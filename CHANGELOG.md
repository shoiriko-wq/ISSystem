# 改訂履歴（CHANGELOG）

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
