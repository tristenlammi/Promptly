"""JSON-structured logging + per-request context.

Replaces the bare ``logging.basicConfig`` from earlier days. Three
moving parts:

* :class:`JsonFormatter` writes one JSON object per record. Stable
  field order so ``jq`` / ``grep`` queries are predictable. Fields
  beyond the standard set (``ts``, ``level``, ``logger``, ``message``)
  are picked up automatically from ``record.__dict__`` via
  :func:`logging.LoggerAdapter` or the ``extra=`` kwarg.

* :func:`RequestContextMiddleware` mints a UUID per inbound request,
  binds it (and the user id, once auth has resolved) into a
  :mod:`contextvars` so anything logged below it picks up the values
  without the caller having to pass them through every function. Also
  sets the ``X-Request-ID`` response header so a frontend bug report
  can link to the matching log line.

* :class:`InMemoryRingHandler` keeps the last N records in a bounded
  deque so the upcoming admin Live Console can stream them over SSE
  without paying for a full search index. Strictly opt-in — wired up
  by :func:`configure_logging`.

Why custom JSON instead of ``python-json-logger`` etc.: zero new
dependency, full control over field order and serialisation of dicts
and tuples, and the middleware-bound context vars need a tiny custom
formatter anyway. The whole module is ~150 lines.
"""
from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from collections import deque
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Deque, Iterable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp


# ---------------------------------------------------------------------
# Per-request context (request id + user id)
# ---------------------------------------------------------------------
# Three ``ContextVar`` slots. ``None`` until something binds them. The
# JSON formatter consults them at emit time so a log call in a deeply
# nested helper still carries the request-id without the helper needing
# to accept a parameter.
_request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)
_user_id_ctx: ContextVar[str | None] = ContextVar("user_id", default=None)
_route_ctx: ContextVar[str | None] = ContextVar("route", default=None)


def get_request_id() -> str | None:
    """Public accessor — exception handlers stamp this onto error rows."""
    return _request_id_ctx.get()


def get_user_id() -> str | None:
    return _user_id_ctx.get()


def get_route() -> str | None:
    return _route_ctx.get()


def bind_user(user_id: str | uuid.UUID | None) -> None:
    """Mark the current context with the resolved user id.

    Call this from :func:`app.auth.deps.get_current_user` once auth has
    succeeded so log lines below the dependency carry the user id.
    Safe to call multiple times — the last call wins.
    """
    if user_id is None:
        _user_id_ctx.set(None)
    else:
        _user_id_ctx.set(str(user_id))


# ---------------------------------------------------------------------
# Standard fields the formatter pulls off LogRecord. Anything not in
# this set is kept under ``extra`` for the frontend live console.
# ---------------------------------------------------------------------
_STANDARD_LOGRECORD_KEYS: frozenset[str] = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
        "taskName",
    }
)


class JsonFormatter(logging.Formatter):
    """One-line JSON formatter with stable field ordering."""

    def format(self, record: logging.LogRecord) -> str:
        # ``getMessage()`` interpolates ``record.args`` into ``record.msg``
        # so ``logger.info("hi %s", name)`` ends up as a single string.
        message = record.getMessage()

        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(
                timespec="milliseconds"
            ),
            "level": record.levelname,
            "logger": record.name,
            "message": message,
        }

        # Bound context — only emit the keys that have a value, so the
        # JSON stays tight when no request is active (e.g. startup).
        rid = _request_id_ctx.get()
        if rid:
            payload["request_id"] = rid
        uid = _user_id_ctx.get()
        if uid:
            payload["user_id"] = uid
        route = _route_ctx.get()
        if route:
            payload["route"] = route

        # Anything passed via ``extra={"foo": bar}`` lives directly on
        # record.__dict__. Pick up the non-standard keys and surface
        # them at the top level so the live console can filter on them.
        extras = {
            k: v
            for k, v in record.__dict__.items()
            if k not in _STANDARD_LOGRECORD_KEYS and not k.startswith("_")
        }
        if extras:
            for k, v in extras.items():
                # Avoid clobbering reserved keys.
                if k in payload:
                    continue
                payload[k] = _safe_jsonable(v)

        if record.exc_info:
            payload["exception_class"] = (
                record.exc_info[0].__name__ if record.exc_info[0] else None
            )
            payload["stack"] = self.formatException(record.exc_info)
        elif record.stack_info:
            payload["stack"] = record.stack_info

        return json.dumps(payload, ensure_ascii=False, default=str)


