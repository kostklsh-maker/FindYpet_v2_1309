#!/usr/bin/env python3
"""
FindYpet — медальон v2: светящийся корпус + крышка с чёрным QR, кличкой и телефоном.

Идея та же, что в первой модели (корпус с ушками и прорезями под ремень, тыльная сторона
изогнута по ошейнику R = 50 мм, NFC-метка в гнезде под крышкой). Изменено:
  • крышка прямоугольная 30 × 36 мм — на ней помещаются QR 20 мм, кличка и телефон;
  • крышка печатается ЛИЦОМ ВВЕРХ: 1,6 мм светящегося пластика + 0,4 мм чёрного рельефа
    (смена пластика на высоте 1,6 мм — одна пауза на весь стол, AMS не нужен);
  • корпус одинаковый для всех — печатается партиями на боку, без поддержек.

Запуск:
  python3 medallion_v2.py body                          → medallion_v2_body.stl (+ стол 3MF)
  python3 medallion_v2.py lid  101 BELLA 050-123-4567   → крышка для старого жетона (по номеру)
  python3 medallion_v2.py lid  K7QM2XA BELLA 050-…      → крышка для нового жетона (по коду, с 16.10.2026)
  python3 medallion_v2.py plate orders.csv              → стол крышек из CSV (id,name,phone; id — код или номер)
Все размеры — в мм.
"""
import math, os, struct, sys, zipfile, csv
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"

# ------------------------------------------------------------------ параметры
P = dict(
    R=50.0,          # радиус изгиба тыльной стороны (ошейник), как в первой модели
    LX=30.0, LY=36.0, lid_r=3.0,   # крышка: вдоль ошейника × поперёк, радиус углов
    lid_t=1.6,       # толщина крышки (светящийся пластик)
    relief=0.4,      # чёрный рельеф: 2 слоя по 0,2 мм
    chamfer=0.3,     # фаска снизу крышки (против «слоновьей ноги»)
    clear=0.15,      # зазор крышка–гнездо на сторону
    rim=1.8,         # стенка вокруг гнезда
    pocket_d=21.0, pocket_h=1.2,   # гнездо под NFC-метку Ø20 мм (наклейка или монетка до 1 мм)
    floor=1.2,       # дно под меткой
    plate_t=2.6,     # толщина ушек
    ear_len=9.5,     # длина ушка за корпусом (по дуге)
    ear_r=4.0,       # радиус углов ушек
    slot_w=3.8, slot_len=27.0,     # прорезь под ремень до 25 мм
    slot_off=4.6,    # центр прорези от края корпуса
    module=0.8,      # модуль QR (25 × 0,8 = 20 мм)
    qr_shrink=0.05,  # чёрные модули уже на 0,05 мм с каждой стороны — запас на растекание пластика
    qr_gap=1.6,      # тихая зона QR до текста (2 модуля)
    margin=1.8,      # поля крышки
    name_h=4.8, phone_h=4.0, text_w=26.0,  # максимальные высота/ширина надписей
    url="HTTPS://FINDY-PET.COM/T/{id}",    # старые жетоны (номер): заглавными, QR версии 2 (25 модулей) с защитой 25 %
    url_code="HTTPS://FINDY-PET.COM/{id}", # новые жетоны (код из 7 знаков): без /T/, иначе QR не влезает в 20 мм
    qr_max=25,       # модулей: больше — QR не помещается между кличкой и телефоном
)
P["bx"] = P["LX"] / 2 + P["clear"] + P["rim"]          # полуширина корпуса вдоль ошейника
P["by"] = P["LY"] / 2 + P["clear"] + P["rim"]          # полувысота поперёк ошейника
P["ztop"] = P["floor"] + P["pocket_h"] + P["lid_t"]    # верх корпуса над тыльной стороной в центре

