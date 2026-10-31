"""Decks, search, today's queue, counts, forecasts and stats — the numbers
the AI, ``to_text`` and reminders use. The study queue rules are mirrored
in ``frontend/.../flashcards/queue.ts`` (what the Study tab shows):

* Learning / relearning items due now come first; one due within 20 min
  is shown early only when nothing else is left (Anki's learn-ahead).
* Then reviews due by the end of the study day (oldest first), capped by
  ``max_reviews_per_day`` minus today's reviews, interleaved with new
  items capped by ``new_per_day`` minus today's new ones (``new_mix``).
* Suspended cards, buried cards and (with ``bury_siblings``) a card's other
  items once one was studied today are left out — except learning ones.
* A deck may have its own daily limits (``Deck.new_per_day`` /
  ``max_reviews_per_day``): they cover its subdecks, and every limit on the
  way up the deck tree applies, as well as the file-wide ones (``Caps``).
"""
from __future__ import annotations

import math
import re
import shlex
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from . import fsrs
from .cloze import render_plain

LEARN_AHEAD = timedelta(minutes=fsrs.LEARN_AHEAD_MIN)


# ------------------------------------------------------------------ decks


def deck_paths(data: dict) -> dict[str, str]:
    """deck id → "Parent::Child" path."""
    by_id = {d["id"]: d for d in data.get("decks", [])}
    out: dict[str, str] = {}

    def path(did: str, depth: int = 0) -> str:
        if did in out:
            return out[did]
        d = by_id.get(did)
        if d is None:
            return ""
        p = d.get("parent_id")
        name = d["name"] if not p or depth > 20 else f"{path(p, depth + 1)}::{d['name']}"
        out[did] = name
        return name

    for did in by_id:
        path(did)
    return out


def subtree(data: dict, deck_id: str) -> set[str]:
    kids: dict[str | None, list[str]] = defaultdict(list)
    for d in data.get("decks", []):
        kids[d.get("parent_id")].append(d["id"])
    out, stack = set(), [deck_id]
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(kids.get(cur, []))
    return out


def find_deck(data: dict, ref: str | None) -> dict | None:
    """A deck by id, full path or (unique) name, case-insensitive."""
    if not ref:
        return None
    ref = ref.strip()
    decks = data.get("decks", [])
    for d in decks:
        if d["id"] == ref:
            return d
    paths = deck_paths(data)
    low = ref.lower()
    for d in decks:
        if paths.get(d["id"], "").lower() == low:
            return d
    named = [d for d in decks if d["name"].lower() == low]
    return named[0] if len(named) == 1 else None


# ----------------------------------------------------------------- search


def _tokens(query: str) -> list[str]:
    try:
        return shlex.split(query or "")
    except ValueError:
        return (query or "").split()


def card_state(card: dict, now: datetime, cfg: fsrs.Config) -> str:
    """The card's headline state: suspended / buried / new / learning / review."""
    if card.get("suspended"):
        return "suspended"
    states = {s.get("state") for s in card.get("srs", [])}
    if "learning" in states or "relearning" in states:
        return "learning"
    if states == {"new"} or not states:
        return "new"
    return "review"


def is_due(card: dict, now: datetime, cfg: fsrs.Config) -> bool:
    if card.get("suspended"):
        return False
    end = fsrs.day_start(fsrs.day_index(now, cfg) + 1, cfg)
    for s in card.get("srs", []):
        if s.get("state") != "new" and s.get("due") and fsrs.parse_moment(s["due"]) < end:
            return True
    return False


def matches(card: dict, query: str, data: dict, now: datetime, cfg: fsrs.Config, paths: dict[str, str]) -> bool:
    """Search syntax (mirrored in TS): words match front/back/note;
    ``tag:x`` ``deck:x`` (with subdecks) ``is:new|learning|review|due|suspended|flagged|buried|leech``
    ``type:basic|reversed|cloze|typein``; ``-`` negates; "quoted phrases"."""
    for tok in _tokens(query):
        neg = tok.startswith("-") and len(tok) > 1
        t = tok[1:] if neg else tok
        low = t.lower()
        if low.startswith("tag:"):
            want = low[4:]
            ok = any(tag.lower() == want or tag.lower().startswith(want + "::") or (want.endswith("*") and tag.lower().startswith(want[:-1])) for tag in card.get("tags", []))
        elif low.startswith("deck:"):
            want = low[5:]
            p = paths.get(card["deck_id"], "").lower()
            ok = p == want or p.startswith(want + "::") or (want.endswith("*") and p.startswith(want[:-1]))
        elif low.startswith("is:"):
            what = low[3:]
            if what == "due":
                ok = is_due(card, now, cfg)
            elif what == "suspended":
                ok = bool(card.get("suspended"))
            elif what == "flagged":
                ok = bool(card.get("flagged"))
            elif what == "buried":
                ok = bool(card.get("buried_until")) and card["buried_until"] > fsrs.study_date(now, cfg)
            elif what == "leech":
                ok = "leech" in (x.lower() for x in card.get("tags", []))
            else:
                ok = card_state(card, now, cfg) == what
        elif low.startswith("type:"):
            ok = card.get("type") == low[5:]
        else:
            hay = f"{card.get('front', '')}\n{card.get('back', '')}\n{card.get('note', '')}".lower()
            ok = low in hay
        if ok == neg:
            return False
    return True


