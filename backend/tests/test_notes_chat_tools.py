"""Notes N1.5: the chat tools (category ``notes``).

* find / read only notes you can open;
* a note with other people's words marks the turn untrusted (memory doesn't
  learn from it, and it can't steer a write in the same turn) and is framed
  as data; your own notes don't;
* every write is refused on an untrusted turn, through the shared guard;
* "my shopping list" goes to your Shopping/Groceries note (yours or shared
  with you), otherwise to the Shopping list in Tasks.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_notes_access import world  # noqa: F401 — fixture
from tests.test_notes_core import H, client, get, live, mk_user, new_list, new_note, pushes, share  # noqa: F401 — fixtures


def ctx(db, u, turn=None):  # noqa: ANN001
    from app.chat.tools.base import ToolContext, TurnState

    t = TurnState()
    t.update(turn or {})
    return ToolContext(db=db, user=u, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn=t)


def tools():
    from app.chat.tools import notes as T

    return T.FindNotesTool(), T.ReadNoteTool(), T.CreateNoteTool(), T.AddToNoteTool(), T.TickNoteItemsTool()


async def tasks_shopping(db, u):  # noqa: ANN001
    from app.items import service as items

    found = await items.list_items(db, u, "tasks", limit=1, archives=False)
    if not found:
        return []
    data = found[0][1].data
    shop = next((x["id"] for x in data["lists"] if x["name"] == "Shopping"), None)
    return [t["title"] for t in data["tasks"] if t["list_id"] == shop]


async def test_the_tools_are_offered_as_their_own_category():
    from app.chat.tools.prompt import build_tools_system_prompt
    from app.chat.tools.registry import tools_in

    assert {t.name for t in tools_in({"notes"})} == {"find_notes", "read_note", "create_note", "add_to_note", "tick_note_items"}
    p = build_tools_system_prompt({"apps", "notes"})
    assert "add_to_note" in p and "shopping list" in p
    assert "add_to_note" not in build_tools_system_prompt({"apps", "calendar"})


async def test_find_and_read_only_what_you_can_open(db, world):  # noqa: F811
    from app.chat.tools.base import ToolError

    w = world
    find, read, *_ = tools()
    for who in ("ann", "bob"):
        out = await find.run(ctx(db, w[who]), {"query": "oat milk"})
        assert w["note"]["id"] in out.content, who
    for who in ("cat", "dan"):
        c = ctx(db, w[who])
        out = await find.run(c, {"query": "oat milk"})
        assert "Shopping" not in out.content and w["note"]["id"] not in out.content
        for ref in (w["note"]["id"], "Shopping list", "shopping list", w["trashed"]["id"], "Old bills"):
            with pytest.raises(ToolError):
                await read.run(c, {"note": ref})
        assert not c.turn.get("untrusted")
    # Trashed notes aren't found, even by their owner.
    out = await find.run(ctx(db, w["ann"]), {"query": "old bills"})
    assert w["trashed"]["id"] not in out.content
    # By label (each person's own labels).
    out = await find.run(ctx(db, w["ann"]), {"label": "#home"})
    assert w["note"]["id"] in out.content
    out = await find.run(ctx(db, w["bob"]), {"label": "home"})
    assert w["note"]["id"] not in out.content


async def test_other_peoples_words_mark_the_turn_and_yours_dont(client, db, world):  # noqa: F811
    w = world
    find, read, *_ = tools()
    mine = await new_note(client, w["cat"], title="Gate", text="Gate code 4471")
    c = ctx(db, w["cat"])
    out = await read.run(c, {"note": "Gate"})
    assert "4471" in out.content and "untrusted_content" not in out.content
    out = await find.run(c, {"query": "gate"})
    assert not c.turn.get("untrusted")
    # Bob reading Ann's note: someone else's words.
    c = ctx(db, w["bob"])
    out = await read.run(c, {"note": w["note"]["id"]})
    assert c.turn["untrusted"] is True and '<untrusted_content source="read_note">' in out.content
    assert "Oat milk" in out.content and "Owned by" in out.content
    c = ctx(db, w["bob"])
    await find.run(c, {"query": "shopping"})
    assert c.turn["untrusted"] is True
    # Ann's own note, once Bob has ticked something on it, has his words too.
    c = ctx(db, w["ann"])
    await read.run(c, {"note": w["note"]["id"]})
    assert not c.turn.get("untrusted")
    iid = w["note"]["items"][1]["id"]
    r = await client.patch(f"/api/notes/{w['note']['id']}/items/{iid}", headers=H(w["bob"]), json={"checked": True})
    assert r.status_code == 200
    c = ctx(db, w["ann"])
    await read.run(c, {"note": w["note"]["id"]})
    assert c.turn["untrusted"] is True
    # A file you attached yourself doesn't open the door for note writes.
    _ = mine


@pytest.mark.parametrize("turn", [{"untrusted": True}, {"untrusted": True, "own_attachments_only": True}])
async def test_writes_are_refused_on_an_untrusted_turn_and_change_nothing(client, db, world, turn):  # noqa: F811
    from app.chat.tools.base import ToolError

    w = world
    _find, _read, create, add, tick = tools()
    before = await get(client, w["ann"], w["note"]["id"])
    calls = [
        (create, {"title": "From a web page", "text": "x"}),
        (add, {"note": w["note"]["id"], "items": ["Bleach"]}),
        (add, {"note": "shopping list", "items": ["Bleach"]}),
        (tick, {"note": w["note"]["id"], "items": ["Eggs"]}),
    ]
    for tool, args in calls:
        with pytest.raises(ToolError, match="outside content"):
            await tool.run(ctx(db, w["ann"], turn), args)
    after = await get(client, w["ann"], w["note"]["id"])
    assert (after["revision"], after["change_seq"], len(after["items"])) == (before["revision"], before["change_seq"], len(before["items"]))
    home = (await client.get("/api/notes", headers=H(w["ann"]))).json()["notes"]
    assert "From a web page" not in [n["title"] for n in home]


async def test_the_shopping_list_goes_to_the_shared_note(client, db, world, live):  # noqa: F811
    w = world
    *_, add, tick = tools()
    # Bob's "my shopping list" is Ann's "Shopping list" note, shared with him.
    out = await add.run(ctx(db, w["bob"]), {"note": "my shopping list", "items": ["Bananas", "Coffee"]})
    assert "Shopping list" in out.content and out.meta["note"] == w["note"]["id"]
    n = await get(client, w["ann"], w["note"]["id"])
    assert [i["text"] for i in n["items"]][-2:] == ["Bananas", "Coffee"]
    assert n["edited_by"] == str(w["bob"].id)
    # Both of them were told (ids only).
    assert any({str(w["ann"].id), str(w["bob"].id)} <= users and ev["id"] == w["note"]["id"] for users, ev in live)
    assert await tasks_shopping(db, w["bob"]) == []
    # Tick by words.
    out = await tick.run(ctx(db, w["bob"]), {"note": "shopping list", "items": ["bananas", "Lobster"]})
    assert "Ticked 1 item" in out.content and "Lobster" in out.content
    n = await get(client, w["ann"], w["note"]["id"])
    assert next(i for i in n["items"] if i["text"] == "Bananas")["checked"] is True


async def test_without_a_shopping_note_it_goes_to_tasks(client, db, world):  # noqa: F811
    w = world
    *_, add, _tick = tools()
    cat = w["cat"]
    # "Shopping trip ideas" isn't the shopping list; an archived "Groceries" isn't either.
    await new_note(client, cat, title="Shopping trip ideas", text="Paris")
    old = await new_list(client, cat, title="Groceries", items=("Flour",))
    await client.put(f"/api/notes/{old['id']}/me", headers=H(cat), json={"archived": True})
    out = await add.run(ctx(db, cat), {"note": "shopping list", "items": ["Oat milk", "Eggs"]})
    assert "Tasks" in out.content and out.meta["url"].startswith("/apps/tasks/")
    assert await tasks_shopping(db, cat) == ["Oat milk", "Eggs"] or sorted(await tasks_shopping(db, cat)) == ["Eggs", "Oat milk"]
    assert [i["text"] for i in (await get(client, cat, old["id"]))["items"]] == ["Flour"]
    # Once there is a Groceries note (a text one), lines go there instead.
    g = await new_note(client, cat, title="Groceries:", text="Bread")
    out = await add.run(ctx(db, cat), {"note": "groceries", "items": ["Butter"]})
    assert out.meta["note"] == g["id"]
    assert (await get(client, cat, g["id"]))["body_text"] == "Bread\nButter"
    # A list beats a text note.
    lst = await new_list(client, cat, title="shopping", items=())
    out = await add.run(ctx(db, cat), {"note": "the shopping list", "items": ["Jam"]})
    assert out.meta["note"] == lst["id"]


async def test_create_and_add_by_title(client, db):  # noqa: F811
    from app.chat.tools.base import ToolError

    ann = await mk_user(db, "ann")
    find, read, create, add, tick = tools()
    out = await create.run(ctx(db, ann), {"title": "Packing", "items": ["Socks", "Charger"]})
    nid = out.meta["note"]
    n = await get(client, ann, nid)
    assert n["kind"] == "list" and n["source"] == "chat" and [i["text"] for i in n["items"]] == ["Socks", "Charger"]
    await add.run(ctx(db, ann), {"note": "packing", "items": ["Passport"]})
    out = await read.run(ctx(db, ann), {"note": "Packing"})
    assert "[ ] Passport" in out.content
    out = await create.run(ctx(db, ann), {"title": "Plumber", "text": "Call Sam 0400 000 000"})
    assert (await get(client, ann, out.meta["note"]))["kind"] == "text"
    with pytest.raises(ToolError):
        await create.run(ctx(db, ann), {})
    with pytest.raises(ToolError, match="checklist"):
        await tick.run(ctx(db, ann), {"note": "Plumber", "items": ["x"]})
    await create.run(ctx(db, ann), {"title": "Packing list", "text": "x"})
    with pytest.raises(ToolError, match="Several"):
        await add.run(ctx(db, ann), {"note": "pack", "items": ["y"]})
    _ = find
