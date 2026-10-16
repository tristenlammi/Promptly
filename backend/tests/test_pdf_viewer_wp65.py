"""The PDF viewer's save (WP-6.5): an edited PDF becomes the file's content,
what it replaces becomes a version (history, diff, restore), a save over
someone else's newer one is refused, and only editors may save."""
from __future__ import annotations

import io
import uuid

import httpx
import pytest
from pypdf import PdfReader


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


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


def _pdf(*pages: str) -> bytes:
    """A PDF with one line of text per page."""
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for text in pages:
        c.drawString(72, 720, text)
        c.showPage()
    c.save()
    return buf.getvalue()


async def _upload(client, user, name, data):
    r = await client.post("/api/files/", files={"file": (name, data, "application/pdf")}, data={"scope": "mine"},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _save(client, user, fid, data, revision):
    return await client.put(f"/api/files/{fid}/pdf", files={"file": ("x.pdf", data, "application/pdf")},
                            data={"revision": revision}, headers=_auth(user))


@pytest.mark.asyncio
async def test_saving_makes_a_version_and_restoring_brings_it_back(client, db, user):
    from app.files.models import FileVersion, UserFile
    from app.files.storage import absolute_path

    fid = await _upload(client, user, "Form.pdf", _pdf("Name: ____"))
    info = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(user))).json()
    assert info["can_edit"] is True
    dl = await client.get(f"/api/files/{fid}/download", headers=_auth(user))
    assert dl.headers["x-file-revision"] == info["revision"]

    filled = _pdf("Name: Ada Lovelace", "Signed today")
    r = await _save(client, user, fid, filled, info["revision"])
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["revision"] != info["revision"] and saved["size_bytes"] == len(filled)

    # The file is the new PDF, and searchable by what was filled in.
    dl = await client.get(f"/api/files/{fid}/download", headers=_auth(user))
    assert dl.content == filled and dl.headers["x-file-revision"] == saved["revision"]
    row = await db.get(UserFile, uuid.UUID(fid), populate_existing=True)
    assert "Ada Lovelace" in (row.content_text or "")

    # What it replaced is a version, with its own bytes still on disk.
    v = await db.get(FileVersion, uuid.UUID(saved["version_id"]))
    assert (v.kind, v.source, v.author_ids) == ("pdf", "edit", [user.id])
    assert absolute_path(v.storage_path).read_bytes().startswith(b"%PDF") and v.storage_path != row.storage_path
    listed = (await client.get(f"/api/files/{fid}/versions", headers=_auth(user))).json()
    assert listed["kind"] == "pdf" and listed["can_edit"] is True
    assert [x["source"] for x in listed["versions"]] == ["edit"]

    # What restoring would change: text and pages.
    diff = (await client.get(f"/api/files/{fid}/versions/{v.id}/diff", headers=_auth(user))).json()
    assert diff["kind"] == "pdf" and (diff["pages_before"], diff["pages_after"]) == (1, 2)
    assert any(line["op"] == "add" and "Ada Lovelace" in line["text"] for line in diff["lines"])

    # Restore: the original is back, and the filled-in one is kept.
    r = await client.post(f"/api/files/{fid}/versions/{v.id}/restore", headers=_auth(user))
    assert r.status_code == 200, r.text
    dl = await client.get(f"/api/files/{fid}/download", headers=_auth(user))
    assert len(PdfReader(io.BytesIO(dl.content)).pages) == 1
    listed = (await client.get(f"/api/files/{fid}/versions", headers=_auth(user))).json()
    assert [x["source"] for x in listed["versions"]] == ["restore", "edit"]
    assert listed["versions"][0]["label"].startswith("Before restoring the version from")


@pytest.mark.asyncio
async def test_a_save_over_a_newer_one_is_refused(client, user):
    fid = await _upload(client, user, "Shared.pdf", _pdf("v1"))
    rev = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(user))).json()["revision"]
    assert (await _save(client, user, fid, _pdf("mine"), rev)).status_code == 200
    # A second tab still holding the first copy:
    r = await _save(client, user, fid, _pdf("theirs"), rev)
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_only_a_pdf_is_accepted(client, user):
    fid = await _upload(client, user, "Doc.pdf", _pdf("x"))
    rev = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(user))).json()["revision"]
    r = await _save(client, user, fid, b"<html>not a pdf</html>", rev)
    assert r.status_code == 400
    r = await _save(client, user, fid, b"%PDF-1.7 garbage", rev)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_viewers_can_read_editors_can_save(client, db, user):
    fid = await _upload(client, user, "Lease.pdf", _pdf("Tenant: ____"))
    viewer = await _user(db, "viewer")
    editor = await _user(db, "editor")
    stranger = await _user(db, "stranger")
    for who, can_edit in ((viewer, False), (editor, True)):
        # Editor grants are allowed on uploaded PDFs now.
        r = await client.post(f"/api/files/file/{fid}/grants",
                              json={"grantee_user_id": str(who.id), "can_edit": can_edit}, headers=_auth(user))
        assert r.status_code in (200, 201), r.text

    assert (await client.get(f"/api/files/{fid}/pdf", headers=_auth(stranger))).status_code == 404
    info = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(viewer))).json()
    assert info["can_edit"] is False
    assert (await _save(client, viewer, fid, _pdf("Tenant: me"), info["revision"])).status_code == 403
    assert (await client.get(f"/api/files/{fid}/versions", headers=_auth(viewer))).json()["can_edit"] is False

    info = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(editor))).json()
    assert info["can_edit"] is True
    r = await _save(client, editor, fid, _pdf("Tenant: Grace"), info["revision"])
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_version_blobs_survive_the_orphan_sweep(client, db, user):
    from app.files.models import FileVersion
    from app.files.tombstones import _referenced_paths

    fid = await _upload(client, user, "Keep.pdf", _pdf("one"))
    rev = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(user))).json()["revision"]
    saved = (await _save(client, user, fid, _pdf("two"), rev)).json()
    v = await db.get(FileVersion, uuid.UUID(saved["version_id"]))
    assert v.storage_path in await _referenced_paths(db, [v.storage_path])
    # Once the version is gone, so is the reference — the sweep collects it.
    await db.delete(v)
    await db.commit()
    assert v.storage_path not in await _referenced_paths(db, [v.storage_path])


@pytest.mark.asyncio
async def test_a_chat_made_pdf_is_not_edited_here(client, db, user):
    from app.files.models import UserFile

    fid = await _upload(client, user, "Report.pdf", _pdf("x"))
    row = await db.get(UserFile, uuid.UUID(fid))
    row.source_kind = "rendered_pdf"
    await db.commit()
    assert (await client.get(f"/api/files/{fid}/pdf", headers=_auth(user))).status_code == 404
    # Its history is its re-renders' (WP-8.1): bytes, not the PDF editor's.
    assert (await client.get(f"/api/files/{fid}/versions", headers=_auth(user))).json()["kind"] == "blob"


@pytest.mark.asyncio
async def test_saving_counts_toward_the_storage_cap(client, db, user):
    from app.auth.models import User

    fid = await _upload(client, user, "Big.pdf", _pdf("small"))
    owner = await db.get(User, user.id)
    rev = (await client.get(f"/api/files/{fid}/pdf", headers=_auth(user))).json()["revision"]
    from app.files.quota import get_quota

    used = (await get_quota(db, owner)).used_bytes
    owner.storage_cap_bytes = used + 10
    await db.commit()
    r = await _save(client, user, fid, _pdf(*["a much longer page of text " * 20] * 30), rev)
    assert r.status_code == 400 and "storage" in r.json()["detail"]
