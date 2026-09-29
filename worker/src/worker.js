/**
 * ============================================================
 *  FindYpet — Cloudflare Worker  (v4, сентябрь 2026)
 * ============================================================
 *  Один сервис делает всё:
 *   • отдаёт сайт — главная, страница метки /tag/?id=101 (и короткая /t/101),
 *     политика конфиденциальности /privacy/
 *   • API для сайта:
 *        POST /api/register   — регистрация с сайта (+ второй телефон, заметки, согласие)
 *        GET  /api/tag?id=101 — данные питомца для страницы метки (с резервным кэшем)
 *        POST /api/scan       — "метку отсканировали" (уведомление владельцу)
 *        POST /api/location   — геолокация от нашедшего → владельцу
 *   • Telegram-бот @YourPetLocatorBot (webhook: POST /telegram)
 *        /register /mytags /lost /found /settings /cancel /help /id
 *   • GET /setup?key=WEBHOOK_SECRET — одноразовая настройка бота (повторить после обновления!)
 *   • scheduled() — напоминание владельцам раз в 180 дней проверить контакты (нужен Cron Trigger)
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
 *   WEBHOOK_SECRET  (секрет)  любая случайная строка (A-Z a-z 0-9 _ -)
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

// ---------------------------------------------------------------
// Тексты бота (можно редактировать)
// ---------------------------------------------------------------
const T = {
  welcome:
    '🐾 <b>Welcome to FindYpet!</b>\n\n' +
    'I help your pet get home fast. Your tag has your phone number, a QR code and NFC. ' +
    'Whoever finds your pet can call you, write to you on WhatsApp, or send you their location — ' +
    'and I will alert you right here the moment the tag is scanned.\n\n' +
    'Tap <b>Register a pet</b> to get your personal tag.',
  askName: '👤 What is your <b>name</b> (pet owner)?',
  askPhone:
    '📱 Your <b>phone number</b> — the finder will call it.\n' +
    'Tap the button below to share it, or type it (e.g. 050-123-4567).',
  badPhone: '⚠️ That doesn\'t look like a phone number. Please try again (e.g. 050-123-4567).',
  askPet: '🐶 What is your <b>pet\'s name</b>?',
  askAddress: '🏠 Your <b>address</b> (city, street, apartment) — we ship the tag there. It is never shown on the pet page.',
  cancelled: 'Cancelled. Send /help to see what I can do.',
  notFoundToken:
    '⚠️ This activation link is not valid (or expired).\nYou can register a new pet here: /register',
  noTags: 'You have no registered pets yet. Tap /register to add one.',
  noKv: '⚠️ This feature is not switched on yet. Please try again later.',
  help:
    '<b>Commands</b>\n' +
    '/register — register a new pet and get a tag\n' +
    '/mytags — your pets, links and status\n' +
    '🚨 /lost — pet missing: switch the tag page to "I\'m lost"\n' +
    '✅ /found — pet is home: switch Lost mode off\n' +
    '⚙️ /settings — second contact and notes for the finder\n' +
    '/cancel — cancel the current action\n' +
    '/id — show your Telegram chat ID',
  askArea:
    '📍 Where was your pet last seen? (area / city — e.g. "Haifa, Carmel Center")\n' +
    'This is shown on the tag page. Tap <b>Skip</b> if you prefer not to say.',
  askPhone2: '📞 Send the <b>second phone number</b> (e.g. a family member). It will be shown on the pet page.',
  askNotes:
    '📝 Send the <b>notes for the finder</b> (up to 200 characters).\n' +
    'For example: "Allergic to chicken. Scared of people — don\'t chase, call me."\n' +
    'They will be shown on the pet page.',
  reminder:
    '🔔 <b>Quick check:</b> are your contacts on the FindYpet tag still up to date?\n' +
    'Outdated contacts are a common reason a found pet doesn\'t get home.\n\n' +
    '/mytags — see your tags · /settings — second contact and notes\n' +
    'Phone number changed? Just write to us here.',
};

const BTN_REGISTER = '🐾 Register a pet';
const BTN_MYTAGS = '🏷 My tags';
const BTN_LOST = '🚨 Lost';
const BTN_SETTINGS = '⚙️ Settings';
const BTN_CANCEL = '❌ Cancel';
const BTN_SKIP = '➡️ Skip';

const REMINDER_DAYS = 180;

// ---------------------------------------------------------------
// Тарифы (разовая оплата, без подписки). ЕДИНСТВЕННОЕ место, где задаются цены:
// отсюда их берут сайт (/js/plans.js) и бот. id не менять — они сохраняются в заказе.
// ---------------------------------------------------------------
const PLANS = {
  basic: { price: '49 ₪', name: 'Basic' },
  smart: { price: '79 ₪', name: 'Smart' },
  family: { price: '199 ₪', name: 'Family (3 Smart tags)' },
};
const DEFAULT_PLAN = 'smart';
function planLabel(id) { const p = PLANS[id]; return p ? `${p.name} · ${p.price}` : '—'; }

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

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
      if (path === '/setup') return await setup(env, url);

      // ---- API сайта ----
      if (path === '/api/register' && request.method === 'POST') return await apiRegister(request, env, url, ctx);
      if (path === '/api/tag' && request.method === 'GET') return await apiTag(url, env, ctx);
      if (path === '/api/scan' && request.method === 'POST') return await apiScan(request, env, url);
      if (path === '/api/location' && request.method === 'POST') return await apiLocation(request, env);
      if (path.startsWith('/api/')) return json({ success: false, error: 'not_found' }, env, 404);

      // ---- Короткая ссылка /t/101 (для QR на жетоне) → та же страница метки ----
      if (/^\/t\/\d{1,9}$/.test(path)) {
        const tagReq = new Request(new URL('/tag/index.html', url.origin), request);
        const res = env.ASSETS ? await env.ASSETS.fetch(tagReq) : serveEmbedded(new URL('/tag/index.html', url.origin), env);
        return new Response(res.body, { status: res.status, headers: res.headers });
      }

      // ---- Цены тарифов для сайта ----
      if (path === '/js/plans.js') {
        return new Response(`const PLANS = ${JSON.stringify(PLANS)};\n`, {
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
        });
      }

      // ---- Статический сайт ----
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return serveEmbedded(url, env);
    } catch (err) {
      console.error(err);
      return json({ success: false, error: 'server_error' }, env, 500);
    }
  },

  // Cron Trigger (например, раз в день): напоминание проверить контакты
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env).catch((e) => console.error('reminders error', e)));
  },
};

// ---------------------------------------------------------------
// Site API
// ---------------------------------------------------------------
async function apiRegister(request, env, url, ctx) {
  const b = await request.json().catch(() => ({}));
  const owner = str(b.owner_name, 80);
  const pet = str(b.pet_name, 40);
  const address = str(b.address, 200);
  const phone = normalizePhone(b.phone);
  const phone2Raw = str(b.phone2, 30);
  const phone2 = phone2Raw ? normalizePhone(phone2Raw) : '';
  const notes = str(b.notes, 200);
  if (!owner || !pet || !address) return json({ success: false, error: 'Please fill in all fields.', error_code: 'fill' }, env, 400);
  if (!phone) return json({ success: false, error: 'Please enter a valid phone number.', error_code: 'phone' }, env, 400);
  if (phone2Raw && !phone2) return json({ success: false, error: 'Second phone is not valid.', error_code: 'phone2' }, env, 400);
  if (b.consent !== true) return json({ success: false, error: 'Consent is required.', error_code: 'consent' }, env, 400);
  const plan = PLANS[b.plan] ? b.plan : DEFAULT_PLAN;

  const r = await db(env, 'register', {
    owner_name: owner, phone, pet_name: pet, address,
    tag_url_base: tagUrlBase(env, url), source: 'site',
  });
  if (!r.ok) return json({ success: false, error: 'Database error. Please try again.', error_code: 'db' }, env, 502);
  const tag = r.tag;

  // Доп. данные и факт согласия — в KV (таблицу не трогаем)
  await putExtras(env, tag.tag_id, {
    phone2, notes,
    consent_at: new Date().toISOString(),
    lang: ['en', 'he', 'ru'].includes(b.lang) ? b.lang : 'en',
    plan,
  });
  ctx.waitUntil(cachePublic(env, tag));
  await notifyAdmin(env, url, tag, 'site', plan);

  return json({
    success: true,
    id_tag: tag.tag_id,
    tag_url: shortUrl(env, url, tag.tag_id),
    telegram_link: `https://t.me/${env.BOT_USERNAME}?start=${tag.link_token}`,
  }, env);
}

async function apiTag(url, env, ctx) {
  const id = url.searchParams.get('id') || url.searchParams.get('id_tag') || '';
  if (!/^\d{1,9}$/.test(id)) return json({ found: false }, env);
  const [r, extras] = await Promise.all([db(env, 'getTag', { id }), getExtras(env, id)]);
  // r.ok === false — сбой связи с базой (Google Apps Script). Это ВРЕМЕННАЯ проблема,
  // а не "метка не зарегистрирована". Сначала пробуем отдать сохранённую копию
  // страницы (номер телефона важнее всего), и только если её нет — temp_error.
  if (!r.ok) {
    const cached = await getCachedPublic(env, id);
    if (cached) return json({ ...cached, ...publicExtras(extras), stale: true }, env);
    return json({ found: false, error: 'temp_error' }, env, 502);
  }
  if (!r.found || String(r.tag.status) === 'disabled') return json({ found: false }, env);
  ctx.waitUntil(cachePublic(env, r.tag));
  return json({ ...publicTag(r.tag, env), ...publicExtras(extras) }, env);
}

async function apiScan(request, env, url) {
  const b = await request.json().catch(() => ({}));
  const id = String(b.id_tag || b.id || '');
  if (!/^\d{1,9}$/.test(id)) return json({ success: false }, env, 400);
  const r = await db(env, 'logScan', { id });
  if (!r.ok || !r.found) return json({ success: false }, env);
  const tag = r.tag;
  if (r.throttled) return json({ success: true }, env);
  const extras = await getExtras(env, id);

  if (tag.telegram_chat_id) {
    const kb = extras.lost
      ? [[{ text: '✅ Pet is home — Lost mode off', callback_data: `found:${id}` }]]
      : [[{ text: '🚨 My pet is missing — Lost mode on', callback_data: `lost:${id}` }]];
    await tg(env, 'sendMessage', {
      chat_id: tag.telegram_chat_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        `👀 <b>${esc(tag.pet_name)}'s tag was just scanned!</b> (${fmtTime(env)})\n` +
        `Someone opened ${esc(tag.pet_name)}'s page. They can call you or write to you on WhatsApp — keep your phone close.\n` +
        `If they share their location, I will send it to you right here.`,
      reply_markup: { inline_keyboard: kb },
    });
  } else if (smsEnabled(env)) {
    await sendSms(env, tag.phone,
      `FindYpet: ${tag.pet_name}'s tag was just scanned. The finder may call you or write on WhatsApp. ${shortUrl(env, url, id)}`);
  }
  return json({ success: true }, env);
}

async function apiLocation(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = String(b.id_tag || b.id || '');
  const lat = Number(b.lat), lon = Number(b.lon);
  const acc = Number(b.accuracy);
  if (!/^\d{1,9}$/.test(id) || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ success: false, error: 'bad_request' }, env, 400);
  }
  const r = await db(env, 'logScan', { id, lat, lon });
  if (!r.ok) return json({ success: false, error: 'temp_error' }, env, 502);
  if (!r.found) return json({ success: false, error: 'not_found' }, env);
  const tag = r.tag;

  const maps = `https://maps.google.com/?q=${lat},${lon}`;
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

  if (!tag.telegram_chat_id) {
    if (smsEnabled(env)) {
      const ok = await sendSms(env, tag.phone, `FindYpet: ${tag.pet_name} was found! The finder is here: ${maps}`);
      return json({ success: ok }, env);
    }
    return json({ success: false, error: 'not_linked' }, env);
  }

  const sent = await tg(env, 'sendMessage', {
    chat_id: tag.telegram_chat_id,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      `🚨📍 <b>${esc(tag.pet_name)} has been found!</b>\n` +
      `The finder shared their location (${fmtTime(env)})` +
      (isFinite(acc) && acc > 0 ? `, accuracy ±${Math.round(acc)} m` : '') + '.\n\n' +
      `🗺 <a href="${maps}">Open in Google Maps</a>  ·  🚗 <a href="${waze}">Waze</a>`,
  });
  await tg(env, 'sendLocation', { chat_id: tag.telegram_chat_id, latitude: lat, longitude: lon });
  if (!(sent && sent.ok) && smsEnabled(env)) {
    // Telegram не доставил (бот заблокирован и т.п.) → резерв SMS
    const ok = await sendSms(env, tag.phone, `FindYpet: ${tag.pet_name} was found! The finder is here: ${maps}`);
    return json({ success: ok }, env);
  }
  return json({ success: !!(sent && sent.ok) }, env);
}

function publicTag(t, env) {
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
function publicExtras(x) {
  x = x || {};
  const phone2 = normalizePhone(x.phone2);
  return {
    lost: !!x.lost,
    lost_since: x.lost ? (x.lost_since || '') : '',
    lost_area: x.lost ? (x.lost_area || '') : '',
    phone2,
    phone2_display: phone2 ? prettyPhone(phone2) : '',
    notes: x.notes || '',
  };
}

// ---------------------------------------------------------------
// KV: доп. данные метки и резервный кэш страницы
// ---------------------------------------------------------------
function kvOn(env) { return !!(env && env.FYP_KV); }

async function getExtras(env, id) {
  if (!kvOn(env)) return {};
  try { return (await env.FYP_KV.get(`x:${id}`, 'json')) || {}; } catch (e) { console.error('kv get', e); return {}; }
}

async function putExtras(env, id, patch) {
  if (!kvOn(env)) return false;
  try {
    const cur = await getExtras(env, id);
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    await env.FYP_KV.put(`x:${id}`, JSON.stringify(next));
    return next;
  } catch (e) { console.error('kv put', e); return false; }
}

/** Сохраняем публичную карточку, чтобы страница метки открылась даже при сбое таблицы. */
async function cachePublic(env, tag) {
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

async function getCachedPublic(env, id) {
  try {
    if (kvOn(env)) return await env.FYP_KV.get(`c:${id}`, 'json');
    if (typeof caches !== 'undefined') {
      const res = await caches.default.match(`https://fyp-cache.internal/c/${id}`);
      if (res) return await res.json();
    }
  } catch (e) { console.error('cache get', e); }
  return null;
}

async function rememberChat(env, chatId) {
  if (!kvOn(env)) return;
  try {
    const key = `chat:${chatId}`;
    if (!(await env.FYP_KV.get(key))) {
      await env.FYP_KV.put(key, JSON.stringify({ since: new Date().toISOString(), last_reminder: new Date().toISOString() }));
    }
  } catch (e) { console.error('rememberChat', e); }
}

async function sendReminders(env) {
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
      const res = await send(env, chatId, T.reminder, mainMenu());
      rec.last_reminder = new Date().toISOString();
      if (!res.ok) rec.failed = (rec.failed || 0) + 1;
      await env.FYP_KV.put(k.name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---------------------------------------------------------------
// SMS-резерв (Twilio). Включается, только если заданы TWILIO_*.
// ---------------------------------------------------------------
function smsEnabled(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

async function sendSms(env, to, body) {
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
    if (!res.ok) console.error('SMS error', res.status, (await res.text()).slice(0, 300));
    return res.ok;
  } catch (e) {
    console.error('SMS failed', e);
    return false;
  }
}

// ---------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------
async function handleUpdate(update, env, url) {
  if (update.callback_query) return handleCallback(update.callback_query, env, url);
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  await rememberChat(env, chatId); // для напоминаний (в т.ч. тех, кто зарегистрирован до обновления)

  // --- команды ---
  if (text.startsWith('/start')) {
    const token = text.split(/\s+/)[1];
    if (token) return linkFromSite(chatId, token, env, url);
    await db(env, 'clearState', { chat_id: chatId });
    return send(env, chatId, T.welcome, mainMenu());
  }
  if (text === '/register' || text === BTN_REGISTER) return startRegistration(chatId, msg, env);
  if (text === '/mytags' || text === BTN_MYTAGS) return myTags(chatId, env, url);
  if (text === '/lost' || text === BTN_LOST) return pickTag(chatId, env, 'lost', '🚨 Which pet is missing?');
  if (text === '/found') return pickTag(chatId, env, 'found', '✅ Which pet is home?', (t) => t._lost);
  if (text === '/settings' || text === BTN_SETTINGS) return pickTag(chatId, env, 'set', '⚙️ Settings for which pet?');
  if (text === '/cancel' || text === BTN_CANCEL) {
    await db(env, 'clearState', { chat_id: chatId });
    return send(env, chatId, T.cancelled, mainMenu());
  }
  if (text === '/id') return send(env, chatId, `Your chat ID: <code>${chatId}</code>`);
  if (text === '/help') return send(env, chatId, T.help, mainMenu());

  // --- многошаговые диалоги ---
  const st = (await db(env, 'getState', { chat_id: chatId })).state;
  if (!st || !st.step) return send(env, chatId, T.help, mainMenu());

  // режим «Потерялся»: где видели в последний раз
  if (st.step === 'lost_area') {
    const area = text === BTN_SKIP ? '' : str(text, 80);
    await db(env, 'clearState', { chat_id: chatId });
    return turnLostOn(chatId, st.tag_id, area, env, url);
  }
  // настройки: второй телефон / заметки
  if (st.step === 'set_phone2') {
    const p2 = normalizePhone(msg.contact ? msg.contact.phone_number : text);
    if (!p2) return send(env, chatId, T.badPhone);
    await db(env, 'clearState', { chat_id: chatId });
    await putExtras(env, st.tag_id, { phone2: p2 });
    return send(env, chatId, `✅ Second contact saved: ${esc(prettyPhone(p2))}\nIt is now shown on the pet page.`, mainMenu());
  }
  if (st.step === 'set_notes') {
    if (!text) return send(env, chatId, T.askNotes);
    await db(env, 'clearState', { chat_id: chatId });
    const notes = str(text, 200);
    await putExtras(env, st.tag_id, { notes });
    return send(env, chatId, `✅ Notes saved:\n<i>${esc(notes)}</i>\nThey are now shown on the pet page.`, mainMenu());
  }

  // регистрация
  if (st.step === 'name') {
    if (!text) return send(env, chatId, T.askName);
    st.owner_name = str(text, 80);
    st.step = 'phone';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, T.askPhone, {
      keyboard: [[{ text: '📱 Share my phone number', request_contact: true }], [{ text: BTN_CANCEL }]],
      resize_keyboard: true, one_time_keyboard: true,
    });
  }
  if (st.step === 'phone') {
    const phone = normalizePhone(msg.contact ? msg.contact.phone_number : text);
    if (!phone) return send(env, chatId, T.badPhone);
    st.phone = phone;
    st.step = 'pet';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, T.askPet, cancelKb());
  }
  if (st.step === 'pet') {
    if (!text) return send(env, chatId, T.askPet);
    st.pet_name = str(text, 40);
    st.step = 'address';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, T.askAddress, cancelKb());
  }
  if (st.step === 'address') {
    if (!text) return send(env, chatId, T.askAddress);
    st.address = str(text, 200);
    st.step = 'plan';
    await db(env, 'setState', { chat_id: chatId, state: st });
    await send(env, chatId, '👌', { remove_keyboard: true });
    return send(env, chatId,
      '💳 <b>Choose your plan</b> (one-time payment, no subscription):\n\n' +
      `• <b>Basic — ${PLANS.basic.price}</b>: tag with phone, QR and NFC; pet page; call & WhatsApp\n` +
      `• <b>Smart — ${PLANS.smart.price}</b>: + instant scan & location alerts, Lost mode, 2nd contact & notes\n` +
      `• <b>Family — ${PLANS.family.price}</b>: 3 Smart tags`,
      { inline_keyboard: Object.keys(PLANS).map((id) => [{ text: planLabel(id), callback_data: `plan_${id}` }]) });
  }
  if (st.step === 'plan') {
    return send(env, chatId, 'Please choose a plan using the buttons above.');
  }
  if (st.step === 'confirm') {
    return send(env, chatId, 'Please tap ✅ Confirm or ✏️ Start over above.');
  }
  return send(env, chatId, T.help, mainMenu());
}

