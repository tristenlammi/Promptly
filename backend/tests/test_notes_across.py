"""Notes N1.5: across Promptly.

* every new surface shows only notes you can open: Today's card, Ctrl+K,
  ``[[`` mentions, a Rooms card, and the new routes (AI, copy, document,
  tasks) answer 404 to anyone else;
* AI proposals write nothing until the person applies them, and applying
  one keeps the note as it was (a version), which Undo restores;
* Make a copy (pictures too), Open as document (+ Undo), Turn into tasks
  (+ Undo).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_notes_access import world  # noqa: F401 — fixture
from tests.test_notes_attachments import attach, client, live, local_stt, png, queued, root, tus_upload  # noqa: F401 — fixtures
from tests.test_notes_core import H, get, mk_user, new_list, new_note, pushes, share  # noqa: F401 — fixtures


def across_routes(nid: str) -> list[tuple[str, str, dict | None]]:
    n = f"/api/notes/{nid}"
    return [
        ("POST", f"{n}/ai/tidy", {}),
        ("POST", f"{n}/ai/to_tasks", {}),
        ("POST", f"{n}/ai/to_event", {}),
        ("POST", f"{n}/copy", {"client_id": str(uuid.uuid4())}),
        ("POST", f"{n}/to-document", {}),
        ("DELETE", f"{n}/to-document", None),
        ("POST", f"{n}/to-tasks", {"tasks": [{"title": "pwned"}]}),
        ("POST", f"{n}/to-tasks/undo", {"file_id": str(uuid.uuid4()), "task_ids": ["x"]}),
    ]


@pytest.fixture
def model(monkeypatch):
    """A stand-in model for the AI routes: answers from ``replies`` by
    action (the system prompt), records each call."""
    from app.files import editor_ai as E
    from app.notes import ai

    calls: list[dict] = []
    replies: dict[str, str] = {}

    async def resolve(db, user, provider_id, model_id):  # noqa: ANN001
        return object(), "fake-model"

    async def quotas(request, user, db):  # noqa: ANN001
        return None

    async def complete(provider, model_id, *, system, messages, **kw):  # noqa: ANN001
        action = next(a for a, s in ai.SYSTEMS.items() if s == system)
        calls.append({"action": action, "prompt": messages[-1].content})
        return replies[action]

    monkeypatch.setattr(E, "resolve_model", resolve)
    monkeypatch.setattr(E, "_quotas", quotas)
    monkeypatch.setattr(E, "complete", complete)
    return {"calls": calls, "replies": replies}


AI = {"provider_id": str(uuid.uuid4()), "model_id": "fake-model"}


# ================================================================== access


@pytest.mark.parametrize("who", ["cat", "dan"])
async def test_new_routes_are_404_to_anyone_who_cant_open_the_note(client, world, who):  # noqa: F811
    w = world
    u = w[who]
    before = await get(client, w["ann"], w["note"]["id"])
    for method, path, body in across_routes(w["note"]["id"]) + across_routes(str(uuid.uuid4())):
        r = await client.request(method, path, headers=H(u), json=body)
        assert r.status_code == 404, (who, method, path, r.status_code, r.text)
        assert "Oat milk" not in r.text and "Shopping" not in r.text
    after = await get(client, w["ann"], w["note"]["id"])
    assert (after["revision"], after["change_seq"], after["doc_file_id"]) == (before["revision"], before["change_seq"], None)


async def test_today_card_shows_only_notes_you_can_open(client, world):  # noqa: F811
    w = world
    nid = w["note"]["id"]
    # Ann pins the shared list and her trashed note was pinned too.
    await client.put(f"/api/notes/{nid}/me", headers=H(w["ann"]), json={"pinned": True})
    gate = await new_note(client, w["ann"], title="Gate code")
    await client.put(f"/api/notes/{gate['id']}/me", headers=H(w["ann"]), json={"pinned": True})
    await client.post(f"/api/notes/{nid}/items/bulk", headers=H(w["ann"]), json={"action": "untick_all"})
    first = (await get(client, w["ann"], nid))["items"][0]["id"]
    await client.patch(f"/api/notes/{nid}/items/{first}", headers=H(w["ann"]), json={"checked": True})

    async def card(u):
        r = await client.get("/api/today", headers=H(u))
        assert r.status_code == 200, r.text
        return r.json()["sections"].get("notes")

    ann = await card(w["ann"])
    titles = [c["title"] for c in ann["pinned"]]
    assert set(titles) == {"Shopping list", "Gate code"} and "Old bills" not in titles
    lst = next(c for c in ann["pinned"] if c["title"] == "Shopping list")
    assert (lst["left"], lst["total"], lst["url"]) == (2, 3, f"/notes/n/{nid}")
    # Pins are each person's own: Bob hasn't pinned it.
    assert await card(w["bob"]) is None
    await client.put(f"/api/notes/{nid}/me", headers=H(w["bob"]), json={"pinned": True})
    assert [c["title"] for c in (await card(w["bob"]))["pinned"]] == ["Shopping list"]
    # A stranger and someone removed see nothing of it.
    assert await card(w["cat"]) is None and await card(w["dan"]) is None
    # Ann removes Bob: his card loses it at once.
    await client.delete(f"/api/notes/{nid}/members/{w['bob'].id}", headers=H(w["ann"]))
    assert await card(w["bob"]) is None


async def test_ctrl_k_finds_notes_you_can_open_and_nothing_else(client, world):  # noqa: F811
    w = world

    async def found(u, q):
        r = await client.get("/api/today/search", headers=H(u), params={"q": q})
        assert r.status_code == 200, r.text
        return r.json()["notes"]

    for u in (w["ann"], w["bob"]):
        hits = await found(u, "oat milk")
        assert [h["id"] for h in hits] == [w["note"]["id"]], hits
        assert hits[0]["url"] == f"/notes/n/{w['note']['id']}"
    assert (await found(w["bob"], "shopping"))[0]["shared"] is True
    for u in (w["cat"], w["dan"]):
        assert await found(u, "oat milk") == [] and await found(u, "shopping") == []
    # Trashed notes aren't searched, even by their owner.
    assert await found(w["ann"], "old bills") == []
    # Words inside a note (not the title) find it, with where it matched.
    gate = await new_note(client, w["cat"], title="Gate", text="The code is 4471, then press the bell")
    hit = (await found(w["cat"], "4471"))[0]
    assert hit["id"] == gate["id"] and "4471" in hit["snippet"]
    assert await found(w["ann"], "4471") == []


async def test_a_mention_links_the_note_for_those_who_can_open_it(client, world):  # noqa: F811
    w = world
    nid = w["note"]["id"]
    # The [[ picker finds it for Ann and Bob only.
    for u, n in ((w["ann"], 1), (w["bob"], 1), (w["cat"], 0), (w["dan"], 0)):
        res = (await client.get("/api/connections/search", headers=H(u), params={"q": "Shopping"})).json()["results"]
        assert len([r for r in res if r["kind"] == "note" and r["id"] == nid]) == n
    # Bob mentions it in a note of his own (the link the picker inserts).
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "Don't forget "},
        {"type": "text", "text": "Shopping list", "marks": [{"type": "link", "attrs": {"href": f"/link/note/{nid}"}}]},
    ]}]}
    mine = await new_note(client, w["bob"], title="Saturday", text=None, body_doc=doc)
    links = (await client.get("/api/connections", headers=H(w["ann"]), params={"kind": "note", "id": nid})).json()
    # Ann can't open Bob's note, so it isn't listed for her…
    assert all(m["id"] != mine["id"] for m in links["mentioned_in"])
    links = (await client.get("/api/connections", headers=H(w["bob"]), params={"kind": "note", "id": nid})).json()
    # …but Bob sees it mentioned in his.
    assert [m["id"] for m in links["mentioned_in"] if m["kind"] == "note"] == [mine["id"]]
    r = await client.get("/api/connections/resolve", headers=H(w["bob"]), params={"kind": "note", "id": nid})
    assert r.json()["href"] == f"/notes/n/{nid}"
    r = await client.get("/api/connections/resolve", headers=H(w["cat"]), params={"kind": "note", "id": nid})
    assert r.status_code == 404


async def test_a_room_card_shows_the_note_only_to_people_on_it(client, db, world):  # noqa: F811
    from app.crossapp import shares

    w = world
    snap = {"kind": "note", "id": w["note"]["id"], "label": shares.LABELS["note"]}
    for who, sees in (("ann", True), ("bob", True), ("cat", False), ("dan", False)):
        got = await shares.card(db, w[who], snap)
        assert (got is not None) == sees, who
        if got:
            assert got["title"] == "Shopping list" and got["subtitle"] == "List · 3 left" and got["href"] == f"/notes/n/{w['note']['id']}"
    assert await shares.card(db, w["ann"], {**snap, "id": w["trashed"]["id"]}) is None
    assert not await shares.can_grant(db, w["ann"], snap)
    # Cat can't send a card for a note she can't open (the room doesn't matter).
    r = await client.post("/api/crossapp/share", headers=H(w["cat"]), json={"room_id": str(uuid.uuid4()), "kind": "note", "id": w["note"]["id"]})
    assert r.status_code == 404


# ================================================================== AI proposals


async def test_ai_proposals_write_nothing_until_applied_and_undo_restores(client, db, model):  # noqa: F811
    from app.notes.models import NoteVersion

    ann = await mk_user(db, "ann")
    words = "um so the plumber is coming tuesday uh at ten and we need to like buy pipe tape"
    n = await new_note(client, ann, title="", text=words)
    before = await get(client, ann, n["id"])
    model["replies"].update({
        "tidy": '{"text": "The plumber is coming Tuesday at ten.\\n\\nWe need to buy pipe tape."}',
        "to_list": '```json\n{"items": ["Plumber Tuesday at ten", "Buy pipe tape", ""]}\n```',
        "title": '{"title": "\\"Plumber visit.\\""}',
        "to_tasks": '{"tasks": [{"title": "Buy pipe tape", "due": null}, {"title": "Let the plumber in", "due": "2026-11-10", "time": "10:00"}]}',
        "to_event": '{"title": "Plumber", "date": "2026-11-10", "start": "10:00", "end": "09:00", "all_day": false, "location": "", "description": ""}',
    })
    got = {}
    for action in ("tidy", "to_list", "title", "to_tasks", "to_event"):
        r = await client.post(f"/api/notes/{n['id']}/ai/{action}", headers=H(ann), json=AI)
        assert r.status_code == 200, (action, r.text)
        got[action] = r.json()["proposal"]
    # The model read the note, as data.
    assert all("<note>" in c["prompt"] and "pipe tape" in c["prompt"] for c in model["calls"])
    assert "Today is" in next(c for c in model["calls"] if c["action"] == "to_event")["prompt"]
    assert got["tidy"]["text"] == "The plumber is coming Tuesday at ten.\nWe need to buy pipe tape."
    assert [b["content"][0]["text"] for b in got["tidy"]["body_doc"]["content"]] == ["The plumber is coming Tuesday at ten.", "We need to buy pipe tape."]
    assert got["to_list"]["items"] == ["Plumber Tuesday at ten", "Buy pipe tape"]
    assert got["title"]["title"] == "Plumber visit"
    assert got["to_tasks"]["tasks"][1] == {"title": "Let the plumber in", "due": "2026-11-10", "time": "10:00"}
    ev = got["to_event"]
    assert (ev["date"], ev["start"], ev["end"], ev["all_day"]) == ("2026-11-10", "10:00", None, False)
    assert ev["description"] == words  # the note's own words when the model gives none
    # Nothing was saved by any of that.
    after = await get(client, ann, n["id"])
    assert (after["revision"], after["change_seq"], after["body_text"], after["title"]) == (
        before["revision"], before["change_seq"], before["body_text"], before["title"])
    assert (await db.execute(select(NoteVersion).where(NoteVersion.note_id == uuid.UUID(n["id"])))).scalars().all() == []

    # "Use this": the normal save, marked as an AI change → the note as it was is kept.
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={
        "base_revision": after["revision"], "body_doc": got["tidy"]["body_doc"], "checkpoint": "ai"})
    assert r.status_code == 200, r.text
    assert r.json()["note"]["body_text"].startswith("The plumber is coming")
    # A second AI change straight after is kept too (not throttled like typing).
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={
        "base_revision": r.json()["note"]["revision"], "title": got["title"]["title"], "checkpoint": "ai"})
    assert r.status_code == 200
    versions = (await client.get(f"/api/notes/{n['id']}/versions", headers=H(ann))).json()["versions"]
    assert [v["reason"] for v in versions] == ["ai", "ai"]
    # Undo: the version from before the first AI change comes back.
    oldest = versions[-1]
    r = await client.post(f"/api/notes/{n['id']}/versions/{oldest['id']}/restore", headers=H(ann))
    assert r.status_code == 200
    back = r.json()["note"]
    assert back["body_text"] == words and back["title"] == ""


async def test_ai_proposals_say_why_when_they_cant(client, db, model):  # noqa: F811
    ann = await mk_user(db, "ann")
    lst = await new_list(client, ann, items=("Eggs", "Milk"))
    # A list's unticked items are its tasks: no model needed.
    r = await client.post(f"/api/notes/{lst['id']}/ai/to_tasks", headers=H(ann), json=AI)
    assert r.status_code == 200 and [t["title"] for t in r.json()["proposal"]["tasks"]] == ["Eggs", "Milk"]
    assert model["calls"] == []
    r = await client.post(f"/api/notes/{lst['id']}/ai/tidy", headers=H(ann), json=AI)
    assert r.status_code == 400 and "list" in r.json()["detail"]
    empty = await new_note(client, ann, title="", text="")
    r = await client.post(f"/api/notes/{empty['id']}/ai/title", headers=H(ann), json=AI)
    assert r.status_code == 400
    n = await new_note(client, ann, text="Some words")
    model["replies"]["to_list"] = "I can't do that."
    r = await client.post(f"/api/notes/{n['id']}/ai/to_list", headers=H(ann), json=AI)
    assert r.status_code == 422
    r = await client.post(f"/api/notes/{n['id']}/ai/nonsense", headers=H(ann), json=AI)
    assert r.status_code == 422


# ================================================================== copy


async def test_make_a_copy_is_yours_with_pictures_and_the_original_is_untouched(client, db, root, live):  # noqa: F811
    from app.files.models import UserFile

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    n = await new_list(client, ann, items=("Tent", "Torch"), title="Camping", color="mint")
    await share(client, ann, n["id"], bob)
    fid = await tus_upload(client, root, ann, "map.png", png(), "image/png")
    assert (await attach(client, ann, n["id"], fid)).status_code == 201
    first = n["items"][0]["id"]
    await client.patch(f"/api/notes/{n['id']}/items/{first}", headers=H(ann), json={"checked": True})
    tag = (await client.post("/api/tags", headers=H(bob), json={"name": "trips"})).json()
    await client.put(f"/api/notes/{n['id']}/labels", headers=H(bob), json={"tag_ids": [tag["id"]]})
    before = await get(client, ann, n["id"])

    # Bob's copy: his own note, his labels; Ann's picture copied into his Notes folder.
    cid = str(uuid.uuid4())
    r = await client.post(f"/api/notes/{n['id']}/copy", headers=H(bob), json={"client_id": cid})
    assert r.status_code == 201, r.text
    copy = r.json()["note"]
    assert copy["id"] == cid and copy["is_owner"] and copy["member_ids"] == [] and copy["color"] == "mint"
    assert [(i["text"], i["checked"]) for i in copy["items"]] == [("Tent", True), ("Torch", False)]
    assert [lb["name"] for lb in copy["labels"]] == ["trips"]
    assert len(copy["attachments"]) == 1
    f = await db.get(UserFile, uuid.UUID(copy["attachments"][0]["file_id"]))
    assert f.user_id == bob.id and f.id != uuid.UUID(fid) and (root / f.storage_path).read_bytes() == png()
    # A retry is the same copy.
    r = await client.post(f"/api/notes/{n['id']}/copy", headers=H(bob), json={"client_id": cid})
    assert r.status_code == 200 and r.json()["note"]["id"] == cid
    # Ann can't see Bob's copy; her note didn't change.
    assert (await client.get(f"/api/notes/{cid}", headers=H(ann))).status_code == 404
    after = await get(client, ann, n["id"])
    assert (after["revision"], after["change_seq"]) == (before["revision"], before["change_seq"])
    # Ann's own copy uses the same picture file (nothing stored twice).
    r = await client.post(f"/api/notes/{n['id']}/copy", headers=H(ann), json={"client_id": str(uuid.uuid4())})
    assert r.json()["note"]["attachments"][0]["file_id"] == fid
    # Undo (the app deletes the new copy for good).
    assert (await client.delete(f"/api/notes/{cid}/forever", headers=H(bob))).status_code == 200
    assert (await client.get(f"/api/notes/{cid}", headers=H(bob))).status_code == 404


# ================================================================== document


async def test_open_as_document_then_undo(client, db, root, world):  # noqa: F811
    from app.files.models import UserFile

    w = world
    ann, bob = w["ann"], w["bob"]
    n = await new_note(client, ann, title="Essay", body_doc={"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Part one"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Long "}, {"type": "text", "text": "words", "marks": [{"type": "bold"}]}]},
    ]})
    await share(client, ann, n["id"], bob)
    # Only the owner.
    r = await client.post(f"/api/notes/{n['id']}/to-document", headers=H(bob), json={})
    assert r.status_code == 403
    r = await client.post(f"/api/notes/{n['id']}/to-document", headers=H(ann), json={})
    assert r.status_code == 201, r.text
    out = r.json()
    doc = await db.get(UserFile, uuid.UUID(out["file_id"]))
    await db.refresh(doc)
    assert doc.user_id == ann.id and doc.source_kind == "document" and "Long" in (doc.content_text or "") and "Part one" in (doc.content_text or "")
    assert out["document"]["href"] == f"/files/doc/{doc.id}" and out["document"]["title"] == "Essay"
    assert out["note"]["archived"] is True and out["note"]["doc_file_id"] == str(doc.id)
    # Bob can't open Ann's document, so there's no card for him.
    assert (await get(client, bob, n["id"]))["document"] is None
    r = await client.post(f"/api/notes/{n['id']}/to-document", headers=H(ann), json={})
    assert r.status_code == 409
    # Undo: the document to Trash, the note back.
    r = await client.delete(f"/api/notes/{n['id']}/to-document", headers=H(ann))
    assert r.status_code == 200
    back = r.json()["note"]
    assert back["archived"] is False and back["doc_file_id"] is None and back["document"] is None
    await db.refresh(doc)
    assert doc.trashed_at is not None


def test_a_list_becomes_a_checklist_in_markdown():
    from types import SimpleNamespace as S

    from app.notes.convert import note_markdown

    note = S(kind="list", body_doc=None)
    items = [S(text="Tent", checked=True, parent_id=None), S(text="Pegs", checked=False, parent_id="x"), S(text=" ", checked=False, parent_id=None)]
    assert note_markdown(note, items) == "- [x] Tent\n  - [ ] Pegs\n"
    text = S(kind="text", body_doc={"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Hi"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "a "}, {"type": "text", "text": "link", "marks": [{"type": "link", "attrs": {"href": "https://x.y"}}]}]},
    ]})
    assert note_markdown(text, []) == "### Hi\n\na [link](https://x.y)\n"


# ================================================================== tasks


async def test_turn_into_tasks_then_undo(client, db, world):  # noqa: F811
    from app.items import service as items
    from app.links.models import EntityLink

    w = world
    nid = w["note"]["id"]
    lists = (await client.get("/api/notes/to-tasks/lists", headers=H(w["bob"]))).json()
    assert lists["available"] and "Shopping" in [x["name"] for x in lists["lists"]]
    r = await client.post(f"/api/notes/{nid}/to-tasks", headers=H(w["bob"]), json={
        "list": "Shopping", "tasks": [{"title": "Oat milk"}, {"title": "Eggs", "due": "2026-11-12", "time": "9:30"}]})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["count"] == 2
    row, doc, _ = await items.load(db, w["bob"], uuid.UUID(out["file_id"]))
    data = doc.data
    made = [t for t in data["tasks"] if t["id"] in out["task_ids"]]
    shop = next(x["id"] for x in data["lists"] if x["name"] == "Shopping")
    assert {(t["title"], t["list_id"], t["due"], t["time"]) for t in made} == {("Oat milk", shop, None, None), ("Eggs", shop, "2026-11-12", "09:30")}
    assert row.user_id == w["bob"].id  # Bob's own Tasks, not Ann's
    async def linked() -> list:
        rows = (await db.execute(select(EntityLink).where(EntityLink.link_type == "link"))).scalars().all()
        return [lk for lk in rows if nid in (lk.source_id, lk.target_id)]

    got = await linked()
    assert len(got) == 2 and all({lk.source_kind, lk.target_kind} == {"note", "task"} for lk in got)
    # Tick one off in Tasks, then Undo: only the open one goes.
    done_id = out["task_ids"][0]
    row, doc, _ = await items.load(db, w["bob"], uuid.UUID(out["file_id"]), lock=True)
    data = dict(doc.data)
    data["tasks"] = [{**t, "done": True, "done_at": "2026-11-09T10:00:00+00:00"} if t["id"] == done_id else t for t in data["tasks"]]
    await items.save_data(db, w["bob"], row, doc, data, base_revision=None)
    await db.commit()
    r = await client.post(f"/api/notes/{nid}/to-tasks/undo", headers=H(w["bob"]), json={"file_id": out["file_id"], "task_ids": out["task_ids"]})
    assert r.json() == {"removed": 1}
    from app.items.models import ItemDocument

    fresh = (
        await db.execute(select(ItemDocument).where(ItemDocument.file_id == uuid.UUID(out["file_id"])).execution_options(populate_existing=True))
    ).scalar_one()
    assert [t["id"] for t in fresh.data["tasks"] if t["id"] in out["task_ids"]] == [done_id]
    assert len(await linked()) == 1  # the removed task's link went with it
    # Someone else's Tasks file can't be touched through Undo.
    r = await client.post(f"/api/notes/{nid}/to-tasks/undo", headers=H(w["ann"]), json={"file_id": out["file_id"], "task_ids": [done_id]})
    assert r.json() == {"removed": 0}
    r = await client.post(f"/api/notes/{nid}/to-tasks", headers=H(w["bob"]), json={"tasks": [{"title": "x", "due": "soon"}]})
    assert r.status_code in (400, 422)
