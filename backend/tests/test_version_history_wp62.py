"""Version history for office files (WP-6.2): list, name and keep versions,
see what changed, and restore one as a server-side room reset — the state
it replaces kept first, the edit generation bumped so stale editors reload."""
from __future__ import annotations

import base64
import uuid
import zlib

import pytest
from sqlalchemy import select

from tests.test_doc_comments_wp45 import _auth, _grant, _user, client  # noqa: F401 — fixtures


def _doc_state(text: str) -> bytes:
    from pycrdt import Doc, XmlElement, XmlFragment, XmlText

    d = Doc()
    d.get("default", type=XmlFragment).children.append(XmlElement("paragraph", {}, [XmlText(text)]))
    return d.get_update()


@pytest.fixture
def collab(monkeypatch):
    """Stand in for the collab server's reset / release."""
    from app import collab_internal

    calls: list[tuple[str, str]] = []
    live: dict[str, bytes | None] = {"state": None}

    async def reset(room):
        calls.append(("reset", room))
        return live["state"]

    async def release(room):
        calls.append(("release", room))

    monkeypatch.setattr(collab_internal, "reset_room", reset)
    monkeypatch.setattr(collab_internal, "release_room", release)
    return {"calls": calls, "live": live}


async def _doc(client, user, text):
    r = await client.post("/api/files/office", json={"kind": "document", "title": "Plan"}, headers=_auth(user))
    doc = r.json()["id"]
    r = await client.post(f"/api/documents/{doc}/initial-state",
                          json={"yjs_state": base64.b64encode(_doc_state(text)).decode()}, headers=_auth(user))
    assert r.status_code == 200, r.text
    return doc


async def _set_doc(db, doc_id, text):
    from app.files.models import DocumentState

    ds = await db.get(DocumentState, uuid.UUID(doc_id), populate_existing=True)
    ds.yjs_update = _doc_state(text)
    await db.commit()


async def _snapshot(db, file_id, label=None, author=None):
    from app.files.models import UserFile
    from app.files.versions import snapshot_file

    row = await db.get(UserFile, uuid.UUID(file_id), populate_existing=True)
    v = await snapshot_file(db, row, source="manual", label=label, author_id=author)
    await db.commit()
    return v.id


@pytest.mark.asyncio
async def test_versions_are_listed_named_kept_and_only_editors_change_them(client, db, user):  # noqa: F811
    doc = await _doc(client, user, "First draft")
    vid = await _snapshot(db, doc, author=user.id)
    reader = await _user(db, "ro")
    await _grant(client, user, doc, reader, False)

    body = (await client.get(f"/api/files/{doc}/versions", headers=_auth(user))).json()
    assert body["kind"] == "document" and body["can_edit"] is True
    assert body["versions"][0]["id"] == str(vid) and body["versions"][0]["authors"] == [{"id": str(user.id), "username": user.username}]

    r = await client.patch(f"/api/files/{doc}/versions/{vid}", json={"label": "Sent to Sam", "keep_forever": True},
                           headers=_auth(user))
    assert r.status_code == 200 and r.json()["label"] == "Sent to Sam" and r.json()["keep_forever"] is True

    assert (await client.get(f"/api/files/{doc}/versions", headers=_auth(reader))).json()["can_edit"] is False
    assert (await client.patch(f"/api/files/{doc}/versions/{vid}", json={"label": "x"}, headers=_auth(reader))).status_code == 403
    assert (await client.post(f"/api/files/{doc}/versions/{vid}/restore", headers=_auth(reader))).status_code == 403
    stranger = await _user(db, "st")
    assert (await client.get(f"/api/files/{doc}/versions", headers=_auth(stranger))).status_code == 404


@pytest.mark.asyncio
async def test_restoring_a_document_replaces_its_state_and_keeps_what_was_there(client, db, user, collab):  # noqa: F811
    from app.files.models import DocumentState, FileVersion, UserFile

    doc = await _doc(client, user, "The launch is in May.")
    vid = await _snapshot(db, doc)
    await _set_doc(db, doc, "The launch is in June, with fireworks.")
    collab["live"]["state"] = _doc_state("The launch is in June, with fireworks and cake.")  # newer than stored

    # The diff: restoring brings back May and drops June.
    d = (await client.get(f"/api/files/{doc}/versions/{vid}/diff", headers=_auth(user))).json()
    assert d["kind"] == "document" and d["added"] == 1 and d["removed"] == 1
    assert {"op": "del", "text": "The launch is in May."} in d["lines"]

    r = await client.post(f"/api/files/{doc}/versions/{vid}/restore", headers=_auth(user))
    assert r.status_code == 200 and r.json()["epoch"] == 1
    assert collab["calls"] == [("reset", doc), ("release", doc)]
    db.expire_all()
    await db.refresh(user)
    ds = await db.get(DocumentState, uuid.UUID(doc))
    from app.files.document_render import extract_text_from_html, render_html_from_update

    assert "in May" in extract_text_from_html(render_html_from_update(ds.yjs_update))
    row = await db.get(UserFile, uuid.UUID(doc))
    assert row.collab_epoch == 1 and "in May" in (row.content_text or "")
    before = (await db.execute(
        select(FileVersion).where(FileVersion.file_id == row.id, FileVersion.source == "restore")
    )).scalars().one()
    assert before.label.startswith("Before restoring the version from")
    assert "cake" in extract_text_from_html(render_html_from_update(zlib.decompress(before.yjs_state)))

    # The token carries the new generation; a stale editor's Save is refused.
    tok = (await client.post(f"/api/files/{doc}/collab-token", headers=_auth(user))).json()
    assert tok["epoch"] == 1
    from jose import jwt

    assert jwt.get_unverified_claims(tok["token"])["epoch"] == 1
    stale = await client.post(f"/api/documents/{doc}/save", headers=_auth(user),
                              json={"html": "<p>old</p>", "epoch": 0})
    assert stale.status_code == 409 and "restored" in stale.json()["detail"]
    ok = await client.post(f"/api/documents/{doc}/save", headers=_auth(user), json={"html": "<p>fine</p>", "epoch": 1})
    assert ok.status_code == 200


