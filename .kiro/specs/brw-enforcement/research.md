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

---

## ギャップ分析: 要件 2 の追加分（2.9〜2.16）（2026-11-23）

対象: 2026-11-23 に追加した受け入れ条件 2.9〜2.16（区切りごとの commit・push と、応答終了時の残りの検出）。既存の要件 1〜6 は実装・検証済み（上の分析）なので、差分だけを扱う。根拠は `scripts/agent-hooks.mjs`・`scripts/brw.mjs`・`scripts/lib.mjs`・`scripts/publish.mjs`、`SKILL.md`、cc-sdd の `kiro-impl`、`tests/agent-hooks-session.mjs` の走査である。

### 要約

- 応答終了時の検出（2.12・2.13）は、既存の Stop 処理（`stopGuidance`）に「作業ブランチの残り」の検出を足せば実現できる。ただし現在の Stop は「当該セッションに結び付いた、準備済みで未公開の作業」だけを見ており、ブランチと作業ツリーの状態は見ない。
- 区切りの commit・push（2.9・2.10）は、cc-sdd の `kiro-*` スキルが担う箇所で、**このリポジトリからは書き換えられない**（セッション開始のたびに入れ直され、`kiro-` で始まる独自スキルも置けない）。実現できる手段は、BRW の SKILL.md・プロジェクトの CLAUDE.md の指示と、Stop フックによる後追いの検出に限られる。
- **commit は BRW が確認を省かない**。確認省略（`autoApprovable`）の対象は push と PR 作成だけで、`git commit` は判定を通す（拒否も許可も返さない）。許可を求めずに commit できるかは、現状ではハーネス側の権限設定に依存する。
- 「自律一括実施」では、1 回の応答が長く続くため、Stop の検出だけでは途中で中断したときの未 push を防げない（Stop は応答の終了時にしか動かない）。

### 要件と既存資産の対応

| 要件 | 既存資産 | ギャップ |
|---|---|---|
| 2.9 spec の各フェーズ生成後に commit・push | `kiro-spec-*` は commit しない（cc-sdd 提供・変更不可）。`kiro-impl` は 1 タスクごとに commit するが push はしない | **Constraint**: 手順は指示（SKILL.md・CLAUDE.md）でしか足せない。**Missing**: 指示の記述と、守られたかの検出 |
| 2.10 実装 1 タスク完了ごとに commit・push | 同上（`kiro-impl` の「e) Commit」はパス指定のステージと commit まで） | 同上。push は指示のみ |
| 2.9・2.10 「許可を求めずに」commit | `autoApprovable` は push・PR のみ（`safePush`・`safePullRequest`）。commit は `judgeBash` が PASS を返すだけ | **Missing**: 作業ブランチでの `git add`・`git commit` を確認省略する経路。**Unknown**: Claude・Codex それぞれで確認省略を返す応答（Claude は PreToolUse の allow、Codex は PermissionRequest の allow）が commit に使えるか |
| 2.9・2.10 「許可を求めずに」push | 2.1 と既存の `autoApprovable` で対応済み | なし（`autoApprove.push` が明示的に false なら確認が残る。2.14 を参照） |
| 2.11 リモートだけで再開・引き継ぎ | `brw resume`（リモートから取得し直して再開）が実装済み。`brw finish` は未 push の commit を保護する | **Missing**: 「未 push・未 commit が無い」ことを再開の前提として確かめ、報告する経路（検出は 2.12 と共通） |
| 2.12 応答終了時の残りの検出 | `stopGuidance`（準備済み作業のみ）、`stop_hook_active` による再入防止、`git()`・`status --porcelain`・`rev-list --count` の既存の使い方（`brw.mjs`・`publish.mjs`） | **Missing**: ブランチ単位の検出（作業ブランチか、未 commit か、未 push か）。作業ブランチの判定には `classifyBranch`・`judgeBranch`（`lib.mjs`）を再利用できる |
| 2.13 調査・確認のみなら止めない | 同上。`stopGuidance` は読み取り専用で状態を書かない | 変更が無い判定は `status --porcelain` と `rev-list` で足りる。**Research Needed**: 作業ツリーに無関係な未追跡ファイルがある場合の扱い |
| 2.14 push 禁止の尊重 | `restrictionsOf(w)`・`noPush`（`brw work restrict`）が作業単位で実装済み。`pendingOf` が使用 | **Unknown**: 「宣言が push を禁じる」運用に対応する宣言の項目が現状ない（`autoApprove.push=false` は確認が残るだけで禁止ではない）。**Missing**: セッションに結び付いた作業が無いブランチでの制限の解決 |
| 2.15 失敗時の報告 | 公開（`brw publish`）の失敗報告は実装済み（2.7）。区切りの commit・push は `brw` を経由しない素の git | **Constraint**: 素の git の失敗はエージェントが報告する。フックが検出できるのは「残っている」ことだけ |
| 2.16 保護ブランチ等へは適用しない | 要件 1 の判定（`judgeBranch`）が拒否する | Stop の検出は作業ブランチに限る。保護ブランチ上の変更は検出対象にしない（案内すると保護ブランチへの commit・push を促してしまう） |

