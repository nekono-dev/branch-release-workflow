# Requirements Document

## Project Description (Input)
BRW（branch-release-workflow。作業ブランチ運用を強制するフックと CLI の一式）を使う利用者・エージェントは、`brw create` / `brw resume` で worktree（ブランチごとの作業用ディレクトリ）を作るとき、古い版の BRW のまま作業を始めてしまうことがある。古い版では最新の判定（フックの拒否・置き換え・PR の手順）が効かず、作業の途中で挙動が変わる。

現状、BRW の更新は利用者が手で行う（Claude プラグインは `claude plugin update branch-release-workflow@nekono-dev`、Codex は clone の `git pull --ff-only`）。`brw create` / `brw resume` は更新の確認をしない。

変えたいこと: `brw create` / `brw resume` は、worktree を作る前に BRW 自身が最新であることを確かめ、古ければ更新してから worktree を作る。最新化できないとき（オフラインなど）は、worktree を作らず中止し、理由と次の手順を案内する。確認は配布の形（Claude プラグイン・Codex の clone・このリポジトリ自身）ごとの差を判定の裏側に閉じ込める。順序は「最新化の確認 → 置き場の決定 → 作成」とする。

あわせて、最新化の確認は BRW 固有の事情から切り離した汎用の仕組み（共通のアーキテクチャ）として作る。BRW 以外の製品でも、開始時に最新かを確かめて古ければ更新する用途に同じ仕組みを使えるようにする。汎用の仕組みは利用する製品を知らず、製品ごとの差（版の取得・更新の手段、案内の文面）は利用側が与える。BRW はその 1 つの利用者であり、他の製品を知らない。

範囲外: worktree の置き場の変更（`brw-branch-gate` の更新で扱う）、worktree の片付け（`finish`）、BRW 以外の仕組みの改修。詳細は `brief.md`。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
