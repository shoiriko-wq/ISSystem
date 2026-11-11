
# Agent Rules

## Tool Usage
- Always use available tools (read, edit, bash, grep, glob, write) for file operations.
- Never guess file contents. Always read files before editing.
- Use tools proactively and verify results.
- Do not output raw source code in chat; use edit/write tools instead.

## 作業の約束（10条）
1. **設計文書**: `README.md`（運用・UI十条・禁则・検証手順＝正典）を最初に読む。`ISSystem仕様書.md` は「現行実装基準」なので**作業対象の該当節だけ**読む（全文を読む義務はない）。実装が仕様から逸脱しないようにする。
2. **ドキュメント同期**: 挙動・UI・API・制約を変えたら `README.md` と `ISSystem仕様書.md` を同じコミットで更新する。`CHANGELOG.md` は人間が指示して更新する。文書の文言一致を機械検査はしない（`verify-docs` は被覆・寸法・機能・Git追跡だけを検査する）。
3. **UI 十条**: 正典は `README.md` の「UI十条」10項目（AGENTS.md に書き写さない）。要点は枠2px実線1枚／モーダル中央・余白10px・`max-height:90dvh`・内部スクロール／入力の7条件／ホバーで1pxリング＋3px浮き／色60〜70%彩度・35%明度・コントラスト4.5以上／Webフォント（font-family 直書き禁止）／画面常時スクロール禁止／左サイドバー常時収納＋せり出しオーバーレイ／操作説明文は常設しない／小学生日本語。
4. **日本語**: ドキュメント・コードコメント・UI文言は小学生にも分かる日本語（英英対訳禁止）。
5. **検証は階層式（開発中は該当分だけ・コミット前に全ゲート）**:
   - 開発中: 変えた層に対応するテストだけ回す。サーバー側は `npm run test:one -- test/<該当>.test.js`（`--runInBand` 直列・`pretest` を踏まない＝DBを作り直さない）。UI・レイアウト・ボタン・カード・枠・フォームは該当 UI スイートを1〜3本（README の検証表）。「CSS・JSを読むだけで通ったことにしない」— 寸法・位置・描画を px で実測する。
   - 機能単位のコミット・リリース直前: `npm test` → `npm run api:check` → `npm run test:ui:all` → `node scripts/verify-docs.mjs` をこの順序で直列に通す。
   - Jest は常に1プロセス直列（`--runInBand`）。全テストが同一DB `issystem` を共有するため、複数 Jest を並列実行するとテーブル・レコードが衝突して落ちる（落ちた時に「DBのテーブル・レコードを消せ」とは言わない — 原因は並列実行、`pretest` がDBを作り直す）。UIスイートは同じサーバー・同じDBを使い、テストが投稿・既読・fixture を作る。前実行の残りで後スイートが失败することがあり、`npm run db:seed` で状態を戻して再実行する（DB破壊はしない）。UI テストは `npm start`（HTTPS/WSS 3443・CA配布は `.env` の `PORT`）が起動している状態で実行し、サーバー側を変えたらサーバーを再起動してから回す（古いコードに当たって偽の失敗が出る）。
