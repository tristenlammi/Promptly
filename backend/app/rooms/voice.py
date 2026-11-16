"""Voice messages: a recording sent as a message.

The recording is an ordinary room attachment; the message's ``meta.voice``
says it is one (``att``, ``duration_ms``, ``peaks`` for the waveform,
``play`` once there's a copy every browser can play, and the transcript's
``state`` and words). With no words of its own, the message's body is
"\U0001F3A4 0:12", then "\U0001F3A4 0:12 \u00b7 what was said" once it's been transcribed, so
lists, notifications and search all read it.

After it's sent (:func:`after_send`): a playback copy (AAC in MP4, which
Chrome, Firefox and Safari all play; a browser's own recording is WebM/Opus
on Chrome and Android, MP4 on Safari), then the words, from the server's
speech-to-text when that's on for Rooms (``features.transcripts_on``). The
push waits a few seconds for the words, so the notification can say them.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.storage import absolute_path

from . import core, features
from .models import Room, RoomAttachment, RoomMessage

logger = logging.getLogger("promptly.rooms.voice")

MAX_BYTES = 30 * 1024 * 1024
PEAKS = 64
MAX_TRANSCRIPT = 20_000
# How much of the transcript rides in the message's body (search, previews).
BODY_WORDS = 6_000
# The push waits this long for the words before going without them.
PUSH_WAIT_S = 8.0
# A recording may run this far past the limit (the clock on the phone and
# the audio's real length never agree exactly).
SLACK_MS = 3_000
_AUDIO_EXT = (".webm", ".m4a", ".mp4", ".ogg", ".oga", ".opus", ".aac", ".mp3", ".wav")
MIC = "\U0001F3A4"


def clock(ms: int) -> str:
    s = max(0, int(round(ms / 1000)))
    return f"{s // 60}:{s % 60:02d}"


def body_for(duration_ms: int, transcript: str | None = None) -> str:
    words = " ".join((transcript or "").split())
    head = f"{MIC} {clock(duration_ms)}"
    return f"{head} \u00b7 {words[:BODY_WORDS]}" if words else head


def of(m: RoomMessage) -> dict | None:
    v = (m.meta or {}).get("voice")
    return v if isinstance(v, dict) and v.get("att") else None


def play_path(att: RoomAttachment) -> str:
    from .service import att_path

    return f"{att_path(att)}.play.m4a"


def _shrink(levels: list[Any] | None, n: int = PEAKS) -> list[float]:
    vals: list[float] = []
    for v in levels or []:
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        vals.append(0.0 if f != f else max(0.0, min(1.0, f)))  # NaN -> 0
    if not vals:
        return []
    if len(vals) > n:
        step = len(vals) / n
        vals = [max(vals[int(i * step): max(int((i + 1) * step), int(i * step) + 1)]) for i in range(n)]
    return [round(v, 2) for v in vals]


def _is_audio(att: RoomAttachment) -> bool:
    mime = (att.mime or "").split(";")[0].strip().lower()
    return mime.startswith("audio/") or mime in ("video/webm", "video/mp4") or (att.filename or "").lower().endswith(_AUDIO_EXT)


async def measure(src: Path) -> tuple[int | None, list[float] | None]:
    """(length in ms, waveform) from the audio itself; (None, None) when it
    can't be read here (no ffmpeg, or not audio)."""
    from app.notes.transcription import read_peaks

    try:
        async with asyncio.timeout(20):
            return await read_peaks(src)
    except (OSError, TimeoutError, ValueError):
        logger.info("voice: couldn't measure %s", src.name, exc_info=True)
        return None, None


async def prepare(db: AsyncSession, room: Room, user_id: uuid.UUID, att_id: uuid.UUID, duration_ms: int, peaks: list[float] | None) -> dict:
    """``meta.voice`` for a recording that was just uploaded, or 400/403.
    The length is the audio's own when the server can read it."""
    f = await features.load(db)
    if not f.voice_messages:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Voice messages are turned off on this server")
    att = await db.get(RoomAttachment, att_id)
    if att is None or att.room_id != room.id or att.uploader_id != user_id or att.message_id is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The recording is missing or already sent")
    if not _is_audio(att) or att.size > MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That isn't a voice recording")
    real_ms, real_peaks = await measure(absolute_path(_att_path(att)))
    ms = real_ms or int(duration_ms)
    limit = f.voice_max_seconds * 1000
    if ms > limit + SLACK_MS:
        mins = f.voice_max_seconds // 60
        cap = f"{mins} minute{'' if mins == 1 else 's'}" if f.voice_max_seconds % 60 == 0 and mins else f"{f.voice_max_seconds} seconds"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Voice messages can be up to {cap} long")
    if ms < 300:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nothing was recorded")
    return {
        "att": str(att.id),
        "duration_ms": min(ms, limit),
        "peaks": _shrink(real_peaks if real_peaks else peaks),
        "play": False,
        "state": "pending" if await features.transcripts_on(db, f) else "off",
    }


