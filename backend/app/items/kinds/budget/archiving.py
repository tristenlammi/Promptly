"""Archiving older transactions out of a budget that's filling up.

``ItemSpec.archive(data, ctx, before_day)`` → ``(kept, archived)``. The cut
is moved back to the start of the budget month that contains ``before_day``
so no month is split between two files. Both files keep the accounts,
categories, groups, rules, goals, subscriptions, budgets (``months``) and
settings; only the transactions are divided.

So the budget maths doesn't change in the kept file, it gets a
``carry_in``: the rollover balances and "to be budgeted" as the first kept
month opened (computed on the whole data before the cut). The archive file
is a plain, disconnected budget (no Up connection — the token stays with
this file), and the kept file remembers the cut (``up.archived_before``) so
a sync never pulls the archived Up transactions back in.
"""
from __future__ import annotations

import copy

from app.items.kinds.budget import logic
from app.items.spec import ActionError, ItemContext


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    sd = (data.get("settings") or {}).get("month_start_day", 1)
    try:
        logic.parse_day(before_day)
    except ValueError as e:
        raise ActionError("Pick a date to archive before.") from e
    month = logic.month_of(before_day, sd)
    cut = logic.month_range(month, sd)[0].isoformat()
    txns = data.get("transactions") or []
    old = [t for t in txns if t["date"] < cut]
    if not old:
        raise ActionError(f"There are no transactions before {cut} to archive.")
    kept = copy.deepcopy(data)
    kept["transactions"] = [t for t in txns if t["date"] >= cut]
    ci = data.get("carry_in")
    if not ci or ci.get("month", "") < month:
        kept["carry_in"] = logic.carry_at(data, month)
    up = dict(kept.get("up") or {})
    if not up.get("archived_before") or up["archived_before"] < cut:
        up["archived_before"] = cut
    if up.get("status") == "full":
        up["status"] = "ok" if up.get("connected") else "off"
        up["last_error"] = ""
    kept["up"] = up

    archived = copy.deepcopy(data)
    archived["transactions"] = old
    archived["up"] = {"connected": False, "status": "off", "last_error": "", "webhook": False}
    archived.setdefault("settings", {})["onboarded"] = True
    return kept, archived
