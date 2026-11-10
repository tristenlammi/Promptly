"""Highlights and the story archive (WP-P2.4): each viewer gets only the
stories in a highlight they may see (Mum the family ones, the mates
theirs), a highlight with none for you isn't there, deleting a story drops
it from highlights (and an emptied highlight goes), only your own stories go
in yours, and an old story's links keep working for the people a highlight
still shows it to — and only them."""
from __future__ import annotations

import uuid

from sqlalchemy import text

from tests.porch_kit import H, client, members_of, mpath, ok, people, photo, quiet, root  # noqa: F401 — fixtures


async def story(client, u, groups, **body) -> dict:
    payload = {"kind": "text", "text": "Hello", "groups": groups if groups == "all" else [str(g) for g in groups], **body}
    return await ok(await client.post("/api/porch/stories", headers=H(u), json=payload), 201)


async def expire_all(db) -> None:
    await db.execute(text("UPDATE porch_stories SET expires_at = now() - interval '1 minute'"))
    await db.commit()


async def highlights(client, viewer, owner) -> list[dict]:
    return await ok(await client.get(f"/api/porch/users/{owner.id}/highlights", headers=H(viewer)))


async def test_each_viewer_sees_only_their_stories_in_a_highlight(client, db, people):
    ann, mum, mate, dan = people
    fam = await members_of(client, ann, "Family", [mum])
    lads = await members_of(client, ann, "The Lads", [mate])
    f1 = await story(client, ann, [fam], text="Kids at the beach")
    l1 = await story(client, ann, [lads], text="Fishing trip")
    f2 = await story(client, ann, [fam], text="Sandcastle")
    h = await ok(
        await client.post("/api/porch/me/highlights", headers=H(ann), json={"name": "Summer", "story_ids": [f1["id"], l1["id"], f2["id"]], "cover_story_id": l1["id"]}),
        201,
    )
    assert h["name"] == "Summer" and h["count"] == 3 and h["cover"]["story_id"] == l1["id"]
    await expire_all(db)  # a highlight outlives the day

    mums = await highlights(client, mum, ann)
    assert [s["text"] for s in mums[0]["stories"]] == ["Kids at the beach", "Sandcastle"]
    # The cover she can't see isn't hers: the first she can is.
    assert mums[0]["cover"]["story_id"] == f1["id"] and mums[0]["count"] == 2 and mums[0]["mine"] is False
    mates = await highlights(client, mate, ann)
    assert [s["text"] for s in mates[0]["stories"]] == ["Fishing trip"]
    # Someone in none of its groups: no highlight at all.
    assert await highlights(client, dan, ann) == []
    # Ann sees all of hers.
    mine = await ok(await client.get("/api/porch/me/highlights", headers=H(ann)))
    assert mine[0]["count"] == 3 and mine[0]["mine"] is True
    # Expired stories aren't live for anyone but Ann…
    assert (await client.get(f"/api/porch/stories/{f1['id']}", headers=H(mum))).status_code == 404
    assert (await ok(await client.get(f"/api/porch/stories/u/{ann.id}", headers=H(mum))))["stories"] == []
    # …and a highlight marks nothing seen.
    seen = (await db.execute(text("SELECT count(*) FROM porch_story_views"))).scalar()
    assert seen == 0

    # Leaving Family: Mum's view of the highlight goes at once.
    await ok(await client.delete(f"/api/porch/groups/{fam}/members/{mum.id}", headers=H(mum)), 204)
    assert await highlights(client, mum, ann) == []


