"""Porch reports go to the group's admins (WP-P2.0).

The rule: a server admin sees another person's Porch content only as a
normal member who can see it. A report is made in a group the reporter sees
the post through and goes to that group's owner and admins; only reports
made in Everyone go to the server admins, and only for things they can see.
A server admin outside a private group sees nothing of it: not in the
queue, not its photos, and can't decide on it. "Remove from <group>" takes
the post out of that group only. Whoever handles a report sees the reason,
never who made it.
"""
from __future__ import annotations

import json
import uuid

from tests.porch_kit import H, boot, client, everyone_id, members_of, mpath, ok, people, photo, post_photos, quiet, root, say, sees  # noqa: F401 — fixtures
from tests.test_porch_push import devices, porch_for, pushes  # noqa: F401 — fixtures


async def report(client, u, target_id, groups=None, reason="", target_type="post", code=201):
    body = {"target_type": target_type, "target_id": target_id, "reason": reason}
    if groups is not None:
        body["groups"] = [str(g) for g in groups]
    return await ok(await client.post("/api/porch/reports", headers=H(u), json=body), code)


async def group_queue(client, u, gid, status="open"):
    return await ok(await client.get(f"/api/porch/groups/{gid}/reports", headers=H(u), params={"status": status}))


async def admin_queue(client, u, status="open"):
    return await ok(await client.get("/api/admin/porch/reports", headers=H(u), params={"status": status}))


def report_pushes(rec, u) -> list[dict]:
    return [c for c in porch_for(rec, u) if c["extra"]["kind"] == "report"] + [c for c in rec.calls if c["category"] == "system_alert" and c["user_id"] == u.id]


async def test_private_group_report_never_reaches_a_server_admin_outside_it(client, db, people, pushes, devices):
    ann, bob, cat, dan = people  # Ann is the server admin, not in Fam; Cat runs Fam.
    fam = await members_of(client, cat, "Fam", [bob, dan])
    pic = await photo(client, dan)
    made = await post_photos(client, dan, [fam], [pic], body="Family secret")
    pid = made["id"]
    assert not await sees(client, ann, pid)

    pushes.calls.clear()
    rep = await report(client, bob, pid, [fam], "Not kind")
    assert [g["name"] for g in rep["groups"]] == ["Fam"]

    # Ann: nothing. No push, no queue, no count, no group tab, no Activity line.
    assert report_pushes(pushes, ann) == []
    assert await admin_queue(client, ann) == []
    assert await admin_queue(client, ann, "handled") == []
    assert (await ok(await client.get("/api/admin/porch", headers=H(ann))))["open_reports"] == 0
    assert (await client.get(f"/api/porch/groups/{fam}/reports", headers=H(ann))).status_code == 404
    assert (await ok(await client.get("/api/porch/activity", headers=H(ann))))["reports"] == []
    # ...and she can't decide on it, by either route.
    for url in (f"/api/admin/porch/reports/{rep['id']}", f"/api/porch/groups/{fam}/reports/{rep['id']}"):
        r = await client.post(url, headers=H(ann), json={"action": "remove", "reason": "x"})
        assert r.status_code == 404, (url, r.text)
    r = await client.post(f"/api/admin/porch/posts/{pid}/remove-from-everyone", headers=H(ann), json={"reason": "x"})
    assert r.status_code == 404

    # Cat runs Fam: a push that says where, not who or what.
    told = report_pushes(pushes, cat)
    assert len(told) == 1 and told[0]["category"] == "porch"
    assert told[0]["title"] == "Something in Fam was reported" and told[0]["url"] == f"/porch/g/{fam}?tab=reports"
    blob = json.dumps(told[0], default=str)
    assert "Family secret" not in blob and "Not kind" not in blob and str(bob.id) not in blob
    # Only the admins: not Bob or Dan.
    assert report_pushes(pushes, bob) == [] and report_pushes(pushes, dan) == []

    # Cat sees it, with the photo, and only her own groups named.
    q = await group_queue(client, cat, fam)
    assert len(q) == 1 and q[0]["target"]["body"] == "Family secret"
    assert q[0]["target"]["groups"] == {"in_everyone": False, "named": [q[0]["group"]]}
    thumb = q[0]["target"]["media"][0]["thumb"]
    assert (await client.get(mpath(thumb), headers=H(cat))).status_code == 200
    # A photo link made out to Ann (as the old queue did) loads nothing: a
    # reported post's photos go only to people who can see the post.
    from app.porch import media as porch_media

    pm, row, fm = (await porch_media.live_media(db, [uuid.UUID(pid)]))[uuid.UUID(pid)][0]
    for which in ("thumb", "preview", "full"):
        link = porch_media.media_out(ann, pm, row, fm, author=False).get(which)
        assert link, which
        assert (await client.get(mpath(link), headers=H(ann))).status_code == 404, which
    # Her group shows the count; so does her Activity.
    g = await ok(await client.get(f"/api/porch/groups/{fam}", headers=H(cat)))
    assert g["open_reports"] == 1
    act = await ok(await client.get("/api/porch/activity", headers=H(cat)))
    assert [(x["group"]["name"], x["count"]) for x in act["reports"]] == [("Fam", 1)]
    # Members who don't run it can't open the tab.
    assert (await client.get(f"/api/porch/groups/{fam}/reports", headers=H(bob))).status_code == 403
    assert "open_reports" not in await ok(await client.get(f"/api/porch/groups/{fam}", headers=H(bob)))

    # Cat removes it from Fam: it was only there, so it's gone; Dan is told why.
    pushes.calls.clear()
    out = await ok(await client.post(f"/api/porch/groups/{fam}/reports/{rep['id']}", headers=H(cat), json={"action": "remove", "reason": "Keep it kind"}))
    assert out == {"closed": 1, "deleted": True, "status": "removed"}
    assert not await sees(client, bob, pid) and not await sees(client, cat, pid)
    assert (await client.get(mpath(thumb), headers=H(cat))).status_code == 404
    told = porch_for(pushes, dan)
    assert [c["extra"]["kind"] for c in told] == ["removed"]
    assert told[0]["title"] == "Your post was removed from Fam" and "Keep it kind" in told[0]["body"]
    act = await ok(await client.get("/api/porch/activity", headers=H(dan)))
    gone = [i for i in act["items"] if i["kind"] == "removed"]
    assert gone[0]["removed"] == {"scope": "group", "reason": "Keep it kind", "group": "Fam"}
    assert await group_queue(client, cat, fam) == []
    done = await group_queue(client, cat, fam, "handled")
    assert done[0]["status"] == "removed" and done[0]["note"] == "Keep it kind"
    assert await admin_queue(client, ann, "handled") == []


