"""Workspace items (WP-2.5): meetings, private boards, board edits and
sync, dates, background removal, discussions, rosters, sheets, canvases and
comments (R-132, R-133, R-168…R-176, R-201, R-202)."""
from __future__ import annotations

import asyncio
import io
import uuid
import zipfile
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _user(db, name, role="user", tz=None):
    from app.auth.models import User

    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}{uuid.uuid4().hex[:6]}",
        password_hash="x",
        role=role,
        settings={"timezone": tz} if tz else None,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _workspace(client, owner, title="Team"):
    r = await client.post("/api/workspaces", json={"title": title}, headers=_auth(owner))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _member(db, ws_id, owner, member, role="editor"):
    from app.chat.models import WorkspaceShare

    db.add(WorkspaceShare(
        workspace_id=uuid.UUID(ws_id), inviter_user_id=owner.id, invitee_user_id=member.id,
        status="accepted", role=role, accepted_at=datetime.now(timezone.utc),
    ))
    await db.commit()


async def _item(client, owner, ws_id, kind, title, **extra):
    r = await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": kind, "title": title, **extra}, headers=_auth(owner))
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(autouse=True)
def _no_debounce(monkeypatch):
    from app.workspaces import reindex

    monkeypatch.setattr(reindex, "DEBOUNCE_SECONDS", 0.0)


# ---------------------------------------------------------------- R-133


@pytest.mark.asyncio
async def test_a_meeting_upload_needs_a_model_and_a_failed_summary_keeps_the_transcript(client, db, user, provider, monkeypatch):
    from app.chat.models import Workspace
    from app.workspaces import meetings_router
    from app.workspaces.meetings_models import MeetingJob

    ws_id = await _workspace(client, user)
    files = {"file": ("call.m4a", b"\x00" * 100, "audio/mp4")}
    r = await client.post(f"/api/workspaces/{ws_id}/meetings", files=files, headers=_auth(user))
    assert r.status_code == 400 and "model" in r.json()["detail"]

    ws = await db.get(Workspace, uuid.UUID(ws_id))
    ws.default_provider_id, ws.default_model_id = provider.id, "test-model"
    job = MeetingJob(workspace_id=ws.id, user_id=user.id, status="failed", error="boom", transcript="Hello team.")
    db.add(job)
    await db.commit()
    queued = []

    async def fake_enqueue(job_id):
        queued.append(job_id)

    monkeypatch.setattr(meetings_router, "enqueue_meeting", fake_enqueue)
    jobs = (await client.get(f"/api/workspaces/{ws_id}/meetings", headers=_auth(user))).json()
    assert jobs[0]["has_transcript"] is True
    t = await client.get(f"/api/workspaces/{ws_id}/meetings/{job.id}/transcript", headers=_auth(user))
    assert t.status_code == 200 and t.text == "Hello team."
    r = await client.post(f"/api/workspaces/{ws_id}/meetings/{job.id}/retry", headers=_auth(user))
    assert r.status_code == 200 and r.json()["status"] == "pending"
    assert queued == [job.id]


@pytest.mark.asyncio
async def test_a_cancelled_meeting_job_is_marked_failed(db, user, monkeypatch):
    from app.chat.models import Workspace
    from app.workspaces import meetings_runner
    from app.workspaces.meetings_models import MeetingJob

    uid = user.id
    ws = Workspace(user_id=uid, title="W")
    db.add(ws)
    await db.flush()
    job = MeetingJob(workspace_id=ws.id, user_id=uid, status="pending")
    db.add(job)
    await db.commit()
    job_id = job.id

    async def interrupted(db_, job_):
        job_.status = "transcribing"
        await db_.commit()
        raise asyncio.CancelledError()

    async def no_notify(**kw):
        return None

    monkeypatch.setattr(meetings_runner, "_execute", interrupted)
    monkeypatch.setattr("app.notifications.dispatch.notify_user", no_notify)
    with pytest.raises(asyncio.CancelledError):
        await meetings_runner.execute_meeting(job_id)
    db.expire_all()
    row = await db.get(MeetingJob, job_id)
    assert row.status == "failed" and "interrupted" in row.error


