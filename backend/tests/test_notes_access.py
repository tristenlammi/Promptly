"""Notes: the access matrix (``docs/notes-plan.md`` §5, §8, §11).

owner / member / removed member / stranger / guessed id / trashed note ×
every route: anyone who can't open a note gets **404** — never 403, never
its text — and nothing changes. Also the readers that aren't routes on the
note: lists, search, labels, tags, links, the One trash, bulk, the live
stream.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_notes_core import H, client, get, home, live, mk_user, new_list, pushes, share  # noqa: F401 — fixtures


def routes(nid: str, iid: str, vid: str, uid: str, other_uid: str) -> list[tuple[str, str, dict | None]]:
    """Every route on one note (method, path, body)."""
    n = f"/api/notes/{nid}"
    return [
        ("GET", n, None),
        ("PATCH", n, {"base_revision": 1, "title": "pwned"}),
        ("POST", f"{n}/items", {"id": str(uuid.uuid4()), "text": "pwned"}),
        ("POST", f"{n}/items/bulk", {"action": "delete_ticked"}),
        ("PATCH", f"{n}/items/{iid}", {"checked": True}),
        ("DELETE", f"{n}/items/{iid}", None),
        ("PUT", f"{n}/me", {"pinned": True}),
        ("PUT", f"{n}/labels", {"tag_ids": []}),
        ("GET", f"{n}/members", None),
        ("POST", f"{n}/members", {"user_ids": [uid]}),
        ("DELETE", f"{n}/members/{uid}", None),
        ("DELETE", f"{n}/members/{other_uid}", None),
        ("GET", f"{n}/versions", None),
        ("GET", f"{n}/versions/{vid}", None),
        ("POST", f"{n}/versions/{vid}/restore", None),
        ("DELETE", n, None),
        ("POST", f"{n}/restore", None),
        ("DELETE", f"{n}/forever", None),
    ]


async def call(client, u, method, path, body):  # noqa: F811
    return await client.request(method, path, headers=H(u), json=body)


@pytest.fixture
async def world(client, db, pushes, live):  # noqa: F811
    """Ann's shopping list, shared with Bob; Dan was on it and was removed;
    Cat never was. Plus a note of Ann's in her Trash that Bob was on."""
    ann, bob, cat, dan = [await mk_user(db, n) for n in ("ann", "bob", "cat", "dan")]
    n = await new_list(client, ann)
    await share(client, ann, n["id"], bob, dan)
    t = (await client.post("/api/tags", headers=H(ann), json={"name": "home"})).json()
    await client.put(f"/api/notes/{n['id']}/labels", headers=H(ann), json={"tag_ids": [t["id"]]})
    td = (await client.post("/api/tags", headers=H(dan), json={"name": "groceries"})).json()
    r = await client.put(f"/api/notes/{n['id']}/labels", headers=H(dan), json={"tag_ids": [td["id"]]})
    assert r.status_code == 200
    r = await client.patch(f"/api/notes/{n['id']}", headers=H(ann), json={"base_revision": 1, "title": "Shopping list"})
    assert r.status_code == 200
    vid = (await client.get(f"/api/notes/{n['id']}/versions", headers=H(ann))).json()["versions"][0]["id"]
    r = await client.delete(f"/api/notes/{n['id']}/members/{dan.id}", headers=H(ann))
    assert r.status_code == 200
    trashed = await new_list(client, ann, title="Old bills")
    await share(client, ann, trashed["id"], bob)
    await client.delete(f"/api/notes/{trashed['id']}", headers=H(ann))
    return {"ann": ann, "bob": bob, "cat": cat, "dan": dan, "note": n, "trashed": trashed, "vid": vid, "tag": t}


async def snapshot(client, w):  # noqa: F811
    n = await get(client, w["ann"], w["note"]["id"])
    return (n["title"], n["revision"], n["change_seq"], [(i["id"], i["text"], i["checked"]) for i in n["items"]],
            [m["user_id"] for m in n["members"]], n["trashed_at"], n["labels"])


