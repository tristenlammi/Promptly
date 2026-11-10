"""Admin privacy, part 2 (docs/admin-privacy-audit.md, AP5-AP10).

The owner's rule: a server admin can never see another user's data, except
where that's obviously intended (the social side). Where running the
server needs an admin to act on an account, the person is told.

* AP5 (U1-U3): admin changes to an account are never silent: email (the
  old address too, for an email change), a notification, a one-time banner,
  and the person's own Recent activity. An admin can email a reset link so
  they never learn a working password.
"""
from __future__ import annotations

import re
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.auth.models import User


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


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _user(db, name, role="user"):
    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}{uuid.uuid4().hex[:6]}",
        password_hash="x",
        role=role,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture
def outbox(monkeypatch):
    """Emails and notifications, captured instead of sent."""
    from app.mfa import smtp
    from app.notifications import dispatch

    box = {"mail": [], "push": []}

    async def _send(db, *, to, subject, text_body, **_):
        box["mail"].append({"to": to, "subject": subject, "body": text_body})

    async def _notify(**kw):
        box["push"].append(kw)

    monkeypatch.setattr(smtp, "send_message", _send)
    monkeypatch.setattr(dispatch, "notify_user", _notify)
    return box


# ------------------------------------------------------------------ AP5


async def test_an_admin_password_reset_is_told_three_ways(db, client, user, outbox):
    member = await _user(db, "bea")

    r = await client.post(
        f"/api/admin/users/{member.id}/reset-password",
        headers=_auth(user), json={"password": "Temp-password-1!"},
    )
    assert r.status_code == 200

    await db.refresh(member)
    assert member.admin_notice_kind == "password_reset" and member.admin_notice_at is not None
    assert [m["to"] for m in outbox["mail"]] == [member.email]
    assert "reset your password" in outbox["mail"][0]["body"]
    assert "Temp-password" not in outbox["mail"][0]["body"]
    assert len(outbox["push"]) == 1
    push = outbox["push"][0]
    assert push["user_id"] == member.id and push["category"] == "system_alert"
    assert push["url"] == "/account/privacy"

    # The banner reaches them (they may only use account endpoints until
    # they choose a new password), and closing it is for every device.
    me = (await client.get("/api/auth/me", headers=_auth(member))).json()
    assert me["admin_notice_kind"] == "password_reset"
    r = await client.post("/api/auth/me/admin-notice/dismiss", headers=_auth(member))
    assert r.status_code == 200 and r.json()["admin_notice_kind"] is None
    await db.refresh(member)
    assert member.admin_notice_at is None


async def test_an_email_change_writes_to_the_old_address_too(db, client, user, outbox):
    member = await _user(db, "cal")
    old = member.email

    r = await client.patch(
        f"/api/admin/users/{member.id}", headers=_auth(user), json={"email": "taken-over@example.com"},
    )
    assert r.status_code == 200

    await db.refresh(member)
    assert member.admin_notice_kind == "email_changed"
    assert sorted(m["to"] for m in outbox["mail"]) == sorted([old, "taken-over@example.com"])
    assert all(old in m["body"] and "taken-over@example.com" in m["body"] for m in outbox["mail"])


async def test_role_and_password_edits_are_told(db, client, user, outbox):
    member = await _user(db, "dee")

    r = await client.patch(f"/api/admin/users/{member.id}", headers=_auth(user), json={"role": "admin"})
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "role_changed"
    assert "now an administrator" in outbox["push"][-1]["body"]

    r = await client.patch(
        f"/api/admin/users/{member.id}", headers=_auth(user), json={"password": "Another-temp-2!"},
    )
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "password_reset"
    assert len(outbox["push"]) == 2


async def test_an_mfa_reset_is_told(db, client, user, outbox):
    member = await _user(db, "eve")

    r = await client.post(f"/api/admin/users/{member.id}/reset-mfa", headers=_auth(user))
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "mfa_reset"
    assert outbox["mail"] and outbox["mail"][0]["to"] == member.email


