/**
 * ISSystem Main Application Entry Point & Router (教職員番号 staff_code 認証基盤 & 全モジュールデータ連動完全版)
 */

import { state, setUserSession, setActiveTabState, subscribeState, setKyomuModeState } from './state.js';
import { startClockWidget, initModalListeners, refreshLucideIcons, showToast, openModal, closeModal, escapeHTML, initNotificationCenter } from './ui-helpers.js';
import { initThemeManager } from './theme.js';
import { apiPost, apiGet, apiPut, apiDelete } from './api.js';
import { socketClient } from './socket.js';

// 各機能モジュールの初期化およびデータロード関数インポート
import { initDashboardModule, loadDashboardData, fetchWeatherData } from './modules/dashboard.module.js';
import { initSeatingModule, loadSeatingData } from './modules/seating.module.js';
import { initBulletinModule, loadBulletins } from './modules/bulletin.module.js';
import { initChatModule, loadMessages } from './modules/chat.module.js';
import { initFacilityModule, loadReservations } from './modules/facility.module.js';
import { initScheduleModule, loadSchedules } from './modules/schedule.module.js';
import { initApprovalModule, loadApprovals } from './modules/approval.module.js';

/**
 * ログイン済みの場合にのみアクティブなタブの実データを取得する関数
 */
export async function loadActiveTabData(tabName = state.currentTab) {
  if (!state.currentUser || !state.authToken) return;

  switch (tabName) {
    case 'dashboard':
      await loadDashboardData();
      await fetchWeatherData();
      break;
    case 'bulletin':
      await loadBulletins();
      break;
    case 'seating':
      await loadSeatingData();
      break;
    case 'chat':
      await loadMessages();
      break;
    case 'facility':
      await loadReservations();
      break;
    case 'schedule':
      await loadSchedules();
      break;
    case 'approval':
      await loadApprovals();
      break;
    default:
      break;
  }
}

/**
 * ビュー切り替えルーティング
 * @param {string} tabName 
 */
export function switchTab(tabName) {
  setActiveTabState(tabName);

  // 全タブビューの非表示化
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.add('hidden');
    view.classList.remove('active');
  });

  // 対象ビューの表示
  const targetView = document.getElementById(`view-${tabName}`);
  if (targetView) {
    targetView.classList.remove('hidden');
    targetView.classList.add('active');
  }

  // サイドバーナビの active 状態更新
  document.querySelectorAll('.app-sidebar .nav-item').forEach(nav => {
    if (nav.getAttribute('data-tab') === tabName) {
      nav.classList.add('active');
    } else {
      nav.classList.remove('active');
    }
  });

  // 認証済みの場合のみ、切り替えたタブの実データを最新取得
  if (state.currentUser && state.authToken) {
    loadActiveTabData(tabName);
  }

  refreshLucideIcons();
}

/**
 * ログイン画面/メイン画面の表示切り替え
 */
function renderAuthScreen() {
  const loginScreen = document.getElementById('login-screen');
  const appContainer = document.getElementById('app-container');
  const userBadge = document.getElementById('current-user-badge');

  if (state.currentUser && state.authToken) {
    loginScreen?.classList.add('hidden');
    appContainer?.classList.remove('hidden');
    
    // ログイン済みの場合、WebSocket リアルタイム接続を開始
    socketClient.init();

    if (userBadge) {
      // データベース仕様書 v2.1.0: 氏名(name) 未設定時は 教職員番号(staff_code) を表示
      const displayName = state.currentUser?.name || state.currentUser?.staff_code || state.currentUser?.id || '教員';
      userBadge.textContent = displayName;
    }
    const dashUserEl = document.getElementById('dash-user-name');
    if (dashUserEl) {
      const displayName = state.currentUser?.name || state.currentUser?.staff_code || state.currentUser?.id || '教員';
      dashUserEl.textContent = `${displayName} 先生`;
    }
    const userAvatar = document.getElementById('header-user-avatar');
    if (userAvatar) {
      if (state.currentUser?.avatar_url) {
        userAvatar.innerHTML = `<img src="${state.currentUser.avatar_url}" class="w-full h-full object-cover" alt="Avatar">`;
      } else {
        userAvatar.innerHTML = `<i data-lucide="user" class="w-3.5 h-3.5"></i>`;
      }
      refreshLucideIcons();
    }
  } else {
    loginScreen?.classList.remove('hidden');
    appContainer?.classList.add('hidden');

    // 未ログイン時は安全に WebSocket 切断
    socketClient.disconnect();
  }
}

