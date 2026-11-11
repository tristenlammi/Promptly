"""Guardrails for admin privacy (docs/admin-privacy-audit.md, AP10).

The owner's rule: a server admin can never see another user's data, except
where that's obviously intended (the social side). Three checks keep it
true as the app grows:

* every admin route is listed below with what it shows, so a new one fails
  here until someone decides it shows counts, account details or config,
  never content;
* no log line passes what someone typed or said (in test_admin_privacy.py);
* an IDOR sweep: the endpoints that take ids an admin could have seen
  (in logs, errors, Storage) check the owner, so seeing an id isn't access.
"""
from __future__ import annotations

import re
import uuid

import httpx
import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute

# What each admin route shows or does. Every one of these was read and
# classified in AP10; a new admin route must be added here, with the class
# that's true of it, after checking it shows no one's content:
#
# account  — accounts, roles, sign-in and security state, quotas (audit O1-O6)
# config   — server settings the admin owns (models, connectors, email...)
# counts   — totals and usage numbers, no content (O7, O9, O19-O26)
# health   — server health, errors and logs without content (AP1/AP2 scrub them)
# moderate — acts on reported or public things without reading private ones
# own      — the admin's own things (their custom models, their workspaces)
# inbox    — what someone wrote to the admins on purpose (Send feedback): the
#            words and who wrote them, never where they were in the app
ADMIN_ROUTES: dict[str, str] = {
    # --- users and accounts
    "GET /api/admin/users": "account",
    "POST /api/admin/users": "account",
    "GET /api/admin/users/export": "account",
    "POST /api/admin/users/import": "account",
    "GET /api/admin/users/import/{job_id}": "account",
    "GET /api/admin/users/locked": "account",
    "PATCH /api/admin/users/{user_id}": "account",  # email/role/password edits tell the person (AP5)
    "DELETE /api/admin/users/{user_id}": "account",  # private workspaces go with the account (AP4)
    "GET /api/admin/users/{user_id}/deletion-preview": "account",  # counts private workspaces (AP4)
    "POST /api/admin/users/{user_id}/disable": "account",
    "POST /api/admin/users/{user_id}/enable": "account",
    "POST /api/admin/users/{user_id}/logout-everywhere": "account",
    "POST /api/admin/users/{user_id}/reset-mfa": "account",  # tells the person (AP5)
    "POST /api/admin/users/{user_id}/reset-password": "account",  # tells the person (AP5)
    "POST /api/admin/users/{user_id}/send-reset-link": "account",
    # Emails a new member their own sign-in details; reads nothing of theirs.
    "POST /api/admin/users/{user_id}/welcome-email": "account",
    "POST /api/admin/users/{user_id}/unlock": "account",
    "GET /api/admin/users/{user_id}/usage": "counts",
    "GET /api/admin/auth-events": "account",  # ids, not titles (AP6)
    "GET /api/admin/auth-events.csv": "account",
    "GET /api/admin/groups": "account",
    "POST /api/admin/groups": "account",
    "PATCH /api/admin/groups/{group_id}": "account",
    "DELETE /api/admin/groups/{group_id}": "account",
    "PUT /api/admin/groups/{group_id}/members": "account",
    # --- usage and analytics
    "GET /api/admin/analytics/by-model": "counts",
    "GET /api/admin/analytics/summary": "counts",
    "GET /api/admin/analytics/timeseries": "counts",
    "GET /api/admin/analytics/users": "counts",
    "GET /api/admin/analytics/users/{user_id}/timeseries": "counts",
    "GET /api/admin/model-pool": "config",
    # --- server health
    "GET /api/admin/metrics": "health",
    "GET /api/admin/logs/stream": "health",
    "GET /api/admin/errors/groups": "health",
    "GET /api/admin/errors/groups/{fingerprint}/events": "health",
    "GET /api/admin/errors/{event_id}": "health",
    "POST /api/admin/errors/groups/{fingerprint}/reopen": "health",
    "POST /api/admin/errors/groups/{fingerprint}/resolve": "health",
    "GET /api/admin/storage/health": "health",  # problem files by kind and owner, no names (AP7)
    "POST /api/admin/storage/check": "health",
    "POST /api/admin/storage/files/{file_id}/recheck": "health",
    "POST /api/admin/storage/media/retry": "health",
    "POST /api/admin/storage/quarantine/empty": "health",
    "POST /api/admin/storage/understanding/retry": "health",
    "GET /api/admin/backups": "health",
    "POST /api/admin/backups/run": "health",
    "PUT /api/admin/backups/offsite": "config",
    "POST /api/admin/backups/offsite/test": "config",
    "POST /api/admin/backups/offsite/{action}": "config",
    "GET /api/maps/data-status": "health",
    "POST /api/maps/traffic/test": "config",
    "GET /api/calls/check": "health",
    "GET /api/calls/usage": "counts",
    "GET /api/admin/talk/usage": "counts",
    # --- server settings
    "GET /api/admin/app-settings": "config",
    "PATCH /api/admin/app-settings": "config",
    "GET /api/admin/app-settings/email-autoconfig": "config",
    "POST /api/admin/app-settings/preview-origin": "config",
    "POST /api/admin/app-settings/test-email": "config",
    "GET /api/admin/local-models/hardware": "config",
    "GET /api/admin/local-models/installed": "config",
    "DELETE /api/admin/local-models/installed/{name:path}": "config",
    "POST /api/admin/local-models/pull": "config",
    "POST /api/admin/local-models/refresh-provider": "config",
    "GET /api/admin/mcp/connectors": "config",  # other people's workspaces counted only (AP7)
    "POST /api/admin/mcp/connectors": "config",
    "PATCH /api/admin/mcp/connectors/{connector_id}": "config",
    "DELETE /api/admin/mcp/connectors/{connector_id}": "config",
    "POST /api/admin/mcp/connectors/{connector_id}/refresh": "config",
    "POST /api/admin/mcp/test": "config",
    "GET /api/admin/mcp/workspaces": "own",  # only workspaces the admin is in (AP7)
    "GET /api/admin/talk": "config",
    "PATCH /api/admin/talk": "config",
    "GET /api/calls/admin/settings": "config",
    "PATCH /api/calls/admin/settings": "config",
    "GET /api/mail/admin/ai-search": "config",
    "PUT /api/mail/admin/ai-search": "config",
    "GET /api/notes/admin/transcription": "config",
    "PUT /api/notes/admin/transcription": "config",
    "GET /api/passwords/admin/breach-watch": "config",
    "PUT /api/passwords/admin/breach-watch": "config",
    "GET /api/passwords/admin/policy": "config",
    "PATCH /api/passwords/admin/policy": "config",
    "PUT /api/items/store/admin": "config",
    "GET /api/admin/porch": "config",
    "PATCH /api/admin/porch": "config",
    "PATCH /api/admin/forms/settings": "config",
    # --- the admin's own knowledge bases (own files only, AP3)
    "GET /api/admin/custom-models": "own",
    "GET /api/admin/custom-models/": "own",
    "POST /api/admin/custom-models": "own",
    "POST /api/admin/custom-models/": "own",
    "GET /api/admin/custom-models/{custom_model_id:uuid}": "own",
    "PATCH /api/admin/custom-models/{custom_model_id:uuid}": "own",
    "DELETE /api/admin/custom-models/{custom_model_id:uuid}": "own",
    "POST /api/admin/custom-models/{custom_model_id:uuid}/files": "own",
    "DELETE /api/admin/custom-models/{custom_model_id:uuid}/files/{user_file_id:uuid}": "own",
    "POST /api/admin/custom-models/{custom_model_id:uuid}/files/{user_file_id:uuid}/reindex": "own",
    "GET /api/admin/custom-models/embedding-config": "config",
    "PUT /api/admin/custom-models/embedding-config": "config",
    "POST /api/admin/custom-models/embedding-config/test": "config",
    "GET /api/admin/custom-models/embedding-models/known": "config",
    "GET /api/admin/custom-models/local-embedding-status": "config",
    "POST /api/admin/custom-models/bootstrap-local-embedding": "config",
    # --- moderation: reported or public things only
    "GET /api/admin/forms": "moderate",  # reported forms + a total (owner decision)
    "GET /api/admin/forms/{form_id:uuid}/reports": "moderate",
    "POST /api/admin/forms/{form_id:uuid}/close": "moderate",
    "GET /api/admin/porch/reports": "moderate",  # Everyone only: the admin is a member (G12)
    "POST /api/admin/porch/reports/{report_id}": "moderate",
    "POST /api/admin/porch/posts/{post_id}/remove-from-everyone": "moderate",
    # --- feedback people sent to the admins
    "GET /api/admin/feedback": "inbox",
    "POST /api/admin/feedback/{feedback_id}/read": "inbox",
    "DELETE /api/admin/feedback/{feedback_id}": "inbox",
}

