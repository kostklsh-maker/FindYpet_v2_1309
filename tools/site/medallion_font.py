"""three.js typeface JSON for the 3D medallion, from the font of the print file (tools/medallion: DejaVu Sans Condensed Bold).
Usage: python3 tools/site/medallion_font.py font.json  — then put the JSON into <script type="application/json" id="fyFont"> of index.html.
Glyphs: Latin capitals, digits, a little punctuation, Cyrillic capitals and the Hebrew letters, so a pet name typed in
English, Russian or Hebrew shows on the 3D lid the way it will be printed."""
import json, sys
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

SRC = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'
CHARS = (" '+-.,0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
         'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'
         + ''.join(chr(c) for c in range(0x05D0, 0x05EB)))


class TypefacePen(BasePen):
    """Glyph outline -> the 'o' string of a three.js typeface (q: end point first, then the control point)."""
    def __init__(self, gs):
        super().__init__(gs); self.out = []
    def n(self, v): return str(round(v)) if abs(v - round(v)) < 1e-6 else f'{v:.1f}'
    def _moveTo(self, p): self.out += ['m', self.n(p[0]), self.n(p[1])]
    def _lineTo(self, p): self.out += ['l', self.n(p[0]), self.n(p[1])]
    def _qCurveToOne(self, c, p): self.out += ['q', self.n(p[0]), self.n(p[1]), self.n(c[0]), self.n(c[1])]
    def _curveToOne(self, c1, c2, p): self.out += ['b', self.n(p[0]), self.n(p[1]), self.n(c1[0]), self.n(c1[1]), self.n(c2[0]), self.n(c2[1])]
    def _closePath(self): pass


def build():
    f = TTFont(SRC)
    cmap = f.getBestCmap(); gs = f.getGlyphSet(); hmtx = f['hmtx']; head = f['head']; hhea = f['hhea']
    glyphs = {}
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if not name: print('no glyph for', ch, file=sys.stderr); continue
        pen = TypefacePen(gs); gs[name].draw(pen)
        adv = hmtx[name][0]
        g = {'ha': adv, 'x_min': 0, 'x_max': adv, 'o': ' '.join(pen.out) + (' ' if pen.out else '')}
        glyphs[ch] = g
    upm = head.unitsPerEm
    return {
        'glyphs': glyphs, 'familyName': 'DejaVu Sans Condensed', 'cssFontWeight': 'bold', 'cssFontStyle': 'normal',
        'ascender': hhea.ascent, 'descender': hhea.descent, 'underlinePosition': f['post'].underlinePosition,
        'underlineThickness': f['post'].underlineThickness,
        'boundingBox': {'xMin': head.xMin, 'yMin': head.yMin, 'xMax': head.xMax, 'yMax': head.yMax},
        'resolution': upm,
        'original_font_information': {'full_font_name': 'DejaVu Sans Condensed Bold',
                                      'license': 'Bitstream Vera / DejaVu fonts license (free), https://dejavu-fonts.github.io/License.html'},
    }


if __name__ == '__main__':
    d = build()
    s = json.dumps(d, ensure_ascii=False, separators=(',', ':'))
    open(sys.argv[1], 'w').write(s)
    print(len(d['glyphs']), 'glyphs,', len(s.encode()), 'bytes')