/**
 * ログインハンドラー
 */
window.handleLoginClick = async function() {
  const idInput = document.getElementById('login-userid');
  const passInput = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');

  if (!idInput) return;

  try {
    errorEl?.classList.add('hidden');
    const staffCodeInput = idInput.value.trim();
    const pass = (passInput ? passInput.value.trim() : '') || 'password123';

    if (!staffCodeInput) {
      if (errorEl) {
        errorEl.textContent = '教職員番号を入力してください。';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    // 仕様 v2.1.0 に合わせ、staff_code を主要キーとして送信（過去互換キー含む）
    const resData = await apiPost('/auth/login', {
      staff_code: staffCodeInput,
      username: staffCodeInput,
      userId: staffCodeInput,
      password: pass
    });

    // トークンとユーザー情報の保存
    setUserSession(resData.user, resData.token);
    renderAuthScreen();
    
    // ログイン成功後にアクティブタブの実データをロード
    switchTab(state.currentTab || 'dashboard');

    const welcomeName = resData.user?.name ? `${resData.user.name} 先生` : `教職員番号: ${resData.user?.staff_code || staffCodeInput}`;
    showToast(`ログインしました: ${welcomeName}`, 'success');

  } catch (err) {
    console.error('[Auth Error]', err);
    if (errorEl) {
      errorEl.textContent = err.message || 'ログイン処理に失敗しました。教職員番号またはパスワードをご確認ください。';
      errorEl.classList.remove('hidden');
    }
  }
};

/**
 * ログアウトハンドラー
 */
function handleLogout() {
  setUserSession(null, null);
  renderAuthScreen();
  showToast('ログアウトしました', 'info');
}

/**
 * イベントリスナーおよびステートバインディング初期化
 */
function initEventsAndListeners() {
  // ログアウトボタン
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

  // サイドバータブ切り替え
  document.querySelectorAll('.app-sidebar [data-tab]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = btn.getAttribute('data-tab');
      if (tab) switchTab(tab);
    });
  });

  // ステート変化時のUI追従
  subscribeState((currState, key) => {
    if (key === 'currentUser') {
      renderAuthScreen();
      
      const examNav = document.getElementById('nav-exam-item');
      if (examNav) {
        // 定期考査メニューは全教員が閲覧可能（編集権限は内部でロール判定）
        examNav.classList.remove('hidden');
      }
    }

    if (key === 'unreadCounts') {
      const bBadge = document.getElementById('bulletin-unread-count');
      const cBadge = document.getElementById('chat-unread-count');
      
      if (bBadge) {
        bBadge.textContent = currState.unreadCounts.bulletin;
        bBadge.classList.toggle('hidden', currState.unreadCounts.bulletin === 0);
      }
      if (cBadge) {
        cBadge.textContent = currState.unreadCounts.chat;
        cBadge.classList.toggle('hidden', currState.unreadCounts.chat === 0);
      }
    }
  });

  // ユーザーメニュー・ドロップダウン開閉
  const userMenuBtn = document.getElementById('user-menu-btn');
  const userDropdownMenu = document.getElementById('user-dropdown-menu');
  if (userMenuBtn && userDropdownMenu) {
    userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdownMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => {
      userDropdownMenu.classList.add('hidden');
    });
  }

  // ログイン画面のタブ切り替え
  const tabLoginBtn = document.getElementById('tab-login-btn');
  const tabRegisterBtn = document.getElementById('tab-register-btn');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  if (tabLoginBtn && tabRegisterBtn && loginForm && registerForm) {
    tabLoginBtn.addEventListener('click', () => {
      tabLoginBtn.className = 'flex-1 pb-2 text-indigo-400 border-b-2 border-indigo-500 transition-colors';
      tabRegisterBtn.className = 'flex-1 pb-2 text-slate-400 border-b-2 border-transparent hover:text-slate-200 transition-colors';
      loginForm.classList.remove('hidden');
      registerForm.classList.add('hidden');
    });
    tabRegisterBtn.addEventListener('click', () => {
      tabRegisterBtn.className = 'flex-1 pb-2 text-indigo-400 border-b-2 border-indigo-500 transition-colors';
      tabLoginBtn.className = 'flex-1 pb-2 text-slate-400 border-b-2 border-transparent hover:text-slate-200 transition-colors';
      registerForm.classList.remove('hidden');
      loginForm.classList.add('hidden');
    });
  }

  // 招待コードでの新規登録フォーム送信
  registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('register-error');
    try {
      errorEl?.classList.add('hidden');
      const invitationCode = document.getElementById('reg-invitation-code').value.trim();
      const staff_code = document.getElementById('reg-staffcode').value.trim();
      const name = document.getElementById('reg-name').value.trim();
      const password = document.getElementById('reg-password').value.trim();
      const department = document.getElementById('reg-department').value;

      const res = await apiPost('/auth/register-invitation', {
        invitationCode,
        staff_code,
        name,
        password,
        department
      });

      if (res && res.success && res.token) {
        setUserSession(res.user, res.token);
        renderAuthScreen();
        showToast('新規アカウント登録が完了しました', 'success');
        switchTab('dashboard');
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || '登録に失敗しました。招待コードをご確認ください。';
        errorEl.classList.remove('hidden');
      }
    }
  });

  // 招待コード発行ボタン
  document.getElementById('generate-invitation-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiPost('/auth/generate-invitation', {});
      if (res && res.success && res.code) {
        const display = document.getElementById('invitation-code-display');
        if (display) {
          display.textContent = res.code;
          display.classList.remove('hidden');
        }
        showToast('招待コードを発行しました（有効期限付き）', 'success');
      }
    } catch (err) {
      showToast('招待コードの発行に失敗しました: ' + err.message, 'error');
    }
  });

  // 画像アップロード & Canvas簡易編集ロジック
  let currentImage = null;
  let imgRotation = 0;
  let imgScale = 1;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  const fileInput = document.getElementById('avatar-file-input');
  const canvas = document.getElementById('avatar-canvas');
  const editorTools = document.getElementById('avatar-editor-tools');
  const previewImg = document.getElementById('profile-avatar-img');
  const placeholderIcon = document.getElementById('profile-avatar-placeholder');
  const hiddenUrlInput = document.getElementById('profile-avatar-url');
  const avatarContainer = document.getElementById('profile-avatar-container');
  const deleteBtn = document.getElementById('avatar-delete-btn');

  const scaleSlider = document.getElementById('avatar-scale-slider');
  const rotateSlider = document.getElementById('avatar-rotate-slider');
  const scaleVal = document.getElementById('scale-val');
  const rotateVal = document.getElementById('rotate-val');
  const rotate90Btn = document.getElementById('avatar-rotate-90-btn');
  const resetBtn = document.getElementById('avatar-reset-btn');

  function resetImageParams() {
    imgRotation = 0;
    imgScale = 1;
    panX = 0;
    panY = 0;
    if (scaleSlider) scaleSlider.value = 1;
    if (rotateSlider) rotateSlider.value = 0;
    if (scaleVal) scaleVal.textContent = '1.00x';
    if (rotateVal) rotateVal.textContent = '0°';
    drawImageToCanvas();
  }

  function loadAvatarFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('画像ファイル（PNG, JPEGなど）を選択してください', 'warning');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        currentImage = img;
        resetImageParams();
        editorTools?.classList.remove('hidden');
        refreshLucideIcons();
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  }

  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadAvatarFile(file);
  });

  // ドラッグ＆ドロップ対応
  avatarContainer?.addEventListener('click', () => {
    fileInput?.click();
  });

  avatarContainer?.addEventListener('dragover', (e) => {
    e.preventDefault();
    avatarContainer.classList.add('ring-4', 'ring-indigo-400');
  });

  avatarContainer?.addEventListener('dragleave', () => {
    avatarContainer.classList.remove('ring-4', 'ring-indigo-400');
  });

  avatarContainer?.addEventListener('drop', (e) => {
    e.preventDefault();
    avatarContainer.classList.remove('ring-4', 'ring-indigo-400');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadAvatarFile(file);
  });

  // 画像削除ボタン
  deleteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    currentImage = null;
    if (hiddenUrlInput) hiddenUrlInput.value = '';
    if (fileInput) fileInput.value = '';
    if (previewImg) {
      previewImg.src = '';
      previewImg.classList.add('hidden');
    }
    if (placeholderIcon) {
      placeholderIcon.classList.remove('hidden');
    }
    editorTools?.classList.add('hidden');
    showToast('アイコン画像を削除しました（保存すると確定します）', 'info');
  });

  function drawImageToCanvas() {
    if (!canvas || !currentImage) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    
    // 中心座標を基準に変形
    ctx.translate(canvas.width / 2 + panX, canvas.height / 2 + panY);
    ctx.rotate((imgRotation * Math.PI) / 180);
    ctx.scale(imgScale, imgScale);
    
    // アスペクト比を維持してキャンバス枠全体を覆う基本サイズを算出
    const baseScale = Math.max(canvas.width / currentImage.width, canvas.height / currentImage.height);
    const drawWidth = currentImage.width * baseScale;
    const drawHeight = currentImage.height * baseScale;

    ctx.drawImage(
      currentImage, 
      -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight
    );
    ctx.restore();

    // プレビューと隠しフィールドに切り抜き後の画像を格納
    const dataUrl = canvas.toDataURL('image/png', 0.85);
    if (previewImg && placeholderIcon && hiddenUrlInput) {
      previewImg.src = dataUrl;
      previewImg.classList.remove('hidden');
      placeholderIcon.classList.add('hidden');
      hiddenUrlInput.value = dataUrl;
    }
  }

  // キャンバス直接ドラッグ操作（マウス）
  canvas?.addEventListener('mousedown', (e) => {
    if (!currentImage) return;
    isDragging = true;
    dragStartX = e.clientX - panX;
    dragStartY = e.clientY - panY;
    canvas.classList.remove('cursor-grab');
    canvas.classList.add('cursor-grabbing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panX = e.clientX - dragStartX;
    panY = e.clientY - dragStartY;
    drawImageToCanvas();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      canvas?.classList.remove('cursor-grabbing');
      canvas?.classList.add('cursor-grab');
    }
  });

  // タッチ操作（スマートフォン / タブレット対応）
  canvas?.addEventListener('touchstart', (e) => {
    if (!currentImage || e.touches.length !== 1) return;
    isDragging = true;
    dragStartX = e.touches[0].clientX - panX;
    dragStartY = e.touches[0].clientY - panY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    panX = e.touches[0].clientX - dragStartX;
    panY = e.touches[0].clientY - dragStartY;
    drawImageToCanvas();
  }, { passive: true });

  window.addEventListener('touchend', () => {
    isDragging = false;
  });

  // マウスホイールでの拡大・縮小
  canvas?.addEventListener('wheel', (e) => {
    if (!currentImage) return;
    e.preventDefault();
    const zoomStep = 0.05;
    if (e.deltaY < 0) {
      imgScale = Math.min(3.0, imgScale + zoomStep);
    } else {
      imgScale = Math.max(0.2, imgScale - zoomStep);
    }
    if (scaleSlider) scaleSlider.value = imgScale;
    if (scaleVal) scaleVal.textContent = `${imgScale.toFixed(2)}x`;
    drawImageToCanvas();
  }, { passive: false });

  // 拡大・縮小スライダー
  scaleSlider?.addEventListener('input', (e) => {
    imgScale = parseFloat(e.target.value);
    if (scaleVal) scaleVal.textContent = `${imgScale.toFixed(2)}x`;
    drawImageToCanvas();
  });

  // 連続回転スライダー (無段階 0〜360°)
  rotateSlider?.addEventListener('input', (e) => {
    imgRotation = parseInt(e.target.value, 10);
    if (rotateVal) rotateVal.textContent = `${imgRotation}°`;
    drawImageToCanvas();
  });

  // +90°回転ボタン
  rotate90Btn?.addEventListener('click', () => {
    if (!currentImage) return;
    imgRotation = (imgRotation + 90) % 360;
    if (rotateSlider) rotateSlider.value = imgRotation;
    if (rotateVal) rotateVal.textContent = `${imgRotation}°`;
    drawImageToCanvas();
  });

  // リセットボタン
  resetBtn?.addEventListener('click', () => {
    if (!currentImage) return;
    resetImageParams();
  });

  // プロフィール編集ボタン
  document.getElementById('menu-profile-btn')?.addEventListener('click', () => {
    userDropdownMenu?.classList.add('hidden');
    const user = state.currentUser;
    if (!user) return;
    document.getElementById('profile-name').value = user.name || '';
    document.getElementById('profile-email').value = user.email || '';
    document.getElementById('profile-department').value = user.department || '１学年';
    document.getElementById('profile-extension').value = user.extension_number || '';
    document.getElementById('profile-avatar-url').value = user.avatar_url || '';
    
    editorTools?.classList.add('hidden');
    if (fileInput) fileInput.value = '';
    currentImage = null;

    if (user.avatar_url && previewImg && placeholderIcon) {
      previewImg.src = user.avatar_url;
      previewImg.classList.remove('hidden');
      placeholderIcon.classList.add('hidden');
    } else if (previewImg && placeholderIcon) {
      previewImg.src = '';
      previewImg.classList.add('hidden');
      placeholderIcon.classList.remove('hidden');
    }
    openModal('profile-modal');
    refreshLucideIcons();
  });

  // プロフィール保存フォーム
  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const name = document.getElementById('profile-name').value.trim();
      const email = document.getElementById('profile-email').value.trim();
      const department = document.getElementById('profile-department').value.trim();
      const extension_number = document.getElementById('profile-extension').value.trim();
      const avatar_url = document.getElementById('profile-avatar-url').value.trim();

      const res = await apiPut('/auth/profile', { name, email, department, extension_number, avatar_url });
      if (res && res.success) {
        const updatedUser = res.user || { ...state.currentUser, name, email, department, extension_number, avatar_url };
        setUserSession(updatedUser, res.token || state.authToken);
        closeModal('profile-modal');
        renderAuthScreen();
      }
    } catch (err) {
      showToast('プロフィールの更新に失敗しました: ' + err.message, 'error');
    }
  });

  // 職員一覧・ユーザー管理ボタン
  document.getElementById('menu-users-manage-btn')?.addEventListener('click', () => {
    userDropdownMenu?.classList.add('hidden');
    openModal('users-manage-modal');
    loadUsersList();
  });

  // 新規ユーザー追加フォーム
  document.getElementById('add-user-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const staff_code = document.getElementById('new-user-staffcode').value.trim();
      const name = document.getElementById('new-user-name').value.trim();
      const password = document.getElementById('new-user-password').value.trim();
      const department = document.getElementById('new-user-dept').value.trim();

      const res = await apiPost('/users', { staff_code, name, password, department });
      if (res && res.success) {
        showToast('新規教職員を追加しました', 'success');
        document.getElementById('add-user-form').reset();
        loadUsersList();
      }
    } catch (err) {
      showToast('追加に失敗しました: ' + err.message, 'error');
    }
  });
}

