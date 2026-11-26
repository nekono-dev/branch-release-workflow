# 調査記録と設計判断: sync-base-branch

## 概要
- **機能**: `sync-base-branch`
- **調査の範囲**: 拡張（既存の判定への追加）。軽量の調査（`design-discovery-light`）を実施した。外部ライブラリの追加は無いため、技術の検証は git の挙動の実機確認に限る。
- **主な発見**:
  - 取り込みの判定は、字句の解析（`scripts/operation-policy.mjs`）と可否の判定（`scripts/operation-decision.mjs` の `evalMerge`）の 2 か所に閉じている。フック（Claude・Codex）と `brw guard` は、どちらも同じ `evaluateAll` を呼ぶため、判定を直せば 3 経路に同時に効く（要件 5.1・5.2）。
  - `git fetch origin main:main` は、更新先がローカルのブランチになりうるため `unparseable` に分類され、確定不能として止まる。許可するには、この分類に新しい形を足す必要がある（要件 1.2）。
  - `git pull` の取り込み元は取得前の状態では確かめられない。fast-forward の保証は git 自身の `--ff-only`（または同等の設定）に任せるのが確実である（下記）。

## 調査ログ

### git の fast-forward 限定の挙動（実機確認、2026-11-26、使い捨てのリポジトリ）
- **背景**: 要件 1 は fast-forward だけの更新を許可する。BRW が実行前に確かめられる範囲を決める必要がある。
- **確認した事実**:
  - `git pull --ff-only origin main` と `git merge --ff-only origin/main` は、履歴が分岐していると `fatal: Not possible to fast-forward, aborting.` で止まり、手元を変えない。`pull.ff=only` の設定でも同じ。
  - 指定なしの `git pull` は、履歴が分岐していて設定が無いと `fatal: Need to specify how to reconcile divergent branches.` で止まる。ただし `pull.ff`・`pull.rebase` などの設定によっては、マージコミットやリベースを作る。設定は実行時に変わりうる。
  - `git fetch origin main:main` は、`main` を確認していない作業ツリーなら fast-forward で更新できる。分岐していると `! [rejected] main -> main (non-fast-forward)` で止まる。`main` をどこかの worktree で確認していると `fatal: refusing to fetch into branch 'refs/heads/main' checked out at ...` で止まる。先頭の `+` が無い refspec は強制更新にならない。
  - `git merge-base --is-ancestor <手元> <取り込み元>` で、手元の先端が取り込み元の祖先か（fast-forward になるか）を、取得済みの追跡ブランチに対して確かめられる。
- **含意**:
  - fast-forward の保証は、実行時の git に任せる。BRW は「保証が付いた形」だけを許可する: `--ff-only` の明示（または `pull.ff=only`・`merge.ff=only` の設定）、`+` を付けない fetch の refspec。
  - `--ff-only` が無い `git pull` は、基底ブランチへは許可しない。拒否の案内に `--ff-only` を添える。
  - 分岐していて fast-forward にならないことは、取り込み元の ID が確定している `git merge` では実行前に祖先関係で確かめられる。`pull` と `fetch` は取得前なので確かめられず、git が止める（手元は変わらない）。

### 取り込み元の分類
- **確認した事実**: `mergeSource`（`operation-policy.mjs`）は、`git merge origin/main` を `{ remote: "origin", branch: "main", oid }` に解く。`git pull origin main` は `{ remote, branch }`（oid なし）に解く。`classifyBranch`（`lib.mjs`）は、ブランチ名を base・protected・development・undeclared に分ける。
- **含意**: 追跡ブランチの分類は、`remote` が `origin` であることを足すだけで書ける。pull の refspec が `main:main` の形（`:` を含む）だと、取り込みとは別に手元のブランチを更新しうるため、この形は許可の対象から外す。

### 既存テストと表示
- **確認した事実**: `tests/decision.mjs:127` は `git pull origin main` を `dev/foo` 上で拒否することを期待している。本仕様で許可に変わるため、期待を更新する。`hook-diagnose.mjs` には、判定の限界を人に示す一覧（`over-detection` など）がある。
- **含意**: pull と fetch の限界（取得前は分岐を確かめられない）は、この一覧に載せる。

