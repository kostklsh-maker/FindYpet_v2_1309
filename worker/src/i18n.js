import { askQty } from './bot.js';
import { qtyLabel } from './pricing.js';
import { kvOn } from './store.js';
// ---------------------------------------------------------------
// Тексты бота на трёх языках (EN / HE / RU). Язык чата: /lang → язык заказа на сайте →
// язык Telegram (language_code) → английский. Значения в функциях уже экранированы (esc) вызывающим кодом.
// В иврите перед /командами стоит невидимая метка LRM (‎), а «3 + 1» обёрнуто в изоляторы
// (⁦…⁩), чтобы цифры и косая черта не переворачивались.
// Сообщения админу (лист производства, /orders, /stats) остаются по-английски.
// ---------------------------------------------------------------
export const LANGS = ['en', 'he', 'ru'];
export const LRM = '‎';
export const iso = (t) => '\u2066' + t + '\u2069'; // изолятор: «3 + 1» и номера не переворачиваются в иврите
export const ruPlural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b >= 2 && b <= 4 ? few : many;
};

export const BOT = {
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
    queuedWait: (v) => '⏳ We got your order for <b>' + v.pet + '</b>. Our system was busy, so it is being finished automatically. ' +
      'When it is done, the confirmation and the tag link will come right here. You don\'t need to do anything.',
    queuedFail: (v) => '⚠️ We could not finish your order for <b>' + v.pet + '</b> automatically. Nothing is lost: we will call you soon to complete it.',
    tokenUsed: '⚠️ This activation link has already been used by another Telegram account. ' +
      'If that was you on another device, write to us here and we will move the tag to this chat.',
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
      '🗑 /delete — delete your data\n' +
      '/cancel — cancel the current action\n' +
      '/id — show your Telegram chat ID\n\n' +
      '✉️ Questions? Write to us here or at hello@findy-pet.com',
    askArea:
      '📍 Where was your pet last seen? (area / city — e.g. "Haifa, Carmel Center")\n' +
      'This is shown on the tag page. Tap <b>Skip</b> if you prefer not to say.',
    askPhone2: '📞 Send the <b>second phone number</b> (e.g. a family member). It will be shown on the pet page — add it only with that person\'s consent.',
    pickDelete: '🗑 Delete the data of which pet?',
    delAsk: (v) => `🗑 <b>Delete ${v.pet}'s data?</b>\n\nWe will erase the name, phone numbers, address, notes and photo, and the tag page will stop showing them — ` +
      'a finder will no longer be able to reach you through this tag. This can\'t be undone.',
    btnDelYes: '🗑 Yes, delete', btnDelNo: '↩️ No, keep it',
    delDone: (v) => `✅ Done — ${v.pet}'s data is deleted and the tag page no longer shows it.\nThank you for using FindYpet. If you want a tag again, send /register.`,
    delLater: '⏳ We got your request. Deletion is finished by hand within a few days — we will write to you here when it is done.',
    delCancelled: 'OK, nothing was deleted.',
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
    myTagLine: (v) => `🐾 <b>${v.pet}</b> — tag #${v.id}` + (v.lost ? '  🚨 <b>Lost mode</b>' : '') +
      (v.copies > 1 ? ` · ${v.copies} tags` : '') + '\n' +
      (v.order ? `🧾 Order ${v.order}: ${v.status}\n` : '') + `🔗 ${v.link}` +
      (v.p2 ? `\n📞 2nd contact: ${v.p2}` : '') + (v.notes ? `\n📝 ${v.notes}` : '') + (v.scan ? `\n🕒 last scan: ${v.scan}` : ''),
    myTagsHead: '<b>Your tags</b>\n\n',
    care: (v) =>
      '💚 <b>FindYpet Care — coming soon</b>\n\n' +
      'Services we are preparing for pet owners, for all your pets at once:\n' +
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
      delete: 'Delete my data', cancel: 'Cancel the current action', help: 'Help',
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
    queuedWait: (v) => '⏳ קיבלנו את ההזמנה שלכם עבור <b>' + v.pet + '</b>. המערכת הייתה עמוסה, ולכן ההזמנה מושלמת אוטומטית. ' +
      'כשהיא תושלם, האישור והקישור לתג יגיעו לכאן. אין צורך לעשות דבר.',
    queuedFail: (v) => '⚠️ לא הצלחנו להשלים אוטומטית את ההזמנה עבור <b>' + v.pet + '</b>. שום דבר לא אבד: נתקשר אליכם בקרוב כדי להשלים אותה.',
    tokenUsed: '⚠️ קישור ההפעלה הזה כבר שימש חשבון טלגרם אחר. אם אלה הייתם אתם ממכשיר אחר, כתבו לנו כאן ונעביר את התג לצ׳אט הזה.',
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
      `🗑 ${LRM}/delete — מחיקת הנתונים שלכם\n` +
      `${LRM}/cancel — ביטול הפעולה הנוכחית\n` +
      `${LRM}/id — מזהה הצ׳אט שלכם בטלגרם\n\n` +
      '✉️ שאלות? כתבו לנו כאן או ל-hello@findy-pet.com',
    askArea:
      '📍 איפה ראו את חיית המחמד בפעם האחרונה? (שכונה או עיר — למשל "חיפה, מרכז הכרמל")\n' +
      'זה יוצג בדף התג. לחצו <b>דילוג</b> אם אתם מעדיפים לא לציין.',
    askPhone2: '📞 שלחו <b>מספר טלפון נוסף</b> (למשל של בן משפחה). הוא יוצג בדף החיה — הוסיפו אותו רק בהסכמת אותו אדם.',
    pickDelete: '🗑 למחוק את הנתונים של איזו חיה?',
    delAsk: (v) => `🗑 <b>למחוק את הנתונים של ${v.pet}?</b>\n\nנמחק את השם, מספרי הטלפון, הכתובת, ההערות והתמונה, ודף התג יפסיק להציג אותם — ` +
      'מי שימצא את החיה כבר לא יוכל להשיג אתכם דרך התג הזה. אי אפשר לבטל את זה.',
    btnDelYes: '🗑 כן, למחוק', btnDelNo: '↩️ לא, להשאיר',
    delDone: (v) => `✅ בוצע — הנתונים של ${v.pet} נמחקו ודף התג כבר לא מציג אותם.\nתודה שהשתמשתם ב-FindYpet. כדי לקבל תג שוב, שלחו ${LRM}/register.`,
    delLater: '⏳ קיבלנו את הבקשה. המחיקה תושלם ידנית תוך כמה ימים — נכתוב לכם כאן כשזה יסתיים.',
    delCancelled: 'בסדר, שום דבר לא נמחק.',
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
      'שירותים שאנחנו מכינים לבעלי חיות, לכל חיות המחמד שלכם יחד:\n' +
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
      delete: 'מחיקת הנתונים שלי', cancel: 'ביטול הפעולה הנוכחית', help: 'עזרה',
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
    queuedWait: (v) => '⏳ Мы получили ваш заказ для <b>' + v.pet + '</b>. Система была занята, поэтому заказ оформляется автоматически. ' +
      'Когда он будет готов, подтверждение и ссылка на жетон придут сюда. Ничего делать не нужно.',
    queuedFail: (v) => '⚠️ Не получилось автоматически оформить заказ для <b>' + v.pet + '</b>. Ничего не потерялось: мы скоро позвоним и закончим оформление.',
    tokenUsed: '⚠️ Эта ссылка активации уже использована другим аккаунтом Telegram. ' +
      'Если это были вы с другого устройства, напишите нам здесь — мы перенесём жетон в этот чат.',
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
      '🗑 /delete — удалить ваши данные\n' +
      '/cancel — отменить текущее действие\n' +
      '/id — ваш chat ID в Telegram\n\n' +
      '✉️ Вопросы? Напишите нам здесь или на hello@findy-pet.com',
    askArea:
      '📍 Где питомца видели в последний раз? (район или город — например, «Хайфа, Центр Кармель»)\n' +
      'Это будет на странице жетона. Нажмите <b>Пропустить</b>, если не хотите указывать.',
    askPhone2: '📞 Отправьте <b>второй номер телефона</b> (например, члена семьи). Он появится на странице питомца — добавляйте его только с согласия этого человека.',
    pickDelete: '🗑 Данные какого питомца удалить?',
    delAsk: (v) => `🗑 <b>Удалить данные питомца ${v.pet}?</b>\n\nМы сотрём имя, номера телефонов, адрес, заметки и фото, и страница жетона перестанет их показывать — ` +
      'нашедший больше не сможет связаться с вами через этот жетон. Отменить это нельзя.',
    btnDelYes: '🗑 Да, удалить', btnDelNo: '↩️ Нет, оставить',
    delDone: (v) => `✅ Готово — данные питомца ${v.pet} удалены, страница жетона их больше не показывает.\nСпасибо, что были с FindYpet. Если снова понадобится жетон — отправьте /register.`,
    delLater: '⏳ Запрос получен. Удаление завершим вручную в течение нескольких дней — напишем вам здесь, когда всё будет готово.',
    delCancelled: 'Хорошо, ничего не удалено.',
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
      'Сервисы, которые мы готовим для владельцев, — сразу для всех ваших питомцев:\n' +
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
      delete: 'Удалить мои данные', cancel: 'Отменить текущее действие', help: 'Помощь',
    },
    desc: 'FindYpet — умный жетон для питомца с вашим номером, QR-кодом и NFC. Нашедший сможет позвонить вам, ' +
      'написать в WhatsApp или отправить геолокацию, а вы получите оповещение здесь, как только жетон отсканируют. ' +
      'Нажмите кнопку ниже, чтобы начать.',
    shortDesc: 'Питомец потерялся? Нашедший позвонит вам или пришлёт геолокацию. Оповещения — прямо здесь.',
  },
};

