"""Aliases on your own domain: making them, routing mail to them by its headers,
turning one off, the leak flag, replying from one, and one person not seeing
another's.

The last part needs a real IMAP/SMTP server, like ``test_mail.py``: it runs when
``MAIL_TEST_HOST`` points at a throwaway GreenMail. The test plays the provider's
catch-all by delivering to alice's mailbox with the alias left in the headers."""
from __future__ import annotations

import asyncio
import contextlib
import re
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import aiosmtplib
import pytest
from sqlalchemy import select, update

from app.mail import aliases as al
from app.mail import worker
from app.mail.models import MailAccount, MailFolder, MailMessage, MailOp, MailOutbox
from tests.test_passwords import bearer, client, make_user, setup_vault  # noqa: F401

DOMAIN = "alias.test"
_RANDOM = f"[{al.RANDOM_ALPHABET}]"


# ------------------------------------------------------------------ pure parts


def test_an_alias_is_a_word_then_a_random_part():
    for _ in range(50):
        local = al.make_local("Shop!", 4, ".")
        assert re.fullmatch(rf"shop\.{_RANDOM}{{4}}", local), local
    assert re.fullmatch(rf"news-{_RANDOM}{{7}}", al.make_local("news", 7, "-"))
    # No word: all random, and long enough not to guess.
    assert re.fullmatch(rf"{_RANDOM}{{8}}", al.make_local("", 4, "."))
    # A separator that isn't offered falls back; lengths are kept sensible.
    assert al.make_local("x", 4, "+").startswith("x.")
    assert len(al.make_local("x", 99, ".")) == len("x.") + 12
    assert len(al.make_local("x", 1, ".")) == len("x.") + 3
    assert al.clean_word("Über Shop 24/7") == "bershop247"
    # Different every time.
    assert len({al.make_local("shop", 4, ".") for _ in range(200)}) > 190


def test_only_a_domain_you_could_own():
    assert al.clean_domain("Example.COM.") == "example.com"
    assert al.clean_domain("@mail.example.co.uk") == "mail.example.co.uk"
    for bad in ("gmail.com", "x.gmail.com", "outlook.com", "localhost", "not a domain", "example", "-x.com", "a" * 300 + ".com"):
        assert al.clean_domain(bad) is None, bad


def _raw(to: str = "me@example.com", sender: str = "News <news@shop.example>", subject: str = "Hello", message_id: str | None = None, date: str | None = None, **headers: str) -> bytes:
    m = EmailMessage()
    m["Message-ID"] = message_id or f"<{uuid.uuid4().hex}@shop.example>"
    m["From"] = sender
    m["To"] = to
    m["Subject"] = subject
    m["Date"] = date or "Mon, 02 Nov 2026 09:00:00 +0000"
    for name, value in headers.items():
        m[name.replace("_", "-")] = value
    m.set_content("Hi")
    return m.as_bytes()


def test_recipients_come_from_every_routing_header():
    raw = _raw(to="Me <Me@Example.com>", Cc="cc@alias.test", Delivered_To="box@example.com", X_Original_To="Shop.K7M2@alias.test")
    got = al.recipients(raw)
    assert got[0] == "box@example.com"
    assert set(got) == {"me@example.com", "cc@alias.test", "box@example.com", "shop.k7m2@alias.test"}
    assert al.recipients(b"not an email at all") == []


def test_same_business():
    assert al.registrable("email.shop.co.uk") == "shop.co.uk"
    assert al.brand("email.shop.co.uk") == "shop"
    assert al.same_business("mail.netflix.com", "netflix.com")
    assert al.same_business("amazonses.com", "amazon.com.au")
    assert al.same_business("shop.co.uk", "shop.com")
    assert not al.same_business("cheap-pills.example", "netflix.com")
    # A short name inside another doesn't count.
    assert not al.same_business("ab.com", "abc.com")


