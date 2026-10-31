"""Scoring: totals from a pad, then places and winners for each win condition.

Mirrored in ``frontend/src/items/kinds/boardgames/scoring.ts`` (the live pad
needs it offline) — keep the two in step.

Places use standard competition ranking (1, 1, 3): equal scores share a
place unless a tiebreak order was recorded (``tiebreak``, lower wins).
"""
from __future__ import annotations

from typing import Any

Number = int | float


def clean_num(v: Number | None) -> Number | None:
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return round(v, 4) if isinstance(v, float) else v


def play_categories(game: dict | None, play: dict | None = None) -> list[dict]:
    """The game's score categories plus those of the expansions in play."""
    if not game:
        return []
    cats = list(game.get("scoring", {}).get("categories", []))
    used = set((play or {}).get("expansions", []))
    for ex in game.get("expansions", []):
        if ex.get("id") in used:
            cats.extend(ex.get("categories", []))
    return cats


def category_points(cat: dict, value: Number | None, scores: dict | None = None) -> Number:
    """Points for one box. With ``scores`` (the whole entry), a category that
    ``requires`` another counts only once that one scored (Yahtzee bonus)."""
    if value is None:
        return 0
    req = cat.get("requires")
    if req and scores is not None and not scores.get(req):
        return 0
    pts = value * (cat.get("multiplier", 1) if cat.get("multiplier") is not None else 1)
    return -pts if cat.get("subtract") else pts


def orphan_categories(game: dict | None, play: dict) -> list[str]:
    """Category ids that hold typed values on this play but no longer exist
    in the game's sheet (deleted, or an expansion switched off). They don't
    count towards totals."""
    known = {c["id"] for c in play_categories(game, play)}
    found: list[str] = []
    for r in [*play.get("seats", []), *play.get("teams", [])]:
        for cid, v in (r.get("scores") or {}).items():
            if v is not None and cid not in known and cid not in found:
                found.append(cid)
    return found


def bonus_points(game: dict | None, entry: dict, cats: list[dict]) -> list[tuple[dict, Number, bool]]:
    """Each bonus rule with (rule, progress, earned)."""
    if not game:
        return []
    by_id = {c["id"]: c for c in cats}
    scores = entry.get("scores", {}) or {}
    out = []
    for rule in game.get("scoring", {}).get("bonuses", []):
        ids = rule.get("categories") or list(by_id)
        progress = sum(category_points(by_id[i], scores.get(i), scores) for i in ids if i in by_id)
        out.append((rule, clean_num(progress), progress >= rule.get("threshold", 0)))
    return out


def has_entries(entry: dict) -> bool:
    return (
        entry.get("total") is not None
        or any(v is not None for v in (entry.get("scores") or {}).values())
        or any(v is not None for v in entry.get("rounds") or [])
    )


def entry_total(game: dict | None, entry: dict, cats: list[dict] | None = None) -> Number:
    """The running total of one seat or team: a typed total wins; otherwise
    category points + earned bonuses + every round."""
    if entry.get("total") is not None:
        return clean_num(entry["total"])
    cats = cats if cats is not None else play_categories(game)
    by_id = {c["id"]: c for c in cats}
    scores = entry.get("scores", {}) or {}
    total: Number = 0
    for cid, v in scores.items():
        cat = by_id.get(cid)
        if cat is not None:  # values for removed categories don't count
            total += category_points(cat, v, scores)
    for rule, _progress, earned in bonus_points(game, entry, cats):
        if earned:
            total += rule.get("points", 0)
    total += sum(r for r in (entry.get("rounds") or []) if r is not None)
    return clean_num(total)


def _rank(entries: list[dict], key: str, reverse: bool) -> None:
    """Competition-rank ``entries`` in place by ``key`` (then ``tiebreak``).
    Entries without a value are left unplaced (``place`` None) — a blank seat
    is missing, not a zero."""

    def sort_key(e: dict) -> tuple:
        s = e.get(key)
        tb = e.get("tiebreak")
        return (-s if reverse else s, tb if tb is not None else 10_000)

    for e in entries:
        if e.get(key) is None:
            e["place"] = None
    ordered = sorted((e for e in entries if e.get(key) is not None), key=sort_key)
    prev = None
    for i, e in enumerate(ordered):
        k = sort_key(e)
        if prev is None or k != prev[0]:
            prev = (k, i + 1)
        e["place"] = prev[1]


def entrants(game: dict | None, play: dict) -> tuple[str, list[dict]]:
    """("teams", play["teams"]) when the play is in teams, else ("seats", …)."""
    win = (game or {}).get("scoring", {}).get("win", "high")
    if play.get("teams") and (win == "teams" or any(s.get("team_id") for s in play.get("seats", []))):
        return "teams", play["teams"]
    return "seats", play.get("seats", [])


