// 操作可否の共通判定（タスク 2.3）: 操作（operation-policy.mjs が確定したもの）・登録済みの宣言・作業で記録された禁止から、
// 拒否・通す・確認省略の対象のどれかと、その理由を決める。
// ホスト（Claude / Codex）の入出力の形は持たない。同じ操作・同じ状態なら、どのホストから呼んでも同じ判定になる（host は結果に影響しない）。
// フックの接続（6.x）・GitHub クライアント（3.x）・公開計画（4.x）には踏み込まない。
// 外部依存なし（Node 標準ライブラリのみ）。依存方向は lib.mjs → operation-policy.mjs → このモジュール → フック変換。
//
// 判定 Decision:
//   verdict      deny（実行させない）| pass（BRW としては止めない。確認省略はしないので、ホストの通常の承認に任せる）
//                | eligibleForApproval（適合し、確認省略の条件も満たす。ホストが許可を返してよい）
//   compliance   適合判定。compliant（規則に適合）| violation（規則に反する）| unresolved（対象を確定できず、適合を確認できない）
//                | outOfScope（BRW が対応しない書き込みで、強制の範囲外）| notApplicable（判定の対象外）
//   approval     確認省略の判定（適合判定とは別）。skip（省略してよい）| normal（通常の承認に任せる）
//                | prohibited（作業で記録された禁止により実行しない）| notApplicable
//   approvalWhy  approval が skip でない理由の識別子（unregistered | opt-out | force | delete | work-restriction | ...）
//   code         判定理由の識別子（ホスト間で同じ操作の判定を比べるときの主な手がかり）
//   reason       人に見せる理由。reasons は確定できなかった理由などの内訳。alternative は代わりに使える BRW の手順
//   targets・facts  判定に使った対象のブランチ名と、その分類
import { BRW_RUN } from "./brw-cmd.mjs";
import { autoApproveOf, classifyBranch, configMatchesHead, git, loadConfig } from "./lib.mjs";
import { aliasHostOf, githubRepoOf } from "./remote-url.mjs";

const CLASS_LABEL = {
  protected: "保護ブランチ",
  base: "恒常的な分岐元",
  development: "開発ブランチ",
  undeclared: "宣言外のブランチ（または命名規則に合わないブランチ）",
  tag: "タグ",
  other: "ブランチ以外の ref",
};

const ALT_CREATE = `ブランチや worktree は \`${BRW_RUN} create <名前>\` で作成してください（既存のブランチは \`${BRW_RUN} resume <名前>\`）。`;
const ALT_RESUME = `既存の開発ブランチは \`${BRW_RUN} resume <名前>\` で再開してください。`;
const ALT_MERGE = `開発ブランチ間の取り込みは PR を作らず、ローカルで \`${BRW_RUN} merge <取り込み元>\` を使ってください。`;
const ALT_PR_FLOW = `PR の作成は \`${BRW_RUN} pr-template\` で本文の下書きを用意し、本文を書いたうえで \`${BRW_RUN} pr\` を実行してください（\`gh pr create\`・GitHub の API・MCP による直接の作成は使えません）。`;
// フック経路は reason と alternative の連結を 500 文字で切るため、短く保つ（案内の 3 点が欠けないように）
const ALT_SYNC = (b) => b === "<基底>"
  ? `基底の更新は fast-forward に限ります。\`git pull --ff-only origin <基底>\`（基底を別の作業ツリーで確認中なら \`git -C <その作業ツリー> pull --ff-only origin <基底>\`）で更新し、分岐する反映は PR で、開発ブランチへの取り込みは \`git merge origin/<基底>\` で行ってください。`
  : `fast-forward で更新してください: \`git pull --ff-only origin ${b}\`（${b} を別の作業ツリーで確認中なら \`git -C <その作業ツリー> pull --ff-only origin ${b}\`）。分岐する反映は PR で、開発ブランチへの取り込みは \`git merge origin/${b}\` で行ってください。`;
