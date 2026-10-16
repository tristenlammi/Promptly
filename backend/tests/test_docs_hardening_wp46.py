"""Documents hardening (WP-4.6): stable asset references with short-lived
links (R-228), Markdown import with images (R-229), mention identity and
notifications (R-232), and a calmer snapshot → re-index path (R-233)."""
from __future__ import annotations

import base64
import io
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest


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


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


async def _doc_with_image(client, user, title="Report"):
    """A document whose content holds one uploaded picture (by path)."""
    from pycrdt import Doc, XmlElement, XmlFragment, XmlText

    r = await client.post("/api/files/office", json={"kind": "document", "title": title}, headers=_auth(user))
    doc_id = r.json()["id"]
    r = await client.post(f"/api/documents/{doc_id}/assets", files={"file": ("dot.png", _png(), "image/png")},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    asset = r.json()
    d = Doc()
    frag = d.get("default", type=XmlFragment)
    frag.children.append(XmlElement("paragraph", {}, [XmlText("See the picture")]))
    frag.children.append(XmlElement("image", {"src": asset["url"]}))
    r = await client.post(f"/api/documents/{doc_id}/initial-state",
                          json={"yjs_state": base64.b64encode(d.get_update()).decode()}, headers=_auth(user))
    assert r.status_code == 200, r.text
    return doc_id, asset


# ---------------------------------------------------------------- R-228


@pytest.mark.asyncio
async def test_documents_store_paths_and_readers_get_short_lived_links(client, db, user):
    doc_id, asset = await _doc_with_image(client, user)
    # The document holds a path — no credential in it.
    assert asset["url"] == f"/api/documents/{doc_id}/assets/{asset['id']}"
    assert "sig=" in asset["display_url"] and "exp=" in asset["display_url"]
    assert (await client.get(asset["display_url"])).status_code == 200
    # The bare path is no key.
    assert (await client.get(asset["url"])).status_code in (404, 422)

    # A reader asks for links; a stranger gets none.
    r = await client.post("/api/documents/asset-links", json={"urls": [asset["url"], asset["url"] + "?sig=old"]},
                          headers=_auth(user))
    links = r.json()["links"]
    assert set(links) == {asset["url"], asset["url"] + "?sig=old"}
    assert (await client.get(links[asset["url"]])).status_code == 200
    stranger = await _user(db, "sam")
    r = await client.post("/api/documents/asset-links", json={"urls": [asset["url"]]}, headers=_auth(stranger))
    assert r.json()["links"] == {}


def test_links_expire_and_old_links_still_verify():
    from app.files import doc_assets

    doc, asset = uuid.uuid4(), uuid.uuid4()
    url = doc_assets.signed_url(doc, asset)
    q = dict(p.split("=") for p in url.split("?")[1].split("&"))
    assert doc_assets.verify(doc, asset, q["sig"], int(q["exp"]))
    assert not doc_assets.verify(doc, asset, q["sig"], int(q["exp"]) + 1)  # tampered expiry
    past = int(time.time()) - 10
    assert not doc_assets.verify(doc, asset, doc_assets._sig(asset, doc, past), past)  # expired
    assert doc_assets.verify(doc, asset, doc_assets._legacy_sig(asset, doc), None)  # pre-R-228 link


@pytest.mark.asyncio
async def test_a_shared_document_gets_fresh_links_and_an_export_inlines_its_pictures(client, db, user):
    doc_id, asset = await _doc_with_image(client, user)
    r = await client.post(f"/api/files/{doc_id}/share-links", json={}, headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    token = r.json()["token"]
    html = (await client.get(f"/api/s/{token}/download")).text
    assert f"/api/documents/{doc_id}/assets/{asset['id']}?exp=" in html
    # Export (HTML) carries the picture inline.
    r = await client.get(f"/api/documents/{doc_id}/download", params={"format": "html"}, headers=_auth(user))
    assert 'src="data:image/png;base64,' in r.text


@pytest.mark.asyncio
async def test_a_copy_gets_its_own_pictures(client, db, user):
    from app.files.models import DocumentState, UserFile
    from app.files.document_render import render_html_from_update

    doc_id, asset = await _doc_with_image(client, user)
    r = await client.post("/api/files/office", json={"template_id": doc_id, "title": "Copy"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    copy_id = uuid.UUID(r.json()["id"])
    state = await db.get(DocumentState, copy_id, populate_existing=True)
    html = render_html_from_update(bytes(state.yjs_update))
    assert f"/api/documents/{copy_id}/assets/" in html and asset["id"] not in html
    new_asset_id = html.split(f"/api/documents/{copy_id}/assets/")[1][:36]
    copy_asset = await db.get(UserFile, uuid.UUID(new_asset_id))
    assert copy_asset.source_file_id == copy_id and copy_asset.user_id == user.id


@pytest.mark.asyncio
async def test_pictures_deleted_from_a_document_are_swept_after_a_week(client, db, user):
    from sqlalchemy import update

    from app.files.models import UserFile
    from app.files.purge import purge_unreferenced_document_assets

    doc_id, used = await _doc_with_image(client, user)
    r = await client.post(f"/api/documents/{doc_id}/assets", files={"file": ("old.png", _png(), "image/png")},
                          headers=_auth(user))
    unused = r.json()
    week_ago = datetime.now(timezone.utc) - timedelta(days=8)
    await db.execute(update(UserFile).where(UserFile.id.in_([uuid.UUID(used["id"]), uuid.UUID(unused["id"])]))
                     .values(created_at=week_ago))
    await db.commit()
    assert await purge_unreferenced_document_assets(db) == 1
    await db.commit()
    assert await db.get(UserFile, uuid.UUID(used["id"]), populate_existing=True) is not None
    gone = await db.get(UserFile, uuid.UUID(unused["id"]), populate_existing=True)
    assert gone is None or gone.trashed_at is not None


# ---------------------------------------------------------------- R-229


@pytest.mark.asyncio
async def test_a_markdown_file_opens_as_a_document(client, db, user):
    md = b"# Plan\n\n| Who | When |\n|---|---|\n| Ann | Mon |\n\n- [ ] book room\n\n![Logo](https://example.com/logo.png)\n"
    r = await client.post("/api/files/", files={"file": ("plan.md", md, "text/markdown")}, data={"scope": "mine"},
                          headers=_auth(user))
    assert r.status_code in (200, 201), r.text
    r = await client.post("/api/documents/import", json={"source_file_id": r.json()["id"]}, headers=_auth(user))
    assert r.status_code == 201, r.text
    doc = r.json()
    html = (await client.get(f"/api/documents/{doc['id']}/download", params={"format": "fragment"},
                             headers=_auth(user))).text
    assert "<h1>Plan</h1>" in html and "<td><p>Ann</p></td>" in html
    assert 'data-type="taskItem"' in html and 'src="https://example.com/logo.png"' in html


# ---------------------------------------------------------------- R-232


@pytest.mark.asyncio
async def test_a_mention_tells_the_person_once(client, db, user, monkeypatch):
    import app.notifications as notifications
    from app.files import doc_comments_router

    sent: list[dict] = []

    async def fake(**kw):
        sent.append(kw)

    monkeypatch.setattr(notifications, "notify_user", fake)
    monkeypatch.setattr(doc_comments_router, "_RECENT_MENTIONS", {})
    r = await client.post("/api/files/office", json={"kind": "document", "title": "Minutes"}, headers=_auth(user))
    doc = r.json()["id"]
    pal, stranger = await _user(db, "pal"), await _user(db, "nope")
    await client.post(f"/api/files/file/{doc}/grants", json={"grantee_user_id": str(pal.id), "can_edit": False},
                      headers=_auth(user))
    for _ in range(2):
        r = await client.post(f"/api/documents/{doc}/mentions", json={"user_id": str(pal.id)}, headers=_auth(user))
        assert r.status_code == 204
    await client.post(f"/api/documents/{doc}/mentions", json={"user_id": str(stranger.id)}, headers=_auth(user))
    assert [s["user_id"] for s in sent] == [pal.id]
    assert "mentioned you" in sent[0]["title"] and sent[0]["url"] == f"/files/doc/{doc}"


def test_a_mention_keeps_who_it_is():
    from pycrdt import Doc, XmlElement, XmlFragment, XmlText

    from app.files.document_render import render_html_from_update

    uid = str(uuid.uuid4())
    d = Doc()
    frag = d.get("default", type=XmlFragment)
    p = XmlElement("paragraph")
    frag.children.append(p)
    t = XmlText()
    p.children.append(t)
    t.insert(0, "@ann", attrs={"mention": {"userId": uid}})
    html = render_html_from_update(d.get_update())
    assert f'<span class="doc-mention" data-type="mention" data-user-id="{uid}">@ann</span>' in html


# ---------------------------------------------------------------- R-233


@pytest.mark.asyncio
async def test_snapshots_reindex_a_note_once_after_typing_pauses(client, db, user, monkeypatch):
    from app.workspaces import reindex

    calls: list[tuple] = []
    monkeypatch.setattr(reindex, "schedule", lambda fn, ws, item, delay=None: calls.append((fn.__name__, delay)))
    r = await client.post("/api/workspaces", json={"title": "Team"}, headers=_auth(user))
    ws = r.json()["id"]
    r = await client.post(f"/api/workspaces/{ws}/items", json={"kind": "note", "title": "Log"}, headers=_auth(user))
    doc = r.json()["ref_id"]
    from pycrdt import Doc, XmlElement, XmlFragment, XmlText

    d = Doc()
    d.get("default", type=XmlFragment).children.append(XmlElement("paragraph", {}, [XmlText("typing")]))
    from app.files import documents_router

    monkeypatch.setattr(documents_router, "_verify_collab_internal_caller", lambda authorization: None)
    for _ in range(3):
        r = await client.post(f"/api/internal/documents/{doc}/snapshot", content=d.get_update(),
                              headers={"content-type": "application/octet-stream"})
        assert r.status_code == 204, r.text
    assert calls == [("index_note_for_workspace", reindex.NOTE_DEBOUNCE_SECONDS)] * 3
