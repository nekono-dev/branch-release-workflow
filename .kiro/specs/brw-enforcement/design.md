# BRW の操作強制と GitHub Ruleset の技術設計

## Overview

BRW 導入リポジトリの Claude Code と Codex の操作を、同じブランチ分類と許可条件で判定する。開発中の push、作業完了時の PR 作成、依存作業の取り込みを BRW で進められるようにする。導入担当者が選択したリポジトリでは、GitHub のブランチ Ruleset で恒常的な分岐元への取り込みを制御する。作業ブランチの変更は、spec の各フェーズの生成後と実装の 1 タスク完了ごとに、許可を求めずに commit・push し、応答を終えるときに残りがあれば止めて案内する（リモートだけで再開・引き継ぎできる状態を保つ）。

### Goals

- 対応する両エージェントで禁止操作を実行前に止め、条件を満たす通常操作の追加確認を省く。
- 作業完了時の push と PR 作成を復旧できる一連の処理にする。
- Ruleset の採否確認、書き込み権限の検査、適用、実効設定の確認を一つの導入操作で行う。
- 作業ブランチの変更を区切りごとに commit・push し、途中で終了してもリモートだけで再開できる状態を保つ。応答の終了時に、作業ブランチの未コミットの変更と未 push の commit を検出して案内する。

### Non-Goals

- 既存履歴の書き換え、GitHub 全体へのマージ方式の一律変更、組織向け Global MCP サービスの配備。
- フックによる push の実行（フックは判定と案内だけを行い、副作用を起こさない）。commit 直後の push の案内（PostToolUse）も採らない。Codex では `additionalContext` がモデルに届くことを実機で確認したが（Claude は未確認）、利用者が残余リスクを許容した（下記）ため、本 spec の範囲に含めない。
- 利用者の依頼（「commit して」「push して」）で扱う中断。区切りの規則が担保するのは、トークンの使い切りと作業の停止による中断に備えた、直前の区切りまでの push。それ以外の契機での中断は対象にしない。

## Boundary Commitments

### This Spec Owns

- ルートの BRW 宣言を基にしたブランチの分類、フックが処理する操作、確認省略、作業完了と開発ブランチ間のマージの判定。
- BRW が作成または再利用する PR と、導入担当者が選択した対象への Ruleset の導入・整合検査。
- エージェントごとのフック導入状態、実効 Ruleset、復旧に必要な情報の CLI 表示。
- 作業ブランチの区切りごとの commit・push の規則（指示の文面と、commit の確認省略）、および応答の終了時に作業ブランチの未コミットの変更・未 push の commit を検出して案内する Stop の処理（要件 2.9〜2.16）。

### Out of Boundary

- プレビューと配備のトリガーは既存のプロバイダーと CI が管理する。
- GitHub のレビュー・必須チェック、アカウントの権限設定、ネットワーク制御、管理対象フックの配布は各環境の設定で管理する。
- Codex・Claude へのフックの届け方（プラグインの配布、フック定義、Codex のフックの信頼登録、`brw setup` の Codex 側の処理、診断の Codex の状態語彙）は harness-plugin-unification が持つ。本 spec は届いたフックが何を判定するかだけを持つ。
- cc-sdd の `kiro-*` スキル（要件・設計・タスクの生成、`kiro-impl`）の手順。これらはセッションの開始ごとに入れ直されるため書き換えられない。区切りの commit・push は、BRW の SKILL.md と導入先の CLAUDE.md の指示、および Stop の検出で担保する。
- フックの保証範囲は稼働確認済みの操作経路。独立したプロセス、対話シェル内の命令、ホストがフック対象にしないツール経路には、GitHub 上の分岐元への反映時に Ruleset が適用される。

### Allowed Dependencies

- Node.js 22 以上の標準モジュールと既存の ESM、Git と `gh`、Claude Code と Codex のフック（届け方は harness-plugin-unification の対応表に従う）、GitHub REST API。既存の宣言読み込み、命名規則、worktree とプレビュー操作を利用する。

### Revalidation Triggers

- フックのイベント形式、ツール名・実行ディレクトリ、確認省略または信頼登録の仕様が変わった場合。
- 宣言の `autoApprove` の項目（`commit` の追加を含む）、作業の制限（`noPush`）、Stop イベントの登録が変わった場合。
- ブランチの分類、分岐元の解決、導入確認の対象、GitHub の権限や実効ルールの契約が変わった場合。ブランチ作成、終了処理、片付け、プレビューの CI トリガーも再検証する。

## Architecture

### Existing Architecture Analysis

`scripts/brw.mjs` は CLI、Claude Code フック、シェル文字列による commit・push の判定と確認省略を担う。`scripts/lib.mjs` は宣言の検証や Git 照会を持つ。Codex へのフックの届け方は harness-plugin-unification でプラグインに置き換わる（旧インストーラー・worktree の有効化は削除）。`agent-hooks.mjs` の Stop は、現状は当該セッションに結び付いた準備済みの作業だけを案内し、ブランチと作業ツリーの状態は見ない。確認省略（`autoApprovable`）の対象は push と PR 作成だけで、commit は判定を通すのみ。既存の `branch.<name>.brwBase` は `create --base` の記録で、現状は主に `finish` が参照する。PR 作成にもこの分岐元解決を共用する。

### Architecture Pattern & Boundary Map

CLI とフックを既存の入口に残し、操作判定を共有する。GitHub を変更する入口は、検証済みの引数を使う BRW の導入と公開の処理に限定する。

```mermaid
flowchart LR
    Claude[Claude Code フック] --> Hooks[フック変換]
    Codex[Codex フック] --> Hooks
    Hooks --> Policy[操作判定]
    CLI[BRW CLI] --> Policy
    Policy --> Repo[宣言と Git]
    Hooks --> Publication[完了状態と公開]
    Hooks --> Remainder[作業ブランチの残り]
    Remainder --> Repo
    CLI --> Publication
    CLI --> Rules[導入と Ruleset]
    Publication --> GitHub[GitHub]
    Rules --> GitHub
```

依存方向は `lib.mjs` → 操作判定・GitHub クライアント → 完了公開・Ruleset → フック変換と CLI とする。矢印の左側を下位依存とし、UI やホストの応答形式は下位モジュールに持ち込まない。

