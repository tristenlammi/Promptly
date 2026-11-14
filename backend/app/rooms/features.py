"""Rooms' server-wide switches for voice messages and polls: what the admin
has turned on for everyone (Admin → Rooms; stored with the rest of Rooms'
settings, ``settings.py``). Read on each use, so a change applies at once."""
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
    # The admin's say on transcripts: None is "with this server's own
    # speech-to-text only", True allows a cloud service too, False is never.
    voice_transcripts: bool | None = None
    polls: bool = True

    def out(self) -> dict:
        """What the page needs to know (in ``/api/rooms/bootstrap``)."""
        return {"voice_messages": self.voice_messages, "voice_max_seconds": self.voice_max_seconds, "polls": self.polls}


async def load(db: AsyncSession) -> Features:
    from . import settings

    s = await settings.load(db)
    return Features(
        voice_messages=s["voice_messages"],
        voice_max_seconds=max(VOICE_MIN_S, min(VOICE_MAX_S, int(s["voice_max_seconds"]))),
        # local: the server's own speech-to-text only. cloud: that, or a
        # cloud service. off: never.
        voice_transcripts={"cloud": True, "off": False}.get(s["voice_transcripts"]),
        polls=s["polls"],
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
