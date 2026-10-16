import { getOrder, orderTagsLine, saveOrder } from './api.js';
import { mainMenu, send, shortUrl, tg } from './db.js';
import { ownerLang, tr } from './i18n.js';
import { orderLabel } from './pricing.js';
import { kvOn } from './store.js';
import { esc, normalizePhone, prettyPhone, qrText } from './util.js';
export function langKb() {
  return { inline_keyboard: [[
    { text: '🇮🇱 עברית', callback_data: 'lang_he' },
    { text: '🇷🇺 Русский', callback_data: 'lang_ru' },
    { text: '🇬🇧 English', callback_data: 'lang_en' },
  ]] };
}

export function isAdmin(env, chatId) { return !!env.ADMIN_CHAT_ID && String(chatId) === String(env.ADMIN_CHAT_ID); }

export const STATUS_LABEL = { new: '🆕 New', paid: '💰 Paid', made: '🏭 Made', shipped: '📦 Shipped' };

/** Лист производства: по одному блоку на каждый физический жетон + кнопки статуса. */
export async function notifyAdmin(env, url, order) {
  if (!env.ADMIN_CHAT_ID) return;
  const total = order.items.reduce((n, i) => n + i.copies, 0);
  const phonePrint = prettyPhone(normalizePhone(order.phone)).replace('+972 ', '0');
  let k = 0;
  const blocks = [];
  for (const it of order.items) {
    const short = shortUrl(env, url, it.code || it.tag_id);
    // жетон с кодом: в QR — короткий текст заглавными (HTTPS://FINDY-PET.COM/<код>), в NFC — обычная ссылка
    const qrData = it.code ? qrText(env, url, it.code) : short;
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=8&data=${encodeURIComponent(qrData)}`;
    for (let c = 0; c < it.copies; c++) {
      k++;
      blocks.push(c === 0
        ? `🏷 <b>Tag ${k} of ${total} — #${it.tag_id}</b>\n` +
          `🖨 Lid: <b>${esc(String(it.pet_name).toUpperCase())}</b> · ${esc(phonePrint)}\n` +
          `<code>python3 medallion_v2.py lid ${it.code || it.tag_id} "${esc(String(it.pet_name).toUpperCase().replace(/"/g, ''))}" ${esc(phonePrint)}</code>\n` +
          (it.code ? `✍️ NFC: <code>${esc(short)}</code>\n🔳 QR: <code>${esc(qrData)}</code>\n` : `✍️ NFC + 🔳 QR: <code>${esc(short)}</code>\n`) +
          `<a href="${esc(qr)}">Download QR image</a>`
        : `🏷 <b>Tag ${k} of ${total} — #${it.tag_id} (spare)</b>\n` +
          `Exact copy of the ${esc(it.pet_name)} tag above: same lid, same NFC link.`);
    }
  }
  const missing = (order.missing || []).length
    ? `\n\n⚠️ <b>Could not create tags for:</b> ${esc(order.missing.join(', '))} — the table did not answer. Create them manually.`
    : '';
  await tg(env, 'sendMessage', {
    chat_id: env.ADMIN_CHAT_ID,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      `🆕 <b>New order ${order.order_id}</b> (via ${order.source})\n` +
      `💳 ${esc(orderLabel(order))} — <b>${total} physical tag${total > 1 ? 's' : ''}</b>\n` +
      `👤 ${esc(order.owner_name)} · 📱 ${esc(prettyPhone(normalizePhone(order.phone)))}\n` +
      `🏠 ${esc(order.address)}\n` +
      `Telegram: ${order.chat_id ? '✅ linked' : '⏳ not yet (updates will go to Telegram once linked)'}\n` +
      (order.care_interest ? '💚 Wants to hear when FindYpet Care launches\n' : '') +
      (order.old_offer ? '⚠️ Ordered from a page opened before 3 + 1 (it showed 3 tags for 98 ₪) — agree the price with the customer.\n' : '') + '\n' +
      blocks.join('\n\n') + missing +
      `\n\nSet the status when it changes — the customer gets a message:`,
    reply_markup: { inline_keyboard: [[
      { text: STATUS_LABEL.paid, callback_data: `ord:${order.order_id}:paid` },
      { text: STATUS_LABEL.made, callback_data: `ord:${order.order_id}:made` },
      { text: STATUS_LABEL.shipped, callback_data: `ord:${order.order_id}:shipped` },
    ]] },
  });
}

export async function setOrderStatus(env, url, adminChat, orderId, status) {
  const order = await getOrder(env, orderId);
  if (!order) return send(env, adminChat, `⚠️ Order ${orderId} not found.`);
  if (order.status === status) return send(env, adminChat, `Order ${orderId} is already ${STATUS_LABEL[status]}.`);
  order.status = status;
  order.history = [...(order.history || []), { status, at: new Date().toISOString() }];
  await saveOrder(env, order);

  const names = order.items.map((i) => esc(i.pet_name)).join(', ');
  const total = order.items.reduce((n, i) => n + i.copies, 0);
  const links = order.items.map((i) => `🐾 ${esc(i.pet_name)}: ${esc(shortUrl(env, url, i.code || i.tag_id))}`).join('\n');
  const L = await ownerLang(env, order.chat_id, order);
  const key = { paid: 'stPaid', made: 'stMade', shipped: 'stShipped' }[status];
  const text = tr(L, key, { id: order.order_id, n: total, names, address: esc(order.address), links });

  let delivered = false;
  if (order.chat_id) {
    const r = await send(env, order.chat_id, text, mainMenu(L));
    delivered = !!(r && r.ok);
  }
  return send(env, adminChat,
    `✅ Order ${orderId} → ${STATUS_LABEL[status]}\n` +
    (delivered ? 'Customer notified in Telegram.'
      : `Customer has no Telegram linked — please call: ${esc(prettyPhone(normalizePhone(order.phone)))}`));
}

export async function listOrders(env, chatId) {
  if (!kvOn(env)) return send(env, chatId, tr('en', 'noKv'));
  const open = [];
  let cursor;
  do {
    const page = await env.FYP_KV.list({ prefix: 'o:', cursor });
    for (const k of page.keys) {
      const o = await env.FYP_KV.get(k.name, 'json');
      if (o && o.status !== 'shipped') open.push(o);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (!open.length) return send(env, chatId, 'No open orders 🎉');
  open.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return send(env, chatId, '<b>Open orders</b>\n\n' + open.map((o) =>
    `${STATUS_LABEL[o.status] || o.status} · <b>${o.order_id}</b> · ${esc(orderLabel(o))}\n` +
    `${esc(orderTagsLine(o))}\n📱 ${esc(prettyPhone(normalizePhone(o.phone)))} · ${esc(String(o.created_at).slice(0, 10))}`).join('\n\n'),
    { inline_keyboard: open.slice(0, 20).flatMap((o) => [[
      { text: `${o.order_id} → ${STATUS_LABEL.paid}`, callback_data: `ord:${o.order_id}:paid` },
      { text: STATUS_LABEL.made, callback_data: `ord:${o.order_id}:made` },
      { text: STATUS_LABEL.shipped, callback_data: `ord:${o.order_id}:shipped` },
    ]]) });
}
