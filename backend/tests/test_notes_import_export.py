"""Notes N1.6: moving in and out.

* Google Keep's Takeout (JSON + HTML + pictures + recordings) → notes with
  their colours, pins, archive, labels, ticks, pictures and recordings and
  Keep's dates; odd notes (missing fields, unknown colour, a broken JSON,
  an HTML-only old export, a ``.jpeg`` named but ``.jpg`` written, a file
  that isn't there, Keep's trash) are handled; a Keep import brings notes
  only; importing it again skips what's already in.
* Export my library writes ``Promptly/Notes/*.md`` + ``notes.json``; the
  folder importer reads them back into a second account with colours,
  pins, labels, lists (ticks and indents), formatting, pictures, recordings
  and transcripts; again → nothing new; into the same account → nothing new.

The fixtures follow what's publicly known of Keep's Takeout (Google doesn't
document it): the owner's real export is the check that matters.
"""
from __future__ import annotations

import io
import json
import shutil
import subprocess
import uuid
import zipfile
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from tests.test_takeout_run_wp102 import _auth, _path, client, root  # noqa: F401

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg (the backend image has it)")

K = "Takeout/Keep/"
T1 = datetime(2021, 3, 4, 5, 6, 7, tzinfo=timezone.utc)
T2 = datetime(2023, 8, 9, 10, 11, 12, tzinfo=timezone.utc)


def usec(dt: datetime) -> int:
    return int(dt.timestamp() * 1_000_000)


def keep(**kw) -> bytes:
    base = {
        "color": "DEFAULT", "isTrashed": False, "isPinned": False, "isArchived": False, "textContent": "", "title": "",
        "createdTimestampUsec": usec(T1), "userEditedTimestampUsec": usec(T2),
    }
    base.update(kw)
    return json.dumps(base).encode()


def _jpeg(colour=(200, 40, 40)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 24), colour).save(buf, "JPEG")
    return buf.getvalue()


def _audio(tmp_path, fmt: str) -> bytes:
    """A second of tone, as Keep's .3gp (AAC in 3GP) or an .m4a."""
    out = tmp_path / f"tone.{fmt}"
    args = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac"]
    if fmt == "3gp":
        args += ["-ar", "16000", "-ac", "1", "-f", "3gp"]
    subprocess.run([*args, str(out)], check=True, timeout=60)
    return out.read_bytes()


OLD_HTML = b"""<!DOCTYPE html><html><head><title>Ancient list</title></head><body>
<div class="note PINK"><div class="heading"><div class="meta-icons"><span class="archived" title="Note archived"></span></div>
Jan 2, 2016, 10:00:00 AM</div>
<div class="title">Ancient list</div>
<div class="content"><ul class="list">
<li class="listitem checked"><span class="bullet">&#9745;</span><span class="text">Tent</span></li>
<li class="listitem"><span class="bullet">&#9744;</span><span class="text">Torch &amp; batteries</span></li>
</ul></div>
<div class="chips"><span class="chip label"><span class="label-name">Camping</span></span></div>
</div></body></html>"""


