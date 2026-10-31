"""Stats over finished plays: records, Elo, head-to-head, streaks, game
stats, collection metrics (H-index, nickels & dimes) and superlatives.

Mirrored (for the dashboards) in ``frontend/src/items/kinds/boardgames/stats.ts``.

Elo: multiplayer Elo by pairwise decomposition — every pair of opponents in
a play is one "game" scored 1 / ½ / 0 by placement; each player's change is
K/(N−1) × Σ(actual − expected), so a 5-player play moves ratings about as
much as a duel. Team-mates aren't opponents; co-op plays don't rate.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from .scoring import clean_num, margin

START_ELO = 1500.0


def finished(data: dict) -> list[dict]:
    """Finished plays, oldest first (date, then end time)."""
    plays = [p for p in data.get("plays", []) if p.get("status") == "finished"]
    return sorted(plays, key=lambda p: (p.get("date", ""), p.get("ended_at") or p.get("created_at") or "", p.get("id", "")))


def games_by_id(data: dict) -> dict[str, dict]:
    return {g["id"]: g for g in data.get("games", [])}


def players_by_id(data: dict) -> dict[str, dict]:
    return {p["id"]: p for p in data.get("players", [])}


def win_of(game: dict | None) -> str:
    return (game or {}).get("scoring", {}).get("win", "high")


def competitive(play: dict, game: dict | None) -> bool:
    return win_of(game) != "coop" and sum(1 for s in play.get("seats", []) if s.get("place")) >= 2


# ---------------------------------------------------------------- Elo


def _expected(ra: float, rb: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def elo_update(ratings: dict[str, float], play: dict, k: float) -> dict[str, float]:
    """Apply one play's result to ``ratings`` (in place); returns the deltas."""
    seats = [s for s in play.get("seats", []) if s.get("place")]
    if len(seats) < 2:
        return {}
    for s in seats:
        ratings.setdefault(s["player_id"], START_ELO)
    deltas: dict[str, float] = {}
    for a in seats:
        opponents = [b for b in seats if b is not a and not (a.get("team_id") and a.get("team_id") == b.get("team_id"))]
        if not opponents:
            continue
        ra = ratings[a["player_id"]]
        total = 0.0
        for b in opponents:
            actual = 1.0 if a["place"] < b["place"] else 0.5 if a["place"] == b["place"] else 0.0
            total += actual - _expected(ra, ratings[b["player_id"]])
        deltas[a["player_id"]] = k / len(opponents) * total
    for pid, d in deltas.items():
        ratings[pid] += d
    return deltas


def elo_ratings(data: dict, game_id: str | None = None) -> tuple[dict[str, float], dict[str, list[tuple[str, float]]]]:
    """(ratings, history per player [(date, rating)]) — overall or one game."""
    k = float(data.get("settings", {}).get("elo_k", 32))
    games = games_by_id(data)
    ratings: dict[str, float] = {}
    history: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for p in finished(data):
        if game_id and p.get("game_id") != game_id:
            continue
        if not competitive(p, games.get(p.get("game_id"))):
            continue
        deltas = elo_update(ratings, p, k)
        for pid in deltas:
            history[pid].append((p["date"], round(ratings[pid], 1)))
    return ratings, history


# ---------------------------------------------------------------- players


def _streaks(results: list[bool]) -> tuple[int, int, int]:
    """(current win streak, longest win streak, current losing streak)."""
    longest = cur = 0
    for won in results:
        cur = cur + 1 if won else 0
        longest = max(longest, cur)
    cur_win = 0
    for won in reversed(results):
        if not won:
            break
        cur_win += 1
    cur_loss = 0
    for won in reversed(results):
        if won:
            break
        cur_loss += 1
    return cur_win, longest, cur_loss


