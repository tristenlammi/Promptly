"""Recent (Today's "pick up where you left off") and Places.

Recents: opens are per person (isolation), capped (the oldest fall off),
debounced, filed under a file's real kind, and on read anything the viewer
can no longer open — or that's gone — drops out (and its row goes).

Places: trip stops, photo places, event locations and contact addresses,
grouped by town through the offline gazetteer, each person seeing only
their own (and what's shared with them).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text

from tests.test_calendar import H, client, mk_user, pushes  # noqa: F401

UTC = timezone.utc


async def _chat(db, u, title: str = "Plans"):
    from app.chat.models import Conversation

    c = Conversation(user_id=u.id, title=title)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return c


async def _dm(db, a, b):
    from app.rooms.models import Room, RoomMember

    room = Room(kind="dm", name="", last_seq=0)
    db.add(room)
    await db.flush()
    db.add_all([RoomMember(room_id=room.id, user_id=a.id), RoomMember(room_id=room.id, user_id=b.id)])
    await db.commit()
    return room


async def _item(client, u, kind: str) -> str:  # noqa: F811
    assert (await client.post(f"/api/items/store/{kind}", headers=H(u))).status_code == 200
    r = await client.post("/api/items", headers=H(u), json={"kind": kind})
    assert r.status_code in (200, 201), r.text
    return r.json()["file_id"]


async def _open(client, u, kind: str, id_) -> None:  # noqa: F811
    r = await client.post("/api/today/recents", headers=H(u), json={"kind": kind, "id": str(id_)})
    assert r.status_code == 204, r.text


async def _recents(client, u, limit: int = 50) -> list[dict]:  # noqa: F811
    r = await client.get(f"/api/today/recents?limit={limit}", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _rows(db, u) -> int:
    from app.today.models import RecentOpen

    uid = u if isinstance(u, uuid.UUID) else u.id
    return (await db.execute(select(func.count()).select_from(RecentOpen).where(RecentOpen.user_id == uid))).scalar_one()


# ------------------------------------------------------------------ recents


async def test_recents_isolation_kinds_and_clear(client, db):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    chat = await _chat(db, ann, "Holiday ideas")
    room = await _dm(db, ann, bob)
    fid = await _item(client, ann, "tasks")

    await _open(client, ann, "chat", chat.id)
    await _open(client, ann, "room", room.id)
    await _open(client, ann, "file", fid)  # filed under its real kind
    got = await _recents(client, ann)
    assert [g["kind"] for g in got] == ["item", "room", "chat"]  # newest first
    assert got[0]["url"] == f"/apps/tasks/{fid}"
    assert got[1]["title"] == bob.username and got[1]["url"] == f"/rooms/r/{room.id}"
    assert got[2]["title"] == "Holiday ideas" and got[2]["url"] == f"/chat/{chat.id}"

    # Bob never sees Ann's opens, and can't record her chat or her app file.
    assert await _recents(client, bob) == []
    await _open(client, bob, "chat", chat.id)
    await _open(client, bob, "file", fid)
    assert await _rows(db, bob) == 0
    # He can record the room they share — only in his own list.
    await _open(client, bob, "room", room.id)
    assert [g["title"] for g in await _recents(client, bob)] == [ann.username]
    assert len(await _recents(client, ann)) == 3

    # Titles are refreshed on read.
    chat.title = "Japan trip"
    await db.commit()
    assert {g["title"] for g in await _recents(client, ann)} >= {"Japan trip"}

    # Forget one, then clear everything (only mine).
    r = await client.delete(f"/api/today/recents/chat/{chat.id}", headers=H(ann))
    assert r.status_code == 204
    assert [g["kind"] for g in await _recents(client, ann)] == ["item", "room"]
    assert (await client.delete("/api/today/recents", headers=H(ann))).status_code == 204
    assert await _recents(client, ann) == []
    assert await _rows(db, bob) == 1


async def test_recents_cap_and_debounce(client, db):  # noqa: F811
    from app.today import recents
    from app.today.models import RecentOpen

    ann = await mk_user(db, "ann")
    aid = ann.id
    base = datetime.now(UTC) - timedelta(hours=2)
    ids = [uuid.uuid4() for _ in range(recents.CAP + 7)]
    for i, eid in enumerate(ids):
        await recents.touch(db, ann.id, "chat", eid, f"chat {i}", now=base + timedelta(minutes=i))
        await db.commit()
    assert await _rows(db, ann) == recents.CAP
    kept = set((await db.execute(select(RecentOpen.entity_id).where(RecentOpen.user_id == ann.id))).scalars())
    assert kept == set(ids[7:])  # the oldest seven fell off

    # A second open within the debounce window doesn't move it; later does.
    chat = await _chat(db, ann)
    cid = chat.id
    await _open(client, ann, "chat", cid)
    first = (await db.execute(select(RecentOpen.opened_at).where(RecentOpen.entity_id == cid))).scalar_one()
    await _open(client, ann, "chat", cid)
    db.expire_all()
    again = (await db.execute(select(RecentOpen.opened_at).where(RecentOpen.entity_id == cid))).scalar_one()
    assert again == first
    later = datetime.now(UTC) + recents.DEBOUNCE + timedelta(seconds=1)
    await recents.touch(db, aid, "chat", cid, "Plans", now=later)
    await db.commit()
    db.expire_all()
    moved = (await db.execute(select(RecentOpen.opened_at).where(RecentOpen.entity_id == cid))).scalar_one()
    assert moved > first
    assert await _rows(db, aid) == recents.CAP


async def test_recents_drop_inaccessible_and_deleted(client, db):  # noqa: F811
    from app.files.models import UserFile
    from app.rooms.models import RoomMember
    from app.today.models import RecentOpen

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    aid = ann.id
    room = await _dm(db, ann, bob)
    gone_chat = await _chat(db, ann, "Delete me")
    kept_chat = await _chat(db, ann, "Keep me")
    fid = await _item(client, ann, "tasks")
    for kind, eid in (("room", room.id), ("chat", gone_chat.id), ("file", fid), ("chat", kept_chat.id)):
        await _open(client, ann, kind, eid)
    assert len(await _recents(client, ann)) == 4

    # She leaves the room, the chat is deleted, the app file is trashed.
    await db.execute(RoomMember.__table__.delete().where(RoomMember.room_id == room.id, RoomMember.user_id == ann.id))
    await db.delete(gone_chat)
    row = await db.get(UserFile, uuid.UUID(fid))
    row.trashed_at = datetime.now(UTC)
    await db.commit()

    got = await _recents(client, ann)
    assert [g["title"] for g in got] == ["Keep me"]
    # …and their rows are gone, not just hidden.
    db.expire_all()
    left = list((await db.execute(select(RecentOpen.kind).where(RecentOpen.user_id == aid))).scalars())
    assert left == ["chat"]


async def test_office_open_records_server_side(client, db):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    r = await client.post("/api/files/office", headers=H(ann), json={"kind": "sheet", "title": "Budget 2027"})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert (await client.get(f"/api/files/{fid}/office", headers=H(ann))).status_code == 200
    got = await _recents(client, ann)
    assert got and got[0]["kind"] == "sheet" and got[0]["title"] == "Budget 2027"
    assert got[0]["url"] == f"/files/sheet/{fid}"
    # Bob can't open it: the editor 404s and his post records nothing.
    assert (await client.get(f"/api/files/{fid}/office", headers=H(bob))).status_code == 404
    await _open(client, bob, "file", fid)
    assert await _recents(client, bob) == [] and await _rows(db, bob) == 0


# ------------------------------------------------------------------ places


async def _gazetteer(db) -> None:
    await db.execute(text("INSERT INTO geo_countries (code, name) VALUES ('JP', 'Japan'), ('GB', 'United Kingdom')"))
    await db.execute(text("INSERT INTO geo_admin1 (code, name) VALUES ('GB.ENG', 'England'), ('JP.22', 'Kyoto')"))
    await db.execute(
        text(
            "INSERT INTO geo_places (geonameid, name, ascii_name, lat, lon, feature_code, country, admin1, population) VALUES "
            "(1857910, 'Kyoto', 'Kyoto', 35.02107, 135.75385, 'PPLA', 'JP', '22', 1459640), "
            "(2644688, 'Leeds', 'Leeds', 53.79648, -1.54785, 'PPLA2', 'GB', 'ENG', 455123), "
            "(9999001, 'Home', 'Home', 47.0, -122.0, 'PPL', 'US', 'WA', 900)"
        )
    )
    await db.commit()


async def _set_trips(db, fid: str, trips: list[dict]) -> None:
    from app.items.models import ItemDocument

    doc = await db.get(ItemDocument, uuid.UUID(fid))
    doc.data = {**(doc.data or {}), "trips": trips}
    await db.commit()


async def test_places_grouped_and_private(client, db, pushes):  # noqa: F811
    await _gazetteer(db)
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")

    tfid = await _item(client, ann, "trip")
    await _set_trips(db, tfid, [{
        "id": "t1", "title": "Japan", "emoji": "", "start": "2027-04-01", "end": "2027-04-10",
        "destinations": [{"id": "d1", "name": "Kyoto", "country": "Japan", "lat": 35.0116, "lng": 135.7681}],
    }])
    cfid = await _item(client, ann, "contacts")
    r = await client.post(f"/api/items/{cfid}/actions/add_contacts", headers=H(ann), json={"args": {"contacts": [
        {"first": "Lee", "last": "Dunn", "addresses": [{"street": "1 Park Row", "city": "Leeds", "country": "UK"}]},
    ]}})
    assert r.status_code == 200, r.text
    ev = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "Gig", "start": "2026-12-01T19:00:00Z", "end": "2026-12-01T22:00:00Z", "location": "Brudenell, 33 Queen's Rd, Leeds",
    })
    assert ev.status_code == 201, ev.text
    home = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "Chill", "start": "2026-12-02T19:00:00Z", "end": "2026-12-02T22:00:00Z", "location": "Home",
    })
    assert home.status_code == 201
    await client.post("/api/calendar/events", headers=H(bob), json={
        "title": "Bob's secret", "start": "2026-12-01T19:00:00Z", "end": "2026-12-01T20:00:00Z", "location": "Kyoto",
    })

    r = await client.get("/api/places", headers=H(ann))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["gazetteer"] is True
    by = {p["name"]: p for p in body["places"]}
    assert by["Leeds"]["counts"]["event"] == 1 and by["Leeds"]["counts"]["contact"] == 1
    assert by["Leeds"]["lat"] == 53.79648
    srcs = {i["source"]: i for i in by["Leeds"]["items"]}
    assert srcs["contact"]["url"].startswith(f"/apps/contacts/{cfid}?c=")
    assert srcs["event"]["url"].startswith("/calendar?event=")
    assert by["Kyoto"]["counts"]["trip"] == 1 and by["Kyoto"]["items"][0]["url"] == f"/apps/trip/{tfid}"
    assert all(i["title"] != "Bob's secret" for p in body["places"] for i in p["items"])
    # "Home" is a kind of place, not Home, Washington: listed, no pin.
    assert by["Home"]["lat"] is None and by["Home"]["counts"]["event"] == 1

    # Bob sees his own event (in Kyoto) and none of Ann's things.
    rb = (await client.get("/api/places", headers=H(bob))).json()
    names = {p["name"]: p for p in rb["places"]}
    assert set(names) == {"Kyoto"} and names["Kyoto"]["counts"] == {"trip": 0, "photos": 0, "event": 1, "contact": 0}


async def test_places_without_gazetteer_lists_text(client, db, pushes):  # noqa: F811
    ann = await mk_user(db, "ann")
    r = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "Lunch", "start": "2026-12-01T12:00:00Z", "end": "2026-12-01T13:00:00Z", "location": "Cafe Luna",
    })
    assert r.status_code == 201
    body = (await client.get("/api/places", headers=H(ann))).json()
    assert body["gazetteer"] is False
    assert [(p["name"], p["lat"]) for p in body["places"]] == [("Cafe Luna", None)]


def test_hidden_nav_accepts_places():
    from app.auth.schemas import UserPreferencesUpdate

    assert UserPreferencesUpdate(hidden_nav=["places", "bogus", "today"]).hidden_nav == ["places", "today"]
