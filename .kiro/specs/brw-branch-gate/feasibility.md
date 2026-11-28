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

- 判定: 通過

**実装中に設計へ戻して直した（2026-11-28、タスク 6.1）**: 配置先の判定の契約・事後条件が、配置先と旧置き場の実体の重なり・解決できない経路・生の `..` を定めておらず、実装が 3 回続けて却下された（原因調査の分類: SPEC_CONFLICT）。利用者の許可を得て、設計を単純化した（`research.md` の D6）: 判定を「worktree のルート 1 階層の一致」の 4 値（配置先・旧置き場・対象外・判定不能）にし、判定不能は呼び出し側が必ず止める。別の提供元の独立レビューを 2 回受け、指摘（生の `..` の検査の位置、シンボリックリンクの検査、判定不能の扱い）を反映した。最後の指摘（`.worktree` 未作成時の規則 3 の例外）を直した修正は、レビュー役の再確認を受けていない。この単純化は新しい外部の動作に依存しない（判定は git の一覧と実体のパスだけ。前提 4・7 の PoC に含まれる）ため、根拠の無い前提は増えない。

確認日 2026-11-28。根拠の無い前提: なし（Codex の前提 3 は `poc/design_03.md` で確認した）。

| # | 前提 | 根拠 |
|---|---|---|
| 1 | EnterWorktree の `path` が `.worktree/<別名>` で、承認を与えれば入れる。BRW のフックの許可では承認を省けない | **一次資料** https://code.claude.com/docs/en/tools-reference「EnterWorktree tool behavior」・https://code.claude.com/docs/en/worktrees（2026-11-28 取得。「a `path` outside `.claude/worktrees/` prompts for your approval before entering」「An `EnterWorktree` permission rule or choosing "don't ask again" doesn't suppress this prompt; only `bypassPermissions` mode skips it.」）。**PoC** `poc/design_01.md` の 1（フックが `allow` を返しても確認で止まる。`.claude/worktrees/` は確認なし）。承認を与えた場合に入れることは、文書の記述のみ（実機では未実施）。**設計への反映**: 案内に承認の注意を書き、移動は `cd` を実用の手段とする |
| 2 | フックが `.worktree/<別名>` で開始したセッション・EnterWorktree で入ったセッションの両方に届く。`CLAUDE_PROJECT_DIR` の値で本体を導ける | **PoC** `poc/design_01.md` の 2・3（開始時は `cwd`・`CLAUDE_PROJECT_DIR` が worktree 自身、EnterWorktree 後は `cwd` が worktree・`CLAUDE_PROJECT_DIR` が本体）。**一次資料** https://code.claude.com/docs/en/hooks「Reference scripts by path」、https://code.claude.com/docs/en/worktrees「What worktrees share with the main checkout」（「plugins installed at project scope from the main checkout also load in worktrees of the same repository.」。`settings.local.json` は本体のルートを使う）、https://code.claude.com/docs/en/settings（2026-11-28 取得）。本体側だけにある project スコープのプラグインの導入が worktree で読まれることは、この一次資料による（実機では、worktree 自身にコミットされた設定で確認）。**設計への反映**: `mainOfStart` の形を `.worktree/<別名>` にする |
| 3 | Codex が `.worktree/<別名>` の linked worktree でも（worktree に空の `.codex/` があれば）、本体の `.codex/hooks.json` を読み込む | **PoC** `poc/design_03.md`（Codex 0.172.0、`hooks/list`: `.worktree/dev-x` で本体の `hooks.json` が読まれ、`.codex/` の無い worktree では読まれず、旧置き場の比較と同じ結果）。**一次資料** https://learn.chatgpt.com/docs/hooks（2026-11-28 取得）「In a linked Git worktree, a project layer can read hooks from the corresponding directory in the main checkout.」（置き場所による違いは記載なし）。発火（実際のセッションでのフックの実行）は旧置き場で Codex 0.167 で確認済みで、読み込みの規則は同じため、新配置先での発火の実機確認は不要と判断した（`poc/design_03.md` の「確かめられなかったこと」に記載） |
| 4 | git が本体の直下の `.worktree/<別名>` に worktree を作り、一覧・本体の特定・移動・削除・`--carry` の手順が従来どおり動く | **PoC** `poc/design_02.md` の 3・4・5・7 |
| 5 | 配置先のディレクトリ全体が無視されているかを `git check-ignore`（存在しない固定の子 `.worktree/.brw-probe`）で検出できる | **PoC** `poc/design_02.md` の 1・6（0 無視・1 無視されない・128 判定不能。`.gitignore`・`info/exclude`・先頭の `/` なしのパターンで 0。別名だけを無視する設定は 1） |
| 6 | 無視されていない本体で `git add -A` をすると worktree が gitlink として誤って追加される（警告の動機） | **PoC** `poc/design_02.md` の 2 |
| 7 | 旧置き場の worktree を `git worktree move` で（未コミットの変更ごと）新しい場所へ移せる。ロックされていれば拒否される。サブモジュールを持つ worktree は移せない | **PoC** `poc/design_02.md` の 5。**一次資料** git 2.43 のマニュアル（`git help -m worktree`、2026-11-28）の「linked worktrees containing submodules cannot be moved with this command」（`poc/design_02.md` の 8）。サブモジュールの実機の出力は未確認だが、設計は移せないときの手順を案内して何も変えない形で、この前提に依存しない |

## タスク計画の確認

- 判定: 通過

確認日 2026-11-28（`/kiro-spec-tasks` の更新分の草案レビュー。別の提供元の独立レビューで `PASS`）。

- 実機の確認は、更新分の最初の群 **5（5.1・5.2）** に置いた。最初の実装タスクは **5.1**（Claude Code と `.worktree/` の挙動の観察。EnterWorktree の承認、フックの届き方、`CLAUDE_PROJECT_DIR`）、5.2 が Codex の本体のフックの読み込みの確認。通しの実機確認（8.1）は後段に置き、5.1・5.2・7.4 に依存させた。
- 根拠の無い前提: なし（設計の確認の表と `poc/design_01.md`〜`design_03.md` に対応づけた）。
- 未解決: なし。これまでの経過: 草案のレビューを 3 回受けた。1 回目は `RETURN_TO_DESIGN`（設計書に旧配置先の記述が 1 か所残っていた。修正済み）、2 回目は `NEEDS_FIXES`（未追跡の件数の担当、試験ファイルの所有、5.1 の観察対象、旧置き場の文字列の検査の範囲、7.3 の列挙）で、すべて草案に反映した。3 回目は指摘なしの `PASS`。
