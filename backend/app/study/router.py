"""Study API — projects, sessions, streaming chat, whiteboard snapshot."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.auth.models import User
from app.database import SessionLocal, get_db
from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.study.models import StudyMessage, StudyProject, StudySession, WhiteboardExercise
from app.study.parser import WhiteboardActionParser
from app.study.schemas import (
    StudyMessageResponse,
    StudyProjectCreate,
    StudyProjectDetail,
    StudyProjectSummary,
    StudyProjectUpdate,
    StudySendMessageRequest,
    StudySendMessageResponse,
    StudySessionDetail,
    StudySessionSummary,
    WhiteboardExerciseDetail,
    WhiteboardExerciseSummary,
    WhiteboardState,
    WhiteboardSubmitRequest,
    WhiteboardSubmitResponse,
    WhiteboardUpdate,
)
from app.study.service import (
    StudyStreamContext,
    build_history_for_llm,
    build_tutor_system_prompt,
    consume_stream,
    enqueue_stream,
    format_submission_user_message,
    parse_action_payload,
)

logger = logging.getLogger("promptly.study")
router = APIRouter()


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


async def _resolve_provider(
    provider: ModelProvider | None,
    user: User,
    db: AsyncSession,
    *,
    model_id: str | None = None,
) -> ModelProvider:
    """Validate provider ownership + per-user model allowlist.

    Non-admins may route through providers owned by any admin (shared pool)
    or system-wide providers (``user_id IS NULL``). Admins use their own.
    When ``model_id`` is supplied we additionally check it is in the user's
    ``allowed_models`` (admins are unrestricted).
    """
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


# ====================================================================
# Projects CRUD
# ====================================================================
@router.get("/projects", response_model=list[StudyProjectSummary])
async def list_projects(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[StudyProjectSummary]:
    result = await db.execute(
        select(StudyProject)
        .where(StudyProject.user_id == user.id)
        .order_by(StudyProject.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return [StudyProjectSummary.model_validate(p) for p in result.scalars().all()]


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
    # Validate provider if a model was chosen. We don't require one at create
    # time — the user can pick later in the session UI.
    if payload.provider_id is not None:
        provider = await db.get(ModelProvider, payload.provider_id)
        await _resolve_provider(provider, user, db, model_id=payload.model_id)

    project = StudyProject(
        user_id=user.id,
        title=payload.title.strip(),
        topics=[t.strip() for t in payload.topics if t.strip()],
        goal=(payload.goal or "").strip() or None,
        model_id=payload.model_id,
    )
    db.add(project)
    await db.flush()

    sessions: list[StudySession] = []
    if payload.create_session:
        session = StudySession(project_id=project.id)
        db.add(session)
        sessions.append(session)

    await db.commit()
    await db.refresh(project)
    for s in sessions:
        await db.refresh(s)

    return StudyProjectDetail.model_validate(
        {
            **project.__dict__,
            "sessions": [StudySessionSummary.model_validate(s) for s in sessions],
        }
    )


@router.get("/projects/{project_id}", response_model=StudyProjectDetail)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudyProjectDetail:
    project = await _get_owned_project(project_id, user, db)
    sessions_res = await db.execute(
        select(StudySession)
        .where(StudySession.project_id == project.id)
        .order_by(StudySession.created_at.asc())
    )
    sessions = [StudySessionSummary.model_validate(s) for s in sessions_res.scalars().all()]
    return StudyProjectDetail.model_validate(
        {**project.__dict__, "sessions": sessions}
    )


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
    return StudyProjectSummary.model_validate(project)


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


# ====================================================================
# Sessions
# ====================================================================
@router.post(
    "/projects/{project_id}/sessions",
    response_model=StudySessionSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StudySessionSummary:
    project = await _get_owned_project(project_id, user, db)
    session = StudySession(project_id=project.id)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return StudySessionSummary.model_validate(session)


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
        {**session.__dict__, "messages": messages}
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

    # Resolve provider + model: request > project default.
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

    # Persist user message immediately so the client can optimistic-render.
    user_msg = StudyMessage(
        session_id=session.id,
        role="user",
        content=payload.content,
    )
    db.add(user_msg)

    # Remember last-used model on the project so subsequent sends work without
    # re-specifying.
    project.model_id = model_id
    project.updated_at = datetime.now(timezone.utc)
    session.updated_at = datetime.now(timezone.utc)

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

        # Rehydrate history — any assistant message linked to an exercise
        # gets its original `<whiteboard_action>` block re-injected so the
        # LLM can reason about what it previously placed.
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

        system_prompt = build_tutor_system_prompt(project)

        yield _sse({"event": "start", "stream_id": str(stream_id)})

        parser = WhiteboardActionParser()
        chat_parts: list[str] = []
        pending_action_payloads: list[dict[str, Any]] = []

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
                for raw in captures:
                    payload = parse_action_payload(raw)
                    if payload is None:
                        logger.warning(
                            "Discarding malformed whiteboard_action JSON (%d chars)",
                            len(raw),
                        )
                        continue
                    pending_action_payloads.append(payload)
                    yield _sse({"event": "action_detected", "kind": payload.get("type")})
        except ProviderError as e:
            logger.warning("Study provider error on stream %s: %s", stream_id, e)
            yield _sse({"error": str(e)})
            yield _sse({"done": True})
            return
        except asyncio.CancelledError:
            logger.info("Study stream %s cancelled", stream_id)
            raise

        # Anything the parser was holding back (partial tag prefix that never
        # resolved to a tag) is now known-safe.
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

        # Persist each captured exercise. We only link the first exercise
        # back onto the assistant message — subsequent exercises in the same
        # reply are rare in practice and the UI will pick up the latest.
        emitted_exercises: list[WhiteboardExercise] = []
        for idx, payload in enumerate(pending_action_payloads):
            kind = str(payload.get("type", "")).lower()
            if kind != "exercise":
                logger.info(
                    "Ignoring unsupported whiteboard action type=%r", payload.get("type")
                )
                continue
            html = payload.get("html")
            if not isinstance(html, str) or not html.strip():
                logger.warning("Skipping whiteboard exercise with empty html")
                continue
            title = payload.get("title")
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

        # Mark the exercise being reviewed as 'reviewed' and stash the
        # feedback (the full assistant reply).
        if reviewing_exercise_id is not None:
            reviewed = await db.get(WhiteboardExercise, reviewing_exercise_id)
            if reviewed is not None and reviewed.session_id == session.id:
                reviewed.status = "reviewed"
                reviewed.ai_feedback = full_chat

        session.updated_at = datetime.now(timezone.utc)
        project.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(assistant)
        for ex in emitted_exercises:
            await db.refresh(ex)

        # Announce each freshly-created exercise so the client can load it
        # into the whiteboard iframe.
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
    # `session_id` is path-only for RESTful-shape; actual ownership check
    # happens inside the generator using the redis context.
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
# Whiteboard snapshot persistence
# ====================================================================
@router.get(
    "/sessions/{session_id}/whiteboard",
    response_model=WhiteboardState,
)
async def get_whiteboard(
    session_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WhiteboardState:
    session, _ = await _get_owned_session(session_id, user, db)
    return WhiteboardState(
        snapshot=session.excalidraw_snapshot,
        updated_at=session.updated_at,
    )


@router.post(
    "/sessions/{session_id}/whiteboard/update",
    response_model=WhiteboardState,
)
async def update_whiteboard(
    session_id: uuid.UUID,
    payload: WhiteboardUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WhiteboardState:
    session, _ = await _get_owned_session(session_id, user, db)
    session.excalidraw_snapshot = payload.snapshot
    session.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(session)
    return WhiteboardState(
        snapshot=session.excalidraw_snapshot,
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

    exercise = await db.get(WhiteboardExercise, payload.exercise_id)
    if exercise is None or exercise.session_id != session.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Exercise not found"
        )
    if exercise.status == "reviewed":
        # Allow re-submission (student tweaks and tries again) — reset to
        # 'submitted' and let the stream promote back to 'reviewed'.
        pass

    # Resolve provider + model for the eval reply. Project.model_id is always
    # populated once the student has sent at least one message; guard anyway.
    model_id = project.model_id
    if not model_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No model is associated with this study project yet — "
                "send a chat message first."
            ),
        )
    # Provider must be owned (or global) + enabled; pick the first enabled
    # provider that exposes this model_id in its enabled_models (or any if
    # enabled_models is null).
    provider = await _pick_provider_for_model(model_id, user, db)

    # Record submission + freehand snapshot.
    now = datetime.now(timezone.utc)
    exercise.status = "submitted"
    exercise.answer_payload = payload.answers
    exercise.excalidraw_snap = payload.excalidraw_snapshot_b64
    exercise.submitted_at = now

    # Synthetic user chat message so the AI receives the submission as a
    # normal turn. Formatting includes the exercise title + answers JSON.
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
    }
    await enqueue_stream(stream_id, ctx)

    return WhiteboardSubmitResponse(
        stream_id=stream_id,
        user_message=StudyMessageResponse.model_validate(user_msg),
        exercise=WhiteboardExerciseSummary.model_validate(exercise),
    )


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


# Keep the scaffold ping for sanity checks.
@router.get("/_ping")
async def ping() -> dict[str, str]:
    return {"module": "study", "status": "ready"}