async def test_an_unrelated_edit_tells_no_one(db, client, user, outbox):
    member = await _user(db, "fay")

    r = await client.patch(
        f"/api/admin/users/{member.id}", headers=_auth(user), json={"can_generate_images": False},
    )
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind is None
    assert outbox == {"mail": [], "push": []}


async def test_an_admin_editing_themselves_gets_no_banner(db, client, user, outbox):
    r = await client.patch(f"/api/admin/users/{user.id}", headers=_auth(user), json={"email": "me-again@example.com"})
    assert r.status_code == 200
    await db.refresh(user)
    assert user.admin_notice_kind is None


async def test_a_failing_mail_server_doesnt_fail_the_reset(db, client, user, monkeypatch):
    from app.mfa import smtp
    from app.notifications import dispatch

    async def _boom(*a, **k):
        raise smtp.SmtpSendError("down")

    async def _notify(**kw):
        return None

    monkeypatch.setattr(smtp, "send_message", _boom)
    monkeypatch.setattr(dispatch, "notify_user", _notify)
    member = await _user(db, "gus")

    r = await client.post(
        f"/api/admin/users/{member.id}/reset-password",
        headers=_auth(user), json={"password": "Temp-password-1!"},
    )
    assert r.status_code == 200
    await db.refresh(member)
    assert member.admin_notice_kind == "password_reset"


async def test_recent_activity_lists_only_your_own_rows(db, client, user, outbox):
    from app.auth.audit import record_event

    member = await _user(db, "hal")
    other = await _user(db, "ida")
    for uid, kind in (
        (member.id, "login_success"),
        (member.id, "token_refresh"),  # noise: not listed
        (member.id, "tool_invoked"),  # not account activity
        (other.id, "login_success"),  # someone else's
    ):
        await record_event(db, event_type=kind, user_id=uid, ip="10.0.0.1", user_agent="Mozilla/5.0 Firefox/130.0")
    await db.commit()
    await client.post(
        f"/api/admin/users/{member.id}/reset-password",
        headers=_auth(user), json={"password": "Temp-password-1!"},
    )
    await db.refresh(member)

    r = await client.get("/api/auth/security-events", headers=_auth(member))
    assert r.status_code == 200
    rows = r.json()
    assert [x["kind"] for x in rows] == ["password_reset_by_admin", "login_success"]
    assert rows[0]["by_admin"] is True and rows[0]["admin_name"] == user.username
    assert rows[1]["by_admin"] is False and rows[1]["ip"] == "10.0.0.1"
    assert "detail" not in rows[0]

    # Paging back from the oldest row shown: nothing older.
    r = await client.get(
        "/api/auth/security-events", headers=_auth(member), params={"before": rows[-1]["at"]},
    )
    assert r.json() == []

    # Signed out: nothing.
    assert (await client.get("/api/auth/security-events")).status_code == 401


async def test_an_admin_can_email_a_reset_link_instead(db, client, user, outbox):
    from app.auth.events import AuthEvent

    member = await _user(db, "jo")
    before_tv = member.token_version

    r = await client.post(f"/api/admin/users/{member.id}/send-reset-link", headers=_auth(user))
    assert r.status_code == 200

    # Nothing changed yet: their sessions and password stand until they use it.
    await db.refresh(member)
    assert member.token_version == before_tv and member.password_hash == "x"
    assert member.must_change_password is False
    assert [m["to"] for m in outbox["mail"]] == [member.email]
    body = outbox["mail"][0]["body"]
    assert "administrator" in body
    token = re.search(r"token=([\w-]+)", body).group(1)

    ev = (
        await db.execute(
            select(AuthEvent).where(AuthEvent.user_id == member.id, AuthEvent.event_type == "password_reset_requested")
        )
    ).scalar_one()
    assert str(user.id) in ev.detail

    r = await client.post("/api/auth/reset-password", json={"token": token, "new_password": "my-own-choice-77!"})
    assert r.status_code == 204
    # The admin's response never carried the link.
    assert token not in r.text


