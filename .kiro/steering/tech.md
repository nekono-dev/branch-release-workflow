---
updated_at: 2026-11-20
---

# 技術スタック

## アーキテクチャ

`node scripts/brw.mjs <サブコマンド>` が共通の実行入口。Claude Code の Bash 用 PreToolUse フックは `hook` を呼び、Codex ではエージェントが `git commit`・`git push` の直前に `guard` を呼ぶ。どちらも同じブランチ判定を使い、Claude Code のフックは必要に応じて確認省略も判定する。

## 基盤

- Node.js 22 以上と Git を使う。JavaScript はネイティブ ESM（`.mjs`）で、Node.js 標準モジュールだけで実行できる。
- GitHub との連携には必要に応じて `gh` を使う。GitHub Actions や Wrangler の設定生成は、対応するプレビュー・配備構成で使う。

## 実装上の判断

- 宣言の読み込み、検証、既定値の補完を共通化する。ルートの JSON を優先し、旧パスだけを使う既存リポジトリも扱う。
- 確認省略は、登録済みで作業ツリーの内容が HEAD と一致する宣言に基づく。対象は、送り先が作業ブランチだと確定できる通常の push と、作業ブランチから宣言の `baseBranch` への PR 作成。判定や副作用を変えるときは、CLI とフックの両方を確認する。
- プレビュー URL と CI の設定生成で変数やブランチの別名の扱いを揃える。宣言の変数は環境変数を優先し、必要に応じて GitHub Variables から解決する。
- 配備先ごとの Wrangler 設定は共有の JSONC テンプレートから生成する。変更は宣言またはテンプレートに加え、生成物はバージョン管理の対象外にする。

## 開発と検証

```sh
node tests/selftest.mjs
claude plugin validate .
claude plugin eval .
```

自己テストは一時 Git リポジトリで判定ロジックと CLI の振る舞いを検証する。プラグインの検証と、導入・作業・片付けなどのエージェント操作の評価には Claude Code のコマンドを使う。
