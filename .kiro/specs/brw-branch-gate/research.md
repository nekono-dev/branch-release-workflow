# 調査記録: brw-branch-gate（設計前の検証）

検証日: 2026-11-25。環境: Claude Code 2.1.329、Codex CLI 0.172.0、Node.js 22。使い捨ての Git リポジトリでフックを組み、`claude -p` で実際に動かして確かめた。

## 検証結果（設計の前提として確定したこと）

| # | 確かめたこと | 結果 | 設計への影響 |
|---|---|---|---|
| 1 | Bash の PreToolUse フックが返す入力の書き換え（`hookSpecificOutput.updatedInput`）が効くか | **効く**。`git switch -c dev/foo` を `git worktree add … && cd … && echo …` へ書き換えて実行できた。理由欄（`permissionDecisionReason`）も返せる | 書き換えによる置き換えが実現できる |
| 2 | 書き換えたコマンドの中の `cd` で、次の Bash 呼び出しの作業ディレクトリも移るか | **移る**（次の `pwd` が worktree、`git branch --show-current` が `dev/foo`）。worktree がプロジェクト配下（`.claude/worktrees/`）にある場合 | `brw create` の後に `cd <worktree>` を足せば、セッションの作業場所ごと移せる。作業場所が配下にあることが条件 |
| 3 | EnterWorktree ツールにフックが掛かるか | **掛かる**。matcher を `.*` にすると `tool_name: "EnterWorktree"`、`tool_input: {name}` が届く。現行の matcher（Bash と `mcp__.*` だけ）では掛からない | matcher に `EnterWorktree` を追加する必要がある |
| 4 | EnterWorktree の素の動作 | ブランチ名は `worktree-<name>`（`dev/*` に合わない）で、`.claude/worktrees/<name>` に作られる。ブランチ名は入力で指定できない | 素のままでは BRW の命名規則を満たせない。置き換えか拒否が必須 |
| 5 | EnterWorktree の入力を `{name}` から `{path}` へ書き換えられるか | **書き換えられる**。`path`（既存 worktree への切り替え）に書き換えると、セッションがその worktree（`dev/probe`）へ移った | フックで `brw create` 相当を行い、結果の worktree を `path` で渡せば、セッションの作業場所も BRW の worktree へ移る |
| 6 | 拒否の応答（`permissionDecision: "deny"` と理由）の伝わり方 | 伝わる。ただし固定の見出し語だけの理由（`BRW-GATE: blocked …`）は、エージェントが意味を取れず、確認を求めて止まった | 機械可読にするだけでなく、自然文の指示（次に実行するコマンドをそのまま書く）を理由の本文にする。見出し語は補助にとどめる |
| 7 | Codex で入力の書き換えが使えるか | **未検証**。フックの信頼が必要で、`--dangerously-bypass-hook-trust` による回避は自動判定で拒否されたため実施していない | Codex は従来どおり拒否と案内（`guard`）で扱う。書き換えは Claude Code 専用とする |
| 8 | 既存の判定で、素の git コマンドを `create` として識別できるか | 識別できる（`git switch -c`・`git checkout -b`・`git worktree add -b` が `create@dev/foo`）。`gh pr create` と `gh api …/pulls` も `pr-create` に分類される | 判定層の追加は最小で済む。置き換え可否の判断を `evalCreate` の結果に足す |

## 設計で確定する方針（検証に基づく）