// 実効値（ff・rebase）を設定から読んだときの根拠。設定のキーと値を示す（無ければ空文字列）
const basisNote = (op) => {
  const b = op.basis;
  const keys = b?.configKeys ?? [];
  if (!keys.length) return "";
  return `（設定 ${keys.map((k) => `${k}=${b.configValues?.[k] ?? "?"}`).join("、")} による: ff=${op.ff}、rebase=${op.rebase}）`;
};
const ALT_PR = "保護対象への反映は、開発ブランチから分岐元へ PR を作成し、GitHub 上でリポジトリの条件を満たす利用者が squash マージしてください。";

function decide(op, fields) {
  return {
    kind: op.kind,
    verdict: "pass",
    compliance: "notApplicable",
    approval: "notApplicable",
    approvalWhy: null,
    code: "",
    reason: "",
    reasons: [],
    alternative: null,
    root: op.root ?? null,
    targets: [],
    facts: {},
    ...fields,
  };
}
const deny = (op, code, reason, more = {}) => decide(op, { verdict: "deny", compliance: "violation", code, reason, ...more });

// 判定の識別子。ホスト間で同じ操作の判定理由を文字列で比べるために使う
export const decisionSignature = (d) => [d.kind, d.verdict, d.compliance, d.approval, d.code].join("|");

/**
 * 操作の判定に必要な文脈（登録済みの宣言・作業で記録された禁止）を、操作の対象リポジトリから読む。
 * registered は、宣言が現在の commit と同じ内容か（未登録・編集中の宣言で自分に許可を与えないため）。
 * @param {{root?: string|null}} op
 * @param {{noPush?: boolean, noPr?: boolean}} [restrictions] 作業で記録された禁止（`brw work restrict` の内容）
 */
export function contextFor(op, restrictions = {}) {
  if (!op.root) return { config: null, registered: false, restrictions };
  const { config, error } = loadConfig(op.root);
  return { config: config ?? null, error: error ?? null, registered: config ? configMatchesHead(op.root) : false, restrictions };
}

const classes = (config, branches) => Object.fromEntries(branches.map((b) => [b, classifyBranch(config, b)]));
const label = (c) => CLASS_LABEL[c] ?? c;

// 確認省略の理由。宣言が未登録なら unregistered、登録済みで明示的に無効なら opt-out
const whyOff = (registered) => (registered === true ? "opt-out" : "unregistered");

/**
 * 操作 1 件の判定。
 * @param {object} op operation-policy.mjs の操作オブジェクト
 * @param {{config: object|null, registered?: boolean, restrictions?: {noPush?: boolean, noPr?: boolean}, error?: string|null}} ctx
 * @returns {object} Decision（このファイル先頭の説明を参照）
 */
export function evaluate(op, ctx) {
  const restrictions = ctx?.restrictions ?? {};
  if (op.kind === "query") return decide(op, { code: "query", reason: "照会のため判定の対象外です。" });
  if (op.repoState === "outside" || op.repoState === "unmanaged")
    return decide(op, { code: "not-managed", reason: op.repoState === "outside" ? "リポジトリの外の操作のため通常どおり扱います。" : "BRW を導入していないリポジトリのため通常どおり扱います。" });
  if (op.repoState === "unknown") return deny(op, "unresolved", `対象のリポジトリを確定できず、規則に適合すると確認できません: ${op.unresolved.join(" ") || "作業ディレクトリが不明です。"}`, { compliance: "unresolved", reasons: op.unresolved });
  const config = ctx?.config ?? null;
  if (op.repoState === "invalid" || (op.repoState === "managed" && !config))
    return deny(op, "declaration-invalid", `宣言ファイルが不正で規則を確認できないため、変更を止めます${ctx?.error ? `: ${ctx.error}` : "。"}`, { compliance: "unresolved", alternative: "宣言ファイルを修正してから再実行してください。" });
  if (op.repoState === "setup-only" || !config)
    return deny(op, "declaration-missing", "BRW の導入設定はありますが宣言ファイルがなく、規則を確認できないため変更を止めます。", { compliance: "unresolved", alternative: "宣言ファイルを作成するか、導入設定を復旧してください。" });

  // GitHub 側のマージと自動マージ予約は、対象が確定できなくても拒否する（マージは利用者が GitHub 上で行う）
  if (op.kind === "github-merge" || op.kind === "auto-merge")
    return deny(op, "github-merge", `エージェントによる GitHub 上のマージ${op.kind === "auto-merge" ? "と自動マージの予約" : ""}は行えません。`, { alternative: ALT_PR, reasons: op.unresolved });

  if (op.unresolved.length > 0 || op.kind === "unparseable")
    return deny(op, "unresolved", `対象を確定できず、規則に適合すると確認できないため変更を止めます: ${op.unresolved.join(" ") || "操作を解釈できません。"}`, { compliance: "unresolved", reasons: op.unresolved });

  const auto = autoApproveOf(config, ctx.registered === true);
  const registered = ctx.registered === true;
  switch (op.kind) {
    case "create": return evalCreate(op, config);
    case "commit": return evalCommit(op, config);
    case "push": return evalPush(op, config, auto, registered, restrictions);
    case "merge": return evalMerge(op, config, registered);
    case "pr-create": return evalPrCreate(op, config, auto, registered, restrictions, ctx.origin ?? "agent");
    case "unsupported-write":
      if (op.refWrite)
        return deny(op, "unsupported-ref-write", `BRW が対応しない書き込み（${op.area ?? "不明"} の ${op.action ?? "変更"}）で、ブランチやタグの先を直接動かしうるため拒否します。`, { compliance: "violation", alternative: "ブランチの更新は BRW の手順（commit と通常の push）で行ってください。" });
      return decide(op, { compliance: "outOfScope", approval: "normal", approvalWhy: "unsupported-write", code: "unsupported-write", reason: `BRW が対応しない書き込み（${op.area ?? "不明"} の ${op.action ?? "変更"}）です。BRW の強制の範囲外のため、ホストの通常の承認に任せます。` });
    default:
      return deny(op, "unresolved", `操作の種類 '${op.kind}' を判定できないため止めます。`, { compliance: "unresolved" });
  }
}

