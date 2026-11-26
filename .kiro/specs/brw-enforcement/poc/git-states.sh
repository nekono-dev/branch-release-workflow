#!/usr/bin/env bash
# PoC: 作業ブランチの「未コミット」「未 push」を git の出力だけで判定できるかを、一時リポジトリで確かめる
set -eu
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git init -q --bare "$T/remote.git"
git clone -q "$T/remote.git" "$T/w" 2>/dev/null; cd "$T/w"
git config user.email a@a; git config user.name a; git checkout -q -b main
echo a > a; echo "ignored.log" > .gitignore; git add .; git commit -qm init; git push -q origin main
show() { printf '%-34s 未コミット=%s 未push=%s\n' "$1" "$(git status --porcelain --untracked-files=normal | wc -l)" "$(git rev-list --count HEAD --not --remotes)"; }
git checkout -q -b dev/x
show "1 新規ブランチ(commit なし)"
echo b > b; show "2 未追跡ファイル"
echo l > ignored.log; show "3 +無視ファイル(増えない)"
git add b; git commit -qm b; show "4 新規ブランチ+commit(同名リモート無し)"
git push -q -u origin dev/x; show "5 push 済み"
echo c >> a; show "6 追跡ファイルの変更"
git commit -qam c; show "7 先行 commit(未 push)"
git push -q; show "8 再び push 済み"
git checkout -q --detach; show "9 detached HEAD(対象外とするのは別判定)"
