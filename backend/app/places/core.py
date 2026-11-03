"""Places: one list and map of where things are, across apps.

Derived on every read — nothing is stored and nothing is geocoded online:

* **Trips** — each trip's destinations, and the stays / plan stops / ideas
  that carry an address or a pin, from every trip file the viewer can open
  (their own, or shared with them).
* **Photos** — the viewer's own library, counted per GeoNames place (the
  place each photo was already given offline, PH-2).
* **Calendar** — events the viewer can see (not free/busy-only calendars,
  not ones they removed or declined) that have a location.
* **Contacts** — addresses in the viewer's own address book.

Everything is grouped by place. A pin is snapped to its nearest GeoNames
town (:func:`app.photos.places.nearest`); a free-text place ("Kyoto",
"12 High St, Leeds, UK", a contact's city + country) is matched by *name*
against the same offline gazetteer — exact town names only, biggest town
first, steered by a country when one is given. What can't be matched stays
in the list under its own text, with no pin on the map. With no gazetteer
loaded yet, pins group by themselves and text by text.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import bindparam, func, or_, select, text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User

logger = logging.getLogger("promptly.places")

SOURCES = ("trip", "photos", "event", "contact")
MAX_EVENTS = 500
MAX_PINS = 300
MAX_ITEMS_PER_PLACE = 40
# Words that name a kind of place, not a town — "Home" mustn't land in
# Home, Washington.
_STOP = frozenset({
    "home", "office", "work", "online", "zoom", "teams", "google meet", "meet", "remote", "tbd", "tba", "school",
    "church", "gym", "park", "hospital", "airport", "station", "hotel", "downtown", "city centre", "city center",
    "phone", "call", "video call", "here", "there", "my place", "your place", "the office", "virtual",
})
# A free-text town with no country must be at least this big to count
# (an event's "Paris" is Paris, France — not one of the small Parises).
_MIN_POP_ALONE = 5000
_COUNTRY_ALIASES = {
    "usa": "US", "u.s.a.": "US", "u.s.": "US", "us": "US", "united states of america": "US", "america": "US",
    "uk": "GB", "u.k.": "GB", "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
    "great britain": "GB", "britain": "GB", "uae": "AE", "south korea": "KR", "korea": "KR", "russia": "RU",
    "czech republic": "CZ", "vietnam": "VN", "the netherlands": "NL", "holland": "NL",
}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


# ------------------------------------------------------------------ the gazetteer


@dataclass
class Geo:
    id: int
    name: str
    admin1: str | None
    country: str | None
    country_code: str
    lat: float
    lon: float
    population: int = 0


class Gazetteer:
    """Offline place lookups for one request (memoised)."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.ready = False
        self.countries: dict[str, str] = {}  # lowercase name / code → code
        self._by_id: dict[int, Geo] = {}
        self._names: dict[str, list[Geo]] = {}
        self._pins: dict[tuple[float, float], int | None] = {}
        self.pin_lookups = 0

    async def start(self) -> None:
        from app.photos import places

        try:
            self.ready = await places.loaded(self.db)
        except Exception:  # noqa: BLE001 — no gazetteer table: list-only
            logger.warning("gazetteer check failed", exc_info=True)
            self.ready = False
        if not self.ready:
            return
        for code, name in (await self.db.execute(text("SELECT code, name FROM geo_countries"))).all():
            self.countries[_norm(name)] = code
            self.countries[code.lower()] = code
        for alias, code in _COUNTRY_ALIASES.items():
            self.countries.setdefault(alias, code)

    def country_code(self, s: str) -> str | None:
        return self.countries.get(_norm(s)) if s else None

    async def _describe(self, ids: set[int]) -> None:
        need = [i for i in ids if i not in self._by_id]
        if not need:
            return
        rows = (
            await self.db.execute(
                text(
                    "SELECT p.geonameid, p.name, a.name, c.name, p.country, p.lat, p.lon, p.population FROM geo_places p "
                    "LEFT JOIN geo_admin1 a ON a.code = p.country || '.' || p.admin1 "
                    "LEFT JOIN geo_countries c ON c.code = p.country WHERE p.geonameid = ANY(:ids)"
                ),
                {"ids": need},
            )
        ).all()
        for r in rows:
            self._by_id[int(r[0])] = Geo(int(r[0]), r[1], r[2], r[3], r[4], float(r[5]), float(r[6]), int(r[7] or 0))

    async def by_ids(self, ids: set[int]) -> dict[int, Geo]:
        await self._describe(ids)
        return {i: self._by_id[i] for i in ids if i in self._by_id}

    async def load_names(self, names: set[str]) -> None:
        """Fetch every town called one of ``names`` (exact, case-blind)."""
        need = sorted({n for n in names if n and n not in self._names and n not in _STOP and len(n) >= 2})[:800]
        if not self.ready or not need:
            return
        for n in need:
            self._names[n] = []
        rows = (
            await self.db.execute(
                text(
                    "SELECT p.geonameid, lower(p.name), lower(p.ascii_name), p.population FROM geo_places p "
                    "WHERE lower(p.name) = ANY(:n) OR lower(p.ascii_name) = ANY(:n)"
                ),
                {"n": need},
            )
        ).all()
        ids: dict[int, set[str]] = {}
        for gid, name, ascii_name, _pop in rows:
            ids.setdefault(int(gid), set()).update({name, ascii_name})
        await self._describe(set(ids))
        for gid, keys in ids.items():
            geo = self._by_id.get(gid)
            if geo is None:
                continue
            for k in keys:
                if k in self._names:
                    self._names[k].append(geo)

    def match(self, name: str, country: str | None = None) -> Geo | None:
        """The biggest town called ``name`` (in ``country`` when given —
        a code). Without a country, small towns don't count."""
        cands = self._names.get(_norm(name)) or []
        if country:
            cands = [g for g in cands if g.country_code == country]
        elif cands:
            cands = [g for g in cands if g.population >= _MIN_POP_ALONE]
        return max(cands, key=lambda g: g.population) if cands else None

    async def snap(self, lat: float, lon: float) -> Geo | None:
        """The nearest town to a pin (memoised per ~100 m)."""
        if not self.ready:
            return None
        key = (round(lat, 3), round(lon, 3))
        if key not in self._pins:
            if self.pin_lookups >= MAX_PINS:
                return None
            self.pin_lookups += 1
            from app.photos import places

            self._pins[key] = await places.nearest(self.db, lat, lon)
        gid = self._pins[key]
        if gid is None:
            return None
        await self._describe({gid})
        return self._by_id.get(gid)


