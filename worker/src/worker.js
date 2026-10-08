/**
 * ============================================================
 *  FindYpet — Cloudflare Worker  (v4, сентябрь 2026)
 * ============================================================
 *  Один сервис делает всё:
 *   • отдаёт сайт — главная, страница метки /tag/?id=101 (и короткая /t/101),
 *     политика конфиденциальности /privacy/
 *   • API для сайта:
 *        POST /api/register   — заказ с сайта: 1, 2 или 4 жетона (3 + 1: питомцы + запасные)
 *        GET  /api/tag?id=101 — данные питомца для страницы метки (с резервным кэшем)
 *        POST /api/scan       — "метку отсканировали" (уведомление владельцу)
 *        POST /api/location   — геолокация от нашедшего → владельцу
 *        POST /api/found      — кнопка «Telegram» на странице: бот пишет владельцу «питомец найден» (+ точка)
 *   • GET /img/101  — фото питомца (из бота, /photo);  GET /p/101 — объявление «Потерялся» (HE/RU/EN, QR, печать)
 *   • Telegram-бот @YourPetLocatorBot (webhook: POST /telegram)
 *        /register /mytags /lost /found /settings /photo /care /lang /cancel /help /id — на иврите, русском и
 *        английском (тексты — const BOT); для админа (по-английски) /orders, /stats и
 *        кнопки статуса заказа (Оплачен → Изготовлен → Отправлен) — клиенту уходит сообщение
 *   • GET /setup?key=WEBHOOK_SECRET — одноразовая настройка бота (повторить после обновления!)
 *   • scheduled() — напоминание владельцам раз в 180 дней проверить контакты (нужен Cron Trigger)
 *
 *  База данных — Google Sheets через Apps Script (GAS_URL + GAS_KEY) — без изменений.
 *  Новые данные (режим «Потерялся», второй телефон, заметки, резервный кэш страницы)
 *  хранятся в Cloudflare KV (binding FYP_KV) с ключом tag_id. Без KV сайт и бот
 *  работают как раньше, просто новые функции отключены.
 *
 *  Переменные окружения (Settings → Variables / Bindings):
 *   BOT_TOKEN       (секрет)  токен бота от @BotFather
 *   BOT_USERNAME              YourPetLocatorBot
 *   GAS_URL         (секрет)  URL веб-приложения Apps Script (…/exec)
 *   GAS_KEY         (секрет)  тот же ключ, что API_KEY в Apps Script
 *   WEBHOOK_SECRET  (секрет)  любая случайная строка (A-Z a-z 0-9 _ -)
 *   SITE_URL                  адрес сайта без / в конце (пусто = адрес этого Worker)
 *   ADMIN_CHAT_ID             (необяз.) ваш chat id — уведомления о новых заказах
 *   TIMEZONE                  Asia/Jerusalem
 *   FYP_KV          (binding) KV namespace — новые функции (обязательно для /lost, /settings)
 *   LOST_CHANNEL_ID           (необяз.) @канал или -100… — куда бот публикует «Потерялся»
 *                             (бот должен быть админом канала)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (секрет), TWILIO_FROM
 *                             (необяз.) SMS-резерв, если у владельца нет Telegram
 * ============================================================
 */

// ---------------------------------------------------------------
// Тексты бота на трёх языках (EN / HE / RU). Язык чата: /lang → язык заказа на сайте →
// язык Telegram (language_code) → английский. Значения в функциях уже экранированы (esc) вызывающим кодом.
// В иврите перед /командами стоит невидимая метка LRM (‎), а «3 + 1» обёрнуто в изоляторы
// (⁦…⁩), чтобы цифры и косая черта не переворачивались.
// Сообщения админу (лист производства, /orders, /stats) остаются по-английски.
// ---------------------------------------------------------------
const LANGS = ['en', 'he', 'ru'];
const LRM = '‎';
const iso = (t) => '\u2066' + t + '\u2069'; // изолятор: «3 + 1» и номера не переворачиваются в иврите
const ruPlural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b >= 2 && b <= 4 ? few : many;
};

