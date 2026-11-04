"""The shape of the ``.trip`` file — all of a person's trips.

One file per person (the Item Store's rule): ``trips`` holds every trip,
each with its own bookings, plan, packing, money and documents; file-level
``settings`` hold preferences (default home currency for new trips,
passport rule, clock). Files from before (one file = one trip, the trip's
fields at the top level) still load: they're wrapped into ``trips[0]``.

Conventions:

* Calendar days are ``YYYY-MM-DD`` (local to wherever you are that day).
* Booking times are **wall-clock local times** (``YYYY-MM-DDTHH:MM``, no
  offset) plus the **IANA zone** of that endpoint (``Asia/Tokyo``), exactly
  as printed on a ticket. Instants and durations are derived with the zone
  database, so DST and date-line crossings come out right
  (:mod:`.timeutil`).
* Money is stored in **minor units of its own currency** (cents; whole yen)
  with an ISO 4217 code, and converted to the trip's home currency with the
  trip's manual rates (``per_home`` = units of that currency per 1 home
  unit, e.g. 1 AUD = 97.5 JPY).
"""
from __future__ import annotations

import hashlib
import re
from datetime import date, datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, model_validator

from app.items.spec import SafeUrl

# --------------------------------------------------------------- primitives


def _day(v: str) -> str:
    v = (v or "").strip()[:10]
    date.fromisoformat(v)  # raises ValueError on 2027-02-30
    return v


def _hhmm(v: str) -> str:
    v = (v or "").strip()
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", v)
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        raise ValueError("time must be HH:MM (24-hour)")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def normalize_local(v: object) -> str:
    """A wall-clock local time as ``YYYY-MM-DDTHH:MM``. Accepts a space
    instead of the T, seconds, or an offset (dropped — the wall time is what
    counts, its zone is stored beside it)."""
    if isinstance(v, datetime):
        return v.replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M")
    s = str(v or "").strip().replace(" ", "T")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        s += "T00:00"
    if s.endswith("Z"):
        s = s[:-1]
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M")


def valid_zone(v: str | None) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    if len(v) > 64 or ".." in v or v.startswith("/"):
        raise ValueError(f"unknown time zone {v!r}")
    try:
        ZoneInfo(v)
    except Exception as e:  # noqa: BLE001 — ZoneInfoNotFoundError / ValueError
        raise ValueError(f"unknown time zone {v!r} (use an IANA name like Asia/Tokyo)") from e
    return v


def _cur(v: str) -> str:
    v = (v or "").strip().upper()
    if not re.fullmatch(r"[A-Z]{3}", v):
        raise ValueError("currency must be a 3-letter ISO code like AUD")
    return v


def _color(v: str) -> str:
    v = (v or "").strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
        raise ValueError("colour must be a hex like #2C9CC8")
    return v.upper()


def _upper_code(v: str) -> str:
    return (v or "").strip().upper()[:4]


Day = Annotated[str, AfterValidator(_day)]
HHMM = Annotated[str, AfterValidator(_hhmm)]
LocalDT = Annotated[str, BeforeValidator(normalize_local)]
Zone = Annotated[str, AfterValidator(valid_zone)]
Currency = Annotated[str, AfterValidator(_cur)]
Color = Annotated[str, AfterValidator(_color)]
Code = Annotated[str, BeforeValidator(_upper_code)]
Lat = Annotated[float, Field(ge=-90, le=90)]
Lng = Annotated[float, Field(ge=-180, le=180)]
Minor = Annotated[int, Field(ge=0, le=10**13)]

Id = Annotated[str, Field(min_length=1, max_length=48)]
# Links are rendered as ``<a href>``: http(s)/mailto/tel only (an AI may copy
# them from web pages and booking PDFs).
Link = Annotated[SafeUrl, Field(max_length=520)]

TripStatus = Literal["planning", "booked", "travelling", "done"]
BookingType = Literal["flight", "stay", "car", "train", "bus", "ferry", "tour", "ticket", "insurance", "other"]
BookingStatus = Literal["confirmed", "pending", "cancelled"]
PlanType = Literal["activity", "food", "transport", "stay", "flight", "note"]
PlanStatus = Literal["idea", "planned", "booked", "done"]
Priority = Literal["must", "want", "maybe"]
Category = Literal["flights", "stays", "transport", "food", "activities", "shopping", "insurance", "fees", "other"]
SplitMode = Literal["equal", "exact", "shares"]
DocType = Literal["passport", "visa", "eta", "insurance", "vaccination", "driving_permit", "id_card", "other"]
DocStatus = Literal["todo", "applied", "done"]
AgeGroup = Literal["adult", "child", "infant"]