def player_stats(data: dict, pid: str) -> dict[str, Any]:
    games = games_by_id(data)
    players = players_by_id(data)
    plays = [p for p in finished(data) if any(s["player_id"] == pid for s in p.get("seats", []))]
    by_game: dict[str, dict] = defaultdict(lambda: {"plays": 0, "wins": 0, "best": None, "places": []})
    results: list[bool] = []
    places: list[float] = []
    coop_plays = coop_wins = 0
    minutes = 0
    for p in plays:
        g = games.get(p["game_id"])
        seat = next(s for s in p["seats"] if s["player_id"] == pid)
        rec = by_game[p["game_id"]]
        rec["plays"] += 1
        minutes += p.get("duration_min") or 0
        if win_of(g) == "coop":
            coop_plays += 1
            coop_wins += 1 if seat.get("winner") else 0
            rec["wins"] += 1 if seat.get("winner") else 0
            continue
        if not competitive(p, g):
            continue
        rec["wins"] += 1 if seat.get("winner") else 0
        results.append(bool(seat.get("winner")))
        n = sum(1 for s in p["seats"] if s.get("place"))
        if seat.get("place"):
            places.append(seat["place"])
            rec["places"].append(seat["place"])
            # 1.0 = always first, 0.0 = always last
            places_norm = (n - seat["place"]) / (n - 1) if n > 1 else 1.0
            rec.setdefault("norm", []).append(places_norm)
        sc = seat.get("score")
        if sc is not None:
            better = (lambda a, b: a < b) if win_of(g) == "low" else (lambda a, b: a > b)
            if rec["best"] is None or better(sc, rec["best"]):
                rec["best"] = sc
    wins = sum(results)
    cur_win, longest, cur_loss = _streaks(results)
    ratings, history = elo_ratings(data)
    per_game_elo = {}
    for gid in by_game:
        r, _h = elo_ratings(data, gid)
        if pid in r:
            per_game_elo[gid] = round(r[pid])
    # Head-to-head against everyone met.
    h2h: dict[str, dict[str, int]] = defaultdict(lambda: {"played": 0, "wins": 0, "losses": 0, "ties": 0})
    for p in plays:
        g = games.get(p["game_id"])
        if not competitive(p, g):
            continue
        me = next(s for s in p["seats"] if s["player_id"] == pid)
        if not me.get("place"):
            continue
        for o in p["seats"]:
            if o["player_id"] == pid or not o.get("place") or (me.get("team_id") and me.get("team_id") == o.get("team_id")):
                continue
            r = h2h[o["player_id"]]
            r["played"] += 1
            if me["place"] < o["place"]:
                r["wins"] += 1
            elif me["place"] > o["place"]:
                r["losses"] += 1
            else:
                r["ties"] += 1
    wins_by_game = sorted(
        (
            {
                "game_id": gid,
                "game": games.get(gid, {}).get("name", "?"),
                "plays": r["plays"],
                "wins": r["wins"],
                "win_rate": round(r["wins"] / r["plays"], 3) if r["plays"] else 0,
                "best_score": clean_num(r["best"]),
                "avg_place": round(sum(r["places"]) / len(r["places"]), 2) if r["places"] else None,
                "elo": per_game_elo.get(gid),
            }
            for gid, r in by_game.items()
        ),
        key=lambda x: (-x["plays"], -x["wins"]),
    )
    return {
        "player_id": pid,
        "name": players.get(pid, {}).get("name", "?"),
        "plays": len(plays),
        "competitive_plays": len(results),
        "wins": wins,
        "win_rate": round(wins / len(results), 3) if results else None,
        "avg_place": round(sum(places) / len(places), 2) if places else None,
        "coop": {"plays": coop_plays, "wins": coop_wins},
        "hours": round(minutes / 60, 1),
        "streak": {"current_wins": cur_win, "longest_wins": longest, "current_losses": cur_loss},
        "elo": round(ratings.get(pid, START_ELO)),
        "elo_history": history.get(pid, [])[-60:],
        "games": wins_by_game,
        "head_to_head": {
            players.get(o, {}).get("name", o): r for o, r in sorted(h2h.items(), key=lambda kv: -kv[1]["played"])
        },
        "last_played": plays[-1]["date"] if plays else None,
    }