@pytest.mark.asyncio
async def test_a_sheet_restore_brings_back_the_workbook_and_shows_changed_cells(client, db, user, collab):  # noqa: F811
    from app.files.models import UserFile
    from app.files.office import content_for_shell

    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Budget"}, headers=_auth(user))
    sid = r.json()["id"]
    row = await db.get(UserFile, uuid.UUID(sid))
    sheet = await content_for_shell(db, row)
    v1 = [{"name": "Q1", "celldata": [{"r": 0, "c": 0, "v": {"v": "Rent"}}, {"r": 0, "c": 1, "v": {"v": 900}}],
           "config": {"merge": {"0_0": {"r": 0, "c": 0, "rs": 1, "cs": 2}}}}]
    sheet.data, sheet.yjs_update = v1, b"\x00\x00"
    await db.commit()
    vid = await _snapshot(db, sid)
    sheet = await content_for_shell(db, await db.get(UserFile, uuid.UUID(sid), populate_existing=True))
    sheet.data = [{"name": "Q1", "celldata": [{"r": 0, "c": 0, "v": {"v": "Rent"}}, {"r": 0, "c": 1, "v": {"v": 950}},
                                              {"r": 3, "c": 2, "v": {"v": "new"}}]},
                  {"name": "Q2", "celldata": []}]
    await db.commit()

    d = (await client.get(f"/api/files/{sid}/versions/{vid}/diff", headers=_auth(user))).json()
    assert d["kind"] == "sheet" and d["changed"] == 2 and d["tabs_added"] == ["Q2"]
    assert {"tab": "Q1", "ref": "B1", "before": "900", "after": "950"} in d["cells"]

    r = await client.post(f"/api/files/{sid}/versions/{vid}/restore", headers=_auth(user))
    assert r.status_code == 200, r.text
    db.expire_all()
    row = await db.get(UserFile, uuid.UUID(sid))
    sheet = await content_for_shell(db, row)
    assert sheet.data == v1  # merges and all
    assert sheet.data_version >= 1 and row.collab_epoch == 1
    assert collab["calls"][0] == ("reset", f"sheet:{sheet.id}")


@pytest.mark.asyncio
async def test_a_whiteboard_diff_counts_shapes_and_a_failed_pause_changes_nothing(client, db, user, monkeypatch):  # noqa: F811
    from app import collab_internal
    from app.files.models import UserFile
    from app.files.office import content_for_shell
    from app.files.office_templates import scene_to_yjs

    r = await client.post("/api/files/office", json={"kind": "whiteboard", "title": "Garden"}, headers=_auth(user))
    bid = r.json()["id"]
    shed = {"id": "shed", "type": "rectangle", "x": 0, "y": 0, "width": 100, "height": 50, "version": 1}
    pond = {"id": "pond", "type": "ellipse", "x": 200, "y": 0, "width": 60, "height": 60, "version": 1}
    board = await content_for_shell(db, await db.get(UserFile, uuid.UUID(bid)))
    board.yjs_update = scene_to_yjs([shed, pond])
    await db.commit()
    vid = await _snapshot(db, bid)
    board = await content_for_shell(db, await db.get(UserFile, uuid.UUID(bid), populate_existing=True))
    note = {"id": "note", "type": "text", "x": 0, "y": 100, "width": 80, "height": 20, "text": "Plant roses", "version": 1}
    board.yjs_update = scene_to_yjs([{**shed, "width": 140}, note])
    await db.commit()

    d = (await client.get(f"/api/files/{bid}/versions/{vid}/diff", headers=_auth(user))).json()
    assert d["counts"] == {"added": 1, "removed": 1, "changed": 1}
    assert d["added"] == ["text: Plant roses"] and d["removed"] == ["ellipse"]

    async def down(room):
        raise RuntimeError("collab is down")

    monkeypatch.setattr(collab_internal, "reset_room", down)
    r = await client.post(f"/api/files/{bid}/versions/{vid}/restore", headers=_auth(user))
    assert r.status_code == 503 and "try again" in r.json()["detail"]
    db.expire_all()
    assert (await db.get(UserFile, uuid.UUID(bid))).collab_epoch == 0


@pytest.mark.asyncio
async def test_versions_count_toward_storage_only_from_the_switch_over_date(client, db, user):  # noqa: F811
    from datetime import datetime, timedelta, timezone

    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.files.quota import get_quota

    doc = await _doc(client, user, "x" * 3000)
    await _snapshot(db, doc, label="kept")
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.versions_quota_from = datetime.now(timezone.utc) + timedelta(days=30)
    await db.commit()
    free = await get_quota(db, user)
    assert free.versions_bytes > 0 and free.versions_counted is False
    row.versions_quota_from = datetime.now(timezone.utc) - timedelta(days=1)
    await db.commit()
    counted = await get_quota(db, user)
    assert counted.versions_counted is True
    assert counted.used_bytes == free.used_bytes + free.versions_bytes
    body = (await client.get("/api/files/storage", headers=_auth(user))).json()
    assert body["versions_counted"] is True and body["versions_bytes"] == free.versions_bytes
