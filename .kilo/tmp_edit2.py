import io
p = 'public/js/modules/bulletin.module.js'
f = io.open(p, encoding='utf-8').read()
pairs = []

# E. 左列タイトル行 → 記事カード（タイトル直下に本文が来る独立記事）
pairs.append(('cardHtml', '''/**
 * 左列のタイトル行（1行タイトル＋行右端の未読バッチ＋クリック誘導のシグニファイア ›）
 * 時間は表示しない。長いタイトルは未読バッチの下に潜って省略表示される
 * @param {Object} b
 * @param {boolean} selected 右ペインで全文表示中か
 */
function titleRowHtml(b, selected) {
  const unread = isUnreadBulletin(b);
  return `
    <button type="button" data-bulletin-toggle="${b.id}" role="option"
            aria-selected="${selected ? 'true' : 'false'}"
            data-unread="${unread ? 'true' : 'false'}"
            title="${escapeHTML(b.title)}"
            class="nav-item bulletin-title-row${selected ? ' active' : ''}">
      <span class="bulletin-row-signifier" aria-hidden="true"><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i></span>
      <span class="bulletin-row-title truncate">${escapeHTML(b.title)}</span>
      ${unread ? '<span class="bulletin-unread-badge">未読</span>' : ''}
    </button>`;
}''', '''/**
 * 記事カード（独立記事：タイトル行の直下に本文が来る。タイトルは左寄せ、右端に投稿者・時刻）
 * @param {Object} b
 * @param {boolean} selected 選択中（既読化済み・強調表示）か
 */
function articleCardHtml(b, selected) {
  const unread = isUnreadBulletin(b);
  const attachments = b.attachments || [];
  const author = b.authorName || b.author_name || '教員';
  const avatar = b.authorAvatar || b.author_avatar || null;
  const time = timeOfJstLabel(b.postedAt || b.posted_at || b.createdAt || b.created_at);
  const longBody = String(b.content || '').length > 240;

  return `
    <article class="bulletin-card${selected ? ' active' : ''}" data-bulletin-toggle="${b.id}"
             data-unread="${unread ? 'true' : 'false'}" role="option" tabindex="0"
             aria-selected="${selected ? 'true' : 'false'}">
      <div class="bulletin-card-head">
        <h3 class="bulletin-card-title">${escapeHTML(b.title)}</h3>
        ${badgeSpans(b)}
        <div class="bulletin-card-meta">
          ${userAvatarHtml({ name: author, avatarUrl: avatar, size: 'xs' })}
          <span>${escapeHTML(author)}</span>
          ${time ? `<span class="font-mono text-muted">${time}</span>` : ''}
        </div>
      </div>
      <div class="bulletin-card-body${longBody && !selected ? ' clamped' : ''}">${escapeHTML(b.content)}</div>
      ${longBody ? `
        <button type="button" data-bulletin-detail="${b.id}"
                class="btn-secondary py-1 px-2.5 text-[11px] mt-1.5 flex items-center gap-1">
          <i data-lucide="maximize-2" class="w-3 h-3"></i> 全文を読む
        </button>` : ''}
      ${attachmentsHtml(attachments)}
    </article>`;
}

/** JST 基準の投稿時刻 (HH:MM)。日付はカードリストの共通前提なので時刻だけ出す */
function timeOfJstLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const jst = new Date(d.getTime() + 9 * 3600000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}'''))

pairs.append(('bulletinList', '''  renderTitleColumn();
  renderDetailPane();
  refreshLucideIcons();''', '''  renderCards();
  refreshLucideIcons();'''))

pairs.append(('renderCards', '''/** 左列（タイトル行＋投稿日グループヘッダー）の描画 */
function renderTitleColumn() {
  const container = document.getElementById('bulletin-list-container');
  if (!container) return;

  const filtered = filteredBulletins();
  const countEl = document.getElementById('bulletin-title-count');
  if (countEl) countEl.textContent = `${filtered.length} 件`;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-10 text-xs text-muted bg-surface-soft rounded-xl border border-divider">
      選択した投稿日に掲示連絡はありません。<kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd> キーと左右の矢印ボタン（1日分）で移動できます。
    </div>`;
    refreshLucideIcons();
    return;
  }

  // 投稿日ごとにグループ化（選択日のみ表示 → ヘッダーは日付と件数）
  const groups = new Map();
  filtered.forEach(b => {
    const k = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at) || 'UNKNOWN';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  });

  const dayKeys = [...groups.keys()].sort().reverse();
  const parts = [];

  dayKeys.forEach(k => {
    const items = groups.get(k);
    if (k !== 'UNKNOWN') {
      parts.push(`
        <div class="bulletin-day-head sticky top-0 z-10 flex items-center gap-2 bg-surface-strong border border-divider rounded-lg px-3 py-1.5 text-[11px] font-bold text-main">
          <i data-lucide="calendar" class="w-3.5 h-3.5 text-accent"></i>
          <span>${k} (${weekdayLabel(k)}) ・ ${items.length} 件</span>
        </div>`);
    }
    parts.push(items.map(b => titleRowHtml(b, String(b.id) === String(selectedId))).join(''));
  });

  container.innerHTML = parts.join('');
  refreshLucideIcons();
}''', '''/** 記事カードリストの描画（日付・件数の欄は置かない。カードが記事単位で独立） */
function renderCards() {
  const container = document.getElementById('bulletin-card-list');
  if (!container) return;

  const filtered = filteredBulletins();
  if (filtered.length === 0) {
    container.innerHTML = `<div class="p-6 text-center text-xs text-muted bg-surface-strong border border-divider rounded-xl">
      <i data-lucide="calendar-off" class="w-7 h-7 mx-auto mb-2 opacity-60"></i>
      <div>この日の掲示連絡はありません。<kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd>・‹ › ボタンで前日・翌日、<kbd class="kbd-key">C</kbd> キーでカレンダーから任意日へ移動できます。</div>
    </div>`;
    refreshLucideIcons();
    return;
  }

  container.innerHTML = filtered.map((b) => articleCardHtml(b, String(b.id) === String(selectedId))).join('');
  refreshLucideIcons();
}'''))

for name, old, new in pairs:
    if old not in f:
        print('MISS', name)
    else:
        f = f.replace(old, new, 1)
        print('OK', name)

io.open(p, 'w', encoding='utf-8').write(f)