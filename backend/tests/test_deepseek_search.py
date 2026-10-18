"""DeepSeek's own Search and Fetch, only on a DeepSeek model: web_search asks
DeepSeek first (the configured providers are the fallback), fetch_url turns
to it when a page blocks the direct fetch, and no other model ever calls it."""
from __future__ import annotations

import uuid

import httpx
import pytest


@pytest.fixture
async def ds_provider(db):
    from app.auth.utils import encrypt_secret
    from app.models_config.models import ModelProvider

    row = ModelProvider(
        user_id=None, name="DeepSeek", type="deepseek", base_url="https://api.deepseek.com",
        api_key=encrypt_secret("sk-test-deepseek"), enabled=True, models=[{"id": "deepseek-v4-flash"}],
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.fixture
def deepseek_api(monkeypatch):
    """A fake api.deepseek.com: records each call; ``answers`` per path."""
    from app.search import deepseek

    calls: list[dict] = []
    answers: dict[str, httpx.Response] = {}

    async def fake(method, url, *, provider_label, headers=None, params=None, json=None):  # noqa: ARG001
        calls.append({"url": url, "json": json, "auth": (headers or {}).get("Authorization")})
        path = url.rsplit("/", 1)[-1]
        resp = answers.get(path) or httpx.Response(500, json={"error": {"message": "boom"}})
        resp.request = httpx.Request(method, url)
        return resp

    monkeypatch.setattr(deepseek, "_safe_request", fake)
    return calls, answers


def _ctx(db, user, turn):
    from app.chat.tools.base import ToolContext

    return ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn=turn)


def test_only_a_deepseek_provider_marks_the_turn(ds_provider, provider):
    from app.search.deepseek import mark_turn, turn_provider_id

    turn: dict = {}
    mark_turn(turn, provider)  # an OpenAI-compatible one
    assert turn_provider_id(turn) is None
    mark_turn(turn, ds_provider)
    assert turn_provider_id(turn) == ds_provider.id


@pytest.mark.asyncio
async def test_web_search_on_a_deepseek_model_uses_deepseek(db, user, ds_provider, deepseek_api):
    from app.chat.tools.web_search import WebSearchTool
    from app.search.deepseek import mark_turn

    calls, answers = deepseek_api
    answers["search"] = httpx.Response(200, json={"results": [
        {"rerank_score": 2.4, "title": "DeepSeek V4 released", "url": "https://example.com/v4",
         "snippet": "short", "summary": "DeepSeek released V4 with better tool calling.", "content": "",
         "site_name": None, "site_icon": None, "date": None, "authority": 3},
        {"title": "not a web page", "url": "magnet:?xt=1", "summary": "x"},
    ]})
    turn: dict = {}
    mark_turn(turn, ds_provider)
    long_query = "deepseek v4 release notes " * 10
    result = await WebSearchTool().run(_ctx(db, user, turn), {"query": long_query})

    assert result.meta["provider"] == "deepseek" and result.meta["result_count"] == 1
    assert "DeepSeek released V4 with better tool calling." in result.content  # the summary, for the model
    assert result.sources[0]["url"] == "https://example.com/v4"
    sent = calls[0]
    assert sent["url"] == "https://api.deepseek.com/v1/tools/search" and sent["auth"] == "Bearer sk-test-deepseek"
    assert len(sent["json"]["query"]) <= 128 and sent["json"]["count"] == 10


@pytest.mark.asyncio
async def test_a_failed_deepseek_search_falls_back_and_other_models_never_call_it(
    db, user, ds_provider, deepseek_api, monkeypatch
):
    from app.chat.tools import web_search
    from app.chat.tools.base import ToolError
    from app.search.deepseek import mark_turn
    from app.search.schemas import SearchResult

    calls, answers = deepseek_api  # no answer yet → DeepSeek errors (500)

    class _Primary:
        id = uuid.uuid4()
        type = "searxng"

    async def pick(db_, user_):  # noqa: ARG001
        return _Primary()

    async def chain(db_, user_, query, *, count=None, primary=None, budget_s=None):  # noqa: ARG001
        return [SearchResult(title="From SearXNG", url="https://example.org/a", snippet="s")], primary

    monkeypatch.setattr(web_search, "pick_search_provider", pick)
    monkeypatch.setattr(web_search, "run_search_with_failover", chain)

    turn: dict = {}
    mark_turn(turn, ds_provider)
    result = await web_search.WebSearchTool().run(_ctx(db, user, turn), {"query": "llamas"})
    assert result.meta["provider"] == "searxng" and len(calls) == 1  # tried DeepSeek, fell back

    calls.clear()
    result = await web_search.WebSearchTool().run(_ctx(db, user, {}), {"query": "llamas"})
    assert result.meta["provider"] == "searxng" and calls == []  # not a DeepSeek model: never asked

    # A DeepSeek chat works even with no search provider set up at all.
    async def none(db_, user_):  # noqa: ARG001
        return None

    monkeypatch.setattr(web_search, "pick_search_provider", none)
    answers["search"] = httpx.Response(200, json={"results": [{"title": "Llamas", "url": "https://example.com/l", "summary": "ok"}]})
    result = await web_search.WebSearchTool().run(_ctx(db, user, turn), {"query": "llamas"})
    assert result.meta["provider"] == "deepseek"
    with pytest.raises(ToolError):  # …while another model still needs one
        await web_search.WebSearchTool().run(_ctx(db, user, {}), {"query": "llamas"})


@pytest.mark.asyncio
async def test_fetch_url_on_a_deepseek_model_rescues_a_blocked_page(db, user, ds_provider, deepseek_api, monkeypatch):
    from app.chat.tools import fetch_url
    from app.chat.tools.base import ToolError
    from app.search.deepseek import mark_turn

    calls, answers = deepseek_api

    async def blocked(method, url, **kw):  # noqa: ARG001
        return httpx.Response(403, text="Access denied", request=httpx.Request(method, url))

    async def nothing(ctx, ptype):  # noqa: ARG001 — no Tavily / Ollama configured
        return None

    monkeypatch.setattr(fetch_url, "safe_fetch", blocked)
    monkeypatch.setattr(fetch_url, "_fallback_provider", nothing)
    answers["fetch"] = httpx.Response(200, json={"title": "Pricing", "content": "# Pricing\n\nThe plan costs 12 dollars."})

    turn: dict = {}
    mark_turn(turn, ds_provider)
    result = await fetch_url.FetchUrlTool().run(_ctx(db, user, turn), {"url": "https://shop.example.com/pricing"})
    assert result.meta["recovered_via"] == "deepseek" and "12 dollars" in result.content
    assert calls[-1]["url"] == "https://api.deepseek.com/v1/tools/fetch"
    assert calls[-1]["json"] == {"url": "https://shop.example.com/pricing"}

    calls.clear()
    with pytest.raises(ToolError):
        await fetch_url.FetchUrlTool().run(_ctx(db, user, {}), {"url": "https://shop.example.com/pricing"})
    assert calls == []
