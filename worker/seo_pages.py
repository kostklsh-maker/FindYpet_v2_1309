"""Языковые страницы лендинга для поиска: / (EN), /he/, /ru/.

Собираются при сборке (worker/build.py) из index.html и js/i18n.js — тексты уже переведены
в HTML (поисковик видит иврит и русский без JavaScript), цены подставлены из PRICING.
В <head> каждой страницы: title и description на её языке, canonical, hreflang, Open Graph
(картинка 1200×630 assets/og.jpg) и JSON-LD (Organization, WebSite, Product с ценами, FAQPage).
Про доставку и сроки здесь ничего не пишем — как и на сайте.
"""
import html as H, json, re, subprocess

SITE = 'https://findy-pet.com'
LANGS = ['en', 'he', 'ru']
PATH = {'en': '/', 'he': '/he/', 'ru': '/ru/'}
OG_LOCALE = {'en': 'en_US', 'he': 'he_IL', 'ru': 'ru_RU'}

NODE_DUMP = r'''
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
const ctx = { localStorage: { getItem() { return null; }, setItem() {} }, navigator: { language: 'en' },
  document: { documentElement: { getAttribute() { return null; }, dataset: {} }, querySelectorAll() { return []; } },
  location: { pathname: '/', search: '', hash: '' }, history: { replaceState() {} } };
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__I18N = I18N;', ctx);
process.stdout.write(JSON.stringify(ctx.__I18N));
'''


def load_i18n(path):
    return json.loads(subprocess.check_output(['node', '-e', NODE_DUMP, str(path)]))


def money(n, cur, lang):
    v = round(n * 100) / 100
    txt = str(int(v)) if float(v).is_integer() else f'{v:.2f}'
    return (txt.replace('.', ',') if lang == 'ru' else txt) + ' ' + cur


def render(page, I18N, pricing, lang):
    T = I18N[lang]
    esc = lambda s: H.escape(s, quote=False)
    attr = lambda s: H.escape(s, quote=True)
    plain = lambda k: k in T and not re.search(r'\{\w+\}', T[k])

    # тексты
    page = re.sub(r'(<(\w+)\b[^>]*\bdata-t="(\w+)"[^>]*>)([^<]*)(</\2>)',
                  lambda m: m.group(1) + esc(T[m.group(3)]) + m.group(5) if plain(m.group(3)) else m.group(0), page)
    page = re.sub(r'(<(\w+)\b[^>]*\bdata-t-html="(\w+)"[^>]*>)(.*?)(</\2>)',
                  lambda m: m.group(1) + T[m.group(3)] + m.group(5) if m.group(3) in T else m.group(0), page, flags=re.S)
    def tag_attr(m, data, name):
        tag = m.group(0)
        k = re.search(rf'\b{data}="(\w+)"', tag).group(1)
        if not plain(k): return tag
        return re.sub(rf'\b{name}="[^"]*"', f'{name}="{attr(T[k])}"', tag)
    page = re.sub(r'<[^>]*\bdata-t-aria="\w+"[^>]*>', lambda m: tag_attr(m, 'data-t-aria', 'aria-label'), page)
    page = re.sub(r'<[^>]*\bdata-t-ph="\w+"[^>]*>', lambda m: tag_attr(m, 'data-t-ph', 'placeholder'), page)

    # цены (без JavaScript тоже видны)
    cur = pricing.get('currency', '₪')
    price = {'tag': pricing['tag'], 'two': pricing['tag'] * 2, 'bundle': pricing['tag'] * (pricing['bundle'] - 1)}
    page = re.sub(r'(<(\w+)\b[^>]*\bdata-price="(\w+)"[^>]*>)(</\2>)',
                  lambda m: m.group(1) + money(price[m.group(3)], cur, lang) + m.group(4) if m.group(3) in price else m.group(0), page)
    page = re.sub(r'(<(\w+)\b[^>]*\bdata-price-min[^>]*>)(</\2>)', lambda m: m.group(1) + money(pricing['tag'], cur, lang) + m.group(3), page)

    # язык документа
    page = page.replace('<html lang="en">', f'<html lang="{lang}" dir="{"rtl" if lang == "he" else "ltr"}" data-lang="{lang}">', 1)

    # /he/ и /ru/ лежат на уровень глубже — относительные ссылки на файлы сайта делаем абсолютными
    if lang != 'en':
        page = re.sub(r'\b(href|src)="(css|js|assets)/', r'\1="/\2/', page)
        page = re.sub(r'\bhref="privacy/"', f'href="/privacy/?lang={lang}"', page)

    # <head>: от <title> до canonical — заново
    head = seo_head(page, T, I18N, pricing, lang)
    page = re.sub(r'    <title>.*?<link rel="canonical"[^>]*>\n', head, page, count=1, flags=re.S)
    return page


