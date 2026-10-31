"""The Journal's actions — the assistant's (and chat's) hands.

Deterministic for (data, args, ctx.now): new ids are a hash of the
arguments and the moment, so a replayed AI write makes the same entry."""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import date, timedelta

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from .logic import (
    brief_entry,
    in_range,
    matches,
    mood_stats,
    newest_first,
    pearson,
    resolve_range,
    sort_key,
    streaks,
    strength,
)
from .models import DAY_RE, MAX_BODY, MAX_ENTRIES, MAX_TEMPLATES, TIME_RE, count_words, norm_tag

# ------------------------------------------------------------------ helpers


def _new_id(prefix: str, taken: set[str], seed: object, ctx: ItemContext) -> str:
    raw = json.dumps(seed, sort_keys=True, default=str) + ctx.now.isoformat()
    base = prefix + hashlib.sha1(raw.encode()).hexdigest()[:9]
    out, n = base, 2
    while out in taken:
        out, n = f"{base}{n}", n + 1
    return out


def _find(data: dict, entry_id: str) -> dict:
    e = next((e for e in data["entries"] if e["id"] == entry_id), None)
    if e is None:
        raise ActionError(f"There's no entry with id {entry_id!r} — use search_entries to find it.")
    return e


def _template(data: dict, tid: str | None) -> dict | None:
    if not tid:
        return None
    t = next((t for t in data.get("templates", []) if t["id"] == tid), None)
    if t is None:
        raise ActionError(f"There's no template with id {tid!r}.")
    return t


class Range(BaseModel):
    start: str | None = Field(default=None, pattern=DAY_RE, description="First day (YYYY-MM-DD), inclusive")
    end: str | None = Field(default=None, pattern=DAY_RE, description="Last day (YYYY-MM-DD), inclusive")
    days: int | None = Field(default=None, ge=1, le=3660, description="Or: the last N days ending at `end` (default today)")


def _range(ctx: ItemContext, p: Range, default_days: int | None) -> tuple[str | None, str | None]:
    return resolve_range(p.start, p.end, p.days, ctx.today, default_days)


# ---------------------------------------------------------------- add entry


class AddEntry(BaseModel):
    person_asked: bool = Field(
        description="True only if the person explicitly asked you to write or draft this entry in this "
        "conversation. Never add entries on your own initiative."
    )
    date: str | None = Field(default=None, pattern=DAY_RE, description="Local day; default today")
    time: str | None = Field(default=None, pattern=TIME_RE, description="HH:MM; default now")
    title: str = Field(default="", max_length=200)
    body: str = Field(default="", max_length=MAX_BODY, description="Markdown, written in the person's own voice and from what they told you")
    mood: int | None = Field(default=None, ge=1, le=5, description="1 Awful … 5 Great — only if they told you")
    emotions: list[str] = Field(default_factory=list, max_length=12)
    energy: int | None = Field(default=None, ge=1, le=5)
    tags: list[str] = Field(default_factory=list, max_length=30)
    gratitude: list[str] = Field(default_factory=list, max_length=10)
    location: str = Field(default="", max_length=200)
    weather: str = Field(default="", max_length=120)
    starred: bool = False
    template_id: str | None = Field(default=None, description="A template's id, to start from its body and tags")
    prompt: str = Field(default="", max_length=500, description="The prompt this answers, if any")