### 実装方針の選択肢

#### Option A: 既存の Stop 処理と SKILL.md を拡張する（指示＋検出）

- `stopGuidance` に、cwd が宣言上の作業ブランチのとき、`git status --porcelain` が空でない、またはリモート追跡ブランチより先行している場合に block する分岐を足す。`stop_hook_active` の再入防止と読み取り専用の性質は保つ。
- SKILL.md の「してよい」を「区切りごとに行う」に改め、spec・実装の区切りを列挙する。プロジェクトの CLAUDE.md にも同じ指示を書く。
- 長所: 変更が小さく、既存の契約テスト（`tests/agent-hooks-session.mjs`）の形で検証できる。両ハーネスは同じ Stop の応答形式を使う。
- 短所: 区切りでの commit・push は指示頼みで、長い応答の途中の中断は防げない。commit の確認省略は別に要る。

#### Option B: 区切りの commit・push を BRW のコマンドにする（`brw checkpoint`）

- 作業ブランチの変更を、パス指定ではなく作業単位で commit し push するサブコマンドを足し、スキルが区切りで呼ぶ。失敗の報告（2.15）と no-push の尊重（2.14）を 1 か所にまとめられる。
- 長所: 2.14・2.15 を機械的に満たせる。確認省略は、既存の公開計画の仕組みに乗せやすい。
- 短所: `kiro-impl` の commit 手順（選択的ステージ・メッセージ形式）と二重になる。cc-sdd 側の手順を変えられないため、呼ぶのは指示頼みのまま。ステージの対象選びを誤ると、無関係なファイルを commit するおそれがある。

#### Option C: PostToolUse で commit 成功を検知して push を促す・実行する（ハイブリッド）

- A に加え、PostToolUse（既に `recordWorkStart` で使用）で作業ブランチへの `git commit` 成功を検知し、push を案内する（または確認省略の範囲で push を実行する）。
- 長所: 応答の途中でも commit 直後に push でき、「自律一括実施」の途中中断に強い。`kiro-impl` の commit をそのまま契機にできる。
- 短所: フックが副作用（push）を起こす設計になり、現在の「フックは判定と案内だけ」という方針から外れる。案内だけにする場合は、エージェントが無視すると効果がない。PostToolUse の応答で追加の文脈を返せるかが、ホストごとに未確認。

### 工数とリスク

- **工数: M（3〜7 日）**。Stop の拡張とテストは小さい（S）。commit の確認省略と、Option C を採る場合の PostToolUse の扱いで M に伸びる。
- **リスク: Medium**。既存の Stop の契約（準備済み作業の案内）と衝突しない設計が要る。無関係な未追跡ファイルによる誤検出で、応答が止まり続けるリスクは `stop_hook_active` で 1 回に抑えられるが、利用者体験が悪い。

### 設計へ持ち越す事項（Research Needed）

