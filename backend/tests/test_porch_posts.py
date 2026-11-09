"""Porch posts: only your own library photos; "All my groups" fixed when you
press Post; a post in two ticked groups shows once; unticking hides a group
from the feed but not from its page; video limits; editing and deleting;
paging and the Photos-only filter."""
from __future__ import annotations

import uuid

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, accept, boot, client, everyone_id, feed_ids, group, members_of, ok, people, photo, post_photos, quiet, root, say, sees,
    set_porch, upload,
)


async def test_only_your_own_library_photos_can_be_posted(client, db, people):
    from app.files.models import UserFile

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    mine = await photo(client, ann, ingest=False)
    theirs = await photo(client, bob, ingest=False)
    loose = await upload(client, ann, "elsewhere.jpg", route=None)  # in My files, not in Photos

    for bad in (theirs, loose, str(uuid.uuid4())):
        r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "photo", "groups": [fam], "media": [{"file_id": bad}]})
        assert r.status_code == 400 and "Photos library" in r.json()["detail"], bad
    # A photo in the trash can't be posted either.
    trashed = await photo(client, ann, "old.jpg", ingest=False)
    row = await db.get(UserFile, uuid.UUID(trashed))
    from datetime import datetime, timezone

    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "photo", "groups": [fam], "media": [{"file_id": trashed}]})
    assert r.status_code == 400

    got = await post_photos(client, ann, [fam], [mine], "Noosa with the kids 🌊")
    assert got["kind"] == "photo" and len(got["media"]) == 1 and got["media"][0]["file_id"] == mine
    assert got["body"] == "Noosa with the kids 🌊" and got["mine"] and got["can_delete"]
    # Others don't learn the file's id.
    seen = await ok(await client.get(f"/api/porch/posts/{got['id']}", headers=H(bob)))
    assert "file_id" not in seen["media"][0] and mine not in str(seen)
    # The same photo uploaded again is the same library file.
    again = await upload(client, ann, "IMG_0001 (1).jpg", data=(await _bytes(db, mine)))
    assert again == mine


async def _bytes(db, fid) -> bytes:
    from app.files.models import UserFile
    from app.files.storage import absolute_path

    row = await db.get(UserFile, uuid.UUID(fid))
    return absolute_path(row.storage_path).read_bytes()


async def test_posting_rules_and_validation(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    lads = await members_of(client, cat, "The Lads", [dan])
    # Groups you're not in don't exist for you.
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "text", "body": "hi", "groups": [lads]})
    assert r.status_code == 404
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "text", "body": "hi", "groups": []})
    assert r.status_code == 400
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "text", "body": "  ", "groups": [fam]})
    assert r.status_code == 400 and r.json()["detail"] == "Write something first"
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "photo", "body": "x", "groups": [fam]})
    assert r.status_code == 400
    # A poll needs its options (polls themselves: test_porch_talk.py).
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "poll", "body": "x", "groups": [fam]})
    assert r.status_code == 400 and r.json()["detail"] == "Add at least two options"
    # A link post with no words; the link is a snapshot (no outside images).
    got = await say(client, ann, [fam], "", link={"url": "https://example.com/a", "title": "A page", "site_name": "Example"})
    assert got["link"] == {"url": "https://example.com/a", "title": "A page", "description": "", "site_name": "Example"}
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "text", "groups": [fam], "link": {"url": "javascript:alert(1)"}})
    assert r.status_code == 422
    # A place and a life event.
    got = await say(client, ann, [fam], "We're engaged!", place={"name": "Noosa Heads", "lat": -26.39, "lon": 153.09})
    assert got["place"]["name"] == "Noosa Heads"
    got = await ok(await client.post("/api/porch/posts", headers=H(ann), json={
        "kind": "life_event", "body": "", "groups": [fam], "life_event": {"type": "new_job", "title": "Started at the council", "date": "2026-11-02"},
    }), 201)
    assert got["kind"] == "life_event" and got["life_event"] == {"type": "new_job", "title": "Started at the council", "date": "2026-11-02"}
    prof = await ok(await client.get(f"/api/porch/users/{ann.id}/posts", headers=H(bob), params={"tab": "life_events"}))
    assert [p["id"] for p in prof["posts"]] == [got["id"]]


