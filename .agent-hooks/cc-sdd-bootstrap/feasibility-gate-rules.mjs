// 実現性の確認の判定（純粋な処理）。
// ファイル・git・環境変数を読まず、入力（コマンド・記録の解析結果など）から結果だけを計算する。
import { detectCommand } from "./kiro-gate-rules.mjs";

/** 対象にする kiro コマンド（分類の対象。停止するかは STOP_TARGETS で決める） */
const TARGET_SKILLS = new Set([
  "kiro-spec-requirements",
  "kiro-spec-design",
  "kiro-validate-design",
  "kiro-spec-tasks",
  "kiro-impl",
  "kiro-spec-quick",
  "kiro-spec-batch",
]);

/**
 * 入力時に止めるコマンドと、止めるのに必要な段階。
 * 段階は "design"（設計）か "tasks"（タスク計画）。後続の spec で対象を足しやすいようデータにしている。
 */
const STOP_TARGETS = {
  "kiro-spec-tasks": "design",
  "kiro-impl": "tasks",
  "kiro-spec-quick": "design",
  "kiro-spec-batch": "design",
};

/**
 * 続けて作るコマンド（設計からタスクまでを一度に作る）。spec が特定できないときだけ案内し、
 * 特定できて設計が通過なら何も返さない（5.10・5.12）。
 */
const CHAINED_COMMANDS = new Set(["kiro-spec-quick", "kiro-spec-batch"]);

/** spec 名の規則。パスの意図しない解決を防ぐため、この規則に合うものだけ採る */
const SPEC_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 記録の節の見出しと、段階の対応 */
const SECTION_HEADINGS = {
  need: "実機検証の要否",
  design: "設計の確認",
  tasks: "タスク計画の確認",
};

/** 判定の語と、解析結果の値の対応 */
const NEED_WORDS = { 必要: "required", 不要: "unneeded" };
const STAGE_WORDS = { 通過: "pass", 未通過: "fail" };

/**
 * 水平線・下線つきの見出しの行（前後の空白を除いた形）。
 * `=` だけの行（下線つきの見出し）、`-`・`*`・`_` が 3 個以上（水平線）。
 */