def live_standings(game: dict | None, play: dict) -> list[dict]:
    """[{id, name-key, total}] for the pad, best first (for high/low/teams)."""
    cats = play_categories(game, play)
    kind, rows = entrants(game, play)
    win = (game or {}).get("scoring", {}).get("win", "high")
    out = [
        {"id": r.get("id") if kind == "teams" else r.get("player_id"), "total": entry_total(game, r, cats)}
        for r in rows
    ]
    scored = {id(r) for r in rows if has_entries(r)}
    for o, r in zip(out, rows):
        o["scored"] = id(r) in scored
    # Blank seats go last (in a low-score game a blank isn't a winning 0).
    out.sort(key=lambda e: (not e["scored"], -e["total"] if win != "low" else e["total"]))
    return out


def compute_results(game: dict | None, play: dict) -> dict[str, Any]:
    """Fill ``score`` / ``place`` / ``winner`` on every seat (and team).

    Returns ``{"winners": [player ids], "tied": bool, "kind": …,
    "unscored": [rows without a score]}``. ``tied`` means first place is
    shared and no tiebreak was recorded — the UI asks. In score games a row
    with nothing typed is unplaced (never a winning 0)."""
    scoring = (game or {}).get("scoring", {})
    win = scoring.get("win", "high")
    cats = play_categories(game, play)
    seats = play.get("seats", [])
    kind, rows = entrants(game, play)

    for r in rows:
        r["score"] = entry_total(game, r, cats) if has_entries(r) else None

    if play.get("manual"):
        # Typed by hand: keep places / winners; derive one from the other.
        if any(r.get("place") for r in rows):
            for r in rows:
                r["winner"] = r.get("place") == 1
        elif any(r.get("winner") for r in rows):
            for r in rows:
                r["place"] = 1 if r.get("winner") else 2
    elif win == "coop":
        won = bool(play.get("coop_won"))
        for r in rows:
            r["place"] = None
            r["winner"] = won
    elif win == "winlose":
        any_win = any(r.get("winner") for r in rows)
        for r in rows:
            r["winner"] = bool(r.get("winner"))
            r["place"] = (1 if r["winner"] else 2) if any_win else None
    elif win == "ranked":
        if any(r.get("score") is not None for r in rows):
            # Scored: the order follows the scores, highest first (recomputed
            # every time, so a fixed or re-finished play never keeps stale
            # places; a hand-picked order is ``manual``).
            _rank(rows, "score", reverse=True)
        for r in rows:
            r["winner"] = r.get("place") == 1
    elif win == "teams" and kind == "teams" and not any(r.get("score") is not None for r in rows):
        # A team game without points (Codenames): the winning team was picked.
        any_win = any(r.get("winner") for r in rows)
        for r in rows:
            r["winner"] = bool(r.get("winner"))
            r["place"] = (1 if r["winner"] else 2) if any_win else None
    else:
        _rank(rows, "score", reverse=win != "low")
        for r in rows:
            r["winner"] = r.get("place") == 1

    if kind == "teams":
        by_team = {t["id"]: t for t in rows}
        for s in seats:
            t = by_team.get(s.get("team_id"))
            s["score"] = None
            if t is not None:
                s["place"] = t.get("place")
                s["winner"] = bool(t.get("winner"))
            else:
                s["place"], s["winner"] = None, False
    winners = [s["player_id"] for s in seats if s.get("winner")]
    firsts = [r for r in rows if r.get("place") == 1]
    tied = win not in ("coop", "winlose") and len(firsts) > 1 and not play.get("manual")
    return {"winners": winners, "tied": tied, "kind": kind, "unscored": unscored_rows(game, play)}


def unscored_rows(game: dict | None, play: dict) -> list[dict]:
    """Seats (or teams) with no score in a game decided by scores, while
    someone else has one — Finish warns about these."""
    win = (game or {}).get("scoring", {}).get("win", "high")
    _kind, rows = entrants(game, play)
    if win in ("coop", "winlose") or play.get("manual"):
        return []
    scored = [r for r in rows if has_entries(r)]
    if win in ("teams", "ranked") and not scored:
        return []  # decided by a pick / a finishing order
    return [r for r in rows if not has_entries(r)]


def break_tie(play: dict, game: dict | None, winner_ref: str) -> None:
    """Record that ``winner_ref`` (a player id or team id) won the tie for
    first place: they get tiebreak 0, the others tied with them 1."""
    kind, rows = entrants(game, play)
    key = "id" if kind == "teams" else "player_id"
    target = next((r for r in rows if r.get(key) == winner_ref), None)
    if target is None and kind == "teams":
        seat = next((s for s in play.get("seats", []) if s.get("player_id") == winner_ref), None)
        target = next((t for t in rows if seat and t.get("id") == seat.get("team_id")), None)
    if target is None:
        raise ValueError("that player isn't in this play")
    if target.get("place") != 1:
        raise ValueError("they aren't tied for first")
    for r in rows:
        if r.get("place") == 1:
            r["tiebreak"] = 0 if r is target else 1


def margin(play: dict, win: str = "high") -> Number | None:
    """Points between first and second (competitive score games)."""
    scores = sorted(
        (s["score"] for s in play.get("seats", []) if s.get("score") is not None), reverse=win != "low"
    )
    if len(scores) < 2:
        return None
    return clean_num(abs(scores[0] - scores[1]))