async def test_without_email_the_reset_link_is_refused_kindly(db, client, user):
    member = await _user(db, "kit")
    r = await client.post(f"/api/admin/users/{member.id}/send-reset-link", headers=_auth(user))
    assert r.status_code == 409
    assert "temporary password" in r.json()["detail"]


async def test_only_admins_send_reset_links(db, client):
    a = await _user(db, "lou")
    b = await _user(db, "max")
    r = await client.post(f"/api/admin/users/{b.id}/send-reset-link", headers=_auth(a))
    assert r.status_code == 403


async def test_a_first_sso_link_is_told_without_a_banner(db, outbox):
    from starlette.requests import Request

    from app.auth.events import AuthEvent
    from app.auth.router import _tell_sso_linked

    member = await _user(db, "ned")
    req = Request({"type": "http", "method": "GET", "path": "/", "headers": [], "client": ("10.1.1.1", 1)})
    await _tell_sso_linked(db, req, member, "https://idp.example.org/realms/x")

    await db.refresh(member)
    assert member.admin_notice_kind is None  # they just signed in themselves
    assert outbox["mail"][0]["to"] == member.email
    assert "idp.example.org" in outbox["mail"][0]["body"]
    ev = (
        await db.execute(select(AuthEvent).where(AuthEvent.user_id == member.id, AuthEvent.event_type == "sso_linked"))
    ).scalar_one()
    assert ev.detail == "issuer_host=idp.example.org"


# ------------------------------------------------------------------ AP6


async def _events(db, user_id=None, kind=None):
    from app.auth.events import AuthEvent

    q = select(AuthEvent).order_by(AuthEvent.created_at)
    if user_id is not None:
        q = q.where(AuthEvent.user_id == user_id)
    if kind is not None:
        q = q.where(AuthEvent.event_type == kind)
    return (await db.execute(q)).scalars().all()


def test_masks_and_extensions():
    from app.auth.audit import ext_of, mask_identifier

    assert mask_identifier("hunter2-is-my-password") == "hu… (22)"
    assert mask_identifier("") == ""
    assert ext_of("Biopsy results.PDF") == ".pdf"
    assert ext_of("C:\\Users\\me\\tax 2026.xlsx") == ".xlsx"
    assert ext_of(".bashrc") == "" and ext_of("README") == "" and ext_of(None) == ""
    assert ext_of("x.not an extension") == ""


async def test_workspace_rows_carry_ids_not_titles(db, client, outbox):
    member = await _user(db, "ora")
    r = await client.post("/api/workspaces", headers=_auth(member), json={"title": "Biopsy results"})
    assert r.status_code in (200, 201), r.text
    ws_id = r.json()["id"]
    rows = await _events(db, member.id, "workspace_created")
    assert rows and rows[-1].detail == f"ws={ws_id}"
    assert all("Biopsy" not in (e.detail or "") for e in await _events(db, member.id))


async def test_a_refused_upload_keeps_only_the_extension(db, user):
    from starlette.requests import Request

    from app.files.router import _audit_upload_rejection

    req = Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("1.2.3.4", 1)})
    await _audit_upload_rejection(db, request=req, user=user, code="bad_type", declared_filename="Divorce papers.exe")
    row = (await _events(db, user.id, "file_upload_rejected"))[-1]
    assert "Divorce" not in row.detail and "ext='.exe'" in row.detail


