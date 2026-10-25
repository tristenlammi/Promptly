"""Describing photos (PH-2, WP-PH2.6, Part E §E4.8).

The admin's "Photos vision" model (Admin → Models → Defaults) writes one sentence and
a few tags for each photo of the people who turned it on (Photos →
settings). What's sent is the media worker's preview, re-encoded as a JPEG
of at most 1024 px — renditions carry no metadata, so never a location.

* **Local** (an Ollama model, or any provider whose address is on this
  server's network): no limit.
* **Cloud**: the person turned it on knowing the provider's name, and the
  instance describes at most ``photos_vision_monthly_limit`` photos a
  calendar month — then it waits for the next month.
"""
from __future__ import annotations

import asyncio
import base64
import io
import ipaddress
import json
import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.captions")

TIMEOUT_SECONDS = 60.0
_LOCAL_HOSTS = {"localhost", "ollama", "host.docker.internal"}

_SYSTEM = (
    "You describe personal photos so they can be found later by searching. "
    "Reply with JSON only: {\"caption\": \"one plain sentence, at most 30 words, saying what the photo shows "
    "(people, animals, objects, place, activity, setting, time of day)\", \"tags\": [\"up to 12 short "
    "lowercase nouns or noun phrases\"]}. Describe only what is visible. Don't guess who people are, their "
    "names, or where exactly it is."
)
_PROMPT = "Describe this photo."


@dataclass(frozen=True)
class Vision:
    provider: Any  # ModelProvider
    model_id: str
    local: bool
    label: str
    monthly_limit: int


def is_local(provider: Any) -> bool:
    """On this server (or its private network): an Ollama provider, or one
    whose address is localhost / a private or Docker-internal host."""
    if (getattr(provider, "type", "") or "").lower() == "ollama":
        return True
    host = (urlparse(getattr(provider, "base_url", "") or "").hostname or "").lower()
    if not host:
        return False
    if host in _LOCAL_HOSTS or host.endswith((".local", ".internal", ".lan")) or "." not in host:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback


async def configured(db: AsyncSession) -> Vision | None:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.models_config.models import ModelProvider

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None or not row.photos_vision_configured:
        return None
    provider = await db.get(ModelProvider, row.photos_vision_provider_id)
    if provider is None or not getattr(provider, "enabled", True):
        return None
    local = is_local(provider)
    return Vision(
        provider, row.photos_vision_model_id, local,
        f"{row.photos_vision_model_id} ({provider.name}{', on this server' if local else ''})",
        int(row.photos_vision_monthly_limit or 0),
    )


async def used_this_month(db: AsyncSession) -> int:
    return int(
        await db.scalar(
            text("SELECT count(*) FROM photo_captions WHERE cloud AND created_at >= date_trunc('month', now())")
        ) or 0
    )


def _jpeg(raw: bytes) -> bytes:
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as im:
        im = im.convert("RGB")
        im.thumbnail((1024, 1024))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)  # no EXIF: nothing but the pixels
    return buf.getvalue()


def parse(reply: str) -> tuple[str, list[str]]:
    """The model's JSON (or, failing that, its text as the caption)."""
    m = re.search(r"\{.*\}", reply or "", re.S)
    if m:
        try:
            d = json.loads(m.group(0))
            caption = str(d.get("caption") or "").strip()
            tags = [str(t).strip().lower()[:40] for t in (d.get("tags") or []) if str(t).strip()][:12]
            if caption:
                return caption[:500], tags
        except (ValueError, AttributeError):
            pass
    return re.sub(r"\s+", " ", (reply or "").strip())[:500], []


async def describe(vision: Vision, preview: bytes, db: AsyncSession) -> tuple[str, list[str]]:
    """One photo's sentence and tags. Raises on a provider error."""
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model
    from app.models_config.provider import ChatMessage, ImagePart, TextPart, model_router

    provider, model_id = vision.provider, vision.model_id
    if is_custom_model_id(model_id):
        resolved = await resolve_custom_model(model_id, db)
        if resolved is None:
            raise RuntimeError("The Photos vision model is a custom model that no longer exists.")
        provider, model_id = resolved.base_provider, resolved.base_model_id
    data = await asyncio.to_thread(_jpeg, preview)
    url = "data:image/jpeg;base64," + base64.b64encode(data).decode()
    message = ChatMessage(role="user", content=[TextPart(text=_PROMPT), ImagePart(url=url)])
    async with asyncio.timeout(TIMEOUT_SECONDS):
        parts = [t async for t in model_router.stream_chat(
            provider=provider, model_id=model_id, messages=[message], system=_SYSTEM, temperature=0.2,
            # A sentence and some tags: no thinking first. A reasoning model
            # (Qwen 3.x Flash, DeepSeek…) otherwise spent the whole budget
            # thinking and answered nothing — every photo "couldn't be read".
            max_tokens=500, reasoning_effort="off",
        )]
    caption, tags = parse("".join(parts))
    if not caption:
        raise RuntimeError("The model gave no description.")
    return caption, tags


__all__ = ["Vision", "configured", "describe", "is_local", "parse", "used_this_month"]
