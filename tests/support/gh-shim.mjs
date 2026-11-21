#!/usr/bin/env node
// 統合テスト用の偽の gh。PATH の先頭に置いて、子プロセスの brw.mjs が呼ぶ `gh api` を受け取る。
// 通信も認証も行わず、要求を tests/support/fake-github.mjs へ渡す。
// 環境変数: BRW_GH_SHIM_CONFIG（{scenario, routes} の JSON のパス）、BRW_GH_SHIM_LOG（要求を 1 行 1 件で追記する先）。
// 要求は必ず BRW_GH_SHIM_LOG に残る（予期しない呼び出しは unexpected として残す）。資格情報は受け取らず、記録もしない。
import { appendFileSync, readFileSync } from "node:fs";
import { createFakeGitHub } from "./fake-github.mjs";

const args = process.argv.slice(2);
const logPath = process.env.BRW_GH_SHIM_LOG;
const log = (entry) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

// 認証トークンは実際の値を返さない（テストで使うのは GH_TOKEN の存在だけ）
if (args[0] === "auth" && args[1] === "token") {
  process.stdout.write("shim-token\n");
  process.exit(0);
}
if (args[0] !== "api") {
  log({ unexpected: args.slice(0, 3).join(" ") });
  process.stderr.write(`偽の gh は未対応の呼び出しです: ${args.slice(0, 2).join(" ")}\n`);
  process.exit(2);
}

const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const method = (valueOf("--method") ?? "GET").toUpperCase();
const host = valueOf("--hostname");
// gh api のパスは "/" で始まる引数（-H の値は "Accept: ..." なので対象外）
const path = args.find((a) => a.startsWith("/"));
const body = args.includes("--input") ? readFileSync(0, "utf8") : undefined;
const parsed = body ? JSON.parse(body) : undefined;

const cfg = JSON.parse(readFileSync(process.env.BRW_GH_SHIM_CONFIG, "utf8"));
const fake = createFakeGitHub({ scenario: cfg.scenario, routes: cfg.routes });

let res;
let lost = false;
try {
  res = await fake.request(method, path, parsed, { host });
} catch {
  lost = true;
}
// applied は、この要求で書き込みが適用されたかどうか（応答喪失でも適用されうる）
log({ method, path, host, body: parsed ?? null, applied: fake.applied.length > 0, lost });
if (lost) {
  // 応答が届かなかった場合の見え方（ghTransport は解釈できない応答として扱う）
  process.stderr.write("応答が途中で切れました\n");
  process.exit(1);
}
process.stdout.write(`HTTP/2.0 ${res.status} ${res.status < 300 ? "OK" : "Error"}\r\ncontent-type: application/json\r\n\r\n${res.body === undefined ? "" : JSON.stringify(res.body)}`);
