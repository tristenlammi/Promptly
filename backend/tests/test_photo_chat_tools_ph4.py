"""Ask your photos in chat (PH-4): the model's structured question finds
the photos, the gallery card gets their ids and chips, a follow-up narrows
or widens the same set — and a photo card shows only the asker's photos."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from tests.test_photo_engine_ph4 import _scene, fake_ml  # noqa: F401
from tests.test_takeout_run_wp102 import _auth, client, root  # noqa: F401
from tests.test_understanding_ph21 import _gazetteer, _gazetteer_keys  # noqa: F401


@pytest.mark.asyncio
async def test_search_and_refine_in_chat(client, db, user, root, fake_ml):
    from app.chat.tools.base import ToolContext, ToolError
    from app.chat.tools.photos import RefinePhotoResultsTool, SearchPhotosTool, has_library
    from app.photos import places

    assert not await has_library(db, user.id)
    _gazetteer(places.local_dir())
    await places.load(db)
    me = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name, linked_user_id) VALUES (:u, 'person', 'Tris', :u) RETURNING id"), {"u": user.id})
    sarah = await db.scalar(text("INSERT INTO photo_people (user_id, kind, name) VALUES (:u, 'person', 'Sarah') RETURNING id"), {"u": user.id})
    await db.execute(text("INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind) VALUES (:u, :p, 'my wife', 'spouse')"), {"u": user.id, "p": sarah})
    await db.commit()
    noosa = await _scene(db, user, who=[me, sarah], lat=-26.39, lon=153.09, when=datetime(2022, 12, 27, tzinfo=timezone.utc), beach=True)
    madrid = await _scene(db, user, who=[me, sarah], lat=40.42, lon=-3.70, when=datetime(2023, 5, 1, tzinfo=timezone.utc))
    assert await has_library(db, user.id)

    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4())
    r = await SearchPhotosTool().run(ctx, {"people": ["me", "my wife"], "place": "Noosa"})
    card = r.meta["photo_results"]
    assert [i["id"] for i in card["items"]] == [str(noosa)] and "1 photo" in r.content
    assert card["understood"]["place"] == "Noosa Heads, Australia"

    # "What about anywhere?" — the same question without the place.
    r2 = await RefinePhotoResultsTool().run(ctx, {"set_id": card["set_id"], "remove": ["place"]})
    assert {i["id"] for i in r2.meta["photo_results"]["items"]} == {str(noosa), str(madrid)}
    assert r2.meta["photo_results"]["parent"] == card["set_id"]
    # "Only the beach ones."
    r3 = await RefinePhotoResultsTool().run(ctx, {"set_id": r2.meta["photo_results"]["set_id"], "add": {"looks_like": "on the beach"}})
    assert r3.meta["photo_results"]["items"][0]["id"] == str(noosa)

    with pytest.raises(ToolError):
        await SearchPhotosTool().run(ctx, {})
    with pytest.raises(ToolError):
        await RefinePhotoResultsTool().run(ctx, {"set_id": "nope"})

    # The card's photos, fresh — only yours.
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    theirs = await _scene(db, other, who=[], lat=0.5, lon=0.5, when=datetime(2022, 1, 1, tzinfo=timezone.utc))
    got = (await client.post("/api/photos/items", json={"ids": [str(madrid), str(theirs), str(noosa)]}, headers=_auth(user))).json()
    assert [i["id"] for i in got["items"]] == [str(madrid), str(noosa)]


@pytest.mark.asyncio
async def test_looking_at_the_photos(client, db, user, root, fake_ml, monkeypatch):
    """inspect_photos: the vision model answers per photo; a cloud model
    only for someone who agreed to send photos to it."""
    from types import SimpleNamespace

    from app.chat.tools import photos as tools
    from app.chat.tools.base import ToolContext, ToolError
    from app.photos import captions

    noosa = await _scene(db, user, who=[], lat=-26.39, lon=153.09, when=datetime(2022, 12, 27, tzinfo=timezone.utc), beach=True)
    other = await _scene(db, user, who=[], lat=-26.39, lon=153.09, when=datetime(2022, 11, 1, tzinfo=timezone.utc), beach=True)
    state = {"local": False}

    async def configured(db):
        return captions.Vision(SimpleNamespace(name="Cloudy"), "cloudy-1", state["local"], "cloudy-1 (Cloudy)", 100)

    async def ask(vision, preview, question, db):
        return ("yes", "two people smiling") if ask.n == 0 else ("no", "no one smiling")

    ask.n = 0

    async def ask_counted(vision, preview, question, db):
        r = await ask(vision, preview, question, db)
        ask.n += 1
        return r

    monkeypatch.setattr(captions, "configured", configured)
    monkeypatch.setattr(tools, "_ask", ask_counted)
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4())
    found = await tools.SearchPhotosTool().run(ctx, {"looks_like": "beach"})
    set_id = found.meta["photo_results"]["set_id"]
    with pytest.raises(ToolError, match="Describe my photos"):
        await tools.InspectPhotosTool().run(ctx, {"set_id": set_id, "question": "are we both smiling?"})
    state["local"] = True  # on this server: fine
    r = await tools.InspectPhotosTool().run(ctx, {"set_id": set_id, "question": "are we both smiling?"})
    assert "1 yes" in r.content and r.meta["photo_results"]["total"] == 1
    assert r.meta["photo_results"]["items"][0]["id"] in {str(noosa), str(other)}
