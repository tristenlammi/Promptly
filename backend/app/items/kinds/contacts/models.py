"""Contacts — the file's shape.

One file is one address book: people (with everything Google Contacts
keeps, plus a personal CRM's memory — interactions, a keep-in-touch rhythm,
gift ideas, things to remember, follow-ups), groups, and the person's
reminder preferences. Every field has a default so older files keep
loading; every list is bounded so a file stays well under the size limit.

Dates: a calendar day is ``YYYY-MM-DD``; a birthday or important date may
leave the year out as ``--MM-DD`` (vCard's own form).
"""
from __future__ import annotations

import calendar
import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.items.spec import SafeUrl, _safe_url

DAY_RE = r"^\d{4}-\d{2}-\d{2}$"
DATE_RE = r"^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$"
HEX_RE = r"^#[0-9A-Fa-f]{6}$"
TIME_RE = r"^([01]\d|2[0-3]):[0-5]\d$"

RelType = Literal[
    "partner", "spouse", "child", "parent", "sibling", "friend", "colleague", "manager", "report", "relative", "other"
]
REL_TYPES: tuple[str, ...] = (
    "partner", "spouse", "child", "parent", "sibling", "friend", "colleague", "manager", "report", "relative", "other"
)
# What the other person is to this one, when a link is made both ways.
RECIPROCAL: dict[str, str] = {
    "partner": "partner",
    "spouse": "spouse",
    "child": "parent",
    "parent": "child",
    "sibling": "sibling",
    "friend": "friend",
    "colleague": "colleague",
    "manager": "report",
    "report": "manager",
    "relative": "relative",
    "other": "other",
}
InteractionType = Literal["call", "message", "meeting", "email", "other"]
INTERACTION_TYPES: tuple[str, ...] = ("call", "message", "meeting", "email", "other")


def valid_date(s: str | None) -> bool:
    """``YYYY-MM-DD`` or ``--MM-DD`` naming a real day (29 Feb allowed
    without a year)."""
    if not s:
        return False
    m = re.fullmatch(r"(\d{4}|-)-(\d{2})-(\d{2})", s)
    if not m:
        return False
    month, day = int(m.group(2)), int(m.group(3))
    if not 1 <= month <= 12:
        return False
    year = int(m.group(1)) if m.group(1) != "-" else 2000  # a leap year
    if year < 1:
        return False
    return 1 <= day <= calendar.monthrange(year, month)[1]


def _clean_str(v: object) -> object:
    return v.strip() if isinstance(v, str) else v


def _dedupe_strings(values: list[str], limit: int = 40) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        s = " ".join(str(v).split())[:limit]
        if s and s.casefold() not in seen:
            seen.add(s.casefold())
            out.append(s)
    return out


class Labeled(BaseModel):
    """A phone, email or website with its label ("mobile", "work", "LinkedIn")."""

    label: str = Field(default="", max_length=40)
    value: str = Field(default="", max_length=320)

    clean_text = field_validator("label", "value", mode="before")(_clean_str)


# Social handles typed as "@name": the profile they mean.
_HANDLE_SITES = {
    "instagram": "https://instagram.com/", "x": "https://x.com/", "twitter": "https://x.com/",
    "tiktok": "https://www.tiktok.com/@", "github": "https://github.com/", "threads": "https://www.threads.net/@",
    "bluesky": "https://bsky.app/profile/", "facebook": "https://facebook.com/", "telegram": "https://t.me/",
}


def normalize_website(label: str, value: str) -> str | None:
    """A website / profile as a safe link ("@sam" with label Instagram →
    instagram.com/sam); None when it can't be one (``javascript:``, ``skype:``)."""
    v = (value or "").strip()
    if not v:
        return None
    if v.startswith("@") and " " not in v and len(v) > 1:
        base = _HANDLE_SITES.get((label or "").strip().casefold(), "https://x.com/")
        v = base + v[1:]
    try:
        return _safe_url(v) or None
    except ValueError:
        return None


class Website(BaseModel):
    label: str = Field(default="", max_length=40)
    value: SafeUrl = Field(default="", max_length=2000)

    clean_label = field_validator("label", mode="before")(_clean_str)


# A contact photo: a small JPEG/PNG/WebP data URL (the app downscales to
# ~256 px). Capped per photo and per file so photos can't fill the file.
PHOTO_MAX_CHARS = 82_000  # ≈ 60 KB of image
PHOTO_BUDGET_CHARS = 4_500_000  # all photos in one file (≈ 3.3 MB)
PHOTO_RE = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$")


