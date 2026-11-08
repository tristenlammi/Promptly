"""Notes core (N1.1): create / edit / items, 409 and safe replays, per-person
state, labels, sharing, versions, trash and the One trash, links, the live
stream. The who-can-see-what matrix is in ``test_notes_access.py``."""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

UTC = timezone.utc


# ------------------------------------------------------------------ body (no DB)


def test_body_is_cleaned_to_the_small_schema():
    from app.notes import body as B

    doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 5, "id": "b1"}, "content": [{"type": "text", "text": "Big"}]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "click", "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}, {"type": "bold"}]},
                {"type": "text", "text": " ok", "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}, {"type": "strike"}]},
            ]},
            {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "in a list"}]}]}]},
            {"type": "codeBlock", "content": [{"type": "text", "text": "x = 1"}]},
            {"type": "image", "attrs": {"src": "http://evil"}},
        ],
    }
    out = B.clean_doc(doc)
    assert out["content"][0] == {"type": "heading", "attrs": {"id": "b1", "level": 2}, "content": [{"type": "text", "text": "Big"}]}
    para = out["content"][1]["content"]
    assert para[0] == {"type": "text", "text": "click", "marks": [{"type": "bold"}]}
    assert para[1]["marks"] == [{"type": "link", "attrs": {"href": "https://example.com"}}]
    assert [b["type"] for b in out["content"]] == ["heading", "paragraph", "paragraph", "paragraph"]
    assert B.doc_text(out) == "Big\nclick ok\nin a list\nx = 1"
    assert B.clean_doc({"type": "doc", "content": [{"type": "paragraph"}]}) is None
    with pytest.raises(B.BodyError):
        B.clean_doc({"type": "not-a-doc"})
    with pytest.raises(B.BodyError):
        B.checked_text("x" * (B.MAX_TEXT + 1))


def test_events_carry_ids_only():
    from app.notes import events

    with pytest.raises(ValueError):
        asyncio.run(events.publish([uuid.uuid4()], {"type": "note", "id": "x", "title": "Gate code"}))


# ------------------------------------------------------------------ API harness


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
def pushes(monkeypatch):
    sent: list[dict] = []

    async def fake(**kw):
        sent.append(kw)

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)
    return sent


@pytest.fixture
def live(monkeypatch):
    """Every live event, as (recipients, event), checked for ids only."""
    from app.notes import events

    got: list[tuple[set[str], dict]] = []

    async def fake(user_ids, event):
        assert set(event) <= events.EVENT_KEYS
        got.append(({str(u) for u in user_ids}, dict(event)))

    monkeypatch.setattr(events, "publish", fake)
    return got


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


async def new_note(client, u, **kw):
    body = {"client_id": str(uuid.uuid4()), "title": "Gate", "text": "Gate code 4471", **kw}
    r = await client.post("/api/notes", headers=H(u), json=body)
    assert r.status_code == 201, r.text
    return r.json()["note"]


async def new_list(client, u, items=("Oat milk", "Eggs", "Bread"), **kw):
    kw.setdefault("title", "Shopping")
    return await new_note(client, u, kind="list", text=None,
                          items=[{"id": str(uuid.uuid4()), "text": t} for t in items], **kw)


