# Agent Rules

## Tool Usage
- Always use available tools (read, edit, bash, grep, glob, write) for file operations.
- Never guess file contents. Always read files before editing.
- Use tools proactively and verify results.
- Do not output raw source code in chat; use edit/write tools instead.

## 作業の約束（プロジェクトの中心ルール・10条＋α）
1. **設計文書を最初に読む**: `README.md`（システム総意・UI十条・禁则）・`ISSystem仕様書.md`（現行実装基準＝層構成・API一覧・権限・既知の課題・意図された非実装）を最初に読み、実装から逸脱しない。
2. **ドキュメント同期**: 挙動・UI・API・制約を変えたら `README.md` / `ISSystem仕様書.md` / `CHANGELOG.md` を同じコミットで更新する。CHANGELOG の更新は人間が指示。
3. **UI テストはヘッドレス Chrome 実測**: UI 規約の検証は `scripts/test-*.mjs`（Puppeteer Core）で描画・寸法・位置を数値で測定し、`npm run test:ui:all` を通す。推測で合否を判定しない。
4. **UI 十条（UI契約）**
   1. 見出し・カード・枠は 2px 実線を 1枚（`border-main`）、影・グラデーション・影文字禁止
   2. モーダルは「画面中央中央・余白10px・`max-height:90dvh`・内部スクロール・`max-width` 上限・閉じボタン」
   3. 入力は「`type`・`id`・`name`・`autocomplete`（新規 `new-password`／既存 `username`）・`aria-label`・`label for`・`border-main`」の7条件
   4. 操作可能要素はホバーで周りに1pxリング＋3px浮き＋影（影はリング目的のみ、背景は変えない）
   5. 色は60-70%彩度・35%明度の単色、コントラスト比4.5以上（`test-chrome-contrast.mjs`）
   6. 文字は「Noto Sans JP + Tencent Sans」Webフォント、font-family 直書き禁止
   7. 画面は常時スクロール禁止（`100dvh`・`overflow:hidden`）、コンテンツは内部スクロール
   8. 左サイドバーは常時収納＋せり出しオーバーレイ（`layouts.css` §6: 768px以上は画面幅を問わず収納 67.25px・アイコンのみ正方形タイル。ホバリング（`:hover`＋JS `is-hover`）とフォーカス（JS `is-focus`）で 16.3rem（285.25px）へせり出し、`#app-body` 内の `position:absolute` オーバーレイ。ラベルは `display:none` ではなく幅0で隠し、せり出しで幅が伸びて真横に現れる。≥1100px では `main` の `padding-left` がせり出し幅へ追従し重ならない。767px以下は画面下バー（アイコンのみ、ホバリングでも文字を出さない）。収納時とせり出し時は寸法・位置を px で実測し、余白・隙間・縮小・見切れ・ラベルの縦移動・斜め移動がないことをスクリーンショットと数値で確認する（`display:none` の切替は縦移動・斜め移動になるため禁止）。せり出しで行の高さを変えないため、アイコンの初回クリックが吸収されずタブが切り替わる。色分け（青=選択、緑=有効、赤=削除、黄=未完了）、枠（`border-main` 2px・角丸0）、影（ホバリング目的のみ）を守る。検証 `npm run test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:frames` R6）
   9. 操作説明文は常設禁止（トースト・title・プレースホルダーのみ）
   10. 説明文・コメントは小学生にも分かる日本語、英英対訳禁止、コードは日本語コメント