const BOT = {
  en: {
    welcome:
      '🐾 <b>Welcome to FindYpet!</b>\n\n' +
      'I help your pet get home fast. Your tag has your phone number, a QR code and NFC. ' +
      'Whoever finds your pet can call you, write to you on WhatsApp, or send you their location — ' +
      'and I will alert you right here the moment the tag is scanned.\n\n' +
      'Tap <b>Register a pet</b> to get your personal tag.\n\n🌐 עברית · Русский · English — /lang',
    btnRegister: '🐾 Register a pet', btnMyTags: '🏷 My tags', btnLost: '🚨 Lost', btnSettings: '⚙️ Settings',
    btnCancel: '❌ Cancel', btnSkip: '➡️ Skip', btnSharePhone: '📱 Share my phone number',
    askName: '👤 What is your <b>name</b> (pet owner)?',
    askPhone:
      '📱 Your <b>phone number</b> — the finder will call it.\n' +
      'Tap the button below to share it, or type it (e.g. 050-123-4567).',
    badPhone: '⚠️ That doesn\'t look like a phone number. Please try again (e.g. 050-123-4567).',
    askPet: '🐶 What is your <b>pet\'s name</b>?',
    askAddress: '🏠 Your <b>address</b> (city, street, apartment) — we ship the tag there. It is never shown on the pet page.',
    cancelled: 'Cancelled. Send /help to see what I can do.',
    notFoundToken: '⚠️ This activation link is not valid (or expired).\nYou can register a new pet here: /register',
    noTags: 'You have no registered pets yet. Tap /register to add one.',
    noKv: '⚠️ This feature is not switched on yet. Please try again later.',
    help:
      '<b>Commands</b>\n' +
      '/register — register a new pet and get a tag\n' +
      '/mytags — your pets, links and status\n' +
      '🚨 /lost — pet missing: switch the tag page to "I\'m lost"\n' +
      '✅ /found — pet is home: switch Lost mode off\n' +
      '⚙️ /settings — second contact and notes for the finder\n' +
      '📷 /photo — add your pet\'s photo to its page\n' +
      '💚 /care — FindYpet Care (coming soon)\n' +
      '🌐 /lang — bot language\n' +
      '/cancel — cancel the current action\n' +
      '/id — show your Telegram chat ID\n\n' +
      '✉️ Questions? Write to us here or at findypet0926@gmail.com',
    askArea:
      '📍 Where was your pet last seen? (area / city — e.g. "Haifa, Carmel Center")\n' +
      'This is shown on the tag page. Tap <b>Skip</b> if you prefer not to say.',
    askPhone2: '📞 Send the <b>second phone number</b> (e.g. a family member). It will be shown on the pet page.',
    askNotes:
      '📝 Send the <b>notes for the finder</b> (up to 200 characters).\n' +
      'For example: "Allergic to chicken. Scared of people — don\'t chase, call me."\n' +
      'They will be shown on the pet page.',
    reminder:
      '🔔 <b>Quick check:</b> are your contacts on the FindYpet tag still up to date?\n' +
      'Outdated contacts are a common reason a found pet doesn\'t get home.\n\n' +
      '/mytags — see your tags · /settings — second contact and notes\n' +
      'Phone number changed? Just write to us here.',
    chatId: (v) => `Your chat ID: <code>${v.id}</code>`,
    useButtons: 'Please choose using the buttons above.',
    petN: (v) => `🐾 Name of pet #${v.n}?`,
    tapConfirm: 'Please tap ✅ Confirm or ✏️ Start over above.',
    btnConfirm: '✅ Confirm', btnAgain: '✏️ Start over',
    phone2Saved: (v) => `✅ Second contact saved: ${v.phone}\nIt is now shown on the pet page.`,
    notesSaved: (v) => `✅ Notes saved:\n<i>${v.notes}</i>\nThey are now shown on the pet page.`,
    tagN: (v) => (v.n === 1 ? '1 tag' : `${v.n} tags`),
    qtyLabel: (v) => (v.tags === 1 ? `1 tag — ${v.total}` : `${v.tags} tags${v.free ? ` (${v.paid} + ${v.free} free)` : ''} — ${v.total}`),
    askQty: (v) =>
      '🏷 <b>How many tags?</b> One-time payment, no subscription needed.\n\n' +
      `• <b>1 tag — ${v.one}</b>\n` +
      `• <b>2 tags — ${v.two}</b>: for 2 pets, or a pet and a spare copy of its tag\n` +
      `• <b>${v.paid} + ${v.free} free — ${v.total} for ${v.tags} tags</b>: for 3–4 pets, or fewer pets plus spare tags\n\n` +
      'Every tag includes everything: call, WhatsApp and Telegram from the page, scan and location alerts, ' +
      'Lost mode, a second contact and notes for the finder.',
    confirm: (v) =>
      '<b>Please check your details:</b>\n\n' +
      `👤 Owner: ${v.owner}\n📱 Phone: ${v.phone}\n` + v.items + `🏠 Address: ${v.address}\n💳 ${v.label} · one-time\n\n` +
      '🔒 By confirming, you agree that your first name, phone and pet\'s name are shown on the pet page ' +
      'to whoever scans the tag. Your address is used only for delivery. ' +
      `<a href="${v.privacy}">Privacy policy</a>`,
    itemPet: (v) => `🐾 Pet: ${v.pet}\n`,
    itemsHead: '🏷 Tags:\n',
    itemCopies: (v) => ` — ${v.c} tags (${v.c - 1} spare)`,
    notLinked: '⚠️ This tag is not linked to your Telegram.',
    phone2Removed: '🗑 Second contact removed.',
    notesRemoved: '🗑 Notes removed.',
    expired: 'Session expired. Tap /register to start again.',
    howManyPets: (v) =>
      `🏷 <b>${v.n} tags${v.free ? ` (${v.paid} + ${v.free} free)` : ''}.</b> How many pets will wear them?\n\n` +
      'Each pet gets its own tag and page. Tags left over become <b>spare tags</b> — an exact copy of a pet\'s tag ' +
      '(same page and link), handy if one gets lost.',
    petsBtn: (v) => (v.c === 1 ? `1 pet: ${v.pet} (+${v.n - 1} spare)` : `${v.c} pets` + (v.n - v.c ? ` (+${v.n - v.c} spare)` : '')),
    offerChanged: (v) => `ℹ️ Our offer has changed: now <b>${v.paid} + ${v.free} — ${v.tags} tags for ${v.total}</b>. ` +
      'Your order gets one more tag — please check the details once more.',
    wentWrong: '⚠️ Something went wrong. Please try again: /register',
    spareQ: (v) => (v.spares === 1 ? '🏷 The spare tag — for which pet?' : `🏷 Spare tag ${v.k} of ${v.spares} — for which pet?`) +
      ' It will be an exact copy of that pet\'s tag.',
    cantLoad: '⚠️ Could not load your tags right now. Please try again in a minute.',
    noneLost: 'None of your pets is in Lost mode right now.',
    pickLost: '🚨 Which pet is missing?', pickFound: '✅ Which pet is home?', pickSet: '⚙️ Settings for which pet?',
    pickPhoto: '📷 Photo for which pet?',
    lostTitle: (v) => `🚨 <b>Lost mode for ${v.pet}</b>\n\n`,
    lostOn: (v) =>
      `🚨 <b>Lost mode is ON for ${v.pet}.</b>\n\n` +
      'The tag page has turned red: "I\'m lost 😢 — My family is looking for me"' + (v.area ? `, last seen: ${v.area}` : '') + '.\n' +
      'Every scan will be reported to you immediately.\n\n' +
      '📣 <b>Forward this to local groups</b> (neighbours, dog owners, lost pets groups). ' +
      'The link opens a poster in Hebrew, Russian and English — you can print it too:\n\n' + v.shares + '\n\n' +
      (v.photo ? '' : '📷 No photo yet — send /photo: people recognise a pet by its photo.\n\n') +
      `When ${v.pet} is home, send /found.`,
    lostOff: (v) => `✅ Great news! Lost mode is OFF — ${v.pet}'s page is back to normal. ❤️`,
    btnChangeP2: '📞 Change second contact', btnAddP2: '📞 Add second contact',
    btnChangeNotes: '📝 Change notes', btnAddNotes: '📝 Add notes for the finder',
    btnRmP2: '🗑 Remove second contact', btnRmNotes: '🗑 Remove notes', btnPhoto: '📷 Pet photo',
    settings: (v) =>
      `⚙️ <b>${v.pet} · tag #${v.id}</b>\n\n` +
      `📱 Main phone: ${v.phone}\n📞 Second contact: ${v.p2 || '—'}\n📝 Notes: ${v.notes ? '<i>' + v.notes + '</i>' : '—'}\n` +
      `📷 Photo: ${v.photo ? 'yes' : '—'}\n\n` +
      'To change the main phone or name, just write to us here.',
    newReg: '📝 <b>New pet registration</b>\n\n',
    regItem: (v) => `🐾 <b>${v.pet}</b> — tag #${v.id}` + (v.c > 1 ? ` · ${v.c} tags (incl. ${v.c - 1} spare)` : '') + `\n🔗 ${v.link}`,
    or: ' or ',
    regOrder: (v) => `🧾 Order <b>${v.id}</b> · ${v.label}\n` +
      '<b>What happens next:</b> we contact you to confirm the order and payment → we print the tag and write the NFC → ' +
      'we ship it to your address. I\'ll keep you posted right here.\n\n',
    registered: (v) =>
      `🎉 <b>${v.owner}, you are registered in FindYpet!</b>\n\n` + v.list + '\n\n' + v.order +
      'When someone scans a tag, I\'ll alert you here, and they can call you, write on WhatsApp or notify you with one tap ' +
      'and send you their location. Keep notifications for this chat turned on 🔔\n\n' +
      '<b>Useful commands</b>\n' +
      '⚙️ /settings — second contact and notes (allergies, "don\'t chase me")\n' +
      '📷 /photo — your pet\'s photo on its page helps the finder be sure\n' +
      `🚨 /lost — if ${v.names} goes missing\n` +
      '💚 /care — FindYpet Care, coming soon\n' +
      '📲 When the tag arrives: scan the QR or hold your phone to it — it must open the pet page.',
    btnPreview: '👀 Preview pet page', btnAddExtras: '⚙️ Add second contact / notes',
    useMyTags: 'Use /mytags any time to see your tags.',
    orderTxt: { new: 'received — we will contact you', paid: 'paid — being made', made: 'ready — shipping soon', shipped: 'shipped' },
    myTagLine: (v) => `🐾 <b>${v.pet}</b> — tag #${v.id}` + (v.lost ? '  🚨 <b>LOST MODE</b>' : '') +
      (v.copies > 1 ? ` · ${v.copies} tags` : '') + '\n' +
      (v.order ? `🧾 Order ${v.order}: ${v.status}\n` : '') + `🔗 ${v.link}` +
      (v.p2 ? `\n📞 2nd contact: ${v.p2}` : '') + (v.notes ? `\n📝 ${v.notes}` : '') + (v.scan ? `\n🕒 last scan: ${v.scan}` : ''),
    myTagsHead: '<b>Your tags</b>\n\n',
    care: (v) =>
      '💚 <b>FindYpet Care — coming soon</b>\n\n' +
      `A monthly program for pet owners — planned ${v.price}/month per owner, covering all your pets; cancel any time:\n` +
      '• a digital health card from your vet clinic\n' +
      '• discounts at pet shops, groomers and pet hotels\n' +
      '• partner bonuses\n\n' +
      'Your tag works fully without it — Care is an extra and is never needed to find your pet.\n' +
      'Want to be among the first? Tap the button and we\'ll let you know when it launches. No payment now.',
    careAlready: '\n\n✅ You are already on the list — we\'ll write to you here.',
    btnCare: '🔔 Notify me when it launches',
    careJoined: '✅ Done! We\'ll write to you here as soon as FindYpet Care launches. Nothing to pay now.',
    stPaid: (v) => `💰 <b>Payment received — thank you!</b>\nOrder ${v.id}: we're now making your ${v.n > 1 ? 'tags' : 'tag'} for ${v.names}.`,
    stMade: (v) => `🏭 <b>Your ${v.n > 1 ? 'tags are' : 'tag is'} ready</b> — printed and NFC written. We'll ship soon.`,
    stShipped: (v) =>
      `📦 <b>Your FindYpet ${v.n > 1 ? 'tags are' : 'tag is'} on the way!</b>\nOrder ${v.id} → ${v.address}\n\n` +
      `<b>When it arrives:</b>\n1️⃣ Scan the QR or hold your phone to the tag — it must open the pet page:\n${v.links}\n` +
      '2️⃣ Put it on the collar.\n3️⃣ /settings — add a second contact and notes for the finder.',
    scanned: (v) =>
      `👀 <b>${v.pet}'s tag was just scanned!</b> (${v.time})\n` +
      `Someone opened ${v.pet}'s page. They can call you, write on WhatsApp or tap "Notify the owner" — keep your phone close.\n` +
      'If they share their location, I will send it to you right here.',
    btnLostOn: '🚨 My pet is missing — Lost mode on', btnLostOff: '✅ Pet is home — Lost mode off',
    foundHead: (v) => `🐾 <b>${v.pet} has been found!</b> (${v.time})\n` +
      `The finder is with ${v.pet} right now and tapped "Notify the owner" on the tag page.\n`,
    foundLoc: (v) => '📍 They shared their location' + (v.acc ? ` (±${v.acc} m)` : '') + ':\n',
    foundNoLoc: 'They did not share their location. Check missed calls and WhatsApp, then call them back.',
    maps: 'Open in Google Maps',
    locHead: (v) => `🚨📍 <b>${v.pet} has been found!</b>\nThe finder shared their location (${v.time})` +
      (v.acc ? `, accuracy ±${v.acc} m` : '') + '.\n\n',
    safety: '\n\n⚠️ <i>FindYpet never asks anyone for money. If someone wants money before you see your pet — don\'t pay. ' +
      'Call the finder back and meet in a public place.</i>',
    smsScan: (v) => `FindYpet: ${v.pet}'s tag was just scanned. The finder may call you or write on WhatsApp. ${v.link}`,
    smsFound: (v) => `FindYpet: ${v.pet} was found! The finder is here: ${v.maps}`,
    langAsk: '🌐 Choose the bot language:',
    langSet: '✅ The bot now speaks English.',
    askPhoto: (v) => `📷 Send one photo of <b>${v.pet}</b> — face and fur well visible. It will be shown on the pet page and on the poster in Lost mode.`,
    photoSaved: (v) => `✅ Photo saved — it is now on ${v.pet}'s page.`,
    photoBad: '⚠️ Please send the photo as a picture (not as a file), or tap ❌ Cancel.',
    photoRemoved: '🗑 Photo removed.', btnRmPhoto: '🗑 Remove photo',
    share: (v) => `🚨 LOST: ${v.pet}` + (v.area ? ` · last seen: ${v.area}` : '') +
      `\nIf you see ${v.pet}, open this page to call the owner: ${v.link}`,
    chanLine: 'Lost pet. Seen it? Open the page and call the owner.',
    chanHome: (v) => `${v.pet} is home! Thank you to everyone who helped ❤️`,
    cmds: {
      register: 'Register a pet and get a tag', mytags: 'My pets, links and status',
      lost: '🚨 My pet is missing — Lost mode on', found: '✅ My pet is home — Lost mode off',
      settings: 'Second contact and notes for the finder', photo: '📷 Pet photo on its page',
      care: '💚 FindYpet Care — coming soon', lang: '🌐 Language · שפה · Язык',
      cancel: 'Cancel the current action', help: 'Help',
    },
    desc: 'FindYpet — smart pet ID tag with your phone number, QR and NFC. Whoever finds your pet can call you, ' +
      'write on WhatsApp or send their location — and you get an alert here the moment the tag is scanned. ' +
      'Tap Start to register.',
    shortDesc: 'Lost pet? Whoever finds it can call you or send you the location. Alerts right here.',
  },

  he: {
    welcome:
      '🐾 <b>ברוכים הבאים ל-FindYpet!</b>\n\n' +
      'אני עוזר לחיות מחמד לחזור הביתה מהר. על התג יש את מספר הטלפון שלכם, קוד QR ו-NFC. ' +
      'מי שימצא את חיית המחמד יוכל להתקשר אליכם, לכתוב לכם בוואטסאפ או לשלוח לכם את המיקום שלו — ' +
      'ואני אודיע לכם כאן ברגע שהתג נסרק.\n\n' +
      'לחצו על <b>רישום חיית מחמד</b> כדי לקבל תג אישי.\n\n' + `🌐 עברית · Русский · English — ${LRM}/lang`,
    btnRegister: '🐾 רישום חיית מחמד', btnMyTags: '🏷 התגים שלי', btnLost: '🚨 מצב חיפוש', btnSettings: '⚙️ הגדרות',
    btnCancel: '❌ ביטול', btnSkip: '➡️ דילוג', btnSharePhone: '📱 לשלוח את המספר שלי',
    askName: '👤 מה <b>השם</b> שלכם (בעלי חיית המחמד)?',
    askPhone:
      '📱 <b>מספר הטלפון</b> שלכם — אליו יתקשר מי שימצא.\n' +
      'לחצו על הכפתור למטה כדי לשלוח אותו, או הקלידו אותו (למשל 050-123-4567).',
    badPhone: '⚠️ זה לא נראה כמו מספר טלפון. נסו שוב (למשל 050-123-4567).',
    askPet: '🐶 מה <b>השם של חיית המחמד</b>?',
    askAddress: '🏠 <b>הכתובת</b> שלכם (עיר, רחוב, דירה) — לשם נשלח את התג. היא אף פעם לא מוצגת בדף החיה.',
    cancelled: `בוטל. שלחו ${LRM}/help כדי לראות מה אני יודע לעשות.`,
    notFoundToken: `⚠️ קישור ההפעלה הזה לא תקף (או שפג תוקפו).\nאפשר לרשום חיית מחמד חדשה כאן: ${LRM}/register`,
    noTags: `עדיין אין לכם חיות מחמד רשומות. לחצו ${LRM}/register כדי להוסיף.`,
    noKv: '⚠️ האפשרות הזו עדיין לא פעילה. נסו שוב מאוחר יותר.',
    help:
      '<b>פקודות</b>\n' +
      `${LRM}/register — רישום חיית מחמד וקבלת תג\n` +
      `${LRM}/mytags — חיות המחמד שלכם, קישורים וסטטוס\n` +
      `🚨 ${LRM}/lost — חיית המחמד נעלמה: הפעלת מצב חיפוש\n` +
      `✅ ${LRM}/found — חיית המחמד בבית: כיבוי מצב חיפוש\n` +
      `⚙️ ${LRM}/settings — איש קשר נוסף והערות למוצא\n` +
      `📷 ${LRM}/photo — תמונה של חיית המחמד בדף שלה\n` +
      `💚 ${LRM}/care — FindYpet Care (בקרוב)\n` +
      `🌐 ${LRM}/lang — שפת הבוט\n` +
      `${LRM}/cancel — ביטול הפעולה הנוכחית\n` +
      `${LRM}/id — מזהה הצ׳אט שלכם בטלגרם\n\n` +
      '✉️ שאלות? כתבו לנו כאן או ל-findypet0926@gmail.com',
    askArea:
      '📍 איפה ראו את חיית המחמד בפעם האחרונה? (שכונה או עיר — למשל "חיפה, מרכז הכרמל")\n' +
      'זה יוצג בדף התג. לחצו <b>דילוג</b> אם אתם מעדיפים לא לציין.',
    askPhone2: '📞 שלחו <b>מספר טלפון נוסף</b> (למשל של בן משפחה). הוא יוצג בדף החיה.',
    askNotes:
      '📝 שלחו <b>הערות למוצא</b> (עד 200 תווים).\n' +
      'למשל: "אלרגי לעוף. מפחד מאנשים — לא לרדוף, להתקשר אליי".\n' +
      'ההערות יוצגו בדף החיה.',
    reminder:
      '🔔 <b>בדיקה קצרה:</b> פרטי הקשר בתג FindYpet עדיין עדכניים?\n' +
      'מספר לא מעודכן הוא סיבה נפוצה לכך שחיה שנמצאה לא חוזרת הביתה.\n\n' +
      `${LRM}/mytags — התגים שלכם · ${LRM}/settings — איש קשר נוסף והערות\n` +
      'המספר השתנה? פשוט כתבו לנו כאן.',
    chatId: (v) => `מזהה הצ׳אט שלכם: <code>${v.id}</code>`,
    useButtons: 'בחרו בבקשה באחד הכפתורים למעלה.',
    petN: (v) => `🐾 מה השם של חיית מחמד מס׳ ${v.n}?`,
    tapConfirm: 'לחצו למעלה על ✅ אישור או על ✏️ להתחיל מחדש.',
    btnConfirm: '✅ אישור', btnAgain: '✏️ להתחיל מחדש',
    phone2Saved: (v) => `✅ איש הקשר הנוסף נשמר: ${v.phone}\nהוא מוצג עכשיו בדף החיה.`,
    notesSaved: (v) => `✅ ההערות נשמרו:\n<i>${v.notes}</i>\nהן מוצגות עכשיו בדף החיה.`,
    tagN: (v) => (v.n === 1 ? 'תג אחד' : `${v.n} תגים`),
    qtyLabel: (v) => (v.tags === 1 ? `תג אחד — ${v.total}` : `${v.tags} תגים${v.free ? ` (${iso(v.paid + ' + ' + v.free)} במתנה)` : ''} — ${v.total}`),
    askQty: (v) =>
      '🏷 <b>כמה תגים?</b> תשלום חד-פעמי, בלי מנוי.\n\n' +
      `• <b>תג אחד — ${v.one}</b>\n` +
      `• <b>2 תגים — ${v.two}</b>: ל-2 חיות, או לחיה אחת ועוד עותק רזרבי של התג שלה\n` +
      `• <b>${iso(v.paid + ' + ' + v.free)} במתנה — ${v.total} ל-${v.tags} תגים</b>: ל-3–4 חיות, או לפחות חיות עם תגים רזרביים\n\n` +
      'כל תג כולל הכול: שיחה, וואטסאפ וטלגרם מהדף, התראות על סריקה ועל מיקום, מצב חיפוש, איש קשר נוסף והערות למוצא.',
    confirm: (v) =>
      '<b>בדקו בבקשה את הפרטים:</b>\n\n' +
      `👤 בעלים: ${v.owner}\n📱 טלפון: ${v.phone}\n` + v.items + `🏠 כתובת: ${v.address}\n💳 ${v.label} · תשלום חד-פעמי\n\n` +
      '🔒 באישור אתם מסכימים שהשם הפרטי, הטלפון ושם חיית המחמד יוצגו בדף החיה למי שסורק את התג. ' +
      'הכתובת משמשת רק למשלוח. ' +
      `<a href="${v.privacy}">מדיניות פרטיות</a>`,
    itemPet: (v) => `🐾 חיית מחמד: ${v.pet}\n`,
    itemsHead: '🏷 תגים:\n',
    itemCopies: (v) => ` — ${v.c} תגים (${v.c - 1} ${v.c - 1 === 1 ? 'רזרבי' : 'רזרביים'})`,
    notLinked: '⚠️ התג הזה לא מקושר לטלגרם שלכם.',
    phone2Removed: '🗑 איש הקשר הנוסף הוסר.',
    notesRemoved: '🗑 ההערות הוסרו.',
    expired: `פג תוקף השיחה. לחצו ${LRM}/register כדי להתחיל מחדש.`,
    howManyPets: (v) =>
      `🏷 <b>${v.n} תגים${v.free ? ` (${iso(v.paid + ' + ' + v.free)} במתנה)` : ''}.</b> כמה חיות יענדו אותם?\n\n` +
      'לכל חיה יש תג ודף משלה. התגים שנשארים הופכים ל<b>תגים רזרביים</b> — עותק מדויק של התג של אחת החיות ' +
      '(אותו דף ואותו קישור), שימושי אם תג הולך לאיבוד.',
    petsBtn: (v) => (v.c === 1 ? `חיה אחת: ${v.pet} (+${v.n - 1} רזרבי)` : `${v.c} חיות` + (v.n - v.c ? ` (+${v.n - v.c} רזרבי)` : '')),
    offerChanged: (v) => `ℹ️ המבצע שלנו השתנה: עכשיו <b>${iso(v.paid + ' + ' + v.free)} — ${v.tags} תגים ב-${v.total}</b>. ` +
      'להזמנה שלכם מתווסף עוד תג — בדקו בבקשה את הפרטים שוב.',
    wentWrong: `⚠️ משהו השתבש. נסו שוב: ${LRM}/register`,
    spareQ: (v) => (v.spares === 1 ? '🏷 התג הרזרבי — לאיזו חיה?' : `🏷 תג רזרבי ${v.k} מתוך ${v.spares} — לאיזו חיה?`) +
      ' הוא יהיה עותק מדויק של התג של אותה חיה.',
    cantLoad: '⚠️ לא הצלחנו לטעון את התגים שלכם כרגע. נסו שוב בעוד דקה.',
    noneLost: 'כרגע אף אחת מחיות המחמד שלכם לא במצב חיפוש.',
    pickLost: '🚨 איזו חיה נעלמה?', pickFound: '✅ איזו חיה חזרה הביתה?', pickSet: '⚙️ הגדרות של איזו חיה?',
    pickPhoto: '📷 תמונה של איזו חיה?',
    lostTitle: (v) => `🚨 <b>מצב חיפוש: ${v.pet}</b>\n\n`,
    lostOn: (v) =>
      `🚨 <b>מצב חיפוש הופעל: ${v.pet}.</b>\n\n` +
      'דף התג הפך לאדום: "הלכתי לאיבוד 😢 — המשפחה שלי מחפשת אותי"' + (v.area ? `, אזור: ${v.area}` : '') + '.\n' +
      'על כל סריקה אודיע לכם מיד.\n\n' +
      '📣 <b>העבירו את זה לקבוצות מקומיות</b> (שכנים, בעלי כלבים, קבוצות חיפוש חיות). ' +
      'הקישור פותח כרזה בעברית, ברוסית ובאנגלית — אפשר גם להדפיס אותה:\n\n' + v.shares + '\n\n' +
      (v.photo ? '' : `📷 עדיין אין תמונה — שלחו ${LRM}/photo: אנשים מזהים חיה לפי התמונה.\n\n`) +
      `כשחיית המחמד חוזרת הביתה, שלחו ${LRM}/found.`,
    lostOff: (v) => `✅ חדשות טובות! מצב החיפוש כבוי — הדף של ${v.pet} חזר לרגיל. ❤️`,
    btnChangeP2: '📞 שינוי איש קשר נוסף', btnAddP2: '📞 הוספת איש קשר נוסף',
    btnChangeNotes: '📝 שינוי הערות', btnAddNotes: '📝 הוספת הערות למוצא',
    btnRmP2: '🗑 הסרת איש הקשר הנוסף', btnRmNotes: '🗑 הסרת ההערות', btnPhoto: '📷 תמונה',
    settings: (v) =>
      `⚙️ <b>${v.pet} · תג מס׳ ${v.id}</b>\n\n` +
      `📱 טלפון ראשי: ${v.phone}\n📞 איש קשר נוסף: ${v.p2 || '—'}\n📝 הערות: ${v.notes ? '<i>' + v.notes + '</i>' : '—'}\n` +
      `📷 תמונה: ${v.photo ? 'יש' : '—'}\n\n` +
      'כדי לשנות את הטלפון הראשי או את השם, פשוט כתבו לנו כאן.',
    newReg: '📝 <b>רישום חיית מחמד חדשה</b>\n\n',
    regItem: (v) => `🐾 <b>${v.pet}</b> — תג מס׳ ${v.id}` + (v.c > 1 ? ` · ${v.c} תגים (כולל ${v.c - 1} ${v.c - 1 === 1 ? 'רזרבי' : 'רזרביים'})` : '') + `\n🔗 ${v.link}`,
    or: ' או ',
    regOrder: (v) => `🧾 הזמנה <b>${v.id}</b> · ${v.label}\n` +
      '<b>מה הלאה:</b> ניצור איתכם קשר כדי לאשר את ההזמנה והתשלום ← נדפיס את התג ונכתוב את ה-NFC ← ' +
      'נשלח אותו לכתובת שלכם. אעדכן אתכם כאן בכל שלב.\n\n',
    registered: (v) =>
      `🎉 <b>${v.owner}, נרשמתם ל-FindYpet!</b>\n\n` + v.list + '\n\n' + v.order +
      'כשמישהו סורק תג, אודיע לכם כאן, ומי שמצא יוכל להתקשר אליכם, לכתוב בוואטסאפ או להודיע לכם בלחיצה אחת ' +
      'ולשלוח את המיקום שלו. השאירו את ההתראות של הצ׳אט הזה פעילות 🔔\n\n' +
      '<b>פקודות שימושיות</b>\n' +
      `⚙️ ${LRM}/settings — איש קשר נוסף והערות (אלרגיות, "לא לרדוף אחריי")\n` +
      `📷 ${LRM}/photo — תמונה בדף עוזרת למוצא לוודא שזו החיה הנכונה\n` +
      `🚨 ${LRM}/lost — אם חיית המחמד נעלמת\n` +
      `💚 ${LRM}/care — FindYpet Care, בקרוב\n` +
      '📲 כשהתג מגיע: סרקו את ה-QR או קרבו אליו את הטלפון — צריך להיפתח דף החיה.',
    btnPreview: '👀 תצוגה של דף החיה', btnAddExtras: '⚙️ איש קשר נוסף / הערות',
    useMyTags: `אפשר לראות את התגים שלכם בכל עת עם ${LRM}/mytags.`,
    orderTxt: { new: 'התקבלה — ניצור איתכם קשר', paid: 'שולמה — בייצור', made: 'מוכנה — תישלח בקרוב', shipped: 'נשלחה' },
    myTagLine: (v) => `🐾 <b>${v.pet}</b> — תג מס׳ ${v.id}` + (v.lost ? '  🚨 <b>מצב חיפוש</b>' : '') +
      (v.copies > 1 ? ` · ${v.copies} תגים` : '') + '\n' +
      (v.order ? `🧾 הזמנה ${v.order}: ${v.status}\n` : '') + `🔗 ${v.link}` +
      (v.p2 ? `\n📞 איש קשר נוסף: ${v.p2}` : '') + (v.notes ? `\n📝 ${v.notes}` : '') + (v.scan ? `\n🕒 סריקה אחרונה: ${v.scan}` : ''),
    myTagsHead: '<b>התגים שלכם</b>\n\n',
    care: (v) =>
      '💚 <b>FindYpet Care — בקרוב</b>\n\n' +
      `תוכנית חודשית לבעלי חיות — מחיר מתוכנן ${v.price} לחודש לבעלים, לכל חיות המחמד שלכם; אפשר לבטל בכל עת:\n` +
      '• כרטיס רפואי דיגיטלי מהמרפאה הווטרינרית שלכם\n' +
      '• הנחות בחנויות לחיות, במספרות לכלבים ובפנסיונים לחיות\n' +
      '• הטבות משותפים\n\n' +
      'התג עובד במלואו גם בלעדיה — Care היא תוספת, ואף פעם לא נדרשת כדי למצוא את החיה.\n' +
      'רוצים להיות מהראשונים? לחצו על הכפתור ונודיע לכם על ההשקה. אין מה לשלם עכשיו.',
    careAlready: '\n\n✅ אתם כבר ברשימה — נכתוב לכם כאן.',
    btnCare: '🔔 עדכנו אותי בהשקה',
    careJoined: '✅ מעולה! נכתוב לכם כאן ברגע ש-FindYpet Care תושק. אין מה לשלם עכשיו.',
    stPaid: (v) => `💰 <b>התשלום התקבל — תודה!</b>\nהזמנה ${v.id}: אנחנו מכינים עכשיו את ${v.n > 1 ? 'התגים' : 'התג'} של ${v.names}.`,
    stMade: (v) => `🏭 <b>${v.n > 1 ? 'התגים מוכנים' : 'התג מוכן'}</b> — ${v.n > 1 ? 'הודפסו' : 'הודפס'} וה-NFC נכתב. נשלח בקרוב.`,
    stShipped: (v) =>
      `📦 <b>${v.n > 1 ? 'התגים' : 'התג'} של FindYpet בדרך אליכם!</b>\nהזמנה ${v.id} · ${v.address}\n\n` +
      `<b>כשזה מגיע:</b>\n1️⃣ סרקו את ה-QR או קרבו את הטלפון לתג — צריך להיפתח דף החיה:\n${v.links}\n` +
      `2️⃣ חברו לקולר.\n3️⃣ ${LRM}/settings — הוסיפו איש קשר נוסף והערות למוצא.`,
    scanned: (v) =>
      `👀 <b>התג של ${v.pet} נסרק עכשיו!</b> (${v.time})\n` +
      `מישהו פתח את הדף של ${v.pet}. הוא יכול להתקשר אליכם, לכתוב בוואטסאפ או ללחוץ "להודיע לבעלים" — השאירו את הטלפון קרוב.\n` +
      'אם הוא ישתף מיקום, אשלח אותו לכם כאן מיד.',
    btnLostOn: '🚨 חיית המחמד נעלמה — הפעלת מצב חיפוש', btnLostOff: '✅ חיית המחמד בבית — כיבוי מצב חיפוש',
    foundHead: (v) => `🐾 <b>מצאו את ${v.pet}!</b> (${v.time})\n` +
      `מי שמצא נמצא עכשיו עם ${v.pet} ולחץ "להודיע לבעלים" בדף התג.\n`,
    foundLoc: (v) => '📍 הוא שיתף מיקום' + (v.acc ? ` (±${v.acc} מ׳)` : '') + ':\n',
    foundNoLoc: 'הוא לא שיתף מיקום. בדקו שיחות שלא נענו וּוואטסאפ, ואז התקשרו אליו.',
    maps: 'Google Maps',
    locHead: (v) => `🚨📍 <b>מצאו את ${v.pet}!</b>\nמי שמצא שיתף מיקום (${v.time})` +
      (v.acc ? `, דיוק ±${v.acc} מ׳` : '') + '.\n\n',
    safety: '\n\n⚠️ <i>FindYpet אף פעם לא מבקשת כסף מאף אחד. אם מישהו רוצה כסף לפני שראיתם את חיית המחמד — אל תשלמו. ' +
      'התקשרו בחזרה למוצא ותיפגשו במקום הומה אנשים.</i>',
    smsScan: (v) => `FindYpet: התג של ${v.pet} נסרק עכשיו. מי שמצא עשוי להתקשר או לכתוב בוואטסאפ. ${v.link}`,
    smsFound: (v) => `FindYpet: מצאו את ${v.pet}! המוצא נמצא כאן: ${v.maps}`,
    langAsk: '🌐 בחרו את שפת הבוט:',
    langSet: '✅ הבוט מדבר עכשיו עברית.',
    askPhoto: (v) => `📷 שלחו תמונה אחת של <b>${v.pet}</b> — שהפנים והפרווה ייראו טוב. היא תוצג בדף החיה ובכרזה במצב חיפוש.`,
    photoSaved: (v) => `✅ התמונה נשמרה — היא מוצגת עכשיו בדף של ${v.pet}.`,
    photoBad: '⚠️ שלחו את התמונה כתמונה (לא כקובץ), או לחצו ❌ ביטול.',
    photoRemoved: '🗑 התמונה הוסרה.', btnRmPhoto: '🗑 הסרת התמונה',
    share: (v) => `🚨 חיית מחמד אבודה: ${v.pet}` + (v.area ? ` · אזור: ${v.area}` : '') +
      `\nראיתם את ${v.pet}? פתחו את הדף כדי להתקשר לבעלים: ${v.link}`,
    chanLine: 'חיית מחמד אבודה. ראיתם אותה? פתחו את הדף והתקשרו לבעלים.',
    chanHome: (v) => `${v.pet} כבר בבית! תודה לכל מי שעזר ❤️`,
    cmds: {
      register: 'רישום חיית מחמד וקבלת תג', mytags: 'חיות המחמד שלי, קישורים וסטטוס',
      lost: '🚨 חיית המחמד נעלמה — הפעלת מצב חיפוש', found: '✅ חיית המחמד בבית — כיבוי מצב חיפוש',
      settings: 'איש קשר נוסף והערות למוצא', photo: '📷 תמונה של חיית המחמד בדף שלה',
      care: '💚 FindYpet Care — בקרוב', lang: '🌐 שפה · Язык · Language',
      cancel: 'ביטול הפעולה הנוכחית', help: 'עזרה',
    },
    desc: 'FindYpet — תג זיהוי חכם לחיית מחמד עם מספר הטלפון שלכם, QR ו-NFC. מי שימצא את חיית המחמד יוכל להתקשר אליכם, ' +
      'לכתוב בוואטסאפ או לשלוח מיקום — ואתם מקבלים התראה כאן ברגע שהתג נסרק. לחצו על הכפתור למטה כדי להתחיל.',
    shortDesc: 'חיית המחמד אבדה? מי שימצא יוכל להתקשר אליכם או לשלוח מיקום. ההתראות מגיעות לכאן.',
  },

  ru: {
    welcome:
      '🐾 <b>Добро пожаловать в FindYpet!</b>\n\n' +
      'Я помогаю питомцам быстро вернуться домой. На жетоне — ваш номер телефона, QR-код и NFC. ' +
      'Тот, кто найдёт питомца, сможет позвонить вам, написать в WhatsApp или отправить свою геолокацию, ' +
      'а я сразу сообщу вам здесь, как только жетон отсканируют.\n\n' +
      'Нажмите <b>Зарегистрировать питомца</b>, чтобы получить свой жетон.\n\n🌐 עברית · Русский · English — /lang',
    btnRegister: '🐾 Зарегистрировать питомца', btnMyTags: '🏷 Мои жетоны', btnLost: '🚨 Потерялся', btnSettings: '⚙️ Настройки',
    btnCancel: '❌ Отмена', btnSkip: '➡️ Пропустить', btnSharePhone: '📱 Отправить мой номер',
    askName: '👤 Как вас <b>зовут</b> (владелец питомца)?',
    askPhone:
      '📱 Ваш <b>номер телефона</b> — по нему позвонит нашедший.\n' +
      'Нажмите кнопку ниже, чтобы отправить его, или напишите (например, 050-123-4567).',
    badPhone: '⚠️ Похоже, это не номер телефона. Попробуйте ещё раз (например, 050-123-4567).',
    askPet: '🐶 Как зовут <b>питомца</b>?',
    askAddress: '🏠 Ваш <b>адрес</b> (город, улица, квартира) — туда отправим жетон. На странице питомца он никогда не показывается.',
    cancelled: 'Отменено. Отправьте /help, чтобы увидеть, что я умею.',
    notFoundToken: '⚠️ Эта ссылка для активации недействительна (или устарела).\nЗарегистрировать нового питомца можно здесь: /register',
    noTags: 'У вас пока нет зарегистрированных питомцев. Нажмите /register, чтобы добавить.',
    noKv: '⚠️ Эта функция пока не включена. Попробуйте позже.',
    help:
      '<b>Команды</b>\n' +
      '/register — зарегистрировать питомца и получить жетон\n' +
      '/mytags — ваши питомцы, ссылки и статус\n' +
      '🚨 /lost — питомец пропал: включить режим поиска\n' +
      '✅ /found — питомец дома: выключить режим поиска\n' +
      '⚙️ /settings — второй контакт и заметки для нашедшего\n' +
      '📷 /photo — фото питомца на его странице\n' +
      '💚 /care — FindYpet Care (скоро)\n' +
      '🌐 /lang — язык бота\n' +
      '/cancel — отменить текущее действие\n' +
      '/id — ваш chat ID в Telegram\n\n' +
      '✉️ Вопросы? Напишите нам здесь или на findypet0926@gmail.com',
    askArea:
      '📍 Где питомца видели в последний раз? (район или город — например, «Хайфа, Центр Кармель»)\n' +
      'Это будет на странице жетона. Нажмите <b>Пропустить</b>, если не хотите указывать.',
    askPhone2: '📞 Отправьте <b>второй номер телефона</b> (например, члена семьи). Он появится на странице питомца.',
    askNotes:
      '📝 Отправьте <b>заметки для нашедшего</b> (до 200 символов).\n' +
      'Например: «Аллергия на курицу. Боится людей — не догоняйте, позвоните мне».\n' +
      'Они появятся на странице питомца.',
    reminder:
      '🔔 <b>Небольшая проверка:</b> контакты на жетоне FindYpet всё ещё актуальны?\n' +
      'Устаревший номер — частая причина, по которой найденный питомец не возвращается домой.\n\n' +
      '/mytags — ваши жетоны · /settings — второй контакт и заметки\n' +
      'Сменился номер? Просто напишите нам здесь.',
    chatId: (v) => `Ваш chat ID: <code>${v.id}</code>`,
    useButtons: 'Пожалуйста, выберите кнопкой выше.',
    petN: (v) => `🐾 Кличка питомца №${v.n}?`,
    tapConfirm: 'Нажмите выше ✅ Подтвердить или ✏️ Заново.',
    btnConfirm: '✅ Подтвердить', btnAgain: '✏️ Заново',
    phone2Saved: (v) => `✅ Второй контакт сохранён: ${v.phone}\nТеперь он показан на странице питомца.`,
    notesSaved: (v) => `✅ Заметки сохранены:\n<i>${v.notes}</i>\nТеперь они показаны на странице питомца.`,
    tagN: (v) => `${v.n} ${ruPlural(v.n, 'жетон', 'жетона', 'жетонов')}`,
    qtyLabel: (v) => (v.tags === 1 ? `1 жетон — ${v.total}` :
      `${v.tags} ${ruPlural(v.tags, 'жетон', 'жетона', 'жетонов')}${v.free ? ` (${v.paid} + ${v.free} в подарок)` : ''} — ${v.total}`),
    askQty: (v) =>
      '🏷 <b>Сколько жетонов?</b> Оплата один раз, подписка не нужна.\n\n' +
      `• <b>1 жетон — ${v.one}</b>\n` +
      `• <b>2 жетона — ${v.two}</b>: для 2 питомцев или для питомца и запасной копии его жетона\n` +
      `• <b>${v.paid} + ${v.free} в подарок — ${v.total} за ${v.tags} жетона</b>: для 3–4 питомцев или для меньшего числа питомцев с запасными жетонами\n\n` +
      'В каждом жетоне есть всё: звонок, WhatsApp и Telegram со страницы, оповещения о скане и геолокации, ' +
      'режим поиска, второй контакт и заметки для нашедшего.',
    confirm: (v) =>
      '<b>Проверьте данные:</b>\n\n' +
      `👤 Владелец: ${v.owner}\n📱 Телефон: ${v.phone}\n` + v.items + `🏠 Адрес: ${v.address}\n💳 ${v.label} · один раз\n\n` +
      '🔒 Подтверждая, вы соглашаетесь, что ваше имя, телефон и кличка питомца будут показаны на странице питомца ' +
      'тому, кто отсканирует жетон. Адрес нужен только для доставки. ' +
      `<a href="${v.privacy}">Политика конфиденциальности</a>`,
    itemPet: (v) => `🐾 Питомец: ${v.pet}\n`,
    itemsHead: '🏷 Жетоны:\n',
    itemCopies: (v) => ` — ${v.c} ${ruPlural(v.c, 'жетон', 'жетона', 'жетонов')} (${v.c - 1} ${ruPlural(v.c - 1, 'запасной', 'запасных', 'запасных')})`,
    notLinked: '⚠️ Этот жетон не привязан к вашему Telegram.',
    phone2Removed: '🗑 Второй контакт удалён.',
    notesRemoved: '🗑 Заметки удалены.',
    expired: 'Сессия устарела. Нажмите /register, чтобы начать заново.',
    howManyPets: (v) =>
      `🏷 <b>${v.n} ${ruPlural(v.n, 'жетон', 'жетона', 'жетонов')}${v.free ? ` (${v.paid} + ${v.free} в подарок)` : ''}.</b> Сколько питомцев будут их носить?\n\n` +
      'У каждого питомца свой жетон и своя страница. Оставшиеся жетоны станут <b>запасными</b> — точной копией жетона питомца ' +
      '(та же страница и ссылка). Пригодится, если один потеряется.',
    petsBtn: (v) => (v.c === 1 ? `1 питомец: ${v.pet} (+${v.n - 1} запасн.)` :
      `${v.c} ${ruPlural(v.c, 'питомец', 'питомца', 'питомцев')}` + (v.n - v.c ? ` (+${v.n - v.c} запасн.)` : '')),
    offerChanged: (v) => `ℹ️ Наше предложение изменилось: теперь <b>${v.paid} + ${v.free} — ${v.tags} жетона за ${v.total}</b>. ` +
      'В ваш заказ добавится ещё один жетон — пожалуйста, проверьте данные ещё раз.',
    wentWrong: '⚠️ Что-то пошло не так. Попробуйте ещё раз: /register',
    spareQ: (v) => (v.spares === 1 ? '🏷 Запасной жетон — для какого питомца?' : `🏷 Запасной жетон ${v.k} из ${v.spares} — для какого питомца?`) +
      ' Это будет точная копия жетона этого питомца.',
    cantLoad: '⚠️ Не удалось загрузить ваши жетоны. Попробуйте через минуту.',
    noneLost: 'Сейчас ни один из ваших питомцев не в режиме поиска.',
    pickLost: '🚨 Какой питомец пропал?', pickFound: '✅ Какой питомец вернулся домой?', pickSet: '⚙️ Настройки какого питомца?',
    pickPhoto: '📷 Фото какого питомца?',
    lostTitle: (v) => `🚨 <b>Режим поиска: ${v.pet}</b>\n\n`,
    lostOn: (v) =>
      `🚨 <b>Режим поиска включён: ${v.pet}.</b>\n\n` +
      'Страница жетона стала красной: «Меня ищут 😢 — меня ищет семья»' + (v.area ? `, район: ${v.area}` : '') + '.\n' +
      'О каждом скане я сообщу вам сразу.\n\n' +
      '📣 <b>Перешлите это в местные группы</b> (соседи, собачники, группы поиска животных). ' +
      'Ссылка открывает объявление на иврите, русском и английском — его можно и распечатать:\n\n' + v.shares + '\n\n' +
      (v.photo ? '' : '📷 Фото пока нет — отправьте /photo: питомца узнают по фото.\n\n') +
      'Когда питомец вернётся домой, отправьте /found.',
    lostOff: (v) => `✅ Отличные новости! Режим поиска выключен — страница питомца ${v.pet} снова обычная. ❤️`,
    btnChangeP2: '📞 Изменить второй контакт', btnAddP2: '📞 Добавить второй контакт',
    btnChangeNotes: '📝 Изменить заметки', btnAddNotes: '📝 Добавить заметки для нашедшего',
    btnRmP2: '🗑 Удалить второй контакт', btnRmNotes: '🗑 Удалить заметки', btnPhoto: '📷 Фото питомца',
    settings: (v) =>
      `⚙️ <b>${v.pet} · жетон №${v.id}</b>\n\n` +
      `📱 Основной телефон: ${v.phone}\n📞 Второй контакт: ${v.p2 || '—'}\n📝 Заметки: ${v.notes ? '<i>' + v.notes + '</i>' : '—'}\n` +
      `📷 Фото: ${v.photo ? 'есть' : '—'}\n\n` +
      'Чтобы изменить основной телефон или имя, просто напишите нам здесь.',
    newReg: '📝 <b>Регистрация питомца</b>\n\n',
    regItem: (v) => `🐾 <b>${v.pet}</b> — жетон №${v.id}` +
      (v.c > 1 ? ` · ${v.c} ${ruPlural(v.c, 'жетон', 'жетона', 'жетонов')} (в т. ч. ${v.c - 1} ${ruPlural(v.c - 1, 'запасной', 'запасных', 'запасных')})` : '') + `\n🔗 ${v.link}`,
    or: ' или ',
    regOrder: (v) => `🧾 Заказ <b>${v.id}</b> · ${v.label}\n` +
      '<b>Что дальше:</b> мы свяжемся с вами, чтобы подтвердить заказ и оплату → напечатаем жетон и запишем NFC → ' +
      'отправим по вашему адресу. О каждом шаге я сообщу здесь.\n\n',
    registered: (v) =>
      `🎉 <b>${v.owner}, вы зарегистрированы в FindYpet!</b>\n\n` + v.list + '\n\n' + v.order +
      'Когда кто-то отсканирует жетон, я сообщу вам здесь, а нашедший сможет позвонить вам, написать в WhatsApp ' +
      'или оповестить вас одним касанием и отправить свою геолокацию. Не выключайте уведомления этого чата 🔔\n\n' +
      '<b>Полезные команды</b>\n' +
      '⚙️ /settings — второй контакт и заметки (аллергии, «не догоняйте меня»)\n' +
      '📷 /photo — фото на странице поможет нашедшему убедиться, что это ваш питомец\n' +
      `🚨 /lost — если ${v.names} потеряется\n` +
      '💚 /care — FindYpet Care, скоро\n' +
      '📲 Когда жетон придёт: отсканируйте QR или поднесите к нему телефон — должна открыться страница питомца.',
    btnPreview: '👀 Страница питомца', btnAddExtras: '⚙️ Второй контакт / заметки',
    useMyTags: 'Ваши жетоны всегда можно посмотреть командой /mytags.',
    orderTxt: { new: 'принят — мы с вами свяжемся', paid: 'оплачен — изготавливаем', made: 'готов — скоро отправим', shipped: 'отправлен' },
    myTagLine: (v) => `🐾 <b>${v.pet}</b> — жетон №${v.id}` + (v.lost ? '  🚨 <b>РЕЖИМ ПОИСКА</b>' : '') +
      (v.copies > 1 ? ` · ${v.copies} ${ruPlural(v.copies, 'жетон', 'жетона', 'жетонов')}` : '') + '\n' +
      (v.order ? `🧾 Заказ ${v.order}: ${v.status}\n` : '') + `🔗 ${v.link}` +
      (v.p2 ? `\n📞 Второй контакт: ${v.p2}` : '') + (v.notes ? `\n📝 ${v.notes}` : '') + (v.scan ? `\n🕒 последний скан: ${v.scan}` : ''),
    myTagsHead: '<b>Ваши жетоны</b>\n\n',
    care: (v) =>
      '💚 <b>FindYpet Care — скоро</b>\n\n' +
      `Ежемесячная программа для владельцев — планируемая цена ${v.price} в месяц за владельца, для всех ваших питомцев; отменить можно в любой момент:\n` +
      '• электронная медкарта из вашей ветклиники\n' +
      '• скидки в зоомагазинах, у грумеров и в гостиницах для животных\n' +
      '• бонусы от партнёров\n\n' +
      'Жетон полностью работает и без неё — Care это дополнение, для поиска питомца оно никогда не нужно.\n' +
      'Хотите быть среди первых? Нажмите кнопку — мы сообщим о запуске. Платить сейчас ничего не нужно.',
    careAlready: '\n\n✅ Вы уже в списке — мы напишем вам здесь.',
    btnCare: '🔔 Сообщить о запуске',
    careJoined: '✅ Готово! Мы напишем вам здесь, как только FindYpet Care запустится. Платить сейчас ничего не нужно.',
    stPaid: (v) => `💰 <b>Оплата получена — спасибо!</b>\nЗаказ ${v.id}: изготавливаем ${v.n > 1 ? 'жетоны' : 'жетон'} для: ${v.names}.`,
    stMade: (v) => `🏭 <b>${v.n > 1 ? 'Жетоны готовы' : 'Жетон готов'}</b> — ${v.n > 1 ? 'напечатаны' : 'напечатан'}, NFC записан. Скоро отправим.`,
    stShipped: (v) =>
      `📦 <b>${v.n > 1 ? 'Ваши жетоны FindYpet уже в пути' : 'Ваш жетон FindYpet уже в пути'}!</b>\nЗаказ ${v.id} → ${v.address}\n\n` +
      `<b>Когда придёт:</b>\n1️⃣ Отсканируйте QR или поднесите телефон к жетону — должна открыться страница питомца:\n${v.links}\n` +
      '2️⃣ Наденьте на ошейник.\n3️⃣ /settings — добавьте второй контакт и заметки для нашедшего.',
    scanned: (v) =>
      `👀 <b>Жетон питомца ${v.pet} только что отсканировали!</b> (${v.time})\n` +
      'Кто-то открыл страницу питомца. Вам могут позвонить, написать в WhatsApp или нажать «Сообщить хозяину» — держите телефон рядом.\n' +
      'Если нашедший поделится геолокацией, я сразу пришлю её сюда.',
    btnLostOn: '🚨 Питомец пропал — включить режим поиска', btnLostOff: '✅ Питомец дома — выключить режим поиска',
    foundHead: (v) => `🐾 <b>Питомца нашли: ${v.pet}!</b> (${v.time})\n` +
      'Нашедший сейчас рядом с питомцем и нажал «Сообщить хозяину» на странице жетона.\n',
    foundLoc: (v) => '📍 Он поделился геолокацией' + (v.acc ? ` (±${v.acc} м)` : '') + ':\n',
    foundNoLoc: 'Геолокацией он не поделился. Проверьте пропущенные звонки и WhatsApp и перезвоните.',
    maps: 'Открыть в Google Maps',
    locHead: (v) => `🚨📍 <b>Питомца нашли: ${v.pet}!</b>\nНашедший поделился геолокацией (${v.time})` +
      (v.acc ? `, точность ±${v.acc} м` : '') + '.\n\n',
    safety: '\n\n⚠️ <i>FindYpet никогда ни у кого не просит денег. Если кто-то хочет денег до того, как вы увидите питомца, — не платите. ' +
      'Перезвоните нашедшему и встречайтесь в людном месте.</i>',
    smsScan: (v) => `FindYpet: жетон питомца ${v.pet} только что отсканировали. Нашедший может позвонить или написать в WhatsApp. ${v.link}`,
    smsFound: (v) => `FindYpet: питомца ${v.pet} нашли! Нашедший здесь: ${v.maps}`,
    langAsk: '🌐 Выберите язык бота:',
    langSet: '✅ Теперь бот говорит по-русски.',
    askPhoto: (v) => `📷 Отправьте одно фото питомца <b>${v.pet}</b> — чтобы хорошо было видно морду и окрас. Оно появится на странице питомца и на объявлении в режиме поиска.`,
    photoSaved: (v) => `✅ Фото сохранено — теперь оно на странице питомца ${v.pet}.`,
    photoBad: '⚠️ Отправьте фото как изображение (не файлом) или нажмите ❌ Отмена.',
    photoRemoved: '🗑 Фото удалено.', btnRmPhoto: '🗑 Удалить фото',
    share: (v) => `🚨 Потерялся питомец: ${v.pet}` + (v.area ? ` · район: ${v.area}` : '') +
      `\nЕсли вы видели этого питомца, откройте страницу, чтобы позвонить хозяину: ${v.link}`,
    chanLine: 'Потерялся питомец. Видели его? Откройте страницу и позвоните хозяину.',
    chanHome: (v) => `${v.pet} уже дома! Спасибо всем, кто помогал ❤️`,
    cmds: {
      register: 'Зарегистрировать питомца и получить жетон', mytags: 'Мои питомцы, ссылки и статус',
      lost: '🚨 Питомец пропал — включить режим поиска', found: '✅ Питомец дома — выключить режим поиска',
      settings: 'Второй контакт и заметки для нашедшего', photo: '📷 Фото питомца на его странице',
      care: '💚 FindYpet Care — скоро', lang: '🌐 Язык · שפה · Language',
      cancel: 'Отменить текущее действие', help: 'Помощь',
    },
    desc: 'FindYpet — умный жетон для питомца с вашим номером, QR-кодом и NFC. Нашедший сможет позвонить вам, ' +
      'написать в WhatsApp или отправить геолокацию, а вы получите оповещение здесь, как только жетон отсканируют. ' +
      'Нажмите кнопку ниже, чтобы начать.',
    shortDesc: 'Питомец потерялся? Нашедший позвонит вам или пришлёт геолокацию. Оповещения — прямо здесь.',
  },
};