def photo_problem(v: str | None) -> str | None:
    """Why ``v`` can't be a contact photo (None when it's fine)."""
    if not v:
        return None
    if len(v) > PHOTO_MAX_CHARS:
        return "that photo is too big (keep it under 60 KB — the app shrinks it for you)"
    if not PHOTO_RE.fullmatch(v):
        return "a photo must be a JPEG, PNG or WebP data URL"
    return None


class Address(BaseModel):
    label: str = Field(default="", max_length=40)
    street: str = Field(default="", max_length=300)
    city: str = Field(default="", max_length=120)
    region: str = Field(default="", max_length=120)
    postcode: str = Field(default="", max_length=30)
    country: str = Field(default="", max_length=80)

    clean_text = field_validator("label", "street", "city", "region", "postcode", "country", mode="before")(_clean_str)


class ImportantDate(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    label: str = Field(default="", max_length=60)
    date: str = Field(pattern=DATE_RE)
    kind: Literal["anniversary", "other"] = "other"
    remind: bool = True

    @field_validator("date")
    @classmethod
    def _real_day(cls, v: str) -> str:
        if not valid_date(v):
            raise ValueError("not a real date")
        return v


class Relationship(BaseModel):
    """To another contact (``contact_id``) or someone not in the book (``name``)."""

    id: str = Field(min_length=1, max_length=40)
    type: RelType = "other"
    contact_id: str | None = Field(default=None, max_length=40)
    name: str = Field(default="", max_length=120)
    label: str = Field(default="", max_length=40)  # "cousin", "mentor" — refines the type


class Interaction(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    date: str = Field(pattern=DAY_RE)
    type: InteractionType = "other"
    notes: str = Field(default="", max_length=4000)


class Note(BaseModel):
    """A thing to remember, a gift idea or a conversation topic / follow-up."""

    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=500)
    done: bool = False  # gift given / topic covered
    added: str | None = Field(default=None, pattern=DAY_RE)


class Contact(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    # Name
    prefix: str = Field(default="", max_length=40)
    first: str = Field(default="", max_length=100)
    middle: str = Field(default="", max_length=100)
    last: str = Field(default="", max_length=100)
    suffix: str = Field(default="", max_length=40)
    nickname: str = Field(default="", max_length=100)
    pronouns: str = Field(default="", max_length=40)
    phonetic_first: str = Field(default="", max_length=100)
    phonetic_last: str = Field(default="", max_length=100)
    # Work
    company: str = Field(default="", max_length=160)
    title: str = Field(default="", max_length=160)
    department: str = Field(default="", max_length=160)
    # Reach
    phones: list[Labeled] = Field(default_factory=list, max_length=20)
    emails: list[Labeled] = Field(default_factory=list, max_length=20)
    addresses: list[Address] = Field(default_factory=list, max_length=10)
    websites: list[Website] = Field(default_factory=list, max_length=20)
    photo: str | None = Field(default=None, max_length=PHOTO_MAX_CHARS)
    # The vCard UID it came with (or was exported as) — re-imports match on it.
    uid: str = Field(default="", max_length=200)
    # "<import id>:<row>" for people an import added — makes a retried import idempotent.
    import_ref: str = Field(default="", max_length=80)
    # Dates
    birthday: str | None = Field(default=None, pattern=DATE_RE)
    dates: list[ImportantDate] = Field(default_factory=list, max_length=30)
    # How we met
    met_how: str = Field(default="", max_length=500)
    met_where: str = Field(default="", max_length=200)
    met_date: str | None = Field(default=None, pattern=DAY_RE)
    # People around them
    relationships: list[Relationship] = Field(default_factory=list, max_length=50)
    # Organise
    tags: list[str] = Field(default_factory=list, max_length=50)
    groups: list[str] = Field(default_factory=list, max_length=50)  # group ids
    notes: str = Field(default="", max_length=20_000)
    favorite: bool = False
    color: str | None = Field(default=None, pattern=HEX_RE)  # initials avatar
    created_at: str = Field(default="", max_length=40)
    updated_at: str = Field(default="", max_length=40)
    # Personal CRM
    interactions: list[Interaction] = Field(default_factory=list, max_length=2000)
    cadence_days: int | None = Field(default=None, ge=1, le=730)
    snoozed_until: str | None = Field(default=None, pattern=DAY_RE)
    gifts: list[Note] = Field(default_factory=list, max_length=100)
    remember: list[Note] = Field(default_factory=list, max_length=100)
    topics: list[Note] = Field(default_factory=list, max_length=100)

    clean_text = field_validator(
        "prefix", "first", "middle", "last", "suffix", "nickname", "pronouns", "phonetic_first", "phonetic_last",
        "company", "title", "department", "met_how", "met_where", mode="before",
    )(_clean_str)

    @field_validator("birthday", "met_date", "snoozed_until", mode="before")
    @classmethod
    def _blank_is_none(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("birthday")
    @classmethod
    def _real_birthday(cls, v: str | None) -> str | None:
        if v is not None and not valid_date(v):
            raise ValueError("not a real date")
        return v

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        return _dedupe_strings(v)

    @field_validator("groups")
    @classmethod
    def _groups(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(g for g in v if g))

    @field_validator("phones", "emails")
    @classmethod
    def _drop_blank(cls, v: list[Labeled]) -> list[Labeled]:
        return [x for x in v if x.value]

    @field_validator("websites", mode="before")
    @classmethod
    def _safe_websites(cls, v: object) -> object:
        """Unsafe or unreadable links are dropped (not refused) so an old
        file or an odd import still loads."""
        if not isinstance(v, list):
            return v
        out = []
        for w in v:
            if isinstance(w, dict):
                url = normalize_website(str(w.get("label") or ""), str(w.get("value") or ""))
                if url:
                    out.append({**w, "value": url})
            else:
                out.append(w)
        return out

    @field_validator("photo", mode="before")
    @classmethod
    def _photo(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip():
            return None
        if isinstance(v, str) and (why := photo_problem(v.strip())):
            raise ValueError(why)
        return v.strip() if isinstance(v, str) else v

    @field_validator("addresses")
    @classmethod
    def _drop_blank_addr(cls, v: list[Address]) -> list[Address]:
        return [a for a in v if any((a.street, a.city, a.region, a.postcode, a.country))]

    @field_validator("interactions")
    @classmethod
    def _newest_first(cls, v: list[Interaction]) -> list[Interaction]:
        return sorted(v, key=lambda i: i.date, reverse=True)


class Group(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=60)
    color: str | None = Field(default=None, pattern=HEX_RE)
    description: str = Field(default="", max_length=300)


class Settings(BaseModel):
    reminder_time: str = Field(default="09:00", pattern=TIME_RE)  # local time for date reminders
    birthday_reminders: bool = True
    birthday_days_before: int = Field(default=0, ge=0, le=30)  # 0 = only on the day
    date_reminders: bool = True
    reconnect_digest: bool = True  # a weekly "time to catch up with…" digest
    digest_weekday: int = Field(default=0, ge=0, le=6)  # Monday = 0
    name_order: Literal["first_last", "last_first"] = "first_last"
    sort_by: Literal["first", "last"] = "first"
    default_cadence_days: int | None = Field(default=None, ge=1, le=730)
    # Country national phone numbers are read in ("AU"); "" = from the person's
    # Promptly location / time zone.
    phone_country: str = Field(default="", pattern=r"^([A-Z]{2})?$")
    # Pairs the person said aren't the same person ("idA|idB", sorted).
    not_duplicates: list[str] = Field(default_factory=list, max_length=5000)


class ContactsData(BaseModel):
    contacts: list[Contact] = Field(default_factory=list, max_length=10_000)
    groups: list[Group] = Field(default_factory=list, max_length=200)
    settings: Settings = Field(default_factory=Settings)

    @model_validator(mode="after")
    def _integrity(self) -> "ContactsData":
        ids = [c.id for c in self.contacts]
        if len(set(ids)) != len(ids):
            raise ValueError("two contacts share an id")
        gids = [g.id for g in self.groups]
        if len(set(gids)) != len(gids):
            raise ValueError("two groups share an id")
        known, groups = set(ids), set(gids)
        photos = sum(len(c.photo or "") for c in self.contacts)
        if photos > PHOTO_BUDGET_CHARS:
            raise ValueError("contact photos take too much room in this file — remove some photos")
        for c in self.contacts:
            # Ids inside a contact must be unique (the app removes by id);
            # older merges could leave repeats — renumber them.
            for lst, prefix in ((c.dates, "d"), (c.relationships, "r"), (c.interactions, "i"), (c.gifts, "g"), (c.remember, "m"), (c.topics, "t")):
                seen: set[str] = set()
                for x in lst:
                    if x.id in seen:
                        n = 1
                        while f"{prefix}{n}" in seen or any(y.id == f"{prefix}{n}" for y in lst):
                            n += 1
                        x.id = f"{prefix}{n}"
                    seen.add(x.id)
            c.groups = [g for g in c.groups if g in groups]
            for r in c.relationships:
                if r.contact_id is not None and (r.contact_id not in known or r.contact_id == c.id):
                    r.contact_id = None
            c.relationships = [r for r in c.relationships if r.contact_id or r.name]
        return self
