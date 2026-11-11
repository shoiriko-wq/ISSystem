# ISSystem仕様書（現行実装基準）

**文書バージョン:** 3.0.0 ／ **改訂日:** 2026年11月7日 ／ **対象:** ISSystem（職員室情報共有システム）

## 0. 文書の位置づけ

本書は**現行コード（`src/` + `public/` + `db/schema.sql`）を唯一の正典として再構成した仕様書**であり、旧文書群の置き換えである。旧文書は実装と乖離していたため削除した。

| 削除した旧文書 | 主な乖離（実データ） |
| --- | --- |
| `仕様書.md` | 0バイト（空） |
| `問題分析.md` | 参照パス `/home/iriko/デスクトップ/ISSystem`（現 `/home/iriko/programing/ISSystem`）、存在しない `CLAUDE.md` を参照 |
| `システム機能仕様書.md` v2.0.0 | 「MongoDB/軽量データストア選択可」→ 現行は PostgreSQL 一本（`config/default.js` は `DB_TYPE≠postgres` に警告）。督促・再通知機能は**実装なし** |
| `データベース仕様書.md` v2.2.0 | 記載約11テーブル → 現行**51テーブル / 77インデックス**。`posts.post_type`・`posts.priority` は撤廃（カラム削除済み） |
| `ＵＩ・ＵＸ仕様書.md` | 「Single-File HTML」「FontAwesome 6.4.0」「インラインCSS」→ 現行は `index.html`(883行) + CSS**7ファイル(4,406行)** + JS**モジュール分割31ファイル(15,793行)**、アイコンは **Lucide** |
| `UI構成ファイル分割計画.txt` | 分割は**実行済み**。計画書は履歴 |
| `バックエンドファイル分割計画.txt` | models 9 / services 10 / controllers 9 / sockets 4 → 現行 **13 / 16 / 13 / 6 (+ utils 10, config 2)** |

**残す文書:** `README.md`（運用手順・コマンド・環境変数。本書の運用補足）、`prompt.txt`（発注メモ）、`AGENTS.md`（エージェント行動規約）、`INSTRUCTIONS.md`。

---

## 1. 概要

校務支援バックエンド。Express + PostgreSQL + Socket.io + Cron による**職員室内のリアルタイム情報共有システム**。教職員が回覧板・掲示板・チャット・施設予約・スケジュール・座席（在席）状態・定期考査の時間割／監督割・メール受信箱を同一ポータルで共有する。

- 画面タブ: `dashboard` / `bulletin` / `chat` / `facility` / `schedule` / `approval` / `seating` / `exam` / `mail`（`news` はダッシュボードウィジェットでタブなし）
- 通信は**すべて TLS（HTTPS/WSS）**。非HTTPアクセスにはプライベートCA配布ページのみ応答する。
- 版数: `GET /api/health` が返す `version` は `2.5.0`。

---

## 2. 技術スタック

**サーバー（実行依存）:** Node.js 20+（開発環境 v24）、Express v5、PostgreSQL（開発環境 18.6）+ `pg`（共有プール）、`socket.io`、`node-cron`、`bcrypt`、`jsonwebtoken`、`helmet`、`morgan`、`cors`、`dotenv`、`socket.io-client`（テスト用）。

**サーバー（開発依存）:** `jest`（`--experimental-vm-modules`、`--runInBand`）、`nodemon`、`puppeteer-core`（UI検証）、`supertest`。

**クライアント:** ビルド工程なしの ES Modules。`index.html` + Tailwind CSS (CDN) + Lucide (unpkg CDN)。CSSは7ファイル分割、JSはタブ別モジュール分割。状態・テーマは `localStorage`（キー `is_system_jwt_token_v251` / `is_system_user_info_v251` / `is_system_theme_preference_v251`）。

**新規依存追加方針:** メール接続テストは `node:net` / `node:tls` のみで実装（`src/services/mail.transport.js`）。npm 依存を増やさない。

---

## 3. 実行構成（2ポート・TLS・プライベートCA）

サーバーは `src/server.js` が**2つのリスナー**を起動する。

| ポート | 設定キー | 内容 |
| --- | --- | --- |
| **3443** | `SSL_PORT` / `SSL_HOST` | **HTTPS/WSS**（アプリ本体・API・Socket.io）。サーバー証明書はプライベートCAで署名 |
| **3000** | `PORT` / `HOST` | 非安全HTTP。**CA証明書のダウンロードページ専用**。アプリ画面は提供せず、APIは `426 Upgrade Required` で拒否（`src/app.insecure.js`） |

- `npm run cert:gen`（`scripts/create-ca.mjs`）が `certs/` に発行: ルートCA `issystem-ca.crt`（秘密鍵 `issystem-ca.key`、`issystem-ca.pem` は同一内容・**v2 は SAN なし＝`CA:TRUE` のみ。信頼は指紋**）、サーバー証明書 `server.pem` + `server.key`（**SAN 付き**＝`localhost, issystem.local, issystem, 127.0.0.1, ::1` ＋ `SSL_HOSTS` の IPv4）。サーバー証明書をCAに読み込ませ WSS でも検証が成立するチェーンを提示する。再発行は `--force`（CA も交換＝全端末でCA再インストール）／ `--server-only`（CA 再利用・サーバー証明書のみ再署名）。`certs/` は Git に入れない。
- 端末の信頼ストアに `certs/issystem-ca.crt` をインストール（Windows: 信頼されたルート証明機関／macOS: 常時信頼）。この設定はユーザー環境で一度だけ行い、npm script に `NODE_EXTRA_CA_CERTS` を埋め込まない。テストスクリプトは `ca: [certs/issystem-ca.crt]` を明示的に渡して TLS 検証する（`api-smoke-test.js` は信頼ストアを使用）。
- 非HTTP（`http://` / `ws://`）で来た端末には `/ca`（`src/routes/ca.routes.js`）が **SHA-256指紋・OS別インストール手順・ダウンロードリンク・`https://HOST:SSL_PORT/` へ移動するボタン**を表示。HTTPS の `/ca` も同じ。`SSL_CA_PAGE_BASE` がボタンURLの基点。
- Express 側 (`src/app.js`) ミドルウェア順: `helmet`（CSP はオフ＝インラインスクリプト／CDN許可、`crossOriginResourcePolicy: cross-origin`）→ `cors`（`CLIENT_ORIGIN` カンマ区切り、credentials 有効）→ JSON/urlencoded（10MB上限）→ `morgan`（production: combined、開発: dev、`NODE_ENV=test` では無し、**v3.0.8: 4b で `data/logs/access-YYYY-MM-DD.log` へファイル出力 (dir 700 / file 600、日次ローテーション)**）→ `/api/health` → `/ca` → `/api` → `express.static(public)` → SPAフォールバック（`/api` 以外は `index.html`）→ `notFoundHandler` → `errorHandler`。
- レート制限（`src/middlewares/rate-limit.middleware.js`、**express-rate-limit v8**、メモリストア＝プロセス内ウィンドウ、`req.ip` は trust proxy 未設定でソケット直結地址＝X-Forwarded-For を信用しない、IPv6 は `ipKeyGenerator` で /48 束ね）: ログイン（IP+識別子小文字キー、失敗のみ 15分5回→429）、認証系グローバル（IP、失敗のみ 1時間200回→429）、招待登録（IP+コード 15分5試行→429）、招待リセット（IP+コード+staff_code 15分5試行→429）、招待発行（IP+ユーザー 15分30回→429）。ユーザー単位ロックアウト（423）は `auth.service.js` 側。成功ログインは失敗カウンタに影響しない。エイリアス（`/auth/register`・`/auth/reset-password`・`/auth/invite-code`）にも同一制限。
- Socket.io は `transports: ['websocket','polling']`、クライアントは `window.location.origin` を使い HTTPS オリジンから `wss://` へ自動対応（`public/js/socket.js`）。ping 25秒 / timeout 20秒（`config/default.js` `realtime`）。

---

## 4. バックエンド層構成（実ファイル・実測行数）

合計 23,482 行（`src/` + `config/`）。

| 層 | ファイル数 | 行数 | 内容 |
| --- | --- | --- | --- |
| `config/` | 2 | 430 | `default.js`(157) 環境変数→設定、`database.js`(273) pg共有プール + `ensureSchema()`（プロメモ化で多重適用防止） |
| `src/` エントリ | 3 | 281 | `server.js`(144) TLS/CA/Cron 起動・グレースフルシャットダウン、`app.js`(82)、`app.insecure.js`(55) |
| `routes/` | 2 | 372 | `index.js`(354) 全API統合（コントローラー関数の `safe()` ラッパーで未定義時のクラッシュ防止）、`ca.routes.js`(18) |
| `middlewares/` | 3 | 260 | `auth.middleware.js`(150) JWT検証 + RBAC、`lock.middleware.js`(51) 編集排他ロック検証、`error.middleware.js`(59) 共通エラー/監査ログ |
| `models/` | 13 | 6,063 | user, bulletin, chat, facility, schedule, approval, seating, exam, audit, mail, absence, subject, basicinfo |
| `services/` | 16 | 8,510 | auth, bulletin, chat, facility, schedule, approval, seating, exam, news, audit, mail, `mail.transport`(net/tls 実接続), absence, subject, basicinfo, upload(10MB・`data/uploads`) |
| `controllers/` | 13 | 3,388 | auth, bulletin, chat, facility, schedule, approval, seating, exam, news, mail, absence, subject, basicinfo, ca |
| `sockets/` | 6 | 808 | `socket.index.js` 認証+接続ルーティング、`chat.socket.js`、`seating.socket.js`、`lock.socket.js`、`socketClient.js`、`socketEvents.js`(110) クライアント側イベントAPI |
| `utils/` | 10 | 3,370 | `exam-block-solver`(720)、`exam-timetable-solver`(775)、`exam-proctor-solver`(666)、`exam-room-solver`(416)、`exam-schedule`(292)、`optimizer.worker`(221 席替え)、`cron.jobs`(67)、`logger`(105)、`db`(56)、`presence`(4)、`origins`(19) |

---

## 5. ロールと権限（RBAC）

`users.role` は `ADMIN` / `KYOMU` / `HEAD` / `TEACHER`（既定 `TEACHER`）。加えて `users.is_kyomu`（INTEGER 1/0）、`users.is_parttime`（BOOLEAN 非常勤）、`users.invited_by_user_id`（招待コード発行者）を持つ。JWT クレームは `{ id, name, role, is_kyomu, grade, department }`。

| ミドルウェア | 許可条件 | 現行の適用先 |
| --- | --- | --- |
| `authenticateToken` | `Authorization: Bearer <JWT>` を `config.auth.jwtSecret` で検証。缺失 401、期限切れ 401 (`TokenExpired`)、無効 403 (`Forbidden`) | ほぼ全 `/api/*` |
| `requireKyomuRole` | `is_kyomu === true` **または** `role === 'KYOMU'` **または** `role === 'ADMIN'` | 教科マスタ追加/改名/削除、施設マスタ CRUD と並び順、監査ログ `/audit/logs`、ニュースキャッシュクリア、考査の決定・コマ組み系 |
| `requireKyomuOnlyRole` | `role === 'KYOMU'` の**み**（`ADMIN` は対象外） | スケジュールカテゴリマスタ（＝プロフィールの部署マスタ）の追加・改名・削除 |
| `requireRoles(...roles)` | 列挙ロール **または** `ADMIN` | ルートでは未使用 |
| `requireAdminRole` | `role === 'ADMIN'` のみ | **v3.0.5 で `DELETE /api/users/:id` に適用**（コントローラ内でも ADMIN を再検証。§15 参照） |

**権限がサービス側で判定されるもの:** 年休・出張欠席（教務・管理職は全教員分、一般教員は本人分のみ）、担当教科の他教員変更（教務部のみ）。

**Socket.io ハンドラー（`seating:*`, `lock:*`, `chat:*`）にはロール検証が存在しない**（接続時の JWT 検証のみ）。

---

## 6. 認証・招待コード

1. `POST /api/auth/login`（`staff_code` + パスワード、bcrypt比較）→ JWT（`JWT_EXPIRES_IN` 既定 24h）を発行。**v3.0.7 総当たり対策**:（a）レート制限 — IP+識別子キーで 15分 5 回（失敗のみカウント、成功は非カウント）超限は 429、IP グローバル 1時間 200 失敗で 429。（b）ユーザー単位ロックアウト — 同一識別子で 15分窓 5 回失敗すると 15分間ロック（423、成功ログインまたはサーバー再起動で解除、`auth.service.js` プロセス内 Map）。（c）失敗ログインは監査ログ `LOGIN_FAILED`（IP・reason: `user_not_found` / `bad_password` / `locked_out`）を記録。パスワード照合失敗ログから `dbHash` を出力しない（§15 監査 #5 対策）。429/423 の `message` はログイン画面の `login-error` に表示される。
2. 招待コード発行 `POST /api/auth/generate-invitation`（要認証＋`K`＝教務部 KYOMU/ADMIN のみ、v3.0.5）: `crypto.randomBytes(16).toString('hex').toUpperCase()` = **32文字16進大写（128bit・v3.0.7。旧 8文字=4バイトは総当たり可能だったため廃止）**、有効期限 24時間（`config.auth.invitationCodeExpiryHours`）。発行は IP+ユーザーキー 15分 30 回（429）。レスポンスはトップレベルに `code` と `expiresAt`。設定ビューの発行カードとユーザー管理メニューは教務部以上にのみ表示（一般教員には非表示）。
3. 発行時点で利用目的は確定しない。受け取った教職員がログイン画面で「新規登録（招待コード）」/「パスワード再設定」を自ら選ぶ。
4. `POST /api/auth/register-invitation`（招待コード + 教職員番号 + パスワード）→ 登録直後に JWT。消費済み 400、既存教職員番号 409、8文字未満/項目不足 400。**v3.0.7**: コード単位試行制限（IP+コードキー 15分 5 試行、超限 429。8桁コード総当たりを封じる）。
5. `POST /api/auth/reset-password-invitation`（招待コード + 教職員番号 + **新パスワード8文字以上**）→ 再設定直後に JWT。未登録教職員番号 404、旧パスワード 401。**v3.0.7**: IP+コード+staff_code キー 15分 5 試行（429）。
6. 消費は `invitation_codes` に `is_used` と `used_for`（`REGISTER` / `PASSWORD_RESET`）として記録。再利用不可。
7. 旧互換ルート（同一ハンドラー）: `POST /api/auth/register`、`POST /api/auth/reset-password`、`POST /api/auth/invite-code`。
8. 自己管理: `GET /api/auth/me`、`PUT /api/auth/profile`（氏名・学年・分掌）、`PUT /api/auth/change-password`、`PUT /api/auth/status`（在席状態）、`POST /api/auth/logout`。

