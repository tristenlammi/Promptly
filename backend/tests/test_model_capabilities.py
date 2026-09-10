"""Which models we believe can read images.

This detection is a heuristic over model ids, and it fails in two very
different ways. A wrong ``True`` sends image parts to a text-only model,
which either 400s or — worse — silently drops them. A wrong ``False``
tells the user their vision model can't see, and the image never leaves
the browser. Both are silent-ish, so the id families are pinned here.
"""
from __future__ import annotations

from app.models_config.provider import _detect_vision_by_id


def test_deepseeks_vision_models_are_recognised():
    """The whole hosted ``*flash*`` family reads images.

    Two releases in three weeks, each of which broke a narrower rule:
    ``deepseek-v4-flash-vision-exp`` (2026-08-21) defeated matching on
    ``deepseek-vl``, and ``deepseek-flash`` (V4.1, 2026-09-10) defeated
    matching on ``vision`` by dropping the word from its name. The older
    ids are now aliases routed to V4.1-Flash, so all three see images.
    """
    for model_id in (
        "deepseek-flash",
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
    ):
        assert _detect_vision_by_id("deepseek", model_id), model_id


def test_deepseeks_text_models_are_still_text_only():
    """Don't blanket-enable the provider — these would drop the image.

    ``deepseek-v4-pro`` is the interesting one: DeepSeek routes it to
    V4.1-Flash from 2026-09-14, so this assertion is deliberately
    conservative rather than permanently true. Under-reporting a badge
    beats claiming a capability the model doesn't have yet.
    """
    for model_id in (
        "deepseek-chat",
        "deepseek-reasoner",
        "deepseek-v4-pro",
    ):
        assert not _detect_vision_by_id("deepseek", model_id), model_id


def test_self_hosted_deepseek_vl_still_counts():
    assert _detect_vision_by_id("deepseek", "deepseek-vl2")


def test_an_unknown_model_defaults_to_no_vision():
    """Err closed: a missing badge beats an image the model silently drops."""
    assert not _detect_vision_by_id("deepseek", "some-future-model")
    assert not _detect_vision_by_id("openai_compatible", "anything-at-all")
