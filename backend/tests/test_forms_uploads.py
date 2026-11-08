"""Files people send with their answers (Forms WP-F1.6).

Who may send what (the allowlist intersection; people without an account
only on link forms that allow it, only pictures and PDFs), the checks every
upload gets (type by magic bytes, size, a day's allowance, the owner's
storage), location stripped, hidden from Drive / search / the Drive index,
served only by signed links to people who can see the answers, files
claimed by the page that staged them, and cleaned up when answers are
changed or deleted or never sent.
"""
from __future__ import annotations

import io
import subprocess
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from PIL import Image


# ------------------------------------------------------------------ helpers
@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app
    from app.tasks import events, queue

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(events, "emit_user_event", lambda **kw: None)
    queued: list = []

    async def media(fid):
        queued.append(fid)

    monkeypatch.setattr(queue, "enqueue_media", media)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            c.queued = queued  # type: ignore[attr-defined]
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    async def fake(**kw):
        return None

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name, role="user"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def q(iid, kind, required=False, **config):
    return {"id": iid, "kind": kind, "title": iid, "description": "", "image_asset_id": None,
            "required": required, "config": config, "deleted": False}


def defn(items):
    return {"version": 1, "title": "Receipts", "description": "", "after": "continue",
            "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
            "items": items}


RECEIPTS = defn([
    q("name", "short_text", required=True),
    q("receipt", "file_upload", required=True, kinds=["images", "pdf", "documents"], max_files=2, max_size_mb=1),
])


class F:
    def __init__(self, fid, form_id, token):
        self.fid, self.form_id, self.token = fid, form_id, token


async def make_form(client, owner, definition=RECEIPTS, **settings) -> F:
    r = await client.post("/api/forms", json={}, headers=H(owner))
    assert r.status_code == 201, r.text
    fid = r.json()["file"]["id"]
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": definition, "data_version": 1},
                         headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True, **settings}, headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/forms/{fid}/link", json={}, headers=H(owner))
    view = r.json()
    return F(fid, uuid.UUID(view["form"]["id"]), view["link"]["token"])


def jpeg_with_gps() -> bytes:
    im = Image.new("RGB", (64, 48), (200, 10, 10))
    ex = Image.Exif()
    ex[0x010F] = "Canon"
    ex[0x8825] = {1: "S", 2: (27.0, 28.0, 0.0), 3: "E", 4: (153.0, 1.0, 0.0)}
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=ex.tobytes(), quality=90)
    return buf.getvalue()


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (20, 20), "blue").save(buf, "PNG")
    return buf.getvalue()


PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
KEY = "k" * 32


async def put_file(client, f: F, name, raw, mime, *, who=None, question="receipt", key=KEY):
    return await client.post(
        f"/api/f/{f.token}/uploads",
        files={"file": (name, raw, mime)},
        data={"question_id": question, "draft_key": key},
        headers=H(who) if who else {},
    )


def started(form_id) -> str:
    from app.forms import abuse

    return abuse.start_token(form_id, now=time.time() - 30)


async def send(client, f: F, answers, *, who=None, key=KEY, **extra):
    body = {"answers": answers, "submit_id": str(uuid.uuid4()), "start_token": started(f.form_id),
            "draft_key": key, **extra}
    return await client.post(f"/api/f/{f.token}/submit", json=body, headers=H(who) if who else {})


async def rows(db, model, *where):
    from sqlalchemy import select

    return (await db.execute(select(model).where(*where).execution_options(populate_existing=True))).scalars().all()


# ------------------------------------------------------------------ the rules
def test_allowlist_intersection():
    from app.files.safety import _ALLOWED_EXTS
    from app.forms import answering as ans
    from app.forms.uploads import GROUP_EXTS, allowed_exts

    every = allowed_exts(list(GROUP_EXTS))
    assert every <= set(_ALLOWED_EXTS)
    assert not {".html", ".htm", ".svg", ".exe", ".js"} & every
    assert allowed_exts(["images"]) >= {".jpg", ".png", ".heic"} and ".pdf" not in allowed_exts(["images"])
    item = q("f", "file_upload", kinds=["images", "documents", "pdf"])
    assert ans.file_kinds(item, "all") == ["images", "documents", "pdf"]
    assert ans.file_kinds(item, "link") == ["images", "pdf"]
    assert ans.file_kinds(item, "none") == []
    # A question only for documents isn't on a stranger's page at all.
    docs = q("d", "file_upload", kinds=["documents"])
    assert not ans.answerable(docs, "link") and ans.answerable(docs, "all")


