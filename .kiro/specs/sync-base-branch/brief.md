# Brief: sync-base-branch

## Problem
- BRW 導入済みのリポジトリで Claude Code・Codex を使う開発者が、クラウドセッションや他のプロバイダで作業を進めた後、リモートだけが進んだ状態になる。手元の基底ブランチ（`main` など）と作業ブランチを追いつかせたいが、エージェントの `git pull` `git merge origin/main` が拒否される。
- 結果として、手元の `main` が古いまま残る。`brw create` は `origin/<base>` から切るため新規作業は最新から始まるが、既存の作業ブランチへの基底の取り込みと、`main` 自体の更新に安全な手段が無い。

## Current State
- `git pull` と `git merge` は同じ「取り込み」操作として扱われる（`scripts/operation-policy.mjs` の pull・merge 分岐）。判定（`scripts/operation-decision.mjs` の `evalMerge`）は、取り込み先が開発ブランチ以外なら `merge-non-development` で拒否し、取り込み元が開発ブランチ以外でも拒否する。
- `git fetch origin main` は照会として通るが、手元の `main` は動かない。`git fetch origin main:main` は照会として通らない。
- 確認した挙動: `main` 上の `git pull` → 拒否。`dev/x` 上の `git pull origin main` → 拒否。

## Desired Outcome
- `main` など基底・保護ブランチを、同名のリモート追跡ブランチ（`origin/main`）から fast-forward だけで更新できる（`git pull --ff-only`、`git merge --ff-only origin/main`）。
- `dev/*` へ、基底・保護ブランチのリモート追跡ブランチを手元で取り込める（`git merge origin/main`、`git pull origin main`）。
- 上記以外（マージコミットが要る更新、手元の別ブランチ・宣言外のリモートからの取り込み）は従来どおり拒否し、理由と代替手段（PR、または開発ブランチ間のローカルマージ）を表示する。
- 宣言が登録済みなら、許可した取り込みの確認を省略できる。

## Approach
既存の判定（`evalMerge`）に、取り込みの許可条件を足す。取り込み元・先の分類（基底・保護・開発）と、fast-forward かどうかの確認を判定に加える。新しい手順やコマンドは作らず、素の `git` を通す（`brw sync` のような専用コマンドは作らない）。

## Scope
- **In**:
  - 基底・保護ブランチへの fast-forward 限定の更新の許可。
  - `dev/*` への基底・保護ブランチのリモート追跡ブランチの取り込みの許可。
  - 許可外の取り込みの拒否と、拒否時の案内。
  - 宣言が登録済みのときの確認の省略。
  - Claude Code・Codex の両方のフックと `brw guard` への反映、`SKILL.md`・`references/` の説明、自己テスト・評価ケースの更新。
- **Out**: 下の Out of Boundary を参照。

## Boundary Candidates
- 取り込みの許可条件の判定（取り込み先・取り込み元の分類と、fast-forward の確認）。
- 取り込み操作の字句の解析（`pull` の追跡先の解決、`--ff-only` などの引数）。
- 拒否・許可の案内の文面と、フック・`brw guard` への出力。

## Out of Boundary
- `rebase` による取り込みの扱い（従来の判定のまま）。
- 分岐元・保護ブランチへの直接 commit・push の拒否（brw-enforcement 要件 1）。
- 専用コマンド（`brw sync` など）の新設。
- GitHub 側の設定（Ruleset）。
- プラグインの導入状態の検査（BRW 自身のリポジトリでプラグインが未導入のまま気づけない問題）。必要なら brw-enforcement 要件 6 の別の拡張として扱う。
- cc-sdd-bootstrap 側の対応（既定ブランチ `main` が空、導入コピーの古さの検知など）。メモは `.kiro/discovery-notes/2026-11-26-base-branch-sync.md`。

## Upstream / Downstream
- **Upstream**: brw-enforcement（フック判定・`evalMerge`・宣言の読み込み・拒否の案内）。
- **Downstream**: クラウドセッション・他プロバイダとの作業の引き継ぎ運用。brw-pr-handoff・brw-branch-gate とは独立。

## Existing Spec Touchpoints
- **Extends**: brw-enforcement（要件 3 の取り込みの許可条件を拡張する。承認済みの文書は書き換えず、本仕様が要件 3-2 の「開発ブランチ以外を対象にしたマージの拒否」に例外を足す）。
- **Adjacent**: brw-branch-gate・brw-pr-handoff（同じ判定ファイルに触れうるため、衝突に注意）。harness-plugin-unification（フック定義の登録先に関わるため、フックの出力形式を変えない）。

## Constraints
- Node.js 22 以上・標準モジュールのみ（`.mjs`）。
- 判定や副作用を変えるときは CLI とフックの両方を確認する（Claude Code・Codex・`brw guard`）。
- 対象を確定できない取り込みは止める（brw-enforcement 要件 1.4 の安全側）。
- fast-forward の確認は、取り込みの前に履歴の祖先関係から機械的に確かめられること。
