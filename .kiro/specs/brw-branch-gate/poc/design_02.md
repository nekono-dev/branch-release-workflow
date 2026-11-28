- 対象: git で、本体の作業ツリーの直下の `.worktree/<別名>` に worktree を作る・移すときの挙動（配置先が無視されているかの検出、連携 worktree からの本体の特定、旧置き場からの移動手順、`git add -A` の影響）（要件 7.1〜7.3・7.5・7.10、実現性の記録の前提 4）
- 段階: design

# PoC design_02: git と `.worktree/` の配置先

## 実施内容
一時ディレクトリの使い捨てのリポジトリで、次を実行した（スクリプトと出力は管理対象に残していない）。
- A〜F: 配置先 `.worktree/dev-x`（まだ存在しないパス）に対する `git check-ignore -q -- <パス>` の終了コードを、無視設定の形ごとに観測した（無し・`.gitignore` の `/.worktree/`・`.git/info/exclude` の `.worktree/`・先頭の `/` が無い `.worktree`・否定パターンでの再包含・git の外）。
- G: `git worktree add .worktree/dev-x -b dev/x`（`.worktree/` が存在しない状態）と、その連携 worktree の中での `git worktree list --porcelain` の先頭の行。
- H・I・J: 旧置き場 `.claude/worktrees/<別名>` の worktree を `git worktree move` で `.worktree/<別名>` へ移す。未コミットの変更・未追跡ファイルがある場合と、ロックされている場合。
- 別の確認（同日、同じ環境）: `.worktree/` を無視していないリポジトリで、本体の `git status` と `git add -A` が worktree をどう扱うか。
- K・L: 配置先そのものを調べる方法として、存在しない子のパス `.worktree/.brw-probe` に `git check-ignore` を使い、子の名前だけを無視する設定（`/.worktree/dev-x`）とディレクトリ全体の無視（`/.worktree/`）を見分けられるか。
- M・N: `.worktree/<別名>` の worktree に対する `git worktree remove`（クリーン・変更あり・`--force`）と、`--carry` と同じ手順（本体で `git stash create`、worktree で `git stash apply`、本体で `git restore --staged --worktree --source=HEAD`）。
- O: git 2.43 のマニュアル（`git help -m worktree`）で、サブモジュールを持つ worktree の移動・削除の規則。

## 実施日
2026-11-28

## 環境と版
git 2.43.0、Linux（Ubuntu）。

## 結果と仕様への反映
1. **検出（要件 7.10）**: 無視されていないとき `git check-ignore -q` は終了コード **1**。`.gitignore` の `/.worktree/`・`info/exclude` の `.worktree/`・先頭の `/` が無い `.worktree` はいずれも **0**。否定パターンで子を再包含しても、親のディレクトリが無視されていれば **0** のまま。git の外では **128**。パスが存在しなくても判定できる。→ 配置先の確認は `git check-ignore -q -- .worktree/<別名>` の終了コードで行い、1 のときだけ警告する。0 は警告しない。128 などの失敗は、判定できないとして警告も止めもしない（警告の追加情報として扱う）。
2. **`git add -A` の影響（要件 7.10 の動機）**: `.worktree/` を無視していない本体で `git status` は `?? .worktree/` と出し、`git add -A` は `warning: adding embedded git repository: .worktree/dev-x` を出したうえで、worktree を**埋め込みリポジトリ（gitlink、モード 160000）としてステージ**した（止まらない）。`.gitignore` に `/.worktree/` を入れると、`status` にも現れず、`git add -A` でも追加されない。
3. **作成（要件 7.1・7.2）**: `git worktree add .worktree/dev-x -b dev/x` は、`.worktree/` が無くても親のディレクトリごと作った。
4. **本体の特定（要件 7.3）**: 連携 worktree の中で `git worktree list --porcelain` の先頭の `worktree` 行は、本体の作業ツリーだった。→ 現行どおり、一覧の先頭を本体とすれば、worktree の中からでも入れ子の配置先を作らない。
5. **旧置き場からの移動手順（要件 7.5・7.6）**: `git worktree move <旧> <新>` で、未コミットの変更・未追跡ファイルがある worktree も、そのまま新しい場所へ移せた（移動後の `status` に変更と未追跡が残る）。**ロックされた worktree は `fatal: cannot move a locked working tree; use 'move -f -f' to override or unlock first` で拒否された。** → 案内は、`git worktree move <旧パス> <新パス>` と、ロックされているときは先に `git worktree unlock <旧パス>`。

6. **配置先そのものの検出（K・L）**: 子の名前だけを無視する設定では、`.worktree/dev-x` は終了コード 0 だが、存在しない子 `.worktree/.brw-probe` は **1**（無視されない）。ディレクトリ全体を無視する設定（`/.worktree/`）では、どちらも **0**。→ 無視の検出は、作成先の別名ではなく **`.worktree/.brw-probe`**（常に存在しない固定の子のパス）で行う。配置先のディレクトリ全体が無視されているときだけ 0 になり、別名の個別の設定だけでは警告になる（要件 7.10）。
7. **新配置先での削除と `--carry`（M・N）**: クリーンな worktree は `git worktree remove` で消せ、変更・未追跡がある worktree は `contains modified or untracked files, use --force to delete it` で拒否された（`--force` で削除できた）。`--carry` と同じ手順（`git stash create` → worktree で `git stash apply` → 本体で `git restore --staged --worktree --source=HEAD`）は、`.worktree/<別名>` でも従来どおり動き、本体の変更が戻った。→ `finish`・`--carry` は置き場所に依存しない（既存の試験の期待値の置き換えだけ）。
8. **サブモジュールの制約（O、git 2.43 のマニュアル）**: 「the main worktree or linked worktrees containing submodules cannot be moved with this command」。削除は「Unclean worktrees or ones with submodules can be removed with --force」。→ サブモジュールを持つ旧置き場の worktree は `git worktree move` で移せない。案内に、移せないときの手順（変更を保持して止まる。未コミットの変更を commit か退避してから `git worktree remove <旧パス>` の後に `brw resume <ブランチ>`）を含める。

## 確かめられなかったこと
- サブモジュールを持つ worktree を実際に移そうとしたときの出力（マニュアルの記述のみ）。
- Windows でのパスの扱い。
- グローバルの除外設定（`core.excludesFile`）の検出（同じ `check-ignore` が参照するが、今回は一時リポジトリのローカル設定だけを試した）。
