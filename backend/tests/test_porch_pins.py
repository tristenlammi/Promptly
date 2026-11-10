"""Pinned posts (WP-P3.1): group admins only (Everyone: the server admins),
three at most ("Unpin one first"), the post must be in the group, the
group page only (never the feed), and a pin lives and dies with its
post-group row (the post deleted or taken out of the group, the group
deleted). A blocked author's pin is hidden from the blocker."""
from __future__ import annotations

from tests.porch_kit import H, client, everyone_id, feed_ids, members_of, ok, people, quiet, root, say  # noqa: F401 — fixtures


async def pins(client, u, gid) -> list[str]:
    return [p["id"] for p in await ok(await client.get(f"/api/porch/groups/{gid}/pins", headers=H(u)))]


async def test_admins_pin_up_to_three_on_the_group_page_only(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, bob, "Family", [ann, cat])  # Bob owns Family
    posts = [await say(client, cat, [fam], f"Post {i}") for i in range(4)]
    # Only the group's admins pin; members and outsiders can't.
    assert (await client.put(f"/api/porch/groups/{fam}/pins/{posts[0]['id']}", headers=H(cat))).status_code == 403
    assert (await client.put(f"/api/porch/groups/{fam}/pins/{posts[0]['id']}", headers=H(dan))).status_code == 404
    for p in posts[:3]:
        await ok(await client.put(f"/api/porch/groups/{fam}/pins/{p['id']}", headers=H(bob)))
    # Pinning again is fine; a fourth isn't.
    await ok(await client.put(f"/api/porch/groups/{fam}/pins/{posts[0]['id']}", headers=H(bob)))
    r = await client.put(f"/api/porch/groups/{fam}/pins/{posts[3]['id']}", headers=H(bob))
    assert r.status_code == 400 and "Unpin one first" in r.json()["detail"]
    # Every member sees them (latest pinned first); the feed is untouched.
    assert set(await pins(client, cat, fam)) == {p["id"] for p in posts[:3]}
    assert await feed_ids(client, cat) == [p["id"] for p in reversed(posts)]
    assert (await client.get(f"/api/porch/groups/{fam}/pins", headers=H(dan))).status_code == 404
    # The post says who can pin it where (only the groups you run).
    mine = await ok(await client.get(f"/api/porch/posts/{posts[0]['id']}", headers=H(bob)))
    assert [(g["name"], g["pinned"]) for g in mine["pin_groups"]] == [("Family", True)]
    theirs = await ok(await client.get(f"/api/porch/posts/{posts[0]['id']}", headers=H(cat)))
    assert theirs["pin_groups"] == []
    # Unpin makes room.
    await ok(await client.delete(f"/api/porch/groups/{fam}/pins/{posts[1]['id']}", headers=H(bob)))
    await ok(await client.put(f"/api/porch/groups/{fam}/pins/{posts[3]['id']}", headers=H(bob)))
    assert (await pins(client, cat, fam))[0] == posts[3]["id"]


async def test_a_pin_lives_and_dies_with_the_post_in_the_group(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, bob, "Family", [ann, cat])
    lads = await members_of(client, cat, "The Lads", [dan])
    other = await say(client, cat, [lads], "Only in the Lads")
    # Not in the group: can't be pinned there.
    assert (await client.put(f"/api/porch/groups/{fam}/pins/{other['id']}", headers=H(bob))).status_code in (400, 404)
    p = await say(client, cat, [fam], "Pinned then deleted")
    await ok(await client.put(f"/api/porch/groups/{fam}/pins/{p['id']}", headers=H(bob)))
    await ok(await client.delete(f"/api/porch/posts/{p['id']}", headers=H(cat)), 204)
    assert await pins(client, bob, fam) == []
    # A deleted post's pin doesn't count towards the three.
    for i in range(3):
        q = await say(client, cat, [fam], f"Keep {i}")
        await ok(await client.put(f"/api/porch/groups/{fam}/pins/{q['id']}", headers=H(bob)))
    assert len(await pins(client, bob, fam)) == 3

    # A blocked author's pin is hidden from the blocker, like the post.
    await ok(await client.put(f"/api/people/blocks/{cat.id}", headers=H(ann)))
    assert await pins(client, ann, fam) == []
    assert len(await pins(client, bob, fam)) == 3

    # The group deleted: its pins go with it.
    await ok(await client.delete(f"/api/porch/groups/{fam}", headers=H(bob)), 204)
    assert (await client.get(f"/api/porch/groups/{fam}/pins", headers=H(bob))).status_code == 404


async def test_everyone_is_pinned_by_the_server_admins(client, db, people):
    ann, bob, cat, dan = people  # Ann is a server admin
    ev = await everyone_id(client, ann)
    p = await say(client, bob, [ev], "For everyone")
    assert (await client.put(f"/api/porch/groups/{ev}/pins/{p['id']}", headers=H(cat))).status_code == 403
    await ok(await client.put(f"/api/porch/groups/{ev}/pins/{p['id']}", headers=H(ann)))
    assert await pins(client, dan, ev) == [p["id"]]
    seen = await ok(await client.get(f"/api/porch/posts/{p['id']}", headers=H(ann)))
    assert [g["kind"] for g in seen["pin_groups"]] == ["everyone"]