function confirmMessage(env, chatId, st, url) {
  return send(env, chatId,
      '<b>Please check your details:</b>\n\n' +
      `👤 Owner: ${esc(st.owner_name)}\n📱 Phone: ${esc(prettyPhone(st.phone))}\n` +
      `🐾 Pet: ${esc(st.pet_name)}\n🏠 Address: ${esc(st.address)}\n💳 Plan: ${esc(planLabel(st.plan))}\n\n` +
      '🔒 By confirming, you agree that your first name, phone and pet\'s name are shown on the pet page ' +
      'to whoever scans the tag. Your address is used only for delivery. ' +
      `<a href="${esc(siteBase(env, url))}/privacy/">Privacy policy</a>`,
      { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'reg_ok' }, { text: '✏️ Start over', callback_data: 'reg_again' }]] });
}

async function handleCallback(cq, env, url) {
  const chatId = String(cq.message.chat.id);
  const data = String(cq.data || '');
  if (cq.id !== '0') await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }); // '0' — вызов из pickTag

  // --- действия с конкретной меткой: lost:ID, found:ID, set:ID, set2:ID:field, clr:ID:field ---
  const m = /^(lost|found|set|set2|clr):(\d{1,9})(?::(phone2|notes))?$/.exec(data);
  if (m) {
    const [, act, id, field] = m;
    const tag = await ownedTag(chatId, id, env);
    if (!tag) return send(env, chatId, '⚠️ This tag is not linked to your Telegram.', mainMenu());
    if (!kvOn(env)) return send(env, chatId, T.noKv, mainMenu());
    if (act === 'lost') {
      await db(env, 'setState', { chat_id: chatId, state: { step: 'lost_area', tag_id: id } });
      return send(env, chatId, `🚨 <b>Lost mode for ${esc(tag.pet_name)}</b>\n\n` + T.askArea, {
        keyboard: [[{ text: BTN_SKIP }], [{ text: BTN_CANCEL }]], resize_keyboard: true, one_time_keyboard: true,
      });
    }
    if (act === 'found') return turnLostOff(chatId, tag, env);
    if (act === 'set') return settingsMenu(chatId, tag, env);
    if (act === 'set2') {
      await db(env, 'setState', { chat_id: chatId, state: { step: field === 'phone2' ? 'set_phone2' : 'set_notes', tag_id: id } });
      return send(env, chatId, field === 'phone2' ? T.askPhone2 : T.askNotes, cancelKb());
    }
    if (act === 'clr') {
      await putExtras(env, id, { [field]: '' });
      return send(env, chatId, field === 'phone2' ? '🗑 Second contact removed.' : '🗑 Notes removed.', mainMenu());
    }
  }

  // --- регистрация: выбор тарифа ---
  const pm = /^plan_(\w+)$/.exec(data);
  if (pm && PLANS[pm[1]]) {
    const st = (await db(env, 'getState', { chat_id: chatId })).state;
    if (!st || st.step !== 'plan') return send(env, chatId, 'Session expired. Tap /register to start again.', mainMenu());
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    st.plan = pm[1];
    st.step = 'confirm';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return confirmMessage(env, chatId, st, url);
  }

  // --- регистрация ---
  if (data === 'reg_again' || data === 'reg_ok') {
    // убираем кнопки у сообщения с подтверждением
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (data === 'reg_again') return startRegistration(chatId, cq, env);
  if (data !== 'reg_ok') return;

  const st = (await db(env, 'getState', { chat_id: chatId })).state;
  if (!st || st.step !== 'confirm') return send(env, chatId, 'Session expired. Tap /register to start again.', mainMenu());

  const r = await db(env, 'register', {
    owner_name: st.owner_name, phone: st.phone, pet_name: st.pet_name, address: st.address,
    telegram_chat_id: chatId, tag_url_base: tagUrlBase(env, url), source: 'telegram',
  });
  if (!r.ok) return send(env, chatId, '⚠️ Something went wrong. Please try again: /register');
  await db(env, 'clearState', { chat_id: chatId });
  const plan = PLANS[st.plan] ? st.plan : DEFAULT_PLAN;
  await putExtras(env, r.tag.tag_id, { consent_at: new Date().toISOString(), consent_via: 'telegram', plan });
  await cachePublic(env, r.tag);
  await rememberChat(env, chatId);
  await sendRegistered(chatId, r.tag, env, url);
  await notifyAdmin(env, url, r.tag, 'telegram', plan);
}

