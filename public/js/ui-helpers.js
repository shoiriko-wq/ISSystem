/**
 * ISSystem Common UI Helpers & Utilities
 */

import { APP_CONFIG } from './config.js';

/**
 * Lucide アイコンの再描画 (動的HTML生成後に呼び出し)
 */
export function refreshLucideIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

/**
 * トースト通知メッセージの表示
 * @param {string} message 
 * @param {'info'|'success'|'warning'|'error'} [type='info'] 
 */
export function showToast(message, type = 'info', onClick = null) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  // 通知履歴へ自動追加
  addNotification(message, type, onClick);

  const toast = document.createElement('div');
  
  const iconMap = {
    info: 'info',
    success: 'check-circle-2',
    warning: 'alert-triangle',
    error: 'alert-circle'
  };

  const colorMap = {
    info: 'border-accent text-accent-strong',
    success: 'border-success text-success-strong',
    warning: 'border-warning text-warning-strong',
    error: 'border-danger text-danger-strong'
  };

  toast.className = `toast ${colorMap[type] || colorMap.info} cursor-pointer hover-surface transition-all flex items-center justify-between gap-2`;
  toast.innerHTML = `
    <div class="flex items-center gap-2 overflow-hidden">
      <i data-lucide="${iconMap[type] || 'info'}" class="w-4 h-4 flex-shrink-0"></i>
      <span class="truncate">${escapeHTML(message)}</span>
    </div>
    <i data-lucide="chevron-right" class="w-3.5 h-3.5 text-muted opacity-60 flex-shrink-0"></i>
  `;

  if (typeof onClick === 'function') {
    toast.addEventListener('click', () => {
      onClick();
      toast.remove();
    });
  }

  container.appendChild(toast);
  refreshLucideIcons();

  let timeoutId = setTimeout(() => {
    fadeOutAndRemove();
  }, 5000);

  function fadeOutAndRemove() {
    toast.style.opacity = '0';
    toast.style.transform = 'scale(0.95)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }

  toast.addEventListener('mouseenter', () => clearTimeout(timeoutId));
  toast.addEventListener('mouseleave', () => {
    timeoutId = setTimeout(() => fadeOutAndRemove(), 2500);
  });
}

// -------------------------------------------------------------
// 通知履歴 & ハイライト機能
// -------------------------------------------------------------

let notificationHistory = [];
let unreadNotificationCount = 0;

/**
 * 該当要素をスムーズスクロールして一時的にハイライト発光させる
 * @param {HTMLElement|string} elementOrSelector 
 */
export function highlightElement(elementOrSelector) {
  const el = typeof elementOrSelector === 'string' ? document.querySelector(elementOrSelector) : elementOrSelector;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('ring-2', 'ring-accent', 'bg-accent-soft', 'transition-all', 'duration-500');
  setTimeout(() => {
    el.classList.remove('ring-2', 'ring-accent', 'bg-accent-soft');
  }, 3000);
}

/**
 * 通知履歴への追加
 */
export function addNotification(message, type = 'info', onClick = null) {
  const item = {
    id: 'notif_' + Math.random().toString(36).substring(2, 9),
    message,
    type,
    time: new Date(),
    read: false,
    onClick
  };
  notificationHistory.unshift(item);
  if (notificationHistory.length > 30) notificationHistory.pop();
  unreadNotificationCount++;
  updateNotificationUI();
}

/**
 * 通知履歴UIの更新
 */
