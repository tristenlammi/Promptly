"""Talk's privacy promises (WP-T6), checked end to end.

* Audio is never written anywhere: no file is opened for writing while a
  conversation runs, and neither the microphone's bytes nor the speech sent
  back turn up in any table or any log line.
* Memory capture is told which of your turns were transcribed, and to skip
  facts that look misheard; a temporary voice chat gives memory nothing.
"""
from __future__ import annotations

import base64
import builtins
import io
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from .talk_fakes import Model
from .test_talk_turns import LONG, finish, messages, open_talk, sidecars, talk_app, use_model  # noqa: F401

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC


class _Writes:
    """Every file opened for writing, by any of the usual ways in."""

    def __init__(self, monkeypatch) -> None:
        self.paths: list[str] = []
        real_open, real_os_open = builtins.open, os.open
        real_mkstemp, real_named, real_temp, real_spooled = (
            tempfile.mkstemp,
            tempfile.NamedTemporaryFile,
            tempfile.TemporaryFile,
            tempfile.SpooledTemporaryFile,
        )

        def opened(file, mode="r", *a, **kw):  # noqa: ANN001
            if any(c in str(mode) for c in "wax+"):
                self.paths.append(str(file))
            return real_open(file, mode, *a, **kw)

        def os_opened(path, flags, *a, **kw):  # noqa: ANN001
            if flags & _WRITE_FLAGS:
                self.paths.append(str(path))
            return real_os_open(path, flags, *a, **kw)

        def temp(kind, real):  # noqa: ANN001
            def made(*a, **kw):  # noqa: ANN001
                self.paths.append(f"<{kind}>")
                return real(*a, **kw)

            return made

        monkeypatch.setattr(builtins, "open", opened)
        monkeypatch.setattr(io, "open", opened)
        monkeypatch.setattr(os, "open", os_opened)
        monkeypatch.setattr(tempfile, "mkstemp", temp("mkstemp", real_mkstemp))
        monkeypatch.setattr(tempfile, "NamedTemporaryFile", temp("NamedTemporaryFile", real_named))
        monkeypatch.setattr(tempfile, "TemporaryFile", temp("TemporaryFile", real_temp))
        monkeypatch.setattr(tempfile, "SpooledTemporaryFile", temp("SpooledTemporaryFile", real_spooled))

    def outside_python_caches(self) -> list[str]:
        return [p for p in self.paths if "__pycache__" not in p and not p.endswith(".pyc")]


def _forms(chunk: bytes) -> list[str]:
    """How a piece of audio could show up as text: hex (as Postgres prints
    bytea), base64, or Python's repr."""
    return [chunk.hex(), "\\x" + chunk.hex(), base64.b64encode(chunk).decode(), repr(chunk)[2:-1][:48]]


