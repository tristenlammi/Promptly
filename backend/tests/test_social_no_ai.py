"""Rooms and Porch are never read or indexed by AI (owner rule, 2026-11-15).

"The social media apps (Porch and Rooms) should never be indexed etc. The
only AI that exists there is saying @promptly to ask AI a question. It cannot
see the chat history or anything."

This file holds that by construction, the way the photos leakage matrix
does: it reads the code, so a new path fails here before it ships.

* No module that talks to a language or embedding model, or is a chat/Talk
  tool, may touch what people wrote in Rooms or Porch (messages, attachments,
  posts, comments, stories). The one exception is ``app/rooms/promptly.py``,
  and what that is given is checked below and in ``test_rooms.py``.
* Inside ``app/rooms`` and ``app/porch`` nothing calls a model at all,
  ``promptly.py`` aside.
* No tool reads Rooms or Porch, and no switch on a room or a member widens
  what ``@promptly`` sees: the message that mentions it, and (owner decision,
  same day) the one message that message replies to, since the asker put the
  quote there for everyone to see. Never history.

Kept on purpose (owner decisions, same day): ``post_to_room`` (the main chat
*sends* a message for you after a yes; it reads nothing), plain word search
inside Rooms and Porch and Porch rows in Ctrl+K (Postgres only, no model),
and voice-message transcripts by the instance's own speech-to-text.
"""
from __future__ import annotations

import inspect
import re
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"

# What people wrote or posted there: the rows and tables that hold it.
CONTENT = re.compile(
    r"\b(RoomMessage|RoomAttachment|RoomReaction|room_messages|room_attachments|room_reactions"
    r"|PorchPost\w*|PorchComment\w*|PorchStor\w*|PorchPoll\w*|porch_posts|porch_post_media|porch_comments|porch_stor\w*"
    r"|porch\.search|porch\.posts|porch\.talk|porch\.stories|porch\.highlights)\b"
)
# Anything that hands text or pictures to a model, or stores it for one.
MODEL = re.compile(
    r"\b(editor_ai|resolve_model|stream_chat|chat_completion\w*|embed_texts|embed_query|embed_documents|embed_batch"
    r"|knowledge_chunks|KnowledgeChunk|memory\.service|app\.memory|custom_models\.embedding|photos\.ml|photos import ml"
    r"|drive_index|ToolResult|ToolContext)\b"
)
# The only place Rooms meets a model.
ONLY = "rooms/promptly.py"
# The list of every table's module, for Alembic: it imports, it runs nothing.
JUST_A_LIST = {"db_models.py"}


def _sources():
    for path in sorted(APP.rglob("*.py")):
        yield path.relative_to(APP).as_posix(), path.read_text(encoding="utf-8")


def test_nothing_that_reaches_a_model_touches_rooms_or_porch_content():
    mixed = [rel for rel, src in _sources() if rel != ONLY and rel not in JUST_A_LIST and CONTENT.search(src) and MODEL.search(src)]
    assert mixed == [], (
        "These modules both reach a model (or are chat tools) and touch what people wrote in Rooms or Porch. "
        f"Rooms and Porch are never read or indexed by AI: {mixed}"
    )


def test_rooms_and_porch_call_no_model_themselves():
    inside = [
        rel for rel, src in _sources()
        if (rel.startswith("rooms/") or rel.startswith("porch/")) and rel != ONLY and MODEL.search(src)
    ]
    assert inside == [], f"A model is reached from inside Rooms or Porch: {inside}"


def test_no_tool_reads_rooms_or_porch():
    from app.chat.tools.base import UNTRUSTED_CONTENT_TOOLS
    from app.chat.tools.registry import REGISTRY
    from app.talk import tools as talk_tools

    names = {t.name for t in REGISTRY}
    assert "read_room" not in names and "rooms_unread" not in names
    assert not [n for n in names if "porch" in n.lower()]
    # The one Rooms tool writes (after a yes); it is never "outside content" to read.
    assert [t.name for t in REGISTRY if t.category == "rooms"] == ["post_to_room"]
    assert not {"read_room", "rooms_unread"} & set(UNTRUSTED_CONTENT_TOOLS)
    assert not {"read_room", "rooms_unread"} & (set(talk_tools.READS) | set(talk_tools.NOT_ON_VOICE))
    # No tool's module loads message or post rows.
    for tool in REGISTRY:
        src = inspect.getsource(inspect.getmodule(type(tool)))
        assert not CONTENT.search(src), f"{tool.name} is defined beside code that reads Rooms or Porch content"


def test_no_switch_widens_what_promptly_sees():
    from app.rooms import promptly
    from app.rooms.models import Room, RoomMember

    assert not hasattr(Room, "ai_context") and not hasattr(RoomMember, "ai_ok")
    assert not hasattr(promptly, "can_read_history") and not hasattr(promptly, "HISTORY")
    # build() loads no messages itself: it is handed the asking one, and may
    # ask quoted() for the single message that one replies to.
    src = inspect.getsource(promptly.build)
    assert "select(" not in src and "db.get(RoomMessage" not in src and "RoomAttachment" not in src
    # quoted() fetches exactly that one message, by the id on the ask: one
    # get, no query, no attachments, no walking further up a chain of replies.
    q = inspect.getsource(promptly.quoted)
    assert q.count("db.get(RoomMessage") == 1 and "ask.reply_to_id" in q
    assert "select(" not in q and "execute(" not in q and "RoomAttachment" not in q and "m.reply_to_id" not in q
    # Nothing else in the module reads messages: answer() gets the ask, post() writes.
    whole = inspect.getsource(promptly)
    assert whole.count("db.get(RoomMessage") == 2 and "select(RoomMessage" not in whole and "RoomAttachment" not in whole


