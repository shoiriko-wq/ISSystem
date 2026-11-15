
# Agent Rules

## Tool Usage
- Always use available tools (read, edit, bash, grep, glob, write) for file operations.
- Never guess file contents. Always read files before editing.
- Use tools proactively and verify results.
- Do not output raw source code in chat; use edit/write tools instead.

UIのチェックや動作確認は「チェックしてください」というような明確な指示がこちらからない場合はチェックはこちらで行います。
こちらで確認できない部分のチェックのみお願いします。
そうしないと開発が遅くなってしまいます。
開発の最終段階でまとめてチェックして完成とします。

## 検証と文書（要点。正典は `README.md` と `ISSystem仕様書.md` §17）
- UI十条の正典は `README.md` に置く（AGENTS.md は要点参照。寸法・色分け・せり出し・追従・初回クリックの検証は `test:ui:sidebar` / `test:ui:sidebar-push` / `test:ui:nav` / `test:ui:frames` の px 実測）。
- 検証階層: 開発中は該当分だけ（サーバー側は `npm run test:one -- test/<該当>.test.js`、UI は該当スイートを1〜3本）。機能単位のコミット・リリース直前は全ゲート `npm test` → `npm run api:check`（`npm start` 起動後）→ `npm run test:ui:all` → `node scripts/verify-docs.mjs` をこの順序で直列に回す。
- Jest は `--runInBand` で1プロセス直列。全テストが同一DB `issystem` を共有するため並列実行はテーブル・レコードが衝突して失敗する（DB破壊は禁止。UIスイートは前実行の残存状態で失敗することがあり `npm run db:seed` で状態を戻す）。
- CA信頼はユーザー環境で一度だけ登録し、npm script に `NODE_EXTRA_CA_CERTS` は埋め込まない（テストは `ca: [certs/issystem-ca.crt]` を明示的に渡す）。
- 検証用一時成果物（`data/`・`ui*.txt`・`t*.txt`・`vd*.txt`・`api*.txt`・`nohup.out` 等）は `.gitignore` で無視し Git に追跡しない。テストの削除・スキップ・無効化は禁止（仕様変更時は期待値を現実へ更新）。
- 実装を変えたら同じコミットで `README.md`・`ISSystem仕様書.md`（§14 と §17 と §18 改訂履歴）と `CHANGELOG.md`（人間が指示する）を行数・項目数まで実測値へ更新する。UI を変えたら §14 も更新する。