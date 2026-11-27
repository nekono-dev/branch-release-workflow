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

## Stop の観測の結果（実行日 2026-11-26）

| 項目 | Claude Code 2.1.329 | Codex 0.172.0 |
|---|---|---|
| 応答の終了を 1 回止め、再入（`stop_hook_active:true`）で通る | 一致 | （未判定。Stop の cwd が worktree でなく、未コミットの変更を検出できなかったため block されなかった） |
| worktree へ移った後の Stop の作業ディレクトリ | 一致（worktree） | **不一致**（起動時の本体のまま。エージェントは worktree でファイルを作っていた） |

- Codex のフックの信頼は、一時の `CODEX_HOME`（`config.toml` にプロジェクトの信頼、`auth.json` は利用者のファイルの一時のコピー。権限 0600、実行の後は削除）で渡す。0.172 では `-c projects."<dir>".trust_level` が効かない（0.167 では効いた）。


# 標準入出力の端末判定の観測（brw-enforcement 14.2）

`brw pr-merge` は、対話の端末（人が操作する画面）から実行されたときだけマージを行う（要件 3.5）。その前提として、エージェントの Bash やシェルで実行したときに、標準入力・標準出力が「端末」として渡されないことを、実際の Claude Code と Codex で観測する。「端末」は、キーボード入力と画面表示を持つ入出力の先（Node では `isTTY` が `true`）を指す。

`BRW_REAL_ENV=1` のときだけ動く。BRW（scripts/）には依存せず、記録用の 1 ファイルの Node スクリプトだけを使う。

```sh
export BRW_REAL_ENV=1
node tests/real-env/tty-observe.mjs --dry-run            # 呼び出しなしで計画を表示
node tests/real-env/tty-observe.mjs --host claude        # Claude を 1 回呼び出して判定
node tests/real-env/tty-observe.mjs --host codex         # Codex を 1 回呼び出して判定
```

- 作業場所は `/tmp/brw-real-env/tty-observe/<ホスト>-*/`（リポジトリ外）。記録用スクリプト `probe.mjs` と記録 `tty.jsonl` を置く。ホストには、このスクリプトを次の 2 通りで実行させる。
  - `direct`: 直接の実行（期待: 標準入力・標準出力の `isTTY` が `undefined` または `false`）
  - `pty`: `script -qc '…' /dev/null` 経由の実行（疑似端末を作って子プロセスに渡す。期待: `isTTY` が `true`）
- 判定は 4 項目。`direct` の記録はすべて両方が端末でないこと、`pty` の記録はすべて両方が端末に見えること（どちらも一致）。1 件でも想定と違えば「不一致」。記録が無い、ホストが非ゼロ終了・タイムアウトした場合、または解析できない行（壊れた JSON）が 1 件でもある場合は、記録が揃っていても総合を「未観測」とする（一致とは書かない）。
- **確認の限界**: `pty` の結果は、エージェントが疑似端末を作れば端末判定を満たせることを示す。つまり端末判定は協調的なエージェントの誤用を防ぐもので、迂回を防ぐ強制ではない（設計の「確認の強さと限界」）。
- Codex の信頼は使わない（フックを使わない）。Codex は一時の `CODEX_HOME`（作業場所の中。認証は利用者の `auth.json` の一時のコピーで、権限 0600。実行の後は削除する）を指して、`codex exec -s workspace-write` で実行する。利用者のファイルはコピー元として読むだけで、Codex が書き込んでも変わらない。利用者の `~/.claude`・`~/.codex` は書き換えない。
- 呼び出し回数は stop-observe.mjs と同じ共有のカウンタ（`events/calls.json`、上限は Claude 12・Codex 14）で数える。

## 観測結果

（未追記。実行結果は親が本節へ追記する。出力の Markdown は `tty-observe.mjs` が標準出力に出す。）

## 端末判定の観測の結果（実行日 2026-11-26、`BRW_REAL_ENV=1 node tests/real-env/tty-observe.mjs --host both`）

