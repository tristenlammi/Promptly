"""Meeting-notes job execution (S-tier 4.4).

Runs on the Arq worker (durable — an API redeploy can't kill an hour of
transcription). One job = one uploaded recording, processed in stages,
each committed to the ``meeting_jobs`` row so the UI can poll real
progress:

1. **Probe + chunk.** ffmpeg normalises any input the browser can hand us
   (webm/opus, m4a, mp3, wav, even a video file — the audio track is
   extracted) into 16 kHz mono Opus segments of ``_CHUNK_SECONDS``. That's
   exactly what Whisper resamples to internally, so the transcode is
   lossless for STT while shrinking a 10-minute chunk to ~2 MB — far under
   the Whisper worker's 25 MB clip cap.
2. **Transcribe.** Chunks go to the configured STT backend sequentially
   (the CPU Whisper worker is single-model; parallel chunks would just
   queue there anyway). Progress commits after every chunk. Each chunk
   gets a ``[h:mm:ss]`` anchor so the transcript stays navigable.
3. **Summarise.** One model call (the workspace's default chat model,
   falling back to its memory model) turns the transcript into structured
   minutes: summary, decisions, action items, open questions.
4. **Seed the note.** The shared ``create_note_with_item`` recipe, with the
   full transcript appended in a trailing section so it's searchable and
   RAG-visible. The uploader gets an inbox/push notification either way.

The transcript is persisted the moment stage 2 finishes: a summarise-stage
failure keeps the expensive part and stamps a clear error instead.
"""
from __future__ import annotations

import asyncio
import logging
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal

logger = logging.getLogger("promptly.workspaces.meetings")

# 10-minute chunks: big enough that per-chunk Whisper warmup is amortised,
# small enough for real progress feedback and per-chunk retry on failure.
_CHUNK_SECONDS = 600
# Per-chunk STT ceiling. A 10-minute chunk on a CPU-only base model runs
# ~1-2 minutes; 15 minutes of headroom covers a loaded homelab box.
_CHUNK_STT_TIMEOUT_S = 900
_CHUNK_RETRIES = 2
# Ceiling on the transcript text handed to the summarising model — beyond
# this we truncate the tail and say so (a ~3h meeting fits comfortably).
_SUMMARY_INPUT_CHAR_CAP = 160_000

_SUMMARY_SYSTEM_PROMPT = """You turn a raw meeting transcript into crisp, useful meeting notes.

Write in Markdown, in the same language as the transcript. Start with a single H1 line: a concise, specific meeting title (infer it from the content). Then produce exactly these sections, omitting any that would be empty:

## Summary
3-6 sentences: what the meeting was about and where it landed.

## Key points
Bullet list of the substantive discussion points (not chit-chat).

## Decisions
Bullet list of decisions actually made. Only things clearly agreed — don't promote suggestions to decisions.

## Action items
Markdown checkboxes, one per item: `- [ ] Task — owner (deadline)`. Include the owner and deadline only when the transcript names them.

## Open questions
Bullets for anything raised but left unresolved.

Ground every line in the transcript — never invent names, numbers, dates, or commitments. Use the [h:mm:ss] anchors to keep chronology straight, but don't cite them in your output."""


class MeetingError(Exception):
    """A stage failed in a way worth showing to the user verbatim."""