def head_to_head(data: dict, a: str, b: str) -> dict[str, Any]:
    games = games_by_id(data)
    out = {"played": 0, "a_wins": 0, "b_wins": 0, "ties": 0, "by_game": {}, "recent": []}
    by_game: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for p in finished(data):
        g = games.get(p["game_id"])
        sa = next((s for s in p["seats"] if s["player_id"] == a), None)
        sb = next((s for s in p["seats"] if s["player_id"] == b), None)
        if not sa or not sb or not competitive(p, g) or not sa.get("place") or not sb.get("place"):
            continue
        if sa.get("team_id") and sa.get("team_id") == sb.get("team_id"):
            continue
        out["played"] += 1
        rec = by_game[g["name"] if g else "?"]
        rec[0] += 1
        if sa["place"] < sb["place"]:
            out["a_wins"] += 1
            rec[1] += 1
            res = "a"
        elif sb["place"] < sa["place"]:
            out["b_wins"] += 1
            rec[2] += 1
            res = "b"
        else:
            out["ties"] += 1
            rec[3] += 1
            res = "tie"
        out["recent"].append({"date": p["date"], "game": g["name"] if g else "?", "result": res, "a_score": sa.get("score"), "b_score": sb.get("score")})
    out["by_game"] = {k: {"played": v[0], "a_wins": v[1], "b_wins": v[2], "ties": v[3]} for k, v in by_game.items()}
    out["recent"] = out["recent"][-10:][::-1]
    return out


# ---------------------------------------------------------------- games


def game_stats(data: dict, gid: str) -> dict[str, Any]:
    games = games_by_id(data)
    players = players_by_id(data)
    g = games.get(gid)
    win = win_of(g)
    plays = [p for p in finished(data) if p["game_id"] == gid]
    scores = [s["score"] for p in plays for s in p["seats"] if s.get("score") is not None]
    team_scores = [t["score"] for p in plays for t in p.get("teams", []) if t.get("score") is not None]
    all_scores = scores or team_scores
    winning = [
        max(sc) if win != "low" else min(sc)
        for p in plays
        if (sc := [s["score"] for s in p["seats"] if s.get("score") is not None])
    ]
    durations = [p["duration_min"] for p in plays if p.get("duration_min")]
    wins = Counter(s["player_id"] for p in plays for s in p["seats"] if s.get("winner") and win != "coop")
    seen = Counter(s["player_id"] for p in plays for s in p["seats"])
    min_plays = int(data.get("settings", {}).get("min_plays_for_best", 3))
    best = None
    for pid, n in seen.items():
        if n < min_plays or win == "coop":
            continue
        rate = wins[pid] / n
        if best is None or (rate, wins[pid]) > (best["win_rate"], best["wins"]):
            best = {"player_id": pid, "name": players.get(pid, {}).get("name", "?"), "wins": wins[pid], "plays": n, "win_rate": round(rate, 3)}
    # High / low score holders.
    def holder(pick):
        cands = [(s["score"], s["player_id"], p["date"]) for p in plays for s in p["seats"] if s.get("score") is not None]
        if not cands:
            return None
        sc, pid, day = pick(cands, key=lambda c: c[0])
        return {"score": clean_num(sc), "player": players.get(pid, {}).get("name", "?"), "date": day}

    # Seat-position advantage (first player wins?).
    seat_wins: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for p in plays:
        if not competitive(p, g):
            continue
        for i, s in enumerate(p["seats"]):
            seat_wins[i + 1][0] += 1
            seat_wins[i + 1][1] += 1 if s.get("winner") else 0
    # Category averages.
    cat_sum: dict[str, list[float]] = defaultdict(list)
    cats = {c["id"]: c for c in (g or {}).get("scoring", {}).get("categories", [])}
    for ex in (g or {}).get("expansions", []):
        for c in ex.get("categories", []):
            cats[c["id"]] = c
    for p in plays:
        for s in p["seats"]:
            for cid, v in (s.get("scores") or {}).items():
                if v is not None and cid in cats:
                    c = cats[cid]
                    cat_sum[c["name"]].append(v * c.get("multiplier", 1) * (-1 if c.get("subtract") else 1))
    coop = [p for p in plays if win == "coop"]
    elo, _h = elo_ratings(data, gid)
    return {
        "game_id": gid,
        "name": (g or {}).get("name", "?"),
        "plays": len(plays),
        "first_played": plays[0]["date"] if plays else None,
        "last_played": plays[-1]["date"] if plays else None,
        "high_score": holder(max if win != "low" else min),
        "low_score": holder(min if win != "low" else max),
        "average_score": round(sum(all_scores) / len(all_scores), 1) if all_scores else None,
        "average_winning_score": round(sum(winning) / len(winning), 1) if winning else None,
        "average_minutes": round(sum(durations) / len(durations)) if durations else None,
        "best_player": best,
        "wins": {players.get(pid, {}).get("name", "?"): n for pid, n in wins.most_common()},
        "coop": {"plays": len(coop), "wins": sum(1 for p in coop if p.get("coop_won"))} if win == "coop" else None,
        "seat_win_rate": {str(k): round(v[1] / v[0], 3) for k, v in sorted(seat_wins.items()) if v[0]},
        "category_averages": {k: round(sum(v) / len(v), 1) for k, v in cat_sum.items()},
        "leaderboard": [
            {"name": players.get(pid, {}).get("name", "?"), "elo": round(r)} for pid, r in sorted(elo.items(), key=lambda kv: -kv[1])
        ][:10],
        "scores_over_time": [
            {"date": p["date"], "winning": clean_num(max(sc) if win != "low" else min(sc)), "average": round(sum(sc) / len(sc), 1)}
            for p in plays
            if (sc := [s["score"] for s in p["seats"] if s.get("score") is not None])
        ][-60:],
    }