- 書き換えの条件: `namePattern` に合う名前、分岐元が確定できる、対象が単独の操作（複合コマンドでない）。満たさなければ拒否。
- 書き換え後のコマンドは `brw create <名前> && cd <worktree のパス>` とし、実行時の出力に「何が置き換えられたか」を自然文で添える（#1・#6）。
- EnterWorktree は**拒否**し、`brw create <名前>` を実行した後に `EnterWorktree {path: <作成された worktree>}` を呼ぶ 2 手を、自然文で案内する（決定済み）。フックの中で worktree を作る案は、ツールが実行されなかった場合の作り残し・計画モードでの書き込み・二重実行と時間切れ・名前の食い違い（EnterWorktree は英大文字・`_`・`.` を許すが `namePattern` は許さない）の懸念があり採らない。`path` 指定の EnterWorktree は、BRW が作った worktree への切り替えとして許可する（#5 で動作を確認済み）。
- 作業場所が `.claude/worktrees/` の配下であることを前提にする（#2・#5）。

## 未決（利用者の判断が必要）

なし（EnterWorktree は拒否して 2 手を案内する方針で決定）。

---

# 設計フェーズの調査（2026-11-25、Extension の軽量調査）

## 追加の検証

| # | 確かめたこと | 結果 | 設計への影響 |
|---|---|---|---|
| 9 | 実物の `brw create` を、フックの書き換え（`node brw.mjs create <名前> && cd <worktree> && echo …`）で動かす | **成功**。`pwd` が `.claude/worktrees/dev-foo`、`git branch --show-current` が `dev/foo`。同じ名前でもう一度実行すると `brw create` が「既に存在します」で終了コード 1 になり、作業場所は動かず、続く `pwd` は直前の worktree のまま | 置き換えは `&&` でつなぐだけで、失敗時の巻き戻しは不要（失敗した `create` は何も作らない）。`cd` の失敗も同じく後続を止める |
| 10 | 書き換えた入力に `description` などの他の項目を残せるか | 残せる（`{...tool_input, command}`）。許可（`permissionDecision: "allow"`）を返すと、`acceptEdits` モードでも確認なしで実行された | 他の項目は展開して引き継ぐ。許可の返却は BRW 自身の CLI に限るので、確認を省略してよい |
| 11 | フックの入力に作業ディレクトリが含まれるか | 含まれる（`cwd`）。worktree の中から呼ばれても本体のパスを逆引きできる（`worktrees()` の先頭） | 置き換えのコマンドは、判定した作業ディレクトリへ `cd` してから始める（先頭の `cd` を持つ元コマンドでも対象リポジトリが一致する） |

## 既存の構造（拡張点）

- `scripts/operation-policy.mjs` の `createOp` が `switch`・`checkout`・`branch`・`worktree add` を `create` 操作（`action`: `create`・`resume`・`rename`・`copy`、`via`、`branch`、`path`）に分類する。**開始点（start-point）は記録していない**。
- `scripts/operation-decision.mjs` の `evalCreate` は常に拒否（`branch-create`・`branch-resume`）。保護・分岐元への切り替えだけ通常承認に任せる。
- `scripts/agent-hooks.mjs` の `judgeBash` が判定結果を `verdict`（`deny`・`ask`・`allow`・`pass`）にし、`responseOf` がホストの応答にする。`decideHook` は `tool_name` が `Bash` と `mcp__*` のときだけ判定する。
- `scripts/hook-install.mjs` が登録すべきフックの一覧（`CLAUDE_HOOKS`・Codex 用）を持ち、導入検査（`hook-diagnose.mjs`・`brw check`）が不足を報告する。`hooks/hooks.json`（プラグイン）にも matcher の定義がある。
- `brw create` は配置先を `<本体>/.claude/worktrees/<alias>` に固定し、既存ブランチなら失敗する。`brw resume` は残っている worktree を使うか、ローカルまたはリモートから作り直す。

## 統合の判断（Synthesis）

- **一般化**: 「作成」と「再開」は、置き換え先のコマンドと `cd` 先が違うだけで、判定・書き換え・案内は共通。1 つの計画関数（`planGate`）が両方を扱う。EnterWorktree も同じ案内の書式を使う。
- **Build vs Adopt**: フックの入力書き換えは、Claude Code のホスト機能（`updatedInput`、PoC #1）を使う。自前の実行ラッパーは作らない（ラッパーは PATH の差し替えが必要で、Bash 以外の入口を捉えられない）。
- **単純化**: 判定層（`operation-decision`）は変えない。拒否の結果を受けて、フックの層で「置き換え可能なら書き換え」に変換する。これにより Codex・`brw guard`・既存の判定の試験は影響を受けない（要件 5.4）。

