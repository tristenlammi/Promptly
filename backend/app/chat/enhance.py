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

# Prose mode — improve a passage of a document (grammar/clarity/flow), not a
# prompt. Used by the note editor's "AI enhance selection".
_PROSE_SYSTEM_PROMPT: Final[str] = (
    "You are a writing editor. Rewrite the passage the user gives you to be "
    "clearer, tighter and better-flowing, fixing grammar and awkward "
    "phrasing.\n\n"
    "Rules:\n"
    "- Preserve the original meaning, intent, tone and language. Don't add "
    "new facts, claims, or content the passage didn't have.\n"
    "- Improve grammar, word choice, clarity and rhythm; cut redundancy.\n"
    "- Keep roughly the same length and format (if it's a bullet, keep a "
    "bullet; a sentence stays a sentence). Don't add headings or preamble.\n"
    "- Output ONLY the rewritten passage as plain text — no quotes, no "
    "commentary, no 'Here is'."
)

_SYSTEM_BY_MODE: Final[dict[str, str]] = {
    "prompt": _ENHANCE_SYSTEM_PROMPT,
    "prose": _PROSE_SYSTEM_PROMPT,
}

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
    mode: str = "prompt",
) -> str:
    """Return an improved version of ``text``. ``mode`` picks the editor
    persona: ``"prompt"`` (sharpen a chat prompt) or ``"prose"`` (improve a
    document passage). Raises ``ProviderError`` on upstream failure so the
    endpoint can surface a clean 502."""
    draft = (text or "").strip()[:_MAX_INPUT_CHARS]
    if not draft:
        return ""

    system = _SYSTEM_BY_MODE.get(mode, _ENHANCE_SYSTEM_PROMPT)
    user_lead = (
        "Passage to improve:" if mode == "prose" else "Rough prompt to improve:"
    )
    messages = [ChatMessage(role="user", content=f"{user_lead}\n\n{draft}")]

    async def _collect(reasoning: str | None) -> str:
        parts: list[str] = []
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=messages,
            system=system,
            temperature=0.4,
            max_tokens=_MAX_OUTPUT_TOKENS,
            reasoning_effort=reasoning,
        ):
            parts.append(token)
        return "".join(parts)

    # Enhance normally skips the thinking pass for speed/cost ("off"), but
    # some reasoning models (e.g. certain OpenRouter routes) reject a disabled
    # thinking pass ("Reasoning is mandatory …"). Fall back to letting the
    # model reason — the ``<think>`` blocks are stripped by ``_sanitize``.
    try:
        raw = await _collect("off")
    except ProviderError as e:
        if "reasoning" in str(e).lower():
            logger.info("enhance retrying with reasoning enabled: %s", e)
            raw = await _collect(None)
        else:
            raise

    cleaned = _sanitize(raw)
    # If the model produced nothing usable, hand back the original so the
    # caller can decide; an empty rewrite is never an improvement.
    return cleaned or draft