| 項目 | Claude Code 2.1.329 | Codex 0.172.0 |
|---|---|---|
| 直接の実行（Bash・パイプ）で標準入力・標準出力が端末として渡されない | 一致（どちらも `undefined`） | 一致（どちらも `undefined`） |
| `script` 経由の実行で標準入力・標準出力が端末に見える（確認の限界） | 一致（どちらも `true`） | 一致（どちらも `true`） |
| ホストの実行（終了コード 0・タイムアウトなし） | 一致 | 一致 |

- 要件 3.5（`brw pr-merge` が、エージェントなど対話端末でない実行から呼ばれたときマージしない）の前提は両ホストで成り立つ。一方、エージェントが疑似端末を作れば端末判定は満たされるため、`brw pr-merge` の端末判定は協調的なエージェントの誤用を防ぐもので、悪意ある迂回を防ぐ強制ではない（design.md「PR のマージ（利用者の端末）」の「確認の強さと限界」）。
- Codex は一時の `CODEX_HOME`（認証は一時のコピー。実行の後に削除）で実行した。生の出力は実行時の `/tmp/brw-real-env/tty-observe/<ホスト>-*/`。
- Codex の再観測（2026-11-26、認証は一時のコピー・実行後に削除）: 端末判定・Stop の観測とも総合「一致」。利用者の `~/.codex/auth.json` のハッシュは実行の前後で同じだった。
- 記録の検証（`tty-observe.mjs`・`stop-observe.mjs` 共通）: 記録の 1 行ごとに、必須項目と型・値（`mode` は `direct`/`pty`、`stdin`/`stdout` は `undefined`/`false`/`true` の文字列、Stop の記録は `stop_hook_active`・`block` が真偽値、など）を検査する。構文エラーも形式の不正も「不正な行」として数え、1 件でもあれば総合を「一致」にしない（想定外の正規の値があれば「不一致」、それ以外は「未観測」）。未知の追加項目と空行は許可する。

## 追加した規則の実環境の確認（19.2）

追加した規則（開発ブランチの確認省略・保護ブランチの拒否・Stop の block と再入・`brw pr-merge` の端末限定）を、実ホストと実 GitHub で観測する。`BRW_REAL_ENV=1` を付けたときだけ動く。

### 実行の状態

- 観測は実行済みで、結果は末尾の「追加した規則の実環境の確認の結果（19.2）」に記録した。この節の手順は、その結果を再現するためのもの。
- 結果の判定に使わなかった項目（記録が無い・根拠が揃わないもの）は「未観測」として扱う。

### 手順

```sh
export BRW_REAL_ENV=1
node tests/real-env/enforce-observe.mjs --stage hosts --host claude --dry-run   # 呼び出しなしで計画を表示
node tests/real-env/enforce-observe.mjs --stage hosts --host claude            # 本番（ホストを最大 4 回呼ぶ）
node tests/real-env/enforce-observe.mjs --stage hosts --host codex             # 本番（最大 4 回）
node tests/real-env/prepare.mjs                                                 # merge 段階の前に状態ファイルを作る
node tests/real-env/enforce-observe.mjs --stage merge --dry-run                # 計画のみ（GitHub へ書き込まない）
node tests/real-env/enforce-observe.mjs --stage merge                          # 本番（使い捨てブランチ 3 本と PR 2 件だけ）
node tests/real-env/cleanup.mjs                                                 # 記録されたものだけを削除
```

- `hosts` 段階（H1・H2・H3・H3w の 4 シナリオ、ホストごと最大 4 回）: origin は GitHub 形式の URL だが、試験用 ssh でローカルの bare リポジトリへ向ける。`gh` は偽物で、呼ばれたら失敗する。フックは `hook-logger.mjs` を挟み、記録（`<作業場所>/hook-log/<ホスト>.jsonl`）と作業場所の Git の状態から判定する。作業場所は `/tmp/brw-real-env/enforce-observe/` 配下。Codex は一時の `CODEX_HOME` を使う（実行の後に削除）。
- `merge` 段階: 使い捨てブランチ `verify/brw-base-<epoch>`・`verify/brw-prot-<epoch>`・`dev/verify-merge-<epoch>` を main の現在の commit から作り、PR-1（head → 分岐元）と PR-2（head → 保護扱い）を立てる。`brw pr-merge` を非端末（M1）・疑似端末で入力なし（M2）・`n`（M3n）・`y`（M3y）で実行し、エージェントのフック経路（M4a・M4b）を `scripts/agent-hooks.mjs` に実際の入力の形で渡す。疑似端末は `script` を使い、プロンプト `マージしますか [y/N]` の出力を待ってから答えを送る（60 秒で打ち切る）。

