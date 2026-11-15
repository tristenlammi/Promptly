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
    assert r.json() == {"enabled": True}


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
    assert (await client.get("/api/home", headers=_hdr(user))).json() == {"homes": []}


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
        ask = await box.hear("call")
        assert (ask["entity"], ask["action"]) == ("light.lamp", "turn_on")
        await box.say({"t": "result", "id": ask["id"], "ok": True})
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
        ask = await box.hear("call")
        await box.say({"t": "result", "id": ask["id"], "ok": False, "error": "The lamp isn't answering."})

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


async def test_guests_switch_things_but_dont_run_the_home(user, client, db):
    await _turn_on(client, user)
    sam, guest = await _other(db), await _other(db)
    prepared = await _prepare(client, user)
    home_id = (await client.post("/api/home/claim", headers=_hdr(sam), json={"code": prepared["claim_code"]})).json()["home_id"]
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": guest.username, "role": "guest"})).status_code == 200
    assert (await client.get("/api/home", headers=_hdr(guest))).json()["homes"][0]["role"] == "guest"
    assert (await client.patch(f"/api/home/{home_id}", headers=_hdr(guest), json={"name": "Mine now"})).status_code == 403
    assert (await client.delete(f"/api/home/{home_id}/boxes/{prepared['box']['id']}", headers=_hdr(guest))).status_code == 403
    second = await _prepare(client, user)
    r = await client.post("/api/home/claim", headers=_hdr(guest), json={"code": second["claim_code"], "home_id": home_id})
    assert r.status_code == 403
    # They can leave; the owner can't.
    assert (await client.delete(f"/api/home/{home_id}/members/{sam.id}", headers=_hdr(sam))).status_code == 409
    assert (await client.delete(f"/api/home/{home_id}/members/{guest.id}", headers=_hdr(guest))).status_code == 200
    assert (await client.get("/api/home", headers=_hdr(guest))).json() == {"homes": []}


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
