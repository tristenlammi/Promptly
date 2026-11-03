"""Shared tags (#tags): one set per person across apps, app tags mirrored
from their files, rename / merge / delete written back, "everything with
tag X" filtered by access, the search box, and isolation between people."""
from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import select


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
def _quiet(monkeypatch):
    async def fake(**kw):
        return None

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user", settings={"timezone": "UTC"})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_item(db, user, kind: str, data: dict):
    from app.items import service as items

    await items.install(db, user, kind)
    row, _doc = await items.create_item(db, user, kind, data=data)
    await db.commit()
    return row.id


async def mk_file(db, user, name="plan.pdf"):
    from app.files.models import UserFile

    fid = uuid.uuid4()
    db.add(UserFile(id=fid, user_id=user.id, filename=name, original_filename=name, mime_type="application/pdf",
                    size_bytes=2048, storage_path=f"{user.id}/{fid}.pdf"))
    await db.commit()
    return fid


async def item_data(db, fid):
    from app.items.models import ItemDocument

    return (await db.execute(select(ItemDocument.data).where(ItemDocument.file_id == fid))).scalar_one()


async def tags_of(client, u):
    r = await client.get("/api/tags", headers=H(u))
    assert r.status_code == 200, r.text
    return {t["name"]: t for t in r.json()["tags"]}


TASKS = {"tasks": [
    {"id": "t1", "title": "Buy paint", "tags": ["Home", "errands"]},
    {"id": "t2", "title": "Call plumber", "tags": ["home"]},
]}
CONTACTS = {"contacts": [{"id": "c1", "first": "Ada", "last": "Lovelace", "tags": ["Home", "maths"]}]}


async def test_app_tags_are_mirrored_into_one_shared_set(client, db):
    ann = await mk_user(db, "ann")
    tasks = await mk_item(db, ann, "tasks", TASKS)
    contacts = await mk_item(db, ann, "contacts", CONTACTS)

    tags = await tags_of(client, ann)
    # "Home" and "home" are one tag; first spelling wins.
    assert set(tags) == {"Home", "errands", "maths"}
    assert tags["Home"]["count"] == 3

    r = await client.get(f"/api/tags/{tags['Home']['id']}/items", headers=H(ann))
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert {(i["kind"], i["title"]) for i in items} == {
        ("task", "Buy paint"), ("task", "Call plumber"), ("contact", "Ada Lovelace"),
    }
    assert any(i["url"] == f"/apps/contacts/{contacts}?c=c1" for i in items)

    # A save that drops a tag in the app drops it from the shared view.
    from app.auth.models import User
    from app.items import service as items_svc

    me = await db.get(User, ann.id)
    row, doc, _ = await items_svc.load(db, me, tasks, need="edit")
    data = dict(doc.data)
    data["tasks"] = [{**t, "tags": []} if t["id"] == "t2" else t for t in data["tasks"]]
    await items_svc.save_data(db, me, row, doc, data, base_revision=None)
    await db.commit()
    assert (await tags_of(client, ann))["Home"]["count"] == 2


async def test_native_tags_on_files_events_albums_and_autocomplete(client, db):
    ann = await mk_user(db, "ann")
    fid = await mk_file(db, ann)
    r = await client.post("/api/calendar/events", headers=H(ann),
                          json={"title": "Dinner", "start": "2026-11-07T18:00:00Z", "end": "2026-11-07T20:00:00Z"})
    assert r.status_code == 201, r.text
    ev = r.json()["event"]["event_id"]

    r = await client.put("/api/tags/entity", headers=H(ann), json={"kind": "file", "id": str(fid), "names": ["Trip", "#Paris"]})
    assert r.status_code == 200, r.text
    assert [t["name"] for t in r.json()["tags"]] == ["Paris", "Trip"]
    r = await client.post("/api/tags/assign", headers=H(ann), json={"name": "trip", "kind": "event", "id": ev})
    assert r.status_code == 200, r.text
    trip = r.json()["tag"]
    assert trip["name"] == "Trip"

    r = await client.get("/api/tags", headers=H(ann), params={"q": "tr"})
    assert [t["name"] for t in r.json()["tags"]] == ["Trip"]

    items = (await client.get(f"/api/tags/{trip['id']}/items", headers=H(ann))).json()["items"]
    assert {i["kind"] for i in items} == {"file", "event"}

    r = await client.get("/api/tags/entity", headers=H(ann), params={"kind": "event", "id": ev})
    assert [t["name"] for t in r.json()["tags"]] == ["Trip"]
    r = await client.post("/api/tags/unassign", headers=H(ann), json={"tag_id": trip["id"], "kind": "event", "id": ev})
    assert r.status_code == 204
    items = (await client.get(f"/api/tags/{trip['id']}/items", headers=H(ann))).json()["items"]
    assert [i["kind"] for i in items] == ["file"]

    # Trash the file: it drops out of the tag page.
    from app.files.models import UserFile
    from datetime import datetime, timezone

    f = await db.get(UserFile, fid)
    f.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    assert (await client.get(f"/api/tags/{trip['id']}/items", headers=H(ann))).json()["items"] == []


