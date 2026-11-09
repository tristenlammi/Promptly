"""Notes W1.3: what the phone's Notes widgets and quick capture send (``/api/widgets``).

* Quick note (text or list), Voice note and Share to Notes make one note of
  yours, safe to send twice (``client_id`` is the note's id);
* a recording uploaded with tus ``route=note`` is attached and queued for its
  words; a picture shows on the card; someone else's file is 404 and nothing
  is made;
* shared text with a link and no title gets the page's title;
* Share → Add to…: lines become items on a list, paragraphs on a text note;
* the One note widget: add an item, tick one, pick a note; other people's
  notes are 404 and never listed;
* a phone password without ``widgets`` is 403.
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_notes_attachments import (  # noqa: F401 — fixtures
    client,
    live,
    local_stt,
    needs_ffmpeg,
    png,
    queued,
    root,
    tus_upload,
    webm,
)
from tests.test_notes_core import H, mk_user, new_note, share


async def _device(db, u, scopes: list[str]) -> tuple[str, str]:
    from app.auth.app_passwords import AppPassword, hint, new_token, token_hash

    token = new_token()
    db.add(AppPassword(user_id=u.id, name="Pixel", token_hash=token_hash(token), hint=hint(token), scopes=scopes))
    await db.commit()
    return (u.username, token)


async def _note(client, u, nid):  # noqa: F811
    r = await client.get(f"/api/notes/{nid}", headers=H(u))
    return r


async def _list(client, u, title="Shopping", items=("Eggs", "Milk")):  # noqa: F811
    body = {"client_id": str(uuid.uuid4()), "kind": "list", "title": title, "items": [{"id": str(uuid.uuid4()), "text": t} for t in items]}
    r = await client.post("/api/notes", headers=H(u), json=body)
    assert r.status_code == 201, r.text
    return r.json()["note"]


# ------------------------------------------------------------------ quick note


async def test_quick_note_and_list_are_made_once(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "kind": "text", "title": "  Gate ", "text": "Code 4471\nBack door"}
    r1 = await client.post("/api/widgets/notes", auth=auth, json=body)
    assert r1.status_code == 201, r1.text
    got = r1.json()
    assert got["note_id"] == cid and got["card"]["title"] == "Gate" and got["card"]["text"].startswith("Code 4471")
    assert got["full"]["id"] == cid
    r2 = await client.post("/api/widgets/notes", auth=auth, json=body)
    assert r2.json()["replayed"] is True
    note = (await _note(client, ann, cid)).json()["note"]
    assert note["source"] == "android"
    assert [n["id"] for n in (await client.get("/api/notes", headers=H(ann))).json()["notes"]].count(cid) == 1

    # A list, from its items or (the same) from lines of text.
    lst = await client.post("/api/widgets/notes", auth=auth, json={"client_id": str(uuid.uuid4()), "kind": "list", "title": "Hardware", "items": ["Screws", "  ", "Glue"]})
    assert lst.status_code == 201 and [i["text"] for i in lst.json()["card"]["items"]] == ["Screws", "Glue"]
    lines = await client.post("/api/widgets/notes", auth=auth, json={"client_id": str(uuid.uuid4()), "kind": "list", "text": "Tape\n\nString"})
    assert lines.json()["card"]["left"] == 2 and lines.json()["card"]["title"] == "Untitled note"

    # Nothing in it, or a missing widgets scope.
    assert (await client.post("/api/widgets/notes", auth=auth, json={"client_id": str(uuid.uuid4()), "title": " "})).status_code == 422
    no_widgets = await _device(db, ann, ["upload", "maps"])
    assert (await client.post("/api/widgets/notes", auth=no_widgets, json={**body, "client_id": str(uuid.uuid4())})).status_code == 403

    # A client id that's someone else's note: not theirs to see.
    bob = await mk_user(db, "bob")
    bob_auth = await _device(db, bob, ["widgets"])
    clash = await client.post("/api/widgets/notes", auth=bob_auth, json={"client_id": cid, "title": "Mine now"})
    assert clash.status_code == 404 and "Gate" not in clash.text


# ------------------------------------------------------------------ voice note


@needs_ffmpeg
async def test_voice_note_attaches_the_recording_and_queues_its_words(client, db, root, queued):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    auth = await _device(db, ann, ["widgets"])
    fid = await tus_upload(client, root, ann, "Voice note.webm", webm(4), "audio/webm")
    cid, aid = str(uuid.uuid4()), str(uuid.uuid4())
    body = {"client_id": cid, "source": "voice", "files": [{"id": aid, "file_id": fid, "duration_ms": 4000, "peaks": [0.1, 0.8, 0.4]}]}
    r = await client.post("/api/widgets/notes", auth=auth, json=body)
    assert r.status_code == 201, r.text
    card = r.json()["card"]
    assert card["voice"] is True and card["title"] == "Voice note"
    assert queued == [uuid.UUID(aid)]
    note = (await _note(client, ann, cid)).json()["note"]
    [a] = note["attachments"]
    assert a["kind"] == "audio" and a["transcript_state"] == "pending" and a["duration_ms"] == 4000 and note["source"] == "voice"
    # Sent again: the same note, nothing queued twice.
    again = await client.post("/api/widgets/notes", auth=auth, json=body)
    assert again.json()["replayed"] is True and queued == [uuid.UUID(aid)]
    # The One note picker names it the same way.
    assert [n["title"] for n in (await client.get("/api/widgets/notes/pick", auth=auth)).json()["notes"]] == ["Voice note"]

    # Bob's recording can't go in Ann's note, and nothing is made.
    bobs = await tus_upload(client, root, bob, "b.webm", webm(2), "audio/webm")
    lost = str(uuid.uuid4())
    r = await client.post("/api/widgets/notes", auth=auth, json={"client_id": lost, "source": "voice", "files": [{"id": str(uuid.uuid4()), "file_id": bobs}]})
    assert r.status_code == 404
    assert (await _note(client, ann, lost)).status_code == 404


# ------------------------------------------------------------------ share


async def test_share_text_gets_the_page_title_and_pictures_attach(client, db, root, monkeypatch):  # noqa: F811
    from app.files import links_router

    asked: list[str] = []

    async def fake_unfurl(url, user):  # noqa: ARG001
        asked.append(url)
        return links_router.LinkPreview(url=url, title="Pavlova, the easy way")

    monkeypatch.setattr(links_router, "unfurl", fake_unfurl)
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    r = await client.post("/api/widgets/notes", auth=auth, json={"client_id": str(uuid.uuid4()), "source": "share", "text": "https://example.com/pav."})
    assert r.status_code == 201, r.text
    assert r.json()["card"]["title"] == "Pavlova, the easy way" and asked == ["https://example.com/pav"]
    # The app gave a title (Chrome's subject): no fetch.
    r = await client.post("/api/widgets/notes", auth=auth, json={"client_id": str(uuid.uuid4()), "source": "share", "title": "Recipe", "text": "https://example.com/x"})
    assert r.json()["card"]["title"] == "Recipe" and len(asked) == 1

    pic = await tus_upload(client, root, ann, "beach.png", png(), "image/png")
    r = await client.post("/api/widgets/notes", auth=auth, json={"client_id": str(uuid.uuid4()), "source": "share", "files": [{"id": str(uuid.uuid4()), "file_id": pic}]})
    assert r.status_code == 201 and r.json()["card"]["image"] is True and r.json()["card"]["voice"] is False


async def test_add_to_a_note(client, db, root):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    auth, bob_auth = await _device(db, ann, ["widgets"]), await _device(db, bob, ["widgets"])
    lst = await _list(client, ann)
    body = {"client_id": str(uuid.uuid4()), "text": "Flour\n\nSugar"}
    r = await client.post(f"/api/widgets/notes/{lst['id']}/add", auth=auth, json=body)
    assert r.status_code == 200, r.text
    assert [i["text"] for i in r.json()["full"]["items"]] == ["Eggs", "Milk", "Flour", "Sugar"]
    again = await client.post(f"/api/widgets/notes/{lst['id']}/add", auth=auth, json=body)
    assert again.json()["replayed"] is True
    assert len((await _note(client, ann, lst["id"])).json()["note"]["items"]) == 4

    text = await new_note(client, ann, title="Ideas", text="First idea")
    r = await client.post(f"/api/widgets/notes/{text['id']}/add", auth=auth, json={"client_id": str(uuid.uuid4()), "text": "https://example.com/a"})
    assert r.status_code == 200, r.text
    assert r.json()["full"]["text"] == "First idea\nhttps://example.com/a"
    pic = await tus_upload(client, root, ann, "p.png", png(), "image/png")
    r = await client.post(f"/api/widgets/notes/{text['id']}/add", auth=auth, json={"client_id": str(uuid.uuid4()), "files": [{"id": str(uuid.uuid4()), "file_id": pic}]})
    assert r.json()["card"]["image"] is True

    # Bob can't add to Ann's note; nothing to add is refused.
    assert (await client.post(f"/api/widgets/notes/{text['id']}/add", auth=bob_auth, json={"client_id": str(uuid.uuid4()), "text": "hi"})).status_code == 404
    assert (await client.post(f"/api/widgets/notes/{text['id']}/add", auth=auth, json={"client_id": str(uuid.uuid4()), "text": "  "})).status_code == 422


# ------------------------------------------------------------------ the One note widget


async def test_one_note_items_ticks_and_pick(client, db):  # noqa: F811
    ann, bob, cat = await mk_user(db, "ann"), await mk_user(db, "bob"), await mk_user(db, "cat")
    auth, cat_auth = await _device(db, ann, ["widgets"]), await _device(db, cat, ["widgets"])
    lst = await _list(client, ann)
    eggs = next(i for i in lst["items"] if i["text"] == "Eggs")

    iid = str(uuid.uuid4())
    r = await client.post(f"/api/widgets/notes/{lst['id']}/items", auth=auth, json={"client_id": iid, "text": "  Bread "})
    assert r.status_code == 201, r.text
    assert r.json()["full"]["items"][-1] == {"id": iid, "text": "Bread", "checked": False, "indent": False}
    assert (await client.post(f"/api/widgets/notes/{lst['id']}/items", auth=auth, json={"client_id": iid, "text": "Bread"})).json()["replayed"] is True

    tick = {"client_id": str(uuid.uuid4()), "checked": True}
    r = await client.patch(f"/api/widgets/notes/{lst['id']}/items/{eggs['id']}", auth=auth, json=tick)
    assert r.status_code == 200, r.text
    full = r.json()["full"]
    assert full["left"] == 2 and full["items"][-1]["id"] == eggs["id"] and full["items"][-1]["checked"] is True  # ticked go last
    # Ticking a ticked item again (another change) changes nothing.
    r = await client.patch(f"/api/widgets/notes/{lst['id']}/items/{eggs['id']}", auth=auth, json={"client_id": str(uuid.uuid4()), "checked": True})
    assert r.status_code == 200 and r.json()["full"]["left"] == 2
    items = (await _note(client, ann, lst["id"])).json()["note"]["items"]
    assert next(i for i in items if i["id"] == eggs["id"])["checked"] is True

    # A collaborator's phone can tick; a stranger's can't, nor find it.
    await share(client, ann, lst["id"], bob)
    bob_auth = await _device(db, bob, ["widgets"])
    r = await client.patch(f"/api/widgets/notes/{lst['id']}/items/{eggs['id']}", auth=bob_auth, json={"client_id": str(uuid.uuid4()), "checked": False})
    assert r.status_code == 200 and r.json()["full"]["left"] == 3
    assert (await client.patch(f"/api/widgets/notes/{lst['id']}/items/{eggs['id']}", auth=cat_auth, json={"client_id": str(uuid.uuid4()), "checked": True})).status_code == 404
    assert (await client.post(f"/api/widgets/notes/{lst['id']}/items", auth=cat_auth, json={"client_id": str(uuid.uuid4()), "text": "x"})).status_code == 404
    ghost = await client.patch(f"/api/widgets/notes/{lst['id']}/items/{uuid.uuid4()}", auth=auth, json={"client_id": str(uuid.uuid4()), "checked": True})
    assert ghost.status_code == 404

    # A text note has no items to add or tick.
    text = await new_note(client, ann, title="Gate")
    assert (await client.post(f"/api/widgets/notes/{text['id']}/items", auth=auth, json={"client_id": str(uuid.uuid4()), "text": "x"})).status_code == 409

    # Pick: yours and the ones shared with you, pinned first; a search narrows it.
    await new_note(client, cat, title="Cat's diary")
    picked = (await client.get("/api/widgets/notes/pick", auth=auth)).json()["notes"]
    titles = [n["title"] for n in picked]
    assert set(titles) == {"Shopping", "Gate"} and "Cat's diary" not in titles
    shop = next(n for n in picked if n["title"] == "Shopping")
    assert shop["kind"] == "list" and shop["left"] == 3
    assert [n["title"] for n in (await client.get("/api/widgets/notes/pick", auth=auth, params={"q": "shop"})).json()["notes"]] == ["Shopping"]
    bobs = (await client.get("/api/widgets/notes/pick", auth=bob_auth)).json()["notes"]
    assert [(n["title"], n["shared"]) for n in bobs] == [("Shopping", True)]
    assert (await client.get("/api/widgets/notes/pick", auth=cat_auth)).json()["notes"][0]["title"] == "Cat's diary"


@pytest.mark.parametrize("q", ["", "zzz-nothing"])
async def test_pick_with_nothing_found(client, db, q):  # noqa: F811
    ann = await mk_user(db, "ann")
    auth = await _device(db, ann, ["widgets"])
    r = await client.get("/api/widgets/notes/pick", auth=auth, params={"q": q} if q else None)
    assert r.status_code == 200 and r.json() == {"notes": []}