async def get(client, u, nid):
    r = await client.get(f"/api/notes/{nid}", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["note"]


async def home(client, u, **params):
    r = await client.get("/api/notes", headers=H(u), params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def share(client, owner, nid, *users):
    r = await client.post(f"/api/notes/{nid}/members", headers=H(owner), json={"user_ids": [str(u.id) for u in users]})
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------ create / edit


async def test_create_is_saved_and_a_retry_makes_no_second_note(client, people, live):
    ann, _, _ = people
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "title": "Gate", "text": "Gate code 4471\nSide door"}
    r1 = await client.post("/api/notes", headers=H(ann), json=body)
    r2 = await client.post("/api/notes", headers=H(ann), json=body)
    assert r1.status_code == 201 and r2.status_code == 200
    assert r1.json()["note"]["id"] == r2.json()["note"]["id"] == cid
    n = r1.json()["note"]
    assert n["body_text"] == "Gate code 4471\nSide door" and n["kind"] == "text" and n["revision"] == 1 and n["is_owner"]
    assert [c["id"] for c in (await home(client, ann))["notes"]] == [cid]
    # Only my own devices hear about my new note.
    assert live == [({str(ann.id)}, {"type": "note", "id": cid, "revision": 1, "change_seq": 1})]


async def test_create_checks_its_input(client, people):
    ann, _, _ = people
    r = await client.post("/api/notes", headers=H(ann), json={"color": "neon"})
    assert r.status_code == 400
    r = await client.post("/api/notes", headers=H(ann), json={"kind": "text", "items": [{"text": "x"}]})
    assert r.status_code == 400
    r = await client.post("/api/notes", headers=H(ann), json={"text": "x" * 20_001})
    assert r.status_code == 400 and "Open as document" in r.json()["detail"]
    # A list from lines of text (the share sheet), indents under the item above.
    n = await new_note(client, ann, kind="list", text="milk\n\neggs")
    assert [i["text"] for i in n["items"]] == ["milk", "eggs"]
    n = await new_list(client, ann, items=())
    r = await client.post("/api/notes", headers=H(ann), json={
        "kind": "list", "items": [{"text": "Fruit"}, {"text": "apples", "indent": True}, {"text": "Bread"}]})
    items = r.json()["note"]["items"]
    assert items[1]["parent_id"] == items[0]["id"] and items[2]["parent_id"] is None


async def test_stale_save_gets_409_with_the_latest_and_replays_are_safe(client, people, live):
    ann, bob, _ = people
    n = await new_note(client, ann)
    await share(client, ann, n["id"], bob)
    first = {"base_revision": 1, "title": "Gate (front)"}
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json=first)
    assert r.status_code == 200 and r.json()["changed"] and r.json()["note"]["revision"] == 2
    # Bob was editing from revision 1: refused, with the current note to merge.
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(bob), json={"base_revision": 1, "title": "Gate (back)"})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["note"]["revision"] == 2 and detail["note"]["title"] == "Gate (front)" and "message" in detail
    # Ann's first save, retried after a lost answer: fine, nothing changes.
    live.clear()
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json=first)
    assert r.status_code == 200 and not r.json()["changed"] and r.json()["note"]["revision"] == 2
    assert live == []
    # Bob merges and replays on the latest revision.
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(bob), json={"base_revision": 2, "title": "Gate (front + back)"})
    assert r.status_code == 200 and r.json()["note"]["revision"] == 3
    assert {tuple(sorted(to)) for to, _ in live} == {tuple(sorted((str(ann.id), str(bob.id))))}
    after = await get(client, ann, n["id"])
    assert after["title"] == "Gate (front + back)" and after["edited_by"] == str(bob.id)


async def test_body_colour_and_kind(client, people):
    ann, _, _ = people
    n = await new_note(client, ann)
    doc = {"type": "doc", "content": [{"type": "paragraph", "attrs": {"id": "p1"}, "content": [{"type": "text", "text": "Eggs"}]},
                                      {"type": "paragraph", "content": [{"type": "text", "text": "Milk"}]}]}
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 1, "body_doc": doc, "color": "mint"})
    note = r.json()["note"]
    assert note["body_text"] == "Eggs\nMilk" and note["color"] == "mint" and note["body_doc"]["content"][0]["attrs"]["id"] == "p1"
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 2, "color": "neon"})
    assert r.status_code == 400
    # Show checkboxes: a line each. Hide them: back to lines, nothing lost.
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 2, "kind": "list"})
    note = r.json()["note"]
    assert note["kind"] == "list" and [i["text"] for i in note["items"]] == ["Eggs", "Milk"] and note["body_text"] == ""
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 3, "kind": "text"})
    note = r.json()["note"]
    assert note["kind"] == "text" and note["body_text"] == "Eggs\nMilk" and note["items"] == []
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 4, "list_opts": {"hide_checked": True}})
    assert r.json()["note"]["list_opts"] == {"hide_checked": True}


# ------------------------------------------------------------------ items


