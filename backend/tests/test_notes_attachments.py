"""Notes N1.3: pictures and recordings in notes.

* uploads with tus ``route=note`` land in My files › Notes (kept out of Photos);
* only your own files go in; a retried add makes one attachment;
* the signed ``note`` link (``/m/``, code 19): the owner and a collaborator
  get the bytes; a stranger, a removed member, a trashed note, a removed
  attachment and a file in its owner's trash all get 404;
* the transcription job with a fake Whisper: a seekable playback copy, the
  waveform, the words in 10-minute chunks (shrunk here), into search and the
  file's ``content_text``; a failure and Try again; off with cloud
  speech-to-text until the admin turns it on.
"""
from __future__ import annotations

import io
import shutil
import subprocess
import uuid

import httpx
import pytest

from tests.test_notes_core import H, mk_user, new_note, share

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg (the backend image has it)")


# ------------------------------------------------------------------ harness


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture
def queued(monkeypatch):
    """Recordings sent to the worker (nothing runs: tests run the job)."""
    from app.notes import transcription
    from app.tasks import queue

    got: list[uuid.UUID] = []

    async def fake(aid):
        got.append(aid)

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(transcription, "enqueue", fake)
    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(queue, "enqueue_office_text", nothing)
    return got


@pytest.fixture
def live(monkeypatch):
    from app.notes import events

    got: list[tuple[set[str], dict]] = []

    async def fake(user_ids, event):
        assert set(event) <= events.EVENT_KEYS
        got.append(({str(u) for u in user_ids}, dict(event)))

    monkeypatch.setattr(events, "publish", fake)
    return got


@pytest.fixture
def local_stt(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "STT_BACKEND", "local")
    monkeypatch.setattr(get_settings(), "WHISPER_URL", "http://whisper:8000")


@pytest.fixture
async def client(db, root, queued, live, local_stt, monkeypatch):
    from app import rate_limit
    from app.config import get_settings
    from app.main import app

    monkeypatch.setattr(get_settings(), "TUS_ENABLED", True)
    monkeypatch.setattr(get_settings(), "TUS_HOOK_SECRET", None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _event(user, *, size, meta, upload_id="", offset=0, method="POST"):
    from app.auth.utils import create_access_token

    tok = create_access_token(user.id, token_version=user.token_version)
    return {
        "Upload": {"ID": upload_id, "Size": size, "SizeIsDeferred": False, "Offset": offset, "MetaData": meta,
                   "IsPartial": False, "IsFinal": False, "PartialUploads": None, "Storage": None},
        "HTTPRequest": {"Method": method, "URI": "/api/files/tus/", "RemoteAddr": "172.18.0.9:5000",
                        "Header": {"Authorization": [f"Bearer {tok}"], "X-Real-Ip": ["203.0.113.7"]}},
    }


async def _hook(client, hook, event):
    r = await client.post("/api/internal/tus-hook", json={"Type": hook, "Event": event})
    assert r.status_code == 200, r.text
    return r.json()


async def tus_upload(client, root, user, name: str, data: bytes, mime: str, route: str | None = "note") -> str:
    """The way tusd does it: pre-create, the bytes, pre-finish."""
    from app.files.tus_hooks import TUS_DIR

    meta = {"filename": name, "filetype": mime, "scope": "mine", **({"route": route} if route else {})}
    reply = await _hook(client, "pre-create", _event(user, size=len(data), meta=meta))
    assert "RejectUpload" not in reply, reply
    upload_id, meta = reply["ChangeFileInfo"]["ID"], reply["ChangeFileInfo"]["MetaData"]
    d = root / TUS_DIR
    d.mkdir(exist_ok=True)
    (d / upload_id).write_bytes(data)
    (d / f"{upload_id}.info").write_text("{}")
    reply = await _hook(client, "pre-finish", _event(user, size=len(data), meta=meta, upload_id=upload_id, offset=len(data), method="PATCH"))
    assert "StatusCode" not in reply["HTTPResponse"], reply
    return reply["HTTPResponse"]["Header"]["Upload-File-Id"]


def png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 30), (200, 80, 60)).save(buf, "PNG")
    return buf.getvalue()


