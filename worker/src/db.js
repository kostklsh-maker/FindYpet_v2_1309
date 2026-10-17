import { bumpFail } from './api.js';
import { tr } from './i18n.js';
import { json } from './util.js';
// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
export async function db(env, action, data = {}) {
  if (d1On(env) && env.DB_READ === 'd1' && action === 'getTag') {
    const hit = await d1Read(env, data.id);
    if (hit) return hit;                       // в D1 жетона нет (ещё не перенесён) — читаем из главной базы
  }
  const res = await dbMain(env, action, data);
  if (d1On(env)) await d1Mirror(env, action, data, res);
  return res;
}

export async function dbMain(env, action, data) {
  if (env.TEST_DB === '1' || env.TEST_DB === true) return testDb(env, action, data);
  // Таймаут: если Google Apps Script завис (бывает при пиковой нагрузке на
  // бесплатной квоте), не заставляем прохожего у метки ждать бесконечно —
  // через 9 секунд отдаём явную "временную" ошибку (и страница берёт кэш).
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: env.GAS_KEY, action, ...data }),
      redirect: 'follow',
      signal: ac.signal,
    });
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      console.error('DB non-JSON response', res.status, txt.slice(0, 300));
      await bumpFail(env, 'db');
      return { ok: false, error: 'db_bad_response' };
    }
  } catch (err) {
    console.error('DB request failed', action, String(err && err.message || err));
    await bumpFail(env, 'db');
    return { ok: false, error: 'db_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Тестовая база (только тестовый сайт, TEST_DB = "1"): те же действия, что у Apps Script,
 * но жетоны хранятся в KV тестового сайта. Настоящая Google-таблица не затрагивается.
 * Номера тестовых жетонов начинаются с 9001, чтобы их нельзя было спутать с настоящими.
 * Ключи: db:seq — последний номер, db:t:<id> — жетон, db:tok:<token> → id,
 *        db:chat:<chat_id> — номера жетонов чата, db:st:<chat_id> — шаг диалога с ботом.
 */
export async function testDb(env, action, d) {
  const kv = env.FYP_KV;
  if (!kv) return { ok: false, error: 'no_kv' };
  const getT = (id) => kv.get(`db:t:${id}`, 'json');
  const putT = (t) => kv.put(`db:t:${t.tag_id}`, JSON.stringify(t));
  const chatIds = async (c) => (await kv.get(`db:chat:${c}`, 'json')) || [];
  const addToChat = async (c, id) => {
    const ids = await chatIds(c);
    if (!ids.includes(String(id))) { ids.push(String(id)); await kv.put(`db:chat:${c}`, JSON.stringify(ids)); }
  };
  switch (action) {
    case 'register': {
      const id = String((Number(await kv.get('db:seq')) || 9000) + 1);
      await kv.put('db:seq', id);
      const t = {
        tag_id: id, owner_name: d.owner_name || '', phone: d.phone || '', pet_name: d.pet_name || '',
        address: d.address || '', telegram_chat_id: d.telegram_chat_id ? String(d.telegram_chat_id) : '',
        status: 'active', link_token: crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        source: d.source || '', created_at: new Date().toISOString(), tag_url: (d.tag_url_base || '') + id,
      };
      await putT(t);
      await kv.put(`db:tok:${t.link_token}`, id);
      if (t.telegram_chat_id) await addToChat(t.telegram_chat_id, id);
      return { ok: true, tag: t };
    }
    case 'getTag': {
      const t = await getT(d.id);
      return t && t.status !== 'deleted' ? { ok: true, found: true, tag: t } : { ok: true, found: false };
    }
    case 'logScan': {
      const t = await getT(d.id);
      if (!t) return { ok: true, found: false };
      const now = Date.now();
      const throttled = !d.lat && now - (Date.parse(t.last_scan_at || '') || 0) < 60000; // повторный скан в течение минуты
      t.last_scan_at = new Date(now).toISOString();
      t.scans = (Number(t.scans) || 0) + 1;
      await putT(t);
      return { ok: true, found: true, tag: t, throttled };
    }
    case 'linkTelegram': {
      const id = await kv.get(`db:tok:${d.token}`);
      const t = id && (await getT(id));
      if (!t) return { ok: true, found: false };
      if (t.telegram_chat_id && String(t.telegram_chat_id) !== String(d.chat_id)) return { ok: true, found: true, conflict: true };
      t.telegram_chat_id = String(d.chat_id);
      await putT(t);
      await addToChat(d.chat_id, t.tag_id);
      return { ok: true, found: true, tag: t };
    }
    case 'listByChat': {
      const tags = (await Promise.all((await chatIds(d.chat_id)).map(getT)))
        .filter((t) => t && String(t.telegram_chat_id) === String(d.chat_id));
      return { ok: true, tags };
    }
    case 'deleteTag': {
      const t = await getT(d.id);
      if (!t || t.status === 'deleted') return { ok: true, found: false };
      if (String(t.telegram_chat_id) !== String(d.chat_id)) return { ok: false, error: 'forbidden' };
      for (const k of ['owner_name', 'phone', 'pet_name', 'address', 'telegram_chat_id', 'link_token']) t[k] = '';
      t.status = 'deleted';
      await putT(t);
      return { ok: true, found: true, deleted: true };
    }
    case 'version': return { ok: true, version: 2 };
    case 'getState': return { ok: true, state: (await kv.get(`db:st:${d.chat_id}`, 'json')) || null };
    case 'setState': await kv.put(`db:st:${d.chat_id}`, JSON.stringify(d.state)); return { ok: true };
    case 'clearState': await kv.delete(`db:st:${d.chat_id}`); return { ok: true };
  }
  return { ok: false, error: 'unknown_action' };
}

// ---------------------------------------------------------------
// D1 (этап D1, шаг 1): копия жетонов в Cloudflare D1.
// Главная база пока прежняя (Google-таблица, на тестовом сайте — KV). Каждый ответ главной базы
// о жетоне записывается в D1: так D1 заполняется сама, а удаление по /delete стирает данные и там.
// DB_READ = "d1" — страница жетона читает из D1, а если жетона там нет, то из главной базы.
// Нет привязки DB — всё работает как раньше. Ошибка D1 никогда не ломает ответ.
// ---------------------------------------------------------------
export const D1_COLS = ['owner_name', 'phone', 'pet_name', 'address', 'telegram_chat_id', 'status', 'link_token',
  'created_at', 'tag_url', 'source', 'scan_count', 'last_scan_at', 'last_scan_location'];
export const D1_PII = ['owner_name', 'phone', 'pet_name', 'address', 'telegram_chat_id', 'link_token', 'last_scan_location'];
export const D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tags (tag_id TEXT PRIMARY KEY, ${D1_COLS.map((c) => `${c} TEXT`).join(', ')}, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS tags_chat ON tags (telegram_chat_id)',
  'CREATE INDEX IF NOT EXISTS tags_token ON tags (link_token)',
  // Н2: счётчики воронки по дням (раньше — KV ev:<день>, тратили суточную квоту записей KV)
  'CREATE TABLE IF NOT EXISTS events (day TEXT NOT NULL, k TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, k))',
  // потолок событий сайта с одного адреса в сутки; хранится хеш адреса, не сам адрес
  'CREATE TABLE IF NOT EXISTS ev_ip (day TEXT NOT NULL, h TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, h))',
];
export const d1Schema = new WeakMap(); // таблица создаётся один раз на базу в каждом экземпляре воркера

export function d1On(env) { return !!(env && env.DB && typeof env.DB.prepare === 'function'); }

export async function d1Init(env) {
  let p = d1Schema.get(env.DB);
  if (!p) {
    p = env.DB.batch(D1_SCHEMA.map((s) => env.DB.prepare(s)));
    d1Schema.set(env.DB, p);
    p.catch(() => d1Schema.delete(env.DB));
  }
  return p;
}

export async function d1Put(env, t) {
  if (!t || t.tag_id === undefined || t.tag_id === null || t.tag_id === '') return;
  const v = (c) => {
    const x = c === 'scan_count' && t[c] === undefined ? t.scans : t[c];
    return x === undefined || x === null ? null : String(x);
  };
  await env.DB.prepare(
    `INSERT INTO tags (tag_id, ${D1_COLS.join(', ')}, updated_at) VALUES (?${', ?'.repeat(D1_COLS.length + 1)}) ` +
    `ON CONFLICT (tag_id) DO UPDATE SET ${D1_COLS.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(', ')}, updated_at = excluded.updated_at`,
  ).bind(String(t.tag_id), ...D1_COLS.map(v), new Date().toISOString()).run();
}

export async function d1Erase(env, id) {
  await env.DB.prepare(`UPDATE tags SET ${D1_PII.map((c) => `${c} = ''`).join(', ')}, status = 'deleted', updated_at = ? WHERE tag_id = ?`)
    .bind(new Date().toISOString(), String(id)).run();
}

/** Ответ главной базы → копия в D1. */
export async function d1Mirror(env, action, d, res) {
  if (!res || !res.ok) return;
  try {
    await d1Init(env);
    if (['register', 'getTag', 'logScan', 'linkTelegram'].includes(action) && res.tag && !res.conflict) await d1Put(env, res.tag);
    else if (action === 'getTag' && res.found === false) await d1Erase(env, d.id); // в главной базе жетона нет или он удалён
    else if (action === 'listByChat') for (const t of res.tags || []) await d1Put(env, t);
    else if (action === 'deleteTag' && res.deleted) await d1Erase(env, d.id);
  } catch (e) {
    console.error('D1 mirror failed', action, String(e && e.message || e));
    await bumpFail(env, 'd1');
  }
}

/** Жетон из D1 в том же виде, что отдаёт главная база; null — в D1 его нет или D1 недоступна. */
export async function d1Read(env, id) {
  try {
    await d1Init(env);
    const row = await env.DB.prepare('SELECT * FROM tags WHERE tag_id = ?').bind(String(id)).first();
    if (!row) return null;
    if (row.status === 'deleted') return { ok: true, found: false };
    const tag = { tag_id: row.tag_id };
    for (const c of D1_COLS) if (row[c] !== null && row[c] !== undefined) tag[c] = row[c];
    return { ok: true, found: true, tag };
  } catch (e) {
    console.error('D1 read failed', String(e && e.message || e));
    await bumpFail(env, 'd1');
    return null;
  }
}

export async function d1Status(env) {
  if (!d1On(env)) return 'not connected (optional for now)';
  try {
    await d1Init(env);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(status = 'deleted') AS del FROM tags").first();
    return `connected ✅ · ${r.n} tags copied (${r.del || 0} deleted) · reads: ${env.DB_READ === 'd1' ? 'D1 first' : 'main database'}`;
  } catch (e) { return `error: ${String(e && e.message || e)}`; }
}

export async function tg(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('TG error', method, JSON.stringify(data));
      if (!(data.error_code < 500 && data.error_code !== 429)) await bumpFail(env, 'tg'); // 400/403 (бот заблокирован) — не сбой
    }
    return data;
  } catch (e) {
    console.error('TG fetch failed', method, e);
    await bumpFail(env, 'tg');
    return { ok: false };
  }
}

