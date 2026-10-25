# branch-release-workflow

本番向けブランチでの直接作業を防ぎ、作業ブランチ（`dev/XXXX` など）で作業させる Claude Code プラグイン。作業ブランチの push でプレビュー、本番向けブランチの push で本番デプロイする運用の整備と案内も行う。

- スキル: [SKILL.md](SKILL.md)（作業ブランチの作成、プレビュー案内、push 後の片付け、整合検査）
- フック: [hooks/hooks.json](hooks/hooks.json)（保護ブランチ・宣言外ブランチへの `git commit` / `git push` を拒否）

運用はリポジトリ内の宣言ファイル `.claude/branch-release-workflow.json`（記入例は [assets/config.example.json](assets/config.example.json)）で決まり、プラグインにはリポジトリ固有の値を持たない。宣言ファイルの無いリポジトリでは何もしない。

## 導入

```
/plugin install branch-release-workflow --marketplace nekono-dev/branch-release-workflow
```

リポジトリ単位での有効化、CI（GitHub Actions・`claude -p --plugin-dir`）での利用、宣言ファイルの作り方は [references/setup.md](references/setup.md)。要件: Node.js 22 以上と git。外部パッケージは使わない。

## 構成

```
.claude-plugin/   プラグインとマーケットプレイスの定義
hooks/            PreToolUse フック
SKILL.md          スキル本体
scripts/          brw.mjs（CLI）、lib.mjs、providers/
references/       宣言ファイル・導入・Cloudflare Previews の詳細
assets/           宣言ファイルの記入例
evals/            スキルの評価ケース（claude plugin eval）
specs/, tests/    開発用（仕様と自己テスト）
```

## 開発

```sh
node tests/selftest.mjs        # スクリプトの自己テスト
claude plugin validate .       # プラグインの検証
claude plugin eval .           # スキルの評価
```

仕様は `specs/` にある（仕様駆動開発。検証は spec-driven-development スキルの `check-all.mjs --root specs`）。このリポジトリには、特定のアプリケーション固有の値や例を含めない。