## アーキテクチャパターンの評価

| 案 | 概要 | 長所 | 限界 | 判断 |
|----|------|------|------|------|
| 判定の拡張（採用） | `evalMerge` に許可条件を足し、字句解析に必要な事実（ff 指定・rebase・fetch の更新先）を足す | 変更が 2 ファイルに閉じる。3 経路に同時に効く | 判定関数が長くなる | 同じ分類・案内の仕組みを再利用できる |
| 専用コマンド `brw sync` | 取り込みを BRW のコマンドに集約し、素の `git pull` は拒否のまま | 抜け道が増えない | コマンドが増え、他のエージェントや呼び出し側が BRW を知る必要がある | 範囲外（brief） |
| 事前に `git fetch` して祖先を確認 | 判定中に取得し、分岐を実行前に確かめる | 分岐を確実に拒否できる | 判定がネットワークに依存し、副作用を持つ | 却下。判定は読み取りのみの原則に反する |

## 設計判断

### 判断: fast-forward の保証は git に任せ、BRW は保証が付いた形だけを許可する
- **背景**: 取得前は分岐を確かめられない（`pull`・`fetch`）。
- **検討した案**: (1) 判定中に取得して祖先を確認する。(2) `--ff-only` の明示を必須にする。(3) 指定なしでも、その時点で fast-forward になるなら許可する。
- **採用**: (2)。`merge` は取り込み元の ID が確定するので、加えて祖先関係を実行前に確かめる。
- **根拠**: (1) は判定に副作用とネットワークを持ち込む。(3) は設定（`pull.rebase` など）と取得の後の状態に左右され、判定と実行の間で結果が変わりうる。(2) は同じ入力が常に同じ判定になる（要件 3.3）。
- **トレードオフ**: `--ff-only` を付け忘れた `git pull` は一度拒否される。拒否の案内で、付けて再実行するよう示す。
- **後続**: 要件 1.1・1.3・1.4 は、この「保証が付いた形」と、実行前に確認できる分岐の拒否で実現する。

### 判断: fetch による更新は `merge` の操作として表す
- **背景**: `git fetch origin main:main` は、現状 `unparseable`（確定不能）に分類される。
- **検討した案**: (1) 新しい操作の種類（例: `ref-update`）を足す。(2) 既存の `merge` の操作に `via: "fetch"` を付けて表す。
- **採用**: (2)。取り込み先（`branch`）・取り込み元（`sources`）・種別（`mode: "fetch-update"`）を持たせる。
- **根拠**: 判定の結果の種類（`kind`）が増えると、フック・`brw guard`・診断の分岐が増える。取り込みと同じ「取り込み先と取り込み元の分類」で判定できる。
- **トレードオフ**: `kind` が `merge` でも実体は fetch になるため、案内の文面を `via` で出し分ける。

### 判断: 取り込み元のリモートは `origin` の名前だけを許可する
- **根拠**: 要件の確認で決定済み。fork などの別のリモートは、内容を確かめる手段が無く、従来どおり拒否する。`origin` の名前は固定とし、宣言に設定を足さない。

## リスクと対策
- **`--ff-only` の付け忘れによる拒否の増加** — 拒否の案内に付け方を書く。`SKILL.md` に取り込みの手順を書く。
- **設定による挙動の変化**（`pull.rebase=true` など）— `pull` は設定の `pull.rebase`・`branch.<名前>.rebase` も読み、リベースになりうる場合は許可の条件を満たさないものとして扱う。読めない設定は確定不能として止める。拒否の理由に、使った設定のキーと値を示す。
- **基底を別の作業ツリーで確認している** — `git fetch origin main:main` は git が止める（実機で確認）。案内で `git -C <その作業ツリー> pull --ff-only origin main` を示す。
- **判定と実行の間で履歴が動く** — fast-forward の保証は実行時の git が持つため、判定の後に履歴が動いても基底ブランチにマージコミットは作られない。
- **`-c` による設定の上書き** — `-c pull.ff=...` などは既存の規則で確定不能になり、止まる（変更なし）。

## 参考
- 手元の実機確認（上記）。外部の資料は参照していない。
