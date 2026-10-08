// ============================================================
// Интерактив главной страницы FindYpet
// (жетон днём и ночью, демо «4 шага», вкладки для нашедшего,
//  переключатель «Потерялся», калькулятор питомцев, живой превью жетона)
// Зависит от i18n.js (t, onLang, money, priceOf, orderTotal)
// ============================================================
(function () {
    const $ = (s, r) => (r || document).querySelector(s);
    const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---------- Появление блоков при прокрутке ----------
    const revealEls = $$(".reveal");
    if ("IntersectionObserver" in window && !reduced) {
        const io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
            });
        }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
        revealEls.forEach(function (el) { io.observe(el); });
    } else {
        revealEls.forEach(function (el) { el.classList.add("in"); });
    }

    // ---------- Шапка: тень при прокрутке, мобильная панель заказа ----------
    const header = $("#siteHeader"), bar = $("#stickyBar"), hero = $("#top"), order = $("#order");
    let orderVisible = false;
    if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (en) { orderVisible = en[0].isIntersecting; onScroll(); }, { threshold: 0.05 }).observe(order);
    }
    function onScroll() {
        const y = window.scrollY;
        header.classList.toggle("scrolled", y > 8);
        const show = y > hero.offsetHeight * 0.8 && !orderVisible;
        bar.classList.toggle("show", show);
        bar.setAttribute("aria-hidden", show ? "false" : "true");
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // ---------- Жетон днём и ночью: корпус светится в темноте ----------
    // Один раз сам показывает ночь (если человек ещё не нажал кнопку), дальше — только по кнопке.
    const hv = $("#heroVisual"), glowBtn = $("#glowBtn"), glowLbl = $("#glowLbl");
    let glowTouched = false;
    function setNight(on) {
        hv.classList.toggle("night", on);
        glowBtn.setAttribute("aria-pressed", on ? "true" : "false");
        glowLbl.dataset.t = on ? "glowBtnDay" : "glowBtn";
        glowLbl.textContent = t(glowLbl.dataset.t);
    }
    glowBtn.addEventListener("click", function () { glowTouched = true; setNight(!hv.classList.contains("night")); });
    if (!reduced) {
        setTimeout(function () {
            if (glowTouched) return;
            setNight(true);
            setTimeout(function () { if (!glowTouched) setNight(false); }, 2800);
        }, 2400);
    }

    // ---------- Демо «4 шага» ----------
    const steps = $$(".demo-step"), screens = $$(".scr");
    const STEP_MS = 4200;
    let cur = 0, demoTimer = null, playing = false;
    function show(i) {
        cur = i;
        steps.forEach(function (b, k) {
            b.classList.toggle("on", k === i);
            b.classList.toggle("done", k < i);
            b.setAttribute("aria-selected", k === i ? "true" : "false");
        });
        screens.forEach(function (s, k) { s.classList.toggle("on", k === i); });
    }
    function play() {
        if (reduced) return;
        playing = true;
        $(".demo").classList.add("playing");
        clearInterval(demoTimer);
        demoTimer = setInterval(function () { show((cur + 1) % steps.length); }, STEP_MS);
    }
    function stop() {
        playing = false;
        $(".demo").classList.remove("playing");
        clearInterval(demoTimer);
    }
    steps.forEach(function (b, i) {
        b.addEventListener("click", function () { stop(); show(i); });
    });
    if ("IntersectionObserver" in window) {
        let started = false;
        new IntersectionObserver(function (en) {
            if (en[0].isIntersecting && !started) { started = true; play(); }
        }, { threshold: 0.35 }).observe($(".demo"));
    }
    show(0);

    // ---------- Вкладки для нашедшего ----------
    function tabs(group, attr, onPick) {
        const btns = $$("button", group);
        btns.forEach(function (b) {
            b.setAttribute("aria-selected", b.classList.contains("on") ? "true" : "false");
            b.addEventListener("click", function () {
                btns.forEach(function (x) {
                    x.classList.toggle("on", x === b);
                    x.setAttribute("aria-selected", x === b ? "true" : "false");
                });
                onPick(b.dataset[attr]);
            });
        });
    }
    tabs($("#finderTabs"), "way", function (way) {
        $$(".way-panel").forEach(function (p) { p.classList.toggle("on", p.dataset.panel === way); });
    });
    tabs($("#osTabs"), "os", function (os) {
        $("#phoneSil").classList.toggle("android", os === "android");
        $$(".os-text").forEach(function (p) { p.hidden = p.dataset.osText !== os; });
    });

    // ---------- Переключатель «Потерялся» ----------
    const lostToggle = $("#lostToggle"), mini = $("#miniPage");
    lostToggle.addEventListener("change", function () { mini.classList.toggle("lost", lostToggle.checked); });

    // ---------- Цены: 3 + 1 — сколько выходит за жетон ----------
    // «4 жетона · экономия 49 ₪ · меньше 37 ₪ за жетон» — выгода в шекелях, без агорот
    function renderPricing() {
        const n = bundleSize(), each = priceOf("bundle") / n, save = priceOf("tag") * n - priceOf("bundle");
        const whole = Number.isInteger(each);
        $("#bundlePer").textContent = each ? t(whole ? "bundlePerEq" : "bundlePer", { n: n, tag: money(save), per: money(whole ? each : Math.ceil(each)) }) : "";
    }

    // ---------- Заказ: живой превью жетона и итог ----------
    const petIn = $("#petName"), phoneIn = $("#ownerPhone");
    // Надписи на крышке не шире 26 мм (как в генераторе медальона): длинные сжимаем по ширине
    function fitText(el, max, perChar) {
        el.removeAttribute("textLength"); el.removeAttribute("lengthAdjust");
        let w = 0;
        try { w = el.getComputedTextLength(); } catch (e) { /* не отрисован */ }
        if (!w) w = el.textContent.length * perChar; // форма ещё скрыта — оценка по числу знаков
        if (w > max) { el.setAttribute("textLength", max); el.setAttribute("lengthAdjust", "spacingAndGlyphs"); }
    }
    function renderPreview() {
        const name = (petIn.value || "").trim();
        $("#pvName").textContent = (name || t("bella")).toUpperCase();
        const ph = (phoneIn.value || "").trim();
        $("#pvPhone").textContent = ph || "050-123-4567";
        fitText($("#pvName"), 26, 4.6);
        fitText($("#pvPhone"), 26, 3.3);
    }
    // ---------- Заказ: 1, 2 или 4 (3 + 1) жетона ----------
    const qty = function () { const r = $('input[name="qty"]:checked'); return r ? +r.value : 1; };
    const multi = function () { return qty() >= 2; };
    const range = function (a, b) { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };
    function renderSummary() {
        const q = qty();
        $("#sumPrice").textContent = money(orderTotal(q));
        $("#formTotal").textContent = t("formTotal", { n: q, sum: money(orderTotal(q)) });
        $("#sumFreeRow").hidden = q < bundleSize();
        $$(".plan-pick label").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); });
        // 2 жетона: ещё один за 49 ₪ — и четвёртый в подарок
        const up = $("#upsell");
        up.hidden = q !== 2;
        $("#upsellText").textContent = t("upsell", { tag: money(priceOf("tag")), n: bundleSize(), bundle: money(priceOf("bundle")) });
    }
    $("#upsellBtn").addEventListener("click", function () {
        const r = $('input[name="qty"][value="' + bundleSize() + '"]');
        if (r) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    // 2 или 4 карточки «Метка 1…4». Метка 1 — питомец из поля «Кличка». Остальные — свой питомец
    // (кличка, второй контакт, заметки) или галочка «Запасная» + для какого питомца.
    // По умолчанию в 3 + 1 метка 4 (подарок) — запасная.
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
        $("#famTitle").textContent = t("famQ", { n: n });
        const petCards = range(0, n).filter(function (i) { return !isSpare(i); });
        ftags.forEach(function (c, i) {
            c.hidden = i >= n;
            c.querySelector(".ft-n").textContent = t("tagN", { n: i + 1 });
            const gift = c.querySelector(".ft-gift");
            if (gift) gift.hidden = n < bundleSize();
            if (i === 0) { $("#ft0Name").textContent = petIn.value.trim(); return; }
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
        // Итог и превью: сколько физических жетонов
        const total = n;
        $("#sumTags").textContent = String(total);
        const cnt = $("#pvCount");
        cnt.hidden = total < 2;
        cnt.textContent = "× " + total;
        const pv = $("#pvList");
        pv.hidden = !(fam && d.items.length > 1);
        pv.textContent = "";
        if (!pv.hidden) d.items.forEach(function (it) {
            const li = document.createElement("li");
            li.textContent = it.name.toUpperCase() + (it.copies > 1 ? " ×" + it.copies : "");
            pv.appendChild(li);
        });
    }
    ftags.forEach(function (c) {
        c.querySelectorAll("input, select, textarea").forEach(function (el) {
            el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", renderOrder);
        });
    });
    petIn.addEventListener("input", renderOrder);

    petIn.addEventListener("input", renderPreview);
    phoneIn.addEventListener("input", renderPreview);
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
    $$(".choose").forEach(function (b) { b.addEventListener("click", function () { setTimeout(function () { renderSummary(); renderOrder(); renderPreview(); }, 0); }); });

    // Шаг 3 «Telegram» подсвечивается после успешного заказа
    const tgStep = $("#telegramStep");
    new MutationObserver(function () { $("#stTg").classList.toggle("on", !tgStep.hidden); })
        .observe(tgStep, { attributes: true, attributeFilter: ["hidden"] });

    function renderAll() { renderPricing(); renderPreview(); renderSummary(); renderOrder(); }
    onLang(renderAll);
    renderAll();
})();
