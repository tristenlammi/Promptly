"""What each provider type is actually sent (WP-1.5)."""
from __future__ import annotations

import pytest

from app.models_config import provider as prov
from app.models_config.models import ModelProvider


class _Capture:
    def __init__(self):
        self.kwargs: dict = {}

        outer = self

        class _Stream:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        class _Completions:
            @staticmethod
            async def create(**kw):
                outer.kwargs = kw
                return _Stream()

        class _Chat:
            completions = _Completions()

        self.chat = _Chat()

    async def close(self):
        pass


async def _sent(monkeypatch, ptype: str, model: str, **kw) -> dict:
    cap = _Capture()
    monkeypatch.setattr(prov, "_client_for", lambda p: cap)
    p = ModelProvider(name="x", type=ptype, base_url="https://api.example.com/v1", api_key=None,
                      models=[{"id": model}])
    async for _ in prov.model_router.stream_chat_events(provider=p, model_id=model, messages=[], **kw):
        pass
    return cap.kwargs


@pytest.mark.parametrize("model", ["o3", "o4-mini", "gpt-5", "gpt-5-mini"])
async def test_openai_reasoning_models_get_no_temperature_and_the_new_token_cap(monkeypatch, model):
    """They reject ``temperature`` (other than the default) and ``max_tokens``
    with a 400 — every chat with them failed (R-256)."""
    sent = await _sent(monkeypatch, "openai", model, temperature=0.7, max_tokens=500)
    assert "temperature" not in sent
    assert "max_tokens" not in sent
    assert sent["max_completion_tokens"] == 500


async def test_other_openai_models_keep_temperature(monkeypatch):
    sent = await _sent(monkeypatch, "openai", "gpt-4o", temperature=0.3, max_tokens=200)
    assert sent["temperature"] == 0.3
    assert sent["max_completion_tokens"] == 200 and "max_tokens" not in sent


@pytest.mark.parametrize("model", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-4-7", "claude-sonnet-4-6"])
async def test_anthropic_gets_no_sampling_parameters(monkeypatch, model):
    """Claude 4.7 and later reject ``temperature`` (400 "`temperature` is
    deprecated for this model"), and API version 2026-10-21 rejects it on
    every model — so it's never sent to Anthropic."""
    sent = await _sent(monkeypatch, "anthropic", model, temperature=0.7, max_tokens=500)
    assert "temperature" not in sent and "top_p" not in sent and "top_k" not in sent
    assert sent["max_tokens"] == 500


async def test_other_providers_are_unchanged(monkeypatch):
    sent = await _sent(monkeypatch, "openrouter", "openai/o3", temperature=0.7, max_tokens=100)
    assert sent["temperature"] == 0.7 and sent["max_tokens"] == 100


@pytest.mark.parametrize("model,window", [
    ("claude-opus-5-5", 1_000_000), ("claude-fable-5-1", 1_000_000), ("claude-sonnet-5-5", 1_000_000),
    ("claude-haiku-5-5", 1_000_000), ("claude-opus-4-8", 1_000_000), ("claude-sonnet-4-6", 1_000_000),
    ("claude-opus-4-5-20251101", 200_000), ("claude-sonnet-4-5-20250929", 200_000),
    ("claude-haiku-4-5-20251001", 200_000), ("claude-opus-4-1-20250805", 200_000),
    ("claude-3-5-haiku-20241022", 200_000),
])
def test_claude_context_windows_match_the_docs(model, window):
    """Checked against Anthropic's context-windows page (2026-10-08). Every
    Claude 4 used to be reported as 1M (R-277)."""
    assert prov._known_context_window("anthropic", model) == window


async def test_the_anthropic_catalog_reads_every_page_and_the_real_window(monkeypatch):
    pages = [
        {"data": [{"id": f"claude-old-{i}", "display_name": f"Old {i}"} for i in range(20)],
         "has_more": True, "last_id": "claude-old-19"},
        {"data": [{"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1_000_000}],
         "has_more": False, "last_id": "claude-opus-5-5"},
    ]
    calls: list = []

    class _Resp:
        def __init__(self, body):
            self._b = body

        def raise_for_status(self):
            pass

        def json(self):
            return self._b

    class _Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None, params=None):
            calls.append(params)
            return _Resp(pages[len(calls) - 1])

    monkeypatch.setattr(prov.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(prov, "_api_key_for", lambda p: "k")
    p = ModelProvider(name="A", type="anthropic", base_url=None, api_key="x", models=[])
    out = await prov.model_router._list_models_anthropic(p)

    assert len(out) == 21
    assert calls[1]["after_id"] == "claude-old-19"
    assert out[-1]["context_window"] == 1_000_000


async def test_side_calls_count_towards_the_users_usage(db, user, monkeypatch):
    """Titles, memory, captions… never reached usage or budgets (R-276)."""
    import asyncio

    from sqlalchemy import select

    from app.billing.models import UsageDaily
    from app.billing.usage_context import bill_usage_to

    async def _events(**kw):
        yield prov.TextDelta(text="A title")
        yield prov.UsageEvent(prompt_tokens=120, completion_tokens=8, cost_usd=0.0001)

    monkeypatch.setattr(prov.model_router, "stream_chat_events", _events)
    p = ModelProvider(name="x", type="openai", base_url=None, api_key=None, models=[])
    bill_usage_to(user.id)

    out = [t async for t in prov.model_router.stream_chat(provider=p, model_id="m", messages=[])]
    assert out == ["A title"]
    # A caller that records usage itself opts out.
    [t async for t in prov.model_router.stream_chat(provider=p, model_id="m", messages=[], bill=False)]
    await asyncio.sleep(0.3)

    rows = list((await db.execute(select(UsageDaily).where(UsageDaily.user_id == user.id))).scalars())
    assert sum(r.prompt_tokens for r in rows) == 120
    assert sum(r.messages_sent for r in rows) == 0


def test_the_effort_control_only_shows_where_it_does_something():
    """Direct Anthropic ignores ``reasoning_effort`` on its OpenAI-compatible
    endpoint, so Effort was a silent no-op there (R-275)."""
    assert prov._detect_reasoning_by_id("anthropic", "claude-opus-5-5") is False
    assert prov._detect_reasoning_by_id("ollama", "deepseek-r1:8b") is False
    assert prov._detect_reasoning_by_id("openrouter", "anthropic/claude-opus-4-6") is True
    assert prov._detect_reasoning_by_id("gemini", "gemini-2.5-pro") is True


async def test_gemini_gets_reasoning_effort(monkeypatch):
    sent = await _sent(monkeypatch, "gemini", "gemini-2.5-pro", reasoning_effort="high")
    assert sent["reasoning_effort"] == "high"
