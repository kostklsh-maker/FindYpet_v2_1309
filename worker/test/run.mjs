// Сквозные тесты API и бота на мок-окружении. Запуск: node test/run.mjs
import assert from 'node:assert/strict';
import { state, KV, makeEnv, call, tgUpdate, msg, cb, worker } from './mock.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('✔', name); }
  catch (e) { console.error('✘', name, '\n  ', e.message); process.exitCode = 1; }
}
const lastTg = (method) => [...state.tg].reverse().find((c) => !method || c.method === method);
const env = makeEnv();

await test('landing, tag page, privacy and /t/ short link are served', async () => {
  for (const p of ['/', '/tag/?id=1', '/privacy/', '/t/101', '/js/i18n.js', '/assets/logo.png']) {
    const r = await call(env, p);
    assert.equal(r.status, 200, p);
  }
  const t = await (await call(env, '/t/101')).text();
  assert.match(t, /Write on WhatsApp/);
  const home = await (await call(env, '/')).text();
  assert.match(home, /fastest way home/);
  assert.doesNotMatch(home, /precise location/);
  assert.doesNotMatch(home, /100 ₪/);
  assert.match(home, /id="plans"/);
  const plans = await (await call(env, '/js/plans.js')).text();
  assert.match(plans, /"basic":\{"price":"49 ₪"/);
  assert.match(plans, /"family"/);
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
    phone2: '052-765-4321', notes: 'Allergic to chicken. Scared of people.', consent: true, lang: 'ru', plan: 'smart' } });
  const d = await r.json();
  assert.equal(d.success, true);
  tagId = d.id_tag; token = d.telegram_link.split('start=')[1];
  assert.equal(d.tag_url, `http://localhost:8787/t/${tagId}`);
  const x = await KV.get(`x:${tagId}`, 'json');
  assert.equal(x.phone2, '+972527654321');
  assert.ok(x.consent_at);
  assert.equal(x.plan, 'smart');
  assert.equal(d.order_id, `FY${tagId}`);
  assert.equal(d.tags.length, 1);
  const admin = lastTg('sendMessage');
  assert.equal(admin.payload.chat_id, 'admin');
  assert.match(admin.payload.text, /QR/);
  assert.match(admin.payload.text, /New order FY\d+/);
  assert.match(admin.payload.text, /Smart · 79 ₪ — <b>1 physical tag<\/b>/);
  assert.match(admin.payload.text, /Engrave front: <b>BELLA<\/b> · 050-123-4567/);
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

