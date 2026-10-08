// ============================================================
// Заказ на сайте FindYpet
// 1) данные → Worker → таблица FindYpetDatabase: по строке (tag_id) на каждого питомца
//    (1, 2 или 4 жетона по акции 3 + 1: до 4 питомцев; оставшиеся жетоны — запасные копии)
//    + доп. данные (второй телефон, заметки — у каждого питомца свои) → KV Worker'а
// 2) пользователь нажимает "Open Telegram" → бот привязывает к чату ВСЕ жетоны заказа
// Тексты — из js/i18n.js (функция t); карточки жетонов (питомец / запасной) — js/app.js (window.FYP_family)
// ============================================================
(function () {
    const form = document.getElementById("registerForm");
    const errEl = document.getElementById("formError");
    const btn = document.getElementById("orderBtn");

    function looksLikePhone(v) {
        const d = String(v || "").replace(/\D/g, "");
        return d.length >= 9 && d.length <= 15;
    }
    function showError(key, noScroll) {
        errEl.textContent = key ? t(key) : "";
        if (key && !noScroll) errEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Ошибка у самого поля: подсветка, текст под полем, aria-invalid; фокус — на первое ошибочное поле
    let errSeq = 0;
    function fieldErr(el, key) {
        const lab = el.closest("label") || el.parentElement;
        let m = lab.querySelector(".field-err");
        if (!m) { m = document.createElement("small"); m.className = "field-err"; m.id = "ferr" + (++errSeq); lab.appendChild(m); }
        m.dataset.t = key; m.textContent = t(key);
        el.setAttribute("aria-invalid", "true");
        el.setAttribute("aria-describedby", m.id);
        lab.classList.add("invalid");
    }
    function clearField(el) {
        const lab = el.closest("label") || el.parentElement;
        el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby");
        if (lab) { lab.classList.remove("invalid"); const m = lab.querySelector(".field-err"); if (m) m.remove(); }
    }
    function clearErrors() { form.querySelectorAll('[aria-invalid="true"]').forEach(clearField); }
    form.addEventListener("input", function (e) { if (e.target.getAttribute && e.target.getAttribute("aria-invalid")) clearField(e.target); });
    form.addEventListener("change", function (e) { if (e.target.type === "checkbox" && e.target.getAttribute("aria-invalid")) clearField(e.target); });
    // Воронка заказа (без личных данных): выбор тарифа → начал заполнять → отправил → открыл Telegram.
    // Счётчики видит админ в боте командой /stats.
    function track(e) {
        try {
            const body = JSON.stringify({ e: e, lang: typeof currentLang !== "undefined" ? currentLang : "en" });
            const url = API_URL + "/api/ev";
            if (!(navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "application/json" })))) {
                fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
            }
        } catch (err) { /* аналитика не должна мешать заказу */ }
    }
    // Ключ повтора: если ответ потерялся и человек нажал «Заказать» ещё раз, второй заказ не создастся
    const newIdem = () => { try { return crypto.randomUUID(); } catch (e) { return Date.now().toString(36) + Math.random().toString(36).slice(2, 12); } };
    let idem = newIdem();

    // Защита от ботов (Cloudflare Turnstile): включается, когда Worker отдаёт TURNSTILE_SITE_KEY в /js/plans.js
    const tsKey = typeof TURNSTILE_SITE_KEY !== "undefined" ? TURNSTILE_SITE_KEY : "";
    let tsToken = "", tsWidget = null;
    function loadTurnstile() {
        if (!tsKey || document.getElementById("tsScript")) return;
        window.fypTsReady = function () {
            tsWidget = window.turnstile.render("#tsBox", {
                sitekey: tsKey, size: "flexible", language: typeof currentLang !== "undefined" ? currentLang : "auto",
                callback: function (tok) { tsToken = tok; }, "expired-callback": function () { tsToken = ""; }
            });
        };
        const sc = document.createElement("script");
        sc.id = "tsScript"; sc.async = true;
        sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=fypTsReady&render=explicit";
        document.head.appendChild(sc);
    }
    function resetTurnstile() { tsToken = ""; try { if (tsWidget !== null) window.turnstile.reset(tsWidget); } catch (e) {} }

    let startedForm = false;
    form.addEventListener("input", function () { if (!startedForm) { startedForm = true; track("form"); } });

    const selectedQty = () => +((form.querySelector('input[name="qty"]:checked') || {}).value || 1);

    // Форма заказа скрыта, пока не нажали «Заказать» в карточке: 1 жетон или 3 + 1
    const orderSec = document.getElementById("order");
    function markChosen(qty) {
        document.querySelectorAll(".plan").forEach(function (p) {
            p.classList.toggle("chosen", p.dataset.plan === (qty >= bundleSize() ? "bundle" : "one"));
        });
    }
    function openOrder(qty) {
        orderSec.classList.remove("closed");
        loadTurnstile();
        if (qty) {
            const r = form.querySelector('input[name="qty"][value="' + qty + '"]');
            if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
        }
        markChosen(selectedQty());
    }
    document.querySelectorAll(".choose").forEach(function (b) {
        b.addEventListener("click", function () {
            track("plan");
            openOrder(+b.dataset.qty || 1);
            requestAnimationFrame(function () { orderSec.scrollIntoView({ behavior: "smooth" }); });
        });
    });
    form.querySelectorAll('input[name="qty"]').forEach(function (r) { r.addEventListener("change", function () { markChosen(selectedQty()); }); });
    if (location.hash === "#order") openOrder();

    let lastOrder = null;
    document.getElementById("telegramLinkBtn").addEventListener("click", function () { track("tg"); });
    function renderDone() {
        if (!lastOrder) return;
        const d = lastOrder;
        document.getElementById("orderIdDisplay").textContent = d.order_id || ("#" + d.id_tag);
        const list = document.getElementById("doneTags");
        list.textContent = "";
        (d.tags || [{ id_tag: d.id_tag, pet_name: "", copies: 1, tag_url: d.tag_url }]).forEach(function (tg) {
            const li = document.createElement("li");
            const b = document.createElement("b");
            b.textContent = tg.copies > 1
                ? t("dtMany", { name: tg.pet_name, id: tg.id_tag, n: tg.copies, s: tg.copies - 1 })
                : t("dtOne", { name: tg.pet_name, id: tg.id_tag });
            const a = document.createElement("a");
            a.href = tg.tag_url; a.target = "_blank"; a.rel = "noopener"; a.className = "ltr";
            a.textContent = tg.tag_url;
            li.appendChild(b); li.appendChild(a);
            list.appendChild(li);
        });
        const ct = document.getElementById("connectText");
        ct.dataset.t = "connectTg";
        ct.textContent = t(ct.dataset.t);
    }
    if (typeof onLang === "function") onLang(renderDone);

    form.addEventListener("submit", async function (e) {
        e.preventDefault();
        showError("");
        const val = (id) => (document.getElementById(id).value || "").trim();
        const qty = selectedQty();
        const fam = window.FYP_family ? window.FYP_family() : { pets: [], spare_for: [], pet_extras: [] };
        const multi = qty >= 2;
        const payload = {
            owner_name: val("ownerName"),
            phone: val("ownerPhone"),
            pet_name: val("petName"),
            address: val("shippingAddress"),
            phone2: multi ? "" : val("phone2"),
            notes: multi ? "" : val("notes"),
            consent: document.getElementById("consent").checked,
            tags: qty,
            care: document.getElementById("careOpt").checked,
            pets: multi ? fam.pets : [],
            spare_for: multi ? fam.spare_for : [],
            pet_extras: multi ? fam.pet_extras : [],
            lang: currentLang,
            idem: idem,
            ts: tsToken
        };
        clearErrors();
        const el = (id) => document.getElementById(id);
        const bad = [];
        if (!payload.pet_name) bad.push([el("petName"), "errReq"]);
        if (!payload.owner_name) bad.push([el("ownerName"), "errReq"]);
        if (multi) {
            document.querySelectorAll(".ftag:not([hidden]) .ft-pet-box:not([hidden]) .ft-name").forEach(function (n) {
                if (!n.value.trim()) bad.push([n, "errReq"]);
            });
            document.querySelectorAll(".ftag:not([hidden]) .ft-phone2").forEach(function (n) {
                if (n.value.trim() && !looksLikePhone(n.value)) bad.push([n, "errPhone2"]);
            });
        }
        if (!payload.phone) bad.push([el("ownerPhone"), "errReq"]);
        else if (!looksLikePhone(payload.phone)) bad.push([el("ownerPhone"), "errPhone"]);
        if (!payload.address) bad.push([el("shippingAddress"), "errReq"]);
        if (payload.phone2 && !looksLikePhone(payload.phone2)) bad.push([el("phone2"), "errPhone2"]);
        if (!payload.consent) bad.push([el("consent"), "errConsent"]);
        if (bad.length) {
            bad.forEach(function (b) { fieldErr(b[0], b[1]); });
            // общая строка над кнопкой — для экранных дикторов и как сводка
            showError(bad.some(function (b) { return b[1] === "errReq"; }) ? (multi && fam.missing ? "errPet2" : "errFill") : bad[0][1], true);
            const first = bad[0][0];
            const details = first.closest("details");
            if (details) details.open = true;
            first.focus({ preventScroll: true });
            first.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }

        if (tsKey && !tsToken) return showError("errCaptcha");

        btn.disabled = true;
        const label = btn.querySelector("[data-t]");
        label.textContent = t("processing");
        try {
            const res = await fetch(API_URL + "/api/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                idem = newIdem();
                resetTurnstile();
                lastOrder = data;
                track("submit");
                form.hidden = true;
                const step = document.getElementById("telegramStep");
                step.hidden = false;
                document.getElementById("telegramLinkBtn").href = data.telegram_link;
                renderDone();
                step.scrollIntoView({ behavior: "smooth", block: "center" });
            } else {
                const code = String(data.error_code || data.error || "");
                if (code === "captcha") resetTurnstile();
                showError(/phone2/i.test(code) ? "errPhone2" : /phone/i.test(code) ? "errPhone" : /consent/i.test(code) ? "errConsent" : /fill/i.test(code) ? "errFill"
                    : code === "captcha" ? "errCaptcha" : code === "busy" ? "errBusy" : "errGeneric");
            }
        } catch (err) {
            console.error(err);
            showError("errNetwork");
        } finally {
            btn.disabled = false;
            label.textContent = t("orderBtn");
        }
    });
})();