# ------------------------------------------------------------------ вывод сеток
def write_stl(path, tris):
    tris = np.asarray(tris, dtype=np.float32)
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True); ln[ln == 0] = 1
    n = (n / ln).astype(np.float32)
    rec = np.zeros(len(tris), dtype=[("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")])
    rec["n"] = n; rec["v"] = tris.reshape(-1, 9)
    with open(path, "wb") as fh:
        fh.write(b"FindYpet medallion v2".ljust(80, b"\0")); fh.write(struct.pack("<I", len(tris)))
        fh.write(rec.tobytes())

def load_stl(path):
    b = open(path, "rb").read(); n = struct.unpack("<I", b[80:84])[0]
    a = np.frombuffer(b[84:], dtype=[("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")], count=n)
    return a["v"].reshape(-1, 3, 3).astype(np.float64)

def indexed(tris, nd=4):
    v = np.round(np.asarray(tris).reshape(-1, 3), nd)
    uniq, inv = np.unique(v, axis=0, return_inverse=True)
    return uniq, inv.reshape(-1, 3)

def write_3mf(path, objects):
    """objects: [(name, tris, (tx, ty, tz))] — каждое тело отдельным объектом на столе."""
    res, build, ids = [], [], {}
    for name, tris, (tx, ty, tz) in objects:
        if id(tris) not in ids:                  # одинаковые тела — одна сетка, много копий на столе
            i = ids[id(tris)] = len(ids) + 1
            v, f = indexed(tris)
            vs = "".join(f'<vertex x="{a:.4f}" y="{b:.4f}" z="{c:.4f}"/>' for a, b, c in v)
            fs = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in f)
            res.append(f'<object id="{i}" name="{name}" type="model"><mesh><vertices>{vs}</vertices>'
                       f'<triangles>{fs}</triangles></mesh></object>')
        build.append(f'<item objectid="{ids[id(tris)]}" transform="1 0 0 0 1 0 0 0 1 {tx:.3f} {ty:.3f} {tz:.3f}"/>')
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             f'<resources>{"".join(res)}</resources><build>{"".join(build)}</build></model>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", model)

