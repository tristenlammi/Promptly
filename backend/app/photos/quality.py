"""How good a photo is, and which photos are nearly the same (PH-2,
WP-PH2.1) — read from the media worker's preview, never the original.

* **pHash** — the classic perceptual hash: 32×32 greyscale, a 2-D DCT, the
  8×8 lowest frequencies against their median → 64 bits. Two photos a few
  bits apart (Hamming distance ≤ ~8) are the same scene: a burst, a resave,
  a crop. Stored as a signed BIGINT; ``bit_count(a # b)`` compares them.
* **Sharpness** — the variance of the Laplacian at 512 px, on a log scale to
  0–1 (blurry shots sit under ~0.4).
* **Brightness** — mean luminance 0–1; with clipping it gives an exposure
  score (a black or blown-out frame scores low).
* **Quality** — 0.6 × sharpness + 0.4 × exposure: "the best of a burst".
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_DCT = None


def _dct_matrix(n: int = 32) -> np.ndarray:
    global _DCT
    if _DCT is None:
        k = np.arange(n)[:, None]
        i = np.arange(n)[None, :]
        m = np.cos(np.pi * (2 * i + 1) * k / (2 * n)) * math.sqrt(2 / n)
        m[0, :] = math.sqrt(1 / n)
        _DCT = m
    return _DCT


@dataclass(frozen=True)
class Quality:
    phash: int
    sharpness: float
    brightness: float
    quality: float


def phash_of(grey: np.ndarray) -> int:
    """64-bit pHash of a 32×32 float image, as a signed int64."""
    c = _dct_matrix(32)
    low = (c @ grey @ c.T)[:8, :8].flatten()
    median = np.median(low[1:])  # the DC term would skew it
    bits = 0
    for v in low:
        bits = (bits << 1) | int(v > median)
    return bits - (1 << 64) if bits >= (1 << 63) else bits


def hamming(a: int, b: int) -> int:
    return bin((a ^ b) & ((1 << 64) - 1)).count("1")


def measure(path: Path) -> Quality:
    from PIL import Image

    with Image.open(path) as im:
        im = im.convert("L")
        small = im.resize((32, 32), Image.Resampling.LANCZOS)
        im.thumbnail((512, 512))
        g = np.asarray(im, dtype=np.float32)
    ph = phash_of(np.asarray(small, dtype=np.float64))
    if g.shape[0] < 3 or g.shape[1] < 3:
        return Quality(ph, 0.0, float(g.mean() / 255) if g.size else 0.0, 0.0)
    lap = g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:] - 4 * g[1:-1, 1:-1]
    sharp = min(1.0, math.log1p(float(lap.var())) / math.log1p(1500.0))
    bright = float(g.mean() / 255)
    clipped = float(((g < 5) | (g > 250)).mean())
    exposure = max(0.0, 1.0 - abs(bright - 0.47) * 1.6 - clipped * 1.5)
    return Quality(ph, round(sharp, 4), round(bright, 4), round(0.6 * sharp + 0.4 * exposure, 4))


__all__ = ["Quality", "hamming", "measure", "phash_of"]
