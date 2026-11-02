"""The Budget's actions — the AI panel's (and chat's) hands, also used by the
UI. Amounts in parameters are **dollars** (``-12.5`` = $12.50 out); the
file stores cents and every result carries both cents and a formatted
string, so the model never has to do arithmetic itself. Deterministic for
(data, args, now): ids are derived from the inputs and ``ctx.now``."""
from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, Field

from app.items.kinds.budget import logic, subscriptions
from app.items.kinds.budget.models import DAY, MAX_RULES, MAX_TRANSACTIONS, MONTH
from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

Dollars = float


def _cur(data: dict) -> str:
    return (data.get("settings") or {}).get("currency") or "AUD"


def _f(data: dict, cents: int) -> str:
    return logic.fmt(cents, _cur(data))


def _cat(data: dict, cid: str | None, *, allow_none: bool = True) -> dict | None:
    if cid in (None, ""):
        if allow_none:
            return None
        raise ActionError("Pick a category.")
    c = next((c for c in data["categories"] if c["id"] == cid), None)
    if c is None:
        by_name = [c for c in data["categories"] if c["name"].lower() == str(cid).lower()]
        if len(by_name) == 1:
            return by_name[0]
        raise ActionError(f"There's no category {cid!r}. Categories: " + ", ".join(f"{c['id']} ({c['name']})" for c in data["categories"][:60]))
    return c


def _acct(data: dict, aid: str | None) -> dict | None:
    if not aid:
        return None
    a = next((a for a in data["accounts"] if a["id"] == aid), None)
    if a is None:
        raise ActionError(f"There's no account {aid!r}.")
    return a


def _txn(data: dict, tid: str) -> dict:
    t = next((t for t in data["transactions"] if t["id"] == tid), None)
    if t is None:
        raise ActionError(f"There's no transaction {tid!r}.")
    return t


def _month_now(data: dict, ctx: ItemContext) -> str:
    return logic.month_of(ctx.today, data["settings"].get("month_start_day", 1))


def _range(data: dict, ctx: ItemContext, start: str | None, end: str | None, month: str | None) -> tuple[date, date]:
    sd = data["settings"].get("month_start_day", 1)
    if month:
        return logic.month_range(month, sd)
    if start or end:
        s = logic.parse_day(start) if start else date(1970, 1, 1)
        e = logic.parse_day(end) if end else ctx.today
        if e < s:
            raise ActionError("The end date is before the start date.")
        return s, e
    return logic.month_range(_month_now(data, ctx), sd)


def _txn_brief(data: dict, t: dict) -> dict:
    cats = logic.cat_index(data)
    c = cats.get(t.get("category_id") or "")
    return {
        "id": t["id"], "date": t["date"], "amount": _f(data, t["amount_cents"]), "amount_cents": t["amount_cents"],
        "payee": t.get("payee"), "category": c["name"] if c else ("split" if t.get("splits") else None),
        "account_id": t.get("account_id"), "pending": t.get("pending", False), "transfer": t.get("transfer", False),
        **({"notes": t["notes"]} if t.get("notes") else {}),
    }


# ============================================================ transactions


class SplitIn(BaseModel):
    category_id: str | None = None
    amount: Dollars = Field(description="Dollars for this part, same sign as the transaction")
    note: str = Field(default="", max_length=200)


class TxnIn(BaseModel):
    date: str | None = Field(default=None, pattern=DAY, description="YYYY-MM-DD; default today")
    amount: Dollars = Field(description="Dollars; negative = money out (spending), positive = money in")
    payee: str = Field(min_length=1, max_length=120)
    category_id: str | None = Field(default=None, description="A category id; omit to let rules decide")
    account_id: str | None = None
    notes: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    splits: list[SplitIn] = Field(default_factory=list, max_length=20, description="Split across categories (must add up)")
    pending: bool = False
    transfer: bool = Field(default=False, description="Between the person's own accounts (not spending)")


class AddTransactions(BaseModel):
    items: list[TxnIn] = Field(min_length=1, max_length=200)


def _splits(data: dict, total: int, splits: list[SplitIn]) -> list[dict]:
    if not splits:
        return []
    out = []
    for s in splits:
        _cat(data, s.category_id)
        out.append({"category_id": s.category_id, "amount_cents": logic.to_cents(s.amount), "note": s.note})
    if sum(s["amount_cents"] for s in out) != total:
        raise ActionError(f"The split parts add up to {_f(data, sum(s['amount_cents'] for s in out))}, not {_f(data, total)}.")
    return out


def add_transactions(ctx: ItemContext, data: dict, p: AddTransactions) -> ActionOutcome:
    if len(data["transactions"]) + len(p.items) > MAX_TRANSACTIONS:
        raise ActionError("This budget is full — archive old transactions into a new file first.")
    learned = logic.learned_categories(data)
    taken = {t["id"] for t in data["transactions"]}
    made = []
    for i, it in enumerate(p.items):
        cents = logic.to_cents(it.amount)
        if cents == 0:
            raise ActionError("A transaction needs a non-zero amount.")
        day = it.date or ctx.today.isoformat()
        cat = _cat(data, it.category_id)
        _acct(data, it.account_id)
        tid = logic.unique_id("t" + logic.short_hash("manual", day, cents, it.payee, ctx.now.isoformat(), i), taken)
        taken.add(tid)
        t = {
            "id": tid, "date": day, "amount_cents": cents, "payee": it.payee.strip(), "description": it.payee.strip(),
            "category_id": cat["id"] if cat else None, "category_by": "user" if cat else "auto", "payee_by": "user",
            "account_id": it.account_id, "notes": it.notes, "tags": it.tags, "splits": _splits(data, cents, it.splits),
            "pending": it.pending, "transfer": it.transfer, "transfer_account_id": None, "source": "manual",
            "external_id": None, "created_at": ctx.now.isoformat(), "transfer_by": "user" if it.transfer else "auto",
        }
        if not cat and not it.transfer and not t["splits"]:
            t["category_id"] = logic.learned_for(learned, t["payee"])
            logic.apply_rules(data, t)
        data["transactions"].append(t)
        made.append(t)
    _sort(data)
    names = ", ".join(f"{t['payee']} {_f(data, t['amount_cents'])}" for t in made[:4])
    more = f" and {len(made) - 4} more" if len(made) > 4 else ""
    return ActionOutcome(summary=f"Added {names}{more}", result={"ids": [t["id"] for t in made]})


