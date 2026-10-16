"""Ask your photos — the search engine (PH-4, Part E §E4.6).

One engine for the Photos search bar and the chat tools:

1. **Understand** — a :class:`PhotoQuery`: who (``me``, names, "my wife"),
   which pets or kinds of animal, where, when, photo or video, words in the
   photo, what it looks like, favourites, order. In chat the model fills it
   in (it is the query understanding); the search bar parses the words with
   :func:`parse` — names and places it knows, dates, "videos", "quotes".
2. **Resolve** to the library's own things: people and pets by name or by
   your relationship labels, places through the gazetteer (the one of that
   name where your photos are), dates to a range. What can't be resolved is
   said ("No one called Zed in your People").
3. **Candidates** with hard filters in SQL — everyone named must be in it
   (``all of``, and "my kids" = any of them), the place within a radius, the
   dates, the kind, the words.
4. **Rank** — what it looks like (SigLIP) fused with the words in it and in
   its description (reciprocal-rank fusion), nudged by favourites and
   quality; else newest first. Near-duplicates (a burst) collapse to the
   best one.
5. **Relax** visibly when nothing matches: the dates first, then the
   place's radius, then the place, then one person — and say so.
6. **Explain** each result with chips: who, which pet, where, when, the
   words, "looks like".

The asker's own library (``in_library``) is searched, and the photos in albums
they own or were invited to (``shared``; not for smart albums) — their people
and pets filters only ever match their own photos.
"""
from __future__ import annotations

import calendar
import re
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_RADIUS_KM = 15.0
LIMIT = 60
_RRF_K = 60
_LOOKS_MIN = 0.05
_LOOKS_WINDOW = 0.05


@dataclass
class PhotoQuery:
    people: list[str] = field(default_factory=list)  # "me", names, "my wife"
    pets: list[str] = field(default_factory=list)
    species: list[str] = field(default_factory=list)
    place: str | None = None
    radius_km: float | None = None
    date_from: date | None = None
    date_to: date | None = None
    media: str | None = None  # photo | video
    text: str | None = None  # words written in it
    visual: str | None = None  # what it looks like
    favorites: bool = False
    sort: str = "relevance"  # relevance | newest | oldest | best
    limit: int = LIMIT
    # Photos in albums shared with the asker too (a smart album: never).
    shared: bool = True

    def describe(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("shared", None)
        for k in ("date_from", "date_to"):
            d[k] = d[k].isoformat() if d[k] else None
        return {k: v for k, v in d.items() if v not in (None, [], False, "relevance", LIMIT)}


@dataclass
class _Group:
    label: str
    ids: list[uuid.UUID]
    kind: str  # person | pet


@dataclass
class _Place:
    label: str
    lat: float | None = None
    lon: float | None = None
    radius_km: float = DEFAULT_RADIUS_KM
    country: str | None = None
    admin1: str | None = None


@dataclass
class Resolved:
    groups: list[_Group] = field(default_factory=list)
    species: list[str] = field(default_factory=list)
    place: _Place | None = None
    unresolved: list[str] = field(default_factory=list)


# ------------------------------------------------------------------ parse

_STOP = {
    "a", "an", "the", "of", "and", "with", "at", "in", "on", "from", "photos", "photo", "pictures", "picture", "pics",
    "pic", "show", "me", "find", "all", "every", "any", "some", "that", "where", "we", "were", "was", "is", "are",
    "there", "can", "you", "please", "my", "our", "taken", "during", "when", "near", "around", "by", "for", "to",
    "together", "both", "us", "i",
}
_MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m} | {
    m.lower(): i for i, m in enumerate(calendar.month_abbr) if m
}
_SPECIES = {"dog": "dog", "dogs": "dog", "puppy": "dog", "puppies": "dog", "cat": "cat", "cats": "cat", "kitten": "cat",
            "kittens": "cat", "bird": "bird", "birds": "bird", "horse": "horse", "horses": "horse", "rabbit": "rabbit",
            "bunny": "rabbit", "fish": "fish"}


