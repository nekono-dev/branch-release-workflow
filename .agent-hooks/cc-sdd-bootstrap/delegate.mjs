// 別の提供元の入口。役割を解決し、起動の名前と推論量を求め、起動してよいかを確かめる。
// 判定は subagent-roles.mjs に任せ、このファイルは入出力と引数の扱いに徹する。
import { closeSync, fstatSync, openSync, promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROLES, DEFAULT_TIERS, EFFORT_ORDER, buildCliCommand, checkChildModel, compareTier, effortAbove, effortCapFor, effortSupported,
  childMaxTier, familyOf, vendorOfFamily, resolveEffort, resolveModelName, resolveRole, validateSubagents,
} from "./subagent-roles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const FROMS = ["claude", "codex"];
const ROLES = ["implement", "review", "investigate", "debug"];
const VALUE_FLAGS = ["--from", "--role", "--orchestrator-model", "--instructions", "--effort", "--model", "--to"];

/** 止める（理由を標準エラーに出して終了 2）ための例外 */
class Stop extends Error {}
const stop = (message) => { throw new Stop(message); };

/** 引数を読む。誤りは Stop */
function parseArgs(argv) {
  const out = { resolveModel: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--resolve-model") { out.resolveModel = true; continue; }
    if (!VALUE_FLAGS.includes(a)) stop(`不明な引数です: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--") || v.trim() === "") stop(`${a} の値がありません`);
    out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    i += 1;
  }
  if (!FROMS.includes(out.from)) stop("--from は claude か codex を指定してください");
  if (!ROLES.includes(out.role)) stop(`--role は ${ROLES.join("・")} のどれかを指定してください`);
  if (out.orchestratorModel === undefined) {
    stop("--orchestrator-model（今の指揮役のモデル）が必要です。指揮役の格が分からないと子のモデルを決められません");
  }
  if (out.to !== undefined && out.to !== "same") stop("--to は same だけを指定できます（別の提供元は役割設定の provider で選びます）");
  if (out.effort !== undefined && !EFFORT_ORDER.includes(out.effort)) {
    stop(`--effort は ${EFFORT_ORDER.join("・")} のどれかを指定してください`);
  }
  if (!out.resolveModel && out.instructions === undefined) stop("--instructions（指示のファイル）が必要です");
  return out;
}

/** 設定を読む。ファイルが無ければ既定。読めない・誤りは Stop */
async function loadConfig() {
  let text;
  try {
    text = await fs.readFile(path.join(root, ".cc-sdd-bootstrap.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    return stop(`.cc-sdd-bootstrap.json を読み取れません（${error.code ?? error.message}）。読み取れる状態に直してください`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    return stop(`.cc-sdd-bootstrap.json が JSON として読めません（${error.message}）。直してください`);
  }
  if (!isObject(parsed)) return stop(".cc-sdd-bootstrap.json は対応（キーと値の組）で書いてください");
  const r = validateSubagents(parsed.subagents);
  if (!r.ok) return stop(`設定 subagents に誤りがあります。次を直してください。\n${r.problems.map((p) => `- ${p}`).join("\n")}`);
  return r.config;
}

/** codex debug models の出力から、名前・表示対象・優先度・受け付ける推論量の一覧を作る。失敗なら null */
function fetchCatalog() {
  // 標準入力は使わない。Codex の制限付きサンドボックスでは、標準入力のパイプを閉じる処理が失敗して error に載り、一覧を捨ててしまうため
  const r = spawnSync("codex", ["debug", "models"], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) return null;
  try {
    const value = JSON.parse(r.stdout);
    if (!isObject(value) || !Array.isArray(value.models)) return null;
    return value.models.filter((m) => isObject(m) && typeof m.slug === "string").map((m) => ({
      slug: m.slug,
      visibility: m.visibility,
      priority: typeof m.priority === "number" ? m.priority : Number.MAX_SAFE_INTEGER,
      // 項目が無いモデルは null（一覧なしと同じ扱い）。空の配列とは区別する
      levels: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((l) => (isObject(l) ? l.effort : l)).filter((e) => typeof e === "string")
        : null,
    }));
  } catch { return null; }
}

/** 設定の格の表（既定に足す） */
function tiersOf(cfg) {
  const tiers = { ...DEFAULT_TIERS };
  if (isObject(cfg.tiers)) {
    for (const [k, v] of Object.entries(cfg.tiers)) if (k !== "" && Number.isInteger(v) && v >= 1) tiers[k.toLowerCase()] = v;
  }
  return tiers;
}

/** 役割設定の推論量を除いた設定 */
function withoutEffort(cfg, from, role) {
  const { effort: _omit, ...rest } = cfg.roles?.[from]?.[role] ?? {};
  return { ...cfg, roles: { ...cfg.roles, [from]: { ...cfg.roles?.[from], [role]: rest } } };
}

/** 役割設定の model だけをその実行用に置き換えた設定 */
function withModel(cfg, from, role, model) {
  return { ...cfg, roles: { ...cfg.roles, [from]: { ...cfg.roles?.[from], [role]: { ...cfg.roles?.[from]?.[role], model } } } };
}

/**
 * 解決と確かめ。止める場合は Stop。
 * @returns {{ line: string, summary: string, notices: string[] }}
 */
function decide(args, cfg) {
  const to = args.to;
  // その実行の --model が委任先の提供元に属さないときは、役割設定のときのように既定に置き換えず止める
  if (args.model !== undefined) {
    const provider = cfg.roles?.[args.from]?.[args.role]?.provider ?? DEFAULT_ROLES[args.from][args.role].provider;
    const willTarget = to === "same" || provider === "same" ? args.from : args.from === "claude" ? "codex" : "claude";
    const f = familyOf(args.model, tiersOf(cfg));
    const v = f === null ? null : vendorOfFamily(f);
    if (v !== null && v !== willTarget) {
      return stop(`--model ${args.model} は委任先（${willTarget}）のものではありません。委任先のモデルを指定してください`);
    }
  }
  const baseCfg = args.model !== undefined ? withModel(cfg, args.from, args.role, args.model) : cfg;
  // 推論量の知らせは入口で取り直すので、resolveRole には役割設定の推論量を渡さない（知らせを文言で見分けない）
  const r = resolveRole(withoutEffort(baseCfg, args.from, args.role), args.from, args.role, args.orchestratorModel, { to });
  if (!r.ok) return stop(r.reason);
  if (r.selfImplement) {
    return stop("同じ提供元に子として使える系統がないため、この役割は指揮役自身が行ってください（子は起動しません）");
  }
  const builtin = args.resolveModel && r.setting.provider === "same";
  if (!args.resolveModel && r.setting.provider === "same" && to === undefined) {
    return stop(`役割 ${args.role} は同じ提供元の組み込みの子が受け持ちます（--resolve-model で定義の名前を求めて使ってください）。同じ提供元の CLI で起動するには --to same を付けてください`);
  }
  const tiers = tiersOf(cfg);
  const notices = [...r.notices];
  const target = r.target;

  // Claude Code の組み込みの子は定義の固定の値で動く。その実行の指定・系統ごとの名前の指定は使えない
  if (builtin && target === "claude") {
    if (args.model !== undefined || args.effort !== undefined) {
      return stop("Claude Code の組み込みの子は定義のモデルと推論量で動くので、--model・--effort は使えません（別の指定にするなら --to same で CLI を起動してください）");
    }
    if (r.definitionName === null) {
      return stop(`この役割に使う Claude Code の組み込みの子の定義は作られないため、適用できません（${notices.at(-1) ?? "子に使える系統の定義がありません"}）`);
    }
    const model = r.setting.model;
    const e = resolveEffort(cfg.roles?.claude?.[args.role]?.effort, model, cfg);
    const effort = e.effort;
    verify({ name: model, effort, target, args, cfg, tiers, levels: null, explicitEffort: false });
    notices.push(...e.notices);
    return { line: `${r.definitionName} ${effort}`, summary: "", notices };
  }

  if (builtin && target === "codex" && r.definitionName === null) {
    return stop("Codex の組み込みの子では、この役割（読み取り専用）の権限を適用できません。同じ提供元の CLI（--to same で codex exec --sandbox read-only）で起動してください");
  }

  const family = typeof r.setting.model === "string" ? familyOf(r.setting.model, tiers) : null;
  if (family !== null && vendorOfFamily(family) !== null && vendorOfFamily(family) !== target) {
    return stop(`モデル ${r.setting.model} は委任先（${target}）のものではありません`);
  }
  const catalog = target === "codex" ? fetchCatalog() : null;
  const resolved = resolveModelName(r.setting.model, target, cfg, catalog);
  if (!resolved.ok) return stop(resolved.reason);
  const name = resolved.name;
  // modelIds を反映した最終的な名前で、委任先の提供元に属するか照合する
  const finalFamily = familyOf(name, tiers);
  const finalVendor = finalFamily === null ? null : vendorOfFamily(finalFamily);
  if (finalVendor !== null && finalVendor !== target) {
    return stop(`起動の名前 ${name} は委任先（${target}）のものではないため適用できません（modelIds の指定を見直してください）`);
  }
  const levels = catalog?.find((m) => m.slug === name)?.levels ?? null;

  // 実際に起動する名前の系統で、役割設定の元の推論量から求め直す
  const e = resolveEffort(cfg.roles?.[args.from]?.[args.role]?.effort, name, cfg);
  if (args.effort === undefined) notices.push(...e.notices);
  const effort = args.effort ?? e.effort;
  verify({ name, effort, target, args, cfg, tiers, levels, explicitEffort: args.effort !== undefined });
  return {
    line: `${name} ${effort}`,
    summary: `委任先: ${target} モデル: ${name} 推論量: ${effort} 権限: ${r.setting.permission}`,
    notices,
    launch: { target, name, effort, permission: r.setting.permission },
  };
}

/** 格・上限・指揮役との関係・推論量を確かめる。問題があれば Stop */
function verify({ name, effort, target, args, cfg, tiers, levels, explicitEffort }) {
  const c = checkChildModel(name, cfg);
  if (!c.ok) {
    return stop(c.kind === "tier4"
      ? `モデル ${name}（${c.family}）は格 4 で、子には使えません`
      : `モデル ${name}（${c.family}）は ${target} の子の上限より上です`);
  }
  // 系統の提供元が分からなくても、格が分かれば委任先の子の上限と比べる
  const famTier = familyOf(name, tiers);
  if (famTier !== null) {
    if (tiers[famTier] > 3) return stop(`モデル ${name}（${famTier}）は格 4 以上で、子には使えません`);
    if (tiers[famTier] > childMaxTier(target, cfg)) return stop(`モデル ${name}（${famTier}）は ${target} の子の上限より上です`);
  }
  const rel = compareTier(name, args.orchestratorModel, tiers);
  if (rel === "same-model") return stop(`モデル ${name} は指揮役（${args.orchestratorModel}）と同じ系統です。指揮役と異なるモデルにしてください`);
  if (rel === "higher") return stop(`モデル ${name} は指揮役（${args.orchestratorModel}）より上の格です。指揮役の格以下にしてください`);
  const fam = familyOf(name, tiers);
  const cap = effortCapFor(fam, cfg);
  if (explicitEffort && effortAbove(effort, cap)) {
    return stop(`--effort ${effort} は ${fam ?? "共通"} の推論量の上限（${cap}）より上です`);
  }
  if (!effortSupported(target, effort, levels)) {
    return stop(`推論量 ${effort} は ${target} のモデル ${name} が受け付けません`);
  }
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig();
  const result = decide(args, cfg);
  for (const n of result.notices) process.stderr.write(`知らせ: ${n}\n`);
  if (args.resolveModel) {
    process.stdout.write(`${result.line}\n`);
    return;
  }
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = launchChild(result.launch, args.instructions);
}

// Claude Code の子に渡さない環境変数。推論量を一律に上書きするものと、Claude Code のセッションの中であることを示すもの
const CLAUDE_ENV_TO_DROP = ["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_EFFORT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/**
 * 確かめ済みの値で子の CLI を起動し、終了コードを返す。起動できなければ Stop（別の条件ではやり直さない）。
 * 指示のファイルは、開いた記述子をそのまま標準入力にする（パイプへの書き込みと close は Codex のサンドボックスで EPERM になるため）。
 */
function launchChild({ target, name, effort, permission }, instructions) {
  let fd;
  try {
    fd = openSync(instructions, "r");
  } catch (error) {
    return stop(`指示のファイルを読み取れません: ${instructions}（${error.code ?? error.message}）。子は起動しません`);
  }
  try {
    if (!fstatSync(fd).isFile()) return stop(`指示のファイルが通常のファイルではありません: ${instructions}。子は起動しません`);
    const cmd = buildCliCommand(target, { permission, effort }, name, root);
    const env = { ...process.env };
    if (cmd.command === "claude") for (const k of CLAUDE_ENV_TO_DROP) delete env[k];
    const r = spawnSync(cmd.command, cmd.args, { cwd: root, env, stdio: [fd, "inherit", "inherit"] });
    if (r.error) {
      return stop(`委任先の CLI（${cmd.command}）を起動できません（${r.error.code ?? r.error.message}）。別の条件でのやり直しはしません`);
    }
    const code = r.status ?? 1;
    process.stderr.write(code === 0 ? "委任先の終了: 成功（終了コード 0）\n" : `委任先の終了: 失敗（終了コード ${code}）\n`);
    return code;
  } finally {
    closeSync(fd);
  }
}

main().catch((error) => {
  if (error instanceof Stop) process.stderr.write(`delegate: ${error.message}\n`);
  else process.stderr.write(`delegate: 予期しない誤りです。詳細: ${error.message || "詳細なし"}\n`);
  process.exitCode = 2;
});
