"""A connector action that changes something irreversible runs only after
the user approves it in chat (WP-2.1, parity with Commands' "Ask before
running"). Destructive tools used to be hidden from chat altogether."""
from __future__ import annotations

import uuid

import httpx
import pytest

from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta
from tests.test_chat_reliability import _drive, _enqueue, _replies
from tests.test_chat_streaming import _seed_turn


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


async def _door_connector(db):
    from app.mcp.models import McpConnector

    c = McpConnector(
        name="Home Assistant", slug=f"ha{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://192.168.1.10/mcp", availability="global", enabled=True,
        tool_catalog=[{
            "name": "HassUnlock",
            "description": "Unlock a lock",
            "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}},
            "annotations": {"destructiveHint": True, "title": "Unlock"},
        }],
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return c


async def test_the_model_asking_to_unlock_doesnt_unlock(db, user, conversation, monkeypatch):
    import app.mcp.service as mcp_service
    from app.mcp.service import build_tools_from_connectors

    connector = await _door_connector(db)
    (_schemas, dispatch) = build_tools_from_connectors([connector], ask_first=True)
    (advertised,) = dispatch

    ran: list[str] = []

    async def _never(*_a, **_kw):
        ran.append("called")
        return "unlocked"

    monkeypatch.setattr(mcp_service, "call_connector_tool", _never)
    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    calls = {"n": 0}

    async def _stream(**kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            yield ToolCallDelta(index=0, id="call_1", name=advertised, arguments='{"name": "front door"}')
            yield FinishEvent(reason="tool_calls")
            return
        yield TextDelta(text="I'll unlock the front door once you approve.")
        yield FinishEvent(reason="stop")

    await _drive(monkeypatch, user, stream_id, _stream)

    assert ran == []
    (reply,) = await _replies(conversation)
    (call,) = reply.tool_calls
    assert call["meta"]["approval"] == "pending"
    assert call["meta"]["arguments"] == {"name": "front door"}
    assert call["meta"]["target"] == "front door"


async def test_approving_runs_it_once_and_only_its_owner_can(db, user, conversation, client, monkeypatch):
    import app.mcp.service as mcp_service
    from app.auth.models import User
    from app.chat.models import Message

    connector = await _door_connector(db)
    msg = Message(
        conversation_id=conversation.id, role="assistant", content="Approve?",
        tool_calls=[{
            "id": "call_1", "name": "ha__HassUnlock", "ok": True,
            "meta": {"approval": "pending", "connector_id": str(connector.id), "tool": "HassUnlock",
                     "connector": "Home Assistant", "arguments": {"name": "front door"}},
        }],
    )
    db.add(msg)
    stranger = User(email=f"s-{uuid.uuid4().hex[:6]}@example.com", username=f"s-{uuid.uuid4().hex[:6]}",
                    password_hash="x", role="user")
    db.add(stranger)
    await db.commit()

    ran: list[dict] = []

    async def _run(db, *, connector_id, real_tool, arguments, allow_destructive=False):
        assert allow_destructive is True
        ran.append(arguments)
        return '{"response_type": "action_done"}'

    monkeypatch.setattr(mcp_service, "call_connector_tool", _run)
    url = f"/api/chat/messages/{msg.id}/tool-calls/call_1/approval"

    assert (await client.post(url, headers=_auth(stranger), json={"approve": True})).status_code == 404
    r = await client.post(url, headers=_auth(user), json={"approve": True})
    assert r.status_code == 200 and r.json()["tool_call"]["meta"]["approval"] == "approved"
    assert (await client.post(url, headers=_auth(user), json={"approve": True})).status_code == 409
    assert ran == [{"name": "front door"}]


async def test_automations_still_never_get_destructive_tools(db):
    from app.mcp.service import build_tools_from_connectors

    connector = await _door_connector(db)
    schemas, dispatch = build_tools_from_connectors([connector])
    assert schemas == [] and dispatch == {}


async def test_a_connector_switched_off_in_a_chat_isnt_offered_there(db, user, conversation, client, monkeypatch):
    """Every reachable connector's tools used to ride along on every
    Tools-on turn (R-161)."""
    from app.mcp.models import McpConnector

    lights = McpConnector(
        name="Lights", slug=f"lights{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://192.168.1.30/mcp", availability="global", enabled=True,
        tool_catalog=[{"name": "LightsOn", "description": "", "input_schema": {"type": "object"}, "annotations": {}}],
    )
    db.add(lights)
    await db.commit()

    listed = (await client.get(f"/api/chat/conversations/{conversation.id}/connectors", headers=_auth(user))).json()
    assert any(c["name"] == "Lights" and c["on"] for c in listed)
    r = await client.put(
        f"/api/chat/conversations/{conversation.id}/connectors",
        headers=_auth(user), json={"disabled_connector_ids": [str(lights.id)]},
    )
    assert r.status_code == 204

    seen: list[dict] = []

    async def _stream(**kwargs):
        seen.append(kwargs)
        yield TextDelta(text="ok")
        yield FinishEvent(reason="stop")

    user_msg = await _seed_turn(db, conversation)
    stream_id = await _enqueue(conversation, user_msg, tools_enabled=True)
    await _drive(monkeypatch, user, stream_id, _stream)

    names = [t["function"]["name"] for t in seen[0]["tools"] or []]
    assert not any("LightsOn" in n for n in names)