def parse(raw: str, *, people_names: list[str], pet_names: list[str], today: date | None = None) -> PhotoQuery:
    """The search bar's words as a :class:`PhotoQuery` — the names and
    relationships it knows, dates, kinds, quoted words; the rest is what it
    looks like (places are tried on what's left, by :func:`resolve`)."""
    from app.photos.people import relation_kind

    today = today or date.today()
    q = PhotoQuery()
    s = " " + raw.strip() + " "
    # "quoted words" are words in the photo.
    quoted = re.findall(r"[\"“”']([^\"“”']{2,80})[\"“”']", s)
    if quoted:
        q.text = " ".join(quoted)
        s = re.sub(r"[\"“”'][^\"“”']{2,80}[\"“”']", " ", s)
    low = s.lower()

    def take(pattern: str) -> re.Match | None:
        nonlocal low, s
        m = re.search(pattern, low)
        if m:
            low = low[: m.start()] + " " + low[m.end():]
            s = s[: m.start()] + " " + s[m.end():]
        return m

    # Who: me; "my wife"; names (longest first).
    if take(r"\b(me|myself|i)\b(?= )") or re.search(r"\bof us\b", low):
        q.people.append("me")
    for m in list(re.finditer(r"\b(my|our)\s+([a-z\-]+(?:\s+[a-z\-]+)?)", low)):
        words = m.group(2)
        # One word first ("my wife at Noosa" is "my wife"), then two ("my best mate").
        for cut in dict.fromkeys((words.split(" ")[0], words)):
            if relation_kind(cut) != "other":
                q.people.append("my " + cut)
                take(r"\b(my|our)\s+" + re.escape(cut) + r"\b")
                break
    for name in sorted(people_names, key=len, reverse=True):
        if take(r"\b" + re.escape(name.lower()) + r"\b"):
            q.people.append(name)
    for name in sorted(pet_names, key=len, reverse=True):
        if take(r"\b" + re.escape(name.lower()) + r"\b"):
            q.pets.append(name)
    # "… and Zed", "with Zed": someone by a name it doesn't know — said so
    # (:func:`resolve`), not searched for as a look.
    for m in list(re.finditer(r"\b(?:and|with)\s+([A-Z][a-zÀ-ÿ'\-]+)\b", s)):
        if m.group(1).lower() not in _STOP and take(r"\b(?:and|with)\s+" + re.escape(m.group(1).lower()) + r"\b"):
            q.people.append(m.group(1))
    # When.
    if take(r"\blast year\b"):
        q.date_from, q.date_to = date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)
    elif take(r"\bthis year\b"):
        q.date_from, q.date_to = date(today.year, 1, 1), today
    elif take(r"\blast month\b"):
        first = today.replace(day=1) - timedelta(days=1)
        q.date_from, q.date_to = first.replace(day=1), first
    m = take(r"\b(christmas|xmas)\s*(\d{4})?\b")
    if m:
        y = int(m.group(2)) if m.group(2) else (today.year if today >= date(today.year, 12, 20) else today.year - 1)
        q.date_from, q.date_to = date(y, 12, 20), date(y, 12, 31)
    m = take(r"\b(" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + r")\.?\s+(\d{4})\b")
    if m:
        mo, y = _MONTHS[m.group(1)], int(m.group(2))
        q.date_from, q.date_to = date(y, mo, 1), date(y, mo, calendar.monthrange(y, mo)[1])
    m = take(r"\b(19[5-9]\d|20\d\d)\b")
    if m and q.date_from is None:
        y = int(m.group(1))
        q.date_from, q.date_to = date(y, 1, 1), date(y, 12, 31)
    # What kind.
    if take(r"\bvideos?\b|\bclips?\b"):
        q.media = "video"
    if take(r"\bfavou?rites?\b|\bstarred\b"):
        q.favorites = True
    for word, sp in _SPECIES.items():
        if take(r"\b" + word + r"\b") and sp not in q.species:
            q.species.append(sp)
    if take(r"\b(best|nicest|sharpest)\b"):
        q.sort = "best"
    elif take(r"\b(first|earliest|oldest)\b"):
        q.sort = "oldest"
    elif take(r"\b(latest|newest|most recent|recent)\b"):
        q.sort = "newest"
    # Where: "in/at/near X" (capitalised in the original, or anything).
    m = re.search(r"\b(?:in|at|near|around)\s+([A-Za-zÀ-ÿ][\wÀ-ÿ'\-]*(?:\s+[A-Z][\wÀ-ÿ'\-]*){0,3})", s)
    if m:
        q.place = m.group(1).strip()
        if re.search(r"\b(near|around)\s+" + re.escape(m.group(1)), s):
            q.radius_km = 30.0
        low = low.replace(m.group(0).lower(), " ")
    rest = [w for w in re.findall(r"[\wÀ-ÿ'\-]+", low) if w not in _STOP]
    if rest:
        q.visual = " ".join(rest)
    return q


