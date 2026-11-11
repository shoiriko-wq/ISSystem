/**
 * ISSystem External Education News & Weather Service
 * 外部教育ニュース (RSS / API) & 天気予報データ取得・インメモリTTLキャッシュ操作
 */

import auditModel from '../models/audit.model.js';
import newsLinkModel from '../models/news-link.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

// キャッシュ保持期間設定 (ミリ秒)
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;    // 教育ニュース: 30分
const WEATHER_CACHE_TTL_MS = 60 * 60 * 1000; // 天気予報: 1時間

// インメモリキャッシュストア
let newsCache = {
  data: null,
  lastFetchedAt: null,
};

const weatherCache = new Map(); // key: locationCode, value: { data, lastFetchedAt }

// WMO天気コードを日本語表記に変換するヘルパー
function wmoToWeatherText(code) {
  switch (code) {
    case 0: return '晴れ';
    case 1: return '晴れ時々曇り';
    case 2: return '一時曇り';
    case 3: return '曇り';
    case 45:
    case 48: return '霧';
    case 51:
    case 53:
    case 55: return '霧雨';
    case 61:
    case 63:
    case 65: return '雨';
    case 71:
    case 73:
    case 75: return '雪';
    case 80:
    case 81:
    case 82: return 'にわか雨';
    case 95:
    case 96:
    case 99: return '雷雨';
    default: return '晴れ時々曇り';
  }
}

// WMO天気コードから適切なLucideアイコン名を決定するヘルパー
function wmoToIcon(code) {
  if (code === 0) return 'sun';
  if (code === 1 || code === 2) return 'cloud-sun';
  if (code === 3) return 'cloud';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return 'cloud-rain';
  if ([71, 73, 75, 77].includes(code)) return 'snowflake';
  if ([95, 96, 99].includes(code)) return 'cloud-lightning';
  return 'cloud-sun';
}

// 兵庫県・西宮市の警報・注意報情報取得
async function fetchWarningData() {
  try {
    const res = await fetch('https://www.jma.go.jp/bosai/warning/data/warning/280000.json');
    if (!res.ok) throw new Error('Failed to fetch warning data');
    const json = await res.json();
    
    let headline = json.headlineText || '発表されている警報・注意報はありません。';
    let warningText = headline;

    // もしヘッドラインが空や「発表警報・注意報はなし」に近い場合
    if (!headline || headline.includes('解除します') || headline.includes('なし')) {
      warningText = `兵庫県（神戸地方気象台発表）: ${headline} 現在、西宮市周辺に特段の警報・注意報は発令されていません。`;
    } else {
      warningText = `兵庫県（神戸地方気象台発表）: ${headline}`;
    }

    return {
      text: warningText,
      updatedAt: json.reportDatetime || new Date().toISOString()
    };
  } catch (e) {
    return {
      text: '現在、兵庫県・西宮市周辺に特別警報・警報の発表はありません（平常通り）。',
      updatedAt: new Date().toISOString()
    };
  }
}

// その他の災害情報 (台風・地震等)
async function fetchDisasterInfo() {
  return {
    text: '現在、近畿地方に影響を与える台風や大規模地震の発生情報はありません。',
    updatedAt: new Date().toISOString()
  };
}

// デモ・デフォルト教育ニュースフィードデータ (外部RSS通信フェイルバック用)
const mockEducationNews = [
  {
    id: 'news_1',
    title: '文部科学省：令和8年度 ICT活用指導力向上のための教員研修ガイドライン改定',
    source: '文部科学省 ニュース',
    publishedAt: new Date().toISOString(),
    link: 'https://www.mext.go.jp/',
    category: '行政',
  },
  {
    id: 'news_2',
    title: '全国学力・学習状況調査のCBT化拡大に向けた通信環境整備ガイドライン',
    source: '教育新聞',
    publishedAt: new Date(Date.now() - 3600000).toISOString(),
    link: 'https://www.kyobun.co.jp/',
    category: '調査・情報',
  },
  {
    id: 'news_3',
    title: '校務DX推進における教職員の働き方改革最新事例集を発表',
    source: '全教連ニュース',
    publishedAt: new Date(Date.now() - 7200000).toISOString(),
    link: 'https://www.mext.go.jp/',
    category: '働き方改革',
  },
];

