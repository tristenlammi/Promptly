"""Calendar events reaching out: photos from an event (and an album of
them), "starting in 1 hour" posts in rooms, guests invited by email who
answer from a public link, and acting straight from a notification."""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from tests.test_calendar import H, add, client, mk_user, people, pushes  # noqa: F401
from tests.test_rooms import make_space

UTC = timezone.utc


@pytest.fixture
def spawned(monkeypatch):
    """Background work (room pushes, emails) collected instead of run."""
    got: list = []
    import app.background as bg

    def fake(coro, name=None):
        got.append((name or "", coro))

    import app.rooms.router as rooms_router

    monkeypatch.setattr(bg, "spawn", fake)
    monkeypatch.setattr(rooms_router, "spawn", lambda coro, name=None: coro.close())
    yield got
    for _name, coro in got:
        coro.close()


@pytest.fixture
async def smtp(db, monkeypatch):
    """SMTP "configured", every email captured."""
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.calendars import reach

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.smtp_host, row.smtp_port, row.smtp_from_address = "smtp.test", 587, "promptly@example.net"
    row.public_origins = ["https://promptly.example.net"]
    await db.commit()
    sent: list[dict] = []

    async def fake(db, **kw):
        sent.append(kw)

    monkeypatch.setattr(reach, "send_mail", fake)
    return sent


async def _run_spawned(spawned, prefix: str) -> None:
    for name, coro in [x for x in spawned if x[0].startswith(prefix)]:
        spawned.remove((name, coro))
        await coro


# ------------------------------------------------------------------ photos


async def _photo(db, user, when: datetime) -> str:
    from app.files.models import FileMedia, UserFile
    from app.files.system_folders import ensure_camera_uploads
    from app.photos.library import sync

    folder = await ensure_camera_uploads(db, user)
    fid = uuid.uuid4()
    db.add(UserFile(id=fid, user_id=user.id, folder_id=folder.id, filename=f"{fid.hex[:6]}.jpg", original_filename="p.jpg",
                    mime_type="image/jpeg", size_bytes=10, storage_path=f"x/{fid}.jpg"))
    await db.flush()
    db.add(FileMedia(file_id=fid, kind="image", taken_at=when, extracted_at=datetime.now(UTC)))
    await db.flush()
    await sync(db, fid)
    await db.commit()
    return str(fid)


async def test_photos_from_an_event_are_yours_and_in_its_window(client, db, people, pushes):
    ann, bob, cat = people
    day = (datetime.now(UTC) - timedelta(days=3)).replace(hour=10, minute=0, second=0, microsecond=0)
    ev = await add(client, ann, title="Picnic", start=day.isoformat(), end=(day + timedelta(hours=2)).isoformat(), guests=[str(bob.id)])
    eid = ev["event_id"]
    inside = [await _photo(db, ann, day - timedelta(minutes=30)), await _photo(db, ann, day + timedelta(hours=3, minutes=30))]
    await _photo(db, ann, day + timedelta(hours=5))  # too late
    await _photo(db, ann, day - timedelta(days=1))  # the day before
    bobs = await _photo(db, bob, day + timedelta(minutes=30))

    r = await client.get(f"/api/calendar/events/{eid}/photos", headers=H(ann))
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["started"] and got["count"] == 2 and [p["id"] for p in got["items"]] == inside
    assert bobs not in r.text and got["album"] is None
    # A guest sees only their own.
    got = (await client.get(f"/api/calendar/events/{eid}/photos", headers=H(bob))).json()
    assert [p["id"] for p in got["items"]] == [bobs]
    # Not started yet: nothing to show.
    soon = datetime.now(UTC) + timedelta(days=2)
    later = await add(client, ann, title="Later", start=soon.isoformat(), end=(soon + timedelta(hours=1)).isoformat())
    got = (await client.get(f"/api/calendar/events/{later['event_id']}/photos", headers=H(ann))).json()
    assert got["started"] is False and got["items"] == []
    # Free/busy only: no photos (no event at all).
    cal = (await client.get("/api/calendar/bootstrap", headers=H(ann))).json()["calendars"][0]["id"]
    await client.post(f"/api/calendar/calendars/{cal}/members", headers=H(ann), json={"user_ids": [str(cat.id)], "role": "busy"})
    assert (await client.get(f"/api/calendar/events/{eid}/photos", headers=H(cat))).status_code == 404
    assert (await client.post(f"/api/calendar/events/{eid}/album", headers=H(cat), json={})).status_code == 404


