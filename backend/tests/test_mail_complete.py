"""The rest of Mail: writing, snoozing, sorting by AI, notifications, older mail and
mail servers with their own certificate."""
from __future__ import annotations

import asyncio
import base64
import email
from email import policy
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.mail import compose, imap, parse, triage, worker
from app.mail.models import MailAccount, MailFolder, MailMessage, MailOutbox, MailSnooze

from .test_mail import H, HOST, PASSWORD, _connect, _deliver, _live_account, _mailbox, _rows, _sync, client, live, mk_account, mk_message, mk_user, server  # noqa: F401


def _parsed(raw: bytes):
    return email.message_from_bytes(raw, policy=policy.default)


def _account() -> MailAccount:
    return MailAccount(email="me@example.com", display_name="Me", signature="Regards,\nMe")


def _original() -> MailMessage:
    return MailMessage(
        message_id="<a@x>", references="<root@x>", subject="Plan", from_name="Sam", from_addr="sam@example.com", sent_at=datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc),
        body_text="First line\nSecond line", body_html='<p>First line</p><img data-remote-src="https://x.example/a.png">',
    )


# ---- writing


def test_a_reply_threads_quotes_and_signs():
    m = compose.build(_account(), compose.Draft(to=["sam@example.com"], cc=[], subject="Re: Plan", text="Sounds good", html="<p><b>Sounds good</b></p>"), reply_to=_original())
    assert m["In-Reply-To"] == "<a@x>" and m["References"] == "<root@x> <a@x>"
    text = m.get_body(("plain",)).get_content()
    assert "Sounds good" in text and "Regards,\nMe" in text and "> First line\n> Second line" in text
    rich = m.get_body(("html",)).get_content()
    assert "<b>Sounds good</b>" in rich and "<blockquote" in rich and 'src="https://x.example/a.png"' in rich


def test_a_forward_includes_the_original():
    m = compose.build(_account(), compose.Draft(to=["b@example.com"], cc=[], subject="Fwd: Plan", text="FYI"), forward=_original())
    assert m["In-Reply-To"] is None
    text = m.get_body(("plain",)).get_content()
    assert "Forwarded message" in text and "Subject: Plan" in text and "First line" in text


def test_what_you_type_cant_add_script_or_headers():
    m = compose.build(_account(), compose.Draft(to=["b@example.com"], cc=[], subject="Hi\r\nBcc: evil@example.com", text="x", html="<p>x</p><script>alert(1)</script><img src=x onerror=alert(1)>"))
    rich = m.get_body(("html",)).get_content()
    assert "<script" not in rich and "onerror" not in rich
    assert m["Bcc"] is None and m["Subject"] == "Hi Bcc: evil@example.com"


def test_attachments_go_along_and_odd_names_and_types_are_tamed():
    files = [compose.File("a\r\nX-Evil: 1.pdf", "application/pdf", b"pdf"), compose.File("b.eml", "message/rfc822", b"x"), compose.File("c", "not a type", b"y")]
    raw = compose.build(_account(), compose.Draft(to=["b@example.com"], cc=[], subject="s", text="x", files=files)).as_bytes()
    got = list(_parsed(raw).iter_attachments())
    assert [a.get_content_type() for a in got] == ["application/pdf", "application/octet-stream", "application/octet-stream"]
    assert b"\nX-Evil" not in raw
    assert got[0].get_content() == b"pdf"


async def test_files_are_checked_and_other_peoples_messages_cant_be_quoted(client, db):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    mine, theirs = await mk_account(db, u), await mk_account(db, other, email="them@example.com")
    private = await mk_message(db, theirs, body="Their secret")
    base = {"account_id": str(mine.id), "to": ["a@example.com"], "subject": "s", "text": "t"}
    assert (await client.post("/api/mail/send", json={**base, "reply_to_message": str(private.id)}, headers=H(u))).status_code == 404
    assert (await client.post("/api/mail/send", json={**base, "forward_of": str(private.id)}, headers=H(u))).status_code == 404
    assert (await client.post("/api/mail/send", json={**base, "files": [{"name": "a", "data": "not base64!"}]}, headers=H(u))).status_code == 422
    big = base64.b64encode(b"x" * (25 * 1024 * 1024 + 1)).decode()
    assert (await client.post("/api/mail/send", json={**base, "files": [{"name": "a", "data": big}]}, headers=H(u))).status_code == 413
    assert await db.scalar(select(MailOutbox.id).limit(1)) is None


