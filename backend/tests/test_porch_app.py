"""What the Porch app (WP-P1.3) asks the server for beyond P1.1's API: is
Porch on for me (the Apps tile), the live stream, "what they are to you" on
a profile, and the first run's "Make a Family group?" suggestions — each
only from the viewer's own data, and never anyone blocked."""
from __future__ import annotations

import asyncio
import json
import uuid
from unittest.mock import AsyncMock

from sqlalchemy import text

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, client, ok, people, quiet, root, say, set_porch,
)


async def test_available_says_whether_porch_is_on_and_never_404s(client, db, people):
    ann, bob, *_ = people
    assert (await ok(await client.get("/api/porch/available", headers=H(bob)))) == {"available": True}
    await set_porch(db, porch_enabled=False)
    assert (await ok(await client.get("/api/porch/available", headers=H(bob)))) == {"available": False}
    # Everything else is a 404, the live stream included.
    assert (await client.get("/api/porch/bootstrap", headers=H(bob))).status_code == 404
    assert (await client.get("/api/porch/events", headers=H(bob))).status_code == 404
    await set_porch(db, porch_enabled=True, porch_user_group_ids=[])
    assert (await ok(await client.get("/api/porch/available", headers=H(ann)))) == {"available": False}


async def test_the_stream_gives_back_its_db_connection_first(people):
    """A stream can stay open for hours: it must not hold a pooled
    connection (the 2026-11-03 outage)."""
    from fastapi.responses import StreamingResponse

    from app.porch import events

    bob = people[1]
    db = AsyncMock()

    class Req:
        async def is_disconnected(self):
            return True

    resp = await events.events(Req(), db=db, user=bob)  # type: ignore[arg-type]
    db.close.assert_awaited_once()
    assert isinstance(resp, StreamingResponse) and resp.media_type == "text/event-stream"
    assert resp.headers["x-accel-buffering"] == "no"


async def test_the_stream_passes_on_events_for_that_person_only(people):
    from app.porch import core, events

    bob, cat = people[1], people[2]
    gone = asyncio.Event()

    class Req:
        async def is_disconnected(self):
            return gone.is_set()

    gen = events._stream(bob.id, Req())  # type: ignore[arg-type]
    assert await gen.__anext__() == ": connected\n\n"
    await core.publish([cat.id], {"type": "post", "post_id": "not-yours"})
    await core.publish([bob.id], {"type": "post", "post_id": "p1"})

    async def next_data() -> str:
        while True:  # pings (": ping") in between are fine
            f = await gen.__anext__()
            if f.startswith("data: "):
                return f

    frame = await asyncio.wait_for(next_data(), 10)
    assert frame.startswith("data: ") and json.loads(frame[6:]) == {"type": "post", "post_id": "p1"}
    gone.set()
    await gen.aclose()


async def test_a_post_publishes_an_id_only_event_to_its_audience(client, db, people, monkeypatch):
    from app.porch import core

    ann, bob, cat, dan = people
    sent: list[tuple[set[str], dict]] = []

    async def capture(user_ids, event):
        sent.append(({str(u) for u in user_ids}, event))

    monkeypatch.setattr(core, "publish", capture)
    gid = (await ok(await client.post("/api/porch/groups", headers=H(ann), json={"name": "Family", "invite": [str(bob.id)]}), 201))["id"]
    await ok(await client.post(f"/api/porch/groups/{gid}/accept", headers=H(bob)))
    sent.clear()
    post = await say(client, ann, [gid], "secret family news")
    (who, ev), = [s for s in sent if s[1]["type"] == "post"]
    assert who == {str(ann.id), str(bob.id)} and ev == {"type": "post", "post_id": post["id"]}
    assert "secret" not in json.dumps(ev)


async def _relation(db, viewer, other, label: str):
    """viewer's Contacts know ``other`` (by email) and call them ``label``."""
    from app.items import service as items

    cfile, _ = await items.create_item(db, viewer, "contacts", installed_check=False, data={
        "contacts": [{"id": "c1", "first": "Sammy", "emails": [{"label": "home", "value": other.email}]}],
    })
    pid = (await db.execute(
        text("INSERT INTO photo_people (user_id, kind, name, contact_file_id, contact_id) VALUES (:u, 'person', 'Sammy', :f, 'c1') RETURNING id"),
        {"u": viewer.id, "f": cfile.id},
    )).scalar_one()
    await db.execute(text("INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind) VALUES (:u, :p, :l, 'sibling')"), {"u": viewer.id, "p": pid, "l": label})
    await db.commit()


async def test_profile_says_what_they_are_to_you_and_only_to_you(client, db, people):
    ann, bob, cat, _ = people
    await _relation(db, ann, bob, "Brother")
    mine = await ok(await client.get(f"/api/porch/users/{bob.id}", headers=H(ann)))
    assert mine["relation"] == {"name": "Sammy", "label": "Brother"}
    # Cat's view of Bob says nothing of Ann's Contacts.
    assert (await ok(await client.get(f"/api/porch/users/{bob.id}", headers=H(cat))))["relation"] is None
    # Your own profile has no "relation".
    assert "relation" not in await ok(await client.get(f"/api/porch/users/{ann.id}", headers=H(ann)))


async def test_family_suggestions_come_from_your_own_people_with_porch(client, db, people):
    ann, bob, cat, dan = people
    await _relation(db, ann, bob, "Brother")
    got = await ok(await client.get("/api/porch/people/suggested", headers=H(ann)))
    assert [(s["user"]["id"], s["label"]) for s in got] == [(str(bob.id), "Brother")]
    # Nothing of Ann's reaches Cat.
    assert await ok(await client.get("/api/porch/people/suggested", headers=H(cat))) == []
    # Blocked either way: not suggested.
    await ok(await client.put(f"/api/people/blocks/{ann.id}", headers=H(bob)))
    assert await ok(await client.get("/api/porch/people/suggested", headers=H(ann))) == []
    await ok(await client.delete(f"/api/people/blocks/{ann.id}", headers=H(bob)))
    # Someone Porch isn't on for: not suggested.
    from app.groups.models import UserGroup, UserGroupMember

    ug = UserGroup(name=f"porch-{uuid.uuid4().hex[:6]}")
    db.add(ug)
    await db.flush()
    db.add(UserGroupMember(group_id=ug.id, user_id=ann.id))
    await db.commit()
    await set_porch(db, porch_user_group_ids=[str(ug.id)])
    assert await ok(await client.get("/api/porch/people/suggested", headers=H(ann))) == []
