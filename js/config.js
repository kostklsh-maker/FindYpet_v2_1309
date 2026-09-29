// ============================================================
// FindYpet — настройки сайта
// ============================================================
// Сайт работает в двух местах:
//  • внутри Cloudflare Worker (основной адрес) — API на том же адресе, API_URL = "";
//  • копия на GitHub Pages — заказы и страница жетона обращаются к Worker'у по полному адресу.
const API_URL = /\.github\.io$/.test(location.hostname) ? "https://findypet-app.kostikklsh.workers.dev" : "";

// Цены тарифов задаются в worker/src/worker.js (const PLANS). Worker отдаёт их как /js/plans.js,
// а файл js/plans.js в репозитории — копия для GitHub Pages (обновляется при сборке).
