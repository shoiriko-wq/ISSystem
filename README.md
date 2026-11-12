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
- **複数アカウント対応**: 1ユーザーは複数メールアカウントを登録できる（`mail_accounts` は `UNIQUE (user_id, lower(email_address))`。`mail_messages.account_id` は `ON DELETE CASCADE` でアカウントに所属し、`UNIQUE (account_id, folder, uid)` で UID 重複を排除する）。受信箱のタブ欄最上段にアカウントタブ（末尾に追加 `+` タブ）を並べ、受信/送信ボックスタブはその下段に置く。表示・取得・送信・既読・削除はすべて `account_id` で対象アカウントを指定する（未指定はそのユーザーの1件目）。ヘッダーの「接続アカウント: … / 最終受信確認: …」行は廃止した（アカウントはタブで示す）。
- **自動受信**: メールタブ表示中は 60 秒周期 (`setInterval`) でアクティブアカウントの受信ボックスを再取得する（受信中はスキップ、受信失敗はサイレントでトーストを出さない、タブ切替と読み込み時もサイレント取得）。受信ボタンのアイコンは Lucide の `download`（`refresh-cw` は使わない）。
- 検証: `npm run test:api:mail-test`（Jest 6項目・存在しない `issystem.example` 宛てなので接続は必ず失敗し、`status=FAILED` と成功系はプローブ差し替えで検証）と `npm run test:ui:mail`（ブラウザ 52項目：アカウントタブ・追加 `+`・タブ切替・アカウント削除・60秒定期受信フック・ダウンロードアイコン・再読み込み後継続）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm start` / `npm run dev` | サーバー起動 (HTTPS/WSS + Cron + CA配布用HTTP) |
| `npm run cert:gen` | プライベートCAとサーバー証明書を生成（既存があればスキップ。`--force` で再発行） |
| `npm test` | jest 統合テスト (12スイート / 150テスト、stack 秘匿 4項目 (error.middleware) + bcrypt ハッシュ非露出 (auth 8c) 含む。各スイートで pg プールを close するため `--forceExit` 不要。`pretest` がDBを作り直すので全ゲート用) |
| `npm run test:one -- test/<file>.test.js` | 開発中の単スイート実行（`--runInBand` 直列・`pretest` を踏まない＝DB再構築しない）。既存の seed データのまま1スイートだけ回す速い経路 |
| `npm run api:check` | API スモークテスト (HTTPS の GET/POST/PUT/DELETE を実行しステータスを検証) |
| `npm run test:socket-auth` | Socket 接続権限検証 (tokenless / garbage / demoトークン / 外部Origin の拒否、KYOMU・ADMIN gate、ロック自保持限定、chat メンバーシップ、職員全体グループが一覧に出ないことの 21項目。サーバー起動後に実行。Node 側通信は `ca: [certs/issystem-ca.crt]` を明示) |
| `npm run test:rbac` | RBAC 権限検証 (`/api/users` 一覧のロール別最小化・追加 KYOMU のみ role=TEACHER 固定・削除 ADMIN のみ、招待コード発行 KYOMU/ADMIN、チャンネル削除 KYOMU/ADMIN の 17項目。TEACHER の権限昇格は 403。サーバー起動後に実行) |
| `npm run test:ratelimit` | ログイン・招待コード レート制限検証 (不存在ユーザー 25 回失敗ログインで 401×5→429×20、失敗ログインの `LOGIN_FAILED` 監査記録、招待コード 128bit=32文字16進大写、架空コード 5 試行→429、使用済みコード 400、ADMIN 後片付けの 8項目。ユーザー単位ロックアウト 423 は `test/auth.test.js` で検証。サーバー起動後に実行) |
| `npm run test:logsecurity` | ログ秘匿・保持検証 (404 レスポンスに stack なし、失敗ログイン 401 がアクセスログ `data/logs/access-YYYY-MM-DD.log` に記録、ログディレクトリ mode 700、アクセスログファイル mode 600、アクセスログに bcrypt ハッシュなし、ADMIN 監査 API に `LOGIN_FAILED`、監査 JSON にハッシュなし、レート制限 6回失敗=401×5+429×1 の 9項目。サーバー起動後に実行) |
| `npm run test:api:mail-test` | メール接続テスト API 検証 (Jest `test/mail.test.js` 6項目) |
| `npm run test:api:mail-defaults` | メール初期値 (.env プリフィル・Git 秘匿) API 検証 (12項目) |
| `npm run test:ui:mail` | メール UI 検証 (初回設定・プリフィル・接続テスト・受信箱・複数アカウントタブ・60秒定期受信の 52項目) |
| `npm run test:ui:exambasic` | 定期考査 基本情報「3. 科目 × 実施クラス・コース」の列幅・チップ配置検証 (実施数列なし / 科目名14%・略称8% / チップ内容分63% / はみ出し0 / チップクリック・Shift範囲選択・保存反映の 4ビューポート 38項目) |
| `npm run test:ui:examaddtop` | 考査 基本情報の「行の追加」が最上部・未入力の行1件だけ・ボタン無効（未入力の行の top が先頭：実測 487px < 保存済み行 552px < 末尾行 2426px / 行追加で画面がスクロールしない `main.scrollTop` 0→0 / ボタン disabled+aria-disabled / 2回押しても31件のまま / 保存 201→ボタン復活 / 未入力の行の削除 200→ベースライン復元 / 部屋 8→9→8 / 科目 9→10→9 / クラス 30→31→30 / 学年順＋名前順不変。クラス名は初期29名固定・学年内重複不可（409）・初期の行は削除不可（使用中の行の「削除」は使用状況照会後 DELETE 非送信、初期名の直接 DELETE は 409）の 22項目） |
| `npm run test:ui:bulletin-search` | 職員掲示板の全日検索 UI 検証 (タイトル・本文・投稿者名を全日で検索して左列が対象日見出し付きの全日の列表になる / タイトルの `<mark>` ハイライト・件数「N 件」・行の対象日チップ / 中心日表示は「全日」になり ‹ ›・本日・日付クリック（カレンダー開閉）は disabled（data-day は維持・固定幅なので › の位置は動かず） / 結果クリックは中心日を動かさず右ペインに全文 / 検索ピルは存在しない / ←/→・T・C キーは停止 / ミニカレンダーの検索該当枠と日付セル disabled（合成クリックでも中心日は動かない） / 検索語クリアで通常表示とナビが復帰・投稿者名検索・後片付けの 23項目) |
| `npm run test:ui:bulletin-title-pane` | 職員掲示板の左列（タイトル列表）の幅を画面幅ごとに px 実測 (床16rem(280px)・画面幅の26%・上限24rem(420px)の `clamp(16rem, 26vw, 24rem)` — 実測 768→280 / 900→280 / 1100→286 / 1280→333 / 1440→374 / 1600→416 / 1900→420px（打ち止め）、右ペインは余り（分割幅 − 左列 − gap(0.9rem) と ±2px で一致、1100px以上では右ペインが左列より広い、768pxでは右ペイン373px）、どの画面幅でもページ・右ペイン・左列に横スクロールなし、1280pxのタイトル文字幅は248px（16rem固定の旧195pxより広い）、極めて長いタイトルでも左列は期待幅のまま（列は押し広げられない・タイトルは1行で ellipsis 省略・行高39px）、左列の枠は2px実線1枚・角丸0.8rem・影なし、収納サイドバー(67.25px)と左列は重ならない（左列の左端 x=74 ≥ サイドバー右端67、main の padding-left 73.5px）、モバイル(390px)は左列全幅で縦 stacking の14項目) |
| `npm run test:ui:bulletin` | 職員掲示板の左右分割・列表・未読バッヂ UI 検証 (開始時に `post_acknowledgements` を空にして前回の検証の結果を引き継がない / 本日にサーバー登録の記事が本日列表へ出る・中心日ラベルは CSS 指定 5.4rem(94.5px) 固定で › の x は 1px も動かず描画実測は 1px 以内 / ‹ › と ←/→・T・C キーは 1日分ザッピング / 左列幅 clamp(16rem,26vw,24rem) 実測 / 右ペインの著者・詳細・添付・送信ボタン・ホバーリング（1px リング＋3px 浮き）/ 詳細モーダル・削除・他人投稿の DELETE 403 / 390px と 320px のレイアウト / サイドバーの全日未読数はクライアントと同じ計算（キャッシュ最新100件の未読・登録日以降・本日掲示有効）と一致 / reduced-motion でアニメ 0 の 68項目) |
| `npm run test:ui:bulletin-unread` | 職員掲示板の全日未読列表 UI 検証 (日付は今日から動的に導出（今日・今日-3・今日-6・今日+3 の fixture を API で作り、週ラベル期待値も今日から計算）。全日未読列表は登録日以降・対象日が今日の順（同一日は投稿時刻の降順）、週セパレータラベルは「先週 6 件」「2 週間前 3 件」など週数で出、ラベル左端 x は全行と同一・見出し左端より左へ出ない（右端は列幅 316px 超でよい）、行高さ 40px、サイドバーの未読ボタンは全日表示中は disabled、後片付け（DELETE→未読 2 減・ボタン hidden・本日列表復帰）の 98項目) |
| `npm run test:ui:bulletin-unread-btn-pos` | 職員掲示板の全日未読ボタンとミニカレンダー年月部の実ブラウザ寸法検証 (未読ボタンはツールバーの検索ボックスの真右で同一の高さ2.4rem(42px)・同一文字1.05rem(18.375px)・700・角丸0.5rem(8.75px)・枠2px実線1枚・bg-input・影なし（btn-secondary は使わず readability.css が張る）、ラベル「未読 N」はサイドバーの数字と同一、見出し右の未読バッヂは無し・ツールバーの「本日」ボタンも無し、年月部はスケジュールのカレンダーと同一設計（‹ [年月] ›）、ラベルクリックで年月選択メニュー（年 ‹ › + 12ヶ月 + 「本日へ」）はラベルの真下に中央揃え（左右余白9px・下4px・幅308px・ラベル中央＝メニュー中央）で開き focus は月ボタンへ、矢印キーで月焦点（メニュー開中は ←/→ は中心日を動かさない）、Esc で閉じて焦点はラベルへ、外クリックで閉じる、› で1ヶ月送り（中心日は本日まま）、「本日へ」で本日へ移動しメニューとカレンダーが閉じる、クリックで全日の未読一覧（中心日表示「未読」・‹ › と中心日クリックと年月ラベルと C キーが停止、未読ボタン自身も disabled）、T キーで閉じて本日へ戻る、後片付け（DELETE→未読数2減・未読ラベルとボタン hidden・列表は本日列表）の12項目) |
| `npm run test:ui:bulletin-download` | 職員掲示板の添付ダウンロード検証 (直リンク `<a href="/api/bulletins/attachments/..">` はブラウザナビゲーションで Authorization を送れず 401 になる原因を実測で確定 / サーバーのトークンなし GET は 401、トークン付き GET は 200・Content-Disposition のファイル名・バイト数が元ファイルと一致 / 新規投稿で .txt を添付して投稿（トースト・左列の行・右ペインの添付行）/ ダウンロードは BUTTON + `data-attachment-download`（pointer と1px実線枠、ラベル「ダウンロード」）で、掲示画面に API 直リンクの `<a>` は存在しない / 右ペインのボタンで保存動作（保存名・サイズ・中身が元ファイルと一致、API 200、成功トースト、ボタンは再利用可能）/ 詳細モーダルのボタンでも同じ（モーダルは閉じない、2回目の保存動作）/ ルール27: 投稿者・KYOMU・ADMIN だけダウンロード可、投稿者ではない TEACHER のトークン GET は 403（ファイル本体は返らない）で UI にボタンが出ない / 後片付け（投稿削除・添付レコードと実体ファイルを data/uploads から消す・既読レコード削除・検証用 TEACHER アカウントを ADMIN で削除）、Node 側は `ca: [certs/issystem-ca.crt]` で TLS を通すの 8項目) |
| `npm run test:ui:news-share` | ダッシュボード「記事を共有」UI 検証 (「すべて見る」撤廃 / 共有モーダルの開閉とURL入力 / **モーダルの中身は記事URL入力欄だけ（常設説明文なし＝`p` 0・本文はラベル「記事URL *」だけ。補完規則はプレースホルダーと `title` のみで伝える＝UI十条9・禁则6）** / **URL入力の7条件を computed style で実測（type・id・name・`autocomplete=off`・`aria-label`・`label[for]`・`border-main` 2px実線＝UI十条3・禁则8）** / URL空・不正の拒否 / スキーマ無しの `https://` 補完 / **共有の行き先は `POST /api/news/links`（`news_links`）だけ＝職員チャットへの投稿は発生しない（v3.1.7・禁则16）、タブはダッシュボードのまま** / サーバー実データ（`news_links`）への登録 / **共有リンクカードは1行表示を px 実測（flex行・タイトルリンク高19px・カード高38px以下（実測36px）・`white-space:nowrap`+`overflow:hidden`+`text-overflow:ellipsis`・下線なし・`title`属性＝リンクの全文（ホバーで全文）・右端の小さな日付（10px・右端余白12px以下・M/D形）・共有者名とドメインバッチは出ない・ホバーはカード本体だけ1pxリング＋3px浮きで中のリンクは二重リングなし（UI十条5）・新タブ `target=_blank` `rel=noopener`）** / **一覧は1列を px 実測（`#dash-news-summary` は `.dash-news-list`＝本日の連絡と同一の flex column・gap も本日の連絡と同一（実測13.125px）・カード幅は全カード同一＝2列にならない・タイトルは14px太字）** / **サーバー実データの `title_source`（`title` / `h1` / `og` / `domain`）記録と、ページタイトルが取れた時はタイトルがドメイン名でないこと** / **後片付け（このテストが作った共有リンクを掃除し、掃除後の API に残さない。実行ごとに一意なURLで共有済み 409 を防ぐ）** / 背景クリック・ESC・閉じるボタン・アイコン描画の 31項目) |
| `npm run test:ui:chat` | 職員チャット UI 検証 (「再通知」ボタン・`handleRenotifyAll`・再通知 API 廃止 / 未読者一覧トーストと既読更新 / 投稿直後の未読数（メンバー数-1）/ サーバー配信の未読名簿 / 別メンバー閲覧で未読 1 減 / リロード後の未読数一致 / 「目のマーク」非表示モードの連動 / メタの左右整列（相手=左からアイコン・名前・日時、自分=右から）/ ホバー時のプルダウンメニュー（実マウスで押せる・レイアウトシフトなし）/ **サーバーのチャンネル一覧は参加グループだけ（タイプは GROUP / DM / WORKFLOW のみ＝職員全体グループは0件。実測 types は `GROUP` と `WORKFLOW` のみ）** / **サイドバーのグループ行は参加グループだけ（行のIDはサーバーのグループ一覧の中に入り・「全体」の文字なし＝v3.1.4、実測 names「📋 教務部連絡」「🧭 進路指導連絡」+作成グループ）** / 検証用グループの削除後片付け。Node 側は `ca: [certs/issystem-ca.crt]` で TLS を通す) |

