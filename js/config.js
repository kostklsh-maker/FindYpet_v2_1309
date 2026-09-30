// ============================================================
// FindYpet — настройки сайта
// ============================================================
// Основной адрес сайта. Сайт, API и бот работают в Cloudflare Worker на этом домене,
// поэтому API_URL пустой (тот же адрес).
const SITE_HOME = "https://findy-pet.com";
const API_URL = "";

// Копия на GitHub Pages (…github.io/<репозиторий>/…) сразу переводит посетителя на основной домен
if (/\.github\.io$/.test(location.hostname)) {
    location.replace(SITE_HOME + location.pathname.replace(/^\/[^/]+/, "") + location.search + location.hash);
}

// Цены тарифов задаются в worker/src/worker.js (const PLANS). Worker отдаёт их как /js/plans.js.