def add_entry(ctx: ItemContext, data: dict, p: AddEntry) -> ActionOutcome:
    if not p.person_asked:
        raise ActionError(
            "Entries are the person's own writing — only add one when they explicitly ask you to write or "
            "draft it. Offer instead, or ask them what they'd like to write."
        )
    if len(data["entries"]) >= MAX_ENTRIES:
        raise ActionError("This journal is full. Start a new journal file for new entries.")
    t = _template(data, p.template_id)
    body = p.body
    if t and not body.strip():
        body = t.get("body", "")
    if not (body.strip() or p.title.strip() or p.gratitude):
        raise ActionError("An entry needs a title, some text or a gratitude item.")
    day = p.date or ctx.today.isoformat()
    when = p.time or ctx.now.strftime("%H:%M")
    eid = _new_id("e", {e["id"] for e in data["entries"]}, p.model_dump(), ctx)
    tags = list(p.tags) + list((t or {}).get("default_tags", []))
    entry = {
        "id": eid,
        "date": day,
        "time": when,
        "created_at": ctx.now.isoformat(),
        "updated_at": ctx.now.isoformat(),
        "title": p.title.strip(),
        "body": body,
        "mood": p.mood,
        "emotions": p.emotions,
        "energy": p.energy,
        "tags": tags,
        "gratitude": p.gratitude,
        "location": p.location,
        "weather": p.weather,
        "starred": p.starred,
        "template_id": p.template_id,
        "prompt": p.prompt or ((t or {}).get("prompts") or [""])[0],
        "ai_drafted": True,
    }
    data["entries"].append(entry)
    words = count_words(entry["title"], body, *p.gratitude)
    named = f" — “{entry['title']}”" if entry["title"] else ""
    return ActionOutcome(
        summary=f"Drafted an entry for {day}{named} (marked as AI-drafted)",
        result={"id": eid, "date": day, "words": words},
    )


# --------------------------------------------------------------- edit entry


class EditEntry(BaseModel):
    id: str
    person_asked: bool = Field(
        default=False,
        description="Required (true) to change or add to the entry's text with `body` or `append`: only when the "
        "person explicitly asked you to rewrite or add to it in this conversation. The entry is then labelled "
        "as edited by the assistant.",
    )
    title: str | None = Field(default=None, max_length=200)
    body: str | None = Field(default=None, max_length=MAX_BODY, description="Replaces the whole body — only when asked to rewrite")
    append: str | None = Field(default=None, max_length=MAX_BODY, description="Text added at the end of the body (a new paragraph)")
    date: str | None = Field(default=None, pattern=DAY_RE)
    time: str | None = Field(default=None, pattern=TIME_RE)
    mood: int | None = Field(default=None, ge=1, le=5, description="Set; pass null to clear")
    emotions: list[str] | None = Field(default=None, max_length=12)
    energy: int | None = Field(default=None, ge=1, le=5, description="Set; pass null to clear")
    tags: list[str] | None = Field(default=None, max_length=30, description="Replaces the tags")
    gratitude: list[str] | None = Field(default=None, max_length=10)
    location: str | None = Field(default=None, max_length=200)
    weather: str | None = Field(default=None, max_length=120)
    starred: bool | None = None


_EDITABLE = ("title", "body", "date", "time", "mood", "emotions", "energy", "tags", "gratitude", "location", "weather", "starred")


def edit_entry(ctx: ItemContext, data: dict, p: EditEntry) -> ActionOutcome:
    e = _find(data, p.id)
    touches_text = ("body" in p.model_fields_set and p.body is not None) or bool(p.append)
    if touches_text and not p.person_asked:
        raise ActionError(
            "An entry's text is the person's own writing — only rewrite or add to it when they explicitly ask "
            "(then set person_asked=true). Offer instead."
        )
    changed = []
    for f in _EDITABLE:
        if f in p.model_fields_set:
            v = getattr(p, f)
            if v is None and f not in ("mood", "energy"):
                continue
            e[f] = v
            changed.append(f)
    if p.append:
        sep = "\n\n" if (e.get("body") or "").strip() else ""
        nxt = (e.get("body") or "").rstrip() + sep + p.append
        if len(nxt) > MAX_BODY:
            raise ActionError(f"That would make the entry longer than {MAX_BODY:,} characters.")
        e["body"] = nxt
        changed.append("body")
    if not changed:
        raise ActionError("Nothing to change — pass at least one field.")
    if "body" in changed:
        e["ai_edited"] = True
    e["updated_at"] = ctx.now.isoformat()
    label = f"“{e['title']}”" if e.get("title") else f"the entry from {e['date']}"
    return ActionOutcome(summary=f"Updated {label} ({', '.join(dict.fromkeys(changed))})", result={"id": e["id"]})


# ------------------------------------------------------------- delete entry


class DeleteEntries(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500, description="Entry ids — confirm with the person first")


