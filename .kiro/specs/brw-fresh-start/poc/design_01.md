- 対象: Claude プラグインの導入の形で、最新かの判定・更新・実行中の操作への反映・オフライン時の振る舞いが期待どおりか（要件 1.8・2.1・2.2・2.4・3.1・3.3、実現性の記録の前提 1・2・6・7・8・9）
- 段階: design

# PoC design_01: Claude プラグインの更新の挙動

## 実施内容
- 利用者の本物のプラグイン設定に触れないよう、`CLAUDE_CONFIG_DIR` を一時ディレクトリに向けた分離環境を作った。
- 配布元の代わりに、一時ディレクトリの bare リポジトリを `git http-backend` 経由の HTTP（Node の小さなサーバー）で公開し、`claude plugin marketplace add http://127.0.0.1:<port>/origin.git` で追加した（`file://` と `http` の dumb 配信は追加できなかったため）。中身はこのリポジトリのコピー（`plugin.json` の版は 1.3.0）。
- ユーザー単位・プロジェクト単位で導入し、配布元へコミットを足しながら次を観測した: (a) 版を変えずにコミットだけ進めた場合の `claude plugin update`、(b) 版を 1.3.1 に上げた場合、(c) 版が同じままの `uninstall` → `install`、(d) 配布元のサーバーを止めた場合、(e) プロジェクト単位の操作を別のディレクトリから実行した場合、(f) 入れ直しでの有効状態と `settings.json`。
- 一時ディレクトリは実施後に削除した。

## 実施日
2026-11-28

## 環境と版
Claude Code 2.1.329、git 2.43.0、Node.js 22.16.0、Linux（Ubuntu）。

## 結果と仕様への反映
1. 導入の記録 `plugins/installed_plugins.json`（`version: 2`）は、導入ごとに `scope`・`installPath`（`cache/<マーケットプレイス>/<プラグイン>/<版>`）・`version`・`gitCommitSha`・（プロジェクト単位のとき）`projectPath` を持つ。`claude plugin list --json` には `gitCommitSha` が出ない。→ 現在のコミットはこの記録から読む。形式が想定と違うときは「現在の版を判定できない」として中止する（要件 3.2）。
2. 配布元の最新は、マーケットプレイスの取得元（`known_marketplaces.json` の `source`。`github` は `repo`、`git` は `url`）に対する `git ls-remote <url> HEAD` で得られ、更新後の `gitCommitSha` と一致した。→ 最新の判定はコミットで行い、`plugin.json` の版の文字列は使わない。
3. **版の文字列を変えずにコミットだけ進めると、`claude plugin update` は更新せず `updateOutcome: up_to_date`（「すでに最新」）と答える**（`marketplace update` の後でも同じ）。コミットは進んでいる。→ 版の比較だけに頼ると古い版を最新と誤認する。BRW は自分でコミットを比べ、`update` が効かなかったときは入れ直し（6）に進む。
4. 版を上げると、`update` は新しい版のキャッシュを作り（`.../1.3.1`）、記録の `installPath`・`version`・`gitCommitSha` を更新する。古い版のキャッシュ（`.../1.3.0`）は残る。メッセージは「Restart to apply changes.」。→ 実行中の操作には反映されない（CLI のヘルプにも `restart required to apply` とある）。更新の後は、新しい `installPath` のスクリプトを起動し直して続ける（要件 2.3・2.4）。
5. 配布元に届かないとき、`claude plugin marketplace update` は終了コード 1（`fatal: unable to access ...`）で失敗するが、**`claude plugin update` は終了コード 0 で「すでに最新」と答える**。→ `update` の結果だけでは最新を確認できない。BRW が自分で最新を取得し（`git ls-remote`）、取得できなければ「判定できない」として中止する（要件 3.1）。
6. 版が同じままのコミットの更新は、`claude plugin uninstall` → `claude plugin install`（同じ `--scope`）で最新のコミットが入った（`gitCommitSha` が一致、ファイルも最新）。ユーザー単位では `settings.json` の `enabledPlugins` は uninstall で空になり、install で戻った。無効にしていた導入は入れ直しで有効になる（実行中の導入が無効なことは通常なく、許容する）。
7. **プロジェクト単位の `install`・`uninstall` は、実行したカレントディレクトリのプロジェクトに作用する。** 別のディレクトリから `install --scope project` を実行すると、そのディレクトリが新しいプロジェクトとして登録され、`.claude/settings.json` が作られた。導入先のプロジェクトのディレクトリで実行したときは `settings.json` は変わらなかった。→ プロジェクト単位の更新・入れ直しは、必ず記録の `projectPath` をカレントディレクトリにして実行する。
8. 同じ版のキャッシュは複数のプロジェクトの導入で共有され、入れ直しは同じ版のキャッシュを上書きする。→ 実行中のスクリプトの読み込みは起動時に終わる設計（静的 import のみ。`scripts/` に動的 import は無い）にしてあるが、更新の後は同じプロセスで続けず、必ず起動し直す。

## 追加の観測（読み取りのみ・実際の GitHub の配布元、2026-11-28）
- 利用者の実環境の `known_marketplaces.json` の `nekono-dev` は `source: {source: "github", repo: "nekono-dev/branch-release-workflow"}`。
- そのマーケットプレイスの取得済みの clone（`marketplaces/nekono-dev`、ブランチ `main`）の `HEAD` は `c484052d38b1e5e0db77f7b67f4d26f06deee755`。`git ls-remote https://github.com/nekono-dev/branch-release-workflow.git HEAD refs/heads/main` も同じ `c484052d…` を返した。
- → `github` 形式の取得先は `https://github.com/<repo>.git` に変換して `ls-remote` すれば、マーケットプレイスが取得するコミットと同じ先端が得られる（結果 2 の裏付け）。

## 確かめられなかったこと
- 実際の GitHub の配布元に対する更新（`update`・入れ直し）の実行（配布元への書き込みが要るため、一時の HTTP サーバーで代替した。読み取りの判定は上の追加の観測で裏付けた）。
- `managed` スコープの導入の更新。
- 複数のプロジェクトが同じ版を共有しているときの、他のプロジェクトへの影響の詳細（同じ版のキャッシュが書き換わることまでは観測）。
