"""Voice notes: what the server does with a recording once it's in a note.

``transcribe_note_audio_job`` (the arq worker, ``app/tasks/worker.py``) runs
three steps, each saved as it finishes, so a slow transcription never holds
up the rest:

1. **A playback copy.** A browser's recording (MediaRecorder's WebM, or
   Safari's fragmented MP4) has no duration or seek index, so players
   can't seek it. ffmpeg copies the stream into a proper file
   (``derived/<file_id>/note-play.<ext>``, never counted against storage).
   The original stays byte-exact.
2. **Length and waveform.** ffmpeg decodes the audio at 1 kHz and keeps the
   loudest sample of each slice: ``duration_ms`` and up to 200 ``peaks``
   (0–1), which the player draws.
3. **Words.** When transcription is on (:func:`config`), the meeting-notes
   recipe (``workspaces/meetings_runner.py``): 16 kHz mono Opus in
   10-minute chunks, each sent to ``voice/service.py::transcribe_audio`` in
   the batch lane (dictation and voice mode never wait behind it). The
   transcript goes under the recording — it never replaces the note's
   text — into the note's search text, and into the audio file's
   ``content_text`` (Drive search finds it too).

Transcription follows Mail's AI-search precedent: **on** when the server
transcribes with its own Whisper (``STT_BACKEND=local``), **off** when that
would send people's recordings to a cloud service, until the admin turns
it on (``app_settings.notes_transcribe``).
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings

logger = logging.getLogger("promptly.notes.transcription")

PEAKS = 200
# Samples per second the waveform is read at, and per slice before it's
# shrunk to PEAKS (0.1 s).
_PEAK_RATE = 1000
_SLICE = 100
PLAY_NAME = {"webm": "note-play.webm", "mp4": "note-play.m4a"}
MAX_TRANSCRIPT = 400_000
# Two recordings at a time per worker: long ones mustn't fill every slot.
_SLOTS = asyncio.Semaphore(2)


# ------------------------------------------------------------------ the switch


@dataclass(frozen=True)
class Config:
    on: bool
    # "local" (the server's own Whisper) or "openai" (cloud).
    backend: str
    # The admin's choice: None (the default for this backend), True, False.
    choice: bool | None
    # Set up at all (a Whisper address, or a cloud key).
    ready: bool


def _backend() -> str:
    b = (get_settings().STT_BACKEND or "local").strip().lower()
    return "openai" if b == "openai" else "local"


async def config(db: AsyncSession) -> Config:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    s = get_settings()
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    choice = getattr(row, "notes_transcribe", None) if row is not None else None
    backend = _backend()
    if backend == "local":
        ready = bool((s.WHISPER_URL or "").strip())
        on = ready and choice is not False
    else:
        ready = bool((s.OPENAI_API_KEY or "").strip())
        on = ready and choice is True
    return Config(on=on, backend=backend, choice=choice, ready=ready)


async def set_choice(db: AsyncSession, on: bool) -> Config:
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is not None:
        row.notes_transcribe = on
        await db.commit()
    return await config(db)


# ------------------------------------------------------------------ the queue


async def enqueue(attachment_id: uuid.UUID) -> None:
    """On the worker; if the queue is down, here (so a recording is never
    left waiting for good)."""
    from app.tasks.queue import NOTE_AUDIO, _get_pool

    try:
        pool = await _get_pool()
        await pool.enqueue_job(NOTE_AUDIO, str(attachment_id), _job_id=f"note-audio-{attachment_id}-{uuid.uuid4().hex[:8]}")
        return
    except Exception:  # noqa: BLE001 — never let queueing break the request
        logger.warning("note audio: queue unavailable, running here", exc_info=True)
    from app.background import spawn

    spawn(process(attachment_id), name=f"note_audio_{attachment_id}")


# ------------------------------------------------------------------ ffmpeg


async def _run(*args: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode or 0, out, err


def _container(mime: str, filename: str) -> str | None:
    m = (mime or "").lower()
    name = (filename or "").lower()
    if m in ("audio/webm", "video/webm") or name.endswith(".webm"):
        return "webm"
    if m in ("audio/mp4", "audio/x-m4a", "audio/m4a", "video/mp4") or name.endswith((".m4a", ".mp4")):
        return "mp4"
    return None


async def make_playback_copy(src: Path, file_id: uuid.UUID, mime: str, filename: str) -> str | None:
    """A seekable copy of a browser recording (stream copy, no re-encode).
    Returns its file name under ``derived/<file_id>/``, or None."""
    from app.files.derivatives import derived_dir

    kind = _container(mime, filename)
    if kind is None:
        return None
    name = PLAY_NAME[kind]
    out_dir = derived_dir(file_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / f".{name}.part"
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(src), "-vn", "-c:a", "copy"]
    args += ["-f", "webm"] if kind == "webm" else ["-movflags", "+faststart", "-f", "ipod"]
    code, _out, err = await _run(*args, str(tmp))
    if code != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        logger.info("note audio: no playback copy (%s)", err.decode(errors="replace").strip().splitlines()[-1:] or "ffmpeg failed")
        return None
    tmp.replace(out_dir / name)
    return name


async def read_peaks(src: Path) -> tuple[int | None, list[float] | None]:
    """(duration in ms, ≤200 levels 0–1) from the decoded audio."""
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-i", str(src), "-vn", "-ac", "1",
        "-ar", str(_PEAK_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    assert proc.stdout is not None
    slices: list[int] = []
    count = 0
    cur = 0
    n_in_slice = 0
    leftover = b""
    while True:
        chunk = await proc.stdout.read(64 * 1024)
        if not chunk:
            break
        data = leftover + chunk
        usable = len(data) - (len(data) % 2)
        leftover = data[usable:]
        mv = memoryview(data[:usable]).cast("h")
        for v in mv:
            a = -v if v < 0 else v
            if a > cur:
                cur = a
            n_in_slice += 1
            if n_in_slice == _SLICE:
                slices.append(cur)
                cur = 0
                n_in_slice = 0
        count += len(mv)
    if n_in_slice:
        slices.append(cur)
    await proc.wait()
    if not count:
        return None, None
    duration_ms = int(count * 1000 / _PEAK_RATE)
    return duration_ms, shrink(slices)


def shrink(levels: list[int] | list[float], n: int = PEAKS) -> list[float]:
    """``levels`` as at most ``n`` values from 0 to 1 (the loudest of each
    group; scaled so the loudest is 1, gently, so quiet speech still shows)."""
    if not levels:
        return []
    if len(levels) > n:
        step = len(levels) / n
        levels = [max(levels[int(i * step): max(int((i + 1) * step), int(i * step) + 1)]) for i in range(n)]
    top = max(levels) or 1
    return [round(min(1.0, (float(v) / top) ** 0.7), 3) for v in levels]


# ------------------------------------------------------------------ the job


async def _publish(db: AsyncSession, note) -> None:  # noqa: ANN001
    from . import access, events

    await events.publish(await access.participants(db, note), events.note_event(note))


async def _touch(db: AsyncSession, note_id: uuid.UUID) -> None:
    """The note moved (its recording got a waveform or words): everyone on
    it refetches. Not an edit, so nobody's "changed by" mark moves."""
    from .models import Note

    note = await db.get(Note, note_id, with_for_update=True)
    if note is None:
        return
    note.change_seq += 1
    await db.commit()
    await _publish(db, note)


