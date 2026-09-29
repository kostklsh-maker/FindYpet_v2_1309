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
        else if (pets === 2) text = t("rec2", { two: money(smart * 2), family: money(family) });
        else { rec = "family"; text = t("rec3", { family: money(family), three: money(three), save: money(save) }); }
        $("#petsRec").textContent = smart ? text : "";
        plans.forEach(function (p) { p.classList.toggle("recommended", p.dataset.plan === rec); });
        const badge = $("#familySave");
        badge.textContent = save > 0 ? t("saveBadge", { save: money(save) }) : "";
        badge.hidden = !(save > 0);
    }
    tabs($("#petsSeg"), "pets", function (n) { pets = +n; renderPets(); });

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
    petIn.addEventListener("input", renderPreview);
    phoneIn.addEventListener("input", renderPreview);
    $$('input[name="plan"]').forEach(function (r) { r.addEventListener("change", renderSummary); });
    // Кнопки «Выбрать» (логика выбора — в register-form.js), тут только обновляем итог
    $$(".choose").forEach(function (b) { b.addEventListener("click", function () { setTimeout(renderSummary, 0); }); });

    // Шаг 3 «Telegram» подсвечивается после успешного заказа
    const tgStep = $("#telegramStep");
    new MutationObserver(function () { $("#stTg").classList.toggle("on", !tgStep.hidden); })
        .observe(tgStep, { attributes: true, attributeFilter: ["hidden"] });

    function renderAll() { renderPets(); renderPreview(); renderSummary(); }
    onLang(renderAll);
    renderAll();
})();
