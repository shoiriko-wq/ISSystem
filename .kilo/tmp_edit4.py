import io

p = 'public/js/modules/bulletin.module.js'
lines = io.open(p, encoding='utf-8').read().split('\n')

def block_range(sig):
    i = next(n for n, l in enumerate(lines) if l.startswith(sig))
    depth = 0
    started = False
    for j in range(i, len(lines)):
        for ch in lines[j]:
            if ch == '{':
                depth += 1
                started = True
            elif ch == '}':
                depth -= 1
        if started and depth == 0:
            return i, j
    raise SystemExit('unbalanced: ' + sig)

def delete_block(sig, include_doc=True):
    i, j = block_range(sig)
    start = i
    if include_doc and start > 0 and lines[start - 1].strip() == '*/':
        # doc comment ends at */; walk back to its /**
        k = start - 1
        while k > 0 and not lines[k].strip().startswith('/*'):
            k -= 1
        start = k
    del lines[start:j + 1]

# 1. renderDetailPane / detailPaneHtml を削除（記事はカードで独立表示）
delete_block('function renderDetailPane()')
delete_block('function detailPaneHtml(')

# 2. selectBulletin を卡片ベースへ
i, j = block_range('function selectBulletin(')
new_select = '''/**
 * カード選択（↑/↓ キー・カードクリック。選択時点で既読化し、カードを強調表示）
 * @param {string} id 掲示ID
 * @param {number} [dir] 移動方向（1=次/下、-1=前/上）。省略時は表示順の位置差から算出
 */
function selectBulletin(id, dir = 0) {
  const key = String(id);
  const items = filteredBulletins();
  const item = items.find(b => String(b.id) === key);
  if (!item) return;

  const prevIdx = items.findIndex(b => String(b.id) === String(selectedId));
  const nextIdx = items.findIndex(b => String(b.id) === key);
  const shift = dir || Math.sign(nextIdx - prevIdx) || 0;

  selectedId = key;
  markBulletinRead(key);          // 非同期 PUT（ローカル状態は即更新）
  renderCards();
  animateShift(shift, 'y');
  focusSelectedCard();
  refreshLucideIcons();
}

/** 選択カードへフォーカスを引き継ぐ（↑/↓ 移動でキーボード操作を止めない） */
function focusSelectedCard() {
  const card = document.querySelector(`#bulletin-card-list [data-bulletin-toggle="${selectedId}"]`);
  if (!card) return;
  card.focus();
  card.scrollIntoView({ block: 'nearest' });
}

/** キーボード操作の手引き（収納パネル）の開閉 */
function toggleKeysHelp() {
  const pop = document.getElementById('bulletin-keys-pop');
  const btn = document.getElementById('bulletin-keys-toggle');
  if (!pop) return;
  const opening = pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !opening);
  if (btn) btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
}'''
lines[i:j + 1] = new_select.split('\n')

# 3. markBulletinRead / openBulletinDetail の再描画先
s = '\n'.join(lines)
s = s.replace("  renderTitleColumn();  // 左列の未読バッジだけ更新（右ペインは選択側で描画）",
              "  renderCards();  // カードの未読バッジだけ更新")
s = s.replace("    renderTitleColumn();  // 左列の未読バッジのみ更新（右ペインは選択側で描画）",
              "    renderCards();  // カードの未読バッジを更新")
io.open(p, 'w', encoding='utf-8').write(s)
print('done selectBulletin/markRead/openDetail')