### 安全制約

- GitHub へ書き込むのは、上の使い捨てブランチ 3 本と PR 2 件だけ。main・既存のブランチ・既存の PR・Ruleset・リポジトリ設定には書き込まない。`hosts` 段階は GitHub へ書き込まない。
- 使い捨てブランチと PR は `prepare.mjs --record` で状態ファイルに記録し、`cleanup.mjs` が記録されたものだけを削除する（`dev/verify-merge-<番号>` の名前も削除対象に含める。既に閉じた PR・マージ済みの PR は閉じ直さない）。
- `brw pr-merge` の M1 は `GH_TOKEN` を無効な値にして実行する。`refs` が変わらないことで書き込みが無いことを確かめる。
- 利用者の `~/.claude`・`~/.codex` は読み書きしない。Codex の認証は一時のコピーで、実行の後に消す。
- 資格情報（トークン）は表示・記録しない。
- 呼び出し回数は既存の共有カウンタ（`events/calls.json`。Claude 12 回・Codex 14 回の上限）に加算する。`hosts` 段階は 1 ホストあたり最大 4 回。

### 記録の検証規則

- フックの記録（`hook-log/<ホスト>.jsonl`）の 1 行ごとに、時刻 `ts`（日時の文字列）、`host`（想定のホスト）、`event`（空でない文字列）、`input`（オブジェクト）、`stdout`（空、または JSON のオブジェクト）、`exit`（整数）を検査する。構文エラーも形式の不正も「不正な行」として数え、1 件でもあればそのシナリオを「記録不正」とし、一致にしない。
- ホストの終了コードが 0 以外、またはタイムアウトのときは一致にしない（「未観測」）。
- merge 段階の観測（M1・M2・M3n・M3y・M4a・M4b）は、6 件すべてがそろい、形式が正しく、条件（終了コード・PR の状態の読み戻し・refs の不変・squash の親が 1 つ・マージ commit が分岐元の先頭と一致など）をすべて満たしたときだけ「一致」。欠けは「未観測」、条件外れは「不一致」、形式の不正や重複は「記録不正」。
- 根拠の厳密さ: H1・H2 は、`git add … && git commit …` が同じ Bash 呼び出し（同じ command）に含まれる記録だけを根拠にする（分けて実行した記録は未観測）。H1 の allow・H2 の deny・H3 の block は、終了コード 0 で応答が期待どおりの JSON のときだけ一致とする。再入（stop_hook_active:true）の応答なしは、終了コード 0 で stdout が空（空白のみを含む）のときだけ一致とし、block・他の JSON・非 0 の終了コードは不一致とする。
- M1 は「利用者が自分の端末」を含み、質問（`マージしますか`）を含まないこと。M2 は「保護ブランチ」「GitHub 上」を含み、質問を含まないこと（入力を送っていない）。M3n は PR の表示（番号・タイトル・取り込み・head の SHA）→ 質問 → 送った入力 `n` → `中止しました` の順で、終了コード 1・PR は open・refs 不変のときだけ一致。M3y は同じ表示・質問・入力 `y`・`マージしました` の順で、終了コード 0・PR は merged・squash（親が 1 つ）・head は残る、のときだけ一致。
- 想定と異なる結果は「不一致」、記録が無いものは「未観測」と書き、成功扱いにしない。

## 追加した規則の実環境の確認の結果（19.2、実行日 2026-11-27）

Claude Code 2.1.329・codex-cli 0.172.0、実 GitHub（`nekono-dev/branch-release-workflow` の使い捨てブランチだけ）。判定は記録の検証（1 行ごとの必須項目の型・値、ホストの終了コード、フックの終了コードと応答、プロンプトの表示と送った入力の順序）を通した結果で、想定と異なるものは成功として記録していない。

