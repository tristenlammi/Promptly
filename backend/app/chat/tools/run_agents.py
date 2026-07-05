"""``run_agents`` — fan a turn out across parallel research sub-agents.

The model hands us 1–4 self-contained tasks; we run each as an
independent sub-agent (its own model↔tool loop, its own DB session, its
own search/fetch budget) **concurrently**, then hand back one merged
brief plus deduped citations. The parent model synthesises from the
briefs.

Why this shape:

* **Breadth without burning the hop budget.** One ``run_agents`` call
  costs the parent a single tool hop but does the work of a dozen
  search/fetch round-trips — the parent's ``MAX_TOOL_HOPS`` ceiling
  stays for depth, this buys width.
* **Token-bloat containment.** Each agent reads pages into its *own*
  context and returns only a bounded digest, so the parent history
  never sees the raw page text. This is a stronger fix than truncation:
  it compresses rather than clips.
* **Depth-1 by construction.** Sub-agents are given the ``search`` tool
  set only — never ``run_agents`` itself — so an agent cannot spawn
  agents. No runtime recursion guard needed.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.chat.models import Conversation
from app.chat.tools.base import Tool, ToolContext, ToolError, ToolResult
from app.search.service import pick_search_provider

logger = logging.getLogger("promptly.tools.run_agents")

_MAX_AGENTS = 4
_MAX_TASK_CHARS = 600

# Per-AGENT tool budget — deliberately tighter than the top-level turn
# caps (web_search 5 / fetch_url 4). A fan-out multiplies whatever each
# agent spends: 4 agents on the default caps could fire 20 searches in
# seconds from one IP, which is exactly the burst signature that gets a
# self-hosted SearXNG CAPTCHA-walled by its upstream engines. 3+2 per
# agent covers a real search→read→refine chain while keeping a full
# fan-out at ≤12 searches.
_AGENT_TOOL_CAPS = {"web_search": 3, "fetch_url": 2}

# Stagger between agent launches. Concurrent agents otherwise fire
# their first searches in the same instant; a sub-second offset smooths
# the burst without meaningfully delaying the fan-out (agents run for
# tens of seconds).
_LAUNCH_STAGGER_S = 0.75


class RunAgentsTool(Tool):
    name = "run_agents"
    category = "agents"
    # One fan-out per turn: each call already runs up to four agents,
    # each with its own multi-hop search budget. A second call in the
    # same turn is almost always the model failing to plan; make it ask
    # for another user turn instead.
    max_per_turn = 1
    # Generous: the tool awaits up to four concurrent multi-hop agents.
    # The per-agent model + tool timeouts bound each one; this is the
    # backstop for the whole fan-out.
    timeout_seconds = 300.0
    # The merged brief is already digest-of-digests; keep the re-fed
    # string bounded regardless of how chatty the agents were.
    max_content_chars = 14_000
    description = (
        "Run several focused research tasks IN PARALLEL as independent "
        "sub-agents, then get back a merged brief with citations. Each "
        "sub-agent has web search + page-reading tools and works on ONE "
        "task you give it. Use this when a request naturally splits into "
        "distinct, independent lines of research that would otherwise "
        "need many sequential searches — e.g. comparing several products "
        "or entities, gathering different facets of a topic, or "
        "researching multiple candidates at once. Give each agent a "
        "specific, self-contained task (it can't see the others or ask "
        "you questions). Do NOT use it for a single simple lookup (call "
        "web_search directly) or for tasks that depend on each other's "
        "results (do those in sequence yourself)."
    )
    prompt_hint = (
        "Fan out 2–4 independent research tasks to parallel sub-agents "
        "(each with web search) and get back a merged, cited brief. Best "
        "for comparisons or multi-part research where the parts are "
        "independent. For one simple fact, just call web_search."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "description": (
                    "The independent research tasks, one per sub-agent "
                    f"(1–{_MAX_AGENTS}). Each must be specific and "
                    "self-contained — the agent sees only its own task."
                ),
                "minItems": 1,
                "maxItems": _MAX_AGENTS,
                "items": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": (
                                "A specific, self-contained research "
                                "instruction for one sub-agent, phrased "
                                "so it makes sense with no other context."
                            ),
                            "maxLength": _MAX_TASK_CHARS,
                        }
                    },
                    "required": ["task"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["tasks"],
        "additionalProperties": False,
    }

    async def run(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        raw_tasks = args.get("tasks")
        if not isinstance(raw_tasks, list) or not raw_tasks:
            raise ToolError("`tasks` must be a non-empty array")
        tasks: list[str] = []
        for entry in raw_tasks[:_MAX_AGENTS]:
            if not isinstance(entry, dict):
                continue
            t = entry.get("task")
            if isinstance(t, str) and t.strip():
                tasks.append(t.strip()[:_MAX_TASK_CHARS])
        if not tasks:
            raise ToolError("no valid task strings in `tasks`")

        # Sub-agents need a model to run. Reuse the conversation's own
        # provider + model (a cheaper dedicated agent model is a future
        # admin knob, not v1).
        conv = await ctx.db.get(Conversation, ctx.conversation_id)
        if conv is None or conv.provider_id is None or not conv.model_id:
            raise ToolError(
                "Can't run sub-agents: this conversation has no model "
                "configured."
            )

        # Sub-agents get the SEARCH tool set only — never ``run_agents``
        # itself (different category), so depth-1 is structural. Bail
        # early if search isn't actually configured; agents with no
        # tools are pointless.
        provider = await pick_search_provider(ctx.db, ctx.user)
        if provider is None:
            raise ToolError(
                "Can't run sub-agents: no web-search provider is "
                "configured. Ask an admin to enable one in Search "
                "settings."
            )
        # Lazy import: ``registry`` imports this module at load time, so
        # importing it here at module scope would close a cycle.
        from app.chat.tools.registry import list_openai_tools

        agent_tools = list_openai_tools({"search"})
        if not agent_tools:
            raise ToolError("No sub-agent tools are available.")

        # Import here to keep the module-load graph acyclic (router →
        # registry → this tool → agent_runner → [lazy] router).
        from app.chat.agent_runner import AgentResult, run_agent

        logger.info(
            "run_agents user=%s conv=%s agents=%d",
            ctx.user.id,
            ctx.conversation_id,
            len(tasks),
        )

        total = len(tasks)
        ctx.report_progress(f"0/{total} agents done")

        # Launch all agents (with a small stagger — see _LAUNCH_STAGGER_S),
        # then report as each finishes so the UI can count down instead
        # of staring at a frozen spinner for up to a few minutes.
        # Results are re-ordered back to the task order afterwards so
        # the merged brief reads in the order the model asked for.
        async def _launch(index: int, task: str):
            if index:
                await asyncio.sleep(index * _LAUNCH_STAGGER_S)
            return await run_agent(
                user_id=ctx.user.id,
                conversation_id=ctx.conversation_id,
                user_message_id=ctx.user_message_id,
                task=task,
                provider_id=conv.provider_id,
                model_id=conv.model_id,
                tools_payload=agent_tools,
                per_tool_caps=dict(_AGENT_TOOL_CAPS),
            )

        launched = [
            asyncio.ensure_future(_launch(i, task))
            for i, task in enumerate(tasks)
        ]
        by_task_index = {t: i for i, t in enumerate(launched)}
        ordered: list[AgentResult | None] = [None] * total
        done_count = 0
        for fut in asyncio.as_completed(launched):
            res = await fut
            done_count += 1
            ctx.report_progress(f"{done_count}/{total} agents done")
        # ``as_completed`` loses the mapping, so read each future's
        # result back into task order once all have resolved.
        for fut, idx in by_task_index.items():
            ordered[idx] = fut.result()
        results: list[AgentResult] = [r for r in ordered if r is not None]

        # ---- Merge briefs into one model-facing string ----
        blocks: list[str] = []
        for i, r in enumerate(results, start=1):
            header = f"### Agent {i}: {r.task}"
            if r.error:
                blocks.append(f"{header}\n[failed] {r.text}")
            else:
                blocks.append(f"{header}\n{r.text}")
        content = (
            "You ran "
            f"{len(results)} research sub-agent(s) in parallel. Their "
            "findings are below. Write your final answer for the user "
            "NOW from these briefs, citing sources inline with [1], "
            "[2] from the merged citation list. The agents already "
            "searched and read pages — do NOT call web_search or "
            "fetch_url again to re-verify their findings; only search "
            "again if a fact the user explicitly asked for is missing "
            "from every brief.\n\n" + "\n\n".join(blocks)
        )

        # ---- Merge + renumber citations across agents ----
        merged_sources = _merge_sources(r.sources for r in results)

        total_cost = sum(r.cost_usd for r in results)
        ok_count = sum(1 for r in results if not r.error)
        meta: dict[str, Any] = {
            "agent_count": len(results),
            "agents": [
                {
                    "task": r.task,
                    "ok": r.error is None,
                    "tool_calls": r.tool_calls,
                    "sources": len(r.sources),
                }
                for r in results
            ],
            "ok_count": ok_count,
            "result_count": len(merged_sources),
        }
        if total_cost > 0:
            meta["cost_usd"] = total_cost

        return ToolResult(content=content, sources=merged_sources, meta=meta)


def _merge_sources(
    per_agent: Any,
) -> list[dict[str, Any]]:
    """Flatten every agent's citations into one deduped list.

    First occurrence of a URL wins so the numbering stays stable; the
    chat router runs its own canonical-URL dedup at persistence time
    too, so this only has to be good enough for the model-facing list.
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for rows in per_agent:
        for r in rows or []:
            if not isinstance(r, dict):
                continue
            url = str(r.get("url") or "")
            if not url or url in seen:
                continue
            seen.add(url)
            out.append(r)
    return out


__all__ = ["RunAgentsTool"]
