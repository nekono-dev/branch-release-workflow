// BRW の CLI を実際に実行できる形（`node '<brw.mjs の絶対パス>'`）で返す。
// プラグインとして導入された環境には `brw` が PATH に無いため、案内の文面はこの形で書く。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 値を 1 つのシェルの単語にする（単一引用符で囲み、中の単一引用符は '\'' にする） */
function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** brw.mjs の絶対パス（このファイルと同じ scripts/ にある） */
export const BRW_CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "brw.mjs");

/** 案内の文面に埋め込む、`brw` の実行形。`${BRW_RUN} create <名前>` のように使う */
export const BRW_RUN = `node ${quote(BRW_CLI_PATH)}`;
