// ============================================================
// Интерактив главной страницы FindYpet
// (жетон-перевёртыш, демо «4 шага», вкладки для нашедшего,
//  переключатель «Потерялся», калькулятор питомцев, живой превью жетона)
// Зависит от i18n.js (t, onLang, planNum, money)
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

    // ---------- Жетон-перевёртыш ----------
    const flip = $("#flipTag");
    let flipTimer = null;
    function autoFlip() { flip.classList.toggle("flipped"); }
    if (!reduced) flipTimer = setInterval(autoFlip, 3800);
    flip.addEventListener("click", function () {
        clearInterval(flipTimer);
        flip.classList.toggle("flipped");
    });

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

    // ---------- Тарифы: сколько питомцев ----------
    const plans = $$(".plan");
    let pets = 1;
    function renderPets() {
        const smart = planNum("smart"), family = planNum("family");
        const three = smart * 3, save = three - family;
        let rec = "smart", text;
        if (pets === 1) text = t("rec1");
        else if (pets === 2) { rec = "family"; text = t("rec2", { two: money(smart * 2), family: money(family) }); }
        else { rec = "family"; text = t("rec3", { family: money(family), three: money(three), save: money(save) }); }
        $("#petsRec").textContent = smart ? text : "";
        plans.forEach(function (p) { p.classList.toggle("recommended", p.dataset.plan === rec); });
        const badge = $("#familySave");
        badge.textContent = save > 0 ? t("saveBadge", { save: money(save) }) : "";
        badge.hidden = !(save > 0);
    }
    tabs($("#petsSeg"), "pets", function (n) {
        pets = +n; renderPets();
        setFamN(pets); // в форме Семейного тарифа сразу стоит то же число питомцев
    });

    // ---------- Заказ: живой превью жетона и итог ----------
    const petIn = $("#petName"), phoneIn = $("#ownerPhone");
    function renderPreview() {
        const name = (petIn.value || "").trim();
        $("#pvName").textContent = (name || t("bella")).toUpperCase();
        const ph = (phoneIn.value || "").trim();
        $("#pvPhone").textContent = ph || "050-123-4567";
        $("#pvName").classList.toggle("long", (name || "BELLA").length > 8);
    }
    function renderSummary() {
        const r = $('input[name="plan"]:checked');
        const id = r ? r.value : "smart";
        const names = { basic: "planBasic", smart: "planSmart", family: "planFamily" };
        $("#sumPlan").textContent = t(names[id]);
        $("#sumPrice").textContent = (typeof PLANS !== "undefined" && PLANS[id]) ? PLANS[id].price : "";
        $$(".plan-pick label").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); });
    }
    // ---------- Заказ: Семейный тариф (питомцы и запасные), Базовый (без доп. полей) ----------
    const planId = function () { const r = $('input[name="plan"]:checked'); return r ? r.value : "smart"; };
    const slots = function () {
        const p = typeof PLANS !== "undefined" && PLANS[planId()];
        return p && p.tags ? p.tags : (planId() === "family" ? 3 : 1);
    };
    // Семейный: 3 карточки «Метка 1/2/3». Метка 1 — питомец из поля «Кличка». Метки 2 и 3 — свой питомец
    // (кличка, второй контакт, заметки) или галочка «Запасная» + для какого питомца.
    const ftags = $$(".ftag");
    const isSpare = function (i) { return i > 0 && planId() === "family" && ftags[i].querySelector(".ft-spare-chk").checked; };
    const cardName = function (i) {
        const v = i === 0 ? petIn.value.trim() : ftags[i].querySelector(".ft-name").value.trim();
        return v || t("petN", { i: i + 1 });
    };
    // Состав заказа для register-form.js
    function famData() {
        if (planId() !== "family") return { pets: [], spare_for: [], pet_extras: [], missing: false, items: [{ name: petIn.value.trim() || t("petN", { i: 1 }), copies: 1 }] };
        const petCards = [0, 1, 2].filter(function (i) { return !isSpare(i); });
        const items = petCards.map(function (i) {
            const c = ftags[i];
            return { name: cardName(i), copies: 1, card: i,
                phone2: c.querySelector(".ft-phone2").value.trim(), notes: c.querySelector(".ft-notes").value.trim() };
        });
        const spareFor = [];
        [1, 2].forEach(function (i) {
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
    // Подсказка «Сколько питомцев?» в разделе цен: 1 → метки 2 и 3 запасные, 2 → метка 3 запасная, 3 → все свои
    function setFamN(n) {
        n = Math.min(Math.max(+n || 1, 1), 3);
        [1, 2].forEach(function (i) { ftags[i].querySelector(".ft-spare-chk").checked = i >= n; });
        renderOrder();
    }
    function renderOrder() {
        const fam = planId() === "family", basic = planId() === "basic";
        $("#familyBox").hidden = !fam;
        $("#moreBox").hidden = basic || fam;   // в Семейном второй контакт и заметки — в карточке каждой метки
        $("#basicNote").hidden = !basic;
        const petCards = [0, 1, 2].filter(function (i) { return !isSpare(i); });
        ftags.forEach(function (c, i) {
            c.querySelector(".ft-n").textContent = t("tagN", { n: i + 1 });
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
            sel.value = petCards.indexOf(+keep) >= 0 ? keep : "0";
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
        const total = slots();
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
    $$('input[name="plan"]').forEach(function (r) { r.addEventListener("change", function () { renderSummary(); renderOrder(); }); });
    // Кнопки «Выбрать» (логика выбора — в register-form.js), тут только обновляем итог
    $$(".choose").forEach(function (b) { b.addEventListener("click", function () { setTimeout(function () { renderSummary(); renderOrder(); }, 0); }); });

    // Шаг 3 «Telegram» подсвечивается после успешного заказа
    const tgStep = $("#telegramStep");
    new MutationObserver(function () { $("#stTg").classList.toggle("on", !tgStep.hidden); })
        .observe(tgStep, { attributes: true, attributeFilter: ["hidden"] });

    function renderAll() { renderPets(); renderPreview(); renderSummary(); renderOrder(); }
    onLang(renderAll);
    renderAll();
})();
