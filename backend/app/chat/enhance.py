"""LLM-backed prompt enhancement (Phase 3.2).

Rewrites a user's rough draft into a clearer, more specific prompt before
they send it. Best-effort and headless — reuses the streaming provider
interface but collects the full output. Never persists anything; the
frontend shows a preview the user can accept or discard.
"""
from __future__ import annotations

import logging
import re
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
# prompt. The note editor sends the selection as an HTML fragment so the model
# preserves structure (headings stay headings, lists stay lists, etc.).
_PROSE_SYSTEM_PROMPT: Final[str] = (
    "You are a copy editor. You are given an HTML fragment from a document. "
    "Rewrite the TEXT to be clearer, tighter and better-flowing, fixing "
    "grammar and awkward phrasing.\n\n"
    "Rules:\n"
    "- PRESERVE the HTML structure and tags exactly: a heading keeps its same "
    "heading tag, lists stay lists, each paragraph stays its own paragraph, "
    "and inline tags (<strong>, <em>, <a>, <code>, <mark>, <s>, <u>) stay on "
    "the right words. NEVER turn body text into a heading, and never merge "
    "separate blocks into one.\n"
    "- Preserve the original meaning, intent, tone and language. Don't add "
    "new facts or content, and don't add tags, headings or sections that "
    "weren't already there.\n"
    "- Keep roughly the same length.\n"
    "- Output ONLY the rewritten HTML fragment — no markdown code fences, no "
    "commentary, no 'Here is'."
)

# Workspace-instructions mode — improve the shared "workspace instructions"
# that get injected as the system prompt into every chat in a workspace. The
# rewrite must fit how Promptly workspaces actually work (RAG over notes +
# human-approved write-back), so it steers the model away from assuming an
# autonomous read/write memory it doesn't have.
_WORKSPACE_INSTRUCTIONS_SYSTEM_PROMPT: Final[str] = (
    "You rewrite 'workspace instructions' for Promptly, a self-hosted AI "
    "workspace. These instructions are injected as the system prompt into "
    "EVERY chat inside one workspace, so they must be tight and general. "
    "Rewrite the user's rough draft into clear, effective instructions.\n\n"
    "CRITICAL — the rewrite must fit how Promptly workspaces actually work:\n"
    "- The AI's knowledge of the workspace comes from its NOTES, documents, "
    "sheets and boards, retrieved automatically as context. The AI reads them; "
    "it does NOT keep its own private memory or database.\n"
    "- To record or save something, the AI PROPOSES a note that the user "
    "approves from a preview card — it cannot silently 'store' data and must "
    "never claim a note exists before it's approved.\n"
    "- The AI only acts when messaged; it cannot run on a schedule or "
    "'periodically' maintain things on its own.\n"
    "- Answers should come from the retrieved workspace notes; if something "
    "isn't in them, it should say so rather than inventing it.\n\n"
    "Rules:\n"
    "- Preserve the user's intent, domain, and voice. Never invent project "
    "facts or add unrelated requirements.\n"
    "- Reword anything that assumes the AI has an autonomous read/write memory, "
    "auto-runs, categorises/prunes a database, or 'stores' data itself — "
    "reframe as 'propose a note', 'answer from the workspace notes', or 'on "
    "request'.\n"
    "- Keep it concise (it runs every turn): a tight, well-structured prompt "
    "beats an exhaustive one.\n"
    "- Output ONLY the rewritten workspace instructions as plain text — no "
    "preamble, no quotes, no commentary, no 'Here is'."
)

_SYSTEM_BY_MODE: Final[dict[str, str]] = {
    "prompt": _ENHANCE_SYSTEM_PROMPT,
    "prose": _PROSE_SYSTEM_PROMPT,
    "workspace_instructions": _WORKSPACE_INSTRUCTIONS_SYSTEM_PROMPT,
}

# Guardrails: long enough for a detailed rewrite, bounded so a runaway
# model can't balloon the cost of a trivial helper.
_MAX_INPUT_CHARS: Final[int] = 8000
_MAX_OUTPUT_TOKENS: Final[int] = 1200


def _sanitize(raw: str) -> str:
    cleaned = _strip_think_blocks(raw).strip()
    # Peel a wrapping ```lang … ``` code fence the model sometimes adds
    # around HTML/markdown despite the instruction.
    fence = re.match(r"^```[a-zA-Z]*\s*\n?(.*?)\n?\s*```$", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
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
    user_lead = {
        "prose": "HTML fragment to improve:",
        "workspace_instructions": "Rough workspace instructions to improve:",
    }.get(mode, "Rough prompt to improve:")
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
