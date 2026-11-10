"""Group events (WP-P3.2): planning in a group invites everyone in it (not
in Everyone, by default), a post carries the card, someone who joins later
answers from the card and becomes a guest, an outsider gets 404 from the
card and from rsvp, the event deleted leaves "Cancelled", the post deleted
can cancel the event (its organiser only), "Make this an event" on your own
post attaches it, and nobody is told twice (Calendar's invite, not Porch's
new-post push)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from tests.porch_kit import H, accept, client, everyone_id, group, members_of, ok, people, quiet, root, say  # noqa: F401 — fixtures


def when(days: int = 3) -> tuple[str, str]:
    s = (datetime.now(timezone.utc) + timedelta(days=days)).replace(hour=4, minute=0, second=0, microsecond=0)
    return s.isoformat(), (s + timedelta(hours=3)).isoformat()


async def plan(client, u, gid, title="Family BBQ", **extra) -> dict:
    start, end = when()
    body = {"title": title, "start": start, "end": end, "location": "Our place", "tz": "UTC", **extra}
    return await ok(await client.post(f"/api/porch/groups/{gid}/events", headers=H(u), json=body), 201)


async def card(client, u, post_id) -> dict | None:
    r = await client.get(f"/api/porch/posts/{post_id}", headers=H(u))
    assert r.status_code in (200, 404), r.text
    return r.json()["event"] if r.status_code == 200 else None


@pytest.fixture
def pushes(monkeypatch):
    import app.notifications.dispatch as d

    rec = SimpleNamespace(calls=[])

    async def fake(**kw):
        rec.calls.append(kw)

    monkeypatch.setattr(d, "notify_user", fake)
    return rec


async def test_planning_in_a_group_invites_everyone_and_posts_the_card(client, db, people, pushes):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    # Bob wants every new post in Family: he still gets one push, Calendar's invite.
    await ok(await client.patch(f"/api/porch/groups/{fam}/me", headers=H(bob), json={"notify": "all"}))
    pushes.calls.clear()
    got = await plan(client, ann, fam, body="Bring a salad!")
    ev, post = got["event"], got["post"]
    assert {a["user_id"] for a in ev["attendees"]} == {str(bob.id), str(cat.id)}
    assert ev["source"] == {"kind": "porch_post", "post_id": post["id"]}
    assert post["body"] == "Bring a salad!" and post["groups"][0]["name"] == "Family"
    c = post["event"]
    assert c["title"] == "Family BBQ" and c["location"] == "Our place" and c["organiser"] is True and c["going_count"] == 1
    # Bob: invited once (Calendar), no Porch "posted in Family" on top.
    to_bob = [x for x in pushes.calls if x["user_id"] == bob.id]
    assert [x["category"] for x in to_bob] == ["calendar"], to_bob
    # Bob answers from the card.
    await ok(await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(bob), json={"status": "going"}))
    c = await card(client, cat, post["id"])
    assert c["going_count"] == 2 and [u["id"] for u in c["going"]] == [str(ann.id), str(bob.id)] and c["invited"] is True
    assert (await card(client, bob, post["id"]))["my_status"] == "going"
    # The group's Events tab.
    evs = await ok(await client.get(f"/api/porch/groups/{fam}/events", headers=H(cat)))
    assert [p["id"] for p in evs["upcoming"]] == [post["id"]] and evs["past"] == []

    # Dan (outside Family): 404 from the post, the card and rsvp.
    assert await card(client, dan, post["id"]) is None
    assert (await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(dan), json={"status": "going"})).status_code == 404
    assert (await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(dan))).status_code == 404

    # Dan joins later: he answers from the card and becomes a guest.
    await ok(await client.post(f"/api/porch/groups/{fam}/invites", headers=H(ann), json={"user_ids": [str(dan.id)]}))
    await accept(client, dan, fam)
    c = await card(client, dan, post["id"])
    assert c["my_status"] is None and c["invited"] is False
    await ok(await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(dan)))
    await ok(await client.post(f"/api/calendar/events/{ev['event_id']}/rsvp", headers=H(dan), json={"status": "maybe"}))
    full = await ok(await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(ann)))
    assert {a["user_id"]: a["status"] for a in full["event"]["attendees"]}[str(dan.id)] == "maybe"
    # It's on Dan's calendar now.
    start = (datetime.now(timezone.utc)).date().isoformat()
    end = (datetime.now(timezone.utc) + timedelta(days=10)).date().isoformat()
    cal = await ok(await client.get("/api/calendar/events", headers=H(dan), params={"start": start, "end": end}))
    items = cal["events"] if isinstance(cal, dict) else cal
    assert any(o["event_id"] == ev["event_id"] for o in items)


async def test_everyone_is_not_invited_by_default(client, db, people):
    ann, bob, cat, dan = people
    ev_id = await everyone_id(client, ann)
    got = await plan(client, bob, ev_id, title="Street party")
    assert got["event"]["attendees"] == []
    # Anyone can still answer from the card.
    await ok(await client.post(f"/api/calendar/events/{got['event']['event_id']}/rsvp", headers=H(dan), json={"status": "going"}))
    assert (await card(client, cat, got["post"]["id"]))["going_count"] == 2
    # And a custom group can be left uninvited too.
    fam = await members_of(client, ann, "Family", [bob])
    quiet_one = await plan(client, ann, fam, title="Quiet one", invite_all=False)
    assert quiet_one["event"]["attendees"] == []
    # Only members plan in a group.
    lads = await group(client, cat, "Lads", "public")
    assert (await client.post(f"/api/porch/groups/{lads}/events", headers=H(dan), json={"title": "x", "start": when()[0]})).status_code == 403


async def test_cancel_and_delete_both_ways(client, db, people):
    ann, bob, cat, _ = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    one = await plan(client, ann, fam, title="Picnic")
    # The event deleted: the post stays, with "Cancelled: Picnic".
    await ok(await client.delete(f"/api/calendar/events/{one['event']['event_id']}", headers=H(ann)), 204)
    c = await card(client, bob, one["post"]["id"])
    assert c == {"cancelled": True, "title": "Picnic"}
    evs = await ok(await client.get(f"/api/porch/groups/{fam}/events", headers=H(bob)))
    assert [p["id"] for p in evs["past"]] == [one["post"]["id"]]

    two = await plan(client, ann, fam, title="Dinner")
    # Renaming the event renames the card (and what a cancellation says).
    await ok(await client.patch(f"/api/calendar/events/{two['event']['event_id']}", headers=H(ann), json={"title": "Big dinner"}))
    assert (await card(client, cat, two["post"]["id"]))["title"] == "Big dinner"
    # Only the organiser can cancel it with the post (an admin deleting the post can't).
    r = await client.delete(f"/api/porch/posts/{two['post']['id']}", headers=H(bob), params={"cancel_event": "true"})
    assert r.status_code == 403
    # The post deleted, the event kept.
    three = await plan(client, ann, fam, title="Kept")
    await ok(await client.delete(f"/api/porch/posts/{three['post']['id']}", headers=H(ann)), 204)
    await ok(await client.get(f"/api/calendar/events/{three['event']['event_id']}", headers=H(bob)))
    # The post deleted and the event cancelled with it.
    await ok(await client.delete(f"/api/porch/posts/{two['post']['id']}", headers=H(ann), params={"cancel_event": "true"}), 204)
    assert (await client.get(f"/api/calendar/events/{two['event']['event_id']}", headers=H(ann))).status_code == 404


async def test_make_this_an_event_attaches_to_your_own_post_only(client, db, people):
    ann, bob, cat, _ = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    mine = await say(client, ann, [fam], "BBQ Saturday")
    theirs = await say(client, bob, [fam], "Movie night?")
    start, end = when(5)

    async def make(u, post_id, title):
        body = {"title": title, "start": start, "end": end, "tz": "UTC", "source": {"kind": "porch_post", "post_id": post_id}, "guests": []}
        return await ok(await client.post("/api/calendar/events", headers=H(u), json=body), 201)

    ev = await make(ann, mine["id"], "BBQ")
    assert (await card(client, cat, mine["id"]))["event_id"] == ev["event"]["event_id"]
    # Cat (not on the event) answers from the card.
    await ok(await client.post(f"/api/calendar/events/{ev['event']['event_id']}/rsvp", headers=H(cat), json={"status": "going"}))
    # Someone else's post: the event is just yours; the post stays as it was.
    await make(ann, theirs["id"], "Movies")
    assert (await card(client, bob, theirs["id"])) is None
