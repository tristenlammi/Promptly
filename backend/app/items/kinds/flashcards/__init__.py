"""Flashcards (``.cards``): decks (with optional per-deck daily limits),
basic / reversed / cloze / type-in cards with Markdown, math, images and
audio (Drive files, ``![…](drive:<id>)``), FSRS-6 spaced repetition
(mirrored in TypeScript; golden fixture in the tests), a phone-first study
flow that runs on the device, Anki ``.apkg`` import (``routes.py`` /
``apkg.py``), Quizlet / CSV / Anki-text import, stats, archiving of old
review history, and an AI tutor that writes cards by the 20 rules."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app.items.spec import ActionError, ItemContext, ItemSpec, Reminder, text_now

from . import fsrs, study
from .actions import ACTIONS
from .brief import AI_BRIEF, AI_SUGGESTIONS
from .models import FlashcardsData
from .routes import router

MAX_TEXT = 20_000


def template(ctx: ItemContext) -> dict:
    return FlashcardsData().model_dump(mode="json")


def to_text(data: dict) -> str:
    now = text_now()  # aware, in the owner's zone (the same "today" as the app)
    cfg = fsrs.config_from(data.get("settings") or {}, now.tzinfo or ZoneInfo("UTC"))
    s = data.get("settings") or {}
    paths = study.deck_paths(data)
    c = study.counts(data, now, cfg)
    n, studied = study.streak(data, now, cfg)
    ret = study.retention(data, now, cfg)
    ret_txt = f"{ret['retention']:.0%}" if ret["retention"] is not None else "n/a"
    lines = [
        f"Flashcards: {len(data.get('cards', []))} cards in {len(data.get('decks', []))} decks. "
        f"Due now: {c['learning']} learning, {c['review']} reviews, {c['new']} new. "
        f"Streak: {n} day{'s' if n != 1 else ''}{' (studied today)' if studied else ''}.",
        f"True retention (30 d): {ret_txt} over {ret['reviews']} reviews; "
        f"target {s.get('desired_retention', 0.9):.0%}. Limits: {s.get('new_per_day', 20)} new/day, {s.get('max_reviews_per_day', 200)} reviews/day."
        + (f" Exam date: {s['exam_date']}." if s.get("exam_date") else ""),
    ]
    if data.get("log_trimmed"):
        lines.append(f"Note: {data['log_trimmed']} of the oldest review-log entries were dropped at the history cap.")
    lines += ["", "Decks:"]
    per = study.deck_counts(data, now, cfg)  # one pass over the cards, not one per deck
    for d in sorted(data.get("decks", []), key=lambda d: paths.get(d["id"], "")):
        dc = per.get(d["id"], {"cards": 0, "review": 0, "new": 0})
        desc = f" — {d['description'][:120]}" if d.get("description") else ""
        lim = []
        if d.get("new_per_day") is not None:
            lim.append(f"{d['new_per_day']} new/day")
        if d.get("max_reviews_per_day") is not None:
            lim.append(f"{d['max_reviews_per_day']} reviews/day")
        lim_txt = f" (own limits: {', '.join(lim)})" if lim else ""
        lines.append(f"- {paths[d['id']]}: {dc['cards']} cards (with subdecks); due {dc['review']} reviews, {dc['new']} new{lim_txt}{desc}")
    days: dict[str, int] = {}
    for e in data.get("review_log", [])[-3000:]:
        days[e["t"][:10]] = days.get(e["t"][:10], 0) + 1
    if days:
        recent = sorted(days.items(), reverse=True)[:14]
        lines += ["", "Reviews by day: " + ", ".join(f"{d}: {k}" for d, k in recent)]
    lines += ["", "Cards (newest first):"]
    out = "\n".join(lines)
    for card in sorted(data.get("cards", []), key=lambda x: x.get("created", ""), reverse=True):
        tags = f" #{' #'.join(card['tags'])}" if card.get("tags") else ""
        flag = " [suspended]" if card.get("suspended") else ""
        back = f" → {study.one_line(card['back'], 140)}" if card.get("back") else ""
        row = f"\n- [{paths.get(card['deck_id'], '')}] {study.one_line(card['front'], 200)}{back}{tags}{flag}"
        if len(out) + len(row) > MAX_TEXT:
            out += "\n…"
            break
        out += row
    return out


def archive(data: dict, ctx: ItemContext, before_day: str) -> tuple[dict, dict]:
    """Move review-log entries from study days before ``before_day`` into a
    new file. Scheduling lives on the cards, so the schedule is untouched;
    only history (stats, streaks before then) moves. The archive holds the
    cards those entries are about — suspended, so it never asks for study."""
    try:
        cut = date.fromisoformat(before_day)
    except ValueError as e:
        raise ActionError("before must be YYYY-MM-DD.") from e
    cfg = fsrs.config_from(data.get("settings") or {}, ctx.tz)
    keep, old = [], []
    for e in data.get("review_log", []):
        try:
            day = date.fromordinal(fsrs.day_index(fsrs.parse_moment(e["t"]), cfg))
        except (ValueError, KeyError, TypeError):
            keep.append(e)
            continue
        (old if day < cut else keep).append(e)
    if not old:
        raise ActionError(f"There's no review history before {before_day} to archive.")
    kept = {**data, "review_log": keep}
    ids = {e["c"] for e in old}
    cards = [
        {**c, "suspended": True, "tags": list(dict.fromkeys([*c.get("tags", []), "archived"]))[:30]}
        for c in data.get("cards", []) if c["id"] in ids
    ]
    deck_ids = {c["deck_id"] for c in cards}
    chains = study.deck_chains(data)
    want = {a for did in deck_ids for a in chains.get(did, [did])}
    archived = {
        "settings": {**(data.get("settings") or {}), "onboarded": True, "reminder_enabled": False, "streak_nudge": False},
        "decks": [d for d in data.get("decks", []) if d["id"] in want],
        "cards": cards,
        "review_log": old,
    }
    return SPEC.validate(kept), SPEC.validate(archived)


def _at(day: date, hhmm: str, ctx: ItemContext) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, h, m, tzinfo=ctx.tz)


def reminders(data: dict, ctx: ItemContext) -> list[Reminder]:
    s = data.get("settings") or {}
    if not data.get("cards"):
        return []
    cfg = fsrs.config_from(s, ctx.tz)
    out: list[Reminder] = []
    if s.get("reminder_enabled", True):
        for i in range(8):
            day = ctx.today + timedelta(days=i)
            at = _at(day, s.get("reminder_time", "19:00"), ctx)
            if at <= ctx.now:
                continue
            c = study.counts(data, at, cfg)
            if c["total"] <= 0:
                continue
            parts = [f"{c['review'] + c['learning']} to review"] if c["review"] + c["learning"] else []
            if c["new"]:
                parts.append(f"{c['new']} new")
            mins = max(1, round((c["review"] + c["learning"]) * 8 / 60 + c["new"] * 25 / 60))
            out.append(Reminder(
                key=f"study:{day.isoformat()}", due_at=at, title="Flashcards are due",
                body=f"{' and '.join(parts)} — about {mins} min.",
            ))
    if s.get("streak_nudge"):
        n, studied = study.streak(data, ctx.now, cfg)
        at = _at(ctx.today, s.get("streak_nudge_time", "21:00"), ctx)
        if n >= 1 and not studied and at > ctx.now:
            out.append(Reminder(
                key=f"streak:{ctx.today.isoformat()}", due_at=at, title=f"Keep your {n}-day streak",
                body="A few cards before bed keeps it going.",
            ))
    return out


SPEC = ItemSpec(
    kind="flashcards",
    name="Flashcards",
    tagline="Remember anything — modern spaced repetition with an AI tutor.",
    description=(
        "Decks of basic, reversed, cloze and type-in cards with Markdown, math, images and audio, scheduled by "
        "FSRS-6 — the algorithm behind modern Anki — so you review each card right before you'd forget it. "
        "A fast, one-handed study flow with swipe and keyboard answers that works offline once the file is open, "
        "Anki .apkg packages (with scheduling history and media), Quizlet and CSV imports, honest stats (true "
        "retention, forecasts, streaks) and an assistant that writes great cards from your notes."
    ),
    category="Learning",
    icon="layers",
    color="#5B6DD9",
    suffix=".cards",
    model=FlashcardsData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=AI_SUGGESTIONS,
    ai_web=True,
    reminders=reminders,
    router=router,
    archive=archive,
    replaces="Replaces Anki, Quizlet and RemNote",
    highlights=[
        "FSRS-6 scheduling with your own desired retention — fewer reviews for the same memory",
        "Basic, reversed, cloze ({{c1::…}}) and type-in cards with Markdown, KaTeX math, images and audio",
        "Phone-first study: tap to flip, swipe or press 1–4, next-interval labels, undo — offline once open",
        "Nested decks with their own daily limits, tags, flags, suspend and bury, a fast card browser",
        "Import Anki .apkg packages (notes, decks, tags, review history, media; Anki 2.1 \"compatible\" exports), "
        "Anki text exports, Quizlet sets and CSV/TSV; export CSV",
        "Stats: review heatmap, true retention vs target, 30-day forecast, streaks, time",
        "Cram or multiple-choice \"Learn\" any tag or deck without touching your schedule",
        "AI tutor: decks from your notes, fixes leeches, exam plans and quizzes",
    ],
)
