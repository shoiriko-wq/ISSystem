# IS System - プロジェクト構成

このプロジェクトは、IS System（情報システム）を管理するためのシステムです。以下の構成で構成されています。

- `index.html` - メインページ
- `style.css` - スタイルシート
- `script.js` - JavaScriptファイル
- `README.md` - プロジェクトの説明

このプロジェクトは、ユーザーが情報を入力し、システムに登録するためのインターフェースを提供します。
# ISSystem (職員室情報共有システム)

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

- `npm run cert:gen` が `certs/` に発行する: ルートCA `issystem-ca.pem`（秘密鍵 `issystem-ca.key`）、サーバー証明書 `server.pem` + 鍵 `server.key`（SAN: localhost, issystem.local, issystem, 127.0.0.1, ::1。CAにサーバ証明書を提示するため WSS でも検証可能）。再発行は `--force`。
- **端末の信頼ストアに `certs/issystem-ca.pem` をインストール**するとブラウザのアドレスバーで「安全な接続」として開ける。Windows はダブルクリック →「信頼されたルート証明機関」、macOS は「常時信頼」。Node からのアクセスは `NODE_EXTRA_CA_CERTS=./certs/issystem-ca.pem`。
- **非HTTP (`http://` や `ws://`) でアクセスしてきた相手には CAダウンロードページ (`/ca`) が表示される。** ページには SHA-256指紋、OS別のインストール手順、ダウンロードリンク、`https://HOST:SSL_PORT/` へ移動するボタンがある。アプリ画面や API は返らない。HTTPS の `/ca` も同じページ（指紋とダウンロード）で利用可能。
- 設定は `.env` の `SSL_PORT` / `SSL_HOST` / `SSL_DIR` / `SSL_KEY` / `SSL_CERT` / `SSL_CA` / `SSL_HOSTS` / `SSL_CA_PAGE_BASE`（`PORT` は CA配布専用ポート）。
- 検証: `npm run test:ui:https`（CA検証・TLSハンドシェイク・CAページ表示・API 426・CAダウンロード・ブラウザ wss 接続・非HTTP ws 拒否の 23項目）。

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

### アカウントのパスワード2系統

- **DBパスワード**: `otome601` → PostgreSQL 接続専用 (`psql`, `db:create` など)
- **アプリのログインパスワード**: `password123` → `scripts/seed.js` の教職員アカウント共通パスワード。教職員番号 `T2026001` (教務主任) などでログイン

```bash
# psql を使う場合
$env:PGPASSWORD='otome601'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h localhost -p 5432 -U postgres -d issystem
```

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm start` / `npm run dev` | サーバー起動 (HTTPS/WSS + Cron + CA配布用HTTP) |
| `npm run cert:gen` | プライベートCAとサーバー証明書を生成（既存があればスキップ。`--force` で再発行） |
| `npm test` | jest 統合テスト (5スイート / 40テスト、各スイートで pg プールを close するため `--forceExit` 不要) |
| `npm run api:check` | API スモークテスト (HTTPS の GET/POST/PUT/DELETE を実行しステータスを検証) |
| `npm run test:ui:https` | 安全通信検証 (CA検証 / TLS / CAページ / API 426 / CA配布 / ブラウザ wss) |
| `npm run db:create` / `db:init` / `db:seed` | DB 作成 / スキーマ適用 / ダミーデータ投入 |
| `npm run db:tables` | コード内参照テーブル名の一覧表示 (スキーマ整合チェック) |

## テストスイート

`test/helpers.js` に共通ヘルパー (`loginToken`, `bearer`, `pickId`, `closePool`) があります。

| ファイル | 内容 |
| --- | --- |
| `test/auth.test.js` | ログイン、`/auth/me`、招待コード発行 (201)、招待登録、新規アカウントでのログイン、消費済みコード 400・既存教職員番号 409、誤パスワード 401、トークンなし 401 |
| `test/facility.test.js` | 施設一覧、日別概要 (`facilitiesOverview`)、予約作成 201、**重複時間帯 409**、予約一覧、キャンセル、`start>=end` は 400、キャンセル後の再予約 |
| `test/approvals.test.js` | 一覧、申請作成 201、詳細、承認処理 (`APPROVED`)、無効ステータス 400、存在しない ID 404 |
| `test/bulletins.test.js` | 一覧、詳細 (確認率 `ack_percentage`)、投稿作成 201、件名・本文欠落 400、コメント、既読、電子承認、不存在 404 |
| `test/chat.test.js` | チャンネル一覧、メンバー一覧 (`chat_channel_members`)、チャンネル作成 201、メッセージ投稿、取得、既読、削除、公開チャンネル削除 400、チャンネル名欠落 400 |
| `test/invitation.test.js` | 招待コード発行 (トップレベル `code`)、新規登録、招待コードによるパスワード再設定、旧パスワード 401、消費済みコード 400、未登録教職員番号 404、8文字未満/項目欠金 400、`used_for` (REGISTER / PASSWORD_RESET) |

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

`users`, `invitation_codes`, `posts`, `post_acknowledgements`, `post_comments`, `chat_channels`, `chat_channel_members`, `chat_messages`, `seating_status`, `resources`, `reservations`, `facility_cells`, `approvals`, `school_schedules`, `audit_logs` (90日保持), `editing_locks` (3分TTL), `classes`, `subjects`, `exam_masters`, `exam_slots`, `exam_proctor_assignments`, `exam_teacher_exemptions` (全22テーブル / `npm run db:tables` でコード参照との整合確認可)

座席レイアウトは `seating_status` + `facility_cells` から導出、考査ステータスは `exam_masters` から導出するため専用のレイアウト/ステータステーブルは存在しない。教育ニュース (`/api/news`) は外部RSS＋インメモリキャッシュであり DB 永続化しない (意図された設計)。

## 開発メモ

- 二重予約判定は `toDateTime()` で `HH:MM` を `YYYY-MM-DD HH:MM:SS` に正規化して比較
- システムメッセージの `sender_id` は FK 制約のため、`resolveSenderId()` で `system` ユーザーへ変換
- `ensureSchema()` はプロメモ化され、複数プロセスからの同時適用による「pool closed」を防止
- スモークテストは `npm start`（HTTPS 3443）でサーバーを起動してから `npm run api:check` を実行する（`NODE_EXTRA_CA_CERTS=./certs/issystem-ca.pem` が付与されCAトラストで検証する）

