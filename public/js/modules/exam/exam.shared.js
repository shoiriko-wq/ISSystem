/**
 * ISSystem 定期考査 共有層
 * 考査ボード（全データ）の状態管理・APIラッパー・グリッド/バッジ描画ヘルパ
 * 権限: server が返す board.is_kyomu (KYOMU / ADMIN) に基づく
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../../api.js';
import { escapeHTML, refreshLucideIcons, showToast } from '../../ui-helpers.js';

/** 考査モジュール共通状態 */
export const examStore = {
  examId: null,
  board: null,
  isKyomu: false,
  sub: 'timetable',
  masters: [],
};

/** フェーズ表示メタ */
export const PHASE_META = {
  DRAFT: { label: '作成中', cls: 'bg-surface text-muted border border-main' },
  SURVEY: { label: '調査中', cls: 'bg-warning-soft text-warning-strong border border-warning-soft' },
  PUBLISHED: { label: '公表中', cls: 'bg-success-soft text-success-strong border border-success-soft' },
  ENDED: { label: '終了', cls: 'bg-danger-soft text-danger-strong border border-danger-soft' },
};

export const STREAM_LABEL = { SCIENCE: '理系', ARTS: '文系', OTHER: 'その他' };

/** {success, message, data} → data をアンラップ */
function unwrap(res) {
  if (res && Object.prototype.hasOwnProperty.call(res, 'data')) return res.data;
  return res;
}

export const examApi = {
  get: (ep) => apiGet(ep).then(unwrap),
  post: (ep, body) => apiPost(ep, body).then(unwrap),
  put: (ep, body) => apiPut(ep, body).then(unwrap),
  del: (ep) => apiDelete(ep).then(unwrap),
};

/** アクティブ考査の特定（明示指定がなければ active マスタ先頭） */
export async function resolveActiveExamId() {
  const masters = await examApi.get('/exam/masters');
  examStore.masters = masters || [];
  if (examStore.examId && examStore.masters.some((m) => m.id === examStore.examId)) {
    return examStore.examId;
  }
  return examStore.masters.length ? examStore.masters[0].id : null;
}

/** 考査ボード一括取得（master / phases / 全割当データ） */
export async function loadBoard(examId) {
  const id = examId || examStore.examId;
  if (!id) return null;
  const board = await examApi.get(`/exam/${id}/board`);
  examStore.examId = id;
  examStore.board = board;
  examStore.isKyomu = !!board.is_kyomu;
  if (!examStore.masters.length) examStore.masters = [board.master];
  return board;
}

export function isKyomuUser() {
  return examStore.isKyomu;
}

/** フェーズバッジ */
export function phaseBadge(phase) {
  const meta = PHASE_META[phase] || PHASE_META.DRAFT;
  return `<span class="badge text-[10px] px-1.5 py-0.5 rounded font-bold ${meta.cls}">${meta.label}</span>`;
}

/** セクションカード */
export function sectionCard(icon, title, desc, bodyHtml, extra = '') {
  return `<div class="card p-4 space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h3 class="text-sm font-bold text-main flex items-center gap-2">
          <i data-lucide="${icon}" class="w-4 h-4 text-accent"></i> ${escapeHTML(title)}
        </h3>
        ${desc ? `<p class="text-[11px] text-muted mt-0.5">${desc}</p>` : ''}
      </div>
      ${extra}
    </div>
    ${bodyHtml}
  </div>`;
}

/** 診断リスト（HARD=赤 / SOFT=橙 / INFO=灰） */
export function diagnosticsHtml(list) {
  if (!list || list.length === 0) {
    return `<p class="text-[11px] text-success-strong">制約チェック: 問題ありません（HARD 0 件）</p>`;
  }
  const levelOf = (d) => (d.level ? d.level : d.type === 'UNPLACED' || d.type === 'OVERFLOW' || d.type === 'FIXED_SLOT' ? 'HARD' : 'SOFT');
  const clsOf = (lv) => (lv === 'HARD' ? 'text-danger-strong' : lv === 'SOFT' ? 'text-warning-strong' : 'text-muted');
  return `<ul class="space-y-1 text-[11px]">
    ${list
      .map((d) => {
        const lv = levelOf(d);
        return `<li class="flex items-start gap-1.5 ${clsOf(lv)}">
          <i data-lucide="${lv === 'HARD' ? 'alert-octagon' : lv === 'SOFT' ? 'alert-triangle' : 'info'}" class="w-3 h-3 mt-0.5 shrink-0"></i>
          <span>${escapeHTML(d.message || d.msg || '')}</span>
        </li>`;
      })
      .join('')}
  </ul>`;
}

/** 実施単位キー（planId#grade） */
export function unitKey(planId, grade) {
  return `${planId}#${grade}`;
}

/** planId 抽出 */
export function planIdOf(key) {
  return String(key || '').split('#')[0] || null;
}

/** 学年別実施単位（grade=0 の全学年展開プランを含む） */
export function unitsForGrade(plan, grade) {
  return (plan || []).filter((p) => Number(p.grade) === 0 || Number(p.grade) === Number(grade));
}

/** スロット行 → unitKey → 配置 {grade, day, slot, span, subject_name, setter} */
export function slotPositions(slots) {
  const pos = new Map();
  for (const s of slots || []) {
    const key = s.unit_id || s.subject_id;
    if (!key) continue;
    pos.set(key, {
      key,
      grade: Number(s.grade),
      day: Number(s.day_number),
      slot: Number(s.slot_number),
      span: Number(s.slot_span) || Number(s.duration_slots) || 1,
      subject_name: s.subject_name,
      setter: s.setter_teacher_name,
    });
  }
  return pos;
}

/** 指定コマ（学年・日・時限）を占有している単位 */
export function cellUnit(pos, grade, day, slot) {
  for (const p of pos.values()) {
    if (p.grade !== Number(grade)) continue;
    if (p.day === Number(day) && slot >= p.slot && slot < p.slot + p.span) {
      return { ...p, isStart: p.slot === slot };
    }
  }
  return null;
}

/** フェーズ+編集可否の通知 */
export function notifyAction(data, message, type = 'success') {
  showToast(message || (data && data.message) || '処理を実行しました', type);
  refreshLucideIcons();
}

export { escapeHTML, refreshLucideIcons, showToast };
