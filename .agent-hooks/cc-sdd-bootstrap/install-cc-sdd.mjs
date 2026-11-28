#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_FILE, UPDATE_COMMAND, FAILURE_RECORD, STATE_PATH, LOCK_PATH, INSTALL_DEADLINE_MS, STALE_LOCK_MS, SECTION_BEGIN_MARKER,
  RETRY_COMMAND, inspectSection, replaceSection, validateSectionText, messageSectionRewritten,
  readInstallConfig, parseState, buildState, decideInstall,
  removalTargets, buildManifest, npxArgs, messageInstalled, messageSkipped, messageReadSkillDirectly, messageBlocked, messageUsage
} from './install-rules.mjs';
import { stopOutput } from './stop-notice-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absolute = (rel, repoRoot = root) => path.join(repoRoot, rel);
const writeOutput = (text) => fs.writeSync(1, text);
// 入力を止めるとき: `decision: 'block'` ではなく、停止の案内と止める指示を追加の文脈で渡し、モデルに応答の文章を作らせる。
// prompt は止めた入力（解析できなかったときは null）、reason は止めた理由と次にやること。
const writeStop = (prompt, reason) => writeOutput(`${JSON.stringify(stopOutput({ prompt, reason }))}\n`);
const writeRecord = (rel, text) => {
  fs.mkdirSync(path.dirname(absolute(rel)), { recursive: true });
  fs.writeFileSync(absolute(rel), text, 'utf8');
};
const SECTION_FILES = { claude: '.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md', codex: '.agent-hooks/cc-sdd-bootstrap/agent-section-codex.md' };
const SECTION_DOCS = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };

/** 文書の区画の有無と、配置物の区画の文章との違い。文書を読めなければ区画なし、配置物を読めなければ違いなし（比べられない） */
function readSectionState(tool, repoRoot) {
  let docText;
  try { docText = fs.readFileSync(absolute(SECTION_DOCS[tool], repoRoot), 'utf8'); }
  catch { return { present: false, stale: false }; }
  let sectionText = null;
  try { sectionText = fs.readFileSync(absolute(SECTION_FILES[tool], repoRoot), 'utf8'); } catch { /* 比べられない */ }
  return sectionText === null ? { present: docText.split(/\r?\n/).includes(SECTION_BEGIN_MARKER), stale: false } : inspectSection(docText, sectionText);
}

