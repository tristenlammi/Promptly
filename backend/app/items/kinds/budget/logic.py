"""Budget arithmetic: payees, months (with payday month starts), what was
spent and assigned per category, rollover, "to be budgeted", rules,
summaries and forecasts. Pure functions over the file's dict — the actions,
the text, reminders and tests all go through these, so a number the AI
quotes is the number the app shows."""
from __future__ import annotations

import calendar
import hashlib
import re
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Iterable

# ------------------------------------------------------------------ money


def fmt(cents: int, currency: str = "AUD") -> str:
    sign = "-" if cents < 0 else ""
    c = abs(int(cents))
    sym = {"AUD": "$", "NZD": "NZ$", "USD": "US$", "GBP": "£", "EUR": "€"}.get(currency.upper(), currency.upper() + " ")
    return f"{sign}{sym}{c // 100:,}.{c % 100:02d}"


def to_cents(amount: float | int | str) -> int:
    """Dollars (``12.5``, ``"-1,234.56"``) → cents, rounding half away from zero."""
    if isinstance(amount, str):
        s = amount.strip().replace(",", "").replace("$", "")
        neg = s.startswith("(") and s.endswith(")")
        s = s.strip("()")
        v = float(s)
        if neg:
            v = -v
    else:
        v = float(amount)
    return int(round(v * 100 + (1e-9 if v >= 0 else -1e-9)))


def short_hash(*parts: Any, n: int = 10) -> str:
    h = hashlib.sha1("\x1f".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return h[:n]


def slug(text: str, n: int = 30) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (text or "").lower()).strip("_")
    return s[:n] or "x"


def unique_id(base: str, taken: Iterable[str]) -> str:
    used = set(taken)
    if base not in used:
        return base
    i = 2
    while f"{base}{i}" in used:
        i += 1
    return f"{base}{i}"


# ----------------------------------------------------------------- payees

_PREFIXES = re.compile(
    r"^(?:(?:visa|eftpos|mastercard|mc|debit|credit|card|pos|purchase|purchased|payment|pymt|direct debit|dd|"
    r"recurring|osko|bpay|apple pay|google pay|contactless|tap|international|intl|aud|"
    r"value date:?|ref:?)(?:[\s:\-]+|$))+",
    re.I,
)
# Payment processors' "SQ *SHOP" style prefixes.
_STAR_PREFIX = re.compile(r"^(?:sq|sp|pp|paypal|zlr|lsp|ezi|tst|gpay|wpy|pos)\s*\*\s*", re.I)
_NOISE = [
    re.compile(r"\b(?:card|crd)\s*(?:no\.?)?\s*x*\d{3,}\b", re.I),
    re.compile(r"\bx{2,}\d{2,}\b", re.I),
    re.compile(r"\b\d{2}[/\-.]\d{2}(?:[/\-.]\d{2,4})?\b"),  # dates
    re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b"),  # times
    re.compile(r"\b(?:ref|receipt|rcpt|txn|id|inv|invoice)\s*[:#]?\s*\w*\d\w*\b", re.I),
    re.compile(r"(?<![\w-])\d{3,}(?![\w-])"),  # bare numbers: card digits, store/terminal ids
    re.compile(r"\s+(?:aus|au|aust|australia)$", re.I),
    re.compile(r"\s+(?:nsw|vic|qld|wa|sa|tas|act|nt)$", re.I),
    re.compile(r"\s+(?:aus|au|aust|australia)$", re.I),
    re.compile(r"\s+(?:pty\.?\s*ltd\.?|ltd\.?|limited|inc\.?|llc)$", re.I),
]
_ACRONYMS = {"AGL", "KFC", "TPG", "BP", "IGA", "JB", "HCF", "NIB", "AHM", "AAMI", "NRMA", "RACV", "RACQ", "BWS", "ATO",
             "CBA", "NAB", "ANZ", "HSBC", "ING", "AMP", "IKEA", "UNSW", "UTS", "RSL", "TAB", "NBN", "MLC", "QBE", "GIO",
             "ABC", "SBS", "AFL", "NRL", "BCF", "HBF", "RAA", "RAC", "UPS", "DHL", "TNT", "EB", "LG", "HP", "XL", "GYG"}
