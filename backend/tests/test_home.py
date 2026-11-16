"""Promptly Home: a box is prepared by an admin, claimed with the code on its
card, and from then on its devices belong to that home alone: not to another
home, and not to the admin who prepared it."""
from __future__ import annotations

import asyncio
import base64
import json
import uuid

import httpx
import pytest
from starlette.websockets import WebSocketDisconnect

from tests.test_maps_timeline import _hdr, _other

LAMP = {"id": "light.lamp", "domain": "light", "name": "Lamp", "state": "off", "area": "lounge", "bri": 0}
TEMP = {"id": "sensor.temp", "domain": "sensor", "name": "Temperature", "state": "21.5", "unit": "°C", "cls": "temperature"}


class FakeBox:
    """The box's end of the line, without a network."""

    class _Client:
        host = "203.0.113.9"

    client = _Client()

    def __init__(self) -> None:
        self.to_server: asyncio.Queue = asyncio.Queue()
        self.from_server: asyncio.Queue = asyncio.Queue()
        self.closed: int | None = None

    async def accept(self) -> None:
        return None

    async def receive_text(self) -> str:
        item = await self.to_server.get()
        if item is None:
            raise WebSocketDisconnect()
        return item

    async def send_text(self, text: str) -> None:
        if self.closed is not None:
            raise RuntimeError("closed")
        await self.from_server.put(json.loads(text))

    async def close(self, code: int = 1000) -> None:
        if self.closed is None:
            self.closed = code
            await self.to_server.put(None)

    # -- what a test does as the box
    async def say(self, msg: dict) -> None:
        await self.to_server.put(json.dumps(msg))

    async def hear(self, t: str) -> dict:
        while True:
            msg = await asyncio.wait_for(self.from_server.get(), timeout=5)
            if msg.get("t") == t:
                return msg

    async def hang_up(self) -> None:
        await self.to_server.put(None)


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.home import relay
    from app.main import app

    relay.reset()
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True
        relay.reset()


async def _turn_on(client, admin) -> None:
    r = await client.patch("/api/admin/home/settings", headers=_hdr(admin), json={"enabled": True})
    assert r.json()["enabled"] is True


async def _prepare(client, admin, label="Sam's box") -> dict:
    r = await client.post("/api/admin/home/boxes", headers=_hdr(admin), json={"label": label, "server_url": "https://promptly.example"})
    assert r.status_code == 200, r.text
    return r.json()


def _setup(prepared: dict) -> dict:
    body = prepared["setup"].removeprefix("pbox1.")
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


async def _dial(prepared: dict, *, key: str | None = None) -> tuple[FakeBox, asyncio.Task]:
    from app.home import relay

    s = _setup(prepared)
    box = FakeBox()
    task = asyncio.create_task(relay.serve(box))
    await box.say({"t": "hello", "box": s["b"], "key": key or s["k"], "v": "test"})
    return box, task


def _has_snapshot(box_id: str) -> bool:
    from app.home import relay

    live = relay.link(uuid.UUID(box_id))
    return live is not None and live.got_snapshot


async def _wait(pred, seconds: float = 3.0) -> None:
    for _ in range(int(seconds / 0.02)):
        if pred():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("timed out")


# ------------------------------------------------------------------ the switch


async def test_off_until_an_admin_turns_it_on(user, client):
    assert (await client.get("/api/home/available", headers=_hdr(user))).json() == {"available": False}
    assert (await client.get("/api/home", headers=_hdr(user))).status_code == 404
    assert (await client.post("/api/home/claim", headers=_hdr(user), json={"code": "ABCD-EFGH-JKMN"})).status_code == 404
    await _turn_on(client, user)
    assert (await client.get("/api/home", headers=_hdr(user))).json()["homes"] == []


async def test_only_an_admin_prepares_boxes(user, client, db):
    other = await _other(db)
    assert (await client.post("/api/admin/home/boxes", headers=_hdr(other), json={})).status_code == 403
    assert (await client.get("/api/admin/home/boxes", headers=_hdr(other))).status_code == 403


# ------------------------------------------------------------------ claiming


async def test_the_code_on_the_card_makes_the_box_yours_once(user, client, db):
    await _turn_on(client, user)
    sam = await _other(db)
    prepared = await _prepare(client, user)
    assert prepared["claim_url"] == f"https://promptly.example/home#claim={prepared['claim_code']}"
    # Only hashes are kept.
    from app.home.models import HomeBox

    row = await db.get(HomeBox, uuid.UUID(prepared["box"]["id"]))
    assert _setup(prepared)["k"] not in (row.key_hash, row.claim_hash) and len(row.key_hash) == 64

    assert (await client.post("/api/home/claim", headers=_hdr(sam), json={"code": "ZZZZ-ZZZZ-ZZZZ"})).status_code == 404
    # However it's typed.
    typed = prepared["claim_code"].replace("-", " ").lower()
    r = await client.post("/api/home/claim", headers=_hdr(sam), json={"code": typed, "home_name": "Sam's place"})
    assert r.status_code == 200, r.text
    homes = (await client.get("/api/home", headers=_hdr(sam))).json()["homes"]
    assert [(h["name"], h["role"], len(h["boxes"])) for h in homes] == [("Sam's place", "owner", 1)]
    assert homes[0]["boxes"][0]["online"] is False
    # Used: it doesn't work twice, for anyone.
    assert (await client.post("/api/home/claim", headers=_hdr(user), json={"code": prepared["claim_code"]})).status_code == 404


# ------------------------------------------------------------------ the line


async def test_a_box_with_the_wrong_key_is_turned_away(user, client):
    prepared = await _prepare(client, user)
    box, task = await _dial(prepared, key="x" * 40)
    await task
    assert box.closed == 4401