### Technology Stack

| レイヤー | 採用 | 用途 |
|---|---|---|
| CLI・処理 | Node.js 22 以上、Git | 既存 CLI、操作判定、ref 検証、worktree 状態 |
| フック | Claude Code の `PreToolUse`・`PostToolUse`・`Stop`、Codex の `PreToolUse`・`PostToolUse`・`PermissionRequest`・`Stop` | 実行前の拒否・通常操作の許可・作業の関連付け・公開漏れの検知。導入時の動作検査で必要イベントを確認 |
| 外部連携 | GitHub REST API と `gh api` | 対象リポジトリを固定した権限照会、PR、Ruleset の適用と実効ルール確認 |
| 状態 | 登録済み BRW 宣言、Git の共通ディレクトリと worktree ごとの状態 | 共有運用ポリシー、導入先の選択、タスク中の公開進捗 |

## File Structure Plan

| パス | 変更 | 責務 |
|---|---|---|
| `scripts/lib.mjs` | 更新 | 宣言の互換読み込み・検証、恒常的な分岐元、現在の ref、個別の分岐元解決。追加: `autoApprove.commit`（検証と `autoApproveOf`） |
| `scripts/operation-policy.mjs` | 新規 | シェル・対応する GitHub ツール入力の操作への変換、ref 分類 |
| `scripts/github-operations.mjs` | 新規 | `gh` コマンド・MCP ツール入力からの GitHub 書き込み経路（PR 作成・マージ・自動マージ予約など）の識別。operation-policy から呼ぶ |
| `scripts/operation-decision.mjs` | 新規 | 操作・登録済み宣言・作業の禁止から、拒否・通す・確認省略の可否を決める共通判定（ホストの入出力の形は持たない） |
| `scripts/agent-hooks.mjs` | 新規・更新 | イベントとホスト応答の変換、終了時の作業状態の案内。更新: Stop に作業ブランチの残りの案内を統合する |
| `scripts/work-remainder.mjs` | 新規（追加） | 作業ブランチの未コミットの変更と未 push の commit の検出、案内文の作成（読み取り専用・ネットワークに依存しない） |
| `scripts/hook-install.mjs` | 新規 → 削除 | harness-plugin-unification で削除される（Claude の登録検査は `hook-registry.mjs` へ移る） |
| `scripts/hook-diagnose.mjs` | 新規 | フックの稼働と対応経路の診断（読み取り専用。合成入力による動作検査） |
| `scripts/github-client.mjs` | 新規 | 固定した GitHub ホスト・リポジトリへの API 呼び出し、対象の照合、応答とエラーの検証、PR・Ruleset の照会と追加 |
| `scripts/publish.mjs` | 新規 | 作業 ID・完了申告・公開計画・push の実行と、途中・完了の状態管理 |
| `scripts/publish-pr.mjs` | 新規 | 保護対象への PR の再利用・作成と、応答不確実時の再取得による照合 |
| `scripts/publish-cli.mjs` | 新規 | `brw work`・`brw publish`・`brw pause` の入口（引数の検査、文言、次の操作の案内） |
| `scripts/ruleset-choice.mjs` | 新規 | 導入先と分岐元ごとの Ruleset の採否の保存と再利用 |
| `scripts/ruleset-preflight.mjs` | 新規 | 導入前の読み取り検査（認証・導入権限・プラン・squash 設定・既存ルール） |
| `scripts/ruleset-apply.mjs` | 新規 | 既存ルールの再利用、不足分だけの Ruleset 追加、応答不確実時の照合 |
| `scripts/ruleset-inspect.mjs` | 新規 | 適用後・日常の実効ルールと作業経路（迂回可能な権限）の検査 |
| `scripts/setup-cli.mjs` | 新規 | `brw setup`・`--migrate`・`brw check --ruleset` の入口（対象の決定、問い、表示、終了コード） |
| `scripts/brw.mjs` | 更新 | サブコマンドの振り分け、既存ブランチ操作と各モジュールの呼び出し（旧 `hook` サブコマンドは手動実行用で、フック登録は agent-hooks.mjs）。追加: 確認省略の対象に `git add`・`git commit`（`safeStage`・`safeCommit`） |
| `hooks/hooks.json` | 更新 | Claude プラグインのイベント登録。Codex 用の定義と導入は harness-plugin-unification が持つ（`scripts/install-codex.mjs` は削除） |
| `SKILL.md`、`references/setup.md`、`references/config.md`、`assets/config.example.json` | 更新 | ゲートで求めるワークフロー、導入・移行・復旧と対応範囲、宣言例。追加: SKILL.md の「作業の区切りの commit・push」（「してよい」を「行う」に改める）、`references/config.md` の `autoApprove.commit` と push 禁止の扱い |
| `CLAUDE.md`（このリポジトリ） | 更新 | このリポジトリで cc-sdd の各フェーズ・各タスクの区切りに commit・push する指示（`kiro-*` スキルは書き換えられないため） |
| `tests/work-remainder.mjs`、`tests/agent-hooks-session.mjs`、`tests/branch-ops.mjs`、`tests/decision.mjs` | 新規・更新 | 残りの検出、Stop の統合、commit の確認省略、リモートからの再開の契約テスト |
| `tests/selftest.mjs` と `tests/*.mjs`（モジュール別の契約テスト・`integration-*.mjs`）、`tests/support/`、`tests/real-env/` | 更新・新規 | 既存 CLI の互換性、新しい操作・導入契約の統合テスト、テスト補助（一時リポジトリ・偽の GitHub）、実環境検証の補助 |

## System Flows

### Ruleset の導入と再試行

```mermaid
flowchart TD
    Start[導入先と分岐元を特定] --> Choice{適用するか}
    Choice -->|適用しない| Skip[選択を保存してフック導入]
    Choice -->|未選択| Pending[選択方法を表示]
    Choice -->|適用する| Check[同じ認証情報で事前検査]
    Check -->|不足または不明| Incomplete[変更を保留して理由を表示]
    Check -->|確認済み| Reuse{既存ルールで充足}
    Reuse -->|充足| Verify[対象ブランチの実効設定を検査]
    Reuse -->|不足| Apply[対象を限定して Ruleset を追加]
    Apply --> Verify
    Verify -->|適合| Done[導入結果を表示]
    Verify -->|不適合または不明| Incomplete
```