/** Выбор метки для действия. Если метка одна — действие сразу. */
async function pickTag(chatId, env, action, question, filter) {
  if (!kvOn(env) && action !== 'mytags') return send(env, chatId, T.noKv, mainMenu());
  const r = await db(env, 'listByChat', { chat_id: chatId });
  if (!r.ok) return send(env, chatId, '⚠️ Could not load your tags right now. Please try again in a minute.');
  let tags = r.tags || [];
  if (!tags.length) return send(env, chatId, T.noTags, mainMenu());
  if (filter) {
    const withX = await Promise.all(tags.map(async (t) => ({ ...t, _lost: !!(await getExtras(env, t.tag_id)).lost })));
    tags = withX.filter(filter);
    if (!tags.length) return send(env, chatId, 'None of your pets is in Lost mode right now.', mainMenu());
  }
  if (tags.length === 1) {
    return handleCallback({ id: '0', data: `${action}:${tags[0].tag_id}`, message: { chat: { id: chatId } } }, env, null);
  }
  return send(env, chatId, question, {
    inline_keyboard: tags.map((t) => [{ text: `🐾 ${t.pet_name} · #${t.tag_id}`, callback_data: `${action}:${t.tag_id}` }]),
  });
}

async function ownedTag(chatId, id, env) {
  const r = await db(env, 'listByChat', { chat_id: chatId });
  const tags = (r.ok && r.tags) || [];
  return tags.find((t) => String(t.tag_id) === String(id)) || null;
}

