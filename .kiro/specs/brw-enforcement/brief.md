# Brief — brw-enforcement

## 課題（Problem）

BRW を導入したリポジトリで、Claude Code と Codex のどちらを使っても、開発ブランチの作成からレビュー依頼まで同じ手順で進めたい。分岐元の履歴は PR ごとの squash コミットで揃え、関連する開発ブランチ間の取り込みは必要に応じて進められるようにしたい。

## 現状（Current State）

- Claude Code には Bash の `git commit` と `git push` を判定する `PreToolUse` フックがある。宣言の `autoApprove` を有効にすると、条件に合う push と PR 作成は確認を省ける。開発ブランチの作成、作業完了時の PR 作成、マージの判断は主にスキルの手順に依存する。
- Codex のインストーラーはスキルをリンクする。`brw guard` を事前に呼ぶ手順はスキルにある。共通 CLI には Codex のフックを登録する仕組みと、GitHub Ruleset の設定を照合する仕組みが必要になる。
- `brw create` は分岐元を記録し、`brw finish` はそれを取り込みの判定に使う。現行の PR 作成の自動許可は宣言の `baseBranch` を参照するため、`create --base` を使う場合は判定を揃える必要がある。

## 期待する結果（Desired Outcome）

| 操作 | 既定の動作 |
|---|---|
| 開発ブランチの作成・作業の再開 | 両エージェントで `brw create` / `brw resume` を通す。保護対象や宣言外での直接 commit・push は拒否する。 |
| 開発ブランチへの通常の push | リポジトリと更新先が確定し、BRW の条件を満たす操作は追加確認なしで行う。途中の push も許可する。 |
| 作業完了時 | その作業の変更を push する。保護対象の分岐元への取り込みでは PR を追加確認なしで作成する。同じリポジトリで head と base が一致するオープンな PR があれば再利用し、URL を報告する。 |
| 開発ブランチから別の開発ブランチへのマージ | 依存する変更の取り込みなど、作業に必要な場合は追加確認なしで実行できる。取り込み元と取り込み先が、どちらも宣言上の開発ブランチであることを検証し、PR を作らずにローカルで取り込む。 |
| 開発ブランチから分岐元・保護ブランチ・その他のブランチへのマージ | 保護対象の分岐元ではエージェントは PR の作成または再利用まで進め、利用者が GitHub 上で squash マージする。その他の宣言外のブランチへの変更は拒否する。 |
| GitHub 上の分岐元の更新（既定 off の任意の追加事項） | 管理者が導入時に求めたときだけ、有効なブランチ Ruleset で PR を必須とし、マージ方式を squash に限定する。通常の作業権限では直接 push や非 squash のマージを拒否する。適用後の更新から強制する。 |

「分岐元」は、`baseBranch` などリポジトリで恒常的な分岐元として宣言したブランチを指す。依存関係のため一時的に `--base` に指定した開発ブランチには、分岐元用 Ruleset を適用しない。恒常的な分岐元・保護対象と開発ブランチの指定が重なる場合は、保護を優先し、導入時に重複を案内する。

## 採用方針（Approach）

両エージェントのフックから BRW の共通判定を呼び、分岐元への反映は GitHub のブランチ Ruleset でも強制する。当初は「エージェントフック＋GitHub Ruleset」案を採ったが、2026-11-21 に利用者が方針を改め、GitHub 側の強制は既定 off の導入の追加事項とした（本分はエージェントに作業ブランチを機械的に切らせること。Ruleset は管理者が求めたときだけ、エージェントが `brw setup --ruleset on` で設定する。求めがなければ GitHub への書き込み・認証要求は行わない）。フックで開発中の操作や完了処理を制御し、GitHub がどのクライアントからの更新にも分岐元のルールを適用する。

