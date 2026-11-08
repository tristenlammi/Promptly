"""/api/calls: LiveKit webhooks, Test calls, and Admin > Calls.

Voice channel routes live under /api/rooms (WP-V2). Anything a person
can't use is a 404, never a 403.
"""
from __future__ import annotations

import os
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.calls import access, checks
from app.database import get_db
from app.rate_limit import parse as parse_limit
from app.rate_limit import rate_limit
from app.redis_client import redis
from app.rtc import config as rtc_config
from app.rtc import names, stun, tokens, webhooks

router = APIRouter()


# ---------------------------------------------------------------- webhook


@router.post("/webhook", include_in_schema=False)
async def livekit_webhook(request: Request) -> Response:
    """LiveKit's events. No bearer: the signature (our API secret over the
    body's hash) is the authentication; anything else is refused."""
    body = (await request.body()).decode("utf-8", errors="replace")
    try:
        event = webhooks.verify(body, request.headers.get("Authorization"))
    except webhooks.BadSignature:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad signature")
    await webhooks.handle(event, redis)
    return Response(status_code=200)


# ---------------------------------------------------------------- me


class CallsMe(BaseModel):
    available: bool  # voice is on for me
    can_test: bool
    configured: bool  # the server has a calls key pair at all
    max_stream: str


