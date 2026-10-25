/**
 * ISSystem Upload Service
 * multipart/form-data パース（Node 標準 Request/FormData API）と
 * 掲示板添付ファイルの検証・保存・削除を行う安全アップロード層
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'node:stream';
import config from '../../config/default.js';
import { ApiError } from '../middlewares/error.middleware.js';

// 学校業務で一般的な拡張白名单（実行ファイル・マクロ系は不可）
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
  '.txt', '.md', '.csv', '.tsv',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip',
]);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/octet-stream',
  'application/x-zip-compressed',
]);

/**
 * ファイル名をサニタイズ (パストラバーサル・制御文字対策)
 * @param {string} originalName
 */
export function sanitizeFileName(originalName) {
  const base = path.basename(String(originalName || 'file'));
  const cleaned = base
    .replace(/[\x00-\x1F]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.substring(0, 120) : 'file';
}

/**
 * Express リクエストの multipart/form-data ボディを Web Request 経由で解析する
 * （外部依存なし: Node 標準 undici Request.formData() を使用）
 * @param {import('express').Request} req
 * @returns {Promise<FormData>}
 */
export async function parseMultipart(req) {
  const contentType = String(req.headers['content-type'] || '');

  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new ApiError(415, 'multipart/form-data 形式でアップロードしてください。');
  }

  const headers = { 'content-type': contentType };
  if (req.headers['content-length']) {
    headers['content-length'] = String(req.headers['content-length']);
  }

  const webRequest = new Request(`http://${req.headers.host || 'localhost'}${req.originalUrl || req.url}`, {
    method: req.method,
    headers,
    body: Readable.toWeb(Readable.from(req)),
    duplex: 'half',
  });

  let form = null;
  try {
    form = await webRequest.formData();
  } catch (err) {
    throw new ApiError(400, `アップロードデータの解析に失敗しました: ${err.message}`);
  }
  return form;
}

/**
 * テキストフォームフィールドとファイルを分離して抽出する
 * @param {FormData} form
 */
export function extractFormParts(form) {
  const fields = {};
  const files = [];

  for (const [key, value] of form) {
    if (value instanceof File) {
      files.push({ key, file: value });
    } else {
      fields[key] = String(value);
    }
  }

  return { fields, files };
}

/**
 * 保存対象の絶対パス解決 (stored_name は UUID 由来の安全名のみ許容)
 * @param {string} storedName
 */
export function resolveStoredPath(storedName) {
  const base = path.basename(String(storedName || ''));
  if (!base || base.includes('..')) {
    throw new ApiError(400, '不正なファイル参照です。');
  }
  const rootDir = path.resolve(config.storage.uploadDir);
  const fullPath = path.join(rootDir, base);
  if (!fullPath.startsWith(rootDir)) {
    throw new ApiError(400, '不正なファイル参照です。');
  }
  return fullPath;
}

/**
 * クライアントへ返す添付メタデータ整形
 */
export function mapAttachment(row) {
  return {
    id: row.id,
    name: row.original_name,
    originalName: row.original_name,
    mime: row.mime_type,
    mimeType: row.mime_type,
    extension: row.extension,
    size: Number(row.size_bytes || 0),
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    downloadPath: `/bulletins/attachments/${row.id}`,
  };
}

/**
 * File エントリの検証・disk 保存・DB レコード作成
 * @param {Array<Object>} formFiles - [{ key, file }]
 * @param {Object} user - { id, name, role }
 * @param {import('../models/bulletin.model.js').bulletinModel} bulletinModel
 * @param {string|null} postId - 投稿 ID (null の場合は未紐付けで作成)
 * @returns {Promise<Array<Object>>}
 */
export async function saveFileEntries(formFiles, user, bulletinModel, postId = null) {
  const files = formFiles.map((f) => f.file).filter(Boolean);

  if (files.length === 0) {
    throw new ApiError(400, '添付ファイルが検出されませんでした。');
  }

  if (files.length > 10) {
    throw new ApiError(400, '添付ファイルは1回につき10件までです。');
  }

  const uploadDir = path.resolve(config.storage.uploadDir);
  await fsp.mkdir(uploadDir, { recursive: true });

  const maxBytes = Number(config.storage.maxFileSize || 10485760);
  const saved = [];

  for (const file of files) {
    const safeName = sanitizeFileName(file.name);
    const ext = path.extname(safeName).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new ApiError(415, `許可されていないファイル形式です (${ext || '拡張子なし'}): ${safeName}`);
    }

    const mime = String(file.type || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      throw new ApiError(415, `許可されていない MIME タイプです (${mime}): ${safeName}`);
    }

    const size = Number(file.size || 0);
    if (size <= 0) {
      throw new ApiError(400, `空のファイルは添付できません: ${safeName}`);
    }
    if (size > maxBytes) {
      throw new ApiError(413, `ファイルサイズが上限 (${Math.round(maxBytes / 1048576)}MB) を超えています: ${safeName}`);
    }

    const id = `att_${crypto.randomUUID()}`;
    const storedName = `${id}${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const targetPath = path.join(uploadDir, storedName);

    await fsp.writeFile(targetPath, buffer);

    const row = {
      id,
      post_id: postId || null,
      original_name: safeName,
      stored_name: storedName,
      mime_type: mime,
      extension: ext,
      size_bytes: size,
      uploaded_by: user && user.id ? user.id : null,
    };

    await bulletinModel.createAttachment(row);
    saved.push(mapAttachment(row));
  }

  return saved;
}

/**
 * アップロードされた全ファイルを検証し、disk + DB に保存する
 * @param {import('express').Request} req
 * @param {Object} user - { id, name, role }
 * @param {import('../models/bulletin.model.js').bulletinModel} bulletinModel
 * @returns {Promise<Array<Object>>} 保存された添付メタデータ一覧
 */
export async function saveUploadedFiles(req, user, bulletinModel) {
  const form = await parseMultipart(req);
  const { files } = extractFormParts(form);
  return saveFileEntries(files, user, bulletinModel);
}

/**
 * 添付ファイルの実体読み込み (存在検証込み)
 * @param {Object} attachmentRow - models から取得した行
 */
export function getAttachmentStream(attachmentRow) {
  const fullPath = resolveStoredPath(attachmentRow.stored_name);
  if (!fs.existsSync(fullPath)) {
    throw new ApiError(404, '添付ファイルの実体が見つかりません。削除済み可能性があります。');
  }
  return fs.createReadStream(fullPath);
}

/**
 * 添付ファイル実体の削除 (DB 行削除は呼び出し側で実施)
 * @param {string} storedName
 */
export async function removeStoredFile(storedName) {
  const fullPath = resolveStoredPath(storedName);
  try {
    await fsp.unlink(fullPath);
    return true;
  } catch (err) {
    console.warn('[UploadService] 実体ファイル削除失敗:', err.message);
    return false;
  }
}

export default {
  sanitizeFileName,
  parseMultipart,
  extractFormParts,
  saveFileEntries,
  saveUploadedFiles,
  resolveStoredPath,
  getAttachmentStream,
  removeStoredFile,
  mapAttachment,
};

