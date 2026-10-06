# Проверка заказа на сайте (модель v13): жетон 49 ₪, 2 жетона 98 ₪, 3 + 1 = 147 ₪ за 4, «Забота» — скоро.
# Сценарии покупателя: 1 питомец; 2 питомца (подсказка «+49 ₪ → 3 + 1»); 3 питомца + подарок; переход из карточки 3 + 1.
# Нужен запущенный node worker/test/server.mjs
import asyncio, os, json
from playwright.async_api import async_playwright
OUT = os.path.join(os.path.dirname(__file__), 'shots')
PETS = {'en': ('Bella', 'Rex', 'Milo'), 'he': ('בלה', 'רקס', 'מילו'), 'ru': ('Белла', 'Рекс', 'Мило')}


async def state(pg):
    return await pg.evaluate("""() => ({
        qty: +document.querySelector('input[name=qty]:checked').value,
        sum: document.querySelector('#sumPrice').textContent,
        tags: document.querySelector('#sumTags').textContent,
        free: !document.querySelector('#sumFreeRow').hidden,
        upsell: document.querySelector('#upsell').hidden ? '' : document.querySelector('#upsell').innerText.replace(/\\n/g, ' '),
        cards: [...document.querySelectorAll('.ftag')].filter(c => !c.hidden && c.offsetParent).length,
        spares: [...document.querySelectorAll('.ftag')].filter(c => !c.hidden && c.offsetParent && c.classList.contains('is-spare')).length,
        gift: [...document.querySelectorAll('.ft-gift')].some(g => !g.hidden && g.offsetParent),
        title: document.querySelector('#famTitle').textContent,
        chosen: document.querySelector('.plan.chosen')?.dataset.plan || '',
        summary: [...document.querySelectorAll('#famSummary li')].map(l => l.textContent),
    })""")


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for lang in ['en', 'he', 'ru']:
            ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, reduced_motion='reduce')
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.goto('http://localhost:8787/')
            await pg.evaluate(f"localStorage.setItem('fyp_lang','{lang}')")
            await pg.goto('http://localhost:8787/')
            await pg.evaluate("document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'))")
            r = {'lang': lang}
            r['hero'] = (await pg.inner_text('.hero-price')).replace('\n', ' ')
            r['prices'] = await pg.evaluate("[...document.querySelectorAll('.plan .plan-price')].map(e => e.textContent)")
            r['bundlePer'] = await pg.inner_text('#bundlePer')
            r['plansSub'] = await pg.inner_text('#plans .sub')
            r['orderClosed'] = not await pg.is_visible('#order')
            await pg.locator('#plans').screenshot(path=f'{OUT}/plans_{lang}.png')
            # A. «Заказать жетон» → 1 жетон
            await pg.click('.choose[data-qty="1"]'); await pg.wait_for_timeout(250)
            r['A_one'] = await state(pg)
            # B. владелец двух питомцев выбирает «2 жетона» → подсказка про 3 + 1
            await pg.click('.qty-pick label:nth-of-type(2)'); await pg.wait_for_timeout(200)
            r['B_two'] = await state(pg)
            a, c, m = PETS[lang]
            await pg.fill('#petName', a); await pg.fill('#ownerName', 'Kostya')
            await pg.fill('#ownerPhone', '050-123-4567'); await pg.fill('#shippingAddress', 'Haifa')
            await pg.check('#consent')
            await pg.click('#orderBtn'); await pg.wait_for_timeout(200)
            r['B_err_no_name'] = await pg.inner_text('#formError')
            await pg.locator('.qty-pick').screenshot(path=f'{OUT}/qty_two_{lang}.png')
            await pg.locator('#registerForm').screenshot(path=f'{OUT}/order_two_{lang}.png')
            # C. жмёт «Перейти на 3 + 1» → 4 карточки, 4-я запасная (подарок)
            await pg.click('#upsellBtn'); await pg.wait_for_timeout(250)
            r['C_bundle'] = await state(pg)
            t2 = pg.locator('.ftag[data-i="1"]'); t3 = pg.locator('.ftag[data-i="2"]'); t4 = pg.locator('.ftag[data-i="3"]')
            await t2.locator('.ft-name').fill(c)
            await t3.locator('.ft-name').fill(m)
            await t2.locator('summary').click()
            await t2.locator('.ft-phone2').fill('052-765-4321'); await t2.locator('.ft-notes').fill('Shy')
            await t4.locator('.ft-for-sel').select_option('1')
            await pg.check('#careOpt')
            r['C_filled'] = await state(pg)
            r['C_pv'] = (await pg.inner_text('#pvList')).replace('\n', ' ')
            await pg.locator('#familyBox').screenshot(path=f'{OUT}/family_box_{lang}.png')
            await pg.locator('#order').screenshot(path=f'{OUT}/order_bundle_{lang}.png')
            body = None
            async def grab(req):
                nonlocal body
                if req.url.endswith('/api/register'): body = json.loads(req.post_data)
            pg.on('request', grab)
            await pg.click('#orderBtn'); await pg.wait_for_timeout(900)
            r['C_payload'] = {k: body[k] for k in ['tags', 'pets', 'spare_for', 'care']} if body else None
            r['C_done'] = (await pg.inner_text('#doneTags')).replace('\n', ' / ')
            await pg.locator('#order').screenshot(path=f'{OUT}/order_done_{lang}.png')
            # D. новый посетитель: сразу карточка 3 + 1
            await pg.goto('http://localhost:8787/')
            await pg.evaluate("document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'))")
            await pg.click('.choose[data-qty="4"]'); await pg.wait_for_timeout(250)
            r['D_from_card'] = await state(pg)
            r['sw'] = await pg.evaluate('document.documentElement.scrollWidth')
            r['errs'] = errs
            print(json.dumps(r, ensure_ascii=False, indent=1))
            await ctx.close()
        await b.close()

asyncio.run(main())
