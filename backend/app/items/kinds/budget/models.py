"""The shape of a ``.budget`` file.

Money is always **integer cents** (minor units). A transaction's
``amount_cents`` is signed from the account's point of view: negative is
money out (a purchase, a bill), positive is money in (pay, a refund).
Calendar days are ``YYYY-MM-DD`` in the person's zone; moments are ISO
strings with an offset. Every field has a default so older files keep
loading, and every list is bounded so a file stays well under the 8 MB
limit even after years of bank sync.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_serializer

DAY = r"^\d{4}-\d{2}-\d{2}$"
MONTH = r"^\d{4}-\d{2}$"
ID = 48
MAX_CENTS = 100_000_000_000  # $1bn — a sanity bound, not a limit anyone hits

MAX_TRANSACTIONS = 16_000
MAX_ACCOUNTS = 60
MAX_CATEGORIES = 200
MAX_GROUPS = 40
MAX_RULES = 500
MAX_GOALS = 60
MAX_SUBSCRIPTIONS = 300
MAX_MONTHS = 120

AccountType = Literal["transactional", "saver", "credit", "home_loan", "loan", "cash", "investment", "other"]
Source = Literal["manual", "up", "csv"]
Cadence = Literal["weekly", "fortnightly", "monthly", "quarterly", "yearly"]


class Money(BaseModel):
    amount_cents: int = Field(default=0, ge=-MAX_CENTS, le=MAX_CENTS)
    currency: str = Field(default="AUD", max_length=3)


class Split(BaseModel):
    category_id: str | None = Field(default=None, max_length=ID)
    amount_cents: int = Field(default=0, ge=-MAX_CENTS, le=MAX_CENTS)
    note: str = Field(default="", max_length=200)


class Transaction(BaseModel):
    id: str = Field(max_length=ID)
    date: str = Field(pattern=DAY)
    amount_cents: int = Field(ge=-MAX_CENTS, le=MAX_CENTS)
    payee: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=300)  # the bank's raw text
    category_id: str | None = Field(default=None, max_length=ID)
    # Who set the category: the bank / an automatic default ("auto"), a rule,
    # or the person ("user" — never overwritten by a sync or a rule).
    category_by: Literal["auto", "rule", "user"] = "auto"
    payee_by: Literal["auto", "rule", "user"] = "auto"
    account_id: str | None = Field(default=None, max_length=ID)
    notes: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    splits: list[Split] = Field(default_factory=list, max_length=20)
    pending: bool = False
    # Money moving between the person's own accounts: never spending or income.
    transfer: bool = False
    transfer_account_id: str | None = Field(default=None, max_length=ID)
    source: Source = "manual"
    external_id: str | None = Field(default=None, max_length=80)
    created_at: str | None = Field(default=None, max_length=40)
    settled_at: str | None = Field(default=None, max_length=40)
    foreign: Money | None = None
    round_up_cents: int = Field(default=0, ge=-MAX_CENTS, le=MAX_CENTS)
    cashback_cents: int = Field(default=0, ge=-MAX_CENTS, le=MAX_CENTS)
    bank_category: str | None = Field(default=None, max_length=60)  # Up's category id, as is
    # Who decided the transfer flag ("user" — never overwritten by a sync or a rule).
    transfer_by: Literal["auto", "rule", "user"] = "auto"
    # Why this one needs a look ("the bank amount changed, so the split was
    # reset"); cleared when the person edits it.
    review: str = Field(default="", max_length=160)
    # The trip it was spent on ("<trip file id>:<trip id>"), for the trip's
    # "Spent so far" — set by hand or from the trip's dates.
    trip_ref: str | None = Field(default=None, max_length=120)

    @model_serializer(mode="wrap")
    def _slim(self, handler: Any) -> dict:
        # Stored without the fields that still hold their default — a synced
        # transaction is ~40% smaller, so years of history fit in one file.
        return slim_txn(handler(self))


TXN_REQUIRED = ("id", "date", "amount_cents")


def slim_txn(d: dict) -> dict:
    """A transaction dict without default-valued fields (what's stored)."""
    return {k: v for k, v in d.items() if k in TXN_REQUIRED or k not in TXN_DEFAULTS or v != TXN_DEFAULTS[k]
            or type(v) is not type(TXN_DEFAULTS[k])}


TXN_DEFAULTS: dict[str, Any] = {
    name: f.get_default(call_default_factory=True)
    for name, f in Transaction.model_fields.items()
    if not f.is_required()
}


def full_txn(d: dict) -> dict:
    """A stored (slim) transaction with every field filled in."""
    return {**{k: (list(v) if isinstance(v, list) else v) for k, v in TXN_DEFAULTS.items()}, **d}


class Account(BaseModel):
    id: str = Field(max_length=ID)
    name: str = Field(max_length=80)
    type: AccountType = "transactional"
    currency: str = Field(default="AUD", max_length=3)
    balance_cents: int = Field(default=0, ge=-MAX_CENTS, le=MAX_CENTS)
    source: Source = "manual"
    external_id: str | None = Field(default=None, max_length=80)
    on_budget: bool = True  # counts towards "to be budgeted" / cash
    archived: bool = False
    balance_at: str | None = Field(default=None, max_length=40)
    ownership: Literal["individual", "joint"] = "individual"
    renamed: bool = False  # the person named it; a sync keeps their name


class CategoryGroup(BaseModel):
    id: str = Field(max_length=ID)
    name: str = Field(max_length=60)
    hidden: bool = False


class Category(BaseModel):
    id: str = Field(max_length=ID)
    group_id: str = Field(max_length=ID)
    name: str = Field(max_length=60)
    kind: Literal["expense", "income"] = "expense"
    emoji: str = Field(default="", max_length=8)
    # The default monthly budget (a month can override it in ``months``).
    budget_cents: int = Field(default=0, ge=0, le=MAX_CENTS)
    # Envelope rollover: what's left (or overspent) carries into next month.
    rollover: bool = False
    hidden: bool = False
    # 50/30/20 bucket for the heuristic view.
    bucket: Literal["needs", "wants", "savings", "none"] = "none"


class BudgetMonth(BaseModel):
    month: str = Field(pattern=MONTH)
    # category id → cents assigned this month (overrides the default).
    assigned: dict[str, int] = Field(default_factory=dict, max_length=MAX_CATEGORIES)
    note: str = Field(default="", max_length=500)


class Rule(BaseModel):
    id: str = Field(max_length=ID)
    field: Literal["payee", "description", "any"] = "any"
    match: Literal["contains", "equals", "starts", "regex"] = "contains"
    pattern: str = Field(min_length=1, max_length=200)
    category_id: str | None = Field(default=None, max_length=ID)
    rename_to: str | None = Field(default=None, max_length=120)
    add_tags: list[str] = Field(default_factory=list, max_length=6)
    mark_transfer: bool = False
    enabled: bool = True
    created_at: str | None = Field(default=None, max_length=40)


class Goal(BaseModel):
    id: str = Field(max_length=ID)
    name: str = Field(max_length=80)
    target_cents: int = Field(default=0, ge=0, le=MAX_CENTS)
    target_date: str | None = Field(default=None, pattern=DAY)
    # Progress comes from the linked account's balance, else ``saved_cents``.
    account_id: str | None = Field(default=None, max_length=ID)
    saved_cents: int = Field(default=0, ge=0, le=MAX_CENTS)
    category_id: str | None = Field(default=None, max_length=ID)  # a sinking-fund category
    emoji: str = Field(default="", max_length=8)
    created: str | None = Field(default=None, pattern=DAY)
    done: bool = False


class PriceChange(BaseModel):
    from_cents: int = 0
    to_cents: int = 0
    on: str = Field(pattern=DAY)


class Subscription(BaseModel):
    id: str = Field(max_length=ID)
    name: str = Field(max_length=120)
    merchant: str = Field(default="", max_length=120)  # normalised key
    kind: Literal["subscription", "bill"] = "subscription"
    cadence: Cadence = "monthly"
    amount_cents: int = Field(default=0, ge=0, le=MAX_CENTS)  # the latest charge, positive
    variable: bool = False  # a bill whose amount moves (power, water)
    monthly_cents: int = Field(default=0, ge=0, le=MAX_CENTS)
    last_date: str | None = Field(default=None, pattern=DAY)
    next_due: str | None = Field(default=None, pattern=DAY)
    occurrences: int = Field(default=0, ge=0, le=10_000)
    confidence: float = Field(default=0.0, ge=0, le=1)
    # What the detector thinks…
    status: Literal["active", "maybe_cancelled"] = "active"
    # …and what the person said (wins).
    user_status: Literal["confirmed", "ignored", "cancelled"] | None = None
    cancelled_on: str | None = Field(default=None, pattern=DAY)
    charged_after_cancel: bool = False
    price_change: PriceChange | None = None
    category_id: str | None = Field(default=None, max_length=ID)
    account_id: str | None = Field(default=None, max_length=ID)
    transaction_ids: list[str] = Field(default_factory=list, max_length=12)
    source: Literal["detected", "manual"] = "detected"
    remind: bool = True
    renamed: bool = False  # the person named it; detection keeps their name


class UpSync(BaseModel):
    """What the UI and text show about the Up connection (never the token)."""

    connected: bool = False
    # "full": the file can't take more transactions — archive older ones.
    status: Literal["off", "ok", "error", "disconnected", "full"] = "off"
    # Legacy: sync times now live in server state (the status endpoint) so a
    # quiet sync doesn't rewrite the file. Kept so older files load.
    last_sync_at: str | None = Field(default=None, max_length=40)
    last_error: str = Field(default="", max_length=300)
    webhook: bool = False
    added_last_sync: int = 0
    # Transactions before this day were archived to another file: a sync
    # never brings Up's copies of them back.
    archived_before: str | None = Field(default=None, pattern=DAY)


class Settings(BaseModel):
    currency: str = Field(default="AUD", max_length=3)
    # Budget months start on this day (payday budgeting): 15 → 15th to 14th.
    month_start_day: int = Field(default=1, ge=1, le=28)
    style: Literal["simple", "envelope"] = "simple"
    # Zero-based: show "to be budgeted" (income minus everything assigned).
    zero_based: bool = False
    pay_frequency: Literal["weekly", "fortnightly", "monthly", "irregular"] = "fortnightly"
    next_payday: str | None = Field(default=None, pattern=DAY)
    bill_reminders: bool = True
    overspend_alerts: bool = True
    # Up category id → this file's category id (overrides the built-in map).
    up_category_map: dict[str, str] = Field(default_factory=dict, max_length=100)
    up_history_days: int = Field(default=365, ge=30, le=1825)
    # The first budget month (YYYY-MM): assigning, rollover and "to be
    # budgeted" count from here. None = from the earliest data (older files).
    budget_start: str | None = Field(default=None, pattern=MONTH)
    onboarded: bool = False


class CarryIn(BaseModel):
    """Where the budget stood when older transactions were archived out:
    rollover balances and "to be budgeted" at the start of ``month``."""

    month: str = Field(pattern=MONTH)
    available: dict[str, int] = Field(default_factory=dict, max_length=MAX_CATEGORIES)
    to_be_budgeted: int = Field(default=0, ge=-MAX_CENTS, le=MAX_CENTS)


class BudgetData(BaseModel):
    settings: Settings = Field(default_factory=Settings)
    accounts: list[Account] = Field(default_factory=list, max_length=MAX_ACCOUNTS)
    transactions: list[Transaction] = Field(default_factory=list, max_length=MAX_TRANSACTIONS)
    groups: list[CategoryGroup] = Field(default_factory=list, max_length=MAX_GROUPS)
    categories: list[Category] = Field(default_factory=list, max_length=MAX_CATEGORIES)
    months: list[BudgetMonth] = Field(default_factory=list, max_length=MAX_MONTHS)
    rules: list[Rule] = Field(default_factory=list, max_length=MAX_RULES)
    goals: list[Goal] = Field(default_factory=list, max_length=MAX_GOALS)
    subscriptions: list[Subscription] = Field(default_factory=list, max_length=MAX_SUBSCRIPTIONS)
    up: UpSync = Field(default_factory=UpSync)
    carry_in: CarryIn | None = None
