- 対象: Codex が、配置先 `<本体>/.worktree/<別名>` の linked worktree でも、本体の `.codex/hooks.json` を読み込むか。worktree 側の `.codex/` の要否と、旧置き場との違い（要件 1.6・5.4・7.1、実現性の記録の前提 3）
- 段階: design

# PoC design_03: Codex と `.worktree/` の linked worktree

## 実施内容
- 使い捨てのリポジトリ（利用者のホームの下のスクラッチ。`/tmp` 配下では Codex がプロジェクトを読み込まなかったため移した）を作り、`.codex/` を `.gitignore` に入れ、本体にだけ未追跡の `.codex/hooks.json`（このリポジトリの実際の登録のコピー）を置いた。導入先の実態（本体にだけ登録し、worktree には BRW が空の `.codex/` を作る）に合わせた。
- worktree を 3 つ作った: `.worktree/dev-x`（空の `.codex/` あり）、`.worktree/dev-nocodex`（`.codex/` なし）、比較用の `.claude/worktrees/dev-y`（空の `.codex/` あり）。
- Codex の `app-server` の `hooks/list`（Codex が cwd で実際に読み込むフックを返す。**モデルを呼ばない**ため認証は不要）を、本体と 3 つの worktree を cwd にして呼んだ。既存の実環境検証（`tests/real-env/host-events.mjs` の `listLoadedHooks`）と同じ方法。
- `CODEX_HOME` は一時のディレクトリにし、利用者の `config.toml` だけを複製した（認証ファイルは複製していない。複製した設定は実施後に削除）。各プロジェクトの信頼は、この一時の `config.toml` に `[projects."<パス>"] trust_level = "trusted"` を追記して与えた。利用者の設定・認証は書き換えていない。

## 実施日
2026-11-28

## 環境と版
Codex CLI 0.172.0、Node.js 22.16.0、git 2.43.0、Linux（Ubuntu）。

## 結果と仕様への反映
| cwd | 読み込まれたフック |
|---|---|
| 本体 | 本体の `.codex/hooks.json` |
| `.worktree/dev-x`（空の `.codex/` あり） | **本体の `.codex/hooks.json`**（`source` が本体のファイル） |
| `.worktree/dev-nocodex`（`.codex/` なし） | なし |
| `.claude/worktrees/dev-y`（比較。空の `.codex/` あり） | 本体の `.codex/hooks.json` |

- `.worktree/<別名>` の linked worktree でも、worktree に空の `.codex/` があれば、Codex は本体の `.codex/hooks.json` を読む。旧置き場との違いは無かった。`.codex/` が無い worktree では読まれず、旧置き場で確認済みの規則（`references/setup.md`）と同じ。→ 配置先の変更は Codex のフックの届き方に影響しない。BRW が worktree に空の `.codex/` を作る既存の処理（`activateWorktree`）はそのまま使える。
- フックの信頼状態は、どの cwd でも `untrusted`（今回は信頼のハッシュを与えていないため。Codex の `/hooks` での承認は従来どおり必要）。
- 補足: プロジェクトの信頼は、コマンドラインの `-c projects."<パス>".trust_level` だけでは与えられず（フックが読み込まれなかった）、`config.toml` の `[projects."<パス>"]` に書くと読み込まれた。この環境（0.172.0）での観測で、BRW の実装には影響しない。

## 確かめられなかったこと
- 実際の `codex exec` のセッションで、`.worktree/<別名>` からのフックの実行（`hooks/list` は読み込みの確認で、発火までは確認していない。旧置き場の発火は Codex 0.167 で確認済み）。
- フックの信頼（`/hooks` の承認）が、本体と worktree で共有されるか（公式ドキュメントに記載なし）。
