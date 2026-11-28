# 設計書: brw-branch-gate

## 概要

**目的**: BRW 導入済みのリポジトリで、エージェントが素の git コマンドや EnterWorktree でブランチ・worktree を作ろうとしたとき、BRW が操作を奪って `brw create`（再開は `brw resume`）に収束させる。
**対象**: エージェント（Claude Code・Codex）と、通常のブランチ作成を指示するだけの呼び出し側（cc-sdd-bootstrap など）。呼び出し側は BRW を知る必要がない。
**影響**: 現状は拒否のみだった作成・再開の判定結果を、Claude Code では「置き換えて実行し、作業場所を移す」に、Codex では「次のコマンドを書いた拒否」に改める。判定の対象に EnterWorktree を加える。2026-11-28 の更新で、worktree の配置先を `<本体>/.claude/worktrees/` から `<本体>/.worktree/` に変え、配置先の決まりをこの仕様が持つ（旧置き場は認めない）。

### 目標

- 命名規則に合う作成・既存ブランチの再開を、Claude Code では拒否せず BRW の手順へ置き換え、作業場所まで移す（1.1〜1.3、3.1）。
- 置き換えられないものは、読むだけで次の手順が取れる自然文の案内つきで拒否する（1.4〜1.6、2.1、4）。
- Bash 以外の入口（EnterWorktree）も同じ判定に載せる（2.1〜2.5）。
- 判定できないときは安全側に倒し、導入していないリポジトリには干渉しない（5）。
- 作業場所の配置先を `<本体>/.worktree/` に統一し、作る場所と許す場所を 1 か所の定義で揃える。旧置き場の worktree は、配置先として認めず、移動の手順を案内する（7）。配置先が無視されていない導入先には警告する（7.10）。

### 非目標

- cc-sdd-bootstrap と kiro 系スキルの変更。`brw create` の命名規則・分岐元の変更。
- PR 本文の置き場 `.brw/` の移動（`brw-pr-handoff`。それまで旧置き場 `.claude/worktrees/.brw/` に残る）。導入先の `.gitignore`・共通の除外設定への追記と、その案内（`brw-install-flow`）。旧置き場の worktree の自動の移動。
- Codex での入力の書き換え（未検証、research.md #7）。Codex は拒否と案内で扱う。
- PR 作成・片付けの流れ（brw-pr-handoff）。

## 境界の確約

### この仕様が担う

- 作成・再開の入力を、置き換え・拒否・通過のいずれかに決める「ゲートの計画」（置き換え後のコマンド、案内文を含む）。
- 置き換え結果と拒否理由の案内の書式（見出し・次のコマンド・作業場所）。
- EnterWorktree の判定と、フックの対象入口の拡大（定義と導入検査）。
- 判定の拡張（開始点の記録）と、それに対する試験・評価ケース・資料。

- `brw create --carry`（追跡済みファイルの未コミットの変更を新しい worktree へ移す、安全確認つきの移動）。
- **配置先の決まり**（`<本体>/.worktree/<別名>`）と、その決定・判定・旧置き場の扱いを 1 か所に集めた部品（`scripts/placement.mjs`）。`brw create`・`brw resume` が作る場所、置き換え・EnterWorktree の許可の判定、旧置き場の worktree の拒否と案内（`resume`・`finish`・EnterWorktree）、`--carry` の未追跡の一覧からの除外、配置先が無視されていないときの警告。

### 担わない

- ブランチ作成そのもの（`brw create`・`brw resume` の処理内容）のうち、`--carry`・配置先・旧置き場の拒否・無視の警告以外。作成・再開の成否は既存のまま使う。未追跡のファイルの移動。
- PR 本文の置き場 `.brw/`（`brw-pr-handoff`）。導入先の `.gitignore`・共通の除外設定の書き換えと、その案内（`brw-install-flow`）。旧置き場の worktree の自動の移動。
- 保護・分岐元・宣言外のブランチの扱い（`operation-decision` の既存の判定）。
- PR・片付け・公開計画（brw-pr-handoff、brw-enforcement）。

### 許可する依存

- `scripts/operation-policy.mjs` の分類結果（操作の種類・ブランチ・パス）と `scripts/lib.mjs` の宣言・ブランチ判定・worktree 一覧。
- `scripts/brw.mjs` の `create`・`resume`（コマンドとして呼ぶだけで、関数は import しない）。
- 依存の向きは「ゲートの計画 → 分類結果・宣言」の一方向とし、`operation-decision` はゲートの計画を知らない。

### 再検証の契機

- `createOp` の分類結果（`action`・`via`・開始点）の形を変えるとき。
- `brw create`・`brw resume` の引数・出力を変えるとき。配置先の決まり（`placement.mjs` の公開関数）を変えるとき（`brw-pr-handoff` の `.brw/` の移動を含む）。
- Claude Code のフックの応答形式（`updatedInput`・`permissionDecision`）が変わったとき。
- フックの登録一覧（`CLAUDE_HOOKS`・`hooks.json`）を変えるとき。
- Claude Code の EnterWorktree の承認の規則（`.claude/worktrees/` の外は承認が要る）、`CLAUDE_PROJECT_DIR` の意味、Codex の linked worktree のフックの読み込みの規則が変わったとき。

## アーキテクチャ

### 既存の構造の分析

- 判定層（`operation-decision.evalCreate`）は作成・再開を常に拒否する。フック層（`agent-hooks.judgeBash`）が判定結果を応答にする。
- 置き換えはホスト固有（Claude Code の書き換え機能）の層の責務なので、判定層は変えず、フック層で「拒否」を「置き換え」へ変換する。Codex と `brw guard` は従来の拒否のまま（5.4）。

### 配置先の決まり（2026-11-28 の更新）

- 配置先のパス（`.worktree`）、旧置き場のパス（`.claude/worktrees`）、判定、案内を `scripts/placement.mjs` に集める。`brw.mjs`・`branch-gate.mjs`・`carry.mjs`・`cleanup.mjs` はそれを呼ぶだけにし、パスの文字列を持たない。`.brw/` の置き場（`pr-template.mjs`・`publish-cli.mjs`・`agent-hooks.mjs`）は、`brw-pr-handoff` の更新まで現状の定数のままにする。
- 依存の向きは「`brw.mjs`・`branch-gate.mjs`・`carry.mjs`・`cleanup.mjs` → `placement.mjs` → `lib.mjs`（`aliasOf`・`git`）」の一方向。`placement.mjs` は `brw.mjs` を import しない（`cleanup.mjs` は `brw.mjs` を import しない決まりのため、循環を避ける）。