async def test_only_tools_that_change_something_are_audited(db, user):
    from starlette.requests import Request

    from app.chat.router import _audit_tool_event

    req = Request({"type": "http", "method": "POST", "path": "/", "headers": [], "client": ("1.2.3.4", 1)})
    for name in ("search_photos", "mail_read", "timeline_day", "remember", "mcp__github__open_issue"):
        await _audit_tool_event(db, request=req, user=user, event_type="tool_invoked", tool_name=name)
    await _audit_tool_event(db, request=req, user=user, event_type="tool_failed", tool_name="web_search",
                            detail={"error": "timeout"})
    tools = sorted(re.search(r"tool='([^']*)'", e.detail).group(1) for e in await _events(db, user.id))
    assert tools == ["mcp__github__open_issue", "remember"]


def test_every_audited_tool_is_a_real_tool():
    """A renamed or removed tool would quietly stop being audited, and a
    stale name would hide that (code_interpreter went with 0420)."""
    from app.auth.audit import AUDITED_TOOLS
    from app.chat.tools.registry import get_tool

    assert sorted(t for t in AUDITED_TOOLS if get_tool(t) is None) == []


async def test_a_login_for_no_account_is_masked(db, client, user):  # an admin exists: set up
    from app.auth.utils import hash_password

    r = await client.post("/api/auth/login", json={"email": "my-Secret-pass!", "password": "whatever-1"})
    assert r.status_code in (400, 401)
    from app.auth.events import AuthEvent

    row = (
        await db.execute(
            select(AuthEvent).where(AuthEvent.event_type == "login_fail").order_by(AuthEvent.created_at.desc())
        )
    ).scalars().first()
    assert row.user_id is None and row.identifier == "my… (15)"

    # A real account's failures still name it: that's how a spray is spotted.
    real = await _user(db, "pia")
    real.password_hash = hash_password("right-password-1!")
    await db.commit()
    r = await client.post("/api/auth/login", json={"email": real.email, "password": "wrong-password-1!"})
    assert r.status_code in (400, 401)
    rows = await _events(db, real.id, "login_fail")
    assert rows and rows[-1].identifier.lower() == real.email.lower()


async def test_credentials_are_audited_by_id(db, client):
    member = await _user(db, "quin")
    r = await client.post(
        "/api/secrets", headers=_auth(member), json={"name": "BANK_LOGIN", "value": "s3cret", "allowed_hosts": ["example.com"]},
    )
    assert r.status_code in (200, 201), r.text
    rows = await _events(db, member.id, "secret_created")
    assert rows[-1].detail == f"credential id={r.json()['id']}"


