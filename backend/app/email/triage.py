"""AI triage pipeline for incoming emails (Phase 12 — E.1).

Two-stage approach (cost-aware):
  1. Heuristic pre-filter — free, handles the obvious bulk (newsletters,
     promotional) without touching the model.
  2. Batched LLM pass — 10-20 messages per call using the admin-configured
     triage model (defaults to local/Ollama). Produces category, priority,
     summary, needs_reply, and a parsed due_at.

The pipeline runs asynchronously and never blocks the sync loop — triage
happens in a separate pass after messages are mirrored.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.email.models import EmailMessage

logger = logging.getLogger("promptly.email.triage")

# Batch size for LLM triage calls
_BATCH_SIZE = 15
# Max messages triaged per scheduler tick
_MAX_TRIAGE_PER_TICK = 60

# ------------------------------------------------------------------ #
# Heuristic pre-filter                                                 #
# ------------------------------------------------------------------ #

_BULK_HEADERS = re.compile(
    r"^list-unsubscribe|^list-id|^precedence:\s*(bulk|list|junk)",
    re.IGNORECASE | re.MULTILINE,
)

_PROMO_SENDERS = re.compile(
    r"@(noreply|no-reply|mailer|newsletter|notifications|updates|info|"
    r"donotreply|marketing|promo|offers)\.",
    re.IGNORECASE,
)

_PROMOTIONAL_SUBJECTS = re.compile(
    r"\b(unsubscribe|deal|offer|discount|sale|coupon|off|free shipping|"
    r"limited time|exclusive|save \d+|% off)\b",
    re.IGNORECASE,
)


def _heuristic_category(msg: EmailMessage) -> str | None:
    """Return a triage_skipped_reason if the message can be categorised cheaply.

    Returns None when the message needs the LLM pass.
    """
    from_addr = (msg.from_address or "").lower()
    subject = (msg.subject or "").lower()

    # Newsletters / bulk mail detected via standard headers (stored in provider_labels
    # or, once we store raw headers, in a headers field — for now we infer from labels)
    labels = [l.upper() for l in (msg.provider_labels or [])]
    if "CATEGORY_PROMOTIONS" in labels or "CATEGORY_UPDATES" in labels:
        return "promotional"
    if "CATEGORY_SOCIAL" in labels:
        return "social"
    if "CATEGORY_FORUMS" in labels:
        return "newsletter"

    if _PROMO_SENDERS.search(from_addr):
        return "promotional"

    if _PROMOTIONAL_SUBJECTS.search(subject):
        return "promotional"

    return None


# ------------------------------------------------------------------ #
# LLM triage                                                           #
# ------------------------------------------------------------------ #

_TRIAGE_SYSTEM_PROMPT = """You are an email triage assistant. For each email given, produce a JSON object.

Categories: action_required | fyi | newsletter | promotional | social | spam

Return a JSON array, one object per email, in the same order as the input:
[
  {
    "email_index": 0,
    "category": "action_required",
    "priority": 8,
    "summary": "Client asking for invoice by Friday",
    "needs_reply": true,
    "due_at": "2026-06-05"
  }
]

