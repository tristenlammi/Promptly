"""/api/passwords/browser-sync: open tabs, sent tabs, history and the reading list.

Everything here is a blob the server can't open (passwords/SYNC.md). It sees whose
it is, which device, a padded size, a history bucket's day and when it changed.
Bodies aren't logged, as for the rest of the vault's API.

* Open tabs and history are written by the browser they came from, with its own
  device token, so one browser can't overwrite another's.
* A sent tab can go only to a device of the same person that can reach the vault.
* History is kept for the person's chosen number of days (90 unless changed), and
  the sweep deletes what's older even if no browser is left to do it.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import Field
from sqlalchemy import and_, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.passwords import schemas as s
from app.passwords.deps import SCOPE_VAULT, VaultSession, parse_uuid, require_enabled, require_session
from app.passwords.models import PwDevice
from app.passwords.router import _QuietRoute
from app.passwords.sync_models import PwSyncRecord, PwSyncState

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])

# A blob is a padded bucket (a power of two) plus 30 bytes of header, nonce and tag.
_OVERHEAD = 64
MAX_TABS_BYTES = 512 * 1024 + _OVERHEAD
MAX_HISTORY_BYTES = 512 * 1024 + _OVERHEAD
MAX_READING_BYTES = 16 * 1024 + _OVERHEAD
MAX_SENT_BYTES = 16 * 1024 + _OVERHEAD
MAX_READING_ENTRIES = 5000
MAX_SENT_PENDING = 100
MAX_HISTORY_TOTAL = 64 * 1024 * 1024
HISTORY_DAYS_DEFAULT = 90
HISTORY_DAYS_MAX = 365
SENT_DAYS = 14
TABS_STALE_DAYS = 30

KINDS = ("tabs", "history", "reading", "sent")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _today() -> date:
    return _now().date()


class BlobIn(s._Base):
    blob: s.B64 = Field(min_length=30, max_length=MAX_TABS_BYTES)


class SentIn(s._Base):
    id: uuid.UUID
    target: uuid.UUID
    blob: s.B64 = Field(min_length=30, max_length=MAX_SENT_BYTES)


class RecordOut(s._Base):
    id: uuid.UUID
    device_id: uuid.UUID | None
    slot: str
    blob: s.B64
    size: int
    updated_at: datetime


class ListOut(s._Base):
    rev: int
    ids: list[uuid.UUID]
    records: list[RecordOut]


class PrefsIO(s._Base):
    history_days: int = Field(ge=1, le=HISTORY_DAYS_MAX)


async def _state(db: AsyncSession, user_id: uuid.UUID, lock: bool = False) -> PwSyncState:
    await db.execute(insert(PwSyncState).values(user_id=user_id, rev=0, history_days=HISTORY_DAYS_DEFAULT).on_conflict_do_nothing(index_elements=["user_id"]))
    q = select(PwSyncState).where(PwSyncState.user_id == user_id)
    row = await db.scalar(q.with_for_update() if lock else q)
    assert row is not None
    return row


def _own_device(session: VaultSession) -> PwDevice:
    """Tabs and history belong to the browser that sends them, known by its token."""
    if session.device is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a browser with the extension can share its tabs or history.")
    return session.device


def _check_size(blob: bytes, limit: int) -> None:
    if len(blob) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "That's more than this server keeps in one piece.")


async def _put(db: AsyncSession, user_id: uuid.UUID, kind: str, device_id: uuid.UUID | None, slot: str, blob: bytes, record_id: uuid.UUID | None = None) -> PwSyncRecord:
    state = await _state(db, user_id, lock=True)
    state.rev += 1
    cond = [PwSyncRecord.user_id == user_id, PwSyncRecord.kind == kind, PwSyncRecord.slot == slot]
    cond.append(PwSyncRecord.device_id.is_(None) if device_id is None else PwSyncRecord.device_id == device_id)
    row = await db.scalar(select(PwSyncRecord).where(*cond))
    if row is None:
        if record_id is not None and await db.get(PwSyncRecord, record_id) is not None:
            # Ids are global. Someone else's, or another kind of record, isn't overwritten.
            raise HTTPException(status.HTTP_409_CONFLICT, "That id is taken.")
        row = PwSyncRecord(id=record_id or uuid.uuid4(), user_id=user_id, kind=kind, device_id=device_id, slot=slot, blob=blob, size=len(blob), rev=state.rev)
        db.add(row)
    else:
        row.blob = blob
        row.size = len(blob)
        row.rev = state.rev
        row.updated_at = _now()
    return row


async def _bump(db: AsyncSession, user_id: uuid.UUID) -> None:
    """A delete changes what's there, so the counter moves and clients look again."""
    state = await _state(db, user_id, lock=True)
    state.rev += 1


def _cutoff(days: int) -> str:
    return (_today() - timedelta(days=days - 1)).isoformat()


