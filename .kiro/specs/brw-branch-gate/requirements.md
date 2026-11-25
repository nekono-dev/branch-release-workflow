# 要件定義書

## 概要

BRW 導入リポジトリで、エージェントが通常の方法（素の git コマンドや Claude Code 組み込みの EnterWorktree ツール）でブランチ・worktree を作ろうとしたとき、BRW がその操作を奪って `brw create` による作成と作業場所の移動に収束させる。現状は Bash の git コマンドだけが拒否され、拒否後はエージェントが自力で手順をやり直す必要があり、EnterWorktree は判定の対象外である。cc-sdd-bootstrap など呼び出し側は BRW を知らず、通常のブランチ作成を指示するだけでよい。BRW が導入されたリポジトリでは、その操作が自動的に BRW の手順へ置き換わるか、実行すべき手順を自然文で案内される。経緯と検証の記録は [brief.md](brief.md) と [research.md](research.md) に置く。

## Boundary Context

- **In scope**: ブランチ・worktree の作成と作業場所の変更を試みる入口の判定、命名規則に合う素の git コマンドの `brw create` への置き換え、置き換えられない場合の拒否と案内、未コミットの変更を移す `brw create --carry`、EnterWorktree の拒否と 2 手の案内、既存ブランチへの切り替えの扱い、利用者向けの資料と検査。
- **Out of scope**: cc-sdd-bootstrap と kiro 系スキルの変更、`brw create` の命名規則・分岐元・配置先の変更（`--carry` の追加を除く）、未追跡のファイルの移動、保護規則・Ruleset の変更、PR 作成・片付けの流れ（brw-pr-handoff）、宣言のないリポジトリの挙動の変更。
- **Adjacent expectations**: 作業ブランチの作成・再開は、既存の `brw create` と `brw resume`（brw-enforcement）が行う。呼び出し側は素の git で試みるだけで、BRW を呼ぶ手順を知る必要はない。Codex では入力の書き換えを前提とせず、拒否と案内で扱う。

## 用語

- **置き換え**: エージェントの操作を拒否せず、同じ目的の BRW の操作に変えて実行すること。
- **作業場所**: エージェントのコマンドが実行されるディレクトリ。作業ブランチの worktree へ移ること。
- **入口**: ブランチ・worktree を作れる、または作業場所を変えられる操作（git コマンド、EnterWorktree ツールなど）。

## Requirements

### Requirement 1: 通常のブランチ作成を BRW の作成に置き換える

**Objective:** As a 呼び出し側（エージェントや cc-sdd-bootstrap）, I want 通常のブランチ作成を指示するだけで BRW の手順が適用されてほしい, so that BRW を知らなくても命名規則・分岐元・作業場所が統一される

#### Acceptance Criteria
1. When エージェントが BRW 導入済みのリポジトリで `git switch -c`・`git checkout -b`・`git branch <名前>`・`git worktree add -b` による作業ブランチの作成を実行しようとし、名前が宣言の命名規則に合い、追跡済みファイルの未コミットの変更が無いとき, the BRW shall その操作を `brw create` による作成に置き換えて実行する。
2. When 置き換えを実行したとき, the BRW shall 作成された worktree へ作業場所を移し、続くコマンドが worktree の中で実行されるようにする。
3. When 置き換えを実行したとき, the BRW shall 何が何に置き換えられたかと、作業場所が移ったことを自然文で表示する。
4. If 名前が宣言の命名規則に合わない、分岐元を確定できない、または操作が他のコマンドと組み合わされていて対象を確定できないとき, then the BRW shall 置き換えず操作を拒否し、理由と実行すべき `brw create` の例を表示する。
5. If 操作が `brw create` の配置先（リポジトリ本体の `.claude/worktrees/` の配下）以外の場所を指している、または作業場所の移動を確認できない実行環境であるとき, then the BRW shall 置き換えを行わず、拒否して `brw create` の使い方を案内する。
6. Where 実行環境が操作の書き換えに対応していない（Codex など）, the BRW shall 置き換えを行わず、拒否して実行すべき手順を表示する。
7. Where BRW を導入していないリポジトリ, the BRW shall ブランチ・worktree の作成を拒否も置き換えもしない。
8. If 追跡済みファイルの未コミットの変更があるとき, then the BRW shall 置き換えず操作を拒否し、「変更を移さずに作る `brw create <名前>`」と「変更を移して作る `brw create <名前> --carry`」の 2 つの選択肢を、それぞれ何が起きるかとともに案内する。
9. While 追跡済みファイルの未コミットの変更が無く未追跡のファイルだけがある, the BRW shall 置き換えを実行し、未追跡のファイルが元の作業ツリーに残ることと件数を案内に含める。
10. When `brw create` に `--carry` が指定されたとき, the BRW shall 元の作業ツリーにある追跡済みファイルの未コミットの変更を新しい worktree に適用し、適用結果が元の変更と一致したことを確認した後にだけ、元の作業ツリーから同じ変更を取り除く。
11. If `--carry` の適用が失敗した、結果が元の変更と一致しない、または分岐元が元の作業ツリーの HEAD と異なるとき, then the BRW shall 元の作業ツリーを変更せず、作成した worktree とブランチを残さず、理由を表示する。
12. If `--carry` の確認と取り除きの間に元の作業ツリーの変更が変わったとき, then the BRW shall 元の作業ツリーから何も取り除かず、変更が両方に残っていることを表示する。
13. When `--carry` が実行されたとき, the BRW shall 未追跡のファイルを移さず、移さなかったファイルの一覧を表示する。

