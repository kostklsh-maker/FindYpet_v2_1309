import { isAdmin, langKb, listOrders, setOrderStatus } from './admin.js';
import { adSpend, alertAdmin, bumpEvent, createOrder, funnelStats, getOrder, orderItems, queuedStart, saveOrder, weeklyText } from './api.js';
import { cancelKb, db, mainMenu, posterUrl, send, shortUrl, siteBase, tg } from './db.js';
import { LRM, chatLang, isBtn, keepChatLang, ltr, setChatLang, tr } from './i18n.js';
import { deletePhoto, savePhoto } from './photo.js';
import { PRICING, ils, normQty, orderLabel, orderPrice, qtyLabel } from './pricing.js';
import { cachePublic, getExtras, kvOn, putExtras, rememberChat } from './store.js';
import { adminTagCode, cell, esc, fmtTime, json, normalizePhone, prettyPhone, str, tagKey } from './util.js';
// ---------------------------------------------------------------
// Telegram bot. Язык ответов — L (см. chatLang): /lang → язык заказа на сайте → язык Telegram → английский.
// ---------------------------------------------------------------
export async function handleUpdate(update, env, url) {
  if (update.callback_query) return handleCallback(update.callback_query, env, url);
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  await rememberChat(env, chatId); // для напоминаний (в т.ч. тех, кто зарегистрирован до обновления)
  const L = await chatLang(env, chatId, msg.from);

  // --- команды ---
  if (text.startsWith('/start')) {
    const token = text.split(/\s+/)[1];
    if (token === 'care') return careInfo(chatId, env, L);
    if (token && token.startsWith('q_')) return queuedStart(chatId, token.slice(2), env, url, msg.from, L);
    if (token) return linkFromSite(chatId, token, env, url, msg.from);
    await db(env, 'clearState', { chat_id: chatId });
    return send(env, chatId, tr(L, 'welcome'), mainMenu(L));
  }
  if (text === '/register' || isBtn(text, 'btnRegister')) return startRegistration(chatId, msg, env, L);
  if (text === '/mytags' || isBtn(text, 'btnMyTags')) return myTags(chatId, env, url, L);
  if (text === '/lost' || isBtn(text, 'btnLost')) return pickTag(chatId, env, 'lost', 'pickLost', L);
  if (text === '/found') return pickTag(chatId, env, 'found', 'pickFound', L, (t) => t._lost);
  if (text === '/settings' || isBtn(text, 'btnSettings')) return pickTag(chatId, env, 'set', 'pickSet', L);
  if (text === '/photo') return pickTag(chatId, env, 'pho', 'pickPhoto', L);
  if (text === '/delete') return pickTag(chatId, env, 'del', 'pickDelete', L);
  if (text === '/nostory') return removeStories(env, chatId, L);
  if (text === '/cancel' || isBtn(text, 'btnCancel')) {
    await db(env, 'clearState', { chat_id: chatId });
    return send(env, chatId, tr(L, 'cancelled'), mainMenu(L));
  }
  if (text === '/lang') return send(env, chatId, tr(L, 'langAsk'), langKb());
  if (text === '/id') return send(env, chatId, tr(L, 'chatId', { id: chatId }));
  if (text === '/care') return careInfo(chatId, env, L);
  // сообщения админу — по-английски
  if (text === '/orders' && isAdmin(env, chatId)) return listOrders(env, chatId);
  if (text === '/stats' && isAdmin(env, chatId)) return send(env, chatId, await funnelStats(env));
  if (/^\/spend(\s|$)/.test(text) && isAdmin(env, chatId)) return send(env, chatId, await adSpend(env, text));
  if (/^\/code(\s|$)/.test(text) && isAdmin(env, chatId)) return send(env, chatId, await adminTagCode(env, url, text));
  if (text === '/week' && isAdmin(env, chatId)) return send(env, chatId, kvOn(env) ? await weeklyText(env, Date.now()) : 'No storage connected.');
  if ((text === '/plate' || text === '/plate all') && isAdmin(env, chatId)) return plateCsv(env, chatId, text === '/plate all');
  if (text === '/help') return send(env, chatId, tr(L, 'help'), mainMenu(L));

  // --- многошаговые диалоги ---
  const st = (await db(env, 'getState', { chat_id: chatId })).state;
  if (!st || !st.step) return send(env, chatId, tr(L, 'help'), mainMenu(L));

  // фото питомца: одно фото (как картинка, не файлом)
  if (st.step === 'photo') {
    if (!Array.isArray(msg.photo) || !msg.photo.length) return send(env, chatId, tr(L, 'photoBad'), cancelKb(L));
    const tag = await ownedTag(chatId, st.tag_id, env);
    if (!tag) return send(env, chatId, tr(L, 'notLinked'), mainMenu(L));
    const v = await savePhoto(env, st.tag_id, msg.photo);
    if (!v) return send(env, chatId, tr(L, 'photoBad'), cancelKb(L));
    await db(env, 'clearState', { chat_id: chatId });
    await send(env, chatId, tr(L, 'photoSaved', { pet: esc(tag.pet_name) }), {
      inline_keyboard: [[{ text: tr(L, 'btnPreview'), url: shortUrl(env, url, await tagKey(env, st.tag_id)) }]],
    });
    return send(env, chatId, tr(L, 'useMyTags'), mainMenu(L));
  }
  // режим «Потерялся»: где видели в последний раз
  if (st.step === 'lost_area') {
    const area = isBtn(text, 'btnSkip') ? '' : cleanArea(text);
    await db(env, 'clearState', { chat_id: chatId });
    return turnLostOn(chatId, st.tag_id, area, env, url, L);
  }
  // настройки: второй телефон / заметки
  if (st.step === 'set_phone2') {
    const p2 = normalizePhone(msg.contact ? msg.contact.phone_number : text);
    if (!p2) return send(env, chatId, tr(L, 'badPhone'));
    await db(env, 'clearState', { chat_id: chatId });
    await putExtras(env, st.tag_id, { phone2: p2 });
    return send(env, chatId, tr(L, 'phone2Saved', { phone: ltr(L, esc(prettyPhone(p2))) }), mainMenu(L));
  }
  if (st.step === 'story') {
    if (!text) return send(env, chatId, tr(L, 'askStory', { pet: '' }), cancelKb(L));
    await db(env, 'clearState', { chat_id: chatId });
    return saveStory(env, chatId, st.tag_id, text, L);
  }
  if (st.step === 'set_notes') {
    if (!text) return send(env, chatId, tr(L, 'askNotes'));
    await db(env, 'clearState', { chat_id: chatId });
    const notes = str(text, 200);
    await putExtras(env, st.tag_id, { notes });
    return send(env, chatId, tr(L, 'notesSaved', { notes: esc(notes) }), mainMenu(L));
  }

  // регистрация
  if (st.step === 'name') {
    if (!text) return send(env, chatId, tr(L, 'askName'));
    st.owner_name = cell(text, 80);
    st.step = 'phone';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, tr(L, 'askPhone'), {
      keyboard: [[{ text: tr(L, 'btnSharePhone'), request_contact: true }], [{ text: tr(L, 'btnCancel') }]],
      resize_keyboard: true, one_time_keyboard: true,
    });
  }
  if (st.step === 'phone') {
    const phone = normalizePhone(msg.contact ? msg.contact.phone_number : text);
    if (!phone) return send(env, chatId, tr(L, 'badPhone'));
    st.phone = phone;
    st.step = 'pet';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, tr(L, 'askPet'), cancelKb(L));
  }
  if (st.step === 'pet') {
    if (!text) return send(env, chatId, tr(L, 'askPet'));
    st.pet_name = cell(text, 40);
    st.step = 'address';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, tr(L, 'askAddress'), cancelKb(L));
  }
  if (st.step === 'address') {
    if (!text) return send(env, chatId, tr(L, 'askAddress'));
    st.address = cell(text, 200);
    st.step = 'qty';
    await db(env, 'setState', { chat_id: chatId, state: st });
    await send(env, chatId, '👌', { remove_keyboard: true });
    return askQty(env, chatId, L);
  }
  if (st.step === 'qty' || st.step === 'plan' || st.step === 'f_count' || st.step === 'f_spare') {
    return send(env, chatId, tr(L, 'useButtons'));
  }
  if (st.step === 'f_pet') {
    if (!text) return send(env, chatId, tr(L, 'petN', { n: st.pets.length + 1 }), cancelKb(L));
    st.slots = normQty(st.slots || 1); // диалог мог начаться до 3 + 1 (slots: 3)
    st.pets.push(cell(text, 40));
    if (st.pets.length < st.fam_n) {
      await db(env, 'setState', { chat_id: chatId, state: st });
      return send(env, chatId, tr(L, 'petN', { n: st.pets.length + 1 }), cancelKb(L));
    }
    await send(env, chatId, '👌', { remove_keyboard: true });
    return afterFamilyPets(env, chatId, st, url, L);
  }
  if (st.step === 'confirm') return send(env, chatId, tr(L, 'tapConfirm'));
  return send(env, chatId, tr(L, 'help'), mainMenu(L));
}

