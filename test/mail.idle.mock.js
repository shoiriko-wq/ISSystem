/**
 * IMAP 常時接続 (IDLE) モックハネス。
 * 常時接続ウォッチ (runWatchLoop) と lazy body/attachment をテストする差し替えプローブを組み立てる。
 *
 * makeIdleHarness(state) -> { openInbox, newEnvelopes, bodyText, attachmentBytes }
 * state:
 *   - exists / uidNext / maxUid   : 接続直後の INBOX 基準値 (openInbox が返す)
 *   - lineQueue : []             : IDLE 応答ライン (「* N EXISTS」等) を順に返す。空なら readTimeout 後に reject (idleReadLine 相当のタイムアウト)
 *   - envelopeQueue : {}          : uid -> envelope (newEnvelopes(session, fromUid) は fromUid 以降の envelope を返す)
 *   - body : {}                  : uid -> { body, html_stripped } (fetchBodyText / probes.bodyText 用)
 *   - attachment : {}            : section -> Buffer (fetchAttachmentBytes / probes.attachmentBytes 用)
 *   - counters : {}              : openInbox / bodyText / attachmentBytes / newEnvelopes 呼び出し回数
 */

/** readTimeout に応じた idleReadLine のモック (ラインが無ければ 50ms でタイムアウトreject) */
function makeSession(state) {
  const counters = state.counters;
  const session = {
    counters: counters,
    async selectInbox() {
      counters.select = (counters.select ?? 0) + 1;
      return { exists: state.exists, uidNext: state.uidNext };
    },
    async idleStart() {
      counters.idleStart = (counters.idleStart ?? 0) + 1;
      return 'tag';
    },
    idleReadLine(timeout) {
      const line = state.lineQueue.shift();
      if (line) return Promise.resolve(line);
      // ライン無し = ドバコの応答無し。readTimeout は最大 50ms で待って reject する (テストは数回ループで十分)
      const ms = Math.max(1, Math.min(Number(timeout) || 30000, 50));
      return new Promise((_res, rej) => setTimeout(() => rej(new Error('idle timeout')), ms));
    },
    async idleDone() {
      counters.idleDone = (counters.idleDone ?? 0) + 1;
      return '+ done';
    },
    extend() {
      counters.extend = (counters.extend ?? 0) + 1;
    },
    async logout() {
      counters.logout = (counters.logout ?? 0) + 1;
    },
    // 単発接続フォールバック用 (接続中でないユーザの lazy body/attachment)
    async fetchBodyText(uid) {
      counters.fetchBody = (counters.fetchBody ?? 0) + 1;
      const entry = state.body[String(uid)];
      if (!entry) return { body: '', html_stripped: false };
      return { body: entry.body ?? '', html_stripped: entry.html_stripped === true };
    },
    async fetchAttachmentBytes(uid, section) {
      counters.fetchAttachment = (counters.fetchAttachment ?? 0) + 1;
      return state.attachment[String(section)] ?? Buffer.from('');
    },
  };
  return session;
}

export function makeIdleHarness(state) {
  const counters = (state.counters = state.counters ?? {});

  const openInbox = async () => {
    counters.openInbox = (counters.openInbox ?? 0) + 1;
    return {
      session: makeSession(state),
      exists: state.exists,
      uidNext: state.uidNext,
      maxUid: state.maxUid,
    };
  };

  const newEnvelopes = async (_session, fromUid) => {
    counters.newEnvelopes = (counters.newEnvelopes ?? 0) + 1;
    const out = [];
    for (const key of Object.keys(state.envelopeQueue)) {
      if (Number(key) >= Number(fromUid)) out.push(state.envelopeQueue[key]);
    }
    // 消費済みにする (同じ件を何度も取り込まない)
    state.envelopeQueue = Object.fromEntries(
      Object.entries(state.envelopeQueue).filter(([k]) => Number(k) < Number(fromUid))
    );
    return out;
  };

  const bodyText = async (_session, uid) => {
    counters.bodyText = (counters.bodyText ?? 0) + 1;
    const entry = state.body[String(uid)];
    if (!entry) return { body: '', html_stripped: false };
    return { body: entry.body ?? '', html_stripped: entry.html_stripped === true };
  };

  const attachmentBytes = async (_session, _uid, section) => {
    counters.attachmentBytes = (counters.attachmentBytes ?? 0) + 1;
    return state.attachment[String(section)] ?? Buffer.from('');
  };

  return { openInbox, newEnvelopes, bodyText, attachmentBytes };
}