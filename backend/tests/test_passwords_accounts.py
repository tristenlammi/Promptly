"""Accounts you have, from your own mail: the evidence rules, the incremental reading
and that only the person's own mail is used."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.passwords import accounts as acc
from app.passwords.accounts import classify, evidence_kind, receiving_address, registrable, sender_site, site_from_links
from tests.test_passwords import bearer, client, make_user, setup_vault  # noqa: F401

ME = "sam@example.org"


# ------------------------------------------------------------------ rules, no database


@pytest.mark.parametrize(
    "host,want",
    [
        ("mail.instagram.com", "instagram.com"),
        ("em.shop.co.uk", "shop.co.uk"),
        ("paypal.com.au", "paypal.com.au"),
        ("accounts.google.com", "google.com"),
        ("co.uk", None),
        ("localhost", None),
        ("192.168.1.1", None),
        ("", None),
    ],
)
def test_registrable(host, want):
    assert registrable(host) == want


@pytest.mark.parametrize(
    "subject,want",
    [
        ("Welcome to Netflix!", "welcome"),
        ("Thanks for signing up", "welcome"),
        ("Your account has been created", "welcome"),
        ("Please verify your email address", "verify"),
        ("Confirm your account", "verify"),
        ("Reset your password", "reset"),
        ("Password reset request", "reset"),
        ("New sign-in to your account", "signin"),
        ("Security alert", "signin"),
        ("Your password was changed", "security"),
        ("Your receipt from Example #1234", "receipt"),
        ("Order confirmation", "receipt"),
        ("Your Spotify Premium subscription has been renewed", "subscription"),
        ("Your free trial ends tomorrow", "subscription"),
        ("Bienvenue sur Exemple", "welcome"),
        ("Passwort zurücksetzen", "reset"),
        # Not accounts.
        ("Welcome to the Weekly Digest", None),
        ("Welcome! Here's 20% off your first order", None),
        ("Please confirm your subscription", None),
        ("You're now subscribed to Tech News", None),
        ("Our biggest sale of the year", None),
        ("Lunch on Friday?", None),
        ("Welcome back, we missed you", None),
        # Forwards and replies are someone else's mail, or a conversation.
        ("Fwd: Welcome to Netflix!", None),
        ("FW: Reset your password", None),
        ("Re: Welcome to the team", None),
        ("", None),
    ],
)
def test_evidence_kind(subject, want):
    assert evidence_kind(subject) == want


def test_site_from_the_sender():
    assert classify(subject="Welcome to Instagram", from_addr="no-reply@mail.instagram.com", account_email=ME).domain == "instagram.com"
    # Facebook sends from facebookmail.com.
    assert classify(subject="New login to Facebook", from_addr="security@facebookmail.com", account_email=ME).domain == "facebook.com"


def test_sending_services_use_reply_to_then_links():
    # Reply-To names the site.
    ev = classify(subject="Verify your email", from_addr="bounces+123@sendgrid.net", reply_to="help@acme-tools.com", account_email=ME)
    assert ev and ev.domain == "acme-tools.com"
    # No Reply-To: the links say, leaving out the service's own trackers and social footers.
    html = (
        '<a href="https://u123.ct.sendgrid.net/ls/click?upn=abc">x</a>'
        '<a href="https://www.facebook.com/acme">fb</a>'
        '<a href="https://app.widgetco.io/verify?t=1">Verify</a>'
        '<a href="https://widgetco.io/help">Help</a>'
        '<a href="https://mailchimp.com/">Powered by</a>'
    )
    ev = classify(subject="Verify your email", from_addr="noreply@amazonses.com", account_email=ME, body_html=html)
    assert ev and ev.domain == "widgetco.io"
    # Amazon SES with nothing to go on isn't anything.
    assert classify(subject="Welcome!", from_addr="x@us-west-2.amazonses.com", account_email=ME) is None
    # Mailchimp's customer-sending domains too.
    assert sender_site("acme=example.com@mail123.atl11.mcsv.net", "", '<a href="https://shop.example.net/account">a</a>') == "example.net"
    assert acc.needs_body("x@sendgrid.net", "") is True
    assert acc.needs_body("x@sendgrid.net", "help@acme.com") is False
    assert acc.needs_body("x@acme.com", "") is False


def test_links_pick_the_commonest_site():
    html = '<a href="https://a.example.com/1">1</a><a href="https://b.example.com/2">2</a><a href="https://other.test/3">3</a>'
    assert site_from_links(html, "") == "example.com"
    assert site_from_links('<a href="javascript:alert(1)">x</a><a href="https://user@evil.test/">y</a>', "") is None


def test_newsletters_and_people_are_not_accounts():
    # A newsletter platform's welcome is a mailing list.
    assert classify(subject="Welcome to The Daily Thing", from_addr="thedailything@substack.com", account_email=ME) is None
    # A person writing from their own mailbox.
    assert classify(subject="Welcome to the neighbourhood!", from_addr="pat.jones@gmail.com", account_email=ME) is None
    assert classify(subject="Reset your password", from_addr="someone@yahoo.co.uk", account_email=ME) is None
    # Your own mail to yourself.
    assert classify(subject="Welcome to my notes", from_addr=ME, account_email=ME) is None
    # A forwarded welcome, from whoever forwarded it.
    assert classify(subject="Fwd: Welcome to Netflix!", from_addr="info@mailer.netflix.com", account_email=ME) is None
    # Marketing with "welcome" in it.
    assert classify(subject="Welcome! Take 15% off today", from_addr="news@shop.example.com", account_email=ME) is None


def test_receiving_address():
    assert receiving_address([{"name": "", "addr": "Sam+shop@Example.org"}], ME) == "sam+shop@example.org"
    # Forwarded in from another address of yours: that's the one the site has.
    assert receiving_address([{"name": "", "addr": "sam@old-isp.net"}], ME) == "sam@old-isp.net"
    assert receiving_address([], ME) == ME
    # Your own address wins over a list it was also sent to.
    assert receiving_address([{"addr": "team@lists.example.com"}, {"addr": "sam@example.org"}], ME) == ME


def test_deletion_lookup(monkeypatch, tmp_path):
    path = tmp_path / "d.json"
    path.write_text(
        '{"sites": {"example.com": {"url": "https://example.com/account/delete", "difficulty": "easy", "name": "Example"},'
        ' "bad.test": {"url": "javascript:alert(1)", "email": "not an email"},'
        ' "mail.test": {"email": "privacy@mail.test", "difficulty": "hard"}}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(acc, "DATA_FILE", path)
    acc.deletion_sites.cache_clear()
    try:
        assert acc.deletion_for("example.com") == {"url": "https://example.com/account/delete", "difficulty": "easy", "name": "Example"}
        assert acc.deletion_for("shop.example.com") == acc.deletion_for("example.com")
        assert acc.deletion_for("bad.test") is None
        assert acc.deletion_for("mail.test") == {"email": "privacy@mail.test", "difficulty": "hard"}
        assert acc.deletion_for("unknown.test") is None
    finally:
        acc.deletion_sites.cache_clear()


def test_shipped_deletion_data_loads():
    acc.deletion_sites.cache_clear()
    sites = acc.deletion_sites()
    # The JustDeleteMe list as shipped: thousands of domains, every page on https.
    assert len(sites) > 1000
    assert all(row["url"].startswith("https://") for row in sites.values() if "url" in row)
    assert acc.deletion_for("123rf.com") is not None


# ------------------------------------------------------------------ with the database


async def _mailbox(db, user, email=None, roles=("inbox", "trash", "spam", "drafts", "sent", "archive")):
    from app.mail.models import MailAccount, MailFolder

    account = MailAccount(
        user_id=user.id, email=email or f"{uuid.uuid4().hex[:8]}@example.org", imap_host="localhost", imap_port=993, imap_security="ssl",
        smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x",
    )
    db.add(account)
    await db.flush()
    folders = {}
    for role in roles:
        f = MailFolder(account_id=account.id, path=role, name=role, role=role, uidvalidity=1)
        db.add(f)
        folders[role] = f
    await db.flush()
    return account, folders


def _mail(account, folder, *, uid, subject, sender, ago=timedelta(days=1), to=None, reply_to="", html="", name="Site"):
    from app.mail.models import MailMessage

    return MailMessage(
        account_id=account.id, folder_id=folder.id, uid=uid, thread_key=uuid.uuid4().hex, subject=subject, from_name=name, from_addr=sender,
        to_addrs=to if to is not None else [{"name": "", "addr": account.email}], reply_to=reply_to,
        sent_at=datetime.now(timezone.utc) - ago, body_html=html,
    )


async def _sites(client, who):
    r = await client.get("/api/passwords/mail/accounts", headers=who.h)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return r.json()


async def test_list_from_my_own_mail_only(client, db):
    a = await setup_vault(client, await make_user(db))
    b = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user)
    other, g = await _mailbox(db, b.user)
    db.add_all(
        [
            _mail(account, f["inbox"], uid=1, subject="Welcome to Netflix!", sender="info@mailer.netflix.com", ago=timedelta(days=400)),
            _mail(account, f["inbox"], uid=2, subject="Reset your password", sender="info@account.netflix.com", ago=timedelta(days=3), to=[{"addr": account.email.replace("@", "+tv@")}]),
            _mail(account, f["archive"], uid=1, subject="Your receipt from Acme", sender="billing@acme.test"),
            _mail(account, f["inbox"], uid=3, subject="Verify your email", sender="bounce@sendgrid.net", html='<a href="https://app.widgetco.io/v?t=1">v</a>'),
            _mail(account, f["inbox"], uid=4, subject="Fwd: Welcome to Hulu", sender="friend@gmail.com"),
            _mail(account, f["inbox"], uid=5, subject="This week's newsletter", sender="news@paper.test"),
            # Not mail you were sent, or thrown away.
            _mail(account, f["trash"], uid=1, subject="Welcome to Trashed", sender="hi@trashed.test"),
            _mail(account, f["spam"], uid=1, subject="Verify your account", sender="hi@spammy.test"),
            _mail(account, f["drafts"], uid=1, subject="Welcome to Drafted", sender=account.email),
            _mail(account, f["sent"], uid=1, subject="Welcome to Sent", sender="hi@sent.test"),
            # Someone else's mailbox.
            _mail(other, g["inbox"], uid=1, subject="Welcome to Theirs", sender="hi@theirs.test"),
        ]
    )
    await db.commit()

    got = await _sites(client, a)
    assert got["mail"] is True and got["complete"] is True
    by = {s["domain"]: s for s in got["sites"]}
    assert set(by) == {"netflix.com", "acme.test", "widgetco.io"}
    n = by["netflix.com"]
    assert n["kinds"] == ["reset", "welcome"]
    assert n["address"] == account.email.replace("@", "+tv@")
    assert n["first_seen"] < n["last_seen"]
    assert n["open"] and n["open"].startswith(f"{account.id}/")
    assert by["acme.test"]["kinds"] == ["receipt"]

    theirs = await _sites(client, b)
    assert [s["domain"] for s in theirs["sites"]] == ["theirs.test"]
    # Not without a vault session.
    assert (await client.get("/api/passwords/mail/accounts", headers=bearer(a.user))).status_code in (401, 403)


async def test_no_mailbox(client, db):
    a = await setup_vault(client, await make_user(db))
    assert await _sites(client, a) == {"mail": False, "complete": True, "sites": []}


async def test_reads_only_what_is_new(client, db, monkeypatch):
    from app.passwords.accounts_models import PwMailScan

    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user, roles=("inbox",))
    db.add(_mail(account, f["inbox"], uid=10, subject="Welcome to Alpha", sender="hi@alpha.test", ago=timedelta(days=5)))
    await db.commit()
    assert [s["domain"] for s in (await _sites(client, a))["sites"]] == ["alpha.test"]

    # Count what each run reads.
    seen: list[str] = []
    real = acc.evidence_kind

    def counting(subject):
        seen.append(subject)
        return real(subject)

    monkeypatch.setattr(acc, "evidence_kind", counting)
    await _sites(client, a)
    assert seen == []

    # New mail above, and older mail copied in below.
    db.add_all(
        [
            _mail(account, f["inbox"], uid=11, subject="New sign-in to Alpha", sender="security@alpha.test", ago=timedelta(hours=1)),
            _mail(account, f["inbox"], uid=3, subject="Your receipt", sender="shop@beta.test", ago=timedelta(days=900)),
        ]
    )
    await db.commit()
    got = {s["domain"]: s for s in (await _sites(client, a))["sites"]}
    assert set(seen) == {"New sign-in to Alpha", "Your receipt"}
    assert got["alpha.test"]["kinds"] == ["signin", "welcome"]
    assert "beta.test" in got
    cur = await db.scalar(select(PwMailScan).where(PwMailScan.folder_id == f["inbox"].id))
    await db.refresh(cur)
    assert (cur.lo_uid, cur.hi_uid) == (3, 11)

    # Numbered again by the server: read again, and nothing's counted twice.
    f["inbox"].uidvalidity = 2
    await db.commit()
    seen.clear()
    again = {s["domain"]: s for s in (await _sites(client, a))["sites"]}
    assert set(seen) == {"Welcome to Alpha", "New sign-in to Alpha", "Your receipt"}
    assert again["alpha.test"]["kinds"] == ["signin", "welcome"]
    assert again["alpha.test"]["first_seen"] == got["alpha.test"]["first_seen"]


async def test_budget_carries_on_next_time(client, db, monkeypatch):
    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user, roles=("inbox",))
    db.add_all([_mail(account, f["inbox"], uid=i, subject=f"Welcome to Site{i}", sender=f"hi@site{i}.test") for i in range(1, 8)])
    await db.commit()
    monkeypatch.setattr(acc, "INLINE_BUDGET", 3)
    monkeypatch.setattr(acc, "BATCH", 2)
    first = await _sites(client, a)
    assert first["complete"] is False and len(first["sites"]) == 3
    await _sites(client, a)
    third = await _sites(client, a)
    assert len(third["sites"]) == 7


async def test_deleted_mail_loses_its_link_and_mailbox_removal_drops_rows(client, db):
    from app.mail.models import MailAccount, MailMessage

    a = await setup_vault(client, await make_user(db))
    account, f = await _mailbox(db, a.user, roles=("inbox",))
    m = _mail(account, f["inbox"], uid=1, subject="Welcome to Gamma", sender="hi@gamma.test")
    db.add(m)
    await db.commit()
    assert (await _sites(client, a))["sites"][0]["open"]
    await db.delete(await db.get(MailMessage, m.id))
    await db.commit()
    assert (await _sites(client, a))["sites"][0]["open"] is None
    await db.delete(await db.get(MailAccount, account.id))
    await db.commit()
    assert (await _sites(client, a)) == {"mail": False, "complete": True, "sites": []}


async def test_background_run_only_for_people_with_a_vault(client, db):
    from app.passwords.accounts_models import PwMailSite

    a = await setup_vault(client, await make_user(db))
    no_vault = await make_user(db)
    account, f = await _mailbox(db, a.user, roles=("inbox",))
    other, g = await _mailbox(db, no_vault, roles=("inbox",))
    db.add_all(
        [
            _mail(account, f["inbox"], uid=1, subject="Welcome to Delta", sender="hi@delta.test"),
            _mail(other, g["inbox"], uid=1, subject="Welcome to Epsilon", sender="hi@epsilon.test"),
        ]
    )
    await db.commit()
    assert await acc.refresh_all() == 1
    rows = (await db.execute(select(PwMailSite.user_id, PwMailSite.domain))).all()
    assert rows == [(a.user.id, "delta.test")]


async def test_device_without_mail_scope_is_refused(client, db):
    """An extension connected without mail access can't read this list either."""
    from app.passwords.connections import _check_mail_scope

    class Device:
        scopes = ["vault"]

    class Session:
        device = Device()

    with pytest.raises(Exception) as e:
        _check_mail_scope(Session())
    assert getattr(e.value, "status_code", None) == 403

def test_background_pass_runs_in_the_passwords_loop_not_arq():
    """arq runs automations, which may not import Passwords (test_no_chat_tool_touches_the_vault)."""
    import inspect

    from app.passwords import service
    from app.tasks.worker import WorkerSettings

    assert "refresh_all" in inspect.getsource(service._loop)
    assert not [c for c in WorkerSettings.cron_jobs if "pw_mail" in c.coroutine.__name__]
