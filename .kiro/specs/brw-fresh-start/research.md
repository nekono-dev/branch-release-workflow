# Research & Design Decisions: brw-fresh-start

## Summary
- **Feature**: `brw-fresh-start`
- **Discovery Scope**: Extension（既存の `brw create` / `brw resume` の入口に前段を足す）＋外部の動作に依存する新しい汎用部品。実機検証あり（`poc/design_01.md`〜`design_03.md`）。
- **Key Findings**:
  - Claude プラグインの `claude plugin update` は **版の文字列**で更新を判断する。`plugin.json` の版を上げずにコミットだけ進めても `up_to_date`（すでに最新）と答える。最新の判定はコミットで行う必要がある。
  - 配布元に届かないとき、`claude plugin update` は終了コード 0 のまま「すでに最新」と答える（`marketplace update` は終了コード 1）。`update` の結果だけでは最新を確認できず、BRW 自身が最新を取得して、取得できなければ中止する必要がある。
  - 更新は実行中の操作に反映されない（CLI が「Restart to apply」と明示）。更新の後は同じプロセスで続けず、更新後の導入先のスクリプトを起動し直して続ける。
  - プロジェクト単位のプラグイン操作は、実行したカレントディレクトリのプロジェクトに作用する。別のディレクトリから実行すると、そこを新しいプロジェクトとして登録する副作用が出る。
  - git の clone は、`ls-remote --symref` → `fetch` → `merge-base --is-ancestor` で判定でき、`merge --ff-only` で更新できる。未コミットの変更が衝突する場合、git は更新を拒否し、何も壊さない。

## Research Log

### Claude プラグインの最新の判定と更新
- **Context**: 要件 1.8・2.1・2.2・2.4・3.1・3.3（実現性の前提 1・2・6〜9）。
- **Sources Consulted**: `claude plugin update --help`（Claude Code 2.1.329）、分離環境での実測（`poc/design_01.md`）、`~/.claude/plugins/installed_plugins.json` と `known_marketplaces.json` の実物（形式の確認。内容は記録しない）。
- **Findings**: `poc/design_01.md` の 1〜8。要点は上の Key Findings のとおり。導入の記録の形式（`version: 2`、`gitCommitSha`）は Claude Code の内部ファイルであり、公開された契約ではない。
- **Implications**: 現在のコミットは導入の記録から読み、形式が想定と違えば「判定できない」で中止する。更新は `marketplace update` → `plugin update` → 効かなければ入れ直し、の順にする。

### git の clone の最新の判定と更新
- **Context**: 要件 1.8・1.9・2.1・2.2・2.6・2.7（前提 3・4）。
- **Sources Consulted**: 一時リポジトリでの 9 状態の実測（`poc/design_02.md`）。
- **Findings**: 判定と更新のコマンドの組が期待どおり動く。固定（detached HEAD）は既定ブランチへ移して更新できる。開発ブランチが先端を含まないときは fast-forward できず、自動の解消はしない。
- **Implications**: 自動で行うのは fast-forward と、固定された clone の既定ブランチへの切り替えだけ。マージ・リベースは行わず、中止の案内に手順を示す。

### 待ち時間の上限
- **Context**: 要件 3.5（前提 6）。
- **Sources Consulted**: Node.js 22.16.0 の `child_process.spawnSync` の `timeout`、実測（`poc/design_03.md`）。
- **Findings**: 応答しない相手でも上限で確実に打ち切れ、`ETIMEDOUT` で判別できる。
- **Implications**: 通信を伴う外部コマンドは、すべて期限つきの実行ラッパーを通す。

### 更新中のコードの差し替え（前提 5）
- **Context**: 実行中のスクリプトが更新で書き換わっても安全か。
- **Sources Consulted**: コードの確認（`scripts/` に動的 import は無い。`grep "import("` が 0 件）、`poc/design_01.md` の 8。
- **Findings**: 静的 import は起動時に読み込みが終わる。ただし同じ版のキャッシュは入れ直しで上書きされる。
- **Implications**: 外部の動作に依存しない設計にする。更新の後は同じプロセスで続けず、必ず起動し直す（旧コードが更新後のファイルを読む場面を作らない）。

## Architecture Pattern Evaluation
| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 戦略（配布の形ごとの部品）＋共通の流れ | 判定・更新・中止と案内の流れは 1 つ。配布の形（git の clone・Claude プラグイン）ごとの部品を差し込む | 要件 4（汎用）と 2・3（同じ振る舞い）を 1 つの流れで満たす。形の追加が局所的 | 部品の契約を安定させる必要 | 採用 |
| BRW の `brw.mjs` に直接書く | create / resume の先頭に BRW 専用の処理を足す | 最小 | 要件 4（BRW を知らない汎用部品）を満たさない | 却下 |
| 独立した外部ツール（別リポジトリ）にする | 最新化を別の配布物にする | 完全に独立 | この仕様の範囲（BRW 内の入口）を超える。導入の手間が増える | 却下 |

## Design Decisions

### Decision: 最新の判定はコミットで行う
- **Context**: `plugin.json` の版は、コミットごとには上がらない（実物でも 1.3.0 のまま複数のコミットが配布されている）。
- **Alternatives Considered**: 1) 版の文字列の比較、2) コミットの比較。
- **Selected Approach**: コミットの比較。版を上げ忘れても古い版を最新と誤認しない。
- **Rationale**: PoC の 3 のとおり、版の比較だけでは誤認する。
- **Trade-offs**: 更新手段（`plugin update`）が版を見るため、版が同じだと効かない。入れ直しの経路を持つ。
- **Follow-up**: 設計後の実装で、入れ直しの経路を、ユーザー単位・プロジェクト単位の両方で試験する。

### Decision: 更新の後は必ず起動し直す
- **Selected Approach**: 更新に成功したら、更新後の導入先の起動スクリプトを、元の引数のまま子プロセスで実行し、終了コードをそのまま返す。起動し直しの後も古いとき（更新が効かなかった）は、再度の更新はせず中止する。
- **Rationale**: 実行中のコードの差し替えを避け（前提 5）、要件 2.3・2.4 を 1 つの仕組みで満たす。
- **Trade-offs**: 子プロセスの 1 段が増える。フック・スキルの定義は、Claude の再起動まで更新前のまま（案内に出す）。

### Decision: 生成物の置き場は `scripts/fresh-start/` に閉じる
- **Selected Approach**: 汎用部品を 1 つのディレクトリにまとめ、ディレクトリの外を import せず、Node.js の標準モジュールだけで動かす。BRW 固有の差は `scripts/brw-fresh.mjs` が与える。
- **Rationale**: 要件 4.1・4.5・4.6・4.7。ディレクトリごと別の製品へ複製して使える。閉じていることは自己テストで検査する（import の範囲、特定の製品名の不在）。
- **Trade-offs**: 複製して使う他の製品は、更新の取り込みを自分で行う（この仕様の範囲外）。

### Decision: 試験用の抜け道は設けない
- **Context**: 要件 1.7（省く手段を提供しない）。既存の試験は `brw.mjs create` / `resume` を子プロセスで起動する。
- **Selected Approach**: 試験は、一時の配布元（bare リポジトリ）とその clone に `scripts/` などを置いた「試験用の配布 clone」を作り、その clone の `brw.mjs` を起動する。最新と判定されるため、通信なしで通る。環境変数やオプションで確認を省く仕組みは作らない。
- **Trade-offs**: 試験の支援部品（`tests/support/dist-fixture.mjs`）と、既存試験の起動先の差し替えが要る。
