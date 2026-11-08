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

- `npm run cert:gen` が `certs/` に発行する: ルートCA `issystem-ca.crt`（秘密鍵 `issystem-ca.key`、**SAN 付き**：localhost, issystem.local, issystem, 127.0.0.1, ::1）、サーバー証明書 `server.pem` + 鍵 `server.key`（同じ SAN。CAにサーバ証明書を提示するため WSS でも検証可能）。`issystem-ca.pem` は `.crt` と同一内容。再発行は `--force`。
- **端末の信頼ストアに `certs/issystem-ca.crt` をインストール**するとブラウザのアドレスバーで「安全な接続」として開ける。Windows はダブルクリック →「信頼されたルート証明機関」、macOS は「常時信頼」。Node からのアクセスは `NODE_EXTRA_CA_CERTS=./certs/issystem-ca.crt`。
- **非HTTP (`http://` や `ws://`) でアクセスしてきた相手には CAダウンロードページ (`/ca`) が表示される。** ページには SHA-256指紋、OS別のインストール手順、ダウンロードリンク、`https://HOST:SSL_PORT/` へ移動するボタンがある。アプリ画面や API は返らない。HTTPS の `/ca` も同じページ（指紋とダウンロード）で利用可能。
- 設定は `.env` の `SSL_PORT` / `SSL_HOST` / `SSL_DIR` / `SSL_KEY` / `SSL_CERT` / `SSL_CA` / `SSL_HOSTS` / `SSL_CA_PAGE_BASE`（`PORT` は CA配布専用ポート）。
- 検証: `npm run test:ui:https`（CA検証（CA自身のSAN含む）・TLSハンドシェイク・CAページ表示・API 426・CAダウンロード・ブラウザ wss 接続・非HTTP ws 拒否の 27項目）。

### .env の設定

