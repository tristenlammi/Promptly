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

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.background import spawn
from app.database import SessionLocal
from app.notifications.models import (
    Notification,
    PushPreferences,
    PushSubscription,
)

logger = logging.getLogger("promptly.notifications")


# Canonical set of push categories. Keep in sync with the frontend
# labels in ``NotificationsPanel.tsx`` — mismatches produce a
# notification the user can't mute from settings.
Category = Literal[
    "export_ready",
    "import_done",
    "shared_message",
    "task_complete",
    # Collaboration events (0133): @-mentions in comments, card
    # assignments, and workspace invites. These also land in the
    # persistent inbox (all notify_user calls do).
    "mention",
    "assignment",
    "invite",
    # Phase 12 — email integration notifications.
    # ``email_brief``  — daily AI digest of what needs attention.
    # ``email_action`` — instant alert for high-priority / VIP / deadline mail.
    "email_brief",
    "email_action",
    # Admin-facing operational alerts (0153) — e.g. a search provider was
    # auto-paused after a quota/auth failure. Only sent to admins.
    "system_alert",
    # Item Store reminders (0229): a habit, a med dose, a trip — asked for
    # by an item file (app/items).
    "item_reminder",
    # A message in Rooms (0230) — push only, never an inbox row.
    "room_message",
    # Calendar (0231): invites, changes, cancellations, answers, reminders.
    "calendar",
    # New mail, and snoozed mail coming back. Push only, never an inbox row.
    "mail",
    # New-device approvals and shared-vault invites. Never any vault data.
    "passwords",
    # Forms (0290): new answers to your forms ("BBQ RSVP: 6 new answers"),
    # and your form closing. Counts only, never an answer.
    "form_response",
    # Calls (0282): a DM call ringing you, a missed call, and the silent
    # "answered on another device" that stops the ringing. Push only.
    "call",
    # Notes: someone shared a note with you (app/notes/push.py). Nothing
    # time-critical — a note's reminders arrive as ``item_reminder``.
    "notes",
    # Porch (0272): posts, comments, mentions, tags, invites, reactions,
    # birthdays — one switch here; per kind in Porch → Settings.
    "porch",
    # Talk (0370): "send that to my phone", and car answers cut short.
    # You asked a moment ago, so quiet hours don't hold it.
    "talk_followup",
    # P Maps: someone is sharing the trip they're driving with you.
    "maps",
    # ``test`` is reserved for the "send me a test push" button on
    # the Notifications panel and bypasses the per-category
    # preference lookup but *not* the master enable toggle.
    "test",
]

CATEGORIES: tuple[str, ...] = (
    "export_ready",
    "import_done",
    "shared_message",
    "task_complete",
    "mention",
    "assignment",
    "invite",
    "email_brief",
    "email_action",
    "system_alert",
    "item_reminder",
    "room_message",
    "calendar",
    "mail",
    "passwords",
    # Forms
    "form_response",
    "call",
    "notes",
    "porch",
    # Talk
    "talk_followup",
    "maps",
    "test",
)


@dataclass(frozen=True)
class Rule:
    """How a category behaves with quiet hours and the daily summary.

    ``holdable`` — quiet hours may hold it (sent when they end). Anything
    urgent or about safety says False and always gets through.
    ``summary`` — offered as "Daily summary" in Account → Notifications.
    ``app`` / ``one`` / ``many`` — how held pushes are counted ("3 new
    messages in Rooms"). ``kinds`` — per-kind nouns for an app whose pushes
    carry ``extra={"kind": …}`` (Porch: posts, comments…).
    ``url`` — where a collapsed push opens."""

    holdable: bool
    app: str = ""
    one: str = "notification"
    many: str = "notifications"
    url: str = "/"
    summary: bool = False
    kinds: tuple[tuple[str, str, str], ...] = ()
    #: Each push is a running total for its ``tag`` ("6 new answers"): a
    #: held one replaces the last held one with the same tag (its
    #: ``extra.count`` is the total, not one more), and an unread inbox row
    #: with the same link is replaced instead of stacking.
    coalesce: bool = False


