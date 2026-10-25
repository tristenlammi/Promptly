"""Faces that are really animals (PH-3): the face detector (YuNet) finds a
dog's or cat's face too, and its faces then cluster into a "person". Each
face's crop is asked of SigLIP 2 — the photo-search model, already loaded —
whether it looks more like a person's face than an animal's, against a few
captions of each; animal faces are dropped.

Used on every new face (``understanding._run_faces``) and, once, over the
faces already found (the ``face_check`` stage). A face someone put a name
to themselves (``assigned_by = 'user'``) is never removed.
"""
from __future__ import annotations

import asyncio
import io
import logging
from typing import Any

logger = logging.getLogger("promptly.photos.face_check")

HUMAN = ("a photo of a person's face", "a close-up photo of a human face", "a selfie of a person")
ANIMAL = (
    "a photo of a dog's face", "a photo of a cat's face", "a close-up photo of an animal", "a photo of a dog",
    "a photo of a cat",
)
# How much wider than the face box the crop is: a dog's face box alone can
# look like anything; with its ears and fur it's plainly a dog.
PAD = 0.35


async def _prompt_vectors() -> Any:
    """The captions' vectors (one small request, per batch of faces)."""
    import numpy as np

    from app.photos import ml

    _model, vecs = await ml.embed_texts(list(HUMAN + ANIMAL))
    return np.array(vecs, dtype="float32")


def crop(preview: bytes, box: tuple[float, float, float, float]) -> bytes:
    """A square crop around a face (box as 0–1 of the picture), padded."""
    from PIL import Image

    with Image.open(io.BytesIO(preview)) as im:
        im = im.convert("RGB")
        w, h = im.size
        x, y, bw, bh = box
        cx, cy = (x + bw / 2) * w, (y + bh / 2) * h
        side = max(bw * w, bh * h) * (1 + PAD)
        part = im.crop((int(cx - side / 2), int(cy - side / 2), int(cx + side / 2), int(cy + side / 2)))
        out = io.BytesIO()
        part.save(out, "WEBP", quality=85)
        return out.getvalue()


async def human(crops: list[bytes]) -> list[bool]:
    """For each face crop: does it look like a person (True) or an animal?
    Raises if the photos service can't answer (the caller keeps the faces)."""
    import numpy as np

    from app.photos import ml

    if not crops:
        return []
    prompts = await _prompt_vectors()
    out: list[bool] = []
    for i in range(0, len(crops), 16):
        _model, vecs = await ml.embed_images(crops[i : i + 16])
        for v in vecs:
            if v is None:
                out.append(True)  # unreadable: leave it as it was found
                continue
            sims = prompts @ np.array(v, dtype="float32")
            out.append(bool(sims[: len(HUMAN)].max() >= sims[len(HUMAN):].max()))
    return out


async def keep_human(preview: bytes, faces: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The faces (as photos-ml returns them) that are people's."""
    if not faces:
        return faces
    crops = await asyncio.to_thread(lambda: [crop(preview, tuple(f["box"])) for f in faces])
    verdicts = await human(crops)
    kept = [f for f, ok in zip(faces, verdicts) if ok]
    if len(kept) < len(faces):
        logger.info("dropped %d animal face(s)", len(faces) - len(kept))
    return kept


__all__ = ["ANIMAL", "HUMAN", "crop", "human", "keep_human"]
