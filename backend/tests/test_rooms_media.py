"""Rooms media: your own GIFs, GIFs from the library, saved GIFs, a space's
own emoji, link previews, and the admin's Rooms settings."""
from __future__ import annotations

import io
import uuid

import pytest
from sqlalchemy import select

from tests.test_rooms import H, _quiet_background, client, make_space, mk_user, people, say  # noqa: F401

GIPHY = {
    "provider": "giphy",
    "id": "abc123",
    "url": "https://media2.giphy.com/media/abc123/giphy.webp?cid=x&rid=giphy.webp",
    "preview_url": "https://media2.giphy.com/media/abc123/200.webp?cid=x",
    "page_url": "https://giphy.com/gifs/abc123",
    "width": 480,
    "height": 270,
    "title": "  Happy   dance ",
}


def _png(size=(64, 64), color=(200, 80, 60)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def _gif(frames: int = 3, size=(48, 32)) -> bytes:
    from PIL import Image

    imgs = [Image.new("RGB", size, (60 * i, 200 - 50 * i, 90)) for i in range(frames)]
    buf = io.BytesIO()
    imgs[0].save(buf, format="GIF", save_all=True, append_images=imgs[1:], duration=80, loop=0)
    return buf.getvalue()


async def mk_admin(db):
    u = await mk_user(db, "boss")
    u.role = "admin"
    await db.commit()
    await db.refresh(u)
    return u


async def gifs_on(client, db, provider="giphy"):
    admin = await mk_admin(db)
    r = await client.patch(
        "/api/admin/rooms/settings",
        headers=H(admin),
        json={"settings": {"gif_search": True, "gif_provider": provider}, "gif_key": "test-key-not-real"},
    )
    assert r.status_code == 200, r.text
    return admin


async def upload(client, u, room, name, data, mime):
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(u), files={"file": (name, data, mime)})
    assert r.status_code == 201, r.text
    return r.json()


# ------------------------------------------------------------------ admin settings


async def test_only_admins_see_or_change_rooms_settings(client, db, people):  # noqa: F811
    ann, *_ = people
    assert (await client.get("/api/admin/rooms/settings", headers=H(ann))).status_code == 403
    assert (await client.patch("/api/admin/rooms/settings", headers=H(ann), json={"settings": {"link_previews": False}})).status_code == 403
    admin = await mk_admin(db)
    got = (await client.get("/api/admin/rooms/settings", headers=H(admin))).json()
    assert got["settings"]["gif_search"] is False and got["settings"]["link_previews"] is True
    assert got["gif_key_set"] is False
    assert got["kinds"]["gif_provider"]["choices"] == ["giphy", "klipy"]
    assert got["kinds"]["emoji_max_kb"]["kind"] == "int"