### 構成図

```mermaid
flowchart TD
  A[PreToolUse の入力] --> B{tool_name}
  B -- Bash --> C[classifyCommand と evaluateAll]
  B -- EnterWorktree --> G[judgeEnterWorktree]
  C -- 拒否: branch-create / branch-resume --> D[planGate]
  C -- それ以外 --> Z[既存の応答]
  D -- 置き換え可 かつ ホスト=claude --> E[rewrite: updatedInput と allow]
  D -- 置き換え不可 --> F[deny: 自然文の案内]
  G -- name 指定 / 不正な path --> F
  G -- BRW の worktree への path --> Z
```

- **選んだ形**: 判定層はそのまま、フック層に `planGate` を足す。
- **維持する既存の形**: 判定は `decideHook` → `responseOf` の 2 段。判定できない入力は止める（安全側）。
- **新しい部品の理由**: 置き換えの条件・コマンド組み立て・案内の書式は判定層にもフックの入出力にも置きたくないため、独立のモジュールにする。

### 技術スタック

| 層 | 選択 | 役割 | 備考 |
|---|---|---|---|
| CLI・フック | Node.js 22 以上、`.mjs`、標準モジュールのみ | 判定・書き換え・案内 | 既存どおり |
| ホスト機能 | Claude Code の PreToolUse `updatedInput` | 入力の書き換え | PoC #1・#2・#5・#9 で確認（2.1.329） |
| 試験 | `tests/*.mjs`（自己テスト）、`claude -p` による実機確認 | 契約・結果の検証 | 実機は `tests/real-env/` の方式 |

## ファイル構成計画

### ディレクトリ構成

```
scripts/
├── branch-gate.mjs        # 新規: ゲートの計画（置き換え可否・コマンド組み立て・案内の書式・EnterWorktree の判定）
├── carry.mjs              # 新規: 未コミットの変更の移動（退避の作成・適用・照合・取り除き・巻き戻し）
├── placement.mjs          # 新規（2026-11-28）: 配置先の決定・配下の判定・旧置き場の判定と案内・無視の検出と警告
├── brw.mjs                # 変更: create に --carry を追加し、carry.mjs を呼ぶ。配置先を placement.mjs から得る。resume の旧置き場の拒否、無視の警告
├── operation-policy.mjs   # 変更: createOp が開始点（start）を記録する
├── agent-hooks.mjs        # 変更: judgeBash がゲートを呼ぶ、EnterWorktree を判定、responseOf が rewrite 応答を作る
├── hook-install.mjs       # 変更: CLAUDE_HOOKS に EnterWorktree の matcher を追加
├── cleanup.mjs            # 変更（2026-11-28）: finishBlocker が旧置き場の worktree を持つブランチを対象外にする
hooks/
└── hooks.json             # 変更: PreToolUse に EnterWorktree の matcher を追加
tests/
├── carry.mjs              # 新規: 移動の安全確認（照合・巻き戻し・並行変更）の試験
├── placement.mjs          # 新規（2026-11-28）: 配置先モジュールの単体試験と、旧置き場の文字列が scripts/ に残っていない検査
├── branch-gate.mjs        # 新規: ゲートの計画の単体・契約テスト
├── agent-hooks.mjs        # 変更: rewrite 応答・EnterWorktree の契約テストを追加
└── selftest.mjs           # 変更: 新規テストを呼ぶ
evals/
└── redirects-git-switch-to-brw-create/   # 新規: 評価ケース
SKILL.md                   # 変更: 作成・再開の挙動を追記。配置先・旧置き場からの移行・無視設定の要否・警告・EnterWorktree の承認の注意（2026-11-28）
.claude-plugin/plugin.json   # 変更（2026-11-28）: 配置先の変更を含む機能の追加として版を上げる（配布の最新化の判定が版を見るため）
references/setup.md        # 変更: 入口の導入検査と Codex の違いを追記
```

### 変更するファイル

- `scripts/operation-policy.mjs` — `createOp` の結果に `start`（開始点の文字列。無ければ `null`）と `branchOnly`（`git branch <名前>` の形）を加える。判定の挙動は変えない。
- `scripts/agent-hooks.mjs` — `judgeBash(command, cwd, host)` に host を渡し、拒否（`branch-create`・`branch-resume`）のとき `planGate` の結果で置き換える。`decideHook` に `EnterWorktree` の分岐を追加する。`responseOf` に `rewrite` を追加する。
- `scripts/hook-install.mjs`・`hooks/hooks.json` — Claude Code の登録一覧に `PreToolUse` / `EnterWorktree` を加える。Codex の一覧は変えない。
- （2026-11-28）`scripts/brw.mjs` — `create`（465〜470 行付近）・`resume`（654・672 行付近）の配置先を `placement.mjs` から得る。`resume` は、ブランチの既存 worktree が旧置き場なら拒否する。worktree の作成・再作成の成功の後に、無視されていなければ警告する。
- （2026-11-28）`scripts/branch-gate.mjs` — 置き換えの配置先の照合（作成・再開）と、`judgeEnterWorktree` の配置先（`name` 指定の案内の worktree のパス、`path` 指定の `underPlacement`）を `placement.mjs` に差し替える。旧置き場を指す `path`・再開先を、専用の拒否（`gate-legacy-placement`・`gate-enter-legacy`）にする。
- （2026-11-28）`scripts/cleanup.mjs` — `finishBlocker` に旧置き場の判定を足す（`--merged` の一覧では「残します」の理由になる）。ブランチも消さない。
- （2026-11-28）`scripts/carry.mjs` — 未追跡の一覧から除く前方一致の文字列を、配置先モジュールの値にする。
- （2026-11-28）`scripts/agent-hooks.mjs` — `mainOfStart` の `CLAUDE_PROJECT_DIR` の形を `<本体>/.worktree/<別名>` にする（`poc/design_01.md` の 2）。`.brw/` の本文置き場（145 行付近）は変えない。

## システムフロー

