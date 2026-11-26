#!/usr/bin/env node
// ブランチ作成・再開のゲート（brw-branch-gate）。案内の書式（guidance）と、作成の置き換えの計画（planGate）を置く。
// planGate は git を呼ばない純粋な関数。git の状態は gatherFacts（呼び出し側が作る）から受け取る。
// 外部依存なし（Node 標準ライブラリと内部モジュールのみ）。
import { BRW_RUN } from "./brw-cmd.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aliasOf, checkName, classifyBranch, configRel, currentBranch, enabledInRepo, git, loadConfig, redactSecrets, sanitize, worktrees } from "./lib.mjs";

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

// ---- 作成の置き換え（planGate） -----------------------------------------------

// BRW の CLI（brw.mjs）の絶対パス。このファイルと同じ scripts/ にある
const BRW_CLI = join(dirname(fileURLToPath(import.meta.url)), "brw.mjs");
// 置き換えの組み立てに使ってよいブランチ名・パスの文字。これ以外は組み立てず、拒否の案内にする
const SAFE_VALUE = /^[A-Za-z0-9._/-]+$/;
// 作成の入口ごとに許す指定。ここに無い指定は、BRW の作成と同じ結果にならないため置き換えない
const VIA_OPTIONS = {
  switch: { value: "-c", allowed: ["-c", "--no-track", "-q", "--quiet"] },
  checkout: { value: "-b", allowed: ["-b", "--no-track", "-q", "--quiet"] },
  branch: { value: null, allowed: ["--no-track"] },
  worktree: { value: "-b", allowed: ["-b", "-q", "--quiet"] },
};

/** 値を 1 つのシェルの単語にする。単一引用符で囲み、中の単一引用符は '\'' にする（シェルに解釈させると元の値に戻る）。 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 1 行のコマンドを、`&&` で区切られた語の列に分ける。引用の外の記号（; & | ( ) < > $ ` \ * ? [ ] ~ { } # と改行）があれば null。
 * 二重引用符の中の $ ` \ も展開されるため null にする。確定できないコマンドは null（安全側）。
 * @returns {string[][] | null} 区切りごとの語の列
 */