経緯: 最初の実行の後、レビューで判定の緩さ（M3n・M2 がプロンプトの有無を見ない、Stop の再入が JSON 応答を通す、H1 が `git add` と `git commit` の別呼び出しを通す）を指摘され、判定を厳密にして実環境をもう一度実行した。厳密化した判定の最初の merge 実行では、判定側が `brw pr-merge` の表示（タイトルとブランチ名をバッククォートで囲む）と合わず M3n・M3y が「不一致」になった（実際の動作は正しかった）。判定を直して再実行した結果が下の表（merge 段階の最終実行は PR #17・#18）。

| 項目 | Claude Code 2.1.329 | Codex 0.172.0 |
|---|---|---|
| H1 開発ブランチの `git add … && git commit …`（複合）の確認省略 | **一致**: PreToolUse が allow（`登録済みの宣言に従う通常の commit`）で、確認なしに commit が作られた。続く Stop が「未 push の commit が残っている」と 1 回止め、モデルは push まで進めて終了コード 0（最初の実行は `--max-turns 4` の上限で終了コード 1 となり「未観測」と判定された。上限を 8 にして再実行し一致。bare に `記録` の commit が反映されていたことも確認） | **未観測**: PreToolUse は応答なし（Codex は allow を返せない）、`codex exec` では PermissionRequest が届かず、サンドボックス（workspace-write）が `.git` を書き込み禁止にするため commit も作られなかった。8.4 で記録した既存の制約と同じで、本件の変更の不具合ではない。承認方針 `on-request` の対話（TUI）での allow の実到達は、この環境では観測できていない |
| H2 保護ブランチ main の commit の拒否 | **一致**: PreToolUse の deny、HEAD 不変、終了コード 0 | **一致**: 同じ |
| H3 未コミットのまま終わる応答の Stop | **一致**: 1 回目が block（理由に「未コミット」と `new.txt`）、再入（`stop_hook_active:true`）は応答なしで通る、終了コード 0 | **一致**: 同じ |
| H3w 別の worktree に残した未コミットの Stop | **一致**: block・再入の通過 | **一致**: block・再入の通過（Codex の Stop の cwd が本体のままでも、全 worktree の走査で検出） |
| M1 非端末の `brw pr-merge` | 終了コード 1、「利用者が自分の端末」、PR は open のまま、`refs` は不変（`GH_TOKEN` を無効にしても同じ＝通信なし） | （ホスト非依存） |
| M2 保護扱いの取り込み先への `brw pr-merge`（疑似端末） | 質問の前に拒否（「保護ブランチです…GitHub 上でマージしてください」）、終了コード 1、PR は open のまま | （同上） |
| M3n 分岐元向けの `brw pr-merge` に `n`（疑似端末） | 「中止しました」、終了コード 1、PR は open のまま | （同上） |
| M3y 同じく `y` | 終了コード 0、PR は merged、マージ commit が分岐元ブランチの先頭と一致、squash（親 1 つ）、head のブランチは削除されない | （同上） |
| M4a エージェントの Bash の `node <brw> pr-merge <番号>` | PreToolUse の deny（`pr-merge-by-agent`、案内に「利用者が自分の端末で実行」） | （フック入力を直接渡して確認。Claude と Codex は同じ判定の経路） |
| M4b エージェントの `gh pr merge` | PreToolUse の deny、案内に `brw pr-merge`（「分岐元向けは別の端末で、保護ブランチ向けは GitHub 上」） | 8.4 の再実行（X3）でも deny を確認（Codex の PreToolUse） |

- 8.4 の `host-events.mjs` を、新しい案内文・Stop の統合のもとで再実行した（誤って `--reset-counter` に全シナリオが続いて走った）。Claude は C1〜C8 すべて OK。Codex は X1〜X7 のうち X3 だけが NG: `git push` のサンドボックス内での追跡参照の更新失敗（`.git` が読み取り専用）による既存の制約で、`gh pr merge`・`--auto`・`gh pr create` の deny と新しい案内（`brw pr-merge`）は届いていた。ほかは OK。
- 後片付け: 使い捨てブランチ `verify/brw-base-*`（2 本）・`verify/brw-prot-*`・`dev/verify-merge-*`、PR #17（マージ済み）・#18（クローズ）、一時クローン・一時 HOME を削除した。`main` の commit は不変（`bd2c9b8`）。
- 未確認のもの: Codex の対話（TUI）での PermissionRequest の allow の実到達、Claude Code の `!` での実行が端末判定を満たすか（SKILL.md は「可能性がある」と書き別の端末を案内）、Windows など他の環境。

