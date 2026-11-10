# ISSystem (職員室情報共有システム)

**仕様書の正典は `ISSystem仕様書.md`（v3.0.0）。** 本書は運用・コマンド・環境変数の手順書。仕様の全体像（層構成・API・Socket・DB 51テーブル・RBAC・セキュリティ既知課題）は仕様書側を参照。

校務支援バックエンド。Express + PostgreSQL 18 + Socket.io + Cron によるリアルタイム職員室共有システム。

## 動作環境

- Node.js 20+ (開発環境: v24)
- PostgreSQL 15+ (開発環境: 18.6, `C:\Program Files\PostgreSQL\18`)
- npm

## セットアップ

```bash
npm install
npm run db:create   # issystem データベースを作成
npm run db:init     # db/schema.sql を適用 (全テーブル + インデックス)
npm run db:seed     # ダミーデータを一括投入
npm run cert:gen    # プライベートCA + サーバー証明書生成 (.env と同じ階層の certs/)
npm start           # HTTPS/WSS は SSL_PORT (既定 3443)、PORT (既定 3000) はCA配布専用
```

## プライベートCA と安全通信 (HTTPS / WSS)

メール機能を含む全通信は TLS で暗号化する。サーバーは2つのポートを持つ:

| ポート | 内容 |
| --- | --- |
| `SSL_PORT` (既定 3443) | HTTPS/WSS によるアプリ本体・API・Socket.io（サーバー証明書はプライベートCAで署名） |
| `PORT` (既定 3000) | 非安全 HTTP。**CA証明書のダウンロードページ専用に固定**。アプリ画面は提供せず API は `426 Upgrade Required` で拒否 |

- `npm run cert:gen` が `certs/` に発行する: ルートCA `issystem-ca.crt`（秘密鍵 `issystem-ca.key`、**SAN なし＝`CA:TRUE` のみ。信頼は指紋で使う**）、サーバー証明書 `server.pem` + 鍵 `server.key`（**SAN 付き**＝`localhost, issystem.local, issystem, 127.0.0.1, ::1` ＋ `SSL_HOSTS` の IPv4。CAにサーバ証明書を提示するため WSS でも検証可能）。`issystem-ca.pem` は `.crt` と同一内容。`SSL_DIR` / `SSL_HOSTS` は `.env` から読む（シェル環境変数が優先）。
- **LAN 端末が `https://<IP>:3443` を開くには、その IPv4 を `SSL_HOSTS`（証明書 SAN）に含める必要がある。** Chrome/Edge/Safari は SAN 不一致を「クリックして続行」不可で拒否するため、`http://<IP>:3000`（CA配布ページ＝TLS なし）は繋がり `https://<IP>:3443` だけが繋まらない、という症状になる。IP は DHCP 予約で固定する。
- 再発行: `npm run cert:gen -- --server-only`（既存ルートCAを再利用しサーバー証明書のみ再署名。**端末の信頼ストア設定は有効のまま**。SAN 変更時の推奨）／ `npm run cert:gen -- --force`（CA も交換 = 全端末で CA 再インストールが必要）。
- **端末の信頼ストアに `certs/issystem-ca.crt` をインストール**するとブラウザのアドレスバーで「安全な接続」として開ける。Windows はダブルクリック →「信頼されたルート証明機関」、macOS は「常時信頼」。この設定はユーザー環境で一度だけ行い、npm script に環境変数を埋め込まない。Node からのアクセス（テストスクリプト）は `ca: [certs/issystem-ca.crt]` を明示的に渡して検証する（`api-smoke-test.js` は信頼ストアを使う）。
- **非HTTP (`http://` や `ws://`) でアクセスしてきた相手には CAダウンロードページ (`/ca`) が表示される。** ページには SHA-256指紋、OS別のインストール手順、ダウンロードリンク、`https://HOST:SSL_PORT/` へ移動するボタン、サーバーと同じ機械で開くための `https://127.0.0.1:<SSL_PORT>/` の案内がある。アプリ画面や API は返らない。HTTPS の `/ca` も同じページ（指紋とダウンロード）で利用可能。
- 設定は `.env` の `SSL_PORT` / `SSL_HOST` / `SSL_DIR` / `SSL_KEY` / `SSL_CERT` / `SSL_CA` / `SSL_HOSTS` / `SSL_CA_PAGE_BASE`（`PORT` は CA配布専用ポート）。
- 検証: `npm run test:ui:https`（CA検証（ルートCAは `CA:TRUE` と指紋・サーバー証明書は SAN）・TLSハンドシェイク・CAページ表示・API 426・CAダウンロード・ブラウザ wss 接続・非HTTP ws 拒否の 27項目）。