| `npm run test:ui:fx` | ダッシュボード労いカード（粒子アニメーション）＋開発・QA 用プレビューパネル UI 検証 (落下・上昇距離がカード高さ実測の `--fx-drop` に比例し ResizeObserver で再計算 / 年休等・出張の「記入する」ボタン撤廃 / パネルは常時表示され開閉バーが残る / テーマセレクト（自動+全13）と前・次で粒子テーマとモーションが切替 / 静的スウォッチ 13 (prefers-reduced-motion でも確認) / 疑似日付 2026-12-24→サンタ+クリスマスイブ文・季節セレクト（冬→夏）で季節文が即時切替・時刻帯5・曜日7・特別な日 13 期間ウィンドウ（年始 1/1–1/3・仕事始め 1/5–1/6・3学期始業式 1/7–1/9・3学期終業式 3/23–3/24・新年度 4/1–4/3・1学期始業式 4/8–4/10・1学期終業式 7/17–7/20・2学期始業式 9/1–9/3・クリスマス 12/23・12/24・12/25・2学期終業式 12/26–12/28・年末 12/29–12/31。セレクトは期間表 `DASH_EVENT_PERIODS` から自動生成）がすべて出る / 期間ウィンドウ算法（年度で ± 日がずれる学校の節目を期間で捕捉し同じ文を 3 日前後表示：疑似日付 2026-04-08・2026-04-10→第1学期始業式文+桜、2026-01-08→3学期始業式+紙吹雪、2026-03-24・2026-07-17→終業式+紙吹雪、2026-12-27→第2学期修了+サンタ、2026-12-29→大掃除+雪）/ 全メッセージセレクト（4組31文）で選んだ文がそのまま出る / 校内行事カードの見出しは「本日の校内行事」（「今日の」表記は出ない） / 復帰で全セレクト自動・実日時へ / `--fx-drop` ≥ カード高さ / 390px で横スクロールなし・全コントロールに label.for と枠線 / 人数タイルのクリックと Enter で年休等・出張の登録・確認モーダルが開きフィルタが効く（記入フォームはモーダル内常設、件数ラベル n名、bindAbsenceTile は件数非依存＝0名表示のタイルでもクリックで開く）/ 梅雨は降り注ぎ系 `fx-rain`（絵文字は傾き固定・回転なし・進行方向は下。JS が粒子ごとに 14〜24deg の `--fx-tilt` を振り、keyframes の角度は全 keyframe 同一、Y が 20%→50%→80% で単調に下がることを deg と px で実測）/ 瞬き系（陽光・日傘・海・お正月・夜の星）は粒子ごとに inline の top を 4% + i*7% + 0〜5% の帯で振って枠全体に広がる（CSS の top:8% はフォールバック。枠高249px で top 実測 30〜180px（8.8〜68.6%）、上端と下端の差 149〜150px（枠高さの60%）、下半分に4個、keyframes 50% の最下点 200px は枠内、全10粒子が枠内を px で実測）の 54項目) |
| `npm run test:ui:unread` | ダッシュボード「本日の連絡」未読バッヂ UI 検証 (カードは対象日が本日の掲示のみ・未読マーカーは未読カードのみ・ヘッダー右バッヂ＝本日未読 / カードクリックで `PUT /api/bulletins/:id/read` と本日バッヂ 1 減・マーカー消去・サイドバーとタイトルバッヂ連動 / カードクリックでタブ移動もモーダル開閉なし・既読カードの再クリックは API を叩かない（冪等） / サイドバー（数字のみ）＝タイトル（未読 N）＝全日未読 / 客户端キャッシュ 100 件未読はサイドバー 99+・タイトルとダッシュボード 未読 99+（擬似キャッシュで再現。100 を出さない、実キャッシュ復帰でバッヂが実データへ追従 / 登録日より古い記事（対象日=本日・掲示期間本日有効でも）と掲示開始前記事は未読バッヂに数えない / 後片付けの 17項目。テストはCAPSIM擬似キャッシュ中心で実 DB は本日記事と登録日前記事のみ) |
| `npm run test:ui:sidebar-push` | サイドメニューせり出し時の main 追従 UI 検証 (≥1100px はせり出し幅 285.25px に main の padding-left が追従し重なりなし (ホバー・is-focus のみ両経路、カーソル/フォーカス離脱で収納復帰)、768〜1099px はオーバーレイ維持 (main padding 不変)、500px は画面下バー・せり出しなしの 12項目) |
| `npm run test:ui:https` | 安全通信検証 (CA検証 / TLS / CAページ / API 426 / CA配布 / ブラウザ wss) |
| `npm run rotate:mail-key -- OLD_JWT_SECRET=<旧> (OLD_SECRET=<旧MAIL_ENC_SECRET> も可)` | mail_accounts の AES-256-GCM キーローテ (sha256(旧JWT) / scrypt(旧MAIL_ENC_SECRET) で暗号化された行を新 MAIL_ENC_SECRET 基準の scrypt キーへ再暗号化。再暗号化後にサーバー再起動) |
| `npm run db:create` / `db:init` / `db:seed` | DB 作成 / スキーマ適用 / ダミーデータ投入 |
| `npm run db:drop-general-chat` | 職員全体チャット撤廃 (v3.1.2) の既存DB移行: `chat_channels` から `general` / `chat-all` / `all` を DELETE（関連する `chat_messages` / `chat_message_reads` / `chat_channel_members` は ON DELETE CASCADE で連動削除。削除件数と残存チェックを表示） |
| `npm run db:mail-accounts` | メール複数アカウント移行 (2026/11/11) の既存DB移行: `mail_accounts` の `UNIQUE(user_id)` を撤去して `UNIQUE (user_id, lower(email_address))` へ、`mail_messages.account_id` (FK `ON DELETE CASCADE`) を追加し、UID 一意制約を `UNIQUE (account_id, folder, uid)` へ作り直す。旧DBの孤立メッセージはそのユーザーの最古アカウントへ割り当てる（冪等。アカウント一覧と内訳・未所属件数を表示） |
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
4. 操作できる要素はホバーで周りに1pxリング＋3px浮き＋影（影はリング目的のみ、背景は変えない）。操作できない面（ダッシュボード上段の労い・年休等・出張・要対応タスクカード＝`card--framed card--static`）は指カーソルを出さず（`cursor:default`）、ホバーでもリング・浮き上がり・背景/影の強調を出さない（指カーソルは実際にクリックできる要素にだけ出す。検証 `test:ui:frames` R4b）
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
9. `!important` はレイアウト寸法の確定に使う（`layouts.css` §6 のサイドバー寸法と `chat.module.js` のレイアウト修正）。色・影・装飾の上書きには使わない（`verify-docs` がサイドバー寸法の `!important` を検査する）
10. 旧全体チャット（`general` / `PUBLIC`）への投稿・参照・フォールバック禁止（v3.1.2 で撤廃済み。参加グループのみがチャット単位）

