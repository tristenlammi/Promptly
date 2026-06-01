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
from typing import Any, AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Conversation, Message
from app.chat.pdf_render import PdfRenderError, render_markdown_to_pdf
from app.chat.schemas import MessageResponse
from app.chat.tools.base import ToolContext
from app.chat.tools.fetch_url import FetchUrlTool
from app.files.generated import GeneratedFileError, persist_generated_file
from app.files.generated_kinds import GeneratedKind
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, TextDelta, UsageEvent, model_router
from app.search.providers import run_search
from app.search.service import pick_search_provider

logger = logging.getLogger("promptly.research")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_NUM_SUBQUESTIONS = 5
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
) -> AsyncGenerator[str, None]:
    """Async generator that yields SSE strings for the research stream."""

    async def _gen() -> AsyncGenerator[str, None]:  # noqa: C901 (complexity OK here)
        try:
            # ------------------------------------------------------------------
            # Step 1: Decompose
            # ------------------------------------------------------------------
            yield _sse({"event": "research_start", "query": query})
            subquestions = await _decompose(query, provider, model_id)
            yield _sse({
                "event": "research_decomposed",
                "subquestions": [
                    {"question": sq["question"], "search_query": sq["search_query"]}
                    for sq in subquestions
                ],
            })

            # ------------------------------------------------------------------
            # Step 2: Search + Read
            # ------------------------------------------------------------------
            search_provider = await pick_search_provider(db, user)

            # Reuse a single fake ToolContext (fetch_url doesn't hit the DB, but
            # the signature requires it; web_search picks the provider via db+user).
            placeholder_msg_id = uuid.uuid4()
            tool_ctx = ToolContext(
                db=db,
                user=user,
                conversation_id=conv.id,
                user_message_id=placeholder_msg_id,
            )
            fetch_tool = FetchUrlTool()

            evidence: list[dict[str, Any]] = []
            source_index = 1
            all_seen_urls: set[str] = set()

            for idx, sq in enumerate(subquestions):
                yield _sse({
                    "event": "research_searching",
                    "index": idx,
                    "question": sq["question"],
                })

                try:
                    if search_provider is not None:
                        results = await run_search(
                            search_provider,
                            sq["search_query"],
                            count=_SEARCH_RESULTS_PER_SQ,
                        )
                    else:
                        results = []
                except Exception:
                    results = []

                yield _sse({
                    "event": "research_searched",
                    "index": idx,
                    "sources_found": len(results),
                })

                sq_items: list[dict[str, Any]] = []
                reads = 0

                for result in results[:_SEARCH_RESULTS_PER_SQ]:
                    url = (result.url or "").strip()
                    if not url:
                        continue

                    already_seen = url in all_seen_urls
                    can_read = reads < _READS_PER_SQ and not already_seen and url.startswith("http")

                    if can_read:
                        all_seen_urls.add(url)
                        yield _sse({
                            "event": "research_reading",
                            "index": idx,
                            "url": url,
                        })
                        try:
                            fetch_result = await fetch_tool.run(tool_ctx, {"url": url})
                            content = fetch_result.content[:_MAX_CONTENT_CHARS]
                            sq_items.append({
                                "index": source_index,
                                "title": result.title or url,
                                "url": url,
                                "content": content,
                                "is_full": True,
                            })
                            reads += 1
                        except Exception:
                            # Fall back to snippet
                            sq_items.append({
                                "index": source_index,
                                "title": result.title or url,
                                "url": url,
                                "content": (result.snippet or "")[:_MAX_SNIPPET_CHARS],
                                "is_full": False,
                            })
                    else:
                        sq_items.append({
                            "index": source_index,
                            "title": result.title or url,
                            "url": url,
                            "content": (result.snippet or "")[:_MAX_SNIPPET_CHARS],
                            "is_full": False,
                        })

                    source_index += 1
                    if len(sq_items) >= _READS_PER_SQ + 2:
                        # Keep a reasonable number of sources per angle
                        break

                evidence.append({
                    "subquestion": sq["question"],
                    "items": sq_items,
                })
                yield _sse({"event": "research_question_done", "index": idx})

            # ------------------------------------------------------------------
            # Step 3: Gap check + follow-up searches
            # ------------------------------------------------------------------
            yield _sse({"event": "research_gap_start"})
            gap_queries = await _gap_check(query, evidence, provider, model_id)
            extra_sources = 0

            for gap in gap_queries[:2]:
                try:
                    if search_provider is not None:
                        gap_results = await run_search(
                            search_provider, gap["search_query"], count=4
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

            yield _sse({"event": "research_gap_done", "extra_sources": extra_sources})

            # ------------------------------------------------------------------
            # Step 4: Synthesize (streaming)
            # ------------------------------------------------------------------
            yield _sse({"event": "research_synth_start"})

            all_sources = [item for angle in evidence for item in angle["items"]]
            source_count = len(all_sources)
            evidence_doc = _build_evidence_doc(evidence)

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
                system=_SYNTHESIS_SYSTEM,
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
                attachment_snaps = [
                    {
                        "id": str(pdf_row.id),
                        "filename": pdf_row.filename,
                        "mime_type": "application/pdf",
                        "size_bytes": pdf_row.size_bytes,
                        "source_kind": pdf_row.source_kind,
                        "source_file_id": str(pdf_row.source_file_id),
                    }
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

            user_msg = Message(
                conversation_id=conv.id,
                role="user",
                content=f"\U0001f52c **Deep Research:** {query}",
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