async function loadUsersList() {
  const tbody = document.getElementById('users-manage-tbody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-slate-500">読み込み中...</td></tr>`;
  try {
    const data = await apiGet('/users');
    const users = data.users || [];
    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-slate-500">登録されている教職員はいません。</td></tr>`;
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr class="hover:bg-slate-800/40 transition-colors">
        <td class="p-3 font-bold text-white flex items-center gap-2">
          <div class="w-6 h-6 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center text-indigo-300 font-bold overflow-hidden text-xs shrink-0">
            ${u.avatar_url ? `<img src="${u.avatar_url}" class="w-full h-full object-cover">` : `<i data-lucide="user" class="w-3.5 h-3.5"></i>`}
          </div>
          <div>
            <div>${escapeHTML(u.name || '(氏名未設定)')}</div>
            <div class="text-[10px] text-slate-400 font-mono">${escapeHTML(u.staff_code)}</div>
          </div>
        </td>
        <td class="p-3 text-slate-300">${escapeHTML(u.department || '未設定')}</td>
        <td class="p-3 text-slate-400 font-mono">${escapeHTML(u.extension_number || '-')}</td>
        <td class="p-3 text-right">
          <button class="btn-danger py-1 px-2 text-[11px] bg-red-500/20 text-red-300 border border-red-500/30 rounded hover:bg-red-500/30 delete-user-btn" data-user-id="${u.id}">
            削除
          </button>
        </td>
      </tr>
    `).join('');
    refreshLucideIcons();

    tbody.querySelectorAll('.delete-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const userId = btn.getAttribute('data-user-id');
        if (confirm('本当にこの教職員アカウントを削除しますか？')) {
          try {
            await apiDelete(`/users/${userId}`);
            showToast('教職員を削除しました', 'success');
            loadUsersList();
          } catch (err) {
            showToast('削除に失敗しました: ' + err.message, 'error');
          }
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-red-400">教職員一覧の取得に失敗しました。</td></tr>`;
  }
}

// アプリ起動エントリーポイント
document.addEventListener('DOMContentLoaded', () => {
  // 1. 基礎UIモジュールの起動
  startClockWidget();
  initModalListeners();
  initThemeManager();
  initNotificationCenter();

  // 2. イベントリスナーバインド
  initEventsAndListeners();

  // 3. 各機能UIモジュールの「構造DOM初期化」のみ実行（APIリクエストは発行しない）
  initDashboardModule();
  initSeatingModule();
  initBulletinModule();
  initChatModule();
  initFacilityModule();
  initScheduleModule();
  initApprovalModule();

  // 4. 初期画面の描画
  renderAuthScreen();

  // 5. 有効なセッション（ログイン保持）が存在する場合のみ実データをロード
  if (state.currentUser && state.authToken) {
    switchTab(state.currentTab || 'dashboard');
  }

  refreshLucideIcons();
});