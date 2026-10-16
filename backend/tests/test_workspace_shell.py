"""Workspaces shell (WP-2.4): trash + transfer, membership, settings
conflicts, counts, Ask, retrieval, My Work, live updates, export/import,
templates and duplicate (R-177…R-189, R-203, R-204)."""
from __future__ import annotations

import asyncio
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

import httpx
import pytest


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {
        "Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"
    }


async def _user(db, name, role="user"):
    from app.auth.models import User

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


async def _workspace(client, owner, title="Team"):
    r = await client.post("/api/workspaces", json={"title": title}, headers=_auth(owner))
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


async def _add_member(db, ws_id, owner, member, role="editor"):
    from app.chat.models import WorkspaceShare

    share = WorkspaceShare(
        workspace_id=uuid.UUID(ws_id),
        inviter_user_id=owner.id,
        invitee_user_id=member.id,
        status="accepted",
        role=role,
        accepted_at=datetime.now(timezone.utc),
    )
    db.add(share)
    await db.commit()
    return share


async def _item(client, owner, ws_id, kind, title, parent_id=None):
    body = {"kind": kind, "title": title}
    if parent_id:
        body["parent_id"] = parent_id
    r = await client.post(f"/api/workspaces/{ws_id}/items", json=body, headers=_auth(owner))
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- R-177


@pytest.mark.asyncio
async def test_deleting_a_workspace_trashes_it_and_restore_brings_it_back(client, db, user):
    member = await _user(db, "mem")
    ws_id = await _workspace(client, user)
    await _add_member(db, ws_id, user, member)
    await _item(client, user, ws_id, "board", "Plans")

    r = await client.delete(f"/api/workspaces/{ws_id}", headers=_auth(user))
    assert r.status_code == 204
    # Gone for everyone — the member and the owner's own lists.
    assert (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(member))).status_code == 404
    assert (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(user))).status_code == 404
    assert ws_id not in [w["id"] for w in (await client.get("/api/workspaces", headers=_auth(member))).json()]
    trash = (await client.get("/api/workspaces", params={"trashed": True}, headers=_auth(user))).json()
    assert [w["id"] for w in trash] == [ws_id]
    # A member can't see the owner's trash.
    assert (await client.get("/api/workspaces", params={"trashed": True}, headers=_auth(member))).json() == []

    r = await client.post(f"/api/workspaces/{ws_id}/restore", headers=_auth(user))
    assert r.status_code == 200
    detail = (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(member))).json()
    assert detail["item_counts"].get("board") == 1


@pytest.mark.asyncio
async def test_permanent_delete_needs_the_trash_first_and_the_sweep_purges(client, db, user):
    from app.chat.models import Workspace
    from app.workspaces.router import purge_trashed_workspaces

    ws_id = await _workspace(client, user)
    r = await client.delete(f"/api/workspaces/{ws_id}", params={"permanent": True}, headers=_auth(user))
    assert r.status_code == 400
    await client.delete(f"/api/workspaces/{ws_id}", headers=_auth(user))

    # Not yet due…
    assert await purge_trashed_workspaces(db) == 0
    ws = await db.get(Workspace, uuid.UUID(ws_id))
    ws.trashed_at = datetime.now(timezone.utc) - timedelta(days=31)
    await db.commit()
    assert await purge_trashed_workspaces(db) == 1
    await db.commit()
    db.expire_all()
    assert await db.get(Workspace, uuid.UUID(ws_id)) is None


@pytest.mark.asyncio
async def test_ownership_transfers_to_an_admin_who_then_owns_it(client, db, user):
    editor = await _user(db, "ed")
    admin = await _user(db, "adm")
    ws_id = await _workspace(client, user)
    await _add_member(db, ws_id, user, editor, "editor")
    await _add_member(db, ws_id, user, admin, "admin")

    r = await client.post(f"/api/workspaces/{ws_id}/transfer", json={"user_id": str(editor.id)}, headers=_auth(user))
    assert r.status_code == 400  # only to an admin
    r = await client.post(f"/api/workspaces/{ws_id}/transfer", json={"user_id": str(admin.id)}, headers=_auth(user))
    assert r.status_code == 200, r.text

    detail = (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(admin))).json()
    assert detail["access_role"] == "owner"
    mine = (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(user))).json()
    assert mine["access_role"] == "admin"  # stayed on as an admin
    # Only the new owner can delete it now.
    assert (await client.delete(f"/api/workspaces/{ws_id}", headers=_auth(user))).status_code == 404


# ---------------------------------------------------------------- R-180


