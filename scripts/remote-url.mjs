// リモートの URL から GitHub の所有者・リポジトリ名を読む唯一の入口（brw-enforcement 1.6〜1.8）。
// SSH の別名ホスト（~/.ssh/config の Host）は、`ssh -G` で `github.com` に解決できたときだけ GitHub を指すものとして読む。
// `ssh -G` は接続せず設定の記述だけで答えるため、GitHub などへの通信はない。
import { spawnSync } from "node:child_process";

const GITHUB = "github.com";
const NAME_PART = /^[A-Za-z0-9_.-]{1,100}$/;
// 別名として解決を試みてよいホストの形（先頭は英数字。`-` 始まりや記号は ssh のオプション・%h 展開への注入になるため拒否）
const ALIAS_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const ALIAS_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_TIMEOUT_MS = 3000;

// https の URL（認証情報なし）
const HTTPS = /^https:\/\/github\.com\/([^/@\s]+)\/([^/@\s]+?)(?:\.git)?\/?$/;
// scp 形式（user@host:owner/repo）と ssh:// 形式（ssh://user@host[:port]/owner/repo）。ホストは後で検査する
const SCP = /^([^@/\s:]+)@([^:/\s@]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const SSH_URL = /^ssh:\/\/([^@/\s:]+)@([^:/\s@]+)(?::(\d{1,5}))?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

const cache = new Map();

/** 別名の解決結果の記憶を捨てる（テスト用） */
export function resetAliasCache() {
  cache.clear();
}

/** ssh -G で別名のホスト名を調べる。調べられなければ null。同じプロセスでは結果（失敗も）を覚える。 */
function resolveHostname(host, user, port) {
  const key = `${user ?? ""}@${host}:${port ?? ""}`;
  if (cache.has(key)) return cache.get(key);
  let out = null;
  if (ALIAS_HOST.test(host) && (user === undefined || ALIAS_USER.test(user)) && (port === undefined || /^\d{1,5}$/.test(String(port)))) {
    const args = ["-G", ...(user ? ["-l", user] : []), ...(port ? ["-p", String(port)] : []), "--", host];
    const r = spawnSync("ssh", args, { encoding: "utf8", timeout: SSH_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], shell: false });
    if (!r.error && r.status === 0) {
      const line = String(r.stdout).split("\n").find((l) => /^hostname\s/i.test(l));
      if (line) out = line.split(/\s+/)[1]?.toLowerCase() ?? null;
    }
  }
  cache.set(key, out);
  return out;
}

/**
 * scp・ssh 形式のホストを正規化する。`github.com` ならそのまま、別名が `github.com` に解決できれば "github.com"、
 * それ以外は入力のまま返す。
 */
export function canonicalSshHost(host, user, port) {
  const h = String(host).toLowerCase();
  if (h === GITHUB) return GITHUB;
  return resolveHostname(host, user, port) === GITHUB ? GITHUB : host;
}

/** URL から { owner, name } を読む。読めなければ null（宛先不明）。認証情報付きの URL・解決できない別名は null。 */
export function githubRepoOf(url) {
  if (typeof url !== "string") return null;
  const s = url.trim();
  let m = HTTPS.exec(s);
  if (m) return NAME_PART.test(m[1]) && NAME_PART.test(m[2]) ? { owner: m[1], name: m[2] } : null;
  let user, host, port, owner, name;
  if ((m = SCP.exec(s))) [, user, host, owner, name] = m;
  else if ((m = SSH_URL.exec(s))) [, user, host, port, owner, name] = m;
  else return null;
  if (!NAME_PART.test(owner) || !NAME_PART.test(name)) return null;
  // 従来どおり、github.com は git ユーザーだけを読む。別名は解決できたときだけ読む
  if (host.toLowerCase() === GITHUB) return user === "git" ? { owner, name } : null;
  return canonicalSshHost(host, user, port) === GITHUB ? { owner, name } : null;
}

/** URL が scp・ssh 形式で、ホストが `github.com` ではない別名の形なら、そのホスト名。そうでなければ null。 */
export function aliasHostOf(url) {
  if (typeof url !== "string") return null;
  const m = SCP.exec(url.trim()) ?? SSH_URL.exec(url.trim());
  if (!m || m[2].toLowerCase() === GITHUB) return null;
  return ALIAS_HOST.test(m[2]) ? m[2] : null;
}

/**
 * 送り先を確定できない理由の文言。URL は出さない（秘密値を含みうる）。別名ホストが原因ならホスト名だけを示して対処を添える。
 * @param {string} remote リモート名
 * @param {string|null} url
 */
export function unknownDestinationText(remote, url) {
  const alias = aliasHostOf(url);
  if (alias) return `push 先のリモート（${remote}）のホスト ${alias} は SSH の別名で、github.com に解決できませんでした。GitHub を指す https の remote を足すか、~/.ssh/config の HostName を確認してください。`;
  return `push 先のリモート（${remote}）を GitHub のリポジトリとして確定できません。`;
}
