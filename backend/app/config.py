"""Application settings loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


# Sentinel value for the development SECRET_KEY default. Any deployment
# whose DOMAIN is not "localhost" must override this — the app refuses
# to boot otherwise (see ``validate_production_safety``).
_INSECURE_SECRET_PLACEHOLDER = "insecure-dev-only-change-me"


class InsecureProductionConfig(RuntimeError):
    """Raised at startup when the configured settings are unsafe for prod."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- App ----
    SECRET_KEY: str = Field(default=_INSECURE_SECRET_PLACEHOLDER)
    DOMAIN: str = "localhost"
    # Master debug switch. Off by default. When True, /api/docs,
    # /api/redoc, and /api/openapi.json are exposed and the production
    # safety checks below are skipped.
    DEBUG: bool = False
    # Legacy flag. Defaults to False now that Promptly is always multi-user.
    # When True, the auth layer bypasses JWT and returns the singleton "local"
    # user for every request. Leave False for normal operation.
    SINGLE_USER_MODE: bool = False
    ALLOWED_ORIGINS: str = "http://localhost"

    # ---- Cookies (refresh + future MFA device cookies) ----
    # Defaults to True because production deployments are HTTPS via the
    # Cloudflare tunnel. Override to False *only* in local dev when you
    # need to test cookie flows over plain HTTP.
    COOKIE_SECURE: bool = True
    # "strict" is correct for first-party-only auth; refresh + device
    # cookies are never sent cross-site.
    COOKIE_SAMESITE: str = "strict"

    # ---- MFA cookies ----
    # Cookie that carries the trusted-device token. Bound to /api so it
    # never leaks to the SPA or to third parties. The value itself is a
    # 256-bit URL-safe random string; the DB only stores its sha256.
    MFA_TRUSTED_DEVICE_COOKIE_NAME: str = "promptly_trusted_device"

    # ---- Account lockout ----
    # Number of consecutive failed logins before the account is locked.
    # Reset to 0 on a successful login. Lockout is permanent until an
    # admin unlocks (matches the product spec).
    LOCKOUT_THRESHOLD: int = 5

    # ---- MFA ----
    # Issuer string baked into the otpauth:// URI shown to authenticator
    # apps. Falls back to ``Promptly`` so a fresh deploy looks sane even
    # before the operator customises it.
    MFA_ISSUER: str = "Promptly"
    # How long a "trust this device" cookie is valid for. The user is
    # explicitly told the duration on the verify screen, so changing
    # this should be a deliberate decision — not a per-deploy tuning.
    MFA_TRUSTED_DEVICE_DAYS: int = 30
    # MFA challenge token TTL — the short-lived JWT the frontend gets
    # in lieu of an access token after password-OK-but-MFA-required.
    # Long enough for a human to type a code, short enough that a leaked
    # challenge token isn't a viable attack.
    MFA_CHALLENGE_TOKEN_TTL_MINUTES: int = 10
    # Email OTP code lifetime. Should match what the email body tells
    # the user. 10 minutes is the de-facto industry default.
    MFA_EMAIL_OTP_TTL_MINUTES: int = 10
    # Minimum gap between successive email OTP sends to the same user.
    # Defends against email-bombing attackers who'd otherwise use our
    # SMTP credentials to spam someone's inbox.
    MFA_EMAIL_OTP_MIN_INTERVAL_SECONDS: int = 30
    # Maximum email OTPs we'll send to one user in a rolling hour.
    MFA_EMAIL_OTP_MAX_PER_HOUR: int = 10
    # How many one-shot backup codes to generate when the user enrolls
    # (or regenerates). 10 is the GitHub / Google convention.
    MFA_BACKUP_CODE_COUNT: int = 10

    # ---- Rate limiting ----
    # Master switch. Set to False in unit tests / dev iteration loops if
    # the limits start getting in the way.
    RATE_LIMIT_ENABLED: bool = True
    # Per-IP login throttle. The format is slowapi/limits' string DSL
    # ("count/window"). Tuned to be invisible to humans and brutal to
    # scripts: 10 attempts per minute per source IP.
    RATE_LIMIT_LOGIN: str = "10/minute"
    # Per-identifier (email/username) throttle. Cheaper than per-IP for
    # password-spray defense — one IP cycling through a thousand
    # identifiers gets caught here long before the IP limit fires.
    RATE_LIMIT_LOGIN_IDENT: str = "5/minute"
    # /auth/refresh runs on every focus event in the tab once an access
    # token is near expiry, so this needs headroom for normal use.
    RATE_LIMIT_REFRESH: str = "60/minute"
    # First-run setup is one-shot. Three attempts an hour from a single
    # IP is plenty to recover from a typo.
    RATE_LIMIT_SETUP: str = "3/hour"
    # MFA verify is the second factor — we want it slow-but-usable.
    # 20/min accommodates a fat-fingered TOTP retry while still capping
    # online brute-force at <0.001% of the 1M six-digit keyspace per
    # window.
    RATE_LIMIT_MFA_VERIFY: str = "20/minute"
    # Email OTP send: tighter than the per-user cap in MFA_EMAIL_OTP_*
    # because this fires per-IP and protects against an unauthenticated
    # attacker spraying send requests for many usernames at once.
    RATE_LIMIT_MFA_EMAIL_SEND: str = "10/hour"
    # Conservative blanket cap applied to every endpoint as a safety net.
    # Tunes how aggressive a scraper can be against the public surface.
    RATE_LIMIT_DEFAULT: str = "300/minute"
    # Per-user *sliding* window applied to chat sends. 60 messages in
    # any rolling 5-minute window is generous for a human (one every
    # 5 s sustained) but cuts off the runaway-script case where a
    # compromised token is being driven by a bot.
    RATE_LIMIT_USER_MESSAGES: str = "60/5 minutes"

    # ---- Database ----
    DATABASE_URL: str = (
        "postgresql+asyncpg://promptly:promptly@postgres:5432/promptly"
    )

    # ---- Redis ----
    REDIS_URL: str = "redis://redis:6379/0"

    # ---- Search ----
    SEARXNG_URL: str = "http://searxng:8080"
    DEFAULT_SEARCH_PROVIDER: str = "searxng"
    SEARCH_RESULT_COUNT: int = 5
    SEARCH_CONCURRENT_REQUESTS: int = 3
    BRAVE_SEARCH_API_KEY: str = ""
    TAVILY_API_KEY: str = ""

    # ---- SSRF allowlist ----
    # Comma-separated hostnames that ``safe_fetch`` will allow even
    # when they resolve to private addresses. The defaults cover the
    # services we ship in docker-compose (``searxng`` resolves to a
    # private docker-network IP); operators with their own internal
    # endpoints can append to the list. Anything not on this list
    # that resolves to a private/loopback/link-local IP is refused.
    SSRF_ALLOWED_HOSTS: str = "searxng"

    @property
    def ssrf_allowed_hosts_set(self) -> frozenset[str]:
        return frozenset(
            h.strip().lower()
            for h in self.SSRF_ALLOWED_HOSTS.split(",")
            if h.strip()
        )

    # ---- Model provider defaults (users can override via Models tab) ----
    OPENROUTER_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""

    # ---- Web Push (VAPID) ----
    # Generated once per deployment with ``scripts/generate_vapid_keys.py``
    # and rotated only when absolutely necessary (rotating invalidates
    # every existing browser subscription). Both keys are PEM-encoded
    # so they round-trip cleanly through .env files without base64
    # gymnastics. ``pywebpush`` accepts them verbatim.
    #
    # When either value is blank, the notifications router returns a
    # graceful 503 to the frontend's ``/account/push/public-key``
    # call; the UI then hides the subscribe button and shows a hint
    # directing the operator at the setup docs.
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    # Contact URI included in the VAPID header — push services (FCM,
    # Mozilla's autopush, Apple's) require this so they know who to
    # reach if a subscription misbehaves. ``mailto:`` or ``https://``
    # both valid; we default to a placeholder so local dev doesn't
    # 401 against a picky push endpoint.
    VAPID_CONTACT: str = "mailto:admin@localhost"

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        """Heuristic: anything that isn't local dev counts as production.

        Used to decide whether to enforce the security checks in
        ``validate_production_safety`` and whether to expose the
        OpenAPI docs.
        """
        if self.DEBUG:
            return False
        return self.DOMAIN.strip().lower() not in {"", "localhost", "127.0.0.1"}

    def validate_production_safety(self) -> list[str]:
        """Return a list of fatal-config errors for the current settings.

        The application's lifespan calls this on startup and refuses to
        boot if anything comes back. We collect *all* errors at once
        rather than failing fast so an operator can fix everything in
        a single restart instead of playing whack-a-mole.
        """
        if not self.is_production:
            return []

        errors: list[str] = []

        if self.SECRET_KEY == _INSECURE_SECRET_PLACEHOLDER:
            errors.append(
                "SECRET_KEY is still the development placeholder. "
                "Set a long random value (e.g. `python -c \"import secrets; "
                "print(secrets.token_urlsafe(64))\"`) before deploying."
            )
        if len(self.SECRET_KEY) < 32:
            errors.append(
                "SECRET_KEY is shorter than 32 chars — too weak for JWT signing "
                "and at-rest encryption. Use 64+ random URL-safe chars."
            )
        if not self.allowed_origins_list:
            errors.append(
                "ALLOWED_ORIGINS is empty. Set it to the public origin of the "
                "frontend (e.g. https://chat.example.com) before deploying."
            )
        if any(o == "*" for o in self.allowed_origins_list):
            errors.append(
                "ALLOWED_ORIGINS contains '*'. Wildcard CORS is incompatible "
                "with credentials — list explicit origins instead."
            )
        if not self.COOKIE_SECURE:
            errors.append(
                "COOKIE_SECURE is False in a production environment. The "
                "refresh-token cookie would travel over plain HTTP."
            )
        return errors


@lru_cache
def get_settings() -> Settings:
    return Settings()