async function turnLostOn(chatId, id, area, env, url) {
  const tag = await ownedTag(chatId, id, env);
  if (!tag) return send(env, chatId, '⚠️ This tag is not linked to your Telegram.', mainMenu());
  const since = new Date().toISOString();
  const x = await putExtras(env, id, { lost: true, lost_since: since, lost_area: area });
  if (!x) return send(env, chatId, T.noKv, mainMenu());
  const link = shortUrl(env, url, id);
  const share =
    `🚨 LOST: ${tag.pet_name}` + (area ? ` · last seen: ${area}` : '') + '\n' +
    `If you see ${tag.pet_name}, open this page to call the owner: ${link}`;

  // Публикация в канал сообщества (если настроен)
  if (env.LOST_CHANNEL_ID) {
    const post = await tg(env, 'sendMessage', {
      chat_id: env.LOST_CHANNEL_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text:
        `🚨 <b>Lost: ${esc(tag.pet_name)}</b>\n` +
        (area ? `📍 Last seen: ${esc(area)}\n` : '') +
        `🕒 Since ${fmtTime(env)}\n\n` +
        `Seen this pet? Open the page to call the owner:\n${esc(link)}`,
    });
    if (post && post.ok) await putExtras(env, id, { channel_msg_id: post.result.message_id });
  }

  await send(env, chatId,
    `🚨 <b>Lost mode is ON for ${esc(tag.pet_name)}.</b>\n\n` +
    `The tag page now says "My family has reported me missing"` + (area ? ` and shows the area: ${esc(area)}` : '') + '.\n' +
    `Every scan will be reported to you immediately.\n\n` +
    `📣 <b>Forward this to local groups</b> (neighbours, dog owners, lost pets groups):\n\n` +
    `<code>${esc(share)}</code>\n\n` +
    `When ${esc(tag.pet_name)} is home, send /found.`,
    mainMenu());
}