async def test_migration_scrubs_stored_audit_rows(db, user, caplog):
    from app.auth.audit import record_event

    ws = uuid.uuid4()
    old = [
        ("workspace_created", f'"Biopsy results" (ws={ws})', user.id, ""),
        ("workspace_item_deleted", f'note "Lump" (+2 nested item(s)) in "Family" (ws={ws})', user.id, ""),
        ("workspace_share_created", f'"Family" (ws={ws}) → bob as editor', user.id, ""),
        ("workspace_exported", f'"Family" (ws={ws}) — 3 notes', user.id, ""),
        ("file_upload_rejected", "code='bad_type', filename='Divorce papers.exe'", user.id, ""),
        ("conversations.imported", "count=3, filename=\"Tom's chats.json\"", user.id, ""),
        ("app_password_created", "device=\"Tristen's phone\"", user.id, ""),
        ("secret_created", "credential BANK_LOGIN", user.id, ""),
        ("tool_invoked", "tool='search_photos'", user.id, ""),
        ("tool_failed", "tool='mail_read', error='timeout'", user.id, ""),
        ("tool_invoked", "tool='remember'", user.id, ""),
        ("tool_invoked", "tool='mcp__gh__x', mcp=True", user.id, ""),
        ("tool_invoked", "tool='unlock', mcp=True, approved_by_user=True, connector='HA', spoken=False", user.id, ""),
        ("login_fail", "unknown_user", None, "my-Secret-pass!"),
        ("login_fail", "bad_password", user.id, user.email),
    ]
    for kind, detail, uid, ident in old:
        await record_event(db, event_type=kind, detail=detail, user_id=uid, identifier=ident)
    await db.commit()

    import logging

    with caplog.at_level(logging.INFO, logger="alembic.runtime.migration"):
        await _run_upgrade("0423_scrub_audit_details")
        await _run_upgrade("0423_scrub_audit_details")  # twice: no change the second time

    from app.auth.events import AuthEvent

    rows = (await db.execute(select(AuthEvent))).scalars().all()
    by = {}
    for e in rows:
        by.setdefault(e.event_type, []).append(e)
    assert by["workspace_created"][0].detail == f"ws={ws}"
    assert by["workspace_item_deleted"][0].detail == f"note (+2 nested item(s)) in ws={ws}"
    assert by["workspace_share_created"][0].detail == f"ws={ws} → bob as editor"
    assert by["workspace_exported"][0].detail == f"ws={ws} — 3 notes"
    assert by["file_upload_rejected"][0].detail == "code='bad_type', ext='.exe'"
    assert by["conversations.imported"][0].detail == "count=3, ext='.json'"
    assert by["app_password_created"][0].detail == "device=[name]"
    assert by["secret_created"][0].detail == "credential [name]"
    tools = sorted(re.search(r"tool='([^']*)'", e.detail).group(1) for e in by["tool_invoked"] + by.get("tool_failed", []))
    assert tools == ["mcp__gh__x", "remember", "unlock"]
    fails = {e.user_id: e.identifier for e in by["login_fail"]}
    assert fails[None] == "my… (15)" and fails[user.id] == user.email
    everything = " ".join((e.detail or "") + e.identifier for e in rows)
    for secret in ("Biopsy", "Lump", "Family", "Divorce", "Tom's", "Tristen", "BANK_LOGIN", "Secret-pass"):
        assert secret not in everything
    assert "0423_scrub_audit_details: 8 details rewritten, 2 tool rows removed, 1 identifiers masked" in caplog.text


def _migration(name: str):
    import importlib.util
    from pathlib import Path

    versions = Path(__file__).resolve().parent.parent / "alembic" / "versions"
    path = next(versions.glob(f"*_{name}.py"))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


async def _run_upgrade(name):
    """Run one migration's ``upgrade()`` again against the test database."""
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    from app.database import engine

    mod = _migration(name)

    def go(sync_conn):
        ctx = MigrationContext.configure(sync_conn)
        with Operations.context(ctx):
            mod.upgrade()

    async with engine.begin() as conn:
        await conn.run_sync(go)


# ------------------------------------------------------------------ AP7


async def _file(db, owner, name="Biopsy results.pdf", state="ready"):
    from app.files.models import UserFile

    f = UserFile(user_id=owner.id, filename=name, original_filename=name, mime_type="application/pdf",
                 size_bytes=10, storage_path=f"x/{uuid.uuid4().hex}", blob_state=state)
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def test_storage_problems_show_kind_and_owner_not_the_name(db, client, user):
    member = await _user(db, "rae")
    f = await _file(db, member, state="damaged")
    r = await client.get("/api/admin/storage/health", headers=_auth(user))
    assert r.status_code == 200
    [row] = [p for p in r.json()["problems"] if p["id"] == str(f.id)]
    assert row["kind"] == ".pdf" and row["owner"] == member.username and "filename" not in row
    assert "Biopsy" not in r.text


async def test_the_storage_alert_counts_for_admins_and_names_for_owners(db, user, outbox):
    from app.files.scrubber import _alert

    a = await _user(db, "sol")
    b = await _user(db, "tia")
    bad = [await _file(db, a, "Biopsy results.pdf"), await _file(db, a, "Will.docx"), await _file(db, b, "Tax.xlsx")]
    await _alert(bad)

    admin = [p for p in outbox["push"] if p["user_id"] == user.id]
    assert admin and "3 files are missing" in admin[0]["body"]
    assert all(n not in admin[0]["body"] for n in ("Biopsy", "Will", "Tax"))
    to_a = [p for p in outbox["push"] if p["user_id"] == a.id]
    assert len(to_a) == 1 and "Biopsy results.pdf" in to_a[0]["body"] and "Will.docx" in to_a[0]["body"]
    assert to_a[0]["title"] == "2 of your files are damaged" and "Tax" not in to_a[0]["body"]
    [to_b] = [p for p in outbox["push"] if p["user_id"] == b.id]
    assert to_b["title"] == "A file of yours is damaged"


