# 改訂履歴（CHANGELOG）

- 2026-11-13 (メール 42): メール受信を**サーバー側 cron へ移し、受信ボックスが変化した時だけ WSS で通知**した（クライアント側の自律受信 `setInterval` は廃止。従来はメールタブ表示中にクライアントが 60秒周期で自走し、タブ非表示で停止していた）。
  - 変更点（実装）: `src/utils/cron.jobs.js`（152行）に `mailPollCronPattern()`（既定60秒=`0 * * * * *`、最小15秒）と受信ジョブを新設。`src/services/mail.service.js`（771行）の `pollAllInboxes(io)` が `src/models/mail.model.js`（294行）の新関数 `listAllAccounts()` で全設定アカウントを IMAP 受信して DB へ幂等に保存し、スナップショット（key = 件数+未読数）と比べて変化したアカウントの所有者だけ `user:<id>` ルームへ `mail:new_messages`（added・unread・total・newest_subject・newest_sender）を送る。初回 poll は基準値の記録のみで通知せず、連続5回（`MAIL_POLL_MAX_FAILURES`）失敗したアカウントは poll 状態をリセットして停止（到達不能サーバーへ毎分再接続しない）。
  - 変更点（クライアント）: `public/js/modules/mail.module.js`（955行）から `POLL_MS`・`pollTimer`・`startPolling`・`stopPolling` を撤去し、`bindMailSocket()` と `applyMailSocketUpdate(payload)` で受信一覧カードの中身だけを差し替え、`#mail-box-count`・`#mail-inbox-count`・アカウントタブ未読 span（id を付与）を更新する。タブ面と一覧コンテナのノードは作り替えない（Animation 再発火なし）。
  - 変更点（設定）: `config/default.js` と `.env.example` に `MAIL_POLL_INTERVAL_MS=60000`・`MAIL_POLL_MAX_FAILURES=5` を追加。
  - 変更点（テスト）: `test/mail.test.js` に6テスト追加（初回pollは通知しない・受信ボックスはDBへ保存・件数変化で通知・1件追加でdelta・WSS 通知経路の実測・連続失敗5回で停止し受信成功で復帰・cron周期生成）。全ゲート `npm test` は**12スイート167テスト全通過**。`scripts/test-mail-setup.mjs` に WSS 通知テスト2項目（受信一覧がDB最新へ更新／一覧コンテナとタブ面のノードが無傷＝マーカー実測）を追加し**54項目 ALL PASS**（`npm start` 稼働下で実行）。
  - 仕様書（§7.6・§8.2・§10・§12・§17・§18 改訂履歴 v3.1.11、§15.2 と §16 の行数）と `README.md`（環境変数2項目、自動受信の項、テスト項目数）を同じコミットで更新。

