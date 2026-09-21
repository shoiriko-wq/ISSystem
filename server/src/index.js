// src/index.js
const express = require('express');
const path = require('path');
const cors = require('cors');

// DB接続と初期化処理の読み込み
const { initDatabase } = require('./db/schema');

// ルーティングファイルの読み込み
const classroomRoutes = require('./routes/classrooms');
const gymRoutes = require('./routes/gym');
const seatingRoutes = require('./routes/seating');

const app = express();
const PORT = process.env.PORT || 3000;

// サーバー起動前にDBテーブルを自動作成
initDatabase();

// ミドルウェアの設定
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ① 静的ファイル（HTML, CSS, JS）の配信設定
app.use(express.static(path.join(__dirname, '../public')));

// ヘルスチェック用API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'サーバーは正常に稼働しています' });
});

// ② 各APIエンドポイントの紐付け
app.use('/api/classrooms', classroomRoutes);
app.use('/api/gym', gymRoutes);
app.use('/api/seating', seatingRoutes);

// ③ 存在しないパスへのアクセスに対する404ハンドラー
app.use((req, res) => {
  res.status(404).json({ error: '指定されたページまたはAPIが見つかりません' });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});