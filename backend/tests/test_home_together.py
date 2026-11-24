"""Home: the rules that only exist once managing a home, each person's page
and automations are in the same app.

* Every endpoint of the page-layout and automation routers has a row here,
  so someone decides who may call a new one (the main Home router has its own
  table in ``test_home_manage.py``).
* A co-owner runs a home's automations like the owner does.
* A home that changes hands keeps its automations; a home that is deleted
  takes its automations and everyone's page with it.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select

from tests.test_home import _turn_on, client  # noqa: F401
from tests.test_home_manage import HUE, LOUNGE, _add, _boxes_stop_answering, _delete_account, _home  # noqa: F401
from tests.test_maps_timeline import _hdr, _other

PAGE = {"widgets": [{"id": "w1", "type": "rest", "size": "l"}]}

# (method, path, body). {h} the home, {a} an automation in it, {b} its box.
# Anyone in the home: their own page, and seeing and running its automations.
USING = [
    ("GET", "/api/home/{h}/layout", None),
    ("PUT", "/api/home/{h}/layout", PAGE),
    ("DELETE", "/api/home/{h}/layout", None),
    ("GET", "/api/home/{h}/automations", None),
    ("GET", "/api/home/{h}/automations/{a}", None),
    ("GET", "/api/home/{h}/automations/{a}/runs", None),
    ("POST", "/api/home/{h}/automations/{a}/run", None),
]
# Whoever runs the home: making and changing automations.
SETTING_UP = [
    ("POST", "/api/home/{h}/automations", {"name": "Bedtime"}),
    ("PUT", "/api/home/{h}/automations/{a}", {"name": "Evening"}),
    ("GET", "/api/home/{h}/automations-music?box_id={b}&q=jazz", None),
]
DELETING = ("DELETE", "/api/home/{h}/automations/{a}", None)


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
    r = await client.request(method, _fill(path, words), headers=_hdr(who), json=body)
    return r.status_code


def test_every_page_and_automation_endpoint_is_in_the_table():
    from app.home.auto_router import router as autos
    from app.home.layout import router as layouts

    listed = {
        (m, p.split("?")[0].replace("{h}", "{home_id}").replace("{a}", "{auto_id}"))
        for m, p, _ in USING + SETTING_UP + [DELETING]
    }
    real = {(m, "/api/home" + r.path) for rt in (autos, layouts) for r in rt.routes if hasattr(r, "methods") for m in r.methods if m != "HEAD"}
    assert real - listed == set(), f"not in the permission table: {sorted(real - listed)}"
    assert listed - real == set(), f"in the table but gone: {sorted(listed - real)}"


async def _automation(client, who, home_id: str, name: str = "Movie time") -> str:
    r = await client.post(f"/api/home/{home_id}/automations", headers=_hdr(who), json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_members_use_and_owners_and_co_owners_set_up_pages_and_automations(user, client, db):
    """owner / co-owner / member / someone outside / an admin outside.
    ``user`` is this server's admin, and in no home."""
    await _turn_on(client, user)
    sam, cora, mel, out = [await _other(db) for _ in range(4)]
    prepared, home_id, box = await _home(client, user, sam, areas=[LOUNGE])
    await _add(client, sam, home_id, cora, "coowner")
    await _add(client, sam, home_id, mel)
    auto_id = await _automation(client, sam, home_id)
    words = {"h": home_id, "a": auto_id, "b": prepared["box"]["id"]}

    async def all_of(cases, who) -> set[int]:
        return {await _call(client, who, c, words) for c in cases}

    # Nobody outside the home learns it, its pages or its automations exist, an admin included.
    for stranger in (out, user):
        assert await all_of(USING + SETTING_UP + [DELETING], stranger) == {404}
    # A member: their own page, and seeing and running automations. (An
    # automation with no steps yet says so: a 409, never "not allowed".)
    assert await all_of(USING[:6], mel) == {200}
    assert await _call(client, mel, USING[6], words) in (200, 409)
    assert await all_of(SETTING_UP + [DELETING], mel) == {403}
    listed = (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(mel))).json()
    assert listed["can_edit"] is False and [a["name"] for a in listed["automations"]] == ["Movie time"]
    # A co-owner makes and changes them, like the owner.
    for who in (cora, sam):
        assert await _call(client, who, SETTING_UP[0], words) == 201
        assert await _call(client, who, SETTING_UP[1], words) == 200
        assert await _call(client, who, SETTING_UP[2], words) not in (403, 404)
        assert (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(who))).json()["can_edit"] is True
    assert await _call(client, cora, DELETING, words) == 200
    # A page is its owner's alone: the member's change isn't the owner's page.
    assert (await client.put(f"/api/home/{home_id}/layout", headers=_hdr(mel), json=PAGE)).status_code == 200
    assert (await client.get(f"/api/home/{home_id}/layout", headers=_hdr(sam))).json()["widgets"] is None
    await box.stop()


async def test_a_home_that_changes_hands_keeps_its_automations(user, client, db):
    """They run as the home's owner, so they follow the home: passed on by
    the owner, and again when an admin deletes the new owner's account."""
    from app.tasks.models import Task

    await _turn_on(client, user)
    sam, cora, mel = [await _other(db) for _ in range(3)]
    prepared, home_id, box = await _home(client, user, sam, entries=[HUE])
    await _add(client, sam, home_id, cora, "coowner")
    await _add(client, sam, home_id, mel)
    auto_id = await _automation(client, sam, home_id)

    async def runs_as() -> uuid.UUID | None:
        return (await db.execute(select(Task.user_id).where(Task.id == uuid.UUID(auto_id)))).scalar_one_or_none()

    assert await runs_as() == sam.id
    # Passed on, the old owner leaving: it is the new owner's.
    r = await client.put(f"/api/home/{home_id}/owner", headers=_hdr(sam), json={"user_id": str(mel.id), "leave": True})
    assert r.status_code == 200
    assert await runs_as() == mel.id
    # The new owner's account is deleted: the home goes to the co-owner, and so does it.
    assert await _delete_account(client, user, mel) == 204
    assert await runs_as() == cora.id
    listed = (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(cora))).json()
    assert [a["name"] for a in listed["automations"]] == ["Movie time"] and listed["can_edit"] is True
    await box.stop()


async def test_a_deleted_home_takes_its_automations_and_pages_with_it(user, client, db):
    from app.home.models import HomeLayout
    from app.tasks.models import Task

    await _turn_on(client, user)
    sam, mel = [await _other(db) for _ in range(2)]
    prepared, home_id, box = await _home(client, user, sam, areas=[LOUNGE])
    await _add(client, sam, home_id, mel)
    auto_id = await _automation(client, sam, home_id)
    for who in (sam, mel):
        assert (await client.put(f"/api/home/{home_id}/layout", headers=_hdr(who), json=PAGE)).status_code == 200
    # Something of the owner's that is not this home's stays.
    assert (await client.delete(f"/api/home/{home_id}", headers=_hdr(sam))).status_code == 200
    assert (await db.execute(select(Task.id).where(Task.id == uuid.UUID(auto_id)))).scalar_one_or_none() is None
    assert (await db.execute(select(HomeLayout.user_id).where(HomeLayout.home_id == uuid.UUID(home_id)))).all() == []
    for who in (sam, mel):
        assert (await client.get(f"/api/home/{home_id}/automations", headers=_hdr(who))).status_code == 404
        assert (await client.get(f"/api/home/{home_id}/layout", headers=_hdr(who))).status_code == 404
    await box.task
