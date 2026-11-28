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

確認日 2026-11-28。**根拠の無い前提: あり（下の 3）**。

| # | 前提 | 根拠 |
|---|---|---|
| 1 | EnterWorktree の `path` が `.worktree/<別名>` で、承認を与えれば入れる。BRW のフックの許可では承認を省けない | **一次資料** https://code.claude.com/docs/en/tools-reference「EnterWorktree tool behavior」・https://code.claude.com/docs/en/worktrees（2026-11-28 取得。「a `path` outside `.claude/worktrees/` prompts for your approval before entering」「An `EnterWorktree` permission rule or choosing "don't ask again" doesn't suppress this prompt; only `bypassPermissions` mode skips it.」）。**PoC** `poc/design_01.md` の 1（フックが `allow` を返しても確認で止まる。`.claude/worktrees/` は確認なし）。承認を与えた場合に入れることは、文書の記述のみ（実機では未実施）。**設計への反映**: 案内に承認の注意を書き、移動は `cd` を実用の手段とする |
| 2 | フックが `.worktree/<別名>` で開始したセッション・EnterWorktree で入ったセッションの両方に届く。`CLAUDE_PROJECT_DIR` の値で本体を導ける | **PoC** `poc/design_01.md` の 2・3（開始時は `cwd`・`CLAUDE_PROJECT_DIR` が worktree 自身、EnterWorktree 後は `cwd` が worktree・`CLAUDE_PROJECT_DIR` が本体）。**一次資料** https://code.claude.com/docs/en/hooks「Reference scripts by path」、https://code.claude.com/docs/en/worktrees「What worktrees share with the main checkout」（「plugins installed at project scope from the main checkout also load in worktrees of the same repository.」。`settings.local.json` は本体のルートを使う）、https://code.claude.com/docs/en/settings（2026-11-28 取得）。本体側だけにある project スコープのプラグインの導入が worktree で読まれることは、この一次資料による（実機では、worktree 自身にコミットされた設定で確認）。**設計への反映**: `mainOfStart` の形を `.worktree/<別名>` にする |
| 3 | **Codex が `.worktree/<別名>` の linked worktree でも、本体の `.codex/hooks.json` を読んでフックを届ける** | **未確認**。一次資料 https://learn.chatgpt.com/docs/hooks（2026-11-28 取得）は「In a linked Git worktree, a project layer can read hooks from the corresponding directory in the main checkout.」とだけ書き、worktree の置き場所による違いと、worktree 側の `.codex/` の要否は記載なし。旧置き場では Codex 0.167 で確認済み（`references/setup.md`）だが、新しい置き場の実機は未実施（認証の一時コピーが要るため、利用者の判断を待つ） |
| 4 | git が本体の直下の `.worktree/<別名>` に worktree を作り、一覧・本体の特定・移動・削除・`--carry` の手順が従来どおり動く | **PoC** `poc/design_02.md` の 3・4・5・7 |
| 5 | 配置先のディレクトリ全体が無視されているかを `git check-ignore`（存在しない固定の子 `.worktree/.brw-probe`）で検出できる | **PoC** `poc/design_02.md` の 1・6（0 無視・1 無視されない・128 判定不能。`.gitignore`・`info/exclude`・先頭の `/` なしのパターンで 0。別名だけを無視する設定は 1） |
| 6 | 無視されていない本体で `git add -A` をすると worktree が gitlink として誤って追加される（警告の動機） | **PoC** `poc/design_02.md` の 2 |
| 7 | 旧置き場の worktree を `git worktree move` で（未コミットの変更ごと）新しい場所へ移せる。ロックされていれば拒否される。サブモジュールを持つ worktree は移せない | **PoC** `poc/design_02.md` の 5。**一次資料** git 2.43 のマニュアル（`git help -m worktree`、2026-11-28）の「linked worktrees containing submodules cannot be moved with this command」（`poc/design_02.md` の 8）。サブモジュールの実機の出力は未確認だが、設計は移せないときの手順を案内して何も変えない形で、この前提に依存しない |

## タスク計画の確認

- 判定: 未通過

2026-11-28 の要件の更新により、既存のタスク計画を更新する必要がある。