async def _transcribe(chunks: list[Path]) -> str:
    from app.voice.service import TranscriptionError, transcribe_audio
    from app.workspaces.meetings_runner import _CHUNK_RETRIES, _CHUNK_SECONDS, _CHUNK_STT_TIMEOUT_S, _anchor

    parts: list[str] = []
    for i, chunk in enumerate(chunks):
        data = await asyncio.to_thread(chunk.read_bytes)
        last: Exception | None = None
        for attempt in range(_CHUNK_RETRIES + 1):
            try:
                result = await transcribe_audio(
                    data=data, filename=chunk.name, content_type="audio/ogg", timeout_s=_CHUNK_STT_TIMEOUT_S, batch=True,
                )
                break
            except TranscriptionError as exc:
                last = exc
                if attempt < _CHUNK_RETRIES:
                    await asyncio.sleep(10 if exc.status_code == 503 else 2)
        else:
            raise RuntimeError(str(last) if last else "transcription failed")
        text = (result.text or "").strip()
        if text:
            # A long recording gets a time mark per 10 minutes; a short one is just its words.
            parts.append(f"{_anchor(i * _CHUNK_SECONDS)} {text}" if len(chunks) > 1 else text)
    return "\n\n".join(parts)[:MAX_TRANSCRIPT]


