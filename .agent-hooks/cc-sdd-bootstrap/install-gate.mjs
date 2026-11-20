#!/usr/bin/env node
/**
 * cc-sdd-bootstrap が各プロジェクトに置く、導入の失敗の記録を見てプロンプトを止めるフック（UserPromptSubmit）。
 * session-install の spec が、記録の中身と再試行の方法を示す形に一般化した。
 *
 * 理由: SessionStart は終了コードで止められない（Claude Code の仕様）。止められるのは UserPromptSubmit。
 * 記録は導入スクリプト（install-cc-sdd.mjs）が書き、成功したら消す。
 *
 * 使い方: node .agent-hooks/cc-sdd-bootstrap/install-gate.mjs user-prompt-submit
 * 判定は標準出力の JSON（decision: "block"）で返す。
 *
 * 失敗時の方針: 例外は標準エラーに出し、終了 0 にする（記録の判定ができないときに作業を止めない）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(scriptDir, "../..")

/** 導入の失敗の記録と、再試行の方法。対象を足すときは 1 件足す。 */
export const installFailures = [
  {
    name: "cc-sdd",
    record: ".cache/cc-sdd-install.failed",
    retry: "node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs",
  },
]

/** 記録のある対象だけを、記録の中身（先頭 2000 文字。読めなければその旨）つきで返す。 */
export const pendingInstallFailures = root =>
  installFailures
    .filter(failure => fs.existsSync(path.join(root, failure.record)))
    .map(failure => {
      let detail
      try {
        detail = fs.readFileSync(path.join(root, failure.record), "utf-8").slice(0, 2000).trimEnd()
      } catch {
        detail = "（記録を読めませんでした）"
      }
      return { ...failure, detail }
    })

/** 利用者に示す理由。対象ごとに名前・記録の中身・再試行の方法を並べる。 */
export const installBlockReason = failures =>
  [
    "導入が完了していないため（失敗・中断を含む）、プロンプトを止めています。新しいセッションを開くと、導入が再試行されます。すぐに直す場合は、Claude の外（通常のターミナル）で次のコマンドを実行してください。成功してから、もう一度入力してください。",
    ...failures.flatMap(failure => [
      `- ${failure.name}`,
      failure.detail
        .split("\n")
        .map(line => `  ${line}`)
        .join("\n"),
      `  再試行: ${failure.retry}`,
    ]),
  ].join("\n")

/** UserPromptSubmit の判定。記録が無ければ null（何もしない）。 */
export const decideUserPromptSubmit = root => {
  const failures = pendingInstallFailures(root)
  if (failures.length === 0) return null
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      // 表示からプロンプトの本文を外す（会話の記録からは外れない）
      suppressOriginalPrompt: true,
    },
    decision: "block",
    reason: installBlockReason(failures),
  }
}

const main = () => {
  const event = process.argv[2]
  if (event !== "user-prompt-submit") throw new Error(`未知のイベント: ${event}`)
  const output = decideUserPromptSubmit(repoRoot)
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  try {
    main()
  } catch (error) {
    // 判定できないときは通す（作業を止めない）
    process.stderr.write(`install-gate: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(0)
  }
}
