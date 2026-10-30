/**
 * ISSystem Subject Catalog Module (教科マスタ・担当教科)
 * 担当教科はプロフィールで複数選択、教科マスタの追加・改名・削除は教務部 (KYOMU) のみ
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

const NAME_MAX = 20;

const COLOR_KEYS = ['ACCENT', 'SUCCESS', 'INFO', 'WARNING', 'DANGER', 'PURPLE', 'SLATE'];
const COLOR_LABELS = {
  ACCENT: 'アクセント',
  SUCCESS: '緑',
  INFO: '青',
  WARNING: '黄',
  DANGER: '赤',
  PURPLE: '紫',
  SLATE: 'グレー',
};

const CHIP_PALETTE = {
  ACCENT: 'bg-accent-soft text-accent-strong border-accent-soft',
  PURPLE: 'bg-accent-alt-soft text-accent-alt border-accent-alt',
  SUCCESS: 'bg-success-soft text-success-strong border-success-soft',
  WARNING: 'bg-warning-soft text-warning-strong border-warning-soft',
  INFO: 'bg-info-soft text-info-strong border-info-soft',
  DANGER: 'bg-danger-soft text-danger-strong border-danger-soft',
  SLATE: 'bg-surface text-soft border-divider',
};

let subjectsCache = [];

function isKyomuUser() {
  const u = state.currentUser;
  if (!u) return false;
  const role = String(u.role || '').toUpperCase();
  return u.is_kyomu === true || role === 'KYOMU' || role === 'ADMIN';
}

function palette(colorKey) {
  return CHIP_PALETTE[String(colorKey || 'SLATE').toUpperCase()] || CHIP_PALETTE.SLATE;
}

/** 教科マスタ一覧 (キャッシュ) */
export async function loadSubjects(force = false) {
  if (subjectsCache.length > 0 && !force) return subjectsCache;
  try {
    const res = await apiGet('/subjects');
    const list = res.subjects || res.data || [];
    subjectsCache = list.map((s) => ({
      id: String(s.id),
      name: String(s.name),
      color_key: String(s.color_key || 'SLATE'),
      sort_order: Number(s.sort_order) || 0,
      plan_count: Number(s.plan_count) || 0,
      teacher_count: Number(s.teacher_count) || 0,
    }));
  } catch (err) {
    console.warn('[SubjectsModule] 教科マスタの取得に失敗:', err.message);
    subjectsCache = [];
  }
  return subjectsCache;
}

export function subjectNames() {
  return subjectsCache.map((s) => s.name);
}

export function subjectsCacheList() {
  return subjectsCache;
}

/** 担当教科表示用チップ */
export function subjectChipsHtml(names, max = 4) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (list.length === 0) return '<span class=\"text-[10px] text-muted\">担当教科なし</span>';
  const shown = list.slice(0, max);
  const chips = shown.map((n) => {
    const sub = subjectsCache.find((s) => String(s.name) === String(n));
    const cls = palette(sub ? sub.color_key : 'SLATE');
    return `<span class="px-1.5 py-0.5 text-[10px] rounded border ${cls} shrink-0">${escapeHTML(n)}</span>`;
  });
  const extra = list.length - shown.length;
  if (extra > 0) chips.push(`<span class="text-[10px] text-muted">+${extra}</span>`);
  return `<div class="flex flex-wrap gap-1">${chips.join('')}</div>`;
}
/**
 * 担当教科の複数選択UI (チェックボックスチップ) を描画する
 * @param {string} containerId 容器要素ID
 * @param {string[]} selected 選択中の教科名
 * @param {string} checkboxName チェックボックスのname属性
 */
export function renderSubjectPicker(containerId, selected = [], checkboxName = 'subject') {
  const holder = document.getElementById(containerId);
  if (!holder) return;

  const selectedSet = new Set((selected || []).map((n) => String(n)));

  if (subjectsCache.length === 0) {
    holder.innerHTML = '<div class="text-[11px] text-muted">教科マスタが登録されていません。教務部が教科を追加してください。</div>';
    return;
  }

  holder.innerHTML = subjectsCache.map((s) => {
    const cls = palette(s.color_key);
    const checked = selectedSet.has(String(s.name)) ? 'checked' : '';
    return `<label class="subject-chip flex items-center gap-1 px-2 py-1 text-[11px] rounded border ${cls} cursor-pointer select-none" data-subject-id="${s.id}">
        <input type="checkbox" name="${checkboxName}" value="${escapeHTML(s.name)}" ${checked} class="accent-theme w-3 h-3 shrink-0">
        <span>${escapeHTML(s.name)}</span>
      </label>`;
  }).join('');
}

