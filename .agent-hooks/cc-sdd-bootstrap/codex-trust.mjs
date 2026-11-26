// 入出力: Codex の承認の記録（hooks.json の自分のフックの承認）を config.toml へ書く・外す。
// 計算は ./codex-trust-rules.mjs に任せ、ここでは設定の読み取り・場所の決定・一時ファイル経由の置き換えだけを行う。
// lib/ は import しない（配置物の規約）。Node.js の標準モジュールだけを使う。
// 例外は投げない。失敗は status "failed" と日本語の理由で返す。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { computeTrustEntries, planTrustEdit } from "./codex-trust-rules.mjs";

/** 導入の設定ファイル（リポジトリ直下） */
const SETTING_FILE = ".cc-sdd-bootstrap.json";
/** Codex の設定ファイル名 */
const CONFIG_FILE = "config.toml";
/** 既存の設定ファイルが無いときに使う権限 */
const DEFAULT_FILE_MODE = 0o600;
/** シンボリックリンクをたどる上限（循環の防止） */
const MAX_SYMLINK_HOPS = 40;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 想定した失敗。理由（日本語）をそのまま結果の reason に載せる */
class TrustFailure extends Error {}

/** エラーのコード（例 EACCES）。無いときは「不明」 */
const codeOf = (error) => (typeof error?.code === "string" ? error.code : "不明");

/**
 * リポジトリの設定ファイルから codex.trustHooks を読む。
 * false のときだけ false を返す。ファイルが無い・読めない・JSON として不正・項目が無い・true は true（既定）。例外は投げない。
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function readTrustSetting(repoRoot) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(repoRoot, SETTING_FILE), "utf8"));
    if (!isObject(doc) || !Object.hasOwn(doc, "codex")) return true;
    const codex = doc.codex;
    if (!isObject(codex) || !Object.hasOwn(codex, "trustHooks")) return true;
    // false 以外（文字列の "false" を含む）は true の扱い
    return codex.trustHooks !== false;
  } catch {
    return true;
  }
}

/** 実体の道筋を求める。取れなければ与えられた道筋を絶対パスにしたものを使う */
function realPathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * git の共通のディレクトリ（本体の .git）から本体の checkout の実体の道筋を求める。
 * git が無い・git のリポジトリではない・終了コードが 0 でない・末尾が .git でない（ベアなど）ときは null。
 * @param {string} real 実体の道筋
 * @returns {string | null}
 */
function mainCheckoutOf(real) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: real,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  const commonDir = String(result.stdout ?? "").trim();
  if (path.basename(commonDir) !== ".git") return null;
  return realPathOr(path.dirname(commonDir));
}

/**
 * 自分のフックの承認の記録を、キーの道筋を除いて並べ替えた一覧（worktree と本体の比較用）。
 * 読めない・書式が不正・自分のフックが 0 件のときは null（比べられない＝違うとみなす）。
 * @param {string} hooksJsonPath
 * @returns {string[] | null}
 */
function ownSignature(hooksJsonPath) {
  let text;
  try {
    text = fs.readFileSync(hooksJsonPath, "utf8");
  } catch {
    return null;
  }
  const computed = computeTrustEntries(text, hooksJsonPath);
  if (!computed.ok || computed.entries.length === 0) return null;
  const prefix = `${hooksJsonPath}:`;
  return computed.entries
    .map((entry) => `${entry.key.startsWith(prefix) ? entry.key.slice(prefix.length) : entry.key} ${entry.hash}`)
    .sort();
}

/** worktree の hooks.json が本体と違うときの案内（resolveHooksTarget の notes） */
function mismatchNote(mainRoot) {
  return `本体の checkout（${mainRoot}）の .codex/hooks.json が、この worktree のものと違う（または無い）ため、Codex が読むフックと承認の記録が合わない可能性があります。本体の checkout でも同じ導入（update）を実行してください。`;
}

/**
 * 承認の記録を書く先（本体の hooks.json）を決める。
 * repoRoot が worktree なら本体の checkout の .codex/hooks.json（Codex が読む側）を返す。
 * 本体を特定できないとき（git が無い・非 git・ベア）は repoRoot の実体の道筋を使う。
 * worktree のとき、本体の hooks.json が無い・自分のフックの一覧が worktree 側と違うなら notes に案内を入れる。
 * @param {string} repoRoot
 * @returns {{ hooksJsonPath: string, notes: string[], isWorktree: boolean, mainRoot: string }}
 */
