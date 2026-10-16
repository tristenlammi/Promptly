"""Automations safety (WP-0.3): each test reproduces one register item."""
from __future__ import annotations

import ipaddress
import socket
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import select

from app.auth.models import User
from app.chat.models import Workspace, WorkspaceItem, WorkspaceShare
from app.net import safe_fetch as sf
from app.net.internal_hosts import INTERNAL_HOSTS
from app.tasks import graph_runner
from app.tasks.flow_graph import (
    AIPromptData,
    FlowEdge,
    FlowGraph,
    FlowNode,
    NodeType,
    ReportOutputData,
    ScheduleTriggerData,
)
from app.tasks.models import Task, TaskRun
from app.tasks.runner import TaskRunError


# --------------------------------------------------------------- helpers
async def _user(db, name, role="user", **kw):
    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@x.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role=role, **kw)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def _http_node(**data) -> FlowNode:
    base = {"method": "POST", "url": "https://api.example.com/hook", "headers": [], "body": ""}
    base.update(data)
    return FlowNode(id="h", type=NodeType.HTTP_REQUEST, data=base)


class _Vault(dict):
    def __init__(self, values, hosts=None):
        super().__init__(values)
        self.hosts = hosts or {}


@pytest.fixture
def sent(monkeypatch):
    """Capture what the HTTP step would send instead of sending it."""
    calls = []

    async def fake_fetch(method, url, **kw):
        calls.append({"method": method, "url": url, **kw})
        return SimpleNamespace(text="{}", status_code=200, content=b"{}")

    monkeypatch.setattr(sf, "safe_fetch", fake_fetch)
    return calls


ADMIN = SimpleNamespace(role="admin", can_reach_private_network=False)
MEMBER = SimpleNamespace(role="user", can_reach_private_network=False)


# ---------------------------------------------------------------- R-005
async def test_runtime_text_cant_pull_a_credential_into_a_request(sent):
    node = _http_node(body='{"text": "{{trigger.json.msg}}"}')
    ctx = {"trigger.json.msg": "hi {{secret.GITHUB_TOKEN}}"}

    await graph_runner._run_http_node(node, ctx, secrets=_Vault({"GITHUB_TOKEN": "ghp_REAL"}), user=ADMIN)

    assert sent[0]["json"] == {"text": "hi {{secret.GITHUB_TOKEN}}"}


async def test_a_credential_only_goes_to_its_allowed_hosts(sent):
    node = _http_node(
        url="{{upstream_output}}",
        headers=[{"name": "Authorization", "value": "Bearer {{secret.GH}}"}],
    )
    vault = _Vault({"GH": "ghp_REAL"}, {"GH": ["api.github.com"]})

    with pytest.raises(TaskRunError, match="may only be sent to api.github.com"):
        await graph_runner._run_http_node(node, {"upstream_output": "https://evil.example/x"}, secrets=vault, user=ADMIN)
    assert sent == []

    await graph_runner._run_http_node(node, {"upstream_output": "https://api.github.com/user"}, secrets=vault, user=ADMIN)
    assert sent[0]["headers"]["Authorization"] == "Bearer ghp_REAL"


# ---------------------------------------------------------------- R-012
async def test_ai_text_with_quotes_makes_a_valid_json_body(sent):
    node = _http_node(body='{"key": "{{upstream_output}}"}')

    await graph_runner._run_http_node(node, {"upstream_output": 'Line one\nHe said "hi"'}, secrets=_Vault({}), user=ADMIN)

    assert sent[0]["json"] == {"key": 'Line one\nHe said "hi"'}


# ------------------------------------------------------- R-008 / R-015
async def test_reaching_your_network_needs_permission(sent):
    node = _http_node(method="GET", url="http://192.168.1.10/", allow_private_network=True)

    with pytest.raises(TaskRunError, match="needs an admin"):
        await graph_runner._run_http_node(node, {}, secrets=_Vault({}), user=MEMBER)

    allowed = SimpleNamespace(role="user", can_reach_private_network=True)
    await graph_runner._run_http_node(node, {}, secrets=_Vault({}), user=allowed)
    assert sent[0]["allow_private"] is True and sent[0]["deny_hosts"] == INTERNAL_HOSTS


