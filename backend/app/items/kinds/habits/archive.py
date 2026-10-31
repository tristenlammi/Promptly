"""Archiving older history out of a file that's filling up
(``ItemSpec.archive``): logs and reviews before ``before_day`` move to a new
file; the kept file starts each habit on that day.

* Kept habits keep their every-N-days cadence (``anchor_date`` is frozen
  before the start moves) and the eras still relevant after the cut.
* The archive is a read-mostly snapshot: every habit is archived, ends the
  day before the cut (``end_date``, so later days don't count as missed),
  and reminders are off.
"""
from __future__ import annotations

import copy
from datetime import timedelta

from app.items.spec import ActionError, ItemContext

from . import engine as E


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    try:
        cut = E.parse_day(before_day)
    except ValueError as e:
        raise ActionError(f"{before_day!r} isn't a day (YYYY-MM-DD).") from e
    last = (cut - timedelta(days=1)).isoformat()
    kept = copy.deepcopy(data)
    arch = copy.deepcopy(data)
    arch_habits = []
    moved = 0
    for kh, ah in zip(kept.get("habits", []), arch.get("habits", [])):
        start = E.start_of(kh)
        anchor = E.anchor_of(kh, start)
        old = [lg for lg in kh.get("logs", []) if lg["day"] < before_day]
        moved += len(old)
        kh["logs"] = [lg for lg in kh.get("logs", []) if lg["day"] >= before_day]
        if start is None or start >= cut:
            continue  # nothing of this habit is older than the cut
        kh["start_date"] = before_day
        if anchor and not kh.get("anchor_date"):
            kh["anchor_date"] = anchor.isoformat()
        kh["history"] = [e for e in kh.get("history") or [] if e["until"] > before_day]
        ah["logs"] = old
        ah["archived"] = True
        ah["active_timer"] = None
        ah["reminders"] = []
        if anchor and not ah.get("anchor_date"):
            ah["anchor_date"] = anchor.isoformat()
        if not ah.get("end_date") or ah["end_date"] > last:
            ah["end_date"] = last
        arch_habits.append(ah)
    if not moved and not any(r["week"] < before_day for r in data.get("reviews", [])):
        raise ActionError(f"There's nothing before {before_day} to archive.")
    arch["habits"] = arch_habits
    kept["reviews"] = [r for r in kept.get("reviews", []) if r["week"] >= before_day]
    arch["reviews"] = [r for r in arch.get("reviews", []) if r["week"] < before_day]
    arch.setdefault("settings", {})["reminders_on"] = False
    arch["settings"]["onboarded"] = True
    return kept, arch