async def test_who_sees_file_questions(client, db, user):
    f = await make_form(client, user, audience="link")
    # A link form with files off: strangers aren't asked.
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert [i["id"] for i in page["definition"]["items"]] == ["name"]
    assert page["uploads"]["mode"] == "none"
    r = await put_file(client, f, "a.png", png(), "image/png")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "no_files"
    # …but someone signed in is, with every kind the question takes.
    member = await mk_user(db, "mem")
    page = (await client.get(f"/api/f/{f.token}", headers=H(member))).json()
    item = next(i for i in page["definition"]["items"] if i["id"] == "receipt")
    assert item["config"]["kinds"] == ["images", "pdf", "documents"]
    # Switched on: strangers get pictures and PDFs only.
    await client.patch(f"/api/forms/{f.fid}/settings", json={"allow_uploads_from_link": True}, headers=H(user))
    page = (await client.get(f"/api/f/{f.token}")).json()
    item = next(i for i in page["definition"]["items"] if i["id"] == "receipt")
    assert item["config"]["kinds"] == ["images", "pdf"]
    assert page["uploads"]["mode"] == "link"
    accept = page["uploads"]["accept"]["receipt"]
    assert ".pdf" in accept and "image/*" in accept and ".docx" not in accept


async def test_types_size_and_magic_bytes(client, db, user):
    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    # A document isn't for strangers, even though the question takes them.
    r = await put_file(client, f, "notes.txt", b"hello there", "text/plain")
    assert r.status_code == 415 and "pictures or PDFs" in r.json()["detail"]["message"]
    # Never a web page.
    r = await put_file(client, f, "x.html", b"<script>alert(1)</script>", "text/html")
    assert r.status_code == 415
    # The name says PNG; the bytes are a PDF.
    r = await put_file(client, f, "photo.png", PDF, "image/png")
    assert r.status_code == 415 and "isn't what its name says" in r.json()["detail"]["message"]
    # Over the question's 1 MB.
    big = Image.new("RGB", (1200, 1200))
    buf = io.BytesIO()
    big.save(buf, "BMP")
    assert len(buf.getvalue()) > 1024 * 1024
    r = await put_file(client, f, "big.bmp", buf.getvalue(), "image/bmp")
    assert r.status_code == 413 and "1 MB" in r.json()["detail"]["message"]
    # A PDF and a picture are fine.
    r = await put_file(client, f, "receipt.pdf", PDF, "application/pdf")
    assert r.status_code == 201, r.text
    assert r.json()["image"] is False
    r = await put_file(client, f, "photo.png", png(), "image/png")
    assert r.status_code == 201 and r.json()["image"] is True
    # Two at most for this question.
    r = await put_file(client, f, "third.png", png(), "image/png")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "too_many"
    # A signed-in person may send a document.
    member = await mk_user(db, "mem")
    r = await put_file(client, f, "notes.txt", b"hello there", "text/plain", who=member, key="m" * 32)
    assert r.status_code == 201, r.text