### 作業完了時の公開

両操作に確認省略が適用される経路を示す。禁止、通常確認待ち、失敗のいずれかに達した場合は、完了済みの操作と未完了の理由を返す。

```mermaid
sequenceDiagram
    participant E as エージェント
    participant B as BRW
    participant G as GitHub
    E->>B: 準備済みの作業 ID・公開計画と必要な PR 入力を指定
    B->>B: 作業と宛先を照合し push 可否を判定
    B->>G: 開発ブランチを通常 push
    B->>B: 遠隔 head を確認
    opt 取り込み先が保護対象
        B->>B: PR 作成可否を確認
        B->>G: 同じ head と base のオープン PR を検索
        opt 対応する PR がない
            B->>G: PR を作成
        end
        G-->>B: 対象と PR の URL
    end
    B-->>E: 結果を返して完了状態を記録
```

### 区切りの commit・push と終了時の検出

```mermaid
flowchart TD
    Boundary[区切り: spec の各フェーズ生成後または実装の 1 タスク完了] --> Commit[git add と git commit]
    Commit -->|commit の確認省略| Push[git push]
    Push -->|push の確認省略| Resume[リモートだけで再開できる状態]
    Boundary --> Stop[応答を終えようとする]
    Stop --> Scan{作業ブランチに残りがあるか}
    Scan -->|なし または 調査のみ| End[終了を許す]
    Scan -->|あり| Block[終了を止めて commit と push を案内]
    Block --> Agent[エージェントが commit・push、または失敗を報告]
    Agent --> Stop
```

Stop の案内は 1 回だけ出し、同じ応答の再入（`stop_hook_active`）では案内せず終了を許す。区切りの commit・push の実行は指示に依存し、Stop は取りこぼしの後追いの検出になる。長い 1 回の応答の途中で中断した場合は、直前の区切りより後の変更が手元に残る（残余リスク。利用者が許容した。中断の契機として想定するのは「トークンの使い切り」と「利用者による作業の停止」で、どちらも Stop が呼ばれないことがある）。

## Requirements Traceability

| 要件 | 対応 | 契約・フロー |
|---|---|---|
| 1.1, 1.2, 1.3 | 操作判定、フック変換、CLI | 共通宣言、ブランチ分類、作成・再開・直接変更の拒否 |
| 1.4, 1.5 | 操作判定、フック変換 | 曖昧な更新の拒否、未導入時の通過 |
| 2.1, 2.6, 2.8 | 操作判定、フック変換 | 送り先の検証と確認省略、明示制限の優先 |
| 2.2, 2.3, 2.4, 2.5 | 完了公開、フック変換 | 状態と push・保護対象への PR 作成・再利用 |
| 2.7 | 完了公開、GitHub クライアント | 失敗の報告、push 後および作成応答消失時の復旧 |
| 2.9, 2.10 | SKILL.md・CLAUDE.md の指示、操作判定（commit の確認省略） | 区切りの commit・push、`safeStage`・`safeCommit`、`autoApprove.commit` |
| 2.11 | 区切りの commit・push、`brw resume`、作業ブランチの残り | リモートからの再開（既存の `resume`）、終了時の検出 |
| 2.12, 2.13 | 作業ブランチの残り、フック変換（Stop） | `remainderOf`、Stop の統合案内、調査のみの応答は止めない |
| 2.14 | 作業ブランチの残り、完了公開の状態（`noPush`）、宣言（`autoApprove.push`） | push 禁止時は commit までの案内と未 push の報告 |
| 2.15 | SKILL.md の指示、Stop の案内文 | 失敗時の報告（成功・未完了・理由）、手元に残る変更の明示 |
| 2.16 | 操作判定、作業ブランチの残り | 保護・分岐元・宣言外では適用せず要件 1 の拒否に従う |
| 3.1, 3.2, 3.3 | 操作判定、フック変換、CLI | PR 不要の開発間マージ、エージェントによる保護対象へのマージの拒否、GitHub 上での squash の案内 |
| 4.1, 4.2, 4.3, 4.4 | CLI、Ruleset | 対話の既定値（導入しない）、非対話の選択（未指定は見送り）、見送り |
| 4.5, 4.6 | Ruleset | リポジトリ ID・対象 ref に対応する導入記録 |
| 5.1, 5.2, 5.3 | Ruleset、GitHub クライアント | 事前検査、変更の保留、一連の適用フロー |
| 5.4, 5.5, 5.6 | Ruleset、GitHub クライアント | 実効設定の検査、競合の報告、重複防止 |
| 5.7, 5.8 | Ruleset、GitHub | 対象 ref 限定、バイパスなしの有効な branch Ruleset |
| 6.1, 6.2 | フック変換、Ruleset、CLI | フックの実測と Ruleset の整合検査 |
| 6.3, 6.4 | 宣言・Git、CLI | 旧パスと現行片付け条件の互換 |

## Components and Interfaces

| コンポーネント | 入口 | 主な依存 |
|---|---|---|
| 操作判定 | `evaluate(operation, context) → Decision` | 宣言・実際の Git ref |
| フック変換 | `handleHook(host, event) → HookResponse` | 操作判定、プロジェクトのフック信頼状態 |
| 完了公開 | `publish(input) → PublishResult` | Git remote、作業先の状態、GitHub API |
| 作業ブランチの残り | `remainderOf(cwd) → Remainder \| null`、`remainderGuidance(remainder, policy) → string \| null` | 宣言、Git、作業の制限 |
| Ruleset | `plan(target, selection) → Result<Plan>`、`apply(plan) → Result<Report>`、`inspect(target) → Report` | GitHub クライアント、導入記録 |
| GitHub クライアント | `request(target, method, path, body?) → Result<Response>` | `gh api`、GitHub API の入力と応答 |

### 操作判定とフック変換

