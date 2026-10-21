"""Understanding photos, stage by stage (PH-2, Part E §E4.1).

Each stage (``place`` and ``quality`` now; embeddings, faces, animals, text
and captions as the ``photos-ml`` service brings them) records, per photo,
which version of it ran, on which input, and whether it worked — one row in
``photo_understanding``. That row is the whole of the bookkeeping:

* **pending** = a live photo with no row for the stage, an older version
  (a model upgrade re-runs it), or a failure under three attempts and an
  hour old;
* **the tick** (the media worker, once a minute, ≤ 50 s) works through the
  pending, newest uploads first — so a new photo is understood within a
  minute or two and a 50k-photo backfill drains in the background;
* **progress** is a count over the same rows (``GET /api/photos/understanding``);
* **change**: ``library.sync`` drops a ``place`` row whose input (the
  location) has changed, and the next tick redoes it.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.understanding")

MAX_ATTEMPTS = 3
BATCH = 100
TICK_SECONDS = 50.0


@dataclass(frozen=True)
class Stage:
    name: str
    version: int
    label: str
    # Extra SQL over ``p`` (photo_assets) and ``m`` (file_media) for a photo
    # this stage can run on now.
    ready_sql: str
    # Works on the photos; returns how many it finished (0 = stuck, stop).
    run: Callable[[list[uuid.UUID]], Awaitable[int]]
    # Why it can't run right now (its service is down, still downloading),
    # or None. Photos waiting on it aren't failed.
    waiting: Callable[[], Awaitable[str | None]] | None = None
    # Run once a tick before the batches (e.g. a model changed: redo).
    prepare: Callable[[], Awaitable[None]] | None = None
    # Which photos it's for at all (SQL over ``p``); the rest aren't counted.
    applies_sql: str = "TRUE"


# ------------------------------------------------------------------ rows


async def record(
    db: AsyncSession, file_id: uuid.UUID, stage: Stage, state: str, *, input_key: str | None = None, error: str | None = None
) -> None:
    from app.photos.models import PhotoUnderstanding

    values = {
        "file_id": file_id, "stage": stage.name, "version": stage.version, "state": state,
        "input_key": input_key, "error": error[:500] if error else None,
        "attempts": 1 if state == "failed" else 0,
    }
    stmt = insert(PhotoUnderstanding).values(**values)
    await db.execute(
        stmt.on_conflict_do_update(
            index_elements=["file_id", "stage"],
            set_={
                "version": stmt.excluded.version, "state": stmt.excluded.state, "input_key": stmt.excluded.input_key,
                "error": stmt.excluded.error, "updated_at": text("now()"),
                "attempts": PhotoUnderstanding.attempts + 1 if state == "failed" else 0,
            },
        )
    )


def location_key(media: Any) -> str:
    """What ``place`` was worked out from: the location people see."""
    if media is None or media.location_hidden:
        return "none"
    if media.lat_override is not None and media.lon_override is not None:
        return f"{media.lat_override:.5f},{media.lon_override:.5f}"
    if media.lat is not None and media.lon is not None:
        return f"{media.lat:.5f},{media.lon:.5f}"
    return "none"


async def forget_if_changed(db: AsyncSession, file_id: uuid.UUID, media: Any) -> None:
    """A photo's location changed (an edit, a re-read): its place is redone."""
    await db.execute(
        text("DELETE FROM photo_understanding WHERE file_id = :f AND stage = 'place' AND input_key IS DISTINCT FROM :k"),
        {"f": file_id, "k": location_key(media)},
    )


async def pending(db: AsyncSession, stage: Stage, limit: int = BATCH) -> list[uuid.UUID]:
    rows = await db.execute(
        text(
            "SELECT p.file_id FROM photo_assets p "
            "JOIN files f ON f.id = p.file_id JOIN file_media m ON m.file_id = p.file_id "
            "LEFT JOIN photo_understanding u ON u.file_id = p.file_id AND u.stage = :stage "
            "WHERE f.trashed_at IS NULL AND (" + stage.applies_sql + ") AND (" + stage.ready_sql + ") AND ("
            "  u.file_id IS NULL OR u.version < :v"
            "  OR (u.state = 'failed' AND u.attempts < :max AND u.updated_at < now() - interval '1 hour')"
            ") ORDER BY f.created_at DESC, p.file_id LIMIT :n"
        ),
        {"stage": stage.name, "v": stage.version, "max": MAX_ATTEMPTS, "n": limit},
    )
    return [r[0] for r in rows]


