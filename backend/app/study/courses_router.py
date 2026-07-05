"""Team Learning (Study L1) — workspace courses + enrollments.

The authoring side of the collab pivot (docs/study-collab-plan.md): a
lead drafts a course from workspace materials with the AI, edits the
blueprint, publishes it, and enrols workspace members. Enrolment
materialises a per-learner :class:`StudyProject` from the blueprint so
the entire existing tutor engine (orchestrator, SM-2, gates, exams)
runs unchanged.

Permissions: authoring (create/edit/publish/enrol) requires workspace
write access (owner or editor); any accepted member can be enrolled and
can view the published course list.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.chat.models import WorkspaceShare
from app.custom_models.embedding import (
    extract_text_for_embedding,
    is_text_extractable,
)
from app.database import SessionLocal, get_db
from app.files.models import UserFile
from app.models_config.models import ModelProvider
from app.study import review as study_review
from app.study.materials import index_material_for_study_project
from app.study.models import (
    StudyCourse,
    StudyCourseUnit,
    StudyEnrollment,
    StudyMaterial,
    StudyProject,
    StudyUnit,
)
from app.study.planner import (
    PLANNING_PROGRESS,
    PlanGenerationError,
    generate_plan,
)
from app.workspaces.shares import (
    get_accessible_workspace,
    require_workspace_write,
)

logger = logging.getLogger("promptly.study.courses")

router = APIRouter()

# Difficulty presets mirror the learner-side levels so the materialised
# project drops straight into the existing pacing logic.
_VALID_PRESETS = {"beginner", "some_exposure", "refresher"}
# Cap of raw material text fed to the drafting planner (same budget the
# personal wizard uses).
_DRAFT_MAX_CHARS = 8_000


# ====================================================================
# Schemas
# ====================================================================
class CourseUnitPayload(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    learning_objectives: list[str] = Field(default_factory=list)
    source_file_ids: list[str] = Field(default_factory=list)


class CourseUnitResponse(CourseUnitPayload):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    order_index: int


class CourseCreate(BaseModel):
    workspace_id: uuid.UUID
    title: str = Field(min_length=1, max_length=255)
    brief: str = Field(min_length=20)
    difficulty_preset: str | None = None
    source_file_ids: list[str] = Field(default_factory=list)
    # Draft the blueprint with the AI right away (background, polled).
    draft_with_ai: bool = True


class CourseUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    brief: str | None = Field(default=None, min_length=20)
    difficulty_preset: str | None = None
    source_file_ids: list[str] | None = None
    unit_mastery_floor: int | None = Field(default=None, ge=50, le=100)
    exam_pass_score: int | None = Field(default=None, ge=50, le=100)


class CourseSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    brief: str
    difficulty_preset: str | None
    status: str
    unit_count: int = 0
    enrollment_count: int = 0
    drafting_error: str | None = None
    published_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class CourseDetail(CourseSummary):
    source_file_ids: list[str] = Field(default_factory=list)
    unit_mastery_floor: int = 75
    exam_pass_score: int = 70
    units: list[CourseUnitResponse] = Field(default_factory=list)


class CourseDraftProgress(BaseModel):
    """Poll target while the AI drafts the blueprint (reuses the L0.3
    planning registry, keyed by course id)."""

    status: str  # draft | published | archived
    drafting: bool
    stage: str | None
    units_drafted: int
    unit_count: int
    error: str | None


class EnrollRequest(BaseModel):
    user_id: uuid.UUID
    due_at: datetime | None = None


class EnrollmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    course_id: uuid.UUID
    learner_user_id: uuid.UUID
    learner_name: str | None = None
    assigned_by: uuid.UUID | None
    project_id: uuid.UUID
    due_at: datetime | None
    status: str
    created_at: datetime


# ====================================================================
# Helpers
# ====================================================================
async def _get_course_for_author(
    course_id: uuid.UUID, user: User, db: AsyncSession
) -> StudyCourse:
    """The course, with write access to its workspace enforced."""
    course = await db.get(StudyCourse, course_id)
    if course is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Course not found."
        )
    _ws, role = await get_accessible_workspace(course.workspace_id, user, db)
    require_workspace_write(role)
    return course


async def _course_units(
    db: AsyncSession, course_id: uuid.UUID
) -> list[StudyCourseUnit]:
    res = await db.execute(
        select(StudyCourseUnit)
        .where(StudyCourseUnit.course_id == course_id)
        .order_by(StudyCourseUnit.order_index)
    )
    return list(res.scalars().all())


async def _counts_for_courses(
    db: AsyncSession, course_ids: list[uuid.UUID]
) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, int]]:
    if not course_ids:
        return {}, {}
    unit_rows = await db.execute(
        select(StudyCourseUnit.course_id, func.count())
        .where(StudyCourseUnit.course_id.in_(course_ids))
        .group_by(StudyCourseUnit.course_id)
    )
    enr_rows = await db.execute(
        select(StudyEnrollment.course_id, func.count())
        .where(StudyEnrollment.course_id.in_(course_ids))
        .group_by(StudyEnrollment.course_id)
    )
    return dict(unit_rows.all()), dict(enr_rows.all())


def _summary(
    course: StudyCourse, unit_count: int, enrollment_count: int
) -> CourseSummary:
    return CourseSummary(
        id=course.id,
        workspace_id=course.workspace_id,
        title=course.title,
        brief=course.brief,
        difficulty_preset=course.difficulty_preset,
        status=course.status,
        unit_count=unit_count,
        enrollment_count=enrollment_count,
        drafting_error=course.drafting_error,
        published_at=course.published_at,
        created_at=course.created_at,
        updated_at=course.updated_at,
    )


async def _detail(db: AsyncSession, course: StudyCourse) -> CourseDetail:
    units = await _course_units(db, course.id)
    _, enr = await _counts_for_courses(db, [course.id])
    return CourseDetail(
        id=course.id,
        workspace_id=course.workspace_id,
        title=course.title,
        brief=course.brief,
        difficulty_preset=course.difficulty_preset,
        status=course.status,
        unit_count=len(units),
        enrollment_count=enr.get(course.id, 0),
        drafting_error=course.drafting_error,
        published_at=course.published_at,
        created_at=course.created_at,
        updated_at=course.updated_at,
        source_file_ids=list(course.source_file_ids or []),
        unit_mastery_floor=course.unit_mastery_floor,
        exam_pass_score=course.exam_pass_score,
        units=[
            CourseUnitResponse(
                id=u.id,
                order_index=u.order_index,
                title=u.title,
                description=u.description,
                learning_objectives=list(u.learning_objectives or []),
                source_file_ids=list(u.source_file_ids or []),
            )
            for u in units
        ],
    )


async def _extract_source_text(
    db: AsyncSession, workspace_id: uuid.UUID, file_ids: list[str]
) -> str:
    """Raw text of the course's source files for the drafting planner.

    Only workspace-visible files count — a file id from outside the
    workspace is silently skipped rather than leaking foreign content.
    """
    parts: list[str] = []
    remaining = _DRAFT_MAX_CHARS
    for fid in file_ids:
        try:
            file_uuid = uuid.UUID(fid)
        except ValueError:
            continue
        uf = await db.get(UserFile, file_uuid)
        if uf is None or not is_text_extractable(uf):
            continue
        try:
            text = extract_text_for_embedding(uf)
        except Exception:  # noqa: BLE001 — a bad file shouldn't kill the draft
            continue
        if not text:
            continue
        trimmed = text[:remaining]
        label = uf.original_filename or uf.filename or "material"
        parts.append(f"[{label}]\n{trimmed}")
        remaining -= len(trimmed)
        if remaining <= 0:
            break
    return "\n\n---\n\n".join(parts)


async def _resolve_drafting_model(
    db: AsyncSession,
) -> tuple[ModelProvider, str]:
    """The model that drafts course blueprints — same resolution as the
    personal planner (admin study model → default chat)."""
    from app.app_settings.defaults import load_effective_defaults

    settings = await load_effective_defaults(db)
    candidates = [
        (settings.study_provider_id, settings.study_model_id),
        (settings.default_chat_provider_id, settings.default_chat_model_id),
    ]
    for provider_id, model_id in candidates:
        if not provider_id or not model_id:
            continue
        provider = await db.get(ModelProvider, provider_id)
        if provider is not None and provider.enabled:
            return provider, model_id
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=(
            "No teaching model is configured. Set one in Admin → Settings "
            "→ Defaults before drafting a course."
        ),
    )


async def _draft_course_task(
    course_id: uuid.UUID, provider_id: uuid.UUID, model_id: str
) -> None:
    """Background: draft the course blueprint with the planner (L0.3-style
    progress registry, keyed by the course id)."""
    try:
        async with SessionLocal() as db:
            course = await db.get(StudyCourse, course_id)
            provider = await db.get(ModelProvider, provider_id)
            if course is None or provider is None:
                return
            prog = PLANNING_PROGRESS.setdefault(course_id, {})
            prog.update({"stage": "reading", "units_drafted": 0})
            material = await _extract_source_text(
                db, course.workspace_id, list(course.source_file_ids or [])
            )
            prog["stage"] = "drafting"
            try:
                plan = await generate_plan(
                    provider=provider,
                    model_id=model_id,
                    title=course.title,
                    learning_request=course.brief,
                    goal=None,
                    topics=[],
                    current_level=course.difficulty_preset,
                    material_context=material or None,
                    progress=prog,
                )
            except PlanGenerationError as exc:
                course.drafting_error = str(exc)[:500]
                await db.commit()
                return
            prog["stage"] = "building"
            # Replace any existing blueprint rows (redraft).
            for existing in await _course_units(db, course_id):
                await db.delete(existing)
            for idx, unit in enumerate(plan.units):
                db.add(
                    StudyCourseUnit(
                        course_id=course_id,
                        order_index=idx,
                        title=unit.title,
                        description=unit.description,
                        learning_objectives=list(unit.learning_objectives or []),
                    )
                )
            course.drafting_error = None
            course.updated_at = datetime.now(timezone.utc)
            await db.commit()
    except Exception:  # noqa: BLE001 — record, never crash the loop
        logger.exception("course draft task crashed course=%s", course_id)
        try:
            async with SessionLocal() as err_db:
                course = await err_db.get(StudyCourse, course_id)
                if course is not None:
                    course.drafting_error = (
                        "Unexpected error while drafting — try again."
                    )
                    await err_db.commit()
        except Exception:  # noqa: BLE001
            pass
    finally:
        PLANNING_PROGRESS.pop(course_id, None)


# ====================================================================
# Authoring CRUD
# ====================================================================
@router.post("/courses", response_model=CourseDetail, status_code=201)
async def create_course(
    payload: CourseCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDetail:
    _ws, role = await get_accessible_workspace(payload.workspace_id, user, db)
    require_workspace_write(role)
    if payload.difficulty_preset and payload.difficulty_preset not in _VALID_PRESETS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"difficulty_preset must be one of {sorted(_VALID_PRESETS)}",
        )
    # Resolve the drafting model up front so a model-less install fails the
    # request with a clear message instead of a background error.
    provider, model_id = await _resolve_drafting_model(db)

    course = StudyCourse(
        workspace_id=payload.workspace_id,
        created_by=user.id,
        title=payload.title.strip(),
        brief=payload.brief.strip(),
        difficulty_preset=payload.difficulty_preset,
        source_file_ids=[s for s in payload.source_file_ids if s.strip()],
        status="draft",
    )
    db.add(course)
    await db.commit()
    await db.refresh(course)

    if payload.draft_with_ai:
        PLANNING_PROGRESS.setdefault(
            course.id, {"stage": "reading", "units_drafted": 0}
        )
        asyncio.create_task(
            _draft_course_task(course.id, provider.id, model_id),
            name=f"course-draft-{course.id}",
        )
    return await _detail(db, course)


@router.get("/courses", response_model=list[CourseSummary])
async def list_courses(
    workspace_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CourseSummary]:
    """Courses in a workspace. Any member sees them; editing needs write."""
    await get_accessible_workspace(workspace_id, user, db)
    res = await db.execute(
        select(StudyCourse)
        .where(StudyCourse.workspace_id == workspace_id)
        .order_by(StudyCourse.created_at.desc())
    )
    courses = list(res.scalars().all())
    unit_counts, enr_counts = await _counts_for_courses(
        db, [c.id for c in courses]
    )
    return [
        _summary(c, unit_counts.get(c.id, 0), enr_counts.get(c.id, 0))
        for c in courses
    ]


@router.get("/courses/{course_id}", response_model=CourseDetail)
async def get_course(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDetail:
    course = await db.get(StudyCourse, course_id)
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found.")
    await get_accessible_workspace(course.workspace_id, user, db)
    return await _detail(db, course)


@router.get(
    "/courses/{course_id}/draft-progress", response_model=CourseDraftProgress
)
async def course_draft_progress(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDraftProgress:
    course = await db.get(StudyCourse, course_id)
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found.")
    await get_accessible_workspace(course.workspace_id, user, db)
    entry = PLANNING_PROGRESS.get(course.id) or {}
    unit_count = (
        await db.execute(
            select(func.count()).where(StudyCourseUnit.course_id == course.id)
        )
    ).scalar_one() or 0
    return CourseDraftProgress(
        status=course.status,
        drafting=bool(entry),
        stage=entry.get("stage"),
        units_drafted=int(entry.get("units_drafted") or 0),
        unit_count=unit_count,
        error=course.drafting_error,
    )


@router.post("/courses/{course_id}/redraft", response_model=CourseDraftProgress)
async def redraft_course(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDraftProgress:
    """Re-run the AI blueprint draft (replaces the current unit list)."""
    course = await _get_course_for_author(course_id, user, db)
    if course.status != "draft":
        raise HTTPException(
            status_code=409, detail="Only draft courses can be re-drafted."
        )
    if PLANNING_PROGRESS.get(course.id):
        raise HTTPException(status_code=409, detail="A draft is already running.")
    provider, model_id = await _resolve_drafting_model(db)
    course.drafting_error = None
    await db.commit()
    PLANNING_PROGRESS.setdefault(
        course.id, {"stage": "reading", "units_drafted": 0}
    )
    asyncio.create_task(
        _draft_course_task(course.id, provider.id, model_id),
        name=f"course-draft-{course.id}",
    )
    return CourseDraftProgress(
        status=course.status,
        drafting=True,
        stage="reading",
        units_drafted=0,
        unit_count=0,
        error=None,
    )


@router.patch("/courses/{course_id}", response_model=CourseDetail)
async def update_course(
    course_id: uuid.UUID,
    payload: CourseUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDetail:
    course = await _get_course_for_author(course_id, user, db)
    data = payload.model_dump(exclude_unset=True)
    if (
        "difficulty_preset" in data
        and data["difficulty_preset"]
        and data["difficulty_preset"] not in _VALID_PRESETS
    ):
        raise HTTPException(
            status_code=422,
            detail=f"difficulty_preset must be one of {sorted(_VALID_PRESETS)}",
        )
    for key, value in data.items():
        if key in ("title", "brief") and isinstance(value, str):
            value = value.strip()
        setattr(course, key, value)
    course.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(course)
    return await _detail(db, course)


@router.put("/courses/{course_id}/units", response_model=CourseDetail)
async def replace_course_units(
    course_id: uuid.UUID,
    units: list[CourseUnitPayload],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDetail:
    """Replace the blueprint — the authoring editor saves the whole list
    (reorder / rewrite / delete / add in one shot). Draft courses only."""
    course = await _get_course_for_author(course_id, user, db)
    if course.status != "draft":
        raise HTTPException(
            status_code=409,
            detail="The blueprint is locked once a course is published.",
        )
    if len(units) > 40:
        raise HTTPException(status_code=422, detail="Too many units (max 40).")
    for existing in await _course_units(db, course_id):
        await db.delete(existing)
    for idx, u in enumerate(units):
        db.add(
            StudyCourseUnit(
                course_id=course_id,
                order_index=idx,
                title=u.title.strip(),
                description=(u.description or "").strip() or None,
                learning_objectives=[
                    o.strip() for o in u.learning_objectives if o.strip()
                ],
                source_file_ids=[s for s in u.source_file_ids if s.strip()],
            )
        )
    course.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(course)
    return await _detail(db, course)


@router.post("/courses/{course_id}/publish", response_model=CourseDetail)
async def publish_course(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDetail:
    """Draft → published. The human sign-off (principle 2): after this the
    blueprint is locked and the course becomes assignable."""
    course = await _get_course_for_author(course_id, user, db)
    if course.status == "published":
        return await _detail(db, course)
    if course.status != "draft":
        raise HTTPException(
            status_code=409, detail="Only draft courses can be published."
        )
    units = await _course_units(db, course_id)
    if not units:
        raise HTTPException(
            status_code=422, detail="Add at least one unit before publishing."
        )
    empty = [u.title for u in units if not (u.learning_objectives or [])]
    if empty:
        raise HTTPException(
            status_code=422,
            detail=(
                "Every unit needs at least one learning objective. Missing: "
                + ", ".join(empty[:3])
            ),
        )
    course.status = "published"
    course.published_at = datetime.now(timezone.utc)
    course.updated_at = course.published_at
    await db.commit()
    await db.refresh(course)
    return await _detail(db, course)


@router.post("/courses/{course_id}/archive", response_model=CourseDetail)
async def archive_course(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CourseDetail:
    course = await _get_course_for_author(course_id, user, db)
    course.status = "archived"
    course.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(course)
    return await _detail(db, course)


@router.delete(
    "/courses/{course_id}",
    status_code=204,
    response_class=Response,
)
async def delete_course(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    """Delete a course. Learners' materialised projects survive (their
    ``source_course_id`` SET-NULLs into personal topics)."""
    course = await _get_course_for_author(course_id, user, db)
    await db.delete(course)
    await db.commit()
    return Response(status_code=204)


# ====================================================================
# Enrollment — materialise the blueprint into a learner project
# ====================================================================
async def _is_workspace_member(
    db: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> bool:
    from app.chat.models import Workspace

    ws = await db.get(Workspace, workspace_id)
    if ws is None:
        return False
    if ws.user_id == user_id:
        return True
    share = (
        await db.execute(
            select(WorkspaceShare).where(
                WorkspaceShare.workspace_id == workspace_id,
                WorkspaceShare.invitee_user_id == user_id,
                WorkspaceShare.status == "accepted",
            )
        )
    ).scalar_one_or_none()
    return share is not None


@router.post(
    "/courses/{course_id}/enroll",
    response_model=EnrollmentResponse,
    status_code=201,
)
async def enroll_learner(
    course_id: uuid.UUID,
    payload: EnrollRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EnrollmentResponse:
    """Assign a published course to a workspace member.

    Materialises the blueprint into a fresh :class:`StudyProject` owned by
    the learner — units copied, objectives seeded, source files attached
    as study materials (indexed for citation-grounded tutoring), diagnostic
    pre-calibrated (the curriculum is authored; the tutor must not
    restructure it).
    """
    course = await _get_course_for_author(course_id, user, db)
    if course.status != "published":
        raise HTTPException(
            status_code=409, detail="Publish the course before assigning it."
        )
    learner = await db.get(User, payload.user_id)
    if learner is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if not await _is_workspace_member(db, course.workspace_id, learner.id):
        raise HTTPException(
            status_code=422,
            detail="That user isn't a member of this workspace.",
        )
    existing = (
        await db.execute(
            select(StudyEnrollment).where(
                StudyEnrollment.course_id == course.id,
                StudyEnrollment.learner_user_id == learner.id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="That member is already enrolled in this course.",
        )

    units = await _course_units(db, course.id)
    if not units:
        raise HTTPException(status_code=422, detail="Course has no units.")

    # Teaching model for the materialised project — same admin resolution
    # the personal path uses.
    provider, model_id = await _resolve_drafting_model(db)

    project = StudyProject(
        user_id=learner.id,
        title=course.title,
        topics=[],
        goal=None,
        learning_request=course.brief,
        current_level=course.difficulty_preset,
        model_id=model_id,
        planning_provider_id=provider.id,
        status="active",
        source_course_id=course.id,
        # Authored curriculum = pre-calibrated: no Unit-1 diagnostic, no
        # prerequisite restructuring (adaptivity stays inside units).
        calibrated=True,
        calibration_source="course",
    )
    db.add(project)
    await db.flush()

    unit_rows: list[StudyUnit] = []
    for cu in units:
        row = StudyUnit(
            project_id=project.id,
            order_index=cu.order_index,
            title=cu.title,
            description=cu.description or "",
            learning_objectives=list(cu.learning_objectives or []),
            status="not_started",
        )
        db.add(row)
        unit_rows.append(row)
    await db.flush()
    for row in unit_rows:
        await study_review.seed_objectives_for_unit(db, row)

    # Attach the course's source files as study materials so lessons are
    # grounded + cited (L0.5). Indexing runs in the background per project
    # (chunks are project-scoped today; course-scoped chunks are a later
    # optimisation).
    material_file_ids: list[uuid.UUID] = []
    for fid in course.source_file_ids or []:
        try:
            file_uuid = uuid.UUID(fid)
        except ValueError:
            continue
        if await db.get(UserFile, file_uuid) is None:
            continue
        db.add(
            StudyMaterial(
                study_project_id=project.id,
                user_file_id=file_uuid,
                indexing_status="pending",
            )
        )
        material_file_ids.append(file_uuid)

    enrollment = StudyEnrollment(
        course_id=course.id,
        learner_user_id=learner.id,
        assigned_by=user.id,
        project_id=project.id,
        due_at=payload.due_at,
        status="assigned",
    )
    db.add(enrollment)
    await db.commit()
    await db.refresh(enrollment)

    for file_uuid in material_file_ids:
        asyncio.create_task(
            index_material_for_study_project(project.id, file_uuid),
            name=f"course-material-{project.id}-{file_uuid}",
        )

    return EnrollmentResponse(
        id=enrollment.id,
        course_id=enrollment.course_id,
        learner_user_id=enrollment.learner_user_id,
        learner_name=learner.username,
        assigned_by=enrollment.assigned_by,
        project_id=enrollment.project_id,
        due_at=enrollment.due_at,
        status=enrollment.status,
        created_at=enrollment.created_at,
    )


@router.get(
    "/courses/{course_id}/enrollments",
    response_model=list[EnrollmentResponse],
)
async def list_enrollments(
    course_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[EnrollmentResponse]:
    """Who's enrolled (authoring view). The full progress dashboard is L2."""
    course = await _get_course_for_author(course_id, user, db)
    rows = (
        await db.execute(
            select(StudyEnrollment, User.username)
            .join(User, User.id == StudyEnrollment.learner_user_id)
            .where(StudyEnrollment.course_id == course.id)
            .order_by(StudyEnrollment.created_at)
        )
    ).all()
    return [
        EnrollmentResponse(
            id=e.id,
            course_id=e.course_id,
            learner_user_id=e.learner_user_id,
            learner_name=username,
            assigned_by=e.assigned_by,
            project_id=e.project_id,
            due_at=e.due_at,
            status=e.status,
            created_at=e.created_at,
        )
        for e, username in rows
    ]