# ---------------------------------------------------------------- R-168


@pytest.mark.asyncio
async def test_a_private_boards_cards_stay_private(client, db, user):
    from app.chat.models import WorkspaceItem, WorkspaceTask

    member = await _user(db, "mem")
    ws_id = await _workspace(client, user)
    await _member(db, ws_id, user, member)
    board = await _item(client, user, ws_id, "board", "HR")
    item = await db.get(WorkspaceItem, uuid.UUID(board["id"]))
    item.visibility = "private"
    task = WorkspaceTask(workspace_id=item.workspace_id, board_item_id=item.id, title="Secret", status="todo", position=1, created_by=user.id)
    db.add(task)
    await db.commit()

    h = _auth(member)
    assert (await client.get(f"/api/workspaces/{ws_id}/tasks", headers=h)).json() == []
    assert (await client.get(f"/api/workspaces/{ws_id}/tasks", params={"board_item_id": board["id"]}, headers=h)).status_code == 404
    assert (await client.patch(f"/api/workspaces/{ws_id}/tasks/{task.id}", json={"title": "x"}, headers=h)).status_code == 404
    assert [t["title"] for t in (await client.get(f"/api/workspaces/{ws_id}/tasks", headers=_auth(user))).json()] == ["Secret"]
    stranger = await _user(db, "stranger")
    assert (await client.get(f"/api/workspaces/{ws_id}/activity", headers=_auth(stranger))).status_code == 404


# ---------------------------------------------------------------- R-173


def test_due_dates_read_in_the_users_timezone():
    from app.chat.proposals_router import _parse_ai_due
    from app.workspaces.localtime import local_date, zone_of

    class U:
        settings = {"timezone": "Australia/Brisbane"}

    due = datetime(2026, 10, 9, 9, 0, tzinfo=ZoneInfo("Australia/Brisbane"))
    assert due.astimezone(timezone.utc).date().isoformat() == "2026-10-08"
    assert local_date(due, zone_of(U())) == "2026-10-09"
    parsed = _parse_ai_due("2026-10-09", U())
    assert parsed.astimezone(ZoneInfo("Australia/Brisbane")).date() == date(2026, 10, 9)

    class NY:
        settings = {"timezone": "America/New_York"}

    assert _parse_ai_due("2026-10-09", NY()).astimezone(ZoneInfo("America/New_York")).date() == date(2026, 10, 9)


# ---------------------------------------------------------------- R-172


@pytest.mark.asyncio
async def test_remove_background_needs_edit_rights_in_a_workspace(client, db, user, monkeypatch):
    from app.workspaces import canvas_router

    viewer = await _user(db, "viewer")
    ws_id = await _workspace(client, user)
    await _member(db, ws_id, user, viewer, "viewer")
    monkeypatch.setattr(canvas_router, "_run_rembg", lambda data: b"PNG")
    files = {"file": ("i.png", b"img", "image/png")}
    r = await client.post("/api/canvas/remove-background", files=files, headers=_auth(user))
    assert r.status_code == 422  # no workspace
    r = await client.post("/api/canvas/remove-background", files=files, data={"workspace_id": ws_id}, headers=_auth(viewer))
    assert r.status_code == 403
    r = await client.post("/api/canvas/remove-background", files=files, data={"workspace_id": ws_id}, headers=_auth(user))
    assert r.status_code == 200 and r.content == b"PNG"


def test_big_images_are_scaled_down_before_inference():
    from PIL import Image

    from app.workspaces.canvas_router import _MAX_BG_PIXELS, _downscale

    buf = io.BytesIO()
    Image.new("RGB", (4000, 3000)).save(buf, format="PNG")
    out = Image.open(io.BytesIO(_downscale(buf.getvalue())))
    assert out.size[0] * out.size[1] <= _MAX_BG_PIXELS