### .env の設定

| キー | 内容 | 備考 |
| --- | --- | --- |
| `DB_PASSWORD` | PostgreSQL の接続パスワード (`otome601`) | **アプリのログインパスワードとは別物** |
| `JWT_SECRET` | JWT 署名シークレット | `config/default.js` の `auth.jwtSecret` と同一値が必要 |
| `SSL_PORT` | HTTPS/WSS ポート | 既定 3443。アプリ・API・Socket.io はこのポートのみ |
| `SSL_HOST` | HTTPS/WSS の監視ホスト | 既定 `0.0.0.0` |
| `SSL_DIR` / `SSL_KEY` / `SSL_CERT` / `SSL_CA` | 鍵と証明書のパス | `.env` と同じ階層の `certs/`（`npm run cert:gen` が生成。Gitには入れない） |
| `SSL_HOSTS` | サーバー証明書のSANホスト | 既定 `localhost,issystem.local,issystem,127.0.0.1,::1`。**LAN 端末が使う IPv4 を必ず含め、変更後は `npm run cert:gen -- --server-only`（CA 再利用）で再署名する** |
| `SSL_CA_PAGE_BASE` | 非HTTPで CAページを見た際の安全URL基点 | 例 `https://127.0.0.1:3443`。「安全接続で開く」ボタンを作る |
| `PORT` | 非安全 HTTP (CA配布専用) ポート | 既定 3000。アプリは提供せず API は 426。CAページは `/` と `/ca` |
| `MAIL_IMAP_HOST` / `MAIL_IMAP_PORT` | 受信 (IMAP) サーバー初期値 | 未設定ユーザーのフォームプリフィルと未入力保存時のフォールバック。**Git に入れない実値は `.env` だけ** |
| `MAIL_SMTP_HOST` / `MAIL_SMTP_PORT` | 送信 (SMTP) サーバー初期値 | 同上。143 / 25 は STARTTLS、993 / 465 は TLS 直結として扱う |
| `MAIL_TIMEOUT_MS` | 接続テストのタイムアウト | 既定 12000 ミリ秒 |

### アカウントのパスワード2系統

- **DBパスワード**: `otome601` → PostgreSQL 接続専用 (`psql`, `db:create` など)
- **アプリのログインパスワード**: `password123` → `scripts/seed.js` の教職員アカウント共通パスワード。教職員番号 `T2026001` (教務主任) などでログイン

```bash
# psql を使う場合（Linux 現行環境）
PGPASSWORD='otome601' psql -h localhost -p 5432 -U postgres -d issystem

# 旧 Windows 開発環境（パスに psql が無い）
# $env:PGPASSWORD='otome601'
# & 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h localhost -p 5432 -U postgres -d issystem
```

## メール接続テスト

