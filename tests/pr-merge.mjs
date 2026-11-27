// PR の取り込み先からマージの可否を判定する純粋関数（brw-enforcement 18.2）の契約テスト。selftest.mjs から呼ばれる。
// 通信・Git・ファイルには触れない。
import { judgeMerge } from "../scripts/pr-merge.mjs";
import { normalizeConfig } from "../scripts/lib.mjs";

const config = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop" });
const origin = { owner: "acme", name: "app" };
// github-client の readPull の pull と同じ形の PR 情報。上書きで区分ごとに変える
const facts = (over = {}) => ({
  number: 5,
  state: "open",
  merged: false,
  title: "取り込みの例",
  headRef: "dev/foo",
  headSha: "abc1234",
  baseRef: "develop",
  baseRepo: { owner: "acme", name: "app" },
  ...over,
});

export const runPrMergeChecks = (eq) => {
  // ---- 区分ごとの判定 ----
  // 分岐元（develop）への open な PR だけが ok になる
  eq("pr-merge/18.2 分岐元 develop への open な PR は ok", judgeMerge(config, facts(), origin), { ok: true });

  // 保護ブランチ向けは GitHub 上でマージする旨を理由に含める
  const protectedVerdict = judgeMerge(config, facts({ baseRef: "main" }), origin);
  eq("pr-merge/18.2 保護ブランチ main 向けは base-protected", protectedVerdict.code, "base-protected");
  eq("pr-merge/18.2 保護ブランチ向けの理由は GitHub 上でマージする旨を含む", [protectedVerdict.ok, /GitHub 上/.test(protectedVerdict.reason)], [false, true]);

  // 開発ブランチ向けは取り込み先の分類（開発ブランチ）を理由に含める
  const devVerdict = judgeMerge(config, facts({ baseRef: "dev/foo" }), origin);
  eq("pr-merge/18.2 開発ブランチ dev/foo 向けは base-not-integration", devVerdict.code, "base-not-integration");
  eq("pr-merge/18.2 開発ブランチ向けの理由は分類（開発ブランチ）と宣言の確認を含む", [/開発ブランチ/.test(devVerdict.reason), /宣言/.test(devVerdict.reason), /GitHub 上/.test(devVerdict.reason)], [true, true, true]);

  // 宣言外のブランチ向けは取り込み先の分類（宣言外）を理由に含める
  const undeclaredVerdict = judgeMerge(config, facts({ baseRef: "feature/x" }), origin);
  eq("pr-merge/18.2 宣言外 feature/x 向けは base-not-integration", undeclaredVerdict.code, "base-not-integration");
  eq("pr-merge/18.2 宣言外向けの理由は分類（宣言外）と宣言の確認を含む", [/宣言外/.test(undeclaredVerdict.reason), /宣言/.test(undeclaredVerdict.reason)], [true, true]);

  // 取り込み先のリポジトリが違う（フォークの PR など）は repo-mismatch
  const mismatch = judgeMerge(config, facts({ baseRepo: { owner: "other", name: "app" } }), origin);
  eq("pr-merge/18.2 別リポジトリは repo-mismatch", mismatch.code, "repo-mismatch");
  eq("pr-merge/18.2 大文字小文字の違いだけなら同一リポジトリとみなす", judgeMerge(config, facts({ baseRepo: { owner: "ACME", name: "App" } }), origin), { ok: true });

  // open でない（closed・merged）は not-open
  eq("pr-merge/18.2 closed の PR は not-open", judgeMerge(config, facts({ state: "closed" }), origin).code, "not-open");
  eq("pr-merge/18.2 merged の PR は not-open", judgeMerge(config, facts({ state: "closed", merged: true }), origin).code, "not-open");
  eq("pr-merge/18.2 open のまま merged が真の不整合も not-open", judgeMerge(config, facts({ merged: true }), origin).code, "not-open");

  // ---- 優先順位（より根本的な理由を先に） ----
  eq("pr-merge/18.2 優先順位: 別リポジトリかつ closed は repo-mismatch", judgeMerge(config, facts({ state: "closed", baseRepo: { owner: "other", name: "app" } }), origin).code, "repo-mismatch");
  eq("pr-merge/18.2 優先順位: closed かつ保護向けは not-open", judgeMerge(config, facts({ state: "closed", baseRef: "main" }), origin).code, "not-open");
  eq("pr-merge/18.2 優先順位: 保護向けは取り込み先の分類で先に base-protected", judgeMerge(config, facts({ baseRef: "main", headRef: "dev/foo" }), origin).code, "base-protected");

  // ---- facts の形が不正なら安全側に倒す（例外を投げない） ----
  const unsafe = { ok: false, code: "base-not-integration", reason: "PR の情報が不正で、取り込み先を確定できません。" };
  const bad = (f) => { try { return judgeMerge(config, f, origin); } catch { return "throw"; } };
  eq("pr-merge/18.2 facts が null なら安全側に倒す", bad(null), unsafe);
  eq("pr-merge/18.2 baseRef が文字列でなければ安全側に倒す", bad(facts({ baseRef: 1 })), unsafe);
  eq("pr-merge/18.2 state が open・closed 以外なら安全側に倒す", bad(facts({ state: "draft" })), unsafe);
  eq("pr-merge/18.2 merged が真偽値でなければ安全側に倒す", bad(facts({ merged: "no" })), unsafe);
  eq("pr-merge/18.2 baseRepo が無ければ安全側に倒す", bad(facts({ baseRepo: undefined })), unsafe);
  // origin を確定できないときは例外ではなく理由つきの拒否にする
  const noOrigin = [null, undefined, "acme/app", {}, { owner: "acme" }, { owner: 1, name: "app" }].map((o) => judgeMerge(config, facts(), o));
  eq("pr-merge/18.2 origin を確定できなければ、例外を投げず repo-mismatch で拒否する", noOrigin.map((v) => [v.ok, v.code]), Array(6).fill([false, "repo-mismatch"]));

  // ---- 指摘 1: リポジトリの所有者・名前は空や不正な文字を許さない ----
  eq("pr-merge/18.2 baseRepo が空文字なら形の不正として拒否する（空同士で ok にならない）", bad(facts({ baseRepo: { owner: "", name: "" } })), unsafe);
  eq("pr-merge/18.2 baseRepo の所有者に空白や記号が含まれれば形の不正として拒否する", bad(facts({ baseRepo: { owner: "ac me", name: "app" } })), unsafe);
  eq("pr-merge/18.2 baseRepo も origin も空文字なら、形の不正（facts 側）を先に拒否する", judgeMerge(config, facts({ baseRepo: { owner: "", name: "" } }), { owner: "", name: "" }).code, "base-not-integration");
  eq("pr-merge/18.2 不正な origin の理由に、origin の生の値を含めない", (() => { const v = judgeMerge(config, facts(), { owner: "a\u001b[31m", name: "app" }); return [v.code, v.reason.includes("\u001b")]; })(), ["repo-mismatch", false]);
  eq("pr-merge/18.2 origin が空文字なら（baseRepo が正しくても）repo-mismatch で拒否する", judgeMerge(config, facts(), { owner: "", name: "" }).code, "repo-mismatch");
  eq("pr-merge/18.2 origin の名前に不正な文字があれば repo-mismatch で拒否する", judgeMerge(config, facts(), { owner: "acme", name: "a\u001bpp" }).code, "repo-mismatch");

  // ---- 指摘 2: PR 番号は正の安全な整数。例外を投げず拒否する ----
  const badNumbers = [Symbol("x"), {}, -1, 0, 1.5, "5", NaN, Number.MAX_SAFE_INTEGER + 2];
  eq("pr-merge/18.2 PR 番号が正の安全な整数でなければ形の不正として拒否する（例外なし）", badNumbers.map((n) => bad(facts({ number: n }))), badNumbers.map(() => unsafe));
  eq("pr-merge/18.2 closed かつ PR 番号が Symbol でも例外を投げず拒否する", bad(facts({ state: "closed", number: Symbol() })), unsafe);

  // ---- 指摘 3: 取り込み先のブランチ名は git の通常の文字だけ。理由に生の値を入れない ----
  const badRefs = ["dev/a\nb", "dev/\u001b[31m", "dev/`x`", "dev/a b", "dev/‮ok", "", "x".repeat(256)];
  eq("pr-merge/18.2 制御文字・空白・バッククォート・U+202E・空・256 文字超の baseRef は形の不正として拒否する", badRefs.map((r) => bad(facts({ baseRef: r }))), badRefs.map(() => unsafe));
  eq("pr-merge/18.2 形の不正の理由に、不正な baseRef の生の値を含めない", badRefs.every((r) => !bad(facts({ baseRef: r })).reason.includes(r) || r === ""), true);
  eq("pr-merge/18.2 通常のブランチ名（英数・ドット・スラッシュ・ハイフン・アンダースコア）は受け付ける", judgeMerge(config, facts({ baseRef: "release/v1.2_x-y" }), origin).code, "base-not-integration");

  // ---- 指摘 4: 保護と分岐元が重なるとき・分岐元が複数のときの classifyBranch の優先順位 ----
  // main が保護かつ分岐元なら保護を優先して base-protected
  const mainBoth = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "main" });
  eq("pr-merge/18.2 main が保護かつ分岐元なら base-protected（保護を優先）", judgeMerge(mainBoth, facts({ baseRef: "main" }), origin).code, "base-protected");
  // 分岐元が複数で、その一部だけが保護のとき、保護でない分岐元は ok、保護のものは base-protected
  const multi = normalizeConfig({ workBranches: ["dev/*"], protectedBranches: ["staging"], baseBranch: "develop", baseBranches: ["develop", "staging"] });
  eq("pr-merge/18.2 複数の分岐元のうち保護でないもの（develop）は ok", judgeMerge(multi, facts({ baseRef: "develop" }), origin), { ok: true });
  eq("pr-merge/18.2 複数の分岐元のうち保護のもの（staging）は base-protected", judgeMerge(multi, facts({ baseRef: "staging" }), origin).code, "base-protected");
};