async def test_deleting_and_editing(client, db, people):
    ann, bob, cat, _ = people
    fam = await members_of(client, ann, "Family", [bob])
    a = await story(client, ann, [fam], text="One")
    b = await story(client, ann, [fam], text="Two")
    theirs = await story(client, bob, [fam], text="Bob's")
    # Only your own stories.
    r = await client.post("/api/porch/me/highlights", headers=H(ann), json={"name": "Mixed", "story_ids": [a["id"], theirs["id"]]})
    assert r.status_code == 404
    h = await ok(await client.post("/api/porch/me/highlights", headers=H(ann), json={"name": "Ours", "story_ids": [a["id"]]}), 201)
    h = await ok(await client.post(f"/api/porch/me/highlights/{h['id']}/stories", headers=H(ann), json={"story_id": b["id"]}))
    assert [s["text"] for s in h["stories"]] == ["One", "Two"]
    # Someone else can't touch it.
    assert (await client.patch(f"/api/porch/me/highlights/{h['id']}", headers=H(bob), json={"name": "Mine now"})).status_code == 404
    h = await ok(await client.patch(f"/api/porch/me/highlights/{h['id']}", headers=H(ann), json={"name": "Family", "story_ids": [b["id"], a["id"]], "cover_story_id": b["id"]}))
    assert h["name"] == "Family" and [s["text"] for s in h["stories"]] == ["Two", "One"] and h["cover"]["story_id"] == b["id"]
    bad = await client.patch(f"/api/porch/me/highlights/{h['id']}", headers=H(ann), json={"cover_story_id": theirs["id"]})
    assert bad.status_code == 400

    # Deleting a story takes it out; the last one takes the highlight with it.
    await ok(await client.delete(f"/api/porch/stories/{a['id']}", headers=H(ann)), 204)
    left = await ok(await client.get("/api/porch/me/highlights", headers=H(ann)))
    assert [s["text"] for s in left[0]["stories"]] == ["Two"]
    out = await ok(await client.delete(f"/api/porch/me/highlights/{h['id']}/stories/{b['id']}", headers=H(ann)))
    assert out["deleted"] is True
    assert await ok(await client.get("/api/porch/me/highlights", headers=H(ann))) == []
    # The story's still in the archive.
    arch = await ok(await client.get("/api/porch/stories/archive", headers=H(ann)))
    assert [s["text"] for s in arch["stories"]] == ["Two"]

    h2 = await ok(await client.post("/api/porch/me/highlights", headers=H(ann), json={"name": "Again", "story_ids": [b["id"]]}), 201)
    await ok(await client.delete(f"/api/porch/stories/{b['id']}", headers=H(ann)), 204)
    assert await ok(await client.get("/api/porch/me/highlights", headers=H(ann))) == []
    assert (await client.delete(f"/api/porch/me/highlights/{h2['id']}", headers=H(ann))).status_code == 404


async def test_old_story_links_work_only_where_a_highlight_shows_it(client, db, people):
    ann, mum, mate, _ = people
    fam = await members_of(client, ann, "Family", [mum])
    await members_of(client, ann, "The Lads", [mate])
    fid = await photo(client, ann, "beach.jpg")
    s = await story(client, ann, [fam], kind="photo", file_id=fid)
    other = await story(client, ann, [fam], kind="photo", file_id=fid)
    await ok(await client.post("/api/porch/me/highlights", headers=H(ann), json={"name": "Beach", "story_ids": [s["id"]]}), 201)
    links = {sid: (await ok(await client.get(f"/api/porch/stories/{sid}", headers=H(mum))))["media"]["preview"] for sid in (s["id"], other["id"])}
    await expire_all(db)
    # In a highlight Mum can see: still loads. Not in one: ended.
    assert (await client.get(mpath(links[s["id"]]))).status_code == 200
    assert (await client.get(mpath(links[other["id"]]))).status_code == 404
    shown = (await highlights(client, mum, ann))[0]["stories"][0]["media"]["preview"]
    assert (await client.get(mpath(shown))).status_code == 200
    # Someone outside the story's groups never gets one.
    assert await highlights(client, mate, ann) == []
    from app.files import media_urls

    forged = media_urls.sign(uuid.UUID(s["id"]), mate.id, mate.token_version, "porch_story_preview", 1)
    assert (await client.get(mpath(forged))).status_code == 404


async def test_export_lists_highlights(client, db, people):
    from app.porch.export import porch_json

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    a = await story(client, ann, [fam], text="Kept")
    await ok(await client.post("/api/porch/me/highlights", headers=H(ann), json={"name": "Keep", "story_ids": [a["id"]]}), 201)
    out = await porch_json(db, ann, {}, "")
    assert out["highlights"] == [{"name": "Keep", "stories": [a["id"]]}]
