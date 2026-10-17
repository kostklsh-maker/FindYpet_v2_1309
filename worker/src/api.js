import { notifyAdmin } from './admin.js';
import { linkFromSite } from './bot.js';
import { d1Bump, d1Events, d1On, db, evIpOver, mainMenu, send, shortUrl, tagUrlBase, tg } from './db.js';
import { chatLang, keepChatLang, mapsLine, ownerLang, tr } from './i18n.js';
import { PRICING, feats, normQty, orderPrice } from './pricing.js';
import { cachePublic, getCachedPublic, getExtras, kvOn, putExtras, rememberChat, sendSms, smsEnabled } from './store.js';
import { cell, clientIp, esc, fmtTime, json, limited, newTagCode, normalizePhone, prettyPhone, randCode, str, tagKey, tagRef } from './util.js';
import { isTestSite } from './worker.js';
// ---------------------------------------------------------------
// Site API
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Воронка заказа: сайт присылает 4 события, счётчики по дням лежат в D1 (таблица events, Н2);
// без D1 и в старых днях — в KV (ev:ГГГГ-ММ-ДД). Чтение складывает оба места.
// Админ видит итог командой /stats. Посещения считает Cloudflare Web Analytics.
// Воронка нашедшего (B12): страница жетона присылает f_call, f_wa, f_geo; f_tg и scan считает сам Worker.
// ---------------------------------------------------------------
export const EVENTS = ['plan', 'form', 'submit', 'tg', 'f_call', 'f_wa', 'f_geo'];

export async function apiEvent(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const e = String(b.e || '');
  if (!EVENTS.includes(e)) return json({ success: false }, env, 400);
  const lang = ['en', 'he', 'ru'].includes(b.lang) ? b.lang : 'en';
  const day = ilDay(env, Date.now());
  if (kvOn(env) || d1On(env)) {
    ctx.waitUntil((async () => {
      if (await evIpOver(env, day, clientIp(request))) return; // один адрес не накручивает воронку
      await bumpEvent(env, e, lang);
    })());
  }
  return json({ success: true }, env);
}

export async function bumpEvent(env, e, lang) {
  const day = ilDay(env, Date.now());
  if (await d1Bump(env, day, lang ? [e, `${e}_${lang}`] : [e])) return;
  if (!kvOn(env)) return;
  const key = `ev:${day}`;
  try {
    const cur = (await env.FYP_KV.get(key, 'json')) || {};
    cur[e] = (cur[e] || 0) + 1;
    if (lang) cur[`${e}_${lang}`] = (cur[`${e}_${lang}`] || 0) + 1;
    await env.FYP_KV.put(key, JSON.stringify(cur), { expirationTtl: 400 * 86400 });
  } catch (err) { console.error('event', err); }
}

/** Счётчики за дни (в том же порядке): D1 + старые дни из KV. 30 чтений KV — в пределах 50 подзапросов. */
export async function readEvents(env, days) {
  const [d1, kv] = await Promise.all([
    d1Events(env, days),
    Promise.all(days.map((d) => (kvOn(env) ? env.FYP_KV.get(`ev:${d}`, 'json').catch(() => null) : null))),
  ]);
  return days.map((d, i) => {
    const a = kv[i], b = d1[d];
    if (!a && !b) return null;
    const t = { ...(a || {}) };
    for (const k of Object.keys(b || {})) t[k] = (t[k] || 0) + b[k];
    return t;
  });
}

/** /stats для админа: воронка за 7 и 30 дней. */
export async function funnelStats(env) {
  if (!kvOn(env)) return 'No storage connected.';
  // 30 чтений KV за раз (лимит бесплатного плана — 50 подзапросов на вызов)
  const days = await readEvents(env, Array.from({ length: 30 }, (_, i) => ilDay(env, Date.now() - i * 86400000)));
  const sum = async (n) => {
    const tot = {};
    for (const v of days.slice(0, n)) for (const k of Object.keys(v || {})) tot[k] = (tot[k] || 0) + v[k];
    return tot;
  };
  const line = (t, title) => {
    const n = (k) => t[k] || 0;
    const pct = (a, b) => (n(b) ? ` (${Math.round((n(a) / n(b)) * 100)}%)` : '');
    const langs = (k) => ['he', 'ru', 'en'].map((l) => `${l} ${n(`${k}_${l}`)}`).join(' · ');
    return `<b>${title}</b>\n` +
      `Chose a plan: ${n('plan')}  (${langs('plan')})\n` +
      `Started the form: ${n('form')}${pct('form', 'plan')}\n` +
      `Sent an order: ${n('submit')}${pct('submit', 'form')}  (${langs('submit')})\n` +
      `Opened Telegram after order: ${n('tg')}${pct('tg', 'submit')}`;
  };
  return '📊 Order funnel on the site\n\n' + line(await sum(7), 'Last 7 days') + '\n\n' + line(await sum(30), 'Last 30 days') +
    '\n\nVisits: Cloudflare dashboard → Web Analytics.';
}

// ---------------------------------------------------------------
// Реклама (B12): откуда пришёл заказ и сколько стоит заказ из рекламы.
// Сайт запоминает метку первого захода из рекламы (utm_source/utm_campaign, gclid, fbclid, ttclid)
// и присылает её с заказом (src). Расходы админ вносит в боте: /spend 120 facebook.
// ---------------------------------------------------------------
export function adSrc(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z0-9_./-]/g, '').slice(0, 60);
  return /^[a-z0-9]/.test(s) ? s : '';
}
export const adKey = (src) => src.split('/')[0]; // facebook/autumn → facebook

