// Cloudflare Workers の Previews（wrangler preview）用 provider。
// 詳細は references/cloudflare-previews.md を参照。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deliveryOf, parseJsonc, previewAliasOf, resolveVars, urlHost } from "../lib.mjs";
import { readTemplate, renderSteps, varEnvLines, configFlag, workerOf } from "../deploy/cloudflare-workers.mjs";

export { parseJsonc };

const MIN_WRANGLER = [4, 135, 0];

const gte = (v, min) => {
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  return true;
};

// 有効な独自ドメイン（custom_domain: true で enabled: false でない route）があるか
export function hasActiveCustomDomain(conf) {
  const routes = [...(Array.isArray(conf.routes) ? conf.routes : []), ...(conf.route ? [conf.route] : [])];
  return routes.some((r) => r && typeof r === "object" && r.custom_domain === true && r.enabled !== false);
}

// 配備先を宣言しない構成での workers_dev / preview_urls の期待値。
// workers_dev は独自ドメインが無いときだけ true。preview_urls は workers.dev 配信なら常に true、独自ドメイン配信なら workers_dev と同じ
export const expectedWorkersDev = (active, delivery = "custom-domain") => ({
  workers_dev: !active,
  preview_urls: delivery === "workers-dev" ? true : !active,
});

// 独自ドメインの有効状況と配信方式に応じて workers_dev / preview_urls を設定した設定文章を返す（コメントは保つ）。
// 省略しても deploy の結果は同じだが、毎回 wrangler が警告を出し既定値にも依存するため、明示する
export function applyWorkersDev(text, delivery = "custom-domain") {
  const active = hasActiveCustomDomain(parseJsonc(text));
  const want = expectedWorkersDev(active, delivery);
  let out = text;
  for (const k of ["workers_dev", "preview_urls"]) {
    const value = String(want[k]);
    const re = new RegExp(`^[ \\t]*"${k}"\\s*:\\s*(true|false)`, "gm");
    const m = [...out.matchAll(re)].find((x) => depthAt(out, x.index) === 1); // トップレベルのキーだけ
    if (m) out = out.slice(0, m.index) + m[0].replace(/(true|false)$/, value) + out.slice(m.index + m[0].length);
    else {
      const open = out.indexOf("{"); // 先頭のオブジェクトの直後に足す（末尾カンマは JSONC で許される）
      out = `${out.slice(0, open + 1)}\n  "${k}": ${value},${out.slice(open + 1)}`;
    }
  }
  parseJsonc(out); // 壊れた結果を書かない
  return { active, want, text: out };
}

// 位置 pos の直前までの括弧の深さ（文字列とコメントは数えない）
function depthAt(text, pos) {
  let depth = 0;
  for (let i = 0; i < pos; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < pos && text[i] !== '"') i += text[i] === "\\" ? 2 : 1; }
    else if (c === "/" && text[i + 1] === "/") while (i < pos && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i + 2) + 1;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth;
}

export function check(root, config) {
  const out = config.deploy ? checkTarget(root, config) : checkRootConfig(root, config);
  // wrangler のバージョン
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const spec = { ...pkg.dependencies, ...pkg.devDependencies }.wrangler;
    const m = spec?.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!spec) out.push({ level: "warn", message: "package.json に wrangler がありません（CI で npx wrangler を使う場合は 4.135.0 以上が必要）。" });
    else if (m && !gte(m.slice(1).map(Number), MIN_WRANGLER)) out.push({ level: "error", message: `wrangler ${spec} は古いです。wrangler preview には 4.135.0 以上が必要です。` });
  }
  // workflow に wrangler preview があるか
  const wfDir = join(root, ".github/workflows");
  const wfs = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (!wfs.some((f) => /wrangler\s+preview\b/.test(readFileSync(join(wfDir, f), "utf8"))))
    out.push({ level: "error", message: ".github/workflows に `wrangler preview` を実行する workflow がありません（gen-workflow で雛形を作れます）。" });
  if (wfs.some((f) => /versions\s+upload[^\n]*--preview-alias/.test(readFileSync(join(wfDir, f), "utf8"))))
    out.push({ level: "warn", message: "旧方式（wrangler versions upload --preview-alias）が残っています。Previews へ移行してください。" });
  return out;
}

