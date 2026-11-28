# 要件定義書

## 概要

BRW 導入リポジトリで、エージェントが通常の方法（素の git コマンドや Claude Code 組み込みの EnterWorktree ツール）でブランチ・worktree を作ろうとしたとき、BRW がその操作を奪って `brw create` による作成と作業場所の移動に収束させる。現状は Bash の git コマンドだけが拒否され、拒否後はエージェントが自力で手順をやり直す必要があり、EnterWorktree は判定の対象外である。cc-sdd-bootstrap など呼び出し側は BRW を知らず、通常のブランチ作成を指示するだけでよい。BRW が導入されたリポジトリでは、その操作が自動的に BRW の手順へ置き換わるか、実行すべき手順を自然文で案内される。経緯と検証の記録は [brief.md](brief.md) と [research.md](research.md) に置く。

2026-11-28 の更新: 作業場所（worktree）の置き場を、`<本体>/.claude/worktrees/` から、Claude Code・Codex など複数のエージェントから使える特定のエージェントの名前を持たない `<本体>/.worktree/` に変える。旧置き場は BRW の配置先として認めない（完全に切り替える）。旧置き場に残った worktree は、利用者が手で移す。配置先の決まりは、この仕様が持つ。

## Boundary Context

- **In scope**: ブランチ・worktree の作成と作業場所の変更を試みる入口の判定、命名規則に合う素の git コマンドの `brw create` への置き換え、置き換えられない場合の拒否と案内、未コミットの変更を移す `brw create --carry`、EnterWorktree の拒否と 2 手の案内、既存ブランチへの切り替えの扱い、利用者向けの資料と検査、作業場所の配置先を `<本体>/.worktree/` にすること（`brw create`・`brw resume` が作る場所、旧置き場の worktree の扱い）。
- **Out of scope**: cc-sdd-bootstrap と kiro 系スキルの変更、`brw create` の命名規則・分岐元の変更（`--carry` の追加と、2026-11-28 の更新による配置先の変更を除く）、未追跡のファイルの移動、保護規則・Ruleset の変更、PR 作成・片付けの流れ（brw-pr-handoff）、宣言のないリポジトリの挙動の変更、PR 本文の置き場 `.brw/` の移動（brw-pr-handoff の更新で続けて行う。それまで PR 本文だけが旧置き場 `.claude/worktrees/.brw/` に残る）、導入先の `.gitignore`・共通の除外設定への `.worktree/` の追記と、その案内（brw-install-flow）。
- **Adjacent expectations**: 作業ブランチの作成・再開は、既存の `brw create` と `brw resume`（brw-enforcement）が行う。呼び出し側は素の git で試みるだけで、BRW を呼ぶ手順を知る必要はない。Codex では入力の書き換えを前提とせず、拒否と案内で扱う。 導入先で `.worktree/` を無視する設定は、導入・更新の流れ（brw-install-flow）が案内する。この仕様の BRW は、導入先の無視の設定を書き換えない。

## 用語

- **置き換え**: エージェントの操作を拒否せず、同じ目的の BRW の操作に変えて実行すること。
- **作業場所**: エージェントのコマンドが実行されるディレクトリ。作業ブランチの worktree へ移ること。
- **配置先**: BRW が作業ブランチの worktree を作る場所。リポジトリ本体の作業ツリーの直下の `.worktree/` の配下（`.worktree/<別名>`）。
- **旧置き場**: 2026-11-28 より前の配置先 `<本体>/.claude/worktrees/` の配下。BRW の配置先としては認めない。
- **入口**: ブランチ・worktree を作れる、または作業場所を変えられる操作（git コマンド、EnterWorktree ツールなど）。

## Requirements

### Requirement 1: 通常のブランチ作成を BRW の作成に置き換える

**Objective:** As a 呼び出し側（エージェントや cc-sdd-bootstrap）, I want 通常のブランチ作成を指示するだけで BRW の手順が適用されてほしい, so that BRW を知らなくても命名規則・分岐元・作業場所が統一される