async def test_all_day_event_takes_its_days(client, db, people, pushes):
    ann, _bob, _cat = people
    d = (datetime.now(UTC) - timedelta(days=10)).date()
    ev = await add(client, ann, title="Beach day", all_day=True, start=d.isoformat(), end=d.isoformat())
    noon = datetime(d.year, d.month, d.day, 12, tzinfo=UTC)
    a = await _photo(db, ann, noon)
    await _photo(db, ann, noon + timedelta(days=1))
    got = (await client.get(f"/api/calendar/events/{ev['event_id']}/photos", headers=H(ann))).json()
    assert [p["id"] for p in got["items"]] == [a]


async def test_make_an_album_from_an_event(client, db, people, pushes):
    from app.calendars.models import CalEvent
    from app.photos.album_models import Album, AlbumItem

    ann, bob, _ = people
    day = (datetime.now(UTC) - timedelta(days=2)).replace(hour=15, minute=0, second=0, microsecond=0)
    ev = await add(client, ann, title="Birthday party", start=day.isoformat(), end=(day + timedelta(hours=3)).isoformat(), guests=[str(bob.id)])
    eid = ev["event_id"]
    # None of yours yet.
    r = await client.post(f"/api/calendar/events/{eid}/album", headers=H(ann), json={})
    assert r.status_code == 400 and "no photos" in r.json()["detail"]
    ids = {await _photo(db, ann, day + timedelta(minutes=m)) for m in (10, 50, 90)}
    r = await client.post(f"/api/calendar/events/{eid}/album", headers=H(ann), json={})
    assert r.status_code == 201, r.text
    album = r.json()["album"]
    assert album["title"] == "Birthday party" and album["count"] == 3
    items = set((await db.execute(select(AlbumItem.file_id).where(AlbumItem.album_id == uuid.UUID(album["id"])))).scalars())
    assert {str(i) for i in items} == ids
    assert str((await db.execute(select(CalEvent.album_id).where(CalEvent.id == uuid.UUID(eid)))).scalar()) == album["id"]
    got = (await client.get(f"/api/calendar/events/{eid}/photos", headers=H(ann))).json()
    assert got["album"]["id"] == album["id"]
    # bob can't open ann's album: he sees none (and can make his own).
    assert (await client.get(f"/api/calendar/events/{eid}/photos", headers=H(bob))).json()["album"] is None
    await _photo(db, bob, day + timedelta(minutes=20))
    r = await client.post(f"/api/calendar/events/{eid}/album", headers=H(bob), json={})
    assert r.status_code == 201
    theirs = r.json()["album"]["id"]
    assert (await client.get(f"/api/calendar/events/{eid}/photos", headers=H(bob))).json()["album"]["id"] == theirs
    assert str((await db.execute(select(CalEvent.album_id).where(CalEvent.id == uuid.UUID(eid)))).scalar()) == album["id"]  # the event keeps the first
    assert (await db.execute(select(Album.owner_id).where(Album.id == uuid.UUID(theirs)))).scalar() == bob.id


# ------------------------------------------------------------------ rooms


