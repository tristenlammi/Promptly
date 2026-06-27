"""Study API — topics (projects), units, exams, sessions, streaming chat.

The Study module is a structured learning path:

1. The student creates a topic by describing what they want to learn +
   the goal. An AI planner turns the brief into 5–20 ordered units
   with learning objectives.
2. The student opens a unit — that creates (or returns) a tutor
   ``StudySession`` bound to the unit. The tutor assesses, teaches,
   and emits a ``<unit_action>`` when it's confident the unit has
   been mastered.
3. Once every unit is ``completed`` the final exam unlocks. The exam
   runs as its own ``exam`` session with a server-enforced timer; the
   AI examiner emits an ``<exam_action>`` at the end to grade it. A
   failed exam re-opens the weak units with extra context; a passed
   exam transitions the project to ``completed`` (and the student
   can archive it from the UI).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import AppSettings, SINGLETON_APP_SETTINGS_ID
from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.database import SessionLocal, get_db
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.study import config as study_config
from app.study import review as study_review
from app.study.config import min_turns_required as study_min_turns_required
from app.files.models import UserFile
from app.study.models import (
    StudyExam,
    StudyMaterial,
    StudyMessage,
    StudyMisconception,
    StudyObjectiveMastery,
    StudyProject,
    StudyRetrievalAttempt,
    StudySession,
    StudyUnit,
    StudyUnitReflection,
    WhiteboardExercise,
)
from app.study.frame_auth import (
    inject_submit_shim,
    sign_exercise_frame_token,
    verify_exercise_frame_token,
)
from app.study.parser import TaggedActionParser
from app.study.planner import (
    PlanGenerationError,
    generate_and_apply_plan,
)
from app.study.materials import (
    extract_material_text_for_planning,
    index_material_for_study_project,
    retrieve_for_study_session,
)
from app.study.schemas import (
    CalibrationDataPoint,
    CalibrationHistoryResponse,
    CompletionReadinessObjective,
    CompletionReadinessResponse,
    ConfidenceCaptureRequest,
    ConfidenceCaptureResponse,
    LearnerProfile,
    LearnerProfileResponse,
    LearnerProfileUpdate,
    MisconceptionEntry,
    MisconceptionListResponse,
    ObjectiveMasteryEntry,
    ObjectiveMasteryListResponse,
    QuickReviewRequest,
    QuickReviewResponse,
    ReviewQueueItem,
    ReviewQueueResponse,
    StudyExamStartRequest,
    StudyExamStartResponse,
    StudyExamSummary,
    StudyMessageResponse,
    StudyProjectCreate,
    StudyProjectDetail,
    StudyProjectRegeneratePlan,
    StudyProjectSummary,
    StudyProjectUpdate,
    StudySendMessageRequest,
    StudySendMessageResponse,
    StudySessionDetail,
    StudySessionSummary,
    StudyUnitSummary,
    UnitEnterResponse,
    NotesState,
    NotesUpdate,
    AssessorStatusResponse,
    SessionArcObjective,
    SessionArcResponse,
    SessionGoalUpdate,
    SessionTimelineEntry,
    StudyBoardBlockResponse,
    WhiteboardExerciseDetail,
    WhiteboardExerciseSummary,
    WhiteboardSubmitRequest,
    WhiteboardSubmitResponse,
    StudyMaterialAttach,
    StudyMaterialResponse,
)
from app.study.assessor import dispatch_assessor_if_configured, grade_for_review
from app.study.orchestrator import advance_phase
from app.study.service import (
    StudyStreamContext,
    apply_captures,
    build_exam_system_prompt,
    build_history_for_llm,
    build_legacy_system_prompt,
    build_unit_system_prompt,
    consume_stream,
    enqueue_stream,
    evaluate_completion_gate,
    format_submission_user_message,
    parse_action_payload,
    parse_whiteboard_payload,
)
from app.study.staleness import (
    apply_staleness_to_project,
    days_since_studied,
)

logger = logging.getLogger("promptly.study")
router = APIRouter()

EXAM_DEFAULT_TIME_LIMIT_SECONDS = 1200  # 20 minutes


# Phrases the system prompt forbids in chat text on a turn that emits
# ``mark_complete``. Used by the leak detector below to flag rejected
# turns where the model wrote celebratory / next-unit language anyway,
# leaving the student staring at "On to Unit 2!" while the unit
# silently stays open. The pattern is deliberately broad — false
# positives here are harmless (the worst case is a slightly more
# emphatic internal nudge to the model) while false negatives are
# what we're actually trying to prevent.
#
# Word boundaries are explicit (``\b``) so common English text doesn't
# trip a match — e.g. "I'm done thinking" wouldn't false-positive on
# "you're done", but "you're done" would.
_CLOSING_LANGUAGE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\byou'?ve\s+(?:completed|finished|cleared|mastered|nailed)\b",
        r"\byou'?re\s+(?:done|finished|all\s+set|ready\s+to\s+move\s+on)\b",
        r"\bunit\s+complete\b",
        r"\bthat'?s\s+a\s+wrap\b",
        r"\bwe'?re\s+(?:done|finished)\s+(?:here|with\s+this\s+unit)\b",
        # "next unit" / "in the next unit" / "on to Unit N+1"
        r"\b(?:in\s+the\s+|on\s+to\s+the?\s+)?next\s+unit\b",
        r"\bon\s+to\s+unit\s+\d+\b",
        r"\bmoving\s+on\s+to\s+(?:unit\s+\d+|the\s+next)\b",
        r"\bsee\s+you\s+(?:in\s+the\s+next\s+unit|next\s+time)\b",
    )
)


def _has_closing_language(chat_text: str) -> bool:
    """True if ``chat_text`` contains language the prompt bans on a
    rejected ``mark_complete`` turn.

    Used by the SSE generator's leak-detector branch to decide whether
    to append an extra "you also leaked closing language" callout to
    the standard rejection nudge. Pure function, no side effects, safe
    to call on every turn (the rejection nudge itself is gated, so we
    only invoke this when ``mark_complete`` was actually rejected).
    """
    if not chat_text:
        return False
    return any(p.search(chat_text) for p in _CLOSING_LANGUAGE_PATTERNS)


# ====================================================================
# Ownership helpers
# ====================================================================
async def _get_owned_project(
    project_id: uuid.UUID, user: User, db: AsyncSession
) -> StudyProject:
    project = await db.get(StudyProject, project_id)
    if project is None or project.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Study project not found"
        )
    return project


async def _get_owned_session(
    session_id: uuid.UUID, user: User, db: AsyncSession
) -> tuple[StudySession, StudyProject]:
    session = await db.get(StudySession, session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Study session not found"
        )
    project = await _get_owned_project(session.project_id, user, db)
    return session, project


async def _get_owned_unit(
    unit_id: uuid.UUID, user: User, db: AsyncSession
) -> tuple[StudyUnit, StudyProject]:
    unit = await db.get(StudyUnit, unit_id)
    if unit is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unit not found"
        )
    project = await _get_owned_project(unit.project_id, user, db)
    return unit, project


async def _get_owned_exam(
    exam_id: uuid.UUID, user: User, db: AsyncSession
) -> tuple[StudyExam, StudyProject]:
    exam = await db.get(StudyExam, exam_id)
    if exam is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exam not found"
        )
    project = await _get_owned_project(exam.project_id, user, db)
    return exam, project


async def _resolve_provider(
    provider: ModelProvider | None,
    user: User,
    db: AsyncSession,
    *,
    model_id: str | None = None,
) -> ModelProvider:
    """Validate provider ownership + per-user model allowlist."""
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
        )
    owner_ok = provider.user_id is None or provider.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, provider.user_id)
        owner_ok = (
            owner is not None and owner.role == "admin" and user.role != "admin"
        )
        if not owner_ok:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown provider"
            )
    if not provider.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider is disabled"
        )
    if model_id is not None:
        from app.models_config.access import is_model_allowed

        # Study model ids aren't synthetic custom ids here, so the base id
        # equals the picked id — but routing through the shared check keeps
        # group grants honoured everywhere.
        if not await is_model_allowed(
            user, db, model_id=model_id, base_model_id=model_id
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have access to that model. Ask an admin to grant it.",
            )
    return provider


async def _pick_provider_for_model(
    model_id: str, user: User, db: AsyncSession
) -> ModelProvider:
    """Find an enabled provider owned by the user (or global) that can serve
    ``model_id`` based on its catalog + enabled_models whitelist."""
    result = await db.execute(
        select(ModelProvider).where(
            (ModelProvider.user_id == user.id) | (ModelProvider.user_id.is_(None)),
            ModelProvider.enabled.is_(True),
        )
    )
    for provider in result.scalars().all():
        catalog_ids = {m["id"] for m in (provider.models or []) if isinstance(m, dict)}
        if model_id not in catalog_ids:
            continue
        allow = provider.enabled_models
        if allow is not None and model_id not in allow:
            continue
        return provider
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"No enabled provider serves model {model_id!r}",
    )


async def _load_study_provider(
    db: AsyncSession,
    user: User,
    project: StudyProject | None = None,
) -> tuple[ModelProvider, str]:
    """Resolve the admin-designated teaching model for Study.

    Precedence:
      1. ``app_settings.study_provider_id`` + ``study_model_id`` — admin's explicit choice.
      2. ``app_settings.default_chat_provider_id`` + ``default_chat_model_id`` — workspace default.
      3. ``project.model_id`` via ``_pick_provider_for_model`` — legacy compat for existing projects.

    Models from the admin settings bypass the per-user ``allowed_models``
    check — the admin chose them for everyone, not the student.

    Raises ``HTTP 503`` with a human-readable admin-action message if
    nothing is configured.
    """
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)

    # 1. Admin-designated study model.
    if settings and settings.study_configured:
        provider = await db.get(ModelProvider, settings.study_provider_id)
        if provider and provider.enabled:
            return provider, settings.study_model_id  # type: ignore[return-value]

    # 2. Workspace default chat model.
    if settings and settings.default_chat_configured:
        provider = await db.get(ModelProvider, settings.default_chat_provider_id)
        if provider and provider.enabled:
            return provider, settings.default_chat_model_id  # type: ignore[return-value]

    # 3. Legacy: project's stored model_id (for sessions created before Phase 0).
    if project and project.model_id:
        try:
            provider = await _pick_provider_for_model(project.model_id, user, db)
            return provider, project.model_id
        except HTTPException:
            pass

    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "No teaching model is configured for Study. "
            "An admin needs to set one under Admin → Models → Defaults → "
            "Study / Teaching model."
        ),
    )


# ====================================================================
# Project DTO helpers
# ====================================================================
async def _project_unit_counts(
    project_id: uuid.UUID, db: AsyncSession
) -> tuple[int, int]:
    """Return ``(total_units, completed_units)``."""
    total_res = await db.execute(
        select(func.count(StudyUnit.id)).where(StudyUnit.project_id == project_id)
    )
    total = int(total_res.scalar() or 0)
    done_res = await db.execute(
        select(func.count(StudyUnit.id)).where(
            StudyUnit.project_id == project_id,
            StudyUnit.status == "completed",
        )
    )
    done = int(done_res.scalar() or 0)
    return total, done


def _unit_summary(
    unit: StudyUnit,
    *,
    gate_blocker: str | None = None,
) -> StudyUnitSummary:
    """Build a ``StudyUnitSummary`` with the derived ``days_since_studied``
    and (optionally) ``gate_blocker`` fields filled in. Pulled out so
    the detail endpoint and the unit ``enter`` endpoint share the same
    computation. ``gate_blocker`` is only computed by callers that have
    the session/mastery/reflection data already loaded — the cheaper
    callers (e.g. the unit-enter response) just leave it ``None``."""
    payload = {
        col.name: getattr(unit, col.name) for col in unit.__table__.columns
    }
    payload["days_since_studied"] = days_since_studied(unit)
    payload["gate_blocker"] = gate_blocker
    return StudyUnitSummary.model_validate(payload)


# Per-objective floor mirrored from ``study.config.PER_OBJECTIVE_FLOOR``
# so the blocker helper can decide "objective mastered" without doing a
# config import dance — kept tight and obvious.
_PER_OBJECTIVE_FLOOR_FOR_BLOCKER = 75


def _compute_gate_blocker(
    *,
    unit: StudyUnit,
    session: StudySession | None,
    mastery_rows: list[StudyObjectiveMastery],
    has_reflection: bool,
) -> str | None:
    """Return the single most informative "why is this unit stuck?" label.

    Mirrors the conditions ``evaluate_completion_gate`` checks but
    works on already-loaded in-memory data so the topic listing
    endpoint can fill ``gate_blocker`` for every in-progress unit
    without N+1 queries. Returns ``None`` for not-started, completed,
    or fully-ready in-progress units (in which case the card just
    shows the standard "In progress" chip with no extra hint).

    The order of checks here is the order the student sees on the
    card — we surface the FIRST unmet condition rather than a list,
    because the card has limited vertical space and the next teaching
    step is the only one the user actually needs to know about.
    Sequence intentionally puts hard-to-fix items (per-objective
    mastery) before easy ones (reflection).
    """
    if unit.status != "in_progress":
        return None

    objectives = list(unit.learning_objectives or [])
    if objectives:
        scored_by_idx = {row.objective_index: row for row in mastery_rows}
        mastered = sum(
            1
            for idx in range(len(objectives))
            if (row := scored_by_idx.get(idx)) is not None
            and row.mastery_score >= _PER_OBJECTIVE_FLOOR_FOR_BLOCKER
        )
        if mastered < len(objectives):
            return f"{mastered}/{len(objectives)} objectives mastered"

    if session is not None and session.teachback_passed_at is None:
        return "Teach-back pending"

    if session is not None and session.confidence_captured_at is None:
        return "Confidence rating pending"

    if not has_reflection:
        return "Reflection pending"

    return None


async def _project_summary(
    project: StudyProject, db: AsyncSession
) -> StudyProjectSummary:
    # Load units so staleness can act on them BEFORE we count "completed"
    # — a stale-flipped unit should vanish from the progress ratio
    # instantly, not only when the detail page re-renders.
    units_res = await db.execute(
        select(StudyUnit)
        .where(StudyUnit.project_id == project.id)
        .order_by(StudyUnit.order_index.asc())
    )
    units = list(units_res.scalars().all())

    changed = await apply_staleness_to_project(db, project, units)
    if changed:
        await db.commit()

    total = len(units)
    done = sum(1 for u in units if u.status == "completed")
    return StudyProjectSummary.model_validate(
        {**_project_fields(project), "total_units": total, "completed_units": done}
    )


async def _project_detail(
    project: StudyProject, db: AsyncSession
) -> StudyProjectDetail:
    units_res = await db.execute(
        select(StudyUnit)
        .where(StudyUnit.project_id == project.id)
        .order_by(StudyUnit.order_index.asc())
    )
    units = list(units_res.scalars().all())

    # Lazy staleness evaluation: runs on every detail load so students
    # always see current verdicts without any background cron.
    changed = await apply_staleness_to_project(db, project, units)
    if changed:
        await db.commit()

    sessions_res = await db.execute(
        select(StudySession)
        .where(StudySession.project_id == project.id)
        .order_by(StudySession.created_at.asc())
    )
    sessions = list(sessions_res.scalars().all())

    exams_res = await db.execute(
        select(StudyExam)
        .where(StudyExam.project_id == project.id)
        .order_by(StudyExam.attempt_number.asc())
    )
    exams = list(exams_res.scalars().all())

    # Batch-load the data needed to compute ``gate_blocker`` for any
    # in-progress unit — one query for mastery, one for reflections —
    # so the listing stays a constant number of round trips regardless
    # of unit count. Only run when the project has at least one
    # in-progress unit; an all-completed plan shouldn't pay the cost.
    in_progress_unit_ids = [u.id for u in units if u.status == "in_progress"]
    mastery_by_unit: dict[uuid.UUID, list[StudyObjectiveMastery]] = {}
    reflection_unit_ids: set[uuid.UUID] = set()
    if in_progress_unit_ids:
        mastery_res = await db.execute(
            select(StudyObjectiveMastery).where(
                StudyObjectiveMastery.unit_id.in_(in_progress_unit_ids)
            )
        )
        for row in mastery_res.scalars().all():
            mastery_by_unit.setdefault(row.unit_id, []).append(row)
        refl_res = await db.execute(
            select(StudyUnitReflection.unit_id)
            .where(StudyUnitReflection.unit_id.in_(in_progress_unit_ids))
            .distinct()
        )
        reflection_unit_ids = {row for row in refl_res.scalars().all()}

    # Build a per-unit session lookup so the blocker helper can read
    # ``teachback_passed_at`` / ``confidence_captured_at`` without
    # another round trip.
    session_by_unit: dict[uuid.UUID, StudySession] = {}
    for s in sessions:
        if s.unit_id is not None:
            session_by_unit[s.unit_id] = s

    def _summary_for(u: StudyUnit) -> StudyUnitSummary:
        blocker = _compute_gate_blocker(
            unit=u,
            session=session_by_unit.get(u.id),
            mastery_rows=mastery_by_unit.get(u.id, []),
            has_reflection=u.id in reflection_unit_ids,
        )
        return _unit_summary(u, gate_blocker=blocker)

    total_units = len(units)
    completed_units = sum(1 for u in units if u.status == "completed")
    has_in_progress_exam = any(e.status == "in_progress" for e in exams)
    already_passed = any(e.status == "passed" for e in exams)
    final_exam_unlocked = (
        total_units > 0
        and completed_units == total_units
        and not has_in_progress_exam
        and project.status != "archived"
        and not already_passed
    )
    active_exam = next((e for e in exams if e.status == "in_progress"), None)

    return StudyProjectDetail.model_validate(
        {
            **_project_fields(project),
            "total_units": total_units,
            "completed_units": completed_units,
            "units": [_summary_for(u) for u in units],
            "sessions": [StudySessionSummary.model_validate(s) for s in sessions],
            "exams": [StudyExamSummary.model_validate(e) for e in exams],
            "final_exam_unlocked": final_exam_unlocked,
            "active_exam_id": active_exam.id if active_exam else None,
        }
    )


def _project_fields(project: StudyProject) -> dict[str, Any]:
    """Extract the raw project columns as a dict for model_validate."""
    return {
        "id": project.id,
        "title": project.title,
        "topics": project.topics,
        "goal": project.goal,
        "learning_request": project.learning_request,
        "difficulty": project.difficulty,
        "current_level": project.current_level,
        "calibrated": project.calibrated,
        "calibration_source": project.calibration_source,
        "status": project.status,
        "model_id": project.model_id,
        "archived_at": project.archived_at,
        "planning_error": project.planning_error,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }


# ====================================================================
# Projects CRUD
# ====================================================================
@router.get("/projects", response_model=list[StudyProjectSummary])
async def list_projects(
    status_filter: str | None = Query(default=None, alias="status"),
    include_archived: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[StudyProjectSummary]:
    """List the user's study topics.

    By default returns everything *except* archived projects — callers
    can flip ``include_archived=true`` to see only archived ones, or
    pass ``status=archived`` explicitly when rendering the archive tab.
    """
    query = select(StudyProject).where(StudyProject.user_id == user.id)
    if status_filter:
        query = query.where(StudyProject.status == status_filter)
    elif not include_archived:
        query = query.where(StudyProject.status != "archived")
    query = query.order_by(StudyProject.updated_at.desc()).limit(limit).offset(offset)

    rows = (await db.execute(query)).scalars().all()
    return [await _project_summary(p, db) for p in rows]


@router.post(
    "/projects",
    response_model=StudyProjectDetail,
    status_code=status.HTTP_201_CREATED,
)
async def create_project(
    payload: StudyProjectCreate,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectDetail:
    """Create a study topic and generate its unit plan inline.

    We generate the plan synchronously because doing it on a background
    task means the frontend has to poll, which adds a sharp edge to
    what should be a single "create → show units" gesture. The planner
    takes anywhere from 5–25 seconds on a typical model; the client
    renders a dedicated "Designing your study plan..." screen for the
    duration.

    If plan generation fails we still persist the project in
    ``planning`` status with the error text so the user can retry
    via ``POST /projects/{id}/regenerate-plan`` instead of losing
    their brief.
    """
    provider, teaching_model_id = await _load_study_provider(db, user)

    project = StudyProject(
        user_id=user.id,
        title=payload.title.strip(),
        topics=[t.strip() for t in payload.topics if t.strip()],
        goal=(payload.goal or "").strip() or None,
        learning_request=payload.learning_request.strip(),
        current_level=payload.current_level,
        model_id=teaching_model_id,
        planning_provider_id=provider.id,
        status="planning",
    )
    db.add(project)
    await db.flush()

    # Attach any uploaded material files before planning so the
    # planner can ground the unit plan in the actual content.
    for file_id in payload.material_file_ids:
        uf = await db.get(UserFile, file_id)
        if uf is None or uf.user_id != user.id:
            continue
        mat = StudyMaterial(
            study_project_id=project.id,
            user_file_id=file_id,
            indexing_status="pending",
        )
        db.add(mat)
    if payload.material_file_ids:
        await db.flush()

    # Extract text from materials to ground the plan (synchronous —
    # full indexing for session retrieval happens async after commit).
    material_context = await extract_material_text_for_planning(db, project.id)

    try:
        await generate_and_apply_plan(
            db=db,
            project=project,
            provider=provider,
            model_id=teaching_model_id,
            material_context=material_context or None,
        )
    except PlanGenerationError as exc:
        # The planner already recorded the error on the project and
        # flushed. Commit so the student has something to retry against.
        await db.commit()
        await db.refresh(project)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Plan generation failed: {exc}",
        )
    except ProviderError as exc:
        await db.rollback()
        # Persist a minimal error-ed project so the user doesn't lose
        # their brief on network blips.
        project = StudyProject(
            user_id=user.id,
            title=payload.title.strip(),
            topics=[t.strip() for t in payload.topics if t.strip()],
            goal=(payload.goal or "").strip() or None,
            learning_request=payload.learning_request.strip(),
            current_level=payload.current_level,
            model_id=payload.model_id,
            planning_provider_id=provider.id,
            status="planning",
            planning_error=str(exc)[:500],
        )
        db.add(project)
        await db.commit()
        await db.refresh(project)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Provider error while generating plan: {exc}",
        )

    await db.commit()
    await db.refresh(project)

    # Kick off async indexing for each attached material now that the
    # project is committed and the file rows are durable.
    for file_id in payload.material_file_ids:
        background.add_task(index_material_for_study_project, project.id, file_id)

    return await _project_detail(project, db)


@router.get("/projects/{project_id}", response_model=StudyProjectDetail)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectDetail:
    project = await _get_owned_project(project_id, user, db)
    return await _project_detail(project, db)


# ---- Study materials -------------------------------------------------------

@router.get(
    "/projects/{project_id}/materials",
    response_model=list[StudyMaterialResponse],
)
async def list_materials(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[StudyMaterialResponse]:
    """List all learning materials attached to a study project."""
    project = await _get_owned_project(project_id, user, db)
    res = await db.execute(
        select(StudyMaterial, UserFile)
        .join(UserFile, UserFile.id == StudyMaterial.user_file_id)
        .where(StudyMaterial.study_project_id == project.id)
        .order_by(StudyMaterial.created_at)
    )
    rows = res.all()
    return [
        StudyMaterialResponse(
            id=mat.id,
            study_project_id=mat.study_project_id,
            user_file_id=mat.user_file_id,
            filename=uf.original_filename or uf.filename,
            mime_type=uf.mime_type,
            size_bytes=uf.size_bytes,
            indexing_status=mat.indexing_status,
            indexing_error=mat.indexing_error,
            indexed_at=mat.indexed_at,
            created_at=mat.created_at,
        )
        for mat, uf in rows
    ]


@router.post(
    "/projects/{project_id}/materials",
    response_model=StudyMaterialResponse,
    status_code=status.HTTP_201_CREATED,
)
async def attach_material(
    project_id: uuid.UUID,
    payload: StudyMaterialAttach,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyMaterialResponse:
    """Attach an already-uploaded file to a study project as learning material.

    Triggers async RAG indexing after the response is sent. Idempotent —
    re-attaching the same file returns the existing record.
    """
    project = await _get_owned_project(project_id, user, db)
    uf = await db.get(UserFile, payload.file_id)
    if uf is None or uf.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    existing_res = await db.execute(
        select(StudyMaterial).where(
            StudyMaterial.study_project_id == project.id,
            StudyMaterial.user_file_id == uf.id,
        )
    )
    existing = existing_res.scalar_one_or_none()
    if existing is not None:
        return StudyMaterialResponse(
            id=existing.id,
            study_project_id=existing.study_project_id,
            user_file_id=existing.user_file_id,
            filename=uf.original_filename or uf.filename,
            mime_type=uf.mime_type,
            size_bytes=uf.size_bytes,
            indexing_status=existing.indexing_status,
            indexing_error=existing.indexing_error,
            indexed_at=existing.indexed_at,
            created_at=existing.created_at,
        )

    mat = StudyMaterial(
        study_project_id=project.id,
        user_file_id=uf.id,
        indexing_status="pending",
    )
    db.add(mat)
    await db.commit()
    await db.refresh(mat)

    background.add_task(index_material_for_study_project, project.id, uf.id)

    return StudyMaterialResponse(
        id=mat.id,
        study_project_id=mat.study_project_id,
        user_file_id=mat.user_file_id,
        filename=uf.original_filename or uf.filename,
        mime_type=uf.mime_type,
        size_bytes=uf.size_bytes,
        indexing_status=mat.indexing_status,
        indexing_error=mat.indexing_error,
        indexed_at=mat.indexed_at,
        created_at=mat.created_at,
    )


@router.delete(
    "/projects/{project_id}/materials/{material_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_material(
    project_id: uuid.UUID,
    material_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Remove a learning material and its indexed chunks from a study project."""
    from sqlalchemy import delete as sql_delete
    from app.custom_models.models import KnowledgeChunk

    project = await _get_owned_project(project_id, user, db)
    mat_res = await db.execute(
        select(StudyMaterial).where(
            StudyMaterial.id == material_id,
            StudyMaterial.study_project_id == project.id,
        )
    )
    mat = mat_res.scalar_one_or_none()
    if mat is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")

    # Delete indexed chunks first, then the material row.
    await db.execute(
        sql_delete(KnowledgeChunk).where(
            KnowledgeChunk.study_project_id == project.id,
            KnowledgeChunk.user_file_id == mat.user_file_id,
        )
    )
    await db.delete(mat)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/projects/{project_id}", response_model=StudyProjectSummary)
