"""Independent assessor pass for the Study module.

After the tutor scores an objective via ``update_objective_mastery``,
:func:`dispatch_assessor_if_configured` fires a background task that:

1. Pulls the student's last answer from the session.
2. Calls the admin-configured assessor model with a short grading
   prompt.
3. Parses the binary correct/incorrect verdict from the response.
4. Overwrites ``correct`` and sets ``source_kind='assessor'`` on the
   ``study_retrieval_attempts`` row the tutor handler created.
5. Re-derives mastery from the updated attempt history and updates
   the ``study_objective_mastery`` row + SM-2 schedule.

This module is intentionally thin: all DB helpers live in
``study.review`` / ``study.models``; provider routing lives in
``models_config.provider``. We only wire them together.

The task is fire-and-forget: the student's SSE stream has already
finished by the time this runs. Errors are logged but never re-raised
so the background loop can't crash the server.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.app_settings.models import AppSettings, SINGLETON_APP_SETTINGS_ID
from app.database import SessionLocal
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.study import review as study_review
from app.study.models import (
    StudyMessage,
    StudyObjectiveMastery,
    StudyRetrievalAttempt,
    StudyUnit,
)

logger = logging.getLogger("promptly.study.assessor")

_ASSESSOR_SYSTEM = """\
You are an objective grader for a spaced-repetition learning system.
Given a learning objective and a student's answer, decide if the answer
demonstrates genuine understanding of that objective.

Respond with ONLY a JSON object on a single line — no prose, no markdown:
{"correct": true, "confidence": 0-100}

- "correct": true if the student's answer shows clear understanding,
  false if it contains a significant misconception, major gap, or is
  off-topic.
- "confidence": 0-100 reflecting how certain you are in that verdict
  (use lower values when the answer is ambiguous or partial).