def delete_entries(ctx: ItemContext, data: dict, p: DeleteEntries) -> ActionOutcome:
    want = set(p.ids)
    found = [e for e in data["entries"] if e["id"] in want]
    if not found:
        raise ActionError("None of those entries exist.")
    data["entries"] = [e for e in data["entries"] if e["id"] not in want]
    missing = sorted(want - {e["id"] for e in found})
    n = len(found)
    return ActionOutcome(
        summary=f"Deleted {n} entr{'y' if n == 1 else 'ies'} (Undo brings {'it' if n == 1 else 'them'} back)",
        result={"deleted": [e["id"] for e in found], "not_found": missing},
    )


# --------------------------------------------------------------- tag entries


class TagEntries(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=2000, description="Entries to tag; or use a filter below")
    query: str | None = Field(default=None, max_length=200, description="Filter: entries whose text contains all these words")
    range: Range | None = Field(default=None, description="Filter: a date range")
    add: list[str] = Field(default_factory=list, max_length=10)
    remove: list[str] = Field(default_factory=list, max_length=10)


def tag_entries(ctx: ItemContext, data: dict, p: TagEntries) -> ActionOutcome:
    add = [norm_tag(t) for t in p.add if norm_tag(t)]
    remove = {norm_tag(t) for t in p.remove}
    if not add and not remove:
        raise ActionError("Say which tags to add or remove.")
    if not p.ids and not p.query and not p.range:
        raise ActionError("Pick the entries: ids, a query or a date range.")
    start, end = _range(ctx, p.range, None) if p.range else (None, None)
    ids = set(p.ids)
    hit = 0
    for e in data["entries"]:
        if ids and e["id"] not in ids:
            continue
        if not in_range(e, start, end) or not matches(e, p.query):
            continue
        before = list(e.get("tags", []))
        tags = [t for t in before if t not in remove]
        for t in add:
            if t not in tags and len(tags) < 30:
                tags.append(t)
        if tags != before:
            e["tags"] = tags
            e["updated_at"] = ctx.now.isoformat()
            hit += 1
    if hit == 0:
        raise ActionError("No entries matched (or they already had those tags).")
    what = " ".join([*(f"+#{t}" for t in add), *(f"−#{t}" for t in sorted(remove))])
    return ActionOutcome(summary=f"Retagged {hit} entr{'y' if hit == 1 else 'ies'} ({what})", result={"changed": hit})


# -------------------------------------------------------------- templates


class AddTemplate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=5000, description="Markdown the entry starts with, e.g. '## Wins\\n\\n## Challenges\\n'")
    prompts: list[str] = Field(default_factory=list, max_length=20, description="Questions shown while writing")
    gratitude_slots: int = Field(default=0, ge=0, le=10, description="How many gratitude lines to offer")
    target_words: int | None = Field(default=None, ge=10, le=5000)
    default_tags: list[str] = Field(default_factory=list, max_length=10)


def add_template(ctx: ItemContext, data: dict, p: AddTemplate) -> ActionOutcome:
    if len(data["templates"]) >= MAX_TEMPLATES:
        raise ActionError("That's the most templates one journal can hold — delete one first.")
    base = "".join(ch if ch.isalnum() else "-" for ch in p.name.lower()).strip("-")[:30] or "template"
    tid, n = base, 2
    taken = {t["id"] for t in data["templates"]}
    while tid in taken:
        tid, n = f"{base}-{n}", n + 1
    data["templates"].append({**p.model_dump(), "id": tid, "builtin": False, "hidden": False})
    return ActionOutcome(summary=f"Added the template “{p.name}”", result={"id": tid})


# --------------------------------------------------------------- settings


class SetSettings(BaseModel):
    daily_reminder: bool | None = None
    reminder_time: str | None = Field(default=None, pattern=TIME_RE, description="HH:MM local")
    weekly_reminder: bool | None = None
    weekly_day: int | None = Field(default=None, ge=0, le=6, description="0 = Monday … 6 = Sunday")
    weekly_time: str | None = Field(default=None, pattern=TIME_RE)
    week_starts_on: int | None = Field(default=None, ge=0, le=1, description="0 = Sunday, 1 = Monday")
    default_template_id: str | None = None
    show_prompt: bool | None = None
    share_excerpts: bool | None = Field(
        default=None,
        description="Let normal chats, search and Drive AI read a short excerpt of each recent entry (off by "
        "default). Only change it when the person asks.",
    )
    hide_previews: bool | None = None
    add_prompts: list[str] = Field(default_factory=list, max_length=50, description="Custom prompts to add to the library")
    onboarded: bool | None = None


