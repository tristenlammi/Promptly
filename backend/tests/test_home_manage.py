"""Promptly Home: who runs a home, and what happens when its owner goes.

Members use a home; its owner and the co-owners the owner picked set it up;
choosing co-owners, passing the home on and deleting it are the owner's
alone. A home is never left without an owner, and a box that leaves a home
forgets that home before anyone else sees anything on it."""
from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

from tests.test_home import LAMP, TEMP, _dial, _has_snapshot, _prepare, _turn_on, _wait, client  # noqa: F401
from tests.test_maps_timeline import _hdr, _other

HUE = {"id": "entry1", "brand": "hue", "brand_name": "Philips Hue", "title": "Hue bridge", "state": "loaded"}
TIDAL = {"id": "tidal--abc", "brand": "tidal", "name": "Tidal"}
LOUNGE = {"id": "lounge", "name": "Lounge"}


_BOXES: list["Box"] = []


@pytest.fixture(autouse=True)
async def _boxes_stop_answering():
    """A box's answering task ends with its test, stopped or not: one left
    waiting was thrown away with the test's event loop, and said so
    ("Event loop is closed") in the middle of some later test."""
    yield
    loop = asyncio.get_running_loop()
    mine = [box._run for box in _BOXES if box._run.get_loop() is loop]
    _BOXES.clear()
    for task in mine:
        task.cancel()
    await asyncio.gather(*mine, return_exceptions=True)


class Box:
    """A connected box that answers like a real one, and remembers what the
    home put on it (a brand, a linked music service, a room)."""

    def __init__(self, fake, task, *, entries=(), sources=(), areas=()) -> None:
        self.fake, self.task = fake, task
        self.entries, self.sources, self.areas = list(entries), list(sources), list(areas)
        self.asked: list[str] = []
        self.heard: list[str] = []
        self.refuse: set[str] = set()
        self._run = asyncio.create_task(self._answer())
        _BOXES.append(self)

    async def _answer(self) -> None:
        while True:
            msg = await self.fake.from_server.get()
            if msg.get("t") != "req":
                self.heard.append(msg.get("t"))
                continue
            op, args = msg["op"], msg.get("args") or {}
            self.asked.append(op)
            if op in self.refuse:
                await self.fake.say({"t": "res", "id": msg["id"], "ok": False, "error": "It wouldn't go."})
                continue
            data = None
            if op == "entries.list":
                data = list(self.entries)
            elif op == "entries.remove":
                self.entries = [e for e in self.entries if e["id"] != args.get("entry")]
            elif op == "music.status":
                data = {"brands": [{"id": "tidal", "name": "Tidal"}], "sources": list(self.sources), "speakers": []}
            elif op == "music.unlink":
                self.sources = [s for s in self.sources if s["id"] != args.get("source")]
            elif op == "areas.delete":
                self.areas = [a for a in self.areas if a["id"] != args.get("area")]
            elif op == "areas.create":
                data = {"id": "new", "name": args.get("name")}
            elif op in ("flows.found", "brands"):
                data = []
            elif op in ("flows.start", "flows.get", "flows.step"):
                data = {"type": "done"}
            elif op in ("music.link.start", "music.link.get"):
                data = {"state": "wait", "flow": "f1", "name": "Tidal"}
            await self.fake.say({"t": "res", "id": msg["id"], "ok": True, "data": data})

    async def snapshot(self, entities=(LAMP,)) -> None:
        await self.fake.say({"t": "snapshot", "areas": self.areas, "entities": list(entities)})

    async def stop(self) -> None:
        self._run.cancel()
        await self.fake.hang_up()
        await self.task


async def _box(prepared, **has) -> Box:
    fake, task = await _dial(prepared)
    return Box(fake, task, **has)


async def _home(client, admin, owner, **has):
    """A home ``owner`` owns, with one connected box that has ``has`` on it."""
    prepared = await _prepare(client, admin)
    home_id = (await client.post("/api/home/claim", headers=_hdr(owner), json={"code": prepared["claim_code"]})).json()["home_id"]
    box = await _box(prepared, **has)
    await box.snapshot()
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    return prepared, home_id, box


async def _add(client, owner, home_id, who, role="member") -> None:
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(owner), json={"username": who.username})).status_code == 200
    if role != "member":
        assert (await client.patch(f"/api/home/{home_id}/members/{who.id}", headers=_hdr(owner), json={"role": role})).status_code == 200