_SMALL = {"and", "of", "the", "for", "to", "at", "on", "in", "by", "de", "la"}


def clean_payee(text: str) -> str:
    """A bank's raw line → a readable merchant: ``"VISA PURCHASE 4829 WOOLWORTHS
    1234 SYDNEY NSW AU 12/10"`` → ``"Woolworths Sydney"``."""
    s = re.sub(r"\s+", " ", (text or "").strip())
    if not s:
        return ""
    s = _PREFIXES.sub("", s)
    s = _STAR_PREFIX.sub("", s)
    s = _PREFIXES.sub("", s)
    s = re.sub(r"\s*\*\s*", " ", s)
    for rx in _NOISE:
        s = rx.sub(" ", s)
        s = re.sub(r"\s+", " ", s).strip(" -*#:,.")
    s = re.sub(r"\s+\d{1,4}$", "", s)  # a trailing store number
    s = re.sub(r"\s+", " ", s).strip(" -*#:,.")
    if not s:
        return (text or "").strip()[:120]
    if s.isupper() or s.islower():
        words = []
        for i, w in enumerate(s.split(" ")):
            lw = w.lower()
            if i and lw in _SMALL:
                words.append(lw)
            elif w.upper() in _ACRONYMS or (len(w) == 1 and w.isalpha()):
                words.append(w.upper())  # AGL, KFC, TPG, "Single O"
            else:
                words.append(lw[:1].upper() + lw[1:])
        s = " ".join(words)
    return s[:120]


_KEY_DROP = re.compile(r"[^a-z0-9 ]+")
_KEY_STOP = {"pty", "ltd", "the", "com", "au", "www", "net", "co", "inc", "online", "payment", "subscription", "aus"}


def merchant_key(payee: str) -> str:
    """A grouping key for one merchant: lower-case words without digits,
    store numbers or suburbs (at most the first three words)."""
    s = (payee or "").lower().replace(".com", " ").replace("*", " ")
    s = _KEY_DROP.sub(" ", s)
    words = [w for w in s.split() if not any(ch.isdigit() for ch in w) and w not in _KEY_STOP]
    return " ".join(words[:3])


# ----------------------------------------------------------------- months


def parse_day(s: str) -> date:
    return date.fromisoformat(s[:10])


def month_of(day: str | date, start_day: int = 1) -> str:
    d = parse_day(day) if isinstance(day, str) else day
    if d.day < start_day:
        first = d.replace(day=1) - timedelta(days=1)
        return f"{first.year:04d}-{first.month:02d}"
    return f"{d.year:04d}-{d.month:02d}"


def add_months(month: str, n: int) -> str:
    y, m = int(month[:4]), int(month[5:7])
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def add_months_day(d: date, n: int) -> date:
    idx = d.year * 12 + (d.month - 1) + n
    y, m = idx // 12, idx % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def month_range(month: str, start_day: int = 1) -> tuple[date, date]:
    """First and last (inclusive) day of a budget month."""
    y, m = int(month[:4]), int(month[5:7])
    start = date(y, m, min(start_day, calendar.monthrange(y, m)[1]))
    nxt = add_months(month, 1)
    ny, nm = int(nxt[:4]), int(nxt[5:7])
    end = date(ny, nm, min(start_day, calendar.monthrange(ny, nm)[1])) - timedelta(days=1)
    return start, end


def month_label(month: str, start_day: int = 1) -> str:
    y, m = int(month[:4]), int(month[5:7])
    name = f"{calendar.month_name[m]} {y}"
    if start_day == 1:
        return name
    a, b = month_range(month, start_day)
    return f"{name} ({a.day} {calendar.month_abbr[a.month]} – {b.day} {calendar.month_abbr[b.month]})"


