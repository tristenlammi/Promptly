"""Compaction works on the visible thread, not every stored version (R-018).

The reproduction from the audit: a 10-turn chat whose last answer was
regenerated. Compaction used to slice *all* rows by position, splice the
summary onto the abandoned answer, and leave the visible thread as a
single orphaned message.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.chat import compaction
from app.chat.models import Message
from app.chat.versioning import active_path


@pytest.fixture
def fake_llm(monkeypatch):
    async def stream_chat(**_kw):
        yield "the middle, summarised"

    monkeypatch.setattr(compaction.model_router, "stream_chat", stream_chat)


async def _thread(db, conversation):
    """U1..U10/A1..A10, an edited U5' branch, and a regenerated A10'."""
    t0 = datetime.now(timezone.utc) - timedelta(hours=1)
    n = 0

    def at():
        nonlocal n
        n += 1
        return t0 + timedelta(seconds=n)

    pad = " lorem ipsum" * 10  # enough tokens that the tail stays small
    msgs: dict[str, Message] = {}
    parent = None
    for i in range(1, 11):
        for role, tag in (("user", "U"), ("assistant", "A")):
            m = Message(conversation_id=conversation.id, role=role,
                        content=f"{tag}{i}{pad}", parent_id=parent, created_at=at())
            db.add(m)
            await db.flush()
            msgs[f"{tag}{i}"] = m
            parent = m.id
    # An abandoned edit of U5 with its own answer.
    u5b = Message(conversation_id=conversation.id, role="user", content="U5'" + pad,
                  parent_id=msgs["A4"].id, created_at=at())
    db.add(u5b)
    await db.flush()
    db.add(Message(conversation_id=conversation.id, role="assistant", content="A5'" + pad,
                   parent_id=u5b.id, created_at=at()))
    # The regenerated final answer — this is what the user is looking at.
    a10b = Message(conversation_id=conversation.id, role="assistant", content="A10'" + pad,
                   parent_id=msgs["U10"].id, created_at=at())
    db.add(a10b)
    await db.flush()
    conversation.active_leaf_message_id = a10b.id
    await db.commit()
    return msgs, a10b


@pytest.mark.asyncio
async def test_compaction_keeps_the_visible_thread_intact(db, conversation, provider, fake_llm):
    msgs, a10b = await _thread(db, conversation)

    result = await compaction.compact_conversation(
        conversation=conversation, llm_provider=provider, llm_model_id="m",
        db=db, keep_tail_tokens=1,
    )

    rows = list((await db.execute(
        select(Message).where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at, Message.id)
    )).scalars())
    path = [m.content.split("]")[0] if m.role == "system" else m.content.split()[0]
            for m in active_path(rows, a10b.id)]
    assert path[:2] == ["U1", "A1"]
    assert path[2].startswith("[Compacted summary")
    assert path[3:] == ["U10", "A10'"]
    contents = {m.content.split()[0] for m in rows}
    # The abandoned final answer is still a switchable version.
    assert "A10" in contents
    # The edit branch hung off a compacted message; it went with it.
    assert "U5'" not in contents and "A5'" not in contents
    # Summarised only what was visible: U2..A9.
    assert result.messages_removed == 16 + 2


@pytest.mark.asyncio
async def test_custom_assistant_chats_compact_with_their_base_model(db, conversation, provider):
    from app.chat.router import _conversation_llm
    from app.custom_models.models import CustomModel

    cm = CustomModel(name="kb", display_name="KB", base_provider_id=provider.id,
                     base_model_id="real-model")
    db.add(cm)
    await db.flush()
    conversation.model_id = f"custom:{cm.id}"
    await db.commit()

    got_provider, model_id = await _conversation_llm(conversation, db)

    assert (got_provider.id, model_id) == (provider.id, "real-model")