export async function adSpend(env, text) {
  if (!kvOn(env)) return 'No storage connected.';
  const m = text.match(/^\/spend\s+(-?\d+(?:[.,]\d+)?)(?:\s+(\S+))?\s*$/);
  if (m) {
    const sum = Math.round(Number(m[1].replace(',', '.')) * 100) / 100;
    const src = adKey(adSrc(m[2] || 'ads') || 'ads');
    if (!sum || Math.abs(sum) > 100000) return 'Amount must be a number, for example: /spend 120 facebook';
    const key = `sp:${ilDay(env, Date.now())}`;
    const cur = (await env.FYP_KV.get(key, 'json')) || {};
    cur[src] = Math.round(((cur[src] || 0) + sum) * 100) / 100;
    await env.FYP_KV.put(key, JSON.stringify(cur), { expirationTtl: 400 * 86400 });
    return `✅ Ad spend today: ${src} ${cur[src]} ${PRICING.currency}\nTo fix a mistake, send a minus: /spend -${Math.abs(sum)} ${src}`;
  }
  if (text.trim() !== '/spend') return 'Write: /spend 120 facebook (amount in ₪, then where the ad ran)';
  const days = Array.from({ length: 7 }, (_, i) => ilDay(env, Date.now() - i * 86400000));
  const t = addUp(await Promise.all(days.map((d) => env.FYP_KV.get(`sp:${d}`, 'json').catch(() => null))));
  const list = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k} ${v} ${PRICING.currency}`).join(' · ');
  return `📣 Ad spend, last 7 days: ${list || 'nothing yet'}\n\nAdd: /spend 120 facebook (amount in ₪, then where the ad ran).\n` +
    'In the ad link add ?utm_source=facebook — then orders from it are counted. The weekly summary shows the cost per order.';
}

export function addUp(list) {
  return list.reduce((t, v) => { for (const k of Object.keys(v || {})) t[k] = (t[k] || 0) + v[k]; return t; }, {});
}

/** Сбои для недельной сводки: db (таблица), tg (Telegram), sms, backup, server. Только на рабочем сайте. */
export async function bumpFail(env, kind) {
  if ((kvOn(env) || d1On(env)) && !isTestSite(env)) await bumpEvent(env, `err_${kind}`);
}

// ---------------------------------------------------------------
// Недельная сводка админу (B10): каждое воскресенье утром (cron) и по команде /week.
// Неделя — 7 полных дней до сегодняшнего (по времени Израиля), сравнение с 7 днями до неё.
// Заказы берутся из KV (o:FY…), остальное — из дневных счётчиков ev:<день>.
// ---------------------------------------------------------------
export const WEEKLY_CRON = '30 6 * * SUN'; // как в worker/wrangler.toml
export const DAILY_CRON = '0 7 * * *';
export const QUEUE_CRON = '*/10 * * * *';
export const QUEUE_CRON_TEST = '0 * * * *'; // тестовый сайт проверяет очередь раз в час (Н2)
export const FAIL_KINDS = { db: 'database', d1: 'D1 copy', tg: 'Telegram', sms: 'SMS', backup: 'backup', server: 'server' };

export function ilDay(env, ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: env.TIMEZONE || 'Asia/Jerusalem' });
}

export async function weeklyDigest(env, now) {
  if (!kvOn(env) || !env.ADMIN_CHAT_ID) return;
  const wd = new Date(now).toLocaleDateString('en-US', { weekday: 'short', timeZone: env.TIMEZONE || 'Asia/Jerusalem' });
  if (wd !== 'Sun') return;
  const mark = `wk:${ilDay(env, now)}`;
  if (await env.FYP_KV.get(mark)) return; // уже отправлена сегодня
  await env.FYP_KV.put(mark, '1', { expirationTtl: 8 * 86400 });
  await send(env, env.ADMIN_CHAT_ID, await weeklyText(env, now));
}

export async function weeklyText(env, now) {
  const dayMs = 86400000;
  const daysOf = (from) => Array.from({ length: 7 }, (_, i) => ilDay(env, now - (from + i) * dayMs));
  const cur = daysOf(1), prev = daysOf(8);
  const evs = await readEvents(env, [...cur, ...prev]);
  const ev = [addUp(evs.slice(0, 7)), addUp(evs.slice(7))];
  const sps = await Promise.all([...cur, ...prev].map((d) => env.FYP_KV.get(`sp:${d}`, 'json').catch(() => null)));
  const sp = [addUp(sps.slice(0, 7)), addUp(sps.slice(7))];

  // Заказы за две недели (лимит чтений KV на запуск — как у резервной копии)
  const wk = new Map([...cur.map((d) => [d, 0]), ...prev.map((d) => [d, 1])]);
  const ord = [0, 1].map(() => ({ n: 0, site: 0, bot: 0, q1: 0, q2: 0, q4: 0, tags: 0, sum: 0, care: 0, ad: {} }));
  let reads = 0, cursor;
  do {
    const page = await env.FYP_KV.list({ prefix: 'o:', cursor });
    for (const k of page.keys) {
      if (reads >= 600) break;
      reads++;
      const o = await env.FYP_KV.get(k.name, 'json').catch(() => null);
      const at = o && Date.parse(o.created_at);
      if (!at) continue; // нет даты или она не читается
      const w = wk.get(ilDay(env, at));
      if (w === undefined) continue;
      const s = ord[w];
      const tags = Number(o.tags_total) || (o.items || []).reduce((n, i) => n + (i.copies || 1), 0);
      s.n++; s[o.source === 'telegram' ? 'bot' : 'site']++;
      s[tags >= PRICING.bundle ? 'q4' : tags === 2 ? 'q2' : 'q1']++;
      s.tags += tags; s.sum += Number(o.price) || 0;
      if (o.care_interest) s.care++;
      if (o.ad_src) s.ad[adKey(o.ad_src)] = (s.ad[adKey(o.ad_src)] || 0) + 1;
    }
    cursor = page.list_complete || reads >= 600 ? undefined : page.cursor;
  } while (cursor);

  const was = (b) => ` <i>(prev ${b})</i>`;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const [o, op] = ord;
  const n = (i, k) => ev[i][k] || 0;
  const fails = (i) => Object.keys(FAIL_KINDS).reduce((t, k) => t + n(i, `err_${k}`), 0);
  const failLine = Object.entries(FAIL_KINDS).filter(([k]) => n(0, `err_${k}`)).map(([k, name]) => `${name} ${n(0, `err_${k}`)}`).join(' · ');
  const fmt = (d) => d.slice(8, 10) + '.' + d.slice(5, 7);
  const finder = (i) => n(i, 'f_call') + n(i, 'f_wa') + n(i, 'f_tg') + n(i, 'f_geo');
  // Реклама: расходы (/spend) и заказы с меткой рекламы; цена заказа = расходы / заказы из рекламы
  const cur$ = PRICING.currency;
  const adSum = (i) => Object.values(sp[i]).reduce((a, b) => a + b, 0);
  const adN = (i) => Object.values(ord[i].ad).reduce((a, b) => a + b, 0);
  const cpo = (i) => (adN(i) ? `${Math.round(adSum(i) / adN(i))} ${cur$}` : '—');
  function adLine() {
    if (!adSum(0) && !adN(0) && !adSum(1) && !adN(1)) return '';
    const srcs = [...new Set([...Object.keys(sp[0]), ...Object.keys(ord[0].ad)])].sort();
    const by = srcs.map((k) => `${k}: ${ord[0].ad[k] || 0} orders / ${Math.round(sp[0][k] || 0)} ${cur$}`).join(' · ');
    return `📣 Ads: spend ${Math.round(adSum(0))} ${cur$} · orders from ads ${adN(0)} · cost per order ${cpo(0)}${was(cpo(1))}\n` +
      (by ? `   ${by}\n` : '');
  }
  return `📈 <b>FindYpet weekly summary</b> · ${fmt(cur[6])}–${fmt(cur[0])}\n\n` +
    `🧾 Orders: <b>${o.n}</b> (site ${o.site} · bot ${o.bot})${was(op.n)}\n` +
    `   1 tag ×${o.q1} · 2 tags ×${o.q2} · 3 + 1 ×${o.q4}\n` +
    `   3 + 1 share: ${pct(o.q4, o.n)}${was(pct(op.q4, op.n))}\n` +
    `   Tags: ${o.tags} · at list price: ${o.sum} ${PRICING.currency}${was(`${op.sum} ${PRICING.currency}`)}\n` +
    `💰 Marked paid: ${n(0, 'paid')}${was(n(1, 'paid'))}\n` +
    `📲 Telegram linked after a site order: ${n(0, 'link')}${was(n(1, 'link'))}\n` +
    `🔎 Finder: tag page opened ${n(0, 'scan')} → call ${n(0, 'f_call')} · WhatsApp ${n(0, 'f_wa')} · ` +
    `Telegram ${n(0, 'f_tg')} · location ${n(0, 'f_geo')}${was(`${n(1, 'scan')} → ${finder(1)}`)}\n` +
    `🏠 Back home after Lost mode: ${n(0, 'home')} · stories shared: ${n(0, 'story')}${was(`${n(1, 'home')} · ${n(1, 'story')}`)}\n` +
    adLine() +
    `💚 Care waitlist: +${n(0, 'care') + o.care} (bot ${n(0, 'care')} · order form ${o.care})${was(n(1, 'care') + op.care)}\n` +
    `⚠️ Failures: ${fails(0)}${failLine ? ` (${failLine})` : ''}${was(fails(1))}\n\n` +
    `<b>Site funnel</b>: chose a plan ${n(0, 'plan')} → started the form ${n(0, 'form')} → sent an order ${n(0, 'submit')}` +
    `${was(`${n(1, 'plan')} → ${n(1, 'form')} → ${n(1, 'submit')}`)}\n` +
    'Visits: Cloudflare dashboard → Web Analytics.';
}

export async function apiRegister(request, env, url, ctx) {
  const b = await request.json().catch(() => ({}));
  const owner = cell(b.owner_name, 80);
  const pet = cell(b.pet_name, 40);
  const address = cell(b.address, 200);
  const phone = normalizePhone(b.phone);
  const phone2Raw = str(b.phone2, 30);
  const phone2 = phone2Raw ? normalizePhone(phone2Raw) : '';
  const notes = str(b.notes, 200);
  if (!owner || !pet || !address) return json({ success: false, error: 'Please fill in all fields.', error_code: 'fill' }, env, 400);
  if (!phone) return json({ success: false, error: 'Please enter a valid phone number.', error_code: 'phone' }, env, 400);
  if (phone2Raw && !phone2) return json({ success: false, error: 'Second phone is not valid.', error_code: 'phone2' }, env, 400);
  if (b.consent !== true) return json({ success: false, error: 'Consent is required.', error_code: 'consent' }, env, 400);
  // 1, 2 или 4 (3 + 1) жетона. Очень старая страница могла прислать plan — Семейный = набор.
  const qty = normQty(b.tags !== undefined ? b.tags : (b.plan === 'family' ? PRICING.bundle : 1));
  const lang = ['en', 'he', 'ru'].includes(b.lang) ? b.lang : 'en';

  const items = orderItems(qty, pet, b.pets, b.spare_for);
  // Несколько питомцев: у каждого свой второй контакт и заметки (pet_extras[i] — для i-го питомца)
  if (Array.isArray(b.pet_extras)) {
    for (let i = 0; i < items.length; i++) {
      const e = b.pet_extras[i] || {};
      const raw = str(e.phone2, 30);
      const p2 = raw ? normalizePhone(raw) : '';
      if (raw && !p2) return json({ success: false, error: 'Second phone is not valid.', error_code: 'phone2' }, env, 400);
      items[i].phone2 = p2;
      items[i].notes = str(e.notes, 200);
    }
  }
  // Защита от ботов (Cloudflare Turnstile) — включается секретом TURNSTILE_SECRET
  if (env.TURNSTILE_SECRET && !(await turnstileOk(env, b.ts, request))) {
    return json({ success: false, error: 'Captcha failed.', error_code: 'captcha' }, env, 403);
  }
  // Повтор того же нажатия (сеть оборвалась, двойной клик) не создаёт второй заказ: ключ idem живёт 10 минут
  const idem = /^[A-Za-z0-9-]{8,64}$/.test(String(b.idem || '')) && kvOn(env) ? `idem:${b.idem}` : '';
  if (idem) {
    const prev = await env.FYP_KV.get(idem);
    if (prev === 'pending') return json({ success: false, error: 'Order is being created.', error_code: 'busy' }, env, 409);
    if (prev) return json(JSON.parse(prev), env);
    await env.FYP_KV.put(idem, 'pending', { expirationTtl: 120 });
  }
  const args = {
    source: 'site', qty, lang, owner_name: owner, phone, address, items, phone2, notes,
    care_interest: b.care === true,
    ad_src: adSrc(b.src),
    // 3 жетона присылала только страница 2 + 1, открытая до 07.10 (там было «98 ₪») — админ уточнит цену
    old_offer: Number(b.tags) === 3,
  };
  const res = await createOrder(env, url, args);
  if (!res.ok && kvOn(env)) {
    // Таблица не ответила: заказ ждёт в очереди и запишется сам, клиент получает ссылку на бота сразу
    const qid = await queueOrder(env, url, args);
    const out = { success: true, queued: true, order_id: `Q${qid}`, tags: [], telegram_link: `https://t.me/${env.BOT_USERNAME}?start=q_${qid}` };
    if (idem) await env.FYP_KV.put(idem, JSON.stringify(out), { expirationTtl: 600 });
    ctx.waitUntil(send(env, env.ADMIN_CHAT_ID,
      `⏳ <b>Site order Q${qid} is queued</b> — the table did not answer. It is retried every 10 minutes for ${Q_HOURS} hours; ` +
      `you get a message when it is written.\n👤 ${esc(owner)} · 📱 ${esc(prettyPhone(phone))} · 🐾 ${esc(pet)} · ${qty} tag(s)`));
    return json(out, env);
  }
  if (!res.ok) {
    if (idem) await env.FYP_KV.delete(idem);
    ctx.waitUntil(alertAdmin(env, `order:${phone}`,
      `⚠️ <b>Site order FAILED</b> — the table did not answer, the customer saw "try again".\n` +
      `👤 ${esc(owner)} · 📱 ${esc(prettyPhone(phone))} · 🐾 ${esc(pet)} · ${normQty(b.tags)} tag(s)\nCall them if no new order arrives soon.`));
    return json({ success: false, error: 'Database error. Please try again.', error_code: 'db' }, env, 502);
  }
  ctx.waitUntil(Promise.all(res.tags.map((t) => cachePublic(env, t))));
  const first = res.tags[0];

  const out = {
    success: true,
    order_id: res.order.order_id,
    total_tags: res.order.tags_total,
    price: res.order.price,
    tags: res.order.items.map((i) => ({ id_tag: i.tag_id, pet_name: i.pet_name, copies: i.copies, tag_url: shortUrl(env, url, i.code || i.tag_id) })),
    // первый жетон — для совместимости со старым кодом страницы
    id_tag: first.tag_id,
    tag_url: shortUrl(env, url, res.order.items[0].code || first.tag_id),
    telegram_link: `https://t.me/${env.BOT_USERNAME}?start=${first.link_token}`,
  };
  if (idem) await env.FYP_KV.put(idem, JSON.stringify(out), { expirationTtl: 600 });
  return json(out, env);
}

