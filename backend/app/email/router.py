"""Email integration API (Phase 12 — E.1).

Endpoints
---------
GET  /api/email/oauth/google/start          → auth URL for Google consent
GET  /api/email/oauth/google/callback       → token exchange (redirect from Google)
GET  /api/email/accounts                    → list user's connected accounts
DELETE /api/email/accounts/{id}             → disconnect an account
POST /api/email/accounts/{id}/sync-now      → trigger an immediate sync
PATCH /api/email/messages/{id}/action       → read/archive with queued writeback
GET  /api/email/contacts                    → contact list
PATCH /api/email/contacts/{id}/vip          → toggle VIP flag

Security notes
--------------
* Every endpoint is gated on get_current_user — no admin required.
* OAuth state is a short-lived signed token stored in Redis (TTL 10 min)
  to prevent CSRF. The state comparison happens server-side in the callback.
* gmail.modify scope is used for two-way sync (read/archive writeback).
  No delete scope is ever requested.
* Client secret is Fernet-encrypted in app_settings; decrypted in-process
  only at token-exchange time.
"""
from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import get_current_user
from app.auth.models import User
from app.auth.utils import decrypt_secret
from app.database import get_db
from app.email.crypto import OAuthTokens, encrypt_tokens
from app.email.models import EmailAccount, EmailContact, EmailMessage
from app.email.models import CalendarEvent
from app.email.schemas import (
    AiAssistRequest,
    AiAssistResponse,
    CalendarEventResponse,
    CategoryCounts,
    ContactVipUpdate,
    CreateCalendarEventRequest,
    DraftReplyRequest,
    DraftReplyResponse,
    EmailAccountResponse,
    EmailContactResponse,
    EmailFeatureStatus,
    EmailMessageBrief,
    EmailMessageDetail,
    MessageActionRequest,
    OAuthStartResponse,
    SendReplyRequest,
)
from app.redis_client import redis

logger = logging.getLogger("promptly.email.router")

router = APIRouter()

# Google OAuth constants
_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 — not a secret
_GOOGLE_SCOPES = (
    "openid email profile "
    "https://www.googleapis.com/auth/gmail.modify "
    "https://www.googleapis.com/auth/gmail.send "
    "https://www.googleapis.com/auth/calendar.readonly "
    "https://www.googleapis.com/auth/calendar.events"
)

_OAUTH_STATE_TTL = 600  # 10 minutes


# ------------------------------------------------------------------ #
# Helpers                                                              #
# ------------------------------------------------------------------ #

async def _get_settings(db: AsyncSession) -> AppSettings:
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        raise HTTPException(status_code=503, detail="App settings not initialised.")
    return row


def _require_email_enabled(row: AppSettings) -> None:
    if not row.email_integration_enabled:
        raise HTTPException(
            status_code=403,
            detail="Email integration is not enabled on this instance.",
        )


def _require_google_oauth(row: AppSettings) -> tuple[str, str]:
    if not row.google_oauth_client_id or not row.google_oauth_client_secret_enc:
        raise HTTPException(
            status_code=503,
            detail="Google OAuth credentials are not configured. "
                   "Ask your admin to add them under Admin → Settings → Email.",
        )
    client_secret = decrypt_secret(row.google_oauth_client_secret_enc)
    return row.google_oauth_client_id, client_secret


# ------------------------------------------------------------------ #
# Google OAuth flow                                                    #
# ------------------------------------------------------------------ #

@router.get("/oauth/google/start", response_model=OAuthStartResponse)
async def google_oauth_start(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OAuthStartResponse:
    """Return the Google consent-screen URL. Frontend redirects the user here."""
    row = await _get_settings(db)
    _require_email_enabled(row)
    client_id, _ = _require_google_oauth(row)

    state = secrets.token_urlsafe(32)
    # Store in Redis so the callback can verify + look up the user_id
    await redis.setex(
        f"email:oauth:state:{state}",
        _OAUTH_STATE_TTL,
        json.dumps({"user_id": str(user.id)}),
    )

    redirect_uri = str(request.base_url).rstrip("/") + "/api/email/oauth/google/callback"
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": _GOOGLE_SCOPES,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return OAuthStartResponse(
        auth_url=f"{_GOOGLE_AUTH_URL}?{urlencode(params)}",
        state=state,
    )


