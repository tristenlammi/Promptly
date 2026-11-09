"""Admin privacy fixes (docs/admin-privacy-audit.md).

The owner's rule: a server admin can never see another user's data, except
where that's obviously intended (the social side). These tests pin the
leaks that were closed:

* AP3 (L1): a custom model only takes files the caller may read, and the
  0403 migration detaches other people's files already attached.
* AP1 (L3-L7, G1): logs and stored errors carry route templates, never raw
  paths, and routine lines carry no user id; 0402 rewrites stored paths.

(AP4, deleting a user, is in test_user_deletion.py.)
"""
from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select, text

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


async def _file(db, owner, name="doc.txt", text_="alpha"):
    from app.files.models import UserFile

    uf = UserFile(user_id=owner.id, filename=name, original_filename=name, mime_type="text/plain",
                  size_bytes=len(text_), storage_path=f"x/{uuid.uuid4().hex}", content_text=text_)
    db.add(uf)
    await db.commit()
    await db.refresh(uf)
    return uf


# ------------------------------------------------------------------ AP3 / L1


@pytest.fixture
async def model(db, user, provider, monkeypatch):
    """A custom model the admin ``user`` made; indexing is stubbed out."""
    from app.custom_models import router as cm_router
    from app.custom_models.models import CustomModel

    async def no_index(*a, **k):
        return None

    monkeypatch.setattr(cm_router, "index_file_for_custom_model", no_index)
    cm = CustomModel(name=f"kb-{uuid.uuid4().hex[:6]}", display_name="KB", base_provider_id=provider.id,
                     base_model_id="test-model", top_k=4, created_by=user.id)
    db.add(cm)
    await db.commit()
    await db.refresh(cm)
    return cm


async def _attached(db, cm_id):
    from app.custom_models.models import CustomModelFile

    return set(
        (await db.execute(select(CustomModelFile.user_file_id).where(CustomModelFile.custom_model_id == cm_id)))
        .scalars()
        .all()
    )


@pytest.mark.asyncio
async def test_admin_cant_attach_someone_elses_file(db, client, user, model):
    other = await _user(db, "other")
    theirs = await _file(db, other, "diary.txt")
    mine = await _file(db, user, "handbook.txt")

    r = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(theirs.id)]}, headers=_auth(user))
    assert r.status_code == 404
    assert "diary" not in r.text
    # Mixed with one of their own: still refused, nothing attached.
    r = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(mine.id), str(theirs.id)]}, headers=_auth(user))
    assert r.status_code == 404
    assert await _attached(db, model.id) == set()

    r = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(mine.id)]}, headers=_auth(user))
    assert r.status_code == 201
    assert await _attached(db, model.id) == {mine.id}


@pytest.mark.asyncio
async def test_a_missing_file_and_a_foreign_one_look_the_same(db, client, user, model):
    other = await _user(db, "other")
    theirs = await _file(db, other)
    a = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(theirs.id)]}, headers=_auth(user))
    b = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(uuid.uuid4())]}, headers=_auth(user))
    assert (a.status_code, a.json()) == (b.status_code, b.json())


@pytest.mark.asyncio
async def test_creating_a_model_with_a_foreign_file_is_refused(db, client, user, provider, model):
    from app.custom_models.models import CustomModel

    other = await _user(db, "other")
    theirs = await _file(db, other)
    r = await client.post("/api/admin/custom-models", headers=_auth(user), json={
        "name": "sneaky", "display_name": "Sneaky", "base_provider_id": str(provider.id),
        "base_model_id": "test-model", "file_ids": [str(theirs.id)],
    })
    assert r.status_code == 404
    assert (await db.execute(select(CustomModel).where(CustomModel.name == "sneaky"))).scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_a_file_shared_with_the_admin_can_be_attached(db, client, user, model):
    """The normal read rule: shared with you means you may read it."""
    from app.files.models import ResourceGrant

    other = await _user(db, "other")
    shared = await _file(db, other, "policy.txt")
    db.add(ResourceGrant(resource_type="file", resource_id=shared.id, grantee_user_id=user.id,
                         granted_by_user_id=other.id))
    await db.commit()

    r = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(shared.id)]}, headers=_auth(user))
    assert r.status_code == 201, r.text
    assert await _attached(db, model.id) == {shared.id}


@pytest.mark.asyncio
async def test_only_admins_reach_custom_models(db, client, model):
    member = await _user(db, "member")
    mine = await _file(db, member)
    r = await client.post(f"/api/admin/custom-models/{model.id}/files",
                          json={"file_ids": [str(mine.id)]}, headers=_auth(member))
    assert r.status_code == 403
    r = await client.get("/api/admin/custom-models", headers=_auth(member))
    assert r.status_code == 403


async def _chunk(db, cm_id, file_id):
    from app.custom_models.embedding import Chunk
    from app.custom_models.ingestion import insert_chunks

    vec = [0.0] * 768
    vec[0] = 1.0
    await insert_chunks(
        db, scope_kind="custom_model", scope_id=cm_id, user_file_id=file_id,
        chunks=[Chunk(index=0, text="secret words", tokens=2, metadata={})], embeddings=[vec],
        embedding_model="m", embedding_dim=768,
    )
    await db.commit()