async def _row(db, box_id: str):
    from app.home.models import HomeBox

    return (await db.execute(select(HomeBox).where(HomeBox.id == uuid.UUID(box_id)).execution_options(populate_existing=True))).scalar_one()


async def _role(db, home_id: str, user_id) -> str | None:
    from app.home.models import HomeMember

    return (
        await db.execute(select(HomeMember.role).where(HomeMember.home_id == uuid.UUID(home_id), HomeMember.user_id == user_id))
    ).scalar_one_or_none()


# ------------------------------------------------------------------ who may do what

# (method, path, body). {h} the home, {b} its box, {m} a member's id.
USING = [
    ("GET", "/api/home/{h}/state", None),
    ("POST", "/api/home/{h}/act", {"box_id": "{b}", "entity_id": "light.lamp", "action": "turn_on"}),
    ("POST", "/api/home/{h}/boxes/{b}/rooms/lounge/lights", {"on": True}),
    ("GET", "/api/home/{h}/boxes/{b}/music", None),
]
SETTING_UP = [
    ("PATCH", "/api/home/{h}", {"name": "Ours"}),
    ("POST", "/api/home/{h}/members", {"username": "{extra}"}),
    ("PATCH", "/api/home/{h}/boxes/{b}", {"name": "Cupboard"}),
    ("GET", "/api/home/{h}/boxes/{b}/setup/found", None),
    ("GET", "/api/home/{h}/boxes/{b}/setup/brands", None),
    ("POST", "/api/home/{h}/boxes/{b}/setup", {"brand": "hue"}),
    ("GET", "/api/home/{h}/boxes/{b}/setup/f1", None),
    ("POST", "/api/home/{h}/boxes/{b}/setup/f1", {"input": {}}),
    ("DELETE", "/api/home/{h}/boxes/{b}/setup/f1", None),
    ("GET", "/api/home/{h}/boxes/{b}/connected", None),
    ("DELETE", "/api/home/{h}/boxes/{b}/connected/other", None),
    ("POST", "/api/home/{h}/boxes/{b}/music/link", {"brand": "tidal"}),
    ("GET", "/api/home/{h}/boxes/{b}/music/link/tidal/f1", None),
    ("DELETE", "/api/home/{h}/boxes/{b}/music/link/tidal/f1", None),
    ("DELETE", "/api/home/{h}/boxes/{b}/music/sources/other", None),
    ("POST", "/api/home/{h}/boxes/{b}/rooms", {"name": "Study"}),
    ("PUT", "/api/home/{h}/boxes/{b}/rooms/order", {"order": ["lounge"]}),
    ("POST", "/api/home/{h}/boxes/{b}/rooms/study/merge", {"into": "lounge"}),
    ("PATCH", "/api/home/{h}/boxes/{b}/rooms/lounge", {"name": "Living room"}),
    ("DELETE", "/api/home/{h}/boxes/{b}/rooms/study", None),
    ("POST", "/api/home/{h}/boxes/{b}/devices/place", {"entities": ["light.lamp"], "area": "lounge"}),
    ("DELETE", "/api/home/{h}/boxes/{b}/note", None),
    ("PATCH", "/api/home/{h}/boxes/{b}/devices", {"entity_id": "light.lamp", "name": "Lamp"}),
]
OWNERS_ALONE = [
    ("PATCH", "/api/home/{h}/members/{m}", {"role": "member"}),
    ("PUT", "/api/home/{h}/owner", {"user_id": "{nobody}"}),
]
# Last, because they take things away: a box, then the home.
TAKING_AWAY = [("DELETE", "/api/home/{h}/boxes/{b}", None)]
DELETING = ("DELETE", "/api/home/{h}", None)


def _fill(value, words):
    if isinstance(value, str):
        for k, v in words.items():
            value = value.replace("{" + k + "}", v)
        return value
    if isinstance(value, dict):
        return {k: _fill(v, words) for k, v in value.items()}
    return value


async def _call(client, who, case, words) -> int:
    method, path, body = case
    r = await client.request(method, _fill(path, words), headers=_hdr(who), json=_fill(body, words) if body is not None else None)
    return r.status_code