# ------------------------------------------------------------------ today


def today_log(data: dict, now: datetime, cfg: fsrs.Config) -> list[dict]:
    """Today's answers. The log is kept in time order, but replays and
    several devices can leave entries slightly out of order, so scanning
    back stops only once entries are two study days old, not at the first
    older one."""
    today = fsrs.day_index(now, cfg)
    out = []
    for e in reversed(data.get("review_log", [])):
        try:
            di = fsrs.day_index(fsrs.parse_moment(e["t"]), cfg)
        except (ValueError, KeyError, TypeError):
            continue
        if di == today:
            out.append(e)
        elif di < today - 1:
            break
    return out


def deck_chains(data: dict) -> dict[str, list[str]]:
    """deck id -> [deck, parent, grandparent...] (cycle-safe)."""
    parent = {d["id"]: d.get("parent_id") for d in data.get("decks", [])}
    out: dict[str, list[str]] = {}
    for did in parent:
        chain, cur, seen = [], did, set()
        while cur is not None and cur in parent and cur not in seen and len(chain) < 25:
            chain.append(cur)
            seen.add(cur)
            cur = parent[cur]
        out[did] = chain
    return out


class Caps:
    """Today's daily limits: the file-wide ones plus each deck's own
    (Anki-style: a deck's limit covers its subdecks, and every limit on the
    way up applies). Mirrored in ``queue.ts`` (``makeCaps``)."""

    def __init__(self, data: dict, done: list[dict]):
        s = data.get("settings", {})
        self.chains = deck_chains(data)
        self.new_left = max(0, int(s.get("new_per_day", 20)) - sum(1 for e in done if e.get("s") == "n"))
        self.rev_left = max(0, int(s.get("max_reviews_per_day", 200)) - sum(1 for e in done if e.get("s") == "r"))
        self.deck_new: dict[str, int] = {}
        self.deck_rev: dict[str, int] = {}
        for d in data.get("decks", []):
            if d.get("new_per_day") is not None:
                self.deck_new[d["id"]] = int(d["new_per_day"])
            if d.get("max_reviews_per_day") is not None:
                self.deck_rev[d["id"]] = int(d["max_reviews_per_day"])
        if self.deck_new or self.deck_rev:
            card_deck = {c["id"]: c["deck_id"] for c in data.get("cards", [])}
            for e in done:
                lim = self.deck_new if e.get("s") == "n" else self.deck_rev if e.get("s") == "r" else None
                if lim is None or e.get("c") not in card_deck:
                    continue
                for did in self.chains.get(card_deck[e["c"]], []):
                    if did in lim:
                        lim[did] -= 1

    def take(self, deck_id: str, kind: str) -> bool:
        """Room for one more ``kind`` (new / review) item from ``deck_id``? Takes it if so."""
        lim = self.deck_new if kind == "new" else self.deck_rev
        if (self.new_left if kind == "new" else self.rev_left) <= 0:
            return False
        chain = [d for d in self.chains.get(deck_id, []) if d in lim] if lim else []
        if any(lim[d] <= 0 for d in chain):
            return False
        for d in chain:
            lim[d] -= 1
        if kind == "new":
            self.new_left -= 1
        else:
            self.rev_left -= 1
        return True


def counts(data: dict, now: datetime, cfg: fsrs.Config, deck_ids: set[str] | None = None) -> dict:
    """What's due now: {learning, review, new} after limits, plus
    ``learning_later`` (due later today) and today's done counts."""
    settings = data.get("settings", {})
    end = fsrs.day_start(fsrs.day_index(now, cfg) + 1, cfg)
    today = fsrs.study_date(now, cfg)
    done = today_log(data, now, cfg)
    studied = {e["c"] for e in done}
    new_done = sum(1 for e in done if e.get("s") == "n")
    rev_done = sum(1 for e in done if e.get("s") == "r")
    bury = settings.get("bury_siblings", True)
    learning = later = 0
    reviews: list[tuple[datetime, str]] = []
    fresh: list[str] = []
    for c in data.get("cards", []):
        if c.get("suspended") or (deck_ids is not None and c["deck_id"] not in deck_ids):
            continue
        if c.get("buried_until") and c["buried_until"] > today:
            continue
        taken = bury and c["id"] in studied
        for s in c.get("srs", []):
            st = s.get("state")
            if st in ("learning", "relearning"):
                due = fsrs.parse_moment(s["due"]) if s.get("due") else now
                if due <= now:
                    learning += 1
                elif due < end:
                    later += 1
                continue
            if taken:
                continue
            if st == "review" and s.get("due") and fsrs.parse_moment(s["due"]) < end:
                reviews.append((fsrs.parse_moment(s["due"]), c["deck_id"]))
                taken = bury
            elif st == "new":
                fresh.append(c["deck_id"])
                taken = bury
    caps = Caps(data, done)
    reviews.sort(key=lambda x: x[0])
    review = sum(1 for _, did in reviews if caps.take(did, "review"))
    new = sum(1 for did in fresh if caps.take(did, "new"))
    return {
        "learning": learning, "learning_later": later, "review": review, "new": new,
        "total": learning + review + new, "done_today": len(done), "new_done_today": new_done,
        "reviews_done_today": rev_done,
    }


