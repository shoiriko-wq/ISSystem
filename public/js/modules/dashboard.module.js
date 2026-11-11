/**

 * ISSystem Dashboard Module

 * ダッシュボード描画・天気情報・統合サマリーコントローラー (本日の施設予約・行事表示完全対応版)

 */



import { apiGet, apiPost } from '../api.js';

import { escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, userAvatarHtml } from '../ui-helpers.js';

import { switchTab } from '../main.js';

import { state, subscribeState } from '../state.js';

import { loadAbsenceSummary, openAbsenceModal } from './absence.module.js';

import {
  bulletinsSnapshot, setBulletinCache, isUnreadForMe, isDisplayActiveOn,
  targetDayOf, markBulletinRead
} from './bulletin.module.js';

// ★ チャット投稿は撤廃（v3.1.7）: 「記事を共有」はピノックアップ教育ニュースへリンクを追加するだけなので、
//   chat.module.js を読み込まない（職員チャットへ投稿しない）。

/**
 * JST の時刻帯 (5段階) と季節 (6区分) を返す
 * @param {Date} now
 */
function dashTimeAndSeason(now = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', month: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const pick = (t) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  const hour = pick('hour');
  const month = pick('month');

  const slot = hour < 5 ? 'NIGHT' : hour < 11 ? 'MORNING' : hour < 13 ? 'NOON'
    : hour < 18 ? 'AFTERNOON' : hour < 22 ? 'EVENING' : 'NIGHT';

  const season = (month >= 3 && month <= 5) ? 'SPRING'
    : month === 6 ? 'RAIN'
    : month === 7 ? 'EARLY_SUMMER'
    : (month >= 8 && month <= 9) ? 'SUMMER'
    : (month === 10 || month === 11) ? 'AUTUMN'
    : 'WINTER';

  return { slot, season };
}

/** 時刻帯別の労いメッセージ（ほっこり・元気が出る声がけ） */
const DASH_TIME_MESSAGES = {
  MORNING:   '朝の光が職員室を明るく照らしています。今日の一日が笑顔で始まりますように。',
  NOON:      '昼の時間帯、温かい食事とひと息の休憩で心もほぐれますように。',
  AFTERNOON: '午後の時間、子どもたちの声に元気をもらいながら進んでいきましょう。',
  EVENING:   '今日一日、ありがとうございました。帰路はゆっくり歩いてリセットしましょう。',
  NIGHT:     '深夜の校務、温かい飲み物を置いて、体の休憩を最優先にしてください。',
};

/** 季節別の労いメッセージ */
const DASH_SEASON_MESSAGES = {
  SPRING:         '桜が舞う新年度、新しい出合いが花開く季節です。',
  RAIN:           '梅雨の合間に窓辺の緑を眺めて、一息のひとときをどうぞ。',
  EARLY_SUMMER:   '考査前の集中期、こまめな水分と深呼吸で乗り切りましょう。',
  SUMMER:         '吹き抜けの風と子どもたちの笑顔がまぶしい夏、涼しい教室で無理なく。',
  AUTUMN:         '実りの秋、行事で見せる子どもたちの成長に心があたたかくなります。',
  WINTER:         '冷えた指先、温かい飲み物で一息のひとときを。冬越えの体調管理を大切に。',
};

/** 曜日別の労いメッセージ（getDay() の 0=日曜〜6=土曜） */
const DASH_WEEK_MESSAGES = {
  0: '日曜は家族とゆっくり過ごし、校務は月曜で間に合います。',
  1: '月曜、今週の歩幅をゆっくり合わせてスタートしましょう。',
  2: '火曜、調子の整わない日もあります。今日着実に進みましょう。',
  3: '水曜、折り返し地点、給食後の一息がおすすめです。',
  4: '木曜、明日の準備を少し早めに、今日を大切に過ごしましょう。',
  5: '金曜、今週の一週間ありがとう。放課後は早めに切り上げましょう。',
  6: '土曜、部活動の笑顔に感謝する一日、無理のない範囲で。',
};

/** JST の曜日 (0=日曜〜6=土曜) を返す */
function dashWeekday(now = new Date()) {
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', weekday: 'short' }).format(now);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 1;
}

/** JST の MM-DD (ゼロ埋め) を返す。ゼロ埋め MM-DD の文字列比較は日付順と一致する */
function dashJstKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  return `${pick('month')}-${pick('day')}`;
}

/**
 * 特別な日（学校の節目・季節の節目）を「期間ウィンドウ」で保持する。
 * 始業式・終業式・仕事始め・新年度は年度によって平日がずれるため、from/to の期間で捕捉し
 * 同じ労い文を 3 日前後表示する（単日の項目は from === to）。
 * fx は粒子アニメーションテーマ。label はプレビューセレクト表示用。
 * 12/24–28 のように期間が重なる年は、先に定義した項目（クリスマス→第2学期終業式）を優先する。
 * 日付は概算（年により ± 日）。学校で運用時は .env ではなくこの表で調整する。
 */
const DASH_EVENT_PERIODS = [
  { key: '01-01..01-03', label: '年始 (1/1–1/3)', from: '01-01', to: '01-03', fx: 'newyear', msg: 'あけましておめでとうございます。新年のスタートは心軽く。' },
  { key: '01-05..01-06', label: '仕事始め (1/5–1/6)', from: '01-05', to: '01-06', fx: 'newyear', msg: '仕事始め、新年の挨拶から軽やかに一日を始めてください。' },
  { key: '01-07..01-09', label: '3学期始業式 (1/7–1/9)', from: '01-07', to: '01-09', fx: 'confetti', msg: '３学期始業式、学年の締めくくりが始まります。軽い歩幅で一日を過ごしましょう。' },
  { key: '03-23..03-24', label: '3学期終業式 (3/23–3/24)', from: '03-23', to: '03-24', fx: 'confetti', msg: '終業式、修了おめでとう。次の年度への準備の季節です。' },
  { key: '04-01..04-03', label: '新年度 (4/1–4/3)', from: '04-01', to: '04-03', fx: 'sakura', msg: '新年度スタート、新しい出合いが始まる日です。' },
  { key: '04-08..04-10', label: '1学期始業式 (4/8–4/10)', from: '04-08', to: '04-10', fx: 'sakura', msg: '第1学期始業式、新しい学期のスタートです。新しい声と新しい名簿に慣れる三日間です。' },
  { key: '07-17..07-20', label: '1学期終業式 (7/17–7/20)', from: '07-17', to: '07-20', fx: 'confetti', msg: '終業式、第1学期修了おめでとう。夏休みはチャージの時間です。' },
  { key: '09-01..09-03', label: '2学期始業式 (9/1–9/3)', from: '09-01', to: '09-03', fx: 'confetti', msg: '２学期始業式、子どもたちの声が学校に戻ってきます。' },
  { key: '12-23', label: 'クリスマスイブ前夜 (12/23)', from: '12-23', to: '12-23', fx: 'santa', msg: '明日はクリスマスイブ、校内の灯りがきらめく季節です。' },
  { key: '12-24', label: 'クリスマスイブ (12/24)', from: '12-24', to: '12-24', fx: 'santa', msg: 'ほら、クリスマスイブ。校内の灯りがきらめく季節です。' },
  { key: '12-25', label: 'クリスマス (12/25)', from: '12-25', to: '12-25', fx: 'santa', msg: 'クリスマス、子どもたちの笑顔が最高の贈り物です。' },
  { key: '12-26..12-28', label: '2学期終業式 (12/26–12/28)', from: '12-26', to: '12-28', fx: 'santa', msg: '終業式、第2学期修了おめでとう。冬休みはチャージの時間です。' },
  { key: '12-29..12-31', label: '年末・大掃除 (12/29–12/31)', from: '12-29', to: '12-31', fx: 'snow', msg: '一年の終わり、大掃除は全員協力のリズムで軽やかに。' },
];