#### Acceptance Criteria
1. When エージェントが BRW 導入済みのリポジトリで `git switch -c`・`git checkout -b`・`git branch <名前>`・`git worktree add -b` による作業ブランチの作成を実行しようとし、名前が宣言の命名規則に合い、追跡済みファイルの未コミットの変更が無いとき, the BRW shall その操作を `brw create` による作成に置き換えて実行する。
2. When 置き換えを実行したとき, the BRW shall 作成された worktree へ作業場所を移し、続くコマンドが worktree の中で実行されるようにする。ただし `git branch <名前>` のようにブランチを切り替えない操作は、ブランチだけを作り、作業場所を移さない。
3. When 置き換えを実行したとき, the BRW shall 何が何に置き換えられたかと、作業場所が移ったことを自然文で表示する。
4. If 名前が宣言の命名規則に合わない、分岐元を確定できない、または操作が他のコマンドと組み合わされていて対象を確定できないとき, then the BRW shall 置き換えず操作を拒否し、理由と実行すべき `brw create` の例を表示する。
5. If 操作が `brw create` の配置先（リポジトリ本体の `.worktree/` の配下）以外の場所（旧置き場を含む）を指している、または作業場所の移動を確認できない実行環境であるとき, then the BRW shall 置き換えを行わず、拒否して `brw create` の使い方を案内する。
6. Where 実行環境が操作の書き換えに対応していない（Codex など）, the BRW shall 置き換えを行わず、拒否して実行すべき手順を表示する。
7. Where BRW を導入していないリポジトリ, the BRW shall ブランチ・worktree の作成を拒否も置き換えもしない。
8. If ブランチを切り替える作成の操作で、追跡済みファイルの未コミットの変更があるとき, then the BRW shall 置き換えず操作を拒否し、「変更を移さずに作る `brw create <名前>`」と「変更を移して作る `brw create <名前> --carry`」の 2 つの選択肢を、それぞれ何が起きるかとともに案内する。
9. While ブランチを切り替えない作成（`git branch <名前>`）である、または追跡済みファイルの未コミットの変更が無く未追跡のファイルだけがある, the BRW shall 置き換えを実行し、未追跡のファイルが元の作業ツリーに残ることと件数を案内に含める。ただし、宣言ファイルが分岐元に未登録のときは、既存の `brw create` が宣言ファイルを新しい worktree へ移すため、その旨を案内に含める。
10. When `brw create` に `--carry` が指定されたとき, the BRW shall 元の作業ツリーにある追跡済みファイルの未コミットの変更を新しい worktree に適用し、適用結果が元の変更と一致したことを確認した後にだけ、元の作業ツリーから同じ変更を取り除く。
11. If `--carry` の適用が失敗した、結果が元の変更と一致しない、または分岐元が元の作業ツリーの HEAD と異なるとき, then the BRW shall 元の作業ツリーを変更せず、作成した worktree とブランチを残さず、理由を表示する。
12. If `--carry` の取り除きの前に、元の作業ツリーの変更が移した内容と違うことを見つけたとき, then the BRW shall 違うパスを取り除かず、取り除いたパスと残したパスの一覧、および復旧の手順を表示する。取り除きの直前から完了までのごく短い間の書き込みは検出できないため、復旧用の参照を残してその手順を案内する。
13. When `--carry` が実行されたとき, the BRW shall 未追跡のファイルを移さず、移さなかったファイルの一覧を表示する。ただし未登録の宣言ファイルは、既存の `brw create` の挙動どおり移す。

### Requirement 2: Bash 以外の入口も BRW の手順に収束させる

**Objective:** As a 開発者, I want git コマンド以外の方法でも BRW を迂回できないようにしたい, so that どの入口から作っても命名規則と分岐元が守られる

#### Acceptance Criteria
1. When エージェントが BRW 導入済みのリポジトリで EnterWorktree を `name` 指定で実行しようとしたとき, the BRW shall 操作を拒否し、`brw create <名前>` を実行した後に `EnterWorktree` を `path` 指定で呼ぶ 2 手を自然文で案内する。
2. When EnterWorktree が `path` 指定で、BRW が配置先に作成した worktree を指しているとき, the BRW shall 操作を許可する。
3. If EnterWorktree の `path` が、BRW が作成した作業ブランチの worktree でないとき, then the BRW shall 操作を拒否し、`brw resume` などの手順を案内する。
4. If EnterWorktree の入力から対象を確定できないとき, then the BRW shall 規則に適合すると確認できるまで操作を止め、判定できなかった理由を表示する。
5. When 判定の対象となる入口が増えたとき, the BRW shall 同じ判定規則と同じ案内の書式で処理する。
6. If EnterWorktree の `path` が旧置き場の worktree を指しているとき, then the BRW shall 操作を拒否し、旧置き場のパス、新しい配置先のパス、利用者が行う移動の手順を表示する。

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
5. The BRW shall 利用者向けの資料に、配置先が `<本体>/.worktree/` であること、旧置き場の worktree を利用者が手で移す手順（BRW は自動で移さない）、導入先で `.worktree/` を無視する設定が必要なことを記載する。

### Requirement 7: 作業場所の配置先を、特定のエージェントに依存しない 1 か所にする

**Objective:** As a Claude Code や Codex など複数のエージェントを使う開発者, I want 作業ブランチの worktree が特定のエージェントの名前を持たない 1 か所に作られてほしい, so that どのエージェントからも同じ場所の作業場所を使える

#### Acceptance Criteria
1. When `brw create` が worktree を作るとき, the BRW shall リポジトリ本体の作業ツリーの直下の `.worktree/<別名>` に作る（別名は従来の規則）。
2. When `brw resume` がリモートまたはローカルのブランチから worktree を作るとき, the BRW shall リポジトリ本体の作業ツリーの直下の `.worktree/<別名>` に作る。
3. While 本体以外の worktree の中から `brw create` または `brw resume` が実行されている, the BRW shall 配置先を本体の `.worktree/` にし、worktree の中に入れ子の配置先を作らない。
4. The BRW shall 旧置き場の配下を、置き換え・EnterWorktree の許可・`brw resume` の既存の worktree の再利用の判定で、BRW の配置先として扱わない。
5. If `brw resume <ブランチ>` の対象ブランチが旧置き場の worktree で使用中であるとき, then the BRW shall worktree を作らず、旧置き場のパス、新しい配置先のパス、利用者が行う移動の手順を表示して拒否する。
6. When `brw finish`（`--merged` を含む）の対象のブランチの worktree が旧置き場にあるとき, the BRW shall その worktree とブランチを片付けず、対象外であることと、利用者が移す・手で片付ける手順を表示する。
7. While 旧置き場に worktree が残っている, the BRW shall 他のブランチに対する `brw create`・`brw resume` を妨げない。
8. When `--carry` や置き換えの案内で未追跡のファイルの一覧と件数を示すとき, the BRW shall 配置先の配下を含めない。
9. The BRW shall 導入先の `.gitignore` と共通の除外設定を、配置先の変更のために書き換えない。