def set_settings(ctx: ItemContext, data: dict, p: SetSettings) -> ActionOutcome:
    s = data["settings"]
    changed = []
    for f in SetSettings.model_fields:
        if f == "add_prompts" or f not in p.model_fields_set:
            continue
        v = getattr(p, f)
        if v is None and f != "default_template_id":
            continue
        if f == "default_template_id" and v:
            _template(data, v)
        s[f] = v
        changed.append(f)
    for q in p.add_prompts:
        q = q.strip()[:300]
        if q and q not in s["custom_prompts"] and len(s["custom_prompts"]) < 200:
            s["custom_prompts"].append(q)
            changed.append("custom_prompts")
    if not changed:
        raise ActionError("Nothing to change.")
    nice = {
        "daily_reminder": "daily reminder", "reminder_time": "reminder time", "weekly_reminder": "weekly reflection reminder",
        "weekly_day": "reflection day", "weekly_time": "reflection time", "custom_prompts": "prompts",
    }
    return ActionOutcome(
        summary="Updated settings: " + ", ".join(dict.fromkeys(nice.get(c, c.replace("_", " ")) for c in changed)),
        result={k: s[k] for k in dict.fromkeys(changed)},
    )


# --------------------------------------------------------------- read-only


class SearchEntries(BaseModel):
    query: str | None = Field(default=None, max_length=200, description="Words that must all appear (title, text, tags, emotions, gratitude, place)")
    range: Range | None = None
    tags: list[str] = Field(default_factory=list, max_length=10, description="Entries with any of these tags")
    emotions: list[str] = Field(default_factory=list, max_length=10)
    mood_min: int | None = Field(default=None, ge=1, le=5)
    mood_max: int | None = Field(default=None, ge=1, le=5)
    starred: bool | None = None
    limit: int = Field(default=20, ge=1, le=50)


def search_entries(ctx: ItemContext, data: dict, p: SearchEntries) -> ActionOutcome:
    start, end = _range(ctx, p.range, None) if p.range else (None, None)
    tags = {norm_tag(t) for t in p.tags}
    emos = {e.strip().lower() for e in p.emotions}
    hits = []
    for e in newest_first(data["entries"]):
        if not in_range(e, start, end) or not matches(e, p.query):
            continue
        if tags and not tags & set(e.get("tags", [])):
            continue
        if emos and not emos & set(e.get("emotions", [])):
            continue
        m = e.get("mood")
        if p.mood_min and (not m or m < p.mood_min):
            continue
        if p.mood_max and (not m or m > p.mood_max):
            continue
        if p.starred is not None and bool(e.get("starred")) != p.starred:
            continue
        hits.append(e)
    first = (p.query or "").split()[0] if p.query else None
    return ActionOutcome(
        summary="",
        result={
            "total": len(hits),
            "shown": min(len(hits), p.limit),
            "entries": [brief_entry(e, 240, first) for e in hits[: p.limit]],
            "hint": "read_entry(id) gives an entry's full text." if hits else "Nothing matched — try fewer words.",
        },
    )


class ReadEntry(BaseModel):
    id: str


def read_entry(ctx: ItemContext, data: dict, p: ReadEntry) -> ActionOutcome:
    return ActionOutcome(summary="", result=_find(data, p.id))


class MoodSummary(BaseModel):
    range: Range = Field(default_factory=Range, description="Default: the last 30 days")


def mood_summary(ctx: ItemContext, data: dict, p: MoodSummary) -> ActionOutcome:
    start, end = _range(ctx, p.range, 30)
    picked = [e for e in data["entries"] if in_range(e, start, end)]
    return ActionOutcome(summary="", result={"start": start, "end": end, **mood_stats(picked)})


