"""The built-in stickers for photo markup (PH-7): ``<id>.png`` here, drawn
by ``make_stickers`` (which also writes the frontend's copies)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent

# id → (label, tintable). Order is the picker's. Tintable ones are drawn
# white and take the chosen colour.
STICKERS: dict[str, tuple[str, bool]] = {
    "circle": ("Hand-drawn circle", True),
    "arrow": ("Arrow", True),
    "curved-arrow": ("Curved arrow", True),
    "check": ("Tick", True),
    "cross": ("Cross", True),
    "star": ("Star", True),
    "heart": ("Heart", True),
    "sparkle": ("Sparkle", True),
    "squiggle": ("Squiggle", True),
    "speech": ("Speech bubble", False),
    "thought": ("Thought bubble", False),
    "exclaim": ("! badge", False),
    "question": ("? badge", False),
    "new": ("NEW", False),
    "sold": ("SOLD", False),
    "price": ("Price tag", False),
}
TINTABLE = frozenset(k for k, (_, t) in STICKERS.items() if t)


@lru_cache(maxsize=32)
def load(sid: str):  # noqa: ANN201 — PIL.Image (RGBA)
    from PIL import Image

    if sid not in STICKERS:
        raise KeyError(sid)
    im = Image.open(HERE / f"{sid}.png")
    im.load()
    return im.convert("RGBA")


__all__ = ["STICKERS", "TINTABLE", "load"]
