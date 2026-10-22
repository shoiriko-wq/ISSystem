/**
 * ISSystem About Module
 * 「このプログラムについて」システム概要・技術スタック・メンテナンスガイドコントローラー
 */

import { apiGet, apiPost } from '../api.js';
import { escapeHTML, refreshLucideIcons, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

let activeSection = 'overview'; // 'overview' | 'tech' | 'maintenance' | 'trouble'

/**
 * システム情報モジュールの初期化
 */
export function initAboutModule() {
  const container = document.getElementById('view-about');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="badge badge-success">v2.5.0 Stable</span>
          <span class="text-xs text-slate-400 font-mono">Build 2026.10.15</span>
        </div>
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="info" class="w-5 h-5 text-indigo-400"></i> このプログラムについて (ISSystem Guide)
        </h2>
        <p class="text-xs text-slate-400">校内統合業務プラットフォームの技術スタック、システムアーキテクチャ、および運用・保守ガイド。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="about-btn-health" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
          <i data-lucide="activity" class="w-3.5 h-3.5 text-emerald-400"></i> ヘルスチェック
        </button>
      </div>
    </div>

    <!-- セクションナビゲーションタブ -->
    <div class="flex flex-wrap items-center gap-2 text-xs bg-slate-950/40 p-2 rounded-lg border border-slate-800">
      <button id="about-tab-overview" class="about-nav-btn px-3.5 py-1.5 rounded-lg font-bold transition-all border bg-slate-800 text-indigo-300 border-slate-700">
        <i data-lucide="layers" class="w-3.5 h-3.5 inline mr-1"></i> システム概要
      </button>
      <button id="about-tab-tech" class="about-nav-btn px-3.5 py-1.5 rounded-lg font-bold transition-all border bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200">
        <i data-lucide="code" class="w-3.5 h-3.5 inline mr-1"></i> 技術構成・仕様
      </button>
      <button id="about-tab-maintenance" class="about-nav-btn px-3.5 py-1.5 rounded-lg font-bold transition-all border bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200">
        <i data-lucide="wrench" class="w-3.5 h-3.5 inline mr-1"></i> 保守・バックアップ
      </button>
      <button id="about-tab-trouble" class="about-nav-btn px-3.5 py-1.5 rounded-lg font-bold transition-all border bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200">
        <i data-lucide="life-buoy" class="w-3.5 h-3.5 inline mr-1"></i> トラブルシューティング
      </button>
    </div>

    <!-- 1. システム概要セクション -->
    <div id="about-sec-overview" class="space-y-4">
      <div class="card p-5 space-y-3">
        <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
          <i data-lucide="shield-check" class="w-4 h-4 text-emerald-400"></i> ISSystem (Integrated School Support System) とは
        </h3>
        <p class="text-xs text-slate-300 leading-relaxed">
          ISSystem（統合校務支援システム）は、高等学校における教員の業務効率化、校内情報の一元化、および定期考査割当などの複雑な業務の自動最適化を目的として構築されたWebプラットフォームです。
          リアルタイムな職員チャット、施設・備品予約、掲示板連絡、物品購入申請から教務主任専用の考査自動最適化機能までシームレスに提供します。
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
          <div class="p-3 bg-slate-900/80 rounded-lg border border-slate-800 text-xs">
            <div class="font-bold text-indigo-400 mb-1 flex items-center gap-1.5">
              <i data-lucide="zap" class="w-4 h-4"></i> 高速・高応答UI
            </div>
            <p class="text-[11px] text-slate-400">SPA（シングルページアプリケーション）構成により、タブ切替や更新が瞬時に完了。</p>
          </div>
          <div class="p-3 bg-slate-900/80 rounded-lg border border-slate-800 text-xs">
            <div class="font-bold text-amber-400 mb-1 flex items-center gap-1.5">
              <i data-lucide="lock" class="w-4 h-4"></i> 権限分離設計
            </div>
            <p class="text-[11px] text-slate-400">一般教員モードと教務主任モードを即座に切り替え可能なロールベース制御。</p>
          </div>
          <div class="p-3 bg-slate-900/80 rounded-lg border border-slate-800 text-xs">
            <div class="font-bold text-emerald-400 mb-1 flex items-center gap-1.5">
              <i data-lucide="cpu" class="w-4 h-4"></i> 自動最適化ソルバー
            </div>
            <p class="text-[11px] text-slate-400">考査監督割り当ての重複や制約違反を数秒で最適化計算。</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 技術構成・仕様セクション -->
    <div id="about-sec-tech" class="space-y-4 hidden">
      <div class="card p-5 space-y-4">
        <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
          <i data-lucide="code" class="w-4 h-4 text-indigo-400"></i> システムアーキテクチャ & 技術スタック
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div class="p-4 bg-slate-900/90 rounded-xl border border-slate-800 space-y-2">
            <h4 class="font-bold text-slate-200 border-b border-slate-800 pb-1.5">フロントエンド (Client)</h4>
            <ul class="space-y-1.5 text-slate-300 font-mono text-[11px]">
              <li>・ Pure ES Modules (JavaScript ES2022)</li>
              <li>・ Tailwind CSS (Utility-First Styling)</li>
              <li>・ Lucide Icons (Dynamic Vector Icons)</li>
              <li>・ Custom Reactive State Manager</li>
            </ul>
          </div>
          <div class="p-4 bg-slate-900/90 rounded-xl border border-slate-800 space-y-2">
            <h4 class="font-bold text-slate-200 border-b border-slate-800 pb-1.5">バックエンド & REST API</h4>
            <ul class="space-y-1.5 text-slate-300 font-mono text-[11px]">
              <li>・ Node.js / Express RESTful API</li>
              <li>・ JWT (JSON Web Token) 認証</li>
              <li>・ In-Memory & Persistent Storage</li>
              <li>・ Web-Socket Ready Architecture</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. 保守・バックアップセクション -->
    <div id="about-sec-maintenance" class="space-y-4 hidden">
      <div class="card p-5 space-y-4">
        <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
          <i data-lucide="wrench" class="w-4 h-4 text-amber-400"></i> システムメンテナンスガイド
        </h3>

        <div class="space-y-3 text-xs">
          <div class="p-3 bg-slate-900 rounded-lg border border-slate-800">
            <h4 class="font-bold text-slate-200 mb-1">1. データバックアップ手順</h4>
            <p class="text-slate-400 mb-2">サーバー上のデータディレクトリを以下のコマンドで定期バックアップしてください。</p>
            <div class="bg-slate-950 p-2.5 rounded font-mono text-[11px] text-emerald-400 border border-slate-800">
              tar -czvf is-system-backup-$(date +%Y%m%d).tar.gz ./data
            </div>
          </div>

          <div class="p-3 bg-slate-900 rounded-lg border border-slate-800">
            <h4 class="font-bold text-slate-200 mb-1">2. サーバーキャッシュのクリア</h4>
            <p class="text-slate-400 mb-2">ローカルキャッシュおよびクライアントステートを手動クリアするコマンド:</p>
            <button id="about-btn-clear-cache" class="btn-secondary py-1 px-3 text-xs flex items-center gap-1 text-amber-300">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ローカルキャッシュをクリア
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. トラブルシューティングセクション -->
    <div id="about-sec-trouble" class="space-y-4 hidden">
      <div class="card p-5 space-y-3 text-xs">
        <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
          <i data-lucide="life-buoy" class="w-4 h-4 text-red-400"></i> トラブルシューティング & Q&A
        </h3>

        <div class="space-y-2">
          <div class="p-3 bg-slate-900/80 rounded-lg border border-slate-800">
            <span class="font-bold text-indigo-300">Q. 画面が正しく表示されない・アイコンが表示されない場合</span>
            <p class="text-slate-300 mt-1">A. ブラウザのキャッシュを再読み込み（Ctrl + F5 / Cmd + Shift + R）を実行してください。</p>
          </div>
          <div class="p-3 bg-slate-900/80 rounded-lg border border-slate-800">
            <span class="font-bold text-indigo-300">Q. 教務主任メニュー（定期考査）が表示されない</span>
            <p class="text-slate-300 mt-1">A. 右上の「教務モード」トグルをONに切り替えてください。一般教員権限時は非表示となります。</p>
          </div>
        </div>
      </div>
    </div>
  `;

  bindEvents();
}

/**
 * イベントリスナーのバインド
 */
function bindEvents() {
  const tabs = [
    { btnId: 'about-tab-overview', secId: 'about-sec-overview' },
    { btnId: 'about-tab-tech', secId: 'about-sec-tech' },
    { btnId: 'about-tab-maintenance', secId: 'about-sec-maintenance' },
    { btnId: 'about-tab-trouble', secId: 'about-sec-trouble' }
  ];

  tabs.forEach(t => {
    document.getElementById(t.btnId)?.addEventListener('click', () => {
      tabs.forEach(x => {
        const btn = document.getElementById(x.btnId);
        const sec = document.getElementById(x.secId);
        if (x.btnId === t.btnId) {
          btn?.classList.add('bg-slate-800', 'text-indigo-300', 'border-slate-700');
          btn?.classList.remove('bg-slate-900', 'text-slate-400', 'border-slate-800');
          sec?.classList.remove('hidden');
        } else {
          btn?.classList.remove('bg-slate-800', 'text-indigo-300', 'border-slate-700');
          btn?.classList.add('bg-slate-900', 'text-slate-400', 'border-slate-800');
          sec?.classList.add('hidden');
        }
      });
      refreshLucideIcons();
    });
  });

  // ヘルスチェックボタン
  document.getElementById('about-btn-health')?.addEventListener('click', async () => {
    try {
      await apiGet('/health');
      showToast('システム診断結果: すべてのAPIモジュールおよびDBサービスは正常稼働中です', 'success');
    } catch (e) {
      showToast('API通信に接続できません（フロントエンド独立デモモードで稼働中）', 'info');
    }
  });

  // キャッシュクリアボタン
  document.getElementById('about-btn-clear-cache')?.addEventListener('click', () => {
    if (confirm('ローカルの表示キャッシュをクリアして再読み込みしますか？')) {
      localStorage.clear();
      showToast('ローカルキャッシュを初期化しました', 'success');
      setTimeout(() => window.location.reload(), 1000);
    }
  });
}