@router.get("/me", response_model=CallsMe)
async def calls_me(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> CallsMe:
    s = await access.load_settings(db)
    return CallsMe(
        available=await access.voice_allowed(db, user, s),
        can_test=await access.can_test(db, user),
        configured=rtc_config.configured(),
        max_stream=s.max_stream,
    )


# ---------------------------------------------------------------- test calls


class TestJoin(BaseModel):
    url: str
    room: str
    identity: str
    token: str
    # A second, listen-only connection that plays you back through the
    # calls server ("Hear yourself").
    echo_identity: str
    echo_token: str


@router.post("/test", response_model=TestJoin)
async def start_test(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> TestJoin:
    if not await access.can_test(db, user):
        raise access.not_found()
    room = names.room_name("t_", user.id)
    me = names.user_identity(user.id, "test")
    echo = names.user_identity(user.id, "echo")
    display = user.username
    return TestJoin(
        url=rtc_config.CLIENT_PATH,
        room=room,
        identity=me,
        token=tokens.mint(identity=me, room=room, name=display, sources=[tokens.MICROPHONE]),
        echo_identity=echo,
        echo_token=tokens.mint(identity=echo, room=room, name=f"{display} (playback)", sources=[]),
    )


class TestReport(BaseModel):
    ok: bool
    protocol: Literal["udp", "tcp"] | None = None
    candidate_type: Literal["host", "srflx", "prflx", "relay"] | None = None
    rtt_ms: float | None = Field(default=None, ge=0, le=60000)
    packet_loss_pct: float | None = Field(default=None, ge=0, le=100)
    connect_ms: float | None = Field(default=None, ge=0, le=120000)
    server_address: str | None = Field(default=None, max_length=64)
    download_mbps: float | None = Field(default=None, ge=0, le=100000)
    error: str | None = Field(default=None, max_length=200)


class TestReportOut(BaseModel):
    outside: bool


@router.post("/test/report", response_model=TestReportOut)
async def report_test(
    payload: TestReport,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TestReportOut:
    """The browser's Test call result. Kept for the admin checklist with
    only "inside or outside the home", not the tester's address."""
    if not await access.can_test(db, user):
        raise access.not_found()
    from app.auth.basic import client_ip

    ip = client_ip(request)
    outside = bool(ip) and ip != "unknown" and not stun.is_private(ip)
    data = payload.model_dump()
    if data.get("server_address"):
        try:
            import ipaddress

            ipaddress.ip_address(data["server_address"])
        except ValueError:
            data["server_address"] = None
    await checks.record_test(redis, user.id, data, outside=outside)
    return TestReportOut(outside=outside)


_SPEEDTEST_MAX_MB = 25


@router.get(
    "/speedtest",
    dependencies=[Depends(rate_limit(parse_limit("12/hour"), bucket="calls_speedtest"))],
)
async def speedtest(
    mb: int = Query(default=8, ge=1, le=_SPEEDTEST_MAX_MB),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> StreamingResponse:
    """Random bytes for Test calls to time: from outside the home, the
    download speed it sees is roughly the home's upload, which is what
    limits how many people can watch a stream."""
    if not await access.can_test(db, user):
        raise access.not_found()
    total = mb * 1024 * 1024
    await db.close()

    async def gen():
        chunk = 64 * 1024
        sent = 0
        while sent < total:
            n = min(chunk, total - sent)
            yield os.urandom(n)
            sent += n

    return StreamingResponse(
        gen(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store", "Content-Length": str(total), "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- admin


class AdminSettings(BaseModel):
    enabled: bool
    group_ids: list[uuid.UUID] | None
    max_participants: int
    max_stream: str
    configured: bool


class AdminSettingsPatch(BaseModel):
    enabled: bool | None = None
    # null = everyone; [] = nobody but admins.
    group_ids: list[uuid.UUID] | None = None
    everyone: bool | None = None
    max_participants: int | None = Field(default=None, ge=access.MAX_PARTICIPANTS_RANGE[0], le=access.MAX_PARTICIPANTS_RANGE[1])
    max_stream: Literal["720p30", "1080p30", "1080p60"] | None = None


async def _settings_out(db: AsyncSession) -> AdminSettings:
    s = await access.load_settings(db)
    return AdminSettings(
        enabled=s.enabled,
        group_ids=s.group_ids,
        max_participants=s.max_participants,
        max_stream=s.max_stream,
        configured=rtc_config.configured(),
    )


@router.get("/admin/settings", response_model=AdminSettings)
async def get_admin_settings(db: AsyncSession = Depends(get_db), _: User = Depends(require_admin)) -> AdminSettings:
    return await _settings_out(db)


@router.patch("/admin/settings", response_model=AdminSettings)
async def patch_admin_settings(
    payload: AdminSettingsPatch,
    request: Request,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_admin),
) -> AdminSettings:
    from app.auth.audit import EVENT_APP_SETTINGS_CHANGED, record_event, safe_dict

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    diff: dict = {}
    if payload.enabled is not None and payload.enabled != row.calls_enabled:
        if payload.enabled and not rtc_config.configured():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The calls service isn't set up on this server yet. See the checklist below.",
            )
        row.calls_enabled = payload.enabled
        diff["calls_enabled"] = payload.enabled
    if payload.everyone:
        if row.calls_group_ids is not None:
            row.calls_group_ids = None
            diff["calls_group_ids"] = None
    elif "group_ids" in payload.model_fields_set and payload.group_ids is not None:
        from sqlalchemy import select

        from app.groups.models import UserGroup

        wanted = list(dict.fromkeys(payload.group_ids))
        if wanted:
            found = set((await db.execute(select(UserGroup.id).where(UserGroup.id.in_(wanted)))).scalars().all())
            if found != set(wanted):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="One of those groups doesn't exist.")
        ids = [str(g) for g in wanted]
        if row.calls_group_ids != ids:
            row.calls_group_ids = ids
            diff["calls_group_ids"] = ids
    if payload.max_participants is not None and payload.max_participants != row.calls_max_participants:
        row.calls_max_participants = payload.max_participants
        diff["calls_max_participants"] = payload.max_participants
    if payload.max_stream is not None and payload.max_stream != row.calls_max_stream:
        row.calls_max_stream = payload.max_stream
        diff["calls_max_stream"] = payload.max_stream
    if diff:
        await record_event(
            db,
            request=request,
            event_type=EVENT_APP_SETTINGS_CHANGED,
            user_id=actor.id,
            identifier=actor.username,
            detail=safe_dict(diff),
        )
    await db.commit()
    return await _settings_out(db)


@router.get("/check")
async def calls_check(_: User = Depends(require_admin)) -> dict:
    return await checks.checklist(redis)


@router.get("/usage")
async def calls_usage(_: User = Depends(require_admin)) -> dict:
    return await checks.usage(redis)