## 未コミットの変更の扱い（2026-11-25、利用者との検討）

`git switch -c` は未コミットの変更を持ち越すが、worktree を作る `brw create` は持ち越さない。置き換えで挙動が変わるため、次を検討した。

| 案 | 内容 | 判断 |
|---|---|---|
| A | 移さない。案内に件数を書く | 変更が見えなくなる恐れ |
| B | 未コミットがあれば拒否し、2 つの選択肢を案内する | **採用**（暗黙の挙動をなくし、他のセッションの変更を黙って奪わない） |
| C | `git stash create` で退避を作り、適用・照合の後に元を戻す | **採用**（`--carry` の方式。退避の置き場を使わず、共有の退避を壊さない） |
| D | その場で切り替える（`--branch-only` と `git switch`） | worktree の隔離を失い、片付けも止まるので不採用 |

懸念と対策: 他のセッションの変更を奪う（B と取り除き前の再照合）、移動途中の失敗で失う（適用・照合の後にだけ元を戻す）、分岐元のずれ（開始点が `HEAD` と同じときだけ移す）、未追跡のファイル（移さず一覧を表示。秘密情報の混入を避ける）。

### `--carry` の方式の検証（2026-11-25、使い捨てリポジトリ）

変更・削除・実行権限の剥奪・バイナリ・ステージ済み＋未ステージの混在・未追跡のファイルがある作業ツリーで、`carryChanges` の手順 1〜5 を手で再現した。

| 手順 | 結果 |
|---|---|
| 1. `git stash create` | コミット `S` が得られ、**退避の置き場（`git stash list`）は増えない**（0 件のまま） |
| 3. 新 worktree で `git stash apply S` | 終了コード 0。変更・削除・実行権限・バイナリがすべて現れた。ステージ済みの変更は未ステージの変更として現れた（案内に書く） |
| 4. 照合 | 存在するファイルは `S` のツリーとオブジェクト ID が一致。**削除されたファイルは `rev-parse` の出力が不定になるため、存在の有無（`git cat-file -e S:<パス>`）で比べる**（設計に反映） |
| 5. 再照合と取り除き | 2 回目の `git stash create` のツリーが `S` と一致。`git restore --staged --worktree --source=HEAD -- <パス>` で該当のパスだけが戻り、**未追跡のファイルは触れずに残った** |


### 実機での確認（タスク 4.3、2026-11-25）

- **実エージェントの実行は未検証**: 使い捨てリポジトリで `claude -p ... --permission-mode bypassPermissions` を入れ子で起動しようとしたが、実行環境の自動判定（auto mode classifier、理由は Undermining Oversight）に拒否された。権限の迂回はせず、実エージェントを動かす確認は行っていない。利用者が許可した環境で、`tests/real-env/` の方式（一時クローン・フックの導入）に沿って実施する必要がある。
- **代わりに確認できたこと**（使い捨てリポジトリ、`agent-hooks.mjs` を標準入力のフック入力で実プロセス起動）:
  - Claude Code の `Bash`（`git switch -c dev/probe-a`）→ `permissionDecision: allow` と `updatedInput.command`。その書き換え後のコマンドを実際の bash で実行すると、worktree `.claude/worktrees/dev-probe-a` が作られ、続く `pwd` が worktree、ブランチが `dev/probe-a`（作業場所が移った）。案内の見出し 4 行が表示された。
  - `EnterWorktree {name}` → 拒否。2 手（`brw create` → `EnterWorktree` の path 指定）の案内。`EnterWorktree {path: <BRW の worktree>}` → 応答なし（通過）。
  - Codex の `Bash`（同じ入力）→ 拒否。「次のコマンド:」に作成と移動（`cd <worktree>`）を連ねたコマンドを示した。
