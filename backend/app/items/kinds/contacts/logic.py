"""Contacts — the pure logic the actions, reminders and text share: names,
dates (next occurrence, age), the keep-in-touch rhythm, fuzzy search,
duplicate detection and merging. Plain dicts in, plain values out —
deterministic for (data, args, today)."""
from __future__ import annotations

import calendar
import hashlib
import re
import unicodedata
from datetime import date, timedelta
from typing import Any, Iterable

from .models import RECIPROCAL

# ------------------------------------------------------------------ names


def display_name(c: dict, order: str = "first_last") -> str:
    first = " ".join(x for x in (c.get("first", ""), c.get("middle", "")) if x)
    last = c.get("last", "")
    if order == "last_first" and first and last:
        name = f"{last}, {first}"
    else:
        name = " ".join(x for x in (first, last) if x)
    if c.get("suffix") and name:
        name = f"{name} {c['suffix']}"
    if name:
        return name
    for k in ("nickname", "company"):
        if c.get(k):
            return c[k]
    for k in ("emails", "phones"):
        if c.get(k):
            return c[k][0]["value"]
    return "No name"


def short_name(c: dict) -> str:
    return c.get("nickname") or c.get("first") or display_name(c)


def fold(s: str) -> str:
    """Lower-case, accents gone, punctuation to spaces."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).casefold()
    return " ".join(re.sub(r"[^\w@.+]+", " ", s).split())


def name_key(c: dict) -> str:
    """Normalised "first last" — only when both are there (a lone "Sam"
    isn't evidence of anything)."""
    if c.get("first") and c.get("last"):
        return fold(f"{c['first']} {c['last']}")
    return ""


# ------------------------------------------------------------- phones
#
# Numbers are compared as full international (E.164) numbers. A number
# written nationally ("0400 123 456") is read in the person's country —
# the file's ``settings.phone_country``, else the country in their Promptly
# location, else their time zone's, else Australia. Extensions are kept
# apart ("+61 2 9999 0000 ext 12" ≠ the switchboard).

# code: (calling code, national trunk prefix, names, time-zone prefixes)
COUNTRIES: dict[str, tuple[str, str, tuple[str, ...], tuple[str, ...]]] = {
    "AU": ("61", "0", ("australia",), ("Australia/",)),
    "NZ": ("64", "0", ("new zealand", "aotearoa"), ("Pacific/Auckland", "Pacific/Chatham", "NZ")),
    "GB": ("44", "0", ("united kingdom", "uk", "england", "scotland", "wales", "northern ireland", "great britain", "britain"), ("Europe/London", "GB")),
    "IE": ("353", "0", ("ireland",), ("Europe/Dublin",)),
    "CA": ("1", "1", ("canada",), ("America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg", "America/Halifax", "America/St_Johns", "America/Regina", "America/Montreal", "Canada/")),
    "US": ("1", "1", ("united states", "usa", "us", "america", "united states of america"), ("America/", "US/")),
    "IN": ("91", "0", ("india",), ("Asia/Kolkata", "Asia/Calcutta")),
    "SG": ("65", "", ("singapore",), ("Asia/Singapore",)),
    "MY": ("60", "0", ("malaysia",), ("Asia/Kuala_Lumpur",)),
    "PH": ("63", "0", ("philippines",), ("Asia/Manila",)),
    "ID": ("62", "0", ("indonesia",), ("Asia/Jakarta",)),
    "HK": ("852", "", ("hong kong",), ("Asia/Hong_Kong",)),
    "JP": ("81", "0", ("japan",), ("Asia/Tokyo",)),
    "KR": ("82", "0", ("south korea", "korea"), ("Asia/Seoul",)),
    "CN": ("86", "0", ("china",), ("Asia/Shanghai",)),
    "ZA": ("27", "0", ("south africa",), ("Africa/Johannesburg",)),
    "DE": ("49", "0", ("germany", "deutschland"), ("Europe/Berlin",)),
    "FR": ("33", "0", ("france",), ("Europe/Paris",)),
    "ES": ("34", "", ("spain", "españa"), ("Europe/Madrid",)),
    "IT": ("39", "", ("italy", "italia"), ("Europe/Rome",)),
    "NL": ("31", "0", ("netherlands", "holland"), ("Europe/Amsterdam",)),
    "BE": ("32", "0", ("belgium",), ("Europe/Brussels",)),
    "CH": ("41", "0", ("switzerland",), ("Europe/Zurich",)),
    "AT": ("43", "0", ("austria",), ("Europe/Vienna",)),
    "SE": ("46", "0", ("sweden",), ("Europe/Stockholm",)),
    "NO": ("47", "", ("norway",), ("Europe/Oslo",)),
    "DK": ("45", "", ("denmark",), ("Europe/Copenhagen",)),
    "FI": ("358", "0", ("finland",), ("Europe/Helsinki",)),
    "PL": ("48", "", ("poland",), ("Europe/Warsaw",)),
    "PT": ("351", "", ("portugal",), ("Europe/Lisbon",)),
    "BR": ("55", "0", ("brazil", "brasil"), ("America/Sao_Paulo",)),
    "MX": ("52", "", ("mexico",), ("America/Mexico_City",)),
    "AR": ("54", "0", ("argentina",), ("America/Argentina/",)),
    "AE": ("971", "0", ("united arab emirates", "uae"), ("Asia/Dubai",)),
    "IL": ("972", "0", ("israel",), ("Asia/Jerusalem",)),
}
DEFAULT_COUNTRY = "AU"


def country_from_location(location: str | None) -> str | None:
    """"Sydney, Australia" → "AU" (the last place-like word that names a country)."""
    loc = fold(location or "")
    if not loc:
        return None
    best: tuple[int, str] | None = None
    for code, (_cc, _t, names, _z) in COUNTRIES.items():
        for n in names:
            for m in re.finditer(rf"(?<![\w]){re.escape(n)}(?![\w])", loc):
                if best is None or m.start() > best[0]:
                    best = (m.start(), code)
    return best[1] if best else None


def country_from_tz(tz: str | None) -> str | None:
    if not tz:
        return None
    best: tuple[int, str] | None = None
    for code, (_cc, _t, _n, zones) in COUNTRIES.items():
        for z in zones:
            if tz == z or (z.endswith("/") and tz.startswith(z)):
                # The most specific prefix wins (America/Toronto beats America/).
                if best is None or len(z) > best[0]:
                    best = (len(z), code)
    return best[1] if best else None


def home_country(data: dict, user: Any = None, tz: Any = None) -> str:
    """The country national numbers are read in."""
    s = (data.get("settings") or {}).get("phone_country") or ""
    if s in COUNTRIES:
        return s
    loc = ((getattr(user, "settings", None) or {}) if user is not None else {}).get("location")
    return country_from_location(loc if isinstance(loc, str) else None) or country_from_tz(str(tz) if tz else None) or DEFAULT_COUNTRY


_EXT_RE = re.compile(r"(?i)\s*(?:;\s*ext\s*=\s*|(?<![a-z])ext(?:ension)?\.?\s*:?\s*|(?<![a-z])x\.?\s*|#\s*|[,;]\s*)(\d{1,8})\s*$")


def phone_parts(value: str, country: str = DEFAULT_COUNTRY) -> tuple[str, str]:
    """``(+E164, extension)``; the number is "" when it can't be read as a
    full number (too short, a local number without an area code)."""
    s = (value or "").strip()
    s = re.sub(r"(?i)^tel:", "", s)
    ext = ""
    m = _EXT_RE.search(s)
    if m and re.search(r"\d", s[: m.start()]):
        ext, s = m.group(1), s[: m.start()]
    digits = re.sub(r"\D", "", s)
    if not digits:
        return "", ext
    cc, trunk, _n, _z = COUNTRIES.get(country, COUNTRIES[DEFAULT_COUNTRY])
    if s.lstrip().startswith("+"):
        full = digits
    elif digits.startswith("00"):
        full = digits[2:]
    elif cc == "1" and digits.startswith("011"):
        full = digits[3:]
    else:
        if trunk and digits.startswith(trunk):
            nsn = digits[len(trunk):]
        elif trunk == "0" and len(digits) < 9:
            return "", ext  # "9999 0000": no area code, so not comparable
        else:
            nsn = digits
        full = cc + nsn
    if not 10 <= len(full) <= 15:
        return "", ext
    return "+" + full, ext


def phone_key(value: str, country: str = DEFAULT_COUNTRY) -> str:
    """The full number (+ extension) two contacts must share to be the same."""
    num, ext = phone_parts(value, country)
    if not num:
        return ""
    return f"{num}x{ext}" if ext else num


def email_key(value: str) -> str:
    v = (value or "").strip().casefold()
    return v if "@" in v else ""


# ------------------------------------------------------------------ ids


def slug(s: str, limit: int = 24) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", fold(s)).strip("-")
    return out[:limit].strip("-")


def new_id(prefix: str, taken: Iterable[str], base: str = "") -> str:
    """``prefix-base`` (or ``prefix1``…) not already taken. Deterministic."""
    used = set(taken)
    stem = f"{prefix}-{base}" if base else prefix
    if base and stem not in used:
        return stem[:40]
    n = 1 if not base else 2
    while f"{stem}{'-' if base else ''}{n}"[:40] in used:
        n += 1
    return f"{stem}{'-' if base else ''}{n}"[:40]


def hashed_id(prefix: str, *parts: Any) -> str:
    h = hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:8]
    return f"{prefix}{h}"


