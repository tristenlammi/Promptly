"""Notes N2.2: shopping lists by aisle.

* Sort by aisle: store order, then A–Z; children stay under their parent and
  take its aisle; unknown things are "Other", at the end;
* Keep sorted by aisle: whatever adds an item — the web, the widget, chat,
  "my shopping list" — puts it after the last item of its aisle; an item put
  in a place takes the aisle of the one above;
* the store order is the Meal Plan order of whoever chose to sort, kept on
  the note, so it doesn't change with who adds;
* dragging an item across an aisle line moves it (and its own items) to that
  aisle.
"""
from __future__ import annotations

import uuid

from tests.test_cross_app import mk_item
from tests.test_notes_chat_tools import ctx
from tests.test_notes_core import H, client, get, live, mk_user, new_list, share  # noqa: F401 — fixtures
from tests.test_notes_widget_capture import _device


def texts(note) -> list[str]:
    return [i["text"] for i in sorted(note["items"], key=lambda i: i["position"])]


def aisles(note) -> dict[str, str | None]:
    return {i["text"]: i["aisle"] for i in note["items"]}


async def bulk(client, u, nid, action):  # noqa: F811
    r = await client.post(f"/api/notes/{nid}/items/bulk", headers=H(u), json={"action": action})
    assert r.status_code == 200, r.text
    return r.json()


async def keep_sorted(client, u, note, on=True):  # noqa: F811
    r = await client.patch(f"/api/notes/{note['id']}", headers=H(u), json={"base_revision": note["revision"], "list_opts": {**note["list_opts"], "aisles": on}})
    assert r.status_code == 200, r.text
    return r.json()["note"]


async def add(client, u, nid, text, **kw):  # noqa: F811
    r = await client.post(f"/api/notes/{nid}/items", headers=H(u), json={"id": str(uuid.uuid4()), "text": text, **kw})
    assert r.status_code == 201, r.text
    return r.json()["item"]


# ------------------------------------------------------------------ sort by aisle


