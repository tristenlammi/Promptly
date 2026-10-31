"""People and pets (PH-3, Part E §E4.5): who's in the photos.

**People, from faces** — incremental clustering in Immich's manner (DBSCAN
adapted to faces arriving over time), over AuraFace vectors in pgvector:

* a face joins the person its neighbours (cosine ≥ :data:`SIMILAR`) vote
  for — each votes its similarity, double if the owner confirmed that face;
  a named person with real support beats an unnamed group, and two named
  people too close in the vote are asked about rather than guessed —
  unless someone said "not this person";
* otherwise, a clear face (≥ :data:`GOOD_SIZE` px, detector ≥
  :data:`GOOD_SCORE`) with at least :data:`MIN_FACES` − 1 similar faces
  starts a new, unnamed person — "Who is this?";
* otherwise it waits (``deferred``): a later face may pull it in; if none
  does, it's a stranger in the background and stays nobody's.

Tagging spreads: "this is Sarah" on one face brings the unnamed group it
was in along, and Sarah's look-alikes are looked at again from the faces
the owner confirmed (:func:`relook`, as pets are) — sure ones are filed,
near ones become "Is this Sarah?" in the review (:func:`suggestions`).

Only the machine's choices (``assigned_by = 'auto'``) are ever changed by
it; a person's say-so (``'user'``) stands, and "not this person" is never
suggested again. Merging, renaming, hiding and "this is me" are the owner's.

Thresholds: AuraFace put two photos of the same person at 0.71–0.76 and
different people at ≤ 0.16 (four public-domain portraits, 2026-10-14);
everyday photos (angles, light, age) run lower, so 0.5 — Immich's default
distance — is the line. Measured on the owner's own library in PH-3's
evaluation (E9).
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("promptly.photos.people")

SIMILAR = 0.5
MIN_FACES = 3
GOOD_SIZE = 40
GOOD_SCORE = 0.8
BATCH = 200
NEIGHBOURS = 20

# New faces: a neighbour the owner confirmed counts double; a named person
# with real support (≈ two auto faces, or one confirmed face, at SIMILAR)
# wins over an unnamed group half again as close; and two named people must
# be apart by NAMED_LEAD or the face is asked about, not filed.
CONFIRMED_WEIGHT = 2.0
NAMED_SUPPORT = 1.0
NAMED_BONUS = 1.5
NAMED_LEAD = 1.5

# Tagging spreads (relook): a face is the tagged person's when the mean of its
# best FACE_TOP similarities to that person's confirmed faces is ≥ FACE_SURE
# and beats every other named person by FACE_MARGIN; an unnamed group goes
# whole when ≥ GROUP_SHARE of it (and ≥ 2 faces) is. Between FACE_ASK and
# sure, the review asks ("Is this Sarah?"). Stricter than SIMILAR (0.5, a
# single neighbour) because a wrong name is worse than a question.
FACE_SURE = 0.55
FACE_MARGIN = 0.10
FACE_ASK = 0.40
FACE_TOP = 3
GROUP_SHARE = 0.6
RELOOK_EXEMPLARS = 30
RELOOK_PER_EXEMPLAR = 200
RELOOK_CANDIDATES = 2000
# Too few confirmed faces to go on (a person named by naming a whole group
# has none): their clearest TOP_UP faces stand in as examples.
MIN_CONFIRMED = 3
TOP_UP = 8
# The clustering tick looks again for each named person once after a
# restart, whenever new faces arrive in their library, and every
# RELOOK_EVERY seconds — never more than its share of the tick.
RELOOK_EVERY = 6 * 3600


async def _neighbours(db: AsyncSession, face_id: uuid.UUID, user_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None, float, bool, bool]]:
    """Faces of the same library within :data:`SIMILAR`, most alike first
    (face id, its person, similarity, the owner confirmed it, that person
    has a name) — trashed photos left out."""
    await db.execute(text("SET LOCAL hnsw.ef_search = 100"))
    await db.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
    rows = (
        await db.execute(
            text(
                "SELECT f.id, f.person_id, 1 - (f.embedding <=> me.embedding) AS sim, "
                "f.assigned_by = 'user' AS confirmed, p.name IS NOT NULL AS named "
                "FROM photo_faces f JOIN files fl ON fl.id = f.file_id LEFT JOIN photo_people p ON p.id = f.person_id, "
                "(SELECT embedding FROM photo_faces WHERE id = :id) me "
                "WHERE f.user_id = :u AND f.id <> :id AND fl.trashed_at IS NULL "
                "AND f.embedding <=> me.embedding <= :d "
                "ORDER BY f.embedding <=> me.embedding LIMIT :n"
            ),
            {"id": face_id, "u": user_id, "d": 1 - SIMILAR, "n": NEIGHBOURS},
        )
    ).all()
    return sorted(((r[0], r[1], float(r[2]), bool(r[3]), bool(r[4])) for r in rows), key=lambda r: -r[2])


def _vote(near: list[tuple[uuid.UUID, uuid.UUID | None, float, bool, bool]], rejected: set[uuid.UUID]) -> uuid.UUID | None | str:
    """Whose face this is, by its neighbours' say: each neighbour votes its
    similarity for its person (double when the owner confirmed that face);
    a named person with real support (:data:`NAMED_SUPPORT`) counts
    :data:`NAMED_BONUS` times over an unnamed group. Two named people close
    to each other in the vote → ``"ask"`` (nobody's; offered in the review).
    ``None`` when no neighbour has anyone."""
    support: dict[uuid.UUID, float] = {}
    named: set[uuid.UUID] = set()
    for _fid, pid, sim, confirmed, is_named in near:
        if pid is None or pid in rejected:
            continue
        support[pid] = support.get(pid, 0.0) + sim * (CONFIRMED_WEIGHT if confirmed else 1.0)
        if is_named:
            named.add(pid)
    if not support:
        return None
    score = {pid: v * (NAMED_BONUS if pid in named and v >= NAMED_SUPPORT else 1.0) for pid, v in support.items()}
    ranked = sorted(score, key=lambda pid: -score[pid])
    best = ranked[0]
    if best in named:
        rival = next((pid for pid in ranked[1:] if pid in named and support[pid] >= NAMED_SUPPORT), None)
        if rival is not None and score[best] < NAMED_LEAD * score[rival]:
            return "ask"
    return best


async def _place(db: AsyncSession, face: Any) -> str:
    """Decide one face: ``joined``, ``new`` (a new person) or ``deferred``."""
    fid, user_id, size_px, score = face
    near = await _neighbours(db, fid, user_id)
    rejected = set(
        (await db.execute(text("SELECT person_id FROM photo_rejections WHERE observation_id = :f"), {"f": fid})).scalars()
    )
    match = _vote(near, rejected)
    if isinstance(match, uuid.UUID):
        await db.execute(
            text("UPDATE photo_faces SET person_id = :p, assigned_by = 'auto', deferred = false, clustered_at = now() WHERE id = :f"),
            {"p": match, "f": fid},
        )
        return "joined"
    if match is None and len(near) + 1 >= MIN_FACES and size_px >= GOOD_SIZE and score >= GOOD_SCORE:
        pid = await db.scalar(
            text("INSERT INTO photo_people (user_id, kind) VALUES (:u, 'person') RETURNING id"), {"u": user_id}
        )
        await db.execute(
            text("UPDATE photo_faces SET person_id = :p, assigned_by = 'auto', deferred = false, clustered_at = now() WHERE id = :f"),
            {"p": pid, "f": fid},
        )
        return "new"
    await db.execute(text("UPDATE photo_faces SET deferred = true, clustered_at = now() WHERE id = :f"), {"f": fid})
    return "deferred"


# person → when the tick last looked again for them (in-process: after a
# restart everyone is looked at once more — bounded and harmless).
_relooked: dict[uuid.UUID, float] = {}


def _stale(user_ids: set[uuid.UUID], db_rows: list[Any]) -> None:
    """New faces in these libraries: their named people are due a relook."""
    for pid, uid in db_rows:
        if uid in user_ids:
            _relooked.pop(pid, None)


async def cluster(budget: float = 20.0) -> dict[str, int]:
    """New faces first, then a round of the deferred ones (a person found
    since may now claim them), then — with what's left, at least a quarter
    of the budget — named people due a relook (:func:`relook_due`), so
    someone named long ago still pulls in look-alike groups found since.
    Committed per batch."""
    from app.database import SessionLocal

    started = time.monotonic()
    placing = budget * 0.75
    done = {"joined": 0, "new": 0, "deferred": 0}
    fresh_users: set[uuid.UUID] = set()
    for first, query in enumerate((
        "SELECT f.id, f.user_id, f.size_px, f.score FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
        "WHERE f.clustered_at IS NULL AND f.person_id IS NULL AND fl.trashed_at IS NULL ORDER BY f.created_at LIMIT :n",
        "SELECT f.id, f.user_id, f.size_px, f.score FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
        "WHERE f.deferred AND f.person_id IS NULL AND fl.trashed_at IS NULL "
        "AND f.clustered_at < now() - interval '10 minutes' ORDER BY f.clustered_at LIMIT :n",
    )):
        while time.monotonic() - started < placing:
            async with SessionLocal() as db:
                faces = (await db.execute(text(query), {"n": BATCH})).all()
                if not faces:
                    break
                for face in faces:
                    done[await _place(db, face)] += 1
                    if first == 0:
                        fresh_users.add(face[1])
                    if time.monotonic() - started >= placing:
                        break
                await db.commit()
            if len(faces) < BATCH:
                break
    left = max(budget - (time.monotonic() - started), budget * 0.25)
    try:
        done["relooked"] = await relook_due(budget=left, fresh_users=fresh_users)
    except Exception:  # noqa: BLE001 — the next tick tries again
        logger.exception("relook of named people failed")
    return done


async def relook_due(budget: float = 5.0, fresh_users: set[uuid.UUID] | None = None) -> int:
    """Look again for named people not looked at since a restart, since new
    faces came into their library, or for :data:`RELOOK_EVERY` — longest
    waiting first, each committed on its own, until the budget's spent.
    Returns how many were looked at."""
    from app.database import SessionLocal

    started = time.monotonic()
    async with SessionLocal() as db:
        named = (
            await db.execute(
                text(
                    "SELECT p.id, p.user_id FROM photo_people p WHERE p.kind = 'person' AND p.name IS NOT NULL "
                    "AND EXISTS (SELECT 1 FROM photo_faces f WHERE f.person_id = p.id)"
                )
            )
        ).all()
    if fresh_users:
        _stale(fresh_users, named)
    now = time.monotonic()
    due = sorted(
        (pid for pid, _u in named if now - _relooked.get(pid, -1e18) >= RELOOK_EVERY),
        key=lambda pid: _relooked.get(pid, -1e18),
    )
    n = 0
    for pid in due:
        if time.monotonic() - started >= budget:
            break
        async with SessionLocal() as db:
            got = await relook(db, pid)
            await db.commit()
        _relooked[pid] = time.monotonic()
        n += 1
        if got["assigned"]:
            logger.info("relook %s: %d faces, %d groups", pid, got["assigned"], got["groups"])
    return n


# ------------------------------------------------------------------ owner actions


async def assign(db: AsyncSession, face_id: uuid.UUID, person_id: uuid.UUID, *, spread: bool = True) -> dict[str, int]:
    """"This is them": a person's say-so, never undone by the machine — and
    it spreads. The unnamed group the face was filed in (the same face
    cluster) comes along, then the person's look-alikes are looked at again
    (:func:`relook`). ``spread=False`` folds the group but leaves the relook
    to the caller (one relook after tagging many faces)."""
    old = (
        await db.execute(
            text(
                "SELECT f.person_id, p.name IS NULL AS unnamed, p.kind FROM photo_faces f "
                "LEFT JOIN photo_people p ON p.id = f.person_id WHERE f.id = :f"
            ),
            {"f": face_id},
        )
    ).first()
    await db.execute(
        text("DELETE FROM photo_rejections WHERE person_id = :p AND observation_id = :f"), {"p": person_id, "f": face_id}
    )
    await db.execute(
        text("UPDATE photo_faces SET person_id = :p, assigned_by = 'user', deferred = false, clustered_at = now() WHERE id = :f"),
        {"p": person_id, "f": face_id},
    )
    out = {"folded": 0, "assigned": 0, "groups": 0}
    if old is not None and old.person_id is not None and old.person_id != person_id and old.unnamed and old.kind == "person":
        out["folded"] = await _fold(db, old.person_id, person_id)
    if spread:
        got = await relook(db, person_id)
        out["assigned"], out["groups"] = got["assigned"], got["groups"]
    return out


async def _fold(db: AsyncSession, group: uuid.UUID, into: uuid.UUID) -> int:
    """An unnamed auto group joins a person: all of it (:func:`merge`) — or,
    if some of its faces were said not to be them, the rest. A group the
    owner vouched for (a confirmed face still in it) stays as it is."""
    if await db.scalar(
        text("SELECT EXISTS (SELECT 1 FROM photo_faces WHERE person_id = :g AND assigned_by = 'user')"), {"g": group}
    ):
        return 0
    rejected = await db.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM photo_faces f JOIN photo_rejections r ON r.observation_id = f.id "
            "WHERE f.person_id = :g AND r.person_id = :p)"
        ),
        {"g": group, "p": into},
    )
    if not rejected:
        return await merge(db, group, into)
    r = await db.execute(
        text(
            "UPDATE photo_faces f SET person_id = :p, assigned_by = 'auto', deferred = false, clustered_at = now() "
            "WHERE f.person_id = :g AND NOT EXISTS (SELECT 1 FROM photo_rejections r WHERE r.observation_id = f.id "
            "AND r.person_id = :p)"
        ),
        {"g": group, "p": into},
    )
    return r.rowcount or 0


async def _drop_if_empty(db: AsyncSession, person_ids: set[uuid.UUID]) -> None:
    """Unnamed groups that lost every face to someone named are gone."""
    if person_ids:
        await db.execute(
            text(
                "DELETE FROM photo_people p WHERE p.id = ANY(CAST(:ids AS uuid[])) AND p.name IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM photo_faces f WHERE f.person_id = p.id) "
                "AND NOT EXISTS (SELECT 1 FROM photo_animals a WHERE a.pet_id = p.id)"
            ),
            {"ids": [str(i) for i in person_ids]},
        )


def _lit(v: Any) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in v) + "]"


async def _references(db: AsyncSession, user_id: uuid.UUID, *, subject: uuid.UUID | None = None,
                      people_cap: int = 100) -> dict[uuid.UUID, Any]:
    """Each named person's face vectors to compare against: the faces the
    owner confirmed — topped up, when they've confirmed fewer than
    :data:`MIN_CONFIRMED` (someone named by naming a whole group has none),
    with their clearest faces (by size × detector score; never one said not
    to be them). ``subject`` — the person a relook spreads from — and
    everyone in the review's questions get at most :data:`TOP_UP` faces that
    way; the other named people a relook weighs them against, up to
    :data:`RELOOK_EXEMPLARS` (more of a rival only makes filing harder)."""
    import numpy as np

    rows = (
        await db.execute(
            text(
                "WITH named AS (SELECT p.id FROM photo_people p WHERE p.user_id = :u AND p.kind = 'person' "
                "AND p.name IS NOT NULL ORDER BY (SELECT count(*) FROM photo_faces f WHERE f.person_id = p.id) DESC "
                "LIMIT :cap), ranked AS (SELECT f.person_id, f.embedding::text AS e, f.assigned_by = 'user' AS confirmed, "
                "row_number() OVER (PARTITION BY f.person_id ORDER BY (f.assigned_by = 'user') DESC, "
                "f.size_px * f.score DESC, f.id) AS rn FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
                "WHERE f.person_id IN (SELECT id FROM named) AND fl.trashed_at IS NULL AND NOT EXISTS "
                "(SELECT 1 FROM photo_rejections r WHERE r.observation_id = f.id AND r.person_id = f.person_id)) "
                "SELECT person_id, e, confirmed FROM ranked WHERE rn <= :per ORDER BY person_id, rn"
            ),
            {"u": user_id, "cap": people_cap, "per": RELOOK_EXEMPLARS},
        )
    ).all()
    by: dict[uuid.UUID, list[tuple[Any, bool]]] = {}
    for pid, e, confirmed in rows:
        by.setdefault(pid, []).append((_vec(e), bool(confirmed)))
    out: dict[uuid.UUID, Any] = {}
    for pid, vs in by.items():
        mine = [v for v, c in vs if c]
        if len(mine) >= MIN_CONFIRMED:
            use = mine
        else:
            cap = TOP_UP if (subject is None or pid == subject) else RELOOK_EXEMPLARS
            use = mine + [v for v, c in vs if not c][: max(0, cap - len(mine))]
        if use:
            out[pid] = np.stack(use)
    return out


def _face_scores(v: Any, refs: dict[uuid.UUID, Any], rejected: set[uuid.UUID]) -> list[tuple[float, uuid.UUID]]:
    """Each named person's score for one face — the mean of its best
    :data:`FACE_TOP` similarities to their faces — best first."""
    import numpy as np

    out = []
    for pid, m in refs.items():
        if pid in rejected:
            continue
        sims = np.sort(m @ v)[::-1][:FACE_TOP]
        out.append((float(sims.mean()), pid))
    return sorted(out, key=lambda x: -x[0])


def _sure_for(scores: list[tuple[float, uuid.UUID]], person_id: uuid.UUID) -> bool:
    """Close enough to them, and clearly closer than to anyone else named."""
    mine = next((sc for sc, pid in scores if pid == person_id), None)
    if mine is None or mine < FACE_SURE:
        return False
    rival = max((sc for sc, pid in scores if pid != person_id), default=-1.0)
    return mine - rival >= FACE_MARGIN


async def _rejections(db: AsyncSession, face_ids: list[uuid.UUID]) -> dict[uuid.UUID, set[uuid.UUID]]:
    out: dict[uuid.UUID, set[uuid.UUID]] = {}
    if face_ids:
        for oid, pid in (
            await db.execute(
                text("SELECT observation_id, person_id FROM photo_rejections WHERE observation_id = ANY(CAST(:ids AS uuid[]))"),
                {"ids": [str(i) for i in face_ids]},
            )
        ).all():
            out.setdefault(oid, set()).add(pid)
    return out


async def relook(db: AsyncSession, person_id: uuid.UUID) -> dict[str, int]:
    """A named person's look-alikes, looked at again from the faces the
    owner confirmed (as a pet's are; their clearest, when they've confirmed
    few — :func:`_references`): faces nobody's yet, and faces in
    unnamed auto groups. A face is theirs when it's sure (:func:`_sure_for`)
    and wasn't said not to be them; an unnamed group whose faces mostly are
    (≥ :data:`GROUP_SHARE` and ≥ 2) joins whole. Confirmed faces, named
    people's faces and groups the owner vouched for are never moved; the
    unsure are left for the review to ask about (:func:`suggestions`).

    Runs in the request, bounded: ≤ :data:`RELOOK_EXEMPLARS` vector queries
    of ≤ :data:`RELOOK_PER_EXEMPLAR` faces each (≤ :data:`RELOOK_CANDIDATES`)."""
    out = {"assigned": 0, "groups": 0}
    user_id = await db.scalar(
        text("SELECT user_id FROM photo_people WHERE id = :p AND kind = 'person' AND name IS NOT NULL"), {"p": person_id}
    )
    if user_id is None:
        return out
    refs = await _references(db, user_id, subject=person_id)
    exemplars = refs.get(person_id)
    if exemplars is None:
        return out
    await db.execute(text("SET LOCAL hnsw.ef_search = 100"))
    await db.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
    # Faces nobody's, or in an unnamed group none of whose faces the owner confirmed.
    eligible = (
        "f.user_id = :u AND fl.trashed_at IS NULL AND f.assigned_by IS DISTINCT FROM 'user' "
        "AND (f.person_id IS NULL OR (p.name IS NULL AND p.kind = 'person' AND NOT EXISTS "
        "(SELECT 1 FROM photo_faces c WHERE c.person_id = f.person_id AND c.assigned_by = 'user')))"
    )
    found: dict[uuid.UUID, tuple[uuid.UUID | None, Any]] = {}
    for ex in exemplars[:RELOOK_EXEMPLARS]:
        for fid, pid, e in (
            await db.execute(
                text(
                    "SELECT f.id, f.person_id, f.embedding::text FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
                    f"LEFT JOIN photo_people p ON p.id = f.person_id WHERE {eligible} "
                    "AND f.embedding <=> CAST(:q AS vector) <= :d ORDER BY f.embedding <=> CAST(:q AS vector) LIMIT :n"
                ),
                {"u": user_id, "q": _lit(ex), "d": 1 - FACE_SURE, "n": RELOOK_PER_EXEMPLAR},
            )
        ).all():
            found.setdefault(fid, (pid, _vec(e)))
        if len(found) >= RELOOK_CANDIDATES:
            break
    if not found:
        return out
    rejections = await _rejections(db, list(found))
    sure = {
        fid for fid, (_pid, v) in found.items()
        if person_id not in rejections.get(fid, set())
        and _sure_for(_face_scores(v, refs, rejections.get(fid, set())), person_id)
    }
    # Whole groups first: every face (the clearest 300) of a group a sure face is in.
    folded: set[uuid.UUID] = set()
    for gid in {found[fid][0] for fid in sure if found[fid][0] is not None}:
        rows = (
            await db.execute(
                text(
                    "SELECT f.id, f.embedding::text FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
                    "WHERE f.person_id = :g AND fl.trashed_at IS NULL ORDER BY f.size_px * f.score DESC LIMIT 300"
                ),
                {"g": gid},
            )
        ).all()
        rej = await _rejections(db, [r[0] for r in rows])
        yes = sum(
            1 for fid, e in rows
            if person_id not in rej.get(fid, set()) and _sure_for(_face_scores(_vec(e), refs, rej.get(fid, set())), person_id)
        )
        if yes >= 2 and yes >= GROUP_SHARE * len(rows):
            out["assigned"] += await _fold(db, gid, person_id)
            out["groups"] += 1
            folded.add(gid)
    # Then single faces: nobody's, or sure ones in a group that didn't come whole.
    single = [fid for fid in sure if found[fid][0] not in folded]
    if single:
        r = await db.execute(
            text(
                "UPDATE photo_faces SET person_id = :p, assigned_by = 'auto', deferred = false, clustered_at = now() "
                "WHERE id = ANY(CAST(:ids AS uuid[])) AND assigned_by IS DISTINCT FROM 'user'"
            ),
            {"p": person_id, "ids": [str(i) for i in single]},
        )
        out["assigned"] += r.rowcount or 0
    await _drop_if_empty(db, {found[fid][0] for fid in single if found[fid][0] is not None})
    return out


async def suggestions(
    db: AsyncSession, user_id: uuid.UUID, groups: dict[uuid.UUID, list[uuid.UUID]], *, people_cap: int = 30, per_person: int = 8,
) -> tuple[dict[uuid.UUID, uuid.UUID], dict[uuid.UUID, list[uuid.UUID]]]:
    """Questions for the review, never answers. ``groups`` (an unnamed group
    → the sample faces shown for it) that look like someone named — "Is
    this Sarah?" — and faces nobody's yet that are nearest someone named
    (≥ :data:`FACE_ASK`) but weren't sure enough to be filed. Returns
    (group → person) and (person → loose faces)."""
    import numpy as np

    refs = await _references(db, user_id, people_cap=people_cap)
    if not refs:
        return {}, {}
    ids = [f for fs in groups.values() for f in fs]
    vecs: dict[uuid.UUID, Any] = {}
    if ids:
        vecs = {
            fid: _vec(e)
            for fid, e in (
                await db.execute(
                    text("SELECT id, embedding::text FROM photo_faces WHERE id = ANY(CAST(:ids AS uuid[]))"),
                    {"ids": [str(i) for i in ids]},
                )
            ).all()
        }
    rej = await _rejections(db, ids)
    group_q: dict[uuid.UUID, uuid.UUID] = {}
    for gid, fs in groups.items():
        totals: dict[uuid.UUID, list[float]] = {}
        for fid in fs:
            if fid in vecs:
                for sc, pid in _face_scores(vecs[fid], refs, rej.get(fid, set())):
                    totals.setdefault(pid, []).append(sc)
        # A person counts only if most of the samples weren't said not to be them.
        means = {pid: float(np.mean(v)) for pid, v in totals.items() if len(v) * 2 > len(fs)}
        if means:
            best = max(means, key=lambda k: means[k])
            if means[best] >= FACE_ASK:
                group_q[gid] = best
    # Faces nobody's: the nearest to each named person's centre.
    await db.execute(text("SET LOCAL hnsw.ef_search = 100"))
    await db.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
    loose: dict[uuid.UUID, list[uuid.UUID]] = {}
    seen: set[uuid.UUID] = set()
    for pid, m in refs.items():
        centre = m.mean(axis=0)
        centre = centre / max(float(np.linalg.norm(centre)), 1e-12)
        rows = (
            await db.execute(
                text(
                    "SELECT f.id, f.embedding::text FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
                    "WHERE f.user_id = :u AND f.person_id IS NULL AND fl.trashed_at IS NULL "
                    "AND f.embedding <=> CAST(:q AS vector) <= :d ORDER BY f.embedding <=> CAST(:q AS vector) LIMIT :n"
                ),
                {"u": user_id, "q": _lit(centre), "d": 1 - (FACE_ASK - 0.05), "n": per_person * 3},
            )
        ).all()
        fresh = [(fid, e) for fid, e in rows if fid not in seen]
        frej = await _rejections(db, [fid for fid, _e in fresh])
        for fid, e in fresh:
            scores = _face_scores(_vec(e), refs, frej.get(fid, set()))
            if scores and scores[0][1] == pid and scores[0][0] >= FACE_ASK and len(loose.get(pid, [])) < per_person:
                seen.add(fid)
                loose.setdefault(pid, []).append(fid)
    return group_q, loose


async def reject(db: AsyncSession, face_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """"Not them": out, and never suggested for them again (it's clustered
    afresh against everyone else)."""
    await db.execute(
        text("INSERT INTO photo_rejections (person_id, observation_id) VALUES (:p, :f) ON CONFLICT DO NOTHING"),
        {"p": person_id, "f": face_id},
    )
    await db.execute(
        text(
            "UPDATE photo_faces SET person_id = NULL, assigned_by = NULL, deferred = false, clustered_at = NULL "
            "WHERE id = :f AND person_id = :p"
        ),
        {"p": person_id, "f": face_id},
    )


async def merge(db: AsyncSession, source: uuid.UUID, into: uuid.UUID) -> int:
    """Two people (or pets) are one: everything of ``source`` moves to
    ``into`` (a name, a link to a user, kept if ``into`` has none)."""
    moved = 0
    for table, col in (("photo_faces", "person_id"), ("photo_animals", "pet_id")):
        r = await db.execute(text(f"UPDATE {table} SET {col} = :into WHERE {col} = :src"), {"into": into, "src": source})
        moved += r.rowcount or 0
    await db.execute(
        text(
            "UPDATE photo_people t SET name = COALESCE(t.name, s.name), linked_user_id = COALESCE(t.linked_user_id, s.linked_user_id), "
            "updated_at = now() FROM photo_people s WHERE t.id = :into AND s.id = :src"
        ),
        {"into": into, "src": source},
    )
    await db.execute(
        text(
            "INSERT INTO photo_rejections (person_id, observation_id) SELECT :into, observation_id FROM photo_rejections "
            "WHERE person_id = :src ON CONFLICT DO NOTHING"
        ),
        {"into": into, "src": source},
    )
    await db.execute(text("DELETE FROM photo_people WHERE id = :src"), {"src": source})
    return moved


# ------------------------------------------------------------------ relationships

# Words people use → the kind "me and my wife" resolves through (PH-4). The
# label itself is kept as they said it.
_KINDS = {
    "spouse": ("wife", "husband", "spouse", "missus", "hubby"),
    "partner": ("partner", "girlfriend", "boyfriend", "fiance", "fiancé", "fiancee", "fiancée", "other half"),
    "child": ("son", "daughter", "child", "kid", "baby", "boy", "girl", "stepson", "stepdaughter"),
    "parent": ("mum", "mom", "mother", "mama", "mummy", "mommy", "dad", "father", "papa", "daddy", "stepmum", "stepmom",
               "stepdad", "stepfather", "stepmother", "parent"),
    "sibling": ("brother", "sister", "sibling", "bro", "sis", "twin"),
    "grandparent": ("grandma", "grandpa", "grandmother", "grandfather", "nana", "nan", "granny", "gran", "grandad",
                    "granddad", "pop", "grandparent", "oma", "opa"),
    "grandchild": ("grandson", "granddaughter", "grandchild", "grandkid"),
    "relative": ("aunt", "auntie", "aunty", "uncle", "cousin", "niece", "nephew", "in-law", "in law"),
    "friend": ("friend", "mate", "best friend", "bestie", "buddy", "pal"),
    "colleague": ("colleague", "coworker", "co-worker", "boss", "workmate"),
}


def relation_kind(label: str) -> str:
    """"my wife" → spouse, "Mum" → parent, "my best mate" → friend."""
    import re

    words = re.sub(r"[^a-zà-ÿ\- ]", " ", (label or "").lower())
    words = re.sub(r"\b(my|our|the|a|an|little|big|older|younger|eldest|youngest|dear|lovely)\b", " ", words).strip()
    words = re.sub(r"\s+", " ", words)
    for kind, terms in _KINDS.items():
        for term in sorted(terms, key=len, reverse=True):
            if re.search(rf"(^|\s){re.escape(term)}s?($|\s)", words):
                return kind
    return "other"


async def set_relationship(db: AsyncSession, viewer_id: uuid.UUID, person_id: uuid.UUID, label: str | None, source: str = "settings") -> None:
    """One label per person per viewer; None removes it. "My wife" is
    only one person: a spouse label moves off anyone else who had it."""
    await db.execute(
        text("DELETE FROM photo_relationships WHERE viewer_user_id = :v AND person_id = :p"), {"v": viewer_id, "p": person_id}
    )
    label = (label or "").strip()[:60]
    if not label:
        return
    kind = relation_kind(label)
    if kind in ("spouse", "partner"):
        await db.execute(
            text("DELETE FROM photo_relationships WHERE viewer_user_id = :v AND kind = :k"), {"v": viewer_id, "k": kind}
        )
    await db.execute(
        text(
            "INSERT INTO photo_relationships (viewer_user_id, person_id, label, kind, source) VALUES (:v, :p, :l, :k, :s)"
        ),
        {"v": viewer_id, "p": person_id, "l": label, "k": kind, "s": source},
    )


async def split(db: AsyncSession, user_id: uuid.UUID, source: uuid.UUID, observation_ids: list[uuid.UUID],
                into: uuid.UUID | None, name: str | None, kind: str) -> uuid.UUID:
    """Some of one person's faces (or a pet's photos) are someone else:
    they move — as the owner's say-so — to another, or to a new one; and
    are never suggested for ``source`` again."""
    table, col = ("photo_faces", "person_id") if kind == "person" else ("photo_animals", "pet_id")
    if into is None:
        species = None
        if kind == "pet":
            species = await db.scalar(text("SELECT species FROM photo_people WHERE id = :p"), {"p": source})
        into = await db.scalar(
            text("INSERT INTO photo_people (user_id, kind, species, name) VALUES (:u, :k, :s, :n) RETURNING id"),
            {"u": user_id, "k": kind, "s": species, "n": (name or "").strip()[:120] or None},
        )
    ids = [str(i) for i in observation_ids]
    await db.execute(
        text(f"UPDATE {table} SET {col} = :into, assigned_by = 'user' WHERE {col} = :src AND id = ANY(CAST(:ids AS uuid[]))"),
        {"into": into, "src": source, "ids": ids},
    )
    await db.execute(
        text(
            "INSERT INTO photo_rejections (person_id, observation_id) SELECT :src, unnest(CAST(:ids AS uuid[])) "
            "ON CONFLICT DO NOTHING"
        ),
        {"src": source, "ids": ids},
    )
    return into


# ------------------------------------------------------------------ pets
#
# A household has few pets, so pets are matched closed-set (Part E §E4.5):
# an animal is compared only with that library's named pets *of the same
# species* (a cat is never Max the dog), through the photos the owner
# confirmed (exemplars). It's Max when it's clearly closer to Max than to
# any other pet and close enough to Max's own photos; otherwise it's asked
# ("Max or Luna?"). Every confirmation is another exemplar, so it gets
# better with use. An animal nobody has named yet waits under its species
# ("A dog in 214 photos — who is this?").
#
# Which vector: two black Portuguese water dogs told apart 68–71% of the
# time by either the SigLIP or the DINOv2 vector (2026-10-14), so each
# household's own confirmed photos decide — the one that tells *their*
# pets apart better, by leave-one-out.

PET_MARGIN = {"embedding": 0.02, "embedding_dino": 0.03}
PET_FLOOR = {"embedding": 0.65, "embedding_dino": 0.45}
PET_TOP = 3


async def assign_animal(db: AsyncSession, animal_id: uuid.UUID, pet_id: uuid.UUID) -> None:
    """"This is Max": an exemplar from now on — and every not-yet-sure
    animal of that species in the library is looked at again."""
    await db.execute(
        text("DELETE FROM photo_rejections WHERE person_id = :p AND observation_id = :a"), {"p": pet_id, "a": animal_id}
    )
    await db.execute(
        text("UPDATE photo_animals SET pet_id = :p, assigned_by = 'user', clustered_at = now() WHERE id = :a"),
        {"p": pet_id, "a": animal_id},
    )
    await _relook(db, animal_id)


async def reject_animal(db: AsyncSession, animal_id: uuid.UUID, pet_id: uuid.UUID) -> None:
    await db.execute(
        text("INSERT INTO photo_rejections (person_id, observation_id) VALUES (:p, :a) ON CONFLICT DO NOTHING"),
        {"p": pet_id, "a": animal_id},
    )
    await db.execute(
        text("UPDATE photo_animals SET pet_id = NULL, assigned_by = NULL, clustered_at = NULL WHERE id = :a AND pet_id = :p"),
        {"p": pet_id, "a": animal_id},
    )
    await _relook(db, animal_id)


async def _relook(db: AsyncSession, animal_id: uuid.UUID) -> None:
    await db.execute(
        text(
            "UPDATE photo_animals a SET clustered_at = NULL FROM photo_animals me "
            "WHERE me.id = :a AND a.user_id = me.user_id AND a.species = me.species "
            "AND a.assigned_by IS DISTINCT FROM 'user'"
        ),
        {"a": animal_id},
    )


def _vec(raw: Any) -> Any:
    import numpy as np

    if isinstance(raw, str):
        raw = [float(x) for x in raw.strip("[]").split(",")]
    v = np.asarray(raw, dtype=np.float32)
    return v / max(float(np.linalg.norm(v)), 1e-12)


def _score(sims: Any) -> float:
    """A pet's score for one animal: the mean of its best few exemplars."""
    import numpy as np

    top = np.sort(np.asarray(sims))[::-1][:PET_TOP]
    return float(top.mean()) if len(top) else -1.0


