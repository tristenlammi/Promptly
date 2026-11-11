"""Your own replies show in the conversation: at once when sent from here, and once
synced when sent from another mail app, in time order and only once.

The live half needs the throwaway GreenMail described in ``test_mail.py``. Gmail-shaped
tests play Gmail's part (it files its own sent copy in Sent Mail and All Mail) and use
``worker._sync_folders``, as the worker does."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid

from sqlalchemy import select

from app.database import SessionLocal
from app.mail import parse, worker
from app.mail.models import MailAccount, MailFolder, MailLabel, MailMessage, MailOutbox, MailSnooze, MailThreadLabel

from .test_mail import H, _connect, _deliver, _live_account, _mailbox, _rows, client, live, mk_account, mk_user, server  # noqa: F401
from .test_mail_labels import ALL_MAIL, _gmail_delivers, gmail_shaped  # noqa: F401

SENT_MAIL = "[Gmail]/Sent Mail"
ME = "alice@mailtest.example"
TERESA = "bob@mailtest.example"


def _earlier() -> str:
    """A Date for the email being answered. Without one it's dated when it's read, to the
    microsecond, and a reply written in the same second (dated to the second) sorts before it."""
    return format_datetime(datetime.now(timezone.utc) - timedelta(hours=1))


def _email(subject: str, sender: str, to: str, *, in_reply_to: str = "", references: str = "", when: datetime | None = None, body: str = "Hello") -> tuple[str, bytes]:
    m = EmailMessage()
    message_id = make_msgid(domain="mailtest.example")
    m["Message-ID"] = message_id
    m["From"] = sender
    m["To"] = to
    m["Subject"] = subject
    m["Date"] = format_datetime(when or datetime.now(timezone.utc))
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
    if references:
        m["References"] = references
    m.set_content(body)
    return message_id, m.as_bytes()


async def _conversation(client, u, account, key: str) -> list[dict]:  # noqa: F811
    r = await client.get(f"/api/mail/threads/{account.id}/{key}", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["messages"]


async def _key_of(db, account, message_id: str) -> str:
    return await db.scalar(
        select(MailMessage.thread_key).where(MailMessage.account_id == account.id, MailMessage.message_id == message_id)
        .execution_options(populate_existing=True).limit(1)
    )


async def _folders(db, account, *spots: tuple[str, str]) -> dict[str, MailFolder]:
    out = {}
    for path, role in spots:
        f = MailFolder(account_id=account.id, path=path, name=path, role=role)
        db.add(f)
        out[role] = f
    await db.commit()
    return out


# ---- threading, with no mail server


async def test_a_reply_stored_before_the_email_it_answers_still_joins_it(db):
    """The worker sees the Inbox more often than Sent, so an auto-reply to your reply
    can arrive here before your reply does."""
    u = await mk_user(db, "order")
    account = await mk_account(db, u)
    f = await _folders(db, account, ("INBOX", "inbox"), ("Sent", "sent"))
    now = datetime.now(timezone.utc)
    reminder, raw_r = _email("#21819 - booking", TERESA, ME, when=now - timedelta(hours=3))
    mine, raw_s = _email("Re: #21819 - booking", ME, TERESA, in_reply_to=reminder, references=reminder, when=now - timedelta(minutes=2))
    auto, raw_a = _email("Automatic reply: #21819 - booking", TERESA, ME, in_reply_to=mine, references=mine, when=now - timedelta(minutes=1))
    await worker._store(account.id, f["inbox"].id, [(1, [], raw_r)])
    await worker._store(account.id, f["inbox"].id, [(2, [], raw_a)])
    await worker._store(account.id, f["sent"].id, [(1, [b"\\Seen"], raw_s)])
    keys = {await _key_of(db, account, m) for m in (reminder, mine, auto)}
    assert len(keys) == 1


async def test_a_conversation_joined_later_keeps_its_label_and_snooze(db):
    u = await mk_user(db, "keep")
    account = await mk_account(db, u)
    f = await _folders(db, account, ("INBOX", "inbox"), ("Sent", "sent"))
    now = datetime.now(timezone.utc)
    first, raw_1 = _email("Plans", TERESA, ME, when=now - timedelta(hours=1))
    mine, raw_2 = _email("Re: Plans", ME, TERESA, in_reply_to=first, references=first, when=now - timedelta(minutes=30))
    answer, raw_3 = _email("Re: Plans", TERESA, ME, in_reply_to=mine, references=mine, when=now - timedelta(minutes=10))
    await worker._store(account.id, f["inbox"].id, [(1, [], raw_1)])
    await worker._store(account.id, f["inbox"].id, [(2, [], raw_3)])
    label = MailLabel(user_id=u.id, name="Holidays")
    db.add(label)
    await db.flush()
    lone = await _key_of(db, account, answer)
    db.add(MailThreadLabel(label_id=label.id, account_id=account.id, thread_key=lone))
    db.add(MailSnooze(account_id=account.id, thread_key=lone, until=now + timedelta(days=1)))
    await db.commit()

    await worker._store(account.id, f["sent"].id, [(1, [b"\\Seen"], raw_2)])
    key = await _key_of(db, account, first)
    assert {await _key_of(db, account, m) for m in (mine, answer)} == {key}
    labels = (await db.execute(select(MailThreadLabel).where(MailThreadLabel.account_id == account.id).execution_options(populate_existing=True))).scalars().all()
    assert [(x.label_id, x.thread_key) for x in labels] == [(label.id, key)]
    snoozes = (await db.execute(select(MailSnooze).where(MailSnooze.account_id == account.id).execution_options(populate_existing=True))).scalars().all()
    assert [s.thread_key for s in snoozes] == [key]


async def test_a_reply_goes_with_the_email_it_answers_not_an_older_one_it_mentions(db):
    u = await mk_user(db, "near")
    account = await mk_account(db, u)
    f = await _folders(db, account, ("INBOX", "inbox"))
    now = datetime.now(timezone.utc)
    old, raw_old = _email("Booking", TERESA, ME, when=now - timedelta(days=20))
    await worker._store(account.id, f["inbox"].id, [(1, [], raw_old)])
    # The booking system starts a new conversation that still mentions the old one.
    reminder, raw_r = _email("Reminder", TERESA, ME, when=now - timedelta(hours=1))
    await worker._store(account.id, f["inbox"].id, [(2, [], raw_r)])
    async with SessionLocal() as s:
        row = await s.scalar(select(MailMessage).where(MailMessage.message_id == reminder))
        row.thread_key = "split-on-purpose"
        await s.commit()
    reply, raw_reply = _email("Re: Reminder", TERESA, ME, in_reply_to=reminder, references=f"{old} {reminder}", when=now)
    await worker._store(account.id, f["inbox"].id, [(3, [], raw_reply)])
    assert await _key_of(db, account, reply) == "split-on-purpose"


# ---- what a conversation shows while your reply is on its way


async def _reply_queued(client, db, u, account, original: MailMessage) -> MailOutbox:  # noqa: F811
    r = await client.post(
        "/api/mail/send", json={"account_id": str(account.id), "to": [TERESA], "subject": "Re: Booking", "text": "See you then", "reply_to_message": str(original.id)}, headers=H(u),
    )
    assert r.status_code == 202, r.text
    return await db.get(MailOutbox, uuid.UUID(r.json()["id"]))


async def _one_email_in(db, account, folder: MailFolder, subject: str = "Booking") -> MailMessage:
    message_id, raw = _email(subject, TERESA, ME, when=datetime.now(timezone.utc) - timedelta(hours=1))
    await worker._store(account.id, folder.id, [(1, [], raw)])
    return await db.scalar(select(MailMessage).where(MailMessage.message_id == message_id))


async def test_a_reply_shows_as_sending_straight_away(client, db):  # noqa: F811
    u = await mk_user(db, "pending")
    account = await mk_account(db, u, email=ME)
    f = await _folders(db, account, ("INBOX", "inbox"), ("Sent", "sent"))
    original = await _one_email_in(db, account, f["inbox"])
    item = await _reply_queued(client, db, u, account, original)

    shown = await _conversation(client, u, account, original.thread_key)
    assert [m["text"].split("\n")[0] for m in shown] == ["Hello", "See you then"]
    assert shown[0]["outgoing"] is None
    assert shown[1]["outgoing"] == {"id": str(item.id), "status": "waiting", "error": ""}
    assert shown[1]["from"]["addr"] == ME and shown[1]["attachments"] == []

    item.status, item.attempts, item.error = "failed", 5, "Couldn't send this message."
    await db.commit()
    shown = await _conversation(client, u, account, original.thread_key)
    assert shown[1]["outgoing"]["status"] == "failed" and shown[1]["outgoing"]["error"] == "Couldn't send this message."

    # Someone else's conversation never shows your outbox, and yours never shows theirs.
    other = await mk_user(db, "other")
    assert (await client.get(f"/api/mail/threads/{account.id}/{original.thread_key}", headers=H(other))).status_code == 404


async def test_a_new_email_isnt_shown_in_a_conversation(client, db):  # noqa: F811
    u = await mk_user(db, "fresh")
    account = await mk_account(db, u, email=ME)
    f = await _folders(db, account, ("INBOX", "inbox"), ("Sent", "sent"))
    original = await _one_email_in(db, account, f["inbox"])
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": [TERESA], "subject": "Booking", "text": "Unrelated"}, headers=H(u))
    assert r.status_code == 202
    assert len(await _conversation(client, u, account, original.thread_key)) == 1


async def test_once_sent_its_kept_in_sent_and_the_mailbox_copy_takes_its_place(client, db, monkeypatch):  # noqa: F811
    u = await mk_user(db, "kept")
    account = await mk_account(db, u, email=ME)
    account.provider = "gmail"
    await db.commit()
    f = await _folders(db, account, ("INBOX", "inbox"), ("[Gmail]/Sent Mail", "sent"))
    original = await _one_email_in(db, account, f["inbox"])
    item = await _reply_queued(client, db, u, account, original)
    item.send_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()

    sent_raw: list[bytes] = []

    async def smtp(_account, raw, _recipients):
        sent_raw.append(raw)

    monkeypatch.setattr(worker, "_smtp_send", smtp)
    monkeypatch.setattr(worker.imap, "check_host", lambda *_: None)
    assert await worker._send_due(None, await db.get(MailAccount, account.id), True) is True

    shown = await _conversation(client, u, account, original.thread_key)
    assert [m["text"].split("\n")[0] for m in shown] == ["Hello", "See you then"]
    assert shown[1]["outgoing"] is None and shown[1]["seen"]
    rows = await _rows(db, account)
    mine = next(r for r in rows if r.folder_id == f["sent"].id)
    assert mine.uid is None and mine.thread_key == original.thread_key
    assert (await client.get("/api/mail/threads?role=sent", headers=H(u))).json()["threads"][0]["subject"] == "Re: Booking"

    # Gmail's own copy turns up in Sent Mail: the same email, now with its number.
    await worker._store(account.id, f["sent"].id, [(7, [b"\\Seen"], sent_raw[0])])
    rows = await _rows(db, account)
    assert len(rows) == 2 and next(r for r in rows if r.folder_id == f["sent"].id).uid == 7
    assert len(await _conversation(client, u, account, original.thread_key)) == 2


async def test_a_sent_copy_with_a_new_message_id_still_takes_the_place_of_ours(db):
    """Some servers give what they file in Sent a Message-ID of their own."""
    u = await mk_user(db, "renamed")
    account = await mk_account(db, u, email=ME)
    f = await _folders(db, account, ("INBOX", "inbox"), ("Sent", "sent"))
    original = await _one_email_in(db, account, f["inbox"])
    when = datetime.now(timezone.utc).replace(microsecond=0)
    _, ours = _email("Re: Booking", ME, TERESA, in_reply_to=original.message_id, references=original.message_id, when=when)
    await worker._keep_sent_copy(account.id, ours)
    _, theirs = _email("Re: Booking", ME, TERESA, in_reply_to=original.message_id, references=original.message_id, when=when + timedelta(seconds=3))
    await worker._store(account.id, f["sent"].id, [(4, [b"\\Seen"], theirs)])
    rows = [r for r in await _rows(db, account) if r.folder_id == f["sent"].id]
    assert len(rows) == 1 and rows[0].uid == 4


# ---- a real mail server


async def _gmail_user(db, name: str):
    u = await mk_user(db, name, role="admin")
    account = await _live_account(db, u)
    account.provider = "gmail"
    await db.commit()
    return u, account


async def _pass(account, every: bool) -> None:
    c = await asyncio.to_thread(_connect, account)
    await worker._refresh_folders(c, account.id)
    await worker._apply_ops(c, account.id)
    await worker._sync_folders(c, account.id, every=every)
    c.logout()


def _gmail_files_sent(raw: bytes) -> None:
    """What Gmail does with mail you send: it's in Sent Mail and All Mail."""
    c = _mailbox()
    for folder in (SENT_MAIL, ALL_MAIL):
        c.append(folder, raw, flags=[b"\\Seen"])
    c.logout()


