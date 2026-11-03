"""Links between things: "Mentioned in" (recorded from docs, room messages,
chat messages and journal entries) and two-way "Linked" — and above all
that neither list ever shows a side the viewer can't see."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_cross_app import mk_file, mk_item, mk_user, space
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    import app.rooms.router as rr

    monkeypatch.setattr(rr, "spawn", lambda coro, name=None: coro.close())

    async def fake(**kw):
        return None

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)


async def conns(client, u, kind, id_, code=200):
    r = await client.get("/api/connections", headers=_auth(u), params={"kind": kind, "id": id_})
    assert r.status_code == code, r.text
    return r.json()


async def mk_event(client, u, **kw):
    body = {"title": "Dinner", "start": "2026-11-07T18:00:00Z", "end": "2026-11-07T20:00:00Z", **kw}
    r = await client.post("/api/calendar/events", headers=_auth(u), json=body)
    assert r.status_code == 201, r.text
    return r.json()["event"]["event_id"]


async def share_file(db, owner, fid, grantee):
    from app.files.models import ResourceGrant

    db.add(ResourceGrant(resource_type="file", resource_id=fid, grantee_user_id=grantee.id, granted_by_user_id=owner.id))
    await db.commit()


# ------------------------------------------------------------------ parsing (no DB)


def test_extract_refs_reads_link_paths_wiki_links_and_chat_file_tokens():
    from app.links.service import extract_refs

    fid, tid = uuid.uuid4(), uuid.uuid4()
    text = (
        f"see @[Pay rent](/link/task/{fid}:t-1) and <a href=\"/link/event/{tid}\">x</a>, "
        f"again @[Pay rent](/link/task/{fid}:t-1), @[a.pdf](file:{tid}), "
        f"<a href=\"/workspaces/{fid}?item={tid}&amp;kind=note\">n</a>, /link/nope/{tid}, /link/task/notauuid:x"
    )
    assert extract_refs(text) == [("task", f"{fid}:t-1"), ("event", str(tid)), ("file", str(tid))]
    assert ("witem", str(tid)) in extract_refs(text, wiki=True)


def test_doc_sanitiser_keeps_link_hrefs():
    from app.files.document_render import sanitize_document_html

    fid = uuid.uuid4()
    out = sanitize_document_html(f'<p><a href="/link/task/{fid}:t1">Pay rent</a></p>')
    assert f"/link/task/{fid}:t1" in out


# ------------------------------------------------------------------ mentions


async def test_room_message_mention_shows_only_to_people_in_the_room(client, db, user):
    bob, cat = await mk_user(db, "bob"), await mk_user(db, "cat")
    tasks = await mk_item(db, user, "tasks", {"tasks": [{"id": "t1", "title": "Book the vet"}]})
    await share_file(db, user, tasks, cat)  # Cat can see the task, but isn't in the room
    room = await space(client, user, bob)
    ref = f"{tasks}:t1"

    r = await client.post(f"/api/rooms/rooms/{room}/messages", headers=_auth(user), json={"body": f"Done? @[Book the vet](/link/task/{ref})"})
    assert r.status_code == 201, r.text
    mid = r.json()["id"]

    mine = await conns(client, user, "task", ref)
    assert [(m["kind"], m["id"]) for m in mine["mentioned_in"]] == [("room_msg", mid)]
    assert mine["mentioned_in"][0]["href"].startswith(f"/rooms/r/{room}?m=")
    # Cat sees the task but not the room: no entry, no room name, no text.
    theirs = await conns(client, cat, "task", ref)
    assert theirs["mentioned_in"] == [] and "Family" not in str(theirs) and "Done?" not in str(theirs)
    # Bob is in the room but can't see the task: the task's list is a 404.
    await conns(client, bob, "task", ref, code=404)

    # Editing the mention out removes it; putting it back and deleting the message too.
    r = await client.patch(f"/api/rooms/messages/{mid}", headers=_auth(user), json={"body": "never mind"})
    assert r.status_code == 200, r.text
    assert (await conns(client, user, "task", ref))["mentioned_in"] == []
    await client.patch(f"/api/rooms/messages/{mid}", headers=_auth(user), json={"body": f"@[x](/link/task/{ref})"})
    assert len((await conns(client, user, "task", ref))["mentioned_in"]) == 1
    assert (await client.delete(f"/api/rooms/messages/{mid}", headers=_auth(user))).status_code == 204
    assert (await conns(client, user, "task", ref))["mentioned_in"] == []
    from app.links.models import EntityLink

    assert (await db.execute(select(EntityLink).where(EntityLink.source_id == mid))).first() is None


async def test_private_source_never_leaks_into_someone_elses_list(client, db, user):
    """Ann's journal mentions Bob's task (she typed the id). The mention is
    recorded, but Bob can't see her journal, so nothing shows — and Ann's
    own journal can't be used to read Bob's task title."""
    from app.items import service as items

    bob = await mk_user(db, "bob")
    btasks = await mk_item(db, bob, "tasks", {"tasks": [{"id": "t9", "title": "Secret surgery"}]})
    ref = f"{btasks}:t9"
    jfile = await mk_item(db, user, "journal")
    row, doc, _ = await items.load(db, user, jfile, need="edit", lock=True)
    data = dict(doc.data)
    data["entries"] = [{"id": "e1", "date": "2026-11-03", "title": "Diary", "body": f"Thinking about @[it](/link/task/{ref})"}]
    await items.save_data(db, user, row, doc, data, base_revision=None)
    await db.commit()

    from app.links.models import EntityLink

    rows = (await db.execute(select(EntityLink).where(EntityLink.target_id == ref))).scalars().all()
    assert [(r.source_kind, r.source_id) for r in rows] == [("journal", f"{jfile}:e1")]
    assert (await conns(client, bob, "task", ref))["mentioned_in"] == []
    # Ann can't open Bob's task, its list, or resolve it.
    await conns(client, user, "task", ref, code=404)
    r = await client.get("/api/connections/resolve", headers=_auth(user), params={"kind": "task", "id": ref})
    assert r.status_code == 404 and "Secret" not in r.text

    # Removing the entry removes its mentions.
    row, doc, _ = await items.load(db, user, jfile, need="edit", lock=True)
    data = dict(doc.data)
    data["entries"] = []
    await items.save_data(db, user, row, doc, data, base_revision=None)
    await db.commit()
    assert (await db.execute(select(EntityLink).where(EntityLink.target_id == ref))).first() is None


async def test_journal_and_doc_mentions_show_to_the_owner(client, db, user):
    from app.items import service as items
    from app.links.service import sync_text

    ev = await mk_event(client, user, title="Dentist")
    jfile = await mk_item(db, user, "journal")
    row, doc, _ = await items.load(db, user, jfile, need="edit", lock=True)
    data = dict(doc.data)
    data["entries"] = [{"id": "e1", "date": "2026-11-03", "title": "Teeth", "body": f"Booked @[Dentist](/link/event/{ev})"}]
    await items.save_data(db, user, row, doc, data, base_revision=None)
    # A doc's snapshot (what the collab save path records).
    fid = await mk_file(db, user, "Notes")
    await sync_text(db, "file", fid, f'<p><a href="/link/event/{ev}">Dentist</a></p>', wiki=True)
    await db.commit()

    got = await conns(client, user, "event", ev)
    kinds = sorted(m["kind"] for m in got["mentioned_in"])
    assert kinds == ["file", "journal"]
    entry = next(m for m in got["mentioned_in"] if m["kind"] == "journal")
    assert entry["title"] == "Teeth" and entry["href"] == f"/apps/journal/{jfile}?entry=e1"


async def test_chat_message_mentions_follow_the_chat(client, db, user, conversation):
    from app.chat.models import Message
    from app.links.service import sync_text

    tasks = await mk_item(db, user, "tasks", {"tasks": [{"id": "t1", "title": "Call mum"}]})
    ref = f"{tasks}:t1"
    m = Message(conversation_id=conversation.id, role="user", content=f"remind me @[Call mum](/link/task/{ref})", author_user_id=user.id)
    db.add(m)
    await db.flush()
    await sync_text(db, "chat_msg", m.id, m.content, user_id=user.id)
    await db.commit()
    got = await conns(client, user, "task", ref)
    assert got["mentioned_in"][0]["kind"] == "chat_msg" and got["mentioned_in"][0]["href"] == f"/chat/{conversation.id}"
    # Someone else who can see the task (shared file) can't see the chat.
    bob = await mk_user(db, "bob")
    await share_file(db, user, tasks, bob)
    assert (await conns(client, bob, "task", ref))["mentioned_in"] == []

    r = await client.delete(f"/api/chat/conversations/{conversation.id}", headers=_auth(user))
    assert r.status_code == 204, r.text
    from app.links.models import EntityLink

    assert (await db.execute(select(EntityLink).where(EntityLink.target_id == ref))).first() is None


# ------------------------------------------------------------------ links


async def test_link_is_two_way_and_needs_both_sides(client, db, user):
    bob = await mk_user(db, "bob")
    fid = await mk_file(db, user, "receipt.pdf")
    ev = await mk_event(client, user, title="Flight")

    r = await client.post("/api/connections", headers=_auth(user), json={"a": {"kind": "file", "id": str(fid)}, "b": {"kind": "event", "id": ev}})
    assert r.status_code == 201, r.text
    assert r.json()["title"] == "Flight" and r.json()["kind"] == "event"
    link_id = r.json()["link_id"]
    # Linking again (either way round) reuses the one link.
    r = await client.post("/api/connections", headers=_auth(user), json={"a": {"kind": "event", "id": ev}, "b": {"kind": "file", "id": str(fid)}})
    assert r.status_code == 201 and r.json()["link_id"] == link_id

    assert [x["title"] for x in (await conns(client, user, "file", str(fid)))["linked"]] == ["Flight"]
    assert [x["title"] for x in (await conns(client, user, "event", ev))["linked"]] == ["receipt.pdf"]

    # Bob sees neither: 404s, and he can't remove it.
    await conns(client, bob, "file", str(fid), code=404)
    await conns(client, bob, "event", ev, code=404)
    assert (await client.delete(f"/api/connections/{link_id}", headers=_auth(bob))).status_code == 404
    # Bob can't link his file to Ann's event he can't see (nor probe it).
    bfile = await mk_file(db, bob, "mine.pdf")
    r = await client.post("/api/connections", headers=_auth(bob), json={"a": {"kind": "file", "id": str(bfile)}, "b": {"kind": "event", "id": ev}})
    assert r.status_code == 404 and "Flight" not in r.text
    # Nonsense ids and self-links are refused.
    r = await client.post("/api/connections", headers=_auth(user), json={"a": {"kind": "file", "id": "x"}, "b": {"kind": "event", "id": ev}})
    assert r.status_code == 404
    r = await client.post("/api/connections", headers=_auth(user), json={"a": {"kind": "event", "id": ev}, "b": {"kind": "event", "id": ev}})
    assert r.status_code == 400

    assert (await client.delete(f"/api/connections/{link_id}", headers=_auth(user))).status_code == 204
    assert (await conns(client, user, "event", ev))["linked"] == []


async def test_shared_event_hides_a_private_linked_file(client, db, user):
    """Ann links her private receipt to an event Bob is invited to. Bob sees
    the event — but not the receipt, its name, or a way to remove it."""
    bob = await mk_user(db, "bob")
    ev = await mk_event(client, user, title="Team lunch", guests=[str(bob.id)])
    fid = await mk_file(db, user, "private-receipt.pdf")
    tasks = await mk_item(db, bob, "tasks", {"tasks": [{"id": "t1", "title": "Bring cake"}]})

    r = await client.post("/api/connections", headers=_auth(user), json={"a": {"kind": "event", "id": ev}, "b": {"kind": "file", "id": str(fid)}})
    assert r.status_code == 201, r.text
    link_id = r.json()["link_id"]
    r = await client.post("/api/connections", headers=_auth(bob), json={"a": {"kind": "event", "id": ev}, "b": {"kind": "task", "id": f"{tasks}:t1"}})
    assert r.status_code == 201, r.text

    bobs = await conns(client, bob, "event", ev)
    assert [x["title"] for x in bobs["linked"]] == ["Bring cake"]
    assert "private-receipt" not in str(bobs)
    anns = await conns(client, user, "event", ev)
    assert [x["title"] for x in anns["linked"]] == ["private-receipt.pdf"]  # not Bob's task
    assert (await client.delete(f"/api/connections/{link_id}", headers=_auth(bob))).status_code == 404


async def test_free_busy_only_event_is_invisible(client, db, user):
    from app.calendars.models import CalMember
    from app.links import refs

    bob = await mk_user(db, "bob")
    ev = await mk_event(client, user, title="Therapy")
    from app.calendars.models import CalEvent

    cal_id = (await db.get(CalEvent, uuid.UUID(ev))).calendar_id
    db.add(CalMember(calendar_id=cal_id, user_id=bob.id, role="busy"))
    await db.commit()
    assert await refs.resolve(db, bob, "event", ev) is None
    assert (await refs.resolve(db, user, "event", ev))["title"] == "Therapy"


async def test_picker_finds_only_your_things(client, db, user):
    bob = await mk_user(db, "bob")
    await mk_item(db, user, "tasks", {"tasks": [{"id": "t1", "title": "Plan holiday"}]})
    await mk_item(db, bob, "tasks", {"tasks": [{"id": "t2", "title": "Plan holiday secretly"}]})
    await mk_event(client, bob, title="Plan holiday dinner")
    r = await client.get("/api/connections/search", headers=_auth(user), params={"q": "holiday"})
    assert r.status_code == 200, r.text
    titles = [x["title"] for x in r.json()["results"]]
    assert titles == ["Plan holiday"]


async def test_photo_and_file_are_one_thing_and_tasks_open_on_their_task(client, db, user):
    fid = await mk_file(db, user, "beach.jpg")
    tasks = await mk_item(db, user, "tasks", {"tasks": [{"id": "t1", "title": "Print it"}]})
    r = await client.post("/api/connections", headers=_auth(user), json={"a": {"kind": "photo", "id": str(fid)}, "b": {"kind": "task", "id": f"{tasks}:t1"}})
    assert r.status_code == 201, r.text
    assert r.json()["href"] == f"/apps/tasks/{tasks}?task=t1"
    # Linked from Photos, it shows in Drive's details too (and the other way).
    assert [x["title"] for x in (await conns(client, user, "file", str(fid)))["linked"]] == ["Print it"]
    assert [x["title"] for x in (await conns(client, user, "photo", str(fid)))["linked"]] == ["Print it"]
    assert [x["kind"] for x in (await conns(client, user, "task", f"{tasks}:t1"))["linked"]] == ["file"]
