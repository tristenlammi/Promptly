"""Workspace export privacy + Markdown-zip import (WP-2.7: R-307, R-312,
R-315, R-327).

Export: another member's private chat never reaches the owner's bundle or
the workspace chat list, and a transcript is the visible thread only.
Import: Notion block ids are stripped, top-level folders become notebooks,
a Promptly bundle's chats/canvases are skipped with a reason, and an
archive past the old 400-note cap is accepted.
"""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

import httpx
import pytest

NOTION_ID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app
    from app.workspaces import knowledge

    # Imported notes write their HTML blobs; keep them out of the real
    # upload root, and don't RAG-index hundreds of notes in a test.
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())

    async def _no_index(*_a, **_k):
        return None

    monkeypatch.setattr(knowledge, "index_note_for_workspace", _no_index)

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

    db.add(
        WorkspaceShare(
            workspace_id=uuid.UUID(ws_id),
            inviter_user_id=owner.id,
            invitee_user_id=member.id,
            status="accepted",
            role=role,
            accepted_at=datetime.now(timezone.utc),
        )
    )
    await db.commit()


async def _chat(db, ws_id, author, provider, title, visibility, text):
    """A workspace conversation with one user turn + one answer."""
    from app.chat.models import Conversation, Message

    conv = Conversation(
        user_id=author.id, title=title, provider_id=provider.id,
        model_id="test-model", workspace_id=uuid.UUID(ws_id),
        visibility=visibility,
    )
    db.add(conv)
    await db.flush()
    t0 = datetime.now(timezone.utc)
    q = Message(id=uuid.uuid4(), conversation_id=conv.id, role="user",
                content=f"{text} question", created_at=t0)
    db.add(q)
    await db.flush()
    a = Message(id=uuid.uuid4(), conversation_id=conv.id, role="assistant",
                content=f"{text} answer", parent_id=q.id,
                created_at=t0 + timedelta(seconds=1))
    db.add(a)
    await db.flush()
    conv.active_leaf_message_id = a.id
    await db.commit()
    return conv, q, a


async def _export(client, owner, ws_id) -> zipfile.ZipFile:
    r = await client.get(f"/api/workspaces/{ws_id}/export", headers=_auth(owner))
    assert r.status_code == 200, r.text
    return zipfile.ZipFile(io.BytesIO(r.content))


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, body in files.items():
            zf.writestr(name, body)
    return buf.getvalue()


async def _import(client, user, data: bytes, filename="import.zip"):
    return await client.post(
        "/api/workspaces/import",
        files={"file": (filename, data, "application/zip")},
        headers=_auth(user),
    )


async def _tree(client, user, ws_id):
    r = await client.get(f"/api/workspaces/{ws_id}/tree", headers=_auth(user))
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- R-312


