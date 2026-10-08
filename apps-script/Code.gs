/**
 * ============================================================
 *  FindYpet — Database API (Google Sheets + Apps Script)   версия 2
 * ============================================================
 *  Этот скрипт — "база данных" системы. Он работает с таблицей
 *  FindYpetDatabase и принимает запросы ТОЛЬКО от Cloudflare Worker
 *  (запрос должен содержать секретный ключ API_KEY).
 *
 *  Что нового в версии 2 (октябрь 2026):
 *   • текст, который попадает в таблицу, не может стать формулой (=, +, -, @ в начале);
 *   • ссылка активации не перепривязывает жетон к другому Telegram-чату (conflict);
 *   • deleteTag — владелец удаляет свои данные из бота (/delete);
 *   • удалённые жетоны (status = deleted) не находятся и не показываются;
 *   • version — Worker проверяет, что развёрнута нужная версия (/setup).
 *
 *  Обновление (делается один раз после изменения файла):
 *   1. Таблица FindYpetDatabase → Расширения → Apps Script.
 *   2. Заменить весь текст Code.gs этим файлом, сохранить (💾).
 *   3. Развернуть → Управление развертываниями → у «FindYpet DB v1» ✏️ Изменить →
 *      Версия: «Новая версия» → Развернуть. URL (…/exec) НЕ меняется.
 *
 *  Первая настройка (если таблица новая):
 *   1. Настройки проекта (⚙️) → Свойства скрипта → API_KEY = <тот же ключ, что GAS_KEY в Worker>.
 *   2. Запустить setup() один раз.
 *   3. Развернуть → Новое развертывание → Веб-приложение: от имени «Я», доступ «Все».
 * ============================================================
 */

const VERSION = 2;
const SHEET_NAME = 'FindYpetDatabase';
const FIRST_TAG_ID = 100;           // первый ID (следующий будет max+1)
const SCAN_THROTTLE_SEC = 120;      // не чаще 1 уведомления "метку отсканировали" за 2 мин
const STATE_TTL_SEC = 21600;        // 6 часов — сколько бот помнит незаконченную регистрацию

const HEADERS = [
  'tag_id', 'owner_name', 'phone', 'pet_name', 'address',
  'telegram_chat_id', 'status', 'link_token', 'created_at',
  'tag_url', 'source', 'scan_count', 'last_scan_at', 'last_scan_location'
];
// Эти колонки храним как текст, чтобы Google не превращал +972… в 9.7E+11
const TEXT_COLUMNS = ['phone', 'telegram_chat_id', 'link_token', 'created_at', 'last_scan_at', 'last_scan_location', 'tag_url'];
// Что стирается по запросу владельца (/delete). tag_id и status остаются, чтобы номер не выдали повторно.
const PERSONAL_COLUMNS = ['owner_name', 'phone', 'pet_name', 'address', 'telegram_chat_id', 'link_token', 'last_scan_location'];

/* ---------------------------- HTTP ---------------------------- */