function evalCreate(op, config) {
  const branch = op.branch;
  const cls = classifyBranch(config, branch);
  const facts = { branchClass: { [branch]: cls }, action: op.action };
  if (op.action === "resume" && (cls === "protected" || cls === "base"))
    return decide(op, { compliance: "compliant", approval: "normal", approvalWhy: "no-skip-rule", code: "branch-resume-protected", reason: `'${branch}' は${label(cls)}への切り替えで、ブランチは増えません。通常のホスト承認に任せます。`, targets: [branch], facts });
  if (op.action === "resume")
    return deny(op, "branch-resume", `${label(cls)} '${branch}' の再開は BRW の手順を経る必要があります。`, { alternative: ALT_RESUME, targets: [branch], facts });
  return deny(op, "branch-create", `ブランチ '${branch}' の作成・名前の変更は BRW の手順を経る必要があります。`, { alternative: ALT_CREATE, targets: [branch], facts });
}

function evalCommit(op, config) {
  const cls = classifyBranch(config, op.branch);
  const facts = { branchClass: { [op.branch]: cls } };
  if (cls === "development") return decide(op, { compliance: "compliant", code: "commit-development", reason: `'${op.branch}' は開発ブランチです。`, targets: [op.branch], facts });
  return deny(op, "direct-update", `${label(cls)} '${op.branch}' へ直接 commit はできません。開発ブランチ（${config.workBranches.join(", ")}）で作業してください。`, { alternative: ALT_CREATE, targets: [op.branch], facts });
}

