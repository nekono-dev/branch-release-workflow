# ギャップ分析: harness-plugin-unification（2026-11-23）

要件 1〜9 と既存のコードベースの差を整理する。根拠は、`scripts/install-codex.mjs`・`hook-install.mjs`・`setup-cli.mjs`・`hook-diagnose.mjs`・`brw.mjs`・`agent-hooks.mjs`、`.claude-plugin/`・`hooks/hooks.json`、`SKILL.md`・`README.md`・`references/setup.md`、`tests/` の走査と、2026-11-23 の Codex CLI 0.167（`gpt-6.2-sol`、思考の深さ medium）での実機確認（brief.md の「現状」に記録済み）である。

## 要約

- 配る側（マニフェスト・フック定義・スキルの置き場）の差は小さい。`.claude-plugin/` と `hooks/hooks.json` が既にあり、Codex 用に `.codex-plugin/plugin.json` と Codex 用のフック定義ファイルを足し、`SKILL.md` を `skills/branch-release-workflow/` へ移せばよい。判定本体（`agent-hooks.mjs`）は変えない。
- 大きいのは**入れる側と診断の作り直し**で、`brw setup` の Codex 登録（`installCodexHooks`）・`brw check` の Codex 診断（`hook-diagnose.mjs`）・`brw create`／`resume` の worktree 有効化を、「プラグインの状態確認と信頼の登録」に置き換える。削除対象のコードを検証するテストが多く、テストの書き換え・削除が工数の中心になる。
- 信頼の登録は、Codex の内部 API（app-server）の `hooks/list`・`config/batchWrite` に依存する。実験的な API のため、版が上がると壊れるリスクがある。手動承認（`/hooks`）への切り替えを必ず用意する。
- **`SKILL.md` を移すと、`<skill>/scripts/brw.mjs` と `references/…` の相対参照が壊れる**。スキルのディレクトリ＝リポジトリの直下という前提で書かれているため、参照の規則を設計で決め直す必要がある。

## 現状の調査

### 配布物の構造

- `.claude-plugin/plugin.json`: `skills: ["./"]`、バージョン 1.2.0。`.claude-plugin/marketplace.json`: プラグイン 1 件、`source: "./"`。
- `hooks/hooks.json`: Claude 用。`${CLAUDE_PLUGIN_ROOT}` で `scripts/agent-hooks.mjs claude <イベント>` を呼ぶ。登録は PreToolUse（Bash・`mcp__.*`）・PostToolUse（Bash）・Stop。
- Codex 側の登録内容は `hook-install.mjs` の `CODEX_HOOKS`（PreToolUse と PermissionRequest の各 Bash・`mcp__.*`、PostToolUse、Stop）。Claude 側は `CLAUDE_HOOKS`（PermissionRequest を持たない）。両者の対応表に当たるものは、コード中に 2 つの定数として別々にある。

### Codex 向けの導入に関わるコード

| 領域 | 現状 | 本 spec での扱い |
|---|---|---|
| `scripts/install-codex.mjs`（60 行） | スキルのリンク、`--repo` で `.codex/hooks.json` 登録 | 削除（要件 8-1） |
| `scripts/hook-install.mjs`（297 行） | `installCodexHooks`・`mergeCodexHooks`・`activateWorktree`・`installWorktreeHooks`・`checkClaudeHooks` | Codex 側は削除。`checkClaudeHooks`・`CLAUDE_HOOKS` は残る可能性があり、対応表の置き場として再編 |
| `scripts/setup-cli.mjs`（476 行） | `installHooks` が `installCodexHooks` を呼び、`checkClaudeHooks` と併せて報告 | Codex 部分を「プラグイン確認＋信頼の登録」に置き換え（要件 4） |
| `scripts/hook-diagnose.mjs`（378 行） | `.codex/hooks.json` の登録・衝突・旧ランチャー・`worktree-not-registered` などで診断 | Codex の診断を、プラグインの状態と信頼の状態の診断に置き換え（要件 5）。旧方式の検出は不要（5-5） |
| `scripts/brw.mjs` の `create`・`resume` | `installWorktreeHooks` を呼び、worktree に `.codex/` を作り `info/exclude` を書く（423 行付近） | 呼び出しを削除（要件 2-4） |
| `scripts/agent-hooks.mjs` | `claude`／`codex` を引数で受けて応答を出し分ける。フックの定義やパスは持たない | 変更不要（引数の形を保つ） |

