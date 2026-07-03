"""Promptly — FastAPI application entrypoint."""
from __future__ import annotations

import asyncio
import logging
import traceback
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.config import InsecureProductionConfig, get_settings
from app.cors_dynamic import DynamicCORSMiddleware
from app.database import engine
from app.logging_setup import (
    RequestContextMiddleware,
    configure_logging,
    get_request_id,
    get_user_id,
)
from app.observability.capture import (
    CapturedError,
    capture_error,
    install_error_capture,
)
from app.chat.temporary_sweeper import start_sweeper
from app.chat.semantic_index import start_semantic_indexer
from app.tasks.scheduler import start_scheduler
from app.redis_client import close_redis, redis

# Configure the JSON logger + in-memory ring buffer *before* any other
# import emits a log line, so structured output is consistent from the
# very first message.
configure_logging()
logger = logging.getLogger("promptly")

settings = get_settings()

# ----------------------------------------------------------------
# Boot-time safety checks (fail-fast).
#
# Run at module import time so a misconfigured deployment can't even
# start uvicorn. The list is deliberately small now that DOMAIN /
# CORS / cookies are wizard-driven — only things that genuinely have
# to be set before the first HTTP request can be served (i.e. a
# strong SECRET_KEY) belong here. Everything else surfaces in the
# setup wizard as a warning the operator can act on with a click.
# ----------------------------------------------------------------
_config_errors = settings.validate_boot_safety()
if _config_errors:
    msg = "Refusing to start with insecure configuration:\n  - " + "\n  - ".join(
        _config_errors
    )
    logger.critical(msg)
    raise InsecureProductionConfig(msg)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info(
        "Promptly backend starting up (debug=%s, domain=%s)",
        settings.DEBUG,
        settings.DOMAIN,
    )
    # Phase Z1 — start the temporary-chat sweeper. Hard-deletes any
    # conversation past its ``expires_at`` so the DB doesn't accumulate
    # ephemeral / 1-hour rows forever. The listing endpoint already
    # lazy-filters expired rows so the sweeper interval is purely a
    # housekeeping concern.
    sweeper_task = start_sweeper()
    # Phase 1 (v2) — start the scheduled-tasks runner. Polls for due
    # automations every minute and dispatches headless runs.
    scheduler_task = start_scheduler()
    # Phase 7 (v2) — start the semantic conversation indexer. Continuously
    # embeds messages lacking an up-to-date vector so the search palette
    # can blend keyword + meaning-based recall. No-op when embeddings
    # aren't configured.
    indexer_task = start_semantic_indexer()
    try:
        yield
    finally:
        logger.info("Promptly backend shutting down")
        for bg in (sweeper_task, scheduler_task, indexer_task):
            bg.cancel()
            try:
                await bg
            except (asyncio.CancelledError, Exception):
                pass
        await close_redis()


# Docs are gated on DEBUG. In production they 404 because the full
# OpenAPI surface is reconnaissance gold — anyone past auth can already
# discover endpoints by using the app, so we don't owe outsiders a map.
_docs_url = "/api/docs" if settings.DEBUG else None
_redoc_url = "/api/redoc" if settings.DEBUG else None
_openapi_url = "/api/openapi.json" if settings.DEBUG else None

app = FastAPI(
    title="Promptly API",
    description="Backend API for the Promptly self-hosted AI chat interface.",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=_docs_url,
    redoc_url=_redoc_url,
    openapi_url=_openapi_url,
)


# Once the app object exists, install the logging-handler ingestion path
# so any ``logger.error`` / ``logger.exception`` call from anywhere
# (including background tasks not bound to a Request) lands in the
# error_events table.
install_error_capture()


@app.exception_handler(Exception)
async def _capture_unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """Persist 500-class errors before the framework hides them.

    FastAPI's default handler swallows the traceback into a 500 with no
    body and only logs to the access stream — fine for the user
    (don't leak internals) but useless for the operator. We persist
    one ``error_events`` row with the full stack and request context
    here, then return the same minimal body the user would have got.
    """
    stack = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    capture_error(
        CapturedError(
            level="ERROR",
            logger_name="promptly.unhandled",
            message=f"{type(exc).__name__}: {exc}",
            exception_class=type(exc).__name__,
            stack=stack,
            route=f"{request.method} {request.url.path}",
            method=request.method,
            status_code=500,
            request_id=get_request_id(),
            user_id=get_user_id(),
            extra=None,
        )
    )
    # Mirror what the framework would have returned by default —
    # generic 500 with no leaked internals.
    logger.exception("Unhandled exception in request handler")
    return JSONResponse(
        {"detail": "Internal Server Error"},
        status_code=500,
        headers={"X-Request-ID": get_request_id() or ""},
    )

