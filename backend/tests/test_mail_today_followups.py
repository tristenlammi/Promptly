"""Mail tells you the moment mail arrives (IDLE, with the timer as the net),
and hands Today a stay it's sure of: marked as from an email, added only when
you tap, gone for good when dismissed, and never beside the calendar event it
became. Plus Today's own: new accounts start without three cards, the
greeting follows your clock, and Health shows only what you log. All mail
here is made up."""
from __future__ import annotations

import asyncio
import threading
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.mail import bookings, imap, worker
from app.mail.models import MailFolder

from .test_mail_ask import H, _msg, client, mk_account, mk_user  # noqa: F401

SENT = date(2026, 11, 10)
TODAY = date(2026, 11, 14)
NELLY = (
    "Hi Tristen,\n\nThanks for booking The Nelly. Your reservation details:\n\n"
    "Check-in: Fri 20 Nov 2026 (after 3PM)\nCheck-out: Sun 22 Nov 2026 (by 10AM)\n"
    "Address: 342 Palmwoods-Montville Road, Palmwoods\n\nLockbox code 4410.\n"
)


# ---------------------------------------------------------------- bookings: reading


def test_a_stay_with_both_days_written_out_is_read():
    got = bookings.read("Booking confirmation - The Nelly", NELLY, "The Nelly", SENT, TODAY)
    assert got == {"title": "The Nelly", "start": "2026-11-20", "end": "2026-11-22", "nights": 2, "location": "342 Palmwoods-Montville Road, Palmwoods"}


@pytest.mark.parametrize(
    "body",
    [
        "Your booking. Check-in is after 3PM, check-out by 10AM.",  # no days at all
        "Your booking. Check-in: 03/04/2027. Check-out: 05/04/2027.",  # which is the month?
        "Your booking. Check-in: Mon 20 Nov 2026. Check-out: Sun 22 Nov 2026.",  # the 20th is a Friday
        "Your booking. Check-in: 20 Nov 2026. Check-out: 19 Nov 2026.",  # out before in
        "Your booking. Check-in: 20 Nov 2026 ... later: check-in 21 Nov 2026. Check-out: 23 Nov 2026.",  # two answers
        "Your booking. Check-in: 2 Nov 2026. Check-out: 4 Nov 2026.",  # already over
    ],
)
def test_anything_less_than_certain_is_left_alone(body):
    assert bookings.read("Booking confirmation", body, "Stayz", SENT, TODAY) is None


def test_an_ordinary_email_with_a_date_is_not_a_booking():
    assert bookings.read("Lunch?", "Are you free on Friday 20 November 2026?", "Sam", SENT, TODAY) is None


def test_a_day_without_a_year_is_the_next_one_and_a_weekday_must_agree():
    got = bookings.read("Booking confirmation", "Your booking is confirmed for Friday 20 November.", "Dentist", SENT, TODAY)
    assert got and got["start"] == got["end"] == "2026-11-20" and got["nights"] == 0
    assert bookings.read("Booking confirmation", "Your booking is confirmed for Monday 20 November.", "Dentist", SENT, TODAY) is None
    # January, written in November, is next January.
    got = bookings.read("Your reservation", "Arrival: 5 January\nDeparture: 8 January", "Hotel", SENT, TODAY)
    assert got and (got["start"], got["end"]) == ("2027-01-05", "2027-01-08")


# ---------------------------------------------------------------- bookings: Today


async def _stay(db, user, **kw):
    account = await mk_account(db, user)
    m = await _msg(db, account, uid=kw.get("uid", 1), subject=kw.get("subject", "Booking confirmation - The Nelly"), body=kw.get("body", _future(NELLY)),
                   sender="The Nelly", addr="stay@nelly.example", sent_at=datetime.now(timezone.utc) - timedelta(days=2))
    await db.commit()
    return account, m


def _future(body: str) -> str:
    """The same email with its days moved to next week, so it's always ahead."""
    start = datetime.now(timezone.utc).date() + timedelta(days=9)
    end = start + timedelta(days=2)
    return body.replace("Fri 20 Nov 2026", start.strftime("%a %d %b %Y")).replace("Sun 22 Nov 2026", end.strftime("%a %d %b %Y"))


@pytest.mark.asyncio
async def test_today_shows_the_stay_as_from_an_email(client, db):  # noqa: F811
    user = await mk_user(db, "stay")
    account, m = await _stay(db, user)
    day = (await client.get("/api/today", headers=H(user))).json()
    start = (datetime.now(timezone.utc).date() + timedelta(days=9)).isoformat()
    assert [(b["title"], b["nights"], b["id"]) for b in day["bookings"]] == [("The Nelly", 2, str(m.id))]
    assert day["bookings"][0]["url"] == f"/mail?open={account.id}/{m.thread_key}"
    assert abs((date.fromisoformat(day["bookings"][0]["start"]) - date.fromisoformat(start)).days) <= 1
    # Nothing was put in the calendar by looking.
    from app.calendars.models import CalEvent
    from sqlalchemy import func, select

    assert await db.scalar(select(func.count()).select_from(CalEvent)) == 0