async def _every_row_as_text(db) -> str:
    """The whole test database, row by row, as Postgres prints it."""
    tables = (
        await db.execute(
            text("SELECT quote_ident(table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
        )
    ).scalars().all()
    out: list[str] = []
    for table in tables:
        rows = (await db.execute(text(f"SELECT t::text FROM {table} t"))).scalars().all()  # noqa: S608 - names from the catalogue
        out.extend(rows)
    return "\n".join(out)


async def test_audio_is_never_written_anywhere(db, user, conversation, sidecars, talk_app, monkeypatch, caplog):  # noqa: F811
    # 20 ms of "microphone" nobody could mistake for anything else.
    mic = bytes((i * 37 + 11) % 256 for i in range(640))
    use_model(monkeypatch, Model([LONG, "Friday's clear."]))
    caplog.set_level(logging.DEBUG)
    writes = _Writes(monkeypatch)

    c = await open_talk(talk_app, user, conversation)
    live = await sidecars.live()
    for _ in range(25):
        await c.mic(mic)
    await live.say(1, "What's on today?")
    await c.until_audio()
    await c.drain(0.6)
    for _ in range(10):
        await c.mic(mic)  # talking over it
    await live.emit({"type": "speech_start", "turn": 2, "at_ms": 5000})
    await live.emit({"type": "partial", "turn": 2, "text": "Wait, what about", "stable": ""})
    await c.expect("stop_audio", timeout=3)
    await live.emit({"type": "turn_end", "turn": 2, "reason": "complete", "speech_end_ms": 6000, "at_ms": 6280})
    await live.emit({"type": "final", "turn": 2, "text": "Wait, what about Friday?"})
    await c.find("reply", done=True)
    await c.expect("state", state="listening", timeout=15)
    await finish(c)
    monkeypatch.undo()  # file access back to normal before reading anything

    # The microphone did reach Whisper, and speech did come back...
    assert mic in bytes(live.audio)
    spoken = [frame[4:] for frame in c.audio if len(frame) > 4]
    assert spoken, "no speech came back"
    # ...but no file was opened for writing while it all happened.
    assert writes.outside_python_caches() == []

    # Not in any table, in any form.
    everything = await _every_row_as_text(db)
    assert "What's on today?" in everything  # the transcript is a chat message, as it should be
    for chunk in (mic[:64], spoken[0][:64], spoken[len(spoken) // 2][:64]):
        for form in _forms(chunk):
            assert form not in everything, "audio found in the database"

    # Not in the logs either (sizes and timings only).
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "talk: session open" in logged
    for chunk in (mic[:32], spoken[0][:32]):
        for form in _forms(chunk):
            assert form not in logged, "audio found in the logs"


# ---- memory capture and transcribed turns


def _says(monkeypatch, answer: str = "[]"):
    """The memory model answers ``answer``; we keep what it was told."""
    from app.memory import service

    asked: list[dict] = []

    async def stream(**kwargs):
        asked.append({"system": kwargs.get("system") or "", "payload": kwargs["messages"][0].content})
        yield answer

    monkeypatch.setattr(service.model_router, "stream_chat", stream)
    return asked


async def _spoken_chat(db, user, provider, **fields):
    from app.chat.models import Conversation, Message

    chat = Conversation(user_id=user.id, title="Talk", model_id="test-model", provider_id=provider.id, **fields)
    db.add(chat)
    await db.flush()
    start = datetime.now(timezone.utc) - timedelta(hours=1)
    rows = [
        ("user", "My sister Shona is visiting on the ninth", {"spoken": True, "interrupted": False, "stt_ms": 610}),
        ("assistant", "Lovely, I'll keep that in mind.", {"spoken": True, "interrupted": False}),
        ("user", "I typed this: I'm vegetarian", None),
        ("assistant", "Noted.", None),
    ]
    for n, (role, content, voice) in enumerate(rows):
        db.add(Message(conversation_id=chat.id, role=role, content=content, voice=voice, created_at=start + timedelta(minutes=n)))
    await db.commit()
    return chat


async def test_capture_is_told_which_turns_were_transcribed(db, provider, monkeypatch):
    from app.memory.capture import capture_conversation, transcript
    from app.chat.models import Message

    from .test_mail import mk_user

    user = await mk_user(db, "speaker")
    asked = _says(monkeypatch)
    chat = await _spoken_chat(db, user, provider)

    rows = (await db.execute(select(Message).where(Message.conversation_id == chat.id).order_by(Message.created_at))).scalars().all()
    said, covered = transcript(list(rows))
    assert covered == 4
    lines = said.split("\n\n")
    assert lines[0].endswith("User (spoken): My sister Shona is visiting on the ninth")
    assert lines[2].endswith("User: I typed this: I'm vegetarian")  # typed turns aren't marked
    assert lines[1] == "Assistant: Lovely, I'll keep that in mind."

    await capture_conversation(db, chat, user)
    assert len(asked) == 1
    assert "User (spoken): My sister Shona" in asked[0]["payload"]
    rules = asked[0]["system"]
    assert "'User (spoken)'" in rules and "misheard" in rules and "Skip a fact" in rules


async def test_a_temporary_voice_chat_gives_memory_nothing(db, provider, monkeypatch):
    from app.memory.capture import capture_conversation

    from .test_mail import mk_user

    user = await mk_user(db, "brief")
    asked = _says(monkeypatch, '[{"op": "add", "text": "User\'s sister is Shona", "category": "context", "confidence": "high"}]')
    chat = await _spoken_chat(db, user, provider, temporary_mode="one_hour", expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
    assert await capture_conversation(db, chat, user) == []
    assert asked == []


@pytest.mark.parametrize("voice", [None, {}, {"spoken": False}])
async def test_only_a_spoken_mark_counts(voice):
    from app.chat.models import Message
    from app.memory.capture import transcript

    m = Message(role="user", content="Hello", voice=voice, created_at=datetime.now(timezone.utc))
    assert "User (spoken)" not in transcript([m])[0]
