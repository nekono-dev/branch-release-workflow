// 配備先（deploy.provider: cloudflare-workers）。テンプレートからの wrangler 設定の生成・配備用 workflow 雛形・検査。
// 配備先の構成は references/cloudflare-previews.md を参照。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configVarNames, deliveryOf, git, globToRegExp, matchesAny, parseJsonc, resolveVars } from "../lib.mjs";

// テンプレートを読む。戻り値: { conf } か { error }
export function readTemplate(root, config) {
  const path = join(root, config.deploy.template);
  if (!existsSync(path)) return { error: `テンプレート ${config.deploy.template} が見つかりません。` };
  try {
    const conf = parseJsonc(readFileSync(path, "utf8"));
    if (typeof conf !== "object" || conf === null || Array.isArray(conf)) return { error: `テンプレート ${config.deploy.template} のルートがオブジェクトではありません。` };
    return { conf };
  } catch (e) {
    return { error: `テンプレート ${config.deploy.template} を JSONC として読めません: ${e.message}` };
  }
}

// 配備先の Worker 名（宣言の worker、無ければテンプレートの name）。変数は解決しない
export const workerOf = (config, target, template) => config.deploy.targets[target].worker ?? template?.name;

// テンプレートと宣言から、配備先 target の wrangler 設定（オブジェクト）を作る。変数は解決済みの値を渡す。
// 引数 vals: { worker, customDomain }（解決済み）
export function renderConfig(template, config, target, vals) {
  const isPreview = config.preview?.provider === "cloudflare-previews" && config.preview.target === target;
  const delivery = deliveryOf(config.preview?.urlTemplate);
  const out = structuredClone(template);
  if (vals.worker) out.name = vals.worker;
  // 独自ドメインの route は宣言で置き換える。ほかの route（ゾーンの route など）は残す
  const routes = [...(Array.isArray(out.routes) ? out.routes : []), ...(out.route ? [out.route] : [])]
    .filter((r) => !(r && typeof r === "object" && r.custom_domain === true));
  delete out.route;
  if (vals.customDomain)
    routes.push({ pattern: vals.customDomain, custom_domain: true, ...(isPreview && delivery === "custom-domain" ? { previews_enabled: true } : {}) });
  if (routes.length) out.routes = routes;
  else delete out.routes;
  out.workers_dev = !vals.customDomain;
  out.preview_urls = isPreview && delivery === "workers-dev";
  if (isPreview && (typeof out.previews !== "object" || out.previews === null)) out.previews = {};
  return out;
}

// 配備先 target の wrangler 設定を生成する。戻り値: { text, path } か { error }
export function render(root, config, target) {
  const t = config.deploy.targets[target];
  if (!t) return { error: `配備先 '${target}' は宣言に無いです（${Object.keys(config.deploy.targets).join(" / ")}）。` };
  const { conf, error } = readTemplate(root, config);
  if (error) return { error };
  const missing = [];
  const res = (s) => {
    if (s === undefined) return undefined;
    const r = resolveVars(s, root);
    missing.push(...r.missing);
    return r.value;
  };
  const vals = { worker: res(t.worker), customDomain: res(t.customDomain) };
  if (missing.length) return { error: `変数を解決できません: ${[...new Set(missing)].join(", ")}（環境変数か GitHub Variables に設定してください）` };
  const obj = renderConfig(conf, config, target, vals);
  const path = isAbsolute(config.deploy.output) ? config.deploy.output : join(root, config.deploy.output);
  const head = /\.jsonc$/.test(path) ? `// brw render-wrangler が ${config.deploy.template} から生成した設定（配備先: ${target}）。手で編集しない\n` : "";
  return { text: `${head}${JSON.stringify(obj, null, 2)}\n`, path };
}

// 生成先へ書き、renderHook を呼ぶ。戻り値: 終了コード
export function writeAndHook(root, config, target, r) {
  writeFileSync(r.path, r.text);
  console.error(`生成しました: ${r.path}（配備先: ${target}）`);
  if (!config.deploy.renderHook) return 0;
  const h = spawnSync(config.deploy.renderHook, { cwd: root, shell: true, stdio: "inherit", env: { ...process.env, BRW_TARGET: target, BRW_OUTPUT: r.path } });
  if (h.status !== 0) console.error(`renderHook が失敗しました（終了コード ${h.status ?? "不明"}）: ${config.deploy.renderHook}`);
  return h.status ?? 1;
}

// ---- workflow 雛形の共通部分 -----------------------------------------------

const yq = (s) => `'${String(s).replace(/'/g, "''")}'`; // YAML の単一引用符
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // シェルの単一引用符

// 宣言で参照する変数を GitHub Variables から渡す env の行（job の env の中身）
export function varEnvLines(config, indent) {
  return configVarNames(config).map((n) => `${indent}${n}: \${{ vars.${n} }}`);
}

// wrangler に渡す設定ファイルの指定（生成先が既定の名前なら不要）
export const configFlag = (config) => (/^wrangler\.(jsonc|json|toml)$/.test(config.deploy.output) ? "" : ` -c ${sq(config.deploy.output)}`);

