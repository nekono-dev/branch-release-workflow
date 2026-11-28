// 配置先の決定と判定（brw-branch-gate の placement）の試験。selftest.mjs から呼ばれる（selftest への登録は 7.4 が行う）。
// 一時ディレクトリは mkdtempSync で作り、realpathSync で実体にしてから使う。試験の最後に後始末する。
// `..` を含む入力は join() を使わず文字列を直接組み立てる（join() は `..` を畳んでしまい、生の入力の検査を試せないため）。
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasParentSegment, ignoreStatus, ignoreWarning, isLegacyPlacement, isUnderPlacement, legacyFinishGuidance, legacyMoveGuidance, placementOf, placementPrefix, placementRoot, placementZone } from "../scripts/placement.mjs";

export const runPlacementChecks = async (eq) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-out-")));
  try {
    // 小さな本体（作業ツリー）を作る。setup で中身を足す
    const mk = (...p) => mkdirSync(join(...p), { recursive: true });
    const repo = (name, setup) => {
      const m = join(base, name);
      mkdirSync(m);
      setup?.(m);
      return m;
    };
    const zone = placementZone;

    // 配置先と旧置き場（.brw を含む）を持つ本体
    const main = repo("repo", (m) => {
      mk(m, ".worktree", "dev-a");
      mk(m, ".claude", "worktrees", "dev-old");
      mk(m, ".claude", "worktrees", ".brw");
      writeFileSync(join(m, ".claude", "worktrees", ".brw", "dev-old.md"), "本文\n");
    });
    // .worktree と .claude が無い本体
    const plain = repo("repo-plain");

    // ---- 1.5・7.1: 配置先の決定 ----
    eq("brw-branch-gate/1.5 配置先のディレクトリは <本体>/.worktree", placementRoot(main), join(main, ".worktree"));
    eq("brw-branch-gate/1.5 配置先は <本体>/.worktree/<別名>（別名は aliasOf の規則）", placementOf(main, "dev/foo"), join(main, ".worktree", "dev-foo"));
    eq("brw-branch-gate/2.2 未追跡の一覧から除く前方一致は .worktree/", placementPrefix(), ".worktree/");
    eq("brw-branch-gate/7.1 存在しない配置先は placement と判定される", zone(main, placementOf(main, "dev/foo")), "placement");
    eq("brw-branch-gate/1.5 存在する配置先の worktree は placement と判定される", zone(main, join(main, ".worktree", "dev-a")), "placement");
    eq("brw-branch-gate/1.5 .worktree がまだ無くても、配置先は placement と判定される", zone(plain, placementOf(plain, "dev/foo")), "placement");
    eq("brw-branch-gate/1.5 .worktree がまだ無いとき isUnderPlacement は真", isUnderPlacement(plain, placementOf(plain, "dev/foo")), true);

    // ---- 2.2: 配置先の対象外 ----
    eq("brw-branch-gate/2.2 配置先ディレクトリそのものは other", zone(main, join(main, ".worktree")), "other");
    eq("brw-branch-gate/2.2 配置先の内部のパスは other", zone(main, join(main, ".worktree", "dev-a", "sub")), "other");
    eq("brw-branch-gate/2.2 名前の前方一致だけ（.worktree-other）は other", zone(main, join(main, ".worktree-other", "x")), "other");
    eq("brw-branch-gate/2.2 配置先ディレクトリそのものは配下と判定されない", isUnderPlacement(main, join(main, ".worktree")), false);

    // ---- 7.4: 旧置き場（.brw/ は含めない） ----
    eq("brw-branch-gate/7.4 旧置き場の worktree は legacy と判定される", zone(main, join(main, ".claude", "worktrees", "dev-old")), "legacy");
    eq("brw-branch-gate/7.4 旧置き場が無くても、旧置き場の worktree は legacy と判定される", zone(plain, join(plain, ".claude", "worktrees", "dev-new")), "legacy");
    eq("brw-branch-gate/7.4 isLegacyPlacement は旧置き場の worktree で真", isLegacyPlacement(main, join(main, ".claude", "worktrees", "dev-old")), true);
    eq("brw-branch-gate/7.4 旧置き場の worktree は配置先の配下と判定されない", isUnderPlacement(main, join(main, ".claude", "worktrees", "dev-old")), false);
    eq("brw-branch-gate/7.4 .brw/ の置き場そのものは other", zone(main, join(main, ".claude", "worktrees", ".brw")), "other");
    eq("brw-branch-gate/7.4 .brw/ の本文ファイルは other", zone(main, join(main, ".claude", "worktrees", ".brw", "dev-old.md")), "other");
    eq("brw-branch-gate/7.4 旧置き場ディレクトリそのものは other", zone(main, join(main, ".claude", "worktrees")), "other");
    eq("brw-branch-gate/7.4 名前の前方一致だけ（worktreesX）は other", zone(main, join(main, ".claude", "worktreesX", "a")), "other");
    eq("brw-branch-gate/1.5 .worktree/ の下は legacy と判定されない", zone(main, join(main, ".worktree", "dev-a")), "placement");

    // ---- 1.5・2.2: 相対パス・生の `..`・`.` と重複 `/` ----
    eq("brw-branch-gate/2.2 相対パスは判定不能（unknown）", zone(main, ".worktree/dev-a"), "unknown");
    eq("brw-branch-gate/2.2 相対パスの本体は判定不能（unknown）", zone("repo", join(main, ".worktree", "dev-a")), "unknown");
    eq("brw-branch-gate/2.2 相対パスは配下と誤判定しない", isUnderPlacement(main, ".worktree/dev-a"), false);
    eq("brw-branch-gate/2.2 生の .. を含む対象（link/../child）は unknown", zone(main, main + "/.worktree/link/../child"), "unknown");
    eq("brw-branch-gate/2.2 生の .. を含む対象（a/../b）は unknown", zone(main, main + "/.worktree/a/../b"), "unknown");
    eq("brw-branch-gate/2.2 生の .. で配置先の中へ戻る対象も unknown（畳む前に止める）", zone(main, main + "/.worktree/dev-a/../dev-b"), "unknown");
    eq("brw-branch-gate/2.2 生の .. で旧置き場へ抜ける対象も unknown", zone(main, main + "/.worktree/dev-a/../../.claude/worktrees/x"), "unknown");
    eq("brw-branch-gate/2.2 本体に生の .. があれば unknown", zone(base + "/x/../repo", join(main, ".worktree", "dev-a")), "unknown");
    eq("brw-branch-gate/2.2 `.` と重複 `/` は許し、配置先と判定する", zone(main, main + "//.worktree/./dev-a"), "placement");
    eq("brw-branch-gate/7.4 `.` と重複 `/` は許し、旧置き場と判定する", zone(main, main + "/./.claude//worktrees/dev-old"), "legacy");
    eq("brw-branch-gate/2.2 文字列でない入力は unknown", zone(undefined, "/x"), "unknown");
    eq("brw-branch-gate/5.1 本体が存在しないときは unknown", zone(join(base, "nope"), join(base, "nope", ".worktree", "x")), "unknown");

    // hasParentSegment: 生の入力の `..` の区切りだけを見る
    eq("brw-branch-gate/2.2 hasParentSegment: a/../b は真", hasParentSegment("a/../b"), true);
    eq("brw-branch-gate/2.2 hasParentSegment: .. だけは真", hasParentSegment(".."), true);
    eq("brw-branch-gate/2.2 hasParentSegment: 区切りが \\ でも真", hasParentSegment("a\\..\\b"), true);
    eq("brw-branch-gate/2.2 hasParentSegment: 名前の一部の .. は偽", hasParentSegment("a/..b"), false);
    eq("brw-branch-gate/2.2 hasParentSegment: ... は偽", hasParentSegment("..."), false);
    eq("brw-branch-gate/2.2 hasParentSegment: ./a は偽", hasParentSegment("./a"), false);

    // ---- 配置先・その親・旧置き場がシンボリックリンク（対象によらず unknown） ----
    const linkIn = repo("repo-link-in", (m) => {
      mk(m, "inner-wt");
      symlinkSync(join(m, "inner-wt"), join(m, ".worktree"));
    });
    eq("brw-branch-gate/1.5 配置先が本体の内側を指すリンクは unknown（リンク経由）", zone(linkIn, join(linkIn, ".worktree", "dev-a")), "unknown");
    eq("brw-branch-gate/1.5 配置先が本体の内側を指すリンクは unknown（実体のパス）", zone(linkIn, join(linkIn, "inner-wt", "dev-a")), "unknown");
    eq("brw-branch-gate/1.5 配置先が内側を指すリンクでも、配置先そのものは unknown", zone(linkIn, join(linkIn, ".worktree")), "unknown");

    const linkOut = repo("repo-link-out", (m) => symlinkSync(outside, join(m, ".worktree")));
    eq("brw-branch-gate/1.5 配置先が外を指すリンクは unknown（配置先の作成先）", zone(linkOut, placementOf(linkOut, "dev/foo")), "unknown");
    eq("brw-branch-gate/1.5 配置先が外を指すリンクは unknown（既存パス）", zone(linkOut, join(linkOut, ".worktree", "dev-x")), "unknown");

    const linkClaude = repo("repo-claude-link", (m) => symlinkSync(outside, join(m, ".claude")));
    eq("brw-branch-gate/1.5 .claude が外を指すリンクは配置先も unknown", zone(linkClaude, placementOf(linkClaude, "dev/foo")), "unknown");
    eq("brw-branch-gate/7.4 .claude が外を指すリンクは旧置き場も unknown", zone(linkClaude, join(linkClaude, ".claude", "worktrees", "x")), "unknown");

    const linkLegacyOut = repo("repo-legacy-out", (m) => {
      mk(m, ".claude");
      symlinkSync(outside, join(m, ".claude", "worktrees"));
    });
    eq("brw-branch-gate/7.4 旧置き場が外を指すリンクは unknown（旧置き場の worktree）", zone(linkLegacyOut, join(linkLegacyOut, ".claude", "worktrees", "dev-x")), "unknown");
    eq("brw-branch-gate/1.5 旧置き場のリンクがあれば配置先も unknown（対象によらない）", zone(linkLegacyOut, placementOf(linkLegacyOut, "dev/foo")), "unknown");

    const linkLegacyIn = repo("repo-legacy-in", (m) => {
      mk(m, "inner-old");
      mk(m, ".claude");
      symlinkSync(join(m, "inner-old"), join(m, ".claude", "worktrees"));
    });
    eq("brw-branch-gate/7.4 旧置き場が内側を指すリンクは unknown（リンク経由）", zone(linkLegacyIn, join(linkLegacyIn, ".claude", "worktrees", "dev-old")), "unknown");
    eq("brw-branch-gate/7.4 旧置き場が内側を指すリンクは unknown（実体のパス）", zone(linkLegacyIn, join(linkLegacyIn, "inner-old", "dev-old")), "unknown");

    const linkMutual = repo("repo-mutual", (m) => {
      mk(m, ".claude");
      symlinkSync(join(m, ".claude", "worktrees"), join(m, ".worktree"));
      symlinkSync(join(m, ".worktree"), join(m, ".claude", "worktrees"));
    });
    eq("brw-branch-gate/1.5 配置先と旧置き場が互いを指すとき、配置先は unknown", zone(linkMutual, placementOf(linkMutual, "dev/foo")), "unknown");
    eq("brw-branch-gate/7.4 配置先と旧置き場が互いを指すとき、旧置き場は unknown", zone(linkMutual, join(linkMutual, ".claude", "worktrees", "dev-x")), "unknown");

    const linkOneWay = repo("repo-one-way", (m) => {
      mk(m, ".worktree", "dev-a");
      mk(m, ".claude");
      symlinkSync(join(m, ".worktree"), join(m, ".claude", "worktrees"));
    });
    eq("brw-branch-gate/1.5 旧置き場だけが配置先を指すリンクでも、配置先の worktree は unknown", zone(linkOneWay, join(linkOneWay, ".worktree", "dev-a")), "unknown");

    // ---- 対象自体がリンクのとき（実体の位置で判定） ----
    const targetLinks = repo("repo-target-links", (m) => {
      mk(m, ".worktree", "dev-a");
      symlinkSync(join(m, ".worktree", "dev-a"), join(m, ".worktree", "dev-link"));
      symlinkSync(outside, join(m, ".worktree", "dev-out"));
    });
    eq("brw-branch-gate/1.5 対象が配置先の別の worktree を指すリンクは、実体の位置で placement", zone(targetLinks, join(targetLinks, ".worktree", "dev-link")), "placement");
    eq("brw-branch-gate/1.5 対象が外を指すリンクは、実体の位置で other", zone(targetLinks, join(targetLinks, ".worktree", "dev-out")), "other");
    eq("brw-branch-gate/1.5 対象が外を指すリンクの下も other", zone(targetLinks, join(targetLinks, ".worktree", "dev-out", "sub")), "other");

    // ---- 壊れたリンク・循環・解決できない祖先 ----
    const broken = repo("repo-broken", (m) => {
      mk(m, ".worktree");
      symlinkSync(join(outside, "nowhere"), join(m, ".worktree", "dev-dangling"));
      symlinkSync(join(m, ".worktree", "loop"), join(m, ".worktree", "loop"));
      writeFileSync(join(m, ".worktree", "blocker"), "x");
      // lp-dir が lp-dir/sub を指す循環（lp-dir/sub は存在しないので、祖先の解決で循環になる）
      symlinkSync(join(m, "lp-dir", "sub"), join(m, "lp-dir"));
    });
    eq("brw-branch-gate/5.1 壊れたリンクは unknown", zone(broken, join(broken, ".worktree", "dev-dangling")), "unknown");
    eq("brw-branch-gate/5.1 自分を指すリンク（循環）は unknown", zone(broken, join(broken, ".worktree", "loop")), "unknown");
    eq("brw-branch-gate/5.1 ファイルの下の対象（解決できない祖先）は unknown", zone(broken, join(broken, ".worktree", "blocker", "x")), "unknown");
    eq("brw-branch-gate/5.1 循環する祖先の下の対象は unknown", zone(broken, join(broken, "lp-dir", "x")), "unknown");

    // ---- 本体がシンボリックリンクのとき、経由によらず同じ結果 ----
    const alias = join(base, "repo-alias");
    symlinkSync(main, alias);
    eq("brw-branch-gate/7.3 本体をリンク経由で指しても、配置先は placement", zone(alias, join(alias, ".worktree", "dev-a")), "placement");
    eq("brw-branch-gate/7.3 本体をリンク経由で指しても、旧置き場は legacy", zone(alias, join(alias, ".claude", "worktrees", "dev-old")), "legacy");
    eq("brw-branch-gate/7.3 本体をリンク経由で指しても、実体のパスの配置先は placement", zone(alias, join(main, ".worktree", "dev-a")), "placement");
    eq("brw-branch-gate/7.3 本体をリンク経由で指しても、新しい配置先は placement", zone(alias, placementOf(alias, "dev/foo")), "placement");
    eq("brw-branch-gate/7.3 本体をリンク経由で指しても、.brw の本文は other", zone(alias, join(alias, ".claude", "worktrees", ".brw", "dev-old.md")), "other");

    // ---- 配置先と旧置き場は同時に真にならない ----
    const samples = [
      placementOf(main, "dev/foo"),
      join(main, ".worktree", "dev-a"),
      join(main, ".claude", "worktrees", "dev-old"),
      join(main, ".claude", "worktrees", ".brw", "dev-old.md"),
      join(main, ".claude"),
      main,
      join(base, "elsewhere"),
      join(plain, ".claude", "worktrees", "dev-new"),
      placementOf(plain, "dev/foo"),
    ];
    eq("brw-branch-gate/7.1 配置先と旧置き場の判定が同時に真にならない", samples.filter((p) => isUnderPlacement(main, p) && isLegacyPlacement(main, p)).length, 0);

    // ---- 6.5・7.5: 旧置き場の worktree を移す手順の案内 ----
    // 空白と単引用符を含む旧パスでも、案内のコマンドがそのまま実行できる形になることを確かめる
    const oddOld = join(main, ".claude", "worktrees", "dev old'1");
    const newP = placementOf(main, "dev/old");
    const guide = legacyMoveGuidance(main, "dev/old", oddOld);
    const guideAll = [guide.reason, ...guide.next].join("\n");
    eq("brw-branch-gate/7.5 案内の理由に旧パス・新パス・ブランチが入る", [oddOld, newP, "dev/old"].every((s) => guide.reason.includes(s)), true);
    eq("brw-branch-gate/7.5 案内の理由は「扱えません」の文面を含む", guide.reason.includes("ではないため扱えません"), true);
    eq("brw-branch-gate/7.5 案内に git worktree unlock が含まれる", guide.next.some((l) => l.startsWith("git worktree unlock ")), true);
    eq("brw-branch-gate/7.5 案内に git worktree move が含まれる", guide.next.some((l) => l.startsWith("git worktree move ")), true);
    eq("brw-branch-gate/7.5 案内に brw resume <ブランチ> が含まれる", guide.next.includes("brw resume dev/old"), true);
    eq("brw-branch-gate/7.5 移せないときの代替（git worktree remove）が含まれる", guide.next.some((l) => l.includes("git worktree remove ")), true);
    eq("brw-branch-gate/6.5 案内は BRW が自動で移さないと書く", guide.reason.includes("自動で移しません"), true);
    eq("brw-branch-gate/7.5 案内に旧パスの unlock・move が空白と単引用符を含んでも、sh で元のパスとして渡る", (() => {
      const moveArgs = guide.next.find((l) => l.startsWith("git worktree move ")).slice("git worktree move ".length);
      const unlockArgs = guide.next.find((l) => l.startsWith("git worktree unlock ")).slice("git worktree unlock ".length);
      const out = execFileSync("sh", ["-c", `set -- ${moveArgs}; printf '%s\\n' "$1" "$2"; set -- ${unlockArgs}; printf '%s\\n' "$1"`], { encoding: "utf8" }).split("\n");
      return out[0] === oddOld && out[1] === newP && out[2] === oddOld;
    })(), true);
    eq("brw-branch-gate/7.5 案内の全体に旧パスと新パスが含まれる", [oddOld, newP].every((s) => guideAll.includes(s)), true);

    // ---- 6.2・7.6: `brw finish` 用の案内（旧置き場の worktree を片付けられないとき） ----
    const finOld = join(main, ".claude", "worktrees", "dev old'1");
    const finNew = placementOf(main, "dev/old");
    const fin = legacyFinishGuidance(main, "dev/old", finOld);
    const finAll = [fin.reason, ...fin.next].join("\n");
    eq("brw-branch-gate/7.6 finish の理由に旧パス・新パス・「ブランチも消しません」が入る", [finOld, finNew, "ブランチも消しません"].every((s) => fin.reason.includes(s)), true);
    eq("brw-branch-gate/7.6 finish の理由は BRW が worktree・ブランチ・変更に触れないと書く", fin.reason.includes("BRW は worktree・ブランチ・変更に触れません"), true);
    eq("brw-branch-gate/7.6 finish の案内に移動後の brw finish <ブランチ> の再実行が含まれる", fin.next.some((l) => l.includes("brw finish dev/old")), true);
    eq("brw-branch-gate/7.6 finish の案内に git worktree remove <旧パス> の手動の片付けが含まれる", fin.next.some((l) => l.includes("git worktree remove ")), true);
    eq("brw-branch-gate/7.6 finish の案内に git branch -d <ブランチ> が含まれる", fin.next.some((l) => l.includes("git branch -d dev/old")), true);
    eq("brw-branch-gate/7.6 finish の案内に旧パスと新パスが含まれる", [finOld, finNew].every((s) => finAll.includes(s)), true);
    // 空白・単引用符を含む旧パスとブランチ名を、sh で解釈すると元の文字列に戻る
    eq("brw-branch-gate/7.6 finish の案内の旧パス・新パス・ブランチ名が sh で元の文字列として渡る", (() => {
      const oddBranch = "dev/a b'c";
      const oddNew = placementOf(main, oddBranch);
      const g = legacyFinishGuidance(main, oddBranch, finOld);
      const cut = (s, start, end) => {
        const i = s.indexOf(start);
        if (i < 0) return null;
        const from = i + start.length;
        const j = s.indexOf(end, from);
        return j < 0 ? null : s.slice(from, j);
      };
      const unlockArgs = cut(g.next[0], "git worktree unlock ", "、次に");
      const moveArgs = cut(g.next[0], "git worktree move ", "、最後に");
      const removeArgs = cut(g.next[1], "git worktree remove ", " を実行");
      const branchArgs = cut(g.next[1], "git branch -d ", " でブランチ");
      const finishArgs = cut(g.next[0], "brw finish ", "を実行");
      if ([unlockArgs, moveArgs, removeArgs, branchArgs, finishArgs].some((x) => x === null)) return false;
      const out = execFileSync("sh", ["-c", `set -- ${moveArgs}; printf '%s\\n' "$1" "$2"; set -- ${unlockArgs}; printf '%s\\n' "$1"; set -- ${removeArgs}; printf '%s\\n' "$1"; set -- ${branchArgs}; printf '%s\\n' "$1"; set -- ${finishArgs}; printf '%s\\n' "$1"`], { encoding: "utf8" }).split("\n");
      return out[0] === finOld && out[1] === oddNew && out[2] === finOld && out[3] === finOld && out[4] === "dev/a b'c" && out[5] === "dev/a b'c";
    })(), true);

    // ---- 7.9・7.10: 配置先のディレクトリ全体が無視されているかの検出 ----
    // 導入先の .gitignore と .git/info/exclude が、呼び出しの前後で変わらないことを確かめる
    const gitRepo = (name, setup) => repo(name, (m) => {
      execFileSync("git", ["-C", m, "init", "-q"]);
      setup?.(m);
    });
    const snap = (m) => [".gitignore", ".git/info/exclude"].map((f) => {
      try {
        return readFileSync(join(m, f), "utf8");
      } catch {
        return null;
      }
    });
    const judge = (m) => {
      const before = snap(m);
      const st = ignoreStatus(m);
      const unchanged = JSON.stringify(before) === JSON.stringify(snap(m));
      const noDir = !existsSync(join(m, ".worktree"));
      return { st, unchanged, noDir };
    };
    const noIgnore = judge(gitRepo("ig-none"));
    eq("brw-branch-gate/7.10 無視設定なしは not-ignored", noIgnore.st, "not-ignored");
    eq("brw-branch-gate/7.9 無視設定なしの判定で導入先の設定が変わらない", noIgnore.unchanged, true);
    eq("brw-branch-gate/7.9 判定で配置先のディレクトリを作らない", noIgnore.noDir, true);

    const dirIgnore = judge(gitRepo("ig-dir", (m) => writeFileSync(join(m, ".gitignore"), "/.worktree/\n")));
    eq("brw-branch-gate/7.10 .gitignore の /.worktree/ は ignored", dirIgnore.st, "ignored");
    eq("brw-branch-gate/7.9 /.worktree/ の判定で .gitignore が変わらない", dirIgnore.unchanged, true);

    const excludeIgnore = judge(gitRepo("ig-exclude", (m) => appendFileSync(join(m, ".git", "info", "exclude"), ".worktree/\n")));
    eq("brw-branch-gate/7.10 info/exclude の .worktree/ は ignored", excludeIgnore.st, "ignored");
    eq("brw-branch-gate/7.9 info/exclude の判定で除外設定が変わらない", excludeIgnore.unchanged, true);

    const noSlash = judge(gitRepo("ig-noslash", (m) => writeFileSync(join(m, ".gitignore"), ".worktree\n")));
    eq("brw-branch-gate/7.10 先頭の / が無い .worktree は ignored", noSlash.st, "ignored");
    eq("brw-branch-gate/7.9 先頭の / が無い判定で .gitignore が変わらない", noSlash.unchanged, true);

    const aliasOnly = judge(gitRepo("ig-alias", (m) => writeFileSync(join(m, ".gitignore"), "/.worktree/dev-x\n")));
    eq("brw-branch-gate/7.10 別名だけの無視設定は not-ignored（配置先全体は無視されていない）", aliasOnly.st, "not-ignored");
    eq("brw-branch-gate/7.9 別名だけの判定で .gitignore が変わらない", aliasOnly.unchanged, true);

    const outsideGit = judge(outside);
    eq("brw-branch-gate/7.10 git の外のディレクトリは unknown", outsideGit.st, "unknown");
    eq("brw-branch-gate/7.9 git の外の判定で配置先のディレクトリを作らない", outsideGit.noDir, true);

    // ---- 7.10: 無視されていないときの警告文 ----
    const warnLines = ignoreWarning();
    const warn = warnLines.join("\n");
    eq("brw-branch-gate/7.10 警告文は複数行の配列", Array.isArray(warnLines) && warnLines.length >= 2, true);
    eq("brw-branch-gate/7.10 警告文に .worktree/・git add -A・.gitignore・「書き換えません」を含む", [".worktree/", "git add -A", ".gitignore", "書き換えません"].every((s) => warn.includes(s)), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
};
