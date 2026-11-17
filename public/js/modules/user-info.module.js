/**
 * ISSystem ユーザ情報編集モジュール (v3.2.0追加5 / 仕様書 §5・§7・§14)
 * 職員一覧・ユーザー管理モーダルの行「情報編集」から管理者 (ADMIN) が
 * 担当教科以外のユーザ情報 (name / email / grade / department / extension_number /
 * is_parttime / role / is_kyomu / subjects) を編集する。
 * 教務部 (KYOMU) はこのフォームを開けない（担当教科ピッカーの行内編集のみ現行維持）。
 * 教職員番号 (ID) とパスワードは編集しない（座席・チャット・考査監督が staff_code を FK 参照）。
 */
import { state } from '../state.js';
import { apiPut } from '../api.js';
import { showToast, refreshLucideIcons } from '../ui-helpers.js';
import { renderSubjectPickerAsync, readSubjectPicker } from './subjects.module.js';

const ROLE_LABELS = { TEACHER: '教員', KYOMU: '教務部', ADMIN: '管理者' };
const isTrue = (v) => v === true || v === 1 || v === '1';

/** 操作者がシステム管理者 (ADMIN) かどうか */
export function isAdminUser() {
  return String(state.currentUser?.role || '').toUpperCase() === 'ADMIN';
}

/** 職員一覧の「種別」セル (role と 教務主任・非常勤) を描画する */
export function userKindCellHtml(u) {
  const role = String(u.role || 'TEACHER').toUpperCase();
  const roleCls = role === 'ADMIN'
    ? 'bg-warning-soft text-warning-strong border-warning-soft'
    : role === 'KYOMU'
      ? 'bg-info-soft text-info-strong border-info-soft'
      : 'bg-surface-soft text-soft border-divider';
  const badges = [`<span class="px-2 py-0.5 rounded border text-[10px] font-bold ${roleCls}">${ROLE_LABELS[role] || role}</span>`];
  if (isTrue(u.is_kyomu)) badges.push('<span class="px-2 py-0.5 rounded border text-[10px] font-bold bg-accent-soft text-accent-strong border-accent-soft">教務主任</span>');
  if (isTrue(u.is_parttime)) badges.push('<span class="px-2 py-0.5 rounded border text-[10px] font-bold bg-surface text-soft border-divider">非常勤</span>');
  return `<div class="flex flex-wrap gap-1">${badges.join('')}</div>`;
}

/** 職員一覧の「学年」セルを描画する */
export function userGradeCellHtml(u) {
  const g = u.grade === null || u.grade === undefined ? '' : String(u.grade);
  if (!g || g === 'NONE') return '<span class="text-muted">-</span>';
  return `<span class="font-bold text-main">${g}</span>`;
}

/** select に存在しない現値（HEAD 等）を落ちないよう option を補って選択する */
function selectWithOption(sel, value) {
  const v = value === null || value === undefined ? '' : String(value);
  if (![...sel.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v === '' ? '未設定' : v;
    sel.appendChild(opt);
  }
  sel.value = v;
}

let editingUserId = null;

/** 編集フォームを非表示にし、対象 id とフォーム値をリセットする */
export function closeUserEditForm() {
  editingUserId = null;
  const card = document.getElementById('user-info-edit-card');
  if (!card) return;
  card.classList.add('hidden');
  document.getElementById('uinfo-target-label').textContent = '--';
  document.getElementById('uinfo-target-code').textContent = '';
  document.getElementById('uinfo-subjects').innerHTML = '';
}

/**
 * 対象ユーザーの現在値で編集フォームを開く（ADMIN のみ。担当教科ピッカー込み）
 * @param {Object} user 職員一覧の行データ
 */
export async function openUserEditForm(user) {
  const card = document.getElementById('user-info-edit-card');
  if (!card || !isAdminUser() || !user) return;

  editingUserId = user.id;
  card.classList.remove('hidden');

  document.getElementById('uinfo-target-label').textContent = user.name || '(氏名未設定)';
  document.getElementById('uinfo-target-code').textContent = user.staff_code || '';
  document.getElementById('uinfo-name').value = user.name || '';
  document.getElementById('uinfo-email').value = user.email || '';
  document.getElementById('uinfo-ext').value = user.extension_number || '';
  document.getElementById('uinfo-department').value = user.department || '';
  selectWithOption(document.getElementById('uinfo-grade'), user.grade ?? 'NONE');
  selectWithOption(document.getElementById('uinfo-role'), user.role || 'TEACHER');
  document.getElementById('uinfo-kyomu').checked = isTrue(user.is_kyomu);
  document.getElementById('uinfo-parttime').checked = isTrue(user.is_parttime);

  // 自分自身の role は変更しない（ADMIN が消滅すると誰も ADMIN 情報を編集できない）
  const self = String(user.id) === String(state.currentUser?.id);
  const roleSel = document.getElementById('uinfo-role');
  roleSel.disabled = self;
  roleSel.title = self ? '自分自身の role は変更できません（ADMIN が消滅するため）' : '';

  await renderSubjectPickerAsync('uinfo-subjects', user.subjects || []);
  refreshLucideIcons();
}

/** 編集フォームを保存して PUT /api/users/:id を送る（ADMIN のみ表示） */
async function saveUserEditForm() {
  if (!editingUserId) return;
  const saveBtn = document.getElementById('uinfo-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const body = {
      name: document.getElementById('uinfo-name').value,
      email: document.getElementById('uinfo-email').value,
      grade: document.getElementById('uinfo-grade').value,
      department: document.getElementById('uinfo-department').value,
      extension_number: document.getElementById('uinfo-ext').value,
      role: document.getElementById('uinfo-role').value,
      is_kyomu: document.getElementById('uinfo-kyomu').checked,
      is_parttime: document.getElementById('uinfo-parttime').checked,
      subjects: readSubjectPicker('uinfo-subjects'),
    };
    const res = await apiPut(`/users/${editingUserId}`, body);
    if (res && res.success) {
      showToast('ユーザ情報を更新しました', 'success');
      closeUserEditForm();
      // 職員一覧の再取得は main.js の委譲 listeners で行う（二重束縛防止）
      document.dispatchEvent(new CustomEvent('users:list-refresh'));
    }
  } catch (err) {
    showToast(`ユーザ情報の保存に失敗しました: ${err.message}`, 'error');
  } finally {
    const btn = document.getElementById('uinfo-save');
    if (btn) btn.disabled = false;
  }
}

/** モジュール初期化（フォーム束縛は1回だけ。職員一覧モーダル開閉で listener 増殖しない） */
export function initUserInfoModule() {
  const form = document.getElementById('user-info-edit-form');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveUserEditForm();
  });
  document.getElementById('uinfo-cancel')?.addEventListener('click', closeUserEditForm);
  refreshLucideIcons();
}

export default { initUserInfoModule, openUserEditForm, closeUserEditForm, isAdminUser, userKindCellHtml, userGradeCellHtml };

