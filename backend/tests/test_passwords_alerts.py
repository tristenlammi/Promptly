"""Expiry reminders in Calendar and Tasks, and breach alerts from Have I Been Pwned.

HIBP is always a mock transport here. Nothing in this file talks to the real API.
"""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select

from tests.test_passwords import b64, bearer, client, make_user, setup_vault, shared_vault, write  # noqa: F401

KEY = "0123456789abcdef0123456789abcdef"


async def _item(client, who, vault_id=None) -> str:
    iid = str(uuid.uuid4())
    await write(client, who, vault_id or who.vault_id, [{"id": iid, "blob": b64(os.urandom(300))}])
    return iid


async def _events(db, user):
    from app.calendars.models import CalCalendar, CalEvent

    q = select(CalEvent).join(CalCalendar, CalCalendar.id == CalEvent.calendar_id).where(CalCalendar.owner_id == user.id).order_by(CalEvent.start_at)
    return (
        await db.execute(q.execution_options(populate_existing=True))
    ).scalars().all()


async def _tasks(db, user):
    from app.items import service as items

    found = await items.primary_file(db, user, "tasks")
    if found is None:
        return []
    await db.refresh(found[1])
    return found[1].data["tasks"]


# ------------------------------------------------------------------ reminders


async def test_reminder_makes_events_and_a_task_and_follows_the_date(client, db):
    a = await setup_vault(client, await make_user(db))
    iid = await _item(client, a)
    r = await client.put(
        f"/api/passwords/reminders/{iid}", headers=a.h,
        json={"expires_on": "2031-05-20", "weeks": 8, "label": "Passport 123456789", "calendar": True, "task": True},
    )
    assert r.status_code == 200, r.text
    got = r.json()
    # A document number never reaches the server's Calendar, whatever the client sends.
    assert got["label"] == "Passport"
    assert got["event_url"] and got["task_url"]

    events = await _events(db, a.user)
    assert [(e.title, e.start_at.date()) for e in events] == [("Passport expires in 8 weeks", date(2031, 3, 25)), ("Passport expires", date(2031, 5, 20))]
    assert all(e.all_day for e in events)
    assert events[1].reminders == [0, 7 * 24 * 60]
    assert not any(ch.isdigit() for e in events for ch in e.title.replace("8 weeks", ""))
    tasks = await _tasks(db, a.user)
    assert [(t["title"], t["due"]) for t in tasks] == [("Passport expires soon", "2031-03-25")]

    # The person renames the event in Calendar; a new date moves it and keeps their wording.
    events[1].title = "Renew passport at the post office"
    await db.commit()
    r = await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json={"expires_on": "2032-01-10", "weeks": 2, "label": "Passport", "calendar": True, "task": True})
    assert r.status_code == 200, r.text
    events = await _events(db, a.user)
    assert [(e.title, e.start_at.date()) for e in events] == [("Passport expires in 2 weeks", date(2031, 12, 27)), ("Renew passport at the post office", date(2032, 1, 10))]
    tasks = await _tasks(db, a.user)
    assert len(tasks) == 1 and tasks[0]["due"] == "2031-12-27" and "10 Jan 2032" in tasks[0]["notes"]

    # One week: no separate heads-up event, the day's own reminder does it. Tasks off removes the task.
    r = await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json={"expires_on": "2032-01-10", "weeks": 1, "label": "Passport", "calendar": True, "task": False})
    assert r.status_code == 200, r.text
    assert len(await _events(db, a.user)) == 1
    assert await _tasks(db, a.user) == []

    listed = (await client.get("/api/passwords/reminders", headers=a.h)).json()
    assert [x["item_id"] for x in listed["reminders"]] == [iid] and listed["tasks_available"] is True

    assert (await client.delete(f"/api/passwords/reminders/{iid}", headers=a.h)).status_code == 204
    assert await _events(db, a.user) == []
    assert (await client.get("/api/passwords/reminders", headers=a.h)).json()["reminders"] == []


