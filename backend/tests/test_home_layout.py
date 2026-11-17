"""Promptly Home: each person's own layout of a home's page. It's theirs
alone, only people in the home reach it, nobody has one until they make one,
and it's a list of ids the server never looks up."""
from __future__ import annotations

import json

import pytest

from tests.test_home import LAMP, _dial, _has_snapshot, _prepare, _turn_on, _wait, client  # noqa: F401
from tests.test_maps_timeline import _hdr, _other


def _w(i: int, **more) -> dict:
    return {"id": f"w{i}", "type": "device", "size": "s", "key": "box/light.lamp", **more}


async def _home(client, admin, owner) -> tuple[str, dict]:
    prepared = await _prepare(client, admin)
    home_id = (await client.post("/api/home/claim", headers=_hdr(owner), json={"code": prepared["claim_code"]})).json()["home_id"]
    return home_id, prepared


async def test_nobody_has_a_layout_until_they_make_one_and_reset_takes_it_away(user, client, db):
    await _turn_on(client, user)
    sam = await _other(db)
    home_id, _ = await _home(client, user, sam)
    url = f"/api/home/{home_id}/layout"
    # Someone who was in the home before layouts existed: the page as it comes.
    assert (await client.get(url, headers=_hdr(sam))).json() == {"widgets": None}

    widgets = [
        {"id": "a", "type": "room", "size": "l", "area": "lounge"},
        {"id": "b", "type": "device", "size": "m", "key": "box/light.lamp", "title": "Lamp"},
        {"id": "c", "type": "scenes", "size": "m", "items": ["box/scene.cosy"], "title": "Scenes"},
        {"id": "d", "type": "group", "size": "l", "items": ["box/light.lamp", "box/switch.kettle"], "title": "Favourites"},
        {"id": "e", "type": "music", "size": "m"},
        {"id": "f", "type": "rest", "size": "l"},
    ]
    r = await client.put(url, headers=_hdr(sam), json={"widgets": widgets})
    assert r.status_code == 200, r.text
    assert (await client.get(url, headers=_hdr(sam))).json() == {"widgets": widgets}
    # Saving again replaces it (the order is the order sent).
    again = [widgets[5], widgets[1]]
    assert (await client.put(url, headers=_hdr(sam), json={"widgets": again})).status_code == 200
    assert (await client.get(url, headers=_hdr(sam))).json() == {"widgets": again}
    # An empty page is a layout too (not "the page as it comes").
    assert (await client.put(url, headers=_hdr(sam), json={"widgets": []})).status_code == 200
    assert (await client.get(url, headers=_hdr(sam))).json() == {"widgets": []}

    assert (await client.delete(url, headers=_hdr(sam))).json() == {"widgets": None}
    assert (await client.get(url, headers=_hdr(sam))).json() == {"widgets": None}
    # Resetting twice is fine.
    assert (await client.delete(url, headers=_hdr(sam))).status_code == 200


async def test_each_person_has_their_own_and_nobody_outside_the_home_reaches_it(user, client, db):
    """``user`` is the admin: not in the home, so no layout to read or write."""
    await _turn_on(client, user)
    sam, kim, ann = await _other(db), await _other(db), await _other(db)
    home_id, _ = await _home(client, user, sam)
    other_home, _ = await _home(client, user, ann)
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": kim.username})).status_code == 200
    url = f"/api/home/{home_id}/layout"

    assert (await client.put(url, headers=_hdr(sam), json={"widgets": [_w(1, title="Sam's lamp")]})).status_code == 200
    # Kim is in the home and still has the page as it comes; hers doesn't touch Sam's.
    assert (await client.get(url, headers=_hdr(kim))).json() == {"widgets": None}
    assert (await client.put(url, headers=_hdr(kim), json={"widgets": [_w(2)]})).status_code == 200
    assert (await client.get(url, headers=_hdr(sam))).json()["widgets"][0]["title"] == "Sam's lamp"
    assert (await client.delete(url, headers=_hdr(kim))).status_code == 200
    assert (await client.get(url, headers=_hdr(sam))).json()["widgets"][0]["id"] == "w1"

    for outsider in (ann, user):
        assert (await client.get(url, headers=_hdr(outsider))).status_code == 404
        assert (await client.put(url, headers=_hdr(outsider), json={"widgets": []})).status_code == 404
        assert (await client.delete(url, headers=_hdr(outsider))).status_code == 404
    assert (await client.get(url, headers=_hdr(sam))).json()["widgets"][0]["id"] == "w1"
    # Ann's own home has nothing of Sam's.
    assert (await client.get(f"/api/home/{other_home}/layout", headers=_hdr(ann))).json() == {"widgets": None}

    # Someone who leaves can't read theirs any more.
    assert (await client.put(url, headers=_hdr(kim), json={"widgets": [_w(3)]})).status_code == 200
    assert (await client.delete(f"/api/home/{home_id}/members/{kim.id}", headers=_hdr(kim))).status_code == 200
    assert (await client.get(url, headers=_hdr(kim))).status_code == 404


