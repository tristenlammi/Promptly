"""Forms are files (WP-F1.1): made from Files (blank or from a template),
saved with the version guard, copied, trashed (which closes them),
restored closed, downloaded as a zip and purged with their answers."""
from __future__ import annotations

import io
import json
import os
import uuid
import zipfile

import httpx
import pytest


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

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def _new_form(client, user, **extra):
    r = await client.post("/api/files/office", json={"kind": "form", **extra}, headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()


async def _form(db, file_id):
    from sqlalchemy import select

    from app.forms.models import Form

    return (
        await db.execute(
            select(Form).where(Form.file_id == uuid.UUID(str(file_id))).execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def _answer(db, form, answers, *, number=None, respondent=None):
    """An answer as the answer side (WP-F1.3) will store it."""
    from app.forms.models import FormResponse

    n = number or form.next_number
    db.add(FormResponse(form_id=form.id, number=n, source="server", answers=answers, submit_id=uuid.uuid4(),
                        respondent_id=respondent))
    form.next_number = n + 1
    form.response_count = (form.response_count or 0) + 1
    await db.commit()


# ---------------------------------------------------------------- create + get


@pytest.mark.asyncio
async def test_new_blank_form_from_files(client, db, user):
    r = await client.post("/api/files/folders", json={"scope": "mine", "name": "Events"}, headers=_auth(user))
    folder_id = r.json()["id"]
    f = await _new_form(client, user, folder_id=folder_id)
    assert f["filename"] == "Untitled form.form"
    assert f["source_kind"] == "form" and f["folder_id"] == folder_id
    assert f["mime_type"] == "application/vnd.promptly.form+json"

    r = await client.get(f"/api/forms/{f['id']}", headers=_auth(user))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access"] == "edit" and body["is_owner"]
    form = body["form"]
    assert form["definition"]["title"] == "Untitled form" and form["definition"]["items"] == []
    assert form["data_version"] == 1
    # New forms are for people on this server, and take answers once sent.
    assert form["settings"]["audience"] == "server" and form["settings"]["accepting"] is True
    assert form["state"] == "open"
    assert body["link"] is None and body["link_answers_allowed"] is True

    # It's listed in Files like any file, and opens in the form editor.
    r = await client.get(f"/api/files/{f['id']}/office", headers=_auth(user))
    assert r.status_code == 200 and r.json()["kind"] == "form"
    r = await client.get(f"/api/files/browse?scope=mine&folder_id={folder_id}", headers=_auth(user))
    assert any(x["id"] == f["id"] for x in r.json()["files"])


@pytest.mark.asyncio
async def test_built_in_templates(client, db, user):
    r = await client.get("/api/forms/templates", headers=_auth(user))
    assert r.status_code == 200
    keys = [t["key"] for t in r.json()["built_in"]]
    assert keys == ["rsvp", "signup", "feedback", "contact", "registration", "order"]
    for key in keys:
        f = await _new_form(client, user, form_template=key)
        form = await _form(db, f["id"])
        assert form.definition["items"], key
    # The RSVP lets people change their answer; the sign-up sheet has limits.
    rsvp = await _new_form(client, user, form_template="rsvp", title="BBQ on Saturday")
    assert rsvp["filename"] == "BBQ on Saturday.form"
    form = await _form(db, rsvp["id"])
    assert form.allow_edit and form.one_per_person and form.audience == "server"
    signup = await _form(db, (await _new_form(client, user, form_template="signup"))["id"])
    bring = next(i for i in signup.definition["items"] if i["id"] == "bring")
    assert [o.get("limit") for o in bring["config"]["options"]] == [2, 2, 3, 1]
    r = await client.post("/api/files/office", json={"kind": "form", "form_template": "nope"}, headers=_auth(user))
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_shell_search_text_has_questions_never_answers(client, db, user):
    from app.files.models import UserFile

    f = await _new_form(client, user, form_template="rsvp")
    form = await _form(db, f["id"])
    await _answer(db, form, {"name": "Zanzibar Quokka", "coming": "o1"})
    # Saving after answers came in rebuilds the shell's text.
    r = await client.get(f"/api/forms/{f['id']}", headers=_auth(user))
    d = r.json()["form"]
    r = await client.put(f"/api/forms/{f['id']}/definition",
                         json={"definition": d["definition"], "data_version": d["data_version"]}, headers=_auth(user))
    assert r.status_code == 200, r.text
    shell = await db.get(UserFile, uuid.UUID(f["id"]), populate_existing=True)
    assert "Can you come?" in shell.content_text
    assert "Quokka" not in shell.content_text
    r = await client.get("/api/files/search?q=Quokka", headers=_auth(user))
    assert not any(h["file"]["id"] == f["id"] for h in r.json()["hits"])
    r = await client.get("/api/files/search?q=come", headers=_auth(user))
    assert any(h["file"]["id"] == f["id"] for h in r.json()["hits"])


# ---------------------------------------------------------------- save


def _q(id_, kind="short_text", title="Q", **config):
    return {"id": id_, "kind": kind, "title": title, "config": config}


@pytest.mark.asyncio
async def test_save_with_version_guard_and_rename(client, db, user):
    f = await _new_form(client, user)
    url = f"/api/forms/{f['id']}/definition"
    defn = {"title": "Choir sign-up", "items": [_q("a", title="Your name")]}
    r = await client.put(url, json={"definition": defn, "data_version": 1}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.json()["data_version"] == 2
    # The title is the file's name.
    assert r.json()["file"]["filename"] == "Choir sign-up.form"
    # A save from the older version is refused with the newer one.
    r = await client.put(url, json={"definition": {"title": "Mine", "items": []}, "data_version": 1},
                         headers=_auth(user))
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "stale" and detail["data_version"] == 2
    assert detail["definition"]["title"] == "Choir sign-up"

    # Renaming in Files renames the form, and an open builder's stale save conflicts.
    r = await client.patch(f"/api/files/{f['id']}", json={"filename": "Choir"}, headers=_auth(user))
    assert r.status_code == 200 and r.json()["filename"] == "Choir.form"
    form = await _form(db, f["id"])
    assert form.definition["title"] == "Choir" and form.data_version == 3
    r = await client.put(url, json={"definition": defn, "data_version": 2}, headers=_auth(user))
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_save_refuses_a_broken_definition_inline(client, db, user):
    f = await _new_form(client, user)
    url = f"/api/forms/{f['id']}/definition"
    bad = {"title": "x", "items": [_q("a", kind="checkboxes", options=[{"id": "o1", "label": "A"}],
                                        min_selected=3, max_selected=2)]}
    r = await client.put(url, json={"definition": bad, "data_version": 1}, headers=_auth(user))
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["item_id"] == "a" and "at least" in d["message"].lower()
    # Nothing was saved.
    assert (await _form(db, f["id"])).data_version == 1


@pytest.mark.asyncio
async def test_settings(client, db, user):
    from app.app_settings.models import AppSettings

    f = await _new_form(client, user)
    url = f"/api/forms/{f['id']}/settings"
    r = await client.patch(url, json={"audience": "link", "max_responses": 30, "close_at": "2026-12-04T18:00:00+10:00",
                                      "closed_message": "  Thanks, we've got enough helpers!  "},
                           headers=_auth(user))
    assert r.status_code == 200, r.text
    s = r.json()["form"]["settings"]
    assert s["audience"] == "link" and s["max_responses"] == 30
    assert s["closed_message"] == "Thanks, we've got enough helpers!"
    assert s["close_at"].startswith("2026-12-04T08:00:00")
    # Null turns a limit off; unknown fields are refused.
    r = await client.patch(url, json={"max_responses": None}, headers=_auth(user))
    assert r.json()["form"]["settings"]["max_responses"] is None
    assert r.json()["form"]["settings"]["audience"] == "link"
    assert (await client.patch(url, json={"colour": "red"}, headers=_auth(user))).status_code == 422
    assert (await client.patch(url, json={"close_at": "2026-12-04T18:00:00"}, headers=_auth(user))).status_code == 422
    # Closing it.
    r = await client.patch(url, json={"accepting": False}, headers=_auth(user))
    assert r.json()["form"]["state"] == "closed"

    # With the admin switch off, a form can't be opened to people without an account.
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.forms_link_answers = False
    await db.commit()
    g = await _new_form(client, user)
    r = await client.patch(f"/api/forms/{g['id']}/settings", json={"audience": "link"}, headers=_auth(user))
    assert r.status_code == 400 and "admin" in r.json()["detail"]
    r = await client.get(f"/api/forms/{g['id']}", headers=_auth(user))
    assert r.json()["link_answers_allowed"] is False


# ---------------------------------------------------------------- pictures


def _png(color="red", size=(40, 30)):
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_pictures_upload_serve_and_belong_to_the_form(client, db, user):
    from app.files.models import UserFile

    f = await _new_form(client, user)
    r = await client.post(f"/api/forms/{f['id']}/assets", files={"file": ("header.png", _png(), "image/png")},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    asset = r.json()
    row = await db.get(UserFile, uuid.UUID(asset["id"]))
    assert row.source_kind == "form_asset" and str(row.source_file_id) == f["id"] and row.folder_id is None
    # The signed link serves it, with no sign-in; a forged one doesn't.
    r = await client.get(asset["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert (await client.get(asset["url"].replace("sig=", "sig=0"))).status_code == 404

    # Not a picture → refused.
    r = await client.post(f"/api/forms/{f['id']}/assets", files={"file": ("a.txt", b"hello", "text/plain")},
                          headers=_auth(user))
    assert r.status_code == 400
    r = await client.post(f"/api/forms/{f['id']}/assets", files={"file": ("a.png", b"not a png", "image/png")},
                          headers=_auth(user))
    assert r.status_code == 400

    # The definition can use it; another form's picture it can't.
    url = f"/api/forms/{f['id']}/definition"
    defn = {"title": "With a header", "theme": {"header_asset_id": asset["id"]},
            "items": [{"id": "pic", "kind": "image", "image_asset_id": asset["id"]}]}
    r = await client.put(url, json={"definition": defn, "data_version": 1}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert asset["id"] in r.json()["asset_urls"]
    g = await _new_form(client, user)
    r = await client.put(f"/api/forms/{g['id']}/definition", json={"definition": defn, "data_version": 1},
                         headers=_auth(user))
    assert r.status_code == 422 and "picture" in r.json()["detail"]["message"]

    # Never in Drive listings or search.
    r = await client.get("/api/files/browse?scope=mine", headers=_auth(user))
    assert all(x["id"] != asset["id"] for x in r.json()["files"])


# ---------------------------------------------------------------- copy, trash, restore, download, purge


@pytest.mark.asyncio
async def test_make_a_copy_takes_questions_not_answers(client, db, user):
    from app.files.models import UserFile

    f = await _new_form(client, user, form_template="signup")
    pic = (await client.post(f"/api/forms/{f['id']}/assets", files={"file": ("h.png", _png(), "image/png")},
                             headers=_auth(user))).json()
    d = (await client.get(f"/api/forms/{f['id']}", headers=_auth(user))).json()["form"]
    defn = d["definition"]
    defn["theme"]["header_asset_id"] = pic["id"]
    await client.put(f"/api/forms/{f['id']}/definition", json={"definition": defn, "data_version": 1},
                     headers=_auth(user))
    form = await _form(db, f["id"])
    await client.patch(f"/api/forms/{f['id']}/settings", json={"audience": "link", "accepting": False},
                       headers=_auth(user))
    await _answer(db, form, {"name": "Sam", "bring": "o1"})

    r = await client.post(f"/api/files/files/{f['id']}/copy-to-mine", headers=_auth(user))
    assert r.status_code == 201, r.text
    c = r.json()["file"]
    assert c["filename"] == "Sign-up sheet (copy).form" and c["id"] != f["id"]
    copy = await _form(db, c["id"])
    assert copy.response_count == 0 and copy.next_number == 1
    assert copy.audience == "link" and copy.accepting is True  # settings, but a fresh start
    # Its own copy of the picture.
    new_pic = copy.definition["theme"]["header_asset_id"]
    assert new_pic and new_pic != pic["id"]
    row = await db.get(UserFile, uuid.UUID(new_pic))
    assert str(row.source_file_id) == c["id"]
    assert [i["id"] for i in copy.definition["items"]] == [i["id"] for i in form.definition["items"]]

    # Save as template, then a new form from it.
    r = await client.post(f"/api/files/{f['id']}/save-as-template", headers=_auth(user))
    assert r.status_code == 201, r.text
    tpl = r.json()
    r = await client.get("/api/forms/templates", headers=_auth(user))
    assert [t["id"] for t in r.json()["mine"]] == [tpl["id"]]
    made = await _new_form(client, user, template_id=tpl["id"], title="Picnic")
    assert made["filename"] == "Picnic.form"
    assert (await _form(db, made["id"])).definition["items"]


@pytest.mark.asyncio
async def test_trash_closes_restore_stays_closed(client, db, user):
    f = await _new_form(client, user, form_template="rsvp")
    assert (await _form(db, f["id"])).accepting is True
    r = await client.post(f"/api/files/{f['id']}/trash", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert (await _form(db, f["id"])).accepting is False
    # In the trash, nobody can open it — not even the owner.
    assert (await client.get(f"/api/forms/{f['id']}", headers=_auth(user))).status_code == 404
    r = await client.post(f"/api/files/{f['id']}/restore", headers=_auth(user))
    assert r.status_code == 200, r.text
    form = await _form(db, f["id"])
    assert form.accepting is False
    body = (await client.get(f"/api/forms/{f['id']}", headers=_auth(user))).json()
    assert body["form"]["state"] == "closed"
    # Trashed with its folder (the bulk path) closes it too.
    await client.patch(f"/api/forms/{f['id']}/settings", json={"accepting": True}, headers=_auth(user))
    r = await client.post("/api/files/folders", json={"scope": "mine", "name": "Old"}, headers=_auth(user))
    folder = r.json()["id"]
    await client.patch(f"/api/files/{f['id']}", json={"folder_id": folder}, headers=_auth(user))
    r = await client.post("/api/files/bulk/trash", json={"folder_ids": [folder], "file_ids": []}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert (await _form(db, f["id"])).accepting is False


@pytest.mark.asyncio
async def test_download_zip_has_questions_and_safe_answers(client, db, user):
    f = await _new_form(client, user, form_template="signup")
    form = await _form(db, f["id"])
    await _answer(db, form, {"name": "=HYPERLINK(\"http://evil\")", "bring": "o2", "note": "+61 400"})
    await _answer(db, form, {"name": "Mum", "bring": {"other": "Pavlova"}})
    r = await client.get(f"/api/files/{f['id']}/download", headers=_auth(user))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert "Sign-up%20sheet.form.zip" in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["form.json", "responses.csv"]
    assert json.loads(z.read("form.json"))["title"] == "Sign-up sheet"
    csv_text = z.read("responses.csv").decode("utf-8-sig")
    lines = csv_text.splitlines()
    assert lines[0].startswith("Response #,Submitted,Edited,Your name,What will you bring?")
    assert "'=HYPERLINK" in csv_text and ",'+61 400" in csv_text
    assert "Dessert" in lines[1] and "Other: Pavlova" in lines[2]
    # Someone who can't open it can't download it.
    other = await _user(db, "o")
    assert (await client.get(f"/api/files/{f['id']}/download", headers=_auth(other))).status_code == 404


@pytest.mark.asyncio
async def test_purge_deletes_answers_and_pictures(client, db, user):
    from sqlalchemy import func, select

    from app.files.models import UserFile
    from app.forms.models import Form, FormResponse

    f = await _new_form(client, user)
    pic = (await client.post(f"/api/forms/{f['id']}/assets", files={"file": ("h.png", _png(), "image/png")},
                             headers=_auth(user))).json()
    form = await _form(db, f["id"])
    await _answer(db, form, {"x": "y"})
    await client.post(f"/api/files/{f['id']}/trash", headers=_auth(user))
    # Answers are kept while it's in the trash.
    assert await db.scalar(select(func.count()).select_from(FormResponse)) == 1
    r = await client.post("/api/files/bulk/purge", json={"file_ids": [f["id"]]}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert await db.scalar(select(func.count()).select_from(Form)) == 0
    assert await db.scalar(select(func.count()).select_from(FormResponse)) == 0
    assert await db.get(UserFile, uuid.UUID(pic["id"]), populate_existing=True) is None
    assert await db.get(UserFile, uuid.UUID(f["id"]), populate_existing=True) is None


@pytest.mark.asyncio
async def test_quota_counts_definition_answers_and_pictures(client, db, user):
    from app.files.models import UserFile
    from app.files.quota import get_quota

    before = (await get_quota(db, user)).used_bytes
    f = await _new_form(client, user, form_template="registration")
    shell = await db.get(UserFile, uuid.UUID(f["id"]), populate_existing=True)
    assert shell.size_bytes > 500
    form = await _form(db, f["id"])
    await _answer(db, form, {"name": "x" * 4000})
    d = (await client.get(f"/api/forms/{f['id']}", headers=_auth(user))).json()["form"]
    await client.put(f"/api/forms/{f['id']}/definition",
                     json={"definition": d["definition"], "data_version": d["data_version"]}, headers=_auth(user))
    shell = await db.get(UserFile, uuid.UUID(f["id"]), populate_existing=True)
    assert shell.size_bytes > 4000
    from PIL import Image

    buf = io.BytesIO()
    Image.frombytes("RGB", (120, 120), os.urandom(120 * 120 * 3)).save(buf, format="PNG")
    pic = buf.getvalue()
    await client.post(f"/api/forms/{f['id']}/assets", files={"file": ("h.png", pic, "image/png")},
                      headers=_auth(user))
    after = (await get_quota(db, user)).used_bytes
    # The shell (definition + answers) and the picture (~40 KB of noise).
    assert after - before >= shell.size_bytes + 30_000


@pytest.mark.asyncio
async def test_deleting_the_owner_takes_their_forms(db, user):
    from sqlalchemy import func, select

    from app.forms.models import Form, FormResponse
    from app.forms.service import create_form
    from app.tasks.deletion import purge_user

    leaver = await _user(db, "leaver")
    _shell, form = await create_form(db, owner=leaver, title="Bye")
    await db.commit()
    await _answer(db, form, {"q": "a"})
    assert await purge_user(db, leaver) is True
    assert await db.scalar(select(func.count()).select_from(Form)) == 0
    assert await db.scalar(select(func.count()).select_from(FormResponse)) == 0