def webm(seconds: int = 25) -> bytes:
    """A browser-style recording: Opus in WebM."""
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=330:duration={seconds}",
         "-af", "volume=0.6", "-c:a", "libopus", "-b:a", "24k", "-f", "webm", "-"],
        check=True, capture_output=True,
    )
    return out.stdout


async def attach(client, u, nid, fid, kind=None, **kw):
    aid = kw.pop("aid", None) or str(uuid.uuid4())
    body = {"id": aid, "file_id": fid, **({"kind": kind} if kind else {}), **kw}
    return await client.post(f"/api/notes/{nid}/attachments", headers=H(u), json=body)


async def note_of(client, u, nid):
    r = await client.get(f"/api/notes/{nid}", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()["note"]


async def fetch(client, url):
    return await client.get("/api" + url)


# ------------------------------------------------------------------ uploads + attaching


async def test_note_uploads_go_to_my_files_notes_and_stay_out_of_photos(client, db, root):
    from app.files.models import FileFolder, UserFile

    ann = await mk_user(db, "ann")
    fid = await tus_upload(client, root, ann, "beach.png", png(), "image/png")
    row = await db.get(UserFile, uuid.UUID(fid), populate_existing=True)
    folder = await db.get(FileFolder, row.folder_id)
    assert folder.system_kind == "notes" and folder.name == "Notes" and folder.hide_from_photos is True
    # A second one goes in the same folder (made once).
    fid2 = await tus_upload(client, root, ann, "beach.png", png(), "image/png")
    assert (await db.get(UserFile, uuid.UUID(fid2), populate_existing=True)).folder_id == folder.id


async def test_attach_your_own_files_once_and_nobody_elses(client, db, root, live):
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    n = await new_note(client, ann, title="Beach")
    pic = await tus_upload(client, root, ann, "beach.png", png(), "image/png")
    bobs = await tus_upload(client, root, bob, "bob.png", png(), "image/png")
    txt = await tus_upload(client, root, ann, "words.txt", b"hello there", "text/plain", route=None)

    aid = str(uuid.uuid4())
    r = await attach(client, ann, n["id"], pic, "image", aid=aid)
    assert r.status_code == 201, r.text
    note = r.json()["note"]
    [a] = note["attachments"]
    assert a["id"] == aid and a["kind"] == "image" and a["width"] in (40, None)
    assert a["urls"]["original"].startswith("/m/")
    assert note["attachments"] and live[-1][1]["type"] == "note"
    # A retry (the answer was lost) makes nothing new.
    r = await attach(client, ann, n["id"], pic, "image", aid=aid)
    assert r.status_code == 200 and len(r.json()["note"]["attachments"]) == 1
    # Someone else's file, a text file, the wrong kind, a reused id elsewhere.
    assert (await attach(client, ann, n["id"], bobs)).status_code == 404
    assert (await attach(client, ann, n["id"], txt)).status_code == 400
    assert (await attach(client, ann, n["id"], pic, "audio")).status_code == 400
    other = await new_note(client, ann, title="Other")
    assert (await attach(client, ann, other["id"], bobs, aid=aid)).status_code == 409
    # The card counts it and shows its tile.
    cards = (await client.get("/api/notes", headers=H(ann))).json()["notes"]
    card = next(c for c in cards if c["id"] == n["id"])
    assert card["attachments"]["images"] == 1 and card["covers"][0]["id"] == aid
    assert [c["id"] for c in (await client.get("/api/notes?type=image", headers=H(ann))).json()["notes"]] == [n["id"]]

    # A stranger can't add to (or find) the note.
    cat = await mk_user(db, "cat")
    cats = await tus_upload(client, root, cat, "cat.png", png(), "image/png")
    assert (await attach(client, cat, n["id"], cats)).status_code == 404
    # Removing it: gone from the note, still in Ann's Drive.
    r = await client.delete(f"/api/notes/{n['id']}/attachments/{aid}", headers=H(ann))
    assert r.status_code == 200 and r.json()["note"]["attachments"] == []
    assert (await client.get(f"/api/files/{pic}", headers=H(ann))).status_code == 200


async def test_signed_links_follow_who_can_open_the_note(client, db, root):
    from app.auth.models import User
    from app.files import media_urls
    from app.notes import media

    ann, bob, cat, dan = [await mk_user(db, n) for n in ("ann", "bob", "cat", "dan")]
    n = await new_note(client, ann, title="Song")
    pic_bytes = png()
    pic = await tus_upload(client, root, ann, "cover.png", pic_bytes, "image/png")
    aid = str(uuid.uuid4())
    assert (await attach(client, ann, n["id"], pic, aid=aid)).status_code == 201
    await share(client, ann, n["id"], bob, dan)

    # Owner and collaborator: the bytes. (The collaborator can't read Ann's
    # Drive file — only through the note.)
    for u in (ann, bob):
        url = (await note_of(client, u, n["id"]))["attachments"][0]["urls"]["original"]
        r = await fetch(client, url)
        assert r.status_code == 200 and r.content == pic_bytes
        assert r.headers["content-type"].startswith("image/png")
    assert (await client.get(f"/api/files/{pic}/signed-urls", headers=H(bob))).status_code == 404
    bob_url = (await note_of(client, bob, n["id"]))["attachments"][0]["urls"]["original"]
    dan_url = (await note_of(client, dan, n["id"]))["attachments"][0]["urls"]["original"]

    # A stranger: no note, and a link made out to them is refused too.
    assert (await client.get(f"/api/notes/{n['id']}", headers=H(cat))).status_code == 404
    cat_row = await db.get(User, cat.id)
    forged = media.sign(uuid.UUID(aid), cat_row, "original", "x")
    assert (await fetch(client, forged)).status_code == 404
    # A tampered link.
    assert (await fetch(client, dan_url[:-3] + ("AAA" if not dan_url.endswith("AAA") else "BBB"))).status_code == 404
    assert media_urls.verify(bob_url[3:]).rendition == "note"

    # Dan is removed: his link stops at once.
    assert (await client.delete(f"/api/notes/{n['id']}/members/{dan.id}", headers=H(ann))).status_code == 200
    assert (await fetch(client, dan_url)).status_code == 404
    assert (await fetch(client, bob_url)).status_code == 200
    # The file in Ann's trash: out of the note for everyone, back when restored.
    r = await client.post(f"/api/files/{pic}/trash", headers=H(ann))
    assert r.status_code == 200, r.text
    assert (await fetch(client, bob_url)).status_code == 404
    assert (await note_of(client, bob, n["id"]))["attachments"] == []
    from app.files.models import UserFile

    row = await db.get(UserFile, uuid.UUID(pic), populate_existing=True)
    row.trashed_at = None
    await db.commit()
    assert (await fetch(client, bob_url)).status_code == 200
    # Unattached: the link is dead.
    await client.delete(f"/api/notes/{n['id']}/attachments/{aid}", headers=H(bob))
    assert (await fetch(client, bob_url)).status_code == 404
    # A trashed note: only its owner, and only in Trash (no attachment links).
    aid2 = str(uuid.uuid4())
    assert (await attach(client, ann, n["id"], pic, aid=aid2)).status_code == 201
    bob_url = (await note_of(client, bob, n["id"]))["attachments"][0]["urls"]["original"]
    assert (await client.delete(f"/api/notes/{n['id']}", headers=H(ann))).status_code == 200
    assert (await fetch(client, bob_url)).status_code == 404


# ------------------------------------------------------------------ transcription


class FakeWhisper:
    def __init__(self, fail: bool = False):
        self.calls: list[tuple[str, bool]] = []
        self.fail = fail

    async def __call__(self, *, data, filename, content_type, language=None, timeout_s=None, batch=False):
        from app.voice.schemas import TranscriptionResponse
        from app.voice.service import TranscriptionError

        assert data and content_type == "audio/ogg"
        self.calls.append((filename, batch))
        if self.fail:
            raise TranscriptionError("Transcription failed (500).", status_code=502)
        return TranscriptionResponse(text=f"the chorus part {len(self.calls)}", language="en")


@pytest.fixture
def whisper(monkeypatch):
    from app.voice import service as voice
    from app.workspaces import meetings_runner

    fake = FakeWhisper()
    monkeypatch.setattr(voice, "transcribe_audio", fake)
    monkeypatch.setattr(meetings_runner, "_CHUNK_SECONDS", 10)  # 10-minute chunks, shrunk
    monkeypatch.setattr(meetings_runner, "_CHUNK_RETRIES", 0)
    return fake


@needs_ffmpeg
async def test_a_recording_gets_a_waveform_and_words_that_search_finds(client, db, root, queued, live, whisper):
    from app.files.derivatives import derived_dir
    from app.files.models import UserFile
    from app.notes import transcription

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    n = await new_note(client, ann, title="Lyrics", text="Verse one goes here")
    await share(client, ann, n["id"], bob)
    fid = await tus_upload(client, root, ann, "Recording.webm", webm(25), "audio/webm")
    r = await attach(client, ann, n["id"], fid, "audio", duration_ms=24_800, peaks=[0.1, 2.0, -1])
    assert r.status_code == 201, r.text
    [a] = r.json()["note"]["attachments"]
    assert a["transcript_state"] == "pending" and a["duration_ms"] == 24_800 and a["peaks"] == [0.1, 1.0, 0.0]
    assert r.json()["note"]["transcription"] is True
    assert queued == [uuid.UUID(a["id"])]

    assert await transcription.process(uuid.UUID(a["id"])) == "done"
    assert [c[1] for c in whisper.calls] == [True, True, True]  # batch lane, three 10 s chunks
    note = await note_of(client, bob, n["id"])
    [a] = note["attachments"]
    assert a["transcript_state"] == "done"
    assert a["transcript"].startswith("[0:00:00] the chorus part 1") and "[0:00:20] the chorus part 3" in a["transcript"]
    assert 24_000 <= a["duration_ms"] <= 26_000
    assert 0 < len(a["peaks"]) <= 200 and max(a["peaks"]) == 1.0
    # The note's own text is untouched; the words are under the recording.
    assert note["body_text"] == "Verse one goes here"
    # A seekable copy to play, for the collaborator too.
    assert (derived_dir(fid) / "note-play.webm").is_file()
    r = await fetch(client, a["urls"]["play"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("audio/webm") and len(r.content) > 1000
    # Found by a word in it, by both of them; and in Drive (content_text).
    for u in (ann, bob):
        hits = (await client.get("/api/notes", headers=H(u), params={"q": "chorus"})).json()["notes"]
        assert [h["id"] for h in hits] == [n["id"]]
    row = await db.get(UserFile, uuid.UUID(fid), populate_existing=True)
    assert "chorus part 2" in row.content_text
    assert live[-1][1] == {"type": "note", "id": n["id"], "revision": note["revision"], "change_seq": note["change_seq"]}
    # The job moved the note without anyone "editing" it (still Ann's attach).
    assert note["edited_by"] == str(ann.id)

    # Removing the recording takes its words out of search.
    await client.delete(f"/api/notes/{n['id']}/attachments/{a['id']}", headers=H(bob))
    assert (await client.get("/api/notes", headers=H(ann), params={"q": "chorus"})).json()["notes"] == []


@needs_ffmpeg
async def test_a_failed_transcription_can_be_tried_again(client, db, root, queued, whisper):
    from app.notes import transcription

    ann = await mk_user(db, "ann")
    n = await new_note(client, ann, title="Memo")
    fid = await tus_upload(client, root, ann, "memo.webm", webm(5), "audio/webm")
    aid = (await attach(client, ann, n["id"], fid)).json()["note"]["attachments"][0]["id"]
    whisper.fail = True
    assert await transcription.process(uuid.UUID(aid)) == "failed"
    a = (await note_of(client, ann, n["id"]))["attachments"][0]
    assert a["transcript_state"] == "failed" and a["peaks"]  # the waveform still came
    whisper.fail = False
    whisper.calls.clear()
    r = await client.post(f"/api/notes/{n['id']}/attachments/{aid}/transcribe", headers=H(ann))
    assert r.status_code == 200 and r.json()["note"]["attachments"][0]["transcript_state"] == "pending"
    assert queued[-1] == uuid.UUID(aid)
    assert await transcription.process(uuid.UUID(aid)) == "done"
    assert (await note_of(client, ann, n["id"]))["attachments"][0]["transcript"] == "the chorus part 1"
    # Not a recording, not in the note.
    assert (await client.post(f"/api/notes/{n['id']}/attachments/{uuid.uuid4()}/transcribe", headers=H(ann))).status_code == 404


@needs_ffmpeg
async def test_cloud_speech_to_text_is_off_until_the_admin_turns_it_on(client, db, root, queued, whisper, monkeypatch):
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.auth.models import User
    from app.config import get_settings
    from app.notes import transcription

    if await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID) is None:
        db.add(AppSettings(id=SINGLETON_APP_SETTINGS_ID))
        await db.commit()
    monkeypatch.setattr(get_settings(), "STT_BACKEND", "openai")
    monkeypatch.setattr(get_settings(), "OPENAI_API_KEY", "sk-test-not-real")
    ann = await mk_user(db, "ann")
    admin = await mk_user(db, "root")
    admin_row = await db.get(User, admin.id)
    admin_row.role = "admin"
    await db.commit()

    n = await new_note(client, ann, title="Memo")
    fid = await tus_upload(client, root, ann, "memo.webm", webm(4), "audio/webm")
    r = await attach(client, ann, n["id"], fid)
    a = r.json()["note"]["attachments"][0]
    assert a["transcript_state"] == "off" and r.json()["note"]["transcription"] is False
    # The job still makes the waveform, and sends nothing anywhere.
    assert await transcription.process(uuid.UUID(a["id"])) == "off"
    assert whisper.calls == []
    a = (await note_of(client, ann, n["id"]))["attachments"][0]
    assert a["transcript_state"] == "off" and a["peaks"]
    assert (await client.post(f"/api/notes/{n['id']}/attachments/{a['id']}/transcribe", headers=H(ann))).status_code == 409

    # Only an admin sees or changes the switch.
    assert (await client.get("/api/notes/admin/transcription", headers=H(ann))).status_code == 403
    st = (await client.get("/api/notes/admin/transcription", headers=H(admin))).json()
    assert st == {"on": False, "backend": "openai", "choice": None, "ready": True}
    r = await client.put("/api/notes/admin/transcription", headers=H(admin), json={"on": True})
    assert r.json()["on"] is True
    r = await client.post(f"/api/notes/{n['id']}/attachments/{a['id']}/transcribe", headers=H(ann))
    assert r.status_code == 200
    assert await transcription.process(uuid.UUID(a["id"])) == "done"
    # And the local Whisper is on unless the admin turned it off.
    monkeypatch.setattr(get_settings(), "STT_BACKEND", "local")
    await client.put("/api/notes/admin/transcription", headers=H(admin), json={"on": False})
    assert (await client.get("/api/notes/admin/transcription", headers=H(admin))).json()["on"] is False


def test_peaks_are_shrunk_to_at_most_200_levels():
    from app.notes.transcription import shrink

    out = shrink(list(range(1000)))
    assert len(out) == 200 and out[-1] == 1.0 and out[0] < 0.05
    assert shrink([0, 5, 10]) == [0.0, round(0.5 ** 0.7, 3), 1.0]
    assert shrink([]) == []