- **実機で未確認**: 書き換え後の `cd` が、エージェントの次の Bash 呼び出しの作業ディレクトリとして引き継がれること（設計時の PoC #2 で確認済みの挙動に依存。実エージェントでは未再確認）。


### 実エージェントでの確認（タスク 4.3、利用者の許可を得て実施、2026-11-26）

実際の `claude -p`（使い捨てのリポジトリ、BRW のフックを設定、`--permission-mode bypassPermissions`）で確認した。
- 素の `git switch -c dev/probe-a` → 置き換えが実行され、worktree `.claude/worktrees/dev-probe-a` が作られ、**次の別の Bash 呼び出しの `pwd` が worktree、ブランチが `dev/probe-a`**（作業場所の移動を確認）。案内の見出し 4 行も表示された。
- `EnterWorktree {name: "probe-b"}` → 拒否され、2 手の案内が表示された。エージェントは案内どおり `brw create` の後に `EnterWorktree {path}` で worktree に入れた。ただし案内の `<名前>`（path 側）はブランチ名ではなく worktree のディレクトリ名（`dev-probe-b`）で、エージェントが読み替えた。案内の分かりにくさとして残る課題。

### 運用で見つかった課題: 案内の `brw` が PATH に無い（2026-11-26）

プラグインとして導入した環境にはコマンド `brw` が PATH に無く、拒否の案内（`brw create <名前>` など）をそのまま実行できなかった。対応として、案内の文面を `node '<brw.mjs の絶対パス>' create <名前>` の形に統一した（`scripts/brw-cmd.mjs` の `BRW_RUN`）。`bin/brw` は採らない（Codex や PATH に入らない導入形態では解決しないため）。`brw pr` などの実行後の出力（`pr-flow.mjs`・`publish-cli.mjs`）は、すでに brw を実行できている文脈なので対象外。

### 運用で見つかった課題: プラグインの版が更新されない（2026-11-26）

機能追加後も `plugin.json` の版が変わらず、導入済みの環境が新しい内容を取り込んだか判別できなかった。機能を足す PR で版を上げる（今回 1.3.0）。検査の自動化は行わない。

---

# ギャップ分析（2026-11-28）: 配置先を `<本体>/.worktree/` に変える更新

対象: 更新後の要件（2.6・6.5・7.1〜7.9 の新設、1.5・2.2 の変更）と現行コードの差。判断（どの案を採るか）は設計で行う。

## 分析の要点
- 配置先のパス `.claude/worktrees` は、**スクリプト 5 ファイル 17 か所**（`brw.mjs` 7、`branch-gate.mjs` 5、`agent-hooks.mjs` 2、`publish-cli.mjs` 2、`pr-template.mjs` 1、`carry.mjs` 1）に直接書かれており、共通の定義が無い。試験 11 ファイル・評価ケース 4 件・`SKILL.md`（4 か所）にも同じ文字列がある。
- 配置先の**決定**（`brw create`・`brw resume`）と**判定**（置き換え・EnterWorktree）が別々に同じパスを組み立てているため、取りこぼすと「作る場所と許す場所がずれる」。
- 要件 7.4〜7.7（旧置き場の扱い）は、現行コードに対応する処理が無い新しい振る舞い。現行の `resume` と `finish` は、ブランチ名で worktree を探しており、パスでは区別しない。
- **新しく分かった危険**: `.worktree/` を無視していないリポジトリで、本体から `git add -A` すると、worktree が埋め込みリポジトリ（gitlink、モード 160000）としてステージされる（一時リポジトリで確認。警告は出るが止まらない）。無視設定を入れれば現れない。要件 7.9 は BRW が無視設定を書かないとしているため、導入先の対応（`brw-install-flow` の案内）が入るまでの間、利用者の環境に露出する。

