"""Contacts — actions: the AI's (and the UI's) hands. Every one is
deterministic for (data, args, ctx.now): ids come from names and counters,
never from randomness."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from . import logic as L
from .models import (
    HEX_RE,
    INTERACTION_TYPES,
    PHOTO_BUDGET_CHARS,
    PHOTO_MAX_CHARS,
    RECIPROCAL,
    Address,
    InteractionType,
    RelType,
    photo_problem,
)

# ------------------------------------------------------------------ helpers

_PREFIXES = {"mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "dame", "rev", "fr"}
_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "phd", "md", "esq", "obe", "mbe", "cpa"}


def split_name(full: str) -> dict:
    """"Dr Jane Q. Smith Jr." → its parts. "Smith, Jane" works too."""
    full = " ".join((full or "").split())
    if "," in full and full.count(",") == 1:
        last, rest = (x.strip() for x in full.split(","))
        if rest and last and rest.rstrip(".").lower() not in _SUFFIXES:
            full = f"{rest} {last}"
    words = full.split(" ") if full else []
    out = {"prefix": "", "first": "", "middle": "", "last": "", "suffix": ""}
    if words and words[0].rstrip(".").lower() in _PREFIXES:
        out["prefix"] = words.pop(0)
    if len(words) > 1 and words[-1].rstrip(".").replace(",", "").lower() in _SUFFIXES:
        out["suffix"] = words.pop(-1)
        if words:
            words[-1] = words[-1].rstrip(",")
    if words:
        out["first"] = words[0]
    if len(words) > 1:
        out["last"] = words[-1]
        out["middle"] = " ".join(words[1:-1])
    return out


def resolve(data: dict, ref: str) -> dict:
    """A contact by id — or, failing that, by an unambiguous name."""
    ref = (ref or "").strip()
    for c in data["contacts"]:
        if c["id"] == ref:
            return c
    f = L.fold(ref)
    if f:
        exact = [c for c in data["contacts"] if L.fold(L.display_name(c)) == f or L.fold(c.get("nickname", "")) == f]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            raise ActionError(
                f"More than one contact is called {ref!r} ("
                + ", ".join(f"{L.display_name(c)} [{c['id']}]" for c in exact[:5])
                + "). Use the id."
            )
        firsts = [c for c in data["contacts"] if L.fold(c.get("first", "")) == f]
        if len(firsts) == 1:
            return firsts[0]
    raise ActionError(f"No contact matches {ref!r}. Use find_contacts to get the id.")


def resolve_many(data: dict, refs: list[str]) -> list[dict]:
    out, seen = [], set()
    for r in refs:
        c = resolve(data, r)
        if c["id"] not in seen:
            seen.add(c["id"])
            out.append(c)
    return out


def group_id(data: dict, name_or_id: str, *, create: bool) -> str | None:
    s = (name_or_id or "").strip()
    if not s:
        return None
    for g in data["groups"]:
        if g["id"] == s or L.fold(g["name"]) == L.fold(s):
            return g["id"]
    if not create:
        return None
    if len(data["groups"]) >= 200:
        raise ActionError("That's the most groups one file can hold (200).")
    gid = L.new_id("g", [g["id"] for g in data["groups"]], L.slug(s) or "group")
    data["groups"].append({"id": gid, "name": s[:60], "color": None, "description": ""})
    return gid


def country_of(data: dict, ctx: ItemContext) -> str:
    """The country national phone numbers are read in for this person."""
    return L.home_country(data, ctx.user, ctx.tz)


def _stamp(ctx: ItemContext) -> str:
    return ctx.now.isoformat(timespec="seconds")


def _touch(c: dict, ctx: ItemContext) -> None:
    c["updated_at"] = _stamp(ctx)


def _date_or_fail(value: str, today: date, what: str, *, allow_no_year: bool = True) -> str:
    v = L.parse_date_flexible(value, today)
    if v is None or (v.startswith("--") and not allow_no_year):
        raise ActionError(f"I couldn't read {value!r} as {what} — use YYYY-MM-DD (or --MM-DD without a year).")
    return v


def _notes(texts: list[str], existing: list[dict], prefix: str, today: date) -> list[dict]:
    have = {L.fold(n["text"]) for n in existing}
    taken = [n["id"] for n in existing]
    out = []
    for t in texts:
        t = " ".join((t or "").split())[:500]
        if not t or L.fold(t) in have:
            continue
        have.add(L.fold(t))
        nid = L.new_id(prefix, taken)
        taken.append(nid)
        out.append({"id": nid, "text": t, "done": False, "added": today.isoformat()})
    return out


def _brief(c: dict, data: dict, today: date) -> dict:
    """A compact summary of one contact for the model."""
    order = data["settings"].get("name_order", "first_last")
    out: dict = {"id": c["id"], "name": L.display_name(c, order)}
    if c.get("nickname"):
        out["nickname"] = c["nickname"]
    work = " at ".join(x for x in (c.get("title"), c.get("company")) if x)
    if work:
        out["work"] = work
    if c.get("emails"):
        out["email"] = c["emails"][0]["value"]
    if c.get("phones"):
        out["phone"] = c["phones"][0]["value"]
    if c.get("tags"):
        out["tags"] = c["tags"]
    last = L.last_contacted(c)
    if last:
        out["last_contacted"] = last
    if c.get("favorite"):
        out["favorite"] = True
    return out


# ------------------------------------------------------------------ params


class LabeledIn(BaseModel):
    label: str = Field(default="", max_length=40, description='e.g. "mobile", "work", "home", "LinkedIn", "Instagram"')
    value: str = Field(min_length=1, max_length=320)


class DateIn(BaseModel):
    label: str = Field(default="", max_length=60, description='e.g. "Wedding anniversary", "Started at Atlassian"')
    date: str = Field(description="YYYY-MM-DD, or --MM-DD when the year isn't known")
    kind: Literal["anniversary", "other"] = "other"


class RelationIn(BaseModel):
    type: RelType
    contact_id: str | None = Field(default=None, description="When the other person is in the contacts")
    name: str = Field(default="", max_length=120, description="When they aren't (e.g. a child's name)")
    label: str = Field(default="", max_length=40, description='Refines the type ("cousin", "mentor")')


class ContactIn(BaseModel):
    full_name: str = Field(default="", max_length=300, description="Used when first/last aren't given; split for you")
    prefix: str = Field(default="", max_length=40)
    first: str = Field(default="", max_length=100)
    middle: str = Field(default="", max_length=100)
    last: str = Field(default="", max_length=100)
    suffix: str = Field(default="", max_length=40)
    nickname: str = Field(default="", max_length=100)
    pronouns: str = Field(default="", max_length=40)
    phonetic_first: str = Field(default="", max_length=100)
    phonetic_last: str = Field(default="", max_length=100)
    company: str = Field(default="", max_length=160)
    title: str = Field(default="", max_length=160, description="Job title")
    department: str = Field(default="", max_length=160)
    phones: list[LabeledIn] = Field(default_factory=list, max_length=20)
    emails: list[LabeledIn] = Field(default_factory=list, max_length=20)
    addresses: list[Address] = Field(default_factory=list, max_length=10)
    websites: list[LabeledIn] = Field(default_factory=list, max_length=20, description="Websites and social profiles")
    birthday: str | None = Field(default=None, description="YYYY-MM-DD, or --MM-DD without a year")
    dates: list[DateIn] = Field(default_factory=list, max_length=30)
    met_how: str = Field(default="", max_length=500, description="How you met (\"intro from Priya at DevCon\")")
    met_where: str = Field(default="", max_length=200)
    met_date: str | None = Field(default=None, description="YYYY-MM-DD")
    relationships: list[RelationIn] = Field(default_factory=list, max_length=50)
    tags: list[str] = Field(default_factory=list, max_length=50)
    groups: list[str] = Field(default_factory=list, max_length=50, description="Group names (created if new)")
    notes: str = Field(default="", max_length=20_000)
    favorite: bool = False
    cadence_days: int | None = Field(default=None, ge=1, le=730, description="Keep in touch every N days")
    remember: list[str] = Field(default_factory=list, max_length=100, description="Things to remember about them")
    gift_ideas: list[str] = Field(default_factory=list, max_length=100)
    topics: list[str] = Field(default_factory=list, max_length=100, description="Conversation topics / follow-ups")
    photo: str | None = Field(default=None, max_length=PHOTO_MAX_CHARS, description="Imports only: a small image data URL")
    uid: str = Field(default="", max_length=200, description="Imports only: the vCard UID")
    import_ref: str = Field(default="", max_length=80, description="Imports only: '<import_id>:<row>'")


def build_contact(data: dict, ci: ContactIn, ctx: ItemContext, *, strict: bool = True) -> dict | None:
    """A new contact from ``ci`` (not yet in ``data``; its groups are named in
    ``_group_names`` — see :func:`attach_groups`). ``strict`` refuses
    unreadable dates, bad photos and nameless people; otherwise (imports)
    bad dates/photos are dropped and a nameless person comes back as None."""
    today = ctx.today

    def when(value: str | None, what: str, allow_no_year: bool = True) -> str | None:
        if not value:
            return None
        if strict:
            return _date_or_fail(value, today, what, allow_no_year=allow_no_year)
        v = L.parse_date_flexible(value, today)
        return None if v is None or (v.startswith("--") and not allow_no_year) else v
    parts = {k: getattr(ci, k) for k in ("prefix", "first", "middle", "last", "suffix")}
    if ci.full_name and not (ci.first or ci.last):
        for k, v in split_name(ci.full_name).items():
            parts[k] = parts[k] or v
    photo = (ci.photo or "").strip() or None
    if photo and (why := photo_problem(photo)):
        if strict:
            raise ActionError(why[0].upper() + why[1:] + ".")
        photo = None
    c: dict = {
        **parts,
        **{k: getattr(ci, k) for k in (
            "nickname", "pronouns", "phonetic_first", "phonetic_last", "company", "title", "department",
            "met_how", "met_where", "notes", "favorite",
        )},
        "phones": [p.model_dump() for p in ci.phones],
        "emails": [e.model_dump() for e in ci.emails],
        "websites": [w.model_dump() for w in ci.websites],
        "addresses": [a.model_dump() for a in ci.addresses],
        "birthday": when(ci.birthday, "a birthday"),
        "met_date": when(ci.met_date, "the day you met", allow_no_year=False),
        "dates": [],
        "relationships": [],
        "tags": ci.tags,
        "groups": [],
        "color": None,
        "photo": photo,
        "uid": ci.uid.strip(),
        "import_ref": ci.import_ref.strip(),
        "created_at": _stamp(ctx),
        "updated_at": _stamp(ctx),
        "interactions": [],
        "cadence_days": ci.cadence_days or data["settings"].get("default_cadence_days"),
        "snoozed_until": None,
        "_group_names": [g for g in ci.groups if g.strip()],
    }
    if not any(c[k] for k in ("first", "last", "nickname", "company")) and not c["emails"] and not c["phones"]:
        if not strict:
            return None
        raise ActionError("A contact needs at least a name, company, email or phone.")
    for d in ci.dates:
        day = when(d.date, "a date")
        if day:
            c["dates"].append({"id": f"d{len(c['dates']) + 1}", "label": d.label, "date": day, "kind": d.kind, "remind": True})
    known = {x["id"] for x in data["contacts"]}
    for r in ci.relationships:
        linked = r.contact_id in known
        if not linked and not r.name.strip():
            continue
        c["relationships"].append(
            {
                "id": f"r{len(c['relationships']) + 1}", "type": r.type, "label": r.label,
                "contact_id": r.contact_id if linked else None,
                "name": "" if linked else " ".join(r.name.split()),
            }
        )
    c["remember"] = _notes(ci.remember, [], "m", today)
    c["gifts"] = _notes(ci.gift_ideas, [], "g", today)
    c["topics"] = _notes(ci.topics, [], "t", today)
    return c


def attach_groups(data: dict, c: dict) -> None:
    """Create (if new) and join the groups ``build_contact`` noted — only for
    people who are actually added or merged."""
    names = c.pop("_group_names", [])
    c["groups"] = list(dict.fromkeys([*c.get("groups", []), *(gid for g in names if (gid := group_id(data, g, create=True)))]))[:50]


# ------------------------------------------------------------- add / edit


class AddContacts(BaseModel):
    contacts: list[ContactIn] = Field(min_length=1, max_length=2000)
    on_duplicate: Literal["add", "skip", "merge"] = Field(
        default="add",
        description="When someone is surely already there (the same email, the same full phone number, or the same "
        "vCard UID — never just the same name): add anyway, skip them, or merge the new details into the existing contact",
    )
    batch: bool | None = Field(
        default=None,
        description="Import mode: rows with unreadable dates or no name are left out instead of refusing the whole "
        "call. Default: on for more than one contact.",
    )
    import_id: str | None = Field(
        default=None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$",
        description="Imports only: one id for the whole import (its chunks and retries) — people added by it are never "
        "matched with each other, and rows already added are skipped",
    )


def add_contacts(ctx: ItemContext, data: dict, p: AddContacts) -> ActionOutcome:
    added, merged, skipped, maybe, invalid, already = [], [], [], [], 0, 0
    photos_dropped = 0
    cc = country_of(data, ctx)
    prefix = f"{p.import_id}:" if p.import_id else None
    # Only people who were there before this import are matched against.
    before = [x for x in data["contacts"] if not (prefix and x.get("import_ref", "").startswith(prefix))]
    index = L.DupeIndex(before, cc)
    refs = {x["import_ref"] for x in data["contacts"] if x.get("import_ref")}
    taken = {x["id"] for x in data["contacts"]}
    strict = (not p.batch) if p.batch is not None else len(p.contacts) == 1
    photo_room = PHOTO_BUDGET_CHARS - sum(len(x.get("photo") or "") for x in data["contacts"])
    for ci in p.contacts:
        if ci.import_ref and ci.import_ref in refs:
            already += 1  # a retried chunk: this row is already in
            continue
        c = build_contact(data, ci, ctx, strict=strict)
        if c is None:
            invalid += 1
            continue
        hit = index.match(c)
        existing = next((x for x in data["contacts"] if x["id"] == hit[0]), None) if hit else None
        if existing is not None and p.on_duplicate == "skip":
            skipped.append({"id": existing["id"], "name": L.display_name(existing), "why": hit[1]})
            continue
        if c.get("photo"):
            room_needed = len(c["photo"]) - (len(existing.get("photo") or "") if existing is not None and p.on_duplicate == "merge" else 0)
            if room_needed > photo_room:
                if strict:
                    raise ActionError("There's no room for more photos in this file — remove some photos first.")
                c["photo"] = None
                photos_dropped += 1
        if existing is not None and p.on_duplicate == "merge":
            had_photo = len(existing.get("photo") or "")
            attach_groups(data, c)
            out = L.merge_into(existing, {**c, "id": existing["id"]}, cc)
            out["updated_at"] = _stamp(ctx)
            data["contacts"] = [out if x["id"] == existing["id"] else x for x in data["contacts"]]
            photo_room -= len(out.get("photo") or "") - had_photo
            for r in list(out["relationships"]):
                if r.get("contact_id") and r["contact_id"] != out["id"]:
                    L.link_both_ways(data, out, r["type"], r["contact_id"], r.get("label", ""))
            merged.append({"id": existing["id"], "name": L.display_name(out), "why": hit[1]})
            continue
        if len(data["contacts"]) >= 10_000:
            raise ActionError("That's the most contacts one file can hold (10,000).")
        attach_groups(data, c)
        c["id"] = L.new_id("c", taken, L.slug(L.display_name(c)) or "contact")
        taken.add(c["id"])
        if c["import_ref"]:
            refs.add(c["import_ref"])
        photo_room -= len(c.get("photo") or "")
        data["contacts"].append(c)
        for r in list(c["relationships"]):
            if r["contact_id"]:
                L.link_both_ways(data, c, r["type"], r["contact_id"], r.get("label", ""))
        added.append({"id": c["id"], "name": L.display_name(c)})
        if existing is not None:
            maybe.append({"new_id": c["id"], "existing_id": existing["id"], "name": L.display_name(existing), "why": hit[1]})
        elif (same := index.name_match(c)) is not None:
            other = next((x for x in data["contacts"] if x["id"] == same), None)
            if other is not None:
                maybe.append({"new_id": c["id"], "existing_id": same, "name": L.display_name(other), "why": "same name"})
    bits = []
    if added:
        bits.append(f"Added {added[0]['name']}" if len(added) == 1 else f"Added {len(added)} contacts")
    if merged:
        bits.append(f"merged {len(merged)} into existing contacts")
    if skipped:
        bits.append(f"skipped {len(skipped)} already there")
    if already:
        bits.append(f"{already} were already imported")
    if invalid:
        bits.append(f"left out {invalid} with no name, email or phone")
    if photos_dropped:
        bits.append(f"left out {photos_dropped} photos (no room left in this file)")
    summary = ", ".join(bits) or "Nothing new to add"
    return ActionOutcome(
        summary=summary[0].upper() + summary[1:],
        result={
            "added": added, "merged": merged, "skipped": skipped, "possible_duplicates": maybe, "invalid": invalid,
            "already_imported": already, "photos_left_out": photos_dropped,
        },
    )


_SCALAR_FIELDS = (
    "prefix", "first", "middle", "last", "suffix", "nickname", "pronouns", "phonetic_first", "phonetic_last",
    "company", "title", "department", "met_how", "met_where",
)


class UpdateContact(BaseModel):
    contact_id: str = Field(description="The contact's id (or exact name)")
    prefix: str | None = None
    first: str | None = None
    middle: str | None = None
    last: str | None = None
    suffix: str | None = None
    nickname: str | None = None
    pronouns: str | None = None
    phonetic_first: str | None = None
    phonetic_last: str | None = None
    company: str | None = None
    title: str | None = Field(default=None, description="Job title")
    department: str | None = None
    met_how: str | None = None
    met_where: str | None = None
    met_date: str | None = Field(default=None, description='YYYY-MM-DD; "" clears')
    birthday: str | None = Field(default=None, description='YYYY-MM-DD or --MM-DD; "" clears')
    notes: str | None = Field(default=None, description="Replaces the notes")
    append_note: str | None = Field(default=None, max_length=4000, description="Added to the end of the notes")
    favorite: bool | None = None
    color: str | None = Field(default=None, description="Avatar colour, #RRGGBB")
    phones: list[LabeledIn] | None = Field(default=None, description="Replaces all phones")
    emails: list[LabeledIn] | None = Field(default=None, description="Replaces all emails")
    websites: list[LabeledIn] | None = Field(default=None, description="Replaces all websites")
    addresses: list[Address] | None = Field(default=None, description="Replaces all addresses")
    add_phones: list[LabeledIn] = Field(default_factory=list, max_length=20)
    add_emails: list[LabeledIn] = Field(default_factory=list, max_length=20)
    add_websites: list[LabeledIn] = Field(default_factory=list, max_length=20)
    add_addresses: list[Address] = Field(default_factory=list, max_length=10)
    remove_values: list[str] = Field(default_factory=list, max_length=40, description="Phone numbers, emails or URLs to remove")
    remember: list[str] = Field(default_factory=list, max_length=50, description="Things to remember to add")
    gift_ideas: list[str] = Field(default_factory=list, max_length=50)
    topics: list[str] = Field(default_factory=list, max_length=50, description="Conversation topics / follow-ups to add")
    mark_done: list[str] = Field(default_factory=list, max_length=100, description="Ids of topics covered / gifts given")
    remove_notes: list[str] = Field(default_factory=list, max_length=100, description="Ids of remember / gift / topic entries to delete")


def update_contact(ctx: ItemContext, data: dict, p: UpdateContact) -> ActionOutcome:
    c = resolve(data, p.contact_id)
    today = ctx.today
    changed: list[str] = []
    for k in _SCALAR_FIELDS:
        v = getattr(p, k)
        if v is not None and v.strip() != c.get(k, ""):
            c[k] = v.strip()
            changed.append(k.replace("_", " "))
    if p.birthday is not None:
        c["birthday"] = _date_or_fail(p.birthday, today, "a birthday") if p.birthday.strip() else None
        changed.append("birthday")
    if p.met_date is not None:
        c["met_date"] = _date_or_fail(p.met_date, today, "a day", allow_no_year=False) if p.met_date.strip() else None
        changed.append("met date")
    if p.notes is not None:
        c["notes"] = p.notes
        changed.append("notes")
    if p.append_note:
        c["notes"] = (f"{c.get('notes', '').rstrip()}\n\n{p.append_note.strip()}" if c.get("notes") else p.append_note.strip())[:20_000]
        changed.append("notes")
    if p.favorite is not None and p.favorite != c.get("favorite"):
        c["favorite"] = p.favorite
        changed.append("favourite")
    if p.color is not None:
        import re

        if p.color and not re.fullmatch(HEX_RE, p.color):
            raise ActionError("Colours are #RRGGBB.")
        c["color"] = p.color or None
        changed.append("colour")
    for key, repl, add in (
        ("phones", p.phones, p.add_phones), ("emails", p.emails, p.add_emails), ("websites", p.websites, p.add_websites),
    ):
        if repl is not None:
            c[key] = [x.model_dump() for x in repl]
            changed.append(key)
        if add:
            have = {x["value"].casefold() for x in c[key]}
            new = [x.model_dump() for x in add if x.value.casefold() not in have]
            c[key] = (c[key] + new)[:20]
            if new:
                changed.append(key)
    if p.addresses is not None:
        c["addresses"] = [a.model_dump() for a in p.addresses]
        changed.append("addresses")
    if p.add_addresses:
        c["addresses"] = (c["addresses"] + [a.model_dump() for a in p.add_addresses])[:10]
        changed.append("addresses")
    if p.remove_values:
        gone = {v.strip().casefold() for v in p.remove_values}
        cc = country_of(data, ctx)
        gone_phones = {L.phone_key(v, cc) for v in p.remove_values if L.phone_key(v, cc)}
        for key in ("phones", "emails", "websites"):
            before = len(c[key])
            c[key] = [
                x for x in c[key]
                if x["value"].casefold() not in gone and not (key == "phones" and L.phone_key(x["value"], cc) in gone_phones)
            ]
            if len(c[key]) != before:
                changed.append(key)
    for key, texts, prefix in (("remember", p.remember, "m"), ("gifts", p.gift_ideas, "g"), ("topics", p.topics, "t")):
        new = _notes(texts, c.get(key, []), prefix, today)
        if new:
            c[key] = (c.get(key, []) + new)[:100]
            changed.append({"remember": "things to remember", "gifts": "gift ideas", "topics": "topics"}[key])
    if p.mark_done or p.remove_notes:
        done, gone_ids = set(p.mark_done), set(p.remove_notes)
        for key in ("remember", "gifts", "topics"):
            for n in c.get(key, []):
                if n["id"] in done and not n["done"]:
                    n["done"] = True
                    changed.append(key)
            before = len(c.get(key, []))
            c[key] = [n for n in c.get(key, []) if n["id"] not in gone_ids]
            if len(c[key]) != before:
                changed.append(key)
    if not changed:
        raise ActionError("Nothing to change — pass the fields to update.")
    _touch(c, ctx)
    what = ", ".join(dict.fromkeys(changed))
    return ActionOutcome(summary=f"Updated {L.display_name(c)} ({what})", result={"id": c["id"], "changed": list(dict.fromkeys(changed))})


class DeleteContacts(BaseModel):
    contact_ids: list[str] = Field(min_length=1, max_length=2000)


def delete_contact(ctx: ItemContext, data: dict, p: DeleteContacts) -> ActionOutcome:
    targets = resolve_many(data, p.contact_ids)
    removed = L.remove_contacts(data, {c["id"] for c in targets})
    names = [L.display_name(c) for c in removed]
    summary = f"Deleted {names[0]}" if len(names) == 1 else f"Deleted {len(names)} contacts"
    return ActionOutcome(summary=summary, result={"deleted": [c["id"] for c in removed]})


class MergeContacts(BaseModel):
    keep_id: str = Field(description="The contact to keep (its details win where both have one)")
    merge_ids: list[str] = Field(min_length=1, max_length=20, description="Contacts folded into it, then removed")


def _merge_targets(data: dict, p: MergeContacts) -> tuple[dict, list[dict]]:
    keep = resolve(data, p.keep_id)
    others = [c for c in resolve_many(data, p.merge_ids) if c["id"] != keep["id"]]
    if not others:
        raise ActionError("Pick at least one other contact to merge into this one.")
    return keep, others


def merge_contacts(ctx: ItemContext, data: dict, p: MergeContacts) -> ActionOutcome:
    keep, others = _merge_targets(data, p)
    merged = L.merge_contacts(data, keep["id"], [o["id"] for o in others], country_of(data, ctx))
    _touch(merged, ctx)
    n = len(others)
    return ActionOutcome(
        summary=f"Merged {n} contact{'s' if n != 1 else ''} into {L.display_name(merged)}",
        result={"id": merged["id"], "removed": [o["id"] for o in others]},
    )


def preview_merge(ctx: ItemContext, data: dict, p: MergeContacts) -> ActionOutcome:
    import copy

    keep, others = _merge_targets(data, p)
    trial = copy.deepcopy(data)
    merged = L.merge_contacts(trial, keep["id"], [o["id"] for o in others], country_of(data, ctx))
    return ActionOutcome(summary="", result={"merged": merged, "removed": [o["id"] for o in others]})


class FindDuplicates(BaseModel):
    strong_only: bool = Field(
        default=False,
        description="Only sets linked by the same email / full phone number / card (never just a name) — the safe ones to merge in bulk",
    )


def find_duplicates(ctx: ItemContext, data: dict, p: FindDuplicates) -> ActionOutcome:
    by_id = {c["id"]: c for c in data["contacts"]}
    groups = [
        {"reasons": g["reasons"], "strong": g["strong"], "contacts": [_brief(by_id[i], data, ctx.today) for i in g["ids"]]}
        for g in L.duplicate_groups(data, country_of(data, ctx), strong_only=p.strong_only)
    ]
    return ActionOutcome(summary="", result={"groups": groups[:100], "count": len(groups)})


# ----------------------------------------------------------- personal CRM


class LogInteraction(BaseModel):
    contact_ids: list[str] = Field(min_length=1, max_length=50, description="Everyone who was there")
    type: InteractionType = "other"
    date: str | None = Field(default=None, description="YYYY-MM-DD (or 'today' / 'yesterday'); default today")
    notes: str = Field(default="", max_length=4000, description="What you talked about, news, anything to follow up")
    follow_ups: list[str] = Field(default_factory=list, max_length=20, description="New topics to follow up next time")
    covered_topic_ids: list[str] = Field(default_factory=list, max_length=50, description="Topic ids now covered")


def log_interaction(ctx: ItemContext, data: dict, p: LogInteraction) -> ActionOutcome:
    today = ctx.today
    day = L.parse_day(p.date, today) if p.date else today.isoformat()
    if day is None:
        raise ActionError(f"I couldn't read {p.date!r} as a day — use YYYY-MM-DD.")
    if date.fromisoformat(day) > today:
        raise ActionError("That's in the future — log it once it's happened (or add a topic to remember).")
    people = resolve_many(data, p.contact_ids)
    out = []
    for c in people:
        ints = c.setdefault("interactions", [])
        if len(ints) >= 2000:
            ints.pop()  # the oldest (kept newest first)
        iid = L.new_id("i", [i["id"] for i in ints])
        ints.insert(0, {"id": iid, "date": day, "type": p.type, "notes": p.notes.strip()})
        ints.sort(key=lambda i: i["date"], reverse=True)
        c["snoozed_until"] = None
        covered = set(p.covered_topic_ids)
        for t in c.get("topics", []):
            if t["id"] in covered:
                t["done"] = True
        c["topics"] = (c.get("topics", []) + _notes(p.follow_ups, c.get("topics", []), "t", today))[:100]
        _touch(c, ctx)
        due = L.due_on(c, today)
        out.append({"id": c["id"], "interaction_id": iid, "next_due": due.isoformat() if due else None})
    names = [L.display_name(c) for c in people]
    who = names[0] if len(names) == 1 else (f"{', '.join(names[:-1])} and {names[-1]}" if len(names) <= 3 else f"{len(names)} people")
    verb = {"call": "a call", "message": "a message", "meeting": "a catch-up", "email": "an email", "other": "an interaction"}[p.type]
    return ActionOutcome(summary=f"Logged {verb} with {who}", result={"logged": out, "date": day})


class SetCadence(BaseModel):
    contact_ids: list[str] = Field(min_length=1, max_length=2000)
    every_days: int | None = Field(default=None, ge=1, le=730, description="Keep in touch every N days (7 weekly, 30 monthly, 90 quarterly)")
    clear: bool = Field(default=False, description="Stop keep-in-touch reminders for them")
    snooze_until: str | None = Field(default=None, description="YYYY-MM-DD: not due before this day")
    snooze_days: int | None = Field(default=None, ge=1, le=365, description="Or: snooze for N days from today")


def set_reminder_cadence(ctx: ItemContext, data: dict, p: SetCadence) -> ActionOutcome:
    if p.every_days is None and not p.clear and not p.snooze_until and not p.snooze_days:
        raise ActionError("Say how often (every_days), or clear / snooze.")
    today = ctx.today
    snooze = None
    if p.snooze_until:
        snooze = L.parse_day(p.snooze_until, today)
        if snooze is None:
            raise ActionError(f"I couldn't read {p.snooze_until!r} as a day.")
    elif p.snooze_days:
        snooze = (today + timedelta(days=p.snooze_days)).isoformat()
    people = resolve_many(data, p.contact_ids)
    for c in people:
        if p.clear:
            c["cadence_days"] = None
            c["snoozed_until"] = None
        elif p.every_days is not None:
            c["cadence_days"] = p.every_days
        if snooze and not p.clear:
            c["snoozed_until"] = snooze
        _touch(c, ctx)
    who = L.display_name(people[0]) if len(people) == 1 else f"{len(people)} people"
    if p.clear:
        summary = f"Stopped keep-in-touch reminders for {who}"
    elif p.every_days is not None:
        summary = f"Keep in touch with {who} every {p.every_days} days"
        if snooze:
            summary += f" (snoozed until {snooze})"
    else:
        summary = f"Snoozed {who} until {snooze}"
    result = [{"id": c["id"], "due_on": (d.isoformat() if (d := L.due_on(c, today)) else None)} for c in people]
    return ActionOutcome(summary=summary, result=result)


class AddDate(BaseModel):
    contact_id: str
    kind: Literal["birthday", "anniversary", "other"] = "other"
    date: str = Field(description="YYYY-MM-DD, or --MM-DD when the year isn't known")
    label: str = Field(default="", max_length=60, description='e.g. "Wedding anniversary", "Moved to Berlin"')
    remind: bool = True


def add_important_date(ctx: ItemContext, data: dict, p: AddDate) -> ActionOutcome:
    c = resolve(data, p.contact_id)
    d = _date_or_fail(p.date, ctx.today, "a date")
    name = L.display_name(c)
    if p.kind == "birthday":
        c["birthday"] = d
        _touch(c, ctx)
        return ActionOutcome(summary=f"Set {name}'s birthday", result={"id": c["id"], "birthday": d})
    label = p.label.strip() or ("Anniversary" if p.kind == "anniversary" else "Important date")
    for x in c.get("dates", []):
        if x["date"][-5:] == d[-5:] and L.fold(x["label"]) == L.fold(label):
            x.update({"date": d, "kind": p.kind, "remind": p.remind})
            _touch(c, ctx)
            return ActionOutcome(summary=f"Updated {name}'s {label.lower()}", result={"id": c["id"], "date_id": x["id"]})
    if len(c.get("dates", [])) >= 30:
        raise ActionError("That's the most dates one contact can hold (30).")
    did = L.new_id("d", [x["id"] for x in c.get("dates", [])])
    c.setdefault("dates", []).append({"id": did, "label": label, "date": d, "kind": p.kind, "remind": p.remind})
    _touch(c, ctx)
    return ActionOutcome(summary=f"Added {label.lower()} for {name}", result={"id": c["id"], "date_id": did})


class AddRelationship(BaseModel):
    contact_id: str = Field(description="Whose relationship this is")
    type: RelType = Field(description="What the other person is to them: their partner, child, parent…")
    other_contact_id: str | None = Field(default=None, description="When the other person is in the contacts")
    name: str = Field(default="", max_length=120, description="When they aren't (e.g. a child's name)")
    label: str = Field(default="", max_length=40, description='Refines the type ("cousin", "mentor", "step-son")')
    reciprocal: bool = Field(default=True, description="Also add the matching link on the other contact")


def add_relationship(ctx: ItemContext, data: dict, p: AddRelationship) -> ActionOutcome:
    c = resolve(data, p.contact_id)
    name = L.display_name(c)
    rel_word = p.label or p.type
    if p.other_contact_id:
        other = resolve(data, p.other_contact_id)
        if other["id"] == c["id"]:
            raise ActionError("Someone can't be related to themselves.")
        if p.reciprocal:
            changed = L.link_both_ways(data, c, p.type, other["id"], p.label)
        else:
            changed = not any(r.get("contact_id") == other["id"] and r["type"] == p.type for r in c["relationships"])
            if changed:
                rid = L.new_id("r", [r["id"] for r in c["relationships"]])
                c["relationships"].append({"id": rid, "type": p.type, "contact_id": other["id"], "name": "", "label": p.label})
        if not changed:
            raise ActionError(f"{L.display_name(other)} is already linked as {name}'s {p.type}.")
        _touch(c, ctx)
        _touch(other, ctx)
        return ActionOutcome(summary=f"{L.display_name(other)} is now {name}'s {rel_word}", result={"id": c["id"], "other_id": other["id"]})
    who = " ".join(p.name.split())
    if not who:
        raise ActionError("Give the other person's contact id or their name.")
    if any(L.fold(r.get("name", "")) == L.fold(who) and r["type"] == p.type for r in c["relationships"]):
        raise ActionError(f"{who} is already listed as {name}'s {p.type}.")
    if len(c["relationships"]) >= 50:
        raise ActionError("That's the most relationships one contact can hold (50).")
    rid = L.new_id("r", [r["id"] for r in c["relationships"]])
    c["relationships"].append({"id": rid, "type": p.type, "contact_id": None, "name": who, "label": p.label})
    _touch(c, ctx)
    return ActionOutcome(summary=f"Added {who} as {name}'s {rel_word}", result={"id": c["id"], "relationship_id": rid})


class TagContacts(BaseModel):
    contact_ids: list[str] = Field(min_length=1, max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    groups: list[str] = Field(default_factory=list, max_length=20, description="Group names (created if new when tagging)")


def tag_contacts(ctx: ItemContext, data: dict, p: TagContacts) -> ActionOutcome:
    tags = [t.strip()[:40] for t in p.tags if t.strip()]
    if not tags and not p.groups:
        raise ActionError("Give at least one tag or group.")
    people = resolve_many(data, p.contact_ids)
    gids = [gid for g in p.groups if (gid := group_id(data, g, create=True))]
    n = 0
    for c in people:
        before = (list(c["tags"]), list(c["groups"]))
        have = {t.casefold() for t in c["tags"]}
        c["tags"] = (c["tags"] + [t for t in tags if t.casefold() not in have])[:50]
        c["groups"] = (c["groups"] + [g for g in gids if g not in c["groups"]])[:50]
        if (c["tags"], c["groups"]) != before:
            n += 1
            _touch(c, ctx)
    labels = tags + [g["name"] for g in data["groups"] if g["id"] in gids]
    return ActionOutcome(summary=f"Tagged {n} contact{'s' if n != 1 else ''} {', '.join(labels)}", result={"changed": n, "group_ids": gids})


def untag_contacts(ctx: ItemContext, data: dict, p: TagContacts) -> ActionOutcome:
    if not p.tags and not p.groups:
        raise ActionError("Give at least one tag or group to remove.")
    people = resolve_many(data, p.contact_ids)
    gone_tags = {t.strip().casefold() for t in p.tags}
    gids = {gid for g in p.groups if (gid := group_id(data, g, create=False))}
    n = 0
    for c in people:
        before = (list(c["tags"]), list(c["groups"]))
        c["tags"] = [t for t in c["tags"] if t.casefold() not in gone_tags]
        c["groups"] = [g for g in c["groups"] if g not in gids]
        if (c["tags"], c["groups"]) != before:
            n += 1
            _touch(c, ctx)
    return ActionOutcome(summary=f"Removed tags from {n} contact{'s' if n != 1 else ''}", result={"changed": n})


class UpdateSettings(BaseModel):
    reminder_time: str | None = Field(default=None, description="HH:MM, local, for birthday/date reminders")
    birthday_reminders: bool | None = None
    birthday_days_before: int | None = Field(default=None, ge=0, le=30, description="Also remind N days before (0 = only on the day)")
    date_reminders: bool | None = None
    reconnect_digest: bool | None = Field(default=None, description="The weekly keep-in-touch digest")
    digest_weekday: int | None = Field(default=None, ge=0, le=6, description="Monday = 0 … Sunday = 6")
    name_order: Literal["first_last", "last_first"] | None = None
    sort_by: Literal["first", "last"] | None = None
    default_cadence_days: int | None = Field(default=None, ge=0, le=730, description="For new contacts; 0 = none")
    phone_country: str | None = Field(default=None, max_length=2, description='Two-letter country national phone numbers are read in ("AU", "GB"); "" = from their location')


def update_settings(ctx: ItemContext, data: dict, p: UpdateSettings) -> ActionOutcome:
    import re

    s = data["settings"]
    changed = []
    for k, v in p.model_dump(exclude_none=True).items():
        if k == "reminder_time" and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
            raise ActionError("Times are HH:MM (24-hour).")
        if k == "default_cadence_days":
            v = v or None
        if k == "phone_country":
            v = v.strip().upper()
            if v and v not in L.COUNTRIES:
                raise ActionError(f"I don't know the phone format for {v!r} — use one of {', '.join(sorted(L.COUNTRIES))}.")
        s[k] = v
        changed.append(k.replace("_", " "))
    if not changed:
        raise ActionError("Nothing to change.")
    return ActionOutcome(summary=f"Updated settings ({', '.join(changed)})", result=s)


# ------------------------------------------------------------- read-only


class FindContacts(BaseModel):
    query: str = Field(default="", max_length=200, description="Words to match across names, company, notes, tags, relationships…; typos are OK")
    tag: str | None = None
    group: str | None = Field(default=None, description="Group name or id")
    favorites_only: bool = False
    limit: int = Field(default=20, ge=1, le=100)


def find_contacts(ctx: ItemContext, data: dict, p: FindContacts) -> ActionOutcome:
    hits = L.search(data, p.query, tag=p.tag, group=p.group, favorites_only=p.favorites_only, limit=p.limit)
    return ActionOutcome(
        summary="",
        result={
            "count": len(hits),
            "contacts": [{**_brief(c, data, ctx.today), "matched": where} for c, _s, where in hits],
        },
    )


class UpcomingDates(BaseModel):
    days: int = Field(default=30, ge=1, le=366)


def upcoming_dates(ctx: ItemContext, data: dict, p: UpcomingDates) -> ActionOutcome:
    items = L.upcoming_dates(data, ctx.today, p.days)
    return ActionOutcome(summary="", result={"today": ctx.today.isoformat(), "dates": items[:200]})


class DueToReconnect(BaseModel):
    within_days: int = Field(default=0, ge=0, le=90, description="0 = due now; 7 = due within a week")


def due_to_reconnect(ctx: ItemContext, data: dict, p: DueToReconnect) -> ActionOutcome:
    items = L.reconnect_list(data, ctx.today, p.within_days)
    return ActionOutcome(summary="", result={"today": ctx.today.isoformat(), "count": len(items), "people": items[:200]})


class ContactBrief(BaseModel):
    contact_id: str


def contact_brief(ctx: ItemContext, data: dict, p: ContactBrief) -> ActionOutcome:
    """Everything worth knowing before you see them."""
    c = resolve(data, p.contact_id)
    today = ctx.today
    by_id = {x["id"]: x for x in data["contacts"]}
    groups = {g["id"]: g["name"] for g in data["groups"]}
    last = L.last_contacted(c)
    due = L.due_on(c, today)
    upcoming = L.upcoming_dates({**data, "contacts": [c]}, today, 60)
    out = {
        "id": c["id"],
        "name": L.display_name(c),
        "nickname": c.get("nickname") or None,
        "pronouns": c.get("pronouns") or None,
        "work": " · ".join(x for x in (c.get("title"), c.get("department"), c.get("company")) if x) or None,
        "age": L.age(c.get("birthday"), today),
        "birthday": c.get("birthday"),
        "how_we_met": " · ".join(x for x in (c.get("met_how"), c.get("met_where"), c.get("met_date")) if x) or None,
        "relationships": [
            {
                "type": r["type"], "label": r.get("label") or None,
                "name": L.display_name(by_id[r["contact_id"]]) if r.get("contact_id") in by_id else r.get("name"),
                "contact_id": r.get("contact_id"),
            }
            for r in c.get("relationships", [])
        ],
        "remember": [n["text"] for n in c.get("remember", [])],
        "open_topics": [{"id": n["id"], "text": n["text"]} for n in c.get("topics", []) if not n["done"]],
        "gift_ideas": [n["text"] for n in c.get("gifts", []) if not n["done"]],
        "gifts_given": [n["text"] for n in c.get("gifts", []) if n["done"]][:10],
        "recent_interactions": [
            {"date": i["date"], "type": i["type"], "notes": i.get("notes", "")[:600]} for i in c.get("interactions", [])[:5]
        ],
        "interactions_total": len(c.get("interactions", [])),
        "last_contacted": last,
        "days_since_contact": (today - date.fromisoformat(last)).days if last else None,
        "keep_in_touch_every_days": c.get("cadence_days"),
        "due_on": due.isoformat() if due else None,
        "upcoming_dates": upcoming,
        "tags": c.get("tags", []),
        "groups": [groups[g] for g in c.get("groups", []) if g in groups],
        "notes": (c.get("notes") or "")[:1500] or None,
    }
    return ActionOutcome(summary="", result={k: v for k, v in out.items() if v not in (None, [], "")})


# ------------------------------------------------------------------ list


ACTIONS = [
    ItemAction(
        "add_contacts",
        "Add one or many people (from pasted text, an email signature, a business card, a list). Fill only what's "
        "known; full_name is split for you. Check find_contacts first when they might already exist, or set "
        "on_duplicate to 'skip' / 'merge' (these only act on the same email, full phone number or vCard UID — a "
        "same-name match is reported in possible_duplicates, never merged).",
        AddContacts, add_contacts,
    ),
    ItemAction(
        "update_contact",
        "Change one contact: any name/work/how-we-met field, birthday, notes (replace or append), favourite, "
        "phones/emails/websites/addresses (replace, add, or remove by value), and add things to remember, gift "
        "ideas or follow-up topics (mark_done / remove_notes by id).",
        UpdateContact, update_contact,
    ),
    ItemAction("delete_contact", "Delete contacts (links to them stay as plain names). Only when clearly asked.", DeleteContacts, delete_contact),
    ItemAction(
        "merge_contacts",
        "Merge duplicate contacts into one (keep_id's details win; lists are combined; the others are removed and "
        "links are repointed). Use find_duplicates / preview_merge first and confirm with the person.",
        MergeContacts, merge_contacts,
    ),
    ItemAction("log_interaction", "Record a call, message, meeting or email with one or more people (resets their keep-in-touch clock). Past or today only.", LogInteraction, log_interaction),
    ItemAction(
        "set_reminder_cadence",
        "Set how often to keep in touch with people (every_days), stop it (clear), or snooze them (snooze_days / snooze_until).",
        SetCadence, set_reminder_cadence,
    ),
    ItemAction("add_important_date", "Add a birthday, anniversary or other date worth remembering for a contact (reminded on the day).", AddDate, add_important_date),
    ItemAction(
        "add_relationship",
        "Link a contact to someone: another contact (both sides get the link: partner↔partner, parent↔child, "
        "manager↔report) or a free-text name (\"daughter Mia\").",
        AddRelationship, add_relationship,
    ),
    ItemAction("tag_contacts", "Add tags and/or groups to many contacts at once (new groups are created).", TagContacts, tag_contacts),
    ItemAction("untag_contacts", "Remove tags and/or groups from many contacts at once.", TagContacts, untag_contacts),
    ItemAction("update_settings", "Change reminder and display preferences (reminder time, days-before for birthdays, weekly digest day, name order…).", UpdateSettings, update_settings),
    ItemAction("find_contacts", "Search people (fuzzy, typo-tolerant) across names, company, notes, tags, groups, relationships, things to remember. Returns ids.", FindContacts, find_contacts, writes=False),
    ItemAction("upcoming_dates", "Birthdays (with the age they turn) and important dates in the next N days, soonest first.", UpcomingDates, upcoming_dates, writes=False),
    ItemAction("due_to_reconnect", "Who is due (or overdue) a catch-up by their keep-in-touch rhythm, most urgent first.", DueToReconnect, due_to_reconnect, writes=False),
    ItemAction("contact_brief", "A pre-meeting brief on one person: work, family, things to remember, open follow-ups, recent interactions, upcoming dates.", ContactBrief, contact_brief, writes=False),
    ItemAction(
        "find_duplicates",
        "Groups of contacts that look like the same person (same email, same full phone number, same card, or same full "
        "name). A same-name-only set is just a maybe — check details before suggesting a merge. strong_only for bulk merges.",
        FindDuplicates, find_duplicates, writes=False,
    ),
    ItemAction("preview_merge", "What merge_contacts would produce, without changing anything.", MergeContacts, preview_merge, writes=False),
]

__all__ = ["ACTIONS", "INTERACTION_TYPES", "RECIPROCAL", "split_name"]
