/**
 * ISSystem Mail Transport Probe
 * node:net / node:tls のみで IMAP / SMTP の接続とログイン認証を確認する（新規依存ライブラリを使わない）
 * - IMAP: 993 = TLS 直結 / 143 = STARTTLS
 * - SMTP: 465 = TLS 直結 / 25・587 = STARTTLS
 * ※ 校内サーバーは自己署名・CN 不一致の証明書が多いため rejectUnauthorized: false
 *    （SNI の servername は送る。証明書の厳密検証は行わない）
 * ※ 応答タイムアウトは config.mail.timeoutMs (既定 12 秒)
 */
import net from 'node:net';
import tls from 'node:tls';

export const DEFAULT_TIMEOUT_MS = 12000;

/** 接続エラーの日本語メッセージ */
function connectErrorMessage(error) {
  switch (error?.code) {
    case 'ENOTFOUND':
    case 'EAIAGAIN':
      return 'サーバー名を DNS で引けませんでした。';
    case 'ECONNREFUSED':
      return 'サーバーに接続を拒否されました。';
    case 'ECONNRESET':
      return '接続がリセットされました。';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'サーバーへ到達できません。';
    case 'EACCES':
      return 'サーバーへの接続が許可されていません。';
    case 'ETIMEDOUT':
      return '接続タイムアウト';
    default:
      return error?.message || '接続エラー';
  }
}

/** ソケット接続 (平文 / TLS 直結) を確立する */
function openSocket(host, port, { directTls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = directTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs })
      : net.connect({ host, port, timeout: timeoutMs });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('接続タイムアウト'));
    }, timeoutMs);
    socket.once(directTls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(connectErrorMessage(e)));
    });
  });
}

/** 暗号化モードの正規化 (none = 暗号化なし / starttls / tls = TLS 直結) */
export const TLS_MODES = ['none', 'starttls', 'tls'];

export function normalizeTlsMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return TLS_MODES.includes(v) ? v : 'none';
}

/** 暗号化モードの日本語ラベル */
export function tlsModeLabel(mode) {
  const m = normalizeTlsMode(mode);
  return m === 'tls' ? 'TLS 直結' : m === 'starttls' ? 'STARTTLS' : '暗号化なし';
}

/** 平文ソケットを STARTTLS で TLS へ昇格する (平文残余バイトは TLS 側へ渡す) */
function upgradeToTls(socket, host, reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners();
    const residue = reader?.takeBuffer?.() || '';
    reader?.close?.();
    const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false, timeout: timeoutMs });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error('TLS 確立タイムアウト'));
    }, timeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      if (residue) tlsSocket.push(Buffer.from(residue, 'latin1'));
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (e) => {
      clearTimeout(timer);
      tlsSocket.destroy();
      reject(new Error(`TLS 確立失敗 (${connectErrorMessage(e)})`));
    });
  });
}

/** 改行区切りの応答を 1 行ずつ取り出す読み取り器 */
class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('latin1');
      this.flush();
    });
    this.socket.on('error', (e) => this.fail(new Error(connectErrorMessage(e))));
    this.socket.on('close', () => this.fail(new Error('接続が切断されました')));
  }

  /** TLS 昇格前に読み取り残余平文を受け渡し、読み取り器を閉じる */
  takeBuffer() {
    return this.buffer;
  }

  close() {
    this.socket.removeAllListeners();
  }

  flush() {
    while (this.buffer.includes('\n')) {
      const idx = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (this.waiters.length > 0) this.waiters.shift().resolve(line);
      else this.lines.push(line);
    }
  }

  /** 次の行 (応答が来なければ timeoutMs で失敗) */
  next(timeoutMs) {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('応答タイムアウト')), timeoutMs);
      this.waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  write(line) {
    this.socket.write(`${line}\r\n`);
  }

  fail(error) {
    this.waiters.forEach((w) => w.reject(error));
    this.waiters = [];
  }
}