async def _service(db: AsyncSession, stage: Stage, file_ids: list[uuid.UUID], call: Awaitable[Any]) -> Any:
    """One request to photos-ml for a chunk of photos. If it fails (the
    service fell over mid-batch, e.g. out of memory), those photos are
    recorded as failed — so they wait an hour and get three tries, rather
    than the same batch being sent again every minute, forever, each time
    taking the service down — and the stage stops for this tick."""
    try:
        return await call
    except Exception as exc:
        for fid in file_ids:
            await record(db, fid, stage, "failed", error=f"photos-ml: {exc.__class__.__name__}: {exc}")
        await db.commit()
        raise


# ------------------------------------------------------------------ stages


async def _run_place(ids: list[uuid.UUID]) -> int:
    from app.database import SessionLocal
    from app.files.models import FileMedia
    from app.photos import places
    from app.photos.models import PhotoAsset

    n = 0
    async with SessionLocal() as db:
        names: bool | None = None
        for fid in ids:
            media = await db.get(FileMedia, fid)
            asset = await db.get(PhotoAsset, fid)
            if asset is None:
                continue
            key = location_key(media)
            if key == "none":
                asset.place_id = None
                await record(db, fid, PLACE, "skipped", input_key=key)
                n += 1
                continue
            if names is None:
                # The place names are fetched the first time a photo has
                # somewhere to name; until they're in, it waits.
                names = await places.loaded(db) or await places.ensure_loaded(db)
            if not names:
                continue
            lat, lon = (float(x) for x in key.split(","))
            asset.place_id = await places.nearest(db, lat, lon)
            await record(db, fid, PLACE, "done", input_key=key)
            n += 1
        await db.commit()
    return n


async def _run_quality(ids: list[uuid.UUID]) -> int:
    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.photos.models import PhotoAsset
    from app.photos.quality import measure

    async with SessionLocal() as db:
        for fid in ids:
            asset = await db.get(PhotoAsset, fid)
            if asset is None:
                continue
            if asset.kind != "image":
                await record(db, fid, QUALITY, "skipped")
                continue
            path = next((p for p in (rendition_path(fid, "preview.webp"), rendition_path(fid, "thumb.webp")) if p.is_file()), None)
            if path is None:
                await record(db, fid, QUALITY, "failed", error="no preview")
                continue
            try:
                q = await asyncio.to_thread(measure, path)
            except Exception as exc:  # noqa: BLE001 — one bad picture never stops the rest
                await record(db, fid, QUALITY, "failed", error=f"{exc.__class__.__name__}: {exc}")
                continue
            asset.phash, asset.sharpness, asset.brightness, asset.quality = q.phash, q.sharpness, q.brightness, q.quality
            await record(db, fid, QUALITY, "done")
        await db.commit()
    return len(ids)


async def _run_embed(ids: list[uuid.UUID]) -> int:
    """SigLIP 2 vectors of the previews (a video's poster), 16 at a time."""
    from app.custom_models.embedding import vector_literal
    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.photos import ml

    async with SessionLocal() as db:
        work: list[tuple[uuid.UUID, bytes]] = []
        for fid in ids:
            path = next(
                (p for p in (rendition_path(fid, n) for n in ("preview.webp", "poster.webp", "thumb.webp")) if p.is_file()),
                None,
            )
            if path is None:
                await record(db, fid, EMBED, "failed", error="no preview")
                continue
            work.append((fid, await asyncio.to_thread(path.read_bytes)))
        for i in range(0, len(work), 16):
            chunk = work[i : i + 16]
            model, vectors = await _service(db, EMBED, [f for f, _ in chunk], ml.embed_images([data for _, data in chunk]))
            for (fid, _), vec in zip(chunk, vectors):
                if vec is None:
                    await record(db, fid, EMBED, "failed", error="the model couldn't read it")
                    continue
                await db.execute(
                    text(
                        "INSERT INTO photo_embeddings (file_id, model, embedding) VALUES (:f, :m, CAST(:v AS vector)) "
                        "ON CONFLICT (file_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, "
                        "created_at = now()"
                    ),
                    {"f": fid, "m": model, "v": vector_literal(vec)},
                )
                await record(db, fid, EMBED, "done", input_key=model[:64])
        await db.commit()
    return len(ids)


async def _embed_waiting() -> str | None:
    from app.photos import ml

    return await ml.waiting()