CATEGORIES: tuple[str, ...] = Category.__args__  # type: ignore[attr-defined]
BOOKING_TYPES: tuple[str, ...] = BookingType.__args__  # type: ignore[attr-defined]
TRANSPORT_TYPES = ("flight", "train", "bus", "ferry")


# --------------------------------------------------------------- the trip


class Traveller(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=60)
    is_me: bool = False  # legacy: the file's creator ("me" is per viewer — see TripData.me_by_user)
    user_id: str = Field(default="", max_length=64)  # the Promptly account this traveller is, when known
    contact_id: str = Field(default="", max_length=40)  # their card in the person's own Contacts, when picked from it
    age_group: AgeGroup = "adult"
    passport_country: str = Field(default="", max_length=60)


class Destination(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=80, description="City or region, e.g. Kyoto")
    country: str = Field(default="", max_length=60)
    lat: Lat | None = None
    lng: Lng | None = None
    tz: Zone = ""
    start: Day | None = None  # arrive
    end: Day | None = None  # leave
    notes: str = Field(default="", max_length=2000)


class CurrencyRate(BaseModel):
    code: Currency
    per_home: float = Field(gt=0, le=10_000_000, description="Units of this currency per 1 unit of home currency")
    updated: Day | None = None


class BudgetLine(BaseModel):
    category: Category
    amount_minor: Minor = 0


class Budget(BaseModel):
    total_minor: Minor | None = None  # in home currency
    lines: list[BudgetLine] = Field(default_factory=list, max_length=len(CATEGORIES))


class Attachment(BaseModel):
    file_id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=200)


class Booking(BaseModel):
    id: Id
    type: BookingType = "other"
    title: str = Field(default="", max_length=160)
    status: BookingStatus = "confirmed"
    start: LocalDT | None = None  # departure / check-in / pick-up — local wall time
    start_tz: Zone = ""
    end: LocalDT | None = None  # arrival / check-out / drop-off — local wall time
    end_tz: Zone = ""
    provider: str = Field(default="", max_length=80)  # airline, hotel, rental company, operator
    number: str = Field(default="", max_length=24)  # flight / train number
    from_code: Code = ""  # IATA (flights)
    to_code: Code = ""
    from_place: str = Field(default="", max_length=120)  # airport / station / pick-up
    to_place: str = Field(default="", max_length=120)
    terminal_from: str = Field(default="", max_length=20)
    terminal_to: str = Field(default="", max_length=20)
    seat: str = Field(default="", max_length=40)
    cabin: str = Field(default="", max_length=30)
    address: str = Field(default="", max_length=240)
    lat: Lat | None = None
    lng: Lng | None = None
    confirmation: str = Field(default="", max_length=60)
    cost_minor: Minor | None = None
    currency: Currency | None = None  # None = home currency
    paid: bool = True
    traveller_ids: list[Id] = Field(default_factory=list, max_length=20)  # empty = everyone
    attachments: list[Attachment] = Field(default_factory=list, max_length=20)
    link: Link = ""
    phone: str = Field(default="", max_length=40)
    notes: str = Field(default="", max_length=4000)


class PlanItem(BaseModel):
    id: Id
    time: HHMM | None = None  # None = anytime
    duration_min: int | None = Field(default=None, ge=0, le=4320)
    type: PlanType = "activity"
    title: str = Field(min_length=1, max_length=160)
    place: str = Field(default="", max_length=120)
    address: str = Field(default="", max_length=240)
    area: str = Field(default="", max_length=80)  # neighbourhood, for clustering
    lat: Lat | None = None
    lng: Lng | None = None
    cost_minor: Minor | None = None
    currency: Currency | None = None
    link: Link = ""
    status: PlanStatus = "planned"
    notes: str = Field(default="", max_length=2000)
    booking_id: str | None = Field(default=None, max_length=48)
    travel_after: str = Field(default="", max_length=120)  # "15 min walk", to the next item


class TripDay(BaseModel):
    date: Day
    title: str = Field(default="", max_length=120)
    notes: str = Field(default="", max_length=2000)
    tz: Zone = ""  # where you are; blank = from destinations / stays
    items: list[PlanItem] = Field(default_factory=list, max_length=40)


