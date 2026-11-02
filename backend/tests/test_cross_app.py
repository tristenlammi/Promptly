"""Across apps: "Send to…" cards in Rooms (and who may see them), the trip
album, Budget spending tagged to a trip, and the grocery list → Tasks."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text

from tests.test_photo_engine_ph4 import _scene
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    import app.crossapp.router as r
    import app.rooms.router as rr

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())
    monkeypatch.setattr(rr, "spawn", lambda coro, name=None: coro.close())


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}", password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def mk_item(db, user, kind: str, data: dict | None = None):
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


async def space(client, owner, *members):
    r = await client.post("/api/rooms/spaces", headers=_auth(owner), json={"name": "Family", "emoji": "🏡"})
    assert r.status_code == 201, r.text
    sid, rid = r.json()["id"], r.json()["room_id"]
    if members:
        r = await client.post(f"/api/rooms/spaces/{sid}/members", headers=_auth(owner), json={"user_ids": [str(m.id) for m in members]})
        assert r.status_code == 200, r.text
    return rid


async def card(client, u, mid):
    r = await client.get(f"/api/crossapp/share/card/{mid}", headers=_auth(u))
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ share cards


@pytest.mark.asyncio
async def test_share_card_needs_access_and_grant_lets_the_room_in(client, db, user):
    bob, cat = await mk_user(db, "bob"), await mk_user(db, "cat")
    room = await space(client, user, bob)
    fid = await mk_file(db, user)

    r = await client.post("/api/crossapp/share", headers=_auth(user), json={"room_id": room, "kind": "file", "id": str(fid), "note": "Our plan"})
    assert r.status_code == 201, r.text
    msg = r.json()["message"]
    assert msg["body"] == "Our plan" and msg["meta"]["share"] == {"kind": "file", "id": str(fid), "label": "a file", "has_note": True}
    assert r.json()["granted"] is None
    # The message itself never carries the name.
    assert "plan.pdf" not in str(msg)

    mine = await card(client, user, msg["id"])
    assert mine["card"]["title"] == "plan.pdf" and mine["card"]["subtitle"].startswith("PDF") and mine["can_grant"]
    # Bob is in the room but can't open the file: a neutral card.
    theirs = await card(client, bob, msg["id"])
    assert theirs["card"] is None and theirs["label"] == "a file" and not theirs["can_grant"]
    # Cat isn't in the room at all.
    assert (await client.get(f"/api/crossapp/share/card/{msg['id']}", headers=_auth(cat))).status_code == 404

    # Sending something you can't open yourself is a 404 (nothing probeable).
    other = await mk_file(db, cat, "secret.pdf")
    r = await client.post("/api/crossapp/share", headers=_auth(user), json={"room_id": room, "kind": "file", "id": str(other)})
    assert r.status_code == 404
    # …and so is a room you're not in.
    r = await client.post("/api/crossapp/share", headers=_auth(cat), json={"room_id": room, "kind": "file", "id": str(other)})
    assert r.status_code == 404

    # "Also give everyone in the room access": a view-only Drive share.
    r = await client.post("/api/crossapp/share", headers=_auth(user), json={"room_id": room, "kind": "file", "id": str(fid), "grant": True})
    assert r.status_code == 201 and r.json()["granted"] == {"granted": 1, "already": 0, "skipped": 0}
    assert r.json()["message"]["body"] == "Shared a file"
    assert (await card(client, bob, msg["id"]))["card"]["title"] == "plan.pdf"
    from app.files.models import ResourceGrant

    g = (await db.execute(select(ResourceGrant).where(ResourceGrant.resource_id == fid))).scalar_one()
    assert g.grantee_user_id == bob.id and not g.can_edit
    # Bob can't let others into Ann's file.
    r = await client.post("/api/crossapp/share", headers=_auth(bob), json={"room_id": room, "kind": "file", "id": str(fid), "grant": True})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_item_cards_task_trip_recipe_and_album(client, db, user):
    bob = await mk_user(db, "bob")
    room = await space(client, user, bob)
    tasks = await mk_item(db, user, "tasks", {"tasks": [{"id": "t1", "title": "Book the vet", "due": "2026-11-20"}]})
    trip = await mk_item(db, user, "trip", {"trips": [{"id": "bali", "title": "Bali", "emoji": "🌴", "start": "2027-03-01", "end": "2027-03-08",
                                                     "destinations": [{"id": "d1", "name": "Ubud"}]}]})
    plan = await mk_item(db, user, "mealplan", {"recipes": [{"id": "r1", "title": "Tacos", "servings": 4, "total_min": 30}]})

    async def send(kind, id_, file_id=None, **kw):
        r = await client.post("/api/crossapp/share", headers=_auth(user), json={"room_id": room, "kind": kind, "id": id_, "file_id": file_id, **kw})
        return r

    r = await send("task", "t1", str(tasks))
    assert r.status_code == 201, r.text
    c = (await card(client, user, r.json()["message"]["id"]))
    assert c["card"]["title"] == "Book the vet" and "due 20 Nov" in c["card"]["subtitle"] and c["card"]["href"] == f"/apps/tasks/{tasks}"
    assert not c["can_grant"]  # a task lives in your whole Tasks file
    assert (await card(client, bob, r.json()["message"]["id"]))["card"] is None
    # Asking to let the room in to a task is refused (it'd share every task).
    assert (await send("task", "t1", str(tasks), grant=True)).status_code == 403
    # A missing id or a mismatched kind is a 404.
    assert (await send("task", "nope", str(tasks))).status_code == 404
    assert (await send("trip", "t1", str(tasks))).status_code == 404
    assert (await send("task", "t1")).status_code == 400

    r = await send("trip", "bali", str(trip))
    c = (await card(client, user, r.json()["message"]["id"]))["card"]
    assert c["title"] == "Bali" and c["emoji"] == "🌴" and "Ubud" in c["subtitle"]
    r = await send("recipe", "r1", str(plan))
    c = (await card(client, user, r.json()["message"]["id"]))["card"]
    assert c["title"] == "Tacos" and c["subtitle"] == "Recipe · 30 min · serves 4"

    # When the Tasks file is shared with Bob, he sees the task card.
    from app.files.models import ResourceGrant

    db.add(ResourceGrant(resource_type="file", resource_id=tasks, grantee_user_id=bob.id, granted_by_user_id=user.id))
    await db.commit()
    msgs = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=_auth(bob))).json()["messages"]
    first = next(m for m in msgs if (m["meta"].get("share") or {}).get("kind") == "task")
    assert (await card(client, bob, first["id"]))["card"]["title"] == "Book the vet"

    # An album: members only, and "let the room in" adds them as viewers.
    r = await client.post("/api/photos/albums", headers=_auth(user), json={"title": "Beach"})
    aid = r.json()["id"]
    r = await send("album", aid)
    mid = r.json()["message"]["id"]
    assert (await card(client, user, mid))["card"]["subtitle"] == "Album · 0 photos"
    assert (await card(client, bob, mid))["card"] is None
    r = await send("album", aid, grant=True)
    assert r.json()["granted"]["granted"] == 1
    assert (await card(client, bob, mid))["card"]["title"] == "Beach"

    # A deleted message has no card.
    await client.delete(f"/api/rooms/messages/{mid}", headers=_auth(user))
    assert (await client.get(f"/api/crossapp/share/card/{mid}", headers=_auth(user))).status_code == 404


# ------------------------------------------------------------------ trip album


@pytest.mark.asyncio
async def test_trip_album_holds_my_photos_from_the_trip(client, db, user, root):
    inside = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=datetime(2024, 3, 2, 12, tzinfo=timezone.utc))
    outside = await _scene(db, user, who=[], lat=0.5, lon=0.5, when=datetime(2024, 4, 10, 12, tzinfo=timezone.utc))
    trip = await mk_item(db, user, "trip", {"trips": [
        {"id": "bali", "title": "Bali", "emoji": "🌴", "start": "2024-03-01", "end": "2024-03-05"},
        {"id": "someday", "title": "Someday"},
    ]})
    base = f"/api/crossapp/trip/{trip}/bali/album"
    got = (await client.get(base, headers=_auth(user))).json()
    assert got == {"album": None, "photos": [], "can_make": True}
    assert (await client.post(f"/api/crossapp/trip/{trip}/someday/album", headers=_auth(user))).status_code == 400

    r = await client.post(base, headers=_auth(user))
    assert r.status_code == 200, r.text
    made = r.json()
    assert made["album"]["title"] == "🌴 Bali" and made["album"]["count"] == 1
    assert [p["id"] for p in made["photos"]] == [str(inside)]
    data = (await client.get(f"/api/items/{trip}", headers=_auth(user))).json()["data"]
    assert data["trips"][0]["photo_albums"] == {str(user.id): made["album"]["id"]}

    # The trip's dates grow: pressing it again moves the album, no second album.
    from app.items import service as items

    row, doc, _ = await items.load(db, user, trip, need="edit", lock=True)
    d = dict(doc.data)
    d["trips"] = [dict(t) for t in d["trips"]]
    d["trips"][0]["end"] = "2024-04-30"
    await items.save_data(db, user, row, doc, d, base_revision=None)
    await db.commit()
    again = (await client.post(base, headers=_auth(user))).json()
    assert again["album"]["id"] == made["album"]["id"] and again["album"]["count"] == 2
    assert {p["id"] for p in again["photos"]} == {str(inside), str(outside)}
    n = await db.scalar(text("SELECT count(*) FROM albums WHERE owner_id = :u"), {"u": user.id})
    assert n == 1

    # Someone else can't make an album on a trip they can't open.
    bob = await mk_user(db, "bob")
    assert (await client.post(base, headers=_auth(bob))).status_code == 404


# ------------------------------------------------------------------ budget tags


@pytest.mark.asyncio
async def test_budget_spending_tagged_to_a_trip(client, db, user):
    trip = await mk_item(db, user, "trip", {"trips": [
        {"id": "tokyo", "title": "Tokyo", "home_currency": "JPY", "start": "2026-05-01", "end": "2026-05-03",
         "currencies": [{"code": "AUD", "per_home": 0.01}]},
        {"id": "home", "title": "Melbourne", "home_currency": "AUD", "start": "2026-06-01", "end": "2026-06-02"},
    ]})
    base = f"/api/crossapp/trip/{trip}/tokyo/spending"
    assert (await client.get(base, headers=_auth(user))).json()["has_budget"] is False

    budget = await mk_item(db, user, "budget", {"settings": {"currency": "AUD"}, "transactions": [
        {"id": "a", "date": "2026-05-01", "amount_cents": -5000, "payee": "Ramen"},
        {"id": "b", "date": "2026-05-02", "amount_cents": -2500, "payee": "Train"},
        {"id": "c", "date": "2026-05-02", "amount_cents": -9900, "transfer": True},
        {"id": "d", "date": "2026-05-09", "amount_cents": -1000, "payee": "Later"},
        {"id": "e", "date": "2026-05-02", "amount_cents": 100000, "payee": "Pay"},
    ]})
    got = (await client.get(base, headers=_auth(user))).json()
    assert got["has_budget"] and got["count"] == 0 and got["untagged"] == 2 and got["spent_minor"] == 0

    trips = (await client.get("/api/crossapp/budget/trips", headers=_auth(user))).json()
    assert [t["title"] for t in trips] == ["Melbourne", "Tokyo"] and trips[1]["ref"] == f"{trip}:tokyo"

    r = await client.post(f"{base}/tag", headers=_auth(user))
    assert r.status_code == 200, r.text
    got = r.json()
    # $75 at 0.01 AUD per yen = ¥7,500; converted into the trip's currency.
    assert got["tagged_now"] == 2 and got["count"] == 2 and got["untagged"] == 0
    assert got["spent_minor"] == 7500 and got["currency"] == "JPY" and got["converted"] and got["budget_cents"] == 7500
    data = (await client.get(f"/api/items/{budget}", headers=_auth(user))).json()["data"]
    refs = {t["id"]: t.get("trip_ref") for t in data["transactions"]}
    assert refs == {"a": f"{trip}:tokyo", "b": f"{trip}:tokyo", "c": None, "d": None, "e": None}
    # A refund tagged by hand takes off what was spent; same currency, no conversion.
    from app.items import service as items

    row, doc, _ = await items.load(db, user, budget, need="edit", lock=True)
    d = dict(doc.data)
    d["transactions"] = [*d["transactions"], {"id": "f", "date": "2026-06-01", "amount_cents": -3000, "trip_ref": f"{trip}:home"},
                         {"id": "g", "date": "2026-06-02", "amount_cents": 1000, "trip_ref": f"{trip}:home"}]
    await items.save_data(db, user, row, doc, d, base_revision=None)
    await db.commit()
    home = (await client.get(f"/api/crossapp/trip/{trip}/home/spending", headers=_auth(user))).json()
    assert home["spent_minor"] == 2000 and home["currency"] == "AUD" and not home["converted"] and home["count"] == 2


# ------------------------------------------------------------------ groceries → tasks


@pytest.mark.asyncio
async def test_grocery_list_to_tasks_is_one_list_updated_in_place(client, db, user):
    def item(i, name, aisle, qty=None, unit="", checked=False, key=None):
        return {"id": i, "name": name, "key": key or name.lower(), "aisle": aisle, "checked": checked, "source": "plan",
                "amounts": [{"qty": qty, "unit": unit}] if qty else [], "recipes": ["Tacos"]}

    plan = await mk_item(db, user, "mealplan", {"grocery": {"start": "2026-11-02", "end": "2026-11-08", "items": [
        item("1", "Milk", "dairy", 2, "l"),
        item("2", "Limes", "produce", 3),
        item("3", "Tortillas", "bakery", 1, "pack"),
        item("4", "Salsa", "condiments", checked=True),
    ]}})
    url = f"/api/crossapp/mealplan/{plan}/to-tasks"
    r = await client.post(url, headers=_auth(user))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["added"] == 3 and out["open"] == 3
    tid = out["tasks_file_id"]
    data = (await client.get(f"/api/items/{tid}", headers=_auth(user))).json()["data"]
    lst = [x for x in data["lists"] if x["id"] == out["list_id"]]
    assert len(lst) == 1 and lst[0]["name"] == "Groceries"
    mine = sorted((t for t in data["tasks"] if t["list_id"] == out["list_id"]), key=lambda t: t["order"])
    # In aisle order: produce, bakery, dairy.
    assert [t["title"].split(" (")[0] for t in mine] == ["Limes", "Tortillas", "Milk"]
    assert mine[0]["notes"].startswith("Produce") and "for Tacos" in mine[0]["notes"]

    # A task the person added to the list by hand.
    from app.items import service as items

    row, doc, _ = await items.load(db, user, uuid.UUID(tid), need="edit", lock=True)
    d = dict(doc.data)
    d["tasks"] = [*d["tasks"], {"id": "mine1", "title": "Coffee", "list_id": out["list_id"]}]
    await items.save_data(db, user, row, doc, d, base_revision=None)
    # The grocery list changes: more milk, limes ticked, tortillas gone, eggs new.
    mrow, mdoc, _ = await items.load(db, user, plan, need="edit", lock=True)
    md = dict(mdoc.data)
    md["grocery"] = {**md["grocery"], "items": [
        item("1", "Milk", "dairy", 3, "l"), item("2", "Limes", "produce", 3, checked=True), item("5", "Eggs", "dairy", 12),
    ]}
    await items.save_data(db, user, mrow, mdoc, md, base_revision=None)
    await db.commit()

    again = (await client.post(url, headers=_auth(user))).json()
    assert again["tasks_file_id"] == tid and again["list_id"] == out["list_id"]
    assert (again["added"], again["updated"], again["done"], again["removed"]) == (1, 1, 1, 1)
    data = (await client.get(f"/api/items/{tid}", headers=_auth(user))).json()["data"]
    assert sum(1 for x in data["lists"] if x["name"] == "Groceries") == 1
    by_title = {t["title"].split(" (")[0]: t for t in data["tasks"] if t["list_id"] == out["list_id"]}
    assert set(by_title) == {"Milk", "Eggs", "Limes", "Coffee"}
    assert by_title["Limes"]["done"] and "3" in by_title["Milk"]["title"]

    # The Groceries tab runs it as the meal plan's own action (pending edits land first).
    r = await client.post(f"/api/items/{plan}/actions/send_grocery_list_to_tasks", headers=_auth(user), json={})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["list_id"] == out["list_id"] and r.json()["summary"].startswith("3 to buy in Tasks")
    # A read-only action: the meal plan itself doesn't change.
    assert r.json()["revision"] == (await client.get(f"/api/items/{plan}", headers=_auth(user))).json()["revision"]

    # Nothing left to buy: refused politely.
    md = dict(md)
    md["grocery"] = {**md["grocery"], "items": [item("2", "Limes", "produce", checked=True)]}
    mrow, mdoc, _ = await items.load(db, user, plan, need="edit", lock=True)
    await items.save_data(db, user, mrow, mdoc, md, base_revision=None)
    await db.commit()
    assert (await client.post(url, headers=_auth(user))).status_code == 400
