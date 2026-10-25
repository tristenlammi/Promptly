"""Describing photos with a reasoning model: Qwen 3.x Flash wasn't known to
reason (its id names no "reasoner"/"thinking"), so its thinking was never
turned off and every description came back empty. The provider's own
catalog now decides; and a model that still answers nothing gets one more
go with room to think."""
from __future__ import annotations

from types import SimpleNamespace

import pytest


def test_the_catalog_decides_whether_a_model_reasons():
    from app.models_config.provider import _model_reasoning_support

    p = SimpleNamespace(type="openrouter", models=[
        {"id": "qwen/qwen3.7-flash", "supports_native_reasoning": True},
        {"id": "google/gemma-3-4b-it", "supports_native_reasoning": False},
    ])
    assert _model_reasoning_support(p, "qwen/qwen3.7-flash") is True  # the id alone wouldn't say
    assert _model_reasoning_support(p, "google/gemma-3-4b-it") is False
    assert _model_reasoning_support(p, "openai/o3") is True  # not in the catalog: the id's guess
    assert _model_reasoning_support(SimpleNamespace(type="ollama", models=[]), "qwen3:8b") is False


@pytest.mark.asyncio
async def test_an_empty_answer_gets_one_more_go_with_room_to_think(monkeypatch):
    import io

    from PIL import Image

    from app.models_config import provider as prov
    from app.photos import captions

    asked = []

    async def stream_chat(**kw):
        asked.append((kw["reasoning_effort"], kw["max_tokens"]))
        if kw["reasoning_effort"] == "off":
            return  # it thought, and said nothing
            yield
        yield '{"caption": "A golden retriever on the grass.", "tags": ["dog"]}'

    monkeypatch.setattr(prov.model_router, "stream_chat", stream_chat)
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (90, 160, 60)).save(buf, "WEBP")
    vision = captions.Vision(SimpleNamespace(type="openrouter", models=[]), "qwen/qwen3.7-flash", False, "Qwen", 10)
    caption, tags = await captions.describe(vision, buf.getvalue(), None)
    assert caption == "A golden retriever on the grass." and tags == ["dog"]
    assert asked == [("off", 500), ("low", 2000)]