```mermaid
sequenceDiagram
  participant Agent as エージェント
  participant Hook as フック(agent-hooks)
  participant Gate as planGate
  participant Brw as brw create/resume
  Agent->>Hook: Bash「git switch -c dev/foo」
  Hook->>Gate: 分類結果・宣言・host
  Gate-->>Hook: rewrite(command, notice)
  Hook-->>Agent: allow と updatedInput
  Agent->>Brw: cd 本体 && brw create dev/foo && cd worktree && echo 案内
  Brw-->>Agent: 作成と作業場所の移動、案内文
```

- 置き換えのコマンドは `&&` でつなぐため、`brw create` が失敗すれば `cd` も案内も実行されず、作業場所は動かない（PoC #9）。
- 置き換えは、元のコマンドを実行する前に 1 回だけ判定される。書き換え後のコマンドは再判定されない（BRW 自身の CLI のみで、許可を返す）。

## 要件トレーサビリティ

| 要件 | 概要 | 部品 | インターフェース |
|---|---|---|---|
| 1.1 | 命名規則に合う作成を置き換える | `planGate`、`agent-hooks.judgeBash` | `planGate` → `rewrite` |
| 1.2 | 作業場所を worktree へ移す | `planGate`（`cd` の組み立て） | 書き換えコマンドの `cd <worktree>` |
| 1.3 | 置き換えを自然文で表示する | `planGate`（案内文） | `echo` で出力 |
| 1.4 | 規則外・分岐元不明・複合は拒否 | `planGate`（適格性の判定） | `deny` |
| 1.5 | 配置先（`.worktree/`）以外（旧置き場を含む）・移動を確認できない環境は拒否 | `planGate`（配置先の照合）、`placement.mjs`（`placementOf`） | `deny` |
| 1.6 | 書き換え非対応のホストは拒否 | `agent-hooks`（host 判定） | `deny` |
| 1.7 | 未導入リポジトリは何もしない | 既存の `repoState`（`unmanaged`） | 既存どおり通過 |
| 1.8 | 追跡済みの未コミット変更があれば拒否し 2 択を案内 | `planGate`（`gate-dirty`）、`guidance` | `deny` |
| 1.9 | 未追跡だけなら置き換え、残ることを案内 | `planGate` | `rewrite` の `notice` |
| 1.10 | `--carry`: 適用・照合後にだけ取り除く | `carry.mjs`、`brw.mjs`（`create`） | `carryChanges` |
| 1.11 | 失敗・不一致・分岐元のずれは巻き戻す | `carry.mjs`、`brw.mjs`（`create`） | `CarryResult.failed` |
| 1.12 | 並行して変わったら取り除かない | `carry.mjs` | `CarryResult.keptBoth` |
| 1.13 | 未追跡は移さず一覧を表示 | `carry.mjs` | `CarryResult.skipped` |
| 2.1 | EnterWorktree の `name` は拒否し 2 手を案内 | `judgeEnterWorktree` | `deny` |
| 2.2 | 配置先の BRW の worktree への `path` は許可 | `judgeEnterWorktree`、`placement.mjs`（`isUnderPlacement`） | 通過 |
| 2.3 | それ以外の `path` は拒否 | `judgeEnterWorktree` | `deny` |
| 2.4 | 入力を確定できなければ止める | `judgeEnterWorktree` | `deny` |
| 2.5 | 入口が増えても同じ規則・書式 | `branch-gate.mjs`（案内の書式を共有） | `guidance` |
| 2.6 | 旧置き場を指す `path` は拒否し移動の手順を案内 | `judgeEnterWorktree`、`placement.mjs`（`isLegacyPlacement`・`legacyMoveGuidance`） | `deny`（`gate-enter-legacy`） |
| 3.1 | 既存の開発ブランチ切り替えを再開へ | `planGate`（`resume` の組み立て） | `rewrite` / `deny` |
| 3.2 | 保護・分岐元は通常承認 | 既存の `evalCreate` | 既存どおり |
| 3.3 | 切り替え先を確認できなければ止める | 既存の `createOp`（未解決） | 既存どおり |
| 3.4 | detached HEAD は作成と見なさない | 既存の `createOp`（`detach`） | 既存どおり |
| 4.1〜4.5 | 案内の中身・書式・再現性 | `guidance`（書式）、`sanitize` | 案内の書式 |
| 5.1 | 確定できなければ止める | `planGate`、`decideHook` の例外処理 | `deny` |
| 5.2 | 失敗しても作成途中を残さない | `brw create` の失敗は何も作らない（PoC #9）。`&&` で後続を止める | 書き換えコマンド |
| 5.3 | 宣言が無ければ通す | 既存の `repoState` | 既存どおり |
| 5.4 | ホスト間で同じ判定（置き換え可否を除く） | 判定層を共有、フック層だけが host で分岐 | `decideHook` |
| 5.5 | 照会は妨げない | 既存の `query` 分類 | 既存どおり |
| 6.1・6.2 | 入口の導入検査と有効化手順 | `hook-install.CLAUDE_HOOKS`、既存の診断 | 不足の報告 |
| 6.3・6.4 | 資料 | `SKILL.md`、`references/setup.md` | — |
| 6.5 | 資料に配置先・手動の移行・無視設定の要否・警告 | `SKILL.md`、`references/setup.md` | — |
| 7.1 | `create` は `.worktree/<別名>` に作る | `brw.mjs`（`create`）、`placement.mjs`（`placementOf`） | `placementOf` |
| 7.2 | `resume` の再作成も同じ配置先 | `brw.mjs`（`resume`）、`placement.mjs` | `placementOf` |
| 7.3 | 連携 worktree から実行しても入れ子にしない | `brw.mjs`（本体は worktree 一覧の先頭から得る）、`placement.mjs` | `placementRoot(main)` |
| 7.4 | 旧置き場を配置先として扱わない | `placement.mjs`、`branch-gate.mjs`、`brw.mjs`（再利用の判定） | `isUnderPlacement`・`isLegacyPlacement` |
| 7.5 | `resume` が旧置き場の使用中ブランチを拒否し移動の手順を案内 | `brw.mjs`（`resume`）、`placement.mjs`（`legacyMoveGuidance`）、`branch-gate.mjs`（置き換えの再開先） | 拒否・`gate-legacy-placement` |
| 7.6 | `finish`（`--merged` 含む）が旧置き場の worktree とブランチを片付けない | `cleanup.mjs`（`finishBlocker`）、`placement.mjs` | `finishBlocker` の理由 |
| 7.7 | 旧置き場の worktree が他のブランチの操作を妨げない | `brw.mjs`・`branch-gate.mjs`（旧置き場の判定をブランチごとに限る） | — |
| 7.8 | 未追跡の一覧から配置先を除く | `carry.mjs`、`placement.mjs`（`placementPrefix`） | 一覧の除外 |
| 7.9 | 導入先の無視設定を書き換えない | 該当する書き込み処理を持たない（試験で確認） | — |
| 7.10 | 配置先が無視されていなければ警告し、作成は続ける | `brw.mjs`（`create`・`resume`）、`placement.mjs`（`ignoreStatus`・`ignoreWarning`） | `ignoreStatus` |

