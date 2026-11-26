# 実環境検証の基盤（brw-enforcement 8.3）

実際の GitHub・Claude Code・Codex を使う検証（8.4・8.5）の準備と片付けをする。通常の `node tests/selftest.mjs` からは実行されない。すべて `BRW_REAL_ENV=1` を付けたときだけ動き、付けなければ説明を出して終了コード 0 で何もしない。

## 目的

- 検証専用の対象 ref（使い捨てブランチ 1 本）、設定用と通常作業用の認証、squash の利用条件を用意して確認する。
- 一時クローンに Claude・Codex のフックを導入し、Codex の信頼済み・未信頼を切り替えて検査できるようにする。
- 通常運用のブランチ（main など）を検証に使わない。

## 安全制約

- GitHub 側で書き込む対象は `verify/brw-base-<epoch>` の 1 ブランチだけ。main の現在の commit から作る。main・`dev/*` など既存ブランチ、既存の Ruleset、リポジトリ設定（`allow_*_merge`・既定ブランチ）は変更しない。
- 検証用の宣言（`baseBranch`・`baseBranches` が使い捨てブランチ、`protectedBranches` が `main`）は一時クローン内に置くだけで、commit も push もしない。`baseBranch` を `main` にすると Ruleset の対象に main が入るため使わない。
- Ruleset を作るときは対象をその 1 ref（`refs/heads/verify/brw-base-<epoch>`）に限り、名前に `brw-verify` を含める（8.4・8.5 で作る場合は下の記録を行う）。
- 作ったブランチ・Ruleset ID・PR 番号・一時クローンは `.brw-verify-state.json`（既定 `/tmp/brw-real-env/`。リポジトリには置かない）に記録し、cleanup は記録にあるものだけを削除する。
- `~/.claude`・`~/.codex` は読み書きしない。Codex のフック導入は一時の `HOME`・`CODEX_HOME` で行い、Claude は登録の読み取り検査だけ行う。
- 資格情報（gh のトークン）は表示・記録しない。`common.mjs` の `authEnv()` が子プロセスの環境変数として渡す。
- 利用者のフックや権限ガードが `gh`・push を拒否したら、迂回せず止めて報告する。

## 手順

```sh
export BRW_REAL_ENV=1
node tests/real-env/prepare.mjs     # 使い捨てブランチ・一時クローン・状態ファイルを作る（再実行すると再利用）
node tests/real-env/hosts.mjs       # 両ホストのフック導入と信頼状態の切り替え検査
# ここで 8.4（フックの実イベント）・8.5（Ruleset の効力）を行う。
# 作った Ruleset・PR・ブランチは状態ファイルへ記録する:
node tests/real-env/prepare.mjs --record ruleset=<ID>
node tests/real-env/prepare.mjs --record pr=<番号>
node tests/real-env/prepare.mjs --record branch=verify/<名前>
node tests/real-env/cleanup.mjs     # 記録されたものだけを削除
node tests/real-env/cleanup.mjs --include-ref-rulesets   # 記録のない brw-pr-squash も、対象が専用ブランチ 1 本だけなら削除対象に加える
```

`prepare.mjs` は admin 権限・`allow_squash_merge`・対象 ref の存在・gh ログインの種類（classic/OAuth か、fine-grained 相当か）を表示する。squash が無効なら設定は変えず中止する。

`hosts.mjs` は次を表示する。

- `claude --version`・`codex --version` の有無
- (a) Codex の `.codex/hooks.json` への導入（一時クローン）と「導入済み・未信頼」（`untrusted`）の確認、再実行で変更なしになること
- (b) 診断への `codexTrust`（`untrusted`/`trusted`/`unknown`）の切り替え結果。信頼の実際の承認は Codex の `/hooks` で利用者が行う操作で、自動化できない。ここは診断への入力値の切り替えで、実ランチャーの応答まで確認する
- (c) Claude の `hooks/hooks.json` の登録検査（`checkClaudeHooks`）と `diagnoseHooks`

## 認証の限界

本環境には gh のログインが 1 つだけで、管理権限を持たない別の資格情報はない。そのため次のとおりにしている。

