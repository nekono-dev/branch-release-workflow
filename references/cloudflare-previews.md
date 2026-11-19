# Cloudflare Previews（provider: cloudflare-previews）

`wrangler preview`（open beta）でブランチ別の Preview を配信する方式。配信先は独自ドメインと workers.dev から選べ、宣言の `preview.urlTemplate` のホスト名で決まる（`.workers.dev` で終われば workers.dev 配信）。旧方式の `wrangler versions upload --preview-alias` は workers.dev 以外で配信できないため、Previews を使う。

## 配信方式と URL

実機（wrangler 4.165.0）で確認した URL の形。Preview の URL は同じ名前なら作り直しても変わらない。

| 配信方式 | Preview の URL | 必要な設定（プレビュー先の Worker） |
|---|---|---|
| 独自ドメイン | `https://<名前>.<独自ドメイン>` | 独自ドメインの route に `previews_enabled: true` |
| workers.dev | `https://<名前>-<Worker 名>.<アカウントのサブドメイン>.workers.dev` | `preview_urls: true`（`workers_dev: false` のままでよい） |

- どちらの設定も無いと、`wrangler preview` は成功するのに URL が空になる。`brw check` はこれを ERROR にする。
- これとは別に、デプロイごとの URL（`<ID 先頭 8 桁>-<Worker 名>...` や `<ID 先頭 8 桁>.<独自ドメイン>`）も出る。案内には Preview の URL（`brw url`）を使う。
- 独自ドメインの Preview は、2 階層目のサブドメイン（`<名前>.develop.example.com`）の証明書の発行に数分かかる。push 直後に繋がらなければ待つ。
- workers.dev の場合、プレビューのホスト名の先頭のラベルは「名前-Worker 名」なので、Worker 名の分だけプレビュー名に使える文字数が減る（63 文字まで）。

## 本番用と開発用の Worker を分ける

宣言に `deploy` を書くと、配備先ごとに Worker を分け、プレビューは `preview.target` の Worker（開発用）に作る（`references/config.md`）。CI は `brw render-wrangler --target <配備先> --write` でテンプレートから wrangler 設定を生成してから、`wrangler deploy` か `wrangler preview` を実行する（`brw gen-workflow deploy` / `preview` の雛形）。

実機で確認した組み合わせ:

| 構成 | 結果 |
|---|---|
| 本番: 独自ドメイン、`workers_dev: false`・`preview_urls: false` | 独自ドメインで本番が応答。workers.dev は無効（1042） |
| 開発: 独自ドメインなし、`workers_dev: false`・`preview_urls: true` | Worker 本体の workers.dev は無効のまま、Preview だけ workers.dev で応答 |
| 開発: 独自ドメイン＋`previews_enabled: true`、`preview_urls: false` | Preview は独自ドメインで応答。workers.dev の Preview は無効（1042） |

後始末は `wrangler preview delete -y --worker-name <プレビュー先の Worker> --name <名前>`（`brw cleanup`）。設定ファイルが無くても削除先を指定できる。存在しない名前は終了コード 1。

- `customDomain` を外して配備しても、`wrangler deploy` は前に付けた独自ドメインを Worker から外さない（実機で確認）。独自ドメイン配信から workers.dev 配信へ移すときは、ダッシュボードか Workers ドメイン API で独自ドメインを外す。残したままだと、Preview は独自ドメインと workers.dev の両方の URL で作られる。
- Preview の削除は、数十秒ほどで独自ドメインにも反映される（それまでは前の内容が返ることがある）。

検証環境で `brw render-wrangler` の生成結果をそのまま配備し、独自ドメイン配信・workers.dev 配信とも、`brw url` の URL と wrangler が返す Preview の URL が一致して応答すること、`brw cleanup --execute` で削除できることを確認した（wrangler 4.165.0）。

## 前提

- wrangler 4.135.0 以上
- Worker のカスタムドメインに `previews_enabled: true` を付ける。`<名前>.<そのドメイン>` で配信され、ワイルドカード DNS と証明書は Cloudflare が自動で作る
- Preview 名は既定で現在の git ブランチ名。`--name` で指定する（このスキルは `/` を `-` にした alias を使う）
- 削除: `wrangler preview delete --name <名前>`（`brw.mjs cleanup <ブランチ> --execute`）

## 設定上の注意

- `wrangler.jsonc` の `previews` ブロックで設定する。**トップレベルの `vars` は引き継がれない**ため、Preview 用の値を `previews.vars` に明示する
- Secrets は設定ファイルに書けず、`wrangler preview secret put` で投入する
- プレビューを本番データに届かない状態にするには、`previews.vars` と Preview 用バインディングを本番と分ける。本番と同じ値を入れると、外部への書き込みは本番データに届く
- Routes、Cron、Service Binding は本番を向く。Queue consumer は Preview に向けられない
- 独自ドメインの Preview には noindex が付かない。Cloudflare Access か `_headers` で対処する
- Free プランは 100 Preview/Worker で、超過分は古いものから自動削除される

## workers.dev の設定

`workers_dev` と `preview_urls` は、省略せず明示する。配備先を宣言しない構成では `brw wrangler-config` が設定する（`workers_dev` は独自ドメインが無いときだけ `true`。`preview_urls` は workers.dev 配信なら `true`、独自ドメイン配信なら `workers_dev` と同じ）。配備先を宣言した構成では `brw render-wrangler` が設定する。独自ドメインの有効判定は、`routes` の `custom_domain: true` で `enabled: false` でないもの。

実機の確認結果（wrangler 4.147.0、`routes` に独自ドメインがある使い捨て Worker）:

| 操作                                              | 結果                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 両キー省略で初回 `wrangler deploy`                 | workers.dev・Preview URL とも無効                                                                 |
| 両方 `true` で deploy                              | workers.dev・Preview URL とも有効                                                                 |
| 有効な状態から両キー省略で deploy                  | 両方無効になる。`'workers_dev' is not in your Wrangler file, it will be disabled` の警告が毎回出る |
| 両方 `false` で deploy                             | 両方無効。警告なし                                                                                |
| `wrangler versions upload`                         | 省略・`false` のどちらでも状態を変えない（有効なままなら Version Preview URL が workers.dev に出る） |
| `wrangler preview`                                 | 状態を変えない。workers.dev が有効なままだと Preview URL が workers.dev に出る                    |

省略しても deploy の結果は `false` と同じだが、警告が出て wrangler の既定値に依存するため、明示する。また `wrangler preview` に `previews: {}` と、ルートの `previews_enabled: true`（と一度の deploy）が必要である。

## ハマりどころ

既存の手動ワイルドカード DNS レコードや、同じホスト名のゾーンルートがあると、`previews_enabled` の有効化が `Hostname '*.xxx' already has externally managed DNS records`（コード 100117）で失敗する。先にそれらを削除する。

## API

Workers ドメイン API（`PUT /accounts/{id}/workers/domains`）は `previews_enabled` を扱える。DNS の読み書きには `Zone > DNS` の権限が別途必要。

## このスキルが機械判定できないこと

- workflow が本番向けか（`wrangler deploy` か `wrangler preview` か）の意味
- Cloudflare 側の設定（`previews_enabled` の実際の状態、Pages の本番ブランチなど）
