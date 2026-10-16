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
     "brightness": -1…1, "contrast": -1…1, "saturation": -1…1}
"""
from __future__ import annotations

import io
import logging
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.edits")

EDIT_FILES = ("thumb.edit.webp", "preview.edit.webp")
_IDENTITY = {"rotate": 0, "flip": False, "crop": None, "brightness": 0.0, "contrast": 0.0, "saturation": 0.0}


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


def render(path: Path, file_id: uuid.UUID, kind: str, ops: dict[str, Any], size: tuple[int, int] | None) -> dict[str, Any]:
    """The edited tile and preview (sync, CPU). → renditions entries."""
    from PIL import Image

    from app.files.derivatives import PREVIEW, THUMB, _save_webp, open_source, rendition_path
    from app.files.thumbhash import image_to_thumbhash

    src = open_source(path, kind)
    if size is None:
        size = src.size
    im = apply(src, ops)
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "PA") else "RGB")
    big = im.copy()
    big.thumbnail((PREVIEW, PREVIEW), Image.LANCZOS, reducing_gap=3.0)
    out: dict[str, Any] = {"preview.edit.webp": _save_webp(big, rendition_path(file_id, "preview.edit.webp"), 82)}
    small = big.copy()
    small.thumbnail((THUMB, THUMB), Image.LANCZOS)
    out["thumb.edit.webp"] = _save_webp(small, rendition_path(file_id, "thumb.edit.webp"), 76)
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
