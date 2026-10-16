import { getOrder, saveOrder } from './api.js';
import { db, shortUrl, siteBase } from './db.js';
import { getExtras, kvOn, putExtras } from './store.js';
// ---------------------------------------------------------------
// Случайные коды жетонов (C4). Новый жетон получает код из 7 знаков (/t/K7QM2XA):
// номера идут подряд (101, 102…), а код не угадать перебором. Код хранится в доп. данных
// жетона (x:<номер>.code, попадает в резервную копию) и в KV k:<код> = номер.
// У жетона с кодом страница по номеру не открывается. Старые жетоны без кода работают по номеру.
// Алфавит без 0/O и 1/I: код читается с крышки, а QR из заглавных букв и цифр меньше.
// 7 знаков (35 бит) — предел для QR версии 2 (20 мм на крышке) с защитой Q: HTTPS://FINDY-PET.COM/<код>
// ровно 29 знаков. Первые коды 16.10 были из 8 знаков — они продолжают работать.
// ---------------------------------------------------------------
export const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 7;
export const CODE_RE = /^[A-HJ-NP-Z2-9]{7,8}$/;

export function randCode(n) {
  // 256 делится на 32 без остатка — все знаки равновероятны
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => CODE_ABC[b % CODE_ABC.length]).join('');
}

/** Выдаёт жетону новый код и записывает его в KV. Без KV или при TAG_CODES=0 — '' (жетон работает по номеру). */
export async function newTagCode(env, id, force) {
  if (!kvOn(env) || (env.TAG_CODES === '0' && !force)) return ''; // TAG_CODES=0 — выключатель: новые жетоны снова по номерам
  for (let i = 0; i < 5; i++) {
    const code = randCode(CODE_LEN);
    if ((await env.FYP_KV.get(`k:${code}`)) !== null) continue;
    await env.FYP_KV.put(`k:${code}`, String(id));
    return code;
  }
  return '';
}

/** Адрес из ссылки (номер или код) → номер жетона. '' — нет такого жетона или у него есть код, а пришёл номер. */
export async function tagRef(env, raw) {
  const s = String(raw || '').trim();
  if (/^\d{1,9}$/.test(s)) return (await getExtras(env, s)).code ? '' : s;
  const code = s.toUpperCase();
  if (!CODE_RE.test(code) || !kvOn(env)) return '';
  try { return (await env.FYP_KV.get(`k:${code}`)) || ''; } catch (e) { console.error('kv code', e); return ''; }
}

/**
 * /code 101 — админ даёт код жетону, который ещё не напечатан (например, 101 и 102).
 * После этого /t/101 больше не открывается, работает только новая ссылка.
 */
export async function adminTagCode(env, url, text) {
  const m = /^\/code\s+(\d{1,9})\s*$/.exec(text);
  if (!m) return 'Write: /code 101 — gives tag 101 a random code. Only for a tag that is not printed yet: after this /t/101 stops working.';
  if (!kvOn(env)) return 'No storage connected.';
  const id = m[1];
  const x = await getExtras(env, id);
  if (x.code) return `Tag #${id} already has a code: ${shortUrl(env, url, x.code)}`;
  const r = await db(env, 'getTag', { id });
  if (!r.ok) return '⚠️ The table did not answer. Try again in a minute.';
  if (!r.found) return `Tag #${id} is not in the table.`;
  const code = await newTagCode(env, id, true);
  if (!code) return '⚠️ Could not create a code. Try again.';
  await putExtras(env, id, { code });
  const o = x.order_id ? await getOrder(env, x.order_id) : null;
  const it = o && o.items.find((i) => i.tag_id === id);
  if (it) { it.code = code; await saveOrder(env, o); }
  const link = shortUrl(env, url, code);
  return `✅ Tag #${id} now opens only by its code.\n✍️ NFC: <code>${esc(link)}</code>\n🔳 QR: <code>${esc(qrText(env, url, code))}</code>\n` +
    `The old link /t/${id} no longer works.`;
}

/** Текст QR на крышке: заглавными (режим букв и цифр — QR меньше). С кодом — без /T/, с номером — /T/<номер>. */
export function qrText(env, url, key) {
  const base = siteBase(env, url).toUpperCase();
  return /^\d+$/.test(String(key)) ? `${base}/T/${key}` : `${base}/${key}`;
}

/** Что ставить в адрес жетона: код, если он есть, иначе номер. */
export async function tagKey(env, id, x) {
  return (x || await getExtras(env, id)).code || String(id);
}

/** Приводит номер к формату +972XXXXXXXXX. Возвращает '' если номер некорректный. */
export function normalizePhone(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (/e\+?\d/i.test(s) && isFinite(Number(s))) s = String(Math.round(Number(s))); // 5.0E8 из таблицы
  let d = s.replace(/[^\d+]/g, '');
  const plus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (!d) return '';
  if (plus) return d.length >= 8 && d.length <= 15 ? '+' + d : '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('972')) { /* already international */ }
  else if (d.startsWith('0')) d = '972' + d.slice(1);
  else if (d.length === 8 || d.length === 9) d = '972' + d; // 50xxxxxxx без нуля
  return d.length >= 8 && d.length <= 15 ? '+' + d : '';
}

export function prettyPhone(p) {
  let m = /^\+972(5\d)(\d{3})(\d{4})$/.exec(p);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  m = /^\+972(\d)(\d{3})(\d{4})$/.exec(p);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  return p;
}

export const LOCALES = { en: 'en-GB', he: 'he-IL', ru: 'ru-RU' };
export function fmtTime(env, L = 'en') {
  return new Date().toLocaleString(LOCALES[L] || 'en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Jerusalem', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function str(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

export function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Текст, который уходит в Google-таблицу: не начинается с = + - @ (иначе таблица считает его формулой). */
export function cell(v, max) {
  return str(v, max + 10).replace(/^[=+\-@\s]+/, '').slice(0, max);
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** true — лимит исчерпан. Бинд не настроен или сломался — пропускаем запрос (сайт важнее лимита). */
export async function limited(env, binding, key) {
  const rl = env && env[binding];
  if (!rl || typeof rl.limit !== 'function') return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch (e) {
    console.error('ratelimit', binding, e);
    return false;
  }
}

/** POST в API принимаем только как JSON и только со своих страниц (findy-pet.com, тестовый сайт, workers.dev). */
export function checkOrigin(request, env, url) {
  if (request.method !== 'POST') return null;
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return json({ success: false, error: 'bad_content_type' }, env, 415);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin && origin !== siteBase(env, url)) {
    return json({ success: false, error: 'forbidden_origin' }, env, 403);
  }
  return null;
}

export function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || env.SITE_URL || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function json(obj, env, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env) },
  });
}
