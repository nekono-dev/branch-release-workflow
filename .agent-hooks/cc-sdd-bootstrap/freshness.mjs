#!/usr/bin/env node
// セッション開始の入口。導入の記録を読み、配置物の指紋を照合し、配布元の最新と比べて、案内があるときだけ 1 行の JSON を出す。
// 判定・文面は freshness-rules.mjs に任せ、この入口は読み取り・git の呼び出し・出力だけを行う。
// 想定外の失敗はすべて握りつぶし、出力せず終了コード 0 で通す（セッションを止めない）。
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 配置先は .agent-hooks/cc-sdd-bootstrap/ なので、2 つ上が導入先の根
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GIT_TIMEOUT_MS = 3000;

/** 引数を検査する。対応するのは `session-start --tool claude|codex` だけで、それ以外は null */
function argumentsOf(argv) {
  if (argv.length !== 3 || argv[0] !== "session-start" || argv[1] !== "--tool") return null;
  const tool = argv[2];
  if (tool !== "claude" && tool !== "codex") return null;
  return { tool };
}

/**
 * 記録の文字列を読む。ファイルが無ければ null（記録なし）。
 * それ以外の読み取りの失敗は、壊れている扱いにするため空の文字列を返す（JSON として不正なので broken になる）。
 * @param {typeof import("./freshness-rules.mjs")} rules
 */
async function readRecordText(rules) {
  try {
    return await fs.readFile(path.join(root, rules.RECORD_PATH), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return "";
  }
}

/**
 * 記録のファイルの指紋を求める。読めないファイルは null（欠けとして扱う）。
 * @param {typeof import("./freshness-rules.mjs")} rules
 * @param {Record<string, string>} files
 */
async function actualFingerprints(rules, files) {
  // __proto__ などのキーが混ざっても汚れないよう、プロトタイプを持たないオブジェクトにする
  const actual = Object.create(null);
  for (const rel of Object.keys(files)) {
    try {
      actual[rel] = rules.fingerprint(await fs.readFile(path.join(root, rel)));
    } catch {
      actual[rel] = null;
    }
  }
  return actual;
}

/**
 * 配布元の最新を取得して記録と比べる。通信の失敗・待ち時間の超過・不正な出力は unknown（比較だけを省く）。
 * 固定のコミット・コミットが無い記録では通信しない。
 * @param {typeof import("./freshness-rules.mjs")} rules
 * @param {{ commit: string | null, ref: string | null }} source
 * @returns {"same" | "behind" | "unknown"}
 */
function latestOf(rules, record, source) {
  const query = rules.remoteQuery(source);
  if (query === null || source.commit === null) return "unknown";
  const result = spawnSync("git", ["ls-remote", rules.DISTRIBUTION_REPO, ...query], {
    encoding: "utf8",
    // 標準入力は使わず、認証の入力を求めさせない
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return "unknown";
  return rules.compareLatest(record, rules.pickRemoteCommit(result.stdout, source.ref));
}

/** 入口の本体。出力する値（無ければ null）を返す */
async function main(argv) {
  const args = argumentsOf(argv);
  if (args === null) return null;

  // 自分の純粋部品だけを動的に読む。読み込みの失敗も下の try で握りつぶす
  const rules = await import("./freshness-rules.mjs");

  const text = await readRecordText(rules);
  const parsed = rules.parseRecord(text);

  let inspection = null;
  let latest = "unknown";
  if (parsed.state === "ok") {
    const record = parsed.record;
    const actual = await actualFingerprints(rules, record.files);
    inspection = rules.inspectFiles(record, actual);
    latest = latestOf(rules, record, record.source);
  }

  const notice = rules.decideNotice({ parsed, inspection, latest });
  if (notice === null) return null;
  const message = rules.messageNotice(notice);
  return {
    systemMessage: message.systemMessage,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message.additionalContext,
    },
  };
}

try {
  const output = await main(process.argv.slice(2));
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch {
  // 想定外の失敗は出力せず通す
}
process.exitCode = 0;