Do NOT add explanation outside the JSON."""

_JSON_RE = re.compile(r'\{[^{}]*"correct"\s*:\s*(true|false)[^{}]*\}', re.DOTALL)


async def _call_assessor(
    provider: ModelProvider,
    model_id: str,
    objective_text: str,
    student_answer: str,
) -> tuple[bool, int] | None:
    """Call the assessor model and return ``(correct, confidence)``.

    Returns ``None`` if the model response couldn't be parsed — callers
    should treat this as "no assessor verdict available".
    """
    user_content = (
        f"Learning objective: {objective_text}\n\n"
        f"Student's answer: {student_answer}"
    )
    full_response: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=user_content)],
            system=_ASSESSOR_SYSTEM,
            temperature=0.0,
            max_tokens=64,
            reasoning_effort="off",
        ):
            full_response.append(token)
    except ProviderError as exc:
        logger.warning("assessor provider call failed: %s", exc)
        return None
    except Exception:
        logger.exception("assessor unexpected error during stream")
        return None

    raw = "".join(full_response).strip()
    m = _JSON_RE.search(raw)
    if not m:
        logger.warning("assessor response not parseable: %.120s", raw)
        return None
    try:
        parsed = json.loads(m.group(0))
        correct = bool(parsed.get("correct"))
        confidence = int(parsed.get("confidence", 70))
        return correct, max(0, min(100, confidence))
    except Exception:
        logger.warning("assessor json parse failed: %.120s", raw)
        return None


async def _run_assessor_task(
    *,
    attempt_id: uuid.UUID,
    session_id: uuid.UUID,
    unit_id: uuid.UUID,
    objective_index: int,
    objective_text: str,
) -> None:
    """Background task body — owns its own DB session."""
    try:
        async with SessionLocal() as db:
            # --- Load assessor model config ---
            settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
            if settings is None or not settings.study_assessor_configured:
                return

            provider = await db.get(ModelProvider, settings.study_assessor_provider_id)
            if provider is None or not provider.enabled:
                return
            model_id = settings.study_assessor_model_id

            # --- Get last student answer (up to 3 turns for context) ---
            msgs_stmt = (
                select(StudyMessage)
                .where(StudyMessage.session_id == session_id)
                .where(StudyMessage.role == "user")
                .order_by(StudyMessage.created_at.desc())
                .limit(3)
            )
            user_msgs = list((await db.execute(msgs_stmt)).scalars().all())
            if not user_msgs:
                return
            # Concatenate in chronological order (reversed) for context.
            student_answer = "\n\n".join(
                m.content for m in reversed(user_msgs) if m.content.strip()
            )

            # --- Call assessor model ---
            result = await _call_assessor(
                provider, model_id, objective_text, student_answer
            )
            if result is None:
                return
            correct, confidence = result

            # --- Update attempt row ---
            attempt = await db.get(StudyRetrievalAttempt, attempt_id)
            if attempt is None:
                return
            attempt.correct = correct
            attempt.confidence = confidence
            attempt.source_kind = "assessor"

            # --- Re-derive mastery from updated attempts ---
            recent = await study_review.recent_attempts_for_objective(
                db, unit_id, objective_index
            )
            derived_score, derived_success = study_review.derive_mastery_from_attempts(
                recent, fallback_score=attempt.tutor_score or 0
            )

            # --- Update mastery row + SM-2 ---
            mastery_stmt = select(StudyObjectiveMastery).where(
                StudyObjectiveMastery.unit_id == unit_id,
                StudyObjectiveMastery.objective_index == objective_index,
            )
            mastery_row = (await db.execute(mastery_stmt)).scalar_one_or_none()
            if mastery_row is not None:
                study_review.schedule_next_review(
                    mastery_row, success=derived_success, score=derived_score
                )

                # Re-average the unit-level mastery score.
                unit = await db.get(StudyUnit, unit_id)
                if unit is not None:
                    all_rows_stmt = select(StudyObjectiveMastery).where(
                        StudyObjectiveMastery.unit_id == unit_id
                    )
                    all_rows = list(
                        (await db.execute(all_rows_stmt)).scalars().all()
                    )
                    if all_rows:
                        avg = int(
                            round(
                                sum(r.mastery_score for r in all_rows) / len(all_rows)
                            )
                        )
                        if unit.status != "completed":
                            unit.mastery_score = avg

            await db.commit()
            logger.debug(
                "assessor pass complete: obj=%d correct=%s score=%d",
                objective_index,
                correct,
                derived_score,
            )
    except Exception:
        logger.exception(
            "assessor background task failed (session=%s obj=%d)",
            session_id,
            objective_index,
        )


def dispatch_assessor_if_configured(
    *,
    attempt_id: uuid.UUID,
    session_id: uuid.UUID,
    unit_id: uuid.UUID,
    objective_index: int,
    objective_text: str,
) -> None:
    """Schedule the assessor pass as a fire-and-forget asyncio task.

    Called from the SSE generator after the main DB commit so the
    student's answer is guaranteed to be visible to the new session the
    assessor task opens.  Returns immediately; the caller does NOT
    await the result.
    """
    asyncio.create_task(
        _run_assessor_task(
            attempt_id=attempt_id,
            session_id=session_id,
            unit_id=unit_id,
            objective_index=objective_index,
            objective_text=objective_text,
        ),
        name=f"assessor-{attempt_id}",
    )


# ---- Standalone review-loop grader ----------------------------------

_TEACHBACK_SYSTEM = """\
You are evaluating a student's teach-back explanation in a spaced-repetition
learning system.

The student was asked to explain the unit's key concepts as if teaching someone
new. Assess whether their explanation:
1. Covers the core mechanism correctly — not just the surface description
2. Avoids significant misconceptions
3. Can articulate the "why", not just the "what"

Respond with ONLY a JSON object on a single line — no prose, no markdown:
{"passed": true, "confidence": 0-100}

- "passed": true only if the explanation is genuinely adequate.
  Be strict — vague, incomplete, or mostly-correct-but-wrong-on-key-point
  explanations should fail. The student can try again.
- "confidence": 0-100 reflecting your certainty.