async def test_promptly_is_given_the_one_message():
    from types import SimpleNamespace

    from app.rooms import promptly
    from app.rooms.models import RoomMessage

    asked_for: list = []

    class NoDb:
        async def get(self, model, key, *a, **kw):
            asked_for.append((getattr(model, "__name__", str(model)), key))
            if model is RoomMessage:
                assert key == 3, "only the message the ask replies to may be fetched"
                return SimpleNamespace(id=3, room_id=1, deleted_at=None, kind="user", author_id=5, body="250g flour, 3 eggs", meta={}, reply_to_id=2)
            return SimpleNamespace(name="Family", username="bob")

        async def execute(self, *a, **kw):
            raise AssertionError("@promptly ran a query: it may only be handed the asking message and the one it replies to")

    room = SimpleNamespace(id=1, space_id=2, kind="text", name="general")
    # Not a reply: the one message, and no message is fetched at all.
    ask = SimpleNamespace(body="@promptly when does Bunnings close?", reply_to_id=None, seq=9, author_id=4, room_id=1)
    system, messages = await promptly.build(NoDb(), room, ask, SimpleNamespace(username="ann"))
    assert messages == [{"role": "user", "content": "ann: @promptly when does Bunnings close?"}]
    assert "only see the one message" in system
    assert not [a for a in asked_for if a[0] == "RoomMessage"]

    # A reply: that one message too, and nothing further up the chain (the
    # quoted message is itself a reply to message 2, which is never fetched).
    asked_for.clear()
    ask = SimpleNamespace(body="@promptly double this", reply_to_id=3, seq=9, author_id=4, room_id=1)
    system, messages = await promptly.build(NoDb(), room, ask, SimpleNamespace(username="ann"))
    assert messages == [{"role": "user", "content": "ann is replying to this message from bob:\n<quoted>\n250g flour, 3 eggs\n</quoted>\n\nann: @promptly double this"}]
    assert [a for a in asked_for if a[0] == "RoomMessage"] == [("RoomMessage", 3)]

    # A message from another room is never handed over, whatever the id says.
    ask = SimpleNamespace(body="@promptly double this", reply_to_id=3, seq=9, author_id=4, room_id=99)
    _system, messages = await promptly.build(NoDb(), room, ask, SimpleNamespace(username="ann"))
    assert messages == [{"role": "user", "content": "ann: @promptly double this"}]


# Speech-to-text writes out a voice message's words (owner decision: kept).
# It is not a language model and is reached from one place only.
SPEECH_TO_TEXT = re.compile(r"\b(notes\.transcription|meetings_runner|_transcribe|_segment_audio)\b")
ONLY_VOICE = "rooms/voice.py"
# ...and ``features.py`` asks whether speech-to-text is set up (and where it
# runs), to decide if a recording may be written out. It hands it nothing.
ASKS_IF_SET_UP = "rooms/features.py"


def test_speech_to_text_is_reached_from_voice_messages_only():
    inside = [
        rel for rel, src in _sources()
        if (rel.startswith("rooms/") or rel.startswith("porch/")) and rel not in (ONLY_VOICE, ASKS_IF_SET_UP) and SPEECH_TO_TEXT.search(src)
    ]
    assert inside == [], f"Speech-to-text is reached from Rooms or Porch outside voice messages: {inside}"
    # ...and voice messages reach nothing else: no language or embedding model.
    voice = (APP / ONLY_VOICE).read_text(encoding="utf-8")
    assert not MODEL.search(voice)
    asks = (APP / ASKS_IF_SET_UP).read_text(encoding="utf-8")
    assert "_transcribe" not in asks and "RoomMessage" not in asks and "RoomAttachment" not in asks


async def test_voice_words_go_to_a_cloud_service_only_if_the_admin_says_so(db, monkeypatch):
    """The default keeps recordings on this server: with cloud speech-to-text
    set up, nothing is written out until the admin allows it."""
    from types import SimpleNamespace

    import app.notes.transcription as transcription
    from app.rooms import features, settings

    kind = {"backend": "cloud"}

    async def _config(db):
        return SimpleNamespace(ready=True, backend=kind["backend"])

    monkeypatch.setattr(transcription, "config", _config)
    assert (await settings.load(db))["voice_transcripts"] == "local"
    assert await features.transcripts_on(db) is False
    kind["backend"] = "local"
    assert await features.transcripts_on(db) is True
    kind["backend"] = "cloud"
    await settings.save(db, {"voice_transcripts": "cloud"})
    await db.commit()
    assert await features.transcripts_on(db) is True
    await settings.save(db, {"voice_transcripts": "off"})
    await db.commit()
    kind["backend"] = "local"
    assert await features.transcripts_on(db) is False