class OnThisDay(BaseModel):
    date: str | None = Field(default=None, pattern=DAY_RE, description="Default today")


def on_this_day(ctx: ItemContext, data: dict, p: OnThisDay) -> ActionOutcome:
    d = date.fromisoformat(p.date) if p.date else ctx.today
    md = d.strftime("-%m-%d")
    out = []
    for e in newest_first(data["entries"]):
        if e["date"].endswith(md) and e["date"] < d.isoformat():
            years = d.year - int(e["date"][:4])
            out.append({**brief_entry(e, 400), "years_ago": years})
    return ActionOutcome(summary="", result={"date": d.isoformat(), "entries": out[:20]} if out else {"date": d.isoformat(), "entries": [], "note": "No entries on this day in earlier years."})


class ReflectionData(BaseModel):
    range: Range = Field(default_factory=Range, description="Default: the last 7 days")
    include_text: bool = Field(default=True, description="Include the entries' text (bounded)")


REFLECTION_BUDGET = 14_000


def reflection_data(ctx: ItemContext, data: dict, p: ReflectionData) -> ActionOutcome:
    start, end = _range(ctx, p.range, 7)
    picked = sorted((e for e in data["entries"] if in_range(e, start, end)), key=sort_key)
    stats = mood_stats(picked)
    stats.pop("daily_mood", None)
    per = max(300, min(2500, REFLECTION_BUDGET // max(1, len(picked))))
    entries = []
    for e in picked:
        row = brief_entry(e, per)
        if p.include_text:
            body = e.get("body", "")
            row["text"] = body if len(body) <= per else body[: per - 1] + "…"
            row.pop("excerpt", None)
            if e.get("gratitude"):
                row["gratitude"] = e["gratitude"]
            if e.get("prompt"):
                row["prompt"] = e["prompt"]
        entries.append(row)
    s = streaks(data["entries"], ctx.today)
    days = sorted({e["date"] for e in picked})
    return ActionOutcome(
        summary="",
        result={
            "start": start,
            "end": end,
            "days_with_entries": len(days),
            "stats": stats,
            "gratitude": [g for e in picked for g in e.get("gratitude", [])][:60],
            "starred": [e["id"] for e in picked if e.get("starred")],
            "streak": {"current": s["current"], "longest": s["longest"]},
            "entries": entries[-60:],
            "note": "Ground every observation in these entries; quote sparingly; don't invent events.",
        },
    )


class NoArgs(BaseModel):
    pass


def streak_info(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    entries = data["entries"]
    s = streaks(entries, ctx.today)
    week0 = (ctx.today - timedelta(days=(ctx.today.weekday() + (1 - data["settings"].get("week_starts_on", 1))) % 7)).isoformat()
    month0 = ctx.today.replace(day=1).isoformat()
    years = Counter(e["date"][:4] for e in entries)
    return ActionOutcome(
        summary="",
        result={
            **s,
            "total_entries": len(entries),
            "total_words": sum(e.get("word_count", 0) for e in entries),
            "entries_this_week": sum(1 for e in entries if e["date"] >= week0),
            "entries_this_month": sum(1 for e in entries if e["date"] >= month0),
            "entries_by_year": dict(sorted(years.items())),
        },
    )


class DayValue(BaseModel):
    date: str = Field(pattern=DAY_RE)
    value: float


class CorrelateMood(BaseModel):
    label: str = Field(min_length=1, max_length=80, description="What the values are, e.g. 'sleep hours' or 'meditated (1/0)'")
    values: list[DayValue] = Field(min_length=1, max_length=1000, description="One value per day, read from another app (health, habits)")
    lag_days: int = Field(default=0, ge=0, le=3, description="Compare with mood this many days later (e.g. 1 = does last night's sleep relate to today's mood)")


def correlate_mood(ctx: ItemContext, data: dict, p: CorrelateMood) -> ActionOutcome:
    by_day: dict[str, list[int]] = {}
    for e in data["entries"]:
        if e.get("mood"):
            by_day.setdefault(e["date"], []).append(e["mood"])
    mood = {d: sum(v) / len(v) for d, v in by_day.items()}
    pairs = []
    for dv in p.values:
        target = (date.fromisoformat(dv.date) + timedelta(days=p.lag_days)).isoformat()
        if target in mood:
            pairs.append((dv.value, mood[target]))
    if len(pairs) < 5:
        raise ActionError(f"Only {len(pairs)} day(s) have both a mood and a {p.label} value — not enough to compare (need 5+).")
    xs, ys = [a for a, _ in pairs], [b for _, b in pairs]
    r = pearson(xs, ys)
    med = sorted(xs)[len(xs) // 2]
    hi = [y for x, y in pairs if x >= med]
    lo = [y for x, y in pairs if x < med]
    return ActionOutcome(
        summary="",
        result={
            "label": p.label,
            "days_compared": len(pairs),
            "pearson_r": round(r, 2) if r is not None else None,
            "reading": strength(r, len(pairs)),
            "median_value": med,
            "avg_mood_when_at_or_above_median": round(sum(hi) / len(hi), 2) if hi else None,
            "avg_mood_when_below_median": round(sum(lo) / len(lo), 2) if lo else None,
            "caveat": "Correlation, not causation — other things (workload, illness, season) may drive both.",
        },
    )


ACTIONS = [
    ItemAction(
        "add_entry",
        "Add a journal entry — ONLY when the person explicitly asks you to write or draft one (set person_asked=true). "
        "It is marked as AI-drafted. Use their own words and facts; never invent events or feelings.",
        AddEntry,
        add_entry,
    ),
    ItemAction(
        "edit_entry",
        "Change fields of one entry (title, mood, tags, star, date…). `append` adds a paragraph; `body` replaces the "
        "text — both only when the person explicitly asked (person_asked=true), and the entry is then labelled as "
        "edited by the assistant. Unset fields stay as they are.",
        EditEntry,
        edit_entry,
    ),
    ItemAction("delete_entries", "Delete entries by id (confirm with the person first; Undo restores).", DeleteEntries, delete_entries),
    ItemAction(
        "tag_entries",
        "Add and/or remove tags on many entries at once — by ids, or by a text query and/or date range.",
        TagEntries,
        tag_entries,
    ),
    ItemAction("add_template", "Create a custom entry template (sections, prompts, gratitude lines, word goal).", AddTemplate, add_template),
    ItemAction(
        "set_settings",
        "Change preferences: daily reminder (on/off, time), weekly reflection reminder (day, time), week start, "
        "default template, prompt of the day, privacy (excerpts for chat, hidden previews), add custom prompts.",
        SetSettings,
        set_settings,
    ),
    ItemAction(
        "search_entries",
        "Find entries by words, date range, tags, emotions, mood range or star. Returns ids, dates, moods and excerpts.",
        SearchEntries,
        search_entries,
        writes=False,
        chat=False,  # excerpts of the text: the journal's own panel only
    ),
    ItemAction("read_entry", "One entry in full (by id).", ReadEntry, read_entry, writes=False, chat=False),
    ItemAction(
        "mood_summary",
        "Mood and energy statistics for a range (default last 30 days): average, distribution, trend, by weekday, "
        "top emotions and families, tags and the mood that goes with them, best/hardest days, daily series.",
        MoodSummary,
        mood_summary,
        writes=False,
    ),
    ItemAction(
        "on_this_day", "Entries written on this calendar day in earlier years.", OnThisDay, on_this_day,
        writes=False, chat=False,
    ),
    ItemAction(
        "reflection_data",
        "Everything for a weekly/monthly reflection over a range (default last 7 days): the entries' text "
        "(bounded), gratitude lists, stats, streak. Use before summarising a period.",
        ReflectionData,
        reflection_data,
        writes=False,
        chat=False,
    ),
    ItemAction("streak_info", "Writing streak (current, longest), totals, entries this week/month/by year.", NoArgs, streak_info, writes=False),
    ItemAction(
        "correlate_mood",
        "Compare daily mood with a daily series from another app (sleep hours, steps, a habit done 1/0 — read it "
        "with read_other_item first). Returns Pearson r, a plain reading and mood above/below the median.",
        CorrelateMood,
        correlate_mood,
        writes=False,
    ),
]