def _sort(data: dict) -> None:
    data["transactions"].sort(key=lambda t: (t["date"], t.get("created_at") or "", t["id"]), reverse=True)


class TxnEdit(BaseModel):
    id: str
    date: str | None = Field(default=None, pattern=DAY)
    amount: Dollars | None = None
    payee: str | None = Field(default=None, max_length=120)
    category_id: str | None = Field(default=None, description="New category id; \"\" clears it")
    account_id: str | None = None
    notes: str | None = Field(default=None, max_length=1000)
    tags: list[str] | None = Field(default=None, max_length=12)
    splits: list[SplitIn] | None = Field(default=None, max_length=20, description="Replace the splits; [] removes them")
    transfer: bool | None = None
    pending: bool | None = None


class EditTransactions(BaseModel):
    items: list[TxnEdit] = Field(min_length=1, max_length=300)


def edit_transactions(ctx: ItemContext, data: dict, p: EditTransactions) -> ActionOutcome:
    for e in p.items:
        t = _txn(data, e.id)
        bank = t.get("source") == "up"
        if bank and (e.amount is not None or e.date is not None or e.pending is not None or e.account_id is not None):
            raise ActionError(f"{t['payee']} comes from Up — its date, amount, account and status follow the bank.")
        t["review"] = ""  # the person has looked at it
        if e.date is not None:
            t["date"] = e.date
        if e.amount is not None:
            t["amount_cents"] = logic.to_cents(e.amount)
        if e.payee is not None:
            t["payee"] = e.payee.strip()
            t["payee_by"] = "user"
        if e.category_id is not None:
            c = _cat(data, e.category_id or None)
            t["category_id"] = c["id"] if c else None
            t["category_by"] = "user"
            t["splits"] = []
        if e.account_id is not None:
            _acct(data, e.account_id or None)
            t["account_id"] = e.account_id or None
        if e.notes is not None:
            t["notes"] = e.notes
        if e.tags is not None:
            t["tags"] = e.tags
        if e.splits is not None:
            t["splits"] = _splits(data, t["amount_cents"], e.splits)
            if t["splits"]:
                t["category_id"] = None
                t["category_by"] = "user"
        if e.transfer is not None:
            t["transfer"] = e.transfer
            t["transfer_by"] = "user"  # a sync or a rule never flips it back
            if e.transfer:
                t["category_id"] = None
        if e.pending is not None:
            t["pending"] = e.pending
    _sort(data)
    return ActionOutcome(summary=f"Updated {len(p.items)} transaction{'s' if len(p.items) != 1 else ''}")


class Ids(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=1000)


def delete_transactions(ctx: ItemContext, data: dict, p: Ids) -> ActionOutcome:
    want = set(p.ids)
    gone = [t for t in data["transactions"] if t["id"] in want]
    if not gone:
        raise ActionError("None of those transactions exist.")
    data["transactions"] = [t for t in data["transactions"] if t["id"] not in want]
    note = ""
    if any(t.get("source") == "up" for t in gone):
        note = " (Up transactions come back on the next sync unless the bank removed them — mark them as transfers or re-categorise instead)"
    return ActionOutcome(summary=f"Deleted {len(gone)} transaction{'s' if len(gone) != 1 else ''}{note}")


class Categorise(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=1000, description="Transaction ids — find them with find_transactions (e.g. uncategorised=true)")
    category_id: str = Field(description="The category id to set")
    always_for_payee: bool = Field(
        default=False, description="Also make a rule so every transaction from these payees gets this category (and apply it now)"
    )


def categorise(ctx: ItemContext, data: dict, p: Categorise) -> ActionOutcome:
    c = _cat(data, p.category_id, allow_none=False)
    payees: set[str] = set()
    for tid in p.ids:
        t = _txn(data, tid)
        t["category_id"] = c["id"]
        t["category_by"] = "user"
        t["splits"] = []
        t["review"] = ""
        if t.get("transfer"):
            t["transfer"] = False  # categorised = it's real spending/income
            t["transfer_by"] = "user"
        if t.get("payee"):
            payees.add(t["payee"])
    extra = 0
    rules_made = 0
    if p.always_for_payee:
        for payee in sorted(payees):
            existing = next((r for r in data["rules"] if r["match"] == "equals" and r["field"] == "payee" and r["pattern"].lower() == payee.lower()), None)
            if existing:
                existing["category_id"] = c["id"]
                rule = existing
            else:
                if len(data["rules"]) >= MAX_RULES:
                    raise ActionError("There are too many rules — tidy some up first.")
                rid = logic.unique_id("r_" + logic.slug(payee, 24), [r["id"] for r in data["rules"]])
                rule = {"id": rid, "field": "payee", "match": "equals", "pattern": payee, "category_id": c["id"],
                        "rename_to": None, "add_tags": [], "mark_transfer": False, "enabled": True,
                        "created_at": ctx.now.isoformat()}
                data["rules"].insert(0, rule)
                rules_made += 1
            for t in data["transactions"]:
                if t.get("category_by") != "user" and logic.rule_matches(rule, t) and not t.get("splits") and not t.get("transfer"):
                    if t.get("category_id") != c["id"]:
                        extra += 1
                    t["category_id"] = c["id"]
                    t["category_by"] = "rule"
    n = len(p.ids)
    tail = f", plus {extra} more from the same payee{'s' if len(payees) > 1 else ''} (rule saved)" if p.always_for_payee else ""
    return ActionOutcome(
        summary=f"Moved {n} transaction{'s' if n != 1 else ''} to {c['name']}{tail}",
        result={"updated": n, "also_updated": extra, "rules_created": rules_made},
    )