async function turnLostOff(chatId, tag, env) {
  const x = await getExtras(env, tag.tag_id);
  await putExtras(env, tag.tag_id, { lost: false, lost_since: '', lost_area: '', channel_msg_id: '' });
  if (env.LOST_CHANNEL_ID && x.channel_msg_id) {
    await tg(env, 'editMessageText', {
      chat_id: env.LOST_CHANNEL_ID,
      message_id: x.channel_msg_id,
      parse_mode: 'HTML',
      text: `✅ <b>${esc(tag.pet_name)} is home!</b> Thank you to everyone who helped ❤️`,
    });
  }
  return send(env, chatId, `✅ Great news! Lost mode is OFF — ${esc(tag.pet_name)}'s page is back to normal. ❤️`, mainMenu());
}

async function settingsMenu(chatId, tag, env) {
  const x = await getExtras(env, tag.tag_id);
  const p2 = normalizePhone(x.phone2);
  const kb = [
    [{ text: p2 ? '📞 Change second contact' : '📞 Add second contact', callback_data: `set2:${tag.tag_id}:phone2` }],
    [{ text: x.notes ? '📝 Change notes' : '📝 Add notes for the finder', callback_data: `set2:${tag.tag_id}:notes` }],
  ];
  if (p2) kb.push([{ text: '🗑 Remove second contact', callback_data: `clr:${tag.tag_id}:phone2` }]);
  if (x.notes) kb.push([{ text: '🗑 Remove notes', callback_data: `clr:${tag.tag_id}:notes` }]);
  return send(env, chatId,
    `⚙️ <b>${esc(tag.pet_name)} · tag #${tag.tag_id}</b>\n\n` +
    `📱 Main phone: ${esc(prettyPhone(normalizePhone(tag.phone)))}\n` +
    `📞 Second contact: ${p2 ? esc(prettyPhone(p2)) : '—'}\n` +
    `📝 Notes: ${x.notes ? '<i>' + esc(x.notes) + '</i>' : '—'}\n\n` +
    'To change the main phone or name, just write to us here.',
    { inline_keyboard: kb });
}