class Idea(BaseModel):
    id: Id
    title: str = Field(min_length=1, max_length=160)
    type: PlanType = "activity"
    place: str = Field(default="", max_length=120)
    address: str = Field(default="", max_length=240)
    area: str = Field(default="", max_length=80)
    lat: Lat | None = None
    lng: Lng | None = None
    tags: list[Annotated[str, Field(max_length=30)]] = Field(default_factory=list, max_length=12)
    priority: Priority = "want"
    duration_min: int | None = Field(default=None, ge=0, le=4320)
    cost_minor: Minor | None = None
    currency: Currency | None = None
    hours: str = Field(default="", max_length=200)  # opening hours / days closed
    book_ahead: bool = False
    link: Link = ""
    notes: str = Field(default="", max_length=2000)


class PackingItem(BaseModel):
    id: Id
    name: str = Field(min_length=1, max_length=80)
    category: str = Field(default="Other", max_length=40)
    traveller_id: str | None = Field(default=None, max_length=48)  # None = shared
    qty: int = Field(default=1, ge=1, le=99)
    checked: bool = False
    essential: bool = False
    notes: str = Field(default="", max_length=200)


class Share(BaseModel):
    traveller_id: Id
    amount_minor: Minor | None = None  # exact split, expense currency
    weight: float | None = Field(default=None, ge=0, le=1000)  # shares split


class Expense(BaseModel):
    id: Id
    date: Day
    title: str = Field(min_length=1, max_length=120)
    amount_minor: Minor = 0
    currency: Currency = "AUD"
    category: Category = "other"
    paid_by: str | None = Field(default=None, max_length=48)
    split: SplitMode = "equal"
    shares: list[Share] = Field(default_factory=list, max_length=20)  # empty + equal = everyone
    per_home: float | None = Field(default=None, gt=0, le=10_000_000)  # locked rate; None = trip rate
    booking_id: str | None = Field(default=None, max_length=48)
    notes: str = Field(default="", max_length=500)


class Settlement(BaseModel):
    id: Id
    date: Day
    from_id: Id
    to_id: Id
    amount_minor: Minor  # home currency
    note: str = Field(default="", max_length=200)


class TravelDocument(BaseModel):
    id: Id
    type: DocType = "other"
    traveller_id: str | None = Field(default=None, max_length=48)
    title: str = Field(default="", max_length=120)
    country: str = Field(default="", max_length=60)  # issuing country / country it's for
    reference: str = Field(default="", max_length=40)  # keep it to the last few digits
    issued: Day | None = None
    expires: Day | None = None
    status: DocStatus = "todo"
    remind_on: Day | None = None
    attachments: list[Attachment] = Field(default_factory=list, max_length=10)
    link: Link = ""
    notes: str = Field(default="", max_length=1000)


class Settings(BaseModel):
    """The person's preferences, for every trip in the file."""

    home_currency: Currency = "AUD"  # the default for new trips (each trip has its own)
    passport_months: int = Field(default=6, ge=0, le=12)  # validity needed beyond return
    onboarded: bool = False
    clock: Literal["auto", "24h", "12h"] = "auto"
    distance: Literal["km", "mi"] = "km"


MAX_TRIPS = 100