// 配備先を宣言しない構成: ルートの wrangler 設定を直接検査する
function checkRootConfig(root, config) {
  const out = [];
  const delivery = deliveryOf(config.preview?.urlTemplate);
  const files = readdirSync(root).filter((f) => /^wrangler(\..+)?\.(jsonc|json|toml)$/.test(f));
  const texts = Object.fromEntries(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
  if (!files.length) out.push({ level: "warn", message: "wrangler の設定ファイルが見つかりません（生成物の場合は無視してよい）。" });
  else if (delivery === "custom-domain" && !files.some((f) => /previews_enabled\W+true/.test(texts[f])))
    out.push({ level: "error", message: `${files.join(", ")} に previews_enabled: true が見つかりません。独自ドメインでプレビューを配信できません。` });
  else if (delivery === "workers-dev" && !files.some((f) => /^\s*"?preview_urls"?\s*[:=]\s*true/m.test(texts[f])))
    out.push({ level: "error", message: `${files.join(", ")} に preview_urls: true が見つかりません。workers.dev でプレビューを配信できません（URL が空のまま成功します）。` });
  // 独自ドメインの有効状況と workers_dev / preview_urls の整合
  for (const f of files.filter((f) => /\.jsonc?$/.test(f))) {
    let conf;
    try { conf = parseJsonc(texts[f]); } catch { continue; }
    const active = hasActiveCustomDomain(conf);
    const want = expectedWorkersDev(active, delivery);
    for (const k of ["workers_dev", "preview_urls"])
      if (typeof conf[k] === "boolean" && conf[k] !== want[k])
        out.push({ level: "warn", message: `${f}: 有効な独自ドメインが${active ? "ある" : "ない"}${delivery === "workers-dev" ? "（workers.dev 配信）" : ""}のに ${k}: ${conf[k]} です。\`brw wrangler-config ${f} --write\` で直せます。` });
  }
  return out;
}

// プレビュー URL の雛形が、宣言された配備先の配信方式と一致するか検査する。
function checkTarget(root, config) {
  const out = [];
  const p = config.preview;
  const t = config.deploy.targets[p.target];
  const delivery = deliveryOf(p.urlTemplate);
  const host = urlHost(p.urlTemplate);
  const aliasMax = config.maxNameLength - (p.aliasStripPrefix?.length ?? 0);
  if (delivery === "custom-domain") {
    if (!t.customDomain)
      out.push({ level: "error", message: `プレビュー先 ${p.target} に customDomain がありません。urlTemplate（${p.urlTemplate}）は独自ドメイン配信ですが、配信先が無いとプレビューは URL が空のまま作られます。` });
    else if (host !== `{alias}.${t.customDomain}`)
      out.push({ level: "warn", message: `urlTemplate のホスト名 ${host} が、プレビュー先 ${p.target} の独自ドメインのプレビュー（{alias}.${t.customDomain}）と食い違います。` });
    if (aliasMax > 63) out.push({ level: "warn", message: `プレビュー名が最大 ${aliasMax} 文字になり、DNS のラベルの上限 63 文字を超えます（maxNameLength を見直してください）。` });
  } else {
    const worker = workerOf(config, p.target, readTemplate(root, config).conf);
    if (!worker) return out;
    if (!host.startsWith(`{alias}-${worker}.`))
      out.push({ level: "warn", message: `urlTemplate のホスト名 ${host} が、プレビュー先 ${p.target} の workers.dev のプレビュー（{alias}-${worker}.<サブドメイン>.workers.dev）と食い違います。` });
    if (!worker.includes("${") && aliasMax + 1 + worker.length > 63)
      out.push({ level: "warn", message: `プレビューのホスト名の先頭のラベル（プレビュー名 最大 ${aliasMax} 文字 + "-" + Worker 名 ${worker.length} 文字）が DNS の上限 63 文字を超えます（maxNameLength を見直してください）。` });
  }
  return out;
}

export function workflow(config) {
  const globs = config.workBranches.map((g) => `"${g.endsWith("/*") ? g + "*" : g}"`).join(", ");
  const pattern = config.namePattern ?? "^.+$";
  const dp = config.deploy;
  const env = dp ? varEnvLines(config, "      ") : [];
  return `# 作業ブランチへの push で Cloudflare Workers の Preview を作成・更新する（本番は変えない）。
# このファイルは branch-release-workflow の gen-workflow で生成した雛形。ビルド手順などはリポジトリに合わせて直すこと。
${dp ? `# Preview は配備先 ${config.preview.target} の Worker に作る（宣言の preview.target）。設定はテンプレートから生成する。\n` : ""}# 同じブランチへ再 push しても URL は変わらず、中身だけ最新になる。
name: preview

on:
  push:
    branches: [${globs}]

concurrency:
  group: preview-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  preview:
    runs-on: ubuntu-latest
    timeout-minutes: 20
${env.length ? `    env:\n${env.join("\n")}\n` : ""}    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci

      # ブランチ名から Preview 名を作る（宣言の aliasStripPrefix を除き、"/" を "-" にする）。宣言の namePattern / 文字数に合わなければスキップする
      - name: Resolve preview alias
        id: alias
        env:
          BRANCH_NAME: \${{ github.ref_name }}
        run: |
          if printf '%s' "$BRANCH_NAME" | grep -Eq '${pattern}' && [ "\${#BRANCH_NAME}" -le ${config.maxNameLength} ]; then
            echo "valid=true" >> "$GITHUB_OUTPUT"
            name="\${BRANCH_NAME#${config.preview.aliasStripPrefix ?? ""}}"
            echo "alias=\${name//\\//-}" >> "$GITHUB_OUTPUT"
          else
            echo "valid=false" >> "$GITHUB_OUTPUT"
            echo "::warning::ブランチ名 '$BRANCH_NAME' は命名規則に合わないため、プレビューをスキップします"
          fi

${dp ? renderSteps(config, config.preview.target, "steps.alias.outputs.valid == 'true'") + "\n" : ""}      - name: Run build
        if: steps.alias.outputs.valid == 'true'
        run: npm run build

      - name: Deploy preview
        if: steps.alias.outputs.valid == 'true'
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PREVIEW_ALIAS: \${{ steps.alias.outputs.alias }}
          COMMIT_SHA: \${{ github.sha }}
        run: |
          npx wrangler preview${dp ? configFlag(config) : ""} \\
            --name "$PREVIEW_ALIAS" \\
            --tag "\${COMMIT_SHA::7}" \\
            --message "preview: $PREVIEW_ALIAS @ \${COMMIT_SHA::7}"

      - name: Show preview URL
        if: steps.alias.outputs.valid == 'true'
        env:
          PREVIEW_ALIAS: \${{ steps.alias.outputs.alias }}
        run: |
          echo "- URL: ${config.preview.urlTemplate.replace("{alias}", "${PREVIEW_ALIAS}")}" >> "$GITHUB_STEP_SUMMARY"
`;
}

// 後始末。配備先を宣言したときは削除先の Worker を --worker-name で明示する（設定ファイルが無くても削除できる）。
// Worker 名の変数が解決できなければ { error } を返す
export function cleanup(config, branch, cwd = process.cwd()) {
  const args = ["wrangler", "preview", "delete", "-y"];
  if (config.deploy) {
    const worker = workerOf(config, config.preview.target, readTemplate(cwd, config).conf);
    if (!worker) return { error: `プレビュー先 ${config.preview.target} の Worker 名が分かりません（宣言の worker か、テンプレートの name を書いてください）。` };
    const r = resolveVars(worker, cwd);
    if (r.missing.length) return { error: `変数を解決できません: ${r.missing.join(", ")}（環境変数か GitHub Variables に設定してください）` };
    args.push("--worker-name", r.value);
  }
  return { cmd: "npx", args: [...args, "--name", previewAliasOf(config, branch)] };
}