**パスワード2系統（別物）:** DB接続パスワード（`DB_PASSWORD`）とアプリログインパスワード。`scripts/seed.js` の教職員共通パスワードは `password123`、教務主任は教職員番号 `T2026001`。

**注意（実装上の既知事項）:** `JWT_SECRET` は bcryptソルト由来の運用・メールパスワードのAES鍵導出（§10）にも使われている。変更時は `npm run db:seed` 再実行が必要。

---

## 7. API 一覧（`src/routes/index.js` 全354行・実測）

凡例: `-` = 認証なし、`A` = `authenticateToken`、`K` = `requireKyomuRole`、`K!` = `requireKyomuOnlyRole`（ADMIN 不可）、`Ad` = `requireAdminRole`（ADMIN のみ）、`L` = `checkEditingLock(...)`。全ルートは `safe()` でラップされ、未定義ハンドラーは 500 を返す（クラッシュしない）。

### 7.1 認証・ユーザー・マスタ

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | - | `staff_code` + パスワード → JWT（v3.0.7: IP+識別子 15分5回失敗で 429、ユーザー単位ロック 423） |
| POST | `/api/auth/register-invitation` | - | 招待コードによる新規登録（v3.0.7: IP+コード 15分5試行で 429） |
| POST | `/api/auth/reset-password-invitation` | - | 招待コードによるパスワード再設定（v3.0.7: IP+コード+staff_code 15分5試行で 429） |
| POST | `/api/auth/generate-invitation` | A+K | 招待コード発行（32文字16進大写=128bit・v3.0.7/24h、教務部 KYOMU/ADMIN のみ・v3.0.5、IP+ユーザー 15分30回） |
| GET | `/api/auth/me` | A | プロフィール |
| PUT | `/api/auth/profile` | A | 氏名・学年・分掌の自己更新 |
| PUT | `/api/auth/change-password` | A | パスワード変更 |
| PUT | `/api/auth/status` | A | 在席状態更新 |
| POST | `/api/auth/logout` | A | ログアウト |
| POST | `/api/auth/register`・`/auth/reset-password`・`/auth/invite-code` | -/A | 旧互換エイリアス（同一ハンドラー） |
| GET | `/api/users` | A＋コントローラでロール再検証 | 一覧（v3.0.5）。KYOMU/ADMIN は全件（email・内線含む）、TEACHER は名簿最小フィールド（id/staff_code/name/role/grade/department/subjects/avatar_url）のみ。**`password_hash` はいかなるロールにも返さない** |
| POST | `/api/users` | A+K | 教職員アカウント追加（v3.0.5）。ADMIN は role 指定可、KYOMU は role が TEACHER 固定（ADMIN への権限昇格抑止）。TEACHER は 403 |
| DELETE | `/api/users/:id` | A+Ad | アカウント削除（ADMIN のみ・v3.0.5、コントローラでも ADMIN を再検証） |
| GET | `/api/subjects` | A | 教科マスタ（全教職員） |
| POST/PUT/DELETE | `/api/subjects`, `/api/subjects/:id` | A+K | 教科マスタ追加・改名・削除（教務部） |
| PUT | `/api/users/:id/subjects` | A | 担当教科設定（自身は全教職員、他教員は service 側で教務部検証） |
| GET | `/api/basic-info` | A | 基本情報マスタ（クラス・コース・科目・教室・年間考査計画） |
| GET | `/api/basic-info/usage/:kind/:id` | A | 削除前に使用状況（参照箇所）を確認 |
| POST/PUT/DELETE | `/api/basic-info/:kind[/:id]` | A | 基本情報マスタの登録・改名・削除（`subject`/`teacher` は全教職員、教員個別設定は service 側権限） |
| GET | `/api/health` | - | `{ status:'ONLINE', version:'2.5.0' }` |
| GET | `/ca`, `/ca/issystem-ca.crt` | - | CAページ（指紋・手順・DL）とCAファイル配布 |

### 7.2 掲示板・回覧板（`/api/bulletins`）

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/bulletins` | A | 一覧（掲示期間・対象日で絞り込み） |
| GET | `/api/bulletins/:id` | A | 詳細（確認率 `ack_percentage`、コメント一覧） |
| POST | `/api/bulletins` | A | 投稿作成（件名・本文必須、欠落 400） |
| POST | `/api/bulletins/upload` | A | 添付付き投稿作成（10MB上限、`data/uploads`） |
| GET/DELETE | `/api/bulletins/attachments/:attachmentId` | A | 添付ダウンロード・削除 |
| POST | `/api/bulletins/:id/attachments` | A | 既存投稿への添付追加 |
| POST | `/api/bulletins/:id/comments` | A | コメント（右ペインでその場で送信、永続化。作者削除でもコメントは残す） |
| PUT | `/api/bulletins/:id/read` | A | 既読 |
| PUT | `/api/bulletins/:id/approve` | A | 電子承認（ワンクリック署名、日時+ユーザーID記録） |
| POST | `/api/bulletins/:id/remind` | A | 未承認者への督促（`remindUnacknowledgedUsers`。旧UIでは**廃止**表記） |
| DELETE | `/api/bulletins/:id` | A | 削除（論理削除 `is_deleted` INTEGER 0/1） |

### 7.3 チャット（`/api/chat`）

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| GET/POST | `/api/chat/channels` | A | チャンネル一覧・作成（名前行 400。タイプは `GROUP`/`DM` のみ＝**職員全体チャンネルは撤廃済み v3.1.2**。`POST` の `type` はサーバー側ホワイトリスト（`chat.service.js` の `ALLOWED_USER_TYPES`）で `GROUP`/`DM` 以外の指定（`PUBLIC`・`PRIVATE`・`ALL` 等）は `GROUP` へ寄せる＝**v3.1.4**。全体グループを作らせない） |
| GET | `/api/chat/channels/:channelId/members` | A | メンバー一覧（`chat_channel_members`） |
| GET/POST | `/api/chat/channels/:channelId/messages` | A | 履歴取得・メッセージ投稿 |
| PUT | `/api/chat/channels/:channelId/read` | A | 既読更新（`chat_message_reads`、未読バッジ算出） |
| PUT | `/api/chat/channels/:channelId/hide` | A | チャンネル非表示トグル（`is_hidden`） |
| DELETE | `/api/chat/channels/:channelId` | A+K | チャンネル削除（教務部 KYOMU/ADMIN のみ・v3.0.5。**職員全体チャンネルは撤廃済み v3.1.2 のため公開チャンネル判定は存在しない**。作成 `POST /api/chat/channels` は全教職員開放のまま） |
| DELETE | `/api/chat/messages/:messageId` | A | メッセージ取り消し（行を残し「取り消された」状態のみ保持。本文はクライアント通信に載せない。`created_at` は変更しない） |

### 7.4 施設・備品（`/api/facilities`）

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/facilities` | A | マスタ（`sort_order` 順、NULL は `category, name` 順で末尾） |
| GET | `/api/facilities/daily-overview` | A | 日別利用状況（空き/使用中） |
| GET | `/api/facilities/:facilityId/reservations` | A | 施設別予約一覧 |
| POST | `/api/facilities/reservations` | A | 予約作成 → **時間帯重複は 409**、`start >= end` は 400 |
| PUT/DELETE | `/api/facilities/reservations/:reservationId` | A | 予約変更・キャンセル（`is_cancelled` INTEGER 0/1） |
| PUT | `/api/facilities/order` | A+K | `{ ids: [...] }` 全件必須。未知 404、重複・全件不足・空 400、非教務部 403 |
| POST/PUT/DELETE | `/api/facilities[/:facilityId]` | A+K | マスタ CRUD（同名 409、有効予約残 409） |

`facility_cells` を扱う `facility.model.js` の `updateCells()`/`getCells()` は**サービス・コントローラー・テストから一度も呼ばれていない**（ルートなし＝未使用パス）。

### 7.5 スケジュール・決裁・欠席・監査

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| GET | `/api/schedules` / `/api/schedules/today` | A | 期間指定一覧・本日タイムライン |
| POST/PUT/DELETE | `/api/schedules[/:id]` | A | 行事予定の追加・更新・削除 |
| GET | `/api/schedules/categories` | A | カテゴリマスタ（＝プロフィールの部署マスタ） |
| POST/PUT/DELETE | `/api/schedules/categories[/:id]` | A+K! | カテゴリ追加・改名・削除（**教務部 KYOMU のみ**） |
| GET | `/api/approvals` / `/api/approvals/:id` | A | 決裁申請一覧・詳細 |
| POST | `/api/approvals` | A | 申請作成（201） |
| PUT | `/api/approvals/:id/process`・`/status` | A | 承認処理（無効ステータス 400、不存在 404） |
| POST | `/api/approvals/:id/remind` | A | 承認者へ督促 |
| GET | `/api/absences` / `/api/absences/teachers` | A | 期間集計・教員別（欠席・早期帰・遅刻） |
| POST/DELETE | `/api/absences[/:id]` | A | 年休・出張等の登録・削除（権限判定は service 側） |
| GET | `/api/audit/logs` | A+K | 監査ログ照会（`action`, `target`, `userId`, `startDate`, `endDate`, `page`, `limit` 既定50） |

### 7.6 メール（`/api/mail`）

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| GET/POST/DELETE | `/api/mail/account` | A | 接続設定の取得・保存（AES-256-GCM暗号化）・削除 |
| POST | `/api/mail/test` | A | `password` とフォーム値を送れば**未保存設定のプレテスト**（DB書込なし）、空なら保存済み設定でテストし `status`（`UNVERIFIED`/`VERIFIED`/`FAILED`）を更新、監査ログ `MAIL_CONNECTION_TEST` |
| GET | `/api/mail/messages` | A | 受信箱（左：件名と日時、右：本文／既読記録） |
| POST | `/api/mail/messages/:id/read` | A | 既読記録 |

### 7.7 座席（`/api/seating`）

`GET /layouts`・`GET /layouts/:id`・`POST /layouts`・`PUT /layouts/:id/cells`（`checkEditingLock('seating')` 付き）・`PUT /layouts`・`PUT /master`・`GET /master`・`GET /students/code/:code`（4桁生徒コード）・`GET /students/search`・`POST/DELETE /layouts/:id/lock`（編集ロック取得/解放）。

**実装の要点（実測）:** レイアウト geometry は DB に永続化されない。`seating.model.js` の `listLayouts()`/`createLayout()` は rows/cols（既定 6×8、id `staff_room`、name `職員室メイン配置図`）を**返すだけ**で INSERT しない。セル保存 `updateCells(_layoutId, cells)` は `desk_number`（`A-01` 形式）・`current_status`・`status_note` を `seating_status` へ UPSERT する。座席レイアウト専用テーブルは存在しない。

### 7.8 定期考査（`/api/exam`）— フェーズ制

- **マスタ**: `GET /exam`（稼働中）、`GET /exam/masters`、`POST /exam`、`PUT /exam/:id`、`POST /exam/:id/deactivate`、`GET /exam/:id/board`、`POST /exam/:id/phase`。
- **公表ビュー**: `GET /exam/:id/view`（+ `/timetable`・`/rooms`・`/proctors`・`/trips`）。
- **実施科目・出題者調査**: `GET /exam/:id/subjects`、`GET /exam/:id/decisions`（教務が1考査分を決定）、`POST /exam/:id/decisions/seed`・`/decisions`・`/decision-rows`・`/decisions/survey/start`・`/decisions/survey/end`・`/decisions/decide`（K）、`POST /exam/decision/:id/submit`（A）、`POST /exam/decision/:id/reset-default`（K）、`DELETE /exam/decision/:id`（K）、`GET /exam-survey-status`、`POST /exam/:id/subject-survey/start`・`/subject-row`・`/subject-row/:rowId/submit`・`/subject-row/:rowId`・`/subject-survey/end`・`/subject-row/:rowId/decide`、`POST /exam/:id/plan/register`・`/plan/survey-start`・`/plan/decide`、`GET /exam/:id/survey-summary`。
- **時間割**: `GET /exam/:id/slots`、`POST /exam/:id/timetable-rules`、`POST /exam/:id/timetable`（ソルバー）、`POST /exam/:id/timetable/slots`、`POST /exam/:id/timetable/publish`・`/end`・`/validate`、`GET/PUT /exam/:id/schedule-cells`、`PUT /exam/:id/timetable/blocked`（学年別禁止時間帯）。
- **コマ組み**: `GET /exam/:id/commands`、`POST /exam/:id/commands/generate`・`/command`（K）、`DELETE /exam/:id/command/:commandId`（K）、`GET /exam/:id/block-shapes`、`POST /exam/:id/block-shapes/generate`・`/block-shape`（K）、`DELETE /exam/:id/block-shape/:shapeId`（K）、`GET /exam/:id/block-groups`、`POST /exam/:id/block-groups/seed`・`/block-group`（K）、`DELETE /exam/:id/block-group/:groupId`（K）、`GET /exam/:id/block-conditions`、`PUT /exam/:id/block-conditions/:shapeId`（K）、`PUT /exam/:id/block-shapes/:shapeId/placements`（K）、`POST /exam/:id/timetable/solve`（K）、`POST /exam/:id/timetable/validate-block`。
- **教室割**: `GET /exam/:id/rooms`・`/room-rules`・`/room-config`、`POST /exam/:id/room-rules`・`/rooms`・`/room-config`・`/room-assign`、`PUT /exam/:id/room-assign`、`POST /exam/:id/room-assign/publish`・`/end`。
- **出張等**: `GET /exam/:id/trips/preview`・`/trips`、`POST /exam/:id/trips/start`・`/publish`・`/trips`・`/trips/end`、`DELETE /exam/:id/trips/:tripId`。
- **監督割**: `GET /api/staff/pool`、`GET /exam/:id/proctor-board`、`POST /exam/:id/proctor-rules`、`POST/DELETE /exam/:id/parttime-staff[/:staffRowId]`、`POST /exam/:id/parttime-availability`、`POST /exam/:id/teacher-constraint`、`POST/DELETE /exam/:id/exemption[/:teacherId]`、`POST/PUT /exam/:id/proctor-assign`、`POST /exam/:id/proctor-assign/validate`・`/publish`・`/end`。

**5ソルバー**（`exam-timetable-solver` 775行、`exam-block-solver` 720行、`exam-proctor-solver` 666行、`exam-room-solver` 416行、`exam-schedule` 292行）が制約充足で時間割・監督割・教室割を生成。`exam_phases` が調査/公表フェーズ（`subject`・`decision`・`timetable`・`trip`・`room_phase`）を1考査1行で保持する。

