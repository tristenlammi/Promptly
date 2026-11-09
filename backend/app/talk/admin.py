"""Admin -> Talk (WP-T6): the switch, who may use it, live slots, the speech
models in use, and how fast it's been (timings only).

``GET /api/admin/talk``          settings, people talking now, speech + answer models
``PATCH /api/admin/talk``        ``{enabled?, group_ids?, live_slots?}``
``GET /api/admin/talk/usage``    ``?days=7``: medians and 90th percentiles (``metrics.py``)

Nothing here can show what anyone said: the usage numbers come from
``talk_metrics``, which has no words in it.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict
from app.auth.deps import require_admin
from app.auth.models import User
from app.config import get_settings
from app.database import get_db

from . import metrics, session as talk

router = APIRouter()

MAX_LIVE_SLOTS = 20
_HEALTH_TIMEOUT_S = 2.5


class TalkSettingsPatch(BaseModel):
    enabled: bool | None = None
    # [] or null = everyone; otherwise only members of these groups (admins always).
    group_ids: list[uuid.UUID] | None = None
    live_slots: int | None = Field(default=None, ge=1, le=MAX_LIVE_SLOTS)
    # "Read me my day": one line of weather from Open-Meteo (phase 2).
    weather: bool | None = None


async def _settings_row(db: AsyncSession):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
        await db.flush()
    return row


async def _health(client: httpx.AsyncClient, base: str | None) -> dict[str, Any] | None:
    base = (base or "").rstrip("/")
    if not base:
        return None
    try:
        r = await client.get(f"{base}/health", timeout=_HEALTH_TIMEOUT_S)
        r.raise_for_status()
        body = r.json()
        return body if isinstance(body, dict) else None
    except Exception:  # noqa: BLE001 - down or unreachable: shown as such
        return None


async def _speech() -> dict[str, Any]:
    """What the two speech services say about themselves (sizes and models,
    never anything said)."""
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        whisper, tts = await asyncio.gather(
            _health(client, settings.WHISPER_URL), _health(client, settings.TTS_URL)
        )
    live = (whisper or {}).get("live") or {}
    streams = (tts or {}).get("streams") or {}
    return {
        "listening": {
            "reachable": whisper is not None,
            "live_model": live.get("model"),
            "live_slots": live.get("slots"),
            "turn_detector": live.get("smart_turn"),
            "dictation_model": (whisper or {}).get("model"),
            "device": (whisper or {}).get("device"),
        },
        "speaking": {
            "reachable": tts is not None,
            "model": "Kokoro-82M" if tts is not None else None,
            "default_voice": (tts or {}).get("voice"),
            "threads": (tts or {}).get("threads"),
            "stream_slots": streams.get("slots"),
        },
    }


async def _answers(db: AsyncSession, row) -> dict[str, Any]:  # noqa: ANN001
    """The model spoken turns use: the admin's voice model, or each chat's own."""
    from app.mail.search import is_local
    from app.models_config.models import ModelProvider

    if not (row.voice_provider_id and row.voice_model_id):
        return {"voice_model_set": False, "provider": None, "model": None, "hosted": None}
    provider = await db.get(ModelProvider, row.voice_provider_id)
    if provider is None:
        return {"voice_model_set": False, "provider": None, "model": None, "hosted": None}
    return {
        "voice_model_set": True,
        "provider": provider.name,
        "model": row.voice_model_id,
        "hosted": not is_local(provider),
        "provider_enabled": bool(provider.enabled),
    }


async def _out(db: AsyncSession, row) -> dict[str, Any]:  # noqa: ANN001
    from app.groups.models import UserGroup

    group_ids = list(row.talk_group_ids or [])
    known: set[uuid.UUID] = set()
    if group_ids:
        known = set((await db.execute(select(UserGroup.id).where(UserGroup.id.in_(group_ids)))).scalars())
    speech = await _speech()
    return {
        "enabled": bool(row.talk_enabled),
        # Groups deleted since they were picked no longer count.
        "group_ids": [str(g) for g in group_ids if g in known],
        "live_slots": int(row.talk_live_slots or 2),
        "weather": bool(getattr(row, "weather_enabled", True)),
        "max_live_slots": MAX_LIVE_SLOTS,
        "talking_now": talk.live_count(),
        "answers": await _answers(db, row),
        "speech": speech,
    }


@router.get("")
async def get_talk(db: AsyncSession = Depends(get_db), _: User = Depends(require_admin)) -> dict[str, Any]:
    row = await _settings_row(db)
    await db.commit()
    return await _out(db, row)


@router.patch("")
async def patch_talk(
    body: TalkSettingsPatch,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> dict[str, Any]:
    from app.groups.models import UserGroup

    row = await _settings_row(db)
    fields = body.model_fields_set
    diff: dict[str, Any] = {}
    if "enabled" in fields and body.enabled is not None and body.enabled != row.talk_enabled:
        row.talk_enabled = body.enabled
        diff["talk_enabled"] = body.enabled
    if "group_ids" in fields:
        wanted = list(dict.fromkeys(body.group_ids or []))
        if wanted:
            found = set((await db.execute(select(UserGroup.id).where(UserGroup.id.in_(wanted)))).scalars())
            if missing := [g for g in wanted if g not in found]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"That group doesn't exist any more ({missing[0]}). Refresh and pick again.",
                )
        new = wanted or None
        if (list(row.talk_group_ids or []) or None) != new:
            row.talk_group_ids = new
            diff["talk_group_ids"] = [str(g) for g in wanted] or "everyone"
    if "live_slots" in fields and body.live_slots is not None and body.live_slots != row.talk_live_slots:
        row.talk_live_slots = body.live_slots
        diff["talk_live_slots"] = body.live_slots
    if "weather" in fields and body.weather is not None and body.weather != row.weather_enabled:
        row.weather_enabled = body.weather
        diff["weather_enabled"] = body.weather
    if diff:
        await record_event(
            db,
            request=request,
            event_type=EVENT_APP_SETTINGS_CHANGED,
            user_id=actor.id,
            identifier=actor.username,
            detail=safe_dict(diff),
        )
    await db.commit()
    await db.refresh(row)
    return await _out(db, row)


@router.get("/usage")
async def talk_usage(
    days: int = Query(default=7, ge=1, le=metrics.KEEP_DAYS),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> dict[str, Any]:
    return await metrics.summary(db, days=days)