### 観測の道具の判定に残る制約（19.2 のレビューで指摘され、受け入れたもの）

判定を変えるたびに実 GitHub・実ホストの再実行が要るため、次の緩さは直していない。結果の表は、これらに頼らず、実行ごとに観測の生の記録と GitHub の読み戻しを人が確認したものである（refs の不変・PR の状態・マージ commit の親の数・`main` の SHA を `gh api` で読み直した）。

- H2: 複合コマンドの deny が 1 件あれば、同じ呼び出しの別の記録が非 0 終了や応答なしでも一致にする（該当する各記録の終了コード・応答を個別には確かめない）。
- M1〜M3n の「refs 不変」: 読み取りに失敗した ref と存在しない ref をどちらも `null` として数えるため、前後とも読み取りに失敗すると不変と誤って判定しうる。
- H1・H2 の複合コマンドの判定: `git add … && git commit …` が同一の Bash 呼び出しにあることは確かめるが、引用文字列の中の例（`echo 'git add x && git commit …'`）と区別しない。
- M4b: deny と終了コードだけを確かめ、案内文（`brw pr-merge`・取り込み先別の案内）は判定に含めない（案内文の内容は単体試験と、host-events.mjs（C3・X3）が実機の応答を表示して確かめる）。

## 分岐元からの PR の実環境の確認（brw-pr-handoff 5.2・8.2）

分岐元（`develop` など）から保護ブランチへの PR を、GitHub の API（5.2）と実機の Claude Code（8.2）で観測する。`BRW_REAL_ENV=1` を付けたときだけ動く。スクリプトは `tests/real-env/base-pr-observe.mjs`、判定の単体試験は `tests/base-pr-observe.mjs`（selftest に登録）。

### 手順

```sh
export BRW_REAL_ENV=1
node tests/real-env/prepare.mjs                                              # 状態ファイルを作る（前提）
node tests/real-env/base-pr-observe.mjs --stage api --dry-run               # 計画のみ（書き込みなし）
node tests/real-env/base-pr-observe.mjs --stage api                         # 本番（使い捨てブランチ 3 本と PR 1 件まで）
node tests/real-env/base-pr-observe.mjs --stage host --dry-run              # 計画のみ（claude を呼ばない）
node tests/real-env/base-pr-observe.mjs --stage host                        # 本番（claude を 1 回呼ぶ）
node tests/real-env/cleanup.mjs                                              # 記録されたものだけを削除
```

- `api` 段階（5.2）: main の commit から使い捨てブランチ `verify/brw-bpr-base-<epoch>`（分岐元役）・`verify/brw-bpr-prot-<epoch>`（保護役）・`verify/brw-bpr-same-<epoch>`（差なしの確認用）を作る。分岐元役に contents API で 1 commit を、`branch=` を指定して作る（main には書かない）。A1: head を分岐元役、base を保護役とする PR を作り、201・読み戻しの base・head・open を見る。A2: 同じ commit の組で PR を作り、422 と「No commits between」を見る。
- `host` 段階（8.2）: 分岐元役に宣言 `.branch-release-workflow.json` を contents API で commit し（登録済みにして確認省略を効かせる）、実 GitHub を匿名で clone して分岐元役をチェックアウトする。宣言・本文・フックの設定は clone の中だけに置く（`.git/info/exclude` で除外）。順序は次のとおり。
  - B3（承認が必要な宣言。編集中の宣言は未登録扱い）: 非端末で `brw pr` を直接実行し、`--confirmed` の案内で終了コード 1 になり、PR が作られないことを見る。PR が無い段階で行う必要がある（既存の PR があれば作成の判定より前に再利用されるため）。
  - B3c: 非端末で `--confirmed` を付けた `brw pr` が、通信の前に拒否されることを見る。
  - B1: 宣言を元に戻し、`claude -p`（Haiku・`--max-turns 10`・`--setting-sources project`・Bash のみ許可）に `brw pr-template` で本文を記入させ、`brw pr` を実行させる。PR が 1 件作られ、分岐元役のブランチ・clone の HEAD・リモートの先頭・`.git/brw` が変わらないことを見る。フックの記録（`hook-log/claude.jsonl`）で、両方の Bash が PostToolUse まで記録され、直接の `gh pr create` が無いことを確かめる。
  - B2: 同じ `brw pr` を直接実行し、「PR を再利用しました」と同じ URL が出て、PR が 1 件のままであることを見る。

