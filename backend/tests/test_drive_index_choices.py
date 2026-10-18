"""Choosing what AI search indexes: the top of your Drive to pick from
(Generated Files and Chat Uploads included), and whole kinds of file left
out — both taking what was already indexed back out."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from tests.test_drive_index_wp51 import _auth, _upload, client, embedder  # noqa: F401 — fixtures


@pytest.mark.asyncio
async def test_generated_files_and_kinds_of_file_can_be_left_out(client, db, user, embedder):
    from app.custom_models.retrieval import retrieve_drive_context
    from app.files.drive_index import index_pass
    from app.files.models import DriveIndexState, UserFile
    from app.files.system_folders import ensure_generated_files, ensure_generated_root

    gen_root = await ensure_generated_root(db, user)
    gen_files = await ensure_generated_files(db, user)
    await db.commit()
    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))

    made = await _upload(client, user, "summary.txt", b"The AI wrote this quarterly summary of llamas.")
    row = await db.get(UserFile, uuid.UUID(made["id"]))
    row.folder_id = gen_files.id
    await db.commit()
    mine = await _upload(client, user, "notes.txt", b"Plumber quoted 340 for the boiler service.")
    r = await client.post("/api/files/office", json={"kind": "document", "title": "Llama farm plan"}, headers=_auth(user))
    doc_id = r.json()["id"]
    doc = await db.get(UserFile, uuid.UUID(doc_id))
    doc.content_text = "Buy two more llamas in spring."
    await db.commit()

    await index_pass(db)
    assert await retrieve_drive_context(db, reader_id=user.id, query="quarterly summary llamas")

    # The top of the Drive is offered, Generated Files with it.
    body = (await client.get("/api/files/ai-index", headers=_auth(user))).json()
    offered = {f["id"]: f for f in body["folders"]}
    assert offered[str(gen_root.id)]["system_kind"] == "generated_root"
    assert offered[str(gen_root.id)]["excluded"] is False
    assert body["excluded_kinds"] == []

    # Leave Generated Files out: what the AI made stops turning up at once.
    r = await client.put(
        "/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": [str(gen_root.id)]}, headers=_auth(user)
    )
    body = r.json()
    assert {f["id"]: f for f in body["folders"]}[str(gen_root.id)]["excluded"] is True
    assert await retrieve_drive_context(db, reader_id=user.id, query="quarterly summary llamas") == []

    # Leave text files out: the note goes, the Doc stays.
    r = await client.put(
        "/api/files/ai-index",
        json={"enabled": True, "excluded_folder_ids": [str(gen_root.id)], "excluded_kinds": ["text"]},
        headers=_auth(user),
    )
    assert r.json()["excluded_kinds"] == ["text"]
    assert await retrieve_drive_context(db, reader_id=user.id, query="plumber boiler") == []
    assert await retrieve_drive_context(db, reader_id=user.id, query="llamas spring")
    await index_pass(db)
    states = {s.file_id for s in (await db.execute(select(DriveIndexState))).scalars().all()}
    assert uuid.UUID(mine["id"]) not in states and uuid.UUID(doc_id) in states

    # A save that doesn't mention kinds keeps them.
    r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    assert r.json()["excluded_kinds"] == ["text"]
    assert r.json()["eligible"] == 1  # the Doc; both text files stay out