def keep_takeout(tmp_path) -> list:
    """Two parts, a note's JSON and its files split across them (as Google does)."""
    gate = keep(
        title="Gate code", textContent="Gate code 4471\nRing twice", color="YELLOW", isPinned=True,
        labels=[{"name": "Home"}],
        annotations=[{"description": "", "source": "WEBLINK", "title": "Gate instructions", "url": "https://example.com/gate"}],
        sharees=[{"isOwner": True, "type": "WRITER", "email": "me@example.com"},
                 {"isOwner": False, "type": "WRITER", "email": "wife@example.com"}],
        someFieldGoogleAddsLater={"x": 1},
    )
    shopping = keep(
        title="Shopping", color="GREEN", textContent=None,
        listContent=[{"text": "Milk", "isChecked": False}, {"text": "Eggs", "isChecked": True},
                     {"textHtml": "<p>Bread</p>", "text": "", "isChecked": False}, {"text": "   ", "isChecked": False}],
        labels=[{"name": "home"}, {"name": "Groceries"}],
    )
    shopping = json.loads(shopping)
    del shopping["textContent"]
    one = {
        K + "Gate code.json": gate,
        K + "Gate code.html": b"<div class='note YELLOW'><div class='title'>Gate code</div></div>",
        K + "Shopping.json": json.dumps(shopping).encode(),
        K + "Old idea.json": keep(title="Old idea", textContent="Paint the shed", color="CERULEAN", isArchived=True,
                                  attachments=[{"filePath": "1a2b3c.jpeg", "mimetype": "image/jpeg"}]),
        K + "Voice memo.json": keep(title="", textContent="", color="RED",
                                    attachments=[{"filePath": "rec-9f.3gp", "mimetype": "audio/3gp"}]),
        K + "Binned.json": keep(title="Binned", textContent="gone", isTrashed=True),
        K + "Weird.json": json.dumps({"textContent": "Just some text", "color": "MAGENTA", "isPinned": "yes",
                                      "labels": "not-a-list", "attachments": [{"nope": 1}, "x"]}).encode(),
        K + "Broken.json": b"{ this isn't json",
        K + "Lost picture.json": keep(title="Lost picture", textContent="It was here",
                                      attachments=[{"filePath": "gone.png", "mimetype": "image/png"}]),
        K + "Ancient list.html": OLD_HTML,
        K + "Labels.txt": b"Home\nGroceries\nCamping\n",
        "Takeout/archive_browser.html": b"<html></html>",
        "Takeout/Google Photos/Photos from 2020/IMG_1.jpg": _jpeg((1, 2, 3)),
    }
    two = {
        K + "1a2b3c.jpg": _jpeg(),
        K + "rec-9f.3gp": _audio(tmp_path, "3gp"),
    }
    paths = []
    for i, members in enumerate((one, two)):
        path = tmp_path / f"takeout-keep-00{i + 1}.zip"
        with zipfile.ZipFile(path, "w") as zf:
            for name, data in members.items():
                zf.writestr(name, data)
        paths.append(path)
    return paths


@pytest.fixture
def quiet(monkeypatch):
    """Recordings sent to the worker, and live updates (not run here)."""
    from app.notes import events, transcription

    sent: list = []

    async def enqueue(aid):
        sent.append(aid)

    async def publish(*_a, **_k):
        return None

    monkeypatch.setattr(transcription, "enqueue", enqueue)
    monkeypatch.setattr(events, "publish", publish)
    return sent


