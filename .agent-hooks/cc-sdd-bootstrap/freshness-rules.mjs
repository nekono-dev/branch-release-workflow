// 導入の版と指紋の記録（純粋な処理）。
// ファイル・git・環境変数を読まず、入力から結果だけを計算する。
// 導入コマンド（lib/）はこのファイルを読み込んでよいが、配置物どうしは互いを読み込まない。
import { createHash } from "node:crypto";

/** 記録ファイルの場所（導入先のリポジトリのルートからの相対パス） */
export const RECORD_PATH = ".agent-hooks/cc-sdd-bootstrap/install-record.json";

/** 配布元のリポジトリ */
export const DISTRIBUTION_REPO = "https://github.com/nekono-dev/cc-sdd-bootstrap";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * 内容の指紋（SHA-256 の 16 進）を返す。
 * @param {Buffer | string} content
 * @returns {string}
 */
export function fingerprint(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 記録の JSON 文字列を作る。同じ入力からは必ず同じ文字列になる。
 * キーは昇順、インデント 2、末尾は改行 1 つ。
 * @param {{ source: { commit: string | null, ref: string | null }, files: Record<string, Buffer | string> }} input
 * @returns {string}
 */
export function buildRecord({ source, files }) {
  // JSON.stringify は整数形式のキーを数値順に並べ替え、`__proto__` を落とすため、files は手で書き出す（キーは文字列の昇順）
  const entries = Object.keys(files).sort().map((path) => `    ${JSON.stringify(path)}: ${JSON.stringify(fingerprint(files[path]))}`);
  const filesText = entries.length === 0 ? "{}" : `{\n${entries.join(",\n")}\n  }`;
  const sourceText = JSON.stringify({ commit: source.commit, ref: source.ref }, null, 2).replace(/\n/g, "\n  ");
  return `{\n  "files": ${filesText},\n  "format": 1,\n  "source": ${sourceText}\n}\n`;
}

/**
 * 記録の文字列を分類する。
 * - null（ファイルが無い）→ missing
 * - 壊れた JSON・format が 1 でない・files の値が 64 桁の 16 進でない・source の形が違う → broken
 * - 正常 → ok（記録の本体を返す）
 * @param {string | null} text
 * @returns {{ state: "missing" } | { state: "broken" } | { state: "ok", record: object }}
 */
export function parseRecord(text) {
  if (text === null) {
    return { state: "missing" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "broken" };
  }
  if (!isPlainObject(value) || value.format !== 1) {
    return { state: "broken" };
  }
  if (!isPlainObject(value.files)) {
    return { state: "broken" };
  }
  for (const hash of Object.values(value.files)) {
    if (typeof hash !== "string" || !HEX64.test(hash)) {
      return { state: "broken" };
    }
  }
  const source = value.source;
  if (!isPlainObject(source)) {
    return { state: "broken" };
  }
  if (!(source.commit === null || (typeof source.commit === "string" && HEX40.test(source.commit)))) {
    return { state: "broken" };
  }
  if (!(source.ref === null || typeof source.ref === "string")) {
    return { state: "broken" };
  }
  return { state: "ok", record: value };
}

/**
 * 記録のファイルと、実際のファイルの指紋を照合する。
 * actual は相対パス → 指紋（無ければ null）。記録に無い actual のファイルは判定しない。
 * @param {{ files: Record<string, string> }} record
 * @param {Record<string, string | null>} actual
 * @returns {{ missing: string[], changed: string[] }} どちらもパスのキー昇順
 */
export function inspectFiles(record, actual) {
  const missing = [];
  const changed = [];
  for (const path of Object.keys(record.files).sort()) {
    const current = actual[path];
    if (current === undefined || current === null) {
      missing.push(path);
    } else if (current !== record.files[path]) {
      changed.push(path);
    }
  }
  return { missing, changed };
}

/**
 * ref が 40 桁の 16 進（固定のコミット）か。
 * @param {string | null} ref
 * @returns {boolean}
 */
export function isPinnedRef(ref) {
  return typeof ref === "string" && HEX40.test(ref);
}

/**
 * ls-remote に渡す引数の配列を作る（リポジトリ URL は含めない）。
 * - ref がブランチ・タグ → refs/heads/<ref>、refs/tags/<ref>、refs/tags/<ref>^{}
 * - ref が無い・空 → HEAD
 * - 固定のコミット → null（比較しない）
 * @param {{ commit: string | null, ref: string | null }} source
 * @returns {string[] | null}
 */
export function remoteQuery(source) {
  const ref = source.ref;
  if (isPinnedRef(ref)) {
    return null;
  }
  if (!ref) {
    return ["HEAD"];
  }
  return [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
}

/**
 * git ls-remote の出力（`<40 桁>\t<refname>` の行）から、比べる 40 桁のコミットを選ぶ。
 * - ref が無い・空 → HEAD の行
 * - ブランチ → refs/heads/<ref>
 * - タグ → refs/tags/<ref>^{}（注釈つきタグの指す先）があればそれ、無ければ refs/tags/<ref>
 * - ブランチとタグが両方ある・同じ refname が複数・不正な行がある・空・見つからない → null
 * 戻り値は 40 桁の 16 進だけ。
 * @param {string} stdout
 * @param {string | null} ref
 * @returns {string | null}
 */
export function pickRemoteCommit(stdout, ref) {
  // 固定のコミットは問い合わせないため、ここでも選ばない
  if (isPinnedRef(ref)) {
    return null;
  }
  const lines = stdout.split("\n");
  // 末尾の改行で生じる空の要素だけを許す
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }

  // 期待する refname の集合。これ以外の行が 1 行でもあれば曖昧・不正として扱う
  const expected = ref
    ? new Set([`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`])
    : new Set(["HEAD"]);

  // refname → コミット。同じ refname が 2 回出たら曖昧として扱う
  const refs = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
    if (match === null) {
      return null;
    }
    if (!expected.has(match[2]) || refs.has(match[2])) {
      return null;
    }
    refs.set(match[2], match[1]);
  }

  if (!ref) {
    return refs.get("HEAD") ?? null;
  }

  const branch = refs.get(`refs/heads/${ref}`);
  const tag = refs.get(`refs/tags/${ref}`);
  const peeled = refs.get(`refs/tags/${ref}^{}`);
  if (branch !== undefined) {
    // ブランチとタグが同名で両方ある場合は曖昧
    if (tag !== undefined || peeled !== undefined) {
      return null;
    }
    return branch;
  }
  if (peeled !== undefined) {
    // 注釈つきタグは、タグ本体と ^{} の組でだけ許す
    return tag !== undefined ? peeled : null;
  }
  return tag ?? null;
}

