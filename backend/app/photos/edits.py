"""Photo editing (PH-7, Part E §E5): non-destructive crop / rotate / flip /
brightness / contrast / saturation.

The edit is a record (``photo_edits.ops``); the original file is never
touched. What you see — the grid tile and the viewer's preview — is made
again with the edit applied (``thumb.edit.webp``, ``preview.edit.webp``,
listed in the file's ``renditions`` with ``edit``: the edited size and
ThumbHash), and a signed link prefers those (:func:`app.files.media_urls.shown`).
Understanding keeps reading the original's renditions, so faces and
search don't move. "Download edited" renders the full-size JPEG on demand;
Revert removes the record and the edited renditions.

Ops, applied in this order (crop is in the rotated, flipped frame):

    {"rotate": 0|90|180|270, "flip": bool,
     "crop": {"x", "y", "w", "h"} (0–1) | null,
     "brightness": -1…1, "contrast": -1…1, "saturation": -1…1,
     "markup": [shape, …]}

Markup is drawn last, on the finished (cropped, adjusted) picture. Every
coordinate is 0–1 of that final frame and every width / text size is a
fraction of its shorter side, so a tile, the preview and the full-size
export all match:

    {"type": "pen" | "highlighter", "color": "#rrggbb", "width": w, "points": [[x, y], …]}
    {"type": "line" | "arrow" | "rect" | "ellipse", "color", "width", "points": [start, end]}
    {"type": "text", "color", "size": s, "points": [top-left], "text": "…"}
    {"type": "blur", "points": [corner, corner]}   (pixelated — to hide something)

Blur boxes go first (they hide what's in the photo, not other marks); the
rest are drawn in order. The editor's preview draws them the same way.
"""
from __future__ import annotations

import io
import logging
import math
import re
from functools import lru_cache
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.edits")

EDIT_FILES = ("thumb.edit.webp", "preview.edit.webp")
_IDENTITY = {"rotate": 0, "flip": False, "crop": None, "brightness": 0.0, "contrast": 0.0, "saturation": 0.0, "markup": []}

MARKUP_TYPES = ("pen", "highlighter", "line", "arrow", "rect", "ellipse", "text", "blur", "emoji", "sticker")
MAX_EMOJI = 8  # code points: a flag, a skin tone, a family
MAX_SHAPES = 500
MAX_POINTS = 2000  # in one stroke
MAX_TOTAL_POINTS = 50_000
MAX_TEXT = 200
HIGHLIGHT_ALPHA = 0.4
PIXEL_BLOCK = 0.03  # a blur box's blocks, as a fraction of the shorter side
_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def _unit(v: Any) -> float:
    # A little past the edge is fine (an arrow drawn in from outside).
    f = float(v)
    if not math.isfinite(f):
        raise ValueError
    return round(min(max(f, -0.5), 1.5), 5)