export function resolveHooksTarget(repoRoot) {
  const real = realPathOr(repoRoot);
  const mainRoot = mainCheckoutOf(real) ?? real;
  const isWorktree = mainRoot !== real;
  const hooksJsonPath = path.join(mainRoot, ".codex", "hooks.json");
  const notes = [];
  if (isWorktree) {
    const local = ownSignature(path.join(real, ".codex", "hooks.json"));
    const main = ownSignature(hooksJsonPath);
    if (main === null || local === null || JSON.stringify(main) !== JSON.stringify(local)) {
      notes.push(mismatchNote(mainRoot));
    }
  }
  return { hooksJsonPath, notes, isWorktree, mainRoot };
}

/**
 * 設定の置き場所を決める。CODEX_HOME が空でなければそれを、無ければ home/.codex を使う。
 * @returns {{ dir: string, configPath: string }}
 */
function configLocation(env, home) {
  const fromEnv = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME : "";
  const dir = fromEnv !== "" ? fromEnv : path.join(home, ".codex");
  return { dir, configPath: path.join(dir, CONFIG_FILE) };
}

/** 設定ディレクトリが存在するか。無ければ false（作らない） */
function codexDirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * シンボリックリンクをたどって、書く先の実体の道筋を求める（リンク自体は置き換えない）。
 * 実体が無い（壊れたリンク）ときは、そのリンク先の道筋を返す。
 */
function followLinks(p) {
  let current = p;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return current;
      throw error;
    }
    if (!stat.isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  throw Object.assign(new Error("シンボリックリンクが多すぎます"), { code: "ELOOP" });
}

/** 設定ファイルの本文を読む。無いときは null */
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** 既存のファイルの権限（無ければ 0o600） */
function permissionOf(p) {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return DEFAULT_FILE_MODE;
  }
}

/** 一時ファイルを消す（無くても例外にしない） */
function removeQuietly(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 消せなくても結果は変えない
  }
}

/**
 * 同じディレクトリの一時ファイルへ新しい本文を書き、置き換え直前に本文を読み直す。
 * 置き換え直前に、リンク（linkPath）の実体を求め直し、最初に決めた target と違えば置き換えず failed にする
 * （書く先が途中で別の実体へ移ったときに、以前の実体を書き換えないため）。
 * 読み直した本文が base と同じなら一時ファイルで置き換えて { changed: false } を返す。
 * 違えば一時ファイルを消して { changed: true, latest } を返す（置き換えない）。
 * beforeCommit は試験用の差し込み口（一時ファイルを書いた後・読み直しの直前に呼ぶ）。
 */
function replaceFile(target, linkPath, newText, base, beforeCommit) {
  const perm = permissionOf(target);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let pending = true;
  try {
    try {
      fs.writeFileSync(tmp, newText, { flag: "wx", mode: perm });
      fs.chmodSync(tmp, perm);
    } catch (error) {
      throw new TrustFailure(`設定ファイルを書けません（${codeOf(error)}）: ${error.message}`);
    }
    try {
      beforeCommit?.();
      // 書く先の実体を、置き換えの直前に求め直す（最初に決めた実体と同じでなければ書かない）
      if (followLinks(linkPath) !== target) {
        throw new TrustFailure("設定ファイルのリンク先が途中で変わりました。もう一度実行してください");
      }
      const latest = readText(target) ?? "";
      if (latest !== base) return { changed: true, latest };
      fs.renameSync(tmp, target);
      pending = false;
      return { changed: false, latest };
    } catch (error) {
      if (error instanceof TrustFailure) throw error;
      throw new TrustFailure(`設定ファイルを書けません（${codeOf(error)}）: ${error.message}`);
    }
  } finally {
    if (pending) removeQuietly(tmp);
  }
}

/** 承認を省く指定の名前（Codex の exec に付ける引数） */
const BYPASS_FLAG = "--dangerously-bypass-hook-trust";
/** 指定の受理を確かめる codex の呼び出しの上限（ミリ秒） */
const BYPASS_CHECK_TIMEOUT_MS = 15000;

/**
 * 承認を省く指定（--dangerously-bypass-hook-trust）を、この codex が受け付けるかを確かめる。
 * `codex exec --help` の終了コードが 0 で、標準出力に指定の名前が含まれるときだけ true。
 * codex を起動できない・終了コードが 0 でない・指定が出ない・タイムアウトは false。例外は投げない。
 * 標準入力は使わない（Codex の制限付きサンドボックスでは標準入力のパイプを閉じる処理が失敗するため。delegate.mjs の fetchCatalog と同じ作法）。
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean}
 */
