"""Subscription & bill detection — deterministic, no model involved.

1. Take outgoing, non-transfer transactions; group them by normalised
   merchant (:func:`logic.merchant_key`).
2. Inside a merchant, cluster charges by amount (±25%, so a price rise
   stays in its cluster) and fold same-day duplicates.
3. A cluster is recurring when its gaps fit one cadence — weekly 7±1,
   fortnightly 14±2, monthly 28–31±3, quarterly ~91±7, yearly ~365±15 —
   for at least 75% of the gaps, with ≥3 charges (≥2 for yearly).
4. The amount must be stable: every charge within ±10% of the median, or
   exactly one step change (a price change, reported as an alert). Bills
   that move more (power, water) count only with ≥4 charges, a utility-ish
   merchant/category and a very regular cadence — flagged ``variable``.
5. Habitual spending (groceries, coffee, fuel) needs exact amounts and must
   be most of that merchant's charges, so a weekly shop isn't a "subscription".

Each finding gets the next due date, its monthly equivalent, a confidence
and a status: active, or *maybe cancelled* once it's overdue by more than
half a cycle (1.5× the cadence since the last charge). What the person said
(confirmed / ignored / cancelled) is kept across re-runs, and a charge after
they marked it cancelled raises ``charged_after_cancel``.
"""
from __future__ import annotations

import statistics
from datetime import date, timedelta

from app.items.kinds.budget import logic
from app.items.kinds.budget.defaults import HABIT_CATEGORIES, KNOWN_RECURRING, RECURRING_CATEGORIES

# cadence → (min gap, max gap) in days
WINDOWS: dict[str, tuple[int, int]] = {
    "weekly": (6, 8),
    "fortnightly": (12, 16),
    "monthly": (25, 34),
    "quarterly": (84, 98),
    "yearly": (350, 380),
}
MIN_COUNT = {"weekly": 3, "fortnightly": 3, "monthly": 3, "quarterly": 3, "yearly": 2}
LOOKBACK_DAYS = 800


def _known(key: str) -> str | None:
    for name, kind in KNOWN_RECURRING.items():
        if key == name or key.startswith(name + " ") or (" " + name) in (" " + key):
            return kind
    return None


def _cluster(charges: list[dict]) -> list[list[dict]]:
    """Charges (oldest first) → amount clusters (±25% of the cluster's latest)."""
    clusters: list[list[dict]] = []
    for c in charges:
        best, best_d = None, None
        for cl in clusters:
            ref = cl[-1]["amount"]
            d = abs(c["amount"] - ref) / max(ref, 1)
            if d <= 0.25 and (best_d is None or d < best_d):
                best, best_d = cl, d
        if best is None:
            clusters.append([c])
        else:
            best.append(c)
    return clusters


def _fold_same_day(cl: list[dict]) -> list[dict]:
    out: list[dict] = []
    for c in cl:
        if out and out[-1]["date"] == c["date"]:
            out[-1] = {**out[-1], "ids": out[-1]["ids"] + c["ids"]}
            continue
        out.append(c)
    return out


def _cadence(gaps: list[int]) -> tuple[str, float] | None:
    """The cadence most gaps fit, and the share that fit it."""
    if not gaps:
        return None
    best = None
    for name, (lo, hi) in WINDOWS.items():
        fit = sum(1 for g in gaps if lo <= g <= hi) / len(gaps)
        if fit >= 0.75 and (best is None or fit > best[1]):
            best = (name, fit)
    return best


def _amount_shape(amounts: list[int]) -> tuple[str, dict | None]:
    """'exact' | 'stable' | 'step' | 'variable', and the step if any."""
    if len(set(amounts)) == 1:
        return "exact", None
    med = statistics.median(amounts)
    if all(abs(a - med) <= 0.10 * med for a in amounts):
        # A step within ±10% is still a price change worth surfacing.
        step = _single_step(amounts)
        return ("step", step) if step else ("stable", None)
    step = _single_step(amounts)
    if step:
        return "step", step
    return "variable", None