async def test_room_reminder_posts_once_and_can_be_turned_off(client, db, people, pushes, spawned):
    from app.calendars.reach import send_room_due

    ann, bob, cat = people
    _sid, rid = await make_space(client, ann, bob, cat)
    r = await client.post("/api/calendar/events", headers=H(ann), json={
        "title": "BBQ @everyone", "start": "2026-12-14T03:00:00Z", "end": "2026-12-14T06:00:00Z", "room_id": rid,
    })
    eid = r.json()["event"]["event_id"]
    await client.post(f"/api/calendar/events/{eid}/rsvp", headers=H(bob), json={"status": "going"})
    detail = (await client.get(f"/api/calendar/events/{eid}", headers=H(ann))).json()["event"]
    assert detail["room_links"] == [{"room_id": rid, "remind_minutes": 60, "can_change": True}]

    assert await send_room_due(db, now=datetime(2026, 12, 14, 1, 30, tzinfo=UTC)) == 0  # not yet
    assert await send_room_due(db, now=datetime(2026, 12, 14, 2, 0, 30, tzinfo=UTC)) == 1
    assert await send_room_due(db, now=datetime(2026, 12, 14, 2, 1, tzinfo=UTC)) == 0  # once
    msgs = (await client.get(f"/api/rooms/rooms/{rid}/messages", headers=H(bob))).json()
    msgs = msgs["messages"] if isinstance(msgs, dict) else msgs
    post = [m for m in msgs if m["meta"].get("event_reminder") == eid]
    assert len(post) == 1 and "Starting in 1 hour" in post[0]["body"] and "2 going" in post[0]["body"]
    assert post[0]["author_id"] == str(ann.id) and post[0]["mentions"] == [] and "event_id" not in post[0]["meta"]

    # bob (a guest) can't change it; ann turns it off.
    r = await client.patch(f"/api/calendar/events/{eid}/rooms/{rid}", headers=H(bob), json={"remind_minutes": None})
    assert r.status_code == 403
    assert (await client.patch(f"/api/calendar/events/{eid}/rooms/{rid}", headers=H(ann), json={"remind_minutes": 7})).status_code == 400
    r = await client.patch(f"/api/calendar/events/{eid}/rooms/{rid}", headers=H(ann), json={"remind_minutes": None})
    assert r.status_code == 200
    await client.patch(f"/api/calendar/events/{eid}", headers=H(ann), json={"start": "2026-12-15T03:00:00Z", "end": "2026-12-15T06:00:00Z"})
    assert await send_room_due(db, now=datetime(2026, 12, 15, 2, 0, 30, tzinfo=UTC)) == 0


# ------------------------------------------------------------------ email guests


