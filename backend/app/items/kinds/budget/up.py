"""Up Bank (https://developer.up.com.au) — read-only sync.

* The person pastes a Personal Access Token (``up:yeah:…``). It is checked
  with ``GET /util/ping`` and kept **encrypted** in the file's server-only
  state (``item_state``, key ``up_token``) — never in the file, never
  logged, never returned by any endpoint.
* A sync reads ``/accounts`` (balances) and ``/transactions`` (all
  accounts, ``page[size]=100``, ``filter[since]``, following ``links.next``),
  maps them onto the file (:func:`merge_up` — pure, tested on fixtures) and
  re-runs subscription detection. The cursor (``up_cursor``) remembers the
  newest transaction seen; each sync re-reads a few days before it and back
  to the oldest still-HELD one (at most :data:`HOLD_LOOKBACK`), so pending
  charges settle (or vanish when the merchant releases the hold). Older
  holds are checked one by one (``GET /transactions/{id}``).
* The person's edits on a hold (category, payee, notes, splits, transfer)
  carry over to the settled transaction when Up replaces the hold with a new
  one (matched by account, merchant, amount ± and date).
* Sync bookkeeping (last sync, counts, status) lives in server state
  (``up_sync``) — the file is only saved when the bank data changed.
* A file that can't take more transactions stops the sync with status
  "full" (shown in the app: archive older transactions) — nothing is ever
  trimmed silently.
* Undo / version restore (:func:`after_restore`) rewinds the cursor to the
  restored file, so the next sync re-reads what the restore took away.
* The first sync reads ``settings.up_history_days`` back; if that's more
  than one pass allows, the rest is back-filled on later syncs.
* Optional webhook: when the instance has a public https origin, connect
  registers ``/api/items/k/budget/hook/{file_id}``; its secret is kept
  encrypted and each delivery's ``X-Up-Authenticity-Signature`` (HMAC-SHA256
  of the raw body) is checked before anything happens.
* 401 → the token was revoked: the webhook is deleted at Up (best effort),
  the token forgotten, and the file says so.
  429 → exponential backoff, then "try again later".
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import hmac
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.items.kinds.budget import logic, subscriptions
from app.items.kinds.budget.defaults import UP_CATEGORY_MAP, UP_PARENT_FALLBACK
from app.items.kinds.budget.models import MAX_TRANSACTIONS, slim_txn

logger = logging.getLogger("promptly.items.budget.up")

API = "https://api.up.com.au/api/v1"
PAGE_SIZE = 100
MAX_PAGES_PER_PASS = 40
OVERLAP = timedelta(days=3)
HOLD_LOOKBACK = timedelta(days=14)  # re-read at most this far back for holds
MAX_HOLD_CHECKS = 10  # older holds looked up one by one per sync
CARRY_DAYS = 14  # how long a released hold's edits wait for a replacement

TOKEN_KEY = "up_token"
WEBHOOK_KEY = "up_webhook"
CURSOR_KEY = "up_cursor"
CATEGORIES_KEY = "up_categories"
SYNC_KEY = "up_sync"  # {last_sync_at, added_last_sync, status, error}
CARRY_KEY = "up_carry"  # edits of released holds waiting for their replacement


class UpError(Exception):
    """Up refused or failed; the message is safe to show (no token in it)."""


class UpAuthError(UpError):
    pass


class UpRateLimited(UpError):
    pass


class UpNotFound(UpError):
    pass


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=API,
        timeout=httpx.Timeout(20.0, connect=10.0),
        headers={"Accept": "application/json", "User-Agent": "Promptly-Budget/1"},
        follow_redirects=False,
    )


# Replaced in tests (an ``httpx.MockTransport`` client) — nothing ever calls
# Up for real from the suite.
client_factory = make_client
sleep = asyncio.sleep


def clean_token(raw: str) -> str:
    t = (raw or "").strip()
    if t.lower().startswith("bearer "):
        t = t[7:].strip()
    if not t.startswith("up:yeah:") or len(t) > 400 or re.search(r"\s", t):
        raise UpError("That doesn't look like an Up token — it starts with “up:yeah:”.")
    return t


class UpClient:
    def __init__(self, token: str):
        self._token = token
        self._c: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "UpClient":
        self._c = client_factory()
        return self

    async def __aexit__(self, *exc) -> None:  # noqa: ANN002
        if self._c is not None:
            await self._c.aclose()

    async def request(self, method: str, url: str, *, params: dict | None = None, json: Any = None) -> dict:
        assert self._c is not None
        if url.startswith("http") and not url.startswith(API + "/"):
            raise UpError("Up sent a link to somewhere else; stopped.")  # never send the token off-site
        headers = {"Authorization": f"Bearer {self._token}"}
        for attempt in range(4):
            try:
                r = await self._c.request(method, url, params=params, json=json, headers=headers)
            except httpx.TimeoutException:
                if attempt < 2:
                    await sleep(1.5 * (attempt + 1))
                    continue
                raise UpError("Up didn't answer in time. Try again in a minute.") from None
            except httpx.HTTPError:
                raise UpError("Couldn't reach Up. Check the server's internet connection.") from None
            if r.status_code == 429:
                if attempt < 3:
                    await sleep(2 ** attempt)
                    continue
                raise UpRateLimited("Up is rate-limiting requests right now. It'll retry on the next sync.")
            if r.status_code == 401:
                raise UpAuthError("Up didn't accept the token — it may have been revoked. Paste a new one.")
            if r.status_code >= 500:
                if attempt < 2:
                    await sleep(2 ** attempt)
                    continue
                raise UpError(f"Up is having trouble ({r.status_code}). It'll retry on the next sync.")
            if r.status_code == 404:
                raise UpNotFound("Up doesn't have that any more.")
            if r.status_code >= 400:
                raise UpError(f"Up refused the request ({r.status_code}).")
            if not r.content:
                return {}
            try:
                return r.json()
            except ValueError:
                raise UpError("Up sent something unexpected.") from None
        raise UpError("Up didn't answer.")  # pragma: no cover

    async def ping(self) -> dict:
        return await self.request("GET", "/util/ping")

    async def _paged(self, path: str, params: dict, max_pages: int) -> tuple[list[dict], bool]:
        out: list[dict] = []
        url: str | None = path
        p: dict | None = params
        pages = 0
        while url and pages < max_pages:
            body = await self.request("GET", url, params=p)
            out.extend(body.get("data") or [])
            url = (body.get("links") or {}).get("next")
            p = None  # the next link carries its own query
            pages += 1
        return out, url is None

    async def accounts(self) -> list[dict]:
        rows, _ = await self._paged("/accounts", {"page[size]": PAGE_SIZE}, 10)
        return rows

    async def transactions(
        self, *, since: str | None = None, until: str | None = None, max_pages: int | None = None
    ) -> tuple[list[dict], bool]:
        params: dict[str, Any] = {"page[size]": PAGE_SIZE}
        if since:
            params["filter[since]"] = since
        if until:
            params["filter[until]"] = until
        return await self._paged("/transactions", params, max_pages or MAX_PAGES_PER_PASS)

    async def transaction(self, txn_id: str) -> dict | None:
        if not re.fullmatch(r"[A-Za-z0-9\-]{1,80}", txn_id or ""):
            return None
        try:
            body = await self.request("GET", f"/transactions/{txn_id}")
        except UpNotFound:
            return None
        return body.get("data")

    async def categories(self) -> list[dict]:
        body = await self.request("GET", "/categories")
        return body.get("data") or []

    async def create_webhook(self, url: str) -> dict:
        body = await self.request(
            "POST", "/webhooks",
            json={"data": {"attributes": {"url": url, "description": "Promptly Budget"}}},
        )
        return body.get("data") or {}

    async def delete_webhook(self, webhook_id: str) -> None:
        if re.fullmatch(r"[A-Za-z0-9\-]{1,80}", webhook_id or ""):
            await self.request("DELETE", f"/webhooks/{webhook_id}")


# ---------------------------------------------------------------- mapping

_ACCOUNT_TYPES = {"TRANSACTIONAL": "transactional", "SAVER": "saver", "HOME_LOAN": "home_loan"}


def account_id_for(ext: str) -> str:
    return "up_" + logic.short_hash("up-account", ext, n=8)


def txn_id_for(ext: str) -> str:
    return "t" + logic.short_hash("up", ext, n=12)


def _cents(money: dict | None) -> int:
    if not money:
        return 0
    v = money.get("valueInBaseUnits")
    if isinstance(v, int):
        return v
    try:
        return logic.to_cents(money.get("value") or "0")
    except ValueError:
        return 0


def map_account(res: dict) -> dict:
    a = res.get("attributes") or {}
    bal = a.get("balance") or {}
    return {
        "external_id": res["id"],
        "name": (a.get("displayName") or "Up account")[:80],
        "type": _ACCOUNT_TYPES.get(a.get("accountType") or "", "other"),
        "currency": (bal.get("currencyCode") or "AUD")[:3],
        "balance_cents": _cents(bal),
        "ownership": "joint" if a.get("ownershipType") == "JOINT" else "individual",
    }


def _rel_id(res: dict, name: str) -> str | None:
    d = ((res.get("relationships") or {}).get(name) or {}).get("data")
    return d.get("id") if isinstance(d, dict) else None


def local_day(iso: str | None, tz: ZoneInfo) -> str | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz).date().isoformat()


def map_category(data: dict, up_cat: str | None, up_parent: str | None) -> str | None:
    known = {c["id"] for c in data.get("categories", [])}
    custom = (data.get("settings") or {}).get("up_category_map") or {}
    for key in (up_cat, up_parent):
        if key and custom.get(key) in known:
            return custom[key]
    if up_cat and UP_CATEGORY_MAP.get(up_cat) in known:
        return UP_CATEGORY_MAP[up_cat]
    if up_parent and UP_PARENT_FALLBACK.get(up_parent) in known:
        return UP_PARENT_FALLBACK[up_parent]
    return None


_TRANSFER_TYPES = ("transfer", "round up", "round-up", "roundup", "cover", "quick save", "forward")
_INCOME_TYPES = ("interest", "bonus", "cashback", "cash back")


def classify(a: dict, transfer_acct: str | None, cents: int) -> tuple[bool, bool]:
    """(is a move between own accounts, is interest/bonus income) — from
    Up's ``transferAccount``, ``transactionType`` and ``isCategorizable``,
    falling back to the description for older payloads."""
    desc = (a.get("description") or "").strip().lower()
    kind = (a.get("transactionType") or "").strip().lower()
    income = any(w in kind for w in _INCOME_TYPES) or (desc in ("interest", "bonus interest") and cents > 0)
    if transfer_acct:
        return True, False
    if kind and any(w in kind for w in _TRANSFER_TYPES):
        return True, False
    if desc in ("round up", "round-up", "roundup") and cents != 0:
        return True, False
    if a.get("isCategorizable") is False and not income:
        return True, False  # Up's own moves (round-ups, covers, savers) can't be categorised
    return False, income


def map_transaction(res: dict, tz: ZoneInfo) -> dict:
    """An Up TransactionResource → the bank-owned fields of a transaction."""
    a = res.get("attributes") or {}
    created = a.get("createdAt")
    desc = (a.get("description") or "").strip()
    raw = (a.get("rawText") or "").strip()
    fx = a.get("foreignAmount")
    round_up = (a.get("roundUp") or {}).get("amount")
    cashback = (a.get("cashback") or {}).get("amount")
    tags = [t.get("id") for t in (((res.get("relationships") or {}).get("tags") or {}).get("data") or []) if t.get("id")]
    transfer_acct = _rel_id(res, "transferAccount")
    cents = _cents(a.get("amount"))
    is_transfer, is_interest = classify(a, transfer_acct, cents)
    return {
        "external_id": res["id"],
        "date": local_day(created, tz) or datetime.now(tz).date().isoformat(),
        "amount_cents": cents,
        "payee": desc[:120] or logic.clean_payee(raw)[:120] or "Up transaction",
        "description": (raw or desc)[:300],
        "message": (a.get("message") or "").strip()[:500],
        "pending": a.get("status") == "HELD",
        "created_at": created,
        "settled_at": a.get("settledAt"),
        "foreign": {"amount_cents": _cents(fx), "currency": (fx.get("currencyCode") or "")[:3]} if fx else None,
        "round_up_cents": _cents(round_up),
        "cashback_cents": _cents(cashback),
        "up_category": _rel_id(res, "category"),
        "up_parent": _rel_id(res, "parentCategory"),
        "tags": [str(t)[:40] for t in tags][:12],
        "account_ext": _rel_id(res, "account"),
        "transfer_ext": transfer_acct,
        "transfer": is_transfer,
        "interest": is_interest,
    }


@dataclass
class MergeStats:
    added: int = 0
    updated: int = 0
    settled: int = 0
    removed: int = 0
    accounts: int = 0
    carried: int = 0
    # Edits of released holds still waiting for their settled replacement.
    waiting: list = field(default_factory=list)

    def as_dict(self) -> dict:
        d = self.__dict__.copy()
        d.pop("waiting", None)
        return d


def merge_accounts(data: dict, accounts: list[dict], now_iso: str) -> int:
    by_ext = {a.get("external_id"): a for a in data["accounts"] if a.get("source") == "up"}
    n = 0
    for res in accounts:
        m = map_account(res)
        cur = by_ext.get(m["external_id"])
        if cur is None:
            if len(data["accounts"]) >= 60:
                continue
            data["accounts"].append(
                {
                    "id": account_id_for(m["external_id"]), "name": m["name"], "type": m["type"],
                    "currency": m["currency"], "balance_cents": m["balance_cents"], "source": "up",
                    "external_id": m["external_id"], "on_budget": m["type"] != "home_loan", "archived": False,
                    "balance_at": now_iso, "ownership": m["ownership"],
                }
            )
            n += 1
        else:
            # Only a real change touches the file (a quiet sync writes nothing).
            if cur.get("balance_cents") != m["balance_cents"]:
                cur["balance_cents"] = m["balance_cents"]
                cur["balance_at"] = now_iso
            if cur.get("currency") != m["currency"]:
                cur["currency"] = m["currency"]
            if not cur.get("renamed") and cur.get("name") != m["name"]:
                cur["name"] = m["name"]
    return n


def _apply_bank(t: dict, m: dict, data: dict, acct_by_ext: dict, learned: dict, *, new: bool) -> None:
    cur = (data.get("settings") or {}).get("currency", "AUD")
    old_amount = t.get("amount_cents")
    t["date"] = m["date"]
    t["amount_cents"] = m["amount_cents"]
    t["description"] = m["description"]
    t["pending"] = m["pending"]
    t["created_at"] = m["created_at"]
    t["settled_at"] = m["settled_at"]
    t["foreign"] = m["foreign"]
    t["round_up_cents"] = m["round_up_cents"]
    t["cashback_cents"] = m["cashback_cents"]
    t["bank_category"] = m["up_category"]
    t["account_id"] = acct_by_ext.get(m["account_ext"], t.get("account_id"))
    if t.get("transfer_by", "auto") != "user":
        # The person's own "it is / isn't a transfer" always wins.
        if m["transfer"]:
            t["transfer"] = True
            t["transfer_by"] = "auto"
            t["transfer_account_id"] = acct_by_ext.get(m["transfer_ext"]) if m["transfer_ext"] else t.get("transfer_account_id")
        elif new:
            t["transfer"] = False
    for tag in m["tags"]:
        if tag not in t.setdefault("tags", []) and len(t["tags"]) < 12:
            t["tags"].append(tag)
    if new and m["message"] and not t.get("notes"):
        t["notes"] = m["message"]
    if t.get("payee_by", "auto") == "auto":
        t["payee"] = m["payee"]
    if t.get("splits") and old_amount is not None and old_amount != m["amount_cents"]:
        logic.rebalance_splits(t, cur)
    if t.get("category_by", "auto") == "auto" and not t.get("splits"):
        if t.get("transfer"):
            t["category_id"] = None
        else:
            cat = logic.learned_for(learned, t["payee"]) or map_category(data, m["up_category"], m["up_parent"])
            if cat is None and m.get("interest") and m["amount_cents"] > 0:
                known = {c["id"] for c in data.get("categories", [])}
                cat = "other_income" if "other_income" in known else None
            t["category_id"] = cat  # money in with no match: left for the person (pay, refunds, gifts)
    if t.get("category_by") != "user" or t.get("payee_by") != "user":
        logic.apply_rules(data, t)


# ---------------------------------------------- held → settled carry-over


def _has_edits(t: dict) -> bool:
    return bool(
        t.get("category_by") == "user" or t.get("payee_by") == "user" or t.get("splits")
        or t.get("transfer_by") == "user" or t.get("notes")
    )


def carry_of(t: dict) -> dict:
    """What the person set on a hold, kept to put on its replacement."""
    keep = ("category_id", "category_by", "payee", "payee_by", "notes", "tags", "splits", "transfer", "transfer_by")
    return {
        "account_id": t.get("account_id"), "amount_cents": t["amount_cents"], "date": t["date"],
        "key": logic.merchant_key(t.get("description") or t.get("payee") or ""),
        **{k: copy.deepcopy(t[k]) for k in keep if k in t},
    }


def _matches(c: dict, t: dict) -> bool:
    if c.get("account_id") != t.get("account_id"):
        return False
    a, b = int(c["amount_cents"]), int(t["amount_cents"])
    if (a < 0) != (b < 0) or abs(a - b) > max(500, abs(a) // 4):
        return False
    try:
        gap = (logic.parse_day(t["date"]) - logic.parse_day(c["date"])).days
    except ValueError:
        return False
    if gap < -1 or gap > 10:
        return False
    k = logic.merchant_key(t.get("description") or t.get("payee") or "")
    return bool(c.get("key")) and (k == c["key"] or k.startswith(c["key"]) or c["key"].startswith(k)) and bool(k)


def apply_carry(t: dict, c: dict, currency: str = "AUD") -> None:
    if c.get("category_by") == "user":
        t["category_id"] = c.get("category_id")
        t["category_by"] = "user"
    if c.get("payee_by") == "user":
        t["payee"] = c.get("payee") or t.get("payee", "")
        t["payee_by"] = "user"
    if c.get("notes") and not t.get("notes"):
        t["notes"] = c["notes"]
    for tag in c.get("tags") or []:
        if tag not in t.setdefault("tags", []) and len(t["tags"]) < 12:
            t["tags"].append(tag)
    if c.get("transfer_by") == "user":
        t["transfer"] = bool(c.get("transfer"))
        t["transfer_by"] = "user"
    if c.get("splits"):
        t["splits"] = copy.deepcopy(c["splits"])
        t["category_id"] = None
        t["category_by"] = "user"
        logic.rebalance_splits(t, currency)


def _iso_dt(s: str | None) -> datetime | None:
    return _parse(s)


def merge_up(
    data: dict,
    accounts: list[dict],
    txns: list[dict],
    *,
    tz: ZoneInfo,
    now: datetime,
    window_start: str | None = None,
    complete: bool = False,
    carry: list[dict] | None = None,
) -> MergeStats:
    """Fold Up's accounts and transactions into ``data`` (in place).

    De-duplicated by Up id; the person's own edits (category, payee, notes,
    splits, transfer) survive. With ``complete`` (the whole window since
    ``window_start`` was read), a HELD transaction in that window that Up no
    longer returns was released by the merchant and is removed — and its
    edits move to the new transaction that replaced it (or wait in
    ``stats.waiting`` for one; pass them back as ``carry`` next time)."""
    stats = MergeStats()
    now_iso = now.isoformat()
    currency = (data.get("settings") or {}).get("currency", "AUD")
    stats.accounts = merge_accounts(data, accounts, now_iso)
    acct_by_ext = {a.get("external_id"): a["id"] for a in data["accounts"] if a.get("source") == "up"}
    existing = {t.get("external_id"): t for t in data["transactions"] if t.get("source") == "up"}
    learned = logic.learned_categories(data)
    floor = (data.get("up") or {}).get("archived_before") or ""
    seen: set[str] = set()
    added: list[dict] = []
    for res in txns:
        if not isinstance(res, dict) or res.get("type") not in (None, "transactions") or not res.get("id"):
            continue
        m = map_transaction(res, tz)
        ext = m["external_id"]
        if ext in seen:
            continue
        seen.add(ext)
        cur = existing.get(ext)
        if cur is None:
            if floor and m["date"] < floor:
                continue  # archived to another file
            t = {"id": txn_id_for(ext), "source": "up", "external_id": ext}
            _apply_bank(t, m, data, acct_by_ext, learned, new=True)
            data["transactions"].append(t)
            existing[ext] = t
            added.append(t)
            stats.added += 1
        else:
            was_pending = bool(cur.get("pending"))
            before = slim_txn(copy.deepcopy(cur))
            _apply_bank(cur, m, data, acct_by_ext, learned, new=False)
            if was_pending and not cur["pending"]:
                stats.settled += 1
            if slim_txn(cur) != before:
                stats.updated += 1
    waiting = [c for c in (carry or []) if isinstance(c, dict) and c.get("date")]
    start = _iso_dt(window_start)
    if complete and start is not None:
        gone = []
        for t in data["transactions"]:
            if t.get("source") != "up" or not t.get("pending") or t.get("external_id") in seen:
                continue
            created = _iso_dt(t.get("created_at"))
            if created is not None and created >= start:
                gone.append(t)
        if gone:
            ids = {t["id"] for t in gone}
            data["transactions"] = [t for t in data["transactions"] if t["id"] not in ids]
            stats.removed = len(gone)
            waiting = [carry_of(t) for t in gone if _has_edits(t)] + waiting
    # A released hold's edits go to the transaction that replaced it.
    for t in added:
        hit = next((c for c in waiting if _matches(c, t)), None)
        if hit is not None:
            apply_carry(t, hit, currency)
            waiting.remove(hit)
            stats.carried += 1
    cutoff = (now.date() - timedelta(days=CARRY_DAYS)).isoformat()
    stats.waiting = [c for c in waiting if c["date"] >= cutoff][:50]
    sort_transactions(data)
    return stats


def remove_external(data: dict, ext: str) -> dict | None:
    """Drop the Up transaction ``ext``; returns it (or None)."""
    gone = next((t for t in data["transactions"] if t.get("source") == "up" and t.get("external_id") == ext), None)
    if gone is not None:
        data["transactions"] = [t for t in data["transactions"] if t is not gone]
    return gone


def sort_transactions(data: dict) -> None:
    # Never trims: a file that's full is reported (status "full") instead.
    data["transactions"].sort(key=lambda t: (t["date"], t.get("created_at") or "", t["id"]), reverse=True)


# ------------------------------------------------------------------- sync


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _oldest(rows: list[dict]) -> datetime | None:
    stamps = [_parse((r.get("attributes") or {}).get("createdAt")) for r in rows]
    stamps = [s for s in stamps if s is not None]
    return min(stamps) if stamps else None


_locks: dict[uuid.UUID, asyncio.Lock] = {}


def _lock(fid: uuid.UUID) -> asyncio.Lock:
    lk = _locks.get(fid)
    if lk is None:
        lk = _locks[fid] = asyncio.Lock()
    return lk


class FileFull(Exception):
    """The file can't take the synced transactions."""


