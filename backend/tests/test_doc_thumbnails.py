"""Files polish: a Doc gets a picture of its first page in the Files grid
(made on the worker, made again when it changes), and an Office file gets
page one of the converter's PDF; until then the grid shows the icon."""
from __future__ import annotations

import io

import pytest
from sqlalchemy import text

from tests.test_drive_index_wp51 import _auth, _upload, client  # noqa: F401 — fixtures


def _pdf() -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(72, 720, "Quarterly plan")
    c.showPage()
    c.save()
    return buf.getvalue()


@pytest.mark.asyncio
async def test_a_doc_and_an_office_file_get_first_page_thumbnails(client, db, user, monkeypatch):
    from PIL import Image

    from app.files import convert, doc_thumbs
    from app.files.models import UserFile
    from app.files.storage import absolute_path

    r = await client.post("/api/files/office", json={"kind": "document", "title": "Plan"}, headers=_auth(user))
    doc_id = r.json()["id"]
    row = await db.get(UserFile, doc_id)
    path = absolute_path(row.storage_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("<h1>Quarterly plan</h1><p>Hire two engineers.</p>", "utf-8")

    # Not made yet: the icon (and a job asked for).
    assert (await client.get(f"/api/files/{doc_id}/thumbnail", headers=_auth(user))).status_code == 415
    assert await doc_thumbs.make(doc_id)
    got = await client.get(f"/api/files/{doc_id}/thumbnail", headers=_auth(user))
    assert got.status_code == 200 and got.headers["content-type"] == "image/jpeg"
    img = Image.open(io.BytesIO(got.content))
    assert img.width == 320 and img.height > img.width  # a portrait page

    # Edited: the old picture isn't served for the new version.
    await db.execute(text("UPDATE files SET modified_at = now() + interval '1 minute' WHERE id = :f"), {"f": doc_id})
    await db.commit()
    assert (await client.get(f"/api/files/{doc_id}/thumbnail", headers=_auth(user))).status_code == 415

    # An Office file: page one of the converter's PDF.
    monkeypatch.setenv("CONVERT_URL", "http://convert.test:3000")

    async def fake_post(path, filename):
        return _pdf()

    monkeypatch.setattr(convert, "_post", fake_post)

    async def enqueue(file_id):
        await convert.convert(file_id)

    monkeypatch.setattr("app.tasks.queue.enqueue_office_convert", enqueue)
    f = await _upload(client, user, "notes.rtf", b"{\\rtf1 Hello}", mime="application/rtf")
    got = await client.get(f"/api/files/{f['id']}/thumbnail", headers=_auth(user))
    assert got.status_code == 200 and got.headers["content-type"] == "image/jpeg"
