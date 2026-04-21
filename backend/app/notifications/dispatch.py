"""Fire-and-forget push dispatch.

The rest of the app calls one function — :func:`notify_user` — and
the machinery here takes care of:

1. Looking up the user's preferences and honouring the master switch
   + per-category toggles.
2. Enumerating their active subscriptions.
3. Serialising the payload the service worker expects
   (``{"title", "body", "url", "tag"}``) and sending it via
   ``pywebpush`` to each endpoint.
4. Removing subscriptions the push service reports as gone
   (404 / 410) so we don't spin forever on a device the user
   unsubscribed from.

Every call is scheduled with ``asyncio.create_task`` so the calling
request returns immediately; a slow push service or a temporary
network blip never blocks the HTTP reply that triggered the
notification.

Notification categories are declared as a module-level tuple. The
router + dispatch helper both import from here so a typo in a
category id surfaces at import-time via mypy / the linter instead
of turning into a silent "notification never fires" bug."""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import SessionLocal
from app.notifications.models import PushPreferences, PushSubscription

logger = logging.getLogger("promptly.notifications")


# Canonical set of push categories. Keep in sync with the frontend
# labels in ``NotificationsPanel.tsx`` — mismatches produce a
# notification the user can't mute from settings.
Category = Literal[
    "study_graded",
    "export_ready",
    "import_done",
    "shared_message",
    # ``test`` is reserved for the "send me a test push" button on
    # the Notifications panel and bypasses the per-category
    # preference lookup but *not* the master enable toggle.
    "test",
]

CATEGORIES: tuple[str, ...] = (
    "study_graded",
    "export_ready",
    "import_done",
    "shared_message",
    "test",
)


# Session factory — dispatch runs outside of a request so we reuse
# the app-wide ``SessionLocal`` factory directly. Each dispatch
# call opens its own short-lived session via the factory's
# async-context-manager protocol so the lifetime is correctly
# scoped to the background task.
_session_maker = SessionLocal


@dataclass
class PushPayload:
    """Shape expected by the service worker's ``push`` handler."""

    title: str
    body: str
    url: str | None = None
    tag: str | None = None
    # Optional category id — echoed in the service-worker's
    # ``notificationclick`` handler for analytics / dedupe. Not
    # surfaced to the user.
    category: str | None = None

    def to_json(self) -> str:
        payload: dict[str, Any] = {"title": self.title, "body": self.body}
        if self.url:
            payload["url"] = self.url
        if self.tag:
            payload["tag"] = self.tag
        if self.category:
            payload["category"] = self.category
        return json.dumps(payload, ensure_ascii=False)


async def notify_user(
    *,
    user_id: UUID,
    category: Category,
    title: str,
    body: str,
    url: str | None = None,
    tag: str | None = None,
) -> None:
    """Schedule a push for every active subscription on ``user_id``.

    Non-blocking. Any failure is logged and swallowed — a broken
    notification subsystem must never surface as an HTTP 500 to the
    user whose request incidentally triggered it."""
    payload = PushPayload(
        title=title, body=body, url=url, tag=tag, category=category
    )
    try:
        asyncio.create_task(_dispatch(user_id=user_id, category=category, payload=payload))
    except RuntimeError:
        # No running event loop (e.g. called from a sync context —
        # we don't expect that, but defensive). Fall back to
        # ``asyncio.run`` so the caller still gets best-effort
        # delivery without having to know about loops.
        logger.warning("notify_user: no running loop; running synchronously")
        try:
            asyncio.run(_dispatch(user_id=user_id, category=category, payload=payload))
        except Exception:
            logger.exception("notify_user: sync fallback dispatch failed")