/** Строка «🗺 Google Maps · 🚗 Waze»; в иврите — в изоляторе, чтобы ссылки не переставлялись. */
function mapsLine(L, maps, waze) {
  return ltr(L, `🗺 <a href="${maps}">${tr(L, 'maps')}</a>  ·  🚗 <a href="${waze}">Waze</a>`);
}

/** Номер телефона внутри текста на иврите — в изоляторе (иначе «+» и части номера переставляются). */
const ltr = (L, s) => (L === 'he' && s ? iso(s) : s);

/** Текст бота на нужном языке; v — подстановки (уже экранированные). Нет перевода — английский. */
function tr(lang, key, v) {
  const L = BOT[lang] || BOT.en;
  const s = L[key] !== undefined ? L[key] : BOT.en[key];
  return typeof s === 'function' ? s(v || {}) : s;
}
/** Все варианты кнопки на трёх языках — нажатие распознаётся, даже если язык сменили. */
function isBtn(text, key) { return LANGS.some((l) => BOT[l][key] === text); }

/** Язык Telegram-клиента → наш язык. */
function tgLang(from) {
  const c = String((from && from.language_code) || '').toLowerCase().slice(0, 2);
  if (c === 'he' || c === 'iw') return 'he';
  if (['ru', 'uk', 'be', 'kk'].includes(c)) return 'ru';
  return 'en';
}
/** Язык чата: выбранный (/lang или язык заказа) → язык Telegram → английский. */
async function chatLang(env, chatId, from) {
  if (kvOn(env)) {
    try { const v = await env.FYP_KV.get(`lang:${chatId}`); if (LANGS.includes(v)) return v; } catch (e) { console.error('lang get', e); }
  }
  return tgLang(from);
}
async function setChatLang(env, chatId, lang) {
  if (!kvOn(env) || !LANGS.includes(lang)) return;
  try { await env.FYP_KV.put(`lang:${chatId}`, lang); } catch (e) { console.error('lang put', e); }
}
/** Язык владельца для оповещений (сканы, находка): выбранный в боте → язык заказа → английский. */
async function ownerLang(env, chatId, extras) {
  if (kvOn(env) && chatId) {
    try { const v = await env.FYP_KV.get(`lang:${chatId}`); if (LANGS.includes(v)) return v; } catch (e) { /* ниже — запасной вариант */ }
  }
  return LANGS.includes(extras && extras.lang) ? extras.lang : 'en';
}
/** Язык из заказа / диалога закрепляется за чатом, если его ещё не выбрали (/lang). Возвращает язык чата. */
async function keepChatLang(env, chatId, lang) {
  const want = LANGS.includes(lang) ? lang : 'en';
  if (!kvOn(env)) return want;
  try {
    const cur = await env.FYP_KV.get(`lang:${chatId}`);
    if (LANGS.includes(cur)) return cur;
    await env.FYP_KV.put(`lang:${chatId}`, want);
  } catch (e) { console.error('lang keep', e); }
  return want;
}