async def test_all_my_groups_is_fixed_when_you_post(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    early = await say(client, ann, "all", "to everything I'm in")
    assert sorted(g["name"] for g in early["groups"]) == ["Everyone", "Family"]
    # A group Ann joins later doesn't get her old posts.
    later = await members_of(client, cat, "Fishing", [ann], "public")
    await ok(await client.post(f"/api/porch/groups/{later}/join", headers=H(dan)))
    page = await ok(await client.get(f"/api/porch/groups/{later}/posts", headers=H(dan)))
    assert early["id"] not in [p["id"] for p in page["posts"]]
    # The picker starts on what you used last.
    assert (await boot(client, ann))["profile"]["last_groups"] == "all"
    await say(client, ann, [fam], "just family")
    assert (await boot(client, ann))["profile"]["last_groups"] == [fam]


async def test_two_ticked_groups_show_once_and_unticking_hides_from_feed_only(client, db, people):
    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    lads = await members_of(client, ann, "The Lads", [bob])
    both = (await say(client, ann, [fam, lads], "BBQ"))["id"]
    only_lads = (await say(client, ann, [lads], "pub?"))["id"]
    assert await feed_ids(client, bob) == [only_lads, both]
    got = await ok(await client.get(f"/api/porch/posts/{both}", headers=H(bob)))
    assert [g["name"] for g in got["groups"]] == ["Family", "The Lads"]

    await ok(await client.patch(f"/api/porch/groups/{lads}/me", headers=H(bob), json={"in_feed": False}))
    assert await feed_ids(client, bob) == [both]  # still via Family
    page = await ok(await client.get(f"/api/porch/groups/{lads}/posts", headers=H(bob)))
    assert [p["id"] for p in page["posts"]] == [only_lads, both]
    await ok(await client.patch(f"/api/porch/groups/{fam}/me", headers=H(bob), json={"in_feed": False}))
    ev = await everyone_id(client, bob)
    await ok(await client.patch(f"/api/porch/groups/{ev}/me", headers=H(bob), json={"in_feed": False}))
    got = await ok(await client.get("/api/porch/feed", headers=H(bob)))
    assert got["posts"] == [] and got["ticked"] == []
    assert await sees(client, bob, both)  # unticking isn't leaving


async def test_feed_pages_newest_first_and_photos_only(client, db, people):
    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    ids = [(await say(client, ann, [fam], f"post {i}"))["id"] for i in range(33)]
    first = await ok(await client.get("/api/porch/feed", headers=H(bob)))
    assert [p["id"] for p in first["posts"]] == ids[::-1][:30] and first["next"]
    second = await ok(await client.get("/api/porch/feed", headers=H(bob), params={"before": first["next"]}))
    assert [p["id"] for p in second["posts"]] == ids[::-1][30:] and second["next"] is None
    assert (await client.get("/api/porch/feed", headers=H(bob), params={"before": "nonsense"})).status_code == 400

    pic = await photo(client, ann, ingest=False)
    shot = await post_photos(client, ann, [fam], [pic])
    assert await feed_ids(client, bob, photos="true") == [shot["id"]]

    # "You're all caught up": the mark moves forward only.
    seen = await ok(await client.post("/api/porch/feed/seen", headers=H(bob), json={}))
    assert seen["feed_seen_at"]
    back = await ok(await client.post("/api/porch/feed/seen", headers=H(bob), json={"at": "2020-01-01T00:00:00Z"}))
    assert back["feed_seen_at"] == seen["feed_seen_at"]
    assert (await ok(await client.get("/api/porch/feed", headers=H(bob))))["feed_seen_at"] == seen["feed_seen_at"]


async def test_video_limits(client, db, people, tmp_path):
    import subprocess

    from app.files.models import FileMedia

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    p = tmp_path / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p)],
        check=True,
    )
    fid = await upload(client, ann, "clip.mp4", p.read_bytes(), "video/mp4")
    await set_porch(db, porch_video_max_mb=1, porch_video_max_seconds=60)
    got = await post_photos(client, ann, [fam], [fid])
    assert got["kind"] == "video" and got["media"][0]["kind"] == "video"
    # Before the media worker: the MP4 plays as uploaded.
    assert got["media"][0]["video"]
    # Too long (once the worker has read its length).
    fm = await db.get(FileMedia, uuid.UUID(fid))
    if fm is None:
        fm = FileMedia(file_id=uuid.UUID(fid), kind="video")
        db.add(fm)
    fm.duration_ms = 61_000
    await db.commit()
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "video", "groups": [fam], "media": [{"file_id": fid}]})
    assert r.status_code == 400 and r.json()["detail"] == "Videos can be up to 1 minute and 1 MB here"
    fm.duration_ms = 2_000
    await set_porch(db, porch_video_max_mb=0)
    r = await client.post("/api/porch/posts", headers=H(ann), json={"kind": "video", "groups": [fam], "media": [{"file_id": fid}]})
    assert r.status_code == 400 and "Videos can be up to" in r.json()["detail"]