1. **commit の確認省略**: 作業ブランチでの `git add <パス>`・`git commit` を `autoApprovable` の対象にするか。対象にする場合の安全条件（コミットメッセージのシェル展開、`--amend`・`--no-verify` の扱い、ステージ対象）。Claude・Codex の確認省略の応答が commit に使えるかを実機で観測する。
2. **「宣言が push を禁じる」の定義**: 宣言に対応する項目が無い。`autoApprove.push=false` を「確認が残る」と扱い、Stop は未 push を案内しない、と決めるのが自然だが、要件 2.14 の文言と合わせて確認する。
3. **未 push の判定**: リモート追跡ブランチが無い新規ブランチ（初回 push 前）は「先行」ではなく「未 push」とみなす。fetch していない追跡ブランチの古さの扱い。ネットワークに依存しない判定にする。
4. **作業ツリーの誤検出**: 無関係な未追跡ファイル、ignore されていない生成物、別の作業の変更が残る共有の作業ツリーをどう扱うか（追跡中の変更だけを見る、`.kiro/` や変更のあるパスに限る、など）。
5. **Stop の作業との関係**: セッションに結び付いた作業が無くても検出する（要件 2.12 は「作業ブランチ」単位）。既存の「準備済みで未公開」の案内と、新しい「未 commit・未 push」の案内の優先順位と文面の統合。
6. **PostToolUse の応答**: Option C を採る場合、Claude・Codex の PostToolUse が追加の文脈を返せるか、返した文脈がエージェントに届くかの実機確認。
7. **自律一括実施の実機検証**: 長い応答（複数タスクの連続実装）で、区切りごとの push が実際に行われ、中断後に別のエージェントが `brw resume` で再開できることの確認。

### 他の spec との接点

- `harness-plugin-unification`（導入の統一）と、`agent-hooks.mjs`（Stop）・`hook-diagnose.mjs`・`setup-cli.mjs`・`SKILL.md`・`tests/agent-hooks-session.mjs` を共有する。Stop のイベントの登録は、両ハーネスのフック定義の対応表（harness-plugin-unification 要件 3-3）に含まれる。
- brw-enforcement の既存の設計にある Codex のフック導入（`installCodexHooks`・worktree の有効化）は、harness-plugin-unification で置き換わる。設計の更新では、Codex への配り方の記述を harness-plugin-unification に委ね、重複して持たない。

### 次の手順

- `/kiro-spec-design brw-enforcement` で設計を更新する。上の Research Needed 1・2 は設計の冒頭で決める（利用者の確認が要る可能性がある）。

---

## 設計時の統合（要件 2.9〜2.16）（2026-11-23）

ギャップ分析（上）の Option A（既存の Stop 処理と SKILL.md を拡張する）に、commit の確認省略を加えた形を採った。

- **一般化**: 「作業ブランチに残った変更」という 1 つの概念（未コミットの変更と未 push の commit）で、要件 2.11（リモートだけで再開）・2.12（終了時の検出）・2.13（調査のみは止めない）・2.14（push 禁止）をまとめた。作業状態（セッションに結び付いた作業）に依存せず、Git の状態だけから導く（`work-remainder.mjs`）。
- **Build vs Adopt**: 区切りの commit・push の実行手段は新設しない（Option B の `brw checkpoint` は、`kiro-impl` の commit 手順と二重になり、cc-sdd 側を変えられないため見送り）。`git add`・`git commit` の確認省略は、既存の `safePush` と同じ作法（限定した引数、複合コマンドは全区間が条件を満たすとき）で足す。
- **簡素化**: フックによる push の実行と、commit 直後の push の案内（Option C の PostToolUse）は採らない。フックは判定と案内だけを行う方針を保ち、PostToolUse が追加の文脈を返せるかの実機確認は、残余リスクとともに設計の Non-Goals に残した。状態ファイルは増やさず、Stop のたびに Git から導く。
- **ギャップ分析の Research Needed への回答**: (1) commit の確認省略は `autoApprove.commit`（未指定は有効）と限定した引数で行う。(2) 宣言に push 禁止の専用項目は無いため、`autoApprove.push: false` を「宣言が push を禁じる」と扱う（要件 2.14 の解釈。検証設計の確認事項）。(3) 未 push は `git rev-list --count HEAD --not --remotes` で、ネットワークなしに判定する。(4) 無関係な未追跡ファイルは、案内を 1 回に限る（`stop_hook_active`）ことと、パスの提示で扱う。(5) セッションに結び付いた作業が無くても検出し、公開の案内と 1 つの block にまとめる。(6) PostToolUse の追加文脈は未確認のまま持ち越す。(7) 長い応答での区切りごとの push は、実環境の検証項目に入れた。