async def test_items_are_idempotent_and_never_conflict(client, people, live):
    ann, bob, _ = people
    n = await new_list(client, ann)
    await share(client, ann, n["id"], bob)
    milk, eggs, bread = (i["id"] for i in n["items"])
    url = f"/api/notes/{n['id']}/items"
    # Bob adds below Eggs; the retry returns the same item.
    new = {"id": str(uuid.uuid4()), "text": "Butter", "after_id": eggs}
    r1 = await client.post(url, headers=H(bob), json=new)
    r2 = await client.post(url, headers=H(bob), json=new)
    assert r1.status_code == 201 and r2.status_code == 200 and r1.json()["item"] == r2.json()["item"]
    # Ticks from both sides, and a title save on a stale-for-items revision
    # still works (items don't move the revision).
    r = await client.patch(f"{url}/{milk}", headers=H(bob), json={"checked": True})
    seq = r.json()["change_seq"]
    assert r.json()["item"]["checked"] and r.json()["item"]["checked_by"] == str(bob.id)
    r = await client.patch(f"{url}/{milk}", headers=H(bob), json={"checked": True})
    assert r.json()["change_seq"] == seq  # a repeated tick changes nothing
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 1, "title": "Shop"})
    assert r.status_code == 200
    note = await get(client, ann, n["id"])
    assert [i["text"] for i in note["items"]] == ["Oat milk", "Eggs", "Butter", "Bread"]
    # Indent, one level only; delete twice is fine; another note's item 404s.
    r = await client.patch(f"{url}/{new['id']}", headers=H(ann), json={"parent_id": eggs})
    assert r.json()["item"]["parent_id"] == eggs
    r = await client.patch(f"{url}/{bread}", headers=H(ann), json={"parent_id": new["id"]})
    assert r.status_code == 400
    r = await client.patch(f"{url}/{eggs}", headers=H(ann), json={"parent_id": milk})
    assert r.status_code == 400  # Eggs has a child now
    r = await client.patch(f"{url}/{new['id']}", headers=H(ann), json={"parent_id": None})
    assert r.json()["item"]["parent_id"] is None
    assert (await client.delete(f"{url}/{bread}", headers=H(ann))).status_code == 204
    assert (await client.delete(f"{url}/{bread}", headers=H(ann))).status_code == 204
    other = await new_list(client, ann, items=("x",))
    r = await client.patch(f"{url}/{other['items'][0]['id']}", headers=H(ann), json={"checked": True})
    assert r.status_code == 404
    r = await client.post(url, headers=H(ann), json={"id": other["items"][0]["id"], "text": "steal"})
    assert r.status_code == 404
    # Items only on lists.
    text_note = await new_note(client, ann)
    r = await client.post(f"/api/notes/{text_note['id']}/items", headers=H(ann), json={"id": str(uuid.uuid4()), "text": "x"})
    assert r.status_code == 400


async def test_item_bulk_actions(client, people):
    ann, _, _ = people
    n = await new_list(client, ann, items=("pears", "Apples", "bananas"))
    url = f"/api/notes/{n['id']}/items"
    a, b, c = (i["id"] for i in n["items"])
    await client.patch(f"{url}/{c}", headers=H(ann), json={"parent_id": b})
    r = await client.post(f"{url}/bulk", headers=H(ann), json={"action": "sort"})
    assert [i["text"] for i in r.json()["items"]] == ["Apples", "bananas", "pears"]  # child stays under its parent
    await client.patch(f"{url}/{a}", headers=H(ann), json={"checked": True})
    await client.patch(f"{url}/{b}", headers=H(ann), json={"checked": True})
    r = await client.post(f"{url}/bulk", headers=H(ann), json={"action": "untick_all"})
    assert not any(i["checked"] for i in r.json()["items"])
    await client.patch(f"{url}/{b}", headers=H(ann), json={"checked": True})
    r = await client.post(f"{url}/bulk", headers=H(ann), json={"action": "delete_ticked"})
    items = r.json()["items"]
    assert [i["text"] for i in items] == ["bananas", "pears"] and all(i["parent_id"] is None for i in items)


async def test_item_positions_survive_many_inserts(client, people):
    ann, _, _ = people
    n = await new_list(client, ann, items=("a", "z"))
    url = f"/api/notes/{n['id']}/items"
    after = n["items"][0]["id"]
    for k in range(60):  # always straight after "a": the gap halves each time
        r = await client.post(url, headers=H(ann), json={"id": str(uuid.uuid4()), "text": f"n{k}", "after_id": after})
        assert r.status_code == 201
    texts = [i["text"] for i in (await get(client, ann, n["id"]))["items"]]
    assert texts[0] == "a" and texts[-1] == "z" and texts[1] == "n59" and len(texts) == 62