- 操作の境界で `{kind, repository, cwd, sourceRef?, targetRef?, remote?, headOid?}` を検証する。種類は作成・再開、commit、push、PR 作成、マージ、自動マージ予約、照会、解釈不能。判定は `pass`、`deny`、`eligibleForApproval` と理由を返す。
- 開発ブランチは命名規則を満たし、`workBranches` に一致するものから恒常的な分岐元と `protectedBranches` を除いて判定する。保護・宣言外への直接更新を拒否する。BRW の作成・再開は正規の CLI コマンドから行う。既存の branch-only と worktree 付きの両方に対応し、`resume` でローカルブランチから worktree を作れるようにする。
- シェル入力は引用符を考慮して解析し、ホストから確認できる実際の実行ディレクトリ、Git の `-C`、実際の remote・refspec と追跡設定を照合する。ブランチ変更を含み、内容を確定できない複合操作には拒否を返す。確認省略はコマンド全体の対象が検証できる場合に限る。強制・削除、未登録や編集中の宣言、明示オプトアウトには確認省略を適用しない。GitHub を変更する MCP ツールも既知の引数を検証する。対応外の書き込みツールは、ホストが遮断を支援する場合は BRW 経由へ誘導し、それ以外は検査で強制範囲外と表示する。
- Claude は `PreToolUse` で拒否と許可を返す。Codex は同イベントで明示的に拒否し、確認省略は `PermissionRequest` に対してのみ許可を返す。導入済みの対応経路では、変更能力のある呼び出しを分類できない場合や、リポジトリ・操作・更新先のいずれかを確定できない場合は、理由付きで拒否する。既知の変更ツールで必須入力が欠ける場合も同じ。通常のホスト承認に委ねるのは、BRW の適合判定が済み、確認省略の条件だけを満たさない操作に限る。既知の照会と未導入リポジトリは通過させる。導入設定だけがある場合は変更を保留し、設定の復旧を案内する。フック自体が届かない経路は導入検査で報告する。
- **commit の確認省略（2.9, 2.10）**: `autoApprovable` の対象に、作業ブランチ上の `git add` と `git commit` を加える（`safeStage`・`safeCommit`。`safePush` と同じ作法で、複合コマンドは全区間が条件を満たすときだけ省略する）。条件: 登録済みで作業ツリーの内容が HEAD と一致する宣言（リポジトリ直下の `.branch-release-workflow.json`。`autoApprove` はその項目）、`autoApprove.commit` が明示的に `false` でないこと、現在のブランチが `judgeBranch` で allow（作業ブランチ）であること。`git add` は `-A`・`-u`・`--all`・`-N`・`-v` とパス指定だけを許し、`git commit` は `-m`・`-F`・`-a`・`-s`・`-q`・`--allow-empty` だけを許す。`--amend`・`--no-verify`・`-n`・`-c`（設定の上書き）・環境変数の前置・展開を含む引数は省略の対象外とし、通常の承認に任せる。メッセージは、リテラルの引用文字列、またはクォートした heredoc（`-m "$(cat <<'EOF' … EOF)"`、本文は展開されない形）に限って受け入れる。Claude は `PreToolUse` の許可、Codex は `PermissionRequest` の許可で返し、保護ブランチ・宣言外の commit は従来どおり拒否する。Codex の対話相当（承認方針 `on-request`）では、`git add … && git commit …` はサンドボックスの失敗のあとにエスカレーションされ、`PermissionRequest` フックへ全コマンド文字列で届き、許可で承認要求なしに実行されることを実機で確認した。非対話（`codex exec`）は承認方針が常に `never` で `PermissionRequest` が発生せず、`.git` が読み取り専用のため、実行側の書き込み許可（`--add-dir`）が無いと commit・push は失敗する（BRW のフックでは解決できない。診断の `limits` と導入手順に明記する）。
- `brw merge <source>` は、元 ref と checkout 先の両方が宣言済みの開発ブランチと確認できる場合にローカルマージする。対象 worktree と確定した元コミットを使い、競合は Git の状態と解決方法を返す。通常の開発ブランチへの push は共通判定に従う。開発間の取り込みに PR 作成は不要。
- `protectedBranches` と恒常的な分岐元は、エージェント操作上の保護対象とする。対応するフック経路で直接の PR 作成も同じ分類を使い、宣言済み開発ブランチから保護対象への PR だけを BRW の公開操作として許可する。開発ブランチ間はローカルマージを案内し、宣言外への PR 作成は拒否する。保護対象への PR は作成または再利用まで行い、利用者に GitHub 上の PR URL、base、squash の案内を返す。エージェントからの GitHub マージと自動マージ予約、および非開発ブランチへのローカルマージは、対応するフック経路で拒否する。BRW は GitHub のマージ API を呼ばない。GitHub 側の直接更新とマージ方式の制限は、選択して適用した Ruleset の対象 ref に効く。

- Claude・Codex へのフックの届け方（プラグインの配布、フック定義、信頼の登録、診断）は harness-plugin-unification の設計に従う。本 spec は、届いたフックのイベントごとの判定と応答を定める。許可と拒否の両方について、対応する実行環境でフックが届くことの稼働検査は、同 spec の受け入れ確認で行う。

### 完了公開と状態

