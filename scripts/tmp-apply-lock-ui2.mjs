/** tmp-apply-lock-ui2.mjs: exam.basic.ui.js / exam.module.js / exam.subject.ui.js へ編集ロック（server連動）を適用 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

function apply(rel, pairs) {
  const p = path.join(ROOT, rel);
  let text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to] of pairs) {
    const n = text.split(from).length - 1;
    if (n !== 1) { console.log(`MISS(${n}) ${rel}: ${JSON.stringify(from.slice(0, 40))}`); continue; }
    text = text.split(from).join(to);
    console.log(`OK ${rel}`);
  }
  fs.writeFileSync(p, text, 'utf8');
}

const B = '`';
const D = '$';

// ============ exam.basic.ui.js ============
apply('public/js/modules/exam/exam.basic.ui.js', [
  [
    ' * 既定は編集ロック（読み取り専用）で、ロック中は入力欄・行追加・削除・実施クラス・コースチップが操作不能（UI側のロックでサーバーの排他編集ロックとは連動しない）。',
    ' * 既定は読み取り専用で、ロック中は入力欄・行追加・削除・実施クラス・コースチップが操作不能。\n' +
      ' * ロックは server の editing_locks（座席表と同一の仕組み）。他教員が編集中はトグルに「他: 名前」が出、書き込みは 423 で守られる。',
  ],
  [
    "import { examStore, examApi, sectionCard, isKyomuUser } from './exam.shared.js';",
    "import { examStore, examApi, sectionCard, isKyomuUser, sectionLockState } from './exam.shared.js';",
  ],
  [
    '/** セクション単位の編集ロック状態（true = 編集ロック = 読み取り専用）。既定はすべて編集ロック。\n' +
      ' *  座席表と同じ「タイトル部のトグルで編集可能 ⇔ 編集ロック」だが、サーバーの排他編集ロック（editing_locks）とは連動しない（UI側のロック）。 */\n' +
      'const basicLocks = { class: true, group: true, subject: true, room: true };',
    '/** セクション単位の編集ロック（座席表の編集排他ロックと同一のサーバー仕組み editing_locks を使う）。\n' +
      ' *  状態は server が返す board.basic_info.locks が真。トグルは POST / DELETE /api/exam/basic-lock/:kind を叩く。\n' +
      ' *  既定は誰もロックしていない＝読み取り専用。トグルで編集可能（ロック取得）⇔ 編集ロック（解放）。 */',
  ],
  [
    "function isLocked(kind) {\n  return basicLocks[kind] !== false;\n}",
    "function isLocked(kind) {\n  return sectionLockState(kind) !== 'mine';\n}",
  ],
  [
    '  const locked = isLocked(kind);\n  const label = KIND_LABELS[kind];',
    '  const locked = isLocked(kind);\n  const st = sectionLockState(kind);\n  const holder = examStore.board?.basic_info?.locks?.[kind]?.user_name || \'\';\n  const label = KIND_LABELS[kind];',
  ],
  [
    `    title="${D}{locked ? 'クリックで編集可能モードへ' : 'クリックで編集ロック（読み取り専用）へ'}"`,
    "    title=\"" + D + "{st === 'mine' ? 'クリックで編集ロック（読み取り専用）へ戻します' : st === 'other' ? '他の教員（' + holder + '）が編集中' : 'クリックで編集可能モードへ'}\"",
  ],
  [
    "    <span>${" + "locked ? '編集ロック' : '編集可能'}</span>",
    "    <span>" + D + "{locked ? '編集ロック' : '編集可能'}</span>\n    " + D + "{st === 'other' ? " + B + "<span class=\"text-[10px] text-warning-strong\">他: " + D + "{escapeHTML(holder)}</span>" + B + " : ''}",
  ],
  [
    '  const sig = { signal: autoCtl.signal };\n\n  const queue = [];',
    '  const sig = { signal: autoCtl.signal };\n\n' +
      '  // ロックの寿命（TTL 180秒）を生かす心跳：編集可能モードのセクションを 90 秒ごとに再取得し、\n' +
      '  // 自分の編集を他教員へ渡さない（パネル unbind で心跳は止まる）\n' +
      '  const heartbeat = setInterval(() => {\n' +
      '    Object.keys(ROW_BUILDERS).forEach((kind) => {\n' +
      "      if (sectionLockState(kind) === 'mine') examApi.post(" + B + '/exam/basic-lock/' + D + '{kind}' + B + ', {}).catch(() => {});\n' +
      '    });\n' +
      '  }, 90000);\n' +
      "  autoCtl.signal.addEventListener('abort', () => clearInterval(heartbeat));\n\n  const queue = [];",
  ],
  [
    'export function bindBasicTab(container, reload) {',
    '/** 画面を離れるときに自分の編集ロックをすべて返す（他教員の編集を直ちに解放する） */\n' +
      'export function releaseBasicLocks() {\n' +
      '  Object.keys(ROW_BUILDERS).forEach((kind) => {\n' +
      "    if (sectionLockState(kind) === 'mine') examApi.del(" + B + '/exam/basic-lock/' + D + '{kind}' + B + ').catch(() => {});\n' +
      '  });\n' +
      '}\n\n' +
      'export function bindBasicTab(container, reload) {',
  ],
]);


