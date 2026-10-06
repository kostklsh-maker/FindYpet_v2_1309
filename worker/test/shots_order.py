# Проверка заказа на сайте: Семейный (2 питомца + запасной), Базовый, экран «что дальше».
# Нужен запущенный node worker/test/server.mjs
import asyncio, os
from playwright.async_api import async_playwright
OUT = os.path.join(os.path.dirname(__file__), 'shots')
PETS = {'en': ('Bella', 'Rex'), 'he': ('בלה', 'רקס'), 'ru': ('Белла', 'Рекс')}


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
            # Базовый: доп. поля скрыты, есть пояснение
            await pg.click('.choose[data-plan="basic"]'); await pg.wait_for_timeout(200)
            basic = (await pg.is_visible('#basicNote'), await pg.is_visible('#moreBox'), await pg.is_visible('#familyBox'))
            # Цены: 2 питомца → подсвечен Семейный; в форме метка 2 — питомец, метка 3 — запасная
            await pg.click('#petsSeg button[data-pets="2"]')
            rec = await pg.evaluate("document.querySelector('.plan.recommended').dataset.plan")
            await pg.click('.choose[data-plan="family"]'); await pg.wait_for_timeout(200)
            fam_n = await pg.evaluate("[...document.querySelectorAll('.ft-spare-chk')].map(c => c.checked)")
            a, c = PETS[lang]
            await pg.fill('#petName', a); await pg.fill('#ownerName', 'Kostya')
            await pg.fill('#ownerPhone', '050-123-4567'); await pg.fill('#shippingAddress', 'Haifa')
            await pg.check('#consent')
            await pg.click('#orderBtn'); await pg.wait_for_timeout(200)
            err = await pg.inner_text('#formError')          # нет клички второго питомца
            tag2 = pg.locator('.ftag[data-i="1"]'); tag3 = pg.locator('.ftag[data-i="2"]')
            await tag2.locator('.ft-name').fill(c)
            await tag2.locator('summary').click()
            await tag2.locator('.ft-phone2').fill('052-765-4321'); await tag2.locator('.ft-notes').fill('Shy')
            await tag3.locator('.ft-for-sel').select_option('1')
            summ = await pg.inner_text('#famSummary'); tags = await pg.inner_text('#sumTags'); pv = await pg.inner_text('#pvList')
            await pg.locator('#order').screenshot(path=f'{OUT}/order_family_{lang}.png')
            await pg.click('#orderBtn'); await pg.wait_for_timeout(900)
            done = await pg.inner_text('#doneTags')
            sw = await pg.evaluate('document.documentElement.scrollWidth')
            print(lang, '| errs', errs, '| basic note/more/fam', basic, '| rec', rec, 'famN', fam_n,
                  '| err:', err, '| summary:', summ.replace('\n', ' / '), '| tags', tags, '| pv', pv.replace('\n', ' '),
                  '| done:', done.replace('\n', ' / '), '| sw', sw)
            await pg.locator('#order').screenshot(path=f'{OUT}/order_done_{lang}.png')
            await ctx.close()
        await b.close()

asyncio.run(main())