def test_every_home_endpoint_is_in_the_table():
    """A new endpoint has to be put in one of the lists above, so someone
    decides who may call it."""
    from app.home.router import router

    listed = {(m, p.replace("{h}", "{home_id}").replace("{b}", "{box_id}")) for m, p, _ in USING + SETTING_UP + OWNERS_ALONE + TAKING_AWAY + [DELETING]}
    shape = {
        "/api/home/{home_id}/boxes/{box_id}/rooms/lounge/lights": "/api/home/{home_id}/boxes/{box_id}/rooms/{area_id}/lights",
        "/api/home/{home_id}/boxes/{box_id}/setup/f1": "/api/home/{home_id}/boxes/{box_id}/setup/{flow_id}",
        "/api/home/{home_id}/boxes/{box_id}/connected/other": "/api/home/{home_id}/boxes/{box_id}/connected/{entry_id}",
        "/api/home/{home_id}/boxes/{box_id}/music/link/tidal/f1": "/api/home/{home_id}/boxes/{box_id}/music/link/{brand}/{flow_id}",
        "/api/home/{home_id}/boxes/{box_id}/music/sources/other": "/api/home/{home_id}/boxes/{box_id}/music/sources/{source_id}",
        "/api/home/{home_id}/boxes/{box_id}/rooms/study/merge": "/api/home/{home_id}/boxes/{box_id}/rooms/{area_id}/merge",
        "/api/home/{home_id}/boxes/{box_id}/rooms/lounge": "/api/home/{home_id}/boxes/{box_id}/rooms/{area_id}",
        "/api/home/{home_id}/boxes/{box_id}/rooms/study": "/api/home/{home_id}/boxes/{box_id}/rooms/{area_id}",
        "/api/home/{home_id}/members/{m}": "/api/home/{home_id}/members/{user_id}",
    }
    listed = {(m, shape.get(p, p)) for m, p in listed}
    # Covered by their own tests: leaving / removing someone, a picture, claiming, the list of homes.
    listed |= {
        ("DELETE", "/api/home/{home_id}/members/{user_id}"),
        ("GET", "/api/home/{home_id}/boxes/{box_id}/art/{entity_id}"),
        ("POST", "/api/home/claim"),
        ("GET", "/api/home"),
        ("GET", "/api/home/available"),
    }
    real = {(m, "/api/home" + r.path) for r in router.routes if hasattr(r, "methods") for m in r.methods if m != "HEAD"}
    assert real - listed == set(), f"not in the permission table: {sorted(real - listed)}"
    assert listed - real == set(), f"in the table but gone: {sorted(listed - real)}"


async def test_members_use_a_home_and_owners_and_co_owners_set_it_up(user, client, db):
    """owner / co-owner / member / someone outside / an admin outside, for
    every Home endpoint. ``user`` is this server's admin, and in no home."""
    await _turn_on(client, user)
    sam, cora, mel, out, extra, pip = [await _other(db) for _ in range(6)]
    prepared, home_id, box = await _home(client, user, sam, areas=[LOUNGE])
    await _add(client, sam, home_id, cora, "coowner")
    await _add(client, sam, home_id, mel)
    await _add(client, sam, home_id, pip)
    words = {"h": home_id, "b": prepared["box"]["id"], "m": str(pip.id), "extra": extra.username, "nobody": str(uuid.uuid4())}
    box.sources = [dict(TIDAL, id="other")]
    box.entries = [dict(HUE, id="other")]

    async def all_of(cases, who) -> set[int]:
        return {await _call(client, who, c, words) for c in cases}

    # Nobody outside the home learns it exists, an admin included.
    for stranger in (out, user):
        assert await all_of(USING + SETTING_UP + OWNERS_ALONE + TAKING_AWAY + [DELETING], stranger) == {404}
    assert (await client.get("/api/home", headers=_hdr(user))).json()["homes"] == []
    # A member uses it and sets nothing up.
    assert await all_of(USING, mel) == {200}
    assert await all_of(SETTING_UP + OWNERS_ALONE + TAKING_AWAY + [DELETING], mel) == {403}
    assert box.asked.count("entries.remove") == 0 and box.asked.count("music.unlink") == 0
    # A co-owner sets it up, and can't choose co-owners, pass it on or delete it.
    assert await all_of(USING + SETTING_UP, cora) == {200}
    assert await all_of(OWNERS_ALONE + [DELETING], cora) == {403}
    # The owner: everything. (Passing it to someone who isn't in it is a 404.)
    assert await all_of(USING + SETTING_UP, sam) == {200}
    assert await _call(client, sam, OWNERS_ALONE[0], words) == 200
    assert await _call(client, sam, OWNERS_ALONE[1], words) == 404
    homes = {who: (await client.get("/api/home", headers=_hdr(who))).json()["homes"][0] for who in (sam, cora, mel)}
    assert [homes[w]["role"] for w in (sam, cora, mel)] == ["owner", "coowner", "member"]
    assert [homes[w]["can_manage"] for w in (sam, cora, mel)] == [True, True, False]
    # A co-owner can move a box on, like the owner; then the owner deletes the home.
    assert await _call(client, cora, TAKING_AWAY[0], words) == 200
    assert await _call(client, sam, DELETING, words) == 200
    assert (await client.get("/api/home", headers=_hdr(cora))).json()["homes"] == []
    await box.task