# ---------------------------------------------------------------- R-170


@pytest.mark.asyncio
async def test_reindexing_coalesces_a_burst():
    from app.workspaces import reindex

    calls = []

    async def fn(ws, item):
        calls.append(item)

    item = uuid.uuid4()
    for _ in range(10):
        reindex.schedule(fn, uuid.uuid4(), item)
    await reindex.drain()
    assert calls == [item]


# ---------------------------------------------------------------- R-176


@pytest.mark.asyncio
async def test_discussion_messages_page_and_can_be_edited(client, db, user):
    ws_id = await _workspace(client, user)
    disc = await _item(client, user, ws_id, "discussion", "Talk")
    h = _auth(user)
    thread = (await client.post(f"/api/workspaces/{ws_id}/discussions/{disc['id']}/threads", json={"title": "T"}, headers=h)).json()
    for i in range(5):
        await client.post(f"/api/workspaces/{ws_id}/threads/{thread['id']}/messages", json={"body": f"m{i}"}, headers=h)
    page = (await client.get(f"/api/workspaces/{ws_id}/threads/{thread['id']}/messages", params={"limit": 2}, headers=h)).json()
    assert [m["body"] for m in page] == ["m3", "m4"]
    older = (await client.get(f"/api/workspaces/{ws_id}/threads/{thread['id']}/messages", params={"limit": 2, "before": page[0]["created_at"]}, headers=h)).json()
    assert [m["body"] for m in older] == ["m1", "m2"]
    r = await client.patch(f"/api/workspaces/{ws_id}/messages/{page[1]['id']}", json={"body": "m4 fixed"}, headers=h)
    assert r.status_code == 200 and r.json()["edited_at"]
    other = await _user(db, "other")
    await _member(db, ws_id, user, other)
    r = await client.patch(f"/api/workspaces/{ws_id}/messages/{page[1]['id']}", json={"body": "hijack"}, headers=_auth(other))
    assert r.status_code == 403


# ---------------------------------------------------------------- R-201


@pytest.mark.asyncio
async def test_column_changes_update_cards_and_duplicates_keep_fields(client, db, user):
    from app.chat.models import WorkspaceTask

    ws_id = await _workspace(client, user)
    board = await _item(client, user, ws_id, "board", "B")
    h = _auth(user)
    cols = [{"id": "todo", "name": "To do"}, {"id": "c_ship", "name": "Shipped"}, {"id": "c_old", "name": "Old"}]
    await client.patch(f"/api/workspaces/{ws_id}/items/{board['id']}", json={"config": {"columns": cols}}, headers=h)
    a = (await client.post(f"/api/workspaces/{ws_id}/tasks", json={"title": "A", "board_item_id": board["id"], "status": "c_ship"}, headers=h)).json()
    b = (await client.post(f"/api/workspaces/{ws_id}/tasks", json={"title": "B", "board_item_id": board["id"], "status": "c_old"}, headers=h)).json()
    await client.patch(f"/api/workspaces/{ws_id}/tasks/{a['id']}", json={"fields": {"f1": "x"}}, headers=h)

    cols2 = [{"id": "todo", "name": "To do"}, {"id": "c_ship", "name": "Shipped", "done": True}]
    await client.patch(f"/api/workspaces/{ws_id}/items/{board['id']}", json={"config": {"columns": cols2}}, headers=h)
    db.expire_all()
    ta, tb = await db.get(WorkspaceTask, uuid.UUID(a["id"])), await db.get(WorkspaceTask, uuid.UUID(b["id"]))
    assert ta.done is True and ta.completed_at is not None
    assert tb.status == "todo"  # its column was deleted

    r = await client.post(f"/api/workspaces/{ws_id}/items/{board['id']}/duplicate", headers=h)
    assert r.status_code in (200, 201), r.text
    copies = (await client.get(f"/api/workspaces/{ws_id}/tasks", params={"board_item_id": r.json()["id"]}, headers=h)).json()
    assert [t.get("fields") for t in copies if t["title"] == "A"] == [{"f1": "x"}]


