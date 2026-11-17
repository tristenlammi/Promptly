"""Rooms uploads (owner decisions, 2026-11-17): a file sent in Rooms can be
up to 1 GB, counts towards its sender's storage, shows in their own "Rooms
uploads" list in Files, can be removed from there (the message then says
"File removed"), and is never anything AI can read: it never becomes a row
in ``files``, so the Drive index, AI search and the chat's file tools can't
reach it."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from sqlalchemy import select, text

from tests.test_drive_index_wp51 import embedder  # noqa: F401 - fixture
from tests.test_rooms import H, make_space, mk_user, say

WORDS = b"The zebrafinch ledger is hidden under the quince tree."


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture
async def client(db, root, monkeypatch):
    from app import rate_limit
    from app.config import get_settings
    from app.files import tus_hooks
    from app.main import app
    from app.tasks import queue
    import app.rooms.router as r

    async def nothing(*_a, **_k):
        return None

    monkeypatch.setattr(queue, "enqueue_media", nothing)
    monkeypatch.setattr(queue, "enqueue_office_text", nothing)
    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())
    monkeypatch.setattr(get_settings(), "TUS_ENABLED", True)
    monkeypatch.setattr(tus_hooks, "_caller_ok", lambda request, key: True)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
async def people(db):
    return [await mk_user(db, n) for n in ("ann", "bob", "cat")]


async def attach(client, u, room, name="plans.txt", data=WORDS, mime="text/plain"):
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(u), files={"file": (name, data, mime)})
    assert r.status_code == 201, r.text
    return r.json()


async def quota(client, u) -> dict:
    r = await client.get("/api/files/quota", headers=H(u))
    assert r.status_code == 200, r.text
    return r.json()


async def cap(db, u, n: int | None) -> None:
    u.storage_cap_bytes = n
    await db.commit()


# ------------------------------------------------------------------ storage


async def test_a_rooms_upload_uses_its_senders_storage(client, db, people):
    ann, bob, _ = people
    _sid, room = await make_space(client, ann, bob)
    assert (await quota(client, ann))["used_bytes"] == 0
    att = await attach(client, ann, room)
    q = await quota(client, ann)
    assert q["used_bytes"] == len(WORDS) and q["rooms_bytes"] == len(WORDS)
    # The sender's, nobody else's: not the people it was sent to.
    await say(client, ann, room, "", attachment_ids=[att["id"]])
    assert (await quota(client, bob))["used_bytes"] == 0
    # Deleting the message gives the space back once its files are wiped.
    from datetime import timedelta

    from app.rooms import service

    m = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(ann))).json()
    mid = [x for x in (m["messages"] if isinstance(m, dict) else m) if x["attachments"]][0]["id"]
    await client.delete(f"/api/rooms/messages/{mid}", headers=H(ann))
    await service.purge_deleted(db, older_than=timedelta(seconds=-5))
    assert (await quota(client, ann))["used_bytes"] == 0


async def test_a_file_that_would_not_fit_is_refused(client, db, people):
    ann, bob, _ = people
    _sid, room = await make_space(client, ann, bob)
    await cap(db, ann, len(WORDS) + 10)
    await attach(client, ann, room)
    # The second copy would go over: refused, and nothing of it is kept.
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(ann), files={"file": ("again.txt", WORDS, "text/plain")})
    assert r.status_code == 413 and "storage limit" in r.json()["detail"]
    assert (await quota(client, ann))["used_bytes"] == len(WORDS)
    from app.rooms.models import RoomAttachment

    assert len((await db.execute(select(RoomAttachment))).scalars().all()) == 1
    # Already full: refused before a byte is read.
    await cap(db, ann, len(WORDS))
    r = await client.post(f"/api/rooms/rooms/{room}/attachments", headers=H(ann), files={"file": ("x.txt", b"x", "text/plain")})
    assert r.status_code == 413 and "reached your storage limit" in r.json()["detail"]
    # Drive uploads see the Rooms file too: it's one storage.
    r = await client.post("/api/files/", files={"file": ("note.txt", b"hello", "text/plain")}, data={"scope": "mine"}, headers=H(ann))
    assert r.status_code == 413
    # Bob's storage is his own.
    await attach(client, bob, room, "bobs.txt")


# ------------------------------------------------------------------ your list, and removing


async def test_your_rooms_uploads_are_listed_only_to_you(client, db, people):
    ann, bob, cat = people
    _sid, room = await make_space(client, ann, bob, name="Family")
    dm = (await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})).json()
    a1 = await attach(client, ann, room, "one.txt")
    await say(client, ann, room, "here", attachment_ids=[a1["id"]])
    a2 = await attach(client, ann, dm["id"], "two.txt")
    await say(client, ann, dm["id"], "", attachment_ids=[a2["id"]])
    waiting = await attach(client, ann, room, "not-sent-yet.txt")
    b1 = await attach(client, bob, room, "bobs.txt")
    await say(client, bob, room, "", attachment_ids=[b1["id"]])

    got = (await client.get("/api/rooms/uploads", headers=H(ann))).json()
    names = {i["filename"]: i for i in got["items"]}
    assert set(names) == {"one.txt", "two.txt", "not-sent-yet.txt"}
    assert got["count"] == 3 and got["bytes"] == 3 * len(WORDS)
    assert names["one.txt"]["sent"] and "Family" in names["one.txt"]["room"]
    assert names["two.txt"]["room"] == bob.username
    assert not names["not-sent-yet.txt"]["sent"]
    assert (await client.get(names["one.txt"]["url"])).status_code == 200
    # Someone with nothing sent sees nothing, whatever rooms they're in.
    assert (await client.get("/api/rooms/uploads", headers=H(cat))).json()["items"] == []
    assert [i["filename"] for i in (await client.get("/api/rooms/uploads", headers=H(bob))).json()["items"]] == ["bobs.txt"]
    # Pages.
    first = (await client.get("/api/rooms/uploads?limit=2", headers=H(ann))).json()
    assert len(first["items"]) == 2 and first["next_before"]
    rest = (await client.get("/api/rooms/uploads", params={"limit": 2, "before": first["next_before"]}, headers=H(ann))).json()
    assert len(rest["items"]) == 1 and rest["next_before"] is None
    assert waiting["id"] in {i["id"] for i in first["items"] + rest["items"]}


async def test_removing_your_file_leaves_file_removed_on_the_message(client, db, people):
    from app.files.storage import absolute_path
    from app.rooms import service
    from app.rooms.models import RoomAttachment

    ann, bob, _ = people
    _sid, room = await make_space(client, ann, bob)
    att = await attach(client, ann, room, "holiday.txt")
    msg = await say(client, ann, room, "see attached", attachment_ids=[att["id"]])
    path = absolute_path(service.att_path(await db.get(RoomAttachment, uuid.UUID(att["id"]))))
    assert path.exists()

    # Only the person who sent it.
    assert (await client.delete(f"/api/rooms/uploads/{att['id']}", headers=H(bob))).status_code == 404
    assert path.exists()
    assert (await client.delete(f"/api/rooms/uploads/{att['id']}", headers=H(ann))).status_code == 204
    assert not path.exists()
    assert (await client.get(att["url"])).status_code == 404
    assert (await quota(client, ann))["used_bytes"] == 0
    assert (await client.get("/api/rooms/uploads", headers=H(ann))).json()["items"] == []

    # The message is still there, for everyone, and says what's gone.
    r = (await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))).json()
    rows = r["messages"] if isinstance(r, dict) else r
    got = [m for m in rows if m["id"] == msg["id"]][0]
    assert got["body"] == "see attached" and got["attachments"] == []
    assert got["removed_attachments"] == [{"id": att["id"], "filename": "holiday.txt", "mime": "text/plain"}]
    # Twice is a 404, not an error.
    assert (await client.delete(f"/api/rooms/uploads/{att['id']}", headers=H(ann))).status_code == 404

    # One that was never sent just goes.
    waiting = await attach(client, ann, room, "draft.txt")
    assert (await client.delete(f"/api/rooms/uploads/{waiting['id']}", headers=H(ann))).status_code == 204
    assert await db.get(RoomAttachment, uuid.UUID(waiting["id"])) is None


# ------------------------------------------------------------------ big files (in pieces)


def _event(user, *, size, meta, upload_id="", offset=0):
    from app.auth.utils import create_access_token

    token = create_access_token(user.id, token_version=user.token_version)
    return {
        "Upload": {"ID": upload_id, "Size": size, "SizeIsDeferred": False, "Offset": offset, "MetaData": meta, "IsPartial": False, "IsFinal": False},
        "HTTPRequest": {"Method": "POST", "URI": "/api/files/tus/", "Header": {"Authorization": [f"Bearer {token}"], "X-Real-Ip": ["203.0.113.7"]}},
    }


async def _hook(client, hook, event):
    r = await client.post("/api/internal/tus-hook", json={"Type": hook, "Event": event})
    assert r.status_code == 200, r.text
    return r.json()


def _refusal(reply) -> tuple[int, str]:
    resp = reply["HTTPResponse"]
    return resp["StatusCode"], json.loads(resp["Body"])["detail"]


async def test_a_big_file_arrives_in_pieces_and_is_still_not_a_drive_file(client, db, people, root):
    from app.files.models import UserFile
    from app.files.tus_hooks import TUS_DIR, _reserved_for
    from app.rooms import uploads

    ann, bob, cat = people
    _sid, room = await make_space(client, ann, bob)
    assert (await client.get("/api/rooms/uploads/policy", headers=H(ann))).json() == {
        "max_bytes": 1024**3, "direct_max_bytes": 50 * 1024 * 1024, "tus_endpoint": "/api/files/tus/",
    }
    data = b"frame " * 5000
    meta = {"filename": "holiday.mp4", "filetype": "video/mp4", "room_id": room}

    # Over 1 GB: told plainly where it can go instead. Not your room: no.
    code, detail = _refusal(await _hook(client, "pre-create", _event(ann, size=uploads.MAX_BYTES + 1, meta=meta)))
    assert code == 413 and "up to 1 GB" in detail and "Send to" in detail
    code, _ = _refusal(await _hook(client, "pre-create", _event(cat, size=len(data), meta=meta)))
    assert code == 404
    # Exactly 1 GB is fine; it's held against your storage while it's on its way.
    reply = await _hook(client, "pre-create", _event(ann, size=len(data), meta=meta))
    assert "RejectUpload" not in reply, reply
    upload_id = reply["ChangeFileInfo"]["ID"]
    assert await _reserved_for(ann.id) == len(data)

    d = root / TUS_DIR
    d.mkdir(exist_ok=True)
    (d / upload_id).write_bytes(data)
    reply = await _hook(client, "pre-finish", _event(ann, size=len(data), meta=meta, upload_id=upload_id, offset=len(data)))
    att_id = reply["HTTPResponse"]["Header"]["Upload-File-Id"]
    assert await _reserved_for(ann.id) == 0 and not (d / upload_id).exists()
    att = (await client.get(f"/api/rooms/uploads/{att_id}", headers=H(ann))).json()
    assert att["filename"] == "holiday.mp4" and att["size"] == len(data) and att["mime"] == "video/mp4"
    assert (await client.get(f"/api/rooms/uploads/{att_id}", headers=H(bob))).status_code == 404  # not yours to send
    m = await say(client, ann, room, "", attachment_ids=[att_id])
    got = await client.get(m["attachments"][0]["url"], headers={"Range": "bytes=0-5"})
    assert got.status_code == 206 and got.content == b"frame "  # a video can be played from the middle
    assert (await quota(client, ann))["rooms_bytes"] == len(data)
    assert (await db.execute(select(UserFile))).scalars().all() == []


async def test_a_big_file_that_would_not_fit_is_refused_before_it_is_sent(client, db, people, root):
    ann, bob, _ = people
    _sid, room = await make_space(client, ann, bob)
    await cap(db, ann, 1000)
    meta = {"filename": "big.bin", "room_id": room}
    code, detail = _refusal(await _hook(client, "pre-create", _event(ann, size=2000, meta=meta)))
    assert code == 413 and "storage limit" in detail
    # Two on their way at once can't both be let in.
    reply = await _hook(client, "pre-create", _event(ann, size=700, meta=meta))
    assert "RejectUpload" not in reply
    code, _ = _refusal(await _hook(client, "pre-create", _event(ann, size=700, meta=meta)))
    assert code == 413


async def test_without_resumable_uploads_the_limit_stays_one_requests_worth(client, people, monkeypatch):
    from app.config import get_settings
    from app.rooms import uploads

    monkeypatch.setattr(get_settings(), "TUS_ENABLED", False)
    assert uploads.max_bytes() == 50 * 1024 * 1024
    assert (await client.get("/api/rooms/uploads/policy", headers=H(people[0]))).json()["tus_endpoint"] is None


# ------------------------------------------------------------------ never read by AI


async def test_a_rooms_upload_is_out_of_reach_of_everything_ai(client, db, people, embedder, root):  # noqa: F811
    """Sent in Rooms, both ways (whole, and in pieces), with AI search on
    for everyone: no Drive file, nothing indexed, nothing embedded, and
    neither AI search nor the chat's file tools can find or open it."""
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.registry import get_tool
    from app.chat.tools.search_my_files import search_drive
    from app.custom_models.retrieval import retrieve_drive_context
    from app.files.drive_index import index_pass
    from app.files.models import DriveIndexState, FileFolder, UserFile
    from app.files.tus_hooks import TUS_DIR

    ann, bob, _ = people
    _sid, room = await make_space(client, ann, bob)
    for u in (ann, bob):
        r = await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=H(u))
        assert r.status_code == 200, r.text

    small = await attach(client, ann, room, "zebrafinch-ledger.txt")
    data = WORDS * 50
    meta = {"filename": "zebrafinch-archive.txt", "filetype": "text/plain", "room_id": room}
    upload_id = (await _hook(client, "pre-create", _event(ann, size=len(data), meta=meta)))["ChangeFileInfo"]["ID"]
    (root / TUS_DIR).mkdir(exist_ok=True)
    (root / TUS_DIR / upload_id).write_bytes(data)
    big = (await _hook(client, "pre-finish", _event(ann, size=len(data), meta=meta, upload_id=upload_id, offset=len(data))))["HTTPResponse"]["Header"]["Upload-File-Id"]
    await say(client, ann, room, "the ledger", attachment_ids=[small["id"], big])
    # A real Drive file beside them, to show the index is working at all.
    r = await client.post("/api/files/", files={"file": ("boiler.txt", b"Plumber quoted 340 for the boiler service.", "text/plain")}, data={"scope": "mine"}, headers=H(ann))
    assert r.status_code in (200, 201), r.text

    # 1. Not a Drive file, not a Drive folder.
    files = (await db.execute(select(UserFile))).scalars().all()
    assert [f.filename for f in files] == ["boiler.txt"]
    kinds = {f.system_kind for f in (await db.execute(select(FileFolder))).scalars().all()}
    assert not [k for k in kinds if k and "room" in k]

    # 2. The index pass takes the Drive file and only that.
    await index_pass(db)
    indexed = {s.file_id for s in (await db.execute(select(DriveIndexState))).scalars().all()}
    assert indexed == {files[0].id}
    stored = (await db.execute(text("SELECT string_agg(text, chr(32)) FROM knowledge_chunks"))).scalar() or ""
    assert "boiler" in stored and "zebrafinch" not in stored.lower() and "quince" not in stored.lower()
    assert not [t for t in embedder if "zebrafinch" in t.lower() or "quince" in t.lower()]

    # 3. AI search: the sender's and the receiver's.
    for u in (ann, bob):
        assert await retrieve_drive_context(db, reader_id=u.id, query="zebrafinch ledger quince tree") == []
        hits = await search_drive(db, u.id, "zebrafinch ledger quince")
        assert not [h for h in hits if "zebrafinch" in json.dumps(h, default=str).lower()]
    assert await retrieve_drive_context(db, reader_id=ann.id, query="plumber boiler")

    # 4. The chat's file tools: can't list it, can't open it by its id.
    ctx = ToolContext(db=db, user=ann, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4())
    listed = (await get_tool("list_my_files").run(ctx, {})).content
    assert "boiler.txt" in listed and "zebrafinch" not in listed.lower()
    for att_id in (small["id"], big):
        with pytest.raises(ToolError):
            await get_tool("read_file").run(ctx, {"file_id": att_id})

    # 5. Drive's own search (plain words, no AI) doesn't have it either: it
    # isn't in Drive. It's found where it was sent, in Rooms.
    r = await client.get("/api/files/search", params={"q": "zebrafinch"}, headers=H(ann))
    assert r.status_code == 200 and r.json()["hits"] == [] and r.json()["related"] == []
