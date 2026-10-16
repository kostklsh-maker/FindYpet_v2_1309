import { iso, tr } from './i18n.js';
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
export const PRICING = { tag: 49, currency: '₪', bundle: 4, care: 39 };
/**
 * Сколько жетонов в заказе: 1, 2 или 4 (3 + 1). Три жетона стоят столько же, сколько четыре,
 * поэтому 3 (и больше) превращается в 3 + 1. Старая страница 2 + 1 присылала 3 — тоже 3 + 1.
 */
export function normQty(n) {
  const v = Math.floor(Number(n)) || 1;
  if (v >= PRICING.bundle - 1) return PRICING.bundle;
  return v >= 2 ? 2 : 1;
}
export function orderPrice(n) {
  const tags = normQty(n);
  const free = tags === PRICING.bundle ? 1 : 0;
  return { tags, free, paid: tags - free, total: (tags - free) * PRICING.tag };
}
export function ils(n) { return `${n} ${PRICING.currency}`; }
export function qtyLabel(n, L = 'en') {
  const p = orderPrice(n);
  return tr(L, 'qtyLabel', { ...p, total: ils(p.total) });
}
// Заказы до 06.10.2026 были по тарифам — показываем их как раньше
export const LEGACY_PLANS = { basic: 'Basic · 49 ₪', smart: 'Special · 79 ₪', family: 'Family · 199 ₪' };
export function orderLabel(o, L = 'en') {
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
export function feats() { return { alerts: true, lost: true, extras: true }; }