CLASSES = {"account", "config", "counts", "health", "moderate", "own", "inbox"}


def _uses(dep, target) -> bool:
    return dep.call is target or any(_uses(d, target) for d in dep.dependencies)


def _admin_routes() -> set[str]:
    """Every route gated by ``require_admin``, or under an ``/admin`` path
    (some check the role inline)."""
    from app.auth.deps import require_admin
    from app.main import app

    out: set[str] = set()
    for r in app.routes:
        if not isinstance(r, APIRoute):
            continue
        if _uses(r.dependant, require_admin) or re.search(r"/admin(/|$)", r.path):
            out |= {f"{m} {r.path}" for m in r.methods - {"HEAD"}}
    return out


def test_every_admin_route_is_classified():
    live = _admin_routes()
    new = sorted(live - set(ADMIN_ROUTES))
    assert not new, (
        "New admin routes: check each shows no one's content (counts, account details or "
        "config only), then add it to ADMIN_ROUTES with its class:\n  " + "\n  ".join(new)
    )
    gone = sorted(set(ADMIN_ROUTES) - live)
    assert not gone, "Admin routes listed here no longer exist; remove them:\n  " + "\n  ".join(gone)
    assert set(ADMIN_ROUTES.values()) <= CLASSES


async def test_admin_paths_refuse_people_who_arent_admins(db):
    """Every route under /admin answers a member with 403 (or 404/405 for a
    made-up id), never data: spot-check the GETs without path params."""
    from app import rate_limit
    from app.auth.models import User
    from app.auth.utils import create_access_token
    from app.main import app

    member = User(email=f"m-{uuid.uuid4().hex[:8]}@example.com", username=f"m{uuid.uuid4().hex[:6]}",
                  password_hash="x", role="user")
    db.add(member)
    await db.commit()
    await db.refresh(member)
    h = {"Authorization": f"Bearer {create_access_token(member.id, token_version=member.token_version)}"}
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            for route in sorted(ADMIN_ROUTES):
                method, path = route.split(" ", 1)
                if method != "GET" or "{" in path or path.endswith("/stream"):
                    continue
                r = await c.get(path, headers=h)
                assert r.status_code == 403, (route, r.status_code)
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


