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
        address: document.getElementById("shippingAddress").value
    };

    try {
        // Запрос отправляется как text/plain, чтобы обойти CORS-блокировку Google Apps Script
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
        submitBtn.innerText = "Order Now — 100 ₪";
    }
});
        }
    } catch (err) {
        alert("Could not reach the server. Please try again later.");
        console.error(err);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = "Order Now — 100 ₪";
    }
});
