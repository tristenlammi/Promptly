"""Notes N2.4: notes by voice — Talking to Promptly and the phone assistant.

* the notes tools are in both allowlists: reads straight away, writes only on
  a yes. Talking to Promptly (Talk phase 2) adds to a checklist at once, with
  "undo", and can tick items on a yes; the phone assistant asks before every
  add and doesn't tick; nothing is deleted by voice;
* the read-back comes from the real arguments and names the real note;
* a shared note read on the same turn makes the add ask (the approval path),
  never refuse.
"""
from __future__ import annotations

import pytest

from app.maps import assistant as phone
from app.talk import readback
from app.talk import tools as voice
from tests.test_maps_voice import _script, trip
from tests.test_notes_chat_tools import ctx
from tests.test_notes_core import H, client, get, live, mk_user, new_list, new_note, share  # noqa: F401 — fixtures


def test_the_notes_tools_are_in_both_allowlists():
    for reads in (voice.READS, phone.READ_TOOLS):
        assert {"find_notes", "read_note"} <= set(reads)
    assert {"add_to_note", "create_note"} <= set(phone.WRITE_TOOLS)
    # Talk: making a note and ticking wait for a yes; an add to a checklist is
    # the quick kind (runs at once with "undo", asked about otherwise).
    assert {"create_note", "tick_note_items"} <= set(voice.WRITES) and voice.QUICK == ("add_to_note",)
    assert "add_to_note" not in voice.WRITES and "add_to_note" in voice.GUARDED
    assert "tick_note_items" not in {*phone.READ_TOOLS, *phone.WRITE_TOOLS}  # the phone doesn't tick
    assert all(voice.approvable(n) for n in ("add_to_note", "create_note", "tick_note_items"))
    assert voice.is_write("create_note") and not voice.approvable("read_note")
    assert not voice.is_write("read_note") and "notes" in voice.CATEGORIES
    assert "shopping list" in voice.prompt(voice.voice_tool_names([]), device="web", driving=False)


async def test_the_read_back_names_the_real_note(client, db, live):  # noqa: F811
    ann = await mk_user(db, "ann")
    args = {"note": "shopping list", "items": ["eggs", "oat milk"]}
    # No Shopping note: it's Tasks' Shopping list, and the question says so.
    q, problem = await readback.read_back(db, ann, "add_to_note", args)
    assert problem is None and q == "Add eggs and oat milk to the Shopping list in Tasks?"
    await new_list(client, ann, title="Shopping", items=())
    q, _ = await readback.read_back(db, ann, "add_to_note", args)
    assert q == "Add eggs and oat milk to your Shopping note?"
    # Named from the note, not from what the model said.
    gate = await new_note(client, ann, title="Gate", text="code")
    q, _ = await readback.read_back(db, ann, "add_to_note", {"note": gate["id"], "text": "side door 1234"})
    assert q == "Add side door 1234 to your Gate note?"
    many = {"note": "shopping list", "items": ["a", "b", "c", "d", "e", "f", "g", "h"]}
    assert (await readback.read_back(db, ann, "add_to_note", many))[0] == "Add a, b, c, d, e and 3 more to your Shopping note?"
    # A note that isn't there, or nothing to add: not asked at all.
    assert (await readback.read_back(db, ann, "add_to_note", {"note": "Moon base", "items": ["x"]}))[1]
    assert (await readback.read_back(db, ann, "add_to_note", {"note": "shopping list", "items": []}))[1]
    # Making a note.
    assert readback.question("create_note", {"title": "Gate code", "text": "4471"}) == "Make a note called Gate code?"
    assert readback.question("create_note", {"title": "Packing", "items": ["socks", "hat"]}) == "Make a list called Packing with socks and hat?"
    assert readback.done_line("add_to_note", ok=True) == "Added." and readback.done_line("create_note", ok=True) == "Saved."


async def test_talk_adds_to_a_list_at_once_and_a_shared_note_read_asks_instead_of_refusing(client, db, live):  # noqa: F811
    from app.chat.tools.notes import AddToNoteTool, ReadNoteTool

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    shop = await new_list(client, bob, title="Shopping", items=("Bread",))
    await share(client, bob, shop["id"], ann)
    args = {"note": "shopping list", "items": ["eggs"]}

    # A checklist add on a clean turn isn't held (Talk phase 2: it runs, with "undo")...
    gate = voice.VoiceGate(user=ann)
    assert await gate.check("add_to_note", args, {}) is None and "add_to_note" in gate.quick
    # ...but making a note is, and so is an add to a text note.
    verdict = await voice.VoiceGate(user=ann).check("create_note", {"title": "Gate code", "text": "4471"}, {})
    assert verdict.kind == "hold" and verdict.say == "Make a note called Gate code?"
    memo = await new_note(client, ann, title="Gate", text="code")
    verdict = await voice.VoiceGate(user=ann).check("add_to_note", {"note": memo["id"], "text": "side door 1234"}, {})
    assert verdict.kind == "hold" and verdict.say == "Add side door 1234 to your Gate note?"
    assert [i["text"] for i in (await get(client, ann, shop["id"]))["items"]] == ["Bread"]  # nothing added yet

    # "What's on the shopping list?": Bob wrote it, so the turn is marked...
    c = ctx(db, ann)
    said = (await ReadNoteTool().run(c, {"note": "shopping list"})).content
    assert "Bread" in said and c.turn.get("untrusted")
    # ...and adding is asked about (held for outside content), not refused.
    verdict = await voice.VoiceGate(user=ann).check("add_to_note", args, c.turn)
    assert verdict.kind == "hold" and verdict.meta.get("held") == "outside_content"
    # The yes runs it on a fresh, approved turn.
    await AddToNoteTool().run(ctx(db, ann, {"untrusted": True, "user_approved": True}), args)
    assert [i["text"] for i in (await get(client, ann, shop["id"]))["items"]] == ["Bread", "eggs"]


async def test_the_phone_asks_then_adds_on_yes(client, db, live, monkeypatch):  # noqa: F811
    ann = await mk_user(db, "ann")
    shop = await new_list(client, ann, title="Groceries", items=())
    args = {"note": "shopping list", "items": ["milk"]}
    _script(monkeypatch, {"do": "use", "tool": "add_to_note", "args": args})
    asked = await phone.reply(db, ann, "add milk to the shopping list", trip())
    assert asked["say"] == "Add milk to your Groceries note?" and asked["pending"]["tool"] == "add_to_note"
    assert (await get(client, ann, shop["id"]))["items"] == []

    _script(monkeypatch, {"do": "confirm"}, {"do": "answer", "say": "Added."})
    done = await phone.reply(db, ann, "yes", trip(pending=asked["pending"]))
    assert done["say"] == "Added."
    assert [i["text"] for i in (await get(client, ann, shop["id"]))["items"]] == ["milk"]

    # "What's on the shopping list?" is a read: straight away.
    seen = _script(monkeypatch, {"do": "use", "tool": "read_note", "args": {"note": "shopping list"}}, {"do": "answer", "say": "Just milk."})
    got = await phone.reply(db, ann, "what's on the shopping list", trip())
    assert got["say"] == "Just milk." and "milk" in seen[1][-1].content


@pytest.mark.parametrize("tool", ["tick_note_items"])
async def test_ticking_isnt_offered_by_voice(db, user, monkeypatch, tool):
    _script(monkeypatch, {"do": "use", "tool": tool, "args": {"note": "shopping list", "items": ["milk"]}})
    got = await phone.reply(db, user, "tick off milk", trip())
    assert got["say"] == phone.FAILED
