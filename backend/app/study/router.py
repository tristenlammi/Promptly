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
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import SessionLocal, get_db
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.study import review as study_review
from app.study.config import min_turns_required as study_min_turns_required
from app.study.models import (
    StudyExam,
    StudyMessage,
    StudyMisconception,
    StudyObjectiveMastery,
    StudyProject,
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
from app.study.schemas import (
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
    WhiteboardExerciseDetail,
    WhiteboardExerciseSummary,
    WhiteboardSubmitRequest,
    WhiteboardSubmitResponse,
)
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
    if (
        model_id is not None
        and user.role != "admin"
        and user.allowed_models is not None
        and model_id not in set(user.allowed_models)
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


def _unit_summary(unit: StudyUnit) -> StudyUnitSummary:
    """Build a ``StudyUnitSummary`` with the derived ``days_since_studied``
    field filled in. Pulled out so the detail endpoint and the unit
    ``enter`` endpoint share the same computation."""
    payload = {
        col.name: getattr(unit, col.name) for col in unit.__table__.columns
    }
    payload["days_since_studied"] = days_since_studied(unit)
    return StudyUnitSummary.model_validate(payload)


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
            "units": [_unit_summary(u) for u in units],
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
    provider = await db.get(ModelProvider, payload.provider_id)
    await _resolve_provider(provider, user, db, model_id=payload.model_id)
    assert provider is not None  # Appeases the type-checker; _resolve_provider raises otherwise.

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
    )
    db.add(project)
    await db.flush()

    try:
        await generate_and_apply_plan(
            db=db,
            project=project,
            provider=provider,
            model_id=payload.model_id,
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
    return await _project_detail(project, db)


@router.get("/projects/{project_id}", response_model=StudyProjectDetail)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectDetail:
    project = await _get_owned_project(project_id, user, db)
    return await _project_detail(project, db)


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

    model_id = payload.model_id or project.model_id
    provider_id = payload.provider_id or project.planning_provider_id
    if not model_id or not provider_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provider and model must be set before regenerating a plan.",
        )
    provider = await db.get(ModelProvider, provider_id)
    await _resolve_provider(provider, user, db, model_id=model_id)
    assert provider is not None

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

    # Resolve a model + provider ONLY if we're actually going to
    # kickoff — avoids failing the enter call when the project
    # doesn't have a model set yet and the student just wants to
    # browse the existing transcript.
    kickoff_stream_id: uuid.UUID | None = None
    if should_kickoff and project.model_id:
        try:
            provider = await _pick_provider_for_model(project.model_id, user, db)
        except HTTPException:
            provider = None
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
                "model_id": project.model_id,
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

    model_id = payload.model_id or project.model_id
    if not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No model configured for this topic — set one and retry.",
        )
    provider_id = payload.provider_id or project.planning_provider_id
    if provider_id is None:
        provider = await _pick_provider_for_model(model_id, user, db)
    else:
        provider = await db.get(ModelProvider, provider_id)
        await _resolve_provider(provider, user, db, model_id=model_id)
        assert provider is not None

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

    provider_id = payload.provider_id
    model_id = payload.model_id or project.model_id
    if provider_id is None or not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model configured for this study session. "
                "Send provider_id + model_id in the request."
            ),
        )
    provider = await db.get(ModelProvider, provider_id)
    await _resolve_provider(provider, user, db, model_id=model_id)
    assert provider is not None

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

    stream_id = uuid.uuid4()
    ctx: StudyStreamContext = {
        "session_id": str(session.id),
        "project_id": str(project.id),
        "user_message_id": str(user_msg.id),
        "provider_id": str(provider_id),
        "model_id": model_id,
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
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
            # Commit the seeding changes so the transaction stays
            # tidy even if the LLM call downstream fails.
            await db.commit()
            system_prompt = build_unit_system_prompt(
                project=project,
                unit=unit,
                all_units=all_units,
                mastery_rows=mastery_rows,
                recent_reflections=recent_reflections,
                open_misconceptions=open_misconceptions,
                review_queue=review_queue,
                review_focus=review_focus,
            )
            allowed_tags = ["whiteboard_action", "unit_action"]
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

        tail = parser.flush()
        if tail:
            chat_parts.append(tail)
            yield _sse({"delta": tail})

        full_chat = "".join(chat_parts)
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
            db.add(
                StudyMessage(
                    session_id=session.id,
                    role="system",
                    content=nudge,
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

    model_id = project.model_id
    if not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model is associated with this study project yet — "
                "send a chat message first."
            ),
        )
    provider = await _pick_provider_for_model(model_id, user, db)

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
        "max_tokens": 4096,
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