const REMINDER_DAYS = 180;

// ---------------------------------------------------------------
// Цены (с 07.10.2026). ЕДИНСТВЕННОЕ место, где они задаются: отсюда их берут сайт
// (/js/plans.js → const PRICING) и бот.
//  • tag    — один жетон, разовая оплата; в каждом жетоне ВСЕ функции (см. feats)
//  • bundle — акция 3 + 1: 4 жетона по цене трёх (четвёртый в подарок: для четвёртого питомца
//             или запасная копия жетона одного из питомцев). В заказе на выбор 1, 2 или 4 жетона.
//  • care   — программа «Забота», ₪ в месяц за ВЛАДЕЛЬЦА (все его питомцы). Пока НЕ продаётся — только лист ожидания
//             (/care в боте, галочка в форме заказа), пока нет сервисов и онлайн-оплаты.
// Заказы 06.10–07.10.2026 были по акции 2 + 1 (3 жетона за 98 ₪) — у них в заказе сохранены
// tags_total / free / price, поэтому они и дальше показываются как «3 tags (2 + 1) · 98 ₪».
// ---------------------------------------------------------------
const PRICING = { tag: 49, currency: '₪', bundle: 4, care: 39 };
/**
 * Сколько жетонов в заказе: 1, 2 или 4 (3 + 1). Три жетона стоят столько же, сколько четыре,
 * поэтому 3 (и больше) превращается в 3 + 1. Старая страница 2 + 1 присылала 3 — тоже 3 + 1.
 */
