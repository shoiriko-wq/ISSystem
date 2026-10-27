/**
 * ISSystem Theme Switching & Management
 */

import { APP_CONFIG } from './config.js';
import { state, setThemeState } from './state.js';
import { openModal, closeModal, showToast } from './ui-helpers.js';

// 対応テーマ一覧（CSS クラスは variables.css の html.theme-* と一致させる）
// mode   : CSS のコントラスト/視認性調整レイヤー (readability.css) がライト/ダークで分岐するための判定
// chrome : "saturated" は二色テーマ（内容色＝白系、バー＝原色）。variables.css の data-chrome フックが白いバー用インクを適用
// hidden : 旧設定（localStorage）との互換エイリアス。テーマ選択UIには表示しない
export const SUPPORTED_THEMES = [
  // ---------- ライト（7） ----------
  { id: 'light-standard', name: 'ライト標準', class: 'theme-light-standard', mode: 'light', palette: ['#f4f6fa', '#4f46e5', '#1e293b'] },
  { id: 'light-paper', name: 'ペーパー（明・高コントラスト）', class: 'theme-light-paper', mode: 'light', palette: ['#f1f2f4', '#1d4ed8', '#0b0b0f'] },
  { id: 'light-sepia', name: 'セピア', class: 'theme-light-sepia', mode: 'light', palette: ['#f7f2e9', '#b45309', '#3b3126'] },
  { id: 'pop-azure', name: 'ポップ：アジュール', class: 'theme-pop-azure', mode: 'light', chrome: 'saturated', palette: ['#0284c7', '#ffffff', '#123a52'] },
  { id: 'pop-forest', name: 'ポップ：エメラルド', class: 'theme-pop-forest', mode: 'light', chrome: 'saturated', palette: ['#15803d', '#ffffff', '#1e3126'] },
  { id: 'pop-crimson', name: 'ポップ：クリムゾン', class: 'theme-pop-crimson', mode: 'light', chrome: 'saturated', palette: ['#b91c1c', '#ffffff', '#3b1621'] },
  { id: 'pop-sunset', name: 'ポップ：サンセット', class: 'theme-pop-sunset', mode: 'light', chrome: 'saturated', palette: ['#1f2937', '#ea580c', '#ffffff'] },
  // ---------- ダーク（4） ----------
  { id: 'dark-navy', name: 'ダークネイビー', class: 'theme-dark-navy', mode: 'dark', palette: ['#0f172a', '#6366f1', '#f8fafc'] },
  { id: 'dark-midnight', name: 'ミッドナイトブラック', class: 'theme-dark-midnight', mode: 'dark', palette: ['#0b1120', '#818cf8', '#e8eefc'] },
  { id: 'dark-plum', name: 'プラムダーク', class: 'theme-dark-plum', mode: 'dark', palette: ['#1a1226', '#c084fc', '#f2e9fb'] },
  { id: 'high-contrast-dark', name: 'ハイコントラスト（暗）', class: 'theme-high-contrast-dark', mode: 'dark', palette: ['#000000', '#fbbf24', '#ffffff'] },
  // ---------- 後方互換エイリアス（旧テーマ設定はそのまま新しいテーマへ対応） ----------
  { id: 'light-sky', name: 'スカイライト（旧）', class: 'theme-pop-azure', mode: 'light', chrome: 'saturated', hidden: true, palette: [] },
  { id: 'light-forest', name: 'フォレストライト（旧）', class: 'theme-pop-forest', mode: 'light', chrome: 'saturated', hidden: true, palette: [] },
  { id: 'light-sakura', name: 'サクラライト（旧）', class: 'theme-pop-crimson', mode: 'light', chrome: 'saturated', hidden: true, palette: [] },
  { id: 'light-candy', name: 'キャンディライト（旧）', class: 'theme-pop-crimson', mode: 'light', chrome: 'saturated', hidden: true, palette: [] },
  { id: 'light-mint', name: 'ミントライト（旧）', class: 'theme-pop-forest', mode: 'light', chrome: 'saturated', hidden: true, palette: [] },
  { id: 'dark-sunset', name: 'サンセットダーク（旧）', class: 'theme-dark-plum', mode: 'dark', hidden: true, palette: [] },
  { id: 'dark-charcoal', name: 'チャコールダーク（旧）', class: 'theme-dark-midnight', mode: 'dark', hidden: true, palette: [] },
  { id: 'navy', name: '標準ネイビー（旧）', class: 'theme-dark-navy', mode: 'dark', hidden: true, palette: [] },
  { id: 'dark', name: 'ダークモード（旧）', class: 'theme-dark-midnight', mode: 'dark', hidden: true, palette: [] },
  { id: 'warm', name: 'ウォームウッド（旧）', class: 'theme-light-sepia', mode: 'light', hidden: true, palette: [] },
  { id: 'high-contrast', name: 'ハイコントラスト（旧）', class: 'theme-high-contrast-dark', mode: 'dark', hidden: true, palette: [] }
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
    || SUPPORTED_THEMES.find(t => t.id === APP_CONFIG.DEFAULT_THEME)
    || SUPPORTED_THEMES[0];

  htmlEl.classList.add(selectedTheme.class);

  // CSS の視認性・コントラスト調整レイヤーがライト/ダークで分岐するためのフック
  htmlEl.dataset.themeMode = selectedTheme.mode || 'light';
  // 二色テーマ（ポップ）でバー用のインクを適用するためのフック
  htmlEl.dataset.chrome = selectedTheme.chrome || 'light';

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
 * 旧テーマ設定（削除されたテーマID）を新テーマ体系のIDへ変換する
 */
function migrateLegacyTheme() {
  const stored = SUPPORTED_THEMES.find(t => t.id === state.currentTheme);
  if (!stored || !stored.hidden) return;
  const canonical = SUPPORTED_THEMES.find(t => t.class === stored.class && !t.hidden);
  if (canonical) setThemeState(canonical.id);
}

/**
 * テーマ選択グリッドを動的生成（旧テーマのエイリアスは表示しない）
 */
function renderThemeOptions() {
  const grid = document.getElementById('theme-modal-grid');
  if (!grid) return;

  grid.innerHTML = '';
  SUPPORTED_THEMES.filter(t => !t.hidden).forEach(t => {
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
  // 旧テーマ設定は新体系のテーマIDへ変換してから適用する
  migrateLegacyTheme();
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