def choose_vector(exemplars: dict[uuid.UUID, dict[str, list[Any]]]) -> str:
    """The vector that tells this household's pets apart better (leave one
    out over the confirmed photos); SigLIP's when there's nothing to go on."""
    import numpy as np

    if len(exemplars) < 2 or sum(1 for e in exemplars.values() if len(e["embedding"]) >= 2) < 2:
        return "embedding"
    best, best_acc = "embedding", -1.0
    for key in ("embedding", "embedding_dino"):
        right = total = 0
        for pid, ex in exemplars.items():
            for i, v in enumerate(ex[key]):
                scores = {}
                for qid, other in exemplars.items():
                    pool = [w for j, w in enumerate(other[key]) if not (qid == pid and j == i)]
                    if pool:
                        scores[qid] = _score([float(np.dot(v, w)) for w in pool])
                if len(scores) >= 2:
                    total += 1
                    right += int(max(scores, key=scores.get) == pid)
        acc = right / total if total else 0.0
        if acc > best_acc:
            best, best_acc = key, acc
    return best


def _threshold(key: str, vectors: list[Any]) -> float:
    """How close an animal must be to a pet's photos: a little under how
    alike those photos are to each other — never under the floor."""
    import numpy as np

    floor = PET_FLOOR[key]
    if len(vectors) < 3:
        return floor + 0.05
    sims = [float(np.dot(vectors[i], vectors[j])) for i in range(len(vectors)) for j in range(i + 1, len(vectors))]
    return max(floor, float(np.mean(sims) - 1.5 * np.std(sims)))