def box(x0, y0, z0, x1, y1, z1):
    v = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                  [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], float)
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
         (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return v[np.array(f)]

def rrect_poly(hx, hy, r, n=10):
    """Скруглённый прямоугольник против часовой стрелки (выпуклый)."""
    pts = []
    for cx, cy, a0 in ((hx - r, hy - r, 0), (-hx + r, hy - r, 90), (-hx + r, -hy + r, 180), (hx - r, -hy + r, 270)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)

def loft(rings):
    """Замкнутое тело по выпуклым контурам [(poly, z), ...] снизу вверх (одинаковое число точек)."""
    n = len(rings[0][0]); tris = []
    for (p0, z0), (p1, z1) in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            a, b = np.r_[p0[i], z0], np.r_[p0[j], z0]
            c, d = np.r_[p1[i], z1], np.r_[p1[j], z1]
            tris += [(a, b, d), (a, d, c)]                   # стенка
    (pb, zb), (pt, zt) = rings[0], rings[-1]
    cb, ct = pb.mean(0), pt.mean(0)
    for i in range(n):
        j = (i + 1) % n
        tris.append((np.r_[cb, zb], np.r_[pb[j], zb], np.r_[pb[i], zb]))  # низ
        tris.append((np.r_[ct, zt], np.r_[pt[i], zt], np.r_[pt[j], zt]))  # верх
    return np.array(tris)

# ------------------------------------------------------------------ корпус (SDF → поверхность)
def sd_rrect(x, y, hx, hy, r):
    qx, qy = np.abs(x) - (hx - r), np.abs(y) - (hy - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r

def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h)

def body_sdf(x, y, z, p=P):
    R = p["R"]
    rr = np.hypot(x, z + R)                      # расстояние до оси изгиба (ось вдоль Y)
    s = R * np.arctan2(x, z + R)                 # длина дуги по тыльной стороне
    block = np.maximum.reduce([sd_rrect(x, y, p["bx"], p["by"], p["lid_r"] + p["clear"] + p["rim"]),
                               z - p["ztop"], R - rr])
    ears = np.maximum(sd_rrect(s, y, p["bx"] + p["ear_len"], p["by"], p["ear_r"]),
                      np.maximum(R - rr, rr - (R + p["plate_t"])))
    d = smin(block, ears, 1.0)                   # плавный переход корпус → ушки (галтель ~1 мм)
    # гнездо под крышку
    rec = np.maximum(sd_rrect(x, y, p["LX"] / 2 + p["clear"], p["LY"] / 2 + p["clear"], p["lid_r"] + p["clear"]),
                     (p["ztop"] - p["lid_t"]) - z)
    d = np.maximum(d, -rec)
    # гнездо под NFC-метку
    z0 = p["ztop"] - p["lid_t"] - p["pocket_h"]
    pk = np.maximum(np.hypot(x, y) - p["pocket_d"] / 2, np.maximum(z0 - z, z - (p["ztop"] - p["lid_t"] + 0.5)))
    d = np.maximum(d, -pk)
    # прорези под ремень (стадион вдоль Y)
    sc = p["bx"] + p["slot_off"]; hw = p["slot_w"] / 2; hl = p["slot_len"] / 2 - hw
    for sgn in (-1, 1):
        dy = np.maximum(np.abs(y) - hl, 0)
        slot = np.hypot(s - sgn * sc, dy) - hw
        d = np.maximum(d, -slot)
    return d

def make_body(h=0.2, p=P):
    from skimage.measure import marching_cubes
    xs = np.arange(-28.0, 28.0 + h, h); ys = np.arange(-p["by"] - 0.8, p["by"] + 0.8 + h, h)
    zs = np.arange(-8.0, p["ztop"] + 0.8 + h, h)
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")
    d = body_sdf(X, Y, Z, p).astype(np.float32)
    verts, faces, _, _ = marching_cubes(d, 0.0, spacing=(h, h, h))
    verts += np.array([xs[0], ys[0], zs[0]])
    tris = verts[faces]
    return orient_out(tris)

def signed_volume(t):
    return np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() / 6

def orient_out(t):
    """Нормали наружу (положительный объём) — иначе слайсер видит «вывернутое» тело."""
    return t if signed_volume(t) > 0 else t[:, [0, 2, 1]]

def body_print_pose(tris, p=P):
    """На боку: плоская грань y = −by на столе, высота печати = 2·by."""
    t = tris.copy()
    out = np.empty_like(t)
    out[..., 0] = t[..., 0]; out[..., 1] = t[..., 2]; out[..., 2] = t[..., 1]
    out = orient_out(out)                        # перестановка осей — зеркало, возвращаем нормали наружу
    mn = out.reshape(-1, 3).min(0)
    return out - mn

# ------------------------------------------------------------------ крышка: QR + текст
def qr_matrix(text):
    pr = cv2.QRCodeEncoder_Params()
    pr.correction_level = cv2.QRCodeEncoder_CORRECT_LEVEL_Q
    pr.mode = cv2.QRCodeEncoder_MODE_ALPHANUMERIC
    m = cv2.QRCodeEncoder.create(pr).encode(text) < 128
    rows, cols = np.where(m.any(1))[0], np.where(m.any(0))[0]
    return m[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]

def text_mask(s, h_max, w_max, px_mm=20):
    """Растр надписи (True = чёрный), подогнанный под h_max × w_max мм. Иврит — справа налево."""
    rtl = any("֐" <= ch <= "׿" for ch in s)
    kw = dict(direction="rtl", language="he") if rtl else {}
    f0 = ImageFont.truetype(FONT, 200)
    l, t, r, b = f0.getbbox(s, **kw)
    k = min(h_max / (b - t), w_max / (r - l))           # мм на пиксель при кегле 200
    f = ImageFont.truetype(FONT, max(8, int(round(200 * k * px_mm))))
    l, t, r, b = f.getbbox(s, **kw)
    im = Image.new("L", (r - l + 4, b - t + 4), 0)
    ImageDraw.Draw(im).text((2 - l, 2 - t), s, font=f, fill=255, **kw)
    return np.array(im) > 127, 1.0 / px_mm

def mask_rects(mask, pix, x0, y_top):
    """Растр → прямоугольники (слияние одинаковых отрезков соседних строк). y растёт вверх."""
    rects, open_ = [], {}
    for row in range(mask.shape[0] + 1):
        runs = set()
        if row < mask.shape[0]:
            m = np.r_[False, mask[row], False]
            d = np.diff(m.astype(np.int8))
            runs = set(zip(np.where(d == 1)[0], np.where(d == -1)[0]))
        for key in list(open_):
            if key not in runs:
                r0 = open_.pop(key)
                rects.append((x0 + key[0] * pix, y_top - row * pix, x0 + key[1] * pix, y_top - r0 * pix))
        for key in runs:
            open_.setdefault(key, row)
    return rects

def qr_url(tag_id, p=P):
    """Номер (101) → HTTPS://FINDY-PET.COM/T/101; код (K7QM2XA) → HTTPS://FINDY-PET.COM/K7QM2XA."""
    tag_id = str(tag_id).strip().upper()
    if not tag_id.isalnum():
        sys.exit(f"Неверный номер или код жетона: {tag_id!r}")
    return (p["url"] if tag_id.isdigit() else p["url_code"]).format(id=tag_id)

def lid_layout(tag_id, name, phone, p=P):
    """Возвращает список прямоугольников рельефа (в координатах крышки, центр 0,0) и сведения."""
    url = qr_url(tag_id, p)
    q = qr_matrix(url)
    n = q.shape[0]; mod = p["module"]; side = n * mod
    if n > p["qr_max"]:
        sys.exit(f"QR для {url} получился {n} × {n} модулей ({side:.1f} мм) и не помещается на крышку. "
                 f"Проверьте код жетона: в нём должно быть 7 знаков.")
    top = p["LY"] / 2 - p["margin"]
    name_band = (top, top - p["name_h"])
    qr_top = name_band[1] - p["qr_gap"]
    qr_bot = qr_top - side
    ph_top = qr_bot - p["qr_gap"]
    ph_bot = max(ph_top - p["phone_h"], -p["LY"] / 2 + p["margin"])
    # компенсация растекания: чёрные модули уже на p["qr_shrink"] мм с каждой стороны (как в полиграфии)
    sub = 16                                     # 16 точек на модуль = 0,05 мм
    big = np.kron(q, np.ones((sub, sub), bool))
    k = int(round(p["qr_shrink"] / (mod / sub)))
    if k:
        big = cv2.erode(big.astype(np.uint8), np.ones((2 * k + 1, 2 * k + 1), np.uint8)).astype(bool)
    rects = mask_rects(big, mod / sub, -side / 2, qr_top)
    info = {"qr": url, "qr_modules": n, "qr_mm": side}
    for label, s, (y0, y1) in (("name", name, name_band), ("phone", phone, (ph_top, ph_bot))):
        if not s:
            continue
        m, pix = text_mask(s, y0 - y1, p["text_w"])
        w, h = m.shape[1] * pix, m.shape[0] * pix
        rects += mask_rects(m, pix, -w / 2, (y0 + y1) / 2 + h / 2)
        info[label] = (round(w, 1), round(h, 1))
    info["bottom_margin"] = round(ph_bot + p["LY"] / 2, 2)
    return rects, info

def make_lid(tag_id, name, phone, p=P):
    outer = rrect_poly(p["LX"] / 2, p["LY"] / 2, p["lid_r"])
    inner = rrect_poly(p["LX"] / 2 - p["chamfer"], p["LY"] / 2 - p["chamfer"], p["lid_r"] - p["chamfer"])
    base = loft([(inner, 0.0), (outer, p["chamfer"]), (outer, p["lid_t"])])
    rects, info = lid_layout(tag_id, name, phone, p)
    z0, z1 = p["lid_t"] - 0.02, p["lid_t"] + p["relief"]
    rel = [box(x0, y0, z0, x1, y1, z1) for x0, y0, x1, y1 in rects]
    tris = np.concatenate([base] + rel) + np.array([p["LX"] / 2, p["LY"] / 2, 0])
    info["relief_boxes"] = len(rects)
    return tris, rects, info

def lid_image(rects, px_mm=12, p=P, glow=(214, 236, 196), ink=(25, 25, 25)):
    """Вид сверху на крышку (для проверки QR камерой)."""
    W, H = int(p["LX"] * px_mm), int(p["LY"] * px_mm)
    im = Image.new("RGB", (W + 60, H + 60), (60, 70, 72))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([30, 30, 30 + W, 30 + H], radius=int(p["lid_r"] * px_mm), fill=glow)
    for x0, y0, x1, y1 in rects:
        d.rectangle([30 + (x0 + p["LX"] / 2) * px_mm, 30 + (p["LY"] / 2 - y1) * px_mm,
                     30 + (x1 + p["LX"] / 2) * px_mm, 30 + (p["LY"] / 2 - y0) * px_mm], fill=ink)
    return im

# ------------------------------------------------------------------ столы
BED = 256.0
def arrange(n, fx, fy, gap=4.5, margin=8.0, bed=BED):
    cols = int((bed - 2 * margin + gap) // (fx + gap)); rows = int((bed - 2 * margin + gap) // (fy + gap))
    n = min(n, cols * rows)
    used_x = cols * fx + (cols - 1) * gap; used_y = rows * fy + (rows - 1) * gap
    ox, oy = (bed - used_x) / 2, (bed - used_y) / 2
    return [(ox + (i % cols) * (fx + gap), oy + (i // cols) * (fy + gap)) for i in range(n)], cols * rows

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("body", "all"):
        stl = os.path.join(OUT, "medallion_v2_body.stl")
        if os.path.exists(stl) and "--rebuild" not in sys.argv:
            tris = load_stl(stl)                 # корпус одинаковый — пересчитываем только с --rebuild
        else:
            tris = body_print_pose(make_body())
            write_stl(stl, tris)
        ext = tris.reshape(-1, 3).max(0)
        pos, cap = arrange(10 ** 6, ext[0], ext[1], gap=4.0)
        write_3mf(os.path.join(OUT, f"plate_bodies_{len(pos)}.3mf"),
                  [(f"body_{i + 1}", tris, (x, y, 0)) for i, (x, y) in enumerate(pos)])
        print(f"body: {len(tris)} triangles, print pose {ext.round(1)} mm, {len(pos)} per plate")
    if cmd in ("lid", "all"):
        tid, name, phone = (sys.argv[2:5] + ["101", "BELLA", "050-123-4567"][len(sys.argv[2:5]):])[:3]
        tid = tid.strip().upper()
        tris, rects, info = make_lid(tid, name.upper(), phone)
        write_stl(os.path.join(OUT, f"medallion_v2_lid_{tid}.stl"), tris)
        lid_image(rects).save(os.path.join(OUT, f"lid_{tid}_top.png"))
        print(f"lid {tid}: {len(tris)} triangles, {info}")
    if cmd == "plate":
        rows = list(csv.DictReader(open(sys.argv[2], encoding="utf-8")))
        pos, cap = arrange(len(rows), P["LX"], P["LY"])
        objs = []
        for (x, y), r in zip(pos, rows):
            r["id"] = r["id"].strip().upper()
            tris, _, _ = make_lid(r["id"], r["name"].upper(), r["phone"])
            objs.append((f"lid_{r['id']}_{r['name']}", tris, (x, y, 0)))
        path = os.path.join(OUT, f"plate_lids_{len(objs)}.3mf")
        write_3mf(path, objs)
        print(f"plate: {len(objs)} lids (max {cap} per plate) → {path}")

if __name__ == "__main__":
    main()
