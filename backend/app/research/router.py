"""Research API router (Phase 11)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import AppSettings, SINGLETON_APP_SETTINGS_ID
from app.app_settings.defaults import load_effective_defaults
from app.auth.deps import get_current_user
from app.auth.models import User
from app.billing.usage import check_budget
from app.chat.models import Conversation, Message
from app.chat.stream_runner import get_or_create_session
from app.database import SessionLocal, get_db
from app.models_config.models import ModelProvider
from app.research.engine import _sse, is_research_worthy, run_research

router = APIRouter()


class ResearchRequest(BaseModel):
    model_config = {"protected_namespaces": ()}
    query: str = Field(min_length=1, max_length=4000)
    # User's currently-selected chat model — used as fallback when the admin
    # has not configured a dedicated research model.
    provider_id: uuid.UUID
    model_id: str = Field(min_length=1, max_length=255)


class RefineRequest(BaseModel):
    model_config = {"protected_namespaces": ()}
    refinement: str = Field(min_length=1, max_length=2000)
    provider_id: uuid.UUID
    model_id: str = Field(min_length=1, max_length=255)
    # The research report message to deepen. Its content is the prior
    # report the refinement expands on.
    base_message_id: uuid.UUID


class ClassifyRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)


async def _resolve_research_model(
    db: AsyncSession,
    user: User,
    fallback_provider_id: uuid.UUID,
    fallback_model_id: str,
) -> tuple[ModelProvider, str]:
    """Pick the research model: admin-configured first, else the user's
    current chat model from the request. Raises HTTPException on a bad
    fallback provider."""
    settings = await load_effective_defaults(db)
    if settings.research_configured:
        rp = await db.get(ModelProvider, settings.research_provider_id)
        if rp is not None and rp.enabled:
            return rp, settings.research_model_id  # type: ignore[return-value]

    # A Custom Model chat stores ``custom:<uuid>``, which no provider
    # accepts — research and sub-agents failed on every such chat (R-079).
    from app.custom_models.resolver import is_custom_model_id, resolve_custom_model

    if is_custom_model_id(fallback_model_id):
        resolved = await resolve_custom_model(fallback_model_id, db)
        if resolved is None or not resolved.base_provider.enabled:
            raise HTTPException(status_code=400, detail="This chat's assistant is unavailable.")
        return resolved.base_provider, resolved.base_model_id

    rp = await db.get(ModelProvider, fallback_provider_id)
    if rp is None:
        raise HTTPException(status_code=400, detail="Unknown provider.")
    owner_ok = rp.user_id is None or rp.user_id == user.id
    if not owner_ok:
        owner = await db.get(User, rp.user_id)
        owner_ok = (
            owner is not None
            and getattr(owner, "role", None) == "admin"
            and getattr(user, "role", None) != "admin"
        )
    if not owner_ok or not rp.enabled:
        raise HTTPException(status_code=400, detail="Unknown provider.")
    return rp, fallback_model_id


async def _start_job(
    *,
    user: User,
    conv: Conversation,
    provider: ModelProvider,
    model_id: str,
    query: str,
    label: str,
    refinement: str | None = None,
    prior_report: str | None = None,
) -> dict[str, str]:
    """Run a research pass as a background job, like a chat reply.

    It used to stream straight from the POST: a reload lost the run, Cancel
    only dropped the browser's connection (the research went on and was
    billed), and the report was saved through the request's database
    session, which FastAPI has already closed by then — so in any chat
    that had messages the finished report vanished (R-044/R-084). Now it
    has its own session, and the chat stream endpoints watch, replay and
    stop it (``GET /api/chat/stream/{id}``, ``POST …/stop``).
    """
    stream_id = uuid.uuid4()
    user_id, conv_id, provider_id = user.id, conv.id, provider.id

    async def _runner(session) -> None:
        async with SessionLocal() as db:
            c = await db.get(Conversation, conv_id)
            u = await db.get(User, user_id)
            p = await db.get(ModelProvider, provider_id)
            if c is None or u is None or p is None:
                session.push(_sse({"error": "This chat or its model is no longer available."}))
            else:
                gen = await run_research(
                    query=query, db=db, user=u, conv=c, provider=p, model_id=model_id,
                    refinement=refinement, prior_report=prior_report,
                )
                async for chunk in gen:
                    session.push(chunk)
        session.push(_sse({"done": True}))

    await get_or_create_session(
        stream_id=stream_id,
        user_id=user_id,
        conversation_id=conv_id,
        runner=_runner,
        kind="research",
        label=label,
    )
    return {"stream_id": str(stream_id)}


@router.post("/conversations/{conversation_id}/research", status_code=status.HTTP_202_ACCEPTED)
async def start_research(
    conversation_id: uuid.UUID,
    payload: ResearchRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Stream a deep research investigation on the given query.

    Model resolution order:
      1. Admin-configured research model (``app_settings.research_provider_id/model_id``)
      2. User's currently-selected chat model from the request payload

    This lets admins point research at a capable pro model while users continue
    chatting with a faster/cheaper model. The conversation's model is never
    changed by this endpoint — the next chat send uses whatever was selected
    before research ran.
    """
    # Validate conversation ownership.
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found.",
        )

    # Budget / quota guard.
    try:
        snapshot = await check_budget(db, user)
        if snapshot.verdict == "blocked":
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Your {snapshot.blocking_window} usage limit has been reached.",
            )
    except HTTPException:
        raise
    except Exception:
        pass

    # ----- Model resolution ------------------------------------------------
    # Prefer the admin-configured research model; fall back to the user's
    # current chat model (from the request).
    research_provider, research_model_id = await _resolve_research_model(
        db, user, payload.provider_id, payload.model_id
    )

    return await _start_job(
        user=user,
        conv=conv,
        provider=research_provider,
        model_id=research_model_id,
        query=payload.query,
        label=payload.query,
    )


