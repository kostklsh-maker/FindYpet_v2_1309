# FindYpet — как выкладывать обновления

## Два сайта: тестовый и рабочий (с 01.10.2026)
| | Тестовый | Рабочий |
|---|---|---|
| Адрес | **https://test.findy-pet.com** | **https://findy-pet.com** (`www` перенаправляет сюда) |
| Ветка в GitHub | `test` | `main` |
| Worker в Cloudflare | `findypet-app-staging` | `findypet-app` |
| Заказы и жетоны | хранилище KV `findypet-data-test`, номера с 9001 | Google-таблица FindYpetDatabase + KV `findypet-data` |
| Telegram-бот | свой тестовый бот (подключается отдельно, см. ниже) | @YourPetLocatorBot |
| Отличия | оранжевая полоса «Тестовый сайт» сверху, закрыт от поисковиков, без напоминаний | — |

Тестовые заказы не попадают ни в Google-таблицу, ни в данные рабочего сайта, и жетоны по ним не изготавливаются.

## Порядок работы
1. **Изменение → ветка `test`.** Через ~1 минуту оно на test.findy-pet.com.
2. **Проверить** на телефоне и компьютере: страницы, заказ, страницу жетона `/t/9001`.
3. **Опубликовать** — перенести `test` в `main`:
   GitHub → **Pull requests** → **New pull request** → base: `main`, compare: `test` → **Create pull request** → **Merge**.
   (Или написать Claude: «опубликуй тестовую версию».)
4. Через ~1 минуту изменения на findy-pet.com.

Срочное исправление можно внести сразу в `main`, но потом перенести его и в `test`, чтобы ветки не разошлись.

## Как это устроено
Любое изменение в ветке `test` или `main` (сайт в корне или `worker/`) запускает GitHub Actions «Deploy worker»:
сборка `python3 worker/build.py` → 32 автотеста → выкладка в Cloudflare → проверка, что сайт открывается.
Если тесты не прошли — выкладки не будет, сайт остаётся прежним.
Запустить вручную: GitHub → Actions → Deploy worker → Run workflow (выбрать ветку).
Секреты репозитория: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Переменные и секреты бота в панели Cloudflare выкладка не меняет (`keep_vars = true` в `worker/wrangler.toml`).

**Зачем GitHub, если сайт на Cloudflare.** Сам сайт GitHub не показывает — оба сайта работают в Cloudflare.
GitHub — это хранилище кода с историей каждой правки (любую можно откатить) и «пульт выкладки»:
без него обновлять сайт пришлось бы вручную с компьютера.

## GitHub Pages — выключить
Старая копия сайта `kostklsh-maker.github.io/findypet_v2_1309` больше не нужна: она только перенаправляет на findy-pet.com,
а заказы и страницы жетонов на ней работать не могут. Выключить:
GitHub → репозиторий → **Settings** → **Pages** → **Build and deployment** → Branch: **None** → **Save**
(или кнопка **Unpublish site**, если она есть).

## Тестовый бот (по желанию)
У Telegram-бота может быть только один адрес для сообщений, поэтому рабочий бот обслуживает только рабочий сайт.
Без своего бота на тестовом сайте работают страницы, заказы и страницы жетонов, но не уведомления и не привязка Telegram.
Чтобы проверять и бота:
1. @BotFather → `/newbot` → имя «FindYpet TEST», username например `FindYpetTestBot` → скопировать токен.
2. Cloudflare → **Workers & Pages** → **findypet-app-staging** → **Settings** → **Variables and Secrets** → **Add**:
   - `BOT_TOKEN` (Secret) — токен тестового бота;
   - `BOT_USERNAME` (Text) — username тестового бота без @;
   - `WEBHOOK_SECRET` (Secret) — любая строка из букв и цифр;
   - `ADMIN_CHAT_ID` (Secret) — ваш chat id (тот же, что у рабочего сайта; бот показывает его по команде `/id`).
3. Открыть `https://test.findy-pet.com/setup` и ввести ключ (SETUP_KEY, а пока его нет — WEBHOOK_SECRET) — в ответе `"setWebhook": { "ok": true }`. Ключ в адресе (`?key=`) больше не принимается.
4. Написать тестовому боту `/start`.

⚠️ Никогда не вписывайте в тестовый сайт токен рабочего бота @YourPetLocatorBot — рабочий бот перестанет отвечать клиентам.

**Очистить тестовые данные:** Cloudflare → **Storage & Databases** → **KV** → `findypet-data-test` → удалить ключи.

## Адреса и ссылки на жетонах
- `SITE_URL` в `worker/wrangler.toml` (`[vars]` — рабочий, `[env.staging.vars]` — тестовый) — от него строятся ссылки на страницы питомцев, QR и NFC.
- Старый адрес `findypet-app.kostikklsh.workers.dev` продолжает работать (уже записанные жетоны и вебхук бота).
- Тестовый сайт доступен также по `findypet-app-staging.kostikklsh.workers.dev`.
- Репозиторий открытый: код виден всем, секретов в нём нет (они хранятся в Cloudflare и в секретах GitHub).
  Его можно сделать закрытым: Settings → General → Danger Zone → Change visibility → Private — выкладка продолжит работать.

## Где что лежит
- Корень репозитория — сайт: `index.html`, `css/`, `js/`, `tag/`, `privacy/`, `assets/logo.png`.
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
`https://findy-pet.com/setup` → ввести ключ в форму (SETUP_KEY; пока его нет — WEBHOOK_SECRET)

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
- Политика конфиденциальности: e-mail findypet0926@gmail.com вписан (30.09.2026). Черновик политики лучше показать юристу.
- Тексты на иврите — проверить с носителем языка.
- Цены: `worker/src/worker.js` → `const PRICING` (сейчас жетон 49 ₪ · 3 + 1 = 4 жетона за 147 ₪ · «Забота» 39 ₪/мес, скоро). Оттуда их берут и сайт, и бот; js/plans.js обновляется при сборке.

## Как пересобрать и проверить после правок
```
python3 worker/build.py        # собрать worker/dist/worker.js
node worker/test/run.mjs       # 32 автотеста (моки таблицы, Telegram, KV, SMS; тестовый сайт)
python3 worker/test/shots_v6.py  # скриншоты лендинга на 3 языках (нужен запущенный test/server.mjs)
node worker/test/server.mjs    # локальный просмотр: http://localhost:8787 , /t/101 , /t/102 (Lost), /t/103 (сбой базы)
```
- Почта hello@findy-pet.com (Cloudflare Email Routing → findypet0926@gmail.com) работает с 08.10.2026, указана на сайте, в политике, на странице доступности и в боте.
