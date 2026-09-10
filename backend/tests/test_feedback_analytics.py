"""Reading the thumbs.

The thumbs were collected long before anything consumed them, so these
tests pin the two things that make the read-side worth having: the rate
is computed against what was actually *rated* (not everything sent), and
the notes come back without dragging conversation content along with
them.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.billing.aggregates import feedback_by_model, feedback_notes
from app.chat.models import Message


async def _reply(db, conversation, *, model, feedback=None, reason=None, age_days=0):
    row = Message(
        conversation_id=conversation.id,
        role="assistant",
        content="...",
        model_id=model,
        feedback=feedback,
        feedback_reason=reason,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    if age_days:
        row.created_at = datetime.now(timezone.utc) - timedelta(days=age_days)
        await db.commit()
        await db.refresh(row)
    return row


def _start(days: int = 30) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


@pytest.mark.asyncio
async def test_the_rate_is_against_rated_replies_not_all_replies(
    db, conversation
):
    """An unrated reply is not a vote of confidence.

    Counting silence as approval would bury a model that everyone
    quietly stops using — the exact signal this screen exists to find.
    """
    await _reply(db, conversation, model="m1", feedback="down")
    await _reply(db, conversation, model="m1", feedback="up")
    for _ in range(20):
        await _reply(db, conversation, model="m1")  # unrated

    rows = await feedback_by_model(db, start=_start())

    assert len(rows) == 1
    assert rows[0].rated == 2
    assert rows[0].down_rate == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_worst_model_sorts_first(db, conversation):
    await _reply(db, conversation, model="good", feedback="up")
    await _reply(db, conversation, model="good", feedback="up")
    await _reply(db, conversation, model="good", feedback="down")
    await _reply(db, conversation, model="bad", feedback="down")
    await _reply(db, conversation, model="bad", feedback="down")

    rows = await feedback_by_model(db, start=_start())

    assert [r.model_id for r in rows] == ["bad", "good"]


@pytest.mark.asyncio
async def test_a_reply_is_attributed_to_the_model_that_produced_it(
    db, conversation
):
    """Not the conversation's current model.

    A conversation's model changes mid-thread, and each regenerated
    sibling stamps its own — attributing by conversation would blame
    whichever model happened to be selected last.
    """
    assert conversation.model_id == "test-model"
    await _reply(db, conversation, model="actually-used", feedback="down")

    rows = await feedback_by_model(db, start=_start())

    assert [r.model_id for r in rows] == ["actually-used"]


@pytest.mark.asyncio
async def test_replies_outside_the_window_are_excluded(db, conversation):
    await _reply(db, conversation, model="m1", feedback="down", age_days=90)

    assert await feedback_by_model(db, start=_start(30)) == []


@pytest.mark.asyncio
async def test_notes_carry_the_reason_but_never_the_message(db, conversation):
    reply = await _reply(
        db,
        conversation,
        model="m1",
        feedback="down",
        reason="Made up a citation.",
    )

    notes = await feedback_notes(db, start=_start())

    assert len(notes) == 1
    assert notes[0].reason == "Made up a citation."
    assert notes[0].message_id == reply.id
    # The row exposes no content field at all — an admin screen that
    # quietly showed everyone's chats would be a different feature.
    assert not hasattr(notes[0], "content")


@pytest.mark.asyncio
async def test_a_thumbs_down_with_no_note_is_not_listed(db, conversation):
    """Counts already cover it; a blank card is noise."""
    await _reply(db, conversation, model="m1", feedback="down")
    await _reply(db, conversation, model="m1", feedback="down", reason="   ")

    assert await feedback_notes(db, start=_start()) == []


@pytest.mark.asyncio
async def test_thumbs_up_notes_are_not_treated_as_complaints(db, conversation):
    await _reply(
        db, conversation, model="m1", feedback="up", reason="Nailed it."
    )

    assert await feedback_notes(db, start=_start()) == []
