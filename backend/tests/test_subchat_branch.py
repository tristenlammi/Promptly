"""The branch-point invariant the Subchat panel depends on.

A subchat is an *ephemeral* branch: the backend copies the parent's whole
history into it so the model has full context, but the floating panel only
ever renders the turns actually taken in the panel — showing the inherited
copy would just be the main thread again, twice.

With the panel unmounted (you navigated to another chat) there's nothing
holding those turns, so recovering them means asking the server for the
conversation and dropping everything from before the fork. The only thing
that makes that separable is ``branched_at``: the copies keep their
*original* timestamps, so every copied row sorts strictly before it and
every new turn strictly after.

That's a quiet contract between two files that don't reference each other.
Copy the messages with a fresh ``created_at`` — the obvious-looking
simplification — and the panel silently starts replaying the entire parent
thread instead of the tangent.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select


async def _seed_history(db, conversation, count: int = 4):
    """A few alternating turns, backdated so they're unambiguously older
    than any branch taken 'now'."""
    from app.chat.models import Message

    base = datetime.now(timezone.utc) - timedelta(hours=1)
    rows = []
    prev = None
    for i in range(count):
        msg = Message(
            conversation_id=conversation.id,
            role="user" if i % 2 == 0 else "assistant",
            content=f"turn {i}",
            parent_id=prev,
            created_at=base + timedelta(minutes=i),
        )
        db.add(msg)
        await db.flush()
        prev = msg.id
        rows.append(msg)
    await db.commit()
    for r in rows:
        await db.refresh(r)
    return rows


async def _branch(db, user, conversation, fork_msg, *, ephemeral: bool):
    from app.chat.router import branch_conversation
    from app.chat.schemas import BranchConversationRequest

    return await branch_conversation(
        conversation.id,
        BranchConversationRequest(message_id=fork_msg.id, ephemeral=ephemeral),
        db=db,
        user=user,
    )


async def _messages_of(db, conversation_id):
    from app.chat.models import Message

    return (
        (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at.asc())
            )
        )
        .scalars()
        .all()
    )


async def test_copied_history_predates_the_branch_point(db, user, conversation):
    """The cutoff the panel filters on. Every inherited message must sort
    strictly before ``branched_at`` so ``created_at > branched_at`` isolates
    the tangent exactly."""
    history = await _seed_history(db, conversation)

    branch = await _branch(db, user, conversation, history[-1], ephemeral=True)

    assert branch.branched_at is not None
    copies = await _messages_of(db, branch.id)
    assert len(copies) == len(history)
    for copy in copies:
        assert copy.created_at < branch.branched_at, (
            "a copied message at or after branched_at would be replayed into "
            "the subchat panel as if the user had typed it"
        )


async def test_copies_keep_the_original_timestamps(db, user, conversation):
    """Stated separately from the invariant above because this is the
    mechanism: stamping copies with ``now()`` would put them *after*
    ``branched_at`` and break the filter while every other test still
    passed."""
    history = await _seed_history(db, conversation)

    branch = await _branch(db, user, conversation, history[-1], ephemeral=True)

    copies = await _messages_of(db, branch.id)
    assert [c.created_at for c in copies] == [h.created_at for h in history]


async def test_a_new_turn_sorts_after_the_branch_point(db, user, conversation):
    """The other half of the filter: a turn taken in the panel must land on
    the visible side of the cutoff."""
    from app.chat.models import Message

    history = await _seed_history(db, conversation)
    branch = await _branch(db, user, conversation, history[-1], ephemeral=True)

    db.add(
        Message(
            conversation_id=branch.id,
            role="user",
            content="the tangent",
            parent_id=None,
        )
    )
    await db.commit()

    visible = [
        m
        for m in await _messages_of(db, branch.id)
        if m.created_at > branch.branched_at
    ]
    assert [m.content for m in visible] == ["the tangent"]


async def test_ephemeral_branch_is_born_temporary(db, user, conversation):
    """A subchat has to carry its own deadline: the panel deletes it on
    close, but a refresh or a closed tab never gets to, and the sweeper is
    what stops those from accumulating."""
    history = await _seed_history(db, conversation)

    branch = await _branch(db, user, conversation, history[-1], ephemeral=True)

    assert branch.temporary_mode == "ephemeral"
    assert branch.expires_at is not None
    assert branch.expires_at > datetime.now(timezone.utc)


async def test_ordinary_branch_is_permanent(db, user, conversation):
    """Same endpoint, and only the flag separates a throwaway subchat from a
    branch the user means to keep."""
    history = await _seed_history(db, conversation)

    branch = await _branch(db, user, conversation, history[-1], ephemeral=False)

    assert branch.temporary_mode is None
    assert branch.expires_at is None
    assert branch.title.startswith("Branch:")


async def test_subchat_is_titled_as_one(db, user, conversation):
    history = await _seed_history(db, conversation)

    branch = await _branch(db, user, conversation, history[-1], ephemeral=True)

    assert branch.title.startswith("Subchat:")


async def test_branching_mid_thread_leaves_later_turns_behind(
    db, user, conversation
):
    """Forking from an earlier message copies only up to that point — the
    subchat inherits the context above it, not the whole thread."""
    history = await _seed_history(db, conversation, count=5)

    branch = await _branch(db, user, conversation, history[1], ephemeral=True)

    copies = await _messages_of(db, branch.id)
    assert [c.content for c in copies] == ["turn 0", "turn 1"]