/**
 * 記録の版と配布元の最新を比べる。
 * - 記録の版が無い・最新が無い・取得時の指定が固定のコミット → unknown（比較しない）
 * - 同じ → same、違う → behind
 * @param {{ source: { commit: string | null, ref: string | null } }} record
 * @param {string | null} latest
 * @returns {"same" | "behind" | "unknown"}
 */
export function compareLatest(record, latest) {
  const { commit, ref } = record.source;
  if (commit === null || latest === null || isPinnedRef(ref)) {
    return "unknown";
  }
  return commit === latest ? "same" : "behind";
}

/** 配布元の既定の更新コマンド（指定なし） */
const BASE_UPDATE_COMMAND = "npx -y github:nekono-dev/cc-sdd-bootstrap";

/**
 * 更新コマンドを作る。ref がブランチ・タグなら #<ref> を付け、無い・固定のコミットなら付けない。
 * @param {{ commit: string | null, ref: string | null }} source
 * @returns {string}
 */
export function updateCommand(source) {
  const ref = source.ref;
  if (!ref || isPinnedRef(ref)) {
    return `${BASE_UPDATE_COMMAND} update`;
  }
  return `${BASE_UPDATE_COMMAND}#${ref} update`;
}

/**
 * 案内が必要かを判断し、必要なら案内の内容を返す。不要なら null。
 * - 記録が無い → kind "missing"／壊れている → kind "broken"
 * - ok のとき、欠け・内容の違いがある、または最新との差（behind）があれば kind "drift"
 * - 最新が unknown なだけなら案内しない。版が取り出せなかった（commit: null）は、ほかの案内があるときだけ versionUnknown を立てる
 * @param {{ parsed: { state: string, record?: object }, inspection: { missing: string[], changed: string[] } | null, latest: "same" | "behind" | "unknown" }} input
 * @returns {{ kind: "missing" | "broken" | "drift", missing: string[], changed: string[], behind: boolean, versionUnknown: boolean, source: { commit: string | null, ref: string | null } } | null}
 */
