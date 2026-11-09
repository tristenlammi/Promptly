"""Porch pushes, settings, reports and Admin → Porch (WP-P1.7).

Pushes: who gets one for a new post (an "All new posts" bell, "Notify me
when they post"), mentions, tag requests (with buttons), comments, replies,
reactions (Daily summary by default), invites (Join / Not now), birthdays
(once a day); never for your own actions, never to someone who can't see
the post, nothing across a block; each kind On / Daily summary / Off, the
account switch, quiet hours holding them. Admin → Porch: off, user groups,
limits, Everyone's name, taking a post out of Everyone. Reports are in
``test_porch_reports.py``.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from tests.porch_kit import H, boot, client, everyone_id, members_of, ok, people, quiet, root, say, sees, set_porch  # noqa: F401 — fixtures

UTC = timezone.utc


@pytest.fixture
def pushes(monkeypatch):
    """Every ``notify_user`` call, run through the real dispatch (holds,
    blocks, preferences) with a fake push service."""
    import app.notifications.dispatch as d

    rec = SimpleNamespace(calls=[], sent=[])

    async def fake_notify_user(**kw):
        payload = d.PushPayload(
            title=kw["title"], body=kw["body"], url=kw.get("url"), tag=kw.get("tag"), category=kw["category"], extra=kw.get("extra"),
        )
        out = await d._dispatch(
            user_id=kw["user_id"], category=kw["category"], payload=payload, actor_user_id=kw.get("actor_user_id"),
            inbox=kw.get("inbox", True), summary=kw.get("summary", False),
        )
        rec.calls.append({**kw, "outcome": out})

    async def fake_vapid(db):
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "notify_user", fake_notify_user)
    monkeypatch.setattr(d, "_send_one", lambda **kw: rec.sent.append(json.loads(kw["payload_json"])))
    monkeypatch.setattr(d, "_vapid", fake_vapid)
    return rec


@pytest.fixture
async def devices(db, people):
    """A push subscription each, so pushes can be delivered or held."""
    from app.notifications.models import PushSubscription

    for u in people:
        db.add(PushSubscription(user_id=u.id, endpoint=f"https://push.invalid/{u.id}", p256dh="k", auth="a"))
    await db.commit()


def porch_for(rec, u) -> list[dict]:
    """The Porch pushes planned for ``u`` (whatever dispatch then did)."""
    return [c for c in rec.calls if c["category"] == "porch" and c["user_id"] == u.id]


def kinds(rec, u) -> list[str]:
    return [c["extra"]["kind"] for c in porch_for(rec, u)]


def reached(rec, u) -> list[str]:
    """Kinds that were delivered or held for ``u`` (not dropped)."""
    return [c["extra"]["kind"] for c in porch_for(rec, u) if c["outcome"]["delivered"] or c["outcome"]["held"]]


async def held_rows(db, u):
    from app.notifications.models import PushHeld

    return (await db.execute(select(PushHeld).where(PushHeld.user_id == u.id))).scalars().all()


async def bell(client, u, gid, notify="all"):
    return await ok(await client.patch(f"/api/porch/groups/{gid}/me", headers=H(u), json={"notify": notify}))


async def modes(client, u, **m):
    return await ok(await client.patch("/api/porch/me/notifications", headers=H(u), json={"modes": m}))


async def comment(client, u, post_id, body, parent=None, mentions=()):
    payload = {"body": body, "parent_id": parent, "mentions": [str(m) for m in mentions]}
    return await ok(await client.post(f"/api/porch/posts/{post_id}/comments", headers=H(u), json=payload), 201)


# ------------------------------------------------------------------ posts


async def test_new_post_goes_to_bells_and_alerts_who_can_see_it(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    for u in people:
        await boot(client, u)
    fam = await members_of(client, ann, "Family", [bob, cat])
    await bell(client, bob, fam)  # All new posts in Family
    await ok(await client.put(f"/api/porch/alerts/{ann.id}", headers=H(cat)))  # Notify me when Ann posts
    await ok(await client.put(f"/api/porch/alerts/{ann.id}", headers=H(dan)))  # Dan can't see Family
    pushes.calls.clear()
    pushes.sent.clear()

    p = await say(client, ann, [fam], "Noosa with the kids")
    assert kinds(pushes, bob) == ["post"] and kinds(pushes, cat) == ["post"]
    assert kinds(pushes, dan) == [] and kinds(pushes, ann) == []  # nothing for your own post
    b = porch_for(pushes, bob)[0]
    assert b["title"].endswith("posted in Family") and b["body"] == "Noosa with the kids"
    assert b["url"] == f"/porch/p/{p['id']}" and b["tag"] == f"porch:post:{p['id']}"
    assert b["actor_user_id"] == ann.id and b["inbox"] is False and b["summary"] is False
    assert len(pushes.sent) == 2

    # To Everyone: Dan's alert now counts; Bob's Family bell doesn't.
    pushes.calls.clear()
    ev = await everyone_id(client, ann)
    await say(client, ann, [ev], "Hello everyone")
    assert kinds(pushes, dan) == ["post"] and kinds(pushes, cat) == ["post"] and kinds(pushes, bob) == []
    assert porch_for(pushes, dan)[0]["title"].endswith("posted in \U0001F30F Everyone")

    # Editing a post never sends "new post" again; the bell off stops it.
    pushes.calls.clear()
    await ok(await client.patch(f"/api/porch/posts/{p['id']}", headers=H(ann), json={"body": "Noosa!"}))
    assert pushes.calls == []
    await bell(client, bob, fam, "none")
    await ok(await client.delete(f"/api/porch/alerts/{ann.id}", headers=H(cat)))
    await say(client, ann, [fam], "Quiet one")
    assert kinds(pushes, bob) == [] and kinds(pushes, cat) == []

    # The alert list, and alerts only for people you can see.
    got = await ok(await client.get("/api/porch/alerts", headers=H(dan)))
    assert [x["id"] for x in got] == [str(ann.id)]
    prof = await ok(await client.get(f"/api/porch/users/{ann.id}", headers=H(dan)))
    assert prof["alert"] is True
    r = await client.put(f"/api/porch/alerts/{uuid.uuid4()}", headers=H(dan))
    assert r.status_code == 404


async def test_mentions_and_tags_beat_the_bell_and_tags_carry_buttons(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    await bell(client, bob, fam)
    await bell(client, cat, fam)
    pushes.calls.clear()
    await say(client, ann, [fam], f"Thanks @{bob.username}", mentions=[str(bob.id), str(dan.id)])
    # One push each: Bob's is the mention; Dan can't see it, so isn't told.
    assert kinds(pushes, bob) == ["mention"] and kinds(pushes, cat) == ["post"] and kinds(pushes, dan) == []

    # A tag request: with Show it / Not me buttons, which work.
    from tests.porch_kit import photo, post_photos

    pic = await photo(client, ann)
    pushes.calls.clear()
    made = await post_photos(client, ann, [fam], [{"file_id": pic, "tags": [{"user_id": str(cat.id), "x": 0.5, "y": 0.5}]}])
    assert kinds(pushes, cat) == ["tag"] and kinds(pushes, bob) == ["post"]
    tag_push = porch_for(pushes, cat)[0]
    acts = {a["action"]: a for a in tag_push["extra"]["actions"]}
    assert set(acts) == {"porch_tag_yes", "porch_tag_no"} and acts["porch_tag_yes"]["title"] == "Show it"
    from app.notifications.actions import perform

    assert await perform(db, acts["porch_tag_yes"]["token"]) == "Your tag shows on the photo now"
    seen = await ok(await client.get(f"/api/porch/posts/{made['id']}", headers=H(ann)))
    assert seen["media"][0]["tags"][0]["status"] == "approved"


async def test_comments_replies_reactions_and_nothing_for_yourself(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "BBQ Saturday"))["id"]
    pushes.calls.clear()

    top = await comment(client, bob, post, "I'm in")
    assert kinds(pushes, ann) == ["comment"] and kinds(pushes, bob) == []
    assert porch_for(pushes, ann)[0]["body"] == "I'm in"
    pushes.calls.clear()
    await comment(client, cat, post, f"Me too @{dan.username} @{ann.username}", parent=top["id"], mentions=[dan.id, ann.id])
    # Ann (her post) a comment, Bob a reply, Dan nothing (can't see it).
    assert kinds(pushes, ann) == ["comment"] and kinds(pushes, bob) == ["reply"] and kinds(pushes, dan) == []
    pushes.calls.clear()
    await comment(client, ann, post, "Great!", parent=top["id"])  # on her own post
    assert kinds(pushes, ann) == [] and kinds(pushes, bob) == ["reply"]

    # Reactions: first one only, to the owner, Daily summary by default.
    pushes.calls.clear()
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(bob), json={"emoji": "❤️"}))
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(bob), json={"emoji": "😂"}))
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(ann), json={"emoji": "❤️"}))
    r = porch_for(pushes, ann)
    assert [c["extra"]["kind"] for c in r] == ["reaction"] and r[0]["summary"] is True
    assert r[0]["outcome"]["held"] == 1
    assert [h.reason for h in await held_rows(db, ann)] == ["summary"]
    pushes.calls.clear()
    await ok(await client.put(f"/api/porch/comments/{top['id']}/reactions", headers=H(cat), json={"emoji": "👍"}))
    assert kinds(pushes, bob) == ["reaction"] and "your comment" in porch_for(pushes, bob)[0]["title"]


async def test_kinds_on_summary_off_and_the_account_switch(client, db, people, pushes, devices):
    ann, bob, cat, _ = people
    fam = await members_of(client, ann, "Family", [bob])
    post = (await say(client, ann, [fam], "Hi"))["id"]
    s = await ok(await client.get("/api/porch/me/notifications", headers=H(ann)))
    assert s["modes"]["reaction"] == "summary" and s["modes"]["comment"] == "on" and s["account"]["porch"] is True

    await modes(client, ann, comment="off")
    pushes.calls.clear()
    await comment(client, bob, post, "one")
    assert kinds(pushes, ann) == []  # off: not even sent to dispatch

    await modes(client, ann, comment="summary")
    await comment(client, bob, post, "two")
    c = porch_for(pushes, ann)[-1]
    assert c["summary"] is True and c["outcome"]["held"] == 1

    r = await client.patch("/api/porch/me/notifications", headers=H(ann), json={"modes": {"poke": "on"}})
    assert r.status_code == 400

    # Porch off in Account → Notifications: nothing reaches the phone.
    await modes(client, ann, comment="on")
    s = await ok(await client.patch("/api/porch/me/notifications", headers=H(ann), json={"porch": False}))
    assert s["account"]["porch"] is False
    pushes.sent.clear()
    await comment(client, bob, post, "three")
    c = porch_for(pushes, ann)[-1]
    assert c["outcome"]["delivered"] == 0 and c["outcome"]["held"] == 0 and pushes.sent == []
    # Settings → Notifications in Account says so too.
    prefs = await ok(await client.get("/api/notifications/preferences", headers=H(ann)))
    assert prefs["porch"] is False and "porch" in prefs["summary_capable"]


async def test_quiet_hours_hold_porch_pushes_and_the_summary_counts_kinds(client, db, people, pushes, devices, monkeypatch):
    from app.notifications import loops, quiet as q
    from app.notifications.models import PushPreferences

    ann, bob, cat, _ = people
    ann.settings = {"timezone": "UTC"}
    await db.commit()
    db.add(PushPreferences(user_id=ann.id, quiet_enabled=True, quiet_start=time(22, 0), quiet_end=time(7, 0)))
    await db.commit()
    monkeypatch.setattr(q, "_now", lambda: datetime(2026, 11, 9, 23, 30, tzinfo=UTC))
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "Late"))["id"]
    await comment(client, bob, post, "night")
    await comment(client, cat, post, "owl")
    rows = await held_rows(db, ann)
    assert sorted(r.reason for r in rows) == ["quiet", "quiet"] and all(r.category == "porch" for r in rows)
    assert q.phrase("porch", rows) == "2 comments in Porch"

    # Quiet hours end: one "While you were away" push for Porch.
    pushes.sent.clear()
    out = await loops.run_once(db, now=datetime(2026, 11, 10, 7, 1, tzinfo=UTC))
    assert out["released"] == 1
    assert [p["title"] for p in pushes.sent] == ["While you were away"] and pushes.sent[0]["body"] == "2 comments in Porch"


# ------------------------------------------------------------------ blocks, invites, birthdays


async def test_blocks_drop_porch_pushes_both_ways(client, db, people, pushes, devices):
    ann, bob, cat, _ = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    await bell(client, bob, fam)
    post = (await say(client, ann, [fam], "Before"))["id"]
    # Ann blocks Cat: Cat's comment on Ann's post doesn't reach her.
    assert (await client.put(f"/api/people/blocks/{cat.id}", headers=H(ann))).status_code in (200, 204)
    pushes.calls.clear()
    r = await client.post(f"/api/porch/posts/{post}/comments", headers=H(cat), json={"body": "hi"})
    assert r.status_code == 404  # she can't see Ann's post any more
    # Bob blocks Ann: her new post isn't pushed to him (he can't see it).
    assert (await client.put(f"/api/people/blocks/{ann.id}", headers=H(bob))).status_code in (200, 204)
    await say(client, ann, [fam], "After")
    assert reached(pushes, bob) == [] and reached(pushes, cat) == []
    # Anything from someone blocked that's pushed anyway is dropped centrally.
    from app.porch import push as porch_push

    pushes.calls.clear()
    await porch_push._send(to=ann.id, kind="comment", mode="on", title="t", body="b", url="/porch/", tag="x", actor=bob)
    assert pushes.calls[-1]["outcome"]["blocked"] == 1


async def test_invites_push_with_join_and_not_now(client, db, people, pushes, devices):
    ann, bob, cat, _ = people
    from app.notifications.actions import perform

    gid = (await ok(await client.post("/api/porch/groups", headers=H(ann), json={"name": "Lads", "visibility": "private", "invite": [str(bob.id), str(cat.id)]}), 201))["id"]
    pb, pc = porch_for(pushes, bob), porch_for(pushes, cat)
    assert [c["extra"]["kind"] for c in pb] == ["invite"] and "invited you to" in pb[0]["title"] and pb[0]["tag"] == f"porch:invite:{gid}"
    acts_b = {a["action"]: a["token"] for a in pb[0]["extra"]["actions"]}
    acts_c = {a["action"]: a["token"] for a in pc[0]["extra"]["actions"]}
    assert await perform(db, acts_b["porch_join"]) == "You joined Lads"
    assert await perform(db, acts_c["porch_decline"]) == "You said not now to Lads"
    mine = await boot(client, bob)
    assert gid in [g["id"] for g in mine["groups"]]
    assert gid not in [g["id"] for g in (await boot(client, cat))["invites"]]
    # A second tap does nothing harmful.
    from app.notifications.actions import ActionRefused

    with pytest.raises(ActionRefused):
        await perform(db, acts_b["porch_join"])
    # Inviting more people later pushes too.
    pushes.calls.clear()
    await ok(await client.post(f"/api/porch/groups/{gid}/invites", headers=H(ann), json={"user_ids": [str(cat.id)]}))
    assert kinds(pushes, cat) == ["invite"]


async def test_birthday_pushes_once_a_day_for_your_groups(client, db, people, pushes, devices):
    from app.porch import push as porch_push

    ann, bob, cat, dan = people
    for u in people:
        await boot(client, u)
        u.settings = {"timezone": "UTC"}
    await db.commit()
    await members_of(client, ann, "Family", [bob])
    today = date(2026, 11, 9)
    await ok(await client.patch("/api/porch/me/profile", headers=H(ann), json={"birthday": "1980-11-09", "show_birthday": True}))
    await ok(await client.patch("/api/porch/me/profile", headers=H(cat), json={"birthday": "1990-11-09", "show_birthday": False}))
    pushes.calls.clear()

    # Before the Today summary time (08:00 by default): nothing yet.
    assert await porch_push.birthdays_once(db, now=datetime(2026, 11, 9, 6, 0, tzinfo=UTC)) == 0
    sent = await porch_push.birthdays_once(db, now=datetime(2026, 11, 9, 7, 55, tzinfo=UTC))
    assert sent == 1
    b = porch_for(pushes, bob)
    assert [c["extra"]["kind"] for c in b] == ["birthday"] and b[0]["title"].endswith("birthday today")
    assert b[0]["url"] == f"/porch/new?for={ann.id}" and b[0]["tag"] == f"porch:birthday:{ann.id}:{today.isoformat()}"
    # Dan shares no group with Ann (only Everyone); Cat hides hers; Ann gets none for herself.
    assert kinds(pushes, dan) == [] and kinds(pushes, ann) == []
    # Once a day, even across a restart.
    assert await porch_push.birthdays_once(db, now=datetime(2026, 11, 9, 12, 0, tzinfo=UTC)) == 0
    # Dan turns on "Notify me when Ann posts": next year he gets hers too.
    await ok(await client.put(f"/api/porch/alerts/{ann.id}", headers=H(dan)))
    await modes(client, bob, birthday="off")
    pushes.calls.clear()
    await porch_push.birthdays_once(db, now=datetime(2027, 11, 9, 9, 0, tzinfo=UTC))
    assert kinds(pushes, dan) == ["birthday"] and kinds(pushes, bob) == []


# ------------------------------------------------------------------ admin (reports: test_porch_reports.py)


async def test_admin_takes_a_post_out_of_everyone(client, db, people, pushes, devices):
    ann, bob, cat, dan = people
    ev = await everyone_id(client, cat)
    mates = await members_of(client, cat, "Mates", [bob])
    both = (await say(client, cat, [ev, mates], "For all"))["id"]
    only = (await say(client, cat, [ev], "Just everyone"))["id"]
    assert await sees(client, dan, both)
    r = await client.post(f"/api/admin/porch/posts/{both}/remove-from-everyone", headers=H(bob), json={"reason": "x"})
    assert r.status_code == 403
    out = await ok(await client.post(f"/api/admin/porch/posts/{both}/remove-from-everyone", headers=H(ann), json={"reason": "Not for everyone, sorry"}))
    assert out["deleted"] is False
    assert not await sees(client, dan, both) and await sees(client, bob, both)
    out = await ok(await client.post(f"/api/admin/porch/posts/{only}/remove-from-everyone", headers=H(ann), json={"reason": ""}))
    assert out["deleted"] is True and not await sees(client, cat, only)
    r = await client.post(f"/api/admin/porch/posts/{both}/remove-from-everyone", headers=H(ann), json={"reason": "again"})
    assert r.status_code in (400, 404)
    act = await ok(await client.get("/api/porch/activity", headers=H(cat)))
    scopes = sorted(i["removed"]["scope"] for i in act["items"] if i["kind"] == "removed")
    assert scopes == ["everyone", "everyone"]
    titles = [c["title"] for c in porch_for(pushes, cat)]
    assert titles.count("Your post was removed from Everyone") == 2


async def test_admin_porch_settings(client, db, people):
    from app.groups.models import UserGroup, UserGroupMember

    ann, bob, cat, _ = people
    assert (await client.get("/api/admin/porch", headers=H(bob))).status_code == 403
    s = await ok(await client.get("/api/admin/porch", headers=H(ann)))
    assert s["enabled"] is True and s["user_group_ids"] is None and s["everyone_name"]

    s = await ok(await client.patch("/api/admin/porch", headers=H(ann), json={"everyone_name": "Lammi Clan", "video_max_seconds": 60, "video_max_mb": 200}))
    assert s["everyone_name"] == "Lammi Clan"
    b = await boot(client, bob)
    assert b["everyone"]["name"] == "Lammi Clan" and b["limits"]["video_max_seconds"] == 60 and b["limits"]["video_max_mb"] == 200
    r = await client.patch("/api/admin/porch", headers=H(ann), json={"everyone_name": "  "})
    assert r.status_code == 400

    # Only one user group may use it.
    ug = UserGroup(name=f"Family {uuid.uuid4().hex[:4]}")
    db.add(ug)
    await db.commit()
    db.add(UserGroupMember(group_id=ug.id, user_id=bob.id))
    await db.commit()
    s = await ok(await client.patch("/api/admin/porch", headers=H(ann), json={"user_group_ids": [str(ug.id)]}))
    assert s["user_group_ids"] == [str(ug.id)] and any(g["id"] == str(ug.id) and g["member_count"] == 1 for g in s["user_groups"])
    assert (await client.get("/api/porch/bootstrap", headers=H(bob))).status_code == 200
    assert (await client.get("/api/porch/bootstrap", headers=H(cat))).status_code == 404
    assert (await ok(await client.get("/api/porch/available", headers=H(cat))))["available"] is False
    r = await client.patch("/api/admin/porch", headers=H(ann), json={"user_group_ids": [str(uuid.uuid4())]})
    assert r.status_code == 400
    s = await ok(await client.patch("/api/admin/porch", headers=H(ann), json={"user_group_ids": None}))
    assert s["user_group_ids"] is None
    assert (await client.get("/api/porch/bootstrap", headers=H(cat))).status_code == 200

    # Off: Porch is gone for everyone (admins too).
    await ok(await client.patch("/api/admin/porch", headers=H(ann), json={"enabled": False}))
    for u in (ann, bob):
        assert (await client.get("/api/porch/bootstrap", headers=H(u))).status_code == 404
    await ok(await client.patch("/api/admin/porch", headers=H(ann), json={"enabled": True}))
    assert (await client.get("/api/porch/bootstrap", headers=H(bob))).status_code == 200
