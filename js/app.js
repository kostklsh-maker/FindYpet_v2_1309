// ============================================================
// Форма заказа на главной FindYpet: 1, 2 или 4 (3 + 1) жетона,
// карточки «Метка 1…4» (свой питомец или запасной жетон), итог и предложение 3 + 1.
// Отправку делает register-form.js (берёт состав заказа из window.FYP_family).
// Зависит от i18n.js (t, onLang, money, priceOf, orderTotal, bundleSize)
// ============================================================
(function () {
    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const form = $("#registerForm");
    if (!form) return;
    const petIn = $("#petName");

    // ---------- 1, 2 или 4 (3 + 1) жетона: итог ----------
    const qty = function () { const r = $('input[name="qty"]:checked'); return r ? +r.value : 1; };
    const multi = function () { return qty() >= 2; };
    const range = function (a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };
    const setText = function (sel, txt) { const el = $(sel); if (el) el.textContent = txt; };
    function renderSummary() {
        const q = qty();
        setText("#sumPrice", money(orderTotal(q)));
        setText("#formTotal", t("formTotal", { n: q, sum: money(orderTotal(q)) }));
        const free = $("#sumFreeRow");
        if (free) free.hidden = q < bundleSize();
        $$(".plan-pick label").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); });
        // 2 жетона: ещё один за 49 ₪ — и четвёртый в подарок (блок раскрывается плавно, скрытый — недоступен)
        const up = $("#upsell");
        if (up) {
            const open = q === 2;
            up.classList.toggle("open", open);
            up.inert = !open;
            up.setAttribute("aria-hidden", open ? "false" : "true");
        }
        setText("#upsellText", t("upsell", { tag: money(priceOf("tag")), n: bundleSize(), bundle: money(priceOf("bundle")) }));
    }
    const upBtn = $("#upsellBtn");
    if (upBtn) upBtn.addEventListener("click", function () {
        const r = $('input[name="qty"][value="' + bundleSize() + '"]');
        if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
    });

    // ---------- Карточки «Метка 1…4» ----------
    // Метка 1 — питомец из поля «Кличка». Остальные — свой питомец (кличка, второй контакт, заметки)
    // или галочка «Запасная» + для какого питомца. По умолчанию в 3 + 1 метка 4 (подарок) — запасная.
    const ftags = $$(".ftag");
    const isSpare = function (i) { return i > 0 && i < qty() && ftags[i].querySelector(".ft-spare-chk").checked; };
    const cardName = function (i) {
        const v = i === 0 ? petIn.value.trim() : ftags[i].querySelector(".ft-name").value.trim();
        return v || t("petN", { i: i + 1 });
    };
    // Состав заказа для register-form.js
    function famData() {
        if (!multi()) return { pets: [], spare_for: [], pet_extras: [], missing: false, items: [{ name: petIn.value.trim() || t("petN", { i: 1 }), copies: 1 }] };
        const n = qty();
        const petCards = range(0, n).filter(function (i) { return !isSpare(i); });
        const items = petCards.map(function (i) {
            const c = ftags[i];
            return { name: cardName(i), copies: 1, card: i,
                phone2: c.querySelector(".ft-phone2").value.trim(), notes: c.querySelector(".ft-notes").value.trim() };
        });
        const spareFor = [];
        range(1, n).forEach(function (i) {
            if (!isSpare(i)) return;
            const want = +ftags[i].querySelector(".ft-for-sel").value || 0;
            const idx = Math.max(petCards.indexOf(want), 0);
            spareFor.push(idx);
            items[idx].copies++;
        });
        return {
            pets: petCards.slice(1).map(function (i) { return ftags[i].querySelector(".ft-name").value.trim(); }),
            spare_for: spareFor,
            pet_extras: items.map(function (it) { return { phone2: it.phone2, notes: it.notes }; }),
            missing: petCards.slice(1).some(function (i) { return !ftags[i].querySelector(".ft-name").value.trim(); }),
            items: items
        };
    }
    window.FYP_family = famData;
    function renderOrder() {
        const fam = multi(), n = qty();
        $("#familyBox").hidden = !fam;
        $("#moreBox").hidden = fam;   // при нескольких жетонах второй контакт и заметки — в карточке каждой метки
        setText("#famTitle", t("famQ", { n: n }));
        const petCards = range(0, n).filter(function (i) { return !isSpare(i); });
        ftags.forEach(function (c, i) {
            c.hidden = i >= n;
            c.querySelector(".ft-n").textContent = t("tagN", { n: i + 1 });
            const gift = c.querySelector(".ft-gift");
            if (gift) gift.hidden = n < bundleSize();
            if (i === 0) { setText("#ft0Name", petIn.value.trim()); return; }
            const spare = isSpare(i);
            c.classList.toggle("is-spare", spare);
            c.querySelector(".ft-pet-box").hidden = spare;
            c.querySelector(".ft-for").hidden = !spare;
            const sel = c.querySelector(".ft-for-sel"), keep = sel.value;
            sel.textContent = "";
            petCards.forEach(function (pi) {
                const o = document.createElement("option");
                o.value = String(pi); o.textContent = cardName(pi);
                sel.appendChild(o);
            });
            // при первом показе keep = "" → выбираем питомца 1 (иначе поле выглядит пустым)
            sel.value = keep !== "" && petCards.indexOf(+keep) >= 0 ? keep : "0";
        });
        const d = famData();
        const ul = $("#famSummary");
        ul.textContent = "";
        if (fam) d.items.forEach(function (it) {
            const li = document.createElement("li");
            li.textContent = it.copies > 1 ? t("fsMany", { name: it.name, n: it.copies, s: it.copies - 1 }) : t("fsOne", { name: it.name });
            ul.appendChild(li);
        });
        setText("#sumTags", String(n));   // сколько физических жетонов
    }
    ftags.forEach(function (c) {
        c.querySelectorAll("input, select, textarea").forEach(function (el) {
            el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", renderOrder);
        });
    });
    petIn.addEventListener("input", renderOrder);

    // 1 жетон ↔ несколько: второй контакт и заметки переезжают между общим блоком и карточкой «Метка 1»
    let wasMulti = multi();
    function carryExtras() {
        const now = multi();
        if (now === wasMulti) return;
        const c0 = ftags[0], pairs = [["#phone2", ".ft-phone2"], ["#notes", ".ft-notes"]];
        pairs.forEach(function (p) {
            const one = $(p[0]), card = c0.querySelector(p[1]);
            const from = now ? one : card, to = now ? card : one;
            if (from.value.trim() && !to.value.trim()) to.value = from.value;
        });
        if (now && (c0.querySelector(".ft-phone2").value || c0.querySelector(".ft-notes").value)) c0.querySelector(".ft-more").open = true;
        wasMulti = now;
    }
    $$('input[name="qty"]').forEach(function (r) { r.addEventListener("change", function () { carryExtras(); renderSummary(); renderOrder(); }); });
    // Кнопки «Выбрать» (логика выбора — в register-form.js), тут только обновляем итог
    $$(".choose").forEach(function (b) { b.addEventListener("click", function () { setTimeout(function () { renderSummary(); renderOrder(); }, 0); }); });

    // Шаг 3 «Telegram» подсвечивается после успешного заказа
    const tgStep = $("#telegramStep"), stTg = $("#stTg");
    if (tgStep && stTg) new MutationObserver(function () { stTg.classList.toggle("on", !tgStep.hidden); })
        .observe(tgStep, { attributes: true, attributeFilter: ["hidden"] });

    function renderAll() { renderSummary(); renderOrder(); }
    onLang(renderAll);
    renderAll();
})();
