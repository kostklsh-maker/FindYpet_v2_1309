import { tg } from './db.js';
import { kvOn, putExtras } from './store.js';
// ---------------------------------------------------------------
// Фото питомца (/photo): берём из Telegram, храним в KV img:<tag_id>, отдаём по /img/<tag_id>?v=…
// Показывается на странице жетона и на объявлении «Потерялся» (/p/<tag_id>).
// ---------------------------------------------------------------
export const PHOTO_MAX = 1_500_000; // байт; Telegram сам сжимает фото до ~100–300 КБ

export async function savePhoto(env, tagId, sizes) {
  if (!kvOn(env)) return '';
  try {
    const ph = [...sizes].sort((a, b) => (a.width * a.height) - (b.width * b.height));
    const pick = ph.filter((p) => Math.max(p.width, p.height) <= 1280 && (!p.file_size || p.file_size <= PHOTO_MAX)).pop() || ph[0];
    const f = await tg(env, 'getFile', { file_id: pick.file_id });
    if (!f || !f.ok || !f.result || !f.result.file_path) return '';
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
    if (!res.ok) return '';
    const buf = await res.arrayBuffer();
    const b = new Uint8Array(buf.slice(0, 3));
    if (buf.byteLength > PHOTO_MAX || buf.byteLength < 200 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return ''; // только JPEG
    const v = Date.now().toString(36);
    await env.FYP_KV.put(`img:${tagId}`, buf, { metadata: { type: 'image/jpeg', v } });
    await putExtras(env, tagId, { photo_v: v });
    return v;
  } catch (e) {
    console.error('photo', e);
    return '';
  }
}

export async function deletePhoto(env, tagId) {
  if (!kvOn(env)) return;
  try { await env.FYP_KV.delete(`img:${tagId}`); } catch (e) { console.error('photo delete', e); }
  await putExtras(env, tagId, { photo_v: '' });
}

export async function servePhoto(env, id, url) {
  const r = kvOn(env) ? await env.FYP_KV.getWithMetadata(`img:${id}`, 'arrayBuffer').catch(() => null) : null;
  if (!r || !r.value) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const versioned = r.metadata && url.searchParams.get('v') === r.metadata.v;
  return new Response(r.value, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
