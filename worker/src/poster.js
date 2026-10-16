import { publicTag } from './api.js';
import { db, posterUrl, siteBase } from './db.js';
import { feats } from './pricing.js';
import { cachePublic, getCachedPublic, getExtras } from './store.js';
import { esc, normalizePhone, prettyPhone } from './util.js';
// ---------------------------------------------------------------
// Объявление «Потерялся»: /p/101. Иврит, русский и английский сразу (группы смешанные, плакат печатают),
// фото, район, большая кнопка «Позвонить», WhatsApp, QR-код на это же объявление, печать A4.
// Открытие объявления НЕ считается сканом жетона: владельца не будят уведомлениями из групп.
// Питомец уже дома — номер телефона не показываем, только «Спасибо всем».
// ---------------------------------------------------------------
export const POSTER_TXT = {
  lost: { he: 'חיית מחמד אבודה', ru: 'Потерялся питомец', en: 'Lost pet' },
  home: { he: 'כבר בבית!', ru: 'Уже дома!', en: 'Home again!' },
  ask: {
    he: 'ראיתם את חיית המחמד? התקשרו לבעלים. אל תרדפו אחריה — היא עלולה להיבהל ולברוח.',
    ru: 'Видели этого питомца? Позвоните хозяину. Не догоняйте — он может испугаться и убежать.',
    en: 'Seen this pet? Call the owner. Please don\'t chase — it may get scared and run.',
  },
  thanks: { he: 'תודה לכל מי שעזר ❤️', ru: 'Спасибо всем, кто помогал ❤️', en: 'Thank you to everyone who helped ❤️' },
  call: { he: 'התקשרו לבעלים', ru: 'Позвонить хозяину', en: 'Call the owner' },
  seen: { he: 'אזור', ru: 'Где видели', en: 'Last seen' },
  since: { he: 'מאז', ru: 'С', en: 'Since' },
  scan: { he: 'סרקו כדי להתקשר', ru: 'Наведите камеру, чтобы позвонить', en: 'Scan to call the owner' },
  print: { he: 'הדפסה', ru: 'Печать', en: 'Print' },
  share: { he: 'שיתוף', ru: 'Поделиться', en: 'Share' },
  wa: { he: 'ראיתי את חיית המחמד שלכם', ru: 'Я видел(а) вашего питомца', en: 'I saw your pet' },
  gone: { he: 'הדף לא נמצא', ru: 'Страница не найдена', en: 'Page not found' },
};
export const tri = (k, sep = ' · ') => ['he', 'ru', 'en'].map((l) => POSTER_TXT[k][l]).join(sep);
export const triHtml = (k, cls = '') => ['he', 'ru', 'en']
  .map((l) => `<span lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}"${cls ? ` class="${cls}"` : ''}>${esc(POSTER_TXT[k][l])}</span>`).join('');

