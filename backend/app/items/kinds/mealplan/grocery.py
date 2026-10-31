"""The grocery list: built from the plan for a date range — identical
ingredients merged across recipes, amounts summed with unit
normalisation, the pantry subtracted, grouped by aisle."""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field

from app.items.kinds.mealplan import foods, units

_LOOSE_COUNTS = {"pinch", "dash", "drop", "handful", "serving", "knob", "sprig", "leaf", "slice", "piece", "scoop", "cube", "sheet"}


def slug(text: str, limit: int = 28) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:limit].strip("-") or "x"


def short_hash(*parts: object) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:6]


def aisle_of(data: dict, key: str, given: str = "", name: str = "") -> str:
    for o in data.get("aisle_overrides", []):
        if o.get("key") == key:
            return o.get("aisle") or "other"
    if given and given in foods.AISLES:
        return given
    return foods.aisle_for(name or key)


@dataclass
class _Acc:
    key: str
    names: list[str] = field(default_factory=list)
    recipes: list[str] = field(default_factory=list)
    base: dict[str, float] = field(default_factory=dict)  # "mass" / "volume" / "count:<unit>"
    spoons_only: bool = True
    some: bool = False  # a "to taste" amount
    aisle: str = ""
    notes: list[str] = field(default_factory=list)


def _dim_key(unit: str) -> str:
    d = units.dimension(unit)
    return d if d in ("mass", "volume") else f"count:{unit}"


def add_to(acc: _Acc, qty: float | None, unit: str) -> None:
    if qty is None:
        acc.some = True
        return
    dk = _dim_key(unit)
    acc.base[dk] = acc.base.get(dk, 0.0) + units.to_base(qty, unit)
    if dk == "volume" and unit not in ("tsp", "tbsp"):
        acc.spoons_only = False


def present_amounts(base: dict[str, float], system: str, spoons_only: bool, item: str = "") -> list[dict]:
    out: list[dict] = []
    for dk in sorted(base, key=lambda k: (k != "mass", k != "volume", k)):
        v = base[dk]
        if v <= 1e-9:
            continue
        if dk in ("mass", "volume"):
            q, u = units.present_base(v, dk, system, prefer_spoons=spoons_only)
        else:
            unit = dk.split(":", 1)[1]
            if unit in _LOOSE_COUNTS:
                q, u = units.present(v, unit, "keep", item)
            else:
                # You can't buy half an onion or half a can.
                q, u = float(max(1, math.ceil(v - 0.05))), unit
        out.append({"qty": q, "unit": u})
    return out[:6]


def amounts_to_base(amounts: list[dict]) -> tuple[dict[str, float], bool]:
    base: dict[str, float] = {}
    spoons = True
    for a in amounts or []:
        q, u = a.get("qty"), a.get("unit") or ""
        if q is None:
            continue
        dk = _dim_key(u)
        base[dk] = base.get(dk, 0.0) + units.to_base(q, u)
        if dk == "volume" and u not in ("tsp", "tbsp"):
            spoons = False
    return base, spoons


def amounts_text(amounts: list[dict]) -> str:
    return " + ".join(units.fmt_qty(a.get("qty"), a.get("unit") or "") for a in amounts if a.get("qty") is not None)


def pantry_key(p: dict) -> str:
    """A pantry row's grocery key — its full name (synonyms and plurals
    folded), never a loose subset: "black pepper" covers black pepper, not
    "1 pepper, diced". A staple called just "pepper" is the black kind."""
    k = foods.ingredient_key(p.get("name", ""))
    if k == "pepper" and (p.get("staple", True) or p.get("qty") is None):
        return "black pepper"
    return k


