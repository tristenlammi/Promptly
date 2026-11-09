"""Notes N2.3: the Meal Planner's grocery list → a note.

* where it goes: the note you pick, else your Shopping note, else a new
  "Groceries" list kept by aisle;
* sending twice adds nothing twice; an amount change updates the item; ticked
  in Meal Plan → ticked; gone from the list → removed; a new week starts over;
  items people typed are never touched;
* a version is kept first, so Undo brings the note back;
* a stranger's note is a 404, and chat can do it through ``use_item``.
"""
from __future__ import annotations

import uuid

import pytest

from app.items import service as items
from tests.test_cross_app import mk_item
from tests.test_notes_chat_tools import ctx
from tests.test_notes_core import H, client, get, live, mk_user, new_list, new_note, share  # noqa: F401 — fixtures


def gi(i, name, aisle, qty=None, unit="", checked=False):
    return {"id": i, "name": name, "key": name.lower(), "aisle": aisle, "checked": checked, "source": "plan",
            "amounts": [{"qty": qty, "unit": unit}] if qty else [], "recipes": ["Tacos"]}


WEEK = {"start": "2026-11-02", "end": "2026-11-08"}


async def plan(db, u, rows, week=WEEK):
    return await mk_item(db, u, "mealplan", {"grocery": {**week, "items": rows}})


async def set_grocery(db, u, plan_id, rows, week=WEEK):
    row, doc, _ = await items.load(db, u, plan_id, need="edit", lock=True)
    d = dict(doc.data)
    d["grocery"] = {**d["grocery"], **week, "items": rows}
    await items.save_data(db, u, row, doc, d, base_revision=None)
    await db.commit()


async def send(client, u, plan_id, note_id=None, code=200):  # noqa: F811
    r = await client.post(f"/api/crossapp/mealplan/{plan_id}/to-note", headers=H(u), json={"note_id": note_id} if note_id else {})
    assert r.status_code == code, r.text
    return r.json()


def texts(note) -> list[str]:
    return [i["text"] for i in sorted(note["items"], key=lambda i: i["position"])]


def ticked(note) -> set[str]:
    return {i["text"] for i in note["items"] if i["checked"]}


# ------------------------------------------------------------------ where it goes


