# ISSystem仕様書（現行実装基準）

**文書バージョン:** 3.0.0 ／ **改訂日:** 2026年11月7日 ／ **対象:** ISSystem（職員室情報共有システム）

## 0. 文書の位置づけ

本書は**現行コード（`src/` + `public/` + `db/schema.sql`）を唯一の正典として再構成した仕様書**であり、旧文書群の置き換えである。旧文書は実装と乖離していたため削除した。

| 削除した旧文書 | 主な乖離（実データ） |
| --- | --- |
| `仕様書.md` | 0バイト（空） |
| `問題分析.md` | 参照パス `/home/iriko/デスクトップ/ISSystem`（現 `/home/iriko/programing/ISSystem`）、存在しない `CLAUDE.md` を参照 |
| `システム機能仕様書.md` v2.0.0 | 「MongoDB/軽量データストア選択可」→ 現行は PostgreSQL 一本（`config/default.js` は `DB_TYPE≠postgres` に警告）。督促・再通知機能は**実装なし** |
| `データベース仕様書.md` v2.2.0 | 記載約11テーブル → 現行**51テーブル / 65インデックス**。`posts.post_type`・`posts.priority` は撤廃（カラム削除済み） |
| `ＵＩ・ＵＸ仕様書.md` | 「Single-File HTML」「FontAwesome 6.4.0」「インラインCSS」→ 現行は `index.html`(883行) + CSS**7ファイル(3,387行)** + JS**モジュール制(15,393行)**、アイコンは **Lucide** |
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

- `npm run cert:gen`（`scripts/create-ca.mjs`）が `certs/` に発行: ルートCA `issystem-ca.crt`（秘密鍵 `issystem-ca.key`、`issystem-ca.pem` は同一内容）、サーバー証明書 `server.pem` + `server.key`。**SAN 付き**（`localhost, issystem.local, issystem, 127.0.0.1, ::1`）で、サーバー証明書をCAに読み込ませ WSS でも検証が成立するチェーンを提示する。再発行は `--force`。`certs/` は Git に入れない。
- 端末の信頼ストアに `certs/issystem-ca.crt` をインストール（Windows: 信頼されたルート証明機関／macOS: 常時信頼）。Node 側は `NODE_EXTRA_CA_CERTS=./certs/issystem-ca.crt`（npm script に付与済み）。
- 非HTTP（`http://` / `ws://`）で来た端末には `/ca`（`src/routes/ca.routes.js`）が **SHA-256指紋・OS別インストール手順・ダウンロードリンク・`https://HOST:SSL_PORT/` へ移動するボタン**を表示。HTTPS の `/ca` も同じ。`SSL_CA_PAGE_BASE` がボタンURLの基点。
- Express 側 (`src/app.js`) ミドルウェア順: `helmet`（CSP はオフ＝インラインスクリプト／CDN許可、`crossOriginResourcePolicy: cross-origin`）→ `cors`（`CLIENT_ORIGIN` カンマ区切り、credentials 有効）→ JSON/urlencoded（10MB上限）→ `morgan`（production: combined、開発: dev、`NODE_ENV=test` では無し）→ `/api/health` → `/ca` → `/api` → `express.static(public)` → SPAフォールバック（`/api` 以外は `index.html`）→ `notFoundHandler` → `errorHandler`。
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
| `requireAdminRole` | `role === 'ADMIN'` のみ | `auth.middleware.js` に定義済みだが、**現行ルートでは未適用**（`/api/users`・`/api/audit/logs` に付与すべき：§15 参照） |

**権限がサービス側で判定されるもの:** 年休・出張欠席（教務・管理職は全教員分、一般教員は本人分のみ）、担当教科の他教員変更（教務部のみ）。

**Socket.io ハンドラー（`seating:*`, `lock:*`, `chat:*`）にはロール検証が存在しない**（接続時の JWT 検証のみ）。

---

## 6. 認証・招待コード