class ImportRow(BaseModel):
    date: str = Field(pattern=DAY)
    amount: Dollars = Field(description="Dollars; negative = money out")
    description: str = Field(default="", max_length=300)
    payee: str | None = Field(default=None, max_length=120)
    category: str | None = Field(default=None, max_length=60, description="A category id or name, if the file had one")
    notes: str = Field(default="", max_length=500)


class ImportTransactions(BaseModel):
    account_id: str | None = Field(default=None, description="The account these rows belong to")
    rows: list[ImportRow] = Field(min_length=1, max_length=5000)


def _dupe_key(day: str, cents: int, text: str) -> tuple:
    return (day, cents, logic.merchant_key(text) or (text or "").strip().lower()[:40])


def import_transactions(ctx: ItemContext, data: dict, p: ImportTransactions) -> ActionOutcome:
    """A bank CSV (parsed in the browser) → transactions. Duplicates (same
    day, amount and description already on that account — counted, so two
    identical coffees stay two) are skipped. Rules and learned payees apply."""
    _acct(data, p.account_id)
    have = Counter(
        _dupe_key(t["date"], t["amount_cents"], t.get("description") or t.get("payee") or "")
        for t in data["transactions"] if (t.get("account_id") == p.account_id)
    )
    have_payee = Counter(
        _dupe_key(t["date"], t["amount_cents"], t.get("payee") or "")
        for t in data["transactions"] if (t.get("account_id") == p.account_id)
    )
    incoming: Counter = Counter()
    learned = logic.learned_categories(data)
    by_name = {c["name"].lower(): c["id"] for c in data["categories"]}
    ids = {c["id"] for c in data["categories"]}
    taken = {t["id"] for t in data["transactions"]}
    added = skipped = 0
    for i, r in enumerate(p.rows):
        cents = logic.to_cents(r.amount)
        if cents == 0:
            skipped += 1
            continue
        text = r.description or r.payee or ""
        k = _dupe_key(r.date, cents, text)
        incoming[k] += 1
        if incoming[k] <= max(have[k], have_payee[_dupe_key(r.date, cents, r.payee or logic.clean_payee(text))]):
            skipped += 1
            continue
        if len(data["transactions"]) >= MAX_TRANSACTIONS:
            raise ActionError(f"Imported {added}; this budget is full now.")
        payee = (r.payee or logic.clean_payee(text) or "Unknown")[:120]
        tid = logic.unique_id("t" + logic.short_hash("csv", p.account_id, r.date, cents, text, incoming[k]), taken)
        taken.add(tid)
        cat = None
        if r.category:
            cat = r.category if r.category in ids else by_name.get(r.category.lower())
        t = {
            "id": tid, "date": r.date, "amount_cents": cents, "payee": payee, "description": text[:300],
            "category_id": cat, "category_by": "user" if cat else "auto", "payee_by": "auto",
            "account_id": p.account_id, "notes": r.notes, "tags": [], "splits": [], "pending": False,
            "transfer": False, "transfer_account_id": None, "source": "csv", "external_id": None,
            "created_at": ctx.now.isoformat(),
        }
        if not cat:
            t["category_id"] = logic.learned_for(learned, payee)
        logic.apply_rules(data, t)
        data["transactions"].append(t)
        added += 1
    _sort(data)
    subs = subscriptions.merge(data, ctx.today)
    msg = f"Imported {added} transaction{'s' if added != 1 else ''}"
    if skipped:
        msg += f", skipped {skipped} already there"
    if subs["new"]:
        msg += f"; found {subs['new']} new recurring charge{'s' if subs['new'] != 1 else ''}"
    return ActionOutcome(summary=msg, result={"imported": added, "skipped": skipped, "subscriptions": subs})


# ================================================================= rules


class AddRule(BaseModel):
    pattern: str = Field(min_length=1, max_length=200, description="Text to look for")
    field: Literal["payee", "description", "any"] = "any"
    match: Literal["contains", "equals", "starts", "regex"] = "contains"
    category_id: str | None = None
    rename_to: str | None = Field(default=None, max_length=120, description="Rename the payee to this")
    add_tags: list[str] = Field(default_factory=list, max_length=6)
    mark_transfer: bool = False
    apply_to_existing: bool = Field(default=True, description="Apply now to existing transactions (not ones the person set by hand)")


def add_rule(ctx: ItemContext, data: dict, p: AddRule) -> ActionOutcome:
    if p.match == "regex":
        try:
            logic.check_regex(p.pattern)
        except ValueError as e:
            raise ActionError(str(e)) from e
    if not (p.category_id or p.rename_to or p.add_tags or p.mark_transfer):
        raise ActionError("A rule needs to do something: set a category, rename, tag or mark as transfer.")
    _cat(data, p.category_id)
    if len(data["rules"]) >= MAX_RULES:
        raise ActionError("There are too many rules — tidy some up first.")
    rid = logic.unique_id("r_" + logic.slug(p.pattern, 24), [r["id"] for r in data["rules"]])
    c = _cat(data, p.category_id)
    rule = {"id": rid, "field": p.field, "match": p.match, "pattern": p.pattern, "category_id": c["id"] if c else None,
            "rename_to": p.rename_to, "add_tags": p.add_tags, "mark_transfer": p.mark_transfer, "enabled": True,
            "created_at": ctx.now.isoformat()}
    data["rules"].insert(0, rule)
    n = 0
    if p.apply_to_existing:
        for t in data["transactions"]:
            if logic.apply_rules(data, t, [rule]):
                n += 1
    return ActionOutcome(summary=f"Rule saved — matched {n} existing transaction{'s' if n != 1 else ''}", result={"id": rid, "applied": n})


class RuleId(BaseModel):
    id: str


def delete_rule(ctx: ItemContext, data: dict, p: RuleId) -> ActionOutcome:
    before = len(data["rules"])
    data["rules"] = [r for r in data["rules"] if r["id"] != p.id]
    if len(data["rules"]) == before:
        raise ActionError(f"There's no rule {p.id!r}.")
    return ActionOutcome(summary="Rule removed (already-categorised transactions keep their category)")


# ================================================================ budget