def test_provider_refusing_the_sender_is_recognised():
    assert al.sender_refused(553, "5.7.1 <x@alias.test>: Sender address rejected: not owned by user")
    assert al.sender_refused(550, "5.7.60 SMTP; Client does not have permissions to send as this sender")
    assert not al.sender_refused(421, "Try again later")
    assert not al.sender_refused(552, "Message size exceeds fixed maximum")


# ------------------------------------------------------------------ with a database


async def _mailbox(db, user, email: str | None = None):
    account = MailAccount(
        user_id=user.id, email=email or f"{uuid.uuid4().hex[:8]}@example.com", imap_host="imap.example.com", imap_port=993, imap_security="ssl",
        smtp_host="smtp.example.com", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x",
    )
    db.add(account)
    await db.flush()
    folders = {}
    for role, path in (("inbox", "INBOX"), ("trash", "Trash"), ("spam", "Junk"), ("other", "Alias junk")):
        f = MailFolder(account_id=account.id, path=path, name=path, role=role, last_uid=1)
        db.add(f)
        folders[role] = f
    await db.commit()
    return account, folders


async def _setup(client, db, domain: str = DOMAIN):  # noqa: F811
    a = await setup_vault(client, await make_user(db))
    account, folders = await _mailbox(db, a.user)
    r = await client.post("/api/passwords/aliases/domains", headers=a.h, json={"domain": domain, "account_id": str(account.id)})
    assert r.status_code == 201, r.text
    return a, account, folders, r.json()


async def _alias(client, a, domain_id: str, word: str = "shop", item_id: str | None = None) -> dict:  # noqa: F811
    r = await client.post("/api/passwords/aliases", headers=a.h, json={"domain_id": domain_id, "word": word, "item_id": item_id})
    assert r.status_code == 201, r.text
    return r.json()


_uid = iter(range(100, 100000))


async def _arrive(account, folder, raws: list[bytes], fresh: bool = True) -> None:
    await worker._store(account.id, folder.id, [(next(_uid), [], raw) for raw in raws], announce=fresh)


async def _where(db, message_id: str) -> str:
    row = (await db.execute(
        select(MailFolder.role).join(MailMessage, MailMessage.folder_id == MailFolder.id).where(MailMessage.message_id == message_id).execution_options(populate_existing=True)
    )).scalars().all()
    return ",".join(sorted(row))


async def _list(client, a) -> dict[str, dict]:  # noqa: F811
    r = await client.get("/api/passwords/aliases", headers=a.h)
    assert r.status_code == 200, r.text
    return {x["address"]: x for x in r.json()}


async def test_setting_up_a_domain_and_making_aliases(client, db):  # noqa: F811
    a = await setup_vault(client, await make_user(db))
    other = await make_user(db)
    theirs, _ = await _mailbox(db, other)
    account, _ = await _mailbox(db, a.user)
    url = "/api/passwords/aliases/domains"
    assert (await client.post(url, headers=a.h, json={"domain": "gmail.com", "account_id": str(account.id)})).status_code == 400
    assert (await client.post(url, headers=a.h, json={"domain": DOMAIN, "account_id": str(theirs.id)})).status_code == 404
    # Needs the vault open, not just being signed in.
    assert (await client.post(url, headers=bearer(a.user), json={"domain": DOMAIN, "account_id": str(account.id)})).status_code == 401
    r = await client.post(url, headers=a.h, json={"domain": "Alias.Test", "account_id": str(account.id)})
    assert r.status_code == 201 and r.json()["domain"] == DOMAIN and r.json()["status"] == "new"
    assert (await client.post(url, headers=a.h, json={"domain": DOMAIN, "account_id": str(account.id)})).status_code == 409
    domain_id = r.json()["id"]
    accounts = (await client.get("/api/passwords/aliases/accounts", headers=a.h)).json()
    assert [x["email"] for x in accounts] == [account.email]

    item = str(uuid.uuid4())
    made = await _alias(client, a, domain_id, "Shop!", item)
    assert re.fullmatch(rf"shop\.{_RANDOM}{{4}}@alias\.test", made["address"]) and made["item_id"] == item and made["enabled"]
    assert made["count"] == 0 and made["last_at"] is None
    # Configurable: a longer random part, another separator, or no word at all.
    r = await client.patch(f"{url}/{domain_id}", headers=a.h, json={"random_len": 6, "separator": "-", "word_style": "site"})
    assert r.status_code == 200 and r.json()["word_style"] == "site"
    assert re.fullmatch(rf"news-{_RANDOM}{{6}}@alias\.test", (await _alias(client, a, domain_id, "news"))["address"])
    assert re.fullmatch(rf"{_RANDOM}{{8}}@alias\.test", (await _alias(client, a, domain_id, ""))["address"])
    assert (await client.patch(f"{url}/{domain_id}", headers=a.h, json={"random_len": 40})).status_code == 422
    assert len(await _list(client, a)) == 3
    # Linking an alias to the login after the login's saved.
    later = str(uuid.uuid4())
    assert (await client.patch(f"/api/passwords/aliases/{made['id']}", headers=a.h, json={"item_id": later})).json()["item_id"] == later