/** 担当教科選択UIから選択値を読み取る */
export function readSubjectPicker(containerId) {
  const holder = document.getElementById(containerId);
  if (!holder) return [];
  return Array.from(holder.querySelectorAll(`input[type="checkbox"]:checked`)).map((cb) => cb.value);
}

/** 教員の担当教科設定 (自分自身は全教職員、他教員は教務部のみ) */
export async function setUserSubjects(userId, subjects) {
  const res = await apiPut(`/users/${userId}/subjects`, { subjects: subjects || [] });
  return res;
}

/** 担当教科選択UIを再描画 (教科マスタ読み込み込み) */
export async function renderSubjectPickerAsync(containerId, selected = [], checkboxName = 'subject') {
  await loadSubjects();
  renderSubjectPicker(containerId, selected, checkboxName);
}
/** 教科マスタ管理モーダル (教務部 KYOMU のみ・追加改名削除と使用件数) */
function ensureSubjectAdminDom() {
  if (document.getElementById('subject-admin-modal')) return;
  const container = document.getElementById('modal-container') || document.body;

  const colorOptions = COLOR_KEYS.map((k) => `<option value="${k}">${COLOR_LABELS[k]}</option>`).join('');

  container.insertAdjacentHTML('beforeend', `
    <div id="subject-admin-modal" class="modal-overlay hidden">
      <div class="modal-card modal-card--wide">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="book-open" class="w-5 h-5 text-accent"></i> 教科マスタ管理</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div class="modal-body space-y-3">
          <div class="p-2 rounded-lg bg-info-soft border border-info-soft text-[11px] text-info-strong">
            教科マスタは<b>教務部 (KYOMU)</b> のみ追加・改名・削除できます。教員はプロフィールで<b>担当教科を複数選択</b>します。
            改名は考査計画の教科名と教員の担当教科へ自動的に反映されます。
          </div>
          <form id="subject-add-form" class="flex flex-wrap items-end gap-2">
            <div class="flex-1 min-w-[150px]">
              <label class="block text-xs font-semibold text-soft mb-1">教科名（${NAME_MAX}文字以内）</label>
              <input id="subject-add-name" maxlength="${NAME_MAX}" required class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main" placeholder="例: 保健体育">
            </div>
            <div class="w-28">
              <label class="block text-xs font-semibold text-soft mb-1">色</label>
              <select id="subject-add-color" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">${colorOptions}</select>
            </div>
            <div class="w-16">
              <label class="block text-xs font-semibold text-soft mb-1">表示順</label>
              <input id="subject-add-sort" type="number" min="0" max="999" value="0" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
            </div>
            <button type="submit" class="btn-primary px-3 py-2 text-xs rounded flex items-center gap-1">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> 追加
            </button>
          </form>
          <div id="subject-admin-list" class="space-y-2"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="modal-close btn-primary px-4 py-2 text-xs rounded bg-accent text-main font-bold hover-primary">閉じる</button>
        </div>
      </div>
    </div>
  `);
}

