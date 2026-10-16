"""Memory import keeps what the export wrote down (R-329).

An export → import round trip used to rebuild only content / category /
pinned and force ``source='manual'``: usage counts and timestamps reset,
and every inferred fact came back labelled "stated" with the import date
as its learned date. The substring dedupe also threw away the richer of
two facts, and there was no way in for another assistant's plain-text
memory list. These tests pin each of those.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import inspect as sa_inspect, select

from app.memory.models import UserMemory


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {
        "Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"
    }


async def _rows(db, user) -> list[UserMemory]:
    # The identity key never lazy-loads, even after an earlier expire_all.
    uid = sa_inspect(user).identity[0]
    db.expire_all()
    return list(
        (
            await db.execute(
                select(UserMemory)
                .where(UserMemory.user_id == uid)
                .order_by(UserMemory.content)
            )
        )
        .scalars()
        .all()
    )


async def test_import_restores_metadata(db, user, client):
    created = "2024-03-01T10:00:00+00:00"
    updated = "2024-04-15T08:30:00+00:00"
    last_used = "2024-05-02T12:00:00Z"
    future = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()

    r = await client.post(
        "/api/memory/import",
        headers=_auth(user),
        json=[
            {
                "content": "User prefers dark roast coffee",
                "category": "preferences",
                "source": "auto",
                "times_used": 7,
                "created_at": created,
                "updated_at": updated,
                "last_used_at": last_used,
            },
            {
                # Implausible metadata is dropped, not fatal.
                "content": "User has two cats",
                "source": "something-else",
                "times_used": 99999,
                "created_at": future,
                "updated_at": "not a date",
            },
        ],
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"imported": 2, "updated": 0, "skipped": 0, "errors": 0}

    rows = {m.content: m for m in await _rows(db, user)}

    coffee = rows["User prefers dark roast coffee"]
    assert coffee.source == "auto"  # stays "inferred" in the prompt
    assert coffee.times_used == 7
    assert coffee.category == "preferences"
    assert coffee.created_at == datetime(2024, 3, 1, 10, 0, tzinfo=timezone.utc)
    assert coffee.updated_at == datetime(2024, 4, 15, 8, 30, tzinfo=timezone.utc)
    assert coffee.last_used_at == datetime(2024, 5, 2, 12, 0, tzinfo=timezone.utc)

    cats = rows["User has two cats"]
    assert cats.source == "manual"  # unknown source → manual
    assert cats.times_used == 1000  # clamped
    now = datetime.now(timezone.utc)
    # Future date ignored → falls back to "learned now".
    assert abs((cats.created_at - now).total_seconds()) < 300


async def test_export_import_round_trip(db, user, client):
    db.add(
        UserMemory(
            user_id=user.id,
            content="User is learning Rust",
            source="auto",
            times_used=4,
            created_at=datetime(2023, 11, 5, tzinfo=timezone.utc),
            updated_at=datetime(2023, 12, 1, tzinfo=timezone.utc),
        )
    )
    await db.commit()

    exported = (await client.get("/api/memory/export", headers=_auth(user))).json()
    assert (await client.delete("/api/memory", headers=_auth(user))).status_code == 204

    r = await client.post("/api/memory/import", headers=_auth(user), json=exported)
    assert r.json()["imported"] == 1

    [row] = await _rows(db, user)
    assert row.source == "auto"
    assert row.times_used == 4
    assert row.created_at == datetime(2023, 11, 5, tzinfo=timezone.utc)
    assert row.updated_at == datetime(2023, 12, 1, tzinfo=timezone.utc)


async def test_richer_import_updates_shorter_existing_fact(db, user, client):
    existing = UserMemory(
        user_id=user.id,
        content="User works at Acme",
        source="manual",
        embed_dim=768,
        embed_model="some-embedder",
        content_hash="0" * 32,
    )
    db.add(existing)
    await db.commit()

    r = await client.post(
        "/api/memory/import",
        headers=_auth(user),
        json=[
            {"content": "User works at Acme Corp as CTO", "category": "identity"},
            # Contained by what's now stored → skipped as before.
            {"content": "User works at Acme Corp"},
        ],
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"imported": 0, "updated": 1, "skipped": 1, "errors": 0}

    [row] = await _rows(db, user)
    assert row.id == existing.id
    assert row.content == "User works at Acme Corp as CTO"
    assert row.category == "identity"  # filled in, was empty
    # Stale vector bookkeeping cleared so it's re-embedded.
    assert row.embed_dim is None
    assert row.embed_model is None
    assert row.content_hash is None


async def test_plain_text_import_strips_bullets(db, user, client):
    text = (
        "# Memories from another assistant\n"
        "\n"
        "- User lives in Perth\n"
        "* User has a dog called Max\n"
        "• User drinks oat milk\n"
        "1. User plays chess\n"
        "2) User is vegetarian\n"
        "\n"
        "User speaks French\n"
    )
    r = await client.post(
        "/api/memory/import", headers=_auth(user), json={"text": text}
    )
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 6

    contents = [m.content for m in await _rows(db, user)]
    assert contents == sorted(
        [
            "User lives in Perth",
            "User has a dog called Max",
            "User drinks oat milk",
            "User plays chess",
            "User is vegetarian",
            "User speaks French",
        ]
    )
    rows = await _rows(db, user)
    assert {m.source for m in rows} == {"manual"}


async def test_plain_text_upload_body(db, user, client):
    """A .txt / .md sent as a text/plain body goes through the same path,
    including dedupe against what's already stored."""
    db.add(UserMemory(user_id=user.id, content="User likes tea", source="manual"))
    await db.commit()

    r = await client.post(
        "/api/memory/import",
        headers={**_auth(user), "Content-Type": "text/plain; charset=utf-8"},
        content="- User likes tea\n- User runs marathons\n".encode(),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"imported": 1, "updated": 0, "skipped": 1, "errors": 0}
    assert [m.content for m in await _rows(db, user)] == [
        "User likes tea",
        "User runs marathons",
    ]
