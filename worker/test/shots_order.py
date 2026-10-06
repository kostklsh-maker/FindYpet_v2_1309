# Проверка заказа на сайте (модель v11): жетон 49 ₪, 2 + 1 = 98 ₪ за 3, «Забота» — скоро.
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
            hero = await pg.inner_text('.hero-price')
            prices = await pg.evaluate("[...document.querySelectorAll('.plan .plan-price')].map(e => e.textContent)")
            trio = await pg.inner_text('#trioPer')
            care_href = await pg.get_attribute('.plan-care a', 'href')
            closed = not await pg.is_visible('#order')
            await pg.locator('#plans').screenshot(path=f'{OUT}/plans_{lang}.png')
            # 1 жетон: общие доп. контакт и заметки, 49 ₪
            await pg.click('.choose[data-qty="1"]'); await pg.wait_for_timeout(250)
            one = (await pg.is_visible('#moreBox'), await pg.is_visible('#familyBox'), await pg.inner_text('#sumPrice'), await pg.inner_text('#sumTags'))
            # 2 + 1: три карточки, метка 3 запасная по умолчанию, 98 ₪
            await pg.click('.qty-pick label:nth-of-type(2)'); await pg.wait_for_timeout(200)
            three = (await pg.is_visible('#moreBox'), await pg.is_visible('#familyBox'), await pg.inner_text('#sumPrice'), await pg.inner_text('#sumTags'), await pg.is_visible('#sumFreeRow'))
            chosen = await pg.evaluate("document.querySelector('.plan.chosen')?.dataset.plan")
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
            await pg.check('#careOpt')
            summ = await pg.inner_text('#famSummary'); pv = await pg.inner_text('#pvList')
            await pg.locator('#order').screenshot(path=f'{OUT}/order_family_{lang}.png')
            await pg.click('#orderBtn'); await pg.wait_for_timeout(900)
            done = await pg.inner_text('#doneTags')
            sw = await pg.evaluate('document.documentElement.scrollWidth')
            print(lang, '| errs', errs, '| hero', hero.replace('\n', ' '), '| prices', prices, '| trio', trio, '| care', care_href,
                  '| order closed', closed, '| one(more,fam,sum,tags)', one, '| three(more,fam,sum,tags,free)', three, '| chosen', chosen,
                  '| err:', err, '| summary:', summ.replace('\n', ' / '), '| pv', pv.replace('\n', ' '),
                  '| done:', done.replace('\n', ' / '), '| sw', sw)
            await pg.locator('#order').screenshot(path=f'{OUT}/order_done_{lang}.png')
            await ctx.close()
        await b.close()

asyncio.run(main())