await test('database outage → page served from backup cache (stale), not "not activated"', async () => {
  state.gasDown = true;
  const r = await call(env, `/api/tag?id=${tagId}`);
  const d = await r.json();
  state.gasDown = false;
  assert.equal(d.found, true);
  assert.equal(d.stale, true);
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
await test('link from site → registered message with short link and settings button', async () => {
  await tgUpdate(env, msg(CHAT, '/start ' + token));
  const m = state.tg.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === CHAT).at(-2);
  assert.match(m.payload.text, new RegExp(`/t/${tagId}`));
  assert.ok(await KV.get(`chat:${CHAT}`));
});

await test('scan alert has "Lost mode on" button', async () => {
  await new Promise((r) => setTimeout(r, 1100));
  await call(env, '/api/scan', { method: 'POST', body: { id_tag: tagId } });
  const m = lastTg('sendMessage');
  assert.equal(m.payload.chat_id, CHAT);
  assert.equal(m.payload.reply_markup.inline_keyboard[0][0].callback_data, `lost:${tagId}`);
});

await test('/lost → asks area → Lost mode on, share text, channel post', async () => {
  const chEnv = makeEnv({ LOST_CHANNEL_ID: '@findypet_lost' });
  await tgUpdate(chEnv, msg(CHAT, '/lost'));
  assert.equal(state.states[CHAT].step, 'lost_area');
  await tgUpdate(chEnv, msg(CHAT, 'Haifa, Carmel'));
  const x = await KV.get(`x:${tagId}`, 'json');
  assert.equal(x.lost, true);
  assert.equal(x.lost_area, 'Haifa, Carmel');
  assert.equal(x.channel_msg_id, 555);
  const post = state.tg.find((c) => c.payload.chat_id === '@findypet_lost');
  assert.match(post.payload.text, /Lost: Bella/);
  assert.match(lastTg('sendMessage').payload.text, /Forward this to local groups/);
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

await test('bot registration: Family plan → 2 pets + 1 spare, one order, production sheet', async () => {
  const C = '7007';
  await tgUpdate(env, msg(C, '/register'));
  await tgUpdate(env, msg(C, 'Anna'));
  await tgUpdate(env, msg(C, '054-111-2222'));
  await tgUpdate(env, msg(C, 'Rex'));
  await tgUpdate(env, msg(C, 'Tel Aviv'));
  const planMsg = lastTg('sendMessage').payload;
  assert.match(planMsg.text, /Choose your plan/);
  assert.equal(planMsg.reply_markup.inline_keyboard.length, 3);
  await tgUpdate(env, cb(C, 'plan_family'));
  const q = lastTg('sendMessage').payload;
  assert.match(q.text, /has 3 tags/);
  assert.equal(q.reply_markup.inline_keyboard.length, 3);
  await tgUpdate(env, cb(C, 'fam_n_2'));
  assert.match(lastTg('sendMessage').payload.text, /Name of pet #2/);
  await tgUpdate(env, msg(C, 'Mika'));
  const sp = lastTg('sendMessage').payload;
  assert.match(sp.text, /spare tag — for which pet/);
  await tgUpdate(env, cb(C, 'fam_sp_0'));
  const conf = lastTg('sendMessage').payload.text;
  assert.match(conf, /Rex — 2 tags \(1 spare\)/);
  assert.match(conf, /• Mika/);
  assert.match(conf, /Family/);
  assert.match(conf, /Privacy policy/);
  const n = state.tags.length;
  await tgUpdate(env, cb(C, 'reg_ok'));
  const created = state.tags.slice(n);
  assert.deepEqual(created.map((t) => t.pet_name), ['Rex', 'Mika']);
  assert.ok(created.every((t) => t.telegram_chat_id === C && t.phone === '+972541112222' && t.address === 'Tel Aviv'));
  const rx = await KV.get(`x:${created[0].tag_id}`, 'json');
  assert.equal(rx.plan, 'family'); assert.equal(rx.copies, 2); assert.equal(rx.order_id, `FY${created[0].tag_id}`);
  assert.equal((await KV.get(`x:${created[1].tag_id}`, 'json')).copies, 1);
  const order = await KV.get(`o:FY${created[0].tag_id}`, 'json');
  assert.equal(order.chat_id, C);
  assert.equal(order.items.reduce((s, i) => s + i.copies, 0), 3);
  const admin = [...state.tg].reverse().find((c) => c.payload.chat_id === 'admin').payload.text;
  assert.match(admin, /3 physical tags/);
  assert.match(admin, /Tag 2 of 3 — #\d+ \(spare\)/);
  assert.match(admin, /Engrave front: <b>MIKA<\/b>/);
  const reg = state.tg.filter((c) => c.payload.chat_id === C && c.method === 'sendMessage').at(-2).payload.text;
  assert.match(reg, /Order <b>FY/);
  assert.match(reg, /Rex<\/b> — tag #\d+ · 2 tags \(incl. 1 spare\)/);
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

await test('site: Family with 1 pet → one tag ×3 (2 spares)', async () => {
  const n = state.tags.length;
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Dana Levi', phone: '052-999-8877', pet_name: 'Luna', address: 'Haifa', consent: true, plan: 'family' } })).json();
  assert.equal(d.success, true);
  assert.equal(state.tags.length, n + 1);
  assert.equal(d.total_tags, 3);
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Luna', 3]]);
});

let famTokenTagIds;
await test('site: Family with 3 pets → 3 rows, same owner data, one order', async () => {
  const n = state.tags.length;
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Olga K', phone: '053-222-3344', pet_name: 'Tom', address: 'Ashdod, Herzl 5', consent: true, plan: 'family',
    pets: ['Jerry', 'Spike'], phone2: '053-000-1111', notes: 'Tom is deaf' } })).json();
  assert.equal(d.success, true);
  const rows = state.tags.slice(n);
  assert.deepEqual(rows.map((t) => t.pet_name), ['Tom', 'Jerry', 'Spike']);
  assert.ok(rows.every((t) => t.owner_name === 'Olga K' && t.phone === '+972532223344' && t.address === 'Ashdod, Herzl 5'));
  assert.equal(new Set(rows.map((t) => t.tag_id)).size, 3);
  assert.deepEqual(d.tags.map((t) => t.copies), [1, 1, 1]);
  // второй контакт — для всех, заметки — только для первого питомца
  const x = await Promise.all(rows.map((t) => KV.get(`x:${t.tag_id}`, 'json')));
  assert.ok(x.every((e) => e.phone2 === '+972530001111' && e.order_id === d.order_id));
  assert.equal(x[0].notes, 'Tom is deaf'); assert.equal(x[1].notes, undefined);
  famTokenTagIds = { token: d.telegram_link.split('start=')[1], ids: rows.map((t) => t.tag_id), order: d.order_id };
});

await test('site: Family with 2 pets, spare for pet #2', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Max', address: 'Eilat', consent: true, plan: 'family',
    pets: ['Bim'], spare_for: [1] } })).json();
  assert.deepEqual(d.tags.map((t) => [t.pet_name, t.copies]), [['Max', 1], ['Bim', 2]]);
});