/** IMAP: tag 付き応答が出るまでの応答行を集める */
async function readImapTagged(reader, tag, timeoutMs) {
  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    const line = await reader.next(timeoutMs);
    lines.push(line);
    if (line.startsWith(`${tag} `)) return lines.join(' | ');
    if (!line.startsWith('* ')) return lines.join(' | ');
  }
  return lines.join(' | ');
}

/** SMTP: 3 ケタコードの応答 (250- 形式の継続行を含む) を集める */
async function readSmtpReply(reader, timeoutMs) {
  const first = await reader.next(timeoutMs);
  const code = Number(first.slice(0, 3));
  const lines = [first];
  for (let i = 0; i < 40; i += 1) {
    if (first.length < 4 || first[3] === ' ') break;
    const line = await reader.next(timeoutMs);
    lines.push(line);
    if (line.slice(0, 3) !== String(code) || line[3] === ' ') break;
  }
  return { code, text: lines.join(' | ') };
}

// ============================================================
// 実メール送受信 (受信ボックス / 送信ボックス)
// ※ node:net / node:tls のみで IMAP / SMTP を扱う（新規依存ライブラリを使わない）
// ============================================================

/** バイト応答読み取り器 (IMAP の `{n}` リテラルに対応する) */
class ByteReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.error = null;
    this.waiters = [];
    this.socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    this.socket.on('error', (e) => this.fail(new Error(connectErrorMessage(e))));
    this.socket.on('close', () => this.fail(new Error('接続が切断されました')));
  }

  /** 溜まったバイトから要求を満たす待者を起こす */
  wake() {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const w = this.waiters[i];
      if (w.kind === 'line') {
        const idx = this.buf.indexOf(0x0a);
        if (idx < 0) continue;
        const line = this.buf.slice(0, idx).toString('latin1').replace(/\r$/, '');
        this.buf = this.buf.slice(idx + 1);
        this.waiters.splice(i, 1);
        i -= 1;
        w.resolve(line);
      } else if (w.kind === 'bytes') {
        if (this.buf.length < w.n) continue;
        const chunk = this.buf.slice(0, w.n);
        this.buf = this.buf.slice(w.n);
        this.waiters.splice(i, 1);
        i -= 1;
        w.resolve(chunk);
      }
    }
  }

  /** 接続エラーを全待者へ伝える */
  fail(error) {
    this.error = error;
    this.waiters.forEach((w) => w.reject(error));
    this.waiters = [];
  }

  /** 1 行読む（改行まで、タイムアウトで失敗） */
  readLine(timeoutMs) {
    if (this.error) return Promise.reject(this.error);
    const idx = this.buf.indexOf(0x0a);
    if (idx >= 0) {
      const line = this.buf.slice(0, idx).toString('latin1').replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('応答タイムアウト')), timeoutMs);
      this.waiters.push({
        kind: 'line',
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /** n バイト読む（IMAP リテラル） */
  readBytes(n, timeoutMs) {
    if (this.error) return Promise.reject(this.error);
    if (this.buf.length >= n) {
      const chunk = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      return Promise.resolve(chunk);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('リテラル読み取りタイムアウト')), timeoutMs);
      this.waiters.push({
        kind: 'bytes',
        n,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  write(line) { this.socket.write(`${line}\r\n`); }
  writeBytes(buf) { this.socket.write(buf); }
  takeBuffer() { return this.buf.toString('latin1'); }
  close() { this.socket.removeAllListeners(); }
}

/** IMAP セッション（接続・ログイン・コマンド・ログアウト） */
class ImapSession {
  constructor({ host, port, tlsMode, user, password, timeoutMs }) {
    this.host = host;
    this.port = port;
    this.tlsMode = normalizeTlsMode(tlsMode);
    this.user = user;
    this.password = password;
    this.deadline = Date.now() + timeoutMs;
    this.tagIndex = 1;
    this.socket = null;
    this.reader = null;
  }

  /** 残り時間 (ミリ秒) */
  remaining() { return Math.max(1, this.deadline - Date.now()); }

  /** 接続 + STARTTLS 昇格 + ログイン */
  async connect() {
    this.socket = await openSocket(this.host, this.port, { directTls: this.tlsMode === 'tls', timeoutMs: this.remaining() });
    this.reader = new ByteReader(this.socket);
    const greeting = await this.reader.readLine(this.remaining());
    if (!/^\* OK/i.test(greeting)) throw new Error(`IMAP 初期応答が異常: ${greeting}`);
    if (this.tlsMode === 'starttls') {
      const r = await this.command('STARTTLS');
      if (r.status !== 'OK') throw new Error(`STARTTLS が利用できません: ${r.text}`);
      this.socket = await upgradeToTls(this.socket, this.host, this.reader, this.remaining());
      this.reader = new ByteReader(this.socket);
    }
    const login = await this.command(`LOGIN ${imapQuote(this.user)} ${imapQuote(this.password)}`);
    if (login.status !== 'OK') throw new Error(`IMAP ログイン失敗: ${login.text}`);
  }

  /** コマンド送出 -> tag 付き応答まで読む (payload はリテラル生バイト) */
  async command(args, payload) {
    const tag = `a${this.tagIndex}`;
    this.tagIndex += 1;
    this.reader.write(`${tag} ${args}`);
    if (payload) this.reader.writeBytes(Buffer.from(payload, 'latin1'));
    return await this.readTagged(tag);
  }

  /** tag 付き応答まで集める（Untagged 行と `{n}` リテラルを含む） */
  async readTagged(tag) {
    const lines = [];
    let literal = null;
    for (let i = 0; i < 400; i += 1) {
      const line = await this.reader.readLine(this.remaining());
      lines.push(line);
      const lit = /\{(\d+)\}\s*$/.exec(line);
      if (lit) {
        literal = (await this.reader.readBytes(Number(lit[1]), this.remaining())).toString('latin1');
        lines.push(literal);
      }
      const done = new RegExp(`^${tag} (OK|NO|BAD)(.*)$`, 'i').exec(line);
      if (done) {
        return { tag, status: done[1].toUpperCase(), text: (done[2] || '').trim(), literal, all: lines.join('\n') };
      }
    }
    throw new Error('IMAP の応答が多すぎます');
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch { /* 切断済みなら無視 */ }
    this.socket?.destroy();
  }
}

/** `* SEARCH` 応答から UID 一覧を取り出す */
function extractUids(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\* SEARCH\s+(.+)$/i.exec(line);
    if (m) out.push(...m[1].split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number));
  }
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** IMAP の INTERNALDATE ("12 Nov 2026 06:29:54 +0900" / "01-Jan-2026 06:29:54 +0900") を ISO 文字列へ (解析不能は null)
 *  引数は「INTERNALDATE "..."」を含む応答テキストでも、日付文字列だけでも使える (ISO 文字列はそのまま正規化)
 */
function parseInternalDate(responseText) {
  const quoted = (/INTERNALDATE\s+"([^"]+)"/i.exec(String(responseText || '')) || [])[1];
  const value = (quoted || String(responseText || '')).trim();
  if (!value) return null;
  const m = /(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})/.exec(value);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (month) {
      const iso = `${m[3]}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}T${m[4]}:${m[5]}:${m[6]}${m[7][0]}${m[7].slice(1, 3)}:${m[7].slice(3, 5)}`;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    }
  }
  const direct = Date.parse(value);
  return Number.isNaN(direct) ? null : new Date(direct).toISOString();
}