- メールタブでメールアドレスとパスワードを入力し「接続テスト（保存前に試す）」を押すと、**保存せずに**その入力値で IMAP / SMTP へ実接続テストを行う。フォームの「接続設定を保存する」後にヘッダーの「接続テスト」を押すと、保存済み設定（DB に AES-256-GCM で暗号化保存されたパスワード）でテストし、成否を `status` (VERIFIED / FAILED) とヘッダーバッジへ反映する。
- 実装は `src/services/mail.transport.js`。`node:net` / `node:tls` のみを使い、IMAP は `STARTTLS → LOGIN`、SMTP は `EHLO → STARTTLS → AUTH LOGIN` を確認する。新規 npm 依存は増やさない。
- 校内サーバーの証明書は CN 不一致・自己署名が多いため `rejectUnauthorized: false`（SNI の servername は送る）。証明書の厳密検証は行わない。
- API: `POST /api/mail/test`。body に `password` とフォーム値を送れば未保存設定のプレテスト（DB 書き込みなし）、空なら保存済み設定でテストし `status` を更新して監査ログ `MAIL_CONNECTION_TEST` を残す。
- 検証: `npm run test:api:mail-test`（Jest 6項目・存在しない `issystem.example` 宛てなので接続は必ず失敗し、`status=FAILED` と成功系はプローブ差し替えで検証）と `npm run test:ui:mail`（ブラウザ 37項目）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm start` / `npm run dev` | サーバー起動 (HTTPS/WSS + Cron + CA配布用HTTP) |
| `npm run cert:gen` | プライベートCAとサーバー証明書を生成（既存があればスキップ。`--force` で再発行） |
| `npm test` | jest 統合テスト (12スイート / 150テスト、stack 秘匿 4項目 (error.middleware) + bcrypt ハッシュ非露出 (auth 8c) 含む。各スイートで pg プールを close するため `--forceExit` 不要) |
| `npm run api:check` | API スモークテスト (HTTPS の GET/POST/PUT/DELETE を実行しステータスを検証) |
| `npm run test:socket-auth` | Socket 接続権限検証 (tokenless / garbage / demoトークン / 外部Origin の拒否、KYOMU・ADMIN gate、ロック自保持限定、chat メンバーシップ、職員全体グループが一覧に出ないことの 21項目。サーバー起動後に実行。Node 側通信は `ca: [certs/issystem-ca.crt]` を明示) |
| `npm run test:rbac` | RBAC 権限検証 (`/api/users` 一覧のロール別最小化・追加 KYOMU のみ role=TEACHER 固定・削除 ADMIN のみ、招待コード発行 KYOMU/ADMIN、チャンネル削除 KYOMU/ADMIN の 17項目。TEACHER の権限昇格は 403。サーバー起動後に実行) |
| `npm run test:ratelimit` | ログイン・招待コード レート制限検証 (不存在ユーザー 25 回失敗ログインで 401×5→429×20、失敗ログインの `LOGIN_FAILED` 監査記録、招待コード 128bit=32文字16進大写、架空コード 5 試行→429、使用済みコード 400、ADMIN 後片付けの 8項目。ユーザー単位ロックアウト 423 は `test/auth.test.js` で検証。サーバー起動後に実行) |
| `npm run test:logsecurity` | ログ秘匿・保持検証 (404 レスポンスに stack なし、失敗ログイン 401 がアクセスログ `data/logs/access-YYYY-MM-DD.log` に記録、ログディレクトリ mode 700、アクセスログファイル mode 600、アクセスログに bcrypt ハッシュなし、ADMIN 監査 API に `LOGIN_FAILED`、監査 JSON にハッシュなし、レート制限 6回失敗=401×5+429×1 の 9項目。サーバー起動後に実行) |
| `npm run test:api:mail-test` | メール接続テスト API 検証 (Jest `test/mail.test.js` 6項目) |
| `npm run test:api:mail-defaults` | メール初期値 (.env プリフィル・Git 秘匿) API 検証 (12項目) |
| `npm run test:ui:mail` | メール UI 検証 (初回設定・プリフィル・接続テスト・受信箱の 37項目) |
| `npm run test:ui:exambasic` | 定期考査 基本情報「3. 科目 × 実施クラス・コース」の列幅・チップ配置検証 (実施数列なし / 科目名14%・略称8% / チップ内容分63% / はみ出し0 / チップクリック・Shift範囲選択・保存反映の 4ビューポート 38項目) |
| `npm run test:ui:examaddtop` | 考査 基本情報の「行の追加」が最上部・未入力の行1件だけ・ボタン無効（未入力の行の top が先頭：実測 487px < 保存済み行 552px < 末尾行 2426px / 行追加で画面がスクロールしない `main.scrollTop` 0→0 / ボタン disabled+aria-disabled / 2回押しても31件のまま / 保存 201→ボタン復活 / 未入力の行の削除 200→ベースライン復元 / 部屋 8→9→8 / 科目 9→10→9 / クラス 30→31→30 / 学年順＋名前順不変。クラス名は初期29名固定・学年内重複不可（409）・初期の行は削除不可（使用中の行の「削除」は使用状況照会後 DELETE 非送信、初期名の直接 DELETE は 409）の 22項目） |
| `npm run test:ui:bulletin-search` | 職員掲示板の全日検索 UI 検証 (タイトル・本文・投稿者名を全日で検索して左列が対象日見出し付きの全日の列表になる / タイトルの `<mark>` ハイライト・件数「N 件」・行の対象日チップ / 中心日表示は「全日」になり ‹ ›・本日・日付クリック（カレンダー開閉）は disabled（data-day は維持・固定幅なので › の位置は動かず） / 結果クリックは中心日を動かさず右ペインに全文 / 検索ピルは存在しない / ←/→・T・C キーは停止 / ミニカレンダーの検索該当枠と日付セル disabled（合成クリックでも中心日は動かない） / 検索語クリアで通常表示とナビが復帰・投稿者名検索・後片付けの 23項目) |
| `npm run test:ui:news-share` | ダッシュボード「記事を共有」UI 検証 (「すべて見る」撤廃 / 共有モーダルの開閉とURL入力 / **モーダルの中身は記事URL入力欄だけ（常設説明文なし＝`p` 0・本文はラベル「記事URL *」だけ。補完規則はプレースホルダーと `title` のみで伝える＝UI十条9・禁则6）** / **URL入力の7条件を computed style で実測（type・id・name・`autocomplete=off`・`aria-label`・`label[for]`・`border-main` 2px実線＝UI十条3・禁则8）** / URL空・不正の拒否 / スキーマ無しの `https://` 補完 / 職員チャットへ `【記事共有】+ドメイン名+URL` の2行投稿（**投稿先は閲覧中の職員チャットチャンネル**＝チャットサイドバー `.active` と一致、URL入力欄のみ・チャンネル選択なし）/ サーバー実データへの登録 / 背景クリック・ESC・閉じるボタン・アイコン描画の 20項目) |
| `npm run test:ui:chat` | 職員チャット UI 検証 (「再通知」ボタン・`handleRenotifyAll`・再通知 API 廃止 / 未読者一覧トーストと既読更新 / 投稿直後の未読数（メンバー数-1）/ サーバー配信の未読名簿 / 別メンバー閲覧で未読 1 減 / リロード後の未読数一致 / 「目のマーク」非表示モードの連動 / メタの左右整列（相手=左からアイコン・名前・日時、自分=右から）/ ホバー時のプルダウンメニュー（実マウスで押せる・レイアウトシフトなし）/ **サーバーのチャンネル一覧は参加グループだけ（タイプは GROUP / DM / WORKFLOW のみ＝職員全体グループは0件。実測 types は `GROUP` と `WORKFLOW` のみ）** / **サイドバーのグループ行は参加グループだけ（行のIDはサーバーのグループ一覧の中に入り・「全体」の文字なし＝v3.1.4、実測 names「📋 教務部連絡」「🧭 進路指導連絡」+作成グループ）** / 検証用グループの削除後片付け。Node 側は `ca: [certs/issystem-ca.crt]` で TLS を通す) |

