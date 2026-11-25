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