# ------------------------------------------------------------------ dates

_MONTHS = {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
_MONTHS.update({m.lower(): i for i, m in enumerate(calendar.month_abbr) if m})
_MONTHS["sept"] = 9


def parse_date_flexible(s: str | None, today: date | None = None) -> str | None:
    """A date as people and other apps write it → ``YYYY-MM-DD`` or
    ``--MM-DD`` (no year). None when it can't be read.

    Takes ISO days, ``--MMDD`` / ``--MM-DD``, ``YYYYMMDD``, ``MM-DD``,
    "3 March 1990", "March 3, 1990", "3 Mar", "today", "yesterday"."""
    from .models import valid_date

    if s is None:
        return None
    raw = str(s).strip()
    if not raw:
        return None
    low = raw.lower()
    if today is not None and low in ("today", "yesterday"):
        return (today - timedelta(days=1 if low == "yesterday" else 0)).isoformat()
    low = low.split("t")[0] if re.match(r"^\d{4}-?\d{2}-?\d{2}t", low) else low
    cand: str | None = None
    if m := re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", low):
        y, mo, d = m.groups()
        cand = f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
        if y in ("1604", "0000"):  # Apple's / some exporters' "no year"
            cand = f"--{int(mo):02d}-{int(d):02d}"
    elif m := re.fullmatch(r"(\d{4})(\d{2})(\d{2})", low):
        y, mo, d = m.groups()
        cand = f"--{mo}-{d}" if y in ("1604", "0000") else f"{y}-{mo}-{d}"
    elif m := re.fullmatch(r"--(\d{2})-?(\d{2})", low):
        cand = f"--{m.group(1)}-{m.group(2)}"
    elif m := re.fullmatch(r"(\d{1,2})-(\d{1,2})", low):
        cand = f"--{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    else:
        words = re.findall(r"[a-z]+|\d+", low)
        month = next((_MONTHS[w] for w in words if w in _MONTHS), None)
        nums = [w for w in words if w.isdigit()]
        if month and nums:
            day_s = next((n for n in nums if len(n) <= 2), None)
            year_s = next((n for n in nums if len(n) == 4), None)
            if day_s:
                cand = f"{year_s}-{month:02d}-{int(day_s):02d}" if year_s else f"--{month:02d}-{int(day_s):02d}"
    return cand if cand and valid_date(cand) else None


def parse_day(s: str | None, today: date) -> str | None:
    """A full calendar day (no year-less forms)."""
    v = parse_date_flexible(s, today)
    return v if v and not v.startswith("--") else None


def month_day(s: str) -> tuple[int | None, int, int]:
    if s.startswith("--"):
        return None, int(s[2:4]), int(s[5:7])
    return int(s[:4]), int(s[5:7]), int(s[8:10])


def _on(year: int, month: int, day: int) -> date:
    if month == 2 and day == 29 and not calendar.isleap(year):
        return date(year, 2, 28)
    return date(year, month, day)


def next_occurrence(s: str, today: date) -> date:
    """The next time this month/day comes round (today counts)."""
    _y, m, d = month_day(s)
    occ = _on(today.year, m, d)
    if occ < today:
        occ = _on(today.year + 1, m, d)
    return occ


def years_on(s: str, occ: date) -> int | None:
    """Age they turn / years since, on ``occ``."""
    y, _m, _d = month_day(s)
    if y is None or y > occ.year:
        return None
    return occ.year - y


def age(birthday: str | None, today: date) -> int | None:
    if not birthday:
        return None
    y, m, d = month_day(birthday)
    if y is None or y > today.year:
        return None
    return today.year - y - (0 if today >= _on(today.year, m, d) else 1)


def upcoming_dates(data: dict, today: date, days: int, *, birthdays: bool = True, others: bool = True) -> list[dict]:
    """Birthdays and important dates in the next ``days`` (today included),
    soonest first."""
    order = data.get("settings", {}).get("name_order", "first_last")
    out: list[dict] = []
    end = today + timedelta(days=days)
    for c in data.get("contacts", []):
        name = display_name(c, order)
        if birthdays and c.get("birthday"):
            occ = next_occurrence(c["birthday"], today)
            if occ <= end:
                out.append(
                    {
                        "contact_id": c["id"], "name": name, "kind": "birthday", "label": "Birthday",
                        "date": occ.isoformat(), "in_days": (occ - today).days,
                        "turns": years_on(c["birthday"], occ), "date_id": None,
                    }
                )
        if others:
            for d in c.get("dates", []):
                occ = next_occurrence(d["date"], today)
                if occ <= end:
                    out.append(
                        {
                            "contact_id": c["id"], "name": name, "kind": d.get("kind", "other"),
                            "label": d.get("label") or ("Anniversary" if d.get("kind") == "anniversary" else "Date"),
                            "date": occ.isoformat(), "in_days": (occ - today).days,
                            "years": years_on(d["date"], occ), "date_id": d["id"], "remind": d.get("remind", True),
                        }
                    )
    out.sort(key=lambda e: (e["date"], e["name"].casefold()))
    return out


# ------------------------------------------------------------ keep in touch


def last_contacted(c: dict) -> str | None:
    days = [i["date"] for i in c.get("interactions", []) if i.get("date")]
    return max(days) if days else None


def due_on(c: dict, today: date) -> date | None:
    """When they're next due a catch-up (None: no rhythm set). Never
    contacted = due now."""
    every = c.get("cadence_days")
    if not every:
        return None
    last = last_contacted(c)
    due = date.fromisoformat(last) + timedelta(days=every) if last else today
    snooze = c.get("snoozed_until")
    if snooze and date.fromisoformat(snooze) > due:
        due = date.fromisoformat(snooze)
    return due


def reconnect_list(data: dict, today: date, within_days: int = 0) -> list[dict]:
    order = data.get("settings", {}).get("name_order", "first_last")
    out = []
    horizon = today + timedelta(days=within_days)
    for c in data.get("contacts", []):
        due = due_on(c, today)
        if due is None or due > horizon:
            continue
        last = last_contacted(c)
        out.append(
            {
                "contact_id": c["id"],
                "name": display_name(c, order),
                "every_days": c["cadence_days"],
                "last_contacted": last,
                "days_since": (today - date.fromisoformat(last)).days if last else None,
                "due_on": due.isoformat(),
                "overdue_days": max(0, (today - due).days),
                "favorite": bool(c.get("favorite")),
            }
        )
    out.sort(key=lambda e: (e["due_on"], not e["favorite"], e["name"].casefold()))
    return out


# ----------------------------------------------------------------- search


def _lev1(a: str, b: str, limit: int) -> bool:
    """Edit distance (with transpositions) ≤ ``limit``."""
    if abs(len(a) - len(b)) > limit:
        return False
    prev2: list[int] | None = None
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            if prev2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > limit:
            return False
        prev2, prev = prev, cur
    return prev[-1] <= limit


def _fields(c: dict, data: dict) -> list[tuple[float, str, str]]:
    """(weight, field name, folded text) for search."""
    groups = {g["id"]: g["name"] for g in data.get("groups", [])}
    out: list[tuple[float, str, str]] = [
        (3.0, "name", fold(" ".join(c.get(k, "") for k in ("prefix", "first", "middle", "last", "suffix")))),
        (3.0, "nickname", fold(c.get("nickname", ""))),
        (1.5, "phonetic", fold(f"{c.get('phonetic_first', '')} {c.get('phonetic_last', '')}")),
        (2.0, "company", fold(f"{c.get('company', '')} {c.get('department', '')}")),
        (1.5, "title", fold(c.get("title", ""))),
        (2.0, "tags", fold(" ".join(c.get("tags", [])))),
        (2.0, "groups", fold(" ".join(groups.get(g, "") for g in c.get("groups", [])))),
        (2.0, "email", fold(" ".join(e["value"] for e in c.get("emails", [])))),
        (1.0, "address", fold(" ".join(" ".join((a.get("street", ""), a.get("city", ""), a.get("region", ""), a.get("country", ""))) for a in c.get("addresses", [])))),
        (1.0, "met", fold(f"{c.get('met_how', '')} {c.get('met_where', '')}")),
        (1.0, "notes", fold(c.get("notes", ""))),
        (1.0, "remember", fold(" ".join(n["text"] for n in c.get("remember", [])))),
        (0.8, "topics", fold(" ".join(n["text"] for n in c.get("topics", [])))),
        (0.8, "gifts", fold(" ".join(n["text"] for n in c.get("gifts", [])))),
        (0.6, "interactions", fold(" ".join(i.get("notes", "") for i in c.get("interactions", [])[:50]))),
        (0.5, "websites", fold(" ".join(w["value"] for w in c.get("websites", [])))),
    ]
    return [f for f in out if f[2]]


def _relationship_text(c: dict, by_id: dict[str, dict]) -> str:
    bits = []
    for r in c.get("relationships", []):
        other = by_id.get(r.get("contact_id") or "")
        bits.append(f"{r.get('type', '')} {r.get('label', '')} {display_name(other) if other else r.get('name', '')}")
    return fold(" ".join(bits))


def match_score(c: dict, query: str, data: dict, by_id: dict[str, dict] | None = None) -> tuple[float, list[str]]:
    """(score, matched field names); 0 when a query word matches nothing."""
    tokens = fold(query).split()
    if not tokens:
        return 1.0, []
    phones_raw = [re.sub(r"\D", "", p["value"]) for p in c.get("phones", [])]
    if not re.search(r"[^\d\s()+.-]", query):
        # A number: match it against phones, ignoring spaces, +country and a trunk 0.
        qd = re.sub(r"\D", "", query)
        if len(qd) >= 3:
            forms = {qd, qd.lstrip("0")} - {""}
            return (3.0, ["phone"]) if any(f in p for f in forms for p in phones_raw) else (0.0, [])
    by_id = by_id if by_id is not None else {x["id"]: x for x in data.get("contacts", [])}
    fields = _fields(c, data)
    rel = _relationship_text(c, by_id)
    if rel:
        fields.append((1.5, "relationships", rel))
    phones = phones_raw
    total = 0.0
    hit: set[str] = set()
    for t in tokens:
        best, where = 0.0, ""
        t_digits = re.sub(r"\D", "", t)
        if len(t_digits) >= 3 and len(t_digits) >= len(t) - 1:
            if any(t_digits in p or (p and t_digits.lstrip("0") and t_digits.lstrip("0") in p) for p in phones):
                best, where = 3.0, "phone"
        for weight, name, text in fields:
            words = text.split()
            if t in words:
                s = 3.0
            elif any(w.startswith(t) for w in words):
                s = 2.0
            elif len(t) >= 3 and t in text:
                s = 1.0
            elif len(t) >= 4 and any(_lev1(t, w[: len(t) + 1] if len(w) > len(t) + 1 else w, 1 if len(t) < 7 else 2) for w in words):
                s = 0.6
            else:
                continue
            if s * weight > best:
                best, where = s * weight, name
        if best == 0:
            return 0.0, []
        total += best
        hit.add(where)
    if c.get("favorite"):
        total += 0.25
    return total, sorted(hit)


def search(data: dict, query: str, *, tag: str | None = None, group: str | None = None,
           favorites_only: bool = False, limit: int = 20) -> list[tuple[dict, float, list[str]]]:
    groups = {g["id"]: g for g in data.get("groups", [])}
    gid = None
    if group:
        gid = next((g["id"] for g in groups.values() if g["id"] == group or fold(g["name"]) == fold(group)), "__none__")
    by_id = {x["id"]: x for x in data.get("contacts", [])}
    out = []
    for c in data.get("contacts", []):
        if favorites_only and not c.get("favorite"):
            continue
        if tag and fold(tag) not in {fold(t) for t in c.get("tags", [])}:
            continue
        if gid and gid not in c.get("groups", []):
            continue
        score, where = match_score(c, query, data, by_id)
        if score > 0:
            out.append((c, score, where))
    out.sort(key=lambda x: (-x[1], display_name(x[0]).casefold()))
    return out[:limit]


# ------------------------------------------------------------- duplicates

# A phone number or email on more than this many contacts is a shared one
# (a family landline, an office switchboard, info@…) — it says nothing about
# who is who.
SHARED_AT = 3


def _pair(a: str, b: str) -> str:
    return "|".join(sorted((a, b)))


def uid_keys(c: dict) -> set[str]:
    """What a vCard UID names: the source app's UID, and — for cards this
    app exported (``promptly-<id>``) — the contact itself."""
    out = set()
    uid = (c.get("uid") or "").strip()
    if uid:
        out.add(f"u:{uid.casefold()}")
    if c.get("id"):
        out.add(f"u:promptly-{c['id']}".casefold())
    return out


def strong_keys(c: dict, country: str = DEFAULT_COUNTRY) -> set[str]:
    """Keys that only the same person shares: an email, a full phone number."""
    keys = {f"e:{k}" for e in c.get("emails", []) if (k := email_key(e["value"]))}
    keys |= {f"p:{k}" for p in c.get("phones", []) if (k := phone_key(p["value"], country))}
    return keys


def duplicate_groups(data: dict, country: str = DEFAULT_COUNTRY, *, strong_only: bool = False) -> list[dict]:
    """Sets of contacts that look like the same person: a shared email or
    full phone number, or (unless ``strong_only``) the same first + last
    name. Numbers/emails on more than two people are shared ones and are
    ignored; pairs the person ruled out are skipped. ``strong`` on a group
    means every link in it is an email / phone (safe for "merge all")."""
    contacts = data.get("contacts", [])
    ruled_out = set(data.get("settings", {}).get("not_duplicates", []))
    buckets: dict[str, list[str]] = {}
    for c in contacts:
        keys = set(strong_keys(c, country))
        if (c.get("uid") or "").strip():
            keys.add(f"u:{c['uid'].strip().casefold()}")
        if not strong_only and (nk := name_key(c)):
            keys.add(f"n:{nk}")
        for k in keys:
            buckets.setdefault(k, []).append(c["id"])
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    reasons: dict[str, set[str]] = {}
    for key, ids in buckets.items():
        kind = key.split(":", 1)[0]
        cap = SHARED_AT - 1 if kind in ("e", "p") else 10
        if len(ids) < 2 or len(ids) > cap:
            continue
        why = {"e": "same email", "p": "same phone", "n": "same name", "u": "same card"}[kind]
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if _pair(a, b) in ruled_out:
                    continue
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[ra] = rb
                reasons.setdefault(_pair(a, b), set()).add(why)
    clusters: dict[str, list[str]] = {}
    for c in contacts:
        if c["id"] in parent:
            clusters.setdefault(find(c["id"]), []).append(c["id"])
    out = []
    for ids in clusters.values():
        if len(ids) < 2:
            continue
        why: set[str] = set()
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                why |= reasons.get(_pair(a, b), set())
        out.append({"ids": ids, "reasons": sorted(why), "strong": "same name" not in why})
    return out


class DupeIndex:
    """Who in the book has which email / full phone number / card UID — so
    an import of thousands checks each newcomer in O(1). Only the contacts
    already there are indexed (people in one import are never matched with
    each other), and numbers/emails shared by more than two contacts are
    ignored. Names are kept apart: a same-name hit is only ever a "maybe"."""

    def __init__(self, contacts: list[dict], country: str = DEFAULT_COUNTRY):
        self.country = country
        owners: dict[str, list[str]] = {}
        self.names: dict[str, str] = {}
        for c in contacts:
            for k in strong_keys(c, country) | uid_keys(c):
                owners.setdefault(k, []).append(c["id"])
            if nk := name_key(c):
                self.names.setdefault(nk, c["id"])
        self.keys = {k: ids[0] for k, ids in owners.items() if len(set(ids)) < SHARED_AT or k.startswith("u:")}

    def match(self, cand: dict) -> tuple[str, str] | None:
        """(contact id, why) of the existing contact that is surely ``cand``."""
        uid = (cand.get("uid") or "").strip()
        if uid and (hit := self.keys.get(f"u:{uid.casefold()}")):
            return hit, "same card"
        for k in sorted(strong_keys(cand, self.country)):
            if k in self.keys:
                return self.keys[k], "same email" if k.startswith("e:") else "same phone"
        return None

    def name_match(self, cand: dict) -> str | None:
        nk = name_key(cand)
        return self.names.get(nk) if nk else None


def strong_match(data: dict, cand: dict, country: str = DEFAULT_COUNTRY) -> dict | None:
    """An existing contact that's surely ``cand``: a shared card UID, email
    or full phone number."""
    hit = DupeIndex(data.get("contacts", []), country).match(cand)
    return next((c for c in data.get("contacts", []) if c["id"] == hit[0]), None) if hit else None


# ------------------------------------------------------------------ merge


def _union(a: list, b: list, key) -> list:  # noqa: ANN001
    seen = {key(x) for x in a}
    out = list(a)
    for x in b:
        k = key(x)
        if k not in seen:
            seen.add(k)
            out.append(x)
    return out


def _renumbered(existing: list[dict], extra: list[dict], prefix: str) -> list[dict]:
    """``extra`` with ids that don't collide with ``existing`` (nor each other)."""
    taken = {x["id"] for x in existing}
    out = []
    for x in extra:
        y = dict(x)
        if y["id"] in taken:
            y["id"] = new_id(prefix, taken)
        taken.add(y["id"])
        out.append(y)
    return out


_SCALARS = (
    "prefix", "first", "middle", "last", "suffix", "nickname", "pronouns", "phonetic_first", "phonetic_last",
    "company", "title", "department", "birthday", "met_how", "met_where", "met_date", "color", "snoozed_until",
    "photo", "uid", "promptly_user_id", "promptly_username",
)


def merge_into(keep: dict, other: dict, country: str = DEFAULT_COUNTRY) -> dict:
    """``other``'s details folded into a copy of ``keep``: empty fields are
    filled, lists are joined without repeats (ids renumbered so none
    collide), notes are kept side by side."""
    import copy

    out = copy.deepcopy(keep)
    for k in _SCALARS:
        if not out.get(k) and other.get(k):
            out[k] = other[k]
    out["phones"] = _union(out.get("phones", []), other.get("phones", []), lambda p: phone_key(p["value"], country) or p["value"])[:20]
    out["emails"] = _union(out.get("emails", []), other.get("emails", []), lambda e: e["value"].casefold())[:20]
    out["websites"] = _union(out.get("websites", []), other.get("websites", []), lambda w: w["value"].casefold().rstrip("/"))[:20]
    out["addresses"] = _union(
        out.get("addresses", []), other.get("addresses", []), lambda a: fold(f"{a.get('street', '')} {a.get('city', '')}")
    )[:10]
    have_dates = out.get("dates", [])
    date_key = lambda d: (d["date"][-5:], fold(d.get("label", "")))  # noqa: E731
    seen = {date_key(d) for d in have_dates}
    new_dates = [d for d in other.get("dates", []) if date_key(d) not in seen]
    out["dates"] = (have_dates + _renumbered(have_dates, new_dates, "d"))[:30]
    have_rels = out.get("relationships", [])
    rel_key = lambda r: (r["type"], r.get("contact_id") or fold(r.get("name", "")))  # noqa: E731
    seen_r = {rel_key(r) for r in have_rels}
    new_rels = []
    for r in other.get("relationships", []):
        if rel_key(r) not in seen_r:
            seen_r.add(rel_key(r))
            new_rels.append(r)
    out["relationships"] = (have_rels + _renumbered(have_rels, new_rels, "r"))[:50]
    out["tags"] = _union(out.get("tags", []), other.get("tags", []), lambda t: t.casefold())[:50]
    out["groups"] = _union(out.get("groups", []), other.get("groups", []), lambda g: g)[:50]
    merged_ints = list(out.get("interactions", [])) + _renumbered(out.get("interactions", []), other.get("interactions", []), "i")
    out["interactions"] = sorted(merged_ints, key=lambda i: i["date"], reverse=True)[:2000]
    for k, cap in (("gifts", 100), ("remember", 100), ("topics", 100)):
        have = out.get(k, [])
        texts = {fold(x["text"]) for x in have}
        extra = []
        for n in other.get(k, []):
            if fold(n["text"]) not in texts:
                texts.add(fold(n["text"]))
                extra.append(n)
        out[k] = (have + _renumbered(have, extra, k[0]))[:cap]
    a, b = (out.get("notes") or "").strip(), (other.get("notes") or "").strip()
    if b and b not in a:
        out["notes"] = (f"{a}\n\n{b}" if a else b)[:20_000]
    out["favorite"] = bool(out.get("favorite") or other.get("favorite"))
    cad = [x for x in (out.get("cadence_days"), other.get("cadence_days")) if x]
    out["cadence_days"] = min(cad) if cad else None
    created = [x for x in (out.get("created_at"), other.get("created_at")) if x]
    out["created_at"] = min(created) if created else ""
    return out


def merge_contacts(data: dict, keep_id: str, merge_ids: list[str], country: str = DEFAULT_COUNTRY) -> dict:
    """Merge (in place) and repoint everyone's links. Returns the kept contact."""
    by_id = {c["id"]: c for c in data["contacts"]}
    keep = by_id[keep_id]
    merged = keep
    for mid in merge_ids:
        merged = merge_into(merged, by_id[mid], country)
    gone = set(merge_ids)
    merged["relationships"] = [r for r in merged.get("relationships", []) if r.get("contact_id") not in gone | {keep_id}]
    data["contacts"] = [merged if c["id"] == keep_id else c for c in data["contacts"] if c["id"] not in gone]
    for c in data["contacts"]:
        rels = []
        seen = set()
        for r in c.get("relationships", []):
            if r.get("contact_id") in gone:
                r = {**r, "contact_id": keep_id}
            if r.get("contact_id") == c["id"]:
                continue
            k = (r["type"], r.get("contact_id") or fold(r.get("name", "")))
            if k in seen:
                continue
            seen.add(k)
            rels.append(r)
        c["relationships"] = rels
    pairs = data.get("settings", {}).get("not_duplicates", [])
    if pairs:
        data["settings"]["not_duplicates"] = [p for p in pairs if not (set(p.split("|")) & gone)]
    return merged


def remove_contacts(data: dict, ids: set[str]) -> list[dict]:
    """Remove (in place); links to them become plain names. Returns them."""
    removed = [c for c in data["contacts"] if c["id"] in ids]
    names = {c["id"]: display_name(c) for c in removed}
    data["contacts"] = [c for c in data["contacts"] if c["id"] not in ids]
    for c in data["contacts"]:
        for r in c.get("relationships", []):
            if r.get("contact_id") in ids:
                r["name"] = r.get("name") or names[r["contact_id"]]
                r["contact_id"] = None
    pairs = data.get("settings", {}).get("not_duplicates", [])
    if pairs:
        data["settings"]["not_duplicates"] = [p for p in pairs if not (set(p.split("|")) & ids)]
    return removed


def link_both_ways(data: dict, a: dict, rel_type: str, b_id: str, label: str = "") -> bool:
    """Contact ``b_id`` is ``a``'s ``rel_type`` ("a's partner is b"), and
    ``b`` gets the reciprocal link. Returns whether anything changed."""
    by_id = {c["id"]: c for c in data["contacts"]}
    b = by_id[b_id]
    changed = False
    for owner, typ, target in ((a, rel_type, b_id), (b, RECIPROCAL.get(rel_type, "other"), a["id"])):
        if any(r.get("contact_id") == target and r["type"] == typ for r in owner.get("relationships", [])):
            continue
        rid = new_id("r", [r["id"] for r in owner.get("relationships", [])])
        owner.setdefault("relationships", []).append(
            {"id": rid, "type": typ, "contact_id": target, "name": "", "label": label if owner is a else ""}
        )
        changed = True
    return changed
