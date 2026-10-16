"""People and pets (PH-3, Part E §E4.5): who's in the photos.

**People, from faces** — incremental clustering in Immich's manner (DBSCAN
adapted to faces arriving over time), over AuraFace vectors in pgvector:

* a face joins the person of its most similar neighbour that has one
  (cosine ≥ :data:`SIMILAR`), unless someone said "not this person";
* otherwise, a clear face (≥ :data:`GOOD_SIZE` px, detector ≥
  :data:`GOOD_SCORE`) with at least :data:`MIN_FACES` − 1 similar faces
  starts a new, unnamed person — "Who is this?";
* otherwise it waits (``deferred``): a later face may pull it in; if none
  does, it's a stranger in the background and stays nobody's.

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


async def _neighbours(db: AsyncSession, face_id: uuid.UUID, user_id: uuid.UUID) -> list[tuple[uuid.UUID, uuid.UUID | None, float]]:
    """Faces of the same library within :data:`SIMILAR`, most alike first
    (face id, its person, similarity) — trashed photos left out."""
    await db.execute(text("SET LOCAL hnsw.ef_search = 100"))
    await db.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
    rows = (
        await db.execute(
            text(
                "SELECT f.id, f.person_id, 1 - (f.embedding <=> me.embedding) AS sim "
                "FROM photo_faces f JOIN files fl ON fl.id = f.file_id, "
                "(SELECT embedding FROM photo_faces WHERE id = :id) me "
                "WHERE f.user_id = :u AND f.id <> :id AND fl.trashed_at IS NULL "
                "AND f.embedding <=> me.embedding <= :d "
                "ORDER BY f.embedding <=> me.embedding LIMIT :n"
            ),
            {"id": face_id, "u": user_id, "d": 1 - SIMILAR, "n": NEIGHBOURS},
        )
    ).all()
    return sorted(((r[0], r[1], float(r[2])) for r in rows), key=lambda r: -r[2])


async def _place(db: AsyncSession, face: Any) -> str:
    """Decide one face: ``joined``, ``new`` (a new person) or ``deferred``."""
    fid, user_id, size_px, score = face
    near = await _neighbours(db, fid, user_id)
    rejected = set(
        (await db.execute(text("SELECT person_id FROM photo_rejections WHERE observation_id = :f"), {"f": fid})).scalars()
    )
    match = next((pid for _, pid, _ in near if pid is not None and pid not in rejected), None)
    if match is not None:
        await db.execute(
            text("UPDATE photo_faces SET person_id = :p, assigned_by = 'auto', deferred = false, clustered_at = now() WHERE id = :f"),
            {"p": match, "f": fid},
        )
        return "joined"
    if len(near) + 1 >= MIN_FACES and size_px >= GOOD_SIZE and score >= GOOD_SCORE:
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


async def cluster(budget: float = 20.0) -> dict[str, int]:
    """New faces first, then a round of the deferred ones (a person found
    since may now claim them). Committed per batch."""
    from app.database import SessionLocal

    started = time.monotonic()
    done = {"joined": 0, "new": 0, "deferred": 0}
    for query in (
        "SELECT f.id, f.user_id, f.size_px, f.score FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
        "WHERE f.clustered_at IS NULL AND f.person_id IS NULL AND fl.trashed_at IS NULL ORDER BY f.created_at LIMIT :n",
        "SELECT f.id, f.user_id, f.size_px, f.score FROM photo_faces f JOIN files fl ON fl.id = f.file_id "
        "WHERE f.deferred AND f.person_id IS NULL AND fl.trashed_at IS NULL "
        "AND f.clustered_at < now() - interval '10 minutes' ORDER BY f.clustered_at LIMIT :n",
    ):
        while time.monotonic() - started < budget:
            async with SessionLocal() as db:
                faces = (await db.execute(text(query), {"n": BATCH})).all()
                if not faces:
                    break
                for face in faces:
                    done[await _place(db, face)] += 1
                    if time.monotonic() - started >= budget:
                        break
                await db.commit()
            if len(faces) < BATCH:
                break
    return done


# ------------------------------------------------------------------ owner actions


async def assign(db: AsyncSession, face_id: uuid.UUID, person_id: uuid.UUID) -> None:
    """"This is them": a person's say-so, never undone by the machine."""
    await db.execute(
        text("DELETE FROM photo_rejections WHERE person_id = :p AND observation_id = :f"), {"p": person_id, "f": face_id}
    )
    await db.execute(
        text("UPDATE photo_faces SET person_id = :p, assigned_by = 'user', deferred = false, clustered_at = now() WHERE id = :f"),
        {"p": person_id, "f": face_id},
    )


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
    "GOOD_SCORE", "GOOD_SIZE", "MIN_FACES", "SIMILAR", "assign", "assign_animal", "choose_vector", "cluster",
    "match_pets", "merge", "reject", "reject_animal", "relation_kind", "set_relationship", "split",
]
