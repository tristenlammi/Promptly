"""A discussion's transcript pointer must never reach someone else's file.

Roadmap R-001 (P0). A discussion item stores the id of its RAG transcript
file in ``config['text_file_id']``. The item PATCH used to replace
``config`` wholesale, so any logged-in user could create their own
workspace, point a discussion at *any* file UUID they knew, and then
toggle context to make the indexer overwrite that file's bytes or move
it to Trash.

Two independent layers now stop it, and each is tested on its own:
the PATCH can't set server-managed keys, and the indexer refuses to
touch a file that isn't this discussion's own transcript.
"""
from __future__ import annotations

import uuid

import pytest

from app.auth.models import User
from app.chat.models import Workspace, WorkspaceItem
from app.files import storage
from app.files.generated_kinds import GeneratedKind
from app.files.models import UserFile
from app.workspaces.items_router import _merge_client_config
from app.workspaces.knowledge import (
    _ensure_discussion_backing_file,
    _purge_discussion_inner,
    load_discussion_backing_file,
)


@pytest.fixture
def upload_root(tmp_path, monkeypatch):
    """Keep every byte these tests write out of the real uploads dir."""
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


async def _user(db, name: str) -> User:
    u = User(
        email=f"{name}-{uuid.uuid4().hex[:8]}@example.com",
        username=f"{name}-{uuid.uuid4().hex[:8]}",
        password_hash="x",
        role="user",
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _file(db, owner: User, upload_root, *, body: bytes, kind=None) -> UserFile:
    fid = uuid.uuid4()
    rel = f"u_{owner.id}/{fid}.pdf"
    path = upload_root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    uf = UserFile(
        id=fid,
        user_id=owner.id,
        filename="tax-return.pdf",
        original_filename="tax-return.pdf",
        mime_type="application/pdf",
        size_bytes=len(body),
        storage_path=rel,
        source_kind=kind,
    )
    db.add(uf)
    await db.commit()
    await db.refresh(uf)
    return uf


async def _discussion(db, owner: User, *, points_at: uuid.UUID | None):
    ws = Workspace(user_id=owner.id, title="Attacker's workspace")
    db.add(ws)
    await db.commit()
    await db.refresh(ws)
    item = WorkspaceItem(
        workspace_id=ws.id,
        kind="discussion",
        title="Innocent chat",
        position=1.0,
        config={"text_file_id": str(points_at)} if points_at else None,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return ws, item


# --------------------------------------------------------------- layer 1


def test_a_client_cannot_set_the_transcript_pointer():
    merged = _merge_client_config(
        {"text_file_id": "server-value"},
        {"text_file_id": "attacker-value", "columns": ["a"]},
    )

    assert merged == {"columns": ["a"], "text_file_id": "server-value"}


def test_a_client_cannot_plant_a_pointer_where_none_existed():
    merged = _merge_client_config(None, {"text_file_id": "attacker-value"})

    assert "text_file_id" not in merged


def test_clearing_config_keeps_the_server_pointer():
    assert _merge_client_config({"text_file_id": "server-value"}, None) == {
        "text_file_id": "server-value"
    }


def test_ordinary_board_config_still_replaces_wholesale():
    """Boards rely on PATCH replacing their label/column registry."""
    merged = _merge_client_config({"columns": ["old"]}, {"columns": ["new"]})

    assert merged == {"columns": ["new"]}


# --------------------------------------------------------------- layer 2


@pytest.mark.asyncio
async def test_purge_never_trashes_a_file_the_pointer_was_aimed_at(
    db, upload_root
):
    attacker = await _user(db, "attacker")
    victim = await _user(db, "victim")
    victim_file = await _file(db, victim, upload_root, body=b"%PDF-1.7 tax")
    ws, item = await _discussion(db, attacker, points_at=victim_file.id)

    await _purge_discussion_inner(db, workspace_id=ws.id, item=item)
    await db.commit()
    await db.refresh(victim_file)

    assert victim_file.trashed_at is None
    assert "text_file_id" not in (item.config or {})


@pytest.mark.asyncio
async def test_indexing_never_overwrites_a_file_the_pointer_was_aimed_at(
    db, upload_root
):
    attacker = await _user(db, "attacker")
    victim = await _user(db, "victim")
    original = b"%PDF-1.7 the victim's real document"
    victim_file = await _file(db, victim, upload_root, body=original)
    ws, item = await _discussion(db, attacker, points_at=victim_file.id)

    created = await _ensure_discussion_backing_file(
        db, ws=ws, item=item, text="attacker: replaced!"
    )
    await db.commit()
    await db.refresh(victim_file)

    assert (upload_root / victim_file.storage_path).read_bytes() == original
    assert victim_file.filename == "tax-return.pdf"
    # A fresh transcript was made instead, and the pointer now names it.
    assert created is not None and created.id != victim_file.id
    assert created.source_kind == GeneratedKind.DISCUSSION_TEXT.value
    assert created.user_id == attacker.id
    assert item.config["text_file_id"] == str(created.id)


@pytest.mark.asyncio
async def test_a_genuine_transcript_is_still_updated_in_place_and_purged(
    db, upload_root
):
    """The guard must not break the normal path."""
    owner = await _user(db, "owner")
    ws, item = await _discussion(db, owner, points_at=None)

    first = await _ensure_discussion_backing_file(
        db, ws=ws, item=item, text="alice: hello"
    )
    await db.commit()
    second = await _ensure_discussion_backing_file(
        db, ws=ws, item=item, text="alice: hello\nbob: hi"
    )
    await db.commit()

    assert second.id == first.id
    assert (upload_root / second.storage_path).read_text() == "alice: hello\nbob: hi"
    assert (
        await load_discussion_backing_file(db, owner_user_id=owner.id, item=item)
    ).id == first.id

    await _purge_discussion_inner(db, workspace_id=ws.id, item=item)
    await db.commit()
    await db.refresh(first)
    assert first.trashed_at is not None


@pytest.mark.asyncio
async def test_a_transcript_owned_by_someone_else_is_rejected(db, upload_root):
    """Right kind, wrong owner — still not ours to touch."""
    owner = await _user(db, "owner")
    other = await _user(db, "other")
    foreign = await _file(
        db, other, upload_root, body=b"x", kind=GeneratedKind.DISCUSSION_TEXT.value
    )
    _ws, item = await _discussion(db, owner, points_at=foreign.id)

    assert (
        await load_discussion_backing_file(db, owner_user_id=owner.id, item=item)
        is None
    )