# Optional Host-header allowlist. Off unless the operator sets
# ``TRUSTED_HOSTS`` (the reverse proxy is the primary Host guard). When on,
# we always also permit loopback + the internal ``backend`` service name so
# docker healthchecks and inter-container calls (collab→backend snapshot)
# aren't rejected.
_trusted_hosts = settings.trusted_hosts_list
if _trusted_hosts:
    from starlette.middleware.trustedhost import TrustedHostMiddleware

    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=[*_trusted_hosts, "localhost", "127.0.0.1", "backend"],
    )

# Paywall enforcement. Added before the RequestContext + CORS layers so those
# stay OUTER — a 402 from here still bubbles out through them (CORS headers +
# request logging intact). Inert unless PAYWALL_ENFORCED; pass-through for
# allowed requests so SSE streams aren't buffered. See app.paywall.
from app.paywall import PaywallMiddleware  # noqa: E402

app.add_middleware(PaywallMiddleware)

# Request-context middleware first so the request id and route are
# bound in contextvars before CORS / auth start logging.
app.add_middleware(RequestContextMiddleware)

app.add_middleware(
    DynamicCORSMiddleware,
    # Origins resolve dynamically per request from a combination of
    # always-allowed localhost defaults, the legacy ``ALLOWED_ORIGINS``
    # env var, and the DB-stored ``app_settings.public_origins`` set
    # by the first-run wizard / Admin → Settings. See
    # ``app.cors_dynamic`` for the resolution order. No wildcards
    # anywhere — wildcard + credentials is browser-rejected and would
    # mask real config bugs.
    allow_credentials=True,
    # Explicit method list rather than "*". Anything new we add must be
    # mentioned here, which is a useful forcing function when reviewing
    # state-changing endpoints.
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
    expose_headers=["Content-Disposition"],
)


async def _check_postgres() -> dict:
    """Round-trip a trivial ``SELECT 1`` against the configured database.

    Sub-second timeout keeps a wedged Postgres from holding the health
    response open for the full asyncpg default. Returns ``{ok: bool,
    error: str | None}`` so the response body can show *which* dependency
    is unhealthy without the operator having to read the logs.
    """
    try:
        async with asyncio.timeout(1.5):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        return {"ok": True, "error": None}
    except Exception as exc:  # noqa: BLE001 — health probe must never raise
        return {"ok": False, "error": str(exc)[:200]}


async def _check_redis() -> dict:
    """``PING`` Redis with a 1-second cap."""
    try:
        async with asyncio.timeout(1.0):
            pong = await redis.ping()
        return {"ok": bool(pong), "error": None}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:200]}


async def _check_searxng() -> dict:
    """HEAD against the SearXNG root URL.

    SearXNG doesn't expose a dedicated ``/healthz`` so we settle for
    "responds to a request at all". A 405 (HEAD not supported by the
    Flask app) is still proof of life and we accept it. Marked
    ``ok=True`` with a note for the rare provider that returns 4xx on
    HEAD; only network errors / timeouts mark unhealthy.
    """
    url = settings.SEARXNG_URL.rstrip("/") + "/"
    try:
        async with asyncio.timeout(2.0):
            async with httpx.AsyncClient(follow_redirects=False) as client:
                resp = await client.head(url)
        return {
            "ok": True,
            "error": None,
            "status": resp.status_code,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:200]}


@app.get("/api/health", tags=["health"])
async def health() -> JSONResponse:
    """Deep health probe.

    Pings every infrastructure dependency in parallel with a sub-second
    cap each so the worst case latency is bounded. Returns ``200`` only
    when everything is green; anything red flips to ``503`` so an uptime
    monitor or container orchestrator can react. The body always lists
    per-component status so the operator can see at a glance which
    dependency is broken without tailing logs.
    """
    pg, rd, sx = await asyncio.gather(
        _check_postgres(),
        _check_redis(),
        _check_searxng(),
    )
    components = {"postgres": pg, "redis": rd, "searxng": sx}
    overall_ok = all(c["ok"] for c in components.values())
    body = {
        "status": "ok" if overall_ok else "degraded",
        "service": "promptly-backend",
        "components": components,
    }
    return JSONResponse(body, status_code=200 if overall_ok else 503)


