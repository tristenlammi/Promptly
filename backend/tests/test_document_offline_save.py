"""A Save made while live sync is down becomes part of the document (R-022).

It used to write only the HTML blob; the CRDT state (what the editor and
the collab server load) never saw it, so the next live edit overwrote it.
"""
from __future__ import annotations

import base64

import pytest
from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from app.files import storage
from app.files.document_build import markdown_to_doc_update
from app.files.documents_router import create_blank_document, manual_save_document
from app.files.models import DocumentState
from app.files.schemas import ManualDocumentSaveRequest


@pytest.fixture
async def doc(db, user, tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    row = await create_blank_document(db, owner_id=user.id, folder_id=None, name="Plan")
    ds = await db.get(DocumentState, row.id)
    ds.yjs_update = markdown_to_doc_update("Server paragraph")
    await db.commit()
    return row


def _client_with_edit(server_state: bytes, text: str) -> str:
    """An editor that synced the server copy, then typed offline."""
    d = Doc()
    d.apply_update(server_state)
    frag = d.get("default", type=XmlFragment)
    p = XmlElement("paragraph")
    frag.children.append(p)
    p.children.append(XmlText(text))
    return base64.b64encode(d.get_update()).decode()


@pytest.mark.asyncio
async def test_offline_save_merges_into_the_document(db, user, doc):
    ds = await db.get(DocumentState, doc.id)
    state = _client_with_edit(ds.yjs_update, "Written offline")
    body = ManualDocumentSaveRequest(html="<p>ignored when state is sent</p>", yjs_state=state)

    await manual_save_document(doc.id, body, db=db, user=user)
    # Saving the same state again (a retry, a second click) changes nothing.
    await manual_save_document(doc.id, body, db=db, user=user)

    await db.refresh(ds)
    from app.files.document_render import render_html_from_update

    html = render_html_from_update(ds.yjs_update)
    assert html.count("Server paragraph") == 1
    assert html.count("Written offline") == 1
    blob = (storage.UPLOAD_ROOT / doc.storage_path).read_text()
    assert "Written offline" in blob and "ignored" not in blob


@pytest.mark.asyncio
async def test_garbage_state_is_rejected(db, user, doc):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        await manual_save_document(
            doc.id, ManualDocumentSaveRequest(yjs_state="not base64!"), db=db, user=user
        )
    assert e.value.status_code == 400


@pytest.mark.asyncio
async def test_missed_snapshots_are_rerendered(db, user, doc):
    """A snapshot the collab server couldn't deliver (backend restarting)
    left the file's HTML and search text stale; the daily sweep fixes it."""
    from datetime import datetime, timedelta, timezone

    from app.files.documents_router import rerender_stale_documents

    # Live state edited well after the HTML was last written. (A trigger
    # stamps files.updated_at on every write, so move the state forward.)
    ds = await db.get(DocumentState, doc.id)
    ds.updated_at = datetime.now(timezone.utc) + timedelta(hours=1)
    await db.commit()

    assert await rerender_stale_documents(db) == 1

    await db.refresh(doc)
    assert "Server paragraph" in (storage.UPLOAD_ROOT / doc.storage_path).read_text()
    assert "Server paragraph" in (doc.content_text or "")


def test_markdown_tables_become_real_tables():
    """V3: template / automation tables used to arrive as "| a | b |" text."""
    from app.files.document_build import markdown_to_doc_update
    from app.files.document_render import render_html_from_update

    html = render_html_from_update(markdown_to_doc_update(
        "| Item | Owner |\n|---|---|\n| Venue | **Sam** |\n| Cake | ~~Jo~~ |\n"
    ))

    assert "<table" in html and "<th" in html and "|" not in html
    assert "Venue" in html and "<strong>Sam</strong>" in html