async def test_devices_reach_the_home_and_a_switch_reaches_the_box(user, client, db):
    from app.home import relay

    await _turn_on(client, user)
    sam = await _other(db)
    prepared = await _prepare(client, user)
    home_id = (await client.post("/api/home/claim", headers=_hdr(sam), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    assert (await box.hear("welcome"))["claimed"] is True
    junk = {"id": "script.x", "domain": "script", "name": "nope", "state": "off"}
    await box.say({"t": "snapshot", "areas": [{"id": "lounge", "name": "Lounge"}], "entities": [LAMP, TEMP, junk, "rubbish"]})
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))

    home = (await client.get("/api/home", headers=_hdr(sam))).json()["homes"][0]
    assert home["boxes"][0]["online"] is True and home["areas"] == [{"id": "lounge", "name": "Lounge"}]
    by_id = {e["id"]: e for e in home["entities"]}
    assert set(by_id) == {"light.lamp", "sensor.temp"}
    assert by_id["light.lamp"]["can_switch"] is True and by_id["sensor.temp"]["can_switch"] is False

    # Nothing changed: the poll says so in one number.
    rev = home["rev"]
    assert (await client.get(f"/api/home/{home_id}/state?after={rev}", headers=_hdr(sam))).json() == {"rev": rev, "changed": False}

    # Switch the lamp: the box is asked, answers, then says the new state.
    async def box_side():
        ask = await box.hear("req")
        assert (ask["op"], ask["args"]["entity"], ask["args"]["action"]) == ("do", "light.lamp", "turn_on")
        await box.say({"t": "res", "id": ask["id"], "ok": True})
        await box.say({"t": "state", "e": {**LAMP, "state": "on", "bri": 80}})

    side = asyncio.create_task(box_side())
    body = {"box_id": prepared["box"]["id"], "entity_id": "light.lamp", "action": "turn_on"}
    assert (await client.post(f"/api/home/{home_id}/act", headers=_hdr(sam), json=body)).json() == {"ok": True}
    await side
    await _wait(lambda: relay.rev(uuid.UUID(home_id)) > rev)
    after = (await client.get(f"/api/home/{home_id}/state?after={rev}", headers=_hdr(sam))).json()
    assert after["changed"] is True
    assert {e["id"]: e["state"] for e in after["entities"]}["light.lamp"] == "on"

    # A sensor can't be switched, and nor can something the box never listed.
    for bad in ({**body, "entity_id": "sensor.temp"}, {**body, "action": "unlock"}):
        assert (await client.post(f"/api/home/{home_id}/act", headers=_hdr(sam), json=bad)).status_code == 400
    assert (await client.post(f"/api/home/{home_id}/act", headers=_hdr(sam), json={**body, "entity_id": "light.other"})).status_code == 409

    # The box goes away: the home still sees its devices, marked offline.
    await box.hang_up()
    await task
    home = (await client.get("/api/home", headers=_hdr(sam))).json()["homes"][0]
    assert home["boxes"][0]["online"] is False
    assert {e["id"] for e in home["entities"]} == {"light.lamp", "sensor.temp"} and not any(e["online"] for e in home["entities"])
    assert (await client.post(f"/api/home/{home_id}/act", headers=_hdr(sam), json=body)).status_code == 409