async def test_a_new_groceries_note_when_you_have_no_shopping_note(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    p = await plan(db, ann, [gi("1", "Milk", "dairy", 2, "l"), gi("2", "Limes", "produce", 3)])
    assert (await client.get("/api/crossapp/mealplan/note-target", headers=H(ann))).json() == {"note": None, "new_title": "Groceries"}
    out = await send(client, ann, p)
    assert out["made"] is True and out["added"] == 2 and out["version_id"] is None
    note = await get(client, ann, out["note_id"])
    assert note["title"] == "Groceries" and note["kind"] == "list" and note["color"] == "sage" and note["is_owner"]
    assert note["list_opts"]["aisles"] is True
    assert [t.split(" (")[0] for t in texts(note)] == ["Limes", "Milk"]
    assert all(i["from_plan"] for i in note["items"])
    # Next time the same note is used (it's called Groceries now).
    target = (await client.get("/api/crossapp/mealplan/note-target", headers=H(ann))).json()
    assert target["note"]["id"] == out["note_id"]


async def test_your_shared_shopping_note_and_the_family_sees_it_live(client, db, live):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    shop = await new_list(client, bob, title="Shopping", items=("Coffee",))
    await share(client, bob, shop["id"], ann)
    p = await plan(db, ann, [gi("1", "Milk", "dairy", 2, "l")])
    live.clear()
    out = await send(client, ann, p)
    assert out["note_id"] == shop["id"] and out["made"] is False
    # Everyone on the note heard about it (after commit).
    import asyncio

    await asyncio.sleep(0.05)
    heard = set().union(*(who for who, ev in live if ev.get("id") == shop["id"])) if live else set()
    assert {str(ann.id), str(bob.id)} <= heard
    assert "Coffee" in texts(await get(client, bob, shop["id"]))


async def test_a_picked_note_and_a_strangers_note_is_404(client, db, live):  # noqa: F811
    ann, cat = await mk_user(db, "ann"), await mk_user(db, "cat")
    mine = await new_list(client, ann, title="Camping food", items=())
    theirs = await new_list(client, cat, title="Cat's", items=())
    text_note = await new_note(client, ann, title="Ideas")
    p = await plan(db, ann, [gi("1", "Milk", "dairy", 2, "l")])
    out = await send(client, ann, p, note_id=mine["id"])
    assert out["note_id"] == mine["id"]
    await send(client, ann, p, note_id=theirs["id"], code=404)
    assert (await send(client, ann, p, note_id=text_note["id"], code=400))["detail"].startswith("That note isn't a checklist")
    # Someone else's meal plan is 404 too.
    await send(client, cat, p, code=404)


# ------------------------------------------------------------------ sending again


async def test_sending_again_merges_and_never_touches_typed_items(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    shop = await new_list(client, ann, title="Shopping", items=("Coffee",))
    p = await plan(db, ann, [gi("1", "Milk", "dairy", 2, "l"), gi("2", "Limes", "produce", 3), gi("3", "Tortillas", "bakery", 1, "pack")])
    first = await send(client, ann, p)
    assert first["added"] == 3 and first["version_id"]
    again = await send(client, ann, p)
    assert (again["added"], again["updated"], again["ticked"], again["removed"]) == (0, 0, 0, 0)
    assert again["version_id"] is None  # nothing new, nothing to undo
    note = await get(client, ann, shop["id"])
    assert len(note["items"]) == 4

    # More milk, limes bought, tortillas gone, eggs new.
    await set_grocery(db, ann, p, [gi("1", "Milk", "dairy", 3, "l"), gi("2", "Limes", "produce", 3, checked=True), gi("4", "Eggs", "dairy", 12)])
    out = await send(client, ann, p)
    assert (out["added"], out["updated"], out["ticked"], out["removed"]) == (1, 1, 1, 1)
    note = await get(client, ann, shop["id"])
    names = {t.split(" (")[0] for t in texts(note)}
    assert names == {"Coffee", "Milk", "Limes", "Eggs"}
    assert any(t.startswith("Milk (3") for t in texts(note))
    assert {t.split(" (")[0] for t in ticked(note)} == {"Limes"}
    coffee = next(i for i in note["items"] if i["text"] == "Coffee")
    assert coffee["from_plan"] is False

    # Undo: the version kept before the send brings the note back.
    r = await client.post(f"/api/notes/{shop['id']}/versions/{out['version_id']}/restore", headers=H(ann))
    assert r.status_code == 200
    back = r.json()["note"]
    assert {t.split(" (")[0] for t in texts(back)} == {"Coffee", "Milk", "Limes", "Tortillas"}
    reasons = [v["reason"] for v in (await client.get(f"/api/notes/{shop['id']}/versions", headers=H(ann))).json()["versions"]]
    assert "send" in reasons


async def test_a_new_week_clears_last_weeks_items(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    shop = await new_list(client, ann, title="Shopping", items=("Coffee",))
    p = await plan(db, ann, [gi("1", "Milk", "dairy", 2, "l"), gi("2", "Limes", "produce", 3, checked=False)])
    await send(client, ann, p)
    note = await get(client, ann, shop["id"])
    limes = next(i for i in note["items"] if i["text"].startswith("Limes"))
    await client.patch(f"/api/notes/{shop['id']}/items/{limes['id']}", headers=H(ann), json={"checked": True})
    nxt = {"start": "2026-11-09", "end": "2026-11-15"}
    await set_grocery(db, ann, p, [gi("1", "Milk", "dairy", 1, "l")], week=nxt)
    out = await send(client, ann, p)
    assert out["added"] == 1 and out["removed"] == 2
    note = await get(client, ann, shop["id"])
    assert {t.split(" (")[0] for t in texts(note)} == {"Coffee", "Milk"}


async def test_an_empty_list_is_refused(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    p = await plan(db, ann, [gi("1", "Milk", "dairy", checked=True)])
    out = await send(client, ann, p, code=400)
    assert "empty" in out["detail"]


# ------------------------------------------------------------------ the action and chat


async def test_the_meal_plan_action_and_chat_use_item(client, db, live):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.items import UseItemTool

    ann = await mk_user(db, "ann")
    shop = await new_list(client, ann, title="Groceries", items=())
    p = await plan(db, ann, [gi("1", "Milk", "dairy", 2, "l")])
    r = await client.post(f"/api/items/{p}/actions/send_grocery_list_to_note", headers=H(ann), json={})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["note_id"] == shop["id"] and r.json()["summary"].startswith("1 to buy")

    await set_grocery(db, ann, p, [gi("1", "Milk", "dairy", 2, "l"), gi("2", "Eggs", "dairy", 6)])
    out = await UseItemTool().run(ctx(db, ann), {"file_id": str(p), "action": "send_grocery_list_to_note"})
    assert "Groceries" in out.content
    assert {t.split(" (")[0] for t in texts(await get(client, ann, shop["id"]))} == {"Milk", "Eggs"}
    # A write: refused on a turn that read someone else's words.
    with pytest.raises(ToolError):
        await UseItemTool().run(ctx(db, ann, {"untrusted": True}), {"file_id": str(p), "action": "send_grocery_list_to_note"})
    _ = uuid