- 設定用 `BRW_SETUP_GH_TOKEN` と作業用 `BRW_WORK_GH_TOKEN` は、どちらも同じ gh ログイン（管理者の OAuth）から作る。
- 管理者は、Ruleset の `bypass_actors` が空でも Ruleset の設定変更権限を持つ。このため `brw check --ruleset` の作業経路は「管理者権限」で `drift` と表示されるのが正しい。Ruleset の迂回不能を確かめる検証（直接 push・rebase・merge commit の拒否など）は、管理者の資格情報では「管理者は迂回できる」ことの確認にとどまる。
- 非管理の資格情報（書き込み権限のみ）が用意できたら `BRW_REAL_ENV_WORK_TOKEN` に渡す。指定があれば作業用にそれを使う（値は表示・記録しない）。

## 環境変数

| 名前 | 用途 |
|---|---|
| `BRW_REAL_ENV=1` | 必須。付けないと何もしない |
| `BRW_REAL_ENV_WORK_TOKEN` | 任意。非管理の作業用資格情報 |
| `BRW_REAL_ENV_DIR` | 任意。状態ファイルと一時クローンの場所（既定 `/tmp/brw-real-env`） |

設定用の資格情報は gh のログインから作る。検証対象のリポジトリは `nekono-dev/branch-release-workflow`（利用者が検証用に使うことを許可している）。

# 実ホストのフックイベント検証（brw-enforcement 8.4）

実際の Claude Code（2.1.329）と Codex（codex-cli 0.167.0）から BRW のフックが呼ばれることを観測する。`BRW_REAL_ENV=1` のときだけ動く。実 GitHub には書き込まない。

## 手順

```sh
export BRW_REAL_ENV=1
node tests/real-env/host-events.mjs --dry-run            # 呼び出しなしで計画（シナリオと回数）を表示
node tests/real-env/host-events.mjs --host claude        # Claude のシナリオ C1〜C8
node tests/real-env/host-events.mjs --host codex         # Codex のシナリオ X1〜X7（X6 は linked worktree）
node tests/real-env/host-events.mjs --scenario C4,C5     # 指定のシナリオだけ
node tests/real-env/host-events.mjs --diagnose-only      # 診断（hook-diagnose）との突き合わせだけ（ホストを呼ばない）
node tests/real-env/host-events.mjs --reset-counter      # 呼び出し回数のカウンタを戻す
```

- 作業場所は `/tmp/brw-real-env/events/`（Claude 用・Codex 用に main・dev の各リポジトリ。origin は `git@github.com:…` 形式だが、`core.sshCommand` と `GIT_SSH_COMMAND` の試験用 ssh でローカルの bare リポジトリへ向く。`gh` は PATH 先頭の偽物で、呼ばれると `fake-gh.log` に記録して失敗する）。
- フックは `tests/real-env/hook-logger.mjs` を挟んで登録する。各イベントの入力・応答・終了コードを日時付きで `/tmp/brw-real-env/hook-log/<host>.jsonl` に追記し、`scripts/agent-hooks.mjs` の応答をそのままホストへ返す（トークン様の文字列は伏せる）。ホストの生出力は `events/out/`。観測ログはリポジトリに置かない。
- Claude はプロジェクトの `.claude/settings.json`（`--setting-sources project`）、Codex は `installCodexHooks` による `.codex/hooks.json`（ランチャーだけ記録用ラッパー）に登録する。利用者の `~/.claude`・`~/.codex` の設定ファイルは書き換えない。
- Codex のフック信頼は、非対話では承認できないため `--dangerously-bypass-hook-trust`（その 1 回の呼び出しだけ）で代用し、未承認の状態は同じ呼び出しでこのフラグを付けない（X1）ことで観測する。プロジェクトの信頼は `-c projects."<dir>".trust_level="trusted"` で渡す（設定ファイルは書き換えない）。
- 呼び出し回数の上限は Claude 12・Codex 14（カウンタは `events/calls.json`）。上限に達したら止まる。

## 観測結果の要約（実行日 2026-11-21）

