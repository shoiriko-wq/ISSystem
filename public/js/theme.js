/**
 * ISSystem Theme Switching & Management
 */

import { APP_CONFIG } from './config.js';
import { state, setThemeState } from './state.js';
import { openModal, closeModal, showToast } from './ui-helpers.js';

// 対応テーマ一覧（CSS クラスは variables.css の html.theme-* と一致させる）
// mode: CSS のコントラスト/視認性調整レイヤー (readability.css) がライト/ダークで分岐するための判定に使用
export const SUPPORTED_THEMES = [
  { id: 'light-standard', name: 'ライト（標準）', class: 'theme-light-standard', mode: 'light', palette: ['#eef2f7', '#4f46e5', '#1e293b'] },
  { id: 'light-sky', name: 'スカイライト', class: 'theme-light-sky', mode: 'light', palette: ['#eaf3fa', '#0284c7', '#1b3547'] },
  { id: 'light-forest', name: 'フォレストライト', class: 'theme-light-forest', mode: 'light', palette: ['#ecf4ec', '#15803d', '#1e3126'] },
  { id: 'light-sakura', name: 'サクラライト', class: 'theme-light-sakura', mode: 'light', palette: ['#f9eaf1', '#db2777', '#3a2129'] },
  { id: 'light-sepia', name: 'セピアライト', class: 'theme-light-sepia', mode: 'light', palette: ['#efe6d7', '#b45309', '#3b3126'] },
  { id: 'light-candy', name: 'キャンディライト', class: 'theme-light-candy', mode: 'light', palette: ['#fbe9f1', '#e11d48', '#341f2c'] },
  { id: 'light-mint', name: 'ミントライト', class: 'theme-light-mint', mode: 'light', palette: ['#e9f4f0', '#0d9488', '#16352f'] },
  { id: 'light-paper', name: 'ペーパー（明・高コントラスト）', class: 'theme-light-paper', mode: 'light', palette: ['#ffffff', '#1d4ed8', '#0b0b0f'] },
  { id: 'dark-navy', name: 'ダークネイビー', class: 'theme-dark-navy', mode: 'dark', palette: ['#0f172a', '#6366f1', '#f8fafc'] },
  { id: 'dark-midnight', name: 'ミッドナイトブラック', class: 'theme-dark-midnight', mode: 'dark', palette: ['#0b1120', '#818cf8', '#e8eefc'] },
  { id: 'dark-forest', name: 'フォレストダーク', class: 'theme-dark-forest', mode: 'dark', palette: ['#0e1a14', '#34d399', '#e8f5ec'] },
  { id: 'dark-ocean', name: 'オーシャンダーク', class: 'theme-dark-ocean', mode: 'dark', palette: ['#0b1d2a', '#38bdf8', '#e6f2fa'] },
  { id: 'dark-plum', name: 'プラムダーク', class: 'theme-dark-plum', mode: 'dark', palette: ['#1a1226', '#c084fc', '#f2e9fb'] },
  { id: 'dark-sunset', name: 'サンセットダーク', class: 'theme-dark-sunset', mode: 'dark', palette: ['#20131a', '#fb923c', '#fbe9ec'] },
  { id: 'dark-charcoal', name: 'チャコールダーク', class: 'theme-dark-charcoal', mode: 'dark', palette: ['#17191c', '#e2e8f0', '#e5e7eb'] },
  { id: 'high-contrast-dark', name: 'ハイコントラスト（暗）', class: 'theme-high-contrast-dark', mode: 'dark', palette: ['#000000', '#fbbf24', '#ffffff'] },
  // 後方互換: 旧設定に保存されたテーマ
  { id: 'navy', name: '標準ネイビー（旧）', class: 'theme-navy', mode: 'dark', palette: ['#0f172a', '#6366f1', '#f8fafc'] },
  { id: 'dark', name: 'ダークモード（旧）', class: 'theme-dark', mode: 'dark', palette: ['#111318', '#38bdf8', '#e9edf3'] },
  { id: 'warm', name: 'ウォームウッド（旧）', class: 'theme-warm', mode: 'dark', palette: ['#1b1f26', '#a78bfa', '#e9edf3'] },
  { id: 'high-contrast', name: 'ハイコントラスト（旧）', class: 'theme-high-contrast', palette: ['#000000', '#fbbf24', '#ffffff'], mode: 'dark' }
];

// テーマクラスの一覧（applyTheme で全消去する）
const ALL_THEME_CLASSES = [...new Set(SUPPORTED_THEMES.map(t => t.class))];

/**
 * テーマの適用
 * @param {string} themeId
 */
export function applyTheme(themeId) {
  const htmlEl = document.documentElement;

  // 既存のテーマクラスを消去
  ALL_THEME_CLASSES.forEach(c => htmlEl.classList.remove(c));

  const selectedTheme = SUPPORTED_THEMES.find(t => t.id === themeId)
    || SUPPORTED_THEMES.find(t => t.id === APP_CONFIG.defaultTheme)
    || SUPPORTED_THEMES[0];
  htmlEl.classList.add(selectedTheme.class);

  // CSS の視認性・コントラスト調整レイヤーがライト/ダークで分岐するためのフック
  htmlEl.dataset.themeMode = selectedTheme.mode || 'light';

  // ステートおよびLocalStorageへの保存
  setThemeState(selectedTheme.id);

  // 選択状態の表示を更新
  updateThemeSelection(selectedTheme.id);
}

/**
 * テーマモーダル内のボタン選択状態を描画
 */
function updateThemeSelection(activeId) {
  document.querySelectorAll('.theme-select-btn').forEach(btn => {
    const active = btn.getAttribute('data-theme-set') === activeId;
    btn.classList.toggle('border-accent', active);
    btn.classList.toggle('ring-accent', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

/**
 * テーマ選択グリッドを動的生成
 */
function renderThemeOptions() {
  const grid = document.getElementById('theme-modal-grid');
  if (!grid) return;

  grid.innerHTML = '';
  SUPPORTED_THEMES.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-select-btn flex flex-col items-center gap-2 p-2 rounded-xl bg-card border border-main hover-surface transition-colors';
    btn.setAttribute('data-theme-set', t.id);
    btn.innerHTML = `
      <div class="theme-swatch w-full h-10 rounded-lg border border-main"
           style="background-image: linear-gradient(135deg, ${t.palette[0]} 0 45%, ${t.palette[1]} 45% 62%, ${t.palette[2]} 62% 100%);"></div>
      <div class="text-soft text-xs font-medium text-center leading-tight">${t.name}</div>
    `;
    grid.appendChild(btn);
  });

  updateThemeSelection(state.currentTheme);
}

/**
 * テーマ切り替えUIモーダルの初期化
 */
export function initThemeManager() {
  // 初期テーマの適用
  applyTheme(state.currentTheme);

  const grid = document.getElementById('theme-modal-grid');

  // 共通クリックハンドラ（1回だけ登録）
  if (grid) {
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.theme-select-btn');
      if (!btn) return;
      const themeId = btn.getAttribute('data-theme-set');
      applyTheme(themeId);
      closeModal('theme-modal');

      const themeInfo = SUPPORTED_THEMES.find(t => t.id === themeId);
      showToast(`テーマを「${themeInfo ? themeInfo.name : themeId}」に切り替えました`, 'success');
    });
  }

  /* テーマ設定はアカウント名ドロップダウン内の項目から開く */
  const themeBtn = document.getElementById('menu-theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const dropdown = document.getElementById('user-dropdown-menu');
      if (dropdown) dropdown.classList.add('hidden');
      renderThemeOptions();
      openModal('theme-modal');
    });
  }
}
