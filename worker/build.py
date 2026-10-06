"""Собирает worker/dist/worker.js — один файл: код Worker'а + встроенный сайт из корня репозитория.

Запуск из любой папки:  python3 worker/build.py
Заодно обновляет js/plans.js (копия цен) из const PRICING в worker/src/worker.js.
"""
import json, base64, pathlib, re, subprocess

here = pathlib.Path(__file__).resolve().parent
repo = here.parent

# Что из корня репозитория попадает на сайт внутри Worker'а
SITE = ['index.html', 'css', 'js', 'tag', 'privacy', 'assets/logo.png', 'assets/mark.png', 'assets/wordmark.png']
TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
         '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'}

src = (here / 'src/worker.js').read_text()
assert '/*__EMBEDDED__*/null' in src, 'в src/worker.js нет метки /*__EMBEDDED__*/null'

# 1) js/plans.js — копия цен (на сайте её отдаёт сам Worker)
m = re.search(r'const PRICING = (\{.*?\});', src, re.S)
assert m, 'const PRICING не найден в worker/src/worker.js'
plans = json.loads(subprocess.check_output(['node', '-e', f'process.stdout.write(JSON.stringify({m.group(1)}))']))
(repo / 'js/plans.js').write_text(
    '// Сгенерировано worker/build.py из const PRICING в worker/src/worker.js — не редактируйте вручную.\n'
    '// На сайте этот файл отдаёт сам Worker (/js/plans.js); здесь — копия для локального просмотра.\n'
    'const PRICING = ' + json.dumps(plans, ensure_ascii=False, indent=4) + ';\n')

# 2) Встраиваем сайт
files = []
for entry in SITE:
    p = repo / entry
    files += sorted(x for x in p.rglob('*') if x.is_file()) if p.is_dir() else [p]

E = {}
for f in files:
    key = '/' + f.relative_to(repo).as_posix()
    t = TYPES.get(f.suffix.lower(), 'application/octet-stream')
    if t.startswith('image/') and f.suffix != '.svg':
        E[key] = {'type': t, 'b64': base64.b64encode(f.read_bytes()).decode()}
    else:
        E[key] = {'type': t, 'text': f.read_text().replace('\r\n', '\n')}

out = src.replace('/*__EMBEDDED__*/null', json.dumps(E, ensure_ascii=False))
(here / 'dist').mkdir(exist_ok=True)
(here / 'dist/worker.js').write_text(out)
print('worker/dist/worker.js', len(out), 'bytes;', ', '.join(E))