/** IMAP の文字列引数エスケープ */
function imapQuote(value) {
  return `"${String(value).replace(/[\\"]/g, (m) => `\\${m}`)}"`;
}

/** 文字セット名を TextDecoder ラベルへ寄せる（日本語メールの主流文字セット） */
function decodeCharset(bytes, charset) {
  const label = String(charset || 'utf-8').trim().toLowerCase();
  const map = {
    'utf-8': 'utf-8', us_ascii: 'latin1', 'us-ascii': 'latin1',
    iso88591: 'latin1', 'iso-8859-1': 'latin1', latin1: 'latin1',
    'iso-2022-jp': 'iso-2022-jp', jis: 'iso-2022-jp',
    'euc-jp': 'euc-jp', 'shift_jis': 'shift_jis', sjis: 'shift_jis',
  };
  const target = map[label] || 'utf-8';
  try { return new TextDecoder(target).decode(bytes); } catch { return Buffer.from(bytes).toString('utf8'); }
}

/** quoted-printable デコード */
function qpDecode(text) {
  return String(text || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 本文を Content-Transfer-Encoding に従って文字列へ戻す */
function decodePart(body, cte, charset) {
  const mode = String(cte || '7bit').toLowerCase();
  const bytes = mode === 'base64'
    ? Buffer.from(String(body).replace(/\s+/g, ''), 'base64')
    : Buffer.from(qpDecode(String(body)), 'latin1');
  return decodeCharset(bytes, charset);
}

/** RFC2047 エンコードワード (=?UTF-8?B?...?=) をデコード */
export function decodeHeaderWord(text) {
  const decoded = String(text || '').replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_, cs, enc, data) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(data.replace(/_/g, ' '), 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return decodeCharset(bytes, cs);
  });
  return decoded.replace(/\s+/g, ' ').trim();
}