@pytest.mark.asyncio
async def test_one_tap_adds_it_and_it_isnt_shown_twice(client, db):  # noqa: F811
    user = await mk_user(db, "stay")
    _account, m = await _stay(db, user)
    made = await client.post(f"/api/mail/bookings/{m.id}/calendar", headers=H(user))
    assert made.status_code == 201 and made.json()["url"].startswith("/calendar?event=")
    day = (await client.get("/api/today", headers=H(user))).json()
    assert day["bookings"] == []


@pytest.mark.asyncio
async def test_an_event_you_made_yourself_counts_too(client, db):  # noqa: F811
    from app.calendars import service

    user = await mk_user(db, "stay")
    await _stay(db, user)
    start = (await client.get("/api/today", headers=H(user))).json()["bookings"][0]["start"]
    await service.create_event(db, user, service.EventFields(title="Nelly weekend", start=start, all_day=True), ping_guests=False)
    await db.commit()
    assert (await client.get("/api/today", headers=H(user))).json()["bookings"] == []


@pytest.mark.asyncio
async def test_a_dismissal_sticks_and_survives_saving_other_settings(client, db):  # noqa: F811
    user = await mk_user(db, "stay")
    _account, m = await _stay(db, user)
    assert (await client.post(f"/api/mail/bookings/{m.id}/dismiss", headers=H(user))).status_code == 204
    assert (await client.get("/api/today", headers=H(user))).json()["bookings"] == []
    saved = await client.patch("/api/auth/me/preferences", headers=H(user), json={"today_hidden": ["rooms"]})
    assert saved.status_code == 200, saved.text
    assert (await client.get("/api/today", headers=H(user))).json()["bookings"] == []


@pytest.mark.asyncio
async def test_someone_elses_booking_is_out_of_reach(client, db):  # noqa: F811
    owner, other = await mk_user(db, "owner"), await mk_user(db, "other")
    _account, m = await _stay(db, owner)
    assert (await client.get("/api/today", headers=H(other))).json()["bookings"] == []
    assert (await client.post(f"/api/mail/bookings/{m.id}/calendar", headers=H(other))).status_code == 404
    assert (await client.post(f"/api/mail/bookings/{m.id}/dismiss", headers=H(other))).status_code == 404
    assert len((await client.get("/api/today", headers=H(owner))).json()["bookings"]) == 1


# ---------------------------------------------------------------- IDLE


class FakeIdle:
    """An IMAP connection in IDLE: ``says`` is what each check hears."""

    def __init__(self, says: list[list], capable: bool = True) -> None:
        self.says, self.capable = list(says), capable
        self.idling = False
        self.log: list[str] = []

    def has_capability(self, name: str) -> bool:
        return self.capable and name == "IDLE"

    def idle(self) -> None:
        assert not self.idling, "IDLE asked for twice"
        self.idling = True
        self.log.append("idle")

    def idle_check(self, timeout: float = 0) -> list:
        assert self.idling
        if self.says:
            return self.says.pop(0)
        threading.Event().wait(0.01)
        return []

    def idle_done(self):
        assert self.idling
        self.idling = False
        self.log.append("done")
        return ("Idle terminated", [])

    def logout(self) -> None:
        assert not self.idling, "logged out while still in IDLE"
        self.log.append("logout")


def test_new_mail_ends_the_wait_and_idle_is_always_closed():
    c = FakeIdle([[], [(b"OK", b"Still here")], [(3, b"EXISTS")]])
    assert imap.wait_for_mail(c, threading.Event(), seconds=5) is True
    assert c.log == ["idle", "done"]


def test_a_quiet_inbox_is_asked_again_before_the_server_gives_up():
    c = FakeIdle([])
    assert imap.wait_for_mail(c, threading.Event(), seconds=0.05) is False
    assert c.log == ["idle", "done"]
    assert imap.IDLE_FOR_S < 29 * 60


def test_being_told_to_stop_ends_the_wait():
    stop = threading.Event()
    stop.set()
    c = FakeIdle([[(4, b"EXISTS")]])
    assert imap.wait_for_mail(c, stop, seconds=60) is False and c.log == ["idle", "done"]


def test_a_flag_change_is_not_new_mail():
    c = FakeIdle([[(2, b"FETCH", (b"FLAGS", (b"\\Seen",)))], [(1, b"EXPUNGE")]])
    assert imap.wait_for_mail(c, threading.Event(), seconds=0.05) is False


async def _watched(db, monkeypatch, fake: FakeIdle):
    user = await mk_user(db, "idle")
    account = await mk_account(db, user)
    db.add(MailFolder(account_id=account.id, path="INBOX", name="Inbox", role="inbox"))
    await db.commit()
    connects: list[int] = []

    def connect(_server):
        connects.append(1)
        return fake

    monkeypatch.setattr(imap, "connect", connect)
    monkeypatch.setattr(imap, "select", lambda _c, _path, readonly=True: 1)
    return account, connects