### テスト・文書・評価ケース

- Codex 導入に関わるテストの参照数は多い: `tests/hook-install.mjs`（45 箇所・360 行）、`tests/hook-diagnose.mjs`（15）、`tests/real-env/host-events.mjs`（17）、`tests/branch-ops.mjs`（7）、`tests/setup-cli.mjs`（4）ほか。大半が旧方式の検証で、削除・書き換えの対象になる。
- 文書: `README.md`（20 行目の Codex 導入）、`references/setup.md`（「Codex」節、162〜172 行目付近。`~/.local/share` への clone、`install-codex.mjs`、worktree の `.codex/` の説明）、`SKILL.md`（32 行目付近の Codex 導入の案内）が旧方式を前提にしている。
- `tests/selftest.mjs` 109 行目は、`install-codex.mjs` が作るリンクの先から `SKILL.md` を読めることを検証している。
- `evals/` の評価ケースは、旧方式（`install-codex`・`.codex/`）への参照を持たない。

### 規約

- スクリプトは Node.js 標準モジュールだけのネイティブ ESM、関数は camelCase、内部 import は拡張子付きの相対パス（structure.md）。テストは `tests/*.mjs` の `run*Checks` 関数を `selftest.mjs` から呼ぶ形。
- `brw setup` は `pluginRoot`（`BRW_ROOT`＝スクリプト自身の位置）を基準に動く。Codex のプラグインのキャッシュ上で実行しても、キャッシュ内の `scripts/` を基準にできる。

## 要件と既存資産の対応

| 要件 | 既存資産 | ギャップ |
|---|---|---|
| 1 同じ手順で導入・更新 | Claude の `/plugin install`、`.claude-plugin/marketplace.json`（Codex も読める。実機確認済み）、`brw setup`・`brw check` | **Missing**: Codex 用の導入手順の文書と、Codex 用マニフェスト。**Constraint**: 導入先で `codex plugin add` が別に要る（リポジトリの `.codex/config.toml` だけでは入らない） |
| 2 引き継いでも同じ動作 | 同じスクリプト・同じ判定。worktree の有効化は旧方式の回避策 | **Missing**: `SKILL.md` を `skills/` 配下の実ファイルにする移動。**Constraint**: 参照規則の再設計（下記）。worktree 用の処理は削除するだけ（実機で、`.codex/` なしの worktree でも動くことを確認済み） |
| 3 フック定義の取り違え防止 | `hooks/hooks.json` が Claude 用。Codex は、マニフェストが無いとこれを読んで誤登録する（実機確認） | **Missing**: `.codex-plugin/plugin.json` の `hooks` で Codex 用の定義ファイルを指すこと。**Missing**: 両定義と対応表の整合を検査する自己テスト（現状は 2 つの定数が独立） |
| 3-5 シンボリックリンクを含めない | 配布物にリンクは無い（確認済み）。`install-codex.mjs` が `~/.agents/skills` にリンクを作るのは削除対象 | 検査（自己テスト）の追加のみ |
| 4 信頼の登録 | `brw setup` の `installHooks`（旧方式の登録）。信頼は「承認を代行しない」前提で作られている | **Missing**: app-server（標準入出力の JSON-RPC）クライアント、`hooks/list` で現在のハッシュを取り `config/batchWrite` で `hooks.state` に書く処理、失敗時の手動承認の案内。**Unknown**: 下記の Research Needed |
| 5 診断 | `hook-diagnose.mjs` が `unsupported`・`untrusted`・`unverifiable` などの状態語彙を既に持つ | **Missing**: プラグイン未導入・無効・信頼が古い、の区別。語彙は再利用できる。旧方式の検出（衝突・旧ランチャー・`worktree-not-registered`）は削除 |
| 6 導入先リポジトリの宣言 | `.claude/settings.json` の `extraKnownMarketplaces`・`enabledPlugins`（このリポジトリ自身も使用） | **Missing**: `.codex/config.toml` の記入例と、`brw setup`／`brw check` がプラグイン未導入のときに出す導入コマンド |
| 7 クラウド・CI・非対話 | `claude -p --plugin-dir` の案内は `references/setup.md` にある。Codex の非対話の案内は旧方式 | **Missing**: 両ハーネスで同じコマンド列の手順。**Constraint**: 信頼が無いと `codex exec` でもフックが飛ばされる（実機確認）ため、信頼の登録が必須になる |
| 8 旧方式の削除 | 上の表のとおり | 削除と、関連テスト・文書の書き換え。**Constraint**: 8-4 の Claude の既存導入を壊さない検証が要る |
| 9 受け入れ確認 | `tests/real-env/`（実機用）、`claude plugin validate`・`eval` | **Missing**: 一時的な `CODEX_HOME` を使う Codex の受け入れ手順（`codex exec`、`gpt-6.2-sol`・medium）。今回の実機確認の手順を `tests/real-env/` に形として残す |