def _att_path(att: RoomAttachment) -> str:
    from .service import att_path

    return att_path(att)


RUN_S = 120.0


async def _run(*args: str, timeout: float = RUN_S) -> int:
    """Run one command; a recording made to keep it busy is stopped."""
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124
    return proc.returncode or 0


async def make_playback_copy(src: Path, out: Path) -> bool:
    """AAC in an MP4 that starts at once (``+faststart``), beside the
    original. Safari's own recording is already AAC: it's copied, not
    re-encoded."""
    tmp = out.with_name(out.name + ".part")
    base = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn"]
    tail = ["-movflags", "+faststart", "-f", "ipod", str(tmp)]
    try:
        for codec in (["-c:a", "copy"], ["-c:a", "aac", "-b:a", "64k", "-ac", "1"]):
            tmp.unlink(missing_ok=True)
            if await _run(*base, *codec, *tail) == 0 and tmp.is_file() and tmp.stat().st_size > 0:
                tmp.replace(out)
                return True
    except OSError:
        logger.info("voice: no playback copy for %s", src.name, exc_info=True)
    tmp.unlink(missing_ok=True)
    return False


async def transcribe(src: Path) -> str:
    """The recording's words, from the server's speech-to-text."""
    from app.notes.transcription import _transcribe
    from app.workspaces.meetings_runner import _segment_audio

    work = Path(tempfile.mkdtemp(prefix="room-voice-"))
    try:
        return (await _transcribe(await _segment_audio(src, work))).strip()
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _update(message_id: uuid.UUID, change: dict, *, transcript: str | None = None) -> bool:
    """Merge ``change`` into the message's ``meta.voice`` and tell the room.
    False when the message is gone."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        msg = await db.get(RoomMessage, message_id, with_for_update=True)
        v = of(msg) if msg is not None else None
        if msg is None or v is None or msg.deleted_at is not None:
            return False
        v = {**v, **change}
        if transcript is not None:
            v["transcript"] = transcript[:MAX_TRANSCRIPT]
            msg.body = body_for(int(v.get("duration_ms") or 0), transcript)
        msg.meta = {**msg.meta, "voice": v}
        room = await db.get(Room, msg.room_id)
        await db.commit()
        if room is not None:
            await db.refresh(msg)
            await core.publish(await core.member_ids(db, room), {"type": "message_edit", "message": await core.message_out(db, msg)})
        return True


async def process(message_id: uuid.UUID) -> str:
    """The playback copy, then the words. Returns what happened (for logs and
    tests): ``gone``, ``off``, ``done``, ``failed``."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        msg = await db.get(RoomMessage, message_id)
        v = of(msg) if msg is not None else None
        if msg is None or v is None or msg.deleted_at is not None:
            return "gone"
        att = await db.get(RoomAttachment, uuid.UUID(str(v["att"])))
        if att is None:
            return "gone"
        src = absolute_path(_att_path(att))
        out = absolute_path(play_path(att))
        wants_words = await features.transcripts_on(db)
    if not src.is_file():
        return "gone"
    if await make_playback_copy(src, out):
        if not await _update(message_id, {"play": True}):
            out.unlink(missing_ok=True)
            return "gone"
    if not wants_words:
        await _update(message_id, {"state": "off"})
        return "off"
    try:
        words = await transcribe(src)
    except Exception:  # noqa: BLE001 - the recording still plays without its words
        logger.warning("voice %s: transcription failed", message_id, exc_info=True)
        await _update(message_id, {"state": "failed"})
        return "failed"
    return "done" if await _update(message_id, {"state": "done"}, transcript=words) else "gone"


async def after_send(message_id: uuid.UUID) -> None:
    """What follows a voice message: its copy and words, and the push, which
    waits a little for the words so the notification can say them."""
    from .push import fan_out

    work = asyncio.ensure_future(process(message_id))
    try:
        await asyncio.wait({work}, timeout=PUSH_WAIT_S)
        await fan_out(message_id)
    finally:
        try:
            await work
        except Exception:  # noqa: BLE001
            logger.warning("voice %s: processing failed", message_id, exc_info=True)
