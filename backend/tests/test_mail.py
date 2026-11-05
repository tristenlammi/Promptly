"""Mail: someone else's mailbox stays out of reach, and the app and a real mail
server stay in step.

The second half needs a real IMAP/SMTP server, so it only runs when
``MAIL_TEST_HOST`` points at a throwaway GreenMail (with its certificate trusted
through ``SSL_CERT_FILE``) that has an ``alice`` and a ``bob``."""
from __future__ import annotations

import asyncio
import os
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import httpx
import pytest
from sqlalchemy import select

from app.auth.utils import create_access_token, encrypt_secret
from app.mail import imap, worker
from app.mail.models import MailAccount, MailFolder, MailMessage, MailOp, MailOutbox

HOST = os.environ.get("MAIL_TEST_HOST", "")
live = pytest.mark.skipif(not HOST, reason="needs a throwaway mail server (MAIL_TEST_HOST)")
PASSWORD = "testpass"


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


async def mk_user(db, name: str, role: str = "user"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}", password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def H(u) -> dict:
    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_account(db, user, email: str = "me@example.com", host: str = "imap.example.com", imap_port: int = 993, smtp_port: int = 465) -> MailAccount:
    a = MailAccount(
        user_id=user.id, email=email, imap_host=host, imap_port=imap_port, imap_security="ssl",
        smtp_host=host, smtp_port=smtp_port, smtp_security="ssl", username=email, secret_encrypted=encrypt_secret(PASSWORD),
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a


async def mk_message(db, account: MailAccount, subject: str = "Hello", body: str = "Private words") -> MailMessage:
    folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == account.id, MailFolder.role == "inbox"))
    if folder is None:
        folder = MailFolder(account_id=account.id, path="INBOX", name="Inbox", role="inbox")
        db.add(folder)
        await db.flush()
    m = MailMessage(
        account_id=account.id, folder_id=folder.id, uid=1, thread_key=uuid.uuid4().hex, message_id=f"<{uuid.uuid4().hex}@x>",
        subject=subject, from_name="Sam", from_addr="sam@example.com", to_addrs=[], cc_addrs=[], sent_at=datetime.now(timezone.utc),
        snippet=body, body_text=body, body_html="", attachments=[{"part": 0, "name": "a.pdf", "mime": "application/pdf", "size": 1}],
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return m


# ---- someone else's mail


async def test_no_way_into_someone_elses_mailbox(client, db):
    owner, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, owner)
    m = await mk_message(db, account)
    h = H(other)

    assert (await client.get("/api/mail/overview", headers=h)).json() == {"accounts": [], "folders": [], "labels": [], "sorting": False, "needs_reply": 0, "failed": []}
    assert (await client.get("/api/mail/threads", headers=h)).json()["threads"] == []
    assert (await client.get(f"/api/mail/threads?account={account.id}", headers=h)).json()["threads"] == []
    assert (await client.get("/api/mail/threads?q=Private", headers=h)).json()["threads"] == []
    assert (await client.get(f"/api/mail/threads?folder={m.folder_id}", headers=h)).json()["threads"] == []
    base = f"/api/mail/threads/{account.id}/{m.thread_key}"
    assert (await client.get(base, headers=h)).status_code == 404
    assert (await client.post(f"{base}/action", json={"action": "trash"}, headers=h)).status_code == 404
    assert (await client.get(f"/api/mail/messages/{m.id}/attachments/0", headers=h)).status_code == 404
    assert (await client.patch(f"/api/mail/accounts/{account.id}", json={"signature": "x"}, headers=h)).status_code == 404
    assert (await client.delete(f"/api/mail/accounts/{account.id}", headers=h)).status_code == 404
    assert (await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["a@example.com"]}, headers=h)).status_code == 404

    # Nothing moved, and their own mailbox can't answer as a reply to the owner's.
    assert await db.scalar(select(MailOp.id).limit(1)) is None
    mine = await mk_account(db, other, email="other@example.com")
    sneaky = {"account_id": str(mine.id), "to": ["a@example.com"], "reply_to_message": str(m.id)}
    assert (await client.post("/api/mail/send", json=sneaky, headers=h)).status_code == 404


async def test_someone_elses_send_cant_be_undone_by_you(client, db):
    owner, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, owner)
    sent = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["a@example.com"], "text": "hi"}, headers=H(owner))
    assert (await client.delete(f"/api/mail/send/{sent.json()['id']}", headers=H(other))).status_code == 404
    assert await db.get(MailOutbox, uuid.UUID(sent.json()["id"])) is not None


async def test_the_password_never_comes_back(client, db):
    owner = await mk_user(db, "owner")
    account = await mk_account(db, owner)
    r = await client.get("/api/mail/overview", headers=H(owner))
    assert PASSWORD not in r.text and account.secret_encrypted not in r.text and "secret" not in r.text
    assert account.secret_encrypted != PASSWORD


