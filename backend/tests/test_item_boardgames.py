"""Game Night (kind ``boardgames``): model + templates, scoring and winners
for every win condition (ties, tiebreaks, teams, lowest-wins), Elo, stats,
every action, to_text, tool schemas and one API flow."""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.items.kinds.boardgames import SPEC, to_text
from app.items.kinds.boardgames import stats
from app.items.kinds.boardgames.models import Game, GamesData
from app.items.kinds.boardgames.scoring import break_tie, compute_results, entry_total, live_standings, margin, orphan_categories, play_categories
from app.items.kinds.boardgames.templates import BY_ID, TEMPLATES, find_template, game_from_template
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 20, 0, tzinfo=TZ)


def ctx(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=TZ)  # type: ignore[arg-type]


def fresh() -> dict:
    return SPEC.validate(SPEC.template(ctx()))


async def act(data: dict, action: str, /, now: datetime = NOW, **args):
    from app.items.service import run_action

    out = await run_action(ctx(now), SPEC, data, action, args)
    # Every action leaves a valid file.
    SPEC.validate(data)
    return out


def game(win="high", pad="total", cats=None, bonuses=None, expansions=None) -> dict:
    return {"id": "g", "name": "G", "scoring": {"win": win, "pad": pad, "categories": cats or [], "bonuses": bonuses or []}, "expansions": expansions or []}


def seat(pid, **kw) -> dict:
    return {"player_id": pid, "scores": {}, "rounds": [], **kw}


# ------------------------------------------------------------ model / templates


def test_template_and_model_defaults():
    d = fresh()
    assert d["players"] == [] and d["games"] == [] and d["plays"] == []
    assert d["settings"]["elo_k"] == 32
    # Old / partial files load.
    assert GamesData.model_validate({"plays": [{"id": "x", "game_id": "g"}]}).plays[0].status == "finished"


def test_templates_are_valid_games_and_cover_the_classics():
    real = [t for t in TEMPLATES if not t["id"].startswith("generic")]
    assert len(real) >= 30
    for t in TEMPLATES:
        g = Game.model_validate({**game_from_template(t), "id": "x"})
        ids = [c.id for c in g.scoring.categories]
        assert len(ids) == len(set(ids)), t["id"]
        for b in g.scoring.bonuses:
            assert set(b.categories) <= set(ids)
    for name in ["Wingspan", "Catan", "Ticket to Ride", "7 Wonders", "7 Wonders Duel", "Carcassonne", "Terraforming Mars",
                 "Azul", "Scythe", "Everdell", "Splendor", "Dominion", "Cascadia", "Agricola", "Viticulture", "Scrabble",
                 "Yahtzee", "Uno", "Rummikub", "Codenames", "Pandemic", "Sushi Go", "Kingdomino", "Dixit", "Love Letter",
                 "Quacks", "Brass", "Root", "Heat", "Lost Cities"]:
        assert find_template(name), name
    w = [c["name"] for c in BY_ID["wingspan"]["scoring"]["categories"]]
    assert w == ["Birds", "Bonus cards", "End-of-round goals", "Eggs", "Food on cards", "Tucked cards"]
    assert find_template("settlers")["id"] == "catan" and find_template("TTR")["id"] == "ticket-to-ride"
    assert BY_ID["pandemic"]["scoring"]["win"] == "coop" and BY_ID["codenames"]["scoring"]["win"] == "teams"
    assert BY_ID["heat"]["scoring"]["win"] == "ranked"


def test_yahtzee_scorecard_with_upper_bonus():
    y = {**game_from_template(BY_ID["yahtzee"]), "id": "y"}
    full = {"ones": 3, "twos": 6, "threes": 9, "fours": 12, "fives": 15, "sixes": 18}  # 63 exactly
    s = seat("a", scores={**full, "full-house": 25, "yahtzee": 50, "yahtzee-bonus": 100, "chance": 22})
    assert entry_total(y, s) == 63 + 35 + 25 + 50 + 100 + 22
    s["scores"]["sixes"] = 12  # 57 — no bonus
    assert entry_total(y, s) == 57 + 25 + 50 + 100 + 22
    # The Yahtzee bonus only counts once the Yahtzee box scored 50.
    s["scores"]["yahtzee"] = 0
    assert entry_total(y, s) == 57 + 25 + 22
    del s["scores"]["yahtzee"]
    assert entry_total(y, s) == 57 + 25 + 22


# ------------------------------------------------------------ scoring