async def test_deleting_the_item_removes_its_reminder(client, db):
    a = await setup_vault(client, await make_user(db))
    keep, drop = await _item(client, a), await _item(client, a)
    for iid in (keep, drop):
        r = await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json={"expires_on": "2030-02-02", "weeks": 4, "label": "Licence", "calendar": True, "task": True})
        assert r.status_code == 200, r.text
    assert len(await _events(db, a.user)) == 4 and len(await _tasks(db, a.user)) == 2
    await write(client, a, a.vault_id, [{"id": drop, "base_revision": 2, "deleted": True}])
    assert len(await _events(db, a.user)) == 2 and len(await _tasks(db, a.user)) == 1
    left = (await client.get("/api/passwords/reminders", headers=a.h)).json()["reminders"]
    assert [x["item_id"] for x in left] == [keep]


async def test_sweep_takes_reminders_for_items_gone_another_way(client, db):
    from app.passwords import reminders
    from app.passwords.models import PwItem

    a = await setup_vault(client, await make_user(db))
    iid = await _item(client, a)
    await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json={"expires_on": "2030-02-02", "weeks": 4, "label": "Card", "calendar": True})
    assert await reminders.sweep(db) == 0
    row = await db.get(PwItem, uuid.UUID(iid))
    await db.delete(row)  # As when a whole vault goes.
    await db.commit()
    assert await reminders.sweep(db) == 1
    assert await _events(db, a.user) == []


async def test_reminders_are_per_person(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    iid = await _item(client, a)
    body = {"expires_on": "2030-02-02", "weeks": 4, "label": "Passport", "calendar": True}
    # Someone else's item, or none at all: the same answer.
    assert (await client.put(f"/api/passwords/reminders/{iid}", headers=b.h, json=body)).status_code == 404
    assert (await client.put(f"/api/passwords/reminders/{uuid.uuid4()}", headers=a.h, json=body)).status_code == 404
    assert (await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json=body)).status_code == 200
    assert (await client.get("/api/passwords/reminders", headers=b.h)).json()["reminders"] == []
    assert (await client.delete(f"/api/passwords/reminders/{iid}", headers=b.h)).status_code == 204
    assert len(await _events(db, a.user)) == 2
    # And a vault session is needed, not just a sign-in.
    assert (await client.get("/api/passwords/reminders", headers=bearer(a.user))).status_code in (401, 403)
    assert (await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json={**body, "calendar": False})).status_code == 400


async def test_member_who_leaves_loses_their_reminder(client, db):
    from app.passwords import reminders
    from app.passwords.models import PwVaultMember

    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    vid = await shared_vault(client, a)
    db.add(PwVaultMember(vault_id=uuid.UUID(vid), user_id=b.user.id, role="edit", wrapped_key=b"k" * 94, signature=b"s" * 64, generation=1))
    await db.commit()
    iid = await _item(client, a, vid)
    body = {"expires_on": "2030-02-02", "weeks": 1, "label": "Family passport", "calendar": True}
    assert (await client.put(f"/api/passwords/reminders/{iid}", headers=a.h, json=body)).status_code == 200
    assert (await client.put(f"/api/passwords/reminders/{iid}", headers=b.h, json=body)).status_code == 200
    m = await db.get(PwVaultMember, (uuid.UUID(vid), b.user.id))
    await db.delete(m)
    await db.commit()
    assert await reminders.sweep(db) == 1
    assert len(await _events(db, a.user)) == 1 and await _events(db, b.user) == []


# ------------------------------------------------------------------ breach alerts


