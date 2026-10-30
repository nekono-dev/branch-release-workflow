# 導入

このリポジトリは Claude Code のプラグインで、スキルと、commit・push を判定する PreToolUse フックを含む。プラグインを有効にすれば、リポジトリへスキルをコピーする必要はない。フックは宣言ファイルの無いリポジトリでは何もしない（リポジトリの設定で有効にしている場合を除く）ので、自分の環境ではどのリポジトリで有効にしてもよい。要件は Node.js 22 以上と git で、外部パッケージは使わない。

## 1. 宣言ファイルを作り、リポジトリに登録する（必須）

導入では、必ず宣言ファイルを作って commit する。宣言はリポジトリの中にあるものだけが判定に使われるため、手元に置いただけでは CI・クラウドセッション・ほかの人の clone から見えず、運用が効かない。リポジトリの設定でプラグインを有効にしたのに宣言が無いと、フックは commit・push をすべて拒否する。

1. 次の値を利用者に確認する。推測で埋めない。各キーは `references/config.md`。
   - 作業ブランチの命名（例: `dev/*`）と、分岐元（例: `develop`。リポジトリに無ければ作るか別のブランチにするか確認する）
   - 保護ブランチ（本番デプロイが走るブランチ。例: `main`）
   - プレビューの有無と公開先の URL の形
2. `assets/config.example.json` を元に、本体の作業ツリーへ `.branch-release-workflow.json` を書く。
3. `brw create <名前>`（例: `add-branch-release-workflow`）で導入用の作業ブランチを作る。宣言は分岐元にまだ無いので、新しい worktree へ移る。
4. その worktree で `brw check` を実行し、workflow との整合を確かめる（未登録の宣言は ERROR になる。commit 後に消える）。プレビューの workflow が無ければ `brw gen-workflow` で雛形を示す。
5. 宣言を commit する。リポジトリ単位でプラグインを有効にする場合（下の 2 章）は、`.claude/settings.json` も同じ commit に入れる。
6. push し、分岐元へ取り込む（プルリクエストなど、リポジトリの流れに従う）。取り込まれるまでは、ほかのブランチでは宣言が見えない。

作業ブランチの push は許可なしで行う運用なので、切り出し元と保護ブランチへの取り込みがリモート側の関門になる。GitHub のブランチ保護（直接 push の禁止、PR とレビューの必須化）で守ることを利用者に勧める。

## 2. プラグインを有効にする

どれか 1 つでよい。settings.json を変える場合は、変更内容を利用者に示して承認を得てから書く（フックの追加は Claude の動作を変えるため）。

### リポジトリで有効にする（チーム・クラウドセッション向け）

リポジトリの `.claude/settings.json` に入れ、宣言ファイルと同じ commit に入れる（1 章の 5）。リポジトリを開いた人に、このプラグインの導入が案内される。

```json
{
  "extraKnownMarketplaces": {
    "nekono-dev": { "source": { "source": "github", "repo": "nekono-dev/branch-release-workflow" } }
  },
  "enabledPlugins": { "branch-release-workflow@nekono-dev": true }
}
```

### 自分の環境で有効にする

```
/plugin install branch-release-workflow --marketplace nekono-dev/branch-release-workflow
```

更新は `claude plugin update branch-release-workflow@nekono-dev`。

### CI で使う

GitHub Actions の `anthropics/claude-code-action` では入力で指定する。

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    plugin_marketplaces: https://github.com/nekono-dev/branch-release-workflow.git
    plugins: branch-release-workflow@nekono-dev
    branch_prefix: dev/      # 宣言の作業ブランチに合わせる（下記）
    base_branch: develop     # 宣言の baseBranch
```

それ以外の CI では、clone したディレクトリを `--plugin-dir` で読み込む。

```sh
git clone --depth 1 https://github.com/nekono-dev/branch-release-workflow.git "$RUNNER_TEMP/brw"
claude -p "..." --plugin-dir "$RUNNER_TEMP/brw"
```

CI は checkout したリポジトリの宣言で判定するので、宣言が登録済みであることが前提になる。CI が作るブランチも宣言に合わせる。合わないとフックが commit を拒否する。

- claude-code-action では、`branch_prefix` を作業ブランチの接頭辞（例: `dev/`）に、`base_branch` を宣言の `baseBranch`（例: `develop`）にするのが簡単。既定の `claude/...` は `dev/*` に合わない。作られる名前（例: `dev/issue-12-20261025-0930`）が `namePattern` と `maxNameLength` に収まるかも確かめる。
- 接頭辞を変えられない CI では、そのパターン（例: `claude/**`）を `workBranches` に加える。

### 開発中の版を試す

```sh
claude --plugin-dir <このリポジトリの clone>
```

## 3. 確認する

- `brw check` が ERROR を出さないこと（宣言が登録されている）
- 保護ブランチ上で `git commit` を試み、フックに拒否されること
- `brw create <名前>` で作業ブランチと worktree ができること

## Codex

同じリポジトリを外部へ clone し、Codex の探索先からリンクする。Claude の hooks は Codex に自動導入されない。

```sh
git clone https://github.com/nekono-dev/branch-release-workflow.git ~/.local/share/branch-release-workflow
node ~/.local/share/branch-release-workflow/scripts/install-codex.mjs
```

更新は `git -C ~/.local/share/branch-release-workflow pull --ff-only`。検証済みの版に固定する運用では、そのコミットを fetch / checkout する。リンク先は同じ clone なので、コピーし直す必要はない。プロジェクト単位なら `--skills-dir /path/to/project/.agents/skills` を指定し、生成されたリンクを .gitignore に入れる。別の導入先が既にある場合は上書きしない。

新規 clone / worktree / クラウド環境でもセットアップを実行する。AGENTS.md には共有宣言のパス、セットアップ手順、commit・push の前に `brw guard "実際のコマンド"` を実行することを書く。skill が見つからなければセットアップ後に再読み込みするか、外部 clone の SKILL.md を直接読む。

宣言の正本は `.branch-release-workflow.json`。旧 `.claude/branch-release-workflow.json` だけのリポジトリも利用できる。旧版の Claude プラグインと併用するときは、旧パスを `../.branch-release-workflow.json` へのシンボリックリンクにし、値を二重管理しない。

Codex の探索先とシンボリックリンク対応: https://learn.chatgpt.com/docs/build-skills