# ------------------------------------------------------------------ yours


async def test_pin_archive_order_are_per_person(client, people):
    ann, bob, _ = people
    a = await new_note(client, ann, title="A")
    b = await new_note(client, ann, title="B")
    c = await new_note(client, ann, title="C")
    assert [x["title"] for x in (await home(client, ann))["notes"]] == ["C", "B", "A"]  # newest first
    await client.put(f"/api/notes/{a['id']}/me", headers=H(ann), json={"pinned": True})
    await client.put(f"/api/notes/{c['id']}/me", headers=H(ann), json={"position": 100})
    assert [x["title"] for x in (await home(client, ann))["notes"]] == ["A", "B", "C"]
    await share(client, ann, a["id"], bob)
    bob_view = (await home(client, bob))["notes"]
    assert [x["title"] for x in bob_view] == ["A"] and not bob_view[0]["pinned"]
    # Archiving unpins (as in Keep) and moves it to Archive.
    r = await client.put(f"/api/notes/{a['id']}/me", headers=H(ann), json={"archived": True})
    assert r.json()["me"]["archived"] and not r.json()["me"]["pinned"]
    assert [x["title"] for x in (await home(client, ann))["notes"]] == ["B", "C"]
    assert [x["title"] for x in (await home(client, ann, view="archive"))["notes"]] == ["A"]
    assert [x["title"] for x in (await home(client, bob))["notes"]] == ["A"]  # still on Bob's home


async def test_changed_dot(client, people):
    ann, bob, _ = people
    n = await new_list(client, ann)
    await share(client, ann, n["id"], bob)
    card = (await home(client, ann))["notes"][0]
    assert not card["changed"]
    await client.patch(f"/api/notes/{n['id']}/items/{n['items'][0]['id']}", headers=H(bob), json={"checked": True})
    assert (await home(client, ann))["notes"][0]["changed"]
    assert not (await home(client, bob))["notes"][0]["changed"]  # your own change isn't news
    await client.put(f"/api/notes/{n['id']}/me", headers=H(ann), json={"seen": True})
    assert not (await home(client, ann))["notes"][0]["changed"]


async def test_labels_are_your_own_tags(client, people):
    ann, bob, _ = people
    n = await new_note(client, ann)
    other = await new_note(client, ann, title="Other")
    await share(client, ann, n["id"], bob)
    t_ann = (await client.post("/api/tags", headers=H(ann), json={"name": "recipes"})).json()
    t_bob = (await client.post("/api/tags", headers=H(bob), json={"name": "home"})).json()
    r = await client.put(f"/api/notes/{n['id']}/labels", headers=H(ann), json={"tag_ids": [t_ann["id"]]})
    assert [t["name"] for t in r.json()["labels"]] == ["recipes"]
    r = await client.put(f"/api/notes/{n['id']}/labels", headers=H(bob), json={"tag_ids": [t_ann["id"]]})
    assert r.status_code == 400  # not Bob's tag
    await client.put(f"/api/notes/{n['id']}/labels", headers=H(bob), json={"tag_ids": [t_bob["id"]]})
    assert [t["name"] for t in (await get(client, ann, n["id"]))["labels"]] == ["recipes"]
    assert [t["name"] for t in (await get(client, bob, n["id"]))["labels"]] == ["home"]
    # Filter, rail counts, and "everything tagged #recipes".
    assert [x["id"] for x in (await home(client, ann, label=t_ann["id"]))["notes"]] == [n["id"]]
    assert (await client.get("/api/notes/labels", headers=H(ann))).json()["labels"] == [
        {"id": t_ann["id"], "name": "recipes", "color": None, "count": 1}
    ]
    items = (await client.get(f"/api/tags/{t_ann['id']}/items", headers=H(ann))).json()
    found = items["items"] if isinstance(items, dict) and "items" in items else items
    assert any(i["kind"] == "note" and i["id"] == n["id"] and i["url"] == f"/notes/n/{n['id']}" for i in found)
    # The generic tag routes work on notes too.
    r = await client.post("/api/tags/assign", headers=H(ann), json={"tag_id": t_ann["id"], "kind": "note", "id": other["id"]})
    assert r.status_code == 200, r.text
    assert [t["name"] for t in (await get(client, ann, other["id"]))["labels"]] == ["recipes"]
    # Bulk label, then unlabel.
    r = await client.post("/api/notes/bulk", headers=H(ann), json={"ids": [n["id"], other["id"]], "action": "unlabel", "tag_id": t_ann["id"]})
    assert len(r.json()["done"]) == 2
    assert (await get(client, ann, other["id"]))["labels"] == []


