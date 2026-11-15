/**
 * ISSystem CSV 一括登録 Controller (v3.1.15)
 * POST /api/users/import/preview : CSV を検証し preview_id と行の合否を返す (DB 書き込みなし)
 * POST /api/users/import/commit  : 承認行を 1 トランザクションで INSERT (must_change_password=1)
 * 教務部 (KYOMU/ADMIN) 限定。ルート側で authenticateToken + requireKyomuRole を通す (§5)
 */
import userImportService from '../services/user-import.service.js';

// base64 デコード後の CSV 上限 (200行 × 約200byte を吸収する 256KB)
const MAX_CSV_BYTES = 256 * 1024;

function decodeCsv(csvBase64) {
  const text = String(csvBase64 ?? '');
  if (!text) return null;
  const buf = Buffer.from(text, 'base64');
  if (buf.length > MAX_CSV_BYTES) return null;
  return buf.toString('utf-8');
}

export const userImportController = {
  /**
   * プレビュー検証 (v3.1.15)
   * POST /api/users/import/preview
   */
  async preview(req, res, next) {
    try {
      const { csvBase64, fileName } = req.body;
      if (!csvBase64) {
        return res.status(400).json({ success: false, message: 'CSVデータ (csvBase64) が空です。' });
      }
      const csvText = decodeCsv(csvBase64);
      if (csvText === null) {
        return res.status(413).json({ success: false, message: 'CSV が大きすぎます (base64 展開後 256KB 以下にしてください)。' });
      }
      const result = await userImportService.createPreview(csvText, req.user, String(fileName || '').slice(0, 120));
      return res.status(200).json({ success: true, message: 'CSV を検証しました。登録行を承認して確定してください。', ...result });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 確定 (v3.1.15)
   * POST /api/users/import/commit
   */
  async commit(req, res, next) {
    try {
      const { preview_id, rows } = req.body;
      if (!preview_id || typeof preview_id !== 'string') {
        return res.status(400).json({ success: false, message: 'preview_id が指定されていません。CSV をアップロードしてください。' });
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ success: false, message: '登録する行 (rows) を選択してください。' });
      }
      const rowNos = rows.map((n) => Number(n));
      if (rowNos.some((n) => !Number.isInteger(n) || n < 1)) {
        return res.status(400).json({ success: false, message: 'rows は CSV 行番号の正整数配列です。' });
      }
      const result = await userImportService.commitImport(preview_id, rowNos, req.user);
      return res.status(201).json({
        success: true,
        message: `${result.created_count}件の教職員アカウントを登録しました。初期パスワードは各自に変更させてください。`,
        ...result
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * テンプレート CSV (v3.1.15 §5)
   * GET /api/users/import/template
   */
  async getTemplate(req, res) {
    const t = userImportService.buildTemplateCsv();
    return res.status(200).json({
      success: true,
      headers: t.headers,
      sample: t.sample,
      csvText: t.csvText,
      required_columns: userImportService.REQUIRED_COLUMNS
    });
  }
};

export default userImportController;
