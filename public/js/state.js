/**
 * ISSystem Global Application State Management
 */

import { APP_CONFIG } from './config.js';

// LocalStorage からの初期ロード
const storedToken = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
const storedUser = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.USER_DATA);
const storedTheme = localStorage.getItem(APP_CONFIG.STORAGE_KEYS.THEME_PREF) || APP_CONFIG.DEFAULT_THEME;

// アプリケーション全体の共通ステートオブジェクト
export const state = {
  currentUser: storedUser ? JSON.parse(storedUser) : null,
  authToken: storedToken || null,
  currentTheme: storedTheme,
  currentTab: 'dashboard',
  isKyomuMode: storedUser ? (JSON.parse(storedUser).role === 'KYOMU') : false,
  socketConnected: false,
  unreadCounts: {
    bulletin: 0,
    // v3.1: ダッシュボード「本日の連絡」ヘッダーのバッヂ（対象日が本日かつ未読）
    bulletinToday: 0,
    chat: 0
  }
};

/**
 * 登録日を 'YYYY-MM-DD' (JST 暦日) に正規化する
 * 'YYYY-MM-DD HH:MM:SS' (PostgreSQL の素朴 timestamp) は JST 壁時計として暦日を直接抽出する
 * @param {string} raw created_at 由来の文字列
 * @returns {string|null}
 */
export function normalizeRegisteredDay(raw) {
  if (!raw) return null;
  const s = String(raw);
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T]\d{2}:\d{2}/);
  if (naive && !/[Zz]|[+-]\d{2}/.test(s)) return naive[1];
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 9 * 3600000).toISOString().split('T')[0];
}

// ステート変更リスナー群
const stateListeners = new Set();

/**
 * ステート変更を監視するリスナーの登録
 * @param {Function} listener 
 * @returns {Function} 監視解除関数
 */
export function subscribeState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * 全リスナーへ変更を通知
 * @param {string} key 変更されたプロパティ名
 */
function notifyStateChange(key) {
  stateListeners.forEach(listener => listener(state, key));
}

/**
 * ログインユーザーセッションの更新および LocalStorage 同期
 * @param {Object|null} user 
 * @param {string|null} token 
 */
export function setUserSession(user, token) {
  state.currentUser = user;
  state.authToken = token;
  
  if (user && token) {
    // v3.1: 登録日を JST 暦日 ('YYYY-MM-DD') で保持（旧セッションに created_at が無い場合は制約なし＝全期間カウント）
    const registeredAt = normalizeRegisteredDay(user.created_at);
    if (registeredAt) {
      state.currentUser.registeredAt = registeredAt;
    }
    localStorage.setItem(APP_CONFIG.STORAGE_KEYS.USER_DATA, JSON.stringify(user));
    localStorage.setItem(APP_CONFIG.STORAGE_KEYS.AUTH_TOKEN, token);
    state.isKyomuMode = (user.role === 'KYOMU');
  } else {
    localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.USER_DATA);
    localStorage.removeItem(APP_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
    state.isKyomuMode = false;
  }
  
  notifyStateChange('currentUser');
}

/**
 * テーマ設定の更新
 * @param {string} theme 
 */
export function setThemeState(theme) {
  state.currentTheme = theme;
  localStorage.setItem(APP_CONFIG.STORAGE_KEYS.THEME_PREF, theme);
  notifyStateChange('currentTheme');
}

/**
 * 教務モード（権限）のトグル切替
 * @param {boolean} enabled 
 */
export function setKyomuModeState(enabled) {
  state.isKyomuMode = enabled;
  notifyStateChange('isKyomuMode');
}

/**
 * 未読バッジカウントの更新
 * @param {'bulletin'|'chat'} type 
 * @param {number} count 
 */
export function setUnreadCount(type, count) {
  if (state.unreadCounts[type] !== undefined) {
    state.unreadCounts[type] = count;
    notifyStateChange('unreadCounts');
  }
}

/**
 * アクティブタブの更新
 * @param {string} tabName 
 */
export function setActiveTabState(tabName) {
  state.currentTab = tabName;
  notifyStateChange('currentTab');
}