async def _run_cmd(*args: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode or 0, out, err


async def _probe_duration(path: Path) -> int | None:
    """Container duration in whole seconds, or None if ffprobe can't tell."""
    code, out, _err = await _run_cmd(
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    )
    if code != 0:
        return None
    try:
        return max(1, int(float(out.decode().strip())))
    except (ValueError, AttributeError):
        return None


async def _segment_audio(src: Path, out_dir: Path) -> list[Path]:
    """Transcode + split ``src`` into 16 kHz mono Opus chunks."""
    pattern = str(out_dir / "chunk_%04d.ogg")
    code, _out, err = await _run_cmd(
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i", str(src),
        "-vn",              # drop any video track — we only want the audio
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "libopus",
        "-b:a", "24k",
        "-f", "segment",
        "-segment_time", str(_CHUNK_SECONDS),
        pattern,
    )
    if code != 0:
        detail = err.decode(errors="replace").strip().splitlines()
        raise MeetingError(
            "Couldn't read the recording — it may be corrupt or in an "
            f"unsupported format. ({detail[-1][:150] if detail else 'ffmpeg failed'})"
        )
    chunks = sorted(out_dir.glob("chunk_*.ogg"))
    if not chunks:
        raise MeetingError("The recording contains no audio.")
    return chunks


def _anchor(seconds: int) -> str:
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"[{h}:{m:02d}:{s:02d}]"


async def _transcribe_chunks(
    db: AsyncSession, job, chunks: list[Path]
) -> str:
    from app.voice.service import TranscriptionError, transcribe_audio

    parts: list[str] = []
    for i, chunk in enumerate(chunks):
        data = chunk.read_bytes()
        last_exc: Exception | None = None
        for attempt in range(_CHUNK_RETRIES + 1):
            try:
                result = await transcribe_audio(
                    data=data,
                    filename=chunk.name,
                    content_type="audio/ogg",
                    language=job.language,
                    timeout_s=_CHUNK_STT_TIMEOUT_S,
                )
                break
            except TranscriptionError as exc:
                last_exc = exc
                # Transient 503s (model still loading) deserve a pause+retry;
                # anything else retries immediately once.
                if attempt < _CHUNK_RETRIES:
                    await asyncio.sleep(10 if exc.status_code == 503 else 2)
        else:
            raise MeetingError(
                f"Transcription failed on part {i + 1} of {len(chunks)}: "
                f"{last_exc}"
            )
        text = (result.text or "").strip()
        if text:
            parts.append(f"{_anchor(i * _CHUNK_SECONDS)} {text}")
        job.progress_done = i + 1
        await db.commit()
    if not parts:
        raise MeetingError(
            "No speech was detected in the recording — nothing to summarise."
        )
    return "\n\n".join(parts)


async def _summarise(db: AsyncSession, ws, transcript: str) -> str:
    """One model call: transcript → structured minutes (Markdown)."""
    from app.models_config.models import ModelProvider
    from app.models_config.provider import ChatMessage, model_router

    provider_id = ws.default_provider_id or ws.memory_provider_id
    model_id = ws.default_model_id or ws.memory_model_id
    if not provider_id or not model_id:
        raise MeetingError(
            "This workspace has no default chat model — set one in the "
            "workspace settings, then try again."
        )
    provider = await db.get(ModelProvider, provider_id)
    if provider is None or not provider.enabled:
        raise MeetingError(
            "The workspace's default model provider is unavailable."
        )

    body = transcript
    if len(body) > _SUMMARY_INPUT_CHAR_CAP:
        body = (
            body[:_SUMMARY_INPUT_CHAR_CAP]
            + "\n\n[Transcript truncated for summarisation — the full text "
            "is preserved in the note.]"
        )
    chunks: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[
                ChatMessage(
                    role="user",
                    content="Here is the meeting transcript:\n\n" + body,
                )
            ],
            system=_SUMMARY_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=3000,
        ):
            chunks.append(token)
    except Exception as exc:  # noqa: BLE001 — ProviderError et al.
        raise MeetingError(
            f"The summarising model failed to respond: {str(exc)[:200]}"
        ) from exc
    notes = "".join(chunks).strip()
    if not notes:
        raise MeetingError("The summarising model returned an empty result.")
    return notes


def _split_title(notes_md: str, fallback: str) -> tuple[str, str]:
    """Pull the model's leading ``# Title`` out of the notes body."""
    lines = notes_md.splitlines()
    for idx, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("# ") and not line.startswith("## "):
            title = line[2:].strip() or fallback
            return title[:200], "\n".join(lines[idx + 1 :]).strip()
        break
    return fallback[:200], notes_md


async def execute_meeting(job_id: uuid.UUID) -> None:
    """Run one meeting job to a terminal state. Owns its session; never
    raises — every failure lands on the job row (and a notification)."""
    from app.workspaces.meetings_models import MeetingJob

    async with SessionLocal() as db:
        job = await db.get(MeetingJob, job_id)
        if job is None or job.status not in ("pending",):
            return  # gone, or an Arq redelivery of an already-running job
        try:
            await _execute(db, job)
        except MeetingError as exc:
            await _fail(db, job, str(exc))
        except Exception:  # noqa: BLE001 — belt and braces
            logger.exception("meeting job %s crashed", job_id)
            await _fail(db, job, "Something went wrong while processing the recording.")


