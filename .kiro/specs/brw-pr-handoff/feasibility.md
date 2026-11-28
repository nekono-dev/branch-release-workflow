# 実現性の記録: brw-pr-handoff

## 実機検証の要否

- 判定: 必要

外部の動作に依存する前提があるため「必要」とする（2026-11-26 の要件の更新時点）。いずれも根拠は未確認で、設計の承認の前に、一次資料か再実行できる PoC で確かめる。

| 前提 | 依存する外部の動作 | 根拠 | PoC の方針 |
|---|---|---|---|
| 分岐元（例 `develop`）から保護ブランチ（例 `main`）への PR を、GitHub の API で作成できる（差が無い場合の応答を含む） | GitHub の PR 作成 API・`gh` | 未確認（引き継ぎメモでは、作成画面の URL を利用者へ渡した記録のみ） | 実リポジトリで、差がある場合・無い場合の PR 作成の応答を確かめる |
| ローカルの分岐元がリモートより先行しているかを、git の出力から判定できる | git の `rev-list`・追跡ブランチの挙動 | 未確認 | 一時リポジトリで、先行・遅れ・同じの各状態を作って確かめる |
| 分岐元の本体の作業ツリーで `brw pr` を実行して、作業状態の記録なしに計画・承認・PR 作成を進められる | 既存の BRW の動作（`brw work start` の拒否の条件） | 未確認 | 実リポジトリの分岐元のチェックアウトで再現する |

## 設計の確認

- 判定: 通過

確認日 2026-11-26。根拠の無い前提: なし。

| 前提 | 根拠 |
|---|---|
| 分岐元を head、保護ブランチを base とする PR を GitHub の API で作れる | **一次資料** GitHub REST API の記述（`api.github.com.json`、`info.version` 1.1.4、取得 2026-11-26）の `POST /repos/{owner}/{repo}/pulls`（201・403・422）。API は head のブランチの種類を区別しない。**既存の観測** 実 GitHub で BRW 経由の開発ブランチ→保護ブランチの PR が実在する（PR #12、2026-11-26 に `gh api` で読み取り）。head が分岐元の実 PR の作成は、外部へ影響するため行っていない。実装後に使い捨てのリポジトリで確かめる |
| ローカルの分岐元をリモートへ fast-forward で追いつかせられ、先行・分岐を検出できる | **PoC** `poc/base-sync.sh`（2026-11-26、一時リポジトリ・bare remote）: 最新・リモート先行・ローカル先行・分岐・差なしの 5 状態。**先行は `ff-only` が成功してしまう**ため `rev-list` で別に検出する、という設計に反映 |
| 保護ブランチとの差を、fetch 後の参照で数えられる | **PoC** 同上（`rev-list --count origin/main..develop`）。実 GitHub の `compare/main...main` は `ahead_by=0`・`identical`（読み取り、2026-11-26） |
| 未コミットの変更がある作業ツリーでの ff 取り込みが安全に失敗する | **PoC** 同上の 6 番: 未追跡ファイルだけなら成功、取り込む対象と同じ追跡ファイルを変更していると「would be overwritten」で失敗し、何も壊さない |
| 分岐元の本体で `brw pr` が作業の記録なしに進められる、片付けが走らない | 外部の動作に依存しない。設計で `base-pr` が `work`・`tidy`・`cleanup` を呼ばない形にし、実装時の試験で固定する |

## タスク計画の確認

- 判定: 通過

確認日 2026-11-26。

- 実機で確かめる前提（分岐元の取り込みと差の判定、head が分岐元の PR の作成）は、今回追加したタスクの先頭の群 **5**（5.1・5.2）に置いた。BRW 本体の実装に依存しない。実機での通し確認は 8.2。
- 1〜4 は、この更新より前に完了した旧い要件のタスクで、今回の更新の対象外。
- 未解決: なし。

## 追記: 公開後の再開（要件 7、2026-11-27）

要件 4.9 の改訂と要件 7 の追加に伴う実機の前提。確認日 2026-11-27。**根拠の無い前提: なし。**

