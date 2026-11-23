# Brief: harness-plugin-unification

## 課題（Problem）

BRW を Claude Code と Codex の両方で使う開発者とエージェントは、ハーネス（エージェントを動かす実行環境。Claude Code・Codex のこと）ごとに導入方法・更新方法・フックの登録先が違うため、作業を相手のハーネスへ引き継ぐときの手順が揃わず、仕組みも複雑になっている。

- Claude はマーケットプレイスからプラグインとして入れる。フックは同梱の `hooks/hooks.json` が `${CLAUDE_PLUGIN_ROOT}` で登録され、更新はプラグインの更新で済む。
- Codex は `~/.local/share/branch-release-workflow` へ手で git clone し、`~/.agents/skills` にリンクを張り、`install-codex.mjs --repo` で clone 先の絶対パスを導入先リポジトリごとの `.codex/hooks.json` に書き込む。linked worktree（同じリポジトリから追加で作った作業用のチェックアウト）では、空の `.codex/` を置かないと親の登録が読まれないため、`brw create`・`brw resume` が `.codex/` を作り、共通の `info/exclude` に追記する回避策を持つ。

## 現状（Current State）

- `.claude-plugin/plugin.json`（`skills: ["./"]`、ルートの `SKILL.md`）と `.claude-plugin/marketplace.json`（`source: "./"`）がある。`.codex-plugin/` は無い。
- Codex 向けの導入は `scripts/install-codex.mjs`、`scripts/hook-install.mjs` の `installCodexHooks`・`activateWorktree` 系、`brw setup` の Codex 登録、`brw check`（`hook-diagnose.mjs`）の `worktree-not-registered` 判定、`references/setup.md` の Codex 節が担う。
- 2026-11-23 に Codex CLI 0.167（`gpt-6.2-sol`、思考の深さ medium）で、一時的な `CODEX_HOME` を使って次を実機で確認した。
  - `codex plugin marketplace add <このリポジトリ>` は `.claude-plugin/marketplace.json` を受け付け、`codex plugin add branch-release-workflow@nekono-dev` で入る。`.codex-plugin/plugin.json` が無いと `.claude-plugin/plugin.json` を読み、**Claude 用の `hooks/hooks.json`（引数 `claude`）を Codex のフックとして読み込む**。現状のまま Codex に入れると誤った定義が登録される。
  - `.codex-plugin/plugin.json` の `hooks` で別ファイル（例 `./hooks/codex-hooks.json`）を指すと、既定の `hooks/hooks.json` は読まれない。`${PLUGIN_ROOT}` は Codex がインストール先の絶対パスへ展開する。フックの実行時には `PLUGIN_ROOT`・`CLAUDE_PLUGIN_ROOT`・`PLUGIN_DATA` が設定される。
  - スキルは `skills/<名前>/SKILL.md` の実ファイルだけが認識される。プラグイン直下の `SKILL.md`（`skills: "./"`）は認識されない。シンボリックリンクはキャッシュへコピーされず、消える。
  - プラグインのフックは信頼（そのフックのコマンドを実行してよいという利用者の承認）が無いと、`codex exec` でも飛ばされる。信頼は `~/.codex/config.toml` の `[hooks.state."<プラグイン>:<定義ファイル>:<イベント>:<番号>"]` に、定義のハッシュ（`trusted_hash`）とプラグインの中身全体のハッシュ（`trusted_content_hash`）として、フック 1 件ごとに保存される。リポジトリ単位でもプラグイン全体でもない。
  - app-server（Codex の内部 API）の `hooks/list` で現在のハッシュを取り、`config/batchWrite` で `hooks.state` に書くと信頼済みになる。その後は `--dangerously-bypass-hook-trust`（信頼の確認を飛ばすオプション）なしの `codex exec` でも、linked worktree（`.codex/` なし）でも、プラグインのフックが動いた。
  - インストールされたプラグインのキャッシュにある `scripts/agent-hooks.mjs codex PreToolUse` に Codex 形式の入力を渡すと、保護ブランチへの commit を拒否した。Codex（指揮役）にスキルが読み込まれ、Bash の実行ごとに PreToolUse・PostToolUse、終了時に Stop が呼ばれることも確認した。
  - リポジトリの `.codex/config.toml` に書いた `[marketplaces.*]` は認識されるが、`[plugins."…"] enabled = true` だけではプラグインは自動で入らない。`codex plugin add` が別に必要。
  - Codex のフックの入力には `turn_id`・`model` があり、Claude にはない。環境変数の `CLAUDECODE` は親プロセスから引き継がれることがあり、ハーネスを見分ける根拠にならない。