## 実装方針の選択肢

### Option A: 既存ファイルを置き換える形で拡張する

- `hook-install.mjs`・`setup-cli.mjs`・`hook-diagnose.mjs` の Codex 部分を、その場で新方式に書き換える。信頼の登録は `hook-install.mjs` に足す。
- 長所: ファイル構成が変わらず、差分を追いやすい。`brw setup`・`brw check` の呼び出し側を変えずに済む。
- 短所: `hook-install.mjs` は旧方式の複雑な処理（worktree・マージ・衝突）の上に新機能を載せることになり、削除と追加が同じファイルで混ざって読みにくい。

### Option B: 新しいモジュールを作り、旧モジュールを丸ごと削除する

- `scripts/codex-plugin.mjs`（プラグインの状態確認と信頼の登録、app-server クライアント）と、両ハーネスのフックの対応表（`scripts/hook-registry.mjs` など）を新設する。`install-codex.mjs`・`hook-install.mjs` は削除し、`setup-cli.mjs`・`hook-diagnose.mjs` はこれらを呼ぶ形にする。
- 長所: 責務が明確になり、旧方式のコードが残らない。app-server クライアントを単体でテストしやすい。
- 短所: 新規ファイルが増える。`checkClaudeHooks` など残す部品の移動が要る。

### Option C: ハイブリッド（対応表と app-server クライアントだけ新設）

- 対応表（両ハーネスの登録内容）と app-server クライアントは新設し、`setup-cli.mjs`・`hook-diagnose.mjs` はその場で書き換える。`hook-install.mjs` は Codex 部分を削除して Claude の検査だけにする（または対応表へ統合して削除）。
- 長所: B ほど大きく動かさずに、旧方式の削除とテスト可能性を両立できる。
- 短所: モジュール境界の線引きを設計で決める必要がある。

## 工数とリスク

- **工数: L（1〜2 週間）**。配る側は S だが、入れる側と診断の作り直し、旧方式のテスト（約 90 箇所の参照）の削除・書き換え、app-server クライアント、受け入れ手順の整備で L になる。
- **リスク: Medium〜High**。信頼の登録が Codex の実験的な内部 API に依存する。信頼のキーとハッシュの形（`trusted_hash`・`trusted_content_hash`）は Codex の実装詳細で、版が上がると変わりうる。フォールバック（手動承認の案内）を前提に設計すればリスクは Medium に下がる。

## 設計へ持ち越す事項（Research Needed）

