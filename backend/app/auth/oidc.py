"""OIDC single sign-on service (Voice-unrelated; auth Phase SSO).

A lean OpenID Connect *client*: discovery → authorize-URL → code exchange →
id_token verification. Deliberately dependency-light — it uses the httpx +
python-jose + cryptography stack the app already ships, not a new OAuth
framework (whose FastAPI helpers would drag in Starlette SessionMiddleware
we don't run).

Security model:
* The client secret is stored Fernet-encrypted in ``app_settings`` and only
  decrypted here.
* CSRF/replay are covered by a signed, short-lived ``state``+``nonce`` the
  login route stamps into an HttpOnly cookie and the callback re-checks.
* The id_token signature is verified against the issuer's JWKS (asymmetric
  algs only — never ``none``/HS), with audience + issuer + expiry checks.
* Invite-only: the caller matches the verified email to an EXISTING user and
  never auto-provisions, so SSO can't widen access beyond the admin's list.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
from jose import jwt as jose_jwt
from sqlalchemy.ext.asyncio import AsyncSession

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.utils import decrypt_secret

# Asymmetric signing algorithms we accept for an id_token. Symmetric (HS*)
# and ``none`` are intentionally excluded — an OIDC id_token is always signed
# with the provider's private key.
_ALLOWED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"]

_DEFAULT_SCOPES = "openid email profile"
_DISCOVERY_SUFFIX = "/.well-known/openid-configuration"

# Small in-process caches (discovery doc + JWKS) keyed by URL. Diarization-
# style TTL so a provider key-rotation is picked up within the hour without a
# fetch on every login.
_CACHE_TTL_S = 3600.0
_disc_cache: dict[str, tuple[float, dict]] = {}
_jwks_cache: dict[str, tuple[float, dict]] = {}


class OidcError(Exception):
    """Any failure in the OIDC exchange worth surfacing to the caller."""


@dataclass
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str
    scopes: str
    button_label: str


def _default_label() -> str:
    return "Sign in with SSO"


async def load_oidc_config(db: AsyncSession) -> OidcConfig | None:
    """Return the configured OIDC client, or ``None`` when SSO is off/incomplete."""
    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None or not row.oidc_enabled:
        return None
    if not (row.oidc_issuer and row.oidc_client_id and row.oidc_client_secret_encrypted):
        return None
    try:
        secret = decrypt_secret(row.oidc_client_secret_encrypted)
    except ValueError:
        # SECRET_KEY changed or ciphertext corrupt — treat SSO as unconfigured
        # rather than 500 the login page.
        return None
    return OidcConfig(
        issuer=row.oidc_issuer.strip(),
        client_id=row.oidc_client_id.strip(),
        client_secret=secret,
        scopes=(row.oidc_scopes or _DEFAULT_SCOPES).strip() or _DEFAULT_SCOPES,
        button_label=(row.oidc_button_label or _default_label()).strip()
        or _default_label(),
    )


def _discovery_url(issuer: str) -> str:
    url = issuer.rstrip("/")
    if url.endswith(_DISCOVERY_SUFFIX):
        return url
    return url + _DISCOVERY_SUFFIX


async def _discover(issuer: str) -> dict:
    url = _discovery_url(issuer)
    now = time.monotonic()
    hit = _disc_cache.get(url)
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            doc = resp.json()
    except httpx.HTTPError as exc:
        raise OidcError(f"Couldn't reach the identity provider: {exc}") from exc
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"):
        if not doc.get(key):
            raise OidcError(f"Identity provider discovery is missing {key!r}.")
    _disc_cache[url] = (now, doc)
    return doc


async def _jwks(jwks_uri: str) -> dict:
    now = time.monotonic()
    hit = _jwks_cache.get(jwks_uri)
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(jwks_uri)
            resp.raise_for_status()
            keys = resp.json()
    except httpx.HTTPError as exc:
        raise OidcError(f"Couldn't fetch the provider's signing keys: {exc}") from exc
    _jwks_cache[jwks_uri] = (now, keys)
    return keys


async def build_authorize_url(
    cfg: OidcConfig, *, redirect_uri: str, state: str, nonce: str
) -> str:
    doc = await _discover(cfg.issuer)
    params = {
        "response_type": "code",
        "client_id": cfg.client_id,
        "redirect_uri": redirect_uri,
        "scope": cfg.scopes,
        "state": state,
        "nonce": nonce,
    }
    return f"{doc['authorization_endpoint']}?{urlencode(params)}"


async def exchange_and_verify(
    cfg: OidcConfig, *, code: str, redirect_uri: str, nonce: str
) -> dict:
    """Trade the auth code for an id_token and return its verified claims."""
    doc = await _discover(cfg.issuer)
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                doc["token_endpoint"],
                data=data,
                headers={"Accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise OidcError(f"Token exchange failed to reach the provider: {exc}") from exc
    if resp.status_code != 200:
        raise OidcError(f"Token exchange was rejected ({resp.status_code}).")
    token_resp = resp.json()
    id_token = token_resp.get("id_token")
    if not id_token:
        raise OidcError("The provider returned no id_token.")

    keys = await _jwks(doc["jwks_uri"])
    try:
        claims = jose_jwt.decode(
            id_token,
            keys,
            algorithms=_ALLOWED_ALGS,
            audience=cfg.client_id,
            issuer=doc["issuer"],
            # We don't use the access-token hash flow, so skip at_hash.
            # Signature, audience, issuer and expiry are all verified by
            # default (python-jose).
            options={"verify_at_hash": False},
        )
    except Exception as exc:  # noqa: BLE001 — jose raises several subclasses
        raise OidcError(f"The provider's id_token failed verification: {exc}") from exc

    if nonce and claims.get("nonce") != nonce:
        raise OidcError("id_token nonce did not match (possible replay).")
    return claims


def verified_email_from_claims(claims: dict) -> str | None:
    """Extract a trustworthy email from id_token claims, or ``None``.

    Requires the ``email_verified`` claim to be truthy when the provider sends
    it (most do). Without a verified email we refuse to match an account.
    """
    email = (claims.get("email") or "").strip().lower()
    if not email:
        return None
    verified = claims.get("email_verified", True)
    if verified in (False, "false", "False", 0, "0"):
        return None
    return email