# ------------------------------------------------------------------ resolve


async def _people(db: AsyncSession, user_id: uuid.UUID, kind: str) -> list[tuple[uuid.UUID, str]]:
    return [(r[0], r[1]) for r in (
        await db.execute(
            text("SELECT id, name FROM photo_people WHERE user_id = :u AND kind = :k AND name IS NOT NULL"),
            {"u": user_id, "k": kind},
        )
    ).all()]


async def resolve(db: AsyncSession, user: Any, q: PhotoQuery) -> Resolved:
    from app.photos.people import relation_kind

    out = Resolved(species=list(q.species))
    for ref in q.people:
        r = ref.strip()
        low = r.lower()
        if low.startswith("id:"):
            # A saved rule names them by id (a rename doesn't break it).
            pid = _uuid(r[3:])
            name = await db.scalar(
                text("SELECT COALESCE(name, '') FROM photo_people WHERE id = :p AND user_id = :u AND kind = 'person'"), {"p": pid, "u": user.id}
            ) if pid else None
            if name is None:
                out.unresolved.append("someone no longer in your People")
            else:
                out.groups.append(_Group(name or "them", [pid], "person"))
            continue
        if low in ("me", "myself", "i", "you"):
            ids = list((await db.execute(
                text("SELECT id FROM photo_people WHERE user_id = :u AND linked_user_id = :u"), {"u": user.id}
            )).scalars())
            if ids:
                out.groups.append(_Group("you", ids, "person"))
            else:
                out.unresolved.append("you — mark yourself in People (This is me)")
            continue
        kind = relation_kind(r)
        by_label = list((await db.execute(
            text("SELECT person_id FROM photo_relationships WHERE viewer_user_id = :u AND (lower(label) = :l OR kind = :k)"),
            {"u": user.id, "l": low, "k": kind if kind != "other" else "__none__"},
        )).scalars())
        if by_label:
            out.groups.append(_Group(r, by_label, "person"))
            continue
        by_name = list((await db.execute(
            text("SELECT id FROM photo_people WHERE user_id = :u AND kind = 'person' AND lower(name) = lower(:n)"),
            {"u": user.id, "n": r},
        )).scalars())
        if not by_name:  # "Sarah" for "Sarah Smith"
            by_name = list((await db.execute(
                text("SELECT id FROM photo_people WHERE user_id = :u AND kind = 'person' AND lower(name) LIKE lower(:n) || ' %'"),
                {"u": user.id, "n": r},
            )).scalars())
        if by_name:
            out.groups.append(_Group(r, by_name, "person"))
        elif kind != "other":
            out.unresolved.append(f"{r} — say who that is on their page in People")
        else:
            out.unresolved.append(f"{r} — no one by that name in your People")
    for name in q.pets:
        if name.lower().startswith("id:"):
            pid = _uuid(name[3:])
            pet = await db.scalar(
                text("SELECT COALESCE(name, '') FROM photo_people WHERE id = :p AND user_id = :u AND kind = 'pet'"), {"p": pid, "u": user.id}
            ) if pid else None
            if pet is None:
                out.unresolved.append("a pet no longer in your Pets")
            else:
                out.groups.append(_Group(pet or "your pet", [pid], "pet"))
            continue
        ids = list((await db.execute(
            text("SELECT id FROM photo_people WHERE user_id = :u AND kind = 'pet' AND lower(name) = lower(:n)"),
            {"u": user.id, "n": name.strip()},
        )).scalars())
        if ids:
            out.groups.append(_Group(name.strip(), ids, "pet"))
        else:
            out.unresolved.append(f"{name} — no pet by that name in your Pets")
    if q.place:
        out.place = await _resolve_place(db, user.id, q.place, q.radius_km or DEFAULT_RADIUS_KM)
        if out.place is None:
            out.unresolved.append(f"{q.place} — not a place I know")
    return out