export async function posterPage(env, url, id, ctx) {
  let pub = await getCachedPublic(env, id);
  if (!pub || !pub.found) {
    const r = await db(env, 'getTag', { id });
    if (r.ok && r.found && String(r.tag.status) !== 'disabled') {
      pub = publicTag(r.tag, env);
      ctx.waitUntil(cachePublic(env, r.tag));
    } else pub = null;
  }
  const headers = {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
  };
  if (!pub) {
    return new Response(posterShell('FindYpet', '', `<main class="gone"><h1>${esc(tri('gone'))}</h1><p><a href="/">findy-pet.com</a></p></main>`),
      { status: 404, headers });
  }
  const x = await getExtras(env, id);
  const site = siteBase(env, url);
  const self = posterUrl(env, url, x.code || id);
  const pet = pub.pet_name || '';
  const lost = !!x.lost;
  const photo = x.photo_v ? `/img/${x.code || id}?v=${x.photo_v}` : '';
  const ogImg = photo ? site + photo : `${site}/assets/logo.png`;
  const area = lost ? String(x.lost_area || '') : '';
  const since = lost && x.lost_since ? new Date(x.lost_since).toLocaleDateString('en-GB', { timeZone: env.TIMEZONE || 'Asia/Jerusalem' }).replace(/\//g, '.') : '';
  const phone = normalizePhone(pub.phone);
  const local = prettyPhone(phone).replace(/^\+972 /, '0');
  const wa = phone ? `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(`🐾 ${pet}: ${tri('wa')} — ${self}`)}` : '';
  const notes = lost && feats(x).extras ? String(x.notes || '') : '';

  const title = lost ? `🚨 ${pet} — ${tri('lost')}` : `✅ ${pet} — ${tri('home')}`;
  const desc = lost ? (area ? `📍 ${area} · ` : '') + tri('call') : tri('thanks');
  const meta =
    `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:image" content="${esc(ogImg)}"><meta property="og:url" content="${esc(self)}"><meta property="og:type" content="website">` +
    `<meta name="twitter:card" content="${photo ? 'summary_large_image' : 'summary'}">`;

  const pic = photo
    ? `<figure class="photo"><img src="${esc(photo)}" alt="${esc(pet)}"></figure>`
    : '<figure class="photo none" aria-hidden="true"><span>🐾</span></figure>';
  const body = lost
    ? `<header class="band">🚨 ${triHtml('lost')}</header>
<main>
${pic}
<h1 dir="auto">${esc(pet)}</h1>
${area || since ? `<p class="meta">${area ? `📍 <b dir="auto">${esc(area)}</b>` : ''}${area && since ? ' · ' : ''}${since ? `🕒 ${since}` : ''}</p>` : ''}
${notes ? `<p class="notes" dir="auto">📝 ${esc(notes)}</p>` : ''}
${phone ? `<a class="call" href="tel:${esc(phone)}"><span class="ico">📞</span><span class="num" dir="ltr">${esc(local)}</span></a>
<p class="sub">${triHtml('call')}</p>
<a class="wa no-print" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
<div class="bottom"><section class="ask">${triHtml('ask')}</section>
<div class="qr">${qrSvg(self)}<p>${triHtml('scan')}</p></div></div>
<div class="actions no-print"><button type="button" id="printBtn">🖨 ${esc(tri('print'))}</button><button type="button" id="shareBtn">📤 ${esc(tri('share'))}</button></div>
</main>`
    : `<header class="band ok">✅ ${triHtml('home')}</header>
<main>
${pic}
<h1 dir="auto">${esc(pet)}</h1>
<section class="ask">${triHtml('thanks')}</section>
</main>`;
  const html = posterShell(title, meta, body + `
<footer><a href="${esc(site)}/">FindYpet · findy-pet.com</a></footer>
<script>
(function () {
  var p = document.getElementById('printBtn'), s = document.getElementById('shareBtn');
  if (p) p.addEventListener('click', function () { window.print(); });
  if (s) s.addEventListener('click', function () {
    var d = { title: document.title, url: location.href };
    if (navigator.share) navigator.share(d).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(function () { s.textContent = '✅ ' + location.host + location.pathname; });
  });
})();
</script>`);
  return new Response(html, { headers });
}

export function posterShell(title, meta, body) {
  return `<!doctype html>
<html lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex, nofollow">${meta}
<meta name="theme-color" content="#c81e3a">
<style>
:root { --red: #c81e3a; --red2: #ff5e57; --ink: #10292a; --muted: #56696a; --soft: #f2f8f7; --ok: #15803d; --wa: #0e7c3f; }
* { box-sizing: border-box; margin: 0; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--ink); background: #fff; line-height: 1.4; }
.band { background: linear-gradient(135deg, var(--red2), var(--red)); color: #fff; text-align: center; padding: 14px 16px; font-weight: 800; font-size: clamp(18px, 5vw, 26px); }
.band span + span::before { content: " · "; opacity: .7; }
.band.ok { background: linear-gradient(135deg, #22c55e, var(--ok)); }
main { max-width: 640px; margin: 0 auto; padding: 18px 16px 8px; text-align: center; }
.photo { width: min(78vw, 360px); aspect-ratio: 1; margin: 6px auto 14px; border-radius: 28px; overflow: hidden; background: var(--soft); box-shadow: 0 16px 40px rgba(16,41,42,.18); }
.photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.photo.none { display: grid; place-items: center; font-size: 96px; width: 160px; border-radius: 50%; }
h1 { font-size: clamp(40px, 12vw, 64px); line-height: 1.05; letter-spacing: -.5px; word-break: break-word; }
.meta { margin-top: 8px; font-size: 18px; color: var(--muted); }
.notes { margin: 12px auto 0; max-width: 480px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 14px; padding: 10px 14px; font-size: 16px; }
.call { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 18px auto 4px; max-width: 480px; min-height: 64px; border-radius: 18px;
  background: var(--red); color: #fff; text-decoration: none; font-weight: 800; font-size: clamp(26px, 8vw, 38px); box-shadow: 0 10px 26px rgba(200,30,58,.35); }
.sub { color: var(--muted); font-size: 15px; }
.sub span + span::before { content: " · "; }
.qr p span { display: block; }
.wa { display: inline-block; margin-top: 12px; padding: 12px 26px; min-height: 48px; border-radius: 14px; background: var(--wa); color: #fff; text-decoration: none; font-weight: 700; font-size: 18px; }
.ask { margin: 20px auto 0; max-width: 520px; display: grid; gap: 8px; font-size: 17px; }
.ask span { display: block; background: var(--soft); border-radius: 12px; padding: 10px 14px; }
.qr { margin: 20px auto 0; width: 200px; }
.qr svg { width: 100%; height: auto; display: block; }
.qr p { font-size: 13px; color: var(--muted); margin-top: 4px; }
.actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin: 20px 0 6px; }
.actions button { font: inherit; font-weight: 700; font-size: 15px; min-height: 48px; padding: 10px 18px; border-radius: 14px; border: 1px solid #cfe0df; background: #fff; color: var(--ink); cursor: pointer; }
footer { text-align: center; padding: 14px 16px 22px; font-size: 13px; }
footer a { color: var(--muted); }
.gone { padding-top: 60px; }
@media print {
  @page { size: A4; margin: 10mm; }
  .no-print, footer { display: none !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  main { max-width: none; padding: 5mm 0 0; }
  .band { font-size: 17pt; padding: 3mm; }
  .photo { box-shadow: none; width: 92mm; margin: 0 auto 3mm; }
  .photo.none { width: 30mm; font-size: 48pt; }
  h1 { font-size: 46pt; }
  .meta { font-size: 13pt; margin-top: 1mm; }
  .notes { font-size: 11pt; margin-top: 3mm; padding: 2mm 4mm; }
  .call { box-shadow: none; font-size: 26pt; min-height: 0; padding: 3mm 0; margin-top: 4mm; max-width: 120mm; }
  .sub { font-size: 10pt; }
  .bottom { display: flex; gap: 6mm; align-items: center; justify-content: center; margin-top: 5mm; }
  .ask { font-size: 11pt; gap: 2mm; margin: 0; flex: 1; max-width: 140mm; }
  .ask span { padding: 2mm 4mm; }
  .qr { width: 38mm; flex: 0 0 38mm; margin: 0; }
  .qr p { font-size: 8pt; }
}
</style></head>
<body>
${body}
</body></html>`;
}

// ---------------------------------------------------------------
// QR-код для объявления «Потерялся» — без внешних сервисов (адрес объявления никуда не уходит).
// Байтовый режим, уровень коррекции M, версии 1–10 (до 213 байт). Алгоритм — по ISO/IEC 18004
// (как в генераторе Nayuki). qrSvg(text) → <svg>…</svg>.
// ---------------------------------------------------------------
export const QR_ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // кодовых слов коррекции на блок
export const QR_BLK_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]; // блоков

export function qrRawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const a = Math.floor(v / 7) + 2;
    r -= (25 * a - 10) * a - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}
export function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
export function rsDivisor(deg) {
  const r = new Array(deg).fill(0);
  r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
export function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

export function qrMatrix(text) {
  const data = new TextEncoder().encode(text);
  let ver = 1, cap = 0;
  for (; ver <= 10; ver++) {
    cap = Math.floor(qrRawModules(ver) / 8) - QR_ECC_M[ver] * QR_BLK_M[ver];
    if (4 + (ver < 10 ? 8 : 16) + data.length * 8 <= cap * 8) break;
  }
  if (ver > 10) throw new Error('qr: text too long');
  // 1) биты данных
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(data.length, ver < 10 ? 8 : 16);
  for (const b of data) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap * 8; pad ^= 0xec ^ 0x11) push(pad, 8);
  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataCw.push(b);
  }
  // 2) блоки с кодами Рида — Соломона, перемежение
  const nb = QR_BLK_M[ver], eccLen = QR_ECC_M[ver], rawCw = Math.floor(qrRawModules(ver) / 8);
  const numShort = nb - (rawCw % nb), shortLen = Math.floor(rawCw / nb);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = dataCw.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) cw.push(b[i]); });
  }
  // 3) матрица: служебные узоры
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
      }
    }
  }
  if (ver > 1) {
    const na = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) setF(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  const drawFormat = (mask) => {
    const d = (0 << 3) | mask; // уровень M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
    setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setF(a, c, dark); setF(c, a, dark);
    }
  }
  // 4) данные змейкой
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!fn[y][x] && n < cw.length * 8) { mod[y][x] = ((cw[n >>> 3] >>> (7 - (n & 7))) & 1) === 1; n++; }
      }
    }
  }
  // 5) маска с наименьшим штрафом (правила 1, 2 и 4 стандарта)
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
  };
  const penalty = () => {
    let p = 0, dark = 0;
    for (let a = 0; a < 2; a++) {
      for (let i = 0; i < size; i++) {
        let run = 1;
        for (let j = 1; j <= size; j++) {
          const cur = j < size ? (a ? mod[j][i] : mod[i][j]) : null, prev = a ? mod[j - 1][i] : mod[i][j - 1];
          if (cur === prev) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mod[y][x]) dark++;
        if (x < size - 1 && y < size - 1 && mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
      }
    }
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const pm = penalty();
    if (pm < bestP) { bestP = pm; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return mod;
}

/** QR как SVG (тёмные модули — один path, поле 4 модуля). */
export function qrSvg(text, color = '#111') {
  const m = qrMatrix(text), size = m.length, q = 4;
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = size + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges" role="img" aria-label="QR">` +
    `<rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="${color}"/></svg>`;
}
