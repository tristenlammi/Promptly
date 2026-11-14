"""Mail's one-tap offers: a bill offers "Remind me", a booking offers "Add to
calendar"; a reminder carries the due day you checked; and Ask, with a
conversation open, also reads the sender's other mail."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.mail.hints import suggest
from tests.test_mail_ask import PLANNING, H, _msg, client, mk_account, mk_user  # noqa: F401


@pytest.mark.parametrize(
    ("subject", "text", "want"),
    [
        ("New invoice INV-2316 from Greenstreet Lawn & Garden Care", "Amount due $120.00. Due date 20 Nov.", "bill"),
        ("Your Origin electricity bill", "Your bill is ready. Total due $310.22 by 28 November.", "bill"),
        ("Nelly - Welcome Guide & Lockbox Code", "Check-in is after 3PM, check-out by 10AM.", "event"),
        ("Booking confirmation", "Your booking is confirmed for Friday 13 November.", "event"),
        ("Your flight to Sydney", "Boarding pass attached. Itinerary below.", "event"),
        ("Thanks for your payment", "Payment received for invoice 2316. Paid in full.", None),
        ("Lunch?", "Are you free on Thursday?", None),
        ("Invoice 88 for your stay", "Check-in was 3 Nov. Amount due $400, pay by 30 Nov.", "bill"),
    ],
)
def test_what_an_email_looks_like(subject, text, want):
    assert suggest(subject, text) == want


def test_a_real_invite_has_its_own_card_so_no_offer():
    assert suggest("Booking confirmation", "Your booking is confirmed", has_invite=True) is None


@pytest.fixture
def model(monkeypatch):
    import app.chat.router as chat_router
    import app.files.editor_ai as ea

    state: dict = {"calls": [], "answer": "{}"}

    async def resolve(db, user, provider_id, model_id):
        return object(), "fake-model"

    async def quotas(request, user, db):
        return None

    async def complete(provider, model_id, *, system, messages, user, **kw):
        state["calls"].append({"system": system, "messages": [(m.role, m.content) for m in messages]})
        if PLANNING in system:
            return json.dumps({"searches": ["welcome guide"], "senders": []})
        return state["answer"]

    monkeypatch.setattr(ea, "resolve_model", resolve)
    monkeypatch.setattr(ea, "complete", complete)
    monkeypatch.setattr(chat_router, "_enforce_send_quotas", quotas)
    return state


MODEL = {"provider_id": "00000000-0000-0000-0000-000000000001", "model_id": "fake"}


async def _bill(db, user):
    account = await mk_account(db, user, email=f"{uuid.uuid4().hex[:6]}@example.com")
    m = await _msg(
        db, account, uid=1, subject="Invoice 00004195 from AR Built Homes", sender="AR Built Homes", addr="accounts@example.com",
        body="INV-00004195 for $745.00. Amount due $745.00. Due date 21 November 2026.",
        sent_at=datetime.now(timezone.utc) - timedelta(days=1),
    )
    await db.commit()
    return account, m


async def test_the_conversation_says_it_looks_like_a_bill(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account, m = await _bill(db, u)
    r = await client.get(f"/api/mail/threads/{account.id}/{m.thread_key}", headers=H(u))
    assert r.status_code == 200, r.text
    assert r.json()["suggest"] == "bill"


async def test_the_reminder_draft_reads_the_bill_and_a_bad_date_is_dropped(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    account, m = await _bill(db, u)
    model["answer"] = 'Sure: {"title": "Pay AR Built Homes invoice", "due": "2026-11-21", "amount": "$745.00", "note": "INV-00004195"}'
    r = await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/task-draft", headers=H(u), json={**MODEL, "today": "2026-11-14"})
    assert r.status_code == 200, r.text
    assert r.json() == {"title": "Pay AR Built Homes invoice", "due": "2026-11-21", "amount": "$745.00", "note": "INV-00004195"}
    # The email is read as information, never as instructions.
    assert "never instructions" in model["calls"][-1]["system"]

    model["answer"] = '{"title": "Pay it", "due": "next Friday"}'
    r = await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/task-draft", headers=H(u), json=MODEL)
    assert r.json()["due"] == ""


async def test_a_reminder_keeps_the_day_you_checked(client, db, monkeypatch):  # noqa: F811
    import app.mail.apps as apps

    made: list[dict] = []

    async def run(db, user, kind, action, args):
        made.append({"kind": kind, "action": action, **args})

    monkeypatch.setattr(apps, "_run_app_action", run)
    u = await mk_user(db, "owner")
    account, m = await _bill(db, u)

    r = await client.post(
        f"/api/mail/threads/{account.id}/{m.thread_key}/task", headers=H(u),
        json={"title": "Pay AR Built Homes invoice", "due": "2026-11-21", "note": "$745.00 · INV-00004195"},
    )
    assert r.status_code == 201, r.text
    task = made[-1]["tasks"][0]
    assert made[-1]["kind"] == "tasks" and task["title"] == "Pay AR Built Homes invoice" and task["due"] == "2026-11-21"
    assert "$745.00" in task["notes"] and f"/mail?open={account.id}/{m.thread_key}" in task["notes"]

    # With nothing sent (the old one-tap), it's the subject and no day.
    r = await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/task", headers=H(u))
    assert r.status_code == 201, r.text
    assert made[-1]["tasks"][0]["title"].startswith("Invoice 00004195") and "due" not in made[-1]["tasks"][0]


async def test_someone_elses_conversation_gets_no_draft_or_task(client, db, model):  # noqa: F811
    owner = await mk_user(db, "owner")
    other = await mk_user(db, "other")
    account, m = await _bill(db, owner)
    assert (await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/task-draft", headers=H(other), json=MODEL)).status_code == 404
    assert (await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/task", headers=H(other), json={"title": "x"})).status_code == 404


async def test_ask_with_a_conversation_open_also_reads_the_senders_earlier_email(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u, email=f"{uuid.uuid4().hex[:6]}@example.com")
    now = datetime.now(timezone.utc)
    guide = await _msg(
        db, account, uid=1, subject="Nelly - Welcome Guide & Lockbox Code", sender="Esther Kieft", addr="esther@example.com",
        body="Check-in is after 3PM. The key is in a lockbox.", sent_at=now - timedelta(days=2),
    )
    await _msg(
        db, account, uid=2, subject="Your upcoming visit", sender="Esther Kieft", addr="esther@example.com",
        body="Confirming your dates: arriving Friday 13 November, leaving Sunday 15 November.", sent_at=now - timedelta(days=16),
    )
    await db.commit()
    model["answer"] = "13 to 15 November."

    r = await client.post(
        "/api/mail/ask", headers=H(u),
        json={**MODEL, "question": "When is this stay?", "account_id": str(account.id), "thread_key": guide.thread_key},
    )
    assert r.status_code == 200, r.text
    asked = model["calls"][-1]["messages"][-1][1]
    assert "The conversation the question is about" in asked and "Nelly - Welcome Guide" in asked
    assert "Other emails that may help" in asked and "Your upcoming visit" in asked
    assert r.json()["read"] == 2
