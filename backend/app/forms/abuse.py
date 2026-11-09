"""Spam limits for answering forms — all on, with nothing to set up.

* **Start token.** ``GET /api/f/{token}`` hands the page a short token
  holding the time it was opened, signed with a key derived from
  ``SECRET_KEY`` for this one purpose (HKDF, the ``media_urls`` way). An
  answer sent back in under 3 seconds, after a day, or without a valid
  token is refused. No third-party captcha.
* **Per form, per person** (an account, else the address): 20 answers an
  hour, in Redis with a TTL. The address comes from
  ``auth.audit.request_meta`` and is never stored with an answer.
* **Per form overall** on link forms: 300 answers an hour. Past that the
  page says it's busy, and the owner gets one push.
* The route-level per-address limits (submit 10/min, report 5/hour) are
  ``rate_limit`` dependencies on the routes; nginx's ``api_rl`` is in
  front of everything.

A Redis outage lets answers through rather than stopping them: these
limits slow abuse down, the form's own closing rules still hold.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
import uuid

from app.config import get_settings

logger = logging.getLogger("promptly.forms")

START_MIN_SECONDS = 3.0
START_MAX_SECONDS = 24 * 3600
PER_PERSON_PER_HOUR = 20
PER_FORM_PER_HOUR = 300
_HOUR = 3600

_START_INFO = b"promptly-forms-start-v1"
_EDIT_INFO = b"promptly-forms-edit-v1"
_RESULT_INFO = b"promptly-forms-result-v1"


def _hkdf(secret: str, info: bytes) -> bytes:
    """RFC 5869 HKDF-SHA256 (one block): a key for one purpose only."""
    prk = hmac.new(b"promptly-forms", secret.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()


def _keys(info: bytes) -> list[bytes]:
    s = get_settings()
    keys = [_hkdf(s.SECRET_KEY, info)]
    if getattr(s, "SECRET_KEY_PREVIOUS", None):
        keys.append(_hkdf(s.SECRET_KEY_PREVIOUS, info))
    return keys


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


# --------------------------------------------------------------------
# Start token
# --------------------------------------------------------------------
def _start_sig(key: bytes, form_id: uuid.UUID, ms: int) -> str:
    return _b64(hmac.new(key, f"{form_id.hex}.{ms}".encode("ascii"), hashlib.sha256).digest())


def start_token(form_id: uuid.UUID, *, now: float | None = None) -> str:
    ms = int((now if now is not None else time.time()) * 1000)
    return f"{ms}.{_start_sig(_keys(_START_INFO)[0], form_id, ms)}"


def check_start(form_id: uuid.UUID, token: str | None, *, now: float | None = None) -> str:
    """``"ok"``, ``"fast"`` (under 3 s), ``"old"`` (over a day) or ``"bad"``."""
    if not token or not isinstance(token, str) or len(token) > 120 or "." not in token:
        return "bad"
    ms_text, sig = token.split(".", 1)
    if not ms_text.isdigit():
        return "bad"
    ms = int(ms_text)
    if not any(hmac.compare_digest(_start_sig(k, form_id, ms), sig) for k in _keys(_START_INFO)):
        return "bad"
    age = (now if now is not None else time.time()) - ms / 1000
    if age < START_MIN_SECONDS:
        return "fast"
    if age > START_MAX_SECONDS:
        return "old"
    return "ok"


# --------------------------------------------------------------------
# Edit tokens (link answers)
# --------------------------------------------------------------------
def edit_token(form_id: uuid.UUID, submit_id: uuid.UUID) -> str:
    """The private "change your answer" key for a link answer. Derived from
    the submit id, so a retried submit gets the same one back; only its
    hash is stored."""
    return _b64(hmac.new(_keys(_EDIT_INFO)[0], f"{form_id.hex}.{submit_id.hex}".encode("ascii"), hashlib.sha256).digest())


def hash_edit_token(token: str) -> str:
    # 32 random-looking bytes: a plain SHA-256 is enough (no bcrypt).
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------
# Results tokens (quizzes, WP-F2.3)
# --------------------------------------------------------------------
def result_token(form_id: uuid.UUID, number: int, submit_id: uuid.UUID) -> str:
    """"Save this link to see your score later": ``<number>.<key>``, the key
    derived from the answer's submit id under its own label (like the edit
    token), so nothing new is stored and it opens that one answer's marks
    only — never anyone else's, and never a way to change it."""
    sig = _b64(hmac.new(_keys(_RESULT_INFO)[0], f"{form_id.hex}.{submit_id.hex}".encode("ascii"), hashlib.sha256).digest())
    return f"{number}.{sig}"


