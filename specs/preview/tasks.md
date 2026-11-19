# プレビュー運用 タスク一覧

## Phase 1: URL と provider

- 対応: D-1, D-2
- [x] T-1.1: URL の算出と provider の切り替えを実装する。
- [x] T-1.2: 雛形の書き込みと後始末の既定動作の単体テストを受け入れ条件のタグ付きで追加する。
- [x] T-1.3: 宣言の aliasStripPrefix を検証し、URL・workflow 雛形・後始末の名前に反映して、AC-9 の単体テストを加える。
- 検証: `node tests/selftest.mjs`

## Phase 2: 検査

- 対応: D-3, D-4
- [x] T-2.1: 宣言外の CI の警告と Cloudflare の検査を実装し、単体テストを追加する。
- 検証: `node --check scripts/providers/cloudflare-previews.mjs && node tests/selftest.mjs`

## Phase 3: workers.dev 関連キー

- 対応: D-5
- [x] T-3.1: 独自ドメインの有効判定と wrangler-config を実装し、検査の警告を追加する。
- [x] T-3.2: AC-7, AC-8 の単体テストを追加し、SKILL.md に使い方を書く。
- 検証: `node tests/selftest.mjs && node --check scripts/brw.mjs`

## Phase 4: 配信方式とプレビュー先

- 対応: D-1, D-2, D-4, D-5, D-6, D-7, D-8
- [x] T-4.1: URL 雛形からの配信方式の判定と、URL の変数の解決を実装し、AC-10, AC-13 の単体テストを加える。
- [x] T-4.2: preview.target の検証、後始末の --worker-name、雛形への生成手順の追加を実装し、AC-11 の単体テストを加える。
- [x] T-4.3: 配信方式に応じた検査と URL 雛形の整合の検査、wrangler-config の workers.dev 配信の列を実装し、AC-4, AC-12 の単体テストを加える。
- [x] T-4.4: references/cloudflare-previews.md・references/config.md・SKILL.md に配信方式とプレビュー先、実機の確認結果を書く。
- 検証: `node tests/selftest.mjs && node --check scripts/brw.mjs`
