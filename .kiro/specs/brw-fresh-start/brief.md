# Brief: brw-fresh-start

## Problem
- BRW を使う利用者・エージェントは、`brw create` / `brw resume` で worktree を作るとき、古い版の BRW のまま作業を始めてしまうことがある。古い版では最新の判定（フックの拒否・置き換え・PR の手順）が効かず、作業の途中で挙動が変わる。

## Current State
- BRW の更新は利用者が手で行う（Claude プラグインは `claude plugin update branch-release-workflow@nekono-dev`、Codex は clone の `git pull --ff-only`。`references/setup.md`）。`brw create` / `brw resume`（`scripts/brw.mjs`）は更新の確認をしない。
- worktree は、BRW が新しい版かどうかに関わらず、そのブランチの内容で作られる。

## Desired Outcome
- `brw create` / `brw resume` は、worktree を作る前に BRW 自身が最新であることを確かめ、古ければ更新してから worktree を作る。最新化できないとき（オフラインなど）は、worktree を作らず中止し、理由と次の手順を案内する。
- 最新の確認を省く手段は設けない（常に最新を使う）。ただし、手段の有無は設計で決める。

## Approach
- BRW の `create` / `resume` の先頭（置き場の決定・作成より前）で最新化を確認する。確認は「現在の版」「配布元の最新」を比べて `same` / `behind` / `unknown` を返し、`behind` のときは更新して再確認、`unknown`（通信の失敗など）のときは中止する。
- 配布の形（Claude プラグイン・Codex の clone・このリポジトリ自身）ごとに、版の取得と更新の手段が違うため、設計で整理する。更新が実行中のセッションに反映される条件（再起動が要るか）は実機で確かめる。

## Scope
- **In**:
  - `brw create` / `brw resume` の前段での最新化の確認と、失敗時の中止（案内つき）。
  - 配布の形ごとの版の取得・更新の手段（BRW）。
- **Out**:
  - worktree の置き場の変更（`brw-branch-gate` の更新で扱う）。
  - 最新化の確認を省くための設定やオプション（必要なら設計で再検討）。

## Boundary Candidates
- 最新化の判定（版の取得・比較）と、更新の実行を分ける。
- 最新化の確認と、`create` / `resume` 側の呼び出し位置を分ける。
- 配布の形ごとの差（Claude プラグイン・Codex・このリポジトリ自身）を、判定の裏側に閉じ込める。

## Out of Boundary
- GitHub 側の設定（Ruleset など）。
- worktree の片付け（`finish`）の挙動。

## Upstream / Downstream
- **Upstream**: `brw-branch-gate`（`create` / `resume` の入口と配置先）、配布の仕組み（Claude プラグインの更新、Codex の clone）。
- **Downstream**: なし。

## Existing Spec Touchpoints
- **Extends**: なし（新しい責務）。
- **Adjacent**: `brw-branch-gate`（`create` / `resume` の置き換え・拒否と配置先。順序は「最新化 → 置き場の決定 → 作成」）、`brw-pr-handoff`（公開後の再開）、`sync-base-branch`（基底ブランチの更新。リポジトリ内容の追従で、BRW 自身の最新化とは別）。

## Constraints
- 最新化に失敗したときは中止する（利用者の決定）。
- 外部の動作（プラグインの更新の反映、通信）に依存するため、要件の段階で実機検証の要否を判定する（PoC が必要になる見込み）。