@pytest.mark.parametrize("who", ["cat", "dan"])
async def test_outsiders_get_404_on_every_route_and_change_nothing(client, world, who):  # noqa: F811
    w = world
    u = w[who]
    before = await snapshot(client, w)
    nid, iid = w["note"]["id"], w["note"]["items"][0]["id"]
    for method, path, body in routes(nid, iid, w["vid"], str(u.id), str(w["bob"].id)):
        r = await call(client, u, method, path, body)
        assert r.status_code == 404, (who, method, path, r.status_code, r.text)
        assert "Shopping" not in r.text and "Oat milk" not in r.text
    assert await snapshot(client, w) == before


async def test_a_guessed_id_is_404_everywhere(client, world):  # noqa: F811
    w = world
    for u in (w["ann"], w["bob"]):
        for method, path, body in routes(str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(u.id), str(w["cat"].id)):
            r = await call(client, u, method, path, body)
            assert r.status_code == 404, (method, path, r.status_code)


async def test_a_trashed_note_is_the_owners_alone(client, world):  # noqa: F811
    w = world
    nid = w["trashed"]["id"]
    iid = w["trashed"]["items"][0]["id"]
    for who in ("bob", "cat", "dan"):
        u = w[who]
        for method, path, body in routes(nid, iid, str(uuid.uuid4()), str(u.id), str(w["ann"].id)):
            r = await call(client, u, method, path, body)
            assert r.status_code == 404, (who, method, path, r.status_code)
    # Ann: read it, restore it, delete it for good — nothing else.
    ann = w["ann"]
    allowed = {("GET", f"/api/notes/{nid}"), ("POST", f"/api/notes/{nid}/restore"), ("DELETE", f"/api/notes/{nid}/forever")}
    for method, path, body in routes(nid, iid, str(uuid.uuid4()), str(w["bob"].id), str(w["cat"].id)):
        if (method, path) in allowed:
            continue
        r = await call(client, ann, method, path, body)
        assert r.status_code == 404, (method, path, r.status_code)
    assert (await call(client, ann, "GET", f"/api/notes/{nid}", None)).status_code == 200
    assert (await call(client, ann, "POST", f"/api/notes/{nid}/restore", None)).status_code == 200
    # Restored: Bob has it again.
    assert (await call(client, w["bob"], "GET", f"/api/notes/{nid}", None)).status_code == 200


async def test_owner_and_member_can_both_read_and_edit(client, world):  # noqa: F811
    w = world
    nid = w["note"]["id"]
    for who in ("ann", "bob"):
        u = w[who]
        rev = (await get(client, u, nid))["revision"]
        iid = str(uuid.uuid4())
        checks = [
            ("GET", f"/api/notes/{nid}", None, 200),
            ("PATCH", f"/api/notes/{nid}", {"base_revision": rev, "title": f"Shopping ({who})"}, 200),
            ("POST", f"/api/notes/{nid}/items", {"id": iid, "text": f"from {who}"}, 201),
            ("PATCH", f"/api/notes/{nid}/items/{iid}", {"checked": True}, 200),
            ("POST", f"/api/notes/{nid}/items/bulk", {"action": "delete_ticked"}, 200),
            ("PUT", f"/api/notes/{nid}/me", {"pinned": True}, 200),
            ("PUT", f"/api/notes/{nid}/labels", {"tag_ids": []}, 200),
            ("GET", f"/api/notes/{nid}/members", None, 200),
            ("GET", f"/api/notes/{nid}/versions", None, 200),
            ("GET", f"/api/notes/{nid}/versions/{w['vid']}", None, 200),
        ]
        for method, path, body, code in checks:
            r = await call(client, u, method, path, body)
            assert r.status_code == code, (who, method, path, r.status_code, r.text)
    # Only the owner shares, removes people or deletes for good (Bob knows
    # the note, so he's told why: 403).
    bob = w["bob"]
    assert (await call(client, bob, "POST", f"/api/notes/{nid}/members", {"user_ids": [str(w["cat"].id)]})).status_code == 403
    assert (await call(client, bob, "DELETE", f"/api/notes/{nid}/members/{w['ann'].id}", None)).status_code == 403
    assert (await call(client, bob, "DELETE", f"/api/notes/{nid}/forever", None)).status_code == 403
    assert (await call(client, bob, "POST", f"/api/notes/{nid}/restore", None)).status_code == 404
    full = await get(client, bob, nid)
    assert full["can"] == {"edit": True, "share": False, "delete": False, "leave": True}
    assert (await get(client, w["ann"], nid))["can"] == {"edit": True, "share": True, "delete": True, "leave": False}


