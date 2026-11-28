// brw-pr-handoff 10.3: 本文置き場 `<本体>/.worktree/.brw/` への記入から PR 作成・片付けまでの実機の記録を判定する純粋な関数。
// 実機・ネットワークを使わない。body-placement-e2e.mjs が使い、tests/body-placement-judge.mjs が壊した記録で NG になることを確かめる。
// 判定は項目ごとに ok（真偽）と detail（理由）を返し、全項目が ok のときだけ全体を成功とする。

// 本文に残る「未記入」の印（scripts/pr-template.mjs の UNFILLED_MARK と同じ文字列。実装を読み込まずに判定する）
export const UNFILLED = "<!-- brw:unfilled";

/**
 * claude -p の stream-json から、ツールの呼び出し（名前・入力・結果・エラーの有無）を順に取り出す。
 * 結果が無い呼び出しは result が null・isError が null のまま残す（未観測）。解析できない行は数えて返す。
 */
export function toolCallsOf(text) {
  const calls = [];
  const byId = new Map();
  let unparsed = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { unparsed++; continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use") {
        const c = { id: b.id ?? null, name: String(b.name ?? ""), input: b.input ?? {}, result: null, isError: null };
        calls.push(c);
        if (c.id !== null) byId.set(c.id, c);
      }
      if (b?.type === "tool_result" && byId.has(b.tool_use_id)) {
        const c = byId.get(b.tool_use_id);
        c.result = typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x?.text ?? "").join("\n") : JSON.stringify(b.content ?? "");
        c.isError = b.is_error === true;
      }
    }
  }
  return { calls, unparsed };
}

const cmdOf = (c) => String(c?.input?.command ?? "");
const isBash = (c) => c?.name === "Bash";
const isWrite = (c) => c?.name === "Write" || c?.name === "Edit";

/**
 * シェルのコマンド文字列を、区切り（`&&` `||` `;` `|` `&`・改行）で分けた「単純なコマンド」の列にする。
 * 各単純なコマンドは語（引用符を外した値）の配列。単一引用・二重引用（\" \\ \$ \` の逃がし）・\ の逃がしに対応する。
 * 解析できない（閉じていない引用符）ときは null。`(` や `$(` などの入れ子は解析しない（語の一部として扱う）。
 */
export function shellSegments(cmd) {
  const s = String(cmd ?? "");
  const segs = [];
  let cur = [];
  let word = null;
  const push = () => { if (word !== null) { cur.push(word); word = null; } };
  const endSeg = () => { push(); if (cur.length) segs.push(cur); cur = []; };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      word = (word ?? "") + s.slice(i + 1, j);
      i = j + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let w = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { w += s[j + 1]; j += 2; } else { w += s[j]; j += 1; }
      }
      if (j >= s.length) return null;
      word = (word ?? "") + w;
      i = j + 1;
    } else if (ch === "\\" && i + 1 < s.length) {
      word = (word ?? "") + s[i + 1];
      i += 2;
    } else if (ch === "\n" || ch === ";") {
      endSeg();
      i += 1;
    } else if (ch === "&" && s[i + 1] === "&") {
      endSeg();
      i += 2;
    } else if (ch === "|") {
      endSeg();
      i += s[i + 1] === "|" ? 2 : 1;
    } else if (ch === "&") {
      endSeg();
      i += 1;
    } else if (/\s/.test(ch)) {
      push();
      i += 1;
    } else {
      word = (word ?? "") + ch;
      i += 1;
    }
  }
  endSeg();
  return segs;
}

/** 単純なコマンドが brw を呼ぶ形なら、brw の後ろの引数を返す（`brw …`・`/path/brw.mjs …`・`node /path/brw.mjs …`）。そうでなければ null */
export function brwArgsOf(words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  if (words[0] === "brw") return words.slice(1);
  if (/(^|\/)brw\.mjs$/.test(words[0])) return words.slice(1);
  if (words[0] === "node" && /(^|\/)brw\.mjs$/.test(words[1] ?? "")) return words.slice(2);
  return null;
}

/** 本文の指定から、brw pr の --body-file の値を取り出す（引用符は外した値）。brw pr の呼び出しでなければ・指定が無ければ null */
export function prBodyFileOf(command) {
  const segs = shellSegments(command);
  if (!segs) return null;
  for (const seg of segs) {
    const a = brwArgsOf(seg);
    if (!a || a[0] !== "pr") continue;
    const i = a.indexOf("--body-file");
    if (i >= 0 && i + 1 < a.length) return a[i + 1];
  }
  return null;
}

/**
 * brw pr-template を、作業場所への cd のあとで実行しているか。
 * 「cd <作業場所>」は単純なコマンドの語の並びとして現れ、その後ろの単純なコマンドが brw pr-template であること。
 * `echo <作業場所>; brw pr-template` のように、作業場所が引数として別のコマンドに出るだけでは成り立たない。
 */
