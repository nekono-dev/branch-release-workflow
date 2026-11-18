# 宣言ファイル `.branch-release-workflow.json`

リポジトリのルートに置き、commit して登録する（CI やほかの clone も同じ宣言で判定するため。`brw check` は未登録を ERROR にする）。記入例は `assets/config.example.json`。不正な宣言は `brw` の各サブコマンドがエラーとして報告し、フックは commit・push のたびに確認を求める。

| キー | 内容 |
|---|---|
| `workBranches` | 作業ブランチの glob の配列（`*` は `/` を除く任意の文字列、`**` は `/` を含む）。必須で 1 件以上 |
| `protectedBranches` | 本番向けなど、直接作業を禁止するブランチの glob の配列。`workBranches` より先に判定する |
| `baseBranch` | 作業ブランチの分岐元。既定は `develop` |
| `namePattern` | 作業ブランチ名（接頭辞を含むブランチ名全体）の正規表現 |
| `maxNameLength` | 作業ブランチ名の最大文字数。既定は 54（プレビューのホスト名が DNS ラベルの 63 文字に収まるように） |
| `autoApprovePush` | 省略可（既定 false）。true にすると、作業ブランチへの通常の push だけのコマンドで、フックが許可を返して利用者への確認を省く（下の「push の確認の省略」） |
| `preview.provider` | `none` / `url-template` / `cloudflare-previews`。省略時は `urlTemplate` があれば `url-template`、無ければ `none` |
| `preview.urlTemplate` | プレビューURLの雛形。`{alias}`（ブランチ名の `/` を `-` にしたもの）を含める。`{branch}` も使える |
| `preview.aliasStripPrefix` | 省略可。alias を作る前にブランチ名から除く接頭辞（例: `"dev/"` で `dev/foo` の alias が `foo`）。プレビューURL・workflow 雛形・後始末の名前に効く |

`brw create` が新しいブランチに付ける接頭辞は、`workBranches` のうち最初の `xxx/*` 形式のもの（例: `dev/*` → `dev/`）。

旧 `.claude/branch-release-workflow.json` だけの構成も利用できる。両方が存在すればルートの正本を優先する。旧版と併用する場合は旧パスを正本へのシンボリックリンクにして値を共有する。

## provider

| provider | 内容 |
|---|---|
| `none` | プレビューを行わない。URL の案内・雛形・後始末は無い |
| `url-template` | URL の組み立てだけを行う。CI は利用者が用意する |
| `cloudflare-previews` | Cloudflare Workers の Previews（`wrangler preview`）。workflow 雛形・後始末・設定の検査がある。`references/cloudflare-previews.md` |

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

## push の確認の省略（`autoApprovePush`）

`autoApprovePush: true` を登録すると、作業ブランチへの push をエージェントへの指示ではなく設定として許可する。フックが `permissionDecision: "allow"` を返し、Claude Code は確認なしで実行する。settings.json の `permissions.deny` に書いた拒否ルールはこれより優先される。

許可はコマンド全体に効くため、次のどれかに当たるコマンドは確認を省かず、通常の確認に回す（拒否はしない）。

- `git push` と `cd <dir>` を `&&` で連ねた以外の形（`;`・`||`・`&`・コマンド置換・変数展開・`tail`/`head` 以外へのパイプ・ファイルへのリダイレクト）
- 環境変数の前置や `git -c` を伴うもの
- 強制（`-f`・`--force*`・`+refspec`）・削除（`--delete`・`:branch`）・タグ・`--all`・`--mirror`・`--no-verify`
- 送り先に保護ブランチや宣言外のブランチを含むもの
- `remote.<名前>.push` が設定されているリポジトリ、送り先を省き `push.default` が `simple`・`current` 以外か追跡先が別名のもの
- 宣言が未登録か、作業ツリーで `HEAD` から書き換えたもの（作業中に自分で許可を足せないようにする）

Codex の `brw guard` には影響しない。