## 禁则（実装・検証の禁止事項）

11. テストの削除・スキップ・無効化は禁止（仕様変更時は既存テストの期待値・選択器・トースト文言を現実に合わせて更新する）
12. UIテストは寸法・位置・描画を px で実測して通す（CSS と JS 阅读だけで「通った」にしない）
13. UI十条を守る（寸法・色分け・ホバリングせり出し・main 追従・初回クリックは README の該当項目が正典。検証は `test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:frames` の px 実測）
14. `NODE_EXTRA_CA_CERTS` 環境変数を npm script に埋め込まない（CA信頼はユーザー環境で一度だけ登録し、テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）
15. DB破壊禁止 — テストが失敗した時に「DBのテーブル・レコードを消せ」と言わない（共有DBの衝突が原因。`pretest` が DB を作り直す）
16. 職員全体チャット general は全廃済み。コード・テスト・fixture にテストを一般（general）チャットへ変更した痕跡を残さない
17. チャットは発言者以外が読み書きする。server 側で `facilities.chats` の members を検証し、発言者以外の参加・発言・既読更新を server 側で拒否する
18. メールはメールタブのメールボックス（IMAP/SMTP）だけを扱う。外部メールサービスのAPIに接続しない
19. 教務と校長の2ロール以外を作らない。追加の権限（管理者など）を禁止
20. 検証の階層を省略・並列化しない — 開発中は該当スイートだけ（Jest は `npm run test:one`、UI は該当スイート1〜3本）、機能単位のコミット前は全ゲート（`npm test` → `api:check`（サーバー起動後）→ `test:ui:all` → `verify-docs`）。Jest の複数プロセス並列は禁止（共有DB衝突）。サーバーを再起動しないで UI テストを走らせない（古いコードにテストが当たって偽の失敗が出る）