export function prTemplateAfterCd(command, worktree) {
  const segs = shellSegments(command);
  if (!segs) return false;
  const cdAt = segs.findIndex((s) => s[0] === "cd" && s[1] === worktree);
  if (cdAt < 0) return false;
  return segs.some((s, k) => k > cdAt && (brwArgsOf(s) ?? [])[0] === "pr-template");
}

/**
 * 本文の内容と、偽 GitHub が受けた PR 本文の照合。Write した本文の「見出し・未記入の印・HTML コメント」以外の行が、
 * すべて PR 本文に含まれること。書いた文章がそのまま PR に入ったことを確かめ、無関係な本文は通さない。
 * 照合できる行が 1 つも無いときは偽（何も確かめていない）。
 */
export function bodyMatches(writtenContent, postBody) {
  const lines = String(writtenContent ?? "").split("\n").map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("<!--") && !l.includes(UNFILLED));
  if (lines.length === 0) return false;
  const post = String(postBody ?? "");
  return lines.every((l) => post.includes(l));
}
// 呼び出しの結果が成功で、結果の文字列が取れているか
const okResult = (c) => c?.result !== null && c?.result !== undefined && c.isError === false;

/**
 * 記入から PR 作成・片付けまでの判定（10.3 の (1)〜(3)）。
 * @param {object} p
 * @param {Array} p.calls toolCallsOf の calls
 * @param {string} p.bodyPath 期待する本文の絶対パス（<本体の実体>/.worktree/.brw/<別名>.md）
 * @param {string} p.worktree 期待する作業場所（<本体の実体>/.worktree/dev-body）
 * @param {string} p.legacyDir 旧い本文置き場（<本体>/.claude/worktrees/.brw）。ここへの書き込みは失敗
 * @param {Array<{applied:boolean, body:string}>} p.posts 偽の gh が受けた PR 作成（POST）の要求
 * @param {boolean} p.bodyExistsAfter 実行後に本文ファイルが残っているか
 * @param {boolean} p.worktreeExistsAfter 実行後に作業場所が残っているか
 */
export function judgeBodyFlow({ calls, bodyPath, worktree, legacyDir, posts, bodyExistsAfter, worktreeExistsAfter }) {
  const items = [];
  const add = (id, ok, detail) => items.push({ id, ok: ok === true, detail });

  // (0) 本体で開始し、Bash の cd で作業場所へ移って pr-template を実行した（作業場所の指定を含む）
  const tIdx = calls.findIndex((c) => isBash(c) && prTemplateAfterCd(cmdOf(c), worktree));
  add("0", tIdx >= 0, tIdx >= 0 ? "cd で作業場所へ移ったあとに brw pr-template を実行した" : "cd <作業場所> のあとに brw pr-template を実行する呼び出しが無い");

  // (1) pr-template の出力が、本文置き場の絶対パスを示し、そのあとに Write で同じパスへ書いた
  const tOk = tIdx >= 0 && okResult(calls[tIdx]) && calls[tIdx].result.includes(bodyPath);
  add("1a", tOk, tOk ? "pr-template の出力が本文置き場の本文のパスを示した" : `pr-template の出力に期待するパス（${bodyPath}）が無い、または失敗した`);
  const wIdx = calls.findIndex((c, i) => i > tIdx && tIdx >= 0 && isWrite(c) && c.input?.file_path === bodyPath);
  const wOk = wIdx >= 0 && okResult(calls[wIdx]);
  add("1b", wOk, wOk ? "期待するパスへ Write で本文を書いた（成功）" : wIdx >= 0 ? "本文の Write が失敗した" : "期待するパスへの Write が pr-template の後に無い");
  const legacyWrite = calls.some((c) => isWrite(c) && typeof c.input?.file_path === "string" && (c.input.file_path === legacyDir || c.input.file_path.startsWith(legacyDir + "/")));
  add("1c", !legacyWrite, legacyWrite ? "旧置き場へ書き込んだ" : "旧置き場へ書き込んでいない");

  // (2) brw pr --body-file <本文のパス> が作成に成功した（出力が「PR を作成しました」）
  // 本文のパスは --body-file の引数として存在することを見る（`echo <パス>; brw pr` のように別のコマンドの引数では数えない）
  const pIdx = calls.findIndex((c, i) => i > wIdx && wIdx >= 0 && isBash(c) && prBodyFileOf(cmdOf(c)) === bodyPath);
  // 片付けで作業場所が消えた直後の Bash は、ツールの表示が「Exit code 1」（isError が真）になることがある（作業場所が消えたため。
  // 実機の観測）。そのため成否は brw pr の出力の文言（PR を作成しました）で見る。isError は detail に残す（隠さない）
  const pOut = pIdx >= 0 && calls[pIdx].result !== null && /PR を作成しました/.test(calls[pIdx].result);
  const pErr = pIdx >= 0 ? calls[pIdx].isError : null;
  add("2a", pOut, pOut
    ? `brw pr（本文のパスを指定）が PR を作成した（Bash の表示: ${pErr === true ? "Exit code 1（片付けで作業場所が消えたため・出力は成功）" : "成功"}）`
    : pIdx >= 0 ? `brw pr が成功の出力を返さなかった（isError=${pErr}・出力の先頭=${JSON.stringify(String(calls[pIdx].result ?? "").slice(0, 300))}）` : "本文のパスを指定した brw pr の呼び出しが無い");

  // (2b) 偽の GitHub が受けた PR 作成は 1 件で、本文は記入済み（未記入の印なし・見出しと本文がある）
  const applied = (posts ?? []).filter((p) => p.applied);
  const body = applied.length === 1 ? String(applied[0].body ?? "") : "";
  const bodyOk = applied.length === 1 && body.length > 0 && !body.includes(UNFILLED) && /^## /m.test(body);
  add("2b", bodyOk, bodyOk ? "PR は 1 件作られ、本文は記入済み（未記入の印なし・見出しあり）" : `PR 作成の要求が ${applied.length} 件（期待 1 件）・本文の検査に失敗`);

  // (2c) Write した本文の内容が、偽 GitHub が受けた PR 本文に入っている（無関係な本文は通さない）
  const written = calls.filter((c, i) => isWrite(c) && c.input?.file_path === bodyPath && okResult(c)).pop();
  const contentOk = applied.length === 1 && written !== undefined && bodyMatches(written.input?.content, body);
  add("2c", contentOk, contentOk ? "Write した本文の内容が PR 本文に入っている" : written === undefined ? "成功した Write の内容が無い" : "Write した本文の行が PR 本文に含まれない（無関係な本文の疑い）");

  // (3) 片付けで本文ファイルが消えた（作業場所も消えた）
  add("3a", !bodyExistsAfter, bodyExistsAfter ? "片付けのあとも本文ファイルが残っている" : "片付けで本文ファイルが消えた");
  add("3b", !worktreeExistsAfter, worktreeExistsAfter ? "作業場所が残っている（片付けが完了していない）" : "作業場所が片付いた");

  return { ok: items.every((i) => i.ok), items };
}