# ------------------------------------------------------------ transactions


def cat_index(data: dict) -> dict[str, dict]:
    return {c["id"]: c for c in data.get("categories", [])}


def txn_lines(t: dict) -> list[tuple[str | None, int]]:
    """(category, cents) parts of a transaction — its splits, or itself."""
    if t.get("splits"):
        return [(s.get("category_id"), int(s.get("amount_cents", 0))) for s in t["splits"]]
    return [(t.get("category_id"), int(t.get("amount_cents", 0)))]


def excluded_accounts(data: dict) -> set[str]:
    """Accounts whose transactions are outside the budget: off-budget ones
    (a home loan, investments — their interest and fees too) and archived."""
    return {a["id"] for a in data.get("accounts", []) if a.get("archived") or not a.get("on_budget", True)}


def counts(t: dict, off: set[str] | frozenset = frozenset()) -> bool:
    """Is this real spending / income for the budget — not a move between
    own accounts, and not on an off-budget or archived account?"""
    return not t.get("transfer") and (not off or t.get("account_id") not in off)


def in_range(t: dict, start: date, end: date) -> bool:
    return start.isoformat() <= t["date"] <= end.isoformat()


def _month_lines(data: dict, off: set[str]) -> tuple[dict, dict, dict]:
    """One pass: month → category → signed cents; month → income; month →
    money out with no (known) category."""
    sd = data.get("settings", {}).get("month_start_day", 1)
    cats = cat_index(data)
    act: dict[str, dict[str | None, int]] = defaultdict(lambda: defaultdict(int))
    income: dict[str, int] = defaultdict(int)
    uncat_out: dict[str, int] = defaultdict(int)
    for t in data.get("transactions", []):
        if not counts(t, off):
            continue
        m = month_of(t["date"], sd)
        for cid, cents in txn_lines(t):
            c = cats.get(cid or "")
            act[m][cid if c else None] += cents
            if (c and c["kind"] == "income") or (c is None and cents > 0):
                income[m] += cents
            elif c is None:
                uncat_out[m] += -cents
    return act, income, uncat_out


def activity_by_month(data: dict) -> dict[str, dict[str | None, int]]:
    """month → category → signed cents (negative = spent), transfers and
    off-budget accounts excluded."""
    return _month_lines(data, excluded_accounts(data))[0]


def income_by_month(data: dict) -> dict[str, int]:
    """Money in per month: income categories, plus uncategorised inflows."""
    return _month_lines(data, excluded_accounts(data))[1]


def assigned_map(data: dict) -> dict[str, dict[str, int]]:
    return {m["month"]: m.get("assigned", {}) for m in data.get("months", [])}


def assigned_for(data: dict, month: str, cat: dict, amap: dict | None = None) -> int:
    amap = amap if amap is not None else assigned_map(data)
    over = amap.get(month, {})
    if cat["id"] in over:
        return int(over[cat["id"]])
    return int(cat.get("budget_cents", 0))


def first_month(data: dict, fallback: str) -> str:
    sd = data.get("settings", {}).get("month_start_day", 1)
    months = [m["month"] for m in data.get("months", [])]
    days = [t["date"] for t in data.get("transactions", [])]
    if days:
        months.append(month_of(min(days), sd))
    return min(months) if months else fallback


def default_budget_start(today: date, start_day: int = 1) -> str:
    """The first full budget month from ``today``: this one if it starts
    today, else the next."""
    m = month_of(today, start_day)
    return m if month_range(m, start_day)[0] == today else add_months(m, 1)


def is_overspent(r: dict) -> bool:
    """Shared with the UI (logic.ts): below zero in a category that had
    money (assigned this month, or a rollover balance either way)."""
    return r["available"] < 0 and (r["assigned"] > 0 or r["carried"] != 0)


