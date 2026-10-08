// Мок-окружение: Google Apps Script (таблица), Telegram API, KV, Twilio.
import worker from '../dist/worker.js';

export const state = { gasDown: false, tg: [], sms: [], tags: [], states: {}, nextId: 101 };

export function makeKV() {
  const kvStore = new Map();
  const meta = new Map();
  const bin = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);
  return {
    async get(k, type) { const v = kvStore.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; },
    async getWithMetadata(k, type) { const v = await this.get(k, type); return { value: v, metadata: v === null ? null : (meta.get(k) || null) }; },
    async put(k, v, opts = {}) { kvStore.set(k, bin(v) ? v : String(v)); if (opts.metadata) meta.set(k, opts.metadata); else meta.delete(k); },
    async delete(k) { kvStore.delete(k); meta.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    _dump() { return Object.fromEntries(kvStore); },
  };
}
export const KV = makeKV();

function gas(body) {
  const { action } = body;
  const find = (id) => state.tags.find((t) => String(t.tag_id) === String(id));
  switch (action) {
    case 'register': {
      const tag = { tag_id: String(state.nextId++), owner_name: body.owner_name, phone: body.phone, pet_name: body.pet_name,
        address: body.address, telegram_chat_id: body.telegram_chat_id || '', status: 'active', link_token: 'tok' + state.nextId, source: body.source };
      state.tags.push(tag); return { ok: true, tag };
    }
    case 'getTag': { const t = find(body.id); return t && t.status !== 'deleted' ? { ok: true, found: true, tag: t } : { ok: true, found: false }; }
    case 'version': return state.oldGas ? { ok: false, error: 'unknown_action' } : { ok: true, version: 2 };
    case 'deleteTag': {
      if (state.oldGas) return { ok: false, error: 'unknown_action' };
      const t = find(body.id); if (!t || t.status === 'deleted') return { ok: true, found: false };
      if (String(t.telegram_chat_id) !== String(body.chat_id)) return { ok: false, error: 'forbidden' };
      for (const k of ['owner_name', 'phone', 'pet_name', 'address', 'telegram_chat_id', 'link_token']) t[k] = '';
      t.status = 'deleted'; return { ok: true, found: true, deleted: true };
    }
    case 'logScan': { const t = find(body.id); if (!t) return { ok: true, found: false };
      const now = Date.now(); const throttled = !body.lat && t._last && now - t._last < 1000; if (!body.lat) t._last = now;
      t.last_scan_at = new Date().toISOString(); return { ok: true, found: true, tag: t, throttled }; }
    case 'linkTelegram': { const t = state.tags.find((x) => x.link_token === body.token); if (!t) return { ok: true, found: false };
      if (!state.oldGas && t.telegram_chat_id && String(t.telegram_chat_id) !== String(body.chat_id)) return { ok: true, found: true, conflict: true };
      t.telegram_chat_id = body.chat_id; return { ok: true, found: true, tag: t }; }
    case 'listByChat': return { ok: true, tags: state.tags.filter((t) => String(t.telegram_chat_id) === String(body.chat_id)) };
    case 'getState': return { ok: true, state: state.states[body.chat_id] || null };
    case 'setState': state.states[body.chat_id] = body.state; return { ok: true };
    case 'clearState': delete state.states[body.chat_id]; return { ok: true };
  }
  return { ok: false, error: 'unknown_action' };
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input.url || input);
  if (url.startsWith('https://gas.mock')) {
    if (state.gasDown) throw new Error('simulated outage');
    return new Response(JSON.stringify(gas(JSON.parse(init.body))));
  }
  if (url.startsWith('https://api.telegram.org/file/bot')) {
    // скачивание фото, присланного в бот: маленький «JPEG» (FF D8 FF …)
    state.tg.push({ method: 'download', payload: { url } });
    const b = new Uint8Array(4000); b.set([0xff, 0xd8, 0xff, 0xe0]);
    return new Response(b, { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url.startsWith('https://api.telegram.org')) {
    const method = url.split('/').pop();
    const payload = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body || '{}');
    state.tg.push({ method, payload });
    const blocked = String(payload.chat_id) === 'blocked';
    if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: state.botUsername || 'FindYpetTestBot' } }));
    if (method === 'getFile') return new Response(JSON.stringify({ ok: true, result: { file_id: payload.file_id, file_path: 'photos/file_7.jpg' } }));
    return new Response(JSON.stringify(blocked ? { ok: false, description: 'bot was blocked' } : { ok: true, result: { message_id: 555 } }));
  }
  if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) {
    const f = new URLSearchParams(String(init.body));
    state.turnstile = (state.turnstile || 0) + 1;
    const okSecret = f.get('secret') === 'ts-secret', okResp = f.get('response') === 'good-token';
    const codes = !okSecret ? ['invalid-input-secret'] : okResp ? [] : ['invalid-input-response'];
    return new Response(JSON.stringify({ success: okSecret && okResp, 'error-codes': codes }));
  }
  if (url.startsWith('https://api.twilio.com')) {
    state.sms.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    return new Response('{}', { status: 201 });
  }
  throw new Error('unexpected fetch ' + url);
};

export function makeEnv(extra = {}) {
  return { GAS_URL: 'https://gas.mock/exec', GAS_KEY: 'k', BOT_TOKEN: 'T', BOT_USERNAME: 'YourPetLocatorBot',
    WEBHOOK_SECRET: 'sec', ADMIN_CHAT_ID: 'admin', TIMEZONE: 'Asia/Jerusalem', FYP_KV: KV, ...extra };
}

export async function call(env, path, { method = 'GET', body, headers = {} } = {}) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const req = new Request('http://localhost:8787' + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, ctx);
  await Promise.all(pending);
  return res;
}

export async function tgUpdate(env, update) {
  return call(env, '/telegram', { method: 'POST', body: update, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sec' } });
}
export const msg = (chat, text, extra = {}) => ({ message: { chat: { id: chat, type: 'private' }, from: { first_name: 'Kostya' }, text, ...extra } });
export const cb = (chat, data, from) => ({ callback_query: { id: 'cq1', data, ...(from ? { from } : {}), message: { chat: { id: chat }, message_id: 7 } } });
export { worker };

/** /setup: ключ уходит в теле POST (в адресе он больше не принимается). */
export async function setupCall(env, key = 'sec') {
  return call(env, '/setup', { method: 'POST', body: { key } });
}