## 検証の実行順序と制約

検証は**階層式**（AGENTS.md 第5条）。開発中は該当分だけ、機能単位のコミット前に全ゲート。

**開発中（速い経路）:**

- サーバー側を変えたら該当スイートだけ: `npm run test:one -- test/<該当>.test.js`（`--runInBand` 直列・`pretest` を踏まない＝DBを作り直さない）。既存の seed データのまま1スイートだけ回す。
- UI・レイアウト・ボタン・カード・枠・フォームを変えたら該当 UI スイートを1〜3本（上の表）。「CSS・JSを読むだけで通ったことにしない」— 寸法・位置・描画を px で実測する。
- **サーバーを再起動しないで UI テストを走らせない。** `npm start` が古いコードのままなら、UI テストは古いコードに当たって偽の失敗を出す。サーバー側を変えたら `npm start` を再起動してから UI テストを回す。
- UIスイートは同じDB（`issystem`）を共有し、テストが投稿・既読・fixture を作る。前の実行の残りがあると後のスイートが失败する。失敗したら `npm run db:seed` で状態を戻して再実行する（DB破壊はしない）。

**機能単位のコミット・リリース直前（全ゲート）:** `npm test` → `npm run api:check` → `npm run test:ui:all` → `node scripts/verify-docs.mjs` をこの順序で直列に通す。