# THE central list: every category says whether quiet hours may hold it.
# Always through: calendar reminders, Passwords, admin/security alerts, the
# test push and item reminders (medication, habits — asked for at a time).
# A new category (Calls' ringing ``call``, Porch, Notes, Forms) adds itself
# here; an import-time check below fails if one is missing.
RULES: dict[str, Rule] = {
    "export_ready": Rule(True, one="export ready", many="exports ready", url="/files"),
    "import_done": Rule(True, one="import finished", many="imports finished", url="/"),
    "shared_message": Rule(True, one="message in a shared chat", many="messages in shared chats", url="/"),
    "task_complete": Rule(True, one="automation result", many="automation results", url="/"),
    "mention": Rule(True, one="mention", many="mentions", url="/"),
    "assignment": Rule(True, one="assignment", many="assignments", url="/"),
    "invite": Rule(True, one="invite", many="invites", url="/"),
    "email_brief": Rule(True, one="email digest", many="email digests", url="/mail"),
    "email_action": Rule(True, app="Mail", one="important email", many="important emails", url="/mail"),
    "system_alert": Rule(False),
    "item_reminder": Rule(False),
    "room_message": Rule(True, app="Rooms", one="new message", many="new messages", url="/rooms", summary=True),
    "calendar": Rule(False),
    "mail": Rule(True, app="Mail", one="new email", many="new emails", url="/mail", summary=True),
    "passwords": Rule(False),
    # Calls: a ringing call is never held (it'd be over by morning), nor is
    # the push that stops it ringing on your other devices.
    # Calls ring through quiet hours. Someone who chose "Don't ring me
    # during quiet hours" gets no ring, and the missed call is held
    # (calls/ring.py holds it itself, as this rule never does): "2 missed
    # calls in Calls".
    "call": Rule(False, app="Calls", one="call", many="calls", url="/rooms/calls", kinds=(("call_missed", "missed call", "missed calls"),)),
    "test": Rule(False),
    # Forms: answers come in bursts; one row and one push per form, updated.
    "form_response": Rule(
        True,
        app="Forms",
        one="new answer",
        many="new answers",
        url="/forms",
        summary=True,
        kinds=(("closed", "form closed", "forms closed"), ("busy", "busy form", "busy forms")),
        coalesce=True,
    ),
    # Notes: someone shared a note with you. Nothing urgent (reminders
    # come as ``item_reminder``), so quiet hours may hold it.
    "notes": Rule(True, app="Notes", one="shared note", many="shared notes", url="/notes"),
    # Porch (WP-P1.7): holdable, summary-capable, counted per kind.
    "porch": Rule(
        True, app="Porch", one="update", many="updates", url="/porch/", summary=True,
        kinds=(
            ("post", "new post", "new posts"),
            ("comment", "comment", "comments"),
            ("reply", "reply", "replies"),
            ("mention", "mention", "mentions"),
            ("reaction", "reaction", "reactions"),
            ("tag", "tag request", "tag requests"),
            ("invite", "group invite", "group invites"),
            ("birthday", "birthday", "birthdays"),
            ("removed", "note from the admin", "notes from the admin"),
            # Porch reports go to the group's admins (WP-P2.0).
            ("report", "report", "reports"),
        ),
    ),
    # Talk (phase 2): asked for a moment ago; never held, never summarised.
    "talk_followup": Rule(False),
}
# P Maps: "Sam is sharing a trip with you". It's about right now (it would be
# over by morning), so quiet hours don't hold it; the switch turns it off.
RULES["maps"] = Rule(False, app="P Maps", one="shared trip", many="shared trips", url="/maps?panel=people")
_missing = set(CATEGORIES) - set(RULES)
assert not _missing, f"notification categories without a quiet-hours rule: {_missing}"

#: Categories a person can set to "Daily summary".
SUMMARY_CATEGORIES: tuple[str, ...] = tuple(c for c, r in RULES.items() if r.summary and r.holdable)


