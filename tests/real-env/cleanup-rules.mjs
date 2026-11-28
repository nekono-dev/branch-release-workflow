// 後始末（cleanup.mjs）の規則の純粋関数。GitHub も記録の読み書きもしない（単体試験から読み込めるよう分けてある）。
// 削除・PR のクローズの対象は、記録された使い捨てブランチを head とするオープンな PR だけ。

/** 使い捨て（検証用）のブランチ名か。main や通常の開発ブランチは含まない。 */
export function isDisposableBranch(name) {
  return typeof name === "string" && /^(verify\/|dev\/verify-merge-\d+$)/.test(name);
}

/**
 * 状態ファイルの記録から、後始末の対象ブランチを選ぶ。
 * 作ったブランチ（branchCreated が真の state.branch）と、記録された追加のブランチ（extraBranches）のうち使い捨てのもの。
 * 使い捨てでない記録は対象にせず、skipped として示す。
 */
export function branchesToClean(state) {
  const recorded = [...(state?.extraBranches ?? []), ...(state?.branchCreated === true && state?.branch ? [state.branch] : [])];
  const unique = [...new Set(recorded)];
  return {
    branches: unique.filter(isDisposableBranch),
    skipped: unique.filter((b) => !isDisposableBranch(b)),
  };
}

/** head が指定のブランチの PR を探す問い合わせ（オープンのみ。所有者:ブランチ の形）。 */
export function pullsHeadQuery(slug, owner, branch) {
  return `repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`;
}

/**
 * 問い合わせの結果（PR の一覧）から、head が指定のブランチのオープンな PR の番号を取る。
 * 一覧が配列でない・項目が壊れている場合は null（空として扱わない。失敗として止める）。
 */
export function openPullsOfHead(data, branch) {
  if (!Array.isArray(data)) return null;
  for (const p of data) {
    if (p === null || typeof p !== "object" || !Number.isInteger(p.number) || typeof p.state !== "string" || typeof p.head?.ref !== "string") return null;
  }
  return data.filter((p) => p.head.ref === branch && p.state === "open").map((p) => p.number);
}
