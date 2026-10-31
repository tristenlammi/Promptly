"""``to_text`` — the file as plain text for the person's own chats, search
and Drive AI. Sensitive data, so it carries what helps answer their
questions (current numbers and trends, medicines and schedule, upcoming
appointments, flagged labs, recent symptoms) and leaves out what doesn't
(free-text notes, emergency notes, contact details, raw logs)."""
from __future__ import annotations

from datetime import timedelta
from zoneinfo import ZoneInfo

from app.items.spec import text_now

from . import meds as M
from . import science as S

MAX_CHARS = 20_000


def to_text(data: dict) -> str:
    now = text_now()  # the owner's "now", in their zone
    if not isinstance(now.tzinfo, ZoneInfo):
        now = now.astimezone(ZoneInfo("UTC"))
    today = now.date()
    t = today.isoformat()
    month_ago = (today - timedelta(days=29)).isoformat()
    prof, st = data.get("profile", {}), data.get("settings", {})
    lines: list[str] = []

    about = []
    age = S.age_years(prof.get("birth_date"), today)
    if age is not None:
        about.append(f"age {age}")
    if prof.get("sex") and prof["sex"] != "unspecified":
        about.append(prof["sex"])
    if prof.get("height_cm"):
        about.append(f"height {S.fmt_value(data, 'waist', prof['height_cm'])}")
    units = f"units {st.get('weight_unit', 'kg')}/{st.get('length_unit', 'cm')}/{'mg/dL' if st.get('glucose_unit') == 'mgdl' else 'mmol/L'}"
    lines.append("Profile: " + ", ".join(about + [units]))
    if prof.get("conditions"):
        lines.append("Conditions: " + ", ".join(prof["conditions"]))
    if prof.get("allergies"):
        lines.append("Allergies: " + ", ".join(prof["allergies"]))

    # Latest numbers + 30-day picture
    alpha = st.get("smoothing", 0.1)
    metric_lines = []
    ids = list(S.BUILTIN) + [c["id"] for c in data.get("custom_metrics", [])]
    for mid in ids:
        info = S.metric_info(data, mid)
        if not info:
            continue
        rows = [r for r in data.get("readings", []) if r["metric"] == mid]
        if not rows:
            continue
        last = max(rows, key=lambda r: r["at"])
        if mid == "bp":
            cat = S.bp_category(last["sys"], last["dia"])
            month = [r for r in rows if r["at"][:10] >= month_ago]
            avg = ""
            if len(month) > 1:
                avg = f"; 30-day avg {round(sum(r['sys'] for r in month) / len(month))}/{round(sum(r['dia'] for r in month) / len(month))} over {len(month)} readings"
            metric_lines.append(f"- Blood pressure: latest {last['sys']}/{last['dia']}{(' pulse ' + str(last['pulse'])) if last.get('pulse') else ''} on {last['at'][:10]} ({cat['label'] if cat else ''}){avg}")
            continue
        series = S.daily(data, mid)
        bit = f"- {info['label']}: latest {S.fmt_value(data, mid, list(series.values())[-1])} on {list(series)[-1]}"
        month = {d: v for d, v in series.items() if d >= month_ago}
        if info["smooth"] and len(series) > 2:
            tr = S.ewma(series, alpha)
            tv = [v for d, v in tr.items() if d >= month_ago]
            if len(tv) >= 2:
                delta = S.from_canonical(tv[-1], info["dim"], st) - S.from_canonical(tv[0], info["dim"], st)
                bit += f"; trend {S.fmt_value(data, mid, tv[-1])} ({delta:+.1f} over 30 days)"
        elif len(month) > 1:
            bit += f"; 30-day avg {S.fmt_value(data, mid, sum(month.values()) / len(month))} ({len(month)} days)"
        metric_lines.append(bit)
    if metric_lines:
        lines.append("\nReadings (newest values; trends are smoothed):")
        lines += metric_lines

    if data.get("goals"):
        g = []
        for goal in data["goals"]:
            info = S.metric_info(data, goal["metric"]) or {"label": goal["metric"]}
            if goal.get("target") is not None:
                g.append(f"{info['label']} {S.fmt_value(data, goal['metric'], goal['target'])}{' a day' if goal['direction'] == 'daily' else ''}{(' by ' + goal['target_date']) if goal.get('target_date') else ''}")
            else:
                g.append(f"{info['label']} {S.fmt_value(data, goal['metric'], goal.get('low'))}–{S.fmt_value(data, goal['metric'], goal.get('high'))}")
        lines.append("Goals: " + "; ".join(g))

    active = [m for m in data.get("medications", []) if m.get("active", True) and (not m.get("end") or m["end"] >= t)]
    if active:
        adh = {r["med_id"]: r for r in M.adherence(data, now, 30)["medications"]}
        lines.append("\nMedications & supplements:")
        for m in active:
            plan = M.plan_on(m, today)
            sch = plan["schedule"]
            sds = sch.get("slot_doses") or {}
            when = "as needed" if sch["type"] == "as_needed" else ", ".join(
                f"{x} ({sds[x]['dose']})" if sds.get(x, {}).get("dose") else x for x in sch["times"])
            if sch["type"] == "days":
                when += " on " + ",".join(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d] for d in sch.get("weekdays", []))
            elif sch["type"] == "interval" and sch.get("every_days", 1) > 1:
                when += f" every {sch['every_days']} days"
            extra = []
            a = adh.get(m["id"])
            if a and a.get("adherence_pct") is not None:
                extra.append(f"30-day adherence {a['adherence_pct']}%")
            sup = M.supply(m, today)
            if sup and sup.get("days_left") is not None:
                extra.append(f"~{sup['days_left']:.0f} days' supply left")
            if m.get("max_per_day") or m.get("min_hours_between"):
                extra.append("limit " + ", ".join(filter(None, [
                    f"max {m['max_per_day']}/day" if m.get("max_per_day") else "",
                    f"{m['min_hours_between']:g} h apart" if m.get("min_hours_between") else ""])))
            nxt = [st for st in m.get("schedule_history", []) if st["until"] >= t]
            if nxt:
                extra.append(f"plan changes after {nxt[0]['until']}")
            food = {"with": "with food", "before": "before food", "after": "after food", "empty": "on an empty stomach"}.get(m.get("with_food", "any"))
            if food:
                extra.append(food)
            lines.append(f"- {m['name']} {plan.get('dose', '')} ({m.get('kind', 'medication')}) · {when}" + (f" · {'; '.join(extra)}" if extra else ""))

    upcoming = [a for a in data.get("appointments", []) if a["at"][:10] >= t and not a.get("done")][:8]
    if upcoming:
        lines.append("\nUpcoming appointments:")
        for a in upcoming:
            q = f" · {len(a['questions'])} questions to ask" if a.get("questions") else ""
            lines.append(f"- {a['at'][:16].replace('T', ' ')} {a.get('title') or 'Appointment'}{(' with ' + a['who']) if a.get('who') else ''}{q}")

    labs = sorted(data.get("labs", []), key=lambda r: r["day"], reverse=True)[:25]
    if labs:
        lines.append("\nRecent lab results:")
        for r in labs:
            val = f"{r['value']:g}" if r.get("value") is not None else r.get("value_text", "")
            ref = ""
            if r.get("ref_low") is not None or r.get("ref_high") is not None:
                lo = "" if r.get("ref_low") is None else format(r["ref_low"], "g")
                hi = "" if r.get("ref_high") is None else format(r["ref_high"], "g")
                ref = f" (ref {lo}–{hi})"
            flag = f" [{r['flag'].upper()}]" if r.get("flag") and r["flag"] != "normal" else ""
            lines.append(f"- {r['day']} {r['test']}: {val} {r.get('unit', '')}{ref}{flag}".replace("  ", " "))

    vax = sorted(data.get("vaccinations", []), key=lambda v: v["day"], reverse=True)[:12]
    if vax:
        lines.append("\nVaccinations: " + "; ".join(f"{v['name']} {v['day']}" + (f" (next due {v['next_due']})" if v.get("next_due") else "") for v in vax))

    recent = [s for s in data.get("symptoms", []) if s["at"][:10] >= (today - timedelta(days=13)).isoformat()]
    if recent:
        agg: dict[str, list[int]] = {}
        for s in recent:
            agg.setdefault(s["name"], []).append(s["severity"])
        lines.append("\nSymptoms, last 14 days: " + "; ".join(f"{n} ×{len(v)} (avg {sum(v) / len(v):.0f}/10)" for n, v in sorted(agg.items(), key=lambda x: -len(x[1]))[:12]))

    if st.get("cycle_tracking"):
        fc = S.cycle_forecast(data.get("periods", []), today)
        if fc:
            lines.append(f"\nCycle: day {fc['cycle_day']} (avg cycle {fc['avg_cycle_days']} d); next period ≈ {fc['next_period']}")

    if not any(data.get(k) for k in ("readings", "symptoms", "medications", "appointments", "labs", "vaccinations", "periods")):
        lines.append("Nothing logged yet.")
    return "\n".join(lines)[:MAX_CHARS]
