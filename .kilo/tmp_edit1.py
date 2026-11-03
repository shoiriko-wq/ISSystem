import io
p = 'public/js/modules/bulletin.module.js'
f = io.open(p, encoding='utf-8').read()
pairs = []

# A. 中心日表示・件数サマリ（年月日と件数の欄）を撤廃
pairs.append(('renderDayStrip', '''/**
 * 中心日表示（ツールバーの ‹ › の左、固定幅）とサマリ件数の更新
 */
function renderDayStrip() {
  const readoutEl = document.getElementById('bulletin-day-current');
  const summaryEl = document.getElementById('bulletin-day-summary');
  if (!readoutEl && !summaryEl) return;

  const center = currentDayDate || dayKey(0);
  const counts = dayCounts();

  if (readoutEl) {
    readoutEl.dataset.day = center;
    readoutEl.textContent = `${mdLabel(center)}(${weekdayLabel(center)})`;
  }

  const total = bulletinsCache.length;
  if (summaryEl) {
    summaryEl.textContent = `${center} (${weekdayLabel(center)}) ${counts.get(center) || 0} 件 / 全 ${total} 件`;
  }
}''', ''))

# B. M/D 表記ヘルパーは未使用
pairs.append(('mdLabel', '''/** M/D 表記 */
function mdLabel(key) {
  const p = String(key).split('-');
  return `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}`;
}''', ''))

# C. ミニカレンダーの手引き文言
pairs.append(('calhint', '''    <p class="text-[10px] text-muted mt-2">● は投稿のある日です。日付をクリックでその日に絞り込み、←/→ キーと左右の矢印ボタンで前日/翌日（1日分）へザッピングできます。</p>''',
'''    <p class="text-[10px] text-muted mt-2">● は投稿のある日です。日付をクリックでその日の記事を表示し、←/→ キーと ‹ › ボタンで前日・翌日（1日分）へ移動できます。</p>'''))

for name, old, new in pairs:
    if old not in f:
        print('MISS', name)
    else:
        f = f.replace(old, new, 1)
        print('OK', name)

io.open(p, 'w', encoding='utf-8').write(f)