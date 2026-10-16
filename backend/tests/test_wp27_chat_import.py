"""Chat import/export (WP-2.7): branches, hidden nodes, round trips,
idempotency, zip caps, permissions and audit (R-306…R-310, R-313, R-316,
R-325, R-326, R-328, R-330)."""
from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import datetime, timezone

import httpx
import pytest

from app.chat import import_ as importer


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _gpt_msg(role, text, *, ct="text", recipient="all", meta=None):
    return {
        "author": {"role": role},
        "content": {"content_type": ct, "parts": [text]},
        "recipient": recipient,
        "metadata": meta or {},
    }


def _gpt_export(conv_id="c-1", title="Trip plan"):
    mapping = {
        "root": {"message": None, "parent": None, "children": ["ctx"]},
        "ctx": {
            "message": {"author": {"role": "user"}, "content": {"content_type": "user_editable_context"}},
            "parent": "root", "children": ["u1"],
        },
        "u1": {"message": _gpt_msg("user", "Plan a trip"), "parent": "ctx", "children": ["a1", "a2"]},
        "a1": {"message": _gpt_msg("assistant", "rejected draft"), "parent": "u1", "children": []},
        "a2": {"message": _gpt_msg("assistant", "Kept answer citeturn0."), "parent": "u1", "children": ["th"]},
        "th": {"message": _gpt_msg("assistant", "", ct="thoughts"), "parent": "a2", "children": ["tool"]},
        "tool": {"message": _gpt_msg("assistant", 'search("x")', ct="code", recipient="web"), "parent": "th", "children": ["u2"]},
        "u2": {"message": _gpt_msg("user", "And day two?"), "parent": "tool", "children": []},
    }
    return [{"title": title, "conversation_id": conv_id, "mapping": mapping, "current_node": "u2"}]


async def _import(client, user, payload: bytes, name="conversations.json", **form):
    return await client.post(
        "/api/chat/conversations/import",
        files={"file": (name, payload, "application/json")},
        data={k: v for k, v in form.items() if v is not None},
        headers=_auth(user),
    )


# ---------------------------------------------------------- R-306 / R-313


def test_chatgpt_follows_the_kept_branch_and_skips_hidden_rows():
    parsed = importer._dispatch_json(_gpt_export())
    msgs = [(m.role, m.content) for m in parsed[0].messages]
    assert msgs == [("user", "Plan a trip"), ("assistant", "Kept answer ."), ("user", "And day two?")]
    assert parsed[0].source_key == "chatgpt:c-1"


def test_chatgpt_without_current_node_takes_the_newest_branch():
    data = _gpt_export()
    del data[0]["current_node"]
    msgs = [m.content for m in importer._dispatch_json(data)[0].messages]
    assert "rejected draft" not in msgs and "Kept answer ." in msgs


# ---------------------------------------------------------------- R-330


def test_claude_keeps_attachments_and_artifacts_and_the_active_branch():
    data = [{
        "uuid": "k1", "name": "Review", "chat_messages": [
            {"uuid": "1", "parent_message_uuid": "0", "sender": "human", "text": "Check this",
             "attachments": [{"file_name": "nda.txt", "extracted_content": "Term: 2 years"}]},
            {"uuid": "2", "parent_message_uuid": "1", "sender": "assistant", "content": [{"type": "text", "text": "old"}]},
            {"uuid": "3", "parent_message_uuid": "1", "sender": "assistant", "content": [
                {"type": "text", "text": "Looks fine"},
                {"type": "tool_use", "name": "artifacts", "input": {"title": "Summary", "content": "- 2 years"}},
            ]},
        ],
    }]
    msgs = importer._dispatch_json(data)[0].messages
    assert len(msgs) == 2
    assert "Term: 2 years" in msgs[0].content and "nda.txt" in msgs[0].content
    assert "Looks fine" in msgs[1].content and "- 2 years" in msgs[1].content


# ---------------------------------------------------------------- R-325