def result_number(token: str | None) -> int | None:
    """The answer number a results token claims (checked afterwards with
    :func:`result_token_ok`)."""
    if not token or len(token) > 120 or "." not in token:
        return None
    n, _sig = token.split(".", 1)
    return int(n) if n.isdigit() and 0 < len(n) <= 9 else None


def result_token_ok(token: str, form_id: uuid.UUID, number: int, submit_id: uuid.UUID) -> bool:
    """Compared as SHA-256 digests, in constant time, against every key
    still in use (a rotated secret keeps old links working)."""
    want = hashlib.sha256(token.encode("utf-8")).digest()
    for key in _keys(_RESULT_INFO):
        sig = _b64(hmac.new(key, f"{form_id.hex}.{submit_id.hex}".encode("ascii"), hashlib.sha256).digest())
        if hmac.compare_digest(hashlib.sha256(f"{number}.{sig}".encode("utf-8")).digest(), want):
            return True
    return False


# --------------------------------------------------------------------
# Counters
# --------------------------------------------------------------------
def _enabled() -> bool:
    return bool(get_settings().RATE_LIMIT_ENABLED)


def person_key(form_id: uuid.UUID, *, user_id: uuid.UUID | None, ip: str) -> str:
    # Signed-in people count by account: a family behind one address can
    # all answer the RSVP.
    who = f"u:{user_id}" if user_id else (ip or "unknown")
    return f"form:{form_id}:{who}"


def _overall_key(form_id: uuid.UUID) -> str:
    return f"form:{form_id}:all"


async def _count(key: str) -> int:
    from app.redis_client import redis

    try:
        raw = await redis.get(key)
        return int(raw or 0)
    except Exception:  # noqa: BLE001 — a Redis outage mustn't stop answers
        logger.warning("forms: couldn't read the rate counter %s", key, exc_info=True)
        return 0


async def person_over(form_id: uuid.UUID, *, user_id: uuid.UUID | None, ip: str) -> bool:
    if not _enabled():
        return False
    return await _count(person_key(form_id, user_id=user_id, ip=ip)) >= PER_PERSON_PER_HOUR


async def form_over(form_id: uuid.UUID) -> bool:
    if not _enabled():
        return False
    return await _count(_overall_key(form_id)) >= PER_FORM_PER_HOUR


async def note_answer(form_id: uuid.UUID, *, user_id: uuid.UUID | None, ip: str, link_form: bool) -> None:
    """Count one accepted answer (after it's saved)."""
    from app.redis_client import redis

    keys = [person_key(form_id, user_id=user_id, ip=ip)]
    if link_form:
        keys.append(_overall_key(form_id))
    try:
        for k in keys:
            n = await redis.incr(k)
            if n == 1:
                await redis.expire(k, _HOUR)
    except Exception:  # noqa: BLE001
        logger.warning("forms: couldn't count an answer", exc_info=True)


async def first_busy_this_hour(form_id: uuid.UUID) -> bool:
    """True once an hour per form: when to push the owner "lots of answers"."""
    from app.redis_client import redis

    try:
        return bool(await redis.set(f"form:{form_id}:busy-told", "1", ex=_HOUR, nx=True))
    except Exception:  # noqa: BLE001
        return False


__all__ = [
    "PER_FORM_PER_HOUR",
    "PER_PERSON_PER_HOUR",
    "START_MAX_SECONDS",
    "START_MIN_SECONDS",
    "check_start",
    "edit_token",
    "first_busy_this_hour",
    "form_over",
    "hash_edit_token",
    "note_answer",
    "person_key",
    "person_over",
    "result_number",
    "result_token",
    "result_token_ok",
    "start_token",
]
