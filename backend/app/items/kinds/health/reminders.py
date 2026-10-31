"""Reminders: each scheduled dose (one per dose per day, dropped once it's
logged), a follow-up 30 min later if it's still unlogged, refills running low, appointments (the day before and 2 h before),
and an optional daily weigh-in. Recomputed on every save and hourly."""
from __future__ import annotations

from datetime import datetime, time, timedelta

from app.items.spec import REMINDER_HORIZON, ItemContext, Reminder

from . import meds as M


def _food(m: dict) -> str:
    return {"with": " with food", "before": " before food", "after": " after food", "empty": " on an empty stomach"}.get(
        m.get("with_food", "any"), ""
    )


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    st = data.get("settings", {})
    now = ctx.now
    end = now + REMINDER_HORIZON
    discreet = bool(st.get("discreet_reminders"))
    out: list[Reminder] = []

    if st.get("med_reminders", True):
        logged = M.doses_by_slot(data)
        # From a follow-up's span ago, so a dose that's just come due still gets its second nudge.
        for m, day, t, at in M.slots_between(data, (now - M.FOLLOW_UP).date(), end.date(), ctx.tz):
            if (m["id"], day.isoformat(), t) in logged or at > end:
                continue
            key = f"dose:{m['id']}:{day.isoformat()}T{t}"
            dose = M.slot_dose(m, day, t)
            if discreet:
                title, body = f"Time for your {t} dose", "Open Body & Health to mark it taken."
                again_title, again_body = f"Still to log: your {t} dose", "Open Body & Health to mark it taken or skipped."
            else:
                name = f"{m['name']}{(' ' + dose) if dose else ''}"
                title, body = name, f"Due at {t}{_food(m)}. Tap to mark it taken."
                again_title = f"Still to take? {name}"
                again_body = f"Your {t} dose isn't logged yet{_food(m)}. Mark it taken or skipped."
            if at > now:
                out.append(Reminder(key=key, due_at=at, title=title[:200], body=body))
            # One follow-up if it's still unlogged half an hour later (dropped once logged).
            again = at + M.FOLLOW_UP
            if now < again <= end:
                out.append(Reminder(key=f"{key}:again", due_at=again, title=again_title[:200], body=again_body))

    if st.get("refill_reminders", True):
        threshold = st.get("refill_days", 7)
        for m in data.get("medications", []):
            if not M.is_active_on(m, now.date()):
                continue
            sup = M.supply(m, now.date())
            if not sup or sup.get("days_left") is None or sup["days_left"] > threshold:
                continue
            # One nudge per run-out week: a refill moves the date, so the next low gets its own.
            ro = datetime.fromisoformat(sup["runs_out"]).date()
            week = f"{ro.isocalendar().year}-W{ro.isocalendar().week:02d}"
            due = datetime.combine(now.date(), time(9, 0), tzinfo=ctx.tz)
            if due <= now:
                due = now + timedelta(minutes=1)
            name = "a medicine" if discreet else m["name"]
            out.append(
                Reminder(
                    key=f"refill:{m['id']}:{week}",
                    due_at=due,
                    title=f"Refill {name}" if not discreet else "Time to order a refill",
                    body=f"About {sup['days_left']:.0f} days left ({sup['remaining']:g} on hand).",
                )
            )

    if st.get("appointment_reminders", True):
        for a in data.get("appointments", []):
            if a.get("done"):
                continue
            try:
                at = datetime.fromisoformat(a["at"])
            except ValueError:
                continue
            if at.tzinfo is None:
                at = at.replace(tzinfo=ctx.tz)
            if at <= now or at - now > REMINDER_HORIZON + timedelta(days=1):
                continue
            label = a.get("title") or "Appointment"
            who = f" with {a['who']}" if a.get("who") else ""
            local = at.astimezone(ctx.tz)
            day_before = datetime.combine(local.date() - timedelta(days=1), time(18, 0), tzinfo=ctx.tz)
            qs = f" You have {len(a['questions'])} questions to ask." if a.get("questions") else ""
            if day_before > now:
                out.append(Reminder(
                    key=f"appt:{a['id']}:day", due_at=day_before,
                    title=f"Tomorrow: {label}{who}"[:200],
                    body=f"{local.strftime('%H:%M')}{(' at ' + a['location']) if a.get('location') else ''}.{qs}",
                ))
            two_h = at - timedelta(hours=2)
            if two_h > now:
                out.append(Reminder(
                    key=f"appt:{a['id']}:2h", due_at=two_h,
                    title=f"In 2 hours: {label}{who}"[:200],
                    body=f"At {local.strftime('%H:%M')}{(' · ' + a['location']) if a.get('location') else ''}.{qs}",
                ))

    hhmm = st.get("weigh_in_time")
    if hhmm:
        h, mi = (int(x) for x in hhmm.split(":"))
        weighed = {r["at"][:10] for r in data.get("readings", []) if r["metric"] == "weight"}
        for i in range(8):
            day = now.date() + timedelta(days=i)
            due = datetime.combine(day, time(h, mi), tzinfo=ctx.tz)
            if due <= now or due > end or day.isoformat() in weighed:
                continue
            out.append(Reminder(key=f"weigh:{day.isoformat()}", due_at=due, title="Morning weigh-in",
                                body="Same time, same scale, before breakfast — the trend does the rest."))

    out.sort(key=lambda r: r.due_at)
    return out
