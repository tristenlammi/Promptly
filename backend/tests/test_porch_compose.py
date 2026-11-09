"""Porch's composer (WP-P1.4): what Photos already knows about the photos
you're posting (a description and a place, your own photos only), @mentions
kept only for people who can see the post, life events, and "Share this
memory" keeping only your own memory."""
from __future__ import annotations

import uuid

from sqlalchemy import text

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, accept, boot, client, everyone_id, group, members_of, ok, people, photo, post_photos, quiet, root, say, sees,
)


async def _place_for(db, fid: str, user, place_id: int, *, hidden: bool = False) -> None:
    await db.execute(
        text(
            "INSERT INTO photo_assets (file_id, user_id, kind, taken_at, taken_local, place_id) "
            "VALUES (:f, :u, 'image', now(), now(), :p) ON CONFLICT (file_id) DO UPDATE SET place_id = :p"
        ),
        {"f": uuid.UUID(fid), "u": user.id, "p": place_id},
    )
    if hidden:
        await db.execute(text("UPDATE file_media SET location_hidden = true WHERE file_id = :f"), {"f": uuid.UUID(fid)})
    await db.commit()


async def test_compose_files_gives_your_photos_description_and_place(client, db, people):
    ann, bob, *_ = people
    await db.execute(text("INSERT INTO geo_countries (code, name) VALUES ('AU', 'Australia') ON CONFLICT DO NOTHING"))
    await db.execute(text("INSERT INTO geo_admin1 (code, name) VALUES ('AU.04', 'Queensland') ON CONFLICT DO NOTHING"))
    await db.execute(
        text(
            "INSERT INTO geo_places (geonameid, name, ascii_name, lat, lon, feature_code, country, admin1, population) "
            "VALUES (2154219, 'Noosa Heads', 'Noosa Heads', -26.39433, 153.09010, 'PPL', 'AU', '04', 4000) ON CONFLICT DO NOTHING"
        )
    )
    await db.commit()
    beach, plain, secret = [await photo(client, ann, f"IMG_{i}.jpg") for i in range(3)]
    theirs = await photo(client, bob, "bob.jpg")
    await _place_for(db, beach, ann, 2154219)
    await _place_for(db, secret, ann, 2154219, hidden=True)
    for fid, cap in ((beach, "Two children building a sandcastle on a beach."), (theirs, "Bob's dog.")):
        await db.execute(
            text("INSERT INTO photo_captions (file_id, caption, tags, model) VALUES (:f, :c, '[]', 'test')"),
            {"f": uuid.UUID(fid), "c": cap},
        )
    await db.commit()

    got = await ok(await client.post("/api/porch/compose/files", headers=H(ann), json={"file_ids": [beach, plain, secret, theirs, str(uuid.uuid4())]}))
    by = {f["file_id"]: f for f in got["files"]}
    # Only Ann's own photos, in the order asked.
    assert [f["file_id"] for f in got["files"]] == [beach, plain, secret]
    assert by[beach]["caption"] == "Two children building a sandcastle on a beach."
    assert by[beach]["place"] == {"name": "Noosa Heads", "address": "Noosa Heads, Queensland, Australia", "lat": -26.3943, "lon": 153.0901}
    assert by[plain] == {"file_id": plain, "caption": None, "place": None}
    # A photo whose location was hidden in Photos offers no place.
    assert by[secret]["place"] is None
    # Bob asking about Ann's photo learns nothing.
    got = await ok(await client.post("/api/porch/compose/files", headers=H(bob), json={"file_ids": [beach]}))
    assert got["files"] == []


