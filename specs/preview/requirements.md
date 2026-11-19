# プレビュー運用 要件定義書

## 1. 目的

作業ブランチの push でプレビューを配信する運用を、宣言ファイルの provider 指定で切り替えられるようにする。プレビューURLの算出、宣言と CI 設定の整合検査、workflow 雛形の生成、provider 固有の後始末を機械的に行い、リポジトリ固有の値をスキルに持たない。

## 2. スコープ

### 2.1 対象

- ブランチ名からのプレビューURLの算出。
- provider の切り替え。
- 宣言と workflow・provider 設定の整合検査。
- preview 用 workflow 雛形の生成。
- provider 固有の後始末コマンドの提示と実行。
- Cloudflare の wrangler 設定の workers.dev 関連キーの、独自ドメインの有効状況に応じた設定。

### 2.2 対象外

- workflow が本番向けかどうかの意味の判定。
- リポジトリ外の設定の検査。

## 3. 前提

- 前提: branch-guard — 宣言ファイルの読み込みと作業ブランチの判定を使う。
- 前提: deploy — 配備先の宣言と変数の解決を使う。

## 4. 機能要件

- FR-1: 作業ブランチ名の斜線をハイフンに置き換えた alias から、宣言のURL雛形に従ってプレビューURLを算出する。
- FR-2: provider の指定により、検査・雛形・後始末の挙動を切り替える。
- FR-3: 宣言の作業ブランチと保護ブランチに含まれないのに push で動く CI の指定を警告する。
- FR-4: Cloudflare の provider では、配信方式に応じたプレビューの配信設定・wrangler のバージョン・workflow の有無を検査する。
- FR-5: provider の workflow 雛形を出力し、既存のファイルは上書きしない。
- FR-6: 後始末のコマンドは既定で表示だけを行い、実行を明示したときだけ実行する。
- FR-7: Cloudflare の provider では、有効な独自ドメインの有無に応じて、wrangler 設定の workers.dev 関連キーを設定できる。
- FR-8: Cloudflare の検査では、独自ドメインの有効状況と食い違う workers.dev 関連キーを警告する。
- FR-9: 宣言で接頭辞を指定したときは、ブランチ名からその接頭辞を除いてから alias を作り、プレビューURLと後始末の名前に使う。
- FR-10: プレビューの配信方式を、URL 雛形のホスト名が workers.dev かどうかで判定する。
- FR-11: 配備先を宣言したときは、プレビューを作る配備先を宣言で指定させ、雛形・後始末・検査をその配備先の Worker に向ける。
- FR-12: 配信方式と、プレビュー先の Worker 名・独自ドメインが URL 雛形と食い違うとき、配信先が無いとき、プレビューのホスト名が DNS のラベルの長さを超えうるときを検査で報告する。
- FR-13: プレビューURLの算出で、URL 雛形の変数を解決する。

## 5. 非機能要件

- なし

## 6. 受け入れ条件

- AC-1 (FR-1): ブランチ dev/foo-bar とURL雛形から、斜線をハイフンにした alias を含むURLが得られる。
- AC-2 (FR-2): provider を none にした宣言では、URLが算出されず後始末も提示されない。
- AC-3 (FR-3): 宣言にない release 系ブランチを push 対象とする workflow が、警告として報告される。
- AC-4 (FR-4): 独自ドメイン配信で有効化設定のない wrangler 設定、workers.dev 配信で preview_urls が true でない wrangler 設定に対し、Cloudflare の検査が誤りを報告する。
- AC-5 (FR-5): preview 用の workflow ファイルが既にあるリポジトリで雛形の書き込みを指示すると、上書きされずに終了コード 1 で終わる。
- AC-6 (FR-6): 後始末を実行指定なしで指示すると、コマンドが表示されるだけで実行されない。
- AC-7 (FR-7): 有効な独自ドメインのある設定に書き込みを指示すると、workers.dev 関連キーが無効になる。
- AC-8 (FR-8): 有効な独自ドメインがあるのに workers.dev が有効な設定に対し、Cloudflare の検査が警告を報告する。
- AC-9 (FR-9): 接頭辞 dev/ を指定した宣言では、ブランチ dev/foo-bar のURLと後始末の名前が foo-bar になる。
- AC-10 (FR-10): URL 雛形 `https://{alias}-app.acct.workers.dev` は workers.dev 配信、`https://{alias}.example.com` と `https://{alias}.${SITE_HOST}` は独自ドメイン配信と判定される。
- AC-11 (FR-11): 配備先を宣言したのにプレビュー先が無い・宣言に無い配備先を指す宣言は誤りになる。後始末のコマンドにプレビュー先の Worker 名が含まれる。
- AC-12 (FR-12): workers.dev 配信で URL 雛形の Worker 名がプレビュー先と違う宣言は警告、独自ドメイン配信でプレビュー先に独自ドメインが無い宣言は誤りとして報告される。alias と Worker 名を合わせて 63 文字を超えうる workers.dev 配信は警告になる。
- AC-13 (FR-13): 環境変数 SITE_HOST=example.com のとき、URL 雛形 `https://{alias}.${SITE_HOST}` とブランチ dev/foo から `https://dev-foo.example.com` が得られる。
