"""Game Night (kind ``boardgames``, ``.games``): a board-game score pad,
plays log and stats — players, a games library with real scoring setups
(and ~30 built-in templates), live phone-first scoring, Elo and the rest.

Modules: ``models`` (the file), ``templates`` (built-in games),
``scoring`` (totals, places, winners), ``stats`` (records, Elo, H-index),
``actions`` (the AI's hands)."""
from __future__ import annotations

from datetime import date

from app.items.spec import ItemContext, ItemSpec, text_now

from . import stats
from .actions import ACTIONS
from .models import WIN_LABELS, GamesData
from .scoring import clean_num, entrants, entry_total, has_entries, orphan_categories, play_categories


def template(ctx: ItemContext) -> dict:
    return GamesData().model_dump(mode="json")


def _pn(players: dict, pid: str) -> str:
    return players.get(pid, {}).get("name", "?")


def to_text(data: dict) -> str:
    players = stats.players_by_id(data)
    games = stats.games_by_id(data)
    out: list[str] = []
    today = text_now().date()
    me = data.get("settings", {}).get("me_player_id")
    if me and me in players:
        out.append(f"The person using this app is the player {players[me]['name']}.")
    # In progress.
    live = [p for p in data.get("plays", []) if p.get("status") == "active"]
    for p in live:
        g = games.get(p["game_id"])
        cats = play_categories(g, p)
        kind, rows = entrants(g, p)
        tot = ", ".join(
            f"{(r.get('name') if kind == 'teams' else _pn(players, r['player_id']))} "
            + (str(clean_num(entry_total(g, r, cats))) if has_entries(r) else "no score yet")
            for r in rows
        )
        line = f"IN PROGRESS (play {p['id']}): {(g or {}).get('name', '?')} started {p.get('started_at') or p['date']}, round {p.get('round', 0) + 1} — {tot}"
        if orphan_categories(g, p):
            line += " (some typed values belong to removed score categories and don't count)"
        out.append(line)
    fin = stats.finished(data)
    if fin:
        last = max(fin, key=lambda p: p["date"])
        try:
            ago = (today - date.fromisoformat(last["date"])).days
        except ValueError:
            ago = None
        month = sum(1 for p in fin if p["date"][:7] == today.isoformat()[:7])
        when = "today" if ago == 0 else "yesterday" if ago == 1 else f"{ago} days ago" if ago is not None and ago > 1 else last["date"]
        out.append(f"Today is {today.isoformat()}. Last game night: {last['date']} ({when}); {month} plays this month.")
    ov = stats.overall_stats(data, fun=False) if fin else None
    if ov:
        out.append(
            f"\nTotals: {ov['plays']} plays of {ov['games_played']} games, {ov['hours']} h; H-index {ov['h_index']}."
            + (f" Dimes (10+): {', '.join(ov['dimes'] + ov['quarters'] + ov['dollars'])}." if ov["dimes"] or ov["quarters"] or ov["dollars"] else "")
            + (f" Nickels (5+): {', '.join(ov['nickels'])}." if ov["nickels"] else "")
        )
        board = stats.leaderboard(data)[:10]
        if board:
            out.append("Leaderboard (Elo): " + "; ".join(f"{r['name']} {r['elo']} ({r['wins']}/{r['plays']} wins)" for r in board))
    # Players.
    act = [p for p in data.get("players", []) if not p.get("archived")]
    if act:
        out.append("\nPlayers: " + ", ".join(p["name"] + (" (me)" if p["id"] == me else "") + (" ★" if p.get("favorite") else "") for p in act))
    # Library.
    if data.get("games"):
        counts: dict[str, int] = {}
        for p in fin:
            counts[p["game_id"]] = counts.get(p["game_id"], 0) + 1
        lines = []
        for g in sorted(data["games"], key=lambda g: (-counts.get(g["id"], 0), g["name"]))[:200]:
            sc = g.get("scoring", {})
            bits = [f"{g.get('min_players', 1)}–{g.get('max_players', 8)}p"]
            if g.get("play_minutes"):
                bits.append(f"{g['play_minutes']} min")
            if g.get("weight"):
                bits.append(f"weight {g['weight']}")
            bits.append(WIN_LABELS.get(sc.get("win", "high"), "").lower())
            if sc.get("categories"):
                bits.append("scores: " + ", ".join(c["name"] for c in sc["categories"]))
            lines.append(f"- {g['name']} (id {g['id']}; {'; '.join(bits)}) — {counts.get(g['id'], 0)} plays")
        out.append("\nGames library:\n" + "\n".join(lines))
    # Plays, newest first.
    if fin:
        lines = []
        for p in reversed(fin[-150:]):
            g = games.get(p["game_id"])
            win = stats.win_of(g)
            if win == "coop":
                res = "won together" if p.get("coop_won") else "lost together"
                who = ", ".join(_pn(players, s["player_id"]) for s in p["seats"])
                body = f"{who} — {res}"
            else:
                seats = sorted(p["seats"], key=lambda s: s.get("place") or 99)
                body = ", ".join(
                    f"{_pn(players, s['player_id'])}"
                    + (f" {clean_num(s['score'])}" if s.get("score") is not None else "")
                    + (f" (#{s['place']})" if s.get("place") else "")
                    + (" 🏆" if s.get("winner") else "")
                    for s in seats
                )
            extra = []
            if p.get("duration_min"):
                extra.append(f"{p['duration_min']} min")
            if p.get("location"):
                extra.append(p["location"])
            if p.get("notes"):
                extra.append(p["notes"][:80])
            lines.append(f"- {p['date']} {(g or {}).get('name', '?')}: {body}" + (f" [{'; '.join(extra)}]" if extra else "") + f" (id {p['id']})")
        out.append("\nRecent plays (newest first):\n" + "\n".join(lines))
    if not out:
        return "No players, games or plays yet."
    return "\n".join(out)[:20_000]