- `brw work start` は新規の変更作業を始めるときに作業 ID を払い出す。既存作業の再試行は同じ ID を明示して再開する。会話の文面や `HEAD` のみから作業を引き継がない。調査だけの依頼では作業を開始しない。別の依頼では同じセッション・worktree・`HEAD` でも新しい ID を使う。進行中の作業を別の作業に切り替えるときは、中断を記録する。`PostToolUse` は成功した `work start` / `work resume` の出力と worktree を検証し、ホスト入力のセッション ID にその作業 ID を関連付ける。停止・完了時に関連付けを解除する。ホスト情報のない端末では作業 ID を明示して同じ制限を適用する。
- `brw work ready --work <id>` は、担当エージェントが依頼の完了条件を満たし、必要な検証が成功し、公開するコミットを確認した後に呼ぶ。CLI はその完了申告と検証の要約を記録し、作業 ID・worktree・開発ブランチ・公開する head OID・push 先リポジトリ ID と ref・取り込み先のリポジトリ ID と ref、および作業で明示された push と PR 作成の制限を照合して固定する。未コミットの変更、未解決の宛先、検証失敗を申告した作業は準備済みにしない。既存 PR の一意な対象、記録済み `brwBase`、宣言の既定値は、記録済み `brwBase` を優先して照合し、競合時は明示指定を求める。CLI が検証するのは記録と Git の状態で、依頼内容の完了判定は担当エージェントが担う。
- `brw publish --work <id> --plan <id> [--title <title> --body-file <path>]` は準備済みまたは途中まで公開済みの指定作業だけを扱う。開発ブランチへの取り込みは push の結果で公開を完了し、PR 作成を計画しない。取り込み先が保護対象の場合は PR を計画し、既存 PR がなければ作成前にタイトルと本文を求める。宣言外や未解決の取り込み先は公開準備で拒否する。
- push と PR 作成の直前に、公開処理自身が登録済み宣言と作業に記録された制限を共通判定へ渡し、副作用ごとに可否と確認省略を判定する。作業開始時と追加指示を受けた時点で、担当エージェントは `brw work restrict --work <id> --no-push|--no-pr` で該当する制限を記録する。同じ作業の再試行では制限を保持する。ホストで作業を追跡できる場合は、直接呼び出された push と PR 作成にも同じ制限を適用する。自動公開の既定は登録済み宣言の各項目が未指定なら有効、明示的な `false` なら無効。未登録・編集中・不正な宣言では確認を省略しない。明示禁止は実行せず、`autoApprove` が無効な操作は自動公開から外してホストの通常ポリシーに従う個別の操作として案内する。実行結果は公開処理が遠隔状態から照合できる。ホストで通常の確認経路を提供できない場合は利用者の実行に委ねる。明示的に禁止された push は省き、同じ OID がすでに対象 ref にあると読み取りで確認できる場合だけ PR 処理へ進める。PR 作成だけが禁止されたときは許可された push の結果を報告し、PR は作成しない。
- `publish` には `brw work plan --work <id>` が発行した計画 ID が必要。計画は作業 ID、宛先、head OID、照合した宣言と制限の版、実行できる書き込みの集合を保持する。計画の作成は読み取りとローカル記録まで。明示禁止・通常確認待ちの書き込みは計画に入れない。Claude `PreToolUse` と Codex `PermissionRequest` は、単独で呼ばれた信頼済み BRW の `publish` だけを対象に、ローカルの計画と必要な引数を共通判定で検証し、計画中の全書き込みが確認省略の対象である場合に限り許可を返す。CLI はホストの許可応答の有無にかかわらず計画を検証し、計画外の書き込みを行わない。再計画では対象の遠隔状態を読み直し、途中の成功を引き継ぐ。
- push は準備時の OID から確定した宛先への通常 push とし、push 後は遠隔の対象 ref が同じ OID を指すことを確認する。PR 作成の直前にも対象 ref を再確認し、同一リポジトリ・head・base のオープン PR を探す。作成後、競合時、応答喪失時は PR を取得し、head OID と両リポジトリ・ref が一致した場合に URL を返す。作成後に食い違いが判明した場合は作成済みの URL と差異を報告し、完了とは記録しない。push を確認できない場合は PR 作成に進まない。準備時の対象が変わった場合や、既存 PR が異なる head を示す場合は結果を成功扱いせず、再確認を求める。
- 状態は `inProgress`、`ready`、`pushed`、`published` を持ち、`brw pause --work <id> --reason <reason>` は次の副作用を保留する。操作ごとに成功・対象外・明示禁止による省略・通常確認待ち・失敗を記録する。必要な操作が終了したときは `published` とし、PR を作成しない場合は URL を持たない。中断後の再開は `brw work resume --work <id>` で明示し、作業対象と検証結果を再照合する。再試行は同じ作業 ID と対象を再照合する。worktree ごとに公開実行を直列化し、操作間では状態の記録を更新できるようにする。push と PR 作成それぞれの直前に状態ロック内で最新の制限と計画の版を照合して操作開始を記録する。開始済みの操作は取り消せないため、追加された制限や中断は次の操作から適用する。終了時フックは当該ホストのセッションに結び付いた作業のみを参照する。準備済みの公開が残っている場合に、同じ作業 ID での再試行または中断を案内する。作業途中、調査のみ、中断済み、明示禁止だけが残る状態では公開を起動しない。終了時フックは書き込みや新しい作業の開始を行わない。
- `finish` は既存の取り込み条件を利用する。リモートとの照合が失敗し、未 push の commit がないと確認できない場合は片付けを保留する。

### 作業ブランチの残りの検出（Stop）

| 項目 | 内容 |
|---|---|
| 役割 | 応答を終えるとき、作業ブランチに未コミットの変更または未 push の commit があれば終了を止めて案内する |
| 要件 | 2.11〜2.16 |

**責務と制約**
- 読み取りだけを行い、状態・設定・リモートを変更しない。ネットワークを使わない（追跡ブランチの古さは許容する）。
- 対象は、cwd のリポジトリが BRW 導入済みで、現在のブランチが `judgeBranch` で allow（作業ブランチ）のとき。保護ブランチ・恒常的な分岐元・宣言外のブランチ・detached HEAD・導入していないリポジトリは対象外（案内しない。2.16、1.5）。
- 未コミットの変更: `git status --porcelain --untracked-files=normal`（ignore されたものは含まない。新規の未追跡ファイルを含める）。
- 未 push の commit: `git rev-list --count HEAD --not --remotes`（既知のどのリモート追跡ブランチにも含まれない commit の数）。追跡ブランチが無い新規のブランチも検出でき、初回の push 前でも成立する。
- push 禁止: 作業の制限 `noPush`（`brw work restrict`。セッションではなく worktree の現在の作業から解決する既存の `restrictionsFor`）、または宣言の `autoApprove.push` が明示的に `false` のとき、未 push は理由にしない。未コミットの変更の案内は残し、「commit だけ行い、未 push であることを報告する」と案内する（2.14）。宣言に push を禁止する専用の項目は無いため、`autoApprove.push: false`（確認を省略しない運用）を「宣言が push を禁じる」と扱う（利用者が 2026-11-23 に確認済み）。この扱いは `references/config.md` に明記する。
- 案内は `stop_hook_active` の再入では出さない（既存の規則）。既存の「準備済みで未公開の作業」の案内と 1 つの block にまとめ、公開の案内を先に、残りの案内を後に並べる。変更も未 push も無い調査・確認だけの応答では案内しない（2.13）。