/**
 * 旧置き場の本文を --body-file に渡したときの拒否（10.3 の (4)）。実際の brw.mjs の CLI の結果を判定する。
 * @param {object} p
 * @param {number|null} p.exit 終了コード
 * @param {string} p.output 標準出力と標準エラーを連結した文字列
 * @param {string} p.legacyPath 旧置き場の本文のパス
 * @param {string} p.legacyDir 旧置き場のディレクトリ
 * @param {string} p.newPath 本文置き場の新しいパス（移すとしたら置く先）
 * @param {boolean} p.legacyExistsAfter 実行後に旧置き場の本文が残っているか（自動で移していないこと）
 * @param {boolean} p.newExistsAfter 実行後に新しいパスに何かあるか（無いこと）
 * @param {number} p.postsDelta この実行で増えた PR 作成の要求の数（0 であること）
 */
export function judgeLegacyRefusal({ exit, output, legacyPath, legacyDir, newPath, legacyExistsAfter, newExistsAfter, postsDelta }) {
  const items = [];
  const add = (id, ok, detail) => items.push({ id, ok: ok === true, detail });
  const out = String(output ?? "");
  add("4a", exit !== null && exit !== undefined && exit !== 0, exit === 0 ? "旧置き場の本文が受け付けられた（終了コード 0）" : `終了コード ${exit}`);
  add("4b", out.includes("旧置き場") && out.includes(legacyDir), out.includes("旧置き場") && out.includes(legacyDir) ? "旧置き場であることを示した" : "旧置き場の案内が無い");
  add("4c", /(^|\n)mv /.test(out) && out.includes(legacyPath) && out.includes(newPath), /(^|\n)mv /.test(out) && out.includes(legacyPath) && out.includes(newPath) ? "移し方（mv）を案内した" : "mv による移し方の案内が無い");
  add("4d", legacyExistsAfter === true && newExistsAfter === false, legacyExistsAfter === true && newExistsAfter === false ? "自動で移していない" : "旧置き場の本文が消えた、または新しい場所に現れた");
  add("4e", postsDelta === 0, postsDelta === 0 ? "PR を作っていない" : `PR 作成の要求が ${postsDelta} 件増えた`);
  return { ok: items.every((i) => i.ok), items };
}
