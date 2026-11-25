// 役割表（役割ごとの提供元・モデル・推論量・権限）の基本の規則を持つ純粋な部品。
// 格・系統・推論量の並び、子の上限、推論量の上限、役割表の項目定義と検証を扱う。
// 何も読み込まず、ファイルも読み書きしない（入力から結果を計算するだけ）。

/**
 * @typedef {"claude" | "codex"} Vendor 提供元
 * @typedef {"implement" | "review" | "investigate" | "debug"} Role 役割
 * @typedef {"low" | "medium" | "high" | "xhigh" | "max" | "ultra"} Effort 推論量
 * @typedef {"write" | "read-only"} Permission 作業先の権限
 * @typedef {{ provider: "same" | "other", model?: string, effort?: Effort, permission: Permission }} RoleSetting
 * @typedef {object} SubagentsConfig
 * @property {Record<string, number>} [tiers] 系統の語 → 格（既定に足す・上書きする）
 * @property {Record<string, string>} [modelIds] 系統の語 → 起動に使うモデルの名前
 * @property {Partial<Record<Vendor, string>>} [maxModel] 提供元 → 子の上限の系統
 * @property {Record<string, Effort>} [maxEffort] 共通（default）と系統ごとの推論量の上限
 * @property {Partial<Record<Vendor, Partial<Record<Role, Partial<RoleSetting>>>>>} [roles] 指揮役の提供元 → 役割 → 設定
 */

/** 系統の語 → 格の既定 */
export const DEFAULT_TIERS = {
  haiku: 1, luna: 1, sonnet: 2, terra: 2, opus: 3, sol: 3, fable: 4, astra: 4,
};

/** 系統の語 → 提供元 */
export const FAMILY_VENDOR = {
  haiku: "claude", sonnet: "claude", opus: "claude", fable: "claude",
  luna: "codex", terra: "codex", sol: "codex", astra: "codex",
};

/** 子に使える格の最大（格 4 以上は指揮役だけが使う） */
export const CHILD_MAX_TIER = 3;

/** 推論量を弱い順に並べたもの */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** 推論量の上限の既定 */
export const DEFAULT_MAX_EFFORT = "high";

/** 役割ごとの既定（提供元と権限だけ。モデルと推論量は別に計算する） */
const claudeRoles = {
  implement: { provider: "same", permission: "write" },
  review: { provider: "other", permission: "read-only" },
  investigate: { provider: "other", permission: "read-only" },
  debug: { provider: "other", permission: "read-only" },
};
export const DEFAULT_ROLES = { claude: claudeRoles, codex: { ...claudeRoles } };

