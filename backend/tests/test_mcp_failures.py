"""A connector tool that fails is a failure everywhere (R-130).

"Close the garage", Home Assistant fails, and Promptly said "Garage
closed." with a green tick in History: the MCP client turned an error
result into ordinary text, so nothing upstream could tell.
"""
from __future__ import annotations

import contextlib
import json
import uuid
from types import SimpleNamespace

import pytest

from app.mcp import client as mcp_client


def _result(text: str, *, is_error: bool = False):
    return SimpleNamespace(
        isError=is_error, content=[SimpleNamespace(type="text", text=text)]
    )


def _fake_server(monkeypatch, result):
    @contextlib.asynccontextmanager
    async def _open(url, headers, transport):
        yield (None, None)

    class _Session:
        def __init__(self, *_a):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return False

        async def initialize(self):
            return None

        async def call_tool(self, name, arguments):
            return result

    monkeypatch.setattr(mcp_client, "_open", _open)
    monkeypatch.setattr(mcp_client, "ClientSession", _Session)
    monkeypatch.setattr(mcp_client, "assert_provider_url_safe", lambda url: None)


async def test_an_error_result_raises(monkeypatch):
    _fake_server(monkeypatch, _result("Garage door is jammed", is_error=True))

    with pytest.raises(mcp_client.McpToolFailed) as exc:
        await mcp_client.call_tool("http://ha.lan/mcp", "HassTurnOff", {"name": "garage"})

    assert "Garage door is jammed" in str(exc.value)


async def test_home_assistants_error_response_raises(monkeypatch):
    """HA reports an intent it couldn't carry out in the result's JSON."""
    body = {
        "response_type": "error",
        "data": {"code": "no_valid_targets"},
        "speech": {"plain": {"speech": "Sorry, I am not aware of any device called garage"}},
    }
    _fake_server(monkeypatch, _result(json.dumps(body)))

    with pytest.raises(mcp_client.McpToolFailed) as exc:
        await mcp_client.call_tool("http://ha.lan/mcp", "HassTurnOff", {"name": "garage"})

    assert "not aware of any device called garage" in str(exc.value)


async def test_a_successful_result_is_returned(monkeypatch):
    body = {"response_type": "action_done", "speech": {"plain": {"speech": "Turned off"}}}
    _fake_server(monkeypatch, _result(json.dumps(body)))

    out = await mcp_client.call_tool("http://ha.lan/mcp", "HassTurnOff", {})

    assert json.loads(out)["response_type"] == "action_done"


async def test_a_failed_command_says_why_instead_of_its_spoken_reply(db, user, monkeypatch):
    """The run is a failure, so the template ("Garage closed.") is never
    spoken and History records the tool's own reason."""
    import app.mcp.service as mcp_service
    from app.commands.models import Command
    from app.commands.service import CommandError, execute

    async def _fails(*_a, **_kw):
        raise mcp_client.McpToolFailed("HassTurnOff failed: Garage door is jammed")

    async def _allowed(*_a, **_kw):
        return None

    monkeypatch.setattr(mcp_service, "authorize_connector_tool", _allowed)
    monkeypatch.setattr(mcp_service, "call_connector_tool", _fails)
    row = Command(
        user_id=user.id,
        name="Close garage",
        action_type="mcp_tool",
        action_ref=f"{uuid.uuid4()}:HassTurnOff",
        response_template="Garage closed.",
        phrases=["close the garage"],
    )
    db.add(row)
    await db.commit()

    with pytest.raises(CommandError) as exc:
        await execute(db, row, user, slots={})

    assert "Garage door is jammed" in str(exc.value)
