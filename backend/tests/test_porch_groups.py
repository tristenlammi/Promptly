"""Porch groups: roles, invites that need accepting, instant public joins,
the owner who can't leave without handing on, removed people who can't
rejoin by themselves, "Members can invite", deleting a group, and the
built-in Everyone (implicit, unleavable, run by the server admins)."""
from __future__ import annotations

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, accept, boot, client, everyone_id, feed_ids, group, members_of, mk_user, ok, people, quiet, root, say, sees, set_porch,
)


async def _groups(client, u) -> dict:
    return await ok(await client.get("/api/porch/groups", headers=H(u)))


async def test_a_new_group_is_private_and_invites_need_accepting(client, db, people):
    ann, bob, cat, dan = people
    gid = await group(client, ann, "Family", invite=[bob])
    me = (await _groups(client, ann))["groups"]
    assert [g["name"] for g in me] == ["Everyone", "Family"]
    fam = me[1]
    assert fam["visibility"] == "private" and fam["role"] == "owner" and fam["is_owner"] and fam["in_feed"] is True
    assert fam["member_count"] == 1  # Bob hasn't said yes

    # Bob sees the invite (the outline and who asked), not the group's posts.
    inv = (await _groups(client, bob))["invites"]
    assert [i["id"] for i in inv] == [gid] and inv[0]["invited_by"]["id"] == str(ann.id) and inv[0]["view"] == "invited"
    assert [g["name"] for g in (await _groups(client, bob))["groups"]] == ["Everyone"]
    secret = (await say(client, ann, [gid], "family news"))["id"]
    assert not await sees(client, bob, secret)
    assert (await client.get(f"/api/porch/groups/{gid}/posts", headers=H(bob))).status_code == 403

    got = await accept(client, bob, gid)
    assert got["view"] == "member" and got["in_feed"] is True and got["member_count"] == 2
    assert await sees(client, bob, secret) and secret in await feed_ids(client, bob)
    assert (await _groups(client, bob))["invites"] == []
    # Accepting twice: there's no invite any more.
    assert (await client.post(f"/api/porch/groups/{gid}/accept", headers=H(bob))).status_code == 404

    # Declining: no membership, and the private group is a 404 again.
    await ok(await client.post(f"/api/porch/groups/{gid}/invites", headers=H(ann), json={"user_ids": [str(cat.id)]}))
    await ok(await client.post(f"/api/porch/groups/{gid}/decline", headers=H(cat)), 204)
    assert (await client.get(f"/api/porch/groups/{gid}", headers=H(cat))).status_code == 404
    # Nobody is dropped in: an invite to someone outside never makes a member.
    assert (await ok(await client.get(f"/api/porch/groups/{gid}", headers=H(ann))))["member_count"] == 2


async def test_only_admins_invite_unless_members_can(client, db, people):
    ann, bob, cat, dan = people
    gid = await members_of(client, ann, "Family", [bob])
    r = await client.post(f"/api/porch/groups/{gid}/invites", headers=H(bob), json={"user_ids": [str(cat.id)]})
    assert r.status_code == 403
    await ok(await client.patch(f"/api/porch/groups/{gid}", headers=H(ann), json={"members_can_invite": True}))
    got = await ok(await client.post(f"/api/porch/groups/{gid}/invites", headers=H(bob), json={"user_ids": [str(cat.id)]}))
    assert got["invited"] == [str(cat.id)]
    # Admins see who's waiting, and can cancel.
    waiting = await ok(await client.get(f"/api/porch/groups/{gid}/invites", headers=H(ann)))
    assert [w["user"]["id"] for w in waiting] == [str(cat.id)] and waiting[0]["invited_by"]["id"] == str(bob.id)
    assert (await client.get(f"/api/porch/groups/{gid}/invites", headers=H(bob))).status_code == 403
    await ok(await client.delete(f"/api/porch/groups/{gid}/invites/{cat.id}", headers=H(ann)), 204)
    assert (await _groups(client, cat))["invites"] == []
    # Members can't edit the group.
    assert (await client.patch(f"/api/porch/groups/{gid}", headers=H(bob), json={"name": "Mine"})).status_code == 403