class FakeHibp:
    """Answers like HIBP v3, from a table of address -> breaches. Counts every call."""

    def __init__(self, table=None):
        self.table = table or {}
        self.calls: list[str] = []
        self.status: list[int] = []  # forced answers, used first

    def breach(self, name, domain, when="2020-01-02", classes=("Email addresses", "Passwords")):
        return {
            "Name": name, "Title": name.title(), "Domain": domain, "BreachDate": when, "AddedDate": "2021-03-04T05:06:07Z",
            "PwnCount": 123456, "Description": "<p>long text we don't keep</p>", "LogoPath": "https://example.invalid/x.png",
            "DataClasses": list(classes), "IsVerified": True, "IsSensitive": False,
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "haveibeenpwned.com"
        assert request.headers["hibp-api-key"] == KEY and request.headers["user-agent"]
        if request.url.path.endswith("/subscription/status"):
            return httpx.Response(200, json={"SubscriptionName": "Core 1", "Rpm": 10})
        address = httpx.URL(request.url).path.rsplit("/", 1)[1]
        from urllib.parse import unquote

        address = unquote(address)
        self.calls.append(address)
        if self.status:
            code = self.status.pop(0)
            return httpx.Response(code, headers={"retry-after": "3"} if code == 429 else {})
        found = self.table.get(address, [])
        return httpx.Response(200, json=found) if found else httpx.Response(404)


@pytest.fixture
def hibp(monkeypatch):
    from app.breach_watch import service as breaches

    fake = FakeHibp()
    monkeypatch.setattr(breaches, "client", lambda: httpx.AsyncClient(base_url=breaches.HIBP_BASE, transport=httpx.MockTransport(fake.handle)))
    sent = []

    async def notify(**kw):
        sent.append(kw)

    monkeypatch.setattr(breaches, "notify_user", notify)
    fake.sent = sent
    return fake


async def _key(db, rpm=10):
    from app.auth.utils import encrypt_secret
    from app.breach_watch import service as breaches

    cfg = await breaches.config(db)
    cfg.api_key_encrypted = encrypt_secret(KEY)
    cfg.rpm = rpm
    await db.commit()


async def _sleeps():
    waits = []

    async def sleep(s):
        waits.append(s)

    return waits, sleep


async def _due_now(db):
    from app.breach_watch.models import BreachAddress

    for r in (await db.execute(select(BreachAddress))).scalars():
        r.next_check_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db.commit()


async def test_no_key_no_checks(client, db, hibp):
    from app.breach_watch import service as breaches

    a = await setup_vault(client, await make_user(db))
    got = (await client.get("/api/passwords/breach-watch", headers=a.h)).json()
    assert got["available"] is False and got["on"] is False
    assert (await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": True})).status_code == 400
    assert (await breaches.run_checks(db))["skipped"] == "no key"
    assert hibp.calls == []


async def test_opt_in_only_and_only_new_breaches_are_announced(client, db, hibp):
    from app.mail.models import MailAccount
    from app.breach_watch import service as breaches
    from app.breach_watch.models import BreachCatalog, BreachHit

    await _key(db)
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))  # never turns it on
    db.add(MailAccount(user_id=a.user.id, email="Ana.Work@Example.org", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x"))
    await db.commit()
    adobe = hibp.breach("adobe", "adobe.com", "2013-10-04")
    hibp.table = {a.user.email: [adobe], "ana.work@example.org": [], b.user.email: [hibp.breach("canva", "canva.com")]}

    # Before agreeing, the person sees exactly which addresses would go to HIBP.
    before = (await client.get("/api/passwords/breach-watch", headers=a.h)).json()
    assert before["available"] is True and before["on"] is False
    assert {x["address"]: x["source"] for x in before["addresses"]} == {a.user.email: "account", "ana.work@example.org": "mail"}
    assert "Have I Been Pwned" in before["attribution"]

    assert (await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": True})).status_code == 200
    waits, sleep = await _sleeps()
    out = await breaches.run_checks(db, sleep=sleep)
    assert out["calls"] == 2 and out["checked"] == 2
    assert sorted(hibp.calls) == sorted([a.user.email, "ana.work@example.org"])  # never b's
    # First check: one summary, not a push per old breach.
    assert len(hibp.sent) == 1 and hibp.sent[0]["user_id"] == a.user.id and hibp.sent[0]["title"] == "Breach alerts are on"

    # Only names and dates per address; what was exposed is the public catalog's.
    hit = await db.scalar(select(BreachHit))
    assert (hit.address, hit.name, hit.breach_date) == (a.user.email, "adobe", date(2013, 10, 4))
    cat = await db.get(BreachCatalog, "adobe")
    assert cat.domain == "adobe.com" and cat.data_classes == ["Email addresses", "Passwords"]
    cols = {c.name for c in BreachHit.__table__.columns}
    assert not cols & {"description", "pwn_count", "data_classes", "raw", "response"}

    # Nothing's due yet, so nothing's asked.
    await breaches.run_checks(db, sleep=sleep)
    assert len(hibp.calls) == 2

    # Next day, same answer: no news.
    await _due_now(db)
    await breaches.run_checks(db, sleep=sleep)
    assert len(hibp.calls) == 4 and len(hibp.sent) == 1

    # A new breach appears for the Mail address: one alert, naming it, pointing to the change helper.
    hibp.table["ana.work@example.org"] = [hibp.breach("linkedin", "linkedin.com", "2016-05-05")]
    await _due_now(db)
    out = await breaches.run_checks(db, sleep=sleep)
    assert out["notified"] == 1 and len(hibp.sent) == 2
    note = hibp.sent[-1]
    assert note["title"] == "New data breach: Linkedin" and note["url"] == "/passwords#/security"
    assert "a…@example.org" in note["body"] and "linkedin.com" in note["body"] and "Security" in note["body"]
    assert "Have I Been Pwned" in note["body"] and "ana.work" not in note["body"]

    seen = (await client.get("/api/passwords/breach-watch", headers=a.h)).json()
    assert {(x["address"], x["name"], x["domain"]) for x in seen["breaches"]} == {(a.user.email, "adobe", "adobe.com"), ("ana.work@example.org", "linkedin", "linkedin.com")}
    # The other person sees nothing of it, and was never checked.
    other = (await client.get("/api/passwords/breach-watch", headers=b.h)).json()
    assert other["on"] is False and other["breaches"] == []

    # Off forgets everything.
    assert (await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": False})).json()["breaches"] == []
    assert await db.scalar(select(BreachHit)) is None


async def test_same_address_two_people_each_get_their_own(client, db, hibp):
    from app.breach_watch import service as breaches

    await _key(db)
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    from app.mail.models import MailAccount

    for who in (a, b):
        db.add(MailAccount(user_id=who.user.id, email="shared@example.org", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x"))
    await db.commit()
    hibp.table = {"shared@example.org": [hibp.breach("dropbox", "dropbox.com")]}
    for who in (a, b):
        await client.put("/api/passwords/breach-watch", headers=who.h, json={"on": True})
    waits, sleep = await _sleeps()
    await breaches.run_checks(db, sleep=sleep)
    # Asked once per run for the shared address.
    assert hibp.calls.count("shared@example.org") == 1
    assert {n["user_id"] for n in hibp.sent} == {a.user.id, b.user.id}
    await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": False})
    assert (await client.get("/api/passwords/breach-watch", headers=a.h)).json()["breaches"] == []
    assert len((await client.get("/api/passwords/breach-watch", headers=b.h)).json()["breaches"]) == 1


async def test_rate_limit_is_kept(client, db, hibp):
    from app.mail.models import MailAccount
    from app.breach_watch import service as breaches

    await _key(db, rpm=2)
    a = await setup_vault(client, await make_user(db))
    for i in range(30):
        db.add(MailAccount(user_id=a.user.id, email=f"box{i}@example.org", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x"))
    await db.commit()
    await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": True})
    waits, sleep = await _sleeps()
    out = await breaches.run_checks(db, sleep=sleep)
    # Two a minute, a little slower than that, and no more than a run's eight minutes' worth.
    assert out["calls"] == len(hibp.calls) == int(2 * 8 / breaches.MARGIN) == 14
    assert len(waits) == 13 and all(w >= 30 for w in waits)
    assert sum(waits) <= breaches.RUN_SECONDS
    # The rest wait for the next run.
    await breaches.run_checks(db, sleep=sleep)
    assert len(set(hibp.calls)) == 28
    await breaches.run_checks(db, sleep=sleep)
    assert len(set(hibp.calls)) == 31


async def test_429_waits_as_told_and_401_stops_and_tells_the_admin(client, db, hibp):
    from app.breach_watch import service as breaches

    await _key(db)
    admin = await make_user(db, role="admin")
    a = await setup_vault(client, await make_user(db))
    await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": True})
    hibp.status = [429]
    waits, sleep = await _sleeps()
    out = await breaches.run_checks(db, sleep=sleep)
    assert waits == [4] and out["checked"] == 1 and hibp.calls == [a.user.email, a.user.email]

    await _due_now(db)
    hibp.status = [401]
    out = await breaches.run_checks(db, sleep=sleep)
    assert out["stopped"] and out["checked"] == 0
    cfg = await breaches.config(db)
    assert "refused the key" in cfg.last_error
    assert [n["user_id"] for n in hibp.sent if n["category"] == "system_alert"] == [admin.id]
    # Told once, not every run.
    hibp.status = [401]
    await breaches.run_checks(db, sleep=sleep)
    assert len([n for n in hibp.sent if n["category"] == "system_alert"]) == 1


async def test_admin_sets_the_key_encrypted_and_never_shows_it(client, db, hibp):
    from app.breach_watch.models import BreachConfig

    admin = await make_user(db, role="admin")
    user = await make_user(db)
    assert (await client.get("/api/passwords/admin/breach-watch", headers=bearer(user))).status_code == 403
    assert (await client.put("/api/passwords/admin/breach-watch", headers=bearer(user), json={"api_key": KEY})).status_code == 403
    assert (await client.put("/api/passwords/admin/breach-watch", headers=bearer(admin), json={"api_key": "not a key"})).status_code == 400
    r = await client.put("/api/passwords/admin/breach-watch", headers=bearer(admin), json={"api_key": KEY})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["key_set"] is True and got["plan"] == "Core 1" and got["rpm"] == 10
    assert KEY not in r.text and KEY not in (await client.get("/api/passwords/admin/breach-watch", headers=bearer(admin))).text
    row = await db.get(BreachConfig, 1, populate_existing=True)
    assert row.api_key_encrypted and KEY not in row.api_key_encrypted
    r = await client.put("/api/passwords/admin/breach-watch", headers=bearer(admin), json={"rpm": 50})
    assert r.json()["rpm"] == 50 and r.json()["key_set"] is True
    r = await client.put("/api/passwords/admin/breach-watch", headers=bearer(admin), json={"api_key": ""})
    assert r.json()["key_set"] is False


async def test_passwords_turned_off_stops_the_checks(client, db, hibp):
    from app.breach_watch import service as breaches
    from app.passwords.deps import policy

    await _key(db)
    a = await setup_vault(client, await make_user(db))
    await client.put("/api/passwords/breach-watch", headers=a.h, json={"on": True})
    row = await policy(db)
    row.enabled = False
    await db.commit()
    assert (await breaches.run_checks(db))["skipped"] == "passwords off"
    assert hibp.calls == []


def test_reminders_table_holds_only_the_label_and_date():
    """The one Passwords table with plaintext from a vault item. Anything new here is a choice."""
    from app.passwords.reminder_models import PwReminder

    assert {c.name for c in PwReminder.__table__.columns} == {
        "id", "user_id", "item_id", "expires_on", "weeks", "label", "calendar", "task",
        "event_id", "early_event_id", "task_file_id", "task_id", "created_at", "updated_at",
    }


def test_breach_watch_never_touches_passwords():
    """It runs in the arq worker beside automations, so it mustn't reach a vault."""
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parent.parent / "app" / "breach_watch"
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf8")
        assert not re.search(r"(from|import)\s+app\.passwords", text), path
        assert "pw_items" not in text and "pw_vault" not in text, path