async def test_a_co_owner_cannot_take_the_home_or_remove_those_who_run_it(user, client, db):
    await _turn_on(client, user)
    sam, cora, cole, mel = [await _other(db) for _ in range(4)]
    prepared, home_id, box = await _home(client, user, sam)
    await _add(client, sam, home_id, cora, "coowner")
    await _add(client, sam, home_id, cole, "coowner")
    await _add(client, sam, home_id, mel)
    h = f"/api/home/{home_id}"
    # Not the owner, not another co-owner, and not themselves into the owner's seat.
    assert (await client.delete(f"{h}/members/{sam.id}", headers=_hdr(cora))).status_code == 403
    assert (await client.delete(f"{h}/members/{cole.id}", headers=_hdr(cora))).status_code == 403
    assert (await client.patch(f"{h}/members/{mel.id}", headers=_hdr(cora), json={"role": "coowner"})).status_code == 403
    assert (await client.patch(f"{h}/members/{cole.id}", headers=_hdr(cora), json={"role": "member"})).status_code == 403
    assert (await client.put(f"{h}/owner", headers=_hdr(cora), json={"user_id": str(cora.id)})).status_code == 403
    assert (await client.patch(f"{h}/members/{cora.id}", headers=_hdr(cora), json={"role": "owner"})).status_code == 422
    # They can take a member out, and a member can't take anyone out.
    assert (await client.delete(f"{h}/members/{cora.id}", headers=_hdr(mel))).status_code == 403
    assert (await client.delete(f"{h}/members/{mel.id}", headers=_hdr(cora))).status_code == 200
    # The owner's own role is never set this way; a co-owner can step down by leaving.
    assert (await client.patch(f"{h}/members/{sam.id}", headers=_hdr(sam), json={"role": "member"})).status_code == 409
    assert (await client.patch(f"{h}/members/{cole.id}", headers=_hdr(sam), json={"role": "member"})).status_code == 200
    assert (await client.delete(f"{h}/members/{cora.id}", headers=_hdr(cora))).status_code == 200
    assert await _role(db, home_id, sam.id) == "owner" and await _role(db, home_id, cole.id) == "member"
    await box.stop()


# ------------------------------------------------------------------ the owner going


async def test_the_owner_passes_the_home_on_and_stays_or_leaves(user, client, db):
    from app.home.models import Home

    await _turn_on(client, user)
    sam, cora, mel = [await _other(db) for _ in range(3)]
    prepared, home_id, box = await _home(client, user, sam, entries=[HUE])
    await _add(client, sam, home_id, cora, "coowner")
    await _add(client, sam, home_id, mel)
    h = f"/api/home/{home_id}"
    # The owner can't just leave: there'd be nobody.
    r = await client.delete(f"{h}/members/{sam.id}", headers=_hdr(sam))
    assert r.status_code == 409 and "Pass the home" in r.json()["detail"]
    # Passed on, staying: the old owner is a co-owner now.
    assert (await client.put(f"{h}/owner", headers=_hdr(sam), json={"user_id": str(mel.id)})).status_code == 200
    assert [await _role(db, home_id, u.id) for u in (sam, cora, mel)] == ["coowner", "coowner", "owner"]
    assert (await db.execute(select(Home.owner_id).where(Home.id == uuid.UUID(home_id)))).scalar_one() == mel.id
    assert (await client.put(f"{h}/owner", headers=_hdr(sam), json={"user_id": str(sam.id)})).status_code == 403
    # Passed on and leaving in one go. Nothing on the box is touched.
    assert (await client.put(f"{h}/owner", headers=_hdr(mel), json={"user_id": str(cora.id), "leave": True})).status_code == 200
    assert [await _role(db, home_id, u.id) for u in (sam, cora, mel)] == ["coowner", "owner", None]
    assert (await client.get("/api/home", headers=_hdr(mel))).json()["homes"] == []
    assert {e["id"] for e in (await client.get("/api/home", headers=_hdr(cora))).json()["homes"][0]["entities"]} == {"light.lamp"}
    assert "entries.remove" not in box.asked and box.entries == [HUE]
    await box.stop()