/** ヘッダー用エンコードワードを組む (ASCII のみの件名はそのまま) */
export function encodeHeaderWord(text) {
  const value = String(text || '');
  if ([...value].every((ch) => ch.charCodeAt(0) < 128)) return value;
  const words = [];
  const bytes = Buffer.from(value, 'utf8');
  const MAX = 54; // 1 ワードの base64 元バイト数（ヘッダー行が 76 字を超えないため）
  for (let i = 0; i < bytes.length; i += MAX) {
    words.push(`=?UTF-8?B?${bytes.slice(i, i + MAX).toString('base64')}?=`);
  }
  return words.join(' ');
}

const TZ_ABBREVS = { ut: 0, utc: 0, gmt: 0, est: -5, edt: -4, cst: -6, cdt: -5, mst: -7, mdt: -6, pst: -8, pdt: -7 };

/** RFC2822 の Date ヘッダー ("Mon, 12 Nov 2026 10:00:00 +0900") を絶対時刻へ変換する
 *  ※ V8 は Date.parse で "+0900" 形式の数値オフセットを無視して UTC 扱いにすることがあるため自前解析 */
function parseRfc2822Date(text) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{3,4})/.exec(String(text || ''));
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const offset = /^[+-]\d{4}$/.test(m[7])
    ? (m[7][0] === '-' ? -1 : 1) * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10))
    : (TZ_ABBREVS[m[7].toLowerCase()] ?? 0);
  const ms = Date.UTC(Number(m[3]), month - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  return Number.isNaN(ms) ? null : new Date(ms - offset * 60000).toISOString();
}