1. `POST /api/auth/login`（`staff_code` + パスワード、bcrypt比較）→ JWT（`JWT_EXPIRES_IN` 既定 24h）を発行。
2. 招待コード発行 `POST /api/auth/generate-invitation`（要認証）: `crypto.randomBytes(4).toString('hex').toUpperCase()` = **8文字16進大写**、有効期限 24時間（`config.auth.invitationCodeExpiryHours`）。レスポンスはトップレベルに `code` と `expiresAt`。
3. 発行時点で利用目的は確定しない。受け取った教職員がログイン画面で「新規登録（招待コード）」/「パスワード再設定」を自ら選ぶ。
4. `POST /api/auth/register-invitation`（招待コード + 教職員番号 + パスワード）→ 登録直後に JWT。消費済み 400、既存教職員番号 409、8文字未満/項目不足 400。
5. `POST /api/auth/reset-password-invitation`（招待コード + 教職員番号 + **新パスワード8文字以上**）→ 再設定直後に JWT。未登録教職員番号 404、旧パスワード 401。
6. 消費は `invitation_codes` に `is_used` と `used_for`（`REGISTER` / `PASSWORD_RESET`）として記録。再利用不可。
7. 旧互換ルート（同一ハンドラー）: `POST /api/auth/register`、`POST /api/auth/reset-password`、`POST /api/auth/invite-code`。
8. 自己管理: `GET /api/auth/me`、`PUT /api/auth/profile`（氏名・学年・分掌）、`PUT /api/auth/change-password`、`PUT /api/auth/status`（在席状態）、`POST /api/auth/logout`。

**パスワード2系統（別物）:** DB接続パスワード（`DB_PASSWORD`）とアプリログインパスワード。`scripts/seed.js` の教職員共通パスワードは `password123`、教務主任は教職員番号 `T2026001`。

**注意（実装上の既知事項）:** `JWT_SECRET` は bcryptソルト由来の運用・メールパスワードのAES鍵導出（§10）にも使われている。変更時は `npm run db:seed` 再実行が必要。

---

## 7. API 一覧（`src/routes/index.js` 全354行・実測）

凡例: `-` = 認証なし、`A` = `authenticateToken`、`K` = `requireKyomuRole`、`K!` = `requireKyomuOnlyRole`（ADMIN 不可）、`L` = `checkEditingLock(...)`。全ルートは `safe()` でラップされ、未定義ハンドラーは 500 を返す（クラッシュしない）。

### 7.1 認証・ユーザー・マスタ

| Method | Path | 権限 | 内容 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | - | `staff_code` + パスワード → JWT |
| POST | `/api/auth/register-invitation` | - | 招待コードによる新規登録 |
| POST | `/api/auth/reset-password-invitation` | - | 招待コードによるパスワード再設定 |
| POST | `/api/auth/generate-invitation` | A | 招待コード発行（8文字/24h） |
| GET | `/api/auth/me` | A | プロフィール |
| PUT | `/api/auth/profile` | A | 氏名・学年・分掌の自己更新 |
| PUT | `/api/auth/change-password` | A | パスワード変更 |
| PUT | `/api/auth/status` | A | 在席状態更新 |
| POST | `/api/auth/logout` | A | ログアウト |
| POST | `/api/auth/register`・`/auth/reset-password`・`/auth/invite-code` | -/A | 旧互換エイリアス（同一ハンドラー） |
| GET/POST/DELETE | `/api/users`, `/api/users/:id` | **A のみ（RBACギャップ）** | ユーザー一覧・作成・削除。`TEACHER` でも ADMIN アカウントを作成・削除可能（§15） |
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
| GET/POST | `/api/chat/channels` | A | チャンネル一覧・作成（名前行 400。`PUBLIC`/`GROUP`/`DM`） |
| GET | `/api/chat/channels/:channelId/members` | A | メンバー一覧（`chat_channel_members`） |
| GET/POST | `/api/chat/channels/:channelId/messages` | A | 履歴取得・メッセージ投稿 |
| PUT | `/api/chat/channels/:channelId/read` | A | 既読更新（`chat_message_reads`、未読バッジ算出） |
| PUT | `/api/chat/channels/:channelId/hide` | A | チャンネル非表示トグル（`is_hidden`） |
| DELETE | `/api/chat/channels/:channelId` | A | チャンネル削除（**公開チャンネルは 400**） |
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
| GET/PUT | `facility_cells`（`updateCells`/`getCells`） | A | フィールドセル値の取得・更新 |

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