async def process(attachment_id: uuid.UUID, *, transcribe: bool = True) -> str:
    """The whole job for one recording. Returns what happened (for logs and
    tests): ``gone``, ``done``, ``off``, ``failed``."""
    from app.database import SessionLocal

    async with _SLOTS:
        async with SessionLocal() as db:
            return await _process(db, attachment_id, transcribe=transcribe)


async def _process(db: AsyncSession, attachment_id: uuid.UUID, *, transcribe: bool) -> str:
    from app.files import storage
    from app.files.models import UserFile
    from app.workspaces.meetings_runner import _segment_audio

    from . import service
    from .models import NoteAttachment

    att = await db.get(NoteAttachment, attachment_id)
    if att is None or att.kind != "audio" or att.file_id is None:
        return "gone"
    file = await db.get(UserFile, att.file_id)
    if file is None or not file.storage_path:
        return "gone"
    src = storage.absolute_path(file.storage_path)
    if not src.is_file():
        return "gone"
    note_id, file_id = att.note_id, file.id

    # 1–2: playback copy, length and waveform (cheap; saved straight away).
    try:
        await make_playback_copy(src, file_id, file.mime_type, file.filename)
    except Exception:  # noqa: BLE001 — playback falls back to the original
        logger.warning("note audio %s: playback copy failed", attachment_id, exc_info=True)
    try:
        duration_ms, peaks = await read_peaks(src)
    except Exception:  # noqa: BLE001
        logger.warning("note audio %s: waveform failed", attachment_id, exc_info=True)
        duration_ms, peaks = None, None
    att = await db.get(NoteAttachment, attachment_id, with_for_update=True)
    if att is None:
        await db.rollback()
        return "gone"
    if duration_ms:
        att.duration_ms = duration_ms
    if peaks:
        att.peaks = peaks
    if att.transcript_state == "done" and att.transcript:
        # Its words came with it (an imported export): only the waveform was needed.
        await db.commit()
        await _touch(db, note_id)
        return "done"
    cfg = await config(db)
    if not transcribe or not cfg.on:
        if att.transcript_state in (None, "pending", "working"):
            att.transcript_state = "off"
        await db.commit()
        await _touch(db, note_id)
        return "off"
    att.transcript_state = "working"
    await db.commit()
    await _touch(db, note_id)

    # 3: the words.
    work = Path(tempfile.mkdtemp(prefix="note-audio-"))
    try:
        try:
            chunks = await _segment_audio(src, work)
            transcript = await _transcribe(chunks)
        except Exception as exc:  # noqa: BLE001 — the note says "Couldn't transcribe — Try again"
            logger.warning("note audio %s: transcription failed: %s", attachment_id, exc)
            att = await db.get(NoteAttachment, attachment_id, with_for_update=True)
            if att is None:
                await db.rollback()
                return "gone"
            att.transcript_state = "failed"
            await db.commit()
            await _touch(db, note_id)
            return "failed"
    finally:
        shutil.rmtree(work, ignore_errors=True)

    att = await db.get(NoteAttachment, attachment_id, with_for_update=True)
    if att is None:
        await db.rollback()
        return "gone"
    att.transcript = transcript
    att.transcript_state = "done"
    att.transcribed_at = datetime.now(timezone.utc)
    file = await db.get(UserFile, file_id)
    if file is not None:
        # Drive search finds the recording by its words too.
        file.content_text = transcript or None
    await db.flush()
    from .models import Note

    note = await db.get(Note, note_id, with_for_update=True)
    if note is not None:
        await service.refresh_search_text(db, note)
        note.change_seq += 1
    await db.commit()
    if note is not None:
        await _publish(db, note)
    return "done"


__all__ = ["Config", "PEAKS", "PLAY_NAME", "config", "enqueue", "make_playback_copy", "process", "read_peaks", "set_choice", "shrink"]