# ------------------------------------------------------------------ lists and search


async def test_filters_search_and_paging(client, people):
    ann, bob, _ = people
    gate = await new_note(client, ann, title="Gate", text="Gate code 4471")
    shop = await new_list(client, ann, color="sand")
    lyric = await new_note(client, ann, title="Song", text="The chorus goes up a fifth")
    await share(client, ann, shop["id"], bob)
    ids = lambda page: [c["id"] for c in page["notes"]]  # noqa: E731
    assert ids(await home(client, ann, q="4471")) == [gate["id"]]
    assert ids(await home(client, ann, q="447")) == [gate["id"]]  # as you type
    assert ids(await home(client, ann, q="eggs")) == [shop["id"]]  # items are searched
    assert ids(await home(client, ann, q="choruses")) == [lyric["id"]]  # stemmed
    assert ids(await home(client, ann, type="list")) == [shop["id"]]
    assert ids(await home(client, ann, type="shared")) == [shop["id"]]
    assert ids(await home(client, bob, type="shared")) == [shop["id"]]
    assert ids(await home(client, ann, color="sand")) == [shop["id"]]
    assert ids(await home(client, ann, type="image")) == []
    assert (await client.get("/api/notes", headers=H(ann), params={"view": "nope"})).status_code == 400
    card = next(c for c in (await home(client, ann))["notes"] if c["id"] == shop["id"])
    assert card["items_total"] == 3 and len(card["items"]) == 3 and card["shared"] and card["member_ids"] == [str(bob.id)]
    # Paging: every note once, in order.
    for k in range(5):
        await new_note(client, ann, title=f"n{k}")
    await client.put(f"/api/notes/{gate['id']}/me", headers=H(ann), json={"pinned": True})
    seen: list[str] = []
    cursor = None
    while True:
        page = await home(client, ann, limit=3, **({"cursor": cursor} if cursor else {}))
        seen += ids(page)
        cursor = page["next_cursor"]
        if not cursor:
            break
    full = ids(await home(client, ann, limit=200))
    assert seen == full and len(full) == 8 and full[0] == gate["id"]
    assert (await client.get("/api/notes", headers=H(ann), params={"view": "archive", "cursor": cursor or "x"})).status_code == 400


# ------------------------------------------------------------------ sharing


async def test_sharing_push_leave_and_remove(client, people, pushes, live, db):
    ann, bob, cat = people
    n = await new_list(client, ann)
    out = await share(client, ann, n["id"], bob, ann)  # adding yourself is ignored
    assert [m["user_id"] for m in out["members"]] == [str(bob.id)] and out["note"].startswith("Only the people you add")
    assert len(pushes) == 1 and pushes[0]["user_id"] == bob.id and pushes[0]["category"] == "notes"
    assert pushes[0]["actor_user_id"] == ann.id and pushes[0]["url"] == f"/notes/n/{n['id']}"
    assert "shared “Shopping” with you" in pushes[0]["title"]
    # Sharing again pushes nothing new.
    await share(client, ann, n["id"], bob)
    assert len(pushes) == 1
    # Only the owner shares.
    r = await client.post(f"/api/notes/{n['id']}/members", headers=H(bob), json={"user_ids": [str(cat.id)]})
    assert r.status_code == 403
    r = await client.post(f"/api/notes/{n['id']}/members", headers=H(ann), json={"user_ids": [str(uuid.uuid4())]})
    assert r.status_code == 400
    # Bob leaves (DELETE on someone else's note = Leave).
    live.clear()
    r = await client.delete(f"/api/notes/{n['id']}", headers=H(bob))
    assert r.json() == {"left": True}
    assert ({str(bob.id)}, {"type": "gone", "id": n["id"]}) in live
    assert (await client.get(f"/api/notes/{n['id']}", headers=H(bob))).status_code == 404
    assert (await get(client, ann, n["id"]))["members"] == []
    # Owner adds Cat back then removes her; she can't remove anyone else.
    await share(client, ann, n["id"], cat, bob)
    r = await client.delete(f"/api/notes/{n['id']}/members/{bob.id}", headers=H(cat))
    assert r.status_code == 403
    r = await client.delete(f"/api/notes/{n['id']}/members/{cat.id}", headers=H(ann))
    assert r.status_code == 200 and [m["user_id"] for m in r.json()["members"]] == [str(bob.id)]
    r = await client.delete(f"/api/notes/{n['id']}/members/{ann.id}", headers=H(ann))
    assert r.status_code == 400  # the owner can't leave their own note


