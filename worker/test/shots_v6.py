# Скриншоты нового лендинга (v6): 3 языка × компьютер/телефон + проверка интерактива
import asyncio, sys
from playwright.async_api import async_playwright
BASE = 'http://localhost:8787/'
async def prep(pg, lang):
    await pg.goto(BASE)
    await pg.evaluate(f"localStorage.setItem('fyp_lang','{lang}')")
    await pg.goto(BASE)
    await pg.wait_for_timeout(300)
    await pg.evaluate("document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'))")
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for lang in ['en','he','ru']:
            for name, vp in [('desk', {'width':1366,'height':900}), ('mob', {'width':390,'height':844})]:
                ctx = await b.new_context(viewport=vp, device_scale_factor=1, reduced_motion='reduce')
                pg = await ctx.new_page(); errs=[]
                pg.on('pageerror', lambda e: errs.append(str(e)))
                pg.on('console', lambda m: m.type=='error' and errs.append(m.text))
                await prep(pg, lang)
                # interactions
                await pg.click('#petsSeg button[data-pets="3"]')
                rec = await pg.inner_text('#petsRec')
                recPlan = await pg.evaluate("document.querySelector('.plan.recommended').dataset.plan")
                await pg.check('#lostToggle', force=True)
                lost = await pg.evaluate("document.getElementById('miniPage').classList.contains('lost')")
                await pg.click('.choose[data-plan="family"]')
                await pg.fill('#petName', 'Rex'); await pg.fill('#ownerPhone', '054-111-2222')
                pv = await pg.inner_text('#pvName'); sp = await pg.inner_text('#sumPrice')
                await pg.click('#finderTabs button[data-way="tap"]'); await pg.click('#osTabs button[data-os="android"]')
                await pg.click('.demo-step[data-step="2"]')
                sw = await pg.evaluate('document.documentElement.scrollWidth')
                untranslated = await pg.evaluate("""(()=>{const bad=[];document.querySelectorAll('[data-t]').forEach(e=>{if(e.textContent===e.dataset.t)bad.push(e.dataset.t)});return bad})()""")
                print(lang, name, 'errs', errs, '| rec', recPlan, rec[:60], '| lost', lost, '| pv', pv, sp, '| sw', sw, vp['width'], '| untranslated', untranslated)
                await pg.screenshot(path=f'shots/v6/{lang}_{name}.png', full_page=True)
                await ctx.close()
        await b.close()
asyncio.run(main())
