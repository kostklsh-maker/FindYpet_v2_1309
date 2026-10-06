// ============================================================
// Заказ на сайте FindYpet
// 1) данные → Worker → таблица FindYpetDatabase: по строке (tag_id) на каждого питомца
//    (Семейный тариф: до 3 питомцев; оставшиеся жетоны — запасные копии)
//    + доп. данные (второй телефон, заметки — тариф Смарт/Семейный) → KV Worker'а
// 2) пользователь нажимает "Open Telegram" → бот привязывает к чату ВСЕ жетоны заказа
// Тексты — из js/i18n.js (функция t); блок Семейного тарифа — js/app.js (window.FYP_family)
// ============================================================
(function () {
    const form = document.getElementById("registerForm");
    const errEl = document.getElementById("formError");
    const btn = document.getElementById("orderBtn");

    function looksLikePhone(v) {
        const d = String(v || "").replace(/\D/g, "");
        return d.length >= 9 && d.length <= 15;
    }
    function showError(key) {
        errEl.textContent = key ? t(key) : "";
        if (key) errEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    const selectedPlan = () => (form.querySelector('input[name="plan"]:checked') || {}).value || "smart";

    // Форма заказа скрыта, пока не выбран тариф: «Выбрать» в карточке → форма раскрывается под тарифами
    const orderSec = document.getElementById("order");
    function markChosen(plan) {
        document.querySelectorAll(".plan").forEach(function (p) { p.classList.toggle("chosen", p.dataset.plan === plan); });
    }
    function openOrder(plan) {
        orderSec.classList.remove("closed");
        if (plan) {
            const r = form.querySelector('input[name="plan"][value="' + plan + '"]');
            if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
        }
        markChosen(selectedPlan());
    }
    document.querySelectorAll(".choose").forEach(function (b) {
        b.addEventListener("click", function () {
            openOrder(b.dataset.plan);
            requestAnimationFrame(function () { orderSec.scrollIntoView({ behavior: "smooth" }); });
        });
    });
    form.querySelectorAll('input[name="plan"]').forEach(function (r) { r.addEventListener("change", function () { markChosen(selectedPlan()); }); });
    if (location.hash === "#order") openOrder();

    let lastOrder = null;
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
        const basic = d.plan === "basic";
        const ct = document.getElementById("connectText");
        ct.dataset.t = basic ? "connectTgBasic" : "connectTg";
        ct.textContent = t(ct.dataset.t);
    }
    if (typeof onLang === "function") onLang(renderDone);

    form.addEventListener("submit", async function (e) {
        e.preventDefault();
        showError("");
        const val = (id) => (document.getElementById(id).value || "").trim();
        const plan = selectedPlan();
        const fam = window.FYP_family ? window.FYP_family() : { pets: [], spare_for: [] };
        const payload = {
            owner_name: val("ownerName"),
            phone: val("ownerPhone"),
            pet_name: val("petName"),
            address: val("shippingAddress"),
            phone2: plan === "smart" ? val("phone2") : "",
            notes: plan === "smart" ? val("notes") : "",
            consent: document.getElementById("consent").checked,
            plan: plan,
            pets: plan === "family" ? fam.pets : [],
            spare_for: plan === "family" ? fam.spare_for : [],
            pet_extras: plan === "family" ? fam.pet_extras : [],
            lang: currentLang
        };
        if (!payload.owner_name || !payload.phone || !payload.pet_name || !payload.address) return showError("errFill");
        if (plan === "family" && fam.missing) return showError("errPet2");
        if (!looksLikePhone(payload.phone)) return showError("errPhone");
        if (payload.phone2 && !looksLikePhone(payload.phone2)) return showError("errPhone2");
        if (plan === "family" && fam.pet_extras.some(function (e) { return e.phone2 && !looksLikePhone(e.phone2); })) return showError("errPhone2");
        if (!payload.consent) return showError("errConsent");

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
                lastOrder = data;
                if (!lastOrder.plan) lastOrder.plan = plan;
                form.hidden = true;
                const step = document.getElementById("telegramStep");
                step.hidden = false;
                document.getElementById("telegramLinkBtn").href = data.telegram_link;
                renderDone();
                step.scrollIntoView({ behavior: "smooth", block: "center" });
            } else {
                const code = String(data.error_code || data.error || "");
                showError(/phone2/i.test(code) ? "errPhone2" : /phone/i.test(code) ? "errPhone" : /consent/i.test(code) ? "errConsent" : /fill/i.test(code) ? "errFill" : "errGeneric");
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
