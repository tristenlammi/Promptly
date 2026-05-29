"""Headless run engine for Scheduled Tasks (Phase 1 — T.1).

Executes a task's prompt with no human watching and stores the result as
a :class:`TaskRun`. Reuses the streaming provider interface
(``model_router.stream_chat_events``) but *collects* the full output
instead of streaming it to a socket, and drives a compact tool loop that
supports the ``search`` family (``web_search`` + ``fetch_url``) so a
news/digest task can pull fresh facts.

Artefact tools (image / PDF generation) are intentionally **not** offered
headless: they attach files to a conversation+message that a task run
doesn't have. Tasks that need a PDF can use the T.3 "export run as PDF"
action instead.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import delete, select

from app.auth.models import User
from app.chat.tools.base import ToolContext, ToolError
from app.chat.tools.registry import get_tool, list_openai_tools
from app.custom_models.resolver import is_custom_model_id, resolve_custom_model
from app.database import SessionLocal
from app.models_config.models import ModelProvider
from app.models_config.provider import (
    ChatMessage,
    FinishEvent,
    ProviderError,
    ReasoningDelta,
    TextDelta,
    ToolCallDelta,
    UsageEvent,
    model_router,
)
from app.tasks.models import Task, TaskRun

logger = logging.getLogger("promptly.tasks.runner")

# Cap headless tool hops. A scheduled run that searches more than a
# handful of times is almost always looping; better to summarise what it
# has. Each hop may emit several tool calls.
_MAX_HOPS = 6
_NIL_UUID = uuid.UUID(int=0)

# Per-run output ceiling (T.4 cost guard). Headless runs can't be watched
# and a runaway model would silently burn budget, so we cap completion
# length. Generous enough for a multi-section digest (~6k words) while
# still bounding worst-case spend.
_MAX_OUTPUT_TOKENS = 8000


class TaskRunError(RuntimeError):
    """Controlled failure during a run — message is safe to store."""


def _build_system_prompt(task: Task, now_local_iso: str) -> str:
    parts = [
        "You are Promptly's automation engine running a scheduled task "
        "with no human watching. Produce a single, self-contained, "
        "well-formatted Markdown report that stands on its own — assume "
        "the reader did not see any previous run. Think of it as a clean "
        "newsletter back-issue the reader will skim in under a minute.",
        f"The current date/time is {now_local_iso} ({task.timezone}).",
        "Structure:",
        "- Open with a single `#` title naming the report and the date.",
        "- Follow with a one- or two-sentence plain-text summary of the "
        "  most important takeaways.",
        "- Group the body into clearly labelled `##` sections. Within a "
        "  section, lead each item with a short **bold** lead-in phrase, "
        "  then a sentence or two of detail.",
        "- Prefer short paragraphs and bullet lists over walls of text. "
        "  Use a Markdown table only when comparing structured data.",
        "Style rules (important for clean rendering):",
        "- Write monetary amounts as plain words: `US$965 billion` or "
        "  `965 billion USD`. NEVER wrap amounts, numbers, or text in "
        "  `$...$` or `\\(...\\)` — that is LaTeX math and will render as "
        "  garbled symbols. Do not use LaTeX/math syntax at all unless the "
        "  task is explicitly about mathematics.",
        "- Keep bold for emphasis on key terms, not whole sentences.",
        "- Be concise and factual. No preamble like 'Sure, here is' and no "
        "  sign-off; the report is the entire response.",
    ]
    if task.use_web_search:
        parts.append(
            "Sourcing:\n"
            "- You have a web_search tool. Use it to gather current "
            "information rather than relying on memory, and cite sources "
            "inline with [1], [2], … matching the results you used. Place "
            "the citation marker at the end of the relevant sentence."
        )
    return "\n".join(parts)


async def _resolve_provider(
    task: Task, db
) -> tuple[ModelProvider, str]:
    """Return (provider, effective_model_id) or raise TaskRunError."""
    if task.provider_id is None or not task.model_id:
        raise TaskRunError(
            "This task has no model configured. Edit the task and pick one."
        )
    provider = await db.get(ModelProvider, task.provider_id)
    if provider is None:
        raise TaskRunError(
            "The model provider for this task no longer exists. Pick a "
            "different model."
        )
    if not provider.enabled:
        raise TaskRunError("The model provider for this task is disabled.")

    effective_model_id = task.model_id
    if is_custom_model_id(task.model_id):
        resolved = await resolve_custom_model(task.model_id, db)
        if resolved is None:
            raise TaskRunError("The custom model for this task is unavailable.")
        effective_model_id = resolved.base_model_id
    return provider, effective_model_id


async def _generate(
    *,
    provider: ModelProvider,
    model_id: str,
    system: str,
    prompt: str,
    user: User,
    use_web_search: bool,
    reasoning_effort: str | None,
    db,
) -> tuple[str, list[dict], dict]:
    """Run the compact tool loop. Returns (text, sources, usage)."""
    tools = list_openai_tools({"search"}) if use_web_search else None
    is_deepseek = provider.type == "deepseek"
    convo: list = [ChatMessage(role="user", content=prompt)]
    sources: list[dict] = []
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": None}
    final_text = ""
    # Keep the most recent hop that produced visible prose. Reasoning
    # models can end a tool hop with chain-of-thought only (no content),
    # so we never want to lose an earlier, real answer to a later empty
    # hop.
    last_text = ""

    async def _consume(_tools):
        """Stream one turn; return (text, reasoning, pending, finish)."""
        hop_text: list[str] = []
        hop_reasoning: list[str] = []
        pending: dict[int, dict[str, str]] = {}
        finish: str | None = None
        async for ev in model_router.stream_chat_events(
            provider=provider,
            model_id=model_id,
            messages=convo,
            system=system,
            temperature=0.4,
            tools=_tools,
            include_usage=True,
            reasoning_effort=reasoning_effort,
            max_tokens=_MAX_OUTPUT_TOKENS,
        ):
            if isinstance(ev, TextDelta):
                hop_text.append(ev.text)
            elif isinstance(ev, ReasoningDelta):
                hop_reasoning.append(ev.text)
            elif isinstance(ev, ToolCallDelta):
                slot = pending.setdefault(
                    ev.index, {"id": "", "name": "", "arguments": ""}
                )
                if ev.id:
                    slot["id"] = ev.id
                if ev.name:
                    slot["name"] = ev.name
                if ev.arguments:
                    slot["arguments"] += ev.arguments
            elif isinstance(ev, UsageEvent):
                if ev.prompt_tokens:
                    usage["prompt_tokens"] += ev.prompt_tokens
                if ev.completion_tokens:
                    usage["completion_tokens"] += ev.completion_tokens
                if ev.cost_usd is not None:
                    usage["cost_usd"] = (usage["cost_usd"] or 0.0) + ev.cost_usd
            elif isinstance(ev, FinishEvent):
                finish = ev.reason
        return hop_text, hop_reasoning, pending, finish

    for _hop in range(_MAX_HOPS):
        hop_text, hop_reasoning, pending, finish = await _consume(tools)

        text_now = "".join(hop_text).strip()
        if text_now:
            last_text = text_now

        tool_calls = [
            {
                "id": s["id"],
                "type": "function",
                "function": {"name": s["name"], "arguments": s.get("arguments", "")},
            }
            for _, s in sorted(pending.items())
            if s.get("id") and s.get("name")
        ]

        # No tool calls (or the model finished normally) → this hop's text
        # is the report.
        if not tool_calls or finish != "tool_calls":
            final_text = text_now or last_text
            break

        # Otherwise append the assistant tool-call turn + each result and
        # re-enter so the model can synthesise its answer. DeepSeek's
        # thinking mode *requires* the ``reasoning_content`` it streamed to
        # be passed back on the assistant turn or the next call 400s.
        assistant_turn: dict = {
            "role": "assistant",
            "content": "".join(hop_text),
            "tool_calls": tool_calls,
        }
        if is_deepseek and hop_reasoning:
            assistant_turn["reasoning_content"] = "".join(hop_reasoning)
        convo.append(assistant_turn)
        for call in tool_calls:
            name = call["function"]["name"]
            tool = get_tool(name)
            try:
                args = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            if tool is None:
                content = f"Unknown tool: {name}"
            else:
                ctx = ToolContext(
                    db=db,
                    user=user,
                    conversation_id=_NIL_UUID,
                    user_message_id=_NIL_UUID,
                )
                try:
                    result = await tool.run(ctx, args)
                    content = result.content
                    if result.sources:
                        sources.extend(result.sources)
                except ToolError as e:
                    content = f"Tool error: {e}"
                except Exception as e:  # noqa: BLE001
                    logger.exception("Task tool %s crashed", name)
                    content = f"Tool failed: {type(e).__name__}"
            convo.append(
                {"role": "tool", "tool_call_id": call["id"], "content": content}
            )
    else:
        # Loop exhausted while still wanting tools — keep the best prose so
        # far for the forced-synthesis fallback below.
        final_text = last_text

    # Forced synthesis: if the tool loop never produced visible prose (a
    # reasoning model that thought + searched but never "spoke", or a hop
    # that ended on tool-calls), make one last call with tools disabled so
    # the model is compelled to write the report from what it gathered.
    if not final_text:
        convo.append(
            {
                "role": "user",
                "content": (
                    "Now write the final report in Markdown based on the "
                    "information gathered above. Output only the report — no "
                    "tool calls, no preamble."
                ),
            }
        )
        hop_text, _r, _p, _f = await _consume(None)
        final_text = "".join(hop_text).strip() or last_text

    if not final_text:
        logger.info(
            "Task produced empty report (model=%s web_search=%s)",
            model_id,
            use_web_search,
        )
        raise TaskRunError(
            "The model returned an empty report. Try a different model, or "
            "turn off web search if the provider doesn't support tool use."
        )

    # De-dup sources by URL, preserving order.
    seen: set[str] = set()
    deduped: list[dict] = []
    for s in sources:
        url = s.get("url")
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        deduped.append(s)

    return final_text, deduped, usage


async def execute_run(run_id: uuid.UUID) -> None:
    """Execute an already-created pending :class:`TaskRun` to completion.

    Opens its own session so it can be spawned as a detached task from
    both the scheduler and the "Run now" endpoint. Never raises — every
    failure is recorded on the run row.
    """
    async with SessionLocal() as db:
        run = await db.get(TaskRun, run_id)
        if run is None:
            logger.warning("execute_run: run %s vanished", run_id)
            return
        task = await db.get(Task, run.task_id)
        if task is None:
            run.status = "failed"
            run.error = "Task was deleted before the run could start."
            run.finished_at = datetime.now(timezone.utc)
            await db.commit()
            return

        run.status = "running"
        run.started_at = datetime.now(timezone.utc)
        await db.commit()

        try:
            user = await db.get(User, task.user_id)
            if user is None:
                raise TaskRunError("Task owner no longer exists.")
            provider, model_id = await _resolve_provider(task, db)
            now_local = run.started_at.astimezone(timezone.utc).isoformat(
                timespec="minutes"
            )
            system = _build_system_prompt(task, now_local)
            text, sources, usage = await _generate(
                provider=provider,
                model_id=model_id,
                system=system,
                prompt=task.prompt,
                user=user,
                use_web_search=task.use_web_search,
                reasoning_effort=task.reasoning_effort,
                db=db,
            )
            run.output_markdown = text
            run.sources = sources
            run.prompt_tokens = usage["prompt_tokens"] or None
            run.completion_tokens = usage["completion_tokens"] or None
            run.cost_usd = usage["cost_usd"]
            run.status = "success"
        except (TaskRunError, ProviderError) as e:
            run.status = "failed"
            run.error = str(e)
            logger.info("Task run %s failed: %s", run_id, e)
        except Exception as e:  # noqa: BLE001
            run.status = "failed"
            run.error = f"Unexpected error: {type(e).__name__}"
            logger.exception("Task run %s crashed", run_id)
        finally:
            run.finished_at = datetime.now(timezone.utc)
            # Mirror the terminal status onto the parent task for the
            # list view, without touching next_run_at (the scheduler owns
            # that).
            task.last_run_at = run.started_at
            task.last_status = run.status
            await db.commit()
            # Best-effort completion push (T.3). Captured outside the
            # session-bound rows so a notify failure can't roll anything
            # back. Honours the per-task ``notify`` flag + the user's
            # ``task_complete`` notification preference.
            final_status = run.status
            notify = task.notify
            owner_id = task.user_id
            title = task.title
            task_id = task.id
            retention = task.retention_runs

        # Retention sweep (T.4): keep only the newest ``retention_runs``
        # rows for this task so history can't grow without bound. Runs in
        # the same session right after the terminal commit.
        if retention and retention > 0:
            try:
                stale = (
                    await db.execute(
                        select(TaskRun.id)
                        .where(TaskRun.task_id == task_id)
                        .order_by(TaskRun.created_at.desc())
                        .offset(retention)
                    )
                ).scalars().all()
                if stale:
                    await db.execute(
                        delete(TaskRun).where(TaskRun.id.in_(stale))
                    )
                    await db.commit()
            except Exception:  # pragma: no cover — pruning is best-effort
                logger.warning("task run retention sweep failed", exc_info=True)

        if notify:
            try:
                from app.notifications import notify_user

                ok = final_status == "success"
                await notify_user(
                    user_id=owner_id,
                    category="task_complete",
                    title=("Task report ready" if ok else "Task failed"),
                    body=(
                        f"'{title}' has a new report."
                        if ok
                        else f"'{title}' failed to run."
                    ),
                    url=f"/tasks/{task_id}",
                    tag=f"promptly-task-{task_id}",
                )
            except Exception:  # pragma: no cover — push is never critical
                logger.warning("task completion push failed", exc_info=True)


__all__ = ["execute_run", "TaskRunError"]