1. **スキルからスクリプトを呼ぶ規則**: `SKILL.md` を `skills/branch-release-workflow/` へ移すと、`<skill>/scripts/brw.mjs` が `<skill>/../../scripts/brw.mjs` になり、`references/`・`assets/` への参照も 1 階層ずつ外へ出る。SKILL.md 内の `references/` 参照は 11 箇所、`assets/` は 2 箇所、`<skill>` は 2 箇所。(a) 相対パスを `../../` に書き換える、(b) 参照先をスキルの中へ移す、(c) プラグインのルートを指す変数をエージェントが使えるか、のどれにするかを決める。**Unknown**: `PLUGIN_ROOT`・`CLAUDE_PLUGIN_ROOT` は、フックの実行時には設定されることを確認したが、エージェントが Bash で実行するコマンドの環境にも設定されるかは未確認。
2. **信頼の登録手段**: app-server の起動方法（`codex app-server` の標準入出力）、`initialize` の手順、`hooks/list` の `cwds`（どの作業ディレクトリを基準にするか）、`config/batchWrite` の `mergeStrategy`、書き込み先の設定ファイル（`CODEX_HOME`）。同時に Codex が動いているとき（設定の競合、書き込みのロック）の挙動。
3. **信頼が外れる条件**: 実機では `trusted_hash`（定義）と `trusted_content_hash`（プラグイン全体）の両方が保存された。プラグインのどの変更で外れるか（バージョン、スクリプトの 1 文字、無関係なファイル）を観測して、`brw check` の「古い信頼」の判定条件を決める。
4. **フックの識別**: 信頼のキーは `<プラグイン>@<マーケットプレイス>:<定義ファイル>:<イベント>:<番号>:<番号>` の形だった。マーケットプレイス名が環境ごとに違う場合（ローカル追加・Git 追加）に、BRW のフックをどう特定するか（`pluginId`、`sourcePath`、コマンドの中身）。
5. **プラグインの有効化と導入の確認**: `codex plugin list`／`plugin add` の出力は人向けの表で、機械可読な形（`--json`）の有無が未確認。app-server の `plugin/list`・`plugin/install` を使えるか。
6. **Codex の対応版と管理者設定**: `[features] hooks = false`、`allow_managed_hooks_only`、`requirements.toml` による制限を、どの経路（設定の読み取り、`hooks/list` の応答）で検出するか。0.167 より前の版の扱い（未対応と報告するための判定）。
7. **導入先の `.codex/config.toml`**: マーケットプレイスの宣言（`[marketplaces.*]`）は認識されたが、プラグインは自動では入らなかった。`[plugins."…"] enabled = true` が `plugin add` 済みのプラグインにだけ効くことの確認と、プロジェクトの信頼（`trust_level`）が前提になる範囲。
8. **Codex のクラウド・非対話**: クラウド（Codex Cloud のタスク）でのプラグイン・フックの挙動は文書に記載がなく、未確認。`codex exec` では、信頼の登録後にフックが動くことを確認済み。
9. **バージョンの扱い**: プラグインのバージョン（`.claude-plugin/plugin.json` の `1.2.0` と `.codex-plugin/plugin.json`）を 1 か所から揃える方法。Codex は版ごとにキャッシュのディレクトリを分けるため、版が同じまま中身を変えると更新されない可能性がある。
10. **Claude 側の影響**: `.claude-plugin/plugin.json` の `skills` 指定を `./skills/` に改めたときに、既存の Claude の導入先で何も壊れないこと（要件 8-4）。`claude plugin validate`・`eval` での確認。

## brw-enforcement との関係

- 本 spec は、brw-enforcement の Codex フック導入（`installCodexHooks`・worktree の有効化・診断の旧語彙）を置き換える。brw-enforcement の設計の該当部分は、本 spec の設計を参照する形へ改める。
- `agent-hooks.mjs` の Stop、`hook-diagnose.mjs`、`setup-cli.mjs`、`SKILL.md`、`tests/agent-hooks-session.mjs` を共有する。実装は、本 spec（配り方）→ brw-enforcement の要件 2 の追加分（振る舞い）の順にすると、Stop の実機確認を新しい配り方の上で行える。
- 要件 3-3 の対応表には、brw-enforcement の Stop（要件 2 の追加分で検出を拡張する）を含める。

## 次の手順

- `/kiro-spec-design harness-plugin-unification` で設計に進む。Research Needed の 1（スキルの参照規則）と 2（信頼の登録手段）は設計の冒頭で決める。
