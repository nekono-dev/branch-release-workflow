// 8.3: 状態ファイルに記録されたものだけを削除する（Ruleset・PR・使い捨てブランチ・一時クローン）。記録に無いものは触らない。
// 使い方: BRW_REAL_ENV=1 node tests/real-env/cleanup.mjs [--include-ref-rulesets]
//   --include-ref-rulesets: 記録に無くても、対象が専用ブランチ 1 本だけ（include が完全に一致）の Ruleset を削除対象に加える。
//   （brw setup が作る brw-pr-squash は ID が記録されないため、この指定か prepare.mjs --record で記録する）
import { rmSync } from "node:fs";
import { STATE_FILE, WORK_DIR, ghApi, ghJson, readState, requireRealEnv, run, writeState } from "./common.mjs";

requireRealEnv("cleanup.mjs");
const state = readState();
if (!state) { console.log("状態ファイルがありません。削除するものはありません。"); process.exit(0); }
const SLUG = state.repo;
const verifyRef = `refs/heads/${state.branch}`;
// 防御: 検証用の名前でなければ何も消さない
if (!/^verify\/brw-base-\d+$/.test(state.branch)) { console.error("記録されたブランチ名が検証用の形ではありません。中止します。"); process.exit(1); }
const out = (s) => console.log(`  ${s}`);
let failed = false;

console.log(`片付け: ${SLUG}（${state.branch}）`);
const rulesets = new Set(state.rulesets ?? []);
if (process.argv.includes("--include-ref-rulesets")) {
  const list = ghJson(`repos/${SLUG}/rulesets`);
  for (const s of list.ok ? list.data : []) {
    const d = ghJson(`repos/${SLUG}/rulesets/${s.id}`);
    const inc = d.ok ? d.data.conditions?.ref_name?.include : null;
    if (Array.isArray(inc) && inc.length === 1 && inc[0] === verifyRef && (d.data.conditions.ref_name.exclude ?? []).length === 0) rulesets.add(s.id);
  }
}
for (const id of rulesets) {
  const r = ghApi(["-X", "DELETE", `repos/${SLUG}/rulesets/${id}`]);
  // 404 は既に無いので成功扱い
  const gone = r.code === 0 || /404|Not Found/.test(r.err);
  out(`Ruleset ${id}: ${gone ? "削除（または既に無し）" : `失敗 ${r.err.trim().split("\n")[0]}`}`);
  failed ||= !gone;
}
for (const n of state.prs ?? []) {
  const r = ghApi(["-X", "PATCH", `repos/${SLUG}/pulls/${n}`, "-f", "state=closed"]);
  out(`PR #${n}: ${r.code === 0 ? "クローズ" : `失敗 ${r.err.trim().split("\n")[0]}`}`);
  failed ||= r.code !== 0;
}
const branches = [...new Set([...(state.extraBranches ?? []), ...(state.branchCreated ? [state.branch] : [])])];
for (const b of branches) {
  if (!b.startsWith("verify/")) { out(`ブランチ ${b}: verify/ 以外のため触りません`); continue; }
  const r = ghApi(["-X", "DELETE", `repos/${SLUG}/git/refs/heads/${b}`]);
  const gone = r.code === 0 || /404|422|Not Found|Reference does not exist/.test(r.err);
  out(`ブランチ ${b}: ${gone ? "削除（または既に無し）" : `失敗 ${r.err.trim().split("\n")[0]}`}`);
  failed ||= !gone;
}
if (failed) { console.error("一部の削除に失敗したため、ローカルの記録と一時クローンを残します。"); process.exit(1); }
// ローカルは自分が作った固定の場所だけ消す
rmSync(state.cloneDir, { recursive: true, force: true });
rmSync(`${WORK_DIR}/home`, { recursive: true, force: true });
rmSync(`${WORK_DIR}/codex-home`, { recursive: true, force: true });
rmSync(STATE_FILE, { force: true });
out(`一時クローン・一時 HOME・状態ファイルを削除: ${WORK_DIR}`);
run("rmdir", [WORK_DIR]);
console.log("片付け完了");