def test_multipliers_penalties_rounds_and_expansion_categories():
    cats = [{"id": "cities", "name": "Cities", "multiplier": 2}, {"id": "failed", "name": "Failed", "subtract": True}]
    g = game(pad="categories", cats=cats, expansions=[{"id": "x", "name": "X", "categories": [{"id": "nectar", "name": "Nectar"}]}])
    s = seat("a", scores={"cities": 3, "failed": 4, "nectar": 5}, rounds=[2, None, 3])
    play = {"seats": [s], "expansions": []}
    # nectar isn't a category without the expansion: its value doesn't count.
    assert entry_total(g, s, play_categories(g, play)) == 6 - 4 + 5
    assert orphan_categories(g, play) == ["nectar"]
    play["expansions"] = ["x"]
    assert [c["id"] for c in play_categories(g, play)] == ["cities", "failed", "nectar"]
    assert entry_total(g, s, play_categories(g, play)) == 6 - 4 + 5 + 5
    assert orphan_categories(g, play) == []
    # A typed total wins over everything.
    s["total"] = 40
    assert entry_total(g, s) == 40


def test_highest_wins_and_shared_ties_use_competition_ranking():
    g = game()
    play = {"seats": [seat("a", total=10), seat("b", total=12), seat("c", total=10), seat("d", total=3)]}
    res = compute_results(g, play)
    assert [s["place"] for s in play["seats"]] == [2, 1, 2, 4]
    assert res["winners"] == ["b"] and not res["tied"]
    play["seats"][0]["total"] = 12
    res = compute_results(g, play)
    assert [s["place"] for s in play["seats"]] == [1, 1, 3, 4]
    assert sorted(res["winners"]) == ["a", "b"] and res["tied"]
    # Tiebreak: b wins it.
    break_tie(play, g, "b")
    res = compute_results(g, play)
    assert res["winners"] == ["b"] and [s["place"] for s in play["seats"]] == [2, 1, 3, 4] and not res["tied"]
    with pytest.raises(ValueError):
        break_tie(play, g, "d")


def test_lowest_wins():
    g = game(win="low", pad="rounds")
    play = {"seats": [seat("a", rounds=[4, 5]), seat("b", rounds=[2, 1]), seat("c", rounds=[3, 3])]}
    res = compute_results(g, play)
    assert res["winners"] == ["b"] and [s["place"] for s in play["seats"]] == [3, 1, 2]
    assert [s["score"] for s in play["seats"]] == [9, 3, 6]
    assert margin(play, "low") == 3


def test_win_lose_and_coop():
    g = game(win="winlose")
    play = {"seats": [seat("a", winner=True), seat("b")]}
    res = compute_results(g, play)
    assert res["winners"] == ["a"] and [s["place"] for s in play["seats"]] == [1, 2]
    c = game(win="coop")
    play = {"seats": [seat("a"), seat("b")], "coop_won": True}
    assert compute_results(c, play)["winners"] == ["a", "b"]
    assert all(s["place"] is None for s in play["seats"])
    play["coop_won"] = False
    assert compute_results(c, play)["winners"] == []


def test_teams_by_score_and_by_pick():
    g = game(win="teams")
    play = {
        "seats": [seat("a", team_id="t1"), seat("b", team_id="t2"), seat("c", team_id="t1"), seat("d", team_id="t2")],
        "teams": [{"id": "t1", "name": "Red", "scores": {}, "rounds": [], "total": 7}, {"id": "t2", "name": "Blue", "scores": {}, "rounds": [], "total": 9}],
    }
    res = compute_results(g, play)
    assert res["kind"] == "teams" and sorted(res["winners"]) == ["b", "d"]
    assert [s["place"] for s in play["seats"]] == [2, 1, 2, 1]
    # Codenames: no points, the winning team is picked.
    play["teams"][0].update(total=None, winner=True)
    play["teams"][1].update(total=None, winner=False)
    res = compute_results(g, play)
    assert sorted(res["winners"]) == ["a", "c"]


def test_ranked_and_manual_results():
    g = game(win="ranked")
    play = {"seats": [seat("a", place=2), seat("b", place=1), seat("c", place=3)]}
    assert compute_results(g, play)["winners"] == ["b"]
    # A score game with a hand-typed result (instant supremacy win).
    h = game()
    play = {"manual": True, "seats": [seat("a", total=20, winner=True), seat("b", total=40)]}
    res = compute_results(h, play)
    assert res["winners"] == ["a"] and [s["place"] for s in play["seats"]] == [1, 2]


# ------------------------------------------------------------ Elo / stats


def test_elo_pairwise_is_zero_sum_and_moves_the_right_way():
    r: dict[str, float] = {}
    d = stats.elo_update(r, {"seats": [{"player_id": "a", "place": 1}, {"player_id": "b", "place": 2}]}, 32)
    assert d["a"] == pytest.approx(16) and d["b"] == pytest.approx(-16)
    d = stats.elo_update(r, {"seats": [{"player_id": "a", "place": 1}, {"player_id": "b", "place": 1}]}, 32)
    assert d["a"] < 0 < d["b"]  # a tie against a weaker player costs the favourite
    r = {}
    d = stats.elo_update(r, {"seats": [{"player_id": x, "place": i + 1} for i, x in enumerate("abc")]}, 32)
    assert sum(d.values()) == pytest.approx(0) and d["a"] > d["b"] > d["c"]
    # Team-mates aren't opponents.
    r = {}
    d = stats.elo_update(r, {"seats": [{"player_id": "a", "place": 1, "team_id": "t"}, {"player_id": "b", "place": 1, "team_id": "t"}, {"player_id": "c", "place": 2, "team_id": "u"}]}, 32)
    assert d["a"] == pytest.approx(d["b"]) and d["c"] == pytest.approx(-16)