async def test_roles_owner_admins_and_handing_on(client, db, people):
    ann, bob, cat, dan = people
    gid = await members_of(client, ann, "Family", [bob, cat, dan])
    # Only the owner makes admins.
    assert (await client.patch(f"/api/porch/groups/{gid}/members/{cat.id}", headers=H(bob), json={"role": "admin"})).status_code == 403
    await ok(await client.patch(f"/api/porch/groups/{gid}/members/{bob.id}", headers=H(ann), json={"role": "admin"}))
    # An admin edits, and removes members — but not other admins or the owner.
    await ok(await client.patch(f"/api/porch/groups/{gid}", headers=H(bob), json={"about": "Us lot", "emoji": "🏡"}))
    await ok(await client.delete(f"/api/porch/groups/{gid}/members/{dan.id}", headers=H(bob)), 204)
    assert (await client.delete(f"/api/porch/groups/{gid}/members/{ann.id}", headers=H(bob))).status_code == 403
    await ok(await client.patch(f"/api/porch/groups/{gid}/members/{cat.id}", headers=H(ann), json={"role": "admin"}))
    assert (await client.delete(f"/api/porch/groups/{gid}/members/{cat.id}", headers=H(bob))).status_code == 403
    # Members are listed owner first, with roles.
    mem = await ok(await client.get(f"/api/porch/groups/{gid}/members", headers=H(cat)))
    assert [(m["id"], m["role"]) for m in mem] == [(str(ann.id), "owner"), (str(bob.id), "admin"), (str(cat.id), "admin")]

    # The owner can't leave without handing on.
    r = await client.delete(f"/api/porch/groups/{gid}/members/{ann.id}", headers=H(ann))
    assert r.status_code == 400 and "owner" in r.json()["detail"]
    # Only the owner hands on or deletes.
    assert (await client.post(f"/api/porch/groups/{gid}/transfer", headers=H(bob), json={"user_id": str(cat.id)})).status_code == 403
    assert (await client.post(f"/api/porch/groups/{gid}/transfer", headers=H(ann), json={"user_id": str(dan.id)})).status_code == 400
    await ok(await client.post(f"/api/porch/groups/{gid}/transfer", headers=H(ann), json={"user_id": str(cat.id)}))
    g = await ok(await client.get(f"/api/porch/groups/{gid}", headers=H(cat)))
    assert g["is_owner"] and g["role"] == "owner"
    assert (await ok(await client.get(f"/api/porch/groups/{gid}", headers=H(ann))))["role"] == "admin"
    await ok(await client.delete(f"/api/porch/groups/{gid}/members/{ann.id}", headers=H(ann)), 204)
    assert (await client.get(f"/api/porch/groups/{gid}", headers=H(ann))).status_code == 404  # private, and out
    assert (await client.delete(f"/api/porch/groups/{gid}", headers=H(bob))).status_code == 403


async def test_alone_owner_is_told_to_delete_instead(client, db, people):
    ann = people[0]
    gid = await group(client, ann, "Just me")
    r = await client.delete(f"/api/porch/groups/{gid}/members/{ann.id}", headers=H(ann))
    assert r.status_code == 400 and "Delete the group" in r.json()["detail"]


async def test_public_groups_join_at_once_and_removed_people_need_an_invite(client, db, people):
    ann, bob, cat, dan = people
    gid = await group(client, ann, "Fishing", "public", about="Bream and flathead")
    found = await ok(await client.get("/api/porch/groups/discover", headers=H(bob)))
    assert [g["name"] for g in found] == ["Fishing"] and found[0]["about"] == "Bream and flathead"
    assert (await ok(await client.get("/api/porch/groups/discover", headers=H(bob), params={"q": "bream"})))[0]["id"] == gid
    assert await ok(await client.get("/api/porch/groups/discover", headers=H(bob), params={"q": "knitting"})) == []
    assert await ok(await client.get("/api/porch/groups/discover", headers=H(ann))) == []  # already in it

    joined = await ok(await client.post(f"/api/porch/groups/{gid}/join", headers=H(bob)))
    assert joined["view"] == "member" and joined["in_feed"] is True and joined["role"] == "member"
    await ok(await client.post(f"/api/porch/groups/{gid}/join", headers=H(bob)))  # idempotent

    # Removed: can't come back alone, and it's no longer offered.
    await ok(await client.delete(f"/api/porch/groups/{gid}/members/{bob.id}", headers=H(ann)), 204)
    r = await client.post(f"/api/porch/groups/{gid}/join", headers=H(bob))
    assert r.status_code == 403 and "invite" in r.json()["detail"]
    assert await ok(await client.get("/api/porch/groups/discover", headers=H(bob))) == []
    # The outline is still there (it's public); an invite brings them back.
    assert (await ok(await client.get(f"/api/porch/groups/{gid}", headers=H(bob))))["view"] == "outline"
    await ok(await client.post(f"/api/porch/groups/{gid}/invites", headers=H(ann), json={"user_ids": [str(bob.id)]}))
    assert (await accept(client, bob, gid))["view"] == "member"

    # Leaving by yourself isn't a removal: you can join again.
    await ok(await client.delete(f"/api/porch/groups/{gid}/members/{cat.id}", headers=H(cat)), 404)
    await ok(await client.post(f"/api/porch/groups/{gid}/join", headers=H(cat)))
    await ok(await client.delete(f"/api/porch/groups/{gid}/members/{cat.id}", headers=H(cat)), 204)
    await ok(await client.post(f"/api/porch/groups/{gid}/join", headers=H(cat)))

    # Going private hides it from everyone outside.
    await ok(await client.patch(f"/api/porch/groups/{gid}", headers=H(ann), json={"visibility": "private"}))
    assert await ok(await client.get("/api/porch/groups/discover", headers=H(dan))) == []
    assert (await client.get(f"/api/porch/groups/{gid}", headers=H(dan))).status_code == 404