async def test_mail_finds_its_alias_by_to_delivered_to_or_x_original_to(client, db):  # noqa: F811
    a, account, f, domain = await _setup(client, db)
    shop = await _alias(client, a, domain["id"], "shop")
    news = await _alias(client, a, domain["id"], "news")
    ids = [f"<{n}-{uuid.uuid4().hex}@shop.example>" for n in ("to", "delivered", "original", "cc", "none", "spam")]
    await _arrive(account, f["inbox"], [
        _raw(to=shop["address"].upper(), message_id=ids[0]),
        _raw(to="undisclosed-recipients:;", message_id=ids[1], Delivered_To=shop["address"]),
        _raw(to="someone@else.example", message_id=ids[2], X_Original_To=news["address"]),
        _raw(to="friend@else.example", message_id=ids[3], Cc=f"Me <{shop['address']}>"),
        _raw(to=account.email, message_id=ids[4]),
    ])
    await _arrive(account, f["spam"], [_raw(to=shop["address"], message_id=ids[5])])
    got = await _list(client, a)
    assert got[shop["address"]]["count"] == 4 and got[news["address"]]["count"] == 1
    assert got[shop["address"]]["last_at"].startswith("2026-11-02")
    assert got[shop["address"]]["senders"] == [{"domain": "shop.example", "count": 4, "last_at": got[shop["address"]]["last_at"], "unlike": False}]
    # The same email seen again (Gmail's All Mail, say) isn't counted twice.
    await _arrive(account, f["other"], [_raw(to=shop["address"], message_id=ids[0])])
    assert (await _list(client, a))[shop["address"]]["count"] == 4
    # Nothing moved: these are all on.
    assert await _where(db, ids[0]) == "inbox,other"

    # Mail shows which alias, for each email in a conversation.
    msg = await db.scalar(select(MailMessage).where(MailMessage.message_id == ids[2]))
    r = await client.get(f"/api/mail/aliases/thread/{account.id}/{msg.thread_key}", headers=bearer(a.user))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["messages"] == {str(msg.id): news["id"]}
    assert body["aliases"][news["id"]]["address"] == news["address"]
    assert body["aliases"][news["id"]]["send_as"] == "unknown"


