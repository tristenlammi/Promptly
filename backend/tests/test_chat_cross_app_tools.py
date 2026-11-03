"""Main chat across the apps: my_day, find_person, search_apps, read_room and
post_to_room — what they return, and that they never show one person
another's data (events, tasks, bills, contacts, rooms)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from tests.test_calendar import H, client, mk_user, pushes  # noqa: F401

UTC = timezone.utc
LON = ZoneInfo("Europe/London")


@pytest.fixture(autouse=True)
def _quiet_rooms(monkeypatch):
    """Posting spawns push fan-out (and @promptly); not wanted here."""
    import app.rooms.router as r

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


def _today() -> date:
    return datetime.now(LON).date()


def _ctx(db, u, turn: dict | None = None):
    from app.chat.tools.base import ToolContext

    return ToolContext(db=db, user=u, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={} if turn is None else turn)


def _at(day: date, hh: int) -> str:
    return datetime.combine(day, time(hh, 0), tzinfo=LON).astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _event(client, u, title: str, day: date, hh: int = 12) -> dict:  # noqa: F811
    r = await client.post("/api/calendar/events", headers=H(u), json={"title": title, "start": _at(day, hh), "end": _at(day, hh + 1)})
    assert r.status_code == 201, r.text
    return r.json()["event"]


async def _file(db, u, kind: str, data: dict):
    from app.items import service as items

    row, _ = await items.create_item(db, u, kind, installed_check=False, data=data)
    await db.commit()
    return row


@pytest.fixture
async def trio(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


# ------------------------------------------------------------------ my_day


async def test_my_day_across_apps_and_private(client, db, trio, pushes):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.crossapp import MyDayTool

    ann, bob, cat = trio
    today = _today()
    tomorrow = today + timedelta(days=1)
    await _event(client, ann, "Standup", today, 9)
    await _event(client, ann, "Dentist", tomorrow, 15)
    await _event(client, bob, "Bob's secret meeting", today, 10)
    await _file(db, ann, "tasks", {"tasks": [
        {"id": "t1", "title": "Pay rent", "due": today.isoformat()},
        {"id": "t2", "title": "Old chore", "due": (today - timedelta(days=4)).isoformat()},
        {"id": "t3", "title": "Way later", "due": (today + timedelta(days=40)).isoformat()},
    ]})
    await _file(db, bob, "tasks", {"tasks": [{"id": "b1", "title": "Bob's private task", "due": today.isoformat()}]})
    budget = await _file(db, ann, "budget", {"settings": {"currency": "AUD"}, "subscriptions": [
        {"id": "s1", "name": "Netflix", "kind": "subscription", "cadence": "monthly", "amount_cents": 1999, "next_due": tomorrow.isoformat()},
        {"id": "s2", "name": "Old gym", "cadence": "monthly", "amount_cents": 5000, "next_due": tomorrow.isoformat(), "user_status": "cancelled"},
    ]})
    await _file(db, ann, "workout", {"planned": [{"id": "w1", "date": tomorrow.isoformat(), "time": "07:00", "name": "Push day"}]})
    await _file(db, ann, "trip", {"trips": [{"id": "jp", "title": "Japan", "start": (today + timedelta(days=20)).isoformat(),
                                             "end": (today + timedelta(days=30)).isoformat()}]})

    out = (await MyDayTool().run(_ctx(db, ann), {"start": today.isoformat(), "end": tomorrow.isoformat()})).content
    for want in ("Standup", "Dentist", "Pay rent", "OVERDUE", "Old chore", "Netflix", "Push day", "Japan", f"Budget {budget.id}"):
        assert want in out, (want, out)
    assert "Old gym" not in out and "Way later" not in out
    assert "Bob's secret meeting" not in out and "Bob's private task" not in out
    # The days are in order, with the dentist on tomorrow.
    assert out.index("Standup") < out.index("Dentist")

    bob_out = (await MyDayTool().run(_ctx(db, bob), {})).content
    assert "Bob's secret meeting" in bob_out and "Bob's private task" in bob_out
    assert "Standup" not in bob_out and "Netflix" not in bob_out and "Japan" not in bob_out
    cat_out = (await MyDayTool().run(_ctx(db, cat), {})).content
    assert "nothing planned" in cat_out and "Standup" not in cat_out and "none yet" in cat_out

    with pytest.raises(ToolError):
        await MyDayTool().run(_ctx(db, ann), {"start": today.isoformat(), "end": (today + timedelta(days=60)).isoformat()})
    with pytest.raises(ToolError):
        await MyDayTool().run(_ctx(db, ann), {"start": "not-a-date"})


# ------------------------------------------------------------------ find_person


async def test_find_person_reads_only_your_book(db, trio):
    from app.chat.tools.crossapp import FindPersonTool

    ann, bob, cat = trio
    cfile = await _file(db, ann, "contacts", {"contacts": [
        {"id": "w", "first": "Bea", "last": "Smith", "birthday": "--05-04",
         "emails": [{"label": "home", "value": bob.email}], "phones": [{"label": "mobile", "value": "+44 7700 900123"}]},
        {"id": "g", "first": "Grandma", "last": "Joan", "phones": [{"label": "home", "value": "01234 567890"}]},
    ]})
    pid = (await db.execute(
        text("INSERT INTO photo_people (user_id, kind, name, contact_file_id, contact_id) VALUES (:u, 'person', 'Bea', :f, 'w') RETURNING id"),
        {"u": ann.id, "f": cfile.id},
    )).scalar_one()
    await db.execute(text("INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind) VALUES (:u, :p, 'Wife', 'spouse')"), {"u": ann.id, "p": pid})
    await _file(db, cat, "contacts", {"contacts": [{"id": "x", "first": "Bea", "last": "Cat'sFriend", "phones": [{"value": "999 999"}]}]})
    await db.commit()

    out = (await FindPersonTool().run(_ctx(db, ann), {"name": "my wife"})).content
    assert "Bea Smith" in out and "Wife" in out and f"@{bob.username}" in out and "+44 7700 900123" in out
    assert "Cat'sFriend" not in out and "999 999" not in out
    gran = (await FindPersonTool().run(_ctx(db, ann), {"name": "grandma"})).content
    assert "Grandma Joan" in gran and "not on this Promptly" in gran

    # Bob finds no one of Ann's book; looking up Ann's account shows only her username.
    bob_out = (await FindPersonTool().run(_ctx(db, bob), {"name": "grandma"})).content
    assert "No one" in bob_out and "01234" not in bob_out
    acct = (await FindPersonTool().run(_ctx(db, bob), {"name": ann.username})).content
    assert f"@{ann.username}" in acct and ann.email not in acct and "Bea" not in acct


# ------------------------------------------------------------------ search_apps


async def test_search_apps_is_per_person(client, db, trio, pushes):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.crossapp import SearchAppsTool

    ann, bob, cat = trio
    await _event(client, ann, "Lasagne night", _today() + timedelta(days=2), 18)
    await _file(db, ann, "tasks", {"tasks": [{"id": "t", "title": "Buy lasagne sheets"}]})
    await _file(db, ann, "mealplan", {"recipes": [{"id": "r1", "title": "Mum's lasagne"}]})
    await _file(db, ann, "trip", {"trips": [{"id": "it", "title": "Italy", "destinations": []}]})
    await _file(db, bob, "tasks", {"tasks": [{"id": "b", "title": "Bob lasagne secret"}]})

    out = (await SearchAppsTool().run(_ctx(db, ann), {"query": "lasagne"})).content
    assert "event: Lasagne night" in out and "task: Buy lasagne sheets" in out and "recipe: Mum's lasagne" in out
    assert "Bob lasagne secret" not in out
    assert "trip: Italy" in (await SearchAppsTool().run(_ctx(db, ann), {"query": "ital"})).content
    cat_out = (await SearchAppsTool().run(_ctx(db, cat), {"query": "lasagne"})).content
    assert cat_out.startswith("Nothing")
    with pytest.raises(ToolError):
        await SearchAppsTool().run(_ctx(db, ann), {"query": "x"})


# ------------------------------------------------------------------ rooms


async def _space(client, owner, *members, name="Family"):  # noqa: F811
    r = await client.post("/api/rooms/spaces", headers=H(owner), json={"name": name, "emoji": "🏡"})
    assert r.status_code == 201, r.text
    sid, rid = r.json()["id"], r.json()["room_id"]
    if members:
        r = await client.post(f"/api/rooms/spaces/{sid}/members", headers=H(owner), json={"user_ids": [str(m.id) for m in members]})
        assert r.status_code == 200, r.text
    return sid, rid


async def test_rooms_read_respects_ai_switch_and_membership(client, db, trio):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.crossapp import ReadRoomTool, has_rooms

    ann, bob, cat = trio
    _sid, rid = await _space(client, ann, bob)
    r = await client.post(f"/api/rooms/rooms/{rid}/messages", headers=H(bob), json={"body": "the surprise party is Saturday"})
    assert r.status_code == 201, r.text
    assert await has_rooms(db, ann.id) and not await has_rooms(db, cat.id)

    listing = (await ReadRoomTool().run(_ctx(db, ann), {})).content
    assert "Family" in listing and "1 unread" in listing and rid in listing and "surprise" not in listing
    private = (await ReadRoomTool().run(_ctx(db, ann), {"room": "Family"})).content
    assert "private" in private and "surprise" not in private

    assert (await client.patch(f"/api/rooms/rooms/{rid}", headers=H(ann), json={"ai_context": True})).status_code == 200
    db.expire_all()  # the tool runs on a fresh session in the chat; here, re-read
    for u in trio:
        await db.refresh(u)
    readable = (await ReadRoomTool().run(_ctx(db, ann), {"room": "general"})).content
    assert "the surprise party is Saturday" in readable and bob.username in readable

    # Cat isn't in the space: the room doesn't exist for her.
    with pytest.raises(ToolError):
        await ReadRoomTool().run(_ctx(db, cat), {"room": rid})
    with pytest.raises(ToolError):
        await ReadRoomTool().run(_ctx(db, cat), {"room": "Family"})
    assert "isn't in any rooms" in (await ReadRoomTool().run(_ctx(db, cat), {})).content


async def test_post_to_room_and_dm_with_the_untrusted_guard(client, db, trio):  # noqa: F811
    from sqlalchemy import select

    from app.chat.tools.base import ToolError
    from app.chat.tools.crossapp import PostToRoomTool
    from app.rooms.models import Room, RoomMember, RoomMessage

    ann, bob, cat = trio
    _sid, rid = await _space(client, ann, bob)
    out = await PostToRoomTool().run(_ctx(db, ann), {"room": "Family", "message": "Dinner at 7"})
    assert "Sent in #general in Family" in out.content and out.meta["room_id"] == rid
    msgs = (await db.execute(select(RoomMessage).where(RoomMessage.room_id == uuid.UUID(rid)))).scalars().all()
    assert [(m.body, m.author_id) for m in msgs if m.kind == "user"] == [("Dinner at 7", ann.id)]

    # A DM to a username opens (or reuses) the conversation.
    dm = await PostToRoomTool().run(_ctx(db, ann), {"to": bob.username, "message": "Running late"})
    room = await db.get(Room, uuid.UUID(dm.meta["room_id"]))
    assert room.kind == "dm"
    members = {m.user_id for m in (await db.execute(select(RoomMember).where(RoomMember.room_id == room.id))).scalars()}
    assert members == {ann.id, bob.id}
    again = await PostToRoomTool().run(_ctx(db, ann), {"to": bob.username, "message": "Five minutes"})
    assert again.meta["room_id"] == dm.meta["room_id"]

    # Not on a turn that read outside content; not into a room you're not in.
    with pytest.raises(ToolError, match="outside content"):
        await PostToRoomTool().run(_ctx(db, ann, {"untrusted": True}), {"room": "Family", "message": "x"})
    with pytest.raises(ToolError):
        await PostToRoomTool().run(_ctx(db, cat), {"room": rid, "message": "let me in"})
    with pytest.raises(ToolError):
        await PostToRoomTool().run(_ctx(db, ann), {"to": "nobody-here-at-all", "message": "hi"})
    with pytest.raises(ToolError):
        await PostToRoomTool().run(_ctx(db, ann), {"message": "where?"})
    n = (await db.execute(select(RoomMessage).where(RoomMessage.body.in_(["x", "let me in"])))).scalars().all()
    assert n == []


# ------------------------------------------------------------------ routing


def test_routing_prompt_and_untrusted_marking():
    from app.chat.router import reads_outside_content
    from app.chat.tools.prompt import build_tools_system_prompt
    from app.chat.tools.registry import tools_in

    names = {t.name for t in tools_in({"apps", "rooms"})}
    assert names == {"my_day", "find_person", "search_apps", "read_room", "post_to_room"}
    p = build_tools_system_prompt({"apps", "calendar", "items", "rooms"})
    assert "`my_day`" in p and "in one step" in p and "forecast_month_end" in p and "read_room/post_to_room" in p
    # Only apps whose tools are offered are named.
    lean = build_tools_system_prompt({"apps", "calendar"})
    assert "use_item" not in lean and "search_photos" not in lean and "read_room" not in lean
    # Room messages are other people's words; the rest is the user's own.
    assert reads_outside_content("read_room")
    assert not reads_outside_content("my_day") and not reads_outside_content("post_to_room")