function normQty(n) {
  const v = Math.floor(Number(n)) || 1;
  if (v >= PRICING.bundle - 1) return PRICING.bundle;
  return v >= 2 ? 2 : 1;
}
function orderPrice(n) {
  const tags = normQty(n);
  const free = tags === PRICING.bundle ? 1 : 0;
  return { tags, free, paid: tags - free, total: (tags - free) * PRICING.tag };
}
function ils(n) { return `${n} ${PRICING.currency}`; }
function qtyLabel(n, L = 'en') {
  const p = orderPrice(n);
  return tr(L, 'qtyLabel', { ...p, total: ils(p.total) });
}
// Заказы до 06.10.2026 были по тарифам — показываем их как раньше
const LEGACY_PLANS = { basic: 'Basic · 49 ₪', smart: 'Special · 79 ₪', family: 'Family · 199 ₪' };
function orderLabel(o, L = 'en') {
  if (o && o.price) {
    const t = Number(o.tags_total) || 1, f = Number(o.free) || 0;
    const pair = L === 'he' ? iso(`${t - f} + ${f}`) : `${t - f} + ${f}`;
    return `${tr(L, 'tagN', { n: t })}${f ? ` (${pair})` : ''} · ${ils(o.price)}`;
  }
  return (o && LEGACY_PLANS[o.plan]) || '—';
}

// Функции: всё, что помогает найти питомца, входит в КАЖДЫЙ жетон — страница, звонок, WhatsApp,
// Telegram, уведомления о скане и геолокации, режим «Потерялся», второй контакт, заметки.
// «Забота» добавит отдельные сервисы (медкарта, скидки), но функции поиска никогда не закрывает.
function feats() { return { alerts: true, lost: true, extras: true }; }

// ---------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    if (!isTestSite(env)) return route(request, env, ctx);
    // Тестовый сайт: не индексируется поисковиками, на каждой странице — пометка «ТЕСТ»
    if (new URL(request.url).pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return markTestSite(await route(request, env, ctx));
  },

  // Cron Trigger (например, раз в день): напоминание проверить контакты
  async scheduled(event, env, ctx) {
    if (isTestSite(env)) return; // тестовый сайт напоминаний не рассылает
    ctx.waitUntil(sendReminders(env).catch((e) => console.error('reminders error', e)));
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // www.findy-pet.com → findy-pet.com (один адрес для людей и поисковиков)
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.toString(), 301);
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

  try {
    // ---- Telegram webhook ----
    if (path === '/telegram' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      // Отвечаем Telegram сразу, обработку делаем в фоне
      ctx.waitUntil(handleUpdate(update, env, url).catch((e) => console.error('update error', e)));
      return new Response('ok');
    }

    // ---- Одноразовая настройка бота ----
    if (path === '/setup') return await setup(env, url);

    // ---- API сайта ----
    if (path.startsWith('/api/')) {
      // Только наш сайт и только JSON: чужие страницы не могут слать запросы от имени посетителя
      const refused = checkOrigin(request, env, url);
      if (refused) return refused;
      // Лимит частоты на адрес посетителя (бинды RL_* в wrangler.toml; без них — без лимита)
      const rl = path === '/api/tag' || path === '/api/ev' ? 'RL_READ' : path === '/api/register' ? 'RL_ORDER' : 'RL_SIGNAL';
      if (await limited(env, rl, `${clientIp(request)}:${path}`)) {
        // страница жетона покажет «временная ошибка, попробуйте ещё раз», а не «жетон не найден»
        return json({ success: false, found: false, error: path === '/api/tag' ? 'temp_error' : 'rate_limited' }, env, 429);
      }
    }
    if (path === '/api/ev' && request.method === 'POST') return await apiEvent(request, env, ctx);
    if (path === '/api/register' && request.method === 'POST') return await apiRegister(request, env, url, ctx);
    if (path === '/api/tag' && request.method === 'GET') return await apiTag(url, env, ctx);
    if (path === '/api/scan' && request.method === 'POST') return await apiScan(request, env, url);
    if (path === '/api/location' && request.method === 'POST') return await apiLocation(request, env);
    if (path === '/api/found' && request.method === 'POST') return await apiFound(request, env);
    if (path.startsWith('/api/')) return json({ success: false, error: 'not_found' }, env, 404);

    // ---- QR на напечатанном медальоне: HTTPS://FINDY-PET.COM/T/101 (заглавные буквы — QR на 15 % меньше) ----
    const upper = /^\/T\/(\d{1,9})$/.exec(path);
    if (upper) return Response.redirect(`${url.origin}/t/${upper[1]}`, 301);

    // ---- Короткая ссылка /t/101 (для QR на жетоне) → та же страница метки ----
    if (/^\/t\/\d{1,9}$/.test(path)) {
      const tagReq = new Request(new URL('/tag/index.html', url.origin), request);
      const res = env.ASSETS ? await env.ASSETS.fetch(tagReq) : serveEmbedded(new URL('/tag/index.html', url.origin), env);
      return noindex(res);
    }

    // ---- Для поисковиков: robots.txt и карта сайта (лендинг на трёх языках) ----
    if (path === '/robots.txt') return new Response(robotsTxt(env, url), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    if (path === '/sitemap.xml') return new Response(sitemapXml(env, url), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });

    // ---- Объявление «Потерялся» для групп и печати ----
    const pm = /^\/p\/(\d{1,9})$/.exec(path);
    if (pm && request.method === 'GET') {
      if (await limited(env, 'RL_READ', `${clientIp(request)}:/p`)) return new Response('Too many requests', { status: 429 });
      return await posterPage(env, url, pm[1], ctx);
    }

    // ---- Фото питомца (загружено владельцем в боте, /photo) ----
    const img = /^\/img\/(\d{1,9})$/.exec(path);
    if (img && request.method === 'GET') return await servePhoto(env, img[1], url);

    // ---- Цены тарифов для сайта ----
    if (path === '/js/plans.js') {
      return new Response(`const PRICING = ${JSON.stringify(PRICING)};\n`, {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }

    // ---- Статический сайт ----
    const res = env.ASSETS ? await env.ASSETS.fetch(request) : serveEmbedded(url, env);
    return path.startsWith('/tag') ? noindex(res) : res;
  } catch (err) {
    console.error(err);
    return json({ success: false, error: 'server_error' }, env, 500);
  }
}

// ---------------------------------------------------------------
// Поисковики. Индексируются только лендинг (/, /he/, /ru/) и политика. Страницы жетонов и объявления
// закрыты заголовком noindex (их не блокируем в robots.txt — иначе поисковик не увидит noindex).
// ---------------------------------------------------------------
function noindex(res) {
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
function robotsTxt(env, url) {
  return 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /img/\nDisallow: /setup\nDisallow: /telegram\n\n' +
    `Sitemap: ${siteBase(env, url)}/sitemap.xml\n`;
}
function sitemapXml(env, url) {
  const b = siteBase(env, url);
  const alt = ['en', 'he', 'ru'].map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${b}${l === 'en' ? '/' : `/${l}/`}"/>`).join('') +
    `<xhtml:link rel="alternate" hreflang="x-default" href="${b}/"/>`;
  const u = (loc, extra = '') => `<url><loc>${loc}</loc>${extra}</url>`;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
    u(`${b}/`, alt) + u(`${b}/he/`, alt) + u(`${b}/ru/`, alt) + u(`${b}/privacy/`) + '</urlset>\n';
}

// ---------------------------------------------------------------
// Тестовый сайт (test.findy-pet.com, окружение staging в wrangler.toml).
// STAGE = "test"  → пометка «ТЕСТ» на страницах, noindex, без напоминаний по расписанию.
// TEST_DB = "1"   → жетоны хранятся в KV этого сайта, а не в Google-таблице (см. testDb).
// На рабочем сайте обе переменные не заданы, и ничего из этого не работает.
// ---------------------------------------------------------------
function isTestSite(env) { return !!(env && env.STAGE); }

const TEST_BANNER =
  '<div id="fyp-test-banner" style="background:#f59e0b;color:#1f2937;font:700 13px/1.35 system-ui,-apple-system,sans-serif;' +
  'text-align:center;padding:7px 12px;letter-spacing:.2px" dir="ltr">🧪 TEST SITE · ТЕСТОВЫЙ САЙТ — ' +
  'orders here are not real · заказы не настоящие. Рабочий сайт: <a href="https://findy-pet.com" style="color:inherit">findy-pet.com</a></div>';

async function markTestSite(res) {
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  if (!(h.get('Content-Type') || '').startsWith('text/html')) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }
  const html = (await res.text())
    .replace(/<title>/i, '<title>[TEST] ')
    .replace(/<body([^>]*)>/i, (m) => m + TEST_BANNER);
  h.delete('Content-Length');
  return new Response(html, { status: res.status, statusText: res.statusText, headers: h });
}

// ---------------------------------------------------------------
// Site API
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Воронка заказа: сайт присылает 4 события, счётчики по дням лежат в KV (ev:ГГГГ-ММ-ДД).
// Админ видит итог командой /stats. Посещения считает Cloudflare Web Analytics.
// ---------------------------------------------------------------
const EVENTS = ['plan', 'form', 'submit', 'tg'];

async function apiEvent(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const e = String(b.e || '');
  if (!EVENTS.includes(e)) return json({ success: false }, env, 400);
  const lang = ['en', 'he', 'ru'].includes(b.lang) ? b.lang : 'en';
  if (kvOn(env)) ctx.waitUntil(bumpEvent(env, e, lang));
  return json({ success: true }, env);
}

async function bumpEvent(env, e, lang) {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: env.TIMEZONE || 'Asia/Jerusalem' });
  const key = `ev:${day}`;
  try {
    const cur = (await env.FYP_KV.get(key, 'json')) || {};
    cur[e] = (cur[e] || 0) + 1;
    cur[`${e}_${lang}`] = (cur[`${e}_${lang}`] || 0) + 1;
    await env.FYP_KV.put(key, JSON.stringify(cur), { expirationTtl: 400 * 86400 });
  } catch (err) { console.error('event', err); }
}

/** /stats для админа: воронка за 7 и 30 дней. */
async function funnelStats(env) {
  if (!kvOn(env)) return 'No storage connected.';
  // 30 чтений KV за раз (лимит бесплатного плана — 50 подзапросов на вызов)
  const days = await Promise.all(Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - i * 86400000).toLocaleDateString('en-CA', { timeZone: env.TIMEZONE || 'Asia/Jerusalem' });
    return env.FYP_KV.get(`ev:${d}`, 'json').catch(() => null);
  }));
  const sum = async (n) => {
    const tot = {};
    for (const v of days.slice(0, n)) for (const k of Object.keys(v || {})) tot[k] = (tot[k] || 0) + v[k];
    return tot;
  };
  const line = (t, title) => {
    const n = (k) => t[k] || 0;
    const pct = (a, b) => (n(b) ? ` (${Math.round((n(a) / n(b)) * 100)}%)` : '');
    const langs = (k) => ['he', 'ru', 'en'].map((l) => `${l} ${n(`${k}_${l}`)}`).join(' · ');
    return `<b>${title}</b>\n` +
      `Chose a plan: ${n('plan')}  (${langs('plan')})\n` +
      `Started the form: ${n('form')}${pct('form', 'plan')}\n` +
      `Sent an order: ${n('submit')}${pct('submit', 'form')}  (${langs('submit')})\n` +
      `Opened Telegram after order: ${n('tg')}${pct('tg', 'submit')}`;
  };
  return '📊 Order funnel on the site\n\n' + line(await sum(7), 'Last 7 days') + '\n\n' + line(await sum(30), 'Last 30 days') +
    '\n\nVisits: Cloudflare dashboard → Web Analytics.';
}