5. **ドキュメントは小学生にも分かる日本語**: コードコメントも説明文も小学生が読める日本語で書く（英英対訳禁止）。
6. **UI 変更は UI 検証を走らせる**: レイアウト・ボタン・カード・枠・フォームを変えたら該当する UI テスト（`test:ui:frames` / `test:ui:modal` / `test:ui:chrome` / `test:ui:sidebar-push` 等）を個別に実行して数値で確認する。
7. **サーバー変更は `npm run api:check`**: 起動済みサーバー（`npm start`＝HTTPS 3443）に対するスモーク `scripts/api-smoke-test.js` を通す。
8. **ドキュメントの矛盾は verify-docs で検出**: `node scripts/verify-docs.mjs` を最終ゲートに含む。検証内容: UI十条が README と AGENTS.md に揃う / サイドバー寸法（収納 67.25px・せり出し 16.3rem）が CSS と文書で一致 / `test:ui:all` が全 `scripts/test-*.mjs`（Puppeteer 版）を漏れなく含む / `npm test` が `pretest`（DB初期化＋シード）後に `--runInBand` 直列 / APIスモークが全トップレベルAPIとhealthをカバー / AGENTS.md の検証規則（直列・順序・省略禁止）が存在 / 旧全体チャット参照の残存（マイグレーションを除く） / 仕様書の「既知の課題」「意図された非実装」「改訂履歴」「テスト実行の順序と制約」の節 / CHANGELOG の存在。
9. **テストを削除しない**: 新機能の検証は新規 `scripts/test-*.mjs` を追加して実施する。既存テストの削除・スキップ・無効化は禁止。
10. **既存UIテストの更新**: 仕様変更に伴い既存 `scripts/test-*.mjs` の期待値・選択器・トースト文言を現実に合わせて更新する（テスト自体を消さない）。
11. **職員全体チャットは存在しない（v3.1.2 撤廃）**: `general` / `PUBLIC` チャネルへの参照・投稿・フォールバック・「全体職員へ共有」トースト・「全員既読」ボタンをコードに置かない。参加グループが無い場合は共有を送らず警告トースト。UI テストは seed の参加グループ（`kyomu` / `suisin`）で検証する。
12. **検証は直列・順序どおり・省略禁止（共有DBと自己起動サーバー）**: 検証は `npm test` →（サーバー起動済みなら）`npm run api:check` → `npm run test:ui:all` → `node scripts/verify-docs.mjs` の順で通し、どれも省略しない。`npm test` は `pretest`（`init-db` + `seed`）でDBを用意し Jest を `--runInBand`（1プロセス直列）で走らせる。全テストが同一DB `issystem` を共有するため、複数 Jest を並列実行するとテーブル・レコードが衝突して落ちる（Jest が落ちた時に「DBのテーブル・レコードを消せ」とは言わない — 原因は直列実行の中止であり、DB破壊は禁止）。UI テスト（`scripts/test-*.mjs`・Puppeteer Core）は `https://localhost:3443` を自己起動（起動済みなら再利用）して描画・寸法・位置を実測する。APIスモーク `npm run api:check` は `npm start`（HTTPS/WSS 3443・監視 `0.0.0.0`）起動後に実行する。CA の信頼はユーザー環境で一度だけ登録し、`NODE_EXTRA_CA_CERTS` 環境変数を npm script に埋め込まない（テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）。

## 実装・検証コマンド
- 単体テスト: `npm test`（Jest 30・`--runInBand`・`pretest` でDB初期化＋シード）→ 現 172 テスト全通過
- API スモーク: `npm start`（HTTPS 3443）後に `npm run api:check`
- UI スイート: `npm run test:ui:all`（チャット・未読・モーダル・サイドバー・施設・日程・試験・座席・コントラスト等 20+）
- ドキュメント矛盾検出: `node scripts/verify-docs.mjs`
- 旧全体チャット撤去マイグレーション: `npm run db:drop-general-chat`

## 禁则（UI契約の禁止事項）
1. 影（影文字・背景影・グラデーション）禁止 — 影はホバーリング目的のみの1種のみ
2. 枠の多層描画禁止 — 実線1枚のみ、太さ2px
3. 画面全体の常時スクロール禁止
4. 説明文・コメントの英語表記禁止（日本語で書く）
5. font-family 直書き禁止（Webフォント運用）
6. 「〜してください」「〜でしてください」等の操作説明を画面内に置く慣例禁止
7. モーダルの高さ上限なし・余白なし中央寄せ禁止
8. 入力の `label`・`aria-label`・`autocomplete` 省略禁止
9. `!important` 上書き禁止（`chat.module.js` のレイアウト修正は例外）
10. 旧全体チャット（`general` / `PUBLIC`）への投稿・参照・フォールバック禁止（v3.1.2 で撤廃済み。参加グループのみがチャット単位）

## 禁则（実装・検証の禁止事項）

11. テストの削除・スキップ・無効化禁止 — 既存テストの期待値・選択器・トースト文言を現実に合わせて更新する
12. UIテストは寸法・位置・描画を px で実測して通す（CSS と JS 阅读だけで「通った」にしない）
13. UI十条を守らない変更（正方形タイル崩し・px 未実測・余白・縮小・見切れ・色分け崩し・せり出し崩し・main 追従なし・初回クリック吸収）禁止
14. `NODE_EXTRA_CA_CERTS` 環境変数を npm script に埋め込むこと禁止（CA信頼はユーザー環境で一度だけ登録し、テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）
15. DB破壊禁止 — テストが失敗した時に「DBのテーブル・レコードを消せ」と言わない（原因は共有DBの衝突。`pretest` が DB を作り直す）
16. 職員全体チャット general は全廃済み。コード・テスト・fixture にテストを一般（general）チャットへ変更した痕跡を残さない
17. チャットは発言者以外が読み書きする。server 側で `facilities.chats` の members を検証し、発言者以外の参加・発言・既読更新を server 側で拒否する
18. メールはメールタブのメールボックス（IMAP/SMTP）だけを扱う。外部メールサービスのAPIに接続しない
19. 教務と校長の2ロール以外を作らない。追加の権限（管理者など）を禁止
20. 検証の省略・並列化禁止 — `npm test`（`--runInBand` 直列）→ `api:check`（サーバー起動後）→ `test:ui:all` → `verify-docs` を順序どおり通す
