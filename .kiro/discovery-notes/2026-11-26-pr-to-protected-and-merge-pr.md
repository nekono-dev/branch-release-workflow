# 引き継ぎメモ: 分岐元ブランチから保護ブランチへの PR を作れない問題と、PR 経由のマージの扱い（BRW 側）

2026-11-26 の cc-sdd-bootstrap での作業中に見つかった問題と、利用者の要望の記録。`/kiro-discovery` の入力に使う。同じ日の別のメモ（`2026-11-26-base-branch-sync.md`）とは別件。

## 利用者の要望（決定済みの方針）

1. **分岐元ブランチ（`baseBranch`。例: `develop`）から保護ブランチ（`protectedBranches`。例: `main`）への PR の作成は、封じない。** 保護ブランチへのマージ・直接の commit・push は禁止のままにする。PR を作ること自体は阻害しない。
2. **作業ブランチから分岐元ブランチへの直接のマージ（ローカルのマージ・push）は NG のまま。ただし、PR を承認してマージすることは、利用者の確認があれば禁止しない。**
   - 「利用者の確認」は、エージェントが代行できない承認（利用者が自分で承認する・全文を自分の端末で実行する、など）を指す。エージェントが確認なしにマージしてはならない。

どちらも、BRW の機能修正として扱う。新規の仕様か既存の仕様（`brw-pr-handoff`・`brw-enforcement` など）の拡張かは、discovery で決める。

## 起きたこと（実際の拒否の記録）

- 状況: cc-sdd-bootstrap で、作業ブランチ `dev/base-branch-sync` の PR（#12）は `brw pr-template` → `brw pr` で作成でき、`develop` へ squash マージされた。続けて、利用者が「`develop` から `main` 向けの PR も作成して」と依頼した。
- そのリポジトリの宣言（`.branch-release-workflow.json`）: `workBranches: ["develop", "dev/*"]`、`protectedBranches: ["main"]`、`baseBranch: "develop"`、`autoApprove: { push: true, pullRequest: true }`。つまり `develop` は作業ブランチかつ分岐元。
- 拒否 1（PreToolUse のフック）: `gh pr create --base main --head develop …` が、「エージェントによる PR の直接の作成は行えません。PR は brw pr で作成します。…（`gh pr create`・GitHub の API・MCP による直接の作成は使えません）」で拒否された。
- 拒否 2: `brw pr-template`（`develop` の本体の checkout で実行）が、「'develop' は開発ブランチではないため、本文を用意しません。」で終了した。
- 拒否 3: `brw work start` が、「'develop' は恒常的な分岐元のため、作業を始めません。開発ブランチで brw create または brw work resume を使ってください。」で終了した。
- 結果: `develop` → `main` の PR を、BRW の手順でも直接の手順でも作れなかった。エージェントは回避せず、利用者へ作成画面の URL と本文案を渡して、利用者が手で作成することになった。
- 過去の記録: cc-sdd-bootstrap でもこれまで「PR は利用者が作成」としてきた。同じ詰まりが繰り返されていた可能性がある。

## 現状の理解（discovery で確かめる）

- `brw pr` / `brw publish` は「開発ブランチ（`dev/*`）の作業」を前提にしており、`brw work start` が `develop`（恒常的な分岐元）を拒否する。分岐元ブランチ自体を PR の出し元にする経路が無い。
- 直接の PR 作成（`gh pr create`・API・MCP）は、規則に合う場合も一律に拒否される。そのため、`brw pr` が使えない場合の逃げ道が無い。
- 拒否の案内は「`brw pr` を使え」と言うが、`brw pr` 側も受け付けないため、利用者を行き止まりに導く。
- 作業ブランチから分岐元ブランチへの PR（`dev/x` → `develop`）は、今の仕組みで作成できた（この点は変えない）。
- PR を承認してマージする操作（GitHub 上のマージ。`gh pr merge` など）が現状どう扱われるかは、この作業では試していない。スキルの説明には「BRW は GitHub のマージを行いません」「エージェントは GitHub のマージや自動マージの予約をしない」とある。

## 検討の案（決めてはいない。discovery で判断する）

- A. `brw pr` に、分岐元ブランチ（または宣言の作業ブランチ）を出し元として保護ブランチへ PR を出す経路を足す（`--base <保護ブランチ>` の指定、本文の雛形は既存の `pr-template` を流用）。`brw work start` が分岐元を拒否している条件の見直しも含む。
- B. 直接の `gh pr create` の拒否を、「出し元が分岐元／作業ブランチで、取り込み先が宣言のブランチ（保護ブランチを含む）」のときは、規則に合うなら許可する。PR 作成はマージではないので、保護の目的（本番への反映の防止）を損なわない。
- C. PR 経由のマージ（`gh pr merge` など）を、通常の承認（利用者が自分で承認・実行する）を条件に許可する経路を設ける。承認の代行はできない既存の方針（`--confirmed` の扱い）に合わせる。保護ブランチへのマージを許可するかどうかは、利用者が決める（要望では、保護ブランチへのマージは禁止されるべきとしている）。
- 優先: 要望 1（PR 作成）は、利用者の作業を止めているので先に直す。要望 2（PR 経由のマージ）は、承認の仕組みの設計が要るので、別の仕様にしてもよい。

## 次の作業

- `/kiro-discovery` でこのメモを入力にし、(a) 要望 1 の直し方（案 A・B のどちらか、または両方）、(b) 要望 2 を同じ仕様に含めるか、(c) 既存の仕様（`brw-pr-handoff`・`brw-enforcement`）との関係、を決める。
- 確認すること: 拒否コードと該当の実装（`scripts/` 配下の `gh pr create` を拒否する判定、`brw work start` の「恒常的な分岐元」の判定、`brw pr-template` の「開発ブランチではない」の判定）、Claude と Codex の両方のフックと `brw guard` への反映、`SKILL.md`・`references/` の説明、自己テスト（`tests/`）。
- 最終的な PR の作成は、これらが直るまでは、利用者が GitHub 上で行う（cc-sdd-bootstrap の `develop` → `main` の PR は、そのように依頼した）。