## 部品とインターフェース

| 部品 | 層 | 役割 | 要件 | 主な依存 | 契約 |
|---|---|---|---|---|---|
| `planGate` | ゲート | 作成・再開の入力を置き換え・拒否に決める | 1、3、4、5 | `lib.mjs`（P0）、分類結果（P0） | Service |
| `judgeEnterWorktree` | ゲート | EnterWorktree の入力を判定する | 2、4、5 | `lib.mjs`（P0） | Service |
| `guidance` | ゲート | 案内文の書式を作る | 4 | なし | Service |
| `placement.mjs`（2026-11-28） | 配置先 | 配置先の決定・配下の判定・旧置き場の判定と案内・無視の検出と警告 | 1.5、2.2、2.6、6.5、7 | `lib.mjs`（P0）、git（P0） | Service |
| `judgeBash`（変更） | フック | 拒否を置き換えへ変換する | 1、3、5 | `planGate`（P0） | State |
| `responseOf`（変更） | フック | `rewrite` をホストの応答にする | 1 | なし | API |

### ゲート（`scripts/branch-gate.mjs`）

#### planGate

| 項目 | 内容 |
|---|---|
| 役割 | 拒否された作成・再開の操作を、置き換え可能なら置き換えの計画にし、そうでなければ案内つきの拒否にする |
| 要件 | 1.1〜1.6、3.1、4.1〜4.5、5.1 |

**責務と制約**
- 入力は分類結果の 1 件（`kind: "create"`）、宣言、host、git の現在の状態（現在のブランチ・既存ブランチ・worktree 一覧）。副作用を持たない（ファイルを書かない、git を変えない）。
- 置き換えの適格性（すべて満たすとき）:
  1. host が `claude`。
  2. コマンド全体が単独の git 操作（先頭の `cd` を除く）で、分類に未解決（`unresolved`）が無い。
  3. 対象リポジトリが BRW 導入済み（`managed`）。
  4. ブランチ名が宣言の開発ブランチとして有効（`classifyBranch` が `development`、命名規則に合う）。接頭辞は補わない（`foo` を `dev/foo` に変えない）。
  5. 開始点が無く現在のブランチが宣言の `baseBranch` であるか、開始点が `baseBranch` または `origin/<baseBranch>` である（それ以外は `brw create <名前> --base <ブランチ>` を案内して拒否）。
  6. `action` が `create` か `resume`。`rename`・`copy`・`--orphan`・強制作成（`-C`・`-B`）は拒否。
  7. `via` が `worktree` のとき、パスが配置先（`placementOf(<本体>, <ブランチ>)` = `<本体>/.worktree/<alias>`）と一致する。一致しなければ拒否（旧置き場を指すときも、配置先外として拒否）。
- `action: "create"` でも、ブランチがローカルまたは `origin` に既にあるとき（リモートにだけある切り替えを含む）は `resume` として扱う。
- 置き換えのコマンドは `cd <操作の作業ディレクトリ> && …` で始める（`brw create` と `--carry` の移動元を、操作を行った作業ツリーに一致させる）。`brw create` は配置先を常に本体の `.worktree/` にする（連携 worktree から実行しても入れ子にならない。7.3）。`branchOnly` は作業場所を変えないよう、`( cd <作業ディレクトリ> && node <brw> create <名前> --branch-only && printf … )` と**サブシェル**で実行する。
- **再開先の配置先の照合（2026-11-28）**: 再開は、ブランチの既存 worktree があればそこ、無ければ `placementOf(<本体>, <ブランチ>)`。既存 worktree が旧置き場（`isLegacyPlacement`）のときは、置き換えず `gate-legacy-placement` で拒否する（`brw resume` が同じ理由で拒否するため。案内は `legacyMoveGuidance`）。
- 開始点は `brw create` の規則（取得した最新の `origin/<分岐元>`）に従う。ローカルの分岐元が `origin` より古いと、元の `git switch -c` とは違う先端から作られるため、案内の本文に「分岐元は、`brw create` が選ぶ開始点（取得できた最新の origin/<分岐元> の先端。取得できないときは手元に残っている origin/<分岐元>、無ければ手元の <分岐元>）から作る」ことを書く（拒否はしない。`--carry` は開始点が元の HEAD と同じときだけ移すので、ずれがあれば失敗して知らせる）。
- `branchOnly`（`git branch <名前>`）は、git の意味（ブランチを作るだけで切り替えない）に合わせて `brw create <名前> --branch-only` に置き換え、`cd` は付けない（要件 1.2 の例外として明記済み）。
- 追跡済みファイルの未コミットの変更（`git status --porcelain` の `??` 以外。操作の作業ディレクトリの作業ツリーで調べる）があり、かつ**ブランチを切り替える作成**のときは、置き換えず拒否する（`gate-dirty`）。切り替えない作成（`git branch <名前>`）は作業ツリーに触れないので、未コミットの変更の有無に関わらず置き換える。案内は 2 つの選択肢: 「`brw create <名前>`（変更は元の作業ツリーに残る）」と「`brw create <名前> --carry`（変更を新しい worktree へ移す）」。どちらを選ぶかは、変更が自分のものかを知っている呼び出し側に委ねる。
- 未追跡のファイルだけがあるときは置き換え、案内に「未追跡のファイル N 件は元の作業ツリーに残る」と書く。

**契約**: Service

