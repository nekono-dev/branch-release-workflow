#!/usr/bin/env bash
# 評価用のリポジトリを現在のディレクトリに作る。origin は同じディレクトリ内の bare リポジトリ（origin.git、git から除外）。
# 使い方: setup-repo.sh <variant>
#   start-on-main   宣言あり。main をチェックアウト
#   dirty-main      宣言あり。main に commit していない変更がある
#   unpushed-work   宣言あり。dev/contact-link の worktree に push していない commit がある
#   pushed-remote   宣言あり。origin にだけ dev/login-form がある（ローカルには無い）
#   merged-work     宣言あり。dev/contact-link は push 済みで origin/develop にマージ済み、dev/wip-banner は push 済みで未マージ。どちらも worktree が残っている
#   no-config       宣言ファイルが無い
#   design-note-uncommitted  宣言あり。dev/design-note の worktree に docs/design-note.md（未 commit・未追跡の新規ファイル）がある
#   base-ahead      宣言あり。protectedBranches は main だけで、develop が分岐元。develop は main より 1 commit 進んで push 済みで、develop をチェックアウトしている
#   published-cleaned  宣言あり。dev/login-form は公開・片付け済み（origin にだけ残り、worktree とローカルのブランチは無い）。再開の記録（brw/resume.json）が残っている
set -eu
variant="${1:?variant}"
here="$(pwd)"
export GIT_AUTHOR_NAME=dev GIT_AUTHOR_EMAIL=dev@example.com GIT_COMMITTER_NAME=dev GIT_COMMITTER_EMAIL=dev@example.com

git init -q -b main
git config user.name dev && git config user.email dev@example.com
git init -q --bare origin.git
echo "origin.git/" >> .git/info/exclude
git remote add origin "$here/origin.git"
git config push.negotiate false

cat > index.html <<'HTML'
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>Sample Shop</title></head>
<body>
  <header><h1>Sample Shop</h1></header>
  <main><p>ようこそ。季節の商品を揃えています。</p></main>
  <footer><p>&copy; Sample Shop</p></footer>
</body>
</html>
HTML
cat > README.md <<'MD'
# Sample Shop

静的サイトです。`index.html` を編集します。プレビューは作業ブランチの push で発行されます。

## 開発

ローカルでは `index.html` をブラウザで開いて確認でます。
MD
echo ".worktree/" > .gitignore
if [ "$variant" != no-config ]; then
  mkdir -p .claude
  cat > .claude/branch-release-workflow.json <<'JSON'
{
  "workBranches": ["dev/*"],
  "protectedBranches": ["main", "develop"],
  "baseBranch": "develop",
  "namePattern": "^dev/[a-z0-9]+(-[a-z0-9]+)*$",
  "maxNameLength": 54,
  "preview": {
    "provider": "url-template",
    "urlTemplate": "https://{alias}.preview.example.com",
    "aliasStripPrefix": "dev/"
  }
}
JSON
  if [ "$variant" = base-ahead ]; then
    # develop を分岐元にするため、保護ブランチは main だけにする
    sed -i 's/"protectedBranches": \["main", "develop"\]/"protectedBranches": ["main"]/' .claude/branch-release-workflow.json
  fi
fi
git add -A && git commit -q -m "initial"
git branch develop
git push -q origin main develop