# ------------------------------------------------------------------ free text


_HAS_DIGIT = re.compile(r"\d")


def text_candidates(location: str, gaz: Gazetteer) -> tuple[list[str], str | None]:
    """(town-name candidates, last part first; a country code if one is
    named) from a free-text place like "Café Luna, 12 High St, Leeds, UK"."""
    parts = [p.strip() for p in re.split(r"[,\n;|·–—]", location or "") if p.strip()]
    country = None
    names: list[str] = []
    for p in reversed(parts):
        code = gaz.country_code(p)
        if code and country is None:
            country = code
            continue
        # "LS1 4AB Leeds" / "Leeds 2000" → "Leeds"; a street with a number is no town.
        words = [w for w in p.split() if not _HAS_DIGIT.search(w)]
        if not words:
            continue
        cand = _norm(" ".join(words))
        if cand and cand not in _STOP:
            names.append(cand)
    return names, country


# ------------------------------------------------------------------ grouping


@dataclass
class Mention:
    source: str
    title: str
    detail: str
    url: str
    when: str | None = None
    place_text: str = ""
    lat: float | None = None
    lon: float | None = None


@dataclass
class Group:
    key: str
    name: str
    sub: str = ""
    lat: float | None = None
    lon: float | None = None
    geonameid: int | None = None
    country_code: str | None = None
    items: list[Mention] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=lambda: {s: 0 for s in SOURCES})
    photos: dict[str, Any] | None = None

    def add(self, m: Mention) -> None:
        self.counts[m.source] = self.counts.get(m.source, 0) + 1
        self.items.append(m)

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def out(self) -> dict[str, Any]:
        items = sorted(self.items, key=lambda m: (SOURCES.index(m.source), -(_ts(m.when))))
        return {
            "key": self.key, "name": self.name, "sub": self.sub, "lat": self.lat, "lon": self.lon,
            "place_id": self.geonameid, "country_code": self.country_code,
            "counts": self.counts, "total": self.total, "photos": self.photos,
            "items": [
                {"source": m.source, "title": m.title, "detail": m.detail, "url": m.url, "when": m.when, "place": m.place_text}
                for m in items[:MAX_ITEMS_PER_PLACE]
            ],
            "more": max(0, len(items) - MAX_ITEMS_PER_PLACE),
        }


