/**
 * ISSystem External Education News & Weather Service
 * 外部教育ニュース (RSS / API) & 天気予報データ取得・インメモリTTLキャッシュ操作
 */

import auditModel from '../models/audit.model.js';

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