### 7.9 ニュース・天気

`GET /api/news`、`/api/news/weather`、`/api/external/news`、`/api/external/weather`、`/api/news/dashboard-widget`（A）、`GET /api/news/health`（認証なし）、`POST /api/news/cache/clear`（A+K）。外部RSS＋インメモリキャッシュ（TTL 既定1h、Cronで毎時強制更新）で **DB永続化しない（意図された設計）**。

---

## 8. リアルタイム通信（Socket.io）

クライアントは CDN の `socket.io@4.7.5`（`public/index.html`）を使い、`public/js/socket.js`（404行）が `window.location.origin`（HTTPS）から `wss://` へ自動対応して接続、`auth: (cb) => token` で JWT を渡す（`transports: ['websocket','polling']`）。接続時サーバーは `user:${userId}` パーソナルルームへ参加し `user:presence` を一斉配信、`onlineUserIds`（`utils/presence.js`）で在线を管理する。

### 8.1 クライアント → サーバー（サーバーが受けるイベント）

| イベント | 内容 |
| --- | --- |
| `chat:join_channel` / `chat:leave_channel` | チャンネル参加・退出（ルーム購読） |
| `chat:send_message` / `chat:cancel_message` / `chat:mark_as_read` | 送信・取り消し・既読 |
| `chat:typing_start` / `chat:typing_stop` | 入力中表示 |
| `seating:update_status` / `seating:highlight_seat` / `seating:grid_updated` | 在席状態・生徒検索ハイライト・グリッド更新 |
| `lock:acquire` / `lock:release` / `lock:timeout_released` | 編集ロック取得・解放・タイムアウト解放 |

**チャット送信は REST（`POST /api/chat/channels/:id/messages`）でも行う。** UI が `socket.emit` で送るのは `chat:join_channel` と `seating:update_status` の2件だけ（実測）。

### 8.2 サーバー → クライアント

- 一斉配信（`io.emit`）: `user:presence`, `user:added`, `user:updated`, `user:deleted`, `bulletin:posted`, `bulletin:commented`, `schedule:changed`, `schedule:categories_changed`, `facility:master_changed`, `facility:reservation_changed`, `seating:status_changed`, `subjects:changed`, `subjects:user_changed`, `basicinfo:changed`, `absence:updated`, `weather:updated`, `lock:status_changed`。
- 個人・ルーム宛（`io.to`）: `chat:channel:${channelId}` → `chat:message`, `chat:message_deleted`, `chat:read_receipt`, `chat:channel_deleted`。`user:${userId}` → `chat:unread_count_updated`, `chat:channel_created`, `chat:toast`。
- クライアントの受信登録（実測 `public/js` 全体）: `connect`, `connect_error`, `disconnect`, および上記に加えて `chat:channels_synced`。

### 8.3 未使用・履歴コード（実測）

`src/sockets/socketEvents.js`(110) と `src/sockets/socketClient.js` は**クライアントから一度も import されていない**（`public/js/socket.js` が自前の `socketClient` を持つ）。しかも `socketClient.js` は自分自身を import する循環参照で、両者は同一の `socketEvents` を export する**複製**であり、受けるイベント名（`chat:new_message`, `chat:unread_update`, `seating:student_highlight`）はサーバーが発行しない名前である。削除またはサーバー側統一の対象。

### 8.4 接続認証とハンドラー権限 gate（2026/11/7 強化・`src/middlewares/socket.middleware.js`）

- **Origin 許可リスト**: `SOCKET_CORS_ORIGINS`（未設定時 `CORS_ORIGINS`）＋ `SSL_HOSTS`×`SSL_PORT` から導出する `https://<host>:<port>` 集合で照合する。Origin を持つハンドシェイクは明示リスト外なら `Authentication error: Origin not allowed` で拒否。`src/server.js` の socket.io `cors.origin` も**同一関数**（`isSocketOriginAllowed`）で照合し、wildcard `*` は明示設定時のみ許可＋警告ログ。非ブラウザクライアント（テストスクリプト）は Origin を送らないため許可（CORS はブラウザ概念）。
- **JWT 厳格検証**: `verifySocketToken()` が `config.auth.jwtSecret` で `jwt.verify` を同期実行。`demo-jwt-token-*` プレフィックス無条件通過と `NODE_ENV≠production` の `dev-user` フォールバックは**廃止**（検証失敗は常時 `connect_error`、サーバーログに `[Socket.io Auth] 拒否`）。
- **ハンドラー gate**: `seating:update_status` は `socket.user.id` のみ（payload の userId は無視）＋ `SEATING_STATUSES` ホワイトリスト。`seating:grid_updated` は `KYOMU/ADMIN` のみ（`socketHasRole`）。`lock:*` は `SOCKET_RESOURCE_TYPES` ホワイトリスト＋ `resourceId` サニタイズ、`acquireEditingLock` は model の位置引数署名で呼び、解放・タイムアウト解放は**自保持分のみ**。`chat:send_message` / `chat:mark_as_read` / `chat:typing_*` はメンバーシップ検証（`canAccessChannel`＝**全チャンネルがメンバーのみ。PUBLIC の抜け道は撤廃済み v3.1.2**）。
- **UI 側**: `public/js/socket.js` は `connect_error` が認証失敗（`Authentication error` / `jwt` / `Origin not allowed`）を示すとき `socket.io.reconnection(false)` で無限再接続を停止し「再ログインしてください」トーストを出す。
- **検証**: `npm run test:socket-auth`（`scripts/test-socket-auth.mjs`、20項目）。代替ポートで検証する場合は `PROBE_SSL_PORT=<port>` で実行する。

---

## 9. データベース（PostgreSQL / 51テーブル（52 CREATE TABLE）/ 77インデックス / 1,262行スキーマ）

- **UTF-8、タイムゾーン `Asia/Tokyo`**（`CURRENT_TIMESTAMP` は JST 壁時計で格納）。
- 主キーは **`id TEXT PRIMARY KEY`**（UUID文字列）。`staff_code` はユニークログインID。外部キーは常に有効（PRAGMA なし）。
- **フラグは INTEGER 0/1 に統一**（`is_deleted`, `is_cancelled`。旧 boolean 環境からは冪等マイグレーション: DROP INDEX → 型変換 → 再作成）。`exam_*` の一部は BOOLEAN を使用。
- `ensureSchema()`（`config/database.js`）が起動時に冪等適用（`DB_AUTO_SCHEMA=false` で無効化可）。`npm run db:init`、`npm run db:tables`（コード参照テーブル名との整合チェック）。
- 歴史的な重複定義が残る: `invitation_codes` は §1c と §11 に2度定義（`IF NOT EXISTS` で冪等、51ユニーク / 52 CREATE TABLE）、`audit_logs`（90日保持）と `system_audit_logs` が併存。

| 分類 | テーブル |
| --- | --- |
| アカウント・招待 | `users`（role/grade/department/extension_number/is_kyomu/is_parttime/invited_by_user_id）, `invitation_codes`（`code`, `is_used`, `used_for`, `expires_at`） |
| 掲示・回覧 | `posts`（`target_scope` JSON, `attachments` JSON, `display_start_date`/`display_end_date`/`target_date`, `is_deleted`）, `bulletin_attachments`, `bulletin_comments`, `post_acknowledgements`（複合ユニーク `(post_id,user_id)`、status `UNREAD/READ/APPROVED/REJECTED`） |
| チャット | `chat_channels`（タイプは `GROUP`/`DM` のみ＝**職員全体チャンネル撤廃済み v3.1.2**。既定 `GROUP`）, `chat_channel_members`（複合PK + `is_hidden`）, `chat_messages`（`is_cancelled`）, `chat_message_reads` |
| 座席・施設 | `seating_status`（`desk_number`, `group_zone`, `current_status` `PRESENT/CLASS/TRIP/LEAVE`, `status_note`。座席セル実体はここに UPSERT）, `resources`（`sort_order`）, `reservations`（`is_cancelled`）, `facility_cells`（**未使用**: model 関数があるが呼び出し元・ルートなし）, `basic_rooms` |
| スケジュール | `school_schedules`, `schedule_categories`, `schedule_category_map` |
| 決裁・欠席 | `approvals`, `absence_records` |
| 監査・ロック | `audit_logs`（90日保持）, `system_audit_logs`, `editing_locks`（TTL 180秒） |
| 授業マスタ | `classes`（略称・運用状態、`course_ids` は旧コース名残りで `'[]'`）, `subjects`, `curriculum_subjects`（年間開講・標準試験時間50分・標準教室）, `curriculum_courses`（**運用廃止、旧データ互換で表のみ残す**） |
| 考査（22） | `exam_masters`, `exam_phases`, `exam_slots`, `exam_subject_plan`, `exam_subject_decisions`, `exam_trips`, `exam_timetable_rules`, `exam_proctor_rules`, `exam_room_rules`, `exam_rooms`, `exam_room_config`, `exam_room_assignments`, `exam_parttime_staff`, `exam_parttime_availability`, `exam_slot_history`, `exam_teacher_constraints`, `exam_teacher_exemptions`, `exam_proctor_assignments`, `exam_commands`, `exam_block_shapes`, `exam_block_groups`, `exam_block_conditions` |
| メール | `mail_accounts`（`password_enc`, `status` `UNVERIFIED/VERIFIED/FAILED`, `last_checked_at`）, `mail_messages`（`is_read`, `idx_…_time` 降順, `idx_…_unread`） |

**意図された設計:** 座席レイアウト geometry は DB に持たず（既定 6×8）、セル状態のみ `seating_status` に保持する。考査ステータスは `exam_masters` + `exam_phases` から導出する。教育ニュースは DB 永続化しない。`npm run db:tables` はコードが参照するテーブル名を一覧表示する（厳密な diff ではなく目視照合用）。

**考査の状態機械:** `exam_phases` の各フェーズ（`subject`調査, `decision`決定, `timetable`時間割, `trip`出張, `room_phase`教室割）は `DRAFT` → `PUBLISHED` → `ENDED`。`exam_room_assignments` は `UNIQUE (exam_master_id, class_id, day_number, slot_number)`、`exam_block_shapes`/`exam_block_groups` は `UNIQUE (exam_master_id, lower(name))`。`exam_slot_history` は過去考査の科目・日分布スナップショット（前後半の偏り均等化用）。

---

## 10. メール機能の暗号化と接続テスト

- `mail_accounts.password_enc` は **AES-256-GCM** 暗号文（`iv:tag:base64`）で保存し、**平文保存しない**。鍵は `sha256(config.auth.jwtSecret)` から導出（`src/models/mail.model.js`）。→ `JWT_SECRET` を変えたら既存暗号文は復号不能（§15 の是正案参照）。
- 接続テストは `src/services/mail.transport.js` が `node:net` / `node:tls` のみで実装。IMAP は `STARTTLS → LOGIN`、SMTP は `EHLO → STARTTLS → AUTH LOGIN`。ポート 143/25 は STARTTLS、993/465 は TLS 直結として扱う。タイムアウト既定 12秒（`MAIL_TIMEOUT_MS`）。新規 npm 依存は増やさない。
- 校内サーバー証明書は CN 不一致・自己署名が多いため **`rejectUnauthorized: false`**（SNI の servername は送る）。厳密検証は行わない（意図された設計）。
- 初期値（ホスト・ポート）は `.env` の秘匿実値、`.env.example` は空。未設定ユーザーのフォームプリフィルと未入力保存時のフォールバックに使う。
- 非TLS経路でのメール送受信は禁止（全通信 TLS 前提。§3 のCA信任が条件）。

---

## 11. 排他編集ロック・在席・在线

- `editing_locks`（`resource_type`, `resource_id`, 保持者）と Socket `lock:acquire`/`lock:release`。**無操作3分（既定180秒）で Cron が自動解放**し `lock:status_changed`（`isTimeout: true`）を一斉通知、クライアントは編集モードを自動解除する。座席セル保存は `checkEditingLock('seating')` が保持者以外を拒否。
- 在席状態は `seating_status.current_status`（`PRESENT`/`CLASS`/`TRIP`/`LEAVE`）+ `status_note`（行き先）。`PUT /api/auth/status`（REST）と `seating:update_status`（Socket）の両経路があり、更新は `seating:status_changed` で全端末へ反映。
- `onlineUserIds`（Set）で在线を保持。切断時に同じユーザーの他のアクティブソケットが無ければ `user:presence { isOnline:false }` を配信。

---

## 12. 定期タスク（`src/utils/cron.jobs.js`）

| 周期 | 内容 |
| --- | --- |
| 毎分（`0 * * * * *`） | 180秒以上更新がない編集ロックを解放 + `lock:status_changed`（タイムアウト）を一斉通知 |
| 毎時（`0 0 * * * *`） | 教育ニュース・天気キャッシュを `forceRefresh` で更新 |
| 監査ログ保持 | `AUDIT_RETENTION_DAYS` 既定90日（Cron maintenance で削除） |

---

## 13. ファイル添付

`src/services/upload.service.js`（262行）が `UPLOAD_DIR`（既定 `data/uploads`）に保存、`MAX_FILE_SIZE` 既定 10MB、`express.json` 上限 10MB。実体ファイルは `data/uploads/att_<uuid>.<ext>` で、DB の `bulletin_attachments` が参照するため**実体を消すと添付リンクが壊れる**（`data/uploads/*` は Git にコミット済み＝テスト固定データ）。

---

## 14. フロントエンド構成