- 2026-11-10 (考査 41): 考査「基本情報の登録」の「行の追加」を**いちばん上・未入力の行1件だけ・ボタン無効**へ変更し、無効時の見た目を全ボタン共通化、配置ルールを測る新規回帰テスト `scripts/test-exam-basic-add-top.mjs`（`npm run test:ui:examaddtop`）を追加。**検証状況（Windows 実測 2026-11-10）: 新規テスト 22項目通過（PASS 22・failure 0）、`npm test` 12スイート/150テスト通過（10.1秒、`pretest` でDB初期化＋シード）、`api:check` 50API呼び出し＋10検証マーカー通過（409二重予約と404存在しないコードは意図された応答、失敗0、サーバー稼働中 PID 29616）、`test:ui:all` の29スクリプトを Edge（`CHROME_PATH`）と `https://127.0.0.1:3443` で実測し 25スクリプト通過（PASSマーカー数: examaddtop 22・chat 41・facility 19・mail 38・exambasic 52・seating 20・schedule 43・block 4・sidebar 68・sidebar-push 12・nav 45 等）、4スクリプト失敗（https 9項目＝Windows のユーザーCA信頼未登録、unread 3項目・timeline 1項目・bulletin-unread 9項目＝PostgreSQL `NOW()` とホスト時計の1日差による日付依存項目）。`node scripts/verify-docs.mjs` は失敗0（NG 0）。`ui:audit`（13ビュー目視）は人間の確認待ち**。
  - 変更点（実装）: `public/js/modules/exam/exam.basic.ui.js` の `addRow` は新行を `tbody.prepend`（クラス30件・科目9件・部屋7件の表で末尾に足すと、書く場所が画面下のずっと下に移動して下へスクロールして書く羽目になるため、入力と保存の操作距離が最短の最上部へ）。追加直後に `main.scrollTop` を現在値へ戻し、画面常時スクロール禁止（UI十条7）を守る。未入力の行（`data-id` が空の行）が1件ある間は「行の追加」ボタンを `disabled`+`aria-disabled=true`（DOMクリックにも防御ハンドラ）とし、`isBlankRow` / `hasBlankRow` / `syncAddButton`（render 時に保存済み行が全行ならボタン復活）で状態を一元管理。未入力の行の「保存」がサーバー制約（クラス名は初期29名固定・学年内重複不可＝409 `クラス・コース「1-3」は 1年に既に登録されています`）に当たると 409 が返り未入力の行は残る＝ボタン無効のまま。未入力の行の「削除」は行をUIから破棄してボタン復活。説明文は常設せず `title`「未入力の行が1件ある間は使えない」と `aria-label` とトーストのみ（UI十条9）。
  - 変更点（CSS）: `public/css/components.css` のボタン無効時ルール（グレー一色・白抜き・影なし、ホバーでも動かさない）を `.btn-primary`/`.btn-secondary`/`.btn-danger` に加え `.btn-warning`（「行の追加」ボタンの色）と `.btn-success`（「保存」ボタン）へ拡張（`components.css` 1,604行 = 旧 1,572行）。
  - 変更点（テスト）: 新規 `scripts/test-exam-basic-add-top.mjs`（**22項目**）と `npm run test:ui:examaddtop`、`npm run test:ui:all` へ登録。テストの削除・スキップ・無効化なし、`pretest`（DB初期化＋シード）はテスト内で実行せず、サーバー稼働中（PID 29616、HTTPS 3443、監視 `0.0.0.0`）、DB破壊なし。
  - 新規テストの実測値: クラス表で未入力の行 top **487px** < 最初の保存済み行 **552px** < 末尾の行 **2426px**（最上部）、`main.scrollTop` **0→0→0**（画面スクロールなし）、ボタン `disabled=true`+`aria-disabled=true`、2回押しても行は **31件のまま**（未入力の行1件限定）、保存で **201** → 未入力の行消えてボタン復活、未入力の行の「削除」で **200** → 部屋 **8→9→保存201→削除200→8**、科目 **9→10→保存201→削除200→9**、クラス **30→31→409系→30**、学年順＋名前順は変更前后で不変。クラス名の制約も実ブラウザで実測（初期名「1-1」の重複保存 409、使用中の行「3-3」の「削除」は使用状況照会後に DELETE を送らない＝DELETE 1件なし、初期名「1-1」の直接 DELETE は **409**＝サーバー側で初期クラス行削除不可）。テストはセッショントークン（localStorage `is_system_jwt_token_v251`）で直接 DELETE を叩く項目を持つ。
  - テスト実行の実際（Windows）: `CHROME_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'`、`UI_BASE=https://127.0.0.1:3443`（IPv4）。スクリプトの CHROME 既定値を Edge（`C:/Program Files (x86)/...` と `C:/Program Files/...`）とし、`/usr/bin/google-chrome` / `/usr/bin/chromium-browser` は `CHROME_PATH` で上書き可能。`npm test` の総数は Windows 実測 **150**（12スイート直列 10.1秒）— 既存 CHANGELOG の 193 は旧 Linux 環境の項目数（README と仕様書は 150 に統一）。テストの削除なし。`test:ui:all` のスクリプト数（`package.json` 実測）は **29**。`npm run test:ui:examlogin` は `package.json` に存在しない（README の実行コマンド一覧は `package.json` と照合済み・欠落0）。UIスイートの実測で失敗した4スイートの原因は環境側（ユーザーCA信頼未登録と `NOW()` とホスト時計の1日差）で、コード側の崩れではない（`ui:audit` の目視確認と併せて人間の判断とする）。
  - 変更ファイル: `public/js/modules/exam/exam.basic.ui.js`（385行 = 旧 371行）、`public/css/components.css`（1,604行 = 旧 1,572行）、`public/index.html`（910行）、`scripts/test-exam-basic-add-top.mjs`（新規 213行）、`scripts/test-exam-basic-columns.mjs`（期待値を「末尾」→「最上部」へ更新 295行）、`package.json`（`test:ui:examaddtop` 追加、`test:ui:all` に登録）。`public/js/state.js`(106) と `public/js/api.js`(155) は変更なし。
  - 仕様書（§14 ファイル行数・§8.4 のUIスクリプト数・§15.2 の新規項目・§18 改訂履歴）と `README.md`（実行コマンド 1行追加、`npm test` 150テスト維持）を同じコミットで更新。

このファイルは「いつ・何を・なぜ変えたか」を小学生にも分かる日本語で記録する。実装を変えたら同じコミットで `README.md` と `ISSystem仕様書.md` も更新する（AGENTS.md 第2条）。CHANGELOG の更新は人間が指示する。

## [3.1.3] - 2026-11-09