@router.post("/conversations/{conversation_id}/research/refine", status_code=status.HTTP_202_ACCEPTED)
async def refine_research(
    conversation_id: uuid.UUID,
    payload: RefineRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Run a focused follow-up ("dig deeper") on an existing report.

    Loads the prior report message, then streams a refinement pass that
    targets the user's instruction and re-synthesises the full updated
    report — rather than restarting the whole investigation.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found."
        )

    base = await db.get(Message, payload.base_message_id)
    if (
        base is None
        or base.conversation_id != conv.id
        or base.role != "assistant"
        or not (base.content or "").strip()
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Report to refine not found.",
        )

    try:
        snapshot = await check_budget(db, user)
        if snapshot.verdict == "blocked":
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Your {snapshot.blocking_window} usage limit has been reached.",
            )
    except HTTPException:
        raise
    except Exception:
        pass

    research_provider, research_model_id = await _resolve_research_model(
        db, user, payload.provider_id, payload.model_id
    )

    # The original topic is the user message that produced this report; fall
    # back to the report's first line if we can't resolve it.
    original_query = base.content.strip().splitlines()[0][:500]
    if base.parent_id is not None:
        parent = await db.get(Message, base.parent_id)
        if parent is not None and (parent.content or "").strip():
            original_query = (
                parent.content.replace("\U0001f52c", "")
                .replace("**Deep Research:**", "")
                .replace("**Deep Research — dig deeper:**", "")
                .strip()[:500]
            )

    return await _start_job(
        user=user,
        conv=conv,
        provider=research_provider,
        model_id=research_model_id,
        query=original_query,
        label=f"Dig deeper: {payload.refinement}",
        refinement=payload.refinement,
        prior_report=base.content,
    )


@router.post("/research/classify")
async def classify_query(
    payload: ClassifyRequest,
    _user: User = Depends(get_current_user),
) -> dict:
    """Quick classifier for proactive research suggestions.

    Returns ``{"suggest": true}`` when the query looks like a genuinely
    research-worthy open investigation. Rule-based so there is zero LLM cost.
    """
    return {"suggest": is_research_worthy(payload.query)}


@router.get("/research/config")
async def get_research_config(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Return the effective research model display name for the UI.

    The frontend uses this to tell users which model their research will run on.
    Returns ``{"model_display": null}`` when no admin model is configured
    (falls back to the user's chat model, which the frontend knows).
    """
    settings = await load_effective_defaults(db)
    if not settings.research_configured:
        return {"model_display": None, "configured": False}

    # Try to surface a human-readable name via the catalog.
    provider = await db.get(ModelProvider, settings.research_provider_id)
    provider_name = provider.name if provider else "Unknown provider"
    return {
        "configured": True,
        "model_display": f"{settings.research_model_id} ({provider_name})",
        "model_id": settings.research_model_id,
        "provider_name": provider_name,
    }