def rule_for(category: str) -> Rule:
    """Unknown categories are treated as urgent: never held."""
    return RULES.get(category) or Rule(False)


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
    # Extra fields for the service worker (Rooms: the sender's icon, the
    # line to stack, the unread count for the app badge). Push only.
    extra: dict[str, Any] | None = None
    # Web Push delivery: ``ttl`` seconds the push service keeps it for an
    # offline device (None: pywebpush's default, 0 = now or never), and
    # ``urgency`` (``high`` wakes a dozing phone at once). Not in the body.
    ttl: int | None = None
    urgency: str | None = None

    def to_json(self) -> str:
        payload: dict[str, Any] = {**(self.extra or {}), "title": self.title, "body": self.body}
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
    actor_user_id: UUID | None = None,
    workspace_id: UUID | None = None,
    inbox: bool = True,
    extra: dict[str, Any] | None = None,
    summary: bool = False,
    ttl: int | None = None,
    urgency: str | None = None,
) -> None:
    """Schedule a push for every active subscription on ``user_id`` and
    write the durable inbox row.

    Non-blocking. Any failure is logged and swallowed — a broken
    notification subsystem must never surface as an HTTP 500 to the
    user whose request incidentally triggered it. The inbox row is
    written regardless of push preferences (those gate the nudge, not
    the record); ``test`` pushes are the one category that never
    persists.

    Pass ``actor_user_id`` for anything a person did: a push (and inbox
    row) from someone the recipient has blocked, or who has blocked them,
    is dropped. ``summary=True`` holds it for the daily summary whatever
    the category's setting (an app's own per-kind "Daily summary" switch);
    quiet hours may also hold it (see :data:`RULES`). ``ttl`` / ``urgency``:
    see :class:`PushPayload` (a ringing call: 45 s, high)."""
    payload = PushPayload(
        title=title, body=body, url=url, tag=tag, category=category, extra=extra,
        ttl=ttl, urgency=urgency,
    )
    coro = _dispatch(
        user_id=user_id,
        category=category,
        payload=payload,
        actor_user_id=actor_user_id,
        workspace_id=workspace_id,
        inbox=inbox,
        summary=summary,
    )
    # Check for a loop up front rather than letting ``spawn`` report it:
    # ``spawn`` closes the coroutine when there's none, and this path wants
    # to still run it synchronously.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # No running event loop (e.g. called from a sync context —
        # we don't expect that, but defensive). Fall back to
        # ``asyncio.run`` so the caller still gets best-effort
        # delivery without having to know about loops.
        logger.warning("notify_user: no running loop; running synchronously")
        try:
            asyncio.run(coro)
        except Exception:
            logger.exception("notify_user: sync fallback dispatch failed")
    else:
        # Held until done — a dropped task here means a notification the
        # user simply never receives, with nothing logged.
        spawn(coro, name=f"notify-{category}-{user_id}")


# Per-user inbox cap — enough scroll-back to catch up after a holiday
# without the table growing unboundedly.
_INBOX_CAP = 200
_AUTOMATION_INBOX_CAP = 50


