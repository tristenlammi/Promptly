"""Comments on every office file (WP-6.1): sheets anchor a thread to a cell,
whiteboards to shapes, with the same rules as documents (view → read,
edit → comment), @-mentions and links that open the right editor."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from tests.test_doc_comments_wp45 import _auth, _grant, _user, client, sent  # noqa: F401 — fixtures


async def _office(client, owner, kind, title="Budget"):
    r = await client.post("/api/files/office", json={"kind": kind, "title": title}, headers=_auth(owner))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_anchors_are_kept_only_when_they_fit_the_kind_of_file():
    from app.files.doc_comments_router import _clean_anchor

    assert _clean_anchor({"sheet": "s1", "r": 4, "c": 1, "x": "junk"}, "sheet") == {"kind": "cell", "sheet": "s1", "r": 4, "c": 1}
    assert _clean_anchor({"sheet": "s1", "tab": "Q1", "r": 0, "c": 0}, "sheet")["tab"] == "Q1"
    assert _clean_anchor({"sheet": "s1", "r": -1, "c": 1}, "sheet") is None
    assert _clean_anchor({"sheet": "s1", "r": True, "c": 1}, "sheet") is None
    assert _clean_anchor({"from": "AQ==", "to": "Ag=="}, "sheet") is None  # a text anchor on a sheet
    assert _clean_anchor({"ids": ["a1", "", 5, "b2"]}, "whiteboard") == {"kind": "element", "ids": ["a1", "b2"]}
    assert _clean_anchor({"ids": []}, "whiteboard") is None
    assert _clean_anchor({"from": "AQ==", "to": "Ag=="}, "document") == {"from": "AQ==", "to": "Ag=="}


@pytest.mark.asyncio
async def test_a_cell_comment_mentions_a_collaborator_and_links_to_the_sheet(client, db, user, sent):  # noqa: F811
    sheet = await _office(client, user, "sheet")
    pal, reader = await _user(db, "pal"), await _user(db, "ro")
    await _grant(client, user, sheet, pal, True)
    await _grant(client, user, sheet, reader, False)
    base = f"/api/documents/{sheet}/comments"

    sent.clear()
    r = await client.post(base, headers=_auth(user), json={
        "body": f"@{pal.username} is this total right?", "quote": "1,380",
        "anchor": {"sheet": "tab-1", "r": 4, "c": 1},
    })
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["anchor"] == {"kind": "cell", "sheet": "tab-1", "r": 4, "c": 1}
    assert [s["user_id"] for s in sent] == [pal.id]
    assert sent[0]["url"] == f"/files/sheet/{sheet}?comment={c['id']}"
    assert "Budget" in sent[0]["title"]

    # The collaborator replies (the author is told); a viewer reads but can't comment.
    sent.clear()
    r = await client.post(base, headers=_auth(pal), json={"body": "Yes — checked it", "parent_id": c["id"]})
    assert r.status_code == 201 and [s["user_id"] for s in sent] == [user.id]
    body = (await client.get(base, headers=_auth(reader))).json()
    assert body["can_comment"] is False and len(body["comments"]) == 2
    assert (await client.post(base, headers=_auth(reader), json={"body": "hi"})).status_code == 403
    stranger = await _user(db, "st")
    assert (await client.get(base, headers=_auth(stranger))).status_code == 404


@pytest.mark.asyncio
async def test_a_whiteboard_comment_points_at_shapes(client, db, user, sent):  # noqa: F811
    board = await _office(client, user, "whiteboard", title="Garden plan")
    base = f"/api/documents/{board}/comments"
    r = await client.post(base, headers=_auth(user), json={"body": "Move the shed?", "anchor": {"ids": ["shed-1", "path-2"]}})
    assert r.status_code == 201, r.text
    assert r.json()["anchor"] == {"kind": "element", "ids": ["shed-1", "path-2"]}
    # A malformed anchor leaves the comment on the board as a whole.
    r = await client.post(base, headers=_auth(user), json={"body": "General note", "anchor": {"from": "x", "to": "y"}})
    assert r.status_code == 201 and r.json()["anchor"] is None
    r = await client.post(f"{base}/{r.json()['id']}/resolve", headers=_auth(user), json={"resolved": True})
    assert r.status_code == 200 and r.json()["resolved_at"]


@pytest.mark.asyncio
async def test_a_workspace_sheet_uses_the_workspace_roles(client, db, user, sent):  # noqa: F811
    from app.chat.models import Spreadsheet, WorkspaceShare

    r = await client.post("/api/workspaces", json={"title": "Team"}, headers=_auth(user))
    ws = r.json()["id"]
    r = await client.post(f"/api/workspaces/{ws}/items", json={"kind": "sheet", "title": "Rota"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    item = r.json()
    sheet = (await db.execute(select(Spreadsheet).where(Spreadsheet.id == uuid.UUID(item["ref_id"])))).scalar_one()
    editor, viewer = await _user(db, "ed"), await _user(db, "vi")
    for member, role in ((editor, "editor"), (viewer, "viewer")):
        db.add(WorkspaceShare(workspace_id=uuid.UUID(ws), inviter_user_id=user.id, invitee_user_id=member.id,
                              status="accepted", role=role, accepted_at=datetime.now(timezone.utc)))
    await db.commit()

    base = f"/api/documents/{sheet.file_id}/comments"
    sent.clear()
    r = await client.post(base, headers=_auth(editor), json={
        "body": f"@{viewer.username} can you cover Tuesday?", "anchor": {"sheet": "s", "r": 2, "c": 3},
    })
    assert r.status_code == 201, r.text
    assert sent and sent[0]["user_id"] == viewer.id
    assert sent[0]["url"] == f"/workspaces/{ws}?item={item['id']}&comment={r.json()['id']}"
    people = {p["username"] for p in (await client.get(f"{base}/people", headers=_auth(editor))).json()}
    assert {user.username, editor.username, viewer.username} <= people
    assert (await client.post(base, headers=_auth(viewer), json={"body": "ok"})).status_code == 403
    # The workspace owner moderates.
    assert (await client.delete(f"{base}/{r.json()['id']}", headers=_auth(user))).status_code == 204
