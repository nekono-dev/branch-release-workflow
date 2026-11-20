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
 * @property {string} flag 引数の名前（例 "cc-sdd-version"）
 * @property {"string" | "boolean" | "map"} kind 値の種類
 * @property {ConfigValue} defaultValue 既定値
 * @property {string} question 対話で示す日本語の質問文
 * @property {(value: unknown) => string | null} validate 不正なら日本語の理由、正しければ null
 * @property {string} [notice] 値が true のとき init・update の完了時に示す文（boolean の項目だけが使う）
 * @property {string[]} [mapKeys] kind が map のとき、対話で尋ねるキーの一覧
 */

/** 設定ファイルの形式の版 */
export const CONFIG_FORMAT = 1;

const VERSION_RE = /^\d+\.\d+\.\d+(-.+)?$/;
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** @type {ConfigField[]} */
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
    path: "ccSdd.keepTemplates",
    flag: "keep-templates",
    kind: "boolean",
    defaultValue: false,
    question: "cc-sdd の雛形（.kiro/settings/templates/）を上書きせずに保持し、コミットできるようにしますか",
    validate(value) {
      return typeof value === "boolean" ? null : "true か false で指定してください";
    },
    notice: "雛形（`.kiro/settings/templates/`）は cc-sdd の成果物（MIT ライセンス）。コミットする場合はそのライセンスに従う。保持すると cc-sdd の版を上げても雛形は入れ替わらない（入れ替えるには `.kiro/settings/templates/` を消して新しいセッションを開く）",
  },
  {
    path: "codex.enabled",
    flag: "codex",
    kind: "boolean",
    defaultValue: false,
    question: "Codex も使いますか",
    validate(value) {
      return typeof value === "boolean" ? null : "true か false で指定してください";
    },
  },
  {
    path: "models",
    flag: "model",
    kind: "map",
    defaultValue: {},
    question: "役割ごとのモデルを入力してください",
    mapKeys: [],
    validate(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "役割の名前とモデルの対応（オブジェクト）で指定してください";
      }
      for (const [key, v] of Object.entries(value)) {
        if (typeof v !== "string" || v.trim() === "") {
          return `${key} のモデルは空でない文字列で指定してください`;
        }
      }
      return null;
    },
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