FULL_MESSAGE = ("This budget file is full, so Up can't add new transactions. Archive older transactions "
                "(⋯ → Archive older data, or the button in Accounts) and the sync picks up where it stopped.")


async def _save(db, owner, file_id: uuid.UUID, fn) -> dict:  # noqa: ANN001
    """Load locked, apply ``fn(data)``, and — only if that changed anything —
    save through the normal path. Commits. Raises :class:`FileFull` when the
    result can't fit in one file (nothing is saved)."""
    from pydantic import ValidationError

    from app.items import service
    from app.items.kinds.budget.models import BudgetData

    row, doc, _ = await service.load(db, owner, file_id, need="edit", lock=True)
    data = copy.deepcopy(doc.data)
    out = fn(data)
    out = out if isinstance(out, dict) else {}
    if len(data.get("transactions") or []) > MAX_TRANSACTIONS:
        await db.commit()  # nothing was changed; releases the row lock
        raise FileFull(FULL_MESSAGE)
    try:
        clean = BudgetData.model_validate(data).model_dump(mode="json")
    except ValidationError:
        clean = None  # let save_data explain it
    if clean is not None and clean == doc.data:
        await db.commit()  # releases the row lock; nothing to write
        return {**out, "changed": False}
    try:
        await service.save_data(db, owner, row, doc, data, base_revision=None, source="edit")
    except service.ItemError as e:
        await db.commit()  # nothing was changed; releases the row lock
        if "more than one" in str(e) or "at most" in str(e):
            raise FileFull(FULL_MESSAGE) from None
        raise
    await db.commit()
    return {**out, "changed": True}