def test_h_index_and_streaks():
    assert stats.h_index([10, 8, 5, 4, 3]) == 4 and stats.h_index([1]) == 1 and stats.h_index([]) == 0
    assert stats._streaks([True, True, False, True, True, True]) == (3, 3, 0)
    assert stats._streaks([True, False, False]) == (0, 1, 2)


async def _table() -> dict:
    d = fresh()
    await act(d, "add_players", players=[{"name": "Tristen", "me": True}, {"name": "Sam"}, {"name": "Jo"}])
    await act(d, "add_from_template", templates=["catan", "wingspan", "pandemic", "codenames", "heat", "7 Wonders Duel"])
    return d


async def test_stats_end_to_end_over_logged_plays():
    d = await _table()
    for i, (me, sam, jo) in enumerate([(10, 8, 7), (9, 10, 6), (10, 7, 5), (10, 9, 8), (10, 8, 9)]):
        await act(d, "log_play", game="Catan", date=f"2026-10-0{i + 1}", duration_min=90,
                  players=[{"player": "me", "score": me}, {"player": "Sam", "score": sam}, {"player": "Jo", "score": jo}])
    await act(d, "log_play", game="Pandemic", date="2026-10-07", coop_won=True, players=[{"player": "me"}, {"player": "Sam"}])
    ps = (await act(d, "player_stats", player="me")).result
    assert ps["plays"] == 6 and ps["wins"] == 4 and ps["competitive_plays"] == 5 and ps["win_rate"] == 0.8
    assert ps["coop"] == {"plays": 1, "wins": 1}
    assert ps["streak"]["current_wins"] == 3 and ps["elo"] > 1500
    assert ps["head_to_head"]["Sam"] == {"played": 5, "wins": 4, "losses": 1, "ties": 0}
    gs = (await act(d, "game_stats", game="catan")).result
    assert gs["plays"] == 5 and gs["high_score"]["score"] == 10 and gs["average_minutes"] == 90
    assert gs["best_player"]["name"] == "Tristen" and gs["average_winning_score"] == 10
    h = (await act(d, "head_to_head", a="Sam", b="Jo")).result
    assert h["played"] == 5 and h["a_wins"] == 4 and h["b_wins"] == 1
    lb = (await act(d, "leaderboard", game="Catan")).result
    assert lb[0]["name"] == "Tristen" and lb[-1]["name"] == "Jo"
    ov = (await act(d, "overall_stats")).result
    assert ov["plays"] == 6 and ov["nickels"] == ["Catan"] and ov["h_index"] == 1
    assert any(s["title"] == "Table champion" for s in ov["superlatives"])
    first = [p for p in d["plays"] if p["date"] == "2026-10-01"][0]
    assert all(s["first_play"] for s in first["seats"])
    assert not any(s["first_play"] for s in d["plays"][1]["seats"])
    sug = (await act(d, "suggest_game", players=2, minutes=30)).result
    assert "7 Wonders Duel" in [r["name"] for r in sug["from_library"]] and "Catan" not in [r["name"] for r in sug["from_library"]]
    fp = (await act(d, "find_plays", game="Catan", since="2026-10-03")).result
    assert [r["date"] for r in fp] == ["2026-10-05", "2026-10-04", "2026-10-03"]
    text = to_text(d)
    assert "Recent plays" in text and "Catan" in text and "Tristen" in text and "H-index" in text
    assert text.index("2026-10-07") < text.index("2026-10-01")


# ------------------------------------------------------------ actions


async def test_players_add_update_merge_delete():
    d = fresh()
    out = await act(d, "add_players", players=[{"name": "Sam"}, {"name": "sam"}, {"name": "Me Myself", "me": True}])
    assert len(d["players"]) == 2 and d["settings"]["me_player_id"] == d["players"][1]["id"]
    assert d["players"][0]["color"] != d["players"][1]["color"]
    assert "Added" in out.summary
    await act(d, "update_player", player="Sam", favorite=True, color="#112233")
    assert d["players"][0]["favorite"] and d["players"][0]["color"] == "#112233"
    await act(d, "add_players", players=[{"name": "Samuel"}])
    await act(d, "log_play", game="Uno", players=[{"player": "Samuel", "score": 500}, {"player": "me", "score": 200}])
    await act(d, "merge_players", keep="Sam", merge=["Samuel"])
    assert [p["name"] for p in d["players"]] == ["Sam", "Me Myself"]
    assert d["plays"][0]["seats"][0]["player_id"] == d["players"][0]["id"]
    with pytest.raises(ActionError):
        await act(d, "merge_players", keep="Sam", merge=["Me Myself"])  # sat together
    with pytest.raises(ActionError):
        await act(d, "delete_player", player="Sam")  # has plays
    await act(d, "add_players", players=[{"name": "Guest"}])
    await act(d, "delete_player", player="Guest")
    with pytest.raises(ActionError):
        await act(d, "update_player", player="Nobody", favorite=True)


