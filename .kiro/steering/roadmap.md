# Roadmap

## Overview
BRW（branch-release-workflow。作業ブランチ運用を強制するフックと CLI の一式）に、次の 4 つの変更を入れる。

1. worktree（ブランチごとの作業用ディレクトリ）を作る・再開する前に、BRW 自身が最新であることを確かめる入口を設ける。
2. worktree の置き場を `<本体>/.claude/worktrees/` から `<本体>/.worktree/` に変える。Claude 以外のエージェント（Codex など）からも使える中立の場所にする。
3. `CLAUDE.md` が `.gitignore` に載っているのに差分に出る問題を直す。
4. BRW の導入・更新（`brw setup` と、プラグイン自体の更新）で導入先のリポジトリが変わるとき、その変更を、保護ブランチや分岐元へ直接 commit せず、作業ブランチ → 分岐元への PR で入れる流れにする。置き場の変更に伴う `.gitignore` への `.worktree/` の追記は、この導入・更新の commit に載せ、BRW は黙って書かず案内する。

## Approach Decision
- **Chosen**: 最新化の確認は新しい仕様 `brw-fresh-start`、導入・更新の流れは新しい仕様 `brw-install-flow` として切り出す。置き場の変更は既存の 2 仕様（`brw-branch-gate`・`brw-pr-handoff`）の更新として扱い、`CLAUDE.md` の追跡外しは仕様を作らず直接実装する。
- **Why**: 最新化は create / resume の前段という新しい責務なので、独立した仕様にすると境界が明確になる。置き場の変更は既存の配置の決まりの書き換えなので、新しい仕様にせず既存の仕様に反映するほうが重複しない。`CLAUDE.md` の件は設定と移動だけで、仕様にするほどの振る舞いの追加がない。
- **Rejected alternatives**:
  - 置き場の変更と最新化を 1 つの新仕様にまとめる案: 置き場の決まりが `brw-branch-gate` と二重管理になるため見送った。
  - `CLAUDE.md` の追跡外しだけ先に行う案: 利用者が全体を一度に進める選択をしたため採らなかった。
  - 導入・更新の流れを `brw-branch-gate` に含める案: 置き場の決まり（作業場所の判定）と、導入先の変更の入れ方（作業ブランチ・PR・`.gitignore` の案内）は責務が別のため、利用者が別の仕様にすることを選んだ。

## Scope
- **In**:
  - create / resume の前に BRW の最新化を確認し、最新化できないときは worktree を作らず中止する仕組み。
  - 最新化の確認を、BRW 以外の製品でも使える汎用の仕組み（共通のアーキテクチャ）として作ること。汎用の仕組みは利用者となる製品を知らず、BRW も他の製品を知らない。
  - worktree の置き場を `<本体>/.worktree/` に変更（旧置き場は認識しない）。これは `brw-branch-gate` の更新で、配置先の決まりをこの仕様が持つ。PR 本文置き場（`.brw/`）の `<本体>/.worktree/.brw/` への移動は、続けて `brw-pr-handoff` の更新で行う。このリポジトリの `.gitignore` には `.worktree/` を追加済み。
  - BRW の導入・更新（`brw setup` と、プラグイン自体の更新の後の案内）による導入先の変更を、作業ブランチ → 分岐元への PR で入れる流れ。`.gitignore` への `.worktree/` の追記は案内し、導入・更新の commit に載せる。
  - `CLAUDE.md` の追跡外し、独自の取り決め（作業の区切りの commit・push）の `.kiro/steering/` への移動。
- **Out**:
  - 旧置き場 `.claude/worktrees/` の既存 worktree の自動移行（利用者が手で移す）。

## Constraints
- 最新化に失敗したとき（オフラインなど）は、create / resume を中止し、理由と手順を案内する（利用者の決定）。
- 置き場は `.worktree`（単数形）に固定する（利用者の指定）。
- 外部の動作（Claude プラグインの更新の反映のされ方、Codex 側の clone の更新）に依存するため、`brw-fresh-start` は実機検証（PoC）が必要になる見込み。
- 導入先の `.gitignore` は BRW が黙って書き換えない。追記は案内し、導入・更新の commit に載せる（利用者の決定）。導入・更新の変更そのものを、作業ブランチ → 分岐元への PR で入れる（利用者の決定）。
- 配置先の決まりを具体的なパスで定めているのは `brw-branch-gate` だけで、`brw create` が実際に作る場所は、どの仕様の要件にも書かれていない。そのため、`brw-branch-gate` を配置先の決まりを持つ仕様として更新する。

## Boundary Strategy
- **Why this split**: 最新化（新しい責務）、置き場（既存の配置の決まり）、追跡外し（設定の修正）は、変更の理由もテストの対象も別。
- **Shared seams to watch**:
  - `brw create` / `brw resume` の入口は、最新化の確認（新仕様）と置き場の決定（既存仕様）の両方が通るため、順序（最新化 → 置き場の決定 → 作成）を設計で固定する。
  - フックの置き換えと拒否の判定は置き場を見ているため、置き場の変更で判定の対象が変わる。
  - `.brw/` の PR 本文の置き場は `brw-pr-handoff` が持つ。`brw-branch-gate` の実装の後、`brw-pr-handoff` の更新までの間は、PR 本文だけが旧置き場 `.claude/worktrees/.brw/` に残る。
  - `brw-install-flow` は、置き場の変更（`brw-branch-gate`）が先に入っていることを前提に、導入先の `.gitignore` の案内を持つ。

## Existing Spec Updates
- [ ] brw-branch-gate -- worktree の配置先を `<本体>/.claude/worktrees/` から `<本体>/.worktree/` に変更する（`brw create`・`brw resume` が作る場所、置き換え・拒否・EnterWorktree の判定を含む）。配置先の決まりをこの仕様が持つため、範囲外としていた「配置先の変更」を範囲内にする。旧置き場は認識しない。Dependencies: none
- [ ] brw-pr-handoff -- PR 本文の置き場 `.brw/` を `<本体>/.worktree/.brw/` に変更する。Dependencies: brw-branch-gate

## Direct Implementation Candidates
- [x] claude-md-untrack -- `CLAUDE.md` を追跡から外し（`git rm --cached`）、独自の取り決めを `.kiro/steering/` へ移す。追跡済みのファイルには `.gitignore` が効かないのが原因（導入コミット e1851ad で追跡対象になっていた）。設定の修正で振る舞いの追加がないため仕様にしない。
- [x] gitignore-worktree -- `.gitignore` に `.worktree/` を追加する。置き場の変更と同時に行う。
- [x] bootstrap-update-commit -- ステージ済みの導入物の更新を commit する。
- [x] discovery-notes-removal -- 作る決まりのない `.kiro/discovery-notes/` を削除し、取り決めと参照から外す（実装・設計に作る仕組みは無く、取り消す実装は不要）。

## Specs (dependency order)
- [ ] brw-fresh-start -- create / resume の前に BRW の最新化を確認し、失敗時は中止する。最新化の確認は、他の製品でも使える汎用の仕組みとして作る。Dependencies: brw-branch-gate
- [ ] brw-install-flow -- BRW の導入・更新（`brw setup` と、プラグイン自体の更新の後の案内）で導入先が変わるとき、実作業の前に `brw create` で作業ブランチを作り、導入・更新の変更を作業ブランチ → 分岐元への PR で入れる。導入先の `.gitignore` への `.worktree/` の追記は案内し、その commit に載せる。Dependencies: brw-branch-gate
