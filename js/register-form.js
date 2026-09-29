// ============================================================
// Обработчик формы регистрации FindYpet
// ============================================================

// Цены из config.js → в карточки тарифов и в выбор в форме
document.querySelectorAll("[data-price]").forEach(function (el) {
    const p = PLANS[el.dataset.price];
    el.textContent = p ? p.price : "";
});

// Кнопка «Choose» на карточке → выбирает тариф в форме и прокручивает к ней
document.querySelectorAll(".choose").forEach(function (b) {
    b.addEventListener("click", function () {
        const r = document.querySelector('input[name="plan"][value="' + b.dataset.plan + '"]');
        if (r) r.checked = true;
        document.getElementById("order").scrollIntoView({ behavior: "smooth" });
    });
});

document.getElementById("registerForm").addEventListener("submit", async function (e) {
    e.preventDefault();

    const submitBtn = e.target.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.innerText = "Processing...";

    const payload = {
        action: "register",
        owner_name: document.getElementById("ownerName").value,
        phone: document.getElementById("ownerPhone").value,
        pet_name: document.getElementById("petName").value,
        address: document.getElementById("shippingAddress").value,
        plan: (document.querySelector('input[name="plan"]:checked') || {}).value || "smart"
    };

    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.success) {
            document.getElementById("registerForm").style.display = "none";
            document.getElementById("telegramStep").style.display = "block";
            document.getElementById("telegramLinkBtn").href = data.telegram_link;
            document.getElementById("tagIdDisplay").innerText = data.id_tag;
        } else {
            alert("Error from server: " + (data.error || "Unknown error"));
        }
    } catch (err) {
        alert("Could not reach the server. Check browser console (F12).");
        console.error(err);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = "Order Now";
    }
});