async def test_add_game_with_scoring_setup_and_update():
    d = fresh()
    out = await act(
        d, "add_game", name="Ark Nova House", min_players=1, max_players=4, play_minutes=150, weight=3.8,
        scoring={"win": "high", "pad": "categories", "categories": [
            {"name": "Appeal"}, {"name": "Conservation", "multiplier": 2}, {"name": "Penalty", "subtract": True}],
            "bonuses": [{"name": "Big zoo", "categories": ["Appeal"], "threshold": 50, "points": 5}],
            "tiebreaker": "Shared"},
        expansions=[{"name": "Marine Worlds", "categories": [{"name": "Reefs"}]}],
    )
    g = d["games"][0]
    assert out.result["game_id"] == g["id"] and [c["id"] for c in g["scoring"]["categories"]] == ["appeal", "conservation", "penalty"]
    assert g["scoring"]["bonuses"][0]["categories"] == ["appeal"]
    assert g["expansions"][0]["categories"][0]["name"] == "Reefs"
    with pytest.raises(ActionError):
        await act(d, "add_game", name="ark nova house")
    await act(d, "update_game", game="Ark Nova House", favorite=True, scoring={"win": "high", "pad": "categories", "categories": [{"name": "Conservation"}, {"name": "Appeal"}]})
    assert g["favorite"] and [c["id"] for c in g["scoring"]["categories"]] == ["conservation", "appeal"]
    # Empty categories on a category pad falls back to totals.
    await act(d, "add_game", name="Plain", scoring={"pad": "categories"})
    assert d["games"][1]["scoring"]["pad"] == "total"


async def test_templates_actions():
    d = fresh()
    out = await act(d, "add_from_template", templates=["wingspan", "Wingspan", "Not A Real Game"])
    assert [g["name"] for g in d["games"]] == ["Wingspan"] and out.result["no_template"] == ["Not A Real Game"]
    with pytest.raises(ActionError):
        await act(d, "add_from_template", templates=["Nope nope"])
    lt = (await act(d, "list_templates", query="wing")).result
    assert lt[0]["id"] == "wingspan" and lt[0]["in_library"]
    with pytest.raises(ActionError):
        await act(d, "delete_game", game="Nope")


async def test_live_play_categories_finish_and_tiebreak():
    d = await _table()
    out = await act(d, "start_play", game="Wingspan", players=["me", "Sam", "Newcomer Nat"], expansions=["Oceania"])
    pid = out.result["play_id"]
    play = d["plays"][-1]
    assert play["status"] == "active" and play["timer_started_at"] and len(play["seats"]) == 3
    assert "Newcomer Nat" in out.result["created"] and play["expansions"] == ["oceania-expansion"]
    r = await act(d, "record_scores", scores=[
        {"player": "me", "category": "Birds", "value": 40}, {"player": "me", "category": "eggs", "value": 10},
        {"player": "Sam", "category": "Birds", "value": 45}, {"player": "Sam", "category": "Nectar", "value": 5},
        {"player": "Nat", "category": "Birds", "value": 30},
    ])
    assert r.result["totals"]["Tristen"] == 50 and r.result["totals"]["Sam"] == 50
    await act(d, "record_scores", scores=[{"player": "Nat", "category": "Birds", "value": 5, "mode": "add"}])
    assert play["seats"][2]["scores"]["birds"] == 35
    with pytest.raises(ActionError):
        await act(d, "record_scores", scores=[{"player": "Sam", "category": "Spaceships", "value": 1}])
    with pytest.raises(ActionError):
        await act(d, "record_scores", scores=[{"player": "Jo", "category": "Birds", "value": 1}])  # not in this play
    later = NOW.replace(hour=21, minute=10)
    out = await act(d, "finish_play", now=later)
    assert out.result["tied"] and "unused food" in out.result["tiebreaker"]
    assert play["status"] == "finished" and play["duration_min"] == 70
    out = await act(d, "edit_play", play_id=pid, tiebreak_winner="Sam")
    assert [s["winner"] for s in play["seats"]] == [False, True, False]
    with pytest.raises(ActionError):
        await act(d, "finish_play", play_id=pid)  # already finished
    with pytest.raises(ActionError):
        await act(d, "finish_play")  # nothing in progress