export function askQty(env, chatId, L) {
  const b = orderPrice(PRICING.bundle);
  return send(env, chatId,
    tr(L, 'askQty', { one: ils(orderPrice(1).total), two: ils(orderPrice(2).total), paid: b.paid, free: b.free, total: ils(b.total), tags: b.tags }),
    { inline_keyboard: [1, 2, PRICING.bundle].map((n) => [{ text: qtyLabel(n, L), callback_data: `qty_${n}` }]) });
}

export function confirmMessage(env, chatId, st, url, L) {
  return send(env, chatId,
    tr(L, 'confirm', {
      owner: esc(st.owner_name), phone: ltr(L, esc(prettyPhone(st.phone))), items: itemsText(st, L), address: esc(st.address),
      label: esc(qtyLabel(st.slots || 1, L)), privacy: `${esc(siteBase(env, url))}/privacy/?lang=${L}`,
    }),
    { inline_keyboard: [[{ text: tr(L, 'btnConfirm'), callback_data: 'reg_ok' }, { text: tr(L, 'btnAgain'), callback_data: 'reg_again' }]] });
}

export async function handleCallback(cq, env, url) {
  const chatId = String(cq.message.chat.id);
  const data = String(cq.data || '');
  if (cq.id !== '0') await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id }); // '0' — вызов из pickTag
  const L = cq._lang || (await chatLang(env, chatId, cq.from));

  // --- язык бота ---
  const lm = /^lang_(en|he|ru)$/.exec(data);
  if (lm) {
    if (!kvOn(env)) return send(env, chatId, tr(L, 'noKv'));
    await setChatLang(env, chatId, lm[1]);
    if (cq.message.message_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    return send(env, chatId, tr(lm[1], 'langSet'), mainMenu(lm[1]));
  }

  // --- действия с конкретной меткой: lost:ID, found:ID, set:ID, pho:ID, set2:ID:field, clr:ID:field ---
  if (data === 'delno') return send(env, chatId, tr(L, 'delCancelled'), mainMenu(L));
  if (data === 'storyno') {
    if (cq.message.message_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    return send(env, chatId, tr(L, 'storyNo'), mainMenu(L));
  }
  const m = /^(lost|found|set|set2|clr|pho|del|delok|story):(\d{1,9})(?::(phone2|notes|photo))?$/.exec(data);
  if (m) {
    const [, act, id, field] = m;
    const tag = await ownedTag(chatId, id, env);
    if (!tag) return send(env, chatId, tr(L, 'notLinked'), mainMenu(L));
    if (!kvOn(env)) return send(env, chatId, tr(L, 'noKv'), mainMenu(L));
    if (act === 'lost') {
      await db(env, 'setState', { chat_id: chatId, state: { step: 'lost_area', tag_id: id } });
      return send(env, chatId, tr(L, 'lostTitle', { pet: esc(tag.pet_name) }) + tr(L, 'askArea'), {
        keyboard: [[{ text: tr(L, 'btnSkip') }], [{ text: tr(L, 'btnCancel') }]], resize_keyboard: true, one_time_keyboard: true,
      });
    }
    if (act === 'found') return turnLostOff(chatId, tag, env, L);
    if (act === 'story') {
      if (cq.message.message_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      await db(env, 'setState', { chat_id: chatId, state: { step: 'story', tag_id: id } });
      return send(env, chatId, tr(L, 'askStory', { pet: esc(tag.pet_name) }), cancelKb(L));
    }
    if (act === 'del') {
      return send(env, chatId, tr(L, 'delAsk', { pet: esc(tag.pet_name) }), { inline_keyboard: [[
        { text: tr(L, 'btnDelYes'), callback_data: `delok:${id}` }, { text: tr(L, 'btnDelNo'), callback_data: 'delno' },
      ]] });
    }
    if (act === 'delok') {
      if (cq.message.message_id) await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
      return deleteTagData(env, chatId, tag, L);
    }
    if (act === 'set') return settingsMenu(chatId, tag, env, L);
    if (act === 'pho') {
      await db(env, 'setState', { chat_id: chatId, state: { step: 'photo', tag_id: id } });
      return send(env, chatId, tr(L, 'askPhoto', { pet: esc(tag.pet_name) }), cancelKb(L));
    }
    if (act === 'set2') {
      if (field === 'photo') return;
      await db(env, 'setState', { chat_id: chatId, state: { step: field === 'phone2' ? 'set_phone2' : 'set_notes', tag_id: id } });
      return send(env, chatId, tr(L, field === 'phone2' ? 'askPhone2' : 'askNotes'), cancelKb(L));
    }
    if (act === 'clr') {
      if (field === 'photo') {
        await deletePhoto(env, id);
        return send(env, chatId, tr(L, 'photoRemoved'), mainMenu(L));
      }
      await putExtras(env, id, { [field]: '' });
      return send(env, chatId, tr(L, field === 'phone2' ? 'phone2Removed' : 'notesRemoved'), mainMenu(L));
    }
  }

  // --- регистрация: 1, 2 или 4 (3 + 1) жетона (qty_3 и plan_* — кнопки из старых сообщений) ---
  const qm = /^(?:qty_(\d)|plan_(\w+))$/.exec(data);
  if (qm) {
    const st = (await db(env, 'getState', { chat_id: chatId })).state;
    if (!st || (st.step !== 'qty' && st.step !== 'plan')) return send(env, chatId, tr(L, 'expired'), mainMenu(L));
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    st.slots = normQty(qm[1] ? Number(qm[1]) : (qm[2] === 'family' ? PRICING.bundle : 1));
    st.pets = [st.pet_name];
    st.spare_for = [];
    if (st.slots > 1) {
      st.step = 'f_count';
      await db(env, 'setState', { chat_id: chatId, state: st });
      const n = st.slots, pr = orderPrice(n);
      return send(env, chatId, tr(L, 'howManyPets', { n, free: pr.free, paid: pr.paid }),
        { inline_keyboard: Array.from({ length: n }, (_, k) => k + 1).map((c) =>
          [{ text: tr(L, 'petsBtn', { c, n, pet: st.pet_name }), callback_data: `fam_n_${c}` }]) });
    }
    st.step = 'confirm';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return confirmMessage(env, chatId, st, url, L);
  }

  // --- «Забота»: записаться в лист ожидания ---
  if (data === 'care_yes') return careJoin(chatId, env, cq.from, L);

  // --- 2 или 4 жетона: сколько питомцев / для кого каждый запасной ---
  // fam_sp_<k>_<i>: ответ на k-й вопрос о запасном (fam_sp_<i> — кнопки из старых сообщений)
  const fm = /^fam_(n|sp)_(\d)(?:_(\d))?$/.exec(data);
  if (fm) {
    const st = (await db(env, 'getState', { chat_id: chatId })).state;
    const want = fm[1] === 'n' ? 'f_count' : 'f_spare';
    if (st && fm[1] === 'sp' && (st.step === 'confirm' || (st.step === want && fm[3] !== undefined && Number(fm[2]) !== (st.spare_for || []).length))) {
      return; // на этот вопрос уже ответили (двойное нажатие или старое сообщение)
    }
    if (!st || st.step !== want) return send(env, chatId, tr(L, 'expired'), mainMenu(L));
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    st.slots = normQty(st.slots || 1); // диалог мог начаться до 3 + 1 (slots: 3)
    const v = Number(fm[3] !== undefined ? fm[3] : fm[2]);
    if (fm[1] === 'n') {
      st.fam_n = Math.min(Math.max(v, 1), st.slots || 1);
      if (st.fam_n > 1) {
        st.step = 'f_pet';
        await db(env, 'setState', { chat_id: chatId, state: st });
        return send(env, chatId, tr(L, 'petN', { n: st.pets.length + 1 }), cancelKb(L));
      }
      return afterFamilyPets(env, chatId, st, url, L);
    }
    st.spare_for = [...(st.spare_for || []), v < st.pets.length ? v : 0];
    return askSpareOrConfirm(env, chatId, st, url, L);
  }

  // --- админ: пост о пропаже в канал ---
  const cm = /^chan:(\d{1,9}):(ok|no)$/.exec(data);
  if (cm) {
    if (!isAdmin(env, chatId) || !env.LOST_CHANNEL_ID) return;
    return channelDecision(env, url, chatId, cq, cm[1], cm[2] === 'ok');
  }

  // --- админ: статус заказа ---
  const om = /^ord:(FY\d{1,9}):(paid|made|shipped)$/.exec(data);
  if (om) {
    if (!isAdmin(env, chatId)) return;
    return setOrderStatus(env, url, chatId, om[1], om[2]);
  }

  // --- регистрация ---
  // Двойное нажатие «Confirm» не должно создать два заказа: замок на минуту — самым первым действием
  const lockKey = `lock:reg:${chatId}`;
  if (data === 'reg_ok' && kvOn(env)) {
    if (await env.FYP_KV.get(lockKey)) return;
    await env.FYP_KV.put(lockKey, '1', { expirationTtl: 60 });
  }
  if (data === 'reg_again' || data === 'reg_ok') {
    // убираем кнопки у сообщения с подтверждением
    await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (data === 'reg_again') return startRegistration(chatId, cq, env, L);
  if (data !== 'reg_ok') return;

  const st = (await db(env, 'getState', { chat_id: chatId })).state;
  if (st && st.step === 'creating') return; // заказ уже создаётся
  if (!st || st.step !== 'confirm') return send(env, chatId, tr(L, 'expired'), mainMenu(L));
  if ((st.slots || 1) === normQty(st.slots || 1)) await db(env, 'setState', { chat_id: chatId, state: { ...st, step: 'creating' } });
  // Подтверждение, показанное до 07.10 (2 + 1: «3 tags — 98 ₪»): сначала новые условия, потом снова «Confirm»
  if ((st.slots || 1) !== normQty(st.slots || 1)) {
    st.slots = normQty(st.slots);
    const b = orderPrice(st.slots);
    await send(env, chatId, tr(L, 'offerChanged', { paid: b.paid, free: b.free, tags: b.tags, total: ils(b.total) }));
    if (kvOn(env)) await env.FYP_KV.delete(lockKey);
    return askSpareOrConfirm(env, chatId, st, url, L);
  }

  const qty = st.slots || 1;
  const res = await createOrder(env, url, {
    source: 'telegram', qty, lang: L, owner_name: st.owner_name, phone: st.phone, address: st.address,
    items: orderItems(qty, st.pet_name, (st.pets || []).slice(1), st.spare_for), chat_id: chatId,
  });
  if (!res.ok) {
    if (kvOn(env)) await env.FYP_KV.delete(lockKey);
    return send(env, chatId, tr(L, 'wentWrong'));
  }
  await db(env, 'clearState', { chat_id: chatId });
  await Promise.all(res.tags.map((t) => cachePublic(env, t)));
  await rememberChat(env, chatId);
  await keepChatLang(env, chatId, L);
  await sendRegistered(chatId, res.tags, env, url, res.order, L);
}

/** После ввода кличек: для кого каждый запасной жетон (если питомцев несколько), затем подтверждение. */
export async function afterFamilyPets(env, chatId, st, url, L) {
  st.spare_for = [];
  return askSpareOrConfirm(env, chatId, st, url, L);
}
export async function askSpareOrConfirm(env, chatId, st, url, L) {
  const spares = (st.slots || 1) - st.pets.length;
  const done = (st.spare_for || []).length;
  // один питомец — все запасные его, спрашивать не о чем
  if (spares > 0 && st.pets.length > 1 && done < spares) {
    st.step = 'f_spare';
    await db(env, 'setState', { chat_id: chatId, state: st });
    return send(env, chatId, tr(L, 'spareQ', { spares, k: done + 1 }),
      { inline_keyboard: st.pets.map((n, i) => [{ text: `🐾 ${n}`, callback_data: `fam_sp_${done}_${i}` }]) });
  }
  st.step = 'confirm';
  await db(env, 'setState', { chat_id: chatId, state: st });
  return confirmMessage(env, chatId, st, url, L);
}

export function itemsText(st, L) {
  const items = orderItems(st.slots || 1, st.pet_name, (st.pets || []).slice(1), st.spare_for);
  if (items.length === 1 && items[0].copies === 1) return tr(L, 'itemPet', { pet: esc(items[0].pet_name) });
  return tr(L, 'itemsHead') + items.map((i) => `   • ${esc(i.pet_name)}` + (i.copies > 1 ? tr(L, 'itemCopies', { c: i.copies }) : '')).join('\n') + '\n';
}

/** Выбор метки для действия (q — ключ текста вопроса). Если метка одна — действие сразу. */
export async function pickTag(chatId, env, action, q, L, filter) {
  if (!kvOn(env)) return send(env, chatId, tr(L, 'noKv'), mainMenu(L));
  const r = await db(env, 'listByChat', { chat_id: chatId });
  if (!r.ok) return send(env, chatId, tr(L, 'cantLoad'));
  let tags = r.tags || [];
  if (!tags.length) return send(env, chatId, tr(L, 'noTags'), mainMenu(L));
  if (filter) {
    const withX = await Promise.all(tags.map(async (t) => ({ ...t, _lost: !!(await getExtras(env, t.tag_id)).lost })));
    tags = withX.filter(filter);
    if (!tags.length) return send(env, chatId, tr(L, 'noneLost'), mainMenu(L));
  }
  if (tags.length === 1) {
    return handleCallback({ id: '0', _lang: L, data: `${action}:${tags[0].tag_id}`, message: { chat: { id: chatId } } }, env, null);
  }
  return send(env, chatId, tr(L, q), {
    inline_keyboard: tags.map((t) => [{ text: `🐾 ${t.pet_name} · #${t.tag_id}`, callback_data: `${action}:${t.tag_id}` }]),
  });
}

export async function ownedTag(chatId, id, env) {
  const r = await db(env, 'listByChat', { chat_id: chatId });
  const tags = (r.ok && r.tags) || [];
  return tags.find((t) => String(t.tag_id) === String(id)) || null;
}

export async function turnLostOn(chatId, id, area, env, url, L) {
  const tag = await ownedTag(chatId, id, env);
  if (!tag) return send(env, chatId, tr(L, 'notLinked'), mainMenu(L));
  const since = new Date().toISOString();
  const x = await putExtras(env, id, { lost: true, lost_since: since, lost_area: area });
  if (!x) return send(env, chatId, tr(L, 'noKv'), mainMenu(L));
  const poster = posterUrl(env, url, x.code || id);
  // Текст для групп — на трёх языках (сначала язык владельца). Ссылка — на объявление /p/:
  // открытие объявления не считается сканом жетона и не будит владельца уведомлением.
  const order = [L, ...['he', 'ru', 'en'].filter((l) => l !== L)];
  const flag = { he: '🇮🇱', ru: '🇷🇺', en: '🇬🇧' };
  const shares = order.map((l) => `${flag[l]} <code>${esc(tr(l, 'share', { pet: tag.pet_name, area, link: poster }))}</code>`).join('\n\n');

  // Канал сообщества (если настроен): только оплаченные заказы (и старые жетоны без заказа) и только
  // после «Опубликовать» у админа — чтобы канал не стал доской для спама
  if (env.LOST_CHANNEL_ID && env.ADMIN_CHAT_ID && (await channelAllowed(env, x))) {
    await tg(env, 'sendMessage', {
      chat_id: env.ADMIN_CHAT_ID, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `📣 <b>Lost mode on</b> — publish to ${esc(env.LOST_CHANNEL_ID)}?\n\n` + channelPost(env, tag, area, poster),
      reply_markup: { inline_keyboard: [[{ text: '✅ Publish', callback_data: `chan:${id}:ok` }, { text: '✖️ Skip', callback_data: `chan:${id}:no` }]] },
    });
  }

  await send(env, chatId, tr(L, 'lostOn', { pet: esc(tag.pet_name), area: esc(area), shares, photo: !!x.photo_v }), mainMenu(L));
}

export function channelPost(env, tag, area, poster) {
  return `🚨 <b>${esc(tag.pet_name)}</b>\n` +
    ['he', 'ru', 'en'].map((l) => `${{ he: '🇮🇱', ru: '🇷🇺', en: '🇬🇧' }[l]} ${tr(l, 'chanLine')}`).join('\n') + '\n\n' +
    (area ? `📍 ${esc(area)}\n` : '') +
    `🕒 ${fmtTime(env, 'en')}\n` +
    esc(poster);
}
export async function channelAllowed(env, x) {
  if (!x.order_id) return true; // жетоны до системы заказов — настоящие клиенты
  const o = await getOrder(env, x.order_id);
  return !o || ['paid', 'made', 'shipped'].includes(o.status);
}
/** Админ: «Опубликовать» / «Пропустить» пост о пропаже в канал. */
export async function channelDecision(env, url, adminChat, cq, id, ok) {
  if (cq.message && cq.message.message_id) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: adminChat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
  if (!ok) return send(env, adminChat, `Skipped — #${id} is not posted to the channel.`);
  const x = await getExtras(env, id);
  if (!x.lost) return send(env, adminChat, `#${id} is no longer in Lost mode — nothing to post.`);
  if (x.channel_msg_id) return send(env, adminChat, `#${id} is already in the channel.`);
  const r = await db(env, 'getTag', { id });
  if (!r.ok || !r.found) return send(env, adminChat, `⚠️ Could not load #${id}.`);
  const post = await tg(env, 'sendMessage', {
    chat_id: env.LOST_CHANNEL_ID, parse_mode: 'HTML', disable_web_page_preview: false,
    text: channelPost(env, r.tag, x.lost_area || '', posterUrl(env, url, x.code || id)),
  });
  if (post && post.ok) await putExtras(env, id, { channel_msg_id: post.result.message_id });
  return send(env, adminChat, post && post.ok ? `✅ #${id} posted to the channel.` : '⚠️ The channel did not accept the post (is the bot an admin there?).');
}

/** Район пропажи: без ссылок и @упоминаний (его видят на странице, в объявлении и в канале). */
export function cleanArea(text) {
  return str(text, 160).replace(/\b(?:https?:\/\/|www\.)\S+|\bt\.me\/\S+|@\w{3,}/gi, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 80);
}

export async function turnLostOff(chatId, tag, env, L) {
  const x = await getExtras(env, tag.tag_id);
  await putExtras(env, tag.tag_id, { lost: false, lost_since: '', lost_area: '', channel_msg_id: '' });
  if (env.LOST_CHANNEL_ID && x.channel_msg_id) {
    await tg(env, 'editMessageText', {
      chat_id: env.LOST_CHANNEL_ID,
      message_id: x.channel_msg_id,
      parse_mode: 'HTML',
      text: '✅ ' + ['he', 'ru', 'en'].map((l) => tr(l, 'chanHome', { pet: esc(tag.pet_name) })).join('\n'),
    });
  }
  const done = await send(env, chatId, tr(L, 'lostOff', { pet: esc(tag.pet_name) }), mainMenu(L));
  if (!x.lost) return done; // /found без режима поиска — не возвращение домой
  await bumpEvent(env, 'home');
  // D5: история «нашлась» — только с согласия владельца
  return send(env, chatId, tr(L, 'storyAsk', { pet: esc(tag.pet_name) }), { inline_keyboard: [[
    { text: tr(L, 'btnStory'), callback_data: `story:${tag.tag_id}` }, { text: tr(L, 'btnNoStory'), callback_data: 'storyno' },
  ]] });
}

/** /nostory: владелец отзывает согласие — удаляем истории всех его жетонов, админ узнаёт об этом. */
export async function removeStories(env, chatId, L) {
  const r = await db(env, 'listByChat', { chat_id: chatId });
  const ids = (r.tags || []).map((t) => String(t.tag_id));
  if (kvOn(env)) await Promise.all(ids.map((id) => env.FYP_KV.delete(`story:${id}`).catch(() => {})));
  if (env.ADMIN_CHAT_ID) await send(env, env.ADMIN_CHAT_ID, `🗑 The owner withdrew consent: stories for ${ids.map((i) => '#' + i).join(', ') || '—'} deleted. Remove them from the site and social pages too.`);
  return send(env, chatId, tr(L, 'storyRemoved'), mainMenu(L));
}

/** История «нашлась»: текст с согласием на публикацию; админ решает, публиковать ли. Удаляется вместе с жетоном (/delete). */
export async function saveStory(env, chatId, tagId, text, L) {
  const tag = await ownedTag(chatId, tagId, env);
  if (!tag) return send(env, chatId, tr(L, 'notLinked'), mainMenu(L));
  const story = str(text, 1000);
  await env.FYP_KV.put(`story:${tagId}`, JSON.stringify({ tag_id: String(tagId), pet: tag.pet_name, lang: L, text: story, consent: true, at: new Date().toISOString() }));
  await bumpEvent(env, 'story');
  if (env.ADMIN_CHAT_ID) {
    await send(env, env.ADMIN_CHAT_ID, `💬 <b>Story: ${esc(tag.pet_name)} is home</b> (#${tagId}, ${L})\nThe owner agreed to publish it on the site and social pages.\n\n<i>${esc(story)}</i>`);
  }
  return send(env, chatId, tr(L, 'storySaved'), mainMenu(L));
}

export async function settingsMenu(chatId, tag, env, L) {
  const x = await getExtras(env, tag.tag_id);
  const p2 = normalizePhone(x.phone2);
  const kb = [
    [{ text: tr(L, p2 ? 'btnChangeP2' : 'btnAddP2'), callback_data: `set2:${tag.tag_id}:phone2` }],
    [{ text: tr(L, x.notes ? 'btnChangeNotes' : 'btnAddNotes'), callback_data: `set2:${tag.tag_id}:notes` }],
    [{ text: tr(L, 'btnPhoto'), callback_data: `pho:${tag.tag_id}` }],
  ];
  if (p2) kb.push([{ text: tr(L, 'btnRmP2'), callback_data: `clr:${tag.tag_id}:phone2` }]);
  if (x.notes) kb.push([{ text: tr(L, 'btnRmNotes'), callback_data: `clr:${tag.tag_id}:notes` }]);
  if (x.photo_v) kb.push([{ text: tr(L, 'btnRmPhoto'), callback_data: `clr:${tag.tag_id}:photo` }]);
  return send(env, chatId, tr(L, 'settings', {
    pet: esc(tag.pet_name), id: tag.tag_id, phone: ltr(L, esc(prettyPhone(normalizePhone(tag.phone)))),
    p2: p2 ? ltr(L, esc(prettyPhone(p2))) : '', notes: x.notes ? esc(x.notes) : '', photo: !!x.photo_v,
  }), { inline_keyboard: kb });
}

export async function startRegistration(chatId, from, env, L) {
  await db(env, 'setState', { chat_id: chatId, state: { step: 'name' } });
  const first = from.from && from.from.first_name ? from.from.first_name : '';
  const kb = first
    ? { keyboard: [[{ text: first }], [{ text: tr(L, 'btnCancel') }]], resize_keyboard: true, one_time_keyboard: true }
    : cancelKb(L);
  return send(env, chatId, tr(L, 'newReg') + tr(L, 'askName'), kb);
}

/** Пользователь зарегистрировался на сайте и нажал Start по ссылке t.me/Bot?start=<token> */
export async function linkFromSite(chatId, token, env, url, from) {
  const L0 = await chatLang(env, chatId, from);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return send(env, chatId, tr(L0, 'notFoundToken'), mainMenu(L0));
  // Ссылка активации одноразовая: после первой привязки другой Telegram-аккаунт её использовать не может
  // (иначе чужой человек со скриншотом ссылки получал бы оповещения о питомце)
  const usedBy = kvOn(env) ? await env.FYP_KV.get(`tok:${token}`) : null;
  if (usedBy && usedBy !== chatId) return refuseRelink(env, chatId, L0, token);
  const r = await db(env, 'linkTelegram', { token, chat_id: chatId });
  if (r.ok && r.conflict) return refuseRelink(env, chatId, L0, token); // таблица: жетон уже привязан к другому чату
  if (!r.ok || !r.found) return send(env, chatId, tr(L0, 'notFoundToken'), mainMenu(L0));
  await rememberChat(env, chatId);
  if (kvOn(env) && usedBy !== chatId) await bumpEvent(env, 'link'); // повторный Start тем же чатом не считаем
  // Все жетоны того же заказа привязываются одним нажатием Start
  const tags = [r.tag];
  const x = await getExtras(env, r.tag.tag_id);
  const order = await getOrder(env, x.order_id);
  if (order) {
    for (const [id, tok] of Object.entries(order.tokens || {})) {
      if (id === String(r.tag.tag_id) || !tok) continue;
      const r2 = await db(env, 'linkTelegram', { token: tok, chat_id: chatId });
      if (r2.ok && r2.found) tags.push(r2.tag);
    }
    order.chat_id = chatId;
    await saveOrder(env, order);
  }
  if (kvOn(env)) {
    const toks = new Set([token, ...Object.values((order && order.tokens) || {}).filter(Boolean)]);
    await Promise.all([...toks].map((t) => env.FYP_KV.put(`tok:${t}`, chatId)));
  }
  // бот говорит на языке, на котором оформлен заказ на сайте (если язык ещё не выбран через /lang)
  const L = await keepChatLang(env, chatId, (order && order.lang) || x.lang || L0);
  await Promise.all(tags.map((t) => cachePublic(env, t)));
  return sendRegistered(chatId, tags, env, url, order, L);
}

/**
 * /delete: владелец стирает данные жетона. Таблица (Apps Script v2: deleteTag) стирает имя, телефон,
 * адрес, кличку, привязку к чату; здесь — доп. данные, фото, копию страницы и личные данные в заказе.
 * Старый Apps Script (без deleteTag) — просьбу получает админ и удаляет вручную.
 */
export async function deleteTagData(env, chatId, tag, L) {
  const id = String(tag.tag_id);
  const r = await db(env, 'deleteTag', { id, chat_id: chatId });
  if (!r.ok) {
    await send(env, env.ADMIN_CHAT_ID || chatId, `🗑 <b>Delete request</b> for #${id} (${esc(tag.pet_name)}) from chat ${esc(chatId)} — ` +
      `the table did not delete it (${esc(r.error || 'error')}). Please delete the row manually and tell the customer.`);
    return send(env, chatId, tr(L, 'delLater'), mainMenu(L));
  }
  const x = await getExtras(env, id);
  if (kvOn(env)) {
    await Promise.all(['x:', 'c:', 'img:', 'f:', 'story:'].map((p) => env.FYP_KV.delete(p + id).catch(() => {})));
    const o = x.order_id ? await getOrder(env, x.order_id) : null;
    if (o) {
      o.items = o.items.map((i) => (i.tag_id === id ? { ...i, pet_name: '', deleted: true } : i));
      if (o.items.every((i) => i.deleted)) { o.owner_name = ''; o.phone = ''; o.address = ''; }
      o.history = [...(o.history || []), { status: 'deleted', tag_id: id, at: new Date().toISOString() }];
      await saveOrder(env, o);
    }
    const left = await db(env, 'listByChat', { chat_id: chatId });
    if (left.ok && !(left.tags || []).length) {
      await Promise.all([`chat:${chatId}`, `care:${chatId}`].map((k) => env.FYP_KV.delete(k).catch(() => {})));
    }
  }
  if (env.ADMIN_CHAT_ID) {
    await send(env, env.ADMIN_CHAT_ID, `🗑 Customer deleted the data of #${id}` + (x.order_id ? ` (order ${esc(x.order_id)})` : '') +
      '. If this tag is not made or shipped yet — do not make it.');
  }
  return send(env, chatId, tr(L, 'delDone', { pet: esc(tag.pet_name) }), mainMenu(L));
}

/** /plate для админа: CSV крышек (номер или код жетона, КЛИЧКА, телефон) для оплаченных заказов — для medallion_v2.py plate. */
export async function plateCsv(env, chatId, all) {
  if (!kvOn(env)) return send(env, chatId, tr('en', 'noKv'));
  const rows = [], noTg = [];
  let cursor;
  do {
    const page = await env.FYP_KV.list({ prefix: 'o:', cursor });
    for (const k of page.keys) {
      const o = await env.FYP_KV.get(k.name, 'json');
      if (!o || !(o.status === 'paid' || (all && o.status === 'new'))) continue;
      if (!o.chat_id) noTg.push(o.order_id);
      const phone = prettyPhone(normalizePhone(o.phone)).replace(/^\+972 /, '0');
      for (const it of o.items) {
        if (it.deleted) continue;
        const name = String(it.pet_name).toUpperCase().replace(/[",\r\n]/g, ' ').trim();
        for (let c = 0; c < (it.copies || 1); c++) rows.push(`${it.code || it.tag_id},${name},${phone}`); // C4: код вместо номера — QR ведёт на /T/<код>
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (!rows.length) return send(env, chatId, all ? 'No new or paid orders.' : 'No paid orders waiting to be made. Use /plate all to include new orders.');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `🖨 ${rows.length} lid(s) — python3 medallion_v2.py plate orders.csv` + (noTg.length ? `\n🔕 No notifications yet (call the customer): ${noTg.join(', ')}` : ''));
  form.append('document', new Blob(['id,name,phone\n' + rows.join('\n') + '\n'], { type: 'text/csv' }), 'orders.csv');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form }).then((x) => x.json()).catch(() => ({ ok: false }));
  if (!res.ok) return send(env, chatId, '⚠️ Could not send the CSV:\n<code>' + esc(rows.join('\n')) + '</code>');
}

export async function refuseRelink(env, chatId, L, token) {
  await alertAdmin(env, `relink:${token}`,
    `⚠️ An activation link was opened by another Telegram chat (${esc(chatId)}) — refused. ` +
    'If the customer changed Telegram, move the tag manually.');
  return send(env, chatId, tr(L, 'tokenUsed'), mainMenu(L));
}

export async function sendRegistered(chatId, tagsIn, env, url, order, L) {
  const tags = Array.isArray(tagsIn) ? tagsIn : [tagsIn];
  const first = tags[0];
  const copies = (id) => { const it = order && order.items.find((i) => i.tag_id === String(id)); return it ? it.copies : 1; };
  const keys = await Promise.all(tags.map((t) => tagKey(env, t.tag_id)));
  const list = tags.map((t, i) => tr(L, 'regItem', {
    pet: esc(t.pet_name), id: t.tag_id, c: copies(t.tag_id), link: esc(shortUrl(env, url, keys[i])),
  })).join('\n\n');
  const nm = tags.map((t) => esc(t.pet_name));
  const names = nm.length > 1 ? nm.slice(0, -1).join(', ') + tr(L, 'or') + nm[nm.length - 1] : nm[0];
  await send(env, chatId,
    tr(L, 'registered', {
      owner: esc(first.owner_name), list, names,
      order: order ? tr(L, 'regOrder', { id: order.order_id, label: esc(orderLabel(order, L)) }) : '',
    }),
    { inline_keyboard: [
      [{ text: tr(L, 'btnPreview'), url: shortUrl(env, url, keys[0]) }],
      [{ text: tr(L, 'btnAddExtras'), callback_data: `set:${first.tag_id}` }],
    ] });
  return send(env, chatId, tr(L, 'useMyTags'), mainMenu(L));
}

export async function myTags(chatId, env, url, L) {
  const r = await db(env, 'listByChat', { chat_id: chatId });
  if (!r.ok) return send(env, chatId, tr(L, 'cantLoad'));
  const tags = r.tags || [];
  if (!tags.length) return send(env, chatId, tr(L, 'noTags'), mainMenu(L));
  const ot = tr(L, 'orderTxt');
  const lines = await Promise.all(tags.map(async (t) => {
    const x = await getExtras(env, t.tag_id);
    const o = x.order_id ? await getOrder(env, x.order_id) : null;
    const open = o && o.status !== 'shipped';
    return tr(L, 'myTagLine', {
      pet: esc(t.pet_name), id: t.tag_id, lost: !!x.lost, copies: Number(x.copies) || 1,
      order: open ? o.order_id : '', status: open ? (ot[o.status] || o.status) : '',
      link: esc(shortUrl(env, url, x.code || t.tag_id)),
      p2: x.phone2 ? ltr(L, esc(prettyPhone(normalizePhone(x.phone2)))) : '', notes: x.notes ? esc(x.notes) : '',
      scan: t.last_scan_at ? esc(t.last_scan_at) : '',
    });
  }));
  return send(env, chatId, tr(L, 'myTagsHead') + lines.join('\n\n') + `\n\n${LRM}/settings · ${LRM}/photo · ${LRM}/lost · ${LRM}/found`, mainMenu(L));
}

/** «Забота»: описание и кнопка «Сообщите о запуске». */
export async function careInfo(chatId, env, L) {
  const on = kvOn(env) && (await env.FYP_KV.get(`care:${chatId}`));
  return send(env, chatId, tr(L, 'care', { price: ils(PRICING.care) }) + (on ? tr(L, 'careAlready') : ''),
    on ? mainMenu(L) : { inline_keyboard: [[{ text: tr(L, 'btnCare'), callback_data: 'care_yes' }]] });
}

/** Записать в лист ожидания «Заботы» и сообщить админу (сколько всего желающих). */
export async function careJoin(chatId, env, from, L) {
  if (!kvOn(env)) return send(env, chatId, tr(L, 'noKv'), mainMenu(L));
  const key = `care:${chatId}`;
  if (!(await env.FYP_KV.get(key))) {
    const name = from ? [from.first_name, from.last_name].filter(Boolean).join(' ') : '';
    await env.FYP_KV.put(key, JSON.stringify({ since: new Date().toISOString(), name, lang: L }));
    await bumpEvent(env, 'care');
    if (env.ADMIN_CHAT_ID) {
      let total = 0, cursor;
      do {
        const page = await env.FYP_KV.list({ prefix: 'care:', cursor });
        total += page.keys.length;
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      await send(env, env.ADMIN_CHAT_ID, `💚 FindYpet Care waitlist +1: ${esc(name || 'customer')} (chat ${chatId}, ${L}). Total: <b>${total}</b>`);
    }
  }
  return send(env, chatId, tr(L, 'careJoined'), mainMenu(L));
}
