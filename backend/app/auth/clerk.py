"""Clerk auth provider.

Verifies Clerk session JWTs (RS256, verified against Clerk's JWKS) and maps them
to a local *shadow* ``User`` row. Only exercised when
``settings.AUTH_PROVIDER == "clerk"`` — the built-in password auth path never
imports or runs this module.

Design: Clerk owns *authentication*; the local row keeps owning every
app-specific concern (role, allowed_models, quotas, future org membership). The
two are linked by ``users.clerk_user_id``.
"""
from __future__ import annotations

import time
import uuid

import httpx
from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import Organization, User
from app.config import get_settings

settings = get_settings()

# In-memory JWKS cache. Clerk rotates signing keys rarely; we refetch on a
# ``kid`` miss (rotation) or after the TTL. Module-level → shared per worker.
_JWKS_TTL_SECONDS = 600
_jwks_cache: dict | None = None
_jwks_fetched_at: float = 0.0


def _jwks_url() -> str:
    if settings.CLERK_JWKS_URL:
        return settings.CLERK_JWKS_URL
    issuer = settings.CLERK_ISSUER.rstrip("/")
    if not issuer:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Clerk auth selected but CLERK_ISSUER/CLERK_JWKS_URL is unset.",
        )
    return f"{issuer}/.well-known/jwks.json"


async def _get_jwks(*, force: bool = False) -> dict:
    global _jwks_cache, _jwks_fetched_at
    now = time.time()
    if (
        not force
        and _jwks_cache is not None
        and (now - _jwks_fetched_at) < _JWKS_TTL_SECONDS
    ):
        return _jwks_cache
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(_jwks_url())
        resp.raise_for_status()
        _jwks_cache = resp.json()
        _jwks_fetched_at = now
    return _jwks_cache


def _find_key(jwks: dict, kid: str) -> dict | None:
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            return key
    return None


async def verify_clerk_token(token: str) -> dict:
    """Verify a Clerk session JWT (signature + exp/nbf + issuer). Returns the
    decoded claims, or raises 401. ``aud`` is not verified (Clerk session tokens
    don't carry one); CSRF isn't a concern here because we authenticate via an
    explicit ``Authorization`` bearer, not an ambient cookie."""
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e
    kid = header.get("kid")
    if not kid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing key id",
            headers={"WWW-Authenticate": "Bearer"},
        )

    jwks = await _get_jwks()
    jwk = _find_key(jwks, kid)
    if jwk is None:
        # Possible key rotation — refetch once before giving up.
        jwks = await _get_jwks(force=True)
        jwk = _find_key(jwks, kid)
    if jwk is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown token signing key",
            headers={"WWW-Authenticate": "Bearer"},
        )

    issuer = settings.CLERK_ISSUER.rstrip("/") or None
    try:
        claims = jwt.decode(
            token,
            jwk,
            algorithms=["RS256"],
            issuer=issuer,
            options={"verify_aud": False},
        )
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e
    return claims


def _unusable_password_hash() -> str:
    """A random, unmatchable bcrypt hash. Clerk owns authentication, so a shadow
    row never authenticates by password — but the column is NOT NULL."""
    from app.auth.utils import hash_password

    return hash_password("clerk:" + uuid.uuid4().hex)


def normalize_org_role(role: str | None) -> str:
    """Clerk org roles are ``org:admin`` / ``org:member``. Collapse to our
    two-value ``admin`` / ``member`` (anything unknown → member)."""
    if not role:
        return "member"
    return "admin" if role.split(":")[-1].lower() == "admin" else "member"


async def upsert_org(
    clerk_org_id: str, name: str | None, db: AsyncSession
) -> Organization:
    """Find-or-create the local shadow of a Clerk organization."""
    result = await db.execute(
        select(Organization).where(Organization.clerk_org_id == clerk_org_id)
    )
    org = result.scalar_one_or_none()
    if org is None:
        org = Organization(clerk_org_id=clerk_org_id, name=name or "Organization")
        db.add(org)
        try:
            await db.commit()
            await db.refresh(org)
        except IntegrityError:
            await db.rollback()
            result = await db.execute(
                select(Organization).where(
                    Organization.clerk_org_id == clerk_org_id
                )
            )
            org = result.scalar_one_or_none()
            if org is None:
                raise
    elif name and org.name != name:
        org.name = name
        await db.commit()
    return org


async def _sync_user_org(user: User, claims: dict, db: AsyncSession) -> None:
    """Set ``user.org_id`` / ``user.org_role`` from the active org in the token.

    Clerk exposes the active org either as flat ``org_id`` / ``org_role`` claims
    or (v2 tokens) an ``o`` object ``{id, rol, slg}``. If there's no active org
    (transient — e.g. the org is still being auto-created) we leave the user's
    tenant untouched; the membership webhook will fill it in."""
    org_id = claims.get("org_id")
    org_role = claims.get("org_role")
    slug = claims.get("org_slug")
    o = claims.get("o")
    if not org_id and isinstance(o, dict):
        org_id = o.get("id")
        org_role = o.get("rol")
        slug = o.get("slg") or slug
    if not org_id:
        return

    org = await upsert_org(org_id, slug, db)
    role = normalize_org_role(org_role)
    changed = False
    if user.org_id != org.id:
        user.org_id = org.id
        changed = True
    if user.org_role != role:
        user.org_role = role
        changed = True
    if changed:
        await db.commit()


async def resolve_or_provision_user(claims: dict, db: AsyncSession) -> User:
    """Map verified Clerk claims to a local ``User``.

    Order: (1) existing row by ``clerk_user_id``; (2) if a verified email matches
    an existing password account, *link* it (migrates the account to Clerk);
    (3) otherwise lazy-provision a shadow row. Email/username come from custom
    session-token claims when the Clerk instance is configured to include them,
    else safe placeholders keyed off the Clerk id (a webhook backfills later).
    """
    clerk_user_id = claims.get("sub")
    if not clerk_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject",
        )

    result = await db.execute(
        select(User).where(User.clerk_user_id == clerk_user_id)
    )
    user = result.scalar_one_or_none()

    if user is None:
        email = (claims.get("email") or "").strip().lower()
        username = (claims.get("username") or "").strip()

        # Link an existing (Clerk-verified) email to migrate a password account.
        if email:
            result = await db.execute(select(User).where(User.email == email))
            existing = result.scalar_one_or_none()
            if existing is not None:
                existing.clerk_user_id = clerk_user_id
                await db.commit()
                await db.refresh(existing)
                user = existing

        if user is None:
            short = clerk_user_id.replace("user_", "")[:24]
            new_user = User(
                email=email or f"{short}@clerk.local",
                username=username or f"clerk_{short}"[:64],
                password_hash=_unusable_password_hash(),
                clerk_user_id=clerk_user_id,
                role="user",
            )
            db.add(new_user)
            try:
                await db.commit()
            except IntegrityError:
                # Concurrent provision / placeholder-handle collision — re-fetch
                # by the Clerk id, the authoritative unique key.
                await db.rollback()
                result = await db.execute(
                    select(User).where(User.clerk_user_id == clerk_user_id)
                )
                user = result.scalar_one_or_none()
                if user is None:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Failed to provision Clerk user",
                    )
            else:
                await db.refresh(new_user)
                user = new_user

    # Keep the caller's tenant (org_id / org_role) in sync with the active org
    # in their token. Webhooks are the primary sync; this covers the window
    # before they fire (and the very first request after sign-up).
    await _sync_user_org(user, claims, db)
    return user
