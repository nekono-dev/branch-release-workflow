// 停止の案内（純粋な処理）。
// 入力を止めるときに、フックが UserPromptSubmit の追加の文脈として渡す文章と、標準出力に書く JSON を作る。
// ファイル・環境変数・時刻を読まず、入力（停止の案内の材料）から結果だけを計算する。

/** 止めた入力を載せる最大の文字数（コードポイント単位） */
const PROMPT_LIMIT = 200;

/** 入力の取得に失敗したときに載せる文言 */
const PROMPT_UNAVAILABLE = "（取得できませんでした）";

/** 制御文字（改行・タブを含む）。1 文字ずつ空白 1 つに置き換える */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * 止めた入力を、表示できる形に整える。
 * 先頭 200 文字まで残し、制御文字を空白 1 つに置き換える。null・空（置き換え後も空）は取得できなかった扱い。
 * @param {string | null} prompt
 * @returns {string} 表示用の文字列（取得できなければ「（取得できませんでした）」）
 */
function promptText(prompt) {
  if (prompt === null) return PROMPT_UNAVAILABLE;
  const text = Array.from(prompt).slice(0, PROMPT_LIMIT).join("").replace(CONTROL_PATTERN, " ");
  return text === "" ? PROMPT_UNAVAILABLE : text;
}

/**
 * UserPromptSubmit の追加の文脈に入れる文章を返す。
 * 見出し・止める指示・区切り・止めた入力・止めたこと・理由（次にやること）の順に、改行で区切って並べる。
 * @param {{ prompt: string | null, reason: string }} notice
 *   - prompt: 止めた入力。取得できなければ null
 *   - reason: 止めた理由と次にやること（既存の messageBlock・messageBlocked の文面）。空でない文字列
 * @returns {string}
 * @throws {TypeError} notice が無い・reason が文字列でない・空のとき、prompt が文字列でも null でもないとき
 */
export function messageStopNotice(notice) {
  if (typeof notice !== "object" || notice === null) {
    throw new TypeError("notice はオブジェクトで渡してください");
  }
  const { prompt, reason } = notice;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new TypeError("reason は空でない文字列で渡してください");
  }
  if (prompt !== null && typeof prompt !== "string") {
    throw new TypeError("prompt は文字列か null で渡してください");
  }
  return [
    "【入力の停止】この入力は止められています。ほかの作業はしないでください。",
    "- 次の「停止の案内」を、そのまま利用者に伝えて終えてください。",
    "- ファイルの作成と編集、状態を変えるコマンドの実行、子のエージェントの起動、ブランチの切り替えはしないでください。",
    "- 同じ入力に並んで届く他の案内（手順書を先に読む案内、終了を止めて手順書を読むよう求める案内、作業ブランチへの切り替えの案内）より、この停止を優先してください。",
    "--- 停止の案内 ---",
    `止めた入力: ${promptText(prompt)}`,
    "止めたこと: この入力を止めました。",
    reason.trim(),
  ].join("\n");
}

/**
 * フックが標準出力に書く JSON（オブジェクト）を返す。decision は含めない。
 * @param {{ prompt: string | null, reason: string }} notice - messageStopNotice と同じ
 * @returns {{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: string } }}
 * @throws {TypeError} messageStopNotice と同じ条件
 */
export function stopOutput(notice) {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: messageStopNotice(notice) } };
}