| 前提 | 依存する外部の動作 | 根拠 |
|---|---|---|
| 本体でセッションを開始した場合、作業場所の削除後にホストが作業ディレクトリを本体へ戻す／作業場所の中で開始した場合はホームに落ちる | Claude Code のシェルの扱い | **PoC**（使い捨てリポジトリ、Claude Code 2.1.329、Haiku）: 本体開始は削除後の次の呼び出しで本体に戻る（`CLAUDE_PROJECT_DIR` も本体）、作業場所内の開始は `/home/ubuntu` に落ちる。Codex はコマンドごとに別のシェル（14.1 の観測: Stop の `cwd` が本体のまま） |
| `UserPromptSubmit` の `additionalContext` が Claude Code・Codex のモデルへ届く | 両ホストのフックの応答 | **PoC** `poc/user-prompt-submit.mjs`（2026-11-27、Claude Code 2.1.329・codex-cli 0.172.0）: 両ホストで、フックが返した合言葉をモデルが答えた（`reachedModel: true`） |
| `UserPromptSubmit` の入力に `session_id`・`cwd`・`prompt` が含まれる（Codex は `turn_id`・`model` も） | 両ホストのフックの入力 | 同上の記録（`keys`）。Codex の `cwd` は本体 |
| 本体で開始したセッションでは、作業場所の削除後の 2 回目の入力でも、同じ `session_id`・`cwd`=本体でフックが動く | Claude Code のフックの実行場所 | **PoC** `poc/user-prompt-submit-after-remove.mjs main`（2026-11-27、Claude Code 2.1.329）: 2 回の `UserPromptSubmit` が同じ `session_id`・`cwd`・`CLAUDE_PROJECT_DIR`（本体）で記録された |
| 作業場所の中で開始したセッションでは、削除後にフックが動かない | 同上 | **PoC** `poc/user-prompt-submit-after-remove.mjs worktree`: 削除後の 2 回目の入力でフックの記録が増えなかった（`hookEntries` が 1 件）。要件 7.4 の対象外とした |
| Codex の `.codex/hooks.json` に `UserPromptSubmit` を登録して届く | Codex 0.172.0 のフック | **PoC** 同上（一時の `CODEX_HOME` の信頼とフックの信頼の省略）。実際の信頼の承認操作は既存の導入手順（`brw setup`・診断の `untrusted`）に従う（実機の承認操作は 9.6 の対象外で、既存の 8.4 の記録に同じ制約） |

## 追記: 実機の観測による差し戻し（要件 7.4、2026-11-27）

9.6 後半の実機の観測（Claude Code 2.1.329、`tests/real-env/README.md` の「結果（brw-pr-handoff 9.6 の後半）」）で、設計の前提が成り立たないと分かった。`## 設計の確認` の判定を `未通過` に戻した。

- 片付けつきの `brw pr` を作業場所の中で実行すると、Bash の結果が「Exit code 1」と報告され、`PostToolUse` が届かない。このため `attachSession`（成功した `brw pr` で記録に `sessionId` を付ける）が働かず、同じセッションの `UserPromptSubmit` の案内（要件 7.4）は一度も届かなかった（本体で開始・3 回とも）。
- `cd <作業場所> && brw pr ; cd <本体>` は `PostToolUse` が届くが、字句解析が `;` を解釈せず付かない。
- 作業場所の中で開始したセッションでも、削除後に `UserPromptSubmit` が動くことがあった（3 回中 1 回）。設計の「動かない」は揺れる。
- Codex は認証が無く未観測。

## 追記: 実行前の記録への改訂の確認（要件 7.2・7.4、2026-11-27）

設計の「セッションの関連付けの改訂」（`PreToolUse` で `session-hint.json` を書き、片付けが読む）の前提。確認日 2026-11-27。**根拠の無い前提: あり（下の 2 件。`## 設計の確認` は `未通過` のまま。9.8 の実機の再観測で根拠を足す）。**

