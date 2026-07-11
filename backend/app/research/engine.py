"""Deep Research engine (Phase 11).

Multi-step agentic loop:
  1. Decompose  — fast model breaks the query into 5 focused sub-questions
  2. Search     — parallel web_search for each sub-question
  3. Read       — fetch_url on top-2 URLs per sub-question
  4. Gap check  — fast model identifies missing angles; 1-2 follow-up searches
  5. Synthesize — best model writes a structured, cited report (streaming)
  6. Save       — persist user + assistant messages; return them to the frontend
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Conversation, Message
from app.chat.pdf_render import PdfRenderError, render_markdown_to_pdf
from app.chat.schemas import MessageResponse
from app.chat.tools.base import ToolContext
from app.chat.tools.fetch_url import FetchUrlTool
from app.database import SessionLocal
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.generated_kinds import GeneratedKind
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, TextDelta, UsageEvent, model_router
from app.search.service import pick_search_provider, run_search_with_failover

logger = logging.getLogger("promptly.research")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_NUM_SUBQUESTIONS = 5
_NUM_REFINE_SUBQUESTIONS = 3     # focused follow-up pass when refining
_SEARCH_RESULTS_PER_SQ = 6       # results fetched per sub-question
_READS_PER_SQ = 2                 # max URL fetches per sub-question
_MAX_CONTENT_CHARS = 3000         # chars of fetched content per source
_MAX_SNIPPET_CHARS = 400          # chars when only a snippet is available
_MAX_EVIDENCE_CHARS = 35_000      # total evidence doc cap for synthesis prompt
_SYNTHESIS_MAX_TOKENS = 3000      # max tokens for the synthesis output
_FAST_MAX_TOKENS = 600            # max tokens for decompose / gap-check

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
_DECOMPOSE_PROMPT = """\
Given a research topic, produce exactly {n} focused sub-questions that together \
provide comprehensive coverage of the subject from distinct angles.

Output a JSON array with exactly {n} objects, nothing else:
[
  {{"question": "...", "search_query": "concise 4-6 word search string"}},
  ...
]

Research topic: {query}"""

_GAP_CHECK_PROMPT = """\
Given the evidence collected so far for a research report on "{query}", \
identify the 1-2 most important angles that are missing or underrepresented. \
If coverage is already comprehensive, output an empty array.

Evidence themes covered:
{themes}

Output a JSON array with 0-2 objects, nothing else:
[
  {{"gap": "short description of what's missing", "search_query": "concise 4-6 word search string"}},
  ...
]"""

_SYNTHESIS_SYSTEM = """\
You are writing a comprehensive research report. Use ONLY the provided evidence — \
do not rely on training knowledge for factual claims. Every non-trivial claim \
must be supported by an inline citation [N] where N matches the source index \
in the evidence.

Format requirements:
• Start with ## Executive Summary (3-4 sentences of key findings)
• Use ## headings for each main section (4-6 sections total)
• Inline citations: [1], [2], etc. immediately after supported claims
• Total length: 600-1000 words
• Do NOT include a top-level # title — start with ## Executive Summary
• Do NOT add a ## Sources section — sources are listed separately
• If evidence is thin on a point, say so rather than speculating\
"""

_SYNTHESIS_USER = """\
Research topic: {query}

Evidence ({source_count} sources across {angle_count} angles):

{evidence_doc}

Write the research report now."""

# --- Refinement ("dig deeper") prompts -------------------------------------
_REFINE_DECOMPOSE_PROMPT = """\
A research report already exists on the topic: {query}

The user now wants to dig deeper specifically on: {refinement}

Produce exactly {n} focused sub-questions that target THIS refinement (not the \
whole original topic), each with a concise search string.

Output a JSON array with exactly {n} objects, nothing else:
[
  {{"question": "...", "search_query": "concise 4-6 word search string"}},
  ...
]"""

_REFINE_SYNTHESIS_SYSTEM = """\
You are revising an existing research report to go deeper on one aspect the user \
asked about. Use the NEW evidence below (cite as [N]) together with the prior \
report's existing findings.

