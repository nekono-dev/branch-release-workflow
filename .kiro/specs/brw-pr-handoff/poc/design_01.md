# PoC design_01: 本文置き場 `<本体>/.worktree/.brw/` への Write

- 対象: PR 本文ファイルの置き場を `<本体>/.claude/worktrees/.brw/` から `<本体>/.worktree/.brw/` へ移す前提（要件 3.9・3.10、設計の本文置き場）
- 段階: design

## 実施内容
使い捨ての Git リポジトリ（`git init`、worktree `.worktree/dev-x`）で、実際の `claude -p`（Haiku、`--permission-mode acceptEdits`）に、Write ツールで `<本体>/.worktree/.brw/<名前>.md` を書かせた。セッションの開始場所を変えて 3 通り。

## 環境と版
2026-11-28、Claude Code 2.1.329（Linux）。

## 結果
| 開始場所 | 書き込み先 | 結果 |
|---|---|---|
| 本体 | `<本体>/.worktree/.brw/` | **確認なしで書けた** |
| worktree（`.worktree/dev-x`） | `<本体>/.worktree/.brw/` | 拒否（権限なし）。`default` でも同じ |
| worktree | 旧置き場 `<本体>/.claude/worktrees/.brw/` | 拒否（同じ） |

- 本体で開始して Bash の `cd` で worktree へ移る BRW の通常の流れ（EnterWorktree は使わない）では、書ける。旧置き場と比べて悪化しない（worktree で開始したセッションは旧置き場でも拒否される）。
- 仕様への反映: 置き場を `<本体>/.worktree/.brw/` にする。worktree で開始したセッションの限界は従来どおり（`brw pr-template` の案内で、書けないときは作業ディレクトリ配下の相対パスを使える）。

## 確かめられなかったこと
Codex の書き込み権限（認証が無く未観測。本文の書き込みは従来どおりホストの承認に従う）。