async def test_deleting_a_group_leaves_single_group_posts_to_their_authors(client, db, people):
    ann, bob, cat, dan = people
    gid = await members_of(client, ann, "Book club", [bob, cat])
    other = await members_of(client, ann, "Family", [cat])
    only_here = (await say(client, bob, [gid], "chapter 3?"))["id"]
    also_elsewhere = (await say(client, cat, [gid, other], "loved it"))["id"]
    assert (await client.delete(f"/api/porch/groups/{gid}", headers=H(bob))).status_code == 403
    await ok(await client.delete(f"/api/porch/groups/{gid}", headers=H(ann)), 204)

    assert await sees(client, bob, only_here)  # the author alone
    assert not await sees(client, ann, only_here) and not await sees(client, cat, only_here)
    assert await sees(client, ann, also_elsewhere) and await sees(client, cat, also_elsewhere)
    assert not await sees(client, bob, also_elsewhere)
    got = await ok(await client.get(f"/api/porch/posts/{also_elsewhere}", headers=H(ann)))
    assert [g["name"] for g in got["groups"]] == ["Family"]
    assert (await client.get(f"/api/porch/groups/{gid}", headers=H(ann))).status_code == 404
    assert [g["name"] for g in (await _groups(client, bob))["groups"]] == ["Everyone"]


async def test_everyone_is_built_in_unleavable_and_run_by_server_admins(client, db, people):
    ann, bob, cat, dan = people  # ann is a server admin
    ev = await everyone_id(client, bob)
    first = (await _groups(client, bob))["groups"][0]
    assert first["kind"] == "everyone" and first["name"] == "Everyone" and first["member_count"] == 4
    assert first["role"] == "member" and not first["is_admin"]
    assert [a["id"] for a in first["admins"]] == [str(ann.id)]
    # Nobody can leave it, be invited to it, or delete it.
    r = await client.delete(f"/api/porch/groups/{ev}/members/{bob.id}", headers=H(bob))
    assert r.status_code == 400 and "Untick" in r.json()["detail"]
    assert (await client.post(f"/api/porch/groups/{ev}/invites", headers=H(ann), json={"user_ids": [str(bob.id)]})).status_code == 400
    assert (await client.delete(f"/api/porch/groups/{ev}", headers=H(ann))).status_code == 400
    # Only a server admin renames it, and it stays public.
    assert (await client.patch(f"/api/porch/groups/{ev}", headers=H(bob), json={"name": "Us"})).status_code == 403
    got = await ok(await client.patch(f"/api/porch/groups/{ev}", headers=H(ann), json={"name": "Lammi Clan"}))
    assert got["name"] == "Lammi Clan"
    assert (await client.patch(f"/api/porch/groups/{ev}", headers=H(ann), json={"visibility": "private"})).status_code == 400
    # Unticking hides it from the feed but not from its page.
    hello = (await say(client, ann, [ev], "hi all"))["id"]
    await ok(await client.patch(f"/api/porch/groups/{ev}/me", headers=H(bob), json={"in_feed": False}))
    assert hello not in await feed_ids(client, bob)
    page = await ok(await client.get(f"/api/porch/groups/{ev}/posts", headers=H(bob)))
    assert [p["id"] for p in page["posts"]] == [hello]
    assert (await boot(client, bob))["groups"][0]["in_feed"] is False
    # Its member list is everyone with Porch.
    mem = await ok(await client.get(f"/api/porch/groups/{ev}/members", headers=H(dan)))
    assert {m["id"] for m in mem} == {str(u.id) for u in people}
    assert next(m for m in mem if m["id"] == str(ann.id))["role"] == "admin"