@pytest.mark.parametrize("host", ["127.0.0.1", "169.254.169.254", "localhost", "postgres"])
async def test_an_ordinary_user_cant_point_mail_at_this_network(client, db, host):
    u = await mk_user(db, "owner")
    body = {"email": "a@example.com", "password": "x", "imap_host": host, "imap_port": 993, "imap_security": "ssl", "smtp_host": "smtp.example.com", "smtp_port": 465, "smtp_security": "ssl"}
    r = await client.post("/api/mail/accounts", json=body, headers=H(u))
    assert r.status_code == 422
    assert await db.scalar(select(MailAccount.id).limit(1)) is None


async def test_a_private_outgoing_server_is_refused_too(client, db, monkeypatch):
    class Fake:
        def logout(self):
            pass

    monkeypatch.setattr(imap, "connect", lambda server: Fake())
    u = await mk_user(db, "owner")
    body = {"email": "a@example.com", "password": "x", "imap_host": "imap.example.com", "imap_port": 993, "imap_security": "ssl", "smtp_host": "127.0.0.1", "smtp_port": 25, "smtp_security": "starttls"}
    assert (await client.post("/api/mail/accounts", json=body, headers=H(u))).status_code == 422


async def test_images_only_come_from_the_public_internet(client, db):
    u = await mk_user(db, "owner")
    r = await client.post("/api/mail/images", json={"urls": ["http://127.0.0.1:8000/x.png", "http://postgres:5432/x.png", "file:///etc/passwd"]}, headers=H(u))
    assert r.status_code == 200 and r.json()["images"] == {}


async def test_everything_needs_signing_in(client, db):
    assert (await client.get("/api/mail/overview")).status_code == 401
    assert (await client.post("/api/mail/images", json={"urls": ["https://x.example/a.png"]})).status_code == 401


# ---- writing


async def test_a_subject_cant_add_headers(client, db):
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["a@example.com"], "subject": "Hi\r\nBcc: evil@example.com", "text": "x"}, headers=H(u))
    item = await db.get(MailOutbox, uuid.UUID(r.json()["id"]))
    assert "\nBcc:" not in item.raw and item.recipients == ["a@example.com"]


async def test_bcc_goes_out_but_isnt_shown(client, db):
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["a@example.com"], "bcc": ["hidden@example.com"], "text": "x"}, headers=H(u))
    item = await db.get(MailOutbox, uuid.UUID(r.json()["id"]))
    assert "hidden@example.com" not in item.raw and "hidden@example.com" in item.recipients


async def test_undo_within_the_window(client, db):
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["a@example.com"], "text": "x"}, headers=H(u))
    item_id = r.json()["id"]
    assert (await client.delete(f"/api/mail/send/{item_id}", headers=H(u))).json() == {"undone": True}
    assert await db.get(MailOutbox, uuid.UUID(item_id)) is None


async def test_undo_is_refused_once_its_on_its_way(client, db):
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["a@example.com"], "text": "x"}, headers=H(u))
    item = await db.get(MailOutbox, uuid.UUID(r.json()["id"]))
    item.status = "sending"
    await db.commit()
    assert (await client.delete(f"/api/mail/send/{item.id}", headers=H(u))).status_code == 409


# ---- a real mail server


def _api(path: str, **kw) -> httpx.Response:
    return httpx.post(f"http://{HOST}:8080/api/{path}", timeout=20, **kw)


def _deliver(to: str, subject: str = "Lunch", body: str = "Are you free?", **headers: str) -> str:
    m = EmailMessage()
    m["From"] = headers.get("sender", "Sam Taylor <sam@mailtest.example>")
    m["To"] = to
    m["Subject"] = subject
    m["Message-ID"] = headers.get("message_id", f"<{uuid.uuid4().hex}@mailtest.example>")
    if "in_reply_to" in headers:
        m["In-Reply-To"] = headers["in_reply_to"]
    m.set_content(body)
    if "attachment" in headers:
        m.add_attachment(headers["attachment"].encode(), maintype="application", subtype="pdf", filename="report.pdf")
    with smtplib.SMTP(HOST, 3025, timeout=20) as s:
        s.send_message(m)
    return m["Message-ID"]


def _mailbox(email: str = "alice@mailtest.example"):
    from imapclient import IMAPClient

    c = IMAPClient(HOST, port=3143, ssl=False, timeout=20)
    c.login(email, PASSWORD)
    return c


@pytest.fixture
def server():
    assert _api("service/reset").status_code == 200
    c = _mailbox()
    for name in ("Sent", "Archive", "Trash"):
        c.create_folder(name)
    c.logout()