| `npm run test:ui:fx` | ダッシュボード労いカード（粒子アニメーション）＋開発・QA 用プレビューパネル UI 検証 (落下・上昇距離がカード高さ実測の `--fx-drop` に比例し ResizeObserver で再計算 / 年休等・出張の「記入する」ボタン撤廃 / パネルは常時表示され開閉バーが残る / テーマセレクト（自動+全13）と前・次で粒子テーマとモーションが切替 / 静的スウォッチ 13 (prefers-reduced-motion でも確認) / 疑似日付 2026-12-24→サンタ+クリスマスイブ文・季節セレクト（冬→夏）で季節文が即時切替・時刻帯5・曜日7・特別な日 13 期間ウィンドウ（年始 1/1–1/3・仕事始め 1/5–1/6・3学期始業式 1/7–1/9・3学期終業式 3/23–3/24・新年度 4/1–4/3・1学期始業式 4/8–4/10・1学期終業式 7/17–7/20・2学期始業式 9/1–9/3・クリスマス 12/23・12/24・12/25・2学期終業式 12/26–12/28・年末 12/29–12/31。セレクトは期間表 `DASH_EVENT_PERIODS` から自動生成）がすべて出る / 期間ウィンドウ算法（年度で ± 日がずれる学校の節目を期間で捕捉し同じ文を 3 日前後表示：疑似日付 2026-04-08・2026-04-10→第1学期始業式文+桜、2026-01-08→3学期始業式+紙吹雪、2026-03-24・2026-07-17→終業式+紙吹雪、2026-12-27→第2学期修了+サンタ、2026-12-29→大掃除+雪）/ 全メッセージセレクト（4組31文）で選んだ文がそのまま出る / 校内行事カードの見出しは「本日の校内行事」（「今日の」表記は出ない） / 復帰で全セレクト自動・実日時へ / `--fx-drop` ≥ カード高さ / 390px で横スクロールなし・全コントロールに label.for と枠線 / 人数タイルのクリックと Enter で年休等・出張の登録・確認モーダルが開きフィルタが効く（記入フォームはモーダル内常設、件数ラベル n名、bindAbsenceTile は件数非依存＝0名表示のタイルでもクリックで開く）/ 梅雨は降り注ぎ系 `fx-rain`（絵文字は傾き固定・回転なし・進行方向は下。JS が粒子ごとに 14〜24deg の `--fx-tilt` を振り、keyframes の角度は全 keyframe 同一、Y が 20%→50%→80% で単調に下がることを deg と px で実測）/ 瞬き系（陽光・日傘・海・お正月・夜の星）は粒子ごとに inline の top を 4% + i*7% + 0〜5% の帯で振って枠全体に広がる（CSS の top:8% はフォールバック。枠高249px で top 実測 30〜180px（8.8〜68.6%）、上端と下端の差 149〜150px（枠高さの60%）、下半分に4個、keyframes 50% の最下点 200px は枠内、全10粒子が枠内を px で実測）の 54項目) |
| `npm run test:ui:unread` | ダッシュボード「本日の連絡」未読バッヂ UI 検証 (カードは対象日が本日の掲示のみ・未読マーカーは未読カードのみ・ヘッダー右バッヂ＝本日未読 / カードクリックで `PUT /api/bulletins/:id/read` と本日バッヂ 1 減・マーカー消去・サイドバーとタイトルバッヂ連動 / カードクリックでタブ移動もモーダル開閉なし・既読カードの再クリックは API を叩かない（冪等） / サイドバー（数字のみ）＝タイトル（未読 N）＝全日未読 / 客户端キャッシュ 100 件未読はサイドバー 99+・タイトルとダッシュボード 未読 99+（擬似キャッシュで再現。100 を出さない、実キャッシュ復帰でバッヂが実データへ追従 / 登録日より古い記事（対象日=本日・掲示期間本日有効でも）と掲示開始前記事は未読バッヂに数えない / 後片付けの 17項目。テストはCAPSIM擬似キャッシュ中心で実 DB は本日記事と登録日前記事のみ) |
| `npm run test:ui:sidebar-push` | サイドメニューせり出し時の main 追従 UI 検証 (≥1100px はせり出し幅 285.25px に main の padding-left が追従し重なりなし (ホバー・is-focus のみ両経路、カーソル/フォーカス離脱で収納復帰)、768〜1099px はオーバーレイ維持 (main padding 不変)、500px は画面下バー・せり出しなしの 12項目) |
| `npm run test:ui:https` | 安全通信検証 (CA検証 / TLS / CAページ / API 426 / CA配布 / ブラウザ wss) |
| `npm run rotate:mail-key -- OLD_JWT_SECRET=<旧> (OLD_SECRET=<旧MAIL_ENC_SECRET> も可)` | mail_accounts の AES-256-GCM キーローテ (sha256(旧JWT) / scrypt(旧MAIL_ENC_SECRET) で暗号化された行を新 MAIL_ENC_SECRET 基準の scrypt キーへ再暗号化。再暗号化後にサーバー再起動) |
| `npm run db:create` / `db:init` / `db:seed` | DB 作成 / スキーマ適用 / ダミーデータ投入 |
| `npm run db:drop-general-chat` | 職員全体チャット撤廃 (v3.1.2) の既存DB移行: `chat_channels` から `general` / `chat-all` / `all` を DELETE（関連する `chat_messages` / `chat_message_reads` / `chat_channel_members` は ON DELETE CASCADE で連動削除。削除件数と残存チェックを表示） |
| `npm run db:tables` | コード内参照テーブル名の一覧表示 (スキーマ整合チェック) |

