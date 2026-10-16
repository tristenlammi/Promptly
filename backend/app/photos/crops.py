"""Square crops of faces and animals (PH-3): what People & Pets show.

Cut from the media worker's preview with room around the box, 192 px,
WebP, cached at ``derived/<file_id>/obs/<observation_id>.webp`` (deleted
with the photo's other renditions). Only the photo's owner gets a link.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

SIZE = 192
ROOM = 0.35  # around the box, each side, as a share of its larger edge


def crop_path(file_id: uuid.UUID, obs_id: uuid.UUID) -> Path:
    from app.files.derivatives import derived_dir

    return derived_dir(file_id) / "obs" / f"{obs_id}.webp"


def _cut(preview: Path, box: tuple[float, float, float, float], out: Path) -> None:
    from PIL import Image

    with Image.open(preview) as im:
        im = im.convert("RGB")
        w, h = im.size
        x, y, bw, bh = box
        side = max(bw * w, bh * h) * (1 + 2 * ROOM)
        cx, cy = (x + bw / 2) * w, (y + bh / 2) * h
        left, top = max(0, int(cx - side / 2)), max(0, int(cy - side / 2))
        right, bottom = min(w, int(cx + side / 2)), min(h, int(cy + side / 2))
        tile = im.crop((left, top, max(right, left + 1), max(bottom, top + 1)))
        tile.thumbnail((SIZE, SIZE))
        out.parent.mkdir(parents=True, exist_ok=True)
        part = out.with_suffix(".part")
        tile.save(part, "WEBP", quality=82)
        part.chmod(0o644)  # nginx serves it
        part.replace(out)


async def ensure(db: AsyncSession, obs_id: uuid.UUID, user_id: uuid.UUID) -> Path | None:
    """The crop's path (made if missing), or None if it isn't the user's."""
    from app.files.derivatives import rendition_path

    row: Any = None
    for table in ("photo_faces", "photo_animals"):
        row = (
            await db.execute(
                text(f"SELECT file_id, box_x, box_y, box_w, box_h FROM {table} WHERE id = :o AND user_id = :u"),
                {"o": obs_id, "u": user_id},
            )
        ).first()
        if row is not None:
            break
    if row is None:
        return None
    out = crop_path(row.file_id, obs_id)
    if out.is_file():
        return out
    preview = rendition_path(row.file_id, "preview.webp")
    if not preview.is_file():
        return None
    await asyncio.to_thread(_cut, preview, (row.box_x, row.box_y, row.box_w, row.box_h), out)
    return out


__all__ = ["crop_path", "ensure"]