/** /setup: включена ли защита формы и подходит ли секретный ключ (проверка пустым токеном — заказ не создаётся). */
export async function turnstileStatus(env) {
  const site = !!(env.TURNSTILE_SITE_KEY && /^[\w-]{8,64}$/.test(env.TURNSTILE_SITE_KEY));
  if (!env.TURNSTILE_SECRET && !site) return 'off (optional): TURNSTILE_SITE_KEY and TURNSTILE_SECRET not set';
  if (!site) return 'TURNSTILE_SITE_KEY missing or invalid — the form shows no captcha, so every order will be refused ❌';
  if (!env.TURNSTILE_SECRET) return 'TURNSTILE_SECRET missing — the captcha shows but is not checked on the server ⚠️';
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: 'setup-check' }),
    });
    const codes = ((await r.json())['error-codes'] || []).join(',');
    if (/invalid-input-secret|missing-input-secret/.test(codes)) return 'TURNSTILE_SECRET is wrong (Cloudflare rejected it) ❌';
    return 'on ✅ site key and secret accepted by Cloudflare';
  } catch (e) {
    return 'on, but Cloudflare could not be reached to check the secret ⚠️';
  }
}

/** Cloudflare Turnstile: проверка токена с формы заказа. */
export async function turnstileOk(env, token, request) {
  if (!token || String(token).length > 2048) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token), remoteip: clientIp(request) }),
    });
    const d = await r.json();
    return !!d.success;
  } catch (e) {
    console.error('turnstile', e);
    return true; // сервис проверки недоступен — заказ важнее (лимит частоты всё равно действует)
  }
}

