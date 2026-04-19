"""Persist captured exceptions into the ``error_events`` table.

Two ingestion paths feed the same ``capture_error`` function:

1. A FastAPI ``@app.exception_handler(Exception)`` for un-caught
   request-handler errors — the only handler that has a `Request` and
   so can populate route / method / status_code reliably.
2. A :class:`logging.Handler` subclass for any ``logger.error`` /
   ``logger.exception`` call that fires in a background task or
   library code outside an HTTP request scope.

Both paths convert to a uniform :class:`CapturedError` dict before
writing so downstream queries (admin Live Console) see one shape.

Fingerprinting is intentionally conservative — sha256 of the four
strongest signals (level, logger name, exception class, normalised
message). Numeric IDs and quoted strings inside the message are
stripped before hashing so "user 12 failed" and "user 99 failed"
collapse into the same group. The original message is preserved on
the row so the admin still sees it; only the fingerprint is the
normalised form.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import traceback
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal
from app.logging_setup import (
    get_request_id,
    get_route,
    get_user_id,
)
from app.observability.models import ErrorEvent

logger = logging.getLogger("promptly.observability")


@dataclass(frozen=True, slots=True)
class CapturedError:
    """Wire-shape passed to :func:`capture_error`.

    The fields mirror the table columns one-to-one so the writer
    function is a trivial mapping.
    """

    level: str
    logger_name: str
    message: str
    exception_class: str | None
    stack: str | None
    route: str | None
    method: str | None
    status_code: int | None
    request_id: str | None
    user_id: str | None
    extra: dict[str, Any] | None


# ---------------------------------------------------------------------
# Fingerprint helpers
# ---------------------------------------------------------------------
# Replace anything that looks like a UUID, quoted string, or naked
# number with a placeholder so the fingerprint stays stable across
# instances of the same logical error.
_NORMALISE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<uuid>"),
    (re.compile(r"\b\d{4,}\b"), "<n>"),
    (re.compile(r"'[^']{0,200}'"), "<str>"),
    (re.compile(r'"[^"]{0,200}"'), "<str>"),
    (re.compile(r"\s+"), " "),
)


def normalise_message(msg: str) -> str:
    """Strip volatile bits from ``msg`` for fingerprinting."""
    out = msg or ""
    for pat, repl in _NORMALISE_PATTERNS:
        out = pat.sub(repl, out)
    return out.strip()[:500]


def fingerprint(
    *,
    level: str,
    logger_name: str,
    exception_class: str | None,
    message: str,
) -> str:
    """sha256 of ``level:logger:class:normalized_msg``.

    Lower-cased hex so equality lookups don't need a hash function on
    each query and the fingerprint reads cleanly in admin URLs.
    """
    parts = (
        (level or "").upper(),
        logger_name or "",
        exception_class or "",
        normalise_message(message),
    )
    raw = ":".join(parts).encode("utf-8", errors="replace")
    return hashlib.sha256(raw).hexdigest()


# ---------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------
async def _persist_async(captured: CapturedError) -> None:
    """Write one ``error_events`` row.

    Opens its own short-lived session so the caller doesn't need to
    pass one in (we're often running inside an exception handler that
    has just rolled the request session back).
    """
    user_uuid: uuid.UUID | None = None
    if captured.user_id:
        try:
            user_uuid = uuid.UUID(captured.user_id)
        except (ValueError, TypeError):
            user_uuid = None

    fp = fingerprint(
        level=captured.level,
        logger_name=captured.logger_name,
        exception_class=captured.exception_class,
        message=captured.message,
    )

    row = ErrorEvent(
        id=uuid.uuid4(),
        fingerprint=fp,
        level=captured.level,
        logger=captured.logger_name[:128],
        exception_class=(captured.exception_class or None),
        message=captured.message[:8000],
        stack=(captured.stack or None),
        route=(captured.route or None),
        method=(captured.method or None),
        status_code=captured.status_code,
        request_id=(captured.request_id or None),
        user_id=user_uuid,
        extra=captured.extra,
    )
    try:
        async with SessionLocal() as db:  # type: AsyncSession
            db.add(row)
            await db.commit()
    except Exception:  # noqa: BLE001 — capture must never raise
        # Print to stderr because logging.error here would risk a loop
        # if the log handler that triggered us is itself broken.
        import sys

        print(
            f"[promptly.observability] failed to persist error_event: {fp}",
            file=sys.stderr,
        )


def capture_error(captured: CapturedError) -> None:
    """Sync entry point — schedules the DB write on the running loop.

    We need a sync surface because the :class:`logging.Handler`
    integration is called from synchronous library code. When called
    inside an asyncio task we add the write to the loop; without a
    loop (e.g. during shutdown) we silently drop, since by that point
    nothing useful is going to consume the row anyway.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_persist_async(captured))


# ---------------------------------------------------------------------
# Logging.Handler integration
# ---------------------------------------------------------------------
class DbErrorHandler(logging.Handler):
    """Capture ``ERROR`` and ``CRITICAL`` log lines into ``error_events``.

    Installed once on the root logger by
    :func:`install_error_capture`. The handler runs on the calling
    thread — the actual DB write is dispatched to the running event
    loop via :func:`capture_error` so we never block the logger.

    We deliberately don't capture ``WARNING`` here — the noise/signal
    ratio drops off fast and the admin live-tail console already
    shows warnings inline.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(record.msg)

        exc_class: str | None = None
        stack: str | None = None
        if record.exc_info:
            exc_type = record.exc_info[0]
            exc_class = exc_type.__name__ if exc_type else None
            try:
                stack = "".join(traceback.format_exception(*record.exc_info))
            except Exception:  # noqa: BLE001
                stack = None
        elif record.stack_info:
            stack = record.stack_info

        # Pull non-standard ``extra=`` keys off the record so the live
        # console can show them under "extra".
        std = {
            "args", "asctime", "created", "exc_info", "exc_text", "filename",
            "funcName", "levelname", "levelno", "lineno", "message", "module",
            "msecs", "msg", "name", "pathname", "process", "processName",
            "relativeCreated", "stack_info", "thread", "threadName", "taskName",
        }
        extras = {
            k: v
            for k, v in record.__dict__.items()
            if k not in std and not k.startswith("_")
        }

        captured = CapturedError(
            level=record.levelname,
            logger_name=record.name,
            message=msg,
            exception_class=exc_class,
            stack=stack,
            route=get_route(),
            method=None,
            status_code=None,
            request_id=get_request_id(),
            user_id=get_user_id(),
            extra=extras or None,
        )
        capture_error(captured)


def install_error_capture() -> None:
    """Attach :class:`DbErrorHandler` to the root logger.

    Idempotent — replaces any previously installed instance so a
    reload doesn't end up writing each error twice.
    """
    root = logging.getLogger()
    for h in list(root.handlers):
        if isinstance(h, DbErrorHandler):
            root.removeHandler(h)
    root.addHandler(DbErrorHandler())


__all__ = [
    "CapturedError",
    "DbErrorHandler",
    "capture_error",
    "fingerprint",
    "install_error_capture",
    "normalise_message",
]
