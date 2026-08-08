"""End-to-end coverage for the chat streaming path.

This is the app's most critical code and, until this file, had none — it
needs a database to do anything, and the suite had no database harness (see
``conftest.py``). Two of these tests exist specifically to lock in fixes
that were previously verified only by hand:

* the assistant reply actually lands in Postgres, and
* the DB connection is **released during the model call**, which is what
  stopped ~30 concurrent replies from exhausting the pool, blocking
  ``/api/health``, and getting the container restarted mid-stream.

The model provider is stubbed — we're testing Promptly's orchestration, not
OpenAI's wire format.
"""
from __future__ import annotations

import inspect
import uuid

import pytest
from sqlalchemy import select

from app.models_config.provider import FinishEvent, TextDelta, UsageEvent


class _FakeRequest:
    """The generator only mentions ``request`` in a comment and passes it to
    tool dispatch; nothing dereferences it on the no-tools path."""

    class _Client:
        host = "127.0.0.1"

    client = _Client()
    headers: dict[str, str] = {}

    async def is_disconnected(self) -> bool:
        return False


def _stub_stream(chunks: list[str], *, on_call=None):
    """Build a stand-in for ``model_router.stream_chat_events``.

    ``on_call`` runs *inside* the generator, i.e. at the moment the real
    thing would be waiting on the provider — the window where the old code
    was holding a pooled connection open.
    """

    async def _stream(**kwargs):
        if on_call is not None:
            result = on_call(kwargs)
            if inspect.isawaitable(result):
                await result
        for c in chunks:
            yield TextDelta(text=c)
        yield UsageEvent(prompt_tokens=11, completion_tokens=7, cost_usd=0.0)
        yield FinishEvent(reason="stop")

    return _stream