async def test_live_rounds_teams_coop_ranked_and_discard():
    d = await _table()
    await act(d, "add_from_template", templates=["uno"])
    await act(d, "start_play", game="UNO", players=["me", "Sam"])
    await act(d, "record_scores", scores=[{"player": "me", "value": 120}, {"player": "Sam", "value": 0}], next_round=True)
    await act(d, "record_scores", scores=[{"player": "Sam", "value": 400}], next_round=True)
    play = d["plays"][-1]
    assert play["round"] == 2 and play["seats"][1]["rounds"] == [0, 400]
    await act(d, "finish_play")
    assert play["seats"][1]["winner"] and play["seats"][1]["score"] == 400
    # Teams (Codenames): pick the winning team.
    with pytest.raises(ActionError):
        await act(d, "start_play", game="Codenames", players=["me", "Sam"])
    await act(d, "start_play", game="Codenames", teams=[{"name": "Red", "players": ["me", "Jo"]}, {"name": "Blue", "players": ["Sam"]}])
    await act(d, "finish_play", winners=["Blue"])
    p = d["plays"][-1]
    assert [s["winner"] for s in p["seats"]] == [False, False, True]
    # Co-op needs the outcome.
    await act(d, "start_play", game="Pandemic", players=["me", "Sam"])
    with pytest.raises(ActionError):
        await act(d, "finish_play")
    await act(d, "finish_play", coop_won=False)
    assert not any(s["winner"] for s in d["plays"][-1]["seats"])
    # Ranked (Heat): finishing order.
    await act(d, "start_play", game="Heat", players=["me", "Sam", "Jo"])
    with pytest.raises(ActionError):
        await act(d, "finish_play")
    await act(d, "finish_play", placements=["Jo", "me", "Sam"])
    assert [s["place"] for s in d["plays"][-1]["seats"]] == [2, 3, 1]
    # Discard.
    await act(d, "start_play", game="Catan", players=["me", "Sam", "Jo"])
    n = len(d["plays"])
    await act(d, "discard_play")
    assert len(d["plays"]) == n - 1


async def test_log_play_from_chat_and_edits():
    d = await _table()
    out = await act(d, "log_play", game="Catan", players=[{"player": "I", "score": 10}, {"player": "Sam", "score": 8}, {"player": "Jo", "score": 7}], location="Home")
    assert "Tristen won with 10" in out.summary
    pid = out.result["play_id"]
    # A brand new game without a template becomes a simple game.
    out = await act(d, "log_play", game="Obscure Thing", players=[{"player": "Sam", "winner": True}, {"player": "Jo"}])
    g = next(g for g in d["games"] if g["name"] == "Obscure Thing")
    assert g["scoring"]["win"] == "winlose" and "new game" in out.summary
    # Category scores by name.
    out = await act(d, "log_play", game="Wingspan", players=[{"player": "me", "category_scores": {"Birds": 50, "Eggs": 12}}, {"player": "Sam", "score": 55}])
    assert d["plays"][-1]["seats"][0]["score"] == 62 and d["plays"][-1]["seats"][0]["winner"]
    with pytest.raises(ActionError):
        await act(d, "log_play", game="Pandemic", players=[{"player": "me"}])  # won or lost?
    with pytest.raises(ActionError):
        await act(d, "log_play", game="Codenames", players=[{"player": "me"}, {"player": "Sam"}])  # needs teams
    with pytest.raises(ActionError):
        await act(d, "log_play", game="Catan", players=[{"player": "Sam"}, {"player": "sam"}])
    # Teams with team scores.
    await act(d, "log_play", game="Codenames", players=[{"player": "me", "team": "Red"}, {"player": "Sam", "team": "Blue"}], team_scores={"Red": 1, "Blue": 0})
    assert d["plays"][-1]["seats"][0]["winner"]
    # Instant win in a score game: places stated.
    await act(d, "log_play", game="7 Wonders Duel", players=[{"player": "me", "score": 30, "place": 1}, {"player": "Sam", "score": 60, "place": 2}])
    assert d["plays"][-1]["manual"] and d["plays"][-1]["seats"][0]["winner"]
    # Edit: new scores flip the result; dates and notes change.
    await act(d, "edit_play", play_id=pid, date="2026-10-20", notes="Rematch soon", players=[{"player": "me", "score": 8}, {"player": "Sam", "score": 10}, {"player": "Jo", "score": 7}])
    p = next(x for x in d["plays"] if x["id"] == pid)
    assert p["date"] == "2026-10-20" and p["seats"][1]["winner"] and not p["seats"][0]["winner"]
    await act(d, "record_scores", play_id=pid, scores=[{"player": "me", "value": 11}])
    assert p["seats"][0]["winner"]
    await act(d, "delete_play", play_id=pid)
    assert all(x["id"] != pid for x in d["plays"])
    with pytest.raises(ActionError):
        await act(d, "delete_play", play_id=pid)
    # Deleting a game with plays needs confirmation.
    with pytest.raises(ActionError):
        await act(d, "delete_game", game="Wingspan")
    await act(d, "delete_game", game="Wingspan", with_plays=True)
    assert not any(g["name"] == "Wingspan" for g in d["games"])


async def test_ids_are_deterministic():
    a, b = await _table(), await _table()
    ra = await act(a, "log_play", game="Catan", players=[{"player": "me", "score": 10}, {"player": "Sam", "score": 3}])
    rb = await act(b, "log_play", game="Catan", players=[{"player": "me", "score": 10}, {"player": "Sam", "score": 3}])
    assert ra.result["play_id"] == rb.result["play_id"] and a == b