async def _chunk_count(db, cm_id, file_id):
    return await db.scalar(text(
        "SELECT count(*) FROM knowledge_chunks WHERE custom_model_id = :c AND user_file_id = :f"
    ), {"c": str(cm_id), "f": str(file_id)})


@pytest.mark.asyncio
async def test_detaching_a_file_drops_its_chunks(db, client, user, model):
    """Retrieval reads chunks by model, so a detached file used to stay
    searchable through it."""
    from app.custom_models.models import CustomModelFile

    mine = await _file(db, user)
    db.add(CustomModelFile(custom_model_id=model.id, user_file_id=mine.id, indexing_status="ready"))
    await db.commit()
    await _chunk(db, model.id, mine.id)
    assert await _chunk_count(db, model.id, mine.id) == 1

    r = await client.delete(f"/api/admin/custom-models/{model.id}/files/{mine.id}", headers=_auth(user))
    assert r.status_code == 204
    assert await _chunk_count(db, model.id, mine.id) == 0


def _migration(name: str):
    versions = Path(__file__).resolve().parent.parent / "alembic" / "versions"
    path = next(versions.glob(f"*_{name}.py"))
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


async def _run_upgrade(db, name):
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


@pytest.mark.asyncio
async def test_migration_detaches_foreign_files_and_their_chunks(db, user, model, caplog):
    from app.custom_models.models import CustomModelFile
    from app.files.models import ResourceGrant

    other = await _user(db, "other")
    mine = await _file(db, user, "mine.txt")
    shared = await _file(db, other, "shared.txt")
    theirs = await _file(db, other, "Biopsy results.txt")
    db.add(ResourceGrant(resource_type="file", resource_id=shared.id, grantee_user_id=user.id,
                         granted_by_user_id=other.id))
    for f in (mine, shared, theirs):
        db.add(CustomModelFile(custom_model_id=model.id, user_file_id=f.id, indexing_status="ready"))
    await db.commit()
    for f in (mine, shared, theirs):
        await _chunk(db, model.id, f.id)

    cm_id, mine_id, shared_id, theirs_id = model.id, mine.id, shared.id, theirs.id
    caplog.set_level("INFO", logger="alembic.runtime.migration")
    await _run_upgrade(db, "0403_cm_foreign_files")

    db.expire_all()
    assert await _attached(db, cm_id) == {mine_id, shared_id}
    assert await _chunk_count(db, cm_id, theirs_id) == 0
    assert await _chunk_count(db, cm_id, mine_id) == 1
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "detached 1 file" in logged
    assert "Biopsy" not in logged and str(theirs_id) not in logged
    assert await db.scalar(select(func.count()).select_from(CustomModelFile)) == 2


# ------------------------------------------------------------- AP1 / L3-L7, G1


@pytest.fixture
def log_lines():
    """Every log line written during the test, as the live tail sees it."""
    import logging

    from app.logging_setup import JsonFormatter

    lines: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            lines.append(self.format(record))

    h = Collect(level=logging.INFO)
    h.setFormatter(JsonFormatter())
    root = logging.getLogger()
    old = root.level
    root.setLevel(logging.INFO)
    root.addHandler(h)
    try:
        yield lines
    finally:
        root.removeHandler(h)
        root.setLevel(old)


def _access(lines, needle):
    import json

    out = [json.loads(line) for line in lines if '"promptly.access"' in line]
    return [r for r in out if needle in r["message"]]


SECRET = "Zq9-SecretToken_abcdefghijklmnop"


@pytest.mark.asyncio
async def test_access_lines_carry_templates_and_no_user_id(db, client, user, log_lines):
    h = _auth(user)
    await client.get(f"/api/calendar/feed/{SECRET}.ics")
    await client.get(f"/api/m/{SECRET}")
    await client.request("PROPFIND", "/dav/Medical%20Records/biopsy.pdf")
    await client.get(f"/api/s/{SECRET}")
    await client.get(f"/api/nothing-here/{SECRET}/x")
    # Phone pairing: the page now asks with a POST, the code in the body;
    # an old page's GET still works and is logged as its template.
    start = (await client.post("/api/devices/pair", headers=h, json={"origin": "https://p.example.org"})).json()
    code = start["code"]
    assert (await client.post("/api/devices/pair/status", headers=h, json={"code": code})).json() == {"state": "waiting"}
    assert (await client.get(f"/api/devices/pair/{code}", headers=h)).json() == {"state": "waiting"}

    blob = "\n".join(log_lines)
    for secret in (SECRET, code, "biopsy", "Medical"):
        assert secret not in blob
    assert _access(log_lines, "GET /api/calendar/feed/{token}.ics")
    assert _access(log_lines, "GET /api/m/{token}")
    assert _access(log_lines, "PROPFIND /dav/{path}")
    assert _access(log_lines, "GET /api/nothing-here/…")
    assert _access(log_lines, "POST /api/devices/pair/status")
    assert _access(log_lines, "GET /api/devices/pair/{code}")
    # Routine lines carry no user id; the route field is the template too.
    signed_in = _access(log_lines, "/api/devices/pair")
    assert signed_in and all("user_id" not in r for r in signed_in)
    assert str(user.id) not in blob