/** RFC822 メッセージを解析して受信ボックス用の形へ戻す (internaldate は Date ヘッダー欠損時のフォールバック) */
export function parseMessage(raw, internaldate = null) {
  const text = String(raw || '');
  const sepMatch = /\r?\n\r?\n/.exec(text);
  const headerPart = sepMatch ? text.slice(0, sepMatch.index) : text;
  const bodyPart = sepMatch ? text.slice(sepMatch.index + sepMatch[0].length) : '';

  const headers = {};
  for (const line of headerPart.replace(/\r\n[ \t]/g, ' ').split(/\r\n|\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  const contentType = headers['content-type'] || 'text/plain';
  const topCharset = (/charset="?([^"\s;]+)"?/i.exec(contentType) || [])[1] || 'utf-8';

  // multipart/alternative: text/plain を探す (無ければ text/html をタグ除去)
  let bodyText = '';
  if (/multipart/i.test(contentType)) {
    const boundary = (/boundary="?([^"\s;]+)"?/i.exec(contentType) || [])[1];
    if (boundary) {
      const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parts = bodyPart.split(new RegExp(`--${esc}`));
      for (const part of parts) {
        const psep = part.search(/\r?\n\r?\n/);
        if (psep < 0) continue;
        const ph = part.slice(0, psep);
        if (!/text\/plain/i.test(ph)) continue;
        const pcte = (/content-transfer-encoding:\s*([^\r\n]+)/i.exec(ph) || [])[1] || '7bit';
        const pcharset = (/charset="?([^"\s;]+)"?/i.exec(ph) || [])[1] || topCharset;
        bodyText = decodePart(part.slice(psep).replace(/^\r?\n\r?\n/, ''), pcte, pcharset);
        break;
      }
      if (!bodyText) {
        for (const part of parts) {
          const psep = part.search(/\r?\n\r?\n/);
          if (psep < 0) continue;
          const ph = part.slice(0, psep);
          if (!/text\/html/i.test(ph)) continue;
          const pcte = (/content-transfer-encoding:\s*([^\r\n]+)/i.exec(ph) || [])[1] || '7bit';
          const pcharset = (/charset="?([^"\s;]+)"?/i.exec(ph) || [])[1] || topCharset;
          bodyText = decodePart(part.slice(psep).replace(/^\r?\n\r?\n/, ''), pcte, pcharset).replace(/<[^>]*>/g, ' ').replace(/\n\s*\n/g, '\n').trim();
          break;
        }
      }
    }
  } else {
    bodyText = decodePart(bodyPart, headers['content-transfer-encoding'] || '7bit', topCharset);
  }

  // 差出人 "表示名 <address>" を分離
  const fromRaw = decodeHeaderWord(headers['from'] || '');
  const addr = (/<([^>]+)>/g.exec(fromRaw) || [])[1] || fromRaw.trim();
  const name = fromRaw.replace(/<[^>]*>/, '').trim() || addr;

  // 受信日時は Date ヘッダー優先。Date が解析不能なら IMAP INTERNALDATE をフォールバックへ使う
  const dateIso = parseRfc2822Date(headers['date'] || '');
  const receivedAt = dateIso ?? parseInternalDate(internaldate);

  return {
    sender_name: name,
    sender_email: addr.toLowerCase(),
    subject: decodeHeaderWord(headers['subject'] || ''),
    body: bodyText.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
    received_at: receivedAt,
  };
}

