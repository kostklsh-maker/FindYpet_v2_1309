import http from 'node:http';
import { state, KV, makeEnv, worker } from './mock.mjs';
const env = makeEnv();
state.tags.push({ tag_id: '101', owner_name: 'Kostya K', phone: '0501234567', pet_name: 'Bella', address: 'x', telegram_chat_id: '1', status: 'active', link_token: 'a' });
state.tags.push({ tag_id: '102', owner_name: 'Anna', phone: '0541112222', pet_name: 'Rex', address: 'x', telegram_chat_id: '2', status: 'active', link_token: 'b' });
state.tags.push({ tag_id: '103', owner_name: 'Dana', phone: '0529998877', pet_name: 'Mika', address: 'x', telegram_chat_id: '', status: 'active', link_token: 'c' });
await KV.put('x:101', JSON.stringify({ phone2: '+972527654321', notes: 'Allergic to chicken. Scared of people — please don\'t chase, just call.' }));
await KV.put('x:102', JSON.stringify({ lost: true, lost_since: new Date(Date.now() - 3 * 3600e3).toISOString(), lost_area: 'Haifa, Carmel Center' }));
await KV.put('c:103', JSON.stringify({ found: true, tag_id: '103', pet_name: 'Mika', owner_name: 'Dana', phone: '+972529998877', phone_display: '+972 52-999-8877', can_notify: false }));
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = 'http://localhost:8787' + req.url;
  state.gasDown = /[?&]id=103/.test(req.url) && req.url.startsWith('/api/tag');
  const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log('ready'));