async def test_rename_merge_delete_write_back_into_apps(client, db):
    ann = await mk_user(db, "ann")
    tasks = await mk_item(db, ann, "tasks", TASKS)
    contacts = await mk_item(db, ann, "contacts", CONTACTS)
    fid = await mk_file(db, ann)
    tags = await tags_of(client, ann)
    await client.put("/api/tags/entity", headers=H(ann), json={"kind": "file", "id": str(fid), "names": ["maths"]})

    # Rename: the apps' files carry the new spelling.
    r = await client.patch(f"/api/tags/{tags['Home']['id']}", headers=H(ann), json={"name": "House", "color": "#ff0000"})
    assert r.status_code == 200, r.text
    assert r.json() == {"id": tags["Home"]["id"], "name": "House", "color": "#ff0000"}
    data = await item_data(db, tasks)
    assert [t["tags"] for t in data["tasks"]] == [["House", "errands"], ["House"]]
    assert (await item_data(db, contacts))["contacts"][0]["tags"] == ["House", "maths"]
    assert (await tags_of(client, ann))["House"]["count"] == 3

    # Renaming onto an existing name is a conflict (merge instead).
    r = await client.patch(f"/api/tags/{tags['errands']['id']}", headers=H(ann), json={"name": "MATHS"})
    assert r.status_code == 409

    # Merge maths → House: the contact keeps one House; the file moves over.
    r = await client.post(f"/api/tags/{tags['maths']['id']}/merge", headers=H(ann), json={"into": tags["Home"]["id"]})
    assert r.status_code == 200, r.text
    assert (await item_data(db, contacts))["contacts"][0]["tags"] == ["House"]
    now = await tags_of(client, ann)
    assert set(now) == {"House", "errands"}
    items = (await client.get(f"/api/tags/{now['House']['id']}/items", headers=H(ann))).json()["items"]
    assert {i["kind"] for i in items} == {"task", "contact", "file"}

    # Delete: gone from the apps too.
    assert (await client.delete(f"/api/tags/{now['House']['id']}", headers=H(ann))).status_code == 204
    data = await item_data(db, tasks)
    assert [t["tags"] for t in data["tasks"]] == [["errands"], []]
    assert set(await tags_of(client, ann)) == {"errands"}


async def test_assign_to_app_thing_edits_its_file(client, db):
    ann = await mk_user(db, "ann")
    tasks = await mk_item(db, ann, "tasks", TASKS)
    r = await client.post("/api/tags/assign", headers=H(ann), json={"name": "Urgent", "kind": "task", "id": f"{tasks}:t2"})
    assert r.status_code == 200, r.text
    assert (await item_data(db, tasks))["tasks"][1]["tags"] == ["home", "Urgent"]
    r = await client.get("/api/tags/entity", headers=H(ann), params={"kind": "task", "id": f"{tasks}:t2"})
    assert sorted(t["name"] for t in r.json()["tags"]) == ["Home", "Urgent"]
    # A thing that isn't in the file is a 404.
    r = await client.post("/api/tags/assign", headers=H(ann), json={"name": "x", "kind": "task", "id": f"{tasks}:nope"})
    assert r.status_code == 404


