- 対象: git の clone（Codex が参照する clone、BRW 自身を開発している作業ツリー、特定のコミットに固定した clone）で、最新かの判定・fast-forward だけの更新・未コミットの変更の保護・オフライン時の失敗が期待どおりか（要件 1.8・1.9・2.1・2.2・2.6・2.7・3.1、実現性の記録の前提 3・4・6）
- 段階: design

# PoC design_02: git の clone の最新判定と更新

## 実施内容
一時ディレクトリに bare の `origin.git`（既定ブランチ `main`）と複数の clone を作り、配布元へコミットを足しながら、次の 9 状態で判定と更新のコマンドを実行した（スクリプトと出力は管理対象に残していない）。判定は `git ls-remote --symref origin HEAD`（既定ブランチと先端）→ `git fetch origin main` → `git merge-base --is-ancestor origin/main HEAD`、更新は `git merge --ff-only origin/main`（固定された clone は先に `git checkout main`）。

## 実施日
2026-11-28

## 環境と版
git 2.43.0、Node.js 22.16.0、Linux（Ubuntu）。

## 結果と仕様への反映
| # | 状態 | 観測 | 反映 |
|---|---|---|---|
| 0 | 既定ブランチの解決 | `ls-remote --symref origin HEAD` が `refs/heads/main` と先端のコミットを返す | 最新は「origin の既定ブランチの先端」とする |
| 1 | 先端と同じ | 先端が HEAD の祖先（等しい）→ 最新 | 最新の判定は「先端が HEAD に含まれる」 |
| 2 | 遅れている（既定ブランチ上） | 古いと判定。`merge --ff-only` が成功 | 更新は fast-forward のみ |
| 3 | 遅れている＋無関係な未コミットの変更・未追跡ファイル | fast-forward が成功し、変更はそのまま残った | 更新で変更は失われない（要件 2.6） |
| 4 | 遅れている＋取り込む対象と同じファイルの未コミットの変更 | `would be overwritten by merge` で失敗（終了コード 1）。作業ツリーは変わらない | 失敗を中止の案内にする（要件 2.7） |
| 5 | 先端より古い commit に固定（detached HEAD） | 古いと判定。`checkout main` → `merge --ff-only` で最新になった | 固定された clone は既定ブランチへ移して更新する（要件 1.8） |
| 5b | 5 の状態＋衝突する未コミットの変更 | `checkout` が `would be overwritten by checkout` で失敗。HEAD は動かない | 失敗を中止の案内にする（要件 2.7） |
| 6 | 開発ブランチが先端を含まず、独自の commit がある | 古いと判定。`merge --ff-only` は分岐のため失敗（終了コード 128） | 自動でマージ・リベースはしない。中止して `git merge origin/<既定>` を案内する（要件 1.9・3.3） |
| 7 | 開発ブランチが先端を含む | 最新と判定 | 開発中の作業ツリーでも、先端を含んでいれば確認は通る |
| 8 | 配布元に届かない | `ls-remote`・`fetch` が即座に終了コード 128 で失敗 | 「最新を取得できない」として中止（要件 3.1） |

## 確かめられなかったこと
- 実際の GitHub への通信（一時の bare リポジトリで代替）。認証が要る配布元の挙動。
- サブモジュールや sparse checkout の clone。