async def test_the_gif_key_is_never_echoed_to_the_admin(client, db, people):  # noqa: F811
    admin = await gifs_on(client, db)
    r = await client.get("/api/admin/rooms/settings", headers=H(admin))
    assert r.json()["gif_key_set"] is True
    assert "test-key-not-real" not in r.text
    # Stored encrypted, not as typed.
    from app.rooms import settings as rooms_settings

    row = await rooms_settings._row(db)
    await db.refresh(row)
    assert row.rooms_gif_key_encrypted and "test-key-not-real" not in row.rooms_gif_key_encrypted
    # "" clears it; search then counts as off for everyone.
    r = await client.patch("/api/admin/rooms/settings", headers=H(admin), json={"gif_key": ""})
    assert r.json()["gif_key_set"] is False
    ann = people[0]
    assert (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()["media"]["gif_search"] is None


async def test_bad_settings_are_refused(client, db, people):  # noqa: F811
    admin = await mk_admin(db)
    for bad in ({"gif_provider": "tenor"}, {"emoji_max_kb": 5}, {"link_previews": "yes"}, {"nonsense": True}):
        r = await client.patch("/api/admin/rooms/settings", headers=H(admin), json={"settings": bad})
        assert r.status_code == 400, (bad, r.text)


async def test_the_page_learns_about_gif_search_only_while_its_on(client, db, people):  # noqa: F811
    ann, *_ = people
    boot = (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()
    assert boot["media"] == {"gif_search": None, "link_previews": True}
    admin = await gifs_on(client, db, "klipy")
    boot = (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()
    assert boot["media"]["gif_search"] == {"provider": "klipy", "key": "test-key-not-real", "rating": "teen"}
    await client.patch("/api/admin/rooms/settings", headers=H(admin), json={"settings": {"gif_search": False}})
    assert (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()["media"]["gif_search"] is None


# ------------------------------------------------------------------ library GIFs


async def test_a_library_gif_rides_on_the_message(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    await gifs_on(client, db)
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "", gif=GIPHY)
    g = m["meta"]["gif"]
    assert g["provider"] == "giphy" and g["url"] == GIPHY["url"] and g["title"] == "Happy dance"
    assert (g["width"], g["height"], g["has_note"]) == (480, 270, False)
    assert m["body"] == "GIF: Happy dance"
    # With your own words, they're the message.
    m2 = await say(client, ann, room, "this is us", gif=GIPHY)
    assert m2["body"] == "this is us" and m2["meta"]["gif"]["has_note"] is True
    # DMs too.
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()["id"]
    assert (await say(client, ann, dm, "", gif=GIPHY))["meta"]["gif"]["id"] == "abc123"


@pytest.mark.parametrize(
    "change",
    [
        {"url": "https://evil.example/track.gif"},
        {"url": "http://media.giphy.com/media/abc/giphy.gif"},  # not https
        {"url": "https://giphy.com.evil.example/x.gif"},
        {"url": "https://user:pw@media.giphy.com/x.gif"},
        {"url": "https://media.giphy.com:8443/x.gif"},
        {"provider": "klipy"},  # not the library this server uses
        {"provider": "tenor"},
    ],
)
async def test_a_gif_that_isnt_the_librarys_is_refused(client, db, people, change):  # noqa: F811
    ann, bob, *_ = people
    await gifs_on(client, db)
    _sid, room = await make_space(client, ann, bob)
    r = await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"body": "", "gif": {**GIPHY, **change}})
    assert r.status_code == 400, r.text


async def test_no_library_gifs_while_search_is_off(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    r = await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"body": "", "gif": GIPHY})
    assert r.status_code == 400 and "isn't on" in r.json()["detail"]


async def test_a_bad_preview_address_is_dropped_not_kept(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    await gifs_on(client, db)
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "", gif={**GIPHY, "preview_url": "https://evil.example/p.gif", "page_url": "javascript:alert(1)"})
    assert m["meta"]["gif"]["preview_url"] is None and m["meta"]["gif"]["page_url"] is None


# ------------------------------------------------------------------ your own GIFs, saved


async def test_an_uploaded_gif_is_marked_animated(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    moving = await upload(client, ann, room, "wave.gif", _gif(), "image/gif")
    still = await upload(client, ann, room, "still.png", _png(), "image/png")
    one_frame = await upload(client, ann, room, "one.gif", _gif(frames=1), "image/gif")
    assert moving["animated"] is True and moving["thumb_url"]
    assert still["animated"] is False and one_frame["animated"] is False


async def test_saving_a_gif_keeps_your_own_copy(client, db, people):  # noqa: F811
    ann, bob, cat, _ = people
    _sid, room = await make_space(client, ann, bob)
    att = await upload(client, ann, room, "wave.gif", _gif(), "image/gif")
    m = await say(client, ann, room, "", attachment_ids=[att["id"]])
    # Someone who can't see the room can't save from it.
    assert (await client.post("/api/rooms/saved-gifs", headers=H(cat), json={"attachment_id": att["id"]})).status_code == 404
    r = await client.post("/api/rooms/saved-gifs", headers=H(bob), json={"attachment_id": att["id"]})
    assert r.status_code == 201, r.text
    saved = r.json()
    assert saved["source"] == "own" and saved["mime"] == "image/gif"
    # Saving it again doesn't make a second copy.
    again = await client.post("/api/rooms/saved-gifs", headers=H(bob), json={"attachment_id": att["id"]})
    assert again.json()["id"] == saved["id"]
    assert [g["id"] for g in (await client.get("/api/rooms/saved-gifs", headers=H(bob))).json()] == [saved["id"]]
    # Only the owner's list has it.
    assert (await client.get("/api/rooms/saved-gifs", headers=H(ann))).json() == []
    # The copy outlives the message it came from.
    await client.delete(f"/api/rooms/messages/{m['id']}", headers=H(ann))
    f = await client.get(saved["url"])
    assert f.status_code == 200 and f.headers["content-type"] == "image/gif" and f.content[:3] == b"GIF"
    assert (await client.get(saved["url"].replace("sig=", "sig=0"))).status_code == 404
    # One tap: it becomes a fresh attachment in a room you're in, and sends.
    dm = (await client.post("/api/rooms/dms", headers=H(bob), json={"user_ids": [str(ann.id)]})).json()["id"]
    r = await client.post(f"/api/rooms/rooms/{dm}/attachments/saved/{saved['id']}", headers=H(bob))
    assert r.status_code == 201, r.text
    assert r.json()["animated"] is True
    sent = await say(client, bob, dm, "", attachment_ids=[r.json()["id"]])
    assert sent["attachments"][0]["animated"] is True
    # Nobody else can use or remove your saved GIF.
    assert (await client.post(f"/api/rooms/rooms/{room}/attachments/saved/{saved['id']}", headers=H(ann))).status_code == 404
    assert (await client.delete(f"/api/rooms/saved-gifs/{saved['id']}", headers=H(ann))).status_code == 404
    assert (await client.delete(f"/api/rooms/saved-gifs/{saved['id']}", headers=H(bob))).status_code == 204
    assert (await client.get(saved["url"])).status_code == 404


async def test_only_gifs_can_be_saved(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    att = await upload(client, ann, room, "still.png", _png(), "image/png")
    await say(client, ann, room, "", attachment_ids=[att["id"]])
    assert (await client.post("/api/rooms/saved-gifs", headers=H(bob), json={"attachment_id": att["id"]})).status_code == 400


async def test_saving_a_library_gif_keeps_a_reference(client, db, people):  # noqa: F811
    ann, *_ = people
    await gifs_on(client, db)
    r = await client.post("/api/rooms/saved-gifs", headers=H(ann), json={"gif": GIPHY})
    assert r.status_code == 201, r.text
    assert r.json()["source"] == "provider" and r.json()["gif"]["url"] == GIPHY["url"] and "url" not in r.json()
    again = await client.post("/api/rooms/saved-gifs", headers=H(ann), json={"gif": GIPHY})
    assert again.json()["id"] == r.json()["id"]
    # No copy was made: there's nothing of it on this server's disk.
    from app.files.storage import absolute_path

    assert not absolute_path(f"rooms/saved/{ann.id}").exists()
    bad = await client.post("/api/rooms/saved-gifs", headers=H(ann), json={"gif": {**GIPHY, "url": "https://evil.example/x.gif"}})
    assert bad.status_code == 400


# ------------------------------------------------------------------ custom emoji


async def add_emoji(client, u, sid, name, data=None, filename="party.png", mime="image/png"):
    return await client.post(
        f"/api/rooms/spaces/{sid}/emojis", headers=H(u), data={"name": name}, files={"file": (filename, data or _png(), mime)}
    )


async def test_a_spaces_admins_add_its_emoji(client, db, people):  # noqa: F811
    ann, bob, cat, _ = people
    sid, room = await make_space(client, ann, bob)
    # A member can't; someone outside the space gets a 404.
    assert (await add_emoji(client, bob, sid, "party")).status_code == 403
    assert (await add_emoji(client, cat, sid, "party")).status_code == 404
    r = await add_emoji(client, ann, sid, ":Party-Time:")
    assert r.status_code == 201, r.text
    e = r.json()
    assert e["name"] == "party_time" and e["animated"] is False
    # Everyone in the space gets it with the space.
    boot = (await client.get("/api/rooms/bootstrap", headers=H(bob))).json()
    assert [x["name"] for x in boot["spaces"][0]["emojis"]] == ["party_time"]
    img = await client.get(boot["spaces"][0]["emojis"][0]["url"])
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    assert (await client.get(e["url"].replace("sig=", "sig=0"))).status_code == 404
    # One name each.
    assert (await add_emoji(client, ann, sid, "party_time")).status_code == 409
    for bad in ("a", "has space!", "x" * 31, "émoji"):
        assert (await add_emoji(client, ann, sid, bad)).status_code == 400, bad
    # An animated one.
    r = await add_emoji(client, ann, sid, "wave", _gif(), "wave.gif", "image/gif")
    assert r.status_code == 201 and r.json()["animated"] is True
    # Rename and delete: admins only.
    assert (await client.patch(f"/api/rooms/emojis/{e['id']}", headers=H(bob), json={"name": "fiesta"})).status_code == 403
    assert (await client.patch(f"/api/rooms/emojis/{e['id']}", headers=H(cat), json={"name": "fiesta"})).status_code == 404
    assert (await client.patch(f"/api/rooms/emojis/{e['id']}", headers=H(ann), json={"name": "wave"})).status_code == 409
    assert (await client.patch(f"/api/rooms/emojis/{e['id']}", headers=H(ann), json={"name": "fiesta"})).json()["name"] == "fiesta"
    assert (await client.delete(f"/api/rooms/emojis/{e['id']}", headers=H(bob))).status_code == 403
    assert (await client.delete(f"/api/rooms/emojis/{e['id']}", headers=H(ann))).status_code == 204
    assert (await client.get(e["url"])).status_code == 404


async def test_an_emoji_must_be_a_real_small_picture(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    sid, _room = await make_space(client, ann, bob)
    # Not a picture at all, whatever it's called.
    assert (await add_emoji(client, ann, sid, "sneaky", b"<script>alert(1)</script>", "x.png", "image/png")).status_code == 400
    assert (await add_emoji(client, ann, sid, "vector", b"<svg xmlns='http://www.w3.org/2000/svg'/>", "x.svg", "image/svg+xml")).status_code == 400
    # Bigger than the admin allows.
    admin = await mk_admin(db)
    await client.patch("/api/admin/rooms/settings", headers=H(admin), json={"settings": {"emoji_max_kb": 32, "emoji_max_per_space": 1}})
    import os

    big = await add_emoji(client, ann, sid, "huge", os.urandom(40 * 1024), "x.png", "image/png")
    assert big.status_code == 413
    assert (await add_emoji(client, ann, sid, "one")).status_code == 201
    r = await add_emoji(client, ann, sid, "two")
    assert r.status_code == 400 and "most this server allows" in r.json()["detail"]


async def test_reacting_with_a_spaces_emoji(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    sid, room = await make_space(client, ann, bob)
    other_sid, other_room = await make_space(client, bob, ann, name="Other")
    assert (await add_emoji(client, ann, sid, "party")).status_code == 201
    m = await say(client, ann, room, "we did it :party:")
    assert m["body"] == "we did it :party:"
    r = await client.put(f"/api/rooms/messages/{m['id']}/reactions", headers=H(bob), json={"emoji": ":party:"})
    assert r.status_code == 200 and r.json()["reactions"] == [{"emoji": ":party:", "user_ids": [str(bob.id)]}]
    # Not an emoji here: refused. Another space's emoji isn't this one's.
    assert (await client.put(f"/api/rooms/messages/{m['id']}/reactions", headers=H(bob), json={"emoji": ":nope:"})).status_code == 400
    m2 = await say(client, ann, other_room, "hello")
    assert (await client.put(f"/api/rooms/messages/{m2['id']}/reactions", headers=H(bob), json={"emoji": ":party:"})).status_code == 400
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()["id"]
    m3 = await say(client, ann, dm, "hi")
    assert (await client.put(f"/api/rooms/messages/{m3['id']}/reactions", headers=H(bob), json={"emoji": ":party:"})).status_code == 400
    # Ordinary emoji are untouched.
    assert (await client.put(f"/api/rooms/messages/{m3['id']}/reactions", headers=H(bob), json={"emoji": "👍"})).status_code == 200


# ------------------------------------------------------------------ link previews


def _fake_fetch(monkeypatch, result, calls=None):
    from app.rooms import media

    async def fetch(url):
        if calls is not None:
            calls.append(url)
        return result(url) if callable(result) else result

    monkeypatch.setattr(media, "fetch_preview", fetch)


def _card(image=True):
    from app.rooms import media

    return {"title": "A Good Recipe", "description": "Dinner in 20 minutes.", "site": "Example Kitchen", "image": media._thumb(_png((320, 200))) if image else None}


async def _msg(client, u, room, mid):
    page = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(u))).json()
    return next(m for m in page["messages"] if m["id"] == mid)


async def test_a_link_gets_a_card_and_its_picture_is_served_from_here(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import media

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    calls: list[str] = []
    _fake_fetch(monkeypatch, _card(), calls)
    url = f"https://kitchen.example/recipes/{uuid.uuid4().hex}"
    m = await say(client, ann, room, f"try this {url}, it's great")
    assert "preview" not in m["meta"]  # it arrives a moment later
    await media.build_preview(uuid.UUID(m["id"]))
    assert calls == [url]
    got = await _msg(client, bob, room, m["id"])
    p = got["meta"]["preview"]
    assert (p["url"], p["title"], p["site"], p["image"]) == (url, "A Good Recipe", "Example Kitchen", True)
    assert p["image_url"].startswith(f"/api/rooms/previews/{m['id']}/image?")
    img = await client.get(p["image_url"])
    assert img.status_code == 200 and img.headers["content-type"] == "image/webp"
    assert (await client.get(p["image_url"].replace("sig=", "sig=0"))).status_code == 404
    # The same address again soon is answered from the cache, not fetched.
    m2 = await say(client, bob, room, url)
    await media.build_preview(uuid.UUID(m2["id"]))
    assert calls == [url]
    assert (await _msg(client, ann, room, m2["id"]))["meta"]["preview"]["image"] is True
    # A deleted message serves no picture.
    await client.delete(f"/api/rooms/messages/{m['id']}", headers=H(ann))
    assert (await client.get(p["image_url"])).status_code == 404


async def test_only_the_sender_removes_a_preview_and_it_stays_off(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import media

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    _fake_fetch(monkeypatch, _card())
    url = f"https://kitchen.example/{uuid.uuid4().hex}"
    m = await say(client, ann, room, url)
    await media.build_preview(uuid.UUID(m["id"]))
    assert (await client.delete(f"/api/rooms/messages/{m['id']}/preview", headers=H(bob))).status_code == 403
    r = await client.delete(f"/api/rooms/messages/{m['id']}/preview", headers=H(ann))
    assert r.status_code == 200 and r.json()["meta"]["preview"] == {"removed": True, "url": url}
    # Nothing brings it back: not a fresh look-up, not an edit.
    await media.build_preview(uuid.UUID(m["id"]))
    await client.patch(f"/api/rooms/messages/{m['id']}", headers=H(ann), json={"body": f"{url} again"})
    await media.build_preview(uuid.UUID(m["id"]))
    assert (await _msg(client, bob, room, m["id"]))["meta"]["preview"]["removed"] is True


async def test_an_edit_moves_or_drops_the_preview(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import media

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    _fake_fetch(monkeypatch, lambda url: {**_card(image=False), "title": url.rsplit("/", 1)[-1]})
    a, b = f"https://one.example/{uuid.uuid4().hex}", f"https://two.example/{uuid.uuid4().hex}"
    m = await say(client, ann, room, a)
    await media.build_preview(uuid.UUID(m["id"]))
    assert (await _msg(client, bob, room, m["id"]))["meta"]["preview"]["url"] == a
    await client.patch(f"/api/rooms/messages/{m['id']}", headers=H(ann), json={"body": b})
    await media.build_preview(uuid.UUID(m["id"]))
    assert (await _msg(client, bob, room, m["id"]))["meta"]["preview"]["url"] == b
    await client.patch(f"/api/rooms/messages/{m['id']}", headers=H(ann), json={"body": "no link now"})
    await media.build_preview(uuid.UUID(m["id"]))
    assert "preview" not in (await _msg(client, bob, room, m["id"]))["meta"]


async def test_what_never_gets_a_preview(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import media

    ann, bob, *_ = people
    await gifs_on(client, db)
    _sid, room = await make_space(client, ann, bob)
    calls: list[str] = []
    _fake_fetch(monkeypatch, _card(), calls)
    quiet = [
        await say(client, ann, room, "no link here"),
        await say(client, ann, room, "in code `https://code.example/x` only"),
        await say(client, ann, room, "a link to this server http://localhost/rooms"),
        await say(client, ann, room, "https://place.example/x", place={"name": "Cafe", "lat": 1.0, "lon": 2.0}),
        await say(client, ann, room, "https://gif.example/x", gif=GIPHY),
        await say(client, ann, room, "https://user:pw@secret.example/x"),
    ]
    for m in quiet:
        await media.build_preview(uuid.UUID(m["id"]))
        assert "preview" not in (await _msg(client, bob, room, m["id"]))["meta"], m["body"]
    assert calls == []
    # A page with nothing to say leaves the message alone.
    _fake_fetch(monkeypatch, None, calls)
    m = await say(client, ann, room, f"https://blank.example/{uuid.uuid4().hex}")
    await media.build_preview(uuid.UUID(m["id"]))
    assert "preview" not in (await _msg(client, bob, room, m["id"]))["meta"]


async def test_the_admin_can_turn_previews_off(client, db, people, monkeypatch):  # noqa: F811
    from app.rooms import media

    ann, bob, *_ = people
    admin = await mk_admin(db)
    await client.patch("/api/admin/rooms/settings", headers=H(admin), json={"settings": {"link_previews": False}})
    _sid, room = await make_space(client, ann, bob)
    calls: list[str] = []
    _fake_fetch(monkeypatch, _card(), calls)
    m = await say(client, ann, room, f"https://kitchen.example/{uuid.uuid4().hex}")
    await media.build_preview(uuid.UUID(m["id"]))
    assert calls == [] and "preview" not in (await _msg(client, bob, room, m["id"]))["meta"]
    assert (await client.get("/api/rooms/bootstrap", headers=H(ann))).json()["media"]["link_previews"] is False


async def test_the_fetch_refuses_private_addresses():
    """The real fetch, no fakes: a page can't make this server look inside
    its own network."""
    from app.rooms import media

    for url in ("http://127.0.0.1:6379/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/admin", "http://[::1]/"):
        assert await media.fetch_preview(url) is None, url


def test_reading_a_pages_head():
    from app.rooms import media

    html = """<!doctype html><html><head><title> Plain   title </title>
    <meta property="og:title" content="Roast &amp; Veg">
    <meta name="description" content="Fallback description">
    <meta property="og:description" content="Easy\x00 dinner">
    <meta property="og:image" content="/img/roast.jpg">
    <meta property="og:site_name" content="Example Kitchen">
    </head><body><meta property="og:title" content="ignored, it's in the body"></body></html>"""
    got = media.parse_page(html, "https://www.kitchen.example/recipes/roast")
    assert got == {
        "title": "Roast & Veg",
        "description": "Easy dinner",
        "site": "Example Kitchen",
        "image_src": "https://www.kitchen.example/img/roast.jpg",
    }
    bare = media.parse_page("<html><head><title>Just a title</title><meta property='og:image' content='javascript:alert(1)'></head></html>", "https://www.bare.example/")
    assert bare["title"] == "Just a title" and bare["site"] == "bare.example" and bare["image_src"] == ""
    assert media.first_link("see (https://a.example/x). And https://b.example") == "https://a.example/x"
    assert media.first_link("```\nhttps://code.example\n``` then [text](https://c.example/y)") == "https://c.example/y"
    assert media.first_link("ftp://x.example and mailto:a@b.c") is None


async def test_a_wiped_message_keeps_no_preview_or_gif(client, db, people, monkeypatch):  # noqa: F811
    from datetime import timedelta

    from app.files.storage import absolute_path
    from app.rooms import media, service
    from app.rooms.models import RoomMessage

    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    _fake_fetch(monkeypatch, _card())
    m = await say(client, ann, room, f"https://kitchen.example/{uuid.uuid4().hex}")
    await media.build_preview(uuid.UUID(m["id"]))
    path = absolute_path(media.preview_path(uuid.UUID(room), uuid.UUID(m["id"])))
    assert path.exists()
    await client.delete(f"/api/rooms/messages/{m['id']}", headers=H(ann))
    assert await service.purge_deleted(db, older_than=timedelta(seconds=0)) == 1
    assert not path.exists()
    row = (await db.execute(select(RoomMessage).where(RoomMessage.id == uuid.UUID(m["id"])))).scalar_one()
    await db.refresh(row)
    assert "preview" not in (row.meta or {})
