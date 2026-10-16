"""ThumbHash encoding (WP-7.4) — a ~25-byte blurred placeholder a photo grid
shows while the real thumbnail loads.

A numpy port of ``rgbaToThumbHash`` from Evan Wallace's reference
implementation (https://github.com/evanw/thumbhash, MIT), bit-for-bit: the
frontend decodes with the reference ``thumbhash`` npm package. (The PyPI
port pins Pillow<11, which Promptly is past.)
"""
from __future__ import annotations

import base64
import math

import numpy as np


def _round(x: float) -> int:
    # JavaScript's Math.round: halves go up (Python's round() goes to even).
    return int(math.floor(x + 0.5))


def rgba_to_thumbhash(w: int, h: int, rgba: bytes | np.ndarray) -> bytes:
    if w > 100 or h > 100:
        raise ValueError(f"{w}x{h} doesn't fit in 100x100")
    px = np.frombuffer(bytes(rgba), dtype=np.uint8).astype(np.float64).reshape(h * w, 4)
    alpha = px[:, 3] / 255.0
    avg_a = float(alpha.sum())
    avg_r = float((alpha / 255.0 * px[:, 0]).sum())
    avg_g = float((alpha / 255.0 * px[:, 1]).sum())
    avg_b = float((alpha / 255.0 * px[:, 2]).sum())
    if avg_a:
        avg_r /= avg_a
        avg_g /= avg_a
        avg_b /= avg_a
    has_alpha = avg_a < w * h
    l_limit = 5 if has_alpha else 7
    lx = max(1, _round(l_limit * w / max(w, h)))
    ly = max(1, _round(l_limit * h / max(w, h)))

    r = avg_r * (1 - alpha) + alpha / 255.0 * px[:, 0]
    g = avg_g * (1 - alpha) + alpha / 255.0 * px[:, 1]
    b = avg_b * (1 - alpha) + alpha / 255.0 * px[:, 2]
    channels = {
        "l": ((r + g + b) / 3).reshape(h, w),
        "p": ((r + g) / 2 - b).reshape(h, w),
        "q": (r - g).reshape(h, w),
        "a": alpha.reshape(h, w),
    }
    xs = np.arange(w) + 0.5
    ys = np.arange(h) + 0.5

    def encode(channel: np.ndarray, nx: int, ny: int) -> tuple[float, list[float], float]:
        dc = 0.0
        ac: list[float] = []
        scale = 0.0
        for cy in range(ny):
            fy = np.cos(math.pi / h * cy * ys)
            cx = 0
            while cx * ny < nx * (ny - cy):
                fx = np.cos(math.pi / w * cx * xs)
                # The reference adds the terms one by one, row by row, each
                # as (value × fx) × fy; cumsum keeps that order (sum() pairs
                # them up), so the rounding matches bit for bit.
                terms = (channel * fx[np.newaxis, :]) * fy[:, np.newaxis]
                f = float(np.cumsum(terms.ravel())[-1]) / (w * h)
                if cx or cy:
                    ac.append(f)
                    scale = max(scale, abs(f))
                else:
                    dc = f
                cx += 1
        if scale:
            ac = [0.5 + 0.5 / scale * v for v in ac]
        return dc, ac, scale

    l_dc, l_ac, l_scale = encode(channels["l"], max(3, lx), max(3, ly))
    p_dc, p_ac, p_scale = encode(channels["p"], 3, 3)
    q_dc, q_ac, q_scale = encode(channels["q"], 3, 3)
    a_dc, a_ac, a_scale = encode(channels["a"], 5, 5) if has_alpha else (0.0, [], 0.0)
    is_landscape = w > h
    header24 = (
        _round(63 * l_dc)
        | (_round(31.5 + 31.5 * p_dc) << 6)
        | (_round(31.5 + 31.5 * q_dc) << 12)
        | (_round(31 * l_scale) << 18)
        | (int(has_alpha) << 23)
    )
    header16 = (ly if is_landscape else lx) | (_round(63 * p_scale) << 3) | (_round(63 * q_scale) << 9) | (int(is_landscape) << 15)
    out = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8]
    ac_start = 6 if has_alpha else 5
    if has_alpha:
        out.append(_round(15 * a_dc) | (_round(15 * a_scale) << 4))
    index = 0
    for ac in ([l_ac, p_ac, q_ac, a_ac] if has_alpha else [l_ac, p_ac, q_ac]):
        for f in ac:
            pos = ac_start + (index >> 1)
            while len(out) <= pos:
                out.append(0)
            out[pos] |= _round(15 * f) << ((index & 1) << 2)
            index += 1
    return bytes(v & 255 for v in out)


def image_to_thumbhash(image) -> str:  # noqa: ANN001 — PIL.Image
    """A PIL image → its ThumbHash, base64 (fits the 64-char column)."""
    im = image.convert("RGBA")
    im.thumbnail((100, 100))
    return base64.b64encode(rgba_to_thumbhash(im.width, im.height, im.tobytes())).decode("ascii")


__all__ = ["image_to_thumbhash", "rgba_to_thumbhash"]