# ---------------------------------------------------------------- overall


def h_index(counts: list[int]) -> int:
    h = 0
    for i, n in enumerate(sorted(counts, reverse=True), 1):
        if n >= i:
            h = i
        else:
            break
    return h


def overall_stats(data: dict, fun: bool = True) -> dict[str, Any]:
    games = games_by_id(data)
    players = players_by_id(data)
    plays = finished(data)
    per_game = Counter(p["game_id"] for p in plays)
    per_month = Counter(p["date"][:7] for p in plays)
    minutes = sum(p.get("duration_min") or 0 for p in plays)
    counts = list(per_game.values())
    name = lambda gid: games.get(gid, {}).get("name", "?")  # noqa: E731
    return {
        "plays": len(plays),
        "games_played": len(per_game),
        "games_in_library": len(games),
        "hours": round(minutes / 60, 1),
        "h_index": h_index(counts),
        "most_played": [{"game": name(gid), "plays": n} for gid, n in per_game.most_common(10)],
        "nickels": sorted(name(g) for g, n in per_game.items() if 5 <= n < 10),
        "dimes": sorted(name(g) for g, n in per_game.items() if 10 <= n < 25),
        "quarters": sorted(name(g) for g, n in per_game.items() if 25 <= n < 100),
        "dollars": sorted(name(g) for g, n in per_game.items() if n >= 100),
        "plays_per_month": dict(sorted(per_month.items())[-12:]),
        "unplayed": sorted(g["name"] for g in data.get("games", []) if g["id"] not in per_game and g.get("owned", True)),
        "players": len([p for p in players.values() if not p.get("archived")]),
        "superlatives": superlatives(data) if fun else [],
    }


