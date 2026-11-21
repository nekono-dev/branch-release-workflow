# 調査と設計判断

## Summary

- **機能**　`brw-enforcement`
- **調査種別**　既存 CLI の拡張を伴う複雑な統合。フック契約と GitHub API を対象にフル調査を行った。
- **主な結果**　ブランチ分類と操作判定はホストをまたいで共用できる。Codex の拒否と確認省略には別のイベントが必要。GitHub の分岐元保護には、導入時の選択、認証情報の書き込み権限、設定の実効性をそれぞれ確認する必要がある。

## Research Log

### CLI と宣言

`scripts/brw.mjs` の `judgeCommand` は commit と push を、`autoApprovable` は制限付きの push・PR 作成を扱う。`scripts/lib.mjs` が宣言の旧パスを扱い、`brw create` は個別の分岐元を Git 設定に記録する。ステアリングに従い、命名検査、既存の CLI、CLI の単体実行、登録済み宣言による確認省略を引き継ぐ。変更を伴う操作の判定結果を両ホストで共用できる形にする。

### ホストのイベントと信頼設定

Claude Code の既存フックは `PreToolUse` で拒否や許可を返せる。Codex では同イベントの `ask` が禁止に使えず、確認省略は既に発生している `PermissionRequest` への許可応答で行う。プロジェクトフックは信頼登録を要し、Work Cloud のクラウドオーケストレーションには管理者が設定する Global MCP フックが必要。コマンドはプロジェクトの CLI を再利用し、実稼働する操作経路は各ホストで確認する。 [Claude Code Hooks](https://code.claude.com/docs/en/hooks) · [Codex Hooks](https://learn.chatgpt.com/docs/hooks)

両ホストの `Stop` は応答が終わるときのイベント。Codex の継続は新たなプロンプトとして処理される。完了判定には BRW の作業状態を使い、終了時フックは記録された作業の案内に使う。GitHub の PR マージ API は head SHA を指定できるが、base を条件にできない。利用者の決定により、保護対象への反映はエージェントが PR を用意し、利用者が GitHub 上で squash マージする。開発間の取り込みはローカルマージを使う。 [Codex Stop](https://learn.chatgpt.com/docs/hooks#stop) · [Claude Code Stop](https://code.claude.com/docs/en/hooks#stop) · [GitHub PR マージ API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

### GitHub のルールと設定権限

ブランチ Ruleset は正確な ref を対象にでき、PR の許可方式を `squash` のみにできる。詳細 API は書き込みアクセスを持つ呼び出し元にだけバイパス設定を返す。実効ルール API と詳細 API を組み合わせて、適用対象、競合、バイパスを確認する。既存の組織ルールやブランチ保護は GitHub が併用し、リポジトリで squash が無効なら取り込みが止まる。 [Ruleset API](https://docs.github.com/en/rest/repos/rules) · [ルールの重ね合わせ](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering) · [マージ方式](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github)

`gh auth status` で分かるのは認証状態。管理ロール単独では fine-grained token の書き込み権限を確認できない。Ruleset 作成の fine-grained 権限はリポジトリの Administration write。利用可能なら同一認証情報による既存 Ruleset の書き込みアクセスなどを読み取りで確認する。適切な既存 Ruleset がない初回導入では、通常の GitHub CLI OAuth・classic token のリポジトリ管理権限と `repo` スコープを使う経路を用意する。`X-Accepted-GitHub-Permissions` は API が要求する権限を示すため、トークンへの付与を証明する材料から除く。既存ルールのない fine-grained token やプラン情報が見えない非公開リポジトリには、検査不能として権限の分かる認証方法を案内する。 [GitHub CLI 認証](https://cli.github.com/manual/gh_auth_status) · [OAuth スコープ](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) · [fine-grained token 権限](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) · [Ruleset の利用条件](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#who-can-use-this-feature)

## Architecture Pattern Evaluation

| 案 | 評価 |
|---|---|
| ホストごとに独立した判定 | 導入先を個別に調整できる。ポリシーの重複と挙動の差分を保守する必要がある。 |
| 既存 CLI を拡張し、共有判定とホストの応答変換を使う | 既存の宣言・ブランチ操作を使える。ホストごとの応答差や対象経路は変換側で扱える。採用。 |
| GitHub だけで強制する | 分岐元への反映を制御できる。ローカルブランチ作成、通常 push の確認省略、作業完了を起点とする公開には別の手段が要る。 |

## Design Decisions

- **共通判定**　ブランチ作成・復帰や Git/GitHub の操作を種類と参照先で表す。既存の宣言検証を採用し、フック固有の応答変換だけを追加する。一般目的のシェル実行環境やツール基盤は導入しない。
- **完了公開**　明示的な BRW 完了ステップを push と PR 作成の入口にする。Git と GitHub の既存機能を呼び出し、Stop は公開漏れの検出を担う。作業途中の push と完了時の公開で判定・宛先を共用できる。
- **Ruleset 導入**　管理者が指定した範囲と実際の資格情報を確認し、GitHub 標準の ref 単位の Ruleset を採用する。設定を変更する権限が読み取りで確認できない場合は、適用せずに別の認証経路を案内する。GitHub の更新 API は置換前の版を条件にできないため、既存ルールを再利用するか、競合しないルールを追加する。事前検査目的の試験的な設定変更や独自の GitHub アプリは採用しない。
- **状態の最小化**　リポジトリ共通の導入選択と Ruleset ID、作業単位の公開進捗だけを保存する。GitHub の実効ルール、リモート ref、オープンな PR は照会して判定する。

## Risks & Mitigations

- ホストのフック対象外や未信頼では操作前に止められる範囲が変わる。実環境で動作を測り、導入診断で制限を明示する。選択済みの GitHub 側の分岐元保護は独立して検査する。
- API では読み取り専用の fine-grained token に管理ロールが見える場合や、組織設定がトークンの利用を阻む場合がある。書き込みを示す根拠を分けて検査し、確認不能や適用失敗を成功と記録しない。
- 書き込み応答が通信途中で失われる場合は、同一の PR と Ruleset の存在を再取得する。外部側での競合が見つかった場合は、実効状態を報告する。
- 保護対象へ公開する際は、既存または作成した PR の head と base を照合して、利用者が GitHub 上で確認できる URL を渡す。エージェントはマージ API を呼ばない。

## References

- [GitHub CLI API 呼び出し](https://cli.github.com/manual/gh_api)
- [GitHub のルール API](https://docs.github.com/en/rest/repos/rules)
- [GitHub のリポジトリ API](https://docs.github.com/en/rest/repos/repos)
- [Claude Code のフック契約](https://code.claude.com/docs/en/hooks)
- [Codex のフック契約](https://learn.chatgpt.com/docs/hooks)

---

## 実装後のギャップ分析（2026-11-21）

対象: `brw-enforcement`（引数なしのため、`.kiro/specs/` にある唯一の仕様を対象にした）。全 29 サブタスクが完了し `kiro-validate-impl` は GO のため、「要件に対して実装・実環境検証で残っている差」を整理する。根拠は最終検証の報告、tasks.md の Implementation Notes（8.3〜8.5）、実機の観測であり、今回コードを走査し直してはいない。

### 要約

- 要件 34 節はすべて実装・テスト済み。実機（Claude Code、Codex 0.167、実 GitHub）で観測できたものと、擬似環境でしか確かめられていないものが分かれる。
- 実機で見つかった設計前提の誤りは 2 件で、修正済み（`tool_response` の形、Codex linked worktree は `.codex/` があるときだけ親の hooks.json を読む）。
- 残る差は「実環境で未観測」と「設計上の限界」に集約される。実装の欠落ではない。

### 実環境で未観測（Research Needed）

| 項目 | 要件 | 状況 | 確かめる方法 |
|---|---|---|---|
| 管理者以外の資格情報での拒否・squash 成功・作業経路 ok | 5.4, 5.7, 5.8 | 資格情報が管理者 1 つのみで未実測 | 書き込み権限のみの fine-grained token か App を用意し `BRW_REAL_ENV_WORK_TOKEN` で 8.5 を再実行 |
| rebase・merge commit の拒否が Ruleset 単独で効くか | 5.x | リポジトリ設定（`allow_*_merge`＝false）の 405 と重なる | 検証用リポジトリで設定を許可にして再測定（設定変更が必要なため利用者判断） |
| 必須チェック・必須レビューを含む Ruleset の squash | 5.x | 未検証 | 検証用の構成で測定 |
| Codex PermissionRequest の実到達 | 2.x, 6.1 | `codex exec` では発生せず | 対話の Codex で確認 |
| MCP matcher `mcp__.*` | 2.x | 未観測 | MCP サーバーを接続した実セッションで確認 |
| `/hooks` での信頼の実承認 | 6.x | 呼び出しごとの回避フラグで代替 | 利用者が対話で承認して確認（自動化不可） |
| クラウドの管理対象フック | 6.4 | 診断は unsupported を表示するのみ | クラウド環境での確認 |

### 設計上の限界（診断の `limits` として表示）

入れ子のシェル（`bash -c` 等）、外部スクリプト内の git、origin 自体の書き換え、Codex PreToolUse は ask を返せない、エージェントによる isTTY の偽装（pty・`NODE_OPTIONS`）など。いずれも導入診断で利用者に示す方針で、GitHub 側の Ruleset が最終防御になる。

### 実装方針の評価（振り返り）

- 採用した「既存 CLI を拡張し、共有判定とホストの応答変換を使う」は、実機でも Claude・Codex の差を応答変換層だけで吸収できた（依存方向の違反なし）。
- 実機の差は `tool_response` の形と worktree の読み込み規則に出た。ホスト契約は fixture だけでは確定できず、実機観測が必要だった。今後ホストの版が上がったら `tests/real-env/host-events.mjs` で再確認する。

### 次の手順

- 設計に戻す変更は不要。上の未観測項目は、必要に応じて追加の実環境検証として行う（管理者以外の資格情報の用意が最も効果が大きい）。
- `main` への取り込みは、利用者が GitHub 上で PR を squash マージする。
