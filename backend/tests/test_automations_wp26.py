"""Automations (WP-2.6): failed-run records, restart safety, local dates,
JSON field access, fairness, notify modes, workspace reads, webhooks and
drafts (R-146…R-155, R-195)."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest

from app.net import safe_fetch as sf
from app.tasks import graph_runner
from app.tasks.flow_graph import (
    FlowEdge,
    FlowGraph,
    FlowNode,
    NodeType,
    ReportOutputData,
)
from app.tasks.models import Task, TaskRun


@pytest.fixture
def sent(monkeypatch):
    calls = []

    async def fake_fetch(method, url, **kw):
        calls.append({"method": method, "url": url, **kw})
        if "/fail" in url:
            raise httpx.ConnectError("down")
        return SimpleNamespace(text="{}", status_code=200, content=b"{}", headers={})

    monkeypatch.setattr(sf, "safe_fetch", fake_fetch)
    return calls


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


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _graph(*middle: FlowNode, trigger_type=NodeType.TRIGGER_MANUAL) -> FlowGraph:
    trig = FlowNode(id="t", type=trigger_type, data={})
    out = FlowNode(id="out", type=NodeType.OUTPUT_REPORT, data=ReportOutputData().model_dump())
    nodes = [trig, *middle, out]
    ids = [n.id for n in nodes]
    return FlowGraph(mode="advanced", nodes=nodes, edges=[FlowEdge(source=a, target=b) for a, b in zip(ids, ids[1:])])


def _http(nid="h", **data) -> FlowNode:
    base = {"method": "GET", "url": "https://api.example.com/x", "headers": [], "body": ""}
    base.update(data)
    return FlowNode(id=nid, type=NodeType.HTTP_REQUEST, data=base)


async def _task(db, user, tz="UTC", graph: FlowGraph | None = None, **kw) -> Task:
    t = Task(title="T", prompt="p", user_id=user.id, timezone=tz, frequency="daily", minute=0,
             flow_graph=graph.model_dump(mode="json") if graph else None, **kw)
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


# ---------------------------------------------------------------- R-148
async def test_date_and_time_are_in_the_schedules_timezone(db, user, sent):
    g = _graph(_http(url="https://api.example.com/{{date}}/{{time}}"))
    task = await _task(db, user, tz="Australia/Sydney", graph=g)
    # 08:00 on 7 Oct in Sydney is 21:00 on 6 Oct UTC.
    started = datetime(2026, 10, 6, 21, 0, tzinfo=timezone.utc)
    await graph_runner.run_graph_flow(task=task, graph=g, user=user, run_started_at=started, db=db)
    assert sent[0]["url"].endswith("/2026-10-07/08:00")


# ---------------------------------------------------------------- R-150
async def test_large_json_payloads_keep_later_fields_and_unfilled_ones_are_flagged(db, user, sent):
    body = {"filler": {f"k{i}": i for i in range(600)}, "status": "ok"}
    g = _graph(_http(url="https://api.example.com/{{trigger.json.status}}/{{trigger.json.missing}}"),
               trigger_type=NodeType.TRIGGER_WEBHOOK)
    task = await _task(db, user, graph=g)
    _r, _s, _u, runs = await graph_runner.run_graph_flow(
        task=task, graph=g, user=user, run_started_at=datetime.now(timezone.utc),
        trigger_payload=json.dumps(body), db=db,
    )
    assert "/ok/" in sent[0]["url"]
    rec = next(r for r in runs if r["node_id"] == "h")
    assert rec.get("unresolved") == ["trigger.json.missing"]


# ---------------------------------------------------------------- R-146
async def test_a_failed_run_keeps_its_steps_and_names_the_broken_one(db, user, sent, monkeypatch):
    from app.tasks.runner import execute_run

    ok = _http("h1", url="https://api.example.com/ok")
    bad = _http("h2", url="https://api.example.com/fail")
    g = _graph(ok, bad)
    task = await _task(db, user, graph=g, enabled=True)
    run = TaskRun(task_id=task.id, status="pending", trigger="manual")
    db.add(run)
    await db.commit()
    run_id = run.id
    await execute_run(run_id)
    db.expire_all()
    row = await db.get(TaskRun, run_id)
    assert row.status == "failed"
    ids = [r["node_id"] for r in row.node_runs]
    assert ids[:2] == ["h1", "h2"]
    assert row.node_runs[1]["status"] == "error"
    assert "HTTP request" in row.error


# ---------------------------------------------------------------- R-147
async def test_a_run_already_running_isnt_started_again(db, user):
    from app.tasks.runner import execute_run

    task = await _task(db, user, graph=_graph(_http()))
    run = TaskRun(task_id=task.id, status="running", trigger="manual", started_at=datetime.now(timezone.utc))
    db.add(run)
    await db.commit()
    run_id = run.id
    await execute_run(run_id)
    db.expire_all()
    row = await db.get(TaskRun, run_id)
    assert row.status == "failed" and "Interrupted" in row.error


# ---------------------------------------------------------------- R-151
async def test_a_busy_owner_waits_their_turn(db, user, monkeypatch):
    from app.tasks import queue, runner

    task = await _task(db, user, graph=_graph(_http()))
    for _ in range(runner.PER_USER_CONCURRENT_RUNS):
        db.add(TaskRun(task_id=task.id, status="running", trigger="manual", started_at=datetime.now(timezone.utc)))
    run = TaskRun(task_id=task.id, status="pending", trigger="manual")
    db.add(run)
    await db.commit()
    run_id = run.id
    requeued = []

    async def fake_enqueue(rid, *, defer_by=None):
        requeued.append((rid, defer_by))

    monkeypatch.setattr(queue, "enqueue_run", fake_enqueue)
    await runner.execute_run(run_id)
    db.expire_all()
    assert (await db.get(TaskRun, run_id)).status == "pending"
    assert requeued and requeued[0][0] == run_id and requeued[0][1]


# ---------------------------------------------------------------- R-152
async def test_notify_modes(db, user):
    from app.tasks.runner import _should_notify

    task = await _task(db, user)
    async def run(status, out=""):
        r = TaskRun(task_id=task.id, status=status, trigger="manual", output_markdown=out)
        db.add(r)
        await db.commit()
        return r.id

    first = await run("success", "A")
    assert await _should_notify(db, mode="failures", status="success", task_id=task.id, run_id=first, output="A")
    second = await run("success", "A")
    assert not await _should_notify(db, mode="failures", status="success", task_id=task.id, run_id=second, output="A")
    assert await _should_notify(db, mode="failures", status="failed", task_id=task.id, run_id=second, output="")
    assert not await _should_notify(db, mode="changes", status="success", task_id=task.id, run_id=second, output="A")
    third = await run("success", "B")
    assert await _should_notify(db, mode="changes", status="success", task_id=task.id, run_id=third, output="B")
    assert not await _should_notify(db, mode="never", status="failed", task_id=task.id, run_id=third, output="")


async def test_automation_results_dont_evict_other_notifications(db, user):
    from sqlalchemy import func, select

    from app.notifications import dispatch
    from app.notifications.models import Notification

    db.add(Notification(user_id=user.id, category="mention", title="you were mentioned", body=""))
    await db.commit()
    for i in range(dispatch._AUTOMATION_INBOX_CAP + 30):
        await dispatch._dispatch(
            user_id=user.id, category="task_complete",
            payload=dispatch.PushPayload(title=f"run {i}", body="", url=f"/tasks/{i}"),
        )
    rows = (await db.execute(select(Notification.category, func.count()).where(Notification.user_id == user.id).group_by(Notification.category))).all()
    counts = dict(rows)
    assert counts.get("mention") == 1
    assert counts["task_complete"] == dispatch._AUTOMATION_INBOX_CAP
    # One rolling row per automation.
    for _ in range(3):
        await dispatch._dispatch(
            user_id=user.id, category="task_complete",
            payload=dispatch.PushPayload(title="again", body="", url="/tasks/same"),
        )
    n_same = await db.scalar(select(func.count()).select_from(Notification).where(Notification.url == "/tasks/same"))
    assert n_same == 1


# ---------------------------------------------------------------- R-195
async def test_webhooks_rotate_check_signatures_and_pass_headers(client, db, user, monkeypatch):
    from app.auth.utils import encrypt_secret
    from app.secrets.models import UserSecret
    from app.tasks import hooks_router

    enq = []

    async def fake_enqueue(rid, **kw):
        enq.append(rid)

    monkeypatch.setattr(hooks_router, "enqueue_run", fake_enqueue)
    g = _graph(_http(), trigger_type=NodeType.TRIGGER_WEBHOOK)
    g.nodes[0].data = {"signature_header": "X-Hub-Signature-256", "signature_secret": "GH_HOOK"}
    task = await _task(db, user, graph=g, enabled=True, webhook_secret="s" * 40)
    db.add(UserSecret(user_id=user.id, name="GH_HOOK", value_encrypted=encrypt_secret("shh")))
    await db.commit()

    body = b'{"action": "opened"}'
    url = f"/api/hooks/{task.id}/{'s' * 40}?ref=main"
    assert (await client.post(url, content=body)).status_code == 401
    sig = "sha256=" + hmac.new(b"shh", body, hashlib.sha256).hexdigest()
    r = await client.post(url, content=body, headers={"X-Hub-Signature-256": sig, "X-GitHub-Event": "pull_request"})
    assert r.status_code == 202, r.text
    run = await db.get(TaskRun, uuid.UUID(r.json()["run_id"]))
    assert run.trigger_meta["headers"]["x_github_event"] == "pull_request"
    assert run.trigger_meta["query"] == {"ref": "main"}

    r = await client.post(f"/api/tasks/{task.id}/webhook/rotate", headers=_auth(user))
    assert r.status_code == 200
    assert (await client.post(url, content=body, headers={"X-Hub-Signature-256": sig})).status_code == 404

    from app.logging_setup import _redact_path

    assert _redact_path(f"/api/hooks/{task.id}/abc123") == f"/api/hooks/{task.id}/[secret]"


# ---------------------------------------------------------------- R-149
async def test_an_incomplete_flow_saves_as_a_draft_and_doesnt_run(client, db, user):
    task = await _task(db, user, graph=_graph(_http()))
    tid = task.id
    half = {"mode": "advanced", "nodes": [{"id": "t", "type": "trigger.manual", "position": {"x": 0, "y": 0}, "data": {}}], "edges": []}
    h = _auth(user)
    assert (await client.put(f"/api/tasks/{task.id}/graph", json=half, headers=h)).status_code == 422
    r = await client.put(f"/api/tasks/{task.id}/graph/draft", json=half, headers=h)
    assert r.status_code == 200
    d = (await client.get(f"/api/tasks/{task.id}/graph/draft", headers=h)).json()
    assert d["graph"]["nodes"][0]["id"] == "t"
    db.expire_all()
    stored = await db.get(Task, tid)
    assert len(stored.flow_graph["nodes"]) == 3  # still the complete flow


# ---------------------------------------------------------------- R-153
async def test_a_workspace_automation_reads_a_note_and_a_file(client, db, user):
    from app.chat.models import WorkspaceFile
    from app.files.models import UserFile

    ws_id = (await client.post("/api/workspaces", json={"title": "W"}, headers=_auth(user))).json()["id"]
    board = (await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "board", "title": "Sprint"}, headers=_auth(user))).json()
    await client.post(f"/api/workspaces/{ws_id}/tasks", json={"title": "Ship it", "board_item_id": board["id"]}, headers=_auth(user))
    from app.workspaces.knowledge import index_board_for_workspace

    await index_board_for_workspace(uuid.UUID(ws_id), uuid.UUID(board["id"]))
    uf = UserFile(user_id=user.id, filename="inv.pdf", original_filename="inv.pdf", mime_type="application/pdf",
                  size_bytes=3, storage_path="x/inv.pdf", content_text="Invoice total: $420")
    db.add(uf)
    await db.flush()
    db.add(WorkspaceFile(workspace_id=uuid.UUID(ws_id), file_id=uf.id))
    await db.commit()

    read_item = FlowNode(id="r1", type=NodeType.WORKSPACE_READ, data={"mode": "item", "title": "Sprint"})
    read_file = FlowNode(id="r2", type=NodeType.WORKSPACE_READ, data={"mode": "file", "file_id": "{{trigger.json.file_id}}"})
    g = _graph(read_item, read_file, trigger_type=NodeType.TRIGGER_WEBHOOK)
    task = await _task(db, user, graph=g, workspace_id=uuid.UUID(ws_id))
    report, _s, _u, runs = await graph_runner.run_graph_flow(
        task=task, graph=g, user=user, run_started_at=datetime.now(timezone.utc),
        trigger_payload=json.dumps({"file_id": str(uf.id)}), db=db,
    )
    by = {r["node_id"]: r for r in runs}
    assert by["r1"]["status"] == "success" and "Ship it" in by["r1"]["output"]
    assert "Invoice total" in report

    personal = await _task(db, user, graph=_graph(read_item))
    with pytest.raises(graph_runner.FlowFailed, match="workspace"):
        await graph_runner.run_graph_flow(task=personal, graph=_graph(read_item), user=user,
                                          run_started_at=datetime.now(timezone.utc), db=db)