async function apiRegister(request, env, url, ctx) {
  const b = await request.json().catch(() => ({}));
  const owner = cell(b.owner_name, 80);
  const pet = cell(b.pet_name, 40);
  const address = cell(b.address, 200);
  const phone = normalizePhone(b.phone);
  const phone2Raw = str(b.phone2, 30);
  const phone2 = phone2Raw ? normalizePhone(phone2Raw) : '';
  const notes = str(b.notes, 200);
  if (!owner || !pet || !address) return json({ success: false, error: 'Please fill in all fields.', error_code: 'fill' }, env, 400);
  if (!phone) return json({ success: false, error: 'Please enter a valid phone number.', error_code: 'phone' }, env, 400);
  if (phone2Raw && !phone2) return json({ success: false, error: 'Second phone is not valid.', error_code: 'phone2' }, env, 400);
  if (b.consent !== true) return json({ success: false, error: 'Consent is required.', error_code: 'consent' }, env, 400);
  // 1, 2 или 4 (3 + 1) жетона. Очень старая страница могла прислать plan — Семейный = набор.
  const qty = normQty(b.tags !== undefined ? b.tags : (b.plan === 'family' ? PRICING.bundle : 1));
  const lang = ['en', 'he', 'ru'].includes(b.lang) ? b.lang : 'en';

  const items = orderItems(qty, pet, b.pets, b.spare_for);
  // Несколько питомцев: у каждого свой второй контакт и заметки (pet_extras[i] — для i-го питомца)
  if (Array.isArray(b.pet_extras)) {
    for (let i = 0; i < items.length; i++) {
      const e = b.pet_extras[i] || {};
      const raw = str(e.phone2, 30);
      const p2 = raw ? normalizePhone(raw) : '';
      if (raw && !p2) return json({ success: false, error: 'Second phone is not valid.', error_code: 'phone2' }, env, 400);
      items[i].phone2 = p2;
      items[i].notes = str(e.notes, 200);
    }
  }
  const res = await createOrder(env, url, {
    source: 'site', qty, lang, owner_name: owner, phone, address, items, phone2, notes,
    care_interest: b.care === true,
    // 3 жетона присылала только страница 2 + 1, открытая до 07.10 (там было «98 ₪») — админ уточнит цену
    old_offer: Number(b.tags) === 3,
  });
  if (!res.ok) return json({ success: false, error: 'Database error. Please try again.', error_code: 'db' }, env, 502);
  ctx.waitUntil(Promise.all(res.tags.map((t) => cachePublic(env, t))));
  const first = res.tags[0];

  return json({
    success: true,
    order_id: res.order.order_id,
    total_tags: res.order.tags_total,
    price: res.order.price,
    tags: res.order.items.map((i) => ({ id_tag: i.tag_id, pet_name: i.pet_name, copies: i.copies, tag_url: shortUrl(env, url, i.tag_id) })),
    // первый жетон — для совместимости со старым кодом страницы
    id_tag: first.tag_id,
    tag_url: shortUrl(env, url, first.tag_id),
    telegram_link: `https://t.me/${env.BOT_USERNAME}?start=${first.link_token}`,
  }, env);
}

// ---------------------------------------------------------------
// Заказы. Один заказ = один или несколько жетонов.
// «Питомец» = своя строка в таблице (свой tag_id, своя страница и ссылка для NFC/QR).
// «Запасной жетон» = ещё одна физическая копия того же жетона (тот же tag_id и ссылка).
// Заказ хранится в KV: o:<order_id>; у каждого жетона x:<tag_id>.order_id.
// ---------------------------------------------------------------
const ORDER_STATUSES = ['new', 'paid', 'made', 'shipped'];

/** Из тарифа, первой клички, доп. кличек и «запасной для питомца №…» собираем состав заказа. */
function orderItems(qty, firstPet, morePets, spareFor) {
  const slots = normQty(qty);
  const names = [firstPet, ...(Array.isArray(morePets) ? morePets : [])]
    .map((n) => cell(n, 40)).filter(Boolean).slice(0, slots);
  const items = names.map((pet_name) => ({ pet_name, copies: 1 }));
  const spares = slots - items.length;
  const want = Array.isArray(spareFor) ? spareFor : [];
  for (let k = 0; k < spares; k++) {
    const i = Number(want[k]);
    items[Number.isInteger(i) && i >= 0 && i < items.length ? i : 0].copies++;
  }
  return items;
}

/**
 * Создаёт строки в таблице (по одной на питомца), доп. данные и заказ в KV,
 * отправляет админу один лист производства. o: { source, qty, lang, owner_name, phone,
 * address, items, phone2?, notes?, chat_id?, care_interest? }
 */
async function createOrder(env, url, o) { // + old_offer?: заказ со страницы, открытой до 3 + 1
  const tags = [];
  for (let i = 0; i < o.items.length; i++) {
    let r = await db(env, 'register', {
      owner_name: o.owner_name, phone: o.phone, pet_name: o.items[i].pet_name, address: o.address,
      telegram_chat_id: o.chat_id || undefined, tag_url_base: tagUrlBase(env, url), source: o.source,
    });
    if (!r.ok) r = await db(env, 'register', { // одна повторная попытка
      owner_name: o.owner_name, phone: o.phone, pet_name: o.items[i].pet_name, address: o.address,
      telegram_chat_id: o.chat_id || undefined, tag_url_base: tagUrlBase(env, url), source: o.source,
    });
    if (!r.ok) {
      if (!tags.length) return { ok: false };
      break; // часть жетонов создана — остальные админ создаст вручную (он увидит это в сообщении)
    }
    tags.push(r.tag);
  }
  const order_id = 'FY' + tags[0].tag_id;
  const now = new Date().toISOString();
  const items = tags.map((t, i) => ({ tag_id: String(t.tag_id), pet_name: t.pet_name || o.items[i].pet_name, copies: o.items[i].copies }));
  const missing = o.items.slice(tags.length).map((i) => i.pet_name);
  for (let i = 0; i < tags.length; i++) {
    await putExtras(env, tags[i].tag_id, {
      order_id, copies: items[i].copies, lang: o.lang || 'en',
      consent_at: now, consent_via: o.source,
      ...(() => {
        // свои данные питомца (Семейный) — иначе общий второй контакт и заметки первого питомца
        const it = o.items[i];
        const p2 = it.phone2 !== undefined ? it.phone2 : o.phone2;
        const nt = it.notes !== undefined ? it.notes : (i === 0 ? o.notes : '');
        return { ...(p2 ? { phone2: p2 } : {}), ...(nt ? { notes: nt } : {}) };
      })(),
    });
  }
  const order = {
    order_id, created_at: now, source: o.source, lang: o.lang || 'en',
    ...(() => { const pr = orderPrice(o.qty); return { tags_total: pr.tags, free: pr.free, price: pr.total }; })(),
    ...(o.care_interest ? { care_interest: true } : {}),
    ...(o.old_offer ? { old_offer: true } : {}),
    owner_name: o.owner_name, phone: o.phone, address: o.address,
    items, missing, chat_id: o.chat_id || '',
    tokens: Object.fromEntries(tags.map((t) => [String(t.tag_id), t.link_token || ''])),
    status: 'new', history: [{ status: 'new', at: now }],
  };
  await saveOrder(env, order);
  await notifyAdmin(env, url, order);
  return { ok: true, order, tags };
}

async function getOrder(env, id) {
  if (!kvOn(env) || !id) return null;
  try { return await env.FYP_KV.get(`o:${id}`, 'json'); } catch (e) { console.error('order get', e); return null; }
}
async function saveOrder(env, order) {
  if (!kvOn(env)) return;
  try { await env.FYP_KV.put(`o:${order.order_id}`, JSON.stringify(order)); } catch (e) { console.error('order put', e); }
}
function orderTagsLine(order) {
  return order.items.map((i) => `${i.pet_name} #${i.tag_id}` + (i.copies > 1 ? ` ×${i.copies}` : '')).join(', ');
}

async function apiTag(url, env, ctx) {
  const id = url.searchParams.get('id') || url.searchParams.get('id_tag') || '';
  if (!/^\d{1,9}$/.test(id)) return json({ found: false }, env);
  // Сначала — сохранённая копия из KV (мгновенно: нашедший стоит рядом с питомцем),
  // таблица (1–3 с) обновляет копию в фоне. Нет копии — ждём таблицу, как раньше.
  const [cached, extras] = await Promise.all([getCachedPublic(env, id), getExtras(env, id)]);
  if (cached && cached.found && kvOn(env)) {
    ctx.waitUntil(refreshPublic(env, id));
    return json({ ...cached, ...publicExtras(extras, id), can_notify: (!!cached.can_notify || smsEnabled(env)) && feats(extras).alerts }, env);
  }
  const r = await db(env, 'getTag', { id });
  // r.ok === false — сбой связи с базой (Google Apps Script). Это ВРЕМЕННАЯ проблема,
  // а не "метка не зарегистрирована". Сначала пробуем отдать сохранённую копию
  // страницы (номер телефона важнее всего), и только если её нет — temp_error.
  if (!r.ok) {
    if (cached) return json({ ...cached, ...publicExtras(extras, id), can_notify: !!cached.can_notify && feats(extras).alerts, stale: true }, env);
    return json({ found: false, error: 'temp_error' }, env, 502);
  }
  if (!r.found || String(r.tag.status) === 'disabled') return json({ found: false }, env);
  ctx.waitUntil(cachePublic(env, r.tag));
  const pub = publicTag(r.tag, env);
  return json({ ...pub, ...publicExtras(extras, id), can_notify: pub.can_notify && feats(extras).alerts }, env);
}

/** Фоновое обновление копии страницы из таблицы; жетон удалён или отключён — копию убираем. */
async function refreshPublic(env, id) {
  const r = await db(env, 'getTag', { id });
  if (!r.ok) return; // таблица недоступна — копия остаётся
  if (!r.found || String(r.tag.status) === 'disabled') {
    try { await env.FYP_KV.delete(`c:${id}`); } catch (e) { console.error('cache drop', e); }
    return;
  }
  await cachePublic(env, r.tag);
}

async function apiScan(request, env, url) {
  const b = await request.json().catch(() => ({}));
  const id = String(b.id_tag || b.id || '');
  if (!/^\d{1,9}$/.test(id)) return json({ success: false }, env, 400);
  const r = await db(env, 'logScan', { id });
  if (!r.ok || !r.found) return json({ success: false }, env);
  const tag = r.tag;
  if (r.throttled) return json({ success: true }, env);
  const extras = await getExtras(env, id);
  const L = await ownerLang(env, tag.telegram_chat_id, extras);

  if (tag.telegram_chat_id) {
    const kb = extras.lost
      ? [[{ text: tr(L, 'btnLostOff'), callback_data: `found:${id}` }]]
      : [[{ text: tr(L, 'btnLostOn'), callback_data: `lost:${id}` }]];
    await tg(env, 'sendMessage', {
      chat_id: tag.telegram_chat_id,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: tr(L, 'scanned', { pet: esc(tag.pet_name), time: fmtTime(env, L) }),
      reply_markup: { inline_keyboard: kb },
    });
  } else if (smsEnabled(env)) {
    await sendSms(env, tag.phone, tr(L, 'smsScan', { pet: tag.pet_name, link: shortUrl(env, url, id) }));
  }
  return json({ success: true }, env);
}

/**
 * Кнопка «Telegram» на странице жетона: бот сам пишет владельцу, что питомца нашли.
 * Если нашедший разрешил геолокацию — в том же сообщении ссылки на карту и точка.
 * Telegram ID владельца берётся из таблицы (telegram_chat_id). Повтор в течение минуты не дублирует сообщение.
 */
async function apiFound(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = String(b.id_tag || b.id || '');
  if (!/^\d{1,9}$/.test(id)) return json({ success: false, error: 'bad_request' }, env, 400);
  // не больше 3 оповещений в минуту на один жетон, с любых адресов (защита владельца от потока сообщений)
  if (await limited(env, 'RL_TAG', `tag:${id}`)) return json({ success: false, error: 'rate_limited' }, env, 429);
  const lat = Number(b.lat), lon = Number(b.lon), acc = Number(b.accuracy);
  const hasLoc = b.lat !== undefined && b.lon !== undefined && isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  // координаты нашедшего уходят только владельцу в Telegram и в таблице не хранятся
  const r = await db(env, 'logScan', { id });
  if (!r.ok) return json({ success: false, error: 'temp_error' }, env, 502);
  if (!r.found || String(r.tag.status) === 'disabled') return json({ success: false, error: 'not_found' }, env);
  const tag = r.tag;
  const extras = await getExtras(env, id);
  if (!feats(extras).alerts || !tag.telegram_chat_id) return json({ success: false, error: 'not_linked' }, env);

  const key = `f:${id}`;
  if (kvOn(env) && !hasLoc && (await env.FYP_KV.get(key))) return json({ success: true, repeat: true }, env);

  // Каждое сообщение «питомец найден» предупреждает о мошенниках (safety): такое сообщение может вызвать и мошенник
  const L = await ownerLang(env, tag.telegram_chat_id, extras);
  let text = tr(L, 'foundHead', { pet: esc(tag.pet_name), time: fmtTime(env, L) });
  if (hasLoc) {
    const maps = `https://maps.google.com/?q=${lat},${lon}`;
    const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
    text += tr(L, 'foundLoc', { acc: isFinite(acc) && acc > 0 ? Math.round(acc) : 0 }) + mapsLine(L, maps, waze);
  } else {
    text += tr(L, 'foundNoLoc');
  }
  text += tr(L, 'safety');
  const sent = await tg(env, 'sendMessage', { chat_id: tag.telegram_chat_id, parse_mode: 'HTML', disable_web_page_preview: true, text });
  if (hasLoc) await tg(env, 'sendLocation', { chat_id: tag.telegram_chat_id, latitude: lat, longitude: lon });
  if (sent && sent.ok && kvOn(env)) await env.FYP_KV.put(key, '1', { expirationTtl: 60 });
  return json({ success: !!(sent && sent.ok) }, env);
}

async function apiLocation(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = String(b.id_tag || b.id || '');
  const lat = Number(b.lat), lon = Number(b.lon);
  const acc = Number(b.accuracy);
  if (!/^\d{1,9}$/.test(id) || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ success: false, error: 'bad_request' }, env, 400);
  }
  if (await limited(env, 'RL_TAG', `tag:${id}`)) return json({ success: false, error: 'rate_limited' }, env, 429);
  const r = await db(env, 'logScan', { id }); // координаты в таблицу не пишем — только владельцу
  if (!r.ok) return json({ success: false, error: 'temp_error' }, env, 502);
  if (!r.found || String(r.tag.status) === 'disabled') return json({ success: false, error: 'not_found' }, env);
  const tag = r.tag;
  const L = await ownerLang(env, tag.telegram_chat_id, await getExtras(env, id));

  const maps = `https://maps.google.com/?q=${lat},${lon}`;
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

  if (!tag.telegram_chat_id) {
    if (smsEnabled(env)) {
      const ok = await sendSms(env, tag.phone, tr(L, 'smsFound', { pet: tag.pet_name, maps }));
      return json({ success: ok }, env);
    }
    return json({ success: false, error: 'not_linked' }, env);
  }

  const sent = await tg(env, 'sendMessage', {
    chat_id: tag.telegram_chat_id,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text:
      tr(L, 'locHead', { pet: esc(tag.pet_name), time: fmtTime(env, L), acc: isFinite(acc) && acc > 0 ? Math.round(acc) : 0 }) +
      mapsLine(L, maps, waze) + tr(L, 'safety'),
  });
  await tg(env, 'sendLocation', { chat_id: tag.telegram_chat_id, latitude: lat, longitude: lon });
  if (!(sent && sent.ok) && smsEnabled(env)) {
    // Telegram не доставил (бот заблокирован и т.п.) → резерв SMS
    const ok = await sendSms(env, tag.phone, tr(L, 'smsFound', { pet: tag.pet_name, maps }));
    return json({ success: ok }, env);
  }
  return json({ success: !!(sent && sent.ok) }, env);
}