Rules:
- category: pick the single best fit
- priority: 0 (lowest) to 10 (most urgent). Deadlines, VIP senders, financial matters = 8-10
- summary: max 2 sentences, plain text, no formatting
- needs_reply: true only when the sender explicitly expects or clearly needs a response
- due_at: ISO 8601 date if a deadline is clearly stated; null otherwise
- Return ONLY valid JSON, no prose."""


def _format_email_for_triage(idx: int, msg: EmailMessage) -> str:
    body = (msg.body_text or msg.snippet or "")[:800]
    return (
        f"[{idx}] From: {msg.from_name or ''} <{msg.from_address or ''}>\n"
        f"Subject: {msg.subject or '(no subject)'}\n"
        f"Date: {msg.date.isoformat() if msg.date else 'unknown'}\n"
        f"Body:\n{body}"
    )


async def _run_llm_triage(
    msgs: list[EmailMessage],
    provider,
    model_id: str,
) -> list[dict[str, Any]]:
    """Call the triage model with a batch of messages. Returns parsed JSON array."""
    from app.models_config.provider import ChatMessage, TextDelta, model_router

    user_content = "\n\n---\n\n".join(
        _format_email_for_triage(i, m) for i, m in enumerate(msgs)
    )

    chunks: list[str] = []
    async for event in model_router.stream_chat_events(
        provider=provider,
        model_id=model_id,
        messages=[ChatMessage(role="user", content=user_content)],
        system=_TRIAGE_SYSTEM_PROMPT,
        temperature=0.1,
        max_tokens=2000,
    ):
        if isinstance(event, TextDelta):
            chunks.append(event.text)

    raw = "".join(chunks).strip()
    # Strip markdown code fences if the model wrapped the JSON
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.DOTALL)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Triage LLM returned invalid JSON: %s", raw[:200])
        return []


def _parse_due_at(due_str: str | None) -> datetime | None:
    if not due_str:
        return None
    try:
        dt = datetime.fromisoformat(due_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


# ------------------------------------------------------------------ #
# Main triage entry point                                              #
# ------------------------------------------------------------------ #

async def triage_pending(db: AsyncSession) -> int:
    """Triage untriaged messages for all users. Returns count processed."""
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None or not settings.email_integration_enabled:
        return 0

    # Find untriaged messages (no triaged_at and no skip reason)
    pending = (
        await db.execute(
            select(EmailMessage)
            .where(
                EmailMessage.triaged_at.is_(None),
                EmailMessage.triage_skipped_reason.is_(None),
            )
            .order_by(EmailMessage.date.desc())
            .limit(_MAX_TRIAGE_PER_TICK)
        )
    ).scalars().all()

    if not pending:
        return 0

    now = datetime.now(timezone.utc)
    llm_batch: list[EmailMessage] = []
    processed = 0

    for msg in pending:
        heuristic = _heuristic_category(msg)
        if heuristic:
            # Fast path: categorise without LLM
            msg.ai_category = heuristic
            msg.ai_priority = 1  # bulk is low priority
            msg.triaged_at = now
            msg.triage_skipped_reason = "bulk_heuristic"
            processed += 1
        else:
            llm_batch.append(msg)

    # LLM batch — only if triage model is configured
    if llm_batch and settings.email_triage_provider_id and settings.email_triage_model_id:
        from app.models_config.models import ModelProvider
        provider = await db.get(ModelProvider, settings.email_triage_provider_id)
        if provider:
            for i in range(0, len(llm_batch), _BATCH_SIZE):
                batch = llm_batch[i : i + _BATCH_SIZE]
                try:
                    results = await _run_llm_triage(
                        batch, provider, settings.email_triage_model_id
                    )
                    for entry in results:
                        idx = entry.get("email_index", -1)
                        if not isinstance(idx, int) or idx < 0 or idx >= len(batch):
                            continue
                        msg = batch[idx]
                        msg.ai_category = entry.get("category") or "fyi"
                        msg.ai_priority = int(entry.get("priority") or 5)
                        msg.ai_summary = (entry.get("summary") or "")[:500] or None
                        msg.needs_reply = bool(entry.get("needs_reply"))
                        msg.due_at = _parse_due_at(entry.get("due_at"))
                        msg.triaged_at = now
                        processed += 1
                except Exception:
                    logger.exception("LLM triage batch failed")
                    # Mark skipped so they don't re-queue endlessly
                    for msg in batch:
                        if not msg.triaged_at:
                            msg.triage_skipped_reason = "triage_error"
        else:
            # No provider found — skip with reason
            for msg in llm_batch:
                msg.triage_skipped_reason = "no_triage_model"
    elif llm_batch:
        # Model not configured
        for msg in llm_batch:
            msg.triage_skipped_reason = "triage_disabled"
        processed += len(llm_batch)

    await db.commit()
    return processed
