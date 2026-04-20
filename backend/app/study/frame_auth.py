"""Short-lived signed tokens for serving sandboxed exercise HTML.

Problem this solves
-------------------
AI-authored whiteboard exercises are rendered inside a sandboxed iframe.
They contain inline ``<script>`` blocks (to wire up Sortable, define
``window.collectAnswers``, etc.) which are blocked by the SPA's strict
``script-src 'self'`` CSP — and ``srcdoc`` iframes inherit that policy,
so there is no in-document way around it.

The fix is to serve exercise HTML from a dedicated URL whose response
relaxes ``script-src`` to allow inline (nginx owns that CSP override —
see ``location /api/study/exercise-frame/`` in ``nginx.conf``), and
load the iframe with ``src=`` pointing at that URL. The iframe still
carries ``sandbox="allow-scripts"`` without ``allow-same-origin``, so
it runs on a null origin with no access to parent cookies or storage.

The iframe's initial ``src=`` request cannot set an ``Authorization``
header, so this module issues short-lived URL-embeddable tokens that
the frame endpoint verifies out-of-band. The flow is:

1. The SPA, while authenticated, asks
   ``POST /api/study/exercises/{id}/frame-token`` for a signed URL.
2. The backend validates the user owns the exercise, mints a token
   that binds ``(user_id, exercise_id, expiry)`` together with an
   HMAC-SHA256 signature over the app's ``SECRET_KEY``, and returns
   the URL ``/api/study/exercise-frame/{id}?t=<token>``.
3. The SPA sets the iframe ``src`` to that URL. The browser loads it;
   the frame endpoint verifies the token and returns the HTML.

Tokens are valid for two minutes — plenty for the iframe's initial
load, short enough that a leaked URL is effectively useless.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
import uuid
from dataclasses import dataclass

from app.config import get_settings

# Two minutes covers slow page loads, flaky networks, and the occasional
# remount without being long enough for a leaked URL to matter. The
# iframe's scripts survive token expiry — once the page is loaded it
# just runs.
_TOKEN_TTL_SECONDS = 120

# "|" is safe because UUIDs are hex and numbers are digits; neither
# contains the separator. We still rsplit on it from the right to be
# resilient in case any field is ever widened.
_SEP = "|"


@dataclass(frozen=True)
class ExerciseFrameClaims:
    user_id: uuid.UUID
    exercise_id: uuid.UUID
    expires_at: int


def _secret() -> bytes:
    return get_settings().SECRET_KEY.encode("utf-8")


def _sign(payload: str) -> str:
    return hmac.new(_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def sign_exercise_frame_token(
    *, user_id: uuid.UUID, exercise_id: uuid.UUID, ttl_seconds: int = _TOKEN_TTL_SECONDS
) -> str:
    """Mint a short-lived token binding ``(user_id, exercise_id, expiry)``."""
    expires_at = int(time.time()) + int(ttl_seconds)
    payload = _SEP.join((str(user_id), str(exercise_id), str(expires_at)))
    signature = _sign(payload)
    raw = f"{payload}{_SEP}{signature}".encode("utf-8")
    # URL-safe base64 without padding so the token fits cleanly into a
    # query string without requiring any encoding.
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def verify_exercise_frame_token(token: str) -> ExerciseFrameClaims | None:
    """Return the decoded claims, or ``None`` if the token is invalid or expired.

    Resists timing attacks on the signature comparison via
    :func:`hmac.compare_digest`. Never raises — callers treat ``None``
    as "unauthorised".
    """
    if not token:
        return None
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None

    parts = raw.split(_SEP)
    if len(parts) != 4:
        return None
    user_id_s, exercise_id_s, expires_s, signature = parts

    expected = _sign(_SEP.join((user_id_s, exercise_id_s, expires_s)))
    if not hmac.compare_digest(expected, signature):
        return None

    try:
        expires_at = int(expires_s)
        user_id = uuid.UUID(user_id_s)
        exercise_id = uuid.UUID(exercise_id_s)
    except ValueError:
        return None

    if expires_at < int(time.time()):
        return None

    return ExerciseFrameClaims(
        user_id=user_id,
        exercise_id=exercise_id,
        expires_at=expires_at,
    )


# Tag the backend injects into every exercise HTML before returning it.
# See ``frontend/public/exercise-shim.js`` for what the shim actually
# does (parent↔iframe submit postMessage + hide stray submit buttons).
_SHIM_TAG = '<script src="/exercise-shim.js"></script>'


def inject_submit_shim(html: str) -> str:
    """Inject the submit-shim script tag so it runs before the AI's scripts.

    Tries, in order: right after ``<head>``; failing that, right before
    ``<body>`` (creating a ``<head>`` for us); as a last resort,
    prepended to whatever we got. Same contract as the frontend helper
    we previously used — moved server-side so the frame endpoint is
    the single source of truth for what ends up in the iframe.
    """
    if not html:
        return _SHIM_TAG

    import re

    head_match = re.search(r"<head\b[^>]*>", html, re.IGNORECASE)
    if head_match is not None:
        idx = head_match.end()
        return html[:idx] + _SHIM_TAG + html[idx:]

    body_match = re.search(r"<body\b[^>]*>", html, re.IGNORECASE)
    if body_match is not None:
        idx = body_match.start()
        return html[:idx] + f"<head>{_SHIM_TAG}</head>" + html[idx:]

    return _SHIM_TAG + html