async def update_project(
    project_id: uuid.UUID,
    payload: StudyProjectUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectSummary:
    project = await _get_owned_project(project_id, user, db)

    if payload.title is not None:
        project.title = payload.title.strip() or project.title
    if payload.topics is not None:
        project.topics = [t.strip() for t in payload.topics if t.strip()]
    if payload.goal is not None:
        project.goal = payload.goal.strip() or None
    if payload.model_id is not None:
        project.model_id = payload.model_id

    await db.commit()
    await db.refresh(project)
    return await _project_summary(project, db)


@router.delete(
    "/projects/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    project = await _get_owned_project(project_id, user, db)
    await db.delete(project)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/projects/{project_id}/calibrate", response_model=StudyProjectSummary
)
async def calibrate_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectSummary:
    """Skip / short-circuit the Phase-3 Unit-1 diagnostic.

    Flips ``calibrated`` to true on the project so the tutor stops
    running the warm-up diagnostic on new Unit-1 sessions. Safe to
    call repeatedly — it's idempotent.
    """
    project = await _get_owned_project(project_id, user, db)
    if not project.calibrated:
        project.calibrated = True
        # Record that THIS calibration came from the skip button so
        # the later honesty nudge has something to trip on. Don't
        # overwrite if somehow already set — keeps the column
        # write-once.
        if project.calibration_source is None:
            project.calibration_source = "skipped"
        project.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(project)
    return await _project_summary(project, db)


@router.post(
    "/projects/{project_id}/archive", response_model=StudyProjectSummary
)
async def archive_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectSummary:
    project = await _get_owned_project(project_id, user, db)
    project.status = "archived"
    project.archived_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(project)
    return await _project_summary(project, db)


@router.post(
    "/projects/{project_id}/unarchive", response_model=StudyProjectSummary
)
async def unarchive_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectSummary:
    """Pull a project back out of the archive.

    Restores the project to whichever status is most useful right now:
    ``completed`` if the final exam was passed, otherwise ``active``
    if there are units, otherwise ``planning`` (the planner needs
    to run again).
    """
    project = await _get_owned_project(project_id, user, db)
    total, _ = await _project_unit_counts(project.id, db)
    passed_res = await db.execute(
        select(func.count(StudyExam.id)).where(
            StudyExam.project_id == project.id,
            StudyExam.status == "passed",
        )
    )
    passed = int(passed_res.scalar() or 0) > 0
    if passed:
        project.status = "completed"
    elif total > 0:
        project.status = "active"
    else:
        project.status = "planning"
    project.archived_at = None
    await db.commit()
    await db.refresh(project)
    return await _project_summary(project, db)


@router.post(
    "/projects/{project_id}/regenerate-plan",
    response_model=StudyProjectDetail,
)
async def regenerate_plan(
    project_id: uuid.UUID,
    payload: StudyProjectRegeneratePlan,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectDetail:
    project = await _get_owned_project(project_id, user, db)

    if project.status == "completed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic has already been passed — regenerating would wipe progress.",
        )

    provider, model_id = await _load_study_provider(db, user, project)

    project.model_id = model_id
    project.planning_provider_id = provider.id
    project.status = "planning"

    try:
        await generate_and_apply_plan(
            db=db, project=project, provider=provider, model_id=model_id
        )
    except PlanGenerationError as exc:
        await db.commit()
        await db.refresh(project)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Plan generation failed: {exc}",
        )
    except ProviderError as exc:
        project.planning_error = str(exc)[:500]
        await db.commit()
        await db.refresh(project)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Provider error while generating plan: {exc}",
        )

    await db.commit()
    await db.refresh(project)
    return await _project_detail(project, db)