```typescript
type GateHost = "claude" | "codex";

interface GateInput {
  host: GateHost;
  command: string;            // 元の Bash コマンド
  toolInput: Record<string, unknown>;
  op: CreateOperation;        // 分類結果（action, via, branch, path, start, branchOnly, cwd）
  config: NormalizedConfig;
  hasLeadingCd: boolean;
  unresolved: string[];
}

type GateResult =
  | { verdict: "rewrite"; command: string; reason: string; notice: string[] }
  | { verdict: "deny"; reason: string; code: GateDenyCode };

type GateDenyCode =
  | "gate-name-invalid" | "gate-start-unsupported" | "gate-compound"
  | "gate-outside-placement" | "gate-host-no-rewrite" | "gate-unresolved"
  | "gate-action-unsupported" | "gate-dirty" | "gate-legacy-placement";

function planGate(input: GateInput): GateResult;
```
- 事前条件: `op.kind` が作成・再開で、判定層が拒否している（`branch-create`・`branch-resume`）。
- 事後条件: `rewrite` のコマンドは `cd <dir> && node <brw> create|resume <引数> [&& cd <worktree>] && echo <案内>` の形。引数・パスは単引用符で引用する。他のコマンドを含まない。
- 不変条件: 拒否の `reason` は自然文で、次に実行するコマンドを含む。

#### judgeEnterWorktree

| 項目 | 内容 |
|---|---|
| 役割 | EnterWorktree の入力を判定する |
| 要件 | 2.1〜2.5、5.1、5.3 |

**責務と制約**
- 対象リポジトリが BRW 導入済みでなければ通過（5.3）。
- `name` 指定: 拒否。案内は、`brw create <名前>` を実行した後に `EnterWorktree` を `path`（作成される worktree の絶対パス）指定で呼ぶ 2 手。名前が `namePattern` に合わないときは、合う名前の付け方（小文字・数字・`-`）も案内する。
- `path` 指定: `git worktree list` に載り、そのブランチが開発ブランチ（`classifyBranch` が `development`）で、配置先（`isUnderPlacement`: `<本体>/.worktree/` の配下）にあるときだけ通過。それ以外は拒否し、`brw resume` を案内する。**旧置き場の worktree を指すとき（`isLegacyPlacement`）は専用の拒否（`gate-enter-legacy`、要件 2.6）**で、旧パス・新しい配置先・移動の手順（`legacyMoveGuidance`）を案内する。
- **承認の注意（2026-11-28、`poc/design_01.md`）**: `name` 指定の 2 手の案内と、`path` の拒否の案内の理由の行に、「Claude Code は `.claude/worktrees/` の外の `path` への EnterWorktree で利用者の承認を求める（BRW のフックの許可では省けない）。承認できない環境では、`brw create` が移した作業場所（Bash の `cd`）で作業する」を加える。BRW は `path` が配置先の開発ブランチの worktree のときに通過（応答なし）にするが、その後の承認は Claude Code が求める。
- `name` も `path` も無い（ランダム名の作成）、両方ある、型が不正: 拒否。
- 例外が出たら拒否（安全側）。

**契約**: Service

```typescript
interface EnterWorktreeInput { name?: unknown; path?: unknown }
type EnterDecision =
  | { verdict: "pass" }
  | { verdict: "deny"; reason: string; code: "gate-enter-name" | "gate-enter-path" | "gate-enter-legacy" | "gate-enter-unresolved" };
function judgeEnterWorktree(input: EnterWorktreeInput, cwd: string | null): EnterDecision;
```

#### placement（`scripts/placement.mjs`、2026-11-28）

| 項目 | 内容 |
|---|---|
| 役割 | 配置先の決定・配下の判定・旧置き場の判定と案内・無視の検出と警告を 1 か所に持つ |
| 要件 | 1.5、2.2、2.6、7.1〜7.8、7.10 |

**責務と制約**
- 配置先は `<本体>/.worktree/<別名>`（別名は `aliasOf`）。旧置き場は `<本体>/.claude/worktrees/` の配下。`.brw/` の置き場は扱わない（`brw-pr-handoff` が持つ）。
- 本体は、呼び出し側が `git worktree list` の先頭から得た値を渡す（連携 worktree の中からでも本体になる。`poc/design_02.md` の 4。要件 7.3）。
- 配下の判定は実体のパス（realpath）で行い、配置先ディレクトリがシンボリックリンクで本体の外を指すときは配下と認めない（現行の `placementSound` の規則を引き継ぐ）。存在しないパスは文字列で比べる。
- 副作用を持たない（`ignoreStatus` が git を読む以外は、ファイルを書かない・git を変えない）。導入先の `.gitignore`・`info/exclude` は書かない（要件 7.9）。

**契約**: Service

```typescript
type IgnoreStatus = "ignored" | "not-ignored" | "unknown";

/** 配置先のディレクトリ（`<main>/.worktree`） */
function placementRoot(main: string): string;
/** ブランチの worktree の配置先（`<main>/.worktree/<別名>`） */
function placementOf(main: string, branch: string): string;
/** 未追跡の一覧から除く前方一致の文字列（`.worktree/`） */
function placementPrefix(): string;
/** target が配置先の配下か */
function isUnderPlacement(main: string, target: string): boolean;
/** target が旧置き場（`<main>/.claude/worktrees/` の配下）か。`.brw/` は worktree ではないため含めない */
function isLegacyPlacement(main: string, target: string): boolean;
/** 旧置き場の worktree を移す手順の案内（旧パス・新しい配置先・手順） */
function legacyMoveGuidance(main: string, branch: string, oldPath: string): { reason: string; next: string[] };
/** 配置先が無視されているか。`git check-ignore -q -- .worktree/<別名>` の終了コード（0 無視、1 無視されない、その他は不明） */
function ignoreStatus(main: string, alias: string): IgnoreStatus;
/** `ignoreStatus` が `not-ignored` のときの警告文（複数行） */
function ignoreWarning(): string[];
```
- 事前条件: `main` は本体の作業ツリーの絶対パス。
- 事後条件: `placementOf` の結果は常に `placementRoot(main)` の配下。`isUnderPlacement(main, placementOf(main, b))` は真。`isLegacyPlacement` と `isUnderPlacement` は同時に真にならない。
- 不変条件: 旧置き場のパスの文字列は、このモジュールだけが持つ（`scripts/` の他のファイルに `.claude/worktrees` は残らない。`.brw/` の定数を除く）。