## テストスイート

`test/helpers.js` に共通ヘルパー (`loginToken`, `bearer`, `pickId`, `closePool`) があります。

| ファイル | 内容 |
| --- | --- |
| `test/auth.test.js` | ログイン、`/auth/me`、招待コード発行 (201)、招待登録、新規アカウントでのログイン、消費済みコード 400・既存教職員番号 409、誤パスワード 401、トークンなし 401、8c bcrypt ハッシュ非露出（console.warn インターセプト、`$2b$` 系パターン検出） |
| `test/error-middleware.test.js` | stack トレース秘匿: production では stack なし、development + ループバックのみ stack あり、development + 外部 IP では stack なし、404 ApiError に stack なし (4項目) |
| `test/facility.test.js` | 施設一覧、日別概要 (`facilitiesOverview`)、予約作成 201、**重複時間帯 409**、予約一覧、キャンセル、`start>=end` は 400、キャンセル後の再予約、施設マスタ CRUD (教務部限定・同名 409・有効予約残 409)、並び順 `PUT /api/facilities/order` |
| `test/approvals.test.js` | 一覧、申請作成 201、詳細、承認処理 (`APPROVED`)、無効ステータス 400、存在しない ID 404 |
| `test/bulletins.test.js` | 一覧、詳細 (確認率 `ack_percentage`)、投稿作成 201、件名・本文欠落 400、コメント、既読、電子承認、不存在 404 |
| `test/chat.test.js` | チャンネル一覧（general / PUBLIC が無いことも確認）、メンバー一覧 (`chat_channel_members`)、チャンネル作成 201、メッセージ投稿、取得、既読、削除、**非メンバーのグループ閲覧 403**（v3.1.2 職員全体チャット撤廃）、撤廃した `general` 削除 404、**職員全体タイプ指定（`type: 'PUBLIC'`）は `GROUP` へ寄せられる**（v3.1.4 サーバー側ホワイトリスト）、チャンネル名欠落 400 |
| `test/invitation.test.js` | 招待コード発行 (トップレベル `code`)、新規登録、招待コードによるパスワード再設定、旧パスワード 401、消費済みコード 400、未登録教職員番号 404、8文字未満/項目欠金 400、`used_for` (REGISTER / PASSWORD_RESET) |
| `test/exam.test.js` | 考査マスタ CRUD、教科・スロット・時間割セル、監督者配置、部屋割りのブロックソルバー、禁止時間帯、検証 API |
| `test/absence.test.js` | 欠席・早期帰・遅刻の作成・一覧・修正・削除と期間集計 |
| `test/schedules.test.js` | 学校日程の作成・年月一覧・当日取得・削除とカテゴリマッピング |
| `test/mail.test.js` | メール設定保存・初期値プリフィル・接続テスト API (`status` VERIFIED/FAILED) (6項目) |