| 項目 | Claude Code | Codex |
|---|---|---|
| main 上の `git commit` の拒否 | PreToolUse の deny が届き、ホストはツールを拒否（HEAD 不変） | PreToolUse の deny が届き、実行されない（HEAD 不変） |
| 開発ブランチへの通常 `git push` | PreToolUse の allow で確認なしに実行（bare へ反映） | PreToolUse は応答なし（Codex は allow を返せない）。サンドボックス内で実行できた。PermissionRequest は届かず（下記） |
| 参照を動かす操作（`git tag`） | PreToolUse の ask。非対話の `-p` では未承認のまま実行されない | 応答なし（設計どおり） |
| `gh pr merge`・`--auto` | どちらも deny。偽 gh は呼ばれない | どちらも deny。偽 gh は呼ばれない |
| 適合した `gh pr create`（main 宛） | PreToolUse の allow。確認なしに偽 gh が呼ばれた | 応答なし（実行された） |
| 作業 ID の関連付け（PostToolUse） | 届く。`tool_response` は `{stdout, stderr, interrupted, isImage, noOutputExpected}` で `exit_code` は無い | 届く。`tool_response` は出力の文字列（例 `"w-…\n"`）で、失敗した呼び出しにも届く |
| 終了時の案内（Stop） | `{"decision":"block","reason":…}` をホストが受け入れ、セッションが継続した。2 回目は `stop_hook_active:true` で応答なし | 同じ形をホストが受け入れ、継続した。2 回目は `stop_hook_active:true` で応答なし |
| 作業の禁止（`restrict --no-push`） | push が deny。Stop は案内しない | 同じ |
| フック未導入 | フックイベント 0 件。main への commit が通った（診断の `not-installed` と一致） | （未導入の作業場所は未実施。診断は `unverifiable`） |
| フック未承認 | （該当なし） | 同じ登録でフラグを付けないとフックイベント 0 件（診断の `untrusted` と一致） |
| プラグイン経由（`${CLAUDE_PLUGIN_ROOT}`） | `--plugin-dir` で読み込んだ実体の hooks/hooks.json が展開され、deny が届いた | （該当なし） |

## 設計と fixture に基づく前提との照合

- Claude PostToolUse の `tool_response` に `exit_code` は無い（`interrupted:false` と `stdout`・`stderr` がある）。Codex は終了コードの無い出力文字列だけ。6.2 の「`exit_code===0`」前提は実機と食い違うため、`scripts/agent-hooks.mjs` の成功判定（`successOutput`）を実機の形に合わせた（Claude は `exit_code` が無ければ `interrupted:false`、Codex は注意の行を除いて作業 ID だけの 1 行の出力に限る。`exit_code` が届けば 0 のみ成功）。`tests/agent-hooks-session.mjs` に実機の形の検査を追加した。
- Codex の PreToolUse は deny のみ、PermissionRequest・Stop の入出力は設計どおりの形でホストに受け入れられた（PermissionRequest の実到達は下記の限界）。Stop の入力は `session_id`・`turn_id`・`cwd`・`stop_hook_active`・`last_assistant_message` などを持つ。
- Codex は `session_id` に thread_id を渡し、BRW の関連付けと一致した。`transcript_path`・`model`・`permission_mode` などの追加項目があるが、BRW は読まない。
- `${CLAUDE_PLUGIN_ROOT}` は Claude がフックのコマンドで展開した（C8）。

## 観測できなかったもの・未解決の不一致

