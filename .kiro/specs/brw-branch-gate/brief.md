# Brief: brw-branch-gate

## Problem
- BRW 導入済みのリポジトリでも、エージェントが素の git コマンドや Claude Code 組み込みの EnterWorktree ツールでブランチ・worktree を作ると、BRW の命名規則・分岐元・作業記録を通らない。
- 将来 cc-sdd-bootstrap が、kiro-discovery などの機能追加時に「通常のブランチ作成」を強制する。BRW と cc-sdd-bootstrap は互いを知らない前提なので、BRW 側が入口を奪って `brw create` に収束させる必要がある。

## Current State
- Bash の `git switch -c` / `git checkout -b` / `git branch <名前>` / `git worktree add` は、既存の brw-enforcement（要件 1.2）が拒否し、`brw create` を案内している（`scripts/operation-decision.mjs` の `evalCreate`）。
- フックの対象は Bash と `mcp__.*` だけで、Claude Code 組み込みの EnterWorktree ツールなど Bash 以外の入口は判定されない。
- 拒否時のメッセージは人が読む文章で、呼び出し側が機械的に次の手順を取り出す形ではない。拒否のため、エージェントは自力で `brw create` を実行し直し、作業場所へ移る必要がある。

## Desired Outcome
- BRW 導入済みのリポジトリで、ブランチ・worktree の作成や作業場所の変更を試みる入口は、すべて `brw create`（または再開の `brw resume`）に収束する。
- 命名規則に合う名前の素の git コマンドは、フックが拒否せず `brw create` 相当へ自動で置き換えて実行し、作業場所（worktree）のパスへ移れるようにする。置き換えられない場合（名前が規則外・対象が確定できない・置き換えに未対応のホスト）は拒否し、案内を返す。
- 拒否・置き換えの案内は、固定の見出し・次に実行するコマンド・作業場所のパスを含む機械可読な形で返す。cc-sdd-bootstrap など呼び出し側が BRW を知らなくても手順を辿れる。
- BRW を導入していないリポジトリでは、何も起きない。

## Approach
既存のフック判定（`classifyCommand` と `operation-decision`）を拡張する。
1. 置き換え: Claude Code のフックの入力書き換え機能で、`git switch -c <名前>` などを `brw create <名前>`（と、成功後に作業場所へ移る `cd`）へ書き換える。対象は名前が `namePattern` に合い、分岐元が確定できるときだけ。
2. 拒否: 置き換えない場合は従来どおり拒否し、案内を機械可読な形で返す。
3. 入口の拡大: フックの matcher を EnterWorktree など Bash 以外の入口へ広げ、同じ判定で処理する。
4. Codex: 入力の書き換えが使えないため、拒否と案内（`guard` の手順）で扱う。

## Scope
- **In**:
  - 置き換え（書き換え）の判定と、その結果の案内。
  - 拒否時の案内を機械可読にする（見出し・次のコマンド・作業場所のパス）。
  - EnterWorktree など Bash 以外の入口への判定の拡大（フック定義と `agent-hooks.mjs`）。
  - 作業場所の変更（既存ブランチへの切り替え・worktree への移動）の扱いの整理（`brw resume` への収束）。
  - 自己テスト・評価ケース、SKILL.md と references の更新。
- **Out**:
  - cc-sdd-bootstrap と kiro 系スキルの変更（呼び出し側は素の git で試みるだけ）。
  - 命名規則・分岐元・保護規則そのものの変更、Ruleset の仕組み。
  - PR 作成・片付けの流れ（brw-pr-handoff）。
  - 宣言の無いリポジトリの挙動の変更。

## Boundary Candidates
- ブランチ・worktree 作成の判定結果に「置き換え」を加える判定層（`operation-decision`）。
- Claude Code のフック応答（書き換え入力・拒否理由の整形）と Codex の案内の出力層。
- フックの対象入口（matcher と Bash 以外のツール入力の読み取り）。
- 案内の機械可読な形式の定義。

## Out of Boundary
- cc-sdd-bootstrap 側の「ブランチ作成を強制する」指示の実装。
- brw create の命名規則の検証の変更（配置先は、2026-11-28 の更新で範囲内にした。下の「更新」を参照）。
- GitHub 側の保護設定。

## Upstream / Downstream
- **Upstream**: brw-enforcement（フック判定・`evalCreate`・`brw create`/`resume`）、宣言の読み込み（`lib.mjs`）。
- **Downstream**: cc-sdd-bootstrap の将来の運用（機能追加時のブランチ作成の強制）。brw-pr-handoff とは独立（同じ作業ブランチ dev/brw-pr-handoff で並行して進める）。

## Existing Spec Touchpoints
- **Extends**: brw-enforcement（要件 1.2 の拒否を、置き換えと入口の拡大で拡張する。承認済みの文書は書き換えない）。
- **Adjacent**: brw-pr-handoff（同じフックの判定ファイルに触れうるため、衝突に注意）。

## Constraints
- Node.js 22 以上・標準モジュールのみ（`.mjs`）。
- 判定や副作用を変えるときは CLI とフックの両方を確認する。
- 置き換えは入力を確定できるときに限り、不確かなときは拒否する（要件 1.4 の安全側）。
- フックの書き換えは Claude Code でのみ使える見込み。Codex は拒否と手順書で扱う。
- BRW と cc-sdd-bootstrap は互いを知らない前提。BRW は `.kiro` や cc-sdd の語を持たない。

## 設計フェーズで決めること（未決）
- Claude Code のフックの入力書き換え（`updatedInput`）で、`brw create` の後に作業場所へ移る（`cd`）方法と、セッションの作業ディレクトリが保たれる条件。
- 書き換え可能な条件（名前の規則・分岐元の確定・既存ブランチの有無）の詳細。
- EnterWorktree の入力（名前・分岐元）の読み取りと、置き換え・拒否のどちらにするか。
- 機械可読な案内の形式（フック応答の理由欄の書式など）。
- 既存ブランチへの切り替え（再開）を、`brw resume` へ置き換えるか拒否にするか。

## 更新（2026-11-28）: 配置先を `<本体>/.worktree/` に変える

### 背景
- Codex など Claude 以外のエージェントからも使える中立の場所にするため、worktree の置き場を `<本体>/.claude/worktrees/` から `<本体>/.worktree/`（単数形）に変える（利用者の決定）。旧置き場は認識しない（完全に切り替える。旧置き場の既存の worktree は、利用者が手で移す）。
- 配置先を具体的なパスで定めているのは、この仕様の要件（1.5）と EnterWorktree の判定（3.x）だけで、`brw create`・`brw resume` が実際に作る場所は、どの仕様の要件にも書かれていない。そのため、配置先の決まりをこの仕様が持つ。

### 範囲の変更
- **In（追加）**: `brw create`・`brw resume` が worktree を作る場所を `<本体>/.worktree/<alias>` と定めること。置き換え・拒否・EnterWorktree の `path` の判定で使う「配置先」を `.worktree/` の配下に改めること。旧置き場の worktree を、配置先として認めないこと。
- **Out（変更なし・別の仕様）**: PR 本文の置き場 `.brw/` の移動（`brw-pr-handoff`。実装の後、続けて移す）。導入先の `.gitignore` への追記と、導入・更新の流れ（`brw-install-flow`）。BRW 自身が導入先の `.gitignore` や `info/exclude` を書き換えること（しない。案内は `brw-install-flow`）。

### 制約
- 置き場の名前は `.worktree`（単数形）に固定する。
- 配置先の変更は、移行期に PR 本文だけが旧置き場 `.claude/worktrees/.brw/` に残ることを許す（`brw-pr-handoff` の更新まで）。