async def test_deleting_a_home_makes_its_box_forget_it(user, client, db):
    await _turn_on(client, user)
    sam, mel = await _other(db), await _other(db)
    prepared, home_id, box = await _home(client, user, sam, entries=[HUE, dict(HUE, id="entry2")], sources=[TIDAL], areas=[LOUNGE])
    await _add(client, sam, home_id, mel)
    r = await client.delete(f"/api/home/{home_id}", headers=_hdr(sam))
    assert r.status_code == 200 and r.json() == {"ok": True, "boxes": 1, "waiting": 0}
    # The brands (and so the devices and their sign-ins), the music, the rooms.
    assert box.entries == [] and box.sources == [] and box.areas == []
    assert box.asked.count("entries.remove") == 2 and "music.unlink" in box.asked and "areas.delete" in box.asked
    assert "released" in box.heard
    await box.task  # told to dial again
    assert box.fake.closed == 4412
    row = await _row(db, prepared["box"]["id"])
    assert row.home_id is None and row.snapshot is None and row.wipe_pending is False and row.claim_hash is None
    for who in (sam, mel):
        assert (await client.get("/api/home", headers=_hdr(who))).json()["homes"] == []
        assert (await client.get(f"/api/home/{home_id}/state", headers=_hdr(who))).status_code == 404


async def test_a_box_that_was_offline_forgets_before_anyone_sees_anything(user, client, db):
    """The home is deleted while its box is unplugged. The box still has the
    old home's devices on it; whoever has it next must never see them."""
    from app.home import relay

    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    prepared, home_id, box = await _home(client, user, sam, entries=[HUE], sources=[TIDAL])
    box_id = prepared["box"]["id"]
    await box.stop()
    r = await client.delete(f"/api/home/{home_id}", headers=_hdr(sam))
    assert r.json() == {"ok": True, "boxes": 1, "waiting": 1}
    assert (await _row(db, box_id)).wipe_pending is True
    # An admin gives it a new card; Ann claims it while it's still unplugged.
    again = (await client.post(f"/api/admin/home/boxes/{box_id}/claim-code", headers=_hdr(user))).json()
    assert (await client.post("/api/home/claim", headers=_hdr(ann), json={"code": again["claim_code"]})).status_code == 200
    # Plugged in again, with Sam's Hue bridge and Tidal still on it.
    box2 = await _box(prepared, entries=[HUE], sources=[TIDAL])
    box2.refuse = {"music.unlink"}  # the first try doesn't get everything
    await box2.snapshot()
    await _wait(lambda: box2.asked.count("music.status") >= 2)
    await asyncio.sleep(0.05)
    live = relay.link(uuid.UUID(box_id))
    assert live is not None and live.hold and not live.got_snapshot
    mine = (await client.get("/api/home", headers=_hdr(ann))).json()["homes"][0]
    assert mine["entities"] == [] and mine["boxes"][0]["ready"] is False
    assert (await client.post(f"/api/home/{mine['id']}/act", headers=_hdr(ann), json={"box_id": box_id, "entity_id": "light.lamp", "action": "turn_on"})).status_code == 409
    assert (await _row(db, box_id)).wipe_pending is True and box2.entries == []
    # Next time it says what it has, the rest goes; then it starts clean.
    box2.refuse = set()
    await box2.snapshot()
    await box2.task
    assert box2.fake.closed == 4412 and box2.sources == []
    assert (await _row(db, box_id)).wipe_pending is False
    box3 = await _box(prepared)
    await box3.snapshot([TEMP])
    await _wait(lambda: _has_snapshot(box_id))
    mine = (await client.get("/api/home", headers=_hdr(ann))).json()["homes"][0]
    assert {e["id"] for e in mine["entities"]} == {"sensor.temp"}
    await box3.stop()


# ------------------------------------------------------------------ an account going


async def _delete_account(client, admin, who) -> int:
    r = await client.request("DELETE", f"/api/admin/users/{who.id}", headers=_hdr(admin), json={"confirm_username": who.username})
    return r.status_code