function publicTag(t, env) {
  const phone = normalizePhone(t.phone);
  return {
    found: true,
    tag_id: t.tag_id,
    pet_name: t.pet_name || '',
    owner_name: String(t.owner_name || '').split(' ')[0],
    phone,
    phone_display: prettyPhone(phone),
    can_notify: !!String(t.telegram_chat_id || '').trim() || smsEnabled(env || {}),
  };
}

/** Публичная часть доп. данных (то, что владелец разрешил показывать). */
function publicExtras(x, id) {
  x = x || {};
  if (!feats(x).extras) x = {};
  const phone2 = normalizePhone(x.phone2);
  return {
    photo: x.photo_v && id ? `/img/${id}?v=${x.photo_v}` : '',
    lost: !!x.lost,
    lost_since: x.lost ? (x.lost_since || '') : '',
    lost_area: x.lost ? (x.lost_area || '') : '',
    phone2,
    phone2_display: phone2 ? prettyPhone(phone2) : '',
    notes: x.notes || '',
  };
}

// ---------------------------------------------------------------
// KV: доп. данные метки и резервный кэш страницы
// ---------------------------------------------------------------
function kvOn(env) { return !!(env && env.FYP_KV); }

async function getExtras(env, id) {
  if (!kvOn(env)) return {};
  try { return (await env.FYP_KV.get(`x:${id}`, 'json')) || {}; } catch (e) { console.error('kv get', e); return {}; }
}

async function putExtras(env, id, patch) {
  if (!kvOn(env)) return false;
  try {
    const cur = await getExtras(env, id);
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    await env.FYP_KV.put(`x:${id}`, JSON.stringify(next));
    return next;
  } catch (e) { console.error('kv put', e); return false; }
}

/** Сохраняем публичную карточку, чтобы страница метки открылась даже при сбое таблицы. */
async function cachePublic(env, tag) {
  const data = publicTag(tag, env);
  const body = JSON.stringify(data);
  try {
    if (kvOn(env)) await env.FYP_KV.put(`c:${tag.tag_id}`, body);
    else if (typeof caches !== 'undefined') {
      await caches.default.put(`https://fyp-cache.internal/c/${tag.tag_id}`,
        new Response(body, { headers: { 'Cache-Control': 'max-age=2592000' } }));
    }
  } catch (e) { console.error('cache put', e); }
}

async function getCachedPublic(env, id) {
  try {
    if (kvOn(env)) return await env.FYP_KV.get(`c:${id}`, 'json');
    if (typeof caches !== 'undefined') {
      const res = await caches.default.match(`https://fyp-cache.internal/c/${id}`);
      if (res) return await res.json();
    }
  } catch (e) { console.error('cache get', e); }
  return null;
}

async function rememberChat(env, chatId) {
  if (!kvOn(env)) return;
  try {
    const key = `chat:${chatId}`;
    if (!(await env.FYP_KV.get(key))) {
      await env.FYP_KV.put(key, JSON.stringify({ since: new Date().toISOString(), last_reminder: new Date().toISOString() }));
    }
  } catch (e) { console.error('rememberChat', e); }
}

async function sendReminders(env) {
  if (!kvOn(env)) return;
  const now = Date.now();
  let cursor;
  do {
    const page = await env.FYP_KV.list({ prefix: 'chat:', cursor });
    for (const k of page.keys) {
      const rec = (await env.FYP_KV.get(k.name, 'json')) || {};
      const last = Date.parse(rec.last_reminder || rec.since || 0) || 0;
      if (now - last < REMINDER_DAYS * 86400000) continue;
      const chatId = k.name.slice(5);
      const L = await ownerLang(env, chatId);
      const res = await send(env, chatId, tr(L, 'reminder'), mainMenu(L));
      rec.last_reminder = new Date().toISOString();
      if (!res.ok) rec.failed = (rec.failed || 0) + 1;
      await env.FYP_KV.put(k.name, JSON.stringify(rec));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// ---------------------------------------------------------------
// SMS-резерв (Twilio). Включается, только если заданы TWILIO_*.
// ---------------------------------------------------------------
function smsEnabled(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

async function sendSms(env, to, body) {
  const phone = normalizePhone(to);
  if (!smsEnabled(env) || !phone) return false;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: env.TWILIO_FROM, Body: body.slice(0, 600) }),
    });
    if (!res.ok) console.error('SMS error', res.status, (await res.text()).slice(0, 300));
    return res.ok;
  } catch (e) {
    console.error('SMS failed', e);
    return false;
  }
}

// ---------------------------------------------------------------
// Telegram bot. Язык ответов — L (см. chatLang): /lang → язык заказа на сайте → язык Telegram → английский.
// ---------------------------------------------------------------
async function handleUpdate(update, env, url) {
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
      inline_keyboard: [[{ text: tr(L, 'btnPreview'), url: shortUrl(env, url, st.tag_id) }]],
    });
    return send(env, chatId, tr(L, 'useMyTags'), mainMenu(L));
  }
  // режим «Потерялся»: где видели в последний раз
  if (st.step === 'lost_area') {
    const area = isBtn(text, 'btnSkip') ? '' : str(text, 80);
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

function askQty(env, chatId, L) {
  const b = orderPrice(PRICING.bundle);
  return send(env, chatId,
    tr(L, 'askQty', { one: ils(orderPrice(1).total), two: ils(orderPrice(2).total), paid: b.paid, free: b.free, total: ils(b.total), tags: b.tags }),
    { inline_keyboard: [1, 2, PRICING.bundle].map((n) => [{ text: qtyLabel(n, L), callback_data: `qty_${n}` }]) });
}

function confirmMessage(env, chatId, st, url, L) {
  return send(env, chatId,
    tr(L, 'confirm', {
      owner: esc(st.owner_name), phone: ltr(L, esc(prettyPhone(st.phone))), items: itemsText(st, L), address: esc(st.address),
      label: esc(qtyLabel(st.slots || 1, L)), privacy: `${esc(siteBase(env, url))}/privacy/?lang=${L}`,
    }),
    { inline_keyboard: [[{ text: tr(L, 'btnConfirm'), callback_data: 'reg_ok' }, { text: tr(L, 'btnAgain'), callback_data: 'reg_again' }]] });
}

async function handleCallback(cq, env, url) {
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
  const m = /^(lost|found|set|set2|clr|pho):(\d{1,9})(?::(phone2|notes|photo))?$/.exec(data);
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
async function afterFamilyPets(env, chatId, st, url, L) {
  st.spare_for = [];
  return askSpareOrConfirm(env, chatId, st, url, L);
}
async function askSpareOrConfirm(env, chatId, st, url, L) {
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

function itemsText(st, L) {
  const items = orderItems(st.slots || 1, st.pet_name, (st.pets || []).slice(1), st.spare_for);
  if (items.length === 1 && items[0].copies === 1) return tr(L, 'itemPet', { pet: esc(items[0].pet_name) });
  return tr(L, 'itemsHead') + items.map((i) => `   • ${esc(i.pet_name)}` + (i.copies > 1 ? tr(L, 'itemCopies', { c: i.copies }) : '')).join('\n') + '\n';
}

/** Выбор метки для действия (q — ключ текста вопроса). Если метка одна — действие сразу. */
async function pickTag(chatId, env, action, q, L, filter) {
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

async function ownedTag(chatId, id, env) {
  const r = await db(env, 'listByChat', { chat_id: chatId });
  const tags = (r.ok && r.tags) || [];
  return tags.find((t) => String(t.tag_id) === String(id)) || null;
}

async function turnLostOn(chatId, id, area, env, url, L) {
  const tag = await ownedTag(chatId, id, env);
  if (!tag) return send(env, chatId, tr(L, 'notLinked'), mainMenu(L));
  const since = new Date().toISOString();
  const x = await putExtras(env, id, { lost: true, lost_since: since, lost_area: area });
  if (!x) return send(env, chatId, tr(L, 'noKv'), mainMenu(L));
  const poster = posterUrl(env, url, id);
  // Текст для групп — на трёх языках (сначала язык владельца). Ссылка — на объявление /p/:
  // открытие объявления не считается сканом жетона и не будит владельца уведомлением.
  const order = [L, ...['he', 'ru', 'en'].filter((l) => l !== L)];
  const flag = { he: '🇮🇱', ru: '🇷🇺', en: '🇬🇧' };
  const shares = order.map((l) => `${flag[l]} <code>${esc(tr(l, 'share', { pet: tag.pet_name, area, link: poster }))}</code>`).join('\n\n');

  // Публикация в канал сообщества (если настроен) — на трёх языках
  if (env.LOST_CHANNEL_ID) {
    const post = await tg(env, 'sendMessage', {
      chat_id: env.LOST_CHANNEL_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      text:
        `🚨 <b>${esc(tag.pet_name)}</b>\n` +
        ['he', 'ru', 'en'].map((l) => `${flag[l]} ${tr(l, 'chanLine')}`).join('\n') + '\n\n' +
        (area ? `📍 ${esc(area)}\n` : '') +
        `🕒 ${fmtTime(env, 'en')}\n` +
        esc(poster),
    });
    if (post && post.ok) await putExtras(env, id, { channel_msg_id: post.result.message_id });
  }

  await send(env, chatId, tr(L, 'lostOn', { pet: esc(tag.pet_name), area: esc(area), shares, photo: !!x.photo_v }), mainMenu(L));
}

async function turnLostOff(chatId, tag, env, L) {
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
  return send(env, chatId, tr(L, 'lostOff', { pet: esc(tag.pet_name) }), mainMenu(L));
}

async function settingsMenu(chatId, tag, env, L) {
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

async function startRegistration(chatId, from, env, L) {
  await db(env, 'setState', { chat_id: chatId, state: { step: 'name' } });
  const first = from.from && from.from.first_name ? from.from.first_name : '';
  const kb = first
    ? { keyboard: [[{ text: first }], [{ text: tr(L, 'btnCancel') }]], resize_keyboard: true, one_time_keyboard: true }
    : cancelKb(L);
  return send(env, chatId, tr(L, 'newReg') + tr(L, 'askName'), kb);
}

/** Пользователь зарегистрировался на сайте и нажал Start по ссылке t.me/Bot?start=<token> */
async function linkFromSite(chatId, token, env, url, from) {
  const L0 = await chatLang(env, chatId, from);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return send(env, chatId, tr(L0, 'notFoundToken'), mainMenu(L0));
  const r = await db(env, 'linkTelegram', { token, chat_id: chatId });
  if (!r.ok || !r.found) return send(env, chatId, tr(L0, 'notFoundToken'), mainMenu(L0));
  await rememberChat(env, chatId);
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
  // бот говорит на языке, на котором оформлен заказ на сайте (если язык ещё не выбран через /lang)
  const L = await keepChatLang(env, chatId, (order && order.lang) || x.lang || L0);
  await Promise.all(tags.map((t) => cachePublic(env, t)));
  return sendRegistered(chatId, tags, env, url, order, L);
}

async function sendRegistered(chatId, tagsIn, env, url, order, L) {
  const tags = Array.isArray(tagsIn) ? tagsIn : [tagsIn];
  const first = tags[0];
  const copies = (id) => { const it = order && order.items.find((i) => i.tag_id === String(id)); return it ? it.copies : 1; };
  const list = tags.map((t) => tr(L, 'regItem', {
    pet: esc(t.pet_name), id: t.tag_id, c: copies(t.tag_id), link: esc(shortUrl(env, url, t.tag_id)),
  })).join('\n\n');
  const nm = tags.map((t) => esc(t.pet_name));
  const names = nm.length > 1 ? nm.slice(0, -1).join(', ') + tr(L, 'or') + nm[nm.length - 1] : nm[0];
  await send(env, chatId,
    tr(L, 'registered', {
      owner: esc(first.owner_name), list, names,
      order: order ? tr(L, 'regOrder', { id: order.order_id, label: esc(orderLabel(order, L)) }) : '',
    }),
    { inline_keyboard: [
      [{ text: tr(L, 'btnPreview'), url: shortUrl(env, url, first.tag_id) }],
      [{ text: tr(L, 'btnAddExtras'), callback_data: `set:${first.tag_id}` }],
    ] });
  return send(env, chatId, tr(L, 'useMyTags'), mainMenu(L));
}

async function myTags(chatId, env, url, L) {
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
      link: esc(shortUrl(env, url, t.tag_id)),
      p2: x.phone2 ? ltr(L, esc(prettyPhone(normalizePhone(x.phone2)))) : '', notes: x.notes ? esc(x.notes) : '',
      scan: t.last_scan_at ? esc(t.last_scan_at) : '',
    });
  }));
  return send(env, chatId, tr(L, 'myTagsHead') + lines.join('\n\n') + `\n\n${LRM}/settings · ${LRM}/photo · ${LRM}/lost · ${LRM}/found`, mainMenu(L));
}

/** «Забота»: описание и кнопка «Сообщите о запуске». */
async function careInfo(chatId, env, L) {
  const on = kvOn(env) && (await env.FYP_KV.get(`care:${chatId}`));
  return send(env, chatId, tr(L, 'care', { price: ils(PRICING.care) }) + (on ? tr(L, 'careAlready') : ''),
    on ? mainMenu(L) : { inline_keyboard: [[{ text: tr(L, 'btnCare'), callback_data: 'care_yes' }]] });
}