def _single_step(amounts: list[int]) -> dict | None:
    """Exactly one change point with near-flat runs either side."""
    for i in range(1, len(amounts)):
        before, after = amounts[:i], amounts[i:]
        if _flat(before) and _flat(after) and abs(before[-1] - after[0]) >= max(50, 0.01 * before[-1]):
            return {"index": i, "from": before[-1], "to": after[0]}
    return None


def _flat(xs: list[int]) -> bool:
    return max(xs) - min(xs) <= max(5, 0.01 * max(xs))


def detect(data: dict, today: date) -> list[dict]:
    """The recurring charges in ``data`` (detected ones only), newest first."""
    cats = logic.cat_index(data)
    since = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    by_merchant: dict[str, list[dict]] = {}
    off = logic.excluded_accounts(data)  # a home loan's interest isn't a bill in this budget
    for t in data.get("transactions", []):
        if t.get("transfer") or t["amount_cents"] >= 0 or t["date"] < since or (off and t.get("account_id") in off):
            continue
        cid = t.get("category_id")
        c = cats.get(cid or "")
        if c and c["kind"] == "income":
            continue
        key = logic.merchant_key(t.get("payee") or t.get("description") or "")
        if not key:
            continue
        by_merchant.setdefault(key, []).append(t)
    found: list[dict] = []
    for key, txns in by_merchant.items():
        txns.sort(key=lambda t: (t["date"], t["id"]))
        charges = [{"date": t["date"], "amount": -t["amount_cents"], "ids": [t["id"]], "t": t} for t in txns]
        # The whole merchant first (a bill whose amount moves stays one series),
        # then by amount (two plans with one merchant).
        whole = _evaluate(key, _fold_same_day(charges), len(charges), cats, today)
        if whole:
            found.append(whole)
            continue
        for cl in _cluster(charges):
            cl = _fold_same_day(cl)
            r = _evaluate(key, cl, len(charges), cats, today)
            if r:
                found.append(r)
    # Same merchant + cadence twice (two Apple plans): keep both, ids differ by amount.
    found.sort(key=lambda s: (-s["monthly_cents"], s["name"]))
    return found


def _evaluate(key: str, cl: list[dict], merchant_total: int, cats: dict, today: date) -> dict | None:
    if len(cl) < 2:
        return None
    days = [logic.parse_day(c["date"]) for c in cl]
    gaps = [(b - a).days for a, b in zip(days, days[1:])]
    cad = _cadence(gaps)
    if cad is None:
        return None
    cadence, fit = cad
    if len(cl) < MIN_COUNT[cadence]:
        return None
    amounts = [c["amount"] for c in cl]
    shape, step = _amount_shape(amounts)
    last_t = cl[-1]["t"]
    cid = last_t.get("category_id")
    known = _known(key)
    utilityish = (cid in RECURRING_CATEGORIES) or known == "bill"
    habit = cid in HABIT_CATEGORIES and not known
    variable = False
    if shape == "variable":
        if not (utilityish and len(cl) >= 4 and fit >= 0.9):
            return None
        variable = True
    if habit:
        # A weekly shop or a daily coffee is a habit, not a subscription.
        if shape != "exact" or len(cl) < 0.6 * merchant_total:
            return None
    if len(cl) < 0.34 * merchant_total and shape != "exact" and not known:
        return None  # a few similar charges among many random ones
    # Confidence: regular gaps, steady amounts, more history, a known merchant.
    conf = 0.35 + 0.25 * fit
    conf += {"exact": 0.2, "stable": 0.12, "step": 0.12, "variable": 0.0}[shape]
    conf += min(0.12, 0.03 * (len(cl) - 2))
    if known or cid in RECURRING_CATEGORIES:
        conf += 0.12
    if habit:
        conf -= 0.1
    nominal = logic.CADENCE_DAYS[cadence]
    gap_sd = statistics.pstdev(gaps) if len(gaps) > 1 else 0.0
    if gap_sd > nominal * 0.12:
        conf -= 0.08
    conf = round(max(0.05, min(0.99, conf)), 2)
    if conf < 0.5:
        return None
    last = days[-1]
    amount = round(statistics.mean(amounts[-3:])) if variable else amounts[-1]
    nd = logic.next_due_from(last, cadence)
    overdue_limit = last + timedelta(days=round(1.5 * nominal))
    status = "maybe_cancelled" if today > overdue_limit else "active"
    price_change = None
    if step and not variable:
        price_change = {"from_cents": step["from"], "to_cents": step["to"], "on": cl[step["index"]]["date"]}
    name = last_t.get("payee") or key.title()
    kind = "bill" if (known == "bill" or (cid in RECURRING_CATEGORIES and cid != "subscriptions" and cid != "fitness")) else "subscription"
    sid = f"s_{logic.slug(key, 24)}_{cadence[:2]}"
    return {
        "id": sid,
        "name": name,
        "merchant": key,
        "kind": kind,
        "cadence": cadence,
        "amount_cents": int(amount),
        "variable": variable,
        "monthly_cents": int(round(amount * logic.PER_MONTH[cadence])),
        "last_date": last.isoformat(),
        "next_due": nd.isoformat(),
        "occurrences": len(cl),
        "confidence": conf,
        "status": status,
        "price_change": price_change,
        "category_id": cid,
        "account_id": last_t.get("account_id"),
        "transaction_ids": [i for c in cl[-12:] for i in c["ids"]][-12:],
        "source": "detected",
    }