def _mark(status: str, error: str = "", **extra: Any):  # noqa: ANN202
    def fn(data: dict) -> None:
        up = data.setdefault("up", {})
        up["status"] = status
        up["last_error"] = error[:300]
        if status == "disconnected":
            up["connected"] = False
            up["webhook"] = False
        up.update(extra)

    return fn


async def _record(db, file_id: uuid.UUID, **kw: Any) -> None:  # noqa: ANN001
    """Sync bookkeeping in server state (not the file)."""
    from app.items import service

    st = dict(await service.get_state(db, file_id, SYNC_KEY) or {})
    st.update(kw)
    await service.set_state(db, file_id, SYNC_KEY, st)
    await db.commit()


async def sync_status(db, file_id: uuid.UUID) -> dict:  # noqa: ANN001
    from app.items import service

    return dict(await service.get_state(db, file_id, SYNC_KEY) or {})


async def after_restore(db, file_id: uuid.UUID) -> None:  # noqa: ANN001
    """A version was restored (Undo / history): Up transactions newer than the
    restored file would otherwise never come back (the cursor is past them).
    Rewind the cursor to the restored file's newest Up transaction (ids
    de-duplicate the overlap); with none, the next sync reads the full
    history again. Waiting hold edits are dropped (they belonged to the
    replaced state)."""
    from app.items import service
    from app.items.models import ItemDocument

    doc = await db.get(ItemDocument, file_id)
    if doc is None or doc.kind != "budget":
        return
    cursor = dict(await service.get_state(db, file_id, CURSOR_KEY) or {})
    stamps = [_parse(t.get("created_at")) for t in (doc.data or {}).get("transactions", []) if t.get("source") == "up"]
    stamps = [s for s in stamps if s is not None]
    if stamps:
        cursor["since"] = _iso(max(stamps))
        await service.set_state(db, file_id, CURSOR_KEY, cursor)
    else:
        await service.set_state(db, file_id, CURSOR_KEY, None)
    await service.set_state(db, file_id, CARRY_KEY, None)
    await db.flush()