def _ts(when: str | None) -> float:
    if not when:
        return 0.0
    try:
        return datetime.fromisoformat(when.replace("Z", "+00:00")[:25]).timestamp()
    except ValueError:
        try:
            return datetime.fromisoformat(when[:10]).timestamp()
        except ValueError:
            return 0.0


class Grouper:
    def __init__(self, gaz: Gazetteer) -> None:
        self.gaz = gaz
        self.groups: dict[str, Group] = {}

    def _geo_group(self, g: Geo) -> Group:
        key = f"g:{g.id}"
        grp = self.groups.get(key)
        if grp is None:
            sub = ", ".join(x for x in (g.admin1 if g.admin1 != g.name else None, g.country) if x)
            grp = self.groups[key] = Group(key, g.name, sub, g.lat, g.lon, g.id, g.country_code)
        return grp

    def _text_group(self, label: str, lat: float | None = None, lon: float | None = None) -> Group:
        if lat is not None and lon is not None:
            key = f"c:{round(lat, 2)},{round(lon, 2)}"
        else:
            key = f"t:{_norm(label)}"
        grp = self.groups.get(key)
        if grp is None:
            grp = self.groups[key] = Group(key, label.strip()[:120] or "Somewhere", "", lat, lon)
        return grp

    async def place(self, m: Mention, *, names: list[str] | None = None, country: str | None = None) -> None:
        """File ``m`` under its town: by its pin, else by its text."""
        if m.lat is not None and m.lon is not None:
            g = await self.gaz.snap(m.lat, m.lon)
            (self._geo_group(g) if g else self._text_group(m.place_text or m.title, m.lat, m.lon)).add(m)
            return
        for n in names or []:
            g = self.gaz.match(n, country)
            if g is not None:
                self._geo_group(g).add(m)
                return
        if m.place_text:
            self._text_group(m.place_text).add(m)


# ------------------------------------------------------------------ sources


async def _trip_files(db: AsyncSession, user: User) -> list[tuple[Any, Any]]:
    """Every live trip file ``user`` can open (not archives)."""
    from app.files.access import readable_predicate
    from app.files.models import UserFile
    from app.items.models import ItemDocument, ItemState
    from app.items.service import ARCHIVE_KEY

    q = (
        select(UserFile, ItemDocument)
        .join(ItemDocument, ItemDocument.file_id == UserFile.id)
        .where(
            ItemDocument.kind == "trip",
            UserFile.source_kind == "item",
            text(readable_predicate("files", param="places_reader")).bindparams(
                bindparam("places_reader", user.id, type_=PG_UUID(as_uuid=True))
            ),
            ~select(ItemState.file_id).where(ItemState.file_id == UserFile.id, ItemState.key == ARCHIVE_KEY).exists(),
        )
        .order_by(UserFile.modified_at.desc())
        .limit(50)
    )
    return [(f, d) for f, d in (await db.execute(q)).all()]