**依存**: `lib.mjs`（`git`・`loadConfig`・`repoRoot`・`judgeBranch`・`autoApproveOf`・`configMatchesHead`。P0）、`agent-hooks.mjs`（呼び出し元。P0）。依存の向きは `lib.mjs` → `work-remainder.mjs` → `agent-hooks.mjs`。

**契約**: Service

```js
/** @typedef {{branch: string, dirty: string[], dirtyCount: number, unpushed: number}} Remainder */
/** @typedef {{noPush: boolean}} RemainderPolicy */

/** 対象の作業ブランチの残りを返す。対象外・判定不能は null（案内しない側に倒す）。 */
export function remainderOf(cwd: string): Remainder | null;

/** 残りがあれば案内文を返す（残りが無ければ null）。dirty は先頭 10 件までを示す。 */
export function remainderGuidance(r: Remainder, policy: RemainderPolicy): string | null;
```

- 事前条件: `cwd` は絶対パス。事後条件: `null` でない結果は、`dirtyCount > 0` または `unpushed > 0`。
- 案内文は、ブランチ名、未コミットの変更の件数と先頭のパス、未 push の commit の数、次の操作（`git add <パス>` → `git commit` → `git push`、`brw` を使う場合は同じ）、失敗時に「成功した処理・未完了の処理・失敗理由を報告して終了する」こと（2.15）、および「この作業で生じた変更なら commit・push する。この作業によるものでなければ、その旨を報告して終了してよい」という判断の指示を含む。Codex では、案内の対象がエージェント自身の作業の変更なら commit・push が実行され、依頼と無関係な既存の変更は「依頼の範囲外」として実行されないことを実機で確認した。後者でも 2 回目の Stop（`stop_hook_active`）で終了できる。
- 誤検出の扱い: 無関係な未追跡ファイルで止まり続けないよう、案内は 1 応答につき 1 回で、2 回目（`stop_hook_active`）は終了を許す。案内にはパスを示し、エージェントが理由を説明して終了できるようにする。

**指示の文面（2.9, 2.10, 2.11, 2.15）**: BRW の SKILL.md に「作業の区切りの commit・push」を置く。区切りは、(1) `.kiro/specs/` に spec を作る運用での要件・設計・タスクの各生成後、(2) 実装の 1 タスク完了ごと。区切りでは、変更したパスだけを `git add` し、`git commit` し、`git push` する（許可は求めない）。利用者が push を禁じた場合は commit までにとどめて未 push を報告する。失敗したときは、成功した処理・未完了の処理・失敗理由を報告し、変更が手元にあることを示す。別の環境・エージェントへ引き継ぐときは、リモートの作業ブランチを `brw resume` で再開する。このリポジトリの CLAUDE.md にも同じ指示を置く。

### Ruleset の導入と検査

- `brw setup [--ruleset on|off]` で、ローカルのリモート設定から対象候補を表示し、宣言から恒常的な分岐元を解決する。Ruleset は既定 off。対話では適用範囲と効果を示して `導入しますか [y/N]` を提示し、Enter は見送り。非対話では導入担当者が指定した引数または同じ範囲に保存済みの選択を使い、どちらも無ければ見送り（選択は記録せず、GitHub への認証・通信・書き込みなし。後から `--ruleset on` で導入できる）。過去の選択が読み取れない場合（対象変更・記録破損）は適用せず保留する。エージェントの起動やフックから Ruleset の導入を暗黙に実行しない。対象が変わった場合は選択を取り直す。見送りでは GitHub の認証を求めず、選択を保存してフック導入へ進む。導入を選んだ場合は GitHub の応答でホスト・所有者・名前を照合してリポジトリ ID を確定し、保存済みの ID と異なる場合は再確認する。
- 事前検査と適用は、明示した同一のホストと認証情報を使う。認証情報は導入処理中に固定し、`gh` の子プロセスにホスト対応の環境変数で渡す。`gh auth status` は認証確認に使い、権限はリポジトリ情報と認証情報が持つアクセスの両方から判断する。通常の GitHub CLI OAuth・classic token では対象の管理権限と実レスポンスの有効な `repo` スコープを照合する。fine-grained token / GitHub App では、対象の既存リポジトリ Ruleset の取得で `bypass_actors` が返るなど、その対象への書き込み権限を示す確実な証拠を使う。トークンの同一性・権限・利用可否を読み取りで確認できない場合は変更を保留し、対応済みの認証方法を案内する。権限検査だけを目的とする Ruleset 作成は行わない。
- 対応する GitHub プラン・対象ブランチの存在・`allow_squash_merge`・有効なルールとの競合を事前検査する。GitHub.com の公開リポジトリは公開向けサポートを根拠にできる。非公開リポジトリの利用可否は、既存 Ruleset または取得可能な対象のプラン情報で確認する。squash が無効の場合は、リポジトリ全体の設定変更を導入時に暗黙に行わず、競合として案内する。
- BRW が作る Ruleset は `target: branch`、`enforcement: active`、`bypass_actors: []` とし、`conditions.ref_name.include` を対象の完全な `refs/heads/<name>` に限定する。`pull_request.parameters.allowed_merge_methods` は `["squash"]`。既存レビューやチェックを別のルールとして併用し、競合時は適用を止める。適合する既存ルールを確認できた場合は再利用する。
- BRW が過去に作成した同一対象の Ruleset は記録済み ID と所有リポジトリで識別する。適合するルールを再利用し、実効条件と競合しない不足分だけを新規 Ruleset として追加する。同名で不適合な Ruleset、適用対象のずれ、既存ルールの置換が必要な場合は競合として管理者に返す。GitHub の公開 API に既存ルール全体の条件付き置換がないため、BRW は既存の Ruleset を更新・削除しない。`POST` が失敗またはタイムアウトした場合は再取得し、同じ適用範囲と設定を確認してから次の操作を決める。ローカルで同一リポジトリの適用を直列化する。別端末の競合で複数候補が見つかった場合は、対象を報告して追加作成・自動削除を保留する。
- 適用後は Ruleset の詳細と各対象ブランチの実効ルールを再取得する。有効化、対象一致、PR 必須、squash 限定、実効ルールの競合、ルールを迂回できないことを確認する。バイパス情報が取得できない既存 Ruleset は適合の根拠に使わない。管理者の設定用認証と通常作業の認証を分け、確認対象の作業経路ごとに実際の主体と Ruleset の変更権限を照合する。GitHub API で主体を固定できない SSH や外部 MCP 経路では、管理設定で固定された作業主体と権限の証跡を使う。適用されたルールと作業権限の検証結果を別々に報告し、主体または変更・迂回権限が未確認の経路は迂回不可と表示しない。少なくとも一つの適合したバイパスなしのルールが必要で、他の既存制約も検査する。`brw check --ruleset` でも日常の読み取り検査を提供し、検査権限がない場合は確認不能を返す。