async def test_turning_an_alias_off_moves_its_new_mail(client, db):  # noqa: F811
    a, account, f, domain = await _setup(client, db)
    shop = await _alias(client, a, domain["id"])
    keep = f"<keep-{uuid.uuid4().hex}@shop.example>"
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=keep)])

    r = await client.patch(f"/api/passwords/aliases/{shop['id']}", headers=a.h, json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["disabled_at"]
    gone = f"<gone-{uuid.uuid4().hex}@shop.example>"
    other = f"<other-{uuid.uuid4().hex}@shop.example>"
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=gone), _raw(to=account.email, message_id=other)])
    assert await _where(db, gone) == "trash"
    assert await _where(db, other) == "inbox"
    # Mail already there stays, and the mailbox is told to move the new one.
    assert await _where(db, keep) == "inbox"
    ops = (await db.execute(select(MailOp).where(MailOp.account_id == account.id))).scalars().all()
    assert [(o.kind, o.folder_path, o.target_path) for o in ops] == [("move", "INBOX", "Trash")]

    # Older mail being copied in for the first time is left alone.
    old = f"<old-{uuid.uuid4().hex}@shop.example>"
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=old, date="Mon, 02 Nov 2020 09:00:00 +0000")], fresh=False)
    assert await _where(db, old) == "inbox"
    # Something you put back yourself (from another device) isn't moved again.
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=gone)])
    assert await _where(db, gone) == "inbox,trash"

    # Or a folder you chose. Then on again.
    folders = (await client.get(f"/api/passwords/aliases/domains/{domain['id']}/folders", headers=a.h)).json()
    junk = next(x for x in folders if x["path"] == "Alias junk")
    assert (await client.patch(f"/api/passwords/aliases/domains/{domain['id']}", headers=a.h, json={"off_folder_id": junk["id"]})).json()["off_folder_id"] == junk["id"]
    chosen = f"<chosen-{uuid.uuid4().hex}@shop.example>"
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=chosen)])
    assert await _where(db, chosen) == "other"
    # Turned off from Mail, as well as from the vault.
    r = await client.patch(f"/api/mail/aliases/{shop['id']}", headers=bearer(a.user), json={"enabled": True})
    assert r.status_code == 200 and r.json()["enabled"] is True
    back = f"<back-{uuid.uuid4().hex}@shop.example>"
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=back)])
    assert await _where(db, back) == "inbox"
    assert (await _list(client, a))[shop["address"]]["count"] == 5


async def test_a_sender_unlike_the_first_one_is_flagged(client, db):  # noqa: F811
    a, account, f, domain = await _setup(client, db)
    shop = await _alias(client, a, domain["id"])
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], sender="Shop <hello@shop.example>")])
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], sender="Shop <offers@mail.shop.example>")])
    got = (await _list(client, a))[shop["address"]]
    assert got["baseline"] == "shop.example" and got["flagged_at"] is None

    await _arrive(account, f["inbox"], [_raw(to=shop["address"], sender="Deals <win@cheap-pills.example>")])
    got = (await _list(client, a))[shop["address"]]
    assert got["flagged_at"] and got["flagged_sender"] == "cheap-pills.example"
    assert {s["domain"]: s["unlike"] for s in got["senders"]} == {"shop.example": False, "mail.shop.example": False, "cheap-pills.example": True}

    # "That one's fine": the flag clears, and it isn't raised by them again.
    r = await client.post(f"/api/passwords/aliases/{shop['id']}/allow", headers=a.h, json={"sender": "cheap-pills.example"})
    assert r.status_code == 200 and r.json()["flagged_at"] is None and r.json()["allowed_senders"] == ["cheap-pills.example"]
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], sender="Deals <more@cheap-pills.example>")])
    assert (await _list(client, a))[shop["address"]]["flagged_at"] is None


