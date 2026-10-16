"""Chat titles never carry a role label (V4).

A chat was titled "user: Is brave open source?": the re-title pass hands
the titler a "user: … assistant: …" transcript, and when the model call
failed the fallback used that transcript's first line.
"""
from __future__ import annotations

from app.chat import titler
from app.models_config.provider import ProviderError


def _failing_model(monkeypatch):
    async def _stream(**_kw):
        raise ProviderError("upstream down")
        yield  # pragma: no cover

    monkeypatch.setattr(titler.model_router, "stream_chat", _stream)


def _model_says(monkeypatch, text):
    async def _stream(**_kw):
        yield text

    monkeypatch.setattr(titler.model_router, "stream_chat", _stream)


async def test_a_failed_retitle_keeps_the_title_it_has(monkeypatch):
    _failing_model(monkeypatch)
    title = await titler.generate_conversation_title(
        user_message="user: Is brave open source?\nassistant: Yes, mostly.",
        assistant_message="Yes, mostly.",
        llm_provider=None,
        llm_model_id="m",
        fallback=False,
    )
    assert title == ""


async def test_a_failed_first_title_still_falls_back_to_the_question(monkeypatch):
    _failing_model(monkeypatch)
    title = await titler.generate_conversation_title(
        user_message="Is brave open source?",
        assistant_message="",
        llm_provider=None,
        llm_model_id="m",
    )
    assert title == "Is brave open source?"


async def test_a_role_label_the_model_echoes_is_dropped(monkeypatch):
    _model_says(monkeypatch, "user: Brave Browser Licensing")
    title = await titler.generate_conversation_title(
        user_message="Is brave open source?",
        assistant_message="Yes.",
        llm_provider=None,
        llm_model_id="m",
    )
    assert title == "Brave Browser Licensing"


def test_a_title_that_merely_starts_with_ai_is_kept():
    assert titler._sanitize("AI: Hype vs Reality") == "AI: Hype vs Reality"