def test_markdown_split_ignores_headings_inside_code_fences():
    md = "## User\n\nShow me\n\n## Assistant\n\n```md\n## User\nhi\n```\n\n---\n\nmore\n"
    msgs = importer._parse_markdown_transcript(md).messages
    assert [m.role for m in msgs] == ["user", "assistant"]
    assert "## User" in msgs[1].content and "---" in msgs[1].content


# ---------------------------------------------------------------- R-308


def test_zip_members_over_the_cap_are_refused(monkeypatch):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("conversations.json", json.dumps(_gpt_export()) + " " * 5000)
    monkeypatch.setattr(importer, "MAX_ZIP_MEMBER_BYTES", 1000)
    with pytest.raises(importer.ImportError, match="too large"):
        importer.parse_upload(filename="x.zip", content_type=None, data=buf.getvalue())


def test_a_workspace_bundle_is_refused_with_a_clear_message():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", "{}")
        zf.writestr("chats/a.md", "## User\n\nhi")
    with pytest.raises(importer.ImportError, match="workspace export"):
        importer.parse_upload(filename="x.zip", content_type=None, data=buf.getvalue())


# ---------------------------------------------------------- R-309 / R-328


@pytest.mark.asyncio
async def test_reimporting_skips_chats_already_here_and_keeps_titles(client, db, user):
    from app.chat.models import Conversation

    payload = json.dumps(_gpt_export(conv_id="dup-1")).encode()
    r = await _import(client, user, payload)
    assert r.status_code == 201, r.text
    assert r.json()["imported"] == 1
    r2 = await _import(client, user, payload)
    assert r2.json()["imported"] == 0 and r2.json()["duplicates"] == 1

    conv = await db.get(Conversation, uuid.UUID(r.json()["conversations"][0]["id"]))
    assert conv.title == "Trip plan" and conv.title_refined is True


@pytest.mark.asyncio
async def test_a_nul_byte_doesnt_fail_the_import(client, user):
    data = _gpt_export(conv_id="nul-1")
    data[0]["mapping"]["u1"]["message"]["content"]["parts"] = ["Plan\x00 a trip"]
    r = await _import(client, user, json.dumps(data).encode())
    assert r.status_code == 201, r.text
    assert r.json()["imported"] == 1 and not r.json()["failed"]


# ---------------------------------------------------------------- R-307


@pytest.mark.asyncio
async def test_json_round_trip_keeps_regenerations_as_siblings(client, db, user, conversation):
    from sqlalchemy import select

    from app.chat.models import Conversation, Message
    from app.chat.versioning import active_path

    q = Message(conversation_id=conversation.id, role="user", content="Question")
    db.add(q)
    await db.flush()
    old = Message(conversation_id=conversation.id, role="assistant", content="First try", parent_id=q.id)
    new = Message(conversation_id=conversation.id, role="assistant", content="Second try", parent_id=q.id)
    db.add_all([old, new])
    await db.flush()
    conversation.active_leaf_message_id = new.id
    await db.commit()

    md = await client.get(f"/api/chat/conversations/{conversation.id}/export?fmt=markdown", headers=_auth(user))
    assert "Second try" in md.text and "First try" not in md.text

    js = await client.get(f"/api/chat/conversations/{conversation.id}/export?fmt=json", headers=_auth(user))
    assert js.status_code == 200
    r = await _import(client, user, js.content, name="chat.json")
    assert r.status_code == 201, r.text
    new_id = uuid.UUID(r.json()["conversations"][0]["id"])
    conv = await db.get(Conversation, new_id)
    rows = list((await db.execute(
        select(Message).where(Message.conversation_id == new_id).order_by(Message.created_at, Message.id)
    )).scalars())
    assert len(rows) == 3
    assert [m.content for m in active_path(rows, conv.active_leaf_message_id)] == ["Question", "Second try"]


# ---------------------------------------------------------- R-316 / R-310