export function decideNotice({ parsed, inspection, latest }) {
  if (parsed.state === "missing") {
    return { kind: "missing", missing: [], changed: [], behind: false, versionUnknown: false, source: { commit: null, ref: null } };
  }
  if (parsed.state === "broken") {
    return { kind: "broken", missing: [], changed: [], behind: false, versionUnknown: false, source: { commit: null, ref: null } };
  }
  const record = parsed.record;
  const missing = inspection?.missing ?? [];
  const changed = inspection?.changed ?? [];
  const behind = latest === "behind";
  if (missing.length === 0 && changed.length === 0 && !behind) {
    return null;
  }
  return {
    kind: "drift",
    missing,
    changed,
    behind,
    versionUnknown: record.source.commit === null,
    source: record.source,
  };
}

/** 案内の詳細に並べるファイル名の上限（欠けと内容の違いを合わせた件数） */
const LIST_LIMIT = 5;

/**
 * 欠けと内容の違いのファイル名を、合計 LIST_LIMIT 件までの詳細行にする。
 * 欠けを先、内容の違いを後に並べ、超えた分は最後に出す行へ「ほか N 件」と付ける。
 * @param {string[]} missing
 * @param {string[]} changed
 * @returns {string[]}
 */
function detailLines(missing, changed) {
  const shownMissing = missing.slice(0, LIST_LIMIT);
  const shownChanged = changed.slice(0, LIST_LIMIT - shownMissing.length);
  const rest = missing.length + changed.length - shownMissing.length - shownChanged.length;
  const tail = rest > 0 ? ` ほか ${rest} 件` : "";
  const lines = [];
  if (shownMissing.length > 0) {
    lines.push(`欠けているファイル: ${shownMissing.join("、")}${shownChanged.length === 0 ? tail : ""}`);
  }
  if (shownChanged.length > 0) {
    lines.push(
      `内容が記録と違うファイル: ${shownChanged.join("、")}${tail}（編集したと断定するものではなく、更新が途中で止まったか版が混ざっている可能性があります）`,
    );
  }
  return lines;
}

/**
 * 案内の文面を作る。利用者向けの案内文（systemMessage）と、エージェントへの指示つきの文脈（additionalContext）を返す。
 * 内容の違いは編集と断定せず、途中で止まった・版が混ざった可能性として書く。
 * @param {ReturnType<typeof decideNotice>} notice
 * @returns {{ systemMessage: string, additionalContext: string }}
 */
export function messageNotice(notice) {
  const command = updateCommand(notice.source);
  const versionNote = notice.versionUnknown ? "配布元の版を取り出せなかったため、最新との比較はできていません。" : "";

  // 1 文の案内（エージェントはこの文をそのまま出力する）
  let head;
  const details = [];
  if (notice.kind === "missing") {
    head = `cc-sdd-bootstrap の導入の記録が無いため、最新かどうかを確かめられません（検知の仕組みが入る前の古い導入の可能性があり、初回は手で更新が必要）。更新コマンド: ${command}`;
  } else if (notice.kind === "broken") {
    head = `cc-sdd-bootstrap の導入の記録が壊れているため、最新かどうかを確かめられません（検知の仕組みが入る前の古い導入の可能性があり、初回は手で更新が必要）。更新コマンド: ${command}`;
  } else {
    const reasons = [];
    if (notice.behind) {
      reasons.push("配布元に新しい版がある");
    }
    if (notice.missing.length > 0) {
      reasons.push("導入ファイルに欠けがある");
    }
    if (notice.changed.length > 0) {
      reasons.push("記録と内容が違うファイルがある");
    }
    head = `cc-sdd-bootstrap の導入に更新の余地があります（${reasons.join("、")}）。更新コマンド: ${command}`;
    details.push(...detailLines(notice.missing, notice.changed));
  }

  // 引用する文面と systemMessage を同じ文字列にし、版不明の 1 文も含める
  const systemMessage = versionNote ? `${head} ${versionNote}` : head;
  const lines = [`利用者の質問への回答より前に、次の 1 文をそのまま最初に出力してください:「${systemMessage}」`, ...details];
  return { systemMessage, additionalContext: lines.join("\n") };
}

/** 値が普通のオブジェクト（配列・null でない）か */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