### 安全制約

- GitHub へ書き込むのは、使い捨てブランチ（`verify/brw-bpr-*`）3 本と、PR（`api` で 1 件、`host` で 1 件）だけ。PR はマージしない。main・既存のブランチ・既存の PR・Ruleset・リポジトリ設定には書かない。
- 作ったブランチと PR は `prepare.mjs --record` で状態ファイルに記録し、`cleanup.mjs` が削除する（ブランチ名は `verify/` で始まり、削除対象の検査を通る）。
- 後始末の順序: 記録された使い捨てブランチごとに、そのブランチを head とするオープンな PR を GitHub に問い合わせて閉じてから、ブランチを削除する。問い合わせや PR のクローズに失敗したブランチは削除せず、失敗として表示する。PR の番号が読めなかった作成は、head で PR を探して記録する（探せなければ中止）。`cleanup.mjs` は、この観測の一時クローンと出力の置き場（`base-pr-observe/`）も消す。
- 生の出力は `/tmp/brw-real-env/base-pr-observe/` に残るが、`cleanup.mjs` で消える。そのため標準出力の末尾に観測の要点（コマンド・終了コード・出力の先頭 300 字・読み戻した PR の状態）を出す。
- トークンは表示・記録しない。`brw pr` は既存の認証（GH_TOKEN・gh のログイン）をそのまま使い、観測のコードは資格情報を渡さない。
- 利用者の `~/.claude` は読み書きしない。フックは `hook-logger.mjs` を挟み、記録先は `BRW_HOOK_LOG_DIR`（一時の場所）。
- Claude の呼び出しは共有カウンタ（`events/calls.json`）に加算し、上限は 3 回（`host` 段階は 1 回）。

### 記録の検証規則

- 判定は観測ごとに、ID（`A1`・`A2`・`B1`・`B2`・`B3`・`B3c` のどれか）、日時、コマンド、終了コード（整数）、出力（文字列）、facts（必須の項目の型・値）を検査する。欠け・型の誤り・想定外の ID・重複・解析できないフックの記録の行は「記録不正」とし、一致にしない。
- 読み取りの失敗（`null`）は「未観測」。ホスト（claude）の終了コードが 0 以外・タイムアウトも「未観測」（不一致にしない）。
- 想定との違い（PR の状態・ref や HEAD の変化・`.git/brw` の存在・出力の書式・記録に無いコマンド・直接の `gh pr create` の使用）は「不一致」。
- 出力の書式は `scripts/base-pr.mjs` の文言に合わせる（「PR を作成しました: <URL>」「PR を再利用しました: <URL>」「PR 作成には通常の承認が必要です」「--confirmed は、利用者が自分の端末で実行したときだけ有効です」）。
- B1 の実行の根拠は、フックの記録の `PostToolUse` にある `brw.mjs pr-template` と `brw.mjs pr`（`pr-template` を `pr` と数えない）。`claude -p` の stream-json の tool_result で、brw pr の出力を取る。
- 全体の判定は段階ごと。`api` は A1・A2、`host` は B1・B2・B3・B3c がすべてそろい、すべて一致のときだけ「一致」（終了コード 0）。

### 結果

- 実行の結果は下に記録した（実行日 2026-11-27）。

#### 結果（brw-pr-handoff 5.2・8.2、実行日 2026-11-27）

gh 2.45.0、Claude Code 2.1.329（Haiku）、実 GitHub（使い捨てブランチだけ。PR はマージしていない）。判定は記録の検証を通した結果で、観測ごとに生の記録と GitHub の読み戻し（`gh api`）を人が確認した。