- **エントリ:** `public/index.html`（910行、`<html lang="ja" class="theme-light-azure" data-theme-mode="light" data-chrome="light">`）。CDN: Tailwind + `lucide@latest` + `socket.io@4.7.5`。スクリプトは ES Modules（`main.js` 1,081行）。
- **共有層（7ファイル 2,464行）:** `main.js`(1,081) タブ切替・初期化、`ui-helpers.js`(436) 共通UI部品、`socket.js`(431) 接続と購読、`theme.js`(178) テーマ切替、`api.js`(155) 共通API呼び出し、`state.js`(106) トークン/ユーザー/テーマの localStorage 永続化、`config.js`(77) `API_BASE_URL='/api'`・`WS_BASE_URL=window.location.origin`・`ENDPOINTS`・`STORAGE_KEYS`・`DEFAULT_THEME='light-azure'`。
- **タブモジュール（12ファイル 8,936行）:** `chat`(1,526), `dashboard`(1,530), `bulletin`(1,410), `schedule`(1,178), `facility`(992), `mail`(515), `seating`(394), `absence`(308), `subjects`(308), `approval`(301), `news`(257), `about`(217)。
- **考査モジュール（12ファイル 5,297行）:** `exam.timetable.ui`(1,004), `exam.proctor.ui`(766), `exam.subject.ui`(576), `exam.room.ui`(548), `exam.decision.ui`(461), `exam.plan.ui`(428), `exam.basic.ui`(385), `exam.trip.ui`(261), `exam.view.ui`(240), `exam.module.js`(210), `exam.shared`(209), `exam.master.ui`(209)。
- **CSS 7ファイル（4,819行）:** `components`(1,604), `variables`(1,019), `readability`(1,013), `layouts`(555), `animations`(342), `theme`(167), `base`(119)。`base.css` の `!important` 制約より ID specificity + `!important` で優先させる実装慣例あり（例 `#chat-btn-toggle-hide[aria-pressed="true"]`）。
- **テーマ:** **18テーマクラス（実測）**。3系統 × 6配色。**light**（`theme-light-{azure,slate,forest,rose,amber,teal}`）、**dark**（`theme-dark-{navy,slate,emerald,amber,rose,plum}`）、**cb（色彩配慮・色覚多様性対応）**（`theme-cb-{azure,crimson,forest,slate,teal,violet}`）。既定は `light-azure`。`localStorage` の `is_system_theme_preference_v251` に保存し、`document.body.className` を差し替える。`<html>` は `data-theme-mode` と `data-chrome` を持つ。旧 localStorage との互換エイリアス（`hidden` テーマ）が定義されている。
- **サイドメニュー収納（`layouts.css` §6 と `main.js`、2026/11/7 変更・2026/11/9 実測値）:** **幅768px以上は画面幅を問わず常時収納**（67.25px・アイコンのみ正方形タイル `2.25rem`）。`.nav-badge`・`.sidebar-version` は `display:none`、`.nav-label` は `display:inline-block` のまま `max-width:0` + `opacity:0` で幅0（`display:none` の切替は縦・斜め移動になるため使わない）。ホバリング（`:hover` + JS `is-hover`）とフォーカス（JS `is-focus`）で 16.3rem（285.25px）へせり出し、ラベル・バッジ・項目内 `gap:0.55rem` を表示する。せり出しは `#app-body`（`position:relative` + `overflow:visible !important`）内の `position:absolute` オーバーレイで、`main` は `padding-left:4.2rem !important` により収納幅分の余白を常時確保する（収納状態で main が全幅を使う）。**広幅画面 (≥1100px) ではせり出しに `main` が追従する:** `@media (min-width:1100px)` で `#app-body:has(.app-sidebar:hover)`（JS の `is-hover`・`is-focus` も同selector）`main { padding-left:16.3rem !important }`（実測285.25px）とし、`padding-left` の 0.22s トランジションを sidebar スライドと同期して、コンテンツ左端がせり出しsidebar の右端に着地し**重ならない**。狭幅 (768〜1099px) は `main` を動かさないオーバーレイ維持（画面崩れ防止）。検証 `npm run test:ui:sidebar-push`（12項目: 1280/1150px で収納・ホバー追従・is-focus のみの追従・収納復帰、900px オーバーレイ維持、500px 画面下バー）。カーソル離脱・サイドバー外クリック・フォーカス移動で収納へ戻す（`:focus-within` はフォーカスを保持して閉じないため JS が `is-hover`/`is-focus` を管理）。767px以下は画面下バー（アイコンのみ、ホバリングでも文字は出さない）。収納時の項目は正方形タイル（`width:min(2.25rem,100%)`, `height:2.25rem !important`, `padding:0 0.1rem !important`, `margin-inline:0`）、ツールチップ `title` はラベルと同一文案（検証 `npm run test:ui:nav`）。せり出し時の項目高さは収納時と同じ `2.25rem` に固定する — せり出しで行が縦へズレると `mousedown`→`mouseup` の間に目標行が外れ、アイコンの初回クリックが吸収される（実測でタブが切り替わらなかった）。
- **トースト通知（`#toast-container`、2026/11/7 変更）:** 画面**右下**（`fixed bottom-4 right-4 z-40 flex flex-col items-end`）。z-40 はモーダル（z-50）の下・収納サイドバーのせり出し（z-30）の上。左下だと収納サイドバーのせり出しやチャット左カラムのフッター（`#chat-btn-toggle-hide` 等）を覆って実クリックがトーストに当たり、初回クリックが吸収される。767px以下では画面下バー（高さ3.9rem・z-40）を覆わないよう `bottom:4.4rem`（`components.css`）。コンテナは `pointer-events:none`、`.toast` 本体は `auto`。検証 `npm run test:ui:sidebar`（R6・M3）。
- **アクセシビリティ/レスポンシブ:** 通常テキストのコントラスト比 4.5:1 以上を保つ（`readability.css` と `npm run test:ui:contrast` / `test:ui:chrome` / `test:ui:contrast-plain` で検証）。`lg`（≥1024px）3カラム、`md` 未満は1カラム。グローバル検索は `Ctrl+K` / `Cmd+K`。
- **チャット「目のマーク」非表示編集モードトグル:** サイドバーフッター左下の `#chat-btn-toggle-hide`（アイコンのみ）。`aria-pressed` が ON 時のみグループ名横に非表示ボタン（`eye-off`）が出、ON は開いた目 `eye` + 警告色リング。色・枠は `components.css`、アイコンは `chat.module.js` の `setHideEditMode()` が差し替え `refreshLucideIcons()` を呼ぶ。回帰テスト `npm run test:ui:chat`（検証項目11）。
- **チャットは参加グループだけ（職員全体グループは撤廃済み、v3.1.2・v3.1.4、2026/11/9）:** サイドバーのグループ行（`#chat-channels-list` の `[data-channel-id]`）は自分が参加したグループのみ（seed は `kyomu`（📋 教務部連絡）と `suisin`（🧭 進路指導連絡）、決裁協議の `WORKFLOW` グループ、個人が作成したグループ）。職員全体グループの行は出ない（実測 ids は参加グループだけ、実測 names は「📋 教務部連絡」「🧭 進路指導連絡」＋作成グループ）。グループ行のアイコンは `users` のみ（全体タイプの `globe` 分岐は撤去済み）。サーバー側は `POST /api/chat/channels` の `type` を `GROUP`/`DM` ホワイトリストで寄せ、一覧のタイプは `GROUP` / `DM` / `WORKFLOW` の3つだけであることを `npm run test:ui:chat`（検証項目14・15）と `npm run test:socket-auth`（21項目）で実測する。
- **労いカードと開発・QA 用プレビューパネル（`#dash-fx-dev-panel`、2026/11/8 追加）:** ダッシュボード上部の労いカード（`.dash-fx-card`）は挨拶（`#dash-greeting`）と労いメッセージ（`#dash-warm-message`）を表示し、`#dash-fx-layer` に CSS keyframes のみの軽量粒子アニメーション（Canvas 不使用）を重ねる。粒子は落下系（`fx-fall` 桜・紅葉・雪）、降り注ぎ系（`fx-rain` 梅雨＝絵文字は傾き固定・回転なし・進行方向は下。JS が粒子ごとに 14〜24deg の傾きを inline の `--fx-tilt` で振り、keyframes は全 keyframe で同一の `rotate(var(--fx-tilt, 18deg))` を使う。Y は 0 から `--fx-drop` まで単調、横漂移 9px、大きさは変えない）、上昇系（`fx-rise` サンタ・ハロウィン・紙吹雪・七夕）、瞬き系（`fx-twinkle` 夜の星・陽光・日傘・海・お正月＝粒子ごとに inline の top を 4% + i*7% + 0〜5%（＝4〜72%）の帯で振るので枠全体に広がり、下半分にも粒子が出る。CSS の `top: 8%` は top 未設定時のフォールバック。落下系・上昇系は CSS が上端/下端に置くので JS は rnd を使わない）の13テーマ、10個（位置・duration 6〜12s・negative delay・font-size は `mulberry32(日付シード)` で同日中は固定・翌日変化）。**落下・上昇距離はカード高さを実測した `--fx-drop`（`setDashFxDrop()` が `offsetHeight+26` を設定、`ResizeObserver` で再計算）**に比例させ、粒子はカード底（上昇系は上端）に到達してから消える（CSS の `160px` は未計測時のフォールバックのみ）。`prefers-reduced-motion: reduce` では `.dash-fx-layer` を `display:none`（静的スウォッチでテーマを確認する）。労いメッセージは 時刻帯5（朝・昼・午後・夕方・深夜）× 曜日7 × 季節6（春・梅雨・初夏・夏・秋・冬）+ 特別な日 13 期間ウィンドウ（`DASH_EVENT_PERIODS`＝年始 1/1–1/3・仕事始め 1/5–1/6・3学期始業式 1/7–1/9・3学期終業式 3/23–3/24・新年度 4/1–4/3・1学期始業式 4/8–4/10・1学期終業式 7/17–7/20・2学期始業式 9/1–9/3・クリスマス 12/23・12/24・12/25・2学期終業式 12/26–12/28・年末 12/29–12/31。**年度で ± 日がずれる学校の節目は `from`/`to` の期間で捕捉し `dashEventPeriod()` が当日の期間を当て、同じ労い文を 3 日前後表示する**（単日項目は `from === to`。ゼロ埋め MM-DD の文字列比較＝日付順。期間が重なる年は先に定義した項目を優先。単日だけのテーマは `DASH_FX_SPECIAL`＝10/31・7/7・1/4・4/6））で「時刻帯文 + 曜日文 + (特別な日文 or 季節文)」を組み立て、`initDashboardModule()` の `setInterval(..., 60*1000)` が `renderDashGreeting()`（引数なし＝プレビュー設定を引き継ぐ）で再評価する。**年休等・出張の「記入する」ボタン（`dash-btn-absence`）は撤廃**し、モーダル内の常設記入フォームを使う（§14 参照）。
- **労いプレビューパネル（`#dash-fx-dev-panel`、ダッシュボード最下部、`bindDashFxDevPanel()`、開発・QA 用で運用では使わない）:** 折りたたまれても**常時表示されるコントロールバー**（`#dash-fx-dev-toggle`、`aria-expanded`/`aria-controls`、開閉で `#dash-fx-dev-body` が `hidden`）と注記を持つ。コントロールは ①アニメーションテーマ（`#fxp-theme`＝自動+全13、`#fxp-prev`/`#fxp-next` が cyclic 切替）②疑似日付 `#fxp-date`・疑似時刻 `#fxp-time`（JST Date 化、日付未設定は null）③時刻帯 `#fxp-slot`（自動+5）④曜日 `#fxp-week`（自動+7）⑤季節 `#fxp-season`（自動+6）⑥特別な日 `#fxp-event`（自動+なし+13。options は `bindDashFxDevPanel()` が `DASH_EVENT_PERIODS` から生成する（労いカードの表示ロジックと单一来源）。季節を明示選・「なし」選の時は特別な日文を抑えて季節文を確実に出す）⑦全メッセージ `#fxp-message`（時刻帯・曜日・季節・特別な日の 4 optgroup 31文を直接選択、selected text をそのまま労いカードへ）⑧静的スウォッチ `#fxp-swatches`（全13テーマの粒子）⑨復帰 `#fxp-reset`（全セレクト自動・疑似日付空・実日時へ、成功トースト）。全コントロールは `label[for]` と `input-field`/`btn-secondary`（枠線）を持つ。**疑似設定は `fxDevPreview` が労いカードの表示ロジックだけに影響し、実 API 呼び出し・年休等・出張・掲示板等の実データは変更しない。**検証 `npm run test:ui:fx`（`scripts/test-dash-fx.mjs` 54項目: ソース静的検証7（`bindAbsenceTile` に件数ゲート・disabled が無く open を常時結ぶ＝件数非依存を含む、梅雨の keyframes は `rotate(var(--fx-tilt))` だけ＝角度変化なしで落下距離は `--fx-drop`、JS が粒子ごとに `--fx-tilt` を振る、瞬き系は JS が inline の top を `4 + i * 7 + rnd() * 5`（%）の帯で振り CSS の `top: 8%` はフォールバック）、**校内行事カード見出しが「本日の校内行事」（「今日の」表記は出ない）1**、パネル常時表示/注記/開閉/復帰4、テーマセレクト+切替+スウォッチ+前/次6、**梅雨の降り注ぎ系4（`fx-rain` クラスと粒子10、傾きは全粒子 14〜24deg を実測、角度は進行中の 20%・50%・80% で 1deg 以内一致＝回転なし（実測 21deg）、Y は 20%→50%→80% で 55→138→220px と単調に下がる（`--fx-drop` 275px・カード高さ 249px）を Web Animations API の `currentTime` で実測）**、**瞬き系5（陽光・日傘・海・お正月・夜の星の各テーマで粒子10・inline top は 4〜72%・全粒子が枠内・上端と下端の差は枠高さの50%以上（実測 149〜150px／枠高 249px＝60%）・下半分に3個以上（実測4個）・keyframes 50%（translateY(10px)・scale 1.12）の最下点 200px は枠内（top 実測 30〜180px＝8.8〜68.6%）を px と % で実測）**、疑似日付 2026-12-24 と季節3・時刻帯1・曜日1、**特別な日 13 期間ウィンドウがすべて出る1＋セレクトが期間表から自動生成される1＋期間ウィンドウ算法7（2026-04-08・2026-04-10→第1学期始業式文+桜、2026-01-08→3学期始業式+紙吹雪、2026-03-24・2026-07-17→終業式+紙吹雪、2026-12-27→第2学期修了+サンタ、2026-12-29→大掃除+雪）**、2026-07-20 と「なし」2、全メッセージ 4組31文+選択2、復帰2、`--fx-drop` がカード高さ以上1、390px 幅の横スクロール/label・枠線2、記入ボタン撤廃・件数ラベル表示・タイルクリック・Enter・0名表示の5で登録・確認モーダルを開く（0名は MutationObserver で `#dash-absence-leave` を固定し実データは不変）。`test:ui:all` に組込み）。
- **職員掲示板の左列（タイトル列表）の幅（`layouts.css` §7.1、2026/11/10 変更）:** 左列は 16rem 固定をやめ、**床16rem・画面幅の26%・上限24rem** の `flex: 0 0 clamp(16rem, 26vw, 24rem)` にした（shrink は 0 — 768px で列が縮んで床を下回ると右ペインが列を圧し床が崩れるため）。ルート font-size 17.5px の実測: 768px→280px(16rem)、900px→280px、1100px→286px(16.34rem)、1280px→333px(19.0rem)、1440px→374px(21.4rem)、1600px→416px(23.77rem)、1750px以上→420px(24rem)で打ち止め。16rem 固定ではタイトル文字が195pxしか使えず、23文字のタイトル（実測 scrollWidth 387px）が途中で切れていた。実測でタイトル文字幅は1280pxで248pxへ広がった。右ペインは余り（`flex: 1 1 auto`・`min-width:0`。分割幅 − 左列 − gap(0.9rem)。1100px以上では右ペインが左列より広く、768pxでは右ペイン373px）。どの画面幅でも横スクロールなし。767px以下は従来どおり縦 stacking（左列全幅）。左列の枠は2px実線1枚・角丸0.8rem・影なし（UI十条1・禁则1/2）。収納サイドバー（収納67.25px）と左列は重ならない（実測 左列の左端 x=74、サイドバー右端67、`main` の padding-left 73.5px）。検証 `npm run test:ui:bulletin-title-pane`（`scripts/test-bulletin-title-pane-width.mjs` 14項目、`test:ui:all` に組込み。`test:ui:bulletin`（`scripts/test-bulletin-split.mjs`）の左右分割と長いタイトルの期待値も clamp 式（実測）へ更新した＝テストは削除していない）。