- Claude Code の既存フックを拡張し、Codex は `PreToolUse` で拒否する。通常の操作で Codex が許可を要求する場合は、対応する実行環境の `PermissionRequest` で対象を確認して許可する。承認応答は各エージェントの仕様に合わせる。 [Claude Code Hooks](https://code.claude.com/docs/en/hooks#pretooluse) · [Codex Hooks](https://learn.chatgpt.com/docs/hooks#permissionrequest)
- 作業完了時は、BRW が実行する push と PR 作成を再試行可能にし、終了時フックで実行漏れを検出する。確認・調査の返答、検証に失敗して途中で止まった作業、途中の push でもエージェントは応答を終了できるため、作業完了は BRW が確認できる状態で表す。完了状態を記録する条件は設計で詰める。 [Claude Code の Stop](https://code.claude.com/docs/en/hooks#stop) · [Codex の Stop](https://learn.chatgpt.com/docs/hooks#stop)
- Ruleset の導入と検査は、宣言にある恒常的な分岐元を対象にする。既存ルールとの競合、GitHub リポジトリでの squash の有効化、エージェントが使用するアカウントやアプリのバイパス権限を検査する。設定の適用は権限のある管理者の導入手順に含める。 [GitHub Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging)

## スコープ（Scope）

- **対象**　共通宣言に基づくブランチ・worktree 操作の判定、両エージェント向けのフック導入と動作確認、通常の push・作業完了時の PR 作成、マージの許可条件、GitHub Ruleset の導入と整合検査、既存の BRW 利用リポジトリの移行。
- **対象外**　既存コミット履歴の書き換え、全ブランチへの一律の squash 制限、プレビューや本番配備の変更、組織向けのマネージド MCP サービスの配備。

## 責務の境界（Boundary Candidates）

- **BRW の判定・操作**　宣言と実際のリポジトリ・ref を照合する。確認省略はリポジトリと操作対象を特定できる場合に限る。強制 push、削除、送り先が不明な操作、自動マージの予約には別途判定を行う。開発ブランチ間は BRW がローカルで取り込み、保護対象へのマージは利用者が GitHub 上で行う。
- **エージェントのフック**　ライフサイクルに応じて判定を呼び出し、対応する経路で拒否・許可・終了時の継続を返す。シェル、GitHub API、MCP の書き込み経路を確認し、エージェントからの GitHub マージ・自動マージ予約は対応する経路で拒否する。未対応の経路やフックの未導入は導入時の検査で報告する。 [Codex のフック対象](https://learn.chatgpt.com/docs/hooks#tool-coverage) · [GitHub の PR マージ API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
- **GitHub の強制（既定 off の任意の追加事項）**　管理者が求めたときだけ、対象 ref に PR 必須・squash 限定の有効な Ruleset を適用する。リポジトリのレビュー・必須チェック・マージ権限と併用する。利用者の GitHub 上でのマージは GitHub の権限と取り込み条件に従う。

## 対象外の責務（Out of Boundary）

- BRW の既存プレビュープロバイダーと配備設定が、配備先および CI のトリガーを管理する。
- 各エージェントの実行環境がフックの信頼設定、GitHub の認証情報、ネットワークへのアクセス権限を管理する。

## 依存関係（Upstream / Downstream）

- **上流**　`.branch-release-workflow.json` と旧パスの互換性、BRW の既存 CLI、Claude Code / Codex のフック仕様、Git と GitHub CLI、GitHub のブランチ Ruleset。
- **下流**　BRW 導入先の新規 clone・worktree、対応するローカル・CI セッション、作業ブランチからの PR レビューと分岐元への squash 取り込み。

## 既存仕様との接点（Existing Spec Touchpoints）

- **継承**　旧 `specs/branch-guard` にあったブランチ判定・作成・再開・保護規則の優先・確認省略を土台とする。現行の `.kiro/specs/` には更新対象となる仕様がなく、Claude Code と Codex の共通強制を新規仕様にする。
- **隣接**　プレビュー・配備は引き続き宣言済みの CI トリガーに従う。PR 作成と既存の `finish` による片付けの関係は、未 push の変更や続行予定の作業を失わないよう検証する。

## 制約（Constraints）

- 確認省略の新しい既定は導入・移行手順で明示し、宣言で指定されたオプトアウトや利用者の「push しない」「PR を作らない」指示を優先する。認証・ネットワーク・実行環境の権限で処理できない場合は、完了した操作と失敗した操作を報告し、再実行で PR が重複しないようにする。
- ローカル Codex では未管理フックの信頼登録が必要。Work Cloud のクラウドオーケストレーションにはリポジトリのコマンドフックを適用できず、対応する管理対象環境の Global MCP フックが必要。エージェント側の強制は導入先の実行環境で確認し、未対応環境にも GitHub 側の分岐元保護は適用する。 [Codex のフックの信頼とクラウド対応](https://learn.chatgpt.com/docs/hooks#hooks-with-cloud-orchestration)
- Ruleset の有効化には対応する GitHub プランと設定権限が必要。設定できないリポジトリは、分岐元のサーバー側保護の導入が未完了と分かるようにする。 [Ruleset の利用条件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#who-can-use-this-feature)
