"""Porch hand-offs (WP-P1.6): the Rooms card (None for anyone who can't see
the post), "Reply privately" (refused by a block), "Make this an event"
(guests only from who can see the post), search by words and by what's in
a photo (never past ``access``), the photo "uses" count behind Photos'
trash warning, the Today card and ``porch_post`` links."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, boot, client, everyone_id, members_of, ok, people, photo, post_photos, quiet, root, say, set_porch,
)


async def block(client, a, b) -> None:
    r = await client.put(f"/api/people/blocks/{b.id}", headers=H(a))
    assert r.status_code in (200, 204), r.text


async def space_with(client, owner, *members) -> str:
    """A Rooms space with these people in it; its first room's id."""
    r = await client.post("/api/rooms/spaces", headers=H(owner), json={"name": "Home", "emoji": "🏡"})
    assert r.status_code == 201, r.text
    sid, rid = r.json()["id"], r.json()["room_id"]
    if members:
        r = await client.post(f"/api/rooms/spaces/{sid}/members", headers=H(owner), json={"user_ids": [str(m.id) for m in members]})
        assert r.status_code in (200, 201), r.text
    return rid


@pytest.fixture(autouse=True)
def _no_room_push(monkeypatch):
    import app.crossapp.router as cr
    import app.rooms.router as rr

    monkeypatch.setattr(cr, "spawn", lambda coro, name=None: coro.close())
    monkeypatch.setattr(rr, "spawn", lambda coro, name=None: coro.close())


# ------------------------------------------------------------------ the card


async def test_card_only_for_people_who_can_see_the_post(client, db, people):
    from app.crossapp import shares
    from app.porch import handoffs

    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    post = await say(client, ann, [fam], "BBQ at ours Saturday\nBring a chair")

    got = await handoffs.card(db, bob, post["id"])
    assert got["title"] == "BBQ at ours Saturday" and got["href"] == f"/porch/p/{post['id']}"
    assert "in Family" in got["subtitle"]
    assert await handoffs.card(db, cat, post["id"]) is None
    assert await handoffs.card(db, cat, str(uuid.uuid4())) is None
    assert await handoffs.card(db, cat, "not-an-id") is None
    assert await shares.card(db, cat, {"kind": "porch_post", "id": post["id"]}) is None
    assert (await shares.card(db, bob, {"kind": "porch_post", "id": post["id"]}))["title"] == "BBQ at ours Saturday"
    # Not grantable: a room is never let in by sharing a post.
    assert not await shares.can_grant(db, ann, {"kind": "porch_post", "id": post["id"]})

    # The API twin.
    assert (await client.get(f"/api/porch/posts/{post['id']}/card", headers=H(bob))).status_code == 200
    assert (await client.get(f"/api/porch/posts/{post['id']}/card", headers=H(cat))).status_code == 404

    # Porch off for bob: no card for him either.
    await set_porch(db, porch_enabled=False)
    assert await handoffs.card(db, bob, post["id"]) is None