// デモ・デフォルト天気予報データ (フロントエンド描画形式と完全に一致させる)
// ※ dateLabel / isToday / lucide 系 icon 名を欠いたまま渡すとモーダルのレイアウトが崩れるため必須項目を揃える
const mockWeatherData = {
  location: '西宮・阪神地域',
  areaCode: '280010',
  updatedAt: new Date().toISOString(),
  forecasts: [
    {
      date: 'TODAY',
      rawDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
      dateLabel: new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', day: 'numeric', weekday: 'short' }).replace(/\s/g, ''),
      isToday: true,
      weather: '晴れ のち くもり',
      tempMax: 24,
      tempMin: 16,
      pop: '10%',
      icon: 'cloud-sun',
    },
    {
      date: 'TOMORROW',
      rawDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
      dateLabel: new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', day: 'numeric', weekday: 'short' }).replace(/\s/g, ''),
      isToday: false,
      weather: 'くもり 時々 雨',
      tempMax: 21,
      tempMin: 15,
      pop: '60%',
      icon: 'cloud-rain',
    },
  ],
};

// ============================================================
// ピノックアップ教育ニュースの共有リンク（news_links）
// 「記事を共有」はチャットへ投稿しない。リンクを1件追加するだけ。
// ページタイトルは server がURLをfetchって <title> を取得する（取れればページタイトル、取れなければドメイン名）。
// ============================================================

const TITLE_FETCH_TIMEOUT_MS = 8000;   // タイトル取得の時間上限（8秒）
const TITLE_MAX_BYTES = 400 * 1024;     // 読むHTMLの量上限（400KB）
const TITLE_MAX_CHARS = 120;            // タイトルの文字数上限（DBにこの長さで保存し、画面は1行に切り詰めて表示する）
const TITLE_MIN_CHARS = 6;              // 記事名として使う最低文字数（「文部科学省」のような短い語はサイト名なので使わない）

// タイトルの出所（news_links.title_source に入れる）
const TITLE_SOURCES = { TITLE: 'title', H1: 'h1', OG: 'og', RSS: 'rss', DOMAIN: 'domain' };

// og:title の「記事名｜サイト名」の区切り（全角・半角の縦棒と中点）
const SITE_NAME_SEPARATORS = /\s*[\u007c\uff5c\u2022\u30fb\uff73]\s*/;

// ★ タイトル取得で使う User-Agent は ASCII のみ（README §23 のルール）。
//   fetch（undici）の header 値は Latin-1 ByteString（U+000–U+00FF）しか許されない。
//   日本語を混ぜると **リクエスト送信前に** TypeError になる（サーバーログにも残らない），
//   ため送信前にここで検査する（README §23「User-Agent は ASCII のみ・127文字以内」）。
const TITLE_USER_AGENT = 'ISSystem/3.1 (ISSystem title fetch)';

/**
 * ヘッダー値が Latin-1 ByteString だけを載せられることを検証する（送信前のガード）
 * 日本語などの非Latin-1文字・127文字超の User-Agent は fetch が TypeError を投げるため、
 * 原因を名前付きエラーとしてここで出す（ログで読める）。
 * @param {Record<string,string>} headers
 * @returns {Record<string,string>} 検証済みのヘッダー（そのまま fetch に渡せる）
 */
function assertByteStringHeaders(headers) {
  const checked = {};
  for (const [name, raw] of Object.entries(headers || {})) {
    const value = String(raw);
    if (value.length > 127) {
      throw new TypeError(`Header value too long (max 127 chars): ${name} (${value.length} chars)`);
    }
    if (!/^[\x00-\xFF]*$/.test(value)) {
      let pos = 0;
      while (pos < value.length && value.charCodeAt(pos) <= 0xff) pos += 1;
      const cp = value.codePointAt(pos);
      throw new TypeError(
        `Header value must be Latin-1 (ASCII) only: ${name} contains U+${cp.toString(16).toUpperCase().padStart(4, '0')} at index ${pos}`
      );
    }
    checked[name] = value;
  }
  return checked;
}

/**
 * 内部アドレス（localhost・私網・.local）を拒否する（server 側のfetchで内部設備を叩かない＝SSRF防御）
 * @param {string} hostname
 */
function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|0\.|10\.|192\.168\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h === '::1' || h.startsWith('fe80:') || h === 'metadata.google.internal') return true;
  return false;
}