async def test_invite_by_email_and_answer_from_the_link(client, db, people, pushes, smtp, spawned):
    ann, bob, _ = people
    ev = await add(client, ann, title="Dinner", location="Our place", guests=[str(bob.id)])
    eid = ev["event_id"]

    r = await client.get("/api/calendar/email-check", headers=H(ann), params={"email": "Pat@Example.org"})
    assert r.json() == {"email": "pat@example.org", "valid": True, "user": None, "can_email": True}
    r = await client.get("/api/calendar/email-check", headers=H(ann), params={"email": bob.email})
    assert r.json()["user"]["id"] == str(bob.id)
    assert (await client.get("/api/calendar/email-check", headers=H(ann), params={"email": "nope"})).json()["valid"] is False

    # Only the organiser invites; Promptly people are invited normally.
    assert (await client.post(f"/api/calendar/events/{eid}/email-guests", headers=H(bob), json={"emails": ["x@example.org"]})).status_code == 403
    r = await client.post(f"/api/calendar/events/{eid}/email-guests", headers=H(ann), json={"emails": [bob.email]})
    assert r.status_code == 400 and "on Promptly" in r.json()["detail"]
    assert (await client.post(f"/api/calendar/events/{eid}/email-guests", headers=H(ann), json={"emails": ["not an email"]})).status_code == 400

    r = await client.post(f"/api/calendar/events/{eid}/email-guests", headers=H(ann), json={"emails": ["Pat@Example.org", "quinn@example.org"]})
    assert r.status_code == 201, r.text
    assert [g["email"] for g in r.json()["guests"]] == ["pat@example.org", "quinn@example.org"]
    assert [m["to"] for m in smtp] == ["pat@example.org", "quinn@example.org"]
    pat = smtp[0]
    name, ctype, ics = pat["attachments"][0]
    assert name == "invite.ics" and ctype == "text/calendar; method=REQUEST"
    assert "METHOD:REQUEST" in ics and "mailto:pat@example.org" in ics and "SUMMARY:Dinner" in ics
    assert pat["subject"].startswith("Invitation: Dinner")
    assert "https://promptly.example.net/calendar/answer/" in pat["text_body"]
    # Nobody else's address in it.
    assert "quinn" not in pat["text_body"] + pat["html_body"] + ics and bob.email not in pat["text_body"] + ics
    token = pat["text_body"].split("/calendar/answer/")[1].split("?")[0]

    # Shown in the event: the organiser sees addresses, a guest a hint.
    detail = (await client.get(f"/api/calendar/events/{eid}", headers=H(ann))).json()["event"]
    assert [(g["email"], g["status"]) for g in detail["email_guests"]] == [("pat@example.org", "invited"), ("quinn@example.org", "invited")]
    masked = (await client.get(f"/api/calendar/events/{eid}", headers=H(bob))).json()["event"]["email_guests"]
    assert masked[0]["email"] == "p•••@example.org"

    # The public page: no sign-in, the event and nothing of other guests.
    r = await client.get(f"/api/calendar/answer/{token}")
    assert r.status_code == 200 and r.json()["title"] == "Dinner" and r.json()["status"] == "invited"
    assert "quinn" not in r.text and bob.email not in r.text
    pushes.clear()
    r = await client.post(f"/api/calendar/answer/{token}", json={"status": "going"})
    assert r.status_code == 200 and r.json()["status"] == "going"
    assert [p["user_id"] for p in pushes] == [ann.id] and pushes[0]["title"] == "pat@example.org is going to"
    assert (await client.get("/api/calendar/answer/not-a-real-token")).status_code == 404

    # A change emails them (in the background).
    smtp.clear()
    await client.patch(f"/api/calendar/events/{eid}", headers=H(ann), json={"start": "2026-11-08T18:00:00Z", "end": "2026-11-08T20:00:00Z"})
    await _run_spawned(spawned, "cal-email-update")
    assert sorted(m["to"] for m in smtp) == ["pat@example.org", "quinn@example.org"]
    assert smtp[0]["subject"].startswith("Changed: Dinner")

    # Uninvited: a cancellation, and the link stops working.
    smtp.clear()
    qid = detail["email_guests"][1]["id"]
    assert (await client.delete(f"/api/calendar/events/{eid}/email-guests/{qid}", headers=H(ann))).status_code == 204
    await _run_spawned(spawned, "cal-email-cancel")
    assert [m["to"] for m in smtp] == ["quinn@example.org"] and "METHOD:CANCEL" in smtp[0]["attachments"][0][2]

    # Deleted: pat hears, and the page is gone.
    smtp.clear()
    assert (await client.delete(f"/api/calendar/events/{eid}", headers=H(ann))).status_code == 204
    await _run_spawned(spawned, "cal-email-cancel")
    assert [m["to"] for m in smtp] == ["pat@example.org"] and smtp[0]["subject"] == "Cancelled: Dinner"
    assert (await client.get(f"/api/calendar/answer/{token}")).status_code == 404


async def test_invite_by_email_needs_smtp(client, db, people, pushes):
    ann, _, _ = people
    ev = await add(client, ann)
    assert (await client.get("/api/calendar/email-check", headers=H(ann), params={"email": "a@b.org"})).json()["can_email"] is False
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/email-guests", headers=H(ann), json={"emails": ["a@b.org"]})
    assert r.status_code == 400 and "can't send email" in r.json()["detail"]


# ------------------------------------------------------------------ notification buttons


async def test_invite_push_buttons_answer_without_a_session(client, db, people, pushes):
    from app.notifications import actions

    ann, bob, cat = people
    ev = await add(client, ann, guests=[str(bob.id)])
    extra = pushes[0]["extra"]
    assert [a["action"] for a in extra["actions"]] == ["cal_going", "cal_declined"]
    going = extra["actions"][0]["token"]

    r = await client.post("/api/notifications/action", json={"token": going})
    assert r.status_code == 200, r.text
    assert r.json()["message"] == "You're going to Dinner"
    got = (await client.get(f"/api/calendar/events/{ev['event_id']}", headers=H(bob))).json()["event"]
    assert got["my_status"] == "going"
    assert any(p["user_id"] == ann.id and "is going to" in p["title"] for p in pushes)

    # Tampered, expired, for someone it doesn't fit, or after "sign out everywhere".
    raw, mac = going.split(".")
    assert (await client.post("/api/notifications/action", json={"token": raw + "." + mac[::-1]})).status_code == 401
    old = actions.sign(bob, "cal_declined", ev["event_id"], now=time.time() - 8 * 24 * 3600)
    assert (await client.post("/api/notifications/action", json={"token": old})).status_code == 401
    stranger = actions.sign(cat, "cal_going", ev["event_id"])
    assert (await client.post("/api/notifications/action", json={"token": stranger})).status_code == 410
    bob.token_version = (bob.token_version or 0) + 1
    await db.commit()
    assert (await client.post("/api/notifications/action", json={"token": going})).status_code == 401


