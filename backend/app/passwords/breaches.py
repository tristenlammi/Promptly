"""Breach alerts on Passwords' Security page, and the admin's key.

The work is in ``app.breach_watch`` (see its docstring for why it sits outside this
module). These routes only gate it: a vault session for the person's side, an admin
for the key. Nothing here reads a vault.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from limits import parse
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import require_admin
from app.auth.models import User
from app.breach_watch import service as watch
from app.breach_watch.models import BreachAddress, BreachCatalog, BreachHit, BreachWatch
from app.database import get_db
from app.passwords import schemas as s
from app.passwords.deps import VaultSession, require_enabled, require_session
from app.passwords.router import _QuietRoute
from app.rate_limit import rate_limit

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])
admin_router = APIRouter(route_class=_QuietRoute)

_LIMIT_CHECK = rate_limit(parse("6/hour"), bucket="pw_breach_check")


class AddressOut(s._Base):
    address: str
    source: str
    checked_at: datetime | None = None


class BreachOut(s._Base):
    address: str
    name: str
    title: str
    domain: str
    breach_date: date | None
    added_date: datetime | None
    data_classes: list[str]
    verified: bool
    found_at: datetime


class WatchOut(s._Base):
    available: bool
    on: bool
    addresses: list[AddressOut]
    breaches: list[BreachOut]
    attribution: str = watch.ATTRIBUTION


class WatchIn(s._Base):
    on: bool


async def _watch_out(db: AsyncSession, user: User) -> WatchOut:
    cfg = await watch.config(db)
    on = await db.get(BreachWatch, user.id) is not None
    if on:
        rows = (await db.execute(select(BreachAddress).where(BreachAddress.user_id == user.id).order_by(BreachAddress.address))).scalars().all()
        addresses = [AddressOut(address=r.address, source=r.source, checked_at=r.checked_at) for r in rows]
    else:
        # What would be sent, shown before they agree to it.
        addresses = [AddressOut(address=a, source=src) for a, src in sorted((await watch.addresses_for(db, user)).items())]
    hits = (
        await db.execute(
            select(BreachHit, BreachCatalog)
            .outerjoin(BreachCatalog, BreachCatalog.name == BreachHit.name)
            .where(BreachHit.user_id == user.id)
            .order_by(BreachHit.breach_date.desc().nulls_last(), BreachHit.name)
        )
    ).all()
    breaches = [
        BreachOut(
            address=h.address, name=h.name, title=c.title if c else h.name, domain=c.domain if c else "",
            breach_date=h.breach_date, added_date=h.added_date, data_classes=list(c.data_classes or []) if c else [],
            verified=c.verified if c else True, found_at=h.found_at,
        )
        for h, c in hits
    ]
    return WatchOut(available=bool(cfg.api_key_encrypted), on=on, addresses=addresses, breaches=breaches)


@router.get("/breach-watch", response_model=WatchOut)
async def get_watch(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> WatchOut:
    out = await _watch_out(db, session.user)
    await db.commit()
    return out


@router.put("/breach-watch", response_model=WatchOut)
async def put_watch(body: WatchIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> WatchOut:
    if body.on:
        if not (await watch.config(db)).api_key_encrypted:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Breach alerts need your admin to add a Have I Been Pwned key first.")
        await watch.turn_on(db, session.user)
    else:
        await watch.forget(db, session.user.id)
    await db.commit()
    return await _watch_out(db, session.user)


@router.post("/breach-watch/check", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(_LIMIT_CHECK)])
async def check_soon(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Put this person's addresses first in the next run, which still keeps to the rate limit."""
    if await db.get(BreachWatch, session.user.id) is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Turn breach alerts on first.")
    now = datetime.now(timezone.utc)
    for r in (await db.execute(select(BreachAddress).where(BreachAddress.user_id == session.user.id))).scalars():
        if r.checked_at is None or now - r.checked_at > timedelta(hours=1):
            r.next_check_at = now
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ the admin's side


class AdminOut(s._Base):
    key_set: bool
    rpm: int
    plan: str | None
    last_run_at: datetime | None
    last_error: str | None
    people_on: int


class AdminIn(s._Base):
    # "" removes the key. It's never sent back.
    api_key: str | None = Field(default=None, max_length=64)
    rpm: int | None = Field(default=None, ge=1, le=100000)


async def _admin_out(db: AsyncSession) -> AdminOut:
    cfg = await watch.config(db)
    people = await db.scalar(select(func.count()).select_from(BreachWatch))
    return AdminOut(key_set=bool(cfg.api_key_encrypted), rpm=cfg.rpm, plan=cfg.plan, last_run_at=cfg.last_run_at, last_error=cfg.last_error, people_on=int(people or 0))


@admin_router.get("/admin/breach-watch", response_model=AdminOut)
async def admin_get(_admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)) -> AdminOut:
    out = await _admin_out(db)
    await db.commit()
    return out


@admin_router.put("/admin/breach-watch", response_model=AdminOut)
async def admin_put(body: AdminIn, _admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)) -> AdminOut:
    cfg = await watch.config(db)
    if body.api_key is not None:
        key = body.api_key.strip()
        if not key:
            cfg.api_key_encrypted, cfg.plan, cfg.last_error, cfg.paused_until = None, None, None, None
        else:
            if not watch.KEY_PATTERN.match(key):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "A Have I Been Pwned key is 32 characters, 0-9 and a-f.")
            info = await watch.check_key(key)
            cfg.api_key_encrypted = watch.seal_key(key)
            cfg.paused_until = None
            if info is None:
                cfg.plan, cfg.last_error = None, "Couldn't check the key with Have I Been Pwned yet. The next run will try it."
            else:
                cfg.plan = str(info.get("SubscriptionName") or "")[:60] or None
                cfg.last_error = None
                rpm = info.get("Rpm")
                if isinstance(rpm, int) and rpm > 0 and body.rpm is None:
                    cfg.rpm = rpm
    if body.rpm is not None:
        cfg.rpm = body.rpm
    await db.commit()
    return await _admin_out(db)


__all__ = ["router", "admin_router"]