async def _seed_turn(db, conversation):
    """Insert the user message that a stream replies to."""
    from app.chat.models import Message

    msg = Message(
        conversation_id=conversation.id,
        role="user",
        content="Hello there",
        parent_id=None,
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return msg


async def _run_stream(monkeypatch, user, conversation, user_msg, stub):
    """Drive the generator end to end and return the SSE chunks it yielded."""
    from app.chat import router as chat_router
    from app.chat.service import enqueue_stream

    monkeypatch.setattr(
        chat_router.model_router, "stream_chat_events", stub, raising=True
    )

    stream_id = uuid.uuid4()
    await enqueue_stream(
        stream_id,
        {
            "conversation_id": str(conversation.id),
            "user_message_id": str(user_msg.id),
            "provider_id": str(conversation.provider_id),
            "model_id": "test-model",
            "web_search_mode": "off",
            "temperature": 0.7,
            "max_tokens": None,
            "tools_enabled": False,
            "reasoning_effort": None,
        },
    )

    return [
        chunk
        async for chunk in chat_router._stream_generator(
            stream_id, user, _FakeRequest()
        )
    ]


async def test_reply_is_streamed_and_persisted(db, user, conversation, monkeypatch):
    from app.chat.models import Message

    user_msg = await _seed_turn(db, conversation)

    chunks = await _run_stream(
        monkeypatch, user, conversation, user_msg,
        _stub_stream(["Hello", " world"]),
    )

    joined = "".join(chunks)
    assert "Hello" in joined and "world" in joined
    assert '"done": true' in joined.lower().replace("'", '"')

    rows = (
        (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conversation.id)
                .where(Message.role == "assistant")
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1, "exactly one assistant reply should be persisted"
    assert rows[0].content == "Hello world"
    # Hung off the user turn — this is what the ‹2/3› version pager walks.
    assert rows[0].parent_id == user_msg.id


async def test_no_db_connection_is_held_during_the_model_call(
    db, user, conversation, monkeypatch
):
    """The regression that mattered most.

    A reply used to hold one pooled connection from the first prep query
    until it was persisted — across every model round-trip. With
    ``pool_size=10, max_overflow=20`` that capped the instance at ~30
    concurrent replies; once the pool drained, ``/api/health``'s ``SELECT 1``
    blocked too, so Docker marked the container unhealthy and restarted it,
    killing every in-flight stream. A self-amplifying outage.

    Asserting on pool occupancy *at the moment the provider is called* is
    the only way to pin that down — the symptom is invisible from the
    outside until the pool is already exhausted.
    """
    from app.database import engine

    user_msg = await _seed_turn(db, conversation)

    observed: list[tuple[int, str]] = []

    def _sample_pool(kwargs) -> None:
        # Label the call so we can tell the reply apart from the follow-up
        # title-generation call, which legitimately runs inside a session.
        observed.append(
            (engine.pool.checkedout(), (kwargs.get("system") or "")[:60])
        )

    await _run_stream(
        monkeypatch, user, conversation, user_msg,
        _stub_stream(["ok"], on_call=_sample_pool),
    )

    assert observed, "the stubbed provider was never called"

    # The reply is the first model call; a second one follows to generate
    # the chat title, and that one legitimately runs inside its own short
    # session — it isn't the long-held connection this guards against.
    checked_out, system = observed[0]
    assert "title" not in system.lower(), (
        f"expected the reply call first, got the titler: {system!r}"
    )
    # Only the test's own `db` fixture session should be holding one, so
    # the generation itself contributes zero.
    assert checked_out <= 1, (
        f"a connection was still checked out during the model call "
        f"(saw {checked_out}) — the generation is holding the pool open "
        f"for its whole duration. Samples: {observed}"
    )


async def test_usage_is_recorded_for_the_turn(
    db, user, conversation, monkeypatch
):
    """Token accounting shares the assistant message's transaction, so a
    reply that lands without usage means the budget view silently disagrees
    with what the chat shows."""
    from app.billing.models import UsageDaily

    user_msg = await _seed_turn(db, conversation)

    await _run_stream(
        monkeypatch, user, conversation, user_msg, _stub_stream(["hi"])
    )

    rows = (
        (await db.execute(select(UsageDaily).where(UsageDaily.user_id == user.id)))
        .scalars()
        .all()
    )
    assert rows, "usage should be recorded alongside the assistant message"
    assert rows[0].prompt_tokens == 11
    assert rows[0].completion_tokens == 7


async def test_deleted_conversation_mid_stream_does_not_persist(
    db, user, conversation, monkeypatch
):
    """Deleting the chat while a reply generates used to violate the
    messages→conversations FK and crash the stream, leaving the client
    wedged on "loading" with no clean close.

    The delete happens *inside* the model call and is awaited, so this
    reproduces the race deterministically rather than hoping for a
    scheduling window.
    """
    from sqlalchemy import delete as sa_delete

    from app.chat.models import Conversation, Message
    from app.database import SessionLocal

    user_msg = await _seed_turn(db, conversation)
    conv_id = conversation.id

    async def _drop_conversation(_kwargs) -> None:
        # A separate session: the generator's own is mid-flight, and this
        # mimics another request deleting the chat.
        async with SessionLocal() as s:
            await s.execute(
                sa_delete(Message).where(Message.conversation_id == conv_id)
            )
            await s.execute(
                sa_delete(Conversation).where(Conversation.id == conv_id)
            )
            await s.commit()

    chunks = await _run_stream(
        monkeypatch, user, conversation, user_msg,
        _stub_stream(["partial"], on_call=_drop_conversation),
    )

    # The stream must still close cleanly for the client...
    assert '"done": true' in "".join(chunks).lower().replace("'", '"')

    # ...and must not have resurrected a reply against the deleted chat.
    orphans = (
        (
            await db.execute(
                select(Message).where(Message.conversation_id == conv_id)
            )
        )
        .scalars()
        .all()
    )
    assert orphans == [], "no message should be written to a deleted chat"