/** Записать в лист ожидания «Заботы» и сообщить админу (сколько всего желающих). */
async function careJoin(chatId, env, from, L) {
  if (!kvOn(env)) return send(env, chatId, tr(L, 'noKv'), mainMenu(L));
  const key = `care:${chatId}`;
  if (!(await env.FYP_KV.get(key))) {
    const name = from ? [from.first_name, from.last_name].filter(Boolean).join(' ') : '';
    await env.FYP_KV.put(key, JSON.stringify({ since: new Date().toISOString(), name, lang: L }));
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

// ---------------------------------------------------------------
// Фото питомца (/photo): берём из Telegram, храним в KV img:<tag_id>, отдаём по /img/<tag_id>?v=…
// Показывается на странице жетона и на объявлении «Потерялся» (/p/<tag_id>).
// ---------------------------------------------------------------
const PHOTO_MAX = 1_500_000; // байт; Telegram сам сжимает фото до ~100–300 КБ

async function savePhoto(env, tagId, sizes) {
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

async function deletePhoto(env, tagId) {
  if (!kvOn(env)) return;
  try { await env.FYP_KV.delete(`img:${tagId}`); } catch (e) { console.error('photo delete', e); }
  await putExtras(env, tagId, { photo_v: '' });
}

async function servePhoto(env, id, url) {
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

function langKb() {
  return { inline_keyboard: [[
    { text: '🇮🇱 עברית', callback_data: 'lang_he' },
    { text: '🇷🇺 Русский', callback_data: 'lang_ru' },
    { text: '🇬🇧 English', callback_data: 'lang_en' },
  ]] };
}

function isAdmin(env, chatId) { return !!env.ADMIN_CHAT_ID && String(chatId) === String(env.ADMIN_CHAT_ID); }

const STATUS_LABEL = { new: '🆕 New', paid: '💰 Paid', made: '🏭 Made', shipped: '📦 Shipped' };

/** Лист производства: по одному блоку на каждый физический жетон + кнопки статуса. */
async function notifyAdmin(env, url, order) {
  if (!env.ADMIN_CHAT_ID) return;
  const total = order.items.reduce((n, i) => n + i.copies, 0);
  const phonePrint = prettyPhone(normalizePhone(order.phone)).replace('+972 ', '0');
  let k = 0;
  const blocks = [];
  for (const it of order.items) {
    const short = shortUrl(env, url, it.tag_id);
    const qr = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=8&data=${encodeURIComponent(short)}`;
    for (let c = 0; c < it.copies; c++) {
      k++;
      blocks.push(c === 0
        ? `🏷 <b>Tag ${k} of ${total} — #${it.tag_id}</b>\n` +
          `🖨 Lid: <b>${esc(String(it.pet_name).toUpperCase())}</b> · ${esc(phonePrint)}\n` +
          `<code>python3 medallion_v2.py lid ${it.tag_id} "${esc(String(it.pet_name).toUpperCase().replace(/"/g, ''))}" ${esc(phonePrint)}</code>\n` +
          `✍️ NFC + 🔳 QR: <code>${esc(short)}</code>\n<a href="${esc(qr)}">Download QR image</a>`
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

async function setOrderStatus(env, url, adminChat, orderId, status) {
  const order = await getOrder(env, orderId);
  if (!order) return send(env, adminChat, `⚠️ Order ${orderId} not found.`);
  if (order.status === status) return send(env, adminChat, `Order ${orderId} is already ${STATUS_LABEL[status]}.`);
  order.status = status;
  order.history = [...(order.history || []), { status, at: new Date().toISOString() }];
  await saveOrder(env, order);

  const names = order.items.map((i) => esc(i.pet_name)).join(', ');
  const total = order.items.reduce((n, i) => n + i.copies, 0);
  const links = order.items.map((i) => `🐾 ${esc(i.pet_name)}: ${esc(shortUrl(env, url, i.tag_id))}`).join('\n');
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

async function listOrders(env, chatId) {
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

// ---------------------------------------------------------------
// One-time setup: webhook, commands, descriptions
// ---------------------------------------------------------------
async function setup(env, url) {
  if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const results = {};
  results.setWebhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/telegram`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  // Меню команд и описание бота: английский — по умолчанию, иврит и русский — для Telegram на этих языках
  for (const l of LANGS) {
    const lc = l === 'en' ? {} : { language_code: l };
    const sfx = l === 'en' ? '' : `_${l}`;
    const c = tr(l, 'cmds');
    results[`setMyCommands${sfx}`] = await tg(env, 'setMyCommands', {
      ...lc,
      commands: ['register', 'mytags', 'lost', 'found', 'settings', 'photo', 'care', 'lang', 'cancel', 'help']
        .map((command) => ({ command, description: c[command] })),
    });
    results[`setMyDescription${sfx}`] = await tg(env, 'setMyDescription', { ...lc, description: tr(l, 'desc') });
    results[`setMyShortDescription${sfx}`] = await tg(env, 'setMyShortDescription', { ...lc, short_description: tr(l, 'shortDesc') });
  }
  results.webhookInfo = await tg(env, 'getWebhookInfo', {});
  results.db = await db(env, 'getTag', { id: '0' }).catch((e) => ({ ok: false, error: String(e) }));
  results.kv = kvOn(env) ? 'FYP_KV connected ✅' : 'FYP_KV NOT connected — /lost, /settings and backup cache are off';
  results.rate_limits = ['RL_READ', 'RL_SIGNAL', 'RL_ORDER', 'RL_TAG'].map((n) => `${n} ${env[n] && typeof env[n].limit === 'function' ? '✅' : '❌'}`).join(' · ');
  results.lostChannel = env.LOST_CHANNEL_ID ? `posting to ${env.LOST_CHANNEL_ID}` : 'not set (optional)';
  results.sms = smsEnabled(env) ? 'SMS fallback on' : 'SMS fallback off (optional)';
  return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// ---------------------------------------------------------------
// Объявление «Потерялся»: /p/101. Иврит, русский и английский сразу (группы смешанные, плакат печатают),
// фото, район, большая кнопка «Позвонить», WhatsApp, QR-код на это же объявление, печать A4.
// Открытие объявления НЕ считается сканом жетона: владельца не будят уведомлениями из групп.
// Питомец уже дома — номер телефона не показываем, только «Спасибо всем».
// ---------------------------------------------------------------
const POSTER_TXT = {
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
const tri = (k, sep = ' · ') => ['he', 'ru', 'en'].map((l) => POSTER_TXT[k][l]).join(sep);
const triHtml = (k, cls = '') => ['he', 'ru', 'en']
  .map((l) => `<span lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}"${cls ? ` class="${cls}"` : ''}>${esc(POSTER_TXT[k][l])}</span>`).join('');

async function posterPage(env, url, id, ctx) {
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
  const self = posterUrl(env, url, id);
  const pet = pub.pet_name || '';
  const lost = !!x.lost;
  const photo = x.photo_v ? `/img/${id}?v=${x.photo_v}` : '';
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

function posterShell(title, meta, body) {
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
const QR_ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // кодовых слов коррекции на блок
const QR_BLK_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]; // блоков

function qrRawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const a = Math.floor(v / 7) + 2;
    r -= (25 * a - 10) * a - 55;
    if (v >= 7) r -= 36;
  }
  return r;
}
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(deg) {
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
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

function qrMatrix(text) {
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
function qrSvg(text, color = '#111') {
  const m = qrMatrix(text), size = m.length, q = 4;
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = size + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges" role="img" aria-label="QR">` +
    `<rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="${color}"/></svg>`;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
async function db(env, action, data = {}) {
  if (env.TEST_DB === '1' || env.TEST_DB === true) return testDb(env, action, data);
  // Таймаут: если Google Apps Script завис (бывает при пиковой нагрузке на
  // бесплатной квоте), не заставляем прохожего у метки ждать бесконечно —
  // через 9 секунд отдаём явную "временную" ошибку (и страница берёт кэш).
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: env.GAS_KEY, action, ...data }),
      redirect: 'follow',
      signal: ac.signal,
    });
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      console.error('DB non-JSON response', res.status, txt.slice(0, 300));
      return { ok: false, error: 'db_bad_response' };
    }
  } catch (err) {
    console.error('DB request failed', action, String(err && err.message || err));
    return { ok: false, error: 'db_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Тестовая база (только тестовый сайт, TEST_DB = "1"): те же действия, что у Apps Script,
 * но жетоны хранятся в KV тестового сайта. Настоящая Google-таблица не затрагивается.
 * Номера тестовых жетонов начинаются с 9001, чтобы их нельзя было спутать с настоящими.
 * Ключи: db:seq — последний номер, db:t:<id> — жетон, db:tok:<token> → id,
 *        db:chat:<chat_id> — номера жетонов чата, db:st:<chat_id> — шаг диалога с ботом.
 */
async function testDb(env, action, d) {
  const kv = env.FYP_KV;
  if (!kv) return { ok: false, error: 'no_kv' };
  const getT = (id) => kv.get(`db:t:${id}`, 'json');
  const putT = (t) => kv.put(`db:t:${t.tag_id}`, JSON.stringify(t));
  const chatIds = async (c) => (await kv.get(`db:chat:${c}`, 'json')) || [];
  const addToChat = async (c, id) => {
    const ids = await chatIds(c);
    if (!ids.includes(String(id))) { ids.push(String(id)); await kv.put(`db:chat:${c}`, JSON.stringify(ids)); }
  };
  switch (action) {
    case 'register': {
      const id = String((Number(await kv.get('db:seq')) || 9000) + 1);
      await kv.put('db:seq', id);
      const t = {
        tag_id: id, owner_name: d.owner_name || '', phone: d.phone || '', pet_name: d.pet_name || '',
        address: d.address || '', telegram_chat_id: d.telegram_chat_id ? String(d.telegram_chat_id) : '',
        status: 'active', link_token: crypto.randomUUID().replace(/-/g, '').slice(0, 24),
        source: d.source || '', created_at: new Date().toISOString(), tag_url: (d.tag_url_base || '') + id,
      };
      await putT(t);
      await kv.put(`db:tok:${t.link_token}`, id);
      if (t.telegram_chat_id) await addToChat(t.telegram_chat_id, id);
      return { ok: true, tag: t };
    }
    case 'getTag': {
      const t = await getT(d.id);
      return t ? { ok: true, found: true, tag: t } : { ok: true, found: false };
    }
    case 'logScan': {
      const t = await getT(d.id);
      if (!t) return { ok: true, found: false };
      const now = Date.now();
      const throttled = !d.lat && now - (Date.parse(t.last_scan_at || '') || 0) < 60000; // повторный скан в течение минуты
      t.last_scan_at = new Date(now).toISOString();
      t.scans = (Number(t.scans) || 0) + 1;
      await putT(t);
      return { ok: true, found: true, tag: t, throttled };
    }
    case 'linkTelegram': {
      const id = await kv.get(`db:tok:${d.token}`);
      const t = id && (await getT(id));
      if (!t) return { ok: true, found: false };
      t.telegram_chat_id = String(d.chat_id);
      await putT(t);
      await addToChat(d.chat_id, t.tag_id);
      return { ok: true, found: true, tag: t };
    }
    case 'listByChat': {
      const tags = (await Promise.all((await chatIds(d.chat_id)).map(getT)))
        .filter((t) => t && String(t.telegram_chat_id) === String(d.chat_id));
      return { ok: true, tags };
    }
    case 'getState': return { ok: true, state: (await kv.get(`db:st:${d.chat_id}`, 'json')) || null };
    case 'setState': await kv.put(`db:st:${d.chat_id}`, JSON.stringify(d.state)); return { ok: true };
    case 'clearState': await kv.delete(`db:st:${d.chat_id}`); return { ok: true };
  }
  return { ok: false, error: 'unknown_action' };
}

async function tg(env, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.error('TG error', method, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('TG fetch failed', method, e);
    return { ok: false };
  }
}

function send(env, chatId, text, replyMarkup) {
  const p = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) p.reply_markup = replyMarkup;
  return tg(env, 'sendMessage', p);
}

function mainMenu(L = 'en') {
  return {
    keyboard: [[{ text: tr(L, 'btnRegister') }, { text: tr(L, 'btnMyTags') }], [{ text: tr(L, 'btnLost') }, { text: tr(L, 'btnSettings') }]],
    resize_keyboard: true,
  };
}
function cancelKb(L = 'en') {
  return { keyboard: [[{ text: tr(L, 'btnCancel') }]], resize_keyboard: true };
}

function siteBase(env, url) {
  return (env.SITE_URL || (url ? url.origin : '')).replace(/\/+$/, '');
}

/** Длинная ссылка — её пишут в NFC (старые метки продолжают работать). */
function tagUrlBase(env, url) {
  return `${siteBase(env, url)}/tag/?id=`;
}

/** Короткая ссылка для QR и сообщений: /t/101 */
function shortUrl(env, url, id) {
  return `${siteBase(env, url)}/t/${id}`;
}

/** Объявление «Потерялся» для групп и печати: /p/101 (открытие не считается сканом жетона) */
function posterUrl(env, url, id) {
  return `${siteBase(env, url)}/p/${id}`;
}

/** Приводит номер к формату +972XXXXXXXXX. Возвращает '' если номер некорректный. */
function normalizePhone(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (/e\+?\d/i.test(s) && isFinite(Number(s))) s = String(Math.round(Number(s))); // 5.0E8 из таблицы
  let d = s.replace(/[^\d+]/g, '');
  const plus = d.startsWith('+');
  d = d.replace(/\D/g, '');
  if (!d) return '';
  if (plus) return d.length >= 8 && d.length <= 15 ? '+' + d : '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('972')) { /* already international */ }
  else if (d.startsWith('0')) d = '972' + d.slice(1);
  else if (d.length === 8 || d.length === 9) d = '972' + d; // 50xxxxxxx без нуля
  return d.length >= 8 && d.length <= 15 ? '+' + d : '';
}

function prettyPhone(p) {
  let m = /^\+972(5\d)(\d{3})(\d{4})$/.exec(p);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  m = /^\+972(\d)(\d{3})(\d{4})$/.exec(p);
  if (m) return `+972 ${m[1]}-${m[2]}-${m[3]}`;
  return p;
}

const LOCALES = { en: 'en-GB', he: 'he-IL', ru: 'ru-RU' };
function fmtTime(env, L = 'en') {
  return new Date().toLocaleString(LOCALES[L] || 'en-GB', {
    timeZone: env.TIMEZONE || 'Asia/Jerusalem', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Текст, который уходит в Google-таблицу: не начинается с = + - @ (иначе таблица считает его формулой). */
function cell(v, max) {
  return str(v, max + 10).replace(/^[=+\-@\s]+/, '').slice(0, max);
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** true — лимит исчерпан. Бинд не настроен или сломался — пропускаем запрос (сайт важнее лимита). */
async function limited(env, binding, key) {
  const rl = env && env[binding];
  if (!rl || typeof rl.limit !== 'function') return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch (e) {
    console.error('ratelimit', binding, e);
    return false;
  }
}

/** POST в API принимаем только как JSON и только со своих страниц (findy-pet.com, тестовый сайт, workers.dev). */
function checkOrigin(request, env, url) {
  if (request.method !== 'POST') return null;
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return json({ success: false, error: 'bad_content_type' }, env, 415);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin && origin !== siteBase(env, url)) {
    return json({ success: false, error: 'forbidden_origin' }, env, 403);
  }
  return null;
}

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || env.SITE_URL || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, env, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env) },
  });
}

// ---------------------------------------------------------------
// Встроенный сайт (для версии "один файл", вставляемой в редактор Cloudflare).
// В обычной версии (wrangler + папка site) EMBEDDED = null и сайт отдаёт env.ASSETS.
// ---------------------------------------------------------------
const EMBEDDED = /*__EMBEDDED__*/null;

function serveEmbedded(url, env) {
  if (!EMBEDDED) return new Response('FindYpet API is running', { headers: cors(env) });
  let p = url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  let f = EMBEDDED[p];
  if (!f && EMBEDDED[p + '/index.html']) {
    return Response.redirect(url.origin + p + '/' + url.search, 301);
  }
  if (!f) return new Response('Not found', { status: 404 });
  const body = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.text;
  return new Response(body, {
    headers: { 'Content-Type': f.type, 'Cache-Control': p.endsWith('.html') ? 'no-cache' : 'public, max-age=300' },
  });
}

// экспорт для тестов
export const _test = { normalizePhone, prettyPhone, publicTag, publicExtras, PRICING, orderPrice, orderItems, feats, BOT, tr, qrMatrix };