async def test_sharing_hook_refuses_blocked_people(client, people, db):
    """The one hook (access.sharing_refused) reads ``user_blocks`` once the
    shared blocks groundwork exists; here the table is stood in for."""
    from sqlalchemy import text

    ann, bob, _ = people
    made = not await db.scalar(text("SELECT to_regclass('public.user_blocks') IS NOT NULL"))
    if made:
        await db.execute(text("CREATE TABLE user_blocks (blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, PRIMARY KEY (blocker_id, blocked_id))"))
    await db.execute(text("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (:a, :b)"), {"a": bob.id, "b": ann.id})
    await db.commit()
    try:
        n = await new_note(client, ann)
        r = await client.post(f"/api/notes/{n['id']}/members", headers=H(ann), json={"user_ids": [str(bob.id)]})
        assert r.status_code == 400 and "can't share" in r.json()["detail"]
    finally:
        if made:
            await db.execute(text("DROP TABLE user_blocks"))
        else:
            await db.execute(text("DELETE FROM user_blocks WHERE blocker_id = :a"), {"a": bob.id})
        await db.commit()


async def test_bulk(client, people, live):
    ann, bob, cat = people
    a = await new_note(client, ann, title="A")
    b = await new_note(client, ann, title="B")
    s = await new_note(client, bob, title="Bob's")
    await share(client, bob, s["id"], ann)
    secret = await new_note(client, cat, title="Cat's")
    r = await client.post("/api/notes/bulk", headers=H(ann), json={"ids": [a["id"], b["id"], secret["id"]], "action": "pin"})
    assert sorted(r.json()["done"]) == sorted([a["id"], b["id"]]) and r.json()["skipped"] == 1
    r = await client.post("/api/notes/bulk", headers=H(ann), json={"ids": [a["id"], s["id"]], "action": "color", "color": "coral"})
    assert (await get(client, bob, s["id"]))["color"] == "coral"  # colour is shared
    r = await client.post("/api/notes/bulk", headers=H(ann), json={"ids": [a["id"], s["id"]], "action": "trash"})
    assert len(r.json()["done"]) == 2
    assert (await client.get(f"/api/notes/{s['id']}", headers=H(ann))).status_code == 404  # left Bob's
    assert (await get(client, bob, s["id"]))["members"] == []
    assert [x["id"] for x in (await home(client, ann, view="trash"))["notes"]] == [a["id"]]
    assert (await get(client, cat, secret["id"]))["color"] == "default"


# ------------------------------------------------------------------ versions


