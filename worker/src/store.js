import { bumpFail, publicTag } from './api.js';
import { mainMenu, send } from './db.js';
import { REMINDER_DAYS, ownerLang, tr } from './i18n.js';
import { json, normalizePhone } from './util.js';
// ---------------------------------------------------------------
// KV: доп. данные метки и резервный кэш страницы
// ---------------------------------------------------------------
export function kvOn(env) { return !!(env && env.FYP_KV); }

export async function getExtras(env, id) {
  if (!kvOn(env)) return {};
  try { return (await env.FYP_KV.get(`x:${id}`, 'json')) || {}; } catch (e) { console.error('kv get', e); return {}; }
}

export async function putExtras(env, id, patch) {
  if (!kvOn(env)) return false;
  try {
    const cur = await getExtras(env, id);
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    await env.FYP_KV.put(`x:${id}`, JSON.stringify(next));
    return next;
  } catch (e) { console.error('kv put', e); return false; }
}

/** Сохраняем публичную карточку, чтобы страница метки открылась даже при сбое таблицы. */
export async function cachePublic(env, tag) {
  const data = publicTag(tag, env);
  const body = JSON.stringify(data);
  try {
    if (kvOn(env)) await env.FYP_KV.put(`c:${tag.tag_id}`, body);
    else if (typeof caches !== 'undefined') {
      await caches.default.put(`https://fyp-cache.internal/c/${tag.tag_id}`,
        new Response(body, { headers: { 'Cache-Control': 'max-age=2592000' } }));
    }
  } catch (e) { console.error('cache put', e); }
}

export async function getCachedPublic(env, id) {
  try {
    if (kvOn(env)) return await env.FYP_KV.get(`c:${id}`, 'json');
    if (typeof caches !== 'undefined') {
      const res = await caches.default.match(`https://fyp-cache.internal/c/${id}`);
      if (res) return await res.json();
    }
  } catch (e) { console.error('cache get', e); }
  return null;
}

export async function rememberChat(env, chatId) {
  if (!kvOn(env)) return;
  try {
    const key = `chat:${chatId}`;
    if (!(await env.FYP_KV.get(key))) {
      await env.FYP_KV.put(key, JSON.stringify({ since: new Date().toISOString(), last_reminder: new Date().toISOString() }));
    }
  } catch (e) { console.error('rememberChat', e); }
}

export async function sendReminders(env) {
  if (!kvOn(env)) return;
  const now = Date.now();
  let cursor;
  do {
    const page = await env.FYP_KV.list({ prefix: 'chat:', cursor });
    for (const k of page.keys) {
      const rec = (await env.FYP_KV.get(k.name, 'json')) || {};
      const last = Date.parse(rec.last_reminder || rec.since || 0) || 0;
      if (now - last < REMINDER_DAYS * 86400000) continue;
      const chatId = k.name.slice(5);
      const L = await ownerLang(env, chatId);
      const res = await send(env, chatId, tr(L, 'reminder'), mainMenu(L));
      rec.last_reminder = new Date().toISOString();
      if (!res.ok) rec.failed = (rec.failed || 0) + 1;
      await env.FYP_KV.put(k.name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---------------------------------------------------------------
// Резервная копия данных из KV (заказы, доп. данные жетонов, лист ожидания Care, языки чатов)
// раз в день — файлом админу в Telegram. Таблица Google хранится у Google и сюда не входит.
// ---------------------------------------------------------------
export const BACKUP_PREFIXES = ['o:', 'x:', 'k:', 'care:', 'lang:', 'chat:', 'tok:', 'story:'];
export async function dailyBackup(env) {
  if (!kvOn(env) || !env.ADMIN_CHAT_ID) return;
  const data = {};
  let n = 0;
  for (const prefix of BACKUP_PREFIXES) {
    let cursor;
    do {
      const page = await env.FYP_KV.list({ prefix, cursor });
      for (const k of page.keys) {
        if (n >= 900) break; // лимит операций KV на один запуск
        const v = await env.FYP_KV.get(k.name);
        n++;
        try { data[k.name] = JSON.parse(v); } catch { data[k.name] = v; }
      }
      cursor = page.list_complete || n >= 900 ? undefined : page.cursor;
    } while (cursor);
  }
  const day = new Date().toLocaleDateString('en-CA', { timeZone: env.TIMEZONE || 'Asia/Jerusalem' });
  const body = JSON.stringify({ created_at: new Date().toISOString(), keys: n, truncated: n >= 900, data }, null, 1);
  const form = new FormData();
  form.append('chat_id', String(env.ADMIN_CHAT_ID));
  form.append('caption', `🗄 FindYpet backup ${day}: ${n} records (orders, tag extras, Care waitlist, chats).`);
  form.append('disable_notification', 'true');
  form.append('document', new Blob([body], { type: 'application/json' }), `findypet-backup-${day}.json`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
    const d = await res.json();
    if (!d.ok) { console.error('backup send', JSON.stringify(d)); await bumpFail(env, 'backup'); }
  } catch (e) { console.error('backup send failed', e); await bumpFail(env, 'backup'); }
}

// ---------------------------------------------------------------
// SMS-резерв (Twilio). Включается, только если заданы TWILIO_*.
// ---------------------------------------------------------------
export function smsEnabled(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

export async function sendSms(env, to, body) {
  const phone = normalizePhone(to);
  if (!smsEnabled(env) || !phone) return false;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: env.TWILIO_FROM, Body: body.slice(0, 600) }),
    });
    if (!res.ok) { console.error('SMS error', res.status, (await res.text()).slice(0, 300)); await bumpFail(env, 'sms'); }
    return res.ok;
  } catch (e) {
    console.error('SMS failed', e);
    await bumpFail(env, 'sms');
    return false;
  }
}