def _pantry_index(data: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for p in data.get("pantry", []):
        k = pantry_key(p)
        if k:
            out.setdefault(k, p)
    return out


def planned_cooks(data: dict, start: str, end: str) -> list[tuple[dict, dict, float]]:
    """(entry, recipe, servings to cook) for every planned recipe in the
    range — leftovers add to the cook they come from."""
    household = data.get("preferences", {}).get("household_size", 2) or 2
    recipes = {r["id"]: r for r in data.get("recipes", [])}
    entries = [e for e in data.get("plan", []) if start <= e["date"] <= end]
    extra: dict[str, float] = {}
    by_id = {e["id"]: e for e in data.get("plan", [])}
    for e in entries:
        src = e.get("leftovers_of")
        if src and src in by_id:
            extra[src] = extra.get(src, 0.0) + float(e.get("servings") or household)
    out = []
    for e in entries:
        if e.get("leftovers_of"):
            continue
        r = recipes.get(e.get("recipe_id") or "")
        if r is None:
            continue
        servings = float(e.get("servings") or household) + extra.get(e["id"], 0.0)
        out.append((e, r, servings))
    return out


def build(data: dict, start: str, end: str, *, include_optional: bool = False) -> tuple[list[dict], list[str], dict]:
    """The plan's grocery items for ``start``..``end`` (inclusive), the
    names the pantry covered, and stats."""
    system = data.get("preferences", {}).get("units", "metric")
    accs: dict[str, _Acc] = {}
    order: list[str] = []
    cooks = planned_cooks(data, start, end)
    for _e, r, servings in cooks:
        factor = servings / float(r.get("servings") or 4)
        for ing in r.get("ingredients", []):
            if ing.get("optional") and not include_optional:
                continue
            key = foods.grocery_key(ing.get("item", ""), ing.get("unit") or "", ing.get("qty"))
            if not key or key in foods.ALWAYS_HAVE:
                continue
            acc = accs.get(key)
            if acc is None:
                acc = accs[key] = _Acc(key=key)
                order.append(key)
            acc.names.append(ing.get("item", ""))
            if r["title"] not in acc.recipes:
                acc.recipes.append(r["title"])
            if not acc.aisle:
                acc.aisle = aisle_of(data, key, ing.get("aisle", ""), ing.get("item", ""))
            q = ing.get("qty")
            add_to(acc, q * factor if q is not None else None, ing.get("unit") or "")

    # "200 g milk" + "1 cup milk": fold a liquid's weight into its volume.
    for key, acc in accs.items():
        dens = foods.liquid_density(key)
        if dens and "mass" in acc.base and "volume" in acc.base:
            acc.base["volume"] += acc.base.pop("mass") / dens
            acc.spoons_only = False

    pantry = _pantry_index(data)
    covered: list[str] = []
    items: list[dict] = []
    for key in order:
        acc = accs[key]
        p = pantry.get(key)
        if p is not None:
            if p.get("staple", True) or p.get("qty") is None:
                covered.append(foods.display_name(key))
                continue
            pdk = _dim_key(p.get("unit") or "")
            dens = foods.liquid_density(key)
            if pdk == "mass" and "volume" in acc.base and "mass" not in acc.base and dens:
                # 500 g of milk in the pantry against 2 cups planned.
                acc.base["volume"] -= units.to_base(p["qty"], p.get("unit") or "") / dens
                if acc.base["volume"] <= 1e-6:
                    acc.base.pop("volume")
                if not acc.base:
                    covered.append(foods.display_name(key))
                    continue
            elif pdk == "volume" and "mass" in acc.base and "volume" not in acc.base and dens:
                acc.base["mass"] -= units.to_base(p["qty"], p.get("unit") or "") * dens
                if acc.base["mass"] <= 1e-6:
                    acc.base.pop("mass")
                if not acc.base:
                    covered.append(foods.display_name(key))
                    continue
            elif pdk in acc.base:
                acc.base[pdk] -= units.to_base(p["qty"], p.get("unit") or "")
                if acc.base[pdk] <= 1e-6:
                    acc.base.pop(pdk)
                if not acc.base and not acc.some:
                    covered.append(foods.display_name(key))
                    continue
                if not acc.base:
                    covered.append(foods.display_name(key))
                    continue
        amounts = present_amounts(acc.base, system, acc.spoons_only, key)
        unitless = len(amounts) == 1 and amounts[0]["unit"] == ""
        name = foods.display_name(key, amounts[0]["qty"] if unitless else None, unitless)
        items.append(
            {
                "id": f"g-{slug(key)}-{short_hash(key)}",
                "name": name[:200],
                "key": key,
                "amounts": amounts,
                "aisle": acc.aisle or "other",
                "checked": False,
                "source": "plan",
                "recipes": acc.recipes[:12],
                "note": "",
                "renamed": False,
                "qty_edited": False,
            }
        )
    stats = {
        "recipes": len(cooks),
        "items": len(items),
        "covered_by_pantry": len(covered),
    }
    return items, covered[:200], stats


def regenerate(data: dict, start: str, end: str, now_iso: str, *, include_optional: bool = False, keep_manual: bool = True,
               restore_removed: bool = False) -> dict:
    """Rebuild the plan-made part of the list for ``start``..``end``.

    What the person did to the old list survives: checks, renames, notes and
    edited amounts carry over by key; plan items they deleted (``removed``)
    stay off while the range is the same (``restore_removed`` brings them
    back); items added by hand are kept, merging into a plan item with the
    same name. Returns stats."""
    g = data["grocery"]
    old = g.get("items", [])
    same_range = g.get("start") == start and g.get("end") == end
    removed = set() if restore_removed or not same_range else set(g.get("removed") or [])
    prev = {i.get("key"): i for i in old if i.get("source") == "plan" and i.get("key")}
    built, covered, stats = build(data, start, end, include_optional=include_optional)
    new_items, left_off = [], []
    for i in built:
        if i["key"] in removed:
            left_off.append(i["name"])
            continue
        o = prev.get(i["key"])
        if o is not None:
            i["checked"] = bool(o.get("checked"))
            if o.get("renamed") and o.get("name"):
                i["name"], i["renamed"] = o["name"], True
            if o.get("note"):
                i["note"] = o["note"][:300]
            if o.get("qty_edited"):
                i["amounts"], i["qty_edited"] = list(o.get("amounts") or [])[:6], True
            if o.get("aisle") and o.get("aisle") != i["aisle"]:
                i["aisle"] = o["aisle"]
        new_items.append(i)
    manual = [i for i in old if i.get("source") == "manual"] if keep_manual else []
    # A manual item the plan now covers merges into the plan's one.
    by_key = {i["key"]: i for i in new_items}
    system = data.get("preferences", {}).get("units", "metric")
    kept = []
    for m in manual:
        target = by_key.get(m.get("key") or "") or by_key.get(foods.ingredient_key(m.get("name", "")))
        if target is not None and not m.get("checked") and not target.get("qty_edited"):
            base, spoons = amounts_to_base(target["amounts"] + m.get("amounts", []))
            target["amounts"] = present_amounts(base, system, spoons, target["key"]) or target["amounts"]
            if m.get("note") and not target.get("note"):
                target["note"] = m["note"][:300]
            continue
        kept.append(m)
    data["grocery"] = {
        "items": (new_items + kept)[:600],
        "start": start,
        "end": end,
        "generated_at": now_iso,
        "covered": covered,
        "removed": sorted(removed)[:400],
    }
    stats["left_off"] = left_off
    return stats


def manual_key(name: str) -> str:
    """A hand-added item's key (the frontend's ``manualKey`` mirrors it)."""
    return foods.ingredient_key(name) or " ".join(foods.normalize(name).split())[:80] or name.lower()[:80]


def add_manual(data: dict, name: str, qty: float | None, unit: str, aisle: str = "", note: str = "", ident: str = "") -> tuple[dict, bool]:
    """Add one item by hand, merging into an unchecked item with the same
    name. Returns (item, merged)."""
    system = data.get("preferences", {}).get("units", "metric")
    key = manual_key(name)
    items = data["grocery"]["items"]
    for i in items:
        if (i.get("key") or foods.ingredient_key(i["name"])) == key and not i.get("checked"):
            if qty is not None:
                base, spoons = amounts_to_base([*i.get("amounts", []), {"qty": qty, "unit": unit}])
                i["amounts"] = present_amounts(base, system, spoons, key)
                if i.get("source") == "plan":
                    i["qty_edited"] = True  # "Update from plan" keeps what was added
            if note:
                i["note"] = note[:300]
            if aisle and aisle in foods.AISLES:
                i["aisle"] = aisle
            return i, True
    if len(items) >= 600:
        raise ValueError("the grocery list is full (600 items) — clear checked items first")
    amounts = []
    if qty is not None:
        q, u = units.present(qty, unit, "keep", key)
        amounts = [{"qty": q, "unit": u}]
    clean = " ".join(name.split())[:200]
    item = {
        "id": ident or f"m-{slug(key)}-{short_hash(key, len(items))}",
        "name": clean[:1].upper() + clean[1:],
        "key": key,
        "amounts": amounts,
        "aisle": aisle if aisle in foods.AISLES else aisle_of(data, key, "", clean),
        "checked": False,
        "source": "manual",
        "recipes": [],
        "note": note[:300],
        "renamed": False,
        "qty_edited": False,
    }
    existing = {i["id"] for i in items}
    n = 2
    base_id = item["id"]
    while item["id"] in existing:
        item["id"] = f"{base_id[:34]}-{n}"
        n += 1
    items.append(item)
    return item, False