def deck_counts(data: dict, now: datetime, cfg: fsrs.Config) -> dict[str, dict]:
    """Due counts for every deck with its subdecks, in one pass (``to_text``,
    ``due_summary``); mirrors ``queue.ts`` ``deckCounts``. A deck's numbers
    are capped by today's file-wide limits and every deck limit on the way up."""
    s = data.get("settings", {})
    end = fsrs.day_start(fsrs.day_index(now, cfg) + 1, cfg)
    day = fsrs.study_date(now, cfg)
    done = today_log(data, now, cfg)
    studied = {e["c"] for e in done}
    bury = s.get("bury_siblings", True)
    own = {d["id"]: {"learning": 0, "review": 0, "new": 0, "cards": 0} for d in data.get("decks", [])}
    for c in data.get("cards", []):
        k = own.get(c["deck_id"])
        if k is None:
            continue
        k["cards"] += 1
        if c.get("suspended") or (c.get("buried_until") and c["buried_until"] > day):
            continue
        taken = bury and c["id"] in studied
        for srs in c.get("srs", []):
            st = srs.get("state")
            if st in ("learning", "relearning"):
                if not srs.get("due") or fsrs.parse_moment(srs["due"]) <= now:
                    k["learning"] += 1
                continue
            if taken:
                continue
            if st == "review" and srs.get("due") and fsrs.parse_moment(srs["due"]) < end:
                k["review"] += 1
                taken = bury
            elif st == "new":
                k["new"] += 1
                taken = bury
    chains = deck_chains(data)
    out = {did: dict(v) for did, v in own.items()}
    for did, v in own.items():
        for anc in chains.get(did, [])[1:]:
            for f in ("learning", "review", "new", "cards"):
                out[anc][f] += v[f]
    caps = Caps(data, done)
    for did, v in out.items():
        nl = [caps.deck_new[a] for a in chains.get(did, []) if a in caps.deck_new]
        rl = [caps.deck_rev[a] for a in chains.get(did, []) if a in caps.deck_rev]
        v["new"] = max(0, min([v["new"], caps.new_left, *nl]))
        v["review"] = max(0, min([v["review"], caps.rev_left, *rl]))
    return out


def forecast(data: dict, now: datetime, cfg: fsrs.Config, days: int = 30, deck_ids: set[str] | None = None) -> list[dict]:
    """Review items falling due on each of the next ``days`` study days
    (overdue ones count today), if nothing were studied meanwhile."""
    today = fsrs.day_index(now, cfg)
    buckets = Counter()
    for c in data.get("cards", []):
        if c.get("suspended") or (deck_ids is not None and c["deck_id"] not in deck_ids):
            continue
        for s in c.get("srs", []):
            if s.get("state") == "new" or not s.get("due"):
                continue
            di = max(today, fsrs.day_index(fsrs.parse_moment(s["due"]), cfg))
            if di - today < days:
                buckets[di - today] += 1
    return [
        {"day": date.fromordinal(today + i).isoformat(), "due": buckets.get(i, 0)} for i in range(days)
    ]


def streak(data: dict, now: datetime, cfg: fsrs.Config) -> tuple[int, bool]:
    """(days in a row with reviews, studied today?). A streak survives until
    today ends — yesterday's counts while today is still open."""
    days = set()
    for e in data.get("review_log", []):
        try:
            days.add(fsrs.day_index(fsrs.parse_moment(e["t"]), cfg))
        except (ValueError, KeyError):
            continue
    today = fsrs.day_index(now, cfg)
    studied = today in days
    cur = today if studied else today - 1
    n = 0
    while cur in days:
        n += 1
        cur -= 1
    return n, studied