- **ダッシュボード「本日の連絡」未読バッヂ（v3.1、2026/11/8 追加）:** 「本日の連絡」カードは対象日が本日かつ掲示期間が本日有効な掲示のみ（既読・未読問わず、客户端キャッシュ latest 100 と件数一致）。カードは `<button data-bulletin-read="id" title="クリックで既読をつける">`（施設予約 `data-facility-open` と同慣習）で、クリックは `PUT /api/bulletins/:id/read` のみ（タブ移動もモーダル開閉もなし）。既読カードの再クリックは API を叩かない（冪等）。未読カードに未読マーカー（`.dash-news-unread-marker`）、既読カードはマーカーなし。ヘッダー右の `#dash-today-bulletin-unread` ＝ **本日未読**（「未読 N」）、サイドバー `#bulletin-unread-count`（数字のみ）＝タイトル `#bulletin-title-unread`（「未読 N」）＝ **全日未読**。**100 件以上は 99+ にキャップ**（`main.js` の `subscribeState('unreadCounts')` の `cap()` がサイドバー 99+／タイトルとダッシュボード「未読 99+」を書き出し、0 は `hidden`）。未読判定 `isUnreadForMe(b)` は `ackStatus` が UNREAD かつ **登録日以降の投稿**（`state.js` の `normalizeRegisteredDay(created_at)` を `state.currentUser.registeredAt` に保持。旧セッションに `created_at` が無い場合は制約なし＝全期間カウント）かつ **掲示期間が本日有効**（開始日未設定/≦本日、終了日未設定/≧本日）かつ `target_scope` 該当。よって登録日より古い記事（対象日=本日・掲示期間本日有効でも）と掲示開始前・掲示終了記事はバッヂに数えない。再計算は `bulletin.module.js` の `recomputeUnreadBadges()` が一元し、`setBulletinCache()`（ダッシュボードの 100 件取得）、`ingestBulletin()`（`bulletin:posted` 受信）、`markBulletinRead()`（PUT 成功後のローカル即更新）から呼ぶ。CSS は `components.css` §v3.1 未読バッヂ（サイドバー nav-badge と同一色系）。検証 `npm run test:ui:unread`（`scripts/test-dashboard-unread.mjs` 17項目、`test:ui:all` に組込み。99+ キャップは客户端キャッシュの上限が latest 100 のため擬似キャッシュ (CAPSIM) で 100 件未読を再現して DOM 表記を検証し、実キャッシュ復帰でバッヂが実データへ追従することも見る。実 DB に 110 件作ると掲示初期化の autoSelect（全文表示時点で既読化）が 1 件を既読化して 99 になるため使わない）。**既知の注意:** PostgreSQL `NOW()` がホスト時計より1日遅い環境があり、API 既定で作った記事の `posted_at` は DB 基準の日付になる（検証は `posted_at`/`created_at` を客户端基準の本日で明示する）。

- **記事共有モーダル（`#news-share-modal`、2026/11/8 追加、2026/11/9 に記事URLだけへ簡素化）:** ダッシュボードの「ピックアップ教育ニュース」ウィジェット右上ボタンは、存在しない `news` タブへ遷移していた「すべて見る」（`dash-btn-news-more`）を**撤廃**し、「記事を共有」（`#dash-btn-news-share`、title「記事URLを閲覧中の職員チャットチャンネルへ共有」）へ置き換えた。モーダルは `#news-share-form`（`novalidate`）に **記事URL入力欄（`#news-share-url`）だけ**を持つ（タイトル・ひとこと・共有先セレクト・チャンネル選択・掲示対象日は**撤廃**、`#news-share-form` 内の input/select/textarea は1個、submit ボタン1個、**常設説明文 `<p>` も撤廃**＝モーダル本文に出る文字はラベル「記事URL *」だけ。UI十条9・禁则6 に従い、スキーマ補完などの説明はプレースホルダー「https://mext.go.jp/...（スキーマ無しは https:// を補完）」と `title` とトーストだけで伝える。URL入力欄は入力の7条件（`type=url`・`id`・`name=news-share-url`・`autocomplete=off`・`aria-label=記事URL`・`label[for]`・`border-main` 2px実線）を満たす＝禁则8）。URLは必須で、スキーマ無し（例: `mext.go.jp/...`）は `https://` を補完し `new URL()` で検証、ドットを含まない hostname（例: `foo`）は拒否してエラートースト（モーダルは開いたまま入力内容を保持）。**投稿先は職員チャットの「閲覧中グループ」に固定**（`chat.module.js` の `getShareableChatChannelId()` を export し、`resolveShareChannelId()` が読む。チャットをまだ開いていない初回は先頭の非表示グループ、**グループが未作成のときは null を返し共有を送らない**＝エラートースト「共有先の職員チャットグループがありません」。職員全体チャンネルは撤廃済み v3.1.2）。本文は `【記事共有】{ドメイン名}\n{URL}` の **2行**（タイトルは `defaultShareTitle()` の hostname、`www.` を除去、ひとことなし）。送信は `POST /api/chat/channels/:id/messages`、成功で成功トースト＋`switchTab('chat')`、失敗時はモーダルを開いたまま。閉じ方は右上X・フッター「閉じる」・背景クリック・ESC の共通規約（`ui-helpers.js` の `initModalListeners`）。検証 `npm run test:ui:news-share`（`scripts/test-news-share-modal.mjs` **20項目**: 入力欄がURLだけ／**常設説明文なし（`p` 0・モーダル本文の表示文字はラベル「記事URL *」だけ）**／**URL入力の7条件を computed style で実測（border-top-width 2px・border-top-style solid）**／**補完規則はプレースホルダーと `title` のみ**／本文2行の完全一致／投稿先がチャットサイドバー `.active` のチャンネルと一致／サーバー実データへの登録／閉じ方（X・フッター・ESC・背景）とアイコン実描画）。
- **考査「基本情報の登録」の行の追加は最上部・未入力の行1件だけ・ボタン無効（2026/11/10、考査 41）:** `public/js/modules/exam/exam.basic.ui.js` の `addRow` は新行を `tbody.prepend`（クラス30件・科目9件・部屋7件の表で末尾に足すと書く場所が画面下のずっと下へ移動するため、入力と保存の操作距離が最短の最上部へ）。追加直後に `main.scrollTop` を現在値へ戻し画面常時スクロール禁止（UI十条7）を守る。未入力の行（`data-id` が空）が1件ある間は「行の追加」ボタン（`#exam-add-<table>`）が `disabled`+`aria-disabled=true`（DOMクリックにも防御ハンドラ）、未入力の行が消えたら復活（`isBlankRow`/`hasBlankRow`/`syncAddButton` で一元管理、CSS は `.btn-warning:disabled` がグレー一色・白抜き・影なし）。未入力の行の「保存」がサーバー制約（クラス名は初期29名固定・学年内重複不可＝409）に当たると未入力の行は残りボタン無効のまま。未入力の行の「削除」は行をUIから破棄しボタン復活。説明文は常設せず `title`「未入力の行が1件ある間は使えない」+`aria-label`+トーストのみ（UI十条9）。検証 `npm run test:ui:examaddtop`（`scripts/test-exam-basic-add-top.mjs` 22項目: 未入力の行が先頭（実測 top 487px < 保存済み行 552px < 末尾行 2426px）、`main.scrollTop` 0→0、ボタン disabled、2回押しても31件のまま、保存 201→ボタン復活、未入力の行の削除 200→ベースライン復元、部屋 8→9→201→200→8、科目 9→10→201→200→9、クラス 30→31→409系→30、学年順＋名前順不変。部屋と科目は自由な名前、クラスは初期名で検証）。



---

## 15. セキュリティ

### 15.1 実装済み（現行コードで確認）