async def test_location_stripped_and_hidden_everywhere(client, db, user):
    from app.files.generated_kinds import GeneratedKind
    from app.files.models import UserFile
    from app.files.quota import get_quota
    from app.files.storage import absolute_path
    from app.forms.models import FormResponse, FormUpload

    before = (await get_quota(db, user)).used_bytes
    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    raw = jpeg_with_gps()
    assert "GPS" in subprocess.run(["exiftool", "-s", "-G", "-"], input=raw, capture_output=True).stdout.decode()
    r = await put_file(client, f, "IMG_0001.JPG", raw, "image/jpeg")
    assert r.status_code == 201, r.text
    up_id = r.json()["id"]
    [up] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(up_id))
    row = await db.get(UserFile, up.file_id)
    stored = absolute_path(row.storage_path).read_bytes()
    tags = subprocess.run(["exiftool", "-s", "-G", "-"], input=stored, capture_output=True).stdout.decode()
    assert "GPS" not in tags and "Canon" not in tags
    # Hidden, owned by the form's owner, counted on their storage.
    assert row.source_kind == GeneratedKind.FORM_UPLOAD.value and row.user_id == user.id and row.folder_id is None
    assert row.content_text is None
    assert (await get_quota(db, user)).used_bytes >= before + row.size_bytes
    assert client.queued == [row.id]  # a tile, from the media worker

    r = await send(client, f, {"name": "Sam", "receipt": [up_id]})
    assert r.status_code == 200, r.text
    [resp] = await rows(db, FormResponse, FormResponse.form_id == f.form_id)
    assert resp.answers["receipt"] == [{"id": up_id, "name": "IMG_0001.JPG"}]
    [up] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(up_id))
    assert up.response_id == resp.id and up.draft_key_hash is None

    # Not in Drive, Recent, search or the Drive index.
    r = await client.get("/api/files/browse?scope=mine", headers=H(user))
    assert all(x["id"] != str(row.id) for x in r.json()["files"])
    r = await client.get("/api/files/search?q=IMG_0001", headers=H(user))
    hits = r.json()
    found = hits if isinstance(hits, list) else hits.get("files", hits.get("results", []))
    assert all(str(row.id) != x.get("id") for x in found)
    from app.files.drive_index import INDEXABLE_KINDS

    assert row.source_kind not in INDEXABLE_KINDS
    # The shell's search text never has the file's name either.
    shell = await db.get(UserFile, uuid.UUID(f.fid))
    assert "IMG_0001" not in (shell.content_text or "")


async def test_claims_only_your_own_staged_files(client, db, user):
    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    up = (await put_file(client, f, "a.png", png(), "image/png", key="a" * 32)).json()
    # Another page (another draft key) can't send it.
    r = await send(client, f, {"name": "x", "receipt": [up["id"]]}, key="b" * 32)
    assert r.status_code == 422 and r.json()["detail"]["question_id"] == "receipt"
    # Nor can it be sent to another question.
    two = defn([q("name", "short_text"), q("receipt", "file_upload", kinds=["images"], max_files=1, max_size_mb=5),
                q("other", "file_upload", kinds=["images"], max_files=1, max_size_mb=5)])
    g = await make_form(client, user, two, audience="link", allow_uploads_from_link=True)
    up2 = (await put_file(client, g, "a.png", png(), "image/png")).json()
    r = await send(client, g, {"name": "x", "other": [up2["id"]]})
    assert r.status_code == 422 and r.json()["detail"]["question_id"] == "other"
    # A made-up id.
    r = await send(client, f, {"name": "x", "receipt": [str(uuid.uuid4())]}, key="a" * 32)
    assert r.status_code == 422
    # The right page: fine.
    r = await send(client, f, {"name": "x", "receipt": [up["id"]]}, key="a" * 32)
    assert r.status_code == 200, r.text


async def test_take_back_a_file(client, db, user):
    from app.files.models import UserFile
    from app.forms.models import FormUpload

    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    up = (await put_file(client, f, "a.png", png(), "image/png")).json()
    [row] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(up["id"]))
    file_id = row.file_id
    r = await client.delete(f"/api/f/{f.token}/uploads/{up['id']}?draft_key={'z' * 32}")
    assert r.status_code == 404
    r = await client.delete(f"/api/f/{f.token}/uploads/{up['id']}?draft_key={KEY}")
    assert r.status_code == 204
    assert await rows(db, FormUpload, FormUpload.id == uuid.UUID(up["id"])) == []
    assert await db.get(UserFile, file_id, populate_existing=True) is None


async def test_daily_allowance_and_full_storage(client, db, user):
    from app.auth.models import User

    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    r = await client.patch("/api/admin/forms/settings", json={"link_upload_cap_mb": 1}, headers=H(user))
    assert r.status_code == 200 and r.json()["link_upload_cap_mb"] == 1
    big = Image.new("RGB", (900, 600))
    buf = io.BytesIO()
    big.save(buf, "BMP")  # ~1.6 MB raw — over the day's 1 MB
    two = defn([q("name", "short_text"),
                q("receipt", "file_upload", kinds=["images"], max_files=3, max_size_mb=5)])
    g = await make_form(client, user, two, audience="link", allow_uploads_from_link=True)
    r = await put_file(client, g, "big.bmp", buf.getvalue(), "image/bmp")
    assert r.status_code == 429 and r.json()["detail"]["code"] == "daily_full"
    await client.patch("/api/admin/forms/settings", json={"link_upload_cap_mb": 100}, headers=H(user))

    # The owner's storage is full: no files, but text answers still go in.
    owner = await db.get(User, user.id)
    owner.storage_cap_bytes = 1
    await db.commit()
    r = await put_file(client, f, "a.png", png(), "image/png")
    assert r.status_code == 507 and r.json()["detail"]["message"] == "This form can't take files right now."
    opt = defn([q("name", "short_text", required=True),
                q("receipt", "file_upload", kinds=["images"], max_files=1, max_size_mb=5)])
    h = await make_form(client, user, opt, audience="link", allow_uploads_from_link=True)
    r = await send(client, h, {"name": "Text only"})
    assert r.status_code == 200, r.text