def _shape(raw: Any) -> dict[str, Any] | None:  # noqa: C901
    """One markup shape, cleaned — or None when there's nothing to draw."""
    if not isinstance(raw, dict) or raw.get("type") not in MARKUP_TYPES:
        return None
    kind = raw["type"]
    try:
        pts = [[_unit(p[0]), _unit(p[1])] for p in list(raw.get("points") or [])[:MAX_POINTS]]
    except (TypeError, ValueError, IndexError, KeyError):
        return None
    need = 2 if kind in ("line", "arrow", "rect", "ellipse", "blur") else 1
    if len(pts) < need:
        return None
    if kind not in ("pen", "highlighter"):
        pts = pts[:need]
    out: dict[str, Any] = {"type": kind, "points": pts}
    if kind in ("emoji", "sticker"):
        try:
            out["size"] = round(min(max(float(raw.get("size") or 0.2), 0.02), 1.0), 5)
            rot = float(raw.get("rotation") or 0.0)
            if not math.isfinite(rot):
                raise ValueError
        except (TypeError, ValueError):
            return None
        out["rotation"] = round(((rot + 180.0) % 360.0) - 180.0, 2)
        if kind == "emoji":
            em = str(raw.get("emoji") or "").strip()
            if not em or len(em) > MAX_EMOJI or any(ch.isspace() or ord(ch) < 0x20 or ch.isascii() and ch.isalnum() for ch in em):
                return None
            out["emoji"] = em
        else:
            from app.photos.stickers import STICKERS, TINTABLE

            sid = str(raw.get("sticker") or "")
            if sid not in STICKERS:
                return None
            out["sticker"] = sid
            if sid in TINTABLE:
                color = str(raw.get("color") or "")
                out["color"] = color.lower() if _COLOR.match(color) else "#ff0000"
        return out
    if kind == "blur":
        x0, x1 = sorted((min(max(pts[0][0], 0.0), 1.0), min(max(pts[1][0], 0.0), 1.0)))
        y0, y1 = sorted((min(max(pts[0][1], 0.0), 1.0), min(max(pts[1][1], 0.0), 1.0)))
        if x1 - x0 < 0.002 or y1 - y0 < 0.002:
            return None
        out["points"] = [[x0, y0], [x1, y1]]
        return out
    color = str(raw.get("color") or "")
    out["color"] = color.lower() if _COLOR.match(color) else "#ff0000"
    if kind == "text":
        txt = " ".join(str(raw.get("text") or "").split())[:MAX_TEXT]
        if not txt:
            return None
        out["text"] = txt
        try:
            out["size"] = round(min(max(float(raw.get("size") or 0.05), 0.01), 0.3), 5)
        except (TypeError, ValueError):
            out["size"] = 0.05
        return out
    try:
        out["width"] = round(min(max(float(raw.get("width") or 0.01), 0.001), 0.15), 5)
    except (TypeError, ValueError):
        out["width"] = 0.01
    return out


def normalise_markup(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    total = 0
    for item in (raw if isinstance(raw, list) else [])[:MAX_SHAPES]:
        shape = _shape(item)
        if shape is None:
            continue
        total += len(shape["points"])
        if total > MAX_TOTAL_POINTS:
            break
        out.append(shape)
    return out


def normalise(ops: dict[str, Any]) -> dict[str, Any]:
    out = {**_IDENTITY, **{k: v for k, v in (ops or {}).items() if k in _IDENTITY}}
    out["rotate"] = int(out["rotate"] or 0) % 360
    crop = out.get("crop")
    if crop:
        x, y = min(max(float(crop["x"]), 0.0), 1.0), min(max(float(crop["y"]), 0.0), 1.0)
        w, h = min(max(float(crop["w"]), 0.0), 1.0 - x), min(max(float(crop["h"]), 0.0), 1.0 - y)
        out["crop"] = None if (w >= 0.999 and h >= 0.999) or w < 0.01 or h < 0.01 else {"x": x, "y": y, "w": w, "h": h}
    for k in ("brightness", "contrast", "saturation"):
        out[k] = round(min(max(float(out[k] or 0.0), -1.0), 1.0), 3)
    out["markup"] = normalise_markup(out.get("markup"))
    return out


def is_identity(ops: dict[str, Any]) -> bool:
    return normalise(ops) == _IDENTITY


def edited_size(width: int, height: int, ops: dict[str, Any]) -> tuple[int, int]:
    """The upright original's size → the edited picture's."""
    ops = normalise(ops)
    if ops["rotate"] in (90, 270):
        width, height = height, width
    if ops["crop"]:
        width, height = max(1, round(width * ops["crop"]["w"])), max(1, round(height * ops["crop"]["h"]))
    return width, height


def apply(im, ops: dict[str, Any]):  # noqa: ANN001, ANN201 — PIL.Image in, PIL.Image out
    from PIL import Image, ImageEnhance

    ops = normalise(ops)
    if ops["rotate"]:
        # Clockwise, as the buttons say; PIL's transpose turns anticlockwise.
        im = im.transpose({90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}[ops["rotate"]])
    if ops["flip"]:
        im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if ops["crop"]:
        c = ops["crop"]
        box = (round(c["x"] * im.width), round(c["y"] * im.height), round((c["x"] + c["w"]) * im.width), round((c["y"] + c["h"]) * im.height))
        im = im.crop(box)
    if ops["brightness"] or ops["contrast"] or ops["saturation"]:
        rgb = im.convert("RGB")
        if ops["brightness"]:
            rgb = ImageEnhance.Brightness(rgb).enhance(1.0 + ops["brightness"])
        if ops["contrast"]:
            rgb = ImageEnhance.Contrast(rgb).enhance(1.0 + ops["contrast"])
        if ops["saturation"]:
            rgb = ImageEnhance.Color(rgb).enhance(1.0 + ops["saturation"])
        im = rgb
    if ops["markup"]:
        im = draw_markup(im, ops["markup"])
    return im


_FONTS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _font(px: int):  # noqa: ANN202
    from PIL import ImageFont

    for path in _FONTS:
        try:
            return ImageFont.truetype(path, px)
        except OSError:
            continue
    return ImageFont.load_default(size=px)


def _rgb(color: str) -> tuple[int, int, int]:
    return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)


