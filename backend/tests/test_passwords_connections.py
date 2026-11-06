"""Mail codes, security emails, plus-address rules, documents from Files, the reminder
and the survival warnings."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.passwords.connections import extract_code, extract_link, plain_text, security_kind
from tests.test_passwords import b64, bearer, client, make_user, setup_vault  # noqa: F401


@pytest.mark.parametrize(
    "subject,body,want",
    [
        ("Your verification code", "Use this code to sign in:\n\n482913\n\nIt expires in 10 minutes.", "482913"),
        ("482913 is your Netflix code", "Hi,", "482913"),
        ("Sign-in attempt", "Your login code is 73-1", None),
        ("Security code", "Your security code is 104-882.", "104-882"),
        ("Código de verificación", "Tu código es 551203", "551203"),
        ("Dein Sicherheitscode", "Sicherheitscode: 668120", "668120"),
        ("認証コード", "コード: 998877", "998877"),
        ("Confirm it's you", "Enter this code: K7Q2MX", "K7Q2MX"),
        # Numbers that aren't codes.
        ("Your order has shipped", "Order 12345678 is on its way. Tracking 998877665.", None),
        ("Invoice 20391", "Total: $1,250.00. Reference 882211.", None),
        ("Newsletter 2026", "Our best stories of 2026. Call 13001234.", None),
        ("Your code expires soon", "Copyright 2026 Example Pty Ltd", None),
        ("Your discount", "Use promo code SAVE20 for 20% off", None),
        ("Hello from Sam", "See you at 1830 at unit 12", None),
    ],
)
def test_extract_code(subject, body, want):
    assert extract_code(subject, body) == want


def test_extract_link():
    html = '<a href="https://example.com/help">Help</a> <a href="https://app.example.com/auth/magic?token=abc123def456">Sign in</a>'
    assert extract_link("Sign in to Example", "", html) == "https://app.example.com/auth/magic?token=abc123def456"
    assert extract_link("Your receipt", "Thanks for buying", '<a href="https://shop.example/login/x">x</a>') is None
    # No http, no credentials in the host, no unsubscribe.
    assert extract_link("Log in", "http://x.example/login/abcdefghijklmnopqrstuvwxyz", "") is None
    assert extract_link("Log in", "https://bank.example@evil.example/login/abc", "") is None
    assert extract_link("Log in", "https://x.example/unsubscribe/login/abcdefghijkl", "") is None


def test_html_only_mail_is_read_as_text():
    assert extract_code("Verify", plain_text("", "<p>Your code is</p><p><b>551203</b></p><style>.x{color:#123456}</style>")) == "551203"


def test_security_kinds():
    assert security_kind("Your password was changed") == "password_changed"
    assert security_kind("New sign-in from Chrome on Windows") == "new_signin"
    assert security_kind("Weekly digest") is None


async def _mailbox(db, user):
    from app.mail.models import MailAccount, MailFolder

    account = MailAccount(
        user_id=user.id,
        email=f"{uuid.uuid4().hex[:8]}@example.com",
        imap_host="localhost",
        imap_port=993,
        imap_security="ssl",
        smtp_host="localhost",
        smtp_port=465,
        smtp_security="ssl",
        username="x",
        secret_encrypted="x",
    )
    db.add(account)
    await db.flush()
    folders = {}
    for role in ("inbox", "trash", "spam", "drafts"):
        f = MailFolder(account_id=account.id, path=role, name=role, role=role)
        db.add(f)
        folders[role] = f
    await db.flush()
    return account, folders


def _mail(account, folder, *, uid, subject="Your verification code", body="Your code is 482913", sender="no-reply@netflix.com", ago=timedelta(minutes=1)):
    from app.mail.models import MailMessage

    return MailMessage(account_id=account.id, folder_id=folder.id, uid=uid, thread_key=uuid.uuid4().hex, subject=subject, from_name="Netflix", from_addr=sender, sent_at=datetime.now(timezone.utc) - ago, body_text=body)


async def test_mail_codes_recent_mine_and_not_trash(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    db.add_all(
        [
            _mail(account, f["inbox"], uid=1),
            _mail(account, f["inbox"], uid=2, body="Your code is 111111", ago=timedelta(minutes=11)),
            _mail(account, f["trash"], uid=3, body="Your code is 222222"),
            _mail(account, f["spam"], uid=4, body="Your code is 333333"),
            _mail(account, f["drafts"], uid=5, body="Your code is 444444"),
        ]
    )
    await db.commit()
    r = await client.get("/api/passwords/mail/codes", headers=a.h)
    assert r.status_code == 200, r.text
    got = r.json()
    assert [c["code"] for c in got] == ["482913"]
    assert got[0]["from_domain"] == "netflix.com"
    assert r.headers["cache-control"] == "no-store"
    # Someone else's mail, or without a vault session.
    assert (await client.get("/api/passwords/mail/codes", headers=b.h)).json() == []
    assert (await client.get("/api/passwords/mail/codes", headers=bearer(a.user))).status_code in (401, 403)


async def test_security_events(client, db):
    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    db.add_all(
        [
            _mail(account, f["inbox"], uid=1, subject="Your password was changed", sender="security@instagram.com", ago=timedelta(days=3)),
            _mail(account, f["inbox"], uid=2, subject="Weekly digest", sender="news@instagram.com"),
            _mail(account, f["inbox"], uid=3, subject="Your password was changed", sender="security@old.example", ago=timedelta(days=45)),
        ]
    )
    await db.commit()
    got = (await client.get("/api/passwords/mail/security-events", headers=a.h)).json()
    assert [(e["kind"], e["from_domain"]) for e in got] == [("password_changed", "instagram.com")]


async def test_plus_rule_labels_mail_as_it_arrives(client, db):
    from app.mail import rules
    from app.mail.models import MailLabel, MailRule, MailThreadLabel

    a = await setup_vault(client, await make_user(db))
    # No mailbox yet, and only a plus-address will do.
    assert (await client.post("/api/passwords/mail/plus-rule", headers=a.h, json={"address": "me+shop@example.com"})).status_code == 409
    account, f = await _mailbox(db, a.user)
    await db.commit()
    assert (await client.post("/api/passwords/mail/plus-rule", headers=a.h, json={"address": "plain@example.com"})).status_code == 400
    r = await client.post("/api/passwords/mail/plus-rule", headers=a.h, json={"address": "Me+Shop@Example.com"})
    assert r.status_code == 201 and r.json()["label"] == "Plus addresses/shop"
    assert (await client.post("/api/passwords/mail/plus-rule", headers=a.h, json={"address": "me+shop@example.com"})).status_code == 201

    rule = (await db.execute(select(MailRule).where(MailRule.user_id == a.user.id))).scalar_one()
    assert rule.kind == "to" and rule.value == "me+shop@example.com"
    label = await db.get(MailLabel, rule.label_id)
    assert label.name == "Plus addresses/shop"

    hit = _mail(account, f["inbox"], uid=10, ago=timedelta(minutes=-5))
    hit.to_addrs = [{"name": "", "addr": "me+shop@example.com"}]
    miss = _mail(account, f["inbox"], uid=11, ago=timedelta(minutes=-5))
    miss.to_addrs = [{"name": "", "addr": "me@example.com"}]
    db.add_all([hit, miss])
    await db.flush()
    await rules.apply_to_new(db, account.id, f["inbox"], [hit, miss])
    await db.commit()
    keys = (await db.execute(select(MailThreadLabel.thread_key).where(MailThreadLabel.label_id == label.id))).scalars().all()
    assert hit.thread_key in keys and miss.thread_key not in keys


async def test_documents_from_files(client, db, tmp_path, monkeypatch):
    from app.files import storage
    from app.files.models import UserFile

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path)
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    (tmp_path / "passport.pdf").write_bytes(b"%PDF scan")
    row = UserFile(user_id=a.user.id, filename="passport.pdf", original_filename="passport.pdf", mime_type="application/pdf", size_bytes=9, storage_path="passport.pdf")
    db.add(row)
    await db.commit()

    got = (await client.get("/api/passwords/drive/files", headers=a.h, params={"q": "PASS"})).json()
    assert [f["name"] for f in got] == ["passport.pdf"]
    assert (await client.get("/api/passwords/drive/files", headers=b.h)).json() == []
    r = await client.get(f"/api/passwords/drive/files/{row.id}/content", headers=a.h)
    assert r.content == b"%PDF scan" and r.headers["cache-control"] == "no-store"
    assert (await client.get(f"/api/passwords/drive/files/{row.id}/content", headers=b.h)).status_code == 404
    assert (await client.post(f"/api/passwords/drive/files/{row.id}/trash", headers=b.h)).status_code == 404
    assert (await client.post(f"/api/passwords/drive/files/{row.id}/trash", headers=a.h)).status_code == 204
    assert (await client.get("/api/passwords/drive/files", headers=a.h)).json() == []


async def test_reminder_says_nothing_about_the_document(client, db):
    from app.calendars.models import CalEvent

    a = await setup_vault(client, await make_user(db))
    r = await client.post("/api/passwords/reminder", headers=a.h, json={"on": date(2030, 5, 1).isoformat(), "title": "Passport"})
    assert r.status_code == 201, r.text
    ev = await db.get(CalEvent, uuid.UUID(r.json()["id"]))
    assert ev.title == "Document expires soon"


async def test_survival_reports_only_what_the_server_knows(client, db):
    a = await setup_vault(client, await make_user(db))
    got = (await client.get("/api/passwords/survival", headers=a.h)).json()
    assert got["kit_confirmed"] is False and got["is_admin"] is False
    assert (await client.post("/api/passwords/account/kit", headers=a.h)).status_code == 204
    assert (await client.get("/api/passwords/survival", headers=a.h)).json()["kit_confirmed"] is True
    assert b64(b"x")


async def test_today_gets_counts_only(client, db):
    from app.today import hub

    a = await setup_vault(client, await make_user(db))
    assert (await client.put("/api/passwords/health", headers=a.h, json={"weak": 2, "reused": 1, "breached": 0, "old": 9})).status_code == 204
    out = {"tz": "UTC", "now": datetime.now(timezone.utc).isoformat(), "sections": {}}
    await hub.extend(db, a.user, out)
    assert out["sections"]["passwords"]["attention"] == 3
    # Turned off, the card goes.
    assert (await client.delete("/api/passwords/health", headers=a.h)).status_code == 204
    out = {"tz": "UTC", "now": datetime.now(timezone.utc).isoformat(), "sections": {}}
    await hub.extend(db, a.user, out)
    assert "passwords" not in out["sections"]
