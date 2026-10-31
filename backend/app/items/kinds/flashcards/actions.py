"""The AI's (and the UI's) hands. Deterministic for (data, args, ctx.now):
new ids come from a hash of the inputs and ``ctx.now``, never randomness.
Reviews themselves are saved by the Study tab (``item.update``), not here.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from app.items.spec import ActionError, ActionOutcome, ItemAction, ItemContext

from . import fsrs, importer, study
from .cloze import ClozeError, review_keys, validate_cloze
from .models import MAX_CARDS, MAX_DECKS, Settings

CardType = Literal["basic", "reversed", "cloze", "typein"]
PALETTE = ["#5B6DD9", "#E2725B", "#4E9F5B", "#D9902F", "#7B6CD9", "#2C9CC8", "#C2557A", "#2F8F83"]


def cfg_of(ctx: ItemContext, data: dict) -> fsrs.Config:
    return fsrs.config_from(data.get("settings") or {}, ctx.tz)


def _now(ctx: ItemContext) -> str:
    return fsrs.iso(ctx.now)


def _hash(*parts: object) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "deck"


def _card_by_id(data: dict) -> dict[str, dict]:
    return {c["id"]: c for c in data["cards"]}


def _pick(data: dict, ids: list[str]) -> list[dict]:
    by = _card_by_id(data)
    found = [by[i] for i in dict.fromkeys(ids) if i in by]
    if not found:
        raise ActionError("None of those card ids exist — use find_cards to get ids.")
    return found


def ensure_deck(ctx: ItemContext, data: dict, path: str, *, description: str = "", color: str | None = None) -> tuple[dict, bool]:
    """The deck at "A::B::C", creating missing levels. (deck, created?)."""
    parts = [p.strip() for p in (path or "").split("::") if p.strip()]
    if not parts:
        raise ActionError("A deck needs a name.")
    if any(len(p) > 120 for p in parts):
        raise ActionError("Deck names are at most 120 characters per level.")
    parent: str | None = None
    deck: dict | None = None
    created = False
    for depth, name in enumerate(parts):
        deck = next(
            (d for d in data["decks"] if d.get("parent_id") == parent and d["name"].lower() == name.lower()), None
        )
        if deck is None:
            if len(data["decks"]) >= MAX_DECKS:
                raise ActionError(f"A file holds at most {MAX_DECKS} decks.")
            base = _slug(name)
            did, n = base, 2
            ids = {d["id"] for d in data["decks"]}
            while did in ids:
                did, n = f"{base}-{n}", n + 1
            last = depth == len(parts) - 1
            deck = {
                "id": did, "name": name, "parent_id": parent,
                "description": description if last else "",
                "color": (color if last and color else None) or PALETTE[len(data["decks"]) % len(PALETTE)],
                "created": _now(ctx),
            }
            data["decks"].append(deck)
            created = True
        parent = deck["id"]
    assert deck is not None
    return deck, created


def _deck_ref(data: dict, ref: str) -> dict:
    d = study.find_deck(data, ref)
    if d is None:
        names = ", ".join(sorted(study.deck_paths(data).values())[:30])
        raise ActionError(f"No deck {ref!r}. Decks: {names or 'none yet'}.")
    return d


class NewCard(BaseModel):
    type: CardType = Field(default="basic", description="basic; reversed (also asks back→front); cloze (front holds {{c1::…}} deletions); typein (type the answer)")
    front: str = Field(min_length=1, max_length=8000, description="The prompt (Markdown, $math$). For cloze: the full sentence with {{c1::answer}} or {{c1::answer::hint}}")
    back: str = Field(default="", max_length=8000, description="The answer (for cloze: optional extra shown after)")
    note: str = Field(default="", max_length=4000, description="Optional: source, mnemonic or explanation shown after answering")
    tags: list[str] = Field(default_factory=list, max_length=30)


def _check_card(c: NewCard | dict) -> None:
    t = c.type if isinstance(c, NewCard) else c["type"]
    front = c.front if isinstance(c, NewCard) else c["front"]
    back = c.back if isinstance(c, NewCard) else c.get("back", "")
    if t == "cloze":
        try:
            validate_cloze(front)
        except ClozeError as e:
            raise ActionError(f"{e} (card: {front[:80]!r})") from e
    elif not (back or "").strip():
        raise ActionError(f"A {t} card needs a back (card: {front[:80]!r}).")
    elif re.search(r"\{\{c\d+::", front):
        raise ActionError(f"That front has cloze deletions — use type \"cloze\" (card: {front[:80]!r}).")


def _new_card(ctx: ItemContext, data: dict, deck_id: str, c: dict, salt: object, used: set[str]) -> dict:
    h = _hash(_now(ctx), deck_id, c["front"], c.get("back", ""), salt)
    cid, n = f"k{h[:8]}", 0
    while cid in used:
        n += 1
        cid = f"k{h[:8]}{n}"
    used.add(cid)
    return {
        "id": cid, "deck_id": deck_id, "type": c["type"], "front": c["front"].strip(), "back": (c.get("back") or "").strip(),
        "note": (c.get("note") or "").strip(), "tags": list(c.get("tags") or []), "flagged": False, "suspended": False,
        "buried_until": None, "created": _now(ctx), "modified": _now(ctx),
        "srs": [fsrs.new_srs(k) for k in review_keys(c["type"], c["front"])],
    }


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


# ------------------------------------------------------------------ decks


class CreateDeck(BaseModel):
    name: str = Field(min_length=1, max_length=400, description='Deck name; nest with "::" e.g. "Biology::Cells"')
    description: str = Field(default="", max_length=2000)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


def create_deck(ctx: ItemContext, data: dict, p: CreateDeck) -> ActionOutcome:
    deck, created = ensure_deck(ctx, data, p.name, description=p.description, color=p.color)
    path = study.deck_paths(data)[deck["id"]]
    if not created:
        return ActionOutcome(summary=f"“{path}” already exists", result={"deck_id": deck["id"], "existed": True})
    return ActionOutcome(summary=f"Created the deck “{path}”", result={"deck_id": deck["id"], "path": path})


class EditDeck(BaseModel):
    deck: str = Field(description="Deck id or path")
    name: str | None = Field(default=None, max_length=120, description="New name for this level (no ::)")
    parent: str | None = Field(default=None, description='Move under this deck (id or path); "" = top level')
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    new_per_day: int | None = Field(default=None, ge=0, le=9999, description="This deck's own new-card limit a day (covers its subdecks)")
    max_reviews_per_day: int | None = Field(default=None, ge=0, le=99_999, description="This deck's own review limit a day (covers its subdecks)")
    clear_limits: bool = Field(default=False, description="Remove the deck's own limits (only the file-wide ones apply)")


def edit_deck(ctx: ItemContext, data: dict, p: EditDeck) -> ActionOutcome:
    d = _deck_ref(data, p.deck)
    if p.name is not None:
        if "::" in p.name or not p.name.strip():
            raise ActionError("Give one level's name (no ::) — use parent to move it.")
        d["name"] = p.name.strip()
    if p.parent is not None:
        if p.parent == "":
            d["parent_id"] = None
        else:
            target = _deck_ref(data, p.parent)
            if target["id"] in study.subtree(data, d["id"]):
                raise ActionError("A deck can't go inside itself.")
            d["parent_id"] = target["id"]
    if p.description is not None:
        d["description"] = p.description
    if p.color is not None:
        d["color"] = p.color
    if p.clear_limits:
        d["new_per_day"] = None
        d["max_reviews_per_day"] = None
    if p.new_per_day is not None:
        d["new_per_day"] = p.new_per_day
    if p.max_reviews_per_day is not None:
        d["max_reviews_per_day"] = p.max_reviews_per_day
    return ActionOutcome(summary=f"Updated “{study.deck_paths(data)[d['id']]}”")


class DeleteDeck(BaseModel):
    deck: str = Field(description="Deck id or path")
    cards: Literal["refuse", "delete", "move_to_parent"] = Field(
        default="refuse", description="What to do with its cards (and subdecks' cards): refuse if any, delete them, or move them up"
    )


def delete_deck(ctx: ItemContext, data: dict, p: DeleteDeck) -> ActionOutcome:
    d = _deck_ref(data, p.deck)
    ids = study.subtree(data, d["id"])
    path = study.deck_paths(data)[d["id"]]
    inside = [c for c in data["cards"] if c["deck_id"] in ids]
    if inside and p.cards == "refuse":
        raise ActionError(f"“{path}” holds {len(inside)} cards — say whether to delete them or move them to the parent deck.")
    if p.cards == "move_to_parent" and inside:
        target = d.get("parent_id")
        if target is None:
            others = [x for x in data["decks"] if x["id"] not in ids]
            if not others:
                raise ActionError("It's the only deck — there's nowhere to move its cards.")
            target = others[0]["id"]
        for c in inside:
            c["deck_id"] = target
    elif p.cards == "delete":
        gone = {c["id"] for c in inside}
        data["cards"] = [c for c in data["cards"] if c["id"] not in gone]
    data["decks"] = [x for x in data["decks"] if x["id"] not in ids]
    return ActionOutcome(summary=f"Deleted “{path}”" + (f" ({len(inside)} cards {'deleted' if p.cards == 'delete' else 'moved'})" if inside else ""))


# ------------------------------------------------------------------ cards


class AddCards(BaseModel):
    deck: str = Field(description='Deck id or path ("Spanish::Verbs"); a path that doesn\'t exist is created')
    cards: list[NewCard] = Field(min_length=1, max_length=500)
    skip_duplicates: bool = Field(default=True, description="Skip cards whose front already exists in that deck")


def add_cards(ctx: ItemContext, data: dict, p: AddCards) -> ActionOutcome:
    for c in p.cards:
        _check_card(c)
    deck = study.find_deck(data, p.deck)
    if deck is None:
        deck, _ = ensure_deck(ctx, data, p.deck)
    if len(data["cards"]) + len(p.cards) > MAX_CARDS:
        raise ActionError(f"A file holds at most {MAX_CARDS} cards — start another flashcards file.")
    existing = {_norm(c["front"]) for c in data["cards"] if c["deck_id"] == deck["id"]}
    used = {c["id"] for c in data["cards"]}
    added, skipped = [], 0
    for i, c in enumerate(p.cards):
        key = _norm(c.front)
        if p.skip_duplicates and key in existing:
            skipped += 1
            continue
        existing.add(key)
        card = _new_card(ctx, data, deck["id"], c.model_dump(), i, used)
        data["cards"].append(card)
        added.append(card["id"])
    path = study.deck_paths(data)[deck["id"]]
    items = sum(len(review_keys(c.type, c.front)) for c in p.cards)
    msg = f"Added {len(added)} card{'s' if len(added) != 1 else ''} to “{path}”"
    if skipped:
        msg += f" ({skipped} duplicate{'s' if skipped != 1 else ''} skipped)"
    return ActionOutcome(summary=msg, result={"deck_id": deck["id"], "card_ids": added, "skipped": skipped, "review_items": items})


class EditCard(BaseModel):
    card_id: str
    type: CardType | None = None
    front: str | None = Field(default=None, max_length=8000)
    back: str | None = Field(default=None, max_length=8000)
    note: str | None = Field(default=None, max_length=4000)
    tags: list[str] | None = Field(default=None, max_length=30, description="Replaces the tags")
    deck: str | None = Field(default=None, description="Move to this deck (id or path)")


def edit_card(ctx: ItemContext, data: dict, p: EditCard) -> ActionOutcome:
    card = _pick(data, [p.card_id])[0]
    nxt = {**card}
    for f in ("type", "front", "back", "note", "tags"):
        v = getattr(p, f)
        if v is not None:
            nxt[f] = v
    _check_card(nxt)
    if p.deck is not None:
        nxt["deck_id"] = _deck_ref(data, p.deck)["id"]
    keys = review_keys(nxt["type"], nxt["front"])
    have = {s["k"]: s for s in card.get("srs", [])}
    nxt["srs"] = [have.get(k) or fsrs.new_srs(k) for k in keys]
    nxt["modified"] = _now(ctx)
    card.clear()
    card.update(nxt)
    return ActionOutcome(summary=f"Edited “{study.one_line(card['front'], 60)}”")


class CardIds(BaseModel):
    card_ids: list[str] = Field(min_length=1, max_length=5000)


def delete_cards(ctx: ItemContext, data: dict, p: CardIds) -> ActionOutcome:
    gone = {c["id"] for c in _pick(data, p.card_ids)}
    data["cards"] = [c for c in data["cards"] if c["id"] not in gone]
    data["review_log"] = [e for e in data.get("review_log", []) if e["c"] not in gone]
    return ActionOutcome(summary=f"Deleted {len(gone)} card{'s' if len(gone) != 1 else ''}")


class Suspend(CardIds):
    suspend: bool = Field(default=True, description="False unsuspends")


def suspend_cards(ctx: ItemContext, data: dict, p: Suspend) -> ActionOutcome:
    cards = _pick(data, p.card_ids)
    for c in cards:
        c["suspended"] = p.suspend
        c["modified"] = _now(ctx)
    return ActionOutcome(summary=f"{'Suspended' if p.suspend else 'Unsuspended'} {len(cards)} card{'s' if len(cards) != 1 else ''}")


class Unsuspend(CardIds):
    pass


def unsuspend_cards(ctx: ItemContext, data: dict, p: Unsuspend) -> ActionOutcome:
    return suspend_cards(ctx, data, Suspend(card_ids=p.card_ids, suspend=False))


class Flag(CardIds):
    flagged: bool = True


def flag_cards(ctx: ItemContext, data: dict, p: Flag) -> ActionOutcome:
    cards = _pick(data, p.card_ids)
    for c in cards:
        c["flagged"] = p.flagged
    return ActionOutcome(summary=f"{'Flagged' if p.flagged else 'Unflagged'} {len(cards)} card{'s' if len(cards) != 1 else ''}")


class Bury(CardIds):
    bury: bool = Field(default=True, description="Hide until tomorrow; False brings them back today")


def bury_cards(ctx: ItemContext, data: dict, p: Bury) -> ActionOutcome:
    cards = _pick(data, p.card_ids)
    cfg = cfg_of(ctx, data)
    tomorrow = date.fromordinal(fsrs.day_index(ctx.now, cfg) + 1).isoformat()
    for c in cards:
        c["buried_until"] = tomorrow if p.bury else None
    return ActionOutcome(summary=f"{'Buried' if p.bury else 'Unburied'} {len(cards)} card{'s' if len(cards) != 1 else ''}")


class MoveCards(CardIds):
    deck: str = Field(description="Target deck id or path (created if it's a new path)")


def move_cards(ctx: ItemContext, data: dict, p: MoveCards) -> ActionOutcome:
    cards = _pick(data, p.card_ids)
    deck = study.find_deck(data, p.deck) or ensure_deck(ctx, data, p.deck)[0]
    for c in cards:
        c["deck_id"] = deck["id"]
        c["modified"] = _now(ctx)
    return ActionOutcome(summary=f"Moved {len(cards)} card{'s' if len(cards) != 1 else ''} to “{study.deck_paths(data)[deck['id']]}”")


class TagCards(CardIds):
    add: list[str] = Field(default_factory=list, max_length=20)
    remove: list[str] = Field(default_factory=list, max_length=20)


def tag_cards(ctx: ItemContext, data: dict, p: TagCards) -> ActionOutcome:
    if not p.add and not p.remove:
        raise ActionError("Say which tags to add or remove.")
    cards = _pick(data, p.card_ids)
    add = ["".join(t.split()) for t in p.add if t.strip()]
    rem = {t.strip().lower() for t in p.remove}
    for c in cards:
        tags = [t for t in c.get("tags", []) if t.lower() not in rem]
        for t in add:
            if t.lower() not in (x.lower() for x in tags):
                tags.append(t)
        c["tags"] = tags[:30]
        c["modified"] = _now(ctx)
    bits = ([f"+{', '.join(add)}"] if add else []) + ([f"−{', '.join(p.remove)}"] if p.remove else [])
    return ActionOutcome(summary=f"Tagged {len(cards)} card{'s' if len(cards) != 1 else ''} ({'; '.join(bits)})")


class ResetCards(CardIds):
    keep_history: bool = Field(default=True, description="Keep their past reviews in the log (stats)")


def reset_cards(ctx: ItemContext, data: dict, p: ResetCards) -> ActionOutcome:
    cards = _pick(data, p.card_ids)
    ids = {c["id"] for c in cards}
    for c in cards:
        c["srs"] = [fsrs.new_srs(s["k"]) for s in c.get("srs", [])]
        c["buried_until"] = None
    if not p.keep_history:
        data["review_log"] = [e for e in data.get("review_log", []) if e["c"] not in ids]
    return ActionOutcome(summary=f"Reset {len(cards)} card{'s' if len(cards) != 1 else ''} to new")


class SetSettings(BaseModel):
    desired_retention: float | None = Field(default=None, ge=0.7, le=0.99, description="Target recall when a card comes due (0.9 = 90%). Higher = more reviews")
    new_per_day: int | None = Field(default=None, ge=0, le=9999)
    max_reviews_per_day: int | None = Field(default=None, ge=0, le=99_999)
    learning_steps: list[float] | None = Field(default=None, max_length=10, description="Minutes, e.g. [1, 10]")
    relearning_steps: list[float] | None = Field(default=None, max_length=10, description="Minutes, e.g. [10]")
    maximum_interval: int | None = Field(default=None, ge=1, le=36500, description="Days")
    fuzz: bool | None = None
    rollover_hour: int | None = Field(default=None, ge=0, le=23, description="Hour the study day starts (4 = 4 am)")
    new_mix: Literal["mixed", "before", "after"] | None = None
    bury_siblings: bool | None = None
    leech_threshold: int | None = Field(default=None, ge=2, le=100)
    leech_action: Literal["tag", "suspend"] | None = None
    show_intervals: bool | None = None
    reminder_enabled: bool | None = None
    reminder_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="HH:MM local")
    streak_nudge: bool | None = None
    streak_nudge_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    exam_date: str | None = Field(default=None, description='YYYY-MM-DD, or "" to clear')


def set_settings(ctx: ItemContext, data: dict, p: SetSettings) -> ActionOutcome:
    changes = p.model_dump(exclude_none=True)
    if not changes:
        raise ActionError("Nothing to change.")
    if "exam_date" in changes:
        if changes["exam_date"] == "":
            changes["exam_date"] = None
        else:
            try:
                date.fromisoformat(changes["exam_date"])
            except ValueError as e:
                raise ActionError("exam_date must be YYYY-MM-DD.") from e
    merged = {**data.get("settings", {}), **changes}
    try:
        data["settings"] = Settings.model_validate(merged).model_dump(mode="json")
    except Exception as e:  # noqa: BLE001 — pydantic's message back to the model
        raise ActionError(f"Those settings aren't valid: {e}") from e
    return ActionOutcome(summary="Updated settings: " + ", ".join(k.replace("_", " ") for k in changes))


class ImportCards(BaseModel):
    text: str = Field(min_length=1, max_length=2_000_000, description="The exported text")
    format: importer.Format = "auto"
    deck: str = Field(default="Imported", description="Deck for cards without their own deck column")
    term_sep: str | None = Field(default=None, description='Quizlet: between term and definition — "tab", "comma" or the characters')
    card_sep: str | None = Field(default=None, description='Quizlet: between cards — "newline", "semicolon" or the characters')
    tags: list[str] = Field(default_factory=list, max_length=10, description="Tags added to every imported card")
    dry_run: bool = Field(default=False, description="Only parse and return a preview")


def import_cards(ctx: ItemContext, data: dict, p: ImportCards) -> ActionOutcome:
    cards, skipped, fmt = importer.parse(p.text, p.format, p.term_sep, p.card_sep)
    if not cards:
        raise ActionError("No cards found in that text — check the format and separators.")
    if p.dry_run:
        return ActionOutcome(
            summary="", result={"format": fmt, "count": len(cards), "skipped": skipped, "preview": cards[:20]}
        )
    if len(data["cards"]) + len(cards) > MAX_CARDS:
        raise ActionError(f"That's more than one file holds ({MAX_CARDS} cards).")
    default = study.find_deck(data, p.deck) or ensure_deck(ctx, data, p.deck)[0]
    used = {c["id"] for c in data["cards"]}
    existing: dict[str, set[str]] = {}
    for c in data["cards"]:
        existing.setdefault(c["deck_id"], set()).add(_norm(c["front"]))
    added = dup = bad = 0
    for i, c in enumerate(cards):
        deck = default
        if c.get("deck"):
            deck = study.find_deck(data, c["deck"]) or ensure_deck(ctx, data, c["deck"])[0]
        if c["type"] == "cloze":
            try:
                validate_cloze(c["front"])
            except ClozeError:
                bad += 1
                continue
        key = _norm(c["front"])
        seen = existing.setdefault(deck["id"], set())
        if key in seen:
            dup += 1
            continue
        seen.add(key)
        c["tags"] = list(dict.fromkeys([*c.get("tags", []), *p.tags]))
        data["cards"].append(_new_card(ctx, data, deck["id"], c, f"imp{i}", used))
        added += 1
    msg = f"Imported {added} card{'s' if added != 1 else ''} ({fmt})"
    extra = [f"{dup} duplicates skipped"] if dup else []
    if skipped + bad:
        extra.append(f"{skipped + bad} rows unreadable")
    if extra:
        msg += " — " + ", ".join(extra)
    return ActionOutcome(summary=msg, result={"added": added, "duplicates": dup, "unreadable": skipped + bad, "format": fmt})


# -------------------------------------------------------------- read-only


class NoArgs(BaseModel):
    pass


def due_summary(ctx: ItemContext, data: dict, p: NoArgs) -> ActionOutcome:
    cfg = cfg_of(ctx, data)
    paths = study.deck_paths(data)
    per = []
    for d in sorted(data["decks"], key=lambda d: paths.get(d["id"], "")):
        c = study.counts(data, ctx.now, cfg, study.subtree(data, d["id"]))
        per.append({"deck_id": d["id"], "deck": paths[d["id"]], **{k: c[k] for k in ("learning", "review", "new", "learning_later")}})
    total = study.counts(data, ctx.now, cfg)
    n, studied = study.streak(data, ctx.now, cfg)
    return ActionOutcome(
        summary="",
        result={"study_day": fsrs.study_date(ctx.now, cfg), "total": total, "decks": per, "streak_days": n, "studied_today": studied,
                "note": "Per-deck new counts each apply the daily new limit; the total is what one session holds."},
    )


class DeckArg(BaseModel):
    deck: str | None = Field(default=None, description="Deck id or path (with subdecks); omit for all")


def _deck_ids(data: dict, ref: str | None) -> set[str] | None:
    return None if not ref else study.subtree(data, _deck_ref(data, ref)["id"])


def deck_stats(ctx: ItemContext, data: dict, p: DeckArg) -> ActionOutcome:
    cfg = cfg_of(ctx, data)
    ids = _deck_ids(data, p.deck)
    out = study.deck_stats(data, ctx.now, cfg, ids)
    out["streak_days"] = study.streak(data, ctx.now, cfg)[0]
    return ActionOutcome(summary="", result=out)


class FindCards(BaseModel):
    query: str = Field(default="", max_length=400, description='Words, tag:x, deck:"A::B", is:new|learning|review|due|suspended|flagged|buried|leech, type:cloze, -negation')
    sort: Literal["created", "lapses", "due", "difficulty"] = Field(default="created", description="lapses/difficulty = weakest first")
    limit: int = Field(default=50, ge=1, le=500)


def _card_row(c: dict, paths: dict[str, str], now, cfg) -> dict:  # noqa: ANN001
    items = []
    for s in c.get("srs", []):
        r = fsrs.current_retrievability(s, now, cfg)
        items.append({
            "k": s["k"], "state": s["state"], "due": (s.get("due") or "")[:16] or None,
            "stability_days": round(s["stability"], 1) if s.get("stability") else None,
            "difficulty": round(s["difficulty"], 1) if s.get("difficulty") else None,
            "recall_now": round(r, 2) if r is not None else None, "reps": s.get("reps", 0), "lapses": s.get("lapses", 0),
        })
    return {
        "id": c["id"], "deck": paths.get(c["deck_id"], ""), "type": c["type"], "front": c["front"][:600], "back": c["back"][:600],
        "note": c.get("note", "")[:300], "tags": c.get("tags", []), "flagged": c.get("flagged", False),
        "suspended": c.get("suspended", False), "items": items,
    }


def find_cards(ctx: ItemContext, data: dict, p: FindCards) -> ActionOutcome:
    cfg = cfg_of(ctx, data)
    paths = study.deck_paths(data)
    hits = [c for c in data["cards"] if study.matches(c, p.query, data, ctx.now, cfg, paths)]
    if p.sort == "lapses":
        hits.sort(key=lambda c: -max((s.get("lapses", 0) for s in c["srs"]), default=0))
    elif p.sort == "difficulty":
        hits.sort(key=lambda c: -max((s.get("difficulty") or 0 for s in c["srs"]), default=0))
    elif p.sort == "due":
        hits.sort(key=lambda c: min((s.get("due") or "9999" for s in c["srs"]), default="9999"))
    else:
        hits.sort(key=lambda c: c.get("created", ""), reverse=True)
    return ActionOutcome(
        summary="", result={"total": len(hits), "cards": [_card_row(c, paths, ctx.now, cfg) for c in hits[: p.limit]]}
    )


class Forecast(BaseModel):
    days: int = Field(default=30, ge=1, le=365)
    deck: str | None = Field(default=None, description="Deck id or path; omit for all")
    exam_date: str | None = Field(default=None, description="YYYY-MM-DD: add readiness numbers for this exam (defaults to the saved exam date)")


def study_forecast(ctx: ItemContext, data: dict, p: Forecast) -> ActionOutcome:
    cfg = cfg_of(ctx, data)
    ids = _deck_ids(data, p.deck)
    fc = study.forecast(data, ctx.now, cfg, p.days, ids)
    out: dict = {"forecast": fc, "total_due_in_period": sum(x["due"] for x in fc), "today": study.counts(data, ctx.now, cfg, ids)}
    exam = p.exam_date or (data.get("settings") or {}).get("exam_date")
    if exam:
        try:
            out["exam"] = study.exam_plan(data, ctx.now, cfg, date.fromisoformat(exam), ids)
        except ValueError as e:
            raise ActionError("exam_date must be YYYY-MM-DD.") from e
    return ActionOutcome(summary="", result=out)


class CardDetails(BaseModel):
    card_ids: list[str] = Field(min_length=1, max_length=20)


def card_details(ctx: ItemContext, data: dict, p: CardDetails) -> ActionOutcome:
    cfg = cfg_of(ctx, data)
    paths = study.deck_paths(data)
    cards = _pick(data, p.card_ids)
    ids = {c["id"] for c in cards}
    hist: dict[str, list] = {}
    for e in data.get("review_log", []):
        if e["c"] in ids:
            hist.setdefault(e["c"], []).append(
                {"t": e["t"][:16], "k": e["k"], "rating": ["", "again", "hard", "good", "easy"][e["r"]], "interval_days": e["i"]}
            )
    rows = []
    for c in cards:
        row = _card_row(c, paths, ctx.now, cfg)
        row.update(front=c["front"], back=c["back"], note=c.get("note", ""), history=hist.get(c["id"], [])[-30:])
        rows.append(row)
    return ActionOutcome(summary="", result={"cards": rows})


ACTIONS = [
    ItemAction("create_deck", "Create a deck (nest with \"A::B\"). Returns its id; an existing path is returned as is.", CreateDeck, create_deck),
    ItemAction("edit_deck", "Rename a deck, move it under another, change its description or colour, or set / clear its own daily limits (Anki-style).", EditDeck, edit_deck),
    ItemAction("delete_deck", "Delete a deck and its subdecks; say what happens to their cards.", DeleteDeck, delete_deck),
    ItemAction(
        "add_cards",
        "Add a batch of cards (up to 500) to a deck — THE way to create cards. Validates cloze syntax and skips duplicate fronts. "
        "Make each card atomic (one fact).",
        AddCards, add_cards,
    ),
    ItemAction("edit_card", "Rewrite one card's text, type, tags or deck. Scheduling is kept for review items that still exist.", EditCard, edit_card),
    ItemAction("delete_cards", "Delete cards (and their review history) by id.", CardIds, delete_cards),
    ItemAction("suspend_cards", "Suspend cards (they stop coming up) — or unsuspend with suspend=false.", Suspend, suspend_cards),
    ItemAction("unsuspend_cards", "Unsuspend cards so they come up again.", Unsuspend, unsuspend_cards),
    ItemAction("flag_cards", "Flag (or unflag) cards to look at later.", Flag, flag_cards),
    ItemAction("bury_cards", "Hide cards until tomorrow's study day (or unbury).", Bury, bury_cards),
    ItemAction("move_cards", "Move cards to another deck.", MoveCards, move_cards),
    ItemAction("tag_cards", "Add and/or remove tags on cards.", TagCards, tag_cards),
    ItemAction("reset_cards", "Forget cards: back to new, scheduling wiped (history kept unless keep_history=false). Ask first.", ResetCards, reset_cards),
    ItemAction("set_settings", "Change study settings: desired retention, daily limits, steps, max interval, fuzz, day rollover, reminders, exam date.", SetSettings, set_settings),
    ItemAction("import_cards", "Import cards from CSV/TSV, Quizlet export text or Anki plain-text export (dry_run to preview).", ImportCards, import_cards),
    ItemAction("due_summary", "What's due today, per deck and in total (learning / review / new after daily limits), and the streak.", NoArgs, due_summary, writes=False),
    ItemAction("deck_stats", "Stats for a deck or everything: card states, mature items, average recall now, true retention vs target, reviews and minutes in 30 days, the hardest cards.", DeckArg, deck_stats, writes=False),
    ItemAction("find_cards", "Search cards (ids, text, tags, scheduling: state, due, stability, difficulty, recall now, lapses). Sort by lapses to find weak cards.", FindCards, find_cards, writes=False),
    ItemAction("card_details", "Full text, scheduling and review history of up to 20 cards.", CardDetails, card_details, writes=False),
    ItemAction("study_forecast", "Reviews due on each coming day, and exam readiness (unseen items, items below target on the exam day, new cards a day needed).", Forecast, study_forecast, writes=False),
]

__all__ = ["ACTIONS", "cfg_of", "ensure_deck"]