@pytest.mark.asyncio
async def test_export_and_import_are_audited_and_export_all_reimports(client, db, user, conversation):
    from sqlalchemy import func, select

    from app.auth.events import AuthEvent
    from app.chat.models import Message

    db.add(Message(conversation_id=conversation.id, role="user", content="Hello there"))
    await db.commit()
    await client.get(f"/api/chat/conversations/{conversation.id}/export?fmt=json", headers=_auth(user))
    bundle = await client.get("/api/chat/exports/conversations", headers=_auth(user))
    assert bundle.status_code == 200, bundle.text
    assert bundle.json()["format"] == "promptly.conversations"
    r = await _import(client, user, bundle.content, name="all.json")
    assert r.status_code == 201 and r.json()["imported"] >= 1

    kinds = set((await db.execute(
        select(AuthEvent.event_type).where(AuthEvent.user_id == user.id)
    )).scalars())
    assert {"conversation.exported", "conversations.exported", "conversations.imported"} <= kinds
    assert await db.scalar(select(func.count()).select_from(AuthEvent)) >= 3


# ---------------------------------------------------------------- R-326


@pytest.mark.asyncio
async def test_an_editor_can_import_into_a_shared_workspace(client, db, user):
    from app.auth.models import User
    from app.chat.models import WorkspaceShare

    r = await client.post("/api/workspaces", json={"title": "Team"}, headers=_auth(user))
    ws_id = r.json()["id"]
    editor = User(email=f"e{uuid.uuid4().hex[:6]}@x.com", username=f"ed{uuid.uuid4().hex[:6]}",
                  password_hash="x", role="user")
    viewer = User(email=f"v{uuid.uuid4().hex[:6]}@x.com", username=f"vi{uuid.uuid4().hex[:6]}",
                  password_hash="x", role="user")
    db.add_all([editor, viewer])
    await db.flush()
    for u, role in ((editor, "editor"), (viewer, "viewer")):
        db.add(WorkspaceShare(workspace_id=uuid.UUID(ws_id), inviter_user_id=user.id, invitee_user_id=u.id,
                              status="accepted", role=role, accepted_at=datetime.now(timezone.utc)))
    await db.commit()
    await db.refresh(editor)
    await db.refresh(viewer)

    payload = json.dumps(_gpt_export(conv_id="ws-1")).encode()
    r = await _import(client, editor, payload, workspace_id=ws_id)
    assert r.status_code == 201, r.text
    r = await _import(client, viewer, json.dumps(_gpt_export(conv_id="ws-2")).encode(), workspace_id=ws_id)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_messages_without_timestamps_keep_their_order(client, db, user):
    """They all got one shared now(), so anything ordered by created_at
    shuffled them."""
    from sqlalchemy import select

    from app.chat.models import Message

    r = await _import(client, user, json.dumps(_gpt_export(conv_id="order-1")).encode())
    cid = uuid.UUID(r.json()["conversations"][0]["id"])
    rows = (await db.execute(
        select(Message.content).where(Message.conversation_id == cid).order_by(Message.created_at, Message.id)
    )).scalars().all()
    assert list(rows) == ["Plan a trip", "Kept answer .", "And day two?"]


def test_a_child_listed_before_its_parent_still_imports_parent_first():
    """Rows sharing a timestamp can export child-first; the batched insert
    checks parent_id row by row."""
    from app.chat.router import _import_rows

    pm = importer.ParsedMessage
    a, b, c = (str(uuid.uuid4()) for _ in range(3))
    parsed = importer.ParsedConversation(title="t", active_leaf_source_id=b, messages=[
        pm(role="assistant", content="Second try", source_id=b, parent_source_id=a),
        pm(role="assistant", content="First try", source_id=c, parent_source_id=a),
        pm(role="user", content="Question", source_id=a, parent_source_id=None),
    ])
    rows, leaf, _ = _import_rows(uuid.uuid4(), parsed, 100, datetime.now(timezone.utc))
    assert rows[0].content == "Question"
    assert {r.parent_id for r in rows[1:]} == {rows[0].id}
    assert leaf == next(r.id for r in rows if r.content == "Second try")
