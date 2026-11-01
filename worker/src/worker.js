/**
 * ============================================================
 *  FindYpet — Cloudflare Worker  (v4, сентябрь 2026)
 * ============================================================
 *  Один сервис делает всё:
 *   • отдаёт сайт — главная, страница метки /t/<код> (новые жетоны, C4) или /t/101 и /tag/?id=101 (старые),
 *     политика конфиденциальности /privacy/
 *   • API для сайта:
 *        POST /api/register   — заказ с сайта: 1, 2 или 4 жетона (3 + 1: питомцы + запасные)
 *        GET  /api/tag?id=101 — данные питомца для страницы метки (с резервным кэшем)
 *        POST /api/scan       — "метку отсканировали" (уведомление владельцу)
 *        POST /api/location   — геолокация от нашедшего → владельцу
 *        POST /api/found      — кнопка «Telegram» на странице: бот пишет владельцу «питомец найден» (+ точка)
 *   • GET /img/101  — фото питомца (из бота, /photo);  GET /p/101 — объявление «Потерялся» (HE/RU/EN, QR, печать)
 *   • Telegram-бот @YourPetLocatorBot (webhook: POST /telegram)
 *        /register /mytags /lost /found /settings /photo /care /lang /cancel /help /id — на иврите, русском и
 *        английском (тексты — const BOT); для админа (по-английски) /orders, /stats и
 *        кнопки статуса заказа (Оплачен → Изготовлен → Отправлен) — клиенту уходит сообщение
 *   • /setup — настройка бота: форма, ключ уходит в теле POST, не в адресе (повторить после обновления!)
 *   • scheduled() — напоминание владельцам раз в 180 дней проверить контакты (нужен Cron Trigger)
 *
 *  Код разделён на части (worker/src/*.js, этап D2); worker/build.py склеивает их в один dist/worker.js.
 *
 *  База данных — Google Sheets через Apps Script (GAS_URL + GAS_KEY) — без изменений.
 *  Новые данные (режим «Потерялся», второй телефон, заметки, резервный кэш страницы)
 *  хранятся в Cloudflare KV (binding FYP_KV) с ключом tag_id. Без KV сайт и бот
 *  работают как раньше, просто новые функции отключены.
 *
 *  Переменные окружения (Settings → Variables / Bindings):
 *   BOT_TOKEN       (секрет)  токен бота от @BotFather
 *   BOT_USERNAME              YourPetLocatorBot
 *   GAS_URL         (секрет)  URL веб-приложения Apps Script (…/exec)
 *   GAS_KEY         (секрет)  тот же ключ, что API_KEY в Apps Script
 *   WEBHOOK_SECRET  (секрет)  любая случайная строка (A-Z a-z 0-9 _ -) — её знает только Telegram
 *   SETUP_KEY       (секрет)  ключ для /setup; пока не задан, подходит WEBHOOK_SECRET
 *   SITE_URL                  адрес сайта без / в конце (пусто = адрес этого Worker)
 *   ADMIN_CHAT_ID             (необяз.) ваш chat id — уведомления о новых заказах
 *   TIMEZONE                  Asia/Jerusalem
 *   FYP_KV          (binding) KV namespace — новые функции (обязательно для /lost, /settings)
 *   LOST_CHANNEL_ID           (необяз.) @канал или -100… — куда бот публикует «Потерялся»
 *                             (бот должен быть админом канала)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (секрет), TWILIO_FROM
 *                             (необяз.) SMS-резерв, если у владельца нет Telegram
 * ============================================================
 */

import { remindUnlinked } from './admin.js';
import { DAILY_CRON, QUEUE_CRON, QUEUE_CRON_TEST, WEEKLY_CRON, apiEvent, apiFound, apiLocation, apiRegister, apiScan, apiTag, bumpFail, orderItems, processQueue, publicExtras, publicTag, weeklyDigest } from './api.js';
import { handleUpdate } from './bot.js';
import { d1Cleanup, siteBase } from './db.js';
import { BOT, tr } from './i18n.js';
import { servePhoto } from './photo.js';
import { posterPage, qrMatrix, qrSvg } from './poster.js';
import { PRICING, feats, orderPrice } from './pricing.js';
import { setupRoute } from './setup.js';
import { dailyBackup, sendReminders } from './store.js';
import { checkOrigin, clientIp, cors, json, limited, normalizePhone, prettyPhone, tagRef } from './util.js';


// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (!isTestSite(env)) return keepOutOfAnalytics(request, env, await secure(await route(request, env, ctx)));
    // Тестовый сайт: не индексируется поисковиками, на каждой странице — пометка «ТЕСТ»
    if (new URL(request.url).pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return keepOutOfAnalytics(request, env, await markTestSite(await secure(await route(request, env, ctx))));
  },

  // Cron Trigger (раз в день): напоминание проверить контакты + резервная копия данных админу;
  // по воскресеньям — ещё недельная сводка админу (B10)
  // (у сводки свой cron WEEKLY_CRON — отдельный запуск со своим лимитом операций KV)
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    // очередь заказов (C3) — и на тестовом сайте, чтобы её можно было проверить
    if (cron === QUEUE_CRON || cron === QUEUE_CRON_TEST || !cron) {
      const now = (event && event.scheduledTime) || Date.now();
      ctx.waitUntil(processQueue(env, now).catch((e) => console.error('queue error', e)));
    }
    if (isTestSite(env)) return; // тестовый сайт напоминаний и копий не рассылает
    if (cron === DAILY_CRON || !cron) {
      ctx.waitUntil(sendReminders(env).catch((e) => console.error('reminders error', e)));
      ctx.waitUntil(dailyBackup(env).catch((e) => console.error('backup error', e)));
      ctx.waitUntil(remindUnlinked(env, (event && event.scheduledTime) || Date.now()).catch((e) => console.error('unlinked error', e)));
      ctx.waitUntil(processQueue(env, Date.now(), true).catch((e) => console.error('queue check error', e)));
      ctx.waitUntil(d1Cleanup(env, new Date(Date.now() - 2 * 86400000).toLocaleDateString('en-CA', { timeZone: env.TIMEZONE || 'Asia/Jerusalem' })));
    }
    if (cron === WEEKLY_CRON || !cron) {
      const now = (event && event.scheduledTime) || Date.now();
      ctx.waitUntil(weeklyDigest(env, now).catch((e) => console.error('weekly digest error', e)));
    }
  },
};