/** Сигнал админу о сбое (не чаще раза в 10 минут на один ключ). */
export async function alertAdmin(env, key, text) {
  if (!env.ADMIN_CHAT_ID) return;
  if (kvOn(env)) {
    const k = `alert:${key}`;
    try { if (await env.FYP_KV.get(k)) return; await env.FYP_KV.put(k, '1', { expirationTtl: 600 }); } catch (e) { /* без замка */ }
  }
  await send(env, env.ADMIN_CHAT_ID, text);
}

// ---------------------------------------------------------------
// Очередь заказов (C3). Таблица не ответила — заказ сохраняется в KV (pq:<id>) и записывается позже:
// каждые 10 минут (cron), паузы растут до 2 часов, всего до Q_HOURS часов. Клиент сразу получает
// ссылку на бота (start=q_<id>). Нажал Start раньше записи — бот запоминает чат и потом сам
// привязывает жетоны и присылает подтверждение. Записанный заказ: pqd:<id> = ссылка активации.
// ---------------------------------------------------------------
export const Q_HOURS = 48;

export function queueId() { return randCode(8); }

export async function queueOrder(env, url, o) {
  const qid = queueId();
  const now = Date.now();
  const q = { qid, o, origin: url.origin, at: now, tries: 0, next: now + 10 * 60000, chat_id: '' };
  await env.FYP_KV.put(`pq:${qid}`, JSON.stringify(q), { expirationTtl: (Q_HOURS + 24) * 3600 });
  await env.FYP_KV.put(Q_FLAG, String(now), { expirationTtl: (Q_HOURS + 48) * 3600 });
  return qid;
}