/** 導入判断に使う材料を一度に読み取る */
export function readInstallFacts(repoRoot = root) {
  let configText = null;
  try { configText = fs.readFileSync(absolute(CONFIG_FILE, repoRoot), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`${CONFIG_FILE} を読み取れません: ${error.message} ${CONFIG_FILE} を直すか、${UPDATE_COMMAND} で設定を新しくしてください。`);
    }
  }
  const config = readInstallConfig(configText);
  let stateText = null;
  try { stateText = fs.readFileSync(absolute(STATE_PATH, repoRoot), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') stateText = ''; }
  const state = parseState(stateText);
  let lock = { present: false };
  try { lock = { present: true, ageMs: Math.max(0, Date.now() - fs.statSync(absolute(LOCK_PATH, repoRoot)).mtimeMs) }; }
  catch (error) { if (error.code !== 'ENOENT') lock = { present: true, ageMs: 0 }; }
  let failure = { present: false };
  try { failure = { present: true, text: fs.readFileSync(absolute(FAILURE_RECORD, repoRoot), 'utf8') }; }
  catch (error) { if (error.code !== 'ENOENT') failure = { present: true, text: null }; }
  const missingFiles = state ? state.files.filter((rel) => !fs.existsSync(absolute(rel, repoRoot))) : [];
  const sectionPresent = { claude: false, codex: false };
  const sectionStale = { claude: false, codex: false };
  for (const tool of ['claude', 'codex']) {
    const states = readSectionState(tool, repoRoot);
    sectionPresent[tool] = states.present;
    sectionStale[tool] = states.stale;
  }
  return { config, state, lock, failure, missingFiles, sectionPresent, sectionStale };
}
/** 消す道筋の各区間にシンボリックリンクがあれば、削除前に失敗させる */
function rejectLinkedPath(rel) {
  let current = '';
  for (const part of rel.split('/')) {
    current = current ? `${current}/${part}` : part;
    try {
      if (fs.lstatSync(absolute(current)).isSymbolicLink()) throw new Error(`${current} がシンボリックリンクです。`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
}

function removeTarget(rel) {
  const full = absolute(rel);
  let stat;
  try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(full, { recursive: true, force: false });
  else fs.unlinkSync(full);
}

/** 導入物の道筋の一覧を返す（中身は持たない） */
function collectFiles() {
  const files = [];
  const collect = (rel, includeAll = false) => {
    let entries;
    try { entries = fs.readdirSync(absolute(rel), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) collect(child, includeAll);
      else if (entry.isFile() && (includeAll || child.endsWith('/SKILL.md') || child === 'CLAUDE.md' || child === 'AGENTS.md')) files.push(child);
    }
  };
  for (const dir of ['.claude/skills', '.agents/skills']) {
    let skillEntries = [];
    try { skillEntries = fs.readdirSync(absolute(dir), { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of skillEntries) {
      if (entry.name.startsWith('kiro-') && entry.isDirectory()) collect(`${dir}/${entry.name}`, true);
    }
  }
  collect('.kiro/settings', true);
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    try { if (fs.statSync(absolute(doc)).isFile()) files.push(doc); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}

const recordedInstallErrors = new WeakSet();

function appendSection(tool, doc) {
  const sectionPath = SECTION_FILES[tool];
  let section;
  try {
    section = fs.readFileSync(absolute(sectionPath), 'utf8');
  } catch (error) {
    throw new Error(`${sectionPath} を読み取れません: ${error.message}`);
  }
  if (section.trim().length === 0) throw new Error(`${sectionPath} に運用の区画がありません。`);
  const full = absolute(doc);
  let contents;
  try { contents = fs.readFileSync(full, 'utf8'); }
  catch (error) { throw new Error(`${doc} を読み取れません: ${error.message}`); }
  const separator = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
  try { fs.writeFileSync(full, `${contents}${separator}${section}`, 'utf8'); }
  catch (error) { throw new Error(`${doc} に運用の区画を書けません: ${error.message}`); }
}

class BusyInstallError extends Error {}
/** 区画の書き直しの失敗。導入の失敗の記録は残さない（残すと次に cc-sdd 本体が入れ直されるため） */
class SectionRewriteError extends Error {}

/** 導入中の印を排他的に取得する。取れなければ BusyInstallError */
function acquireLock() {
  fs.mkdirSync(absolute(path.dirname(LOCK_PATH)), { recursive: true });
  let lockFd;
  try {
    lockFd = fs.openSync(absolute(LOCK_PATH), 'wx');
    fs.writeFileSync(lockFd, `${new Date().toISOString()}\n${RETRY_COMMAND}\n`, 'utf8');
  } catch (error) {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (error.code === 'EEXIST') throw new BusyInstallError('別の導入が進行中です。');
    if (lockFd !== undefined) fs.rmSync(absolute(LOCK_PATH), { force: true });
    throw error;
  }
  fs.closeSync(lockFd);
}

/**
 * 古い区画だけを書き直す。導入中の印を取得し、取得後に状態を読み直して、まだ書き直しが要るときだけ書く。
 * 文書ごとに一時のファイルへ書いてから置き換えるので、途中で失敗しても元の文書が残る。cc-sdd 本体と導入の記録には触れない。
 * @returns {{ rewritten: boolean, message?: string }}
 */
function performSectionRewrite({ writeResult = true } = {}) {
  try { acquireLock(); }
  catch (error) {
    if (error instanceof BusyInstallError) throw error;
    throw new SectionRewriteError(`導入中の印を作れません: ${error.message}`);
  }
  try {
    const facts = readInstallFacts();
    const decision = decideInstall({ ...facts, lock: { present: false } });
    // 再判定が書き直し以外なら書き直さず、呼び出し元の入口の扱いに回す
    if (decision.action !== 'rewrite-section') return { rewritten: false, decision, facts };
    for (const tool of decision.tools) {
      const doc = SECTION_DOCS[tool];
      const full = absolute(doc);
      const tmp = `${full}.${process.pid}.tmp`;
      try {
        const sectionText = fs.readFileSync(absolute(SECTION_FILES[tool]), 'utf8');
        const problem = validateSectionText(sectionText);
        if (problem !== null) throw new Error(`${SECTION_FILES[tool]}: ${problem}`);
        const next = replaceSection(fs.readFileSync(full, 'utf8'), sectionText);
        if (next === null) throw new Error(`${doc} に運用の区画が見つかりません。`);
        const mode = fs.statSync(full).mode & 0o777;
        fs.writeFileSync(tmp, next, { encoding: 'utf8', mode });
        fs.renameSync(tmp, full);
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* 後片付けの失敗は書き直しの失敗の理由を優先する */ }
        throw new SectionRewriteError(`${doc} の運用の区画を書き直せません: ${error.message}`);
      }
    }
    const message = messageSectionRewritten(decision.tools);
    if (writeResult) writeOutput(`${message}\n`);
    return { rewritten: true, message };
  } catch (error) {
    throw error instanceof SectionRewriteError ? error : new SectionRewriteError(`区画の書き直しで失敗しました: ${error.message}`);
  } finally {
    try { fs.rmSync(absolute(LOCK_PATH), { force: true }); } catch { /* 印を消せない場合は次の入力で古い印として扱われる */ }
  }
}

function performInstall(config, { writeResult = true } = {}) {
  acquireLock();
  const manifestPaths = [];
  try {
    writeRecord(FAILURE_RECORD, 'cc-sdd の導入中です。');
    const entries = { claude: [], codex: [] };
    for (const [tool, dir] of [['claude', '.claude/skills'], ['codex', '.agents/skills']]) {
      rejectLinkedPath(dir);
      try { entries[tool] = fs.readdirSync(absolute(dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const targets = removalTargets(entries);
    for (const target of targets) rejectLinkedPath(target);
    for (const target of targets) removeTarget(target);

    const rawTimeout = process.env.CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS;
    const override = /^\d+$/.test(rawTimeout ?? '') && Number(rawTimeout) > 0 ? Number(rawTimeout) : INSTALL_DEADLINE_MS;
    const deadline = Date.now() + Math.min(INSTALL_DEADLINE_MS, override);
    for (const tool of ['claude', 'codex']) {
      const cache = absolute('.cache');
      fs.mkdirSync(cache, { recursive: true });
      const manifestPath = absolute(`.cache/cc-sdd-install.manifest.${process.pid}.${tool}.json`);
      manifestPaths.push(manifestPath);
      fs.writeFileSync(manifestPath, JSON.stringify(buildManifest(tool)), 'utf8');
      const timeout = Math.max(1, deadline - Date.now());
      const result = spawnSync('npx', npxArgs(config, tool, manifestPath), { cwd: root, stdio: ['ignore', 2, 2], timeout });
      if (result.error?.code === 'ETIMEDOUT') throw new Error(`導入全体の期限（${Math.ceil(Math.min(INSTALL_DEADLINE_MS, override) / 1000)}秒）を過ぎました。通信を確かめてから再試行してください`);
      if (result.error) throw new Error(`npx を起動できませんでした: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`npx（${tool}）の終了コードが ${result.status ?? result.signal} でした。通信・版（${config.version}）・言語（${config.lang}）を確かめてください`);
    }

    appendSection('claude', 'CLAUDE.md');
    appendSection('codex', 'AGENTS.md');
    const state = buildState(config, collectFiles());
    const stateTmp = absolute(`${STATE_PATH}.${process.pid}.tmp`);
    fs.writeFileSync(stateTmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(stateTmp, absolute(STATE_PATH));
    fs.rmSync(absolute(FAILURE_RECORD), { force: true });
    const installedMessage = messageInstalled(config);
    if (writeResult) writeOutput(`${installedMessage}\n`);
    return installedMessage;
  } catch (error) {
    try { writeRecord(FAILURE_RECORD, error.message); }
    catch (recordError) { process.stderr.write(`失敗の記録を書けませんでした: ${recordError.message}\n`); }
    const failure = error instanceof Error ? error : new Error(String(error));
    recordedInstallErrors.add(failure);
    throw failure;
  } finally {
    for (const manifestPath of manifestPaths) fs.rmSync(manifestPath, { force: true });
    fs.rmSync(absolute(LOCK_PATH), { force: true });
  }
}

async function runSessionStart(tool) {
  try {
    // SessionStart の入力 JSON は仕様上使わないが、標準入力を最後まで読み捨てる。
    for await (const _chunk of process.stdin) { /* 内容は使わず読み捨てる */ }
    const facts = readInstallFacts();
    const decision = decideInstall(facts);
    const context = decision.action === 'skip'
      ? messageSkipped(facts.config.config)
      : decision.action === 'busy'
        ? 'cc-sdd の導入中、または前回の導入が中断されています。導入が完了するまで入力は止まります。'
        : decision.action === 'fail'
          ? `cc-sdd の導入は未完了です。最初の入力で導入を試み、完了するまで入力は止まります。理由: ${decision.reason}`
          : decision.action === 'rewrite-section'
            ? '運用の区画の文章が新しくなっています。最初の入力で、区画だけを書き直します（cc-sdd 本体は入れ直しません）。'
            : 'cc-sdd はまだ揃っていません。最初の入力で導入します。';
    writeOutput(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`);
  } catch {
    // SessionStart の例外は知らせず、入力時のフックに判断を任せる。
  }
  process.exitCode = 0;
}

async function runUserPromptSubmit(tool) {
  // 止めた入力。入力の解析に成功した後は、後続の例外でも停止の案内に入れる
  let prompt = null;
  let installing = false;
  let rewriting = false;
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input);
    if (typeof event.prompt !== 'string') throw new Error('入力 JSON に prompt 文字列がありません。');
    prompt = event.prompt;
    let facts = readInstallFacts();
    let decision = decideInstall(facts);
    if (decision.action === 'skip') {
      process.exitCode = 0;
      return;
    }
    if (decision.action === 'fail') {
      writeStop(prompt, messageBlocked({ kind: 'failed', detail: decision.reason }));
      process.exitCode = 0;
      return;
    }
    if (decision.action === 'busy') {
      writeStop(prompt, messageBlocked({ kind: 'busy', stale: decision.stale }));
      process.exitCode = 0;
      return;
    }
    if (decision.action === 'rewrite-section') {
      rewriting = true;
      const result = performSectionRewrite({ writeResult: false });
      rewriting = false;
      if (result.rewritten) {
        const additionalContext = `${result.message}\n${messageReadSkillDirectly(tool, event.prompt)}`;
        writeOutput(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })}\n`);
        process.exitCode = 0;
        return;
      }
      // 印を取った後の再判定が書き直し以外なら、今の入口の扱いに回す
      decision = result.decision;
      facts = result.facts;
      if (decision.action === 'skip') {
        process.exitCode = 0;
        return;
      }
      if (decision.action === 'fail') {
        writeStop(prompt, messageBlocked({ kind: 'failed', detail: decision.reason }));
        process.exitCode = 0;
        return;
      }
      if (decision.action === 'busy') {
        writeStop(prompt, messageBlocked({ kind: 'busy', stale: decision.stale }));
        process.exitCode = 0;
        return;
      }
    }
    installing = true;
    const installedMessage = performInstall(facts.config.config, { writeResult: false });
    const additionalContext = `${installedMessage}\n${messageReadSkillDirectly(tool, event.prompt)}`;
    writeOutput(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } })}\n`);
  } catch (error) {
    if (error instanceof BusyInstallError) {
      let stale = false;
      try {
        const facts = readInstallFacts();
        stale = facts.lock.present && facts.lock.ageMs > STALE_LOCK_MS;
      } catch { /* 印を読めない場合も、止める理由を下で示す */ }
      writeStop(prompt, messageBlocked({ kind: 'busy', stale }));
    } else if (rewriting && error instanceof SectionRewriteError) {
      writeStop(prompt, messageBlocked({ kind: 'section', detail: error.message }));
    } else if (installing || (error instanceof Error && recordedInstallErrors.has(error))) {
      writeStop(prompt, messageBlocked({ kind: 'failed', detail: error.message }));
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      writeStop(prompt, `入力を止めています。判定できなかった理由: ${detail}\n通常の端末で次を実行して再試行してください: ${RETRY_COMMAND}`);
    }
  }
  process.exitCode = 0;
}

/**
 * 導入の成功後に承認の記録を書き、結果の表示行を出す（4.3）。
 * codex-trust*.mjs は動的 import で読む（古い導入先で配置物が無くても、導入の結果を変えないため）。
 * 失敗は標準エラー出力へ 1 行だけ出し、終了コードは変えない。
 */
async function reportCodexTrust() {
  try {
    const { applyCodexTrust } = await import('./codex-trust.mjs');
    const { messageTrust } = await import('./codex-trust-rules.mjs');
    const result = applyCodexTrust({ repoRoot: root, mode: 'write' });
    for (const line of messageTrust(result)) writeOutput(`${line}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`承認の記録を扱えませんでした（${reason}）\n`);
  }
}

function runCli() {
const args = process.argv.slice(2);
if (args[0] === 'user-prompt-submit') {
  if (args.length !== 3 || args[1] !== '--tool' || !['claude', 'codex'].includes(args[2])) {
    fs.writeSync(2, `使い方: user-prompt-submit --tool <claude|codex>\n${messageUsage()}\n`);
    process.exit(2);
  }
  void runUserPromptSubmit(args[2]);
  return;
}
if (args[0] === 'session-start') {
  if (args.length !== 3 || args[1] !== '--tool' || !['claude', 'codex'].includes(args[2])) {
    fs.writeSync(2, `使い方: session-start --tool <claude|codex>\n${messageUsage()}\n`);
    process.exit(2);
  }
  void runSessionStart(args[2]);
  return;
}
if (args.length === 1 && args[0] === '--help') {
  writeOutput(`${messageUsage()}\n`);
  process.exitCode = 0;
  return;
}
if (args.length !== 0) {
  fs.writeSync(2, `${messageUsage()}\n`);
  process.exit(2);
}
try {
  const facts = readInstallFacts();
  const checked = facts.config;
  if (!checked.ok) throw new Error(checked.reason);
  const config = checked.config;
  const decision = decideInstall(facts);
  if (decision.action === 'skip') {
    writeOutput(`${messageSkipped(config)}\n`);
  } else if (decision.action === 'rewrite-section') {
    const result = performSectionRewrite();
    if (!result.rewritten) {
      // 印を取った後の再判定が書き直し以外なら、今の扱いに回す
      const again = result.decision;
      if (again.action === 'skip') writeOutput(`${messageSkipped(config)}\n`);
      else if (again.action === 'install') performInstall(result.facts.config.config);
      else {
        writeOutput(`${messageBlocked(again.action === 'busy'
          ? { kind: 'busy', stale: again.stale }
          : { kind: 'failed', detail: again.reason })}\n`);
        process.exitCode = 1;
        process.exit();
      }
    }
  } else if (decision.action === 'install') {
    performInstall(config);
  } else {
    writeOutput(`${messageBlocked(decision.action === 'busy'
      ? { kind: 'busy', stale: decision.stale }
      : { kind: 'failed', detail: decision.reason })}\n`);
    process.exitCode = 1;
    process.exit();
  }
  process.exitCode = 0;
  // 導入が成功した経路（skip・rewrite-section・install）だけがここに来る。失敗の経路は process.exit で止まる
  void reportCodexTrust();
} catch (error) {
  if (error instanceof BusyInstallError) {
    const facts = readInstallFacts();
    writeOutput(`${messageBlocked({ kind: 'busy', stale: facts.lock.present && facts.lock.ageMs > 660000 })}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof SectionRewriteError) {
    // 区画の書き直しの失敗は導入の失敗ではないため、失敗の記録は残さない。
    writeOutput(`${messageBlocked({ kind: 'section', detail: error.message })}\n`);
    process.exitCode = 1;
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  // 失敗記録は導入中の印を持つ実行だけが更新する。
  if (!(error instanceof Error && recordedInstallErrors.has(error)) && !fs.existsSync(absolute(LOCK_PATH))) {
    try { writeRecord(FAILURE_RECORD, reason); }
    catch (recordError) { process.stderr.write(`失敗の記録を書けませんでした: ${recordError.message}\n`); }
  }
  writeOutput(`${messageBlocked({ kind: 'failed', detail: reason })}\n`);
  process.exitCode = 1;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCli();
