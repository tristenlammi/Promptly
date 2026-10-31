"""Archiving older data out of a file that's filling up.

Readings, symptoms and dose records before a day move to a new archive
file; the profile, medicines, goals, settings, appointments, labs,
vaccinations and cycle log stay in the working file (they're small and the
present needs them). The archive gets copies of the profile, units, custom
metrics and medicines so its own charts and dose history still read
properly — with every reminder switched off, so it never nags.
"""
from __future__ import annotations

import copy
from datetime import date

from app.items.spec import ActionError, ItemContext


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    try:
        cut = date.fromisoformat(before_day).isoformat()
    except (TypeError, ValueError) as e:
        raise ActionError(f"{before_day!r} isn't a date (use YYYY-MM-DD).") from e
    if cut > ctx.today.isoformat():
        raise ActionError("Pick a day that isn't in the future.")

    def split(rows: list[dict], day_of) -> tuple[list[dict], list[dict]]:
        old, new = [], []
        for r in rows:
            (old if day_of(r) < cut else new).append(r)
        return old, new

    old_r, new_r = split(data.get("readings", []), lambda r: (r.get("at") or "")[:10])
    old_s, new_s = split(data.get("symptoms", []), lambda r: (r.get("at") or "")[:10])
    old_d, new_d = split(data.get("doses", []), lambda r: r.get("day") or "")
    if not (old_r or old_s or old_d):
        raise ActionError(f"Nothing was logged before {cut} — there's nothing to archive.")

    kept = copy.deepcopy(data)
    kept.update(readings=new_r, symptoms=new_s, doses=new_d)

    settings = copy.deepcopy(data.get("settings", {}))
    settings.update(med_reminders=False, refill_reminders=False, appointment_reminders=False, weigh_in_time=None, onboarded=True)
    meds = copy.deepcopy(data.get("medications", []))
    for m in meds:
        m["remaining"] = None  # supply belongs to the working file
    archived = {
        "profile": copy.deepcopy(data.get("profile", {})),
        "settings": settings,
        "custom_metrics": copy.deepcopy(data.get("custom_metrics", [])),
        "goals": [],
        "readings": old_r,
        "symptoms": old_s,
        "periods": [],
        "medications": meds,
        "doses": old_d,
        "appointments": [],
        "labs": [],
        "vaccinations": [],
    }
    return kept, archived
