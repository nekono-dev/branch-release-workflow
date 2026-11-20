<!-- cc-sdd-bootstrap:begin この区画は cc-sdd-bootstrap が管理する。手で書き換えると update で戻る -->
## cc-sdd の導入（セッション開始時）
- `.claude/skills/kiro-*` と `.kiro/settings/` は、セッションの開始時に `.cc-sdd-bootstrap.json` の版・言語で導入され、揃っていれば入れ直しを省く。
- 入れ直すときは `.claude/skills/kiro-*` を消してから導入するため、`kiro-` で始まる独自のスキルは置かない。
- 導入が完了していない（失敗・中断）と次の入力は止まる。理由が示される。Claude の外で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行して再試行する。新しいセッションを開いても再試行される。
- スキル一覧に載らないスキルは、対応する `.claude/skills/<名前>/SKILL.md` を Read して手順を最後まで実行する。`SKILL.md` が見つからないときは導入が完了していないと利用者に伝え、上の再試行を勧める。

## cc-sdd の標準の決まり
次の取り込みは、cc-sdd が生成する標準の決まりの文書で、セッションの開始のたびに入れ直すためコミットしない。

@.kiro/settings/cc-sdd-guide.md
<!-- cc-sdd-bootstrap:end -->