async def test_share_to_a_room_shows_outsiders_nothing(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    post = await say(client, ann, [fam], "Noosa with the kids")
    room = await space_with(client, ann, bob, cat)

    r = await client.post("/api/crossapp/share", headers=H(ann), json={"room_id": room, "kind": "porch_post", "id": post["id"], "note": "Look!"})
    msg = (await ok(r, 201))["message"]
    assert msg["meta"]["share"] == {"kind": "porch_post", "id": post["id"], "label": "a Porch post", "has_note": True}
    assert msg["body"] == "Look!"  # never the post's words

    seen = await ok(await client.get(f"/api/crossapp/share/card/{msg['id']}", headers=H(bob)))
    assert seen["card"]["title"] == "Noosa with the kids" and seen["can_grant"] is False
    hidden = await ok(await client.get(f"/api/crossapp/share/card/{msg['id']}", headers=H(cat)))
    assert hidden["card"] is None and hidden["label"] == "a Porch post"

    # Someone who can't see the post can't send it (nothing to probe).
    r = await client.post("/api/crossapp/share", headers=H(cat), json={"room_id": room, "kind": "porch_post", "id": post["id"]})
    assert r.status_code == 404
    # The composer's preview of what's attached: yours to see, else 404.
    r = await client.get("/api/crossapp/share/preview", headers=H(bob), params={"kind": "porch_post", "id": post["id"]})
    assert (await ok(r))["card"]["title"] == "Noosa with the kids"
    r = await client.get("/api/crossapp/share/preview", headers=H(cat), params={"kind": "porch_post", "id": post["id"]})
    assert r.status_code == 404


# ------------------------------------------------------------------ reply privately


async def test_reply_privately_opens_the_dm_and_a_block_refuses_it(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = await say(client, ann, [fam], "New puppy!")

    got = await ok(await client.post(f"/api/porch/posts/{post['id']}/reply", headers=H(bob)))
    assert got["share"] == f"porch_post:{post['id']}" and got["url"] == f"/rooms/r/{got['room_id']}?share=porch_post:{post['id']}"
    # The same conversation every time; ann doesn't see it until bob sends something.
    again = await ok(await client.post(f"/api/porch/posts/{post['id']}/reply", headers=H(bob)))
    assert again["room_id"] == got["room_id"]
    boot_ann = await ok(await client.get("/api/rooms/bootstrap", headers=H(ann)))
    assert got["room_id"] not in [d["id"] for d in boot_ann["dms"]]
    # Sending the card with the words opens it for her.
    r = await client.post("/api/crossapp/share", headers=H(bob), json={"room_id": got["room_id"], "kind": "porch_post", "id": post["id"], "note": "So cute"})
    await ok(r, 201)
    boot_ann = await ok(await client.get("/api/rooms/bootstrap", headers=H(ann)))
    assert got["room_id"] in [d["id"] for d in boot_ann["dms"]]

    # Your own post: nobody to reply to.
    assert (await client.post(f"/api/porch/posts/{post['id']}/reply", headers=H(ann))).status_code == 400
    # Someone who can't see it: 404.
    assert (await client.post(f"/api/porch/posts/{post['id']}/reply", headers=H(dan))).status_code == 404

    # A block either way refuses it (and hides the post).
    await block(client, ann, cat)
    assert (await client.post(f"/api/porch/posts/{post['id']}/reply", headers=H(cat))).status_code in (403, 404)
    from app.people.blocks import dm_refusal

    assert await dm_refusal(db, cat.id, ann.id)


async def test_reply_privately_checks_the_block_even_if_the_post_shows(client, db, people, monkeypatch):
    """Belt and braces: were a post ever visible across a block, the DM is
    still refused (decision D7)."""
    from app.porch import access

    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    post = await say(client, ann, [fam], "Hello")
    await block(client, bob, ann)

    real = access.load_post

    async def leaky(db_, user, post_id):
        from app.porch.models import PorchPost

        return await db_.get(PorchPost, post_id)

    monkeypatch.setattr(access, "load_post", leaky)
    r = await client.post(f"/api/porch/posts/{post['id']}/reply", headers=H(bob))
    assert r.status_code == 403
    monkeypatch.setattr(access, "load_post", real)


# ------------------------------------------------------------------ make an event


async def test_event_from_a_post_invites_only_people_who_can_see_it(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = await say(client, ann, [fam], "BBQ at ours Saturday", place={"name": "Our place"})

    pre = await ok(await client.get(f"/api/porch/posts/{post['id']}/event", headers=H(bob)))
    assert pre["title"] == "BBQ at ours Saturday" and pre["location"] == "Our place"
    assert {g["id"] for g in pre["guests"]} == {str(ann.id), str(cat.id)}  # not bob himself, never dan

    base = {"title": "BBQ", "start": "2026-11-14T08:00:00Z", "end": "2026-11-14T10:00:00Z", "source": {"kind": "porch_post", "post_id": post["id"]}}
    r = await client.post("/api/calendar/events", headers=H(bob), json={**base, "guests": [str(ann.id), str(cat.id)]})
    ev = (await ok(r, 201))["event"]
    assert ev["source"] == {"kind": "porch_post", "post_id": post["id"]}
    # Editing it later: new guests too must be able to see the post.
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"guests": [str(ann.id), str(cat.id), str(dan.id)]})
    assert r.status_code == 400
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(bob), json={"guests": [str(ann.id)]})
    await ok(r)
    # dan can't see the post, so he can't be invited from it...
    r = await client.post("/api/calendar/events", headers=H(bob), json={**base, "guests": [str(dan.id)]})
    assert r.status_code == 400
    # ...and can't make an event from it himself.
    r = await client.post("/api/calendar/events", headers=H(dan), json={**base, "guests": []})
    assert r.status_code == 404
    assert (await client.get(f"/api/porch/posts/{post['id']}/event", headers=H(dan))).status_code == 404
    # A block since: that person drops out of who can be invited.
    await block(client, ann, cat)
    r = await client.post("/api/calendar/events", headers=H(ann), json={**base, "guests": [str(cat.id)]})
    assert r.status_code == 400


# ------------------------------------------------------------------ search