async def _embed_prepare() -> None:
    """Another model (an upgrade, another variant): those photos are
    embedded again."""
    from app.database import SessionLocal
    from app.photos import ml

    h = await ml.health()
    if not h or not h.get("model"):
        return
    async with SessionLocal() as db:
        await db.execute(
            text("DELETE FROM photo_understanding WHERE stage = 'embed' AND state = 'done' AND input_key IS DISTINCT FROM :m"),
            {"m": str(h["model"])[:64]},
        )
        await db.commit()


async def _run_faces(ids: list[uuid.UUID]) -> int:
    """Faces in the previews, 16 at a time. A photo's faces are replaced
    on a re-run — except any a person confirmed (PH-3), which are kept."""
    import json

    from app.custom_models.embedding import vector_literal
    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.photos import ml
    from app.photos.models import PhotoAsset

    async with SessionLocal() as db:
        work: list[tuple[uuid.UUID, uuid.UUID, bytes]] = []
        for fid in ids:
            asset = await db.get(PhotoAsset, fid)
            path = rendition_path(fid, "preview.webp")
            if asset is None:
                continue
            if not path.is_file():
                await record(db, fid, FACES, "failed", error="no preview")
                continue
            work.append((fid, asset.user_id, await asyncio.to_thread(path.read_bytes)))
        for i in range(0, len(work), 16):
            chunk = work[i : i + 16]
            model, found = await _service(db, FACES, [f for f, _, _ in chunk], ml.find_faces([data for _, _, data in chunk]))
            for (fid, owner, _), faces in zip(chunk, found):
                if faces is None:
                    await record(db, fid, FACES, "failed", error="the model couldn't read it")
                    continue
                await db.execute(
                    text("DELETE FROM photo_faces WHERE file_id = :f AND assigned_by IS DISTINCT FROM 'user'"),
                    {"f": fid},
                )
                for face in faces:
                    x, y, w, h = face["box"]
                    await db.execute(
                        text(
                            "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, landmarks, score, "
                            "size_px, model, embedding) VALUES (:f, :u, :x, :y, :w, :h, CAST(:lm AS jsonb), :s, :px, :m, "
                            "CAST(:v AS vector))"
                        ),
                        {"f": fid, "u": owner, "x": x, "y": y, "w": w, "h": h, "lm": json.dumps(face["landmarks"]),
                         "s": face["score"], "px": face["size"], "m": model[:64], "v": vector_literal(face["embedding"])},
                    )
                await record(db, fid, FACES, "done", input_key=model[:64])
        await db.commit()
    return len(ids)


async def _run_animals(ids: list[uuid.UUID]) -> int:
    """Animals in the previews, 16 at a time; a re-run replaces a photo's
    animals except any a person named (PH-3)."""
    from app.custom_models.embedding import vector_literal
    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.photos import ml
    from app.photos.models import PhotoAsset

    async with SessionLocal() as db:
        work: list[tuple[uuid.UUID, uuid.UUID, bytes]] = []
        for fid in ids:
            asset = await db.get(PhotoAsset, fid)
            path = rendition_path(fid, "preview.webp")
            if asset is None:
                continue
            if not path.is_file():
                await record(db, fid, ANIMALS, "failed", error="no preview")
                continue
            work.append((fid, asset.user_id, await asyncio.to_thread(path.read_bytes)))
        for i in range(0, len(work), 16):
            chunk = work[i : i + 16]
            model, found = await _service(db, ANIMALS, [f for f, _, _ in chunk], ml.find_animals([data for _, _, data in chunk]))
            for (fid, owner, _), animals in zip(chunk, found):
                if animals is None:
                    await record(db, fid, ANIMALS, "failed", error="the model couldn't read it")
                    continue
                await db.execute(
                    text("DELETE FROM photo_animals WHERE file_id = :f AND assigned_by IS DISTINCT FROM 'user'"),
                    {"f": fid},
                )
                for a in animals:
                    x, y, w, h = a["box"]
                    await db.execute(
                        text(
                            "INSERT INTO photo_animals (file_id, user_id, species, box_x, box_y, box_w, box_h, score, "
                            "size_px, model, embedding, embedding_dino) VALUES (:f, :u, :sp, :x, :y, :w, :h, :s, :px, :m, "
                            "CAST(:v AS vector), CAST(:d AS vector))"
                        ),
                        {"f": fid, "u": owner, "sp": a["species"][:24], "x": x, "y": y, "w": w, "h": h, "s": a["score"],
                         "px": a["size"], "m": model[:64], "v": vector_literal(a["embedding"]),
                         "d": vector_literal(a["embedding_dino"])},
                    )
                await record(db, fid, ANIMALS, "done", input_key=model[:64])
        await db.commit()
    return len(ids)


