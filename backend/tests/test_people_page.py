"""The person page (one person from a Contacts entry, a Photos person or a
Promptly account) and the people picker — and that nobody else's private
things leak into either."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.test_calendar import H, client, mk_user, people, pushes  # noqa: F401
from tests.test_rooms import make_space

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _quiet_background(monkeypatch):
    import app.background as bg
    import app.rooms.router as r

    monkeypatch.setattr(bg, "spawn", lambda coro, name=None: coro.close())
    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


def _when(days: int, hours: int = 0) -> str:
    t = (datetime.now(UTC) + timedelta(days=days, hours=hours)).replace(minute=0, second=0, microsecond=0)
    return t.isoformat().replace("+00:00", "Z")


async def _event(client, u, title, guests=(), days=3):
    r = await client.post("/api/calendar/events", headers=H(u), json={
        "title": title, "start": _when(days), "end": _when(days, 1), "guests": [str(g.id) for g in guests],
    })
    assert r.status_code == 201, r.text
    return r.json()["event"]


@pytest.fixture
async def book(db, people):
    """ann's Contacts: bob as "Bea" (by email), linked to a Photos person she
    calls "Wife", and someone not on Promptly."""
    from app.items import service as items

    ann, bob, cat = people
    cfile, _ = await items.create_item(db, ann, "contacts", installed_check=False, data={
        "contacts": [
            {"id": "w", "first": "Bea", "last": "Smith", "birthday": "--05-04",
             "emails": [{"label": "home", "value": bob.email.upper()}], "phones": [{"label": "mobile", "value": "+44 7700 900123"}]},
            {"id": "y", "first": "Grandma", "last": "Joan"},
        ],
    })
    pid = (await db.execute(
        text("INSERT INTO photo_people (user_id, kind, name, contact_file_id, contact_id) VALUES (:u, 'person', 'Bea', :f, 'w') RETURNING id"),
        {"u": ann.id, "f": cfile.id},
    )).scalar_one()
    await db.execute(text("INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind) VALUES (:u, :p, 'Wife', 'spouse')"), {"u": ann.id, "p": pid})
    await db.commit()
    return cfile.id, pid


async def test_three_addresses_one_person(client, people, book):
    ann, bob, _ = people
    fid, pid = book
    pages = [
        (await client.get(f"/api/people/u/{bob.id}", headers=H(ann))).json(),
        (await client.get(f"/api/people/c/{fid}/w", headers=H(ann))).json(),
        (await client.get(f"/api/people/p/{pid}", headers=H(ann))).json(),
    ]
    for p in pages:
        assert p["name"] == "Bea Smith" and p["label"] == "Wife" and p["match"] == "email"
        assert p["user"]["id"] == str(bob.id) and p["photo_person_id"] == str(pid)
        assert p["contact"]["file_id"] == str(fid) and p["contact"]["contact_id"] == "w"
        assert p["contact"]["birthday"] == "--05-04" and p["contact"]["phones"][0]["value"] == "+44 7700 900123"
        assert p["contact"]["can_edit"] is True and p["is_me"] is False
        assert p["photos"] == {"person_id": str(pid), "count": 0, "items": []}
    # Someone in Contacts who isn't on Promptly: just the card.
    joan = (await client.get(f"/api/people/c/{fid}/y", headers=H(ann))).json()
    assert joan["user"] is None and joan["events"] == [] and joan["rooms"] == [] and joan["contact"]["name"] == "Grandma Joan"
    # Yourself.
    me = (await client.get(f"/api/people/u/{ann.id}", headers=H(ann))).json()
    assert me["is_me"] and me["dm_room_id"] is None and me["files"] == []


async def test_someone_elses_contacts_and_photos_are_404(client, people, book):
    ann, bob, cat = people
    fid, pid = book
    assert (await client.get(f"/api/people/c/{fid}/w", headers=H(cat))).status_code == 404
    assert (await client.get(f"/api/people/p/{pid}", headers=H(cat))).status_code == 404
    assert (await client.get(f"/api/people/c/{fid}/nope", headers=H(ann))).status_code == 404
    assert (await client.get(f"/api/people/u/{uuid.uuid4()}", headers=H(ann))).status_code == 404
    # cat looking at bob sees an account — none of ann's card, face or label.
    p = (await client.get(f"/api/people/u/{bob.id}", headers=H(cat))).json()
    assert p["name"] == bob.username and p["contact"] is None and p["label"] is None
    assert p["face"] is None and p["photo_person_id"] is None and "email" not in p["user"]


async def test_events_rooms_and_files_only_what_you_share(client, db, people, pushes):
    from app.files.models import ResourceGrant
    from app.items import service as items

    ann, bob, cat = people
    dan = await mk_user(db, "dan")
    await _event(client, ann, "Dinner with Bob", guests=[bob])
    await _event(client, bob, "Bob's party", guests=[ann, cat])
    await _event(client, bob, "Bob and Cat, private", guests=[cat])
    await _event(client, ann, "Ann alone")
    declined = await _event(client, ann, "Declined", guests=[bob])
    r = await client.post(f"/api/calendar/events/{declined['event_id']}/rsvp", headers=H(bob), json={"status": "declined"})
    assert r.status_code == 200, r.text
    # Rooms: a space with ann+bob; a space bob+cat only; DMs.
    await make_space(client, ann, bob, name="Family")
    await make_space(client, bob, cat, name="Secret")
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()["id"]
    await client.post("/api/rooms/dms", headers=H(bob), json={"user_ids": [str(cat.id)]})
    # Files: ann → bob, bob → ann, bob → cat.
    f1, _ = await items.create_item(db, ann, "contacts", installed_check=False, data={"contacts": []})
    f2, _ = await items.create_item(db, bob, "contacts", installed_check=False, data={"contacts": []})
    f3, _ = await items.create_item(db, dan, "contacts", installed_check=False, data={"contacts": []})
    db.add(ResourceGrant(resource_type="file", resource_id=f1.id, grantee_user_id=bob.id, granted_by_user_id=ann.id))
    db.add(ResourceGrant(resource_type="file", resource_id=f2.id, grantee_user_id=ann.id, granted_by_user_id=bob.id))
    db.add(ResourceGrant(resource_type="file", resource_id=f3.id, grantee_user_id=cat.id, granted_by_user_id=dan.id))
    db.add(ResourceGrant(resource_type="file", resource_id=f3.id, grantee_user_id=bob.id, granted_by_user_id=dan.id))
    await db.commit()

    p = (await client.get(f"/api/people/u/{bob.id}", headers=H(ann))).json()
    assert {e["title"] for e in p["events"]} == {"Dinner with Bob", "Bob's party"}
    assert p["dm_room_id"] == dm
    assert [r["space"] for r in p["rooms"]] == ["Family"]
    assert "body" not in str(p["rooms"]) and "preview" not in str(p["rooms"])
    assert {(f["id"], f["direction"]) for f in p["files"]} == {(str(f1.id), "mine"), (str(f2.id), "theirs")}
    # cat sees bob: their party, their space, their DM — nothing of ann's dinner.
    p = (await client.get(f"/api/people/u/{bob.id}", headers=H(cat))).json()
    assert {e["title"] for e in p["events"]} == {"Bob's party", "Bob and Cat, private"}
    assert [r["space"] for r in p["rooms"]] == ["Secret"] and p["dm_room_id"] is not None and p["files"] == []
    # dan shares with nobody here except by file; no rooms, no events.
    p = (await client.get(f"/api/people/u/{bob.id}", headers=H(dan))).json()
    assert p["events"] == [] and p["rooms"] == [] and p["dm_room_id"] is None
    assert [f["direction"] for f in p["files"]] == ["mine"]


async def test_search_suggests_contacts_first_and_never_emails(client, db, people, book):
    ann, bob, cat = people
    off = await mk_user(db, "offline")
    off.disabled = True
    await db.commit()
    blank = (await client.get("/api/people/search", headers=H(ann))).json()["people"]
    assert blank[0]["user"]["id"] == str(bob.id) and blank[0]["name"] == "Bea Smith" and blank[0]["label"] == "Wife"
    assert all(p["user"] for p in blank)  # suggestions are pickable
    # By label, by contact name, by username — one row for bob.
    for q in ("wife", "bea", bob.username[:5]):
        got = (await client.get("/api/people/search", headers=H(ann), params={"q": q})).json()["people"]
        assert [p["user"]["id"] for p in got if p["user"]].count(str(bob.id)) == 1, q
        assert got[0]["user"]["id"] == str(bob.id) and got[0]["label"] == "Wife"
    # Not on Promptly: shown when searching, unpickable.
    got = (await client.get("/api/people/search", headers=H(ann), params={"q": "grandma"})).json()["people"]
    assert got[0]["user"] is None and got[0]["name"] == "Grandma Joan"
    # Disabled accounts and emails never show; cat doesn't see ann's labels.
    got = (await client.get("/api/people/search", headers=H(ann), params={"q": "offline"})).json()["people"]
    assert got == []
    got = (await client.get("/api/people/search", headers=H(cat), params={"q": bob.username})).json()["people"]
    assert got[0]["name"] == bob.username and got[0]["label"] is None and got[0]["face"] is None
    assert "@example.com" not in str(got)


async def test_search_details_fill_from_own_contact_card(client, db, people, book):
    """``details=true`` (item apps' person fields): the viewer's own contact
    card's first phone / email / address — never anyone else's."""
    ann, bob, cat = people
    plain = (await client.get("/api/people/search", headers=H(ann), params={"q": "bea"})).json()["people"]
    assert set(plain[0]["contact"]) == {"file_id", "contact_id"}  # unchanged without the flag
    got = (await client.get("/api/people/search", headers=H(ann), params={"q": "bea", "details": "true"})).json()["people"]
    c = got[0]["contact"]
    assert got[0]["user"]["id"] == str(bob.id) and c["contact_id"] == "w"
    assert c["phone"] == "+44 7700 900123" and c["email"] == bob.email.upper() and c["address"] == "" and c["company"] == ""
    joan = (await client.get("/api/people/search", headers=H(ann), params={"q": "grandma", "details": "1"})).json()["people"]
    assert joan[0]["user"] is None and joan[0]["contact"]["contact_id"] == "y" and joan[0]["contact"]["phone"] == ""
    # cat has no contacts: an account row carries no contact, so no email.
    theirs = (await client.get("/api/people/search", headers=H(cat), params={"q": bob.username, "details": "true"})).json()["people"]
    assert theirs[0]["contact"] is None and "@example.com" not in str(theirs).lower()


async def test_calendar_people_suggestions_still_work(client, people, book):
    ann, bob, _ = people
    r = await client.get("/api/calendar/people-suggestions", headers=H(ann))
    assert r.status_code == 200, r.text
    assert [(p["user"]["id"], p["contact_name"], p["label"]) for p in r.json()["people"]] == [(str(bob.id), "Bea Smith", "Wife")]
