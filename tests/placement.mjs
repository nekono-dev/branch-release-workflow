// 配置先の決定と判定（brw-branch-gate の placement）の試験。selftest.mjs から呼ばれる。タスク 6.2 も、この関数に試験を追記する。
// 一時ディレクトリは mkdtempSync で作り、realpathSync で実体にしてから使う。試験の最後に後始末する。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLegacyPlacement, isUnderPlacement, placementOf, placementPrefix, placementRoot } from "../scripts/placement.mjs";

export const runPlacementChecks = async (eq) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "brw-placement-out-")));
  try {
    // 本体: 配置先と旧置き場（.brw/ を含む）を持つ
    const main = join(base, "repo");
    mkdirSync(join(main, ".worktree", "dev-a"), { recursive: true });
    mkdirSync(join(main, ".claude", "worktrees", "dev-old"), { recursive: true });
    mkdirSync(join(main, ".claude", "worktrees", ".brw"), { recursive: true });

    // ---- 1.5: 配置先の決定 ----
    eq("brw-branch-gate/1.5 配置先のディレクトリは <本体>/.worktree", placementRoot(main), join(main, ".worktree"));
    eq("brw-branch-gate/1.5 配置先は <本体>/.worktree/<別名>（別名は aliasOf の規則）", placementOf(main, "dev/foo"), join(main, ".worktree", "dev-foo"));
    eq("brw-branch-gate/2.2 未追跡の一覧から除く前方一致は .worktree/", placementPrefix(), ".worktree/");
    eq("brw-branch-gate/1.5 存在しない配置先は文字列で配下と判定される", isUnderPlacement(main, placementOf(main, "dev/foo")), true);
    eq("brw-branch-gate/1.5 存在する配置先の worktree は配下と判定される", isUnderPlacement(main, join(main, ".worktree", "dev-a")), true);
    eq("brw-branch-gate/2.2 配置先ディレクトリそのものは配下と判定されない", isUnderPlacement(main, placementRoot(main)), false);
    eq("brw-branch-gate/2.2 名前の前方一致だけ（.worktree-other）は配下と判定されない", isUnderPlacement(main, join(main, ".worktree-other", "x")), false);

    // 本体への別の経路（シンボリックリンク）でも、同じ実体として判定する
    const alias = join(base, "repo-link");
    symlinkSync(main, alias);
    eq("brw-branch-gate/7.3 本体をシンボリックリンク経由で指しても配下と判定される", isUnderPlacement(alias, join(alias, ".worktree", "dev-a")), true);

    // ---- 7.4: 旧置き場の判定（.brw/ は含めない） ----
    eq("brw-branch-gate/7.4 旧置き場の worktree は旧置き場と判定される", isLegacyPlacement(main, join(main, ".claude", "worktrees", "dev-old")), true);
    eq("brw-branch-gate/7.4 旧置き場の worktree は配置先の配下と判定されない", isUnderPlacement(main, join(main, ".claude", "worktrees", "dev-old")), false);
    eq("brw-branch-gate/7.4 .brw/ の本文ファイルは旧置き場の worktree に含まれない", isLegacyPlacement(main, join(main, ".claude", "worktrees", ".brw", "dev-old.md")), false);
    eq("brw-branch-gate/7.4 .brw/ の置き場そのものは旧置き場の worktree に含まれない", isLegacyPlacement(main, join(main, ".claude", "worktrees", ".brw")), false);
    eq("brw-branch-gate/7.4 旧置き場ディレクトリそのものは旧置き場の worktree ではない", isLegacyPlacement(main, join(main, ".claude", "worktrees")), false);
    eq("brw-branch-gate/7.4 名前の前方一致だけ（worktreesX）は旧置き場と判定されない", isLegacyPlacement(main, join(main, ".claude", "worktreesX", "a")), false);
    eq("brw-branch-gate/1.5 .worktree/ の下は旧置き場と判定されない", isLegacyPlacement(main, join(main, ".worktree", "dev-a")), false);

    // ---- 1.5・2.2: 相対パスや .. を含むパス ----
    eq("brw-branch-gate/2.2 相対パスは配下と誤判定しない", isUnderPlacement(main, ".worktree/dev-a"), false);
    eq("brw-branch-gate/2.2 相対パスは旧置き場と誤判定しない", isLegacyPlacement(main, ".claude/worktrees/dev-old"), false);
    eq("brw-branch-gate/2.2 .. で配置先の外に出るパスは配下と判定されない", isUnderPlacement(main, join(main, ".worktree", "..", "src", "x")), false);
    eq("brw-branch-gate/2.2 .. で配置先の中へ戻るパスは配下と判定される", isUnderPlacement(main, join(main, ".worktree", "dev-a", "..", "dev-b")), true);
    eq("brw-branch-gate/2.2 .. で旧置き場へ抜けるパスは配下と判定されない", isUnderPlacement(main, join(main, ".worktree", "dev-a", "..", "..", ".claude", "worktrees", "x")), false);
    eq("brw-branch-gate/7.4 .. で旧置き場へ入るパスは旧置き場と判定される", isLegacyPlacement(main, join(main, ".worktree", "..", ".claude", "worktrees", "dev-old")), true);

    // ---- 1.5: 配置先が本体の外を指すシンボリックリンク ----
    const outsideMain = join(base, "repo-outside-root");
    mkdirSync(outsideMain);
    symlinkSync(outside, join(outsideMain, ".worktree"));
    eq("brw-branch-gate/1.5 配置先ディレクトリが外を指すシンボリックリンクのとき、配下と認めない", isUnderPlacement(outsideMain, placementOf(outsideMain, "dev/foo")), false);
    eq("brw-branch-gate/1.5 外を指す配置先の下の既存パスも配下と認めない", isUnderPlacement(outsideMain, join(outsideMain, ".worktree", "dev-x")), false);

    const linkMain = join(base, "repo-link-child");
    mkdirSync(join(linkMain, ".worktree"), { recursive: true });
    symlinkSync(outside, join(linkMain, ".worktree", "dev-link"));
    eq("brw-branch-gate/1.5 配置先の子が外を指すシンボリックリンクのとき、配下と認めない", isUnderPlacement(linkMain, join(linkMain, ".worktree", "dev-link")), false);
    eq("brw-branch-gate/1.5 外を指す子シンボリックリンクの下も配下と認めない", isUnderPlacement(linkMain, join(linkMain, ".worktree", "dev-link", "sub")), false);

    const danglingMain = join(base, "repo-dangling");
    mkdirSync(join(danglingMain, ".worktree"), { recursive: true });
    symlinkSync(join(outside, "nowhere"), join(danglingMain, ".worktree", "dev-dangling"));
    eq("brw-branch-gate/1.5 壊れたシンボリックリンクは配下と認めない", isUnderPlacement(danglingMain, join(danglingMain, ".worktree", "dev-dangling")), false);

    // ---- 1.5・7.4: 本体の内側を指すシンボリックリンクは認め、実体のパスで判定する ----
    const innerMain = join(base, "repo-inner-link");
    mkdirSync(join(innerMain, "inner-wt"), { recursive: true });
    symlinkSync(join(innerMain, "inner-wt"), join(innerMain, ".worktree"));
    eq("brw-branch-gate/1.5 配置先が本体の内側を指すリンクのとき、リンク経由の worktree は配下と判定される", isUnderPlacement(innerMain, join(innerMain, ".worktree", "dev-a")), true);
    eq("brw-branch-gate/1.5 内側を指す配置先は、実体のパス（<本体>/<リンク先>/<別名>）でも配下と判定される", isUnderPlacement(innerMain, join(innerMain, "inner-wt", "dev-a")), true);
    eq("brw-branch-gate/1.5 内側を指す配置先の配置先ディレクトリそのものは配下と判定されない", isUnderPlacement(innerMain, join(innerMain, ".worktree")), false);

    const innerLegacy = join(base, "repo-inner-legacy");
    mkdirSync(join(innerLegacy, "inner-old"), { recursive: true });
    mkdirSync(join(innerLegacy, ".claude"), { recursive: true });
    symlinkSync(join(innerLegacy, "inner-old"), join(innerLegacy, ".claude", "worktrees"));
    eq("brw-branch-gate/7.4 旧置き場が本体の内側を指すリンクのとき、リンク経由の worktree は旧置き場と判定される", isLegacyPlacement(innerLegacy, join(innerLegacy, ".claude", "worktrees", "dev-old")), true);
    eq("brw-branch-gate/7.4 内側を指す旧置き場は、実体のパスでも旧置き場と判定される", isLegacyPlacement(innerLegacy, join(innerLegacy, "inner-old", "dev-old")), true);
    eq("brw-branch-gate/7.4 内側を指す旧置き場の .brw/ は旧置き場の worktree に含まれない", isLegacyPlacement(innerLegacy, join(innerLegacy, ".claude", "worktrees", ".brw", "dev-old.md")), false);

    const outsideLegacy = join(base, "repo-outside-legacy");
    mkdirSync(join(outsideLegacy, ".claude"), { recursive: true });
    symlinkSync(outside, join(outsideLegacy, ".claude", "worktrees"));
    eq("brw-branch-gate/7.4 旧置き場が外を指すシンボリックリンクのとき、旧置き場と認めない", isLegacyPlacement(outsideLegacy, join(outsideLegacy, ".claude", "worktrees", "dev-x")), false);
    eq("brw-branch-gate/7.4 外を指す旧置き場の実体のパスも、本体の旧置き場と認めない", isLegacyPlacement(outsideLegacy, join(outside, "dev-x")), false);

    // ---- 配置先と旧置き場の実体が重なる場合（旧置き場の判定を優先する） ----
    // (a) .worktree が本体内の .claude/worktrees を指すリンク
    const overlapA = join(base, "repo-overlap-a");
    mkdirSync(join(overlapA, ".claude", "worktrees", "dev-old"), { recursive: true });
    mkdirSync(join(overlapA, ".claude", "worktrees", ".brw"), { recursive: true });
    symlinkSync(join(overlapA, ".claude", "worktrees"), join(overlapA, ".worktree"));
    eq("brw-branch-gate/7.4 配置先が旧置き場を指すとき、リンク経由の旧置き場の worktree は旧置き場と判定される", isLegacyPlacement(overlapA, join(overlapA, ".worktree", "dev-old")), true);
    eq("brw-branch-gate/7.4 配置先が旧置き場を指すとき、リンク経由の旧置き場の worktree は配置先の配下と判定されない", isUnderPlacement(overlapA, join(overlapA, ".worktree", "dev-old")), false);
    eq("brw-branch-gate/7.4 配置先が旧置き場を指すとき、実体のパスの旧置き場の worktree は旧置き場と判定される", isLegacyPlacement(overlapA, join(overlapA, ".claude", "worktrees", "dev-old")), true);
    eq("brw-branch-gate/7.4 配置先が旧置き場を指すとき、実体のパスの旧置き場の worktree は配置先の配下と判定されない", isUnderPlacement(overlapA, join(overlapA, ".claude", "worktrees", "dev-old")), false);
    // (c) 重なる場合でも .brw/ の下は両方偽
    eq("brw-branch-gate/7.4 重なる場合でも .brw/ の下は旧置き場と判定されない（リンク経由）", isLegacyPlacement(overlapA, join(overlapA, ".worktree", ".brw", "dev-old.md")), false);
    eq("brw-branch-gate/1.5 重なる場合でも .brw/ の下は配置先の配下と判定されない（リンク経由）", isUnderPlacement(overlapA, join(overlapA, ".worktree", ".brw", "dev-old.md")), false);
    eq("brw-branch-gate/7.4 重なる場合でも .brw/ の下は旧置き場と判定されない（実体）", isLegacyPlacement(overlapA, join(overlapA, ".claude", "worktrees", ".brw", "dev-old.md")), false);
    eq("brw-branch-gate/1.5 重なる場合でも .brw/ の下は配置先の配下と判定されない（実体）", isUnderPlacement(overlapA, join(overlapA, ".claude", "worktrees", ".brw", "dev-old.md")), false);

    // (b) .claude/worktrees が本体内の .worktree を指すリンク（逆方向）
    const overlapB = join(base, "repo-overlap-b");
    mkdirSync(join(overlapB, ".worktree", "dev-old"), { recursive: true });
    mkdirSync(join(overlapB, ".claude"), { recursive: true });
    symlinkSync(join(overlapB, ".worktree"), join(overlapB, ".claude", "worktrees"));
    eq("brw-branch-gate/7.4 旧置き場が配置先を指すとき、リンク経由の worktree は旧置き場と判定される", isLegacyPlacement(overlapB, join(overlapB, ".claude", "worktrees", "dev-old")), true);
    eq("brw-branch-gate/7.4 旧置き場が配置先を指すとき、リンク経由の worktree は配置先の配下と判定されない", isUnderPlacement(overlapB, join(overlapB, ".claude", "worktrees", "dev-old")), false);
    eq("brw-branch-gate/7.4 旧置き場が配置先を指すとき、実体のパスの worktree は旧置き場と判定される", isLegacyPlacement(overlapB, join(overlapB, ".worktree", "dev-old")), true);
    eq("brw-branch-gate/7.4 旧置き場が配置先を指すとき、実体のパスの worktree は配置先の配下と判定されない", isUnderPlacement(overlapB, join(overlapB, ".worktree", "dev-old")), false);
    eq("brw-branch-gate/7.4 重なる（逆方向）場合でも .brw/ の下は旧置き場と判定されない", isLegacyPlacement(overlapB, join(overlapB, ".worktree", ".brw", "dev-old.md")), false);
    eq("brw-branch-gate/1.5 重なる（逆方向）場合でも .brw/ の下は配置先の配下と判定されない", isUnderPlacement(overlapB, join(overlapB, ".worktree", ".brw", "dev-old.md")), false);

    // (d) 重ならない通常の配置では従来どおり
    eq("brw-branch-gate/1.5 重ならない配置では配置先の worktree は配置先の配下と判定される（従来どおり）", isUnderPlacement(main, join(main, ".worktree", "dev-a")), true);
    eq("brw-branch-gate/7.4 重ならない配置では旧置き場の worktree は旧置き場と判定される（従来どおり）", isLegacyPlacement(main, join(main, ".claude", "worktrees", "dev-old")), true);

    // ---- 配置先と旧置き場は同時に真にならない ----
    const samples = [
      placementOf(main, "dev/foo"),
      join(main, ".worktree", "dev-a"),
      join(main, ".claude", "worktrees", "dev-old"),
      join(main, ".claude", "worktrees", ".brw", "dev-old.md"),
      join(main, ".claude"),
      main,
      join(base, "elsewhere"),
    ];
    eq("brw-branch-gate/7.1 配置先と旧置き場の判定が同時に真にならない", samples.filter((p) => isUnderPlacement(main, p) && isLegacyPlacement(main, p)).length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
};