class BudgetLine(BaseModel):
    category_id: str
    amount: Dollars = Field(ge=0, description="Dollars per month")
    month: str | None = Field(default=None, pattern=MONTH, description="YYYY-MM for just that month; omit to set the default for every month")


class SetBudget(BaseModel):
    items: list[BudgetLine] = Field(min_length=1, max_length=200)


def _month_row(data: dict, month: str) -> dict:
    row = next((m for m in data["months"] if m["month"] == month), None)
    if row is None:
        if len(data["months"]) >= 120:
            data["months"].sort(key=lambda m: m["month"])
            first = data["settings"].get("budget_start") or (data.get("carry_in") or {}).get("month") or ""
            if not first or data["months"][0]["month"] >= first:
                raise ActionError("This budget has ten years of monthly budgets — archive older data first.")
            data["months"].pop(0)  # only a month from before the budget started
        row = {"month": month, "assigned": {}, "note": ""}
        data["months"].append(row)
        data["months"].sort(key=lambda m: m["month"])
    return row


def set_budget(ctx: ItemContext, data: dict, p: SetBudget) -> ActionOutcome:
    total = 0
    for it in p.items:
        c = _cat(data, it.category_id, allow_none=False)
        cents = logic.to_cents(it.amount)
        total += cents
        if it.month:
            _month_row(data, it.month)["assigned"][c["id"]] = cents
        else:
            c["budget_cents"] = cents
            # A new default applies from this month on: drop this and future overrides.
            cur = _month_now(data, ctx)
            for m in data["months"]:
                if m["month"] >= cur:
                    m["assigned"].pop(c["id"], None)
    n = len(p.items)
    return ActionOutcome(summary=f"Set {n} budget{'s' if n != 1 else ''} ({_f(data, total)} a month in total)",
                         result={"total_cents": total})


class MoveMoney(BaseModel):
    amount: Dollars = Field(gt=0)
    from_category_id: str | None = Field(default=None, description="Take from this category; omit for 'to be budgeted'")
    to_category_id: str | None = Field(default=None, description="Give to this category; omit for 'to be budgeted'")
    month: str | None = Field(default=None, pattern=MONTH, description="Default: this budget month")


def move_money(ctx: ItemContext, data: dict, p: MoveMoney) -> ActionOutcome:
    if not p.from_category_id and not p.to_category_id:
        raise ActionError("Say where the money comes from or goes to.")
    if p.from_category_id == p.to_category_id:
        raise ActionError("That's the same category.")
    month = p.month or _month_now(data, ctx)
    cents = logic.to_cents(p.amount)
    src = _cat(data, p.from_category_id)
    dst = _cat(data, p.to_category_id)
    row = _month_row(data, month)
    if src:
        have = logic.assigned_for(data, month, src)
        if have < cents:
            raise ActionError(f"{src['name']} only has {_f(data, have)} assigned in {month}.")
        row["assigned"][src["id"]] = have - cents
    if dst:
        row["assigned"][dst["id"]] = logic.assigned_for(data, month, dst) + cents
    a = src["name"] if src else "To be budgeted"
    b = dst["name"] if dst else "To be budgeted"
    t = logic.budget_table(data, month)
    return ActionOutcome(summary=f"Moved {_f(data, cents)} from {a} to {b}",
                         result={"month": month, "to_be_budgeted": _f(data, t["to_be_budgeted"])})