Do NOT add anything outside the JSON."""

_TEACHBACK_JSON_RE = re.compile(
    r'\{[^{}]*"passed"\s*:\s*(true|false)[^{}]*\}', re.DOTALL
)


async def grade_teachback(
    db: AsyncSession,
    unit: "StudyUnit",
    student_messages: list[str],
) -> bool | None:
    """Grade a student's teach-back explanation against the unit's objectives.

    Returns ``True`` (passed), ``False`` (rejected), or ``None`` when the
    assessor is not configured or a call error occurs — callers should treat
    ``None`` as "pass-through" and not gate on it.
    """
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None or not settings.study_assessor_configured:
        return None

    provider = await db.get(ModelProvider, settings.study_assessor_provider_id)
    if provider is None or not provider.enabled:
        return None
    model_id: str = settings.study_assessor_model_id

    objectives_text = "\n".join(
        f"- {obj}" for obj in (unit.learning_objectives or [])
    )
    explanation = "\n\n".join(student_messages[-3:]) if student_messages else "(no answer provided)"

    user_content = (
        f"Unit: {unit.title}\n\n"
        f"Learning objectives:\n{objectives_text}\n\n"
        f"Student's teach-back explanation:\n{explanation}"
    )
    full_response: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=user_content)],
            system=_TEACHBACK_SYSTEM,
            temperature=0.0,
            max_tokens=64,
            reasoning_effort="off",
        ):
            full_response.append(token)
    except ProviderError as exc:
        logger.warning("teachback grader provider call failed: %s", exc)
        return None
    except Exception:
        logger.exception("teachback grader unexpected error")
        return None

    raw = "".join(full_response).strip()
    m = _TEACHBACK_JSON_RE.search(raw)
    if not m:
        logger.warning("teachback grader response not parseable: %.120s", raw)
        return None
    try:
        parsed = json.loads(m.group(0))
        return bool(parsed.get("passed"))
    except Exception:
        logger.warning("teachback grader json parse failed: %.120s", raw)
        return None


_REVIEW_GRADE_SYSTEM = """\
You are a grader for a spaced-repetition learning system.
Given a learning objective and a student's free-recall answer, decide
whether the student demonstrates genuine understanding.

Respond with ONLY a JSON object on a single line — no prose, no markdown:
{"correct": true, "feedback": "one sentence"}

- "correct": true if the answer shows clear understanding; false if it
  has a significant misconception, major gap, or is off-topic.
- "feedback": ONE sentence. If correct, affirm what they got right with
  a brief reinforcing note. If incorrect, pinpoint the gap without
  revealing the full answer — give a useful nudge toward the right idea.

Do NOT add anything outside the JSON."""

_REVIEW_JSON_RE = re.compile(
    r'\{[^{}]*"correct"\s*:\s*(true|false)[^{}]*\}', re.DOTALL
)


async def grade_for_review(
    db: AsyncSession,
    objective_text: str,
    student_answer: str,
) -> tuple[bool, str] | None:
    """Grade a free-recall answer for the standalone daily review loop.

    Returns ``(correct, feedback_sentence)`` or ``None`` if the assessor
    model is not configured — callers should fall back to self-grading.
    """
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None or not settings.study_assessor_configured:
        return None

    provider = await db.get(ModelProvider, settings.study_assessor_provider_id)
    if provider is None or not provider.enabled:
        return None
    model_id: str = settings.study_assessor_model_id

    user_content = (
        f"Learning objective: {objective_text}\n\n"
        f"Student's answer: {student_answer}"
    )
    full_response: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=user_content)],
            system=_REVIEW_GRADE_SYSTEM,
            temperature=0.0,
            max_tokens=128,
            reasoning_effort="off",
        ):
            full_response.append(token)
    except ProviderError as exc:
        logger.warning("review grader provider call failed: %s", exc)
        return None
    except Exception:
        logger.exception("review grader unexpected error")
        return None

    raw = "".join(full_response).strip()
    m = _REVIEW_JSON_RE.search(raw)
    if not m:
        logger.warning("review grader response not parseable: %.120s", raw)
        return None
    try:
        parsed = json.loads(m.group(0))
        correct = bool(parsed.get("correct"))
        feedback = str(parsed.get("feedback", "")).strip()
        return correct, feedback
    except Exception:
        logger.warning("review grader json parse failed: %.120s", raw)
        return None