async def _dispatch(
    *,
    user_id: UUID,
    category: Category,
    payload: PushPayload,
    actor_user_id: UUID | None = None,
    workspace_id: UUID | None = None,
    inbox: bool = True,
    summary: bool = False,
) -> dict[str, int]:
    """Write the inbox row and push to every device. Returns what happened
    to the pushes: ``{"delivered", "failed", "removed", "held", "blocked"}``."""
    outcome = {"delivered": 0, "failed": 0, "removed": 0, "held": 0, "blocked": 0}
    # The kind decides how urgently it's delivered (``default_urgency``).
    if payload.category is None:
        payload.category = category
    async with _session_maker() as db:
        # 0) Blocks (D7): nothing at all from someone the recipient blocked,
        #    or who blocked them — not the push, not the inbox row. Central,
        #    so every app that passes ``actor_user_id`` gets it.
        if actor_user_id is not None and actor_user_id != user_id:
            from app.people.blocks import either

            if await either(db, user_id, actor_user_id):
                outcome["blocked"] = 1
                return outcome
        # 1) Durable inbox row first — it must land even when the user
        #    has push muted or owns no subscriptions.
        # ``inbox=False``: a push only (a chat message — the app is its own
        # inbox, and a busy room would bury everything else).
        if category != "test" and inbox:
            try:
                # An automation keeps one rolling inbox row — its latest
                # result — instead of one per run (R-152).
                if rule_for(category).coalesce and payload.url:
                    # A running total (Forms): the unread row for the same
                    # place is replaced, not stacked.
                    await db.execute(
                        delete(Notification).where(
                            Notification.user_id == user_id,
                            Notification.category == category,
                            Notification.url == payload.url,
                            Notification.read_at.is_(None),
                        )
                    )
                if category == "task_complete" and payload.url:
                    await db.execute(
                        delete(Notification).where(
                            Notification.user_id == user_id,
                            Notification.category == "task_complete",
                            Notification.url == payload.url,
                        )
                    )
                db.add(
                    Notification(
                        user_id=user_id,
                        category=category,
                        title=payload.title[:200],
                        body=payload.body,
                        url=payload.url,
                        actor_user_id=actor_user_id,
                        workspace_id=workspace_id,
                    )
                )
                await db.flush()
                # Prune beyond the cap (cheap: only fires on insert) — per
                # kind: automation results have their own budget, so they
                # can never push out mentions, invites or assignments.
                is_auto = category == "task_complete"
                stale = (
                    await db.execute(
                        select(Notification.id)
                        .where(
                            Notification.user_id == user_id,
                            (Notification.category == "task_complete")
                            if is_auto
                            else (Notification.category != "task_complete"),
                        )
                        .order_by(Notification.created_at.desc())
                        .offset(_AUTOMATION_INBOX_CAP if is_auto else _INBOX_CAP)
                    )
                ).scalars().all()
                if stale:
                    await db.execute(
                        delete(Notification).where(Notification.id.in_(stale))
                    )
                await db.commit()
            except Exception:
                logger.exception("inbox row write failed")
                await db.rollback()
        vapid = await _vapid(db)
        if vapid is None:
            return outcome

        prefs = await _get_prefs(db, user_id)
        if not _should_send(prefs, category):
            return outcome

        if not await _has_subscriptions(db, user_id):
            return outcome

        # 2) Quiet hours / daily summary: hold it for later instead.
        from app.notifications import quiet

        reason = await quiet.hold_reason(db, prefs, category, summary=summary)
        if reason is not None:
            await quiet.hold(
                db, user_id=user_id, category=category, payload=payload,
                actor_user_id=actor_user_id, reason=reason,
            )
            await db.commit()
            outcome["held"] = 1
            return outcome

        sent = await deliver(db, user_id, payload, vapid=vapid)
        outcome.update(sent)
        return outcome


async def _vapid(db: AsyncSession) -> tuple[str, str] | None:
    """(private key, contact) — or None when push isn't set up.

    Read from the DB rather than ``settings`` — the bootstrap
    auto-generates a keypair on first boot and admins can rotate via
    Admin → Settings without touching ``.env``. Static env vars are
    still mirrored into the same column at boot if set, so existing
    deployments behave identically."""
    app_settings_row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    vapid_private = app_settings_row.vapid_private_key if app_settings_row else None
    vapid_contact = (
        app_settings_row.vapid_contact if app_settings_row else None
    ) or "mailto:admin@localhost"
    if not vapid_private:
        # Should never happen on a healthy install; log loud enough
        # to surface in Admin → Console without spamming.
        logger.warning("push dispatch skipped: VAPID private key not configured")
        return None
    return vapid_private, vapid_contact


async def _has_subscriptions(db: AsyncSession, user_id: UUID) -> bool:
    got = await db.execute(
        select(PushSubscription.id)
        .where(PushSubscription.user_id == user_id, PushSubscription.enabled.is_(True))
        .limit(1)
    )
    return got.first() is not None