## 期待する結果（Desired Outcome）

- どちらのハーネスでも「マーケットプレイスを追加 → プラグインを入れる → `brw setup` → `brw check`」という同じ手順で導入・更新でき、作業を相手のハーネスへ引き継いでも同じスキル・同じ判定・同じフックの動作になる。
- 1 つのリポジトリ・1 つの版が、両ハーネスのプラグインの正本になる。Codex 専用の clone、絶対パスの登録、worktree ごとの有効化は無くなる。
- クラウド環境・CI・非対話の実行（`claude -p`・`codex exec`）でも、同じ導入手順（セットアップスクリプトから同じコマンドを実行する）でフックが有効になる。
- Codex では `brw setup` が BRW のフックの信頼を毎回登録して残し、更新で信頼が外れた状態を `brw check` が検出する。

## 採用方針（Approach）

**両ハーネスでプラグインとして配る**。同じリポジトリに Claude 用と Codex 用のマニフェストを並べ、マーケットプレイス定義は 1 つを共有する。フックの判定本体（`scripts/agent-hooks.mjs`）は共通のまま、ハーネスごとの定義ファイルで引数（`claude` / `codex`）と対象イベントだけを変える。

- 採用理由: Codex 0.167 のプラグイン機能（フック同梱・`${PLUGIN_ROOT}`・`.claude-plugin/marketplace.json` の読み込み）で、Claude と同じ配布・更新の形にできることを実機で確認した。worktree の回避策と絶対パスの管理が不要になり、仕組みが最も単純になる。
- 不採用: 導入先リポジトリへスクリプトを同梱する方式（CI では導入不要で動くが、更新のたびにコピーし直す必要があり、Claude の現行方式から離れる）。現行のまま手順だけ揃える方式（仕組みの違いが残る）。

フックの信頼は、`brw setup` が app-server の `hooks/list` と `config/batchWrite` で **BRW のフックの分だけ毎回登録して残す**（利用者が 2026-11-23 に決定。既存 brw-enforcement の「承認を代行しない」方針を、この範囲で改める）。BRW の信頼は BRW のフック定義 1 件ごとに付くため、BRW 以外のフックやコマンドの承認・サンドボックス（実行範囲の制限）を飛ばすことにはならない。プロジェクトの信頼（`[projects."<パス>"] trust_level`）には触れない。

## スコープ（Scope）

- **対象**
  - Codex 用マニフェスト（`.codex-plugin/plugin.json`）と Codex 用フック定義ファイルの追加。両ハーネスのフック定義を 1 つの対応表から作り、自己テストで食い違いを検出する。
  - スキルの配置を `skills/branch-release-workflow/SKILL.md` へ移し、両マニフェストから参照する（参照している文書・評価ケース・テストも追従させる）。
  - 共有のマーケットプレイス定義の扱い（`.claude-plugin/marketplace.json` を両ハーネスの正本にするか、`.agents/plugins/marketplace.json` を併置するかは設計で決める）。
  - 導入先リポジトリでの宣言: `.claude/settings.json`（`extraKnownMarketplaces`・`enabledPlugins`）と `.codex/config.toml`（`[marketplaces.*]`・`[plugins."…"]`）。
  - `brw setup` の Codex 側の処理を「プラグインの導入・有効化の確認と、BRW のフックの信頼の登録」に置き換える。登録できないとき（app-server が使えない、フックが無効化されている、管理者設定で管理対象のフックしか許されない等）は、理由と `/hooks` での手動承認を案内する。
  - `brw check` での、プラグインの未導入・無効・未信頼・古いハッシュ（更新後に登録し直していない）の区別と報告。
  - 旧方式の削除: `scripts/install-codex.mjs`、`.codex/hooks.json` への絶対パスの登録、`brw create`・`brw resume` の `.codex/` 有効化と `info/exclude` への追記、`worktree-not-registered` 判定、`~/.local/share` への clone と `--skills-dir` の手順。
  - クラウド・CI の導入手順（セットアップスクリプトで両ハーネスに同じコマンド列を実行する）と、README・`references/setup.md`・SKILL.md・AGENTS.md の案内の更新。
  - 受け入れ確認: `gpt-6.2-sol`（思考の深さ medium）の `codex exec` を指揮役（作業を進めるエージェント）として、一時的な `CODEX_HOME` で導入から保護ブランチの拒否・作業ブランチでの作業までを確かめる。Claude 側は既存の `claude plugin validate`・`claude plugin eval` で確かめる。
