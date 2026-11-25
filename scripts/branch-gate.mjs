#!/usr/bin/env node
// ブランチ作成・再開のゲート（brw-branch-gate）。ここでは案内の書式（guidance）だけを置く。
// 置き換えの計画（planGate）と EnterWorktree の判定（judgeEnterWorktree）は後続のタスクで同じファイルに追加する。
// 外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
import { isAbsolute } from "node:path";
import { redactSecrets, sanitize } from "./lib.mjs";

const HEADING = "[branch-release-workflow]";
const OUTCOMES = ["置き換え", "拒否"];

/**
 * 案内の文面を作る。同じ入力には同じ文面を返す（要件 4.5）。
 * 書式は次のとおり。見出しの行は機械的な取り出し用で、本文だけで手順が読み取れるように書く（research.md #6）。
 *   [branch-release-workflow] <1 行の結論>
 *   BRW 案内: 置き換え | 拒否
 *   次のコマンド: <1 件のコマンド、または 2 件のとき「1) …」「2) …」>
 *   作業場所: <絶対パス。無ければ ->
 *   <理由と注意の自然文（複数行可）>
 *
 * @param {object} input
 * @param {"置き換え"|"拒否"} input.outcome 種別
 * @param {string} input.conclusion 1 行の結論
 * @param {string[]} input.commands 次に実行するコマンド（1 件、または 2 手のとき 2 件）
 * @param {string|null} input.workdir 作業場所の絶対パス。無いときは null
 * @param {string} input.notes 理由と次の手順の自然文（改行で行を分ける）
 * @returns {string} 案内の文面（改行で区切る）
 */
export function guidance({ outcome, conclusion, commands, workdir, notes }) {
  // 不正な入力では文面を組み立てず、呼び出し側の誤りを早く見つける
  if (!OUTCOMES.includes(outcome)) throw new Error(`案内の種別が不正です: ${outcome}`);
  const headline = sanitize(conclusion);
  if (headline === "") throw new Error("案内の結論が空です");
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 2) throw new Error("案内の次のコマンドは 1 件か 2 件で指定してください");
  if (commands.some((c) => String(c ?? "").trim() === "")) throw new Error("案内の次のコマンドが空です");
  // 改行を含むコマンドは「次のコマンド:」の 1 行に収まらないため、組み立てない（コマンドの意味は変えられない）
  if (commands.some((c) => /[\r\n]/.test(String(c)))) throw new Error("案内の次のコマンドに改行を含めることはできません");
  // 改行を含む作業場所も、見出しの「作業場所:」の 1 行に収まらないため、組み立てない
  if (typeof workdir === "string" && /[\r\n]/.test(workdir)) throw new Error("案内の作業場所に改行を含めることはできません");
  const body = String(notes ?? "").split(/\r?\n/).map((line) => sanitize(line)).filter((line) => line !== "");
  if (body.length === 0) throw new Error("案内の本文（理由と次の手順）が空です");

  // コマンドと作業場所は、そのまま実行できるように空白や長さを変えない。資格情報らしい値だけを伏せる
  const cmds = commands.map((c) => redactSecrets(c));
  // 2 手のときは「1) …」「2) …」を 1 行に並べる。見出しの「次のコマンド:」の行は常に 1 行
  const next = cmds.length === 1 ? cmds[0] : cmds.map((c, i) => `${i + 1}) ${c}`).join(" ");
  // 作業場所は絶対パスだけを書く。無い・相対パスのときは「-」
  const place = typeof workdir === "string" && isAbsolute(workdir) ? redactSecrets(workdir) : "-";

  return [
    `${HEADING} ${headline}`,
    `BRW 案内: ${outcome}`,
    `次のコマンド: ${next}`,
    `作業場所: ${place}`,
    ...body,
  ].join("\n");
}