function evalPush(op, config, auto, registered, restrictions) {
  const refs = op.refs ?? [];
  if (refs.length === 0) return deny(op, "unresolved", "push の更新先が空で、規則に適合すると確認できません。", { compliance: "unresolved" });
  const cls = Object.fromEntries(refs.map((r) => [r.dst, r.refKind === "branch" ? classifyBranch(config, r.dst) : r.refKind]));
  const targets = refs.map((r) => r.dst);
  const bad = Object.entries(cls).filter(([, c]) => c !== "development");
  if (bad.length)
    return deny(op, "direct-update", `${bad.map(([b, c]) => `${label(c)} '${b}'`).join("、")} へ直接 push はできません。開発ブランチ（${config.workBranches.join(", ")}）だけが対象です。`, { alternative: "保護対象への反映は、開発ブランチを push して PR を作成してください。", targets, facts: { branchClass: cls } });
  const base = { compliance: "compliant", code: "push-development", targets, facts: { branchClass: cls, force: op.flags.force, delete: op.flags.delete } };
  if (restrictions.noPush)
    return decide(op, { ...base, verdict: "deny", approval: "prohibited", approvalWhy: "work-restriction", reason: "この作業では push が禁止されています（作業の制限が既定の動作より優先されます）。" });
  if (!op.normal) {
    const why = op.flags.force ? "force" : op.flags.delete ? "delete" : "not-normal";
    return decide(op, { ...base, approval: "normal", approvalWhy: why, reason: `開発ブランチへの${why === "force" ? "強制 push" : why === "delete" ? "ブランチの削除" : "通常でない push"}は適合しますが、確認は省略せずホストの通常の承認に任せます。` });
  }
  if (!auto.push) return decide(op, { ...base, approval: "normal", approvalWhy: whyOff(registered), reason: registered ? "宣言の autoApprove.push が無効のため、ホストの通常の承認に任せます。" : "宣言が未登録または編集中のため、確認は省略せずホストの通常の承認に任せます。" });
  return decide(op, { ...base, verdict: "eligibleForApproval", approval: "skip", reason: "登録済みの宣言に従う開発ブランチへの通常の push です。確認を省略できます。" });
}

function evalMerge(op, config, registered) {
  const sources = op.sources ?? [];
  const target = classifyBranch(config, op.branch);
  const srcCls = Object.fromEntries(sources.map((s) => [s.name, s.branch ? classifyBranch(config, s.branch) : "undeclared"]));
  const facts = { branchClass: { [op.branch]: target }, sourceClass: srcCls, ff: op.ff ?? null, rebase: op.rebase ?? null, basis: op.basis ?? null };
  const note = basisNote(op);
  const srcLabel = sources.length ? `取り込み元 ${sources.map((s) => `'${s.name}'（${label(srcCls[s.name])}）`).join("、")}` : "取り込み元なし";
  const targets = [op.branch, ...sources.map((s) => s.branch).filter(Boolean)];
  const isFetch = op.via === "fetch";
  // 形 A: 基底・保護ブランチを、origin の同名の追跡ブランチ 1 つから fast-forward で更新する
  if ((target === "protected" || target === "base") && sources.length === 1) {
    const s = sources[0];
    if (s.remote === "origin" && s.branch === op.branch && !s.refspecDst) {
      const b = op.branch;
      const ffBase = { compliance: "violation", alternative: ALT_SYNC(b), targets, facts };
      if (op.rebase || op.mode === "pull-rebase" || op.mode === "squash" || op.ff === "never" || op.fastForwardable === false)
        return deny(op, "sync-not-fast-forward", `${label(target)} '${b}' への ${srcLabel} の取り込みは、履歴を分岐させる更新（リベース・--no-ff・--squash・分岐した merge）になるため拒否します。${note}`, ffBase);
      if (op.ff !== "only" && op.mode !== "fetch-update")
        return deny(op, "sync-ff-only-required", `${label(target)} '${b}' への ${srcLabel} の取り込みに fast-forward の保証がありません。--ff-only を付けてください。${note}`, ffBase);
      const ok = { compliance: "compliant", code: "sync-base-fast-forward", targets, facts };
      if (!registered) return decide(op, { ...ok, approval: "normal", approvalWhy: "unregistered", reason: `${label(target)} '${b}' の fast-forward 更新です。宣言が未登録または編集中のため、確認は省略せずホストの通常の承認に任せます。` });
      return decide(op, { ...ok, verdict: "eligibleForApproval", approval: "skip", reason: `${label(target)} '${b}' を origin の同名ブランチから fast-forward で更新します（履歴は分岐しません）。確認を省略できます。` });
    }
  }
  // fetch による更新は形 A だけを許す。それ以外（開発ブランチ・宣言外・別の形）は更新を許さない
  if (isFetch)
    return deny(op, "merge-non-development", `fetch による '${op.branch}'（${label(target)}）の更新は許可されません（${srcLabel}）。fetch で更新できるのは origin の同名の基底・保護ブランチだけです。`, { alternative: ALT_SYNC(target === "protected" || target === "base" ? op.branch : "<基底>"), targets, facts });
  if (target !== "development")
    return deny(op, "merge-non-development", `${label(target)} '${op.branch}' へのローカルマージはできません。マージ先は開発ブランチだけです。`, { alternative: ALT_PR, targets, facts });
  // 形 B: 取り込み元が origin の追跡ブランチのうち基底・保護ブランチに当たるもの（<元>:<先> の形は除く）
  const isBaseSrc = (s) => s.remote === "origin" && !s.refspecDst && !!s.branch && ["protected", "base"].includes(classifyBranch(config, s.branch));
  const baseSrcs = sources.filter(isBaseSrc);
  const badSrc = sources.filter((s) => srcCls[s.name] !== "development" && !isBaseSrc(s)).map((s) => [s.name, srcCls[s.name]]);
  if (badSrc.length)
    return deny(op, "merge-non-development", `取り込み元 ${badSrc.map(([n, c]) => `'${n}'（${label(c)}）`).join("、")} は開発ブランチでも origin の基底・保護ブランチでもないため、マージできません。`, { alternative: ALT_MERGE, targets, facts });
  if (baseSrcs.length > 0 && (op.rebase || op.mode === "pull-rebase"))
    return deny(op, "sync-rebase", `${label(target)} '${op.branch}' への ${srcLabel} の取り込みはリベースになるため拒否します。マージで取り込んでください。${note}`, { alternative: ALT_SYNC(baseSrcs[0].branch), targets, facts });
  const base = { compliance: "compliant", code: baseSrcs.length > 0 ? "sync-base-merge" : "merge-development", targets, facts };
  if (sources.length === 0) return decide(op, { ...base, approval: "normal", approvalWhy: "no-source", reason: "取り込み元の指定がなく（--abort など）、確認は省略しません。" });
  if (!registered) return decide(op, { ...base, approval: "normal", approvalWhy: "unregistered", reason: "宣言が未登録または編集中のため、確認は省略せずホストの通常の承認に任せます。" });
  return decide(op, { ...base, verdict: "eligibleForApproval", approval: "skip", reason: baseSrcs.length > 0 ? "開発ブランチへの基底・保護ブランチ（origin）の取り込みです（マージコミットは作れますが、基底は変わりません）。確認を省略できます。" : "開発ブランチ同士のローカルマージです（PR は不要）。確認を省略できます。" });
}

