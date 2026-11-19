# 配備先の宣言と設定の生成 タスク一覧

## Phase 1: 宣言と変数

- 対応: D-1, D-2
- [x] T-1.1: `deploy` の検証・正規化と、変数の解決（環境変数 → GitHub Variables）を lib.mjs に実装する。
- [x] T-1.2: AC-1, AC-2, AC-11 の単体テストを受け入れ条件のタグ付きで追加する。
- 検証: `node tests/selftest.mjs`

## Phase 2: 設定の生成

- 対応: D-3
- [x] T-2.1: scripts/deploy/cloudflare-workers.mjs に生成を実装し、brw.mjs に render-wrangler を加える。
- [x] T-2.2: AC-3 から AC-7 の単体テストを追加する。
- 検証: `node --check scripts/deploy/cloudflare-workers.mjs && node tests/selftest.mjs`

## Phase 3: 雛形と検査

- 対応: D-4, D-5
- [x] T-3.1: gen-workflow deploy と配備先の検査を実装し、AC-8 から AC-10 の単体テストを追加する。
- [x] T-3.2: references/config.md・SKILL.md・README.md に deploy を書き、plugin.json の版を上げる（auto-approve の作業と合わせて 1.2.0）。
- 検証: `node tests/selftest.mjs && node --check scripts/brw.mjs`

## Phase 4: 実機での確認

- 対応: D-3, D-4
- [x] T-4.1: 検証環境で、雛形と生成結果を使って使い捨ての本番・開発 Worker を配備し、独自ドメイン配信と workers.dev 配信のプレビューが宣言の URL で届くことを確かめ、後始末で削除する。
- 検証: 確認の記録を references/cloudflare-previews.md に反映する
