"""A sheet's live state (its ``sheet:<id>`` Yjs room), read on the server.

Editors share a sheet through a Y.Doc (``useSheetCollab.ts``):

* ``cells``  — one entry per non-empty cell, keyed ``<tab>!<r>,<c>`` → the
  Fortune cell object (``{v, m, ct, …}``); a tab without an id is ``#<index>``;
* ``struct`` — the structure (``lib/sheetStructure.ts``): ``<tab>|tab`` →
  ``{name, order, color, hide}`` and finer keys for merges, widths, …;
* ``meta``   — ``seeded`` (cells were loaded into the room once) and
  ``structSeeded``.

``spreadsheets.data`` (the Fortune workbook JSON that export, search and RAG
read) is only written by an editor's autosave. A change made in the room
while no editor has it open — a form answer arriving (Forms WP-F1.5) —
never reaches it that way, so :func:`data_from_state` rebuilds the workbook
JSON from the stored state: each tab's cells become the room's, tabs added in
the room are added, and tabs the room's structure no longer has are dropped,
just as an editor joining the room would show it.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SheetState:
    cells: dict[str, Any] = field(default_factory=dict)
    struct: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def seeded(self) -> bool:
        """Cells live in the room (not only in the workbook JSON)."""
        return self.meta.get("seeded") is True or bool(self.cells)

    @property
    def struct_seeded(self) -> bool:
        return self.meta.get("structSeeded") is True or bool(self.struct)

    def tabs(self) -> dict[str, dict[str, Any]]:
        """``{tab id: {name, order, …}}`` from the shared structure."""
        out: dict[str, dict[str, Any]] = {}
        for k, v in self.struct.items():
            parts = k.split("|")
            if len(parts) == 2 and parts[1] == "tab" and isinstance(v, dict):
                out[parts[0]] = v
        return out

    def tab_cells(self, tab: str) -> dict[tuple[int, int], Any]:
        """``{(r, c): cell}`` of one tab."""
        out: dict[tuple[int, int], Any] = {}
        prefix = f"{tab}!"
        for k, v in self.cells.items():
            if not k.startswith(prefix) or v is None:
                continue
            pos = parse_pos(k[len(prefix):])
            if pos is not None:
                out[pos] = v
        return out


def parse_pos(s: str) -> tuple[int, int] | None:
    try:
        r, c = s.split(",")
        ri, ci = int(r), int(c)
    except (ValueError, TypeError):
        return None
    return (ri, ci) if ri >= 0 and ci >= 0 else None


def read_state(state: bytes | None) -> SheetState:
    """The room's three maps, as plain Python."""
    if not state:
        return SheetState()
    from pycrdt import Doc, Map

    doc = Doc()
    doc.apply_update(bytes(state))

    def plain(name: str) -> dict[str, Any]:
        m = doc.get(name, type=Map)
        out: dict[str, Any] = {}
        for k, v in m.items():
            out[str(k)] = v.to_py() if hasattr(v, "to_py") else v
        return out

    return SheetState(cells=plain("cells"), struct=plain("struct"), meta=plain("meta"))


def tab_key(tab: dict[str, Any], index: int) -> str:
    """The id a tab is known by in the room (``#<index>`` without one)."""
    return str(tab.get("id") or f"#{index}")


def workbook_cells(data: Any) -> dict[str, Any]:
    """Every non-empty cell of a workbook, keyed as the room keys them — what
    the first editor seeds an empty room with."""
    out: dict[str, Any] = {}
    if not isinstance(data, list):
        return out
    for i, tab in enumerate(data):
        if not isinstance(tab, dict):
            continue
        sid = tab_key(tab, i)
        celldata = tab.get("celldata")
        if isinstance(celldata, list) and celldata:
            for cell in celldata:
                if not isinstance(cell, dict) or cell.get("v") is None:
                    continue
                r, c = cell.get("r"), cell.get("c")
                if isinstance(r, int) and isinstance(c, int):
                    out[f"{sid}!{r},{c}"] = cell["v"]
            continue
        grid = tab.get("data")
        if isinstance(grid, list):
            for r, row in enumerate(grid):
                if not isinstance(row, list):
                    continue
                for c, v in enumerate(row):
                    if v is not None:
                        out[f"{sid}!{r},{c}"] = v
    return out


def _celldata(cells: dict[tuple[int, int], Any]) -> list[dict[str, Any]]:
    return [{"r": r, "c": c, "v": copy.deepcopy(cells[(r, c)])} for (r, c) in sorted(cells)]


def _fit(tab: dict[str, Any], cells: dict[tuple[int, int], Any]) -> None:
    """A saved size never hides cells (Fortune grows to the larger anyway)."""
    if not cells:
        return
    rows = max(r for r, _ in cells) + 1
    cols = max(c for _, c in cells) + 1
    if isinstance(tab.get("row"), int) and tab["row"] < rows:
        tab["row"] = rows
    if isinstance(tab.get("column"), int) and tab["column"] < cols:
        tab["column"] = cols


def data_from_state(data: Any, state: bytes | SheetState | None) -> Any:
    """The workbook JSON as the room has it.

    ``data`` is the saved workbook; ``state`` the stored Y state. A room that
    was never seeded hasn't taken over the cells yet: ``data`` comes back
    as it is. Otherwise each tab's cells are the room's, tabs the room's
    structure added are appended (name and order from it), tabs it no longer
    has are dropped (never the last), and renames / reorders apply. Structure
    beyond tabs (widths, merges, …) is left as saved — the next editor's
    save carries it."""
    st = state if isinstance(state, SheetState) else read_state(state)
    if not st.seeded:
        return data
    tabs = [copy.deepcopy(t) for t in (data or []) if isinstance(t, dict)] if isinstance(data, list) else []
    shared = st.tabs() if st.struct_seeded else {}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, tab in enumerate(tabs):
        key = tab_key(tab, i)
        seen.add(key)
        if shared and key not in shared and not key.startswith("#"):
            continue  # deleted in the room
        cells = st.tab_cells(key)
        tab.pop("data", None)
        tab["celldata"] = _celldata(cells)
        _fit(tab, cells)
        meta = shared.get(key)
        if meta:
            if meta.get("name"):
                tab["name"] = meta["name"]
            if isinstance(meta.get("order"), (int, float)):
                tab["order"] = int(meta["order"])
        out.append(tab)
    for key, meta in shared.items():
        if key in seen or key.startswith("#"):
            continue
        cells = st.tab_cells(key)
        out.append(
            {
                "id": key,
                "name": str(meta.get("name") or "Sheet"),
                "order": int(meta["order"]) if isinstance(meta.get("order"), (int, float)) else len(out),
                "celldata": _celldata(cells),
            }
        )
    if not out and tabs:
        # Never lose the last tab.
        first = tabs[0]
        first["celldata"] = _celldata(st.tab_cells(tab_key(first, 0)))
        first.pop("data", None)
        out.append(first)
    return out


__all__ = ["SheetState", "data_from_state", "parse_pos", "read_state", "tab_key", "workbook_cells"]
