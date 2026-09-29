// ============================================================
// Регистрация на сайте FindYpet
// 1) данные → Worker → таблица FindYpetDatabase (новый tag_id)
//    + доп. данные (второй телефон, заметки) → KV Worker'а
// 2) пользователь нажимает "Open Telegram" → бот привязывает его chat id
// Тексты берутся из js/i18n.js (функция t)
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

    // Кнопки "Выбрать" в карточках тарифов → отмечаем тариф в форме и переходим к ней
    document.querySelectorAll(".choose").forEach(function (b) {
        b.addEventListener("click", function () {
            const r = form.querySelector('input[name="plan"][value="' + b.dataset.plan + '"]');
            if (r) r.checked = true;
            document.getElementById("order").scrollIntoView({ behavior: "smooth" });
        });
    });

    form.addEventListener("submit", async function (e) {
        e.preventDefault();
        showError("");
        const val = (id) => (document.getElementById(id).value || "").trim();
        const payload = {
            owner_name: val("ownerName"),
            phone: val("ownerPhone"),
            pet_name: val("petName"),
            address: val("shippingAddress"),
            phone2: val("phone2"),
            notes: val("notes"),
            consent: document.getElementById("consent").checked,
            plan: (form.querySelector('input[name="plan"]:checked') || {}).value || "smart",
            lang: currentLang
        };
        if (!payload.owner_name || !payload.phone || !payload.pet_name || !payload.address) return showError("errFill");
        if (!looksLikePhone(payload.phone)) return showError("errPhone");
        if (payload.phone2 && !looksLikePhone(payload.phone2)) return showError("errPhone2");
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
                form.hidden = true;
                const step = document.getElementById("telegramStep");
                step.hidden = false;
                document.getElementById("telegramLinkBtn").href = data.telegram_link;
                document.getElementById("tagIdDisplay").textContent = data.id_tag;
                const link = document.getElementById("tagUrlDisplay");
                link.href = data.tag_url;
                link.textContent = data.tag_url;
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
