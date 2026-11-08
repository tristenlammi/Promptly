"""Looking after memory overnight.

Retires what has run its course, merges what says the same thing twice, and writes a
short profile. The profile is what's always in front of the model: someone planning
family dinners needs the allergy, and no search for "dinner" will find it. It's written
from the facts and nothing else, so the facts stay the truth and fixing one fixes it.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.database import SessionLocal
from app.memory.constants import ACTIVE, RETIRED
from app.memory.models import UserMemory, UserMemoryProfile
from app.memory.service import (
    consolidate_memories,
    fact_hash,
    load_memories,
    profile_is_stale,
    resolve_memory_mode,
    resolve_memory_model,
)
from app.models_config.provider import ChatMessage, model_router

logger = logging.getLogger("promptly.memory.upkeep")

# Not used in this long, and only inferred facts about what's going on. Who you are
# and how you like things don't go stale by sitting quietly.
STALE_AFTER = timedelta(days=180)
_STALE_CATEGORIES = ("projects", "context")
# Enough changes to be worth a model call to merge them.
_MERGE_AFTER_CHANGES = 5
_PROFILE_WORDS = 130
# Well over what the words need: a reply that hits the limit can come back empty.
_PROFILE_TOKENS = 1200
_PROFILE_FACTS = 300
# One stalled provider mustn't use up the night's job for everyone.
MODEL_CALL_SECONDS = 120

_PROFILE_PROMPT = (
    "Write a short profile of a user, for an AI assistant to keep in mind in every "
    "conversation with them. You are given the facts saved about them. Use ONLY these "
    f"facts; never add, guess or embellish. At most {_PROFILE_WORDS} words, in plain "
    "third-person sentences, most important first: who they are and what they do, the "
    "people close to them, anything that must always be respected (allergies, diet, health, "
    "how they want to be spoken to), then what they're working on now. Leave out passing "
    "detail. Output only the profile."
)


async def retire_expired(db: AsyncSession) -> int:
    """Plans whose day has been and gone."""
    now = datetime.now(timezone.utc)
    done = await db.execute(
        update(UserMemory)
        .where(UserMemory.status == ACTIVE, UserMemory.expires_at.is_not(None), UserMemory.expires_at <= now)
        .values(status=RETIRED, valid_until=UserMemory.expires_at, retired_reason="expired", pinned=False, updated_at=UserMemory.updated_at)
    )
    await db.commit()
    return done.rowcount or 0


async def retire_stale(db: AsyncSession, user_id: uuid.UUID) -> int:
    cutoff = datetime.now(timezone.utc) - STALE_AFTER
    done = await db.execute(
        update(UserMemory)
        .where(
            UserMemory.user_id == user_id,
            UserMemory.status == ACTIVE,
            UserMemory.source == "auto",
            UserMemory.pinned.is_(False),
            UserMemory.category.in_(_STALE_CATEGORIES),
            UserMemory.created_at < cutoff,
            UserMemory.updated_at < cutoff,
            or_(UserMemory.last_used_at.is_(None), UserMemory.last_used_at < cutoff),
        )
        .values(status=RETIRED, valid_until=datetime.now(timezone.utc), retired_reason="stale", updated_at=UserMemory.updated_at)
    )
    await db.commit()
    return done.rowcount or 0


def _fingerprint(facts: list[UserMemory]) -> str:
    joined = "\n".join(sorted(f"{m.id}:{m.content}" for m in facts))
    return fact_hash(joined)


async def refresh_profile(db: AsyncSession, user_id: uuid.UUID, *, force: bool = False) -> str | None:
    """Rewritten only when the facts have changed. Only what applies everywhere: a
    project's facts stay in that project."""
    facts = [m for m in await load_memories(db, user_id, limit=_PROFILE_FACTS, workspace=None)]
    profile = await db.get(UserMemoryProfile, user_id)
    if not facts:
        if profile is not None:
            await db.delete(profile)
            await db.commit()
        return None
    fingerprint = _fingerprint(facts)
    if profile is not None and profile.fingerprint == fingerprint and not force:
        return profile.content
    resolved = await resolve_memory_model(db, user_id=user_id)
    if resolved is None:
        return profile.content if profile is not None else None
    provider, model_id = resolved
    # Stated before inferred, and what's in use before what isn't.
    ordered = sorted(facts, key=lambda m: (m.source != "manual", not m.pinned, -(m.times_used or 0)))
    listing = "\n".join(f"- {m.content}" for m in ordered)
    chunks: list[str] = []
    async with asyncio.timeout(MODEL_CALL_SECONDS):
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=f"FACTS:\n{listing}")],
            system=_PROFILE_PROMPT,
            temperature=0.0,
            max_tokens=_PROFILE_TOKENS,
            reasoning_effort="off",
        ):
            chunks.append(token)
    written = "".join(chunks).strip()
    if not written:
        return profile.content if profile is not None else None
    hashes = {str(m.id): fact_hash(m.content) for m in facts}
    if profile is None:
        profile = UserMemoryProfile(user_id=user_id, content=written, fingerprint=fingerprint, generated_at=datetime.now(timezone.utc), source_hashes=hashes)
        db.add(profile)
    else:
        profile.content, profile.fingerprint, profile.generated_at, profile.source_hashes = written, fingerprint, datetime.now(timezone.utc), hashes
    await db.commit()
    return written


