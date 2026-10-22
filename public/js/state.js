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
    chat: 0
  },
  globalSearchQuery: ''
};

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