## 現行の状態（配置先に関わる箇所）
| 箇所 | 役割 | 配置先の扱い |
|---|---|---|
| `brw.mjs` の `create`（465〜470 行付近） | worktree の作成 | 本体の `.claude/worktrees/<別名>`。既に存在するときは中止。親ディレクトリを作る |
| `brw.mjs` の `resume`（654・672 行付近） | ローカル・リモートからの再作成 | 同上。**既存の worktree は、ブランチ名で探して再利用**（`others.find`）。パスは見ない |
| `brw.mjs` の `finish` と `cleanup.mjs` の `removeBranch`・`finishBlocker` | 片付け | ブランチ名で worktree を探す。パスは見ない |
| `branch-gate.mjs`（206・288 行付近） | 置き換えの配置先の照合 | `join(main, ".claude", "worktrees", aliasOf(branch))` と作業場所を比べる |
| `branch-gate.mjs` の `judgeEnterWorktree`（`name` 指定の案内、`path` 指定の `underPlacement`・`placementSound`） | EnterWorktree の判定 | 本体の `.claude/worktrees/` の配下だけを許す。それ以外は一般の拒否（理由は「配下にありません」） |
| `agent-hooks.mjs` 939 行付近（`mainOfStart`） | 実行先が Git の外のとき、`CLAUDE_PROJECT_DIR` が `<本体>/.claude/worktrees/<別名>` の形なら本体を導く | 置き場の形に**依存**（Claude 側の挙動が前提。下の Research Needed） |
| `agent-hooks.mjs` 145・`publish-cli.mjs` 285・`pr-template.mjs` 31 | PR 本文の置き場 `.brw/` | **この仕様の範囲外**（`brw-pr-handoff`。移行の間は旧置き場に残る） |
| `carry.mjs` 56 | `--carry` の未追跡の一覧から配置先を除く | `.claude/worktrees/` を前方一致で除く |
| `hook-install.mjs` の `activateWorktree` | Codex 用の `.codex/` の有効化と `info/exclude` への追記 | 配置先の場所に依存しない（`.codex/` は worktree の直下）。`.worktree/` は除外しない |

## 要件に対する技術的な必要事項と差
| 要件 | 必要なこと | 差 |
|---|---|---|
| 1.5・2.2・7.1〜7.3 | 配置先を `.worktree/` に | 定数の一括変更。`create`・`resume`・置き換え・EnterWorktree の 4 経路で同じ値を使う。**差は小さいが取りこぼしやすい** |
| 7.4 | 旧置き場を配置先として扱わない | 判定に使う関数（`underPlacement` 等）が `.worktree/` だけを見る。比較的小さい |
| 7.5 | `resume` が旧置き場の使用中ブランチを拒否し、移動手順を案内 | **新規**。`others.find` の結果のパスが新しい配置先の配下かを見て、外なら拒否。案内文（旧パス・新パス・`git worktree move` の手順）が要る |
| 2.6 | EnterWorktree の `path` が旧置き場なら専用の案内で拒否 | **新規**。現行の一般の拒否（`gate-enter-path`）に、旧置き場を見分ける枝と案内を足す |
| 7.6 | `finish`（`--merged` 含む）が旧置き場の worktree を片付けない | **新規**。`finishBlocker` に旧置き場の判定を足し、`--merged` の一覧では「残します」の理由にする。ブランチの削除も止めるか（worktree だけ残してブランチを消すと不整合になる）は設計の判断 |
| 7.7 | 旧置き場の worktree が他のブランチの操作を妨げない | `worktrees()` の一覧の扱いが、旧置き場の worktree で例外を出さないこと。現状は問題なさそうだが試験が要る |
| 7.8 | 未追跡の一覧から配置先を除く | `carry.mjs` の前方一致の文字列の変更だけ |
| 7.9 | 導入先の無視設定を書かない | 実装は不要（書かないことの確認だけ）。ただし上の「新しく分かった危険」がある |
| 6.5 | 資料に配置先・移行手順・無視設定の要否 | `SKILL.md`（4 か所）と `references/` の追記 |

