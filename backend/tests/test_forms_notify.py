"""Telling people about answers (WP-F1.4): one running-total push per form
that replaces the last ("6 new answers"), never an answer's words; at most
one push a minute per person (a burst becomes one trailing push); the
per-form choice (each / daily / off) and who may follow a form; "seen"
resetting the count; the coalesced inbox row and held push; the daily
summary and daily email; the Forms switch in notification settings; the
closing pushes; and the Today section.
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import select, text, update

UTC = timezone.utc


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.forms import notify
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    # Each test calls notify.after_answer itself, so nothing races it.
    monkeypatch.setattr(notify, "answer_arrived", lambda form_id: None)
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
def open_gate(monkeypatch):
    from app.forms import notify

    async def now(form_id, user_id):
        return 0

    monkeypatch.setattr(notify, "gate", now)


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name, **settings):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user", settings=settings or {})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


DEFN = {
    "version": 1, "title": "BBQ RSVP", "description": "", "after": "continue",
    "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
    "items": [{"id": "name", "kind": "short_text", "title": "Your name", "description": "", "image_asset_id": None,
               "required": True, "config": {}, "deleted": False}],
}


class F:
    def __init__(self, fid, form_id, token):
        self.fid, self.form_id, self.token = fid, form_id, token


async def make_form(client, owner, **settings) -> F:
    r = await client.post("/api/forms", json={}, headers=H(owner))
    fid = r.json()["file"]["id"]
    assert (await client.put(f"/api/forms/{fid}/definition", json={"definition": DEFN, "data_version": 1},
                             headers=H(owner))).status_code == 200
    r = await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True, "audience": "link", **settings},
                           headers=H(owner))
    assert r.status_code == 200, r.text
    view = (await client.post(f"/api/forms/{fid}/link", json={}, headers=H(owner))).json()
    return F(fid, uuid.UUID(view["form"]["id"]), view["link"]["token"])


async def answer(client, f: F, name="SECRET answer text"):
    from app.forms import abuse

    r = await client.post(f"/api/f/{f.token}/submit", json={
        "answers": {"name": name}, "submit_id": str(uuid.uuid4()),
        "start_token": abuse.start_token(f.form_id, now=time.time() - 30)})
    assert r.status_code == 200, r.text
    return r.json()["number"]


def answer_pushes(pushes, f):
    return [p for p in pushes if p.get("tag") == f"form:{f.form_id}"]


# ------------------------------------------------------------------ pushes
async def test_one_running_total_push_that_replaces_the_last(client, db, pushes, open_gate):
    from app.forms import notify

    owner = await mk_user(db, "ann")
    f = await make_form(client, owner)
    await answer(client, f)
    await notify.after_answer(f.form_id)
    await answer(client, f)
    await notify.after_answer(f.form_id)
    got = answer_pushes(pushes, f)
    assert [p["body"] for p in got] == ["1 new answer", "2 new answers"]
    p = got[-1]
    assert p["user_id"] == owner.id and p["category"] == "form_response"
    assert p["title"] == "BBQ RSVP" and p["tag"] == f"form:{f.form_id}"
    assert p["url"] == f"/files/form/{f.fid}?tab=responses"
    assert p["extra"] == {"count": 2} and p["summary"] is False
    # Never an answer's words.
    assert "SECRET" not in json.dumps(got, default=str)

    # Looking at the Responses tab starts the count again.
    assert (await client.post(f"/api/forms/{f.fid}/seen", headers=H(owner))).status_code == 200
    await answer(client, f)
    await notify.after_answer(f.form_id)
    assert answer_pushes(pushes, f)[-1]["body"] == "1 new answer"
    # The Forms home agrees.
    card = next(c for c in (await client.get("/api/forms", headers=H(owner))).json()["forms"] if c["file_id"] == f.fid)
    assert card["new_count"] == 1 and card["response_count"] == 3


async def test_burst_becomes_one_trailing_push(db, monkeypatch):
    from app.forms import notify
    from app.redis_client import redis

    form_id, user_id = uuid.uuid4(), uuid.uuid4()
    await redis.delete(f"forms:push:{form_id}:{user_id}", f"forms:push-trail:{form_id}:{user_id}")
    assert await notify.gate(form_id, user_id) == 0
    wait = await notify.gate(form_id, user_id)
    assert wait is not None and 1 <= wait <= notify.PUSH_GAP
    # Only one trailing push is planned for the rest of the burst.
    assert await notify.gate(form_id, user_id) is None
    assert await notify.gate(form_id, user_id) is None
    await redis.delete(f"forms:push:{form_id}:{user_id}", f"forms:push-trail:{form_id}:{user_id}")


async def test_modes_and_who_hears(client, db, pushes, open_gate):
    from app.forms import notify

    owner = await mk_user(db, "ann")
    editor = await mk_user(db, "ed")
    stranger = await mk_user(db, "sid")
    f = await make_form(client, owner)
    r = await client.post(f"/api/files/file/{f.fid}/grants", json={"grantee_user_id": str(editor.id), "can_edit": True},
                          headers=H(owner))
    assert r.status_code in (200, 201), r.text

    # Defaults: the owner each time, a collaborator not at all.
    s = (await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))).json()["notify"]
    assert s["mode"] == "each" and s["email_daily"] is False
    assert (await client.get(f"/api/forms/{f.fid}/summary", headers=H(editor))).json()["notify"]["mode"] == "off"
    await answer(client, f)
    await notify.after_answer(f.form_id)
    assert [p["user_id"] for p in answer_pushes(pushes, f)] == [owner.id]

    # The collaborator follows it once a day; the owner turns it off.
    r = await client.put(f"/api/forms/{f.fid}/notify", json={"mode": "daily"}, headers=H(editor))
    assert r.status_code == 200 and r.json()["mode"] == "daily"
    assert (await client.put(f"/api/forms/{f.fid}/notify", json={"mode": "off"}, headers=H(owner))).json()["mode"] == "off"
    pushes.clear()
    await answer(client, f)
    await notify.after_answer(f.form_id)
    got = answer_pushes(pushes, f)
    assert [(p["user_id"], p["summary"]) for p in got] == [(editor.id, True)]

    # Someone who can't see the form can't follow it, and a lost grant stops it.
    assert (await client.put(f"/api/forms/{f.fid}/notify", json={"mode": "each"}, headers=H(stranger))).status_code == 404
    await db.execute(text("DELETE FROM resource_grants WHERE grantee_user_id = :u"), {"u": editor.id})
    await db.commit()
    pushes.clear()
    await answer(client, f)
    await notify.after_answer(f.form_id)
    assert answer_pushes(pushes, f) == []
    assert (await client.put(f"/api/forms/{f.fid}/notify", json={"mode": "weekly"}, headers=H(owner))).status_code == 422


async def test_seen_drops_held_push_and_reads_inbox_row(client, db):
    from app.forms import notify
    from app.notifications.dispatch import PushPayload, _dispatch
    from app.notifications.models import Notification, PushHeld

    owner = await mk_user(db, "ann")
    f = await make_form(client, owner)
    url = notify.responses_url(uuid.UUID(f.fid))
    for n in (1, 2, 3):
        await _dispatch(user_id=owner.id, category="form_response", payload=PushPayload(
            title="BBQ RSVP", body=notify.answers_words(n), url=url, tag=notify.tag_for(f.form_id),
            category="form_response", extra={"count": n}))
    rows = (await db.execute(select(Notification).where(Notification.user_id == owner.id)
                             .execution_options(populate_existing=True))).scalars().all()
    # One unread inbox row per form, updated.
    assert [(r.body, r.read_at) for r in rows] == [("3 new answers", None)]
    db.add(PushHeld(user_id=owner.id, category="form_response", title="BBQ RSVP", body="3 new answers",
                    url=url, tag=notify.tag_for(f.form_id), reason="summary", extra={"count": 3},
                    created_at=datetime.now(UTC)))
    await db.commit()
    assert (await client.post(f"/api/forms/{f.fid}/seen", headers=H(owner))).status_code == 200
    held = (await db.execute(select(PushHeld).where(PushHeld.user_id == owner.id))).scalars().all()
    assert held == []
    row = (await db.execute(select(Notification).where(Notification.user_id == owner.id)
                            .execution_options(populate_existing=True))).scalar_one()
    assert row.read_at is not None
    # A read row isn't replaced: the next answers start a fresh one.
    await _dispatch(user_id=owner.id, category="form_response", payload=PushPayload(
        title="BBQ RSVP", body="1 new answer", url=url, tag=notify.tag_for(f.form_id), category="form_response"))
    assert len((await db.execute(select(Notification).where(Notification.user_id == owner.id))).scalars().all()) == 2


# ------------------------------------------------------------------ the push machinery
@pytest.fixture
def sent(monkeypatch):
    import app.notifications.dispatch as d

    out: list[dict] = []

    def fake_send_one(**kw):
        out.append(json.loads(kw["payload_json"]))

    async def fake_vapid(db):
        return ("test-key", "mailto:test@example.com")

    monkeypatch.setattr(d, "_send_one", fake_send_one)
    monkeypatch.setattr(d, "_vapid", fake_vapid)
    return out


async def subscribe(db, u):
    from app.notifications.models import PushSubscription

    db.add(PushSubscription(user_id=u.id, endpoint=f"https://push.invalid/{u.id}", p256dh="k", auth="a"))
    await db.commit()


async def test_switch_daily_summary_and_held_coalescing(client, db, sent, monkeypatch):
    import app.notifications.quiet as q
    from app.notifications import loops
    from app.notifications.dispatch import PushPayload, _dispatch
    from app.notifications.models import PushHeld

    ann = await mk_user(db, "ann", timezone="Europe/London")
    await subscribe(db, ann)
    # Held at 06:00 London, before the 08:00 summary.
    monkeypatch.setattr(q, "_now", lambda: datetime(2026, 11, 9, 6, 0, tzinfo=ZoneInfo("Europe/London")).astimezone(UTC))
    prefs = (await client.get("/api/notifications/preferences", headers=H(ann))).json()
    assert prefs["form_response"] is True and "form_response" in prefs["summary_capable"]

    def payload(n, tag="form:a", **extra):
        return PushPayload(title="BBQ RSVP", body=f"{n} new answers", url="/files/form/x?tab=responses", tag=tag,
                           category="form_response", extra={"count": n, **extra})

    r = await _dispatch(user_id=ann.id, category="form_response", payload=payload(1))
    assert r["delivered"] == 1 and sent[-1]["tag"] == "form:a" and sent[-1]["body"] == "1 new answers"

    # "Once a day" for this form: held, and a running total replaces the held one.
    for n in (1, 2, 3):
        r = await _dispatch(user_id=ann.id, category="form_response", payload=payload(n), summary=True)
        assert r["held"] == 1
    await _dispatch(user_id=ann.id, category="form_response", payload=payload(2, tag="form:b"), summary=True)
    await _dispatch(user_id=ann.id, category="form_response", summary=True, payload=PushPayload(
        title="“Quiz” closed", body="It closed", url="/x", tag="form-closed:b", category="form_response",
        extra={"kind": "closed"}))
    rows = (await db.execute(select(PushHeld).where(PushHeld.user_id == ann.id))).scalars().all()
    assert sorted((r.tag, (r.extra or {}).get("count")) for r in rows) == [("form-closed:b", None), ("form:a", 3), ("form:b", 2)]
    before = len(sent)
    out = await loops.run_once(db, datetime(2026, 11, 9, 8, 1, tzinfo=ZoneInfo("Europe/London")).astimezone(UTC))
    assert out["summaries"] == 1
    assert sent[-1]["body"] == "5 new answers and 1 form closed in Forms" and len(sent) == before + 1

    # The Forms switch off: nothing pushed (the inbox row still lands).
    r = await client.patch("/api/notifications/preferences", json={"form_response": False}, headers=H(ann))
    assert r.status_code == 200 and r.json()["form_response"] is False
    r = await _dispatch(user_id=ann.id, category="form_response", payload=payload(9))
    assert r["delivered"] == 0 and r["held"] == 0


async def test_busy_and_admin_close_are_form_pushes(client, db, pushes, monkeypatch):
    from app.auth.models import User
    from app.forms import abuse

    owner = await mk_user(db, "ann")
    admin = await mk_user(db, "root")
    await db.execute(update(User).where(User.id == admin.id).values(role="admin"))
    await db.commit()
    f = await make_form(client, owner)
    from limits.aio.storage import RedisStorage
    from limits.aio.strategies import FixedWindowRateLimiter

    from app import rate_limit

    # A limiter with a Redis connection of this test's own: the shared one may
    # hold a pooled connection from an earlier test's event loop, which hangs
    # (as in test_forms_answer's ``limited`` fixture).
    monkeypatch.setattr(rate_limit, "_limiter", FixedWindowRateLimiter(RedisStorage(rate_limit._settings.REDIS_URL)))
    rate_limit._settings.RATE_LIMIT_ENABLED = True
    monkeypatch.setattr(abuse, "PER_FORM_PER_HOUR", 0)
    from app.redis_client import redis

    await redis.delete(f"form:{f.form_id}:busy-told")
    r = await client.post(f"/api/f/{f.token}/submit", json={
        "answers": {"name": "x"}, "submit_id": str(uuid.uuid4()),
        "start_token": abuse.start_token(f.form_id, now=time.time() - 30)}, headers={"X-Real-IP": "203.0.113.9"})
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    assert r.status_code == 429
    busy = [p for p in pushes if p.get("tag") == f"form-busy:{f.form_id}"]
    assert busy and busy[0]["category"] == "form_response" and busy[0]["extra"] == {"kind": "busy"}

    r = await client.post(f"/api/admin/forms/{f.form_id}/close", json={"reason": "Phishing"}, headers=H(admin))
    assert r.status_code == 200, r.text
    closed = [p for p in pushes if p.get("tag") == f"form-closed:{f.form_id}"]
    assert closed[0]["category"] == "form_response" and closed[0]["user_id"] == owner.id


# ------------------------------------------------------------------ closing
async def test_closing_is_told_once_until_it_opens_again(client, db, pushes):
    from app.forms import notify
    from app.forms.models import Form

    owner = await mk_user(db, "ann")
    f = await make_form(client, owner)
    await answer(client, f)
    past = datetime.now(UTC) - timedelta(minutes=1)
    await db.execute(update(Form).where(Form.id == f.form_id).values(close_at=past))
    await db.commit()
    assert await notify.close_tick(db) == 1
    assert await notify.close_tick(db) == 0
    told = [p for p in pushes if p.get("tag") == f"form-closed:{f.form_id}"]
    assert len(told) == 1 and told[0]["title"] == "“BBQ RSVP” closed"
    assert told[0]["body"] == "It reached its closing time with 1 answer." and told[0]["extra"] == {"kind": "closed"}

    # Opened again (a later closing time), then closing again is told again.
    later = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    assert (await client.patch(f"/api/forms/{f.fid}/settings", json={"close_at": later}, headers=H(owner))).status_code == 200
    await db.execute(update(Form).where(Form.id == f.form_id).values(close_at=past))
    await db.commit()
    assert await notify.close_tick(db) == 1

    # Closing on its answer limit is told inline, once.
    g = await make_form(client, owner, max_responses=2)
    await answer(client, g)
    assert not [p for p in pushes if p.get("tag") == f"form-closed:{g.form_id}"]
    await answer(client, g)
    full = [p for p in pushes if p.get("tag") == f"form-closed:{g.form_id}"]
    assert len(full) == 1 and "2 answers" in full[0]["body"]
    assert await notify.close_tick(db) == 0


# ------------------------------------------------------------------ daily email
async def test_daily_email_counts_only(client, db, monkeypatch):
    from app.calendars import reach
    from app.forms import notify
    from app.forms.models import FormNotify

    mails: list[dict] = []

    async def fake_mail(db, **kw):
        mails.append(kw)

    ready = {"on": False}

    async def smtp_ready(db):
        return ready["on"]

    monkeypatch.setattr(notify, "_send_mail", fake_mail)
    monkeypatch.setattr(reach, "smtp_ready", smtp_ready)

    owner = await mk_user(db, "ann", timezone="UTC", morning_summary={"on": False, "time": "00:00"})
    f = await make_form(client, owner)
    # No SMTP: the email can't be turned on, and none goes.
    r = await client.put(f"/api/forms/{f.fid}/notify", json={"email_daily": True}, headers=H(owner))
    assert r.status_code == 400
    assert (await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))).json()["notify"]["can_email"] is False
    ready["on"] = True
    r = await client.put(f"/api/forms/{f.fid}/notify", json={"email_daily": True}, headers=H(owner))
    assert r.status_code == 200 and r.json()["email_daily"] is True and r.json()["can_email"] is True
    # Pretend it was turned on yesterday.
    await db.execute(update(FormNotify).where(FormNotify.form_id == f.form_id)
                     .values(emailed_at=datetime.now(UTC) - timedelta(days=1)))
    await db.commit()
    await answer(client, f, "SECRET one")
    await answer(client, f, "SECRET two")
    now = datetime.now(UTC) + timedelta(seconds=5)
    assert await notify.send_email_digests(db, now) == 1
    [m] = mails
    assert m["to"] == owner.email and m["subject"] == "New answers to your form"
    assert "BBQ RSVP: 2 new answers (2 in all)" in m["text_body"]
    assert f"/files/form/{f.fid}?tab=responses" in m["text_body"]
    assert "SECRET" not in json.dumps(m)
    # Once a day.
    assert await notify.send_email_digests(db, now + timedelta(minutes=15)) == 0
    # The next day, with nothing new since: no email.
    assert await notify.send_email_digests(db, now + timedelta(days=1)) == 0
    ready["on"] = False
    assert await notify.send_email_digests(db, now + timedelta(days=2)) == 0
    assert len(mails) == 1


# ------------------------------------------------------------------ Today
async def test_today_section(client, db):
    owner = await mk_user(db, "ann", timezone="Australia/Sydney")
    other = await mk_user(db, "bo")
    f = await make_form(client, owner)
    r = await client.get("/api/today", headers=H(owner))
    assert r.status_code == 200 and "forms" not in r.json()["sections"]
    await answer(client, f)
    await answer(client, f)
    sec = (await client.get("/api/today", headers=H(owner))).json()["sections"]["forms"]
    assert sec["new_total"] == 2 and sec["forms"] == [
        {"title": "BBQ RSVP", "new": 2, "total": 2, "url": f"/files/form/{f.fid}?tab=responses"}]
    assert "SECRET" not in json.dumps(sec)
    # Nobody else sees it.
    assert "forms" not in (await client.get("/api/today", headers=H(other))).json()["sections"]
    # Seen: gone, unless it closes today.
    await client.post(f"/api/forms/{f.fid}/seen", headers=H(owner))
    assert "forms" not in (await client.get("/api/today", headers=H(owner))).json()["sections"]
    soon = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    await client.patch(f"/api/forms/{f.fid}/settings", json={"close_at": soon}, headers=H(owner))
    sec = (await client.get("/api/today", headers=H(owner))).json()["sections"]["forms"]
    assert sec["forms"] == [] and sec["closing"][0]["title"] == "BBQ RSVP"
    # Turned off for this form: not in Today either.
    await client.patch(f"/api/forms/{f.fid}/settings", json={"close_at": None}, headers=H(owner))
    await answer(client, f)
    await client.put(f"/api/forms/{f.fid}/notify", json={"mode": "off"}, headers=H(owner))
    assert "forms" not in (await client.get("/api/today", headers=H(owner))).json()["sections"]