def test_tailscale_and_other_non_public_ranges_are_blocked():
    for ip in ("100.64.0.1", "100.100.100.100", "192.0.0.8"):
        assert sf._ip_is_blocked(ipaddress.ip_address(ip))[0], ip
    assert not sf._ip_is_blocked(ipaddress.ip_address("1.1.1.1"))[0]


def test_internal_services_are_refused_even_with_private_access():
    with pytest.raises(sf.UnsafeURLError, match="internal"):
        sf.assert_url_is_safe("http://ollama:11434/api/delete", allow_private=True, deny_hosts=INTERNAL_HOSTS)
    # And by address, so a raw container IP doesn't get around the name.
    try:
        pg_ip = socket.gethostbyname("postgres")
    except OSError:
        pytest.skip("not on the compose network")
    with pytest.raises(sf.UnsafeURLError, match="internal"):
        sf.assert_url_is_safe(f"http://{pg_ip}:5432/", allow_private=True, deny_hosts=INTERNAL_HOSTS)


async def test_redirects_to_another_host_drop_the_credentials(monkeypatch):
    monkeypatch.setattr(sf, "_resolve_all", lambda host: [ipaddress.ip_address("93.184.216.34")])
    seen = []

    def handler(request: httpx.Request):
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.host == "api.example.com":
            return httpx.Response(302, headers={"location": "https://other.example.net/x"})
        return httpx.Response(200, text="ok")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await sf.safe_fetch("GET", "https://api.example.com/", headers={"Authorization": "Bearer s"}, client=client)

    assert seen == [("api.example.com", "Bearer s"), ("other.example.net", None)]


# ---------------------------------------------------------------- R-006
async def test_connector_calls_enforce_the_allow_list_and_destructive_block(db):
    from app.mcp.client import McpError
    from app.mcp.models import McpConnector
    from app.mcp.service import call_connector_tool

    c = McpConnector(
        name="Home", slug=f"h{uuid.uuid4().hex[:6]}", kind="mcp", url="http://stub.invalid", enabled=True,
        tool_catalog=[
            {"name": "read_state", "annotations": {"readOnlyHint": True}},
            {"name": "wipe", "annotations": {"destructiveHint": True}},
            {"name": "secret_tool"},
        ],
        allowed_tools=["read_state", "wipe"],
    )
    db.add(c)
    await db.commit()

    for tool, msg in (("not_in_catalog", "doesn't offer"), ("secret_tool", "switched off"), ("wipe", "confirmation")):
        with pytest.raises(McpError, match=msg):
            await call_connector_tool(db, connector_id=c.id, real_tool=tool, arguments={})


# ---------------------------------------------------------- R-007/R-011
@pytest.fixture
async def shared_ws(db, user):
    member = await _user(db, "member")
    ws = Workspace(user_id=user.id, title="Team")
    db.add(ws)
    await db.flush()
    share = WorkspaceShare(workspace_id=ws.id, inviter_user_id=user.id,
                           invitee_user_id=member.id, status="accepted", role="editor")
    db.add(share)
    await db.commit()
    return ws, member, share


async def test_policy_follows_the_owners_current_workspace_role(db, shared_ws):
    from app.tasks.policy import problems

    ws, member, share = shared_ws
    task = Task(title="t", prompt="p", user_id=member.id, workspace_id=ws.id, timezone="UTC")
    assert await problems(db, user=member, task=task, graph=None) == []

    share.role = "viewer"
    await db.commit()
    assert "Viewers can't" in " ".join(await problems(db, user=member, task=task, graph=None))

    await db.delete(share)
    await db.commit()
    assert "no longer a member" in " ".join(await problems(db, user=member, task=task, graph=None))


