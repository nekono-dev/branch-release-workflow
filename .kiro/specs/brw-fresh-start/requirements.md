# Requirements Document

## Project Description (Input)
BRW（branch-release-workflow。作業ブランチ運用を強制するフックと CLI の一式）を使う利用者・エージェントは、`brw create` / `brw resume` で worktree（ブランチごとの作業用ディレクトリ）を作るとき、古い版の BRW のまま作業を始めてしまうことがある。古い版では最新の判定（フックの拒否・置き換え・PR の手順）が効かず、作業の途中で挙動が変わる。

現状、BRW の更新は利用者が手で行う（Claude プラグインは `claude plugin update branch-release-workflow@nekono-dev`、Codex は clone の `git pull --ff-only`）。`brw create` / `brw resume` は更新の確認をしない。

変えたいこと: `brw create` / `brw resume` は、worktree を作る前に BRW 自身が最新であることを確かめ、古ければ更新してから worktree を作る。最新化できないとき（オフラインなど）は、worktree を作らず中止し、理由と次の手順を案内する。確認は配布の形（Claude プラグイン・Codex の clone・このリポジトリ自身）ごとの差を判定の裏側に閉じ込める。順序は「最新化の確認 → 置き場の決定 → 作成」とする。

あわせて、最新化の確認は BRW 固有の事情から切り離した汎用の仕組み（共通のアーキテクチャ）として作る。BRW 以外の製品でも、開始時に最新かを確かめて古ければ更新する用途に同じ仕組みを使えるようにする。汎用の仕組みは利用する製品を知らず、製品ごとの差（版の取得・更新の手段、案内の文面）は利用側が与える。BRW はその 1 つの利用者であり、他の製品を知らない。

範囲外: worktree の置き場の変更（`brw-branch-gate` の更新で扱う）、worktree の片付け（`finish`）、BRW 以外の仕組みの改修。詳細は `brief.md`。

## Introduction
BRW を使う利用者・エージェントが、古い版の BRW で作業場所（ブランチと worktree）を作ったり再開したりしないよう、作業場所を作る・使う操作の前に BRW の最新化を確かめ、古ければ自動で更新する。最新化できないときは作業場所を作らず中止する。この確認と更新は、BRW 以外の製品でも同じ形で使える汎用の仕組みとして提供し、BRW はその利用者の 1 つとする。

## Boundary Context
- **In scope**:
  - `brw create`（`--branch-only`・`--carry` を含む）と、ブランチ名を指定した `brw resume` の前の、BRW の最新化の確認・自動更新・失敗時の中止。
  - 最新化の確認と更新を、BRW を知らない汎用の仕組みとして定義すること（製品ごとの差を利用側が与える形、結果と案内の契約）。
- **Out of scope**:
  - worktree の置き場の変更（`brw-branch-gate` の更新で扱う）、worktree の片付け（`finish`）、基底ブランチの追従（`sync-base-branch`）。
  - 最新化の確認を省く手段（設けない）。特定の版への固定（認めない）。
  - BRW 以外の個別の製品の改修と、それらの名指し。
- **Adjacent expectations**:
  - `brw-branch-gate` が、素の Git のブランチ作成を `brw create` に置き換えて実行する。この要件は、置き換えで実行された `brw create` にも同じ確認を課す。置き場の決定と作成の挙動そのものは `brw-branch-gate` が持つ。
  - BRW の導入の形（Claude のプラグイン、Codex が参照する clone、BRW 自身を開発している作業ツリー）と、その更新手順は既存の導入手順に従う。この要件は更新手順を新しく定めず、更新を自動で実行する振る舞いを定める。

## Requirements

### Requirement 1: 作業場所を作る・使う操作の前の最新化の確認
**Objective:** As a BRW を使う利用者・エージェント, I want 作業場所を作る・使う操作の前に BRW が最新かを必ず確かめてほしい, so that 古い版のまま作業を始めて、判定や手順が途中で変わることを避けられる