export function updateNotificationUI() {
  const badge = document.getElementById('notification-badge');
  if (badge) {
    if (unreadNotificationCount > 0) {
      badge.textContent = unreadNotificationCount > 99 ? '99+' : unreadNotificationCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  const listEl = document.getElementById('notification-list');
  if (!listEl) return;

  if (notificationHistory.length === 0) {
    listEl.innerHTML = `<div class="px-4 py-6 text-center text-muted text-[11px]">新着の通知はありません</div>`;
    return;
  }

  const iconMap = {
    info: 'info',
    success: 'check-circle-2',
    warning: 'alert-triangle',
    error: 'alert-circle'
  };

  listEl.innerHTML = notificationHistory.map(n => {
    const timeStr = new Date(n.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const unreadDot = !n.read ? '<span class="w-2 h-2 rounded-full bg-accent inline-block flex-shrink-0"></span>' : '<span class="w-2 h-2 inline-block flex-shrink-0"></span>';
    return `
      <div class="notification-item px-3 py-2.5 hover-surface cursor-pointer transition-colors flex items-start gap-2.5 text-soft" data-id="${n.id}">
        <div class="mt-0.5 text-accent flex-shrink-0">
          <i data-lucide="${iconMap[n.type] || 'info'}" class="w-3.5 h-3.5"></i>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[11px] text-main leading-snug truncate">${escapeHTML(n.message)}</p>
          <span class="text-[9px] text-muted font-mono">${timeStr}</span>
        </div>
        <div class="flex items-center self-center">${unreadDot}</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.notification-item').forEach(el => {
    const id = el.getAttribute('data-id');
    el.addEventListener('click', () => {
      const target = notificationHistory.find(n => n.id === id);
      if (target) {
        target.read = true;
        unreadNotificationCount = notificationHistory.filter(n => !n.read).length;
        updateNotificationUI();
        if (typeof target.onClick === 'function') {
          target.onClick();
        }
        const dropdown = document.getElementById('notification-dropdown-menu');
        if (dropdown) dropdown.classList.add('hidden');
      }
    });
  });

  refreshLucideIcons();
}

/**
 * 通知センターの初期化 (ベルアイコンクリックおよびドロップダウン制御)
 */
export function initNotificationCenter() {
  const notifBtn = document.getElementById('notification-btn');
  const notifMenu = document.getElementById('notification-dropdown-menu');
  const clearAllBtn = document.getElementById('notification-clear-all');

  if (notifBtn && notifMenu) {
    notifBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      notifMenu.classList.toggle('hidden');
      updateNotificationUI();
    });

    document.addEventListener('click', (e) => {
      if (!notifBtn.contains(e.target) && !notifMenu.contains(e.target)) {
        notifMenu.classList.add('hidden');
      }
    });
  }

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      notificationHistory.forEach(n => n.read = true);
      unreadNotificationCount = 0;
      updateNotificationUI();
      showToast('すべての通知を既読にしました', 'info');
    });
  }

  updateNotificationUI();
}

/**
 * モーダルを開く
 * @param {string} modalId 
 */
export function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    refreshLucideIcons();
  }
}

/**
 * モーダルを閉じる
 * @param {string} modalId 
 */
export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
  }
}

/**
 * 画面上の全モーダルのイベントリスナー一括初期化 (背景クリック閉じる等)
 */
export function initModalListeners() {
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });

    modal.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    });
  });

  /* 動的生成されるモーダル（チャット・施設・スケジュールなど init 後に注入されるもの）
     でも閉じるが効くよう、document レベルの委譲で .modal-close と背景スクリーンを処理する。
     data-lucide の SVG が子要素になるため closest() でボタンを辿る。 */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.modal-close');
    if (btn) {
      const modal = btn.closest('.modal-overlay');
      if (modal) modal.classList.add('hidden');
      return;
    }
    if (e.target.classList && e.target.classList.contains('modal-overlay')) {
      e.target.classList.add('hidden');
    }
  });

  /* ESC キーで最前面の開いているモーダルを閉じる（全モーダル共通ルール） */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openModals = Array.from(document.querySelectorAll('.modal-overlay'))
      .filter(m => !m.classList.contains('hidden'));
    if (openModals.length === 0) return;
    openModals[openModals.length - 1].classList.add('hidden');
  });
}

/**
 * ヘッダーリアルタイム時計の開始
 */
export function startClockWidget() {
  const clockEl = document.getElementById('clock-widget');
  if (!clockEl) return;

  const update = () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${hours}:${minutes}:${seconds}`;
  };

  update();
  setInterval(update, APP_CONFIG.CLOCK_INTERVAL_MS);
}

/**
 * 日付・時刻文字列のフォーマット
 * @param {string|Date} dateVal 
 * @param {boolean} [includeTime=true] 
 * @returns {string} 
 */
export function formatDate(dateVal, includeTime = true) {
  if (!dateVal) return '-';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  
  if (!includeTime) {
    return `${year}/${month}/${date}`;
  }

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${date} ${hours}:${minutes}`;
}

/**
 * XSSサニタイズ用のHTMLエスケープ
 * @param {string} str 
 * @returns {string}
 */
export function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}