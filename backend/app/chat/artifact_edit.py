"""LLM-backed in-place artifact editing (Phase 5).

Applies a natural-language change ("make the button blue", "add a dark
mode toggle") to an existing code artifact and returns the FULL updated
source, so the side panel can patch the *same* artifact in place instead
of the model re-emitting a whole new code block in the chat.

Headless + stateless — mirrors :mod:`app.chat.enhance`. Nothing is
persisted; the panel swaps its draft to the returned source and the live
preview re-renders.
"""
from __future__ import annotations

import logging
import re
from typing import Final

from app.chat.titler import _strip_think_blocks
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router

logger = logging.getLogger("promptly.chat.artifact_edit")

__all__ = ["edit_artifact", "ProviderError"]

_SYSTEM_PROMPT: Final[str] = (
    "You are a precise code and document editor for a live artifact "
    "viewer. You are given the FULL current source of a single artifact "
    "and a change request. Apply the change and return the COMPLETE "
    "updated source.\n\n"
    "Rules:\n"
    "- Return the ENTIRE file, not a diff and not a snippet — the viewer "
    "replaces the whole artifact with exactly what you output.\n"
    "- Make ONLY the change the user asked for, plus the minimum needed "
    "to keep the file valid. Preserve everything else verbatim: "
    "structure, indentation, comments, and unrelated code.\n"
    "- Keep the same language and format as the input.\n"
    "- Output ONLY the raw source. No markdown code fences, no "
    "explanation, no preamble, no trailing commentary."
)

# Bounds: a single artifact is usually a few KB; cap generously but
# guard against a pathological paste. Output token budget is large
# because the model returns the whole file, not just the edit.
_MAX_SOURCE_CHARS: Final[int] = 60_000
_MAX_INSTRUCTION_CHARS: Final[int] = 2_000
_MAX_OUTPUT_TOKENS: Final[int] = 8_000

# Strip a single wrapping ```lang … ``` fence if the model adds one
# despite the instruction.
_FENCE_RE = re.compile(r"\A\s*```[^\n]*\n(?P<body>.*?)\n?```\s*\Z", re.DOTALL)


def _strip_fence(text: str) -> str:
    m = _FENCE_RE.match(text)
    return m.group("body") if m else text


async def edit_artifact(
    *,
    source: str,
    language: str,
    instruction: str,
    provider: ModelProvider,
    model_id: str,
) -> str:
    """Return the full updated artifact source after applying ``instruction``.

    Raises :class:`ProviderError` on upstream failure so the endpoint can
    surface a clean 502. Returns the original source unchanged when the
    instruction is empty or the model produces nothing usable.
    """
    src = (source or "")[:_MAX_SOURCE_CHARS]
    instr = (instruction or "").strip()[:_MAX_INSTRUCTION_CHARS]
    if not instr:
        return src

    user_msg = (
        f"Language: {language or 'unknown'}\n\n"
        f"Change request:\n{instr}\n\n"
        "Current source (return the full updated version):\n"
        f"{src}"
    )

    chunks: list[str] = []
    async for token in model_router.stream_chat(
        provider=provider,
        model_id=model_id,
        messages=[ChatMessage(role="user", content=user_msg)],
        system=_SYSTEM_PROMPT,
        temperature=0.2,
        max_tokens=_MAX_OUTPUT_TOKENS,
        reasoning_effort="off",
    ):
        chunks.append(token)

    cleaned = _strip_think_blocks("".join(chunks)).strip()
    cleaned = _strip_fence(cleaned)
    # Preserve internal whitespace; only trim trailing blank lines.
    cleaned = cleaned.rstrip("\n")
    return cleaned or src
