"""Who may talk, with what voice, and the per-turn timings (WP-T2)."""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select

from app.auth.models import User

logger = logging.getLogger("promptly.talk")

TALK_OFF = "Talk is turned off on this server."
NOT_FOR_YOU = "Talk isn't turned on for your account."
SPEEDS = (0.9, 1.3)


@dataclass
class ServerTalk:
    enabled: bool = True
    group_ids: list[uuid.UUID] | None = None
    live_slots: int = 2
    voice_model_set: bool = False


async def server_talk(db) -> ServerTalk:  # noqa: ANN001
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        return ServerTalk()
    return ServerTalk(
        enabled=bool(row.talk_enabled),
        group_ids=list(row.talk_group_ids) if row.talk_group_ids else None,
        live_slots=max(1, int(row.talk_live_slots or 2)),
        voice_model_set=bool(row.voice_provider_id and row.voice_model_id),
    )


async def refusal(db, user: User, server: ServerTalk) -> str | None:  # noqa: ANN001
    """Why ``user`` can't talk, or None."""
    if not server.enabled:
        return TALK_OFF
    if server.group_ids and user.role != "admin":
        from app.groups.models import UserGroupMember

        member = await db.scalar(
            select(UserGroupMember.user_id).where(
                UserGroupMember.user_id == user.id,
                UserGroupMember.group_id.in_(server.group_ids),
            ).limit(1)
        )
        if member is None:
            return NOT_FOR_YOU
    return None


@dataclass
class VoicePrefs:
    voice: str | None
    speed: float
    save: str  # "chat" | "temporary"
    turn_mode: str  # "hands_free" | "tap"
    interrupt: str  # "talk" | "tap"
    captions: bool


def voice_prefs(user: User) -> VoicePrefs:
    """Account -> Voice, from ``users.settings`` (no columns of its own)."""
    s = user.settings or {}
    try:
        speed = float(s.get("tts_speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    return VoicePrefs(
        voice=(s.get("tts_voice") or None),
        speed=min(SPEEDS[1], max(SPEEDS[0], speed)),
        save="temporary" if s.get("talk_save") == "temporary" else "chat",
        turn_mode="tap" if s.get("talk_turn_mode") == "tap" else "hands_free",
        interrupt="tap" if s.get("talk_interrupt") == "tap" else "talk",
        captions=s.get("talk_captions") is not False,
    )


async def record_turn(
    *,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    session_id: uuid.UUID,
    device: str,
    endpoint_ms: int | None,
    stt_ms: int | None,
    ttft_ms: int | None,
    first_audio_ms: int | None,
    barge_ins: int,
    fast_path: bool = False,
    tool_ms: int | None = None,
    transport: str = "ws",
) -> None:
    """One answered turn's timings. Never fails the conversation."""
    from app.database import SessionLocal

    from .models import TalkMetric

    def _ms(v: int | None) -> int | None:
        return None if v is None else max(0, min(int(v), 600_000))

    try:
        async with SessionLocal() as db:
            db.add(
                TalkMetric(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    session_id=session_id,
                    device=device,
                    transport=transport,
                    endpoint_ms=_ms(endpoint_ms),
                    stt_ms=_ms(stt_ms),
                    ttft_ms=_ms(ttft_ms),
                    first_audio_ms=_ms(first_audio_ms),
                    tool_ms=_ms(tool_ms),
                    barge_ins=barge_ins,
                    fast_path=fast_path,
                )
            )
            await db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("talk: couldn't record a turn's timings")