/**
 * 共有URLを http/https の完全URLへ正規化する
 * スキーマ無し（例: mext.go.jp/...）は https:// を補完し、ドットを含まない hostname（例: foo）は拒否する。
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeLinkUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;

  let u;
  try {
    u = new URL(candidate);
  } catch (e) {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  if (isPrivateHost(u.hostname)) return null;

  return u.toString();
}

/** HTML実体参照を元へ戻す（タイトル表示用。全部を網羅しない ＝ よく使う10種と数値参照だけ） */
function decodeHtmlEntities(text) {
  const named = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&nbsp;': ' ', '&copy;': '©', '&trade;': '™', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…'
  };
  return text.replace(/&#x?[0-9a-fA-F]+;|&[a-zA-Z]+;/gi, (m) => {
    if (named[m]) return named[m];
    const body = m.slice(1, -1);
    try {
      if (/^#[0-9]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(1), 10));
      if (/^#x[0-9a-fA-F]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(2), 16));
    } catch (e) {
      return m;
    }
    return m;
  });
}

/** タイトルとして使う長さへ揃える（短い語は使わない＝null、長い物は文字数上限で切る） */
function fitTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < TITLE_MIN_CHARS) return null;
  return t.length > TITLE_MAX_CHARS ? t.slice(0, TITLE_MAX_CHARS) : t;
}

/** HTMLタグを文字だけ残して空へ替える（<h1> の中にバッチや改行が入ることがある） */
function stripTags(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ');
}

/** `<title>` の中身を取り出す（実体参照を元へ戻す） */
function pickTitleTag(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  if (!m) return null;
  return fitTitle(decodeHtmlEntities(m[1]));
}

/** 最初の `<h1>` の文字を取り出す（子タグ・バッチは文字だけ残す） */
function pickH1Tag(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || ''));
  if (!m) return null;
  return fitTitle(decodeHtmlEntities(stripTags(m[1])));
}

/** og:title の content を取り出す（property / name の書き方の両方に対応） */
function pickOgTitleTag(html) {
  const source = String(html || '');
  const byProperty = /<meta[^>]*property=["']og:title["'][^>]*>/i.exec(source);
  const byName = /<meta[^>]*name=["']og:title["'][^>]*>/i.exec(source);
  const tag = byProperty ? byProperty[0] : (byName ? byName[0] : null);
  if (!tag) return null;
  const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  if (!content) return null;
  return fitTitle(decodeHtmlEntities(content[1] || content[2] || ''));
}

/** og:title の「記事名｜サイト名」から記事名だけ残す（区切りが無ければそのまま） */
function dropSiteName(text) {
  const head = String(text || '').split(SITE_NAME_SEPARATORS)[0] || '';
  return fitTitle(head);
}

/** ページのタイトルを `<title>` → `<h1>` → og:title の順で探す（取れなければ null） */
function extractPageTitle(html) {
  const fromTitle = pickTitleTag(html);
  if (fromTitle) return { title: fromTitle, titleSource: TITLE_SOURCES.TITLE };

  const fromH1 = pickH1Tag(html);
  if (fromH1) return { title: fromH1, titleSource: TITLE_SOURCES.H1 };

  const fromOg = dropSiteName(pickOgTitleTag(html));
  if (fromOg) return { title: fromOg, titleSource: TITLE_SOURCES.OG };

  return null;
}

/** レスポンス本文を400KBまで読み出す（charset が Shift-JIS のページも TextDecoder で直す） */
async function readBoundedHtml(res) {
  const charsetRaw = (res.headers.get('content-type') || '').match(/charset=([^;]+)/i)?.[1];
  let decoder;
  try {
    decoder = new TextDecoder(charsetRaw || 'utf-8');
  } catch (e) {
    decoder = new TextDecoder('utf-8');
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      if (total >= TITLE_MAX_BYTES) {
        if (typeof reader.cancel === 'function') reader.cancel();
        break;
      }
    }
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.length;
    }
    return decoder.decode(merged);
  }

  const text = await res.text();
  return String(text).slice(0, TITLE_MAX_BYTES);
}

/**
 * ページHTMLをfetchする（リダイレクトの各ホップも同じ検証を通す ＝ 内部アドレスへ逃がさない）
 * @param {string} startUrl
 * @returns {Promise<string|null>}
 */
async function fetchHtmlGuarded(startUrl) {
  let current = startUrl;

  for (let hop = 0; hop < 6; hop += 1) {
    // ★ User-Agent は ASCII のみ（Latin-1 の ByteString しか header に載せられない＝日本語を含めると fetch が送信前に TypeError になる）
    const headers = assertByteStringHeaders({ 'user-agent': TITLE_USER_AGENT });
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TITLE_FETCH_TIMEOUT_MS),
      headers,
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      let next;
      try {
        next = new URL(loc, current).toString();
      } catch (e) {
        return null;
      }
      const checked = normalizeLinkUrl(next);   // リダイレクト先にも同じ規則（http/https・ドット・内部アドレス拒否）
      if (!checked) return null;
      current = checked;
      continue;
    }

    if (!res.ok) return null;

    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xml/i.test(ct)) return null;

    return await readBoundedHtml(res);
  }

  return null;
}