| 操作 | GitHub API | 入出力 |
|---|---|---|
| 対象と squash 設定の確認 | `GET /repos/{owner}/{repo}` | リポジトリ ID・可視性・権限情報・`allow_squash_merge` |
| 一覧・詳細・実効ルール | `GET /repos/{owner}/{repo}/rulesets`、`GET /repos/{owner}/{repo}/rulesets/{id}`、`GET /repos/{owner}/{repo}/rules/branches/{branch}` | 親ルールを含む一覧・詳細・各 ref の実効ルール。ページングと branch 名の URL エンコードを扱う |
| 追加 | `POST /repos/{owner}/{repo}/rulesets` | 対象とルールの JSON、返却 ID、エラー |
| PR の再利用と作成 | `GET /repos/{owner}/{repo}/pulls`、`POST /repos/{owner}/{repo}/pulls` | head リポジトリ・head ref・base ref・状態・URL。作成時は title・body・head・base |

## Data Models

- 宣言は正本と旧パスの優先順を維持する。恒常的な分岐元は `baseBranch` と追加の固定名 `baseBranches` から解決する。任意のパターンや一時的な `brwBase` は Ruleset の対象集合へ入れない。
- 導入選択は `{host, owner, repository, repositoryId?, refs, enabled}`。リポジトリ ID は GitHub 側への適用を選んだ場合に確認・保存する。Git 共通ディレクトリに保存し、適用済み ID は選択とは別に記録する。選択済みと適用確認済みを区別する。別 clone では新たな対話確認または利用者指定の非対話入力を利用する。
- 公開状態は `{workId, sessionId?, worktreeId, status, pausedReason?, ready?, restrictions, results}`。`ready` は公開先リポジトリ ID、push 先 ref、取り込み先リポジトリ ID と ref、head OID、完了申告、検証要約を持つ。作業の明示制限は `restrictions` に保存し、操作別の結果と PR URL は `results` に記録する。計画は作業に関連付け、記録した前提に変更があれば失効する。Git 共通ディレクトリに worktree 単位で保存し、同じ worktree の状態遷移はロックと一時ファイルからの置換で行う。セッションを関連付けられない環境では作業 ID で再開でき、終了時フックによる案内は無効と報告する。秘密情報や PR 本文は進捗記録に含めない。
- 作業ブランチの残りは `{branch, dirty[], dirtyCount, unpushed}`。保存せず、Stop のたびに Git から導く（状態ファイルを増やさない）。
- 宣言の `autoApprove` は `{push?, pullRequest?, commit?}`（未指定は有効、明示的な `false` だけが無効）。`commit` を足す。
- 結果は成功または `auth`、`permission`、`unsupported`、`conflict`、`network`、`invalidInput` の判別可能なエラー。外部 JSON とフック入力は境界で検証してから JSDoc で型を表す。

## Error Handling

- 拒否時はリポジトリ、対象ブランチ、判定理由と BRW の代替操作を返す。外部コマンドの stderr は秘密値を除いて必要な部分だけ表示する。
- 権限エラー、SSO 制約、プラン不明などは、確認できた範囲を示して設定の変更を保留する。適用成功後に確認できない場合は Ruleset ID または候補を表示し、実効設定を再取得できるようにする。
- フック検査は設定の有無と実際の応答を区別する。無害な BRW 検査呼び出しへのホストからのイベント到達を確認し、未導入・未信頼・非対応・検査不能を表示する。未導入と未信頼は登録状況またはホストの信頼状態を確認できた場合に判定し、フックが届かなかっただけの場合は検査不能を返す。Work Cloud のクラウドオーケストレーションは管理対象の Global MCP フックが前提となるため、リポジトリのコマンドフックだけの構成は非対応と表示する。
- 非対話の Codex で `.git` に書き込めない場合（commit・push の失敗）は、エージェントが失敗を報告して終了する（2.15）。BRW は検出した残りを案内するだけで、書き込み許可は変えない。
- 残りの検出は、Git の呼び出しが失敗したときや対象を決められないときに案内しない側（終了を許す側）へ倒す。確認不能で応答の終了を妨げない。
- コマンドフックで権限を確認できない場合、アプリの審査・サンドボックス・ネットワーク方針に従う。共同の保護は GitHub Ruleset の実効設定で確認する。

## Testing Strategy

