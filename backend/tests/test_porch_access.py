"""Porch: who can see what (``app/porch/access.py``, the one definition).

The matrix from the plan: member of one / several / none of a post's
groups × a block either way × a deleted post × Porch off for the viewer;
the SQL twin agrees with the Python form; a private group is a 404 from
outside everywhere; joining shows a group's history and leaving hides it
at once."""
from __future__ import annotations

import itertools
import uuid

from sqlalchemy import text

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, accept, boot, client, everyone_id, feed_ids, group, members_of, ok, people, quiet, root, say, sees, set_porch,
)


async def _block(client, a, b):
    await ok(await client.put(f"/api/people/blocks/{b.id}", headers=H(a)))


async def _unblock(client, a, b):
    await ok(await client.delete(f"/api/people/blocks/{b.id}", headers=H(a)))


async def _sql_sees(db, user, post_id) -> bool:
    from app.porch.access import visible_post_sql

    q = text(f"SELECT EXISTS (SELECT 1 FROM porch_posts p WHERE p.id = :pid AND {visible_post_sql('p')})")
    return bool((await db.execute(q, {"pid": uuid.UUID(post_id), "me": user.id})).scalar())


async def _py_sees(db, user, post_id) -> bool:
    from app.porch.access import can_see_post

    return await can_see_post(db, user, uuid.UUID(post_id))


async def test_the_matrix_groups_blocks_deleted_and_porch_off(client, db, people):
    ann, bob, cat, dan = people
    for u in people:
        await boot(client, u)
    family = await members_of(client, ann, "Family", [bob])
    lads = await members_of(client, ann, "The Lads", [cat])
    ev = await everyone_id(client, ann)

    p_family = (await say(client, ann, [family], "grandkids"))["id"]
    p_both = (await say(client, ann, [family, lads], "BBQ Saturday"))["id"]
    p_lads = (await say(client, ann, [lads], "fishing trip"))["id"]
    p_all = (await say(client, ann, [ev], "hello server"))["id"]
    posts = {"family": p_family, "both": p_both, "lads": p_lads, "all": p_all}

    async def visible(u) -> set[str]:
        out = set()
        for name, pid in posts.items():
            got = await sees(client, u, pid)
            # The SQL twin and the Python form say the same thing.
            assert await _sql_sees(db, u, pid) == got == await _py_sees(db, u, pid), (u.username, name)
            if got:
                out.add(name)
        return out

    # Member of one / several / none of a post's groups; the author sees all.
    assert await visible(ann) == {"family", "both", "lads", "all"}
    assert await visible(bob) == {"family", "both", "all"}
    assert await visible(cat) == {"both", "lads", "all"}
    assert await visible(dan) == {"all"}

    # A block, either way, hides both people's posts from each other.
    await _block(client, ann, bob)
    assert await visible(bob) == set()
    bobs = (await say(client, bob, [family], "from bob"))["id"]
    assert not await sees(client, ann, bobs)
    assert await sees(client, bob, bobs)
    await _unblock(client, ann, bob)
    assert await visible(bob) == {"family", "both", "all"} and await sees(client, ann, bobs)
    await _block(client, cat, ann)  # the other way round
    assert await visible(cat) == set()
    await _unblock(client, cat, ann)

    # Deleted: gone for everyone, the author included.
    await ok(await client.delete(f"/api/porch/posts/{p_family}", headers=H(ann)), 204)
    assert "family" not in await visible(ann) and "family" not in await visible(bob)

    # Porch off for the server: every route is a 404, and nothing is visible.
    await set_porch(db, porch_enabled=False)
    for u in (ann, bob):
        assert (await client.get(f"/api/porch/posts/{p_all}", headers=H(u))).status_code == 404
        assert (await client.get("/api/porch/feed", headers=H(u))).status_code == 404
        assert not await _py_sees(db, u, p_all)
    await set_porch(db, porch_enabled=True)

    # Porch on only for a user group: Cat isn't in it.
    from app.groups.models import UserGroup, UserGroupMember

    ug = UserGroup(name="Family")
    db.add(ug)
    await db.flush()
    for u in (ann, bob):
        db.add(UserGroupMember(group_id=ug.id, user_id=u.id))
    await db.commit()
    await set_porch(db, porch_user_group_ids=[str(ug.id)])
    assert await sees(client, bob, p_all)
    assert (await client.get(f"/api/porch/posts/{p_all}", headers=H(cat))).status_code == 404
    assert (await client.get("/api/porch/bootstrap", headers=H(cat))).status_code == 404
    assert not await _py_sees(db, cat, p_all)
    # …and Everyone is only the people Porch is on for.
    assert (await boot(client, ann))["everyone"]["member_count"] == 2


