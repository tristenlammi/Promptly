"""Ask your Drive (WP-5.1): one read rule for downloads and AI search, an
opt-in per-user Drive index with folder exclusions, and a background pass
that only re-embeds what changed."""
from __future__ import annotations

import base64
import io
import uuid

import httpx
import pytest
from sqlalchemy import select, text


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app
    from app.tasks import queue

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())

    async def no_worker(file_id):
        return None

    monkeypatch.setattr(queue, "enqueue_office_text", no_worker)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
def embedder(monkeypatch, provider):
    """A fake 768-dim embedder; counts the texts it was asked to embed."""
    from app.chat import semantic_search
    from app.chat.semantic_search import EmbeddingConfig
    from app.custom_models import ingestion, retrieval

    calls: list[str] = []

    async def fake_embed(*, provider, model_id, texts, **kw):  # noqa: ARG001
        calls.extend(texts)
        return [[0.01 * (i + 1)] * 768 for i, _ in enumerate(texts)]

    async def cfg(db):  # noqa: ARG001
        return EmbeddingConfig(provider=provider, model_id="fake-embed", dim=768)

    async def no_vector(db, query):  # noqa: ARG001 — keyword arm only in tests
        return None

    monkeypatch.setattr(ingestion, "embed_texts", fake_embed)
    monkeypatch.setattr(semantic_search, "get_embedding_config", cfg)
    monkeypatch.setattr(retrieval, "_resolve_query_vector", no_vector)
    return calls


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _user(db, name):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:4]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _upload(client, user, name, data, folder_id=None, mime="text/plain"):
    form = {"scope": "mine"}
    if folder_id:
        form["folder_id"] = str(folder_id)
    r = await client.post("/api/files/", files={"file": (name, data, mime)}, data=form, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    return r.json()


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (0, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------- read rule


@pytest.mark.asyncio
async def test_one_read_rule_for_owner_grants_folders_and_trash(client, db, user):
    from datetime import datetime, timezone

    from app.files.access import can_read
    from app.files.models import FileFolder, UserFile

    pal, stranger = await _user(db, "pal"), await _user(db, "sam")
    top = FileFolder(user_id=user.id, name="Shared")
    db.add(top)
    await db.flush()
    inner = FileFolder(user_id=user.id, name="Inner", parent_id=top.id)
    db.add(inner)
    await db.commit()
    deep = await _upload(client, user, "deep.txt", b"deep", folder_id=inner.id)
    loose = await _upload(client, user, "loose.txt", b"loose")
    r = await client.post(f"/api/files/folder/{top.id}/grants", json={"grantee_user_id": str(pal.id)}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    deep_id, loose_id = uuid.UUID(deep["id"]), uuid.UUID(loose["id"])

    assert await can_read(db, deep_id, user.id) and await can_read(db, loose_id, user.id)
    assert await can_read(db, deep_id, pal.id)  # inherited from a folder two levels up
    assert not await can_read(db, loose_id, pal.id)
    assert not await can_read(db, deep_id, stranger.id)
    row = await db.get(UserFile, deep_id)
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    assert not await can_read(db, deep_id, pal.id)
    assert await can_read(db, deep_id, pal.id, include_trashed=True)
    # Downloads follow the same rule.
    assert (await client.get(f"/api/files/{loose_id}/download", headers=_auth(pal))).status_code == 404


# ---------------------------------------------------------------- settings


@pytest.mark.asyncio
async def test_ai_search_is_off_until_turned_on_and_only_your_folders_can_be_excluded(client, db, user, embedder):
    from app.files.models import FileFolder

    r = await client.get("/api/files/ai-index", headers=_auth(user))
    assert r.json()["enabled"] is False and r.json()["embedder"] == "Test provider · fake-embed"
    mine = FileFolder(user_id=user.id, name="Medical")
    other = await _user(db, "oth")
    theirs = FileFolder(user_id=other.id, name="Theirs")
    db.add_all([mine, theirs])
    await db.commit()
    r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [str(theirs.id)]},
                         headers=_auth(user))
    assert r.status_code == 404
    r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [str(mine.id)]},
                         headers=_auth(user))
    body = r.json()
    assert body["enabled"] is True and body["excluded_folders"] == [{"id": str(mine.id), "name": "Medical"}]


# ---------------------------------------------------------------- indexing