/** 作業ディレクトリの remote に、github.com に解決できない SSH の別名ホストがあれば、その案内（要件 1.8）。無ければ空文字列。 */
function aliasRemoteNote(dir) {
  if (!dir) return "";
  const hosts = new Set();
  for (const n of (git(dir, "remote") ?? "").split("\n").filter(Boolean)) {
    const url = git(dir, "remote", "get-url", n);
    const h = aliasHostOf(url);
    if (h && !githubRepoOf(url)) hosts.add(h);
  }
  if (!hosts.size) return "";
  return `（remote のホスト ${[...hosts].join("・")} は SSH の別名で、github.com に解決できませんでした。GitHub を指す https の remote を足すか、~/.ssh/config の HostName を確認してください。）`;
}

// PR 作成の判定。起点が "agent"（既定。フック・brw guard・MCP の判定）のときは、規則に適合する作成も拒否して brw pr を案内する。
// BRW 自身の公開（計画時と実行時）だけが "brw-publish" を渡し、従来の判定（禁止・適合・確認省略）を使う。渡し忘れは拒否側に倒れる
function evalPrCreate(op, config, auto, registered, restrictions, origin) {
  const r = evalPrCreateRules(op, config, auto, registered, restrictions);
  if (origin === "brw-publish" || r.verdict === "deny") return r;
  return deny(op, "pr-create-use-brw", "エージェントによる PR の直接の作成は行えません。PR は brw pr で作成します。", { compliance: r.compliance, alternative: ALT_PR_FLOW, targets: r.targets, facts: r.facts });
}

