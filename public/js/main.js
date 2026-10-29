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
import { initAbsenceModule, loadAbsenceSummary } from './modules/absence.module.js';
import { initExamModule, loadExamData } from './modules/exam.module.js';


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
    case 'exam':
      await loadExamData();
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

    // 定期考査メニューはログイン時のみ表示（編集権限はモジュール内でロール判定）
    const examNav = document.getElementById('nav-exam-item');
    if (examNav) examNav.classList.remove('hidden');

    // 教務/一般権限バッジを現在のロールで再描画し、考査データも最新化する
    initExamModule();
  } else {
    loginScreen?.classList.remove('hidden');
    appContainer?.classList.add('hidden');

    // 未ログイン時は定期考査メニューを非表示化
    const examNav = document.getElementById('nav-exam-item');
    if (examNav) examNav.classList.add('hidden');

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
 * 発行された招待コードを職員一覧モーダル内に表示する
 * 招待コードは新規登録・パスワード再設定のどちらでも利用される共通の許可証
 */
function displayInvitationCode(code, expiresAt) {
  const display = document.getElementById('invitation-code-display');
  const copyBtn = document.getElementById('copy-invitation-btn');
  const expiryEl = document.getElementById('invitation-expiry');

  if (display) {
    display.textContent = code;
    display.classList.remove('hidden');
  }
  if (copyBtn) copyBtn.classList.remove('hidden');

  if (expiryEl) {
    const exp = expiresAt ? new Date(expiresAt) : null;
    const expiryText = exp && !Number.isNaN(exp.getTime()) ? exp.toLocaleString('ja-JP') : '24時間以内';
    expiryEl.textContent = `有効期限: ${expiryText} / コードは1回のみ使用可`;
    expiryEl.classList.remove('hidden');
  }
  refreshLucideIcons();
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
      // renderAuthScreen 内でメニュー可視性・権限バッジの再描画を行う
      renderAuthScreen();
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

  // ログイン画面のタブ切り替え (3タブ: ログイン / 新規登録 / パスワード再設定)
  const tabLoginBtn = document.getElementById('tab-login-btn');
  const tabRegisterBtn = document.getElementById('tab-register-btn');
  const tabResetBtn = document.getElementById('tab-reset-btn');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const resetForm = document.getElementById('reset-form');

  const TAB_ACTIVE_CLASS = 'flex-1 pb-2 text-accent border-b-2 border-accent transition-colors';
  const TAB_IDLE_CLASS = 'flex-1 pb-2 text-muted border-b-2 border-transparent hover-text-main transition-colors';

  // ユーザー自身が「新規登録」か「パスワード忘れ」かをログイン画面で選択する
  const loginTabs = [
    { key: 'login', btn: tabLoginBtn, form: loginForm },
    { key: 'register', btn: tabRegisterBtn, form: registerForm },
    { key: 'reset', btn: tabResetBtn, form: resetForm },
  ].filter((t) => t.btn && t.form);

  const selectLoginTab = (activeKey) => {
    loginTabs.forEach(({ key, btn, form }) => {
      btn.className = key === activeKey ? TAB_ACTIVE_CLASS : TAB_IDLE_CLASS;
      form.classList.toggle('hidden', key !== activeKey);
    });
    // 他タブのエラー表示をクリア
    document.getElementById('login-error')?.classList.add('hidden');
    document.getElementById('register-error')?.classList.add('hidden');
    document.getElementById('reset-error')?.classList.add('hidden');
  };

  loginTabs.forEach(({ key, btn }) => btn.addEventListener('click', () => selectLoginTab(key)));

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

  // 招待コードによるパスワード再設定フォーム送信 (パスワード忘れた方向け)
  resetForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('reset-error');
    try {
      errorEl?.classList.add('hidden');
      const invitationCode = document.getElementById('reset-invitation-code').value.trim();
      const staff_code = document.getElementById('reset-staffcode').value.trim();
      const newPassword = document.getElementById('reset-password').value.trim();
      const confirmPassword = document.getElementById('reset-password-confirm').value.trim();

      if (!invitationCode || !staff_code) {
        throw new Error('招待コードと教職員番号を入力してください。');
      }
      if (newPassword.length < 8) {
        throw new Error('新しいパスワードは8文字以上で入力してください。');
      }
      if (newPassword !== confirmPassword) {
        throw new Error('新しいパスワードが確認用入力と一致しません。');
      }

      const res = await apiPost('/auth/reset-password-invitation', {
        invitationCode,
        staff_code,
        newPassword
      });

      if (res && res.success && res.token) {
        setUserSession(res.user, res.token);
        renderAuthScreen();
        resetForm.reset();
        showToast('パスワードを再設定し、ログインしました', 'success');
        switchTab(state.currentTab || 'dashboard');
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'パスワードの再設定に失敗しました。招待コードをご確認ください。';
        errorEl.classList.remove('hidden');
      }
    }
  });

  // 招待コード発行ボタン (新規登録・パスワード再設定で共用される共通コード)
  document.getElementById('generate-invitation-btn')?.addEventListener('click', async () => {
    try {
      const res = await apiPost('/auth/generate-invitation', {});
      const code = res.code || res.invitation?.code;
      if (res && res.success && code) {
        displayInvitationCode(code, res.expiresAt || res.invitation?.expiresAt);
        showToast(`招待コード ${code} を発行しました`, 'success');
      } else {
        showToast('招待コードの発行に失敗しました（サーバーがコードを返していません）', 'error');
      }
    } catch (err) {
      showToast('招待コードの発行に失敗しました: ' + err.message, 'error');
    }
  });

  // 発行済み招待コードのコピー
  document.getElementById('copy-invitation-btn')?.addEventListener('click', async () => {
    const code = document.getElementById('invitation-code-display')?.textContent.trim();
    if (!code || code === '--') return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const temp = document.createElement('textarea');
        temp.value = code;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
      }
      showToast(`招待コード ${code} をコピーしました`, 'success');
    } catch (err) {
      showToast('コピーに失敗しました: ' + err.message, 'error');
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
    avatarContainer.classList.add('ring-4', 'ring-accent');
  });

  avatarContainer?.addEventListener('dragleave', () => {
    avatarContainer.classList.remove('ring-4', 'ring-accent');
  });

  avatarContainer?.addEventListener('drop', (e) => {
    e.preventDefault();
    avatarContainer.classList.remove('ring-4', 'ring-accent');
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
    // パスワード変更欄はモーダルを開くたびに空へリセットする
    ['profile-current-password', 'profile-new-password', 'profile-new-password-confirm'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const pwErrEl = document.getElementById('pw-change-error');
    if (pwErrEl) {
      pwErrEl.textContent = '';
      pwErrEl.classList.add('hidden');
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
        // パスワード欄はプロフィール保存とは無関係なので、保存後に空へ戻す（取り違い防止）
        ['profile-current-password', 'profile-new-password', 'profile-new-password-confirm'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        const pwErrEl = document.getElementById('pw-change-error');
        if (pwErrEl) {
          pwErrEl.textContent = '';
          pwErrEl.classList.add('hidden');
        }
        closeModal('profile-modal');
        renderAuthScreen();
      }
    } catch (err) {
      showToast('プロフィールの更新に失敗しました: ' + err.message, 'error');
    }
  });

  // フッターの「保存する」は form 属性で profile-form を送信する（form 属性非対応環境は JS で補完）
  const profileForm = document.getElementById('profile-form');
  const profileSaveBtn = document.querySelector('#profile-modal .modal-footer button[type="submit"]');
  if (profileForm && profileSaveBtn && !('form' in HTMLButtonElement.prototype)) {
    profileSaveBtn.addEventListener('click', () => profileForm.requestSubmit());
  }

  // パスワード変更（現在の / 新しい / 確認 → PUT /api/auth/change-password）
  const pwChangeBtn = document.getElementById('profile-password-change-btn');
  const pwFieldIds = ['profile-current-password', 'profile-new-password', 'profile-new-password-confirm'];

  const setPwError = (msg) => {
    const errEl = document.getElementById('pw-change-error');
    if (!errEl) return;
    if (msg) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }
  };

  pwChangeBtn?.addEventListener('click', async () => {
    const currentPw = document.getElementById('profile-current-password')?.value || '';
    const newPw = document.getElementById('profile-new-password')?.value || '';
    const confirmPw = document.getElementById('profile-new-password-confirm')?.value || '';

    setPwError('');

    if (!currentPw) {
      setPwError('現在のパスワードを入力してください。');
      return;
    }
    if (newPw.length < 8) {
      setPwError('新しいパスワードは8文字以上で入力してください。');
      return;
    }
    if (newPw === currentPw) {
      setPwError('新しいパスワードは現在のパスワードと別のものにしてください。');
      return;
    }
    if (newPw !== confirmPw) {
      setPwError('新しいパスワードと確認入力が一致しません。');
      return;
    }

    pwChangeBtn.disabled = true;
    try {
      const res = await apiPut('/auth/change-password', { currentPassword: currentPw, newPassword: newPw });
      if (res && res.success) {
        pwFieldIds.forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        showToast('パスワードを変更しました', 'success');
      }
    } catch (err) {
      setPwError(err.message || 'パスワードの変更に失敗しました。');
    } finally {
      pwChangeBtn.disabled = false;
    }
  });

  // 3つのパスワード欄で Enter を押すとフォーム送信ではなくパスワード変更を実行する
  pwFieldIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        pwChangeBtn?.click();
      }
    });
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
  tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-muted">読み込み中...</td></tr>`;
  try {
    const data = await apiGet('/users');
    const users = data.users || [];
    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-muted">登録されている教職員はいません。</td></tr>`;
      return;
    }
    tbody.innerHTML = users.map(u => `
      <tr class="hover-surface transition-colors">
        <td class="p-3 font-bold text-main flex items-center gap-2">
          <div class="w-6 h-6 rounded-full bg-accent-soft border border-accent flex items-center justify-center text-accent-strong font-bold overflow-hidden text-xs shrink-0">
            ${u.avatar_url ? `<img src="${u.avatar_url}" class="w-full h-full object-cover">` : `<i data-lucide="user" class="w-3.5 h-3.5"></i>`}
          </div>
          <div>
            <div>${escapeHTML(u.name || '(氏名未設定)')}</div>
            <div class="text-[10px] text-muted font-mono">${escapeHTML(u.staff_code)}</div>
          </div>
        </td>
        <td class="p-3 text-soft">${escapeHTML(u.department || '未設定')}</td>
        <td class="p-3 text-muted font-mono">${escapeHTML(u.extension_number || '-')}</td>
        <td class="p-3 text-right whitespace-nowrap">
          <button class="btn-secondary py-1 px-2 text-[11px] rounded border border-main bg-surface text-main flex items-center gap-1 inline-flex invite-code-btn mr-2" data-staff-code="${escapeHTML(u.staff_code)}" data-user-label="${escapeHTML(u.name || u.staff_code)}">
            <i data-lucide="key" class="w-3 h-3"></i> 再設定コード
          </button>
          <button class="btn-danger py-1 px-2 text-[11px] bg-danger-soft text-danger-strong border border-danger-soft rounded hover-danger-soft delete-user-btn" data-user-id="${u.id}">
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
    // 職員ごとの「パスワード再設定用招待コード」発行 (新規登録用と同じ手続き)
    tbody.querySelectorAll('.invite-code-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const staffCode = btn.getAttribute('data-staff-code');
        const label = btn.getAttribute('data-user-label') || staffCode;
        try {
          const res = await apiPost('/auth/generate-invitation', {});
          const code = res.code || res.invitation?.code;
          if (res && res.success && code) {
            displayInvitationCode(code, res.expiresAt || res.invitation?.expiresAt);
            showToast(`${label} さん用の招待コード: ${code}`, 'success');
          } else {
            showToast('招待コードの発行に失敗しました', 'error');
          }
        } catch (err) {
          showToast('招待コードの発行に失敗しました: ' + err.message, 'error');
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-6 text-danger">教職員一覧の取得に失敗しました。</td></tr>`;
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
  initAbsenceModule();
  // 定期考査モジュールは renderAuthScreen (ログイン時のロール判定込み) で初期化される


  // 4. 初期画面の描画
  renderAuthScreen();

  // 5. 有効なセッション（ログイン保持）が存在する場合のみ実データをロード
  if (state.currentUser && state.authToken) {
    switchTab(state.currentTab || 'dashboard');
  }

  refreshLucideIcons();
});