# ------------------------------------------------------------------ reading


@router.get("/browser-sync/{kind}", response_model=ListOut)
async def list_records(
    kind: str,
    since: int = 0,
    from_day: str | None = None,
    session: VaultSession = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> ListOut:
    """What's there now (``ids``) and what changed after ``since``, with its blob. Sent tabs
    are only ever listed to the device they're for."""
    if kind not in KINDS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    user_id = session.user.id
    state = await _state(db, user_id)
    cond = [PwSyncRecord.user_id == user_id, PwSyncRecord.kind == kind]
    if kind == "sent":
        cond.append(PwSyncRecord.device_id == _own_device(session).id)
    if kind == "history":
        floor = _cutoff(state.history_days)
        if from_day is not None:
            if not _DAY.match(from_day):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "from_day is YYYY-MM-DD")
            floor = max(floor, from_day)
        cond.append(PwSyncRecord.slot >= floor)
    if kind in ("tabs", "sent", "history"):
        # A device that's been removed doesn't speak for anyone any more.
        live = select(PwDevice.id).where(PwDevice.user_id == user_id, PwDevice.revoked_at.is_(None))
        cond.append(PwSyncRecord.device_id.in_(live))
    ids = (await db.execute(select(PwSyncRecord.id).where(*cond))).scalars().all()
    rows = (await db.execute(select(PwSyncRecord).where(*cond, PwSyncRecord.rev > since).order_by(PwSyncRecord.rev))).scalars().all()
    await db.commit()
    return ListOut(
        rev=state.rev,
        ids=list(ids),
        records=[RecordOut(id=r.id, device_id=r.device_id, slot=r.slot, blob=r.blob, size=r.size, updated_at=r.updated_at) for r in rows],
    )


# ------------------------------------------------------------------ open tabs