**案内の文面**
- `legacyMoveGuidance`: 「作業ブランチ <ブランチ> の worktree は旧置き場 <旧パス> にあり、BRW の配置先（<新パス>）ではないため扱えません。次の手順で移してから、もう一度実行してください。1) ロックされていれば `git worktree unlock <旧パス>`。2) `git worktree move <旧パス> <新パス>`（未コミットの変更・未追跡のファイルはそのまま移る）。3) `brw resume <ブランチ>`」。BRW は自動で移さない（要件 6.5）。`poc/design_02.md` の 5。
- `ignoreWarning`: 「`.worktree/` が導入先で無視されていません。本体の作業ツリーで `git add -A` などを実行すると、worktree が埋め込みリポジトリとして誤って追加されます。`.worktree/` を無視する設定（`.gitignore` への `/.worktree/` の追記など）を導入先に追加してください。BRW はこの設定を書き換えません。」`poc/design_02.md` の 2。

**利用箇所の振る舞い**
- `brw create`: 配置先 `placementOf` に worktree を作る。作成に成功した後に `ignoreStatus` が `not-ignored` なら `ignoreWarning` を標準出力に出す（作成は続いている）。`--branch-only` では出さない。
- `brw resume`: 既存 worktree がブランチ名で見つかり、それが旧置き場なら、worktree を作らず `legacyMoveGuidance` で拒否する（終了コード 1）。旧置き場以外の既存 worktree の再利用は従来どおり。ローカル・リモートから再作成する経路は `placementOf` に作り、成功後に `create` と同じ警告を出す。他のブランチの `resume` は旧置き場の worktree の存在に影響されない（要件 7.7）。
- `brw finish`: `finishBlocker` が、対象ブランチの worktree が旧置き場のとき「worktree は旧置き場にあるため BRW は片付けません。移すか、`git worktree remove` で手動で片付けてください（ブランチも消しません）」を返す。`finish --merged` は「残します: <ブランチ> — <理由>」の行になる。
- `carry.mjs`: 未追跡の一覧から `placementPrefix()` で始まるパスを除く。
- `agent-hooks.mjs` の `mainOfStart`: `CLAUDE_PROJECT_DIR` が `<本体>/.worktree/<別名>` の形のときに本体を導く（`poc/design_01.md` の 2）。

#### carryChanges（`scripts/carry.mjs`）

| 項目 | 内容 |
|---|---|
| 役割 | `brw create --carry` で、追跡済みファイルの未コミットの変更を新しい worktree へ安全に移す |
| 要件 | 1.10〜1.13 |

**方式**（research.md の検討を採用）
1. 退避の作成: 元の作業ツリーで `git stash create` を実行し、変更を表すコミット `S` を得る（退避の置き場 `refs/stash` は使わない。他のセッションと共有されるため）。出力が空なら移す変更は無い。
2. 前提の確認: `brw create` が決めた開始点のコミットが、元の作業ツリーの `HEAD` と同じであること。違えば移さず失敗（分岐元がずれていると適用が混ざるため）。
3. 適用: 新しい worktree で `git stash apply <S>`。競合・失敗なら失敗。
4. 照合: `S` が変更した全パスについて、新しい worktree の内容（ファイルの OID・実行権限）が `S` と一致し、`S` で削除されたパスは存在しないこと。存在の判定は `git cat-file -e S:<パス>` による（削除されたパスに `rev-parse` を使わない。research.md の検証）。
5. 取り除き: 元の作業ツリーで、もう一度 `git stash create` した結果のツリーが `S` と同じときだけ進む。進む前に `refs/brw/carry/<ブランチ>` を `S` に向けて**復旧用の参照を作る**（`refs/stash` ではないので共有の退避を壊さない）。続いてパスごとに、現在のファイルの OID が `S` のものと同じことを確認してから `git restore --staged --worktree --source=HEAD -- <パス>` で戻す（`reset --hard` は使わない）。1 つでも違えば、そのパスは戻さず `keptBoth` にする。
   - 限界（要件 1.12）: 再照合・OID 確認から復元までの間（ミリ秒単位）の書き込みは、ロックが無い以上ゼロにできず、その間の編集は復元で失われうる（参照は `S`＝移した時点の内容を指すだけで、その編集は含まない）。取り除きは「移した内容と一致するパスだけ」を対象にし、途中で違いを見つけたら**それ以降のパスを戻さず**、戻したパスと残したパスの一覧を `keptBoth` で返す。残りのリスクは、同じ本体の作業ツリーを複数のセッションが同時に編集しないという運用の前提として、利用者向けの資料と案内に明記する。
   - 復旧の案内: 「移した内容は `git stash apply refs/brw/carry/<ブランチ>` で再度取り出せる」。参照は、利用者が作業を確認した後に `brw finish` が削除する。
6. 失敗時の巻き戻し: 手順 2〜4 の失敗では、作成した worktree とブランチを削除する。元の作業ツリーには手順 5 まで触れない。`brw create` 自体も、worktree 作成後の失敗で、作った worktree とブランチを削除する巻き戻しを持つように変更する（`brw.mjs` の `create`。要件 1.11・5.2 のため）。順序は次のとおり: 宣言ファイルを worktree へ移していれば、**先に元の場所へ戻す**。戻せたときだけ worktree とブランチを削除する。戻せないときは、worktree を削除せず、宣言ファイルの場所と手動の復旧手順を表示して止まる（未追跡の宣言ファイルを失わない）。

**契約**: Service

```typescript
type CarryResult =
  | { kind: "none" }                                              // 移す変更が無い
  | { kind: "carried"; files: string[]; skipped: string[] }       // skipped は未追跡
  | { kind: "keptBoth"; files: string[]; skipped: string[] }      // 元にも残した
  | { kind: "failed"; reason: string };                           // 巻き戻し済み
function carryChanges(opts: { source: string; worktree: string; startOid: string }): CarryResult;
```
- 不変条件: `carried` 以外では、元の作業ツリーの内容は呼び出し前と同じ。ステージ済みの変更は、移動後は未ステージの変更になる（案内に書く）。

#### guidance（案内の書式）

固定の書式を持つ 1 つの関数で、置き換え・拒否・EnterWorktree の案内を作る。