async def test_cross_user_isolation(client, db):
    from app.files.models import ResourceGrant

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    ann_tasks = await mk_item(db, ann, "tasks", TASKS)
    ann_file = await mk_file(db, ann, "secret.pdf")
    shared_file = await mk_file(db, ann, "shared.pdf")
    ann_tags = await tags_of(client, ann)
    await client.put("/api/tags/entity", headers=H(ann), json={"kind": "file", "id": str(ann_file), "names": ["Home"]})

    # Bob has his own set: none of Ann's tags, same name is a separate tag.
    assert await tags_of(client, bob) == {}
    r = await client.post("/api/tags", headers=H(bob), json={"name": "Home"})
    assert r.status_code == 201
    bob_home = r.json()
    assert bob_home["id"] != ann_tags["Home"]["id"]
    assert set(await tags_of(client, bob)) == {"Home"}
    assert (await tags_of(client, ann))["Home"]["count"] == 3

    # Ann's tag is invisible and untouchable to Bob.
    hid = ann_tags["Home"]["id"]
    assert (await client.get(f"/api/tags/{hid}", headers=H(bob))).status_code == 404
    assert (await client.get(f"/api/tags/{hid}/items", headers=H(bob))).status_code == 404
    assert (await client.patch(f"/api/tags/{hid}", headers=H(bob), json={"name": "x"})).status_code == 404
    assert (await client.delete(f"/api/tags/{hid}", headers=H(bob))).status_code == 404
    assert (await client.post(f"/api/tags/{bob_home['id']}/merge", headers=H(bob), json={"into": hid})).status_code == 404
    assert (await client.post("/api/tags/assign", headers=H(bob), json={"tag_id": hid, "kind": "file", "id": str(ann_file)})).status_code == 404

    # Bob can't tag (or read tags on) Ann's things he can't open.
    r = await client.put("/api/tags/entity", headers=H(bob), json={"kind": "file", "id": str(ann_file), "names": ["Mine"]})
    assert r.status_code == 404
    assert (await client.get("/api/tags/entity", headers=H(bob), params={"kind": "file", "id": str(ann_file)})).status_code == 404
    r = await client.post("/api/tags/assign", headers=H(bob), json={"name": "Mine", "kind": "task", "id": f"{ann_tasks}:t1"})
    assert r.status_code == 404
    assert (await item_data(db, ann_tasks))["tasks"][0]["tags"] == ["Home", "errands"]

    # Shared with Bob: he can tag it with his own tag; Ann doesn't see Bob's tag on it.
    db.add(ResourceGrant(resource_type="file", resource_id=shared_file, grantee_user_id=bob.id, granted_by_user_id=ann.id))
    await db.commit()
    r = await client.put("/api/tags/entity", headers=H(bob), json={"kind": "file", "id": str(shared_file), "names": ["Home"]})
    assert r.status_code == 200, r.text
    assert [t["id"] for t in r.json()["tags"]] == [bob_home["id"]]
    assert (await client.get("/api/tags/entity", headers=H(ann), params={"kind": "file", "id": str(shared_file)})).json()["tags"] == []
    items = (await client.get(f"/api/tags/{bob_home['id']}/items", headers=H(bob))).json()["items"]
    assert [i["title"] for i in items] == ["shared.pdf"]

    # Access revoked: it drops out of Bob's tag page.
    from sqlalchemy import delete

    await db.execute(delete(ResourceGrant).where(ResourceGrant.grantee_user_id == bob.id))
    await db.commit()
    assert (await client.get(f"/api/tags/{bob_home['id']}/items", headers=H(bob))).json()["items"] == []

    # Ann renaming her Home leaves Bob's alone.
    await client.patch(f"/api/tags/{hid}", headers=H(ann), json={"name": "House"})
    assert set(await tags_of(client, bob)) == {"Home"}

    # Search: each person only finds their own tags.
    r = await client.get("/api/today/search", headers=H(bob), params={"q": "hous"})
    assert r.status_code == 200, r.text
    assert r.json()["tags"] == []
    r = await client.get("/api/today/search", headers=H(ann), params={"q": "#hous"})
    assert [t["name"] for t in r.json()["tags"]] == ["House"]


async def test_search_finds_things_by_tag(client, db):
    ann = await mk_user(db, "ann")
    await mk_item(db, ann, "tasks", TASKS)
    await mk_item(db, ann, "contacts", CONTACTS)
    r = await client.post("/api/calendar/events", headers=H(ann),
                          json={"title": "Dinner", "start": "2026-11-07T18:00:00Z", "end": "2026-11-07T20:00:00Z"})
    ev = r.json()["event"]["event_id"]
    await client.post("/api/tags/assign", headers=H(ann), json={"name": "maths", "kind": "event", "id": ev})

    r = await client.get("/api/today/search", headers=H(ann), params={"q": "#maths"})
    body = r.json()
    assert [t["name"] for t in body["tags"]] == ["maths"]
    assert [c["name"] for c in body["contacts"]] == ["Ada Lovelace"]
    assert [e["title"] for e in body["events"]] == ["Dinner"]


async def test_bad_input(client, db):
    ann = await mk_user(db, "ann")
    assert (await client.post("/api/tags", headers=H(ann), json={"name": "  #  "})).status_code == 400
    assert (await client.post("/api/tags", headers=H(ann), json={"name": "x", "color": "red"})).status_code == 400
    r = await client.post("/api/tags", headers=H(ann), json={"name": "x"})
    assert (await client.post("/api/tags", headers=H(ann), json={"name": "X"})).status_code == 409
    r = await client.put("/api/tags/entity", headers=H(ann), json={"kind": "spaceship", "id": "1", "names": ["x"]})
    assert r.status_code == 400
