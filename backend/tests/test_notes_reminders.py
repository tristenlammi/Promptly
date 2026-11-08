"""Notes N1.4: reminders are tasks in your Tasks (linked to the note both
ways, read live), and sharing (share / leave / remove, blocks, the push and
quiet hours)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import select

UTC = timezone.utc


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
def pushes(monkeypatch):
    sent: list[dict] = []

    async def fake(**kw):
        sent.append(kw)

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)
    return sent


@pytest.fixture
def live(monkeypatch):
    from app.notes import events

    got: list[tuple[set[str], dict]] = []

    async def fake(user_ids, event):
        assert set(event) <= events.EVENT_KEYS
        got.append(({str(u) for u in user_ids}, dict(event)))

    monkeypatch.setattr(events, "publish", fake)
    return got


async def mk_user(db, name: str):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user", settings={"timezone": "Australia/Sydney"})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


async def new_note(client, u, **kw):
    body = {"client_id": str(uuid.uuid4()), "title": "Call the plumber", "text": "About the leak", **kw}
    r = await client.post("/api/notes", headers=H(u), json=body)
    assert r.status_code == 201, r.text
    return r.json()["note"]


async def get(client, u, nid):
    r = await client.get(f"/api/notes/{nid}", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["note"]


async def share(client, owner, nid, *users):
    r = await client.post(f"/api/notes/{nid}/members", headers=H(owner), json={"user_ids": [str(u.id) for u in users]})
    assert r.status_code == 200, r.text
    return r.json()


async def remind(client, u, nid, **body):
    r = await client.put(f"/api/notes/{nid}/reminder", headers=H(u), json=body)
    assert r.status_code == 200, r.text
    return r.json()["note"]


async def tasks_of(client, u, fid):
    r = await client.get(f"/api/items/{fid}", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["data"]["tasks"]


def tomorrow() -> str:
    return (datetime.now(ZoneInfo("Australia/Sydney")).date() + timedelta(days=1)).isoformat()


# ------------------------------------------------------------------ reminders


async def test_reminder_is_a_linked_task_in_your_tasks(client, people, live, db):
    ann, _, _ = people
    n = await new_note(client, ann)
    assert n["reminder"] is None and n["has_reminder"] is False

    day = tomorrow()
    out = await remind(client, ann, n["id"], due=day, time="09:00")
    rem = out["reminder"]
    assert out["has_reminder"] is True
    assert rem["due"] == day and rem["time"] == "09:00" and rem["repeat"] is None and rem["at"].startswith(day)
    assert rem["href"] == f"/apps/tasks/{rem['task_file_id']}?task={rem['task_id']}"
    # The task: in Ann's own Tasks, titled like the note, an at-the-time alert.
    tasks = await tasks_of(client, ann, rem["task_file_id"])
    t = next(x for x in tasks if x["id"] == rem["task_id"])
    assert t["title"] == "Call the plumber" and t["due"] == day and t["time"] == "09:00" and t["alerts"] == [0]
    # Live: only Ann's own devices hear about it.
    assert live[-1] == ({str(ann.id)}, {"type": "note", "id": n["id"], "revision": n["revision"], "change_seq": n["change_seq"]})

    # Linked both ways: the task lists the note, and the note lists the task.
    r = await client.get("/api/connections", headers=H(ann), params={"kind": "task", "id": f"{rem['task_file_id']}:{rem['task_id']}"})
    assert r.status_code == 200, r.text
    assert any(x.get("href", "").endswith(n["id"]) for x in r.json()["linked"])
    r = await client.get("/api/connections", headers=H(ann), params={"kind": "note", "id": n["id"]})
    assert any("tasks" in (x.get("href") or "") for x in r.json()["linked"])

    # Cards carry it; the Reminders view and filter find it.
    r = await client.get("/api/notes", headers=H(ann), params={"view": "reminders"})
    assert [c["id"] for c in r.json()["notes"]] == [n["id"]] and r.json()["notes"][0]["reminder"]["due"] == day
    r = await client.get("/api/notes", headers=H(ann), params={"type": "reminder"})
    assert [c["id"] for c in r.json()["notes"]] == [n["id"]]

    # Moving it moves the same task (and a repeat comes along).
    out = await remind(client, ann, n["id"], due=day, time="17:30", repeat="weekly")
    assert out["reminder"]["task_id"] == rem["task_id"] and out["reminder"]["time"] == "17:30" and out["reminder"]["repeat"] == "weekly"
    tasks = await tasks_of(client, ann, rem["task_file_id"])
    assert len([x for x in tasks if x["title"] == "Call the plumber"]) == 1
    assert next(x for x in tasks if x["id"] == rem["task_id"])["repeat"]["freq"] == "weekly"

    # Taking it off deletes the (open) task and the link.
    r = await client.delete(f"/api/notes/{n['id']}/reminder", headers=H(ann))
    assert r.status_code == 200 and r.json()["note"]["reminder"] is None
    assert not any(x["id"] == rem["task_id"] for x in await tasks_of(client, ann, rem["task_file_id"]))
    r = await client.get("/api/connections", headers=H(ann), params={"kind": "note", "id": n["id"]})
    assert r.json()["linked"] == []
    r = await client.get("/api/notes", headers=H(ann), params={"view": "reminders"})
    assert r.json()["notes"] == []


async def test_reminder_input_is_checked(client, people):
    ann, bob, _ = people
    n = await new_note(client, ann)
    for body in ({"due": "tomorrow"}, {"due": tomorrow(), "time": "25:00"}, {"due": tomorrow(), "repeat": "hourly"}, {}):
        r = await client.put(f"/api/notes/{n['id']}/reminder", headers=H(ann), json=body)
        assert r.status_code == 422, body
    # Someone who can't open the note can't put a reminder on it: 404.
    r = await client.put(f"/api/notes/{n['id']}/reminder", headers=H(bob), json={"due": tomorrow()})
    assert r.status_code == 404
    # All day (no time) works: the Tasks default time is its moment.
    out = await remind(client, ann, n["id"], due=tomorrow())
    assert out["reminder"]["time"] is None and "T09:00" in out["reminder"]["at"]


async def test_done_in_tasks_or_on_the_push_clears_the_chip(client, people, live, pushes, db):
    """Ticking the task off (Tasks, or **Done** on the reminder push) clears
    the note's chip, live; a repeating one moves to its next day instead.
    Snooze works and keeps the chip. The push opens the note."""
    from app.items.loops import send_due
    from app.items.models import ItemReminder

    ann, _, _ = people
    n = await new_note(client, ann)
    rem = (await remind(client, ann, n["id"], due=tomorrow(), time="09:00"))["reminder"]
    fid = uuid.UUID(rem["task_file_id"])
    row = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == fid))).scalars().first()
    assert row is not None and row.key.startswith(f"task:{rem['task_id']}:")
    row.due_at = datetime.now(UTC) - timedelta(minutes=1)
    await db.commit()
    pushes.clear()
    assert await send_due(db) >= 1
    push = next(p for p in pushes if p["category"] == "item_reminder")
    assert push["title"] == "Call the plumber" and push["url"] == f"/notes/n/{n['id']}"
    done, snooze = (a["token"] for a in push["extra"]["actions"])

    r = await client.post("/api/notifications/action", json={"token": snooze})
    assert r.status_code == 200 and "in an hour" in r.json()["message"]
    assert (await get(client, ann, n["id"]))["has_reminder"] is True

    live.clear()
    r = await client.post("/api/notifications/action", json={"token": done})
    assert r.status_code == 200 and r.json()["message"].startswith("Completed")
    note = await get(client, ann, n["id"])
    assert note["reminder"] is None and note["has_reminder"] is False
    # Ann's open Notes heard about it straight after the commit.
    for _ in range(20):
        if any(ev["id"] == n["id"] for _, ev in live):
            break
        import asyncio

        await asyncio.sleep(0.05)
    assert ({str(ann.id)}, {"type": "note", "id": n["id"], "revision": note["revision"], "change_seq": note["change_seq"]}) in live
    r = await client.get("/api/notes", headers=H(ann), params={"view": "reminders"})
    assert r.json()["notes"] == []

    # Undo in Tasks (reopen) brings the chip back: the task is the truth.
    r = await client.post(f"/api/items/{fid}/actions/complete_tasks", headers=H(ann), json={"args": {"tasks": [rem["task_id"]], "done": False}})
    assert r.status_code == 200, r.text
    assert (await get(client, ann, n["id"]))["reminder"]["task_id"] == rem["task_id"]

    # A repeating reminder: Done moves it on, the chip follows.
    out = await remind(client, ann, n["id"], due=tomorrow(), time="09:00", repeat="daily")
    r = await client.post(f"/api/items/{fid}/actions/complete_tasks", headers=H(ann), json={"args": {"tasks": [rem["task_id"]]}})
    assert r.status_code == 200, r.text
    moved = (await get(client, ann, n["id"]))["reminder"]
    assert moved is not None and moved["due"] > out["reminder"]["due"]

    # A ticked-off one-off reminder set again makes a fresh task.
    await remind(client, ann, n["id"], due=tomorrow(), time="09:00")
    await client.post(f"/api/items/{fid}/actions/complete_tasks", headers=H(ann), json={"args": {"tasks": [rem["task_id"]]}})
    again = (await remind(client, ann, n["id"], due=tomorrow(), time="10:00"))["reminder"]
    assert again["task_id"] != rem["task_id"]


async def test_deleted_in_tasks_drops_the_reminder(client, people, db):
    ann, _, _ = people
    n = await new_note(client, ann)
    rem = (await remind(client, ann, n["id"], due=tomorrow(), time="08:00"))["reminder"]
    r = await client.post(f"/api/items/{rem['task_file_id']}/actions/delete_tasks", headers=H(ann), json={"args": {"tasks": [rem["task_id"]]}})
    assert r.status_code == 200, r.text
    from app.notes.models import NoteReminder

    ann_id = ann.id
    db.expire_all()
    assert await db.get(NoteReminder, (uuid.UUID(n["id"]), ann_id)) is None
    await db.refresh(ann)
    assert (await get(client, ann, n["id"]))["reminder"] is None
    # Renamed in Tasks: the reminder stays and is still read from the task.
    rem = (await remind(client, ann, n["id"], due=tomorrow(), time="08:00"))["reminder"]
    r = await client.post(f"/api/items/{rem['task_file_id']}/actions/update_task", headers=H(ann), json={"args": {"task": rem["task_id"], "title": "Ring Mario", "due": tomorrow()}})
    assert r.status_code == 200, r.text
    assert (await get(client, ann, n["id"]))["reminder"]["title"] == "Ring Mario"


async def test_reminders_are_each_persons_own_and_go_when_they_leave(client, people, db):
    ann, bob, _ = people
    n = await new_note(client, ann)
    await share(client, ann, n["id"], bob)
    a = (await remind(client, ann, n["id"], due=tomorrow(), time="09:00"))["reminder"]
    b = (await remind(client, bob, n["id"], due=tomorrow(), time="18:00"))["reminder"]
    assert a["task_file_id"] != b["task_file_id"]
    assert (await get(client, ann, n["id"]))["reminder"]["time"] == "09:00"
    assert (await get(client, bob, n["id"]))["reminder"]["time"] == "18:00"
    # Bob can't see Ann's task through the link.
    r = await client.get("/api/connections", headers=H(bob), params={"kind": "note", "id": n["id"]})
    assert all(a["task_id"] not in (x.get("href") or "") for x in r.json()["linked"])

    # Bob leaves: his reminder task goes; Ann's stays.
    r = await client.delete(f"/api/notes/{n['id']}/members/{bob.id}", headers=H(bob))
    assert r.status_code == 200 and r.json() == {"left": True}
    assert not any(t["id"] == b["task_id"] for t in await tasks_of(client, bob, b["task_file_id"]))
    assert any(t["id"] == a["task_id"] for t in await tasks_of(client, ann, a["task_file_id"]))

    # Removed by the owner: the same.
    await share(client, ann, n["id"], bob)
    b = (await remind(client, bob, n["id"], due=tomorrow(), time="18:00"))["reminder"]
    r = await client.delete(f"/api/notes/{n['id']}/members/{bob.id}", headers=H(ann))
    assert r.status_code == 200
    assert not any(t["id"] == b["task_id"] for t in await tasks_of(client, bob, b["task_file_id"]))

    # Deleted for good: everyone's go.
    r = await client.delete(f"/api/notes/{n['id']}/forever", headers=H(ann))
    assert r.status_code == 200
    assert not any(t["id"] == a["task_id"] for t in await tasks_of(client, ann, a["task_file_id"]))


async def test_tasks_turned_off(client, people, db, monkeypatch):
    from app.notes import reminders

    async def off(db):  # noqa: ANN001
        return False

    monkeypatch.setattr(reminders, "tasks_available", off)
    ann, _, _ = people
    n = await new_note(client, ann)
    r = await client.put(f"/api/notes/{n['id']}/reminder", headers=H(ann), json={"due": tomorrow()})
    assert r.status_code == 400 and "Tasks" in r.json()["detail"]


# ------------------------------------------------------------------ sharing


async def test_share_leave_remove_and_live(client, people, live, pushes):
    ann, bob, cat = people
    n = await new_note(client, ann, kind="list", text=None, title="Shopping", items=[{"id": str(uuid.uuid4()), "text": "Eggs"}])
    out = await share(client, ann, n["id"], bob, cat)
    assert sorted(m["user_id"] for m in out["members"]) == sorted([str(bob.id), str(cat.id)])
    assert set(out["users"]) == {str(ann.id), str(bob.id), str(cat.id)}
    assert {p["user_id"] for p in pushes} == {bob.id, cat.id} and all(p["category"] == "notes" for p in pushes)
    # It's on their home straight away, as shared by Ann; members see members.
    for u in (bob, cat):
        r = await client.get("/api/notes", headers=H(u))
        c = next(x for x in r.json()["notes"] if x["id"] == n["id"])
        assert c["is_owner"] is False and c["owner_id"] == str(ann.id) and c["shared"]
        full = await get(client, u, n["id"])
        assert full["can"] == {"edit": True, "share": False, "delete": False, "leave": True}
        r = await client.get(f"/api/notes/{n['id']}/members", headers=H(u))
        assert r.status_code == 200 and len(r.json()["members"]) == 2

    # A member ticks: everyone on the note hears (ids only); the others get the "changed" dot.
    item = (await get(client, bob, n["id"]))["items"][0]
    live.clear()
    r = await client.patch(f"/api/notes/{n['id']}/items/{item['id']}", headers=H(bob), json={"checked": True})
    assert r.status_code == 200
    assert live and live[-1][0] == {str(ann.id), str(bob.id), str(cat.id)} and live[-1][1]["type"] == "note"
    card = lambda u: client.get("/api/notes", headers=H(u))  # noqa: E731
    assert next(x for x in (await card(ann)).json()["notes"] if x["id"] == n["id"])["changed"] is True
    assert next(x for x in (await card(bob)).json()["notes"] if x["id"] == n["id"])["changed"] is False
    # Opening it (seen) clears Ann's dot.
    assert (await client.put(f"/api/notes/{n['id']}/me", headers=H(ann), json={"seen": True})).status_code == 200
    assert next(x for x in (await card(ann)).json()["notes"] if x["id"] == n["id"])["changed"] is False

    # Cat leaves: gone for her (404), the others hear.
    live.clear()
    r = await client.delete(f"/api/notes/{n['id']}/members/{cat.id}", headers=H(cat))
    assert r.status_code == 200 and r.json() == {"left": True}
    assert ({str(cat.id)}, {"type": "gone", "id": n["id"]}) in live
    assert any(ids == {str(ann.id), str(bob.id)} for ids, ev in live if ev["type"] == "note")
    assert (await client.get(f"/api/notes/{n['id']}", headers=H(cat))).status_code == 404
    # The owner removes Bob: everything 404s for him, including ticking.
    r = await client.delete(f"/api/notes/{n['id']}/members/{bob.id}", headers=H(ann))
    assert r.status_code == 200 and r.json()["members"] == []
    assert (await client.patch(f"/api/notes/{n['id']}/items/{item['id']}", headers=H(bob), json={"checked": False})).status_code == 404
    assert (await client.put(f"/api/notes/{n['id']}/reminder", headers=H(bob), json={"due": tomorrow()})).status_code == 404
    # Removing someone who isn't on it.
    assert (await client.delete(f"/api/notes/{n['id']}/members/{bob.id}", headers=H(ann))).status_code == 404


async def test_blocked_people_are_refused_kindly(client, people, db, pushes):
    """``sharing_refused`` → ``blocks.either``: a block either way stops
    sharing. Whoever blocked hears why (and how to undo it); the other
    side is never told about a block."""
    from app.people.blocks import UserBlock

    ann, bob, cat = people
    n = await new_note(client, ann)
    db.add(UserBlock(blocker_id=bob.id, blocked_id=ann.id))  # Bob blocked Ann
    db.add(UserBlock(blocker_id=ann.id, blocked_id=cat.id))  # Ann blocked Cat
    await db.commit()
    r = await client.post(f"/api/notes/{n['id']}/members", headers=H(ann), json={"user_ids": [str(bob.id)]})
    assert r.status_code == 400
    assert r.json()["detail"] == f"{bob.username} can't be added to this note." and "block" not in r.json()["detail"].lower()
    r = await client.post(f"/api/notes/{n['id']}/members", headers=H(ann), json={"user_ids": [str(cat.id)]})
    assert r.status_code == 400 and "You've blocked" in r.json()["detail"] and "Blocked people" in r.json()["detail"]
    # Nothing was added, nobody was pushed (all-or-nothing).
    r = await client.post(f"/api/notes/{n['id']}/members", headers=H(ann), json={"user_ids": [str(cat.id), str(bob.id)]})
    assert r.status_code == 400
    assert (await get(client, ann, n["id"]))["members"] == [] and pushes == []


async def test_shared_push_is_held_in_quiet_hours(client, people, db, monkeypatch):
    """The "X shared a note with you" push is in the holdable ``notes``
    category: quiet hours hold it, and it goes when they end."""
    import json as _json

    import app.notifications.dispatch as d
    import app.notifications.quiet as q
    from app.notifications import loops
    from app.notifications.models import PushHeld, PushPreferences, PushSubscription

    ann, bob, _ = people
    sent: list[dict] = []
    monkeypatch.setattr(d, "_send_one", lambda **kw: sent.append(_json.loads(kw["payload_json"])))

    async def vapid(db):  # noqa: ANN001
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "_vapid", vapid)
    syd = ZoneInfo("Australia/Sydney")
    night = datetime.combine(date(2026, 11, 9), time(23, 15), tzinfo=syd).astimezone(UTC)
    monkeypatch.setattr(q, "_now", lambda: night)
    db.add(PushSubscription(user_id=bob.id, endpoint=f"https://push.invalid/{bob.id}", p256dh="k", auth="a"))
    db.add(PushPreferences(user_id=bob.id, quiet_enabled=True))
    await db.commit()

    n = await new_note(client, ann, title="Shopping")
    await d._dispatch(  # what notes.push.shared_with schedules, awaited here
        user_id=bob.id, category="notes", actor_user_id=ann.id,
        payload=d.PushPayload(title=f"{ann.username} shared “Shopping” with you", body="Open it in Notes.", url=f"/notes/n/{n['id']}",
                              tag=f"notes:share:{n['id']}", category="notes", extra={"app": "notes"}),
    )
    assert sent == []
    held = list((await db.execute(select(PushHeld).where(PushHeld.user_id == bob.id))).scalars())
    assert [h.category for h in held] == ["notes"] and held[0].reason == "quiet"
    out = await loops.run_once(db, datetime.combine(date(2026, 11, 10), time(7, 1), tzinfo=syd).astimezone(UTC))
    assert out["released"] == 1 and sent and sent[0]["category"] == "notes" and sent[0]["url"] == f"/notes/n/{n['id']}"


async def test_the_share_route_sends_the_notes_push(client, people, monkeypatch):
    """The route itself goes through ``notify_user`` in category ``notes``
    with the actor set (so blocks and quiet hours apply centrally)."""
    import app.notifications.dispatch as d

    seen: list[dict] = []

    async def fake_dispatch(**kw):
        seen.append(kw)
        return {}

    monkeypatch.setattr(d, "_dispatch", fake_dispatch)
    ann, bob, _ = people
    n = await new_note(client, ann, title="Shopping")
    await share(client, ann, n["id"], bob)
    import asyncio

    for _ in range(20):
        if seen:
            break
        await asyncio.sleep(0.05)
    assert seen and seen[0]["category"] == "notes" and seen[0]["actor_user_id"] == ann.id and seen[0]["user_id"] == bob.id
