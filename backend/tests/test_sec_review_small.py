"""Small hardening from the 2026-11 security review."""
from __future__ import annotations

import io
import sys


async def test_a_command_that_never_ends_is_stopped():
    from app.rooms import voice

    code = await voice._run(sys.executable, "-c", "import time; time.sleep(60)", timeout=0.5)
    assert code == 124


def test_a_preview_picture_too_big_to_open_is_not_opened(monkeypatch):
    from PIL import Image

    from app.rooms import media

    buf = io.BytesIO()
    Image.new("RGB", (400, 300), "red").save(buf, format="PNG")
    assert media._thumb(buf.getvalue()) is not None
    monkeypatch.setattr(media, "PREVIEW_MAX_PIXELS", 100_000)  # 400 x 300 is now "too big"
    assert media._thumb(buf.getvalue()) is None