### Requirement 2: Bash 以外の入口も BRW の手順に収束させる

**Objective:** As a 開発者, I want git コマンド以外の方法でも BRW を迂回できないようにしたい, so that どの入口から作っても命名規則と分岐元が守られる

#### Acceptance Criteria
1. When エージェントが BRW 導入済みのリポジトリで EnterWorktree を `name` 指定で実行しようとしたとき, the BRW shall 操作を拒否し、`brw create <名前>` を実行した後に `EnterWorktree` を `path` 指定で呼ぶ 2 手を自然文で案内する。
2. When EnterWorktree が `path` 指定で、BRW が作成した worktree を指しているとき, the BRW shall 操作を許可する。
3. If EnterWorktree の `path` が、BRW が作成した作業ブランチの worktree でないとき, then the BRW shall 操作を拒否し、`brw resume` などの手順を案内する。
4. If EnterWorktree の入力から対象を確定できないとき, then the BRW shall 規則に適合すると確認できるまで操作を止め、判定できなかった理由を表示する。
5. When 判定の対象となる入口が増えたとき, the BRW shall 同じ判定規則と同じ案内の書式で処理する。

### Requirement 3: 作業場所の変更と既存ブランチの再開を BRW に収束させる

**Objective:** As a 開発者, I want 既存の作業ブランチへ戻るときも同じ手順を通したい, so that 再開時にもリモートとの同期や作業場所の整合が保たれる

#### Acceptance Criteria
1. When エージェントが BRW 導入済みのリポジトリで、既存の開発ブランチへ `git switch`・`git checkout` で切り替えようとしたとき, the BRW shall その操作を `brw resume` による再開に置き換えるか、拒否して `brw resume <ブランチ>` を案内する。
2. When 保護ブランチや分岐元ブランチへの切り替えを求められたとき, the BRW shall 従来どおり通常の承認の判断に任せ、ブランチを作成しない。
3. If 切り替え先がブランチ・コミット・ファイルのどれか確認できないとき, then the BRW shall 操作を止め、判定できなかった理由を表示する。
4. While detached HEAD のコミットへ移るだけの操作, the BRW shall 作業ブランチの作成として扱わない。

### Requirement 4: 拒否と置き換えの案内を、BRW を知らない呼び出し側でも辿れる形にする

**Objective:** As a 呼び出し側（エージェントや cc-sdd-bootstrap）, I want 拒否されたときに次に実行すべきことが分かる案内を受けたい, so that BRW を知らなくても手順を辿れる

#### Acceptance Criteria
1. When BRW が操作を拒否するとき, the BRW shall 理由を自然文で示し、次に実行するコマンドをそのまま書く。
2. When BRW が操作を拒否または置き換えるとき, the BRW shall 固定の見出しと、次に実行するコマンド、作業場所のパスを、案内の中に決まった形で含める。
3. The BRW shall 案内の本文を、見出しや符号だけに頼らず、読んだだけで次の手順を取れる文章にする。
4. The BRW shall 案内の中で cc-sdd や `.kiro` などの特定の呼び出し側の語を使わない。
5. When 同じ拒否が繰り返されたとき, the BRW shall 毎回同じ内容の案内を返す。

### Requirement 5: 判定できないときは安全側に倒し、導入していない環境には干渉しない

**Objective:** As a 開発者, I want 判定に自信がないときに誤って通さず、BRW のない環境を邪魔しないでほしい, so that 規則の抜け穴が生まれず、既存の運用も壊れない

#### Acceptance Criteria
1. If 操作の対象（リポジトリ・ブランチ名・分岐元・作業場所）を確定できないとき, then the BRW shall 規則に適合すると確認できるまで操作を止め、判定できなかった理由を表示する。
2. When 置き換えの実行に失敗したとき, the BRW shall 作成途中の worktree やブランチを残さず、失敗の理由と再試行の方法を表示する。
3. Where 宣言ファイルが無いリポジトリ, the BRW shall 通常のエージェント操作を通す。
4. The BRW shall 同じ宣言と同じ入力に対して、Claude Code と Codex で同じ判定結果（置き換え可否を除く）を返す。
5. The BRW shall 判定の対象外の入口（照会だけの git コマンドなど）を妨げない。

### Requirement 6: 導入状態の検査と利用者向けの資料

**Objective:** As a リポジトリの管理者, I want 入口の制御が有効かどうかを確認し、手順を資料で知りたい, so that 導入の漏れに気付ける

#### Acceptance Criteria
1. When 導入状態を検査したとき, the BRW shall ブランチ・worktree の入口（Bash・EnterWorktree）が判定の対象になっているかを報告する。
2. If 入口のいずれかが判定の対象になっていないとき, then the BRW shall 対象外の入口と、有効にする手順を表示する。
3. The BRW shall 利用者向けの資料に、置き換えと拒否のそれぞれの挙動、作業場所の移動の条件、Codex との違いを記載する。
4. The BRW shall 呼び出し側の指示（通常のブランチ作成）と、BRW が返す案内の対応を資料に例示する。