class AddCategory(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    group_id: str | None = Field(default=None, description="An existing group id")
    group_name: str | None = Field(default=None, max_length=60, description="Or a group name (created if new)")
    kind: Literal["expense", "income"] = "expense"
    budget: Dollars = Field(default=0, ge=0, description="Default monthly budget, dollars")
    rollover: bool = False
    emoji: str = Field(default="", max_length=8)
    bucket: Literal["needs", "wants", "savings", "none"] = "none"


def add_category(ctx: ItemContext, data: dict, p: AddCategory) -> ActionOutcome:
    if any(c["name"].lower() == p.name.lower() for c in data["categories"]):
        raise ActionError(f"There's already a category called {p.name}.")
    if len(data["categories"]) >= 200:
        raise ActionError("That's the most categories one budget can have.")
    gid = p.group_id
    if gid and not any(g["id"] == gid for g in data["groups"]):
        raise ActionError(f"There's no group {gid!r}.")
    if not gid:
        gname = (p.group_name or "Other").strip()
        g = next((g for g in data["groups"] if g["name"].lower() == gname.lower()), None)
        if g is None:
            g = {"id": logic.unique_id(logic.slug(gname, 24), [g["id"] for g in data["groups"]]), "name": gname, "hidden": False}
            data["groups"].append(g)
        gid = g["id"]
    cid = logic.unique_id(logic.slug(p.name, 28), [c["id"] for c in data["categories"]])
    data["categories"].append({"id": cid, "group_id": gid, "name": p.name, "kind": p.kind, "emoji": p.emoji,
                               "budget_cents": logic.to_cents(p.budget), "rollover": p.rollover, "hidden": False,
                               "bucket": p.bucket})
    return ActionOutcome(summary=f"Added the category {p.name}", result={"id": cid})


# ======================================================= goals & accounts


class AddGoal(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    target: Dollars = Field(gt=0)
    target_date: str | None = Field(default=None, pattern=DAY)
    account_id: str | None = Field(default=None, description="A saver whose balance is the progress (e.g. an Up saver)")
    saved: Dollars = Field(default=0, ge=0, description="Already saved, if not tracked by an account")
    category_id: str | None = Field(default=None, description="A sinking-fund category to budget into")
    emoji: str = Field(default="", max_length=8)


def _goal_brief(data: dict, g: dict, today: date) -> dict:
    have = logic.goal_progress(data, g)
    left = max(0, g["target_cents"] - have)
    out = {"id": g["id"], "name": g["name"], "target": _f(data, g["target_cents"]), "saved": _f(data, have),
           "left": _f(data, left), "pct": round(have / g["target_cents"] * 100) if g["target_cents"] else 0}
    if g.get("target_date") and left:
        days = (logic.parse_day(g["target_date"]) - today).days
        months = max(1, round(days / 30.44)) if days > 0 else 1
        fortnights = max(1, days // 14) if days > 0 else 1
        out["per_month_needed"] = _f(data, -(-left // months))
        out["per_fortnight_needed"] = _f(data, -(-left // fortnights))
        out["days_left"] = days
    return out


def add_goal(ctx: ItemContext, data: dict, p: AddGoal) -> ActionOutcome:
    _acct(data, p.account_id)
    _cat(data, p.category_id)
    if len(data["goals"]) >= 60:
        raise ActionError("That's the most goals one budget can have.")
    gid = logic.unique_id("g_" + logic.slug(p.name, 24), [g["id"] for g in data["goals"]])
    g = {"id": gid, "name": p.name, "target_cents": logic.to_cents(p.target), "target_date": p.target_date,
         "account_id": p.account_id, "saved_cents": logic.to_cents(p.saved), "category_id": p.category_id,
         "emoji": p.emoji, "created": ctx.today.isoformat(), "done": False}
    data["goals"].append(g)
    b = _goal_brief(data, g, ctx.today)
    tail = f" — about {b['per_month_needed']} a month" if b.get("per_month_needed") else ""
    return ActionOutcome(summary=f"New goal: {p.name}, {b['target']}{tail}", result=b)


class UpdateGoal(BaseModel):
    id: str
    name: str | None = Field(default=None, max_length=80)
    target: Dollars | None = Field(default=None, gt=0)
    target_date: str | None = Field(default=None, pattern=DAY)
    add_saved: Dollars | None = Field(default=None, description="Add (or with a negative, take) dollars to the saved amount")
    done: bool | None = None
    delete: bool = False


def update_goal(ctx: ItemContext, data: dict, p: UpdateGoal) -> ActionOutcome:
    g = next((g for g in data["goals"] if g["id"] == p.id), None)
    if g is None:
        raise ActionError(f"There's no goal {p.id!r}.")
    if p.delete:
        data["goals"] = [x for x in data["goals"] if x["id"] != p.id]
        return ActionOutcome(summary=f"Removed the goal {g['name']}")
    if p.name is not None:
        g["name"] = p.name
    if p.target is not None:
        g["target_cents"] = logic.to_cents(p.target)
    if p.target_date is not None:
        g["target_date"] = p.target_date
    if p.add_saved is not None:
        g["saved_cents"] = max(0, g["saved_cents"] + logic.to_cents(p.add_saved))
    if p.done is not None:
        g["done"] = p.done
    return ActionOutcome(summary=f"Updated {g['name']}", result=_goal_brief(data, g, ctx.today))


class AddAccount(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    type: Literal["transactional", "saver", "credit", "home_loan", "loan", "cash", "investment", "other"] = "transactional"
    balance: Dollars = Field(default=0, description="Current balance in dollars (negative for what's owed)")
    currency: str = Field(default="AUD", max_length=3)
    on_budget: bool = True


def add_account(ctx: ItemContext, data: dict, p: AddAccount) -> ActionOutcome:
    if len(data["accounts"]) >= 60:
        raise ActionError("That's the most accounts one budget can have.")
    aid = logic.unique_id("a_" + logic.slug(p.name, 24), [a["id"] for a in data["accounts"]])
    data["accounts"].append({"id": aid, "name": p.name, "type": p.type, "currency": p.currency.upper(),
                             "balance_cents": logic.to_cents(p.balance), "source": "manual", "external_id": None,
                             "on_budget": p.on_budget and p.type not in ("home_loan", "investment"), "archived": False,
                             "balance_at": ctx.now.isoformat(), "ownership": "individual", "renamed": True})
    return ActionOutcome(summary=f"Added the account {p.name}", result={"id": aid})


class UpdateAccount(BaseModel):
    id: str
    name: str | None = Field(default=None, max_length=80)
    balance: Dollars | None = Field(default=None, description="Set the balance (manual accounts only)")
    archived: bool | None = None
    on_budget: bool | None = None


def update_account(ctx: ItemContext, data: dict, p: UpdateAccount) -> ActionOutcome:
    a = _acct(data, p.id)
    assert a is not None
    if p.balance is not None:
        if a.get("source") == "up":
            raise ActionError("That balance comes from Up.")
        a["balance_cents"] = logic.to_cents(p.balance)
        a["balance_at"] = ctx.now.isoformat()
    if p.name is not None:
        a["name"] = p.name
        a["renamed"] = True
    if p.archived is not None:
        a["archived"] = p.archived
    if p.on_budget is not None:
        a["on_budget"] = p.on_budget
    return ActionOutcome(summary=f"Updated {a['name']}")


# ========================================================= subscriptions


class MarkSubscription(BaseModel):
    id: str
    status: Literal["confirmed", "ignored", "cancelled", "active"] = Field(
        description="confirmed = yes it's recurring; ignored = not a subscription; cancelled = I've cancelled it; active = clear my mark"
    )
    remind: bool | None = Field(default=None, description="Remind the day before each charge")
    name: str | None = Field(default=None, max_length=120)
    category_id: str | None = None


def mark_subscription(ctx: ItemContext, data: dict, p: MarkSubscription) -> ActionOutcome:
    s = next((s for s in data["subscriptions"] if s["id"] == p.id), None)
    if s is None:
        raise ActionError(f"There's no subscription {p.id!r}.")
    s["user_status"] = None if p.status == "active" else p.status
    s["cancelled_on"] = ctx.today.isoformat() if p.status == "cancelled" else None
    s["charged_after_cancel"] = False
    if p.remind is not None:
        s["remind"] = p.remind
    if p.name:
        s["name"] = p.name
        s["renamed"] = True
    if p.category_id is not None:
        c = _cat(data, p.category_id or None)
        s["category_id"] = c["id"] if c else None
    words = {"confirmed": "confirmed", "ignored": "ignored — it won't be counted", "cancelled": "marked cancelled — I'll flag it if it charges again", "active": "back to automatic"}
    return ActionOutcome(summary=f"{s['name']}: {words[p.status]}")


class AddSubscription(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    amount: Dollars = Field(gt=0, description="Dollars per charge")
    cadence: Literal["weekly", "fortnightly", "monthly", "quarterly", "yearly"] = "monthly"
    next_due: str = Field(pattern=DAY)
    kind: Literal["subscription", "bill"] = "subscription"
    category_id: str | None = None
    account_id: str | None = None
    remind: bool = True


def add_subscription(ctx: ItemContext, data: dict, p: AddSubscription) -> ActionOutcome:
    _cat(data, p.category_id)
    _acct(data, p.account_id)
    if len(data["subscriptions"]) >= 300:
        raise ActionError("That's the most subscriptions one budget can track.")
    cents = logic.to_cents(p.amount)
    sid = logic.unique_id("m_" + logic.slug(p.name, 24), [s["id"] for s in data["subscriptions"]])
    data["subscriptions"].append({
        "id": sid, "name": p.name, "merchant": logic.merchant_key(p.name), "kind": p.kind, "cadence": p.cadence,
        "amount_cents": cents, "variable": False, "monthly_cents": int(round(cents * logic.PER_MONTH[p.cadence])),
        "last_date": None, "next_due": p.next_due, "occurrences": 0, "confidence": 1.0, "status": "active",
        "user_status": "confirmed", "category_id": p.category_id, "account_id": p.account_id,
        "transaction_ids": [], "source": "manual", "remind": p.remind, "renamed": True,
    })
    return ActionOutcome(summary=f"Tracking {p.name}: {_f(data, cents)} {p.cadence}, next {p.next_due}", result={"id": sid})


class NoArgs(BaseModel):
    pass


def detect_subscriptions(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    r = subscriptions.merge(data, ctx.today)
    live = [s for s in data["subscriptions"] if subscriptions.is_live(s)]
    monthly = sum(s["monthly_cents"] for s in live)
    msg = f"Found {r['found']} recurring charge{'s' if r['found'] != 1 else ''} ({r['new']} new) — {_f(data, monthly)} a month"
    if r["price_changes"]:
        msg += f"; {len(r['price_changes'])} price change{'s' if len(r['price_changes']) != 1 else ''}"
    return ActionOutcome(summary=msg, result={**r, "monthly_total": _f(data, monthly)})


# ============================================================== settings


class SetSettings(BaseModel):
    currency: str | None = Field(default=None, max_length=3)
    month_start_day: int | None = Field(default=None, ge=1, le=28, description="Payday budgeting: months start on this day")
    style: Literal["simple", "envelope"] | None = None
    zero_based: bool | None = None
    pay_frequency: Literal["weekly", "fortnightly", "monthly", "irregular"] | None = None
    next_payday: str | None = Field(default=None, pattern=DAY)
    bill_reminders: bool | None = None
    overspend_alerts: bool | None = None
    up_history_days: int | None = Field(default=None, ge=30, le=1825)
    up_category_map: dict[str, str] | None = Field(default=None, description="Up category id → this budget's category id")
    budget_start: str | None = Field(default=None, pattern=MONTH, description="First budget month YYYY-MM: rollover and 'to be budgeted' count from here")


def set_settings(ctx: ItemContext, data: dict, p: SetSettings) -> ActionOutcome:
    s = data["settings"]
    changed = []
    for k, v in p.model_dump(exclude_none=True).items():
        if k == "currency":
            v = v.upper()
        if k == "up_category_map":
            for cid in v.values():
                _cat(data, cid, allow_none=False)
            v = {**s.get("up_category_map", {}), **v}
        s[k] = v
        changed.append(k.replace("_", " "))
    s["onboarded"] = True
    return ActionOutcome(summary="Updated " + (", ".join(changed) or "settings"))


# ============================================================== read-only


class RangeArgs(BaseModel):
    month: str | None = Field(default=None, pattern=MONTH, description="A budget month YYYY-MM (default: this one)")
    start: str | None = Field(default=None, pattern=DAY)
    end: str | None = Field(default=None, pattern=DAY)
    by: Literal["category", "group", "merchant"] = "category"
    account_id: str | None = None
    top: int = Field(default=15, ge=1, le=100)


def spending_summary(ctx: ItemContext, data: dict, p: RangeArgs) -> ActionOutcome:
    s, e = _range(data, ctx, p.start, p.end, p.month)
    r = logic.spending(data, s, e, p.by, p.account_id)
    rows = [{"name": b["name"], "spent": _f(data, b["spent"]), "spent_cents": b["spent"], "count": b["count"],
             "share_pct": round(b["share"] * 100, 1)} for b in r["rows"][: p.top]]
    return ActionOutcome(summary="", result={
        "range": f"{r['start']} to {r['end']}", "total_spent": _f(data, r["spent"]), "total_income": _f(data, r["income"]),
        "net": _f(data, r["net"]), "transactions": r["transactions"], "top": rows,
        "more_rows": max(0, len(r["rows"]) - p.top),
    })


class CashflowArgs(BaseModel):
    months: int = Field(default=6, ge=1, le=36, description="How many budget months back (incl. this one)")
    start: str | None = Field(default=None, pattern=DAY)
    end: str | None = Field(default=None, pattern=DAY)
    interval: Literal["month", "week", "day"] = "month"


def cashflow(ctx: ItemContext, data: dict, p: CashflowArgs) -> ActionOutcome:
    sd = data["settings"].get("month_start_day", 1)
    if p.start or p.end:
        s, e = _range(data, ctx, p.start, p.end, None)
    else:
        cur = _month_now(data, ctx)
        s = logic.month_range(logic.add_months(cur, -(p.months - 1)), sd)[0]
        e = ctx.today
    r = logic.cashflow(data, s, e, p.interval)
    return ActionOutcome(summary="", result={
        "range": f"{r['start']} to {r['end']}", "money_in": _f(data, r["in"]), "money_out": _f(data, r["out"]),
        "net": _f(data, r["net"]), "savings_rate_pct": round(r["savings_rate"] * 100, 1) if r["savings_rate"] is not None else None,
        "periods": [{"period": x["period"], "in": _f(data, x["in"]), "out": _f(data, x["out"]), "net": _f(data, x["net"]),
                     "net_cents": x["net"]} for x in r["periods"]],
    })


class MonthArg(BaseModel):
    month: str | None = Field(default=None, pattern=MONTH, description="YYYY-MM (default: this budget month)")


def budget_status(ctx: ItemContext, data: dict, p: MonthArg) -> ActionOutcome:
    month = p.month or _month_now(data, ctx)
    sd = data["settings"].get("month_start_day", 1)
    t = logic.budget_table(data, month)
    groups = logic.group_names(data)
    rows = [{"category_id": r["id"], "name": r["name"], "group": groups.get(r["group_id"], ""), "assigned": _f(data, r["assigned"]),
             "spent": _f(data, r["spent"]), "carried_in": _f(data, r["carried"]), "available": _f(data, r["available"]),
             "available_cents": r["available"], "pct_used": round(r["spent"] / r["assigned"] * 100) if r["assigned"] else None}
            for r in t["rows"] if (r["assigned"] or r["spent"] or r["carried"])]
    s, e = logic.month_range(month, sd)
    out = {
        "month": month, "label": logic.month_label(month, sd), "dates": f"{s} to {e}",
        "assigned": _f(data, t["assigned"]), "spent": _f(data, t["spent"]), "income": _f(data, t["income"]),
        "uncategorised_spent": _f(data, t["uncategorised_spent"]), "categories": rows,
        "overspent": [{"name": r["name"], "over_by": _f(data, -r["available"])} for r in t["overspent"]],
    }
    if t["before_start"]:
        out["note"] = (f"Budgeting starts {t['budget_start']}: this month is shown on its own (no rollover, no 'to be budgeted')."
                       if t.get("budget_start") and month < t["budget_start"] else "Before the archived history: shown on its own.")
    elif data["settings"].get("zero_based") or data["settings"].get("style") == "envelope":
        out["to_be_budgeted"] = _f(data, t["to_be_budgeted"])
    if month == _month_now(data, ctx):
        out["days_left"] = (e - ctx.today).days
    return ActionOutcome(summary="", result=out)


def subscriptions_report(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    subs = data["subscriptions"]
    live = [s for s in subs if subscriptions.is_live(s)]
    rows = []
    for s in sorted(subs, key=lambda s: -s["monthly_cents"]):
        st = subscriptions.effective_status(s)
        rows.append({"id": s["id"], "name": s["name"], "kind": s["kind"], "cadence": s["cadence"], "amount": _f(data, s["amount_cents"]),
                     "per_month": _f(data, s["monthly_cents"]), "next_due": s.get("next_due"), "last_charged": s.get("last_date"),
                     "status": st, "confidence": s.get("confidence"), "variable": s.get("variable", False),
                     **({"price_change": f"{_f(data, s['price_change']['from_cents'])} → {_f(data, s['price_change']['to_cents'])} on {s['price_change']['on']}"} if s.get("price_change") else {}),
                     **({"charged_after_cancel": True} if s.get("charged_after_cancel") else {})})
    monthly = sum(s["monthly_cents"] for s in live)
    return ActionOutcome(summary="", result={
        "active_count": len(live), "per_month": _f(data, monthly), "per_year": _f(data, monthly * 12),
        "subscriptions_only_per_month": _f(data, sum(s["monthly_cents"] for s in live if s["kind"] == "subscription")),
        "bills_per_month": _f(data, sum(s["monthly_cents"] for s in live if s["kind"] == "bill")),
        "items": rows[:100],
    })


class FindArgs(BaseModel):
    query: str | None = Field(default=None, max_length=120, description="Words in the payee, description, notes or tags")
    category_id: str | None = None
    account_id: str | None = None
    start: str | None = Field(default=None, pattern=DAY)
    end: str | None = Field(default=None, pattern=DAY)
    min_amount: Dollars | None = Field(default=None, description="Size of the amount (absolute), dollars")
    max_amount: Dollars | None = None
    direction: Literal["any", "out", "in"] = "any"
    uncategorised: bool = False
    pending: bool | None = None
    limit: int = Field(default=50, ge=1, le=200)


def find_transactions(ctx: ItemContext, data: dict, p: FindArgs) -> ActionOutcome:
    words = [w for w in (p.query or "").lower().split() if w]
    lo = logic.to_cents(p.min_amount) if p.min_amount is not None else None
    hi = logic.to_cents(p.max_amount) if p.max_amount is not None else None
    hits = []
    total = 0
    for t in data["transactions"]:
        if p.start and t["date"] < p.start or p.end and t["date"] > p.end:
            continue
        if p.account_id and t.get("account_id") != p.account_id:
            continue
        if p.category_id and t.get("category_id") != p.category_id and not any(s.get("category_id") == p.category_id for s in t.get("splits", [])):
            continue
        if p.uncategorised and (t.get("category_id") or t.get("splits") or t.get("transfer")):
            continue
        if p.pending is not None and bool(t.get("pending")) != p.pending:
            continue
        a = t["amount_cents"]
        if (p.direction == "out" and a >= 0) or (p.direction == "in" and a <= 0):
            continue
        if lo is not None and abs(a) < abs(lo) or hi is not None and abs(a) > abs(hi):
            continue
        if words:
            hay = " ".join([t.get("payee") or "", t.get("description") or "", t.get("notes") or "", " ".join(t.get("tags", []))]).lower()
            if not all(w in hay for w in words):
                continue
        total += a
        hits.append(t)
    return ActionOutcome(summary="", result={
        "matches": len(hits), "net_total": _f(data, total), "net_total_cents": total,
        "transactions": [_txn_brief(data, t) for t in hits[: p.limit]],
    })


def forecast_month_end(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    r = logic.forecast(data, ctx.today)
    out = {
        "month": r["month"], "dates": f"{r['start']} to {r['end']}", "days_left": r["days_left"],
        "spent_so_far": _f(data, r["spent_so_far"]), "income_so_far": _f(data, r["income_so_far"]),
        "budgeted": _f(data, r["assigned"]), "daily_discretionary_pace": _f(data, r["daily_pace"]),
        "bills_still_to_come": [{"name": u["name"], "date": u["date"], "amount": _f(data, u["amount"])} for u in r["upcoming_bills"]],
        "bills_still_to_come_total": _f(data, r["upcoming_total"]), "projected_month_spend": _f(data, r["projected_spend"]),
        "fixed_and_recurring_so_far": _f(data, r["fixed_and_recurring_so_far"]),
        "one_offs_left_out_of_pace": [{"payee": o["payee"], "amount": _f(data, o["amount"])} for o in r["one_offs"]],
    }
    if r["projected_vs_budget"] is not None:
        v = r["projected_vs_budget"]
        out["projected_vs_budget"] = (f"{_f(data, v)} under budget" if v >= 0 else f"{_f(data, -v)} over budget")
    return ActionOutcome(summary="", result=out)


def accounts_overview(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    live = [a for a in data["accounts"] if not a.get("archived")]
    # Net worth: every live account (loans included); "cash" only on-budget ones.
    assets = sum(a["balance_cents"] for a in live if a["balance_cents"] > 0)
    debts = sum(a["balance_cents"] for a in live if a["balance_cents"] < 0)
    cash = sum(a["balance_cents"] for a in live if a.get("on_budget") and a["type"] in ("transactional", "saver", "cash"))
    # Emergency-fund cover: cash vs. three months of average spending.
    sd = data["settings"].get("month_start_day", 1)
    cur = _month_now(data, ctx)
    s = logic.month_range(logic.add_months(cur, -3), sd)[0]
    e = logic.month_range(logic.add_months(cur, -1), sd)[1]
    avg = logic.spending(data, s, e)["spent"] // 3
    return ActionOutcome(summary="", result={
        "accounts": [{"id": a["id"], "name": a["name"], "type": a["type"], "balance": _f(data, a["balance_cents"]),
                      "source": a["source"], "as_of": a.get("balance_at")} for a in live],
        "assets": _f(data, assets), "debts": _f(data, debts), "net_worth": _f(data, assets + debts), "cash": _f(data, cash),
        "avg_monthly_spend_last_3": _f(data, avg),
        "months_of_expenses_in_cash": round(cash / avg, 1) if avg > 0 else None,
        "goals": [_goal_brief(data, g, ctx.today) for g in data["goals"] if not g.get("done")],
    })


ACTIONS = [
    ItemAction("add_transactions", "Add one or more manual transactions (cash spends, bills paid from another bank). Amounts in dollars, negative = money out.", AddTransactions, add_transactions),
    ItemAction("edit_transactions", "Change transactions (payee, category, notes, tags, splits, transfer flag; date/amount only for manual ones). Batch.", EditTransactions, edit_transactions),
    ItemAction("delete_transactions", "Delete transactions by id (manual/CSV ones; Up ones come back on sync).", Ids, delete_transactions),
    ItemAction("categorise", "Set the category of transactions by id. With always_for_payee, also saves a rule for those payees and applies it to their other transactions.", Categorise, categorise),
    ItemAction("import_transactions", "Import rows from a bank statement/CSV into an account (duplicates skipped, rules applied, subscriptions re-detected).", ImportTransactions, import_transactions),
    ItemAction("add_rule", "Create an auto-categorisation rule (payee/description contains/equals/starts/regex → category, rename, tags, transfer) and apply it to existing transactions.", AddRule, add_rule),
    ItemAction("delete_rule", "Remove a rule.", RuleId, delete_rule),
    ItemAction("set_budget", "Set monthly budgets per category (dollars) — as the default for every month, or for one month. Batch.", SetBudget, set_budget),
    ItemAction("move_money", "Envelope move: shift assigned dollars between two categories (or from/to 'to be budgeted') for a month — e.g. to cover overspending.", MoveMoney, move_money),
    ItemAction("add_category", "Add a budget category (in an existing or new group).", AddCategory, add_category),
    ItemAction("add_goal", "Create a savings goal (target, optional date, optional linked saver account).", AddGoal, add_goal),
    ItemAction("update_goal", "Change, add savings to, finish or delete a goal.", UpdateGoal, update_goal),
    ItemAction("add_account", "Add a manual account (cash, another bank, a credit card, a loan).", AddAccount, add_account),
    ItemAction("update_account", "Rename, archive or set the balance of an account (manual balances only).", UpdateAccount, update_account),
    ItemAction("mark_subscription", "Mark a detected subscription/bill as confirmed, ignored (not one), cancelled, or back to automatic; set reminders or rename it.", MarkSubscription, mark_subscription),
    ItemAction("add_subscription", "Track a subscription or bill by hand (amount, cadence, next due date).", AddSubscription, add_subscription),
    ItemAction("detect_subscriptions", "Re-run subscription & bill detection over all transactions now.", NoArgs, detect_subscriptions),
    ItemAction("set_settings", "Change settings: currency, month start day (payday), budgeting style, zero-based, pay frequency / next payday, reminders, Up history and category map.", SetSettings, set_settings),
    ItemAction("spending_summary", "Spending totals for a month or date range, by category, group or merchant (computed — quote these numbers).", RangeArgs, spending_summary, writes=False),
    ItemAction("cashflow", "Money in vs out per month/week/day over a range, with net and savings rate.", CashflowArgs, cashflow, writes=False),
    ItemAction("budget_status", "A budget month: per category assigned, spent, carried in (rollover), available; overspent categories; to-be-budgeted.", MonthArg, budget_status, writes=False),
    ItemAction("subscriptions_report", "All subscriptions and bills with monthly/yearly totals, next charges, statuses and price changes.", NoArgs, subscriptions_report, writes=False),
    ItemAction("find_transactions", "Search transactions by words, category, account, dates, amount, direction, uncategorised or pending. Returns ids and a total.", FindArgs, find_transactions, writes=False),
    ItemAction("forecast_month_end", "Project this budget month's end: spend so far, daily pace, bills still due, projected total vs budget.", NoArgs, forecast_month_end, writes=False),
    ItemAction("accounts_overview", "Balances, net worth, cash, months of expenses covered (emergency fund) and goal progress.", NoArgs, accounts_overview, writes=False),
]
