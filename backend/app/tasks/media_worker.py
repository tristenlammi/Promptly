"""The media worker (WP-7.4, Part C §4.5) — its own container, its own queue.

Photo and video work (metadata, thumbnails, previews, transcodes) is CPU
heavy and arrives in floods (a phone backup is hundreds of files), so it
runs here, not on the general worker or in the API:

* the ``promptly:media`` Arq queue, ``max_jobs`` 2 — and one video at a
  time inside that (``media_pipeline._VIDEO_SLOT``);
* a ``cpus:`` limit in compose and ``nice``-d ffmpeg, so chat stays quick
  while 500 photos are processed;
* the DB row is the source of truth: a sweep every 20 minutes re-queues
  stuck or failed rows and anything never queued.

Run: ``arq app.tasks.media_worker.MediaWorkerSettings``.
"""
from __future__ import annotations

from arq.connections import RedisSettings
from arq.cron import cron
from arq.worker import func
from PIL import Image

from app.config import get_settings
from app.tasks.queue import MEDIA_INGEST, MEDIA_QUEUE

# A 200 MP phone shot is ~12240 × 16320. The API keeps its 40 MP cap; only
# this worker may decode this much (Part C §4.4).
Image.MAX_IMAGE_PIXELS = 250_000_000


async def ingest_media_job(ctx, file_id: str) -> str:
    from app.files.media_pipeline import ingest

    return await ingest(file_id)


async def media_sweep(ctx) -> None:
    from app.files.media_pipeline import sweep

    await sweep()


_TICK_LOCK = "promptly:photos:understand-tick"


async def understand_tick(ctx) -> dict:
    """Understanding photos (PH-2): up to 50 s of whatever is pending,
    newest uploads first. One at a time: a tick that's still busy (a slow
    batch on a small CPU) makes the next minute's skip, rather than two
    working on the same photos."""
    from app.photos.understanding import tick
    from app.redis_client import redis

    if not await redis.set(_TICK_LOCK, "1", nx=True, ex=_TICK_TIMEOUT):
        return {"skipped": "the last tick is still running"}
    try:
        return await tick()
    finally:
        await redis.delete(_TICK_LOCK)


async def _startup(ctx) -> None:
    from app.tasks.worker import wait_for_schema

    await wait_for_schema(ctx)


ingest_media_job.__name__ = MEDIA_INGEST
# Room for the 50 s budget plus one slow batch finishing (reading the text
# in 8 photos can take a minute on a small CPU) — cut off any sooner, the
# batch was lost and redone every minute.
_TICK_TIMEOUT = 300


class MediaWorkerSettings:
    queue_name = MEDIA_QUEUE
    functions = [
        # A long video on CPU can take a while; a file that fails twice is
        # left "failed" for the sweep's capped retries.
        func(ingest_media_job, timeout=3 * 3600, max_tries=2),
    ]
    cron_jobs = [
        cron(media_sweep, minute={5, 25, 45}, run_at_startup=True, unique=True),
        # Every minute; one at a time (``unique``), in its own slot below.
        cron(understand_tick, minute=None, second=30, run_at_startup=False, unique=True, timeout=_TICK_TIMEOUT),
    ]
    on_startup = _startup
    redis_settings = RedisSettings.from_dsn(get_settings().REDIS_URL)
    # Two for new photos and videos, one for understanding (PH-2).
    max_jobs = 3
    job_timeout = 3 * 3600
    keep_result = 0


__all__ = ["MediaWorkerSettings"]
