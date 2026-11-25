# 調査記録: brw-branch-gate（設計前の検証）

検証日: 2026-11-25。環境: Claude Code 2.1.329、Codex CLI 0.172.0、Node.js 22。使い捨ての Git リポジトリでフックを組み、`claude -p` で実際に動かして確かめた。

## 検証結果（設計の前提として確定したこと）

| # | 確かめたこと | 結果 | 設計への影響 |
|---|---|---|---|
| 1 | Bash の PreToolUse フックが返す入力の書き換え（`hookSpecificOutput.updatedInput`）が効くか | **効く**。`git switch -c dev/foo` を `git worktree add … && cd … && echo …` へ書き換えて実行できた。理由欄（`permissionDecisionReason`）も返せる | 書き換えによる置き換えが実現できる |
| 2 | 書き換えたコマンドの中の `cd` で、次の Bash 呼び出しの作業ディレクトリも移るか | **移る**（次の `pwd` が worktree、`git branch --show-current` が `dev/foo`）。worktree がプロジェクト配下（`.claude/worktrees/`）にある場合 | `brw create` の後に `cd <worktree>` を足せば、セッションの作業場所ごと移せる。作業場所が配下にあることが条件 |
| 3 | EnterWorktree ツールにフックが掛かるか | **掛かる**。matcher を `.*` にすると `tool_name: "EnterWorktree"`、`tool_input: {name}` が届く。現行の matcher（Bash と `mcp__.*` だけ）では掛からない | matcher に `EnterWorktree` を追加する必要がある |
| 4 | EnterWorktree の素の動作 | ブランチ名は `worktree-<name>`（`dev/*` に合わない）で、`.claude/worktrees/<name>` に作られる。ブランチ名は入力で指定できない | 素のままでは BRW の命名規則を満たせない。置き換えか拒否が必須 |
| 5 | EnterWorktree の入力を `{name}` から `{path}` へ書き換えられるか | **書き換えられる**。`path`（既存 worktree への切り替え）に書き換えると、セッションがその worktree（`dev/probe`）へ移った | フックで `brw create` 相当を行い、結果の worktree を `path` で渡せば、セッションの作業場所も BRW の worktree へ移る |
| 6 | 拒否の応答（`permissionDecision: "deny"` と理由）の伝わり方 | 伝わる。ただし固定の見出し語だけの理由（`BRW-GATE: blocked …`）は、エージェントが意味を取れず、確認を求めて止まった | 機械可読にするだけでなく、自然文の指示（次に実行するコマンドをそのまま書く）を理由の本文にする。見出し語は補助にとどめる |
| 7 | Codex で入力の書き換えが使えるか | **未検証**。フックの信頼が必要で、`--dangerously-bypass-hook-trust` による回避は自動判定で拒否されたため実施していない | Codex は従来どおり拒否と案内（`guard`）で扱う。書き換えは Claude Code 専用とする |
| 8 | 既存の判定で、素の git コマンドを `create` として識別できるか | 識別できる（`git switch -c`・`git checkout -b`・`git worktree add -b` が `create@dev/foo`）。`gh pr create` と `gh api …/pulls` も `pr-create` に分類される | 判定層の追加は最小で済む。置き換え可否の判断を `evalCreate` の結果に足す |

## 設計で確定する方針（検証に基づく）

- 書き換えの条件: `namePattern` に合う名前、分岐元が確定できる、対象が単独の操作（複合コマンドでない）。満たさなければ拒否。
- 書き換え後のコマンドは `brw create <名前> && cd <worktree のパス>` とし、実行時の出力に「何が置き換えられたか」を自然文で添える（#1・#6）。
- EnterWorktree は、名前が規則に合うなら `brw create` を実行したうえで `{path}` へ書き換える。副作用（worktree の作成）をフックの中で行うため、設計で「フックが副作用を持つ」ことの是非を決める（代案: 拒否して `brw create` の後に `EnterWorktree {path}` を案内する）。
- 作業場所が `.claude/worktrees/` の配下であることを前提にする（#2・#5）。

## 未決（利用者の判断が必要）

- EnterWorktree: フック内で worktree を作って書き換える（便利、副作用あり）か、拒否して 2 手に分ける（副作用なし、手数が増える）か。