async def deliver(
    db: AsyncSession,
    user_id: UUID,
    payload: PushPayload,
    *,
    vapid: tuple[str, str] | None = None,
) -> dict[str, int]:
    """Push ``payload`` to every device ``user_id`` has, now — no
    preference, block or quiet-hours checks (the callers made them).
    Prunes dead subscriptions and commits. Used by :func:`_dispatch` and by
    the release of held pushes (``notifications/loops.py``)."""
    outcome = {"delivered": 0, "failed": 0, "removed": 0}
    if vapid is None:
        vapid = await _vapid(db)
        if vapid is None:
            return outcome
    vapid_private, vapid_contact = vapid
    subs = (
        (
            await db.execute(
                # Only devices whose own switch is on (0442).
                select(PushSubscription).where(
                    PushSubscription.user_id == user_id,
                    PushSubscription.enabled.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
    if not subs:
        return outcome

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
            vapid_private_key=vapid_private,
            vapid_contact=vapid_contact,
            ttl=payload.ttl if payload.ttl is not None else DEFAULT_TTL,
            urgency=payload.urgency or default_urgency(payload.category),
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
    outcome["delivered"] = len(live_ids)
    outcome["removed"] = len(dead_ids)
    outcome["failed"] = len(subs) - len(live_ids) - len(dead_ids)
    return outcome


async def send_test_push(user_id: UUID) -> dict[str, int]:
    """A test push, awaited, so the caller can say what actually arrived
    — it used to report how many devices were *registered* (R-167)."""
    return await _dispatch(
        user_id=user_id,
        category="test",
        payload=PushPayload(
            title="Promptly",
            body="Push notifications are set up correctly.",
            url="/account/notifications",
            tag="promptly-test",
            category="test",
        ),
    )


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


class _PushGone(Exception):
    """Marker raised by :func:`_send_one` for 404/410 responses.

    Not an error per se — it just means the browser has
    unsubscribed (tab closed permanently, incognito expired, user
    revoked permission) and we should drop the row."""


# How long the push service keeps a push for a phone it can't reach right now.
# pywebpush's own default is 0 seconds: "now or never", so a phone asleep in a
# pocket (most of the time) never got anything but a test sent while holding it.
DEFAULT_TTL = 24 * 3600

# Pushes a person expects at once: these wake a dozing phone ("high");
# everything else may wait for the phone's next check-in ("normal").
_URGENT = frozenset({"room_message", "call", "item_reminder", "calendar", "talk_followup", "maps", "test"})


def default_urgency(category: str | None) -> str:
    return "high" if category in _URGENT else "normal"


def _send_one(
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload_json: str,
    vapid_private_key: str,
    vapid_contact: str,
    ttl: int | None = None,
    urgency: str | None = None,
) -> None:
    """Single sync send via ``pywebpush``. Translates the HTTP status
    into our internal ``_PushGone`` on endpoint-invalid responses so
    the async caller can bulk-delete rows without needing to know
    about ``pywebpush`` exception types."""
    # Import inside the function so the module still imports cleanly
    # in test / packaging environments where pywebpush isn't
    # installed (it's a runtime-only dependency).
    from pywebpush import WebPushException, webpush

    extra: dict[str, Any] = {}
    if ttl is not None:
        extra["ttl"] = int(ttl)
    if urgency:
        extra["headers"] = {"Urgency": urgency}
    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            },
            data=payload_json,
            vapid_private_key=_signing_key(vapid_private_key),
            vapid_claims={"sub": vapid_contact},
            **extra,
        )
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            raise _PushGone() from exc
        raise


def _signing_key(vapid_private_key: str) -> Any:
    """The stored VAPID key in a form ``pywebpush`` can sign with.

    We store a PEM (``bootstrap._generate_vapid_keypair``), but pywebpush
    hands any string that isn't a file path to ``Vapid.from_string``, which
    only reads bare base64 (raw or DER) and fails on a PEM: every push
    failed with "Could not deserialize key data". So load a PEM ourselves
    and pass the key object; a bare base64 key (an old ``.env`` value) goes
    through as it is."""
    if "-----BEGIN" not in vapid_private_key:
        return vapid_private_key
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid

    return Vapid(
        private_key=serialization.load_pem_private_key(
            vapid_private_key.strip().encode("ascii"), password=None
        )
    )


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
    if category in ("test", "system_alert"):
        # Diagnostic pushes obey the master switch but not the
        # per-category flags — otherwise a user with everything
        # turned off couldn't verify their setup. Admin alerts (a backup
        # failed, a connector is down) have no flag of their own, so the
        # lookup always said no and they never pushed (R-167).
        return True
    return bool(getattr(prefs, category, False))
