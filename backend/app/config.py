"""Application settings loaded from environment variables."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
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

    # ---- Host-header allowlist ----
    # Optional Starlette TrustedHostMiddleware allowlist. Empty (default)
    # disables the app-layer check: the reverse proxy is the primary Host
    # guard, and internal docker service-to-service calls (collab→backend
    # snapshot, healthchecks) use container hostnames a naive allowlist
    # would wrongly reject. Set to a comma list of public hostnames to
    # additionally enforce Host validation at the app layer — loopback and
    # the internal ``backend`` service name are always permitted on top.
    TRUSTED_HOSTS: str = ""

    @property
    def trusted_hosts_list(self) -> list[str]:
        return [h.strip() for h in self.TRUSTED_HOSTS.split(",") if h.strip()]

    # ---- Trusted reverse proxies (real client-IP extraction) ----
    # The per-IP rate limiters and the audit log need the *real* client IP,
    # which arrives in forwarded headers (CF-Connecting-IP / X-Real-IP /
    # X-Forwarded-For). Those headers are trivially spoofable, so we ONLY
    # honour them when the socket peer — the machine that actually opened the
    # TCP connection to us — is one of these trusted proxy networks. A client
    # that reaches the backend directly on a public IP is NOT trusted, so it
    # cannot forge its source and defeat login/MFA throttling.
    #
    # Default: loopback + RFC1918 + ULA/link-local. In the bundled stack the
    # peer is always the nginx container on the private docker network, so it
    # works out of the box. On a public host, keep this to your proxy/docker
    # ranges only and never expose the backend port directly to the internet.
    TRUSTED_PROXY_IPS: str = (
        "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,"
        "fc00::/7,fe80::/10"
    )

    @property
    def trusted_proxy_networks(self) -> list:
        import ipaddress

        nets: list = []
        for chunk in self.TRUSTED_PROXY_IPS.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            try:
                nets.append(ipaddress.ip_network(chunk, strict=False))
            except ValueError:
                continue
        return nets

    # ---- MFA cookies ----
    # Cookie that carries the trusted-device token. Bound to /api so it
    # never leaks to the SPA or to third parties. The value itself is a
    # 256-bit URL-safe random string; the DB only stores its sha256.
    MFA_TRUSTED_DEVICE_COOKIE_NAME: str = "promptly_trusted_device"

    # ---- Account lockout ----
    # Number of consecutive failed logins before the account is locked.
    # Reset to 0 on a successful login.
    LOCKOUT_THRESHOLD: int = 5
    # How long a brute-force lockout stays in force before it auto-expires
    # on the next login attempt. A non-zero cooldown is what stops the
    # lockout from doubling as a denial-of-service lever: because login
    # accepts a username/email and any authenticated user can enumerate
    # handles via the share directory, a permanent lock would let anyone
    # freeze any account (admins included) with LOCKOUT_THRESHOLD bad
    # submissions. 15 minutes is the OWASP-recommended default. Set to 0
    # to restore the old permanent-until-admin-unlock behaviour. An admin
    # can always unlock early via POST /api/admin/users/{id}/unlock, and a
    # genuinely malicious account should be hard-``disabled`` instead.
    LOCKOUT_COOLDOWN_MINUTES: int = 15

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

    # ---- Session tokens ----
    # Refresh-token lifetime. The access token is short (15 min) and rotates;
    # the refresh token is the longer-lived credential, so its TTL bounds how
    # long a *stolen* refresh token stays usable. 3 days keeps an active user
    # (the SPA refreshes on focus) logged in while shrinking the theft window
    # vs. the old 7-day default. (Full rotation-reuse detection would need a
    # server-side refresh-session table — a follow-up.) token_version still
    # revokes everything instantly on password reset / "log out everywhere".
    REFRESH_TOKEN_TTL_DAYS: int = 3
    ACCESS_TOKEN_TTL_MINUTES: int = 15

    # ---- Database ----
    DATABASE_URL: str = (
        "postgresql+asyncpg://promptly:promptly@postgres:5432/promptly"
    )

    # ---- Redis ----
    REDIS_URL: str = "redis://redis:6379/0"

    # ---- Code interpreter sandbox (Phase 4) ----
    # Base URL of the isolated execution worker. Empty disables the
    # ``code_interpreter`` tool entirely (it'll report itself as
    # unavailable rather than silently failing). The shared secret is
    # sent on every job so only the backend can submit work.
    CODE_SANDBOX_URL: str = "http://sandbox:8000"
    CODE_SANDBOX_SECRET: str = ""
    CODE_SANDBOX_TIMEOUT_S: int = 30

    # ---- Speech-to-text (Voice Phase 1) ----
    # ``STT_BACKEND`` selects how dictation clips are transcribed:
    #   * ``local``  — POST the audio to the bundled faster-whisper
    #     service at ``WHISPER_URL`` (private, self-hosted, default).
    #   * ``openai`` — use OpenAI's hosted transcription API (needs
    #     ``OPENAI_API_KEY``). Lower latency / higher accuracy, but the
    #     audio leaves the box.
    # Empty ``WHISPER_URL`` disables the local path (the endpoint then
    # returns a friendly 503 instead of hanging).
    STT_BACKEND: str = "local"
    WHISPER_URL: str = "http://whisper:8000"
    # Model the cloud path asks for when ``STT_BACKEND=openai``. ``whisper-1``
    # is the broadly-available default; ``gpt-4o-transcribe`` is newer/better
    # where the account has access.
    STT_OPENAI_MODEL: str = "whisper-1"
    # Hard ceiling on an uploaded dictation clip (bytes). Mirrors the
    # whisper worker's own cap so we reject early at the edge.
    STT_MAX_AUDIO_BYTES: int = 25 * 1024 * 1024
    # How long we'll wait on the transcription backend before giving up.
    STT_TIMEOUT_S: int = 60

    # ---- Text-to-speech (Voice Phase 2) ----
    # Internal-only Kokoro worker the backend POSTs assistant text to for
    # read-aloud + voice mode. Empty disables TTS (the endpoint returns a
    # friendly 503).
    TTS_URL: str = "http://tts:8000"
    # Default Kokoro voice. Overridable per request by the client.
    TTS_VOICE: str = "af_heart"
    # Longest chunk of text we'll synthesise in one call. Voice mode feeds
    # sentences, so this is a generous safety cap, not a normal limit.
    TTS_MAX_CHARS: int = 4000
    TTS_TIMEOUT_S: int = 60

    # ---- Search ----
    SEARXNG_URL: str = "http://searxng:8080"
    # False when the operator installed without the bundled SearXNG
    # container (install.sh --no-search / --minimal). Gates the health
    # probe's SearXNG component so a search-less stack can report 200,
    # and skips provisioning the system SearXNG search provider.
    SEARXNG_ENABLED: bool = True
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

        Used to gate doc-exposure and to decide whether the wizard
        should warn about insecure cookie settings on a non-localhost
        public origin.
        """
        if self.DEBUG:
            return False
        return self.DOMAIN.strip().lower() not in {"", "localhost", "127.0.0.1"}

    @model_validator(mode="after")
    def _mirror_sandbox_secret(self) -> "Settings":
        """The code-sandbox bearer reuses ``SECRET_KEY`` by default.

        Compose already passes it through explicitly, but this keeps a
        bare ``uvicorn``/non-compose launch (``.env`` sets ``SECRET_KEY``
        only) working the same way, rather than backend and sandbox
        landing on mismatched — or empty — bearers.
        """
        if not self.CODE_SANDBOX_SECRET:
            self.CODE_SANDBOX_SECRET = self.SECRET_KEY
        return self

    def validate_boot_safety(self) -> list[str]:
        """Return a list of fatal-config errors that prevent boot.

        Trimmed down from the old ``validate_production_safety`` to
        cover only the things that genuinely have to be set before the
        backend can serve the first request. ``DOMAIN`` /
        ``ALLOWED_ORIGINS`` / ``COOKIE_SECURE`` are no longer in scope
        — they're handled by the first-run wizard's
        ``validate_wizard_safety`` check at the moment the operator
        saves a public origin, with the result surfaced in the wizard
        UI as a warning rather than a refused boot.

        Currently boot-fatal:
          * ``SECRET_KEY`` is the dev placeholder
          * ``SECRET_KEY`` is shorter than 32 chars

        Both are guaranteed to be satisfied by the install script
        (``./install.sh`` / ``install.ps1``) which seeds a 64-hex-char
        value the moment ``.env`` is created. The check exists to
        catch hand-edited ``.env`` files that lost the seed.
        """
        errors: list[str] = []

        # Always fatal: the exact dev sentinel or a too-short key — these are
        # unsafe even on a local box and signal a broken .env.
        if self.SECRET_KEY == _INSECURE_SECRET_PLACEHOLDER:
            errors.append(
                "SECRET_KEY is still the development placeholder. "
                "Re-run ./install.sh (or ./install.ps1 on Windows) to seed "
                "a strong value, or set one manually in .env."
            )
        if len(self.SECRET_KEY) < 32:
            errors.append(
                "SECRET_KEY is shorter than 32 chars — too weak for JWT signing "
                "and at-rest encryption. Use 64+ random URL-safe chars."
            )
        # Production-only (non-localhost DOMAIN): reject placeholder secrets +
        # default datastore credentials. Gated on ``is_production`` so a local
        # dev box (DOMAIN=localhost) with the bundled placeholders still boots,
        # while a public deployment that skipped the installer is refused —
        # a "change-me" SECRET_KEY there is a PUBLICLY-KNOWN signing/encryption
        # key (forgeable JWTs). The .env.example placeholder is long enough to
        # sail past the length check above, so this substring guard is what
        # actually catches the "copied the example, skipped the installer" case.
        if self.is_production:
            lowered_secret = self.SECRET_KEY.lower()
            if "change-me" in lowered_secret or "changeme" in lowered_secret:
                errors.append(
                    "SECRET_KEY still contains a 'change-me' placeholder on a "
                    "public DOMAIN. Generate a real one (openssl rand -hex 32) "
                    "— a known key lets anyone forge login tokens."
                )
            db_url = self.DATABASE_URL.lower()
            if "change-me" in db_url or "promptly:promptly@" in db_url:
                errors.append(
                    "DATABASE_URL uses a default/placeholder password on a "
                    "public DOMAIN. Set a strong POSTGRES_PASSWORD in .env."
                )
            redis_url = self.REDIS_URL.lower()
            if "change-me" in redis_url:
                errors.append(
                    "REDIS_URL contains a 'change-me' placeholder password. "
                    "Set a real REDIS_PASSWORD in .env."
                )
        # SINGLE_USER_MODE returns the admin user with NO token check, so
        # it must never run on a network-reachable host. Allow it only for
        # localhost / private-LAN / dev. ``getattr`` keeps this resilient
        # if a field is renamed (the guard simply won't false-trigger).
        if getattr(self, "SINGLE_USER_MODE", False) and not getattr(
            self, "DEV_MODE", False
        ):
            domain = (getattr(self, "DOMAIN", "") or "").strip().lower()
            # Exact host match (not substring — ``localhost.evil.com`` must
            # NOT pass) plus a real private-IP check so a hostname like
            # ``10.evil.com`` can't masquerade as the 10/8 range.
            host_only = domain.split(":", 1)[0]
            is_local = host_only in {"", "localhost", "127.0.0.1", "::1"}
            if not is_local:
                import ipaddress

                try:
                    ip = ipaddress.ip_address(host_only)
                    is_local = ip.is_private or ip.is_loopback
                except ValueError:
                    is_local = False
            if not is_local:
                errors.append(
                    "SINGLE_USER_MODE=true with a public DOMAIN "
                    f"({getattr(self, 'DOMAIN', None)!r}) — this disables ALL "
                    "authentication on a network-reachable deployment. Set "
                    "SINGLE_USER_MODE=false (or only enable it on localhost/dev)."
                )
        return errors

    # Backwards-compat alias for any third-party code (or older
    # ``main.py`` snapshots) that still imports the old name. Safe to
    # remove once a deployment cycle has rolled forward.
    def validate_production_safety(self) -> list[str]:
        return self.validate_boot_safety()

    def validate_wizard_safety(
        self, *, public_origin: str | None
    ) -> list[str]:
        """Return non-fatal warnings for the wizard's "public URL" step.

        The wizard surfaces these alongside the save action so the
        operator can choose to proceed anyway (e.g. they're behind a
        Cloudflare Tunnel that handles TLS, so HTTP-on-the-origin is
        intentional). None of them refuse the save — that decision is
        the operator's, not the framework's.
        """
        warnings: list[str] = []
        if public_origin and public_origin.startswith("http://"):
            host = public_origin[len("http://") :].split("/", 1)[0].lower()
            host_only = host.split(":", 1)[0]
            if host_only not in {"localhost", "127.0.0.1", "::1"}:
                warnings.append(
                    "Your public URL is plain HTTP. For anything past local "
                    "testing, front Promptly with HTTPS (Cloudflare Tunnel, "
                    "Caddy, Traefik, or nginx + Let's Encrypt). The "
                    "auth cookie is set Secure=true by default and won't "
                    "survive a plain HTTP origin."
                )
        if not self.COOKIE_SECURE:
            warnings.append(
                "COOKIE_SECURE is False in your .env. The refresh-token "
                "cookie will travel over plain HTTP — only safe in local "
                "dev. Set COOKIE_SECURE=true for any public deployment."
            )
        return warnings


@lru_cache
def get_settings() -> Settings:
    return Settings()
