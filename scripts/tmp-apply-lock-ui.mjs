/** tmp-apply-lock-ui.mjs: sectionLockState・board.basic_info.locks・ロック中CSS を適用する */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

function apply(rel, pairs) {
  const p = path.join(ROOT, rel);
  let text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of pairs) {
    const n = text.split(from).length - 1;
    if (n !== 1) { console.log(`MISS(${n}) ${rel}: ${JSON.stringify(from.slice(0, 44))}`); continue; }
    text = text.split(from).join(to);
    console.log(`OK ${rel}`);
  }
  fs.writeFileSync(p, text, 'utf8');
}

// ============ exam.shared.js: sectionLockState ============
apply('public/js/modules/exam/exam.shared.js', [
  [
    'export function isKyomuUser() {\n  if (examStore.board) return !!examStore.board.is_kyomu;\n  return examStore.roleKyomu;\n}',
    'export function isKyomuUser() {\n  if (examStore.board) return !!examStore.board.is_kyomu;\n  return examStore.roleKyomu;\n}\n\n' +
      '/** 基本情報のセクション編集ロック状態（server の editing_locks が真。座席表と同一の仕組み）\n' +
      " *  'none' = 誰も編集中でない（既定は読み取り専用）、'mine' = 自分の編集モード、'other' = 他教員が編集中 */\n" +
      'export function sectionLockState(kind) {\n' +
      '  const lock = examStore.board?.basic_info?.locks?.[kind];\n' +
      "  if (!lock) return 'none';\n" +
      '  const uid = state.currentUser?.id;\n' +
      "  return String(lock.user_id) === String(uid) ? 'mine' : 'other';\n" +
      '}',
  ],
]);

// ============ exam.service.js: board.basic_info.locks ============
apply('src/services/exam.service.js', [
  [
    'availability, proctors, constraints, exemptions, subjectGroups, subjects, roomCatalog, classes, surveySummary] =',
    'availability, proctors, constraints, exemptions, subjectGroups, subjects, roomCatalog, classes, surveySummary, locks] =',
  ],
  [
    '        examModel.subjectSurveySummary(examMasterId),\n      ]);',
    '        examModel.subjectSurveySummary(examMasterId),\n        basicinfoService.sectionLocks(),\n      ]);',
  ],
  [
    '      basic_info: {\n        subject_groups: subjectGroups,\n        classes,\n        subjects,\n        rooms: roomCatalog,\n      },',
    '      basic_info: {\n        subject_groups: subjectGroups,\n        classes,\n        subjects,\n        rooms: roomCatalog,\n        locks,\n      },',
  ],
]);

// ============ components.css: ロック中の入力欄の見た目 ============
apply('public/css/components.css', [
  [
    '#exam-panel-basic .cc-list.is-locked [data-cc] {\n  cursor: default;\n}',
    '#exam-panel-basic .cc-list.is-locked [data-cc] {\n  cursor: default;\n}\n\n' +
      '/* 編集ロック中（読み取り専用）の入力欄・選択欄・削除ボタン（既定は編集ロック＝誰も編集していない状態） */\n' +
      '#exam-panel-basic .input-field:disabled,\n#exam-panel-basic select.input-field:disabled {\n  opacity: 0.55;\n  cursor: not-allowed;\n}\n\n' +
      '#exam-panel-basic button[data-act="delete"]:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}',
  ],
]);
