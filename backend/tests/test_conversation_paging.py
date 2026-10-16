"""The sidebar can reach every chat (WP-1.3, R-047/R-098).

It loaded the 50 most recent conversations, once, and never asked for
more: older chats simply vanished. Workspace chats (filtered out in the
browser) used up the 50, so heavy workspace users saw almost nothing, and
folders looked empty when their chats weren't in that first page. The
Archive stopped at 200.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest


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


def _auth(user) -> dict[str, str]:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _chats(db, user, n: int, **fields) -> list[uuid.UUID]:
    from app.chat.models import Conversation

    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    rows = []
    for i in range(n):
        # Every third chat shares a timestamp with its neighbour, so paging
        # can't lean on updated_at alone.
        rows.append(Conversation(user_id=user.id, title=f"chat {i}", updated_at=base + timedelta(minutes=i // 3),
                                 **fields))
    db.add_all(rows)
    await db.commit()
    return [r.id for r in rows]


def _cursor(row: dict, archived: bool = False) -> str:
    if archived:
        return f"{row['archived_at']}|{row['id']}"
    return f"{int(row['pinned'])}|{row['updated_at']}|{row['id']}"


async def _page_all(client, user, archived: bool = False, **params) -> list[dict]:
    seen: list[dict] = []
    cursor = None
    for _ in range(50):
        q = {"limit": 50, "archived": archived, **params}
        if cursor:
            q["cursor"] = cursor
        r = await client.get("/api/chat/conversations", params=q, headers=_auth(user))
        assert r.status_code == 200, r.text
        page = r.json()
        seen.extend(page)
        if len(page) < 50:
            return seen
        cursor = _cursor(page[-1], archived)
    raise AssertionError("never reached the end")


async def test_every_chat_is_reachable_page_by_page(db, user, client):
    ids = await _chats(db, user, 130)

    rows = await _page_all(client, user, scope="personal")

    assert len(rows) == 130
    assert {r["id"] for r in rows} == {str(i) for i in ids}


async def test_workspace_chats_dont_use_up_the_sidebar(db, user, client):
    from app.chat.models import Workspace

    ws = Workspace(user_id=user.id, title="Busy workspace")
    db.add(ws)
    await db.commit()
    await _chats(db, user, 60, workspace_id=ws.id)
    mine = await _chats(db, user, 5)

    r = await client.get("/api/chat/conversations", params={"limit": 50, "scope": "personal"}, headers=_auth(user))

    assert {c["id"] for c in r.json()} == {str(i) for i in mine}


async def test_a_folder_lists_its_own_chats(db, user, client):
    from app.chat.models import ChatFolder

    folder = ChatFolder(user_id=user.id, name="Taxes")
    db.add(folder)
    await db.commit()
    filed = await _chats(db, user, 3, folder_id=folder.id)
    loose = await _chats(db, user, 4)

    inside = await client.get("/api/chat/conversations",
                              params={"scope": "personal", "folder": str(folder.id)}, headers=_auth(user))
    outside = await client.get("/api/chat/conversations",
                               params={"scope": "personal", "folder": "none"}, headers=_auth(user))

    assert {c["id"] for c in inside.json()} == {str(i) for i in filed}
    assert {c["id"] for c in outside.json()} == {str(i) for i in loose}


async def test_the_archive_reaches_past_200_and_can_search_titles(db, user, client):
    now = datetime.now(timezone.utc)
    await _chats(db, user, 230, archived_at=now)

    rows = await _page_all(client, user, archived=True)
    assert len(rows) == 230

    r = await client.get("/api/chat/conversations", params={"archived": True, "q": "chat 21"}, headers=_auth(user))
    titles = {c["title"] for c in r.json()}
    assert "chat 21" in titles and "chat 210" in titles and "chat 5" not in titles


async def test_pinned_chats_come_first_across_pages(db, user, client):
    from app.chat.models import Conversation

    ids = await _chats(db, user, 70)
    pin = await db.get(Conversation, ids[0])  # the oldest
    pin.pinned = True
    await db.commit()

    r = await client.get("/api/chat/conversations", params={"limit": 50, "scope": "personal"}, headers=_auth(user))
    assert r.json()[0]["id"] == str(ids[0])