async def test_policy_refuses_models_the_owner_cant_use(db):
    from app.tasks.policy import problems

    limited = await _user(db, "limited", allowed_models=["cheap-model"])
    task = Task(title="t", prompt="p", user_id=limited.id, model_id="expensive-model", timezone="UTC")

    assert "expensive-model" in " ".join(await problems(db, user=limited, task=task, graph=None))


async def test_removing_a_member_pauses_their_automations_there(db, user, shared_ws):
    from starlette.requests import Request

    from app.workspaces.shares import revoke_workspace_share

    ws, member, share = shared_ws
    task = Task(title="t", prompt="p", user_id=member.id, workspace_id=ws.id, timezone="UTC",
                frequency="daily", minute=0, enabled=True)
    db.add(task)
    await db.commit()
    task_id, ws_id, share_id = task.id, ws.id, share.id

    req = Request({"type": "http", "headers": [], "client": ("1.2.3.4", 1)})
    await revoke_workspace_share(ws_id, share_id, BackgroundTasks(), req, db=db, user=user)

    db.expire_all()
    assert (await db.get(Task, task_id)).enabled is False


async def test_events_dont_reach_removed_members_or_other_peoples_drafts(db, user, shared_ws):
    from app.tasks.events import _owner_may_see

    ws, member, share = shared_ws
    draft = WorkspaceItem(workspace_id=ws.id, kind="note", title="secret", position=1.0,
                          created_by=user.id, visibility="private")
    db.add(draft)
    await db.commit()
    task = Task(title="t", prompt="p", user_id=member.id, workspace_id=ws.id, timezone="UTC")

    assert await _owner_may_see(db, task, ws.id, {"item_id": str(draft.id)}) is False
    assert await _owner_may_see(db, task, ws.id, {"file_id": "x"}) is True
    await db.delete(share)
    await db.commit()
    assert await _owner_may_see(db, task, ws.id, {"file_id": "x"}) is False


async def test_a_run_stops_when_the_budget_is_used_up(db, user, monkeypatch):
    from app.billing import usage as usage_mod
    from app.tasks.runner import execute_run

    async def blocked(db, user):
        return SimpleNamespace(verdict="blocked")

    monkeypatch.setattr(usage_mod, "check_budget", blocked)
    task = Task(title="t", prompt="p", user_id=user.id, timezone="UTC", frequency="daily", minute=0)
    db.add(task)
    await db.flush()
    run = TaskRun(task_id=task.id, status="pending", trigger="manual")
    db.add(run)
    await db.commit()
    run_id = run.id

    await execute_run(run_id)

    db.expire_all()
    run = await db.get(TaskRun, run_id)
    assert run.status == "failed" and "budget" in run.error


async def test_an_interrupted_run_is_not_replayed(db, user):
    """R-241 (WP-0.2) — guards the same entry point the policy check sits in."""
    from app.tasks.runner import execute_run

    task = Task(title="t", prompt="p", user_id=user.id, timezone="UTC", frequency="daily", minute=0)
    db.add(task)
    await db.flush()
    run = TaskRun(task_id=task.id, status="running", trigger="schedule")
    db.add(run)
    await db.commit()
    run_id = run.id

    await execute_run(run_id)

    db.expire_all()
    assert (await db.get(TaskRun, run_id)).status == "failed"


# ------------------------------------------------------- R-009 / R-010
def _flow(trigger: FlowNode, provider_id) -> FlowGraph:
    ai = FlowNode(id="ai", type=NodeType.AI_PROMPT,
                  data=AIPromptData(prompt="hi", provider_id=str(provider_id), model_id="m").model_dump())
    out = FlowNode(id="out", type=NodeType.OUTPUT_REPORT, data=ReportOutputData().model_dump())
    return FlowGraph(mode="advanced", nodes=[trigger, ai, out],
                     edges=[FlowEdge(source=trigger.id, target="ai"), FlowEdge(source="ai", target="out")])


