# Скриншоты страницы жетона: обычная (101), «Потерялся» (102), сбой базы (103), не найдена (99999).
# Нужен запущенный node worker/test/server.mjs
import asyncio, os
from playwright.async_api import async_playwright
OUT = os.path.join(os.path.dirname(__file__), 'shots')

async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for tid, lang in [('101', 'en'), ('102', 'ru'), ('103', 'he'), ('99999', 'en')]:
            ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, reduced_motion='reduce',
                                      geolocation={'latitude': 32.79, 'longitude': 34.99}, permissions=['geolocation'])
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.goto('http://localhost:8787/')
            await pg.evaluate(f"localStorage.setItem('fyp_lang','{lang}')")
            await pg.goto(f'http://localhost:8787/t/{tid}')
            await pg.wait_for_timeout(900)
            vis = {k: await pg.is_visible('#' + k) for k in ['pet', 'notFound', 'tempError', 'missing', 'notesBox', 'call2Btn', 'staleLine', 'waBtn']}
            sw = await pg.evaluate('document.documentElement.scrollWidth')
            print(tid, lang, 'errors:', errs, vis, 'scrollWidth', sw)
            await pg.screenshot(path=f'{OUT}/t{tid}_{lang}.png', full_page=True)
            if tid == '101':
                await pg.click('#locBtn'); await pg.wait_for_timeout(800)
                print('  after location:', await pg.inner_text('#locStatus'), '|', await pg.get_attribute('#locBtn', 'class'))
                await pg.screenshot(path=f'{OUT}/t101_sent.png', full_page=True)
            await ctx.close()
        await b.close()

asyncio.run(main())