async def test_nobody_sees_or_changes_someone_elses_aliases(client, db):  # noqa: F811
    a, account, f, domain = await _setup(client, db)
    shop = await _alias(client, a, domain["id"])
    msg_id = f"<a-{uuid.uuid4().hex}@shop.example>"
    await _arrive(account, f["inbox"], [_raw(to=shop["address"], message_id=msg_id)])
    b, b_account, b_f, b_domain = await _setup(client, db)

    assert await _list(client, b) == {}
    assert [d["id"] for d in (await client.get("/api/passwords/aliases/domains", headers=b.h)).json()] == [b_domain["id"]]
    for method, path, body in (
        ("PATCH", f"/api/passwords/aliases/{shop['id']}", {"enabled": False}),
        ("POST", f"/api/passwords/aliases/{shop['id']}/allow", {"sender": "x.example"}),
        ("DELETE", f"/api/passwords/aliases/{shop['id']}", None),
        ("PATCH", f"/api/passwords/aliases/domains/{domain['id']}", {"random_len": 5}),
        ("POST", f"/api/passwords/aliases/domains/{domain['id']}/check", None),
        ("GET", f"/api/passwords/aliases/domains/{domain['id']}/folders", None),
        ("DELETE", f"/api/passwords/aliases/domains/{domain['id']}", None),
        ("POST", "/api/passwords/aliases", {"domain_id": domain["id"], "word": "x"}),
    ):
        r = await client.request(method, path, headers=b.h, json=body)
        assert r.status_code == 404, (method, path, r.status_code)
    # Their folder can't be the place your alias mail goes.
    assert (await client.patch(f"/api/passwords/aliases/domains/{b_domain['id']}", headers=b.h, json={"off_folder_id": str(f["other"].id)})).status_code == 404
    # From Mail too.
    msg = await db.scalar(select(MailMessage).where(MailMessage.message_id == msg_id))
    assert (await client.get(f"/api/mail/aliases/thread/{account.id}/{msg.thread_key}", headers=bearer(b.user))).status_code == 404
    assert (await client.patch(f"/api/mail/aliases/{shop['id']}", headers=bearer(b.user), json={"enabled": False})).status_code == 404
    send = {"account_id": str(b_account.id), "to": ["x@example.com"], "text": "hi", "from_alias": shop["address"]}
    r = await client.post("/api/mail/send", headers=bearer(b.user), json=send)
    assert r.status_code == 404, r.text
    assert (await _list(client, a))[shop["address"]]["enabled"] is True

    # The same domain added by someone else counts only mail in their own mailbox.
    clash = (await db.execute(select(al.MailAlias).where(al.MailAlias.id == uuid.UUID(shop["id"])))).scalar_one()
    db.add(al.MailAlias(user_id=b.user.id, domain_id=uuid.UUID(b_domain["id"]), address=clash.address))
    await db.commit()
    await _arrive(account, f["inbox"], [_raw(to=shop["address"])])
    assert (await _list(client, a))[shop["address"]]["count"] == 2
    assert (await _list(client, b))[shop["address"]]["count"] == 0