def _uuid(raw: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(raw.strip())
    except ValueError:
        return None


async def _resolve_place(db: AsyncSession, user_id: uuid.UUID, name: str, radius: float) -> _Place | None:
    n = name.strip()
    country = (await db.execute(text("SELECT code, name FROM geo_countries WHERE lower(name) = lower(:n)"), {"n": n})).first()
    if country:
        return _Place(country.name, country=country.code)
    admin = (await db.execute(text("SELECT code, name FROM geo_admin1 WHERE lower(name) = lower(:n) LIMIT 1"), {"n": n})).first()
    # A town of that name — the one your photos are near, else the biggest.
    rows = (
        await db.execute(
            text(
                "SELECT * FROM (SELECT g.geonameid, g.name, g.lat, g.lon, g.population, c.name AS country, "
                "(lower(g.name) = lower(:n) OR lower(g.ascii_name) = lower(:n)) AS exact, "
                "(SELECT count(*) FROM photo_assets p JOIN geo_places pg ON pg.geonameid = p.place_id "
                " WHERE p.user_id = :u AND abs(pg.lat - g.lat) < 0.3 AND abs(pg.lon - g.lon) < 0.3) AS mine "
                "FROM geo_places g LEFT JOIN geo_countries c ON c.code = g.country "
                # The exact name, else one it starts ("Noosa" → Noosa Heads) —
                # the one your photos are near first.
                "WHERE lower(g.name) = lower(:n) OR lower(g.ascii_name) = lower(:n) "
                "OR lower(g.ascii_name) LIKE lower(:n) || ' %' OR lower(g.name) LIKE lower(:n) || ' %') x "
                "ORDER BY (exact AND mine > 0) DESC, mine DESC, exact DESC, population DESC LIMIT 1"
            ),
            {"u": user_id, "n": n},
        )
    ).first()
    if rows and (rows.mine or not admin):
        return _Place(f"{rows.name}{', ' + rows.country if rows.country else ''}", float(rows.lat), float(rows.lon), radius)
    if admin:
        cc, a1 = admin.code.split(".", 1)
        return _Place(admin.name, country=cc, admin1=a1)
    return None


# ------------------------------------------------------------------ candidates and ranking


def _filters(user_id: uuid.UUID, q: PhotoQuery, r: Resolved, params: dict[str, Any]) -> list[str]:
    from app.photos.library import SHARED_SQL

    # Theirs, and what's in albums shared with them — the people, pets and
    # "me" filters below only ever match their own photos' faces.
    mine = f"(p.user_id = :u OR p.file_id IN ({SHARED_SQL}))" if q.shared else "p.user_id = :u"
    where = [mine, "p.archived_at IS NULL", "NOT p.live_hidden"]
    params["u"] = user_id
    for i, g in enumerate(r.groups):
        table, col = ("photo_faces", "person_id") if g.kind == "person" else ("photo_animals", "pet_id")
        params[f"g{i}"] = [str(x) for x in g.ids]
        where.append(f"EXISTS (SELECT 1 FROM {table} o WHERE o.file_id = p.file_id AND o.{col} = ANY(CAST(:g{i} AS uuid[])))")
    if r.species:
        params["sp"] = r.species
        where.append("EXISTS (SELECT 1 FROM photo_animals o WHERE o.file_id = p.file_id AND o.species = ANY(CAST(:sp AS text[])))")
    pl = r.place
    if pl is not None:
        if pl.country:
            params["cc"] = pl.country
            clause = "gp.country = :cc"
            if pl.admin1:
                params["a1"] = pl.admin1
                clause += " AND gp.admin1 = :a1"
            where.append(f"EXISTS (SELECT 1 FROM geo_places gp WHERE gp.geonameid = p.place_id AND {clause})")
        else:
            dlat = pl.radius_km / 111.0
            dlon = dlat / max(0.05, abs(__import__("math").cos(__import__("math").radians(pl.lat))))
            params.update(plat0=pl.lat - dlat, plat1=pl.lat + dlat, plon0=pl.lon - dlon, plon1=pl.lon + dlon)
            where.append(
                "EXISTS (SELECT 1 FROM file_media fm WHERE fm.file_id = p.file_id AND NOT fm.location_hidden "
                "AND COALESCE(fm.lat_override, fm.lat) BETWEEN :plat0 AND :plat1 "
                "AND COALESCE(fm.lon_override, fm.lon) BETWEEN :plon0 AND :plon1)"
            )
    if q.date_from:
        params["d0"] = datetime.combine(q.date_from, datetime.min.time())
        where.append("p.taken_local >= :d0")
    if q.date_to:
        params["d1"] = datetime.combine(q.date_to + timedelta(days=1), datetime.min.time())
        where.append("p.taken_local < :d1")
    if q.media in ("photo", "video"):
        params["kind"] = "image" if q.media == "photo" else "video"
        where.append("p.kind = :kind")
    if q.favorites:
        where.append("f.starred_at IS NOT NULL")
    if q.text:
        params["words"] = q.text
        where.append(
            "(EXISTS (SELECT 1 FROM photo_text t WHERE t.file_id = p.file_id AND t.tsv @@ plainto_tsquery('simple', :words)) "
            "OR EXISTS (SELECT 1 FROM photo_captions c WHERE c.file_id = p.file_id AND c.tsv @@ plainto_tsquery('english', :words)))"
        )
    return where


async def _ranked(db: AsyncSession, user: Any, q: PhotoQuery, r: Resolved) -> list[dict[str, Any]]:
    """Candidates, best first: [{file_id, looks, words, score}]."""
    params: dict[str, Any] = {}
    where = _filters(user.id, q, r, params)
    base = (
        "FROM photo_assets p JOIN files f ON f.id = p.file_id AND f.trashed_at IS NULL "
        "WHERE " + " AND ".join(where) + " "
    )
    hits: dict[uuid.UUID, dict[str, Any]] = {}
    # What it looks like.
    looks_rank: dict[uuid.UUID, int] = {}
    if q.visual:
        from app.custom_models.embedding import vector_literal
        from app.photos import ml

        if not await ml.waiting():
            model, vectors = await ml.embed_texts([f"This is a photo of {q.visual.strip()}."])
            await db.execute(text("SET LOCAL hnsw.ef_search = 200"))
            await db.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
            rows = (
                await db.execute(
                    text(
                        "SELECT p.file_id, 1 - (e.embedding <=> CAST(:v AS vector)) AS s "
                        + base.replace("FROM photo_assets p", "FROM photo_embeddings e JOIN photo_assets p ON p.file_id = e.file_id", 1)
                        + "AND e.model = :m ORDER BY e.embedding <=> CAST(:v AS vector) LIMIT 400"
                    ),
                    {**params, "v": vector_literal(vectors[0]), "m": model},
                )
            ).all()
            rows = sorted(rows, key=lambda x: -float(x[1]))
            best = float(rows[0][1]) if rows else 0.0
            # Alone, it must really look like it; with other filters, rank.
            alone = not (r.groups or r.species or r.place or q.date_from or q.text or q.media or q.favorites)
            for i, (fid, s) in enumerate(rows):
                s = float(s)
                if alone and s < max(_LOOKS_MIN, best - _LOOKS_WINDOW):
                    continue
                hits.setdefault(fid, {"file_id": fid})["looks"] = round(s, 4)
                looks_rank[fid] = i
    # Words in it or in its description (the visual words too).
    words_rank: dict[uuid.UUID, int] = {}
    terms = " ".join(x for x in (q.text, q.visual) if x)
    if terms:
        rows = (
            await db.execute(
                text(
                    "SELECT p.file_id, max(r), bool_or(written) FROM ("
                    " SELECT t.file_id, ts_rank(t.tsv, plainto_tsquery('simple', :terms)) + 1 AS r, true AS written FROM photo_text t"
                    "  WHERE t.tsv @@ plainto_tsquery('simple', :terms)"
                    " UNION ALL SELECT c.file_id, ts_rank(c.tsv, plainto_tsquery('english', :terms)), false FROM photo_captions c"
                    "  WHERE c.tsv @@ plainto_tsquery('english', :terms)"
                    ") w JOIN photo_assets p ON p.file_id = w.file_id JOIN files f ON f.id = p.file_id AND f.trashed_at IS NULL "
                    "WHERE " + " AND ".join(where) + " GROUP BY p.file_id ORDER BY 2 DESC LIMIT 400"
                ),
                {**params, "terms": terms},
            )
        ).all()
        for i, (fid, _r, written) in enumerate(rows):
            # Written in it (a sign), or said of it (its description).
            hits.setdefault(fid, {"file_id": fid})["words"] = "text" if written else "description"
            words_rank[fid] = i
    if not (q.visual or terms):
        order = {"oldest": "p.taken_local ASC", "best": "p.quality DESC NULLS LAST, p.taken_local DESC"}.get(q.sort, "p.taken_local DESC")
        rows = (
            await db.execute(text("SELECT p.file_id " + base + f"ORDER BY {order} LIMIT 1000"), params)
        ).scalars().all()
        return [{"file_id": fid, "score": 1.0 - i / 2000} for i, fid in enumerate(rows)]
    # Fuse.
    extra = (
        await db.execute(
            text(
                "SELECT p.file_id, p.quality, f.starred_at IS NOT NULL FROM photo_assets p JOIN files f ON f.id = p.file_id "
                "WHERE p.file_id = ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": [str(x) for x in hits]},
        )
    ).all() if hits else []
    prior = {fid: (quality or 0.0) * 0.002 + (0.003 if fav else 0.0) for fid, quality, fav in extra}
    for fid, h in hits.items():
        s = 0.0
        if fid in looks_rank:
            s += 1.0 / (_RRF_K + looks_rank[fid])
        if fid in words_rank:
            s += 1.5 / (_RRF_K + words_rank[fid])  # its own words are strong evidence
        h["score"] = s + prior.get(fid, 0.0)
    ranked = sorted(hits.values(), key=lambda h: -h["score"])
    if q.sort in ("newest", "oldest"):
        when = dict((await db.execute(
            text("SELECT file_id, taken_local FROM photo_assets WHERE file_id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": [str(h["file_id"]) for h in ranked]},
        )).all()) if ranked else {}
        ranked.sort(key=lambda h: when.get(h["file_id"]) or datetime.min, reverse=q.sort == "newest")
    return ranked


async def _collapse(db: AsyncSession, ranked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A burst (the same scene within ten minutes) is one result: its best."""
    from app.photos.quality import hamming

    if len(ranked) < 2:
        return ranked
    info = {
        r[0]: (r[1], r[2])
        for r in (
            await db.execute(
                text("SELECT file_id, phash, taken_at FROM photo_assets WHERE file_id = ANY(CAST(:ids AS uuid[]))"),
                {"ids": [str(h["file_id"]) for h in ranked[:400]]},
            )
        ).all()
    }
    kept: list[dict[str, Any]] = []
    for h in ranked:
        ph, when = info.get(h["file_id"], (None, None))
        twin = None
        if ph is not None and when is not None:
            for k in kept:
                kph, kwhen = info.get(k["file_id"], (None, None))
                if kph is not None and kwhen is not None and abs((kwhen - when).total_seconds()) <= 600 and hamming(kph, ph) <= 6:
                    twin = k
                    break
        if twin is not None:
            twin["similar"] = twin.get("similar", 0) + 1
            continue
        kept.append(h)
    return kept


async def search(db: AsyncSession, user: Any, q: PhotoQuery) -> dict[str, Any]:
    """The engine end to end: items (best first) with chips, how the
    question was understood, what was relaxed and what wasn't found."""
    r = await resolve(db, user, q)
    relaxed: list[str] = []
    ranked = await _collapse(db, await _ranked(db, user, q, r))
    # The relaxation ladder: when nothing matches, loosen one thing at a time.
    steps: list[tuple[str, Any]] = []
    if q.date_from or q.date_to:
        steps.append(("any date", lambda q, r: (replace(q, date_from=None, date_to=None), r)))
    if r.place is not None and r.place.lat is not None:
        wide = replace(r.place, radius_km=r.place.radius_km * 5)
        steps.append((f"within {int(wide.radius_km)} km of {r.place.label}", lambda q, r, wide=wide: (q, replace(r, place=wide))))
    if r.place is not None:
        steps.append((f"anywhere, not just {r.place.label}", lambda q, r: (q, replace(r, place=None))))
    if len(r.groups) > 1:
        last = r.groups[-1]
        steps.append((f"without {last.label}", lambda q, r, last=last: (q, replace(r, groups=[g for g in r.groups if g is not last]))))
    cq, cr = q, r
    for label, step in steps:
        if ranked:
            break
        cq, cr = step(cq, cr)
        relaxed.append(label)
        ranked = await _collapse(db, await _ranked(db, user, cq, cr))
    ranked = ranked[: q.limit]
    items = await _items(db, user, ranked, cq, cr)
    return {
        "items": items,
        "understood": {
            **q.describe(),
            "people": [g.label for g in r.groups if g.kind == "person"],
            "pets": [g.label for g in r.groups if g.kind == "pet"],
            "place": r.place.label if r.place else None,
        },
        "relaxed": relaxed,
        "unresolved": r.unresolved,
    }


async def _items(db: AsyncSession, user: Any, ranked: list[dict[str, Any]], q: PhotoQuery, r: Resolved) -> list[dict[str, Any]]:
    from sqlalchemy import select

    from app.files.models import FileMedia, UserFile
    from app.photos import places
    from sqlalchemy import or_

    from app.photos.library import in_library, shared_with
    from app.photos.models import PhotoAsset
    from app.photos.router import _item

    if not ranked:
        return []
    ids = [h["file_id"] for h in ranked]
    rows = {
        a.file_id: (a, f, m)
        for a, f, m in (
            await db.execute(
                select(PhotoAsset, UserFile, FileMedia)
                .join(UserFile, UserFile.id == PhotoAsset.file_id)
                .outerjoin(FileMedia, FileMedia.file_id == PhotoAsset.file_id)
                .where(or_(in_library(user.id), PhotoAsset.file_id.in_(shared_with(user.id))) if q.shared else in_library(user.id),
                       PhotoAsset.file_id.in_(ids))
            )
        ).all()
    }
    # Someone else's photo: from which shared album.
    theirs = [str(a.file_id) for a, _f, _m in rows.values() if a.user_id != user.id]
    via: dict[uuid.UUID, str] = {}
    if theirs:
        for fid, title, owner in (
            await db.execute(
                text(
                    "SELECT DISTINCT ON (ai.file_id) ai.file_id, al.title, u.username FROM album_items ai "
                    "JOIN albums al ON al.id = ai.album_id JOIN users u ON u.id = al.owner_id "
                    "WHERE ai.file_id = ANY(CAST(:ids AS uuid[])) AND (al.owner_id = :u OR EXISTS "
                    "(SELECT 1 FROM album_members am WHERE am.album_id = al.id AND am.user_id = :u)) ORDER BY ai.file_id, al.title"
                ),
                {"ids": theirs, "u": user.id},
            )
        ).all():
            via[fid] = f"{owner}'s “{title}”" if owner != user.username else f"“{title}”"
    who = {}
    for fid, name in (
        await db.execute(
            text(
                "SELECT o.file_id, pp.name FROM photo_faces o JOIN photo_people pp ON pp.id = o.person_id "
                "WHERE o.file_id = ANY(CAST(:ids AS uuid[])) AND pp.name IS NOT NULL AND NOT pp.hidden "
                "UNION SELECT o.file_id, pp.name FROM photo_animals o JOIN photo_people pp ON pp.id = o.pet_id "
                "WHERE o.file_id = ANY(CAST(:ids AS uuid[])) AND pp.name IS NOT NULL"
            ),
            {"ids": [str(x) for x in ids]},
        )
    ).all():
        who.setdefault(fid, []).append(name)
    place_cache: dict[int, str | None] = {}
    out = []
    for h in ranked:
        row = rows.get(h["file_id"])
        if row is None:
            continue
        a, f, m = row
        chips = []
        for g in r.groups:
            chips.append({"kind": g.kind, "label": g.label})
        for name in sorted(set(who.get(a.file_id, []))):
            if not any(c["label"].lower() == name.lower() for c in chips):
                chips.append({"kind": "who", "label": name})
        if a.place_id is not None:
            if a.place_id not in place_cache:
                p = await places.describe(db, a.place_id)
                place_cache[a.place_id] = p.label if p else None
            if place_cache[a.place_id]:
                chips.append({"kind": "place", "label": place_cache[a.place_id]})
        chips.append({"kind": "when", "label": f"{a.taken_local.day} {a.taken_local:%b %Y}"})
        if a.file_id in via:
            chips.append({"kind": "album", "label": via[a.file_id]})
        if h.get("words"):
            chips.append({"kind": "words", "label": q.text or q.visual or ""})
        if "looks" in h:
            chips.append({"kind": "looks", "label": q.visual or ""})
        out.append({
            **_item(a, f, m, user), "score": round(h.get("score", 0.0), 5), "chips": chips,
            "similar": h.get("similar", 0),
            "matched": h.get("words") or ("looks" if "looks" in h else "filters"),
        })
    return out


# ------------------------------------------------------------------ saved questions


def query_from(args: dict[str, Any]) -> PhotoQuery:
    """A question in the chat tool's / smart album's shape (``looks_like``,
    ``near`` …) as a :class:`PhotoQuery`."""
    def day(v: Any) -> date | None:
        try:
            return date.fromisoformat(str(v)[:10]) if v else None
        except ValueError:
            return None

    return PhotoQuery(
        people=[str(x) for x in args.get("people") or [] if str(x).strip()],
        pets=[str(x) for x in args.get("pets") or [] if str(x).strip()],
        species=[str(x).lower() for x in args.get("species") or [] if str(x).strip()],
        place=(args.get("place") or None),
        radius_km=30.0 if args.get("near") else None,
        date_from=day(args.get("date_from")), date_to=day(args.get("date_to")),
        media=args.get("media") if args.get("media") in ("photo", "video") else None,
        text=(args.get("text") or None), visual=(args.get("looks_like") or None),
        favorites=bool(args.get("favorites")), sort=args.get("sort") or "relevance",
    )


def args_of(q: PhotoQuery) -> dict[str, Any]:
    return {
        "people": q.people, "pets": q.pets, "species": q.species, "place": q.place, "near": bool(q.radius_km),
        "date_from": q.date_from.isoformat() if q.date_from else None,
        "date_to": q.date_to.isoformat() if q.date_to else None,
        "media": q.media, "text": q.text, "looks_like": q.visual, "favorites": q.favorites, "sort": q.sort,
    }


# How alike a photo must be to count for a saved question's look ("at the
# beach"): matches measured 0.09–0.14, unrelated 0.01–0.05 (2026-10-14).
LOOKS_RULE_MIN = 0.07


async def matching(db: AsyncSession, user: Any, q: PhotoQuery, *, cap: int = 20000) -> list[uuid.UUID] | None:
    """Every photo of the library that answers ``q`` — no ranking, no
    relaxing, nothing guessed (an unresolved name matches nothing). None
    when it can't be told now (the look needs the photos service)."""
    q = replace(q, shared=False)  # a smart album holds the owner's own photos
    from sqlalchemy import select

    from app.files.models import UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    r = await resolve(db, user, q)
    if r.unresolved:
        return []
    params: dict[str, Any] = {}
    where = _filters(user.id, q, r, params)
    if q.visual:
        from app.custom_models.embedding import vector_literal
        from app.photos import ml

        if await ml.waiting():
            return None
        model, vectors = await ml.embed_texts([f"This is a photo of {q.visual.strip()}."])
        sql = (
            "SELECT p.file_id FROM photo_embeddings e JOIN photo_assets p ON p.file_id = e.file_id "
            "JOIN files f ON f.id = p.file_id AND f.trashed_at IS NULL WHERE " + " AND ".join(where)
            + " AND e.model = :m AND 1 - (e.embedding <=> CAST(:v AS vector)) >= :min LIMIT :cap"
        )
        params.update(m=model, v=vector_literal(vectors[0]), min=LOOKS_RULE_MIN)
    else:
        sql = (
            "SELECT p.file_id FROM photo_assets p JOIN files f ON f.id = p.file_id AND f.trashed_at IS NULL WHERE "
            + " AND ".join(where) + " LIMIT :cap"
        )
    params["cap"] = cap
    ids = list((await db.execute(text(sql), params)).scalars())
    keep: list[uuid.UUID] = []
    for i in range(0, len(ids), 2000):
        chunk = ids[i : i + 2000]
        keep += list((await db.execute(
            select(PhotoAsset.file_id).join(UserFile, UserFile.id == PhotoAsset.file_id)
            .where(in_library(user.id), PhotoAsset.file_id.in_(chunk))
        )).scalars())
    return keep


def summary(q: PhotoQuery, names: dict[str, str] | None = None) -> str:
    """A saved question in words: "Sarah · Max · at the beach · 2022"."""
    names = names or {}
    bits = [names.get(p, p) for p in q.people] + [names.get(p, p) for p in q.pets] + [f"{s}s" for s in q.species]
    if q.place:
        bits.append(("near " if q.radius_km else "in ") + q.place)
    if q.date_from or q.date_to:
        bits.append(f"{q.date_from or '…'} – {q.date_to or '…'}")
    if q.media == "video":
        bits.append("videos")
    if q.text:
        bits.append(f"“{q.text}” in it")
    if q.visual:
        bits.append(q.visual)
    if q.favorites:
        bits.append("favourites")
    return " · ".join(bits) or "everything"


__all__ = ["LOOKS_RULE_MIN", "PhotoQuery", "Resolved", "args_of", "matching", "parse", "query_from", "resolve", "search", "summary"]