# ---- Router registration ----
from app.admin.router import router as admin_router  # noqa: E402
from app.admin.deletion_router import router as deletion_router  # noqa: E402
from app.app_settings.router import router as app_settings_router  # noqa: E402
from app.app_settings.org_defaults_router import (  # noqa: E402
    router as org_defaults_router,
)
from app.app_settings.public_router import (  # noqa: E402
    router as workspace_defaults_router,
)
from app.auth.router import router as auth_router  # noqa: E402
from app.auth.clerk_webhook import router as clerk_webhook_router  # noqa: E402
from app.workspaces.shares import invite_router as workspace_invite_router  # noqa: E402
from app.workspaces.shares import router as workspace_shares_router  # noqa: E402
from app.workspaces.router import router as workspaces_router  # noqa: E402
from app.workspaces.items_router import router as workspace_items_router  # noqa: E402
from app.workspaces.canvas_router import router as workspace_canvas_router  # noqa: E402
from app.workspaces.ask_router import router as workspace_ask_router  # noqa: E402
from app.workspaces.overview_router import router as workspace_overview_router  # noqa: E402
from app.workspaces.tasks_router import router as workspace_tasks_router  # noqa: E402
from app.workspaces.comments_router import router as workspace_comments_router  # noqa: E402
from app.mcp.router import router as mcp_admin_router  # noqa: E402
from app.mcp.workspace_router import router as mcp_workspace_router  # noqa: E402
from app.groups.router import router as groups_admin_router  # noqa: E402
from app.chat.router import router as chat_router  # noqa: E402
from app.custom_models.router import router as custom_models_router  # noqa: E402
from app.files.documents_router import router as documents_router  # noqa: E402
from app.files.router import router as files_router  # noqa: E402
from app.files.share_router import router as file_share_router  # noqa: E402
from app.local_models.router import router as local_models_router  # noqa: E402
from app.billing.router import router as billing_router  # noqa: E402
from app.research.router import router as research_router  # noqa: E402
from app.mfa.router import router as mfa_router  # noqa: E402
from app.models_config.router import router as models_router  # noqa: E402
from app.notifications.router import router as notifications_router  # noqa: E402
from app.saved_prompts.router import router as saved_prompts_router  # noqa: E402
from app.search.router import router as search_router  # noqa: E402
from app.study.router import router as study_router  # noqa: E402
from app.memory.router import router as memory_router  # noqa: E402
from app.tasks.router import router as tasks_router  # noqa: E402
from app.voice.router import router as voice_router  # noqa: E402

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(
    clerk_webhook_router, prefix="/api/auth/clerk", tags=["clerk"]
)
app.include_router(mfa_router, prefix="/api/auth/mfa", tags=["mfa"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
app.include_router(
    deletion_router, prefix="/api/admin/deletion", tags=["admin"]
)
app.include_router(
    app_settings_router, prefix="/api/admin/app-settings", tags=["admin"]
)
# Per-org model-role defaults (org admins). Scoped to the caller's own org.
app.include_router(
    org_defaults_router, prefix="/api/admin/org-defaults", tags=["admin"]
)
# Non-admin read of the workspace-wide model defaults — every
# authenticated user needs to see this so the chat picker can
# initialise to the admin's default for users who haven't picked
# a personal preference yet.
app.include_router(
    workspace_defaults_router,
    prefix="/api/workspace-defaults",
    tags=["workspace-defaults"],
)
app.include_router(chat_router, prefix="/api/chat", tags=["chat"])
app.include_router(
    saved_prompts_router, prefix="/api/saved-prompts", tags=["saved-prompts"]
)
app.include_router(
    workspaces_router, prefix="/api/workspaces", tags=["workspaces"]
)
# Navigator tree (folders / notes / move / delete) — same prefix; the
# /tree and /items paths don't collide with the core workspaces CRUD.
app.include_router(
    workspace_items_router, prefix="/api/workspaces", tags=["workspaces"]
)
# Canvas collab tokens + text sync (creation goes through the items router).
app.include_router(
    workspace_canvas_router, prefix="/api/canvas", tags=["workspaces"]
)
# Ask-this-workspace grounded Q&A (POST /api/workspaces/{wid}/ask).
app.include_router(
    workspace_ask_router, prefix="/api/workspaces", tags=["workspaces"]
)
# Workspace overview home (counts + tasks rollup + recent).
app.include_router(
    workspace_overview_router, prefix="/api/workspaces", tags=["workspaces"]
)
# Workspace task list (first-class, project-level to-dos).
app.include_router(
    workspace_tasks_router, prefix="/api/workspaces", tags=["workspaces"]
)
# Workspace item comments (collaboration discussion threads).
app.include_router(
    workspace_comments_router, prefix="/api/workspaces", tags=["workspaces"]
)
# MCP connectors (admin-managed external tool servers — Phase 10).
app.include_router(
    mcp_admin_router, prefix="/api/admin/mcp", tags=["mcp"]
)
# Workspace owners attach workspace-scoped connectors to their workspace.
app.include_router(
    mcp_workspace_router, prefix="/api/workspaces", tags=["mcp"]
)
# User groups (admin-managed teams; scope connectors by identity).
app.include_router(
    groups_admin_router, prefix="/api/admin/groups", tags=["groups"]
)
# Workspace share management endpoints — separate router so it can
# be version-bumped independently of the core workspaces CRUD.
app.include_router(
    workspace_shares_router,
    prefix="/api/workspaces",
    tags=["workspaces"],
)
# Invitee-perspective endpoints (``/api/workspace-share-invites``)
# live on ``/api`` so they sit next to the conversation
# equivalents.
app.include_router(
    workspace_invite_router, prefix="/api", tags=["workspaces"]
)
app.include_router(models_router, prefix="/api/models", tags=["models"])
# Custom Models — admin-curated assistants (personality + knowledge
# library). Lives under the admin prefix so non-admins can't list
# them; the picker integration on ``/api/models/available`` exposes
# the user-safe surface.
app.include_router(
    custom_models_router,
    prefix="/api/admin/custom-models",
    tags=["custom-models"],
)
# Local Models — thin admin-only wrapper over the bundled Ollama
# container (list / pull / delete / hardware probe). The pulled
# models surface through ``/api/models/available`` via the
# auto-registered Ollama ``ModelProvider`` row, so no chat-path
# wiring is needed here.
app.include_router(
    local_models_router,
    prefix="/api/admin/local-models",
    tags=["local-models"],
)
app.include_router(study_router, prefix="/api/study", tags=["study"])
app.include_router(tasks_router, prefix="/api/tasks", tags=["tasks"])
app.include_router(memory_router, prefix="/api/memory", tags=["memory"])
# Voice — speech-to-text dictation (Phase 1). POST /api/voice/transcribe.
app.include_router(voice_router, prefix="/api/voice", tags=["voice"])
app.include_router(billing_router, prefix="/api/usage", tags=["usage"])
app.include_router(research_router, prefix="/api", tags=["research"])
app.include_router(search_router, prefix="/api/search", tags=["search"])
app.include_router(files_router, prefix="/api/files", tags=["files"])
# Drive Documents API (create doc, mint collab JWT, accept snapshot
# from Hocuspocus, upload inline assets). Kept at /api/documents
# because /api/files is the generic CRUD surface and document rows
# live alongside ordinary files there — the dedicated prefix makes
# the collab-aware endpoints easy to find + easy to lock down in
# nginx / rate limits independently.
app.include_router(documents_router, prefix="/api/documents", tags=["documents"])
# Public share-link API. Mounted under ``/api/s/*`` so nginx still
# proxies it to the backend (``/s/*`` alone would collide with the
# SPA route for the share landing page). Each endpoint is
# token-gated + optionally password-gated — *no* auth dependency
# is applied here because anonymous visitors are the whole point.
# Sits outside ``/api/files`` so revocation + auth rules stay
# deliberately separate from the owner-side CRUD.
app.include_router(file_share_router, prefix="/api/s", tags=["file-shares"])
app.include_router(
    notifications_router,
    prefix="/api/notifications",
    tags=["notifications"],
)
