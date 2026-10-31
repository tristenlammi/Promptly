"""Draw the photo-markup stickers (PH-7) — the one source for both sides.

    python -m app.photos.stickers.make_stickers [out_dir …]

Writes ``<id>.png`` (512×512, transparent) here, and into any extra
directories given (the frontend's ``public/photo-stickers``), so the
editor's preview and the server's render use the very same pictures.
``TINTABLE`` ones are drawn white: they take the chosen colour (the
picture's alpha, filled with it). Run in the backend image (its DejaVu
Bold font draws the lettering).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.photos.stickers import STICKERS

SIZE = 512
SS = 2  # drawn at 2× and scaled down — smooth edges
HERE = Path(__file__).resolve().parent
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _canvas() -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
    n = SIZE * SS
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im), n


def _poly_stroke(d: ImageDraw.ImageDraw, pts: list[tuple[float, float]], w: float, fill) -> None:  # noqa: ANN001
    d.line(pts, fill=fill, width=round(w), joint="curve")
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=fill)


def _head(d: ImageDraw.ImageDraw, x: float, y: float, ang: float, length: float, fill) -> None:  # noqa: ANN001
    s = math.radians(30)
    d.polygon([(x, y), (x - length * math.cos(ang - s), y - length * math.sin(ang - s)),
               (x - length * math.cos(ang + s), y - length * math.sin(ang + s))], fill=fill)


def _text(d: ImageDraw.ImageDraw, xy: tuple[float, float], s: str, size: int, fill, stroke=None) -> None:  # noqa: ANN001
    d.text(xy, s, font=ImageFont.truetype(FONT, size), fill=fill, anchor="mm",
           stroke_width=round(size * 0.06) if stroke else 0, stroke_fill=stroke)


def _star_points(cx: float, cy: float, outer: float, inner: float, n: int, rot: float = -math.pi / 2) -> list[tuple[float, float]]:
    out = []
    for i in range(n * 2):
        r = outer if i % 2 == 0 else inner
        a = rot + i * math.pi / n
        out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return out


def draw(sid: str) -> Image.Image:  # noqa: C901, PLR0915
    im, d, n = _canvas()
    W = (255, 255, 255, 255)
    K = (20, 20, 20, 255)
    c = n / 2
    if sid == "circle":
        # A loop drawn by hand: a little wobble, and it overshoots its start.
        pts = []
        for i in range(0, 400):
            t = i / 360 * 2 * math.pi
            r = 1 + 0.035 * math.sin(3 * t) + (0.06 * (i - 340) / 60 if i > 340 else 0)
            pts.append((c + 0.42 * n * r * math.cos(t - 2.2), c + 0.3 * n * r * math.sin(t - 2.2)))
        _poly_stroke(d, pts, 0.045 * n, W)
    elif sid == "arrow":
        _poly_stroke(d, [(0.12 * n, 0.5 * n), (0.7 * n, 0.5 * n)], 0.07 * n, W)
        _head(d, 0.9 * n, 0.5 * n, 0, 0.3 * n, W)
    elif sid == "curved-arrow":
        pts = [(c + 0.36 * n * math.cos(a), 0.75 * n + 0.42 * n * math.sin(a))
               for a in [math.pi + i * (0.62 * math.pi) / 60 for i in range(61)]]
        _poly_stroke(d, pts[:-6], 0.06 * n, W)
        (x0, y0), (x1, y1) = pts[-8], pts[-1]
        _head(d, x1 + (x1 - x0) * 0.6, y1 + (y1 - y0) * 0.6, math.atan2(y1 - y0, x1 - x0), 0.24 * n, W)
    elif sid == "check":
        _poly_stroke(d, [(0.16 * n, 0.52 * n), (0.4 * n, 0.76 * n), (0.86 * n, 0.24 * n)], 0.11 * n, W)
    elif sid == "cross":
        _poly_stroke(d, [(0.2 * n, 0.2 * n), (0.8 * n, 0.8 * n)], 0.11 * n, W)
        _poly_stroke(d, [(0.8 * n, 0.2 * n), (0.2 * n, 0.8 * n)], 0.11 * n, W)
    elif sid == "star":
        d.polygon(_star_points(c, 0.53 * n, 0.46 * n, 0.19 * n, 5), fill=W)
    elif sid == "heart":
        pts = []
        for i in range(200):
            t = i / 200 * 2 * math.pi
            x = 16 * math.sin(t) ** 3
            y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            pts.append((c + x * 0.027 * n, 0.47 * n - y * 0.027 * n))
        d.polygon(pts, fill=W)
    elif sid == "sparkle":
        pts = []
        for i in range(8):
            r = 0.45 * n if i % 2 == 0 else 0.1 * n
            a = -math.pi / 2 + i * math.pi / 4
            pts.append((c + r * math.cos(a), c + r * math.sin(a)))
        d.polygon(pts, fill=W)
        sm = [(0.82 * n + (0.12 * n if i % 2 == 0 else 0.03 * n) * math.cos(-math.pi / 2 + i * math.pi / 4),
               0.2 * n + (0.12 * n if i % 2 == 0 else 0.03 * n) * math.sin(-math.pi / 2 + i * math.pi / 4)) for i in range(8)]
        d.polygon(sm, fill=W)
    elif sid == "squiggle":
        pts = [(0.08 * n + i / 120 * 0.84 * n, c + 0.12 * n * math.sin(i / 120 * 5 * math.pi)) for i in range(121)]
        _poly_stroke(d, pts, 0.06 * n, W)
    elif sid == "speech":
        lw = round(0.03 * n)
        d.polygon([(0.3 * n, 0.66 * n), (0.2 * n, 0.9 * n), (0.48 * n, 0.68 * n)], fill=K)
        d.rounded_rectangle((0.06 * n, 0.12 * n, 0.94 * n, 0.7 * n), radius=0.16 * n, fill=W, outline=K, width=lw)
        d.polygon([(0.32 * n, 0.66 * n), (0.25 * n, 0.82 * n), (0.44 * n, 0.66 * n)], fill=W)
    elif sid == "thought":
        lw = round(0.025 * n)
        for (x, y, r) in [(0.3, 0.36, 0.2), (0.52, 0.28, 0.22), (0.72, 0.38, 0.19), (0.58, 0.52, 0.18), (0.36, 0.53, 0.17)]:
            d.ellipse(((x - r) * n, (y - r) * n, (x + r) * n, (y + r) * n), fill=W, outline=K, width=lw)
        for (x, y, r) in [(0.3, 0.36, 0.2), (0.52, 0.28, 0.22), (0.72, 0.38, 0.19), (0.58, 0.52, 0.18), (0.36, 0.53, 0.17)]:
            r2 = r - lw / n
            d.ellipse(((x - r2) * n, (y - r2) * n, (x + r2) * n, (y + r2) * n), fill=W)
        for (x, y, r) in [(0.24, 0.78, 0.06), (0.14, 0.9, 0.035)]:
            d.ellipse(((x - r) * n, (y - r) * n, (x + r) * n, (y + r) * n), fill=W, outline=K, width=lw)
    elif sid in ("exclaim", "question"):
        col = (220, 38, 38, 255) if sid == "exclaim" else (37, 99, 235, 255)
        d.ellipse((0.06 * n, 0.06 * n, 0.94 * n, 0.94 * n), fill=W)
        d.ellipse((0.1 * n, 0.1 * n, 0.9 * n, 0.9 * n), fill=col)
        _text(d, (c, c), "!" if sid == "exclaim" else "?", round(0.6 * n), W)
    elif sid == "new":
        d.polygon(_star_points(c, c, 0.48 * n, 0.38 * n, 14), fill=(250, 204, 21, 255))
        _text(d, (c, c), "NEW", round(0.24 * n), (180, 20, 20, 255))
    elif sid == "sold":
        layer, ld, _ = _canvas()
        red = (220, 38, 38, 255)
        ld.rounded_rectangle((0.05 * n, 0.3 * n, 0.95 * n, 0.7 * n), radius=0.04 * n, outline=red, width=round(0.035 * n))
        ld.rounded_rectangle((0.1 * n, 0.35 * n, 0.9 * n, 0.65 * n), radius=0.03 * n, fill=red)
        _text(ld, (c, c), "SOLD", round(0.22 * n), W)
        im = layer.rotate(14, resample=Image.Resampling.BICUBIC)
    elif sid == "price":
        orange = (249, 115, 22, 255)
        d.polygon([(0.06 * n, c), (0.3 * n, 0.24 * n), (0.94 * n, 0.24 * n), (0.94 * n, 0.76 * n), (0.3 * n, 0.76 * n)], fill=orange)
        d.ellipse((0.2 * n, 0.45 * n, 0.3 * n, 0.55 * n), fill=(0, 0, 0, 0))
        _text(d, (0.62 * n, c), "$", round(0.36 * n), W)
    else:
        raise KeyError(sid)
    return im.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main(extra: list[str]) -> None:
    outs = [HERE, *(Path(p) for p in extra)]
    for out in outs:
        out.mkdir(parents=True, exist_ok=True)
    for sid in STICKERS:
        im = draw(sid)
        for out in outs:
            im.save(out / f"{sid}.png", optimize=True)
    print(f"{len(STICKERS)} stickers → {', '.join(map(str, outs))}")


if __name__ == "__main__":
    main(sys.argv[1:])