def test_tokens_are_scoped():
    from app.notifications import actions

    class U:
        id = uuid.uuid4()
        token_version = 0

    tok = actions.sign(U, "task_done", "f|t")
    claims = actions.verify(tok)
    assert (claims["u"], claims["a"], claims["t"]) == (str(U.id), "task_done", "f|t")
    with pytest.raises(actions.ActionRefused):
        actions.verify(tok, now=time.time() + 8 * 24 * 3600)
    assert actions.task_buttons(U, uuid.uuid4(), "digest:2026-11-02") is None
    b = actions.task_buttons(U, uuid.uuid4(), "snooze:123:task:abc:2026-11-02:0")
    assert [x["action"] for x in b["actions"]] == ["task_done", "task_snooze"]
    assert actions.verify(b["actions"][0]["token"])["t"].endswith("|abc")


async def test_task_reminder_done_and_snooze(client, db, people, pushes):
    from app.items.loops import send_due
    from app.items.models import ItemReminder

    ann, _, _ = people
    assert (await client.post("/api/items/store/tasks", headers=H(ann))).status_code == 200
    fid = (await client.post("/api/items", headers=H(ann), json={"kind": "tasks", "title": "My tasks"})).json()["file_id"]
    soon = (datetime.now(UTC) + timedelta(days=2)).date().isoformat()
    r = await client.post(f"/api/items/{fid}/actions/add_tasks", headers=H(ann), json={"args": {"tasks": [{"title": "Water plants", "due": soon, "time": "12:00"}]}})
    assert r.status_code == 200, r.text
    rem = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().first()
    rem.due_at = datetime.now(UTC) - timedelta(minutes=1)
    await db.commit()
    pushes.clear()
    assert await send_due(db) >= 1
    push = next(p for p in pushes if p["title"] == "Water plants")
    done, snooze = (a["token"] for a in push["extra"]["actions"])

    r = await client.post("/api/notifications/action", json={"token": snooze})
    assert r.status_code == 200 and "in an hour" in r.json()["message"]
    snoozed = (await db.execute(select(ItemReminder).where(ItemReminder.key.startswith("snooze:")))).scalars().all()
    assert len(snoozed) == 1 and snoozed[0].sent_at is None and snoozed[0].title == "Water plants"

    r = await client.post("/api/notifications/action", json={"token": done})
    assert r.status_code == 200 and r.json()["message"].startswith("Completed")
    data = (await client.get(f"/api/items/{fid}", headers=H(ann))).json()["data"]
    assert data["tasks"][0]["done"] is True
    # Saving the file recomputed its reminders — the snooze stayed.
    db.expire_all()
    assert (await db.execute(select(ItemReminder).where(ItemReminder.key.startswith("snooze:")))).scalars().all()


async def test_event_reminder_has_snooze(db, people, pushes):
    from app.calendars import notify
    from app.calendars.models import CalEvent

    ann, _, _ = people
    start = datetime.now(UTC) + timedelta(minutes=30)
    ev = CalEvent(id=uuid.uuid4(), calendar_id=uuid.uuid4(), title="Call", start_at=start, end_at=start + timedelta(hours=1), tz="UTC")
    await notify.reminder(ann, ev, start, 30)
    assert [a["action"] for a in pushes[-1]["extra"]["actions"]] == ["cal_snooze"]
    await notify.reminder(ann, ev, datetime.now(UTC) + timedelta(minutes=5), 5)
    assert pushes[-1]["extra"] is None