async def test_versions_throttle_restore_and_cap(client, people, db):
    from sqlalchemy import update

    from app.auth.models import User
    from app.notes import service
    from app.notes.models import Note, NoteVersion

    ann, bob, _ = people
    n = await new_list(client, ann)
    await share(client, ann, n["id"], bob)
    url = f"/api/notes/{n['id']}"
    await client.patch(url, headers=H(ann), json={"base_revision": 1, "title": "Shop 1"})
    await client.patch(url, headers=H(ann), json={"base_revision": 2, "title": "Shop 2"})
    await client.patch(f"{url}/items/{n['items'][0]['id']}", headers=H(bob), json={"checked": True})
    vs = (await client.get(f"{url}/versions", headers=H(bob))).json()["versions"]
    assert len(vs) == 1 and vs[0]["title"] == "Shopping" and vs[0]["reason"] == "edit"  # one per 10 minutes
    await db.execute(update(NoteVersion).values(created_at=datetime.now(UTC) - timedelta(minutes=11)))
    await db.commit()
    await client.patch(url, headers=H(ann), json={"base_revision": 3, "title": "Shop 3"})
    vs = (await client.get(f"{url}/versions", headers=H(ann))).json()["versions"]
    assert [v["title"] for v in vs] == ["Shop 2", "Shopping"]
    full = (await client.get(f"{url}/versions/{vs[1]['id']}", headers=H(ann))).json()["version"]
    assert [i["text"] for i in full["snapshot"]["items"]] == ["Oat milk", "Eggs", "Bread"]
    # Bob restores the first one: title and the unticked items come back,
    # and what was there is kept as a version first.
    r = await client.post(f"{url}/versions/{vs[1]['id']}/restore", headers=H(bob))
    note = r.json()["note"]
    assert note["title"] == "Shopping" and not any(i["checked"] for i in note["items"]) and note["revision"] == 5
    vs = (await client.get(f"{url}/versions", headers=H(ann))).json()["versions"]
    assert vs[0]["reason"] == "restore" and vs[0]["title"] == "Shop 3"
    # Only the last 30 stay.
    row = await db.get(Note, uuid.UUID(n["id"]))
    who = await db.get(User, ann.id)
    for _ in range(35):
        await service.save_version(db, row, who, reason="ai")
    await db.commit()
    assert len((await client.get(f"{url}/versions", headers=H(ann))).json()["versions"]) == 30
    other = await new_note(client, ann)
    r = await client.get(f"/api/notes/{other['id']}/versions/{vs[0]['id']}", headers=H(ann))
    assert r.status_code == 404


# ------------------------------------------------------------------ trash


async def test_trash_in_place_and_the_one_trash(client, people, live, db):
    ann, bob, _ = people
    n = await new_list(client, ann, title="Bills")
    await share(client, ann, n["id"], bob)
    live.clear()
    r = await client.delete(f"/api/notes/{n['id']}", headers=H(ann))
    assert r.json() == {"trashed": True}
    assert ({str(bob.id)}, {"type": "gone", "id": n["id"]}) in live
    assert (await home(client, ann))["notes"] == []
    assert [x["id"] for x in (await home(client, ann, view="trash"))["notes"]] == [n["id"]]
    assert (await home(client, bob, view="trash"))["notes"] == []
    # The owner can still read it in Trash, not edit it.
    assert (await get(client, ann, n["id"]))["trashed_at"] is not None
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 1, "title": "x"})
    assert r.status_code == 404
    # One trash: listed under Notes; restore puts it back for everyone.
    t = (await client.get("/api/trash", headers=H(ann))).json()["items"]
    row = next(i for i in t if i["type"] == "note")
    assert row["id"] == n["id"] and row["app"] == "notes" and row["title"] == "Bills" and row["location"] == "Notes"
    assert not [i for i in (await client.get("/api/trash", headers=H(bob))).json()["items"] if i["type"] == "note"]
    r = await client.post("/api/trash/restore", headers=H(bob), json={"items": [{"type": "note", "id": n["id"]}]})
    assert r.json()["done"] == 0
    r = await client.post("/api/trash/restore", headers=H(ann), json={"items": [{"type": "note", "id": n["id"]}]})
    assert r.json()["done"] == 1 and r.json()["results"][0]["location"] == "Notes"
    assert [x["id"] for x in (await home(client, bob))["notes"]] == [n["id"]]
    # Purge from the One trash.
    await client.delete(f"/api/notes/{n['id']}", headers=H(ann))
    r = await client.post("/api/trash/purge", headers=H(ann), json={"items": [{"type": "note", "id": n["id"]}]})
    assert r.json()["done"] == 1
    assert (await client.get(f"/api/notes/{n['id']}", headers=H(ann))).status_code == 404
    # Empty the trash (Notes' own, and the One trash's).
    a = await new_note(client, ann)
    b = await new_note(client, ann)
    await client.delete(f"/api/notes/{a['id']}", headers=H(ann))
    assert (await client.delete("/api/notes/trash", headers=H(ann))).json() == {"deleted": 1}
    await client.delete(f"/api/notes/{b['id']}", headers=H(ann))
    assert (await client.delete("/api/trash", headers=H(ann))).json()["deleted"] >= 1
    assert (await home(client, ann, view="trash"))["notes"] == []