/** Строка «🗺 Google Maps · 🚗 Waze»; в иврите — в изоляторе, чтобы ссылки не переставлялись. */
export function mapsLine(L, maps, waze) {
  return ltr(L, `🗺 <a href="${maps}">${tr(L, 'maps')}</a>  ·  🚗 <a href="${waze}">Waze</a>`);
}

/** Номер телефона внутри текста на иврите — в изоляторе (иначе «+» и части номера переставляются). */
export const ltr = (L, s) => (L === 'he' && s ? iso(s) : s);

/** Текст бота на нужном языке; v — подстановки (уже экранированные). Нет перевода — английский. */
export function tr(lang, key, v) {
  const L = BOT[lang] || BOT.en;
  const s = L[key] !== undefined ? L[key] : BOT.en[key];
  return typeof s === 'function' ? s(v || {}) : s;
}
/** Все варианты кнопки на трёх языках — нажатие распознаётся, даже если язык сменили. */
export function isBtn(text, key) { return LANGS.some((l) => BOT[l][key] === text); }

/** Язык Telegram-клиента → наш язык. */
export function tgLang(from) {
  const c = String((from && from.language_code) || '').toLowerCase().slice(0, 2);
  if (c === 'he' || c === 'iw') return 'he';
  if (['ru', 'uk', 'be', 'kk'].includes(c)) return 'ru';
  return 'en';
}
/** Язык чата: выбранный (/lang или язык заказа) → язык Telegram → английский. */
export async function chatLang(env, chatId, from) {
  if (kvOn(env)) {
    try { const v = await env.FYP_KV.get(`lang:${chatId}`); if (LANGS.includes(v)) return v; } catch (e) { console.error('lang get', e); }
  }
  return tgLang(from);
}
export async function setChatLang(env, chatId, lang) {
  if (!kvOn(env) || !LANGS.includes(lang)) return;
  try { await env.FYP_KV.put(`lang:${chatId}`, lang); } catch (e) { console.error('lang put', e); }
}
/** Язык владельца для оповещений (сканы, находка): выбранный в боте → язык заказа → английский. */
export async function ownerLang(env, chatId, extras) {
  if (kvOn(env) && chatId) {
    try { const v = await env.FYP_KV.get(`lang:${chatId}`); if (LANGS.includes(v)) return v; } catch (e) { /* ниже — запасной вариант */ }
  }
  return LANGS.includes(extras && extras.lang) ? extras.lang : 'en';
}
/** Язык из заказа / диалога закрепляется за чатом, если его ещё не выбрали (/lang). Возвращает язык чата. */
export async function keepChatLang(env, chatId, lang) {
  const want = LANGS.includes(lang) ? lang : 'en';
  if (!kvOn(env)) return want;
  try {
    const cur = await env.FYP_KV.get(`lang:${chatId}`);
    if (LANGS.includes(cur)) return cur;
    await env.FYP_KV.put(`lang:${chatId}`, want);
  } catch (e) { console.error('lang keep', e); }
  return want;
}

export const REMINDER_DAYS = 180;
