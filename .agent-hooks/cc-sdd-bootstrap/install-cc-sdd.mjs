#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_FILE, UPDATE_COMMAND, FAILURE_RECORD, STATE_PATH, NPX_TIMEOUT_MS, RECORD_IN_PROGRESS,
  readInstallConfig, parseState, buildState, isFingerprintTarget, decideInstall,
  removalTargets, buildManifest, npxArgs, messageInstalled, messageSkipped,
  messageGuide, failureRecordText, messageFailed
} from './install-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hookMode = process.argv[2] === 'session-start';
const argsValid = process.argv.length === 2 || (process.argv.length === 3 && hookMode);

if (!argsValid) {
  process.stderr.write('使い方: node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs [session-start]\n');
  process.exit(2);
}

const absolute = (rel) => path.join(root, rel);
const writeRecord = (rel, text) => {
  fs.mkdirSync(path.dirname(absolute(rel)), { recursive: true });
  fs.writeFileSync(absolute(rel), text, 'utf8');
};
const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function currentHashes(keepTemplates) {
  const hashes = {};
  const walk = (rel) => {
    const full = absolute(rel);
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && isFingerprintTarget(child, keepTemplates)) {
        try { hashes[child] = hashFile(absolute(child)); } catch { /* 読めないファイルは未記録とする */ }
      }
    }
  };
  walk('.claude/skills');
  walk('.kiro/settings');
  return hashes;
}

function templatesMissing() {
  const dir = absolute('.kiro/settings/templates');
  try {
    const walk = (current) => fs.readdirSync(current, { withFileTypes: true }).some((entry) => {
      const file = path.join(current, entry.name);
      return entry.isFile() || (entry.isDirectory() && walk(file));
    });
    return !walk(dir);
  } catch { return true; }
}

function rejectLinkedParents() {
  for (const rel of ['.claude', '.claude/skills', '.kiro', '.kiro/settings']) {
    try {
      if (fs.lstatSync(absolute(rel)).isSymbolicLink()) throw new Error(`${rel} がシンボリックリンクです。`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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

function collectFiles(keepTemplates) {
  const files = {};
  const collect = (rel) => {
    let entries;
    try { entries = fs.readdirSync(absolute(rel), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) collect(child);
      else if (entry.isFile() && isFingerprintTarget(child, keepTemplates)) files[child] = hashFile(absolute(child));
    }
  };
  let skillEntries = [];
  try { skillEntries = fs.readdirSync(absolute('.claude/skills'), { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of skillEntries) {
    if (entry.name.startsWith('kiro-') && entry.isDirectory()) collect(`.claude/skills/${entry.name}`);
  }
  const guide = '.kiro/settings/cc-sdd-guide.md';
  try {
    if (fs.lstatSync(absolute(guide)).isFile() && isFingerprintTarget(guide, keepTemplates)) files[guide] = hashFile(absolute(guide));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!keepTemplates) collect('.kiro/settings/templates');
  return files;
}

function performInstall(config, templatesAbsent) {
  writeRecord(FAILURE_RECORD, RECORD_IN_PROGRESS);
  rejectLinkedParents();
  let skillEntries = [];
  try { skillEntries = fs.readdirSync(absolute('.claude/skills')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const rel of removalTargets({ skillEntries, keepTemplates: config.keepTemplates })) removeTarget(rel);

  const cache = absolute('.cache');
  fs.mkdirSync(cache, { recursive: true });
  const manifestPath = absolute(`.cache/cc-sdd-install.manifest.${process.pid}.json`);
  const manifest = buildManifest({ keepTemplates: config.keepTemplates, templatesMissing: templatesAbsent });
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const rawTimeout = process.env.CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS;
    const timeout = /^\d+$/.test(rawTimeout ?? '') && Number(rawTimeout) > 0 ? Number(rawTimeout) : NPX_TIMEOUT_MS;
    const result = spawnSync('npx', npxArgs(config, manifestPath), {
      cwd: root, stdio: ['ignore', 2, 2], timeout, encoding: 'utf8'
    });
    if (result.error?.code === 'ETIMEDOUT') throw new Error(`時間内に取得・導入が終わりませんでした（${Math.ceil(timeout / 1000)}秒）。通信を確かめてから再試行してください`);
    if (result.error) throw new Error(`npx を起動できませんでした: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`npx の終了コードが ${result.status ?? result.signal} でした。通信・版（${config.version}）・言語（${config.lang}）を確かめてください`);

    const state = buildState({ config, files: collectFiles(config.keepTemplates) });
    const stateTmp = absolute(`${STATE_PATH}.${process.pid}.tmp`);
    fs.writeFileSync(stateTmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(stateTmp, absolute(STATE_PATH));
    fs.rmSync(absolute(FAILURE_RECORD), { force: true });
    process.stdout.write(`${messageInstalled(config)}\n${messageGuide()}\n`);
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }
}

try {
  let configText = null;
  try { configText = fs.readFileSync(absolute(CONFIG_FILE), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`${CONFIG_FILE} を読めませんでした（${error.message}）。${CONFIG_FILE} を直すか、${UPDATE_COMMAND} で設定を新しくしてください。`);
    }
  }
  const checked = readInstallConfig(configText);
  if (!checked.ok) throw new Error(checked.reason);
  const config = checked.config;
  let stateText = null;
  try { stateText = fs.readFileSync(absolute(STATE_PATH), 'utf8'); } catch { /* 読めない状態は未記録 */ }
  const state = parseState(stateText);
  const failureRecordExists = fs.existsSync(absolute(FAILURE_RECORD));
  const current = currentHashes(config.keepTemplates);
  const missing = templatesMissing();
  const decision = decideInstall({ config, state, failureRecordExists, currentHashes: current, templatesMissing: missing });
  if (decision.action === 'skip') {
    process.stdout.write(`${messageSkipped(config)}\n${messageGuide()}\n`);
  } else {
    performInstall(config, missing);
  }
  process.exit(0);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  try { writeRecord(FAILURE_RECORD, failureRecordText(reason)); }
  catch (recordError) { process.stderr.write(`失敗の記録を書けませんでした: ${recordError.message}\n`); }
  process.stdout.write(`${messageFailed(reason)}\n`);
  process.exit(hookMode ? 0 : 1);
}
