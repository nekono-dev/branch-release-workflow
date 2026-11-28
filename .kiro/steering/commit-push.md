# 作業の区切りの commit・push（このリポジトリの取り決め）

この文書は `CLAUDE.md` から移した。`CLAUDE.md` は `.gitignore` の対象（cc-sdd-bootstrap が生成する）で、リポジトリには置かないため、独自の取り決めはここに置く。Claude Code・Codex など、どのエージェントもこの文書を読む。

作業ブランチ（`dev/*`）で作業しているとき、次の区切りごとに、変更したパスだけを `git add` し、`git commit` し、`git push` する（許可は求めない。`git add -A` は使わない。秘密情報らしいファイルを含めない。commit 前に `git status`・`git diff --cached` でステージ内容を確かめる）。目的は、作業が途中で終わっても、リモートの作業ブランチだけで別の環境・エージェントが再開でき、終了時に未 push の作業ブランチを残さないこと。

- cc-sdd の各フェーズの成果物（`brief.md`・`roadmap.md`・`requirements.md`・`research.md`・`design.md`・`tasks.md`・`spec.json`・`feasibility.md`・`.kiro/discovery-notes/`）の生成・更新が完了したとき（`/kiro-discovery`・`/kiro-spec-init`・`/kiro-spec-requirements`・`/kiro-validate-gap`・`/kiro-spec-design`・`/kiro-validate-design`・`/kiro-spec-tasks` などの各コマンドの完了時）。
- `/kiro-impl` の各タスクの完了時（`tasks.md` のチェックと実装メモの更新を含めて 1 回）。
- 利用者が push を禁じたときは commit までにとどめ、未 push であることを報告する。push などに失敗したときは、成功した処理・未完了の処理・失敗理由を報告する。
- 応答を終えようとしたときに、未コミットの変更や未 push の commit が残っていると、Stop のフックが終了を 1 回止めて案内する。フックが無い環境では、終了前に `node scripts/brw.mjs guard --finish` を実行し、`[block]` なら案内に従う。