async def _animals_waiting() -> str | None:
    from app.photos import ml

    return await ml.animals_waiting()


async def _animals_prepare() -> None:
    from app.database import SessionLocal
    from app.photos import ml

    h = await ml.health() or {}
    model = (h.get("animals") or {}).get("model")
    if not model:
        return
    async with SessionLocal() as db:
        await db.execute(
            text("DELETE FROM photo_understanding WHERE stage = 'animals' AND state = 'done' AND input_key IS DISTINCT FROM :m"),
            {"m": str(model)[:64]},
        )
        await db.commit()


async def _run_text(ids: list[uuid.UUID]) -> int:
    """The words in the previews, 16 at a time."""
    import json

    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.photos import ml

    async with SessionLocal() as db:
        work: list[tuple[uuid.UUID, bytes]] = []
        for fid in ids:
            path = rendition_path(fid, "preview.webp")
            if not path.is_file():
                await record(db, fid, TEXT, "failed", error="no preview")
                continue
            work.append((fid, await asyncio.to_thread(path.read_bytes)))
        for i in range(0, len(work), 16):
            chunk = work[i : i + 16]
            model, found = await _service(db, TEXT, [f for f, _ in chunk], ml.find_text([data for _, data in chunk]))
            for (fid, _), got in zip(chunk, found):
                if got is None:
                    await record(db, fid, TEXT, "failed", error="the model couldn't read it")
                    continue
                if got.get("text"):
                    await db.execute(
                        text(
                            "INSERT INTO photo_text (file_id, text, lines, model) VALUES (:f, :t, CAST(:l AS jsonb), :m) "
                            "ON CONFLICT (file_id) DO UPDATE SET text = EXCLUDED.text, lines = EXCLUDED.lines, "
                            "model = EXCLUDED.model, created_at = now()"
                        ),
                        {"f": fid, "t": got["text"][:20000], "l": json.dumps(got.get("lines") or []), "m": model[:64]},
                    )
                else:
                    await db.execute(text("DELETE FROM photo_text WHERE file_id = :f"), {"f": fid})
                await record(db, fid, TEXT, "done", input_key=model[:64])
        await db.commit()
    return len(ids)


async def _text_waiting() -> str | None:
    from app.photos import ml

    return await ml.text_waiting()


async def _text_prepare() -> None:
    from app.database import SessionLocal
    from app.photos import ml

    h = await ml.health() or {}
    model = (h.get("text") or {}).get("model")
    if not model:
        return
    async with SessionLocal() as db:
        await db.execute(
            text("DELETE FROM photo_understanding WHERE stage = 'text' AND state = 'done' AND input_key IS DISTINCT FROM :m"),
            {"m": str(model)[:64]},
        )
        await db.commit()


async def _run_captions(ids: list[uuid.UUID]) -> int:
    """A sentence and tags for each photo, from the Photos vision model —
    four at a time; a cloud model stops at the month's limit."""
    import json

    from app.database import SessionLocal
    from app.files.derivatives import rendition_path
    from app.photos import captions

    async with SessionLocal() as db:
        vision = await captions.configured(db)
        if vision is None:
            return 0
        room = None if vision.local else max(0, vision.monthly_limit - await captions.used_this_month(db))
        if room == 0:
            return 0
        ids = ids[:room] if room is not None else ids
        slots = asyncio.Semaphore(4)

        async def one(fid: uuid.UUID) -> tuple[uuid.UUID, tuple[str, list[str]] | str]:
            path = rendition_path(fid, "preview.webp")
            if not path.is_file():
                return fid, "no preview"
            async with slots:
                try:
                    async with SessionLocal() as own:
                        return fid, await captions.describe(vision, await asyncio.to_thread(path.read_bytes), own)
                except Exception as exc:  # noqa: BLE001 — one photo's failure never stops the rest
                    logger.warning("captioning %s failed: %s", fid, exc)
                    return fid, f"{exc.__class__.__name__}: {exc}"

        for fid, got in await asyncio.gather(*(one(f) for f in ids)):
            if isinstance(got, str):
                await record(db, fid, CAPTIONS, "failed", error=got)
                continue
            caption, tags = got
            await db.execute(
                text(
                    "INSERT INTO photo_captions (file_id, caption, tags, model, cloud) VALUES (:f, :c, CAST(:t AS jsonb), :m, :cl) "
                    "ON CONFLICT (file_id) DO UPDATE SET caption = EXCLUDED.caption, tags = EXCLUDED.tags, "
                    "model = EXCLUDED.model, cloud = EXCLUDED.cloud, created_at = now()"
                ),
                {"f": fid, "c": caption, "t": json.dumps(tags), "m": vision.model_id[:255], "cl": not vision.local},
            )
            await record(db, fid, CAPTIONS, "done", input_key=vision.model_id[:64])
        await db.commit()
    return len(ids)


