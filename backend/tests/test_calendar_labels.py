"""Calendar labels: each person's own colour-coding. Defaults seeded once,
CRUD, labels on events (create, patch, the per-event endpoint), privacy
between people on a shared event, deleting a label untags, cascades, the
series split, and the chat tools."""
from __future__ import annotations

import uuid

import pytest

from .test_calendar import H, add, client, listing, people, pushes  # noqa: F401

pytestmark = pytest.mark.asyncio


async def labels_of(client, u) -> list[dict]:  # noqa: F811
    r = await client.get("/api/calendar/labels", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["labels"]


async def test_defaults_seeded_once_and_crud(client, people, pushes):  # noqa: F811
    ann, _, _ = people
    first = await labels_of(client, ann)
    assert [(lb["name"], lb["color"]) for lb in first] == [("Personal", "#4E9F5B"), ("Work", "#4F7FE0")]
    assert [lb["id"] for lb in await labels_of(client, ann)] == [lb["id"] for lb in first]  # not seeded twice
    boot = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()
    assert [lb["id"] for lb in boot["labels"]] == [lb["id"] for lb in first]
    # Add, rename, recolour.
    r = await client.post("/api/calendar/labels", headers=H(ann), json={"name": " Kids ", "color": "#D9A23B"})
    assert r.status_code == 201, r.text
    kids = r.json()
    assert kids["name"] == "Kids" and kids["position"] == 2
    r = await client.patch(f"/api/calendar/labels/{kids['id']}", headers=H(ann), json={"name": "School", "color": "#8E5BD9"})
    assert r.json()["name"] == "School" and r.json()["color"] == "#8E5BD9" and r.json()["hidden"] is False
    r = await client.patch(f"/api/calendar/labels/{kids['id']}", headers=H(ann), json={"hidden": True})
    assert r.json()["hidden"] is True and r.json()["name"] == "School"
    assert (await client.post("/api/calendar/labels", headers=H(ann), json={"name": "x", "color": "red"})).status_code == 422
    # Delete both defaults: they don't come back.
    for lb in first:
        assert (await client.delete(f"/api/calendar/labels/{lb['id']}", headers=H(ann))).status_code == 204
    assert [lb["name"] for lb in await labels_of(client, ann)] == ["School"]


async def test_label_cap(client, people, pushes):  # noqa: F811
    ann, _, _ = people
    await labels_of(client, ann)
    for i in range(28):
        assert (await client.post("/api/calendar/labels", headers=H(ann), json={"name": f"L{i}", "color": "#000000"})).status_code == 201
    r = await client.post("/api/calendar/labels", headers=H(ann), json={"name": "one more", "color": "#000000"})
    assert r.status_code == 400 and "30" in r.text


async def test_labels_are_private(client, people, pushes):  # noqa: F811
    ann, bob, cat = people
    ann_work = (await labels_of(client, ann))[1]
    bob_personal = (await labels_of(client, bob))[0]
    # Ann makes an event with her label and invites Bob.
    ev = await add(client, ann, guests=[str(bob.id)], label_id=ann_work["id"])
    eid = ev["event_id"]
    assert ev["label_id"] == ann_work["id"]
    assert (await listing(client, ann))[0]["label_id"] == ann_work["id"]
    # Bob sees no label on it — not Ann's.
    bob_view = (await client.get(f"/api/calendar/events/{eid}", headers=H(bob))).json()["event"]
    assert bob_view["label_id"] is None
    assert (await listing(client, bob))[0]["label_id"] is None
    # Bob can't see, change, delete or use Ann's label.
    assert ann_work["id"] not in [lb["id"] for lb in await labels_of(client, bob)]
    assert (await client.patch(f"/api/calendar/labels/{ann_work['id']}", headers=H(bob), json={"name": "x"})).status_code == 404
    assert (await client.delete(f"/api/calendar/labels/{ann_work['id']}", headers=H(bob))).status_code == 404
    r = await client.put(f"/api/calendar/events/{eid}/label", headers=H(bob), json={"label_id": ann_work["id"]})
    assert r.status_code == 404
    # A guest (no edit rights) puts his own label on it; Ann's stays hers.
    r = await client.put(f"/api/calendar/events/{eid}/label", headers=H(bob), json={"label_id": bob_personal["id"]})
    assert r.status_code == 200 and r.json()["label_id"] == bob_personal["id"]
    assert (await listing(client, bob))[0]["label_id"] == bob_personal["id"]
    assert (await listing(client, ann))[0]["label_id"] == ann_work["id"]
    # Cat, who can't see the event, can't label it.
    cat_label = (await labels_of(client, cat))[0]
    r = await client.put(f"/api/calendar/events/{eid}/label", headers=H(cat), json={"label_id": cat_label["id"]})
    assert r.status_code == 404
    # The subscribe feed never carries a label name.
    tok = (await client.post("/api/calendar/feed", headers=H(ann))).json()["feed_token"]
    body = (await client.get(f"/api/calendar/feed/{tok}.ics")).text
    assert "Work" not in body
    # Bob takes his off.
    r = await client.put(f"/api/calendar/events/{eid}/label", headers=H(bob), json={"label_id": None})
    assert r.json()["label_id"] is None


async def test_shared_calendar_each_their_own(client, people, pushes):  # noqa: F811
    ann, bob, _ = people
    fam = (await client.post("/api/calendar/calendars", headers=H(ann), json={"name": "Family", "member_ids": [str(bob.id)]})).json()
    ev = await add(client, ann, calendar_id=fam["id"], title="Bins")
    a_lab, b_lab = (await labels_of(client, ann))[0], (await labels_of(client, bob))[1]
    # Patch with a label (Ann can edit), and Bob (an editor) via the endpoint.
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"label_id": a_lab["id"]})
    assert r.status_code == 200 and r.json()["event"]["label_id"] == a_lab["id"]
    await client.put(f"/api/calendar/events/{ev['event_id']}/label", headers=H(bob), json={"label_id": b_lab["id"]})
    assert (await listing(client, ann))[0]["label_id"] == a_lab["id"]
    assert (await listing(client, bob))[0]["label_id"] == b_lab["id"]
    # Patching without label_id leaves it; patching null takes it off.
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"title": "Bins out"})
    assert r.json()["event"]["label_id"] == a_lab["id"]
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={"label_id": None})
    assert r.json()["event"]["label_id"] is None
    assert (await listing(client, bob))[0]["label_id"] == b_lab["id"]
    # Search carries yours too.
    found = (await client.get("/api/calendar/search", headers=H(bob), params={"q": "Bins"})).json()["events"]
    assert found[0]["label_id"] == b_lab["id"]