# ---------------------------------------------------------------- R-202


@pytest.mark.asyncio
async def test_comment_moderation_and_edits(client, db, user):
    from app.chat.models import WorkspaceTaskComment

    admin = await _user(db, "adm")
    editor = await _user(db, "ed")
    ws_id = await _workspace(client, user)
    await _member(db, ws_id, user, admin, "admin")
    await _member(db, ws_id, user, editor, "editor")
    note = await _item(client, user, ws_id, "note", "N")
    c = (await client.post(f"/api/workspaces/{ws_id}/items/{note['id']}/comments", json={"body": "hi"}, headers=_auth(editor))).json()
    r = await client.patch(f"/api/workspaces/{ws_id}/items/{note['id']}/comments/{c['id']}", json={"body": "hello"}, headers=_auth(editor))
    assert r.status_code == 200 and r.json()["edited_at"]
    assert (await client.patch(f"/api/workspaces/{ws_id}/items/{note['id']}/comments/{c['id']}", json={"body": "x"}, headers=_auth(admin))).status_code == 403
    assert (await client.delete(f"/api/workspaces/{ws_id}/items/{note['id']}/comments/{c['id']}", headers=_auth(admin))).status_code == 204

    board = await _item(client, user, ws_id, "board", "B")
    card = (await client.post(f"/api/workspaces/{ws_id}/tasks", json={"title": "C", "board_item_id": board["id"]}, headers=_auth(editor))).json()
    activity = (await client.get(f"/api/workspaces/{ws_id}/tasks/{card['id']}/comments", headers=_auth(editor))).json()
    act = [x for x in activity if x.get("kind") == "activity"][0]
    r = await client.delete(f"/api/workspaces/{ws_id}/tasks/{card['id']}/comments/{act['id']}", headers=_auth(editor))
    assert r.status_code == 403
    assert await db.get(WorkspaceTaskComment, uuid.UUID(act["id"])) is not None


# ---------------------------------------------------------------- R-174


