"""LLM-backed prompt enhancement (Phase 3.2).

Rewrites a user's rough draft into a clearer, more specific prompt before
they send it. Best-effort and headless — reuses the streaming provider
interface but collects the full output. Never persists anything; the
frontend shows a preview the user can accept or discard.
"""
from __future__ import annotations

import logging
from typing import Final

from app.chat.titler import _strip_think_blocks
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router

logger = logging.getLogger("promptly.chat.enhance")

_ENHANCE_SYSTEM_PROMPT: Final[str] = (
    "You are a prompt editor for an AI chat assistant. Rewrite the user's "
    "rough draft into a single, clear, well-structured prompt that will get "
    "a noticeably better answer.\n\n"
    "Rules:\n"
    "- Preserve the user's original intent, meaning, and language. Never "
    "answer the prompt or add requirements that change what they asked for.\n"
    "- Make it specific and unambiguous: clarify the goal, add helpful "
    "structure, and surface obvious constraints the user implied.\n"
    "- Keep it concise — tighten, don't pad. Don't invent facts or context.\n"
    "- Output ONLY the rewritten prompt as plain text. No preamble, no "
    "quotes, no commentary, no 'Here is' — just the improved prompt."
)

# Guardrails: long enough for a detailed rewrite, bounded so a runaway
# model can't balloon the cost of a trivial helper.
_MAX_INPUT_CHARS: Final[int] = 8000
_MAX_OUTPUT_TOKENS: Final[int] = 1200


def _sanitize(raw: str) -> str:
    cleaned = _strip_think_blocks(raw).strip()
    # Peel wrapping quotes/backticks a model sometimes adds despite the
    # instruction, without touching internal punctuation.
    for _ in range(3):
        before = cleaned
        cleaned = cleaned.strip().strip("`").strip()
        if (
            len(cleaned) >= 2
            and cleaned[0] in "\"'“”‘’"
            and cleaned[-1] in "\"'“”‘’"
        ):
            cleaned = cleaned[1:-1].strip()
        if cleaned == before:
            break
    return cleaned


async def enhance_prompt(
    *,
    text: str,
    provider: ModelProvider,
    model_id: str,
) -> str:
    """Return an improved version of ``text``. Raises ``ProviderError`` on
    upstream failure so the endpoint can surface a clean 502."""
    draft = (text or "").strip()[:_MAX_INPUT_CHARS]
    if not draft:
        return ""

    chunks: list[str] = []
    async for token in model_router.stream_chat(
        provider=provider,
        model_id=model_id,
        messages=[
            ChatMessage(
                role="user",
                content=f"Rough prompt to improve:\n\n{draft}",
            )
        ],
        system=_ENHANCE_SYSTEM_PROMPT,
        temperature=0.4,
        max_tokens=_MAX_OUTPUT_TOKENS,
        reasoning_effort="off",
    ):
        chunks.append(token)

    cleaned = _sanitize("".join(chunks))
    # If the model produced nothing usable, hand back the original so the
    # caller can decide; an empty rewrite is never an improvement.
    return cleaned or draft
