/**
 * ISSystem Private CA Controller (プライベートCA・安全通信誘導)
 *
 * - 非HTTPアクセス → CAダウンロードページを表示
 * - 非HTTPの API 呼び出し → 426 Upgrade Required
 * - HTTPS側でも /ca ページとCA証明書のダウンロードを提供（配布は公開情報）
 */

import fs from 'fs';
import config from '../../config/default.js';
import { getCaInfo, sslPaths, buildCaPage, CA_FILE_NAME } from '../services/ca.service.js';

/** リクエストホスト名（ポート番号を除く）を返す */
const hostNameOf = (req) => (req.headers.host || 'localhost').split(':')[0].trim() || 'localhost';

/** 非HTTPアクセス時に返す誘導JSON（CAページとHTTPS URL） */
const guidanceJson = (req, extra = {}) => ({
  success: false,
  ...extra,
  ca_page: `http://${req.headers.host}/ca`,
  https_url: config.ssl.caPageBase || `https://${hostNameOf(req)}:${config.ssl.httpsPort}/`,
});

export const caController = {
  /**
   * CAダウンロードページの表示
   * GET /ca（HTTP・HTTPS 両対応）
   */
  showCaPage(req, res, next) {
    try {
      const secure = req.protocol === 'https';
      const caInfo = getCaInfo();
      const html = buildCaPage({
        secure,
        host: hostNameOf(req),
        httpsPort: config.ssl.httpsPort,
        secureUrl: config.ssl.caPageBase,
        caFileName: CA_FILE_NAME,
        caInfo,
      });
      return res.status(200).type('html').send(html);
    } catch (error) {
      next(error);
    }
  },

  /**
   * ルートCA証明書（.pem）のダウンロード
   * GET /ca/issystem-ca.pem
   */
  downloadCaPem(req, res, next) {
    const paths = sslPaths();
    if (!fs.existsSync(paths.ca)) {
      return res.status(404).json({
        success: false,
        message: 'CA証明書が見つかりません。サーバー側で `npm run cert:gen` を実行してください。',
      });
    }
    return res.download(
      paths.ca,
      CA_FILE_NAME,
      {
        setHeaders: (r) => {
          r.setHeader('Cache-Control', 'no-store');
          r.setHeader('Content-Type', 'application/x-pem-file');
          r.setHeader('X-Content-Type-Options', 'nosniff');
        },
      },
      (err) => {
        if (err) return next(err);
      }
    );
  },

  /**
   * 非HTTP（非安全）アクセスに対する誘導レスポンス
   * 426 Upgrade Required（Upgrade Required）
   */
  insecureTransport(req, res) {
    return res
      .status(426)
      .json(
        guidanceJson(req, {
          error: 'INSECURE_TRANSPORT',
          message:
            'ISSystem はプライベートCAによる安全通信 (HTTPS / WSS) を使用しています。' +
            'CA証明書をインストールし、安全接続 (HTTPS) でアクセスしてください。',
        })
      );
  },

  /**
   * 非HTTPポートへ来た任意リクエストの振り分け（CA配布専用ポートの入口）
   * - favicon / apple-touch-icon → 204（ページ描画対象外）
   * - GET/HEAD 以外のメソッド → 405 Method Not Allowed
   * - API的パス・JSON期望 → 426 Upgrade Required
   * - それ以外のブラウザGET → CAダウンロードページ
   */
  insecureRequest(req, res, next) {
    if (req.path === '/favicon.ico' || req.path === '/apple-touch-icon') {
      return res.status(204).end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res
        .status(405)
        .json(
          guidanceJson(req, {
            error: 'METHOD_NOT_ALLOWED',
            message:
              '非安全ポート (HTTP) はCA証明書の配布専用です。' +
              'アプリの API は安全接続 (HTTPS) でのみ利用できます。',
            allowed: ['GET', 'HEAD'],
          })
        );
    }

    const accept = String(req.headers.accept || '');
    const wantsJson = accept.includes('application/json') && !accept.includes('text/html');
    const apiLike =
      req.path.startsWith('/api') || req.path.startsWith('/socket.io') || req.path.startsWith('/uploads');

    if (wantsJson || apiLike) {
      return caController.insecureTransport(req, res);
    }

    return caController.showCaPage(req, res, next);
  },
};

export default caController;