def seo_head(page, T, I18N, pricing, lang):
    a = lambda s: H.escape(s, quote=True)
    url = SITE + PATH[lang]
    alt = ''.join(f'    <link rel="alternate" hreflang="{l}" href="{SITE}{PATH[l]}">\n' for l in LANGS)
    alt += f'    <link rel="alternate" hreflang="x-default" href="{SITE}/">\n'
    others = ''.join(f'    <meta property="og:locale:alternate" content="{OG_LOCALE[l]}">\n' for l in LANGS if l != lang)
    faq = [(q, a_) for q, a_ in re.findall(r'<summary data-t="(\w+)">[^<]*</summary><p data-t="(\w+)">', page)]
    tag_price, bundle_price = pricing['tag'], pricing['tag'] * (pricing['bundle'] - 1)
    graph = {
        '@context': 'https://schema.org',
        '@graph': [
            {'@type': 'Organization', '@id': SITE + '/#org', 'name': 'FindYpet', 'url': SITE + '/',
             'logo': SITE + '/assets/logo.png', 'email': 'findypet0926@gmail.com',
             'sameAs': ['https://t.me/YourPetLocatorBot']},
            {'@type': 'WebSite', '@id': SITE + '/#site', 'url': SITE + '/', 'name': 'FindYpet',
             'inLanguage': ['en', 'he', 'ru'], 'publisher': {'@id': SITE + '/#org'}},
            {'@type': 'Product', '@id': url + '#tag', 'name': T['tagName'], 'brand': {'@type': 'Brand', 'name': 'FindYpet'},
             'description': T['metaDesc'], 'image': SITE + '/assets/og.jpg', 'inLanguage': lang,
             'offers': [
                 {'@type': 'Offer', 'name': T['qtyOne'], 'price': str(tag_price), 'priceCurrency': 'ILS',
                  'availability': 'https://schema.org/InStock', 'url': url + '#plans'},
                 {'@type': 'Offer', 'name': T['bundleName'] + ' · ' + T['bundleBadge'], 'price': str(bundle_price), 'priceCurrency': 'ILS',
                  'availability': 'https://schema.org/InStock', 'url': url + '#plans'},
             ]},
            {'@type': 'FAQPage', '@id': url + '#faq', 'inLanguage': lang,
             'mainEntity': [{'@type': 'Question', 'name': T[q], 'acceptedAnswer': {'@type': 'Answer', 'text': T[an]}}
                            for q, an in faq if q in T and an in T]},
        ],
    }
    ld = json.dumps(graph, ensure_ascii=False).replace('</', '<\\/')
    return (
        f'    <title>{H.escape(T["docTitle"], quote=False)}</title>\n'
        f'    <meta name="description" content="{a(T["metaDesc"])}">\n'
        f'    <meta name="theme-color" content="#00A2A6">\n'
        f'    <link rel="canonical" href="{url}">\n' + alt +
        f'    <meta property="og:type" content="website">\n'
        f'    <meta property="og:site_name" content="FindYpet">\n'
        f'    <meta property="og:locale" content="{OG_LOCALE[lang]}">\n' + others +
        f'    <meta property="og:title" content="{a(T["docTitle"])}">\n'
        f'    <meta property="og:description" content="{a(T["metaDesc"])}">\n'
        f'    <meta property="og:url" content="{url}">\n'
        f'    <meta property="og:image" content="{SITE}/assets/og.jpg">\n'
        f'    <meta property="og:image:width" content="1200">\n'
        f'    <meta property="og:image:height" content="630">\n'
        f'    <meta property="og:image:alt" content="{a(T["tagAria"])}">\n'
        f'    <meta name="twitter:card" content="summary_large_image">\n'
        f'    <script type="application/ld+json">{ld}</script>\n'
    )


def build_pages(repo, pricing):
    I18N = load_i18n(repo / 'js/i18n.js')
    page = (repo / 'index.html').read_text().replace('\r\n', '\n')
    return {PATH[l] + 'index.html' if l != 'en' else '/index.html': render(page, I18N, pricing, l) for l in LANGS}