## 実装の選択肢
### A: 既存のファイルをそのまま書き換える
- 17 か所の文字列を `.worktree` に置き換え、旧置き場の判定は各所に個別に足す。
- ✅ 新しいファイルが無く最小。❌ 同じ文字列と判定が 5 ファイルに散ったまま。次に置き場を変えるときも同じ取りこぼしの危険。7.4〜7.6・2.6 の旧置き場の判定が複数箇所に重複する。

### B: 配置先の決定・判定・案内を 1 つのモジュールに集める（新規）
- 配置先の組み立て（`<本体>/.worktree/<別名>`）、配下かの判定、旧置き場かの判定、旧置き場の案内文を 1 か所に置き、`brw.mjs`・`branch-gate.mjs`・`carry.mjs`・`cleanup.mjs` が呼ぶ。
- ✅ 取りこぼしが起きにくく、`brw-pr-handoff` の `.brw/` 移行も同じモジュールで行える。試験も集中。❌ 新規ファイルと、呼び出し側の差し替えが要る。

### C: ハイブリッド（推奨案）
- 小さな配置先のモジュール（B）を作り、既存の `lib.mjs` の `aliasOf` と並べる形で呼ぶ。`brw.mjs` と `branch-gate.mjs` の置き換えは機械的に行い、`.brw/` は `brw-pr-handoff` の更新まで現状のまま（別の定数）。
- ✅ B の利点と、移行の間の `.brw/` の現状維持を両立。❌ 段階的な差し替えの手順管理。

**推奨**: C。配置先の決定・判定・旧置き場の案内を 1 か所にし、後続の `brw-pr-handoff` が同じ場所を使えるようにする。

## 複雑さとリスク
- 労力: **M**（1〜2 週間未満）。定数の置き換えは機械的だが、旧置き場の振る舞い（7.4〜7.6・2.6）は新規で、試験の更新量（11 ファイル + 評価ケース 4 件）が大きい。
- リスク: **中**。(1) エージェントの実行環境（EnterWorktree・フック・Codex）の挙動への依存（実機検証が必要）。(2) 無視設定が無い導入先で `git add -A` による gitlink の誤ステージ。(3) 配置先の定数の取りこぼし。

## Research Needed（設計で実機検証する。`feasibility.md` の 4 つの前提に対応）
1. Claude Code の EnterWorktree が、`.claude/worktrees/` 以外の場所の `path` を受け付けるか。
2. `CLAUDE_PROJECT_DIR` が、`.worktree/<別名>` で動くセッションでどうなるか（`mainOfStart` が置き場の形に依存している）。置き場の形に依存しない本体の求め方（`git rev-parse --git-common-dir` など）に変えられるか。
3. Codex が `.worktree/<別名>` の linked worktree でも本体の `.codex/hooks.json` を読むか。
4. `finish` が旧置き場の worktree を持つブランチを対象外にするとき、ブランチの削除も止めるべきか（設計の判断）。

## 要確認（要件へ追加するかの判断が要る）
- **`.worktree/` が無視されていない導入先で `brw create`・`brw resume` を実行したとき、BRW は何もしないでよいか。** 本体で `git add -A` すると worktree が gitlink として誤ってステージされる（確認済み）。要件 7.9 のとおり BRW は無視設定を書かないが、**無視されていないことを検出して警告する**（書き込みはしない。止めるか通すかも決める）要件を足す選択肢がある。`brw-install-flow` の案内が入るまでの間の安全策になる。

---

# 設計の調査と判断（2026-11-28）: 配置先を `<本体>/.worktree/` に変える更新