async def test_feed_and_lists_never_widen_the_rule(client, db, people):
    ann, bob, cat, dan = people
    family = await members_of(client, ann, "Family", [bob])
    lads = await members_of(client, ann, "The Lads", [cat])
    p1 = (await say(client, ann, [family], "family only"))["id"]
    p2 = (await say(client, ann, [lads], "lads only"))["id"]
    assert set(await feed_ids(client, bob)) == {p1}
    assert set(await feed_ids(client, cat)) == {p2}
    assert await feed_ids(client, dan) == []
    # A profile shows only what the viewer may see.
    got = await ok(await client.get(f"/api/porch/users/{ann.id}/posts", headers=H(bob)))
    assert [p["id"] for p in got["posts"]] == [p1]


async def test_a_private_group_is_invisible_from_outside(client, db, people):
    ann, bob, cat, dan = people
    family = await members_of(client, ann, "Family", [bob])
    lads = await members_of(client, ann, "The Lads", [cat])
    both = (await say(client, ann, [family, lads], "BBQ"))["id"]

    # By direct id: a 404, the same as a group that doesn't exist.
    for path in ("", "/posts", "/members"):
        r = await client.get(f"/api/porch/groups/{family}{path}", headers=H(dan))
        assert r.status_code == 404, path
        assert r.json() == (await client.get(f"/api/porch/groups/{uuid.uuid4()}{path}", headers=H(dan))).json()
    assert (await client.post(f"/api/porch/groups/{family}/join", headers=H(dan))).status_code == 404
    # Not in discover, nor in search of the people picker.
    assert all(g["id"] != family for g in await ok(await client.get("/api/porch/groups/discover", headers=H(dan))))
    assert (await client.get("/api/porch/people", headers=H(cat), params={"groups": family})).status_code == 404
    # On a post, Cat sees only her own group's label — never "Family".
    got = await ok(await client.get(f"/api/porch/posts/{both}", headers=H(cat)))
    assert [g["name"] for g in got["groups"]] == ["The Lads"]
    assert "Family" not in str(got)
    # On a profile, only the groups you share.
    prof = await ok(await client.get(f"/api/porch/users/{ann.id}", headers=H(cat)))
    assert [g["name"] for g in prof["shared_groups"]] == ["The Lads"]
    prof = await ok(await client.get(f"/api/porch/users/{ann.id}", headers=H(bob)))
    assert [g["name"] for g in prof["shared_groups"]] == ["Family"]
    # A mention picker for the post lists only who can see it.
    names = {p["id"] for p in await ok(await client.get("/api/porch/people", headers=H(bob), params={"post": both}))}
    assert names == {str(ann.id), str(cat.id)}
    names = {p["id"] for p in await ok(await client.get("/api/porch/people", headers=H(ann), params={"groups": family}))}
    assert names == {str(bob.id)}


async def test_joining_shows_history_and_leaving_hides_it_at_once(client, db, people):
    ann, bob, cat, dan = people
    fishing = await group(client, ann, "Fishing", "public")
    old = (await say(client, ann, [fishing], "big one last year"))["id"]
    # Public, not joined: the outline, not the posts.
    outline = await ok(await client.get(f"/api/porch/groups/{fishing}", headers=H(dan)))
    assert outline["view"] == "outline" and outline["member_count"] == 1 and outline["admins"][0]["id"] == str(ann.id)
    assert (await client.get(f"/api/porch/groups/{fishing}/posts", headers=H(dan))).status_code == 403
    assert not await sees(client, dan, old)

    await ok(await client.post(f"/api/porch/groups/{fishing}/join", headers=H(dan)))
    assert await sees(client, dan, old)
    assert old in await feed_ids(client, dan)  # ticked from the start
    page = await ok(await client.get(f"/api/porch/groups/{fishing}/posts", headers=H(dan)))
    assert [p["id"] for p in page["posts"]] == [old]

    await ok(await client.delete(f"/api/porch/groups/{fishing}/members/{dan.id}", headers=H(dan)), 204)
    assert not await sees(client, dan, old)
    assert old not in await feed_ids(client, dan)


async def test_everyone_is_implicit_for_new_people(client, db, people):
    from tests.porch_kit import mk_user

    ann = people[0]
    ev = await everyone_id(client, ann)
    hello = (await say(client, ann, [ev], "welcome"))["id"]
    newbie = await mk_user(db, "newbie")
    # No bootstrap, no row: already in Everyone, and sees its posts.
    assert await sees(client, newbie, hello)
    assert hello in await feed_ids(client, newbie)


async def test_sql_twin_matches_over_every_pair(client, db, people):
    ann, bob, cat, dan = people
    family = await members_of(client, ann, "Family", [bob])
    pub = await members_of(client, cat, "Open", [dan], "public")
    pids = [
        (await say(client, ann, [family], "a"))["id"],
        (await say(client, cat, [pub], "b"))["id"],
        (await say(client, bob, [family], "c"))["id"],
    ]
    await _block(client, dan, cat)
    await ok(await client.delete(f"/api/porch/groups/{family}", headers=H(ann)), 204)
    for u, pid in itertools.product(people, pids):
        assert await _sql_sees(db, u, pid) == await _py_sees(db, u, pid), (u.username, pid)