/** 当日が属する特別な日期間を返す（該当なしは null）。単日項目は期間より先に評価する */
function dashEventPeriod(now = new Date()) {
  const key = dashJstKey(now);
  return DASH_EVENT_PERIODS.find((p) => (p.from === p.to ? p.from === key : p.from <= key && key <= p.to)) || null;
}

/** 特別な日の労いメッセージ。該当なしは null */
function dashEventMessage(now = new Date()) {
  return dashEventPeriod(now)?.msg || null;
}

/** プレビューセレクトが選んだキー（期間 key）から労いメッセージを返す */
function dashEventMessageByKey(key) {
  return DASH_EVENT_PERIODS.find((p) => p.key === key)?.msg || null;
}

/** 労いメッセージ枠の軽量粒子アニメーションテーマ (CSS keyframes のみ・Canvas 不使用) */
const DASH_FX = {
  sakura:    { motion: 'fall',    emojis: ['🌸', '🌸', '💮', '🌸', '🌺'] },
  rain:      { motion: 'rain', tilt: [14, 24], emojis: ['💧', '💧', '🌧️', '💧', '☂️'] },
  sun:       { motion: 'twinkle', emojis: ['✨', '🌞', '✨', '🕊️', '✨'] },
  sunhat:    { motion: 'twinkle', emojis: ['👒', '🌻', '✨', '🐚', '🍋'] },
  ocean:     { motion: 'twinkle', emojis: ['🌊', '🐠', '🩵', '🍉', '🐚'] },
  leaves:    { motion: 'fall',    emojis: ['🍁', '🍂', '🍁', '🌰', '🍄'] },
  snow:      { motion: 'fall',    emojis: ['❄️', '🌨️', '❄️', '⛄', '❄️'] },
  santa:     { motion: 'rise',    emojis: ['🎅', '🎄', '⛄', '🎁', '✨'] },
  halloween: { motion: 'rise',    emojis: ['🎃', '👻', '🍬', '🦇', '🕷️'] },
  newyear:   { motion: 'twinkle', emojis: ['🎍', '🗻', '✨', '🎴', '☺️'] },
  tanabata:  { motion: 'rise',    emojis: ['🎋', '🌙', '✨', '🌌', '🌠'] },
  confetti:  { motion: 'rise',    emojis: ['🎉', '🎊', '👏', '✨', '🌈'] },
  star:      { motion: 'twinkle', emojis: ['🌙', '✨', '⭐', '✨', '🌟'] },
};

/** 単日だけ有効な特別な日テーマ (mm-dd → theme)。期間ウィンドウの fx で補えない隙間日を表す */
const DASH_FX_SPECIAL = {
  '10-31': 'halloween',
  '07-07': 'tanabata',
  '01-04': 'newyear',
  '04-06': 'sakura',
};

/** 日付をシードにする決定論的乱数 (同日中は粒子配置が固定・翌日変化) */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 開発・QA 用プレビュー設定（労いカードの粒子アニメーションと労いメッセージを確認する。運用では使わない） */
const fxDevPreview = { fx: null, date: null, time: null, slot: null, week: null, season: null, evt: null, noEvent: null, message: null };

const FX_DEV_THEME_LABELS = {
  auto: '自動 (日時)', sakura: '桜', rain: '梅雨', sun: '陽光', sunhat: '日傘', ocean: '海',
  leaves: '紅葉', snow: '雪', santa: 'サンタ', halloween: 'ハロウィン', newyear: 'お正月',
  tanabata: '七夕', confetti: '紙吹雪', star: '夜の星',
};