## 要約
- **調査の種類**: 拡張（既存の置き換え・EnterWorktree の判定の配置先を変え、旧置き場の扱いを足す）＋外部の動作への依存（Claude Code・Codex・git）。一次資料の取得と、実機検証（`poc/design_01.md`・`poc/design_02.md`）を行った。
- **設計に効く発見**:
  1. 配置先が `.claude/worktrees/` の外になると、**EnterWorktree の `path` 指定は Claude Code 自身の承認（人の確認）を必ず求め、BRW のフックの許可では省けない**（実機 R1 と一次資料）。`.claude/worktrees/` の下（比較 R3）は確認なしで入れる。また、worktree に入ったセッションからは、`.claude/worktrees/` の配下にしか EnterWorktree で移れない（一次資料）。BRW の置き換え（Bash の `cd`）は承認の対象外なので、Claude Code での作業場所の移動は `cd` が実用的になる。
  2. `.worktree/<別名>` で開始したセッションでも、フックは届く。入力の `cwd` と `CLAUDE_PROJECT_DIR` は**どちらも worktree 自身**（実機 R4）。EnterWorktree で入った場合は、`cwd` が worktree、`CLAUDE_PROJECT_DIR` は本体のまま（一次資料・実機 R3）。
  3. 配置先が無視されているかは、`git check-ignore -q -- .worktree/<別名>` の終了コード（0 無視、1 無視されない、128 判定不能）で見分けられる。無視されていない本体で `git add -A` をすると、worktree が gitlink として誤ってステージされる（実機で確認）。
  4. `git worktree move` で、旧置き場の worktree を、未コミットの変更ごと新しい場所へ移せる。ロックされていれば先に `git worktree unlock` が要る。

## 調べたこと
### Claude Code: EnterWorktree・フック・設定の読み込み
- **出典**: https://code.claude.com/docs/en/tools-reference（「EnterWorktree tool behavior」）、https://code.claude.com/docs/en/worktrees、https://code.claude.com/docs/en/hooks、https://code.claude.com/docs/en/settings（いずれも 2026-11-28 取得。ページに版・日付の表示は無い）。
- **事実**: 「a `path` outside `.claude/worktrees/` prompts for your approval before entering」「from within a worktree session, only the `path` form is available and the target must be under `.claude/worktrees/`」。承認は、権限ルールや「今後確認しない」では省けず、`bypassPermissions` のときだけ省かれる。`CLAUDE_PROJECT_DIR` は「the project root where the session started」で、worktree に入っても変わらない。`cwd` は worktree に移る。設定は、EnterWorktree の移動で、移動先の設定が読まれる。project スコープのプラグインは、同じリポジトリの worktree にも読み込まれる。
- **実機**: `poc/design_01.md`（`claude -p` 2.1.329）。
- **影響**: EnterWorktree を経由する移動は、承認の人手が要る。BRW は拒否・案内の対象にするが、案内に承認の注意を書く。承認の自動化は、BRW のフックではできない。

### Codex: フックと linked worktree
- **出典**: https://learn.chatgpt.com/docs/hooks（旧 https://developers.openai.com/codex/hooks からの転送。2026-11-28 取得。版・日付の表示は無い）。
- **事実**: 「In a linked Git worktree, a project layer can read hooks from the corresponding directory in the main checkout.」。worktree 側に `.codex/` が要るか、worktree の置き場所（`.worktree/` や本体の外）による規則の違いは**記載なし**。フックの信頼は、フックの定義のハッシュで記録される（本体と worktree で共有するかは記載なし）。
- **影響**: 一次資料だけでは置き場所による違いが分からなかったため、実機（`hooks/list`）で確認した（`poc/design_03.md`）。`.worktree/<別名>` の linked worktree でも、空の `.codex/` があれば本体の `hooks.json` が読まれる。`feasibility.md` の前提 3 は確認済み。

