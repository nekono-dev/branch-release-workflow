

# Requirements Document

## Project Description (Input)
# Brief: brw-pr-handoff

## Problem
- 作業ブランチの完了時、利用者が毎回「片付けて」と指示しないと、開発サーバ上の worktree・ローカルブランチ・作業記録が残る。
- PR の本文が作業ごとにばらつき、運用が統一されない。本文は人が読む文章なので、機械的な生成ではなく意味の伝わる文章にしたい。
- `gh pr create` を直接使うと、brw の計画・承認・状態記録・片付けの流れを通らない。
- 未コミットの変更（作業に無関係なものを含む）が残ると、片付けが止まる。

## Current State
- `brw publish` は PR 作成までを行えるが、「PR までやる」は任意の仕組みで、片付け（`brw finish`）は別手順（SKILL.md 3 章）。
- PR 本文は利用者に尋ねて `--body-file` で渡す形で、既定の雛形が無い。
- `gh pr create` を直接使うことを止める仕組みは無い。
- 宣言（`.branch-release-workflow.json`）に、片付けと PR 本文に関する設定は無い。

## Desired Outcome
- PR 作成が完了した時点で、worktree・ローカルブランチ・brw の作業状態が自動で片付く（リモートのブランチとプレビューは残す）。セッションは続けて次の `brw create` に進める。
- PR 本文は brw 同梱の既定雛形（日本語・節は「概要／変更内容／検証／作業外の変更」）を使う。リポジトリの `.github/PULL_REQUEST_TEMPLATE.md` があればそれを優先する。
- `brw pr-template` が、雛形と「各節の書き方の指示」を出力する。本文は最も単価の低いサブエージェントなどが、その指示に沿って書く（半自動）。
- 直接の `gh pr create`（`gh api` での PR 作成を含む）はフックが拒否し、ラッパー `brw pr` を案内する。`brw pr` は `brw publish` の薄い別名で、作業 ID を使わない利用でも自動で補う。
- 未コミットの変更は、publish の直前に「作業外の変更」として接頭辞付きの別コミットにまとめ、PR 本文の「作業外の変更」の節に自動で列挙する（ボーイスカウト・ルール）。

## Approach
`brw publish` を単一の入口として拡張する（計画・承認・状態記録の仕組みを再利用）。
1. publish の前段で、未コミットの変更を別コミット化する。
2. 本文の下書きを雛形から作る（`brw pr-template`）。
3. push → PR 作成。
4. 成功後、片付け（既存の finish と同等の安全確認）と作業状態の完了処理を実行し、リポジトリ本体のパスと次の `brw create` を案内する。

設定は宣言に 1 キー（例: `afterPublish.cleanup`）を追加する。既定は ON、`false` の明示だけが無効（`autoApprove` と同じ流儀）。導入時（setup）が既定値として書き込む。既存の導入先も次回から ON になる。

## Scope
- **In**:
  - PR 作成成功後の自動片付け（worktree・ローカルブランチ・作業状態）と、宣言の設定キー（既定 ON・オプトアウト）。
  - 片付けの中止条件: リモートに未 push の commit がある場合は片付けず、理由を報告する。
  - 未コミット変更の自動別コミット化（publish の前段）と、PR 本文「作業外の変更」の節への自動列挙。
  - PR 本文の既定雛形（日本語）、リポジトリ側の上書き（`.github/PULL_REQUEST_TEMPLATE.md` 優先）、言語を変える宣言キー（既定は日本語）。
  - `brw pr-template`（雛形と記入指示の出力）、`brw pr`（`brw publish` の別名）。
  - 直接の `gh pr create` を拒否し `brw pr` を案内するフックの判定（Claude Code のフック、Codex は手順書の `guard`）。
  - SKILL.md・references・setup の更新、自己テスト・評価ケースの追加。
- **Out**:
  - PR 本文の完全な自動生成（本文を書くのはエージェント）。
  - cc-sdd-bootstrap 側の「kiro-validate-impl 完了後に PR を作らせる」運用の追加（brw 側は cc-sdd と `.kiro` を一切知らない）。
  - リモートブランチの削除、プレビューの後始末、GitHub 側のマージや自動マージ。
  - 既存の保護・Ruleset の仕組みの変更。

## Boundary Candidates
- 宣言の拡張（片付け設定・PR 本文設定）と既定値の補完。
- `publish` の前段（別コミット化）と後段（片付け・案内）。
- PR 本文の雛形の解決（同梱 / リポジトリ側）と記入指示の出力。
- フックの判定（直接の PR 作成の拒否と案内）。
- 導入（setup）と利用者向け資料。

## Out of Boundary
- cc-sdd-bootstrap と kiro 系スキルの変更、`.kiro` 配下の参照。
- GitHub 側のリポジトリ設定（マージ後のブランチ自動削除など）。
- PR 本文の文章生成そのもの（サブエージェントの選定は呼び出し側の責務）。

## Upstream / Downstream
- **Upstream**: brw-enforcement（`publish`・作業 ID と計画・状態記録・フック判定）、既存の `finish` の取り込み済み判定、宣言の読み込みと既定値補完（`lib.mjs`）。
- **Downstream**: 将来の cc-sdd-bootstrap の PR 作成運用（`brw pr-template` と `brw pr` を呼ぶ側）。

## Existing Spec Touchpoints
- **Extends**: brw-enforcement（承認済みの仕様は書き換えず、`publish`・PR 作成・フック判定の入口を拡張する）。
- **Adjacent**: なし（cc-sdd-bootstrap は仕様を持たず、brw から直接参照しない）。

## Constraints
- Node.js 22 以上・標準モジュールのみ（`.mjs`）。
- 作業ブランチへの push は許可不要、保護ブランチへの push・merge は不可（利用者の運用ルール）。
- 判定や副作用を変えるときは、CLI とフックの両方を確認する。
- 片付けで消えるのは worktree とローカルブランチ、作業状態だけ。リモートのブランチとプレビューは残す。
- 片付け後はセッションの作業ディレクトリが消えるため、リポジトリ本体のパスと次の `brw create` を標準出力で案内する（`cd` の強制はしない）。

## 設計フェーズで決めること（未決）
- 宣言の正式なキー名と構造（`afterPublish.cleanup`・`pullRequest.language` など）。
- 別コミットの接頭辞・メッセージ形式と、未追跡ファイル（生成物・秘密情報）の扱い。
- 既存 PR を再利用した場合の片付け（push・PR が済んでいれば片付ける方針で進めるか）。
- `brw pr` が作業 ID なしで呼ばれたときの補い方。
- 作業状態の「完了」と片付けの順序、片付け失敗時の再試行。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