6. **ゲートの合否はコード起因の失敗 0 で判定する**: `test:ui:https` の CA 信頼項目は OS 信頼ストアに `certs/issystem-ca.crt` を一度だけ登録する人間作業（npm script に `NODE_EXTRA_CA_CERTS` を埋め込まない、テストは `ca: [certs/issystem-ca.crt]` を明示）。UI の残存状態と `.env` の `PORT` のズレは設定・状態の問題として人間に確認して片付ける。UI の日付系項目はサーバーが JST 壁時計を書くことで揃う。
7. **UI テストの追加・更新**: 新機能は既存 `scripts/test-*.mjs` の該当スイートに項目を追加して検証してよい（新規スイートも可。全ゲートの実行時間が増えるため統合・整理も許す）。追加スイートは npm script を作り `npm run test:ui:all` に登録する（verify-docs が被覆を検査）。仕様変更時は既存テストの期待値・選択器・トースト文言を現実に合わせて更新する。**テストの削除・スキップ・無効化は禁止**。
8. **サイドバー契約**: 寸法・せり出し・`main` 追従・色分けの正典は `README.md` §UI十条8項と `public/css/layouts.css` §6（AGENTS.md に寸法を書かない）。`verify-docs` が CSS と README の寸法一致（67.25px・16.3rem・`is-focus`）を検査する。変えたら `test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:frames` を回して px 実測する。
9. **サーバー変更の API スモーク**: 起動済みサーバー（`npm start`＝HTTPS 3443）に `npm run api:check`（`scripts/api-smoke-test.js`）を通す。
10. **リポジトリ衛生**: 検証用一時成果物（`data/`、`ui*.txt`、`t*.txt`、`vd*.txt`、`api*.txt`、`mail-*.txt`、`prompt.txt`、`health.json`、`audit-resolve.json`、`nohup.out`、`*.tmp`、`tmp-probe.mjs`、`scripts/tmp/`）はコミットしない（`.gitignore` に登録済み）。`verify-docs` が Git の追跡状態を検査する。

## 実装・検証コマンド
- 開発中の単スイート: `npm run test:one -- test/<該当>.test.js`（`--runInBand` 直列・`pretest` を踏まない＝DBを作り直さない）
- 全ゲート: `npm test`（`pretest` がDBを作り直し、Jest を直列）→ `npm run api:check`（サーバー起動後）→ `npm run test:ui:all`（31スイート・実測1スイート6〜32秒＝全体で約10分）→ `node scripts/verify-docs.mjs`（被覆・寸法・health・Git追跡を検査）
- UI スイート個別: `test:ui:frames` / `test:ui:modal` / `test:ui:chrome` / `test:ui:contrast` / `test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:chat` / `test:ui:mail` / `test:ui:exambasic` / `test:ui:seating` 他（README の検証表）
- 状態リセット: `npm run db:seed`（UIスイートの残りを掃除して再実行。DB破壊はしない）
- 旧全体チャット撤去マイグレーション: `npm run db:drop-general-chat`

## 禁则（UI契約）

UI契約の禁止事項（影・多層枠・常時スクロール・font-family直書き・操作説明常設・モーダル契約・入力の7条件・色・せり出し寸法）は `README.md` の「UI十条」と「禁则（UI契約の禁止事項）」が正典。AGENTS.md は重複を書かない。ここに書くのは運用上の2項目だけ:

1. `!important` はレイアウト寸法の確定に使う（`layouts.css` §6 のサイドバー寸法と `chat.module.js` のレイアウト修正）。色・影・装飾の上書きには使わない
2. 旧全体チャット（`general` / `PUBLIC`）への投稿・参照・フォールバック禁止（v3.1.2 で撤廃済み。参加グループのみがチャット単位）

## 禁则（実装・検証の禁止事項）

1. Jest の複数プロセス並列実行禁止（共有DB `issystem` の衝突）。テスト失敗時に「DBのテーブル・レコードを消せ」と言わない（DB破壊禁止。`pretest` がDBを作り直す）
2. `NODE_EXTRA_CA_CERTS` を npm script に埋め込まない（CA信頼は人間環境で一度だけ登録し、テストは `ca: [certs/issystem-ca.crt]` を明示）
3. 職員全体チャット general は全廃済み。コード・テスト・fixture に痕跡を残さない
4. チャットは発言者以外が読み書きする。server 側で `facilities.chats` の members を検証し、発言者以外の参加・発言・既読更新を server 側で拒否する
5. メールはメールタブのメールボックス（IMAP/SMTP）だけを扱う。外部メールサービスのAPIに接続しない
6. 教務と校長の2ロール以外を作らない（管理者などの追加権限禁止）
7. 検証の階層（第5条）を省略・並列化しない — 開発中は該当スイート、コミット前は全ゲート。UIテストは px 実測で通す（CSS・JSを読むだけで通ったことにしない）