- `npm test` は `pretest`（`scripts/init-db.js` + `scripts/seed.js`）でDBを作り直し、Jest を `--runInBand`（1プロセス直列）で走らせる。全テストが同一DB `issystem` を共有するため、**複数 Jest を並列実行するとテーブル・レコードが衝突して落ちる**。落ちた時に「DBのテーブル・レコードを消せ」とは言わない（DB破壊は禁止、原因は並列実行）。
- `test:ui:all`（32スイート）は実測で1スイート6〜32秒、全体で約10分。`npm start`（HTTPS/WSS 3443・監視 `0.0.0.0`、CA配布は `.env` の `PORT`）が起動している状態で実行する。
- `test:ui:https`（10項目）は CA配布ページを `.env` の `PORT` 実値から読む（2026-11-11 修正: 既定3000と `PORT=3030` のズレで10項目落ちていた）。残る失敗は**人間の環境**（OS信頼ストアに `certs/issystem-ca.crt` を一度だけ登録）が原因で、コードの劣化ではない。npm script に `NODE_EXTRA_CA_CERTS` は埋め込まない。
- 全ゲートの合否は**コード起因の失敗 0**で判定する。CA信頼未登録・UI残存状態・`.env` の `PORT` のズレは**設定・状態の問題**として扱い、人間に確認して片付ける。
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
- **職員全体チャット（general / `PUBLIC`）は撤廃済み（v3.1.2・2026/11/9）**: チャットチャンネルは個人が作成したグループのみ（`type` 既定 `GROUP`）。閲覧・送信・既読更新・参加はすべて `chat_channel_members` のメンバーシップのみで判定される（PUBLIC の抜け道なし）。seed は 3 グループ（`grade1` / `kyomu` / `suisin`）だけを作り、既存 DB の旧全体チャンネルは `npm run db:drop-general-chat` で撤去する。フロント (`chat.module.js`) はグループ未作成時に空状態メッセージ「表示できるグループがありません」を描画し API を叩かない（`showEmptyChannelState()`）。ダッシュボード「記事を共有」は職員チャットへ投稿しない（v3.1.7・共有は `POST /api/news/links` で `news_links` に1件追加するだけ＝ピノックアップ教育ニュースの共有リンク）。**API 作成の `type` ホワイトリスト（v3.1.4・2026/11/9）**: `POST /api/chat/channels` は `GROUP` / `DM` 以外の指定（`PUBLIC`・`PRIVATE`・`ALL` 等の架空タイプ）を `GROUP` へ寄せる（`chat.service.js` の `ALLOWED_USER_TYPES`。全体グループを作らせない）。フロントのグループ行アイコンは `users` のみ（`PUBLIC` の `globe` 分岐は撤去）。検証: `npm run test:socket-auth`（21項目。職員全体グループが一覧に出ないことを実測）と `test/chat.test.js`（`type: 'PUBLIC'` 指定が `GROUP` へ寄せられることを確認）、`npm run test:ui:chat`（サイドバーのグループ行が参加グループだけ＝行IDに `general` なし・「全体」の文字なし、サーバー一覧に `general`・全体タイプ 0件）
- **ダッシュボード「記事を共有」モーダルの中身は記事URL入力欄だけ（v3.1.3・2026/11/9）**: モーダル本文は `label[for="news-share-url"]` と URL 入力欄だけ（常設の操作説明文 `<p>` は置かない＝UI十条9・禁则6。「https:// を補完する」等の説明はプレースホルダーと `title` とトーストだけで伝える）。URL入力欄は入力の7条件（`type=url`・`id`・`name=news-share-url`・`autocomplete=off`・`aria-label=記事URL`・`label for`・`border-main` 2px実線）を満たす（禁则8）。検証は `npm run test:ui:news-share`（30項目・共有の行き先は `POST /api/news/links`＝職員チャットへの投稿は発生しない・テストが作った共有リンクは後片付けで削除し API に残さない）
- **共有リンクカードは1列・1行表示（v3.1.8・2026/11/11、1列化とタイトル14px化は v3.1.10・2026-11-12）**: 「ピノックアップ教育ニュース」の一覧は**1列**（`#dash-news-summary` は `.dash-news-list`＝「本日の連絡」と同一の flex column・gap 0.75rem。2列にはしない）。カード1枚は1行だけ＝「タイトルリンク（**14px**太字・`white-space:nowrap`+`overflow:hidden`+`text-overflow:ellipsis`で1行・長いタイトルは末尾を … で切る・`title`属性に全文（ホバーで全文）・下線と下地と二重リングなし（カード本体だけが1pxリング＋3px浮き＝UI十条5・禁则5））」＋「右端の小さな日付（10px・JST壁時計の M/D・右端余白12px以下）」。共有者名・ドメインバッチ・常設説明文は出ない（UI十条9）。元記事は新タブで開く（`target="_blank"`・`rel="noopener noreferrer"`）。CSS の寸法は `public/css/readability.css` §14（`!important` はレイアウト寸法の確定に使う＝禁则13）。検証は `npm run test:ui:news-share`（px実測）と `npm run test:ui:frames`（fixture の3枚で切り詰め・右端日付・枠2px・1列（flex column・gap とカード幅が本日の連絡と同一＝実測 gap 13.125px・カード幅 732px 全カード同一・カード高36px・リンク高19px）を px 実測、描画コードがカード1枚にリンク1本と日付1個だけであることを源码照合）
- **ページタイトルと出所（title_source）（v3.1.8・2026/11/11）**: 共有時に server がURLをfetchしてタイトルを `<title>` → `<h1>` → `og:title`（「記事名｜サイト名」のサイト名接尾を除く）の順で取り、取れないときだけドメイン名を使う。出所は `news_links.title_source`（`title` / `h1` / `og` / `domain`）へ記録し、API とダッシュボードへ返す（既定 `domain`、旧環境からの冪等マイグレーション `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）。検証は `npm run test:ui:news-share`（サーバー実データの `title_source` と「ページタイトルが取れた時はタイトルがドメイン名でない」）
- **ダッシュボード上段3カードはクリック誘導効果なし（v3.1.9・2026-11-11）**: 労いカード・「年休等・出張」・「要対応タスク」の3カードはカード自体にクリックハンドラが存在しない「面」＝`card--framed card--static`。指カーソルは出さず（`cursor:default`）、ホバーでも1pxリング・3px浮き上がり・背景/影の強調を出さない（`public/css/readability.css` 第10節 644〜654行。第9節・第10節のホバールール自体が `!important` なので、この上書きも `!important` で消す）。2pxの実枠と角丸はセクションカードと同一のまま。カード内で実際にクリックできるもの（年休等・出張の `role="button"` 人数タイル、「承認依頼一覧へ」ボタン、4セクションの記事カード、天気ウィジェット）は従来どおり指カーソル＋ホバーリングが出る。検証は `npm run test:ui:frames`（`scripts/test-frame-rules.mjs` 24項目＝R4b 追加5項目と R3b2（教育ニュース一覧が1列＝flex column・gap とカード幅が本日の連絡と同一）で computed style を実測）と `npm run test:ui:fx`（タイルクリック・キーボード Enter で登録・確認モーダルが開く回帰）
- **ピノックアップ教育ニュースは1列・タイトル14px（v3.1.10・2026-11-12）**: 枠を**2列から1列へ**変更（`#dash-news-summary` を `grid grid-cols-1 md:grid-cols-2 gap-3` → `.dash-news-list`＝「本日の連絡」と同一の flex column・gap 0.75rem。取得中/空状態の `col-span-2` は2箇所撤去）し、タイトルリンクを 12px→**14px** へ大きくした（700・line-height 1.35・1行末尾 … 切り詰め・`title` 全文ホバーはそのまま、右端日付 10px と枠 2px は不変）。実測（Chrome 1280×1200・`https://127.0.0.1:3443`）: タイトルリンク高 **19px**、カード高 **36px**、カード幅 **732px**（3枚すべて同一＝2列にならない）、一覧 gap **13.125px** ＝ 本日の連絡（`#dash-pinned-bulletins`）の gap と同一。ホバー 1px リング＋3px 浮きと中のリンクの二重リング禁止（UI十条5）は第8/9節のまま。検証: `npm run test:ui:news-share`（**31項目 ALL OK**・一覧1列の実測を追加・後片付けで共有リンク1件掃除・API 残り0）と `npm run test:ui:frames`（**24項目 PASS・failure 0**・R3b 期待値更新と R3b2 追加）。テストの削除・スキップ・弱化はしない。`test:ui:fx` と `test:ui:audit` の目視（スクリーンショット）確認は人間の判断に委ねる


