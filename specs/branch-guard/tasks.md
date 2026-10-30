# ブランチ運用の強制 タスク一覧

## Phase 1: 宣言と判定

- 対応: D-1, D-2, D-3
- [x] T-1.1: 宣言の読み込み・検証とブランチの判定を実装する。
- [x] T-1.2: フックと push の送り先の解釈を実装し、判定の単体テストを受け入れ条件のタグ付きで追加する。
- 検証: `node tests/selftest.mjs`

## Phase 2: 作成

- 対応: D-4
- [x] T-2.1: 作業ブランチの作成を実装する。
- 検証: `node --check scripts/brw.mjs && node tests/selftest.mjs`

## Phase 3: 片付けと再開

- 対応: D-5
- [x] T-3.1: push 済みの作業ブランチの片付けと、リモートからの再開を実装し、AC-8 と AC-9 の単体テストを加える。
- 検証: `node tests/selftest.mjs` の branch-guard/AC-8・AC-9

## Phase 4: 宣言の登録

- 対応: D-2, D-6
- [x] T-4.1: プラグインを有効にしたリポジトリで宣言が無いときの拒否と、未登録の宣言の検査・worktree への移動を実装し、AC-10 と AC-11 の単体テストを加える。
- 検証: `node tests/selftest.mjs` の branch-guard/AC-10・AC-11

## Phase 5: 取り込み後の片付け

- 対応: D-5
- [x] T-5.1: 片付けを切り出し元への取り込み（または保護ブランチへの PR）の後に限り、`finish --merged` と、残っている worktree への `resume` の取り込みを実装し、AC-8 と AC-9 の単体テストを改める。
- 検証: `node tests/selftest.mjs` の branch-guard/AC-8・AC-9

## Phase 6: エージェント間の共有

- 対応: D-1, D-7
- [x] T-6.1: ルートの共有宣言を優先し、旧パスの後方互換と未登録宣言の移動を検証する。
- [x] T-6.2: Codex のリンク導入と guard を実装し、再実行・既存導入先の保護・判定を検証する。
- 検証: `node tests/selftest.mjs` の branch-guard/AC-12・AC-13