async def test_a_failed_send_shows_and_can_be_retried_or_dismissed_only_by_you(client, db):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    item = MailOutbox(account_id=account.id, user_id=u.id, raw="Subject: Hello there\r\n\r\nx", recipients=["a@example.com"], status="failed", error="Couldn't send this message.")
    db.add(item)
    await db.commit()
    shown = (await client.get("/api/mail/overview", headers=H(u))).json()["failed"]
    assert shown == [{"id": str(item.id), "subject": "Hello there", "error": "Couldn't send this message."}]
    assert (await client.post(f"/api/mail/send/{item.id}/retry", headers=H(other))).status_code == 404
    assert (await client.post(f"/api/mail/send/{item.id}/dismiss", headers=H(other))).status_code == 404
    assert (await client.post(f"/api/mail/send/{item.id}/retry", headers=H(u))).status_code == 204
    await db.refresh(item)
    assert item.status == "waiting" and item.attempts == 0
    assert (await client.get("/api/mail/overview", headers=H(u))).json()["failed"] == []
    assert (await client.post(f"/api/mail/send/{item.id}/dismiss", headers=H(u))).status_code == 404


async def test_address_suggestions_come_from_your_own_mail(client, db):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    await mk_message(db, await mk_account(db, u))
    assert (await client.get("/api/mail/people?q=sam", headers=H(u))).json()["people"] == [{"name": "Sam", "addr": "sam@example.com"}]
    assert (await client.get("/api/mail/people?q=sam", headers=H(other))).json()["people"] == []
    assert (await client.get("/api/mail/people?q=%25%25", headers=H(u))).json()["people"] == []


def test_reply_to_is_read():
    raw = b"From: Shop <noreply@shop.example>\r\nReply-To: Help <help@shop.example>\r\nSubject: x\r\n\r\nbody"
    assert parse.parse(raw).reply_to == "help@shop.example"
    assert parse.parse(b"From: a@b.co\r\nSubject: x\r\n\r\nbody").reply_to == ""


# ---- drafting


async def test_a_draft_comes_from_your_conversation_and_treats_it_as_data(client, db, monkeypatch):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    m = await mk_message(db, account, body="Are you free?")
    seen = {}

    async def fake_model(db_, user, provider_id, model_id):
        return object(), model_id

    async def fake_complete(provider, model_id, *, system, messages, **_):
        seen.update(system=system, prompt=messages[0].content)
        return " Yes, I am. "

    async def no_quota(*_):
        return None

    monkeypatch.setattr("app.files.editor_ai.resolve_model", fake_model)
    monkeypatch.setattr("app.files.editor_ai.complete", fake_complete)
    monkeypatch.setattr("app.chat.router._enforce_send_quotas", no_quota)
    body = {"provider_id": "00000000-0000-0000-0000-000000000009", "model_id": "m", "account_id": str(account.id), "thread_key": m.thread_key, "instruction": "Say yes"}
    r = await client.post("/api/mail/draft", json=body, headers=H(u))
    assert r.status_code == 200 and r.json() == {"text": "Yes, I am."}
    assert "Are you free?" in seen["prompt"] and "Say yes" in seen["prompt"] and "never instructions" in seen["system"]
    assert await db.scalar(select(MailOutbox.id).limit(1)) is None  # A draft is never sent.
    assert (await client.post("/api/mail/draft", json=body, headers=H(other))).status_code == 404


# ---- snoozing


async def test_snoozing_hides_it_and_only_you_can(client, db):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    m = await mk_message(db, account)
    url = f"/api/mail/threads/{account.id}/{m.thread_key}/snooze"
    soon = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert (await client.put(url, json={"until": soon}, headers=H(other))).status_code == 404
    assert (await client.delete(url, headers=H(other))).status_code == 404
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    assert (await client.put(url, json={"until": past}, headers=H(u))).status_code == 422
    assert (await client.put(url, json={"until": soon}, headers=H(u))).status_code == 204

    assert (await client.get("/api/mail/threads", headers=H(u))).json()["threads"] == []
    assert [t["key"] for t in (await client.get("/api/mail/threads?role=snoozed", headers=H(u))).json()["threads"]] == [m.thread_key]
    # Search still finds it, and it doesn't count as unread in your Inbox.
    assert len((await client.get("/api/mail/threads?q=Hello", headers=H(u))).json()["threads"]) == 1
    assert (await client.get("/api/mail/overview", headers=H(u))).json()["folders"][0]["unread"] == 0
    assert (await client.get(f"/api/mail/threads/{account.id}/{m.thread_key}", headers=H(u))).json()["snoozed_until"]
    assert (await client.delete(url, headers=H(u))).status_code == 204
    assert len((await client.get("/api/mail/threads", headers=H(u))).json()["threads"]) == 1