async def test_sort_by_aisle_keeps_children_and_puts_unknowns_last(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    n = await new_list(client, ann, items=("Milk", "Gizmo", "Bread", "Apples"))
    bread = next(i for i in n["items"] if i["text"] == "Bread")
    await add(client, ann, n["id"], "sourdough", after_id=bread["id"], parent_id=bread["id"])

    await bulk(client, ann, n["id"], "sort_aisle")
    n = await get(client, ann, n["id"])
    assert texts(n) == ["Apples", "Bread", "sourdough", "Milk", "Gizmo"]
    assert aisles(n) == {"Apples": "produce", "Bread": "bakery", "sourdough": "bakery", "Milk": "dairy", "Gizmo": "other"}
    # The order it used is kept on the note, for everyone who adds later.
    assert n["list_opts"]["aisle_order"][:3] == ["produce", "bakery", "meat"]
    # Sorting again changes nothing (and keeps no new version).
    before = n["change_seq"]
    await bulk(client, ann, n["id"], "sort_aisle")
    assert (await get(client, ann, n["id"]))["change_seq"] == before


async def test_the_order_is_the_choosers_meal_plan_store_order(client, db, live):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    # Ann's shop: dairy at the door, then produce.
    await mk_item(db, ann, "mealplan", {"preferences": {"aisle_order": ["dairy", "produce"]}})
    n = await new_list(client, ann, items=("Apples", "Bread", "Milk"))
    await share(client, ann, n["id"], bob)
    n = await keep_sorted(client, ann, n)
    assert texts(n) == ["Milk", "Apples", "Bread"]
    assert n["list_opts"]["aisle_order"][:3] == ["dairy", "produce", "bakery"]
    # Bob adds: Ann's order still decides (it's the note's now).
    await add(client, bob, n["id"], "Cheddar cheese")
    await add(client, bob, n["id"], "Bananas")
    assert texts(await get(client, bob, n["id"])) == ["Milk", "Cheddar cheese", "Apples", "Bananas", "Bread"]


# ------------------------------------------------------------------ keep sorted


async def test_kept_sorted_every_way_of_adding_lands_in_its_aisle(client, db, live):  # noqa: F811
    from app.chat.tools.notes import AddToNoteTool

    ann = await mk_user(db, "ann")
    n = await new_list(client, ann, title="Shopping", items=("Frozen peas", "Bread", "Apples"))
    n = await keep_sorted(client, ann, n)
    assert texts(n) == ["Apples", "Bread", "Frozen peas"]

    # The web, with no place given.
    await add(client, ann, n["id"], "Milk")
    # The One note widget's +.
    auth = await _device(db, ann, ["widgets"])
    r = await client.post(f"/api/widgets/notes/{n['id']}/items", auth=auth, json={"client_id": str(uuid.uuid4()), "text": "Cheddar cheese"})
    assert r.status_code in (200, 201), r.text
    # Chat, by the note's id, and as "my shopping list".
    await AddToNoteTool().run(ctx(db, ann), {"note": n["id"], "items": ["Yoghurt"]})
    await AddToNoteTool().run(ctx(db, ann), {"note": "shopping list", "items": ["Butter", "Sprocket"]})

    n = await get(client, ann, n["id"])
    order = texts(n)
    dairy = order[order.index("Bread") + 1: order.index("Frozen peas")]
    assert set(dairy) == {"Milk", "Cheddar cheese", "Yoghurt", "Butter"}
    assert order[-1] == "Sprocket" and aisles(n)["Sprocket"] == "other"
    assert all(aisles(n)[t] == "dairy" for t in dairy)


async def test_an_item_put_in_a_place_takes_that_aisle(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    n = await keep_sorted(client, ann, await new_list(client, ann, items=("Apples", "Milk")))
    apples = next(i for i in n["items"] if i["text"] == "Apples")
    # Enter after Apples: an empty item, in Produce, right there.
    item = await add(client, ann, n["id"], "", after_id=apples["id"])
    assert item["aisle"] == "produce"
    assert texts(await get(client, ann, n["id"])) == ["Apples", "", "Milk"]
    # A child takes its parent's aisle.
    kid = await add(client, ann, n["id"], "green ones", after_id=apples["id"], parent_id=apples["id"])
    assert kid["aisle"] == "produce"


async def test_dragging_across_an_aisle_line_changes_the_aisle(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    n = await keep_sorted(client, ann, await new_list(client, ann, items=("Apples", "Milk", "Frozen peas")))
    apples = next(i for i in n["items"] if i["text"] == "Apples")
    await add(client, ann, n["id"], "green ones", after_id=apples["id"], parent_id=apples["id"])
    r = await client.patch(f"/api/notes/{n['id']}/items/{apples['id']}", headers=H(ann), json={"aisle": "frozen", "position": 99})
    assert r.status_code == 200 and r.json()["item"]["aisle"] == "frozen"
    n = await get(client, ann, n["id"])
    assert aisles(n)["green ones"] == "frozen"
    # Something added to Produce later goes before Dairy, not after Apples.
    await add(client, ann, n["id"], "Bananas")
    assert texts(await get(client, ann, n["id"]))[0] == "Bananas"
    r = await client.patch(f"/api/notes/{n['id']}/items/{apples['id']}", headers=H(ann), json={"aisle": "moon"})
    assert r.status_code == 400


async def test_turning_it_off_leaves_the_list_and_adds_go_to_the_end(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    n = await keep_sorted(client, ann, await new_list(client, ann, items=("Milk", "Apples")))
    n = await keep_sorted(client, ann, n, on=False)
    assert texts(n) == ["Apples", "Milk"]
    await add(client, ann, n["id"], "Bananas")
    assert texts(await get(client, ann, n["id"])) == ["Apples", "Milk", "Bananas"]
    # A bad store order is refused.
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": n["revision"], "list_opts": {"aisle_order": "dairy"}})
    assert r.status_code == 400


async def test_restoring_the_version_from_before_a_sort_brings_the_old_order_back(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    n = await new_list(client, ann, items=("Milk", "Apples"))
    await bulk(client, ann, n["id"], "sort_aisle")
    versions = (await client.get(f"/api/notes/{n['id']}/versions", headers=H(ann))).json()["versions"]
    assert versions
    # Restoring the newest version keeps each item's aisle as it was then.
    r = await client.post(f"/api/notes/{n['id']}/versions/{versions[0]['id']}/restore", headers=H(ann))
    assert r.status_code == 200
    restored = r.json()["note"]
    assert texts(restored) == ["Milk", "Apples"]