async def _captions_waiting() -> str | None:
    from app.database import SessionLocal
    from app.photos import captions

    async with SessionLocal() as db:
        wanted = await db.scalar(text("SELECT EXISTS (SELECT 1 FROM users WHERE " + _CAPTIONS_ON.replace("u.", "") + ")"))
        if not wanted:
            return "Describing photos is off"
        vision = await captions.configured(db)
        if vision is None:
            return "No Photos vision model is chosen (Admin → Models → Defaults)"
        if not vision.local and await captions.used_this_month(db) >= vision.monthly_limit:
            return "This month's limit of photos to describe is reached"
    return None


async def _captions_prepare() -> None:
    """Another model: photos are described again by it."""
    from app.database import SessionLocal
    from app.photos import captions

    async with SessionLocal() as db:
        vision = await captions.configured(db)
        if vision is None:
            return
        await db.execute(
            text("DELETE FROM photo_understanding WHERE stage = 'captions' AND state = 'done' AND input_key IS DISTINCT FROM :m"),
            {"m": vision.model_id[:64]},
        )
        await db.commit()


async def _faces_waiting() -> str | None:
    from app.database import SessionLocal
    from app.photos import ml

    # Nothing to do (nobody has faces on) is no reason to wake the models.
    async with SessionLocal() as db:
        wanted = await db.scalar(text("SELECT EXISTS (SELECT 1 FROM users WHERE " + _FACES_ON.replace("u.", "") + ")"))
    if not wanted:
        return "Face recognition is off"
    return await ml.faces_waiting()


async def _faces_prepare() -> None:
    """Another face model: the machine's guesses are made again."""
    from app.database import SessionLocal
    from app.photos import ml

    h = await ml.health() or {}
    model = (h.get("faces") or {}).get("model")
    if not model:
        return
    async with SessionLocal() as db:
        await db.execute(
            text("DELETE FROM photo_understanding WHERE stage = 'faces' AND state = 'done' AND input_key IS DISTINCT FROM :m"),
            {"m": str(model)[:64]},
        )
        await db.commit()


PLACE = Stage("place", 1, "Places", "TRUE", _run_place)
# Needs the preview the media worker makes (videos are marked skipped).
QUALITY = Stage("quality", 1, "Quality", "m.derivative_state IN ('ready', 'skipped', 'failed') OR p.kind <> 'image'", _run_quality)
# What's in it (WP-PH2.2): needs the photos-ml service and a preview.
EMBED = Stage(
    "embed", 1, "Search by what's in them", "m.derivative_state = 'ready'", _run_embed,
    waiting=_embed_waiting, prepare=_embed_prepare,
)
# Faces (WP-PH2.3): only for libraries whose owner turned them on.
_FACES_ON = "COALESCE((u.settings ->> 'photos_faces')::boolean, false)"
FACES = Stage(
    "faces", 1, "Faces", "m.derivative_state = 'ready'", _run_faces,
    waiting=_faces_waiting, prepare=_faces_prepare,
    applies_sql="p.kind = 'image' AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND " + _FACES_ON + ")",
)
# Animals (WP-PH2.4): pets aren't biometric data, so no opt-in.
ANIMALS = Stage(
    "animals", 1, "Pets and animals", "m.derivative_state = 'ready'", _run_animals,
    waiting=_animals_waiting, prepare=_animals_prepare, applies_sql="p.kind = 'image'",
)
# Text in photos (WP-PH2.5): signs, menus, screenshots.
TEXT = Stage(
    "text", 1, "Text in photos", "m.derivative_state = 'ready'", _run_text,
    waiting=_text_waiting, prepare=_text_prepare, applies_sql="p.kind = 'image'",
)
# Describing photos (WP-PH2.6): for people who turned it on.
_CAPTIONS_ON = "COALESCE((u.settings ->> 'photos_captions')::boolean, false)"
CAPTIONS = Stage(
    "captions", 1, "Descriptions", "m.derivative_state = 'ready'", _run_captions,
    waiting=_captions_waiting, prepare=_captions_prepare,
    applies_sql="p.kind = 'image' AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND " + _CAPTIONS_ON + ")",
)
STAGES: tuple[Stage, ...] = (PLACE, QUALITY, EMBED, FACES, ANIMALS, TEXT, CAPTIONS)