@router.get("/oauth/google/callback")
async def google_oauth_callback(
    code: str = Query(...),
    state: str = Query(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Exchange OAuth code for tokens. Called by Google; returns JSON for SPA."""
    row = await _get_settings(db)

    # Validate state (CSRF guard)
    state_key = f"email:oauth:state:{state}"
    raw = await redis.get(state_key)
    if not raw:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state.")
    await redis.delete(state_key)
    state_data = json.loads(raw)
    user_id = uuid.UUID(state_data["user_id"])

    client_id, client_secret = _require_google_oauth(row)
    redirect_uri = str(request.base_url).rstrip("/") + "/api/email/oauth/google/callback"

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            _GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )

    if resp.status_code != 200:
        logger.error("Google token exchange failed: %s", resp.text[:300])
        raise HTTPException(status_code=502, detail="Failed to exchange OAuth code.")

    token_data = resp.json()
    access_token = token_data.get("access_token", "")
    refresh_token = token_data.get("refresh_token")

    expiry_iso: str | None = None
    if "expires_in" in token_data:
        expiry = datetime.now(timezone.utc) + timedelta(seconds=int(token_data["expires_in"]))
        expiry_iso = expiry.isoformat()

    # Fetch the Gmail address for this token
    async with httpx.AsyncClient() as client:
        profile_resp = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
    if profile_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch Google profile.")

    profile = profile_resp.json()
    email_address = profile.get("email", "").lower()
    if not email_address:
        raise HTTPException(status_code=502, detail="Google profile missing email.")

    tokens: OAuthTokens = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expiry_iso": expiry_iso,
    }
    encrypted = encrypt_tokens(tokens)

    # Upsert the account row
    existing = (
        await db.execute(
            select(EmailAccount).where(
                EmailAccount.user_id == user_id,
                EmailAccount.provider == "google",
                EmailAccount.email_address == email_address,
            )
        )
    ).scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if existing:
        existing.oauth_tokens_encrypted = encrypted
        if refresh_token:
            pass  # always update if we got a fresh refresh token
        existing.scopes = _GOOGLE_SCOPES
        existing.enabled = True
        existing.next_sync_at = now  # trigger immediate sync
        existing.sync_cursor_expired = True  # force resync on reconnect
        account = existing
    else:
        account = EmailAccount(
            user_id=user_id,
            provider="google",
            email_address=email_address,
            oauth_tokens_encrypted=encrypted,
            scopes=_GOOGLE_SCOPES,
            enabled=True,
            next_sync_at=now,
        )
        db.add(account)

    # Seed the Email Attachments system folder for this user (lazy)
    from app.email.system_folder import ensure_email_attachments_for_user
    await ensure_email_attachments_for_user(db, user_id)

    await db.commit()
    await db.refresh(account)

    logger.info("Google account connected: user=%s email=%s", user_id, email_address)
    return {"status": "connected", "account_id": str(account.id), "email": email_address}


# ------------------------------------------------------------------ #
# Account management                                                   #
# ------------------------------------------------------------------ #

@router.get("/accounts", response_model=list[EmailAccountResponse])
async def list_accounts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[EmailAccountResponse]:
    rows = (
        await db.execute(
            select(EmailAccount)
            .where(EmailAccount.user_id == user.id)
            .order_by(EmailAccount.created_at)
        )
    ).scalars().all()
    return [EmailAccountResponse.model_validate(r) for r in rows]


@router.delete(
    "/accounts/{account_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def disconnect_account(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = await db.get(EmailAccount, account_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Account not found.")
    await db.delete(row)
    await db.commit()
    logger.info("Email account disconnected: user=%s account=%s", user.id, account_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/accounts/{account_id}/sync-now", status_code=status.HTTP_202_ACCEPTED)
async def sync_now(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Queue an immediate sync by setting next_sync_at to now."""
    row = await db.get(EmailAccount, account_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Account not found.")
    row.next_sync_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "queued"}


# ------------------------------------------------------------------ #
# Message actions (two-way sync via writeback flags)                  #
# ------------------------------------------------------------------ #

@router.patch("/messages/{message_id}/action", status_code=status.HTTP_200_OK)
async def message_action(
    message_id: uuid.UUID,
    body: MessageActionRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Mark a message read/unread/archived/unarchived.

    Updates the local row immediately and queues a writeback flag so the
    next sync loop applies the change to Gmail. This keeps the UI instant
    while the API call is eventually consistent.
    """
    msg = await db.get(EmailMessage, message_id)
    if not msg or msg.user_id != user.id:
        raise HTTPException(status_code=404, detail="Message not found.")

    match body.action:
        case "read":
            msg.read = True
            msg.writeback_read = True
        case "unread":
            msg.read = False
            msg.writeback_read = False
        case "archive":
            msg.archived = True
            msg.writeback_archived = True
        case "unarchive":
            msg.archived = False
            msg.writeback_archived = False

    await db.commit()
    return {"status": "ok"}


# ------------------------------------------------------------------ #
# Contacts                                                             #
# ------------------------------------------------------------------ #

@router.get("/contacts", response_model=list[EmailContactResponse])
async def list_contacts(
    q: str = Query(default="", max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[EmailContactResponse]:
    stmt = (
        select(EmailContact)
        .where(EmailContact.user_id == user.id)
        .order_by(EmailContact.message_count.desc())
        .limit(limit)
    )
    if q:
        q_lower = f"%{q.lower()}%"
        from sqlalchemy import or_, func as sqlfunc
        stmt = stmt.where(
            or_(
                sqlfunc.lower(EmailContact.email_address).like(q_lower),
                sqlfunc.lower(EmailContact.display_name).like(q_lower),
            )
        )
    rows = (await db.execute(stmt)).scalars().all()
    return [EmailContactResponse.model_validate(r) for r in rows]


@router.patch("/contacts/{contact_id}/vip", response_model=EmailContactResponse)
async def update_vip(
    contact_id: uuid.UUID,
    body: ContactVipUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EmailContactResponse:
    row = await db.get(EmailContact, contact_id)
    if not row or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Contact not found.")
    row.is_vip = body.is_vip
    await db.commit()
    await db.refresh(row)
    return EmailContactResponse.model_validate(row)


# ------------------------------------------------------------------ #
# Feature status (public — any authenticated user can read)           #
# ------------------------------------------------------------------ #

@router.get("/feature-status", response_model=EmailFeatureStatus)
async def feature_status(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> EmailFeatureStatus:
    """Return whether email integration is enabled + OAuth is configured.
    Readable by any authenticated user so the account settings panel can
    show/hide the connect-Gmail button without admin access.
    """
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        return EmailFeatureStatus(enabled=False, oauth_configured=False)
    return EmailFeatureStatus(
        enabled=bool(row.email_integration_enabled),
        oauth_configured=bool(row.google_oauth_client_id and row.google_oauth_client_secret_enc),
    )


# ------------------------------------------------------------------ #
# Message list / detail                                                #
# ------------------------------------------------------------------ #

@router.get("/messages/counts", response_model=CategoryCounts)
async def message_counts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CategoryCounts:
    """Return unread (non-archived) message counts per AI category."""
    from sqlalchemy import func as sqlfunc
    rows = (
        await db.execute(
            select(EmailMessage.ai_category, sqlfunc.count().label("cnt"))
            .where(
                EmailMessage.user_id == user.id,
                EmailMessage.read.is_(False),
                EmailMessage.archived.is_(False),
            )
            .group_by(EmailMessage.ai_category)
        )
    ).all()
    counts: dict[str, int] = {}
    for category, cnt in rows:
        key = category or "uncategorised"
        counts[key] = cnt
    return CategoryCounts(**{k: counts.get(k, 0) for k in CategoryCounts.model_fields})


@router.get("/messages", response_model=list[EmailMessageBrief])
async def list_messages(
    category: str | None = Query(default=None),
    read: bool | None = Query(default=None),
    archived: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[EmailMessageBrief]:
    stmt = (
        select(EmailMessage)
        .where(EmailMessage.user_id == user.id)
        .order_by(EmailMessage.date.desc())
        .limit(limit)
        .offset(offset)
    )
    if category is not None:
        if category == "uncategorised":
            stmt = stmt.where(EmailMessage.ai_category.is_(None))
        else:
            stmt = stmt.where(EmailMessage.ai_category == category)
    if read is not None:
        stmt = stmt.where(EmailMessage.read.is_(read))
    stmt = stmt.where(EmailMessage.archived.is_(archived))
    rows = (await db.execute(stmt)).scalars().all()
    return [EmailMessageBrief.model_validate(r) for r in rows]


@router.get("/messages/{message_id}", response_model=EmailMessageDetail)
async def get_message(
    message_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> EmailMessageDetail:
    msg = await db.get(EmailMessage, message_id)
    if not msg or msg.user_id != user.id:
        raise HTTPException(status_code=404, detail="Message not found.")
    # Auto-mark as read on open
    if not msg.read:
        msg.read = True
        msg.writeback_read = True
        await db.commit()
        await db.refresh(msg)
    return EmailMessageDetail.model_validate(msg)


# ------------------------------------------------------------------ #
# Calendar events                                                      #
# ------------------------------------------------------------------ #

@router.get("/calendar/events", response_model=list[CalendarEventResponse])
async def list_calendar_events(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CalendarEventResponse]:
    """Return upcoming calendar events within the next ``days`` days."""
    from datetime import timedelta
    from sqlalchemy import and_
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(days=days)
    rows = (
        await db.execute(
            select(CalendarEvent)
            .where(
                and_(
                    CalendarEvent.user_id == user.id,
                    CalendarEvent.start_at >= now,
                    CalendarEvent.start_at <= cutoff,
                    CalendarEvent.status != "cancelled",
                )
            )
            .order_by(CalendarEvent.start_at)
            .limit(50)
        )
    ).scalars().all()
    return [CalendarEventResponse.model_validate(r) for r in rows]


@router.post("/calendar/events", response_model=CalendarEventResponse, status_code=status.HTTP_201_CREATED)
async def create_calendar_event(
    body: CreateCalendarEventRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CalendarEventResponse:
    """Create a new Google Calendar event and mirror it locally."""
    row = await _get_settings(db)
    _require_email_enabled(row)
    client_id, client_secret = _require_google_oauth(row)

    # Find the user's first enabled Google account
    account = (
        await db.execute(
            select(EmailAccount)
            .where(
                EmailAccount.user_id == user.id,
                EmailAccount.provider == "google",
                EmailAccount.enabled.is_(True),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if not account:
        raise HTTPException(
            status_code=404,
            detail="No connected Google account found. Connect Gmail first.",
        )

    from app.email.sync import _get_valid_tokens
    tokens = await _get_valid_tokens(db, account, client_id, client_secret)

    # Build Google Calendar event body
    if body.all_day:
        start_payload = {"date": body.start_at.date().isoformat()}
        end_payload = {"date": body.end_at.date().isoformat()}
    else:
        start_payload = {"dateTime": body.start_at.isoformat(), "timeZone": "UTC"}
        end_payload = {"dateTime": body.end_at.isoformat(), "timeZone": "UTC"}

    gcal_body: dict = {
        "summary": body.title,
        "start": start_payload,
        "end": end_payload,
    }
    if body.location:
        gcal_body["location"] = body.location
    if body.description:
        gcal_body["description"] = body.description

    async with httpx.AsyncClient() as http:
        resp = await http.post(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            json=gcal_body,
            timeout=20,
        )

    if resp.status_code not in (200, 201):
        logger.error("Calendar event creation failed: %s %s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail=f"Google Calendar API error: {resp.status_code}")

    gcal_event = resp.json()
    now = datetime.now(timezone.utc)

    # Mirror locally
    new_event = CalendarEvent(
        account_id=account.id,
        user_id=user.id,
        provider_event_id=gcal_event["id"],
        title=body.title,
        start_at=body.start_at,
        end_at=body.end_at,
        all_day=body.all_day,
        location=body.location,
        description=body.description,
        attendees=[],
        meet_link=None,
        status="confirmed",
        synced_at=now,
    )
    db.add(new_event)
    await db.commit()
    await db.refresh(new_event)

    logger.info("Calendar event created: user=%s id=%s title=%r", user.id, new_event.id, body.title)
    return CalendarEventResponse.model_validate(new_event)


# ------------------------------------------------------------------ #
# Draft reply + send                                                   #
# ------------------------------------------------------------------ #

async def _get_email_model(db: AsyncSession):
    """Resolve which model+provider to use for email AI features.

    Preference order: email_triage model → default_chat model → 503.
    """
    from app.models_config.models import ModelProvider
    settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if settings is None:
        raise HTTPException(status_code=503, detail="App settings not initialised.")

    # Prefer the dedicated email triage model
    if settings.email_triage_provider_id and settings.email_triage_model_id:
        provider = await db.get(ModelProvider, settings.email_triage_provider_id)
        if provider:
            return provider, settings.email_triage_model_id

    # Fallback to the default chat model
    if settings.default_chat_provider_id and settings.default_chat_model_id:
        provider = await db.get(ModelProvider, settings.default_chat_provider_id)
        if provider:
            return provider, settings.default_chat_model_id

    raise HTTPException(
        status_code=503,
        detail="No AI model configured. Set a model under Admin → Models.",
    )


def _build_thread_context(msg: EmailMessage) -> str:
    """Format an email message for injection into a model prompt."""
    parts = [
        f"Subject: {msg.subject or '(no subject)'}",
        f"From: {msg.from_name or ''} <{msg.from_address or ''}>",
        f"Date: {msg.date.isoformat() if msg.date else 'unknown'}",
        f"To: {', '.join(str(a) for a in (msg.to_addresses or []))}",
    ]
    if msg.body_text:
        parts.append(f"\n{msg.body_text[:4000]}")
    elif msg.snippet:
        parts.append(f"\n{msg.snippet}")
    return "\n".join(parts)


_DRAFT_SYSTEM = """You are an expert email assistant. Draft a professional, concise reply to the email below.
Write ONLY the reply body — no subject line, no "Dear ...", no sign-off unless natural for the context.
Match the tone of the original. Be direct and helpful.
If the user has given a specific instruction, follow it exactly."""

_ASSIST_SYSTEM = """You are a helpful email assistant. The user wants help with the email below.
Respond concisely and directly. Do not add unnecessary caveats."""


@router.post("/messages/{message_id}/draft-reply", response_model=DraftReplyResponse)
async def draft_reply(
    message_id: uuid.UUID,
    body: DraftReplyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftReplyResponse:
    """Generate an AI draft reply for the given message."""
    from app.models_config.provider import ChatMessage, TextDelta, model_router
    from app.memory.service import build_memory_system_prompt

    msg = await db.get(EmailMessage, message_id)
    if not msg or msg.user_id != user.id:
        raise HTTPException(status_code=404, detail="Message not found.")

    provider, model_id = await _get_email_model(db)

    # Build system prompt (optionally injecting memories)
    memory_block, _ = await build_memory_system_prompt(db, user.id)
    system = _DRAFT_SYSTEM
    if memory_block:
        system = memory_block + "\n\n" + system

    # Build user message
    thread_ctx = _build_thread_context(msg)
    user_content = f"Email to reply to:\n\n{thread_ctx}"
    if body.instruction:
        user_content += f"\n\nAdditional instruction: {body.instruction}"

    chunks: list[str] = []
    async for event in model_router.stream_chat_events(
        provider=provider,
        model_id=model_id,
        messages=[ChatMessage(role="user", content=user_content)],
        system=system,
        temperature=0.7,
        max_tokens=800,
    ):
        if isinstance(event, TextDelta):
            chunks.append(event.text)

    return DraftReplyResponse(draft="".join(chunks).strip())


@router.post("/messages/{message_id}/send-reply", response_model=dict)
async def send_reply(
    message_id: uuid.UUID,
    body: SendReplyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Send a reply via Gmail. Requires send_confirmed=true as an explicit guard."""
    if not body.send_confirmed:
        raise HTTPException(
            status_code=400,
            detail="send_confirmed must be true. Confirm the recipient before sending.",
        )
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="Message body cannot be empty.")

    msg = await db.get(EmailMessage, message_id)
    if not msg or msg.user_id != user.id:
        raise HTTPException(status_code=404, detail="Message not found.")

    # Get the account to find the sending address and tokens
    account = await db.get(EmailAccount, msg.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Email account not found.")

    row = await _get_settings(db)
    _require_email_enabled(row)
    client_id, client_secret = _require_google_oauth(row)

    from app.email.sync import _get_valid_tokens
    tokens = await _get_valid_tokens(db, account, client_id, client_secret)

    # Build RFC 2822 message
    import email.mime.text
    import base64

    reply_to = msg.from_address or ""
    subject = msg.subject or ""
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"

    mime_msg = email.mime.text.MIMEText(body.body, "plain", "utf-8")
    mime_msg["To"] = reply_to
    mime_msg["From"] = account.email_address
    mime_msg["Subject"] = subject

    raw = base64.urlsafe_b64encode(mime_msg.as_bytes()).decode("ascii")
    payload: dict = {"raw": raw}
    if msg.thread_id:
        payload["threadId"] = msg.thread_id

    async with httpx.AsyncClient() as http:
        resp = await http.post(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            json=payload,
            timeout=20,
        )

    if resp.status_code not in (200, 201):
        logger.error("Gmail send failed: %s %s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail=f"Gmail send failed: {resp.status_code}")

    logger.info("Reply sent: user=%s message=%s to=%s", user.id, message_id, reply_to)
    return {"status": "sent", "to": reply_to}


# ------------------------------------------------------------------ #
# AI assist in reading pane                                            #
# ------------------------------------------------------------------ #

@router.post("/messages/{message_id}/ai-assist", response_model=AiAssistResponse)
async def ai_assist(
    message_id: uuid.UUID,
    body: AiAssistRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> AiAssistResponse:
    """Answer a free-form question about the email using AI."""
    from app.models_config.provider import ChatMessage, TextDelta, model_router

    if not body.instruction.strip():
        raise HTTPException(status_code=400, detail="Instruction cannot be empty.")

    msg = await db.get(EmailMessage, message_id)
    if not msg or msg.user_id != user.id:
        raise HTTPException(status_code=404, detail="Message not found.")

    provider, model_id = await _get_email_model(db)

    thread_ctx = _build_thread_context(msg)
    user_content = f"Email:\n\n{thread_ctx}\n\nInstruction: {body.instruction}"

    chunks: list[str] = []
    async for event in model_router.stream_chat_events(
        provider=provider,
        model_id=model_id,
        messages=[ChatMessage(role="user", content=user_content)],
        system=_ASSIST_SYSTEM,
        temperature=0.3,
        max_tokens=600,
    ):
        if isinstance(event, TextDelta):
            chunks.append(event.text)

    return AiAssistResponse(response="".join(chunks).strip())