// Н2: флаг «в очереди есть заказы». Без него cron не делает list (лимит list-запросов KV — 1000 в сутки на аккаунт).
export const Q_FLAG = 'pq_on';

export async function processQueue(env, now = Date.now(), force = false) {
  if (!kvOn(env)) return;
  const flag = await env.FYP_KV.get(Q_FLAG);
  if (flag === null && !force) return; // раз в сутки (force) — проверка без флага: на случай потерянного флага
  const page = await env.FYP_KV.list({ prefix: 'pq:', limit: 20 });
  // очередь пуста — снимаем флаг; свежий не трогаем (заказ мог встать в очередь только что, а list его ещё не видит)
  if (!page.keys.length && flag !== null && now - Number(flag) > 15 * 60000) await env.FYP_KV.delete(Q_FLAG);
  if (page.keys.length && flag === null) await env.FYP_KV.put(Q_FLAG, String(now), { expirationTtl: (Q_HOURS + 48) * 3600 });
  for (const k of page.keys) {
    const q = await env.FYP_KV.get(k.name, 'json').catch(() => null);
    if (!q) continue;
    const url = new URL(q.origin);
    const pet = esc((q.o.items[0] || {}).pet_name || '');
    // уже записан (Start нажали в ту же минуту) — только привязываем чат
    const done = await env.FYP_KV.get(`pqd:${q.qid}`);
    if (done !== null) {
      await env.FYP_KV.delete(k.name);
      if (q.chat_id && done) await linkFromSite(q.chat_id, done, env, url, null);
      continue;
    }
    if (q.next > now) continue;
    const res = await createOrder(env, url, q.o);
    if (res.ok) {
      const token = res.tags[0].link_token || '';
      await env.FYP_KV.put(`pqd:${q.qid}`, token, { expirationTtl: 30 * 86400 });
      await env.FYP_KV.delete(k.name);
      await Promise.all(res.tags.map((t) => cachePublic(env, t)));
      await send(env, env.ADMIN_CHAT_ID, `✅ Queued order Q${q.qid} is written: <b>${res.order.order_id}</b> (attempt ${q.tries + 1}).` +
        (q.chat_id ? ' The customer already pressed Start and gets the confirmation now.' : ' The customer has not opened the bot yet.'));
      if (q.chat_id && token) await linkFromSite(q.chat_id, token, env, url, null);
      continue;
    }
    q.tries++;
    if (now - q.at >= Q_HOURS * 3600000) {
      await env.FYP_KV.delete(k.name);
      const o = q.o;
      await send(env, env.ADMIN_CHAT_ID,
        `❌ <b>Queued order Q${q.qid} was NOT written</b> after ${q.tries} attempts in ${Q_HOURS} hours. Create it by hand and call the customer.\n` +
        `👤 ${esc(o.owner_name)} · 📱 ${esc(prettyPhone(o.phone))}\n🏠 ${esc(o.address)}\n` +
        `🐾 ${o.items.map((i) => `${esc(i.pet_name)} ×${i.copies}`).join(', ')} · ${o.qty} tag(s)` +
        (o.phone2 ? `\n📱2 ${esc(prettyPhone(o.phone2))}` : '') + (o.notes ? `\n📝 ${esc(o.notes)}` : ''));
      if (q.chat_id) await send(env, q.chat_id, tr(await chatLang(env, q.chat_id), 'queuedFail', { pet }));
      continue;
    }
    q.next = now + Math.min(120, 10 * 2 ** Math.min(q.tries, 4)) * 60000; // 20, 40, 80, 120… минут
    await env.FYP_KV.put(k.name, JSON.stringify(q), { expirationTtl: (Q_HOURS + 24) * 3600 });
  }
}