async def test_the_setup_check(client, db, monkeypatch):  # noqa: F811
    from app.mail import imap
    from app.passwords import aliases as pw
    # A mail server on this network is refused for someone who can't reach it.
    b = await setup_vault(client, await make_user(db))
    b_account, _ = await _mailbox(db, b.user)
    await db.execute(update(MailAccount).where(MailAccount.id == b_account.id).values(smtp_host="127.0.0.1"))
    await db.commit()
    bd = (await client.post("/api/passwords/aliases/domains", headers=b.h, json={"domain": DOMAIN, "account_id": str(b_account.id)})).json()
    assert (await client.post(f"/api/passwords/aliases/domains/{bd['id']}/check", headers=b.h)).status_code == 422
    # (The test's mail server names don't resolve here.)
    monkeypatch.setattr(imap, "check_host", lambda host, allow_private: None)

    a = await setup_vault(client, await make_user(db, role="admin"))
    account, f = await _mailbox(db, a.user)
    domain = (await client.post("/api/passwords/aliases/domains", headers=a.h, json={"domain": DOMAIN, "account_id": str(account.id)})).json()
    sent: list[EmailMessage] = []

    async def fake_send(_account, message, to):
        sent.append(message)

    monkeypatch.setattr(pw, "_send", fake_send)
    url = f"/api/passwords/aliases/domains/{domain['id']}/check"
    r = await client.post(url, headers=a.h)
    assert r.status_code == 200 and r.json()["status"] == "checking"
    test = sent[-1]
    assert test["To"].startswith(al.CHECK_PREFIX) and test["To"].endswith("@" + DOMAIN)
    # Once a minute at most.
    assert (await client.post(url, headers=a.h)).status_code == 429
    assert len(sent) == 1
    monkeypatch.setattr(pw, "CHECK_EVERY", timedelta(0))
    assert al.CHECK_SENDER_PREFIX in test["From"]

    # It arrives, From unchanged: the catch-all works and so does sending as the domain.
    await _arrive(account, f["inbox"], [test.as_bytes()])
    got = (await client.get("/api/passwords/aliases/domains", headers=a.h)).json()[0]
    assert (got["status"], got["send_as"]) == ("ok", "ok")
    assert await _where(db, test["Message-ID"]) == "trash"

    # The provider rewrote the sender.
    await client.post(url, headers=a.h)
    test = sent[-1]
    test.replace_header("From", account.email)
    await _arrive(account, f["inbox"], [test.as_bytes()])
    got = (await client.get("/api/passwords/aliases/domains", headers=a.h)).json()[0]
    assert (got["status"], got["send_as"]) == ("ok", "rewritten") and account.email in got["send_as_detail"]

    # The provider refused the sender: said so, and the check goes on from the mailbox's own address.
    async def refusing(_account, message, to):
        if message["From"] and DOMAIN in message["From"]:
            raise aiosmtplib.SMTPSenderRefused(553, "5.7.1 Sender address rejected: not owned by user", message["From"])
        sent.append(message)

    monkeypatch.setattr(pw, "_send", refusing)
    got = (await client.post(url, headers=a.h)).json()
    assert (got["status"], got["send_as"]) == ("checking", "refused") and "553" in got["send_as_detail"]
    assert account.email in str(sent[-1]["From"])
    await _arrive(account, f["spam"], [sent[-1].as_bytes()])
    got = (await client.get("/api/passwords/aliases/domains", headers=a.h)).json()[0]
    assert (got["status"], got["send_as"]) == ("ok", "refused") and "Spam" in got["status_detail"]

    # It never arrives.
    await client.post(url, headers=a.h)
    await db.execute(update(al.MailAliasDomain).values(check_started_at=datetime.now(timezone.utc) - timedelta(minutes=11)))
    await db.commit()
    got = (await client.get("/api/passwords/aliases/domains", headers=a.h)).json()[0]
    assert got["status"] == "failed" and account.email in got["status_detail"]



async def test_replying_from_an_alias(client, db):  # noqa: F811
    a, account, f, domain = await _setup(client, db)
    shop = await _alias(client, a, domain["id"])
    body = {"account_id": str(account.id), "to": ["support@shop.example"], "subject": "Re: order", "text": "Thanks", "from_alias": shop["address"].upper()}
    r = await client.post("/api/mail/send", headers=bearer(a.user), json=body)
    assert r.status_code == 202, r.text
    item = await db.get(MailOutbox, uuid.UUID(r.json()["id"]))
    raw = item.raw
    assert f"From: {shop['address']}" in raw and f"@{DOMAIN}>" in raw.split("Message-ID:")[1].splitlines()[0]
    assert account.email not in raw.split("\n\n")[0]

    # Not an alias of yours, or one the provider won't send as.
    assert (await client.post("/api/mail/send", headers=bearer(a.user), json={**body, "from_alias": f"nobody@{DOMAIN}"})).status_code == 404
    await db.execute(update(al.MailAliasDomain).values(send_as="refused", send_as_detail="Add it as a send-as address."))
    await db.commit()
    r = await client.post("/api/mail/send", headers=bearer(a.user), json=body)
    assert r.status_code == 409 and "send-as" in r.json()["detail"]


# ------------------------------------------------------------------ a real mail server

from tests.test_mail import HOST, _connect, _live_account, _mailbox as _imap, _sync, live, server  # noqa: E402,F401


def _deliver_to_alias(alias: str, subject: str, header: str = "To", sender: str = "Shop <hello@shop.example>") -> str:
    """What a catch-all does: the mailbox gets it, the alias stays in the headers."""
    m = EmailMessage()
    m["From"] = sender
    m[header] = alias
    if header != "To":
        m["To"] = "undisclosed-recipients:;"
    m["Subject"] = subject
    m["Message-ID"] = f"<{uuid.uuid4().hex}@shop.example>"
    m.set_content("Hello")
    with smtplib.SMTP(HOST, 3025, timeout=20) as s:
        s.send_message(m, to_addrs=["alice@mailtest.example"])
    return m["Message-ID"]


