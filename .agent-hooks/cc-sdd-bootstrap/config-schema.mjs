// 設定ファイルの各項目の道筋・引数の名前・既定値・検証・質問文を 1 か所で定義する（データだけ）。
// 他の lib を import しない。

/**
 * 設定の値。文字列・真偽・対応（キー→文字列）のどれか。
 * @typedef {string | boolean | Record<string, string>} ConfigValue
 */

/**
 * 設定ファイルの 1 項目の定義。
 * @typedef {object} ConfigField
 * @property {string} path 設定ファイルの中の道筋（例 "ccSdd.version"）
 * @property {string} [flag] 引数の名前（例 "cc-sdd-version"）
 * @property {"string" | "boolean" | "map"} kind 値の種類
 * @property {ConfigValue} defaultValue 既定値
 * @property {string} [question] 対話で示す日本語の質問文
 * @property {(value: unknown) => string | null} validate 不正なら日本語の理由、正しければ null
 * @property {string} [notice] 値が true のとき init・update の完了時に示す文（boolean の項目だけが使う）
 * @property {string[]} [mapKeys] kind が map のとき、対話で尋ねるキーの一覧
 */

/** 設定ファイルの形式の版 */
export const CONFIG_FORMAT = 1;

const VERSION_RE = /^\d+\.\d+\.\d+(-.+)?$/;
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
// 基底ブランチの要素に使えない文字（空白・C0 制御文字・DEL・C1 制御文字）
const BASE_BRANCH_BAD_RE = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * 基底ブランチの一覧（カンマ区切り）を検査する。
 * @param {unknown} value - 設定の値
 * @returns {string | null} 不正なら日本語の理由、正しければ null
 */
function baseBranchesProblem(value) {
  if (typeof value !== "string") return "文字列で指定してください";
  const names = value.split(",");
  if (names.some((name) => name === "")) {
    return "カンマ区切りで 1 件以上を指定し、空の要素は使わないでください（例 main,develop）";
  }
  for (const name of names) {
    if (name.startsWith("-")) return "ブランチ名の先頭に「-」は使えません";
    if (BASE_BRANCH_BAD_RE.test(name)) return "ブランチ名に空白や制御文字は使えません";
  }
  return null;
}

/**
 * 導入に使う基本の項目だけを置く（役割表などの項目は lib/config-schema.mjs でつなぐ。subagent-delegation 1.12）。
 * @type {ConfigField[]}
 */
export const configFields = [
  {
    path: "ccSdd.version",
    flag: "cc-sdd-version",
    kind: "string",
    defaultValue: "3.1.0",
    question: "導入する cc-sdd の版を入力してください",
    validate(value) {
      if (typeof value !== "string") return "文字列で指定してください";
      return VERSION_RE.test(value)
        ? null
        : "「数字.数字.数字」の形で指定してください（例 3.1.0。「-」以降は付けてもよい）";
    },
  },
  {
    path: "ccSdd.lang",
    flag: "lang",
    kind: "string",
    defaultValue: "ja",
    question: "cc-sdd の言語を入力してください（例 ja・en・pt-BR）",
    validate(value) {
      if (typeof value !== "string") return "文字列で指定してください";
      return LANG_RE.test(value)
        ? null
        : "「xx」または「xx-YY」の形で指定してください（例 ja・pt-BR）";
    },
  },
  {
    // Codex のフックの承認の記録を書く・子の承認の確認を省くかの切り替え（既定 true）。
    // flag・question は持たない（対話や引数では尋ねない）。
    path: "codex.trustHooks",
    kind: "boolean",
    defaultValue: true,
    validate(value) {
      return typeof value === "boolean" ? null : "true か false で指定してください";
    },
  },
  {
    // 作業前のブランチ確保を有効にするか（既定 true）。flag・question は持たない。
    path: "workflow.branchGate",
    kind: "boolean",
    defaultValue: true,
    validate(value) {
      return typeof value === "boolean" ? null : "true か false で指定してください";
    },
  },
  {
    // 検証後の PR 作成の案内を有効にするか（既定 true）。flag・question は持たない。
    path: "workflow.prAfterValidate",
    kind: "boolean",
    defaultValue: true,
    validate(value) {
      return typeof value === "boolean" ? null : "true か false で指定してください";
    },
  },
  {
    // 基底ブランチの一覧（カンマ区切り。既定 main,master,develop）。flag・question は持たない。
    path: "workflow.baseBranches",
    kind: "string",
    defaultValue: "main,master,develop",
    validate: baseBranchesProblem,
  },
];

/**
 * 設定ファイルの format 値を検査する。配置物と導入コマンドで同じ規則を使う。
 * @param {unknown} format - 検査対象の format 値
 * @returns {string | null} 問題があれば「format: 理由」の文、無ければ null
 */
export function formatProblem(format) {
  if (format === undefined) {
    return "format: 形式の版がありません。cc-sdd-bootstrap の設定ファイルか確認してください";
  }
  if (!Number.isInteger(format) || format < 1) {
    return "format: 1 以上の整数で指定してください";
  }
  if (format > CONFIG_FORMAT) {
    return `format: この設定ファイルは新しい形式（${format}）で書かれています。cc-sdd-bootstrap を新しい版に上げてから実行してください`;
  }
  return null;
}
