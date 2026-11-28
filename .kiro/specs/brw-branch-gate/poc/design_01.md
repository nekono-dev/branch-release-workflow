- 対象: Claude Code で、配置先 `<本体>/.worktree/<別名>` の worktree に対して、(1) EnterWorktree の `path` 指定がフックの許可で承認プロンプトなしに通るか、(2) `.worktree/<別名>` で開始したセッションと、EnterWorktree で入ったセッションで、フック・`cwd`・`CLAUDE_PROJECT_DIR` がどうなるか（要件 1.5・2.2・2.6・7.1〜7.4、実現性の記録の前提 1・2）
- 段階: design

# PoC design_01: Claude Code と `.worktree/` の配置先

## 実施内容
- 一時ディレクトリに使い捨てのリポジトリを作り、プロジェクトの設定（`.claude/settings.json`、コミット済み）で SessionStart・UserPromptSubmit・PreToolUse（EnterWorktree・Bash）・Stop のフックに、入力の `cwd`・環境変数 `CLAUDE_PROJECT_DIR` を記録するだけの小さなスクリプトを登録した。環境変数で、EnterWorktree に対して `permissionDecision: "allow"` を返すかを切り替えられる。`.gitignore` に `/.worktree/` と `/.claude/worktrees/` を入れた。
- worktree を 2 つ作った: `<本体>/.worktree/dev-x`（配置先の候補）と、比較用の `<本体>/.claude/worktrees/dev-y`（現行の配置先）。
- 実際の `claude -p`（`--output-format stream-json`、`--allowedTools "EnterWorktree,Bash,ToolSearch"`、権限モードは既定）で、次を実行した。
  - R1: 本体のセッションで、EnterWorktree を `path` に `.worktree/dev-x` で呼び、続けて `pwd`。フックは `allow` を返す。
  - R3（比較）: 同じことを `.claude/worktrees/dev-y` で行う。フックは何も返さない。
  - R4: セッションを `.worktree/dev-x` で開始し（`cwd` をそこにして `claude -p` を起動）、`pwd` を実行する。
- 利用者の設定・認証は書き換えていない（一時のリポジトリの設定だけを使用）。使い捨てのリポジトリと記録は実施後に残していない。

## 実施日
2026-11-28

## 環境と版
Claude Code 2.1.329、Node.js 22.16.0、git 2.43.0、Linux（Ubuntu）。

## 結果と仕様への反映
1. **R1: フックが `allow` を返しても、`.worktree/dev-x` への EnterWorktree は止まった。** ツールの結果は `Enter the worktree at "…/.worktree/dev-x"? This moves the session's working directory and write access there, and loads project configuration (CLAUDE.md, settings) from that location.`（`is_error`）で、作業ディレクトリは移らなかった（`-p` は承認の入力ができない）。フックの PreToolUse は発火し、`allow` を返していた。**R3（比較）: `.claude/worktrees/dev-y` は、確認なしで入れた**（`Entered worktree at …`、続く `pwd` が worktree）。→ 配置先が `.claude/worktrees/` の外になると、EnterWorktree は Claude Code 自身の承認（人の確認）を必ず求め、BRW のフックの許可では省けない。公式ドキュメントの記述（「a `path` outside `.claude/worktrees/` prompts for your approval before entering」「An `EnterWorktree` permission rule or choosing "don't ask again" doesn't suppress this prompt; only `bypassPermissions` mode skips it.」。https://code.claude.com/docs/en/tools-reference と https://code.claude.com/docs/en/worktrees、2026-11-28 取得）と一致する。
2. **R4: `.worktree/dev-x` で開始したセッションでも、フックは届いた**（SessionStart・UserPromptSubmit・PreToolUse・Stop のすべて。worktree 自身にコミットされた設定のフックが発火）。このとき入力の `cwd` と環境変数 `CLAUDE_PROJECT_DIR` は、**どちらも worktree 自身**（`<本体>/.worktree/dev-x`）だった。→ `mainOfStart` が使う `CLAUDE_PROJECT_DIR` の形は `<本体>/.worktree/<別名>` に改める必要がある。
3. **EnterWorktree で入ったあとのフック（R3）**: `cwd` は worktree、`CLAUDE_PROJECT_DIR` は本体のまま（公式ドキュメント「Worktrees are different.」の記述と一致）。
4. BRW の置き換え（`cd` による作業場所の移動。既存の方式）は、Bash の `cd` なので承認の対象ではない。→ Claude Code での作業場所の移動は、承認を要する EnterWorktree ではなく、`cd` による方法が実用的になる。
5. 公式ドキュメントの別の記述: 「from within a worktree session, only the `path` form is available and the target must be under `.claude/worktrees/` of the session's repository.」（tools-reference）。→ EnterWorktree で worktree に入ったセッションからは、`.worktree/` の下の別の worktree へ EnterWorktree で移れない（先に ExitWorktree が要る）。

## 確かめられなかったこと
- 承認を与えた場合（対話の確認で許可、`bypassPermissions`）に、`.worktree/<別名>` へ実際に入れること（権限モードの迂回に当たるとして自動の判定が実行を止めたため、実施していない。文書上は、承認すれば入れる）。
- 対話（`-p` でない）のセッションでの承認プロンプトの見え方。
- worktree セッション内から別の `.worktree/` の worktree への EnterWorktree の拒否（文書の記述のみ）。