# ------------------------------------------------------------------ IDOR sweep
# File and item ids reach admins through Storage and stored errors. Seeing an
# id must not be access: each place that takes one checks the caller.


async def _person(db, name):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:8]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _their_file(db, owner):
    from app.files.models import UserFile

    f = UserFile(user_id=owner.id, filename="private.txt", original_filename="private.txt",
                 mime_type="text/plain", size_bytes=5, storage_path=f"x/{uuid.uuid4().hex}", content_text="hello")
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def test_a_chat_cant_attach_someone_elses_file(db, user):
    from app.files.router import resolve_attachments

    other = await _person(db, "ann")
    f = await _their_file(db, other)
    with pytest.raises(HTTPException) as e:
        await resolve_attachments(db, [f.id], user)  # ``user`` is an admin
    assert e.value.status_code == 400


async def test_old_messages_dont_load_someone_elses_file(db, user):
    from types import SimpleNamespace

    from app.chat.router import _load_message_attachments

    other = await _person(db, "bob")
    f = await _their_file(db, other)
    msg = SimpleNamespace(id=uuid.uuid4(), attachments=[{"id": str(f.id)}])
    assert await _load_message_attachments(db, [msg], user) == {}


async def test_tags_only_resolve_files_you_can_read(db, user):
    from app.tags.service import readable_file_ids

    other = await _person(db, "cy")
    theirs = await _their_file(db, other)
    mine = await _their_file(db, user)
    assert await readable_file_ids(db, user, {theirs.id, mine.id}) == {mine.id}


async def test_file_endpoints_hide_someone_elses_file(db, user):
    from app import rate_limit
    from app.auth.utils import create_access_token
    from app.main import app

    other = await _person(db, "di")
    f = await _their_file(db, other)
    h = {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            for path in (f"/api/files/{f.id}", f"/api/files/{f.id}/download", f"/api/files/{f.id}/preview"):
                r = await c.get(path, headers=h)
                assert r.status_code in (403, 404), (path, r.status_code)
                assert "hello" not in r.text and "private.txt" not in r.text
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True