Format requirements:
• Produce the FULL updated report — it REPLACES the previous one, so don't write a bare addendum.
• Keep the prior report's structure and still-valid content; substantially expand the section(s) relevant to the refinement using the new evidence.
• Start with ## Executive Summary; use ## headings (4-6 sections); add inline [N] citations for claims drawn from the new evidence.
• Do NOT include a top-level # title and do NOT add a ## Sources section — sources are listed separately.
• Total length: 700-1200 words. If the new evidence is thin, say so rather than padding."""

_REFINE_SYNTHESIS_USER = """\
Original research topic: {query}
The user wants to dig deeper on: {refinement}

PRIOR REPORT (to expand, not discard):
{prior_report}

NEW EVIDENCE ({source_count} sources across {angle_count} angles):

{evidence_doc}

Write the full updated report now, going deeper on the requested refinement."""

# ---------------------------------------------------------------------------
# SSE helper
# ---------------------------------------------------------------------------
def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# ---------------------------------------------------------------------------
# Decompose
# ---------------------------------------------------------------------------
async def _decompose(
    query: str,
    provider: ModelProvider,
    model_id: str,
) -> list[dict]:
    """Break the query into sub-questions. Returns list of {question, search_query}."""
    prompt = _DECOMPOSE_PROMPT.format(n=_NUM_SUBQUESTIONS, query=query)
    chunks: list[str] = []
    try:
        async for event in model_router.stream_chat_events(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=prompt)],
            temperature=0.3,
            max_tokens=_FAST_MAX_TOKENS,
        ):
            if isinstance(event, TextDelta):
                chunks.append(event.text)
    except Exception:
        logger.exception("Decompose model call failed")
        # Fallback: use the query itself as a single "sub-question"
        return [{"question": query, "search_query": query}]

    raw = "".join(chunks).strip()
    # Strip think blocks (DeepSeek)
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        return [{"question": query, "search_query": query}]
    try:
        sqs = json.loads(raw[start : end + 1])
        valid = [
            sq for sq in sqs
            if isinstance(sq, dict)
            and sq.get("question")
            and sq.get("search_query")
        ]
        return valid[:_NUM_SUBQUESTIONS] if valid else [{"question": query, "search_query": query}]
    except (ValueError, TypeError):
        return [{"question": query, "search_query": query}]


async def _decompose_refine(
    query: str,
    refinement: str,
    provider: ModelProvider,
    model_id: str,
) -> list[dict]:
    """Break a refinement instruction into focused follow-up sub-questions."""
    prompt = _REFINE_DECOMPOSE_PROMPT.format(
        query=query, refinement=refinement, n=_NUM_REFINE_SUBQUESTIONS
    )
    chunks: list[str] = []
    try:
        async for event in model_router.stream_chat_events(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=prompt)],
            temperature=0.3,
            max_tokens=_FAST_MAX_TOKENS,
        ):
            if isinstance(event, TextDelta):
                chunks.append(event.text)
    except Exception:
        logger.exception("Refine decompose failed")
        return [{"question": refinement, "search_query": refinement}]

    raw = "".join(chunks).strip()
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        return [{"question": refinement, "search_query": refinement}]
    try:
        sqs = json.loads(raw[start : end + 1])
        valid = [
            sq for sq in sqs
            if isinstance(sq, dict)
            and sq.get("question")
            and sq.get("search_query")
        ]
        return (
            valid[:_NUM_REFINE_SUBQUESTIONS]
            if valid
            else [{"question": refinement, "search_query": refinement}]
        )
    except (ValueError, TypeError):
        return [{"question": refinement, "search_query": refinement}]


# ---------------------------------------------------------------------------
# Gap check
# ---------------------------------------------------------------------------
async def _gap_check(
    query: str,
    evidence: list[dict],
    provider: ModelProvider,
    model_id: str,
) -> list[dict]:
    """Identify missing research angles. Returns list of {gap, search_query}."""
    themes = "\n".join(
        f"- {a['subquestion']}" for a in evidence
    )
    prompt = _GAP_CHECK_PROMPT.format(query=query, themes=themes)
    chunks: list[str] = []
    try:
        async for event in model_router.stream_chat_events(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=prompt)],
            temperature=0.3,
            max_tokens=_FAST_MAX_TOKENS,
        ):
            if isinstance(event, TextDelta):
                chunks.append(event.text)
    except Exception:
        return []

    raw = "".join(chunks).strip()
    raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        gaps = json.loads(raw[start : end + 1])
        return [
            g for g in gaps
            if isinstance(g, dict) and g.get("gap") and g.get("search_query")
        ][:2]
    except (ValueError, TypeError):
        return []


# ---------------------------------------------------------------------------
# Evidence document builder
# ---------------------------------------------------------------------------
def _build_evidence_doc(evidence: list[dict]) -> str:
    """Render the evidence into a structured document for the synthesis prompt."""
    parts: list[str] = []
    for angle in evidence:
        parts.append(f"=== ANGLE: {angle['subquestion']} ===\n")
        for item in angle["items"]:
            title = item.get("title") or "Untitled"
            url = item.get("url") or ""
            content = (item.get("content") or "").strip()
            parts.append(
                f"[{item['index']}] {title}\n"
                f"URL: {url}\n"
                f"Content: {content}\n"
            )
        parts.append("")
    doc = "\n".join(parts)
    # Hard cap so we don't blow the context window.
    if len(doc) > _MAX_EVIDENCE_CHARS:
        doc = doc[:_MAX_EVIDENCE_CHARS] + "\n...[evidence truncated]"
    return doc


# ---------------------------------------------------------------------------
# Proactive-suggestion classifier (no LLM — fast rule-based)
# ---------------------------------------------------------------------------
_RESEARCH_POSITIVE = re.compile(
    r"\b("
    r"explain\s+the\s+(landscape|state|impact|evolution|mechanism|science|history|role|relationship)"
    r"|what\s+(are|were|have\s+been)\s+the\s+(key|main|major|primary|core|critical|significant)\s+"
    r"(factors?|trends?|challenges?|developments?|implications?|drivers?|reasons?|causes?|effects?)"
    r"|compare\s+\w+(\s+\w+)?\s+(and|with|vs\.?|versus)\s+\w+"
    r"|how\s+does\s+\w+(\s+\w+)?\s+(work|function|evolve|affect|impact|influence|differ|compare|relate)"
    r"|(comprehensive|detailed|thorough|in-depth|full)\s+(overview|analysis|guide|review|examination|breakdown)"
    r"|(history|evolution|development|origins?|progression)\s+of\s+\w"
    r"|(future|current|modern|recent)\s+(state|trends?|landscape|developments?|challenges?)\s+(of|in)\s+\w"
    r"|(advantages?\s+and\s+disadvantages?|pros?\s+and\s+cons?|benefits?\s+and\s+drawbacks?)"
    r"|(analyze|analyse|investigate|research|explore|examine)\s+\w"
    r"|what\s+is\s+the\s+(impact|effect|role|importance|significance|relationship|connection)"
    r"|overview\s+of"
    r"|deep\s+(dive|analysis|exploration)\s+(into|of)"
    r")\b",
    re.IGNORECASE,
)

_RESEARCH_NEGATIVE = re.compile(
    r"\b("
    r"how\s+to|how\s+do\s+i|can\s+you\s+(write|create|make|generate|help)"
    r"|write\s+(me|a|an)|create\s+(a|an)|make\s+(me|a)"
    r"|fix\s+(this|my|the)|debug|error|exception|traceback|bug|issue\s+with"
    r"|translate|summarize|summarise|sum\s+up|tldr|tl;dr"
    r")\b",
    re.IGNORECASE,
)


def is_research_worthy(query: str) -> bool:
    """Conservative rule-based classifier for proactive research suggestions.

    Returns True only for clearly open-ended investigation queries that would
    genuinely benefit from multi-source deep research. Intentionally conservative
    to avoid annoying users with suggestions on ordinary questions.
    """
    q = (query or "").strip()
    if len(q) < 60:
        return False
    if "`" in q:  # Code question
        return False
    if _RESEARCH_NEGATIVE.search(q):
        return False
    return bool(_RESEARCH_POSITIVE.search(q))


# ---------------------------------------------------------------------------
# Evidence gathering (shared core — no side effects)
# ---------------------------------------------------------------------------
@dataclass
class ResearchEvidence:
    """Structured output of the investigation phase.

    Everything a synthesis step (or a chat tool that wants to synthesise
    inline) needs, with ZERO side effects — no messages persisted, no PDF
    rendered, no stream emitted. Progress is observed through the
    ``on_progress`` callback while gathering; the collected evidence is
    returned here for the caller to do with as it likes.
    """

    evidence: list[dict[str, Any]]
    sources: list[dict[str, Any]]      # flattened [{title,url,snippet}] for a ToolResult
    evidence_doc: str                  # rendered, ≤_MAX_EVIDENCE_CHARS
    source_count: int
    angle_count: int


async def gather_research_evidence(
    *,
    query: str,
    db: AsyncSession,
    user: User,
    conversation_id: uuid.UUID,
    user_message_id: uuid.UUID,
    provider: ModelProvider,
    model_id: str,
    refinement: str | None = None,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> ResearchEvidence:
    """Run decompose → parallel search+read → gap-check and return evidence.

    This is the reusable heart of Deep Research, split out from
    :func:`run_research` so BOTH the user-triggered research endpoint and
    the ``deep_research`` chat tool call the exact same investigation
    logic. It has no side effects: progress is reported through
    ``on_progress`` (each call receives the same event dicts the endpoint
    turns into SSE), and the evidence is returned for the caller to
    synthesise however it likes.

    When ``refinement`` is set, the decomposition targets that follow-up
    instruction instead of the whole topic.
    """
    is_refine = bool(refinement)

    def _emit(ev: dict[str, Any]) -> None:
        if on_progress is not None:
            try:
                on_progress(ev)
            except Exception:  # noqa: BLE001 — progress is best-effort
                logger.debug("research on_progress callback failed", exc_info=True)

    # --- Step 1: Decompose ---
    _emit({"event": "research_start", "query": query, "refine": is_refine})
    if is_refine:
        subquestions = await _decompose_refine(
            query, refinement or "", provider, model_id
        )
    else:
        subquestions = await _decompose(query, provider, model_id)
    _emit({
        "event": "research_decomposed",
        "subquestions": [
            {"question": sq["question"], "search_query": sq["search_query"]}
            for sq in subquestions
        ],
    })

    # --- Step 2: Search + Read (parallel angles) ---
    search_provider = await pick_search_provider(db, user)
    placeholder_msg_id = user_message_id

    # Every sub-question is an independent research angle, so run them as
    # PARALLEL tasks — one per sub-question, each on its own DB session
    # (concurrent tasks must never share one), searching + reading its top
    # URLs at the same time as the others. Events are pushed to a queue we
    # drain into ``on_progress``; citation numbers are assigned in a
    # deterministic post-pass so they don't depend on finish order.
    event_q: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    all_seen_urls: set[str] = set()

    async def _investigate(idx: int, sq: dict[str, Any]) -> dict[str, Any]:
        # Small stagger so five searches don't hit the provider in the
        # same instant (the burst signature that trips search rate limits).
        if idx:
            await asyncio.sleep(idx * 0.3)
        items: list[dict[str, Any]] = []
        async with SessionLocal() as tdb:
            tuser = await tdb.get(User, user.id)
            if tuser is None:
                return {"subquestion": sq["question"], "items": items}
            tctx = ToolContext(
                db=tdb,
                user=tuser,
                conversation_id=conversation_id,
                user_message_id=placeholder_msg_id,
            )
            tfetch = FetchUrlTool()
            event_q.put_nowait({
                "event": "research_searching",
                "index": idx,
                "question": sq["question"],
            })
            try:
                results, _used = await run_search_with_failover(
                    tdb, tuser, sq["search_query"],
                    count=_SEARCH_RESULTS_PER_SQ,
                )
            except Exception:
                results = []
            event_q.put_nowait({
                "event": "research_searched",
                "index": idx,
                "sources_found": len(results),
            })

            reads = 0
            for result in results[:_SEARCH_RESULTS_PER_SQ]:
                url = (result.url or "").strip()
                if not url:
                    continue
                can_read = (
                    reads < _READS_PER_SQ
                    and url not in all_seen_urls
                    and url.startswith("http")
                )
                if can_read:
                    all_seen_urls.add(url)
                    event_q.put_nowait({
                        "event": "research_reading",
                        "index": idx,
                        "url": url,
                    })
                    try:
                        fr = await tfetch.run(tctx, {"url": url})
                        items.append({
                            "index": 0,  # assigned post-gather
                            "title": result.title or url,
                            "url": url,
                            "content": fr.content[:_MAX_CONTENT_CHARS],
                            "is_full": True,
                        })
                        reads += 1
                    except Exception:
                        items.append({
                            "index": 0,
                            "title": result.title or url,
                            "url": url,
                            "content": (result.snippet or "")[:_MAX_SNIPPET_CHARS],
                            "is_full": False,
                        })
                else:
                    items.append({
                        "index": 0,
                        "title": result.title or url,
                        "url": url,
                        "content": (result.snippet or "")[:_MAX_SNIPPET_CHARS],
                        "is_full": False,
                    })
                if len(items) >= _READS_PER_SQ + 2:
                    break
        event_q.put_nowait({"event": "research_question_done", "index": idx})
        return {"subquestion": sq["question"], "items": items}

    tasks = [
        asyncio.ensure_future(_investigate(i, sq))
        for i, sq in enumerate(subquestions)
    ]

    async def _sentinel() -> None:
        await asyncio.gather(*tasks, return_exceptions=True)
        event_q.put_nowait(None)

    sentinel = asyncio.ensure_future(_sentinel())
    try:
        while True:
            ev = await event_q.get()
            if ev is None:
                break
            _emit(ev)
    finally:
        sentinel.cancel()

    # Collect evidence in sub-question order and assign stable citation
    # numbers, regardless of which task finished first.
    evidence: list[dict[str, Any]] = []
    source_index = 1
    for t in tasks:
        if t.cancelled() or t.exception() is not None:
            continue
        angle = t.result()
        for it in angle["items"]:
            it["index"] = source_index
            source_index += 1
        evidence.append(angle)

    # --- Step 3: Gap check + follow-up searches ---
    _emit({"event": "research_gap_start"})
    gap_queries = await _gap_check(query, evidence, provider, model_id)
    extra_sources = 0

    for gap in gap_queries[:2]:
        try:
            if search_provider is not None:
                gap_results, _gused = await run_search_with_failover(
                    db,
                    user,
                    gap["search_query"],
                    count=4,
                    primary=search_provider,
                )
            else:
                gap_results = []
        except Exception:
            gap_results = []

        gap_items: list[dict[str, Any]] = []
        for r in gap_results[:3]:
            url = (r.url or "").strip()
            if not url:
                continue
            gap_items.append({
                "index": source_index,
                "title": r.title or url,
                "url": url,
                "content": (r.snippet or "")[:_MAX_SNIPPET_CHARS],
                "is_full": False,
            })
            source_index += 1
            extra_sources += 1

        if gap_items:
            evidence.append({
                "subquestion": gap["gap"],
                "items": gap_items,
            })

    _emit({"event": "research_gap_done", "extra_sources": extra_sources})

    all_sources = [item for angle in evidence for item in angle["items"]]
    sources_list = [
        {
            "title": s["title"],
            "url": s["url"],
            "snippet": (s["content"] or "")[:200],
        }
        for s in all_sources
    ]
    return ResearchEvidence(
        evidence=evidence,
        sources=sources_list,
        evidence_doc=_build_evidence_doc(evidence),
        source_count=len(all_sources),
        angle_count=len(evidence),
    )


# ---------------------------------------------------------------------------
# Main research generator
# ---------------------------------------------------------------------------
async def run_research(
    *,
    query: str,
    db: AsyncSession,
    user: User,
    conv: Conversation,
    provider: ModelProvider,
    model_id: str,
    refinement: str | None = None,
    prior_report: str | None = None,
) -> AsyncGenerator[str, None]:
    """Async generator that yields SSE strings for the research stream.

    When ``refinement`` + ``prior_report`` are supplied, this runs a
    focused follow-up pass ("dig deeper") instead of a full investigation:
    fewer, refinement-targeted sub-questions, and a synthesis that expands
    the prior report rather than writing one from scratch.
    """
    is_refine = bool(refinement and prior_report)

    async def _gen() -> AsyncGenerator[str, None]:  # noqa: C901 (complexity OK here)
        try:
            # --- Steps 1-3: gather evidence via the shared core ---
            # ``gather_research_evidence`` runs decompose → parallel
            # search+read → gap-check with no side effects, reporting each
            # event through ``on_progress``. Run it as a task and drain its
            # progress queue into the SSE stream so the frontend keeps
            # receiving the exact same event dicts it always has.
            progress_q: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
            gather_task = asyncio.ensure_future(
                gather_research_evidence(
                    query=query,
                    db=db,
                    user=user,
                    conversation_id=conv.id,
                    user_message_id=uuid.uuid4(),
                    provider=provider,
                    model_id=model_id,
                    refinement=refinement if is_refine else None,
                    on_progress=progress_q.put_nowait,
                )
            )

            async def _drain_sentinel() -> None:
                # Await the gather (swallowing its error — re-surfaced
                # after the drain) then unblock the drain loop.
                try:
                    await gather_task
                except Exception:  # noqa: BLE001 — reported below
                    pass
                finally:
                    progress_q.put_nowait(None)

            drain_sentinel = asyncio.ensure_future(_drain_sentinel())
            try:
                while True:
                    ev = await progress_q.get()
                    if ev is None:
                        break
                    yield _sse(ev)
            finally:
                drain_sentinel.cancel()

            if gather_task.cancelled():
                yield _sse({"error": "Research was cancelled."})
                return
            gather_exc = gather_task.exception()
            if gather_exc is not None:
                logger.error("Research gather failed", exc_info=gather_exc)
                yield _sse({"error": str(gather_exc)})
                return
            research_evidence = gather_task.result()
            evidence = research_evidence.evidence

            # ------------------------------------------------------------------
            # Step 4: Synthesize (streaming)
            # ------------------------------------------------------------------
            yield _sse({"event": "research_synth_start"})

            all_sources = [item for angle in evidence for item in angle["items"]]
            source_count = len(all_sources)
            evidence_doc = _build_evidence_doc(evidence)

            if is_refine:
                synth_system = _REFINE_SYNTHESIS_SYSTEM
                synth_user = _REFINE_SYNTHESIS_USER.format(
                    query=query,
                    refinement=refinement,
                    prior_report=(prior_report or "")[:_MAX_EVIDENCE_CHARS],
                    source_count=source_count,
                    angle_count=len(evidence),
                    evidence_doc=evidence_doc,
                )
            else:
                synth_system = _SYNTHESIS_SYSTEM
                synth_user = _SYNTHESIS_USER.format(
                    query=query,
                    source_count=source_count,
                    angle_count=len(evidence),
                    evidence_doc=evidence_doc,
                )

            report_chunks: list[str] = []
            cost_usd = 0.0
            prompt_tokens = 0
            completion_tokens = 0

            async for event in model_router.stream_chat_events(
                provider=provider,
                model_id=model_id,
                messages=[ChatMessage(role="user", content=synth_user)],
                system=synth_system,
                temperature=0.3,
                max_tokens=_SYNTHESIS_MAX_TOKENS,
                include_usage=True,
            ):
                if isinstance(event, TextDelta):
                    report_chunks.append(event.text)
                    yield _sse({"delta": event.text})
                elif isinstance(event, UsageEvent):
                    prompt_tokens = event.prompt_tokens or 0
                    completion_tokens = event.completion_tokens or 0
                    cost_usd = event.cost_usd or 0.0

            report_content = "".join(report_chunks)

            # ------------------------------------------------------------------
            # Step 5: Generate PDF attachment
            # Must happen before message persistence because persist_generated_file
            # commits its own transaction; we read conv.active_leaf_message_id
            # now so we don't need to re-read it from an expired session object.
            # ------------------------------------------------------------------
            prev_leaf_id = conv.active_leaf_message_id

            report_slug = re.sub(r"[^a-z0-9]+", "-", query.lower())[:40].strip("-")
            pdf_filename = f"research-{report_slug}.pdf"
            md_filename = f"research-{report_slug}.md"

            # Build a sources section for the PDF using the structured evidence.
            sources_section_lines = [
                f"[{s['index']}] **{s['title']}** — {s['url']}"
                for s in all_sources
            ]
            pdf_markdown = (
                report_content
                + "\n\n## Sources\n\n"
                + "\n\n".join(sources_section_lines)
            )

            attachment_snaps: list[dict] = []
            try:
                md_row = await persist_generated_file(
                    db,
                    user=user,
                    filename=md_filename,
                    mime_type="text/markdown",
                    content=pdf_markdown.encode("utf-8"),
                    source_kind=GeneratedKind.MARKDOWN_SOURCE.value,
                )
                pdf_bytes = await asyncio.to_thread(
                    render_markdown_to_pdf, pdf_markdown, query
                )
                pdf_row = await persist_generated_file(
                    db,
                    user=user,
                    filename=pdf_filename,
                    mime_type="application/pdf",
                    content=pdf_bytes,
                    source_kind=GeneratedKind.RENDERED_PDF.value,
                    source_file_id=md_row.id,
                )
                # Attach BOTH the PDF (polished, printable) and the Markdown
                # (copy-paste / editable / shareable via the Files share-link).
                # Non-PDF output is the E4 ask — the .md was always generated
                # but previously only the PDF chip was surfaced.
                attachment_snaps = [
                    {
                        "id": str(pdf_row.id),
                        "filename": pdf_row.filename,
                        "mime_type": "application/pdf",
                        "size_bytes": pdf_row.size_bytes,
                        "source_kind": pdf_row.source_kind,
                        "source_file_id": str(pdf_row.source_file_id),
                    },
                    {
                        "id": str(md_row.id),
                        "filename": md_row.filename,
                        "mime_type": "text/markdown",
                        "size_bytes": md_row.size_bytes,
                        "source_kind": md_row.source_kind,
                        "source_file_id": None,
                    },
                ]
                logger.info(
                    "Research PDF generated pdf_id=%s bytes=%d",
                    pdf_row.id,
                    pdf_row.size_bytes,
                )
            except Exception:
                logger.warning("Research PDF generation skipped", exc_info=True)
                attachment_snaps = []

            # ------------------------------------------------------------------
            # Step 6: Persist messages
            # ------------------------------------------------------------------
            full_content = report_content

            user_label = (
                f"\U0001f52c **Deep Research — dig deeper:** {refinement}"
                if is_refine
                else f"\U0001f52c **Deep Research:** {query}"
            )
            user_msg = Message(
                conversation_id=conv.id,
                role="user",
                content=user_label,
                parent_id=prev_leaf_id,
                author_user_id=user.id,
            )
            db.add(user_msg)
            await db.flush()
            conv.active_leaf_message_id = user_msg.id

            sources_list = [
                {
                    "title": s["title"],
                    "url": s["url"],
                    "snippet": (s["content"] or "")[:200],
                }
                for s in all_sources
            ]
            asst_msg = Message(
                conversation_id=conv.id,
                role="assistant",
                content=full_content,
                parent_id=user_msg.id,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                # cost is stored as integer micros (1 = $0.000001)
                cost_usd_micros=int(cost_usd * 1_000_000) if cost_usd else None,
                sources=sources_list,
                attachments=attachment_snaps if attachment_snaps else None,
            )
            db.add(asst_msg)
            await db.flush()
            conv.active_leaf_message_id = asst_msg.id
            conv.updated_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(user_msg)
            await db.refresh(asst_msg)

            user_msg_data = MessageResponse.model_validate(user_msg).model_dump(mode="json")
            asst_msg_data = MessageResponse.model_validate(asst_msg).model_dump(mode="json")

            yield _sse({
                "event": "research_done",
                "user_message": user_msg_data,
                "assistant_message": asst_msg_data,
                "cost_usd": round(cost_usd, 5),
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "source_count": source_count,
            })

        except Exception as exc:
            logger.exception("Research engine error: %s", exc)
            yield _sse({"error": str(exc)})

    return _gen()