async def test_a_box_that_says_no_is_an_error_not_a_hang(user, client):
    await _turn_on(client, user)
    prepared = await _prepare(client, user)
    home_id = (await client.post("/api/home/claim", headers=_hdr(user), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    await box.say({"t": "snapshot", "areas": [], "entities": [LAMP]})

    async def box_side():
        ask = await box.hear("req")
        await box.say({"t": "res", "id": ask["id"], "ok": False, "error": "The lamp isn't answering."})

    side = asyncio.create_task(box_side())
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    r = await client.post(f"/api/home/{home_id}/act", headers=_hdr(user), json={"box_id": prepared["box"]["id"], "entity_id": "light.lamp", "action": "toggle"})
    await side
    assert r.status_code == 502 and "isn't answering" in r.json()["detail"]
    await box.hang_up()
    await task


# ------------------------------------------------------------------ whose it is


async def test_another_home_and_the_admin_see_nothing(user, client, db):
    """``user`` is the admin who prepared both boxes."""
    from app.home import relay

    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    p1, p2 = await _prepare(client, user, "one"), await _prepare(client, user, "two")
    h1 = (await client.post("/api/home/claim", headers=_hdr(sam), json={"code": p1["claim_code"]})).json()["home_id"]
    h2 = (await client.post("/api/home/claim", headers=_hdr(ann), json={"code": p2["claim_code"]})).json()["home_id"]
    b1, t1 = await _dial(p1)
    await b1.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await _wait(lambda: _has_snapshot(p1["box"]["id"]))

    body = {"box_id": p1["box"]["id"], "entity_id": "light.lamp", "action": "turn_on"}
    for outsider in (ann, user):
        homes = (await client.get("/api/home", headers=_hdr(outsider))).json()["homes"]
        assert all(h["id"] != h1 and not h["entities"] for h in homes)
        assert (await client.get(f"/api/home/{h1}/state", headers=_hdr(outsider))).status_code == 404
        assert (await client.post(f"/api/home/{h1}/act", headers=_hdr(outsider), json=body)).status_code == 404
        assert (await client.delete(f"/api/home/{h1}/boxes/{p1['box']['id']}", headers=_hdr(outsider))).status_code == 404
    # Ann can't reach Sam's box through her own home either.
    assert (await client.post(f"/api/home/{h2}/act", headers=_hdr(ann), json=body)).status_code == 404

    # What the admin's list says about a claimed box: that it is, and nothing more.
    listed = (await client.get("/api/admin/home/boxes", headers=_hdr(user))).json()["boxes"]
    row = next(b for b in listed if b["id"] == p1["box"]["id"])
    assert row["claimed"] is True and row["online"] is True
    text = json.dumps(listed)
    for leak in ("light.lamp", "Lamp", h1, str(sam.id), sam.username, "snapshot", "entities", "home_id"):
        assert leak not in text
    # ...and an admin can't hand a claimed box a new card.
    assert (await client.post(f"/api/admin/home/boxes/{p1['box']['id']}/claim-code", headers=_hdr(user))).status_code == 409
    await b1.hang_up()
    await t1


async def test_members_use_the_home_and_only_the_owner_runs_it(user, client, db):
    """Owner and member, nothing else: there are no guests."""
    await _turn_on(client, user)
    sam, kim = await _other(db), await _other(db)
    prepared = await _prepare(client, user)
    home_id = (await client.post("/api/home/claim", headers=_hdr(sam), json={"code": prepared["claim_code"]})).json()["home_id"]
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": kim.username})).status_code == 200
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": "nobody-here"})).status_code == 404
    home = (await client.get("/api/home", headers=_hdr(kim))).json()["homes"][0]
    assert home["role"] == "member" and {m["role"] for m in home["members"]} == {"owner", "member"}
    assert (await client.patch(f"/api/home/{home_id}", headers=_hdr(kim), json={"name": "Mine now"})).status_code == 403
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(kim), json={"username": user.username})).status_code == 403
    assert (await client.delete(f"/api/home/{home_id}/boxes/{prepared['box']['id']}", headers=_hdr(kim))).status_code == 403
    assert (await client.patch(f"/api/home/{home_id}", headers=_hdr(sam), json={"name": "Sam and Kim's"})).status_code == 200
    # A member can add a second box to the home they're in.
    second = await _prepare(client, user)
    r = await client.post("/api/home/claim", headers=_hdr(kim), json={"code": second["claim_code"], "home_id": home_id})
    assert r.status_code == 200 and r.json()["home_id"] == home_id
    # They can leave; the owner can't.
    assert (await client.delete(f"/api/home/{home_id}/members/{sam.id}", headers=_hdr(sam))).status_code == 409
    assert (await client.delete(f"/api/home/{home_id}/members/{kim.id}", headers=_hdr(kim))).status_code == 200
    assert (await client.get("/api/home", headers=_hdr(kim))).json()["homes"] == []
    assert (await client.get(f"/api/home/{home_id}/state", headers=_hdr(kim))).status_code == 404


# ------------------------------------------------------------------ moving and cutting off