async def trip_mentions(db: AsyncSession, user: User) -> list[tuple[Mention, list[str], str | None]]:
    from app.items import service as items

    out: list[tuple[Mention, list[str], str | None]] = []
    for row, doc in await _trip_files(db, user):
        try:
            await items.upgrade(db, doc)
        except Exception:  # noqa: BLE001
            logger.warning("trip upgrade failed", exc_info=True)
            continue
        url = f"/apps/trip/{row.id}"
        for t in (doc.data or {}).get("trips", []) or []:
            trip = f"{t.get('emoji') or ''} {t.get('title') or 'Trip'}".strip()
            for d in t.get("destinations") or []:
                name = d.get("name") or ""
                m = Mention("trip", name, f"Destination · {trip}", url, d.get("start") or t.get("start"),
                            ", ".join(x for x in (name, d.get("country") or "") if x), d.get("lat"), d.get("lng"))
                out.append((m, [_norm(name)], d.get("country") or None))
            for b in t.get("bookings") or []:
                if b.get("status") == "cancelled" or b.get("type") not in ("stay", "tour", "ticket", "car"):
                    continue
                if not (b.get("address") or b.get("lat") is not None):
                    continue
                m = Mention("trip", b.get("title") or b.get("provider") or "Booking", f"{(b.get('type') or '').title()} · {trip}", url,
                            (b.get("start") or "")[:10] or None, b.get("address") or "", b.get("lat"), b.get("lng"))
                out.append((m, [], None))
            for day in t.get("days") or []:
                for p in day.get("items") or []:
                    if p.get("type") in ("note", "flight", "transport"):
                        continue
                    if not (p.get("address") or p.get("lat") is not None):
                        continue
                    m = Mention("trip", p.get("title") or p.get("place") or "Stop", f"Plan · {trip}", url, day.get("date"),
                                p.get("address") or p.get("place") or "", p.get("lat"), p.get("lng"))
                    out.append((m, [], None))
            for idea in t.get("ideas") or []:
                if idea.get("lat") is None or idea.get("lng") is None:
                    continue
                m = Mention("trip", idea.get("title") or "Idea", f"Idea · {trip}", url, None,
                            idea.get("address") or idea.get("place") or "", idea.get("lat"), idea.get("lng"))
                out.append((m, [], None))
    return out


async def photo_groups(db: AsyncSession, user: User) -> list[tuple[int, int]]:
    """(place id, photo count) for the viewer's own library."""
    from app.files.models import UserFile
    from app.photos.library import in_library
    from app.photos.models import PhotoAsset

    rows = (
        await db.execute(
            select(PhotoAsset.place_id, func.count())
            .join(UserFile, UserFile.id == PhotoAsset.file_id)
            .where(in_library(user.id), PhotoAsset.archived_at.is_(None), PhotoAsset.place_id.is_not(None))
            .group_by(PhotoAsset.place_id)
        )
    ).all()
    return [(int(pid), int(n)) for pid, n in rows]


async def event_mentions(db: AsyncSession, user: User) -> list[Mention]:
    """Events with a location the viewer can see in full."""
    from app.calendars.models import CalAttendee, CalEvent, CalMember

    my_cals = select(CalMember.calendar_id).where(CalMember.user_id == user.id, CalMember.role != "busy")
    invited = select(CalAttendee.event_id).where(
        CalAttendee.user_id == user.id, CalAttendee.hidden.is_(False), CalAttendee.status != "declined"
    )
    out_of = select(CalAttendee.event_id).where(
        CalAttendee.user_id == user.id, or_(CalAttendee.hidden.is_(True), CalAttendee.status == "declined")
    )
    rows = (
        await db.execute(
            select(CalEvent)
            .where(
                or_(CalEvent.calendar_id.in_(my_cals), CalEvent.id.in_(invited)),
                ~CalEvent.id.in_(out_of),
                func.length(func.trim(CalEvent.location)) > 0,
            )
            .order_by(CalEvent.start_at.desc())
            .limit(MAX_EVENTS)
        )
    ).scalars()
    return [
        Mention("event", ev.title or "Untitled event", "Event", f"/calendar?event={ev.id}",
                ev.start_at.isoformat() if ev.start_at else None, ev.location.strip())
        for ev in rows
    ]


