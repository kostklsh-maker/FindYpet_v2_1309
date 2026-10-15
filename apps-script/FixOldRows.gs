/**
 * ============================================================
 *  FindYpet — приведение старых строк таблицы к формату v2 (пункт B8)
 * ============================================================
 *  Разовый файл. Работает рядом с Code.gs (использует его table_, setCell_, text_).
 *  Веб-приложение не меняется, новое развертывание НЕ нужно.
 *
 *   1. checkOldRows — только показывает, что будет исправлено (ничего не меняет).
 *   2. fixOldRows   — исправляет.
 *  В журнал пишутся только номера жетонов и названия колонок, без личных данных.
 *  После проверки этот файл можно удалить из проекта.
 * ============================================================
 */

const FIX_SITE_BASE = 'https://findy-pet.com';
const FIX_TEXT_FIELDS = { owner_name: 80, pet_name: 40, address: 200 };

function checkOldRows() { fixOldRows_(false); }
function fixOldRows() { fixOldRows_(true); }

/** Телефон в формате +972…, как его пишет Worker (normalizePhone). */
function fixPhone_(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (/e\+?\d/i.test(s) && isFinite(Number(s))) s = String(Math.round(Number(s)));
  let d = s.replace(/[^\d+]/g, '');
  const plus = d.charAt(0) === '+';
  d = d.replace(/\D/g, '');
  if (!d) return '';
  if (plus) return d.length >= 8 && d.length <= 15 ? '+' + d : '';
  if (d.indexOf('00') === 0) d = d.slice(2);
  else if (d.indexOf('972') === 0) { /* уже международный */ }
  else if (d.charAt(0) === '0') d = '972' + d.slice(1);
  else if (d.length === 8 || d.length === 9) d = '972' + d;
  return d.length >= 8 && d.length <= 15 ? '+' + d : '';
}

function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

function fixDate_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm:ss');
  return String(v === undefined || v === null ? '' : v).trim();
}

/** Возвращает { колонка: новое значение } для одной строки. Пустой объект — строка уже в порядке. */
function fixRowChanges_(o, formulas) {
  const ch = {};
  const id = String(o.tag_id).trim();
  const same = function (name, v) {
    const cur = o[name] === undefined || o[name] === null ? '' : o[name];
    // Число в текстовой колонке (телефон 5.0E8, chat id) тоже переписываем текстом
    const numInText = typeof cur === 'number' && TEXT_COLUMNS.indexOf(name) !== -1;
    if (String(cur) !== v || formulas[name] || numInText) ch[name] = v;
  };

  if (o.status === 'deleted') {
    // У удалённых личные данные уже стёрты; правим только служебные поля.
  } else {
    if (String(o.phone) !== '') {
      const p = fixPhone_(o.phone);
      if (p) same('phone', p); else ch.phone = { problem: 'телефон не распознан' };
    }
    Object.keys(FIX_TEXT_FIELDS).forEach(function (name) {
      if (String(o[name]) !== '' || formulas[name]) same(name, text_(o[name], FIX_TEXT_FIELDS[name]));
    });
    if (String(o.telegram_chat_id) !== '') same('telegram_chat_id', String(o.telegram_chat_id).replace(/[^\d-]/g, ''));
  }
  ['created_at', 'last_scan_at'].forEach(function (name) {
    if (isDate_(o[name]) || formulas[name]) ch[name] = fixDate_(o[name]);
  });
  same('tag_url', FIX_SITE_BASE + '/tag/?id=' + id);
  if (String(o.scan_count) === '' || isNaN(Number(o.scan_count))) same('scan_count', '0');
  if (String(o.status) === '') ch.status = 'pending';
  return ch;
}

function fixOldRows_(apply) {
  const t = table_();
  const last = t.sh.getLastRow();
  const formulasAll = last > 1 ? t.sh.getRange(2, 1, last - 1, t.head.length).getFormulas() : [];
  let fixed = 0, problems = 0;
  t.rows.forEach(function (r, i) {
    const o = {};
    const formulas = {};
    t.head.forEach(function (h, j) {
      o[h] = r[j];
      if (formulasAll[i] && formulasAll[i][j]) formulas[h] = true;
    });
    if (String(o.tag_id).trim() === '') return;
    const ch = fixRowChanges_(o, formulas);
    const names = Object.keys(ch);
    if (!names.length) return;
    const f = { t: t, rowNum: i + 2 };
    const done = [];
    names.forEach(function (name) {
      if (ch[name] && ch[name].problem) { problems++; done.push(name + ' (' + ch[name].problem + ', поправьте руками)'); return; }
      done.push(name + (formulas[name] ? ' (была формула)' : ''));
      if (apply) setCell_(f, name, name === 'scan_count' ? 0 : ch[name]);
    });
    if (names.some(function (n) { return !(ch[n] && ch[n].problem); })) fixed++;
    Logger.log('Жетон ' + o.tag_id + ': ' + done.join(', '));
  });
  if (apply) {
    TEXT_COLUMNS.forEach(function (name) {
      const c = t.col[name];
      if (c !== undefined && last > 1) t.sh.getRange(2, c + 1, last - 1, 1).setNumberFormat('@');
    });
    SpreadsheetApp.flush();
  }
  Logger.log((apply ? 'Исправлено строк: ' : 'Нужно исправить строк: ') + fixed +
    (problems ? '. Требуют ручной правки: ' + problems : '') + '. Всего жетонов: ' + t.rows.filter(function (r) { return String(r[t.col.tag_id]).trim() !== ''; }).length);
}
