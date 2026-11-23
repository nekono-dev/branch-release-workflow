# Requirements Document

## Project Description (Input)
**誰が困っているか**: BRW を Claude Code と Codex の両方で使う開発者とエージェント。作業を一方のハーネス（エージェントを動かす実行環境）からもう一方へ引き継ぐ場面で、導入・更新・フック登録の手順が揃わず、仕組みも複雑になっている。

**現状**: Claude はマーケットプレイスからプラグインとして入れ、同梱のフックを `${CLAUDE_PLUGIN_ROOT}` で登録する。Codex は `~/.local/share` への手動の git clone、`~/.agents/skills` へのリンク、`install-codex.mjs --repo` による導入先リポジトリごとの `.codex/hooks.json` への絶対パス登録で導入する。linked worktree では `brw create`・`brw resume` が `.codex/` を置く回避策も要る。Codex CLI 0.167 にはフック同梱のプラグイン機能があり、今のマーケットプレイス定義も読めることを実機で確認した。ただし Codex 用のマニフェストが無いため、そのまま入れると Claude 用のフック定義が Codex に登録されてしまう。

**何を変えるか**: 同じリポジトリを両ハーネスのプラグインとして配り、どちらでも「マーケットプレイスの追加 → プラグインの導入 → `brw setup` → `brw check`」という同じ手順で導入・更新できるようにする。Codex 用のマニフェストとフック定義ファイルを加え、スキルを `skills/branch-release-workflow/` へ移す。Codex では `brw setup` が BRW のフックの信頼を毎回登録し、`brw check` が未導入・無効・未信頼・古いハッシュを区別して報告する。クラウド・CI・非対話の実行でも同じ手順にする。`install-codex.mjs`、絶対パスでの登録、worktree の回避策、clone の手順は削除する（移行手段は作らない）。詳細は同じディレクトリの `brief.md` を参照。

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