await test('site: Smart ignores extra pets (1 tag)', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Ron', phone: '054-555-6666', pet_name: 'Solo', address: 'Eilat', consent: true, plan: 'smart', pets: ['X', 'Y'] } })).json();
  assert.equal(d.tags.length, 1); assert.equal(d.total_tags, 1);
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

await test('Basic plan: no scan alerts, location goes via WhatsApp, Lost mode offers upgrade', async () => {
  const d = await (await call(env, '/api/register', { method: 'POST', body: {
    owner_name: 'Basic Ben', phone: '050-777-8888', pet_name: 'Pip', address: 'Holon', consent: true, plan: 'basic',
    phone2: '050-111-1111', notes: 'secret' } })).json();
  const id = d.id_tag, C = '4004';
  const x = await KV.get(`x:${id}`, 'json');
  assert.equal(x.phone2, undefined); assert.equal(x.notes, undefined); // доп. поля — только в Смарт
  await tgUpdate(env, msg(C, '/start ' + d.telegram_link.split('start=')[1]));
  const reg = state.tg.filter((c) => c.payload.chat_id === C).at(-2).payload.text;
  assert.match(reg, /Your plan is <b>Basic<\/b>/);
  const t = await (await call(env, `/api/tag?id=${id}`)).json();
  assert.equal(t.can_notify, false);
  const n = state.tg.length;
  await new Promise((r) => setTimeout(r, 1100));
  await call(env, '/api/scan', { method: 'POST', body: { id_tag: id } });
  assert.equal(state.tg.slice(n).filter((c) => c.payload.chat_id === C).length, 0);
  const loc = await (await call(env, '/api/location', { method: 'POST', body: { id_tag: id, lat: 32, lon: 34.8 } })).json();
  assert.equal(loc.error, 'not_linked');
  await tgUpdate(env, msg(C, '/lost'));
  assert.match(lastTg('sendMessage').payload.text, /part of the <b>Smart<\/b> plan/);
});

await test('old tags without a plan keep Smart features', async () => {
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
});

console.log(`\n${passed} tests passed`);