@pytest.mark.asyncio
async def test_a_role_changes_in_place_and_members_see_roles_and_their_share(client, db, user):
    member = await _user(db, "mem")
    ws_id = await _workspace(client, user)
    share = await _add_member(db, ws_id, user, member, "viewer")

    r = await client.patch(
        f"/api/workspaces/{ws_id}/shares/{share.id}", json={"role": "editor"}, headers=_auth(user)
    )
    assert r.status_code == 200 and r.json()["role"] == "editor"
    assert r.json()["status"] == "accepted"  # not reset to pending

    detail = (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(member))).json()
    assert detail["my_share_id"] == str(share.id)
    assert [c["role"] for c in detail["collaborators"]] == ["editor"]
    # A non-admin can't change roles.
    r = await client.patch(
        f"/api/workspaces/{ws_id}/shares/{share.id}", json={"role": "admin"}, headers=_auth(member)
    )
    assert r.status_code == 403


# ---------------------------------------------------------------- R-179


@pytest.mark.asyncio
async def test_instructions_save_refuses_to_overwrite_someone_elses_edit(client, db, user):
    ws_id = await _workspace(client, user)
    h = _auth(user)
    r = await client.patch(f"/api/workspaces/{ws_id}", json={"system_prompt": "A"}, headers=h)
    assert r.status_code == 200
    # Another admin started from "" and saves — stale base.
    r = await client.patch(
        f"/api/workspaces/{ws_id}",
        json={"system_prompt": "B", "expected_system_prompt": ""},
        headers=h,
    )
    assert r.status_code == 409
    r = await client.patch(
        f"/api/workspaces/{ws_id}",
        json={"system_prompt": "B", "expected_system_prompt": "A"},
        headers=h,
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_an_unchanged_default_model_isnt_revalidated(client, db, user, provider):
    from app.chat.models import Workspace

    ws_id = await _workspace(client, user)
    ws = await db.get(Workspace, uuid.UUID(ws_id))
    # A default the editing admin couldn't set themselves.
    ws.default_provider_id = provider.id
    ws.default_model_id = "not-enabled-anywhere"
    await db.commit()
    r = await client.patch(
        f"/api/workspaces/{ws_id}",
        json={
            "description": "typo fixed",
            "default_model_id": "not-enabled-anywhere",
            "default_provider_id": str(provider.id),
        },
        headers=_auth(user),
    )
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------- R-203


@pytest.mark.asyncio
async def test_overview_counts_files_rosters_and_discussions(client, db, user):
    from app.chat.models import WorkspaceFile
    from app.files.models import UserFile

    ws_id = await _workspace(client, user)
    await _item(client, user, ws_id, "roster", "Shifts")
    await _item(client, user, ws_id, "discussion", "Talk")
    trashed = await _item(client, user, ws_id, "note", "Gone")
    uf = UserFile(user_id=user.id, filename="a.pdf", original_filename="a.pdf", mime_type="application/pdf", size_bytes=3, storage_path="x/a.pdf")
    db.add(uf)
    await db.flush()
    db.add(WorkspaceFile(workspace_id=uuid.UUID(ws_id), file_id=uf.id))
    await db.commit()
    await client.delete(f"/api/workspaces/{ws_id}/items/{trashed['id']}", headers=_auth(user))

    ov = (await client.get(f"/api/workspaces/{ws_id}/overview", headers=_auth(user))).json()
    assert ov["counts"]["files"] == 1
    assert ov["counts"]["rosters"] == 1
    assert ov["counts"]["discussions"] == 1
    card = (await client.get(f"/api/workspaces/{ws_id}", headers=_auth(user))).json()
    assert card["file_count"] == 1
    assert "note" not in card["item_counts"]  # the trashed note doesn't count


# ---------------------------------------------------------------- R-184


@pytest.mark.asyncio
async def test_my_work_drops_custom_done_columns_and_trashed_boards(client, db, user):
    from app.chat.models import WorkspaceItem, WorkspaceTask

    ws_id = await _workspace(client, user)
    board = await _item(client, user, ws_id, "board", "B")
    other = await _item(client, user, ws_id, "board", "Old")
    item = await db.get(WorkspaceItem, uuid.UUID(board["id"]))
    item.config = {"columns": [
        {"id": "todo", "name": "To do"},
        {"id": "c_shipped", "name": "Shipped", "done": True},
    ]}
    wid = uuid.UUID(ws_id)
    for title, status, b in (("open", "todo", board), ("shipped", "c_shipped", board), ("orphan", "todo", other)):
        db.add(WorkspaceTask(workspace_id=wid, board_item_id=uuid.UUID(b["id"]), title=title, status=status, assignee_user_id=user.id, position=1, created_by=user.id))
    old = await db.get(WorkspaceItem, uuid.UUID(other["id"]))
    old.trashed_at = datetime.now(timezone.utc)
    await db.commit()

    cards = (await client.get("/api/workspaces/my-work", headers=_auth(user))).json()["cards"]
    assert [c["title"] for c in cards] == ["open"]


# ---------------------------------------------------------------- R-183


@pytest.mark.asyncio
async def test_ask_without_an_embedder_answers_from_the_workspace_content(client, db, user, provider, monkeypatch):
    from app.chat.models import Workspace
    from app.workspaces import ask_router

    ws_id = await _workspace(client, user)
    ws = await db.get(Workspace, uuid.UUID(ws_id))
    ws.default_provider_id = provider.id
    ws.default_model_id = "test-model"
    await db.commit()
    await _item(client, user, ws_id, "board", "Launch checklist")

    seen = {}

    async def fake_stream(**kw):
        seen["msg"] = kw["messages"][0].content
        yield "From the board."

    monkeypatch.setattr(ask_router.model_router, "stream_chat", fake_stream)
    r = await client.post(f"/api/workspaces/{ws_id}/ask", json={"question": "what's here?"}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["answer"] == "From the board."
    assert "Launch checklist" in seen["msg"]


@pytest.mark.asyncio
async def test_ask_uses_only_a_model_the_caller_may_use(client, db, user, provider, monkeypatch):
    from app.chat.models import Workspace
    from app.workspaces import ask_router

    member = await _user(db, "viewer")
    ws_id = await _workspace(client, user)
    await _add_member(db, ws_id, user, member, "viewer")
    ws = await db.get(Workspace, uuid.UUID(ws_id))
    ws.default_provider_id = provider.id
    ws.default_model_id = "test-model"
    await db.commit()

    async def denied(u, db, *, model_id, base_model_id):
        return u.id != member.id

    monkeypatch.setattr("app.models_config.access.is_model_allowed", denied)
    r = await client.post(f"/api/workspaces/{ws_id}/ask", json={"question": "q"}, headers=_auth(member))
    assert r.status_code == 400
    assert "model you can use" in r.json()["detail"]


# ---------------------------------------------------------------- R-186


@pytest.mark.asyncio
async def test_the_same_query_is_embedded_once(db, provider, monkeypatch):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.custom_models import retrieval

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.embedding_provider_id = provider.id
    row.embedding_model_id = "embed"
    row.embedding_dim = sorted(retrieval.SUPPORTED_DIMS)[0]
    await db.commit()
    calls = []

    async def fake_embed(**kw):
        calls.append(kw["texts"])
        return [[0.1] * row.embedding_dim]

    monkeypatch.setattr(retrieval, "embed_texts", fake_embed)
    retrieval._QUERY_VECTOR_CACHE.clear()
    for _ in range(5):
        assert await retrieval._resolve_query_vector(db, "quarterly plan") is not None
    assert len(calls) == 1


# ---------------------------------------------------------------- R-187


@pytest.mark.asyncio
async def test_structural_changes_publish_a_live_event(client, db, user, monkeypatch):
    from app.workspaces import live

    published = []

    async def fake_publish(wid, actor=None):
        published.append(wid)

    ws_id = await _workspace(client, user)
    monkeypatch.setattr(live, "publish", fake_publish)
    await _item(client, user, ws_id, "note", "Fresh")
    await asyncio.sleep(0.05)
    assert uuid.UUID(ws_id) in published


# ---------------------------------------------------------------- R-188


@pytest.mark.asyncio
async def test_export_carries_rosters_discussions_paths_and_a_signed_link(client, db, user):
    from app.chat.models import Roster

    ws_id = await _workspace(client, user)
    nb = await _item(client, user, ws_id, "container", "Projects")
    await _item(client, user, ws_id, "note", "Brief", parent_id=nb["id"])
    roster = await _item(client, user, ws_id, "roster", "Shifts")
    row = await db.get(Roster, uuid.UUID(roster["ref_id"]))
    row.data = {"settings": {}, "shifts": [{"id": "s1", "personId": str(user.id), "date": "2026-10-10", "timed": True, "start": "09:00", "end": "17:00", "hours": 8, "tags": []}]}
    await db.commit()
    disc = await _item(client, user, ws_id, "discussion", "Talk")
    r = await client.post(f"/api/workspaces/{ws_id}/discussions/{disc['id']}/threads", json={"title": "Plan", "body": "Let's go"}, headers=_auth(user))
    assert r.status_code == 201, r.text

    link = (await client.post(f"/api/workspaces/{ws_id}/export-link", headers=_auth(user))).json()["url"]
    r = await client.get(link)  # no bearer header — the link is the credential
    assert r.status_code == 200, r.text
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert any(n.startswith("rosters/") for n in names)
    assert any(n.startswith("discussions/") for n in names)
    roster_csv = zf.read([n for n in names if n.startswith("rosters/")][0]).decode()
    assert user.username in roster_csv and "09:00" in roster_csv
    assert "Let's go" in zf.read([n for n in names if n.startswith("discussions/")][0]).decode()
    manifest = json.loads(zf.read("manifest.json"))
    brief = [i for i in manifest["items"] if i["title"] == "Brief"][0]
    assert brief["path"] == "Projects / Brief"

    # A tampered link is refused.
    assert (await client.get(link.replace("sig=", "sig=0"))).status_code == 403

    # And the bundle imports back with its notebook.
    r = await client.post(
        "/api/workspaces/import",
        files={"file": ("bundle.zip", r.content, "application/zip")},
        headers=_auth(user),
    )
    assert r.status_code == 201, r.text
    new_id = r.json()["id"]
    tree = (await client.get(f"/api/workspaces/{new_id}/tree", headers=_auth(user))).json()
    nbs = [n for n in tree if n["kind"] == "container"]
    assert [n["title"] for n in nbs] == ["Projects"]
    assert [c["title"] for c in nbs[0]["children"]] == ["Brief"]


# ---------------------------------------------------------------- R-204 / V10


@pytest.mark.asyncio
async def test_templates_come_from_the_server_and_include_family_ones(client, db, user):
    rows = (await client.get("/api/workspaces/templates", headers=_auth(user))).json()
    keys = {r["key"] for r in rows}
    assert {"household", "trip", "renovation", "school", "legal_matter"} <= keys
    assert {r["group"] for r in rows if r["key"] == "trip"} == {"Home & family"}


@pytest.mark.asyncio
async def test_duplicate_and_save_as_template_copy_the_setup(client, db, user):
    ws_id = await _workspace(client, user, "Sprint")
    h = _auth(user)
    await client.patch(f"/api/workspaces/{ws_id}", json={"system_prompt": "Be terse."}, headers=h)
    board = await _item(client, user, ws_id, "board", "Sprint board")
    await client.post(f"/api/workspaces/{ws_id}/tasks", json={"title": "Card", "board_item_id": board["id"]}, headers=h)

    r = await client.post(f"/api/workspaces/{ws_id}/duplicate", json={}, headers=h)
    assert r.status_code == 201, r.text
    copy_id = r.json()["id"]
    assert r.json()["title"] == "Sprint (copy)"
    detail = (await client.get(f"/api/workspaces/{copy_id}", headers=h)).json()
    assert detail["system_prompt"] == "Be terse."
    tasks = (await client.get(f"/api/workspaces/{copy_id}/tasks", headers=h)).json()
    assert [t["title"] for t in tasks] == ["Card"]

    # Saved as a template, it's offered to members and seeds new workspaces.
    member = await _user(db, "mem")
    await _add_member(db, ws_id, user, member, "viewer")
    await client.patch(f"/api/workspaces/{ws_id}", json={"is_template": True}, headers=h)
    rows = (await client.get("/api/workspaces/templates", headers=_auth(member))).json()
    assert f"ws:{ws_id}" in {r["key"] for r in rows}
    r = await client.post("/api/workspaces", json={"title": "Next sprint", "template": f"ws:{ws_id}"}, headers=_auth(member))
    assert r.status_code in (200, 201), r.text
    new_tree = (await client.get(f"/api/workspaces/{r.json()['id']}/tree", headers=_auth(member))).json()
    assert "Sprint board" in [n["title"] for n in new_tree]


# ---------------------------------------------------------------- R-178


@pytest.mark.asyncio
async def test_indexing_interrupted_by_a_restart_is_requeued(client, db, user, monkeypatch):
    from app.chat.models import WorkspaceItem
    from app.custom_models import backfill

    ws_id = await _workspace(client, user)
    note = await _item(client, user, ws_id, "note", "N")
    item = await db.get(WorkspaceItem, uuid.UUID(note["id"]))
    item.indexing_status = "embedding"
    await db.commit()
    monkeypatch.setattr(backfill, "start_backfill", lambda: None)
    assert await backfill.recover_interrupted_indexing() == 1
    db.expire_all()
    assert (await db.get(WorkspaceItem, uuid.UUID(note["id"]))).indexing_status == "queued"
