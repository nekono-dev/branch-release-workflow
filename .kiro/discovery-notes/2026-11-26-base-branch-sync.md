# 引き継ぎメモ: 基底ブランチを手元で最新にできない問題と、作業ブランチが切られなかった問題（BRW 側）

2026-11-26 の相談の記録。`/kiro-discovery` の入力に使う。対になるメモは cc-sdd-bootstrap リポジトリの `.kiro/discovery-notes/2026-11-26-base-branch-sync.md`。

## 1. 基底ブランチの更新（git pull）が拒否される — 新規仕様 `sync-base-branch`（Path C）

（更新: 2026-11-26。当初は brw-enforcement の拡張（Path A）としたが、同時並行で進めるため新規仕様に分けた。要件の内容は `.kiro/specs/sync-base-branch/brief.md`。brw-enforcement は承認済みの元の状態に戻してある）
- 現状: `git pull` は取り込み操作として扱われ、取り込み先が `main` などの保護ブランチだと拒否される（`scripts/operation-policy.mjs` の pull・merge 分岐、`scripts/operation-decision.mjs` の `evalMerge`、拒否コード `merge-non-development`）。`dev/x` 上の `git pull origin main` も、取り込み元が開発ブランチでないため拒否される。`git fetch origin main:main` も照会として通らない。
- 動機: クラウドセッションや他のプロバイダで作業するとリモートだけが進み、手元の基底ブランチ・作業ブランチを追いつかせたい。
- 決定済みの方針（`.kiro/specs/sync-base-branch/brief.md` の Desired Outcome に反映済み）:
  - 基底・保護ブランチを、同名のリモート追跡ブランチから fast-forward だけで更新する操作を許可する。
  - `dev/*` へ、基底・保護ブランチのリモート追跡ブランチを取り込む操作を許可する。
  - マージコミットが要る更新・他の非開発ブランチ・宣言外のリモートは拒否し、代替手段を表示する。
  - `rebase` の扱いと、保護ブランチへの直接 commit・push の拒否は変えない。
- 次の作業: `/kiro-spec-init sync-base-branch`（または `/kiro-spec-quick sync-base-branch`）。
- 設計で確認すること: `operation-policy.mjs` の pull 分岐が追跡先をどう解決するか、`--ff-only` の判定方法、Claude と Codex 両方のフックと `brw guard` への反映、`SKILL.md`・`references/` の説明、自己テスト（`tests/`）。

## 2. 作業ブランチが切られなかった理由のうち、BRW 側に関係するもの
- BRW プラグインは `.claude/settings.json` で有効だが、`~/.claude/plugins/installed_plugins.json` に、このリポジトリのパスの導入記録が無かった。BRW 自身のリポジトリでは、プラグインの導入元と利用先が同じになり、未導入に気づきにくい。セッションにスキル（branch-release-workflow）もフックも載らなかった。
  - 候補: 導入状態の検査（`hook-diagnose.mjs` など）で、「宣言があり、プラグインが有効なのに、導入記録が無い」状態を報告する。仕様の置き場所は brw-enforcement 要件 6（導入状態の確認）の拡張が自然。
- BRW のフックは Bash の `git` と `EnterWorktree` と MCP だけを見る。`Write` / `Edit` で仕様書を書くことは判定されない。ただし、この穴は cc-sdd 側の work-branch-gate が埋める設計（cc-sdd は brw を知らない前提）。BRW 側で `Write` / `Edit` を止めるかは、重複を避けるため原則として扱わない（要判断）。
- 手元の `main` が古かったことも、混乱の一因だった（`brw create` は `origin/<base>` から切るため、作業ブランチ自体には影響しない）。1 が解消すれば緩和される。

## 3. 本体 checkout への反映（運用メモ）
- cc-sdd-bootstrap の更新は worktree で実行した。本体の checkout の `.codex/hooks.json` が worktree と違うという警告が出ている。この変更をマージして本体の `main` を更新した後、本体でも更新（update）を実行する。