def _safe_jsonable(value: Any) -> Any:
    """Coerce ``value`` to something json.dumps will accept."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple, set)):
        return [_safe_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _safe_jsonable(v) for k, v in value.items()}
    return str(value)


# ---------------------------------------------------------------------
# Bounded in-memory ring buffer
# ---------------------------------------------------------------------
class InMemoryRingHandler(logging.Handler):
    """Keep the last ``capacity`` formatted log lines in a deque.

    Used by the admin Live Console SSE endpoint — instead of opening a
    file or shelling out to ``docker logs``, the endpoint dumps the
    current buffer for backfill and then attaches a listener that's
    notified on every subsequent emit. The deque is bounded so the
    process never grows unbounded under sustained log pressure.

    Listeners are simple callables registered via :meth:`subscribe` —
    they receive the formatted JSON string. Errors raised by a
    listener are swallowed so a misbehaving subscriber can't take down
    the logging path.
    """

    def __init__(self, capacity: int = 2000) -> None:
        super().__init__()
        self._buf: Deque[str] = deque(maxlen=capacity)
        self._subscribers: list[Callable[[str], None]] = []

    # -- consumption side --------------------------------------------------
    def snapshot(self) -> list[str]:
        """Return a *copy* of the buffer (oldest first)."""
        return list(self._buf)

    def subscribe(self, callback: Callable[[str], None]) -> Callable[[], None]:
        """Register ``callback`` for new log lines. Returns an unsubscribe."""
        self._subscribers.append(callback)

        def _unsub() -> None:
            try:
                self._subscribers.remove(callback)
            except ValueError:
                pass

        return _unsub

    # -- production side ---------------------------------------------------
    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = self.format(record)
        except Exception:  # noqa: BLE001
            return
        self._buf.append(line)
        for cb in list(self._subscribers):
            try:
                cb(line)
            except Exception:  # noqa: BLE001 — never crash the logger
                pass


# Module-level singleton so the Live Console endpoint can grab it
# without rummaging through ``logging.getLogger().handlers``. Created
# lazily by ``configure_logging`` so an ad-hoc import (e.g. from a
# test) doesn't allocate a buffer that nobody will read.
_RING: InMemoryRingHandler | None = None


def get_ring_handler() -> InMemoryRingHandler | None:
    return _RING


# ---------------------------------------------------------------------
# Request id middleware
# ---------------------------------------------------------------------
class RequestContextMiddleware(BaseHTTPMiddleware):
    """ASGI middleware: bind request id + route + (optionally) user id.

    Mints a fresh ``request_id`` per inbound request unless the client
    provided one via ``X-Request-ID`` (CloudFlare etc.) — in which
    case we trust + propagate it so the caller's request id matches
    ours. The id is echoed in the response header.

    The user id is bound *later*, by ``get_current_user``, because
    auth hasn't resolved at middleware time.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # 64 hex chars max so we don't accept arbitrarily long client
        # input as a key in our context. UUID4 is the local default.
        incoming = request.headers.get("X-Request-ID")
        if incoming and 8 <= len(incoming) <= 64 and all(
            c.isalnum() or c in "-_" for c in incoming
        ):
            request_id = incoming
        else:
            request_id = uuid.uuid4().hex

        # Compose a "method path" route label that's stable (no ids in
        # the path). Full path is fine for our log volume.
        route = f"{request.method} {request.url.path}"

        rid_token = _request_id_ctx.set(request_id)
        uid_token = _user_id_ctx.set(None)
        route_token = _route_ctx.set(route)
        request.state.request_id = request_id

        started = time.perf_counter()
        status_code: int | None = None
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = request_id
            return response
        finally:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            # Single access-log line per request, level INFO. Live
            # Console will surface this for "what's the app doing right
            # now". Skip the noisy /api/health probe so a 1-second
            # healthcheck doesn't drown out real traffic.
            if request.url.path != "/api/health":
                logging.getLogger("promptly.access").info(
                    "%s -> %s in %dms",
                    route,
                    status_code if status_code is not None else "(no response)",
                    elapsed_ms,
                    extra={
                        "status_code": status_code,
                        "latency_ms": elapsed_ms,
                    },
                )
            _request_id_ctx.reset(rid_token)
            _user_id_ctx.reset(uid_token)
            _route_ctx.reset(route_token)


# ---------------------------------------------------------------------
# Public configuration entry point
# ---------------------------------------------------------------------
def configure_logging(
    *,
    level: int | str = logging.INFO,
    enable_ring: bool = True,
    quiet_loggers: Iterable[str] = (
        # Uvicorn double-logs every request through ``uvicorn.access`` —
        # we already emit our own access line above, so silence theirs
        # to avoid duplicates in the live console.
        "uvicorn.access",
    ),
) -> None:
    """Wire up JSON logging on the root logger + the ring buffer.

    Idempotent — calling it twice in the same process replaces the
    handlers on the root logger so a re-import (e.g. uvicorn reload)
    doesn't double-emit.
    """
    global _RING

    formatter = JsonFormatter()

    # Tear down whatever was previously installed so we don't end up
    # with stacked handlers.
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(level)

    # stdout handler — Docker scrapes stdout/stderr.
    stream = logging.StreamHandler(stream=sys.stdout)
    stream.setFormatter(formatter)
    stream.setLevel(level)
    root.addHandler(stream)

    if enable_ring:
        ring = InMemoryRingHandler()
        ring.setFormatter(formatter)
        ring.setLevel(level)
        root.addHandler(ring)
        _RING = ring
    else:
        _RING = None

    for name in quiet_loggers:
        logging.getLogger(name).setLevel(logging.WARNING)


__all__ = [
    "InMemoryRingHandler",
    "JsonFormatter",
    "RequestContextMiddleware",
    "bind_user",
    "configure_logging",
    "get_request_id",
    "get_ring_handler",
    "get_route",
    "get_user_id",
]


def install_middleware(app: ASGIApp) -> None:
    """Convenience: attach the request-context middleware to ``app``."""
    # Imported here to avoid a top-level FastAPI dep (this module is
    # consumed by bootstrap.py too, which doesn't need FastAPI loaded).
    from fastapi import FastAPI  # noqa: PLC0415

    if isinstance(app, FastAPI):
        app.add_middleware(RequestContextMiddleware)
