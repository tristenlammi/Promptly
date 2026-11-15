"""This server's own home box (``app/home/builtin.py``): bundled with the
deployment, so there's nothing to prepare and nothing to claim. Turning
Promptly Home on puts it in a home the admin who did it owns; nobody else
sees that home, other admins included."""
from __future__ import annotations

import asyncio
import json
import uuid

import httpx
import pytest

from tests.test_home import LAMP, FakeBox, _wait
from tests.test_maps_timeline import _hdr, _other

SECRET = "s3cret-" + "x" * 40


@pytest.fixture
async def client(db, monkeypatch):
    from app import rate_limit
    from app.home import builtin, relay
    from app.main import app

    relay.reset()
    monkeypatch.setattr(builtin, "secret", lambda: SECRET)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True
        relay.reset()


async def _admin(db):
    from app.auth.models import User

    row = User(email=f"a-{uuid.uuid4().hex[:8]}@example.com", username=f"a{uuid.uuid4().hex[:6]}", password_hash="x", role="admin", settings={})
    db.add(row)
    await db.commit()
    return row


async def _dial(key: str = SECRET) -> tuple[FakeBox, asyncio.Task]:
    from app.home import builtin, relay

    box = FakeBox()
    task = asyncio.create_task(relay.serve(box))
    await box.say({"t": "hello", "box": str(builtin.BOX_ID), "key": key, "v": "test"})
    return box, task


def _live() -> bool:
    from app.home import builtin, relay

    link = relay.link(builtin.BOX_ID)
    return link is not None and link.got_snapshot


async def _on(client, admin) -> dict:
    r = await client.patch("/api/admin/home/settings", headers=_hdr(admin), json={"enabled": True})
    assert r.status_code == 200, r.text
    return r.json()


async def test_turning_home_on_is_the_whole_set_up(user, client, db):
    """``user`` is the admin. No box prepared, no code typed."""
    assert (await client.get("/api/admin/home/settings", headers=_hdr(user))).json() == {"enabled": False, "bundled": True, "box_online": False, "box_ready": False}
    assert (await _on(client, user))["enabled"] is True

    got = (await client.get("/api/home", headers=_hdr(user))).json()
    assert got["bundled"] is True
    (home,) = got["homes"]
    assert (home["name"], home["role"]) == ("Home", "owner") and [m["id"] for m in home["members"]] == [str(user.id)]
    (box,) = home["boxes"]
    # Home Assistant hasn't dialled in yet: it's starting, not broken.
    assert (box["builtin"], box["online"], box["ready"], box["name"]) == (True, False, False, "This server")

    live, task = await _dial()
    assert (await live.hear("welcome"))["claimed"] is True
    await live.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await _wait(_live)
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert home["boxes"][0]["ready"] is True and [e["id"] for e in home["entities"]] == ["light.lamp"]
    status = (await client.get("/api/admin/home/settings", headers=_hdr(user))).json()
    assert (status["box_online"], status["box_ready"]) == (True, True)
    # Turning it on again (or off and on) makes no second home.
    await client.patch("/api/admin/home/settings", headers=_hdr(user), json={"enabled": False})
    await _on(client, user)
    assert len((await client.get("/api/home", headers=_hdr(user))).json()["homes"]) == 1
    await live.hang_up()
    await task


async def test_the_box_dials_in_first_then_home_is_turned_on(user, client, db):
    live, task = await _dial()
    assert (await live.hear("welcome"))["claimed"] is False
    await live.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await _wait(_live)
    await _on(client, user)
    assert (await live.hear("claimed")) == {"t": "claimed"}
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert home["boxes"][0]["ready"] is True and [e["id"] for e in home["entities"]] == ["light.lamp"]
    await live.hang_up()
    await task


async def test_home_was_already_on_when_the_box_first_arrived(user, client, db, monkeypatch):
    """An update brings the bundled box to a server that had Home on: it goes
    to the server's first admin, with nothing for them to do."""
    from app.home import builtin

    monkeypatch.setattr(builtin, "secret", lambda: "")
    await _on(client, user)
    assert (await client.get("/api/home", headers=_hdr(user))).json() == {"homes": [], "bundled": False}
    monkeypatch.setattr(builtin, "secret", lambda: SECRET)
    live, task = await _dial()
    assert (await live.hear("welcome"))["claimed"] is True
    home = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]
    assert (home["name"], home["role"], home["boxes"][0]["builtin"]) == ("Home", "owner", True)
    await live.hang_up()
    await task