| 項目 | 結果 |
|---|---|
| A1（5.2）分岐元役を head、保護役を base とする PR を API で作成 | **一致**: 201 で作成、base・head・open を読み戻した |
| A2（5.2）同じ commit の組（差なし）の PR | **一致**: 422「No commits between …」。PR は作られない |
| B1（8.2）登録済みの宣言で、claude が `brw pr-template` → 本文を記入 → `brw pr --title … --target …` | **一致**: フックの PreToolUse が allow（確認省略）、PR が 1 件作成（head=分岐元役・base=保護役・open）、直接の `gh pr create` は使われず、`.git/brw` が無く、別コミット・push が無い（リモートの分岐元役の先頭が不変）、未コミットの変更が 1 件で「PR には含まれません」と表示 |
| B2（8.2）同じ `brw pr` の再実行 | **一致**: 「PR を再利用しました」、同じ head・base のオープンな PR が 1 件のまま |
| B3（8.2）承認が必要な宣言（未登録）の非端末の `brw pr` | **一致**: PR を作らず `--confirmed` の全文を案内して終了コード 1 |
| B3c（8.2）非端末で `--confirmed` | **一致**: 「利用者が自分の端末で実行したときだけ有効」で拒否、取り込み・PR の作成を行わない |

- 経緯: (1) 最初の API 段階の実行で、道具が `gh api -i` の出力（ヘッダーが CRLF）の本文を読めず A1 が「未観測」・A2 が「不一致」になった（実際は 201・422 で想定どおり）。判定を直して回帰テストを足し、再実行して一致した。この実行で作られた PR #19 は記録が漏れたため手で閉じた。(2) 最初の host 段階の実行は、呼び出し回数の共有カウンタの累計が上限に達して中止した（書き込み前）。カウンタを戻して再実行した。(3) 2 回目の host 段階の実行で、検証用の宣言が保護ブランチを 2 つ（`main` と保護役）にしたため、`brw pr` は作成先を決められず `--target` を求めて**書き込みなしで停止**した（PR 0 件）。道具のコマンドに `--target <保護役>` を付けて再実行し、全観測が一致した。保護ブランチが複数の宣言で `--target` が要る挙動（7.2 の `resolveTarget`）が実機で確認できた。
- 最終確認: 後始末を「記録された使い捨てブランチを head とするオープンな PR を GitHub に問い合わせて閉じる」形に改めた後（記録漏れに依存しない）、API 段階と host 段階を再実行して全観測が一致し（PR #22・#23）、後始末が PR を閉じてブランチを削除した。
- 後片付け: 使い捨てブランチ `verify/brw-bpr-*`・`verify/brw-base-*`、PR #19〜#23（いずれもマージなし・クローズ）、一時クローンを削除した。`main` の commit は不変（`bd2c9b8`）。
- 未確認: Codex での分岐元からの PR、端末（TTY）での `brw pr --confirmed` の受理（単体試験は `stdinIsTTY` 注入）、保護ブランチが `main` だけの宣言での作成（`--target` 不要の経路は単体・統合試験で確認）。

## 結果（brw-pr-handoff 9.6 の後半、実行日 2026-11-27）

観測の道具は `tests/real-env/resume-observe.mjs`（`BRW_REAL_ENV=1 node tests/real-env/resume-observe.mjs --stage claude-main|claude-main-cdback|claude-inside`）。判定の純粋部分は `tests/resume-observe.mjs` が単体で試す（実機は呼ばない）。

### 実行の条件

- バージョン: Claude Code 2.1.329（`claude --version`）。Codex は観測していない（下の「未観測」）。
- 一時の環境: 使い捨ての一時ディレクトリ（一時リポジトリ・bare remote・偽の gh・偽の ssh・宣言・本文・フック）だけを使い、終了時に消す。GitHub へは接続も書き込みもしない（偽の gh が PR の状態を一時ファイルに持つ）。
- Claude: `-p --input-format stream-json` の同じセッションで 2 ターン（ターン 1: 公開、ターン 2: 続きの依頼）。`--setting-sources project` と一時プロジェクトの `.claude/settings.json`（`hooks/hooks.json` と同じ登録。観測用の記録を前置）。`~/.claude` の設定は、道具では読み書きしない（CLI が自分の認証を読むのは既定の動作）。`--no-session-persistence`。
- Codex: 一時の `CODEX_HOME`（認証を置かない）で `codex exec` を試したところ、401（認証なし）。資格情報は使わない方針のため、Codex の項目はすべて未観測。

### 項目ごとの結果（各ホスト・各構成で 3 回ずつ。再試行は各構成 2 回まで）