def retention(data: dict, now: datetime, cfg: fsrs.Config, days: int = 30, deck_ids: set[str] | None = None) -> dict:
    """True retention: share of reviews of cards in the Review state that
    weren't Again (Anki's definition), over the last ``days``."""
    since = now - timedelta(days=days)
    cards = None if deck_ids is None else {c["id"] for c in data.get("cards", []) if c["deck_id"] in deck_ids}
    n = passed = 0
    for e in data.get("review_log", []):
        if e.get("s") != "r" or (cards is not None and e["c"] not in cards):
            continue
        try:
            if fsrs.parse_moment(e["t"]) < since:
                continue
        except ValueError:
            continue
        n += 1
        passed += e["r"] > 1
    return {"reviews": n, "retention": round(passed / n, 3) if n else None, "target": cfg.retention}


def deck_stats(data: dict, now: datetime, cfg: fsrs.Config, deck_ids: set[str] | None = None) -> dict:
    states = Counter()
    items = Counter()
    rs: list[float] = []
    mature = 0
    lapses: list[tuple[int, dict]] = []
    n_cards = 0
    for c in data.get("cards", []):
        if deck_ids is not None and c["deck_id"] not in deck_ids:
            continue
        n_cards += 1
        states[card_state(c, now, cfg)] += 1
        for s in c.get("srs", []):
            items[s.get("state", "new")] += 1
            r = fsrs.current_retrievability(s, now, cfg)
            if r is not None:
                rs.append(r)
            if (s.get("stability") or 0) >= 21 and s.get("state") == "review":
                mature += 1
        worst = max((s.get("lapses", 0) for s in c.get("srs", [])), default=0)
        if worst:
            lapses.append((worst, c))
    cards = None if deck_ids is None else {c["id"] for c in data.get("cards", []) if c["deck_id"] in deck_ids}
    log = [e for e in data.get("review_log", []) if cards is None or e["c"] in cards]
    since = now - timedelta(days=30)
    recent = []
    for e in log:
        try:
            if fsrs.parse_moment(e["t"]) >= since:
                recent.append(e)
        except ValueError:
            continue
    lapses.sort(key=lambda x: -x[0])
    return {
        "cards": n_cards,
        "card_states": dict(states),
        "review_items": dict(items),
        "mature_items": mature,
        "average_recall_now": round(sum(rs) / len(rs), 3) if rs else None,
        "reviews_last_30d": len(recent),
        "minutes_last_30d": round(sum(min(e.get("d", 0), 60_000) for e in recent) / 60_000, 1),
        "ratings_last_30d": dict(Counter({1: "again", 2: "hard", 3: "good", 4: "easy"}[e["r"]] for e in recent)),
        "true_retention_30d": retention(data, now, cfg, 30, deck_ids),
        "hardest": [
            {"id": c["id"], "lapses": n, "front": render_plain(c.get("front", ""))[:120]} for n, c in lapses[:10]
        ],
    }


def exam_plan(data: dict, now: datetime, cfg: fsrs.Config, exam: date, deck_ids: set[str] | None = None) -> dict:
    """Readiness for an exam: what's unseen, the projected recall of the
    seen items on the day, and the new cards a day it takes to see all."""
    today = fsrs.day_index(now, cfg)
    exam_idx = exam.toordinal()
    days_left = exam_idx - today
    unseen = weak = seen = 0
    for c in data.get("cards", []):
        if c.get("suspended") or (deck_ids is not None and c["deck_id"] not in deck_ids):
            continue
        for s in c.get("srs", []):
            if s.get("state") == "new" or not s.get("stability") or not s.get("last_review"):
                unseen += 1
                continue
            seen += 1
            t = exam_idx - fsrs.day_index(fsrs.parse_moment(s["last_review"]), cfg)
            if fsrs.retrievability(t, s["stability"], cfg) < cfg.retention:
                weak += 1
    # Leave the last ~third of the time (min 2 days) for consolidation.
    learn_days = max(1, days_left - max(2, days_left // 3))
    return {
        "exam_date": exam.isoformat(),
        "days_left": days_left,
        "unseen_items": unseen,
        "seen_items": seen,
        "seen_items_below_target_on_exam_day": weak,
        "suggested_new_per_day": math.ceil(unseen / learn_days) if unseen and days_left > 0 else 0,
        "finish_new_by": date.fromordinal(today + learn_days).isoformat() if days_left > 0 else None,
    }


_WS = re.compile(r"\s+")
_MEDIA = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")


def _media_word(m: re.Match) -> str:
    alt = (m.group(1) or "").strip()
    low = alt.lower()
    if low.startswith("audio") or re.search(r"\.(mp3|m4a|ogg|wav|aac|flac|webm)$", m.group(2).lower()):
        return "[audio]"
    return f"[image: {alt}]" if alt else "[image]"


def one_line(text: str, n: int = 160) -> str:
    return _WS.sub(" ", _MEDIA.sub(_media_word, render_plain(text or ""))).strip()[:n]