async function startRegistration(chatId, from, env) {
  await db(env, 'setState', { chat_id: chatId, state: { step: 'name' } });
  const first = from.from && from.from.first_name ? from.from.first_name : '';
  const kb = first
    ? { keyboard: [[{ text: first }], [{ text: BTN_CANCEL }]], resize_keyboard: true, one_time_keyboard: true }
    : cancelKb();
  return send(env, chatId, '📝 <b>New pet registration</b>\n\n' + T.askName, kb);
}

/** Пользователь зарегистрировался на сайте и нажал Start по ссылке t.me/Bot?start=<token> */
async function linkFromSite(chatId, token, env, url) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return send(env, chatId, T.notFoundToken, mainMenu());
  const r = await db(env, 'linkTelegram', { token, chat_id: chatId });
  if (!r.ok || !r.found) return send(env, chatId, T.notFoundToken, mainMenu());
  await rememberChat(env, chatId);
  await cachePublic(env, r.tag);
  return sendRegistered(chatId, r.tag, env, url);
}

async function sendRegistered(chatId, tag, env, url) {
  const link = shortUrl(env, url, tag.tag_id);
  await send(env, chatId,
    `🎉 <b>${esc(tag.owner_name)}, you are registered in FindYpet!</b>\n\n` +
    `🐾 Pet: <b>${esc(tag.pet_name)}</b>\n` +
    `🆔 Tag: <b>#${tag.tag_id}</b>\n` +
    `🔗 Pet page: ${esc(link)}\n\n` +
    `When someone scans the tag, I'll alert you here, and they can call you, write on WhatsApp ` +
    `or send you their location. Keep notifications for this chat turned on 🔔\n\n` +
    `<b>Useful commands</b>\n` +
    `⚙️ /settings — add a second contact and notes (allergies, "don't chase me")\n` +
    `🚨 /lost — if ${esc(tag.pet_name)} goes missing\n` +
    `📲 When the tag arrives: hold your phone to it to check it opens this page.`,
    { inline_keyboard: [[{ text: '👀 Preview pet page', url: link }], [{ text: '⚙️ Add second contact / notes', callback_data: `set:${tag.tag_id}` }]] });
  return send(env, chatId, 'Use /mytags any time to see your tags.', mainMenu());
}