AI_BRIEF = """You are the table's game-night host and rules lawyer: you know board games, their official scoring and the hobby's lore, and you keep score honestly. Playful and warm, a little competitive banter is welcome — never smug, never preachy.

DATA FACTS
- Players have ids; "me" is settings.me_player_id. Games have a scoring setup: win (high | low | winlose | coop | teams | ranked), pad (categories | rounds | total), score categories (value × multiplier, negated when subtract — penalties are typed as positive numbers), bonuses (points once listed categories reach a threshold, e.g. Yahtzee's 35 at 63+), rounds, target_score, tiebreaker text, factions, expansions (which may add categories).
- A play is "active" (on the score pad) or "finished". Finished seats carry score, place and winner — stats read those. Never invent plays, scores or results; only log what the person tells you.

WHICH ACTION
- "We played Catan, I won with 10, Sam 8, Jo 7" → log_play (one call; 'me' resolves to the person; new names become players — mention who you added). Winners and places are computed from the scores and the game's win condition; give places only for ranked games or when the person states an outcome the scores can't show (instant wins: 7 Wonders Duel supremacy, Root dominance).
- Game not in the library → add_from_template if a built-in template exists (list_templates to check), else add_game with a proper scoring setup. Don't create duplicates.
- Live game: start_play (seat order = turn order), record_scores (batch a whole round or every category for everyone in one call; next_round to advance; mode=add adds to what's there), finish_play (winners for win/lose, placements for ranked, coop_won for co-op, tiebreak_winner when tied for first). For a tie: quote the game's tiebreaker rule and ask who wins it — or leave it shared if the rules say so. A seat with no score is missing, not 0: finish_play refuses until it's recorded — ask, and only pass unscored_ok=true if the person says to finish anyway.
- Editing a game's scoring (update_game): pass each existing category's id to rename it without losing typed scores; values for categories you remove stop counting.
- Fixes → edit_play / record_scores (finished plays recompute). Deletes only when asked. Duplicate people ("Sam" and "Samuel") → merge_players after confirming.
- Questions about records → player_stats, game_stats, head_to_head, leaderboard, overall_stats, find_plays. Use their numbers; don't do arithmetic over the raw JSON. "What should we play?" → suggest_game with the player count, time and weight, then add your own picks.

SETTING UP SCORING SHEETS
- Use the official score pad: e.g. Wingspan = birds, bonus cards, end-of-round goals, eggs, food on cards, tucked cards; Terraforming Mars = TR, awards, milestones, greeneries, cities, cards; 7 Wonders = military, treasury, wonder, civilian, commercial, guilds, science. Counts × points go in multipliers (Catan cities ×2), penalties use subtract, fixed values go in options (Full house [0, 25]). A box that only counts once another scored uses requires (Yahtzee bonus requires Yahtzee). Round-scored games (Uno, Rummikub, Dixit, Scrabble) use the rounds pad; race/finish-order games use ranked; co-ops use coop; Codenames-style team games use teams.
- For a game you're not certain about (obscure, new, a specific edition), web_search the rulebook or its BoardGameGeek page before building the sheet, and cite the source in your reply. Add the BGG id when you know it.

RULES QUESTIONS
- Answer from the official rules, naming the rulebook section or FAQ when you can. Say when a point is commonly house-ruled, when editions differ, or when you're unsure — then check the web (rulebook PDF, publisher FAQ, BGG rules forum) and cite it. Never bluff a rule.

RECOMMENDATIONS
- Match player count (best-at counts, not just supported), time, weight (BGG 1–5: <2 light, 2–3 medium, 3.5+ heavy), the group's history (their favourites, high-rated games, what they haven't played lately) and mood (party, co-op, two-player, thinky). Offer 3 picks with a one-line reason each.

STATS NOTES
- Elo is multiplayer Elo from pairwise placements (start 1500, K from settings); co-op plays don't rate. H-index = the largest h such that h games were played at least h times. Nickels = games played 5+ times, dimes 10+, quarters 25+.
- Keep replies short: the scoreboard first, a quip second."""