async def test_delete_label_untags_and_event_delete_cascades(client, db, people, pushes):  # noqa: F811
    from sqlalchemy import func, select

    from app.calendars.models import CalEventLabel

    ann, _, _ = people
    work = (await labels_of(client, ann))[1]
    one = await add(client, ann, label_id=work["id"])
    two = await add(client, ann, title="Lunch", label_id=work["id"])
    assert (await client.delete(f"/api/calendar/labels/{work['id']}", headers=H(ann))).status_code == 204
    assert all(o["label_id"] is None for o in await listing(client, ann))
    assert len(await listing(client, ann)) == 2  # the events stay
    # Deleting an event drops its label rows.
    personal = (await labels_of(client, ann))[0]
    await client.put(f"/api/calendar/events/{one['event_id']}/label", headers=H(ann), json={"label_id": personal["id"]})
    await client.put(f"/api/calendar/events/{two['event_id']}/label", headers=H(ann), json={"label_id": personal["id"]})
    assert (await client.delete(f"/api/calendar/events/{one['event_id']}", headers=H(ann))).status_code == 204
    n = (await db.execute(select(func.count()).select_from(CalEventLabel).where(CalEventLabel.user_id == ann.id))).scalar()
    assert n == 1
    # A label id that isn't anyone's is refused.
    r = await client.post("/api/calendar/events", headers=H(ann), json={"title": "x", "start": "2026-11-08T10:00:00Z", "label_id": str(uuid.uuid4())})
    assert r.status_code == 404


async def test_series_label_covers_all_and_follows_split(client, people, pushes):  # noqa: F811
    ann, _, _ = people
    work = (await labels_of(client, ann))[1]
    ev = await add(client, ann, title="Swim", start="2026-11-02T17:00:00Z", end="2026-11-02T18:00:00Z",
                   repeat={"freq": "weekly", "weekdays": [0]}, label_id=work["id"])
    occ = await listing(client, ann)
    assert len(occ) == 5 and all(o["label_id"] == work["id"] for o in occ)
    r = await client.patch(f"/api/calendar/events/{ev['event_id']}", headers=H(ann), json={
        "scope": "following", "occurrence": "2026-11-23T17:00:00Z", "title": "Swim club",
    })
    assert r.json()["event"]["event_id"] != ev["event_id"] and r.json()["event"]["label_id"] == work["id"]
    assert all(o["label_id"] == work["id"] for o in await listing(client, ann))


async def test_chat_tools_labels(client, db, people, pushes):  # noqa: F811
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.calendar import CalendarAddEventTool, CalendarChangeEventTool, CalendarEventsTool

    ann, bob, _ = people
    ctx = ToolContext(db=db, user=ann, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = await CalendarAddEventTool().run(ctx, {"title": "Standup", "start": "2026-11-09T09:00", "label": "work", "guests": [bob.username]})
    eid = out.content.split("event_id ")[1].rstrip(")")
    seen = await CalendarEventsTool().run(ctx, {"start": "2026-11-09", "end": "2026-11-09"})
    assert "label Work" in seen.content and "Your labels: Personal, Work" in seen.content
    with pytest.raises(ToolError, match="No label called"):
        await CalendarAddEventTool().run(ctx, {"title": "x", "start": "2026-11-09T10:00", "label": "Gym"})
    # Bob (a guest who can't edit) labels it his way; Ann's is untouched.
    bctx = ToolContext(db=db, user=bob, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = await CalendarChangeEventTool().run(bctx, {"event_id": eid, "action": "update", "label": "Personal"})
    assert "Labelled" in out.content
    bseen = await CalendarEventsTool().run(bctx, {"start": "2026-11-09", "end": "2026-11-09"})
    assert "label Personal" in bseen.content and "label Work" not in bseen.content
    # Bob can't use Ann's label by name: it's not one of his.
    await client.post("/api/calendar/labels", headers=H(ann), json={"name": "Secret", "color": "#000000"})
    with pytest.raises(ToolError):
        await CalendarChangeEventTool().run(bctx, {"event_id": eid, "action": "update", "label": "Secret"})
    out = await CalendarChangeEventTool().run(ctx, {"event_id": eid, "action": "update", "label": "none"})
    assert "Took the label off" in out.content
