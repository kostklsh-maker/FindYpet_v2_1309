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
    phone2: '052-765-4321', notes: 'Allergic to chicken. Scared of people.', consent: true, lang: 'ru', plan: 'basic' } });
  const d = await r.json();
  assert.equal(d.success, true);
  tagId = d.id_tag; token = d.telegram_link.split('start=')[1];
  assert.equal(d.tag_url, `http://localhost:8787/t/${tagId}`);
  const x = await KV.get(`x:${tagId}`, 'json');
  assert.equal(x.phone2, '+972527654321');
  assert.ok(x.consent_at);
  assert.equal(x.plan, 'basic');
  const admin = lastTg('sendMessage');
  assert.equal(admin.payload.chat_id, 'admin');
  assert.match(admin.payload.text, /QR/);
  assert.match(admin.payload.text, /Plan: <b>Basic · 49 ₪/);
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

await test('bot registration flow still works (with privacy note) ', async () => {
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
  assert.match(lastTg('sendMessage').payload.text, /Plan: Family/);
  assert.match(lastTg('sendMessage').payload.text, /Privacy policy/);
  await tgUpdate(env, cb(C, 'reg_ok'));
  const rex = state.tags.find((t) => t.pet_name === 'Rex' && t.telegram_chat_id === C);
  assert.ok(rex);
  assert.equal((await KV.get(`x:${rex.tag_id}`, 'json')).plan, 'family');
  assert.ok(state.tg.some((c) => c.payload.chat_id === 'admin' && /Plan: <b>Family/.test(c.payload.text)));
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

console.log(`\n${passed} tests passed`);