async def test_responses_show_files_by_signed_links(client, db, user):
    from app.files.models import UserFile

    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    up = (await put_file(client, f, "receipt.pdf", PDF, "application/pdf")).json()
    assert (await send(client, f, {"name": "Sam", "receipt": [up["id"]]})).status_code == 200

    summary = (await client.get(f"/api/forms/{f.fid}/summary", headers=H(user))).json()
    block = next(b for b in summary["questions"] if b["id"] == "receipt")
    [card] = block["files"]
    assert card["name"] == "receipt.pdf" and card["number"] == 1 and card["outside"] is True
    assert card["url"].startswith("/m/") and card["thumb"] is None
    one = (await client.get(f"/api/forms/{f.fid}/responses/1", headers=H(user))).json()
    item = next(a for a in one["answers"] if a["id"] == "receipt")
    assert item["files"][0]["id"] == up["id"] and item["text"] == "receipt.pdf"
    qa = (await client.get(f"/api/forms/{f.fid}/responses?question=receipt", headers=H(user))).json()
    assert qa["items"][0]["files"][0]["url"]

    # A download in a sandbox, never shown as a page.
    r = await client.get("/api" + card["url"])
    assert r.status_code == 200 and r.content == PDF
    assert "attachment" in r.headers["content-disposition"]
    assert "sandbox" in r.headers["content-security-policy"] and r.headers["x-content-type-options"] == "nosniff"

    # Someone without access to the form: a link signed for them is a 404.
    from app.files import media_urls
    from app.forms.models import FormUpload

    stranger = await mk_user(db, "nosy")
    [row] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(up["id"]))
    theirs = media_urls.sign(row.file_id, stranger.id, stranger.token_version, "form_upload", 1)
    assert (await client.get("/api" + theirs)).status_code == 404
    # A read grant on the form opens it.
    r = await client.post(f"/api/files/file/{f.fid}/grants",
                          json={"grantee_user_id": str(stranger.id), "can_edit": False}, headers=H(user))
    assert r.status_code < 300, r.text
    assert (await client.get("/api" + theirs)).status_code == 200
    # In the trash: dead for everyone.
    shell = await db.get(UserFile, uuid.UUID(f.fid))
    shell.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    assert (await client.get("/api" + card["url"])).status_code == 404