- **単体**　恒常的な分岐元と開発指定の重複、`git -C`、push の refspec、確認対象の混在、別 remote、不正なフック入力での書き込み拒否、記録済み分岐元とオプトアウトを判定する。Claude と Codex のイベント応答、公開計画のうち一方だけ確認待ちになる場合、フックがホスト承認を受け取らない場合、開発間・宣言外への直接の PR 作成を拒否する場合を契約テストする。1.1–1.5, 2.1, 2.6, 2.8, 3.1–3.3。
- **Git 統合**　一時リポジトリと bare remote で BRW 経由の作成・再開と作業中の通常 push を確認する。調査・中断、同じセッションと HEAD での別作業、公開準備前の拒否、操作別の禁止・通常確認待ち、公開成功、push 成功後の PR 失敗・再試行、既存 PR、開発間での PR なしのマージと公開、宛先変更、未 push の worktree の保持を確認する。1.2, 2.2–2.7, 6.3, 6.4。
- **GitHub 契約**　通常の `gh` 書き込み制限、管理者でも権限不足のトークン、プラン不明、選択見送り、既存ルールの再利用、範囲変更、バイパス情報欠落、Ruleset を変更できる作業主体と確認不能な主体、競合と応答消失を再現する。別管理者が条件を追加しても既存設定の更新要求を送らないことを確認する。事前検査の失敗時に書き込み要求がゼロであることも確認する。4.1–4.6, 5.1–5.7, 6.2。
- **実環境**　検証用リポジトリで非管理の作業資格情報を使い、直接 push・rebase・merge commit が拒否され、利用者は GitHub 上で対象 PR を squash マージできることを確認する。対応するエージェント経路では GitHub マージと予約が拒否されることも確認する。Claude Code と Codex で禁止操作の拒否、通常 push・PR 作成の確認省略、作業 ID とセッションの関連付け、フック未信頼の検出を確認する。2.1, 2.2, 3.3, 5.8, 6.1。

- **区切りの commit・push と終了時の検出**　`tests/work-remainder.mjs` で、未コミットの変更（変更・新規・削除）、未 push の commit、追跡ブランチが無い新規ブランチ、push 済みで残りが無い場合、保護ブランチ・分岐元・宣言外・detached HEAD・未導入で `null` になること、無視されたファイルを数えないことを確かめる（2.12, 2.13, 2.16, 1.5）。`tests/agent-hooks-session.mjs` で、Claude・Codex の Stop が残りを block で案内し、調査のみでは案内しないこと、`stop_hook_active` で再入しないこと、公開の案内と 1 つの block に統合されること、`noPush`・`autoApprove.push: false` では未 push を理由にせず未コミットだけを案内すること、状態ファイルやロックを作らないことを確かめる（2.12〜2.14）。`tests/decision.mjs` で、作業ブランチの `git add` と `git commit`（リテラルのメッセージ、クォートした heredoc）が確認省略され、`--amend`・`--no-verify`・`-c`・展開を含むメッセージ・保護ブランチ・`autoApprove.commit: false`・未登録の宣言では省略されないことを確かめる（2.9, 2.10, 2.16）。`tests/branch-ops.mjs` で、区切りで push 済みの作業ブランチを、手元の worktree を消した後に `brw resume` でリモートから再開できることを確かめる（2.11）。実環境では、Claude Code と Codex で、commit の確認省略（Codex は承認方針 `on-request` の app-server 経由で `PermissionRequest` の許可を確かめ、`codex exec` は `--add-dir` の有無での成否を確かめる）、Stop の案内（エージェント自身の変更で commit・push に進み、無関係な変更では報告して終了できること）、長い応答（複数タスクの連続実装）での区切りごとの push と中断後の別エージェントによる再開を確かめる（2.9〜2.12）。

## Security Considerations

- 設定用の管理者資格情報は導入操作で使用し、通常作業の資格情報は Ruleset を編集・迂回できないものを使用する。適用や検査に使う資格情報の値は出力しない。
- 対応するフック経路の同一性、実行ディレクトリ、操作対象を検査する。リポジトリや worktree が供給する未登録の宣言や CLI パス変更で、確認省略や書き込みの許可範囲が広がらないようにする。
- フックの信頼の登録は harness-plugin-unification の `brw setup` が BRW のフックに限って行う（利用者の決定で、従来の「製品の確認に任せる」を改めた）。設定だけで強制を保証できない経路は導入診断で明示する。
- commit の確認省略は、作業ブランチ、登録済みの宣言、限定した引数の形に限り、`--amend`・`--no-verify`・設定の上書き・展開を含む引数は対象外にする。確認を省いても、保護ブランチ・宣言外への commit・push の拒否は変わらない。

## Migration Strategy

既存宣言を読み込み、ローカルのブランチ運用と重複を診断する。新規の確認省略の既定を案内し、明示済みの制限を維持する。設定を変えずに従来どおり確認を省略しない運用を続ける場合は、移行時に対象の項目を明示的に無効化できるようにする。Claude の既存プラグインの更新と、Codex のプラグイン導入・フックの信頼登録（harness-plugin-unification）を案内し、稼働を確認する。宣言の `autoApprove` に `commit` が加わる（未指定は有効。確認を求めたい運用は `false` を明示する）。Ruleset の採否が未設定なら導入フローを実行する。新設した Ruleset の無効化は GitHub の管理者操作として記録済み ID を案内し、既存ルールの復旧を伴う変更はその管理主体に委ねる。

## 改訂メモ

- 2026-11-21: File Structure Plan を実際のファイル分割に合わせ、Codex の linked worktree の前提（worktree に `.codex/` があるときだけ親の hooks.json を読む。登録・信頼は親に結び付く）を訂正した。
- 2026-11-21: 利用者の決定（仕様変更）により、Ruleset の既定を「導入する」から「導入しない（既定 off の任意の追加事項）」へ改訂した。承認済みの文書への改訂で、要件 4.1〜4.3 と対話の既定・非対話の未指定の扱いを変更した（`--ruleset on` と保存済みの導入の挙動は不変）。
- 2026-11-23: 要件 2.9〜2.16（区切りごとの commit・push と、応答終了時の残りの検出）を追加した。commit の確認省略（`safeStage`・`safeCommit`、`autoApprove.commit`）、Stop の統合（`work-remainder.mjs`）、指示の文面を設計した。Codex へのフックの届け方は harness-plugin-unification に委ね、`hook-install.mjs`・`install-codex.mjs` の記述を削除対象へ改めた。
- 2026-11-23（再生成）: Codex 0.167 の実機検証の結果を反映した。`PermissionRequest` による commit の確認省略（対話相当）、非対話での `.git` 書き込み許可の要否、Stop の案内への従い方（案内文に「この作業で生じた変更か」の判断を含める）、PostToolUse の追加文脈（Codex で到達。本 spec では採らない）。利用者が `autoApprove.push: false` の解釈と残余リスク（中断の契機はトークンの使い切りと作業の停止）を確認・許容した。
