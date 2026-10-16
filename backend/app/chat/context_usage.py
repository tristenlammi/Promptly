"""How full a chat's context is, and what's filling it (WP-1.4).

The context meter used to read ``prompt_tokens``, which is the sum over a
turn's tool hops — right for billing, but a turn that searched once
showed roughly double its real size. What the meter needs is the size of
the *last* request: everything the model had in view when it wrote the
reply. That's ``total`` here, with a breakdown of what made it up.

The provider only reports a total, so the parts are estimated from
character counts and scaled to it. They're for orientation ("most of
this is tool definitions"), not accounting.
"""
from __future__ import annotations

import json
from typing import Any

_CHARS_PER_TOKEN = 4
# An image costs tokens by its pixel size, not its base64 length; a
# mid-size image is in the high hundreds to low thousands on most models.
_IMAGE_TOKENS = 1000


def _content_chars(content: Any) -> int:
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for part in content:
            if not isinstance(part, dict):
                # TextPart / ImagePart from the provider layer.
                if hasattr(part, "to_openai"):
                    part = part.to_openai()
                else:
                    total += len(str(part))
                    continue
            if part.get("type") == "text":
                total += len(part.get("text") or "")
            elif part.get("type") in ("image_url", "image"):
                total += _IMAGE_TOKENS * _CHARS_PER_TOKEN
            else:
                total += len(json.dumps(part, default=str))
        return total
    return len(str(content))


def history_chars(history: list[Any]) -> int:
    """Characters of conversation the model sees (messages, tool calls
    and tool results), counting each image at a flat estimate."""
    total = 0
    for msg in history:
        if isinstance(msg, dict):
            total += _content_chars(msg.get("content"))
            if msg.get("tool_calls"):
                total += len(json.dumps(msg["tool_calls"], default=str))
        else:
            total += _content_chars(getattr(msg, "content", None))
    return total


def build_context_usage(
    *,
    measured_prompt_tokens: int | None,
    instructions_chars: int,
    turn_chars: int,
    tools_chars: int,
    history_chars: int,
) -> dict[str, Any]:
    """``{"total", "measured", "parts": {instructions, turn, tools, history}}``.

    ``instructions`` is the standing system prompt (guidelines, workspace
    and chat instructions, tool guidance); ``turn`` is what was looked up
    for this message (date and time, memories, retrieved files,
    @-mentions); ``tools`` is the tool definitions; ``history`` is the
    conversation itself.
    """
    estimates = {
        "instructions": instructions_chars / _CHARS_PER_TOKEN,
        "turn": turn_chars / _CHARS_PER_TOKEN,
        "tools": tools_chars / _CHARS_PER_TOKEN,
        "history": history_chars / _CHARS_PER_TOKEN,
    }
    estimated_total = sum(estimates.values())
    measured = bool(measured_prompt_tokens and measured_prompt_tokens > 0)
    total = int(measured_prompt_tokens) if measured else round(estimated_total)
    scale = (total / estimated_total) if estimated_total > 0 else 0.0
    parts = {k: round(v * scale) for k, v in estimates.items()}
    return {"total": total, "measured": measured, "parts": parts}