case "$variant" in
  start-on-main|no-config) ;;
  dirty-main)
    sed -i 's#<footer><p>&copy; Sample Shop</p></footer>#<footer><p>\&copy; Sample Shop</p><p>営業時間: 10:00-18:00</p></footer>#' index.html ;;
  unpushed-work)
    git worktree add -q --no-track -b dev/contact-link .worktree/dev-contact-link origin/develop
    ( cd .worktree/dev-contact-link
      sed -i 's#<footer><p>&copy; Sample Shop</p></footer>#<footer><p>\&copy; Sample Shop</p><p><a href="/contact">お問い合わせ</a></p></footer>#' index.html
      git commit -q -am "フッターにお問い合わせへのリンクを追加" ) ;;
  pushed-remote)
    git worktree add -q --no-track -b dev/login-form .worktree/dev-login-form origin/develop
    ( cd .worktree/dev-login-form
      cat > login.html <<'HTML'
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>ログイン</title></head>
<body>
  <form id="login" action="/login" method="post">
    <label>メールアドレス <input name="email" type="text"></label>
    <label>パスワード <input name="password" type="password"></label>
    <button type="submit">ログイン</button>
  </form>
</body>
</html>
HTML
      git add login.html && git commit -q -m "ログインフォームを追加"
      git push -q origin dev/login-form )
    git worktree remove .worktree/dev-login-form
    git branch -q -D dev/login-form ;;
  merged-work)
    git worktree add -q --no-track -b dev/contact-link .worktree/dev-contact-link origin/develop
    ( cd .worktree/dev-contact-link
      sed -i 's#<footer><p>&copy; Sample Shop</p></footer>#<footer><p>\&copy; Sample Shop</p><p><a href="/contact">お問い合わせ</a></p></footer>#' index.html
      git commit -q -am "フッターにお問い合わせへのリンクを追加"
      git push -q origin dev/contact-link )
    git worktree add -q --no-track -b dev/wip-banner .worktree/dev-wip-banner origin/develop
    ( cd .worktree/dev-wip-banner
      sed -i 's#<main>#<div class="banner">セール準備中</div>\n  <main>#' index.html
      git commit -q -am "バナーを追加（作業中）"
      git push -q origin dev/wip-banner )
    # 別の場所で develop へマージされた状態を作る
    tmp="$(mktemp -d)"
    git clone -q -b develop "$here/origin.git" "$tmp"
    ( cd "$tmp" && git -c user.name=dev -c user.email=dev@example.com merge -q --no-ff -m "Merge dev/contact-link" origin/dev/contact-link && git push -q origin develop )
    rm -rf "$tmp"
    git fetch -q origin ;;
  design-note-uncommitted)
    git worktree add -q --no-track -b dev/design-note .worktree/dev-design-note origin/develop
    ( cd .worktree/dev-design-note
      mkdir -p docs
      cat > docs/design-note.md <<'MD'
# 設計メモ

- 問い合わせフォームは `/contact` に置く。
- 送信内容はメールで受け取る。
MD
    )
    git fetch -q origin ;;
  base-ahead)
    # develop（分岐元）に変更を取り込んで push し、develop のチェックアウトのまま残す
    git checkout -q develop
    sed -i 's#<main>#<section class="news"><h2>新着情報</h2><p>春の新商品を追加しました。</p></section>\n  <main>#' index.html
    git commit -q -am "新着情報の欄を develop に追加"
    git push -q origin develop ;;
  published-cleaned)
    # PR を作って片付けた後の状態: dev/login-form は push 済みで、worktree とローカルのブランチは無い。再開の記録が残っている
    git worktree add -q --no-track -b dev/login-form .worktree/dev-login-form origin/develop
    ( cd .worktree/dev-login-form
      cat > login.html <<'HTML'
<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>ログイン</title></head>
<body>
  <form id="login" action="/login" method="post">
    <label>メールアドレス <input name="email" type="text"></label>
    <label>パスワード <input name="password" type="password"></label>
    <button type="submit">ログイン</button>
  </form>
</body>
</html>
HTML
      git add login.html && git commit -q -m "ログインフォームを追加"
      git push -q origin dev/login-form )
    git worktree remove .worktree/dev-login-form
    git branch -q -D dev/login-form
    mkdir -p "$(git rev-parse --git-common-dir)/brw"
    printf '{"version":1,"entries":[{"branch":"dev/login-form","prUrl":"https://github.com/acme/app/pull/12","repository":"acme/app","sessionId":null,"at":"%s"}]}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$(git rev-parse --git-common-dir)/brw/resume.json"
    git fetch -q origin ;;
  *) echo "unknown variant: $variant" >&2; exit 2 ;;
esac
