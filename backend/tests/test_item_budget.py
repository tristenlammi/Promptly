"""Budget item: the model, the arithmetic, subscription detection, every
action, reminders, text, the Up Bank sync (fixtures shaped exactly like
Up's documented responses; HTTP always mocked) and the API end to end."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.items.kinds.budget import SPEC, logic, subscriptions, up
from app.items.kinds.budget.models import BudgetData
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 12, 0, tzinfo=TZ)
TOKEN = "up:yeah:abcDEF1234567890secretTOKENvalue"


class _U:
    settings = {"currency": "AUD", "timezone": "Australia/Sydney"}


def ctx(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=_U(), file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


def fresh() -> dict:
    return SPEC.template(ctx())


async def act(data: dict, name: str, args: dict | None = None, now: datetime = NOW):
    from app.items import service

    out = await service.run_action(ctx(now), SPEC, data, name, args or {})
    # Whatever an action leaves must still be a valid file.
    data.update(SPEC.validate(data))
    return out


def txn(tid: str, day: str, cents: int, payee: str, cat: str | None = None, **kw) -> dict:
    return {"id": tid, "date": day, "amount_cents": cents, "payee": payee, "description": payee, "category_id": cat, **kw}


# ===================================================== Up-shaped fixtures


def up_money(cents: int, ccy: str = "AUD") -> dict:
    sign = "-" if cents < 0 else ""
    return {"currencyCode": ccy, "value": f"{sign}{abs(cents) // 100}.{abs(cents) % 100:02d}", "valueInBaseUnits": cents}


def up_account(aid: str, name: str, kind: str, cents: int, owner: str = "INDIVIDUAL") -> dict:
    return {
        "type": "accounts",
        "id": aid,
        "attributes": {
            "displayName": name,
            "accountType": kind,
            "ownershipType": owner,
            "balance": up_money(cents),
            "createdAt": "2024-01-01T10:00:00+11:00",
        },
        "relationships": {"transactions": {"links": {"related": f"{up.API}/accounts/{aid}/transactions"}}},
        "links": {"self": f"{up.API}/accounts/{aid}"},
    }


def up_txn(
    tid: str,
    created: str,
    cents: int,
    desc: str,
    *,
    status: str = "SETTLED",
    account: str = "acc-spend",
    category: str | None = None,
    parent: str | None = None,
    raw: str | None = None,
    message: str | None = None,
    transfer: str | None = None,
    round_up: int | None = None,
    cashback: int | None = None,
    foreign: tuple[int, str] | None = None,
    tags: list[str] | None = None,
) -> dict:
    return {
        "type": "transactions",
        "id": tid,
        "attributes": {
            "status": status,
            "rawText": raw,
            "description": desc,
            "message": message,
            "isCategorizable": transfer is None,
            "holdInfo": {"amount": up_money(cents), "foreignAmount": None} if status == "HELD" else None,
            "roundUp": {"amount": up_money(round_up), "boostPortion": None} if round_up else None,
            "cashback": {"description": "Cashback", "amount": up_money(cashback)} if cashback else None,
            "amount": up_money(cents),
            "foreignAmount": up_money(*foreign) if foreign else None,
            "cardPurchaseMethod": {"method": "CONTACTLESS", "cardNumberSuffix": "0001"},
            "settledAt": None if status == "HELD" else created,
            "createdAt": created,
            "transactionType": None,
            "note": None,
            "performingCustomer": {"displayName": "Tristen"},
            "deepLinkURL": f"up://transaction/{tid}",
        },
        "relationships": {
            "account": {"data": {"type": "accounts", "id": account}, "links": {"related": f"{up.API}/accounts/{account}"}},
            "transferAccount": {"data": {"type": "accounts", "id": transfer} if transfer else None},
            "category": {
                "data": {"type": "categories", "id": category} if category else None,
                "links": {"self": f"{up.API}/transactions/{tid}/relationships/category"},
            },
            "parentCategory": {"data": {"type": "categories", "id": parent} if parent else None},
            "tags": {"data": [{"type": "tags", "id": t} for t in (tags or [])], "links": {"self": f"{up.API}/transactions/{tid}/relationships/tags"}},
            "attachment": {"data": None},
        },
        "links": {"self": f"{up.API}/transactions/{tid}"},
    }


ACCOUNTS = [
    up_account("acc-spend", "Spending", "TRANSACTIONAL", 123456),
    up_account("acc-saver", "🏝️ Holiday", "SAVER", 500000),
    up_account("acc-home", "Home Loan", "HOME_LOAN", -45000000),
]


def first_sync_txns() -> list[dict]:
    return [
        up_txn("tx-coffee-held", "2026-10-30T08:15:00+11:00", -550, "Single O", status="HELD",
               category="restaurants-and-cafes", parent="good-life", raw="SINGLE O SURRY HILLS"),
        up_txn("tx-woolies", "2026-10-29T18:00:00+11:00", -8432, "Woolworths", category="groceries", parent="home",
               raw="WOOLWORTHS 1234 SYDNEY", round_up=-68),
        up_txn("tx-roundup", "2026-10-29T18:00:01+11:00", 68, "Round Up", account="acc-saver", transfer="acc-spend"),
        up_txn("tx-save", "2026-10-28T09:00:00+11:00", -20000, "Transfer to Holiday", transfer="acc-saver"),
        up_txn("tx-save-in", "2026-10-28T09:00:01+11:00", 20000, "Transfer from Spending", account="acc-saver", transfer="acc-spend"),
        up_txn("tx-pay", "2026-10-27T03:00:00+11:00", 312345, "ACME Pty Ltd", raw="SALARY ACME PTY LTD", message="Pay"),
        up_txn("tx-netflix", "2026-10-20T00:10:00+11:00", -2299, "Netflix", category="tv-and-music", parent="good-life"),
        up_txn("tx-japan", "2026-10-15T12:00:00+11:00", -4120, "Lawson", category="groceries", parent="home",
               foreign=(-400000, "JPY"), cashback=0),
        up_txn("tx-cashback", "2026-10-14T12:00:00+11:00", 500, "Cashback", category=None, cashback=500),
        up_txn("tx-mystery", "2026-10-13T12:00:00+11:00", -999, "Some New Shop", category="brand-new-up-cat", parent="personal",
               tags=["work"]),
    ]


class FakeUp:
    """An ``httpx.MockTransport`` handler that answers like Up."""

    def __init__(self) -> None:
        self.accounts = ACCOUNTS
        self.txns: list[dict] = first_sync_txns()
        self.page_size_seen: list[str] = []
        self.calls: list[tuple[str, str, dict]] = []
        self.auth: set[str] = set()
        self.status_override: list[int] = []  # popped per request
        self.webhooks: dict[str, dict] = {}
        self.ping_status = 200

    def factory(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=up.API, transport=httpx.MockTransport(self.handle))

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.auth.add(request.headers.get("Authorization", ""))
        path = request.url.path.replace("/api/v1", "", 1)
        params = dict(request.url.params)
        self.calls.append((request.method, path, params))
        if self.status_override:
            code = self.status_override.pop(0)
            return httpx.Response(code, json={"errors": [{"status": str(code), "title": "x", "detail": "x"}]})
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"errors": [{"status": "401", "title": "Not Authorized", "detail": "bad"}]})
        if path == "/util/ping":
            if self.ping_status != 200:
                return httpx.Response(self.ping_status, json={"errors": []})
            return httpx.Response(200, json={"meta": {"id": "x", "statusEmoji": "⚡️"}})
        if path == "/accounts":
            return httpx.Response(200, json={"data": self.accounts, "links": {"prev": None, "next": None}})
        if path == "/categories":
            return httpx.Response(200, json={"data": [
                {"type": "categories", "id": "groceries", "attributes": {"name": "Groceries"},
                 "relationships": {"parent": {"data": {"type": "categories", "id": "home"}}, "children": {"data": []}}},
                {"type": "categories", "id": "home", "attributes": {"name": "Home"},
                 "relationships": {"parent": {"data": None}, "children": {"data": [{"type": "categories", "id": "groceries"}]}}},
            ]})
        if path == "/webhooks" and request.method == "POST":
            body = json.loads(request.content)
            wid = f"wh-{len(self.webhooks) + 1}"
            self.webhooks[wid] = body["data"]["attributes"]
            return httpx.Response(201, json={"data": {"type": "webhooks", "id": wid, "attributes": {
                **body["data"]["attributes"], "secretKey": "whsec-very-secret", "createdAt": "2026-10-31T12:00:00+11:00"}}})
        if path.startswith("/webhooks/") and request.method == "DELETE":
            self.webhooks.pop(path.rsplit("/", 1)[1], None)
            return httpx.Response(204)
        if path.startswith("/transactions/"):
            tid = path.rsplit("/", 1)[1]
            hit = next((t for t in self.txns if t["id"] == tid), None)
            return httpx.Response(200 if hit else 404, json={"data": hit} if hit else {"errors": []})
        if path == "/transactions":
            rows = sorted(self.txns, key=lambda t: t["attributes"]["createdAt"], reverse=True)
            since = params.get("filter[since]")
            until = params.get("filter[until]")
            if since:
                s = datetime.fromisoformat(since.replace("Z", "+00:00"))
                rows = [t for t in rows if datetime.fromisoformat(t["attributes"]["createdAt"]) >= s]
            if until:
                u = datetime.fromisoformat(until.replace("Z", "+00:00"))
                rows = [t for t in rows if datetime.fromisoformat(t["attributes"]["createdAt"]) < u]
            size = int(params.get("page[size]", 4)) if "page[size]" in params else 4
            size = min(size, 4)  # small pages so pagination is exercised
            after = int(params.get("page[after]", 0))
            chunk = rows[after: after + size]
            nxt = None
            if after + size < len(rows):
                q = dict(params)
                q["page[after]"] = str(after + size)
                q["page[size]"] = str(size)
                nxt = str(httpx.URL(f"{up.API}/transactions", params=q))
            return httpx.Response(200, json={"data": chunk, "links": {"prev": None, "next": nxt}})
        return httpx.Response(404, json={"errors": [{"status": "404"}]})


@pytest.fixture
def fake_up(monkeypatch):
    f = FakeUp()
    monkeypatch.setattr(up, "client_factory", f.factory)

    async def no_sleep(_s):
        return None

    monkeypatch.setattr(up, "sleep", no_sleep)
    return f


# ================================================================= model


def test_template_and_old_files_load():
    d = fresh()
    assert d["settings"]["currency"] == "AUD" and d["settings"]["month_start_day"] == 1
    assert any(c["id"] == "groceries" for c in d["categories"]) and any(g["id"] == "income" for g in d["groups"])
    assert SPEC.validate({}) == BudgetData().model_dump(mode="json")
    assert SPEC.kind == "budget" and SPEC.suffix == ".budget" and SPEC.color == "#2F8F83" and SPEC.icon == "wallet"
    assert SPEC.category == "Money" and SPEC.router is not None and SPEC.periodic is not None
    with pytest.raises(Exception):
        SPEC.validate({"transactions": [{"id": "x", "date": "31/10/2026", "amount_cents": 1}]})


def test_payee_cleaning_and_merchant_keys():
    assert logic.clean_payee("VISA PURCHASE 4829 WOOLWORTHS 1234 SYDNEY NSW AU 12/10") == "Woolworths Sydney"
    assert logic.clean_payee("SQ *SINGLE O SURRY HILLS") == "Single O Surry Hills"
    assert logic.clean_payee("DIRECT DEBIT 123456789 AGL SALES PTY LTD") == "AGL Sales"
    assert logic.clean_payee("Netflix.com") == "Netflix.com"
    assert logic.merchant_key("Netflix.com") == "netflix"
    assert logic.merchant_key("WOOLWORTHS 1234 SYDNEY") == "woolworths sydney"
    assert logic.to_cents("-1,234.56") == -123456 and logic.to_cents(12.345) == 1235 and logic.to_cents("(5.00)") == -500


def test_payday_months():
    assert logic.month_of("2026-10-14", 15) == "2026-09"
    assert logic.month_of("2026-10-15", 15) == "2026-10"
    assert logic.month_range("2026-10", 15) == (date(2026, 10, 15), date(2026, 11, 14))
    assert logic.month_range("2026-02", 1) == (date(2026, 2, 1), date(2026, 2, 28))
    assert logic.month_of("2026-01-03", 5) == "2025-12"


def test_budget_table_rollover_and_to_be_budgeted():
    d = fresh()
    assert d["settings"]["budget_start"] == "2026-11"  # the first full month after setup (31 Oct)
    d["settings"]["budget_start"] = "2026-09"
    for c in d["categories"]:
        if c["id"] == "groceries":
            c["budget_cents"] = 60000
            c["rollover"] = True
        if c["id"] == "eating_out":
            c["budget_cents"] = 20000
    d["transactions"] = [
        txn("p1", "2026-09-01", 400000, "Pay", "salary"),
        txn("g1", "2026-09-05", -50000, "Woolworths", "groceries"),
        txn("e1", "2026-09-06", -25000, "Dinner", "eating_out"),
        txn("x1", "2026-09-07", -100000, "To saver", None, transfer=True),
        txn("g2", "2026-10-05", -30000, "Coles", "groceries"),
        txn("r1", "2026-10-06", 2000, "Coles refund", "groceries"),
    ]
    sep = logic.budget_table(d, "2026-09")
    g = next(r for r in sep["rows"] if r["id"] == "groceries")
    e = next(r for r in sep["rows"] if r["id"] == "eating_out")
    assert (g["assigned"], g["spent"], g["available"]) == (60000, 50000, 10000)
    assert e["available"] == -5000 and [r["id"] for r in sep["overspent"]] == ["eating_out"]
    assert sep["spent"] == 75000  # the transfer isn't spending
    oct_ = logic.budget_table(d, "2026-10")
    g = next(r for r in oct_["rows"] if r["id"] == "groceries")
    e = next(r for r in oct_["rows"] if r["id"] == "eating_out")
    assert g["carried"] == 10000 and g["spent"] == 28000 and g["available"] == 42000  # refund nets off
    assert e["carried"] == 0 and e["available"] == 20000  # no rollover there
    # Eating out's -$50 overspend (no rollover) comes out of "to be budgeted" when September closes.
    assert oct_["to_be_budgeted"] == 400000 - 2 * 80000 - 5000


# ============================================================ subscriptions


def _monthly(prefix: str, payee: str, amounts: list[int], start: date, cat: str | None = "subscriptions", step: int = 1) -> list[dict]:
    out = []
    for i, a in enumerate(amounts):
        d = logic.add_months_day(start, i * step)
        out.append(txn(f"{prefix}{i}", d.isoformat(), -a, payee, cat))
    return out


def test_detects_monthly_with_next_due_and_price_change():
    d = fresh()
    d["transactions"] = _monthly("n", "Netflix", [1899, 1899, 1899, 2299, 2299], date(2026, 6, 20))
    r = subscriptions.merge(d, date(2026, 10, 31))
    s = d["subscriptions"][0]
    assert r["found"] == 1 and s["cadence"] == "monthly" and s["amount_cents"] == 2299
    assert s["next_due"] == "2026-11-20" and s["monthly_cents"] == 2299 and s["status"] == "active"
    assert s["price_change"] == {"from_cents": 1899, "to_cents": 2299, "on": "2026-09-20"}
    assert r["price_changes"] and s["confidence"] >= 0.8 and s["kind"] == "subscription"


def test_detects_weekly_fortnightly_yearly_and_monthly_equivalents():
    d = fresh()
    start = date(2026, 8, 3)
    d["transactions"] = (
        [txn(f"w{i}", (start + timedelta(days=7 * i)).isoformat(), -1500, "Hello Fresh", None) for i in range(6)]
        + [txn(f"f{i}", (start + timedelta(days=14 * i)).isoformat(), -6000, "Anytime Fitness", "fitness") for i in range(5)]
        + [txn("y0", "2024-11-10", -14900, "Amazon Prime", None), txn("y1", "2025-11-10", -14900, "Amazon Prime", None)]
    )
    subscriptions.merge(d, date(2026, 10, 31))
    by = {s["merchant"]: s for s in d["subscriptions"]}
    assert by["hello fresh"]["cadence"] == "weekly" and by["hello fresh"]["monthly_cents"] == round(1500 * 52 / 12)
    assert by["anytime fitness"]["cadence"] == "fortnightly" and by["anytime fitness"]["monthly_cents"] == 13000
    assert by["amazon prime"]["cadence"] == "yearly" and by["amazon prime"]["next_due"] == "2026-11-10"
    assert by["amazon prime"]["monthly_cents"] == round(14900 / 12)


def test_habits_and_noise_are_not_subscriptions():
    d = fresh()
    start = date(2026, 7, 4)
    shop = [8230, 9415, 7780, 10120, 8890, 9930, 8070, 9650, 8800, 9200]
    d["transactions"] = [txn(f"g{i}", (start + timedelta(days=7 * i)).isoformat(), -a, "Woolworths", "groceries") for i, a in enumerate(shop)]
    # Two charges only (monthly needs three) and a random-interval merchant.
    d["transactions"] += _monthly("s", "Stan", [1200, 1200], date(2026, 9, 1))
    d["transactions"] += [txn(f"r{i}", day, -2000, "Kmart", "shopping") for i, day in enumerate(["2026-08-01", "2026-08-09", "2026-09-23", "2026-10-01"])]
    subscriptions.merge(d, date(2026, 10, 31))
    assert d["subscriptions"] == []


def test_same_day_duplicates_maybe_cancelled_and_variable_bills():
    d = fresh()
    d["transactions"] = _monthly("sp", "Spotify", [1399, 1399, 1399], date(2026, 3, 5))
    d["transactions"].append(txn("dup", "2026-04-05", -1399, "Spotify", "subscriptions"))
    d["transactions"] += [
        txn("e0", "2025-10-02", -31244, "AGL", "utilities"), txn("e1", "2026-01-03", -42871, "AGL", "utilities"),
        txn("e2", "2026-04-02", -26010, "AGL", "utilities"), txn("e3", "2026-07-01", -38999, "AGL", "utilities"),
        txn("e4", "2026-10-01", -35555, "AGL", "utilities"),
    ]
    subscriptions.merge(d, date(2026, 10, 31))
    by = {s["merchant"]: s for s in d["subscriptions"]}
    sp = by["spotify"]
    assert sp["occurrences"] == 3 and sp["status"] == "maybe_cancelled"  # last charge 5 May, overdue
    agl = by["agl"]
    assert agl["cadence"] == "quarterly" and agl["variable"] and agl["kind"] == "bill"
    assert agl["next_due"] == "2027-01-01" and agl["amount_cents"] == round((26010 + 38999 + 35555) / 3)


def test_user_marks_survive_and_charges_after_cancel_are_flagged():
    d = fresh()
    d["transactions"] = _monthly("k", "Kayo Sports", [2500, 2500, 2500], date(2026, 6, 10))
    subscriptions.merge(d, date(2026, 8, 20))
    sid = d["subscriptions"][0]["id"]
    d["subscriptions"][0].update({"user_status": "cancelled", "cancelled_on": "2026-08-20"})
    d["transactions"] += _monthly("k2", "Kayo Sports", [2500], date(2026, 9, 10))
    subscriptions.merge(d, date(2026, 9, 12))
    s = next(s for s in d["subscriptions"] if s["id"] == sid)
    assert s["user_status"] == "cancelled" and s["charged_after_cancel"] is True
    # Ignored ones stay ignored (and kept) even if no longer detected.
    s["user_status"] = "ignored"
    d["transactions"] = []
    subscriptions.merge(d, date(2026, 9, 12))
    assert d["subscriptions"][0]["user_status"] == "ignored" and not subscriptions.is_live(d["subscriptions"][0])


# ================================================================== actions


async def test_add_edit_split_delete_transactions():
    d = fresh()
    r = await act(d, "add_transactions", {"items": [
        {"date": "2026-10-30", "amount": -45.5, "payee": "Bunnings", "category_id": "home_maintenance"},
        {"amount": -120, "payee": "Costco", "splits": [{"category_id": "groceries", "amount": -80}, {"category_id": "homewares", "amount": -40}]},
    ]})
    ids = r.result["ids"]
    assert len(ids) == 2 and d["transactions"][0]["date"] == "2026-10-31"
    costco = next(t for t in d["transactions"] if t["payee"] == "Costco")
    assert costco["amount_cents"] == -12000 and len(costco["splits"]) == 2
    with pytest.raises(ActionError, match="add up"):
        await act(d, "add_transactions", {"items": [{"amount": -10, "payee": "x", "splits": [{"category_id": "groceries", "amount": -3}]}]})
    with pytest.raises(ActionError, match="no category"):
        await act(d, "add_transactions", {"items": [{"amount": -10, "payee": "x", "category_id": "nope"}]})
    await act(d, "edit_transactions", {"items": [{"id": ids[0], "payee": "Bunnings Warehouse", "notes": "paint", "amount": -50}]})
    b = next(t for t in d["transactions"] if t["id"] == ids[0])
    assert b["payee"] == "Bunnings Warehouse" and b["payee_by"] == "user" and b["amount_cents"] == -5000
    # Determinism: the same call at the same moment makes the same ids.
    d2 = fresh()
    r2 = await act(d2, "add_transactions", {"items": [
        {"date": "2026-10-30", "amount": -45.5, "payee": "Bunnings", "category_id": "home_maintenance"},
        {"amount": -120, "payee": "Costco", "splits": [{"category_id": "groceries", "amount": -80}, {"category_id": "homewares", "amount": -40}]},
    ]})
    assert r2.result["ids"] == ids
    await act(d, "delete_transactions", {"ids": ids})
    assert d["transactions"] == []
    with pytest.raises(ActionError):
        await act(d, "delete_transactions", {"ids": ["nope"]})


async def test_up_transactions_keep_bank_fields():
    d = fresh()
    d["transactions"] = [txn("t1", "2026-10-01", -500, "Single O", None, source="up", external_id="x")]
    with pytest.raises(ActionError, match="comes from Up"):
        await act(d, "edit_transactions", {"items": [{"id": "t1", "amount": -1}]})
    await act(d, "edit_transactions", {"items": [{"id": "t1", "category_id": "eating_out"}]})
    assert d["transactions"][0]["category_by"] == "user"


async def test_categorise_always_for_payee_makes_a_rule():
    d = fresh()
    d["transactions"] = [
        txn("a", "2026-10-01", -1200, "Guzman y Gomez"), txn("b", "2026-10-08", -1350, "Guzman y Gomez"),
        txn("c", "2026-10-09", -999, "Guzman y Gomez", "eating_out", category_by="user"),
    ]
    r = await act(d, "categorise", {"ids": ["a"], "category_id": "takeaway", "always_for_payee": True})
    assert r.result == {"updated": 1, "also_updated": 1, "rules_created": 1}
    assert [t["category_id"] for t in d["transactions"]] == ["takeaway", "takeaway", "eating_out"]  # user choice kept
    assert d["rules"][0]["pattern"] == "Guzman y Gomez" and d["rules"][0]["category_id"] == "takeaway"
    with pytest.raises(ActionError):
        await act(d, "categorise", {"ids": ["a"], "category_id": "nope"})


async def test_rules_contains_regex_rename_and_refusals():
    d = fresh()
    d["transactions"] = [txn("a", "2026-10-01", -2000, "UBER *TRIP HELP.UBER.COM"), txn("b", "2026-10-02", -3000, "Uber Eats")]
    r = await act(d, "add_rule", {"pattern": r"^uber \*trip", "match": "regex", "field": "payee", "category_id": "rideshare", "rename_to": "Uber"})
    assert r.result["applied"] == 1
    a = next(t for t in d["transactions"] if t["id"] == "a")
    assert a["payee"] == "Uber" and a["category_id"] == "rideshare" and a["category_by"] == "rule"
    await act(d, "add_rule", {"pattern": "uber eats", "category_id": "takeaway"})
    assert next(t for t in d["transactions"] if t["id"] == "b")["category_id"] == "takeaway"
    with pytest.raises(ActionError, match="nested"):
        await act(d, "add_rule", {"pattern": "(a+)+$", "match": "regex", "category_id": "misc"})
    with pytest.raises(ActionError, match="needs to do something"):
        await act(d, "add_rule", {"pattern": "x"})
    rid = d["rules"][0]["id"]
    await act(d, "delete_rule", {"id": rid})
    with pytest.raises(ActionError):
        await act(d, "delete_rule", {"id": rid})


async def test_import_csv_rows_dedupes_and_learns():
    d = fresh()
    await act(d, "add_account", {"name": "CommBank Everyday", "balance": 1500})
    aid = d["accounts"][0]["id"]
    d["transactions"].append(txn("old", "2026-09-01", -2299, "Netflix", "subscriptions", account_id=aid, category_by="user",
                                 description="NETFLIX.COM MELBOURNE"))
    rows = [
        {"date": "2026-09-01", "amount": -22.99, "description": "NETFLIX.COM MELBOURNE"},  # already there
        {"date": "2026-10-01", "amount": -22.99, "description": "NETFLIX.COM MELBOURNE"},
        {"date": "2026-10-02", "amount": -4.5, "description": "VISA PURCHASE 1234 SINGLE O SURRY HILLS NSW"},
        {"date": "2026-10-02", "amount": -4.5, "description": "VISA PURCHASE 1234 SINGLE O SURRY HILLS NSW"},  # a 2nd coffee
        {"date": "2026-10-03", "amount": 2500, "description": "SALARY ACME", "category": "Salary & wages"},
    ]
    r = await act(d, "import_transactions", {"account_id": aid, "rows": rows})
    assert r.result["imported"] == 4 and r.result["skipped"] == 1
    net = next(t for t in d["transactions"] if t["date"] == "2026-10-01")
    assert net["category_id"] == "subscriptions" and net["source"] == "csv"  # learned from the earlier one
    assert sum(1 for t in d["transactions"] if t["payee"] == "Single O Surry Hills") == 2
    assert next(t for t in d["transactions"] if t["amount_cents"] == 250000)["category_id"] == "salary"
    again = await act(d, "import_transactions", {"account_id": aid, "rows": rows})
    assert again.result["imported"] == 0 and again.result["skipped"] == 5
    with pytest.raises(ActionError):
        await act(d, "import_transactions", {"account_id": "nope", "rows": rows})


async def test_budgets_move_money_and_status():
    d = fresh()
    await act(d, "set_budget", {"items": [{"category_id": "groceries", "amount": 600}, {"category_id": "eating_out", "amount": 200}]})
    d["transactions"] = [txn("p", "2026-10-01", 300000, "Pay", "salary"), txn("e", "2026-10-10", -25000, "Dinner", "eating_out")]
    st = (await act(d, "budget_status", {})).result
    assert st["month"] == "2026-10" and st["overspent"] == [{"name": "Eating out", "over_by": "$50.00"}]
    r = await act(d, "move_money", {"amount": 50, "from_category_id": "groceries", "to_category_id": "eating_out"})
    assert "Moved $50.00 from Groceries to Eating out" == r.summary
    st = (await act(d, "budget_status", {})).result
    assert st["overspent"] == []
    with pytest.raises(ActionError, match="only has"):
        await act(d, "move_money", {"amount": 5000, "from_category_id": "groceries", "to_category_id": "travel"})
    with pytest.raises(ActionError):
        await act(d, "move_money", {"amount": 5})
    await act(d, "set_settings", {"zero_based": True})
    st = (await act(d, "budget_status", {})).result
    assert "to_be_budgeted" not in st and "Budgeting starts 2026-11" in st["note"]  # before the budget start
    await act(d, "set_settings", {"budget_start": "2026-10"})
    st = (await act(d, "budget_status", {})).result
    assert st["to_be_budgeted"] == "$2,200.00"
    await act(d, "set_budget", {"items": [{"category_id": "travel", "amount": 100, "month": "2026-11"}]})
    assert next(m for m in d["months"] if m["month"] == "2026-11")["assigned"]["travel"] == 10000


async def test_categories_goals_accounts_settings():
    d = fresh()
    r = await act(d, "add_category", {"name": "Car rego", "group_name": "Sinking funds", "budget": 70, "rollover": True})
    assert any(c["id"] == r.result["id"] and c["budget_cents"] == 7000 for c in d["categories"])
    with pytest.raises(ActionError, match="already"):
        await act(d, "add_category", {"name": "Groceries"})
    await act(d, "add_account", {"name": "Emergency saver", "type": "saver", "balance": 2000})
    aid = d["accounts"][0]["id"]
    g = await act(d, "add_goal", {"name": "Emergency fund", "target": 12000, "target_date": "2027-10-31", "account_id": aid})
    assert g.result["saved"] == "$2,000.00" and g.result["per_month_needed"] == "$833.34"
    await act(d, "update_account", {"id": aid, "balance": 3000})
    o = (await act(d, "accounts_overview", {})).result
    assert o["net_worth"] == "$3,000.00" and o["goals"][0]["saved"] == "$3,000.00"
    await act(d, "update_goal", {"id": g.result["id"], "done": True})
    with pytest.raises(ActionError):
        await act(d, "update_goal", {"id": "nope"})
    await act(d, "set_settings", {"month_start_day": 15, "pay_frequency": "fortnightly", "next_payday": "2026-11-06", "currency": "aud"})
    assert d["settings"]["month_start_day"] == 15 and d["settings"]["currency"] == "AUD" and d["settings"]["onboarded"]
    with pytest.raises(ActionError):
        await act(d, "set_settings", {"up_category_map": {"groceries": "nope"}})
    d["accounts"][0]["source"] = "up"
    with pytest.raises(ActionError, match="from Up"):
        await act(d, "update_account", {"id": aid, "balance": 1})


async def test_subscription_actions_and_reports():
    d = fresh()
    d["transactions"] = _monthly("n", "Netflix", [2299, 2299, 2299], date(2026, 8, 20))
    r = await act(d, "detect_subscriptions", {})
    assert r.result["found"] == 1 and "$22.99 a month" in r.summary
    sid = d["subscriptions"][0]["id"]
    await act(d, "mark_subscription", {"id": sid, "status": "cancelled"})
    assert d["subscriptions"][0]["user_status"] == "cancelled" and d["subscriptions"][0]["cancelled_on"] == "2026-10-31"
    await act(d, "add_subscription", {"name": "Car insurance", "amount": 720, "cadence": "yearly", "next_due": "2027-02-01", "kind": "bill"})
    rep = (await act(d, "subscriptions_report", {})).result
    assert rep["active_count"] == 1 and rep["per_month"] == "$60.00" and rep["per_year"] == "$720.00"
    with pytest.raises(ActionError):
        await act(d, "mark_subscription", {"id": "nope", "status": "ignored"})


async def test_read_only_analysis_actions():
    d = fresh()
    d["transactions"] = [
        txn("p", "2026-10-01", 300000, "Pay", "salary"),
        txn("g", "2026-10-03", -12000, "Woolworths", "groceries"),
        txn("g2", "2026-10-10", -8000, "Coles", "groceries"),
        txn("e", "2026-10-12", -5000, "Dinner", "eating_out"),
        txn("u", "2026-10-13", -1000, "Mystery", None),
        txn("s", "2026-09-03", -9000, "Woolworths", "groceries"),
        txn("x", "2026-10-14", -50000, "To saver", None, transfer=True),
    ]
    s = (await act(d, "spending_summary", {})).result
    assert s["total_spent"] == "$260.00" and s["top"][0]["name"] == "Groceries" and s["top"][0]["spent"] == "$200.00"
    m = (await act(d, "spending_summary", {"by": "merchant", "start": "2026-09-01", "end": "2026-10-31"})).result
    assert m["top"][0]["name"] == "Woolworths" and m["top"][0]["spent"] == "$210.00"
    c = (await act(d, "cashflow", {"months": 2})).result
    assert c["money_in"] == "$3,000.00" and c["money_out"] == "$350.00" and len(c["periods"]) == 2
    f = (await act(d, "find_transactions", {"query": "woolworths"})).result
    assert f["matches"] == 2 and f["net_total"] == "-$210.00"
    f = (await act(d, "find_transactions", {"uncategorised": True})).result
    assert [t["id"] for t in f["transactions"]] == ["u"]
    fc = (await act(d, "forecast_month_end", {})).result
    assert fc["days_left"] == 0 and fc["spent_so_far"] == "$260.00"
    with pytest.raises(ActionError):
        await act(d, "spending_summary", {"start": "2026-10-10", "end": "2026-10-01"})


def test_tools_have_no_refs_and_include_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names
    assert "$ref" not in json.dumps(tools)
    ro = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "budget_status" in ro and "categorise" not in ro


def test_to_text_and_reminders():
    d = fresh()
    d["accounts"] = [{"id": "a", "name": "Spending", "type": "transactional", "balance_cents": 123456}]
    d["transactions"] = _monthly("n", "Netflix", [2299, 2299, 2299], date(2026, 8, 1))
    for c in d["categories"]:
        if c["id"] == "subscriptions":
            c["budget_cents"] = 1000
    d = SPEC.validate(d)
    subscriptions.merge(d, date(2026, 10, 31))
    text = SPEC.to_text(d)
    assert "Spending" in text and "$1,234.56" in text and "Netflix" in text and "Subscriptions & bills" in text
    rem = SPEC.reminders(d, ctx(datetime(2026, 10, 15, 8, 0, tzinfo=TZ)))
    keys = {r.key for r in rem}
    sub = next(r for r in rem if r.key.startswith("sub:"))
    assert sub.due_at == datetime(2026, 10, 31, 9, 0, tzinfo=TZ) and "Netflix tomorrow" in sub.title
    assert "over:2026-10:subscriptions" in keys
    d["settings"]["bill_reminders"] = False
    d["settings"]["overspend_alerts"] = False
    assert SPEC.reminders(d, ctx(datetime(2026, 10, 15, 8, 0, tzinfo=TZ))) == []


# ============================================================ Up (pure)


def test_up_mapping_of_a_documented_transaction():
    m = up.map_transaction(up_txn("t1", "2026-10-15T23:30:00Z", -4120, "Lawson", category="groceries", parent="home",
                                  foreign=(-400000, "JPY"), round_up=-80, cashback=150, tags=["Holiday"], raw="LAWSON TOKYO",
                                  message="snacks"), TZ)
    assert m["date"] == "2026-10-16"  # local day in Sydney
    assert m["amount_cents"] == -4120 and m["foreign"] == {"amount_cents": -400000, "currency": "JPY"}
    assert m["round_up_cents"] == -80 and m["cashback_cents"] == 150 and m["tags"] == ["Holiday"]
    assert m["payee"] == "Lawson" and m["description"] == "LAWSON TOKYO" and not m["pending"] and not m["transfer"]
    a = up.map_account(ACCOUNTS[2])
    assert a["type"] == "home_loan" and a["balance_cents"] == -45000000


def test_merge_up_dedupes_settles_flags_transfers_and_keeps_user_edits():
    d = fresh()
    st = up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    assert st.added == 10 and st.accounts == 3
    by = {t["external_id"]: t for t in d["transactions"]}
    assert by["tx-coffee-held"]["pending"] and by["tx-coffee-held"]["category_id"] == "eating_out"
    assert by["tx-woolies"]["category_id"] == "groceries" and by["tx-woolies"]["round_up_cents"] == -68
    for ext in ("tx-roundup", "tx-save", "tx-save-in"):
        assert by[ext]["transfer"] and by[ext]["category_id"] is None
    assert by["tx-save"]["transfer_account_id"] == up.account_id_for("acc-saver")
    assert by["tx-pay"]["category_id"] is None and by["tx-pay"]["notes"] == "Pay"
    assert by["tx-mystery"]["category_id"] == "misc"  # unknown Up child → parent fallback
    assert by["tx-mystery"]["tags"] == ["work"]
    assert by["tx-netflix"]["category_id"] == "subscriptions"
    accts = {a["external_id"]: a for a in d["accounts"]}
    assert accts["acc-saver"]["type"] == "saver" and accts["acc-home"]["on_budget"] is False
    # Transfers don't count as spending.
    s = logic.spending(d, date(2026, 10, 1), date(2026, 10, 31))
    assert s["spent"] == 550 + 8432 + 2299 + 4120 + 999

    # The person re-categorises Woolworths; then Up settles the coffee and resends everything.
    by["tx-woolies"].update({"category_id": "shopping", "category_by": "user"})
    again = first_sync_txns()
    again[0]["attributes"]["status"] = "SETTLED"
    again[0]["attributes"]["settledAt"] = "2026-10-31T09:00:00+11:00"
    again[0]["attributes"]["amount"] = up_money(-600)
    st = up.merge_up(d, ACCOUNTS, again, tz=TZ, now=NOW)
    by = {t["external_id"]: t for t in d["transactions"]}
    assert st.added == 0 and st.settled == 1 and len(d["transactions"]) == 10
    assert not by["tx-coffee-held"]["pending"] and by["tx-coffee-held"]["amount_cents"] == -600
    assert by["tx-woolies"]["category_id"] == "shopping"


def test_merge_up_removes_released_holds_only_inside_a_complete_window():
    d = fresh()
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    rest = [t for t in first_sync_txns() if t["id"] != "tx-coffee-held"]
    up.merge_up(d, [], rest, tz=TZ, now=NOW, window_start="2026-10-01T00:00:00Z", complete=False)
    assert any(t["external_id"] == "tx-coffee-held" for t in d["transactions"])
    st = up.merge_up(d, [], rest, tz=TZ, now=NOW, window_start="2026-10-01T00:00:00Z", complete=True)
    assert st.removed == 1 and not any(t["external_id"] == "tx-coffee-held" for t in d["transactions"])


def test_merge_up_applies_rules_and_learned_payees():
    d = fresh()
    d["rules"] = [{"id": "r", "field": "payee", "match": "contains", "pattern": "netflix", "category_id": "entertainment"}]
    d = SPEC.validate(d)
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    t = next(t for t in d["transactions"] if t["external_id"] == "tx-netflix")
    assert t["category_id"] == "entertainment" and t["category_by"] == "rule"


def test_signature_and_token_checks():
    body = b'{"data":{"type":"webhook-events"}}'
    sig = hmac.new(b"sekret", body, hashlib.sha256).hexdigest()
    assert up.verify_signature("sekret", body, sig)
    assert not up.verify_signature("sekret", body + b" ", sig)
    assert not up.verify_signature("sekret", body, "")
    assert up.clean_token("  Bearer " + TOKEN + "\n") == TOKEN
    with pytest.raises(up.UpError):
        up.clean_token("not a token")


async def test_client_backs_off_on_429_and_refuses_offsite_links(fake_up):
    fake_up.status_override = [429, 429]
    async with up.UpClient(TOKEN) as c:
        assert (await c.ping())["meta"]["statusEmoji"]
        with pytest.raises(up.UpError, match="somewhere else"):
            await c.request("GET", "https://evil.example.com/steal")
    fake_up.status_override = [429, 429, 429, 429]
    async with up.UpClient(TOKEN) as c:
        with pytest.raises(up.UpRateLimited):
            await c.ping()
    async with up.UpClient("up:yeah:wrong") as c:
        with pytest.raises(up.UpAuthError):
            await c.ping()


async def test_client_paginates(fake_up):
    async with up.UpClient(TOKEN) as c:
        rows, complete = await c.transactions(since="2026-01-01T00:00:00Z")
    assert complete and len(rows) == 10 and len({r["id"] for r in rows}) == 10
    pages = [c for c in fake_up.calls if c[1] == "/transactions"]
    assert len(pages) == 3  # 4 + 4 + 2
    assert fake_up.calls[0][2]["page[size]"] == "100" and fake_up.calls[0][2]["filter[since]"] == "2026-01-01T00:00:00Z"
    async with up.UpClient(TOKEN) as c:
        rows, complete = await c.transactions(since="2026-01-01T00:00:00Z", max_pages=1)
    assert not complete and len(rows) == 4


# ================================================================ API


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def _new_budget(client, user) -> dict:
    r = await client.post("/api/items/store/budget", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "budget", "title": "Household"})
    assert r.status_code == 201, r.text
    return r.json()


async def test_end_to_end_api_flow(client, user):
    item = await _new_budget(client, user)
    fid = item["file_id"]
    assert item["filename"] == "Household.budget" and item["data"]["settings"]["currency"] == "AUD"
    r = await client.post(f"/api/items/{fid}/actions/add_transactions", headers=_auth(user),
                          json={"args": {"items": [{"amount": -12.5, "payee": "Bakery", "category_id": "groceries"}]}})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["transactions"][0]["amount_cents"] == -1250
    r = await client.post(f"/api/items/{fid}/actions/budget_status", headers=_auth(user), json={})
    assert r.status_code == 200 and r.json()["result"]["spent"] == "$12.50"
    r = await client.post(f"/api/items/{fid}/actions/categorise", headers=_auth(user), json={"args": {"ids": ["nope"], "category_id": "groceries"}})
    assert r.status_code == 400
    data = r.json() and (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    body = data["data"]
    body["settings"]["month_start_day"] = 15
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": body, "base_revision": data["revision"]})
    assert r.status_code == 200 and r.json()["data"]["settings"]["month_start_day"] == 15


async def test_up_connect_sync_status_and_secrets(client, db, user, fake_up):
    from sqlalchemy import select

    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings
    from app.files.models import UserFile
    from app.items.models import ItemState

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    if row is None:
        row = AppSettings(id=SINGLETON_APP_SETTINGS_ID)
        db.add(row)
    row.public_origins = ["http://localhost:8087", "https://money.example.com"]
    await db.commit()

    item = await _new_budget(client, user)
    fid = item["file_id"]
    bad = await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": "up:yeah:wrongtoken"})
    assert bad.status_code == 400 and "didn't accept" in bad.json()["detail"]
    r = await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["connected"] and out["webhook"] and out["sync"]["ok"] and out["sync"]["added"] == 10
    assert len(out["data"]["accounts"]) == 3 and len(out["data"]["transactions"]) == 10
    assert fake_up.webhooks["wh-1"]["url"] == f"https://money.example.com/api/items/k/budget/hook/{fid}"
    assert out["up_categories"][0]["id"] == "groceries"
    # The token is never in the response, the file, its text, or stored in the clear.
    assert TOKEN not in r.text and "whsec-very-secret" not in r.text
    got = await client.get(f"/api/items/{fid}", headers=_auth(user))
    assert TOKEN not in got.text
    f = await db.get(UserFile, uuid.UUID(fid))
    await db.refresh(f)
    assert TOKEN not in (f.content_text or "")
    states = (await db.execute(select(ItemState).where(ItemState.file_id == uuid.UUID(fid)))).scalars().all()
    assert {s.key for s in states} >= {"up_token", "up_webhook", "up_cursor"}
    for s in states:
        assert TOKEN not in json.dumps(s.value) and "whsec-very-secret" not in json.dumps(s.value)
    st = await client.get(f"/api/items/k/budget/{fid}/up/status", headers=_auth(user))
    assert st.status_code == 200 and st.json()["connected"] and st.json()["status"] == "ok" and TOKEN not in st.text

    # A new charge + the held coffee settles; incremental sync picks both up.
    fake_up.txns[0]["attributes"]["status"] = "SETTLED"
    fake_up.txns.append(up_txn("tx-new", "2026-10-31T10:00:00+11:00", -1599, "Spotify", category="tv-and-music", parent="good-life"))
    fake_up.calls.clear()
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert r.status_code == 200 and r.json()["sync"]["added"] == 1 and r.json()["sync"]["settled"] == 1
    since = next(c[2]["filter[since]"] for c in fake_up.calls if c[1] == "/transactions")
    assert since < "2026-10-30T00:00:00Z"  # re-read back to the held one
    assert len(r.json()["data"]["transactions"]) == 11

    # A stranger and a view-only reader can't touch the connection.
    from app.auth.models import User

    other = User(email=f"o-{uuid.uuid4().hex[:6]}@example.com", username=f"o{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(other)
    await db.commit()
    await db.refresh(other)
    assert (await client.get(f"/api/items/k/budget/{fid}/up/status", headers=_auth(other))).status_code == 404
    assert (await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(other))).status_code == 404

    # Webhook: bad signature refused; a good one fetches just that transaction.
    fake_up.txns.append(up_txn("tx-hook", "2026-10-31T11:00:00+11:00", -800, "Bourke St Bakery", category="restaurants-and-cafes"))
    payload = json.dumps({"data": {"type": "webhook-events", "id": "ev1", "attributes": {"eventType": "TRANSACTION_CREATED", "createdAt": "2026-10-31T11:00:01+11:00"},
                                   "relationships": {"webhook": {"data": {"type": "webhooks", "id": "wh-1"}},
                                                     "transaction": {"data": {"type": "transactions", "id": "tx-hook"}}}}}).encode()
    nope = await client.post(f"/api/items/k/budget/hook/{fid}", content=payload, headers={"X-Up-Authenticity-Signature": "00"})
    assert nope.status_code == 401
    sig = hmac.new(b"whsec-very-secret", payload, hashlib.sha256).hexdigest()
    ok = await client.post(f"/api/items/k/budget/hook/{fid}", content=payload, headers={"X-Up-Authenticity-Signature": sig})
    assert ok.status_code == 200
    data = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()["data"]
    assert any(t["external_id"] == "tx-hook" for t in data["transactions"])
    # TRANSACTION_DELETED removes it.
    deleted = payload.replace(b"TRANSACTION_CREATED", b"TRANSACTION_DELETED")
    sig = hmac.new(b"whsec-very-secret", deleted, hashlib.sha256).hexdigest()
    assert (await client.post(f"/api/items/k/budget/hook/{fid}", content=deleted, headers={"X-Up-Authenticity-Signature": sig})).status_code == 200
    data = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()["data"]
    assert not any(t["external_id"] == "tx-hook" for t in data["transactions"])

    # Disconnect forgets the token and removes the webhook at Up.
    r = await client.delete(f"/api/items/k/budget/{fid}/up", headers=_auth(user))
    assert r.status_code == 200 and not r.json()["connected"] and fake_up.webhooks == {}
    states = (await db.execute(select(ItemState.key).where(ItemState.file_id == uuid.UUID(fid)))).scalars().all()
    assert "up_token" not in states and "up_webhook" not in states
    assert (await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))).status_code == 400
    # The transactions stay.
    assert len(r.json()["data"]["transactions"]) == 11


async def test_revoked_token_disconnects_and_periodic_sync(client, db, user, fake_up):
    from app.database import SessionLocal
    from app.items import service
    from app.items.models import ItemReminder
    from app.items.spec import PeriodicContext
    from sqlalchemy import select

    item = await _new_budget(client, user)
    fid = uuid.UUID(item["file_id"])
    r = await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    assert r.status_code == 200 and not r.json()["webhook"]  # no public https origin here

    async def periodic_once():
        async with SessionLocal() as s:
            owner = await s.get(type(user), user.id)
            base = service.make_context(s, owner, fid, SPEC)

            async def get_state(key, secret=False):
                return await service.get_state(s, fid, key, secret=secret)

            pctx = PeriodicContext(db=s, user=owner, file_id=fid, now=base.now, tz=base.tz, get_state=get_state)
            await SPEC.periodic(pctx)

    fake_up.txns.append(up_txn("tx-p", "2026-10-31T10:00:00+11:00", -1000, "Opal", category="public-transport"))
    await periodic_once()
    data = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()["data"]
    assert any(t["external_id"] == "tx-p" for t in data["transactions"])

    # Up starts refusing the token (revoked in the Up app).
    fake_up.status_override = [401]
    await periodic_once()
    data = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()["data"]
    assert data["up"]["status"] == "disconnected" and not data["up"]["connected"] and "revoked" in data["up"]["last_error"]
    async with SessionLocal() as s:
        assert await service.get_state(s, fid, "up_token", secret=True) is None
        rems = (await s.execute(select(ItemReminder.title).where(ItemReminder.file_id == fid))).scalars().all()
    assert "Up Bank disconnected" in rems
    st = (await client.get(f"/api/items/k/budget/{fid}/up/status", headers=_auth(user))).json()
    assert not st["connected"] and st["status"] == "disconnected"
    # Periodic now does nothing (no token) — and makes no request.
    fake_up.calls.clear()
    await periodic_once()
    assert fake_up.calls == []


async def test_first_sync_backfills_beyond_one_pass(client, user, fake_up, monkeypatch):
    monkeypatch.setattr(up, "MAX_PAGES_PER_PASS", 1)
    item = await _new_budget(client, user)
    fid = item["file_id"]
    r = await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    assert r.json()["sync"]["added"] == 4
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert len(r.json()["data"]["transactions"]) == 8
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert len(r.json()["data"]["transactions"]) == 10


# ======================================================== fix pass (review)


def _cat_set(d: dict, cid: str, **kw) -> None:
    for c in d["categories"]:
        if c["id"] == cid:
            c.update(kw)


def test_stored_transactions_are_slim_and_a_full_file_fits():
    from app.items.kinds.budget.models import MAX_TRANSACTIONS, full_txn

    d = fresh()
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    clean = SPEC.validate(d)
    t = next(t for t in clean["transactions"] if t["external_id"] == "tx-woolies")
    for k in ("notes", "splits", "pending", "transfer", "transfer_account_id", "foreign", "cashback_cents", "category_by", "review"):
        assert k not in t, k
    assert t["round_up_cents"] == -68 and t["category_id"] == "groceries"
    assert SPEC.validate(clean) == clean  # stable
    slim = len(json.dumps(clean["transactions"]))
    full = len(json.dumps([full_txn(x) for x in clean["transactions"]]))
    assert slim < 0.75 * full
    # A file at the transaction cap still fits the 8 MB limit with room to spare.
    one = json.dumps(t)
    assert len(one) * MAX_TRANSACTIONS < 0.8 * SPEC.max_bytes
    # Defaults come back when read through the model.
    assert BudgetData.model_validate(clean).transactions[0].splits == []


def test_sort_never_trims_history(monkeypatch):
    d = fresh()
    d["transactions"] = [txn(f"t{i}", "2026-10-01", -100, "x") for i in range(5)]
    monkeypatch.setattr(up, "MAX_TRANSACTIONS", 2)
    up.sort_transactions(d)
    assert len(d["transactions"]) == 5


def _budget_history() -> dict:
    d = fresh()
    d["settings"]["budget_start"] = "2026-08"
    _cat_set(d, "groceries", budget_cents=60000, rollover=True)
    _cat_set(d, "eating_out", budget_cents=20000)
    d["accounts"] = [{"id": "a", "name": "Spending", "balance_cents": 1000}]
    d["rules"] = [{"id": "r", "pattern": "coles", "category_id": "groceries"}]
    d["goals"] = [{"id": "g", "name": "Trip", "target_cents": 100000}]
    d["transactions"] = [
        txn("p8", "2026-08-01", 300000, "Pay", "salary"),
        txn("g8", "2026-08-05", -40000, "Coles", "groceries"),
        txn("u8", "2026-08-06", -1500, "Mystery"),
        txn("p9", "2026-09-01", 300000, "Pay", "salary"),
        txn("g9", "2026-09-20", -70000, "Coles", "groceries"),
        txn("e9", "2026-09-21", -5000, "Dinner", "eating_out"),
        txn("p10", "2026-10-01", 300000, "Pay", "salary"),
        txn("g10", "2026-10-02", -10000, "Coles", "groceries"),
    ]
    return SPEC.validate(d)


def test_archive_keeps_everything_but_old_transactions_and_the_budget_numbers():
    d = _budget_history()
    before = logic.budget_table(d, "2026-10")
    kept, arch = SPEC.archive(d, ctx(), "2026-09-17")  # → cut at the 1 Sept month start
    kept, arch = SPEC.validate(kept), SPEC.validate(arch)
    assert {t["id"] for t in kept["transactions"]} == {"p9", "g9", "e9", "p10", "g10"}
    assert {t["id"] for t in arch["transactions"]} == {"p8", "g8", "u8"}
    for k in ("accounts", "categories", "groups", "rules", "goals", "subscriptions", "months", "settings"):
        assert kept[k] == d[k] and arch[k] == d[k] or k == "settings"
    assert kept["carry_in"] == {"month": "2026-09", "available": {"groceries": 20000}, "to_be_budgeted": 300000 - 80000 - 1500 + 20000}
    after = logic.budget_table(kept, "2026-10")
    assert after["to_be_budgeted"] == before["to_be_budgeted"]
    assert [r["available"] for r in after["rows"]] == [r["available"] for r in before["rows"]]
    assert kept["up"]["archived_before"] == "2026-09-01" and not arch["up"]["connected"]
    # A later sync never re-adds Up transactions from before the cut.
    st = up.merge_up(kept, [], [up_txn("old", "2026-08-10T10:00:00+10:00", -500, "Old"), up_txn("new", "2026-10-20T10:00:00+11:00", -500, "New")],
                     tz=TZ, now=NOW)
    assert st.added == 1 and not any(t.get("external_id") == "old" for t in kept["transactions"])
    with pytest.raises(ActionError, match="no transactions"):
        SPEC.archive(kept, ctx(), "2026-01-15")


async def test_archive_through_the_api(client, user):
    item = await _new_budget(client, user)
    fid = item["file_id"]
    body = _budget_history()
    got = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": body, "base_revision": got["revision"]})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()["can_archive"]
    r = await client.post(f"/api/items/{fid}/archive", headers=_auth(user), json={"before": "2026-10-01"})
    assert r.status_code == 200, r.text
    assert {t["id"] for t in r.json()["data"]["transactions"]} == {"p10", "g10"}
    arch = (await client.get(f"/api/items/{r.json()['archive_id']}", headers=_auth(user))).json()
    assert len(arch["data"]["transactions"]) == 6


def test_split_follows_a_bank_amount_change():
    d = fresh()
    held = up_txn("tx-dinner", "2026-10-30T19:00:00+11:00", -10000, "Chin Chin", status="HELD", category="restaurants-and-cafes")
    up.merge_up(d, ACCOUNTS, [held], tz=TZ, now=NOW)
    t = d["transactions"][0]
    t.update(splits=[{"category_id": "eating_out", "amount_cents": -6000, "note": ""}, {"category_id": "gifts", "amount_cents": -4000, "note": ""}],
             category_id=None, category_by="user")
    tip = up_txn("tx-dinner", "2026-10-30T19:00:00+11:00", -11500, "Chin Chin", category="restaurants-and-cafes")
    up.merge_up(d, [], [tip], tz=TZ, now=NOW)
    t = d["transactions"][0]
    assert [s["amount_cents"] for s in t["splits"]] == [-7500, -4000] and sum(c for _, c in logic.txn_lines(t)) == -11500
    assert "largest part" in t["review"]
    # Settled for much less: the difference would flip the big part → cleared and flagged.
    small = up_txn("tx-dinner", "2026-10-30T19:00:00+11:00", -1000, "Chin Chin", category="restaurants-and-cafes")
    up.merge_up(d, [], [small], tz=TZ, now=NOW)
    t = d["transactions"][0]
    assert t["splits"] == [] and t["category_by"] == "auto" and "cleared" in t["review"]
    assert t["category_id"] == "eating_out"  # back to the bank's category; money is never lost
    assert sum(c for _, c in logic.txn_lines(t)) == -1000
    assert "[needs a look]" in SPEC.to_text(SPEC.validate(d))


async def test_editing_clears_the_review_flag():
    d = fresh()
    d["transactions"] = [txn("a", "2026-10-02", -500, "x", review="check")]
    await act(d, "edit_transactions", {"items": [{"id": "a", "notes": "ok"}]})
    assert not d["transactions"][0].get("review")


def test_off_budget_and_archived_accounts_are_left_out():
    d = fresh()
    d["settings"]["budget_start"] = "2026-10"
    d["accounts"] = [{"id": "s", "name": "Spending", "balance_cents": 0}, {"id": "h", "name": "Home loan", "type": "home_loan", "on_budget": False},
                     {"id": "old", "name": "Old card", "archived": True}]
    d["transactions"] = [
        txn("pay", "2026-10-01", 500000, "Pay", "salary", account_id="s"),
        txn("food", "2026-10-03", -10000, "Coles", "groceries", account_id="s"),
        txn("int", "2026-10-05", -150000, "Interest", "life_admin", account_id="h"),
        txn("fee", "2026-10-06", -2000, "Card fee", "life_admin", account_id="old"),
        txn("cash", "2026-10-07", -700, "Cash coffee", "eating_out"),  # no account → counts
    ]
    for m in (8, 9):
        d["transactions"].append(txn(f"int{m}", f"2026-0{m}-05", -150000, "Interest", "life_admin", account_id="h"))
    d = SPEC.validate(d)
    s = logic.spending(d, date(2026, 10, 1), date(2026, 10, 31))
    assert s["spent"] == 10700 and s["income"] == 500000
    assert logic.spending(d, date(2026, 10, 1), date(2026, 10, 31), account_id="h")["spent"] == 150000  # asked for by name
    t = logic.budget_table(d, "2026-10")
    assert t["spent"] == 10700 and next(r for r in t["rows"] if r["id"] == "life_admin")["spent"] == 0
    assert logic.cashflow(d, date(2026, 10, 1), date(2026, 10, 31))["out"] == 10700
    assert not any(x["merchant"] == "interest" for x in subscriptions.detect(d, date(2026, 10, 31)))


def test_budget_start_default_and_months_before_it():
    assert logic.default_budget_start(date(2026, 10, 31)) == "2026-11"
    assert logic.default_budget_start(date(2026, 11, 1)) == "2026-11"
    assert logic.default_budget_start(date(2026, 10, 15), 15) == "2026-10"
    assert logic.default_budget_start(date(2026, 10, 16), 15) == "2026-11"
    d = fresh()
    _cat_set(d, "groceries", budget_cents=50000, rollover=True)
    d["transactions"] = [txn("p", "2026-10-01", 100000, "Pay", "salary"), txn("g", "2026-10-02", -20000, "Coles", "groceries"),
                         txn("p2", "2026-11-01", 100000, "Pay", "salary")]
    oct_ = logic.budget_table(d, "2026-10")
    assert oct_["before_start"] and oct_["to_be_budgeted"] == 0
    assert next(r for r in oct_["rows"] if r["id"] == "groceries")["available"] == 30000  # shown, on its own
    nov = logic.budget_table(d, "2026-11")
    g = next(r for r in nov["rows"] if r["id"] == "groceries")
    assert not nov["before_start"] and g["carried"] == 0  # October's leftover doesn't roll into the start
    assert nov["to_be_budgeted"] == 100000 - 50000  # only income since the start


def test_non_rollover_leftovers_go_back_to_be_budgeted_and_money_is_conserved():
    d = fresh()
    d["settings"]["budget_start"] = "2026-08"
    _cat_set(d, "groceries", budget_cents=60000)  # no rollover
    _cat_set(d, "travel", budget_cents=20000, rollover=True)
    d["transactions"] = []
    spent = 0
    for m in ("08", "09", "10"):
        d["transactions"] += [txn(f"p{m}", f"2026-{m}-01", 200000, "Pay", "salary"), txn(f"g{m}", f"2026-{m}-10", -45000, "Coles", "groceries"),
                              txn(f"u{m}", f"2026-{m}-12", -1000, "Something")]
        spent += 46000
    t = logic.budget_table(d, "2026-10")
    g = next(r for r in t["rows"] if r["id"] == "groceries")
    tr = next(r for r in t["rows"] if r["id"] == "travel")
    assert g["carried"] == 0 and g["available"] == 15000 and tr["available"] == 60000
    # Every dollar is somewhere: to be budgeted + what's in the envelopes = income − spending.
    assert t["to_be_budgeted"] + sum(r["available"] for r in t["rows"]) == 3 * 200000 - spent
    # Aug + Sep groceries leftovers ($150 each) came back.
    assert t["to_be_budgeted"] == 600000 - 3 * 80000 - 3000 + 2 * 15000


def test_overspent_rule_matches_the_ui():
    assert logic.is_overspent({"available": -1, "assigned": 100, "carried": 0})
    assert logic.is_overspent({"available": -1, "assigned": 0, "carried": -50})
    assert not logic.is_overspent({"available": -1, "assigned": 0, "carried": 0})  # never budgeted
    assert not logic.is_overspent({"available": 5, "assigned": 0, "carried": 5})


async def test_unmarking_a_transfer_sticks_through_syncs():
    d = fresh()
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    tid = next(t["id"] for t in d["transactions"] if t["external_id"] == "tx-save")
    await act(d, "edit_transactions", {"items": [{"id": tid, "transfer": False}]})
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    t = next(t for t in d["transactions"] if t["id"] == tid)
    assert t.get("transfer", False) is False and t["transfer_by"] == "user"
    # A "mark as transfer" rule doesn't override the person either.
    d["rules"] = [{"id": "r", "pattern": "transfer to holiday", "mark_transfer": True}]
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    assert next(t for t in d["transactions"] if t["id"] == tid).get("transfer", False) is False


def test_up_transaction_type_and_categorizable_flags():
    rt = up_txn("x1", "2026-10-20T10:00:00+11:00", 33, "Round Up from Spending", account="acc-saver")
    rt["attributes"].update(transactionType="Round Up", isCategorizable=False)
    m = up.map_transaction(rt, TZ)
    assert m["transfer"]
    interest = up_txn("x2", "2026-10-31T10:00:00+11:00", 1234, "Interest", account="acc-saver")
    interest["attributes"].update(transactionType="Interest", isCategorizable=False)
    m = up.map_transaction(interest, TZ)
    assert not m["transfer"] and m["interest"]
    cover = up_txn("x3", "2026-10-20T10:00:00+11:00", -500, "Cover from Holiday")
    cover["attributes"]["isCategorizable"] = False
    assert up.map_transaction(cover, TZ)["transfer"]
    d = fresh()
    up.merge_up(d, ACCOUNTS, [interest], tz=TZ, now=NOW)
    assert d["transactions"][0]["category_id"] == "other_income"


def test_released_hold_edits_carry_to_the_settled_replacement():
    d = fresh()
    up.merge_up(d, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    hold = next(t for t in d["transactions"] if t["external_id"] == "tx-coffee-held")
    hold.update(category_id="shopping", category_by="user", notes="with Sam")
    rest = [t for t in first_sync_txns() if t["id"] != "tx-coffee-held"]
    # Up released the hold; the replacement isn't there yet.
    st = up.merge_up(d, [], rest, tz=TZ, now=NOW, window_start="2026-10-01T00:00:00Z", complete=True)
    assert st.removed == 1 and st.carried == 0 and len(st.waiting) == 1
    final = up_txn("tx-coffee-final", "2026-10-31T07:00:00+11:00", -600, "Single O", category="restaurants-and-cafes")
    st2 = up.merge_up(d, [], rest + [final], tz=TZ, now=NOW, window_start="2026-10-01T00:00:00Z", complete=True, carry=st.waiting)
    t = next(t for t in d["transactions"] if t["external_id"] == "tx-coffee-final")
    assert st2.carried == 1 and st2.waiting == []
    assert t["category_id"] == "shopping" and t["category_by"] == "user" and t["notes"] == "with Sam"
    # Something unrelated never inherits (another merchant, far off amount).
    d2 = fresh()
    up.merge_up(d2, ACCOUNTS, first_sync_txns(), tz=TZ, now=NOW)
    next(t for t in d2["transactions"] if t["external_id"] == "tx-coffee-held").update(category_id="shopping", category_by="user")
    other = up_txn("tx-other", "2026-10-31T07:00:00+11:00", -600, "Bakery")
    st3 = up.merge_up(d2, [], rest + [other], tz=TZ, now=NOW, window_start="2026-10-01T00:00:00Z", complete=True)
    assert st3.carried == 0 and next(t for t in d2["transactions"] if t["external_id"] == "tx-other").get("category_by") != "user"


def test_released_holds_compare_real_times_not_strings():
    d = fresh()
    # 09:00 on 1 Oct in Sydney is 22:00 UTC on 30 Sep — before a 23:00Z window.
    up.merge_up(d, ACCOUNTS, [up_txn("h", "2026-10-01T09:00:00+10:00", -500, "Hotel", status="HELD")], tz=TZ, now=NOW)
    st = up.merge_up(d, [], [], tz=TZ, now=NOW, window_start="2026-09-30T23:30:00Z", complete=True)
    assert st.removed == 0 and len(d["transactions"]) == 1
    st = up.merge_up(d, [], [], tz=TZ, now=NOW, window_start="2026-09-30T22:30:00Z", complete=True)
    assert st.removed == 1


def test_forecast_pace_leaves_out_rent_bills_and_one_offs():
    d = fresh()
    d["settings"]["budget_start"] = "2026-10"
    d["transactions"] = [
        txn("rent", "2026-10-01", -250000, "Ray White", "rent"),
        txn("tv", "2026-10-02", -129900, "JB Hi-Fi", "technology"),  # a one-off
        *[txn(f"c{i}", f"2026-10-{i:02d}", -2000, "Cafe", "eating_out") for i in range(1, 11)],
    ]
    r = logic.forecast(SPEC.validate(d), date(2026, 10, 10))
    assert r["daily_pace"] == 2000
    assert r["one_offs"] == [{"payee": "JB Hi-Fi", "amount": 129900}] and r["fixed_and_recurring_so_far"] == 250000
    assert r["projected_spend"] == 250000 + 129900 + 20000 + 2000 * 21


def test_to_text_uses_the_owners_today():
    from app.items.spec import _TEXT_NOW

    d = fresh()
    d["transactions"] = [txn("a", "2026-09-02", -500, "Old")]
    tok = _TEXT_NOW.set(datetime(2026, 11, 3, 9, 0, tzinfo=TZ))
    try:
        text = SPEC.to_text(SPEC.validate(d))
    finally:
        _TEXT_NOW.reset(tok)
    assert "Budget November 2026" in text and "counts from 2026-11" in text


async def test_quiet_sync_writes_nothing_and_status_comes_from_server_state(client, db, user, fake_up):
    item = await _new_budget(client, user)
    fid = item["file_id"]
    r = await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    assert r.status_code == 200, r.text
    assert r.json()["last_sync_at"] and r.json()["data"]["up"].get("last_sync_at") is None
    rev = (await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))).json()["revision"]
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert r.json()["sync"]["ok"] and r.json()["sync"]["changed"] is False and r.json()["revision"] == rev
    st = (await client.get(f"/api/items/k/budget/{fid}/up/status", headers=_auth(user))).json()
    assert st["last_sync_at"] and st["added_last_sync"] == 0 and st["is_owner"]


async def test_a_full_file_pauses_sync_visibly_instead_of_trimming(client, user, fake_up, monkeypatch):
    monkeypatch.setattr(up, "MAX_TRANSACTIONS", 5)
    item = await _new_budget(client, user)
    fid = item["file_id"]
    r = await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    out = r.json()
    assert out["sync"]["full"] and not out["sync"]["ok"] and "Archive older transactions" in out["sync"]["error"]
    assert out["data"]["up"]["status"] == "full" and out["full"] and out["data"]["transactions"] == []
    assert len(out["data"]["accounts"]) == 3  # balances still kept fresh
    # Nothing was read past: the cursor didn't move, so syncing again (after archiving) re-reads it all.
    monkeypatch.setattr(up, "MAX_TRANSACTIONS", 16_000)
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert r.json()["sync"]["added"] == 10 and r.json()["data"]["up"]["status"] == "ok"


async def test_the_byte_limit_also_pauses_sync(client, user, fake_up, monkeypatch):
    item = await _new_budget(client, user)
    fid = item["file_id"]
    monkeypatch.setattr(SPEC, "max_bytes", int(item["size_bytes"]) + 2500)
    out = (await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})).json()
    assert out["sync"]["full"] and out["data"]["up"]["status"] == "full" and out["data"]["transactions"] == []


async def test_restore_rewinds_the_sync_cursor(client, db, user, fake_up):
    from app.database import SessionLocal

    item = await _new_budget(client, user)
    fid = item["file_id"]
    await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    got = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    # An older version comes back (Undo / history): everything from 20 Oct on is gone from the file.
    body = got["data"]
    body["transactions"] = [t for t in body["transactions"] if t["external_id"] in ("tx-japan", "tx-cashback", "tx-mystery")]
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": body, "base_revision": got["revision"]})
    assert r.status_code == 200 and len(r.json()["data"]["transactions"]) == 3
    from app.items import service

    async with SessionLocal() as s:
        # Without the hook the next sync would only look back from 30 Oct and never re-read them.
        assert (await service.get_state(s, uuid.UUID(fid), up.CURSOR_KEY))["since"] == "2026-10-29T21:15:00Z"
        await SPEC.after_restore(s, uuid.UUID(fid))
        await s.commit()
        assert (await service.get_state(s, uuid.UUID(fid), up.CURSOR_KEY))["since"] == "2026-10-15T01:00:00Z"
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert len(r.json()["data"]["transactions"]) == 10  # all back, no duplicates


async def test_old_holds_are_checked_one_by_one_not_by_rereading(client, user, fake_up):
    now = datetime.now(TZ)
    old = (now - timedelta(days=20)).replace(microsecond=0).isoformat()
    fake_up.txns = [up_txn("tx-hotel", old, -30000, "Hotel deposit", status="HELD"),
                    up_txn("tx-new", (now - timedelta(days=1)).replace(microsecond=0).isoformat(), -500, "Coffee")]
    item = await _new_budget(client, user)
    fid = item["file_id"]
    await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    fake_up.txns = fake_up.txns[1:]  # the hotel released the hold
    fake_up.calls.clear()
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    since = next(c[2]["filter[since]"] for c in fake_up.calls if c[1] == "/transactions")
    assert datetime.fromisoformat(since.replace("Z", "+00:00")) > now - timedelta(days=15)
    assert ("GET", "/transactions/tx-hotel", {}) in fake_up.calls
    assert [t["external_id"] for t in r.json()["data"]["transactions"]] == ["tx-new"]


async def test_only_the_owner_manages_the_up_connection(client, db, user, fake_up, monkeypatch):
    from app.auth.models import User
    from app.files import office

    item = await _new_budget(client, user)
    fid = item["file_id"]
    await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    editor = User(email=f"e-{uuid.uuid4().hex[:6]}@example.com", username=f"e{uuid.uuid4().hex[:6]}", password_hash="x", role="user")
    db.add(editor)
    await db.commit()
    await db.refresh(editor)
    real = office.get_office_access

    async def shared(db_, row, who):  # the file is shared with ``editor`` for editing
        return "edit" if who.id == editor.id else await real(db_, row, who)

    monkeypatch.setattr(office, "get_office_access", shared)
    h = _auth(editor)
    st = await client.get(f"/api/items/k/budget/{fid}/up/status", headers=h)
    assert st.status_code == 200 and st.json()["connected"] and not st.json()["is_owner"]
    assert (await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=h)).status_code == 403
    assert (await client.delete(f"/api/items/k/budget/{fid}/up", headers=h)).status_code == 403
    assert (await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=h, json={"token": TOKEN})).status_code == 403
    # …but they can still edit the budget itself.
    r = await client.post(f"/api/items/{fid}/actions/add_transactions", headers=h, json={"args": {"items": [{"amount": -5, "payee": "Milk"}]}})
    assert r.status_code == 200


async def test_webhook_body_is_capped_and_revoked_token_drops_the_webhook(client, db, user, fake_up):
    from app.database import SessionLocal
    from app.items import service

    item = await _new_budget(client, user)
    fid = uuid.UUID(item["file_id"])
    r = await client.post(f"/api/items/k/budget/hook/{fid}", content=b"x" * (70 * 1024))
    assert r.status_code == 413
    await client.post(f"/api/items/k/budget/{fid}/up/connect", headers=_auth(user), json={"token": TOKEN})
    async with SessionLocal() as s:
        await service.set_state(s, fid, up.WEBHOOK_KEY, {"id": "wh-9", "secret": "s"}, secret=True)
        await s.commit()
    fake_up.webhooks["wh-9"] = {}
    fake_up.status_override = [401]
    fake_up.calls.clear()
    r = await client.post(f"/api/items/k/budget/{fid}/up/sync", headers=_auth(user))
    assert r.json()["sync"]["disconnected"]
    assert ("DELETE", "/webhooks/wh-9", {}) in fake_up.calls and "wh-9" not in fake_up.webhooks
    async with SessionLocal() as s:
        assert await service.get_state(s, fid, up.WEBHOOK_KEY, secret=True) is None
