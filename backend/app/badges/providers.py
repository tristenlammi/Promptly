"""The sidebar's badge parts (see :mod:`app.badges`).

Each one reuses its app's own definition of "new", so the sidebar never
disagrees with the app:

* ``tasks``  open tasks due today or overdue, in your time zone, from your
  Tasks & Reminders file (Today's ``tasks_section`` buckets).
* ``mail``   unread conversations in the Inbox across your accounts
  (:func:`app.mail.apps.inbox_unread`, Today's number).
* ``rooms``  unread rooms, DMs and mentions (:func:`app.rooms.core.unread_total`,
  the Rooms app's own total and its icon badge) plus missed DM calls you
  haven't seen (:func:`app.calls.dm.missed_count`, the Calls tab's badge).
* ``porch``  Activity you haven't seen (comments and replies on your posts,
  mentions, reactions, plus invites and tag requests waiting for an answer:
  :func:`app.porch.activity.unseen_count`, the Activity tab's badge) plus
  new posts in the groups you've ticked since you last had your feed open
  (:func:`app.porch.today.new_post_count`, Today's Porch card).
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

from . import badge


@badge("tasks", "due")
async def tasks_due(db: AsyncSession, user: User) -> int:
    from app.items import service
    from app.items.kinds.tasks import logic

    found = await service.primary_file(db, user, "tasks")
    if found is None:
        return 0
    _row, doc = found
    data = dict(doc.data or {})
    spec = service.get_spec("tasks")
    if spec is not None and spec.migrate is not None and doc.schema_version < spec.version:
        # An old file, read in today's shape (without writing it back here).
        data = spec.validate(spec.migrate(data, doc.schema_version))
    today = datetime.now(timezone.utc).astimezone(service.zone_for(user)).date()
    b = logic.buckets({"tasks": data.get("tasks") or []}, today, days=0)
    return len(b["overdue"]) + len(b["today"])


@badge("mail", "unread")
async def mail_unread(db: AsyncSession, user: User) -> int:
    from app.mail.apps import inbox_unread
    from app.mail.router import _my_account_ids

    return await inbox_unread(db, await _my_account_ids(db, user))


@badge("rooms", "unread")
async def rooms_unread(db: AsyncSession, user: User) -> int:
    from app.rooms import core

    return await core.unread_total(db, user.id)


@badge("rooms", "missed_calls")
async def rooms_missed_calls(db: AsyncSession, user: User) -> int | None:
    from app.calls import access, dm

    if not await access.voice_allowed(db, user):
        return None
    return await dm.missed_count(db, user.id)


@badge("porch", "activity")
async def porch_activity(db: AsyncSession, user: User) -> int | None:
    from app.porch import activity, deps

    if not await deps.allowed(db, user):
        return None
    return await activity.unseen_count(db, user)


@badge("porch", "new_posts")
async def porch_new_posts(db: AsyncSession, user: User) -> int | None:
    from app.porch import deps, today

    if not await deps.allowed(db, user):
        return None
    return await today.new_post_count(db, user)