@pytest.mark.asyncio
async def test_the_watcher_wakes_the_sync_with_one_connection_and_tidies_up(db, monkeypatch):
    fake = FakeIdle([[], [(9, b"EXISTS")]])
    account, connects = await _watched(db, monkeypatch, fake)
    wake = asyncio.Event()
    task = asyncio.create_task(worker.watch_inbox(account.id, wake))
    await asyncio.wait_for(wake.wait(), timeout=5)
    await asyncio.sleep(0.05)  # back in IDLE for the next one
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert connects == [1]
    assert fake.log[:2] == ["idle", "done"] and fake.log[-1] == "logout" and not fake.idling


@pytest.mark.asyncio
async def test_a_server_without_idle_is_left_to_the_timer(db, monkeypatch):
    fake = FakeIdle([], capable=False)
    account, connects = await _watched(db, monkeypatch, fake)
    assert await worker._watch_once(account.id, asyncio.Event()) == "no-idle"
    assert fake.log == ["logout"] and connects == [1]
    assert worker.WATCH_RECHECK_S >= 600


@pytest.mark.asyncio
async def test_a_lost_connection_waits_longer_each_time(db, monkeypatch):
    account, _connects = await _watched(db, monkeypatch, FakeIdle([]))
    tries: list[float] = []

    def refuse(_server):
        raise OSError("connection refused")

    async def nap(seconds: float) -> None:
        tries.append(seconds)
        if len(tries) == 4:
            raise asyncio.CancelledError

    monkeypatch.setattr(imap, "connect", refuse)
    monkeypatch.setattr(worker.asyncio, "sleep", nap)
    with pytest.raises(asyncio.CancelledError):
        await worker.watch_inbox(account.id, asyncio.Event())
    assert tries == [10, 20, 40, 80] and worker.WATCH_RETRY_MAX_S == 300


@pytest.mark.asyncio
async def test_a_removed_account_stops_being_watched(db):
    import uuid

    await asyncio.wait_for(worker.watch_inbox(uuid.uuid4(), asyncio.Event()), timeout=5)


# ---------------------------------------------------------------- Today's own


@pytest.mark.asyncio
async def test_a_new_account_starts_without_three_cards_and_can_bring_them_back(client, db):  # noqa: F811
    user = await mk_user(db, "fresh")
    assert user.settings["today_hidden"] == ["passwords", "forms", "automations"]
    # Customise can show them again, and hide them: the server keeps these keys.
    back = await client.patch("/api/auth/me/preferences", headers=H(user), json={"today_hidden": ["forms"]})
    assert back.status_code == 200 and back.json()["settings"]["today_hidden"] == ["forms"]


@pytest.mark.asyncio
async def test_an_account_made_with_its_own_choice_keeps_it(db):
    import uuid

    from app.auth.models import User

    u = User(email=f"own-{uuid.uuid4().hex[:6]}@example.com", username=f"own{uuid.uuid4().hex[:4]}", password_hash="x", role="user", settings={"today_hidden": []})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    assert u.settings["today_hidden"] == []


@pytest.mark.parametrize(
    ("hour", "want"),
    [(0, "Good evening, Sam"), (1, "Good evening, Sam"), (2, "Up late, Sam"), (3, "Up late, Sam"), (4, "Good morning, Sam"), (12, "Good afternoon, Sam"), (18, "Good evening, Sam"), (23, "Good evening, Sam")],
)
def test_the_greeting_follows_your_clock(hour, want):
    from types import SimpleNamespace

    from app.today.core import greeting

    now = datetime(2026, 11, 14, hour, 30, tzinfo=ZoneInfo("Australia/Brisbane"))
    assert greeting(now, SimpleNamespace(settings={"display_name": "Sam"}, username="sam")) == want


def test_health_shows_goals_only_for_what_you_log():
    import uuid

    from app.today.hub import health_section

    now = datetime(2026, 11, 14, 9, 0, tzinfo=ZoneInfo("Australia/Brisbane"))
    goal = lambda metric, target: {"metric": metric, "target": target, "direction": "daily"}  # noqa: E731
    data = {
        "settings": {"today_tiles": ["weight", "sleep", "steps"]},
        "goals": [goal("water", 2000), goal("sleep", 7.5), goal("steps", 8000)],
        "readings": [{"metric": "weight", "value": 81.2, "at": "2026-11-14T07:00:00"}],
    }
    got = health_section(uuid.uuid4(), data, now)
    assert got and got["weight"] and got["goals"] == []
    # Once sleep is logged, even on another day, its goal is theirs.
    data["readings"].append({"metric": "sleep", "value": 7, "at": "2026-11-12T07:00:00"})
    assert [g["metric"] for g in health_section(uuid.uuid4(), data, now)["goals"]] == ["sleep"]