export function bypassFlagSupported({ env } = {}) {
  try {
    const result = spawnSync("codex", ["exec", "--help"], {
      env: env ?? process.env,
      encoding: "utf8",
      timeout: BYPASS_CHECK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return false;
    return String(result.stdout ?? "").includes(BYPASS_FLAG);
  } catch {
    return false;
  }
}

/**
 * 承認の記録を書く（mode "write"）・外す（mode "remove"）。例外は投げない。
 * 設定が false のときは何も読み書きせず disabled を返す。
 * @param {{ repoRoot: string, mode: "write" | "remove", env?: NodeJS.ProcessEnv, home?: string, beforeCommit?: () => void }} options
 * @returns {{ status: string, configPath: string | null, counts: object | null, reason: string | null, notes: string[] }}
 */
export function applyCodexTrust(options = {}) {
  const notes = [];
  let configPath = null;
  const done = (status, extra = {}) => ({
    status,
    configPath,
    counts: extra.counts ?? null,
    reason: extra.reason ?? null,
    notes: [...notes],
  });

  try {
    const { repoRoot, mode, env = process.env, home = os.homedir(), beforeCommit } = options;
    if (mode !== "write" && mode !== "remove") {
      return done("failed", { reason: `未対応の操作です: ${String(mode)}` });
    }
    if (!readTrustSetting(repoRoot)) {
      return done("disabled", { reason: "設定 codex.trustHooks が false のため変更していません" });
    }

    // 本体の checkout の特定。worktree からの取り除きは、設定ファイルも hooks.json も読み書きせず見送る
    const target = resolveHooksTarget(repoRoot);
    notes.push(...target.notes);
    if (mode === "remove" && target.isWorktree) {
      return done("skipped", {
        reason: `worktree の中では承認の記録を取り除きません。Codex が読む本体の checkout の承認を消してしまうため、本体の checkout（${target.mainRoot}）で uninstall を実行したときに取り除きます`,
      });
    }

    // 設定の場所。ディレクトリが無ければ作らず、未導入または一度も起動されていないとして返す
    const location = configLocation(env, home);
    configPath = location.configPath;
    if (!codexDirExists(location.dir)) {
      return done("skipped", {
        reason: `Codex の設定ディレクトリ（${location.dir}）がありません。Codex が未導入、または一度も起動されていません`,
      });
    }
    const configFile = followLinks(location.configPath);
    configPath = configFile;
    const original = readText(configFile);
    if (mode === "remove" && original === null) {
      return done("skipped", { reason: "取り除く記録がありません" });
    }

    // 本体の hooks.json から自分のフックの記録を求める
    const { hooksJsonPath } = target;
    let hooksText;
    try {
      hooksText = fs.readFileSync(hooksJsonPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return done("skipped", { reason: ".codex/hooks.json がありません" });
      }
      return done("failed", { reason: `.codex/hooks.json を読めません（${codeOf(error)}）` });
    }
    const computed = computeTrustEntries(hooksText, hooksJsonPath);
    if (!computed.ok) return done("failed", { reason: computed.reason });
    notes.push(...computed.skipped);
    if (computed.entries.length === 0) {
      return done("skipped", { reason: "自分のフックの登録が見つかりません" });
    }

    // 計算と書き込み。置き換え直前に本文が変わっていたら 1 回だけ計算し直す
    let base = original ?? "";
    let plan = planTrustEdit(base, computed.entries, mode);
    for (let attempt = 1; ; attempt += 1) {
      if (!plan.ok) return done("failed", { reason: plan.reason });
      if (plan.text === base) {
        if (mode === "write") return done("unchanged", { counts: plan.counts });
        return done("skipped", { counts: plan.counts, reason: "取り除く記録がありません" });
      }
      const outcome = replaceFile(configFile, location.configPath, plan.text, base, beforeCommit);
      if (!outcome.changed) {
        if (mode === "write") return done("written", { counts: plan.counts });
        return done(plan.counts.removed > 0 ? "removed" : "skipped", {
          counts: plan.counts,
          reason: plan.counts.removed > 0 ? null : "取り除く記録がありません",
        });
      }
      if (attempt >= 2) {
        return done("failed", { reason: "設定ファイルが同時に更新されています。もう一度実行してください" });
      }
      base = outcome.latest;
      plan = planTrustEdit(base, computed.entries, mode);
    }
  } catch (error) {
    if (error instanceof TrustFailure) return done("failed", { reason: error.message });
    return done("failed", {
      reason: `設定ファイルを扱う途中で想定外のエラーが起きました（${codeOf(error)}）: ${error?.message ?? String(error)}`,
    });
  }
}
