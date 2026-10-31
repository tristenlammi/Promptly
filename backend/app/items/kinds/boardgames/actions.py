"""Game Night actions — the AI's (and chat's) hands. Deterministic for
(data, args, ctx.now): new ids come from names and counters, never chance."""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from . import stats
from .models import WIN_LABELS, Hex, Num, PadKind, WinCondition
from .scoring import break_tie, clean_num, compute_results, entrants, entry_total, has_entries, orphan_categories, play_categories, unscored_rows
from .templates import find_template, game_from_template, search_templates, slug

PALETTE = ["#C2557A", "#3B7DD8", "#4E9F5B", "#D9902F", "#7B6CD9", "#2C9CC8", "#E2725B", "#8A6F5A", "#2F8F83", "#B5835A", "#D9506A", "#5B6DD9"]
TEAM_COLORS = ["#D9506A", "#3B7DD8", "#4E9F5B", "#D9902F", "#7B6CD9", "#2C9CC8"]


# ------------------------------------------------------------------ helpers


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _new_id(prefix: str, base: str, taken: set[str]) -> str:
    stem = f"{prefix}{slug(base, 20)}" if base else prefix
    cand, n = stem, 2
    while cand in taken:
        cand, n = f"{stem}-{n}", n + 1
    return cand


def _play_id(data: dict, game_id: str, ctx: ItemContext, salt: str = "") -> str:
    h = hashlib.sha1(f"{game_id}|{ctx.now.isoformat()}|{salt}|{len(data['plays'])}".encode()).hexdigest()[:8]
    taken = {p["id"] for p in data["plays"]}
    cand, n = f"pl{h}", 2
    while cand in taken:
        cand, n = f"pl{h}{n}", n + 1
    return cand


def _me(data: dict) -> dict | None:
    mid = data["settings"].get("me_player_id")
    return next((p for p in data["players"] if p["id"] == mid), None) or next((p for p in data["players"] if p.get("me")), None)