async def test_releasing_a_box_forgets_the_home_and_gives_a_new_code(user, client, db):
    from app.home.models import HomeBox

    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    prepared = await _prepare(client, user)
    home_id = (await client.post("/api/home/claim", headers=_hdr(sam), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    await box.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await box.hear("welcome")
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    r = await client.delete(f"/api/home/{home_id}/boxes/{prepared['box']['id']}", headers=_hdr(sam))
    code = r.json()["claim_code"]
    assert (await box.hear("released")) == {"t": "released"}
    from sqlalchemy import select

    row = (
        await db.execute(select(HomeBox).where(HomeBox.id == uuid.UUID(prepared["box"]["id"])).execution_options(populate_existing=True))
    ).scalar_one()
    assert row.home_id is None and row.snapshot is None and row.claimed_by is None
    assert (await client.get("/api/home", headers=_hdr(sam))).json()["homes"][0]["entities"] == []
    # Its next home.
    assert (await client.post("/api/home/claim", headers=_hdr(ann), json={"code": code})).status_code == 200
    assert (await box.hear("claimed")) == {"t": "claimed"}
    ann_home = (await client.get("/api/home", headers=_hdr(ann))).json()["homes"][0]
    assert {e["id"] for e in ann_home["entities"]} == {"light.lamp"}
    await box.hang_up()
    await task


async def test_a_revoked_box_is_cut_off_and_a_new_setup_replaces_the_old_key(user, client):
    await _turn_on(client, user)
    prepared = await _prepare(client, user)
    box, task = await _dial(prepared)
    await box.hear("welcome")
    assert (await client.post(f"/api/admin/home/boxes/{prepared['box']['id']}/revoke", headers=_hdr(user), json={})).json()["box"]["revoked"] is True
    await task
    assert box.closed == 4403
    again, task = await _dial(prepared)
    await task
    assert again.closed == 4403
    await client.post(f"/api/admin/home/boxes/{prepared['box']['id']}/revoke", headers=_hdr(user), json={"revoked": False})
    fresh = (await client.post(f"/api/admin/home/boxes/{prepared['box']['id']}/setup", headers=_hdr(user), json={"server_url": "https://promptly.example"})).json()
    old, task = await _dial(prepared)
    await task
    assert old.closed == 4401
    new, task = await _dial({"setup": fresh["setup"]})
    assert (await new.hear("welcome"))["claimed"] is False
    await new.hang_up()
    await task


def test_what_a_box_says_is_cut_to_what_we_know():
    from app.home import relay

    assert relay.clean_entity({"id": "light.x", "domain": "switch", "name": "x", "state": "on"}) is None  # domains disagree
    assert relay.clean_entity({"id": "lock.door", "domain": "lock", "name": "Door", "state": "locked", "extra": {"a": 1}}) == {
        "id": "lock.door", "domain": "lock", "name": "Door", "state": "locked",
    }
    long = relay.clean_entity({"id": "sensor.a", "domain": "sensor", "name": "n" * 500, "state": "s" * 500, "bri": 400})
    assert len(long["name"]) == 120 and len(long["state"]) == 64 and "bri" not in long
    assert "lock" not in relay.SWITCHABLE and "cover" not in relay.SWITCHABLE
    # Extras are cut to the ones we know.
    x = relay.clean_entity({"id": "light.a", "domain": "light", "name": "a", "state": "on", "x": {"k": 2700, "modes": ["color_temp", "xy"], "rgb": [255, 0, 0], "junk": "no", "title": 5}})["x"]
    assert x == {"k": 2700, "modes": ["color_temp", "xy"], "rgb": [255, 0, 0]}


def test_claim_codes_read_the_same_however_typed():
    from app.home import codes

    code = codes.new_claim_code()
    assert codes.claim_digest(code) == codes.claim_digest(code.lower().replace("-", " "))
    assert codes.claim_digest("ABCD") is None and codes.claim_digest("O0O0-I1I1-LLLL") is None


async def test_a_box_that_just_dialled_in_is_online_before_its_devices_are(user, client):
    """Until it has said what it has, the home sees what it last said, and
    can't switch it."""
    await _turn_on(client, user)
    prepared = await _prepare(client, user)
    home_id = (await client.post("/api/home/claim", headers=_hdr(user), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    await box.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    await box.hang_up()
    await task

    again, task = await _dial(prepared)
    await again.hear("welcome")
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert home["boxes"][0]["online"] is True
    assert [(e["id"], e["online"]) for e in home["entities"]] == [("light.lamp", False)]
    body = {"box_id": prepared["box"]["id"], "entity_id": "light.lamp", "action": "turn_on"}
    assert (await client.post(f"/api/home/{home_id}/act", headers=_hdr(user), json=body)).status_code == 409
    await again.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert home["entities"][0]["online"] is True
    await again.hang_up()
    await task


# ------------------------------------------------------------------ more than on and off

DOOR = {"id": "lock.front", "domain": "lock", "name": "Front door", "state": "locked"}
GARAGE = {"id": "cover.garage", "domain": "cover", "name": "Garage", "state": "closed", "cls": "garage"}
BLIND = {"id": "cover.blind", "domain": "cover", "name": "Blind", "state": "open", "x": {"pos": 100}}
HEAT = {"id": "climate.hall", "domain": "climate", "name": "Hall", "state": "heat", "x": {"target": 20, "modes": ["off", "heat"], "min": 7, "max": 35}}
BULB = {"id": "light.bulb", "domain": "light", "name": "Bulb", "state": "on", "bri": 50, "x": {"modes": ["color_temp"], "kmin": 2000, "kmax": 6500}}


async def _home_with(client, admin, who, entities):
    prepared = await _prepare(client, admin)
    home_id = (await client.post("/api/home/claim", headers=_hdr(who), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    await box.say({"t": "snapshot", "areas": [], "entities": entities})
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    return prepared, home_id, box, task


async def _answer(box, data=None, n=1):
    """Say yes to the next ``n`` things the server asks, and return them."""
    asked = []
    for _ in range(n):
        ask = await box.hear("req")
        asked.append(ask)
        await box.say({"t": "res", "id": ask["id"], "ok": True, "data": data})
    return asked


async def test_setting_a_value_is_checked_then_passed_to_the_box(user, client):
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [BULB, HEAT, BLIND])
    url, base = f"/api/home/{home_id}/act", {"box_id": prepared["box"]["id"]}

    side = asyncio.create_task(_answer(box, n=3))
    for body in (
        {"entity_id": "light.bulb", "action": "set", "value": {"bri": 30, "k": 2700, "nonsense": 1}},
        {"entity_id": "climate.hall", "action": "temperature", "value": 21.5},
        {"entity_id": "cover.blind", "action": "position", "value": 40},
    ):
        assert (await client.post(url, headers=_hdr(user), json={**base, **body})).status_code == 200
    asked = [a["args"] for a in await side]
    assert asked == [
        {"entity": "light.bulb", "action": "set", "value": {"bri": 30, "k": 2700}},
        {"entity": "climate.hall", "action": "temperature", "value": 21.5},
        {"entity": "cover.blind", "action": "position", "value": 40},
    ]
    for bad in (
        {"entity_id": "light.bulb", "action": "set", "value": {"bri": 400}},
        {"entity_id": "climate.hall", "action": "mode", "value": "cool"},  # not one of its modes
        {"entity_id": "cover.blind", "action": "position", "value": 140},
        {"entity_id": "climate.hall", "action": "temperature", "value": 40},  # above what it can be set to
        {"entity_id": "light.bulb", "action": "unlock"},
    ):
        assert (await client.post(url, headers=_hdr(user), json={**base, **bad})).status_code == 400, bad
    await box.hang_up()
    await task


async def test_a_lock_and_a_garage_door_want_a_yes_first(user, client):
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [DOOR, GARAGE, BLIND])
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert {e["id"]: e["careful"] for e in home["entities"]} == {"lock.front": True, "cover.garage": True, "cover.blind": False}
    url, base = f"/api/home/{home_id}/act", {"box_id": prepared["box"]["id"]}
    for body in ({"entity_id": "lock.front", "action": "unlock"}, {"entity_id": "cover.garage", "action": "open"}):
        assert (await client.post(url, headers=_hdr(user), json={**base, **body})).status_code == 428
    # Locking, closing, and an ordinary blind need no asking.
    side = asyncio.create_task(_answer(box, n=5))
    for body in (
        {"entity_id": "lock.front", "action": "lock"},
        {"entity_id": "cover.garage", "action": "close"},
        {"entity_id": "cover.blind", "action": "open"},
        {"entity_id": "lock.front", "action": "unlock", "confirm": True},
        {"entity_id": "cover.garage", "action": "open", "confirm": True},
    ):
        assert (await client.post(url, headers=_hdr(user), json={**base, **body})).status_code == 200, body
    assert [a["args"]["action"] for a in await side] == ["lock", "close", "open", "unlock", "open"]
    await box.hang_up()
    await task


# ------------------------------------------------------------------ adding a device


async def test_set_up_steps_go_straight_through_to_the_box(user, client, db, caplog):
    """What's typed into a step reaches the box as typed, and stays nowhere here."""
    import logging

    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [])
    base = f"/api/home/{home_id}/boxes/{prepared['box']['id']}"
    secret = "hunter2-" + uuid.uuid4().hex
    caplog.set_level(logging.DEBUG)

    step = {"kind": "form", "flow": "f1", "brand": "tuya", "fields": [{"name": "password", "type": "password", "label": "Password"}]}
    side = asyncio.create_task(_answer(box, data=step))
    assert (await client.post(f"{base}/setup", headers=_hdr(user), json={"brand": "tuya"})).json() == step
    assert [(a["op"], a["args"]) for a in await side] == [("flows.start", {"brand": "tuya"})]

    side = asyncio.create_task(_answer(box, data={"kind": "done", "flow": "f1", "title": "Tuya", "devices": []}))
    r = await client.post(f"{base}/setup/f1", headers=_hdr(user), json={"input": {"username": "sam@example.com", "password": secret}})
    assert r.json()["kind"] == "done"
    (asked,) = await side
    assert (asked["op"], asked["args"]) == ("flows.step", {"flow": "f1", "input": {"username": "sam@example.com", "password": secret}})

    assert secret not in caplog.text
    from sqlalchemy import text

    for table in ("home_boxes", "homes", "home_members"):
        rows = (await db.execute(text(f"select row_to_json(t)::text from {table} t"))).scalars().all()
        assert not any(secret in row for row in rows)
    await box.hang_up()
    await task


async def test_rooms_names_and_removing_reach_the_box(user, client):
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [BULB])
    base = f"/api/home/{home_id}/boxes/{prepared['box']['id']}"
    side = asyncio.create_task(_answer(box, data={"id": "study", "name": "Study"}, n=5))
    assert (await client.post(f"{base}/rooms", headers=_hdr(user), json={"name": " Study "})).json() == {"id": "study", "name": "Study"}
    assert (await client.patch(f"{base}/rooms/study", headers=_hdr(user), json={"name": "Office"})).status_code == 200
    assert (await client.patch(f"{base}/devices", headers=_hdr(user), json={"entity_id": "light.bulb", "name": "Desk lamp", "area": "study"})).status_code == 200
    assert (await client.delete(f"{base}/connected/abc123", headers=_hdr(user))).status_code == 200
    assert (await client.delete(f"{base}/setup/f9", headers=_hdr(user))).status_code == 200
    assert [(a["op"], a["args"]) for a in await side] == [
        ("areas.create", {"name": "Study"}),
        ("areas.rename", {"area": "study", "name": "Office"}),
        ("device.update", {"entity_id": "light.bulb", "name": "Desk lamp", "area": "study"}),
        ("entries.remove", {"entry": "abc123"}),
        ("flows.abort", {"flow": "f9"}),
    ]
    assert (await client.patch(f"{base}/devices", headers=_hdr(user), json={"name": "x"})).status_code == 400
    # A room's id is an id, here as everywhere else.
    assert (await client.patch(f"{base}/devices", headers=_hdr(user), json={"entity_id": "light.bulb", "area": "../x"})).status_code == 400
    # A step is a few fields: one far bigger than the box's line carries is refused here.
    assert (await client.post(f"{base}/setup/f1", headers=_hdr(user), json={"input": {"host": "x" * 20_000}})).status_code == 400
    await box.hang_up()
    await task


async def test_nobody_outside_the_home_reaches_its_set_up(user, client, db):
    """``user`` is the admin who prepared the box; Ann has a home of her own."""
    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    prepared, home_id, box, task = await _home_with(client, user, sam, [BULB])
    await box.hear("welcome")
    p2 = await _prepare(client, user)
    ann_home = (await client.post("/api/home/claim", headers=_hdr(ann), json={"code": p2["claim_code"]})).json()["home_id"]
    bid = prepared["box"]["id"]
    for who in (ann, user):
        for home in (home_id, ann_home):  # not through her own home either
            if who is user and home == ann_home:
                continue  # the admin isn't in it at all
            base = f"/api/home/{home}/boxes/{bid}"
            calls = [
                client.get(f"{base}/setup/found", headers=_hdr(who)),
                client.get(f"{base}/setup/brands", headers=_hdr(who)),
                client.post(f"{base}/setup", headers=_hdr(who), json={"brand": "hue"}),
                client.get(f"{base}/setup/f1", headers=_hdr(who)),
                client.post(f"{base}/setup/f1", headers=_hdr(who), json={"input": {}}),
                client.delete(f"{base}/setup/f1", headers=_hdr(who)),
                client.get(f"{base}/connected", headers=_hdr(who)),
                client.delete(f"{base}/connected/e1", headers=_hdr(who)),
                client.post(f"{base}/rooms", headers=_hdr(who), json={"name": "x"}),
                client.patch(f"{base}/rooms/a", headers=_hdr(who), json={"name": "x"}),
                client.delete(f"{base}/rooms/a", headers=_hdr(who)),
                client.patch(f"{base}/devices", headers=_hdr(who), json={"entity_id": "light.bulb", "name": "x"}),
                client.put(f"{base}/rooms/order", headers=_hdr(who), json={"order": ["a"]}),
                client.post(f"{base}/rooms/a/merge", headers=_hdr(who), json={"into": "b"}),
                client.post(f"{base}/rooms/a/lights", headers=_hdr(who), json={"on": True}),
                client.post(f"{base}/devices/place", headers=_hdr(who), json={"entities": ["light.bulb"], "area": "a"}),
                client.delete(f"{base}/note", headers=_hdr(who)),
            ]
            assert {(await c).status_code for c in calls} == {404}, (who.username, home)
    assert box.from_server.empty()  # nothing was asked of the box
    await box.hang_up()
    await task


# ------------------------------------------------------------------ rooms are Promptly's


async def test_rooms_are_merged_ordered_and_filled_from_promptly(user, client):
    await _turn_on(client, user)
    lounge = {**BULB, "id": "light.lamp", "area": "lounge", "dev": "d1"}
    prepared, home_id, box, task = await _home_with(client, user, user, [lounge, {**BULB, "id": "light.desk", "dev": "d2"}])
    base = f"/api/home/{home_id}/boxes/{prepared['box']['id']}"
    side = asyncio.create_task(_answer(box, n=4))
    assert (await client.post(f"{base}/rooms/lounge/merge", headers=_hdr(user), json={"into": "living"})).status_code == 200
    assert (await client.put(f"{base}/rooms/order", headers=_hdr(user), json={"order": ["living", "study"]})).status_code == 200
    assert (await client.post(f"{base}/devices/place", headers=_hdr(user), json={"entities": ["light.desk", "light.lamp"], "area": "study"})).status_code == 200
    assert (await client.post(f"{base}/rooms/lounge/lights", headers=_hdr(user), json={"on": False})).status_code == 200
    assert [(a["op"], a["args"]) for a in await side] == [
        ("areas.merge", {"area": "lounge", "into": "living"}),
        ("areas.order", {"order": ["living", "study"]}),
        ("devices.place", {"entities": ["light.desk", "light.lamp"], "area": "study"}),
        ("room.lights", {"area": "lounge", "action": "turn_off"}),
    ]
    # A room into itself, a room with no lights, nonsense ids: refused here, the box isn't asked.
    assert (await client.post(f"{base}/rooms/lounge/merge", headers=_hdr(user), json={"into": "lounge"})).status_code == 400
    assert (await client.post(f"{base}/rooms/attic/lights", headers=_hdr(user), json={"on": True})).status_code == 404
    assert (await client.post(f"{base}/devices/place", headers=_hdr(user), json={"entities": ["not an id"], "area": "study"})).status_code == 400
    assert box.from_server.empty()
    await box.hang_up()
    await task


async def test_what_joined_on_its_own_is_said_once(user, client):
    """The box put three speakers back under "Found on your network": the
    home is told, and "Got it" ends it, here and on the box."""
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [])
    base = f"/api/home/{home_id}/boxes/{prepared['box']['id']}"
    await box.say({"t": "snapshot", "areas": [], "entities": [], "note": {"n": 3, "what": "speakers", "brands": ["Google Cast"], "extra": "x" * 9000}})

    def told() -> bool:
        from app.home import relay

        return relay.link(uuid.UUID(prepared["box"]["id"])).note is not None

    await _wait(told)
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert home["boxes"][0]["note"] == {"n": 3, "what": "speakers", "brands": ["Google Cast"]}
    side = asyncio.create_task(_answer(box))
    assert (await client.delete(f"{base}/note", headers=_hdr(user))).status_code == 200
    assert [(a["op"], a["args"]) for a in await side] == [("note.clear", {})]
    assert (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]["boxes"][0]["note"] is None
    await box.hang_up()
    await task


def test_a_device_id_and_a_speaker_group_come_through_and_nothing_else_new():
    from app.home import relay

    got = relay.clean_entity({"id": "media_player.downstairs", "domain": "media_player", "name": "Downstairs", "state": "off", "dev": "abc123", "grp": True, "cls": "speaker", "members": ["x"]})
    assert got == {"id": "media_player.downstairs", "domain": "media_player", "name": "Downstairs", "state": "off", "dev": "abc123", "grp": True, "cls": "speaker"}
    assert "grp" not in relay.clean_entity({"id": "light.a", "domain": "light", "name": "A", "state": "on", "grp": "yes"})
    assert relay.clean_note({"n": "3"}) is None and relay.clean_note({"n": 0, "brands": []}) is None


# ------------------------------------------------------------------ security review 2026-11


class _Peer:
    def __init__(self, host: str) -> None:
        self.host = host


class ProxiedBox(FakeBox):
    """A box dialling in through nginx: the socket's peer is the proxy, and
    the real caller is in X-Real-IP."""

    def __init__(self, real_ip: str) -> None:
        super().__init__()
        self.client = _Peer("172.18.0.5")
        self.headers = {"X-Real-IP": real_ip}


async def test_wrong_hellos_from_one_address_do_not_shut_every_box_out(user, client):
    """Behind nginx every caller used to be counted as nginx: ten wrong
    hellos from anyone turned every box away, this server's own included."""
    from app.home import relay

    admin = user
    await _turn_on(client, admin)
    prepared = await _prepare(client, admin)
    s = _setup(prepared)

    for _ in range(relay.MAX_BAD_HELLOS + 2):
        stranger = ProxiedBox("203.0.113.9")
        task = asyncio.create_task(relay.serve(stranger))
        await stranger.say({"t": "hello", "box": s["b"], "key": "x" * 40, "v": "test"})
        await asyncio.wait_for(task, timeout=5)
        assert stranger.closed in (relay.CLOSE_BAD, relay.CLOSE_BUSY)
    assert stranger.closed == relay.CLOSE_BUSY  # the stranger is turned away...

    box = ProxiedBox("198.51.100.20")  # ...the real box, from its own address, is not
    task = asyncio.create_task(relay.serve(box))
    await box.say({"t": "hello", "box": s["b"], "key": s["k"], "v": "test"})
    assert (await box.hear("welcome"))["claimed"] is False
    await box.hang_up()
    await asyncio.wait_for(task, timeout=5)


@pytest.mark.parametrize("bad", ["..", ".", ".hidden", "a/b", ""])
async def test_ids_sent_on_to_the_box_are_never_dot_segments(bad):
    import re

    from app.home.router import _ID

    assert not re.match(_ID, bad)
    assert re.match(_ID, "01JABCDEF") and re.match(_ID, "living_room") and re.match(_ID, "a.b-c")


# ------------------------------------------------------------------ every kind of device (Home phase 2, stage 1)

AC = {"id": "climate.ac", "domain": "climate", "name": "AC", "state": "off", "x": {"target": 23, "cur": 26, "min": 16, "max": 30, "step": 1, "modes": ["off", "auto", "cool", "heat"], "fans": ["low", "high", "auto"], "fan": "auto", "last": "cool", "can": ["temp", "fan", "off", "on"], "sys": "climate.ac"}}
ZONE = {"id": "climate.bed", "domain": "climate", "name": "Bedroom", "state": "fan_only", "x": {"target": 22, "modes": ["off", "fan_only"], "can": ["temp", "off", "on"], "sys": "climate.ac", "zone": True}}
WIIM = {"id": "media_player.kitchen", "domain": "media_player", "name": "Kitchen", "state": "playing", "cls": "speaker", "x": {"vol": 30, "muted": False, "title": "Song", "artist": "Band", "src": "Wi-Fi", "srcs": ["Wi-Fi", "Line In"], "members": ["media_player.kitchen"], "art": "abc123", "can": ["pause", "vol", "mute", "next", "src", "stop", "play", "group"]}}
WIIM2 = {"id": "media_player.lounge", "domain": "media_player", "name": "Lounge", "state": "idle", "cls": "speaker", "x": {"vol": 20, "can": ["pause", "vol", "play", "group"]}}
TV = {"id": "media_player.tv", "domain": "media_player", "name": "TV", "state": "off", "cls": "tv", "x": {"can": ["on", "off", "vol"]}}
ROBOT = {"id": "vacuum.robot", "domain": "vacuum", "name": "Robot", "state": "docked", "x": {"bat": 90, "can": ["start", "dock", "pause"]}}
MOVIE = {"id": "scene.movie", "domain": "scene", "name": "Movie night", "state": "2026-11-16T10:00:00+00:00"}
CEILING = {"id": "fan.ceiling", "domain": "fan", "name": "Ceiling fan", "state": "on", "x": {"pct": 50, "osc": False, "can": ["speed"]}}
MOWER = {"id": "lawn_mower.back", "domain": "lawn_mower", "name": "Mower", "state": "docked"}
ALARM = {"id": "alarm_control_panel.house", "domain": "alarm_control_panel", "name": "Alarm", "state": "disarmed"}


async def test_air_con_speakers_a_vacuum_and_a_scene_are_controlled_and_checked(user, client):
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [AC, ZONE, WIIM, WIIM2, TV, ROBOT, MOVIE, CEILING, MOWER, ALARM])
    url, base = f"/api/home/{home_id}/act", {"box_id": prepared["box"]["id"]}
    good = [
        {"entity_id": "climate.ac", "action": "turn_on"},
        {"entity_id": "climate.ac", "action": "turn_off"},
        {"entity_id": "climate.ac", "action": "mode", "value": "cool"},
        {"entity_id": "climate.ac", "action": "fan", "value": "high"},
        {"entity_id": "climate.ac", "action": "temperature", "value": 24},
        {"entity_id": "climate.bed", "action": "turn_off"},
        {"entity_id": "media_player.kitchen", "action": "next"},
        {"entity_id": "media_player.kitchen", "action": "mute", "value": True},
        {"entity_id": "media_player.kitchen", "action": "source", "value": "Line In"},
        {"entity_id": "media_player.kitchen", "action": "join", "value": ["media_player.lounge"]},
        {"entity_id": "media_player.lounge", "action": "unjoin"},
        {"entity_id": "media_player.tv", "action": "turn_on"},
        {"entity_id": "vacuum.robot", "action": "start"},
        {"entity_id": "vacuum.robot", "action": "dock"},
        {"entity_id": "scene.movie", "action": "run"},
    ]
    side = asyncio.create_task(_answer(box, n=len(good)))
    for body in good:
        assert (await client.post(url, headers=_hdr(user), json={**base, **body})).status_code == 200, body
    asked = [a["args"] for a in await side]
    assert [(a["entity"], a["action"], a["value"]) for a in asked] == [(b["entity_id"], b["action"], b.get("value")) for b in good]
    for bad in (
        {"entity_id": "climate.ac", "action": "mode", "value": "dry"},  # not one of its modes
        {"entity_id": "climate.ac", "action": "fan", "value": "turbo"},  # not one of its fan speeds
        {"entity_id": "climate.ac", "action": "temperature", "value": 12},  # below what it can be set to
        {"entity_id": "climate.bed", "action": "fan", "value": "low"},  # a zone has no fan of its own
        {"entity_id": "media_player.kitchen", "action": "prev"},  # it didn't say it can
        {"entity_id": "media_player.kitchen", "action": "source", "value": "Bluetooth"},
        {"entity_id": "media_player.kitchen", "action": "mute", "value": "yes"},
        {"entity_id": "media_player.kitchen", "action": "turn_off"},  # a speaker with no power button
        {"entity_id": "media_player.kitchen", "action": "join", "value": ["media_player.tv"]},  # the TV can't be grouped
        {"entity_id": "media_player.kitchen", "action": "join", "value": ["media_player.kitchen"]},  # itself
        {"entity_id": "media_player.kitchen", "action": "join", "value": ["light.lamp"]},
        {"entity_id": "media_player.lounge", "action": "next"},
        {"entity_id": "media_player.tv", "action": "play"},
        {"entity_id": "vacuum.robot", "action": "locate"},
        {"entity_id": "vacuum.robot", "action": "turn_on"},
        {"entity_id": "fan.ceiling", "action": "oscillate", "value": True},  # this fan doesn't turn its head
        {"entity_id": "scene.movie", "action": "turn_off"},
        {"entity_id": "lawn_mower.back", "action": "start"},  # shown, with nothing to press yet
        {"entity_id": "alarm_control_panel.house", "action": "disarm"},
    ):
        assert (await client.post(url, headers=_hdr(user), json={**base, **bad})).status_code == 400, bad
    await box.hang_up()
    await task