async def _changed_since_profile(db: AsyncSession, user_id: uuid.UUID) -> int:
    """New or changed facts since the profile was written, and so since the last merge."""
    profile = await db.get(UserMemoryProfile, user_id)
    known = profile.source_hashes if profile is not None else {}
    facts = await load_memories(db, user_id, limit=_PROFILE_FACTS, workspace=None)
    return sum(known.get(str(m.id)) != fact_hash(m.content) for m in facts)


async def upkeep_for(db: AsyncSession, user: User) -> dict[str, int]:
    """Self-managed means it never changes your facts by itself: it only writes the profile."""
    automatic = resolve_memory_mode(user) == "auto"
    out = {"stale": await retire_stale(db, user.id) if automatic else 0, "merged": 0}
    if automatic and await _changed_since_profile(db, user.id) >= _MERGE_AFTER_CHANGES:
        try:
            async with asyncio.timeout(MODEL_CALL_SECONDS):
                merged = await consolidate_memories(db, user_id=user.id, limit=_PROFILE_FACTS, changed_by="upkeep", unattended=True)
            await db.commit()
            out["merged"] = merged.get("removed", 0)
        except ValueError as e:  # no model, or its answer was cut off: try again tomorrow
            await db.rollback()
            logger.info("Memory merge skipped: %s", e)
    await refresh_profile(db, user.id)
    return out


async def refresh_stale_profiles() -> None:
    """A profile that mentions something now gone is left out of chats until rewritten, so
    rewrite it soon rather than tonight. Only when that has happened: it costs a model call."""
    async with SessionLocal() as db:
        profiles = list((await db.execute(select(UserMemoryProfile))).scalars())
        stale = [p.user_id for p in profiles if await profile_is_stale(db, p)]
    for user_id in stale:
        async with SessionLocal() as db:
            try:
                await refresh_profile(db, user_id)
            except Exception as e:  # noqa: BLE001
                await db.rollback()
                logger.warning("Couldn't rewrite a memory profile (%s)", type(e).__name__)


async def nightly() -> dict[str, int]:
    async with SessionLocal() as db:
        expired = await retire_expired(db)
        with_facts = set((await db.execute(select(UserMemory.user_id).where(UserMemory.status == ACTIVE).distinct())).scalars())
        # Someone whose last fact has gone still has a profile to clear.
        with_profile = set((await db.execute(select(UserMemoryProfile.user_id))).scalars())
        people = list(with_facts | with_profile)
    totals = {"expired": expired, "stale": 0, "merged": 0, "people": 0}
    for user_id in people:
        async with SessionLocal() as db:
            user = await db.get(User, user_id)
            if user is None or resolve_memory_mode(user) == "off":
                continue
            try:
                result = await upkeep_for(db, user)
                totals["stale"] += result["stale"]
                totals["merged"] += result["merged"]
                totals["people"] += 1
            except Exception as e:  # noqa: BLE001 — one person's model trouble is theirs alone
                await db.rollback()
                logger.warning("Memory upkeep failed for someone (%s)", type(e).__name__)
    return totals
