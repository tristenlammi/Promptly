"""Background email sync scheduler (Phase 12 — E.1).

Polls email_accounts every ~5 minutes using ``FOR UPDATE SKIP LOCKED``
so multiple backend workers never double-fire the same account sync.
Mirrors the Tasks scheduler pattern (app/tasks/scheduler.py).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
from app.auth.utils import decrypt_secret
from app.database import SessionLocal
from app.email.models import EmailAccount
from app.email.sync import sync_account
from app.email.triage import triage_pending

logger = logging.getLogger("promptly.email.scheduler")

POLL_INTERVAL_SECONDS = 60  # Check every minute; next_sync_at gates actual work
_CLAIM_LIMIT = 10  # Max accounts synced per tick


async def _claim_due() -> list[dict]:
    """Claim due email accounts, returning their ids + OAuth config."""
    now = datetime.now(timezone.utc)
    account_data: list[dict] = []

    async with SessionLocal() as db:
        # Check global kill switch
        settings = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        if not settings or not settings.email_integration_enabled:
            return []

        client_id = settings.google_oauth_client_id
        client_secret_enc = settings.google_oauth_client_secret_enc
        if not client_id or not client_secret_enc:
            return []

        try:
            client_secret = decrypt_secret(client_secret_enc)
        except Exception:
            logger.error("Failed to decrypt Google OAuth client secret")
            return []

        rows = (
            await db.execute(
                select(EmailAccount)
                .where(
                    EmailAccount.enabled.is_(True),
                    EmailAccount.next_sync_at.is_not(None),
                    EmailAccount.next_sync_at <= now,
                )
                .order_by(EmailAccount.next_sync_at.asc())
                .limit(_CLAIM_LIMIT)
                .with_for_update(skip_locked=True)
            )
        ).scalars().all()

        for account in rows:
            # Advance next_sync_at immediately to prevent double-fire
            from datetime import timedelta
            account.next_sync_at = now + timedelta(minutes=6)
            account_data.append({
                "account_id": account.id,
                "client_id": client_id,
                "client_secret": client_secret,
            })

        await db.commit()

    return account_data


async def _run_sync(account_id, client_id: str, client_secret: str) -> None:
    """Execute one account sync in its own DB session."""
    async with SessionLocal() as db:
        account = await db.get(EmailAccount, account_id)
        if not account or not account.enabled:
            return
        try:
            counters = await sync_account(db, account, client_id, client_secret)
            logger.info(
                "Email sync complete: account=%s new=%d updated=%d writebacks=%d",
                account_id, counters["new"], counters["updated"], counters["writebacks"],
            )
        except Exception as exc:
            logger.exception("Email sync failed for account %s: %s", account_id, exc)
            account.last_sync_error = str(exc)[:500]
            from datetime import timedelta
            account.next_sync_at = datetime.now(timezone.utc) + timedelta(minutes=10)
            await db.commit()


async def _run_triage() -> None:
    """Run the triage pass in its own DB session."""
    async with SessionLocal() as db:
        try:
            n = await triage_pending(db)
            if n:
                logger.info("Email triage: processed %d messages", n)
        except Exception:
            logger.exception("Email triage pass failed")


async def _loop() -> None:
    logger.info("Email sync scheduler started")
    triage_tick = 0
    while True:
        try:
            due = await _claim_due()
            for item in due:
                asyncio.create_task(
                    _run_sync(item["account_id"], item["client_id"], item["client_secret"]),
                    name=f"email_sync_{item['account_id']}",
                )
            if due:
                logger.info("Email scheduler dispatched %d sync(s)", len(due))

            # Run triage every 3 ticks (~3 min) so it doesn't hammer the model
            triage_tick += 1
            if triage_tick >= 3:
                triage_tick = 0
                asyncio.create_task(_run_triage(), name="email_triage")

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Email scheduler tick failed; will retry")

        await asyncio.sleep(POLL_INTERVAL_SECONDS)


def start_email_scheduler() -> asyncio.Task[None]:
    """Spawn the email sync loop; caller cancels the handle on shutdown."""
    return asyncio.create_task(_loop(), name="email_scheduler")