- **テストの期待値を現実へ更新**（AGENTS.md 第10条）: `test-frame-rules.mjs` の R6 は「ラベルを `display:none` で隠す」を見ていたが、現実の設計はラベルを幅0（`max-width:0` + `opacity:0`）でレイアウトに残し、せり出しで幅が伸びて真横に現す。ラベルの表示幅が1px以下なら合格として実測で通した（`display:none` の切替は縦移動・斜め移動になるため使わない）。
- **CA検証を現実へ更新**: ルートCA証明書には `CA:TRUE` だけが入り、SAN は入らない（CA信頼は指紋で確立する）。`test-https-ca.mjs` は「ルートCAに SAN があること」を要求していたため失敗した。ルートCAは `CA:TRUE` と自己署名、SAN はサーバー証明書側（`127.0.0.1` / `localhost`）であることを検証する形へ変えた。
- **npm script から `NODE_EXTRA_CA_CERTS` を外した**: 9テストが CA信頼登録済みで動いていたため、環境変数による上書きを外した。テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す。
- **検証の順序と制約を明文化**（AGENTS.md 第12条、README、仕様書 §17）: `npm test` → `api:check`（サーバー起動後）→ `test:ui:all` → `verify-docs` の順、Jest は `--runInBand` 直列、共有DB衝突の警告、テスト削除禁止、スクリーンショットと px 実測、UI十条、CA・DB・チャット・メール・権限の禁则。
- **AGENTS.md と README のサイドバー記述を現実に同期**: 収納 67.25px（`width:67.25px !important`）、せり出し 16.3rem（285.25px）、`main` の `padding-left:4.2rem`（収納幅分の余白常時確保）と ≥1100px の追従、ラベル幅0、`is-hover`/`is-focus`。
- **検証ゲート `scripts/verify-docs.mjs` を拡充**: 検査項目 11 → 98（UI十条10項目、禁则20項目、AGENTS第4条・第12条、`pretest`/`--runInBand`、`test:ui:all` の全 puppeteer テスト inclusion、サイドバー寸法の CSS と文書の一致、APIスモークの全トップレベルAPI網羅、health 実測、仕様の4節、general 残存、CHANGELOG）。
- **npm script を2件接続**: `test:ui:block`（入れ条件グリッド 15項目）と `test:ui:sidebar-push` / `test:ui:schedule` を `test:ui:all` に追加（計26スイート）。
- **APIスモークを全セグメント網羅へ拡張**: 読取専用 GET で `/subjects` / `/basic-info` / `/mail/account` / `/exam-survey-status` / `/staff/pool` / `/external/news` / `/external/weather` / `/absences` を追加し、`verify-docs` が `src/routes/index.js` の全セグメントと突き合わせる。
- **梅雨のアニメーションを「降り注ぎ系」へ変えた**: 労いカードの梅雨テーマは桜・紅葉・雪と同じ落下系（絵文字が回りながら落ちる）共用だった。梅雨は進行方向を下へ向け、絵文字は傾き固定（粒子ごとに 14〜24deg。同日中は固定・翌日変化）で回転させない専用 keyframes `dash-fx-rain` を追加した（横漂移 9px、大きさは変えない、カード底に届いて消える）。JS は粒子ごとに inline の `--fx-tilt` で傾き角を振る。`scripts/test-dash-fx.mjs` は傾きが 14〜24deg で全粒子に収まること、進行中の 20%・50%・80% で角度が変わらないこと（実測 21deg）、Y が 55→138→220px と単調に下がること（`--fx-drop` 275px・カード高さ 249px）を deg と px で実測する（`npm run test:ui:fx` 46項目）。README と仕様書 §14 も同じ内容へ更新。

## [3.1.2] - 2026-11-09

- 職員全体チャット（general / `PUBLIC`）を全廃: `chat_channels` は `type` 既定 `GROUP`、server はメンバーシップのみで判定（PUBLIC 許容・フォールバック削除）、ダッシュボード「記事を共有」は閲覧中のグループへ送信（未作成時は警告トースト）、旧全体チャンネルは `npm run db:drop-general-chat` で撤去。
- チャット未読: `chat_message_reads` の `read_at` を「未読の最終更新」基準へ統一（`test:ui:unread` 12項目）、チャットメンバーシップ検証（`test:socket-auth`）。
- メール: 接続テスト `POST /api/mail/test`（6項目）、初期値プリフィル（12項目）。
- 権限: 2ロール（教務・校長）以外を作らない、`PUT /auth/me/online` は自身のみ、`editing_locks` はホワイトリスト行のみ、メールはメールボックスのみ。
- 監査4項目追加: `test:rbac`（17項目）、`test:ratelimit`（8項目）、`test:logsecurity`（9項目）。
- `npm run db:tables` コード参照整合チェック、`npm run ca:create`（CA信頼を1回だけ登録）、UI検証3スイート追加。

## [3.1.1] - 2026-11-08

- サイドメニュー収納（768px以上は画面幅を問わず常時収納・せり出しオーバーレイ・広幅で `main` 追従）、画面下バー（767px以下）。
- 施設予約タイムラインのヘッダー固定、スクロール・寸法の実測検証。

## [3.1.0] - 2026-11-07

- 全面 HTTPS/WSS（3443・自己起動）、CA検証スイート（27項目）、TLS制約（TLS1.2+）。