- **対象外**
  - 旧方式（`~/.local/share` の clone、`.codex/hooks.json` の登録）で導入済みの環境からの移行手段（利用者が不要と判断）。
  - ブランチ・push・PR の判定ロジック、確認省略（`autoApprove`）の条件、GitHub Ruleset、プレビュー・配備。
  - このリポジトリ自身の開発用フック（`.agent-hooks/cc-sdd-bootstrap/`）。
  - Codex の公開ディレクトリへの掲載（フック同梱のプラグインは掲載対象外）。

## 責務の境界（Boundary Candidates）

- **パッケージ定義**: 両マニフェスト、マーケットプレイス定義、スキルの配置、ハーネスごとのフック定義ファイルとその生成・整合検査。
- **導入と信頼の登録（`brw setup`）**: Codex のプラグインの状態確認、app-server を使った BRW のフックの信頼の登録、失敗時の案内。Claude 側はプラグインの登録状態の検査だけ。
- **診断（`brw check`）**: ハーネスごとの「強制が有効か」の判定と、未導入・無効・未信頼・古いハッシュの区別。
- **旧方式の撤去**: `install-codex.mjs`、worktree の有効化、関連するテストと文書の削除。
- **導入手順の文書**: 対話・クラウド・CI で共通の手順と、導入先リポジトリの宣言ファイルの記入例。

## 責務の外（Out of Boundary）

- フックが受け取った操作を許可・拒否する判定（`operation-decision.mjs` などの brw-enforcement の責務）。この spec はフックの「届け方」だけを扱う。
- ハーネスの応答形式への変換（`agent-hooks.mjs` の Claude / Codex の出し分け）。引数で指定する現行の形を保つ。
- Codex・Claude の製品側の信頼・承認の画面や仕様そのもの。

## 上流・下流（Upstream / Downstream）

- **上流**: Codex CLI のプラグイン機能（0.167 で確認。`.codex-plugin/plugin.json`、`hooks` の指定、`${PLUGIN_ROOT}`、`.claude-plugin/marketplace.json` の読み込み、app-server の `hooks/list`・`config/batchWrite`）。Claude Code のプラグイン機能。brw-enforcement の共通判定とフック応答（`scripts/agent-hooks.mjs`）。
- **下流**: 導入先リポジトリの利用者とエージェント、クラウド環境・CI のセットアップスクリプト、ハーネスをまたぐ作業の引き継ぎ。今後のハーネス追加（同じ「マニフェスト＋フック定義ファイル」の形で足せる）。

## 既存 spec との接点（Existing Spec Touchpoints）

- **Extends**: brw-enforcement。要件 86 行目付近（導入状態の検査で、未導入・未信頼・未対応を区別して報告する）と、Codex のフック導入（`installCodexHooks`・worktree の有効化）を扱う設計・タスクを、この spec の方式に置き換える。「信頼は製品の確認に任せ、承認を代行しない」という方針は、BRW のフックに限って「`brw setup` が毎回登録して残す」に改める。brw-enforcement の文書を直すかどうかは、要件定義の段階で決める。
- **Adjacent**: `scripts/agent-hooks.mjs`（応答の変換）、`scripts/hook-diagnose.mjs`（診断）、`scripts/setup-cli.mjs`（`brw setup`）、`scripts/brw.mjs` の `create`・`resume`。

## 制約（Constraints）

- Node.js 22 以上と Git だけで動かす。外部パッケージは使わない。Codex 側の操作は `codex` コマンドと app-server（標準入出力の JSON-RPC）で行う。
- Codex の対応版は 0.167 以上を前提とし、プラグインのフック機能が無い・無効（`[features] hooks = false`、`allow_managed_hooks_only` など）の環境は「未対応」として報告する。app-server は実験的な内部 API のため、使えないときは `/hooks` での手動承認へ切り替える。
- Codex の信頼はプラグインの中身全体のハッシュに結び付くため、プラグインを更新するたびに `brw setup` で登録し直す必要がある。外れた信頼はフック自身では検出できない（フックが呼ばれない）ため、`brw check` と手順の案内で補う。
- プラグインのキャッシュではシンボリックリンクが消えるため、配布物にシンボリックリンクを使わない。
- Claude の既存の導入（`/plugin install`、`.claude/settings.json` の宣言）と、`${CLAUDE_PLUGIN_ROOT}` を使う既存のフック定義を壊さない。
- このリポジトリには、特定のアプリケーション固有の値や例を含めない。