@pytest.fixture
def fake_ml(monkeypatch):
    from app.photos import ml

    async def waiting():
        return None

    async def embed_texts(texts):
        return "fake-siglip@1", [_unit(0) if "beach" in t else _unit(9) for t in texts]

    monkeypatch.setattr(ml, "waiting", waiting)
    monkeypatch.setattr(ml, "embed_texts", embed_texts)


def _unit(i: int) -> list[float]:
    v = [0.0] * 768
    v[i] = 1.0
    return v


async def _looks(db, fid, i):
    from app.custom_models.embedding import vector_literal

    await db.execute(
        text("INSERT INTO photo_embeddings (file_id, model, embedding) VALUES (:f, 'fake-siglip@1', CAST(:v AS vector))"),
        {"f": fid, "v": vector_literal(_unit(i))},
    )
    await db.commit()


async def search(client, u, q) -> list[str]:
    got = await ok(await client.get("/api/porch/search", headers=H(u), params={"q": q}))
    return [r["id"] for r in got["results"]]


async def test_search_by_words_obeys_who_can_see(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    lads = await members_of(client, cat, "The Lads", [dan])
    bbq = await say(client, ann, [fam], "BBQ at ours Saturday", place={"name": "Noosa Heads"})
    beers = await say(client, cat, [lads], "BBQ and beers at the pub")
    mine = await say(client, bob, [fam], "Bringing the barbecue tongs")

    assert await search(client, bob, "bbq") == [bbq["id"]]
    assert await search(client, dan, "bbq") == [beers["id"]]
    assert await search(client, bob, "noosa") == [bbq["id"]]  # the place
    assert await search(client, bob, "tong") == [mine["id"]]  # the word being typed
    # A name narrows it to their posts.
    assert await search(client, bob, f"{ann.username} saturday") == [bbq["id"]]
    assert await search(client, bob, f"{bob.username}") == [mine["id"]]
    # Someone blocked: their posts aren't found, nor is their name a filter.
    await block(client, bob, ann)
    assert await search(client, bob, "bbq") == []
    # Ctrl+K's rows come from the same place.
    got = await ok(await client.get("/api/today/search", headers=H(dan), params={"q": "bbq"}))
    assert [p["id"] for p in got["porch"]] == [beers["id"]]
    assert got["porch"][0]["url"] == f"/porch/p/{beers['id']}"
    got = await ok(await client.get("/api/today/search", headers=H(bob), params={"q": "bbq"}))
    assert got["porch"] == []
    # Porch off: no Porch rows, and the search route is a 404.
    await set_porch(db, porch_enabled=False)
    got = await ok(await client.get("/api/today/search", headers=H(dan), params={"q": "bbq"}))
    assert got["porch"] == []
    assert (await client.get("/api/porch/search", headers=H(dan), params={"q": "bbq"})).status_code == 404


async def test_search_photos_by_whats_in_them_obeys_who_can_see(client, db, people, fake_ml):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    beach = await photo(client, ann, "IMG_1.jpg")
    city = await photo(client, ann, "IMG_2.jpg")
    secret = await photo(client, cat, "IMG_3.jpg")
    await _looks(db, beach, 0)
    await _looks(db, city, 5)
    await _looks(db, secret, 0)
    p1 = await post_photos(client, ann, [fam], [beach], "Sunday")
    await post_photos(client, ann, [fam], [city], "Monday")
    hidden = await post_photos(client, cat, [await members_of(client, cat, "Cats", [dan])], [secret], "Private beach day")

    got = await ok(await client.get("/api/porch/search", headers=H(bob), params={"q": "the beach"}))
    assert [r["id"] for r in got["results"]] == [p1["id"]] and got["photos_searched"] is True
    assert got["results"][0]["thumb"]
    # Sam's beach photo: the name and the look together.
    assert await search(client, bob, f"beach {ann.username}") == [p1["id"]]
    # dan sees cat's beach (by words and look), never ann's.
    assert await search(client, dan, "beach") == [hidden["id"]]
    # A photo trashed in Photos isn't found by its look any more.
    r = await client.post("/api/files/bulk/trash", headers=H(ann), json={"file_ids": [beach], "folder_ids": []})
    assert r.status_code in (200, 204), r.text
    assert await search(client, bob, "beach") == []


async def test_search_without_the_photo_service_uses_words(client, db, people, monkeypatch):
    from app.photos import ml

    async def down():
        return "Photo search isn't set up"

    monkeypatch.setattr(ml, "waiting", down)
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    p = await say(client, ann, [fam], "Beach day")
    got = await ok(await client.get("/api/porch/search", headers=H(bob), params={"q": "beach"}))
    assert [r["id"] for r in got["results"]] == [p["id"]] and got["photos_searched"] is False


# ------------------------------------------------------------------ uses


async def test_uses_counts_your_own_photos_posts(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    a = await photo(client, ann, "IMG_a.jpg")
    b = await photo(client, ann, "IMG_b.jpg")
    one = await post_photos(client, ann, [fam], [a])
    await post_photos(client, ann, [fam], [a, b])
    assert (await ok(await client.get(f"/api/porch/files/{a}/uses", headers=H(ann))))["posts"] == 2
    assert (await ok(await client.get(f"/api/porch/files/{b}/uses", headers=H(ann))))["posts"] == 1
    got = await ok(await client.post("/api/porch/files/uses", headers=H(ann), json={"file_ids": [a, b]}))
    assert got == {"posts": 2, "photos": 2}
    # Someone else's photo says nothing.
    assert (await ok(await client.get(f"/api/porch/files/{a}/uses", headers=H(bob))))["posts"] == 0
    # A deleted post no longer counts.
    await ok(await client.delete(f"/api/porch/posts/{one['id']}", headers=H(ann)), 204)
    assert (await ok(await client.get(f"/api/porch/files/{a}/uses", headers=H(ann))))["posts"] == 1


# ------------------------------------------------------------------ Today


async def test_today_card_new_posts_and_birthdays(client, db, people):
    from app.porch.today import today_section

    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    await boot(client, bob)
    now = datetime.now(timezone.utc)
    today = now.date()
    assert await today_section(db, bob, now, today) is None

    await say(client, ann, [fam], "One")
    pic = await photo(client, ann, "IMG_t.jpg")
    await post_photos(client, ann, [fam], [pic], "Two")
    await say(client, bob, [fam], "Mine don't count")
    sec = await today_section(db, bob, now + timedelta(seconds=1), today)
    assert sec["new_posts"]["count"] == 2 and len(sec["new_posts"]["thumbs"]) == 1
    assert sec["new_posts"]["from"] == [ann.username]
    # Seen the feed: nothing new.
    await ok(await client.post("/api/porch/feed/seen", headers=H(bob), json={}))
    assert await today_section(db, bob, now + timedelta(seconds=1), today) is None
    # Unticking the group: not in the card either.
    # Birthdays: only shown ones, of people in a group with you.
    born = date(1990, today.month, today.day) if (today.month, today.day) != (2, 29) else date(1992, 2, 29)
    await ok(await client.patch("/api/porch/me/profile", headers=H(cat), json={"birthday": born.isoformat(), "show_birthday": True}))
    await ok(await client.patch("/api/porch/me/profile", headers=H(dan), json={"birthday": born.isoformat(), "show_birthday": True}))
    await ok(await client.patch("/api/porch/me/profile", headers=H(ann), json={"birthday": born.isoformat(), "show_birthday": False}))
    # bob unticks Everyone: only Family's people.
    ev = await everyone_id(client, bob)
    await ok(await client.patch(f"/api/porch/groups/{ev}/me", headers=H(bob), json={"in_feed": False}))
    sec = await today_section(db, bob, now + timedelta(seconds=1), today)
    assert [b["user"]["id"] for b in sec["birthdays"]] == [str(cat.id)]
    assert sec["birthdays"][0]["post_url"] == f"/porch/new?for={cat.id}"
    # Everyone ticked: dan too (everyone here is in Everyone).
    await ok(await client.patch(f"/api/porch/groups/{ev}/me", headers=H(bob), json={"in_feed": True}))
    sec = await today_section(db, bob, now + timedelta(seconds=1), today)
    assert {b["user"]["id"] for b in sec["birthdays"]} == {str(cat.id), str(dan.id)}
    # A block hides them.
    await block(client, dan, bob)
    sec = await today_section(db, bob, now + timedelta(seconds=1), today)
    assert [b["user"]["id"] for b in sec["birthdays"]] == [str(cat.id)]

    # The Today API carries it.
    got = await ok(await client.get("/api/today", headers=H(bob)))
    assert got["sections"]["porch"]["birthdays"][0]["user"]["id"] == str(cat.id)
    # Porch off: no card.
    await set_porch(db, porch_enabled=False)
    assert await today_section(db, bob, now, today) is None


# ------------------------------------------------------------------ links


async def test_porch_post_links_resolve_only_for_people_who_can_see(client, db, people):
    from app.links import refs

    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    post = await say(client, ann, [fam], "Our news")
    got = await refs.resolve(db, bob, "porch_post", post["id"])
    assert got["title"] == "Our news" and got["href"] == f"/porch/p/{post['id']}" and got["label"] == "Porch post"
    assert await refs.resolve(db, cat, "porch_post", post["id"]) is None