@pytest.mark.asyncio
async def test_the_drive_is_indexed_incrementally_and_shared_files_are_found(client, db, user, embedder):
    from pycrdt import Doc, XmlElement, XmlFragment, XmlText

    from app.custom_models.retrieval import retrieve_drive_context
    from app.files.drive_index import index_pass
    from app.files.models import DriveIndexState, FileFolder, UserFile

    private = FileFolder(user_id=user.id, name="Private")
    db.add(private)
    await db.commit()
    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [str(private.id)]},
                     headers=_auth(user))

    # A Promptly Doc, a text file, a Word upload, an image, a hidden file.
    r = await client.post("/api/files/office", json={"kind": "document", "title": "Car insurance"}, headers=_auth(user))
    doc_id = r.json()["id"]
    d = Doc()
    d.get("default", type=XmlFragment).children.append(
        XmlElement("paragraph", {}, [XmlText("Policy renews on 14 March; premium rose to 912 dollars.")])
    )
    await client.post(f"/api/documents/{doc_id}/initial-state",
                      json={"yjs_state": base64.b64encode(d.get_update()).decode()}, headers=_auth(user))
    notes = await _upload(client, user, "notes.txt", b"Plumber quoted 340 for the boiler service.")
    word = await _upload(client, user, "letter.docx", b"PK placeholder", mime="application/octet-stream") \
        if False else None
    img = await _upload(client, user, "cat.png", _png(), mime="image/png")
    secret = await _upload(client, user, "diagnosis.txt", b"Confidential diagnosis paperwork.", folder_id=private.id)
    del word

    assert await index_pass(db) >= 3
    states = {s.file_id: s.status for s in (await db.execute(select(DriveIndexState))).scalars().all()}
    assert states[uuid.UUID(doc_id)] == "ready" and states[uuid.UUID(notes["id"])] == "ready"
    assert states[uuid.UUID(img["id"])] == "skipped"
    assert uuid.UUID(secret["id"]) not in states  # excluded folder
    chunks = (await db.execute(text("SELECT count(*) FROM knowledge_chunks WHERE drive_user_id = :u"),
                               {"u": str(user.id)})).scalar()
    assert chunks >= 2

    # Nothing changed → nothing re-embedded.
    before = len(embedder)
    await index_pass(db)
    assert len(embedder) == before

    # Search: the owner finds the doc; a stranger finds nothing; once the
    # text file is shared with them, they find that (and only that).
    hits = await retrieve_drive_context(db, reader_id=user.id, query="premium renews")
    assert hits and hits[0].user_file_id == uuid.UUID(doc_id)
    pal = await _user(db, "pal")
    assert await retrieve_drive_context(db, reader_id=pal.id, query="plumber boiler") == []
    await client.post(f"/api/files/file/{notes['id']}/grants", json={"grantee_user_id": str(pal.id)},
                      headers=_auth(user))
    hits = await retrieve_drive_context(db, reader_id=pal.id, query="plumber boiler")
    assert [h.user_file_id for h in hits] == [uuid.UUID(notes["id"])]
    assert await retrieve_drive_context(db, reader_id=pal.id, query="premium renews") == []
    assert await retrieve_drive_context(db, reader_id=user.id, query="diagnosis paperwork") == []

    # Moving a file into the excluded folder takes it out of the index.
    row = await db.get(UserFile, uuid.UUID(notes["id"]))
    row.folder_id = private.id
    await db.commit()
    await index_pass(db)
    assert await retrieve_drive_context(db, reader_id=user.id, query="plumber boiler") == []

    # Turning it off forgets everything.
    await client.put("/api/files/ai-index", json={"enabled": False, "excluded_folder_ids": []}, headers=_auth(user))
    left = (await db.execute(text("SELECT count(*) FROM knowledge_chunks WHERE drive_user_id = :u"),
                             {"u": str(user.id)})).scalar()
    assert left == 0
    status = (await client.get("/api/files/ai-index", headers=_auth(user))).json()
    assert status["indexed"] == 0 and status["enabled"] is False


@pytest.mark.asyncio
async def test_an_edited_file_is_reindexed(client, db, user, embedder):
    from datetime import datetime, timedelta, timezone

    from app.custom_models.retrieval import retrieve_drive_context
    from app.files.drive_index import index_pass
    from app.files.models import UserFile
    from app.files.storage import absolute_path

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    f = await _upload(client, user, "todo.txt", b"Buy paint for the fence.")
    await index_pass(db)
    row = await db.get(UserFile, uuid.UUID(f["id"]))
    absolute_path(row.storage_path).write_bytes(b"Book the dentist for Tuesday.")
    row.modified_at = datetime.now(timezone.utc) + timedelta(seconds=5)
    await db.commit()
    before = len(embedder)
    await index_pass(db)
    assert len(embedder) > before
    assert await retrieve_drive_context(db, reader_id=user.id, query="dentist tuesday")
    assert await retrieve_drive_context(db, reader_id=user.id, query="paint fence") == []


@pytest.mark.asyncio
async def test_vectors_a_workspace_already_has_are_copied_not_reembedded(client, db, user, embedder):
    from app.chat.models import WorkspaceFile
    from app.custom_models.embedding import file_content_hash
    from app.custom_models.embedding import Chunk
    from app.custom_models.ingestion import insert_chunks
    from app.files.drive_index import index_pass
    from app.files.models import DriveIndexState, UserFile

    r = await client.post("/api/workspaces", json={"title": "Home"}, headers=_auth(user))
    ws = uuid.UUID(r.json()["id"])
    f = await _upload(client, user, "manual.txt", b"Dishwasher manual: clean the filter monthly.")
    row = await db.get(UserFile, uuid.UUID(f["id"]))
    db.add(WorkspaceFile(workspace_id=ws, file_id=row.id, pinned_by=user.id,
                         indexing_status="ready", indexed_content_hash=file_content_hash(row)))
    await db.commit()
    await insert_chunks(db, scope_kind="workspace", scope_id=ws, user_file_id=row.id,
                        chunks=[Chunk(index=0, text="Dishwasher manual: clean the filter monthly.", tokens=8, metadata={})],
                        embeddings=[[0.5] * 768], embedding_model="fake-embed", embedding_dim=768)

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    before = len(embedder)
    await index_pass(db)
    assert len(embedder) == before  # nothing sent to the embedder
    st = await db.get(DriveIndexState, row.id, populate_existing=True)
    assert st.status == "ready" and st.chunks == 1
    n = (await db.execute(text("SELECT count(*) FROM knowledge_chunks WHERE drive_user_id = :u AND user_file_id = :f"),
                          {"u": str(user.id), "f": str(row.id)})).scalar()
    assert n == 1