| 構成 | (a) 片付け後の記録に sessionId | (b) ターン 2 で案内が届く | (c) brw resume で作り直す | (d) 新しい作業ブランチを作らない |
|---|---|---|---|---|
| Claude（本体で開始・通常の `brw pr`） | 不一致 ×3 | 不一致 ×3 | 一致 ×3 | 一致 ×3 |
| Claude（本体で開始・`cd <wt> && brw pr ; cd <本体>`） | 不一致 ×3 | 不一致 ×3 | 一致 ×3 | 一致 ×3 |
| Claude（作業場所の中で開始） | 不一致 ×3 | 一致 1・不一致 1・一致 1（下の注） | 未観測 ×3 | 一致 ×3 |
| Codex | 未観測（認証なし） | 未観測 | 未観測 | 未観測 |

判定の根拠（実行の記録から）:

- (a) 不一致（本体で開始・通常）: `brw pr` の Bash 呼び出しは、作業場所を片付けた後に「Exit code 1」と報告された（シェルの作業ディレクトリが消えたため）。PostToolUse は成功した呼び出しだけに届くため、この呼び出しの関連付けは届かず、記録の sessionId は空のまま。
- (a) 不一致（cd で戻す形）: `brw pr` の呼び出しは成功（exit 0 相当）で、PostToolUse は届いた。しかし、コマンドの末尾が `; cd <本体>` のため、関連付けの字句解析（`;` を解釈しない）が「pr の呼び出し」と認めず、記録に付かなかった。同じ形の文字列を `scanWords` に通すと null になる（解析できない）ことを、node で確かめた。
- (b) 不一致: 同じセッションの UserPromptSubmit はターン 2 で動いた（ターン 1 と合わせて 2 回）。しかし案内の前提（同じセッションの記録に sessionId が付いていること）が無いため、案内は出ていない。答えの再開コマンドは、ターン 1 の `brw pr` の出力（「続きの再開:」の行）に由来する。
- (c) 一致（本体で開始）: ターン 2 で `brw resume dev/obs-resume` が実行され、作業場所が作り直された。ただし案内は出ていないため、フックの効果とは言えない（依頼文の中で、作業の再開を依頼していることによる）。
- (b)・(c)（作業場所の中で開始）: 削除後のシェルは作業ディレクトリが無く、Bash ツールが使えない（「シェルの作業ディレクトリが削除されている」と報告）。ターン 2 のフックは、3 回中 1 回だけ動いた（残る 2 回は動かず、既知の限界どおり）。動いた 1 回は、想定の「動かない」と異なる（不一致）。いずれも案内の前提が無く、案内は出ていない。(c) は resume を試みても作業場所が作られず（シェルが使えない）、未観測。
- (d) 一致: どの構成でも、新しいブランチは作られなかった。

### 実装について（報告。直していない）

1. 片付けつきの `brw pr` を作業場所の中で実行すると、Claude Code の Bash ツールは「Exit code 1」と報告する（作業ディレクトリが消えるため）。PostToolUse は成功した呼び出しだけに届くので、続きの再開の関連付け（sessionId）が付かない。設計の前提（成功した `brw pr` で付く）が、実機では成り立たない。
2. `cd <作業場所> && node <CLI> pr … ; cd <本体>` の形は、関連付けの字句解析が `;` を解釈せず、付かない（安全側）。
3. 作業場所の中で開始したセッションでも、削除後の入力でフックが動くことがあった（3 回中 1 回）。設計の「動かない」は、この環境では再現が揺れる。案内の内容は、1 の不具合（記録に sessionId が付かない）のため、どちらにせよ出ない。

### 限界

- Codex は未観測（認証が無い一時 CODEX_HOME。資格情報は使わない）。
- モデルの判断は揺れる（各構成 3 回のうち、同じ判定になったもの・ならなかったものを上の表に分けて記録した）。
- 観測の道具は、ターン 2 の依頼文で「作業の再開方法を答える」よう求める（案内が届いたかを、答えで確かめるため）。依頼の文言は、再開のコマンドを指示しない（実行は観測対象のモデルの判断）。
- 初回の探索（判定の前提や記録の仕組みを直す前）の実行は、判定の根拠に使っていない。