async def _dispatch(
    *, user_id: UUID, category: Category, payload: PushPayload
) -> None:
    settings = get_settings()
    if not settings.VAPID_PUBLIC_KEY or not settings.VAPID_PRIVATE_KEY:
        # VAPID not configured — stay quiet at WARN level so a prod
        # misconfiguration surfaces in logs without spamming at ERROR.
        logger.warning("push dispatch skipped: VAPID keys not configured")
        return

    async with _session_maker() as db:
        prefs = await _get_prefs(db, user_id)
        if not _should_send(prefs, category):
            return

        subs = (
            (
                await db.execute(
                    select(PushSubscription).where(
                        PushSubscription.user_id == user_id
                    )
                )
            )
            .scalars()
            .all()
        )
        if not subs:
            return

        # pywebpush is sync + blocking. Ship the per-subscription
        # send into a thread so one slow push service doesn't stall
        # the event loop for other work. They run concurrently via
        # ``asyncio.gather``.
        send_tasks = [
            asyncio.to_thread(
                _send_one,
                endpoint=sub.endpoint,
                p256dh=sub.p256dh,
                auth=sub.auth,
                payload_json=payload.to_json(),
                vapid_private_key=settings.VAPID_PRIVATE_KEY,
                vapid_contact=settings.VAPID_CONTACT,
            )
            for sub in subs
        ]
        results = await asyncio.gather(*send_tasks, return_exceptions=True)

        dead_ids: list[UUID] = []
        live_ids: list[UUID] = []
        for sub, res in zip(subs, results):
            if isinstance(res, _PushGone):
                dead_ids.append(sub.id)
            elif isinstance(res, Exception):
                logger.warning(
                    "push send failed for subscription %s: %s", sub.id, res
                )
            else:
                live_ids.append(sub.id)

        now = datetime.now(timezone.utc)
        if dead_ids:
            await db.execute(
                delete(PushSubscription).where(
                    PushSubscription.id.in_(dead_ids)
                )
            )
            logger.info(
                "pruned %d dead push subscription(s) for user %s",
                len(dead_ids),
                user_id,
            )
        if live_ids:
            await db.execute(
                update(PushSubscription)
                .where(PushSubscription.id.in_(live_ids))
                .values(last_used_at=now)
            )
        await db.commit()


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


class _PushGone(Exception):
    """Marker raised by :func:`_send_one` for 404/410 responses.

    Not an error per se — it just means the browser has
    unsubscribed (tab closed permanently, incognito expired, user
    revoked permission) and we should drop the row."""


def _send_one(
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload_json: str,
    vapid_private_key: str,
    vapid_contact: str,
) -> None:
    """Single sync send via ``pywebpush``. Translates the HTTP status
    into our internal ``_PushGone`` on endpoint-invalid responses so
    the async caller can bulk-delete rows without needing to know
    about ``pywebpush`` exception types."""
    # Import inside the function so the module still imports cleanly
    # in test / packaging environments where pywebpush isn't
    # installed (it's a runtime-only dependency).
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            },
            data=payload_json,
            vapid_private_key=vapid_private_key,
            vapid_claims={"sub": vapid_contact},
        )
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            raise _PushGone() from exc
        raise


async def _get_prefs(db: AsyncSession, user_id: UUID) -> PushPreferences:
    """Return (and lazily create) the prefs row for ``user_id``.

    A missing row means "never visited the settings page yet";
    honouring all-defaults for new users matches the "helpful by
    default" posture of the rest of the onboarding."""
    row = await db.get(PushPreferences, user_id)
    if row is None:
        row = PushPreferences(user_id=user_id)
        db.add(row)
        # We flush but don't commit — the caller (``_dispatch``)
        # owns the transaction boundary so dead-sub pruning runs
        # in the same commit.
        await db.flush()
    return row


def _should_send(prefs: PushPreferences, category: str) -> bool:
    if not prefs.enabled:
        return False
    if category == "test":
        # Diagnostic pushes obey the master switch but not the
        # per-category flags — otherwise a user with everything
        # turned off couldn't verify their setup.
        return True
    return bool(getattr(prefs, category, False))