function doGet() {
  return json_({ ok: true, service: 'FindYpet DB', version: VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }

  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key || req.key !== key) return json_({ ok: false, error: 'unauthorized' });

  try {
    switch (req.action) {
      case 'version':      return json_({ ok: true, version: VERSION });
      case 'register':     return json_(register_(req));
      case 'getTag':       return json_(getTag_(req));
      case 'linkTelegram': return json_(linkTelegram_(req));
      case 'listByChat':   return json_(listByChat_(req));
      case 'logScan':      return json_(logScan_(req));
      case 'deleteTag':    return json_(deleteTag_(req));
      case 'getState':     return json_(getState_(req));
      case 'setState':     return json_(setState_(req));
      case 'clearState':   return json_(clearState_(req));
      default:             return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------- Actions ---------------------------- */

function register_(req) {
  const owner = text_(req.owner_name, 80);
  const phone = phone_(req.phone);
  const pet = text_(req.pet_name, 40);
  const address = text_(req.address, 200);
  if (!owner || !phone || !pet || !address) return { ok: false, error: 'missing_fields' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const t = table_();
    let maxId = FIRST_TAG_ID - 1;
    t.rows.forEach(function (r) {
      const n = Number(r[t.col.tag_id]);
      if (!isNaN(n) && n > maxId) maxId = n;
    });
    const id = maxId + 1;
    const token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    const chatId = req.telegram_chat_id ? String(req.telegram_chat_id).replace(/[^\d-]/g, '') : '';

    const obj = {
      tag_id: id,
      owner_name: owner,
      phone: phone,
      pet_name: pet,
      address: address,
      telegram_chat_id: chatId,
      status: chatId ? 'active' : 'pending',
      link_token: token,
      created_at: now_(),
      tag_url: req.tag_url_base ? text_(req.tag_url_base, 100) + id : '',
      source: text_(req.source, 20) || 'site',
      scan_count: 0,
      last_scan_at: '',
      last_scan_location: ''
    };
    const row = t.head.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
    const r = t.sh.getLastRow() + 1;
    formatRow_(t, r);
    t.sh.getRange(r, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
    return { ok: true, tag: obj };
  } finally {
    lock.releaseLock();
  }
}

function getTag_(req) {
  const f = findRow_(function (o) { return String(o.tag_id) === String(req.id); });
  if (!f || f.obj.status === 'deleted') return { ok: true, found: false };
  return { ok: true, found: true, tag: f.obj };
}

/** Привязка жетона к Telegram по ссылке активации. Уже привязан к ДРУГОМУ чату — conflict, ничего не меняем. */
function linkTelegram_(req) {
  const token = String(req.token || '');
  const chatId = String(req.chat_id || '');
  if (!token || !chatId) return { ok: false, error: 'missing_fields' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = findRow_(function (o) { return String(o.link_token) === token; });
    if (!f || f.obj.status === 'deleted') return { ok: true, found: false };
    const cur = String(f.obj.telegram_chat_id || '');
    if (cur && cur !== chatId) return { ok: true, found: true, conflict: true };
    setCell_(f, 'telegram_chat_id', chatId);
    if (f.obj.status === 'pending' || !f.obj.status) setCell_(f, 'status', 'active');
    f.obj.telegram_chat_id = chatId;
    if (f.obj.status === 'pending' || !f.obj.status) f.obj.status = 'active';
    return { ok: true, found: true, already: cur === chatId, tag: f.obj };
  } finally {
    lock.releaseLock();
  }
}

function listByChat_(req) {
  const chatId = String(req.chat_id || '');
  const t = table_();
  const tags = t.rows
    .map(function (r) { return rowToObj_(t, r); })
    .filter(function (o) { return chatId && String(o.telegram_chat_id) === chatId && o.status !== 'deleted'; });
  return { ok: true, tags: tags };
}

/** Записывает факт сканирования. throttled=true — недавно уже уведомляли. Координаты нашедшего НЕ храним. */
function logScan_(req) {
  const cache = CacheService.getScriptCache();
  const ck = 'scan_' + req.id;
  if (cache.get(ck)) {
    const f0 = findRow_(function (o) { return String(o.tag_id) === String(req.id); });
    const ok0 = f0 && f0.obj.status !== 'deleted';
    return { ok: true, found: !!ok0, throttled: true, tag: ok0 ? f0.obj : null };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = findRow_(function (o) { return String(o.tag_id) === String(req.id); });
    if (!f || f.obj.status === 'deleted') return { ok: true, found: false };
    setCell_(f, 'scan_count', (Number(f.obj.scan_count) || 0) + 1);
    setCell_(f, 'last_scan_at', now_());
    cache.put(ck, '1', SCAN_THROTTLE_SEC);
    return { ok: true, found: true, throttled: false, tag: f.obj };
  } finally {
    lock.releaseLock();
  }
}

/** Владелец удаляет свои данные (бот: /delete). Только из того же Telegram-чата, к которому привязан жетон. */
function deleteTag_(req) {
  const chatId = String(req.chat_id || '');
  if (!req.id || !chatId) return { ok: false, error: 'missing_fields' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const f = findRow_(function (o) { return String(o.tag_id) === String(req.id); });
    if (!f || f.obj.status === 'deleted') return { ok: true, found: false };
    if (String(f.obj.telegram_chat_id) !== chatId) return { ok: false, error: 'forbidden' };
    PERSONAL_COLUMNS.forEach(function (name) { setCell_(f, name, ''); });
    setCell_(f, 'status', 'deleted');
    setCell_(f, 'last_scan_at', now_());
    return { ok: true, found: true, deleted: true };
  } finally {
    lock.releaseLock();
  }
}

/* Состояние диалога регистрации в боте */
function getState_(req) {
  const v = CacheService.getScriptCache().get('st_' + req.chat_id);
  return { ok: true, state: v ? JSON.parse(v) : null };
}
function setState_(req) {
  CacheService.getScriptCache().put('st_' + req.chat_id, JSON.stringify(req.state || {}), STATE_TTL_SEC);
  return { ok: true };
}
function clearState_(req) {
  CacheService.getScriptCache().remove('st_' + req.chat_id);
  return { ok: true };
}

/* ---------------------------- Sheet helpers ---------------------------- */

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.getSheets()[0];
  return sh;
}

/** Читает всю таблицу; добавляет недостающие колонки из HEADERS. */
function table_() {
  const sh = sheet_();
  const lastCol = Math.max(sh.getLastColumn(), 1);
  let head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  while (head.length && head[head.length - 1] === '') head.pop();
  HEADERS.forEach(function (h) {
    if (head.indexOf(h) === -1) {
      head.push(h);
      sh.getRange(1, head.length).setValue(h);
    }
  });
  const col = {};
  head.forEach(function (h, i) { col[h] = i; });
  const lastRow = sh.getLastRow();
  const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, head.length).getValues() : [];
  return { sh: sh, head: head, col: col, rows: rows };
}

function rowToObj_(t, r) {
  const o = {};
  t.head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
  return o;
}

function findRow_(pred) {
  const t = table_();
  for (let i = 0; i < t.rows.length; i++) {
    const o = rowToObj_(t, t.rows[i]);
    if (String(o.tag_id) !== '' && pred(o)) return { t: t, rowNum: i + 2, obj: o };
  }
  return null;
}

function setCell_(f, name, value) {
  const c = f.t.col[name];
  if (c === undefined) return;
  const rng = f.t.sh.getRange(f.rowNum, c + 1);
  if (TEXT_COLUMNS.indexOf(name) !== -1) rng.setNumberFormat('@');
  rng.setValue(value);
}

function formatRow_(t, r) {
  TEXT_COLUMNS.forEach(function (name) {
    const c = t.col[name];
    if (c !== undefined) t.sh.getRange(r, c + 1).setNumberFormat('@');
  });
}

/** Строка без управляющих символов, не длиннее max. */
function clean_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}
/** Текст для таблицы: не начинается с = + - @ (иначе Google считает его формулой). */
function text_(v, max) {
  return clean_(v, max + 10).replace(/^[=+\-@\s]+/, '').slice(0, max);
}
/** Телефон: только цифры, +, пробел и дефис (колонка — текстовая, «+972…» формулой не станет). */
function phone_(v) {
  return clean_(v, 30).replace(/[^\d+\- ]/g, '').slice(0, 20);
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm:ss');
}

/* ---------------------------- Setup ---------------------------- */

/** Запустите один раз вручную: создаст недостающие колонки и выставит текстовый формат. */
function setup() {
  const t = table_();
  TEXT_COLUMNS.forEach(function (name) {
    const c = t.col[name];
    if (c !== undefined) t.sh.getRange(2, c + 1, Math.max(t.sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });
  t.sh.setFrozenRows(1);
  // У старых строк без link_token создаём токен и статус (чтобы их можно было привязать к Telegram)
  t.rows.forEach(function (r, i) {
    if (String(r[t.col.tag_id]) === '') return;
    const f = { t: t, rowNum: i + 2 };
    if (!r[t.col.link_token] && r[t.col.status] !== 'deleted') setCell_(f, 'link_token', Utilities.getUuid().replace(/-/g, '').slice(0, 16));
    if (!r[t.col.status]) setCell_(f, 'status', 'pending');
  });
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  Logger.log(key ? 'API_KEY задан ✔' : '⚠️ Добавьте свойство скрипта API_KEY!');
  Logger.log('Версия ' + VERSION + '. Колонки: ' + t.head.join(', '));
}
