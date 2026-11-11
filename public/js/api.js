/**
 * ISSystem API Client (Fetch Wrapper with Auto-Token Injection)
 */

import { API_BASE_URL } from './config.js';
import { state, setUserSession } from './state.js';

/**
 * 共通Fetch処理ラッパー
 * @param {string} endpoint APIエンドポイント (例: '/bulletins')
 * @param {Object} options fetchオプション
 * @returns {Promise<any>} レスポンスJSONデータ
 */
export async function apiFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;

  // ヘッダーの設定と認証トークンの自動付与
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  // FormData (multipart/form-data) の場合はブラウザが Content-Type + boundary を生成するため削除
  if (options.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  if (state.authToken) {
    headers['Authorization'] = `Bearer ${state.authToken}`;
  }

  const config = {
    ...options,
    headers
  };

  try {
    const response = await fetch(url, config);

    // ログインエンドポイントかどうかの判定
    const isLoginEndpoint = endpoint.includes('/auth/login') || endpoint.includes('/login');

    // 401 / 403 の認証・権限エラー時の判定
    if (response.status === 401 || response.status === 403) {
      const errorData = await response.json().catch(() => ({}));

      // ログインリクエストの場合はセッション切れ処理を行わず、サーバーのエラーメッセージをそのまま返す
      if (isLoginEndpoint) {
        throw new Error(errorData.message || errorData.error || '教職員番号またはパスワードが正しくありません。');
      }

      // 403 は権限不足（セッションは有効）。ログアウトさせずサーバーメッセージを表示する
      if (response.status === 403) {
        console.warn('[API] 権限不足で拒否されました。');
        throw new Error(errorData.message || errorData.error || 'この操作を行う権限がありません。');
      }

      // 401 はセッション切れとして処理する。
      // トークンが存在した場合のみセッションを破棄する（未ログイン時の 401 は「セッション切れ」ではないため、
      // 警告ログとログアウト処理 (localStorage 削除) を行わない）
      if (state.authToken) {
        console.warn('[API] 認証セッションが無効です。再ログインが必要です。');
        setUserSession(null, null);
      }
      throw new Error(errorData.message || errorData.error || 'UNAUTHORIZED_OR_FORBIDDEN');
    }

    // レスポンスが 204 No Content の場合
    if (response.status === 204) {
      return { success: true };
    }

    const data = await response.json();

    if (!response.ok) {
      // エラーミドルウェアは error キー、コントローラーは message キーで返すため両対応
      const err = new Error(data.message || data.error || `APIエラー (Status: ${response.status})`);
      err.details = data.details ?? null;
      throw err;
    }

    return data;
  } catch (error) {
    console.error(`[API Error] ${options.method || 'GET'} ${endpoint}:`, error);
    throw error;
  }
}

/**
 * GET リクエスト送信
 * @param {string} endpoint 
 * @param {Object} [params] クエリパラメータ
 */
export async function apiGet(endpoint, params = null) {
  let url = endpoint;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        searchParams.append(key, value);
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }
  return apiFetch(url, { method: 'GET' });
}

/**
 * POST リクエスト送信
 * @param {string} endpoint 
 * @param {Object} body 
 */
export async function apiPost(endpoint, body = {}) {
  return apiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

/**
 * PUT リクエスト送信
 * @param {string} endpoint 
 * @param {Object} body 
 */
export async function apiPut(endpoint, body = {}) {
  return apiFetch(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

/**
 * DELETE リクエスト送信
 * @param {string} endpoint 
 */
export async function apiDelete(endpoint) {
  return apiFetch(endpoint, {
    method: 'DELETE'
  });
}

/**
 * multipart/form-data リクエスト送信（ファイル添付アップロード）
 * @param {string} endpoint
 * @param {FormData} formData
 */
export async function apiPostForm(endpoint, formData = new FormData()) {
  return apiFetch(endpoint, {
    method: 'POST',
    body: formData
  });
}

/**
 * Content-Disposition からファイル名を取り出す（UTF-8 の filename* を優先）
 * @param {string|null} disposition レスポンスヘッダー
 * @returns {string} ファイル名（取れれば）
 */
function filenameFromDisposition(disposition) {
  if (!disposition) return '';
  const utf8 = disposition.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch (e) {
      // 壊れた UTF-8 指定は無視して filename へ進む
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

/**
 * 認証付きファイルダウンロード（Bearer トークンをヘッダーで送る）
 * ブラウザの直接リンク（<a href>）は Authorization ヘッダーを送れないため、
 * 保護された添付 API はこの関数でのみ取得する（直リンクは 401 になる）
 * @param {string} endpoint APIエンドポイント (例: '/bulletins/attachments/att_xxx')
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function apiDownload(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;

  const headers = {};
  if (state.authToken) {
    headers['Authorization'] = `Bearer ${state.authToken}`;
  }

  const response = await fetch(url, { method: 'GET', headers });

  // 401/403 は JSON エラー body（ファイル本体は返らない）。apiFetch と同じ扱いでメッセージを出す
  if (response.status === 401 || response.status === 403) {
    const errorData = await response.json().catch(() => ({}));

    if (response.status === 403) {
      console.warn('[API] 権限不足でファイル取得が拒否されました。');
      throw new Error(errorData.message || errorData.error || 'このファイルを読む権限がありません。');
    }

    // トークンがあったのに 401 の時だけセッションを破棄する（未ログインの 401 はセッション切れではない）
    if (state.authToken) {
      console.warn('[API] 認証セッションが無効です。再ログインが必要です。');
      setUserSession(null, null);
    }
    throw new Error(errorData.message || errorData.error || 'ファイルを取得できませんでした。ログインし直してください。');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || errorData.error || `ファイルを取得できませんでした (Status: ${response.status})`);
  }

  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('Content-Disposition'));
  return { blob, filename };
}

/**
 * メモリ上のファイルをこの端末に保存する（ダウンロード）
 * @param {Blob} blob 取得したファイル本体
 * @param {string} filename 保存時のファイル名
 */
export function saveBlobAsFile(blob, filename = 'download') {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 保存が始まってから URL を捨てる（長く置くと同じ URL を再利用できない）
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}