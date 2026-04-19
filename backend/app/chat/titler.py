"""LLM-backed conversation title generation.

Used after the first assistant response to replace the provisional "first-N
characters" title with a short, meaningful summary. The call is best-effort —
on any provider failure we fall back to a truncation of the first user turn
so the conversation always has *some* sensible label.
"""
from __future__ import annotations

import logging
import re
from typing import Final

from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router

logger = logging.getLogger("promptly.chat.titler")

_TITLE_SYSTEM_PROMPT: Final[str] = (
    "You generate ultra-concise chat titles. Read the user message and the "
    "assistant reply that follows, then respond with a single short title "
    "(2–4 words) that captures the topic.\n\n"
    "Rules:\n"
    "- Plain text only. No quotes, no emojis, no trailing punctuation.\n"
    "- Title Case is preferred (e.g. 'Docker on Fly.io').\n"
    "- Never answer the question — just name the topic.\n"
    "- Hard limit: 30 characters. Shorter is better.\n"
    "- Never return anything other than the title itself."
)

# Hard cap so generated titles always fit the sidebar.
_MAX_TITLE_LEN: Final[int] = 30
_MAX_SOURCE_CHARS: Final[int] = 2000


def _truncate_to_fit(text: str, limit: int = _MAX_TITLE_LEN) -> str:
    """Trim ``text`` to ``limit`` characters. Prefer breaking on a word
    boundary and append a single-character ellipsis when we actually had to
    cut so the user knows the label was clipped."""
    if len(text) <= limit:
        return text
    # Reserve one character for the ellipsis so the final string still fits.
    budget = limit - 1
    head = text[:budget]
    last_space = head.rfind(" ")
    # Only break on a space if it leaves a reasonable amount of text behind.
    # Otherwise hard-cut at the budget rather than producing "A…".
    if last_space >= max(8, budget // 2):
        head = head[:last_space].rstrip(",;:.- ")
    return f"{head}…"


def fallback_title(user_message: str) -> str:
    """Deterministic, provider-free fallback used both as a provisional title
    at send-time and as a last-ditch when LLM generation fails."""
    first_line = user_message.strip().splitlines()[0] if user_message.strip() else ""
    if not first_line:
        return "New chat"
    return _truncate_to_fit(first_line)


def _sanitize(raw: str) -> str:
    """Clean up raw LLM output into a single-line title."""
    # Keep only the first non-empty line — some models like to add a
    # "Title:" prefix or follow with a justification.
    candidate = ""
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped:
            candidate = stripped
            break
    # Strip common prefixes LLMs add despite instructions.
    candidate = re.sub(r"^(title|chat title)\s*[:\-]\s*", "", candidate, flags=re.I)
    # Iteratively peel off wrapping quotes / trailing punctuation / backticks
    # so inputs like ``'Foo'.`` converge to ``Foo``.
    for _ in range(4):
        before = candidate
        candidate = candidate.strip().strip("\"'“”‘’`")
        candidate = candidate.rstrip(".?!,;:")
        if candidate == before:
            break
    # Collapse internal whitespace.
    candidate = re.sub(r"\s+", " ", candidate)
    return _truncate_to_fit(candidate)


async def generate_conversation_title(
    *,
    user_message: str,
    assistant_message: str,
    llm_provider: ModelProvider,
    llm_model_id: str,
) -> str:
    """Ask the chat provider for a short title. Never raises — any failure
    degrades gracefully to :func:`fallback_title`."""
    user = (user_message or "").strip()[:_MAX_SOURCE_CHARS]
    assistant = (assistant_message or "").strip()[:_MAX_SOURCE_CHARS]
    if not user:
        return fallback_title(user_message)

    prompt = (
        "USER MESSAGE:\n"
        f"{user}\n\n"
        "ASSISTANT REPLY:\n"
        f"{assistant or '(no reply)'}\n\n"
        "Respond with only the title."
    )

    try:
        chunks: list[str] = []
        async for token in model_router.stream_chat(
            provider=llm_provider,
            model_id=llm_model_id,
            messages=[ChatMessage(role="user", content=prompt)],
            system=_TITLE_SYSTEM_PROMPT,
            temperature=0.3,
            max_tokens=40,
        ):
            chunks.append(token)
        cleaned = _sanitize("".join(chunks))
        if cleaned:
            return cleaned
        logger.info("Titler returned empty output; using fallback")
    except ProviderError as e:
        logger.warning("Title generation failed, using fallback: %s", e)
    except Exception:  # pragma: no cover - defensive belt-and-braces
        logger.exception("Unexpected error during title generation")

    return fallback_title(user_message)
