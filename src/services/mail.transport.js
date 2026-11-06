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

/** IMAP の文字列引数エスケープ */
function imapQuote(value) {
  return `"${String(value).replace(/[\\"]/g, (m) => `\\${m}`)}"`;
}



/** IMAP 接続 + ログイン認証テスト */
export async function probeImap({ host, port, secure, user, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket = null;

  try {
    socket = await openSocket(host, port, { directTls: secure, timeoutMs: remaining() });
    let reader = new LineReader(socket);

    const greeting = await reader.next(remaining());
    if (!/^\* OK/i.test(greeting)) {
      return { ok: false, message: `IMAP 初期応答が異常: ${greeting}` };
    }

    let tag = 'a1';
    if (!secure) {
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
        ? `IMAP 接続・ログイン確認 (${host}:${port} / ${secure ? 'TLS 直結' : 'STARTTLS'})`
        : `IMAP ログイン失敗: ${login}`,
    };
  } catch (e) {
    return { ok: false, message: `IMAP: ${e.message}` };
  } finally {
    socket?.destroy();
  }
}

/** SMTP 接続 + AUTH LOGIN 認証テスト */
export async function probeSmtp({ host, port, secure, user, password, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket = null;

  try {
    socket = await openSocket(host, port, { directTls: secure, timeoutMs: remaining() });
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

    if (!secure) {
      if (!/STARTTLS/i.test(ehlo.text)) {
        return { ok: false, message: 'この SMTP サーバーは STARTTLS を提供していません。' };
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
        ? `SMTP 接続・認証確認 (${host}:${port} / ${secure ? 'TLS 直結' : 'STARTTLS'})`
        : `SMTP 認証失敗 (code=${passReply.code}): ${passReply.text}`,
    };
  } catch (e) {
    return { ok: false, message: `SMTP: ${e.message}` };
  } finally {
    socket?.destroy();
  }
}

export default { probeImap, probeSmtp };