## UI十条（UI契約）

1. 見出し・カード・枠は 2px の実線を1枚（`border-main`）。影・グラデーション・影文字は使わない
2. モーダルは画面中央・余白10px・`max-height:90dvh`・内部スクロール・`max-width` 上限・閉じボタン
3. 入力は `type`・`id`・`name`・`autocomplete`（新規 `new-password`／既存 `username`）・`aria-label`・`label for`・`border-main` の7条件
4. 操作できる要素はホバーで周りに1pxリング＋3px浮き＋影（影はリング目的のみ、背景は変えない）
5. 色は60〜70%彩度・35%明度の単色、コントラスト比4.5以上（`npm run test:ui:contrast` / `test:ui:chrome`）
6. 文字は「Noto Sans JP + Tencent Sans」Webフォント、font-family 直書き禁止
7. 画面の常時スクロール禁止（`100dvh`・`overflow:hidden`、コンテンツは内部スクロール）
8. 左サイドバーは常時収納（768px以上は画面幅を問わず 67.25px・アイコンのみ正方形タイル）。ホバリング（`:hover`＋JS `is-hover`）とフォーカス（JS `is-focus`）で 16.3rem（285.25px）へせり出し、`#app-body` 内のオーバーレイとしてラベルを幅0から真横へ現す。1100px以上では `main` の `padding-left` がせり出し幅へ追従し重ならない。767px以下は画面下バー（アイコンのみ、ホバリングでも文字を出さない）。収納時とせり出し時は寸法・位置を px（rem 併記）で実測し、余白・隙間・縮小・見切れ・ラベルの縦移動・斜め移動がないことをスクリーンショットと数値で確認する。せり出しで行の高さを変えないため、アイコンの初回クリックが吸収されずタブが切り替わる。色分け（青=選択・緑=有効・赤=削除・黄色=未完了）、枠（`border-main` 2px・角丸0）、影（ホバリング目的の1種のみ）を守る（検証: `test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:frames`）
9. 操作説明文は画面に常設しない（トースト・`title`・プレースホルダーのみ）
10. 説明文・コメントは小学生にも分かる日本語（英英対訳禁止、コードは日本語コメント）

## 禁则（UI契約の禁止事項）

1. 影（影文字・背景影・グラデーション）禁止 — 影はホバリング目的のみの1種のみ
2. 枠の多層描画禁止 — 実線1枚のみ、太さ2px
3. 画面全体の常時スクロール禁止
4. 説明文・コメントの英語表記禁止（日本語で書く）
5. font-family 直書き禁止（Webフォント運用）
6. 「〜してください」等の操作説明を画面内に置く慣例禁止
7. モーダルの高さ上限なし・余白なし中央寄せ禁止
8. 入力の `label`・`aria-label`・`autocomplete` 省略禁止
9. `!important` 上書き禁止（`chat.module.js` のレイアウト修正は例外）
10. 旧全体チャット（`general` / `PUBLIC`）への投稿・参照・フォールバック禁止（v3.1.2 で撤廃済み。参加グループのみがチャット単位）

## 禁则（実装・検証の禁止事項）