/** Start по ссылке из очереди (q_<id>): записанный заказ — обычная привязка; ещё в очереди — запоминаем чат. */
export async function queuedStart(chatId, qid, env, url, from, L) {
  if (!/^[A-Z2-9]{8}$/.test(qid) || !kvOn(env)) return send(env, chatId, tr(L, 'notFoundToken'), mainMenu(L));
  const done = await env.FYP_KV.get(`pqd:${qid}`);
  if (done) return linkFromSite(chatId, done, env, url, from);
  const q = await env.FYP_KV.get(`pq:${qid}`, 'json');
  if (!q || (q.chat_id && q.chat_id !== chatId)) return send(env, chatId, tr(L, 'notFoundToken'), mainMenu(L));
  q.chat_id = chatId;
  await env.FYP_KV.put(`pq:${qid}`, JSON.stringify(q), { expirationTtl: (Q_HOURS + 24) * 3600 });
  await rememberChat(env, chatId);
  const L2 = await keepChatLang(env, chatId, q.o.lang || L);
  return send(env, chatId, tr(L2, 'queuedWait', { pet: esc((q.o.items[0] || {}).pet_name || '') }), mainMenu(L2));
}

// ---------------------------------------------------------------
// Заказы. Один заказ = один или несколько жетонов.
// «Питомец» = своя строка в таблице (свой tag_id, своя страница и ссылка для NFC/QR).
// «Запасной жетон» = ещё одна физическая копия того же жетона (тот же tag_id и ссылка).
// Заказ хранится в KV: o:<order_id>; у каждого жетона x:<tag_id>.order_id.
// ---------------------------------------------------------------
export const ORDER_STATUSES = ['new', 'paid', 'made', 'shipped'];

/** Из тарифа, первой клички, доп. кличек и «запасной для питомца №…» собираем состав заказа. */
export function orderItems(qty, firstPet, morePets, spareFor) {
  const slots = normQty(qty);
  const names = [firstPet, ...(Array.isArray(morePets) ? morePets : [])]
    .map((n) => cell(n, 40)).filter(Boolean).slice(0, slots);
  const items = names.map((pet_name) => ({ pet_name, copies: 1 }));
  const spares = slots - items.length;
  const want = Array.isArray(spareFor) ? spareFor : [];
  for (let k = 0; k < spares; k++) {
    const i = Number(want[k]);
    items[Number.isInteger(i) && i >= 0 && i < items.length ? i : 0].copies++;
  }
  return items;
}

/**
 * Создаёт строки в таблице (по одной на питомца), доп. данные и заказ в KV,
 * отправляет админу один лист производства. o: { source, qty, lang, owner_name, phone,
 * address, items, phone2?, notes?, chat_id?, care_interest? }
 */
export async function createOrder(env, url, o) { // + old_offer?: заказ со страницы, открытой до 3 + 1
  const tags = [];
  for (let i = 0; i < o.items.length; i++) {
    let r = await db(env, 'register', {
      owner_name: o.owner_name, phone: o.phone, pet_name: o.items[i].pet_name, address: o.address,
      telegram_chat_id: o.chat_id || undefined, tag_url_base: tagUrlBase(env, url), source: o.source,
    });
    if (!r.ok) r = await db(env, 'register', { // одна повторная попытка
      owner_name: o.owner_name, phone: o.phone, pet_name: o.items[i].pet_name, address: o.address,
      telegram_chat_id: o.chat_id || undefined, tag_url_base: tagUrlBase(env, url), source: o.source,
    });
    if (!r.ok) {
      if (!tags.length) return { ok: false };
      break; // часть жетонов создана — остальные админ создаст вручную (он увидит это в сообщении)
    }
    tags.push(r.tag);
  }
  const order_id = 'FY' + tags[0].tag_id;
  const now = new Date().toISOString();
  const items = tags.map((t, i) => ({ tag_id: String(t.tag_id), pet_name: t.pet_name || o.items[i].pet_name, copies: o.items[i].copies }));
  const missing = o.items.slice(tags.length).map((i) => i.pet_name);
  for (let i = 0; i < tags.length; i++) {
    const code = await newTagCode(env, tags[i].tag_id); // C4: адрес жетона — случайный код
    if (code) items[i].code = code;
    await putExtras(env, tags[i].tag_id, {
      order_id, copies: items[i].copies, lang: o.lang || 'en', ...(code ? { code } : {}),
      consent_at: now, consent_via: o.source,
      ...(() => {
        // свои данные питомца (Семейный) — иначе общий второй контакт и заметки первого питомца
        const it = o.items[i];
        const p2 = it.phone2 !== undefined ? it.phone2 : o.phone2;
        const nt = it.notes !== undefined ? it.notes : (i === 0 ? o.notes : '');
        return { ...(p2 ? { phone2: p2 } : {}), ...(nt ? { notes: nt } : {}) };
      })(),
    });
  }
  const order = {
    order_id, created_at: now, source: o.source, lang: o.lang || 'en',
    ...(() => { const pr = orderPrice(o.qty); return { tags_total: pr.tags, free: pr.free, price: pr.total }; })(),
    ...(o.care_interest ? { care_interest: true } : {}),
    ...(o.ad_src ? { ad_src: o.ad_src } : {}),
    ...(o.old_offer ? { old_offer: true } : {}),
    owner_name: o.owner_name, phone: o.phone, address: o.address,
    items, missing, chat_id: o.chat_id || '',
    tokens: Object.fromEntries(tags.map((t) => [String(t.tag_id), t.link_token || ''])),
    status: 'new', history: [{ status: 'new', at: now }],
  };
  await saveOrder(env, order);
  await notifyAdmin(env, url, order);
  return { ok: true, order, tags };
}