def _subjects(folder: str, email: str = "alice@mailtest.example") -> list[str]:
    c = _imap(email)
    try:
        c.select_folder(folder)
        uids = c.search(["ALL"])
        return sorted(v[b"ENVELOPE"].subject.decode() for v in c.fetch(uids, ["ENVELOPE"]).values())
    finally:
        c.logout()


@live
async def test_live_routing_and_turning_off(client, db, server):  # noqa: F811
    a = await setup_vault(client, await make_user(db, role="admin"))
    account = await _live_account(db, a.user)
    await _sync(account)
    domain = (await client.post("/api/passwords/aliases/domains", headers=a.h, json={"domain": DOMAIN, "account_id": str(account.id)})).json()
    shop = await _alias(client, a, domain["id"])
    _deliver_to_alias(shop["address"], "To header")
    _deliver_to_alias(shop["address"], "Original-To header", header="X-Original-To")
    await _sync(account)
    assert (await _list(client, a))[shop["address"]]["count"] == 2

    await client.patch(f"/api/passwords/aliases/{shop['id']}", headers=a.h, json={"enabled": False})
    _deliver_to_alias(shop["address"], "After turning off")
    await _sync(account)  # copies it, files it
    await _sync(account)  # the mailbox follows
    assert _subjects("Trash") == ["After turning off"]
    assert _subjects("INBOX") == ["Original-To header", "To header"]


@live
async def test_live_check_and_reply_from_an_alias(client, db, server, monkeypatch):  # noqa: F811
    a = await setup_vault(client, await make_user(db, role="admin"))
    account = await _live_account(db, a.user)
    await _sync(account)
    domain = (await client.post("/api/passwords/aliases/domains", headers=a.h, json={"domain": DOMAIN, "account_id": str(account.id)})).json()
    real = worker._smtp_send

    async def catch_all(acct, raw, recipients):
        # GreenMail has no catch-all: this is the provider's part.
        await real(acct, raw, ["alice@mailtest.example" if r.endswith("@" + DOMAIN) else r for r in recipients])

    monkeypatch.setattr(worker, "_smtp_send", catch_all)
    r = await client.post(f"/api/passwords/aliases/domains/{domain['id']}/check", headers=a.h)
    assert r.status_code == 200 and r.json()["status"] == "checking", r.text
    for _ in range(10):
        await _sync(account)
        got = (await client.get("/api/passwords/aliases/domains", headers=a.h)).json()[0]
        if got["status"] != "checking":
            break
        await asyncio.sleep(0.5)
    assert (got["status"], got["send_as"]) == ("ok", "ok"), got

    shop = await _alias(client, a, domain["id"])
    body = {"account_id": str(account.id), "to": ["bob@mailtest.example"], "subject": "From an alias", "text": "Hi Bob", "from_alias": shop["address"]}
    sent = await client.post("/api/mail/send", headers=bearer(a.user), json=body)
    assert sent.status_code == 202, sent.text
    await db.execute(update(MailOutbox).values(send_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    await db.commit()
    c = await asyncio.to_thread(_connect, account)
    try:
        await worker._send_due(c, account, True)
    finally:
        # GreenMail over TLS never answers QUIT, so a send waits out its timeout and
        # this connection has gone idle by then. That's GreenMail, not the send.
        with contextlib.suppress(Exception):
            await asyncio.to_thread(c.logout)
    bob = _imap("bob@mailtest.example")
    try:
        bob.select_folder("INBOX")
        envelopes = [v[b"ENVELOPE"] for v in bob.fetch(bob.search(["ALL"]), ["ENVELOPE"]).values()]
    finally:
        bob.logout()
    froms = [f"{e.from_[0].mailbox.decode()}@{e.from_[0].host.decode()}" for e in envelopes if e.subject == b"From an alias"]
    assert froms == [shop["address"]]
