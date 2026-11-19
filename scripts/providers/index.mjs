// プレビュー provider の共通部分。provider は宣言の preview.provider で切り替わる。
//
// provider の規約（各ファイルが export する）:
//   check(root, config)            -> { level: "error"|"warn", message }[]   宣言と設定の整合検査
//   workflow(config)               -> string | null                           preview 用 workflow の雛形
//   cleanup(config, branch)        -> { cmd, args } | null                    ブランチ削除時の後始末コマンド
import { aliasOf, previewAliasOf, resolveVars } from "../lib.mjs";
import * as none from "./none.mjs";
import * as urlTemplate from "./url-template.mjs";
import * as cloudflarePreviews from "./cloudflare-previews.mjs";

const providers = { none, "url-template": urlTemplate, "cloudflare-previews": cloudflarePreviews };

export const getProvider = (config) => providers[config.preview.provider];

export { aliasOf, previewAliasOf };

// プレビューURLと未解決の変数名。provider が none の場合は url が null
export function previewUrlInfo(config, branch, cwd = process.cwd()) {
  if (config.preview.provider === "none") return { url: null, missing: [] };
  const { value, missing } = resolveVars(config.preview.urlTemplate, cwd);
  return { url: value.replaceAll("{alias}", previewAliasOf(config, branch)).replaceAll("{branch}", branch), missing };
}

// プレビューURL。provider が none の場合は null。未解決の変数は ${NAME} のまま残る
export const previewUrl = (config, branch, cwd) => previewUrlInfo(config, branch, cwd).url;
