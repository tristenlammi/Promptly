"""Porch stories (WP-P2.1): the access matrix (membership × block × expired
× deleted × Porch off), the row following ticked groups, viewers seen only
by the poster (blocked people left out), signed links stopping at expiry
for everyone but the poster, a purged or trashed photo ending the story,
the one-minute video limit, mentions only for people in the groups, no push
for a new story (only "mentioned you in a story"), not in search, reports
going to the group's admins, and export."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, boot, client, everyone_id, members_of, mpath, ok, people, photo, quiet, root, set_porch,
)


async def story(client, u, groups, **body) -> dict:
    payload = {"kind": "text", "text": "Hello", "groups": groups if groups == "all" else [str(g) for g in groups], **body}
    return await ok(await client.post("/api/porch/stories", headers=H(u), json=payload), 201)


async def theirs(client, viewer, author, **params) -> list[str]:
    got = await ok(await client.get(f"/api/porch/stories/u/{author.id}", headers=H(viewer), params=params))
    return [s["id"] for s in got["stories"]]


async def can_see(client, viewer, sid) -> bool:
    r = await client.get(f"/api/porch/stories/{sid}", headers=H(viewer))
    assert r.status_code in (200, 404), r.text
    return r.status_code == 200


async def row(client, u) -> dict:
    return await ok(await client.get("/api/porch/stories", headers=H(u)))


async def expire(db, sid) -> None:
    await db.execute(text("UPDATE porch_stories SET expires_at = now() - interval '1 minute' WHERE id = :s"), {"s": uuid.UUID(sid)})
    await db.commit()


@pytest.fixture
def pushes(monkeypatch):
    import app.notifications.dispatch as d

    rec = SimpleNamespace(calls=[])

    async def fake(**kw):
        rec.calls.append(kw)

    monkeypatch.setattr(d, "notify_user", fake)
    return rec


async def test_the_matrix(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    s = await story(client, ann, [fam], text="Pancakes!", background="ocean")
    assert s["kind"] == "text" and s["background"] == "ocean" and s["mine"] and s["groups"][0]["name"] == "Family"
    assert not s["expired"] and s["view_count"] == 0
    # Members see it; outsiders don't (not even Everyone's members).
    assert await can_see(client, bob, s["id"]) and not await can_see(client, cat, s["id"])
    assert await theirs(client, bob, ann) == [s["id"]]
    assert await theirs(client, cat, ann) == []

    # A block either way hides it.
    await ok(await client.put(f"/api/people/blocks/{ann.id}", headers=H(bob)))
    assert not await can_see(client, bob, s["id"])
    await ok(await client.delete(f"/api/people/blocks/{ann.id}", headers=H(bob)))
    assert await can_see(client, bob, s["id"])

    # Porch off for the viewer: nothing at all.
    await set_porch(db, porch_enabled=False)
    assert (await client.get(f"/api/porch/stories/{s['id']}", headers=H(bob))).status_code == 404
    await set_porch(db, porch_enabled=True)

    # Expired: gone for everyone but the poster (who keeps it in the archive).
    await expire(db, s["id"])
    assert not await can_see(client, bob, s["id"]) and await can_see(client, ann, s["id"])
    assert (await row(client, ann))["me"] is None
    arch = await ok(await client.get("/api/porch/stories/archive", headers=H(ann)))
    assert [x["id"] for x in arch["stories"]] == [s["id"]] and arch["stories"][0]["expired"]
    assert (await ok(await client.get("/api/porch/stories/archive", headers=H(bob))))["stories"] == []

    # Deleted: gone for everyone, the poster too.
    s2 = await story(client, ann, "all", text="To everyone")
    assert await can_see(client, cat, s2["id"]) and await can_see(client, dan, s2["id"])
    assert (await client.delete(f"/api/porch/stories/{s2['id']}", headers=H(bob))).status_code == 404
    await ok(await client.delete(f"/api/porch/stories/{s2['id']}", headers=H(ann)), 204)
    assert not await can_see(client, cat, s2["id"]) and not await can_see(client, ann, s2["id"])

    # Leaving the group hides its stories at once; a deleted group's too.
    s3 = await story(client, ann, [fam])
    await ok(await client.delete(f"/api/porch/groups/{fam}/members/{bob.id}", headers=H(bob)), 204)
    assert not await can_see(client, bob, s3["id"])


async def test_the_row_follows_ticked_groups(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    lads = await members_of(client, cat, "The Lads", [bob, dan])
    a = await story(client, ann, [fam], text="Family news")
    c1 = await story(client, cat, [lads], text="Fishing")
    r = await row(client, bob)
    assert r["me"] is None
    who = {p["user"]["id"]: p for p in r["people"]}
    assert set(who) == {str(ann.id), str(cat.id)}
    # One group each: that group's emoji goes on the ring.
    assert who[str(ann.id)]["ring_group"]["name"] == "Family" and who[str(cat.id)]["ring_group"]["name"] == "The Lads"
    assert who[str(ann.id)]["unseen"] == 1 and who[str(ann.id)]["thumb"]["background"] == "sunset"

    # Untick The Lads: Cat drops out of the row (her Lads story isn't in the feed)…
    await ok(await client.patch(f"/api/porch/groups/{lads}/me", headers=H(bob), json={"in_feed": False}))
    assert [p["user"]["id"] for p in (await row(client, bob))["people"]] == [str(ann.id)]
    # …but her page still shows it unless asked for the feed's view.
    assert await theirs(client, bob, cat) == [c1["id"]]
    assert await theirs(client, bob, cat, feed=1) == []

    # Seen goes to the end; your own circle is separate.
    c2 = await story(client, cat, [fam], text="Also family")
    await ok(await client.post(f"/api/porch/stories/{a['id']}/view", headers=H(bob)))
    order = [p["user"]["id"] for p in (await row(client, bob))["people"]]
    assert order == [str(cat.id), str(ann.id)]
    cat_row = (await row(client, bob))["people"][0]
    assert cat_row["count"] == 1 and cat_row["ring_group"]["name"] == "Family"
    mine = (await row(client, cat))["me"]
    assert mine["count"] == 2 and mine["ring_group"] is None
    assert c2["id"]


async def test_viewers_only_for_the_poster(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    s = await story(client, ann, [fam])
    for u in (bob, cat):
        await ok(await client.post(f"/api/porch/stories/{s['id']}/view", headers=H(u)))
    await ok(await client.post(f"/api/porch/stories/{s['id']}/view", headers=H(bob)))  # twice is once
    await ok(await client.post(f"/api/porch/stories/{s['id']}/view", headers=H(ann)))  # your own never counts
    got = await ok(await client.get(f"/api/porch/stories/{s['id']}/viewers", headers=H(ann)))
    assert got["count"] == 2 and {v["user"]["id"] for v in got["viewers"]} == {str(bob.id), str(cat.id)}
    assert (await client.get(f"/api/porch/stories/{s['id']}/viewers", headers=H(bob))).status_code == 403
    assert (await client.get(f"/api/porch/stories/{s['id']}/viewers", headers=H(dan))).status_code == 404
    seen = (await ok(await client.get(f"/api/porch/stories/u/{ann.id}", headers=H(bob))))["stories"][0]
    assert seen["seen"] and "view_count" not in seen
    assert (await ok(await client.get(f"/api/porch/stories/{s['id']}", headers=H(ann))))["view_count"] == 2
    # A block hides the viewer from the list and the count.
    await ok(await client.put(f"/api/people/blocks/{cat.id}", headers=H(ann)))
    got = await ok(await client.get(f"/api/porch/stories/{s['id']}/viewers", headers=H(ann)))
    assert [v["user"]["id"] for v in got["viewers"]] == [str(bob.id)]
    assert (await ok(await client.get(f"/api/porch/stories/{s['id']}", headers=H(ann))))["view_count"] == 1
    # Outsiders can't mark it seen.
    assert (await client.post(f"/api/porch/stories/{s['id']}/view", headers=H(dan))).status_code == 404


async def test_photo_links_stop_at_expiry_and_purge_ends_it(client, db, people):
    ann, bob, cat, _ = people
    fam = await members_of(client, ann, "Family", [bob])
    fid = await photo(client, ann, "beach.jpg")
    crop = {"crop": {"x": 0.3, "y": 0.0, "w": 0.4, "h": 1.0}}
    s = await story(client, ann, [fam], kind="photo", file_id=fid, edit=crop, alt_text="The beach")
    m = s["media"]
    assert m["kind"] == "image" and m["preview"] and m["thumb"] and s["alt_text"] == "The beach"
    # The crop is this story's own: a 9:16-ish picture, not the library's.
    b = (await ok(await client.get(f"/api/porch/stories/{s['id']}", headers=H(bob))))["media"]
    assert b["width"] < b["height"]
    r = await client.get(mpath(b["preview"]), headers=H(bob))
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    # Someone else's file can't be a story; a text story with no words can't either.
    other = await photo(client, bob, "mine.jpg")
    assert (await client.post("/api/porch/stories", headers=H(ann), json={"kind": "photo", "file_id": other, "groups": "all"})).status_code == 400
    assert (await client.post("/api/porch/stories", headers=H(ann), json={"kind": "text", "text": "  ", "groups": "all"})).status_code == 400

    # Expired: Bob's links stop, Ann's still work.
    mine = (await ok(await client.get(f"/api/porch/stories/{s['id']}", headers=H(ann))))["media"]
    await expire(db, s["id"])
    assert (await client.get(mpath(b["preview"]))).status_code == 404
    assert (await client.get(mpath(mine["preview"]))).status_code == 200

    # A trashed photo hides the story; purging the photo ends it.
    s2 = await story(client, ann, [fam], kind="photo", file_id=fid)
    await db.execute(text("UPDATE files SET trashed_at = now() WHERE id = :f"), {"f": uuid.UUID(fid)})
    await db.commit()
    assert not await can_see(client, bob, s2["id"])
    await db.execute(text("UPDATE files SET trashed_at = NULL WHERE id = :f"), {"f": uuid.UUID(fid)})
    await db.commit()
    assert await can_see(client, bob, s2["id"])
    await db.execute(text("DELETE FROM files WHERE id = :f"), {"f": uuid.UUID(fid)})
    await db.commit()
    assert (await db.execute(text("SELECT count(*) FROM porch_stories WHERE file_id IS NOT NULL"))).scalar() == 0
    assert not await can_see(client, bob, s2["id"])


async def test_videos_up_to_a_minute(client, db, people):
    ann, bob, *_ = people
    fid = await photo(client, ann, "clip.jpg")
    await db.execute(
        text("UPDATE file_media SET kind = 'video', duration_ms = :d WHERE file_id = :f"), {"d": 90_000, "f": uuid.UUID(fid)}
    )
    await db.execute(text("UPDATE files SET mime_type = 'video/mp4' WHERE id = :f"), {"f": uuid.UUID(fid)})
    await db.commit()
    r = await client.post("/api/porch/stories", headers=H(ann), json={"kind": "video", "file_id": fid, "groups": "all"})
    assert r.status_code == 400 and "up to a minute" in r.json()["detail"]
    await db.execute(text("UPDATE file_media SET duration_ms = 59000 WHERE file_id = :f"), {"f": uuid.UUID(fid)})
    await db.commit()
    s = await story(client, ann, "all", kind="video", file_id=fid)
    assert s["kind"] == "video" and s["media"]["kind"] == "video"
    assert (await boot(client, ann))["limits"]["story_video_max_seconds"] == 60


async def test_stickers_and_mentions_only_for_people_in_the_groups(client, db, people, pushes):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    pushes.calls.clear()  # the invite
    s = await story(
        client, ann, [fam], text="Look",
        overlays=[
            {"type": "text", "x": 0.5, "y": 0.2, "text": "Hi!", "style": "bold", "scale": 1.5, "rotate": 10},
            {"type": "mention", "x": 0.5, "y": 0.5, "user_id": str(bob.id)},
            {"type": "mention", "x": 0.5, "y": 0.6, "user_id": str(cat.id)},  # not in Family: dropped
            {"type": "place", "x": 0.5, "y": 0.8, "place": {"name": "Noosa", "lat": -26.39, "lon": 153.09}},
            {"type": "text", "x": 0.1, "y": 0.1, "text": "   "},  # empty: dropped
        ],
    )
    kinds = [o["type"] for o in s["overlays"]]
    assert kinds == ["text", "mention", "place"]
    assert s["overlays"][1]["user"]["id"] == str(bob.id) and s["overlays"][2]["place"]["name"] == "Noosa"
    # Only "mentioned you in a story" pushes; nothing for a new story.
    porch = [c for c in pushes.calls if c["category"] == "porch"]
    assert [(c["user_id"], c["extra"]["kind"]) for c in porch] == [(bob.id, "mention")]
    assert "mentioned you in a story" in porch[0]["title"]
    pushes.calls.clear()
    await story(client, ann, "all", text="Nobody's told")
    assert [c for c in pushes.calls if c["category"] == "porch"] == []
    # A blocked person's mention isn't shown to the viewer.
    await ok(await client.put(f"/api/people/blocks/{bob.id}", headers=H(cat)))
    s_all = await story(client, ann, "all", overlays=[{"type": "mention", "x": 0.5, "y": 0.5, "user_id": str(bob.id)}])
    assert [o["type"] for o in (await ok(await client.get(f"/api/porch/stories/{s_all['id']}", headers=H(cat))))["overlays"]] == []
    # An unknown background or style is refused.
    bad = await client.post("/api/porch/stories", headers=H(ann), json={"kind": "text", "text": "x", "background": "plaid", "groups": "all"})
    assert bad.status_code == 422


async def test_stories_are_not_searched(client, db, people):
    ann, bob, *_ = people
    await story(client, ann, "all", text="Zanzibar holiday")
    got = await ok(await client.get("/api/porch/search", headers=H(bob), params={"q": "Zanzibar"}))
    assert got["results"] == []


async def test_reports_go_to_the_groups_admins(client, db, people):
    ann, bob, cat, dan = people
    # Bob runs Family (Ann is a member); Ann posts a story there.
    fam = await members_of(client, bob, "Family", [ann, cat])
    s = await story(client, ann, [fam], text="Something rude")
    r = await ok(await client.post("/api/porch/reports", headers=H(cat), json={"target_type": "story", "target_id": s["id"], "reason": "Rude"}), 201)
    assert [g["name"] for g in r["groups"]] == ["Family"]
    # Ann can't report her own; Dan (not in Family) can't see it to report it.
    assert (await client.post("/api/porch/reports", headers=H(ann), json={"target_type": "story", "target_id": s["id"]})).status_code == 400
    assert (await client.post("/api/porch/reports", headers=H(dan), json={"target_type": "story", "target_id": s["id"]})).status_code == 404
    q = await ok(await client.get(f"/api/porch/groups/{fam}/reports", headers=H(bob)))
    assert len(q) == 1 and q[0]["target"]["type"] == "story" and q[0]["target"]["body"] == "Something rude"
    assert "reporter" not in str(q[0]) and str(cat.id) not in str(q[0])
    # The server admin (Ann is one, but she's the poster) — Dan isn't an admin; nobody outside sees it in Admin → Porch.
    admin_q = await ok(await client.get("/api/admin/porch/reports", headers=H(ann)))
    assert admin_q == []
    out = await ok(await client.post(f"/api/porch/groups/{fam}/reports/{q[0]['id']}", headers=H(bob), json={"action": "remove", "reason": "Not here"}))
    assert out["deleted"] is True
    assert not await can_see(client, cat, s["id"])
    act = await ok(await client.get("/api/porch/activity", headers=H(ann)))
    removed = [i for i in act["items"] if i["kind"] == "removed"]
    assert removed and removed[0]["target"] == "story" and removed[0]["removed"]["reason"] == "Not here"


async def test_export_has_your_stories(client, db, people):
    from app.porch.export import porch_json

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    await story(client, ann, [fam], text="Breakfast", overlays=[{"type": "text", "x": 0.5, "y": 0.5, "text": "Yum"}])
    await story(client, bob, [fam], text="Not Ann's")
    out = await porch_json(db, ann, {}, "")
    assert [s["text"] for s in out["stories"]] == ["Breakfast"]
    assert out["stories"][0]["groups"] == ["Family"] and out["stories"][0]["stickers"] == ["Yum"]
    assert datetime.fromisoformat(out["stories"][0]["ended"]) - datetime.fromisoformat(out["stories"][0]["posted"]) == timedelta(hours=24)
    assert datetime.now(timezone.utc)


# ------------------------------------------------------------------ replies (WP-P2.3)


async def test_a_reply_lands_in_the_posters_dm_with_the_story(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    s = await story(client, ann, [fam], text="New puppy!")
    got = await ok(await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(bob), json={"text": "So cute"}), 201)
    room = got["room_id"]
    boot_ann = await ok(await client.get("/api/rooms/bootstrap", headers=H(ann)))
    assert room in [d["id"] for d in boot_ann["dms"]]
    msgs = await ok(await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann)))
    items = msgs["messages"] if isinstance(msgs, dict) else msgs
    last = items[-1]
    assert last["body"] == "So cute" and last["meta"]["share"]["kind"] == "porch_story" and last["meta"]["share"]["id"] == s["id"]
    # The card while it's live: both of them see it; nobody else would.
    for u in (ann, bob):
        c = await ok(await client.get(f"/api/crossapp/share/card/{last['id']}", headers=H(u)))
        assert c["card"]["title"] == "New puppy!" and c["card"]["href"] == f"/porch/stories/{ann.id}" and c["can_grant"] is False
    # A reaction is the emoji, in the same conversation.
    again = await ok(await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(bob), json={"emoji": "❤️"}), 201)
    assert again["room_id"] == room
    assert (await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(bob), json={"emoji": "🍕"})).status_code == 400
    assert (await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(bob), json={"text": "  "})).status_code == 400
    # Your own story: nobody to reply to; an outsider: 404.
    assert (await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(ann), json={"text": "hi"})).status_code == 400
    assert (await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(dan), json={"text": "hi"})).status_code == 404
    # Ended: the card is gone for everyone, the poster too ("This story has ended").
    await expire(db, s["id"])
    for u in (ann, bob):
        c = await ok(await client.get(f"/api/crossapp/share/card/{last['id']}", headers=H(u)))
        assert c["card"] is None and c["label"] == "a Porch story"
    assert (await client.post(f"/api/porch/stories/{s['id']}/reply", headers=H(bob), json={"text": "late"})).status_code == 404
    # A block either way refuses it.
    s2 = await story(client, ann, [fam], text="Another")
    await ok(await client.put(f"/api/people/blocks/{cat.id}", headers=H(ann)))
    assert (await client.post(f"/api/porch/stories/{s2['id']}/reply", headers=H(cat), json={"text": "hi"})).status_code in (403, 404)


async def test_stories_remember_their_own_audience(client, db, people):
    from tests.porch_kit import say

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    await say(client, ann, [fam], "A post to Family")
    await story(client, ann, "all", text="A story to everyone")
    prof = (await boot(client, ann))["profile"]
    assert prof["last_groups"] == [fam] and prof["last_story_groups"] == "all"
