// Ruleset の対象範囲と導入の選択の再利用（brw-enforcement 5.1）の契約テスト。selftest.mjs から呼ばれる。
// 選択はローカルの Git 共通ディレクトリに保存し、GitHub へは通信しない（見送りが認証なしで残ることを確かめる）。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitOut, mkRepoWithRemote, mkWorktree } from "./support/git-fixture.mjs";
import { normalizeConfig } from "../scripts/lib.mjs";
import { choiceFileOf, markVerified, recordApplied, recordChoice, refsOf, resolveChoice } from "../scripts/ruleset-choice.mjs";

const CONFIG = { workBranches: ["dev/*"], protectedBranches: ["main"], baseBranch: "develop", baseBranches: ["release"] };
const TARGET = { host: "github.com", owner: "acme", repository: "app", repositoryId: 4242, refs: ["develop", "release"] };
const SKIP = { host: "github.com", owner: "acme", repository: "app", refs: ["develop", "release"] };

export const runRulesetChoiceChecks = async (eq) => {
  const r = mkRepoWithRemote({ branch: "dev/foo", config: CONFIG });
  try {
    const d = r.dir;

    // ---- 対象範囲は恒常的な分岐元（permanentBases）から決まる ----
    eq("ruleset/4.1 対象の分岐元は宣言の恒常的な分岐元の集合（整列・重複なし）", refsOf(normalizeConfig(CONFIG)), ["develop", "release"]);
    eq("ruleset/4.1 一時的な brwBase は分岐元の集合へ入らない", refsOf(normalizeConfig({ ...CONFIG, brwBase: "feature/x" })).includes("feature/x"), false);

    // ---- 保存場所は Git 共通ディレクトリ配下 brw/ ----
    const file = choiceFileOf(d);
    const common = realpathSync(join(d, gitOut(d, "rev-parse", "--git-common-dir")));
    eq("ruleset/4.1 選択の保存先は Git 共通ディレクトリ配下 brw/", file?.startsWith(join(common, "brw")), true);

    // ---- 導入する選択 ----
    const before = resolveChoice(d, TARGET);
    eq("ruleset/4.1 未選択の対象は選択待ちとして返す", [before.ok, before.status], [true, "pending"]);

    const rec = recordChoice(d, { ...TARGET, enabled: true });
    eq("ruleset/4.1 導入を選んだ選択を保存できる", rec.ok, true);
    const sel = resolveChoice(d, TARGET);
    eq("ruleset/4.5 同一の対象では保存した選択を引き継ぐ（導入・リポジトリ ID 保存済み）", [sel.status, sel.repositoryId], ["selected", 4242]);

    // owner・repository の大文字小文字は同じリポジトリとして扱う（GitHub の名前は大文字小文字を区別しない）
    eq("ruleset/4.5 リポジトリ名の大文字小文字が違っても同じ対象として扱う", resolveChoice(d, { ...TARGET, owner: "ACME", repository: "App" }).status, "selected");

    // ---- 対象の変更と ID の不一致は選択待ち ----
    const moved = resolveChoice(d, { ...TARGET, refs: ["develop"] });
    eq("ruleset/4.6 保護対象の分岐元が変わったら選択待ちとして返す", [moved.status, /分岐元/.test(moved.reason ?? "")], ["pending", true]);
    const idMismatch = resolveChoice(d, { ...TARGET, repositoryId: 999 });
    eq("ruleset/4.6 保存済みと異なるリポジトリ ID は選択待ちとして返す", [idMismatch.status, /ID/.test(idMismatch.reason ?? "")], ["pending", true]);
    const otherHost = resolveChoice(d, { ...TARGET, host: "ghe.example.com" });
    eq("ruleset/4.6 ホストが違う対象は同じ選択として扱わない", otherHost.status, "pending");
    const otherRepo = resolveChoice(d, { ...TARGET, repository: "other" });
    eq("ruleset/4.6 別リポジトリは同じ選択として扱わない", otherRepo.status, "pending");

    // 選択を取り直したら、新しい対象で再利用できる。古い対象は選択待ちに戻る
    const reChosen = recordChoice(d, { ...TARGET, refs: ["develop"], enabled: true });
    eq("ruleset/4.6 対象を取り直して保存できる", reChosen.ok, true);
    eq("ruleset/4.6 取り直した対象は再利用できる", resolveChoice(d, { ...TARGET, refs: ["develop"] }).status, "selected");
    eq("ruleset/4.6 取り直し前の分岐元集合は選択待ちに戻る", resolveChoice(d, TARGET).status, "pending");
    recordChoice(d, { ...TARGET, enabled: true });

    // ---- 適用済み ID は選択と別に記録する ----
    const choiceBefore = JSON.stringify(readJson(file).repos["github.com/acme/app"].choice);
    const app = recordApplied(d, { ...TARGET, rulesetId: 77 });
    eq("ruleset/4.3 適用済み ID を記録できる", app.ok, true);
    const choiceAfter = JSON.stringify(readJson(file).repos["github.com/acme/app"].choice);
    eq("ruleset/4.3 適用済み ID の記録は選択の内容を変えない", choiceAfter, choiceBefore);
    eq("ruleset/4.3 適用済み ID は適用確認前として記録される", readJson(file).repos["github.com/acme/app"].applied[0].verified, false);
    eq("ruleset/4.3 同じ ID を二度記録しても重複しない", [recordApplied(d, { ...TARGET, rulesetId: 77 }).ok, readJson(file).repos["github.com/acme/app"].applied.length], [true, 1]);
    eq("ruleset/4.3 適用確認の完了を記録すると確認済みになる", [markVerified(d, { ...TARGET, rulesetId: 77 }).ok, readJson(file).repos["github.com/acme/app"].applied[0].verified], [true, true]);
    const withApplied = resolveChoice(d, TARGET);
    eq("ruleset/4.5 選択済みの再利用結果に既存の適用済み ID が含まれる", withApplied.appliedRulesetIds, [77]);
    eq("ruleset/4.3 未登録の ID は確認済みにできない", markVerified(d, { ...TARGET, rulesetId: 1234 }).ok, false);
    eq("ruleset/4.3 リポジトリ ID のない適用は記録できない", recordApplied(d, { ...TARGET, repositoryId: undefined, rulesetId: 78 }).ok, false);

    // 対象が変わっても、既に作った Ruleset の ID は報告できるよう残す
    const changed = resolveChoice(d, { ...TARGET, refs: ["develop"] });
    eq("ruleset/4.6 対象が変わった場合も既存の適用済み ID を報告する", changed.knownRulesetIds, [77]);

    // ---- 見送りは GitHub 認証なしで保存し、次回も見送りになる ----
    const skipRec = recordChoice(d, { ...SKIP, enabled: false, token: "ghp_abcdefghijklmnop" });
    eq("ruleset/4.4 見送りを認証なしで保存できる", skipRec.ok, true);
    eq("ruleset/4.4 資格情報らしい値は保存されない", readFileSync(file, "utf8").includes("ghp_"), false);
    eq("ruleset/4.4 見送りの記録は次回の読み込みでも見送りになる", resolveChoice(d, SKIP), { ok: true, status: "skipped" });
    eq("ruleset/4.4 見送りは対象の分岐元が変われば選択待ちになる", resolveChoice(d, { ...SKIP, refs: ["develop"] }).status, "pending");
    eq("ruleset/4.4 見送りでも保存したリポジトリ ID を要求しない", resolveChoice(d, { ...SKIP, repositoryId: 4242 }).status, "skipped");
    recordChoice(d, { ...TARGET, enabled: true });

    // ---- 入力の検証 ----
    eq("ruleset/4.1 不正なホストは保存しない", recordChoice(d, { ...TARGET, host: "bad host/x", enabled: true }).ok, false);
    eq("ruleset/4.1 空の分岐元集合は保存しない", recordChoice(d, { ...TARGET, refs: [], enabled: true }).ok, false);
    eq("ruleset/4.1 不正な分岐元名は保存しない", recordChoice(d, { ...TARGET, refs: ["a b"], enabled: true }).ok, false);
    eq("ruleset/4.1 Git の外では保存も読み込みもしない", [recordChoice("/", { ...TARGET, enabled: true }).ok, resolveChoice("/", TARGET).status], [false, "pending"]);

    // ---- worktree 間で同じ選択を共有し、保存は一時ファイル経由 ----
    const wt = mkWorktree(d, "dev/bar");
    eq("ruleset/4.1 別の worktree も同じ Git 共通ディレクトリの選択を使う", resolveChoice(wt, TARGET).status, "selected");
    eq("ruleset/4.1 保存後に一時ファイルと作業ロックが残らない", readdirSync(join(file, "..")).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock")), []);

    // ---- ロック中は待って失敗し、解放後に保存できる ----
    const lock = `${file}.lock`;
    writeFileSync(lock, String(process.pid));
    const locked = recordChoice(d, { ...TARGET, enabled: true }, { lockWaitMs: 50 });
    eq("ruleset/4.1 別の処理が保存中なら書き込まず衝突として返す", [locked.ok, locked.error?.kind], [false, "conflict"]);
    rmSync(lock, { force: true });
    eq("ruleset/4.1 ロックが解放されたら保存できる", recordChoice(d, { ...TARGET, enabled: true }).ok, true);

    // ---- 壊れた保存は安全側（選択待ち）。上書きもしない ----
    const brokenText = "{ broken";
    writeFileSync(file, brokenText);
    const broken = resolveChoice(d, TARGET);
    eq("ruleset/4.1 壊れた選択の記録は選択待ちとして返す（例外にしない）", [broken.ok, broken.status], [true, "pending"]);
    eq("ruleset/4.1 壊れた選択の記録は上書きせず衝突として返す", [recordChoice(d, { ...TARGET, enabled: true }).ok, readFileSync(file, "utf8")], [false, brokenText]);
    eq("ruleset/4.1 壊れた選択の記録では適用済み ID を追加しない", [recordApplied(d, { ...TARGET, rulesetId: 80 }).ok, readFileSync(file, "utf8")], [false, brokenText]);
    rmSync(file, { force: true });
    eq("ruleset/4.1 記録が消えた場合は選択待ちに戻る", resolveChoice(d, TARGET).status, "pending");

    // 形が違う（版・構造が想定外）も壊れた扱い
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 99, repos: [] }));
    eq("ruleset/4.1 形の違う記録は選択待ちとして返す", resolveChoice(d, TARGET).status, "pending");

    // ---- リポジトリ ID を取り直したとき、旧 ID の適用済み記録を再利用しない（レビュー指摘） ----
    rmSync(file, { force: true });
    recordChoice(d, { ...TARGET, enabled: true });
    recordApplied(d, { ...TARGET, rulesetId: 5 });
    eq("ruleset/4.5 リポジトリ ID を取り直して保存できる", recordChoice(d, { ...TARGET, repositoryId: 4243, enabled: true }).ok, true);
    const reId = resolveChoice(d, { ...TARGET, repositoryId: 4243 });
    eq("ruleset/4.5 取り直した ID では旧 ID の適用済み記録を再利用結果に含めない", [reId.status, reId.appliedRulesetIds], ["selected", []]);
    eq("ruleset/4.6 取り直し後の対象が変わった場合も旧 ID を報告しない", resolveChoice(d, { ...TARGET, refs: ["develop"], repositoryId: 4243 }).knownRulesetIds, []);
    eq("ruleset/4.3 同じ Ruleset ID でもリポジトリ ID が違えば別の記録として残す", [recordApplied(d, { ...TARGET, repositoryId: 4243, rulesetId: 5 }).ok, readJson(file).repos["github.com/acme/app"].applied.length], [true, 2]);
    recordChoice(d, { ...TARGET, enabled: true });
    eq("ruleset/4.5 元の ID に戻すと、その ID の適用済み記録だけを返す", resolveChoice(d, TARGET).appliedRulesetIds, [5]);

    // ---- 記録の形が想定外なら、例外にせず選択待ちにする（レビュー指摘） ----
    const writeRecord = (over) => writeFileSync(file, JSON.stringify({
      version: 1,
      repos: { "github.com/acme/app": { host: "github.com", owner: "acme", repository: "app", applied: [], choice: { refs: ["develop", "release"], enabled: true, repositoryId: null }, ...over } },
    }));
    writeRecord({ applied: [null] });
    let nullRes;
    try { nullRes = resolveChoice(d, TARGET); } catch (e) { nullRes = { threw: e.message }; }
    eq("ruleset/4.1 適用済み記録に null があれば例外にせず選択待ちとして返す", [nullRes.ok, nullRes.status], [true, "pending"]);
    eq("ruleset/4.1 適用済み記録に null があれば書き込みは衝突として返す", recordApplied(d, { ...TARGET, rulesetId: 9 }).ok, false);
    writeRecord({ choice: { refs: ["develop", "release"], enabled: true, repositoryId: "x" } });
    eq("ruleset/4.1 保存済みのリポジトリ ID が正の整数でなければ選択済みにしない", resolveChoice(d, { ...TARGET, repositoryId: undefined }).status, "pending");
    writeRecord({ applied: [{ refs: ["develop", "release"], repositoryId: 4242, rulesetId: "5", verified: false }] });
    eq("ruleset/4.1 適用済み ID が正の整数でなければ選択待ちとして返す", resolveChoice(d, TARGET).status, "pending");
    writeRecord({ choice: { refs: ["develop", "release"], enabled: true, repositoryId: 4242 }, applied: [{ refs: ["develop", "release"], repositoryId: 4242, rulesetId: 5, verified: "yes" }] });
    eq("ruleset/4.1 適用済み記録の確認フラグが真偽値でなければ選択待ちとして返す", resolveChoice(d, TARGET).status, "pending");
  } finally {
    r.cleanup();
  }
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