def budget_table(data: dict, month: str) -> dict:
    """Every expense category for ``month``: assigned, spent, carried in,
    available — plus totals and "to be budgeted".

    The envelope maths (YNAB-style), counted from ``settings.budget_start``
    (or, after an archive, from ``carry_in``):

    * "to be budgeted" = income − everything assigned − money spent with no
      category, since the budget started;
    * a **rollover** category carries what's left (or overspent) into next
      month;
    * a **non-rollover** category starts each month at zero: what was left
      goes back to "to be budgeted" (and overspending comes out of it), so
      no money is ever lost or created.

    A month before the budget start (or before the archived history) is
    shown on its own: assigned and spent, no rollover, no "to be budgeted"
    (``before_start``)."""
    off = excluded_accounts(data)
    act, income, uncat_out = _month_lines(data, off)
    amap = assigned_map(data)
    cats = [c for c in data.get("categories", []) if c["kind"] == "expense"]
    bs = (data.get("settings") or {}).get("budget_start")
    ci = data.get("carry_in") or None
    standalone = bool((bs and month < bs) or (ci and month < ci["month"]))
    carry: dict[str, int] = {c["id"]: 0 for c in cats}
    tbb = 0
    if standalone:
        start = month
    else:
        start = bs or max(first_month(data, month), add_months(month, -35))
        if ci and ci["month"] >= start:
            start = ci["month"]
            tbb = int(ci.get("to_be_budgeted", 0))
            for k, v in (ci.get("available") or {}).items():
                if k in carry:
                    carry[k] = int(v)
        start = max(start, add_months(month, -120))
        if start > month:
            start = month
    m = start
    rows: list[dict] = []
    while True:
        tbb += income.get(m, 0) - uncat_out.get(m, 0)
        rows = []
        for c in cats:
            assigned = assigned_for(data, m, c, amap)
            spent = -act.get(m, {}).get(c["id"], 0)
            carried = carry[c["id"]] if c.get("rollover") else 0
            available = carried + assigned - spent
            tbb -= assigned
            rows.append({"id": c["id"], "name": c["name"], "group_id": c["group_id"], "assigned": assigned,
                         "spent": spent, "carried": carried, "available": available,
                         "rollover": bool(c.get("rollover")), "hidden": bool(c.get("hidden"))})
            carry[c["id"]] = available
        if m >= month:
            break
        # Month end: a non-rollover category's balance goes back to the pot.
        tbb += sum(r["available"] for r in rows if not r["rollover"])
        m = add_months(m, 1)
    uncategorised_spent = uncat_out.get(month, 0)
    total_assigned = sum(r["assigned"] for r in rows)
    total_spent = sum(r["spent"] for r in rows) + uncategorised_spent
    return {
        "month": month,
        "rows": rows,
        "assigned": total_assigned,
        "spent": total_spent,
        "uncategorised_spent": uncategorised_spent,
        "income": income.get(month, 0),
        "available": sum(r["available"] for r in rows),
        "to_be_budgeted": 0 if standalone else tbb,
        "before_start": standalone,
        "budget_start": bs,
        "overspent": [r for r in rows if is_overspent(r)],
    }


def carry_at(data: dict, month: str) -> dict:
    """The carry-in for a budget that continues at ``month`` without the
    data before it: rollover balances and "to be budgeted" as it opens."""
    prev = add_months(month, -1)
    t = budget_table(data, prev)
    if t["before_start"]:
        return {"month": month, "available": {}, "to_be_budgeted": 0}
    tbb = t["to_be_budgeted"] + sum(r["available"] for r in t["rows"] if not r["rollover"])
    return {"month": month, "available": {r["id"]: r["available"] for r in t["rows"] if r["rollover"] and r["available"]},
            "to_be_budgeted": tbb}


