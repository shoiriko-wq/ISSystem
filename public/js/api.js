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

    // 401 または 403 認証・権限エラー時の判定
    if (response.status === 401 || response.status === 403) {
      const errorData = await response.json().catch(() => ({}));
      
      // ログインリクエストの場合はセッション切れ処理を行わず、サーバーのエラーメッセージをそのまま返す
      if (isLoginEndpoint) {
        throw new Error(errorData.message || errorData.error || '教職員番号またはパスワードが正しくありません。');
      }

      // 通常の保護されたAPI呼び出しで401/403が返った場合はセッション切れとして処理
      console.warn('[API] 認証セッションが無効です。再ログインが必要です。');
      setUserSession(null, null);
      throw new Error(errorData.message || errorData.error || 'UNAUTHORIZED_OR_FORBIDDEN');
    }

    // レスポンスが 204 No Content の場合
    if (response.status === 204) {
      return { success: true };
    }

    const data = await response.json();

    if (!response.ok) {
      // エラーミドルウェアは error キー、コントローラーは message キーで返すため両対応
      throw new Error(data.message || data.error || `APIエラー (Status: ${response.status})`);
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