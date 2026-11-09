"""Marking answers again when a quiz's key changes (WP-F2.3).

Saving the definition with different points or answer keys — or turning a
form into a quiz after answers came in — queues ``forms_regrade_job`` (arq,
stable job id ``forms-regrade:<form_id>``; inline when the queue is down).
It walks the answers in batches of 500, each under the form's row lock
(the same lock submits take, so an answer can't be marked twice at once),
re-marks the automatic parts and keeps the owner's own marks (the answers
didn't change, so ``quiz.mark`` keeps them). Each changed answer takes a
new ``seq`` so the linked Sheet's Score column follows. If the key changes
again while it runs, it goes round again.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text

from app.forms.models import Form, FormResponse

logger = logging.getLogger("promptly.forms")

JOB = "forms_regrade_job"
BATCH = 500


def needs_regrade(old_defn: dict[str, Any] | None, new_defn: dict[str, Any]) -> bool:
    from app.forms.quiz import key_signature

    return key_signature(old_defn or {}) != key_signature(new_defn or {})


async def _signature(form_id: uuid.UUID) -> tuple[str | None, bool]:
    from app.database import SessionLocal
    from app.forms.quiz import key_signature

    async with SessionLocal() as db:
        form = await db.get(Form, form_id)
        if form is None or form.quiz is None:
            return None, False
        return key_signature(form.definition or {}), form.sheet_tab_id is not None


async def regrade_form(form_id: uuid.UUID) -> int:
    """Mark every answer of a quiz again. Returns how many changed."""
    from app.database import SessionLocal
    from app.forms import quiz

    changed = 0
    for _round in range(5):
        sig, linked = await _signature(form_id)
        if sig is None:
            return changed
        last = 0
        while True:
            async with SessionLocal() as db:
                form = (
                    await db.execute(select(Form).where(Form.id == form_id).with_for_update())
                ).scalar_one_or_none()
                if form is None or form.quiz is None:
                    return changed
                defn = form.definition or {}
                release_now = (form.quiz or {}).get("release", "now") == "now"
                rows = (
                    await db.execute(
                        select(FormResponse)
                        .where(FormResponse.form_id == form_id, FormResponse.deleted_at.is_(None), FormResponse.number > last)
                        .order_by(FormResponse.number)
                        .limit(BATCH)
                    )
                ).scalars().all()
                now = datetime.now(timezone.utc)
                for r in rows:
                    answers = r.answers or {}
                    new = quiz.mark(defn, answers, r.grading, answers)
                    touched = False
                    if new != r.grading:
                        r.grading = new
                        r.score = quiz.score_of(new)
                        touched = True
                    if release_now and r.released_at is None:
                        # "Straight after sending": a quiz turned on later
                        # releases what's already in.
                        r.released_at = now
                    if touched:
                        r.seq = (await db.execute(text("SELECT nextval('form_response_seq')"))).scalar_one()
                        changed += 1
                await db.commit()
                if not rows or len(rows) < BATCH:
                    break
                last = rows[-1].number
        again, linked = await _signature(form_id)
        if again == sig:
            break
    if linked and changed:
        from app.forms.sheet import enqueue_sync

        await enqueue_sync(form_id)
    return changed


async def enqueue(form_id: uuid.UUID) -> None:
    """Queue a regrade on the worker (one per form at a time); run it here
    when the queue is down."""
    try:
        from app.tasks.queue import get_pool

        pool = await get_pool()
        await pool.enqueue_job(JOB, str(form_id), _job_id=f"forms-regrade:{form_id}")
        return
    except Exception:  # noqa: BLE001 — never let queueing break a save
        logger.warning("forms regrade: queue unavailable, running here", exc_info=True)
    from app.background import spawn

    spawn(_safe(form_id), name=f"forms-regrade-{form_id}")


async def _safe(form_id: uuid.UUID) -> None:
    try:
        await regrade_form(form_id)
    except Exception:  # noqa: BLE001
        logger.exception("forms regrade failed for %s", form_id)


def regrade_soon(form: Form) -> None:
    """After a commit that changed what marking depends on."""
    if form.quiz is None:
        return
    from app.background import spawn

    spawn(enqueue(form.id), name=f"forms-regrade-q-{form.id}")


__all__ = ["BATCH", "JOB", "enqueue", "needs_regrade", "regrade_form", "regrade_soon"]
