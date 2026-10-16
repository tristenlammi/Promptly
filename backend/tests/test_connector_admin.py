"""Connector setup says what's wrong, and connectors remember whether they
work (R-157, R-158, R-160)."""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.mcp import client as mcp_client


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


# ------------------------------------------------------------- URL problems


async def test_a_missing_scheme_says_how_to_fix_it():
    with pytest.raises(mcp_client.McpError) as exc:
        await mcp_client.check_url("homeassistant.local:8123/mcp_server/sse")
    assert "http://" in str(exc.value)


async def test_an_unresolvable_name_suggests_the_ip(monkeypatch):
    import socket

    from app.net import safe_fetch

    def _fail(*_a, **_kw):
        raise socket.gaierror("nope")

    monkeypatch.setattr(safe_fetch.socket, "getaddrinfo", _fail)
    with pytest.raises(mcp_client.McpError) as exc:
        await mcp_client.check_url("http://homeassistant.local:8123/mcp_server/sse")
    assert "IP address" in str(exc.value)


async def test_creating_with_a_bad_url_is_a_400_not_a_500(db, user, client):
    r = await client.post(
        "/api/admin/mcp/connectors",
        headers=_auth(user),
        json={"name": "Home", "url": "homeassistant.local:8123", "availability": "global"},
    )
    assert r.status_code == 400
    assert "http://" in r.json()["detail"]


async def test_creating_a_second_connector_with_the_same_name_is_refused(db, user, client, monkeypatch):
    """A retry after a slow create used to leave "Home" and "Home-2"."""
    import app.mcp.router as mcp_router

    async def _no_catalog(db, connector):
        raise mcp_client.McpError("offline")

    monkeypatch.setattr(mcp_router, "refresh_catalog", _no_catalog)
    body = {"name": "Home", "url": "http://192.168.1.10:8123/mcp", "availability": "global"}
    first = await client.post("/api/admin/mcp/connectors", headers=_auth(user), json=body)
    second = await client.post("/api/admin/mcp/connectors", headers=_auth(user), json=body)
    assert first.status_code == 201
    assert second.status_code == 409


# ------------------------------------------------------------- catalog


def test_schemas_are_cleaned_for_providers():
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$defs": {"Area": {"type": "string", "description": "room"}},
        "properties": {"area": {"$ref": "#/$defs/Area"}},
    }
    out = mcp_client.normalise_schema(schema)
    assert out["type"] == "object"
    assert out["properties"]["area"] == {"type": "string", "description": "room"}
    assert "$schema" not in out and "$defs" not in out


async def test_every_page_of_the_catalog_is_read(monkeypatch):
    import contextlib

    pages = {
        None: SimpleNamespace(tools=[_tool("a")], nextCursor="p2"),
        "p2": SimpleNamespace(tools=[_tool("b")], nextCursor=None),
    }

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

        async def list_tools(self, cursor=None):
            return pages[cursor]

    monkeypatch.setattr(mcp_client, "_open", _open)
    monkeypatch.setattr(mcp_client, "ClientSession", _Session)
    monkeypatch.setattr(mcp_client, "assert_provider_url_safe", lambda url: None)

    tools = await mcp_client.fetch_tools("http://ha.lan/mcp")
    assert [t["name"] for t in tools] == ["a", "b"]


def _tool(name):
    return SimpleNamespace(name=name, description="", inputSchema={"type": "object"}, annotations=None)


# ------------------------------------------------------------- health


async def test_failures_are_recorded_and_success_clears_them(db, user, monkeypatch):
    from app.mcp import service as mcp_service
    from app.mcp.models import McpConnector

    alerts: list[str] = []

    async def _alert(_db, name, _cid, _err):
        alerts.append(name)

    monkeypatch.setattr(mcp_service, "_alert_admins_connector_down", _alert)
    c = McpConnector(
        name="Home", slug=f"home{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://192.168.1.10/mcp", enabled=True,
        tool_catalog=[{"name": "HassTurnOff", "annotations": {}}],
    )
    db.add(c)
    await db.commit()

    async def _down(*_a, **_kw):
        raise mcp_client.McpError("Connection refused")

    monkeypatch.setattr(mcp_service, "call_tool", _down)
    for _ in range(3):
        with pytest.raises(mcp_client.McpError):
            await mcp_service.call_connector_tool(db, connector_id=c.id, real_tool="HassTurnOff", arguments={})
    await db.refresh(c)
    assert c.consecutive_failures == 3 and "refused" in c.last_error
    assert alerts == ["Home"]  # once per streak

    async def _tool_says_no(*_a, **_kw):
        raise mcp_client.McpToolFailed("HassTurnOff failed: no such device")

    monkeypatch.setattr(mcp_service, "call_tool", _tool_says_no)
    with pytest.raises(mcp_client.McpToolFailed):
        await mcp_service.call_connector_tool(db, connector_id=c.id, real_tool="HassTurnOff", arguments={})
    await db.refresh(c)
    assert c.consecutive_failures == 0 and c.last_ok_at is not None


# ------------------------------------------------------------- workspaces (R-156)


async def _plain_user(db, name):
    from app.auth.models import User

    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_an_owners_save_leaves_the_admins_attachments_alone(db, user, client):
    """The owner flipping any toggle used to wipe every attachment and
    re-add only what they could personally reach."""
    from app.chat.models import Workspace
    from app.mcp.models import ConnectorUser, McpConnector, WorkspaceMcpConnector

    owner = await _plain_user(db, "owner")
    ws = Workspace(user_id=owner.id, title="Home")
    db.add(ws)
    admins_pick = McpConnector(
        name="Alarm", slug=f"alarm{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://192.168.1.20/mcp", availability="restricted", enabled=True,
    )
    owners_own = McpConnector(
        name="Lights", slug=f"lights{uuid.uuid4().hex[:6]}", kind="mcp",
        url="http://192.168.1.21/mcp", availability="restricted", enabled=True,
    )
    db.add_all([admins_pick, owners_own])
    await db.flush()
    db.add(WorkspaceMcpConnector(workspace_id=ws.id, connector_id=admins_pick.id, attached_by_admin=True))
    db.add(ConnectorUser(connector_id=owners_own.id, user_id=owner.id))
    await db.commit()

    r = await client.put(
        f"/api/workspaces/{ws.id}/connectors", headers=_auth(owner),
        json={"connector_ids": [str(owners_own.id)]},
    )
    assert r.status_code == 204
    r = await client.put(
        f"/api/workspaces/{ws.id}/connectors", headers=_auth(owner), json={"connector_ids": []},
    )
    assert r.status_code == 204

    listed = {
        c["name"]: c
        for c in (await client.get(f"/api/workspaces/{ws.id}/connectors", headers=_auth(owner))).json()
    }
    assert listed["Alarm"]["attached"] is True
    assert listed["Alarm"]["can_change"] is False
    assert listed["Lights"]["attached"] is False and listed["Lights"]["can_change"] is True


def test_admin_alerts_push_without_a_preference_of_their_own():
    """``system_alert`` has no per-category switch, so the lookup always
    said no and admin alerts never pushed (R-167)."""
    from types import SimpleNamespace

    from app.notifications.dispatch import _should_send

    prefs = SimpleNamespace(enabled=True)
    assert _should_send(prefs, "system_alert") is True
    assert _should_send(SimpleNamespace(enabled=False), "system_alert") is False