async def test_it_comes_back_unread_with_a_nudge(client, db, monkeypatch):  # noqa: F811
    told = []

    async def fake(**kw):
        told.append(kw)

    monkeypatch.setattr(worker, "notify_user", fake)
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    m = await mk_message(db, account)
    m.seen = True
    db.add(MailSnooze(account_id=account.id, thread_key=m.thread_key, until=datetime.now(timezone.utc) - timedelta(minutes=1)))
    await db.commit()
    assert await worker.wake_snoozed() == 1
    row = (await _rows(db, account))[0]
    assert row.seen is False
    assert told and "Back from snooze" in told[0]["title"] and told[0]["category"] == "mail"
    assert await db.scalar(select(MailSnooze.account_id).limit(1).execution_options(populate_existing=True)) is None


# ---- sorting by AI


def test_reading_the_models_answer():
    assert triage.read_answer('{"needs_reply": true, "summary": "Wants your numbers"}') == (True, "Wants your numbers")
    assert triage.read_answer('Sure! ```{"needs_reply": false, "summary": "A receipt"}```') == (False, "A receipt")
    assert triage.read_answer("no idea") == (False, "")
    assert triage.read_answer('{"needs_reply": "yes"}') == (False, "")
    assert triage.read_answer('[1]') == (False, "")


def test_what_never_goes_to_the_model():
    assert triage.can_skip_model(MailMessage(from_addr="no-reply@x.co", unsubscribe=""))
    assert triage.can_skip_model(MailMessage(from_addr="news@x.co", unsubscribe="<mailto:u@x.co>"))
    assert triage.can_skip_model(MailMessage(from_addr="notifications@x.co", unsubscribe=""))
    assert not triage.can_skip_model(MailMessage(from_addr="sam@x.co", unsubscribe=""))


@pytest.fixture
def fake_model(monkeypatch):
    calls: list[str] = []

    async def resolve(db, user, provider_id, model_id):
        return object(), model_id

    async def complete(provider, model_id, *, system, messages, **_):
        calls.append(messages[0].content)
        return '{"needs_reply": true, "summary": "Asks about lunch"}'

    monkeypatch.setattr("app.files.editor_ai.resolve_model", resolve)
    monkeypatch.setattr("app.files.editor_ai.complete", complete)
    triage._resting.clear()
    return calls


CHOICE = {"provider_id": "00000000-0000-0000-0000-000000000009", "model_id": "m"}


async def test_nothing_is_sorted_until_you_choose_a_model(client, db, fake_model):  # noqa: F811
    u = await mk_user(db, "owner")
    await mk_message(db, await mk_account(db, u))
    assert await triage.sort_some(db) == 0
    assert fake_model == []


async def test_sorting_flags_what_wants_a_reply_and_replying_clears_it(client, db, fake_model):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    m = await mk_message(db, account, body="Lunch?")
    m.uid = 9
    await db.commit()
    news = await mk_message(db, account, subject="Newsletter")
    news.unsubscribe, news.from_addr = "<mailto:x@y.co>", "news@example.com"
    assert (await client.put("/api/mail/settings", json=CHOICE, headers=H(u))).json()["sorting"]["model_id"] == "m"
    await db.refresh(u)
    await db.commit()

    assert await triage.sort_some(db) == 2
    assert len(fake_model) == 1 and "Lunch?" in fake_model[0]  # The newsletter wasn't sent.
    await db.commit()
    got = (await client.get("/api/mail/threads?needs_reply=true", headers=H(u))).json()["threads"]
    assert [t["key"] for t in got] == [m.thread_key] and got[0]["summary"] == "Asks about lunch" and got[0]["needs_reply"]
    assert (await client.get("/api/mail/overview", headers=H(u))).json()["needs_reply"] == 1
    assert await triage.sort_some(db) == 0  # Each email only once.

    sent = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["sam@example.com"], "subject": "Re", "text": "Yes", "reply_to_message": str(m.id)}, headers=H(u))
    assert sent.status_code == 202
    assert (await client.get("/api/mail/threads?needs_reply=true", headers=H(u))).json()["threads"] == []