async def contact_mentions(db: AsyncSession, user: User) -> list[tuple[Mention, dict]]:
    from app.items import service as items
    from app.items.kinds.contacts.logic import display_name

    out: list[tuple[Mention, dict]] = []
    for row, doc in await items.list_items(db, user, "contacts", limit=5, archives=False):
        for c in (doc.data or {}).get("contacts", []) or []:
            for a in c.get("addresses") or []:
                line = ", ".join(x for x in (a.get("street"), a.get("city"), a.get("region"), a.get("postcode"), a.get("country")) if x)
                if not line:
                    continue
                name = display_name(c) or c.get("company") or "Contact"
                label = (a.get("label") or "").strip()
                m = Mention("contact", name, f"Contact{f' · {label}' if label else ''}", f"/apps/contacts/{row.id}?c={c['id']}", None, line)
                out.append((m, a))
    return out


# ------------------------------------------------------------------ the page


async def build(db: AsyncSession, user: User) -> dict[str, Any]:
    """Every place across the viewer's apps, most things first."""
    gaz = Gazetteer(db)
    await gaz.start()
    grouper = Grouper(gaz)

    async def safe(fn, what: str):  # noqa: ANN001, ANN202
        try:
            async with db.begin_nested():
                return await fn(db, user)
        except Exception:  # noqa: BLE001 — one app failing mustn't hide the others
            logger.exception("places: reading %s failed", what)
            return []

    trips = await safe(trip_mentions, "trips")
    events = await safe(event_mentions, "events")
    contacts = await safe(contact_mentions, "contacts")
    photos = await safe(photo_groups, "photos")

    # Name lookups, all at once.
    event_cands = {id(m): text_candidates(m.place_text, gaz) for m in events}
    contact_cands: dict[int, tuple[list[str], str | None]] = {}
    for m, a in contacts:
        cc = gaz.country_code(a.get("country") or "")
        names = [_norm(a.get("city") or "")] if a.get("city") else []
        contact_cands[id(m)] = (names, cc)
    trip_cands: dict[int, tuple[list[str], str | None]] = {}
    for m, names, country in trips:
        trip_cands[id(m)] = (names, gaz.country_code(country or "") if country else None)
    wanted: set[str] = set()
    for names, _ in (*event_cands.values(), *contact_cands.values(), *trip_cands.values()):
        wanted.update(names)
    await gaz.load_names(wanted)

    for m, _n, _c in trips:
        names, cc = trip_cands[id(m)]
        await grouper.place(m, names=names, country=cc)
    for m in events:
        names, cc = event_cands[id(m)]
        await grouper.place(m, names=names, country=cc)
    for m, _a in contacts:
        names, cc = contact_cands[id(m)]
        await grouper.place(m, names=names, country=cc)

    if photos:
        geos = await gaz.by_ids({pid for pid, _ in photos})
        for pid, n in photos:
            g = geos.get(pid)
            if g is None:
                continue
            grp = grouper._geo_group(g)
            grp.counts["photos"] += n
            grp.photos = {"count": n, "url": f"/files/photos/places/{g.country_code}/{g.id}"}

    groups = sorted(grouper.groups.values(), key=lambda g: (-g.total, g.name.lower()))
    from app.photos.places import ATTRIBUTION

    return {
        "places": [g.out() for g in groups[:500]],
        "gazetteer": gaz.ready,
        "attribution": ATTRIBUTION if gaz.ready else None,
    }


__all__ = ["Gazetteer", "Grouper", "Mention", "build", "text_candidates"]
