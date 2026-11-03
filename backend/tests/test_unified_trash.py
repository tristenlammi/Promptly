"""One trash across apps: restore, delete forever, 30-day purge and
cross-user isolation for Drive files, workspace items, calendar events,
tasks, contacts and albums."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select, update

from tests.test_photo_albums_wp94 import _photo


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


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    import app.notifications.dispatch as dispatch

    async def notify_user(**kw):
        return None

    monkeypatch.setattr(dispatch, "notify_user", notify_user)


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user", settings={"timezone": "UTC"})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def trash(client, u) -> list[dict]:
    r = await client.get("/api/trash", headers=H(u))
    assert r.status_code == 200, r.text
    assert r.json()["retention_days"] == 30
    return r.json()["items"]


async def act(client, u, verb, *refs):
    r = await client.post(f"/api/trash/{verb}", headers=H(u), json={"items": list(refs)})
    assert r.status_code == 200, r.text
    return r.json()


def ref(it: dict) -> dict:
    out = {"type": it["type"], "id": it["id"]}
    if it.get("workspace_id"):
        out["workspace_id"] = it["workspace_id"]
    return out


async def _event(client, u, **kw):
    body = {"title": "Dinner", "start": "2026-11-07T18:00:00Z", "end": "2026-11-07T20:00:00Z", **kw}
    r = await client.post("/api/calendar/events", headers=H(u), json=body)
    assert r.status_code == 201, r.text
    return r.json()["event"]["event_id"]


async def _items_file(client, u, kind: str) -> str:
    assert (await client.post(f"/api/items/store/{kind}", headers=H(u))).status_code == 200
    r = await client.post("/api/items", headers=H(u), json={"kind": kind, "title": f"My {kind}"})
    assert r.status_code == 201, r.text
    return r.json()["file_id"]


async def _action(client, u, fid, name, args):
    r = await client.post(f"/api/items/{fid}/actions/{name}", headers=H(u), json={"args": args})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ calendar


async def test_calendar_event_delete_restore_and_isolation(client, db):
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    eid = await _event(client, ann, guests=[str(bob.id)], description="Bring wine")
    assert (await client.delete(f"/api/calendar/events/{eid}", headers=H(ann))).status_code == 204
    assert (await client.get(f"/api/calendar/events/{eid}", headers=H(ann))).status_code == 404

    items = await trash(client, ann)
    [it] = [i for i in items if i["kind"] == "calendar_event"]
    assert it["app"] == "calendar" and it["title"] == "Dinner" and it["location"] == "My calendar"
    # Bob was a guest, not the owner: nothing in his trash, and he can't act on Ann's.
    assert await trash(client, bob) == []
    res = await act(client, bob, "restore", ref(it))
    assert res["done"] == 0 and not res["results"][0]["ok"]
    res = await act(client, bob, "purge", ref(it))
    assert res["done"] == 0

    res = await act(client, ann, "restore", ref(it))
    assert res["done"] == 1 and res["results"][0]["location"] == "My calendar"
    got = await client.get(f"/api/calendar/events/{eid}", headers=H(ann))
    assert got.status_code == 200, got.text
    ev = got.json()["event"]
    assert ev["description"] == "Bring wine"
    # Bob's invite came back with it.
    assert (await client.get(f"/api/calendar/events/{eid}", headers=H(bob))).status_code == 200
    assert [i for i in await trash(client, ann) if i["kind"] == "calendar_event"] == []


async def test_event_undo_by_its_own_id_and_restore_into_own_calendar_when_its_calendar_is_gone(client, db):
    from app.calendars.models import CalCalendar, CalMember

    ann = await mk_user(db, "ann")
    cal = CalCalendar(name="Family", personal=False, owner_id=None)
    db.add(cal)
    await db.flush()
    db.add(CalMember(calendar_id=cal.id, user_id=ann.id, role="owner"))
    await db.commit()
    eid = await _event(client, ann, calendar_id=str(cal.id))
    await client.delete(f"/api/calendar/events/{eid}", headers=H(ann))
    # The calendar goes too.
    await client.delete(f"/api/calendar/calendars/{cal.id}", headers=H(ann))

    # An app's Undo only knows the event id.
    res = await act(client, ann, "restore", {"type": "calendar_event", "id": eid})
    assert res["done"] == 1 and res["results"][0]["location"] == "My calendar"
    ev = (await client.get(f"/api/calendar/events/{eid}", headers=H(ann))).json()["event"]
    assert ev["calendar_id"] != str(cal.id)


# ------------------------------------------------------------------ tasks & contacts


async def test_tasks_deleted_in_the_app_restore_into_the_file(client, db):
    ann = await mk_user(db, "ann")
    fid = await _items_file(client, ann, "tasks")
    out = await _action(client, ann, fid, "add_tasks", {"tasks": [{"title": "Water plants", "list": "Home"}, {"title": "Pay rent"}]})
    data = out["data"]
    water = next(t for t in data["tasks"] if t["title"] == "Water plants")

    # The app deletes client-side: a save without the task.
    cur = (await client.get(f"/api/items/{fid}", headers=H(ann))).json()
    data = cur["data"]
    data["tasks"] = [t for t in data["tasks"] if t["id"] != water["id"]]
    r = await client.put(f"/api/items/{fid}", headers=H(ann), json={"data": data, "base_revision": cur["revision"]})
    assert r.status_code == 200, r.text
    [it] = [i for i in await trash(client, ann) if i["kind"] == "task"]
    assert it["title"] == "Water plants" and it["app"] == "tasks" and it["location"].endswith("· Home")

    # Its list is gone by the time it's restored: it lands in the Inbox.
    await _action(client, ann, fid, "manage_list", {"op": "delete", "list": "Home"})
    res = await act(client, ann, "restore", ref(it))
    assert res["done"] == 1, res
    tasks = (await client.get(f"/api/items/{fid}", headers=H(ann))).json()["data"]["tasks"]
    back = next(t for t in tasks if t["id"] == water["id"])
    assert back["list_id"] == "inbox"
    assert [i for i in await trash(client, ann) if i["kind"] == "task"] == []

    # The app's own Undo (the task saved back) takes it out of the trash.
    await _action(client, ann, fid, "delete_tasks", {"tasks": [water["id"]]})
    assert len([i for i in await trash(client, ann) if i["kind"] == "task"]) == 1
    cur = (await client.get(f"/api/items/{fid}", headers=H(ann))).json()
    cur["data"]["tasks"].append(back)
    r = await client.put(f"/api/items/{fid}", headers=H(ann), json={"data": cur["data"], "base_revision": cur["revision"]})
    assert r.status_code == 200, r.text
    assert [i for i in await trash(client, ann) if i["kind"] == "task"] == []


async def test_contacts_delete_restore_and_delete_forever(client, db):
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    fid = await _items_file(client, ann, "contacts")
    out = await _action(client, ann, fid, "add_contacts", {"contacts": [{"full_name": "Grace Hopper"}, {"full_name": "Alan Turing"}]})
    grace = next(c for c in out["data"]["contacts"] if c["first"] == "Grace")
    alan = next(c for c in out["data"]["contacts"] if c["first"] == "Alan")
    await _action(client, ann, fid, "delete_contact", {"contact_ids": [grace["id"], alan["id"]]})

    items = [i for i in await trash(client, ann) if i["kind"] == "contact"]
    assert {i["title"] for i in items} == {"Grace Hopper", "Alan Turing"}
    assert await trash(client, bob) == []
    g = next(i for i in items if i["title"] == "Grace Hopper")
    a = next(i for i in items if i["title"] == "Alan Turing")
    assert (await act(client, ann, "restore", ref(g)))["done"] == 1
    names = [c["first"] for c in (await client.get(f"/api/items/{fid}", headers=H(ann))).json()["data"]["contacts"]]
    assert names == ["Grace"]

    # Delete forever.
    assert (await act(client, ann, "purge", ref(a)))["done"] == 1
    assert [i for i in await trash(client, ann) if i["kind"] == "contact"] == []
    assert (await act(client, ann, "restore", ref(a)))["done"] == 0


# ------------------------------------------------------------------ albums


async def test_album_delete_and_restore_keeps_its_photos(client, db):
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    a = await _photo(db, ann, "beach.jpg", 3)
    r = await client.post("/api/photos/albums", json={"title": "Holiday", "file_ids": [a]}, headers=H(ann))
    album_id = r.json()["id"]
    assert (await client.delete(f"/api/photos/albums/{album_id}", headers=H(ann))).status_code == 204
    [it] = [i for i in await trash(client, ann) if i["kind"] == "album"]
    assert it["app"] == "photos"
    assert [i for i in await trash(client, bob) if i["kind"] == "album"] == []
    assert (await act(client, ann, "restore", ref(it)))["done"] == 1
    r = await client.get(f"/api/photos/albums/{album_id}/items", headers=H(ann))
    assert r.status_code == 200 and [x["filename"] for x in r.json()["items"]] == ["beach.jpg"]


# ------------------------------------------------------------------ drive & workspaces


async def test_drive_and_workspace_items_show_and_restore(client, db):
    from app.chat.models import WorkspaceItem
    from app.files.models import UserFile

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    f = UserFile(user_id=ann.id, filename="notes.txt", original_filename="notes.txt", mime_type="text/plain",
                 size_bytes=1, storage_path=f"u/{uuid.uuid4()}", trashed_at=datetime.now(timezone.utc))
    db.add(f)
    await db.commit()
    r = await client.post("/api/workspaces", json={"title": "Team"}, headers=H(ann))
    ws_id = r.json()["id"]
    r = await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "container", "title": "Folder"}, headers=H(ann))
    assert r.status_code == 201, r.text
    folder = r.json()
    r = await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "note", "title": "Inner", "parent_id": folder["id"]}, headers=H(ann))
    inner = r.json()
    assert (await client.delete(f"/api/workspaces/{ws_id}/items/{inner['id']}", headers=H(ann))).status_code == 204
    # Its parent goes later, for good.
    assert (await client.delete(f"/api/workspaces/{ws_id}/items/{folder['id']}", headers=H(ann))).status_code == 204

    items = await trash(client, ann)
    drive = [i for i in items if i["type"] == "file"]
    assert [i["title"] for i in drive] == ["notes.txt"] and drive[0]["app"] == "drive"
    ws_items = {i["title"]: i for i in items if i["type"] == "workspace_item"}
    assert set(ws_items) == {"Folder"} and ws_items["Folder"]["count"] == 1 and ws_items["Folder"]["location"] == "Team"
    assert await trash(client, bob) == []
    assert (await act(client, bob, "restore", ref(drive[0])))["done"] == 0

    res = await act(client, ann, "restore", ref(drive[0]))
    assert res["done"] == 1 and res["results"][0]["location"] == "My files"
    await db.refresh(f)
    assert f.trashed_at is None

    # Purge the parent folder; then the inner item (trashed on its own,
    # earlier) would have no parent — but it went with the subtree.
    assert (await act(client, ann, "purge", ref(ws_items["Folder"])))["done"] == 1
    assert await db.scalar(select(WorkspaceItem.id).where(WorkspaceItem.id == uuid.UUID(inner["id"]))) is None


async def test_workspace_item_restored_to_top_level_when_its_parent_is_gone(client, db):
    from app.chat.models import WorkspaceItem

    ann = await mk_user(db, "ann")
    ws_id = (await client.post("/api/workspaces", json={"title": "Team"}, headers=H(ann))).json()["id"]
    folder = (await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "container", "title": "Folder"}, headers=H(ann))).json()
    child = (await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "note", "title": "Child", "parent_id": folder["id"]}, headers=H(ann))).json()
    await client.delete(f"/api/workspaces/{ws_id}/items/{child['id']}", headers=H(ann))
    # Move the child out of its parent's subtree on paper is not possible;
    # instead trash the parent separately later, then restore only the child.
    await db.execute(update(WorkspaceItem).where(WorkspaceItem.id == uuid.UUID(folder["id"])).values(trashed_at=datetime.now(timezone.utc) + timedelta(seconds=1)))
    await db.commit()
    items = await trash(client, ann)
    assert {i["title"] for i in items if i["type"] == "workspace_item"} == {"Folder"}
    # Restore the child directly (by id) — its parent is still trashed.
    res = await act(client, ann, "restore", {"type": "workspace_item", "id": child["id"], "workspace_id": ws_id})
    assert res["done"] == 1
    row = await db.get(WorkspaceItem, uuid.UUID(child["id"]))
    await db.refresh(row)
    assert row.trashed_at is None and row.parent_id is None


# ------------------------------------------------------------------ retention


async def test_everything_is_purged_after_30_days(client, db):
    from app.chat.models import WorkspaceItem
    from app.files.models import UserFile
    from app.tasks.maintenance import run_storage_maintenance
    from app.trash.models import TrashEntry

    ann = await mk_user(db, "ann")
    old = datetime.now(timezone.utc) - timedelta(days=31)
    recent = datetime.now(timezone.utc) - timedelta(days=29)

    # Calendar events: one old, one recent.
    e1 = await _event(client, ann, title="Old")
    e2 = await _event(client, ann, title="Recent")
    await client.delete(f"/api/calendar/events/{e1}", headers=H(ann))
    await client.delete(f"/api/calendar/events/{e2}", headers=H(ann))
    await db.execute(update(TrashEntry).where(TrashEntry.source_id == e1).values(deleted_at=old))
    await db.execute(update(TrashEntry).where(TrashEntry.source_id == e2).values(deleted_at=recent))
    # A Drive file 31 days in the trash.
    f = UserFile(user_id=ann.id, filename="old.txt", original_filename="old.txt", mime_type="text/plain",
                 size_bytes=1, storage_path=f"u/{uuid.uuid4()}", trashed_at=old)
    db.add(f)
    # A workspace item nobody has looked at since.
    ws_id = (await client.post("/api/workspaces", json={"title": "Team"}, headers=H(ann))).json()["id"]
    it = (await client.post(f"/api/workspaces/{ws_id}/items", json={"kind": "container", "title": "Stale"}, headers=H(ann))).json()
    await client.delete(f"/api/workspaces/{ws_id}/items/{it['id']}", headers=H(ann))
    await db.execute(update(WorkspaceItem).where(WorkspaceItem.id == uuid.UUID(it["id"])).values(trashed_at=old))
    await db.commit()

    out = await run_storage_maintenance()
    assert out["trash_entries_purged"] == 1
    assert out["workspace_items_purged"] == 1
    assert out["trash_purged"] >= 1

    titles = {i["title"] for i in await trash(client, ann)}
    assert titles == {"Recent"}
    assert await db.scalar(select(UserFile.id).where(UserFile.id == f.id)) is None
    assert await db.scalar(select(WorkspaceItem.id).where(WorkspaceItem.id == uuid.UUID(it["id"]))) is None


async def test_empty_trash_clears_everything_but_not_other_peoples(client, db):
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    await client.delete(f"/api/calendar/events/{await _event(client, ann)}", headers=H(ann))
    await client.delete(f"/api/calendar/events/{await _event(client, bob)}", headers=H(bob))
    fid = await _items_file(client, ann, "tasks")
    out = await _action(client, ann, fid, "add_tasks", {"tasks": [{"title": "One"}]})
    await _action(client, ann, fid, "delete_tasks", {"tasks": [out["data"]["tasks"][0]["id"]]})
    assert len(await trash(client, ann)) == 2

    r = await client.delete("/api/trash", headers=H(ann))
    assert r.status_code == 200 and r.json()["deleted"] == 2
    assert await trash(client, ann) == []
    assert len(await trash(client, bob)) == 1