export async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // www.findy-pet.com → findy-pet.com (один адрес для людей и поисковиков)
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.toString(), 301);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

  try {
    // ---- Telegram webhook ----
    if (path === '/telegram' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      // Отвечаем Telegram сразу, обработку делаем в фоне
      ctx.waitUntil(handleUpdate(update, env, url).catch((e) => console.error('update error', e)));
      return new Response('ok');
    }

    // ---- Одноразовая настройка бота ----
    if (path === '/setup') return await setupRoute(request, env, url);

    // ---- API сайта ----
    if (path.startsWith('/api/')) {
      // Только наш сайт и только JSON: чужие страницы не могут слать запросы от имени посетителя
      const refused = checkOrigin(request, env, url);
      if (refused) return refused;
      // Лимит частоты на адрес посетителя (бинды RL_* в wrangler.toml; без них — без лимита)
      const rl = path === '/api/tag' || path === '/api/ev' ? 'RL_READ' : path === '/api/register' ? 'RL_ORDER' : 'RL_SIGNAL';
      if (await limited(env, rl, `${clientIp(request)}:${path}`)) {
        // страница жетона покажет «временная ошибка, попробуйте ещё раз», а не «жетон не найден»
        return json({ success: false, found: false, error: path === '/api/tag' ? 'temp_error' : 'rate_limited' }, env, 429);
      }
    }
    if (path === '/api/ev' && request.method === 'POST') return await apiEvent(request, env, ctx);
    if (path === '/api/register' && request.method === 'POST') return await apiRegister(request, env, url, ctx);
    if (path === '/api/tag' && request.method === 'GET') return await apiTag(url, env, ctx);
    if (path === '/api/scan' && request.method === 'POST') return await apiScan(request, env, url);
    if (path === '/api/location' && request.method === 'POST') return await apiLocation(request, env);
    if (path === '/api/found' && request.method === 'POST') return await apiFound(request, env);
    if (path.startsWith('/api/')) return json({ success: false, error: 'not_found' }, env, 404);

    // ---- QR на напечатанном медальоне: HTTPS://FINDY-PET.COM/T/101 (заглавные буквы — QR на 15 % меньше) ----
    const upper = /^\/T\/(\d{1,9}|[A-Z0-9]{7,8})$/.exec(path);
    if (upper) return Response.redirect(`${url.origin}/t/${upper[1]}`, 301);
    // ---- QR жетона с кодом (C4): HTTPS://FINDY-PET.COM/K7QM2XA — без /T/, чтобы QR остался 20 мм (версия 2) ----
    const bare = /^\/([A-HJ-NP-Z2-9]{7})$/.exec(path);
    if (bare) return Response.redirect(`${url.origin}/t/${bare[1]}`, 301);

    // ---- Короткая ссылка /t/101 (для QR на жетоне) → та же страница метки ----
    if (/^\/t\/(\d{1,9}|[A-Za-z0-9]{7,8})$/.test(path)) {
      const tagReq = new Request(new URL('/tag/index.html', url.origin), request);
      const res = env.ASSETS ? await env.ASSETS.fetch(tagReq) : serveEmbedded(new URL('/tag/index.html', url.origin), env);
      return noindex(res);
    }

    // ---- Для поисковиков: robots.txt и карта сайта (лендинг на трёх языках) ----
    // Н4: QR кнопки «Открыть бота» для компьютера (только ссылки на нашего бота)
    if (path === '/qr/bot.svg') {
      const c = url.searchParams.get('c') || '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(c)) return new Response('bad', { status: 400 });
      return new Response(qrSvg(`https://t.me/${env.BOT_USERNAME}?start=${c}`), { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=3600' } });
    }
    if (path === '/robots.txt') return new Response(robotsTxt(env, url), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    if (path === '/sitemap.xml') return new Response(sitemapXml(env, url), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });

    // ---- Объявление «Потерялся» для групп и печати ----
    const pm = /^\/p\/(\d{1,9}|[A-Za-z0-9]{7,8})$/.exec(path);
    if (pm && request.method === 'GET') {
      if (await limited(env, 'RL_READ', `${clientIp(request)}:/p`)) return new Response('Too many requests', { status: 429 });
      return await posterPage(env, url, (await tagRef(env, pm[1])) || '0', ctx);
    }

    // ---- Фото питомца (загружено владельцем в боте, /photo) ----
    const img = /^\/img\/(\d{1,9}|[A-Za-z0-9]{7,8})$/.exec(path);
    if (img && request.method === 'GET') return await servePhoto(env, (await tagRef(env, img[1])) || '0', url);

    // ---- Цены тарифов для сайта ----
    if (path === '/js/plans.js') {
      const ts = env.TURNSTILE_SITE_KEY && /^[\w-]{8,64}$/.test(env.TURNSTILE_SITE_KEY) ? `const TURNSTILE_SITE_KEY = "${env.TURNSTILE_SITE_KEY}";\n` : '';
      return new Response(`const PRICING = ${JSON.stringify(PRICING)};\n` + ts, {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }

    // ---- Статический сайт ----
    // /new/ — бывший предварительный показ нового дизайна: теперь это главная
    if (path === '/new' || path.startsWith('/new/')) return Response.redirect(url.origin + '/' + url.search, 301);
    const res = env.ASSETS ? await env.ASSETS.fetch(request) : serveEmbedded(url, env);
    return path.startsWith('/tag') ? noindex(res) : res;
  } catch (err) {
    console.error(err);
    await bumpFail(env, 'server').catch(() => {});
    return json({ success: false, error: 'server_error' }, env, 500);
  }
}

// ---------------------------------------------------------------
// Заголовки безопасности. HTML: CSP с одноразовым nonce для встроенных <script> (страница жетона,
// объявление, политика), сторонние скрипты — только Cloudflare Web Analytics и Turnstile.
// ---------------------------------------------------------------
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=15552000',
};
export function csp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://static.cloudflareinsights.com https://challenges.cloudflare.com`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://cloudflareinsights.com",
    'frame-src https://challenges.cloudflare.com',
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
}
// Н3: Web Analytics Cloudflare не вставляет счётчик в страницы с Cache-Control: no-transform.
// Не считаем в «визитах сайта» тестовый сайт, /setup и страницы жетонов (их открывают нашедшие питомцев, не покупатели).
export function keepOutOfAnalytics(request, env, res) {
  const path = new URL(request.url).pathname;
  const skip = isTestSite(env) || path === '/setup' || /^\/(t|tag)(\/|$)/.test(path);
  if (!skip || !(res.headers.get('Content-Type') || '').startsWith('text/html')) return res;
  const h = new Headers(res.headers);
  const cc = h.get('Cache-Control') || '';
  if (!/no-transform/i.test(cc)) h.set('Cache-Control', cc ? `${cc}, no-transform` : 'no-transform');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export async function secure(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  if (!(h.get('Content-Type') || '').startsWith('text/html')) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html = (await res.text()).replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  h.set('Content-Security-Policy', csp(nonce));
  h.set('X-Frame-Options', 'DENY');
  h.delete('Content-Length');
  return new Response(html, { status: res.status, statusText: res.statusText, headers: h });
}

// ---------------------------------------------------------------
// Поисковики. Индексируются только лендинг (/, /he/, /ru/) и политика. Страницы жетонов и объявления
// закрыты заголовком noindex (их не блокируем в robots.txt — иначе поисковик не увидит noindex).
// ---------------------------------------------------------------
export function noindex(res) {
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
export function robotsTxt(env, url) {
  return 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /img/\nDisallow: /setup\nDisallow: /telegram\n\n' +
    `Sitemap: ${siteBase(env, url)}/sitemap.xml\n`;
}
export function sitemapXml(env, url) {
  const b = siteBase(env, url);
  const alt = ['en', 'he', 'ru'].map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${b}${l === 'en' ? '/' : `/${l}/`}"/>`).join('') +
    `<xhtml:link rel="alternate" hreflang="x-default" href="${b}/"/>`;
  const u = (loc, extra = '') => `<url><loc>${loc}</loc>${extra}</url>`;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
    u(`${b}/`, alt) + u(`${b}/he/`, alt) + u(`${b}/ru/`, alt) + u(`${b}/privacy/`) + u(`${b}/accessibility/`) + '</urlset>\n';
}

// ---------------------------------------------------------------
// Тестовый сайт (test.findy-pet.com, окружение staging в wrangler.toml).
// STAGE = "test"  → пометка «ТЕСТ» на страницах, noindex, без напоминаний по расписанию.
// TEST_DB = "1"   → жетоны хранятся в KV этого сайта, а не в Google-таблице (см. testDb).
// На рабочем сайте обе переменные не заданы, и ничего из этого не работает.
// ---------------------------------------------------------------
export function isTestSite(env) { return !!(env && env.STAGE); }

export const TEST_BANNER =
  '<div id="fyp-test-banner" class="stage-banner" style="background:#f59e0b;color:#1f2937;font:700 13px/1.35 system-ui,-apple-system,sans-serif;' +
  'text-align:center;padding:7px 12px;letter-spacing:.2px" dir="ltr">🧪 TEST SITE · ТЕСТОВЫЙ САЙТ — ' +
  'orders here are not real · заказы не настоящие. Рабочий сайт: <a href="https://findy-pet.com" style="color:inherit">findy-pet.com</a></div>';

export async function markTestSite(res) {
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  if (!(h.get('Content-Type') || '').startsWith('text/html')) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  const html = (await res.text())
    .replace(/<title>/i, '<title>[TEST] ')
    .replace(/<body([^>]*)>/i, (m) => m + TEST_BANNER);
  h.delete('Content-Length');
  return new Response(html, { status: res.status, statusText: res.statusText, headers: h });
}

// ---------------------------------------------------------------
// Встроенный сайт (для версии "один файл", вставляемой в редактор Cloudflare).
// В обычной версии (wrangler + папка site) EMBEDDED = null и сайт отдаёт env.ASSETS.
// ---------------------------------------------------------------
export const EMBEDDED = /*__EMBEDDED__*/null;

export function serveEmbedded(url, env) {
  if (!EMBEDDED) return new Response('FindYpet API is running', { headers: cors(env) });
  let p = url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  let f = EMBEDDED[p];
  if (!f && EMBEDDED[p + '/index.html']) {
    return Response.redirect(url.origin + p + '/' + url.search, 301);
  }
  if (!f) return new Response('Not found', { status: 404 });
  const body = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.text;
  return new Response(body, {
    headers: { 'Content-Type': f.type, 'Cache-Control': p.endsWith('.html') ? 'no-cache' : p.startsWith('/assets/fonts/') ? 'public, max-age=2592000' : 'public, max-age=300' },
  });
}

// экспорт для тестов
export const _test = { normalizePhone, prettyPhone, publicTag, publicExtras, PRICING, orderPrice, orderItems, feats, BOT, tr, qrMatrix };
