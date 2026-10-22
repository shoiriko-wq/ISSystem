/**
 * ISSystem Theme Switching & Management
 */

import { APP_CONFIG } from './config.js';
import { state, setThemeState } from './state.js';
import { openModal, closeModal, showToast } from './ui-helpers.js';

// 対応テーマ一覧
export const SUPPORTED_THEMES = [
  { id: 'navy', name: '標準ネイビー', class: 'theme-navy' },
  { id: 'high-contrast', name: 'ハイコントラスト', class: 'theme-high-contrast' },
  { id: 'warm', name: 'ウォームウッド', class: 'theme-warm' },
  { id: 'dark', name: 'ダークモード', class: 'theme-dark' }
];

/**
 * テーマの適用
 * @param {string} themeId 
 */
export function applyTheme(themeId) {
  const htmlEl = document.documentElement;
  
  // 既存のテーマクラスを消去
  SUPPORTED_THEMES.forEach(t => {
    htmlEl.classList.remove(t.class);
  });

  const selectedTheme = SUPPORTED_THEMES.find(t => t.id === themeId) || SUPPORTED_THEMES[0];
  htmlEl.classList.add(selectedTheme.class);

  // ステートおよびLocalStorageへの保存
  setThemeState(selectedTheme.id);
}

/**
 * テーマ切り替えUIモーダルの初期化
 */
export function initThemeManager() {
  // 初期テーマの適用
  applyTheme(state.currentTheme);

  const themeBtn = document.getElementById('theme-menu-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      openModal('theme-modal');
    });
  }

  // テーマ選択ボタンのイベントリスナー
  document.querySelectorAll('.theme-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const themeId = btn.getAttribute('data-theme-set');
      if (themeId) {
        applyTheme(themeId);
        closeModal('theme-modal');
        
        const themeInfo = SUPPORTED_THEMES.find(t => t.id === themeId);
        showToast(`テーマを「${themeInfo ? themeInfo.name : themeId}」に切り替えました`, 'success');
      }
    });
  });
}