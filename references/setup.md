# 導入

このリポジトリは Claude Code のプラグインで、スキルと、commit・push を判定する PreToolUse フックを含む。プラグインを有効にすれば、リポジトリへスキルをコピーする必要はない。フックは宣言ファイルの無いリポジトリでは何もしない（リポジトリの設定で有効にしている場合を除く）ので、自分の環境ではどのリポジトリで有効にしてもよい。要件は Node.js 22 以上と git で、外部パッケージは使わない。

## 1. 宣言ファイルを作り、リポジトリに登録する（必須）

導入では、必ず宣言ファイルを作って commit する。宣言はリポジトリの中にあるものだけが判定に使われるため、手元に置いただけでは CI・クラウドセッション・ほかの人の clone から見えず、運用が効かない。リポジトリの設定でプラグインを有効にしたのに宣言が無いと、フックは commit・push をすべて拒否する。

1. 次の値を利用者に確認する。推測で埋めない。各キーは `references/config.md`。
   - 作業ブランチの命名（例: `dev/*`）と、分岐元（例: `develop`。リポジトリに無ければ作るか別のブランチにするか確認する）
   - 保護ブランチ（本番デプロイが走るブランチ。例: `main`）
   - プレビューの有無と公開先の URL の形
2. `assets/config.example.json` を元に、本体の作業ツリーへ `.branch-release-workflow.json` を書く。
3. `brw create <名前>`（例: `add-branch-release-workflow`）で導入用の作業ブランチを作る。宣言は分岐元にまだ無いので、新しい worktree へ移る。
4. その worktree で `brw check` を実行し、workflow との整合を確かめる（未登録の宣言は ERROR になる。commit 後に消える）。プレビューの workflow が無ければ `brw gen-workflow` で雛形を示す。
5. 宣言を commit する。リポジトリ単位でプラグインを有効にする場合（下の 2 章）は、`.claude/settings.json` も同じ commit に入れる。
6. push し、分岐元へ取り込む（プルリクエストなど、リポジトリの流れに従う）。取り込まれるまでは、ほかのブランチでは宣言が見えない。

作業ブランチの push は許可なしで行う運用なので、切り出し元と保護ブランチへの取り込みがリモート側の関門になる。GitHub のブランチ保護（直接 push の禁止、PR とレビューの必須化）で守ることを利用者に勧める。

## 2. プラグインを有効にする

どれか 1 つでよい。settings.json を変える場合は、変更内容を利用者に示して承認を得てから書く（フックの追加は Claude の動作を変えるため）。

### リポジトリで有効にする（チーム・クラウドセッション向け）

リポジトリの `.claude/settings.json` に入れ、宣言ファイルと同じ commit に入れる（1 章の 5）。リポジトリを開いた人に、このプラグインの導入が案内される。

```json
{
  "extraKnownMarketplaces": {
    "nekono-dev": { "source": { "source": "github", "repo": "nekono-dev/branch-release-workflow" } }
  },
  "enabledPlugins": { "branch-release-workflow@nekono-dev": true }
}
```

### 自分の環境で有効にする

```
/plugin install branch-release-workflow --marketplace nekono-dev/branch-release-workflow
```

更新は `claude plugin update branch-release-workflow@nekono-dev`。

### CI で使う

GitHub Actions の `anthropics/claude-code-action` では入力で指定する。

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    plugin_marketplaces: https://github.com/nekono-dev/branch-release-workflow.git
    plugins: branch-release-workflow@nekono-dev
    branch_prefix: dev/      # 宣言の作業ブランチに合わせる（下記）
    base_branch: develop     # 宣言の baseBranch