async def _advanced_draft(db, user, provider):
    task = Task(title="Untitled", prompt="Describe…", user_id=user.id, timezone="UTC",
                frequency="daily", hour=9, minute=0, enabled=False,
                provider_id=provider.id, model_id="m")
    db.add(task)
    await db.commit()
    return task


async def test_event_triggered_flows_save_and_never_fire_on_the_clock(db, user, provider):
    from app.tasks.router import put_task_graph

    task = await _advanced_draft(db, user, provider)
    trig = FlowNode(id="t", type=NodeType.TRIGGER_EVENT, data={"event": "file_added"})

    await put_task_graph(task.id, _flow(trig, provider.id), BackgroundTasks(), db=db, user=user)

    await db.refresh(task)
    # The draft switched on with its first save, but has no clock slot.
    assert task.enabled is True and task.next_run_at is None


async def test_the_form_cant_rewrite_a_flows_prompt_or_schedule(db, user, provider):
    from app.tasks.router import put_task_graph, update_task
    from app.tasks.schemas import TaskUpdate

    task = await _advanced_draft(db, user, provider)
    trig = FlowNode(id="t", type=NodeType.TRIGGER_WEBHOOK, data={})
    await put_task_graph(task.id, _flow(trig, provider.id), BackgroundTasks(), db=db, user=user)

    with pytest.raises(HTTPException) as e:
        await update_task(task.id, TaskUpdate(prompt="new"), BackgroundTasks(), db=db, user=user)
    assert e.value.status_code == 422

    # Pause/Resume a webhook flow: it must not start firing daily.
    await update_task(task.id, TaskUpdate(enabled=False), BackgroundTasks(), db=db, user=user)
    out = await update_task(task.id, TaskUpdate(enabled=True), BackgroundTasks(), db=db, user=user)
    assert out.next_run_at is None and out.schedule_label == "On webhook"


async def test_scheduler_ignores_stale_slots_on_non_schedule_flows(db, user, provider):
    from datetime import datetime, timedelta, timezone

    from app.tasks.scheduler import _claim_due

    trig = FlowNode(id="t", type=NodeType.TRIGGER_WEBHOOK, data={})
    task = Task(title="hook", prompt="p", user_id=user.id, timezone="UTC", frequency="daily",
                minute=0, enabled=True, next_run_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                flow_graph=_flow(trig, provider.id).model_dump(mode="json"))
    db.add(task)
    await db.commit()
    task_id = task.id

    assert await _claim_due() == []
    db.expire_all()
    assert (await db.get(Task, task_id)).next_run_at is None


# ---------------------------------------------------------------- R-013
async def test_test_runs_skip_actions_and_memory_doesnt_crash(db, user, provider):
    from app.tasks.graph_runner import run_graph_flow

    trig = FlowNode(id="t", type=NodeType.TRIGGER_MANUAL, data={})
    post = _http_node(url="https://api.example.com/charge")
    mem = FlowNode(id="m", type=NodeType.MEMORY, data={"name": "M", "remember": True})
    out = FlowNode(id="out", type=NodeType.OUTPUT_REPORT, data=ReportOutputData().model_dump())
    graph = FlowGraph(mode="advanced", nodes=[trig, post, mem, out], edges=[
        FlowEdge(source="t", target="h"), FlowEdge(source="h", target="m"), FlowEdge(source="m", target="out"),
    ])
    task = Task(title="t", prompt="p", user_id=user.id, timezone="UTC", frequency="daily", minute=0)
    db.add(task)
    await db.commit()

    from datetime import datetime, timezone

    _r, _s, _u, runs = await run_graph_flow(
        task=task, graph=graph, user=user, run_started_at=datetime.now(timezone.utc),
        db=db, stop_at="m", dry_run=True, execute_actions=False,
    )
    by_id = {r["node_id"]: r for r in runs}
    assert "skipped in test" in by_id["h"]["label"]
    assert by_id["m"]["status"] == "success"