@pytest.mark.asyncio
async def test_publishing_a_roster_is_what_staff_see_and_their_calendar(client, db, user, monkeypatch):
    staff = await _user(db, "staff")
    ws_id = await _workspace(client, user)
    await _member(db, ws_id, user, staff, "editor")
    roster = await _item(client, user, ws_id, "roster", "Shifts")
    today = date.today()
    shift = lambda d, s: {"id": s, "personId": str(staff.id), "date": d.isoformat(), "timed": True, "start": "09:00", "end": "17:00", "hours": 8, "tags": [], "note": ""}
    told = []

    async def fake_notify(**kw):
        told.append(kw["user_id"])

    monkeypatch.setattr("app.notifications.notify_user", fake_notify)
    h = _auth(user)
    r = await client.post(
        f"/api/workspaces/{ws_id}/rosters/{roster['ref_id']}/publish",
        json={"data": {"settings": {}, "shifts": [shift(today + timedelta(days=1), "s1")]}},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert told == [staff.id]
    # A later draft edit isn't what staff see until it's published.
    rev = r.json()["revision"]
    await client.put(
        f"/api/workspaces/{ws_id}/rosters/{roster['ref_id']}",
        json={"data": {"settings": {}, "shifts": [shift(today + timedelta(days=2), "s2")]}, "base_revision": rev},
        headers=h,
    )
    seen = (await client.get(f"/api/workspaces/{ws_id}/rosters/{roster['ref_id']}", headers=_auth(staff))).json()
    assert [s["id"] for s in seen["data"]["shifts"]] == ["s1"]
    mine = (await client.get("/api/workspaces/my-shifts", headers=_auth(staff))).json()
    assert [m["date"] for m in mine] == [(today + timedelta(days=1)).isoformat()]
    link = (await client.post("/api/workspaces/my-shifts/calendar-link", headers=_auth(staff))).json()["url"]
    ics = await client.get(link.replace("http://test", ""))
    assert ics.status_code == 200 and "BEGIN:VEVENT" in ics.text and "Shifts" in ics.text
    assert (await client.get(link.replace("http://test", "").replace("sig=", "sig=x"))).status_code == 404


def test_roster_text_is_dated_and_windowed():
    from app.workspaces.roster_text import flatten_roster

    today = date(2026, 10, 9)
    data = {"shifts": [
        {"personId": "u1", "date": "2026-10-10", "timed": True, "start": "09:00", "end": "17:00", "hours": 8},
        {"personId": "u1", "date": "2025-01-01", "timed": False, "hours": 4},
    ]}
    text = flatten_roster("Cafe", data, {"u1": "Ben"}, today=today)
    assert "Sat 10 Oct 2026 (2026-10-10)" in text and "Ben 09:00–17:00" in text
    assert "2025-01-01" not in text


# ---------------------------------------------------------------- R-132


@pytest.mark.asyncio
async def test_sheets_export_and_import_xlsx_with_formulas_and_keep_versions(client, db, user):
    from openpyxl import load_workbook

    ws_id = await _workspace(client, user)
    sheet = await _item(client, user, ws_id, "sheet", "Budget")
    h = _auth(user)
    data = [{"name": "Q1", "celldata": [
        {"r": 0, "c": 0, "v": {"v": 2, "m": "2"}},
        {"r": 1, "c": 0, "v": {"v": 3, "m": "3"}},
        {"r": 2, "c": 0, "v": {"v": 5, "m": "5", "f": "=SUM(A1:A2)"}},
    ]}]
    url = f"/api/workspaces/{ws_id}/spreadsheets/{sheet['ref_id']}"
    assert (await client.put(url, json={"data": data, "content_text": "x"}, headers=h)).status_code == 200
    xlsx = await client.get(url + "/export", params={"format": "xlsx"}, headers=h)
    assert xlsx.status_code == 200
    wb = load_workbook(io.BytesIO(xlsx.content))
    assert wb["Q1"]["A3"].value == "=SUM(A1:A2)"
    csv_ = await client.get(url + "/export", params={"format": "csv"}, headers=h)
    assert csv_.text.lstrip("﻿").splitlines() == ["2", "3", "5"]

    r = await client.post(url + "/import", files={"file": ("b.xlsx", xlsx.content, "application/octet-stream")}, headers=h)
    assert r.status_code == 200
    tab = r.json()["data"][0]
    a3 = [c for c in tab["celldata"] if c["r"] == 2][0]["v"]
    assert a3["f"] == "=SUM(A1:A2)"
    versions = (await client.get(url + "/versions", headers=h)).json()
    assert versions and versions[0]["reason"] == "import" and versions[0]["cell_count"] == 3
    v = (await client.get(url + f"/versions/{versions[0]['id']}", headers=h)).json()
    assert v["data"][0]["name"] == "Q1"


# ---------------------------------------------------------------- R-175


def test_a_canvas_exports_as_an_excalidraw_scene():
    import json

    from pycrdt import Doc, Map

    from app.workspaces.export_router import canvas_scene_json

    doc = Doc()
    els = doc.get("elements", type=Map)
    files = doc.get("files", type=Map)
    els["a"] = {"id": "a", "type": "image", "fileId": "f1", "isDeleted": False}
    els["b"] = {"id": "b", "type": "rectangle", "isDeleted": True}
    files["f1"] = {"id": "f1", "dataURL": "data:image/png;base64,AA"}
    files["f2"] = {"id": "f2", "dataURL": "data:image/png;base64,BB"}
    scene = json.loads(canvas_scene_json(doc.get_update()))
    assert scene["type"] == "excalidraw"
    assert [e["id"] for e in scene["elements"]] == ["a"]
    assert list(scene["files"]) == ["f1"]
