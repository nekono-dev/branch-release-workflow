# 宣言ファイル `.branch-release-workflow.json`

リポジトリのルートに置き、commit して登録する（CI やほかの clone も同じ宣言で判定するため。`brw check` は未登録を ERROR にする）。記入例は `assets/config.example.json`。不正な宣言は `brw` の各サブコマンドがエラーとして報告し、フックは commit・push のたびに確認を求める。

| キー | 内容 |
|---|---|
| `workBranches` | 作業ブランチの glob の配列（`*` は `/` を除く任意の文字列、`**` は `/` を含む）。必須で 1 件以上 |
| `protectedBranches` | 本番向けなど、直接作業を禁止するブランチの glob の配列。`workBranches` より先に判定する |
| `baseBranch` | 作業ブランチの分岐元。既定は `develop` |
| `namePattern` | 作業ブランチ名（接頭辞を含むブランチ名全体）の正規表現 |
| `maxNameLength` | 作業ブランチ名の最大文字数。既定は 54（プレビューのホスト名が DNS ラベルの 63 文字に収まるように） |
| `autoApprove` | 省略可。確認を省く作業ブランチ運用の操作。省略した項目は有効、明示的な `false` だけが無効（下の「作業ブランチ運用の操作の確認の省略」） |
| `afterPublish.cleanup` | 省略可。PR を作成した後に、その作業の worktree・ローカルブランチ・作業状態を片付けるか。省略は有効、`false` の明示だけが無効（無効のときは何も削除せず、手動の片付け `brw finish` を案内する） |
| `pullRequest.language` | 省略可。`brw pr-template` が出す PR 本文の雛形の言語（`ja` / `en`）。省略は `ja`。リポジトリの `.github/PULL_REQUEST_TEMPLATE.md` があればそれを優先する |
| `preview.provider` | `none` / `url-template` / `cloudflare-previews`。省略時は `urlTemplate` があれば `url-template`、無ければ `none` |
| `preview.urlTemplate` | プレビューURLの雛形。`{alias}`（ブランチ名の `/` を `-` にしたもの）を含める。`{branch}` と `${変数}` も使える。ホスト名が `.workers.dev` で終われば workers.dev 配信、それ以外は独自ドメイン配信と判定する |
| `preview.target` | `deploy` があり provider が `cloudflare-previews` なら必須。プレビューを作る配備先（`deploy.targets` の名前） |
| `preview.aliasStripPrefix` | 省略可。alias を作る前にブランチ名から除く接頭辞（例: `"dev/"` で `dev/foo` の alias が `foo`）。プレビューURL・workflow 雛形・後始末の名前に効く |

## 配備先 `deploy`（本番用と開発用の Worker を分けるとき）

省略すると、従来どおりルートの wrangler 設定を直接使う（Worker は 1 つ）。書くと、CI がテンプレートから配備先ごとの wrangler 設定を生成する（`brw render-wrangler`）。

```jsonc
"deploy": {
  "provider": "cloudflare-workers",
  "template": "config/wrangler.template.jsonc",
  "output": "wrangler.jsonc",
  "renderHook": "node scripts/config/after-render.mjs",
  "brwSource": { "repository": "https://github.com/nekono-dev/branch-release-workflow.git", "ref": "main" },
  "targets": {
    "production": { "branches": ["release/**"], "worker": "app", "customDomain": "${SITE_HOST}" },
    "develop": { "branches": ["develop"], "worker": "app-develop", "customDomain": "develop.${SITE_HOST}" }
  }
}
```

