# 実現性の記録: brw-branch-gate

## 実機検証の要否

- 判定: 必要

2026-11-28 の要件の更新（配置先を `<本体>/.worktree/` に変更）の時点で判定した。配置先がエージェント側の既定の場所（`.claude/worktrees/`）から外れるため、エージェントの実行環境の挙動に依存する前提がある。いずれも根拠は未確認で、設計の承認の前に、一次資料か再実行できる PoC で確かめる。

| 前提 | 依存する外部の動作 | 根拠 | PoC の方針 |
|---|---|---|---|
| Claude Code の EnterWorktree が、`path` 指定で `<本体>/.worktree/<別名>` の worktree に入れる（置き場が `.claude/worktrees/` でなくても拒否されない） | Claude Code 組み込みの EnterWorktree の入力の扱い | 未確認 | 実際の Claude Code で、`.worktree/` の下の worktree を `path` 指定で入り、作業ディレクトリが移ることを確かめる |
| Claude Code の PreToolUse・Stop などのフックが、`.worktree/<別名>` の中で動くセッションにも、本体の導入と同じ判定で届く（本体の特定が、置き場の形に依存しない） | Claude Code のプロジェクトの特定（`CLAUDE_PROJECT_DIR`・フックの作業ディレクトリ）とフックの発火 | 未確認（現行の実装は `.claude/worktrees/<別名>` の形から本体を求めている箇所がある） | 実際の Claude Code で、`.worktree/<別名>` を作業ディレクトリにして、フックの入力の作業ディレクトリとプロジェクトの値を観測する |
| Codex が、`.worktree/<別名>` の linked worktree でも、本体の `.codex/hooks.json` を読んでフックを届ける（worktree に `.codex/` がある場合） | Codex のフックの読み込みと linked worktree の扱い | 未確認（旧置き場では Codex 0.167 で確認済み） | 実際の Codex で、`.worktree/<別名>` の worktree からフックが届くことを確かめる |
| git が、本体の作業ツリーの直下の `.worktree/<別名>` に worktree を作り、一覧・削除・`--carry` の適用が従来どおり動く | git の `worktree add`・`list`・`remove` の挙動 | 未確認 | 一時リポジトリで、作成・一覧・片付け・未追跡の一覧への現れ方を確かめる |

## 設計の確認

- 判定: 未通過

2026-11-28 の要件の更新により、既存の設計（承認済み）を更新する必要がある。更新後の設計で、前提ごとに根拠を確認する。

## タスク計画の確認

- 判定: 未通過

2026-11-28 の要件の更新により、既存のタスク計画を更新する必要がある。