async function myTags(chatId, env, url) {
  const r = await db(env, 'listByChat', { chat_id: chatId });
  const tags = (r.ok && r.tags) || [];
  if (!tags.length) return send(env, chatId, T.noTags, mainMenu());
  const lines = await Promise.all(tags.map(async (t) => {
    const x = await getExtras(env, t.tag_id);
    return `🐾 <b>${esc(t.pet_name)}</b> — tag #${t.tag_id}` + (x.lost ? '  🚨 <b>LOST MODE</b>' : '') + '\n' +
      `🔗 ${esc(shortUrl(env, url, t.tag_id))}` +
      (x.phone2 ? `\n📞 2nd contact: ${esc(prettyPhone(normalizePhone(x.phone2)))}` : '') +
      (x.notes ? `\n📝 ${esc(x.notes)}` : '') +
      (t.last_scan_at ? `\n🕒 last scan: ${esc(t.last_scan_at)}` : '');
  }));
  return send(env, chatId, '<b>Your tags</b>\n\n' + lines.join('\n\n') + '\n\n/settings · /lost · /found', mainMenu());
}

async function notifyAdmin(env, url, tag, source, plan) {
  if (!env.ADMIN_CHAT_ID) return;
  const link = tagUrlBase(env, url) + tag.tag_id;
  const short = shortUrl(env, url, tag.tag_id);
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=8&data=${encodeURIComponent(short)}`;
  await tg(env, 'sendMessage', {
    chat_id: env.ADMIN_CHAT_ID,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      `🆕 <b>New tag #${tag.tag_id}</b> (via ${source})\n` +
      `💳 Plan: <b>${esc(planLabel(plan))}</b>\n` +
      `👤 ${esc(tag.owner_name)} · 📱 ${esc(prettyPhone(normalizePhone(tag.phone)))}\n` +
      `🐾 ${esc(tag.pet_name)}\n🏠 ${esc(tag.address)}\n` +
      `Telegram: ${tag.telegram_chat_id ? '✅ linked' : '⏳ not yet'}\n\n` +
      `🔤 <b>Engrave on the front:</b> ${esc(String(tag.pet_name).toUpperCase())} · ${esc(prettyPhone(normalizePhone(tag.phone)).replace('+972 ', '0'))}\n` +
      `✍️ <b>Write to NFC:</b>\n<code>${esc(link)}</code>\n` +
      `🔳 <b>QR (print on the back):</b> <code>${esc(short)}</code>\n<a href="${esc(qr)}">Download QR image</a>`,
  });
}

