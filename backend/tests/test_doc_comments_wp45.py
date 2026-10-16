"""Comments on documents and notes (WP-4.5, R-227): threads anchored in
the text, replies, resolve, @-mentions and reply notifications, and the
same access rules as the document (view → read, edit → comment)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

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


@pytest.fixture
def sent(monkeypatch):
    import app.notifications as notifications

    out: list[dict] = []

    async def fake(**kw):
        out.append(kw)

    monkeypatch.setattr(notifications, "notify_user", fake)
    return out


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


async def _doc(client, owner, title="Plan"):
    r = await client.post("/api/files/office", json={"kind": "document", "title": title}, headers=_auth(owner))
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _grant(client, owner, file_id, grantee, can_edit):
    r = await client.post(f"/api/files/file/{file_id}/grants",
                          json={"grantee_user_id": str(grantee.id), "can_edit": can_edit}, headers=_auth(owner))
    assert r.status_code in (200, 201), r.text


ANCHOR = {"from": "AQIDBA==", "to": "BQYHCA=="}


@pytest.mark.asyncio
async def test_a_thread_is_anchored_replied_to_resolved_and_deleted(client, db, user, sent):
    doc = await _doc(client, user)
    base = f"/api/documents/{doc}/comments"
    r = await client.post(base, json={"body": "Is this date right?", "quote": "31 March", "anchor": ANCHOR},
                          headers=_auth(user))
    assert r.status_code == 201, r.text
    root = r.json()
    assert root["anchor"] == ANCHOR and root["quote"] == "31 March" and root["parent_id"] is None
    assert root["can_edit"] and root["can_delete"] and root["author"]["username"] == user.username

    reply = (await client.post(base, json={"body": "Yes", "parent_id": root["id"]}, headers=_auth(user))).json()
    assert reply["parent_id"] == root["id"] and reply["anchor"] is None
    # A reply to a reply still hangs off the thread's root.
    nested = (await client.post(base, json={"body": "Thanks", "parent_id": reply["id"]}, headers=_auth(user))).json()
    assert nested["parent_id"] == root["id"]

    r = await client.post(f"{base}/{root['id']}/resolve", json={"resolved": True}, headers=_auth(user))
    assert r.json()["resolved_at"] and r.json()["resolved_by"] == user.username
    r = await client.patch(f"{base}/{reply['id']}", json={"body": "Yes — checked"}, headers=_auth(user))
    assert r.json()["body"] == "Yes — checked" and r.json()["edited_at"]

    listing = (await client.get(base, headers=_auth(user))).json()
    assert listing["can_comment"] is True and len(listing["comments"]) == 3
    assert (await client.delete(f"{base}/{root['id']}", headers=_auth(user))).status_code == 204
    assert (await client.get(base, headers=_auth(user))).json()["comments"] == []  # replies went with it


@pytest.mark.asyncio
async def test_access_follows_the_document(client, db, user, sent):
    doc = await _doc(client, user, "Budget")
    base = f"/api/documents/{doc}/comments"
    viewer, editor, stranger = await _user(db, "vic"), await _user(db, "eve"), await _user(db, "sam")
    await _grant(client, user, doc, viewer, can_edit=False)
    await _grant(client, user, doc, editor, can_edit=True)

    # The editor comments and mentions the owner; the owner hears about it.
    sent.clear()
    r = await client.post(base, json={"body": f"@{user.username} can you check this?", "anchor": ANCHOR},
                          headers=_auth(editor))
    assert r.status_code == 201, r.text
    root = r.json()
    assert [s["user_id"] for s in sent] == [user.id]
    assert "mentioned you" in sent[0]["title"] and sent[0]["url"] == f"/files/doc/{doc}?comment={root['id']}"

    # The owner replies: the editor (a thread participant) is told.
    sent.clear()
    await client.post(base, json={"body": "On it", "parent_id": root["id"]}, headers=_auth(user))
    assert [s["user_id"] for s in sent] == [editor.id] and "replied" in sent[0]["title"]

    # A viewer reads but can't comment or resolve; a stranger sees nothing.
    listing = (await client.get(base, headers=_auth(viewer))).json()
    assert listing["can_comment"] is False and len(listing["comments"]) == 2
    assert (await client.post(base, json={"body": "hi"}, headers=_auth(viewer))).status_code == 403
    r = await client.post(f"{base}/{root['id']}/resolve", json={"resolved": True}, headers=_auth(viewer))
    assert r.status_code == 403
    assert (await client.get(base, headers=_auth(stranger))).status_code == 404

    # Only the author edits; the owner may delete anyone's comment.
    r = await client.patch(f"{base}/{root['id']}", json={"body": "changed"}, headers=_auth(user))
    assert r.status_code == 403
    people = {p["username"] for p in (await client.get(f"{base}/people", headers=_auth(editor))).json()}
    assert people == {user.username, viewer.username, editor.username}
    r = await client.delete(f"{base}/{root['id']}", headers=_auth(viewer))
    assert r.status_code == 403
    assert (await client.delete(f"{base}/{root['id']}", headers=_auth(user))).status_code == 204


@pytest.mark.asyncio
async def test_a_note_uses_the_workspace_roles(client, db, user, sent):
    from app.chat.models import WorkspaceShare

    r = await client.post("/api/workspaces", json={"title": "Team"}, headers=_auth(user))
    ws = r.json()["id"]
    r = await client.post(f"/api/workspaces/{ws}/items", json={"kind": "note", "title": "Minutes"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    item = r.json()
    doc = item["ref_id"]
    editor, viewer = await _user(db, "ed"), await _user(db, "vi")
    for member, role in ((editor, "editor"), (viewer, "viewer")):
        db.add(WorkspaceShare(workspace_id=uuid.UUID(ws), inviter_user_id=user.id, invitee_user_id=member.id,
                              status="accepted", role=role, accepted_at=datetime.now(timezone.utc)))
    await db.commit()

    base = f"/api/documents/{doc}/comments"
    sent.clear()
    r = await client.post(base, json={"body": f"@{viewer.username} see this", "anchor": ANCHOR}, headers=_auth(editor))
    assert r.status_code == 201, r.text
    assert sent and sent[0]["user_id"] == viewer.id
    assert sent[0]["url"] == f"/workspaces/{ws}?item={item['id']}&comment={r.json()['id']}"
    assert (await client.post(base, json={"body": "me too"}, headers=_auth(viewer))).status_code == 403
    assert (await client.get(base, headers=_auth(viewer))).json()["can_comment"] is False
    # The workspace owner moderates.
    r = await client.delete(f"{base}/{r.json()['id']}", headers=_auth(user))
    assert r.status_code == 204