export async function getOrder(env, id) {
  if (!kvOn(env) || !id) return null;
  try { return await env.FYP_KV.get(`o:${id}`, 'json'); } catch (e) { console.error('order get', e); return null; }
}
export async function saveOrder(env, order) {
  if (!kvOn(env)) return;
  try { await env.FYP_KV.put(`o:${order.order_id}`, JSON.stringify(order)); } catch (e) { console.error('order put', e); }
}
export function orderTagsLine(order) {
  return order.items.map((i) => `${i.pet_name} #${i.tag_id}` + (i.copies > 1 ? ` ×${i.copies}` : '')).join(', ');
}

export async function apiTag(url, env, ctx) {
  const id = await tagRef(env, url.searchParams.get('id') || url.searchParams.get('id_tag') || '');
  if (!id) return json({ found: false }, env);
  // Сначала — сохранённая копия из KV (мгновенно: нашедший стоит рядом с питомцем),
  // таблица (1–3 с) обновляет копию в фоне. Нет копии — ждём таблицу, как раньше.
  const [cached, extras] = await Promise.all([getCachedPublic(env, id), getExtras(env, id)]);
  if (cached && cached.found && kvOn(env)) {
    ctx.waitUntil(refreshPublic(env, id));
    return json({ ...cached, ...publicExtras(extras, id), can_notify: (!!cached.can_notify || smsEnabled(env)) && feats(extras).alerts }, env);
  }
  const r = await db(env, 'getTag', { id });
  // r.ok === false — сбой связи с базой (Google Apps Script). Это ВРЕМЕННАЯ проблема,
  // а не "метка не зарегистрирована". Сначала пробуем отдать сохранённую копию
  // страницы (номер телефона важнее всего), и только если её нет — temp_error.
  if (!r.ok) {
    if (cached) return json({ ...cached, ...publicExtras(extras, id), can_notify: !!cached.can_notify && feats(extras).alerts, stale: true }, env);
    return json({ found: false, error: 'temp_error' }, env, 502);
  }
  if (!r.found || isOff(r.tag)) return json({ found: false }, env);
  ctx.waitUntil(cachePublic(env, r.tag));
  const pub = publicTag(r.tag, env);
  return json({ ...pub, ...publicExtras(extras, id), can_notify: pub.can_notify && feats(extras).alerts }, env);
}

/** Фоновое обновление копии страницы из таблицы; жетон удалён или отключён — копию убираем. */
export async function refreshPublic(env, id) {
  const r = await db(env, 'getTag', { id });
  if (!r.ok) return; // таблица недоступна — копия остаётся
  if (!r.found || isOff(r.tag)) {
    try { await env.FYP_KV.delete(`c:${id}`); } catch (e) { console.error('cache drop', e); }
    return;
  }
  await cachePublic(env, r.tag);
}

export async function apiScan(request, env, url) {
  const b = await request.json().catch(() => ({}));
  const id = await tagRef(env, b.id_tag || b.id);
  if (!id) return json({ success: false }, env, 400);
  const r = await db(env, 'logScan', { id });
  if (!r.ok || !r.found || isOff(r.tag)) return json({ success: false }, env);
  if (kvOn(env)) await bumpEvent(env, 'scan');
  const tag = r.tag;
  if (r.throttled) return json({ success: true }, env);
  const extras = await getExtras(env, id);
  const L = await ownerLang(env, tag.telegram_chat_id, extras);

  if (tag.telegram_chat_id) {
    const kb = extras.lost
      ? [[{ text: tr(L, 'btnLostOff'), callback_data: `found:${id}` }]]
      : [[{ text: tr(L, 'btnLostOn'), callback_data: `lost:${id}` }]];
    await tg(env, 'sendMessage', {
      chat_id: tag.telegram_chat_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: tr(L, 'scanned', { pet: esc(tag.pet_name), time: fmtTime(env, L) }),
      reply_markup: { inline_keyboard: kb },
    });
  } else if (smsEnabled(env)) {
    await sendSms(env, tag.phone, tr(L, 'smsScan', { pet: tag.pet_name, link: shortUrl(env, url, await tagKey(env, id, extras)) }));
  }
  return json({ success: true }, env);
}

/**
 * Кнопка «Telegram» на странице жетона: бот сам пишет владельцу, что питомца нашли.
 * Если нашедший разрешил геолокацию — в том же сообщении ссылки на карту и точка.
 * Telegram ID владельца берётся из таблицы (telegram_chat_id). Повтор в течение минуты не дублирует сообщение.
 */
