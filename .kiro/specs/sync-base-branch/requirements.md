# Requirements Document

## Project Description (Input)
BRW 導入済みのリポジトリで、クラウドセッションや他のプロバイダでの作業によりリモートだけが進んだとき、エージェントが手元の基底ブランチと作業ブランチをリモートに追いつかせられるようにする。

- 基底・保護ブランチ（`main` など）を、同名のリモート追跡ブランチ（`origin/main`）から fast-forward だけで更新できる（`git pull --ff-only`、`git merge --ff-only origin/main`）。
- `dev/*` へ、基底・保護ブランチのリモート追跡ブランチを手元で取り込める（`git merge origin/main`、`git pull origin main`）。
- 上記以外（マージコミットが要る更新、手元の別ブランチ・宣言外のリモートからの取り込み）は従来どおり拒否し、理由と代替手段（PR、または開発ブランチ間のローカルマージ）を表示する。
- 宣言が登録済みなら、許可した取り込みの確認を省略できる。
- 範囲外: `rebase`、専用コマンドの新設、分岐元・保護ブランチへの直接 commit・push の拒否（brw-enforcement 要件 1）、プラグイン導入状態の検査。

経緯・範囲・境界は [brief.md](brief.md) を参照する。brw-enforcement の要件 3（取り込みの許可条件）を拡張する。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
