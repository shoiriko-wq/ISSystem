/**
 * ISSystem Global Configuration & API Endpoints
 */

// API & WebSocket Base URLs
// 安全通信 (HTTPS/WSS)：サーバーが同一オリジンで画面・API・WSS を提供するため相対/オリジンで解決する
export const API_BASE_URL = '/api';

// https://... → socket.io は wss:// に、http://... → ws:// へ自動で対応する
export const WS_BASE_URL = window.location.origin;

// API Endpoints Mapping
export const ENDPOINTS = {
  AUTH: {
    LOGIN: '/auth/login',
    LOGOUT: '/auth/logout',
    ME: '/auth/me',
  },
  BULLETIN: {
    LIST: '/bulletins',
    CREATE: '/bulletins',
    DETAIL: (id) => `/bulletins/${id}`,
    READ: (id) => `/bulletins/${id}/read`,
    REVISE_REQUEST: (id) => `/bulletins/${id}/revise-request`,
  },
  CHAT: {
    CHANNELS: '/chat/channels',
    MESSAGES: (channelId) => `/chat/channels/${channelId}/messages`,
  },
  FACILITY: {
    LIST: '/facilities',
    RESERVATIONS: '/facilities/reservations',
    CREATE_RESERVATION: '/facilities/reservations',
  },
  SCHEDULE: {
    LIST: '/schedules',
    CREATE: '/schedules',
  },
  APPROVAL: {
    LIST: '/approvals',
    CREATE: '/approvals',
    UPDATE_STATUS: (id) => `/approvals/${id}/status`,
  },
  SEATING: {
    MASTER: '/seating/master',
    UPDATE: '/seating/master',
  },
  EXAM: {
    OPTIMIZE: '/exam/optimize',
    STATUS: '/exam/status',
    MATRIX: '/exam/matrix',
  },
  EXTERNAL: {
    WEATHER: '/external/weather',
    NEWS: '/external/news',
  }
};

// System Roles
export const ROLES = {
  TEACHER: 'TEACHER',
  KYOMU: 'KYOMU',
  ADMIN: 'ADMIN'
};

// Application Constants
export const APP_CONFIG = {
  NAME: 'ISSystem',
  VERSION: 'v2.5.1',
  CLOCK_INTERVAL_MS: 1000,
  WEATHER_REFRESH_MS: 600000, // 10 minutes
  DEFAULT_THEME: 'light-azure',
  STORAGE_KEYS: {
    AUTH_TOKEN: 'is_system_jwt_token_v251',
    USER_DATA: 'is_system_user_info_v251',
    THEME_PREF: 'is_system_theme_preference_v251'
  }
};