```
[branch-release-workflow] <1 行の結論（自然文）>
BRW 案内: 置き換え | 拒否
次のコマンド: <そのまま実行できる 1 コマンド。2 手のときは「1) …」「2) …」>
作業場所: <移る先の絶対パス。無ければ ->
<理由と注意の自然文（複数行可）>
```

- 見出しの行は呼び出し側が機械的に取り出すための補助で、本文だけで意味が通る（research.md #6）。
- cc-sdd・kiro・`.kiro` などの特定の呼び出し側の語を含めない。同じ入力には同じ文面を返す（4.5）。
- 資格情報らしい文字列は既存の `sanitize` で伏せる。

### フック

#### judgeBash / responseOf（変更）

- `judgeBash` は、判定が拒否で `code` が `branch-create` または `branch-resume` のときだけ `planGate` を呼ぶ。結果が `rewrite` なら `{ verdict: "rewrite", command, reason }`、`deny` なら案内つきの拒否（既存の `decisionOf` と同じ形）にする。
- `responseOf` は `rewrite` を次の応答にする（Claude Code のみ。Codex には届かない）。

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
  "permissionDecision": "allow",
  "permissionDecisionReason": "[branch-release-workflow] …",
  "updatedInput": { "...元の tool_input": "", "command": "<書き換え後>" } } }