async def keep_import(client, user, paths, source="keep"):
    from tests.test_takeout_index_wp101 import _upload_part

    job = (await client.post("/api/imports", json={"source": source}, headers=_auth(user))).json()
    for path in paths:
        await _upload_part(client, user, job["id"], path)
    await client.post(f"/api/imports/{job['id']}/check", headers=_auth(user))
    got = (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()
    assert got["state"] == "ready", got["error"]
    r = await client.post(f"/api/imports/{job['id']}/start", headers=_auth(user))
    assert r.status_code == 200, r.text
    return got["report"], (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()


async def notes_of(db, user):
    """title → (note, my state, items, attachments + files, label names)."""
    from app.files.models import UserFile
    from app.notes.models import Note, NoteAttachment, NoteItem, NoteUserState
    from app.tags.models import Tag, TagAssignment

    out = {}
    for n in (await db.execute(select(Note).where(Note.owner_id == user.id).execution_options(populate_existing=True))).scalars():
        st = await db.get(NoteUserState, (n.id, user.id), populate_existing=True)
        items = (await db.execute(select(NoteItem).where(NoteItem.note_id == n.id).order_by(NoteItem.position))).scalars().all()
        atts = []
        for a in (await db.execute(select(NoteAttachment).where(NoteAttachment.note_id == n.id).order_by(NoteAttachment.position))).scalars():
            atts.append((a, await db.get(UserFile, a.file_id, populate_existing=True)))
        labels = sorted(
            (await db.execute(
                select(Tag.name).join(TagAssignment, TagAssignment.tag_id == Tag.id)
                .where(TagAssignment.entity_kind == "note", TagAssignment.entity_id == str(n.id), TagAssignment.user_id == user.id)
            )).scalars(),
            key=str.casefold,
        )
        out[n.title or n.body_text.split("\n")[0] or "(untitled)"] = (n, st, items, atts, labels)
    return out


# ------------------------------------------------------------------ reading (no DB)


def test_keep_json_is_read_tolerantly():
    from app.imports.keep import color_of, is_keep_note, keep_json_from_html, note_from_keep

    def resolve(path, mime):
        return {"part": 0, "member": "Takeout/Keep/" + path, "name": path, "size": 1} if path != "gone.png" else None

    note, tell = note_from_keep(json.loads(keep(title="T", textContent="a\nb", color="TEAL", isPinned=True,
                                                attachments=[{"filePath": "x.jpg", "mimetype": "image/jpeg"},
                                                             {"filePath": "gone.png", "mimetype": "image/png"},
                                                             {"filePath": "y.m4a", "mimetype": "audio/mp4"}])),
                                ref="keep:1", resolve=resolve)
    assert note["kind"] == "text" and note["color"] == "sage" and note["pinned"] is True
    assert [b["content"][0]["text"] for b in note["body_doc"]["content"]] == ["a", "b"]
    assert [a["kind"] for a in note["attachments"]] == ["image", "audio"] and tell["missing"] == 1
    assert note["created"] == T1.timestamp() and note["edited"] == T2.timestamp()
    # Every colour Keep has, and anything else is the plain card.
    assert [color_of(c) for c in ("DEFAULT", "RED", "ORANGE", "YELLOW", "GREEN", "TEAL", "BLUE", "CERULEAN", "PURPLE",
                                   "PINK", "BROWN", "GRAY", "MAGENTA", None, 5)] == [
        "default", "coral", "peach", "sand", "mint", "sage", "fog", "storm", "dusk", "blossom", "clay", "chalk",
        "default", "default", "default"]
    # Text and a list in one note: the items come after the text.
    both, _ = note_from_keep({"textContent": "Intro", "listContent": [{"text": "a", "isChecked": True}]}, ref="r", resolve=resolve)
    assert both["kind"] == "text" and "[x] a" in json.dumps(both["body_doc"])
    # An empty list is still a list; nothing here is a note.
    assert note_from_keep({"listContent": [], "color": "RED"}, ref="r", resolve=resolve)[0]["kind"] == "list"
    assert not is_keep_note({"title": "an album", "photoTakenTime": {}}) and not is_keep_note([1, 2])
    # An old export's page.
    page = keep_json_from_html(OLD_HTML)
    assert page["title"] == "Ancient list" and page["color"] == "PINK" and page["isArchived"] is True
    assert page["listContent"] == [{"text": "Tent", "isChecked": True}, {"text": "Torch & batteries", "isChecked": False}]
    assert page["labels"] == [{"name": "Camping"}]
    assert keep_json_from_html(b"<html><body>not keep</body></html>") is None


# ------------------------------------------------------------------ Keep import


@needs_ffmpeg
@pytest.mark.asyncio
async def test_a_keep_takeout_comes_in_with_colours_lists_pictures_and_recordings(client, db, user, tmp_path, quiet):
    from app.files.models import UserFile

    paths = keep_takeout(tmp_path)
    report, job = await keep_import(client, user, paths)
    n = report["notes"]
    assert (n["notes"], n["lists"], n["archived"], n["pinned"], n["trashed"]) == (7, 2, 2, 1, 1), n
    assert (n["with_pictures"], n["with_recordings"], n["missing_attachments"], n["shared"], n["unreadable"]) == (1, 1, 1, 1, 1), n
    assert n["labels"] == ["Camping", "Groceries", "Home"]
    # A Keep import is the notes only; the photo in the same Takeout is named, not imported.
    assert report["photos"] == 0 and "Google Photos" in report["other_products"]
    assert job["state"] == "done", job["error"]
    assert (job["progress"]["notes"], job["progress"]["failed"]) == (7, 0), job["progress"]

    got = await notes_of(db, user)
    assert set(got) == {"Gate code", "Shopping", "Old idea", "(untitled)", "Just some text", "Lost picture", "Ancient list"}
    gate, st, _items, _atts, labels = got["Gate code"]
    assert (gate.color, st.pinned, st.archived_at, gate.source, labels) == ("sand", True, None, "import", ["Home"])
    text = json.dumps(gate.body_doc)
    assert "Ring twice" in text and '"href": "https://example.com/gate"' in text
    assert "Shared in Keep with wife@example.com." in gate.body_text
    assert gate.created_at == T1 and gate.updated_at == T2 and gate.import_ref == f"keep:{usec(T1)}"

    shop, st, items, _a, labels = got["Shopping"]
    assert shop.kind == "list" and shop.color == "mint" and labels == ["Groceries", "Home"]  # "home" is the same #tag
    assert [(i.text, i.checked) for i in items] == [("Milk", False), ("Eggs", True), ("Bread", False)]

    old, st, _i, atts, _l = got["Old idea"]
    assert old.color == "storm" and st.archived_at is not None and not st.pinned
    [(att, f)] = atts  # named .jpeg, written .jpg
    assert att.kind == "image" and f.filename == "1a2b3c.jpg" and await _path(db, f.folder_id) == ["Notes"]

    voice, _st, _i, atts, _l = got["(untitled)"]
    [(att, f)] = atts
    assert voice.color == "coral" and att.kind == "audio" and f.filename == "rec-9f.m4a" and f.mime_type.startswith("audio/")
    assert att.transcript_state in ("pending", "off") and quiet == [att.id]  # the worker makes its waveform (and words)

    weird = got["Just some text"][0]
    assert weird.color == "default" and weird.import_ref.startswith("keep:file:")
    ancient, st, items, _a, labels = got["Ancient list"]
    assert (ancient.color, st.archived_at is not None, labels) == ("blossom", True, ["Camping"])
    assert [(i.text, i.checked) for i in items] == [("Tent", True), ("Torch & batteries", False)]
    assert got["Lost picture"][3] == []  # its picture wasn't in the Takeout: the note still comes
    assert not await db.scalar(select(func.count(UserFile.id)).where(UserFile.user_id == user.id, UserFile.filename == "IMG_1.jpg"))

    # Again: nothing new, nothing copied twice.
    files_before = await db.scalar(select(func.count(UserFile.id)).where(UserFile.user_id == user.id))
    _report, again = await keep_import(client, user, paths)
    assert again["state"] == "done" and (again["progress"]["notes"], again["progress"]["duplicates"]) == (0, 7), again["progress"]
    assert len(await notes_of(db, user)) == 7
    assert await db.scalar(select(func.count(UserFile.id)).where(UserFile.user_id == user.id)) == files_before


@pytest.mark.asyncio
async def test_a_takeout_without_keep_says_so(client, user, tmp_path):
    from tests.test_takeout_index_wp101 import _upload_part

    path = tmp_path / "photos-only.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Takeout/Google Photos/Photos from 2020/IMG_1.jpg", _jpeg())
    job = (await client.post("/api/imports", json={"source": "keep"}, headers=_auth(user))).json()
    await _upload_part(client, user, job["id"], path)
    await client.post(f"/api/imports/{job['id']}/check", headers=_auth(user))
    got = (await client.get(f"/api/imports/{job['id']}", headers=_auth(user))).json()
    assert got["state"] == "failed" and "no Google Keep notes" in got["error"]


@needs_ffmpeg
@pytest.mark.asyncio
async def test_a_plain_takeout_brings_keep_notes_too(client, db, user, tmp_path, quiet):
    """The Google Takeout import reads Keep as well as Photos and Drive."""
    report, job = await keep_import(client, user, keep_takeout(tmp_path), source="takeout")
    assert report["photos"] == 1 and report["notes"]["notes"] == 7
    assert job["state"] == "done" and job["progress"]["notes"] == 7, job


# ------------------------------------------------------------------ export and back


async def _extra_notes(db, user, client):
    """A formatted note and an indented list made here, a recording with its
    words, and a shared note."""
    from app.auth.models import User
    from app.notes import service
    from app.notes.models import NoteAttachment, NoteMember

    me = await db.get(User, user.id)
    doc = {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Lyrics"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "loud", "marks": [{"type": "bold"}]}, {"type": "text", "text": " and soft"}]},
    ]}
    await service.create(db, me, note_id=None, kind="text", title="Song", body_doc=doc, color="dusk", source="web")
    await service.create(db, me, note_id=None, kind="list", title="Packing", color="fog", pinned=True,
                         items=[{"text": "Clothes"}, {"text": "Socks", "indent": True, "checked": True}, {"text": "Torch"}])
    voice = (await db.execute(select(NoteAttachment).where(NoteAttachment.kind == "audio"))).scalars().one()
    voice.transcript, voice.transcript_state = "la la la chorus", "done"
    friend = User(email=f"f-{uuid.uuid4().hex[:6]}@example.com", username=f"friend{uuid.uuid4().hex[:4]}", password_hash="x", role="user")
    db.add(friend)
    await db.flush()
    shop = await service.create(db, me, note_id=None, kind="text", title="Shared plan", text="Party", source="web")
    db.add(NoteMember(note_id=shop[0].id, user_id=friend.id, added_by=me.id))
    # And a note someone shared with me isn't mine to export.
    theirs, _ = await service.create(db, friend, note_id=None, kind="text", title="Their note", text="not mine", source="web")
    db.add(NoteMember(note_id=theirs.id, user_id=me.id, added_by=friend.id))
    await db.commit()
    return friend