export function splitWords(command) {
  const segments = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) {
      words.push(word);
      word = null;
    }
  };
  const endSegment = () => {
    endWord();
    segments.push(words);
    words = [];
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let end = i + 1;
      while (end < command.length && command[end] !== '"') {
        if (/[$`\\]/.test(command[end])) return null;
        end++;
      }
      if (end >= command.length) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "&" && command[i + 1] === "&") {
      endSegment();
      i += 2;
    } else if (/[;&|()<>$`\\*?[\]~{}#\r\n]/.test(c)) {
      return null;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  endSegment();
  return segments.some((s) => s.length === 0) ? null : segments;
}

/**
 * 作業ツリーの git の状態を集める（planGate の入力）。本体の作業ツリーや状態を読めないときは null（確定できない）。
 * @param {string} cwd 操作の作業ディレクトリ
 */
export function gatherFacts(cwd) {
  const list = worktrees(cwd);
  const mainRoot = list[0]?.path ?? null;
  const status = git(cwd, "status", "--porcelain");
  if (mainRoot === null || status === null) return null;
  const lines = status.split("\n").filter((l) => l !== "");
  const untracked = lines.filter((l) => l.startsWith("??")).length;
  const exists = (ref) => git(cwd, "show-ref", "--verify", "--quiet", ref) !== null;
  return {
    cwd,
    mainRoot,
    currentBranch: currentBranch(cwd),
    mainBranch: list[0]?.branch ?? null,
    // ブランチを使用中の worktree（本体を除く）のパス。無ければ null
    worktreeOf: (name) => list.slice(1).find((w) => w.branch === name)?.path ?? null,
    trackedChanges: lines.length - untracked,
    untrackedChanges: untracked,
    branchExists: (name) => ({ local: exists(`refs/heads/${name}`), origin: exists(`refs/remotes/origin/${name}`) }),
    declaredAt: (ref) => git(cwd, "cat-file", "-e", `${ref}:${configRel(mainRoot)}`) !== null,
  };
}

// 拒否の結果。理由は案内の書式で組み立て、次のコマンドを含める
const denied = (code, conclusion, commands, notes, workdir = null) => ({
  verdict: "deny",
  code,
  reason: guidance({ outcome: "拒否", conclusion, commands, workdir, notes: notes.join("\n") }),
});

// 作成の置き換え（rewrite）か拒否を決める本体。git は呼ばない
function planCore({ command, op, config, facts, hasLeadingCd, unresolved }) {
  const branch = op.branch ?? null;
  const safe = (v) => typeof v === "string" && v !== "" && SAFE_VALUE.test(v);
  const name = safe(branch) ? branch : "<名前>";
  const main = facts?.mainRoot ?? "<本体>";
  const flags = op.branchOnly === true ? " --branch-only" : "";
  // 操作の作業ディレクトリ（移動元の作業ツリー）。--carry の移動元と一致させるため、本体ではなくここへ移動してから実行する
  const dir = facts?.cwd ?? main;
  // brw create の 1 件のコマンド
  const cmd = (extra = "") => `cd ${shellQuote(dir)} && node ${shellQuote(BRW_CLI)} create ${shellQuote(name)}${extra}${flags}`;

  if (!facts || !facts.mainRoot) return denied("gate-unresolved", "作業場所を確定できないため、置き換えられません", [cmd()], ["git の状態（本体の作業ツリー）を読めません。git リポジトリの中で実行してください。"]);
  if (unresolved.length > 0) return denied("gate-unresolved", "対象を確定できないため、置き換えられません", [cmd()], [`対象を確定できません: ${unresolved.join(" ")}`]);

  // 単独の git 操作か（先頭の cd を除く）
  const segments = splitWords(command);
  const compound = () => denied("gate-compound", "単独の git 操作として確定できないため、置き換えられません", [cmd()], [`他のコマンドと組み合わせた操作や、展開・記号を含むコマンドは置き換えません。${BRW_RUN} create を単独で実行してください。`]);
  if (segments === null) return compound();
  const lead = hasLeadingCd ? 1 : 0;
  if (segments.length !== lead + 1) return compound();
  if (hasLeadingCd && (segments[0].length !== 2 || segments[0][0] !== "cd")) return compound();
  const words = segments[lead];
  const unsupported = (conclusion, notes) => denied("gate-action-unsupported", conclusion, [cmd()], notes);

  // 既存の開発ブランチの再開（brw resume）への置き換え。保護・分岐元は通常の承認に任せ、開発ブランチ以外は拒否する
  const planResume = () => {
    const resumeCmd = `cd ${shellQuote(dir)} && node ${shellQuote(BRW_CLI)} resume ${shellQuote(branch)}`;
    const cls = branch ? classifyBranch(config, branch) : "undeclared";
    if (!safe(branch)) return denied("gate-name-invalid", "切り替え先のブランチ名を確定できないため、置き換えられません", [cmd()], [`記号や空白を含む名前は置き換えません。再開するブランチを確認して ${BRW_RUN} resume <ブランチ> を実行してください。`]);
    const existing = facts.branchExists(branch);
    if (!existing.local && !existing.origin) return denied("gate-unresolved", `切り替え先 '${branch}' が既存のブランチと確認できないため、置き換えられません`, [cmd()], [`ローカルにもリモート（origin）にも無いブランチです。新しく作るなら ${BRW_RUN} create を実行してください。`]);
    if (cls === "protected" || cls === "base")
      return { verdict: "pass", code: "gate-resume-protected", reason: `'${branch}' は${cls === "protected" ? "保護ブランチ" : "恒常的な分岐元"}への切り替えで、ブランチは増えません。通常のホスト承認に任せます。` };
    if (cls !== "development") return denied("gate-name-invalid", `'${branch}' は宣言の開発ブランチではないため、再開に置き換えられません`, [cmd()], [`${BRW_RUN} resume で再開できるのは、宣言の作業ブランチ（workBranches）に一致するブランチだけです。`, `新しく作るなら、命名規則に合う名前で brw create を実行してください。`]);
    if (facts.mainBranch === branch) return denied("gate-action-unsupported", `ブランチ '${branch}' は本体の作業ツリーで使用中のため、再開に置き換えられません`, [cmd()], ["brw resume は worktree を作るため、本体で使用中のブランチは再開できません。"]);
    // 再開先: 既にそのブランチの worktree があればそこ。無ければ brw resume が作る場所
    const wt = facts.worktreeOf(branch) ?? join(main, ".claude", "worktrees", aliasOf(branch));
    if (op.via === "worktree" && (op.path === undefined || op.path === null || resolve(op.path) !== resolve(wt)))
      return denied("gate-outside-placement", `作業場所（${op.path ?? "不明"}）は BRW の再開先（${wt}）ではないため、置き換えられません`, [resumeCmd], [`${BRW_RUN} resume は本体の .claude/worktrees/ の配下か、そのブランチの既存の worktree を使います。`]);
    const notes = [
      "既存の開発ブランチの再開として brw resume を実行します。リモートに更新があれば取り込みます。",
      `作業場所をブランチの worktree（${wt}）に移しました。続けて、この worktree で作業してください。`,
    ];
    if (facts.trackedChanges > 0 || facts.untrackedChanges > 0) notes.push(`未コミットの変更（追跡済み ${facts.trackedChanges} 件・未追跡 ${facts.untrackedChanges} 件）は元の作業ツリー（${dir}）に残ります。`);
    const conclusion = `ブランチ '${branch}' への切り替えを BRW の再開に置き換えました`;
    const text = guidance({ outcome: "置き換え", conclusion, commands: [resumeCmd], workdir: wt, notes: notes.join("\n") });
    return { verdict: "rewrite", command: `${resumeCmd} && cd ${shellQuote(wt)} && printf '%s\\n' ${shellQuote(text)}`, reason: conclusion, notice: notes, createCommand: resumeCmd, worktree: wt, branchOnly: false };
  };

  // 指定の形（switch -c・checkout -b・branch・worktree add -b の各形だけを扱う）
  if (words[0] !== "git") return unsupported("git の操作ではないため、置き換えられません", ["BRW の作成に置き換えられるのは git の操作だけです。"]);
  const k = words[1] === "-C" ? 3 : 1; // -C の作業ディレクトリは op.cwd に反映済み
  const sub = words[k];
  if (sub === undefined || !Object.hasOwn(VIA_OPTIONS, sub)) return unsupported(`この git の操作（${sub ?? "なし"}）は BRW の作成に置き換えられません`, ["ブランチを作る形（switch -c・checkout -b・branch・worktree add -b）だけを置き換えます。"]);
  const spec = VIA_OPTIONS[sub];
  const operands = [];
  let flagSeen = false;
  let flagValue = null;
  let rest = words.slice(k + 1);
  if (sub === "worktree") {
    // worktree の形は「worktree add ...」だけを扱う（分類と同じ）
    if (rest[0] !== "add") return unsupported("worktree の操作は add だけを置き換えます", ["worktree add の形で作ってください。"]);
    rest = rest.slice(1);
  }
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    if (!w.startsWith("-")) {
      operands.push(w);
      continue;
    }
    if (!spec.allowed.includes(w)) return unsupported(`オプション ${w} は BRW の作成と同じ結果にならないため、置き換えられません`, [`このオプションを外すか、${BRW_RUN} create を使ってください。`]);
    if (w === spec.value) {
      flagSeen = true;
      flagValue = rest[j + 1] ?? null;
      j++;
    }
  }

  // 開始点と、ブランチ名の位置
  let start = null;
  if (sub === "switch" || sub === "checkout") {
    if (!flagSeen) {
      // 既存のブランチへの切り替え（リモートにだけあるブランチの切り替えを含む）は、再開として扱う
      if (operands.length !== 1) return unsupported("切り替え先を確定できません", ["切り替え先のブランチを 1 つだけ書いた形で指定してください。"]);
      return planResume();
    }
    if (operands.length > 1 || flagValue !== branch) return unsupported("ブランチ名または開始点を確定できません", ["ブランチ名と開始点を 1 つずつ書いた形で作ってください。"]);
    start = operands[0] ?? null;
  } else if (sub === "branch") {
    if (operands.length < 1 || operands.length > 2 || operands[0] !== branch) return unsupported("ブランチ名または開始点を確定できません", ["ブランチ名と開始点を 1 つずつ書いた形で作ってください。"]);
    start = operands[1] ?? null;
  } else if (op.action === "resume") {
    // worktree add <配置先> <既存のブランチ> は再開として扱う
    if (operands.length !== 2 || operands[1] !== branch) return unsupported("配置先またはブランチを確定できません", ["配置先と既存のブランチを 1 つずつ書いた形で指定してください。"]);
    return planResume();
  } else if (flagSeen) {
    if (operands.length < 1 || operands.length > 2 || flagValue !== branch) return unsupported("ブランチ名または配置先を確定できません", ["配置先とブランチ名を 1 つずつ書いた形で作ってください。"]);
    start = operands[1] ?? null;
  } else if (operands.length !== 1) {
    return unsupported("配置先を確定できません", [`配置先だけを書いた形は、${BRW_RUN} create で作ってください。`]);
  }
  if ((op.start ?? null) !== start) return unsupported("開始点を確定できません", ["開始点を 1 つに確定できる形で作ってください。"]);

  // 操作の種類（作成と、既存ブランチの再開だけを置き換える）
  if (op.action === "resume") return planResume();
  if (op.action !== "create") return unsupported(`この操作（${op.action}）は BRW の作成に置き換えられません`, [op.action === "rename" || op.action === "copy" ? "ブランチの名前変更・複製は置き換えません。" : "BRW の作成は分岐元からの新規作成だけを扱います。"]);

  // ブランチ名は宣言の開発ブランチとして有効なものだけ（接頭辞は補わない）
  const cls = branch ? classifyBranch(config, branch) : "undeclared";
  if (!safe(branch) || cls !== "development") {
    if (cls === "protected" || cls === "base") return denied("gate-name-invalid", `'${branch}' は${cls === "protected" ? "保護ブランチ" : "恒常的な分岐元"}のため、作業ブランチとして作れません`, [cmd()], ["保護ブランチと分岐元は作業ブランチの名前にできません。"]);
    const why = safe(branch) ? checkName(config, branch) ?? `'${branch}' は workBranches（${config.workBranches.join(", ")}）に一致しません。` : "記号や空白を含む名前は置き換えません。";
    return denied("gate-name-invalid", `ブランチ名 '${branch ?? ""}' は作業ブランチの命名規則に合わないため、置き換えられません`, [cmd()], [why, `接頭辞（dev/ など）は補いません。宣言の作業ブランチと命名規則に合う名前で、${BRW_RUN} create を実行してください。`]);
  }
  const existing = facts.branchExists(branch);
  if (existing.local || existing.origin) return denied("gate-action-unsupported", `ブランチ '${branch}' は既に存在するため、作成ではなく再開です`, [`cd ${shellQuote(main)} && node ${shellQuote(BRW_CLI)} resume ${shellQuote(branch)}`], [`既存のブランチの再開は ${BRW_RUN} resume で行ってください。`]);

  // 配置先（本体の .claude/worktrees/ の配下。brw create が作る場所と一致すること）
  const base = config.baseBranch;
  const wt = join(main, ".claude", "worktrees", aliasOf(branch));
  if (op.via === "worktree" && (op.path === undefined || op.path === null || resolve(op.path) !== resolve(wt)))
    return denied("gate-outside-placement", `作業場所（${op.path ?? "不明"}）は BRW の配置先（${wt}）ではないため、置き換えられません`, [cmd()], [`BRW は本体の .claude/worktrees/ の配下にだけ worktree を作ります。${BRW_RUN} create で作ってください。`]);

  // 開始点は分岐元（baseBranch か origin/baseBranch）に限る。現在のブランチから作る操作は分岐元からの作成と結果が違う
  if (start === null) {
    if (facts.currentBranch !== base) {
      const cur = facts.currentBranch;
      return denied("gate-start-unsupported", `現在のブランチ（${cur ?? "なし"}）から分岐する操作のため、置き換えられません`, [safe(cur) ? cmd(` --base ${shellQuote(cur)}`) : cmd()], [`brw create は分岐元（${base}）から作ります。結果が変わるため、置き換えません。`, safe(cur) ? `分岐元を ${cur} にするなら --base で指定してください。` : `分岐元を指定しない作成は、${BRW_RUN} create の既定（分岐元）だけです。`]);
    }
  } else if (start !== base && start !== `origin/${base}`) {
    const b = start.replace(/^origin\//, "");
    const e = safe(b) ? facts.branchExists(b) : { local: false, origin: false };
    const isBranch = e.local || e.origin;
    return denied("gate-start-unsupported", `開始点 '${start}' は分岐元（${base}）ではないため、置き換えられません`, [isBranch ? cmd(` --base ${shellQuote(b)}`) : cmd()], [isBranch ? `--base で ${b} を指定すると、同じ開始点から作れます。` : "開始点がコミットなどの場合、brw create では指定できません。分岐元から作ってください。"]);
  }

  // 追跡済みの未コミットの変更は、ブランチを切り替える作成だけ移さず拒否する（git branch は作業ツリーに触れないので置き換える）
  if (facts.trackedChanges > 0 && op.branchOnly !== true) {
    return denied("gate-dirty", "追跡済みのファイルに未コミットの変更があるため、置き換えられません", [cmd(), cmd(" --carry")], [
      "1) そのまま作る: 変更は元の作業ツリーに残り、作業場所は新しい worktree に移ります。",
      "2) --carry で移す: 変更を新しい worktree へ移し、元の作業ツリーからは取り除きます。",
      "どちらを選ぶかは、変更が今の作業のものかで決めてください。",
    ]);
  }

  // 置き換え: brw create の実行、作業場所の移動、案内の表示をつないだコマンド
  const branchOnly = op.branchOnly === true;
  const createCommand = cmd();
  const notes = [
    // brw create は fetch 後の最新の origin/<分岐元> から作る。ローカルの分岐元が古くても、この点は元の git switch -c と違うので案内する
    `分岐元は、brw create が選ぶ開始点（取得できた最新の origin/${base} の先端。取得できないときは、手元に残っている origin/${base}、無ければ手元の ${base}）から作ります。`,
    branchOnly ? "ブランチだけを作りました。作業場所は移していません。" : `作業場所を新しい worktree（${wt}）に移しました。続けて、この worktree で作業してください。`,
  ];
  if (facts.untrackedChanges > 0) notes.push(`未追跡のファイル ${facts.untrackedChanges} 件は元の作業ツリー（${facts.cwd}）に残ります。`);
  const startRef = facts.branchExists(base).origin ? `origin/${base}` : base;
  if (!facts.declaredAt(startRef)) notes.push(branchOnly ? "宣言ファイルは分岐元に未登録です。この作業ブランチで commit して登録してください。" : "宣言ファイルは分岐元に未登録のため、brw create は未追跡の宣言ファイルを新しい worktree へ移します。この作業ブランチで commit して登録してください。");
  const conclusion = `ブランチ '${branch}' の作成を BRW の作成に置き換えました`;
  const workdir = branchOnly ? null : wt;
  const text = guidance({ outcome: "置き換え", conclusion, commands: [createCommand], workdir, notes: notes.join("\n") });
  const print = `printf '%s\\n' ${shellQuote(text)}`;
  // branchOnly は作業場所を変えないようサブシェルで実行する（cd が呼び出し側に残らない）。それ以外は worktree へ移動してから案内を表示する
  const replaced = branchOnly ? `( ${createCommand} && ${print} )` : `${createCommand} && cd ${shellQuote(wt)} && ${print}`;
  return { verdict: "rewrite", command: replaced, reason: conclusion, notice: notes, createCommand, worktree: workdir, branchOnly };
}

/**
 * 作成（kind: create の操作）を、置き換えか拒否に決める。副作用なし・git を呼ばない。
 * @param {object} input
 * @param {"claude"|"codex"} input.host 入口のホスト。置き換え（書き換え）は claude だけ
 * @param {string} input.command 元の Bash コマンド
 * @param {object} input.op operation-policy の分類結果（action・via・branch・path・start・branchOnly・cwd）
 * @param {object} input.config 正規化済みの宣言
 * @param {object|null} input.facts gatherFacts の結果（null は確定できない）
 * @param {boolean} [input.hasLeadingCd] 先頭が `cd <dir> &&` か
 * @param {string[]} [input.unresolved] 分類で確定できなかった理由
 * @returns {{verdict: "rewrite", command: string, reason: string, notice: string[]} | {verdict: "deny", code: string, reason: string}}
 */
export function planGate(input) {
  const { host, op, facts } = input;
  if (!op || op.kind !== "create") throw new Error("ゲートの計画には作成の操作（kind: create）が必要です");
  const plan = planCore({ ...input, unresolved: input.unresolved ?? op.unresolved ?? [], facts: facts ?? null, hasLeadingCd: input.hasLeadingCd === true });
  if (plan.verdict !== "rewrite" || host === "claude") return plan;
  // Claude Code 以外は入力を書き換えられない。同じ作成と作業場所の移動を、次のコマンドとして示す拒否にする
  // branchOnly は作業場所を移さないので、案内を実行しても作業ディレクトリが変わらないようサブシェルで囲む（Claude の置き換えと同じ形）
  const cmdText = plan.worktree
    ? `${plan.createCommand} && cd ${shellQuote(plan.worktree)}`
    : plan.branchOnly ? `( ${plan.createCommand} )` : plan.createCommand;
  return denied("gate-host-no-rewrite", `この環境（${host}）では操作を書き換えられないため、置き換えず拒否します`, [cmdText], [
    "この環境では元の操作を BRW の手順に書き換えられません。次のコマンドを実行してください。",
    "次のコマンドは、Claude Code で置き換えた場合と同じ作成と作業場所の移動を行います。",
  ], plan.worktree);
}

// ---- EnterWorktree の判定（judgeEnterWorktree） ---------------------------------

const enterDenied = (code, conclusion, commands, notes, workdir = null) => ({
  verdict: "deny",
  code,
  reason: guidance({ outcome: "拒否", conclusion, commands, workdir, notes: notes.join("\n") }),
});
// 実在するパスは実体へ解決し、無ければ絶対パスへ正規化する
const realOf = (p) => {
  try { return existsSync(p) ? realpathSync(p) : resolve(p); } catch { return resolve(p); }
};

// 作業ディレクトリのリポジトリの状態。git が「リポジトリではない」と答えたときだけ outside。実行の失敗・権限などは unresolved（確定できない）
function repoOf(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  if (r.error) return { state: "unresolved" };
  if (r.status === 0 && r.stdout.trim() !== "") return { state: "inside", root: r.stdout.trim() };
  return /not a git repository/i.test(r.stderr ?? "") ? { state: "outside" } : { state: "unresolved" };
}

/**
 * EnterWorktree の入力を判定する。副作用なし。
 * BRW を導入していないリポジトリ（または git の外）は通過。導入済みでは、`path` が BRW の開発ブランチの worktree
 * （本体の .claude/worktrees/ の配下で、worktree 一覧に載り、宣言の開発ブランチを使用中）のときだけ通過し、それ以外は案内つきで拒否する。
 * 例外が出たときも拒否（安全側）。
 * @param {{name?: unknown, path?: unknown}|null|undefined} input EnterWorktree の tool_input
 * @param {string|null} cwd フックの作業ディレクトリ
 * @returns {{verdict: "pass"} | {verdict: "deny", code: "gate-enter-name"|"gate-enter-path"|"gate-enter-unresolved", reason: string}}
 */
export function judgeEnterWorktree(input, cwd) {
  try {
    if (typeof cwd !== "string" || cwd === "" || !isAbsolute(cwd) || !existsSync(cwd))
      return enterDenied("gate-enter-unresolved", "作業場所を確定できないため、EnterWorktree を止めます", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], ["作業ディレクトリを確定できません。git リポジトリの中で、brw create または brw resume で作業場所を用意してください。"]);
    const repo = repoOf(cwd);
    if (repo.state === "outside") return { verdict: "pass" }; // リポジトリの外
    if (repo.state !== "inside") return enterDenied("gate-enter-unresolved", "git の状態を確認できないため、EnterWorktree を止めます", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], ["git を実行できない、またはリポジトリの状態を読めません。git の状態を確認してから、brw create または brw resume で作業場所を用意してください。"]);
    const root = repo.root;
    const { config, error } = loadConfig(root);
    if (error) return enterDenied("gate-enter-unresolved", "宣言ファイルが不正で規則を確認できないため、EnterWorktree を止めます", [`node ${shellQuote(BRW_CLI)} check`], [error.split("\n")[0], "宣言ファイルを修正してから再実行してください。"]);
    if (!config) return enabledInRepo(root)
      ? enterDenied("gate-enter-unresolved", "BRW の導入設定はありますが宣言ファイルがなく、規則を確認できないため、EnterWorktree を止めます", [`node ${shellQuote(BRW_CLI)} check`], ["宣言ファイルを作成するか、導入設定を復旧してください。"])
      : { verdict: "pass" }; // 未導入のリポジトリ
    const list = worktrees(root);
    const main = list[0]?.path ?? null;
    if (main === null) return enterDenied("gate-enter-unresolved", "本体の作業ツリーを確定できないため、EnterWorktree を止めます", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], ["git の状態を読めません。git リポジトリの中で実行してください。"]);

    // 入力の無い呼び出し（名前なしの作成）は空として扱う。オブジェクト以外は対象を確定できない
    const obj = input === undefined || input === null ? {} : input;
    if (typeof obj !== "object" || Array.isArray(obj))
      return enterDenied("gate-enter-unresolved", "EnterWorktree の入力から対象を確定できないため、止めます", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], ["入力はオブジェクト（name または path）で指定してください。"]);
    const name = obj.name;
    const path = obj.path;
    // 明示された null は指定とみなし、型の検査で拒否する（未指定の undefined だけが「無い」）
    const hasName = name !== undefined;
    const hasPath = path !== undefined;
    const valid = (v) => typeof v === "string" && v.trim() !== "" && !/[\0\r\n]/.test(v);
    if ((hasName && !valid(name)) || (hasPath && !valid(path)))
      return enterDenied("gate-enter-unresolved", "EnterWorktree の入力から対象を確定できないため、止めます", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], ["name と path は空でない文字列で指定してください。BRW の worktree へは、path にそのパスを指定します。"]);
    if (hasName && hasPath)
      return enterDenied("gate-enter-unresolved", "EnterWorktree に name と path の両方が指定されているため、対象を確定できません", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], ["name（新規作成）と path（既存の worktree へ移動）は同時に指定できません。BRW の worktree へ入るには path だけを指定してください。"]);

    if (!hasPath) {
      // 新しい worktree の作成（name 指定、または名前なし）。brw create の後に path 指定で入る 2 手を案内する
      const branch = valid(name) && SAFE_VALUE.test(name) && classifyBranch(config, name) === "development" && checkName(config, name) === null ? name : "<名前>";
      const wt = join(main, ".claude", "worktrees", aliasOf(branch === "<名前>" ? "<名前>" : branch));
      const hint = branch === "<名前>"
        ? [`作業ブランチの名前は、宣言の作業ブランチ（${config.workBranches.join(", ")}）と命名規則${config.namePattern ? `（${config.namePattern}）` : ""}に合う名前にしてください。`, "<名前> は、その名前に置き換えます。"]
        : [];
      return enterDenied("gate-enter-name", "EnterWorktree による worktree の作成は、BRW の命名規則と分岐元を通らないため、止めます", [
        `cd ${shellQuote(root)} && node ${shellQuote(BRW_CLI)} create ${shellQuote(branch)}`,
        `EnterWorktree を path に ${wt} を指定して呼ぶ`,
      ], [
        `1) ${BRW_RUN} create で作業ブランチと worktree を作ります。2) できた worktree のパスを path に指定して EnterWorktree を呼ぶと、作業場所がその worktree に移ります。`,
        ...hint,
      ], branch === "<名前>" ? null : wt);
    }

    // path 指定: BRW の開発ブランチの worktree への切り替えだけを通す
    const target = realOf(isAbsolute(path) ? path : resolve(cwd, path));
    const entry = list.slice(1).find((w) => realOf(w.path) === target);
    // 配置先そのものが本体の外を指す（シンボリックリンク）ときは、配下と認めない
    const placementDir = join(realOf(main), ".claude", "worktrees");
    const placementSound = realOf(join(main, ".claude", "worktrees")) === placementDir;
    const placed = relative(placementDir, target);
    const underPlacement = placementSound && placed !== "" && !placed.startsWith("..") && !isAbsolute(placed);
    if (entry && entry.branch && underPlacement && classifyBranch(config, entry.branch) === "development") return { verdict: "pass" };
    const cause = !entry ? "git の worktree 一覧に載っていません"
      : !underPlacement ? "本体の .claude/worktrees/ の配下にありません"
      : !entry.branch ? "ブランチを使用していません（detached HEAD）"
      : `使用中のブランチ '${entry.branch}' は宣言の開発ブランチではありません`;
    return enterDenied("gate-enter-path", `指定された場所（${sanitize(String(path))}）は BRW の作業ブランチの worktree ではないため、EnterWorktree を止めます`, [
      `cd ${shellQuote(root)} && node ${shellQuote(BRW_CLI)} resume <ブランチ>`,
      "EnterWorktree を path に、brw resume が示した worktree を指定して呼ぶ",
    ], [
      `理由: ${cause}。`,
      `既存の作業ブランチへ入るときは、${BRW_RUN} resume でその worktree を用意してから、path に指定してください。新しく作るときは ${BRW_RUN} create <名前> を使います。`,
    ]);
  } catch {
    return enterDenied("gate-enter-unresolved", "EnterWorktree の判定で内部エラーが起きたため、止めます", [`node ${shellQuote(BRW_CLI)} resume <ブランチ>`], [`判定を完了できませんでした。${BRW_RUN} create または ${BRW_RUN} resume で作業場所を用意してください。`]);
  }
}
