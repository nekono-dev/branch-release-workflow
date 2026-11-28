// 後始末の規則（cleanup.mjs の PR の探索・対象ブランチの選び方）の純粋関数を、GitHub を呼ばずに確かめる。
import { branchesToClean, isDisposableBranch, openPullsOfHead, pullsHeadQuery } from "./real-env/cleanup-rules.mjs";

const SLUG = "nekono-dev/branch-release-workflow";

export const runRealEnvCleanupChecks = async (eq) => {
  // 対象ブランチの形（検証用の名前だけ）
  eq("cleanup-rules verify/ の名前は使い捨て", isDisposableBranch("verify/brw-bpr-base-1"), true);
  eq("cleanup-rules dev/verify-merge-<数字> は使い捨て", isDisposableBranch("dev/verify-merge-12"), true);
  eq("cleanup-rules main は使い捨てではない", isDisposableBranch("main"), false);
  eq("cleanup-rules 通常の開発ブランチは使い捨てではない", isDisposableBranch("dev/feature-x"), false);
  eq("cleanup-rules 名前が文字列でなければ使い捨てではない", isDisposableBranch(null), false);

  // 記録からの対象（作った記録があるものだけ。main は触らない）
  const cands = branchesToClean({ branchCreated: true, branch: "verify/brw-base-1", extraBranches: ["verify/brw-bpr-base-2", "main", "dev/x"] });
  eq("cleanup-rules 作ったブランチと記録の使い捨てブランチを対象にする", [...cands.branches].sort(), ["verify/brw-base-1", "verify/brw-bpr-base-2"]);
  eq("cleanup-rules 使い捨てでない記録は対象外として示す", cands.skipped, ["main", "dev/x"]);
  eq("cleanup-rules 作っていない（記録だけの）メインのブランチは対象にしない", branchesToClean({ branchCreated: false, branch: "verify/brw-base-1", extraBranches: [] }).branches, []);

  // PR の探索の結果（head が対象ブランチのオープンな PR だけ）
  const list = [
    { number: 5, state: "open", head: { ref: "verify/a" }, base: { ref: "main" } },
    { number: 6, state: "open", head: { ref: "main" }, base: { ref: "verify/a" } },
    { number: 7, state: "closed", head: { ref: "verify/a" }, base: { ref: "main" } },
    { number: 8, state: "open", head: { ref: "dev/other" }, base: { ref: "main" } },
  ];
  eq("cleanup-rules head が対象のオープンな PR だけを閉じる候補にする", openPullsOfHead(list, "verify/a"), [5]);
  eq("cleanup-rules 記録に main があっても対象にしない（main を head とする PR を探さない）", branchesToClean({ branchCreated: true, branch: "main", extraBranches: ["main"] }).branches, []);
  eq("cleanup-rules 対象ブランチの PR のうち、base だけが対象のものは候補にしない", openPullsOfHead(list, "verify/a").includes(6), false);
  eq("cleanup-rules 問い合わせの読み取り失敗（配列でない）は null（空として扱わない）", openPullsOfHead(null, "verify/a"), null);
  eq("cleanup-rules 一覧の項目が壊れていれば null", openPullsOfHead([{ state: "open" }], "verify/a"), null);
  const q = pullsHeadQuery(SLUG, "nekono-dev", "verify/a");
  eq("cleanup-rules 問い合わせは open と head（所有者:ブランチ）で絞る", [q.startsWith(`repos/${SLUG}/pulls?`), decodeURIComponent(q).includes("head=nekono-dev:verify/a"), q.includes("state=open")], [true, true, true]);
};