class Trip(BaseModel):
    id: Id = "trip"
    title: str = Field(default="", max_length=120)
    home_currency: Currency = "AUD"  # budgets, settle-up and conversions for this trip
    emoji: str = Field(default="✈️", max_length=16)
    color: Color = "#2C9CC8"
    start: Day | None = None
    end: Day | None = None
    status: TripStatus = "planning"
    notes: str = Field(default="", max_length=5000)
    destinations: list[Destination] = Field(default_factory=list, max_length=40)
    travellers: list[Traveller] = Field(default_factory=list, max_length=20)
    currencies: list[CurrencyRate] = Field(default_factory=list, max_length=24)
    budget: Budget = Field(default_factory=Budget)
    bookings: list[Booking] = Field(default_factory=list, max_length=300)
    days: list[TripDay] = Field(default_factory=list, max_length=400)
    ideas: list[Idea] = Field(default_factory=list, max_length=500)
    packing: list[PackingItem] = Field(default_factory=list, max_length=800)
    expenses: list[Expense] = Field(default_factory=list, max_length=3000)
    settlements: list[Settlement] = Field(default_factory=list, max_length=300)
    documents: list[TravelDocument] = Field(default_factory=list, max_length=120)
    # Which traveller each Promptly user is ("this is me"): user id → traveller id.
    me_by_user: dict[Annotated[str, Field(max_length=64)], Annotated[str, Field(max_length=48)]] = Field(
        default_factory=dict, max_length=40
    )
    # Each traveller's own Photos album of the trip (user id → album id): a
    # smart album of their photos taken between the trip's dates.
    photo_albums: dict[Annotated[str, Field(max_length=64)], Annotated[str, Field(max_length=64)]] = Field(
        default_factory=dict, max_length=40
    )

    @model_validator(mode="after")
    def _tidy(self) -> Trip:
        if self.start and self.end and self.end < self.start:
            self.start, self.end = self.end, self.start
        # One entry per date, in date order (duplicates merged).
        merged: dict[str, TripDay] = {}
        for d in self.days:
            if d.date in merged:
                keep = merged[d.date]
                keep.items = (keep.items + d.items)[:40]
                keep.title = keep.title or d.title
                keep.notes = keep.notes or d.notes
                keep.tz = keep.tz or d.tz
            else:
                merged[d.date] = d
        self.days = [merged[k] for k in sorted(merged)]
        # The home currency never needs a rate.
        home = self.home_currency
        seen: set[str] = set()
        rates = []
        for r in self.currencies:
            if r.code == home or r.code in seen:
                continue
            seen.add(r.code)
            rates.append(r)
        self.currencies = rates
        # "This is me" only points at travellers that exist, one user per traveller.
        ids = {t.id for t in self.travellers}
        seen_t: set[str] = set()
        me: dict[str, str] = {}
        for uid, tid in self.me_by_user.items():
            if tid in ids and tid not in seen_t:
                me[uid] = tid
                seen_t.add(tid)
        self.me_by_user = me
        return self


# Top-level keys of a file from before multiple trips (one file = one trip).
LEGACY_KEYS = tuple(k for k in Trip.model_fields if k not in ("id", "home_currency"))
_CONTENT_KEYS = ("start", "end", "destinations", "bookings", "days", "ideas", "packing", "expenses", "settlements",
                 "documents", "notes", "budget", "currencies")


def legacy_trip_id(old: dict) -> str:
    """A stable id for the trip of an old one-trip file (the same file always
    gets the same id, so a replayed migration agrees with itself)."""
    seed = "|".join(str(old.get(k) or "") for k in ("title", "start", "end"))
    seed += "|" + ",".join(str(b.get("id", "")) for b in (old.get("bookings") or [])[:5] if isinstance(b, dict))
    return "trip-" + hashlib.sha1(seed.encode()).hexdigest()[:8]


def wrap_legacy(raw: dict) -> dict:
    """An old one-trip file → the multi-trip shape (``trips[0]``). A brand-new
    old file that never got past setup (no dates, places, bookings…) becomes
    an empty file, so the person starts with "New trip"."""
    settings = dict(raw.get("settings") or {})
    out: dict[str, Any] = {k: v for k, v in raw.items() if k not in LEGACY_KEYS and k not in ("id", "home_currency")}
    out["settings"] = settings
    has_content = any(raw.get(k) for k in _CONTENT_KEYS if k != "budget") or bool(
        (raw.get("budget") or {}).get("total_minor") or (raw.get("budget") or {}).get("lines")
    ) or (raw.get("title") or "").strip() or settings.get("onboarded")
    if not has_content:
        out["trips"] = []
        return out
    trip = {k: raw[k] for k in LEGACY_KEYS if k in raw}
    trip["id"] = raw.get("id") or legacy_trip_id(raw)
    trip["home_currency"] = raw.get("home_currency") or settings.get("home_currency") or "AUD"
    out["trips"] = [trip]
    return out


class TripData(BaseModel):
    """The whole file: every trip, plus the person's preferences."""

    trips: list[Trip] = Field(default_factory=list, max_length=MAX_TRIPS)
    settings: Settings = Field(default_factory=Settings)

    @model_validator(mode="before")
    @classmethod
    def _legacy(cls, v: Any) -> Any:
        if isinstance(v, dict) and "trips" not in v and any(k in v for k in LEGACY_KEYS):
            return wrap_legacy(v)
        return v

    @model_validator(mode="after")
    def _unique_ids(self) -> TripData:
        seen: set[str] = set()
        for t in self.trips:
            base, n = t.id, 2
            while t.id in seen:
                t.id, n = f"{base[:44]}-{n}", n + 1
            seen.add(t.id)
        return self