const RULE_PATTERN = /^(?:=+|(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/;

/**
 * 先頭の kiro コマンドを、対象のコマンドと spec 名に分ける。対象外・コマンドなしは null。
 * spec 名は、コマンド名の後の語のうち `-` で始まらない最初の語（規則に合わなければ null）。
 * @param {unknown} prompt - 利用者の入力
 * @returns {{ skill: string, spec: string | null } | null}
 */
export function classifyPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const command = detectCommand(prompt);
  if (!command || !TARGET_SKILLS.has(command.skill)) return null;

  // detectCommand は先頭の空白を除いてから照合するので、同じ前提で後ろの文字列を切り出す
  const trimmed = prompt.trimStart();
  const rest = trimmed.slice(1 + command.skill.length);
  // `-` で始まる引数（例: -y）は読み飛ばし、最初の語を spec 名の候補にする
  const firstWord = rest.trim().split(/\s+/).find((word) => word !== "" && !word.startsWith("-"));
  const spec = firstWord !== undefined && SPEC_NAME_PATTERN.test(firstWord) ? firstWord : null;
  return { skill: command.skill, spec };
}

/**
 * 記録（feasibility.md）の本文を解析する。
 * 3 つの `## ` の節ごとに、行頭（空白なし）の `- 判定: <語>` の行がちょうど 1 つあるときだけ、語を値にする。
 * 節が無い・判定の行が無い・2 つ以上・語が違うときは null。
 * コードブロック（CommonMark のフェンス）と HTML コメントの中は読まない。
 * 迷う形は読まず null（止める側）に倒す。
 * @param {unknown} text - 記録の本文
 * @returns {{ need: "required" | "unneeded" | null, design: "pass" | "fail" | null, tasks: "pass" | "fail" | null }}
 */
export function parseRecord(text) {
  const sections = readSections(typeof text === "string" ? text : "");
  return {
    need: judgementOf(sections, SECTION_HEADINGS.need, NEED_WORDS),
    design: judgementOf(sections, SECTION_HEADINGS.design, STAGE_WORDS),
    tasks: judgementOf(sections, SECTION_HEADINGS.tasks, STAGE_WORDS),
  };
}

/**
 * 本文を節ごとに分け、各節の判定の語（trim 済み）を集める。
 * 同じ見出しの節が 2 つあるときは、どちらが正か決められないので無効にする（null を入れる）。
 * 節の境界は、レベル 1・2 の見出し、水平線・下線つきの見出し、前置きのあるコメントの開始、対象外の見出し。
 * 4 個以上の空白・タブで始まる行は判定として読まない（見出しに見えるものは境界にする）。
 * @param {string} text
 * @returns {Map<string, string[] | null>}
 */
function readSections(text) {
  const sections = new Map();
  let current = null;
  // 開いているフェンス（コードブロック）。null なら外。CommonMark に合わせ、文字・長さ（閉じるには開始以上）を覚える
  let fence = null;
  // HTML コメントの中か（閉じの `-->` が来るまで読まない）
  let comment = false;

  for (const line of text.split(/\r?\n/)) {
    if (fence !== null) {
      // フェンスの中の行は見出しにも判定にも使わない。同じ文字で開始以上の長さの閉じ行だけがフェンスを閉じる
      const closing = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
      continue;
    }

    if (comment) {
      // コメントの中の行は見出しにも判定にも使わない
      if (line.includes("-->")) comment = false;
      continue;
    }

    // 行頭（0〜3 個の空白・タブの後）の 3 文字以上の並びで開始する。バッククォートの開始行は情報文字列に ` を含めない
    const opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }

    // HTML コメントの開始。前に文字があるなら、その行は節の境界として扱う（保守的に終わらせる）
    const commentStart = line.indexOf("<!--");
    if (commentStart !== -1) {
      if (line.slice(0, commentStart).trim() !== "") current = null;
      comment = !line.slice(commentStart + 4).includes("-->");
      continue;
    }

    const trimmedStart = line.replace(/^[ \t]+/, "");
    // 4 個以上の空白・タブで始まる行は読まない。見出しや水平線に見えるものだけは境界にする
    if (line.startsWith("\t") || line.length - trimmedStart.length >= 4) {
      if (/^#{1,6}(?:[ \t]|$)/.test(trimmedStart) || RULE_PATTERN.test(trimmedStart)) current = null;
      continue;
    }

    // 水平線・下線つきの見出しは、直前の節を終わらせる
    if (RULE_PATTERN.test(trimmedStart)) {
      current = null;
      continue;
    }

    // レベル 1・2 の見出しは節を終わらせる。レベル 3 以上は節の中に含める
    const heading = /^(#{1,6})(?:[ \t]|$)(.*)$/.exec(trimmedStart);
    if (heading) {
      if (heading[1].length === 1) {
        current = null;
        continue;
      }
      if (heading[1].length >= 3) continue;
      // 閉じの `#` つき（`## 名前 ##`）は、名前から除く
      const name = heading[2].trim().replace(/(?:^|[ \t]+)#+$/, "").trim();
      if (sections.has(name)) {
        sections.set(name, null);
        current = null;
      } else {
        sections.set(name, []);
        current = name;
      }
      continue;
    }

    // 判定の行は、行頭（空白なし）の `- 判定:` だけを数える（半角コロン）
    const judgement = /^-[ \t]*判定:(.*)$/.exec(line);
    if (judgement && current !== null) {
      sections.get(current).push(judgement[1].trim());
    }
  }
  return sections;
}

/**
 * 節の判定の語を値に直す。節が無効・判定が 1 つでない・語が対応表に無いときは null。
 * @param {Map<string, string[] | null>} sections
 * @param {string} heading - 節の見出し
 * @param {Record<string, string>} words - 語と値の対応
 * @returns {string | null}
 */
function judgementOf(sections, heading, words) {
  const values = sections.get(heading);
  if (!values || values.length !== 1) return null;
  return Object.hasOwn(words, values[0]) ? words[values[0]] : null;
}

/**
 * 追加の指示だけを返すコマンド。spec が特定できなくても、段階の指示を出す（1.1〜2.6）。
 * kiro-spec-quick・kiro-spec-batch は 2.3 で扱うので、ここには含めない。
 */
const ALWAYS_CONTEXT = new Set(["kiro-spec-requirements", "kiro-spec-design", "kiro-validate-design"]);

/**
 * 入力を判断する。
 * - 要件・設計・設計の確認: spec の特定の有無によらず、追加の指示（context）。
 * - 停止の対象（kiro-spec-tasks・kiro-impl）: spec が特定でき、必要な段階が通過でないときだけ止める（block。記録が無い・読めないも止める）。それ以外は追加の指示（context）。
 * - それ以外（kiro-spec-quick・kiro-spec-batch を含む）: 何も返さない（none）。
 * 要否（need）は判断に使わない（5.9）。想定外の型は止めない側に倒す。
 * @param {{ skill: string, spec: string | null } | null} command - classifyPrompt の結果
 * @param {boolean} specFound - spec のディレクトリが特定できたか
 * @param {{ need: unknown, design: unknown, tasks: unknown } | null} record - 記録の解析結果。読めなければ null
 * @returns {{ kind: "none" } | { kind: "context", text: string } | { kind: "block", reason: string }}
 */
export function decideInput(command, specFound, record) {
  if (!command || typeof command !== "object") return { kind: "none" };
  const spec = typeof command.spec === "string" ? command.spec : null;
  // 記録を読む対象が特定できたか（spec 名があり、spec のディレクトリが見つかった）
  const known = spec !== null && specFound === true;
  const name = known ? spec : null;
  if (ALWAYS_CONTEXT.has(command.skill)) return { kind: "context", text: messageContext(command.skill, name) };
  if (!Object.hasOwn(STOP_TARGETS, command.skill)) return { kind: "none" };

  const stage = STOP_TARGETS[command.skill];
  if (known) {
    if (!record || typeof record !== "object") {
      return { kind: "block", reason: messageBlock(spec, stage, "no-record", command.skill) };
    }
    if (record[stage] !== "pass") {
      return { kind: "block", reason: messageBlock(spec, stage, "not-passed", command.skill) };
    }
    if (CHAINED_COMMANDS.has(command.skill)) return { kind: "none" };
  }
  return { kind: "context", text: messageContext(command.skill, name) };
}

/**
 * 利用者向けの停止の理由（日本語）。spec 名・段階・通す手順・記録の場所を示す。
 * @param {string} spec - spec 名
 * @param {"design" | "tasks"} stage - 段階
 * @param {"no-record" | "not-passed"} reason - 記録が無い・判定が通過でない
 * @param {string} skill - 止められたコマンド名
 * @returns {string}
 */
export function messageBlock(spec, stage, reason, skill) {
  const stageName = stage === "tasks" ? "タスク計画" : "設計";
  const section = stage === "tasks" ? SECTION_HEADINGS.tasks : SECTION_HEADINGS.design;
  const review = stage === "tasks" ? "`/kiro-spec-tasks`" : "`/kiro-spec-design`・`/kiro-validate-design`";
  const cause = reason === "no-record" ? "記録がありません" : "判定が通過ではありません";
  const path = `.kiro/specs/${spec}/feasibility.md`;
  const lines = [
    `spec \`${spec}\` の${stageName}の実現性の確認が通っていません（${cause}）。`,
    `${review}で前提ごとの根拠を確認し、\`${path}\` の \`## ${section}\` の \`- 判定:\` を \`通過\` にしてから、もう一度同じ入力を送ってください。`,
    "実機検証が不要なら、`## 実機検証の要否` に `- 判定: 不要` と理由を書いてください。",
  ];
  if (skill === "kiro-spec-quick" || skill === "kiro-spec-batch") {
    lines.push("これらは設計とタスクを続けて作るコマンドなので、個別の段階のコマンド（`/kiro-spec-design`・`/kiro-spec-tasks` など）で確認を済ませてから送ってください。");
  }
  return lines.join("\n");
}

/**
 * `git worktree list --porcelain -z` の出力から worktree の根を取り出す（純粋な処理）。
 * -z の出力は NUL 区切りの生のパスなので、引用も改行の折り返しも無い。
 * 空のフィールド（NUL が続く）で 1 つの worktree のまとまりが終わる。bare と prunable のまとまりは外す。
 * @param {unknown} text - git の標準出力
 * @returns {string[]} worktree の根（絶対パス）
 */
export function parseWorktreeListZ(text) {
  const roots = [];
  let block = [];
  for (const field of typeof text === "string" ? text.split("\0") : []) {
    if (field === "") {
      pushWorktree(block, roots, false);
      block = [];
    } else {
      block.push(field);
    }
  }
  pushWorktree(block, roots, false);
  return roots;
}

/**
 * `git worktree list --porcelain` の出力から worktree の根を取り出す（-z が使えない git のフォールバック。純粋な処理）。
 * 特殊文字を含むパスは `worktree "..."` の形で引用されうるため、引用符で始まるものは候補に入れない（誤った場所を作らない）。
 * @param {unknown} text - git の標準出力
 * @returns {string[]} 引用されていない worktree の根
 */
export function parseWorktreeListPorcelain(text) {
  const roots = [];
  let block = [];
  for (const line of typeof text === "string" ? text.split(/\r?\n/) : []) {
    if (line === "") {
      pushWorktree(block, roots, true);
      block = [];
    } else {
      block.push(line);
    }
  }
  pushWorktree(block, roots, true);
  return roots;
}

/**
 * worktree の 1 つのまとまりから根を足す。bare と prunable は外す。
 * rejectQuoted が真（porcelain）なら、引用符で始まるパスも外す。
 */
function pushWorktree(block, roots, rejectQuoted) {
  const line = block.find((item) => item.startsWith("worktree "));
  if (line === undefined) return;
  if (block.some((item) => item === "bare" || item.startsWith("prunable"))) return;
  const root = line.slice("worktree ".length);
  if (rejectQuoted && root.startsWith("\"")) return;
  roots.push(root);
}

/** 段階ごとの指示に共通する、実現性の記録の書式（エージェント向け）。path は記録の場所 */
function recordFormatOf(path) {
  return `実現性の記録は \`${path}\` に置きます。3 つの節 \`## 実機検証の要否\`・\`## 設計の確認\`・\`## タスク計画の確認\` があり、各節に \`- 判定: <語>\` の行をちょうど 1 つ書きます。要否の語は \`必要\`・\`不要\`、段階の語は \`通過\`・\`未通過\` です。判定の行より前に水平線 \`---\` を置かないでください。確認をやり直したら、該当節の判定をまず \`未通過\` に戻してから、結果で更新してください。`;
}

/** 段階ごとの追加の指示の文言（エージェント向けの日本語）。対象外のコマンドは空文字 */
const CONTEXT_TEXTS = {
  "kiro-spec-requirements": (path) => `【実現性の確認】この依頼は要件を作る段階です。実機検証の要否を判定し、必要でも不要でも、判定と理由を記録の \`## 実機検証の要否\` に残してください。外部の動作（ツール・API・OS・外部サービスの挙動）に依存する前提が 1 つでもあれば「必要」にします。「不要」にできるのは、外部の動作に依存する前提が無い場合に限ります。必要なら、前提ごとに PoC（実機で前提を確かめる試作。結果は PoC 文書に残す）を作ることを基本とし、PoC を作らない前提は、その前提と理由を記録してください。不要でも、判定と理由を記録してください。${recordFormatOf(path)}`,
  "kiro-spec-design": (path) => designContextOf(path),
  "kiro-validate-design": (path) => designContextOf(path),
  "kiro-spec-tasks": (path) => `【実現性の確認】タスク計画の各前提の根拠（一次資料の出典、または位置付けと結果が文書で追える PoC 文書の場所）と、実施の段取りが確実にできるかを確認してください。実機検証が必要な spec では、実際の配置物・実機を使う確認を、最初の実装タスク（またはその群）に置いてください。実機の確認が最後に置かれている・欠けているなど未解決があれば、「未解決」として記録に残し、計画を直してから更新してください。結果は記録の \`## タスク計画の確認\` に残し、各前提の根拠の有無、実機の確認が最初に置かれているか（最初の実装タスクの番号）を書いてください。判定の語（\`通過\`・\`未通過\`）のうち通過にしてよいのは、根拠の無い前提と未解決が無いときだけです。レビュー役の依頼文にも、この観点（実機の確認が最初の実装タスクにあるか）を入れてください。${recordFormatOf(path)}`,
  "kiro-spec-quick": (path) => batchNoticeOf(path),
  "kiro-spec-batch": (path) => batchNoticeOf(path),
  "kiro-impl": (path) => `【実現性の確認】実装中に要件・設計と現実の食い違いが見つかったら、その場で requirements.md・design.md を書き換えないでください。cc-sdd の Blocked の扱い（タスクを止めて理由を残す）で、該当する段階（要件・設計・タスク）へ戻してください。戻した後は、記録の該当節の判定をまず \`未通過\` に戻してから、確認し直して更新してください。${recordFormatOf(path)}`,
};

/** 続けて作るコマンド（kiro-spec-quick・kiro-spec-batch）の案内。spec を特定できないときに出す（5.12） */
function batchNoticeOf(path) {
  return `【実現性の確認】\`kiro-spec-quick\`・\`kiro-spec-batch\` は設計とタスクを続けて作るため、この入力の前に、spec ごとに個別の段階のコマンドで実現性の確認を済ませ、記録（\`${path}\`）の設計の確認が通過になっていることを確かめてください。名前なしの一括作成は入力を止められないので、各 spec の設計・タスク計画の確認を個別に行ってください。`;
}

/** 設計の段階（kiro-spec-design・kiro-validate-design で同じ文言）の追加の指示 */
function designContextOf(path) {
  return `【実現性の確認】設計の前提ごとに根拠を確認してください。認める根拠は、一次資料（出典の場所と版が示せるもの）か、PoC 文書（\`.kiro/specs/<spec 名>/poc/<段階>_<通し番号>.md\`。位置付けと結果が文書で追えるもの）だけです。PoC 文書は、冒頭の \`- 対象:\`・\`- 段階:\` と、実施日・環境と版・結果を含む必須の項目がそろったものに限ります。根拠の無い前提は「未確認」として記録に残し、設計の承認の前に根拠を足してください。結果は記録の \`## 設計の確認\` に残し、前提ごとの根拠（一次資料の出典、または PoC 文書の場所）と、根拠の無い前提の有無（無ければ「なし」と明記）を書いてください。判定の語（\`通過\`・\`未通過\`）のうち通過にしてよいのは、根拠の無い前提が無いときだけです。根拠の無い前提が残るうちは \`未通過\` のままにしてください。レビュー役（子のエージェント）を起動するときは、依頼文に観点「前提ごとの根拠が一次資料か、PoC 文書で位置付けと結果が追える PoC で確かめられているか」を入れてください。${recordFormatOf(path)}`;
}

/**
 * 段階ごとの追加の指示（エージェント向け）。spec 名が分かるときは記録の場所を具体的に書き、分からないときは `<spec 名>` のまま書く。
 * 対象外のコマンドは空文字。
 * @param {string} skill - コマンド名
 * @param {string | null} spec - spec 名（分からなければ null）
 * @returns {string}
 */
export function messageContext(skill, spec = null) {
  const build = Object.hasOwn(CONTEXT_TEXTS, skill) ? CONTEXT_TEXTS[skill] : null;
  if (build === null) return "";
  const path = typeof spec === "string" ? `.kiro/specs/${spec}/feasibility.md` : ".kiro/specs/<spec 名>/feasibility.md";
  return build(path);
}
