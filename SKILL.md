---
name: branch-release-workflow
description: 作業ブランチ運用（main など本番向けブランチで直接作業せず、dev/XXXX などの作業ブランチで作業する）と、作業ブランチの push でプレビュー・本番向けブランチの push で本番デプロイする CI/CD を扱う。リポジトリに .claude/branch-release-workflow.json があるなら、新機能の実装・修正・要望の追加に着手する前に必ず使い、作業ブランチを作ってから作業する。ほかに、実装した挙動を確認したい・プレビューを見たいと言われたとき、作業ブランチを push した後（worktree の片付け）、push 済みの作業ブランチの続きをするとき、main への直接の commit・push を頼まれたとき、作業ブランチ運用やプレビュー環境（Cloudflare Previews など）を導入・点検するとき、CI から Claude を動かすときにも使う。
---

# 作業ブランチ運用とプレビュー/本番の CI/CD

運用の正本は、リポジトリ内の宣言ファイル `.claude/branch-release-workflow.json`。どのブランチが作業ブランチで、どれが保護ブランチか、プレビューをどう出すかはすべてここに書かれていて、スキルはリポジトリ固有の値を持たない。宣言ファイルが無いリポジトリでは、この運用は使われていない（フックも何もしない）。

操作はスクリプトで行う。このスキルのディレクトリ（この SKILL.md があるディレクトリ）を `<skill>` とすると:

```sh
node <skill>/scripts/brw.mjs <サブコマンド>
```

以下、これを `brw` と書く。`brw` はブランチ名の検証や worktree の場所を宣言に合わせて決めるので、同じことを git で直接行わずに `brw` を使う。

## 守ること

- **保護ブランチ（`protectedBranches`）と、宣言に無いブランチでは commit・push しない。** 保護ブランチへの push はそのまま本番デプロイになりうるため。プラグインのフックが `git commit` / `git push` を止めるが、フックは Bash の git しか見ないので、手順の側でも守る。
- **作業ブランチは `brw create` で作る。** `git checkout -b` や `git worktree add` を直接使うと命名規則の検証を通らず、規則に合わない名前ではプレビューが発行されない。
- **commit は作業ブランチ上なら許可なしでよいが、push は利用者の許可を得る。** push は CI を動かし、外から見える変化になるため。リポジトリの CLAUDE.md などに別の取り決めがあればそちらに従う。
- **push したら `brw finish` で worktree を片付ける。** 次の作業は手元に残ったものではなく、リモートから取得し直したもので始める（3 章）。
- 宣言が `develop` などを `workBranches` にしているリポジトリ（CI が無い等）では、そのブランチで作業してよい。

main への直接の commit・push を頼まれたときは、理由（本番に直接届く・フックが止める）を短く伝え、作業ブランチを作って進めることを提案する。

## 1. 作業ブランチの作成

新機能・修正・要望の追加を頼まれたら、コードに触る前に作る。名前は依頼内容を表す短い英語（例: `login-form`）を自分で決めてよい。

```sh
brw create <名前> [--base <分岐元>] [--branch-only]
```

接頭辞（`dev/` など）は宣言から自動で付く。既定で worktree（`.claude/worktrees/<alias>`）も作るので、以降の編集・commit はその worktree の中で行う。worktree を使えない事情があるときは `--branch-only` でブランチだけ作る。名前が命名規則に合わないと失敗するので、表示された規則に合わせて付け直す。

## 2. プレビューURLの案内

実装の挙動を確認したい・プレビューを見たいと言われたら、作業ブランチの変更を commit し、push の許可を得て push してから URL を案内する。

```sh
brw url [ブランチ]
```

- 案内するのは `brw url` が返す URL だけにする。CI の出力に別の URL（`workers.dev` など）が出ても、それは宣言された公開先ではない。
- push 直後は CI が終わるまで反映されない。`gh run list` などで状況を確かめ、未完了ならそう伝える。
- 命名規則に合わないブランチではプレビューが発行されない。その旨を伝え、`brw create` で合うブランチへ移すことを提案する。
- 宣言の `preview` が無い（`provider: none`）ならプレビューは無い。そう伝える。

## 3. push 後の片付けと再開