def _auto_reply_to(message_id: str, chain: str = "") -> str:
    """Outlook's out-of-office answer, straight back."""
    return _gmail_delivers("Automatic reply: #21819 - booking", sender=f"Teresa <{TERESA}>", in_reply_to=message_id, references=chain or message_id)


@live
async def test_on_gmail_a_reply_sent_here_is_in_the_conversation_before_and_after_gmail_files_it(client, db, gmail_shaped):  # noqa: F811
    reminder = _gmail_delivers("#21819 - booking", sender=f"Teresa <{TERESA}>", date=_earlier())
    u, account = await _gmail_user(db, "gs1")
    await _pass(account, every=True)
    original = (await _rows(db, account))[0]
    item = await _reply_queued(client, db, u, account, original)
    assert [m["outgoing"] and m["outgoing"]["status"] for m in await _conversation(client, u, account, original.thread_key)] == [None, "waiting"]

    item.send_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    c = await asyncio.to_thread(_connect, account)
    assert await worker._send_due(c, await db.get(MailAccount, account.id), True)
    c.logout()
    bob = _mailbox(TERESA)
    bob.select_folder("INBOX")
    uid = bob.search(["ALL"])[0]
    raw = bob.fetch([uid], ["BODY.PEEK[]"])[uid][b"BODY[]"]
    bob.logout()
    mine = parse.parse(raw).message_id
    assert parse.parse(raw).in_reply_to == reminder

    # Gmail files it, and her out-of-office answers it at once.
    _gmail_files_sent(raw)
    auto = _auto_reply_to(mine)
    # The next look at the Inbox, well before the five-minute look at everything.
    await _pass(account, every=False)
    shown = await _conversation(client, u, account, original.thread_key)
    assert [m["message_id"] for m in shown] == [reminder, mine, auto]
    assert all(m["outgoing"] is None for m in shown)

    await _pass(account, every=True)
    await _pass(account, every=True)
    shown = await _conversation(client, u, account, original.thread_key)
    assert [m["message_id"] for m in shown] == [reminder, mine, auto]
    rows = await _rows(db, account)
    copies = [r for r in rows if r.message_id == mine]
    assert len(copies) == 1 and copies[0].uid is not None
    assert (await db.get(MailFolder, copies[0].folder_id)).path == SENT_MAIL
    # One conversation in the Inbox, with all three in it.
    listed = (await client.get("/api/mail/threads", headers=H(u))).json()["threads"]
    assert [t["key"] for t in listed] == [original.thread_key]


