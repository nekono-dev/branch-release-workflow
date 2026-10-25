# 導入

このリポジトリは Claude Code のプラグインで、スキルと、commit・push を判定する PreToolUse フックを含む。プラグインを有効にすれば、リポジトリへスキルをコピーする必要はない。フックは宣言ファイルの無いリポジトリでは何もしないので、どのリポジトリで有効にしてもよい。要件は Node.js 22 以上と git で、外部パッケージは使わない。

## 1. 宣言ファイルを作る

`assets/config.example.json` を元に `.claude/branch-release-workflow.json` を作る。各キーは `references/config.md`。次の値は利用者に確認し、推測で埋めない。

- 作業ブランチの命名（例: `dev/*`）と、分岐元（例: `develop`）
- 保護ブランチ（本番デプロイが走るブランチ。例: `main`）
- プレビューの有無と公開先の URL の形

作ったら `brw check` で workflow との整合を確かめる。プレビューの workflow が無ければ `brw gen-workflow` で雛形を示す。

## 2. プラグインを有効にする

どれか 1 つでよい。settings.json を変える場合は、変更内容を利用者に示して承認を得てから書く（フックの追加は Claude の動作を変えるため）。

### リポジトリで有効にする（チーム・クラウドセッション向け）

リポジトリの `.claude/settings.json` に入れてコミットする。リポジトリを開いた人に、このプラグインの導入が案内される。

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
```

それ以外の CI では、clone したディレクトリを `--plugin-dir` で読み込む。

```sh
git clone --depth 1 https://github.com/nekono-dev/branch-release-workflow.git "$RUNNER_TEMP/brw"
claude -p "..." --plugin-dir "$RUNNER_TEMP/brw"
```

CI が作るブランチ（claude-code-action の `claude/...` など）で commit させるなら、そのパターンを宣言の `workBranches` に加える。加えないとフックが commit を拒否する。

### 開発中の版を試す

```sh
claude --plugin-dir <このリポジトリの clone>
```

## 3. 確認する

- 保護ブランチ上で `git commit` を試み、フックに拒否されること
- `brw create <名前>` で作業ブランチと worktree ができること