@pytest.mark.asyncio
async def test_a_failing_request_stores_its_template_and_keeps_the_user(db, user, log_lines):
    """Errors keep the user id (support needs it) but never the raw path."""
    import asyncio

    from app.main import app
    from app.observability.models import ErrorEvent
    from app.background import pending_count

    from fastapi import Depends

    from app.auth.deps import get_current_user

    async def boom(token: str, who: User = Depends(get_current_user)):
        raise RuntimeError("kaboom")

    app.add_api_route("/api/test-privacy-boom/{token}", boom, methods=["GET"])
    route = app.router.routes[-1]
    try:
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            r = await c.get(f"/api/test-privacy-boom/{SECRET}", headers=_auth(user))
        assert r.status_code == 500
        for _ in range(50):
            if pending_count() == 0 and await db.scalar(select(func.count()).select_from(ErrorEvent)):
                break
            await asyncio.sleep(0.05)
    finally:
        app.router.routes.remove(route)

    rows = (await db.execute(select(ErrorEvent))).scalars().all()
    assert rows
    for row in rows:
        assert SECRET not in (row.route or "") + row.message + (row.stack or "")
    assert any(row.route == "GET /api/test-privacy-boom/{token}" for row in rows)
    assert any(row.user_id == user.id for row in rows)
    assert SECRET not in "\n".join(log_lines)


@pytest.mark.asyncio
async def test_a_rate_limited_request_is_audited_by_template(db):
    from starlette.requests import Request

    from app.auth.audit import EVENT_RATE_LIMITED
    from app.auth.events import AuthEvent
    from app.main import app
    from app.rate_limit import _record_rate_limit_audit

    media = next(r for r in app.routes if getattr(r, "path", "") == "/api/m/{token}")
    req = Request({"type": "http", "method": "GET", "path": f"/api/m/{SECRET}", "headers": [],
                   "client": ("1.2.3.4", 1), "route": media})
    await _record_rate_limit_audit(req, bucket="media")
    stray = Request({"type": "http", "method": "GET", "path": f"/api/nope/{SECRET}", "headers": [],
                     "client": ("1.2.3.4", 1)})
    await _record_rate_limit_audit(stray, bucket="default")

    details = sorted(
        (await db.execute(select(AuthEvent.detail).where(AuthEvent.event_type == EVENT_RATE_LIMITED))).scalars()
    )
    assert details == ["path=/api/m/{token} bucket=media", "path=/api/nope/… bucket=default"]


@pytest.mark.asyncio
async def test_migration_rewrites_stored_paths_to_templates(db, user, caplog):
    from app.auth.events import AuthEvent
    from app.observability.models import ErrorEvent

    def err(route):
        return ErrorEvent(fingerprint="f", level="ERROR", logger="promptly.x", message="m", route=route)

    db.add_all([
        err(f"GET /api/calendar/feed/{SECRET}.ics"),
        err("PROPFIND /dav/Medical Records/biopsy.pdf"),
        err(f"GET /api/devices/pair/{SECRET}"),
        err(f"POST /api/hooks/{uuid.uuid4()}/[secret]"),
        err("GET /api/m/{token}"),
        err(f"GET /api/gone-in-0-34/{SECRET}"),
        err(None),
        AuthEvent(event_type="rate_limited", detail=f"path=/api/m/{SECRET} bucket=media"),
        AuthEvent(event_type="rate_limited", detail="path=/dav/My Taxes/2025.pdf bucket=dav"),
        AuthEvent(event_type="rate_limited", detail=f"path=/api/gone-in-0-34/{SECRET} bucket=default"),
        AuthEvent(event_type="login_fail", detail="path=/api/auth/login stays"),
    ])
    await db.commit()

    caplog.set_level("INFO", logger="alembic.runtime.migration")
    await _run_upgrade(db, "0402_scrub_error_routes")
    await _run_upgrade(db, "0402_scrub_error_routes")  # idempotent

    db.expire_all()
    routes = sorted((r or "") for r in (await db.execute(select(ErrorEvent.route))).scalars())
    assert routes == sorted([
        "",
        "GET /api/calendar/feed/{token}.ics",
        "GET /api/devices/pair/{code}",
        "GET /api/m/{token}",
        "POST /api/hooks/{task_id}/{secret}",
        "PROPFIND /dav/{path}",
    ])
    details = sorted((await db.execute(select(AuthEvent.detail))).scalars())
    assert details == sorted([
        "path=/api/m/{token} bucket=media",
        "path=/dav/{path} bucket=dav",
        "path=[removed] bucket=default",
        "path=/api/auth/login stays",
    ])
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "4 error route(s) rewritten, 1 deleted, 3 audit detail(s) rewritten" in logged
    assert SECRET not in logged
