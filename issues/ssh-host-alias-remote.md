# 問題メモ: `origin` が SSH の別名（Host alias）だと、brw が GitHub のリポジトリと確定できない

記録日: 2026-11-25（cc-sdd-bootstrap の dev/subagent-delegation の PR 作成で発生）。状態: 未対応（メモ）。

## 事象

`origin` の URL が `~/.ssh/config` の別名ホストを指していると、brw の次の操作が止まる。このリポジトリ自身の `origin` も同じ形（`git@github.com.nekono:nekono-dev/branch-release-workflow.git`）で、同じ事象が起きる。

| 操作 | 出たメッセージ |
|---|---|
| `brw work ready --work <ID> ...` | `エラー: push 先のリモート（origin）を GitHub のリポジトリとして確定できません。` |
| `brw work plan --work <ID>` | `エラー: 準備済みの記録がありません。先に brw work ready を実行してください。`（上の失敗の続き） |
| PreToolUse フックでの `gh pr create -R <owner>/<repo> --base ... --head ...` | `[branch-release-workflow] PR の作成先が、この作業ディレクトリのリポジトリと一致すると確認できないため拒否します。`（`-R` で明示しても同じ） |

結果として、`brw publish` の手順（SKILL.md 4 章）が最後まで進まず、PR を作るには利用者が自分で `gh pr create` を実行するしかない。フックは `gh` による PR 作成を止めるため、エージェントが迂回する手段もない（迂回すべきでもない）。

## 再現

環境: `~/.ssh/config` に次の別名がある（複数の GitHub アカウントを使い分けるための一般的な構成）。

```
Host github.com.nekono
    HostName github.com
    User git
    Port 22
    IdentityFile /home/ubuntu/.ssh/nekono_key
    IdentitiesOnly yes
```

```
$ git remote -v
origin  git@github.com.nekono:nekono-dev/cc-sdd-bootstrap.git (fetch)
origin  git@github.com.nekono:nekono-dev/cc-sdd-bootstrap.git (push)
$ brw work ready --work <ID> --completion "..." --verification "..."
エラー: push 先のリモート（origin）を GitHub のリポジトリとして確定できません。
```

`gh auth status` は認証済み（https）。`git ls-remote` と `git push`（別名経由）は通る。つまり GitHub への接続・認証は問題なく、brw の URL の読み取りだけが原因。

## 原因

URL から GitHub の所有者・リポジトリ名を読む正規表現が、ホスト名を `github.com` に固定している。

- `scripts/publish.mjs:335` の `GITHUB_REPO`: `https://github.com/`・`git@github.com:`・`ssh://git@github.com/` だけを受け付ける。`git@github.com.nekono:` のような別名は null になり、「宛先不明」として扱われる（`githubRepoOf`）。呼び出し元は `publish.mjs:397`・`:516`、`publish-cli.mjs:119`、`agent-hooks.mjs:127`・`:133` など。
- `scripts/github-operations.mjs` の `parseRepoSpec`・`remoteRepos`（`gh` の対象リポジトリの確定）も、remote の URL を同様に読むため、別名の remote は「GitHub を指す remote が無い」扱いになり、PR 作成の判定（`scripts/operation-decision.mjs` の `pr-create-repository`）が拒否に倒れる。
- 認証情報付きの URL を読まないという方針（宛先不明で拒否）は正しい。別名はこれと別の、正当な形。

## 影響

- 複数アカウントの SSH 別名を使う利用者は、brw の `work ready`・`plan`・`publish` と、フック下の `gh pr create` が使えない。
- このメモを書いた時点では、`brw create`・`brw finish` や、作業ブランチの `git push`（別名経由）は問題なく動く。

## 回避策（暫定）

- 利用者が PR を自分で作る（本文は `.git` 配下などにファイルで用意して渡す）。
- リポジトリの設定を変えられるなら、`origin` を https にするか、GitHub を指す remote（https）を 1 つ足す。足した remote で、フックと `brw` は対象を確定できるはず（未検証。`distinct.length === 1` の経路）。ただし push 先は別名のままにしたい場合に、`brw publish` の push が別の remote を使うかは未確認。

## 修正の案

1. **SSH の別名を解決する**: remote の URL が scp 形式（`user@host:path`）で、`host` が `github.com` でないとき、`ssh -G <host>` の出力の `hostname` を読んで `github.com` に解決する（`HostName github.com` の別名のみ受け付ける。解決に失敗したら今までどおり宛先不明で拒否）。`githubRepoOf` と `parseRepoSpec` の両方（フックの判定を含む）で同じ関数を使う。
2. **宣言で対応を明示できるようにする**（案 1 の代替または併用）: `.branch-release-workflow.json` に、別名ホストと GitHub のリポジトリの対応（例: `"remoteAliases": { "github.com.nekono": "github.com" }`）を書けるようにする。ネットワークも `ssh` の実行もしないので、フックの判定が単純に保てる。宣言は commit されるため、CI・ほかの人の clone でも同じ判定になる。
3. 失敗メッセージに、原因（別名ホストなので読めない）と、とれる対処（案 2 の宣言、または https の remote を足す）を出す。今は「確定できません」だけで、利用者が原因を調べる手がかりが少ない。

## 受け入れ条件（案）

- 別名ホストの `origin` で、`brw work ready`・`plan`・`publish` が最後まで通る（PR の作成まで）。
- 同じ構成で、フック下の `gh pr create -R <owner>/<repo>` が、作成先が作業ディレクトリのリポジトリと一致すると判定されて通る。
- 別名が `github.com` 以外を指す場合（GHES など）や解決できない場合は、今までどおり拒否される。
- 試験: `tests/` に、別名ホストの URL（`git@github.com.nekono:...`）の読み取りと、解決できない別名・認証情報付きの URL が null になることを足す。

## 決定（2026-11-25、利用者の承認済み）

- 対応方法は「修正の案」の **案 1（`ssh -G` で別名を `github.com` に解決する）＋案 3（失敗メッセージの改善）**。案 2（`.branch-release-workflow.json` に別名を書く）は採らない。理由: 個人の SSH 設定が commit され、他の人の clone や PR の貢献者にとってノイズになるため。
- 「origin を https のままにして別名を `url.<別名>.insteadOf` に置く」運用は、brw では解決にならない。brw は `git remote get-url`（書き換え後の URL）を読むため、結局別名を見る。書き換え前の生の URL を読むのは、実際の送り先と違うものを検査することになるため採らない。
- 注意: `ssh -G` は `~/.ssh/config` の `Match exec` を評価し、書かれたコマンドを実行する。利用者自身の設定なので受け入れ、設計で明記する。
- 仕様の扱い: `.kiro/specs/brw-enforcement/requirements.md` の要件 1 の 6〜8 に追記済み（承認待ち）。設計・タスクへの反映と実装は別セッションで、cc-sdd の手順（`/kiro-spec-design brw-enforcement` → `/kiro-spec-tasks` → `/kiro-impl`）で行う。
- 試験は「受け入れ条件（案）」のとおり。加えて、`ssh -G` が失敗・タイムアウトしたとき、認証情報付き URL、`github.com` 以外に解決される別名が null になることを確かめる。