async def test_you_can_say_no_reply_is_needed(client, db, fake_model):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    m = await mk_message(db, account)
    m.needs_reply = True
    await db.commit()
    assert (await client.post(f"/api/mail/threads/{account.id}/{m.thread_key}/action", json={"action": "no_reply"}, headers=H(u))).status_code == 204
    assert (await client.get("/api/mail/threads?needs_reply=true", headers=H(u))).json()["threads"] == []


async def test_turning_sorting_off_stops_it(client, db, fake_model):  # noqa: F811
    u = await mk_user(db, "owner")
    await mk_message(db, await mk_account(db, u))
    await client.put("/api/mail/settings", json=CHOICE, headers=H(u))
    assert (await client.put("/api/mail/settings", json={}, headers=H(u))).json()["sorting"] is None
    await db.refresh(u)
    await db.commit()
    assert await triage.sort_some(db) == 0


async def test_a_model_failure_tries_again_later_instead_of_losing_the_email(client, db, monkeypatch, fake_model):  # noqa: F811
    async def broken(*_, **__):
        raise RuntimeError("down")

    monkeypatch.setattr("app.files.editor_ai.complete", broken)
    u = await mk_user(db, "owner")
    m = await mk_message(db, await mk_account(db, u))
    await client.put("/api/mail/settings", json=CHOICE, headers=H(u))
    await db.refresh(u)
    await db.commit()
    assert await triage.sort_some(db) == 0
    await db.refresh(m)
    assert m.triaged is False
    assert triage._resting  # And leaves it alone for a while.


async def test_the_summary_says_where_the_conversation_stands_and_keeps_up(client, db, fake_model, monkeypatch):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    first = await mk_message(db, account, subject="Lunch", body="Free on Friday?")
    first.uid = 31
    first.sent_at = datetime.now(timezone.utc) - timedelta(hours=2)
    await client.put("/api/mail/settings", json=CHOICE, headers=H(u))
    await db.refresh(u)
    await db.commit()
    await triage.sort_some(db)
    await db.commit()
    url = f"/api/mail/threads/{account.id}/{first.thread_key}"
    assert (await client.get(url, headers=H(u))).json()["summary"] == "Asks about lunch"

    answers = iter(['{"needs_reply": false, "summary": "Sam booked 12:30 on Friday"}'])

    async def next_answer(provider, model_id, *, system, messages, **_):
        fake_model.append(messages[0].content)
        return next(answers)

    monkeypatch.setattr("app.files.editor_ai.complete", next_answer)
    later = await mk_message(db, account, subject="Re: Lunch", body="12:30 works")
    later.thread_key = first.thread_key
    await db.commit()
    await triage.sort_some(db)
    await db.commit()
    # The model saw what came before, and the newest summary is the one shown, in both places.
    assert "Free on Friday?" in fake_model[-1] and "12:30 works" in fake_model[-1]
    assert (await client.get(url, headers=H(u))).json()["summary"] == "Sam booked 12:30 on Friday"
    row = (await client.get("/api/mail/threads", headers=H(u))).json()["threads"][0]
    assert row["summary"] == "Sam booked 12:30 on Friday" and row["needs_reply"] is False


async def test_your_own_reply_updates_the_summary_but_never_waits_on_you(client, db, fake_model):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    first = await mk_message(db, account, body="Free on Friday?")
    first.uid, first.triaged, first.summary = 41, True, "Asks about Friday"
    first.sent_at = datetime.now(timezone.utc) - timedelta(hours=2)
    sent = MailFolder(account_id=account.id, path="Sent", name="Sent", role="sent")
    db.add(sent)
    await db.flush()
    db.add(MailMessage(
        account_id=account.id, folder_id=sent.id, uid=1, thread_key=first.thread_key, message_id="<mine@x>", in_reply_to=first.message_id, subject="Re: Hello",
        from_name="Me", from_addr=account.email, sent_at=datetime.now(timezone.utc), body_text="Yes I am",
    ))
    await client.put("/api/mail/settings", json=CHOICE, headers=H(u))
    await db.refresh(u)
    await db.commit()
    assert await triage.sort_some(db) == 1
    await db.commit()
    assert "From: the reader" in fake_model[-1]
    got = (await client.get(f"/api/mail/threads/{account.id}/{first.thread_key}", headers=H(u))).json()
    assert got["summary"] == "Asks about lunch"  # What the fake model says: the newest one.
    assert (await client.get("/api/mail/threads?needs_reply=true", headers=H(u))).json()["threads"] == []


