"""The memory scorecard: how well does it remember, on a made-up person?

Calls a real model, so it only runs when asked. Four scores, from the test set in
``memory_eval/golden.json``:

* captured   — what you said became a fact, and what you shouldn't keep didn't
* found      — the fact is in front of the model when the question needs it
* corrected  — a change of heart replaces the old fact and leaves the rest alone
* unanswered — nothing off-topic is injected, and it admits what it doesn't know

Run it with ``scripts/memory_scorecard.sh``. Published memory benchmarks are mostly
vendor-run and argued over, so this is the number to compare changes against.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import create_async_engine

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.utils import encrypt_secret
from app.custom_models.embedding import embed_texts
from app.memory.models import UserMemory, UserMemoryProfile
from app.chat.models import Conversation, Message
from app.chat.semantic_index import _upsert
from app.chat.semantic_search import get_embedding_config
from app.chat.tools.base import ToolContext
from app.chat.tools.past_chats import SearchPastChatsTool
from app.memory import capture as capture_module
from app.memory.capture import capture_conversation
from app.memory.service import build_memory_system_prompt, embed_memory_row
from app.memory.upkeep import refresh_profile
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, model_router

from .test_mail import mk_user

pytestmark = pytest.mark.skipif(not os.environ.get("MEMORY_EVAL"), reason="calls a real model: scripts/memory_scorecard.sh")

# golden.json was tuned against; holdout.json was written blind and is the honest number.
GOLDEN = json.loads((Path(__file__).parent / "memory_eval" / os.environ.get("MEMORY_EVAL_SET", "golden.json")).read_text(encoding="utf-8"))
MODEL = os.environ.get("MEMORY_EVAL_MODEL", "anthropic/claude-haiku-5.5")
RETRIEVAL_K = 10
SAYS_IT_DOESNT_KNOW = re.compile(r"\b(don'?t|do not|didn'?t|haven'?t|not sure|no record|no information|can'?t|cannot|isn'?t|unknown|not something)\b", re.I)


async def _real_provider() -> ModelProvider:
    """The chat model from the real install, read-only and never saved anywhere."""
    engine = create_async_engine(os.environ["MEMORY_EVAL_DB"])
    try:
        async with engine.connect() as conn:
            row = (await conn.execute(
                text("SELECT name, type, base_url, api_key, models FROM model_providers WHERE name = :n"),
                {"n": os.environ.get("MEMORY_EVAL_PROVIDER", "OpenRouter")},
            )).mappings().one()
    finally:
        await engine.dispose()
    return ModelProvider(id=uuid.uuid4(), name=row["name"], type=row["type"], base_url=row["base_url"], api_key=row["api_key"], enabled=True, models=row["models"], enabled_models=[MODEL])


async def _use_embedder(db) -> None:
    """Point this throwaway database at the bundled embedder."""
    provider = ModelProvider(name="Eval embedder", type="ollama", base_url=os.environ.get("MEMORY_EVAL_EMBEDDER", "http://ollama:11434/v1"), api_key=encrypt_secret("unused"), enabled=True, models=[], enabled_models=[])
    db.add(provider)
    await db.flush()
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        settings = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(settings)
    settings.embedding_provider_id = provider.id
    settings.embedding_model_id = os.environ.get("MEMORY_EVAL_EMBED_MODEL", "nomic-embed-text")
    settings.embedding_dim = 768
    await db.commit()
    # Loading the model takes longer than the wait a chat allows.
    await embed_texts(provider=provider, model_id=settings.embedding_model_id, texts=["warm up"])


async def _seed(db, user, facts: list[dict[str, str] | str]) -> None:
    for fact in facts:
        content = fact if isinstance(fact, str) else fact["text"]
        row = UserMemory(user_id=user.id, content=content, source="auto", category=None if isinstance(fact, str) else fact.get("category"))
        db.add(row)
        await db.flush()
        await embed_memory_row(db, row)
    await db.commit()


async def _facts(db, user) -> list[str]:
    # Waiting for approval counts: it was caught, and you're the one who decides.
    found = await db.execute(select(UserMemory).where(UserMemory.user_id == user.id, UserMemory.status.in_(("active", "suggested"))).execution_options(populate_existing=True))
    return [m.content.lower() for m in found.scalars()]


def _has(facts: list[str], group: list[str]) -> bool:
    return any(any(word in fact for word in group) for fact in facts)


async def _capture(db, user, provider, turns: list[list[str]]) -> None:
    """A conversation, the way a chat would see it."""
    conversation = Conversation(user_id=user.id, title="Chat", model_id=MODEL)
    db.add(conversation)
    await db.flush()
    start = datetime.now(timezone.utc) - timedelta(hours=1)
    for n, (said, replied) in enumerate(turns):
        db.add(Message(conversation_id=conversation.id, role="user", content=said, created_at=start + timedelta(minutes=2 * n)))
        db.add(Message(conversation_id=conversation.id, role="assistant", content=replied, created_at=start + timedelta(minutes=2 * n + 1)))
    await db.commit()
    await capture_conversation(db, conversation, user)


async def _injected(db, user, case: dict[str, Any]) -> tuple[str | None, list[str]]:
    query = "\n".join([*case.get("history", []), case["query"]])[-1500:]
    block, used = await build_memory_system_prompt(db, user.id, query=query, k=RETRIEVAL_K)
    return block, [m.content.lower() for m in used]


async def _answer(provider, block: str | None, question: str) -> str:
    chunks = []
    async for token in model_router.stream_chat(
        provider=provider, model_id=MODEL, messages=[ChatMessage(role="user", content=question)],
        system=(block or "") + "\n\nAnswer in one or two sentences, using only what you've been told about the user.",
        temperature=0.0, max_tokens=120, reasoning_effort="off",
    ):
        chunks.append(token)
    return "".join(chunks)


async def _index_messages(db, _names) -> None:
    cfg = await get_embedding_config(db)
    rows = (await db.execute(select(Message))).scalars().all()
    for m in rows:
        vectors = await embed_texts(provider=cfg.provider, model_id=cfg.model_id, texts=[m.content], dimensions=cfg.dim)
        await _upsert(db, dim=cfg.dim, model=cfg.model_id, message_id=m.id, conversation_id=m.conversation_id, vec=vectors[0], content=m.content)
    await db.commit()


class Score:
    def __init__(self) -> None:
        self.passed = 0
        self.total = 0
        self.misses: list[str] = []

    def add(self, ok: bool, what: str) -> None:
        self.total += 1
        if ok:
            self.passed += 1
        else:
            self.misses.append(what)

    @property
    def percent(self) -> float:
        return 100 * self.passed / self.total if self.total else 0.0


async def test_scorecard(db, monkeypatch):
    provider = await _real_provider()
    await _use_embedder(db)

    # No default model in this throwaway database: use the real install's.
    async def the_model(db_, **_kwargs):
        return provider, MODEL

    monkeypatch.setattr(capture_module, "resolve_memory_model", the_model)
    monkeypatch.setattr("app.memory.upkeep.resolve_memory_model", the_model)
    scores = {name: Score() for name in ("captured", "kept out", "found", "corrected", "off-topic kept out", "admits not knowing", "past chats")}

    for case in GOLDEN["captured"]:
        user = await mk_user(db, "cap")
        await _capture(db, user, provider, case["turns"])
        facts = await _facts(db, user)
        for group in case["expect"]:
            scores["captured"].add(_has(facts, group), f"{case['id']}: wanted {group}, kept {facts}")
        for word in case.get("forbid", []):
            scores["kept out"].add(not _has(facts, [word]), f"{case['id']}: shouldn't keep {word!r}, kept {facts}")

    for case in GOLDEN["corrected"]:
        user = await mk_user(db, "fix")
        await _seed(db, user, case["facts"])
        await _capture(db, user, provider, case["turns"])
        facts = await _facts(db, user)
        ok = all(_has(facts, group) for group in case["current"]) and not any(old in fact for old in case["gone"] for fact in facts)
        scores["corrected"].add(ok, f"{case['id']}: now {facts}")

    person = await mk_user(db, "persona")
    await _seed(db, person, GOLDEN["persona"])
    print("\nProfile:", await refresh_profile(db, person.id))

    async def fresh() -> None:
        # What earlier questions pulled up mustn't sway later ones.
        await db.execute(update(UserMemory).where(UserMemory.user_id == person.id).values(times_used=0, last_used_at=None))
        await db.commit()

    for case in GOLDEN["found"]:
        await fresh()
        _block, used = await _injected(db, person, case)
        # The profile is in every chat, so it counts here and not against "off-topic".
        profile = await db.get(UserMemoryProfile, person.id)
        used = used + ([profile.content.lower()] if profile else [])
        for group in case["expect"]:
            scores["found"].add(_has(used, group), f"{case['id']}: wanted {group}, got {used}")

    for case in GOLDEN["unanswered"]:
        await fresh()
        block, used = await _injected(db, person, case)
        for word in case["not_injected"]:
            scores["off-topic kept out"].add(not _has(used, [word]), f"{case['id']}: {word!r} was injected")
        if case.get("abstain"):
            said = await _answer(provider, block, case["query"])
            scores["admits not knowing"].add(bool(SAYS_IT_DOESNT_KNOW.search(said)), f"{case['id']}: said {said!r}")

    # Past chats, by their own search. Message vectors go in by hand: the indexer runs
    # in the app, not here.
    asker = await mk_user(db, "pastchats")
    chats: dict[str, Conversation] = {}
    for spec in GOLDEN["past_chats"]["chats"]:
        chat = Conversation(user_id=asker.id, title=spec["id"], model_id=MODEL)
        db.add(chat)
        await db.flush()
        chats[spec["id"]] = chat
        start = datetime.now(timezone.utc) - timedelta(days=30)
        for n, (said, replied) in enumerate(spec["turns"]):
            db.add(Message(conversation_id=chat.id, role="user", content=said, created_at=start + timedelta(minutes=2 * n)))
            db.add(Message(conversation_id=chat.id, role="assistant", content=replied, created_at=start + timedelta(minutes=2 * n + 1)))
    here = Conversation(user_id=asker.id, title="Now", model_id=MODEL)
    db.add(here)
    await db.commit()
    await _index_messages(db, list(chats))
    for case in GOLDEN["past_chats"]["questions"]:
        result = await SearchPastChatsTool().run(ToolContext(db=db, user=asker, conversation_id=here.id, user_message_id=uuid.uuid4()), {"query": case["query"]})
        if case["expect"] is None:
            scores["past chats"].add(result.meta["found"] == 0, f"{case['id']}: should find nothing, found {result.content[:200]!r}")
        else:
            first = result.content.split("/chat/")[1][:36] if "/chat/" in result.content else ""
            scores["past chats"].add(first == str(chats[case["expect"]].id), f"{case['id']}: {result.content[:200]!r}")

    print("\n\n=== Memory scorecard ===")
    for name, score in scores.items():
        print(f"{name:<22} {score.passed:>3}/{score.total:<3} {score.percent:5.1f}%")
    for name, score in scores.items():
        for miss in score.misses:
            print(f"MISS {name}: {miss[:400]}")
    out = os.environ.get("MEMORY_EVAL_OUT")
    if out:
        Path(out).write_text(json.dumps({n: {"passed": s.passed, "total": s.total, "misses": s.misses} for n, s in scores.items()}, indent=1), encoding="utf-8")
