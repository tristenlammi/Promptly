"""Container bootstrap: apply migrations, provision singleton user + admin.

Invoked by the Docker entrypoint (see backend/entrypoint.sh) before uvicorn
starts. Running as a separate process keeps the server startup path fast and
surfaces migration errors loudly instead of being swallowed by lifespan.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import select

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.deps import SINGLE_USER_EMAIL, SINGLE_USER_USERNAME
from app.auth.models import User
from app.auth.utils import hash_password
from app.config import get_settings
from app.database import SessionLocal
from app.files.system_folders import seed_system_folders
from app.search.models import SearchProvider

from app.logging_setup import configure_logging  # noqa: E402

# Bootstrap runs before uvicorn so configure the JSON logger eagerly.
# ``enable_ring=False`` because the ring buffer is only useful in the
# long-running web process — the bootstrap pass exits.
configure_logging(enable_ring=False)
logger = logging.getLogger("promptly.bootstrap")


def run_migrations() -> None:
    settings = get_settings()
    cfg_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = Config(str(cfg_path))
    cfg.set_main_option("script_location", str(cfg_path.parent / "alembic"))
    cfg.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    logger.info("Running Alembic migrations to head...")
    command.upgrade(cfg, "head")
    logger.info("Migrations complete.")


async def provision_singleton_user() -> None:
    """Legacy path for SINGLE_USER_MODE deployments."""
    settings = get_settings()
    if not settings.SINGLE_USER_MODE:
        return

    async with SessionLocal() as db:
        existing = await db.execute(
            select(User).where(User.username == SINGLE_USER_USERNAME)
        )
        if existing.scalar_one_or_none() is not None:
            logger.info("Singleton user already exists.")
            return

        # Generate a random password — this user is never logged in by password
        # anyway, since SINGLE_USER_MODE bypasses auth. It's stored only to
        # satisfy the NOT NULL constraint on password_hash.
        random_password = secrets.token_urlsafe(32)
        user = User(
            email=SINGLE_USER_EMAIL,
            username=SINGLE_USER_USERNAME,
            password_hash=hash_password(random_password),
            role="admin",
            settings={},
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
        # Seed the system folders (Chat Uploads / Generated Files / ...)
        # straight away so the singleton user's Files page is populated
        # before they ever upload anything.
        await seed_system_folders(db, user)
        await db.commit()
        logger.info(
            "Provisioned singleton user: username=%s email=%s",
            SINGLE_USER_USERNAME,
            SINGLE_USER_EMAIL,
        )


async def provision_default_search_provider() -> None:
    """Ensure a system-wide SearXNG search provider exists.

    Users can add their own (Brave, Tavily, etc.) via the Search API, but this
    guarantees the out-of-box web-search toggle works against the bundled
    SearXNG sidecar without any user action.
    """
    settings = get_settings()
    async with SessionLocal() as db:
        existing = await db.execute(
            select(SearchProvider).where(
                SearchProvider.user_id.is_(None),
                SearchProvider.type == "searxng",
            )
        )
        if existing.scalar_one_or_none() is not None:
            return

        sp = SearchProvider(
            user_id=None,
            name="SearXNG (system)",
            type="searxng",
            config={
                "url": settings.SEARXNG_URL,
                "result_count": settings.SEARCH_RESULT_COUNT,
            },
            is_default=True,
            enabled=True,
        )
        db.add(sp)
        await db.commit()
        logger.info("Provisioned system SearXNG search provider (%s)", settings.SEARXNG_URL)


async def provision_app_settings() -> None:
    """Belt-and-braces: ensure the singleton app_settings row exists.

    The Alembic migration (0007_security_foundation) seeds it on first
    upgrade, but if someone wipes the row by hand or restores from a
    very old backup we re-create it here with safe defaults so the
    rest of the app can always assume ``db.get(AppSettings, ID)`` is
    non-null.
    """
    async with SessionLocal() as db:
        existing = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        if existing is not None:
            return
        db.add(AppSettings(id=SINGLETON_APP_SETTINGS_ID))
        await db.commit()
        logger.info("Provisioned singleton app_settings row.")


def _generate_vapid_keypair() -> tuple[str, str]:
    """Return a fresh ``(public_key_b64url, private_key_pem)`` pair.

    Inlined from ``backend/scripts/generate_vapid_keys.py`` (which
    remains the manual operator-facing CLI) so bootstrap doesn't need
    to import that module — the ``scripts/`` directory isn't a Python
    package and adding an ``__init__.py`` just to share these 12 lines
    would be more code than the duplication. The two implementations
    must stay byte-for-byte equivalent so the keypair format is
    consistent across the manual CLI and the auto-provision path.
    """
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()
    pub_bytes = (
        b"\x04"
        + public_numbers.x.to_bytes(32, "big")
        + public_numbers.y.to_bytes(32, "big")
    )
    public_b64 = base64.urlsafe_b64encode(pub_bytes).rstrip(b"=").decode("ascii")
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    return public_b64, pem


async def provision_vapid_keys() -> None:
    """Auto-generate a Web Push (VAPID) keypair on first boot.

    Replaces the old manual flow ("run ``python backend/scripts/
    generate_vapid_keys.py`` and paste the output into ``.env``") so a
    brand-new install gets working push notifications with zero
    operator action.

    Behaviour:

    * If the operator pre-set ``VAPID_PUBLIC_KEY`` / ``VAPID_PRIVATE_KEY``
      in ``.env`` (typical when restoring from an older deployment to
      avoid invalidating existing browser subscriptions), those values
      are mirrored into the DB so the runtime read path sees a single
      source of truth.
    * Otherwise, if either DB column is NULL, a fresh keypair is
      generated and stored. This is the common path on first boot.
    * On re-runs both columns are already populated, so this function
      is a no-op — the keypair is stable across restarts.

    Rotating the keys (deleting the columns by hand and rebooting)
    invalidates every existing browser subscription, so don't rotate
    casually.
    """
    settings = get_settings()
    async with SessionLocal() as db:
        row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        if row is None:
            # provision_app_settings should have created it already, but
            # if a downgrade-then-upgrade left things weird we just bail
            # quietly — the next boot will retry.
            return

        # Honour an env-pinned keypair so existing deployments can avoid
        # re-issuing keys (which would invalidate every browser
        # subscription) on upgrade.
        env_pub = settings.VAPID_PUBLIC_KEY.strip()
        env_priv = settings.VAPID_PRIVATE_KEY.strip()
        env_contact = settings.VAPID_CONTACT.strip() or None

        changed = False
        if env_pub and env_priv:
            if row.vapid_public_key != env_pub:
                row.vapid_public_key = env_pub
                changed = True
            if row.vapid_private_key != env_priv:
                row.vapid_private_key = env_priv
                changed = True
        elif row.vapid_public_key is None or row.vapid_private_key is None:
            pub, priv = _generate_vapid_keypair()
            row.vapid_public_key = pub
            row.vapid_private_key = priv
            changed = True
            logger.info("Generated a fresh VAPID keypair for Web Push.")

        if env_contact and row.vapid_contact != env_contact:
            row.vapid_contact = env_contact
            changed = True
        elif row.vapid_contact is None:
            # Default contact — push services accept either mailto: or
            # https: URIs; this placeholder is fine until an admin
            # customises it under Admin → Settings.
            row.vapid_contact = "mailto:admin@localhost"
            changed = True

        if changed:
            await db.commit()


async def _provision_all() -> None:
    """Run every async provisioning step inside a single event loop.

    SQLAlchemy's async engine pools asyncpg connections to the loop that
    opened them — running provisioning steps across multiple `asyncio.run`
    calls leaves pooled connections bound to closed loops and subsequent
    calls raise ``Future attached to a different loop``.
    """
    await provision_app_settings()
    await provision_vapid_keys()
    await provision_singleton_user()
    await provision_default_search_provider()


def main() -> int:
    try:
        run_migrations()
    except Exception:  # noqa: BLE001 — want full traceback on container stdout
        logger.exception("Migration failed")
        return 1

    try:
        asyncio.run(_provision_all())
    except Exception:  # noqa: BLE001
        logger.exception("Async provisioning failed")
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())


# Respect RUN_BOOTSTRAP_ONLY env var for one-shot use in CI/ad-hoc jobs.
_RUN_ON_IMPORT = os.environ.get("PROMPTLY_BOOTSTRAP_ON_IMPORT") == "1"
if _RUN_ON_IMPORT:
    sys.exit(main())