async def tick(budget: float = TICK_SECONDS) -> dict[str, int]:
    """Work through what's pending, stage by stage, for up to ``budget``
    seconds. Returns how many photos each stage took."""
    from app.database import SessionLocal

    started = time.monotonic()
    done: dict[str, int] = {}
    for stage in STAGES:
        if stage.waiting is not None and await stage.waiting():
            continue
        if stage.prepare is not None:
            await stage.prepare()
        while time.monotonic() - started < budget:
            async with SessionLocal() as db:
                ids = await pending(db, stage)
            if not ids:
                break
            try:
                n = await stage.run(ids)
            except Exception:  # noqa: BLE001 — the next tick tries again
                logger.exception("understanding %s failed on a batch", stage.name)
                break
            done[stage.name] = done.get(stage.name, 0) + n
            if n == 0:
                break  # waiting on something (the place names): next tick
    # Who's who (PH-3): new faces into people, animals to named pets.
    from app.photos import people

    left = budget - (time.monotonic() - started)
    if left > 1:
        try:
            got = await people.cluster(budget=left / 2)
            done["people"] = got["joined"] + got["new"]
            pets = await people.match_pets(budget=max(1.0, budget - (time.monotonic() - started)))
            done["pets"] = pets["assigned"]
        except Exception:  # noqa: BLE001 — the next tick tries again
            logger.exception("people/pets failed")
    # Smart albums (PH-5) catch up with whatever this tick learned.
    left = budget - (time.monotonic() - started)
    if left > 1:
        from app.photos import smart

        try:
            done["smart_albums"] = await smart.refresh_due(budget=left)
        except Exception:  # noqa: BLE001
            logger.exception("smart albums failed")
    # …and the family library (new photos of members who share them).
    left = budget - (time.monotonic() - started)
    if left > 1:
        from app.photos import family

        try:
            done["family"] = await family.refresh_due(budget=left)
        except Exception:  # noqa: BLE001
            logger.exception("family library failed")
    return done


# ------------------------------------------------------------------ progress


async def progress(db: AsyncSession, user_id: uuid.UUID | None = None) -> list[dict[str, Any]]:
    """Per stage: done / total / failed over the live library (one user's,
    or everyone's for the admin)."""
    from app.photos import places

    out = []
    for stage in STAGES:
        row = (
            await db.execute(
                text(
                    "SELECT count(*), "
                    "count(*) FILTER (WHERE u.state IN ('done', 'skipped') AND u.version >= :v), "
                    "count(*) FILTER (WHERE u.state = 'failed' AND u.attempts >= :max) "
                    "FROM photo_assets p JOIN files f ON f.id = p.file_id "
                    "LEFT JOIN photo_understanding u ON u.file_id = p.file_id AND u.stage = :stage "
                    "WHERE f.trashed_at IS NULL AND (" + stage.applies_sql + ")" + (" AND p.user_id = :u" if user_id else "")
                ),
                {"v": stage.version, "max": MAX_ATTEMPTS, "stage": stage.name, **({"u": user_id} if user_id else {})},
            )
        ).one()
        total, ok, failed = int(row[0]), int(row[1]), int(row[2])
        item: dict[str, Any] = {"stage": stage.name, "label": stage.label, "total": total, "done": ok, "failed": failed}
        if stage is PLACE and not await places.loaded(db) and ok < total:
            item["waiting"] = "Place names are being downloaded"
        elif stage.waiting is not None and ok < total:
            reason = await stage.waiting()
            if reason:
                item["waiting"] = reason
        out.append(item)
    return out


__all__ = ["ANIMALS", "CAPTIONS", "EMBED", "FACES", "PLACE", "TEXT", "QUALITY", "STAGES", "forget_if_changed", "location_key", "pending", "progress", "record", "tick"]