def outline_for(color: str) -> tuple[int, int, int]:
    """Text gets a thin outline that stands out from its fill."""
    r, g, b = _rgb(color)
    return (255, 255, 255) if 0.299 * r + 0.587 * g + 0.114 * b < 60 else (0, 0, 0)


def arrow_head(x0: float, y0: float, x1: float, y1: float, w: float, short: float) -> list[tuple[float, float]]:
    """The arrowhead's triangle (pixels): as long as 4 strokes or 2.5% of
    the shorter side, whichever is bigger. The frontend draws the same."""
    length = max(4 * w, 0.025 * short)
    ang = math.atan2(y1 - y0, x1 - x0)
    spread = math.radians(28)
    return [
        (x1, y1),
        (x1 - length * math.cos(ang - spread), y1 - length * math.sin(ang - spread)),
        (x1 - length * math.cos(ang + spread), y1 - length * math.sin(ang + spread)),
    ]


EMOJI_FONTS = (
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf",
)


@lru_cache(maxsize=256)
def _emoji(em: str):  # noqa: ANN202 — PIL.Image (RGBA), cropped to the ink
    """An emoji, in colour (Noto Color Emoji's bitmaps are 109 px). Without
    the font, the plain one's outline — never an error."""
    from PIL import Image, ImageDraw, ImageFont

    font = None
    for path in EMOJI_FONTS:
        try:
            font = ImageFont.truetype(path, 109)
            break
        except OSError:
            continue
    if font is None:
        font = _font(109)
    im = Image.new("RGBA", (320, 220), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((20, 20), em, font=font, embedded_color=True)
    box = im.getchannel("A").getbbox()
    return im.crop(box) if box else im.crop((0, 0, 1, 1))


def _sticker(sid: str, color: str | None):  # noqa: ANN202
    from PIL import Image

    from app.photos.stickers import TINTABLE, load

    im = load(sid)
    if sid in TINTABLE and color:
        tinted = Image.new("RGBA", im.size, (*_rgb(color), 255))
        tinted.putalpha(im.getchannel("A"))
        return tinted
    return im


def _place(layer, pic, centre: tuple[float, float], width: float, rotation: float) -> None:  # noqa: ANN001
    """An emoji or sticker: ``width`` pixels wide (its ink), turned
    ``rotation`` degrees clockwise about its centre."""
    from PIL import Image

    w = max(1, round(width))
    h = max(1, round(width * pic.height / max(1, pic.width)))
    out = pic.resize((w, h), Image.Resampling.LANCZOS)
    if rotation:
        out = out.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=True)
    x, y = round(centre[0] - out.width / 2), round(centre[1] - out.height / 2)
    # alpha_composite won't take a spot partly off the picture: clip it.
    sx, sy = max(0, -x), max(0, -y)
    ex, ey = min(out.width, layer.width - x), min(out.height, layer.height - y)
    if ex <= sx or ey <= sy:
        return
    layer.alpha_composite(out.crop((sx, sy, ex, ey)), (x + sx, y + sy))