export function send(env, chatId, text, replyMarkup) {
  const p = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) p.reply_markup = replyMarkup;
  return tg(env, 'sendMessage', p);
}

export function mainMenu(L = 'en') {
  return {
    keyboard: [[{ text: tr(L, 'btnRegister') }, { text: tr(L, 'btnMyTags') }], [{ text: tr(L, 'btnLost') }, { text: tr(L, 'btnSettings') }]],
    resize_keyboard: true,
  };
}
export function cancelKb(L = 'en') {
  return { keyboard: [[{ text: tr(L, 'btnCancel') }]], resize_keyboard: true };
}

export function siteBase(env, url) {
  return (env.SITE_URL || (url ? url.origin : '')).replace(/\/+$/, '');
}

/** Длинная ссылка — её пишут в NFC (старые метки продолжают работать). */
export function tagUrlBase(env, url) {
  return `${siteBase(env, url)}/tag/?id=`;
}

/** Короткая ссылка для QR и сообщений: /t/101 */
export function shortUrl(env, url, id) {
  return `${siteBase(env, url)}/t/${id}`;
}

/** Объявление «Потерялся» для групп и печати: /p/101 (открытие не считается сканом жетона) */
export function posterUrl(env, url, id) {
  return `${siteBase(env, url)}/p/${id}`;
}

