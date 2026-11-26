# 実現性の記録: brw-enforcement

## 実機検証の要否

- 判定: 必要

外部の動作に依存する前提があるため「必要」とする（2026-11-26 の要件の更新時点）。いずれも根拠は未確認で、設計の承認の前に、一次資料か再実行できる PoC で確かめる。

| 前提 | 依存する外部の動作 | 根拠 | PoC の方針 |
|---|---|---|---|
| Stop フックが、Claude Code と Codex の両方で応答の終了を止められ、同じ終了の試みで 2 回目以降を止めない（`stop_hook_active`）と判別できる | Claude Code・Codex のフックの仕様 | 未確認（既存の実装と research.md の実機記録は、準備済みの作業の案内にだけ使っている） | 実機で、未 push の commit がある状態の終了を止め、2 回目で通ることを確かめる |
| 未コミットの変更・未追跡のファイル・未 push の commit（リモートに同名のブランチが無い新しいブランチを含む）を、git の出力から判定できる | git の `status`・`rev-list` の挙動 | 未確認 | 一時リポジトリで、新しいブランチ・先行・遅れ・分岐元と同じ内容の各状態を作り、判定を確かめる |
| 利用者の端末で実行する BRW のマージのコマンドが、対話端末の判定でエージェントの実行を拒み、PR の取り込み先を GitHub への照会で確定できる（失敗時はマージしない） | Claude Code・Codex の実行環境の標準入力の扱い、GitHub の PR 取得・マージ API | 未確認 | 既存の `publish --confirmed` の対話端末の判定を実機（Claude・Codex）で確かめ、実リポジトリで PR の取り込み先の取得とマージを確かめる |
| 直接のマージ（`gh pr merge`・API・MCP・自動マージ予約）を、取り込み先にかかわらず実行前に拒否できる | `gh` の引数、MCP の呼び出しの形 | 未確認（現行の一律拒否の実装は `operation-decision.mjs` にある） | 既存の判定の試験で各経路が拒否されることを確かめる |

## 設計の確認

- 判定: 通過

確認日 2026-11-26。根拠の無い前提: なし。

| 前提 | 根拠 |
|---|---|
| Stop が状態ファイル無しでも Claude Code・Codex で応答の終了を止められ、2 回目は `stop_hook_active:true` になる | **PoC** `poc/claude-stop-no-state.sh`（実行日 2026-11-26、Claude Code 2.1.329、一時リポジトリ、作業の記録なし）: 1 回目 `block`、2 回目 `stop_hook_active:true` で通った。Codex は `tests/real-env/README.md` の実機観測（2026-11-21、Codex 0.167。同じ形の block を受け入れ、2 回目は `stop_hook_active:true`）。Codex 0.172.0 での再観測は実装時の実環境試験で行う |
| 未コミット・未追跡・未 push・同名リモート無しを git の出力で判定できる | **PoC** `poc/git-states.sh`（2026-11-26、一時リポジトリ・bare remote）: 9 状態で期待どおり（無視ファイルは数えず、新規ブランチの commit は未 push として数える） |
| エージェントの実行は標準入出力が端末でない | **PoC**（2026-11-26）: Claude Code 2.1.329 の Bash と Codex 0.172.0 の `codex exec` で `process.stdin.isTTY`・`process.stdout.isTTY` がともに `undefined` |
| 疑似端末による迂回の可否（確認の限界） | **PoC**（2026-11-26）: `script -qc` 経由では `isTTY=true`。迂回できるため、設計は限界を明記し、フックの拒否で補強する（`design.md` の `pr-merge` の節） |
| マージ API が `sha`・`merge_method` を受け、405・409 を返す | **一次資料** GitHub REST API の記述（`github/rest-api-description` の `api.github.com.json`、`info.version` 1.1.4、取得 2026-11-26）の `pulls/merge` |
| PR の取り込み先（`base.ref`）を API で取得できる | **PoC**（2026-11-26、実 GitHub の読み取り）: `gh api repos/nekono-dev/branch-release-workflow/pulls/12` が `base.ref` を返した |
| 直接のマージ（`gh pr merge`・`--auto`）の拒否が両ホストで届く | **PoC** `tests/real-env/README.md`（2026-11-21、Claude・Codex）: どちらも deny |
| 宣言または利用者の指示から push 禁止を読む方法 | 外部の動作に依存しない（既存の `restrictionsFor` と `autoApprove.push: false` の扱い。利用者が 2026-11-23 に確認済み）。 |

実マージの実行（`PUT .../merge`）は、一次資料の確認にとどめ、実際の PR では行っていない（外部へ影響するため）。実装後に、使い捨てのリポジトリで実環境試験として確かめる（`design.md` の Testing Strategy）。

## タスク計画の確認

- 判定: 未通過