```

それ以外の CI では、clone したディレクトリを `--plugin-dir` で読み込む。

```sh
git clone --depth 1 https://github.com/nekono-dev/branch-release-workflow.git "$RUNNER_TEMP/brw"
claude -p "..." --plugin-dir "$RUNNER_TEMP/brw"
```

CI は checkout したリポジトリの宣言で判定するので、宣言が登録済みであることが前提になる。CI が作るブランチも宣言に合わせる。合わないとフックが commit を拒否する。

- claude-code-action では、`branch_prefix` を作業ブランチの接頭辞（例: `dev/`）に、`base_branch` を宣言の `baseBranch`（例: `develop`）にするのが簡単。既定の `claude/...` は `dev/*` に合わない。作られる名前（例: `dev/issue-12-20261025-0930`）が `namePattern` と `maxNameLength` に収まるかも確かめる。
- 接頭辞を変えられない CI では、そのパターン（例: `claude/**`）を `workBranches` に加える。

### 開発中の版を試す

```sh
claude --plugin-dir <このリポジトリの clone>
```

## 3. 確認する

- `brw check` が ERROR を出さないこと（宣言が登録されている）
- 保護ブランチ上で `git commit` を試み、フックに拒否されること
- `brw create <名前>` で作業ブランチと worktree ができること
- フックが使えない環境（未導入・未信頼の Codex など）では、応答を終える前に `brw guard --finish` を実行する必要がある（終了前の確認は SKILL.md の「作業の区切りと終了前の確認」）。フックのある環境では Stop のフックが同じ判定で止める。

### PR のマージ（利用者の端末）

取り込み先で手順が分かれる（SKILL.md の 4 章「PR のマージ（取り込み先ごと）」）。
- **分岐元向けの PR**: 利用者が自分の端末で `brw pr-merge <PR 番号>` を実行する。対話端末が必要（標準入力・標準出力が端末）。Claude Code の `!` での実行は端末判定を満たさない可能性があるため、別の端末で実行する。
- **保護ブランチ向けの PR**: `brw pr-merge` は拒否する。リポジトリのマージ条件を満たす利用者が GitHub 上でマージする。
- **トークン**: `brw pr-merge` を実行できるトークン（`GH_TOKEN`・`GITHUB_TOKEN`・`gh auth login` の保存済みログイン）は利用者のものに限る。エージェントの環境にマージ権限のあるトークンを渡さない。
- **迂回の限界**: 端末判定は協調的な誤用の防止であり、疑似端末などによる迂回を防ぐ強制ではない。迂回を許さない保証は GitHub 側のマージ権限と Ruleset が与える。
- **マージ条件**: 必須チェック・レビューは GitHub 側の設定が決める。条件を満たさないと GitHub が 405 で拒否し、`brw pr-merge` は理由を表示する。
- **状態**: 状態ファイルや作業の記録を作らず、ブランチを削除しない（片付けは `brw finish`）。

### 分岐元から保護ブランチへの PR（分岐元のチェックアウト）

分岐元のチェックアウトで行う。対象は `baseBranch`・`baseBranches` の恒常的な分岐元で、保護ブランチに該当しないもの。`brw pr-template` が出す記入指示に従って本文を記入してから、`brw pr` を `--title "<タイトル>"` を付けて実行する。`brw pr` は 3 段（取り込み → 作成 → 報告）だけを行い、作業の記録・別コミット・片付けは行わない。手順の詳細は SKILL.md の 4 章。受け付けられない組（開発ブランチ間など）は、GitHub 上での作成か `brw merge` になる（同じ 4 章）。

## 4. Ruleset とフックを導入する（brw setup）

```sh
brw setup                   # Ruleset は既定で導入しない（対話は `導入しますか [y/N]`、Enter で見送り）
brw setup --ruleset off     # 見送りを明示する（GitHub の認証は不要。選択は保存され、次回も見送りになる）
brw setup --ruleset on      # 導入する（管理者が求めたときだけ。非対話でも指定できる）
```

Ruleset（GitHub 側で分岐元を PR 必須・squash 限定にする機能）は BRW の本分ではなく、導入の追加事項で既定 off である。管理者が初回導入時に求めたときだけ、エージェントが `--ruleset on` で設定する。エージェントが自発的に提案・実行してはならない。要求がなければ GitHub への認証要求・通信・書き込みは一切行わない。

注意（限界）: 導入の選択はクローンごとのローカル記録（`<git の共通ディレクトリ>/brw/ruleset-choice.json`）に保存する。記録の無いクローンでは、GitHub に導入済みの Ruleset があっても `brw check --ruleset` は「未選択」（終了コード 0）になり、ずれは見えない。導入済みかどうかを確かめるときは、導入したクローンで検査するか、`brw setup --ruleset on` を再実行する（同条件の既存 Ruleset は再利用され、重複登録しない）。

`brw setup` は次の順に進める。

1. 宣言を読み、ローカルのリモート設定から対象（GitHub のリポジトリ。`origin` を優先）を表示する。
2. 恒常的な分岐元（`baseBranch` と `baseBranches`）を Ruleset の対象にする。作業ブランチや一時的な分岐元は対象にしない。
3. 導入するかを決める。既定は導入しない。対話では対象と効果を示し、`導入しますか [y/N]` と聞く（Enter は見送り）。非対話で `--ruleset` を指定せず保存済みの選択も無いときは見送り（終了コード 0。通信・書き込みなし。選択は記録せず、後から `--ruleset on` で導入できる）で、フックの導入は続ける。過去の選択が読み取れない（対象変更・記録破損など）ときは推測せず保留し（終了コード 3）、適用はしない。
4. 導入する場合は、GitHub の応答でホスト・所有者・名前を照合してリポジトリ ID を確定する。保存済みの ID と違えば、書き込まずに再確認を求める。
5. 管理権限と既存のルールを事前に確かめる（読み取りだけ）。不足・競合・確認不能があれば、変更せず理由を表示する。
6. 不足している分岐元だけを対象に Ruleset を 1 件追加する。既存の Ruleset は更新・削除しない。
7. 適用後の有効な設定を読み直し、PR 必須・squash 限定・バイパスなしを確かめる。
8. フックを導入する。Codex は導入先の `.codex/hooks.json` に登録する（同じ登録の再実行は変更なし）。Claude は同梱の登録を検査する。

追加される Ruleset は `brw-pr-squash` という名前で、対象は分岐元の完全な `refs/heads/<名前>`、PR 必須・squash 限定・バイパスなし・有効である。既存のレビュー・必須チェックは別のルールのまま変更しない。squash がリポジトリで無効な場合は、リポジトリ全体の設定を暗黙に変えず、競合として表示する。

認証は 2 つに分ける。

| 環境変数 | 用途 | 未設定のとき |
|---|---|---|
| `BRW_SETUP_GH_TOKEN` | 導入・適用・状態検査の設定用（管理権限が必要） | gh の保存済みログインを使う |
| `BRW_WORK_GH_TOKEN` | 作業経路の権限の確認（通常作業で使う認証。Ruleset を変えられないもの） | 作業経路を確認できず、適用後の検査は確認不能（終了コード 3）になる |

値は表示も記録もしない。`BRW_WORK_GH_TOKEN` を設定して `brw check --ruleset` を実行すると、作業経路が Ruleset を迂回できないことを確かめられる。

注意（非対話の実行）: `--ruleset on` は非対話（エージェントや CI）でも指定できる。その場合、`BRW_SETUP_GH_TOKEN` が未設定だと gh の保存済みログイン（そのホストの既定の資格情報）で Ruleset を書き込む。つまり、その端末の管理権限でエージェントが書き込みを起動できてしまう。エージェントに導入を任せるときは、管理権限のない資格情報を保存済みログインにしておくか、`BRW_SETUP_GH_TOKEN` に導入専用の資格情報を渡し、通常の作業の環境には置かないこと。`brw setup` と `brw check --ruleset` の子の gh には、この 2 つの変数は継承させない（引数の資格情報 1 つだけを渡す）。

## 5. 状態を確かめる（brw check）

```sh
brw check                    # 宣言の整合とフックの稼働（経路ごと）を表示する
brw check --ruleset          # 加えて Ruleset の状態を読み取りだけで検査する（書き込みはしない）
brw check --branches-only    # 宣言と分岐の整合だけ（フックと Ruleset は表示しない）
```

| 終了コード | 意味 |
|---|---|
| 0 | 問題なし（見送り・未選択の Ruleset を含む） |
| 1 | 宣言・整合の誤り、または Ruleset の設定のずれ（迂回できる作業経路を含む） |
| 2 | 使い方の誤り |
| 3 | Ruleset の確認不能、または過去の選択が読み取れない保留（確認できる権限や選択を用意して再実行する） |

フックの状態（`active`・`not-installed`・`untrusted`・`unsupported`・`conflict`・`unverifiable`）は経路ごとに表示し、終了コードには含めない。対応していない経路（クラウドの実行環境、ツールが別経路の書き込み、対話シェルの命令など）の限界も一覧で示す。

## 6. 旧パスの宣言を移行する

`.claude/branch-release-workflow.json` だけのリポジトリは、次で新しいパスへ移す。

```sh
brw setup --migrate                        # 変更点を表示してから .branch-release-workflow.json を作る
brw setup --migrate --keep-confirm push    # push も確認を求める（既定では省く）
```

- 旧パスの内容と明示した値（`false` など）は保つ。旧パスは残すので、内容を確認して commit したあと `git rm` で削除する。
- 新しい既定値では、`autoApprove` を省いた項目の確認を省く（旧版は確認を求めていた）。移行の差分にこの変更点が出るので、従来どおり確認を求めたい項目は `--keep-confirm` で明示する。
- 新旧の宣言の内容が違うときは上書きせず、どちらを使うかを利用者に決めてもらう。

## 7. 復旧

- 特定の作業で push や PR を止める: `brw work restrict --work <作業 ID> --no-push`（または `--no-pr`）。記録した禁止は外せない。
- 宣言の確認省略を止める: 宣言の `autoApprove` の該当キーを `false` にして commit する。
- Codex のフックを外す: `.codex/hooks.json` から `agent-hooks.mjs` を指す BRW の定義だけを取り除く（ほかの定義は残す）。Claude はプラグインを無効化する。
- Ruleset を外す: BRW は既存の Ruleset を削除しない。`brw setup` が表示した Ruleset ID（`brw-pr-squash`）を、GitHub の Rulesets 画面で管理者が削除する。既存のルールの復旧を伴う変更は、その管理主体に委ねる。
- 導入をやり直す: 対象や分岐元が変わったら `brw setup` で採否を選び直す。保存済みの選択は `<git の共通ディレクトリ>/brw/ruleset-choice.json` にあり、壊れている場合は直すか削除してから選び直す。

## Codex

同じリポジトリを外部へ clone し、Codex の探索先からリンクする。Claude の hooks は Codex に自動導入されない。

```sh
git clone https://github.com/nekono-dev/branch-release-workflow.git ~/.local/share/branch-release-workflow
node ~/.local/share/branch-release-workflow/scripts/install-codex.mjs --repo /path/to/repo
```

`--repo` で導入先リポジトリの `.codex/hooks.json` に BRW のフックを登録する（既存の定義は保持し、同じ登録の再実行は変更なしで終わる）。登録後、Codex で `/hooks` から信頼を承認する。登録元や衝突を解決できなければ対象の箇所を表示して止まる。

linked worktree では、Codex（0.167 で実機確認）は**親（本体）チェックアウトの `.codex/hooks.json` を読む**が、worktree 自身に `.codex/` ディレクトリがあるときだけである（空でもよい。worktree 側の hooks.json の中身は読まれず、登録と信頼は親に結び付く）。`.codex/` が無い worktree では、親が登録済みでもフックは届かない。`brw create`・`brw resume` は、親に BRW の登録があるとき新しい worktree に `.codex/` を作って有効化する（共通の `info/exclude` に `.codex/` を足し、未追跡として現れないようにする。`info/exclude` は親チェックアウトと全 worktree で共有されるため、この除外は親にも及び、親の `.codex/`（hooks.json など）も未追跡として表示されなくなる）。`install-codex.mjs --repo <worktree>` も同じ有効化を行い、同じ共通の `info/exclude` に `.codex/` を追記する。手作業で作った worktree は `install-codex.mjs --repo <その worktree>` で有効化する。診断（`brw check`）は、`.codex/` の無い worktree を `worktree-not-registered`（未導入）と表示する。

更新は `git -C ~/.local/share/branch-release-workflow pull --ff-only`。検証済みの版に固定する運用では、そのコミットを fetch / checkout する。リンク先は同じ clone なので、コピーし直す必要はない。プロジェクト単位なら `--skills-dir /path/to/project/.agents/skills` を指定し、生成されたリンクを .gitignore に入れる。別の導入先が既にある場合は上書きしない。

新規 clone / worktree / クラウド環境でもセットアップを実行する。AGENTS.md には共有宣言のパス、セットアップ手順、commit・push の前に `brw guard "実際のコマンド"` を実行することを書く。skill が見つからなければセットアップ後に再読み込みするか、外部 clone の SKILL.md を直接読む。

宣言の正本は `.branch-release-workflow.json`。旧 `.claude/branch-release-workflow.json` だけのリポジトリも利用できる。旧版の Claude プラグインと併用するときは、旧パスを `../.branch-release-workflow.json` へのシンボリックリンクにし、値を二重管理しない。

Codex の探索先とシンボリックリンク対応: https://learn.chatgpt.com/docs/build-skills