def find_player(data: dict, ref: str, among: set[str] | None = None) -> dict | None:
    """By id, 'me', exact name, then a unique prefix / first-name / any-word
    match (limited to ``among`` player ids when given — a play's seats)."""
    ref = (ref or "").strip()
    if not ref:
        return None
    pool = [p for p in data["players"] if among is None or p["id"] in among]
    for p in pool:
        if p["id"] == ref:
            return p
    if _norm(ref) in ("me", "i", "myself", "mine"):
        me = _me(data)
        return me if me and (among is None or me["id"] in among) else None
    q = _norm(ref)
    exact = [p for p in pool if _norm(p["name"]) == q]
    if exact:
        return next((p for p in exact if not p.get("archived")), exact[0])
    live = [p for p in pool if not p.get("archived")]
    for match in (
        lambda p: _norm(p["name"]).startswith(q),
        lambda p: any(_norm(w) == q for w in p["name"].split()),
        lambda p: any(_norm(w).startswith(q) for w in p["name"].split()),
    ):
        hits = [p for p in live if match(p)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            return None
    return None


def need_player(data: dict, ref: str, among: set[str] | None = None) -> dict:
    p = find_player(data, ref, among)
    if p is None:
        raise ActionError(f"No player called {ref!r}. Add them first (add_players) or check the name.")
    return p


def _add_player(data: dict, name: str, ctx: ItemContext, color: str | None = None, me: bool = False, favorite: bool = False) -> dict:
    taken = {p["id"] for p in data["players"]}
    used = {p["color"] for p in data["players"]}
    col = color or next((c for c in PALETTE if c not in used), PALETTE[len(data["players"]) % len(PALETTE)])
    p = {
        "id": _new_id("p-", name, taken),
        "name": name.strip()[:60],
        "color": col,
        "favorite": favorite,
        "archived": False,
        "me": me,
        "bgg_user": "",
        "notes": "",
        "created": ctx.today.isoformat(),
    }
    if me:
        for o in data["players"]:
            o["me"] = False
        data["settings"]["me_player_id"] = p["id"]
    data["players"].append(p)
    return p


def player_or_new(data: dict, ref: str, ctx: ItemContext, created: list[str]) -> dict:
    p = find_player(data, ref)
    if p is None:
        if not ref.strip() or _norm(ref) in ("me", "i", "myself"):
            raise ActionError("Who is “me”? Add yourself as a player (add_players with me=true) first.")
        p = _add_player(data, ref, ctx)
        created.append(p["name"])
    return p


def find_game(data: dict, ref: str) -> dict | None:
    ref = (ref or "").strip()
    for g in data["games"]:
        if g["id"] == ref:
            return g
    q = _norm(ref)
    if not q:
        return None
    exact = [g for g in data["games"] if _norm(g["name"]) == q]
    if exact:
        return exact[0]
    t = find_template(ref)
    if t:
        by_t = [g for g in data["games"] if g.get("template_id") == t["id"]]
        if by_t:
            return by_t[0]
    pref = [g for g in data["games"] if _norm(g["name"]).startswith(q) or q in _norm(g["name"])]
    return pref[0] if len(pref) == 1 else None


def need_game(data: dict, ref: str) -> dict:
    g = find_game(data, ref)
    if g is None:
        raise ActionError(f"No game called {ref!r} in the library. Add it (add_game or add_from_template) first.")
    return g


def _insert_game(data: dict, g: dict, ctx: ItemContext) -> dict:
    taken = {x["id"] for x in data["games"]}
    g["id"] = _new_id("g-", g["name"], taken)
    g.setdefault("created", ctx.today.isoformat())
    from .models import Game

    clean = Game.model_validate(g).model_dump(mode="json")
    data["games"].append(clean)
    return clean


def game_or_template(data: dict, ref: str, ctx: ItemContext, created: list[str], scored: bool = True) -> dict:
    g = find_game(data, ref)
    if g:
        return g
    t = find_template(ref)
    if t:
        g = _insert_game(data, game_from_template(t), ctx)
        created.append(f"{g['name']} (from template)")
        return g
    if not ref.strip():
        raise ActionError("Which game?")
    g = _insert_game(
        data,
        {"name": ref.strip()[:100], "scoring": {"win": "high" if scored else "winlose", "pad": "total"}},
        ctx,
    )
    created.append(f"{g['name']} (new game — check its scoring setup)")
    return g


def need_play(data: dict, play_id: str | None, active: bool | None = None) -> dict:
    if play_id:
        p = next((p for p in data["plays"] if p["id"] == play_id), None)
        if p is None:
            raise ActionError(f"No play with id {play_id!r}.")
        if active is True and p["status"] != "active":
            raise ActionError("That play is already finished — use edit_play.")
        return p
    live = [p for p in data["plays"] if p["status"] == "active"]
    if active is not False and len(live) == 1:
        return live[0]
    if not live:
        raise ActionError("There's no play in progress. Start one with start_play (or use log_play).")
    raise ActionError("More than one play is in progress — say which (play_id): " + ", ".join(p["id"] for p in live))


def _game_name(data: dict, gid: str) -> str:
    return next((g["name"] for g in data["games"] if g["id"] == gid), "?")


def _pname(data: dict, pid: str) -> str:
    return next((p["name"] for p in data["players"] if p["id"] == pid), "?")


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def _mark_first_plays(data: dict, play: dict) -> None:
    earlier = {
        s["player_id"]
        for p in data["plays"]
        if p is not play and p["status"] == "finished" and p["game_id"] == play["game_id"] and (p["date"], p.get("ended_at") or "") < (play["date"], play.get("ended_at") or "")
        for s in p["seats"]
    }
    for s in play["seats"]:
        s["first_play"] = s["player_id"] not in earlier


def _result_text(data: dict, game: dict | None, play: dict) -> str:
    win = (game or {}).get("scoring", {}).get("win", "high")
    names = [_pname(data, s["player_id"]) for s in play["seats"] if s.get("winner")]
    if win == "coop":
        return "You all won! 🎉" if play.get("coop_won") else "The game won this time."
    kind, rows = entrants(game, play)
    if kind == "teams":
        w = [t["name"] for t in rows if t.get("winner")]
        return f"{' & '.join(w)} won" if w else "No winner recorded"
    if not names:
        return "No winner recorded"
    score = next((s.get("score") for s in play["seats"] if s.get("winner")), None)
    tail = f" with {clean_num(score)}" if score is not None and win in ("high", "low") else ""
    return (" & ".join(names) + (" shared the win" if len(names) > 1 else " won")) + tail


def _standings(data: dict, game: dict | None, play: dict) -> list[dict]:
    kind, rows = entrants(game, play)
    if kind == "teams":
        return [{"team": t["name"], "score": t.get("score"), "place": t.get("place"), "winner": t.get("winner")} for t in rows]
    return [
        {"player": _pname(data, s["player_id"]), "score": s.get("score"), "place": s.get("place"), "winner": s.get("winner")}
        for s in sorted(play["seats"], key=lambda s: s.get("place") or 99)
    ]


# ------------------------------------------------------------------ players


class NewPlayer(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: Hex | None = Field(default=None, description="#RRGGBB; picked automatically if omitted")
    me: bool = Field(default=False, description="This is the person using the app")
    favorite: bool = False


class AddPlayers(BaseModel):
    players: list[NewPlayer] = Field(min_length=1, max_length=30)


def add_players(ctx: ItemContext, data: dict, p: AddPlayers) -> ActionOutcome:
    added, existing = [], []
    for np in p.players:
        found = next((x for x in data["players"] if _norm(x["name"]) == _norm(np.name)), None)
        if found:
            existing.append(found["name"])
            if np.me:
                for o in data["players"]:
                    o["me"] = o is found
                data["settings"]["me_player_id"] = found["id"]
            if found.get("archived"):
                found["archived"] = False
            continue
        added.append(_add_player(data, np.name, ctx, np.color, np.me, np.favorite))
    bits = []
    if added:
        bits.append("Added " + ", ".join(a["name"] for a in added))
    if existing:
        bits.append("already here: " + ", ".join(existing))
    return ActionOutcome(summary="; ".join(bits) or "No change", result={"added": [{"id": a["id"], "name": a["name"]} for a in added], "existing": existing})


class UpdatePlayer(BaseModel):
    player: str = Field(description="Player id or name")
    name: str | None = Field(default=None, min_length=1, max_length=60)
    color: Hex | None = None
    favorite: bool | None = None
    archived: bool | None = None
    me: bool | None = None
    notes: str | None = Field(default=None, max_length=500)


def update_player(ctx: ItemContext, data: dict, p: UpdatePlayer) -> ActionOutcome:
    pl = need_player(data, p.player)
    for f in ("name", "color", "favorite", "archived", "notes"):
        v = getattr(p, f)
        if v is not None:
            pl[f] = v
    if p.me is not None:
        if p.me:
            for o in data["players"]:
                o["me"] = o is pl
            data["settings"]["me_player_id"] = pl["id"]
        else:
            pl["me"] = False
            if data["settings"].get("me_player_id") == pl["id"]:
                data["settings"]["me_player_id"] = None
    return ActionOutcome(summary=f"Updated {pl['name']}", result={"id": pl["id"]})


class MergePlayers(BaseModel):
    keep: str = Field(description="The player to keep (id or name)")
    merge: list[str] = Field(min_length=1, max_length=10, description="Duplicates folded into `keep` and removed")


def merge_players(ctx: ItemContext, data: dict, p: MergePlayers) -> ActionOutcome:
    keep = need_player(data, p.keep)
    gone = []
    for ref in p.merge:
        dup = need_player(data, ref)
        if dup["id"] == keep["id"]:
            continue
        for play in data["plays"]:
            ids = [s["player_id"] for s in play["seats"]]
            if dup["id"] in ids and keep["id"] in ids:
                raise ActionError(f"{dup['name']} and {keep['name']} both sat in one play ({play['date']}) — they're different people.")
            for s in play["seats"]:
                if s["player_id"] == dup["id"]:
                    s["player_id"] = keep["id"]
        if dup.get("me") or data["settings"].get("me_player_id") == dup["id"]:
            keep["me"] = True
            data["settings"]["me_player_id"] = keep["id"]
        data["players"] = [x for x in data["players"] if x["id"] != dup["id"]]
        gone.append(dup["name"])
    return ActionOutcome(summary=f"Merged {', '.join(gone)} into {keep['name']}" if gone else "Nothing to merge", result={"kept": keep["id"]})


class DeletePlayer(BaseModel):
    player: str


def delete_player(ctx: ItemContext, data: dict, p: DeletePlayer) -> ActionOutcome:
    pl = need_player(data, p.player)
    n = sum(1 for play in data["plays"] if any(s["player_id"] == pl["id"] for s in play["seats"]))
    if n:
        raise ActionError(f"{pl['name']} is in {n} logged plays — archive them instead (update_player archived=true), or merge.")
    data["players"] = [x for x in data["players"] if x["id"] != pl["id"]]
    if data["settings"].get("me_player_id") == pl["id"]:
        data["settings"]["me_player_id"] = None
    return ActionOutcome(summary=f"Removed {pl['name']}")


# ------------------------------------------------------------------ games


class CategoryIn(BaseModel):
    id: str | None = Field(default=None, max_length=48, description="The existing category's id when editing a game — pass it to rename a category and keep everyone's typed scores")
    name: str = Field(min_length=1, max_length=60)
    hint: str = Field(default="", max_length=160)
    section: str = Field(default="", max_length=40)
    multiplier: Num = Field(default=1, description="Points per unit typed (Catan cities: 2)")
    subtract: bool = Field(default=False, description="A penalty typed as a positive number")
    options: list[Num] = Field(default_factory=list, max_length=12, description="Quick values (e.g. [0, 25])")
    step: Num = 1
    min: Num | None = None
    max: Num | None = None
    requires: str | None = Field(default=None, max_length=60, description="Name of another category that must have scored for this one to count (Yahtzee bonus → Yahtzee)")


class BonusIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    categories: list[str] = Field(default_factory=list, description="Category names it sums (empty = all)")
    threshold: Num
    points: Num


class ScoringIn(BaseModel):
    win: WinCondition = Field(default="high", description="; ".join(f"{k}: {v}" for k, v in WIN_LABELS.items()))
    pad: PadKind = Field(default="categories", description="categories = one row per score category; rounds = a score per round; total = one number each")
    categories: list[CategoryIn] = Field(default_factory=list, max_length=40)
    bonuses: list[BonusIn] = Field(default_factory=list, max_length=10)
    rounds: int | None = Field(default=None, ge=1, le=100, description="Fixed number of rounds, if any")
    target_score: Num | None = Field(default=None, description="The score that ends the game (Catan 10)")
    tiebreaker: str = Field(default="", max_length=400)
    notes: str = Field(default="", max_length=600)
    factions: list[str] = Field(default_factory=list, max_length=40)


class ExpansionIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    categories: list[CategoryIn] = Field(default_factory=list, max_length=20)
    factions: list[str] = Field(default_factory=list, max_length=20)


class GameIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    year: int | None = Field(default=None, ge=-3000, le=2100)
    min_players: int = Field(default=1, ge=1, le=100)
    max_players: int = Field(default=8, ge=1, le=100)
    play_minutes: int | None = Field(default=None, ge=1, le=10_000)
    weight: float | None = Field(default=None, ge=1, le=5, description="BGG complexity 1–5")
    categories: list[str] = Field(default_factory=list, max_length=12, description="Tags: Engine building, Party…")
    bgg_id: int | None = Field(default=None, ge=1)
    scoring: ScoringIn = Field(default_factory=ScoringIn)
    expansions: list[ExpansionIn] = Field(default_factory=list, max_length=30)
    notes: str = Field(default="", max_length=1000)
    owned: bool = True


def _cats(items: list[CategoryIn], old: list[dict] | None = None, reserved: set[str] | None = None) -> list[dict]:
    """Category dicts with ids. When editing (``old`` = the current sheet),
    a category keeps its id if the caller passed it or the name is
    unchanged, so typed scores stay attached through renames; a brand-new
    category never reuses an old id (it mustn't inherit a deleted one's
    values)."""
    old = old or []
    old_ids = {c["id"] for c in old}
    avoid = old_ids | (reserved or set())
    old_by_name = {_norm(c["name"]): c["id"] for c in old}
    used: set[str] = set()
    out = []
    for c in items:
        d = c.model_dump(exclude={"id", "requires"})
        cid = None
        if c.id and c.id in old_ids and c.id not in used:
            cid = c.id
        elif old_by_name.get(_norm(c.name)) and old_by_name[_norm(c.name)] not in used:
            cid = old_by_name[_norm(c.name)]
        if cid is None:
            cid = _new_id("", c.name, used | avoid)
        used.add(cid)
        d["id"] = cid
        d["_requires"] = c.requires
        out.append(d)
    by_name = {_norm(x["name"]): x["id"] for x in out}
    ids = {x["id"] for x in out}
    for d in out:
        req = d.pop("_requires")
        d["requires"] = (req if req in ids else by_name.get(_norm(req))) if req else None
    return out


def _scoring(s: ScoringIn, old_cats: list[dict] | None = None, reserved: set[str] | None = None) -> dict:
    cats = _cats(s.categories, old_cats, reserved)
    by_name = {_norm(c["name"]): c["id"] for c in cats}
    ids = {c["id"] for c in cats}
    bonuses = []
    for i, b in enumerate(s.bonuses):
        refs = [n if n in ids else by_name.get(_norm(n)) for n in b.categories]
        bonuses.append({"id": f"b{i + 1}", "name": b.name, "categories": [r for r in refs if r], "threshold": b.threshold, "points": b.points})
    pad = s.pad
    if pad == "categories" and not cats:
        pad = "total"
    return {**s.model_dump(exclude={"categories", "bonuses"}), "pad": pad, "categories": cats, "bonuses": bonuses}


def _game_dict(p: GameIn) -> dict:
    d = p.model_dump(exclude={"scoring", "expansions"})
    d["scoring"] = _scoring(p.scoring)
    taken: set[str] = set()
    exps = []
    for e in p.expansions:
        eid = _new_id("", e.name, taken)
        taken.add(eid)
        exps.append({"id": eid, "name": e.name, "categories": _cats(e.categories), "factions": e.factions})
    d["expansions"] = exps
    if d["max_players"] < d["min_players"]:
        d["max_players"] = d["min_players"]
    return d


def add_game(ctx: ItemContext, data: dict, p: GameIn) -> ActionOutcome:
    if find_game(data, p.name) and _norm(find_game(data, p.name)["name"]) == _norm(p.name):
        raise ActionError(f"{p.name} is already in the library — use update_game to change it.")
    g = _insert_game(data, _game_dict(p), ctx)
    sc = g["scoring"]
    return ActionOutcome(
        summary=f"Added {g['name']} ({WIN_LABELS[sc['win']].lower()}{', ' + str(len(sc['categories'])) + ' score categories' if sc['categories'] else ''})",
        result={"game_id": g["id"]},
    )


class FromTemplate(BaseModel):
    templates: list[str] = Field(min_length=1, max_length=40, description="Template ids or game names (see list_templates)")


def add_from_template(ctx: ItemContext, data: dict, p: FromTemplate) -> ActionOutcome:
    added, have, missing = [], [], []
    for ref in p.templates:
        t = find_template(ref)
        if t is None:
            missing.append(ref)
            continue
        existing = next((g for g in data["games"] if g.get("template_id") == t["id"] or _norm(g["name"]) == _norm(t["name"])), None)
        if existing and not t["id"].startswith("generic"):
            have.append(existing["name"])
            continue
        g = _insert_game(data, game_from_template(t), ctx)
        added.append({"game_id": g["id"], "name": g["name"]})
    if not added and missing and not have:
        raise ActionError(f"No built-in template for {', '.join(missing)} — set it up with add_game instead.")
    bits = []
    if added:
        bits.append("Added " + ", ".join(a["name"] for a in added))
    if have:
        bits.append("already in the library: " + ", ".join(have))
    if missing:
        bits.append("no template for: " + ", ".join(missing))
    return ActionOutcome(summary="; ".join(bits), result={"added": added, "already": have, "no_template": missing})


class ListTemplates(BaseModel):
    query: str = Field(default="", max_length=60)


def list_templates(ctx: ItemContext, data: dict, p: ListTemplates) -> ActionOutcome:
    rows = search_templates(p.query)
    have = {g.get("template_id") for g in data["games"]}
    return ActionOutcome(
        summary="",
        result=[
            {
                "id": t["id"],
                "name": t["name"],
                "year": t["year"],
                "players": f"{t['min_players']}–{t['max_players']}",
                "minutes": t["play_minutes"],
                "weight": t["weight"],
                "tags": t["categories"],
                "bgg_id": t["bgg_id"],
                "win": t["scoring"]["win"],
                "pad": t["scoring"]["pad"],
                "score_categories": [c["name"] for c in t["scoring"]["categories"]],
                "expansions": [e["name"] for e in t["expansions"]],
                "in_library": t["id"] in have,
                "scoring": t["scoring"],
            }
            for t in rows
        ],
    )


class UpdateGame(BaseModel):
    game: str = Field(description="Game id or name")
    name: str | None = Field(default=None, min_length=1, max_length=100)
    year: int | None = None
    min_players: int | None = Field(default=None, ge=1, le=100)
    max_players: int | None = Field(default=None, ge=1, le=100)
    play_minutes: int | None = Field(default=None, ge=1, le=10_000)
    weight: float | None = Field(default=None, ge=1, le=5)
    categories: list[str] | None = None
    bgg_id: int | None = None
    favorite: bool | None = None
    owned: bool | None = None
    notes: str | None = Field(default=None, max_length=1000)
    scoring: ScoringIn | None = Field(default=None, description="Replaces the whole scoring setup (finished plays keep their scores)")
    expansions: list[ExpansionIn] | None = Field(default=None, description="Replaces the expansion list")


def update_game(ctx: ItemContext, data: dict, p: UpdateGame) -> ActionOutcome:
    g = need_game(data, p.game)
    for f in ("name", "year", "min_players", "max_players", "play_minutes", "weight", "categories", "bgg_id", "favorite", "owned", "notes"):
        v = getattr(p, f)
        if v is not None:
            g[f] = v
    # Ids that hold typed values on this game's plays: a brand-new category
    # must not take one over (it would inherit a deleted category's numbers).
    used_ids = {cid for pl in data["plays"] if pl["game_id"] == g["id"] for r in [*pl.get("seats", []), *pl.get("teams", [])] for cid in (r.get("scores") or {})}
    if p.scoring is not None:
        # Category ids stay stable (by id, else by unchanged name), so live
        # pads and logged plays keep their numbers through renames.
        g["scoring"] = _scoring(p.scoring, g["scoring"].get("categories", []), used_ids)
    if p.expansions is not None:
        old_ex = {_norm(e["name"]): e for e in g.get("expansions", [])}
        exps = []
        taken: set[str] = set()
        for e in p.expansions:
            prev = old_ex.get(_norm(e.name))
            eid = prev["id"] if prev else _new_id("", e.name, taken | {x["id"] for x in g.get("expansions", [])})
            taken.add(eid)
            exps.append({"id": eid, "name": e.name, "categories": _cats(e.categories, (prev or {}).get("categories", []), used_ids), "factions": e.factions})
        g["expansions"] = exps
    # Values typed for categories that no longer exist don't count on the pad
    # (finished plays keep the result they were logged with) — say so.
    stranded = sum(1 for pl in data["plays"] if pl["game_id"] == g["id"] and orphan_categories(g, pl))
    note = f" — {stranded} play(s) hold scores for removed categories; those won't count if re-scored" if stranded else ""
    if g["max_players"] < g["min_players"]:
        g["max_players"] = g["min_players"]
    return ActionOutcome(summary=f"Updated {g['name']}{note}", result={"game_id": g["id"], "plays_with_removed_categories": stranded})


class DeleteGame(BaseModel):
    game: str
    with_plays: bool = Field(default=False, description="Also delete its logged plays (only when the person explicitly asked)")


def delete_game(ctx: ItemContext, data: dict, p: DeleteGame) -> ActionOutcome:
    g = need_game(data, p.game)
    n = sum(1 for x in data["plays"] if x["game_id"] == g["id"])
    if n and not p.with_plays:
        raise ActionError(f"{g['name']} has {n} logged plays. Confirm deleting them too (with_plays=true) or keep the game.")
    data["plays"] = [x for x in data["plays"] if x["game_id"] != g["id"]]
    data["games"] = [x for x in data["games"] if x["id"] != g["id"]]
    return ActionOutcome(summary=f"Deleted {g['name']}" + (f" and its {n} plays" if n else ""))


# ------------------------------------------------------------------ live play


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    players: list[str] = Field(min_length=1, max_length=15, description="Player names or ids")


class StartPlay(BaseModel):
    game: str = Field(description="Game id or name (a built-in template is added to the library if needed)")
    players: list[str] = Field(default_factory=list, max_length=30, description="Seat order; names or ids ('me' works). New names are added as players.")
    teams: list[TeamIn] = Field(default_factory=list, max_length=12)
    factions: dict[str, str] = Field(default_factory=dict, description="player → faction/role")
    expansions: list[str] = Field(default_factory=list, description="Expansion names in use")
    location: str = Field(default="", max_length=80)
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    start_timer: bool = True


def _seats_and_teams(data: dict, ctx: ItemContext, players: list[str], teams: list[TeamIn], created: list[str]) -> tuple[list[dict], list[dict]]:
    seats: list[dict] = []
    team_rows: list[dict] = []
    seen: set[str] = set()

    def seat_for(ref: str, team_id: str | None) -> None:
        pl = player_or_new(data, ref, ctx, created)
        if pl["id"] in seen:
            return
        seen.add(pl["id"])
        seats.append({"player_id": pl["id"], "team_id": team_id, "scores": {}, "rounds": []})

    for i, t in enumerate(teams):
        tid = f"t{i + 1}"
        team_rows.append({"id": tid, "name": t.name, "color": TEAM_COLORS[i % len(TEAM_COLORS)], "scores": {}, "rounds": []})
        for ref in t.players:
            seat_for(ref, tid)
    for ref in players:
        seat_for(ref, None)
    return seats, team_rows


def _expansion_ids(game: dict, names: list[str]) -> list[str]:
    out = []
    for n in names:
        ex = next((e for e in game.get("expansions", []) if e["id"] == n or _norm(e["name"]) == _norm(n) or _norm(n) in _norm(e["name"])), None)
        if ex is None:
            raise ActionError(f"{game['name']} has no expansion called {n!r} — add it with update_game first.")
        out.append(ex["id"])
    return out


def start_play(ctx: ItemContext, data: dict, p: StartPlay) -> ActionOutcome:
    created: list[str] = []
    game = game_or_template(data, p.game, ctx, created)
    win = game["scoring"]["win"]
    if win == "teams" and not p.teams:
        raise ActionError(f"{game['name']} is played in teams — give the teams and who's on each.")
    seats, teams = _seats_and_teams(data, ctx, p.players, p.teams, created)
    if not seats:
        raise ActionError("Who's playing?")
    for ref, fac in p.factions.items():
        pl = find_player(data, ref)
        for s in seats:
            if pl and s["player_id"] == pl["id"]:
                s["faction"] = fac[:60]
    now = _iso(ctx.now)
    play = {
        "id": _play_id(data, game["id"], ctx, json.dumps(p.model_dump(), sort_keys=True)),
        "game_id": game["id"],
        "status": "active",
        "date": p.date or ctx.today.isoformat(),
        "started_at": now,
        "location": p.location or data["settings"].get("default_location", ""),
        "seats": seats,
        "teams": teams,
        "expansions": _expansion_ids(game, p.expansions),
        "timer_started_at": now if p.start_timer else None,
        "timer_elapsed_s": 0,
        "created_at": now,
    }
    data["plays"].append(play)
    note = f" (added: {', '.join(created)})" if created else ""
    names = ", ".join(_pname(data, s["player_id"]) for s in seats)
    return ActionOutcome(summary=f"Started {game['name']} — {names}{note}", result={"play_id": play["id"], "game_id": game["id"], "created": created})


class ScoreIn(BaseModel):
    player: str = Field(description="Player name/id — or a team name in a team game")
    category: str | None = Field(default=None, description="Score category name/id (category pads)")
    round: int | None = Field(default=None, ge=1, le=100, description="Round number, 1-based (round pads)")
    value: Num
    mode: Literal["set", "add"] = "set"


class RecordScores(BaseModel):
    play_id: str | None = Field(default=None, description="Defaults to the one play in progress")
    scores: list[ScoreIn] = Field(min_length=1, max_length=300)
    next_round: bool = Field(default=False, description="Move the pad on to the next round afterwards")


def _entry_for(data: dict, game: dict, play: dict, ref: str) -> tuple[dict, str]:
    kind, rows = entrants(game, play)
    if kind == "teams":
        t = next((t for t in rows if t["id"] == ref or _norm(t["name"]) == _norm(ref)), None)
        if t is None:
            pl = find_player(data, ref, {s["player_id"] for s in play["seats"]})
            seat = next((s for s in play["seats"] if pl and s["player_id"] == pl["id"]), None)
            t = next((t for t in rows if seat and t["id"] == seat.get("team_id")), None)
        if t is None:
            raise ActionError(f"No team {ref!r} in this play.")
        return t, t["name"]
    in_play = {s["player_id"] for s in play["seats"]}
    pl = find_player(data, ref, in_play) or need_player(data, ref)
    seat = next((s for s in play["seats"] if s["player_id"] == pl["id"]), None)
    if seat is None:
        raise ActionError(f"{pl['name']} isn't in this play.")
    return seat, pl["name"]


def _find_cat(cats: list[dict], ref: str) -> dict | None:
    q = _norm(ref)
    return next((c for c in cats if c["id"] == ref), None) or next((c for c in cats if _norm(c["name"]) == q), None) or next(
        (c for c in cats if _norm(c["name"]).startswith(q)), None
    )


def _apply_score(data: dict, game: dict, play: dict, s: ScoreIn) -> str:
    entry, who = _entry_for(data, game, play, s.player)
    cats = play_categories(game, play)
    pad = game["scoring"]["pad"]
    if s.category:
        c = _find_cat(cats, s.category)
        if c is None:
            raise ActionError(f"{game['name']} has no score category {s.category!r} (it has: {', '.join(x['name'] for x in cats) or 'none'}).")
        cur = entry["scores"].get(c["id"]) or 0
        entry["scores"][c["id"]] = clean_num(cur + s.value if s.mode == "add" else s.value)
        entry["total"] = None
        return f"{who} {c['name']} {clean_num(entry['scores'][c['id']])}"
    if s.round is not None or pad == "rounds":
        r = (s.round - 1) if s.round is not None else play.get("round", 0)
        rounds = entry.setdefault("rounds", [])
        while len(rounds) <= r:
            rounds.append(None)
        rounds[r] = clean_num((rounds[r] or 0) + s.value if s.mode == "add" else s.value)
        entry["total"] = None
        return f"{who} R{r + 1} {clean_num(rounds[r])}"
    cur = entry.get("total") or 0
    entry["total"] = clean_num(cur + s.value if s.mode == "add" else s.value)
    return f"{who} {clean_num(entry['total'])}"


def follows_scores(game: dict, play: dict) -> bool:
    """Whether a hand-set (``manual``) result is just what the scores say
    anyway — then it's safe to let the scores decide again."""
    trial = copy.deepcopy(play)
    trial["manual"] = False
    compute_results(game, trial)
    _k, rows = entrants(game, play)
    _k, trows = entrants(game, trial)
    for a, b in zip(rows, trows):
        if a.get("winner") is not None and bool(a["winner"]) != bool(b.get("winner")):
            return False
        if a.get("place") is not None and (a["place"] == 1) != bool(b.get("winner")):
            return False
        # Places only matter on their own in a ranked game (elsewhere a
        # hand-set result stores 1 / 2 for won / lost).
        if game["scoring"]["win"] == "ranked" and a.get("place") is not None and a["place"] != b.get("place"):
            return False
    return True


def record_scores(ctx: ItemContext, data: dict, p: RecordScores) -> ActionOutcome:
    play = need_play(data, p.play_id, active=None)
    game = need_game(data, play["game_id"])
    kept_manual = False
    if play["status"] == "finished" and play.get("manual"):
        # A result picked by hand that agrees with the scores is released, so
        # the fix re-decides it; a real override (an instant win) is kept.
        if follows_scores(game, play):
            play["manual"] = False
        else:
            kept_manual = True
    bits = [_apply_score(data, game, play, s) for s in p.scores]
    if p.next_round:
        play["round"] = min(99, play.get("round", 0) + 1)
    if play["status"] == "finished":
        compute_results(game, play)
        if kept_manual:
            bits.append("the result was set by hand and stays as it was (use finish/edit_play to change the winner)")
    totals = {
        (r.get("name") or _pname(data, r.get("player_id", ""))): entry_total(game, r, play_categories(game, play))
        for r in entrants(game, play)[1]
    }
    return ActionOutcome(summary="; ".join(bits[:8]) + (f" (+{len(bits) - 8} more)" if len(bits) > 8 else ""), result={"totals": totals, "round": play.get("round", 0) + 1})


class FinishPlay(BaseModel):
    play_id: str | None = None
    winners: list[str] = Field(default_factory=list, description="Win/lose games, or to override the result by hand (player or team names)")
    placements: list[str] = Field(default_factory=list, description="Finishing order, first to last (ranked games)")
    coop_won: bool | None = Field(default=None, description="Co-op games: did the table win?")
    tiebreak_winner: str | None = Field(default=None, description="Who won a tie for first under the game's tiebreaker")
    duration_min: int | None = Field(default=None, ge=0, le=10_000)
    notes: str | None = Field(default=None, max_length=2000)
    unscored_ok: bool = Field(default=False, description="Finish even though some seats have no score (they stay unplaced). Only when the person confirms.")


def _apply_manual(data: dict, game: dict, play: dict, winners: list[str], placements: list[str]) -> None:
    kind, rows = entrants(game, play)
    key = "id" if kind == "teams" else "player_id"
    win = game["scoring"]["win"]

    def ref_id(ref: str) -> str:
        e, _ = _entry_for(data, game, play, ref)
        return e[key]

    if placements:
        order = [ref_id(r) for r in placements]
        for r in rows:
            r["place"] = order.index(r[key]) + 1 if r[key] in order else len(order) + 1
            r["winner"] = r["place"] == 1
        # A ranked game without scores is decided by the order anyway; with
        # scores (or any other game) a given order overrides them.
        if win != "ranked" or any(has_entries(r) for r in rows):
            play["manual"] = True
    elif winners:
        ids = {ref_id(r) for r in winners}
        for r in rows:
            r["winner"] = r[key] in ids
            r["place"] = 1 if r["winner"] else 2
        if win not in ("winlose", "teams"):
            play["manual"] = True


def _elapsed_min(play: dict, ctx: ItemContext) -> int | None:
    secs = play.get("timer_elapsed_s", 0)
    if play.get("timer_started_at"):
        try:
            secs += max(0, int((ctx.now - datetime.fromisoformat(play["timer_started_at"])).total_seconds()))
        except ValueError:
            pass
    if not secs and play.get("started_at"):
        try:
            secs = max(0, int((ctx.now - datetime.fromisoformat(play["started_at"])).total_seconds()))
        except ValueError:
            return None
    return round(secs / 60) if secs else None


def finish_play(ctx: ItemContext, data: dict, p: FinishPlay) -> ActionOutcome:
    play = need_play(data, p.play_id, active=True)
    game = need_game(data, play["game_id"])
    win = game["scoring"]["win"]
    # A reopened play is decided afresh: no stale hand-picked result, places
    # or tiebreaks from the last time it was finished.
    play["manual"] = False
    _k, rows = entrants(game, play)
    for r in rows:
        r["tiebreak"] = None
        if win not in ("winlose", "teams") and not p.placements:
            r.pop("place", None)
    if win == "coop":
        if p.coop_won is None and play.get("coop_won") is None:
            raise ActionError("Did the table win or lose? (coop_won)")
        if p.coop_won is not None:
            play["coop_won"] = p.coop_won
    _apply_manual(data, game, play, p.winners, p.placements)
    if win == "winlose" and not any(s.get("winner") for s in play["seats"]):
        raise ActionError("Who won? (winners)")
    if win == "ranked" and not p.placements and not any(s.get("place") for s in play["seats"]) and not any(
        has_entries(s) for s in play["seats"]
    ):
        raise ActionError("What was the finishing order? (placements)")
    if not play.get("manual") and not p.unscored_ok:
        missing = unscored_rows(game, play)
        if missing:
            names = ", ".join(r.get("name") or _pname(data, r.get("player_id", "")) for r in missing)
            scored = any(has_entries(r) for r in rows)
            raise ActionError(
                f"No score for {names}. Record it with record_scores, or confirm finishing without (unscored_ok=true — they stay unplaced)."
                if scored
                else "No scores recorded yet — record_scores first, or give the winners."
            )
    play["timer_elapsed_s"] = (_elapsed_min(play, ctx) or 0) * 60
    play["timer_started_at"] = None
    play["duration_min"] = p.duration_min if p.duration_min is not None else _elapsed_min(play, ctx)
    play["ended_at"] = _iso(ctx.now)
    play["status"] = "finished"
    if p.notes:
        play["notes"] = p.notes
    res = compute_results(game, play)
    if p.tiebreak_winner and res["tied"]:
        kind, _rows = entrants(game, play)
        e, _ = _entry_for(data, game, play, p.tiebreak_winner)
        break_tie(play, game, e["id"] if kind == "teams" else e["player_id"])
        res = compute_results(game, play)
    _mark_first_plays(data, play)
    text = _result_text(data, game, play)
    return ActionOutcome(
        summary=f"{game['name']}: {text}" + (" — tied for first (say who won the tiebreak, or leave it shared)" if res["tied"] else ""),
        result={"play_id": play["id"], "tied": res["tied"], "tiebreaker": game["scoring"].get("tiebreaker", ""), "standings": _standings(data, game, play)},
    )


class PlayRef(BaseModel):
    play_id: str | None = Field(default=None, description="Defaults to the one play in progress")


def discard_play(ctx: ItemContext, data: dict, p: PlayRef) -> ActionOutcome:
    play = need_play(data, p.play_id, active=True)
    data["plays"] = [x for x in data["plays"] if x["id"] != play["id"]]
    return ActionOutcome(summary=f"Discarded the {_game_name(data, play['game_id'])} in progress")


# ------------------------------------------------------------------ logging


class LogSeat(BaseModel):
    player: str = Field(description="Name or id ('me' works); new names become players")
    score: Num | None = Field(default=None, description="Final score")
    category_scores: dict[str, Num] = Field(default_factory=dict, description="Score category name → value as typed")
    place: int | None = Field(default=None, ge=1, le=100)
    winner: bool | None = None
    team: str | None = Field(default=None, description="Team name, for team games")
    faction: str = Field(default="", max_length=60)


class LogPlay(BaseModel):
    game: str = Field(description="Game id or name (a template or a new game is added if needed)")
    players: list[LogSeat] = Field(min_length=1, max_length=30, description="In seat order")
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="Default today")
    duration_min: int | None = Field(default=None, ge=0, le=10_000)
    location: str = Field(default="", max_length=80)
    notes: str = Field(default="", max_length=2000)
    expansions: list[str] = Field(default_factory=list)
    coop_won: bool | None = None
    team_scores: dict[str, Num] = Field(default_factory=dict, description="Team name → score (team games)")
    tiebreak_winner: str | None = None


def _fill_seats(data: dict, ctx: ItemContext, game: dict, play: dict, seats_in: list[LogSeat], team_scores: dict[str, Num], created: list[str]) -> None:
    cats = play_categories(game, play)
    teams: dict[str, dict] = {}
    seats = []
    seen = set()
    for ls in seats_in:
        pl = player_or_new(data, ls.player, ctx, created)
        if pl["id"] in seen:
            raise ActionError(f"{pl['name']} is listed twice.")
        seen.add(pl["id"])
        seat = {"player_id": pl["id"], "scores": {}, "rounds": [], "faction": ls.faction, "team_id": None}
        if ls.team:
            key = _norm(ls.team)
            if key not in teams:
                i = len(teams)
                teams[key] = {"id": f"t{i + 1}", "name": ls.team[:40], "color": TEAM_COLORS[i % len(TEAM_COLORS)], "scores": {}, "rounds": []}
            seat["team_id"] = teams[key]["id"]
            if ls.winner:
                teams[key]["winner"] = True
        for name, v in ls.category_scores.items():
            c = _find_cat(cats, name)
            if c is None:
                raise ActionError(f"{game['name']} has no score category {name!r} (it has: {', '.join(x['name'] for x in cats) or 'none'}).")
            seat["scores"][c["id"]] = v
        if ls.score is not None and not ls.category_scores:
            seat["total"] = ls.score
        if ls.place is not None:
            seat["place"] = ls.place
        if ls.winner is not None:
            seat["winner"] = ls.winner
        seats.append(seat)
    for name, v in team_scores.items():
        key = _norm(name)
        if key not in teams:
            raise ActionError(f"No team {name!r} among the players.")
        teams[key]["total"] = v
    play["seats"] = seats
    play["teams"] = list(teams.values())


def _decide_manual(game: dict, play: dict, seats_in: list[LogSeat]) -> None:
    """Whether a logged play's result is hand-set (``manual``): a score game
    given only placements / winners, or a stated result that disagrees with
    the scores (instant wins). A stated result the scores agree with stays
    automatic, so later score fixes re-decide it."""
    win = game["scoring"]["win"]
    has_scores = any(s.score is not None or s.category_scores for s in seats_in)
    has_places = any(s.place for s in seats_in)
    has_winners = any(s.winner for s in seats_in)
    play["manual"] = False
    if win in ("high", "low") and not has_scores and (has_places or has_winners):
        play["manual"] = True
    elif win in ("high", "low", "teams", "ranked") and has_scores and (has_places or has_winners):
        play["manual"] = not follows_scores(game, play)


def log_play(ctx: ItemContext, data: dict, p: LogPlay) -> ActionOutcome:
    created: list[str] = []
    scored = any(s.score is not None or s.category_scores for s in p.players)
    game = game_or_template(data, p.game, ctx, created, scored=scored)
    win = game["scoring"]["win"]
    play = {
        "id": _play_id(data, game["id"], ctx, json.dumps(p.model_dump(), sort_keys=True)),
        "game_id": game["id"],
        "status": "finished",
        "date": p.date or ctx.today.isoformat(),
        "duration_min": p.duration_min,
        "location": p.location or data["settings"].get("default_location", ""),
        "notes": p.notes,
        "expansions": _expansion_ids(game, p.expansions),
        "coop_won": p.coop_won,
        "ended_at": _iso(ctx.now),
        "created_at": _iso(ctx.now),
    }
    _fill_seats(data, ctx, game, play, p.players, p.team_scores, created)
    if win == "coop" and p.coop_won is None:
        if any(s.winner for s in p.players):
            play["coop_won"] = True
        elif all(s.winner is False for s in p.players):
            play["coop_won"] = False
        else:
            raise ActionError("Did the table win or lose? (coop_won)")
    if win == "winlose" and not any(s.winner for s in p.players) and not any(s.place == 1 for s in p.players):
        raise ActionError("Who won? Mark the winner(s).")
    if win == "winlose":
        for s, ls in zip(play["seats"], p.players):
            if ls.place == 1:
                s["winner"] = True
    if win == "ranked" and not any(s.place for s in p.players) and not scored:
        raise ActionError("What was the finishing order? Give each player a place.")
    if win == "teams" and not play["teams"]:
        raise ActionError(f"{game['name']} is a team game — give each player a team.")
    _decide_manual(game, play, p.players)
    if not play.get("manual"):
        for s in play["seats"]:
            if win in ("high", "low", "teams"):
                s.pop("place", None)
    data["plays"].append(play)
    res = compute_results(game, play)
    if p.tiebreak_winner and res["tied"]:
        kind, _rows = entrants(game, play)
        e, _ = _entry_for(data, game, play, p.tiebreak_winner)
        break_tie(play, game, e["id"] if kind == "teams" else e["player_id"])
        res = compute_results(game, play)
    _mark_first_plays(data, play)
    note = f" (added: {', '.join(created)})" if created else ""
    return ActionOutcome(
        summary=f"Logged {game['name']} on {play['date']}: {_result_text(data, game, play)}{note}"
        + (" — tied for first" if res["tied"] else ""),
        result={"play_id": play["id"], "tied": res["tied"], "tiebreaker": game["scoring"].get("tiebreaker", ""), "standings": _standings(data, game, play), "created": created},
    )


class EditPlay(BaseModel):
    play_id: str
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    location: str | None = Field(default=None, max_length=80)
    duration_min: int | None = Field(default=None, ge=0, le=10_000)
    notes: str | None = Field(default=None, max_length=2000)
    game: str | None = Field(default=None, description="Move the play to another game")
    expansions: list[str] | None = None
    coop_won: bool | None = None
    players: list[LogSeat] | None = Field(default=None, description="Replaces every seat and score (finished plays)")
    team_scores: dict[str, Num] | None = None
    tiebreak_winner: str | None = None


def edit_play(ctx: ItemContext, data: dict, p: EditPlay) -> ActionOutcome:
    play = need_play(data, p.play_id)
    created: list[str] = []
    if p.game:
        play["game_id"] = need_game(data, p.game)["id"]
    game = need_game(data, play["game_id"])
    for f in ("date", "location", "duration_min", "notes", "coop_won"):
        v = getattr(p, f)
        if v is not None:
            play[f] = v
    if p.expansions is not None:
        play["expansions"] = _expansion_ids(game, p.expansions)
    if p.players is not None:
        play["manual"] = False
        _fill_seats(data, ctx, game, play, p.players, p.team_scores or {}, created)
        _decide_manual(game, play, p.players)
    elif p.team_scores:
        for name, v in p.team_scores.items():
            t = next((t for t in play["teams"] if _norm(t["name"]) == _norm(name)), None)
            if t is None:
                raise ActionError(f"No team {name!r} in this play.")
            t["total"] = v
    if play["status"] == "finished":
        res = compute_results(game, play)
        if p.tiebreak_winner and res["tied"]:
            kind, _rows = entrants(game, play)
            e, _ = _entry_for(data, game, play, p.tiebreak_winner)
            break_tie(play, game, e["id"] if kind == "teams" else e["player_id"])
            compute_results(game, play)
        _mark_first_plays(data, play)
    return ActionOutcome(
        summary=f"Updated the {game['name']} play on {play['date']}" + (f": {_result_text(data, game, play)}" if play["status"] == "finished" else ""),
        result={"play_id": play["id"], "standings": _standings(data, game, play)},
    )


class DeletePlay(BaseModel):
    play_id: str


def delete_play(ctx: ItemContext, data: dict, p: DeletePlay) -> ActionOutcome:
    play = need_play(data, p.play_id)
    data["plays"] = [x for x in data["plays"] if x["id"] != play["id"]]
    return ActionOutcome(summary=f"Deleted the {_game_name(data, play['game_id'])} play on {play['date']}")


class SettingsIn(BaseModel):
    default_location: str | None = Field(default=None, max_length=80)
    elo_k: int | None = Field(default=None, ge=4, le=100)
    confetti: bool | None = None
    min_plays_for_best: int | None = Field(default=None, ge=1, le=50)


def update_settings(ctx: ItemContext, data: dict, p: SettingsIn) -> ActionOutcome:
    for f, v in p.model_dump(exclude_none=True).items():
        data["settings"][f] = v
    return ActionOutcome(summary="Settings updated")


# ------------------------------------------------------------------ read-only


class PlayerRef(BaseModel):
    player: str = Field(default="me", description="Name or id ('me' for the person)")


def player_stats(ctx: ItemContext, data: dict, p: PlayerRef) -> ActionOutcome:
    pl = need_player(data, p.player)
    st = stats.player_stats(data, pl["id"])
    st.pop("elo_history", None)
    return ActionOutcome(summary="", result=st)


class GameRef(BaseModel):
    game: str


def game_stats(ctx: ItemContext, data: dict, p: GameRef) -> ActionOutcome:
    g = need_game(data, p.game)
    return ActionOutcome(summary="", result=stats.game_stats(data, g["id"]))


class H2H(BaseModel):
    a: str = Field(description="Player name or id")
    b: str = Field(description="Player name or id")


def head_to_head(ctx: ItemContext, data: dict, p: H2H) -> ActionOutcome:
    a, b = need_player(data, p.a), need_player(data, p.b)
    r = stats.head_to_head(data, a["id"], b["id"])
    return ActionOutcome(summary="", result={"a": a["name"], "b": b["name"], **r})


class Leaderboard(BaseModel):
    game: str | None = Field(default=None, description="One game, or all games")
    metric: Literal["elo", "wins", "win_rate"] = "elo"
    min_plays: int = Field(default=1, ge=1, le=100)


def leaderboard(ctx: ItemContext, data: dict, p: Leaderboard) -> ActionOutcome:
    gid = need_game(data, p.game)["id"] if p.game else None
    return ActionOutcome(summary="", result=stats.leaderboard(data, gid, p.metric, p.min_plays))


class Overall(BaseModel):
    pass


def overall_stats(ctx: ItemContext, data: dict, p: Overall) -> ActionOutcome:
    return ActionOutcome(summary="", result=stats.overall_stats(data))


class Suggest(BaseModel):
    players: int = Field(ge=1, le=100)
    minutes: int | None = Field(default=None, ge=5, le=1000, description="Time available")
    max_weight: float | None = Field(default=None, ge=1, le=5, description="Heaviest complexity wanted (BGG 1–5)")


def suggest_game(ctx: ItemContext, data: dict, p: Suggest) -> ActionOutcome:
    rows = stats.suggest(data, p.players, p.minutes, p.max_weight, ctx.today.isoformat())
    return ActionOutcome(summary="", result={"from_library": rows, "note": "Library games that fit, favourites and least-recently-played first." if rows else "Nothing in the library fits — suggest from general knowledge."})


class FindPlays(BaseModel):
    game: str | None = None
    player: str | None = None
    since: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    until: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    limit: int = Field(default=30, ge=1, le=200)


def find_plays(ctx: ItemContext, data: dict, p: FindPlays) -> ActionOutcome:
    gid = need_game(data, p.game)["id"] if p.game else None
    pid = need_player(data, p.player)["id"] if p.player else None
    games = stats.games_by_id(data)
    rows = []
    for pl in sorted(data["plays"], key=lambda x: (x["date"], x.get("ended_at") or ""), reverse=True):
        if gid and pl["game_id"] != gid:
            continue
        if pid and not any(s["player_id"] == pid for s in pl["seats"]):
            continue
        if p.since and pl["date"] < p.since:
            continue
        if p.until and pl["date"] > p.until:
            continue
        g = games.get(pl["game_id"])
        rows.append({"play_id": pl["id"], "date": pl["date"], "status": pl["status"], "game": (g or {}).get("name", "?"), "result": _result_text(data, g, pl) if pl["status"] == "finished" else "in progress", "standings": _standings(data, g, pl), "duration_min": pl.get("duration_min"), "location": pl.get("location", "")})
        if len(rows) >= p.limit:
            break
    return ActionOutcome(summary="", result=rows)


ACTIONS = [
    ItemAction("add_players", "Add one or more players (deduplicated by name). Set me=true for the person using the app.", AddPlayers, add_players),
    ItemAction("update_player", "Rename a player or change colour, favourite, archived or the 'me' flag.", UpdatePlayer, update_player),
    ItemAction("merge_players", "Fold duplicate players into one (their plays move over) and remove the duplicates.", MergePlayers, merge_players),
    ItemAction("delete_player", "Remove a player who has no logged plays (otherwise archive or merge).", DeletePlayer, delete_player),
    ItemAction("add_game", "Add a game to the library with its full scoring setup (win condition, pad type, score categories with multipliers/penalties, bonuses, rounds, target, tiebreaker, factions, expansions). Use add_from_template when a built-in template exists.", GameIn, add_game),
    ItemAction("add_from_template", "Add games from the built-in templates (official scoring sheets for ~30 popular games plus generic sheets).", FromTemplate, add_from_template),
    ItemAction("update_game", "Change a game's details, scoring setup or expansions.", UpdateGame, update_game),
    ItemAction("delete_game", "Delete a game (and, only if explicitly confirmed, its plays).", DeleteGame, delete_game),
    ItemAction("start_play", "Start a live play on the score pad: game, players in seat order (or teams), factions, expansions. The timer starts.", StartPlay, start_play),
    ItemAction("record_scores", "Enter scores on a play in progress (or fix a finished one): per category, per round, or a total; set or add. Batch a whole round in one call.", RecordScores, record_scores),
    ItemAction("finish_play", "Finish the play in progress: works out places and winners from the game's win condition. Give winners (win/lose), placements (ranked), coop_won (co-op), tiebreak_winner for a tie.", FinishPlay, finish_play),
    ItemAction("discard_play", "Throw away a play in progress without logging it.", PlayRef, discard_play),
    ItemAction("log_play", "Log a complete, finished play in one go (\"We played Catan, I won with 10, Sam 8, Jo 7\"). Winners/places are worked out from the scores unless given.", LogPlay, log_play),
    ItemAction("edit_play", "Change a logged play: date, location, duration, notes, game, expansions, or replace the seats and scores.", EditPlay, edit_play),
    ItemAction("delete_play", "Delete a logged play (only when asked).", DeletePlay, delete_play),
    ItemAction("update_settings", "Change Game Night settings (default location, Elo K-factor, confetti, min plays for 'best player').", SettingsIn, update_settings),
    ItemAction("player_stats", "A player's record: plays, wins, win rate, average place, Elo (overall and per game), streaks, wins by game, head-to-head.", PlayerRef, player_stats, writes=False),
    ItemAction("game_stats", "A game's stats: plays, high/low/average scores, best player, average duration, seat advantage, category averages, Elo leaderboard, scores over time.", GameRef, game_stats, writes=False),
    ItemAction("head_to_head", "Two players' record against each other, overall and by game.", H2H, head_to_head, writes=False),
    ItemAction("leaderboard", "Players ranked by Elo, wins or win rate — overall or for one game.", Leaderboard, leaderboard, writes=False),
    ItemAction("overall_stats", "Collection stats: total plays and hours, H-index, most played, nickels/dimes/quarters, plays per month, unplayed games, superlatives.", Overall, overall_stats, writes=False),
    ItemAction("suggest_game", "Library games that fit a player count, time and weight (favourites and least-recently-played first).", Suggest, suggest_game, writes=False),
    ItemAction("find_plays", "Search the plays log by game, player and date range (newest first).", FindPlays, find_plays, writes=False),
    ItemAction("list_templates", "Browse the built-in game templates and their official scoring setups.", ListTemplates, list_templates, writes=False),
]