// トグル = server のロック API を叩く（編集可能＝ロック取得／編集ロック＝解放）
const OLD_TOGGLE = [
  "      lockBtn.addEventListener('click', () => {",
  '        basicLocks[kind] = !basicLocks[kind];',
  '        applyLockState(panel, kind);',
  '        showToast(',
  '          basicLocks[kind]',
  '            ? ' + B + D + '{KIND_LABELS[kind]}を編集ロックしました（読み取り専用）。' + B,
  '            : ' + B + D + '{KIND_LABELS[kind]}を編集可能モードへ切り替えました。' + B + ',',
  "          basicLocks[kind] ? 'info' : 'success'",
  '        );',
  '      }, sig);',
].join('\n');

const NEW_TOGGLE = [
  "      lockBtn.addEventListener('click', async () => {",
  '        const st = sectionLockState(kind);',
  '        lockBtn.disabled = true;',
  '        try {',
  "          if (st === 'mine') {",
  '            await examApi.del(' + B + '/exam/basic-lock/' + D + '{kind}' + B + ');',
  '            showToast(' + B + D + '{KIND_LABELS[kind]}を編集ロック（読み取り専用）へ戻しました。' + B + ", 'info');",
  '          } else {',
  '            await examApi.post(' + B + '/exam/basic-lock/' + D + '{kind}' + B + ', {});',
  '            showToast(' + B + D + '{KIND_LABELS[kind]}を編集可能モードへ切り替えました（今この自分だけが入力できます）。' + B + ", 'success');",
  '          }',
  '        } catch (err) {',
  '          showToast(err.message, ' + "'error'" + ');',
  '        }',
  '        lockBtn.disabled = false;',
  '        await reload();',
  '        applyLockState(panel, kind);',
  '      }, sig);',
].join('\n');

apply('public/js/modules/exam/exam.basic.ui.js', [[OLD_TOGGLE, NEW_TOGGLE]]);

// ============ exam.module.js ============
apply('public/js/modules/exam/exam.module.js', [
  [
    "import { renderBasicTab, bindBasicTab } from './exam.basic.ui.js';",
    "import { renderBasicTab, bindBasicTab, releaseBasicLocks } from './exam.basic.ui.js';",
  ],
  [
    "    examStore.sub = btn.dataset.subtab;\n    if (examStore.sub === 'timetable') resetTimetableState();",
    "    examStore.sub = btn.dataset.subtab;\n    if (examStore.sub !== 'basic') releaseBasicLocks();   // 画面を離れるときは自分の編集ロックを返す\n    if (examStore.sub === 'timetable') resetTimetableState();",
  ],
  [
    "  socketClient.on('basicinfo:changed', () => {\n    const view = document.getElementById('view-exam');\n    if (state.currentUser && view && !view.classList.contains('hidden')) {\n      reload();\n    }\n  });",
    "  socketClient.on('basicinfo:changed', () => {\n    const view = document.getElementById('view-exam');\n    if (state.currentUser && view && !view.classList.contains('hidden')) {\n      reload();\n    }\n  });\n\n  // 基本情報のセクション編集ロック変化（座席表の lock:status_changed と同一イベント）を板へ反映する\n  socketClient.on('lock:status_changed', (payload) => {\n    if (payload?.resourceType !== 'exam_basic') return;\n    const view = document.getElementById('view-exam');\n    if (!state.currentUser || !view || view.classList.contains('hidden')) return;\n    const locks = examStore.board?.basic_info?.locks;\n    if (!locks) return;\n    const kind = payload.kind;\n    if (payload.isLocked) locks[kind] = { user_id: payload.user_id, user_name: payload.user_name };\n    else delete locks[kind];\n    if (examStore.sub === 'basic') renderActivePanel();\n  });",
  ],
]);

// ============ exam.subject.ui.js ============
apply('public/js/modules/exam/exam.subject.ui.js', [
  [
    "  isKyomuUser,\n} from './exam.shared.js';",
    "  isKyomuUser,\n  sectionLockState,\n} from './exam.shared.js';",
  ],
  [
    'export function subjectRowHtml(p, kyomu) {\n  const can = rowEditable(p, kyomu);',
    "export function subjectRowHtml(p, kyomu) {\n  // クラス・コース編集ロックが他教員なら chips を操作不能にする（server も書き込みを 423 で守る）\n  const can = rowEditable(p, kyomu) && sectionLockState('class') !== 'other';",
  ],
]);