| キー | 内容 |
|---|---|
| `provider` | `cloudflare-workers` だけ |
| `template` | wrangler 設定のテンプレート（JSONC）。必須 |
| `output` | 生成先。既定は `wrangler.jsonc`。生成物なので commit せず `.gitignore` に入れる |
| `renderHook` | 省略可。生成の後にシェルで実行するコマンド。環境変数 `BRW_TARGET`（配備先名）と `BRW_OUTPUT`（生成先の絶対パス）を受け取り、D1・R2 の名前などリポジトリ固有の加工を行う。非ゼロで終わると生成も失敗する |
| `brwSource` | 省略可。CI の雛形が取得する BRW のリポジトリ（`https://github.com/<owner>/<repo>.git`）と `ref`（ブランチ名か 40 桁のコミット）。既定は本体の `main` |
| `targets.<名前>.branches` | この配備先へ配備するブランチの glob。`protectedBranches` に含める |
| `targets.<名前>.worker` | Worker 名。省略時はテンプレートの `name` |
| `targets.<名前>.customDomain` | 独自ドメイン（ホスト名だけ）。省略すると workers.dev で公開 |

生成では、テンプレートの `name`・独自ドメインの route・`workers_dev`・`preview_urls`・`previews` だけを宣言どおりに書き換える。

| 生成するキー | 値 |
|---|---|
| `name` | 配備先の `worker` |
| 独自ドメインの route | テンプレートの `custom_domain: true` の route を除き、`customDomain` の route を加える。プレビュー先で独自ドメイン配信なら `previews_enabled: true` を付ける。ほかの route は残す |
| `workers_dev` | `customDomain` が無いときだけ `true` |
| `preview_urls` | プレビュー先で workers.dev 配信のときだけ `true` |
| `previews` | プレビュー先では必ず置く |

Worker を分けない構成でテンプレートから生成したいときは、配備先を 1 つにして、それをプレビュー先にする。

## 変数 `${NAME}`

`preview.urlTemplate`、`targets.*.worker`、`targets.*.customDomain` に書ける（NAME は英大文字・数字・`_`）。運用者ごとに違う値（ドメインなど）を宣言に直書きしないために使う。値は環境変数から取り、無ければ `gh api` で GitHub Variables を読む（`gh variable get` の無い古い gh でも動く）。雛形は、宣言で参照する変数を `${{ vars.NAME }}` で job に渡す。解決できないとき、`brw url` は変数を残したまま表示し、`render-wrangler` と `cleanup` は失敗する。

`brw create` が新しいブランチに付ける接頭辞は、`workBranches` のうち最初の `xxx/*` 形式のもの（例: `dev/*` → `dev/`）。

旧 `.claude/branch-release-workflow.json` だけの構成も利用できる。両方が存在すればルートの正本を優先する。旧版と併用する場合は旧パスを正本へのシンボリックリンクにして値を共有する。新しいパスへ移すには `brw setup --migrate` を使う（旧パスの内容と明示した値を保ち、旧パスは残す）。

## provider

| provider | 内容 |
|---|---|
| `none` | プレビューを行わない。URL の案内・雛形・後始末は無い |
| `url-template` | URL の組み立てだけを行う。CI は利用者が用意する |
| `cloudflare-previews` | Cloudflare Workers の Previews（`wrangler preview`）。workflow 雛形・後始末・設定の検査がある。独自ドメイン配信と workers.dev 配信に対応する。`references/cloudflare-previews.md` |

## フックの判定

| 状況 | 判定 |
|---|---|
| 宣言ファイルが無い | 判定しない（運用の対象外） |
| 宣言ファイルが無いが、`.claude/settings.json` の `enabledPlugins` でこのプラグインを有効にしている | 拒否（導入の途中なので、宣言を作って登録するまで止める） |
| 宣言が不正 | 確認を求める |
| `protectedBranches` に一致 | 拒否 |
| `workBranches` に一致 | 許可 |
| どちらにも一致しない | 拒否 |
| ブランチを特定できない（detached HEAD）、`--all` / `--mirror` | 確認を求める |

push は送り先の引数（`HEAD:main`、`refs/heads/...` など）から実際に更新されるブランチを求めて判定する。CI などで使うブランチ（`claude/**` など）も作業ブランチとして扱いたいときは、`workBranches` に加える。

## 作業ブランチ運用の操作の確認の省略（`autoApprove`）

