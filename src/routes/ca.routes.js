/**
 * ISSystem CA Routes (プライベートCAダウンロードページ / 証明書配布)
 * 安全接続 (HTTPS) でも /ca ページとCA証明書を取得できる
 */

import { Router } from 'express';
import { caController } from '../controllers/ca.controller.js';
import { CA_FILE_NAME } from '../services/ca.service.js';

const router = Router();

// GET /ca → CAダウンロード・設定ページ
router.get('/', caController.showCaPage);

// GET /ca/issystem-ca.crt → ルートCA証明書（公開情報・.crt）のダウンロード
router.get(`/${CA_FILE_NAME}`, caController.downloadCa);

export default router;
