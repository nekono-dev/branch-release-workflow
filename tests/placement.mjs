// 配置先の決定と判定（brw-branch-gate の placement）の試験。selftest.mjs から呼ばれる（selftest への登録は 7.4 が行う）。
// 一時ディレクトリは mkdtempSync で作り、realpathSync で実体にしてから使う。試験の最後に後始末する。
// `..` を含む入力は join() を使わず文字列を直接組み立てる（join() は `..` を畳んでしまい、生の入力の検査を試せないため）。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasParentSegment, isLegacyPlacement, isUnderPlacement, placementOf, placementPrefix, placementRoot, placementZone } from "../scripts/placement.mjs";

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
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
};
