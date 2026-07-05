"""Reusable, non-streaming model↔tool loop for headless sub-agents.

The chat router's own tool loop lives inline in ``_stream_generator``
and is tangled up with SSE emission, persistence, cost/usage rollups,
DeepSeek reasoning replay, the forced-finish synthesis net, and version
bookkeeping. A sub-agent needs almost none of that — it just has to run
one focused task to completion against a tool set and hand back a short
digest. This module is that stripped-down loop.

It deliberately reuses the *same* provider event interface
(``model_router.stream_chat_events``) and the *same* tool dispatcher
(``_dispatch_tools``, imported lazily to avoid an import cycle with the
router) so a sub-agent's tools run through the identical parallel,
timeout-guarded, schema-validated path as a top-level turn — no second
implementation to keep in sync.

Design invariants that keep fan-out safe:

* **Own session.** Each :func:`run_agent` call opens its own
  ``SessionLocal``. Agents run concurrently, so they must never share
  an ``AsyncSession``.
* **Digest, not transcript.** The return value is a bounded text
  summary plus structured sources — never the agent's full tool
  output. This is the whole point: a sub-agent burns its own context
  reading pages, then throws that context away, so the *parent* history
  stays lean regardless of how much the agent read.
* **No recursion.** The caller controls ``tools_payload``; passing a
  set that excludes ``run_agents`` (the tool never advertises itself to
  its own children) makes depth-1 structural, not a runtime check.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any
import uuid

from app.auth.models import User
from app.chat.tools import ToolContext
from app.database import SessionLocal
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    FinishEvent,
    ProviderError,
    TextDelta,
    ToolCallDelta,
    UsageEvent,
    model_router,
)

logger = logging.getLogger("promptly.agent_runner")

# A sub-agent gets a tight hop budget: enough for a genuine
# search → read → refine chain, but bounded so one confused agent can't
# spin. The final hop drops the tool schema to force a written answer,
# mirroring the top-level loop's forced-finish.
DEFAULT_AGENT_HOPS = 5

# Hard ceiling on the digest we hand back to the parent. The whole
# value proposition is compression, so this stays small — a couple of
# thousand tokens, not the agent's full reading.
_MAX_DIGEST_CHARS = 4_000

_AGENT_SYSTEM_PROMPT = (
    "You are a focused research sub-agent working on ONE specific task "
    "as part of a larger request. You have web tools available. Your job:\n"
    "1. Use the tools to gather what the task needs — search, then read "
    "the most promising results in full when a snippet isn't enough.\n"
    "2. Write a tight, self-contained findings brief: the concrete "
    "answer plus the specific facts, figures, and quotes that support "
    "it. Lead with the answer.\n"
    "3. Cite sources inline with [1], [2] matching the numbered results "
    "you relied on. If the task can't be answered from what you found, "
    "say so plainly and report what you did find.\n"
    "You are not talking to the end user — another model will synthesise "
    "your brief with others, so be dense and factual, skip pleasantries, "
    "and don't ask follow-up questions."
)


@dataclass
class AgentResult:
    """Outcome of one sub-agent task. ``error`` is set on failure and
    ``text`` then holds a short human-readable reason instead of a
    findings brief."""

    task: str
    text: str
    sources: list[dict[str, Any]] = field(default_factory=list)
    cost_usd: float = 0.0
    tool_calls: int = 0
    hops: int = 0
    error: str | None = None


async def run_agent(
    *,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    user_message_id: uuid.UUID,
    task: str,
    provider_id: uuid.UUID,
    model_id: str,
    tools_payload: list[dict[str, Any]],
    per_tool_caps: dict[str, int] | None = None,
    max_hops: int = DEFAULT_AGENT_HOPS,
    temperature: float = 0.4,
    max_tokens: int | None = None,
) -> AgentResult:
    """Run one focused task to completion on its own DB session.

    Never raises: any failure (provider error, missing model, empty
    result) is caught and returned as an :class:`AgentResult` with
    ``error`` set, so a fan-out caller can surface a per-agent failure
    without losing the agents that succeeded.
    """
    # Lazy import: router imports the registry which imports the
    # run_agents tool which imports this module — importing the
    # dispatcher at module load would close that cycle.
    from app.chat.router import _dispatch_tools

    async with SessionLocal() as db:
        user = await db.get(User, user_id)
        if user is None:
            return AgentResult(
                task=task, text="account unavailable", error="no_user"
            )
        provider = await db.get(ModelProvider, provider_id)
        if provider is None:
            return AgentResult(
                task=task,
                text="the agent model is no longer available",
                error="no_provider",
            )

        running_history: list[ChatMessage | dict[str, Any]] = [
            ChatMessage(role="user", content=task)
        ]
        text_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        cost_usd = 0.0
        tool_count = 0
        invocation_counts: dict[str, int] = {}
        hops_used = 0

        def _noop_sse(_: dict[str, Any]) -> str:
            return ""

        def _add_cost(c: float) -> None:
            nonlocal cost_usd
            cost_usd += c

        try:
            for hop in range(max_hops):
                hops_used = hop + 1
                is_final = hop == max_hops - 1
                hop_tools = None if is_final else tools_payload
                hop_system = _AGENT_SYSTEM_PROMPT
                if is_final and tools_payload:
                    hop_system += (
                        "\n\n[FINISH] No more tool calls are available. "
                        "Write your findings brief now from what you have "
                        "already gathered."
                    )

                hop_text_parts: list[str] = []
                pending_calls: dict[int, dict[str, str]] = {}
                hop_finish: str | None = None

                async for ev in model_router.stream_chat_events(
                    provider=provider,
                    model_id=model_id,
                    messages=running_history,
                    system=hop_system,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=hop_tools,
                    tool_choice=None,
                    include_usage=True,
                ):
                    if isinstance(ev, TextDelta):
                        hop_text_parts.append(ev.text)
                    elif isinstance(ev, ToolCallDelta):
                        slot = pending_calls.setdefault(
                            ev.index, {"id": "", "name": "", "arguments": ""}
                        )
                        if ev.id:
                            slot["id"] = ev.id
                        if ev.name:
                            slot["name"] = ev.name
                        if ev.arguments:
                            slot["arguments"] += ev.arguments
                    elif isinstance(ev, UsageEvent):
                        if ev.cost_usd is not None:
                            cost_usd += ev.cost_usd
                    elif isinstance(ev, FinishEvent):
                        hop_finish = ev.reason

                hop_text = "".join(hop_text_parts)
                if hop_text:
                    text_parts.append(hop_text)

                # Done: the model answered in text, or we're out of hops,
                # or nothing callable came back.
                if is_final or hop_finish != "tool_calls" or not pending_calls:
                    break

                # Append the assistant tool-call turn, then dispatch.
                from app.chat.router import _build_tool_calls_payload

                tool_calls_payload = _build_tool_calls_payload(pending_calls)
                if not tool_calls_payload:
                    break
                running_history.append(
                    {
                        "role": "assistant",
                        "content": hop_text or None,
                        "tool_calls": tool_calls_payload,
                    }
                )

                tool_ctx = ToolContext(
                    db=db,
                    user=user,
                    conversation_id=conversation_id,
                    user_message_id=user_message_id,
                )
                # No ``request`` object in a headless run; the audit
                # helper only reads ``.client`` / ``.headers`` defensively.
                fake_request = _HeadlessRequest()
                async for _sse_str, hist_msg in _dispatch_tools(
                    db=db,
                    request=fake_request,  # type: ignore[arg-type]
                    user=user,
                    pending_calls=pending_calls,
                    ctx=tool_ctx,
                    sse_yield=_noop_sse,
                    on_attachment=lambda _snap: None,
                    on_sources=sources.extend,
                    on_cost=_add_cost,
                    invocation_counts=invocation_counts,
                    per_tool_caps=per_tool_caps,
                ):
                    if hist_msg is not None:
                        tool_count += 1
                        running_history.append(hist_msg)
        except ProviderError as e:
            logger.info("sub-agent provider error: %s", e)
            return AgentResult(
                task=task,
                text=f"the agent couldn't complete (model error: {e})",
                sources=_dedupe(sources),
                cost_usd=cost_usd,
                tool_calls=tool_count,
                hops=hops_used,
                error="provider_error",
            )
        except Exception:  # noqa: BLE001 — never let one agent kill the fan-out
            logger.exception("sub-agent crashed on task=%r", task[:120])
            return AgentResult(
                task=task,
                text="the agent failed unexpectedly",
                sources=_dedupe(sources),
                cost_usd=cost_usd,
                tool_calls=tool_count,
                hops=hops_used,
                error="crashed",
            )

        digest = "".join(text_parts).strip()
        if len(digest) > _MAX_DIGEST_CHARS:
            digest = digest[:_MAX_DIGEST_CHARS].rstrip() + "\n…[brief truncated]"
        if not digest:
            digest = (
                "the agent gathered material but produced no written "
                "findings"
            )
        return AgentResult(
            task=task,
            text=digest,
            sources=_dedupe(sources),
            cost_usd=cost_usd,
            tool_calls=tool_count,
            hops=hops_used,
        )


def _dedupe(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop duplicate-URL sources, first occurrence wins."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or "")
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(r)
    return out


class _HeadlessRequest:
    """Minimal stand-in for FastAPI's ``Request`` in a headless run.

    ``_audit_tool_event`` → ``record_event`` reads ``client`` and
    ``headers`` best-effort; both are absent here, which the audit path
    already tolerates (it's wrapped in a broad except)."""

    client = None
    headers: dict[str, str] = {}


__all__ = ["AgentResult", "run_agent", "DEFAULT_AGENT_HOPS"]