async def test_mentions_are_kept_only_for_people_who_can_see_the_post(client, db, people):
    from app.people import blocks

    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    lads = await members_of(client, ann, "The Lads", [dan])
    # The mention picker for Family offers Bob and Cat, never Dan.
    picker = await ok(await client.get("/api/porch/people", headers=H(ann), params={"groups": [fam]}))
    assert {p["id"] for p in picker} == {str(bob.id), str(cat.id)}
    # Dan can't see a Family post, and Ann can't mention herself: both dropped.
    got = await say(client, ann, [fam], f"Look @{bob.username} @{dan.username}", mentions=[str(bob.id), str(dan.id), str(ann.id), str(bob.id)])
    assert [m["id"] for m in got["mentions"]] == [str(bob.id)]
    assert got["mentions"][0]["username"] == bob.username
    # Posting to both groups: Dan can be mentioned too.
    both = await say(client, ann, [fam, lads], "all of you", mentions=[str(dan.id), str(cat.id)])
    assert [m["id"] for m in both["mentions"]] == [str(dan.id), str(cat.id)]
    # Editing the words can change who's mentioned, by the same rule.
    got = await ok(await client.patch(f"/api/porch/posts/{got['id']}", headers=H(ann), json={"body": "Look @cat", "mentions": [str(cat.id), str(dan.id)]}))
    assert [m["id"] for m in got["mentions"]] == [str(cat.id)]
    # Leaving mentions out of an edit keeps them.
    got = await ok(await client.patch(f"/api/porch/posts/{got['id']}", headers=H(ann), json={"body": "Look @cat!"}))
    assert [m["id"] for m in got["mentions"]] == [str(cat.id)]
    # Someone who blocked a mentioned person doesn't see them named.
    await blocks.block(db, bob.id, cat.id)
    await db.commit()
    seen = await ok(await client.get(f"/api/porch/posts/{got['id']}", headers=H(bob)))
    assert seen["mentions"] == []


async def test_life_events(client, db, people):
    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    # A life event needs to say what happened, with a known kind and a date.
    for bad in (None, {"type": "won_lotto", "date": "2026-11-01"}, {"type": "new_baby"}):
        r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "life_event", "groups": [fam], "life_event": bad})
        assert r.status_code in (400, 422), bad
    pic = await photo(client, ann, "baby.jpg")
    got = await ok(await client.post("/api/porch/posts", headers=H(ann), json={
        "kind": "life_event", "body": "Welcome to the world", "groups": [fam],
        "life_event": {"type": "new_baby", "title": "Max was born", "date": "2026-11-07"},
        "media": [{"file_id": pic, "alt_text": "A sleeping baby"}],
    }), 201)
    assert got["kind"] == "life_event" and got["life_event"] == {"type": "new_baby", "title": "Max was born", "date": "2026-11-07"}
    assert len(got["media"]) == 1 and got["media"][0]["alt_text"] == "A sleeping baby"
    tab = await ok(await client.get(f"/api/porch/users/{ann.id}/posts", headers=H(bob), params={"tab": "life_events"}))
    assert [p["id"] for p in tab["posts"]] == [got["id"]]
    # Its date and words can be changed afterwards; it stays a life event.
    got = await ok(await client.patch(f"/api/porch/posts/{got['id']}", headers=H(ann), json={
        "life_event": {"type": "new_baby", "title": "Max is here", "date": "2026-11-06"}, "place": {"name": "Nambour Hospital"},
    }))
    assert got["life_event"]["date"] == "2026-11-06" and got["place"]["name"] == "Nambour Hospital" and got["edited_at"]


async def test_share_this_memory_keeps_only_your_own_memory(client, db, people):
    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    pic = await photo(client, ann, "trip.jpg")
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    for mid, who in ((mine, ann), (theirs, bob)):
        await db.execute(
            text(
                "INSERT INTO photo_memories (id, user_id, kind, key, title, period_start, period_end, file_ids) "
                "VALUES (:id, :u, 'trip', :k, 'Noosa trip', '2026-01-01', '2026-01-05', ARRAY[]::uuid[])"
            ),
            {"id": mid, "u": who.id, "k": f"trip-{mid}"},
        )
    await db.commit()
    a = await post_photos(client, ann, [fam], [pic], "Noosa trip", from_memory_id=str(mine))
    b = await post_photos(client, ann, [fam], [pic], "Noosa trip", from_memory_id=str(theirs))
    kept = dict((await db.execute(text("SELECT id, from_memory_id FROM porch_posts WHERE id IN (:a, :b)"), {"a": uuid.UUID(a["id"]), "b": uuid.UUID(b["id"])})).all())
    assert kept[uuid.UUID(a["id"])] == mine and kept[uuid.UUID(b["id"])] is None