async def test_a_deleted_owners_home_goes_to_a_co_owner_first(user, client, db):
    from app.home.models import Home

    await _turn_on(client, user)
    sam, mel, cora = [await _other(db) for _ in range(3)]
    prepared, home_id, box = await _home(client, user, sam, entries=[HUE])
    await _add(client, sam, home_id, mel)  # here longer than the co-owner
    await _add(client, sam, home_id, cora, "coowner")
    # The admin is told how many, and nothing about the home.
    preview = (await client.get(f"/api/admin/users/{sam.id}/deletion-preview", headers=_hdr(user))).json()
    assert preview["homes_passed"] == 1 and preview["homes_wiped"] == 0
    assert "home" not in str({k: v for k, v in preview.items() if not k.startswith("homes_")}).lower()
    assert await _delete_account(client, user, sam) == 204
    assert [await _role(db, home_id, u.id) for u in (cora, mel)] == ["owner", "member"]
    assert (await db.execute(select(Home.owner_id).where(Home.id == uuid.UUID(home_id)))).scalar_one() == cora.id
    # The home carries on as it was: same box, same devices, nothing removed.
    home = (await client.get("/api/home", headers=_hdr(mel))).json()["homes"][0]
    assert {e["id"] for e in home["entities"]} == {"light.lamp"} and box.entries == [HUE]
    assert (await _row(db, prepared["box"]["id"])).wipe_pending is False
    await box.stop()


async def test_with_no_co_owner_it_goes_to_whoever_has_been_there_longest(user, client, db):
    await _turn_on(client, user)
    sam, first, second = [await _other(db) for _ in range(3)]
    prepared, home_id, box = await _home(client, user, sam)
    await _add(client, sam, home_id, first)
    await asyncio.sleep(0.01)
    await _add(client, sam, home_id, second)
    assert await _delete_account(client, user, sam) == 204
    assert [await _role(db, home_id, u.id) for u in (first, second)] == ["owner", "member"]
    await box.stop()


async def test_a_deleted_owners_home_with_nobody_else_in_it_is_wiped(user, client, db):
    from app.auth.events import AuthEvent
    from app.home.models import Home

    await _turn_on(client, user)
    sam = await _other(db)
    prepared, home_id, box = await _home(client, user, sam, entries=[HUE], sources=[TIDAL])
    preview = (await client.get(f"/api/admin/users/{sam.id}/deletion-preview", headers=_hdr(user))).json()
    assert preview["homes_passed"] == 0 and preview["homes_wiped"] == 1
    assert await _delete_account(client, user, sam) == 204
    assert (await db.execute(select(Home.id).where(Home.id == uuid.UUID(home_id)))).first() is None
    # The box forgets it in the background (the admin's click doesn't wait).
    await box.task
    assert box.entries == [] and box.sources == [] and box.fake.closed == 4412
    row = await _row(db, prepared["box"]["id"])
    assert row.home_id is None and row.wipe_pending is False
    line = (await db.execute(select(AuthEvent.detail).where(AuthEvent.event_type == "user_deleted"))).scalar_one()
    assert "homes_passed=0; homes_wiped=1" in line


async def test_someone_who_only_lives_in_a_home_just_leaves_it(user, client, db):
    await _turn_on(client, user)
    sam, mel = await _other(db), await _other(db)
    prepared, home_id, box = await _home(client, user, sam)
    await _add(client, sam, home_id, mel, "coowner")
    assert await _delete_account(client, user, mel) == 204
    home = (await client.get("/api/home", headers=_hdr(sam))).json()["homes"][0]
    assert [m["role"] for m in home["members"]] == ["owner"]
    await box.stop()


@pytest.mark.parametrize("stay", [True, False])
async def test_a_home_always_has_exactly_one_owner(user, client, db, stay):
    from app.home.models import Home, HomeMember

    await _turn_on(client, user)
    sam, mel = await _other(db), await _other(db)
    prepared, home_id, box = await _home(client, user, sam)
    await _add(client, sam, home_id, mel)
    assert (await client.put(f"/api/home/{home_id}/owner", headers=_hdr(sam), json={"user_id": str(mel.id), "leave": not stay})).status_code == 200
    owners = (await db.execute(select(HomeMember.user_id).where(HomeMember.home_id == uuid.UUID(home_id), HomeMember.role == "owner"))).scalars().all()
    assert owners == [mel.id] == [(await db.execute(select(Home.owner_id).where(Home.id == uuid.UUID(home_id)))).scalar_one()]
    await box.stop()