async def test_only_the_right_secret_is_this_servers_box(user, client, monkeypatch):
    from app.home import builtin

    wrong, task = await _dial("not-the-secret-" + "y" * 30)
    await task
    assert wrong.closed == 4401
    # A deployment without the bundled box has no built-in box at all.
    monkeypatch.setattr(builtin, "secret", lambda: "")
    none, task = await _dial("")
    await task
    assert none.closed == 4401
    also, task = await _dial(SECRET)
    await task
    assert also.closed == 4401


async def test_nobody_else_sees_it_other_admins_included(user, client, db):
    from app.home import builtin

    await _on(client, user)
    other_admin, sam = await _admin(db), await _other(db)
    live, task = await _dial()
    await live.say({"t": "snapshot", "areas": [], "entities": [LAMP]})
    await _wait(_live)
    home_id = (await client.get("/api/home", headers=_hdr(user))).json()["homes"][0]["id"]
    bid = str(builtin.BOX_ID)
    body = {"box_id": bid, "entity_id": "light.lamp", "action": "turn_on"}
    for who in (other_admin, sam):
        assert (await client.get("/api/home", headers=_hdr(who))).json()["homes"] == []
        assert (await client.get(f"/api/home/{home_id}/state", headers=_hdr(who))).status_code == 404
        assert (await client.post(f"/api/home/{home_id}/act", headers=_hdr(who), json=body)).status_code == 404
        assert (await client.get(f"/api/home/{home_id}/boxes/{bid}/connected", headers=_hdr(who))).status_code == 404
        assert (await client.post(f"/api/home/{home_id}/boxes/{bid}/setup", headers=_hdr(who), json={"brand": "hue"})).status_code == 404
    # What an admin who isn't in the home can learn: that the box is up. Nothing about the home.
    said = json.dumps(
        [
            (await client.get("/api/admin/home/settings", headers=_hdr(other_admin))).json(),
            (await client.get("/api/admin/home/boxes", headers=_hdr(other_admin))).json(),
        ]
    )
    for leak in ("light.lamp", "Lamp", home_id, str(user.id), user.username, bid):
        assert leak not in said
    # ...and it isn't one of the boxes an admin manages.
    for call in (
        client.post(f"/api/admin/home/boxes/{bid}/revoke", headers=_hdr(other_admin), json={}),
        client.post(f"/api/admin/home/boxes/{bid}/setup", headers=_hdr(other_admin), json={}),
        client.post(f"/api/admin/home/boxes/{bid}/claim-code", headers=_hdr(other_admin)),
        client.delete(f"/api/admin/home/boxes/{bid}", headers=_hdr(other_admin)),
    ):
        assert (await call).status_code == 404
    # Once added, a member sees it; and the box can't be moved out of the home.
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(user), json={"username": sam.username})).status_code == 200
    assert [e["id"] for e in (await client.get("/api/home", headers=_hdr(sam))).json()["homes"][0]["entities"]] == ["light.lamp"]
    assert (await client.delete(f"/api/home/{home_id}/boxes/{bid}", headers=_hdr(user))).status_code == 409
    await live.hang_up()
    await task


async def test_an_admin_who_looks_gets_it_going_if_nobody_has(user, client, db):
    """Home is on, the bundled box has never dialled in and has no home (its
    owner's account is gone, say): the admin who opens Home becomes its owner."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID) or AppSettings(id=SINGLETON_APP_SETTINGS_ID)
    row.home_enabled = True
    db.add(row)
    await db.commit()
    sam = await _other(db)
    assert (await client.get("/api/home", headers=_hdr(sam))).json()["homes"] == []  # not for someone who isn't an admin
    (home,) = (await client.get("/api/home", headers=_hdr(user))).json()["homes"]
    assert home["role"] == "owner" and home["boxes"][0]["builtin"] is True