def rebalance_splits(t: dict, currency: str = "AUD") -> None:
    """The bank changed a split transaction's amount (a hold settled for a
    different total, a tip): the difference goes on the largest part. If
    that would flip the part's sign, the split is cleared instead. Either
    way the transaction is flagged for a quick look (``review``)."""
    splits = t.get("splits") or []
    if not splits:
        return
    total = sum(int(s.get("amount_cents", 0)) for s in splits)
    diff = int(t["amount_cents"]) - total
    if diff == 0:
        return
    big = max(range(len(splits)), key=lambda i: (abs(int(splits[i].get("amount_cents", 0))), -i))
    new = int(splits[big].get("amount_cents", 0)) + diff
    if new != 0 and (new > 0) == (int(t["amount_cents"]) > 0):
        splits[big]["amount_cents"] = new
        t["review"] = f"The bank amount changed by {fmt(diff, currency)} — added to the largest part of the split."
    else:
        t["splits"] = []
        t["category_id"] = None
        t["category_by"] = "auto"
        t["review"] = f"The bank amount changed to {fmt(int(t['amount_cents']), currency)}, so the split was cleared — categorise it again."


def group_names(data: dict) -> dict[str, str]:
    return {g["id"]: g["name"] for g in data.get("groups", [])}


# ------------------------------------------------------------------ rules

_NESTED = re.compile(r"\([^)]*[+*}][^)]*\)\s*[+*{]")


def check_regex(pattern: str) -> re.Pattern:
    if _NESTED.search(pattern):
        raise ValueError("that pattern has nested repeats, which can be very slow — simplify it")
    try:
        return re.compile(pattern, re.I)
    except re.error as e:
        raise ValueError(f"that isn't a valid pattern ({e})") from e


def rule_matches(rule: dict, t: dict) -> bool:
    if not rule.get("enabled", True):
        return False
    hay = []
    if rule.get("field") in ("payee", "any"):
        hay.append(t.get("payee") or "")
    if rule.get("field") in ("description", "any"):
        hay.append(t.get("description") or "")
    pat = rule.get("pattern") or ""
    how = rule.get("match", "contains")
    for h in hay:
        h = h[:300]
        if how == "regex":
            try:
                if check_regex(pat).search(h):
                    return True
            except ValueError:
                return False
        else:
            a, b = h.lower().strip(), pat.lower().strip()
            if (how == "contains" and b in a) or (how == "equals" and a == b) or (how == "starts" and a.startswith(b)):
                return True
    return False


def apply_rules(data: dict, t: dict, rules: list[dict] | None = None) -> bool:
    """Apply the first matching rule (by order) to ``t``; returns whether it
    changed. The person's own choices (``*_by == "user"``) always win."""
    changed = False
    for r in rules if rules is not None else data.get("rules", []):
        if not rule_matches(r, t):
            continue
        if r.get("category_id") and t.get("category_by") != "user" and not t.get("splits"):
            if t.get("category_id") != r["category_id"]:
                t["category_id"] = r["category_id"]
                changed = True
            t["category_by"] = "rule"
        if r.get("rename_to") and t.get("payee_by") != "user":
            if t.get("payee") != r["rename_to"]:
                t["payee"] = r["rename_to"]
                changed = True
            t["payee_by"] = "rule"
        for tag in r.get("add_tags", []):
            if tag not in t.setdefault("tags", []) and len(t["tags"]) < 12:
                t["tags"].append(tag)
                changed = True
        if r.get("mark_transfer") and not t.get("transfer") and t.get("transfer_by") != "user":
            t["transfer"] = True
            t["transfer_by"] = "rule"
            changed = True
        break
    return changed


def learned_categories(data: dict) -> dict[str, str]:
    """merchant key → the category the person (or a rule) last gave it."""
    out: dict[str, tuple[str, str]] = {}
    for t in data.get("transactions", []):
        if t.get("category_id") and t.get("category_by") in ("user", "rule") and not t.get("splits"):
            k = merchant_key(t.get("payee") or "")
            if k and (k not in out or t["date"] >= out[k][0]):
                out[k] = (t["date"], t["category_id"])
    return {k: v[1] for k, v in out.items()}


def learned_for(learned: dict[str, str], payee: str) -> str | None:
    """The learned category for ``payee`` — its full key, else a shorter
    prefix ("netflix melbourne" → "netflix")."""
    words = merchant_key(payee).split()
    for n in range(len(words), 0, -1):
        k = " ".join(words[:n])
        if n == 1 and len(k) < 4:
            break
        if k in learned:
            return learned[k]
    return None