async def _live_account(db, owner, email: str = "alice@mailtest.example") -> MailAccount:
    return await mk_account(db, owner, email=email, host=HOST, imap_port=3993, smtp_port=3465)


def _connect(account: MailAccount):
    return imap.connect(imap.Server(account.imap_host, account.imap_port, account.imap_security, account.username, PASSWORD, True))


async def _sync(account: MailAccount, client=None) -> None:
    own = client is None
    client = client or await asyncio.to_thread(_connect, account)
    await worker._refresh_folders(client, account.id)
    await worker._apply_ops(client, account.id)
    from app.database import SessionLocal

    async with SessionLocal() as s:
        folders = (await s.execute(select(MailFolder).where(MailFolder.account_id == account.id))).scalars().all()
    for folder in folders:
        await worker._sync_folder(client, account.id, folder)
    if own:
        await asyncio.to_thread(client.logout)


async def _rows(db, account: MailAccount) -> list[MailMessage]:
    query = select(MailMessage).where(MailMessage.account_id == account.id).order_by(MailMessage.sent_at).execution_options(populate_existing=True)
    return list((await db.execute(query)).scalars())


@live
async def test_connecting_checks_the_password_and_keeps_it_encrypted(client, db, server):
    admin = await mk_user(db, "owner", role="admin")
    body = {"email": "alice@mailtest.example", "password": "wrong", "display_name": "Alice", "imap_host": HOST, "imap_port": 3993, "imap_security": "ssl", "smtp_host": HOST, "smtp_port": 3465, "smtp_security": "ssl"}
    assert (await client.post("/api/mail/accounts", json=body, headers=H(admin))).status_code == 422
    assert await db.scalar(select(MailAccount.id).limit(1)) is None
    r = await client.post("/api/mail/accounts", json={**body, "password": PASSWORD}, headers=H(admin))
    assert r.status_code == 201 and PASSWORD not in r.text
    assert (await client.post("/api/mail/accounts", json={**body, "password": PASSWORD}, headers=H(admin))).status_code == 409


@live
async def test_a_certificate_we_dont_trust_is_refused(server, monkeypatch):
    monkeypatch.setenv("SSL_CERT_FILE", "/nonexistent")
    with pytest.raises(imap.MailError):
        imap.connect(imap.Server(HOST, 3993, "ssl", "alice@mailtest.example", PASSWORD, True))