# ---- notifications, older mail


@pytest.fixture
def told(monkeypatch):
    out: list[dict] = []

    async def fake(**kw):
        out.append(kw)

    monkeypatch.setattr(worker, "notify_user", fake)
    return out


@live
async def test_new_mail_notifies_but_a_first_sync_and_filed_mail_dont(client, db, server, told):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Old news")
    await _sync(account)
    assert told == []

    _deliver("alice@mailtest.example", subject="Fresh")
    await _sync(account)
    assert [t["body"] for t in told] == ["Fresh"]
    assert told[0]["category"] == "mail" and told[0]["inbox"] is False and str(account.id) in told[0]["url"]

    told.clear()
    account.notify = False
    await db.commit()
    _deliver("alice@mailtest.example", subject="Quiet")
    await _sync(account)
    assert told == []

    account.notify = True
    await db.commit()
    label = (await client.post("/api/mail/labels", json={"name": "Filed"}, headers=H(u))).json()["id"]
    await client.post("/api/mail/rules", json={"kind": "subject", "value": "file me", "label_id": label}, headers=H(u))
    _deliver("alice@mailtest.example", subject="File me")
    await _sync(account)
    assert told == []


@live
async def test_lots_at_once_is_one_notification(db, server, told):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    await _sync(account)
    for i in range(5):
        _deliver("alice@mailtest.example", subject=f"Mail {i}")
    await _sync(account)
    assert len(told) == 1 and told[0]["title"] == "5 new emails"


@live
async def test_older_mail_comes_in_bit_by_bit_without_a_fuss(db, server, told, monkeypatch):
    monkeypatch.setattr(worker, "INITIAL_PER_FOLDER", 2)
    monkeypatch.setattr(worker, "BACKFILL_BATCH", 2)
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    for i in range(5):
        _deliver("alice@mailtest.example", subject=f"Mail {i}")
    client_ = await asyncio.to_thread(_connect, account)
    await _sync(account, client_)
    assert len(await _rows(db, account)) == 2
    await worker._backfill(client_, account.id)
    assert len(await _rows(db, account)) == 4
    await worker._backfill(client_, account.id)
    assert len(await _rows(db, account)) == 5
    await worker._backfill(client_, account.id)
    inbox = await db.scalar(select(MailFolder).where(MailFolder.account_id == account.id, MailFolder.role == "inbox").execution_options(populate_existing=True))
    assert inbox.oldest_uid == 1
    await _sync(account, client_)
    assert len(await _rows(db, account)) == 5
    await asyncio.to_thread(client_.logout)
    assert told == []


@live
async def test_a_reply_brings_a_snoozed_conversation_back(client, db, server, told):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    first = _deliver("alice@mailtest.example", subject="Talk")
    await _sync(account)
    key = (await _rows(db, account))[0].thread_key
    soon = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    await client.put(f"/api/mail/threads/{account.id}/{key}/snooze", json={"until": soon}, headers=H(u))
    assert (await client.get("/api/mail/threads", headers=H(u))).json()["threads"] == []
    _deliver("alice@mailtest.example", subject="Re: Talk", in_reply_to=first)
    await _sync(account)
    assert [t["key"] for t in (await client.get("/api/mail/threads", headers=H(u))).json()["threads"]] == [key]