async def _connector(db):
    from app.mcp.models import McpConnector

    c = McpConnector(name=f"Alarm {uuid.uuid4().hex[:4]}", slug=f"alarm{uuid.uuid4().hex[:6]}", kind="mcp",
                     url="http://192.168.1.20/mcp", availability="restricted", enabled=True)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return c


async def test_the_connector_picker_lists_only_the_admins_workspaces(db, client, user):
    from app.chat.models import Workspace, WorkspaceShare
    from app.mcp.models import WorkspaceMcpConnector

    stranger = await _user(db, "uma")
    friend = await _user(db, "vic")
    mine = Workspace(user_id=user.id, title="Admin's own")
    theirs = Workspace(user_id=stranger.id, title="Uma's diary")
    shared = Workspace(user_id=friend.id, title="Family")
    db.add_all([mine, theirs, shared])
    await db.flush()
    db.add(WorkspaceShare(workspace_id=shared.id, inviter_user_id=friend.id, invitee_user_id=user.id,
                          status="accepted", role="editor"))
    c = await _connector(db)
    # The stranger turned it on in their own workspace themselves.
    db.add(WorkspaceMcpConnector(workspace_id=theirs.id, connector_id=c.id))
    await db.commit()

    r = await client.get("/api/admin/mcp/workspaces", headers=_auth(user))
    assert r.status_code == 200
    assert sorted(w["title"] for w in r.json()) == ["Admin's own", "Family"]
    assert "diary" not in r.text

    # Attaching to someone else's workspace is ignored; theirs is left alone.
    r = await client.patch(
        f"/api/admin/mcp/connectors/{c.id}", headers=_auth(user),
        json={"workspace_ids": [str(mine.id), str(theirs.id)]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["workspace_ids"] == [str(mine.id)] and body["other_workspace_count"] == 1
    rows = (await db.execute(select(WorkspaceMcpConnector).where(WorkspaceMcpConnector.connector_id == c.id))).scalars().all()
    assert {(x.workspace_id, x.attached_by_admin) for x in rows} == {(mine.id, True), (theirs.id, False)}

    # Clearing the admin's list doesn't take it away from the stranger.
    r = await client.patch(f"/api/admin/mcp/connectors/{c.id}", headers=_auth(user), json={"workspace_ids": []})
    assert r.json()["workspace_ids"] == [] and r.json()["other_workspace_count"] == 1


async def test_admin_forms_lists_reported_forms_and_counts_the_rest(db, client, user):
    from app.files.models import UserFile
    from app.forms.models import Form, FormReport

    owner = await _user(db, "wes")
    forms = []
    for title in ("Secret santa", "Spam form"):
        shell = UserFile(user_id=owner.id, filename=f"{title}.form", original_filename=f"{title}.form",
                         mime_type="application/x-promptly-form", size_bytes=0, storage_path=f"x/{uuid.uuid4().hex}")
        db.add(shell)
        await db.flush()
        f = Form(file_id=shell.id, definition={"title": title, "questions": []}, audience="link", accepting=True)
        db.add(f)
        await db.flush()
        forms.append(f)
    db.add(FormReport(form_id=forms[1].id, reason="phishing"))
    await db.commit()

    body = (await client.get("/api/admin/forms", headers=_auth(user))).json()
    assert [x["title"] for x in body["forms"]] == ["Spam form"]
    assert body["link_form_count"] == 2
    assert "Secret santa" not in str(body)
