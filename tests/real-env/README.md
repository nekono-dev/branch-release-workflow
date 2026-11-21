# 実環境検証の基盤（brw-enforcement 8.3）

実際の GitHub・Claude Code・Codex を使う検証（8.4・8.5）の準備と片付けをする。通常の `node tests/selftest.mjs` からは実行されない。すべて `BRW_REAL_ENV=1` を付けたときだけ動き、付けなければ説明を出して終了コード 0 で何もしない。

## 目的

- 検証専用の対象 ref（使い捨てブランチ 1 本）、設定用と通常作業用の認証、squash の利用条件を用意して確認する。
- 一時クローンに Claude・Codex のフックを導入し、Codex の信頼済み・未信頼を切り替えて検査できるようにする。
- 通常運用のブランチ（main など）を検証に使わない。

## 安全制約

- GitHub 側で書き込む対象は `verify/brw-base-<epoch>` の 1 ブランチだけ。main の現在の commit から作る。main・`dev/*` など既存ブランチ、既存の Ruleset、リポジトリ設定（`allow_*_merge`・既定ブランチ）は変更しない。
- 検証用の宣言（`baseBranch`・`baseBranches` が使い捨てブランチ、`protectedBranches` が `main`）は一時クローン内に置くだけで、commit も push もしない。`baseBranch` を `main` にすると Ruleset の対象に main が入るため使わない。
- Ruleset を作るときは対象をその 1 ref（`refs/heads/verify/brw-base-<epoch>`）に限り、名前に `brw-verify` を含める（8.4・8.5 で作る場合は下の記録を行う）。
- 作ったブランチ・Ruleset ID・PR 番号・一時クローンは `.brw-verify-state.json`（既定 `/tmp/brw-real-env/`。リポジトリには置かない）に記録し、cleanup は記録にあるものだけを削除する。
- `~/.claude`・`~/.codex` は読み書きしない。Codex のフック導入は一時の `HOME`・`CODEX_HOME` で行い、Claude は登録の読み取り検査だけ行う。
- 資格情報（gh のトークン）は表示・記録しない。`common.mjs` の `authEnv()` が子プロセスの環境変数として渡す。
- 利用者のフックや権限ガードが `gh`・push を拒否したら、迂回せず止めて報告する。

## 手順

```sh
export BRW_REAL_ENV=1
node tests/real-env/prepare.mjs     # 使い捨てブランチ・一時クローン・状態ファイルを作る（再実行すると再利用）
node tests/real-env/hosts.mjs       # 両ホストのフック導入と信頼状態の切り替え検査
# ここで 8.4（フックの実イベント）・8.5（Ruleset の効力）を行う。
# 作った Ruleset・PR・ブランチは状態ファイルへ記録する:
node tests/real-env/prepare.mjs --record ruleset=<ID>
node tests/real-env/prepare.mjs --record pr=<番号>
node tests/real-env/prepare.mjs --record branch=verify/<名前>
node tests/real-env/cleanup.mjs     # 記録されたものだけを削除
node tests/real-env/cleanup.mjs --include-ref-rulesets   # 記録のない brw-pr-squash も、対象が専用ブランチ 1 本だけなら削除対象に加える
```

`prepare.mjs` は admin 権限・`allow_squash_merge`・対象 ref の存在・gh ログインの種類（classic/OAuth か、fine-grained 相当か）を表示する。squash が無効なら設定は変えず中止する。

`hosts.mjs` は次を表示する。

- `claude --version`・`codex --version` の有無
- (a) Codex の `.codex/hooks.json` への導入（一時クローン）と「導入済み・未信頼」（`untrusted`）の確認、再実行で変更なしになること
- (b) 診断への `codexTrust`（`untrusted`/`trusted`/`unknown`）の切り替え結果。信頼の実際の承認は Codex の `/hooks` で利用者が行う操作で、自動化できない。ここは診断への入力値の切り替えで、実ランチャーの応答まで確認する
- (c) Claude の `hooks/hooks.json` の登録検査（`checkClaudeHooks`）と `diagnoseHooks`

## 認証の限界

本環境には gh のログインが 1 つだけで、管理権限を持たない別の資格情報はない。そのため次のとおりにしている。

- 設定用 `BRW_SETUP_GH_TOKEN` と作業用 `BRW_WORK_GH_TOKEN` は、どちらも同じ gh ログイン（管理者の OAuth）から作る。
- 管理者は、Ruleset の `bypass_actors` が空でも Ruleset の設定変更権限を持つ。このため `brw check --ruleset` の作業経路は「管理者権限」で `drift` と表示されるのが正しい。Ruleset の迂回不能を確かめる検証（直接 push・rebase・merge commit の拒否など）は、管理者の資格情報では「管理者は迂回できる」ことの確認にとどまる。
- 非管理の資格情報（書き込み権限のみ）が用意できたら `BRW_REAL_ENV_WORK_TOKEN` に渡す。指定があれば作業用にそれを使う（値は表示・記録しない）。

## 環境変数

| 名前 | 用途 |
|---|---|
| `BRW_REAL_ENV=1` | 必須。付けないと何もしない |
| `BRW_REAL_ENV_WORK_TOKEN` | 任意。非管理の作業用資格情報 |
| `BRW_REAL_ENV_DIR` | 任意。状態ファイルと一時クローンの場所（既定 `/tmp/brw-real-env`） |

設定用の資格情報は gh のログインから作る。検証対象のリポジトリは `nekono-dev/branch-release-workflow`（利用者が検証用に使うことを許可している）。