/** RFC822 メッセージを組み立てる (UTF-8 base64 本文・日本語件名) */
export function buildRawMessage({ from, displayName, to, subject, body }) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST ヘッダー用
  const dateHeader = `${days[jst.getUTCDay()]}, ${pad(jst.getUTCDate())} ${months[jst.getUTCMonth()]} ${jst.getUTCFullYear()} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())} +0900`;
  const b64 = Buffer.from(String(body), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const fromLine = displayName ? `${encodeHeaderWord(displayName)} <${from}>` : from;
  const lines = [
    `From: ${fromLine}`,
    `To: ${to.map((t) => encodeHeaderWord(t)).join(', ')}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${dateHeader}`,
    `Message-ID: <${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@issystem>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
  ];
  return lines.join('\r\n');
}

/** IMAP APPEND 用の日付文字列 (13-Nov-2026 12:34:56 +0900) */
function imapDateTime(date = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `"${String(jst.getUTCDate()).padStart(2, '0')}-${months[jst.getUTCMonth()]}-${jst.getUTCFullYear()} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())} +0900"`;
}




/** IMAP 接続 + ログイン認証テスト (tlsMode = none / starttls / tls) */
export async function probeImap({ host, port, tlsMode = 'starttls', secure, user, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const mode = secure ? 'tls' : normalizeTlsMode(tlsMode);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket = null;

  try {
    socket = await openSocket(host, port, { directTls: mode === 'tls', timeoutMs: remaining() });
    let reader = new LineReader(socket);

    const greeting = await reader.next(remaining());
    if (!/^\* OK/i.test(greeting)) {
      return { ok: false, message: `IMAP 初期応答が異常: ${greeting}` };
    }

    let tag = 'a1';
    if (mode === 'starttls') {
      reader.write(`${tag} STARTTLS`);
      const startTls = await readImapTagged(reader, tag, remaining());
      if (!new RegExp(`^${tag} OK`, 'i').test(startTls)) {
        return { ok: false, message: `STARTTLS が利用できません: ${startTls}` };
      }
      socket = await upgradeToTls(socket, host, reader, remaining());
      reader = new LineReader(socket);
      tag = 'a2';
    }

    reader.write(`${tag} LOGIN ${imapQuote(user)} ${imapQuote(password)}`);
    const login = await readImapTagged(reader, tag, remaining());
    const ok = new RegExp(`^${tag} OK`, 'i').test(login);
    return {
      ok,
      message: ok
        ? `IMAP 接続・ログイン確認 (${host}:${port} / ${tlsModeLabel(mode)})`
        : `IMAP ログイン失敗: ${login}`,
    };
  } catch (e) {
    return { ok: false, message: `IMAP: ${e.message}` };
  } finally {
    socket?.destroy();
  }
}

/** SMTP 接続 + AUTH LOGIN 認証テスト (tlsMode = none / starttls / tls) */
export async function probeSmtp({ host, port, tlsMode = 'starttls', secure, user, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const mode = secure ? 'tls' : normalizeTlsMode(tlsMode);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket = null;

  try {
    socket = await openSocket(host, port, { directTls: mode === 'tls', timeoutMs: remaining() });
    let reader = new LineReader(socket);

    const greeting = await readSmtpReply(reader, remaining());
    if (greeting.code !== 220) {
      return { ok: false, message: `SMTP 初期応答が異常: ${greeting.text}` };
    }

    reader.write('EHLO issystem.local');
    const ehlo = await readSmtpReply(reader, remaining());
    if (ehlo.code !== 250) {
      return { ok: false, message: `EHLO 応答が異常: ${ehlo.text}` };
    }

    if (mode === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) {
        return { ok: false, message: 'この SMTP サーバーは STARTTLS を提供していません。暗号化なしへ変更してください。' };
      }
      reader.write('STARTTLS');
      const startTls = await readSmtpReply(reader, remaining());
      if (startTls.code !== 250) {
        return { ok: false, message: `STARTTLS が拒否されました: ${startTls.text}` };
      }
      socket = await upgradeToTls(socket, host, reader, remaining());
      reader = new LineReader(socket);
      reader.write('EHLO issystem.local');
      const tlsEhlo = await readSmtpReply(reader, remaining());
      if (tlsEhlo.code !== 250) {
        return { ok: false, message: `TLS 昇格後の EHLO が異常: ${tlsEhlo.text}` };
      }
    }

    reader.write('AUTH LOGIN');
    const auth = await readSmtpReply(reader, remaining());
    if (auth.code !== 334) {
      return { ok: false, message: `AUTH LOGIN が拒否されました (code=${auth.code}): ${auth.text}` };
    }

    reader.write(Buffer.from(String(user), 'utf8').toString('base64'));
    const userReply = await readSmtpReply(reader, remaining());
    if (userReply.code !== 334) {
      return { ok: false, message: `ユーザー名応答が異常 (code=${userReply.code}): ${userReply.text}` };
    }

    reader.write(Buffer.from(String(password), 'utf8').toString('base64'));
    const passReply = await readSmtpReply(reader, remaining());
    const ok = passReply.code === 235;
    return {
      ok,
      message: ok
        ? `SMTP 接続・認証確認 (${host}:${port} / ${tlsModeLabel(mode)})`
        : `SMTP 認証失敗 (code=${passReply.code}): ${passReply.text}`,
    };
  } catch (e) {
    return { ok: false, message: `SMTP: ${e.message}` };
  } finally {
    socket?.destroy();
  }
}

/** IMAP: フォルダのメッセージを取得する (新しい順・最大 limit 件。フォルダ未指定は受信ボックス INBOX) */
export async function imapFetchMessages({ host, port, tlsMode, user, password, folder = 'INBOX', limit = 50, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const session = new ImapSession({ host, port, tlsMode, user, password, timeoutMs });
  await session.connect();
  try {
    const sel = await session.command(`SELECT ${imapQuote(folder)}`);
    if (sel.status !== 'OK') throw new Error(`フォルダ「${folder}」を開けません: ${sel.text}`);
    const search = await session.command('UID SEARCH ALL');
    const uids = extractUids(search.all);
    const picks = uids.slice(-limit).reverse(); // 新しい順
    const messages = [];
    for (const uid of picks) {
      // INTERNALDATE も併せて要求する (Date ヘッダーが欠けたメールの受信日時フォールバック用)
      const fetched = await session.command(`UID FETCH ${uid} (FLAGS INTERNALDATE BODY.PEEK[])`);
      if (fetched.status !== 'OK') continue;
      const flags = (/FLAGS \(([^)]*)\)/i.exec(fetched.all) || [])[1] || '';
      const raw = fetched.literal || '';
      const internaldate = parseInternalDate(fetched.all);
      // raw と解析済み項目の両方を返す (受信日時も項目名で返す)
      messages.push({ uid, seen: /\\Seen/i.test(flags), raw, internaldate, ...parseMessage(raw, internaldate) });
    }
    return messages;
  } finally {
    await session.logout();
  }
}

/** IMAP: メッセージを既読 (\Seen) にする (フォルダ未指定は受信ボックス INBOX) */
export async function imapMarkSeen({ host, port, tlsMode, user, password, folder = 'INBOX', uid, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const session = new ImapSession({ host, port, tlsMode, user, password, timeoutMs });
  await session.connect();
  try {
    const sel = await session.command(`SELECT ${imapQuote(folder)}`);
    if (sel.status !== 'OK') throw new Error(`フォルダ「${folder}」を開けません: ${sel.text}`);
    const stored = await session.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
    if (stored.status !== 'OK') throw new Error(`既読マークが付けられません: ${stored.text}`);
    return true;
  } finally {
    await session.logout();
  }
}

/** IMAP: 送信済みフォルダへ APPEND する (raw は RFC822 文字列。フォルダ未指定は 'Sent') */
export async function imapAppend({ host, port, tlsMode, user, password, folder = 'Sent', raw, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const session = new ImapSession({ host, port, tlsMode, user, password, timeoutMs });
  await session.connect();
  try {
    const len = Buffer.byteLength(raw, 'utf8');
    const appended = await session.command(`APPEND ${imapQuote(folder)} ${imapDateTime()} (\\Seen) {${len}}`, raw);
    if (appended.status !== 'OK') throw new Error(`送信済みフォルダ「${folder}」へ保存できません: ${appended.text}`);
    return true;
  } finally {
    await session.logout();
  }
}

/** SMTP: メッセージを送信する (AUTH LOGIN -> MAIL FROM -> RCPT TO -> DATA) */
export async function smtpSend({ host, port, tlsMode, user, password, from, to, raw, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const mode = normalizeTlsMode(tlsMode);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket = null;

  try {
    socket = await openSocket(host, port, { directTls: mode === 'tls', timeoutMs: remaining() });
    let reader = new LineReader(socket);

    const greeting = await readSmtpReply(reader, remaining());
    if (greeting.code !== 220) throw new Error(`SMTP 初期応答が異常: ${greeting.text}`);

    reader.write('EHLO issystem.local');
    const ehlo = await readSmtpReply(reader, remaining());
    if (ehlo.code !== 250) throw new Error(`EHLO 応答が異常: ${ehlo.text}`);

    if (mode === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) {
        throw new Error('SMTP サーバーが STARTTLS を提供していません。暗号化の設定を見てください。');
      }
      reader.write('STARTTLS');
      const startTls = await readSmtpReply(reader, remaining());
      if (startTls.code !== 250) throw new Error(`STARTTLS が拒否されました: ${startTls.text}`);
      socket = await upgradeToTls(socket, host, reader, remaining());
      reader = new LineReader(socket);
      reader.write('EHLO issystem.local');
      const tlsEhlo = await readSmtpReply(reader, remaining());
      if (tlsEhlo.code !== 250) throw new Error(`TLS 昇格後の EHLO が異常: ${tlsEhlo.text}`);
    }

    // AUTH LOGIN (認証を提供しないサーバーは 500/502/504 を無視して中継条件を通す)
    reader.write('AUTH LOGIN');
    const auth = await readSmtpReply(reader, remaining());
    if (auth.code === 334) {
      reader.write(Buffer.from(String(user), 'utf8').toString('base64'));
      const userReply = await readSmtpReply(reader, remaining());
      if (userReply.code !== 334) throw new Error(`ユーザー名応答が異常 (code=${userReply.code}): ${userReply.text}`);
      reader.write(Buffer.from(String(password), 'utf8').toString('base64'));
      const passReply = await readSmtpReply(reader, remaining());
      if (passReply.code !== 235) throw new Error(`SMTP 認証失敗 (code=${passReply.code}): ${passReply.text}`);
    } else if (![500, 502, 504].includes(auth.code)) {
      throw new Error(`AUTH LOGIN 応答が異常 (code=${auth.code}): ${auth.text}`);
    }

    reader.write(`MAIL FROM:<${from}>`);
    const mailFrom = await readSmtpReply(reader, remaining());
    if (mailFrom.code !== 250 && mailFrom.code !== 251) {
      throw new Error(`MAIL FROM が拒否されました (code=${mailFrom.code}): ${mailFrom.text}`);
    }

    for (const rcpt of to) {
      reader.write(`RCPT TO:<${rcpt}>`);
      const r = await readSmtpReply(reader, remaining());
      if (r.code !== 250 && r.code !== 251) {
        throw new Error(`宛先 ${rcpt} が拒否されました (code=${r.code}): ${r.text}`);
      }
    }

    reader.write('DATA');
    const data = await readSmtpReply(reader, remaining());
    if (data.code !== 354) throw new Error(`DATA が拒否されました (code=${data.code}): ${data.text}`);

    // ドットストローフィング (本文の先頭 . を .. へ)
    const wire = String(raw).replace(/\r?\n/g, '\n').split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    reader.write(`${wire}\r\n.`);
    const sent = await readSmtpReply(reader, remaining());
    if (sent.code !== 250) throw new Error(`送信が拒否されました (code=${sent.code}): ${sent.text}`);

    reader.write('QUIT');
    try { await readSmtpReply(reader, remaining()); } catch { /* QUIT 応答が来なくても送信済み */ }
    return `SMTP 送信完了 (${host}:${port} / ${tlsModeLabel(mode)}): 宛先 ${to.length} 件`;
  } catch (e) {
    throw new Error(`SMTP: ${e.message}`);
  } finally {
    socket?.destroy();
  }
}

export default { probeImap, probeSmtp, imapFetchMessages, imapAppend, imapMarkSeen, smtpSend, parseMessage, buildRawMessage };