/** 教科マスタ一覧 (教務部用の編集行) を描画する */
function renderSubjectAdminList() {
  const holder = document.getElementById('subject-admin-list');
  if (!holder) return;

  if (subjectsCache.length === 0) {
    holder.innerHTML = '<div class="p-3 text-xs text-muted text-center">教科がありません。上のフォームから追加してください。</div>';
    return;
  }

  const colorOptions = COLOR_KEYS.map((k) => `<option value="${k}">${COLOR_LABELS[k]}</option>`).join('');

  holder.innerHTML = subjectsCache.map((s) => {
    return `<div class="subject-row flex flex-wrap items-center gap-2 p-2 rounded-lg border border-divider bg-surface-soft" data-subject-id="${s.id}">
      <input type="text" data-field="name" value="${escapeHTML(s.name)}" maxlength="${NAME_MAX}" class="w-32 p-1.5 text-xs rounded bg-surface border border-main text-main" required>
      <select data-field="color_key" class="w-24 p-1.5 text-xs rounded bg-surface border border-main text-main">${colorOptions}</select>
      <input type="number" data-field="sort_order" value="${Number(s.sort_order) || 0}" min="0" max="999" class="w-14 p-1.5 text-xs rounded bg-surface border border-main text-main">
      <span class="text-[10px] text-muted font-semibold shrink-0">担当 ${Number(s.teacher_count) || 0}名 / 考査 ${Number(s.plan_count) || 0}枠</span>
      <div class="flex items-center gap-1 ml-auto">
        <button type="button" data-action="save" class="btn-primary px-2 py-1.5 text-[11px] rounded flex items-center gap-1"><i data-lucide="save" class="w-3 h-3"></i> 保存</button>
        <button type="button" data-action="delete" class="btn-danger px-2 py-1.5 text-[11px] rounded bg-danger-soft text-danger-strong hover-danger-strong flex items-center gap-1"><i data-lucide="trash-2" class="w-3 h-3"></i> 削除</button>
      </div>
    </div>`;
  }).join('');

  bindSubjectRowHandlers(holder);
  refreshLucideIcons();
}
/** 教務部用編集行の保存・削除ボタンを束縛する */
function bindSubjectRowHandlers(holder) {
  holder.querySelectorAll('.subject-row').forEach((row) => {
    const id = String(row.dataset.subjectId);

    row.querySelector('[data-action=save]').addEventListener('click', async () => {
      const name = row.querySelector('[data-field=name]').value.trim();
      const color_key = row.querySelector('[data-field=color_key]').value;
      const sort_order = Number(row.querySelector('[data-field=sort_order]').value) || 0;
      if (!name) { showToast('教科名を入力してください。', 'error'); return; }

      try {
        await apiPut(`/subjects/${id}`, { name, color_key, sort_order });
        showToast(`教科「${name}」を更新しました。`, 'success');
        await loadSubjects(true);
        renderSubjectAdminList();
      } catch (e) {
        showToast(`更新に失敗しました: ${e.message}`, 'error');
      }
    });

    row.querySelector('[data-action=delete]').addEventListener('click', async () => {
      const target = subjectsCache.find((s) => String(s.id) === id);
      const planCount = target ? Number(target.plan_count) || 0 : 0;
      const teacherCount = target ? Number(target.teacher_count) || 0 : 0;

      if (planCount > 0) {
        showToast(`「${target ? target.name : ''}」は考査計画で ${planCount}枠使用されているため削除できません。`, 'error');
        return;
      }

      const message = teacherCount > 0
        ? `「${target ? target.name : 'この教科'}」は ${teacherCount}名の担当教科に登録されています。削除しますか？（教員の担当教科からも除去されます）`
        : `「${target ? target.name : 'この教科'}」を削除しますか？`;
      if (!window.confirm(message)) return;

      try {
        await apiDelete(`/subjects/${id}`);
        showToast(`教科「${target ? target.name : ''}」を削除しました。`, 'success');
        await loadSubjects(true);
        renderSubjectAdminList();
      } catch (e) {
        showToast(`削除に失敗しました: ${e.message}`, 'error');
      }
    });
  });
}

/** 教科追加フォーム (教務部 KYOMU) */
async function submitSubjectAddForm(event) {
  event.preventDefault();
  if (!isKyomuUser()) {
    showToast('教科マスタの追加は教務部 (KYOMU) のみです。', 'error');
    return;
  }

  const nameInput = document.getElementById('subject-add-name');
  const colorInput = document.getElementById('subject-add-color');
  const sortInput = document.getElementById('subject-add-sort');
  const name = nameInput ? nameInput.value.trim() : '';
  const color_key = colorInput ? colorInput.value : 'SLATE';
  const sort_order = sortInput ? Number(sortInput.value) || 0 : 0;

  if (!name) { showToast('教科名を入力してください。', 'error'); return; }

  try {
    const res = await apiPost('/subjects', { name, color_key, sort_order });
    showToast(`教科「${name}」を追加しました。`, 'success');
    if (nameInput) nameInput.value = '';
    await loadSubjects(true);
    renderSubjectAdminList();
    return res;
  } catch (e) {
    showToast(`教科追加に失敗しました: ${e.message}`, 'error');
  }
}

/** 教科マスタ管理モーダルを開く (教務部のみ) */
export function openSubjectAdmin() {
  if (!isKyomuUser()) {
    showToast('教科マスタの追加・改名・削除は教務部 (KYOMU) のみです。', 'error');
    return;
  }
  ensureSubjectAdminDom();
  renderSubjectAdminList();
  openModal('subject-admin-modal');
  refreshLucideIcons();
}

/** モジュール初期化 (DOM生成・追加フォーム・教科マスタ読み込み) */
export async function initSubjectsModule() {
  ensureSubjectAdminDom();
  const addForm = document.getElementById('subject-add-form');
  if (addForm) addForm.addEventListener('submit', submitSubjectAddForm);
  await loadSubjects(true);
  refreshLucideIcons();
}

export { isKyomuUser };