- 全アプリ通信は TLS（HTTPS/WSS、`SSL_PORT` 3443）。非HTTPポートは CA 配布専用で API を `426` 拒否。
- `helmet` セキュリティヘッダー、CORS は `CORS_ORIGIN` / `CLIENT_ORIGIN` の明示リスト（wildcard `*` 既定化は廃止）、`express.json` 10MB上限。
- JWT（`Bearer`）検証 + RBAC ミドルウェア、bcrypt(10) ハッシュ、`JWT_EXPIRES_IN` 24h。
- Socket 接続は Origin 許可リスト＋JWT 厳格検証、ハンドラーにロール/メンバーシップ gate（§8.4、`src/middlewares/socket.middleware.js`）。
- 監査ログ（`audit_logs` / `system_audit_logs`、500系は `SERVER_ERROR` として stack を監査ログへ）、`AUDIT_RETENTION_DAYS` 既定90日保持。**v3.0.7**: 失敗ログインを `LOGIN_FAILED`（user_id は該当ユーザー、未登録時は NULL、ip_address、new_value に identifier+reason）として記録（成功 `LOGIN` のみの旧実装から拡張）。
- **アクセスログファイル (v3.0.8, §15 #5 ログ権限/保存期間管理)**: `src/utils/access-log.js` が morgan ファイルストリーム `data/logs/access-YYYY-MM-DD.log` (日次ローテーション、ディレクトリ mode 700、ファイル mode 600、IP・URL・ステータスコードのみ。bcrypt ハッシュ・パスワードは記録されない) を生成。cron 3:00 AM が `AUDIT_RETENTION_DAYS` (既定 90日、config.limits.auditRetentionDays) で監査ログ (`audit_logs` / `system_audit_logs`) とアクセスログファイルを経過削除 (`cleanOldAuditLogs` の重複定義を統一し、両テーブル削除)。stack トレースは `NODE_ENV=development` かつループバック (127.x / ::1) 要求のレスポンスのみ返り、本番・LAN 越しでは返らない。パスワード照合失敗ログは identifier のみ。検証: `npm run test:logsecurity` 9項目。
- エラーレスポンスの stack trace は **`NODE_ENV=development` のみ**（本番では出さない）。
- 座席セル・施設予約等の業務単位での排他ロック（3分自動解放）、二重予約 409。
- メールのパスワードは AES-256-GCM 暗号保存（平文不可）。

### 15.2 既知の課題（2026/11/7 監査で確定した重大度順・**#1 と #9 一部は対応済み**、#2 以降は未対応）

- 2026-11-10 (考査 41): 考査「基本情報の登録」の「行の追加」を最上部・未入力の行1件限定・ボタン無効へ変更し、配置ルールを測る回帰テストを新設。**検証状況（Windows 実測 2026-11-10）: 新規テスト 22項目通過（PASS 22・failure 0）、考査 basic 系6スイート通過、`npm test` 12スイート/150テスト通過（Windows 実測 10.1秒、`pretest` でDB初期化＋シード）、`api:check` 50API呼び出し＋10検証マーカー通過（409二重予約と404存在しないコードは意図された応答、失敗0、サーバー稼働中、PID 29616）、`test:ui:all` の29スクリプトを Edge と `https://127.0.0.1:3443` で実測し25スクリプト通過、4スクリプト失敗（https 9項目＝ユーザーCA信頼未登録、unread 3項目・timeline 1項目・bulletin-unread 9項目＝`NOW()` とホスト時計の1日差による日付依存項目）、`verify-docs` 失敗0（NG 0）。`ui:audit`（13ビュー目視）は人間の確認待ち**。
  - 変更: `addRow` が新行を `tbody.prepend`（クラス30件・科目9件・部屋7件の表で末尾に足すと下へスクロールして書く羽目になるため、入力と保存の操作距離が最短の最上部へ）、追加直後に `main.scrollTop` を現在値へ戻し画面常時スクロール禁止（UI十条7）を守る。未入力の行（`data-id` が空）が1件ある間は「行の追加」ボタンが `disabled`+`aria-disabled`（`.btn-warning:disabled` はグレー一色・白抜き・影なし、`components.css` §5b で全ボタン共通）、DOMクリックにも防御。未入力の行の「保存」はサーバー制約（初期29名固定・学年内重複不可＝409）で 409 が返り未入力の行は残る。未入力の行の「削除」は行をUIから破棄しボタン復活。説明文は常設せず `title` と `aria-label` とトーストのみ（UI十条9）。実測: 未入力の行 top 487px < 最初の保存済み行 552px < 末尾行 2426px、`main.scrollTop` 0→0、ボタン disabled=true、2回押しても31件のまま、部屋 8→9→保存201→削除200→8、科目 9→10→保存201→削除200→9、クラス 30→31→409系→30、学年順＋名前順不変。クラス名の制約（初期名の重複保存 409、使用中の行の「削除」は使用状況照会後 DELETE 非送信、初期名の直接 DELETE 409）も実ブラウザで実測。テストの削除・スキップなし、`pretest` 未実行、DB破壊なし。UIテストの CHROME 既定は Edge（`CHROME_PATH` で上書き可）、`UI_BASE=https://127.0.0.1:3443`（IPv4）。テスト総数は Windows 実測 **150**（12スイート直列）、UIスイートは **25スクリプト**、`api:check` **131**。


| # | 重大度 | 内容 | 是正案 |
| --- | --- | --- | --- |
| 1 | **Critical**（**対応済み 2026/11/7**） | `src/sockets/socket.index.js` が `NODE_ENV≠production` で JWT 検証失敗時に `dev-user`（role `TEACHER`）として接続を許可し、`demo-jwt-token-*` を無条件で通していた。Socket ハンドラーにロール検証がなく、socket.io の cors origin は `*`。**`wss://0.0.0.0:3443` に有効 JWT なしで職員全体チャンネルへ書き込み可能**だった | **実装済みの是正**: `src/middlewares/socket.middleware.js` を新設し、(a) Origin 許可リスト照合（`server.js` の cors も同一関数）、(b) `verifySocketToken()` で常時 `jwt.verify`（デモ/fallback 廃止）、(c) `seating:update_status` 本人限定＋ステータスホワイトリスト、(d) `seating:grid_updated` は KYOMU/ADMIN のみ、(e) `lock:*` は種別ホワイトリスト・自保持のみ解放（`getActiveEditingLock`/`refreshEditingLock` の実体欠如も修正）、(f) chat はメンバーシップ検証、(g) UI は認証失敗で再接続を停止。`.env` は `NODE_ENV=production` と明示 Origin リストへ変更。回帰検証 `npm run test:socket-auth`（20項目 PASS） |
| 2 | **Critical** | 既定 `JWT_SECRET`（`is_system_secret_key_2026_default_jwt`）が `.env.example` に平文公開済み。この秘密鍵で ADMIN トークンを伪造すると `/api/users`・`/api/audit/logs` に到達可能。同じ秘密鍵がメール AES 鍵の導出元（`mail.model.js` は `sha256(config.auth.jwtSecret)`） | `openssl rand -hex 32` で採り `.env` 秘密化、既定値をコードに残さない。メール鍵は `MAIL_ENC_KEY` として JWT と分離（移行は再暗号化マイグレーション）。**注意**: `JWT_SECRET` は bcrypt ソルトにも使われているため、変更時は全ユーザーのパスワードハッシュ再作成（`npm run db:seed` 相当の再ハッシュ）が必須 |
| 3 | **High** | `/api/users`（一覧・作成・削除）は `authenticateToken` のみ。**`TEACHER` が ADMIN アカウントを作成・削除できる**（`requireAdminRole` は定義済みだが未適用） | `POST /users`・`DELETE /users/:id` に `requireAdminRole`（または `requireKyomuRole`）を付与 → **✅ v3.0.5 で実装**（`POST /users`=K、`DELETE /users/:id`=Ad、招待発行・チャンネル削除=K。コントローラで role 再検証、一覧はロール別最小化、権限昇格抑止。`npm run test:rbac` 17項目 ALL PASS） |
| 4 | **High** | ログイン・招待コード登録に**レート制限・アカウントロックアウトがない**（`express-rate-limit` 依存なし）。招待コードは8文字16進（4バイトエントロピー）で試行攻撃に対して弱い | `express-rate-limit` を `/api/auth/login` と `register-invitation`/`reset-password-invitation` に適用。コードは6バイト以上＋試行上限 → **✅ v3.0.7 で実装**（コードは 128bit=32文字大写、ログイン IP+識別子 15分5回失敗=429、ユーザー単位ロック 423、コード単位 15分5試行、失敗時 `LOGIN_FAILED` 監査。`npm run test:ratelimit` 8項目 ALL PASS、`test/auth.test.js` 8b で 423 検証） |
| 5 | **Medium** | `src/services/auth.service.js:86` がパスワード照合失敗時に **`dbHash`（bcryptハッシュ全文）をログへ出力**（morgan と併せてサーバログに流出） | `dbHash` を出さず `identifier` のみにする → **✅ v3.0.7 で実装**（照合失敗ログは identifier のみ）→ **✅ v3.0.8: ログ権限/保存期間管理 + stack 応答秘匿**（アクセスログファイル dir 700 / file 600・日次ローテーション・90日保持 cron、`cleanOldAuditLogs` 重複定義統一で `system_audit_logs` も削除、`NODE_ENV=development` の stack 応答はループバック要求のみ、`npm run test:logsecurity` 9項目 ALL PASS） |
| 6 | **Medium** | `CSP` が `false`（インラインスクリプト・CDN許可）＋ Tailwind/Lucide/socket.io を CDN から読む。UI にユーザー入力が入るため XSS 表面が広い | コンテンツセキュリティポリシーを段階的に有効化、CDN をローカルへ自前配布 |
| 7 | **Medium** | JWT を `localStorage`（`is_system_jwt_token_v251`）に保存するため XSS でトークン流出する | 短期有効 + HttpOnly Cookie セッションへ移行 |
| 8 | **Medium** | メール接続テストは `rejectUnauthorized: false`（意図された設計）だが、中間者攻撃に対して STARTTLS が検証されない | 校内CAの指紋を `.env` に登録して pinning をオプション化 |
| 9 | **Low** | 開発モードで `morgan('dev')` がリクエストパス・ユーザー名等をログ出力、監査ログの `SERVER_ERROR.details.stack` はスタックトレ全文を含む | 本番ログレベルと保持期間を運用で固定 |

**優先対応順:** ~~#1~~（対応済み）→ #2 → #3 → #4 → #5。対応後は `npm test`（139テスト）、`npm run test:socket-auth`（20項目）、`npm run test:ui:https`（27項目）、`npm run test:ui:chat` で回帰確認する。

---

## 16. 意図された非実装・履歴（仕様として明示）

- **督促:** 掲示板 `POST /api/bulletins/:id/remind` と決裁 `POST /api/approvals/:id/remind` は**実装されている**。旧UI/旧仕様書の「廃止済み」表記は古い（v3.0.0 で訂正）。
- **未使用コード:** `src/sockets/socketEvents.js` / `src/sockets/socketClient.js`（§8.3）、`facility.model.js` の `updateCells()`/`getCells()`（`facility_cells` への書き込み経路が未接続、§7.4）。
- **旧データ互換:** `curriculum_courses`（運用廃止、表のみ）、`classes.course_ids`（`'[]'` 維持）、`posts.post_type`/`priority`（カラム削除済み）、`invitation_codes` 二重定義、`audit_logs` と `system_audit_logs` の併存。
- **DB 永続化なし:** 教育ニュース・天気（インメモリキャッシュのみ）。
- `news` タブは無い（ダッシュボードウィジェット）。ウィジェット本文 `#dash-news-summary` は共有リンク（`news_links`＝`GET /api/news/links`）だけを新しい順に描画する（`loadSharedNewsLinks()`）。共有は手入力URLの `POST /api/news/links`（server がページタイトルを取得し、取れない日はドメイン名がタイトル）。職員チャットへは投稿しない（v3.1.7・禁则16）。検証は `npm run test:ui:news-share`（21項目・テストが作った共有リンクは後片付けで消す）。
- 単一HTML構成・NAS配置のみでの運用は現行アーキテクチャ（Express + PostgreSQL + TLS）**では成立しない**（旧 UI/UX 仕様書の記述は廃止）。

---

## 17. 運用・テスト

**コマンド**（詳細は `README.md`）: `npm run db:create` / `db:init` / `db:seed` / `cert:gen` / `npm start`（`npm run dev` = nodemon）/ `npm test` / `npm run api:check` / `npm run db:tables` / `npm run db:drop-general-chat` / `npm run test:socket-auth` / `node scripts/verify-docs.mjs`。

**テスト実行の順序と制約（AGENTS.md 第5条・第6条、2026-11-11 改訂）:** 検証は**階層式**。開発中は該当分だけ — サーバー側は `npm run test:one -- test/<該当>.test.js`（`--runInBand` 直列・`pretest` を踏まない＝DBを作り直さない）、UI・レイアウトは該当 UI スイートを1〜3本。機能単位のコミット・リリース直前は全ゲート `npm test` → `npm run api:check`（`npm start` 起動後）→ `npm run test:ui:all` → `node scripts/verify-docs.mjs` をこの順序で直列に回す。全テストが同一DB `issystem` を共有するため、複数 Jest を並列実行するとテーブル・レコードが衝突して失敗する（失敗時に「DBのテーブル・レコードを消せ」と言わない。DB破壊は禁止）。UI テストは `npm start`（HTTPS/WSS 3443）が起動している状態で実行し、**サーバー側のコードを変えたらサーバーを再起動してから回す**（古いコードに当たって偽の失敗が出る）。UIスイートは共有DBの状態（投稿・既読・fixture）を作るため、前実行の残りで後スイートが失败することがあり、`npm run db:seed` で状態を戻して再実行する（DB破壊はしない）。CA信頼はユーザー環境で一度だけ登録し、npm script に `NODE_EXTRA_CA_CERTS` は埋め込まない（テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）。全ゲートの合否はコード起因の失敗 0 で判定し、CA信頼未登録・UI残存状態・`.env` の `PORT` ズレは設定・状態の問題として人間に確認する。テストの削除・スキップ・無効化は禁止（仕様変更時は期待値を現実へ更新）。UI十条の正典は `README.md` に置き、AGENTS.md は要点参照（寸法・色分け・せり出し・追従・初回クリックの検証は `test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:frames` の px 実測）。検証用一時成果物（`data/`・`ui*.txt`・`t*.txt`・`vd*.txt`・`api*.txt`・`nohup.out` 等）は `.gitignore` で無視し Git に追跡しない（AGENTS.md 第10条）。`verify-docs` は文書の文言一致を検査せず、被覆・寸法・機能・追跡状態だけを検査する（2026-11-11 改訂）。

**Jest 統合テスト:** 12スイート・150テスト（`--experimental-vm-modules --runInBand`、`pretest` が `init-db` + `seed` を実行）。共通ヘルパー `test/helpers.js`（`loginToken`, `bearer`, `pickId`, `closePool`）。スイート: `auth`, `facility`, `approvals`, `bulletins`, `chat`, `invitation`, `exam`, `absence`, `schedules`, `mail`, `unread-count`, `error-middleware`。jest は `<rootDir>/test/**/*.test.js` を対象し `/node_modules/` と `<rootDir>/.kilo/` を無視（`.kilo` は削除済み＝無害な履歴設定）。

**UI 検証スクリプト（`puppeteer-core`、サーバー自己起動）:** `test:ui:https`（CA検証・TLS・CAページ・API 426・CA配布・ブラウザ wss 接続・非HTTP ws 拒否の 27項目）、`test:ui:all`（**29スクリプト**の回帰: https / modal / news-share / fx / frames / audit / chrome / contrast / contrast-plain / scan / header-frames / nav / sidebar / sidebar-push / facility-header-sticky / facility-order / bulletin / unread / bulletin-search / bulletin-unread / schedule / chat / facility / timeline / mail / exambasic / examaddtop / seating / block。Windows 実測 2026-11-10: 25スクリプト通過、4スクリプト失敗（https 9項目＝ユーザーCA信頼未登録、unread 3項目・timeline 1項目・bulletin-unread 9項目＝`NOW()` とホスト時計の1日差による日付依存）。`node scripts/verify-docs.mjs` が全 `scripts/test-*.mjs`（puppeteer 使用）の漏れなし inclusion を検証）。`test:ui:mail`（37項目）。API 検証: `api:check`（スモーク）、`test:api:mail-defaults`（12項目）、`test:api:mail-test`（6項目）。Socket / セキュリティ検証: `test:socket-auth`（21項目。職員全体グループが一覧に出ないことを含む）、`test:rbac`（17項目）、`test:ratelimit`（8項目）、`test:logsecurity`（9項目）。ドキュメント矛盾検出: `node scripts/verify-docs.mjs`。Node 側の API 呼び出し・socket.io は `ca: [certs/issystem-ca.crt]` を明示して TLS を通す（素の `fetch` は自己署名チェーンで `SELF_SIGNED_CERT_IN_CHAIN` になり落ちる＝`test:ui:chat` / `test:ui:seating` / `test:socket-auth` で 2026/11/9 修正）。

**開発メモ:** 二重予約判定は `toDateTime()` で `HH:MM` → `YYYY-MM-DD HH:MM:SS` 正規化。システムメッセージの `sender_id` は FK 制約のため `resolveSenderId()` で `system` ユーザーへ変換。`ensureSchema()` はプロメモ化（複数プロセス同時適用で「pool closed」防止）。スモークテストは `npm start` 起動後に `npm run api:check`。

**環境メモ:** 開発は Windows（`C:\Program Files\PostgreSQL\18`）→ 現行環境は Linux（`/home/iriko/programing/ISSystem`）。DBパスワード `otome601`、アプリ共通パスワード `password123`（教務主任 `T2026001`）。`npm test` は DB に `issystem` テストデータを再投入する。

---

## 18. 改訂履歴

| バージョン | 日付 | 内容 |
| --- | --- | --- |
| v1.0.0〜v2.2.0 | 2026/09〜2026/10 | 旧 `システム機能仕様書.md` / `ＵＩ・ＵＸ仕様書.md` / `データベース仕様書.md` / `仕様書.md` / 各種分割計画 txt に分散（**実装との乖離により削除**） |
| **v3.0.0** | 2026/11/7 | 現行コード（`src`+`config` 23,482行、`public` 21,082行（JS 31ファイル 15,793行・CSS 7ファイル 4,406行・`index.html` 883行）、`db/schema.sql` 1,262行・51テーブル/77インデックス）を計測し**単一正典として再構成**。Socket 認証バックdoor・JWT 既定鍵・`/api/users` の RBAC ギャップ・レート制限欠如・ログ流出を既知課題として明文化（§15）。`README.md` は運用手順書として維持 |
| **v3.0.1** | 2026/11/7 | §15.2 **#1 を実装で解消**。`src/middlewares/socket.middleware.js` 新設（Origin 許可リスト照合・JWT 厳格検証・`socketHasRole`・`sanitizeSocketString`・リソース種別ホワイトリスト）、`socket.index.js` から demo/fallback を削除、`seating.socket.js` に本人限定と KYOMU/ADMIN gate、`lock.socket.js` は model の位置引数署名へ修正＋自保持のみ解放（`audit.model.js` に `getActiveEditingLock`/`refreshEditingLock` を実装＝旧 export の実体欠如を解消）、`chat.socket.js` にメンバーシップ検証、`app.js`/`server.js` の CORS を wildcard 既定化から明示リストへ変更、UI は認証失敗で無限再接続を停止。`scripts/test-socket-auth.mjs`（20項目）と `npm run test:socket-auth` を追加。回帰: `npm test` 139テスト PASS、`npm run test:ui:chat` ALL PASSED |
| **v3.0.2** | 2026/11/7 | **サイドメニュー収納を画面幅に関係なく適用**（§14）。`public/css/layouts.css` §6 の条件を `@media (min-width:768px) and (max-width:1023px)` → `@media (min-width:768px)` に拡張し、768px以上は常時 3.6rem（アイコンのみ）収納・ホバリング/フォーカスで 12.5rem せり出し。`public/js/main.js` の matchMedia も `(min-width:768px)`（`is-hover`/`is-focus` 管理は同一）。回帰: `test:ui:nav`（title/label 45件一致、1280px で sidebar=63px→hover 218.75px）、`test:ui:frames` 18項目 PASS、`test:ui:all` |
| **v3.0.3** | 2026/11/8 | **ダッシュボードの「すべて見る」を撤廃し「記事を共有」モーダルへ置換**（§14）。`dash-btn-news-more`（存在しない `news` タブへの遷移）を削除し、`dash-btn-news-share` が `#news-share-modal`（URL・タイトル・ひとこと・共有先、チャンネル選択／掲示対象日）を開く。送信はチャット `POST /api/chat/channels/:id/messages`（`【記事共有】`）と掲示板 `POST /api/bulletins`（`【参考記事】`+URL+対象日）。URL はスキーマ無しを `https://` へ補完し `new URL()` で検証、空・不正はトースト警告で送信しない。`scripts/test-news-share-modal.mjs`（21項目）と `npm run test:ui:news-share` を追加（`test:ui:all` へ組込み）。現行測定: `public` 21,726行（JS 31ファイル 16,228行・CSS 7ファイル 4,590行・`index.html` 908行）。回帰: `test:ui:news-share` 21項目 ALL OK、`test:ui:modal` ALL OK、`test:ui:sidebar` 68項目 PASS、`test:ui:chat` 32項目 PASS、`test:ui:seating` ALL PASSED、`test:ui:frames` 17/18項目 PASS（残りはサイドバー収納アイコンのクリッピング項目＝既存の既知 failure、本変更とは無関係） |
| **v3.0.4** | 2026/11/8 | **監査 Critical 対策: JWT secret 強制・メール暗号キー分離・平文フォールバック撤去**（§2）。`.env` の `JWT_SECRET` を `openssl rand -hex 32`（64文字16進ランダム）へ再生成し、専用 `MAIL_ENC_SECRET`（同生成手順・JWT とは必ず別値）を新設。`config/default.js` は未設定・32文字未満・既知既定値（`is_system_secret_key_2026_default_jwt` / `dev-secret-key-change-in-production` / `changeme` 等）・`MAIL_ENC_SECRET==JWT_SECRET` を**起動時に throw**（fail-fast、既定値フォールバック撤去）。`src/models/mail.model.js` の AES-256-GCM キーは JWT 導出（sha256）をやめ `scrypt(MAIL_ENC_SECRET, 'issystem-mail-enc-v2', 32)` の別系統へ分離（JWT 流出で全メールパスワードが復号される被害を断った）。`src/services/auth.service.js` の SHA-256(password+secret) フォールバックと `storedHash === password`（平文一致）を撤去し bcrypt のみ（seed は bcrypt）。ローテ手順: `JWT_SECRET` 変更時はサーバー再起動（全トークン失効）、`MAIL_ENC_SECRET` 変更時は `npm run rotate:mail-key -- OLD_JWT_SECRET=<旧>`（`scripts/rotate-mail-enc-key.mjs` が `mail_accounts` を新キーへ再暗号化）。実測検証: 旧既定 secret での FORGED-ADMIN トークンは `/api/auth/me` `/api/audit/logs` `/api/users` すべて 403、sha256(旧既定secret) 暗号化行はローテ後 scrypt 新キーで復号、`npm test` 139/139、`test:api:mail-test` 6/6、`test:ui:mail` ALL PASS、`test:api:mail-defaults` ALL PASS、`test:socket-auth` 20件/失敗0、`test:ui:news-share` ALL OK。なお `.env` のメール初期値（§8）をテストの「Git追跡ファイルに実値なし」項目に配慮し `imap.dev.example.net:143` / `smtp.dev.example.net:25`（到達不能 example）へ整備した |
| **v3.0.6** | 2026/11/8 | **サイドメニューせり出しに main が追従（広幅は重なりなし）**（§14）。`public/css/layouts.css` §6 に `@media (min-width:1100px)` を追加し、せり出し (`:hover` / JS `is-hover` / `is-focus`) 時 `#app-body:has(...) main` の `padding-left` を 4.2rem → 16.3rem（実測285.25px）へ 0.22s（sidebar と同一イージング）で遷移させ、コンテンツ左端が sidebar 右端に着地して重なりを消去。768〜1099px はオーバーレイ維持（main 不動・画面崩れ防止）、767px 以下は画面下バーで無変更。`scripts/test-sidebar-push.mjs`（12項目）と `npm run test:ui:sidebar-push` を追加。回帰: `test:ui:sidebar-push` 12項目 ALL PASS、`test:ui:sidebar` 68項目 ALL PASSED、`test:ui:nav`（45件一致・sidebar 67.25px→hover 285.25px）、`test:ui:chat`、`test:ui:seating` |
| **v3.0.5** | 2026/11/8 | **RBAC 強化: ユーザー管理・招待コード発行・チャンネル削除の権限昇格を消去**（§5・§7・§15）。`src/routes/index.js` に `requireKyomuRole` を `POST /api/users`・`POST /api/auth/generate-invitation`・`DELETE /api/chat/channels/:channelId`、`requireAdminRole` を `DELETE /api/users/:id` へ適用（`requireAdminRole` は定義済み未適用だった）。コントローラ（`auth.controller.js` の `isPrivilegedUser`、`chat.controller.js`）でも `req.user.role` を再検証する第二防衛線を設置。`GET /api/users` は `password_hash` を全ロールで一切返さなくなり、TEACHER には名簿最小フィールド（email・内線除去）、KYOMU/ADMIN のみ全件。KYOMU が作成するアカウントの role は TEACHER 固定（ADMIN 昇格は ADMIN のみ）。UI は招待コード発行カード（`invitation-issuance-card`）とユーザー管理メニューを非教務部で非表示化（`main.js`/`index.html`）。招待コード発行は自主分散から教務部発行へ変更（§6 更新、jest テストは KYOMU トークン使用で無影響）。`scripts/test-rbac-user-admin.mjs`（17項目）と `npm run test:rbac` を追加。回帰: `npm test` 139/139、`test:rbac` 17項目 ALL PASS、`test:ui:chat`、`test:ui:seating`、`test:socket-auth` 20件/失敗0 |
| **v3.0.7** | 2026/11/8 | **ログイン総当たり対策: レート制限・ユーザー単位ロックアウト・LOGIN_FAILED 監査・招待コード 128bit 化**（§5・§6・§13・§15 監査 #4/#5）。`src/middlewares/rate-limit.middleware.js` を新設（**express-rate-limit v8**、メモリストア、`package.json` 依存追加）。ログイン: `authIpLimiter`（IP グローバル失敗のみ 1時間200回→429）＋ `loginLimiter`（IP+識別子小文字キー、失敗のみカウント、15分5回超限 429 JSON）。招待登録 `registerInvitationLimiter`（IP+コード 15分5試行）、招待リセット `resetInvitationLimiter`（IP+コード+staff_code 15分5試行）、発行 `generateInvitationLimiter`（IP+ユーザー 15分30回）。`/auth/register`・`/auth/reset-password`・`/auth/invite-code` エイリアスにも同一適用。IPv6 は `ipKeyGenerator` で /48 束ね（trust proxy 未設定＝X-Forwarded-For 非信用）。ユーザー単位ロックアウトは `auth.service.js` のプロセス内 Map（15分窓 5 回失敗→15分ロック、423。成功ログイン・サーバー再起動で解除、DB 永続化はせず—`LOGIN_FAILED` 監査で検知）。失敗ログインは監査 `LOGIN_FAILED`（ip_address + reason: `user_not_found`/`bad_password`/`locked_out`）を記録し、照合失敗ログの `dbHash` 出力を廃止（§15 #5）。招待コードは `crypto.randomBytes(16)` = 32文字16進大写（128bit）。UI は 429/423 の message を `login-error` に表示（`api.js` の非 OK 分岐）。テスト: `test/auth.test.js` 8b（サービス直結で 5 回 401→6 回目 423、`LOGIN_FAILED` 5件以上を DB count、`clearLoginLockForTests` で後片付け）、招待コード正規表現 8→32文字へ（`auth.test.js`・`invitation.test.js`・`test-rbac-user-admin.mjs`）、`scripts/test-login-ratelimit.mjs`（8項目）と `npm run test:ratelimit` を追加（不存在ユーザー 25 回失敗→401×5+429×20、LOGIN_FAILED delta=5、32文字コード、架空コード 400×5→429、初回登録 201、使用済み 400、ADMIN 後片付け 200。実行ごとに一意な識別子・コードでウィンドウを共有しない）。実測: `npm test` 140/140、`test:ratelimit` 8/8、`test:rbac` 17/17、`test:ui:sidebar-push` 12項目 ALL PASS、`test:ui:nav` 45件一致、`test:ui:chat` ALL PASSED、`test:ui:seating` ALL PASSED |
| **v3.0.8** | 2026/11/8 | **ログ秘匿・保持管理: アクセスログファイル権限/保持、stack 応答秘匿、cleanOldAuditLogs 統一**（§5・§13・§15 監査 #5）。`src/utils/access-log.js` を新設: morgan ファイルストリーム `data/logs/access-YYYY-MM-DD.log` を日次ローテーション（ディレクトリ mode 700、ファイル mode 600、append。bcrypt ハッシュは日志に現れない）。`src/app.js` に 4b（morgan ファイル出力、test ではスキップ、dir 700 / file 600 を強制 chmod）。`src/middlewares/error.middleware.js` に `isLoopbackIp()` を追加し、stack トレースを `NODE_ENV=development` + ループバック (127.x / ::1 / ::ffff:127.x) 要求のみレスポンスへ返す（本番・LAN 越し開発で秘匿）。`src/models/audit.model.js` の `cleanOldAuditLogs` 重複定義（2 つ、後定義=audit_logs のみ $1 が勝っていた）を統一し `audit_logs` + `system_audit_logs` を $1 で削除（`?::integer` 版は dead code 削除）。`src/utils/cron.jobs.js` は保持日数を `config.limits.auditRetentionDays`（`AUDIT_RETENTION_DAYS` 既定 90日、ハードコード 90 を排除）へ統一し、同一 3:00 AM ジョブでアクセスログファイル (`access-*.log`) も経過削除（`cleanupAccessLogs()`）。`config/default.js` に `logging.logDir`（`LOG_DIR` 既定 `data/logs`）、`.env.example` に `AUDIT_RETENTION_DAYS=90` / `LOG_DIR=data/logs` を追加。テスト: `test/error-middleware.test.js`（新 suite、stack 秘匿 4項目: production / dev+ループバック / dev+外部IP / 404）、`test/auth.test.js` 8c（console.warn インターセプト、失敗ログインログに identifier あり・bcrypt ハッシュ `$2b$/$2a$/$2y$` なし、`clearLoginLockForTests`）、`scripts/test-log-security.mjs` + `npm run test:logsecurity`（9項目: 404 stack なし、失敗ログイン 401、dir 700、file 600、アクセスログにハッシュなし、監査 API に LOGIN_FAILED=11、監査 JSON にハッシュなし、レート制限 6回=401×5+429×1）。実測: `npm test` 11 suite 145/145 ALL PASS、`test:logsecurity` 9/9、`test:ratelimit` 8/8、`test:rbac` 17/17、UI nav 45件一致・scan 12 view 区、`node --check` 8ファイル、サーバー nodemon 自動再起動 (3443 稼働)、`data/logs` 700 / access-2026-11-08.log 600 実測（`tr -d '\0'` == `wc -c` でアクセスログ完全クリーン確認。コンソールログの NUL sparse は nodemon 旧 fd + ログ trunc の運用副作用でアクセスログに影響なし） |
| **v3.1** | 2026/11/8 | **ダッシュボード「本日の連絡」未読バッヂ: カード＝button でクリック既読、本日未読／全日未読、99+ キャップ、登録日・掲示期間フィルタ**（§14）。`public/js/modules/dashboard.module.js` の「本日の連絡」を本日中心に: 対象日が本日かつ掲示期間が本日有効な掲示のみカード化（客户端キャッシュ latest 100 と一致）、ヘッダー右に `#dash-today-bulletin-unread`（本日未読「未読 N」）、カードは `<button data-bulletin-read title="クリックで既読をつける">`（施設予約 `data-facility-open` と同慣習）でクリックは `PUT /api/bulletins/:id/read` のみ（タブ移動・モーダル開閉なし、既読カードの再クリックは API を叩かない＝冪等）、未読カードのみ未読マーカー（`.dash-news-unread-marker`）。`public/js/modules/bulletin.module.js` に `recomputeUnreadBadges()`（一覧 load／markAsRead 成功／`bulletin:posted` 受信／ダッシュボード既読化で一元再計算）、`setBulletinCache()`／`bulletinsSnapshot()`／`ingestBulletin()`（socket.js の `bulletin:posted` はトーストのみでバッヂが古かったのをキャッシュ反映＋再計算へ。自分の投稿は除く）、`isUnreadForMe()`（現行の ackStatus 土台＋**登録日以降の投稿**＋**掲示期間が本日有効**＋`target_scope`（現行は ALL/ALL で noop）＝登録日より古い記事（対象日=本日・掲示期間本日有効でも）と掲示開始前・掲示終了記事をバッヂに数えない）。`public/js/state.js` に `normalizeRegisteredDay(created_at)` → `state.currentUser.registeredAt`（'YYYY-MM-DD' JST、登録当日 ≧ 含む。旧セッションに `created_at` が無い場合は制約なし＝全期間カウント、次回ログインで解消）。サーバーは `auth.service.js` の login 応答と `auth.controller.js` の getProfile 応答に `created_at` を追加（現状どちらも返していなかった）。`public/js/main.js` の `subscribeState('unreadCounts')` に `cap()`（**100 以上は 99+**。サイドバー `#bulletin-unread-count`＝数字のみ、メイン画面タイトル `#bulletin-title-unread`（h2 直後）＝サイドバーと同一値の全日未読「未読 N」、ダッシュボード＝本日未読、0 は `hidden`）。`components.css` に §v3.1 未読バッヂ（サイドバー nav-badge と同一色系）。テスト: `test/unread-count.test.js`（新 suite: 登録日より古い記事が未読数に含まれないことを seed の `created_at` と posts を操作して SQL 検証、login/me 応答に `created_at`、PUT /read 後 ackStatus=READ かつ ack 行増加）、`scripts/test-dashboard-unread.mjs` + `npm run test:ui:unread`（**17項目**: ①本日カード・未読マーカー・button 要素・ヘッダーバッヂ、②カードクリックで PUT read 発火・本日バッヂ 1 減・マーカー消去・サイドバーとタイトル連動、③クリックでタブ移動もモーダルも開かない・既読カード再クリックは API 叩かず（冪等）、④サイドバー（数字のみ）＝タイトル（未読 N）＝全日未読、⑤**99+ キャップ**（客户端キャッシュの上限が latest 100 のため擬似キャッシュ CAPSIM で 100 件未読を再現。サイドバー 99+・タイトルとダッシュボード「未読 99+」・100 を出さない・実キャッシュ復帰でバッヂが実データへ追従。実 DB に 110 件作ると掲示初期化の autoSelect が 1 件を全文表示時点で既読化して 99 になるため擬似キャッシュを使う）、⑥登録日より古い記事（対象日=本日・掲示期間本日有効でも）と掲示開始前記事は未読バッヂに数えない、後片付け。`test:ui:all` へ組込み）。既存テスト拡張: `test:ui:bulletin` にタイトルバッヂ項目、`test:ui:sidebar` は 100 件超キャップ「99+」バッヂでもメニュー名が省略されない R9 へ更新（旧 999 流しを廃止）、`test:ui:nav`（45件一致）・`test:ui:scan` 回帰。現行測定: JS 31ファイル 16,877行・CSS 7ファイル 4,825行・`index.html` 908行（`dashboard.module.js` 1,617、`bulletin.module.js` 1,472、`main.js` 1,098、`state.js` 129、`components.css` 1,610）。**既知の環境注意:** PostgreSQL `NOW()` がホスト時計より1日遅い環境（DB 2026-11-08 / ホスト JST 11-09）があり、API 既定で作った記事の `posted_at` は DB 基準日付になるため検証は `posted_at`/`created_at` を客户端基準の本日で明示する。実測: `test:ui:unread` 17項目 ALL PASSED（CAPSIM cacheLen=100・unreadAll=100 → side `99+`・title/dash `未読 99+`、実キャッシュ復帰で side=1）、`test:ui:fx` 35項目 ALL PASS、`npm test` 12 suite 148/148 ALL PASS、`test:ui:scan` 8タブ OK、`test:ui:contrast` 12テーマ failures=0、`test:ui:chrome` 18項目 ALL PASS、`test:ui:seating` ALL PASSED、サーバー 3443 health 200、`node --check` OK |
| **v3.1.3** | 2026/11/9 | **ダッシュボード「記事を共有」モーダルは記事URL入力欄だけ（常設説明文の撤去＋入力の7条件）**（§14）。モーダル本文から常設の操作説明文 `<p>`（「http://・https:// で始まるURLを入力してください…」）を撤去し、スキーマ補完・タイトル・投稿先の説明はプレースホルダー「https://mext.go.jp/...（スキーマ無しは https:// を補完）」と `title` とトーストだけで伝える（UI十条9・禁则6）。URL入力欄に `name="news-share-url"` と `aria-label="記事URL"` を追加し、入力の7条件（`type=url`・`id`・`name`・`autocomplete=off`・`aria-label`・`label[for]`・`border-main` 2px実線）を完成（禁则8）。モーダル本文に出る文字はラベル「記事URL *」だけ。送信経路・投稿先（閲覧中の職員チャットチャンネル）・本文2行・閉じ方共通規約は変更なし。`scripts/test-news-share-modal.mjs` を **17→20項目**（常設説明文なし＝`p` 0・本文はラベルだけ／入力の7条件を computed style で実測（border-top-width 2px・solid）／補完規則は placeholder と title のみ）。回帰: `test:ui:news-share` 20項目、`test:ui:modal`、`test:ui:frames`、`node scripts/verify-docs.mjs` |
| **v3.1.2** | 2026/11/9 | **職員全体チャット（general／`PUBLIC`）撤廃: 個人作成グループのみへ**（§7.3・§9・§14）。`src/models/chat.model.js` から `general`/`chat-all`/`all` エイリアス（`normalizeChannelId`・`createChannel`・`findChannelById`・`listChannelsForUser` の特別扱い）と `getSharedChannelIds()`（server 側に呼び出し元なし）を削除し、`src/services/chat.service.js` の `canViewChannel`／`sendMessage`／`addMemberToChannel` の PUBLIC 特例を撤去（**閲覧・送信・参加はすべてメンバーシップのみ**）。`src/sockets/chat.socket.js` は `isPublic` 分岐を撤去し `canAccessChannel` をメンバー限定へ統一。`db/schema.sql` の `chat_channels.type` 既定を `PUBLIC` → `GROUP` へ、`scripts/seed.js` の `general` チャンネル投入と全メンバー参加処理を削除。`public/js/modules/chat.module.js` は `currentChannelId=null` 初期化（`general` 文字列リテラルはゼロ）、グループ未作成時は空状態メッセージ「表示できるグループがありません」を描画し API を叩かない（`showEmptyChannelState()`）、非表示モードで最終グループを非表示化すると `currentChannelId=null` となり送信はトースト警告へ。`dashboard.module.js` の `resolveShareChannelId()` は `getShareableChatChannelId()`（先頭の非表示グループ、未作成時 null）を読み、共有先が無い場合は送信しない。既存DBの撤去は `npm run db:drop-general-chat`（`scripts/migrate-chat-drop-general.mjs` が `general`/`chat-all`/`all` を DELETE、`chat_messages`/`chat_message_reads`/`chat_channel_members` は `ON DELETE CASCADE` で連動削除）。追加検証: `scripts/test-chat-unread.mjs`（未読計算・既読更新・未読名簿）、`scripts/test-news-share-modal.mjs`（投稿先がサイドバー `.active` と一致）。回帰: `npm test`、`test:ui:news-share`、`test:ui:chat` |
| **v3.1.5** | 2026-11-10 | **職員掲示板の左列（タイトル列表）の幅を画面幅に応じて広げる（16rem 固定の廃止）**（§14）。`public/css/layouts.css` §7.1 の `.bulletin-title-pane` を `flex: 0 0 16rem` → `flex: 0 0 clamp(16rem, 26vw, 24rem)`（shrink 0）へ変更。16rem（280px）固定ではタイトル文字が195pxしか使えず、23文字のタイトル（実測387px）が途中で切れていた。実測: 768→280 / 900→280 / 1100→286 / 1280→333 / 1440→374 / 1600→416 / 1900→420px（24rem で打ち止め）。1280px のタイトル文字幅は195px→248px。右ペインは余り（768px→373px、1280px→832px）。767px以下は縦 stacking で左列全幅（変更なし）。追加検証 `scripts/test-bulletin-title-pane-width.mjs`（**14項目**: 期待式 clamp と±2px一致、単調増加、24rem 打ち止め、右ペイン余り、横スクロールなし、タイトル文字幅240px以上、長タイトルで列が広がらない・1行省略、枠2px実線1枚・角丸0.8rem・影なし、収納サイドバー(67.25px)と左列が重ならない、モバイル390px全幅）と `npm run test:ui:bulletin-title-pane` を `test:ui:all` へ組込み。`scripts/test-bulletin-split.mjs` の「左列=16rem固定」「長いタイトルでも16rem」の2項目を clamp 式（現実に合わせた期待値）へ更新（テスト削除なし）。あわせて `scripts/test-bulletin-unread-btn-pos.mjs`（12項目）が `test:ui:all` に未登録だったのを配線（verify-docs の被覆チェックは101→102項目、失敗0）。回帰: `test:ui:bulletin-title-pane` 14項目 ALL OK、`test:ui:all` の UI 節は https の CA ページ（HTTP ポート未起動）以外 FAIL なし、`node scripts/verify-docs.mjs` 102項目 失敗0 |
| **v3.1.1** | 2026/11/9 | **ダッシュボード「記事を共有」モーダルは記事URLだけへ簡素化（共有先＝閲覧中の職員チャットチャンネルに固定）**（§14）。`#news-share-form` からタイトル・ひとこと・共有先セレクト・チャンネル選択・掲示対象日を撤廃し、入力欄は `#news-share-url` の1つだけ（`#news-share-form` 内の input/select/textarea = 1、submit ボタン = 1）。投稿先は `chat.module.js` の新 export `getCurrentChatChannelId()` を読む `resolveShareChannelId()` が「閲覧中チャンネル」へ固定（チャット未開の初回は既定チャンネル）。本文は `【記事共有】{ドメイン名}\n{URL}` の2行（`defaultShareTitle()` の hostname、`www.` 除去）。`SHARE_TARGET_LABELS`／`loadShareChannelOptions()`／`syncShareFields()`／`jstToday()`／掲示板 `POST /api/bulletins` 経路を削除し、`openNewsShareModal()` は async 不要になった。URL検証（スキーマ無しは `https://` 補完・hostname にドット無しは拒否）・空送信拒否・成功時トースト+`switchTab('chat')`・失敗時はモーダル維持・閉じ方共通規約（X/フッター/背景/ESC）は維持。`scripts/test-news-share-modal.mjs` を **21→17項目**（入力欄がURLだけ／本文2行の完全一致／投稿先がチャットサイドバー `.active` のチャンネルと一致／サーバー実データ登録）。回帰: `npm test` 148/148、`test:ui:news-share` 17項目 ALL OK、`test:ui:modal` ALL PASSED、`test:ui:fx` 44項目 ALL PASSED、`node --check` 3ファイル 0 |
| **v3.1.6** | 2026-11-10 | **日付の1日ずれを直した: サーバーが書く時刻は日本の壁時計（JST）**（§9・§14）。`src/utils/db.js` の `nowIso()` が UTC を返していたため、サーバー既定の日付（掲示の `targetDate` 既定・`displayStartDate` 既定、日程作成の `date` 既定、チャット既読時刻）が日本の今日より1日早く格納され、「本日列表」・未読バッヂ・日程一覧が一日ずれて表示されていた（§9 の「`CURRENT_TIMESTAMP` は JST 壁時計で格納」が実際の運用）。`nowIso()` を `toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' })`（`YYYY-MM-DD HH:MM:SS` の JST 壁時計）へ統一し、`src/models/schedule.model.js` の `getSchedulesInRange` と `src/models/chat.model.js` の既読タイムスタンプ2箇所を `NOW()`／`CURRENT_TIMESTAMP` 文字列変換から `nowIso()` へ変更（`src/models/bulletin.model.js` は `nowIso()` 既定で追随）。UI 側は「全日未読」モードの未読ボタンをツールバーとサイドバーせり出しの両方に適用（`syncUnreadButtonToState` を `querySelectorAll('#bulletin-toolbar-read, #bulletin-unread-btn')` へ）。「今日」を基準とする検証は固定日付をやめて今日から導出: `scripts/test-bulletin-unread-all-days.mjs`（固定 `2026-11-01` 廃止→今日・今日-3・今日-6・今日+3 の fixture、週ラベル期待値も今日から計算、登録日は `/api/auth/me` の `created_at` → JST 日、列表件数・ラベル位置・期待行順は `/api/bulletins` 基準、最終行クリック後の右ペインは「復帰した本日列表に読んだ行が残るか」で期待値を決める）、`scripts/test-bulletin-split.mjs`（開始時に `post_acknowledgements` を空にして前回の未読検証の結果を引き継がない／サイドバーの全日未読数はクライアントと同じ計算（キャッシュ最新100件の未読・登録日以降・本日掲示有効）と一致／中心日表示の幅は CSS 指定 5.4rem（94.5px）固定で › の x は 1px 動かず、描画実測は文字幅差で 1px 以内揺れる／`pool.end()` でプロセス終了）。`scripts/test-frame-rules.mjs` はホバーを `:hover` 確認（最大6回くり返し）してから描画を実測（座標吸収で見失う flaky を防ぐ）。`public/js/modules/facility.module.js` の日付読み上げクリックが `bulletin.module.js` の `toggleMiniCalendar()` を呼んでいた（未 import で `ReferenceError: toggleMiniCalendar is not defined` → `test:ui:facility` がクラッシュ）を、施設タブ自身の `facilityCalendar.toggle()`（`facility-calendar.js`）へ変更（§7）。実測: `npm test` 153/153、`api:check` 全通過、`test:ui:all` 全スクリプト ALL PASSED（`test:ui:bulletin` 68項目・`test:ui:bulletin-unread` 98項目を含む）、`verify-docs` 102項目 失敗0 |
| **v3.1.4** | 2026/11/9 | **職員全体グループの撤廃をサーバー側で完成（API の `type` ホワイトリスト＋フロントの全体アイコン消去）**（§7.3・§14）。`src/services/chat.service.js` の `createChannel` に `ALLOWED_USER_TYPES = ['GROUP', 'DM']` を設け、`POST /api/chat/channels` に `type: 'PUBLIC'` / `'PRIVATE'` / `'ALL'` 等の架空タイプが来ても `GROUP` へ寄せる（API 経由で職員全体グループを作らせない）。`public/js/modules/chat.module.js` のグループ行アイコンから `type === 'PUBLIC' ? 'globe' : 'users'` 分岐を3箇所撤去し、グループ行は `users` のみ（禁则10 の PUBLIC 参照をコードから消す）。検証追加: `test/chat.test.js` に「`type: 'PUBLIC'` 指定は `GROUP` へ寄せられる」（149→**150テスト**）、`scripts/test-chat-unread.mjs` に項目14・15（サーバーのチャンネル一覧は参加グループだけ＝タイプは `GROUP` / `DM` / `WORKFLOW` のみ・職員全体グループは0件／サイドバーのグループ行のIDはサーバーのグループ一覧の中に入り・「全体」の文字なし。実測 types は `GROUP` と `WORKFLOW` のみ、names「📋 教務部連絡」「🧭 進路指導連絡」＋作成グループ）、`scripts/test-socket-auth.mjs` に「職員全体グループは存在しない（一覧のタイプは GROUP / DM / WORKFLOW のみ）」追加（20→**21項目**。メンバーシップ検証は `WORKFLOW` を除いた個人作成グループを使い、検証用グループは `type: 'GROUP'` で作成）。あわせて Node 側通信の TLS を CA 明示へ統一（`test-chat-unread.mjs`・`test-ui-seating.mjs`・`test-socket-auth.mjs` に `caFetch()` と `ca: [certs/issystem-ca.crt]`。素の `fetch` は自己署名チェーンで `SELF_SIGNED_CERT_IN_CHAIN` になり `test:ui:chat` / `test:ui:seating` が落ちていた。npm script に `NODE_EXTRA_CA_CERTS` は埋め込まない＝禁则14）。実測: `npm test` 12スイート 150/150 ALL PASS、`api:check` exit 0（サーバー起動後）、`test:socket-auth` 合計21件/失敗0、`test:ui:chat` ALL PASSED、`test:ui:seating` ALL PASSED、`test:ui:news-share` ALL OK、`node scripts/verify-docs.mjs` |