| 前提 | 依存する外部の動作 | 根拠 |
|---|---|---|
| 信頼済みの `brw pr`（Bash）の実行前に、`PreToolUse` が Claude Code で届く | Claude Code のフック | **既存の観測** 8.4・5.2 B1（実機の Claude Code が登録済みのフックの PreToolUse の allow で `brw pr` を実行）、9.6 後半の観測（`brw pr` が実際に実行され片付けまで進んだ。許可の経路は PreToolUse） |
| `PreToolUse` の入力に `session_id`・`cwd`・`tool_input.command` が含まれ、`session_id` が後続の `UserPromptSubmit` の `session_id` と同じ | 両ホストのフックの入力 | **未確認**（`UserPromptSubmit` の入力は 9.1 の PoC で確認済みだが、`PreToolUse` の `session_id` が同じ値かは未観測）。9.8 で観測する |
| Codex でも `PreToolUse` が届き、同じ入力の項目を持つ | Codex 0.172.0 のフック | **未確認**（8.4 に PreToolUse の入力の観測はあるが、`session_id` の項目と `UserPromptSubmit` との一致は未観測。Codex は認証が無く、この環境では再観測できない可能性がある） |
| `PostToolUse` は片付けつきの `brw pr` では届かない（本体で開始） | Claude Code のフック | **実機の観測** 9.6 後半（Claude Code 2.1.329、3 回とも）。このため `PostToolUse` に頼らない設計にした |

### 9.8 の再観測の結果（2026-11-27、Claude Code 2.1.329）

- `PreToolUse` の入力に `session_id`・`cwd`・`tool_input.command` が含まれ、`session_id` は `UserPromptSubmit` と同じ値（6 回中 6 回）。→ 上の表の 2 番目の前提に**根拠が付いた（実機の観測、`tests/real-env/README.md` の 9.8）**。
- PreToolUse のメモで、片付け後の記録に `sessionId` が付いた（本体で開始・作業場所の中で開始とも 3/3）。ラッパーの記録で、ターン 2 の `UserPromptSubmit` に BRW が案内（`brw resume` を含む）を返した（6 回中 6 回）。モデルが案内の文言を答えに示した確認はできなかったが、`additionalContext` がモデルへ届くことは 9.1 の PoC（両ホスト）で確認済み。
- Codex の `PreToolUse` の入力: 実機の既存の観測（`tests/real-env/README.md` 8.4。`session_id` に thread_id が渡り、BRW の関連付けと一致した）を根拠とする。今回は認証が無く再観測していない。→ 3 番目の前提に根拠あり（8.4）。
- 作業場所の中で開始したセッションでは、削除後でも `UserPromptSubmit` が動き案内が返ることがあった（3 回中 3 回）。設計の「動かない」は保証ではなく**最低限の限界**とする（動くときは案内が届く。動かないときは `brw resume` の一覧と手順書）。
- 根拠の無い前提: なし（Codex の実機での案内の通し確認と、モデルが案内を答えに示した確認は未実施の観測として README に記録）。

## 追記: 本文置き場の移動（要件 3.9・3.11・3.12、2026-11-28）

brw-branch-gate による置き場の変更（`.worktree/`）に合わせ、本文置き場を `<本体>/.worktree/.brw/` に移す。確認日 2026-11-28。**根拠の無い前提: なし。**

| 前提 | 依存する外部の動作 | 根拠 |
|---|---|---|
| 本体で開始したセッションが `<本体>/.worktree/.brw/` へ Write ツールで確認なしに書ける（worktree で開始すると旧置き場と同じく拒否される） | Claude Code の書き込み権限 | **PoC** `poc/design_01.md`（2026-11-28、Claude Code 2.1.329） |

- 以前の `## 設計の確認`・`## タスク計画の確認` の `未通過` は、9.8 の再観測（上の追記）で根拠が揃い解消している。今回の更新と合わせて `通過` に更新した。
- 実機で確かめる前提は PoC で確認済み。実際の配置物での通し確認は 10.3（先頭に置くべき実機の前提は PoC で先に確認済みのため、群の末尾でよい）。