@live
async def test_on_gmail_a_reply_from_another_app_joins_the_conversation(client, db, gmail_shaped):  # noqa: F811
    reminder = _gmail_delivers("#21819 - booking", sender=f"Teresa <{TERESA}>", date=_earlier())
    u, account = await _gmail_user(db, "gs2")
    await _pass(account, every=True)
    original = (await _rows(db, account))[0]
    # Sent from the phone's Gmail app, so only Gmail's own copies of it exist.
    mine, raw = _email("Re: #21819 - booking", f"Me <{ME}>", TERESA, in_reply_to=reminder, references=reminder)
    _gmail_files_sent(raw)
    auto = _auto_reply_to(mine)
    await _pass(account, every=False)
    shown = await _conversation(client, u, account, original.thread_key)
    assert [m["message_id"] for m in shown] == [reminder, mine, auto]
    await _pass(account, every=True)
    assert [m["message_id"] for m in await _conversation(client, u, account, original.thread_key)] == [reminder, mine, auto]
    assert len([r for r in await _rows(db, account) if r.message_id == mine]) == 1


@live
async def test_elsewhere_the_copy_we_file_in_sent_takes_the_place_of_ours(client, db, server):  # noqa: F811
    first = _deliver(ME, sender=f"Teresa <{TERESA}>", subject="Booking", date=_earlier())
    u = await mk_user(db, "gs3", role="admin")
    account = await _live_account(db, u)
    await _pass(account, every=True)
    original = (await _rows(db, account))[0]
    item = await _reply_queued(client, db, u, account, original)
    item.send_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    c = await asyncio.to_thread(_connect, account)
    await worker._send_due(c, await db.get(MailAccount, account.id), True)
    c.logout()
    assert len(await _conversation(client, u, account, original.thread_key)) == 2
    await _pass(account, every=False)
    await _pass(account, every=True)
    rows = await _rows(db, account)
    assert len(rows) == 2 and all(r.uid is not None for r in rows)
    shown = await _conversation(client, u, account, original.thread_key)
    assert shown[0]["message_id"] == first and len(shown) == 2