// ---------------------------------------------------------------
// Н2: счётчики событий в D1. Одно событие — один SQL-запрос (прибавление на месте),
// поэтому два события в одну секунду оба посчитаны. Без D1 счётчики остаются в KV.
// ---------------------------------------------------------------
export const EV_IP_MAX = 60; // событий сайта с одного адреса в сутки

/** Прибавляет счётчики; true — записано в D1. */
export async function d1Bump(env, day, keys) {
  if (!d1On(env)) return false;
  try {
    await d1Init(env);
    await env.DB.batch(keys.map((k) => env.DB.prepare(
      'INSERT INTO events (day, k, n) VALUES (?, ?, 1) ON CONFLICT (day, k) DO UPDATE SET n = n + 1').bind(day, k)));
    return true;
  } catch (e) {
    console.error('D1 events', e);
    return false;
  }
}

/** Счётчики за дни: { день: { событие: n } }; без D1 или при сбое — пусто. */
export async function d1Events(env, days) {
  const out = {};
  if (!d1On(env) || !days.length) return out;
  try {
    await d1Init(env);
    const r = await env.DB.prepare(`SELECT day, k, n FROM events WHERE day IN (${days.map(() => '?').join(', ')})`).bind(...days).all();
    for (const row of r.results || []) (out[row.day] ||= {})[row.k] = Number(row.n) || 0;
  } catch (e) { console.error('D1 events read', e); }
  return out;
}

/** true — с этого адреса сегодня уже слишком много событий. Сбой D1 — пропускаем (сайт важнее счётчика). */
export async function evIpOver(env, day, ip) {
  if (!d1On(env) || !ip || ip === 'unknown') return false;
  try {
    await d1Init(env);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${ip}`));
    const h = [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const row = await env.DB.prepare(
      'INSERT INTO ev_ip (day, h, n) VALUES (?, ?, 1) ON CONFLICT (day, h) DO UPDATE SET n = n + 1 RETURNING n').bind(day, h).first();
    return !!row && Number(row.n) > EV_IP_MAX;
  } catch (e) {
    console.error('D1 ev_ip', e);
    return false;
  }
}

/** Ежедневно: старые записи потолка по адресам больше не нужны. */
export async function d1Cleanup(env, day) {
  if (!d1On(env)) return;
  try { await d1Init(env); await env.DB.prepare('DELETE FROM ev_ip WHERE day < ?').bind(day).run(); }
  catch (e) { console.error('D1 cleanup', e); }
}