`GET /layouts`・`GET /layouts/:id`・`POST /layouts`・`PUT /layouts/:id/cells`（`checkEditingLock('seating')` 付き）・`PUT /layouts`・`PUT /master`・`GET /master`・`GET /students/code/:code`（4桁生徒コード）・`GET /students/search`・`POST/DELETE /layouts/:id/lock`（編集ロック取得/解放）。座席レイアウトは `seating_status` + `facility_cells` から導出（専用テーブルなし）。

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

---

## 9. データベース（PostgreSQL / 51テーブル・65インデックス・1,262行スキーマ）

- **UTF-8、タイムゾーン `Asia/Tokyo`**（`CURRENT_TIMESTAMP` は JST 壁時計で格納）。
- 主キーは **`id TEXT PRIMARY KEY`**（UUID文字列）。`staff_code` はユニークログインID。外部キーは常に有効（PRAGMA なし）。
- **フラグは INTEGER 0/1 に統一**（`is_deleted`, `is_cancelled`。旧 boolean 環境からは冪等マイグレーション: DROP INDEX → 型変換 → 再作成）。`exam_*` の一部は BOOLEAN を使用。
- `ensureSchema()`（`config/database.js`）が起動時に冪等適用（`DB_AUTO_SCHEMA=false` で無効化可）。`npm run db:init`、`npm run db:tables`（コード参照テーブル名との整合チェック）。
- 歴史的な重複定義が残る: `invitation_codes` は §1c と §11 に2度定義（`IF NOT EXISTS` で冪等）、`audit_logs`（90日保持）と `system_audit_logs` が併存。

| 分類 | テーブル |
| --- | --- |
| アカウント・招待 | `users`（role/grade/department/extension_number/is_kyomu/is_parttime/invited_by_user_id）, `invitation_codes`（`code`, `is_used`, `used_for`, `expires_at`） |
| 掲示・回覧 | `posts`（`target_scope` JSON, `attachments` JSON, `display_start_date`/`display_end_date`/`target_date`, `is_deleted`）, `bulletin_attachments`, `bulletin_comments`, `post_acknowledgements`（複合ユニーク `(post_id,user_id)`、status `UNREAD/READ/APPROVED/REJECTED`） |
| チャット | `chat_channels`（`PUBLIC/GROUP/DM`）, `chat_channel_members`（複合PK + `is_hidden`）, `chat_messages`（`is_cancelled`）, `chat_message_reads` |
| 座席・施設 | `seating_status`（`desk_number`, `group_zone`, `current_status` `PRESENT/CLASS/TRIP/LEAVE`, `status_note`）, `resources`（`sort_order`）, `reservations`（`is_cancelled`）, `facility_cells`, `basic_rooms` |
| スケジュール | `school_schedules`, `schedule_categories`, `schedule_category_map` |
| 決裁・欠席 | `approvals`, `absence_records` |
| 監査・ロック | `audit_logs`（90日保持）, `system_audit_logs`, `editing_locks`（TTL 180秒） |
| 授業マスタ | `classes`（略称・運用状態、`course_ids` は旧コース名残りで `'[]'`）, `subjects`, `curriculum_subjects`（年間開講・標準試験時間50分・標準教室）, `curriculum_courses`（**運用廃止、旧データ互換で表のみ残す**） |
| 考査（22） | `exam_masters`, `exam_phases`, `exam_slots`, `exam_subject_plan`, `exam_subject_decisions`, `exam_trips`, `exam_timetable_rules`, `exam_proctor_rules`, `exam_room_rules`, `exam_rooms`, `exam_room_config`, `exam_room_assignments`, `exam_parttime_staff`, `exam_parttime_availability`, `exam_slot_history`, `exam_teacher_constraints`, `exam_teacher_exemptions`, `exam_proctor_assignments`, `exam_commands`, `exam_block_shapes`, `exam_block_groups`, `exam_block_conditions` |
| メール | `mail_accounts`（`password_enc`, `status` `UNVERIFIED/VERIFIED/FAILED`, `last_checked_at`）, `mail_messages`（`is_read`, `idx_…_time` 降順, `idx_…_unread`） |

