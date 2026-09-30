# FindYpet — как выкладывать обновления

## Автоматически (основной способ, с 29.09.2026)
Любое изменение в ветке `main` этого репозитория (сайт в корне или `worker/`) запускает GitHub Actions
«Deploy worker»: сборка `python3 worker/build.py` → 18 тестов → выкладка в Cloudflare (`findypet-app`) → проверка, что сайт открывается.
Если тесты не прошли — выкладки не будет, сайт остаётся прежним.
Запустить вручную: GitHub → Actions → Deploy worker → Run workflow.
Секреты репозитория: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Переменные и секреты бота в панели Cloudflare выкладка не меняет (`keep_vars = true` в `worker/wrangler.toml`).

## Адрес сайта
- Основной: **https://findy-pet.com** (домен подключён к Worker'у в `worker/wrangler.toml` → `routes`; `www` перенаправляет на основной).
- `SITE_URL = "https://findy-pet.com"` (там же, `[vars]`) — от него строятся ссылки на страницы питомцев, QR и NFC.
- Старый адрес `findypet-app.kostikklsh.workers.dev` продолжает работать (уже записанные жетоны и вебхук бота).
- Копия на GitHub Pages перенаправляет посетителей на findy-pet.com.

## Где что лежит
- Корень репозитория — сайт (он же копия на GitHub Pages): `index.html`, `css/`, `js/`, `tag/`, `privacy/`, `assets/logo.png`.
- `worker/src/worker.js` — API и Telegram-бот; `worker/build.py` встраивает сайт в `worker/dist/worker.js`.
- Цены — только в `worker/src/worker.js` → `const PLANS`; `js/plans.js` генерируется сборкой.

---

# Ручная установка (запасной вариант)

Всё готово в одном файле **`dist/worker.js`** (сайт встроен внутрь, как и раньше).
Google-таблица и Apps Script **не меняются**.

## Шаг 1. Подключить хранилище KV (1 минута)
Хранилище для новых функций уже создано в вашем аккаунте Cloudflare: **`findypet-data`**.

1. Cloudflare → **Workers & Pages** → **findypet-app** → **Settings** → **Bindings** → **Add** → **KV namespace**.
2. Variable name: **`FYP_KV`** (точно так), KV namespace: **`findypet-data`** → **Save / Deploy**.

> Без этого шага сайт и бот тоже будут работать, но режим «Потерялся», /settings, второй контакт,
> заметки и резервная копия страницы будут выключены.

## Шаг 2. Вставить новый код
1. **findypet-app** → **Edit code**.
2. Выделить весь код (Ctrl+A) → вставить содержимое `dist/worker.js` → **Deploy**.
3. Копия старой версии лежит в `backup/worker_v3_before_update.js` — её можно вставить обратно тем же способом, если что-то пойдёт не так.

## Шаг 3. Обновить команды бота
Откройте в браузере:
`https://findypet-app.kostikklsh.workers.dev/setup?key=<ваш WEBHOOK_SECRET>`

В ответе должно быть: `"kv": "FYP_KV connected ✅"` и `"setMyCommands": { "ok": true }`.
После этого в меню бота появятся /lost, /found, /settings.

## Шаг 4. Напоминания раз в 180 дней (по желанию)
**findypet-app** → **Settings** → **Triggers** → **Cron Triggers** → **Add**: `0 7 * * *`
(каждый день в 10:00 по Израилю бот проверяет, кому пора напомнить обновить контакты).

## Шаг 5. Необязательные настройки (Settings → Variables)
| Переменная | Зачем |
|---|---|
| `LOST_CHANNEL_ID` | `@имя_канала` — бот публикует туда объявление «Потерялся» и отмечает «Нашёлся». Бота нужно сделать админом канала. |
| `SITE_URL` | Ваш будущий домен, например `https://findypet.co.il` — все ссылки и QR будут на нём. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (секрет), `TWILIO_FROM` | SMS-резерв для владельцев без Telegram. Платно, по тарифам Twilio. |

## Шаг 6. Проверка (5 минут)
- [ ] Главная открывается на EN / עב / RU, кнопка «Заказать» ведёт к форме.
- [ ] Регистрация без галочки согласия показывает ошибку; с галочкой — создаёт жетон.
- [ ] Страница жетона `/t/<номер>` открывается, есть кнопки «Позвонить», «WhatsApp», «Отправить геолокацию».
- [ ] В боте: /settings → добавить заметку → она видна на странице жетона.
- [ ] /lost → страница жетона стала красной «Меня ищет семья»; /found → вернулась обычная.
- [ ] Сканирование страницы → приходит уведомление с кнопкой «Lost mode on».

## Что осталось заполнить вручную
- `site/privacy/index.html`: вместо `[email]` — ваш e-mail. Черновик политики лучше показать юристу.
- Тексты на иврите — проверить с носителем языка.
- Тарифы: `worker/src/worker.js` → `const PLANS` (сейчас Базовый 49 ₪ · Смарт 79 ₪ · Семейный 199 ₪ за 3 жетона). Цены оттуда берут и сайт, и бот. Сайт и js/plans.js подхватят их при сборке.

## Как пересобрать и проверить после правок
```
python3 worker/build.py        # собрать worker/dist/worker.js
node worker/test/run.mjs       # 18 автотестов (моки таблицы, Telegram, KV, SMS)
python3 worker/test/shots_v6.py  # скриншоты лендинга на 3 языках (нужен запущенный test/server.mjs)
node worker/test/server.mjs    # локальный просмотр: http://localhost:8787 , /t/101 , /t/102 (Lost), /t/103 (сбой базы)
```
