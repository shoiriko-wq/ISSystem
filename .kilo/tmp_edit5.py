import io

p = 'public/js/modules/bulletin.module.js'
lines = io.open(p, encoding='utf-8').read().split('\n')

# 1. 旧ツールバー（中心日表示・件数サマリ・日付label・カレンダーボタン）を削除
start = next(n for n, l in enumerate(lines) if '投稿日ザッピングツールバー' in l)
sum_i = next(n for n, l in enumerate(lines) if 'bulletin-day-summary' in l)
end = sum_i + 1  # </div>
assert lines[end].strip() == '</div>', lines[end]
del lines[start:end + 1]

s = '\n'.join(lines)

# 2. renderDayStrip() 呼び出しを撤廃
s = s.replace('  renderDayStrip();\n  renderBulletinList();', '  renderBulletinList();')

# 3. アニメーションは卡片リストだけ（中心日表示は存在しない）
s = s.replace("  // 1日=中心日±3px・内容±5.5px、7日=中心日±9px・内容±14.5px。タイトル移動は従来どおり\n  const readoutStep = dir * (2 + span);\n",
              '  // 1日はずっと小さく、複数日ジャンプだけ大きく動く\n')
block = '''  // 中心日は x 軸（日付ザッピング）でのみスライド。タイトル移動では動かさない
  if (axis === 'x') {
    const readoutEl = document.getElementById('bulletin-day-current');
    if (readoutEl && typeof readoutEl.animate === 'function') {
      readoutEl.animate(
        [{ transform: `translateX(${readoutStep}px)`, opacity: 0.65 }, { transform: 'translateX(0)', opacity: 1 }],
        opts
      );
    }
  }
'''
assert block in s
s = s.replace(block, '')
s = s.replace("  slide(document.getElementById('bulletin-list-container'), contentStep);\n  slide(document.getElementById('bulletin-detail-pane'), contentStep);",
              "  slide(document.getElementById('bulletin-card-list'), contentStep);")

# 4. 日付移動時もフォーカスを追従
s = s.replace("  const shift = dir || Math.sign(dayDiff(currentDayDate, target)) || 0;\n  currentDayDate = target;",
              "  const shift = dir || Math.sign(dayDiff(currentDayDate, target)) || 0;\n  const hadFocus = document.activeElement && document.activeElement.closest('#bulletin-card-list');\n  currentDayDate = target;")
s = s.replace("  animateShift(shift, 'x', span);\n  refreshLucideIcons();",
              "  animateShift(shift, 'x', span);\n  if (hadFocus) focusSelectedCard();\n  refreshLucideIcons();")

# 5. 文言更新
s = s.replace(' * 中心日の設定（ザッピングの中心関数）。中心日は ‹ › の左の固定幅表示に反映される',
              ' * 表示日の設定（カードリスト再描画を駆動する中心関数）。ヘッダーの日付入力に追従')
s = s.replace('// 初期中心日 = 今日 (JST)。7日ウィンドウの真ん中に今日を置く',
              '// 初期表示日 = 今日 (JST)。カードリストは今日の投稿だけを出す')
s = s.replace('// ★ キーボードザッピング（掲示板タブがアクティブな時のみ）',
              '// ★ キーボード操作（掲示タブがアクティブな時のみ）')
s = s.replace('// 中心日は ‹ › の左に固定幅で表示する。幅が動かないので矢印ボタンは常に同じ位置（連打できる）\n', '')

io.open(p, 'w', encoding='utf-8').write(s)
print('done')