11. テストの削除・スキップ・無効化は禁止（仕様変更時は既存テストの期待値・選択器・トースト文言を現実に合わせて更新する）
12. UIテストは寸法・位置・描画を px で実測して通す（CSS と JS 阅读だけで「通った」にしない）
13. UI十条（正方形タイル・px・余白・色分け・ホバリングせり出し・main 追従・初回クリック・スクリーンショット実測）を守る
14. `NODE_EXTRA_CA_CERTS` 環境変数を npm script に埋め込まない（CA信頼はユーザー環境で一度だけ登録し、テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）
15. DB破壊禁止 — テストが失敗した時に「DBのテーブル・レコードを消せ」と言わない（共有DBの衝突が原因。`pretest` が DB を作り直す）
16. 職員全体チャット general は全廃済み。コード・テスト・fixture にテストを一般（general）チャットへ変更した痕跡を残さない
17. チャットは発言者以外が読み書きする。server 側で `facilities.chats` の members を検証し、発言者以外の参加・発言・既読更新を server 側で拒否する
18. メールはメールタブのメールボックス（IMAP/SMTP）だけを扱う。外部メールサービスのAPIに接続しない
19. 教務と校長の2ロール以外を作らない。追加の権限（管理者など）を禁止
20. 検証の省略禁止 — 実行順序（`npm test` → `api:check`（サーバー起動後）→ `test:ui:all` → `verify-docs`）を省略・並列化しない

## 検証の実行順序と制約

検証は **`npm test` → `npm run api:check`（`npm start` 起動後）→ `npm run test:ui:all` → `node scripts/verify-docs.mjs`** の順で、どれも省略しない。

- `npm test` は `pretest`（`scripts/init-db.js` + `scripts/seed.js`）でDBを用意し、Jest を `--runInBand`（1プロセス直列）で走らせる。全テストが同一DB `issystem` を共有するため、**複数 Jest を並列実行するとテーブル・レコードが衝突して落ちる**。落ちた時に「DBのテーブル・レコードを消せ」とは言わない（DB破壊は禁止、原因は並列実行）。
- UI テスト（`scripts/test-*.mjs`・`puppeteer-core`）は `https://localhost:3443` を自己起動（起動済みなら再利用）し、描画・寸法・位置を数値で実測する。CA信頼はユーザー環境で一度だけ登録し、npm script に `NODE_EXTRA_CA_CERTS` を埋め込まない（テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）。
- APIスモーク `npm run api:check`（`scripts/api-smoke-test.js`）は `npm start`（HTTPS/WSS 3443・監視 `0.0.0.0`）が起動している状態で実行する。
- テストの削除・スキップ・無効化は禁止。仕様変更に伴い既存テストの期待値・選択器・トースト文言を現実に合わせて更新する。

## 認証フロー

1. 教員は `staff_code` + パスワードで `POST /api/auth/login` → JWT を取得
2. 教務主任等は `POST /api/auth/generate-invitation` で招待コード (24時間有効 / レスポンスのトップレベルに `code` と `expiresAt` を返す) を発行
3. 招待コードは発行時点で利用目的が確定しない。受け取った教職員がログイン画面で「新規登録（招待コード）」または「パスワード再設定」を自分で選ぶ
4. 新規教員は `POST /api/auth/register-invitation` (招待コード + 教職員番号 + パスワード) で登録 → 登録直後に JWT が返る
5. パスワード忘れは `POST /api/auth/reset-password-invitation` (招待コード + 教職員番号 + 新しいパスワード8文字以上) で再設定 → 再設定直後に JWT が返る。未登録の教職員番号は 404
6. 招待コードは `invitation_codes` テーブルで管理され、消費後は再利用不可 (400)、既存教職員番号の再登録は 409。消費した目的は `used_for` (REGISTER / PASSWORD_RESET) に記録される

## 主要 API

- `/api/auth` … ログイン、招待コード発行、招待コードによる新規登録、招待コードによるパスワード再設定、プロフィール、パスワード変更、在席状態更新
- `/api/facilities` … 施設一覧、日別予約一覧、予約作成 (時間帯重複は **409 Conflict**)、予約キャンセル
- `/api/bulletins` … 掲示板投稿 CRUD、既読/承認、コメント
- `/api/chat` … チャンネル作成、メッセージ投稿/取得、既読、メンバー一覧 (`chat_channel_members`)
- `/api/approvals` … 決裁申請の作成・一覧・詳細・処理
- `/api/schedules`, `/api/seating`, `/api/exams`, `/api/audit`, `/api/users`, `/api/news`

## スキーマ上の重要テーブル