async def test_answer_page_get_does_not_record_post_does(client, db, people, pushes, smtp):
    """Email link scanners and prefetchers open links: GET (even with the
    email's ``?a=going``) only shows the invite; the click's POST answers."""
    from app.calendars.models import CalExternalGuest

    ann, _, _ = people
    ev = await add(client, ann, title="Picnic")
    r = await client.post(f"/api/calendar/events/{ev['event_id']}/email-guests", headers=H(ann), json={"emails": ["pat@example.org"]})
    assert r.status_code == 201, r.text
    token = smtp[0]["text_body"].split("/calendar/answer/")[1].split("?")[0]
    assert f"/calendar/answer/{token}?a=going" in smtp[0]["text_body"]  # old-style links still carry a suggestion

    pushes.clear()
    for _ in range(2):
        r = await client.get(f"/api/calendar/answer/{token}", params={"a": "going"})
        assert r.status_code == 200 and r.json()["status"] == "invited"
    g = (await db.execute(select(CalExternalGuest).where(CalExternalGuest.token == token))).scalar_one()
    await db.refresh(g)
    assert g.status == "invited" and g.responded_at is None and pushes == []

    r = await client.post(f"/api/calendar/answer/{token}", json={"status": "maybe"})
    assert r.status_code == 200 and r.json()["status"] == "maybe"
    await db.refresh(g)
    assert g.status == "maybe" and g.responded_at is not None
    assert [p["user_id"] for p in pushes] == [ann.id]
    assert (await client.post(f"/api/calendar/answer/{token}", json={"status": "sure"})).status_code == 422


async def test_event_snooze_is_saved_and_survives_a_restart(client, db, people, pushes, monkeypatch):
    from app.calendars import loops, recur
    from app.calendars.models import CalEventSnooze
    from app.notifications import actions
    import app.background as bg

    # Nothing may be parked in memory: the snooze lives in the table only.
    monkeypatch.setattr(bg, "spawn", lambda coro, name=None: (coro.close(), pytest.fail("snooze spawned a task")))
    ann, _, _ = people
    start = (datetime.now(UTC) + timedelta(hours=2)).replace(second=0, microsecond=0)
    ev = await add(client, ann, title="Call", start=recur.stamp(start), end=recur.stamp(start + timedelta(hours=1)), reminders=[])
    target = f"{ev['event_id']}|{recur.stamp(start)}"

    before = datetime.now(UTC)
    r = await client.post("/api/notifications/action", json={"token": actions.sign(ann, "cal_snooze", target)})
    assert r.status_code == 200, r.text
    assert r.json()["message"] == "I'll remind you about Call in 10 minutes"
    # Snoozing again moves it rather than doubling it.
    r = await client.post("/api/notifications/action", json={"token": actions.sign(ann, "cal_snooze", target)})
    assert r.status_code == 200, r.text
    rows = (await db.execute(select(CalEventSnooze))).scalars().all()
    assert len(rows) == 1 and rows[0].user_id == ann.id and rows[0].occurrence == start
    until = rows[0].until
    assert before + timedelta(minutes=9) < until < datetime.now(UTC) + timedelta(minutes=11)

    # "Restart": a fresh look at the database is all there is.
    db.expire_all()
    pushes.clear()
    assert await loops.send_due(db, now=until - timedelta(minutes=1)) == 0
    assert pushes == []
    assert await loops.send_due(db, now=until + timedelta(seconds=5)) == 1
    assert [p["title"] for p in pushes] == ["Call"]
    assert pushes[0]["body"].startswith("In 1 h 4") or pushes[0]["body"].startswith("In 1 h 5")
    # Sent once, and the row is gone.
    assert (await db.execute(select(CalEventSnooze))).scalars().all() == []
    assert await loops.send_due(db, now=until + timedelta(seconds=40)) == 0
    assert len(pushes) == 1

    # One that came due while the server was down too long is dropped, not sent late.
    r = await client.post("/api/notifications/action", json={"token": actions.sign(ann, "cal_snooze", target)})
    until = (await db.execute(select(CalEventSnooze.until))).scalar_one()
    assert await loops.send_due(db, now=until + timedelta(minutes=30)) == 0
    assert len(pushes) == 1 and (await db.execute(select(CalEventSnooze))).scalars().all() == []