@router.put("/browser-sync/tabs", status_code=status.HTTP_204_NO_CONTENT)
async def put_tabs(body: BlobIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    device = _own_device(session)
    _check_size(body.blob, MAX_TABS_BYTES)
    await _put(db, session.user.id, "tabs", device.id, "", body.blob)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/browser-sync/tabs", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tabs(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """This browser stops sharing its tabs."""
    device = _own_device(session)
    await _bump(db, session.user.id)
    await db.execute(delete(PwSyncRecord).where(PwSyncRecord.user_id == session.user.id, PwSyncRecord.kind == "tabs", PwSyncRecord.device_id == device.id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ sent tabs


@router.post("/browser-sync/sent", status_code=status.HTTP_204_NO_CONTENT)
async def send_tab(body: SentIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    target = await db.get(PwDevice, body.target)
    if target is None or target.user_id != session.user.id or target.revoked_at is not None or SCOPE_VAULT not in (target.scopes or []):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such device")
    _check_size(body.blob, MAX_SENT_BYTES)
    waiting = await db.scalar(select(func.count()).select_from(PwSyncRecord).where(PwSyncRecord.user_id == session.user.id, PwSyncRecord.kind == "sent", PwSyncRecord.device_id == target.id))
    if int(waiting or 0) >= MAX_SENT_PENDING:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "That device has a lot of tabs waiting already.")
    existing = await db.get(PwSyncRecord, body.id)
    if existing is not None:
        # The same send again, after a retry, is fine. Anything else with that id isn't.
        if existing.user_id == session.user.id and existing.kind == "sent" and existing.device_id == target.id:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        raise HTTPException(status.HTTP_409_CONFLICT, "That id is taken.")
    await _put(db, session.user.id, "sent", target.id, str(body.id), body.blob, record_id=body.id)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/browser-sync/sent/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
async def ack_sent(record_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """The device it was for has shown it."""
    row = await db.get(PwSyncRecord, parse_uuid(record_id))
    if row is None or row.user_id != session.user.id or row.kind != "sent":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _bump(db, session.user.id)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ history


@router.put("/browser-sync/history/{day}", status_code=status.HTTP_204_NO_CONTENT)
async def put_history(day: str, body: BlobIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    device = _own_device(session)
    if not _DAY.match(day):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "day is YYYY-MM-DD")
    try:
        when = date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "day is YYYY-MM-DD") from None
    state = await _state(db, session.user.id)
    # A day ahead allows for time zones. Anything past what's kept would only be swept.
    if when > _today() + timedelta(days=1) or day < _cutoff(state.history_days):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That day is outside the history this account keeps.")
    _check_size(body.blob, MAX_HISTORY_BYTES)
    used = await db.scalar(
        select(func.coalesce(func.sum(PwSyncRecord.size), 0)).where(
            PwSyncRecord.user_id == session.user.id, PwSyncRecord.kind == "history", ~and_(PwSyncRecord.device_id == device.id, PwSyncRecord.slot == day)
        )
    )
    if int(used or 0) + len(body.blob) > MAX_HISTORY_TOTAL:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Synced history is full. Keep fewer days, or delete it and start again.")
    await _put(db, session.user.id, "history", device.id, day, body.blob)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/browser-sync/history", status_code=status.HTTP_204_NO_CONTENT)
async def delete_history(this_device: bool = False, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Every browser's synced history, or only this one's. The browsers' own history stays."""
    cond = [PwSyncRecord.user_id == session.user.id, PwSyncRecord.kind == "history"]
    if this_device:
        cond.append(PwSyncRecord.device_id == _own_device(session).id)
    await _bump(db, session.user.id)
    await db.execute(delete(PwSyncRecord).where(*cond))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/browser-sync-prefs", response_model=PrefsIO)
async def get_prefs(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> PrefsIO:
    state = await _state(db, session.user.id)
    await db.commit()
    return PrefsIO(history_days=state.history_days)


@router.put("/browser-sync-prefs", response_model=PrefsIO)
async def put_prefs(body: PrefsIO, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> PrefsIO:
    """Fewer days takes effect at once: what's older goes now, not at the next sweep."""
    state = await _state(db, session.user.id, lock=True)
    state.history_days = body.history_days
    state.rev += 1
    await db.execute(delete(PwSyncRecord).where(PwSyncRecord.user_id == session.user.id, PwSyncRecord.kind == "history", PwSyncRecord.slot < _cutoff(body.history_days)))
    await db.commit()
    return PrefsIO(history_days=state.history_days)


# ------------------------------------------------------------------ reading list


@router.put("/browser-sync/reading/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def put_reading(entry_id: str, body: BlobIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    rid = parse_uuid(entry_id)
    _check_size(body.blob, MAX_READING_BYTES)
    existing = await db.get(PwSyncRecord, rid)
    if existing is not None and (existing.user_id != session.user.id or existing.kind != "reading"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if existing is None:
        count = await db.scalar(select(func.count()).select_from(PwSyncRecord).where(PwSyncRecord.user_id == session.user.id, PwSyncRecord.kind == "reading"))
        if int(count or 0) >= MAX_READING_ENTRIES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Your reading list is full. Remove some first.")
    await _put(db, session.user.id, "reading", None, str(rid), body.blob, record_id=rid)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/browser-sync/reading/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_reading(entry_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    row = await db.get(PwSyncRecord, parse_uuid(entry_id))
    if row is None or row.user_id != session.user.id or row.kind != "reading":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    await _bump(db, session.user.id)
    await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ sweeping and alerts


async def sweep(db: AsyncSession) -> dict[str, int]:
    """History past each person's chosen days, sent tabs nobody collected in two weeks, open
    tabs from a browser that hasn't said anything for a month, and anything of a removed device's
    that only made sense while it was there."""
    out: dict[str, int] = {}
    today = _today()
    # People who never chose keep the default, and have no state row until they write.
    old = (await db.execute(select(PwSyncRecord.id, PwSyncRecord.user_id, PwSyncRecord.slot).where(PwSyncRecord.kind == "history"))).all()
    keep: dict[uuid.UUID, int] = {u: d for u, d in (await db.execute(select(PwSyncState.user_id, PwSyncState.history_days))).all()}
    stale = [rid for rid, uid, slot in old if slot < (today - timedelta(days=keep.get(uid, HISTORY_DAYS_DEFAULT) - 1)).isoformat()]
    if stale:
        await db.execute(delete(PwSyncRecord).where(PwSyncRecord.id.in_(stale)))
    out["history"] = len(stale)
    now = _now()
    r = await db.execute(delete(PwSyncRecord).where(PwSyncRecord.kind == "sent", PwSyncRecord.created_at < now - timedelta(days=SENT_DAYS)))
    out["sent"] = r.rowcount or 0
    r = await db.execute(delete(PwSyncRecord).where(PwSyncRecord.kind == "tabs", PwSyncRecord.updated_at < now - timedelta(days=TABS_STALE_DAYS)))
    out["tabs"] = r.rowcount or 0
    revoked = select(PwDevice.id).where(PwDevice.revoked_at.is_not(None))
    r = await db.execute(delete(PwSyncRecord).where(PwSyncRecord.kind.in_(("tabs", "sent")), PwSyncRecord.device_id.in_(revoked)))
    out["revoked"] = r.rowcount or 0
    if stale or out["sent"] or out["tabs"] or out["revoked"]:
        await db.execute(update(PwSyncState).values(rev=PwSyncState.rev + 1))
    await db.commit()
    return out


async def sent_waiting(db: AsyncSession, device_id: uuid.UUID) -> int:
    """For the bare counts a locked phone polls: how many tabs were sent to it."""
    return int(await db.scalar(select(func.count()).select_from(PwSyncRecord).where(PwSyncRecord.kind == "sent", PwSyncRecord.device_id == device_id)) or 0)