### 持ち越し

- `autoApprove.push: false` を「宣言が push を禁じる」と読む解釈の確認（利用者）。
- クォートした heredoc のメッセージの受け入れ範囲（実装時に、Claude の標準的な commit 手順で通ることを確かめる）。
- Claude・Codex の PostToolUse が追加の文脈を返せるか（返せれば、commit 直後の push の案内を別途検討できる）。

---

## Codex での追加検証（2026-11-23、設計の再生成前）

harness-plugin-unification の research.md の同名の節に、検証の条件と全項目の結果を記録した。本 spec に関わる結果だけを再掲する。

- **commit の確認省略（2.9, 2.10）**: 対話相当（承認方針 `on-request`）では、`git add … && git commit …` はサンドボックスの失敗のあと `PermissionRequest` フックに全コマンド文字列で届き、`allow` で承認なしに実行された。設計の方式（Codex は `PermissionRequest` の許可で返す）は成立する。
- **非対話（`codex exec`）の制約**: 承認方針が常に `never` で `PermissionRequest` は発生せず、`workspace-write` では `.git` が読み取り専用のため commit・push は失敗する。BRW のフックでは解決できず、実行側の書き込み許可（`--add-dir <.git>`、linked worktree では `<.git>/worktrees/<名>` も）か、外部のサンドボックスが要る。診断の `limits` と導入手順に明記する。
- **Stop の案内（2.12〜2.15）**: `reason` はモデルに `hook_prompt` として届き、再入では `stop_hook_active: true` になる。案内の対象がエージェント自身の作業で生じた変更のときは commit・push が実行された。無関係な既存の変更のときは「依頼の範囲外」として実行されなかった。案内文に、この作業で生じた変更かどうかの判断と、そうでない場合の報告を含める。
- **PostToolUse の追加文脈**: Codex では `additionalContext` がモデルに届く（Claude は未確認）。commit 直後の push の案内（Non-Goals）の実現可能性の材料になるが、利用者の判断（残余リスクの許容。中断の契機はトークンの使い切りと作業の停止）により、本 spec では採らない。
- **中断の契機と Stop の関係**: トークンの使い切りと利用者による停止では、Stop が呼ばれない場合がある（Codex には別に `interrupt` イベントがある）。この残余リスクは許容され、取りこぼしは区切りごとの push で最小化する。それ以外の契機での中断は、利用者の依頼（「commit して」「push して」）で扱う。

### 設計の検証で訂正した点（2026-11-23）

- 設計では commit の確認省略を `brw.mjs` の `autoApprovable`（`safePush` と同じ作法）に足す案にしていたが、フックの実際の経路は `agent-hooks.mjs` の `judgeBash` → `operation-decision.mjs` の `evaluateAll`（`eligibleForApproval`）→ `plainOperation` だった（`autoApprovable` は手動実行用の旧経路）。設計を、`evalCommit`・`operation-policy.mjs` の flags・`plainOperation` の複合コマンドへの対応に改めた。
- `plainOperation` は変更操作がちょうど 1 つの `git`・`gh` だけを許す。`git add` は読み取り扱いのため、`git add … && git commit …` を含む複合は現状では確認省略されない。この点も設計に含めた。
- 既存の `stopGuidance` は、セッション ID や状態ファイルが無いと先頭で `null` を返す。残りの案内はこれと独立に評価する構造に改めた。