export async function apiFound(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = await tagRef(env, b.id_tag || b.id);
  if (!id) return json({ success: false, error: 'bad_request' }, env, 400);
  // не больше 3 оповещений в минуту на один жетон, с любых адресов (защита владельца от потока сообщений)
  if (await limited(env, 'RL_TAG', `tag:${id}`)) return json({ success: false, error: 'rate_limited' }, env, 429);
  const lat = Number(b.lat), lon = Number(b.lon), acc = Number(b.accuracy);
  const hasLoc = b.lat !== undefined && b.lon !== undefined && isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  // координаты нашедшего уходят только владельцу в Telegram и в таблице не хранятся
  const r = await db(env, 'logScan', { id });
  if (!r.ok) return json({ success: false, error: 'temp_error' }, env, 502);
  if (!r.found || isOff(r.tag)) return json({ success: false, error: 'not_found' }, env);
  const tag = r.tag;
  const extras = await getExtras(env, id);
  if (!feats(extras).alerts || !tag.telegram_chat_id) return json({ success: false, error: 'not_linked' }, env);

  const key = `f:${id}`;
  if (kvOn(env) && !hasLoc && (await env.FYP_KV.get(key))) return json({ success: true, repeat: true }, env);

  // Каждое сообщение «питомец найден» предупреждает о мошенниках (safety): такое сообщение может вызвать и мошенник
  const L = await ownerLang(env, tag.telegram_chat_id, extras);
  let text = tr(L, 'foundHead', { pet: esc(tag.pet_name), time: fmtTime(env, L) });
  if (hasLoc) {
    const maps = `https://maps.google.com/?q=${lat},${lon}`;
    const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
    text += tr(L, 'foundLoc', { acc: isFinite(acc) && acc > 0 ? Math.round(acc) : 0 }) + mapsLine(L, maps, waze);
  } else {
    text += tr(L, 'foundNoLoc');
  }
  text += tr(L, 'safety');
  const sent = await tg(env, 'sendMessage', { chat_id: tag.telegram_chat_id, parse_mode: 'HTML', disable_web_page_preview: true, text });
  if (hasLoc) await tg(env, 'sendLocation', { chat_id: tag.telegram_chat_id, latitude: lat, longitude: lon });
  if (sent && sent.ok && kvOn(env)) {
    await env.FYP_KV.put(key, '1', { expirationTtl: 60 });
    await bumpEvent(env, 'f_tg');
  }
  if (!(sent && sent.ok)) await ownerUnreachable(env, tag, hasLoc ? `https://maps.google.com/?q=${lat},${lon}` : '');
  return json({ success: !!(sent && sent.ok) }, env);
}

export async function apiLocation(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = await tagRef(env, b.id_tag || b.id);
  const lat = Number(b.lat), lon = Number(b.lon);
  const acc = Number(b.accuracy);
  if (!id || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ success: false, error: 'bad_request' }, env, 400);
  }
  if (await limited(env, 'RL_TAG', `tag:${id}`)) return json({ success: false, error: 'rate_limited' }, env, 429);
  const r = await db(env, 'logScan', { id }); // координаты в таблицу не пишем — только владельцу
  if (!r.ok) return json({ success: false, error: 'temp_error' }, env, 502);
  if (!r.found || isOff(r.tag)) return json({ success: false, error: 'not_found' }, env);
  const tag = r.tag;
  const L = await ownerLang(env, tag.telegram_chat_id, await getExtras(env, id));

  const maps = `https://maps.google.com/?q=${lat},${lon}`;
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

  if (!tag.telegram_chat_id) {
    if (smsEnabled(env)) {
      const ok = await sendSms(env, tag.phone, tr(L, 'smsFound', { pet: tag.pet_name, maps }));
      return json({ success: ok }, env);
    }
    return json({ success: false, error: 'not_linked' }, env);
  }

  const sent = await tg(env, 'sendMessage', {
    chat_id: tag.telegram_chat_id,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      tr(L, 'locHead', { pet: esc(tag.pet_name), time: fmtTime(env, L), acc: isFinite(acc) && acc > 0 ? Math.round(acc) : 0 }) +
      mapsLine(L, maps, waze) + tr(L, 'safety'),
  });
  await tg(env, 'sendLocation', { chat_id: tag.telegram_chat_id, latitude: lat, longitude: lon });
  if (!(sent && sent.ok) && smsEnabled(env)) {
    // Telegram не доставил (бот заблокирован и т.п.) → резерв SMS
    const ok = await sendSms(env, tag.phone, tr(L, 'smsFound', { pet: tag.pet_name, maps }));
    return json({ success: ok }, env);
  }
  if (!(sent && sent.ok)) await ownerUnreachable(env, tag, maps);
  return json({ success: !!(sent && sent.ok) }, env);
}

/** Нашедший нажал «Сообщить хозяину», а Telegram не доставил (бот заблокирован и т.п.) — админ позвонит владельцу. */
export function ownerUnreachable(env, tag, maps) {
  return alertAdmin(env, `found:${tag.tag_id}`,
    `🚨 <b>Finder could not reach the owner</b> of #${tag.tag_id} (${esc(tag.pet_name)}) — Telegram did not deliver.\n` +
    `Please call the owner: ${esc(prettyPhone(normalizePhone(tag.phone)))}` + (maps ? `\n📍 Finder's location: ${esc(maps)}` : ''));
}

/** Жетон отключён админом или удалён владельцем (/delete) — страница «не найден», оповещений нет. */
export function isOff(tag) { return ['disabled', 'deleted'].includes(String((tag && tag.status) || '')); }

export function publicTag(t, env) {
  const phone = normalizePhone(t.phone);
  return {
    found: true,
    tag_id: t.tag_id,
    pet_name: t.pet_name || '',
    owner_name: String(t.owner_name || '').split(' ')[0],
    phone,
    phone_display: prettyPhone(phone),
    can_notify: !!String(t.telegram_chat_id || '').trim() || smsEnabled(env || {}),
  };
}

/** Публичная часть доп. данных (то, что владелец разрешил показывать). */
export function publicExtras(x, id) {
  x = x || {};
  if (!feats(x).extras) x = {};
  const phone2 = normalizePhone(x.phone2);
  return {
    photo: x.photo_v && id ? `/img/${x.code || id}?v=${x.photo_v}` : '',
    lost: !!x.lost,
    lost_since: x.lost ? (x.lost_since || '') : '',
    lost_area: x.lost ? (x.lost_area || '') : '',
    phone2,
    phone2_display: phone2 ? prettyPhone(phone2) : '',
    notes: x.notes || '',
  };
}
