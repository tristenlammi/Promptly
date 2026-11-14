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
  what ``@promptly`` sees.

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
    # build() loads no messages: it is handed the asking one and uses only that.
    src = inspect.getsource(promptly.build)
    assert "select(" not in src and "reply_to" not in src and "RoomAttachment" not in src


async def test_promptly_is_given_the_one_message():
    from types import SimpleNamespace

    from app.rooms import promptly

    class NoDb:
        async def get(self, *a, **kw):  # a space's name is all it may look up
            return SimpleNamespace(name="Family")

        async def execute(self, *a, **kw):
            raise AssertionError("@promptly ran a query: it may only be handed the asking message")

    room = SimpleNamespace(id=1, space_id=2, kind="text", name="general")
    ask = SimpleNamespace(body="@promptly when does Bunnings close?", reply_to_id=3, seq=9, author_id=4)
    system, messages = await promptly.build(NoDb(), room, ask, SimpleNamespace(username="ann"))
    assert messages == [{"role": "user", "content": "ann: @promptly when does Bunnings close?"}]
    assert "only see the one message" in system