async def test_feed_ticks_and_bells_are_saved(client, db, people):
    ann, bob, *_ = people
    gid = await members_of(client, ann, "Family", [bob])
    got = await ok(await client.patch(f"/api/porch/groups/{gid}/me", headers=H(bob), json={"in_feed": False, "notify": "all"}))
    assert got == {"group_id": gid, "in_feed": False, "notify": "all"}
    fam = next(g for g in (await boot(client, bob))["groups"] if g["id"] == gid)
    assert fam["in_feed"] is False and fam["notify"] == "all"
    assert (await client.patch(f"/api/porch/groups/{gid}/me", headers=H(bob), json={"notify": "loud"})).status_code == 422


async def test_invites_skip_blocked_people_and_people_without_porch(client, db, people):
    from app.groups.models import UserGroup, UserGroupMember

    ann, bob, cat, dan = people
    await ok(await client.put(f"/api/people/blocks/{ann.id}", headers=H(dan)))
    ug = UserGroup(name="Porch people")
    db.add(ug)
    await db.flush()
    for u in (ann, bob, dan):
        db.add(UserGroupMember(group_id=ug.id, user_id=u.id))
    await db.commit()
    await set_porch(db, porch_user_group_ids=[str(ug.id)])
    gid = await group(client, ann, "Family")
    got = await ok(await client.post(f"/api/porch/groups/{gid}/invites", headers=H(ann), json={"user_ids": [str(bob.id), str(cat.id), str(dan.id)]}))
    assert got["invited"] == [str(bob.id)]
    # The people picker never offers them either.
    names = {p["id"] for p in await ok(await client.get("/api/porch/people", headers=H(ann), params={"q": "a"}))}
    assert names == set()  # 2+ letters
    found = {p["id"] for p in await ok(await client.get("/api/porch/people", headers=H(ann), params={"q": cat.username[:3]}))}
    assert str(cat.id) not in found
    found = {p["id"] for p in await ok(await client.get("/api/porch/people", headers=H(ann), params={"q": bob.username[:3]}))}
    assert str(bob.id) in found


async def test_bootstrap_makes_your_profile_and_everyone_settings(client, db, people):
    from app.porch.models import PorchGroupMember, PorchProfile

    ann = people[0]
    got = await boot(client, ann)
    assert got["me"]["id"] == str(ann.id) and got["me"]["is_admin"] is True
    assert got["everyone"]["name"] == "Everyone" and got["limits"]["max_media"] == 20
    assert got["profile"]["welcomed"] is False and got["invites"] == []
    assert await db.get(PorchProfile, ann.id) is not None
    assert await db.get(PorchGroupMember, (__import__("uuid").UUID(got["everyone"]["id"]), ann.id)) is not None
    prof = await ok(await client.patch("/api/porch/me/profile", headers=H(ann), json={"bio": "Dad of 3", "birthday": "1990-04-02", "welcomed": True}))
    assert prof["bio"] == "Dad of 3" and prof["welcomed"] is True and prof["show_birthday"] is False
    # Birthday shown only if they choose.
    bob = people[1]
    assert (await ok(await client.get(f"/api/porch/users/{ann.id}", headers=H(bob))))["birthday"] is None
    await ok(await client.patch("/api/porch/me/profile", headers=H(ann), json={"show_birthday": True}))
    assert (await ok(await client.get(f"/api/porch/users/{ann.id}", headers=H(bob))))["birthday"] == "1990-04-02"
    # A blocked person's profile is a 404 both ways.
    await ok(await client.put(f"/api/people/blocks/{bob.id}", headers=H(ann)))
    assert (await client.get(f"/api/porch/users/{ann.id}", headers=H(bob))).status_code == 404
    assert (await client.get(f"/api/porch/users/{bob.id}", headers=H(ann))).status_code == 404
