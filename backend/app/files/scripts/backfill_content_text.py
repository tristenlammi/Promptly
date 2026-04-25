"""One-shot backfill for ``files.content_text``.

Walks every ``UserFile`` row whose ``content_text`` is NULL and
attempts to extract plain text via
:func:`app.files.extraction.extract_content_text`. Commits in
batches so a crash midway through a huge instance doesn't lose
progress.

Usage (inside the backend container):

    python -m app.files.scripts.backfill_content_text

Safe to re-run — rows that already have ``content_text`` populated
are skipped. Re-run after bulk imports or after tuning the
extraction heuristic.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import SessionLocal as AsyncSessionLocal
from app.files.extraction import extract_content_text
from app.files.models import UserFile

logger = logging.getLogger("promptly.files.backfill")

# Rows to fetch and commit per batch. Keeps memory + transaction
# size bounded on large installs.
_BATCH_SIZE = 200


async def _fetch_batch(
    session: AsyncSession, last_id: "str | None"
) -> Sequence[UserFile]:
    stmt = select(UserFile).where(UserFile.content_text.is_(None)).order_by(
        UserFile.id.asc()
    )
    if last_id is not None:
        stmt = stmt.where(UserFile.id > last_id)  # type: ignore[arg-type]
    stmt = stmt.limit(_BATCH_SIZE)
    return (await session.execute(stmt)).scalars().all()


async def run() -> None:
    processed = 0
    extracted = 0
    last_id: str | None = None
    async with AsyncSessionLocal() as session:
        while True:
            batch = await _fetch_batch(session, last_id)
            if not batch:
                break
            for row in batch:
                processed += 1
                try:
                    text = extract_content_text(row)
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "backfill extraction crashed for %s", row.id
                    )
                    text = None
                if text is not None:
                    row.content_text = text
                    extracted += 1
            await session.commit()
            last_id = str(batch[-1].id)
            logger.info(
                "backfill progress: processed=%d extracted=%d (cursor=%s)",
                processed,
                extracted,
                last_id,
            )
    logger.info(
        "backfill complete: processed=%d extracted=%d", processed, extracted
    )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    asyncio.run(run())


if __name__ == "__main__":
    main()