# --------------------------------------------------------------- analysis


def spending(data: dict, start: date, end: date, by: str = "category", account_id: str | None = None) -> dict:
    cats = cat_index(data)
    groups = group_names(data)
    buckets: dict[str, dict] = {}
    total_out = total_in = 0
    n = 0
    # One named account: exactly that account. Otherwise only on-budget ones.
    off = set() if account_id else excluded_accounts(data)
    for t in data.get("transactions", []):
        if not counts(t, off) or not in_range(t, start, end):
            continue
        if account_id and t.get("account_id") != account_id:
            continue
        n += 1
        for cid, cents in txn_lines(t):
            c = cats.get(cid or "")
            if c and c["kind"] == "income":
                total_in += cents
                continue
            if c is None and cents > 0:
                total_in += cents
                continue
            if by == "merchant":
                key = t.get("payee") or "(no payee)"
                label = key
            elif by == "group":
                key = c["group_id"] if c else "_none"
                label = groups.get(key, "Uncategorised")
            else:
                key = cid or "_none"
                label = c["name"] if c else "Uncategorised"
            b = buckets.setdefault(key, {"key": key, "name": label, "spent": 0, "count": 0})
            b["spent"] += -cents
            b["count"] += 1
            total_out += -cents
    rows = sorted((b for b in buckets.values() if b["spent"]), key=lambda b: -b["spent"])
    for b in rows:
        b["share"] = round(b["spent"] / total_out, 3) if total_out > 0 else 0
    return {"start": start.isoformat(), "end": end.isoformat(), "spent": total_out, "income": total_in,
            "net": total_in - total_out, "transactions": n, "rows": rows}


def cashflow(data: dict, start: date, end: date, interval: str = "month") -> dict:
    sd = data.get("settings", {}).get("month_start_day", 1)
    cats = cat_index(data)
    periods: dict[str, dict] = {}
    off = excluded_accounts(data)
    for t in data.get("transactions", []):
        if not counts(t, off) or not in_range(t, start, end):
            continue
        if interval == "week":
            d = parse_day(t["date"])
            key = (d - timedelta(days=d.weekday())).isoformat()
        elif interval == "day":
            key = t["date"]
        else:
            key = month_of(t["date"], sd)
        p = periods.setdefault(key, {"period": key, "in": 0, "out": 0})
        for cid, cents in txn_lines(t):
            c = cats.get(cid or "")
            is_income = (c and c["kind"] == "income") or (c is None and cents > 0)
            if is_income:
                p["in"] += cents
            else:
                p["out"] += -cents
    rows = [dict(p, net=p["in"] - p["out"]) for _, p in sorted(periods.items())]
    tin = sum(p["in"] for p in rows)
    tout = sum(p["out"] for p in rows)
    return {"start": start.isoformat(), "end": end.isoformat(), "interval": interval, "in": tin, "out": tout,
            "net": tin - tout, "savings_rate": round((tin - tout) / tin, 3) if tin > 0 else None, "periods": rows}


FIXED_GROUPS = {"bills"}
FIXED_CATEGORIES = {"rent", "utilities", "internet", "mobile", "insurance", "rates", "car", "education"}
ONE_OFF_MIN = 30_000  # $300: smaller than this is everyday spending


