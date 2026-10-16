"""Deep Research runs as a background job (WP-1.2, R-044/R-084).

It used to run inline on the POST: a reload lost the run, Cancel only
dropped the browser's connection (the research kept going and was billed),
and in a chat that already had messages the finished report was written
through a database session FastAPI had already closed — so it vanished.
"""
from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.models_config.provider import FinishEvent, TextDelta, UsageEvent


@pytest.fixture(autouse=True)
def _clean_sessions():
    from app.chat.stream_runner import _sessions

    _sessions.clear()
    yield
    _sessions.clear()


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


@pytest.fixture
def scripted(monkeypatch):
    """Evidence gathering and synthesis without the network."""
    from app.research import engine

    gate = {"hold": None}

    async def _gather(**kw):
        kw["on_progress"]({"event": "research_decomposed", "subquestions": [{"question": "q", "search_query": "q"}]})
        if gate["hold"] is not None:
            await gate["hold"].wait()
        ev = [{"subquestion": "q", "items": [{"index": 1, "title": "T", "url": "https://example.com", "content": "c"}]}]
        return engine.ResearchEvidence(evidence=ev, sources=[], evidence_doc="", source_count=1, angle_count=1)

    async def _synth(**kw):
        yield TextDelta(text="# Report\n\nThe findings.")
        yield UsageEvent(prompt_tokens=900, completion_tokens=300, cost_usd=0.02)
        yield FinishEvent(reason="stop")

    monkeypatch.setattr(engine, "gather_research_evidence", _gather)
    monkeypatch.setattr(engine.model_router, "stream_chat_events", _synth)
    return gate


async def _start(client, user, conversation) -> str:
    r = await client.post(
        f"/api/conversations/{conversation.id}/research",
        json={"query": "state of solid-state batteries", "provider_id": str(conversation.provider_id),
              "model_id": "test-model"},
        headers=_auth(user),
    )
    assert r.status_code == 202, r.text
    return r.json()["stream_id"]


async def test_the_report_lands_in_a_chat_that_already_has_messages(db, user, conversation, client, scripted):
    from app.chat.models import Conversation, Message
    from app.chat.stream_runner import get_session

    first = Message(conversation_id=conversation.id, role="user", content="earlier question")
    db.add(first)
    await db.flush()
    (await db.get(Conversation, conversation.id)).active_leaf_message_id = first.id
    await db.commit()

    stream_id = await _start(client, user, conversation)
    await asyncio.wait_for(get_session(uuid.UUID(stream_id)).task, 10)

    from app.database import SessionLocal

    async with SessionLocal() as s:
        conv = await s.get(Conversation, conversation.id)
        leaf = await s.get(Message, conv.active_leaf_message_id)
        assert leaf.role == "assistant" and "The findings." in leaf.content
        # Usage is recorded for the budget, not just shown.
        from app.billing.models import UsageDaily

        rows = list((await s.execute(select(UsageDaily).where(UsageDaily.user_id == user.id))).scalars())
        assert sum(r.completion_tokens or 0 for r in rows) >= 300


async def test_cancel_stops_the_research(db, user, conversation, client, scripted):
    from app.chat.models import Message
    from app.chat.stream_runner import get_session

    scripted["hold"] = asyncio.Event()
    stream_id = await _start(client, user, conversation)
    session = get_session(uuid.UUID(stream_id))
    await asyncio.sleep(0.2)

    r = await client.post(f"/api/chat/stream/{stream_id}/stop", headers=_auth(user))
    assert r.status_code == 200
    scripted["hold"].set()
    await asyncio.sleep(0.3)

    assert session.task.done()
    replies = list((await db.execute(
        select(Message).where(Message.conversation_id == conversation.id, Message.role == "assistant")
    )).scalars())
    assert replies == []


async def test_a_reload_can_find_a_running_research(db, user, conversation, client, scripted):
    scripted["hold"] = asyncio.Event()
    stream_id = await _start(client, user, conversation)
    r = await client.get(f"/api/chat/conversations/{conversation.id}/active-stream", headers=_auth(user))
    assert r.json() == {"stream_id": stream_id, "kind": "research", "label": "state of solid-state batteries"}
    scripted["hold"].set()