async def test_edit_and_delete(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    await ok(await client.patch(f"/api/porch/groups/{fam}/members/{cat.id}", headers=H(ann), json={"role": "admin"}))
    a, b, c = [await photo(client, ann, f"IMG_{i}.jpg", ingest=False) for i in range(3)]
    post = await post_photos(client, ann, [fam], [a, b], "first go")
    ma, mb = post["media"]
    assert post["edited_at"] is None

    # Only the author edits.
    r = await client.patch(f"/api/porch/posts/{post['id']}", headers=H(bob), json={"body": "mine now"})
    assert r.status_code == 403
    got = await ok(await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={
        "body": "second go", "place": {"name": "Noosa"},
        "media": [{"id": mb["id"], "alt_text": "Kids on the sand"}, {"file_id": c}],
    }))
    assert got["body"] == "second go" and got["place"]["name"] == "Noosa" and got["edited_at"]
    assert [m["file_id"] for m in got["media"]] == [b, c] and got["media"][0]["id"] == mb["id"]
    assert got["media"][0]["alt_text"] == "Kids on the sand"
    # Its groups don't change, and other people's photos can't be slipped in.
    bobs = await photo(client, bob, ingest=False)
    r = await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={"media": [{"file_id": bobs}]})
    assert r.status_code == 400
    r = await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={"media": []})
    assert r.status_code == 400
    r = await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={"media": [{"id": str(uuid.uuid4())}]})
    assert r.status_code == 404
    # Clearing the place.
    got = await ok(await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={"place": None}))
    assert got["place"] is None and len(got["media"]) == 2

    # Delete: not a plain member; an admin of every group it's in may.
    assert (await client.delete(f"/api/porch/posts/{post['id']}", headers=H(bob))).status_code == 403
    assert (await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(cat))))["can_delete"] is True
    await ok(await client.delete(f"/api/porch/posts/{post['id']}", headers=H(cat)), 204)
    assert not await sees(client, ann, post["id"])
    # The photos stay in Ann's library.
    from app.files.models import UserFile

    for f in (a, b, c):
        assert (await db.get(UserFile, uuid.UUID(f))).trashed_at is None

    # An admin of only one of a post's groups can't delete it.
    lads = await members_of(client, ann, "The Lads", [bob])
    two = (await say(client, ann, [fam, lads], "both"))["id"]
    assert (await ok(await client.get(f"/api/porch/posts/{two}", headers=H(cat))))["can_delete"] is False
    assert (await client.delete(f"/api/porch/posts/{two}", headers=H(cat))).status_code == 403
    # A server admin is Everyone's admin.
    ev = await everyone_id(client, bob)
    hi = (await say(client, bob, [ev], "hi all"))["id"]
    await ok(await client.delete(f"/api/porch/posts/{hi}", headers=H(ann)), 204)