async def test_removed_member_sees_nothing_anywhere(client, world, db, live):  # noqa: F811
    from app.auth.models import User
    from app.links import refs, search
    from app.tags import service as tags

    w = world
    nid = w["note"]["id"]
    for who in ("dan", "cat"):
        u = w[who]
        assert (await home(client, u))["notes"] == []
        assert (await home(client, u, q="Oat milk"))["notes"] == []
        assert (await home(client, u, view="archive"))["notes"] == []
        assert (await home(client, u, view="trash"))["notes"] == []
        assert (await home(client, u, type="shared"))["notes"] == []
        assert (await client.get("/api/notes/labels", headers=H(u))).json() == {"labels": []}
        assert not [i for i in (await client.get("/api/trash", headers=H(u))).json()["items"] if i["type"] == "note"]
        r = await client.post("/api/trash/restore", headers=H(u), json={"items": [{"type": "note", "id": w["trashed"]["id"]}]})
        assert r.json()["done"] == 0
        r = await client.post("/api/trash/purge", headers=H(u), json={"items": [{"type": "note", "id": w["trashed"]["id"]}]})
        assert r.json()["done"] == 0
        r = await client.post("/api/notes/bulk", headers=H(u), json={"ids": [nid], "action": "trash"})
        assert r.json() == {"done": [], "skipped": 1}
        assert (await client.get("/api/tags/entity", headers=H(u), params={"kind": "note", "id": nid})).status_code == 404
        assert (await client.get("/api/connections/resolve", headers=H(u), params={"kind": "note", "id": nid})).status_code == 404
        res = (await client.get("/api/connections/search", headers=H(u), params={"q": "Shopping", "kinds": "note"})).json()
        assert res["results"] == []
        row = await db.get(User, u.id)
        assert await refs.resolve(db, row, "note", nid) is None
        assert await search.search(db, row, "milk", kinds={"note"}) == []
        assert not await tags.can_see(db, row, "note", nid)
        # Creating "a new note" with someone else's id can't reach theirs.
        r = await client.post("/api/notes", headers=H(u), json={"client_id": nid, "title": "mine now"})
        assert r.status_code == 404
    # The removed member's own labels on it went with them.
    from sqlalchemy import func, select

    from app.tags.models import TagAssignment

    left = await db.scalar(select(func.count()).select_from(TagAssignment).where(TagAssignment.user_id == w["dan"].id))
    assert left == 0
    # …and live events about it go only to the people still on it.
    live.clear()
    rev = (await get(client, w["ann"], nid))["revision"]
    await client.patch(f"/api/notes/{nid}", headers=H(w["ann"]), json={"base_revision": rev, "title": "Shop"})
    await client.patch(f"/api/notes/{nid}/items/{w['note']['items'][1]['id']}", headers=H(w["bob"]), json={"checked": True})
    assert live and all(to == {str(w["ann"].id), str(w["bob"].id)} for to, _ in live)
    assert all(set(ev) <= {"type", "id", "revision", "change_seq"} for _, ev in live)


async def test_removal_is_immediate_mid_session(client, world, live):  # noqa: F811
    """Bob has the note open; Ann removes him: his next call of any kind 404s,
    and his stream is told the note is gone."""
    w = world
    nid = w["note"]["id"]
    bob = w["bob"]
    assert (await call(client, bob, "GET", f"/api/notes/{nid}", None)).status_code == 200
    live.clear()
    await client.delete(f"/api/notes/{nid}/members/{bob.id}", headers=H(w["ann"]))
    assert ({str(bob.id)}, {"type": "gone", "id": nid}) in live
    for method, path, body in routes(nid, w["note"]["items"][0]["id"], w["vid"], str(bob.id), str(w["ann"].id)):
        r = await call(client, bob, method, path, body)
        assert r.status_code == 404, (method, path, r.status_code)