`users`, `invitation_codes`, `posts`, `bulletin_attachments`, `bulletin_comments`, `post_acknowledgements`, `chat_channels`, `chat_channel_members`, `chat_messages`, `chat_message_reads`, `seating_status`, `resources`, `reservations`, `facility_cells`, `basic_rooms`, `approvals`, `school_schedules`, `schedule_categories`, `schedule_category_map`, `audit_logs` (90日保持), `system_audit_logs`, `editing_locks` (3分TTL), `classes`, `subjects`, `curriculum_subjects`, `curriculum_courses`(運用廃止・表のみ), 考査系22テーブル (`exam_masters`, `exam_phases`, `exam_slots`, `exam_subject_plan`, `exam_subject_decisions`, `exam_trips`, `exam_timetable_rules`, `exam_proctor_rules`, `exam_room_rules`, `exam_rooms`, `exam_room_config`, `exam_room_assignments`, `exam_parttime_staff`, `exam_parttime_availability`, `exam_slot_history`, `exam_teacher_constraints`, `exam_teacher_exemptions`, `exam_proctor_assignments`, `exam_commands`, `exam_block_shapes`, `exam_block_groups`, `exam_block_conditions`), `absence_records`, `mail_accounts`, `mail_messages`（**全51ユニークテーブル / 52 CREATE TABLE（`invitation_codes` 二重定義）/ 77インデックス**。詳細と分類表は `ISSystem仕様書.md` §9。`npm run db:tables` でコード参照との整合確認可）

座席レイアウトは `seating_status` + `facility_cells` から導出、考査ステータスは `exam_masters` から導出するため専用のレイアウト/ステータステーブルは存在しない。教育ニュース (`/api/news`) は外部RSS＋インメモリキャッシュであり DB 永続化しない (意図された設計)。

## 開発メモ

- 二重予約判定は `toDateTime()` で `HH:MM` を `YYYY-MM-DD HH:MM:SS` に正規化して比較
- システムメッセージの `sender_id` は FK 制約のため、`resolveSenderId()` で `system` ユーザーへ変換
- `ensureSchema()` はプロメモ化され、複数プロセスからの同時適用による「pool closed」を防止
- スモークテストは `npm start`（HTTPS 3443）でサーバーを起動してから `npm run api:check` を実行する（`scripts/api-smoke-test.js` が `API_BASE` 既定の `https://127.0.0.1:3443/api` を叩く。証明書は `npm run ca:create` で作成し Windows の証明書ストアに信頼設定済み。`NODE_EXTRA_CA_CERTS=./certs/issystem-ca.crt` を付与してもよい）
- **職員全体チャット（general / `PUBLIC`）は撤廃済み（v3.1.2・2026/11/9）**: チャットチャンネルは個人が作成したグループのみ（`type` 既定 `GROUP`）。閲覧・送信・既読更新・参加はすべて `chat_channel_members` のメンバーシップのみで判定される（PUBLIC の抜け道なし）。seed は 3 グループ（`grade1` / `kyomu` / `suisin`）だけを作り、既存 DB の旧全体チャンネルは `npm run db:drop-general-chat` で撤去する。フロント (`chat.module.js`) はグループ未作成時に空状態メッセージ「表示できるグループがありません」を描画し API を叩かない（`showEmptyChannelState()`）。ダッシュボード「記事を共有」の投稿先は閲覧中のグループ（未作成時は送信せず警告トースト）。**API 作成の `type` ホワイトリスト（v3.1.4・2026/11/9）**: `POST /api/chat/channels` は `GROUP` / `DM` 以外の指定（`PUBLIC`・`PRIVATE`・`ALL` 等の架空タイプ）を `GROUP` へ寄せる（`chat.service.js` の `ALLOWED_USER_TYPES`。全体グループを作らせない）。フロントのグループ行アイコンは `users` のみ（`PUBLIC` の `globe` 分岐は撤去）。検証: `npm run test:socket-auth`（21項目。職員全体グループが一覧に出ないことを実測）と `test/chat.test.js`（`type: 'PUBLIC'` 指定が `GROUP` へ寄せられることを確認）、`npm run test:ui:chat`（サイドバーのグループ行が参加グループだけ＝行IDに `general` なし・「全体」の文字なし、サーバー一覧に `general`・全体タイプ 0件）
- **ダッシュボード「記事を共有」モーダルの中身は記事URL入力欄だけ（v3.1.3・2026/11/9）**: モーダル本文は `label[for="news-share-url"]` と URL 入力欄だけ（常設の操作説明文 `<p>` は置かない＝UI十条9・禁则6。「https:// を補完する」等の説明はプレースホルダーと `title` とトーストだけで伝える）。URL入力欄は入力の7条件（`type=url`・`id`・`name=news-share-url`・`autocomplete=off`・`aria-label=記事URL`・`label for`・`border-main` 2px実線）を満たす（禁则8）。検証は `npm run test:ui:news-share`（20項目）