async def test_settings_and_me_required():
    d = fresh()
    with pytest.raises(ActionError):
        await act(d, "log_play", game="Catan", players=[{"player": "me", "score": 3}])
    await act(d, "update_settings", default_location="The Den", elo_k=24)
    assert d["settings"]["default_location"] == "The Den" and d["settings"]["elo_k"] == 24
    await act(d, "log_play", game="Catan", players=[{"player": "Ann", "score": 3}, {"player": "Bo", "score": 2}])
    assert d["plays"][0]["location"] == "The Den"


def test_tools_have_no_refs_and_include_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    for a in SPEC.actions:
        assert a.name in names
    assert "web_search" in names
    assert "$ref" not in json.dumps(tools)
    ro = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "player_stats" in ro and "log_play" not in ro


def test_to_text_empty_and_in_progress():
    assert "No players" in to_text(fresh())


async def test_to_text_shows_play_in_progress():
    d = await _table()
    await act(d, "start_play", game="Catan", players=["me", "Sam"])
    await act(d, "record_scores", scores=[{"player": "Sam", "category": "Cities", "value": 2}])
    assert "IN PROGRESS" in to_text(d) and "Sam 4" in to_text(d)


# ------------------------------------------------------------ API


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def test_api_flow(client, user):
    h = _auth(user)
    store = (await client.get("/api/items/store", headers=h)).json()["items"]
    entry = next(i for i in store if i["kind"] == "boardgames")
    assert entry["suffix"] == ".games" and entry["color"] == "#C2557A" and entry["category"] == "Fun"
    assert (await client.post("/api/items/store/boardgames", headers=h)).status_code == 200
    r = await client.post("/api/items", headers=h, json={"kind": "boardgames", "title": "Friday games"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "Friday games.games"
    r = await client.post(f"/api/items/{fid}/actions/add_players", headers=h, json={"args": {"players": [{"name": "Me", "me": True}, {"name": "Sam"}]}})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/actions/log_play", headers=h, json={"args": {"game": "Catan", "players": [{"player": "me", "score": 10}, {"player": "Sam", "score": 8}]}})
    assert r.status_code == 200 and "won with 10" in r.json()["summary"]
    rev = r.json()["revision"]
    data = r.json()["data"]
    r = await client.post(f"/api/items/{fid}/actions/player_stats", headers=h, json={"args": {"player": "Sam"}})
    assert r.status_code == 200 and r.json()["result"]["plays"] == 1 and r.json()["revision"] == rev
    r = await client.post(f"/api/items/{fid}/actions/finish_play", headers=h, json={"args": {}})
    assert r.status_code == 400 and "no play in progress" in r.json()["detail"].lower()
    # The UI's own save (direct edit) is validated.
    data["settings"]["confetti"] = False
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": data, "base_revision": rev})
    assert r.status_code == 200 and r.json()["data"]["settings"]["confetti"] is False
    bad = json.loads(json.dumps(r.json()["data"]))
    bad["players"][0]["color"] = "red"
    r2 = await client.put(f"/api/items/{fid}", headers=h, json={"data": bad, "base_revision": r.json()["revision"]})
    assert r2.status_code == 400
    # A live play shaped exactly like the UI's (makePlay) saves, and the AI can finish it.
    cur = r.json()
    d2 = json.loads(json.dumps(cur["data"]))
    me_id, sam_id = d2["players"][0]["id"], d2["players"][1]["id"]
    entry = {"scores": {}, "rounds": [], "total": None, "tiebreak": None, "score": None, "place": None, "winner": False}
    d2["plays"].append({
        "id": "plk2j3h4", "game_id": d2["games"][0]["id"], "status": "active", "date": "2026-10-31",
        "started_at": "2026-10-31T19:00:00+11:00", "ended_at": None, "duration_min": None, "location": "", "notes": "",
        "seats": [{**entry, "player_id": me_id, "team_id": None, "faction": "", "first_play": False, "note": "", "scores": {"settlements": 4, "cities": 3}},
                  {**entry, "player_id": sam_id, "team_id": None, "faction": "", "first_play": False, "note": "", "scores": {"settlements": 5}}],
        "teams": [], "expansions": [], "coop_won": None, "manual": False, "round": 0, "focus": 1,
        "timer_started_at": None, "timer_elapsed_s": 3600, "tiebreak_note": "", "created_at": "2026-10-31T19:00:00+11:00",
    })
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": d2, "base_revision": cur["revision"]})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/actions/finish_play", headers=h, json={"args": {}})
    assert r.status_code == 200, r.text
    fin = next(p for p in r.json()["data"]["plays"] if p["id"] == "plk2j3h4")
    assert fin["status"] == "finished" and fin["duration_min"] == 60 and fin["seats"][0]["score"] == 10 and fin["seats"][0]["winner"]

    from app.database import SessionLocal
    from app.files.models import UserFile

    async with SessionLocal() as s:
        row = await s.get(UserFile, uuid.UUID(fid))
        assert "Catan" in row.content_text and "Sam" in row.content_text


# ------------------------------------------------------------ fix pass


def _tpl(tid: str) -> dict:
    return {**game_from_template(BY_ID[tid]), "id": tid}


def test_template_arithmetic_on_samples():
    tm = _tpl("terraforming-mars")
    s = seat("a", scores={"tr": 40, "awards": 7, "milestones": 2, "greenery": 9, "cities": 8, "cards": 15})
    assert entry_total(tm, s) == 40 + 7 + 10 + 9 + 8 + 15
    ev = _tpl("everdell")
    s = seat("a", scores={"cards": 30, "tokens": 4, "basic-events": 2, "special-events": 6, "prosperity": 9, "journey": 3})
    assert entry_total(ev, s) == 30 + 4 + 6 + 6 + 9 + 3
    catan = _tpl("catan")
    assert entry_total(catan, seat("a", scores={"settlements": 2, "cities": 3, "vp-cards": 1, "longest-road": 2})) == 2 + 6 + 1 + 2
    azul = _tpl("azul")
    assert entry_total(azul, seat("a", scores={"wall": 50, "floor": 6, "rows": 2, "columns": 1, "colours": 1})) == 50 - 6 + 4 + 7 + 10
    spl = _tpl("splendor")
    assert entry_total(spl, seat("a", scores={"cards": 12, "nobles": 1})) == 15
    dom = _tpl("dominion")
    assert entry_total(dom, seat("a", scores={"estates": 3, "duchies": 2, "provinces": 4, "curses": 2})) == 3 + 6 + 24 - 2
    agr = _tpl("agricola")
    assert entry_total(agr, seat("a", scores={"fields": 2, "unused": 3, "stone": 2, "family": 4, "begging": 1})) == 2 - 3 + 4 + 12 - 3
    ttr = _tpl("ticket-to-ride")
    assert entry_total(ttr, seat("a", scores={"routes": 60, "tickets": 30, "failed": 12, "longest": 10})) == 88
    # Every "Count — N each" category multiplies by N (negative = a penalty).
    import re as _re

    checked = 0
    for t in TEMPLATES:
        for c in t["scoring"]["categories"] + [c for e in t["expansions"] for c in e["categories"]]:
            m = _re.search(r"Count — (−?\d+) (?:VP )?each", c.get("hint", ""))
            if m:
                n = int(m.group(1).replace("−", "-"))
                assert c.get("multiplier", 1) == abs(n), (t["id"], c["name"])
                assert bool(c.get("subtract")) == (n < 0), (t["id"], c["name"])
                checked += 1
    assert checked >= 20


def test_blank_seat_is_missing_not_zero():
    low = game(win="low", pad="rounds")
    play = {"seats": [seat("a", rounds=[4, 5]), seat("b"), seat("c", rounds=[3, 3])]}
    res = compute_results(low, play)
    assert res["winners"] == ["c"] and [s["place"] for s in play["seats"]] == [2, None, 1]
    assert [r.get("player_id") for r in res["unscored"]] == ["b"]
    assert [x["id"] for x in live_standings(low, play)] == ["c", "a", "b"]
    high = game()
    play = {"seats": [seat("a", total=3), seat("b")]}
    res = compute_results(high, play)
    assert res["winners"] == ["a"] and play["seats"][1]["place"] is None and not play["seats"][1]["winner"]


def test_ranked_with_scores_recomputes_places():
    g = game(win="ranked")
    play = {"seats": [seat("a", total=5, place=1), seat("b", total=9, place=2)]}
    compute_results(g, play)
    assert [s["place"] for s in play["seats"]] == [2, 1] and play["seats"][1]["winner"]
    # No scores: the typed finishing order stands.
    play = {"seats": [seat("a", place=2), seat("b", place=1)]}
    assert compute_results(g, play)["winners"] == ["b"]


async def test_refinish_a_reopened_play_recomputes():
    d = await _table()
    await act(d, "start_play", game="Catan", players=["me", "Sam"])
    await act(d, "record_scores", scores=[{"player": "me", "value": 10}, {"player": "Sam", "value": 8}])
    await act(d, "finish_play", winners=["Sam"])  # picked by hand
    play = d["plays"][-1]
    assert play["manual"] and play["seats"][1]["winner"]
    # Reopened on the pad (the UI's "Edit scores"), then finished again without a pick.
    play["status"] = "active"
    await act(d, "finish_play")
    assert not play["manual"] and play["seats"][0]["winner"] and not play["seats"][1]["winner"]
    # Ranked: a score fix on the finished play re-ranks, and so does a re-finish.
    await act(d, "start_play", game="Heat", players=["me", "Sam"])
    await act(d, "record_scores", scores=[{"player": "me", "value": 3}, {"player": "Sam", "value": 9}])
    await act(d, "finish_play")
    h = d["plays"][-1]
    assert [s["place"] for s in h["seats"]] == [2, 1]
    await act(d, "record_scores", play_id=h["id"], scores=[{"player": "me", "value": 20}])
    assert [s["place"] for s in h["seats"]] == [1, 2] and h["seats"][0]["winner"]
    h["status"] = "active"
    await act(d, "record_scores", scores=[{"player": "Sam", "value": 30}])
    await act(d, "finish_play")
    assert [s["place"] for s in h["seats"]] == [2, 1]


async def test_record_scores_on_finished_manual_play():
    d = await _table()
    # The stated winner agrees with the scores: a later fix re-decides it.
    out = await act(d, "log_play", game="Catan", players=[{"player": "me", "score": 10, "place": 1}, {"player": "Sam", "score": 8, "place": 2}])
    p = d["plays"][-1]
    assert not p["manual"]
    await act(d, "record_scores", play_id=out.result["play_id"], scores=[{"player": "Sam", "value": 12}])
    assert p["seats"][1]["winner"] and not p["seats"][0]["winner"]
    # A real override (an instant win) survives a score fix, and says so.
    out = await act(d, "log_play", game="7 Wonders Duel", players=[{"player": "me", "score": 30, "place": 1}, {"player": "Sam", "score": 60, "place": 2}])
    p = d["plays"][-1]
    assert p["manual"]
    r = await act(d, "record_scores", play_id=out.result["play_id"], scores=[{"player": "Sam", "value": 70}])
    assert p["seats"][0]["winner"] and "set by hand" in r.summary


async def test_finish_refuses_blank_seats_unless_confirmed():
    d = await _table()
    await act(d, "add_from_template", templates=["generic-low"])
    await act(d, "start_play", game="Lowest score wins (golf style)", players=["me", "Sam", "Jo"])
    with pytest.raises(ActionError, match="No scores recorded"):
        await act(d, "finish_play")
    await act(d, "record_scores", scores=[{"player": "me", "value": 5}, {"player": "Sam", "value": 7}])
    with pytest.raises(ActionError, match="No score for Jo"):
        await act(d, "finish_play")
    await act(d, "finish_play", unscored_ok=True)
    p = d["plays"][-1]
    assert [s["place"] for s in p["seats"]] == [1, 2, None] and p["seats"][0]["winner"] and not p["seats"][2]["winner"]


async def test_update_game_keeps_category_ids_and_ignores_removed():
    d = fresh()
    await act(d, "add_players", players=[{"name": "Me", "me": True}, {"name": "Sam"}])
    await act(d, "add_game", name="House", scoring={"pad": "categories", "categories": [{"name": "Gold"}, {"name": "Gems", "multiplier": 2}, {"name": "Junk"}]})
    await act(d, "start_play", game="House", players=["me", "Sam"])
    await act(d, "record_scores", scores=[
        {"player": "me", "category": "Gold", "value": 5}, {"player": "me", "category": "Gems", "value": 3}, {"player": "me", "category": "Junk", "value": 4}])
    g = d["games"][0]
    # Rename Gems → Jewels (by id), drop Junk, add "Junk 2".
    out = await act(d, "update_game", game="House", scoring={"pad": "categories", "categories": [
        {"name": "Gold"}, {"id": "gems", "name": "Jewels", "multiplier": 2}, {"name": "Junk 2"}]})
    ids = [c["id"] for c in g["scoring"]["categories"]]
    assert ids == ["gold", "gems", "junk-2"]
    assert out.result["plays_with_removed_categories"] == 1 and "removed categories" in out.summary
    play = d["plays"][-1]
    assert entry_total(g, play["seats"][0], play_categories(g, play)) == 5 + 6  # Junk no longer counts
    # A new category never takes over an old (deleted) one's id.
    await act(d, "update_game", game="House", scoring={"pad": "categories", "categories": [{"name": "Gold"}, {"name": "Junk"}]})
    assert [c["id"] for c in g["scoring"]["categories"]] == ["gold", "junk-3"]
    assert entry_total(g, play["seats"][0], play_categories(g, play)) == 5
    # ``requires`` resolves by name.
    await act(d, "add_game", name="Dice", scoring={"pad": "categories", "categories": [{"name": "Big"}, {"name": "Big bonus", "requires": "Big"}]})
    assert d["games"][-1]["scoring"]["categories"][1]["requires"] == "big"


def test_to_text_uses_the_owners_today():
    from app.items.spec import _TEXT_NOW

    d = fresh()
    d["players"] = [{"id": "a", "name": "Ann"}, {"id": "b", "name": "Bo"}]
    d["games"] = [{"id": "g", "name": "G"}]
    d["plays"] = [{"id": "p1", "game_id": "g", "date": "2026-10-29", "seats": [seat("a", score=3, place=1, winner=True), seat("b", score=1, place=2)]}]
    d = SPEC.validate(d)
    tok = _TEXT_NOW.set(NOW)
    try:
        text = to_text(d)
    finally:
        _TEXT_NOW.reset(tok)
    assert "Today is 2026-10-31" in text and "2 days ago" in text and "1 plays this month" in text
