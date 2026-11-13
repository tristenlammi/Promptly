"""Ask about your mail: it finds the email a question is about even when the
two share no words ("a stay tomorrow" → "Welcome Guide & Lockbox Code"), it
knows today's date, follow-ups make sense, and only your own mail is read.
All mail here is made up."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from .test_mail import H, client, mk_account, mk_user  # noqa: F401

PLANNING = "turn a question about someone's email into searches"


@pytest.fixture
def model(monkeypatch):
    """A scripted model: the search plan it gives, and every prompt it was sent."""
    import app.chat.router as chat_router
    import app.files.editor_ai as ea

    state: dict = {"plan": {"searches": [], "senders": []}, "calls": [], "fail_plan": False}

    async def resolve(db, user, provider_id, model_id):
        return object(), "fake-model"

    async def quotas(request, user, db):
        return None

    async def complete(provider, model_id, *, system, messages, user, **kw):
        call = {"system": system, "messages": [(m.role, m.content) for m in messages], "user": user, "max_tokens": kw.get("max_tokens")}
        state["calls"].append(call)
        if PLANNING in system:
            if state["fail_plan"]:
                raise RuntimeError("model down")
            return json.dumps(state["plan"])
        return "An answer."

    monkeypatch.setattr(ea, "resolve_model", resolve)
    monkeypatch.setattr(ea, "complete", complete)
    monkeypatch.setattr(chat_router, "_enforce_send_quotas", quotas)
    return state


async def _msg(db, account, *, uid: int, subject: str, body: str, sender: str, addr: str, sent_at):
    from sqlalchemy import select

    from app.mail.models import MailFolder, MailMessage

    folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == account.id, MailFolder.role == "inbox"))
    if folder is None:
        folder = MailFolder(account_id=account.id, path="INBOX", name="Inbox", role="inbox")
        db.add(folder)
        await db.flush()
    m = MailMessage(
        account_id=account.id, folder_id=folder.id, uid=uid, thread_key=uuid.uuid4().hex, message_id=f"<{uuid.uuid4().hex}@x>",
        subject=subject, from_name=sender, from_addr=addr, to_addrs=[], cc_addrs=[], sent_at=sent_at,
        snippet=body[:200], body_text=body, body_html="", attachments=[],
    )
    db.add(m)
    return m


async def _inbox(db, user, *, noise: int = 45):
    """A booking that never says "stay" or "tomorrow", under a pile of newer mail."""
    account = await mk_account(db, user, email=f"{uuid.uuid4().hex[:6]}@example.com")
    now = datetime.now(timezone.utc)
    nelly = await _msg(
        db, account, uid=1, subject="Nelly - Welcome Guide & Lockbox Code", sender="Esther Kieft", addr="esther@example.com",
        body="Hi Tristen, we're excited to welcome you to our cute container. Check-in is after 3PM, "
             "check-out by 10AM. The key is in a lockbox on the patio. 342 Palmwoods-Montville Road.",
        sent_at=now - timedelta(days=2),
    )
    for i in range(noise):
        await _msg(db, account, uid=100 + i, subject=f"Your electricity bill {i}", sender="Origin Energy", addr="bills@example.com",
                   body=f"Your bill is ready. Email us about anything. {i}", sent_at=now - timedelta(hours=i))
    await db.commit()
    return account, nelly


def _asked(state) -> str:
    return state["calls"][-1]["messages"][-1][1]


def _read_in_full(prompt: str) -> str:
    return prompt.split("The newest emails in the inbox")[0]


async def _ask(client, user, question: str, **extra):
    r = await client.post("/api/mail/ask", headers=H(user), json={
        "question": question, "provider_id": "00000000-0000-0000-0000-000000000001", "model_id": "fake", **extra,
    })
    assert r.status_code == 200, r.text
    return r.json()


async def test_a_stay_tomorrow_finds_the_welcome_guide(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u)
    model["plan"] = {"searches": ["booking", "check-in", "welcome guide", "lockbox", "accommodation"], "senders": []}

    got = await _ask(client, u, "Do I have a stay tomorrow?")

    assert "Nelly - Welcome Guide & Lockbox Code" in _read_in_full(_asked(model))
    assert got["read"] >= 1
    # The pile of newer bills doesn't push it out: they don't match.
    assert "electricity bill" not in _read_in_full(_asked(model))


async def test_a_name_finds_its_email_even_when_the_model_cant_plan(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u)
    model["fail_plan"] = True

    await _ask(client, u, "Did I get an email about the Nelly?")

    assert "Nelly - Welcome Guide & Lockbox Code" in _read_in_full(_asked(model))


async def test_the_start_of_a_word_finds_the_whole_word(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u)
    model["plan"] = {"searches": ["lock"], "senders": []}

    await _ask(client, u, "Where's the key?")

    assert "Nelly - Welcome Guide & Lockbox Code" in _read_in_full(_asked(model))


async def test_a_sender_named_is_searched_for(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u)
    model["plan"] = {"searches": [], "senders": ["Esther"]}

    await _ask(client, u, "What did she send?")

    assert "Esther Kieft" in _read_in_full(_asked(model))


async def test_the_newest_inbox_emails_always_come_along(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u, noise=5)

    await _ask(client, u, "Anything new?")

    prompt = _asked(model)
    assert "The newest emails in the inbox" in prompt
    assert "Your electricity bill 0" in prompt.split("The newest emails in the inbox")[1]


async def test_a_follow_up_knows_the_conversation(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u)
    model["plan"] = {"searches": ["nelly"], "senders": []}

    await _ask(client, u, "What time is check-in?", history=[
        {"q": "Did I get an email about the Nelly?", "a": "Yes, Esther Kieft sent the welcome guide."},
    ])

    plan_call = next(c for c in model["calls"] if PLANNING in c["system"])
    assert "Did I get an email about the Nelly?" in plan_call["messages"][-1][1]
    final = model["calls"][-1]["messages"]
    assert final[0] == ("user", "Did I get an email about the Nelly?")
    assert final[1][0] == "assistant"


async def test_only_your_own_mail_is_read(client, db, model):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    await _inbox(db, other)
    await mk_account(db, u, email="mine@example.com")
    model["plan"] = {"searches": ["nelly", "lockbox"], "senders": ["Esther"]}

    got = await _ask(client, u, "Did I get an email about the Nelly?")

    emails = _asked(model).split("Question:")[0]
    assert "Nelly" not in emails and "Esther" not in emails and "Lockbox" not in emails
    assert got["read"] == 0


async def test_only_an_admin_is_told_ai_search_is_off(client, db, model):  # noqa: F811
    admin, u = await mk_user(db, "boss", role="admin"), await mk_user(db, "owner")
    await mk_account(db, admin, email="boss@example.com")
    await _inbox(db, u, noise=1)

    assert "AI search" in (await _ask(client, admin, "Anything new?")).get("hint", "")
    assert "hint" not in await _ask(client, u, "Anything new?")


async def test_every_call_to_the_model_names_whose_day_it_is(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u, noise=1)

    await _ask(client, u, "Do I have a stay tomorrow?")

    assert model["calls"] and all(c["user"] is not None and c["user"].id == u.id for c in model["calls"])


def test_the_plan_always_keeps_your_own_words():
    from app.mail.ask import parse_plan

    plan = parse_plan({"searches": ["booking", "welcome guide"], "senders": ["Esther"], "sent_after": "nonsense"}, "Is the Nelly booked?")
    assert "booking" in plan.searches and "welcome guide" in plan.searches
    assert "nelly" in plan.searches and plan.senders == ["Esther"] and plan.sent_after is None
    assert parse_plan("not a dict", "the Nelly lockbox").searches[0] == "nelly lockbox"


def test_searches_cant_smuggle_in_query_syntax():
    from app.mail.ask import tsquery

    assert tsquery("welcome guide") == "welcome:* & guide:*"
    assert tsquery("a') | !(b") == "a:* & b:*"
    assert tsquery("!!!") is None


async def test_the_senders_earlier_booking_email_comes_along(client, db, model):  # noqa: F811
    """The welcome guide has no dates; the host's earlier booking email does, and
    shares no words with the question. It's read because it's from the same sender."""
    u = await mk_user(db, "owner")
    account, nelly = await _inbox(db, u)
    await _msg(
        db, account, uid=2, subject="Your upcoming visit", sender="Esther Kieft", addr="esther@example.com",
        body="Hello! Confirming your dates: arriving Friday 13 November, leaving Sunday 15 November.",
        sent_at=nelly.sent_at - timedelta(days=14),
    )
    await db.commit()
    model["plan"] = {"searches": ["welcome guide", "lockbox"], "senders": []}

    await _ask(client, u, "When is my stay at the Nelly?")

    read = _read_in_full(_asked(model))
    assert "Nelly - Welcome Guide & Lockbox Code" in read
    assert "Your upcoming visit" in read


async def test_the_answer_has_room_to_finish(client, db, model):  # noqa: F811
    u = await mk_user(db, "owner")
    await _inbox(db, u, noise=2)
    await _ask(client, u, "Tell me everything about the Nelly")
    assert model["calls"][-1]["max_tokens"] >= 1500