@needs_ffmpeg
@pytest.mark.asyncio
async def test_export_writes_markdown_and_notes_json_and_a_second_account_gets_it_all_back(client, db, user, tmp_path, quiet):
    from app.files.models import UserFile
    from tests.test_folder_import_wp103 import _run
    from tests.test_library_export_wp104 import _other_user

    _r, job = await keep_import(client, user, keep_takeout(tmp_path))
    assert job["state"] == "done"
    friend = await _extra_notes(db, user, client)
    mine = await notes_of(db, user)
    assert len(mine) == 10

    export = (await client.post("/api/files/exports", json={"part_gb": 2}, headers=_auth(user))).json()
    assert export["counts"]["notes"] == 10
    r = await client.get("/api" + export["parts"][0]["url"])
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert "Promptly/Notes/notes.json" in names and "Promptly/Notes/Their note.md" not in names
    shop = z.read("Promptly/Notes/Shopping.md").decode()
    assert shop.startswith("---\ntitle: \"Shopping\"\ntype: list\ncolor: mint\npinned: false\narchived: false\n")
    assert 'labels: ["Groceries", "Home"]' in shop and "- [ ] Milk\n- [x] Eggs\n- [ ] Bread" in shop
    packing = z.read("Promptly/Notes/Packing.md").decode()
    assert "pinned: true" in packing and "- [ ] Clothes\n  - [x] Socks\n- [ ] Torch" in packing
    assert "# Lyrics" in z.read("Promptly/Notes/Song.md").decode() or "## Lyrics" in z.read("Promptly/Notes/Song.md").decode()
    assert "**loud** and soft" in z.read("Promptly/Notes/Song.md").decode()
    old = z.read("Promptly/Notes/Old idea.md").decode()
    assert "![1a2b3c.jpg](<../My files/Notes/1a2b3c.jpg>)" in old and "Promptly/My files/Notes/1a2b3c.jpg" in names
    voice_md = next(z.read(n).decode() for n in names if n.startswith("Promptly/Notes/") and "rec-9f" in z.read(n).decode(errors="replace") and n.endswith(".md"))
    assert "[Recording: rec-9f.m4a](<../My files/Notes/rec-9f.m4a>)" in voice_md and "> la la la chorus" in voice_md
    assert "shared_with: [\"" + friend.username + "\"]" in z.read("Promptly/Notes/Shared plan.md").decode()
    records = json.loads(z.read("Promptly/Notes/notes.json"))["notes"]
    assert len(records) == 10
    rec = next(x for x in records if x["title"] == "Shopping")
    assert rec["color"] == "GREEN" and rec["listContent"][1] == {"text": "Eggs", "isChecked": True}
    assert rec["promptly"]["color"] == "mint"

    # A second account brings the export in.
    path = tmp_path / export["parts"][0]["name"]
    path.write_bytes(r.content)
    other = await _other_user(db)
    job = await _run(client, other, [path], "folder")
    assert job["state"] == "done", job["error"]
    assert job["report"]["notes"]["notes"] == 10 and job["progress"]["notes"] == 10, job
    theirs = await notes_of(db, other)
    assert set(theirs) == set(mine)
    for title, (n, st, items, atts, labels) in mine.items():
        m, mst, mitems, matts, mlabels = theirs[title]
        assert (m.kind, m.color, m.title, labels) == (n.kind, n.color, n.title, mlabels), title
        assert (bool(st.pinned), st.archived_at is None) == (bool(mst.pinned), mst.archived_at is None), title
        assert [(i.text, i.checked, i.parent_id is None) for i in items] == [(i.text, i.checked, i.parent_id is None) for i in mitems], title
        assert [(a.kind, f.filename) for a, f in atts] == [(a.kind, f.filename) for a, f in matts], title
        assert m.body_doc == n.body_doc and abs((m.created_at - n.created_at).total_seconds()) < 0.001, title
        for a, f in matts:
            assert f.user_id == other.id and await _path(db, f.folder_id) == ["Notes"]
    # A recording keeps its words (not sent for transcribing again).
    [(va, _vf)] = theirs["(untitled)"][3]
    assert va.transcript == "la la la chorus" and va.transcript_state == "done"
    # The note files went to Notes, not "Imported – …"; nothing became a photo.
    files = (await db.execute(select(UserFile).where(UserFile.user_id == other.id))).scalars().all()
    assert sorted(f.filename for f in files) == ["1a2b3c.jpg", "rec-9f.m4a"]

    # Again into the same account, and into the account it came from: nothing new.
    again = await _run(client, other, [path], "folder")
    assert again["progress"]["notes"] == 0 and len(await notes_of(db, other)) == 10
    back = await _run(client, user, [path], "folder")
    assert back["progress"]["notes"] == 0 and len(await notes_of(db, user)) == 10