**意図された設計:** 座席レイアウトは `seating_status` + `facility_cells` から、考査ステータスは `exam_masters` + `exam_phases` から導出するため専用テーブルを持たない。教育ニュースは DB 永続化しない。

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

- **エントリ:** `public/index.html`（883行、`<html lang="ja" class="theme-light-azure" data-theme-mode="light" data-chrome="light">`）。CDN: Tailwind + `lucide@latest` + `socket.io@4.7.5`。スクリプトは ES Modules（`main.js` 1,073行）。
- **共有層:** `api.js`(155) 共通API呼び出し、`config.js`(77) `API_BASE_URL='/api'`・`WS_BASE_URL=window.location.origin`・`ENDPOINTS`・`STORAGE_KEYS`・`DEFAULT_THEME='light-azure'`、`state.js`(106) トークン/ユーザー/テーマの localStorage 永続化、`socket.js`(404) 接続と購読、`theme.js`(178) テーマ切替、`ui-helpers.js`(436) 共通UI部品、`main.js` タブ切替・初期化。
- **タブモジュール（12）:** `dashboard`(969), `bulletin`(1,250), `chat`(1,526), `facility`(992), `schedule`(1,124), `approval`(302), `absence`(309), `seating`(342), `subjects`(308), `mail`(515), `news`(257), `about`(217)。
- **考査モジュール（11・計5,253行）:** `exam.module.js`(210) + `exam.master.ui`(209), `exam.plan.ui`(428), `exam.subject.ui`(576), `exam.decision.ui`(461), `exam.timetable.ui`(1,004), `exam.room.ui`(548), `exam.proctor.ui`(766), `exam.trip.ui`(261), `exam.view.ui`(240), `exam.shared`(209)。
- **CSS 7ファイル（3,387行）:** `base`(119), `variables`(1,019), `components`(1,291), `layouts`(455), `theme`(167), `readability`(1,013), `animations`(342)。`base.css` の `!important` 制約より ID specificity + `!important` で優先させる実装慣例あり（例 `#chat-btn-toggle-hide[aria-pressed="true"]`）。
- **テーマ:** 24テーマクラス。3系統 × 配色。**light**（`theme-light-{azure,slate,forest,rose,amber,teal}`）、**dark**（`theme-dark-{navy,slate,emerald,amber,rose,plum}`）、**cb（色彩配慮・色覚多様性対応）**（`theme-cb-{azure,slate,forest,rose,amber,violet,teal,crimson}`）。`localStorage` の `is_system_theme_preference_v251` に保存、`document.body.className` を差し替える。旧設定との互換エイリアス（`hidden`）が定義されている。
- **アクセシビリティ/レスポンシブ:** 通常テキストのコントラスト比 4.5:1 以上を保つ（`readability.css` と `npm run test:ui:contrast` / `test:ui:chrome` / `test:ui:contrast-plain` で検証）。`lg`（≥1024px）3カラム、`md` 未満は1カラム。グローバル検索は `Ctrl+K` / `Cmd+K`。
- **チャット「目のマーク」非表示編集モードトグル:** サイドバーフッター左下の `#chat-btn-toggle-hide`（アイコンのみ）。`aria-pressed` が ON 時のみグループ名横に非表示ボタン（`eye-off`）が出、ON は開いた目 `eye` + 警告色リング。色・枠は `components.css`、アイコンは `chat.module.js` の `setHideEditMode()` が差し替え `refreshLucideIcons()` を呼ぶ。回帰テスト `npm run test:ui:chat`（検証項目11）。

---

## 15. セキュリティ

### 15.1 実装済み（現行コードで確認）

