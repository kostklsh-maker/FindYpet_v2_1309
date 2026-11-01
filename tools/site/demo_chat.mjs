// The demo chat on the homepage shows the real bot messages: made here from the bot's own texts (worker/src/i18n.js,
// via the built worker) for Sam, so the demo and the bot never drift apart. Prints JSON {key: {en, he, ru}}.
// Usage (from the repo root, after python3 worker/build.py): node tools/site/demo_chat.mjs worker/dist/worker.js
// The keys go into js/i18n.js (en / he / ru); the test "demo chat on the landing = the real bot messages" checks them.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { _test } = await import(pathToFileURL(resolve(process.argv[2] || 'worker/dist/worker.js')).href);
const tr = _test.tr;
export const NAME = { en: 'Sam', he: 'סאם', ru: 'Сэм' };
const LOC = { en: 'en-GB', he: 'he-IL', ru: 'ru-RU' };
const NOTES = {
  en: "I'm scared of scooters. Please don't chase me, call Dana instead.",
  he: 'אני מפחד מקורקינטים. בבקשה אל תרדפו אחריי, התקשרו לדנה.',
  ru: 'Я боюсь самокатов. Пожалуйста, не гонитесь за мной, лучше позвоните Дане.',
};
const iso = (t) => '⁦' + t + '⁩';
const br = (s) => s.replace(/\n+$/, '').replace(/\n/g, '<br>');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = {};
const put = (k, L, v) => { (out[k] = out[k] || {})[L] = v; };
for (const L of ['en', 'he', 'ru']) {
  const pet = NAME[L];
  const time = (min) => new Date(Date.UTC(2026, 9, 6, 11, min)).toLocaleString(LOC[L], { timeZone: 'Asia/Jerusalem', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  // someone opened the pet's page (+ the reply-keyboard button under it)
  put('xMsgScanned', L, br(tr(L, 'scanned', { pet, time: time(32) })) + `<span class="tg-kb">${tr(L, 'btnLostOn')}</span>`);
  // "Notify the owner" without the location / the finder shared the location (links are not clickable in the demo)
  put('xMsgFound', L, br(tr(L, 'foundHead', { pet, time: time(33) }) + tr(L, 'foundNoLoc')));
  const links = `🗺 <u>${tr(L, 'maps')}</u> · 🚗 <u>Waze</u>`;
  put('xMsgLocation', L, br(tr(L, 'locHead', { pet, time: time(33), acc: 12 })) + `<span class="tg-links">${L === 'he' ? iso(links) : links}</span>`);
  // /lost — without the paragraph with the poster texts for local groups
  const MARK = '\u0000SHARES\u0000';
  let lost = tr(L, 'lostOn', { pet, area: '', shares: MARK, photo: true });
  lost = lost.replace(new RegExp('📣[\\s\\S]*?' + MARK + '\\n\\n'), '');
  put('xMsgLostOn', L, br(lost));
  put('xMsgLostOff', L, br(tr(L, 'lostOff', { pet })));
  const phone = `<span class="tel">${L === 'he' ? iso('050-123-4567') : '050-123-4567'}</span>`;  // the number is not broken across lines
  put('xMsgSettings', L, br(tr(L, 'settings', { pet, id: 2048, phone, p2: '', notes: esc(NOTES[L]), photo: true })));
}
process.stdout.write(JSON.stringify(out, null, 1));