@live
async def test_attachments_really_go_and_a_forward_carries_them(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Report", attachment="the report")
    await _sync(account)
    original = (await _rows(db, account))[0]
    body = {"account_id": str(account.id), "to": ["bob@mailtest.example"], "subject": "Fwd: Report", "text": "See this", "forward_of": str(original.id), "files": [{"name": "extra.txt", "mime": "text/plain", "data": base64.b64encode(b"extra").decode()}]}
    r = await client.post("/api/mail/send", json=body, headers=H(u))
    assert r.status_code == 202, r.text
    item = await db.get(MailOutbox, __import__("uuid").UUID(r.json()["id"]))
    item.send_at = datetime.now(timezone.utc)
    await db.commit()
    link = await asyncio.to_thread(_connect, account)
    await worker._send_due(link, account, True)
    await asyncio.to_thread(link.logout)

    box = _mailbox("bob@mailtest.example")
    box.select_folder("INBOX")
    uid = box.search(["ALL"])[0]
    raw = box.fetch([uid], ["BODY.PEEK[]"])[uid][b"BODY[]"]
    box.logout()
    got = _parsed(raw)
    assert sorted(a.get_filename() for a in got.iter_attachments()) == ["extra.txt", "report.pdf"]
    assert "the report" in str(next(a for a in got.iter_attachments() if a.get_filename() == "report.pdf").get_content())


# ---- a mail server with its own certificate


@live
async def test_a_server_on_your_network_can_be_trusted_once_you_agree(client, db, server, monkeypatch):  # noqa: F811
    monkeypatch.setenv("SSL_CERT_FILE", "/nonexistent")
    admin, ordinary = await mk_user(db, "boss", role="admin"), await mk_user(db, "owner")
    body = {"email": "alice@mailtest.example", "password": PASSWORD, "imap_host": HOST, "imap_port": 3993, "imap_security": "ssl", "smtp_host": HOST, "smtp_port": 3465, "smtp_security": "ssl"}

    asked = await client.post("/api/mail/accounts", json=body, headers=H(admin))
    assert asked.status_code == 422
    fingerprint = asked.json()["detail"]["fingerprint"]
    assert len(fingerprint) == 64
    # Someone who can't reach private addresses doesn't get the choice.
    assert (await client.post("/api/mail/accounts", json={**body, "cert_pin": fingerprint}, headers=H(ordinary))).status_code == 422
    # A certificate you didn't agree to is refused.
    wrong = await client.post("/api/mail/accounts", json={**body, "cert_pin": "A" * 64}, headers=H(admin))
    assert wrong.status_code == 422 and "changed" in wrong.json()["detail"]

    ok = await client.post("/api/mail/accounts", json={**body, "cert_pin": fingerprint}, headers=H(admin))
    assert ok.status_code == 201 and ok.json()["pinned"] is True
    account = await db.scalar(select(MailAccount).where(MailAccount.user_id == admin.id))
    assert account.cert_pin == fingerprint
    # And it works for syncing and sending, still without trusting it in general.
    worker_server = worker._server(account, True)
    link = await asyncio.to_thread(imap.connect, worker_server)
    await asyncio.to_thread(link.logout)
    m = compose.build(account, compose.Draft(to=["bob@mailtest.example"], cc=[], subject="Pinned", text="x"))
    await worker._smtp_send(account, m.as_bytes(), ["bob@mailtest.example"])
    account.cert_pin = "B" * 64
    with pytest.raises(imap.MailError):
        await worker._smtp_send(account, m.as_bytes(), ["bob@mailtest.example"])
    box = _mailbox("bob@mailtest.example")
    box.select_folder("INBOX")
    assert len(box.search(["ALL"])) == 1
    box.logout()


def test_a_public_server_with_a_bad_certificate_isnt_offered_as_a_choice(monkeypatch):
    monkeypatch.setattr(imap.socket, "getaddrinfo", lambda *_: [(0, 0, 0, "", ("8.8.8.8", 0))])
    assert imap._on_this_network("mail.example.com") is False
    monkeypatch.setattr(imap.socket, "getaddrinfo", lambda *_: [(0, 0, 0, "", ("192.168.1.5", 0))])
    assert imap._on_this_network("bridge.lan") is True
    monkeypatch.setattr(imap.socket, "getaddrinfo", lambda *_: [(0, 0, 0, "", ("192.168.1.5", 0)), (0, 0, 0, "", ("8.8.8.8", 0))])
    assert imap._on_this_network("mixed.example.com") is False


@live
async def test_a_new_password_is_only_saved_if_it_works(client, db, server):  # noqa: F811
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    before = account.secret_encrypted
    r = await client.patch(f"/api/mail/accounts/{account.id}", json={"password": "wrong"}, headers=H(u))
    assert r.status_code == 422
    await db.refresh(account)
    assert account.secret_encrypted == before
    assert (await client.patch(f"/api/mail/accounts/{account.id}", json={"password": PASSWORD}, headers=H(u))).status_code == 200


# ---- the people who can't say what's going on get told


async def test_proton_and_outlook_say_whats_going_on(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    proton = (await client.get("/api/mail/setup?email=me@proton.me", headers=H(u))).json()
    assert proton["known"] is False and "Bridge" in proton["note"] and proton["imap"]["port"] == 1143
    outlook = (await client.get("/api/mail/setup?email=me@outlook.com", headers=H(u))).json()
    assert outlook["known"] is False and "Outlook" in outlook["note"]