- 全アプリ通信は TLS（HTTPS/WSS、`SSL_PORT` 3443）。非HTTPポートは CA 配布専用で API を `426` 拒否。
- `helmet` セキュリティヘッダー、CORS は `CLIENT_ORIGIN` の明示リスト、`express.json` 10MB上限。
- JWT（`Bearer`）検証 + RBAC ミドルウェア、bcrypt(10) ハッシュ、`JWT_EXPIRES_IN` 24h。
- 監査ログ（`audit_logs` / `system_audit_logs`、500系は `SERVER_ERROR` として stack を監査ログへ）、`AUDIT_RETENTION_DAYS` 既定90日保持。
- エラーレスポンスの stack trace は **`NODE_ENV=development` のみ**（本番では出さない）。
- 座席セル・施設予約等の業務単位での排他ロック（3分自動解放）、二重予約 409。
- メールのパスワードは AES-256-GCM 暗号保存（平文不可）。

### 15.2 既知の課題（2026/11/7 監査で確定した重大度順・**未対応**）

| # | 重大度 | 内容 | 是正案 |
| --- | --- | --- | --- |
| 1 | **Critical** | `src/sockets/socket.index.js` が **`NODE_ENV≠production` で JWT 検証失敗時に `dev-user`（role `TEACHER`）として接続を許可**し、`demo-jwt-token-*` プレフィックスのトークンも無条件で通す。Socket ハンドラー（`seating:*`, `lock:*`, `chat:*`）には**ロール検証がない**ため、開発モードでは無資格端末が在席更新・座席グリッド更新・ロック取得できる | デモ/fallback 許可を削除し常時 `jwt.verify` を強制。ハンドラーに `socket.user.role` チェックを追加 |
| 2 | **Critical** | 既定 `JWT_SECRET`（`is_system_secret_key_2026_default_jwt`）が `.env.example` に平文公開済み。この秘密鍵で ADMIN トークンを伪造すると `/api/users`・`/api/audit/logs` に到達可能。同じ秘密鍵がメール AES 鍵の導出元 | `openssl rand -hex 32` で採り `.env` 秘密化、既定値をコードに残さない。メール鍵は `MAIL_ENC_KEY` として JWT と分離（移行は再暗号化マイグレーション） |
| 3 | **High** | `/api/users`（一覧・作成・削除）は `authenticateToken` のみ。**`TEACHER` が ADMIN アカウントを作成・削除できる**（`requireAdminRole` は定義済みだが未適用） | `POST /users`・`DELETE /users/:id` に `requireAdminRole`（または `requireKyomuRole`）を付与 |
| 4 | **High** | ログイン・招待コード登録に**レート制限・アカウントロックアウトがない**（`express-rate-limit` 依存なし）。招待コードは8文字16進（4バイトエントロピー）で試行攻撃に対して弱い | `express-rate-limit` を `/api/auth/login` と `register-invitation`/`reset-password-invitation` に適用。コードは6バイト以上＋試行上限 |
| 5 | **Medium** | `src/services/auth.service.js:86` がパスワード照合失敗時に **`dbHash`（bcryptハッシュ全文）をログへ出力**（morgan と併せてサーバログに流出） | `dbHash` を出さず `identifier` のみにする |
| 6 | **Medium** | `CSP` が `false`（インラインスクリプト・CDN許可）＋ Tailwind/Lucide/socket.io を CDN から読む。UI にユーザー入力が入るため XSS 表面が広い | コンテンツセキュリティポリシーを段階的に有効化、CDN をローカルへ自前配布 |
| 7 | **Medium** | JWT を `localStorage`（`is_system_jwt_token_v251`）に保存するため XSS でトークン流出する | 短期有効 + HttpOnly Cookie セッションへ移行 |
| 8 | **Medium** | メール接続テストは `rejectUnauthorized: false`（意図された設計）だが、中間者攻撃に対して STARTTLS が検証されない | 校内CAの指紋を `.env` に登録して pinning をオプション化 |
| 9 | **Low** | 開発モードで `morgan('dev')` がリクエストパス・ユーザー名等をログ出力、監査ログの `SERVER_ERROR.details.stack` はスタックトレ全文を含む | 本番ログレベルと保持期間を運用で固定 |

**優先対応順:** #1 → #2 → #3 → #4 → #5。対応後は `npm test`（139テスト）と `npm run test:ui:https`（27項目）で回帰確認する。

---

## 16. 意図された非実装・履歴（仕様として明示）

