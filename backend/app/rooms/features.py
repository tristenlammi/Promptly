"""Rooms' server-wide switches (``app_settings.rooms_*``): what the admin
has turned on for everyone. Read on each use, so a change applies at once."""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

VOICE_MIN_S = 10
VOICE_MAX_S = 3600
VOICE_DEFAULT_S = 600


@dataclass(frozen=True)
class Features:
    voice_messages: bool = True
    voice_max_seconds: int = VOICE_DEFAULT_S
    # The admin's say on transcripts: None follows the server's default
    # (``app.notes.transcription.config``).
    voice_transcripts: bool | None = None
    polls: bool = True

    def out(self) -> dict:
        """What the page needs to know (in ``/api/rooms/bootstrap``)."""
        return {"voice_messages": self.voice_messages, "voice_max_seconds": self.voice_max_seconds, "polls": self.polls}


async def load(db: AsyncSession) -> Features:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        return Features()
    try:
        secs = int(getattr(row, "rooms_voice_max_seconds", None) or VOICE_DEFAULT_S)
    except (TypeError, ValueError):
        secs = VOICE_DEFAULT_S
    return Features(
        voice_messages=getattr(row, "rooms_voice_messages", True) is not False,
        voice_max_seconds=max(VOICE_MIN_S, min(VOICE_MAX_S, secs)),
        voice_transcripts=getattr(row, "rooms_voice_transcripts", None),
        polls=getattr(row, "rooms_polls", True) is not False,
    )


async def transcripts_on(db: AsyncSession, f: Features | None = None) -> bool:
    """Are voice messages transcribed? Never unless speech-to-text is set up;
    with the server's own Whisper, yes unless the admin said no; with cloud
    speech-to-text (recordings would leave the server), only if the admin
    said yes."""
    from app.notes.transcription import config

    f = f or await load(db)
    cfg = await config(db)
    if not cfg.ready or f.voice_transcripts is False:
        return False
    if cfg.backend == "local":
        return True
    return f.voice_transcripts is True