# ====================================================================
# Learner state (Study 10/10) — profile, mastery, misconceptions,
# review queue, confidence capture. These endpoints back the
# LearnerProfilePanel, ObjectiveMasteryList, MisconceptionsPanel,
# ReviewQueueWidget, and ConfidenceWidget frontend components.
# ====================================================================
def _render_learner_profile(project: StudyProject) -> LearnerProfileResponse:
    raw = project.learner_profile or {}
    return LearnerProfileResponse(
        profile=LearnerProfile(**raw) if isinstance(raw, dict) else LearnerProfile(),
        updated_at=project.learner_profile_updated_at,
    )


@router.get(
    "/projects/{project_id}/learner-profile",
    response_model=LearnerProfileResponse,
)
async def get_learner_profile(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LearnerProfileResponse:
    project = await _get_owned_project(project_id, user, db)
    return _render_learner_profile(project)


@router.put(
    "/projects/{project_id}/learner-profile",
    response_model=LearnerProfileResponse,
)
async def update_learner_profile(
    project_id: uuid.UUID,
    payload: LearnerProfileUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LearnerProfileResponse:
    """Student-editable profile update.

    Only fields present in the payload are touched — omitting a
    field leaves the existing value alone. Passing an empty list or
    empty string is treated as an explicit clear (student said "no,
    I don't have any interests to list right now").
    """
    project = await _get_owned_project(project_id, user, db)
    current: dict[str, Any] = dict(project.learner_profile or {})

    if payload.occupation is not None:
        current["occupation"] = payload.occupation.strip()
    if payload.interests is not None:
        current["interests"] = [i.strip() for i in payload.interests if i.strip()]
    if payload.goals is not None:
        current["goals"] = [g.strip() for g in payload.goals if g.strip()]
    if payload.background is not None:
        current["background"] = payload.background.strip()
    if payload.preferred_examples_from is not None:
        current["preferred_examples_from"] = [
            p.strip() for p in payload.preferred_examples_from if p.strip()
        ]
    if payload.free_form is not None:
        current["free_form"] = {str(k): v for k, v in payload.free_form.items()}

    project.learner_profile = current
    project.learner_profile_updated_at = datetime.now(timezone.utc)
    project.updated_at = project.learner_profile_updated_at
    await db.commit()
    await db.refresh(project)
    return _render_learner_profile(project)


def _render_mastery_entry(
    row: StudyObjectiveMastery, now: datetime
) -> ObjectiveMasteryEntry:
    days_since: int | None = None
    if row.last_reviewed_at is not None:
        ref = row.last_reviewed_at
        if ref.tzinfo is None:
            ref = ref.replace(tzinfo=timezone.utc)
        days_since = max(0, int((now - ref).total_seconds() // 86400))
    is_due = False
    if row.next_review_at is not None:
        ref = row.next_review_at
        if ref.tzinfo is None:
            ref = ref.replace(tzinfo=timezone.utc)
        is_due = ref <= now
    return ObjectiveMasteryEntry(
        id=row.id,
        project_id=row.project_id,
        unit_id=row.unit_id,
        objective_index=row.objective_index,
        objective_text=row.objective_text,
        mastery_score=row.mastery_score,
        ease_factor=row.ease_factor,
        interval_days=row.interval_days,
        last_reviewed_at=row.last_reviewed_at,
        next_review_at=row.next_review_at,
        review_count=row.review_count,
        consecutive_failures=row.consecutive_failures,
        days_since_review=days_since,
        is_due=is_due,
    )


@router.get(
    "/projects/{project_id}/objective-mastery",
    response_model=ObjectiveMasteryListResponse,
)
async def list_objective_mastery(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ObjectiveMasteryListResponse:
    project = await _get_owned_project(project_id, user, db)
    rows = await study_review.list_mastery_for_project(db, project.id)
    now = datetime.now(timezone.utc)
    return ObjectiveMasteryListResponse(
        entries=[_render_mastery_entry(r, now) for r in rows]
    )


@router.get(
    "/projects/{project_id}/misconceptions",
    response_model=MisconceptionListResponse,
)
async def list_misconceptions(
    project_id: uuid.UUID,
    include_resolved: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MisconceptionListResponse:
    project = await _get_owned_project(project_id, user, db)
    stmt = select(StudyMisconception).where(
        StudyMisconception.project_id == project.id
    )
    if not include_resolved:
        stmt = stmt.where(StudyMisconception.resolved_at.is_(None))
    stmt = stmt.order_by(StudyMisconception.last_seen_at.desc())
    rows = list((await db.execute(stmt)).scalars().all())
    return MisconceptionListResponse(
        entries=[MisconceptionEntry.model_validate(r) for r in rows]
    )


@router.post(
    "/projects/{project_id}/misconceptions/{misconception_id:uuid}/resolve",
    response_model=MisconceptionEntry,
)
async def resolve_misconception(
    project_id: uuid.UUID,
    misconception_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MisconceptionEntry:
    """Student-initiated "I've got this now" dismissal."""
    project = await _get_owned_project(project_id, user, db)
    row = await db.get(StudyMisconception, misconception_id)
    if row is None or row.project_id != project.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Misconception not found",
        )
    if row.resolved_at is None:
        row.resolved_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(row)
    return MisconceptionEntry.model_validate(row)


@router.get(
    "/projects/{project_id}/review-queue",
    response_model=ReviewQueueResponse,
)
async def get_review_queue(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ReviewQueueResponse:
    """Top items due for spaced-repetition review across the project.

    Joins to ``study_units`` so the frontend can render the unit
    title in the widget without a second round-trip.
    """
    project = await _get_owned_project(project_id, user, db)
    queue_rows = await study_review.compute_due(db, project.id)
    if not queue_rows:
        return ReviewQueueResponse(items=[])

    unit_ids = {r.unit_id for r in queue_rows}
    units_stmt = select(StudyUnit).where(StudyUnit.id.in_(unit_ids))
    units_by_id = {
        u.id: u for u in (await db.execute(units_stmt)).scalars().all()
    }
    now = datetime.now(timezone.utc)
    items: list[ReviewQueueItem] = []
    for row in queue_rows:
        unit = units_by_id.get(row.unit_id)
        if unit is None:
            continue
        overdue = 0
        if row.next_review_at is not None:
            ref = row.next_review_at
            if ref.tzinfo is None:
                ref = ref.replace(tzinfo=timezone.utc)
            overdue = max(0, int((now - ref).total_seconds() // 86400))
        items.append(
            ReviewQueueItem(
                objective_id=row.id,
                unit_id=row.unit_id,
                unit_title=unit.title,
                objective_index=row.objective_index,
                objective_text=row.objective_text,
                mastery_score=row.mastery_score,
                days_overdue=overdue,
                last_reviewed_at=row.last_reviewed_at,
            )
        )
    return ReviewQueueResponse(items=items)


@router.post(
    "/sessions/{session_id}/confidence",
    response_model=ConfidenceCaptureResponse,
)
async def capture_session_confidence(
    session_id: uuid.UUID,
    payload: ConfidenceCaptureRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConfidenceCaptureResponse:
    """Student-initiated confidence capture.

    Complements the tutor's ``capture_confidence`` action so the
    student can volunteer a rating even if the tutor didn't ask. Sets
    ``confidence_captured_at`` which is one of the mark-complete gate
    conditions.
    """
    session, _ = await _get_owned_session(session_id, user, db)
    now = datetime.now(timezone.utc)
    session.confidence_captured_at = now
    session.updated_at = now
    await db.commit()
    await db.refresh(session)
    return ConfidenceCaptureResponse(
        session_id=session.id,
        captured_at=now,
        level=payload.level,
    )


@router.get(
    "/sessions/{session_id}/completion-readiness",
    response_model=CompletionReadinessResponse,
)
async def get_completion_readiness(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CompletionReadinessResponse:
    """Read-only snapshot of the six-condition completion gate.

    Lets the UI render a live progress checklist (teach-back ✓,
    confidence ⨯, 3/5 turns…) without having to duplicate the gate
    logic client-side — the same :func:`evaluate_completion_gate`
    the ``mark_complete`` action handler uses is the single source
    of truth for what "ready" means.
    """
    session, _ = await _get_owned_session(session_id, user, db)
    if session.kind != "unit" or session.unit_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Completion readiness is only meaningful for unit sessions.",
        )
    unit = await db.get(StudyUnit, session.unit_id)
    if unit is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unit no longer exists.",
        )
    readiness = await evaluate_completion_gate(
        db=db, unit=unit, session=session, proposed_score=None, proposed_summary=None
    )
    return CompletionReadinessResponse(
        ready=readiness["ready"],
        unmet=list(readiness["unmet"]),
        overall_score=readiness["overall_score"],
        per_objective=[
            CompletionReadinessObjective(
                index=e["index"],
                text=e["text"],
                score=e["score"],
                meets_floor=e["meets_floor"],
            )
            for e in readiness["per_objective"]
        ],
        teachback_passed=readiness["teachback_passed"],
        confidence_captured=readiness["confidence_captured"],
        student_turn_count=readiness["student_turn_count"],
        min_turns_required=readiness["min_turns_required"],
        has_reflection=readiness["has_reflection"],
    )


# ====================================================================
# Units
# ====================================================================
@router.post("/units/{unit_id}/enter", response_model=UnitEnterResponse)
async def enter_unit(
    unit_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> UnitEnterResponse:
    """Open (or reopen) a tutor session bound to this unit.

    A unit has at most one tutor session. If none exists yet we create
    one; if the stored session was hard-deleted out from under us we
    transparently regenerate it. Entering a ``not_started`` unit
    transitions it to ``in_progress``.

    For brand-new sessions (zero prior messages) we enqueue a
    synthetic kickoff stream so the tutor speaks first — a warm
    opener that references the unit's objectives and asks if the
    student is ready. Re-entering an existing session does NOT
    enqueue a second kickoff; the client gets ``stream_id=None``
    and reads the existing transcript normally.
    """
    unit, project = await _get_owned_unit(unit_id, user, db)

    if project.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic is archived — unarchive it to keep studying.",
        )

    session: StudySession | None = None
    if unit.session_id:
        session = await db.get(StudySession, unit.session_id)
    fresh_session = session is None
    if session is None:
        session = StudySession(
            project_id=project.id,
            kind="unit",
            unit_id=unit.id,
        )
        db.add(session)
        await db.flush()
        unit.session_id = session.id

    # Even if the session existed, treat it as kickoff-eligible when
    # there are zero persisted messages (e.g. a prior kickoff failed
    # before writing anything). Cheap COUNT keeps this O(1).
    existing_msgs = 0
    if not fresh_session:
        count_res = await db.execute(
            select(func.count(StudyMessage.id)).where(
                StudyMessage.session_id == session.id
            )
        )
        existing_msgs = int(count_res.scalar() or 0)
    should_kickoff = fresh_session or existing_msgs == 0

    now = datetime.now(timezone.utc)
    if unit.status == "not_started":
        unit.status = "in_progress"
    unit.last_studied_at = now
    unit.updated_at = now
    project.updated_at = now

    # Resolve the admin-designated teaching model for the kickoff stream.
    # Silently skip the stream (not an error) when no model is reachable —
    # the student lands on the existing transcript instead.
    kickoff_stream_id: uuid.UUID | None = None
    if should_kickoff:
        try:
            provider, teaching_model_id = await _load_study_provider(db, user, project)
        except HTTPException:
            provider = None
            teaching_model_id = None
        if provider is not None:
            # Mirror the final-exam kickoff pattern: a short
            # student-authored "let's start" seed so the tutor's
            # opener reads as a natural reply rather than an
            # unprompted monologue. Visible in the transcript (like
            # the exam kickoff) so the conversation stays coherent.
            kickoff = StudyMessage(
                session_id=session.id,
                role="user",
                content="I just opened this unit. I'm ready — let's start.",
            )
            db.add(kickoff)
            session.student_turn_count = (session.student_turn_count or 0) + 1
            session.updated_at = now
            await db.commit()
            await db.refresh(kickoff)

            kickoff_stream_id = uuid.uuid4()
            ctx: StudyStreamContext = {
                "session_id": str(session.id),
                "project_id": str(project.id),
                "user_message_id": str(kickoff.id),
                "provider_id": str(provider.id),
                "model_id": teaching_model_id,
                "temperature": 0.6,
                "max_tokens": 2000,
                "reviewing_exercise_id": None,
                "session_kind": "unit",
                "unit_id": str(unit.id),
                "exam_id": None,
            }
            await enqueue_stream(kickoff_stream_id, ctx)
        else:
            await db.commit()
    else:
        await db.commit()
    await db.refresh(unit)
    await db.refresh(session)

    return UnitEnterResponse(
        unit=_unit_summary(unit),
        session=StudySessionSummary.model_validate(session),
        stream_id=kickoff_stream_id,
    )


@router.get("/units/{unit_id}", response_model=StudyUnitSummary)
async def get_unit(
    unit_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyUnitSummary:
    unit, _ = await _get_owned_unit(unit_id, user, db)
    return _unit_summary(unit)


@router.post("/units/{unit_id}/reset", response_model=StudyUnitSummary)
async def reset_unit(
    unit_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyUnitSummary:
    """Wipe a unit's progress so the student can re-study it from scratch.

    Deletes the unit's tutor session (which cascades its chat messages,
    whiteboard exercises, board blocks, and retrieval attempts) plus the
    unit-scoped learner state the session cascade doesn't reach
    (per-objective mastery, reflections, unit-specific misconceptions),
    then resets the unit row back to ``not_started``. The unit's
    *definition* — title, description, objectives, prereq metadata — is
    preserved; only progress is cleared.

    Resetting a completed unit on a finished project flips the project
    back to ``active`` (it's no longer fully complete). Archived topics
    must be unarchived first, mirroring the other write endpoints.
    """
    from sqlalchemy import delete as sql_delete

    unit, project = await _get_owned_unit(unit_id, user, db)

    if project.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic is archived — unarchive it to reset a unit.",
        )

    # Detach the unit's session pointer first so deleting the session
    # below doesn't momentarily leave a dangling FK, then delete the
    # session. The DB cascades study_messages, whiteboard_exercises,
    # study_board_blocks, and session-scoped study_retrieval_attempts.
    session_id = unit.session_id
    unit.session_id = None
    await db.flush()
    if session_id is not None:
        session = await db.get(StudySession, session_id)
        if session is not None:
            await db.delete(session)
            await db.flush()

    # Unit-scoped learner state the session cascade doesn't cover.
    await db.execute(
        sql_delete(StudyObjectiveMastery).where(
            StudyObjectiveMastery.unit_id == unit.id
        )
    )
    await db.execute(
        sql_delete(StudyUnitReflection).where(
            StudyUnitReflection.unit_id == unit.id
        )
    )
    await db.execute(
        sql_delete(StudyMisconception).where(
            StudyMisconception.unit_id == unit.id
        )
    )
    # Any retrieval attempts not already removed via the session cascade
    # (e.g. rows whose session was previously hard-deleted, leaving the
    # attempt with a null session_id but this unit_id still set).
    await db.execute(
        sql_delete(StudyRetrievalAttempt).where(
            StudyRetrievalAttempt.unit_id == unit.id
        )
    )

    now = datetime.now(timezone.utc)
    unit.status = "not_started"
    unit.mastery_score = None
    unit.mastery_summary = None
    unit.exam_focus = None
    unit.completed_at = None
    unit.last_studied_at = None
    unit.updated_at = now

    # A reset unit means the plan is no longer fully complete; pull a
    # finished project back to active so its progress ratio is honest.
    if project.status == "completed":
        project.status = "active"
    project.updated_at = now

    await db.commit()
    await db.refresh(unit)
    return _unit_summary(unit)


# ====================================================================
# Final Exam
# ====================================================================
@router.post(
    "/projects/{project_id}/final-exam",
    response_model=StudyExamStartResponse,
)
async def start_final_exam(
    project_id: uuid.UUID,
    payload: StudyExamStartRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyExamStartResponse:
    """Start (or resume) the final exam for this project.

    Idempotent — if there's an in-progress exam, returns its session
    rather than creating a second one. Verifies that every unit has
    been completed before letting a new attempt begin.
    """
    project = await _get_owned_project(project_id, user, db)
    if project.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic is archived — unarchive it first.",
        )

    units_res = await db.execute(
        select(StudyUnit)
        .where(StudyUnit.project_id == project.id)
        .order_by(StudyUnit.order_index.asc())
    )
    units = list(units_res.scalars().all())
    if not units:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No units on this project — generate a plan first.",
        )

    # If there's already an in-progress exam, return it directly.
    active_res = await db.execute(
        select(StudyExam).where(
            StudyExam.project_id == project.id,
            StudyExam.status == "in_progress",
        )
    )
    active = active_res.scalars().first()
    if active is not None:
        session = await db.get(StudySession, active.session_id) if active.session_id else None
        if session is None:
            # Session was deleted out from under us — recreate.
            session = StudySession(
                project_id=project.id, kind="exam", exam_id=active.id
            )
            db.add(session)
            await db.flush()
            active.session_id = session.id
            await db.commit()
            await db.refresh(active)
            await db.refresh(session)
        return StudyExamStartResponse(
            exam=StudyExamSummary.model_validate(active),
            session=StudySessionSummary.model_validate(session),
            stream_id=None,
        )

    # All units must be completed before a fresh attempt.
    incomplete = [u for u in units if u.status != "completed"]
    if incomplete:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{len(incomplete)} unit(s) are still incomplete.",
        )
    # And there must not be a passed exam (they should archive instead).
    passed_res = await db.execute(
        select(func.count(StudyExam.id)).where(
            StudyExam.project_id == project.id,
            StudyExam.status == "passed",
        )
    )
    if int(passed_res.scalar() or 0) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic has already been passed — archive it instead.",
        )

    provider, model_id = await _load_study_provider(db, user, project)

    # Determine the next attempt number.
    prior_res = await db.execute(
        select(func.count(StudyExam.id)).where(StudyExam.project_id == project.id)
    )
    next_attempt = int(prior_res.scalar() or 0) + 1

    time_limit = payload.time_limit_seconds or EXAM_DEFAULT_TIME_LIMIT_SECONDS
    now = datetime.now(timezone.utc)

    exam = StudyExam(
        project_id=project.id,
        attempt_number=next_attempt,
        status="in_progress",
        time_limit_seconds=time_limit,
        started_at=now,
    )
    db.add(exam)
    await db.flush()

    session = StudySession(
        project_id=project.id,
        kind="exam",
        exam_id=exam.id,
    )
    db.add(session)
    await db.flush()
    exam.session_id = session.id

    # Kick off the exam with a synthetic "start the exam" user message
    # so the AI examiner can deliver item #1 without needing the
    # student to say anything first.
    kickoff = StudyMessage(
        session_id=session.id,
        role="user",
        content="Please start the final exam now. I'm ready.",
    )
    db.add(kickoff)
    project.updated_at = now
    session.updated_at = now
    await db.commit()
    await db.refresh(exam)
    await db.refresh(session)
    await db.refresh(kickoff)

    stream_id = uuid.uuid4()
    ctx: StudyStreamContext = {
        "session_id": str(session.id),
        "project_id": str(project.id),
        "user_message_id": str(kickoff.id),
        "provider_id": str(provider.id),
        "model_id": model_id,
        "temperature": 0.5,
        "max_tokens": 8000,
        "reviewing_exercise_id": None,
        "session_kind": "exam",
        "unit_id": None,
        "exam_id": str(exam.id),
    }
    await enqueue_stream(stream_id, ctx)

    return StudyExamStartResponse(
        exam=StudyExamSummary.model_validate(exam),
        session=StudySessionSummary.model_validate(session),
        stream_id=stream_id,
    )


@router.get("/exams/{exam_id}", response_model=StudyExamSummary)
async def get_exam(
    exam_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyExamSummary:
    exam, _ = await _get_owned_exam(exam_id, user, db)
    return StudyExamSummary.model_validate(exam)


@router.post("/exams/{exam_id}/timeout", response_model=StudyExamSummary)
async def timeout_exam(
    exam_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyExamSummary:
    """Mark the current exam attempt as ended due to time running out.

    Called by the frontend when the local timer hits zero. The AI
    examiner will still be given one final chance (through a synthetic
    system-style user message) to emit a ``<exam_action>`` grade, but
    that happens as a follow-up send from the client — this endpoint
    just seals the timer server-side so further answers don't count.
    """
    exam, project = await _get_owned_exam(exam_id, user, db)
    if exam.status != "in_progress":
        return StudyExamSummary.model_validate(exam)

    # Don't auto-fail here; let the AI grade what it got. We just
    # record the end time and wait for the grading action to land.
    exam.ended_at = datetime.now(timezone.utc)
    exam.updated_at = exam.ended_at
    project.updated_at = exam.ended_at
    await db.commit()
    await db.refresh(exam)
    return StudyExamSummary.model_validate(exam)


# ====================================================================
# Sessions (read only; creation is implicit via enter_unit / start_final_exam)
# ====================================================================
@router.get("/sessions/{session_id}", response_model=StudySessionDetail)
async def get_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudySessionDetail:
    session, _ = await _get_owned_session(session_id, user, db)
    messages_res = await db.execute(
        select(StudyMessage)
        .where(StudyMessage.session_id == session.id)
        .order_by(StudyMessage.created_at.asc())
    )
    messages = [StudyMessageResponse.model_validate(m) for m in messages_res.scalars().all()]
    return StudySessionDetail.model_validate(
        {
            "id": session.id,
            "project_id": session.project_id,
            "kind": session.kind,
            "unit_id": session.unit_id,
            "exam_id": session.exam_id,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
            "notes_md": session.notes_md,
            "messages": messages,
        }
    )


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_session(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    session, _ = await _get_owned_session(session_id, user, db)
    await db.delete(session)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ====================================================================
# Send message (enqueue stream)
# ====================================================================
@router.post(
    "/sessions/{session_id}/messages",
    response_model=StudySendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def send_message(
    session_id: uuid.UUID,
    payload: StudySendMessageRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudySendMessageResponse:
    session, project = await _get_owned_session(session_id, user, db)

    if project.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic is archived — unarchive it to keep studying.",
        )

    provider, model_id = await _load_study_provider(db, user, project)

    user_msg = StudyMessage(
        session_id=session.id,
        role="user",
        content=payload.content,
    )
    db.add(user_msg)

    project.model_id = model_id
    now = datetime.now(timezone.utc)
    project.updated_at = now
    session.updated_at = now
    # Monotonic student-turn counter — feeds the completion gate's
    # "student has had enough back-and-forth before closing" check.
    session.student_turn_count = (session.student_turn_count or 0) + 1
    if session.kind == "unit" and session.unit_id:
        unit = await db.get(StudyUnit, session.unit_id)
        if unit is not None:
            unit.last_studied_at = now
            unit.updated_at = now
            # Seed min_turns_required the first time this session gets
            # a user message. Uses the unit's current objective count,
            # so if the tutor later splices in prereqs the floor stays
            # keyed to THIS unit's scope.
            if session.min_turns_required is None:
                n_obj = len(unit.learning_objectives or []) or 1
                session.min_turns_required = study_min_turns_required(n_obj)

    # Sticky-until-satisfied review focus. The frontend passes
    # ``review_focus_objective_id`` on the FIRST message after a
    # ReviewQueueWidget deep-link; we only stamp it if the session
    # doesn't already have a focus AND the referenced mastery row
    # belongs to this session's unit (prevents cross-unit deep-links
    # from silently corrupting focus). The focus auto-clears when
    # the tutor scores the matching objective — see
    # handle_update_objective_mastery.
    if (
        payload.review_focus_objective_id is not None
        and session.current_review_focus_objective_id is None
        and session.kind == "unit"
        and session.unit_id is not None
    ):
        focus_row = await db.get(
            StudyObjectiveMastery, payload.review_focus_objective_id
        )
        if focus_row is not None and focus_row.unit_id == session.unit_id:
            session.current_review_focus_objective_id = focus_row.id

    await db.commit()
    await db.refresh(user_msg)

    # Unit and exam turns can place an interactive exercise, whose raw
    # HTML alone runs 2–3k tokens. The client's default budget (4096)
    # left too little room once feedback prose was added, truncating the
    # reply mid-``<whiteboard_action>`` and silently dropping the
    # exercise. Floor those kinds at a budget that fits a full exercise
    # plus commentary; legacy free-chat sessions keep the client value.
    requested_max_tokens = payload.max_tokens or 4096
    if session.kind in ("unit", "exam"):
        effective_max_tokens = max(requested_max_tokens, 8000)
    else:
        effective_max_tokens = requested_max_tokens

    stream_id = uuid.uuid4()
    ctx: StudyStreamContext = {
        "session_id": str(session.id),
        "project_id": str(project.id),
        "user_message_id": str(user_msg.id),
        "provider_id": str(provider.id),
        "model_id": model_id,
        "temperature": payload.temperature,
        "max_tokens": effective_max_tokens,
        "reviewing_exercise_id": None,
        "session_kind": session.kind or "legacy",
        "unit_id": str(session.unit_id) if session.unit_id else None,
        "exam_id": str(session.exam_id) if session.exam_id else None,
    }
    await enqueue_stream(stream_id, ctx)

    return StudySendMessageResponse(
        stream_id=stream_id,
        user_message=StudyMessageResponse.model_validate(user_msg),
    )


# ====================================================================
# SSE stream
# ====================================================================
def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


async def _stream_generator(
    stream_id: uuid.UUID, user: User, request: Request
) -> AsyncGenerator[str, None]:
    ctx = await consume_stream(stream_id)
    if ctx is None:
        yield _sse({"error": "Stream not found or expired"})
        yield _sse({"done": True})
        return

    session_id = uuid.UUID(ctx["session_id"])
    provider_id = uuid.UUID(ctx["provider_id"])
    reviewing_exercise_id = (
        uuid.UUID(ctx["reviewing_exercise_id"])
        if ctx.get("reviewing_exercise_id")
        else None
    )
    session_kind = ctx.get("session_kind") or "legacy"
    unit_id = uuid.UUID(ctx["unit_id"]) if ctx.get("unit_id") else None
    exam_id = uuid.UUID(ctx["exam_id"]) if ctx.get("exam_id") else None

    async with SessionLocal() as db:
        session = await db.get(StudySession, session_id)
        if session is None:
            yield _sse({"error": "Session not found"})
            yield _sse({"done": True})
            return

        project = await db.get(StudyProject, session.project_id)
        if project is None or project.user_id != user.id:
            yield _sse({"error": "Study project not found"})
            yield _sse({"done": True})
            return

        provider = await db.get(ModelProvider, provider_id)
        if provider is None:
            yield _sse({"error": "Provider no longer exists"})
            yield _sse({"done": True})
            return

        # Load unit / exam context up front so the prompt builders can
        # be called without extra round-trips.
        unit: StudyUnit | None = None
        all_units: list[StudyUnit] = []
        if session_kind == "unit" and unit_id is not None:
            unit = await db.get(StudyUnit, unit_id)
            all_units_res = await db.execute(
                select(StudyUnit)
                .where(StudyUnit.project_id == project.id)
                .order_by(StudyUnit.order_index.asc())
            )
            all_units = list(all_units_res.scalars().all())

        exam: StudyExam | None = None
        exam_units: list[StudyUnit] = []
        prior_exams: list[StudyExam] = []
        if session_kind == "exam" and exam_id is not None:
            exam = await db.get(StudyExam, exam_id)
            exam_units_res = await db.execute(
                select(StudyUnit)
                .where(StudyUnit.project_id == project.id)
                .order_by(StudyUnit.order_index.asc())
            )
            exam_units = list(exam_units_res.scalars().all())
            prior_res = await db.execute(
                select(StudyExam)
                .where(
                    StudyExam.project_id == project.id,
                    StudyExam.id != (exam.id if exam else None),
                )
                .order_by(StudyExam.attempt_number.asc())
            )
            prior_exams = [
                e for e in prior_res.scalars().all() if e.status in ("passed", "failed")
            ]

        # Rehydrate history.
        messages_res = await db.execute(
            select(StudyMessage)
            .where(StudyMessage.session_id == session.id)
            .order_by(StudyMessage.created_at.asc())
        )
        history_rows = list(messages_res.scalars().all())
        linked_ids = {m.exercise_id for m in history_rows if m.exercise_id is not None}
        exercises_by_msg: dict[uuid.UUID, WhiteboardExercise] = {}
        if linked_ids:
            ex_res = await db.execute(
                select(WhiteboardExercise).where(WhiteboardExercise.id.in_(linked_ids))
            )
            for ex in ex_res.scalars().all():
                if ex.message_id is not None:
                    exercises_by_msg[ex.message_id] = ex

        history: list[ChatMessage] = build_history_for_llm(
            history_rows, exercises_by_msg
        )

        # Pick the right system prompt + tag set for this session kind.
        if session_kind == "unit" and unit is not None:
            # Seed per-objective mastery rows (idempotent) so a
            # legacy unit created before the 0033 migration still
            # gets a populated Mastery-state block on first open.
            await study_review.seed_objectives_for_unit(db, unit)
            mastery_rows = await study_review.list_mastery_for_project(db, project.id)
            # Recent reflections across the project, most-recent first.
            refl_stmt = (
                select(StudyUnitReflection)
                .join(StudyUnit, StudyUnit.id == StudyUnitReflection.unit_id)
                .where(StudyUnit.project_id == project.id)
                .order_by(StudyUnitReflection.created_at.desc())
                .limit(10)
            )
            recent_reflections = list(
                (await db.execute(refl_stmt)).scalars().all()
            )
            # Unresolved misconceptions, most-recently seen first.
            misc_stmt = (
                select(StudyMisconception)
                .where(
                    StudyMisconception.project_id == project.id,
                    StudyMisconception.resolved_at.is_(None),
                )
                .order_by(StudyMisconception.last_seen_at.desc())
                .limit(20)
            )
            open_misconceptions = list(
                (await db.execute(misc_stmt)).scalars().all()
            )
            review_queue = await study_review.compute_due(db, project.id)
            # Resolve the sticky review focus (if any) to a mastery
            # row so the prompt can inject a dedicated focus block.
            # Focus lives on ``study_sessions`` and auto-clears when
            # the tutor scores the matching objective — see
            # handle_update_objective_mastery + the 0034 migration.
            review_focus: StudyObjectiveMastery | None = None
            focus_id = getattr(session, "current_review_focus_objective_id", None)
            if focus_id is not None:
                review_focus = await db.get(StudyObjectiveMastery, focus_id)
            # Advance the lesson phase (Phase 2 orchestrator).
            # This mutates session.phase / session.phase_history in
            # place; the changes are committed with the assistant
            # message at the end of the stream.
            current_phase = advance_phase(
                session=session,
                unit=unit,
                mastery_rows=mastery_rows,
                has_due_reviews=bool(review_queue),
            )

            # Commit the seeding changes so the transaction stays
            # tidy even if the LLM call downstream fails.
            await db.commit()

            # Retrieve relevant passages from study materials (if any
            # are indexed). Uses the student's last message as the
            # query so the returned chunks are scoped to this turn.
            # Falls back to "" when no embedding provider is configured
            # or no materials are indexed — graceful degradation.
            last_user_text = next(
                (m.content for m in reversed(history_rows) if m.role == "user"),
                "",
            ) or ""
            retrieved_material = await retrieve_for_study_session(
                db,
                study_project_id=project.id,
                query=last_user_text,
            )

            system_prompt = build_unit_system_prompt(
                project=project,
                unit=unit,
                all_units=all_units,
                mastery_rows=mastery_rows,
                recent_reflections=recent_reflections,
                open_misconceptions=open_misconceptions,
                review_queue=review_queue,
                review_focus=review_focus,
                current_phase=current_phase,
                session_goal=getattr(session, "session_goal", None),
                material_context=retrieved_material or None,
            )
            allowed_tags = ["whiteboard_action", "unit_action", "board_op"]
        elif session_kind == "exam" and exam is not None:
            system_prompt = build_exam_system_prompt(
                project=project,
                exam=exam,
                units=exam_units,
                prior_exams=prior_exams,
            )
            allowed_tags = ["whiteboard_action", "exam_action"]
        else:
            system_prompt = build_legacy_system_prompt(project)
            allowed_tags = ["whiteboard_action"]

        yield _sse({"event": "start", "stream_id": str(stream_id)})

        parser = TaggedActionParser(tags=allowed_tags)
        chat_parts: list[str] = []
        pending_whiteboard: list[dict[str, Any]] = []
        pending_side_actions: list[Any] = []  # Capture objects for unit/exam

        try:
            async for token in model_router.stream_chat(
                provider=provider,
                model_id=ctx["model_id"],
                messages=history,
                system=system_prompt,
                temperature=ctx["temperature"],
                max_tokens=ctx["max_tokens"],
            ):
                if await request.is_disconnected():
                    logger.info("Study SSE client disconnected: %s", stream_id)
                    return
                safe_text, captures = parser.feed(token)
                if safe_text:
                    chat_parts.append(safe_text)
                    yield _sse({"delta": safe_text})
                for cap in captures:
                    if cap.tag == "whiteboard_action":
                        payload_obj = parse_whiteboard_payload(cap.body)
                        if payload_obj is None:
                            logger.warning(
                                "Discarding malformed whiteboard_action (%d chars) - "
                                "head=%r",
                                len(cap.body),
                                cap.body[:120],
                            )
                            continue
                        pending_whiteboard.append(payload_obj)
                        yield _sse(
                            {
                                "event": "action_detected",
                                "kind": payload_obj.get("type"),
                            }
                        )
                    else:
                        pending_side_actions.append(cap)
                        yield _sse(
                            {"event": "action_detected", "kind": cap.tag}
                        )
        except ProviderError as e:
            logger.warning("Study provider error on stream %s: %s", stream_id, e)
            yield _sse({"error": str(e)})
            yield _sse({"done": True})
            return
        except asyncio.CancelledError:
            logger.info("Study stream %s cancelled", stream_id)
            raise

        # Detect a truncated action block BEFORE flushing — flush()
        # discards any partial capture. ``truncated_tag`` is the tag the
        # model was still mid-emit on when the stream ended (usually
        # because it hit the token budget). For ``whiteboard_action``
        # this means an exercise was cut off and would otherwise vanish
        # without a trace.
        truncated_tag = parser.pending_capture()
        tail = parser.flush()
        if tail:
            chat_parts.append(tail)
            yield _sse({"delta": tail})

        exercise_truncated = truncated_tag == "whiteboard_action"
        if truncated_tag is not None:
            logger.warning(
                "Study stream %s ended mid-<%s> (token budget?) — partial "
                "action discarded",
                stream_id,
                truncated_tag,
            )

        full_chat = "".join(chat_parts)

        # Self-heal a truncated exercise. ``pending_whiteboard`` holds the
        # complete, parsed exercises from this turn; if the model's block
        # was cut off mid-stream nothing lands there. When that happens
        # AND nothing complete arrived, the student would be left staring
        # at a blank board with no explanation — so add a short, visible
        # recovery prompt to the reply they can act on immediately.
        exercise_dropped = exercise_truncated and not pending_whiteboard
        if exercise_dropped:
            hint = (
                "\n\n_(Heads up — the practice exercise didn't finish "
                "loading. Say \"try again\" and I'll resend a shorter "
                "version.)_"
            )
            full_chat += hint
            yield _sse({"delta": hint})

        assistant = StudyMessage(
            session_id=session.id,
            role="assistant",
            content=full_chat,
        )
        db.add(assistant)
        await db.flush()

        # Persist any whiteboard exercises.
        emitted_exercises: list[WhiteboardExercise] = []
        for idx, wp in enumerate(pending_whiteboard):
            kind = str(wp.get("type", "")).lower()
            if kind != "exercise":
                logger.info("Ignoring unsupported whiteboard action type=%r", wp.get("type"))
                continue
            html = wp.get("html")
            if not isinstance(html, str) or not html.strip():
                logger.warning("Skipping whiteboard exercise with empty html")
                continue
            title = wp.get("title")
            exercise = WhiteboardExercise(
                session_id=session.id,
                message_id=assistant.id,
                title=str(title).strip()[:255] if isinstance(title, str) else None,
                html=html,
                status="active",
            )
            db.add(exercise)
            await db.flush()
            emitted_exercises.append(exercise)
            if idx == 0:
                assistant.exercise_id = exercise.id

        # Apply unit/exam side-channel captures.
        capture_result = await apply_captures(
            db=db,
            captures=pending_side_actions,
            project=project,
            unit=unit,
            session=session,
            exam=exam,
        )

        # If the tutor tried to close the unit but the gate rejected
        # it, inject a synthetic ``system`` message into the
        # transcript listing the unmet conditions. This is what makes
        # the completion gate self-correcting — the rejected list is
        # visible to the model on its very next turn so it knows
        # exactly which step it skipped.
        #
        # The frontend filters ``role == "system"`` rows out of the
        # visible transcript so the student never sees this nudge —
        # the wording below is therefore tuned for the *model*, not
        # the student. Keep it terse and instructional; if it ever
        # does leak (older client, server-rendered email digest,
        # etc.) it should still read as a benign internal note
        # rather than a scary "REJECTED" alert.
        mc_rejected = capture_result.get("mark_complete_rejected")
        if mc_rejected and unit is not None:
            unmet_text = "\n".join(f"- {item}" for item in mc_rejected.get("unmet") or [])
            nudge = (
                "Internal tutor note (not shown to the student): the "
                "completion gate didn't accept mark_complete yet. "
                "Outstanding requirements:\n"
                f"{unmet_text}\n"
                "Address each item before emitting mark_complete again. "
                "Don't mention this note in chat — just continue teaching."
            )
            # Belt-and-braces leak detector — the system prompt forbids
            # the model from writing celebratory / next-unit language on
            # the same turn it emits ``mark_complete``, because the gate
            # may reject and the student would be left looking at "Great
            # work, on to Unit 2!" while the unit silently stays open.
            # If the model violated that rule on this rejected turn,
            # surface the leak in the nudge so it self-corrects on the
            # next reply (and ideally walks back what it just said
            # without ever drawing attention to "the system" or "the
            # gate").
            if _has_closing_language(full_chat):
                nudge += (
                    "\n\n**You also used closing/celebratory language**"
                    " in your chat reply on this same turn (e.g."
                    " 'next unit', 'you're done', or a preview of the"
                    " next unit by name) even though the gate rejected"
                    " mark_complete. The student now sees a celebration"
                    " that isn't real. On your next reply, smoothly"
                    " walk it back by treating the unmet conditions as"
                    " the next teaching step — DO NOT apologise, do"
                    " NOT mention 'the gate' or 'the system', do NOT"
                    " say 'I jumped ahead'. Just pick up the missing"
                    " step (run the teach-back, ask for the confidence"
                    " rating, etc.) as if it were always part of the"
                    " plan."
                )
            db.add(
                StudyMessage(
                    session_id=session.id,
                    role="system",
                    content=nudge,
                )
            )

        # Tell the model (hidden from the student) that its exercise was
        # truncated so it resends a smaller one next turn instead of
        # repeating the overflow. Pairs with the visible recovery prompt
        # appended to ``full_chat`` above.
        if exercise_dropped:
            db.add(
                StudyMessage(
                    session_id=session.id,
                    role="system",
                    content=(
                        "Internal tutor note (not shown to the student): "
                        "your last <whiteboard_action> was cut off before "
                        "its closing tag, so the exercise did NOT render. "
                        "This usually means the reply ran past the response "
                        "budget. On your next reply, resend a SHORTER, "
                        "self-contained exercise and keep any lead-in to one "
                        "or two sentences so the full HTML fits. Don't "
                        "mention this note."
                    ),
                )
            )

        # Surface any captures the parser grabbed but couldn't parse, so
        # the tutor re-emits them in a parseable form instead of the
        # action silently vanishing. The biggest offender is a
        # ``<board_op .../>`` whose SVG/diagram payload contains ``/>``
        # (the self-closing parser stops at the first one and truncates
        # the JSON); the JSON-body ``<board_op>{...}</board_op>`` form is
        # immune, so that's what we steer the model toward.
        parse_failures = capture_result.get("parse_failures") or []
        if parse_failures:
            _PARSE_FIX_HINTS = {
                "board_op": (
                    "a board_op didn't parse — re-emit it as "
                    "<board_op>{\"op\":\"add\",\"kind\":\"...\","
                    "\"payload\":{...}}</board_op> (JSON between the tags). "
                    "Do NOT use the self-closing <board_op ... /> form: it "
                    "breaks whenever the payload contains '/>', e.g. an SVG "
                    "diagram."
                ),
                "unit_action": (
                    "a unit_action didn't parse — re-emit it as "
                    "<unit_action>{...valid JSON...}</unit_action>."
                ),
                "exam_action": (
                    "your exam_action (grade) didn't parse — re-emit it as "
                    "<exam_action>{...valid JSON...}</exam_action> so the "
                    "result is recorded."
                ),
            }
            lines = []
            for tag in dict.fromkeys(parse_failures):  # dedupe, keep order
                lines.append("- " + _PARSE_FIX_HINTS.get(
                    tag,
                    f"a {tag} didn't parse — re-emit it as valid JSON "
                    f"between <{tag}> and </{tag}>.",
                ))
            db.add(
                StudyMessage(
                    session_id=session.id,
                    role="system",
                    content=(
                        "Internal tutor note (not shown to the student): one "
                        "or more side-channel actions you emitted couldn't be "
                        "applied:\n" + "\n".join(lines) + "\nRe-emit them on "
                        "your next reply. Don't mention this note."
                    ),
                )
            )

        # Mark the exercise being reviewed as 'reviewed' and stash
        # feedback (the full assistant reply).
        if reviewing_exercise_id is not None:
            reviewed = await db.get(WhiteboardExercise, reviewing_exercise_id)
            if reviewed is not None and reviewed.session_id == session.id:
                reviewed.status = "reviewed"
                reviewed.ai_feedback = full_chat

        session.updated_at = datetime.now(timezone.utc)
        project.updated_at = session.updated_at
        await db.commit()
        await db.refresh(assistant)
        for ex in emitted_exercises:
            await db.refresh(ex)
        if unit is not None:
            await db.refresh(unit)
        if exam is not None:
            await db.refresh(exam)

        # Fire async assessor passes for every scored objective.
        # These run after commit so the student answers are visible
        # to the new session the assessor task opens. Fire-and-forget.
        for att in capture_result.get("mastery_attempts") or []:
            dispatch_assessor_if_configured(
                attempt_id=att["attempt_id"],
                session_id=att["session_id"],
                unit_id=att["unit_id"],
                objective_index=att["objective_index"],
                objective_text=att["objective_text"],
            )

        # Emit board_updated for every block the tutor just pinned.
        for block_info in capture_result.get("board_blocks_added") or []:
            yield _sse(
                {
                    "event": "board_updated",
                    "block": block_info,
                }
            )

        if exercise_dropped:
            yield _sse({"event": "exercise_error", "reason": "truncated"})

        for ex in emitted_exercises:
            yield _sse(
                {
                    "event": "exercise_ready",
                    "exercise": {
                        "id": str(ex.id),
                        "session_id": str(ex.session_id),
                        "message_id": str(ex.message_id) if ex.message_id else None,
                        "title": ex.title,
                        "html": ex.html,
                        "status": ex.status,
                        "created_at": ex.created_at.isoformat(),
                    },
                }
            )

        if reviewing_exercise_id is not None:
            yield _sse(
                {
                    "event": "exercise_reviewed",
                    "exercise_id": str(reviewing_exercise_id),
                }
            )

        inserted_units = capture_result.get("units_inserted") or []
        if inserted_units:
            yield _sse(
                {
                    "event": "units_inserted",
                    "units": inserted_units,
                    "reason": capture_result.get("reason"),
                    "before_unit_id": str(unit.id) if unit is not None else None,
                }
            )

        if capture_result.get("project_calibrated"):
            yield _sse(
                {
                    "event": "project_calibrated",
                    "project_id": str(project.id),
                }
            )

        calibration_warning = capture_result.get("calibration_warning")
        if calibration_warning:
            yield _sse(
                {
                    "event": "calibration_warning",
                    "project_id": str(project.id),
                    "reason": calibration_warning.get("reason"),
                    "batch_id": calibration_warning.get("batch_id"),
                }
            )

        if capture_result.get("unit_completed") and unit is not None:
            yield _sse(
                {
                    "event": "unit_completed",
                    "unit": {
                        "id": str(unit.id),
                        "status": unit.status,
                        "mastery_score": unit.mastery_score,
                        "mastery_summary": unit.mastery_summary,
                        "completed_at": unit.completed_at.isoformat()
                        if unit.completed_at
                        else None,
                    },
                }
            )

        mc_rejected_event = capture_result.get("mark_complete_rejected")
        if mc_rejected_event and unit is not None:
            yield _sse(
                {
                    "event": "mark_complete_rejected",
                    "unit_id": str(unit.id),
                    "unmet": mc_rejected_event.get("unmet") or [],
                    "score": mc_rejected_event.get("score"),
                }
            )

        # Durable-state invalidation events so the frontend can refresh
        # the Learner profile panel / objective mastery list / etc.
        # without polling.
        state_changed: list[str] = []
        if capture_result.get("learner_profile_updated"):
            state_changed.append("learner_profile")
        if capture_result.get("mastery_updated"):
            state_changed.append("objective_mastery")
        if capture_result.get("misconceptions_changed"):
            state_changed.append("misconceptions")
        if capture_result.get("reflection_written"):
            state_changed.append("reflections")
        if capture_result.get("session_goal_set"):
            state_changed.append("session_goal")
        if state_changed:
            yield _sse(
                {
                    "event": "study_state_updated",
                    "project_id": str(project.id),
                    # Key name mirrors the SSEPayload.changes contract
                    # the frontend hook reads — keeping them in lockstep
                    # avoids falling back to the broad-invalidate path.
                    "changes": state_changed,
                }
            )

        if capture_result.get("exam_applied") and exam is not None:
            yield _sse(
                {
                    "event": "exam_graded",
                    "exam": {
                        "id": str(exam.id),
                        "status": exam.status,
                        "passed": exam.passed,
                        "score": exam.score,
                        "summary": exam.summary,
                        "weak_unit_ids": [str(x) for x in (exam.weak_unit_ids or [])],
                        "strong_unit_ids": [
                            str(x) for x in (exam.strong_unit_ids or [])
                        ],
                        "ended_at": exam.ended_at.isoformat() if exam.ended_at else None,
                    },
                }
            )
            # Push for users who stepped away during grading — the
            # exam can take 15–30 s of model time on a long topic,
            # plenty for the student to alt-tab. Tag so a re-grade
            # replaces the previous notification.
            try:
                from app.notifications import notify_user

                score_line = (
                    f"{int(round(exam.score))}%"
                    if exam.score is not None
                    else "result in"
                )
                verdict = "Passed" if exam.passed else "Not yet"
                await notify_user(
                    user_id=project.user_id,
                    category="study_graded",
                    title=f"{verdict} — {project.title}",
                    body=f"Final exam graded: {score_line}.",
                    url=f"/study/{project.id}",
                    tag=f"promptly-exam-{exam.id}",
                )
            except Exception:  # pragma: no cover — push is never critical
                logging.getLogger("promptly.study.push").warning(
                    "push-dispatch-failed", exc_info=True
                )

        yield _sse(
            {
                "done": True,
                "message_id": str(assistant.id),
                "created_at": assistant.created_at.isoformat(),
                # Phase 2: expose current phase so the frontend can
                # render the arc rail and highlight the active beat.
                "phase": session.phase,
            }
        )


@router.get("/sessions/{session_id}/stream/{stream_id}")
async def stream_response(
    session_id: uuid.UUID,
    stream_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    _ = session_id
    return StreamingResponse(
        _stream_generator(stream_id, user, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ====================================================================
# Unit notes (plain-text scratchpad)
# ====================================================================
@router.get(
    "/sessions/{session_id}/notes",
    response_model=NotesState,
)
async def get_notes(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NotesState:
    session, _ = await _get_owned_session(session_id, user, db)
    return NotesState(
        notes=session.notes_md,
        updated_at=session.updated_at,
    )


@router.post(
    "/sessions/{session_id}/notes/update",
    response_model=NotesState,
)
async def update_notes(
    session_id: uuid.UUID,
    payload: NotesUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NotesState:
    session, _ = await _get_owned_session(session_id, user, db)
    session.notes_md = payload.notes
    session.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(session)
    return NotesState(
        notes=session.notes_md,
        updated_at=session.updated_at,
    )


# ====================================================================
# Lesson board (Phase 3 — evolving canvas)
# ====================================================================
@router.get(
    "/sessions/{session_id}/board",
    response_model=list[StudyBoardBlockResponse],
)
async def get_board_blocks(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[StudyBoardBlockResponse]:
    """Return all board blocks for a session, ordered oldest-first."""
    from app.study.models import StudyBoardBlock

    session, _ = await _get_owned_session(session_id, user, db)
    stmt = (
        select(StudyBoardBlock)
        .where(StudyBoardBlock.session_id == session.id)
        .order_by(StudyBoardBlock.order_index.asc())
    )
    rows = list((await db.execute(stmt)).scalars().all())
    return [
        StudyBoardBlockResponse(
            id=b.id,
            session_id=b.session_id,
            order_index=b.order_index,
            kind=b.kind,
            payload=b.payload_json,
            created_at=b.created_at,
        )
        for b in rows
    ]


# ====================================================================
# Session arc (Phase 3 — phase rail + objective promises)
# ====================================================================
@router.get(
    "/sessions/{session_id}/arc",
    response_model=SessionArcResponse,
)
async def get_session_arc(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SessionArcResponse:
    """Phase plan + per-objective mastery for the arc rail component."""
    session, _ = await _get_owned_session(session_id, user, db)
    unit: StudyUnit | None = (
        await db.get(StudyUnit, session.unit_id)
        if session.unit_id is not None
        else None
    )

    objectives: list[SessionArcObjective] = []
    if unit is not None:
        mastery_rows: list[StudyObjectiveMastery] = list(
            (
                await db.execute(
                    select(StudyObjectiveMastery)
                    .where(StudyObjectiveMastery.unit_id == unit.id)
                    .order_by(StudyObjectiveMastery.objective_index.asc())
                )
            )
            .scalars()
            .all()
        )
        mastery_by_index = {m.objective_index: m for m in mastery_rows}
        for idx, text in enumerate(unit.learning_objectives or []):
            row = mastery_by_index.get(idx)
            score = row.mastery_score if row is not None else None
            mastered = score is not None and score >= study_config.MASTERY_FLOOR
            objectives.append(
                SessionArcObjective(
                    index=idx,
                    text=text,
                    mastery_score=score,
                    mastered=mastered,
                )
            )

    total_objectives = len(objectives)
    current_objective_index: int | None = None
    for obj in objectives:
        if not obj.mastered:
            current_objective_index = obj.index
            break

    return SessionArcResponse(
        phase=session.phase,
        phase_history=list(session.phase_history or []),
        objectives=objectives,
        total_objectives=total_objectives,
        current_objective_index=current_objective_index,
    )


# ====================================================================
# Session goal (P1-A)
# ====================================================================
@router.patch(
    "/sessions/{session_id}/goal",
    response_model=SessionGoalUpdate,
)
async def set_session_goal(
    session_id: uuid.UUID,
    body: SessionGoalUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SessionGoalUpdate:
    """Set (or clear) the student's personal goal for a session."""
    session, _ = await _get_owned_session(session_id, user, db)
    goal = body.session_goal.strip() if body.session_goal else None
    session.session_goal = goal
    session.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return SessionGoalUpdate(session_goal=session.session_goal)


# ====================================================================
# Assessor health (P1-C — admin only)
# ====================================================================
@router.get(
    "/assessor-status",
    response_model=AssessorStatusResponse,
)
async def get_assessor_status(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AssessorStatusResponse:
    """Coverage stats for the independent assessor model (admin only)."""
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    configured = bool(settings and settings.study_assessor_configured)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    total_result = await db.execute(
        select(func.count()).where(StudyRetrievalAttempt.created_at >= cutoff)
    )
    total_24h: int = total_result.scalar_one() or 0

    assessor_result = await db.execute(
        select(func.count()).where(
            StudyRetrievalAttempt.created_at >= cutoff,
            StudyRetrievalAttempt.source_kind == "assessor",
        )
    )
    assessor_24h: int = assessor_result.scalar_one() or 0

    return AssessorStatusResponse(
        configured=configured,
        total_attempts_24h=total_24h,
        assessor_attempts_24h=assessor_24h,
    )


# ====================================================================
# Session timeline (P2-C — phase history per session)
# ====================================================================
@router.get(
    "/projects/{project_id}/session-timeline",
    response_model=list[SessionTimelineEntry],
)
async def get_session_timeline(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SessionTimelineEntry]:
    """Phase progression for recent unit sessions — drives the timeline in InsightDashboard."""
    project = await _get_owned_project(project_id, user, db)

    sessions: list[StudySession] = list(
        (
            await db.execute(
                select(StudySession)
                .where(
                    StudySession.project_id == project.id,
                    StudySession.kind == "unit",
                    StudySession.unit_id.isnot(None),
                )
                .order_by(StudySession.updated_at.desc())
                .limit(10)
            )
        )
        .scalars()
        .all()
    )

    # Fetch unit titles in one query.
    unit_ids = list({s.unit_id for s in sessions if s.unit_id})
    unit_title_map: dict[uuid.UUID, str] = {}
    if unit_ids:
        rows = (
            await db.execute(
                select(StudyUnit.id, StudyUnit.title).where(StudyUnit.id.in_(unit_ids))
            )
        ).all()
        unit_title_map = {r.id: r.title for r in rows}

    return [
        SessionTimelineEntry(
            session_id=s.id,
            unit_id=s.unit_id,
            unit_title=unit_title_map.get(s.unit_id, "Unknown unit") if s.unit_id else "Unknown unit",
            started_at=s.created_at,
            updated_at=s.updated_at,
            student_turn_count=s.student_turn_count or 0,
            teachback_passed=s.teachback_passed_at is not None,
            phase_history=list(s.phase_history or []),
        )
        for s in sessions
    ]


# ====================================================================
# Calibration history (Phase 4 #18 — confidence vs. correctness)
# ====================================================================
@router.get(
    "/projects/{project_id}/calibration-history",
    response_model=CalibrationHistoryResponse,
)
async def get_calibration_history(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CalibrationHistoryResponse:
    """Return all retrieval attempts with confidence + correctness data.

    Powers the Calibration Chart in the LessonBoard Insights tab —
    plots self-reported confidence (1-5) against measured correctness
    so the student can see Dunning-Kruger patterns in their own data.
    Returns at most 200 data points (newest first for recency) to
    keep the chart readable.
    """
    from app.study.models import StudyRetrievalAttempt

    project = await _get_owned_project(project_id, user, db)

    # Load units for this project to resolve titles.
    units_stmt = select(StudyUnit).where(StudyUnit.project_id == project.id)
    units = list((await db.execute(units_stmt)).scalars().all())
    unit_title_map = {u.id: u.title for u in units}

    stmt = (
        select(StudyRetrievalAttempt)
        .where(
            StudyRetrievalAttempt.unit_id.in_([u.id for u in units]),
        )
        .order_by(StudyRetrievalAttempt.created_at.desc())
        .limit(200)
    )
    rows = list((await db.execute(stmt)).scalars().all())

    data_points = [
        CalibrationDataPoint(
            attempt_id=r.id,
            unit_title=unit_title_map.get(r.unit_id, "Unknown unit"),
            objective_index=r.objective_index,
            phase=r.phase,
            confidence=r.confidence,
            correct=r.correct,
            created_at=r.created_at,
        )
        for r in rows
    ]
    return CalibrationHistoryResponse(
        project_id=project.id,
        data_points=data_points,
    )


@router.post(
    "/projects/{project_id}/quick-review",
    response_model=QuickReviewResponse,
)
async def quick_review(
    project_id: uuid.UUID,
    body: QuickReviewRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> QuickReviewResponse:
    """Grade a standalone review attempt and update SM-2 scheduling.

    Used by the daily review loop — no session required. The assessor
    model grades the answer if configured; otherwise the caller may pass
    ``self_correct`` for a student-graded round-trip. If neither is
    available, SM-2 is not updated and ``correct`` is null.
    """
    project = await _get_owned_project(project_id, user, db)

    # Verify the objective belongs to this project.
    mastery_row = await db.get(StudyObjectiveMastery, body.objective_id)
    if mastery_row is None:
        raise HTTPException(status_code=404, detail="Objective not found.")

    unit = await db.get(StudyUnit, mastery_row.unit_id)
    if unit is None or unit.project_id != project.id:
        raise HTTPException(status_code=404, detail="Objective not found.")

    # Grade the answer.
    grade_result = await grade_for_review(
        db, mastery_row.objective_text, body.answer
    ) if body.answer.strip() else None

    assessor_unavailable = grade_result is None and not body.answer.strip() is False
    if grade_result is not None:
        correct: bool | None = grade_result[0]
        feedback: str = grade_result[1]
        assessor_unavailable = False
    elif body.self_correct is not None:
        correct = body.self_correct
        feedback = ""
        assessor_unavailable = True
    else:
        correct = None
        feedback = ""
        assessor_unavailable = True

    # Record the attempt (session_id is nullable since migration 0078).
    attempt = StudyRetrievalAttempt(
        session_id=None,
        unit_id=mastery_row.unit_id,
        objective_index=mastery_row.objective_index,
        phase="review",
        correct=correct,
        confidence=body.confidence,
        source_kind="review" if grade_result is not None else "self",
    )
    db.add(attempt)

    # Update SM-2 only when we have a definitive grade.
    if correct is not None:
        recent = await study_review.recent_attempts_for_objective(
            db, mastery_row.unit_id, mastery_row.objective_index
        )
        derived_score, derived_success = study_review.derive_mastery_from_attempts(
            [attempt] + recent, fallback_score=mastery_row.mastery_score
        )
        study_review.schedule_next_review(
            mastery_row, success=derived_success, score=derived_score
        )

        # Re-average unit-level mastery.
        if unit.status != "completed":
            all_rows_stmt = select(StudyObjectiveMastery).where(
                StudyObjectiveMastery.unit_id == unit.id
            )
            all_rows = list((await db.execute(all_rows_stmt)).scalars().all())
            if all_rows:
                unit.mastery_score = int(
                    round(sum(r.mastery_score for r in all_rows) / len(all_rows))
                )

    await db.commit()

    # Count remaining due items.
    remaining_rows = await study_review.compute_due(db, project.id)
    items_remaining = len(remaining_rows)

    return QuickReviewResponse(
        correct=correct,
        feedback=feedback,
        new_mastery_score=mastery_row.mastery_score / 100,
        items_remaining=items_remaining,
        assessor_unavailable=assessor_unavailable,
    )


# ====================================================================
# Whiteboard exercises
# ====================================================================
@router.get(
    "/sessions/{session_id}/exercises",
    response_model=list[WhiteboardExerciseSummary],
)
async def list_exercises(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[WhiteboardExerciseSummary]:
    session, _ = await _get_owned_session(session_id, user, db)
    result = await db.execute(
        select(WhiteboardExercise)
        .where(WhiteboardExercise.session_id == session.id)
        .order_by(WhiteboardExercise.created_at.desc())
    )
    return [WhiteboardExerciseSummary.model_validate(e) for e in result.scalars().all()]


@router.get(
    "/sessions/{session_id}/exercises/{exercise_id}",
    response_model=WhiteboardExerciseDetail,
)
async def get_exercise(
    session_id: uuid.UUID,
    exercise_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WhiteboardExerciseDetail:
    session, _ = await _get_owned_session(session_id, user, db)
    exercise = await db.get(WhiteboardExercise, exercise_id)
    if exercise is None or exercise.session_id != session.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )
    return WhiteboardExerciseDetail.model_validate(exercise)


# --- Sandboxed iframe delivery -------------------------------------
# AI-authored exercise HTML can't be rendered via ``srcDoc`` because
# the SPA's strict CSP (``script-src 'self'``) is inherited by srcdoc
# iframes and would block every inline ``<script>`` block the AI
# generates — including the glue code that wires Sortable to the DOM
# and defines ``window.collectAnswers``. These two endpoints serve the
# HTML from a dedicated URL whose response CSP allows inline scripts
# (see ``location /api/study/exercise-frame/`` in ``nginx.conf``),
# while the signed-token indirection keeps the frame endpoint
# auth-free so the browser's iframe loader (which can't attach a
# Bearer header) can still reach it.


async def _require_owned_exercise(
    exercise_id: uuid.UUID, user: User, db: AsyncSession
) -> WhiteboardExercise:
    """Verify the current user owns ``exercise_id`` — 404 otherwise."""
    exercise = await db.get(WhiteboardExercise, exercise_id)
    if exercise is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )
    session = await db.get(StudySession, exercise.session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )
    project = await db.get(StudyProject, session.project_id)
    if project is None or project.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )
    return exercise


@router.post("/exercises/{exercise_id}/frame-token")
async def create_exercise_frame_token(
    exercise_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Return a signed, short-lived URL the SPA can use as an iframe ``src``.

    Proof of ownership happens here, while we have the authenticated
    user. The token binds the user, the exercise, and a 2-minute
    expiry together with HMAC-SHA256 over ``SECRET_KEY``.
    """
    await _require_owned_exercise(exercise_id, user, db)
    token = sign_exercise_frame_token(user_id=user.id, exercise_id=exercise_id)
    return {
        "token": token,
        "url": f"/api/study/exercise-frame/{exercise_id}?t={token}",
    }


@router.get("/exercise-frame/{exercise_id}")
async def serve_exercise_frame(
    exercise_id: uuid.UUID,
    t: str = Query(..., description="Signed token from /frame-token"),
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Serve exercise HTML for in-iframe rendering.

    This endpoint is intentionally unauthenticated (no
    ``get_current_user`` dependency) because the browser's iframe
    loader cannot attach an ``Authorization`` header. Authorisation
    comes from the HMAC-signed ``t`` query parameter; a mismatch
    between the token's exercise id and the URL's returns 403.

    The response CSP is loosened by nginx for this path — see the
    ``location /api/study/exercise-frame/`` block in ``nginx.conf``.
    """
    claims = verify_exercise_frame_token(t)
    if claims is None or claims.exercise_id != exercise_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid or expired exercise token",
        )
    exercise = await db.get(WhiteboardExercise, exercise_id)
    if exercise is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )
    html = inject_submit_shim(exercise.html or "")
    return HTMLResponse(content=html)


@router.post(
    "/sessions/{session_id}/whiteboard/submit",
    response_model=WhiteboardSubmitResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_exercise(
    session_id: uuid.UUID,
    payload: WhiteboardSubmitRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WhiteboardSubmitResponse:
    session, project = await _get_owned_session(session_id, user, db)

    if project.status == "archived":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This topic is archived — unarchive it first.",
        )

    exercise = await db.get(WhiteboardExercise, payload.exercise_id)
    if exercise is None or exercise.session_id != session.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )

    provider, model_id = await _load_study_provider(db, user, project)

    now = datetime.now(timezone.utc)
    exercise.status = "submitted"
    exercise.answer_payload = payload.answers
    exercise.submitted_at = now

    user_msg = StudyMessage(
        session_id=session.id,
        role="user",
        content=format_submission_user_message(exercise, payload.answers),
    )
    db.add(user_msg)
    session.updated_at = now
    project.updated_at = now
    await db.commit()
    await db.refresh(user_msg)
    await db.refresh(exercise)

    stream_id = uuid.uuid4()
    ctx: StudyStreamContext = {
        "session_id": str(session.id),
        "project_id": str(project.id),
        "user_message_id": str(user_msg.id),
        "provider_id": str(provider.id),
        "model_id": model_id,
        "temperature": 0.7,
        # Review turns carry both the feedback prose AND a freshly
        # re-presented exercise (often a 2–3k-token HTML block). 4096
        # routinely truncated the reply mid-``<whiteboard_action>``, so
        # the closing tag never arrived and the exercise was silently
        # dropped — the board went blank after a wrong answer. Give the
        # turn real headroom.
        "max_tokens": 8000,
        "reviewing_exercise_id": str(exercise.id),
        "session_kind": session.kind or "legacy",
        "unit_id": str(session.unit_id) if session.unit_id else None,
        "exam_id": str(session.exam_id) if session.exam_id else None,
    }
    await enqueue_stream(stream_id, ctx)

    return WhiteboardSubmitResponse(
        stream_id=stream_id,
        user_message=StudyMessageResponse.model_validate(user_msg),
        exercise=WhiteboardExerciseSummary.model_validate(exercise),
    )


# Keep the scaffold ping for sanity checks.
@router.get("/_ping")
async def ping() -> dict[str, str]:
    return {"module": "study", "status": "ready"}
