import { turnstileStatus } from './api.js';
import { d1Status, db, tg } from './db.js';
import { LANGS, tr } from './i18n.js';
import { kvOn, smsEnabled } from './store.js';
import { clientIp, json, limited } from './util.js';
import { isTestSite } from './worker.js';
// ---------------------------------------------------------------
// One-time setup: webhook, commands, descriptions
// ---------------------------------------------------------------
/** Сравнение строк за одинаковое время (ключ не подбирается по скорости ответа). */
export function sameSecret(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** /setup: GET — форма, POST — ключ в теле запроса. Ключ в адресе больше не принимается
 *  (адрес остаётся в истории браузера, в логах и в переписке). */
export async function setupRoute(request, env, url) {
  const noStore = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  const form = (msg, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>FindYpet setup</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#0E3B3D}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin:8px 0;border-radius:10px;border:1px solid #738F8E}button{background:#0E3B3D;color:#fff;border:0;cursor:pointer}.err{color:#B42318;font-weight:600}</style></head><body><h1>FindYpet setup</h1>${msg ? `<p class="err" role="alert">${msg}</p>` : ''}<form method="post" action="/setup"><label for="k">Setup key</label><input id="k" name="key" type="password" autocomplete="off" required autofocus><button type="submit">Run setup</button></form></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...noStore } });
  if (request.method === 'GET') {
    if (url.searchParams.has('key')) return form('The key is no longer accepted in the address. Enter it below.', 403);
    return form('');
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  if (await limited(env, 'RL_SIGNAL', `${clientIp(request)}:/setup`)) return form('Too many attempts. Wait a minute.', 429);
  let key = '';
  try {
    const type = request.headers.get('Content-Type') || '';
    if (type.includes('application/json')) key = (await request.json()).key;
    else key = (await request.formData()).get('key');
  } catch (e) { key = ''; }
  const expected = env.SETUP_KEY || env.WEBHOOK_SECRET;
  if (!sameSecret(key, expected)) return form('Wrong key.', 403);
  const res = await setup(env, url);
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(noStore)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

export async function setup(env, url) {
  const results = {};
  // Тестовый сайт с токеном рабочего бота перехватил бы его webhook — отказываемся
  const me = await tg(env, 'getMe', {});
  results.bot = me && me.ok && me.result ? `@${me.result.username}` : 'getMe failed';
  if (isTestSite(env) && me && me.ok && me.result && me.result.username === 'YourPetLocatorBot') {
    return new Response(JSON.stringify({ error: 'This test site has the PRODUCTION bot token. Put the test bot token into BOT_TOKEN of findypet-app-staging.' }, null, 2),
      { status: 409, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  results.setWebhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  // Отображаемое имя бота (у Telegram строгий лимит на смену имени — меняем, только если оно другое)
  const botName = env.STAGE === 'test' ? 'FindYpet TEST' : 'FindYpet';
  const curName = await tg(env, 'getMyName', {});
  results.setMyName = curName && curName.ok && curName.result && curName.result.name === botName
    ? `${botName} ✅` : await tg(env, 'setMyName', { name: botName });
  // Меню команд и описание бота: английский — по умолчанию, иврит и русский — для Telegram на этих языках
  for (const l of LANGS) {
    const lc = l === 'en' ? {} : { language_code: l };
    const sfx = l === 'en' ? '' : `_${l}`;
    const c = tr(l, 'cmds');
    results[`setMyCommands${sfx}`] = await tg(env, 'setMyCommands', {
      ...lc,
      commands: ['register', 'mytags', 'lost', 'found', 'settings', 'photo', 'care', 'lang', 'delete', 'cancel', 'help']
        .map((command) => ({ command, description: c[command] })),
    });
    results[`setMyDescription${sfx}`] = await tg(env, 'setMyDescription', { ...lc, description: tr(l, 'desc') });
    results[`setMyShortDescription${sfx}`] = await tg(env, 'setMyShortDescription', { ...lc, short_description: tr(l, 'shortDesc') });
  }
  results.webhookInfo = await tg(env, 'getWebhookInfo', {});
  results.db = await db(env, 'getTag', { id: '0' }).catch((e) => ({ ok: false, error: String(e) }));
  const ver = await db(env, 'version', {}).catch(() => ({}));
  results.db_version = ver && ver.version ? `Apps Script v${ver.version}` : 'Apps Script v1 — update it (apps-script/Code.gs): /delete and relink protection need v2';
  results.d1 = await d1Status(env);
  results.kv = kvOn(env) ? 'FYP_KV connected ✅' : 'FYP_KV NOT connected — /lost, /settings and backup cache are off';
  results.rate_limits = ['RL_READ', 'RL_SIGNAL', 'RL_ORDER', 'RL_TAG'].map((n) => `${n} ${env[n] && typeof env[n].limit === 'function' ? '✅' : '❌'}`).join(' · ');
  results.lostChannel = env.LOST_CHANNEL_ID ? `posting to ${env.LOST_CHANNEL_ID}` : 'not set (optional)';
  results.sms = smsEnabled(env) ? 'SMS fallback on' : 'SMS fallback off (optional)';
  results.turnstile = await turnstileStatus(env);
  results.setup_key = env.SETUP_KEY ? 'separate SETUP_KEY ✅' : 'using WEBHOOK_SECRET — add a separate SETUP_KEY secret ⚠️';
  return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