function evalPrCreateRules(op, config, auto, registered, restrictions) {
  const head = op.head;
  const baseName = op.base;
  if (!op.repository || op.repoMatchesCwd !== true)
    return deny(op, "pr-create-repository", `PR の作成先が、この作業ディレクトリのリポジトリと一致すると確認できないため拒否します。${aliasRemoteNote(op.cwd)}`, { compliance: "unresolved", facts: { repository: op.repository ?? null } });
  if (head.owner)
    return deny(op, "pr-create-head", `取り込み元 '${head.owner}:${head.branch}' は別のリポジトリのブランチで、開発ブランチと確認できないため拒否します。`, { targets: [head.branch, baseName] });
  const hc = classifyBranch(config, head.branch);
  const bc = classifyBranch(config, baseName);
  const facts = { branchClass: { [head.branch]: hc, [baseName]: bc } };
  const targets = [head.branch, baseName];
  if (hc !== "development")
    return deny(op, "pr-create-head", `取り込み元 '${head.branch}' は${label(hc)}で、PR は開発ブランチからだけ作成できます。`, { alternative: ALT_PR, targets, facts });
  if (bc === "development")
    return deny(op, "pr-create-development", `開発ブランチ '${baseName}' への PR は作成できません。開発ブランチ間の取り込みに PR は使いません。`, { alternative: ALT_MERGE, targets, facts });
  if (bc !== "protected" && bc !== "base")
    return deny(op, "pr-create-undeclared", `取り込み先 '${baseName}' は${label(bc)}で、宣言外のブランチへの PR は作成できません。`, { alternative: ALT_PR, targets, facts });
  const base = { compliance: "compliant", code: "pr-create-protected", targets, facts };
  if (restrictions.noPr)
    return decide(op, { ...base, verdict: "deny", approval: "prohibited", approvalWhy: "work-restriction", reason: "この作業では PR 作成が禁止されています（作業の制限が既定の動作より優先されます）。" });
  if (!auto.pullRequest) return decide(op, { ...base, approval: "normal", approvalWhy: whyOff(registered), reason: registered ? "宣言の autoApprove.pullRequest が無効のため、ホストの通常の承認に任せます。" : "宣言が未登録または編集中のため、確認は省略せずホストの通常の承認に任せます。" });
  // gh pr create は head を push することがある。その push も確認省略の条件を満たすときだけ省略する
  if (op.mayPush && restrictions.noPush) return decide(op, { ...base, approval: "normal", approvalWhy: "work-restriction-push", reason: "この作業では push が禁止されていますが、gh pr create は head を push しうるため、確認は省略しません。" });
  if (op.mayPush && !auto.push) return decide(op, { ...base, approval: "normal", approvalWhy: "opt-out-push", reason: "gh pr create は head を push しうるため、push の確認省略が無効な宣言では確認を省略しません。" });
  return decide(op, { ...base, verdict: "eligibleForApproval", approval: "skip", reason: `開発ブランチから ${label(bc)} '${baseName}' への PR 作成です。確認を省略できます（マージは GitHub 上で利用者が行います）。`, alternative: ALT_PR });
}

/**
 * classifyCommand / classifyMcpCall の結果全体の判定。照会以外の操作をすべて判定し、
 *   1 つでも deny があれば deny、すべてが確認省略の対象のときだけ eligibleForApproval、それ以外は pass とする。
 * 戻り値は Decision の形（verdict・code・reason は決め手になった操作のもの）に、全操作の判定 decisions を加えたもの。
 * 確認省略は、コマンド全体の対象が検証できる場合に限る（実際の実行内容の網羅はフック側の責務）。
 * @param {{operations: object[]}} classified
 * @param {{noPush?: boolean, noPr?: boolean}} [restrictions]
 * @param {{origin?: "agent"|"brw-publish"}} [ctx] 操作の起点。既定はエージェント（直接の PR 作成を拒否する）。BRW 自身の公開だけが "brw-publish" を渡す
 */
export function evaluateAll(classified, restrictions = {}, { origin = "agent" } = {}) {
  const decisions = classified.operations.filter((o) => o.kind !== "query").map((o) => evaluate(o, { ...contextFor(o, restrictions), origin }));
  const denied = decisions.find((d) => d.verdict === "deny");
  const decider = denied
    ?? (decisions.length > 0 && decisions.every((d) => d.verdict === "eligibleForApproval") ? decisions[0] : decisions.find((d) => d.verdict === "pass" && d.approval !== "skip"));
  if (!decider) return { ...decide({ kind: "query" }, { code: "query", reason: "判定の対象となる変更操作はありません。" }), decisions };
  const verdict = denied ? "deny" : decisions.every((d) => d.verdict === "eligibleForApproval") ? "eligibleForApproval" : "pass";
  return { ...decider, verdict, decisions };
}