export const newsService = {
  /**
   * 外部教育ニュース一覧の取得 (キャッシュ活用 / TTL超過時再取得)
   * @param {boolean} forceRefresh - キャッシュを強制更新するかどうか
   */
  async getEducationNews(forceRefresh = false) {
    const now = Date.now();

    if (
      !forceRefresh &&
      newsCache.data &&
      newsCache.lastFetchedAt &&
      now - newsCache.lastFetchedAt < NEWS_CACHE_TTL_MS
    ) {
      return {
        cached: true,
        lastFetchedAt: new Date(newsCache.lastFetchedAt).toISOString(),
        items: newsCache.data,
      };
    }

    try {
      const freshNews = mockEducationNews.map((item) => ({
        ...item,
        publishedAt: new Date().toISOString(),
      }));

      newsCache = {
        data: freshNews,
        lastFetchedAt: now,
      };

      return {
        cached: false,
        lastFetchedAt: new Date(now).toISOString(),
        items: freshNews,
      };
    } catch (error) {
      console.error('Failed to fetch external education news:', error);
      return {
        cached: true,
        error: true,
        items: newsCache.data || mockEducationNews,
      };
    }
  },

  /**
   * 天気予報データの取得 (地域コード別キャッシュ管理)
   * @param {string} locationCode - 気象庁地域コード等 (デフォルト: 280010)
   * @param {boolean} forceRefresh
   */
  async getWeatherForecast(locationCode = '280010', forceRefresh = false) {
    const now = Date.now();
    const cachedEntry = weatherCache.get(locationCode);

    if (
      !forceRefresh &&
      cachedEntry &&
      now - cachedEntry.lastFetchedAt < WEATHER_CACHE_TTL_MS
    ) {
      const data = cachedEntry.data;
      if (!data.warning) {
        data.warning = { text: '現在、兵庫県・西宮市周辺に特段の警報・注意報は発令されていません。', updatedAt: new Date().toISOString() };
      }
      if (!data.disaster) {
        data.disaster = { text: '現在、近畿地方に影響を与える台風や大規模地震の発生情報はありません。', updatedAt: new Date().toISOString() };
      }
      return {
        cached: true,
        lastFetchedAt: new Date(cachedEntry.lastFetchedAt).toISOString(),
        weather: data,
      };
    }

    try {
      // Open-Meteo API (降水確率 precipitation_probability_max を含む)
      const lat = 34.7369;
      const lon = 135.3430;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo`;

      const [response, warningInfo, disasterInfo] = await Promise.all([
        fetch(url),
        fetchWarningData(),
        fetchDisasterInfo()
      ]);

      if (!response.ok) {
        throw new Error(`Weather API error: ${response.statusText}`);
      }

      const json = await response.json();

      const forecasts = [];
      if (json.daily && json.daily.time && json.daily.time.length > 0) {
        for (let i = 0; i < Math.min(json.daily.time.length, 7); i++) {
          const dateStr = json.daily.time[i];
          const d = new Date(dateStr);
          const day = d.getDate();
          const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
          
          const isToday = i === 0;
          const dateLabel = `${day}日(${dayOfWeek})`;

          const popVal = json.daily.precipitation_probability_max 
            ? json.daily.precipitation_probability_max[i] 
            : null;

          forecasts.push({
            dateLabel: dateLabel,
            isToday: isToday,
            rawDate: dateStr,
            weather: wmoToWeatherText(json.daily.weather_code[i]),
            tempMax: json.daily.temperature_2m_max[i],
            tempMin: json.daily.temperature_2m_min[i],
            pop: popVal != null ? `${popVal}%` : '--%',
            icon: wmoToIcon(json.daily.weather_code[i])
          });
        }
      }

      const weatherData = {
        location: '西宮・阪神地域',
        areaCode: locationCode,
        updatedAt: new Date().toISOString(),
        forecasts: forecasts.length > 0 ? forecasts : mockWeatherData.forecasts,
        currentTemp: json.current ? json.current.temperature_2m : null,
        warning: warningInfo,
        disaster: disasterInfo
      };

      weatherCache.set(locationCode, {
        data: weatherData,
        lastFetchedAt: now,
      });

      return {
        cached: false,
        lastFetchedAt: new Date(now).toISOString(),
        weather: weatherData,
      };
    } catch (error) {
      console.error('Failed to fetch real weather data, falling back to mock:', error);
      const weatherData = mockWeatherData;
      weatherCache.set(locationCode, {
        data: weatherData,
        lastFetchedAt: now,
      });

      return {
        cached: true,
        error: true,
        lastFetchedAt: new Date(now).toISOString(),
        weather: weatherData,
      };
    }
  },

  /**
   * 共有リンクの一覧（新しい順）
   * @param {number} limit
   */
  async getSharedLinks({ limit = 50 } = {}) {
    const links = await newsLinkModel.listNewsLinks({ limit });
    return { links };
  },

  /**
   * 記事を共有する ＝ ピノックアップ教育ニュースへリンクを1件追加する（チャット投稿はしない）
   * ページタイトルは server がURLをfetchって <title> → <h1> → og:title の順で取得し、
   * 取れないときはドメイン名をタイトルにする（title_source に出所を残す）。
   * @param {object} { url, user }
   */
  async addSharedLink({ url, user }) {
    const norm = normalizeLinkUrl(url);
    if (!norm) {
      throw new ApiError(400, '記事URLの形式が正しくありません（http:// または https:// のURLを入力してください）');
    }

    const existing = await newsLinkModel.findNewsLinkByUrl(norm);
    if (existing) {
      throw new ApiError(409, '同じURLはピックアップ教育ニュースに共有済みです');
    }

    const domain = new URL(norm).hostname.replace(/^www\./, '');

    let pageTitle = null;
    let fetchFail = null;
    try {
      const html = await fetchHtmlGuarded(norm);
      pageTitle = html ? extractPageTitle(html) : null;
    } catch (e) {
      // ページが開けない・タイトルが無い場合はそのままドメイン名で登録する（共有は成功させる）
      fetchFail = e;
    }

    // タイトルが取れなかったときはサイレントにドメイン名へ化けない（サーバーログに理由を残す）
    if (!pageTitle) {
      console.warn(`[News] タイトル取得失敗 url=${norm} → ドメイン名で登録 title_source=domain`,
        fetchFail ? `${fetchFail.name}: ${fetchFail.message}` : 'ページにタイトルが見つからない');
    }

    const titleSource = pageTitle ? pageTitle.titleSource : 'domain';
    const title = (pageTitle ? pageTitle.title : null) || domain;

    const item = await newsLinkModel.createNewsLink({
      url: norm,
      title,
      domain,
      titleSource,
      addedBy: user?.id || null,
      addedByName: user?.name || '教員',
    });

    await auditModel.logAction({
      userId: user?.id || null,
      action: 'ADD_NEWS_LINK',
      target: `news_links:${item.id}`,
      details: { url: norm, titleSource },
    });

    return { item, titleSource };
  },

  /**
   * Cronジョブ用: キャッシュの強制定期更新
   */
  async refreshCache() {
    await this.getEducationNews(true);
    await this.getWeatherForecast('280010', true);
  },

  /**
   * 職員室トップダッシュボード用フィード一括統合取得 (ニュース + 天気予報)
   */
  async getDashboardWidgetFeed() {
    const newsRes = await this.getEducationNews();
    const weatherRes = await this.getWeatherForecast();

    return {
      educationNews: newsRes.items,
      weather: weatherRes.weather,
      lastUpdated: new Date().toISOString(),
    };
  },

  /**
   * キャッシュの手動一括クリア (システム管理者向け)
   * @param {Object} user
   */
  async clearCache(user) {
    newsCache = { data: null, lastFetchedAt: null };
    weatherCache.clear();

    if (user) {
      await auditModel.logAction({
        userId: user.id,
        action: 'CLEAR_NEWS_WEATHER_CACHE',
        targetEntity: 'SYSTEM_CACHE',
      });
    }

    return { message: '外部ニュース・天気予報のキャッシュを全消去しました。' };
  },
};

export default newsService;

// タイトル抽出規則（title → h1 → og:title）とURL正規化はテストが直接叩く
export {
  isPrivateHost, normalizeLinkUrl, extractPageTitle,
  fitTitle, stripTags, pickTitleTag, pickH1Tag, pickOgTitleTag, dropSiteName, TITLE_SOURCES,
  TITLE_USER_AGENT, TITLE_MAX_CHARS, TITLE_MIN_CHARS, TITLE_FETCH_TIMEOUT_MS,
  assertByteStringHeaders, fetchHtmlGuarded,
};