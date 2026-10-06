// Сквозные тесты API и бота на мок-окружении. Запуск: node test/run.mjs
import assert from 'node:assert/strict';
import { state, KV, makeKV, makeEnv, call, tgUpdate, msg, cb, worker } from './mock.mjs';

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
  assert.match(admin, /Engrave front: <b>MIKA<\/b>/);
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

console.log(`\n${passed} tests passed`);
