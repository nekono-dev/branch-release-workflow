# Roadmap

## Overview
BRW（branch-release-workflow。作業ブランチ運用を強制するフックと CLI の一式）に、次の 3 つの変更を入れる。

1. worktree（ブランチごとの作業用ディレクトリ）を作る・再開する前に、BRW 自身が最新であることを確かめる入口を設ける。cc-sdd-bootstrap（cc-sdd の運用一式を導入する別リポジトリの仕組み）も同じ形で使える共通の入口として設計する。
2. worktree の置き場を `<本体>/.claude/worktrees/` から `<本体>/.worktree/` に変える。Claude 以外のエージェント（Codex など）からも使える中立の場所にする。
3. `CLAUDE.md` が `.gitignore` に載っているのに差分に出る問題を直す。

## Approach Decision
- **Chosen**: 最新化の確認は新しい仕様 `brw-fresh-start` として切り出す。置き場の変更は既存の 2 仕様（`brw-branch-gate`・`brw-pr-handoff`）の更新として扱い、`CLAUDE.md` の追跡外しは仕様を作らず直接実装する。
- **Why**: 最新化は create / resume の前段という新しい責務で、cc-sdd-bootstrap にも同じ形で渡す境界（共通の入口）を持つため、独立した仕様にすると境界が明確になる。置き場の変更は既存の配置の決まりの書き換えなので、新しい仕様にせず既存の仕様に反映するほうが重複しない。`CLAUDE.md` の件は設定と移動だけで、仕様にするほどの振る舞いの追加がない。
- **Rejected alternatives**:
  - 置き場の変更と最新化を 1 つの新仕様にまとめる案: 置き場の決まりが `brw-branch-gate` と二重管理になるため見送った。
  - `CLAUDE.md` の追跡外しだけ先に行う案: 利用者が全体を一度に進める選択をしたため採らなかった。

## Scope
- **In**:
  - create / resume の前に BRW の最新化を確認し、最新化できないときは worktree を作らず中止する仕組み。
  - 上の仕組みを cc-sdd-bootstrap も同じ形で使えるようにする共通の入口の定義。
  - worktree と PR 本文置き場（`.brw/`）の置き場を `<本体>/.worktree/` に変更（旧置き場は認識しない）。`.gitignore` に `.worktree/` を追加。
  - `CLAUDE.md` の追跡外し、独自の取り決め（作業の区切りの commit・push）の `.kiro/steering/` への移動。
- **Out**:
  - cc-sdd-bootstrap 本体の改修（配置物は直接編集しない決まり。別リポジトリでの対応）。
  - 旧置き場 `.claude/worktrees/` の既存 worktree の自動移行（利用者が手で移す）。

## Constraints
- 最新化に失敗したとき（オフラインなど）は、create / resume を中止し、理由と手順を案内する（利用者の決定）。
- 置き場は `.worktree`（単数形）に固定する（利用者の指定）。
- 外部の動作（Claude プラグインの更新の反映のされ方、Codex 側の clone の更新）に依存するため、`brw-fresh-start` は実機検証（PoC）が必要になる見込み。
- `.agent-hooks/cc-sdd-bootstrap/` の配置物は直接編集しない。

## Boundary Strategy
- **Why this split**: 最新化（新しい責務）、置き場（既存の配置の決まり）、追跡外し（設定の修正）は、変更の理由もテストの対象も別。
- **Shared seams to watch**:
  - `brw create` / `brw resume` の入口は、最新化の確認（新仕様）と置き場の決定（既存仕様）の両方が通るため、順序（最新化 → 置き場の決定 → 作成）を設計で固定する。
  - フックの置き換えと拒否の判定は置き場を見ているため、置き場の変更で判定の対象が変わる。
  - `.brw/` の PR 本文の置き場は `brw-pr-handoff` が持つ。

## Existing Spec Updates
- [ ] brw-branch-gate -- worktree の配置先を `<本体>/.claude/worktrees/` から `<本体>/.worktree/` に変更する（置き換え・拒否・EnterWorktree の判定を含む）。Dependencies: none
- [ ] brw-pr-handoff -- PR 本文の置き場 `.brw/` を `<本体>/.worktree/.brw/` に変更する。Dependencies: brw-branch-gate

## Direct Implementation Candidates
- [ ] claude-md-untrack -- `CLAUDE.md` を追跡から外し（`git rm --cached`）、独自の取り決めを `.kiro/steering/` へ移す。追跡済みのファイルには `.gitignore` が効かないのが原因（導入コミット e1851ad で追跡対象になっていた）。設定の修正で振る舞いの追加がないため仕様にしない。
- [ ] gitignore-worktree -- `.gitignore` に `.worktree/` を追加する。置き場の変更と同時に行う。
- [ ] bootstrap-update-commit -- ステージ済みの cc-sdd-bootstrap の更新を commit する。

## Specs (dependency order)
- [ ] brw-fresh-start -- create / resume の前に BRW の最新化を確認し、失敗時は中止する。cc-sdd-bootstrap も使える共通の入口を定める。Dependencies: brw-branch-gate