@pytest.mark.asyncio
async def test_export_and_chat_list_leave_out_another_members_private_chat(
    client, db, user, provider
):
    ws_id = await _workspace(client, user)
    member = await _user(db, "member")
    await _add_member(db, ws_id, user, member)
    await _chat(db, ws_id, member, provider, "Member secret", "private", "Secret")
    await _chat(db, ws_id, member, provider, "Member shared", "workspace", "Shared")
    await _chat(db, ws_id, user, provider, "Owner own", "private", "Own")

    zf = await _export(client, user, ws_id)
    chats = {n for n in zf.namelist() if n.startswith("chats/")}
    assert chats == {"chats/Member shared.md", "chats/Owner own.md"}
    blob = b"".join(zf.read(n) for n in zf.namelist())
    assert b"Secret question" not in blob and b"Secret answer" not in blob
    manifest = json.loads(zf.read("manifest.json"))
    assert any("private chats" in s for s in manifest["limitations"])
    assert any("not a restorable backup" in s for s in manifest["limitations"])

    # The workspace chat list follows the same rule — for the owner...
    r = await client.get(f"/api/workspaces/{ws_id}/conversations", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert {c["title"] for c in r.json()} == {"Member shared", "Owner own"}
    # ...while the member still sees their own private chat (not the owner's).
    r = await client.get(f"/api/workspaces/{ws_id}/conversations", headers=_auth(member))
    assert {c["title"] for c in r.json()} == {"Member secret", "Member shared"}


# ---------------------------------------------------------------- R-307


@pytest.mark.asyncio
async def test_exported_transcript_is_the_visible_thread_only(client, db, user, provider):
    from app.chat.models import Message

    ws_id = await _workspace(client, user)
    conv, q, a = await _chat(db, ws_id, user, provider, "Branched", "workspace", "First")
    # A regeneration of the answer, which the user then switched away from.
    regen = Message(id=uuid.uuid4(), conversation_id=conv.id, role="assistant",
                    content="Discarded regeneration", parent_id=q.id,
                    created_at=a.created_at + timedelta(seconds=5))
    db.add(regen)
    await db.commit()

    zf = await _export(client, user, ws_id)
    md = zf.read("chats/Branched.md").decode()
    assert "First answer" in md
    assert "Discarded regeneration" not in md


# ---------------------------------------------------------------- R-315


@pytest.mark.asyncio
async def test_import_strips_notion_ids_and_maps_top_folders_to_notebooks(client, db, user):
    data = _zip(
        {
            f"Export-{NOTION_ID}/Meeting notes {NOTION_ID}.md": "# Meeting\n\nAgenda",
            f"Export-{NOTION_ID}/Specs {NOTION_ID}/Overview {NOTION_ID}.md": "Overview",
            f"Export-{NOTION_ID}/Specs {NOTION_ID}/2024 {NOTION_ID}/API {NOTION_ID}.md": "API",
            f"Export-{NOTION_ID}/Specs {NOTION_ID}/diagram.png": b"\x89PNG",
            f"Export-{NOTION_ID}/Tasks {NOTION_ID}.csv": "a,b",
        }
    )
    r = await _import(client, user, data, filename="notion.zip")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["notes"] == 3
    assert body["notebooks"] == 1
    assert body["skipped_total"] == 2
    assert sum(body["skipped"].values()) == 2
    assert all(isinstance(k, str) and k for k in body["skipped"])

    tree = await _tree(client, user, body["id"])
    top = {n["title"]: n for n in tree}
    assert "Meeting notes" in top
    assert top["Specs"]["kind"] == "container"
    assert {c["title"] for c in top["Specs"]["children"]} == {"Overview", "2024 / API"}
    titles = json.dumps(tree)
    assert NOTION_ID not in titles


@pytest.mark.asyncio
async def test_import_accepts_more_than_the_old_400_note_cap(client, db, user):
    data = _zip({f"vault/note {i:04d}.md": f"Note {i}" for i in range(420)})
    r = await _import(client, user, data)
    assert r.status_code == 201, r.text
    assert r.json()["notes"] == 420


@pytest.mark.asyncio
async def test_import_cap_and_total_size_guard_still_apply(client, db, user, monkeypatch):
    from app.workspaces import export_router

    monkeypatch.setattr(export_router, "_IMPORT_MAX_NOTES", 3)
    r = await _import(client, user, _zip({f"n{i}.md": "x" for i in range(4)}))
    assert r.status_code == 413, r.text

    monkeypatch.setattr(export_router, "_IMPORT_MAX_NOTES", 2000)
    monkeypatch.setattr(export_router, "_IMPORT_MAX_TOTAL_BYTES", 10)
    r = await _import(client, user, _zip({"a.md": "x" * 6, "b.md": "y" * 6}))
    assert r.status_code == 413, r.text


# ---------------------------------------------------------------- R-327


@pytest.mark.asyncio
async def test_bundle_chats_and_canvases_are_skipped_with_a_reason(client, db, user):
    from app.workspaces.export_router import _BUNDLE_SKIP_REASONS

    manifest = {
        "format": "promptly-workspace-export",
        "version": 2,
        "workspace": {"title": "Old team"},
        "items": [
            {"id": str(uuid.uuid4()), "kind": "note", "title": "Brief",
             "parent_id": None, "path": "Brief", "file": "notes/Brief.md"},
        ],
    }
    data = _zip(
        {
            "manifest.json": json.dumps(manifest),
            "notes/Brief.md": "# Brief",
            "chats/Planning chat.md": "# Planning chat\n\n### User — 2026-10-01\n\nhi",
            "canvases/Board.excalidraw": "{}",
            "canvases/Board.txt": "text",
            "boards/Sprint.csv": "Title\nCard",
        }
    )
    r = await _import(client, user, data)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["notes"] == 1
    assert body["skipped"][_BUNDLE_SKIP_REASONS["chats"]] == 1
    assert body["skipped"][_BUNDLE_SKIP_REASONS["canvases"]] == 2
    assert body["skipped"][_BUNDLE_SKIP_REASONS["boards"]] == 1

    titles = {n["title"] for n in await _tree(client, user, body["id"]) if n["kind"] == "note"}
    assert titles == {"Brief"}


@pytest.mark.asyncio
async def test_a_bundle_without_a_readable_manifest_still_skips_its_chats(client, db, user):
    from app.workspaces.export_router import _BUNDLE_SKIP_REASONS

    data = _zip(
        {
            "manifest.json": "not json",
            "notes/Kept.md": "kept",
            "chats/Transcript.md": "# Transcript",
        }
    )
    r = await _import(client, user, data)
    assert r.status_code == 201, r.text
    assert r.json()["notes"] == 1
    assert r.json()["skipped"] == {_BUNDLE_SKIP_REASONS["chats"]: 1}