def _pixelate(im, box: tuple[int, int, int, int], block: int):  # noqa: ANN001, ANN202
    from PIL import Image

    x0, y0, x1, y1 = box
    if x1 - x0 < 1 or y1 - y0 < 1:
        return im
    region = im.crop(box)
    small = region.resize((max(1, -(-(x1 - x0) // block)), max(1, -(-(y1 - y0) // block))), Image.Resampling.BOX)
    im.paste(small.resize(region.size, Image.Resampling.NEAREST), (x0, y0))
    return im


def draw_markup(im, shapes: list[dict[str, Any]]):  # noqa: ANN001, ANN201, C901
    """The marks, on the finished picture (PIL in, PIL out). Drawn on a
    supersampled layer and scaled down, so edges are smooth."""
    from PIL import Image, ImageDraw

    mode = "RGBA" if im.mode in ("RGBA", "LA", "PA") else "RGB"
    im = im.convert(mode) if im.mode != mode else im.copy()
    W, H = im.size
    short = min(W, H)
    # Redactions first, on the photo itself.
    block = max(2, round(PIXEL_BLOCK * short))
    for s in shapes:
        if s["type"] == "blur":
            (ax, ay), (bx, by) = s["points"]
            im = _pixelate(im, (round(ax * W), round(ay * H), round(bx * W), round(by * H)), block)
    marks = [s for s in shapes if s["type"] != "blur"]
    if not marks:
        return im
    ss = max(1, min(3, 3000 // max(W, H)))
    LW, LH = W * ss, H * ss
    layer = Image.new("RGBA", (LW, LH), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    lshort = short * ss

    def px(p: list[float]) -> tuple[float, float]:
        return p[0] * LW, p[1] * LH

    def stroke(points: list[tuple[float, float]], fill: tuple[int, ...], w: float, on=None) -> None:  # noqa: ANN001
        on = on or draw
        r = w / 2
        if len(points) > 1:
            on.line(points, fill=fill, width=max(1, round(w)), joint="curve")
        for x, y in (points[0], points[-1]) if len(points) > 1 else points:
            on.ellipse((x - r, y - r, x + r, y + r), fill=fill)

    for s in marks:
        kind = s["type"]
        if kind in ("emoji", "sticker"):
            pic = _emoji(s["emoji"]) if kind == "emoji" else _sticker(s["sticker"], s.get("color"))
            _place(layer, pic, px(s["points"][0]), s["size"] * lshort, s["rotation"])
            continue
        color = _rgb(s["color"])
        if kind == "text":
            size = max(4, round(s["size"] * lshort))
            x, y = px(s["points"][0])
            draw.text((x, y), s["text"], font=_font(size), fill=(*color, 255), anchor="lt",
                      stroke_width=max(1, round(size * 0.06)), stroke_fill=(*outline_for(s["color"]), 255))
            continue
        w = max(1.0, s["width"] * lshort)
        pts = [px(p) for p in s["points"]]
        if kind == "highlighter":
            # On its own, so where it crosses itself it isn't darker.
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            ox, oy = max(0, int(min(xs) - w)), max(0, int(min(ys) - w))
            ex, ey = min(LW, int(max(xs) + w) + 1), min(LH, int(max(ys) + w) + 1)
            if ex <= ox or ey <= oy:
                continue
            mask = Image.new("L", (ex - ox, ey - oy), 0)
            stroke([(x - ox, y - oy) for x, y in pts], 255, w, ImageDraw.Draw(mask))
            mask = mask.point(lambda v: round(v * HIGHLIGHT_ALPHA))
            patch = Image.new("RGBA", mask.size, (*color, 255))
            patch.putalpha(mask)
            layer.alpha_composite(patch, (ox, oy))
            continue
        fill = (*color, 255)
        if kind == "pen":
            stroke(pts, fill, w)
        elif kind in ("line", "arrow"):
            (x0, y0), (x1, y1) = pts
            if kind == "arrow":
                head = arrow_head(x0, y0, x1, y1, w, lshort)
                # The shaft stops inside the head, so its end doesn't poke out.
                bx, by = (head[1][0] + head[2][0]) / 2, (head[1][1] + head[2][1]) / 2
                stroke([(x0, y0), ((bx + x1) / 2, (by + y1) / 2)], fill, w)
                draw.polygon(head, fill=fill)
            else:
                stroke([(x0, y0), (x1, y1)], fill, w)
        elif kind in ("rect", "ellipse"):
            (x0, y0), (x1, y1) = pts
            x0, x1 = sorted((x0, x1))
            y0, y1 = sorted((y0, y1))
            # Centred on the outline, as a browser strokes it.
            box = (x0 - w / 2, y0 - w / 2, x1 + w / 2, y1 + w / 2)
            if box[2] - box[0] < 1 or box[3] - box[1] < 1:
                continue
            if kind == "rect":
                draw.rectangle(box, outline=fill, width=max(1, round(w)))
            else:
                draw.ellipse(box, outline=fill, width=max(1, round(w)))
    if ss > 1:
        layer = layer.resize((W, H), Image.Resampling.LANCZOS)
    if mode == "RGB":
        base = im.convert("RGBA")
        base.alpha_composite(layer)
        return base.convert("RGB")
    im.alpha_composite(layer)
    return im

def _open_full(path: Path, kind: str):  # noqa: ANN201
    """The whole picture, upright (a raw's embedded preview)."""
    from PIL import Image, ImageOps

    import app.files.imaging  # noqa: F401 — HEIC
    from app.files.derivatives import open_source

    if kind == "raw":
        return open_source(path, kind)
    im = Image.open(path)
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)
    im.load()
    return ImageOps.exif_transpose(im)


def render(
    path: Path, file_id: uuid.UUID, kind: str, ops: dict[str, Any], size: tuple[int, int] | None,
    names: tuple[str, str] = EDIT_FILES,
) -> dict[str, Any]:
    """The edited tile and preview (sync, CPU). → renditions entries.

    ``names`` are the (tile, preview) file names under ``derived/<file_id>/``:
    the library's edited renditions by default; a Porch post's own crop or
    filter writes ``porch-<media_id>.*`` there instead (app/porch/media.py)."""
    from PIL import Image

    from app.files.derivatives import PREVIEW, THUMB, _save_webp, derived_dir, open_source
    from app.files.thumbhash import image_to_thumbhash

    thumb_name, preview_name = names
    src = open_source(path, kind)
    if size is None:
        size = src.size
    im = apply(src, ops)
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "PA") else "RGB")
    big = im.copy()
    big.thumbnail((PREVIEW, PREVIEW), Image.LANCZOS, reducing_gap=3.0)
    out: dict[str, Any] = {preview_name: _save_webp(big, derived_dir(file_id) / preview_name, 82)}
    small = big.copy()
    small.thumbnail((THUMB, THUMB), Image.LANCZOS)
    out[thumb_name] = _save_webp(small, derived_dir(file_id) / thumb_name, 76)
    w, h = edited_size(size[0], size[1], ops)
    out["edit"] = {"width": w, "height": h, "thumbhash": image_to_thumbhash(small)}
    return out


def export_jpeg(path: Path, kind: str, ops: dict[str, Any]) -> bytes:
    """The full-size edited picture as a JPEG (sync, CPU)."""
    im = apply(_open_full(path, kind), ops)
    if im.mode != "RGB":
        im = im.convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92, optimize=True)
    return buf.getvalue()


def _upright(media: Any) -> tuple[int, int] | None:
    if not media.width or not media.height:
        return None
    if media.orientation in (5, 6, 7, 8):
        return media.height, media.width
    return media.width, media.height


async def apply_to_renditions(db: AsyncSession, file_id: uuid.UUID) -> bool:
    """Make (or remove) the edited renditions from the file's edit record.
    True when the photo is shown edited. Committed by the caller."""
    import asyncio

    from app.files.derivatives import rendition_path
    from app.files.models import FileMedia, UserFile
    from app.files.storage import absolute_path

    media = await db.get(FileMedia, file_id)
    row = await db.get(UserFile, file_id)
    if media is None or row is None:
        return False
    ops = await db.scalar(text("SELECT ops FROM photo_edits WHERE file_id = :f"), {"f": file_id})
    renditions = {k: v for k, v in (media.renditions or {}).items() if k not in (*EDIT_FILES, "edit")}
    if not ops or is_identity(ops):
        for name in EDIT_FILES:
            rendition_path(file_id, name).unlink(missing_ok=True)
        media.renditions = renditions
        return False
    kind = media.kind if media.kind in ("image", "raw") else "image"
    made = await asyncio.to_thread(render, absolute_path(row.storage_path), file_id, kind, ops, _upright(media))
    media.renditions = {**renditions, **made}
    return True


__all__ = ["EDIT_FILES", "apply", "apply_to_renditions", "edited_size", "export_jpeg", "is_identity", "normalise", "render"]