async def test_a_kind_we_have_no_controls_for_is_still_shown_and_an_alarm_asks_first(user, client):
    await _turn_on(client, user)
    _prepared, _home_id, box, task = await _home_with(client, user, user, [MOWER, ALARM, ROBOT, MOVIE, AC, ZONE])
    got = {e["id"]: e for e in (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]["entities"]}
    assert got["lawn_mower.back"]["state"] == "docked" and got["lawn_mower.back"]["can_switch"] is False
    assert got["alarm_control_panel.house"]["careful"] is True and got["vacuum.robot"]["careful"] is False
    # A ducted system's zones say which unit they belong to.
    assert got["climate.bed"]["x"]["zone"] is True and got["climate.bed"]["x"]["sys"] == "climate.ac" and got["climate.ac"]["x"]["last"] == "cool"
    await box.hang_up()
    await task


def test_a_box_cannot_send_a_kind_of_thing_with_a_made_up_name_or_oversized_extras():
    from app.home import relay

    assert relay.clean_entity({"id": "Bad Domain.x", "domain": "Bad Domain", "name": "x", "state": "on"}) is None
    assert relay.clean_entity({"id": "a" * 40 + ".x", "domain": "a" * 40, "name": "x", "state": "on"}) is None
    x = relay.clean_entity({"id": "media_player.a", "domain": "media_player", "name": "a", "state": "playing", "x": {
        "srcs": ["s" * 200] * 100, "members": ["media_player.b"] * 100, "can": ["play", True, {"no": 1}], "artist": "a" * 500, "art": "h" * 99, "zone": "yes", "junk": 1,
    }})["x"]
    assert len(x["srcs"]) == 40 and len(x["srcs"][0]) == 60 and len(x["members"]) == 32 and x["can"] == ["play"]
    assert len(x["artist"]) == 120 and len(x["art"]) == 16 and "zone" not in x and "junk" not in x
    assert relay.can_do({"domain": "media_player", "x": {}}, "next") is True  # an older box doesn't say: taken at its word
    assert relay.can_do({"domain": "media_player", "x": {"can": []}}, "next") is False