async def _full(db, owner, file_id: uuid.UUID, accounts: list[dict], now: datetime) -> dict:  # noqa: ANN001
    """The sync didn't fit: keep balances fresh if possible, say so."""
    def fn(d: dict) -> None:
        merge_accounts(d, accounts, now.isoformat())
        _mark("full", FULL_MESSAGE, connected=True)(d)

    try:
        await _save(db, owner, file_id, fn)
    except FileFull:
        await _save(db, owner, file_id, _mark("full", FULL_MESSAGE, connected=True))
    await _record(db, file_id, status="full", error=FULL_MESSAGE, last_attempt_at=now.isoformat())
    return {"ok": False, "full": True, "error": FULL_MESSAGE}


async def sync_file(db, owner, file_id: uuid.UUID, *, event: tuple[str, str] | None = None) -> dict:  # noqa: ANN001
    """Sync one file from Up (incremental). ``event`` = (eventType,
    transaction id) from a webhook: just that transaction."""
    from app.items import service

    async with _lock(file_id):
        token = await service.get_state(db, file_id, TOKEN_KEY, secret=True)
        if not token:
            return {"ok": False, "error": "Up isn't connected."}
        _row, doc, _ = await service.load(db, owner, file_id, need="edit")
        tz = service.zone_for(owner)
        now = datetime.now(tz)
        data = doc.data
        cursor = await service.get_state(db, file_id, CURSOR_KEY) or {}
        carry = list(await service.get_state(db, file_id, CARRY_KEY) or [])
        new_cursor = cursor
        accounts: list[dict] = []
        try:
            async with UpClient(token) as up:
                accounts = await up.accounts()
                if event is not None:
                    kind, tid = event
                    if kind == "TRANSACTION_DELETED":
                        stash: list[dict] = []

                        def drop(d: dict) -> dict:
                            merge_accounts(d, accounts, now.isoformat())
                            gone = remove_external(d, tid)
                            if gone is not None and gone.get("pending") and _has_edits(gone):
                                stash.append(carry_of(gone))
                            return {"ok": True}

                        try:
                            out = await _save(db, owner, file_id, drop)
                        except FileFull:
                            return await _full(db, owner, file_id, accounts, now)
                        if stash:
                            await service.set_state(db, file_id, CARRY_KEY, (stash + carry)[:50])
                            await db.commit()
                        return out
                    res = await up.transaction(tid)
                    batches = [([res] if res else [], None, False)]
                else:
                    history_start = now - timedelta(days=int((data.get("settings") or {}).get("up_history_days", 365)))
                    since = _parse(cursor.get("since"))
                    old_holds: list[str] = []
                    if since is None:
                        window = history_start
                    else:
                        window = since - OVERLAP
                        floor = now - HOLD_LOOKBACK
                        for t in data.get("transactions", []):
                            if t.get("source") != "up" or not t.get("pending"):
                                continue
                            h = _parse(t.get("created_at"))
                            if h is None:
                                continue
                            if h >= floor:
                                window = min(window, h - timedelta(hours=1))
                            elif t.get("external_id"):
                                old_holds.append(t["external_id"])  # looked up one by one instead
                    window = max(window, history_start)
                    rows, complete = await up.transactions(since=_iso(window))
                    batches = [(rows, _iso(window), complete)]
                    newest = max((_parse((r.get("attributes") or {}).get("createdAt")) for r in rows), default=None, key=lambda d: d or datetime.min.replace(tzinfo=timezone.utc))
                    new_cursor = dict(cursor)
                    if newest is not None and (since is None or newest > since):
                        new_cursor["since"] = _iso(newest)
                    elif since is None:
                        new_cursor["since"] = _iso(now)
                    # Gaps still to read (oldest-first work list): a pass that
                    # hit the page cap leaves [window, oldest row read).
                    gaps = [g for g in (cursor.get("gaps") or []) if isinstance(g, dict) and g.get("before")]
                    if not complete and rows:
                        oldest = _oldest(rows)
                        if oldest is not None:
                            gap = {"before": _iso(oldest), "after": _iso(window)}
                            if gap not in gaps:
                                gaps.append(gap)
                    if cursor.get("gaps"):
                        bf = gaps[0]
                        more, done = await up.transactions(since=bf.get("after"), until=bf.get("before"))
                        batches.append((more, None, False))
                        oldest = _oldest(more)
                        if done or not more or oldest is None:
                            gaps.pop(0)
                        else:
                            gaps[0] = {"before": _iso(oldest), "after": bf.get("after")}
                    new_cursor["gaps"] = gaps[:5]
                    # Holds older than the look-back: ask about each directly.
                    gone_holds: list[str] = []
                    found: list[dict] = []
                    for ext in old_holds[:MAX_HOLD_CHECKS]:
                        res = await up.transaction(ext)
                        if res is None:
                            gone_holds.append(ext)  # released (or expired) at Up
                        else:
                            found.append(res)
                    if found:
                        batches.append((found, None, False))
        except UpAuthError as e:
            hook = await service.get_state(db, file_id, WEBHOOK_KEY, secret=True)
            if hook and hook.get("id"):
                try:  # best effort — Up usually refuses this too once the token is revoked
                    async with UpClient(token) as up:
                        await up.delete_webhook(hook["id"])
                except UpError:
                    pass
            await service.set_state(db, file_id, TOKEN_KEY, None)
            await service.set_state(db, file_id, WEBHOOK_KEY, None)
            await db.commit()
            await _save(db, owner, file_id, _mark("disconnected", str(e)))
            await _record(db, file_id, status="disconnected", error=str(e), last_attempt_at=now.isoformat())
            return {"ok": False, "error": str(e), "disconnected": True}
        except UpError as e:
            await _save(db, owner, file_id, _mark("error", str(e)))
            await _record(db, file_id, status="error", error=str(e), last_attempt_at=now.isoformat())
            return {"ok": False, "error": str(e)}

        left: list[dict] = []

        def apply(d: dict) -> dict:
            total = {"added": 0, "updated": 0, "settled": 0, "removed": 0, "accounts": 0, "carried": 0}
            first = True
            pending_carry = carry
            for rows, window_start, complete in batches:
                st = merge_up(d, accounts if first else [], rows, tz=tz, now=now, window_start=window_start,
                              complete=complete, carry=pending_carry)
                pending_carry = st.waiting
                first = False
                for k, v in st.as_dict().items():
                    total[k] += v
            if event is None:
                for ext in gone_holds:
                    t = remove_external(d, ext)
                    if t is not None:
                        total["removed"] += 1
                        if _has_edits(t):
                            pending_carry = [carry_of(t)] + pending_carry
            left[:] = pending_carry
            subs = subscriptions.merge(d, now.date())
            _mark("ok", connected=True)(d)
            return {"ok": True, **total, "subscriptions": subs}

        try:
            out = await _save(db, owner, file_id, apply)
        except FileFull:
            return await _full(db, owner, file_id, accounts, now)
        if event is None:
            await service.set_state(db, file_id, CURSOR_KEY, new_cursor)
        await service.set_state(db, file_id, CARRY_KEY, left[:50] or None)
        await db.commit()
        await _record(db, file_id, status="ok", error="", last_sync_at=now.isoformat(), last_attempt_at=now.isoformat(),
                      added_last_sync=out.get("added", 0))
        return out


# ---------------------------------------------------------------- webhook


def verify_signature(secret: str, body: bytes, signature: str) -> bool:
    if not secret or not signature:
        return False
    mac = hmac.new(secret.encode("utf-8"), body, hashlib.sha256)
    sig = signature.strip()
    return hmac.compare_digest(mac.hexdigest(), sig.lower()) or hmac.compare_digest(
        __import__("base64").b64encode(mac.digest()).decode(), sig
    )


async def public_origin(db) -> str | None:  # noqa: ANN001
    from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

    row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
    for o in list(getattr(row, "public_origins", None) or []):
        if not isinstance(o, str):
            continue
        o = o.strip().rstrip("/")
        host = o[8:].split("/")[0].split(":")[0].lower() if o.startswith("https://") else ""
        if host and host not in ("localhost", "127.0.0.1") and not host.endswith(".local") and "." in host:
            return o
    return None