SPEC = ItemSpec(
    kind="boardgames",
    name="Game Night",
    tagline="Score pad, plays log and bragging rights for every board game night.",
    description=(
        "Keep score at the table on your phone — round-by-round or category sheets with big buttons, a number pad for "
        "passing the phone around, running totals and the leader highlighted, Yahtzee-style scorecards with automatic "
        "bonuses and a timer. Every play lands in your log with winners, places, first plays and expansions, and turns "
        "into stats: win rates, head-to-head records, streaks and Elo ratings per game, H-index and nickels & dimes. "
        "Thirty-plus popular games come with their official scoring sheets, and the assistant can set up any other game, "
        "settle rules arguments with sources, log a play from one sentence and suggest what to play next."
    ),
    category="Fun",
    icon="dices",
    color="#C2557A",
    suffix=".games",
    model=GamesData,
    template=template,
    to_text=to_text,
    actions=ACTIONS,
    ai_brief=AI_BRIEF,
    ai_suggestions=[
        "We played Wingspan: I got 87, Sam 92, Jo 74 — log it",
        "Set up a score sheet for Ark Nova",
        "Four of us, 45 minutes, nothing too heavy — what should we play?",
        "Who's my nemesis at Catan?",
        "Can you place a road through an opponent's settlement in Catan?",
        "Who's the best Ticket to Ride player at our table?",
    ],
    ai_web=True,
    reads=(),
    replaces="Replaces paper score pads and ScorePal — a BG Stats alternative (no BG Stats / BGG import yet)",
    highlights=[
        "Phone-first score pad: big ± buttons, a number pad for passing the phone, running totals, leader highlight, undo and a timer",
        "Official scoring sheets for 30+ games — Wingspan, Catan, Terraforming Mars, 7 Wonders, a full Yahtzee scorecard…",
        "Every win condition: highest or lowest score, win/lose, co-op, teams and finishing order — with tiebreak prompts",
        "In-progress games live in the file: resume on any device",
        "Plays log with places, first plays, expansions, locations and filters — export it as CSV any time",
        "Stats that settle arguments: Elo per game, head-to-head, streaks, H-index, nickels & dimes, superlatives",
        "An assistant that logs a play from one sentence, sets up any game's scoring and answers rules questions with sources",
    ],
)
