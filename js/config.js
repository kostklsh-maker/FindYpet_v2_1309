// ============================================================
// Единое место для хранения API_URL для всего проекта
// ============================================================
const API_URL = "https://script.google.com/macros/s/AKfycbw7YtH3ZyIW09kejhkvimx2IPMhOLpZL7bl60P0pLfpwUd2CtMpXQScUp2D2ciAGJ1Z/exec";
// Замените YOUR_DEPLOYMENT_ID на ваш реальный ID из Apps Script

// ============================================================
// Тарифы — единое место для цен на сайте.
// Держите в синхроне с const PLANS в worker.js (бот и админ-уведомления).
// ============================================================
const PLANS = {
    basic:  { price: "49 ₪",  name: "Basic" },
    smart:  { price: "79 ₪",  name: "Smart" },
    family: { price: "199 ₪", name: "Family (3 Smart tags)" }
};
