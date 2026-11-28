# Codex 実機検証の記録（2026-11-28）

- 総合判定: NO-GO（必須の全テストが終了コード 1。失敗の所有元は未確定）
- 要件 7.4 の実機観測: MANUAL_VERIFY_REQUIRED（前提となるセッションを完了できず未観測）
- 対象: ローカルに保存された `origin/dev/discovery-push-enforcement` の `4ca6f96f294eacc38a1f095a3d6f242800e582b6`。`main` の `bd2c9b8` には要件 7 がなく、検証対象は後者ではない。遠隔への問い合わせは名前解決に失敗したため、対象が現在の遠隔最新版かは未確認。
- 適用版: チェックアウトのプラグイン定義は 1.3.0、cc-sdd-bootstrap の設定は 3.1.0。対象の保存済み参照のプラグイン定義も 1.3.0。実際に Codex で BRW プラグインが導入・有効・信頼済みであることは未確認。
- 対象 spec は `spec.json` で要件・設計・タスクが未承認、`feasibility.md` の設計とタスク計画は未通過。タスクはチェック済みだが、承認・実機観測の不足は解消されていない。

## 今回の観測

- 対象の Git archive を `/tmp/brw-validation-20261128` に展開し、`tests/real-env/resume-observe.mjs --stage codex` を `BRW_REAL_ENV=1`、独立した結果ディレクトリ、Codex CLI 0.172.0、Node.js 22.16.0 で実行した。既存の手順はローカル bare remote と偽の gh・SSH を使い、GitHub に接続しない。認証のコピーは一時ホームを使い、実行後に削除された。
- 既定の 420 秒で応答がないため一度中断し、今回の一時コピーだけのターンのタイムアウトを 30 秒に変更して再実行した。結果 `/tmp/brw-validation-observation/observe-96b-codex.json` は timeout=true、完了ターン 0、hook 0 件、PR 0 件、receive-pack 0 件。2 ターン目は実行されておらず、スクリプトが案内と resume を「不一致」と出力したことは機能の動作不良の観測ではない。片付け、再開記録、案内のモデルへの到達、同じ作業の再開はすべて未観測。
- 同じ参照の既存の 9.9 記録では、別の実行で Codex workspace-write と `--add-dir` の下、`brw pr` の tidy 中に Node.js の Git 起動が EPERM となり、PR 作成と片付けに到達しなかった。直接の `git status` は成功したと記録されている。今回の再試行では Git 起動まで到達しておらず、この EPERM を再現したとは言えない。
- 現環境は外側にネットワーク制限と workspace-write 制限がある。直接の `codex exec` は内部 app-server 初期化時に `Read-only file system` で終了した。既存観測スクリプト内の Codex は 30 秒でタイムアウトし、原因は特定できていない。
- 実 GitHub: `git ls-remote origin refs/heads/main` は名前解決に失敗、`gh auth status` は両アカウントの認証が無効と報告。GitHub の書き込み・設定変更はしていない。

## 機械検証とレビュー

- 対象の `node tests/selftest.mjs` は終了コード 1。5 件の FAIL を表示後、355 行の空のフック出力の JSON 解析で中断したため全体は未実行。現環境の Node.js `spawnSync` は `git --version` と `node --version` の両方で status 0 と error `EPERM` を同時に返した。各 FAIL の製品側原因は未確定であり、全テストが通ったとは言えない。
- CLI の `resume --help` は実際に起動して使い方を返したが終了コード 2。完全な正常起動と機能の通し確認を示す smoke としては不十分。
- 独立レビュー: 指定の読み取り専用の Claude 経路は `UserPromptSubmit` の `Unexpected end of JSON input` により入力を停止し、レビュー本文を返さなかった。Codex への代替経路は app-server 初期化の読み取り専用エラーで終了コード 1。独立レビューは未実施。
- 境界・要求対応・設計整合の全体監査は未完了。GO に必要な全テスト、実機 smoke、要求網羅、統合、設計整合、独立レビューの証拠は揃っていない。