| キー | 内容 | 備考 |
| --- | --- | --- |
| `DB_PASSWORD` | PostgreSQL の接続パスワード (`otome601`) | **アプリのログインパスワードとは別物** |
| `JWT_SECRET` | JWT 署名シークレット | `config/default.js` の `auth.jwtSecret` と同一値が必要 |
| `SSL_PORT` | HTTPS/WSS ポート | 既定 3443。アプリ・API・Socket.io はこのポートのみ |
| `SSL_HOST` | HTTPS/WSS の監視ホスト | 既定 `0.0.0.0` |
| `SSL_DIR` / `SSL_KEY` / `SSL_CERT` / `SSL_CA` | 鍵と証明書のパス | `.env` と同じ階層の `certs/`（`npm run cert:gen` が生成。Gitには入れない） |
| `SSL_HOSTS` | サーバー証明書のSANホスト | 既定 `localhost,issystem.local,issystem,127.0.0.1,::1` |
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
| `npm test` | jest 統合テスト (11スイート / 145テスト、stack 秘匿 4項目 (error.middleware) + bcrypt ハッシュ非露出 (auth 8c) 含む。各スイートで pg プールを close するため `--forceExit` 不要) |
| `npm run api:check` | API スモークテスト (HTTPS の GET/POST/PUT/DELETE を実行しステータスを検証) |
| `npm run test:socket-auth` | Socket 接続権限検証 (tokenless / garbage / demoトークン / 外部Origin の拒否、KYOMU・ADMIN gate、ロック自保持限定、chat メンバーシップの 20項目。サーバー起動後に実行) |
| `npm run test:rbac` | RBAC 権限検証 (`/api/users` 一覧のロール別最小化・追加 KYOMU のみ role=TEACHER 固定・削除 ADMIN のみ、招待コード発行 KYOMU/ADMIN、チャンネル削除 KYOMU/ADMIN の 17項目。TEACHER の権限昇格は 403。サーバー起動後に実行) |
| `npm run test:ratelimit` | ログイン・招待コード レート制限検証 (不存在ユーザー 25 回失敗ログインで 401×5→429×20、失敗ログインの `LOGIN_FAILED` 監査記録、招待コード 128bit=32文字16進大写、架空コード 5 試行→429、使用済みコード 400、ADMIN 後片付けの 8項目。ユーザー単位ロックアウト 423 は `test/auth.test.js` で検証。サーバー起動後に実行) |
| `npm run test:logsecurity` | ログ秘匿・保持検証 (404 レスポンスに stack なし、失敗ログイン 401 がアクセスログ `data/logs/access-YYYY-MM-DD.log` に記録、ログディレクトリ mode 700、アクセスログファイル mode 600、アクセスログに bcrypt ハッシュなし、ADMIN 監査 API に `LOGIN_FAILED`、監査 JSON にハッシュなし、レート制限 6回失敗=401×5+429×1 の 9項目。サーバー起動後に実行) |
| `npm run test:api:mail-test` | メール接続テスト API 検証 (Jest `test/mail.test.js` 6項目) |
| `npm run test:api:mail-defaults` | メール初期値 (.env プリフィル・Git 秘匿) API 検証 (12項目) |
| `npm run test:ui:mail` | メール UI 検証 (初回設定・プリフィル・接続テスト・受信箱の 37項目) |
| `npm run test:ui:exambasic` | 定期考査 基本情報「3. 科目 × 実施クラス・コース」の列幅・チップ配置検証 (実施数列なし / 科目名14%・略称8% / チップ内容分63% / はみ出し0 / チップクリック・Shift範囲選択・保存反映の 4ビューポート 38項目) |
| `npm run test:ui:bulletin-search` | 職員掲示板の全日検索 UI 検証 (タイトル・本文・投稿者名を全日で検索して左列が対象日見出し付きの全日の列表になる / タイトルの `<mark>` ハイライト・件数「N 件」・行の対象日チップ / 中心日表示は「全日」になり ‹ ›・本日・日付クリック（カレンダー開閉）は disabled（data-day は維持・固定幅なので › の位置は動かず） / 結果クリックは中心日を動かさず右ペインに全文 / 検索ピルは存在しない / ←/→・T・C キーは停止 / ミニカレンダーの検索該当枠と日付セル disabled（合成クリックでも中心日は動かない） / 検索語クリアで通常表示とナビが復帰・投稿者名検索・後片付けの 23項目) |
| `npm run test:ui:news-share` | ダッシュボード「記事を共有」UI 検証 (「すべて見る」撤廃 / 共有モーダルの開閉とURL入力 / URL空・不正の拒否 / スキーマ無しの `https://` 補完 / 職員チャットへ `【記事共有】`投稿 (チャンネル選択) と掲示板へ `【参考記事】`投稿 (対象日) / サーバー実データへの登録 / 背景クリック・ESC・閉じるボタン・アイコン描画の 21項目) |
| `npm run test:ui:fx` | ダッシュボード労いカード（粒子アニメーション）＋開発・QA 用プレビューパネル UI 検証 (落下・上昇距離がカード高さ実測の `--fx-drop` に比例し ResizeObserver で再計算 / 年休等・出張の「記入する」ボタン撤廃 / パネルは常時表示され開閉バーが残る / テーマセレクト（自動+全13）と前・次で粒子テーマとモーションが切替 / 静的スウォッチ 13 (prefers-reduced-motion でも確認) / 疑似日付 2026-12-24→サンタ+クリスマスイブ文・季節セレクト（冬→夏）で季節文が即時切替・時刻帯5・曜日7・特別な日10がすべて出る・全メッセージセレクト（4組28文）で選んだ文がそのまま出る / 復帰で全セレクト自動・実日時へ / `--fx-drop` ≥ カード高さ / 390px で横スクロールなし・全コントロールに label.for と枠線 / 人数タイルのクリックと Enter で年休等・出張の登録・確認モーダルが開きフィルタが効く（記入フォームはモーダル内常設、件数ラベル n名、bindAbsenceTile は件数非依存＝0名表示のタイルでもクリックで開く）の 35項目) |
| `npm run test:ui:unread` | ダッシュボード「本日の連絡」未読バッヂ UI 検証 (カードは対象日が本日の掲示のみ・未読マーカーは未読カードのみ・ヘッダー右バッヂ＝本日未読 / カードクリックで `PUT /api/bulletins/:id/read` と本日バッヂ 1 減・マーカー消去・サイドバーとタイトルバッヂ連動 / カードクリックでタブ移動もモーダル開閉なし・既読カードの再クリックは API を叩かない（冪等） / サイドバー（数字のみ）＝タイトル（未読 N）＝全日未読 / 客户端キャッシュ 100 件未読はサイドバー 99+・タイトルとダッシュボード 未読 99+（擬似キャッシュで再現。100 を出さない、実キャッシュ復帰でバッヂが実データへ追従 / 登録日より古い記事（対象日=本日・掲示期間本日有効でも）と掲示開始前記事は未読バッヂに数えない / 後片付けの 17項目。テストはCAPSIM擬似キャッシュ中心で実 DB は本日記事と登録日前記事のみ) |
| `npm run test:ui:sidebar-push` | サイドメニューせり出し時の main 追従 UI 検証 (≥1100px はせり出し幅 285.25px に main の padding-left が追従し重なりなし (ホバー・is-focus のみ両経路、カーソル/フォーカス離脱で収納復帰)、768〜1099px はオーバーレイ維持 (main padding 不変)、500px は画面下バー・せり出しなしの 12項目) |
| `npm run test:ui:https` | 安全通信検証 (CA検証 / TLS / CAページ / API 426 / CA配布 / ブラウザ wss) |
| `npm run rotate:mail-key -- OLD_JWT_SECRET=<旧> (OLD_SECRET=<旧MAIL_ENC_SECRET> も可)` | mail_accounts の AES-256-GCM キーローテ (sha256(旧JWT) / scrypt(旧MAIL_ENC_SECRET) で暗号化された行を新 MAIL_ENC_SECRET 基準の scrypt キーへ再暗号化。再暗号化後にサーバー再起動) |
| `npm run db:create` / `db:init` / `db:seed` | DB 作成 / スキーマ適用 / ダミーデータ投入 |
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
| `test/chat.test.js` | チャンネル一覧、メンバー一覧 (`chat_channel_members`)、チャンネル作成 201、メッセージ投稿、取得、既読、削除、公開チャンネル削除 400、チャンネル名欠落 400 |
| `test/invitation.test.js` | 招待コード発行 (トップレベル `code`)、新規登録、招待コードによるパスワード再設定、旧パスワード 401、消費済みコード 400、未登録教職員番号 404、8文字未満/項目欠金 400、`used_for` (REGISTER / PASSWORD_RESET) |
| `test/exam.test.js` | 考査マスタ CRUD、教科・スロット・時間割セル、監督者配置、部屋割りのブロックソルバー、禁止時間帯、検証 API |
| `test/absence.test.js` | 欠席・早期帰・遅刻の作成・一覧・修正・削除と期間集計 |
| `test/schedules.test.js` | 学校日程の作成・年月一覧・当日取得・削除とカテゴリマッピング |
| `test/mail.test.js` | メール設定保存・初期値プリフィル・接続テスト API (`status` VERIFIED/FAILED) (6項目) |

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
- スモークテストは `npm start`（HTTPS 3443）でサーバーを起動してから `npm run api:check` を実行する（`NODE_EXTRA_CA_CERTS=./certs/issystem-ca.crt` が付与されCAトラストで検証する）

