"""Editor-state protection (WP-3.3): file_versions, pre-AI snapshots,
conditional sheet saves, retention and admin recovery."""
from __future__ import annotations

import uuid
import zlib
from datetime import datetime, timedelta, timezone

import httpx
import pytest


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _user(db, name):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _sheet(client, user, title="Budget"):
    r = await client.post("/api/workspaces", json={"title": "Home"}, headers=_auth(user))
    ws_id = r.json()["id"]
    r = await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "sheet", "title": title},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    return ws_id, r.json()


def _book(*values):
    return [{"name": "Sheet1", "celldata": [{"r": i, "c": 0, "v": {"v": v}} for i, v in enumerate(values)]}]


async def _versions(db, file_id):
    from sqlalchemy import select

    from app.files.models import FileVersion

    return list(
        (
            await db.execute(
                select(FileVersion).where(FileVersion.file_id == file_id).order_by(FileVersion.created_at)
            )
        ).scalars()
    )


async def _shell_id(db, item):
    from app.chat.models import Spreadsheet

    sheet = await db.get(Spreadsheet, uuid.UUID(item["ref_id"]), populate_existing=True)
    return sheet.file_id


# ---------------------------------------------------------------- conditional save


@pytest.mark.asyncio
async def test_a_stale_sheet_save_gets_409_with_the_newer_workbook(client, db, user):
    ws_id, item = await _sheet(client, user)
    url = f"/api/workspaces/{ws_id}/spreadsheets/{item['ref_id']}"
    first = await client.get(url, headers=_auth(user))
    v0 = first.json()["data_version"]

    a = await client.put(url, json={"data": _book("a"), "data_version": v0}, headers=_auth(user))
    assert a.status_code == 200 and a.json()["data_version"] == v0 + 1
    # A second editor still on v0 would have overwritten that.
    b = await client.put(url, json={"data": _book("b"), "data_version": v0}, headers=_auth(user))
    assert b.status_code == 409
    detail = b.json()["detail"]
    assert detail["code"] == "stale" and detail["data_version"] == v0 + 1
    assert detail["data"][0]["celldata"][0]["v"]["v"] == "a"
    # Based on the newest version it goes through.
    c = await client.put(url, json={"data": _book("b"), "data_version": v0 + 1}, headers=_auth(user))
    assert c.status_code == 200
    # Older clients that don't send a version still save.
    d = await client.put(url, json={"data": _book("c")}, headers=_auth(user))
    assert d.status_code == 200


@pytest.mark.asyncio
async def test_oversized_workbooks_are_refused(client, db, user, monkeypatch):
    from app.workspaces import items_router

    monkeypatch.setattr(items_router, "_MAX_WORKBOOK_JSON_BYTES", 200)
    ws_id, item = await _sheet(client, user)
    r = await client.put(f"/api/workspaces/{ws_id}/spreadsheets/{item['ref_id']}",
                         json={"data": _book("x" * 500)}, headers=_auth(user))
    assert r.status_code == 413


# ---------------------------------------------------------------- snapshots


@pytest.mark.asyncio
async def test_clear_and_pre_ai_keep_versions(client, db, user):
    ws_id, item = await _sheet(client, user)
    url = f"/api/workspaces/{ws_id}/spreadsheets/{item['ref_id']}"
    await client.put(url, json={"data": _book("keep me")}, headers=_auth(user))
    r = await client.post(f"{url}/versions/checkpoint?reason=clear", headers=_auth(user))
    assert r.status_code == 200
    fid = await _shell_id(db, item)
    vs = await _versions(db, fid)
    assert [v.label for v in vs] == ["Before Clear sheet"]
    assert vs[0].data[0]["celldata"][0]["v"]["v"] == "keep me"

    # An editor asks for a pre-AI copy; a stranger can't.
    r = await client.post(f"/api/files/{fid}/versions", json={"source": "pre_ai"}, headers=_auth(user))
    assert r.status_code == 201
    stranger = await _user(db, "s")
    r = await client.post(f"/api/files/{fid}/versions", json={"source": "pre_ai"}, headers=_auth(stranger))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_snapshots_skip_an_unchanged_file(db, user, client):
    from app.files.models import UserFile
    from app.files.versions import snapshot_file

    ws_id, item = await _sheet(client, user)
    await client.put(f"/api/workspaces/{ws_id}/spreadsheets/{item['ref_id']}",
                     json={"data": _book("1")}, headers=_auth(user))
    shell = await db.get(UserFile, await _shell_id(db, item))
    assert await snapshot_file(db, shell, source="pre_ai") is not None
    assert await snapshot_file(db, shell, source="pre_ai") is None  # nothing new


# ---------------------------------------------------------------- retention


@pytest.mark.asyncio
async def test_prune_keeps_hourly_then_daily_and_the_labelled(db, user, client):
    from app.files.models import FileVersion
    from app.files.versions import prune_versions

    _ws, item = await _sheet(client, user)
    fid = await _shell_id(db, item)
    now = datetime.now(timezone.utc)

    def add(age: timedelta, label=None):
        db.add(FileVersion(file_id=fid, kind="sheet", source="auto", label=label,
                           yjs_state=zlib.compress(b"x"), created_at=now - age))

    # Pinned inside one clock hour / one day — "5 and 15 minutes ago" fell in
    # different hours when the suite ran at :05–:15 past the hour.
    last_hour = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    last_week_noon = (now - timedelta(days=7)).replace(hour=12, minute=0, second=0, microsecond=0)
    # Two in the same recent hour → one stays.
    add(now - (last_hour + timedelta(minutes=10)))
    add(now - (last_hour + timedelta(minutes=40)))
    # Two on the same day last week → one stays.
    add(now - (last_week_noon - timedelta(hours=1)))
    add(now - (last_week_noon + timedelta(hours=1)))
    # Older than 30 days → goes, unless labelled.
    add(timedelta(days=40))
    add(timedelta(days=41), label="Before the big rewrite")
    await db.commit()

    removed = await prune_versions(db)
    await db.commit()
    assert removed == 3
    kept = await _versions(db, fid)
    assert len(kept) == 3
    assert any(v.label == "Before the big rewrite" for v in kept)


# ---------------------------------------------------------------- recovery


@pytest.mark.asyncio
async def test_a_blanked_sheet_is_recovered_as_a_copy(db, user, client):
    from sqlalchemy import select

    from app.chat.models import Spreadsheet, WorkspaceItem
    from app.cli import _versions_recover

    ws_id, item = await _sheet(client, user, title="Chores")
    url = f"/api/workspaces/{ws_id}/spreadsheets/{item['ref_id']}"
    await client.put(url, json={"data": _book("dishes", "bins")}, headers=_auth(user))
    await client.post(f"{url}/versions/checkpoint?reason=clear", headers=_auth(user))
    await client.put(url, json={"data": []}, headers=_auth(user))  # blanked
    fid = await _shell_id(db, item)
    version = (await _versions(db, fid))[-1]

    assert await _versions_recover(str(version.id)) == 0
    copies = (
        await db.execute(
            select(WorkspaceItem).where(
                WorkspaceItem.workspace_id == uuid.UUID(ws_id), WorkspaceItem.title.like("Chores (recovered%")
            )
        )
    ).scalars().all()
    assert len(copies) == 1
    sheet = await db.get(Spreadsheet, copies[0].ref_id)
    assert [c["v"]["v"] for c in sheet.data[0]["celldata"]] == ["dishes", "bins"]
