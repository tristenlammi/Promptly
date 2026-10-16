"""An embedder that's missing or down (WP-1.5, R-261/R-268/R-271)."""
from __future__ import annotations

import time

import pytest

from app.custom_models import embedding as emb
from app.models_config.models import ModelProvider


class _Failing:
    calls = 0

    def with_options(self, **kw):
        return self

    class embeddings:  # noqa: N801
        @staticmethod
        async def create(**kw):
            _Failing.calls += 1
            raise ConnectionError("embedder down")


async def test_a_dead_embedder_is_skipped_after_a_few_failures(monkeypatch):
    """Every chat turn and memory write waited on it again (R-271)."""
    emb._breaker.clear()
    _Failing.calls = 0
    monkeypatch.setattr(emb, "_client_for", lambda p: _Failing())
    p = ModelProvider(name="Down", type="ollama", base_url="http://x/v1", api_key=None, models=[])

    for _ in range(emb._BREAKER_FAILURES):
        with pytest.raises(ConnectionError):
            await emb.embed_texts(provider=p, model_id="m", texts=["q"], fast=True)
    started = time.monotonic()
    with pytest.raises(emb.EmbedderUnavailable):
        await emb.embed_texts(provider=p, model_id="m", texts=["q"], fast=True)
    assert time.monotonic() - started < 0.1
    assert _Failing.calls == emb._BREAKER_FAILURES  # the skip made no call


async def test_memories_saved_without_an_embedder_get_one_later(db, user, monkeypatch):
    """They dropped out of retrieval for good (R-268)."""
    from app.chat import semantic_search
    from app.custom_models import backfill
    from app.memory import service as mem
    from app.memory.models import UserMemory

    row = UserMemory(user_id=user.id, content="User prefers tea")
    db.add(row)
    await db.commit()

    class _Cfg:
        dim = 768
        provider = None
        model_id = "m"

    async def _cfg(db):
        return _Cfg()

    embedded: list = []

    async def _embed(db, memory, cfg=None):
        embedded.append(memory.content)
        memory.embed_dim = 768
        return True

    monkeypatch.setattr(backfill, "get_embedding_config", _cfg)
    monkeypatch.setattr(mem, "embed_memory_row", _embed)
    out = await backfill.backfill_embeddings()

    assert "User prefers tea" in embedded
    assert out["memories"] >= 1
