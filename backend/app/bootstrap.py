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
from app.models_config.models import ModelProvider
from app.models_config.service import encrypt_api_key
from app.search.models import SearchProvider

from app.logging_setup import configure_logging  # noqa: E402

# Bootstrap runs before uvicorn so configure the JSON logger eagerly.
# ``enable_ring=False`` because the ring buffer is only useful in the
# long-running web process — the bootstrap pass exits.
configure_logging(enable_ring=False)
logger = logging.getLogger("promptly.bootstrap")


def _alembic_cfg() -> Config:
    settings = get_settings()
    cfg_path = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = Config(str(cfg_path))
    cfg.set_main_option("script_location", str(cfg_path.parent / "alembic"))
    cfg.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    return cfg


def run_migrations() -> None:
    cfg = _alembic_cfg()
    logger.info("Running Alembic migrations to head...")
    command.upgrade(cfg, "head")
    logger.info("Migrations complete.")


class SchemaAheadError(RuntimeError):
    """The database was migrated by newer code than this image."""


# Filled by the pre-migration backup, recorded once ``backup_runs`` exists.
_premigrate_record: dict | None = None


async def _pre_migration_backup() -> None:
    """Dump the database before applying a schema change (WP-0.2, R-237).

    Updates used to apply irreversible, data-deleting migrations with
    nothing to roll back to. Runs only when there's something to migrate on
    an existing install. Fails closed: if the dump can't be taken the
    migration doesn't run, and the log says how to proceed anyway
    (``PROMPTLY_SKIP_PREMIGRATE_BACKUP=1``).
    """
    global _premigrate_record
    from alembic.script import ScriptDirectory
    from sqlalchemy import text

    from app.backups.service import dump_database, server_major
    from app.database import engine

    script = ScriptDirectory.from_config(_alembic_cfg())
    head = script.get_current_head()
    try:
        async with SessionLocal() as db:
            try:
                current = (
                    await db.execute(text("SELECT version_num FROM alembic_version"))
                ).scalar_one_or_none()
            except Exception:  # noqa: BLE001 — no table yet: a fresh install
                current = None
            if current is None or current == head:
                return
            try:
                script.get_revision(current)
            except Exception as e:  # noqa: BLE001 — revision not in this code
                raise SchemaAheadError(
                    f"The database is at schema revision {current}, which this "
                    f"version of Promptly doesn't know (its newest is {head}). "
                    "It was upgraded by a newer release. Run that release again, "
                    "or restore the backup taken before the upgrade "
                    "(data/backups/pre-migrate-*.dump, see README → Backups)."
                ) from e
            if os.environ.get("PROMPTLY_SKIP_PREMIGRATE_BACKUP") == "1":
                logger.warning(
                    "Skipping the pre-migration backup (PROMPTLY_SKIP_PREMIGRATE_BACKUP=1)"
                )
                return
            logger.info("Schema %s -> %s: backing up the database first...", current, head)
            res = await dump_database(
                "pre_migrate", label=current, server_version=await server_major(db)
            )
            logger.info("Pre-migration backup written: %s (%d bytes)", res.path.name, res.size_bytes)
            _premigrate_record = {
                "filename": res.path.name, "size_bytes": res.size_bytes, "revision": current,
            }
    finally:
        await engine.dispose()


async def _record_premigrate_backup() -> None:
    if not _premigrate_record:
        return
    from datetime import datetime, timezone

    from app.backups.models import BackupRun

    async with SessionLocal() as db:
        db.add(
            BackupRun(
                kind="pre_migrate", status="ok", finished_at=datetime.now(timezone.utc),
                **_premigrate_record,
            )
        )
        await db.commit()


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
    if not settings.SEARXNG_ENABLED:
        # Installed without the bundled SearXNG container — don't provision
        # a default provider that points at a host which will never exist.
        # Operators can still add Brave/Tavily (or an external SearXNG)
        # from the admin panel.
        return
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


async def provision_env_model_provider() -> None:
    """Seed a chat model provider from an ``*_API_KEY`` env var, if one is set.

    Without this, an operator who put ``OPENROUTER_API_KEY`` in their ``.env``
    still had to re-enter the same key in the first-run wizard — and if they
    skipped that step, the install finished in a state where Promptly could
    not answer anything at all. The setup wizard detects the provider this
    creates and skips its provider step entirely.

    Only runs when there is no provider yet, so it never fights an operator
    who has since configured providers in the admin panel. First match wins,
    in preference order; the rest can be added from Admin → Models.
    """
    settings = get_settings()
    candidates: list[tuple[str, str, str]] = [
        # (provider type, display name, key)
        ("openrouter", "OpenRouter", settings.OPENROUTER_API_KEY),
        ("anthropic", "Anthropic", settings.ANTHROPIC_API_KEY),
        ("openai", "OpenAI", settings.OPENAI_API_KEY),
    ]
    chosen = next(((t, n, k.strip()) for t, n, k in candidates if k and k.strip()), None)
    if chosen is None:
        return

    provider_type, name, api_key = chosen
    async with SessionLocal() as db:
        existing = await db.execute(select(ModelProvider).limit(1))
        if existing.scalar_one_or_none() is not None:
            # Somebody has already configured providers — leave them alone.
            return

        mp = ModelProvider(
            user_id=None,  # system-wide
            name=name,
            # base_url stays NULL: provider.py resolves a per-type default at
            # call time, so we don't bake a host into the row.
            base_url=None,
            type=provider_type,
            api_key=encrypt_api_key(api_key),
            enabled=True,
            models=[],
        )
        # Fetch the real catalog now. Left empty, the provider looked
        # "connected" in the wizard while the chat picker had nothing to
        # offer until someone found "Refresh models" (R-283). Best effort:
        # offline or a bad key keeps the empty list, as before.
        try:
            from app.models_config.provider import model_router

            mp.models = await asyncio.wait_for(model_router.list_models(mp), timeout=20)
        except Exception:  # noqa: BLE001
            logger.warning("Couldn't fetch the %s model list at startup", name, exc_info=True)
        db.add(mp)
        await db.commit()
        logger.info(
            "Provisioned %s model provider from environment (%s_API_KEY).",
            name,
            provider_type.upper(),
        )


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
        elif row.vapid_contact in (None, "mailto:admin@localhost"):
            # Push services use this to reach whoever runs the server when
            # something's wrong; some reject a placeholder. Use the first
            # admin's address once there is one (R-167).
            from app.auth.models import User

            admin_email = (
                await db.execute(
                    select(User.email)
                    .where(User.role == "admin", User.disabled.is_(False))
                    .order_by(User.created_at)
                    .limit(1)
                )
            ).scalar_one_or_none()
            contact = f"mailto:{admin_email}" if admin_email else "mailto:admin@localhost"
            if row.vapid_contact != contact:
                row.vapid_contact = contact
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
    await _record_premigrate_backup()
    await provision_app_settings()
    await provision_vapid_keys()
    await provision_singleton_user()
    await provision_default_search_provider()
    await provision_env_model_provider()


def main() -> int:
    try:
        asyncio.run(_pre_migration_backup())
    except SchemaAheadError as e:
        logger.error("%s", e)
        return 3
    except Exception:  # noqa: BLE001
        logger.exception(
            "Couldn't back up the database before migrating, so the migration "
            "was not run. Free some disk space or fix the error above; to "
            "migrate without a backup, set PROMPTLY_SKIP_PREMIGRATE_BACKUP=1."
        )
        return 4

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