- **督促:** 掲示板 `POST /api/bulletins/:id/remind` と決裁 `POST /api/approvals/:id/remind` は**実装されている**。旧UI/旧仕様書の「廃止済み」表記は古い（v3.0.0 で訂正）。
- **未使用コード:** `src/sockets/socketEvents.js` / `src/sockets/socketClient.js`（§8.3）。
- **旧データ互換:** `curriculum_courses`（運用廃止、表のみ）、`classes.course_ids`（`'[]'` 維持）、`posts.post_type`/`priority`（カラム削除済み）、`invitation_codes` 二重定義、`audit_logs` と `system_audit_logs` の併存。
- **DB 永続化なし:** 教育ニュース・天気（インメモリキャッシュのみ）。
- `news` タブは無い（ダッシュボードウィジェット）。
- 単一HTML構成・NAS配置のみでの運用は現行アーキテクチャ（Express + PostgreSQL + TLS）**では成立しない**（旧 UI/UX 仕様書の記述は廃止）。

---

## 17. 運用・テスト

**コマンド**（詳細は `README.md`）: `npm run db:create` / `db:init` / `db:seed` / `cert:gen` / `npm start`（`npm run dev` = nodemon）/ `npm test` / `npm run api:check` / `npm run db:tables`。

**Jest 統合テスト:** 10スイート・139テスト（`--experimental-vm-modules --runInBand`、`pretest` が `init-db` + `seed` を実行）。共通ヘルパー `test/helpers.js`（`loginToken`, `bearer`, `pickId`, `closePool`）。スイート: `auth`, `facility`, `approvals`, `bulletins`, `chat`, `invitation`, `exam`, `absence`, `schedules`, `mail`。jest は `<rootDir>/test/**/*.test.js` を対象し `/node_modules/` と `<rootDir>/.kilo/` を無視（`.kilo` は削除済み＝無害な履歴設定）。

**UI 検証スクリプト（`puppeteer-core` + `NODE_EXTRA_CA_CERTS`）:** `test:ui:https`（CA検証・TLS・CAページ・API 426・CA配布・ブラウザ wss 接続・非HTTP ws 拒否の 27項目）、`test:ui:all`（17スクリプトの回帰: modal / frames / scan / header-frames / audit / chrome / contrast / contrast-plain / nav / bulletin / chat / facility / facility-order / facility-header-sticky / timeline / mail / https）、`test:ui:mail`（37項目）。API 検証: `api:check`（スモーク）、`test:api:mail-defaults`（12項目）、`test:api:mail-test`（6項目）。

**開発メモ:** 二重予約判定は `toDateTime()` で `HH:MM` → `YYYY-MM-DD HH:MM:SS` 正規化。システムメッセージの `sender_id` は FK 制約のため `resolveSenderId()` で `system` ユーザーへ変換。`ensureSchema()` はプロメモ化（複数プロセス同時適用で「pool closed」防止）。スモークテストは `npm start` 起動後に `npm run api:check`。

**環境メモ:** 開発は Windows（`C:\Program Files\PostgreSQL\18`）→ 現行環境は Linux（`/home/iriko/programing/ISSystem`）。DBパスワード `otome601`、アプリ共通パスワード `password123`（教務主任 `T2026001`）。`npm test` は DB に `issystem` テストデータを再投入する。

---

## 18. 改訂履歴

| バージョン | 日付 | 内容 |
| --- | --- | --- |
| v1.0.0〜v2.2.0 | 2026/09〜2026/10 | 旧 `システム機能仕様書.md` / `ＵＩ・ＵＸ仕様書.md` / `データベース仕様書.md` / `仕様書.md` / 各種分割計画 txt に分散（**実装との乖離により削除**） |
| **v3.0.0** | 2026/11/7 | 現行コード（`src`+`config` 23,482行、`public` 19,663行（JS 15,393行・CSS 3,387行・`index.html` 883行）、`db/schema.sql` 1,262行・51テーブル）を計測し**単一正典として再構成**。Socket 認証バックdoor・JWT 既定鍵・`/api/users` の RBAC ギャップ・レート制限欠如・ログ流出を既知課題として明文化（§15）。`README.md` は運用手順書として維持 |