- **linked worktree（訂正済み）**: 当初の観測（worktree に `.codex` が無いと親の登録が届かない）を、Codex の `hooks/list`（モデルを呼ばず、cwd ごとに実際に読み込むフックを返す app-server の API）で詳しく調べた。
  - linked worktree は、**親（本体）チェックアウトの `.codex/hooks.json` を読む**。ただし worktree 自身に **`.codex/` ディレクトリがあるときだけ**（空でもよい）。無ければ、親が登録済みでもフックは 1 件も届かない。
  - worktree 側の `.codex/hooks.json` の中身は読まれない（独自の Stop 定義を置いても一覧に出ない）。登録と信頼（`trustStatus`）は親の hooks.json に結び付き、worktree ごとの承認は要らない。
  - 対応: `brw create`・`brw resume` が作る worktree に、親に BRW の登録があるとき `.codex/`（印のファイル付き）を作って有効化し、共通の `info/exclude` に `.codex/` を足す。`install-codex.mjs --repo <worktree>` も同様に有効化する。診断は、親が登録済みでも `.codex/` の無い worktree を `not-installed`（`worktree-not-registered`）と表示する。
  - 実機（X6）: `brw create` が有効化した worktree では親の登録のフックが届き、`restrict --no-push` の作業の `git push` と `gh pr merge` が deny された。`.codex/` の無い worktree はフック 0 件で push・merge がそのまま実行された。診断（有効化した worktree: 信頼済み active・未信頼 untrusted、無い worktree: not-installed[worktree-not-registered]）と一致した。
- **PermissionRequest**: `codex exec`（非対話）では、承認を要する実行（権限の昇格の要求）をモデルが行わず、PermissionRequest は 1 件も届かなかった。allow の応答の実到達は未観測（対話の TUI が必要）。`approval_policy = "untrusted"` は 0.167 では使えない。
- **サンドボックス**: Codex の workspace-write では `.git` が書き込み禁止で、`brw work start` が状態ファイル（`.git/brw/work`）を作れず失敗した。検証では状態の保存先だけを `--add-dir` で書き込み可にした。実運用では書き込みの承認（権限の昇格）が要る。
- **MCP の matcher（`mcp__.*`）**: MCP サーバーを用意していないため、正規表現としての解釈は実機で未観測（Bash の matcher は両ホストで届いた）。
- **Codex の信頼承認の実操作**: `/hooks` での承認は自動化できないため未実施。信頼済みはバイパスフラグで、未承認はフラグなしで観測した。なお `codex app-server` の `hooks/list` が各フックの `trustStatus` と `currentHash` を返すため、信頼状態の読み取りは今後可能（診断の `codexTrust` は現状、呼び出し側の入力）。
- **クラウド（管理対象フック）**: 本環境では確認できない。診断は `unsupported`（managed-hooks-required）のまま。

# Stop の観測（brw-enforcement 14.1）

Stop の block と再入（`stop_hook_active`）、worktree へ移った後の Stop の作業ディレクトリを、実際の Claude Code と Codex で 1 回ずつ観測する。BRW（scripts/）には依存せず、記録用の Stop フックだけを使う。`BRW_REAL_ENV=1` のときだけ動く。

```sh
export BRW_REAL_ENV=1
node tests/real-env/stop-observe.mjs --dry-run            # 呼び出しなしで計画を表示
node tests/real-env/stop-observe.mjs --host claude        # Claude を 1 回呼び出して判定
node tests/real-env/stop-observe.mjs --host codex         # Codex を 1 回呼び出して判定
```

- 作業場所は `/tmp/brw-real-env/stop-observe/<ホスト>-*/`（本体と worktree は一時リポジトリ。作業の記録・状態ファイルは作らない）。登録ファイル（`.claude/`・`.codex/`）は本体の `.git/info/exclude` で未追跡の表示から外す。worktree は本体の `.claude/worktrees/wt` に作る（`poc/claude-stop-cwd.sh` で Stop の作業ディレクトリが worktree に追従した配置と同じ。本体の外に置くと、シェルの `cd` が引き継がれず本体で Stop が起きて観測できなかった）。
- 判定は 2 項目: (a) 1 回目の Stop が未コミットの変更で block され、`stop_hook_active:true` の再入は block されずに通る、(b) すべての Stop の作業ディレクトリが worktree と一致する。
- 結果は標準出力に、ホスト・版・日時つきの Markdown として出る。「観測結果の要約」へ追記する。記録が無い・想定と違う結果は「未観測」「不一致」と書き、成功として扱わない。
- 呼び出し回数は host-events.mjs と同じ共有のカウンタ（`events/calls.json`、上限は Claude 12・Codex 14）で数える。Codex だけ `--dangerously-bypass-hook-trust` を 1 回の呼び出しに付ける。利用者の `~/.claude`・`~/.codex` の設定は書き換えない。