## 再実施条件

Codex の app-server とモデル通信が利用でき、使い捨てリポジトリで Node.js から Git の子プロセスを起動できる環境を用意する。最新の対象参照と実際の BRW 適用版・フック信頼を確認し、対象の `tests/real-env/README.md` 9.9 に従ってタイムアウトを既定に戻して実行する。片付け後の記録、同一 thread の次入力での案内出力とモデルへの到達、対応する単独 `brw resume` の前後状態・終了コードを照合する。全テストと独立レビューを再実行し、未承認の spec と実現性判定を所定の手順で解消してから最終判定する。

## 権限修正後の再試行（2026-11-28）

- 遠隔読み取りに成功。`main` は `c484052d38b1e5e0db77f7b67f4d26f06deee755`、対象ブランチは `4ca6f96f294eacc38a1f095a3d6f242800e582b6`。両者の tree は `81964b1669d5ab4f8662ebaba813bca607468b7b` で一致する。遠隔のプラグイン定義は 1.3.0。GitHub の認証は有効と確認。実 GitHub への書き込みは行っていない。
- 外側の権限を使うと Node.js からの Git 起動に EPERM は発生しない。対象と同じ tree の一時コピーで `node tests/selftest.mjs` は終了コード 0、末尾は「すべて成功」。全ログは `/tmp/brw-validation-elevated-selftest.log`。`node /tmp/brw-validation-20261128/scripts/brw.mjs resume` は終了コード 0 で再開候補と使い方を表示した。
- 元の 420 秒のタイムアウトに戻した `BRW_REAL_ENV=1 BRW_REAL_ENV_DIR=/tmp/brw-validation-retry node tests/real-env/resume-observe.mjs --stage codex` は終了コード 0、同一 thread で 2 ターン完了、20 件のフックを記録した。両ターンの thread ID と UserPromptSubmit、PR 実行前の PreToolUse の session ID は一致し、PreToolUse の cwd は対象 worktree と一致した。
- ただし内部の Codex `workspace-write` サンドボックスでは `spawnSync("git", …)` が `error.code=EPERM`・`status=0` を返し、`brw pr` は作業ツリーを読めず tidy で停止。直接の `git status` は成功した。外側の権限修正だけでは内側の起動制約は解消しなかった。実際の syscall 等の詳細な原因は未特定。
- PR 作成 0 件、receive-pack 0 件。片付けと再開記録は発生せず、2 ターン目の UserPromptSubmit は案内を返さなかった。前提が未成立のため、案内と `brw resume` の通し動作については未観測であり、要件違反とも成功とも判定しない。観測の原本は `/tmp/brw-validation-retry/observe-96b-codex.json`。
- 今回の独立レビューは別提供元が観測ファイルの読み取りを拒否され、同じ提供元の読み取り専用経路でも再実行した。結果は後記。

**今回の最終検証:** 全テストと CLI の一覧起動は通過。要件 7.4 の実機での片付け後の案内と再開は未観測であり、spec.json の要件・設計・タスクは未承認、feasibility.md の設計とタスク計画は未通過。総合は `MANUAL_VERIFY_REQUIRED`。必要な環境は、Codex の `workspace-write` 内で Node.js が Git を正常に起動できること。観測条件を整え、既存の 9.9 手順と独立レビューを実行した上で再判定する。

### 独立レビューの結果

同じ提供元の読み取り専用 Codex レビューを実施した。結論は `MANUAL_VERIFY_REQUIRED`。PR 作成前に EPERM で止まった観測では要件 7.4 の案内・再開を判定できず、Codex 内の Git 起動条件を整えた再観測が必要とした。PoC の個別の根拠と Codex の公開から再開までの通しの証拠を区別し、要件・設計・タスクの未承認と実現性の未通過を確認した。複数セッションが重なる場合の誤案内は要件 7.6 の明示された許容例外であり、削除済み作業場所から開始したセッションは案内が保証されないことも確認した。