def merge(data: dict, today: date) -> dict:
    """Run detection and fold it into ``data["subscriptions"]`` keeping what
    the person said. Returns counts and alerts for the summary."""
    found = detect(data, today)
    old = {s["id"]: s for s in data.get("subscriptions", [])}
    by_merchant_cadence = {(s.get("merchant"), s.get("cadence")): s for s in data.get("subscriptions", [])}
    out: list[dict] = []
    seen: set[str] = set()
    new_count = 0
    alerts: list[dict] = []
    for f in found:
        sid = f["id"]
        if sid in seen:
            sid = logic.unique_id(f"{sid}_{f['amount_cents']}", seen)
            f["id"] = sid
        prev = old.get(sid) or by_merchant_cadence.get((f["merchant"], f["cadence"]))
        if prev is not None and prev.get("id") in seen:
            prev = None
        if prev is None:
            new_count += 1
            f["remind"] = bool(data.get("settings", {}).get("bill_reminders", True))
            f["user_status"] = None
        else:
            f["id"] = prev["id"]
            f["remind"] = prev.get("remind", True)
            f["user_status"] = prev.get("user_status")
            f["cancelled_on"] = prev.get("cancelled_on")
            if prev.get("name") and prev.get("name") != f["name"] and prev.get("renamed"):
                f["name"] = prev["name"]
            if f["price_change"] is None and prev.get("price_change"):
                f["price_change"] = prev["price_change"]
            if prev.get("category_id") and not f.get("category_id"):
                f["category_id"] = prev["category_id"]
        f["charged_after_cancel"] = bool(
            f.get("user_status") == "cancelled" and f.get("cancelled_on") and f["last_date"] > f["cancelled_on"]
        )
        if f["price_change"] and f["price_change"]["on"] >= (today - timedelta(days=60)).isoformat():
            alerts.append({"id": f["id"], "name": f["name"], **f["price_change"]})
        seen.add(f["id"])
        out.append(f)
    # Keep the person's own entries, and detected ones they've spoken about.
    for s in data.get("subscriptions", []):
        if s["id"] in seen:
            continue
        if s.get("source") == "manual":
            nd = s.get("next_due")
            if nd:
                d = logic.parse_day(nd)
                while d < today:
                    d = logic.next_due_from(d, s.get("cadence", "monthly"))
                s["next_due"] = d.isoformat()
            out.append(s)
        elif s.get("user_status") in ("confirmed", "cancelled", "ignored"):
            out.append(s)
    data["subscriptions"] = out[:300]
    return {"found": len(found), "new": new_count, "price_changes": alerts}


def effective_status(s: dict) -> str:
    return s.get("user_status") or s.get("status") or "active"


def is_live(s: dict) -> bool:
    return effective_status(s) in ("active", "confirmed")