async def test_a_layout_is_only_ids_and_naming_another_homes_device_shows_nothing_of_it(user, client, db):
    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    sams, p1 = await _home(client, user, sam)
    anns, _ = await _home(client, user, ann)
    box, task = await _dial(p1)
    await box.say({"t": "snapshot", "areas": [{"id": "lounge", "name": "Lounge"}], "entities": [{**LAMP, "name": "Sam's secret lamp"}]})
    await _wait(lambda: _has_snapshot(p1["box"]["id"]))

    # Ann puts Sam's lamp (by its ids) on her own page: she gets her ids back and nothing else.
    key = f"{p1['box']['id']}/light.lamp"
    r = await client.put(f"/api/home/{anns}/layout", headers=_hdr(ann), json={"widgets": [_w(1, key=key), {"id": "r", "type": "room", "size": "l", "area": "lounge"}]})
    assert r.status_code == 200
    text = json.dumps((await client.get(f"/api/home/{anns}/layout", headers=_hdr(ann))).json()) + json.dumps((await client.get("/api/home", headers=_hdr(ann))).json())
    assert "Sam's secret lamp" not in text and "Lounge" not in text
    # ...and it still can't be switched from her home.
    body = {"box_id": p1["box"]["id"], "entity_id": "light.lamp", "action": "turn_on"}
    assert (await client.post(f"/api/home/{anns}/act", headers=_hdr(ann), json=body)).status_code == 404
    await box.hang_up()
    await task
    assert sams != anns


@pytest.mark.parametrize(
    "widgets",
    [
        [{"id": "a", "type": "clock", "size": "s"}],  # a kind there isn't
        [{"id": "a", "type": "device", "size": "xl"}],  # a size there isn't
        [{"id": "a b", "type": "device", "size": "s"}],  # an id that isn't one
        [{"id": "a", "type": "device", "size": "s", "html": "<b>hi</b>"}],  # anything extra
        [{"id": "a", "type": "device", "size": "s", "title": "x" * 61}],
        [{"id": "a", "type": "device", "size": "s", "key": "k" * 201}],
        [{"id": "a", "type": "group", "size": "m", "items": ["k" * 201]}],
        [{"id": "a", "type": "group", "size": "m", "items": ["k"] * 41}],
        [{"id": "a", "type": "device", "size": "s"}, {"id": "a", "type": "music", "size": "m"}],  # the same id twice
        [{"id": f"w{i}", "type": "device", "size": "s"} for i in range(61)],  # too many
        [{"id": f"w{i}", "type": "group", "size": "m", "items": [f"k{n}" for n in range(40)]} for i in range(11)],  # too many devices in all
    ],
)
async def test_a_layout_that_is_not_one_is_refused_and_nothing_is_saved(user, client, db, widgets):
    await _turn_on(client, user)
    sam = await _other(db)
    home_id, _ = await _home(client, user, sam)
    url = f"/api/home/{home_id}/layout"
    assert (await client.put(url, headers=_hdr(sam), json={"widgets": widgets})).status_code == 422
    assert (await client.get(url, headers=_hdr(sam))).json() == {"widgets": None}


async def test_layouts_are_off_with_home(user, client):
    import uuid

    assert (await client.get(f"/api/home/{uuid.uuid4()}/layout", headers=_hdr(user))).status_code == 404


async def test_a_home_that_goes_takes_its_layouts_with_it(user, client, db):
    from sqlalchemy import delete, func, select

    from app.home.models import Home, HomeLayout

    await _turn_on(client, user)
    sam = await _other(db)
    home_id, _ = await _home(client, user, sam)
    assert (await client.put(f"/api/home/{home_id}/layout", headers=_hdr(sam), json={"widgets": [_w(1)]})).status_code == 200
    assert (await db.execute(select(func.count()).select_from(HomeLayout))).scalar_one() == 1
    await db.execute(delete(Home).where(Home.id == Home.id))
    await db.commit()
    assert (await db.execute(select(func.count()).select_from(HomeLayout))).scalar_one() == 0