async def _execute(db: AsyncSession, job) -> None:
    from app.auth.models import User
    from app.chat.models import Workspace
    from app.files.storage import absolute_path, delete_blob
    from app.notifications.dispatch import notify_user
    from app.workspaces.content_seed import create_note_with_item
    from app.workspaces.knowledge import index_note_for_workspace

    ws = await db.get(Workspace, job.workspace_id)
    if ws is None:
        raise MeetingError("The workspace no longer exists.")
    if not job.audio_path:
        raise MeetingError("The uploaded recording is gone.")
    try:
        src = absolute_path(job.audio_path)
    except ValueError as exc:
        raise MeetingError("The uploaded recording is gone.") from exc
    if not src.exists():
        raise MeetingError("The uploaded recording is gone.")

    # ---- Stage 1+2: chunk + transcribe -------------------------------
    job.status = "transcribing"
    job.duration_s = await _probe_duration(src)
    await db.commit()

    with tempfile.TemporaryDirectory(prefix="meeting_") as tmp:
        chunks = await _segment_audio(src, Path(tmp))
        job.progress_total = len(chunks)
        await db.commit()
        transcript = await _transcribe_chunks(db, job, chunks)

    job.transcript = transcript
    job.status = "summarising"
    await db.commit()

    # ---- Stage 3: summarise ------------------------------------------
    notes_md = await _summarise(db, ws, transcript)

    # ---- Stage 4: seed the note --------------------------------------
    date_label = datetime.now(timezone.utc).strftime("%d %b %Y")
    fallback_title = (job.title or "").strip() or f"Meeting notes — {date_label}"
    inferred_title, body = _split_title(notes_md, fallback_title)
    # A user-supplied title wins; the model's inferred one fills the gap.
    title = (job.title or "").strip()[:200] or inferred_title

    markdown = body + "\n\n---\n\n## Transcript\n\n" + transcript

    owner = await db.get(User, ws.user_id)
    if owner is None:
        raise MeetingError("The workspace owner no longer exists.")
    item = await create_note_with_item(
        db,
        ws=ws,
        owner=owner,
        creator_id=job.user_id,
        title=title,
        markdown=markdown,
    )
    job.note_item_id = item.id
    job.status = "done"
    job.error = None
    audio_rel = job.audio_path
    job.audio_path = None  # transient input — clear before the blob goes
    await db.commit()
    if audio_rel:
        delete_blob(audio_rel)

    try:
        await index_note_for_workspace(ws.id, item.id)
    except Exception:  # noqa: BLE001 — indexing must never fail the job
        logger.warning("meeting note index failed", exc_info=True)

    await notify_user(
        user_id=job.user_id,
        category="task_complete",
        title="Meeting notes are ready",
        body=f"“{title}” has been transcribed and summarised.",
        url=f"/workspaces/{ws.id}?item={item.id}",
        tag=f"promptly-meeting-{job.id}",
        workspace_id=ws.id,
    )


async def _fail(db: AsyncSession, job, message: str) -> None:
    from app.files.storage import delete_blob
    from app.notifications.dispatch import notify_user

    await db.rollback()  # the failed stage may have left the session dirty
    # The rollback expired the instance — reload explicitly (attribute
    # access on an expired object would need a lazy load, which the async
    # session forbids outside await).
    await db.refresh(job)
    job.status = "failed"
    job.error = message[:500]
    audio_rel = job.audio_path
    job.audio_path = None
    await db.commit()
    if audio_rel:
        delete_blob(audio_rel)
    await notify_user(
        user_id=job.user_id,
        category="task_complete",
        title="Meeting notes failed",
        body=message[:180],
        url=f"/workspaces/{job.workspace_id}",
        tag=f"promptly-meeting-{job.id}",
        workspace_id=job.workspace_id,
    )


__all__ = ["execute_meeting"]