async def test_someone_in_another_home_cannot_command_or_see_a_pictures_of_this_ones_devices(user, client, db):
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [WIIM, AC])
    other = await _other(db)
    theirs_prepared = await _prepare(client, user, label="Next door")
    theirs = (await client.post("/api/home/claim", headers=_hdr(other), json={"code": theirs_prepared["claim_code"]})).json()["home_id"]
    mine_box, their_box = prepared["box"]["id"], theirs_prepared["box"]["id"]
    for home, box_id in ((home_id, mine_box), (theirs, mine_box)):
        r = await client.post(f"/api/home/{home}/act", headers=_hdr(other), json={"box_id": box_id, "entity_id": "climate.ac", "action": "turn_on"})
        assert r.status_code == 404, (home, box_id)
        assert (await client.get(f"/api/home/{home}/boxes/{box_id}/art/media_player.kitchen", headers=_hdr(other))).status_code == 404
    # Their own box, asked for this home's speaker: nothing there.
    assert (await client.get(f"/api/home/{theirs}/boxes/{their_box}/art/media_player.kitchen", headers=_hdr(other))).status_code == 404
    await box.hang_up()
    await task


async def test_the_picture_of_what_is_playing_comes_through_only_as_a_small_image(user, client):
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home_with(client, user, user, [WIIM, WIIM2])
    url = f"/api/home/{home_id}/boxes/{prepared['box']['id']}/art"
    png = base64.b64encode(b"\x89PNG fake").decode()
    side = asyncio.create_task(_answer(box, {"type": "image/png", "b64": png}))
    r = await client.get(f"{url}/media_player.kitchen", headers=_hdr(user))
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.headers["x-content-type-options"] == "nosniff" and r.content == b"\x89PNG fake"
    assert [(a["op"], a["args"]) for a in await side] == [("art", {"entity": "media_player.kitchen"})]
    # Nothing playing a picture: not asked for at all. A page as "a picture", or a huge one: refused.
    assert (await client.get(f"{url}/media_player.lounge", headers=_hdr(user))).status_code == 404
    assert (await client.get(f"{url}/light.lamp", headers=_hdr(user))).status_code == 404
    for data in ({"type": "text/html", "b64": png}, {"type": "image/svg+xml", "b64": png}, {"type": "image/png", "b64": base64.b64encode(b"x" * (300 * 1024 + 1)).decode()}, {"type": "image/png", "b64": "not base64!"}):
        side = asyncio.create_task(_answer(box, data))
        assert (await client.get(f"{url}/media_player.kitchen", headers=_hdr(user))).status_code == 404, data["type"]
        await side
    await box.hang_up()
    await task