def superlatives(data: dict) -> list[dict[str, str]]:
    """Fun facts with real numbers."""
    games = games_by_id(data)
    players = players_by_id(data)
    plays = finished(data)
    nm = lambda pid: players.get(pid, {}).get("name", "?")  # noqa: E731
    gn = lambda gid: games.get(gid, {}).get("name", "?")  # noqa: E731
    out: list[dict[str, str]] = []
    scored = [(s["score"], s["player_id"], p) for p in plays for s in p["seats"] if s.get("score") is not None and win_of(games.get(p["game_id"])) != "low"]
    if scored:
        sc, pid, p = max(scored, key=lambda x: x[0])
        out.append({"title": "Highest score ever", "text": f"{nm(pid)} — {clean_num(sc)} in {gn(p['game_id'])} ({p['date']})"})
    margins = [(m, p) for p in plays if competitive(p, games.get(p["game_id"])) and (m := margin(p, win_of(games.get(p["game_id"])))) is not None]
    if margins:
        m, p = max(margins, key=lambda x: x[0])
        w = next((s for s in p["seats"] if s.get("winner")), None)
        if m > 0 and w:
            out.append({"title": "Biggest blowout", "text": f"{nm(w['player_id'])} won {gn(p['game_id'])} by {m} ({p['date']})"})
        close = [x for x in margins if x[0] >= 0]
        m2, p2 = min(close, key=lambda x: x[0])
        if len(margins) > 1:
            out.append({"title": "Photo finish", "text": f"{gn(p2['game_id'])} on {p2['date']} — decided by {m2}"})
    long = [p for p in plays if p.get("duration_min")]
    if long:
        p = max(long, key=lambda p: p["duration_min"])
        out.append({"title": "Marathon", "text": f"{gn(p['game_id'])} took {p['duration_min']} min ({p['date']})"})
    days = Counter(p["date"] for p in plays)
    if days:
        d, n = days.most_common(1)[0]
        if n > 1:
            out.append({"title": "Biggest game night", "text": f"{n} plays on {d}"})
    pairs = Counter()
    for p in plays:
        ids = sorted({s["player_id"] for s in p["seats"]})
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pairs[(ids[i], ids[j])] += 1
    if pairs:
        (a, b), n = pairs.most_common(1)[0]
        if n > 1:
            out.append({"title": "Inseparable", "text": f"{nm(a)} & {nm(b)} have played {n} games together"})
    ratings, _ = elo_ratings(data)
    if ratings:
        top = max(ratings.items(), key=lambda kv: kv[1])
        out.append({"title": "Table champion", "text": f"{nm(top[0])} — Elo {round(top[1])}"})
    # Streak holder.
    best = None
    for pid in players:
        res = [bool(s.get("winner")) for p in plays if competitive(p, games.get(p["game_id"])) for s in p["seats"] if s["player_id"] == pid]
        _c, longest, _l = _streaks(res)
        if longest >= 2 and (best is None or longest > best[1]):
            best = (pid, longest)
    if best:
        out.append({"title": "On fire", "text": f"{nm(best[0])} once won {best[1]} in a row"})
    # Most loyal: a game one person keeps choosing.
    per_game = Counter(p["game_id"] for p in plays)
    if per_game:
        gid, n = per_game.most_common(1)[0]
        if n >= 3:
            out.append({"title": "Old faithful", "text": f"{gn(gid)} — {n} plays"})
    me = data.get("settings", {}).get("me_player_id")
    if me:
        st = player_stats(data, me)
        rivals = [(name, r) for name, r in st["head_to_head"].items() if r["played"] >= 3]
        if rivals:
            name, r = max(rivals, key=lambda x: (x[1]["losses"] - x[1]["wins"], x[1]["played"]))
            if r["losses"] > r["wins"]:
                out.append({"title": "Your nemesis", "text": f"{name} — {r['wins']}–{r['losses']} against you"})
    return out


def leaderboard(data: dict, gid: str | None = None, metric: str = "elo", min_plays: int = 1) -> list[dict[str, Any]]:
    players = players_by_id(data)
    games = games_by_id(data)
    ratings, _ = elo_ratings(data, gid)
    plays = Counter()
    wins = Counter()
    for p in finished(data):
        if gid and p["game_id"] != gid:
            continue
        if not competitive(p, games.get(p["game_id"])):
            continue
        for s in p["seats"]:
            plays[s["player_id"]] += 1
            wins[s["player_id"]] += 1 if s.get("winner") else 0
    rows = [
        {
            "player_id": pid,
            "name": players.get(pid, {}).get("name", "?"),
            "elo": round(ratings.get(pid, START_ELO)),
            "plays": n,
            "wins": wins[pid],
            "win_rate": round(wins[pid] / n, 3),
        }
        for pid, n in plays.items()
        if n >= min_plays and not players.get(pid, {}).get("archived")
    ]
    key = {"elo": lambda r: (-r["elo"], -r["wins"]), "wins": lambda r: (-r["wins"], -r["win_rate"]), "win_rate": lambda r: (-r["win_rate"], -r["plays"])}
    rows.sort(key=key.get(metric, key["elo"]))
    return rows


def suggest(data: dict, players: int, minutes: int | None, max_weight: float | None, today: str) -> list[dict]:
    """Owned games that fit, least-recently-played and favourites first."""
    plays = finished(data)
    last: dict[str, str] = {}
    count = Counter()
    for p in plays:
        last[p["game_id"]] = p["date"]
        count[p["game_id"]] += 1
    out = []
    for g in data.get("games", []):
        if not g.get("owned", True):
            continue
        if not (g.get("min_players", 1) <= players <= g.get("max_players", 99)):
            continue
        if minutes and g.get("play_minutes") and g["play_minutes"] > minutes * 1.15:
            continue
        if max_weight and g.get("weight") and g["weight"] > max_weight:
            continue
        out.append(
            {
                "game_id": g["id"],
                "name": g["name"],
                "minutes": g.get("play_minutes"),
                "weight": g.get("weight"),
                "plays": count[g["id"]],
                "last_played": last.get(g["id"]),
                "favorite": g.get("favorite", False),
            }
        )
    out.sort(key=lambda r: (not r["favorite"], r["last_played"] or "0000", -r["plays"]))
    return out[:10]
