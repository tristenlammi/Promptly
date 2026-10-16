"""Photo actions from a chat (PH-4 follow-up): "make an album of these",
"add them to Holiday", "share it with Sam", "Sarah is my wife" — each a
proposal card the person applies; checked again when applied."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer_keys  # noqa: F401

T = datetime(2024, 3, 1, tzinfo=timezone.utc)


async def _conv(db, user, provider):
    from app.chat.models import Conversation

    c = Conversation(user_id=user.id, title="Photos", provider_id=provider.id, model_id="test-model")
    db.add(c)
    await db.commit()
    return c


async def _apply(client, user, meta):
    return await client.post(f"/api/chat/proposals/{meta['proposal_id']}/apply", headers=_auth(user))


@pytest.mark.asyncio
async def test_album_share_and_relationship_from_chat(client, db, user, provider, root, fake_ml):
    from app.auth.models import User
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.photos import ProposePhotoActionTool, SearchPhotosTool

    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.commit()
    beach = [await _scene(db, user, who=[sarah], lat=0.5, lon=0.5, when=T, beach=True) for _ in range(2)]
    await _scene(db, user, who=[], lat=0.5, lon=0.5, when=T)
    conv = await _conv(db, user, provider)
    ctx = ToolContext(db=db, user=user, conversation_id=conv.id, user_message_id=uuid.uuid4())
    tool = ProposePhotoActionTool()

    # "Make an album of Sarah's photos."
    found = (await SearchPhotosTool().run(ctx, {"people": ["Sarah"]})).meta["photo_results"]
    r = await tool.run(ctx, {"action": "album", "set_id": found["set_id"], "title": "Sarah"})
    assert r.meta["kind"] == "photo_album" and "2 photos" in r.meta["summary"]
    assert not await db.scalar(text("SELECT count(*) FROM albums"))  # nothing until applied
    applied = await _apply(client, user, r.meta)
    assert applied.status_code == 200, applied.text
    album_id = applied.json()["applied_item_id"]
    items = (await client.get(f"/api/photos/albums/{album_id}/items", headers=_auth(user))).json()["items"]
    assert {i["id"] for i in items} == {str(b) for b in beach}

    # "Share it with sam." — by exact username only.
    sam = User(email="sam@example.com", username=f"sam{uuid.uuid4().hex[:4]}", password_hash="x", role="user")
    db.add(sam)
    await db.commit()
    with pytest.raises(ToolError, match="Couldn't find"):
        await tool.run(ctx, {"action": "share", "album": "Sarah", "people": ["Samuel"]})
    r = await tool.run(ctx, {"action": "share", "album": "sarah", "people": ["sam@example.com"], "role": "contributor"})
    assert sam.username in r.meta["summary"]
    assert (await _apply(client, user, r.meta)).status_code == 200
    role = await db.scalar(text("SELECT role FROM album_members WHERE album_id = :a AND user_id = :u"), {"a": album_id, "u": sam.id})
    assert role == "contributor"

    # "Sarah is my wife." → then "me and my wife" finds her.
    r = await tool.run(ctx, {"action": "relationship", "person": "sarah", "label": "my wife"})
    assert (await _apply(client, user, r.meta)).status_code == 200
    kind = await db.scalar(text("SELECT kind FROM photo_relationships WHERE person_id = :p AND viewer_user_id = :u"), {"p": sarah, "u": user.id})
    assert kind == "spouse"
    with pytest.raises(ToolError, match="No one called"):
        await tool.run(ctx, {"action": "relationship", "person": "Zed", "label": "my brother"})

    # A smart album from the same search: it follows new photos.
    r = await tool.run(ctx, {"action": "album", "set_id": found["set_id"], "title": "Always Sarah", "smart": True})
    smart_id = (await _apply(client, user, r.meta)).json()["applied_item_id"]
    got = (await client.get(f"/api/photos/albums/{smart_id}", headers=_auth(user))).json()
    assert got["smart"] and got["count"] == 2

    # Someone else can't apply it, and a gone album fails softly.
    r = await tool.run(ctx, {"action": "album", "album": "Sarah", "file_ids": [str(beach[0])]})
    assert (await _apply(client, sam, r.meta)).status_code == 404
    await client.delete(f"/api/photos/albums/{album_id}", headers=_auth(user))
    gone = await _apply(client, user, r.meta)
    assert gone.status_code == 409 and "No album" in gone.json()["detail"]
