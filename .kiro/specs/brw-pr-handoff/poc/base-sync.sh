#!/usr/bin/env bash
# PoC: 分岐元(develop)を、リモートから fast-forward だけで最新にできるか、できない状態(分岐・先行)を検出できるか、保護ブランチとの差を数えられるか
set -eu
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git init -q --bare "$T/remote.git"
git clone -q "$T/remote.git" "$T/w" 2>/dev/null; cd "$T/w"
git config user.email a@a; git config user.name a; git checkout -q -b main
echo a > a; git add .; git commit -qm init; git push -q origin main
git checkout -q -b develop; echo d > d; git add .; git commit -qm d1; git push -q -u origin develop
git clone -q "$T/remote.git" "$T/other" 2>/dev/null
step() { echo "== $1"; }
sync() { git fetch -q origin develop main
  printf '  ff取り込み: '; if git merge --ff-only origin/develop >/dev/null 2>&1; then echo OK; else echo "不可($(git rev-list --count origin/develop..HEAD) 先行 / $(git rev-list --count HEAD..origin/develop) 遅れ)"; fi
  printf '  main との差(origin/main..develop): %s commit\n' "$(git rev-list --count origin/main..develop)"; }
step "1 最新・差あり"; sync
step "2 リモートが先行(別環境が push)"; (cd "$T/other"; git config user.email a@a; git config user.name a; git checkout -q develop; echo e > e; git add .; git commit -qm d2; git push -q origin develop); sync
step "3 ローカルが先行(未 push の commit)"; echo f > f; git add .; git commit -qm local; sync
step "4 分岐(両方に commit)"; (cd "$T/other"; echo g > g; git add .; git commit -qm d3; git push -q origin develop); sync
step "5 main と差なし"; git reset -q --hard origin/main; git checkout -q main 2>/dev/null; git branch -qf develop origin/main; git checkout -q develop; git push -q -f origin develop; sync
step "6 未コミットの変更がある作業ツリーでの ff 取り込み（変更が衝突しない / 衝突する）"
git fetch -q origin develop; git reset -q --hard origin/develop
(cd "$T/other"; git pull -q origin develop 2>/dev/null; echo h > h; echo "v2" > d; git add .; git commit -qm d4; git push -q origin develop)
echo "scratch" > untracked.txt
echo "  未追跡ファイルだけ: $(git fetch -q origin develop; git merge --ff-only origin/develop >/dev/null 2>&1 && echo 'ff OK' || echo 'ff 失敗')"
(cd "$T/other"; echo "v3" > d; git commit -qam d5; git push -q origin develop)
echo "dirty" > d
echo "  取り込む対象と同じ追跡ファイルを変更: $(git fetch -q origin develop; git merge --ff-only origin/develop 2>&1 | head -2 | tr '\n' ' ' | cut -c1-90)"