@live
async def test_new_mail_arrives_and_replies_join_the_conversation(client, db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    first = _deliver("alice@mailtest.example", subject="Lunch", body="Are you free Friday?", attachment="PDFDATA")
    await _sync(account)
    _deliver("alice@mailtest.example", subject="Re: Lunch", body="Actually Saturday", in_reply_to=first)
    _deliver("alice@mailtest.example", subject="Invoice", body="Please pay")
    await _sync(account)

    r = (await client.get("/api/mail/threads", headers=H(u))).json()
    assert sorted(t["count"] for t in r["threads"]) == [1, 2]
    lunch = next(t for t in r["threads"] if t["count"] == 2)
    assert lunch["unread"] == 2 and lunch["attachments"] is True
    full = (await client.get(f"/api/mail/threads/{account.id}/{lunch['key']}", headers=H(u))).json()
    assert [m["text"].strip() for m in full["messages"]] == ["Are you free Friday?", "Actually Saturday"]

    found = (await client.get("/api/mail/threads?q=saturday", headers=H(u))).json()["threads"]
    assert [t["key"] for t in found] == [lunch["key"]]

    # An attachment comes from the mailbox, as a download.
    message = full["messages"][0]
    part = message["attachments"][0]["part"]
    got = await client.get(f"/api/mail/messages/{message['id']}/attachments/{part}", headers=H(u))
    assert got.content == b"PDFDATA" and got.headers["content-disposition"].startswith("attachment")
    assert got.headers["content-type"] == "application/octet-stream"


@live
async def test_syncing_twice_adds_nothing(db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example")
    await _sync(account)
    await _sync(account)
    assert len(await _rows(db, account)) == 1


@live
async def test_what_you_do_here_reaches_the_mailbox(client, db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example")
    await _sync(account)
    key = (await _rows(db, account))[0].thread_key
    base = f"/api/mail/threads/{account.id}/{key}/action"

    assert (await client.post(base, json={"action": "read"}, headers=H(u))).status_code == 204
    assert (await client.post(base, json={"action": "star"}, headers=H(u))).status_code == 204
    # On screen at once, before the mailbox has heard.
    row = (await _rows(db, account))[0]
    assert row.seen and row.flagged
    await _sync(account)
    box = _mailbox()
    box.select_folder("INBOX")
    uid = box.search(["ALL"])[0]
    flags = box.get_flags([uid])[uid]
    assert b"\\Seen" in flags and b"\\Flagged" in flags

    assert (await client.post(base, json={"action": "archive"}, headers=H(u))).status_code == 204
    assert (await client.get("/api/mail/threads", headers=H(u))).json()["threads"] == []
    await _sync(account)
    box.select_folder("INBOX")
    assert box.search(["ALL"]) == []
    box.select_folder("Archive")
    assert len(box.search(["ALL"])) == 1
    box.logout()

    # One message, now known by its number in the new folder. It wasn't copied.
    rows = await _rows(db, account)
    assert len(rows) == 1 and rows[0].uid is not None
    archived = (await client.get("/api/mail/threads?role=archive", headers=H(u))).json()["threads"]
    assert [t["key"] for t in archived] == [key]
    assert await db.scalar(select(MailOp.id).limit(1)) is None

    assert (await client.post(base, json={"action": "inbox"}, headers=H(u))).status_code == 204
    await _sync(account)
    assert len((await client.get("/api/mail/threads", headers=H(u))).json()["threads"]) == 1


@live
async def test_what_happens_in_the_mailbox_shows_here(db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="One")
    _deliver("alice@mailtest.example", subject="Two")
    await _sync(account)
    assert all(not r.seen for r in await _rows(db, account))

    # Read on your phone's own mail app, and one deleted there.
    box = _mailbox()
    box.select_folder("INBOX")
    uids = sorted(box.search(["ALL"]))
    box.add_flags(uids[:1], [b"\\Seen"])
    box.delete_messages(uids[1:])
    box.expunge()
    box.logout()
    await _sync(account)
    rows = await _rows(db, account)
    assert len(rows) == 1 and rows[0].seen


@live
async def test_sending_for_real(client, db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    await _sync(account)
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["bob@mailtest.example"], "subject": "Café ☕", "text": "Tomorrow, ça va?"}, headers=H(u))
    item_id = uuid.UUID(r.json()["id"])

    # Not during the undo window.
    conn = await asyncio.to_thread(_connect, account)
    await worker._send_due(conn, account, True)
    bob = _mailbox("bob@mailtest.example")
    bob.select_folder("INBOX")
    assert bob.search(["ALL"]) == []

    item = await db.get(MailOutbox, item_id)
    item.send_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    await worker._send_due(conn, account, True)
    bob.select_folder("INBOX")
    uids = bob.search(["ALL"])
    assert len(uids) == 1
    from app.mail import parse

    got = parse.parse(bob.fetch(uids, ["BODY.PEEK[]"])[uids[0]][b"BODY[]"])
    assert got.subject == "Café ☕" and "ça va" in got.text
    bob.logout()

    assert (await db.get(MailOutbox, item_id, populate_existing=True)).status == "sent"
    # It's in Sent, in the mailbox and then here.
    await _sync(account, conn)
    await asyncio.to_thread(conn.logout)
    sent = (await client.get("/api/mail/threads?role=sent", headers=H(u))).json()["threads"]
    assert [t["subject"] for t in sent] == ["Café ☕"]
    assert sent[0]["unread"] == 0


@live
async def test_a_reply_threads_at_the_other_end_too(client, db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    original = _deliver("alice@mailtest.example", sender="bob@mailtest.example", subject="Plans")
    await _sync(account)
    row = (await _rows(db, account))[0]
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["bob@mailtest.example"], "subject": "Re: Plans", "text": "Yes", "reply_to_message": str(row.id)}, headers=H(u))
    item = await db.get(MailOutbox, uuid.UUID(r.json()["id"]))
    assert f"In-Reply-To: {original}" in item.raw

    item.send_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    conn = await asyncio.to_thread(_connect, account)
    await worker._send_due(conn, account, True)
    await _sync(account, conn)
    await asyncio.to_thread(conn.logout)
    # Your reply in Sent and their message in the inbox are one conversation.
    keys = {m.thread_key for m in await _rows(db, account)}
    assert len(keys) == 1 and len(await _rows(db, account)) == 2


@live
async def test_a_failed_send_says_so_and_tries_again(client, db, server):
    u = await mk_user(db, "owner", role="admin")
    account = await mk_account(db, u, email="alice@mailtest.example", host=HOST, imap_port=3993, smtp_port=3999)
    r = await client.post("/api/mail/send", json={"account_id": str(account.id), "to": ["bob@mailtest.example"], "text": "x"}, headers=H(u))
    item = await db.get(MailOutbox, uuid.UUID(r.json()["id"]))
    item.send_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    await db.commit()
    conn = await asyncio.to_thread(_connect, account)
    await worker._send_due(conn, account, True)
    await asyncio.to_thread(conn.logout)
    item = await db.get(MailOutbox, item.id, populate_existing=True)
    assert item.status == "waiting" and item.attempts == 1 and "tried again" in item.error
    assert item.send_at > datetime.now(timezone.utc)
