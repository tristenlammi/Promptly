"""Backend paywall enforcement.

The frontend ``ClerkSubscriptionGate`` blocks the UI, but the API must refuse an
unentitled caller too (otherwise the paywall is bypassable with a raw token).

Entitlement is read straight from the verified Clerk session JWT — the same
features ``has({feature})`` uses client-side. No webhook lag, no mirror to
backfill; Clerk session tokens refresh ~every 60s so it's near-live.

Design safety:
  * Gated behind ``PAYWALL_ENFORCED`` (default OFF) — shipping it is inert.
  * FAILS OPEN — a request we can't classify (no token, bad token, self-host,
    single-user) passes through to the endpoint's own auth (which 401s if
    needed). Only a *confirmed* unentitled Clerk caller is blocked (402).
  * The platform operator is never a customer — bypassed by verified email.
Verify the token actually carries the feature via ``GET /api/usage/entitlement``
BEFORE flipping enforcement on.
"""
from __future__ import annotations

import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.config import get_settings

# Prefixes that must stay reachable regardless of subscription: auth (login,
# /me, preferences, the Clerk webhook, MFA), the usage/billing surface
# (including this module's entitlement check), health, and public share links.
_OPEN_PREFIXES = ("/api/auth", "/api/usage", "/api/health", "/api/s")


def _split(blob: object) -> list[str]:
    """Normalise a claim value (string list, comma/space string, or list) to
    a list of tokens."""
    if isinstance(blob, str):
        return [t for t in re.split(r"[,\s]+", blob) if t]
    if isinstance(blob, (list, tuple)):
        return [str(t) for t in blob if t]
    return []


def entitled_from_claims(claims: dict) -> bool:
    """True if the session carries the configured paywall feature.

    Clerk billing surfaces features in the ``fea`` claim and plans in ``pla``,
    commonly scope-prefixed (``o:pro`` for an org-level feature). The active-org
    object ``o`` may also carry ``fea`` / ``features``. We check every plausible
    location and strip the scope prefix, so feature ``pro`` matches ``pro`` /
    ``o:pro`` / ``u:pro`` wherever it appears. Unknown shape → False (only
    binds when enforcement is on; the status endpoint surfaces the raw claim
    so a mismatch is obvious before you enable)."""
    feature = (get_settings().PAYWALL_FEATURE or "pro").strip()
    blobs: list[str] = []
    for key in ("fea", "pla", "features", "plans"):
        blobs += _split(claims.get(key))
    o = claims.get("o")
    if isinstance(o, dict):
        for key in ("fea", "features", "pla", "plan", "plans"):
            blobs += _split(o.get(key))
    return any(tok.split(":")[-1].strip() == feature for tok in blobs)


async def _verdict(request: Request) -> bool | None:
    """``True`` = entitled, ``False`` = blocked, ``None`` = can't tell (fail
    open — let the endpoint's own auth decide)."""
    s = get_settings()
    if s.SINGLE_USER_MODE:
        return True
    if (s.AUTH_PROVIDER or "custom").lower() != "clerk":
        return True  # self-host / custom auth: no paywall
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        return None  # unauthenticated → let the endpoint 401 as usual
    try:
        from app.auth.clerk import verify_clerk_token

        claims = await verify_clerk_token(auth[7:].strip())
    except Exception:
        return None  # bad / expired token → the endpoint's auth handles it
    # The platform operator is never a customer — bypass by verified email.
    email = (claims.get("email") or "").strip().lower()
    operator = (s.PLATFORM_ADMIN_EMAIL or "").strip().lower()
    if email and operator and email == operator:
        return True
    return entitled_from_claims(claims)


def _needs_check(path: str) -> bool:
    return path.startswith("/api/") and not any(
        path.startswith(p) for p in _OPEN_PREFIXES
    )


class PaywallMiddleware(BaseHTTPMiddleware):
    """Refuses unentitled callers with 402 when ``PAYWALL_ENFORCED``. Pass-through
    (no body buffering) for allowed requests, so SSE streams are unaffected."""

    async def dispatch(self, request: Request, call_next) -> Response:
        s = get_settings()
        if not s.PAYWALL_ENFORCED or request.method == "OPTIONS":
            return await call_next(request)
        if not _needs_check(request.url.path):
            return await call_next(request)
        if await _verdict(request) is False:
            return JSONResponse(
                status_code=402,
                content={
                    "detail": "An active subscription is required to use Promptly.",
                    "code": "subscription_required",
                },
            )
        return await call_next(request)


async def entitlement_status(request: Request) -> dict:
    """Payload for ``GET /api/usage/entitlement`` — lets you confirm the token
    actually carries the feature (and see the raw claim) BEFORE enabling
    enforcement, so you never flip it on and lock out paying customers."""
    s = get_settings()
    result: dict = {
        "enforced": bool(s.PAYWALL_ENFORCED),
        "feature": s.PAYWALL_FEATURE or "pro",
        "auth_provider": (s.AUTH_PROVIDER or "custom"),
        "entitled": True,
        "raw": {},
    }
    auth = request.headers.get("authorization") or ""
    if (s.AUTH_PROVIDER or "custom").lower() == "clerk" and auth.lower().startswith(
        "bearer "
    ):
        try:
            from app.auth.clerk import verify_clerk_token

            claims = await verify_clerk_token(auth[7:].strip())
            result["entitled"] = entitled_from_claims(claims)
            o = claims.get("o") if isinstance(claims.get("o"), dict) else {}
            result["raw"] = {
                "fea": claims.get("fea"),
                "pla": claims.get("pla"),
                "o.fea": o.get("fea"),
                "o.features": o.get("features"),
                "o.plan": o.get("plan") or o.get("pla"),
                "email": claims.get("email"),
            }
        except Exception as e:  # noqa: BLE001 - surface the reason to the operator
            result["error"] = str(e)
    return result


__all__ = ["PaywallMiddleware", "entitled_from_claims", "entitlement_status"]
