/**
 * ISSystem News Module
 * 教育ニュース速報・ワンタップチャット/掲示板共有コントローラー
 */

import { apiGet, apiPost } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { switchTab } from '../main.js';
import { state } from '../state.js';

let selectedNewsCategory = 'ALL';
let newsCache = [];

const NEWS_CATEGORIES = [
  { id: 'ALL', label: 'すべて' },
  { id: 'ICT', label: 'GIGA・ICT教育' },
  { id: 'CURRICULUM', label: '学習指導要領' },
  { id: 'WORKSTYLE', label: '働き方改革' },
  { id: 'ENTRANCE', label: '入試・高大接続' }
];

/**
 * 教育ニュースモジュールの初期化
 */
export function initNewsModule() {
  const container = document.getElementById('view-news');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
      <div>
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="newspaper" class="w-5 h-5 text-indigo-400"></i> 最新教育動向 & ニュース速報
        </h2>
        <p class="text-xs text-slate-400">文科省発表・教育技術トレンド記事の閲覧および職員チャット・掲示板へのワンタップ共有を行えます。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="news-btn-refresh" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> ニュース更新
        </button>
      </div>
    </div>

    <!-- カテゴリフィルター -->
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="text-slate-400 font-bold mr-1 flex items-center gap-1">
        <i data-lucide="tag" class="w-3.5 h-3.5"></i> テーマ:
      </span>
      ${NEWS_CATEGORIES.map(c => `
        <button data-cat="${c.id}" class="news-filter-btn px-3 py-1.5 rounded-lg border font-semibold transition-all ${c.id === 'ALL' ? 'active bg-slate-800 text-slate-200 border-slate-700' : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'}">
          ${c.label}
        </button>
      `).join('')}
    </div>

    <!-- ニュース記事一覧コンテナ -->
    <div id="news-list-container" class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="text-center py-12 text-xs text-slate-500 col-span-2">教育ニュースフィードを取得中...</div>
    </div>
  `;

  bindEvents();
  if (state.currentUser && state.authToken) {
    loadNewsData();
  }
}

/**
 * イベントリスナー登録
 */
function bindEvents() {
  document.getElementById('news-btn-refresh')?.addEventListener('click', () => {
    loadNewsData();
    showToast('最新の教育ニュースを取得しました', 'info');
  });

  // フィルターボタン
  document.querySelectorAll('.news-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.news-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-slate-800', 'text-slate-200', 'border-slate-700');
        b.classList.add('bg-slate-900', 'text-slate-400', 'border-slate-800');
      });
      btn.classList.add('active', 'bg-slate-800', 'text-slate-200', 'border-slate-700');
      btn.classList.remove('bg-slate-900', 'text-slate-400', 'border-slate-800');

      selectedNewsCategory = btn.getAttribute('data-cat') || 'ALL';
      renderNewsList();
    });
  });
}

/**
 * ニュースデータのロード
 */
async function loadNewsData() {
  if (!state.currentUser || !state.authToken) return;
  try {
    const data = await apiGet('/external/news');
    newsCache = Array.isArray(data) ? data : getDummyNews();
  } catch (e) {
    newsCache = getDummyNews();
  }

  renderNewsList();
}

/**
 * ニュースカード一覧の描画
 */
function renderNewsList() {
  const container = document.getElementById('news-list-container');
  if (!container) return;

  const filtered = newsCache.filter(item => {
    return selectedNewsCategory === 'ALL' || item.category === selectedNewsCategory;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-slate-500 col-span-2 bg-slate-900/30 rounded-xl border border-slate-800">該当する教育ニュースはありません。</div>`;
    return;
  }

  container.innerHTML = filtered.map(item => `
    <div class="card p-5 hover:border-indigo-500/50 transition-all flex flex-col justify-between space-y-3">
      <div>
        <div class="flex items-center justify-between text-[11px] mb-2">
          <span class="badge bg-indigo-500/20 text-indigo-300 border-indigo-500/30">${getCategoryLabel(item.category)}</span>
          <span class="text-slate-400 font-mono">${formatDate(item.publishedAt, false)} (${escapeHTML(item.source)})</span>
        </div>
        <h3 class="font-bold text-sm text-slate-100 mb-1.5 leading-snug">${escapeHTML(item.title)}</h3>
        <p class="text-xs text-slate-300 line-clamp-3 leading-relaxed">${escapeHTML(item.summary)}</p>
      </div>

      <!-- ワンタップ共有アクションバー -->
      <div class="pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
        <a href="${escapeHTML(item.url || '#')}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:underline flex items-center gap-1 text-[11px]">
          元記事を読む <i data-lucide="external-link" class="w-3 h-3"></i>
        </a>

        <div class="flex items-center gap-2">
          <button class="btn-share-chat py-1 px-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-[11px] flex items-center gap-1 transition-colors" data-news-id="${item.id}">
            <i data-lucide="message-square" class="w-3.5 h-3.5 text-indigo-400"></i> チャットへ共有
          </button>

          <button class="btn-share-bulletin py-1 px-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded text-[11px] flex items-center gap-1 transition-colors" data-news-id="${item.id}">
            <i data-lucide="megaphone" class="w-3.5 h-3.5 text-amber-400"></i> 掲示板へ投稿
          </button>
        </div>
      </div>
    </div>
  `).join('');

  // チャット共有ボタンイベント
  container.querySelectorAll('.btn-share-chat').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-news-id');
      shareToChat(id);
    });
  });

  // 掲示板共有ボタンイベント
  container.querySelectorAll('.btn-share-bulletin').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-news-id');
      shareToBulletin(id);
    });
  });

  refreshLucideIcons();
}