const VENDORS = ["claude", "codex"];
const ROLES = ["implement", "review", "investigate", "debug"];
const PERMISSIONS = ["write", "read-only"];
const SETTING_KEYS = ["provider", "model", "effort", "permission"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isEffort = (v) => EFFORT_ORDER.includes(v);
const isName = (v) => typeof v === "string" && v.trim() !== "";
const isTier = (v) => Number.isInteger(v) && v >= 1;

/** 既定の格に設定の格を重ねた表（不正な値は無視する） */
function mergedTiers(cfg) {
  const tiers = { ...DEFAULT_TIERS };
  const extra = cfg?.tiers;
  if (isObject(extra)) {
    for (const [k, v] of Object.entries(extra)) {
      if (k !== "" && isTier(v)) tiers[k.toLowerCase()] = v;
    }
  }
  return tiers;
}

/**
 * モデルの名前から系統の語を求める。小文字にして、含まれる語を長い順に照合する。
 * 例: claude-sonnet-5-5 → sonnet、gpt-6.1-terra → terra
 * @param {string} model
 * @param {Record<string, number>} tiers
 * @returns {string | null}
 */
export function familyOf(model, tiers) {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase();
  const words = Object.keys(tiers).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return words.find((w) => w !== "" && id.includes(w)) ?? null;
}

/**
 * 系統の語から提供元を求める（設定で足した語は null）。
 * @param {string} family
 * @returns {Vendor | null}
 */
export function vendorOfFamily(family) {
  return Object.hasOwn(FAMILY_VENDOR, family) ? FAMILY_VENDOR[family] : null;
}

/**
 * 提供元ごとの子の上限の格。maxModel が無ければ CHILD_MAX_TIER。CHILD_MAX_TIER は超えない。
 * @param {Vendor} vendor
 * @param {SubagentsConfig} cfg
 * @returns {number}
 */
export function childMaxTier(vendor, cfg) {
  const tiers = mergedTiers(cfg);
  const name = cfg?.maxModel?.[vendor];
  const family = typeof name === "string" ? familyOf(name, tiers) : null;
  if (family === null) return CHILD_MAX_TIER;
  return Math.min(tiers[family], CHILD_MAX_TIER);
}

/**
 * 推論量の上限。系統ごとの上限 → 共通の上限 → 既定（high）の順。
 * @param {string | null} family
 * @param {SubagentsConfig} cfg
 * @returns {Effort}
 */
export function effortCapFor(family, cfg) {
  const table = cfg?.maxEffort ?? {};
  if (family !== null && family !== "default" && isEffort(table[family])) return table[family];
  if (isEffort(table.default)) return table.default;
  return DEFAULT_MAX_EFFORT;
}

/**
 * effort が cap より強いか。
 * @param {Effort} effort
 * @param {Effort} cap
 * @returns {boolean}
 */
export function effortAbove(effort, cap) {
  return EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(cap);
}

/**
 * 子の系統の既定の推論量。格 1 は high、格 2 以上は medium。上限より上なら上限まで下げる。
 * @param {string} family
 * @param {SubagentsConfig} cfg
 * @returns {Effort}
 */
export function defaultEffortFor(family, cfg) {
  const tier = mergedTiers(cfg)[family];
  const base = tier === 1 ? "high" : "medium";
  const cap = effortCapFor(family, cfg);
  return effortAbove(base, cap) ? cap : base;
}

/**
 * 子のモデルが格 4 以上、または子の提供元の上限より上でないか確かめる。
 * 系統・提供元が分からなければ問題なしとする。
 * @param {string} child
 * @param {SubagentsConfig} cfg
 * @returns {{ ok: true } | { ok: false, kind: "tier4" | "above-cap", family: string }}
 */
export function checkChildModel(child, cfg) {
  const tiers = mergedTiers(cfg);
  const family = familyOf(child, tiers);
  if (family === null) return { ok: true };
  if (tiers[family] > CHILD_MAX_TIER) return { ok: false, kind: "tier4", family };
  const vendor = vendorOfFamily(family);
  if (vendor !== null && tiers[family] > childMaxTier(vendor, cfg)) {
    return { ok: false, kind: "above-cap", family };
  }
  return { ok: true };
}

/**
 * 子と指揮役の格を比べる。
 * @param {string} child
 * @param {string | null} orchestrator
 * @param {Record<string, number>} tiers
 * @returns {"higher" | "same-model" | "ok" | "unknown"}
 */
export function compareTier(child, orchestrator, tiers) {
  if (orchestrator === null || orchestrator === undefined) return "unknown";
  const c = familyOf(child, tiers);
  const o = familyOf(orchestrator, tiers);
  if (c === null || o === null) return "unknown";
  if (c === o) return "same-model";
  return tiers[c] > tiers[o] ? "higher" : "ok";
}

/**
 * @typedef {{ vendor: Vendor, childModel: string | null, childEffort: Effort | null, orchestratorModel: string | null }} SpawnInput
 * vendor は指揮役のツール（claude・codex）。
 */

const DENY_LABELS = {
  missing: "子のモデルが指定されていません",
  inherit: "子のモデルが inherit（指揮役の引き継ぎ）になっています",
  "same-model": "子が指揮役と同じ系統のモデルです",
  higher: "子が指揮役より上の格のモデルです",
  tier4: "格 4 以上のモデルは子に使いません（指揮役だけが使えます）",
  "above-cap": "子のモデルが子の上限（maxModel）より上の格です",
  effort: "子の推論量が子のモデルの系統の上限より上です",
};

/**
 * 子の起動の拒否の文言。理由の種類と、明示の必要を伝える。
 * @param {"missing" | "inherit" | "same-model" | "higher" | "tier4" | "above-cap" | "effort"} kind
 * @param {{ child: string | null, orchestrator: string | null, effort?: Effort, cap?: string, vendor?: Vendor, family?: string }} detail
 * @returns {string}
 */
export function messageSpawnDenied(kind, detail = {}) {
  const lines = [`子の起動を拒否しました。理由: ${DENY_LABELS[kind] ?? kind}。`];
  if (detail.child) lines.push(`子のモデル: ${detail.child}`);
  if (detail.orchestrator) lines.push(`指揮役のモデル: ${detail.orchestrator}`);
  if (detail.family && (kind === "above-cap" || kind === "tier4")) lines.push(`子の系統: ${detail.family}`);
  if (kind === "effort") lines.push(`子の推論量: ${detail.effort}（上限: ${detail.cap}、系統: ${detail.family ?? "不明"}）`);
  lines.push(
    "子のモデルは、指揮役と異なる、指揮役の格以下かつ子の上限以下のモデルを、推論量の上限以下で明示してください。",
  );
  if (kind === "missing") {
    const from = detail.vendor ?? "<claude|codex>";
    lines.push(
      "使う定義の名前は次のコマンドで求められます。",
      `node .agent-hooks/cc-sdd-bootstrap/delegate.mjs --resolve-model --from ${from} --role <役割> --orchestrator-model <自分のモデル>`,
    );
  }
  return lines.join("\n");
}

/**
 * 設定が壊れているときの文言。直るまで子を起動しない。
 * @param {string[]} problems
 * @returns {string}
 */
export function messageConfigBroken(problems) {
  return [
    "subagents の設定に問題があるため、直るまで子を起動しません。",
    "問題の項目:",
    ...problems.map((p) => `- ${p}`),
    "直し方: .cc-sdd-bootstrap.json の subagents を直してください。",
    "問題の確かめ方: npx github:nekono-dev/cc-sdd-bootstrap update（または node bin/cc-sdd-bootstrap.mjs update）を実行します。",
  ].join("\n");
}

/**
 * 子の起動を通すか拒否するかを決める純粋な判定。
 * 順に: 未指定・inherit → 格 4・上限超え → 推論量の上限超え → 同じ系統・上の格。確かめられなければ通す。
 * @param {SpawnInput} input
 * @param {SubagentsConfig} cfg
 * @returns {{ deny: false } | { deny: true, reason: string }}
 */
export function decideSpawn(input, cfg) {
  const { vendor, childModel, childEffort, orchestratorModel } = input;
  const detail = { child: childModel ?? null, orchestrator: orchestratorModel ?? null, vendor };
  const deny = (kind, extra = {}) => ({ deny: true, reason: messageSpawnDenied(kind, { ...detail, ...extra }) });
  if (!isName(childModel)) return deny("missing");
  if (childModel.trim().toLowerCase() === "inherit") return deny("inherit");
  const check = checkChildModel(childModel, cfg);
  if (!check.ok) return deny(check.kind, { family: check.family });
  const tiers = mergedTiers(cfg);
  if (isEffort(childEffort)) {
    const cap = effortCapFor(familyOf(childModel, tiers), cfg);
    if (effortAbove(childEffort, cap)) return deny("effort", { effort: childEffort, cap, family: familyOf(childModel, tiers) });
  }
  const cmp = compareTier(childModel, orchestratorModel, tiers);
  if (cmp === "same-model" || cmp === "higher") return deny(cmp);
  return { deny: false };
}

const otherVendor = (v) => (v === "claude" ? "codex" : "claude");

/**
 * 役割ごとの既定のモデル（系統）を決める。
 * 目標の格: 実装 = 指揮役 −1、レビュー・デバッグ = 指揮役、調査 = max(指揮役 −2, 1)。
 * 上限 = min(目標, 委任先の子の上限の格, 3)。委任先の系統のうち上限以下で最も上の格（同じ格は名前の順で最初）。
 * 委任先が指揮役と同じ提供元なら指揮役の系統（分からなければ指揮役の格の系統）を候補から外す。
 * @param {Role} role
 * @param {Vendor} target 委任先の提供元
 * @param {{ vendor: Vendor, tier: number, family: string | null }} orchestrator
 * @param {SubagentsConfig} cfg
 * @returns {{ kind: "family", family: string } | { kind: "self" } | { kind: "none", reason: string }}
 */
export function defaultModelFor(role, target, orchestrator, cfg) {
  const tiers = mergedTiers(cfg);
  const T = orchestrator.tier;
  const sameVendor = target === orchestrator.vendor;
  const goal = role === "implement" ? T - 1 : role === "investigate" ? Math.max(T - 2, 1) : T;
  if (goal < 1) return { kind: "self" };
  const cap = Math.min(goal, childMaxTier(target, cfg), CHILD_MAX_TIER);
  const candidates = Object.keys(tiers)
    .filter((f) => vendorOfFamily(f) === target && tiers[f] <= cap)
    .filter((f) => {
      if (!sameVendor) return true;
      return orchestrator.family !== null ? f !== orchestrator.family : tiers[f] !== T;
    })
    .sort((a, b) => tiers[b] - tiers[a] || (a < b ? -1 : a > b ? 1 : 0));
  if (candidates.length > 0) return { kind: "family", family: candidates[0] };
  if (sameVendor) return { kind: "self" };
  return {
    kind: "none",
    reason: `${target} に、格 ${cap} 以下で使える系統がありません（子の上限か格の設定を見直してください）`,
  };
}

/**
 * 子のモデルが確定したあとの実際の推論量と知らせ。明示が無ければ子の系統の既定、
 * 明示は子の系統の上限まで下げて知らせる（元の設定の値は変えない）。
 * @param {Effort | undefined} explicit 役割設定の明示の推論量
 * @param {string | null | undefined} childModel 確定した子のモデルの名前
 * @param {SubagentsConfig} cfg
 * @returns {{ effort: Effort, notices: string[] }}
 */
export function resolveEffort(explicit, childModel, cfg) {
  const tiers = mergedTiers(cfg);
  const family = typeof childModel === "string" ? familyOf(childModel, tiers) : null;
  const cap = effortCapFor(family, cfg);
  if (explicit === undefined) {
    if (family !== null) return { effort: defaultEffortFor(family, cfg), notices: [] };
    return { effort: effortAbove("medium", cap) ? cap : "medium", notices: [] };
  }
  if (effortAbove(explicit, cap)) {
    const label = family ?? "共通";
    return {
      effort: cap,
      notices: [`推論量 ${explicit} は ${label} の上限（${cap}）より上なので ${cap} に下げました`],
    };
  }
  return { effort: explicit, notices: [] };
}

/**
 * 役割定義の名前。Claude Code は `cc-sdd-<役割>-<系統>`、Codex は `cc_sdd_<役割>`。
 * @param {Vendor} vendor
 * @param {Role} role
 * @param {string} family
 * @returns {string}
 */
export function definitionNameFor(vendor, role, family) {
  return vendor === "claude" ? `cc-sdd-${role}-${family}` : `cc_sdd_${role}`;
}

/**
 * 役割を解決する（委任先・モデル・推論量・権限）。
 * 役割設定の明示値を優先し、無い項目は既定の分担と既定のモデルの決め方で補う。
 * opts.to で委任先を指揮役と同じ（same）・別（other）に切り替えられる。
 * 同じ提供元への切り替えで、明示のモデルが切り替え先の提供元に属さないときは、その明示を使わず知らせる。
 * @param {SubagentsConfig} cfg
 * @param {Vendor} from 指揮役の提供元
 * @param {Role} role
 * @param {string | null} orchestratorModel 指揮役のモデル（分からなければ null で格 2 とみなす）
 * @param {{ to?: "same" | "other" }} [opts]
 * @returns {{ ok: true, target: Vendor, setting: RoleSetting, selfImplement: boolean, effort: Effort,
 *   definitionName: string | null, notices: string[] } | { ok: false, reason: string }}
 */
export function resolveRole(cfg, from, role, orchestratorModel, opts = {}) {
  const tiers = mergedTiers(cfg);
  const notices = [];
  const explicit = cfg?.roles?.[from]?.[role] ?? {};
  const setting = { ...DEFAULT_ROLES[from][role], ...explicit };
  const switched = opts?.to === "same" || opts?.to === "other";
  if (switched) setting.provider = opts.to;
  const target = setting.provider === "same" ? from : otherVendor(from);
  const configuredTarget = (explicit.provider ?? DEFAULT_ROLES[from][role].provider) === "same" ? from : otherVendor(from);

  // 同じ提供元への切り替え（to: same）で、明示のモデルが切り替え先に属さなければ使わず知らせる。
  // 別の提供元への切り替え（to: other）で委任先が変わり明示のモデルと食い違うときは、置き換えず理由を返す
  let model = setting.model;
  if (model !== undefined && switched) {
    const f = familyOf(model, tiers);
    const v = f === null ? null : vendorOfFamily(f);
    if (v !== null && v !== target) {
      if (opts.to === "same") {
        notices.push(`役割設定のモデル ${model} は ${target} のものではないので使わず、既定の決め方で選びました`);
        model = undefined;
      } else if (target !== configuredTarget) {
        return {
          ok: false,
          reason: `役割設定のモデル ${model} は ${target} のものではありません（--to other では置き換えません。役割設定のモデルか provider を見直してください）`,
        };
      }
    }
  }

  let selfImplement = false;
  if (model === undefined) {
    const fam = typeof orchestratorModel === "string" ? familyOf(orchestratorModel, tiers) : null;
    const orchestrator = { vendor: from, tier: fam !== null ? tiers[fam] : 2, family: fam };
    const d = defaultModelFor(role, target, orchestrator, cfg);
    if (d.kind === "none") return { ok: false, reason: d.reason };
    if (d.kind === "self") selfImplement = true;
    else model = d.family;
  }
  delete setting.model;
  if (model !== undefined) setting.model = model;

  const e = resolveEffort(explicit.effort, model, cfg);
  notices.push(...e.notices);
  const family = model !== undefined ? familyOf(model, tiers) : null;
  let definitionName = null;
  if (target === "claude" && family !== null) {
    // 定義は Claude の系統で、子に使える格（上限以下）のものだけが作られる
    const generated = vendorOfFamily(family) === "claude" && tiers[family] <= Math.min(childMaxTier("claude", cfg), CHILD_MAX_TIER);
    if (generated) definitionName = definitionNameFor("claude", role, family);
    else notices.push(`${family} の定義は作られないので、組み込みの子の定義は使えません`);
  } else if (target === "codex" && setting.permission === "write") {
    definitionName = definitionNameFor("codex", role, family ?? "");
  }
  return { ok: true, target, setting, selfImplement, effort: e.effort, definitionName, notices };
}

/**
 * @typedef {{ slug: string, visibility: string, priority: number, levels: string[] }[]} ModelCatalog
 */

/**
 * 起動に使うモデルの名前を求める。
 * 完全な名前（系統の語そのものでない）はそのまま → modelIds → Claude Code は別名（系統の語）
 * → Codex は一覧（visibility が list で slug が "-<系統>" で終わるうち priority が最小）。
 * @param {string} model
 * @param {Vendor} vendor
 * @param {SubagentsConfig} cfg
 * @param {ModelCatalog | null} catalog
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
export function resolveModelName(model, vendor, cfg, catalog) {
  const tiers = mergedTiers(cfg);
  const family = familyOf(model, tiers);
  if (family === null || model.toLowerCase() !== family) return { ok: true, name: model };
  const ids = cfg?.modelIds;
  if (isObject(ids) && isName(ids[family])) return { ok: true, name: ids[family] };
  if (vendor === "claude") return { ok: true, name: family };
  const hits = (Array.isArray(catalog) ? catalog : [])
    .filter((m) => m.visibility === "list" && typeof m.slug === "string" && m.slug.endsWith(`-${family}`))
    .sort((a, b) => a.priority - b.priority);
  if (hits.length === 0) {
    return {
      ok: false,
      reason: `${family} の最新のモデル名を Codex のモデルの一覧から求められません（modelIds.${family} で名前を指定してください）`,
    };
  }
  return { ok: true, name: hits[0].slug };
}

/**
 * subagents の値を検証する。誤りは問題の項目の道筋つきで返す。
 * @param {unknown} value
 * @returns {{ ok: true, config: SubagentsConfig } | { ok: false, problems: string[] }}
 */
export function validateSubagents(value) {
  if (value === undefined) return { ok: true, config: {} };
  if (!isObject(value)) {
    return { ok: false, problems: ["subagents: 対応（キーと値の組）で指定してください"] };
  }
  const problems = [];
  const sub = (key, name) => {
    const v = value[key];
    if (v === undefined) return null;
    if (!isObject(v)) {
      problems.push(`subagents.${name}: 対応（キーと値の組）で指定してください`);
      return null;
    }
    return v;
  };

  const tiersIn = sub("tiers", "tiers");
  if (tiersIn) {
    for (const [k, v] of Object.entries(tiersIn)) {
      if (k === "") problems.push("subagents.tiers: 系統の名前は空にできません");
      else if (!isTier(v)) problems.push(`subagents.tiers.${k}: 格は 1 以上の整数で指定してください`);
    }
  }
  const tiers = mergedTiers(value);

  const modelIds = sub("modelIds", "modelIds");
  if (modelIds) {
    for (const [k, v] of Object.entries(modelIds)) {
      if (!isName(v)) problems.push(`subagents.modelIds.${k}: 空でないモデルの名前で指定してください`);
    }
  }

  const maxModel = sub("maxModel", "maxModel");
  if (maxModel) {
    for (const [k, v] of Object.entries(maxModel)) {
      if (!VENDORS.includes(k)) {
        problems.push(`subagents.maxModel.${k}: 提供元は ${VENDORS.join("・")} のどちらかにしてください`);
        continue;
      }
      // 系統の語と完全に一致するものだけを受け付ける（版付き・部分一致は誤り）
      const family = isName(v) && Object.hasOwn(tiers, v) ? v : null;
      if (family === null || vendorOfFamily(family) !== k) {
        problems.push(`subagents.maxModel.${k}: ${k} の系統の名前で指定してください`);
      } else if (tiers[family] > CHILD_MAX_TIER) {
        problems.push(`subagents.maxModel.${k}: 子に使える格（${CHILD_MAX_TIER} 以下）の系統を指定してください`);
      }
    }
  }

  const maxEffort = sub("maxEffort", "maxEffort");
  if (maxEffort) {
    for (const [k, v] of Object.entries(maxEffort)) {
      if (k !== "default" && !Object.hasOwn(tiers, k)) {
        problems.push(`subagents.maxEffort.${k}: キーは default か系統の名前にしてください`);
      } else if (!isEffort(v)) {
        problems.push(`subagents.maxEffort.${k}: 推論量は ${EFFORT_ORDER.join("・")} のどれかにしてください`);
      }
    }
  }

  const roles = sub("roles", "roles");
  if (roles) {
    for (const [from, byRole] of Object.entries(roles)) {
      if (!VENDORS.includes(from)) {
        problems.push(`subagents.roles.${from}: 提供元は ${VENDORS.join("・")} のどちらかにしてください`);
        continue;
      }
      if (!isObject(byRole)) {
        problems.push(`subagents.roles.${from}: 対応（キーと値の組）で指定してください`);
        continue;
      }
      for (const [role, setting] of Object.entries(byRole)) {
        validateRoleSetting(problems, `subagents.roles.${from}.${role}`, from, role, setting, value, tiers);
      }
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: value };
}

/** 役割 1 つの設定を検証し、問題を problems に足す */
function validateRoleSetting(problems, path, from, role, setting, cfg, tiers) {
  if (!ROLES.includes(role)) {
    problems.push(`${path}: 役割は ${ROLES.join("・")} のどれかにしてください`);
    return;
  }
  if (!isObject(setting)) {
    problems.push(`${path}: 対応（キーと値の組）で指定してください`);
    return;
  }
  for (const k of Object.keys(setting)) {
    if (!SETTING_KEYS.includes(k)) {
      problems.push(`${path}.${k}: 使えない項目です（${SETTING_KEYS.join("・")} のどれか）`);
    }
  }
  if (setting.provider !== undefined && !["same", "other"].includes(setting.provider)) {
    problems.push(`${path}.provider: same か other で指定してください`);
  }
  if (setting.permission !== undefined && !PERMISSIONS.includes(setting.permission)) {
    problems.push(`${path}.permission: ${PERMISSIONS.join(" か ")} で指定してください`);
  }
  let family = null;
  if (setting.model !== undefined) {
    if (!isName(setting.model)) {
      problems.push(`${path}.model: 空でないモデルの名前で指定してください`);
    } else {
      family = familyOf(setting.model, tiers);
      const check = checkChildModel(setting.model, cfg);
      if (!check.ok) {
        problems.push(
          check.kind === "tier4"
            ? `${path}.model: 格 ${CHILD_MAX_TIER + 1} 以上のモデル（${check.family}）は子に使えません`
            : `${path}.model: 子の上限より上のモデル（${check.family}）は指定できません`
        );
      } else if (family !== null) {
        // 提供元が分からない系統でも、委任先の提供元（役割表から決まる）の上限と格で比べる
        const provider = setting.provider ?? DEFAULT_ROLES[from][role].provider;
        const target = provider === "same" ? from : from === "claude" ? "codex" : "claude";
        if (tiers[family] > childMaxTier(target, cfg)) {
          problems.push(`${path}.model: 委任先（${target}）の子の上限より上のモデル（${family}）は指定できません`);
        }
      }
    }
  }
  if (setting.effort !== undefined) {
    if (!isEffort(setting.effort)) {
      problems.push(`${path}.effort: 推論量は ${EFFORT_ORDER.join("・")} のどれかにしてください`);
    } else {
      const cap = effortCapFor(family, cfg);
      if (effortAbove(setting.effort, cap)) {
        problems.push(`${path}.effort: 推論量の上限（${cap}）より上は指定できません`);
      }
    }
  }
}

/** 設定ファイルの項目 subagents の定義（配置物の基本の項目につなぐ） */
export const subagentsField = {
  path: "subagents",
  kind: "map",
  defaultValue: {},
  validate(value) {
    const r = validateSubagents(value);
    return r.ok ? null : r.problems.join("、");
  },
};

/** 提供元ごとの推論量（Claude Code は ultra を受け付けない） */
export const VENDOR_EFFORTS = { claude: ["low", "medium", "high", "xhigh", "max"], codex: EFFORT_ORDER };

/**
 * 推論量をその提供元のモデルが受け付けるか。
 * Claude Code は VENDOR_EFFORTS.claude。Codex はモデルの一覧の受け付ける値（あれば）、無ければ VENDOR_EFFORTS.codex。
 * @param {Vendor} vendor
 * @param {string} effort
 * @param {string[] | null} catalogLevels
 * @returns {boolean}
 */
export function effortSupported(vendor, effort, catalogLevels) {
  if (vendor === "codex" && Array.isArray(catalogLevels)) return catalogLevels.includes(effort);
  return (VENDOR_EFFORTS[vendor] ?? []).includes(effort);
}

/**
 * 別の提供元の CLI を起動するコマンドと引数を組み立てる（起動はしない。指示は標準入力で渡す）。
 * @param {Vendor} target
 * @param {{ permission: string, effort: string }} setting
 * @param {string} modelName
 * @param {string} root 作業場所
 * @returns {{ command: string, args: string[] }}
 */
export function buildCliCommand(target, setting, modelName, root) {
  const readOnly = setting.permission === "read-only";
  if (target === "codex") {
    return {
      command: "codex",
      args: ["-a", "never", "exec", "--sandbox", readOnly ? "read-only" : "workspace-write", "--model", modelName,
        "--config", `model_reasoning_effort="${setting.effort}"`, "--cd", root, "-"],
    };
  }
  return {
    command: "claude",
    args: ["-p", "--model", modelName, "--effort", setting.effort,
      ...(readOnly ? ["--tools", "Read,Grep,Glob"] : ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"])],
  };
}

const ROLE_LABELS = { implement: "実装・修正", review: "レビュー", investigate: "調査", debug: "デバッグの原因調査" };
const ROLE_TASKS = {
  implement: "割り当てられた作業の範囲だけを実装・修正し、結果と確認の内容を簡潔に報告してください。",
  review: "変更を点検し、問題点と根拠を簡潔に報告してください。",
  investigate: "指示された事柄を調べ、分かったことと根拠を簡潔に報告してください。",
  debug: "不具合の原因を突き止め、原因と根拠を簡潔に報告してください。",
};
/** 役割の短い指示。設定後の権限（write・read-only）を反映する */
function instructionFor(role, permission) {
  const access = permission === "write"
    ? "必要な編集とテストの実行ができます。作業の範囲を超えて変更しないでください。"
    : "読み取り専用で作業し、ファイルは変更しません。";
  return `${ROLE_TASKS[role]}${access}`;
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** 役割設定（明示を含む）の最終的な設定 */
function roleSettingOf(cfg, from, role) {
  return { ...DEFAULT_ROLES[from][role], ...(cfg?.roles?.[from]?.[role] ?? {}) };
}

/**
 * Claude Code の定義の説明文。Claude Code が指揮役のとき（roles.claude）だけから作る。
 * 同じ提供元の指揮役の系統を外す既定のモデルの決め方（defaultModelFor）の逆引き。
 */
function claudeDescription(cfg, role, family, explicit) {
  const tiers = mergedTiers(cfg);
  const setting = roleSettingOf(cfg, "claude", role);
  const label = ROLE_LABELS[role];
  const head = `cc-sdd の${label}の役割（${capitalize(family)}）。`;
  if (explicit) return `${head}役割設定でモデルを明示した Claude Code の指揮役が${label}を任せるときに使う。`;
  const users = Object.keys(tiers)
    .filter((f) => vendorOfFamily(f) === "claude")
    .filter((f) => {
      const d = defaultModelFor(role, "claude", { vendor: "claude", tier: tiers[f], family: f }, cfg);
      return d.kind === "family" && d.family === family;
    })
    .sort((a, b) => tiers[a] - tiers[b])
    .map((f) => `${capitalize(f)} の指揮役`);
  const who = users.length > 0 ? users.join("・") : "指揮役";
  return setting.provider === "same"
    ? `${head}${who}が${label}を任せるとき。`
    : `${head}別の提供元が使えないとき（同じ提供元での委任）に ${who}が使う。`;
}

/** Claude Code の定義 1 つ（frontmatter と短い指示）。値は YAML の二重引用の文字列で書く */
function claudeDefinition(role, family, model, effort, permission, description) {
  const name = definitionNameFor("claude", role, family);
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `model: ${JSON.stringify(model)}`,
    `effort: ${effort}`,
  ];
  if (permission === "read-only") lines.push("tools: Read, Grep, Glob");
  lines.push("---", "", instructionFor(role, permission), "");
  return { path: `.claude/agents/${name}.md`, content: lines.join("\n") };
}

/**
 * 役割定義の中身を作る。ファイルは書かず、道筋と中身を返す。指揮役のモデルは使わない。
 * Claude Code: roles.claude の役割 × 子に使える Claude の系統ごとに 1 つ。
 * Codex: roles.codex のうち書き込み可の役割だけ 1 つ（モデルも推論量も書かない）。
 * @param {SubagentsConfig} cfg
 * @returns {{ files: { path: string, content: string }[], notices: string[] }}
 */
export function renderDefinitions(cfg) {
  const tiers = mergedTiers(cfg);
  const files = [];
  const notices = [];
  const maxTier = Math.min(childMaxTier("claude", cfg), CHILD_MAX_TIER);
  const allFamilies = Object.keys(tiers)
    .filter((f) => vendorOfFamily(f) === "claude" && tiers[f] <= maxTier)
    .sort((a, b) => tiers[a] - tiers[b] || (a < b ? -1 : 1));

  for (const role of ROLES) {
    const setting = roleSettingOf(cfg, "claude", role);
    const explicitModel = setting.model;
    const explicitFamily = explicitModel !== undefined ? familyOf(explicitModel, tiers) : null;
    const onlyOwn = explicitFamily !== null && vendorOfFamily(explicitFamily) === "claude" && allFamilies.includes(explicitFamily);
    if (explicitModel !== undefined && !onlyOwn) {
      notices.push(`役割 ${role} のモデル ${explicitModel} は Claude Code の定義には使わず、使える系統すべての定義を作りました（別の提供元が使えないときの予備）`);
    }
    const families = onlyOwn ? [explicitFamily] : allFamilies;
    for (const family of families) {
      const model = onlyOwn ? explicitModel : family;
      const name = definitionNameFor("claude", role, family);
      const e = resolveEffort(cfg?.roles?.claude?.[role]?.effort, model, cfg);
      notices.push(...e.notices.map((n) => `${name}: ${n}`));
      if (!effortSupported("claude", e.effort, null)) {
        notices.push(`${name}: 推論量 ${e.effort} は Claude Code が受け付けないので、この定義は作りませんでした`);
        continue;
      }
      files.push(claudeDefinition(role, family, model, e.effort, setting.permission, claudeDescription(cfg, role, family, onlyOwn)));
    }
  }

  for (const role of ROLES) {
    const setting = roleSettingOf(cfg, "codex", role);
    if (setting.permission !== "write") {
      notices.push(`Codex の組み込みの子では読み取り専用を適用できない（${role}）`);
      continue;
    }
    const name = definitionNameFor("codex", role, "");
    const description = `cc-sdd の${ROLE_LABELS[role]}の役割。Codex の指揮役が${ROLE_LABELS[role]}を任せるときに使う。`;
    const content = [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(description)}`,
      `developer_instructions = ${JSON.stringify(instructionFor(role, setting.permission))}`,
      "",
    ].join("\n");
    files.push({ path: `.codex/agents/${name}.toml`, content });
  }
  return { files, notices };
}