async def match_pets(budget: float = 15.0) -> dict[str, int]:
    """Animals not yet looked at, in libraries that have named pets of their
    species: Max, Luna, or asked."""
    import numpy as np

    from app.database import SessionLocal

    started = time.monotonic()
    done = {"assigned": 0, "asked": 0}
    async with SessionLocal() as db:
        groups = (
            await db.execute(
                text(
                    "SELECT DISTINCT a.user_id, a.species FROM photo_animals a "
                    "WHERE a.clustered_at IS NULL AND EXISTS (SELECT 1 FROM photo_animals x WHERE x.user_id = a.user_id "
                    "AND x.species = a.species AND x.assigned_by = 'user' AND x.pet_id IS NOT NULL)"
                )
            )
        ).all()
    for user_id, species in groups:
        if time.monotonic() - started >= budget:
            break
        async with SessionLocal() as db:
            rows = (
                await db.execute(
                    text(
                        "SELECT pet_id, embedding::text, embedding_dino::text FROM photo_animals "
                        "WHERE user_id = :u AND species = :s AND assigned_by = 'user' AND pet_id IS NOT NULL"
                    ),
                    {"u": user_id, "s": species},
                )
            ).all()
            exemplars: dict[uuid.UUID, dict[str, list[Any]]] = {}
            for pid, e, d in rows:
                ex = exemplars.setdefault(pid, {"embedding": [], "embedding_dino": []})
                ex["embedding"].append(_vec(e))
                ex["embedding_dino"].append(_vec(d))
            key = choose_vector(exemplars)
            thresholds = {pid: _threshold(key, ex[key]) for pid, ex in exemplars.items()}
            candidates = (
                await db.execute(
                    text(
                        f"SELECT id, {key}::text FROM photo_animals WHERE user_id = :u AND species = :s "
                        "AND clustered_at IS NULL AND assigned_by IS DISTINCT FROM 'user' LIMIT 500"
                    ),
                    {"u": user_id, "s": species},
                )
            ).all()
            for aid, raw in candidates:
                v = _vec(raw)
                rejected = set(
                    (await db.execute(text("SELECT person_id FROM photo_rejections WHERE observation_id = :a"), {"a": aid})).scalars()
                )
                scores = sorted(
                    ((_score([float(np.dot(v, w)) for w in ex[key]]), pid) for pid, ex in exemplars.items() if pid not in rejected),
                    reverse=True,
                )
                best = scores[0] if scores else (-1.0, None)
                second = scores[1][0] if len(scores) > 1 else -1.0
                sure = best[1] is not None and best[0] >= thresholds[best[1]] and best[0] - second >= PET_MARGIN[key]
                if sure:
                    await db.execute(
                        text("UPDATE photo_animals SET pet_id = :p, assigned_by = 'auto', clustered_at = now() WHERE id = :a"),
                        {"p": best[1], "a": aid},
                    )
                    done["assigned"] += 1
                else:
                    # Not sure: nobody's (yet) — offered in the review as a question.
                    await db.execute(
                        text("UPDATE photo_animals SET pet_id = NULL, assigned_by = NULL, clustered_at = now() WHERE id = :a"),
                        {"a": aid},
                    )
                    done["asked"] += 1
            await db.commit()
    return done


__all__ = [
    "FACE_ASK", "FACE_MARGIN", "FACE_SURE", "GOOD_SCORE", "GOOD_SIZE", "MIN_FACES", "SIMILAR", "assign", "assign_animal",
    "choose_vector", "cluster", "match_pets", "merge", "reject", "reject_animal", "relation_kind", "relook", "relook_due",
    "set_relationship", "split", "suggestions",
]