async def test_trash_expires_after_30_days(client, people, db):
    from sqlalchemy import update

    from app.notes import service
    from app.notes.models import Note

    ann, _, _ = people
    old = await new_note(client, ann)
    recent = await new_note(client, ann)
    for x in (old, recent):
        await client.delete(f"/api/notes/{x['id']}", headers=H(ann))
    await db.execute(update(Note).where(Note.id == uuid.UUID(old["id"])).values(trashed_at=datetime.now(UTC) - timedelta(days=31)))
    await db.commit()
    assert await service.purge_expired(db) == 1
    await db.commit()
    assert [x["id"] for x in (await home(client, ann, view="trash"))["notes"]] == [recent["id"]]


async def test_forever_drops_labels_and_links(client, people, db):
    from sqlalchemy import func, select

    from app.links.models import EntityLink
    from app.tags.models import TagAssignment

    ann, bob, _ = people
    target = await new_note(client, ann, title="Target")
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "see", "marks": [{"type": "link", "attrs": {"href": f"/link/note/{target['id']}"}}]}]}]}
    src = await new_note(client, ann, title="Source", text=None, body_doc=doc)
    await share(client, ann, src["id"], bob)
    t = (await client.post("/api/tags", headers=H(ann), json={"name": "x"})).json()
    await client.put(f"/api/notes/{src['id']}/labels", headers=H(ann), json={"tag_ids": [t["id"]]})
    con = (await client.get("/api/connections", headers=H(ann), params={"kind": "note", "id": target["id"]})).json()
    assert [m["id"] for m in con["mentioned_in"]] == [src["id"]]
    assert (await client.get("/api/connections", headers=H(bob), params={"kind": "note", "id": target["id"]})).status_code == 404
    # A member can't delete for good; the owner can.
    assert (await client.delete(f"/api/notes/{src['id']}/forever", headers=H(bob))).status_code == 403
    assert (await client.delete(f"/api/notes/{src['id']}/forever", headers=H(ann))).json() == {"deleted": True}
    assert await db.scalar(select(func.count()).select_from(TagAssignment).where(TagAssignment.entity_kind == "note")) == 0
    assert await db.scalar(select(func.count()).select_from(EntityLink).where(EntityLink.source_kind == "note")) == 0


# ------------------------------------------------------------------ links picker and resolve


async def test_links_resolve_and_picker(client, people, db):
    from app.auth.models import User
    from app.links import refs, search

    ann, bob, cat = people
    n = await new_list(client, ann)
    await share(client, ann, n["id"], bob)
    got = (await client.get("/api/connections/resolve", headers=H(bob), params={"kind": "note", "id": n["id"]})).json()
    assert got["title"] == "Shopping" and got["href"] == f"/notes/n/{n['id']}" and got["label"] == "Note"
    assert (await client.get("/api/connections/resolve", headers=H(cat), params={"kind": "note", "id": n["id"]})).status_code == 404
    c = await db.get(User, cat.id)
    assert await refs.resolve(db, c, "note", n["id"]) is None
    r = (await client.get("/api/connections/search", headers=H(bob), params={"q": "eggs", "kinds": "note"})).json()["results"]
    assert [x["id"] for x in r] == [n["id"]]
    assert await search.search(db, c, "eggs", kinds={"note"}) == []


# ------------------------------------------------------------------ live stream (real Redis)


class _Req:
    async def is_disconnected(self) -> bool:
        return False


async def test_stream_delivers_ids_only(client, people):
    from app.notes import events

    ann, bob, _ = people
    n = await new_note(client, ann, title="Gate code", text="4471")
    await share(client, ann, n["id"], bob)
    gen = events.stream(bob.id, _Req())
    assert await gen.__anext__() == ": connected\n\n"
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 1, "title": "Gate code (new)"})
    assert r.status_code == 200
    chunk = await asyncio.wait_for(gen.__anext__(), timeout=10)
    while chunk.startswith(":"):
        chunk = await asyncio.wait_for(gen.__anext__(), timeout=25)
    assert chunk.startswith("data: ")
    data = json.loads(chunk[len("data: "):])
    assert data == {"type": "note", "id": n["id"], "revision": 2, "change_seq": 2}
    assert "Gate" not in chunk and "4471" not in chunk
    await gen.aclose()
    assert (await client.get("/api/notes/events")).status_code == 401
