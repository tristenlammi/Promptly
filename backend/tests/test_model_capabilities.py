"""Which models we believe can read images.

This detection is a heuristic over model ids, and it fails in two very
different ways. A wrong ``True`` sends image parts to a text-only model,
which either 400s or — worse — silently drops them. A wrong ``False``
tells the user their vision model can't see, and the image never leaves
the browser. Both are silent-ish, so the id families are pinned here.
"""
from __future__ import annotations

from app.models_config.provider import _detect_vision_by_id


def test_deepseeks_vision_model_is_recognised():
    """``deepseek-v4-flash-vision-exp`` reads images on the normal endpoint.

    Released 2026-08-21. Before this, the DeepSeek branch only matched the
    open-weight ``deepseek-vl*`` family, so selecting the hosted vision
    model still produced the "can't see images" warning.
    """
    assert _detect_vision_by_id("deepseek", "deepseek-v4-flash-vision-exp")


def test_deepseeks_text_models_are_still_text_only():
    """The rest of the line has not gained vision — don't blanket-enable."""
    for model_id in (
        "deepseek-chat",
        "deepseek-reasoner",
        "deepseek-v4-flash",
        "deepseek-v4-pro",
    ):
        assert not _detect_vision_by_id("deepseek", model_id), model_id


def test_self_hosted_deepseek_vl_still_counts():
    assert _detect_vision_by_id("deepseek", "deepseek-vl2")


def test_an_unknown_model_defaults_to_no_vision():
    """Err closed: a missing badge beats an image the model silently drops."""
    assert not _detect_vision_by_id("deepseek", "some-future-model")
    assert not _detect_vision_by_id("openai_compatible", "anything-at-all")