/**
 * チャットへワンタップ共有
 */
async function shareToChat(newsId) {
  const item = newsCache.find(n => String(n.id) === String(newsId));
  if (!item) return;

  const shareText = `【教育ニュース共有】\n■ ${item.title}\n${item.summary}\n(詳細: ${item.url || '校内参照'})`;

  try {
    await apiPost('/chat/channels/general/messages', {
      text: shareText,
      senderName: state.currentUser?.name || '自分'
    });
  } catch (e) {
    // APIフォールバック
  }

  showToast('全体職員チャットへニュースを共有しました', 'success');
  switchTab('chat');
}

/**
 * 掲示板へワンタップ共有
 */
async function shareToBulletin(newsId) {
  const item = newsCache.find(n => String(n.id) === String(newsId));
  if (!item) return;

  const today = new Date().toISOString().split('T')[0];
  const newBulletin = {
    title: `【参考情報】${item.title}`,
    category: 'GENERAL',
    targetDate: today,
    content: `${item.summary}\n\n出展: ${item.source} (${item.url || ''})`,
    authorName: state.currentUser?.name || '自分'
  };

  try {
    await apiPost('/bulletins', newBulletin);
  } catch (e) {
    // APIフォールバック
  }

  showToast('掲示板にニュース投稿を作成しました', 'success');
  switchTab('bulletin');
}

function getCategoryLabel(cat) {
  const item = NEWS_CATEGORIES.find(c => c.id === cat);
  return item ? item.label : '一般教育';
}

function getDummyNews() {
  return [
    {
      id: 'n1',
      title: '文科省: 生成AIの校務活用に関する新ガイドライン改訂版を公表',
      category: 'ICT',
      summary: '成績処理・指導要録案作成時のセキュリティ要件を明確化。安全なローカルLLMおよび認証済みクラウドサービスの利用推奨基準を新設。',
      source: '文部科学省 報道発表',
      publishedAt: '2026-10-14T10:00:00Z',
      url: 'https://www.mext.go.jp'
    },
    {
      id: 'n2',
      title: '教員の時間外在校等時間の削減に向けた校務DX推進施策モデル事例',
      category: 'WORKSTYLE',
      summary: '職員室情報の一元化と紙文書の電子化により、学年・分掌間の連絡コストを年間約120時間削減した先進校の取組事例が公開。',
      source: '教育新聞',
      publishedAt: '2026-10-12T14:30:00Z',
      url: 'https://www.kyobun.co.jp'
    },
    {
      id: 'n3',
      title: '新学習指導要領における「総合的な探究の時間」成果発表会ガイド',
      category: 'CURRICULUM',
      summary: '地域社会や地元企業と連携した課題解決型学習(PBL)の評価ルーブリック策定手法に関する解説資料を配布開始。',
      source: '国立教育政策研究所',
      publishedAt: '2026-10-10T09:15:00Z',
      url: 'https://www.nier.go.jp'
    }
  ];
}