// ---------------------------------------------------------------
// One-time setup: webhook, commands, descriptions
// ---------------------------------------------------------------
async function setup(env, url) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const results = {};
  results.setWebhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  results.setMyCommands = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'register', description: 'Register a pet and get a tag' },
      { command: 'mytags', description: 'My pets, links and status' },
      { command: 'lost', description: '🚨 My pet is missing — Lost mode on' },
      { command: 'found', description: '✅ My pet is home — Lost mode off' },
      { command: 'settings', description: 'Second contact and notes for the finder' },
      { command: 'cancel', description: 'Cancel the current action' },
      { command: 'help', description: 'Help' },
    ],
  });
  results.setMyDescription = await tg(env, 'setMyDescription', {
    description:
      'FindYpet — smart pet ID tag with your phone number, QR and NFC. Whoever finds your pet can call you, ' +
      'write on WhatsApp or send their location — and you get an alert here the moment the tag is scanned. ' +
      'Tap Start to register.',
  });
  results.setMyShortDescription = await tg(env, 'setMyShortDescription', {
    short_description: 'Lost pet? Whoever finds it can call you or send you the location. Alerts right here.',
  });
  results.webhookInfo = await tg(env, 'getWebhookInfo', {});
  results.db = await db(env, 'getTag', { id: '0' }).catch((e) => ({ ok: false, error: String(e) }));
  results.kv = kvOn(env) ? 'FYP_KV connected ✅' : 'FYP_KV NOT connected — /lost, /settings and backup cache are off';
  results.lostChannel = env.LOST_CHANNEL_ID ? `posting to ${env.LOST_CHANNEL_ID}` : 'not set (optional)';
  results.sms = smsEnabled(env) ? 'SMS fallback on' : 'SMS fallback off (optional)';
  return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
async function db(env, action, data = {}) {
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
      return { ok: false, error: 'db_bad_response' };
    }
  } catch (err) {
    console.error('DB request failed', action, String(err && err.message || err));
    return { ok: false, error: 'db_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

async function tg(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.error('TG error', method, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('TG fetch failed', method, e);
    return { ok: false };
  }
}

function send(env, chatId, text, replyMarkup) {
  const p = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) p.reply_markup = replyMarkup;
  return tg(env, 'sendMessage', p);
}

function mainMenu() {
  return {
    keyboard: [[{ text: BTN_REGISTER }, { text: BTN_MYTAGS }], [{ text: BTN_LOST }, { text: BTN_SETTINGS }]],
    resize_keyboard: true,
  };
}
function cancelKb() {
  return { keyboard: [[{ text: BTN_CANCEL }]], resize_keyboard: true };
}

function siteBase(env, url) {
  return (env.SITE_URL || (url ? url.origin : '')).replace(/\/+$/, '');
}

/** Длинная ссылка — её пишут в NFC (старые метки продолжают работать). */
function tagUrlBase(env, url) {
  return `${siteBase(env, url)}/tag/?id=`;
}

/** Короткая ссылка для QR и сообщений: /t/101 */
function shortUrl(env, url, id) {
  return `${siteBase(env, url)}/t/${id}`;
}

/** Приводит номер к формату +972XXXXXXXXX. Возвращает '' если номер некорректный. */
function normalizePhone(raw) {
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

function prettyPhone(p) {
  let m = /^\+972(5\d)(\d{3})(\d{4})$/.exec(p);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  m = /^\+972(\d)(\d{3})(\d{4})$/.exec(p);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  return p;
}

function fmtTime(env) {
  return new Date().toLocaleString('en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Jerusalem', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, env, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env) },
  });
}

// ---------------------------------------------------------------
// Встроенный сайт (для версии "один файл", вставляемой в редактор Cloudflare).
// В обычной версии (wrangler + папка site) EMBEDDED = null и сайт отдаёт env.ASSETS.
// ---------------------------------------------------------------
const EMBEDDED = /*__EMBEDDED__*/null;

function serveEmbedded(url, env) {
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
    headers: { 'Content-Type': f.type, 'Cache-Control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=300' },
  });
}

// экспорт для тестов
export const _test = { normalizePhone, prettyPhone, publicTag, publicExtras, PLANS };
