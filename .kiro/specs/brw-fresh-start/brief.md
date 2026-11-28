# Brief: brw-fresh-start

## Problem
- BRW を使う利用者・エージェントは、`brw create` / `brw resume` で worktree を作るとき、古い版の BRW のまま作業を始めてしまうことがある。古い版では最新の判定（フックの拒否・置き換え・PR の手順）が効かず、作業の途中で挙動が変わる。
- 同じ問題は cc-sdd-bootstrap（cc-sdd の運用一式を導入する別リポジトリの仕組み）にもある。そちらにも同じ形で「最初に最新を適用する」仕組みを持たせたいが、BRW と cc-sdd-bootstrap は互いを知らない前提のため、共通の入口の形が要る。

## Current State
- BRW の更新は利用者が手で行う（Claude プラグインは `claude plugin update branch-release-workflow@nekono-dev`、Codex は clone の `git pull --ff-only`。`references/setup.md`）。`brw create` / `brw resume`（`scripts/brw.mjs`）は更新の確認をしない。
- cc-sdd-bootstrap には `freshness.mjs`（セッション開始時に配布元の最新と比べて案内を出す）と `install-cc-sdd.mjs`（セッション開始・入力時に導入）があるが、案内だけで止めない。通信に失敗したときは何も出さず通す（`unknown`）。
- worktree はこの導入物（フックの設定・`.agent-hooks/` など）が新しい版かどうかに関わらず、そのブランチの内容で作られる。

## Desired Outcome
- `brw create` / `brw resume` は、worktree を作る前に BRW 自身が最新であることを確かめ、古ければ更新してから worktree を作る。最新化できないとき（オフラインなど）は、worktree を作らず中止し、理由と次の手順を案内する。
- 最新化の確認は共通の入口（判定の結果・更新の手順・案内の形）として定義され、cc-sdd-bootstrap も同じ入口で最新化を最初に適用できる。
- 最新の確認を省く手段は設けない（常に最新を使う）。ただし、手段の有無は設計で決める。

## Approach
- 共通の入口を定義し、BRW の `create` / `resume` の先頭（置き場の決定・作成より前）で呼ぶ。入口は「現在の版」「配布元の最新」を比べて `same` / `behind` / `unknown` を返し、`behind` のときは更新して再確認、`unknown`（通信の失敗など）のときは中止する。
- 配布の形（Claude プラグイン・Codex の clone・このリポジトリ自身）ごとに、版の取得と更新の手段が違うため、設計で整理する。更新が実行中のセッションに反映される条件（再起動が要るか）は実機で確かめる。
- cc-sdd-bootstrap 側は別リポジトリの対応なので、この仕様では入口の形（出力・終了コード・案内の文面の契約）までを定める。

## Scope
- **In**:
  - `brw create` / `brw resume` の前段での最新化の確認と、失敗時の中止（案内つき）。
  - 配布の形ごとの版の取得・更新の手段（BRW）。
  - cc-sdd-bootstrap も使える共通の入口の契約（入出力・案内の形）。
- **Out**:
  - cc-sdd-bootstrap 本体の改修（配置物は直接編集しない。別リポジトリでの対応）。
  - worktree の置き場の変更（`brw-branch-gate` の更新で扱う）。
  - 最新化の確認を省くための設定やオプション（必要なら設計で再検討）。

## Boundary Candidates
- 最新化の判定（版の取得・比較）と、更新の実行を分ける。
- 共通の入口の契約と、BRW 側の呼び出し位置を分ける。
- 配布の形ごとの差（Claude プラグイン・Codex・このリポジトリ自身）を、判定の裏側に閉じ込める。

## Out of Boundary
- cc-sdd-bootstrap の `freshness.mjs`・`install-cc-sdd.mjs` の改修。
- GitHub 側の設定（Ruleset など）。
- worktree の片付け（`finish`）の挙動。

## Upstream / Downstream
- **Upstream**: `brw-branch-gate`（`create` / `resume` の入口と配置先）、配布の仕組み（Claude プラグインの更新、Codex の clone）。
- **Downstream**: cc-sdd-bootstrap（同じ入口を使って最新化を最初に適用する将来の変更）。

## Existing Spec Touchpoints
- **Extends**: なし（新しい責務）。
- **Adjacent**: `brw-branch-gate`（`create` / `resume` の置き換え・拒否と配置先。順序は「最新化 → 置き場の決定 → 作成」）、`brw-pr-handoff`（公開後の再開）、`sync-base-branch`（基底ブランチの更新。リポジトリ内容の追従で、BRW 自身の最新化とは別）。

## Constraints
- 最新化に失敗したときは中止する（利用者の決定）。
- 外部の動作（プラグインの更新の反映、通信）に依存するため、要件の段階で実機検証の要否を判定する（PoC が必要になる見込み）。
- `.agent-hooks/cc-sdd-bootstrap/` の配置物は直接編集しない。