push に成功したら続けて片付ける。手元の worktree を残すと、リモートで rebase されたブランチや別の会話での作業とずれたまま再開してしまうため。

```sh
brw finish [ブランチ]   # 省略時は現在のブランチ
brw resume <ブランチ>   # push 済みの作業ブランチで作業を続けるとき
```

- `finish` は、commit していない変更や push していない commit があると何も消さずに失敗する。その場合は commit・push（許可を得る）してからやり直す。消えるのは worktree とローカルブランチだけで、リモートのブランチとプレビューは残る。
- `finish` は worktree の中から実行してよいが、実行後はその作業ディレクトリが消えるので、以降はリポジトリ本体で作業する。
- 次の依頼が同じ作業ブランチの続きなら `resume` でリモートから worktree を作り直してから着手し、新しい機能なら `brw create` で作る。手元に古い worktree やローカルブランチが残っていても、それを使って再開しない。
- 片付けたことと、次の作業はリモートから作り直すことを利用者に伝える。

## 4. 整合検査・雛形・後始末

導入時や、CI の設定を変えたときに使う。

```sh
brw check                                # 宣言・workflow・provider 設定の整合検査
brw gen-workflow [--write]               # provider の preview workflow 雛形（--write で .github/workflows/preview.yaml を作成。既存は上書きしない）
brw cleanup <ブランチ> [--execute]        # provider 固有の後始末（既定は表示のみ）
brw wrangler-config [ファイル] [--write]  # wrangler 設定の workers_dev / preview_urls を独自ドメインの有無に合わせる
```

`check` は workflow の `on.push.branches` を簡易解析し、宣言に無いブランチで CI が走る指定を警告する。workflow が本番向けか（`wrangler deploy` か preview か）という意味や、リポジトリ外の設定（Cloudflare 側の設定など）は機械判定できないので、利用者に確認する。Cloudflare の詳細は `references/cloudflare-previews.md` を読む。

## 非対話の環境（CI・クラウドセッション）

利用者にその場で確認できない環境では、次のように読み替える。

- push の許可は、起動時の指示（CI のプロンプトやセッションの指示）で与えられている範囲に従う。指示に無ければ push せず、commit までで止めて結果を報告する。
- 環境がブランチ名を指定する場合（GitHub Actions の `claude/...` など）、そのブランチが `workBranches` に含まれていればそのまま使う。含まれていなければフックが commit を止めるので、宣言に追加する必要があることを報告する（自分で宣言を書き換えない）。
- 実行環境は使い捨てなので、`finish` による片付けは不要。

## 導入するとき（宣言ファイルの作成と登録は必須）

運用の導入やプラグインの有効化を頼まれたら、`references/setup.md` を読んで進める。導入は、宣言ファイルを作ってリポジトリに commit するところまでが一続きで、省略できない。宣言はリポジトリにあるものだけが判定に使われるので、手元に置いただけでは CI・クラウドセッション・ほかの人の clone で運用が効かない。

- 宣言の値（作業ブランチの命名、分岐元、保護ブランチ、プレビューの公開先）は推測で埋めず利用者に確認する。各キーは `references/config.md`、記入例は `assets/config.example.json`。
- 宣言は導入用の作業ブランチで commit する（`brw create` が未登録の宣言を新しい worktree へ移す）。保護ブランチには直接 commit しない。
- 宣言はあるのに commit されていない（`brw check` が ERROR を出す）なら、導入が終わっていない。登録を先に済ませる。
- リポジトリの `.claude/settings.json` でプラグインを有効にしているのに宣言が無い場合、フックは commit・push を拒否する。導入の途中なので、宣言を作って登録する。

宣言ファイルが無く、プラグインもリポジトリで有効にしていないリポジトリは、この運用の対象外。依頼が単なる実装なら通常どおり作業してよい。

## 参照ファイル

| ファイル | 読むとき |
|---|---|
| `references/config.md` | 宣言ファイルを作る・直す・読み解くとき |
| `references/setup.md` | 導入（宣言ファイルの作成と登録、プラグインの有効化、CI での利用）のとき |
| `references/cloudflare-previews.md` | `provider: cloudflare-previews` のプレビューを扱うとき |
| `assets/config.example.json` | 宣言ファイルの記入例 |
