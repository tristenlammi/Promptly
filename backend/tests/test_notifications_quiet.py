"""Quiet hours and the daily summary (0320): the window across midnight and
in the person's own time zone, the weekend pair, the categories that always
get through, held pushes released once when quiet hours end (one push per
app), the daily summary (counts only — never anyone's text), the Today
morning push carrying it, and the settings endpoint."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import select

UTC = timezone.utc
SYD = ZoneInfo("Australia/Sydney")
LON = ZoneInfo("Europe/London")


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


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
def sent(monkeypatch):
    """Every push that reached the (fake) push service: one entry per device."""
    import app.notifications.dispatch as d

    out: list[dict] = []

    def fake_send_one(**kw):
        out.append(json.loads(kw["payload_json"]))

    async def fake_vapid(db):
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "_send_one", fake_send_one)
    monkeypatch.setattr(d, "_vapid", fake_vapid)
    return out


@pytest.fixture
def clock(monkeypatch):
    """Set "now" for quiet-hours decisions in dispatch."""
    import app.notifications.quiet as q

    state = {"now": datetime(2026, 11, 9, 12, 0, tzinfo=UTC)}
    monkeypatch.setattr(q, "_now", lambda: state["now"])
    return state


async def mk_user(db, name: str, tz: str = "Australia/Sydney", **settings):
    from app.auth.models import User
    from app.notifications.models import PushSubscription

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user", settings={"timezone": tz, **settings})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    db.add(PushSubscription(user_id=u.id, endpoint=f"https://push.invalid/{u.id}", p256dh="k", auth="a"))
    await db.commit()
    return u


async def set_prefs(db, u, **kw):
    from app.notifications.models import PushPreferences

    row = await db.get(PushPreferences, u.id)
    if row is None:
        row = PushPreferences(user_id=u.id)
        db.add(row)
    for k, v in kw.items():
        setattr(row, k, v)
    await db.commit()
    return row


async def push(u, category="room_message", title="Sam", body="hello", actor=None, **kw):
    from app.notifications.dispatch import PushPayload, _dispatch

    return await _dispatch(
        user_id=u.id, category=category, actor_user_id=actor.id if actor else None,
        payload=PushPayload(title=title, body=body, url=kw.pop("url", "/rooms/r/1"), tag=kw.pop("tag", None), category=category, extra=kw.pop("extra", None)),
        **kw,
    )


def at(tz: ZoneInfo, d: date, hh: int, mm: int = 0) -> datetime:
    return datetime.combine(d, time(hh, mm), tzinfo=tz).astimezone(UTC)


async def held(db, u):
    from app.notifications.models import PushHeld

    return list((await db.execute(select(PushHeld).where(PushHeld.user_id == u.id).execution_options(populate_existing=True))).scalars())


# ------------------------------------------------------------------ the window


def _prefs(**kw):
    from app.notifications.models import PushPreferences

    p = PushPreferences(user_id=uuid.uuid4(), quiet_enabled=True, quiet_start=time(22, 0), quiet_end=time(7, 0))
    for k, v in kw.items():
        setattr(p, k, v)
    return p


def test_quiet_window_across_midnight_in_own_time_zone():
    from app.notifications.quiet import is_quiet, quiet_until

    p = _prefs()
    mon = date(2026, 11, 9)
    # Sydney evening and early morning are quiet; midday isn't.
    assert is_quiet(p, at(SYD, mon, 22, 0), SYD)
    assert is_quiet(p, at(SYD, mon, 23, 59), SYD)
    assert is_quiet(p, at(SYD, mon, 0, 30), SYD)
    assert is_quiet(p, at(SYD, mon, 6, 59), SYD)
    assert not is_quiet(p, at(SYD, mon, 7, 0), SYD)
    assert not is_quiet(p, at(SYD, mon, 12, 0), SYD)
    assert not is_quiet(p, at(SYD, mon, 21, 59), SYD)
    # Ends at 07:00 the next morning, local.
    assert quiet_until(p, at(SYD, mon, 23, 0), SYD) == datetime.combine(mon + timedelta(days=1), time(7, 0), tzinfo=SYD)
    # The same instant is quiet in Sydney and not in London (it's midday there).
    instant = at(SYD, mon, 23, 0)
    assert instant.astimezone(LON).hour == 12
    assert is_quiet(p, instant, SYD) and not is_quiet(p, instant, LON)
    # A daytime window (no midnight) works too; off and zero-length never hold.
    day = _prefs(quiet_start=time(13, 0), quiet_end=time(15, 0))
    assert is_quiet(day, at(LON, mon, 14, 0), LON) and not is_quiet(day, at(LON, mon, 15, 0), LON)
    assert not is_quiet(_prefs(quiet_enabled=False), at(SYD, mon, 23, 0), SYD)
    assert not is_quiet(_prefs(quiet_start=time(7, 0)), at(SYD, mon, 7, 0), SYD)


def test_weekend_pair_for_friday_and_saturday_nights():
    from app.notifications.quiet import is_quiet

    p = _prefs(quiet_weekend_start=time(23, 30), quiet_weekend_end=time(9, 0))
    fri, sat, sun = date(2026, 11, 13), date(2026, 11, 14), date(2026, 11, 15)
    assert fri.weekday() == 4
    # Friday night ends on Saturday: the weekend pair.
    assert not is_quiet(p, at(SYD, fri, 22, 30), SYD)
    assert is_quiet(p, at(SYD, fri, 23, 45), SYD)
    assert is_quiet(p, at(SYD, sat, 8, 30), SYD)
    assert not is_quiet(p, at(SYD, sat, 9, 0), SYD)
    # Sunday night ends on Monday: the weekday pair again.
    assert is_quiet(p, at(SYD, sun, 22, 30), SYD)
    assert not is_quiet(p, at(SYD, date(2026, 11, 16), 7, 30), SYD)
    # Thursday night ends on Friday: weekday.
    assert is_quiet(p, at(SYD, date(2026, 11, 12), 22, 30), SYD)


def test_every_category_declares_whether_it_can_be_held():
    from app.notifications.dispatch import CATEGORIES, RULES, SUMMARY_CATEGORIES, rule_for

    assert set(CATEGORIES) <= set(RULES)
    always = {c for c, r in RULES.items() if not r.holdable}
    assert {"calendar", "passwords", "system_alert", "test", "item_reminder"} <= always
    assert RULES["room_message"].holdable and RULES["mail"].holdable
    # Apps add themselves (Forms: form_response); these are the groundwork's.
    assert {"room_message", "mail"} <= set(SUMMARY_CATEGORIES)
    # Something unknown (a future ringing call before it registers) is never held.
    assert rule_for("call").holdable is False


def test_phrase_counts_batches_and_kinds():
    from app.notifications import dispatch
    from app.notifications.models import PushHeld
    from app.notifications.quiet import phrase, summary_line

    mail = [PushHeld(category="mail", title="Bank", body="x"), PushHeld(category="mail", title="12 new emails", body="a@b", extra={"count": 12})]
    assert phrase("mail", mail) == "13 new emails in Mail"
    # An app with per-kind nouns (how Porch will plug in), and a kind it doesn't know.
    rule = dispatch.Rule(True, app="Porch", one="update", many="updates", kinds=(("post", "new post", "new posts"), ("comment", "comment", "comments")))
    dispatch.RULES["porch_test"] = rule
    try:
        rows = [PushHeld(category="porch_test", title="t", body="b", extra={"kind": k}) for k in ("post", "post", "comment", "poke")]
        assert phrase("porch_test", rows) == "2 new posts, 1 comment and 1 update in Porch"
        assert summary_line(rows + mail) == "2 new posts, 1 comment and 1 update in Porch, 13 new emails in Mail"
    finally:
        del dispatch.RULES["porch_test"]


# ------------------------------------------------------------------ holding


async def test_quiet_hours_hold_holdable_and_let_exempt_through(db, sent, clock):
    ann = await mk_user(db, "ann")
    await set_prefs(db, ann, quiet_enabled=True)
    clock["now"] = at(SYD, date(2026, 11, 9), 23, 15)

    r = await push(ann, "room_message", body="are you up?")
    assert r["held"] == 1 and r["delivered"] == 0 and sent == []
    r = await push(ann, "mail", title="Bank", body="Statement")
    assert r["held"] == 1 and sent == []
    # Always through: calendar reminders, Passwords, admin alerts, reminders, the test push.
    for cat in ("calendar", "passwords", "system_alert", "item_reminder", "test"):
        r = await push(ann, cat, title=f"{cat}!", body="now")
        assert r["held"] == 0 and r["delivered"] == 1, cat
    assert [p["title"] for p in sent] == ["calendar!", "passwords!", "system_alert!", "item_reminder!", "test!"]
    rows = await held(db, ann)
    assert sorted(r.category for r in rows) == ["mail", "room_message"] and {r.reason for r in rows} == {"quiet"}
    # Outside quiet hours nothing is held.
    clock["now"] = at(SYD, date(2026, 11, 10), 12, 0)
    r = await push(ann, "room_message", body="lunch?")
    assert r["delivered"] == 1 and r["held"] == 0


async def test_held_released_once_when_quiet_hours_end(db, sent, clock):
    from app.notifications import loops

    ann = await mk_user(db, "ann")
    sam = await mk_user(db, "sam")
    await set_prefs(db, ann, quiet_enabled=True)
    night = date(2026, 11, 9)
    clock["now"] = at(SYD, night, 23, 0)
    await push(ann, "room_message", title="Sam", body="first", actor=sam, extra={"line": "first"})
    await push(ann, "room_message", title="Sam", body="second", actor=sam)
    await push(ann, "mail", title="Bank", body="Your statement", url="/mail/m/1", tag="mail-1")
    assert sent == []

    # Still quiet at 06:30: nothing goes.
    out = await loops.run_once(db, at(SYD, night + timedelta(days=1), 6, 30))
    assert out["released"] == 0 and sent == []
    # 07:01: one push per app — Rooms collapsed, the single mail as it was.
    out = await loops.run_once(db, at(SYD, night + timedelta(days=1), 7, 1))
    assert out["released"] == 2
    rooms = next(p for p in sent if p["category"] == "room_message")
    assert rooms["title"] == "While you were away" and rooms["body"] == "2 new messages in Rooms"
    assert rooms["url"] == "/rooms/r/1" and "first" not in json.dumps(rooms)
    mail = next(p for p in sent if p["category"] == "mail")
    assert mail["title"] == "Bank" and mail["body"] == "Your statement" and mail["url"] == "/mail/m/1"
    assert await held(db, ann) == []
    # A later pass (or a restart): never again.
    await loops.run_once(db, at(SYD, night + timedelta(days=1), 7, 2))
    assert len(sent) == 2


async def test_switched_off_since_or_master_off_drops_held(db, sent, clock):
    from app.notifications import loops

    ann = await mk_user(db, "ann")
    await set_prefs(db, ann, quiet_enabled=True)
    clock["now"] = at(SYD, date(2026, 11, 9), 23, 0)
    await push(ann, "room_message")
    await push(ann, "mail")
    await set_prefs(db, ann, mail=False)
    await loops.run_once(db, at(SYD, date(2026, 11, 10), 7, 5))
    assert [p["category"] for p in sent] == ["room_message"]
    await push(ann, "room_message")  # the dispatch clock still says night: held
    await set_prefs(db, ann, enabled=False)
    await loops.run_once(db, at(SYD, date(2026, 11, 10), 7, 6))
    assert len(sent) == 1 and await held(db, ann) == []


# ------------------------------------------------------------------ daily summary


async def test_daily_summary_counts_only_once_a_day(client, db, sent, clock):
    from app.notifications import loops
    from app.notifications.models import PushHeld

    ann = await mk_user(db, "ann", tz="Europe/London")
    stranger = await mk_user(db, "stranger")
    r = await client.patch("/api/notifications/preferences", headers=H(ann), json={"summary_categories": ["room_message", "mail"]})
    assert r.status_code == 200 and r.json()["summary_categories"] == ["room_message", "mail"]
    day = date(2026, 11, 9)
    clock["now"] = at(LON, day, 6, 0)
    await push(ann, "room_message", title=stranger.username, body="SECRET plan for the party", actor=stranger)
    await push(ann, "room_message", title=stranger.username, body="another secret", actor=stranger)
    await push(ann, "mail", title="Prince", body="Claim your PRIZE")
    # Instant categories still go now.
    await push(ann, "calendar", title="Dentist", body="in 1 hour")
    assert [p["category"] for p in sent] == ["calendar"]
    assert {r.reason for r in await held(db, ann)} == {"summary"}

    # Before the Today summary time (08:00, Today itself off): nothing.
    await loops.run_once(db, at(LON, day, 7, 59))
    assert len(sent) == 1
    out = await loops.run_once(db, at(LON, day, 8, 1))
    assert out["summaries"] == 1 and len(sent) == 2
    s = sent[-1]
    assert s["title"] == "Your daily summary"
    assert s["body"] == "2 new messages in Rooms, 1 new email in Mail"
    blob = json.dumps(s).lower()
    assert "secret" not in blob and "prize" not in blob and stranger.username.lower() not in blob
    assert await held(db, ann) == []

    # One that arrives after the summary waits for tomorrow's.
    clock["now"] = at(LON, day, 9, 0)
    await push(ann, "room_message", body="late")
    await loops.run_once(db, at(LON, day, 9, 1))
    await loops.run_once(db, at(LON, day, 20, 0))
    assert len(sent) == 2 and len(await held(db, ann)) == 1
    await loops.run_once(db, at(LON, day + timedelta(days=1), 8, 0))
    assert len(sent) == 3 and sent[-1]["body"] == "1 new message in Rooms"

    # Quiet-held pushes still waiting at summary time are folded in, once.
    db.add(PushHeld(user_id=ann.id, category="mail", title="x", body="y", reason="quiet",
                    created_at=at(LON, day + timedelta(days=1), 23, 30)))
    db.add(PushHeld(user_id=ann.id, category="room_message", title="x", body="y", reason="summary",
                    created_at=at(LON, day + timedelta(days=1), 23, 0)))
    await db.commit()
    await loops.run_once(db, at(LON, day + timedelta(days=2), 8, 2))
    assert sent[-1]["body"] == "1 new message in Rooms, 1 new email in Mail"
    await loops.run_once(db, at(LON, day + timedelta(days=2), 8, 3))
    assert len(sent) == 4


async def test_summary_waits_for_quiet_hours_to_end(db, sent, clock):
    from app.notifications import loops

    ann = await mk_user(db, "ann", tz="Europe/London")
    await set_prefs(db, ann, quiet_enabled=True, quiet_start=time(22, 0), quiet_end=time(9, 0), summary_categories=["mail"])
    day = date(2026, 11, 10)
    clock["now"] = at(LON, day, 3, 0)
    await push(ann, "mail")
    clock["now"] = at(LON, day, 3, 1)
    await push(ann, "room_message")
    assert sent == []
    # 08:00 is the summary time but it's still quiet.
    await loops.run_once(db, at(LON, day, 8, 5))
    assert sent == []
    # Quiet ends at 09:00: one push carrying both (summary + quiet).
    await loops.run_once(db, at(LON, day, 9, 1))
    assert len(sent) == 1 and sent[0]["body"] == "1 new email in Mail, 1 new message in Rooms"
    await loops.run_once(db, at(LON, day, 9, 2))
    assert len(sent) == 1


async def test_today_morning_push_carries_the_summary(db, sent, clock, monkeypatch):
    from app.notifications import dispatch, loops
    from app.today import push as today_push

    morning: list[dict] = []

    async def fake_notify(**kw):
        morning.append(kw)

    monkeypatch.setattr(dispatch, "notify_user", fake_notify)
    ann = await mk_user(db, "ann", tz="Europe/London", morning_summary={"on": True, "time": "07:30"})
    await set_prefs(db, ann, summary_categories=["room_message"])
    day = date(2026, 11, 11)
    clock["now"] = at(LON, day, 6, 0)
    await push(ann, "room_message", body="private words")
    await push(ann, "room_message", body="more private words")

    # The held loop leaves it to the Today push while that can still go.
    await loops.run_once(db, at(LON, day, 7, 31))
    assert sent == [] and len(await held(db, ann)) == 2
    await today_push.send_due(db, at(LON, day, 7, 31))
    assert len(morning) == 1
    m = morning[0]
    assert m["title"] == "Your daily summary" and m["body"] == "2 new messages in Rooms"
    assert "private" not in json.dumps(m, default=str)
    assert await held(db, ann) == []
    # And the held loop doesn't send a second one.
    await loops.run_once(db, at(LON, day, 7, 40))
    assert sent == []


# ------------------------------------------------------------------ settings


async def test_preferences_quiet_hours_and_summary_settings(client, db):
    ann = await mk_user(db, "ann")
    bob = await mk_user(db, "bob", tz="Europe/London")
    r = await client.get("/api/notifications/preferences", headers=H(ann))
    assert r.status_code == 200
    j = r.json()
    assert j["quiet_enabled"] is False and j["quiet_start"] == "22:00" and j["quiet_end"] == "07:00"
    assert j["quiet_weekend"] is False and j["summary_categories"] == []
    assert {"room_message", "mail"} <= set(j["summary_capable"])
    assert j["timezone"] == "Australia/Sydney" and j["summary_time"] == "08:00"

    r = await client.patch("/api/notifications/preferences", headers=H(ann),
                           json={"quiet_enabled": True, "quiet_start": "21:30", "quiet_end": "06:45", "quiet_weekend": True})
    j = r.json()
    assert j["quiet_enabled"] and j["quiet_start"] == "21:30" and j["quiet_end"] == "06:45"
    assert j["quiet_weekend"] and j["quiet_weekend_start"] == "21:30" and j["quiet_weekend_end"] == "06:45"
    j = (await client.patch("/api/notifications/preferences", headers=H(ann), json={"quiet_weekend_end": "09:30"})).json()
    assert j["quiet_weekend_end"] == "09:30" and j["quiet_end"] == "06:45"
    j = (await client.patch("/api/notifications/preferences", headers=H(ann), json={"quiet_weekend": False})).json()
    assert j["quiet_weekend"] is False and j["quiet_weekend_start"] is None
    # Bad input.
    assert (await client.patch("/api/notifications/preferences", headers=H(ann), json={"quiet_start": "25:00"})).status_code == 422
    r = await client.patch("/api/notifications/preferences", headers=H(ann), json={"summary_categories": ["calendar"]})
    assert r.status_code == 400
    # Each person's own: Bob's settings are untouched.
    j = (await client.get("/api/notifications/preferences", headers=H(bob))).json()
    assert j["quiet_enabled"] is False and j["quiet_start"] == "22:00" and j["timezone"] == "Europe/London"
    assert (await client.get("/api/notifications/preferences")).status_code == 401