#### Acceptance Criteria
1. When `brw create` が実行される（`--branch-only`・`--carry` を含む）, the BRW shall ブランチと worktree を作る前に、実行中の BRW が最新であるかを確認する。
2. When ブランチ名を指定した `brw resume` が実行される, the BRW shall 作業場所を再開する前に、実行中の BRW が最新であるかを確認する。
3. When 引数なしの `brw resume`（再開できる作業の一覧の表示）が実行される, the BRW shall 最新化の確認を行わず、一覧を表示する。
4. When 素の Git のブランチ作成が `brw create` に置き換えられて実行される, the BRW shall 利用者が `brw create` を直接実行した場合と同じ確認を行う。
5. When 確認で最新だと分かった, the BRW shall 利用者に追加の操作を求めず、元の操作を続ける。
6. The BRW shall 最新化の確認を、置き場の決定と作業場所の作成より前に行う。
7. The BRW shall 最新化の確認を省く手段（オプション・設定・環境変数など）を提供しない。
8. If BRW の導入が特定の版に固定されていて、その版が配布元の最新と異なる, then the BRW shall 固定された版を最新と見なさず、古い版として扱う。
9. While BRW が自身を開発している作業ツリーから実行されている, the BRW shall 他の導入の形と同じ最新化の確認を行う。

### Requirement 2: 古い版の自動更新と続行
**Objective:** As a BRW を使う利用者・エージェント, I want 古い版と分かったときは手作業なしで更新して続けてほしい, so that 更新の手順を調べて実行する手間なく、常に最新の版で作業できる

#### Acceptance Criteria
1. If 確認で実行中の BRW が最新でないと分かった, then the BRW shall 利用者の操作を待たずに、その導入の形に応じた更新を実行する。
2. The BRW shall 導入の形（Claude のプラグイン、Codex が参照する clone、BRW 自身を開発している作業ツリー）ごとに、現在の版と最新の版の比較と更新を行い、利用者に導入の形を指定させない。
3. When 更新が成功し、更新後の版で今回の操作を続けられる, the BRW shall 元の操作（引数を含む）を続行する。
4. If 更新は成功したが、今回の実行には反映されない（更新前の版が動き続けている）, then the BRW shall 作業場所を作らず、再実行を求める案内を表示して中止する。
5. While 更新が完了していない, the BRW shall ブランチ・worktree・作業の記録を作らない。
6. The BRW shall 更新によって、利用者の未コミットの変更を失わせない。
7. If 未コミットの変更を失わせずには更新できない, then the BRW shall 更新せずに中止し、理由と次の手順を表示する。

### Requirement 3: 最新化できないときの中止と案内
**Objective:** As a BRW を使う利用者・エージェント, I want 最新化できないときは作業場所が作られずに止まり、理由と次の手順が分かってほしい, so that 古い版のまま作業が進むことなく、自力で復旧できる

#### Acceptance Criteria
1. If 配布元の最新の版を取得できない（オフライン・配布元に到達できない・待ち時間の超過）, then the BRW shall ブランチと worktree を作らず中止し、理由と次の手順を表示する。
2. If 実行中の BRW の現在の版を判定できない, then the BRW shall ブランチと worktree を作らず中止し、理由と次の手順を表示する。
3. If 更新の実行が失敗した, then the BRW shall ブランチと worktree を作らず中止し、失敗の理由と、更新前の版が使える状態かどうかを表示する。
4. When 中止する, the BRW shall 非ゼロの終了コードで終了し、ブランチ・worktree・作業の記録を作らない。
5. The BRW shall 最新化の確認の待ち時間に上限を設け、上限を超えたときは最新の版を取得できなかったものとして扱う。

### Requirement 4: 他の製品でも使える汎用の最新化の仕組み
**Objective:** As a BRW 以外の製品の作り手, I want 開始時に最新かを確かめ古ければ更新する仕組みを、自分の製品でも同じ形で使いたい, so that 製品ごとに最新化の確認を作り直さずに済む

#### Acceptance Criteria
1. The 最新化の仕組み shall BRW が導入されていない環境でも、単独で利用できる。
2. The 最新化の仕組み shall 利用する製品を知らず、製品ごとの差（現在の版の求め方・最新の版の求め方・更新の方法・利用者への案内の文面）を利用側から与えられる。
3. The 最新化の仕組み shall どの製品に使われても、同じ 3 つの結果（最新で続行・古いので更新して続行・判定できないので中止）と、Requirement 2・3 と同じ振る舞い（自動更新・反映されない場合の再実行の案内・失敗時の中止）を提供する。
4. If 利用側が必須の項目を与えていない, then the 最新化の仕組み shall 確認を行わず、欠けている項目を示して中止する。
5. The 最新化の仕組み shall BRW を含む特定の製品の名前や固有の値を持たない。
6. The BRW shall 最新化の仕組みの利用者の 1 つとして、BRW 固有の差だけを与える。
7. The BRW shall 最新化の仕組みを利用する他の製品の存在を前提にしない。