### git: 配置先の挙動
- **実機**: `poc/design_02.md`。無視の検出、`git add -A` の影響、旧置き場からの移動、ロックされた worktree。

## 設計判断
### D1: 配置先の決定・判定・旧置き場の案内を 1 つのモジュールに集める
- **理由**: 配置先のパスが 5 ファイル 17 か所に散っていて、共通の定義が無い（ギャップ分析）。作る場所（`create`・`resume`）と許す場所（置き換え・EnterWorktree）がずれることを防ぐ。
- **採用**: 小さな新規モジュール `scripts/placement.mjs`（ギャップ分析の案 C）。`.brw/` の置き場は `brw-pr-handoff` の更新まで現状のままで、別の定数にする。

### D2: 旧置き場の worktree は、配置先として認めず、「ブランチ名で再利用する」経路からも外す
- **採用**: 旧置き場の判定は配置先モジュールに 1 つだけ置く。`resume`・`finish`（`finishBlocker`）・置き換えの再開先・EnterWorktree の `path` の 4 経路が同じ関数を呼ぶ。`finish` は、旧置き場の worktree を持つブランチを**丸ごと対象外**にする（worktree もブランチも消さない。worktree だけ残してブランチを消すと不整合になるため）。旧置き場以外の場所にある既存 worktree の再利用は、従来どおり（要件に含まれない）。

### D3: EnterWorktree の案内に、承認の注意を加える（要件 2.1 の文言は変えない）
- **採用**: 2 手の案内は維持し、理由の行に「Claude Code は `.claude/worktrees/` の外の `path` への EnterWorktree で承認を求める。承認できない環境では、`brw create` が移した作業場所（`cd`）で作業する」を加える。要件 2.1・2.2 の見直し（承認の要る EnterWorktree をそもそも案内するか）は、利用者の判断が要るため、設計では変えない。

### D4: `mainOfStart` の形を `.worktree/<別名>` に改める
- **採用**: 実行先が Git の外（削除済みの作業場所）のとき、`CLAUDE_PROJECT_DIR` が `<本体>/.worktree/<別名>` の形なら本体を導く。旧置き場の形（`.claude/worktrees/<別名>`）は、配置先として認めないため導かない。

### D5: 無視されていない配置先の警告は、作成の後に 1 回、`brw create`・`brw resume` が出す（要件 7.10）
- **採用**: worktree を作る処理（作成・再作成）の成功の後に、`git check-ignore` が 1 を返したときだけ警告する。0 は何も出さない。128 などの判定不能は、何も出さない（誤警告を避ける）。警告は標準出力の案内に含め、作成は続ける。導入先の設定は書かない（要件 7.9）。`--branch-only`（worktree を作らない）と、既存 worktree の再利用では出さない。

## 簡素化・統合の結果（design-synthesis）
- 旧置き場の判定（7.4〜7.6・2.6）は、4 経路で同じ関数を使うため、一般化して配置先モジュールに集めた。
- 新しい部品は `placement.mjs` の 1 つだけ。EnterWorktree と置き換えの案内の書式は、既存の `guidance` を共有する。

## リスク
- **EnterWorktree の承認**: 配置先の変更により、Claude Code の EnterWorktree は常に承認を求める。非対話（`-p`・CI）では `bypassPermissions` でないと通らない。BRW の置き換え（`cd`）は影響を受けない。
- **Codex**: 実機で読み込みを確認済み（`poc/design_03.md`）。実セッションでの発火は旧置き場で確認済みの規則と同じと判断し、実装後の実機検証で再確認する。
- **無視設定が無い導入先**: 警告（7.10）が安全策。`brw-install-flow` の案内が入るまでの間、利用者が設定を足すまで gitlink の誤ステージの危険が残る。
- **取りこぼし**: 17 か所の置き換えを、配置先モジュールの導入と試験（旧置き場の文字列が `scripts/` に残っていないことの検査）で防ぐ。

