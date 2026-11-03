import io
p = 'public/js/modules/bulletin.module.js'
f = io.open(p, encoding='utf-8').read()
pairs = []

pairs.append(('detailPane', '''/** 右ペイン（選択記事の全文）の描画 */
function renderDetailPane() {
  const pane = document.getElementById('bulletin-detail-pane');
  if (!pane) return;

  const item = bulletinsCache.find(b => String(b.id) === String(selectedId));
  pane.innerHTML = item
    ? detailPaneHtml(item)
    : `<div class="text-center py-12 text-xs text-muted">表示する掲示がありません。左のタイトルを選択してください。</div>`;
  refreshLucideIcons();
}''', ''))

pairs.append(('detailPaneHtml', '''/**
 * 右ペイン（投稿者・投稿日・掲示期間＋本文全文＋添付＋操作ボタン）
 * @param {Object} b
 */
function detailPaneHtml(b) {
  const attachments = b.attachments || [];
  const author = b.authorName || b.author_name || '教員';
  const avatar = b.authorAvatar || b.author_avatar || null;

  return `
    <header class="pane-header">
      <div class="flex w-full items-center gap-2 flex-wrap">
        ${badgeSpans(b)}
        <div class="flex items-center gap-1.5 text-[10px] font-mono text-soft">
          ${userAvatarHtml({ name: author, avatarUrl: avatar, size: 'xs' })}
          <span>投稿者: <strong class="text-main">${escapeHTML(author)}</strong></span>
        </div>
        <button type="button" data-bulletin-detail="${b.id}" class="ml-auto btn-secondary py-1 px-2.5 text-[10px] flex items-center gap-1 shrink-0"
                title="詳細（投稿日時・掲示期間・添付を含む全文）を読む">
          <i data-lucide="maximize-2" class="w-3 h-3"></i> 詳細
        </button>
      </div>
    </header>

    <div class="bulletin-detail-body">
      <h3 class="text-sm font-bold text-main mb-2">${escapeHTML(b.title)}</h3>
      <div class="text-xs text-main leading-relaxed whitespace-pre-wrap">${escapeHTML(b.content)}</div>
      ${attachmentsHtml(attachments)}
    </div>

    <footer class="pane-footer">
      <button type="button" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5" data-bulletin-comment="${b.id}">
        <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 補足・コメント
      </button>
      <div class="ml-auto hidden md:flex items-center gap-3 text-[10px] text-muted font-mono">
        <span><kbd class="kbd-key">↑</kbd><kbd class="kbd-key">↓</kbd> 前・次（選択で全文表示）</span>
        <span><kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd> 前日・翌日</span>
      </div>
    </footer>`;
}''', '''))

pairs.append(('markRead', '''  updateUnread(unreadCount);
  renderTitleColumn();  // 左列の未読バッジだけ更新（右ペインは選択側で描画）''',
'''  updateUnread(unreadCount);'''))

pairs.append(('openDetail', '''    updateUnread(unreadCount);
    renderTitleColumn();  // 左列の未読バッジのみ更新（右ペインは選択側で描画）''',
'''    updateUnread(unreadCount);
    renderCards();  // カードの未読バッジを更新'''))

pairs.append(('animateShift', '''  const span = Math.max(1, Math.min(Math.abs(days) || 1, 7));
  const prop = axis === 'y' ? 'translateY' : 'translateX';
  // 1日=中心日±3px・内容±5.5px、7日=中心日±9px・内容±14.5px。タイトル移動は従来どおり
  const readoutStep = dir * (2 + span);
  const contentStep = axis === 'y' ? dir * 18 : dir * (4 + span * 1.5);
  const fade = axis === 'y' ? 0.2 : 0.6;
  const opts = {
    duration: axis === 'y' ? 260 : 170,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
  };''', '''  const span = Math.max(1, Math.min(Math.abs(days) || 1, 7));
  const prop = axis === 'y' ? 'translateY' : 'translateX';
  // 1日はずlittle、複数日ジャンプだけ大きく動く（日付移動は卡片リストのみ、カード移動は y 軸）
  const contentStep = axis === 'y' ? dir * 18 : dir * (4 + span * 1.5);
  const fade = axis === 'y' ? 0.2 : 0.6;
  const opts = {
    duration: axis === 'y' ? 260 : 170,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
  };'''))

pairs.append(('animateSlide', '''  // 中心日は x 軸（日付ザッピング）でのみスライド。タイトル移動では動かさない
  if (axis === 'x') {
    const readoutEl = document.getElementById('bulletin-day-current');
    if (readoutEl && typeof readoutEl.animate === 'function') {
      readoutEl.animate(
        [{ transform: `translateX(${readoutStep}px)`, opacity: 0.65 }, { transform: 'translateX(0)', opacity: 1 }],
        opts
      );
    }
  }
  slide(document.getElementById('bulletin-list-container'), contentStep);
  slide(document.getElementById('bulletin-detail-pane'), contentStep);''',
'''  slide(document.getElementById('bulletin-card-list'), contentStep);'''))

for name, old, new in pairs:
    if old not in f:
        print('MISS', name)
    else:
        f = f.replace(old, new, 1)
        print('OK', name)

io.open(p, 'w', encoding='utf-8').write(f)