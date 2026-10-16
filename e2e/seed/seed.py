"""Prepare (or put away) the end-to-end test fixtures in a running stack.

Piped into the backend container by ``e2e/lib/stack.ts``:

    docker exec -i -e E2E_ACTION=setup -e E2E_PASSWORD=... Promptly-Backend python - < seed.py

``setup`` makes sure two ordinary users exist (alice, bob) with a fresh
password and clean security state, points them at the "E2E Mock"
provider (the fake model in ``e2e/mock-llm``), enables that provider, and
prints JSON with ids and freshly minted refresh tokens — the suite signs
in with those instead of the login form, so only the login test spends
the login rate limit.

``teardown`` disables the provider again, so outside a test run the fake
models don't show up in anyone's model picker.

Nothing else in the instance is touched: no app settings, no defaults,
no other users.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text

import app.db_models  # noqa: F401 — every mapper, so relationships resolve
from app.auth.models import User
from app.chat.models import ChatFolder, Conversation
from app.auth.utils import create_refresh_token, hash_password
from app.database import SessionLocal
from app.files.system_folders import seed_system_folders
from app.models_config.models import ModelProvider
from app.models_config.service import encrypt_api_key

PROVIDER_NAME = "E2E Mock"
MOCK_URL = os.environ.get("E2E_MOCK_URL", "http://promptly-e2e-mock:8000/v1")
MODELS = [
    {"id": "e2e-mock-chat", "display_name": "E2E Mock Chat", "context_window": 32000,
     "supports_vision": False, "supports_tools": False},
    {"id": "e2e-mock-vision", "display_name": "E2E Mock Vision", "context_window": 32000,
     "supports_vision": True, "supports_tools": False},
    # Accepts tool definitions (and ignores them), so a turn sends the
    # full tool set — what the context meter checks measure.
    {"id": "e2e-mock-tools", "display_name": "E2E Mock Tools", "context_window": 32000,
     "supports_vision": False, "supports_tools": True},
]
USERS = {
    "alice": ("e2e-alice@example.com", "e2e_alice"),
    "bob": ("e2e-bob@example.com", "e2e_bob"),
    # Signs in with an admin-chosen password and must pick her own first.
    "carol": ("e2e-carol@example.com", "e2e_carol"),
    # An administrator, for the admin screens (Backups, Users…).
    "dana": ("e2e-dana@example.com", "e2e_dana"),
}


async def _provider(db) -> ModelProvider | None:
    return (await db.execute(
        select(ModelProvider).where(ModelProvider.name == PROVIDER_NAME, ModelProvider.user_id.is_(None))
    )).scalar_one_or_none()


async def setup() -> dict:
    password = os.environ["E2E_PASSWORD"]
    async with SessionLocal() as db:
        provider = await _provider(db)
        if provider is None:
            provider = ModelProvider(name=PROVIDER_NAME, type="openai_compatible", user_id=None)
            db.add(provider)
        provider.base_url = MOCK_URL
        provider.api_key = encrypt_api_key("sk-e2e")
        provider.models = MODELS
        provider.enabled_models = None
        provider.enabled = True
        await db.flush()

        out: dict = {"provider_id": str(provider.id), "users": {}}
        pw_hash = hash_password(password)
        for key, (email, username) in USERS.items():
            user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
            created = user is None
            if created:
                user = User(email=email, username=username, password_hash=pw_hash, role="user")
                db.add(user)
            user.role = "admin" if key == "dana" else "user"
            user.email = email  # example.com: reserved domains like .test fail the API's EmailStr
            user.password_hash = pw_hash
            user.disabled = False
            user.locked_at = None
            user.failed_login_attempts = 0
            user.mfa_enrolled_method = None
            user.must_change_password = key == "carol"
            user.allowed_models = [m["id"] for m in MODELS]
            user.settings = {
                **(user.settings or {}),
                "memory_mode": "off",
                "default_web_search_mode": "off",
                "default_provider_id": str(provider.id),
                "default_model_id": MODELS[0]["id"],
            }
            await db.flush()
            if created:
                await seed_system_folders(db, user)
            if key == "alice":
                await _old_history(db, user)
            out["users"][key] = {
                "id": str(user.id),
                "email": email,
                "username": username,
                "refresh_token": create_refresh_token(user.id, token_version=user.token_version or 0),
            }
        await db.commit()
    return out


OLD_CHATS = 70


async def _old_history(db, user: User) -> None:
    """Chats from long ago, so the sidebar has more than one page to load
    (older chats used to be unreachable past the first 50), and a folder
    whose only chat is old (folders used to look empty). Created once."""
    prefix = "E2E archive-era chat"
    # Earlier runs' chats pile up (1,200+ after a few weeks) and the sidebar
    # test then can't reach the oldest in time: clear them, keep the seeded.
    try:
        async with db.begin_nested():
            await db.execute(
                text(
                    "DELETE FROM conversations WHERE user_id = :u AND title NOT LIKE :p "
                    "AND title <> 'E2E filed chat' AND created_at < now() - interval '10 minutes'"
                ),
                {"u": user.id, "p": f"{prefix}%"},
            )
    except Exception as exc:  # noqa: BLE001 — a leftover is only slower, never wrong
        print(f"(couldn't clear earlier runs' chats: {exc.__class__.__name__})")
    have = await db.scalar(
        select(func.count()).select_from(Conversation)
        .where(Conversation.user_id == user.id, Conversation.title.like(f"{prefix}%"))
    )
    base = datetime(2020, 1, 1, tzinfo=timezone.utc)
    for i in range(have or 0, OLD_CHATS):
        when = base + timedelta(hours=i)
        db.add(Conversation(user_id=user.id, title=f"{prefix} {i:02d}", created_at=when, updated_at=when))
    folder = (await db.execute(
        select(ChatFolder).where(ChatFolder.user_id == user.id, ChatFolder.name == "E2E old folder")
    )).scalar_one_or_none()
    if folder is None:
        folder = ChatFolder(user_id=user.id, name="E2E old folder")
        db.add(folder)
        await db.flush()
        when = datetime(2019, 6, 1, tzinfo=timezone.utc)
        db.add(Conversation(user_id=user.id, title="E2E filed chat", folder_id=folder.id,
                            created_at=when, updated_at=when))


async def teardown() -> dict:
    async with SessionLocal() as db:
        provider = await _provider(db)
        if provider is not None:
            provider.enabled = False
        # The test admin doesn't stay usable outside a run.
        dana = (await db.execute(select(User).where(User.username == USERS["dana"][1]))).scalar_one_or_none()
        if dana is not None:
            dana.disabled = True
            dana.token_version = (dana.token_version or 0) + 1
        await db.commit()
    return {"ok": True}


async def _clear_lockouts(user_ids: list[str], identifiers: list[str]) -> None:
    """Forget failed-login counters and login rate-limit buckets for the
    test accounts only, so back-to-back runs (two sign-ins each) don't trip
    the 5-per-minute per-account limit."""
    try:
        from redis.asyncio import Redis

        from app.config import get_settings

        r = Redis.from_url(get_settings().REDIS_URL)
        for uid in user_ids:
            async for key in r.scan_iter(match=f"login_fail:{uid}:*"):
                await r.delete(key)
        for ident in identifiers:
            async for key in r.scan_iter(match=f"LIMITS:LIMITER/login_ident/{ident}|*"):
                await r.delete(key)
        await r.aclose()
    except Exception:  # noqa: BLE001 — best effort
        pass


async def main() -> None:
    action = os.environ.get("E2E_ACTION", "setup")
    if action == "setup":
        result = await setup()
        await _clear_lockouts(
            [u["id"] for u in result["users"].values()],
            [x.lower() for pair in USERS.values() for x in pair],
        )
    else:
        result = await teardown()
    print("E2E_RESULT " + json.dumps(result))


asyncio.run(main())