```

- 許可を返す理由: 書き換え後のコマンドは BRW 自身の CLI の 2 種類（`create`・`resume`）と `cd`・`echo` だけで、組み立ては判定済みの値の引用に限る。確認を求めると呼び出し側の指示が止まる。
- `decideHook` に `tool === "EnterWorktree"` の分岐を足し、`judgeEnterWorktree` の拒否を既存の `decisionOf` と同じ形にして返す。`pass` は応答なし。

**実装メモ**
- 連携: `createOp` の `start`・`branchOnly` を `planGate` が読む。
- 検証: 書き換え後のコマンドの文字列を、引用の往復（シェルで解釈して元の引数に戻ること）で試験する。
- リスク: `--carry` は元の作業ツリーを書き換える唯一の処理。取り除きの直前の再照合（手順 5）で、並行する他のセッションの変更を失わないようにする。
- 既存の挙動: 宣言ファイルが分岐元に未登録のとき、`brw create` は元の作業ツリーの未追跡の宣言ファイルを worktree へ移す。1.9 の「未追跡のファイルが元に残る」の唯一の例外で、案内に含める（`brw create` の既存の出力をそのまま流す）。
- Codex の手順書の経路（`brw guard`）は、現在は commit・push の旧来の判定だけを呼ぶ。作成・再開の拒否を同じ文面で返すため、`guard` は先に共通の判定（`classifyCommand` と `evaluateAll`）を呼び、拒否があれば案内を表示して終了する形に変える。この変更は brw-pr-handoff（`gh pr create` の拒否）と共有する入口なので、先に実装する側が作り、他方は再利用する。
- 判定層の拒否のうち、対象を確定できない拒否（`unresolved`）は `planGate` に渡さず、既存の理由に共通の案内の見出し（書式の 4 行）を付けて返す。これにより、どの拒否でも見出しと「次のコマンド」の行が揃う（要件 4.2）。
- `--carry` は、分岐元の取得後の開始点（`origin/<分岐元>`）が元の作業ツリーの `HEAD` と同じときだけ移す。手元の分岐元が古いときは失敗し、案内に「先に `git pull` するか、移さずに作る」を含める。
- EnterWorktree の `path` の許可は、「`.claude/worktrees/` の配下にあり、`git worktree list` に載り、開発ブランチを指す」ことを BRW の来歴の確認とする（BRW が作ったという記録は持たない。`brw resume` が作る worktree も同じ条件を満たす）。

## データモデル

永続データは持たない。フック間で受け渡す値は次の 2 つ。

- 分類結果（拡張）: `start: string | null`、`branchOnly: boolean`。
- 判定結果（拡張）: `verdict` に `rewrite` を追加（`command`・`reason`）。

## エラー処理

| 区分 | 例 | 応答 |
|---|---|---|
| 規則に合わない | 名前が `namePattern` 外、開始点が分岐元以外 | 拒否。合う名前または `--base` の付け方を含む案内 |
| 確定できない | 複合コマンド、動的引数、EnterWorktree の型不正 | 拒否。確定できない理由を表示（安全側） |
| 実行時の失敗 | `brw create` が既存ブランチなどで終了コード 1 | 書き換えコマンドの `&&` で後続を止める。`brw create` の出力が理由になる |
| 内部エラー | フック内の例外 | 既存どおり、Git の操作を含む入力は拒否 |
| 旧置き場の worktree（2026-11-28） | `resume` の対象ブランチが旧置き場で使用中、EnterWorktree の `path` が旧置き場、`finish` の対象ブランチが旧置き場 | 拒否（`finish` は対象外）。旧パス・新しい配置先・移動の手順を案内。何も作らず・消さない |
| 配置先が無視されていない（2026-11-28） | `check-ignore` が 1 | 警告のみ（作成は続ける）。0 は何も出さず、判定不能（128 など）は警告も止めもしない |

## テスト戦略

### 単体・契約（`tests/branch-gate.mjs`）
- `planGate`: 適格な `git switch -c dev/foo`（本体で `baseBranch` 上）が `rewrite` になり、コマンドが `cd <本体> && node <brw> create 'dev/foo' && cd '<wt>' && echo …` の形であること（1.1〜1.3）。
- `planGate`: 名前が規則外・開始点が分岐元以外・`worktree add` のパスが配置先外・複合コマンド・host が `codex` のとき `deny` で、案内に次のコマンドがあること（1.4〜1.6、4.1）。
- `planGate`: 既存ブランチへの切り替えが `brw resume` に置き換わり、リモートにだけあるブランチも `resume` になること（3.1）。
- 引用の往復: 空白・単引用符を含むパスでも、書き換えコマンドをシェルで解釈して元の引数に戻ること。
- `judgeEnterWorktree`: `name` は拒否、BRW の worktree への `path` は通過、それ以外の `path`・入力不正は拒否（2.1〜2.4）。
- 案内の書式: 見出し 4 行があり、特定の呼び出し側の語を含まず、同じ入力で同じ文面になること（4.2〜4.5）。

### 移動（`tests/carry.mjs`）
- 取り除きの直前に元のファイルを書き換えると、そのパス以降は戻されず、戻したパスと残したパスの一覧が出ること。`refs/brw/carry/<ブランチ>` から移した内容を取り出せること（1.12）。
- `brw create` が worktree 作成後に失敗（宣言ファイルの移動後の失敗を模擬）したとき、宣言ファイルが元の場所へ戻り、worktree とブランチが残らないこと。戻せないときは worktree を残して手順を表示すること（1.11、5.2）。
- `brw guard "git switch -c dev/x"` と `brw guard "gh pr create …"` が拒否になること（Codex の手順書の経路、1.6）。
- 追跡済みの変更（変更・削除・実行権限・バイナリ）が新しい worktree に同じ内容で現れ、元から取り除かれること（1.10）。
- 開始点が `HEAD` と異なるとき、適用が競合したとき、照合が一致しないときに、worktree とブランチが残らず元が変わらないこと（1.11）。
- 照合と取り除きの間に元のファイルを書き換えると、何も取り除かず `keptBoth` になること（1.12）。
- 未追跡のファイルは移らず、一覧が表示されること（1.13）。

### 配置先（`tests/placement.mjs`、2026-11-28）
- `placementOf`・`isUnderPlacement`・`isLegacyPlacement` の単体: 配置先は `.worktree/<別名>`、旧置き場は `.claude/worktrees/` の配下、`.brw/` は旧置き場の worktree に含めない。配置先ディレクトリがシンボリックリンクで本体の外を指すときは配下と認めない（1.5、2.2、7.4）。
- 連携 worktree の中から `brw create`・`brw resume` を実行しても、`<本体>/.worktree/` に作り、入れ子を作らない（7.3）。
- `resume` が旧置き場の使用中ブランチを拒否し、旧パス・新しい配置先・`git worktree move`（ロックのときは `unlock`）の手順を案内し、worktree もブランチも変えないこと。他のブランチの `create`・`resume` が、旧置き場の worktree があっても通ること（7.5、7.7）。
- `finish`・`finish --merged` が旧置き場の worktree を持つブランチを片付けず（worktree もブランチも残す）、理由を表示すること（7.6）。
- 置き換えの `git switch -c`（本体）が `.worktree/<別名>` に作る書き換えコマンドになり、旧置き場を指す `git worktree add` は配置先外として拒否されること（1.5）。
- EnterWorktree: `.worktree/` の下の開発ブランチの worktree への `path` は通過、旧置き場を指す `path` は `gate-enter-legacy` の拒否（旧パス・新パス・手順つき）、それ以外は従来の拒否（2.2、2.3、2.6）。案内の理由に承認の注意が含まれること（D3）。
- `--carry` と置き換えの案内の未追跡の件数に、`.worktree/` の配下が含まれないこと（7.8）。
- 無視の警告: 無視されていない本体で `create`・`resume`（作成・再作成）が成功後に警告を出して作成は続き、`.gitignore` の `/.worktree/`・`info/exclude` の `.worktree/` で無視されているときは出さないこと。`--branch-only`・既存 worktree の再利用では出さないこと。導入先の `.gitignore`・`info/exclude` が書き換わらないこと（7.9、7.10）。
- `scripts/` に旧置き場の文字列 `.claude/worktrees` が `placement.mjs` と `.brw/` の定数以外に残っていないことの機械的な検査。
- `mainOfStart` が `CLAUDE_PROJECT_DIR` の `<本体>/.worktree/<別名>` の形で本体を導き、旧置き場の形では導かないこと。

### 統合（`tests/agent-hooks.mjs` ほか）
- `handleHook("claude", "PreToolUse", …)` が `updatedInput` つきの許可を返し、`handleHook("codex", …)` が同じ入力で拒否を返すこと（1.6、5.4）。
- 宣言のないリポジトリでは何も返さないこと（1.7、5.3）。`hooks.json`・`CLAUDE_HOOKS` に `EnterWorktree` があり、欠けていると導入検査が報告すること（6.1、6.2）。

### 実機（`claude -p`、`tests/real-env/` の方式）
- 使い捨てリポジトリで、`git switch -c` の置き換え後に次の Bash 呼び出しの `pwd` が `<本体>/.worktree/<別名>` であること。EnterWorktree の `name` が拒否され、案内に従って `brw create` で作った worktree へ、Bash の `cd` で移れること（PoC #5・#9 の再現。2026-11-28 の更新で、`.worktree/` への EnterWorktree の承認は人の確認が要るため、`cd` で確かめる）。
- `.worktree/<別名>` で開始したセッションでフックが届き、`mainOfStart` が `CLAUDE_PROJECT_DIR` から本体を導くこと（`poc/design_01.md` の 2）。Codex の linked worktree（`.worktree/<別名>`）でフックが届くこと（未確認の前提。`feasibility.md`）。

## 運用上のリスク（2026-11-28 の更新）

- **EnterWorktree の承認**: `.worktree/` への EnterWorktree は、Claude Code が承認を求める（BRW のフックの許可では省けず、非対話では `bypassPermissions` が要る）。worktree に入ったセッションからは、`.worktree/` の下の別の worktree へ EnterWorktree で移れない。Claude Code での作業場所の移動は、BRW の置き換えが使う Bash の `cd` が実用的。案内に注意を書く（D3）。
- **無視設定が無い導入先**: 本体で `git add -A` をすると worktree が gitlink として誤ってステージされる。警告（7.10）が安全策で、`.worktree/` を無視する設定の追記の案内は `brw-install-flow`。
- **Codex**: linked worktree の `.worktree/<別名>` でフックが届くかは、一次資料に記載がなく、実機でも未確認。
- **旧置き場の worktree**: BRW は自動で移さない。`brw-pr-handoff` の更新までの間、PR 本文だけが旧置き場 `.claude/worktrees/.brw/` に残る。

## セキュリティ

- 書き換えコマンドの値（ブランチ名・パス）は、すべて単引用符で引用する。ブランチ名は宣言の命名規則（小文字・数字・`-`・`/`）に合うものに限り、パスは git の一覧から得る。シェルの特殊文字が混入しても別のコマンドにならない。
- 許可を返すのは、BRW 自身の CLI を組み立てた場合だけ。元のコマンドを部分的に引き継がない。
- 案内文は `sanitize` を通し、資格情報らしい値を出さない。