async def test_changing_and_deleting_answers_cleans_up_files(client, db, user):
    from app.files.models import BlobTombstone, UserFile
    from app.forms.models import FormUpload

    member = await mk_user(db, "mum")
    f = await make_form(client, user, allow_edit=True)  # people on this server
    a = (await put_file(client, f, "a.png", png(), "image/png", who=member)).json()
    b = (await put_file(client, f, "b.pdf", PDF, "application/pdf", who=member)).json()
    r = await send(client, f, {"name": "Mum", "receipt": [a["id"], b["id"]]}, who=member)
    assert r.status_code == 200, r.text
    [up_a] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(a["id"]))
    [up_b] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(b["id"]))
    file_a, file_b = up_a.file_id, up_b.file_id

    # Changing the answer: keeps a, drops b, adds c.
    mine = (await client.get(f"/api/f/{f.token}/mine", headers=H(member))).json()
    assert mine["answers"]["receipt"] == [a["id"], b["id"]] and mine["files"][a["id"]]["name"] == "a.png"
    c = (await put_file(client, f, "c.png", png(), "image/png", who=member, key="c" * 32)).json()
    r = await client.put(f"/api/f/{f.token}/mine", headers=H(member), json={
        "answers": {"name": "Mum", "receipt": [a["id"], c["id"]]}, "start_token": started(f.form_id),
        "draft_key": "c" * 32})
    assert r.status_code == 200, r.text
    assert await db.get(UserFile, file_b, populate_existing=True) is None
    assert await db.get(UserFile, file_a, populate_existing=True) is not None
    tomb = await rows(db, BlobTombstone, BlobTombstone.reason == "form_upload")
    assert tomb

    # Deleting the answer deletes its files.
    r = await client.delete(f"/api/forms/{f.fid}/responses/1", headers=H(user))
    assert r.status_code == 200
    assert await rows(db, FormUpload, FormUpload.form_id == f.form_id) == []
    assert await db.get(UserFile, file_a, populate_existing=True) is None

    # Delete all, too.
    d = (await put_file(client, f, "d.png", png(), "image/png", who=member, key="d" * 32)).json()
    member2 = await mk_user(db, "dad")
    assert (await send(client, f, {"name": "Mum", "receipt": [d["id"]]}, who=member, key="d" * 32)).status_code == 200
    e = (await put_file(client, f, "e.png", png(), "image/png", who=member2, key="e" * 32)).json()
    assert (await send(client, f, {"name": "Dad", "receipt": [e["id"]]}, who=member2, key="e" * 32)).status_code == 200
    r = await client.delete(f"/api/forms/{f.fid}/responses", headers=H(user))
    assert r.status_code == 200 and r.json()["deleted"] == 2
    assert await rows(db, FormUpload, FormUpload.form_id == f.form_id) == []


async def test_unsent_files_are_swept(client, db, user):
    from app.files.models import UserFile
    from app.forms.models import FormUpload
    from app.forms.uploads import sweep

    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    old = (await put_file(client, f, "old.png", png(), "image/png")).json()
    new = (await put_file(client, f, "new.png", png(), "image/png", key="n" * 32)).json()
    [row] = await rows(db, FormUpload, FormUpload.id == uuid.UUID(old["id"]))
    row.created_at = datetime.now(timezone.utc) - timedelta(hours=25)
    file_id = row.file_id
    await db.commit()
    assert await sweep(db) == 1
    assert await rows(db, FormUpload, FormUpload.id == uuid.UUID(old["id"])) == []
    assert await db.get(UserFile, file_id, populate_existing=True) is None
    assert await rows(db, FormUpload, FormUpload.id == uuid.UUID(new["id"]))


async def test_save_to_files_copies_into_drive(client, db, user):
    f = await make_form(client, user, audience="link", allow_uploads_from_link=True)
    up = (await put_file(client, f, "receipt.png", png(), "image/png")).json()
    assert (await send(client, f, {"name": "Sam", "receipt": [up["id"]]})).status_code == 200
    r = await client.post(f"/api/forms/{f.fid}/uploads/{up['id']}/save", headers=H(user))
    assert r.status_code == 201, r.text
    saved = r.json()["file"]
    assert saved["filename"].startswith("receipt") and saved["id"] != up["id"]
    listing = await client.get(f"/api/files/browse?scope=mine&folder_id={saved['folder_id']}", headers=H(user))
    assert any(x["id"] == saved["id"] for x in listing.json()["files"])
    # Someone who can't see the answers can't.
    nosy = await mk_user(db, "nosy")
    r = await client.post(f"/api/forms/{f.fid}/uploads/{up['id']}/save", headers=H(nosy))
    assert r.status_code == 404


def test_sheet_cells_list_each_file_with_a_link():
    from types import SimpleNamespace

    from app.forms.sheet import file_link, row_values

    r = SimpleNamespace(number=3, submitted_at=None, edited_at=None, email=None, respondent_id=None,
                        answers={"name": "=1+1", "receipt": [{"id": "u1", "name": "a.png"}, {"id": "u2", "name": "b.pdf"}]})
    vals = row_values(RECEIPTS, r, link=lambda n, uid: file_link("https://p.example", "FID", n, uid))
    assert vals["q:receipt"] == (
        "a.png — https://p.example/files/form/FID?tab=responses&answer=3&file=u1\n"
        "b.pdf — https://p.example/files/form/FID?tab=responses&answer=3&file=u2"
    )
    # Without links (exports): the names.
    assert row_values(RECEIPTS, r)["q:receipt"] == "a.png\nb.pdf"