async def test_remove_from_group_leaves_its_other_groups(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    fam = await members_of(client, cat, "Fam", [bob, dan])  # Cat runs Fam
    mates = await members_of(client, bob, "Mates", [dan])  # Bob runs Mates
    pid = (await say(client, dan, [fam, mates], "Both groups"))["id"]

    # Only a group you see it in.
    r = await client.post("/api/porch/reports", headers=H(bob), json={"target_type": "post", "target_id": pid, "groups": [await everyone_id(client, bob)]})
    assert r.status_code == 400
    # Bob reports it in Fam: Cat hears, Bob's own Mates queue stays empty.
    pushes.calls.clear()
    rep = await report(client, bob, pid, [fam], "Not for family")
    assert len(report_pushes(pushes, cat)) == 1 and report_pushes(pushes, bob) == []
    assert await group_queue(client, bob, mates) == []
    # Reporting again in Fam only updates the reason (no second push).
    pushes.calls.clear()
    await report(client, bob, pid, [fam], "Really not for family")
    assert report_pushes(pushes, cat) == []
    q = await group_queue(client, cat, fam)
    assert [x["reason"] for x in q[0]["reports"]] == ["Really not for family"]

    out = await ok(await client.post(f"/api/porch/groups/{fam}/reports/{rep['id']}", headers=H(cat), json={"action": "remove", "reason": "Not here"}))
    assert out["deleted"] is False and out["closed"] == 1
    # Still in Mates: Bob and Dan see it there; Cat (not in Mates) doesn't.
    assert await sees(client, bob, pid) and await sees(client, dan, pid) and not await sees(client, cat, pid)
    got = await ok(await client.get(f"/api/porch/posts/{pid}", headers=H(bob)))
    assert [g["name"] for g in got["groups"]] == ["Mates"]
    # The author can still delete it everywhere.
    await ok(await client.delete(f"/api/porch/posts/{pid}", headers=H(dan)), 204)
    assert not await sees(client, bob, pid)


async def test_everyone_reports_go_to_the_server_admins(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    ev = await everyone_id(client, bob)
    ev_name = (await boot(client, bob))["everyone"]["name"]
    fam = await members_of(client, cat, "Fam", [bob, dan])
    pid = (await say(client, dan, [ev, fam], "For all"))["id"]

    # Bob sees it through both: he picks Everyone.
    pushes.calls.clear()
    rep = await report(client, bob, pid, [ev], "Spam")
    told = report_pushes(pushes, ann)
    assert len(told) == 1 and told[0]["title"] == f"Something in {ev_name} was reported"
    assert report_pushes(pushes, cat) == []
    assert await group_queue(client, cat, fam) == []
    assert (await ok(await client.get("/api/admin/porch", headers=H(ann))))["open_reports"] == 1
    # Ann's queue: Admin → Porch and Everyone's own Reports tab, the same.
    q = await admin_queue(client, ann)
    assert len(q) == 1 and q[0]["target"]["body"] == "For all"
    # Fam isn't hers, so it isn't named.
    assert [g["kind"] for g in q[0]["target"]["groups"]["named"]] == ["everyone"] and "others" not in q[0]["target"]["groups"]
    assert [x["target"]["id"] for x in await group_queue(client, ann, ev)] == [pid]
    # Everyone's tab is the server admins' only.
    assert (await client.get(f"/api/porch/groups/{ev}/reports", headers=H(cat))).status_code == 403

    # Remove: out of Everyone only.
    out = await ok(await client.post(f"/api/admin/porch/reports/{rep['id']}", headers=H(ann), json={"action": "remove", "reason": "Not for everyone"}))
    assert out["deleted"] is False
    assert not await sees(client, ann, pid) and await sees(client, bob, pid)
    assert porch_for(pushes, dan)[-1]["title"] == "Your post was removed from Everyone"
    assert await admin_queue(client, ann) == []


async def test_everyone_report_only_for_admins_who_can_see_it(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    ev = await everyone_id(client, bob)
    pid = (await say(client, dan, [ev], "Hello all"))["id"]
    await ok(await client.put(f"/api/people/blocks/{ann.id}", headers=H(dan)))
    assert not await sees(client, ann, pid)
    await report(client, bob, pid, [ev], "Rude")
    # Ann can't see it (a block), so it isn't shown to her.
    assert await admin_queue(client, ann) == []


async def test_the_reporter_stays_anonymous(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    ev = await everyone_id(client, bob)
    fam = await members_of(client, cat, "Fam", [bob, dan])
    pid = (await say(client, dan, [ev, fam], "Hmm"))["id"]
    await report(client, bob, pid, None, "Bob thinks it's rude")  # no groups: every one he sees it in
    for who, q in ((cat, await group_queue(client, cat, fam)), (ann, await admin_queue(client, ann))):
        assert len(q) == 1, who
        blob = json.dumps(q)
        assert str(bob.id) not in blob and bob.username not in blob
        assert "reporter" not in q[0]["reports"][0]
        assert q[0]["reports"][0]["reason"] == "Bob thinks it's rude"


async def test_a_comment_report_in_a_group(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    fam = await members_of(client, cat, "Fam", [bob, dan])
    pid = (await say(client, bob, [fam], "Holiday"))["id"]
    c = await ok(await client.post(f"/api/porch/posts/{pid}/comments", headers=H(dan), json={"body": "Meh"}), 201)
    rep = await report(client, bob, c["id"], [fam], "Rude", target_type="comment")
    assert await admin_queue(client, ann) == []
    q = await group_queue(client, cat, fam)
    assert q[0]["target"]["type"] == "comment" and q[0]["target"]["body"] == "Meh" and q[0]["target"]["post_body"] == "Holiday"
    # Keep: closed, the comment stays.
    await ok(await client.post(f"/api/porch/groups/{fam}/reports/{rep['id']}", headers=H(cat), json={"action": "keep"}))
    got = await ok(await client.get(f"/api/porch/posts/{pid}/comments", headers=H(bob)))
    assert [x["body"] for x in got["comments"]] == ["Meh"]
    # Reported again and removed: gone; Dan is told who by (the group), not by whom.
    rep2 = await report(client, bob, c["id"], [fam], target_type="comment")
    pushes.calls.clear()
    await ok(await client.post(f"/api/porch/groups/{fam}/reports/{rep2['id']}", headers=H(cat), json={"action": "remove", "reason": ""}))
    assert (await ok(await client.get(f"/api/porch/posts/{pid}/comments", headers=H(bob))))["count"] == 0
    told = porch_for(pushes, dan)[0]
    assert told["title"] == "Your comment was removed" and told["body"] == "By an admin of Fam."


async def test_who_runs_it_and_their_own_posts(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    # Dan is the only admin of Solo: reporting Dan there would go to Dan.
    solo = await members_of(client, dan, "Solo", [bob])
    pid = (await say(client, dan, [solo], "Mine"))["id"]
    r = await client.post("/api/porch/reports", headers=H(bob), json={"target_type": "post", "target_id": pid, "groups": [solo]})
    assert r.status_code == 400 and "Only" in r.json()["detail"] and "leave the group or block" in r.json()["detail"]

    # Fam has two admins: a report on Cat's post goes to Bob, not to Cat.
    fam = await members_of(client, cat, "Fam", [bob, dan])
    await ok(await client.patch(f"/api/porch/groups/{fam}/members/{bob.id}", headers=H(cat), json={"role": "admin"}))
    pid2 = (await say(client, cat, [fam], "Cat's post"))["id"]
    pushes.calls.clear()
    rep = await report(client, dan, pid2, [fam], "Hmm")
    assert len(report_pushes(pushes, bob)) == 1 and report_pushes(pushes, cat) == []
    assert await group_queue(client, cat, fam) == []
    assert (await ok(await client.get(f"/api/porch/groups/{fam}", headers=H(cat))))["open_reports"] == 0
    r = await client.post(f"/api/porch/groups/{fam}/reports/{rep['id']}", headers=H(cat), json={"action": "keep"})
    assert r.status_code == 404
    assert [x["target"]["id"] for x in await group_queue(client, bob, fam)] == [pid2]