/** 疑似日時を JST の Date として返す。日付未設定は null */
function fxDevNow() {
  if (!fxDevPreview.date) return null;
  const t = fxDevPreview.time || '12:00';
  const d = new Date(`${fxDevPreview.date}T${t}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 粒子の落下・上昇距離を労いカードの高さに合わせて --fx-drop に設定する */
function setDashFxDrop(layer) {
  const h = layer.offsetHeight;
  if (h > 0) layer.style.setProperty('--fx-drop', `${Math.round(h + 26)}px`);
}

/** 時刻・季節・特別な日（期間ウィンドウ）からアニメーションテーマを選ぶ (開発用 fxOverride があれば優先) */
function dashFxTheme(now = new Date(), fxOverride = null) {
  if (fxOverride) return fxOverride;
  const special = DASH_FX_SPECIAL[dashJstKey(now)] || null;
  if (special) return special;
  const period = dashEventPeriod(now);
  if (period?.fx) return period.fx;
  const { slot, season } = dashTimeAndSeason(now);
  if (slot === 'NIGHT') return 'star';
  return { SPRING: 'sakura', RAIN: 'rain', EARLY_SUMMER: 'sun', SUMMER: 'ocean', AUTUMN: 'leaves', WINTER: 'snow' }[season];
}

/** 労いメッセージ枠の粒子を描画する (#dash-fx-layer / CSS keyframes が毎フレーム動かす)
 *  落下系・上昇系は CSS が上端/下端に置き、--fx-drop（カード高さ実測）で枠全体を移動する。
 *  瞬き系（陽光・日傘・海・お正月・夜の星）は枠全体に広がるよう、粒子 i（0〜9）ごとに inline の top を
 *  4% + i*7% + 0〜5%（＝4〜72%）で振る。帯分かれなので必ず枠全体へ広がり、下半分にも粒子が出る。
 *  4〜72% は絵文字の高さ（最大26px）と keyframes の translateY(10px) を引いた安全域で、粒子は枠の内側に収まる。 */
function renderDashFx(now = new Date(), fxOverride = null) {
  const layer = document.getElementById('dash-fx-layer');
  if (!layer) return;
  const theme = dashFxTheme(now, fxOverride);
  const def = DASH_FX[theme] || DASH_FX.star;
  const rnd = mulberry32(Math.floor(now.getTime() / 86400000) + 1);
  layer.className = `dash-fx-layer fx-${def.motion}`;
  layer.dataset.fxTheme = theme;
  let html = '';
  for (let i = 0; i < 10; i++) {
    const emoji = def.emojis[i % def.emojis.length];
    const x = 3 + rnd() * 94;
    // 瞬き系は縦位置を帯で分けて粒子ごとに決める（枠全体に必ず広がる）。落下系・上昇系は CSS の top/bottom を使うので rnd を使わない
    const y = def.motion === 'twinkle' ? 4 + i * 7 + rnd() * 5 : null;
    const dur = 6 + rnd() * 6;
    const delay = rnd() * 9;
    const size = 12 + Math.round(rnd() * 14);
    // 降り注ぎ系 (梅雨) は傾き角を粒子ごとに 14〜24deg で決める。角度は進行中に変わらない（keyframes に回転はない）
    const tilt = def.tilt ? Math.round(def.tilt[0] + rnd() * (def.tilt[1] - def.tilt[0])) : 0;
    const topCss = y === null ? '' : `top:${y.toFixed(1)}%;`;
    html += `<span class="dash-fx" style="left:${x.toFixed(1)}%;${topCss}animation-duration:${dur.toFixed(1)}s;animation-delay:-${delay.toFixed(1)}s;font-size:${size}px;--fx-tilt:${tilt}deg">${emoji}</span>`;
  }
  layer.innerHTML = html;
  setDashFxDrop(layer);
}

/**
 * 挨拶文と労いのメッセージを時刻・曜日・季節に応じて描画する (#dash-greeting / #dash-warm-message)
 * @param {Date} now
 */
function renderDashGreeting(now = new Date()) {
  const nameEl = document.getElementById('dash-user-name');
  if (!nameEl) return;

  const sim = fxDevNow() || now;
  const auto = dashTimeAndSeason(sim);
  const slot = fxDevPreview.slot || auto.slot;
  const season = fxDevPreview.season || auto.season;
  const cu = state.currentUser;
  const name = cu?.name ? String(cu.name) : '先生';
  nameEl.textContent = `${name} 先生`;

  const h2 = document.getElementById('dash-greeting');
  if (h2) {
    h2.innerHTML = `お疲れ様です、<span id="dash-user-name" class="text-primary font-bold">${escapeHTML(name)} 先生</span>`;
  }

  // 時刻帯・曜日・季節（特別な日は期間ウィンドウの文を優先）を組み合わせた労いのメッセージ
  const wd = fxDevPreview.week ?? dashWeekday(sim);
  // 季節セレクトで季節を明示した時は特別な日の文を抑え、季節文を確実に表示する
  const evt = (fxDevPreview.season || fxDevPreview.noEvent) ? null
    : (fxDevPreview.evt ? dashEventMessageByKey(fxDevPreview.evt) : dashEventMessage(sim));
  const msgEl = document.getElementById('dash-warm-message');
  if (msgEl) {
    msgEl.textContent = fxDevPreview.message || `${DASH_TIME_MESSAGES[slot]} ${DASH_WEEK_MESSAGES[wd]} ${evt ?? DASH_SEASON_MESSAGES[season]}`;
  }

  // 労いメッセージ枠の軽量粒子アニメーション (時刻・季節・特別な日でテーマ切替)
  renderDashFx(sim, fxDevPreview.fx);
}



/**

 * ダッシュボードのHTMLスケルトン生成と初期描画

 */

export function initDashboardModule() {

  const container = document.getElementById('view-dashboard');

  if (!container) return;



  container.innerHTML = `

    <!-- 1. ウェルカムバナー & サマリーカード群 -->

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">

      <!-- 上段3カード（労い・年休等・出張・要対応タスク）は「面」＝カード自体はクリックできない。
           card--static で指カーソル・ホバーリング・浮き上がり等のクリック誘導効果を付けない
           （readability.css 第9節/第10節）。カード内の role="button" タイル（年休等・出張）と
           「承認依頼一覧へ」ボタンはクリック可能なので従来どおり pointer + リングが出る。 -->
      <div class="card card--framed card--static p-5 bg-gradient-to-br from-accent-soft via-surface-soft to-surface-strong border-accent-soft md:col-span-2 flex flex-col justify-between dash-fx-card">

        <div id="dash-fx-layer" class="dash-fx-layer" aria-hidden="true"></div>

        <div>

          <h2 class="text-xl font-bold text-main mb-1" id="dash-greeting">お疲れ様です、<span id="dash-user-name" class="text-primary font-bold">先生</span></h2>

          <p id="dash-warm-message" class="text-sm text-soft leading-relaxed">

            先生方、いつもありがとう。今日も無理なく、笑顔の一日を。

          </p>

        </div>

      </div>



      <!-- 本日の 年休等・出張 (区分別人数タイルをクリックして登録・確認モーダルを開く。記入フォームはモーダル内に常設) -->
      <!-- 見出しと区分別タイルの間の余白を消す: justify-between を撤去し、タイル群 (flex-1) がカード残高を満たす -->

      <div class="card card--framed card--static p-4 flex flex-col">

        <div class="flex items-center justify-between text-sm text-muted mb-2">

          <span class="font-bold text-main">年休等・出張</span>

          <i data-lucide="calendar-x-2" class="w-4 h-4 text-danger"></i>

        </div>

        <!-- 区分別人数 (absence.module.js の renderAbsenceCounts が数値を流し込む)
             配色は登録・確認モーダル（index.html の区分別人数サマリー）と同一トークン:
             年休等 = 赤系 (bg-danger-soft / border-danger-soft / text-danger)
             出張   = 黄系 (bg-warning-soft / border-warning-soft / text-warning) -->
        <div class="grid grid-cols-2 gap-2 flex-1 items-stretch">
          <div id="dash-absence-leave-tile" role="button" tabindex="0"
               class="flex flex-col items-center justify-center gap-1 py-2.5 px-0 rounded-lg bg-danger-soft border border-danger-soft cursor-pointer transition hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-danger"
               title="クリックして本日の「年休等」の詳細リストと記入フォームを開く">
            <div class="flex items-center gap-1.5 text-danger text-xs font-bold whitespace-nowrap">
              <i data-lucide="bed-double" class="w-3.5 h-3.5 shrink-0"></i>
              <span>年休等</span>
            </div>
            <span id="dash-absence-leave" class="text-xl font-black text-danger leading-none">0名</span>
          </div>
          <div id="dash-absence-trip-tile" role="button" tabindex="0"
               class="flex flex-col items-center justify-center gap-1 py-2.5 px-0 rounded-lg bg-warning-soft border border-warning-soft cursor-pointer transition hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-warning"
               title="クリックして本日の「出張」の詳細リストと記入フォームを開く">
            <div class="flex items-center gap-1.5 text-warning text-xs font-bold whitespace-nowrap">
              <i data-lucide="briefcase" class="w-3.5 h-3.5 shrink-0"></i>
              <span>出張</span>
            </div>
            <span id="dash-absence-trip" class="text-xl font-black text-warning leading-none">0名</span>
          </div>
        </div>
      </div>



      <!-- 未処理タスク・承認サマリー -->

      <div class="card card--framed card--static p-4 flex flex-col justify-between">

        <div class="flex items-center justify-between text-xs text-muted mb-2">

          <span class="font-bold text-main">要対応タスク</span>

          <i data-lucide="check-square" class="w-4 h-4 text-warning"></i>

        </div>

        <div class="space-y-2 text-xs my-1">

          <div class="flex justify-between items-center p-2 rounded bg-surface-strong border border-divider">

            <span class="text-soft">未処理の承認・請求:</span>

            <span class="font-bold text-warning" id="dash-pending-approvals">0件</span>

          </div>

          <div class="flex justify-between items-center p-2 rounded bg-surface-strong border border-divider">

            <span class="text-soft">掲示板 未読連絡（全日）:</span>

            <span class="font-bold text-accent" id="dash-unread-bulletins">0件</span>

          </div>

        </div>

        <button id="dash-btn-approval" class="text-[11px] text-warning hover-text-warning-strong font-semibold text-right flex items-center justify-end gap-1 mt-1">

          承認依頼一覧へ <i data-lucide="chevron-right" class="w-3 h-3"></i>

        </button>

      </div>

    </div>



    <!-- 2. 主要グリッドコンテンツ -->

    <div class="dashboard-grid mt-6">

      

      <!-- 左カラム : 重要掲示板 & 教育ニュースサマリー -->

      <div class="dash-col-main space-y-6">

        <!-- 本日の優先・重要連絡 -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-4">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="megaphone" class="w-4 h-4 text-accent"></i> 本日の連絡

            </h3>

            <!-- v3.1: 本日未読バッヂ（対象日が本日かつ未読。カードクリックで即減る） -->
            <span id="dash-today-bulletin-unread" class="dash-today-unread-badge hidden" aria-label="本日の未読連絡数">未読 0</span>

          </div>

          <div id="dash-pinned-bulletins" class="dash-news-list">

            <div class="text-sm text-muted py-4 text-center">読み込み中...</div>

          </div>

        </div>



        <!-- 最新教育ニュース速報 統合ウィジェット -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-4">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="newspaper" class="w-4 h-4 text-accent"></i> ピックアップ教育ニュース

            </h3>

            <button type="button" id="dash-btn-news-share" class="btn-secondary py-1 px-2.5 text-sm shrink-0 flex items-center gap-1.5" title="記事URLをピノックアップ教育ニュースへ共有（リンク追加）">
              <i data-lucide="share-2" class="w-3.5 h-3.5"></i> 記事を共有
            </button>

          </div>

          <div id="dash-news-summary" class="grid grid-cols-1 md:grid-cols-2 gap-3">

            <div class="text-xs text-muted py-4 text-center col-span-2">ニュースを取得中...</div>

          </div>

        </div>

      </div>



      <!-- 右カラム : 本日の施設予約 & 校内スケジュール -->

      <div class="dash-col-side space-y-6">

        <!-- 本日の施設物品予約（その日の予約を実データから一覧。行クリックで施設タブへ） -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-3">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="building-2" class="w-4 h-4 text-success"></i>
              本日の施設物品予約
              <span id="dash-facility-count" class="dash-facility-count">0 件</span>

            </h3>

            <button type="button" id="dash-btn-facility" class="btn-secondary py-1 px-2.5 text-sm shrink-0">予約する</button>

          </div>

          <div id="dash-today-facilities" class="dash-facility-list">

            <div class="dash-facility-empty">読み込み中...</div>

          </div>

        </div>



        <!-- 本日の校内スケジュール -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-3">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="calendar" class="w-4 h-4 text-accent-alt"></i> 本日の校内行事

            </h3>

            <button id="dash-btn-schedule" class="text-xs text-accent-alt hover:underline">カレンダー</button>

          </div>

          <div id="dash-today-schedules" class="space-y-2 text-xs">

            <div class="text-muted py-2 text-center">本日の行事は登録されていません</div>

          </div>

        </div>

      </div>

    </div>

    <!-- 開発・QA 用プレビューパネル（労いカードの粒子アニメーションと教員への労いメッセージを確認するバー。運用では使わない） -->
    <div id="dash-fx-dev-panel" class="card card--framed p-3 mt-4 flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="dash-fx-dev-toggle" class="btn-secondary py-1 px-2.5 text-xs flex items-baseline gap-1.5" aria-expanded="true" aria-controls="dash-fx-dev-body" title="開発用プレビューパネルを開閉する">
          <i data-lucide="wand-2" class="w-3.5 h-3.5 shrink-0"></i> <span class="pt-0.5">労いプレビュー</span>
        </button>
        <label class="text-[10px] text-muted" for="fxp-theme">アニメーション</label>
        <select id="fxp-theme" class="input-field py-1 px-2 text-xs" title="労いカードの粒子アニメーションのテーマ">
          <option value="auto">自動 (日時)</option>
          <option value="sakura">桜</option>
          <option value="rain">梅雨</option>
          <option value="sun">陽光</option>
          <option value="sunhat">日傘</option>
          <option value="ocean">海</option>
          <option value="leaves">紅葉</option>
          <option value="snow">雪</option>
          <option value="santa">サンタ</option>
          <option value="halloween">ハロウィン</option>
          <option value="newyear">お正月</option>
          <option value="tanabata">七夕</option>
          <option value="confetti">紙吹雪</option>
          <option value="star">夜の星</option>
        </select>
        <button type="button" id="fxp-prev" class="btn-secondary py-1 px-2 text-xs flex items-baseline gap-1" title="前のテーマへ切り替える">
          <i data-lucide="chevron-left" class="w-3.5 h-3.5 shrink-0"></i> <span class="pt-0.5">前</span>
        </button>
        <button type="button" id="fxp-next" class="btn-secondary py-1 px-2 text-xs flex items-baseline gap-1" title="次のテーマへ切り替える">
          <i data-lucide="chevron-right" class="w-3.5 h-3.5 shrink-0"></i> <span class="pt-0.5">次</span>
        </button>
        <span class="fxp-note ml-auto">アニメーションと教員への労いメッセージを確認する開発・QA 用パネル（運用では使わない）</span>
      </div>
      <div id="dash-fx-dev-body" class="flex flex-wrap items-end gap-2.5">
        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-muted" for="fxp-date">疑似日付</label>
          <input type="date" id="fxp-date" class="input-field py-1 px-2 text-xs w-28" title="労いメッセージと季節アニメーションの疑似日付 (JST)">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-muted" for="fxp-time">疑似時刻</label>
          <input type="time" id="fxp-time" class="input-field py-1 px-2 text-xs w-24" title="労いメッセージの疑似時刻 (JST)">
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-muted" for="fxp-slot">時刻帯</label>
          <select id="fxp-slot" class="input-field py-1 px-2 text-xs" title="労いメッセージの時刻帯">
            <option value="">自動</option>
            <option value="MORNING">朝</option>
            <option value="NOON">昼</option>
            <option value="AFTERNOON">午後</option>
            <option value="EVENING">夕方</option>
            <option value="NIGHT">深夜</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-muted" for="fxp-week">曜日</label>
          <select id="fxp-week" class="input-field py-1 px-2 text-xs" title="労いメッセージの曜日">
            <option value="">自動</option>
            <option value="0">日曜</option>
            <option value="1">月曜</option>
            <option value="2">火曜</option>
            <option value="3">水曜</option>
            <option value="4">木曜</option>
            <option value="5">金曜</option>
            <option value="6">土曜</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-muted" for="fxp-season">季節</label>
          <select id="fxp-season" class="input-field py-1 px-2 text-xs" title="労いメッセージの季節">
            <option value="">自動</option>
            <option value="SPRING">春</option>
            <option value="RAIN">梅雨</option>
            <option value="EARLY_SUMMER">初夏</option>
            <option value="SUMMER">夏</option>
            <option value="AUTUMN">秋</option>
            <option value="WINTER">冬</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[10px] text-muted" for="fxp-event">特別な日</label>
          <select id="fxp-event" class="input-field py-1 px-2 text-xs" title="特別な日の労いメッセージ（期間ウィンドウ）">
            <option value="">自動 (日付)</option>
            <option value="none">なし (季節文)</option>
          </select>
        </div>
        <div id="fxp-swatches" class="flex flex-wrap items-center gap-1.5 text-base leading-none" title="全テーマの粒子（静的表示）"></div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-[10px] text-muted" for="fxp-message">全メッセージ</label>
        <select id="fxp-message" class="input-field py-1 px-2 text-xs" title="労いメッセージ文を選んで表示する">
          <option value="">メッセージを選ぶ</option>
        </select>
        <button type="button" id="fxp-reset" class="btn-secondary py-1 px-2.5 text-xs flex items-baseline gap-1.5" title="実日時と自動テーマへ復帰する">
          <i data-lucide="rotate-ccw" class="w-3.5 h-3.5 shrink-0"></i> <span class="pt-0.5">復帰</span>
        </button>
      </div>
    </div>

  `;



  bindDashboardEvents();

  bindDashFxDevPanel();

  bindNewsShareForm();



  if (state.currentUser || state.authToken) {

    loadDashboardData();

    fetchWeatherData();

  }

  // 1分ごとに挨拶文を再評価 (時刻帯・季節の変化を反映)

  setInterval(() => {

    renderDashGreeting();

    refreshLucideIcons();

  }, 60 * 1000);

}



/**

 * ボタンクリック等のイベントバインディング

 */

function bindDashboardEvents() {


  document.getElementById('dash-btn-approval')?.addEventListener('click', () => switchTab('approval'));

  // v3.1「本日の連絡」カード = 施設予約 (data-facility-open) と同じ button 慣習。
  // クリックは PUT /api/bulletins/:id/read のみ。タブ移動もモーダルも開かない。既読カードは API を叩かない（冪等）
  document.getElementById('dash-pinned-bulletins')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bulletin-read]');
    if (!btn) return;
    const id = btn.getAttribute('data-bulletin-read');
    const item = bulletinsSnapshot().find((b) => String(b.id) === String(id));
    if (!item) return;
    if (isUnreadForMe(item)) markBulletinRead(id);
    renderDashTodayBulletins();
  });

  // 未読バッヂ追従（全日ラベル・本日バッヂ・カードの未読マーカー）。DOM 書き出しの本体は main.js の subscribeState
  subscribeState((s, key) => {
    if (key !== 'unreadCounts') return;
    const fullEl = document.getElementById('dash-unread-bulletins');
    if (fullEl) fullEl.textContent = `${s.unreadCounts.bulletin}件`;
    renderDashTodayBulletins();
  });

  document.getElementById('dash-btn-news-share')?.addEventListener('click', () => openNewsShareModal());

  document.getElementById('dash-btn-facility')?.addEventListener('click', () => switchTab('facility'));

  document.getElementById('dash-btn-schedule')?.addEventListener('click', () => switchTab('schedule'));

}

/**
 * 開発・QA 用プレビューパネル (#dash-fx-dev-panel) のバインディング。
 * 労いカードの粒子アニメーションと教員への労いメッセージをダッシュボード最下部で確認する（運用では使わない）。
 * 疑似日時・時刻帯・曜日・季節・特別な日は労いカードの表示ロジックだけに影響し、実 API 呼び出しは変更しない。
 */
function bindDashFxDevPanel() {
  const themeSel = document.getElementById('fxp-theme');
  const slotSel = document.getElementById('fxp-slot');
  const weekSel = document.getElementById('fxp-week');
  const seasonSel = document.getElementById('fxp-season');
  const evtSel = document.getElementById('fxp-event');
  const msgSel = document.getElementById('fxp-message');
  const dateInput = document.getElementById('fxp-date');
  const timeInput = document.getElementById('fxp-time');
  const themeKeys = ['auto', ...Object.keys(DASH_FX)];

  const apply = () => {
    renderDashGreeting();
    refreshLucideIcons();
  };

  // 全テーマの粒子を静的スウォッチで並べる (prefers-reduced-motion では粒子レイヤーが消えるため、ここでテーマを確認する)
  const swatches = document.getElementById('fxp-swatches');
  if (swatches) {
    swatches.innerHTML = Object.entries(DASH_FX)
      .map(([key, def]) => `<span title="${key} : ${FX_DEV_THEME_LABELS[key] || key}">${def.emojis[0]}</span>`)
      .join('');
  }

  // 特別な日セレクトは期間ウィンドウ表から生成する（労いカードの表示ロジックと单一来源。運用では使わない）
  if (evtSel) {
    evtSel.innerHTML = '<option value="">自動 (日付)</option><option value="none">なし (季節文)</option>'
      + DASH_EVENT_PERIODS.map((p) => `<option value="${escapeHTML(p.key)}">${escapeHTML(p.label)}</option>`).join('');
  }

  // 労いメッセージ文を一覧から直接選べる (時刻帯・曜日・季節・特別な日の全メッセージ)
  if (msgSel) {
    const groups = [
      ['時刻帯', Object.entries(DASH_TIME_MESSAGES)],
      ['曜日', Object.entries(DASH_WEEK_MESSAGES)],
      ['季節', Object.entries(DASH_SEASON_MESSAGES)],
      ['特別な日', DASH_EVENT_PERIODS.map((p) => [p.key, p.msg])],
    ];
    let html = '<option value="">メッセージを選ぶ</option>';
    for (const [glabel, table] of groups) {
      html += `<optgroup label="${glabel}">`;
      for (const [key, text] of table) {
        html += `<option value="${escapeHTML(text)}">${glabel} ${escapeHTML(String(key))}: ${escapeHTML(text.slice(0, 14))}…</option>`;
      }
      html += '</optgroup>';
    }
    msgSel.innerHTML = html;
  }

  themeSel?.addEventListener('change', () => {
    fxDevPreview.fx = themeSel.value === 'auto' ? null : themeSel.value;
    apply();
  });

  const cycleTheme = (dir) => {
    const idx = (themeKeys.indexOf(themeSel ? themeSel.value : 'auto') + dir + themeKeys.length) % themeKeys.length;
    if (themeSel) themeSel.value = themeKeys[idx];
    fxDevPreview.fx = themeKeys[idx] === 'auto' ? null : themeKeys[idx];
    apply();
  };
  document.getElementById('fxp-prev')?.addEventListener('click', () => cycleTheme(-1));
  document.getElementById('fxp-next')?.addEventListener('click', () => cycleTheme(1));

  dateInput?.addEventListener('change', () => {
    fxDevPreview.date = dateInput.value || null;
    fxDevPreview.evt = null;
    fxDevPreview.noEvent = null;
    fxDevPreview.message = null;
    if (evtSel) evtSel.value = '';
    if (msgSel) msgSel.value = '';
    apply();
  });

  timeInput?.addEventListener('change', () => {
    fxDevPreview.time = timeInput.value || null;
    fxDevPreview.message = null;
    if (msgSel) msgSel.value = '';
    apply();
  });

  slotSel?.addEventListener('change', () => {
    fxDevPreview.slot = slotSel.value || null;
    fxDevPreview.message = null;
    if (msgSel) msgSel.value = '';
    apply();
  });

  weekSel?.addEventListener('change', () => {
    fxDevPreview.week = weekSel.value === '' ? null : Number(weekSel.value);
    fxDevPreview.message = null;
    if (msgSel) msgSel.value = '';
    apply();
  });

  seasonSel?.addEventListener('change', () => {
    fxDevPreview.season = seasonSel.value || null;
    fxDevPreview.evt = null;
    fxDevPreview.noEvent = null;
    fxDevPreview.message = null;
    if (evtSel) evtSel.value = '';
    if (msgSel) msgSel.value = '';
    apply();
  });

  evtSel?.addEventListener('change', () => {
    fxDevPreview.evt = evtSel.value && evtSel.value !== 'none' ? evtSel.value : null;
    fxDevPreview.noEvent = evtSel.value === 'none' ? true : null;
    fxDevPreview.season = null;
    fxDevPreview.message = null;
    if (seasonSel) seasonSel.value = '';
    if (msgSel) msgSel.value = '';
    apply();
  });

  msgSel?.addEventListener('change', () => {
    fxDevPreview.message = msgSel.value || null;
    apply();
  });

  // 復帰 (実日時・自動テーマへ戻す)
  document.getElementById('fxp-reset')?.addEventListener('click', () => {
    fxDevPreview.fx = null;
    fxDevPreview.date = null;
    fxDevPreview.time = null;
    fxDevPreview.slot = null;
    fxDevPreview.week = null;
    fxDevPreview.season = null;
    fxDevPreview.evt = null;
    fxDevPreview.noEvent = null;
    fxDevPreview.message = null;
    if (themeSel) themeSel.value = 'auto';
    if (slotSel) slotSel.value = '';
    if (weekSel) weekSel.value = '';
    if (seasonSel) seasonSel.value = '';
    if (evtSel) evtSel.value = '';
    if (msgSel) msgSel.value = '';
    if (dateInput) dateInput.value = '';
    if (timeInput) timeInput.value = '';
    apply();
    showToast('労いプレビューを実日時に復帰しました', 'info');
  });

  // 開閉 (折りたたまれるとコントロールバーだけが残る)
  const toggle = document.getElementById('dash-fx-dev-toggle');
  const body = document.getElementById('dash-fx-dev-body');
  toggle?.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    if (body) body.classList.toggle('hidden', !expanded);
    refreshLucideIcons();
  });

  // 労いカードの高さを計測して粒子の落下・上昇距離 (--fx-drop) を更新する
  const fxLayer = document.getElementById('dash-fx-layer');
  if (fxLayer) {
    setDashFxDrop(fxLayer);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => setDashFxDrop(fxLayer)).observe(fxLayer);
    }
  }
}



/** JST の本日キー (YYYY-MM-DD) */
function dashTodayKey() {

  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

}

/**
 * 「本日の連絡」カード群の描画（対象日が本日の掲示だけを既読・未読問わず提示。未読カードに未読マーカーを出す）
 * カードは button。クリックは PUT /api/bulletins/:id/read のみ（タブ移動・モーダルなし、既読カードは冪等）。
 * 掲示期間が有効（開始日未設定/≦本日、終了日未設定/≧本日）な物だけ対象日マッチさせる
 */
function renderDashTodayBulletins() {

  const listEl = document.getElementById('dash-pinned-bulletins');

  if (!listEl) return;

  const today = dashTodayKey();

  const todays = bulletinsSnapshot()

    .filter((b) => targetDayOf(b) === today && isDisplayActiveOn(b, today))

    .sort((a, b) => {

      const ta = String(a.postedAt || a.posted_at || a.createdAt || a.created_at || '');

      const tb = String(b.postedAt || b.posted_at || b.createdAt || b.created_at || '');

      if (ta < tb) return 1;

      if (ta > tb) return -1;

      return 0;

    });

  if (todays.length === 0) {

    listEl.innerHTML = '<p class="text-sm text-muted text-center py-2">本日の連絡はありません。</p>';

    return;

  }

  listEl.innerHTML = todays.map((b) => {

    const author = b.authorName || b.author_name || '教員';

    const avatarUrl = b.authorAvatar || b.author_avatar || null;

    const unread = isUnreadForMe(b);

    const title = escapeHTML(String(b.title || ''));

    return `

      <button type="button" class="dash-news-item" data-bulletin-read="${b.id}"

              title="${unread ? 'クリックで既読をつける' : '既読済み'}"

              aria-label="${title}（${unread ? '未読' : '既読'}・クリックで既読をつける）">

        <span class="dash-news-head">

          <span class="dash-news-title">${title}</span>

          ${unread ? '<span class="dash-news-unread-marker">未読</span>' : ''}

          <span class="dash-news-author">

            ${userAvatarHtml({ name: author, avatarUrl, size: 'xs' })}

            <span class="dash-news-author-name">${escapeHTML(author)} 教員</span>

          </span>

        </span>

        <span class="dash-news-body">${escapeHTML(String(b.content || ''))}</span>

      </button>

    `;

  }).join('');

  refreshLucideIcons();

}



/**

 * ダッシュボード表示用データの取得と描画

 */

export async function loadDashboardData() {

  // ユーザー名表示更新

  const userEl = document.getElementById('dash-user-name');

  if (userEl && state.currentUser) {

    userEl.textContent = `${state.currentUser.name || state.currentUser.id} 先生`;

  }

  // 時刻と季節に合わせた挨拶を再生成 (深夜・朝・夕方、季節ごとの状況案内)

  renderDashGreeting();



  // 1. 掲示一覧の取得（キャッシュは bulletin.module.js と共有し、未読バッヂを再計算する）
  //    「本日の連絡」は対象日が本日の掲示だけを既読・未読問わず提示し、未読カードに未読マーカーを出す
  try {

    const res = await apiGet('/bulletins', { limit: 100 });

    const bulletins = res.bulletins || (Array.isArray(res) ? res : []);

    setBulletinCache(bulletins);

    renderDashTodayBulletins();

  } catch (e) {

    console.warn('[Dashboard] 掲示一覧の取得に失敗:', e.message);

    setBulletinCache([]);

    const listEl = document.getElementById('dash-pinned-bulletins');

    if (listEl) {

      listEl.innerHTML = `

        <div class="p-3 rounded-lg bg-surface-strong border border-divider">

          <div class="flex items-center justify-between text-[11px] mb-1">

            <span class="badge badge-warning">指示・依頼</span>

            <span class="text-muted font-mono">08:30 (教務部)</span>

          </div>

          <h4 class="font-bold text-xs text-main mb-1">【重要】中間考査問題の提出期限について</h4>

          <p class="text-[11px] text-muted">各教科担当の先生方は、本日17時までに教務システムへアップロードをお願いします。</p>

        </div>

      `;

    }

  }



  // ★ 2. ピノックアップ教育ニュース（共有リンク news_links）
  //    「記事を共有」で追加した記事だけを並べる（チャット投稿は撤廃済み＝v3.1.7）
  await loadSharedNewsLinks();

  // ★ 3. 本日の施設物品予約（daily-overview は施設単位のグループ { facility, reservations } を返す。
  //   予約だけをフラット化して開始時間順に並べ、行クリックで施設タブへ飛べるようにする）

  const todayStr = new Date().toISOString().split('T')[0];

  const facEl = document.getElementById('dash-today-facilities');

  if (facEl) {

    try {

      const res = await apiGet('/facilities/daily-overview', { date: todayStr });

      const groups = res.facilitiesOverview || res.data || res.reservations || (Array.isArray(res) ? res : []);

      const todayRes = [];
      for (const g of (groups || [])) {
        const facName = g.facility?.name || g.facility_name || g.name || '施設';
        const list = Array.isArray(g.reservations) ? g.reservations : (g && g.start_time ? [g] : []);
        for (const r of list) {
          if (!r) continue;
          todayRes.push({ ...r, facilityName: facName });
        }
      }

      const countEl = document.getElementById('dash-facility-count');
      if (countEl) countEl.textContent = `${todayRes.length} 件`;

      const timeOf = (t) => {
        const raw = String(t || '').replace('T', ' ');
        const hhmm = (raw.split(' ')[1] || raw).slice(0, 5);
        return hhmm;
      };

      if (todayRes.length > 0) {
        todayRes.sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));

        facEl.innerHTML = todayRes.map((r) => {
          const title = r.title || r.purpose || '利用';
          const userName = r.user_name || r.userName || r.user_id || '教員';
          const avatarUrl = r.avatar_url || r.avatarUrl || null;
          const timeRange = r.start_time ? `${timeOf(r.start_time)} - ${timeOf(r.end_time || r.start_time)}` : '終日';

          return `
            <button type="button" class="dash-facility-item" data-facility-open title="施設タブのタイムラインでこの日の予約を見る"
                    aria-label="${escapeHTML(r.facilityName)} ${escapeHTML(title)} ${escapeHTML(timeRange)}（施設タブを開く）">
              <div class="dash-facility-head">
                <span class="dash-facility-fac">${escapeHTML(r.facilityName)}</span>
                <span class="dash-facility-time font-mono">${escapeHTML(timeRange)}</span>
              </div>
              <div class="dash-facility-body">
                <span class="dash-facility-title">${escapeHTML(title)}</span>
                <span class="dash-facility-author">${userAvatarHtml({ name: userName, avatarUrl, size: 'xs' })}<span class="dash-facility-author-name">${escapeHTML(userName)}</span></span>
              </div>
            </button>
          `;
        }).join('');
      } else {
        facEl.innerHTML = '<div class="dash-facility-empty">本日の施設物品予約はありません</div>';
      }

      // 行クリック → 施設タブ（本日指定でタイムラインを表示）
      facEl.querySelectorAll('[data-facility-open]').forEach((row) => {
        row.addEventListener('click', () => switchTab('facility'));
      });

    } catch (e) {

      facEl.innerHTML = '<div class="dash-facility-empty">予約データの取得に失敗しました</div>';

    }

  }



  // ★ 4. 要対応タスク数（未処理承認・未読掲示）の更新

  // 年休等・出張サマリー (absence.module.js) を読み込み人数表示

  await loadAbsenceSummary();

  const pendingApprovals = document.getElementById('dash-pending-approvals');

  const unreadBulletins = document.getElementById('dash-unread-bulletins');



  // 未処理の承認申請 (PENDING) 件数を実データから取得
  if (pendingApprovals) {
    try {
      const approvalRes = await apiGet('/approvals', { status: 'PENDING' });
      const approvalList = approvalRes.approvals || (Array.isArray(approvalRes) ? approvalRes : []);
      const pendingCount = approvalList.filter((a) => (a.status || 'PENDING') === 'PENDING').length;
      pendingApprovals.textContent = `${pendingCount}件`;
    } catch (e) {
      console.warn('[Dashboard] 未処理承認数の取得に失敗:', e.message);
      pendingApprovals.textContent = '--';
    }
  }

  if (unreadBulletins) unreadBulletins.textContent = `${state.unreadCounts?.bulletin || 0}件`;



  refreshLucideIcons();

}



/**

 * ヘッダー用お天気データの取得

 * ★ モーダル表示のちらつき対策: キャッシュを保持し、変化があった場合のみ再描画する

 */

// モーダル/ウィジェット用の天気キャッシュ (取得成功時のみ保持)

let cachedWeatherObj = null;

let lastForecastHtml = null;

let lastWidgetHtml = null;

/**

 * 週間予報グリッドを描画する (列数を実データ数に合わせ、レイアウト崩れとちらつきを防止)

 * @param {Object} weatherObj

 * @param {boolean} force - 変化がなくても再描画する

 */

function renderWeatherGrid(weatherObj, force = false) {

  const container = document.getElementById('weather-modal-forecasts');

  if (!container) return;

  const forecasts = Array.isArray(weatherObj && weatherObj.forecasts) ? weatherObj.forecasts : [];

  const cols = Math.max(1, Math.min(7, forecasts.length));

  // 列数を実データ数に合わせる (固定 7列だと 2件時にカードが引き伸ばされ表示が崩れる)

  container.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  if (forecasts.length === 0) {

    const emptyHtml = `<div class="col-span-full text-center py-6 text-muted text-xs">週間予報データがありません。</div>`;

    if (lastForecastHtml === emptyHtml && !force) return;

    lastForecastHtml = emptyHtml;

    container.innerHTML = emptyHtml;

    return;

  }

  const html = forecasts.map(f => `

    <div class="bg-surface px-1.5 py-2.5 rounded-xl border border-main text-center flex flex-col justify-between h-full min-h-[128px]">

      <div>

        <div class="h-4 mb-0.5 flex items-center justify-center">

          ${f.isToday ? '<span class="px-1 py-0.5 rounded text-[8px] bg-warning-soft text-warning-strong font-bold leading-none">今日</span>' : ''}

        </div>

        <div class="text-[10px] font-bold text-accent-strong mb-1">${escapeHTML(f.dateLabel || f.rawDate || f.date || '')}</div>

        <div class="my-1 flex justify-center"><i data-lucide="${f.icon || 'cloud-sun'}" class="w-4 h-4 text-warning"></i></div>

        <div class="text-[10px] font-bold text-main mb-1 leading-tight min-h-[28px] flex items-center justify-center px-0.5">${escapeHTML(f.weather || '')}</div>

        <div class="text-[9px] text-muted mb-1">降水: <span class="text-info font-semibold">${escapeHTML(f.pop || '--')}</span></div>

      </div>

      <div class="text-[9px] text-soft space-y-0.5 pt-1 border-t border-main">

        <div>高: <span class="text-danger font-bold">${f.tempMax != null ? f.tempMax + '℃' : '--'}</span></div>

        <div>低: <span class="text-info font-bold">${f.tempMin != null ? f.tempMin + '℃' : '--'}</span></div>

      </div>

    </div>

  `).join('');

  // ★ 内容が変化しない限り innerHTML を書き換えない → ちらつき・レイアウトジャンプを防止

  if (lastForecastHtml === html && !force) return;

  lastForecastHtml = html;

  container.innerHTML = html;

  refreshLucideIcons();

}

/**

 * 初回のみスケルトン表示 (キャッシュ済みなら既存内容維持でちらつき防止)

 */

function showWeatherGridSkeleton() {

  const container = document.getElementById('weather-modal-forecasts');

  if (!container) return;

  if (cachedWeatherObj) {

    renderWeatherGrid(cachedWeatherObj, true);

    return;

  }

  const cols = 7;

  container.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  const skeleton = Array.from({ length: cols }, () =>

    `<div class="bg-surface rounded-xl border border-main min-h-[128px] shimmer-loading"></div>`

  ).join('');

  lastForecastHtml = skeleton;

  container.innerHTML = skeleton;

}

/**

 * ヘッダー天気ウィジェットを描画 (内容が変わったときだけ書き換え)

 */

function renderWeatherWidget(widget, weatherObj) {

  let weatherText = '';

  let tempText = '';

  let iconName = 'cloud-sun';

  if (weatherObj && typeof weatherObj === 'object' && Array.isArray(weatherObj.forecasts) && weatherObj.forecasts.length > 0) {

    const f = weatherObj.forecasts[0];

    weatherText = f.weather || f.weatherText || '';

    tempText = f.tempMax != null ? `(${f.tempMax}℃)` : (f.tempMaxMin ? `(${f.tempMax}℃/${f.tempMin}℃)` : '');

    iconName = f.icon && String(f.icon).length > 2 ? f.icon : 'cloud-sun';

  }

  const html = weatherText

    ? `<i data-lucide="${iconName}" class="w-4 h-4 text-warning"></i> ${escapeHTML(weatherText)} ${escapeHTML(tempText)}`

    : `<i data-lucide="cloud" class="w-4 h-4 text-muted"></i> 天気不明 (--℃)`;

  if (lastWidgetHtml === html) return;

  lastWidgetHtml = html;

  widget.innerHTML = html;

  refreshLucideIcons();

}


export async function fetchWeatherData() {

  const widget = document.getElementById('weather-widget');

  if (!widget) return;



  async function loadWeatherModalData(forceRefresh = false) {

    const container = document.getElementById('weather-modal-forecasts');

    // ★ キャッシュがあれば即表示 (ローディング書き換えによるちらつきを防止)

    if (container) showWeatherGridSkeleton();

    try {

      const endpoint = forceRefresh ? '/news/weather?refresh=true' : '/news/weather';

      const data = await apiGet(endpoint);

      const weatherObj = data && data.weather;

      if (weatherObj) {

        // 更新日時のセット

        const updatedAtStr = weatherObj.updatedAt ? new Date(weatherObj.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '--:--';

        const weatherUpdatedEl = document.getElementById('weather-updated-at');

        if (weatherUpdatedEl) weatherUpdatedEl.textContent = `更新: ${updatedAtStr}`;



        // 警報情報

        const warningEl = document.getElementById('warning-content-text');

        const warningUpdatedEl = document.getElementById('warning-updated-at');

        if (warningEl) {

          warningEl.textContent = weatherObj.warning ? weatherObj.warning.text : '現在、兵庫県・西宮市周辺に特段の警報・注意報は発令されていません。';

        }

        if (warningUpdatedEl) {

          const wTime = weatherObj.warning?.updatedAt ? new Date(weatherObj.warning.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : updatedAtStr;

          warningUpdatedEl.textContent = `更新: ${wTime}`;

        }



        // 災害情報

        const disasterEl = document.getElementById('disaster-content-text');

        const disasterUpdatedEl = document.getElementById('disaster-updated-at');

        if (disasterEl) {

          disasterEl.textContent = weatherObj.disaster ? weatherObj.disaster.text : '現在、近畿地方に影響を与える台風や大規模地震の発生情報はありません。';

        }

        if (disasterUpdatedEl) {

          const dTime = weatherObj.disaster?.updatedAt ? new Date(weatherObj.disaster.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : updatedAtStr;

          disasterUpdatedEl.textContent = `更新: ${dTime}`;

        }



        // 週間予報 (キャッシュ更新して差分描画)

        cachedWeatherObj = weatherObj;

        renderWeatherGrid(weatherObj);

        if (forceRefresh) {

          showToast('気象情報を最新に更新しました', 'success');

        }

      }

    } catch (err) {

      if (container) {

        container.innerHTML = `<div class="col-span-7 text-center py-6 text-danger text-xs">気象データの取得に失敗しました。</div>`;

      }

      if (forceRefresh) {

        showToast('気象情報の更新に失敗しました', 'error');

      }

    }

  }



  // クリックで詳細モーダルを開くイベントを設定

  if (!widget.dataset.boundClick) {

    widget.dataset.boundClick = 'true';

    widget.style.cursor = 'pointer';

    widget.title = 'クリックして西宮・阪神地域の週間予報・防災情報を見る';

    widget.addEventListener('click', () => {

      openModal('weather-detail-modal');

      loadWeatherModalData(false);

    });

  }



   try {

     const data = await apiGet('/news/weather');

     const weatherObj = data && data.weather;

     if (weatherObj) cachedWeatherObj = weatherObj;

     renderWeatherWidget(widget, weatherObj);

   } catch (e) {

     const fallbackHtml = `<i data-lucide="cloud" class="w-4 h-4 text-muted"></i> 天気不明 (--℃)`;

     if (lastWidgetHtml === fallbackHtml) return;

     lastWidgetHtml = fallbackHtml;

     widget.innerHTML = fallbackHtml;

     refreshLucideIcons();

   }

}

// ============================================================
// 記事共有モーダル（入力欄は記事URLのみ。閲覧中の職員チャットチャンネルへ共有）
// ============================================================

/**
 * 入力URLを http(s) の絶対URLへ正規化する。解釈できない場合は null
 * スキーマ無し（例: mext.go.jp/...）は https:// を補完する
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeShareUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  try {
    const u = new URL(candidate);
    // ドットを含まない hostname (例: "foo") はURLとみなさない
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

/** URL から既定タイトル（ドメイン名）を導く */
function defaultShareTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '共有記事';
  }
}

/**
 * ★ チャット投稿は撤廃（v3.1.7）: 職員チャットへの共有投稿経路（チャンネル解決・投稿テキスト組み立て）は
 *   コードに存在しない。共有の行き先は「ピノックアップ教育ニュース」の共有リンク（server の news_links）だけ。
 */

// 共有リンクの控え（ウィジェット描画用。loadDashboardData と共有成功時に更新する）
let sharedLinks = [];

/** 共有リンクのスナップショット（描画・UI テスト用。元配列は渡さない） */
export function sharedLinksSnapshot() {
  return sharedLinks.slice();
}

/**
 * 「ピノックアップ教育ニュース」ウィジェットを描画する（共有リンクを新しい順・1行1件）
 * カードは 2px 実線の1枚の枠（readability.css R3/R4 でホバーリング・浮き上がり）。
 * 行は「タイトルリンク（1行・長さは末尾 … で切る・ホバーで全文）＋右端の小さな日付」だけ。共有者名は出さない。
 * 元記事は新タブで開く（target="_blank"・rel="noopener noreferrer"）。常設説明文は置かない（UI十条9）。
 */
function renderDashNewsSummary() {
  const el = document.getElementById('dash-news-summary');
  if (!el) return;

  if (sharedLinks.length === 0) {
    el.innerHTML = '<div class="text-xs text-muted py-4 text-center col-span-2">共有された記事はまだありません。</div>';
    refreshLucideIcons();
    return;
  }

  el.innerHTML = sharedLinks.map((l) => {
    const rawUrl = String(l.url || '');
    const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '#';
    const fullTitle = String(l.title || l.domain || '共有記事');
    const day = String(l.addedDay || l.added_day || '').substring(0, 10);
    const dayShort = /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? `${Number(day.substring(5, 7))}/${Number(day.substring(8, 10))}`
      : '';

    return `
      <div class="news-link-card rounded-lg bg-surface-strong border border-divider px-2 py-1.5">
        <a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer"
           class="news-link-card__title truncate" title="${escapeHTML(fullTitle)}"
           aria-label="元記事を開く">${escapeHTML(fullTitle)}</a>
        <span class="news-link-card__date font-mono">${escapeHTML(dayShort)}</span>
      </div>
    `;
  }).join('');

  refreshLucideIcons();
}

/**
 * 共有リンク一覧を取得して描画する（ダッシュボード読み込み時）
 */
export async function loadSharedNewsLinks() {
  const el = document.getElementById('dash-news-summary');
  if (!el) return;

  try {
    const res = await apiGet('/news/links', { limit: 8 });
    sharedLinks = res.links || (Array.isArray(res) ? res : []);
  } catch (e) {
    console.warn('[Dashboard] 共有リンクの取得に失敗:', e.message);
    sharedLinks = [];
  }

  renderDashNewsSummary();
}

/**
 * 記事共有モーダルを開く（入力欄は記事URLのみ、開いたら URL 欄へフォーカス）
 */
export function openNewsShareModal() {
  if (!state.currentUser || !state.authToken) {
    showToast('記事を共有するにはログインが必要です', 'warning');
    return;
  }

  openModal('news-share-modal');
  refreshLucideIcons();
  document.getElementById('news-share-url')?.focus();
}

/**
 * 共有モーダルのフォームイベント登録（初期化時に1回だけ）
 * ★ 送信先は POST /api/news/links（共有リンクを1件追加するだけ）。チャットには投稿しない。
 *   ページタイトルは server がURLをfetchって取得する（取れない日はドメイン名がタイトルになる）。
 */
function bindNewsShareForm() {
  const form = document.getElementById('news-share-form');
  if (!form || form.dataset.shareBound === '1') return;
  form.dataset.shareBound = '1';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = normalizeShareUrl(document.getElementById('news-share-url')?.value);
    if (!url) {
      showToast('記事URLの形式が正しくありません（http:// または https:// のURLを入力してください）', 'error');
      document.getElementById('news-share-url')?.focus();
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-60');
    }

    try {
      const res = await apiPost('/news/links', { url });
      const item = res?.link || res?.data || null;

      closeModal('news-share-modal');
      form.reset();

      const title = (item && item.title) ? item.title : defaultShareTitle(url);
      showToast(`ピックアップ教育ニュースへ「${title}」を共有しました`, 'success');

      // ウィジェットへ即反映（server へ再取得を頼まず、追加した1件を先頭に足す）
      if (item) {
        sharedLinks = [item, ...sharedLinks];
        renderDashNewsSummary();
      }
    } catch (err) {
      // 失敗時はモーダルを開いたままエラー表示（入力内容は保持）
      showToast(`共有に失敗しました: ${err.message}`, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-60');
      }
    }
  });
}
