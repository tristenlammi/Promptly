"""Items' background work, in-process (one uvicorn worker):

* **reminders** — every 30 s, send the due ones (push + inbox), once each.
  Hourly, recompute every file whose kind has reminders, so a recurring
  one keeps coming even when nobody opens the file.
* **periodic** — each kind's ``periodic`` job for every file of that kind,
  at most every ``periodic_minutes`` (a bank sync).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select

from app.database import SessionLocal

logger = logging.getLogger("promptly.items.loops")

_TICK_S = 30
_REFRESH_EVERY = timedelta(hours=1)
_LATE = timedelta(hours=6)  # a reminder this overdue (server was down) is dropped, not sent


async def send_due(db) -> int:  # noqa: ANN001
    from app.files.models import UserFile
    from app.items.models import ItemReminder
    from app.notifications.dispatch import notify_user

    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(ItemReminder, UserFile)
            .join(UserFile, UserFile.id == ItemReminder.file_id)
            .where(ItemReminder.sent_at.is_(None), ItemReminder.due_at <= now)
            .order_by(ItemReminder.due_at)
            .limit(200)
            .with_for_update(of=ItemReminder, skip_locked=True)
        )
    ).all()
    n = 0
    for rem, f in rows:
        rem.sent_at = now
        if f.trashed_at is not None or now - rem.due_at > _LATE:
            continue
        await notify_user(
            user_id=rem.user_id,
            category="item_reminder",
            title=rem.title,
            body=rem.body,
            url=f"/files/item/{f.id}",
            tag=f"item:{rem.key}"[:120],
        )
        n += 1
    await db.commit()
    return n


async def refresh_all(db) -> None:  # noqa: ANN001
    from app.auth.models import User
    from app.files.models import UserFile
    from app.items.models import ItemDocument
    from app.items.registry import all_specs
    from app.items.service import refresh_reminders

    kinds = [k for k, s in all_specs().items() if s.reminders is not None]
    if not kinds:
        return
    rows = (
        await db.execute(
            select(UserFile, ItemDocument, User)
            .join(ItemDocument, ItemDocument.file_id == UserFile.id)
            .join(User, User.id == UserFile.user_id)
            .where(ItemDocument.kind.in_(kinds), UserFile.trashed_at.is_(None))
        )
    ).all()
    for f, doc, owner in rows:
        try:
            await refresh_reminders(db, f, doc, owner)
        except Exception:  # noqa: BLE001
            logger.exception("refreshing reminders for %s failed", f.id)
    await db.commit()


async def run_periodic(db) -> None:  # noqa: ANN001
    from app.auth.models import User
    from app.files.models import UserFile
    from app.items import service
    from app.items.models import ItemDocument
    from app.items.registry import all_specs
    from app.items.spec import PeriodicContext

    now = datetime.now(timezone.utc)
    for spec in all_specs().values():
        if spec.periodic is None:
            continue
        cutoff = now - timedelta(minutes=max(5, spec.periodic_minutes))
        ids = (
            await db.execute(
                select(ItemDocument.file_id)
                .join(UserFile, UserFile.id == ItemDocument.file_id)
                .where(
                    ItemDocument.kind == spec.kind,
                    UserFile.trashed_at.is_(None),
                    or_(ItemDocument.periodic_at.is_(None), ItemDocument.periodic_at < cutoff),
                )
                .limit(50)
            )
        ).scalars().all()
        for fid in ids:
            async with SessionLocal() as s:
                doc = await s.get(ItemDocument, fid)
                f = await s.get(UserFile, fid)
                owner = await s.get(User, f.user_id) if f is not None else None
                if doc is None or f is None or owner is None:
                    continue
                doc.periodic_at = now
                await s.commit()
                base = service.make_context(s, owner, fid, spec)

                async def update(fn, label: str = "", _fid=fid, _s=s, _owner=owner) -> bool:  # noqa: ANN001
                    import copy

                    row, d, _ = await service.load(_s, _owner, _fid, need="edit", lock=True)
                    data = copy.deepcopy(d.data)
                    fn(data)
                    before = d.revision
                    await service.save_data(_s, _owner, row, d, data, base_revision=None, source="edit")
                    await _s.commit()
                    return d.revision != before

                async def get_state(key: str, secret: bool = False, _fid=fid, _s=s):  # noqa: ANN202
                    return await service.get_state(_s, _fid, key, secret=secret)

                async def set_state(key: str, value, secret: bool = False, _fid=fid, _s=s) -> None:  # noqa: ANN001
                    await service.set_state(_s, _fid, key, value, secret=secret)
                    await _s.commit()

                pctx = PeriodicContext(
                    db=s, user=owner, file_id=fid, now=base.now, tz=base.tz, read_item=base.read_item,
                    update=update, get_state=get_state, set_state=set_state,
                )
                try:
                    async with asyncio.timeout(120):
                        await spec.periodic(pctx)
                except Exception:  # noqa: BLE001 — one file's sync mustn't stop the rest
                    logger.exception("periodic %s for %s failed", spec.kind, fid)
                    await s.rollback()


async def _loop() -> None:
    last_refresh = datetime.min.replace(tzinfo=timezone.utc)
    last_periodic = datetime.min.replace(tzinfo=timezone.utc)
    logger.info("Item loops started")
    while True:
        try:
            async with SessionLocal() as db:
                await send_due(db)
            now = datetime.now(timezone.utc)
            if now - last_refresh > _REFRESH_EVERY:
                last_refresh = now
                async with SessionLocal() as db:
                    await refresh_all(db)
            if now - last_periodic > timedelta(minutes=5):
                last_periodic = now
                async with SessionLocal() as db:
                    await run_periodic(db)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — never let the loop die
            logger.exception("item loop pass failed")
        await asyncio.sleep(_TICK_S)


def start_item_loops() -> asyncio.Task:
    return asyncio.create_task(_loop(), name="item_loops")