// BRW の取得と設定の生成の手順（steps の要素）。cond は if 条件（無ければ空）
export function renderSteps(config, target, cond = "") {
  const { repository, ref } = config.deploy.brwSource;
  const ifLine = cond ? `\n        if: ${cond}` : "";
  return `      # 宣言の deploy.brwSource から branch-release-workflow を取得する（設定の生成に使う）
      - name: Fetch branch-release-workflow${ifLine}
        run: |
          git init -q "$RUNNER_TEMP/brw"
          git -C "$RUNNER_TEMP/brw" fetch -q --depth 1 ${sq(repository)} ${sq(ref)}
          git -C "$RUNNER_TEMP/brw" checkout -q --detach FETCH_HEAD
          echo "BRW_DIR=$RUNNER_TEMP/brw" >> "$GITHUB_ENV"

      # テンプレート（${config.deploy.template}）から配備先の wrangler 設定を生成する${config.deploy.renderHook ? "（続けて renderHook を呼ぶ）" : ""}
      - name: Render wrangler config${ifLine}
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          BRW_TARGET_NAME: ${target}
        run: node "$BRW_DIR/scripts/brw.mjs" render-wrangler --target "$BRW_TARGET_NAME" --write
`;
}

// ---- 配備用 workflow 雛形 ----------------------------------------------------

export function workflow(config) {
  const targets = Object.entries(config.deploy.targets);
  const branches = [...new Set(targets.flatMap(([, t]) => t.branches))].map(yq).join(", ");
  const resolve = targets
    .map(([name, t], i) => `          ${i ? "elif" : "if"} printf '%s' "$BRANCH_NAME" | grep -Eq ${sq(t.branches.map((b) => globToRegExp(b).source.replaceAll("\\/", "/")).join("|"))}; then target=${name}`)
    .join("\n");
  const env = varEnvLines(config, "      ");
  return `# 配備先のブランチへの push で、Cloudflare Workers へ配備する（branch-release-workflow の gen-workflow deploy で生成した雛形）。
# 配備先とブランチの対応は .branch-release-workflow.json の deploy.targets が正本。テスト・マイグレーション・シークレットの登録などは、リポジトリに合わせて加えること。
${targets.map(([name, t]) => `# - ${name}: ${t.branches.join(", ")} → Worker ${t.worker ?? "(テンプレートの name)"}${t.customDomain ? `（${t.customDomain}）` : "（workers.dev）"}`).join("\n")}
name: deploy

on:
  push:
    branches: [${branches}]

permissions:
  contents: read

jobs:
  # push されたブランチから配備先を決める。どの配備先にも当たらなければ配備しない
  resolve:
    runs-on: ubuntu-latest
    outputs:
      target: \${{ steps.target.outputs.name }}
    steps:
      - name: Resolve target
        id: target
        env:
          BRANCH_NAME: \${{ github.ref_name }}
        run: |
          target=""
${resolve}
          fi
          echo "name=$target" >> "$GITHUB_OUTPUT"
          echo "配備先: \${target:-(なし)}"

  deploy:
    needs: resolve
    if: needs.resolve.outputs.target != ''
    runs-on: ubuntu-latest
    timeout-minutes: 20
    # 同じ配備先への配備は直列にし、実行中の配備は中断しない
    concurrency:
      group: deploy-\${{ needs.resolve.outputs.target }}
      cancel-in-progress: false
${env.length ? `    env:\n${env.join("\n")}\n` : ""}    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci

${renderSteps(config, "${{ needs.resolve.outputs.target }}")}
      - name: Run build
        run: npm run build

      - name: Deploy worker
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: npx wrangler deploy${configFlag(config)}
`;
}

// ---- 検査 ----------------------------------------------------------------

export function check(root, config) {
  const out = [];
  const { error } = readTemplate(root, config);
  if (error) out.push({ level: "error", message: error });
  const prot = config.protectedBranches ?? [];
  for (const [name, t] of Object.entries(config.deploy.targets))
    for (const b of t.branches)
      if (!prot.includes(b) && !matchesAny(prot, b.replace(/\*+/g, "x")))
        out.push({ level: "warn", message: `deploy.targets.${name}: ブランチ '${b}' が protectedBranches に含まれません（作業ブランチから直接配備される可能性）。` });
  if (git(root, "ls-files", "--error-unmatch", config.deploy.output) !== null)
    out.push({ level: "warn", message: `生成先 ${config.deploy.output} が git に登録されています。生成物なので登録から外し、.gitignore に加えてください。` });
  const wfDir = join(root, ".github/workflows");
  const wfs = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (!wfs.some((f) => /wrangler\s+deploy\b/.test(readFileSync(join(wfDir, f), "utf8"))))
    out.push({ level: "warn", message: ".github/workflows に `wrangler deploy` を実行する workflow がありません（`brw gen-workflow deploy` で雛形を作れます）。" });
  return out;
}