作業ブランチ運用では、作業ブランチへの push と、作業ブランチから切り出し元（`baseBranch`）への PR の作成は、利用者の許可なしで行ってよい。`autoApprove` を登録すると、これをエージェントへの指示ではなく設定として許可する。フックが `permissionDecision: "allow"` を返し、Claude Code は確認なしで実行する。settings.json の `permissions.deny` に書いた拒否ルールはこれより優先される。

```json
"autoApprove": { "push": true, "pullRequest": true }
```

既定値は有効である。`autoApprove` を省くか、キーを省いた項目は確認を省く（上の例の `"autoApprove": { "push": true, "pullRequest": true }` は省略できる同じ既定値を明示したもの）。確認を求めたい項目だけ `false` を明示する（例: `"autoApprove": { "push": false }`）。無効化を取り消すには、その `false` を削除して commit する。旧版（旧パスの宣言）は未指定を確認が必要と扱っていたため、旧パスの宣言を移行するときは `brw setup --migrate` が変更点を表示する（[導入手順の移行](setup.md#6-旧パスの宣言を移行する)）。

| キー | 対象 |
| --- | --- |
| `push` | 作業ブランチへの `git push` |
| `pullRequest` | 作業ブランチから切り出し元への `gh pr create --base <baseBranch>` |

許可はコマンド全体に効くため、次のどれかに当たるコマンドは確認を省かず、通常の確認に回す（拒否はしない）。

- `git push`・`gh pr create` と `cd <dir>` を `&&` で連ねた以外の形（引用符の外の `;`・`||`・`&`・括弧、`tail`/`head` 以外へのパイプ、ファイルへのリダイレクト、引用符の外か二重引用符の中の `$`・`` ` ``・`\`）。PR の本文に展開が要るときは `--body-file` を使う
- 環境変数の前置や `git -c` を伴うもの
- 強制（`-f`・`--force*`・`+refspec`）・削除（`--delete`・`:branch`）・タグ・`--all`・`--mirror`・`--no-verify`
- 送り先に保護ブランチや宣言外のブランチを含む push
- `remote.<名前>.push` が設定されているリポジトリ、送り先を省き `push.default` が `simple`・`current` 以外か追跡先が別名の push
- `--base` が `baseBranch` でないか省いた PR、取り込み元が作業ブランチでない PR、`-R`（他のリポジトリ）・`--web` を伴う PR
- 宣言が未登録か、作業ツリーで `HEAD` から書き換えたもの（作業中に自分で許可を足せないようにする）

切り出し元・保護ブランチへのマージ（`gh pr merge` など）は対象外で、常に確認を求める。Codex の `brw guard` には影響しない。

### 基底の更新・取り込みの確認の省略

次の取り込みは、`autoApprove` のキーとは別に、宣言が登録済みで作業ツリーの宣言が `HEAD` と一致するときに確認を省く。未登録・編集中のときは省かず、通常の承認に任せる。手順は SKILL.md の「基底ブランチへの追従」。

- 基底・保護ブランチの fast-forward 更新: `git pull --ff-only origin <基底>`、基底を確認していない作業ツリーでの `git fetch origin <基底>:<基底>`、確認中の作業ツリーを指す `git -C <その作業ツリー> pull --ff-only origin <基底>`
- 開発ブランチへの基底・保護ブランチの取り込み: `git merge origin/<基底>`、`git pull origin <基底>`

対象外（拒否される。確認の省略以前に実行できない）のは、リベース（`--rebase`、`pull.rebase` などの設定）、基底の更新での `--ff-only` の無い `git pull`・`--no-ff`・`--squash`・`+` 付きの更新、分岐した merge、`origin` 以外のリモートや手元の別ブランチからの取り込み。取り込み元の指定がない操作（`git merge --abort` など）は確認を省かない。fast-forward にならない分岐は git が止める。`pull`・`fetch` は取得前に判定するので、分岐は事前には確かめない（診断の限界 `sync-ff-unverified`）。