def forecast(data: dict, today: date) -> dict:
    """Where this budget month is heading: spent so far, the daily pace of
    *everyday* spending, and the bills/subscriptions still to come.

    The pace leaves out what doesn't repeat day by day — recurring bills
    and subscriptions (they're projected from their due dates instead),
    fixed costs (rent, utilities, insurance… the "Bills & housing" group)
    and one-off big spends (over $300 and over 4× the month's typical
    purchase) — so one rent payment early in the month doesn't project a
    month of rent every day."""
    sd = data.get("settings", {}).get("month_start_day", 1)
    month = month_of(today, sd)
    start, end = month_range(month, sd)
    table = budget_table(data, month)
    elapsed = (today - start).days + 1
    total_days = (end - start).days + 1
    left = max(0, total_days - elapsed)
    cats = cat_index(data)
    off = excluded_accounts(data)
    live = [s for s in data.get("subscriptions", [])
            if s.get("user_status") not in ("ignored", "cancelled") and s.get("status") != "maybe_cancelled"]
    sub_ids = {tid for s in data.get("subscriptions", []) for tid in s.get("transaction_ids", [])}
    sub_merchants = {s.get("merchant") for s in live if s.get("merchant")}
    lines: list[tuple[int, str]] = []  # (cents out, payee)
    fixed = 0
    for t in data.get("transactions", []):
        if not counts(t, off) or not in_range(t, start, min(today, end)):
            continue
        recurring = t["id"] in sub_ids or merchant_key(t.get("payee") or "") in sub_merchants
        for cid, cents in txn_lines(t):
            c = cats.get(cid or "")
            if cents >= 0 or (c and c["kind"] == "income"):
                continue
            if recurring or (c and (c["id"] in FIXED_CATEGORIES or c.get("group_id") in FIXED_GROUPS)):
                fixed += -cents
                continue
            lines.append((-cents, t.get("payee") or ""))
    typical = sorted(a for a, _ in lines)
    median = typical[len(typical) // 2] if typical else 0
    cutoff = max(ONE_OFF_MIN, 4 * median)
    one_offs = [(a, p) for a, p in lines if a > cutoff]
    everyday = sum(a for a, _ in lines if a <= cutoff)
    upcoming = []
    for s in live:
        nd = s.get("next_due")
        if not nd:
            continue
        d = parse_day(nd)
        while d <= end:
            if d > today:
                upcoming.append({"name": s["name"], "date": d.isoformat(), "amount": s["amount_cents"]})
            d = next_due_from(d, s["cadence"])
    upcoming_total = sum(u["amount"] for u in upcoming)
    pace = everyday / max(1, elapsed)
    projected_extra = int(round(pace * left))
    spent = table["spent"]
    projected = spent + projected_extra + upcoming_total
    return {
        "month": month, "start": start.isoformat(), "end": end.isoformat(), "days_elapsed": elapsed,
        "days_left": left, "spent_so_far": spent, "assigned": table["assigned"], "income_so_far": table["income"],
        "daily_pace": int(round(pace)), "upcoming_bills": sorted(upcoming, key=lambda u: u["date"]),
        "upcoming_total": upcoming_total, "projected_spend": projected,
        "fixed_and_recurring_so_far": fixed,
        "one_offs": [{"payee": p, "amount": a} for a, p in sorted(one_offs, reverse=True)[:10]],
        "projected_vs_budget": (table["assigned"] - projected) if table["assigned"] else None,
    }


CADENCE_DAYS = {"weekly": 7, "fortnightly": 14, "monthly": 30.44, "quarterly": 91.31, "yearly": 365.25}
PER_MONTH = {"weekly": 52 / 12, "fortnightly": 26 / 12, "monthly": 1.0, "quarterly": 1 / 3, "yearly": 1 / 12}


def next_due_from(d: date, cadence: str) -> date:
    if cadence == "weekly":
        return d + timedelta(days=7)
    if cadence == "fortnightly":
        return d + timedelta(days=14)
    if cadence == "monthly":
        return add_months_day(d, 1)
    if cadence == "quarterly":
        return add_months_day(d, 3)
    return add_months_day(d, 12)


def account_balance(data: dict, acct: dict) -> int:
    return int(acct.get("balance_cents", 0))


def goal_progress(data: dict, g: dict) -> int:
    if g.get("account_id"):
        a = next((a for a in data.get("accounts", []) if a["id"] == g["account_id"]), None)
        if a is not None:
            return max(0, account_balance(data, a))
    return int(g.get("saved_cents", 0))
