"""Templates and copies for office files (WP-3.4, Part C §3.5).

Templates are ordinary office files in a protected **Templates** system
folder, one per user. The folder is created — and the starter set laid
down — the first time someone opens "From template…": the four note
templates as Documents; budget, chore chart, packing list and invoice
Sheets; mind map, floor plan and kanban-sketch Whiteboards. Delete or
edit them like any file; they don't come back.

"New from template", "Save as template" and "Make a copy" are all
:func:`copy_office_file`: a new office file with the source's editor state
(Yjs) and, for a sheet, its workbook.
"""
from __future__ import annotations

import random
import re
import time
import uuid
from datetime import date
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.generated_kinds import GeneratedKind
from app.files.models import DocumentState, FileFolder, UserFile

if TYPE_CHECKING:
    from app.auth.models import User


# --------------------------------------------------------------------
# Copy
# --------------------------------------------------------------------
def office_kind_of(row: UserFile) -> str | None:
    """"document" / "sheet" / "whiteboard" for an office file, else None."""
    return {
        GeneratedKind.DOCUMENT.value: "document",
        GeneratedKind.SHEET.value: "sheet",
        GeneratedKind.WHITEBOARD.value: "whiteboard",
    }.get(row.source_kind or "")


def office_title(row: UserFile) -> str:
    """The file's name without its office suffix."""
    name = row.filename or "Untitled"
    for suffix in (".html", ".sheet", ".whiteboard"):
        if name.lower().endswith(suffix):
            return name[: -len(suffix)] or "Untitled"
    return name


async def _write_document(
    db: AsyncSession, doc: UserFile, *, update: bytes, html: str, text: str | None
) -> None:
    from app.files.storage import absolute_path

    ds = await db.get(DocumentState, doc.id)
    if ds is not None:
        ds.yjs_update = update
        ds.version = (ds.version or 0) + 1
    doc.content_text = text
    with open(absolute_path(doc.storage_path), "w", encoding="utf-8") as f:
        f.write(html)
    doc.size_bytes = len(html.encode("utf-8"))


async def copy_office_file(
    db: AsyncSession,
    src: UserFile,
    *,
    owner: User,
    folder_id: uuid.UUID | None,
    title: str,
) -> UserFile:
    """A new personal office file in ``owner``'s ``folder_id`` with ``src``'s
    content. Flushed, not committed."""
    from app.files.office import content_for_shell, create_office_file

    kind = office_kind_of(src)
    if kind is None:
        raise ValueError("not an office file")
    if kind == "document":
        from app.files.storage import absolute_path

        state = await db.get(DocumentState, src.id)
        try:
            html = absolute_path(src.storage_path).read_text(encoding="utf-8")
        except (OSError, ValueError):
            html = ""
        doc, _ = await create_office_file(db, kind="document", owner=owner, title=title, folder_id=folder_id)
        await _write_document(
            db,
            doc,
            update=bytes(state.yjs_update) if state is not None and state.yjs_update else b"",
            html=html,
            text=src.content_text,
        )
        await db.flush()
        # Its own copies of the pictures, re-pointed in its content (R-228).
        from app.files.doc_assets import relink_copy

        await relink_copy(db, src.id, doc)
        return doc
    entity = await content_for_shell(db, src)
    shell, new = await create_office_file(
        db,
        kind=kind,  # type: ignore[arg-type]
        owner=owner,
        title=title,
        folder_id=folder_id,
        data=getattr(entity, "data", None) if entity is not None else None,
    )
    if entity is not None:
        new.yjs_update = bytes(entity.yjs_update or b"")
        new.content_text = entity.content_text
    await db.flush()
    return shell


# --------------------------------------------------------------------
# The Templates folder
# --------------------------------------------------------------------
async def templates_folder(db: AsyncSession, user: User, *, seed: bool = True) -> FileFolder:
    """The user's Templates folder — created, with the starter set, on
    first use. Flushed, not committed."""
    from app.files.system_folders import SystemKind, _ensure, _fetch

    existing = await _fetch(db, user.id, SystemKind.TEMPLATES)
    if existing is not None:
        return existing
    folder = await _ensure(db, user.id, SystemKind.TEMPLATES)
    if seed:
        await seed_starter_templates(db, user, folder)
    return folder


async def list_templates(db: AsyncSession, user: User) -> list[UserFile]:
    folder = await templates_folder(db, user)
    return list(
        (
            await db.execute(
                select(UserFile)
                .where(
                    UserFile.folder_id == folder.id,
                    UserFile.trashed_at.is_(None),
                    UserFile.source_kind.in_(
                        [
                            GeneratedKind.DOCUMENT.value,
                            GeneratedKind.SHEET.value,
                            GeneratedKind.WHITEBOARD.value,
                        ]
                    ),
                )
                .order_by(UserFile.filename)
            )
        ).scalars()
    )


async def seed_starter_templates(db: AsyncSession, user: User, folder: FileFolder) -> None:
    import asyncio

    from app.files.office import create_office_file
    from app.workspaces.content_seed import render_note_markdown
    from app.workspaces.templates import NOTE_TEMPLATES

    for _key, (title, markdown) in NOTE_TEMPLATES.items():
        # The date is filled in when a file is made from it — a template
        # keeps the placeholder readable instead.
        rendered = await asyncio.to_thread(render_note_markdown, markdown.replace("{date}", "[date]"))
        doc, _ = await create_office_file(db, kind="document", owner=user, title=title, folder_id=folder.id)
        update, html, text = rendered
        await _write_document(db, doc, update=update, html=html, text=text)
    for title, data, text in _starter_sheets():
        shell, sheet = await create_office_file(
            db, kind="sheet", owner=user, title=title, folder_id=folder.id, data=data
        )
        sheet.content_text = text
    for title, elements in _starter_whiteboards():
        shell, board = await create_office_file(
            db, kind="whiteboard", owner=user, title=title, folder_id=folder.id
        )
        board.yjs_update = scene_to_yjs(elements)
        board.content_text = "\n".join(e["text"] for e in elements if e.get("type") == "text")
    await db.flush()


def fill_template_placeholders(markdown_or_html: str) -> str:
    return markdown_or_html.replace("[date]", date.today().strftime("%d %b %Y"))


# --------------------------------------------------------------------
# Starter sheets
# --------------------------------------------------------------------
def _cell(r: int, c: int, value: Any, *, bold: bool = False) -> dict:
    v: dict[str, Any] = {}
    if isinstance(value, str) and value.startswith("="):
        v["f"] = value
    elif isinstance(value, (int, float)):
        v["v"] = value
        v["m"] = str(value)
        v["ct"] = {"fa": "General", "t": "n"}
    else:
        v["v"] = value
        v["m"] = value
        v["ct"] = {"fa": "General", "t": "g"}
    if bold:
        v["bl"] = 1
    return {"r": r, "c": c, "v": v}


_REF = re.compile(r"\b([A-Z])([0-9]+)\b")
_SUM = re.compile(r"SUM\(([A-Z])([0-9]+):([A-Z])([0-9]+)\)")


def _evaluate(rows: list[list[Any]]) -> dict[tuple[int, int], float]:
    """Values for the starter sheets' few formulas (cell refs, SUM over a
    range, + - * and numbers) so a template shows its totals before the
    editor recalculates — and in read-only views that never do."""
    values: dict[tuple[int, int], float] = {}

    def num(r: int, c: int) -> float:
        if (r, c) in values:
            return values[(r, c)]
        v = rows[r][c] if r < len(rows) and c < len(rows[r]) else None
        return float(v) if isinstance(v, (int, float)) else 0.0

    for _ in range(3):  # formulas only point up or left; a few passes settle it
        for r, row in enumerate(rows):
            for c, v in enumerate(row):
                if not (isinstance(v, str) and v.startswith("=")):
                    continue
                expr = _SUM.sub(
                    lambda m: repr(
                        sum(
                            num(rr, cc)
                            for rr in range(int(m[2]) - 1, int(m[4]))
                            for cc in range(ord(m[1]) - 65, ord(m[3]) - 64)
                        )
                    ),
                    v[1:],
                )
                expr = _REF.sub(lambda m: repr(num(int(m[2]) - 1, ord(m[1]) - 65)), expr)
                if re.fullmatch(r"[0-9.+\-*/() e]+", expr):
                    values[(r, c)] = round(float(eval(expr, {"__builtins__": {}}, {})), 2)  # noqa: S307 — digits and operators only
    return values


def _sheet(name: str, rows: list[list[Any]], *, bold_rows: tuple[int, ...] = (0,)) -> dict:
    computed = _evaluate(rows)
    cells = []
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            if value in (None, ""):
                continue
            cell = _cell(r, c, value, bold=r in bold_rows)
            if (r, c) in computed:
                n = computed[(r, c)]
                n = int(n) if float(n).is_integer() else n
                cell["v"].update({"v": n, "m": str(n), "ct": {"fa": "General", "t": "n"}})
            cells.append(cell)
    return {"name": name, "celldata": cells}


def _text_of(rows: list[list[Any]]) -> str:
    return "\n".join(
        " | ".join(str(v) for v in row if v not in (None, "") and not str(v).startswith("="))
        for row in rows
    )


def _starter_sheets() -> list[tuple[str, list[dict], str]]:
    budget = [
        ["Category", "Planned", "Actual", "Difference"],
        ["Rent / mortgage", 1500, 1500, "=B2-C2"],
        ["Groceries", 600, 0, "=B3-C3"],
        ["Utilities", 200, 0, "=B4-C4"],
        ["Transport", 150, 0, "=B5-C5"],
        ["Insurance", 120, 0, "=B6-C6"],
        ["Savings", 400, 0, "=B7-C7"],
        ["Fun", 200, 0, "=B8-C8"],
        ["Total", "=SUM(B2:B8)", "=SUM(C2:C8)", "=SUM(D2:D8)"],
    ]
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    chores = [["Chore", "Who", *days]] + [
        [chore, "", *([""] * 7)]
        for chore in ("Dishes", "Laundry", "Vacuum", "Take out the bins", "Bathroom", "Water the plants")
    ]
    packing = [
        ["Item", "Category", "Qty", "Packed"],
        ["Passport / ID", "Documents", 1, "☐"],
        ["Tickets & bookings", "Documents", 1, "☐"],
        ["Phone charger", "Electronics", 1, "☐"],
        ["Headphones", "Electronics", 1, "☐"],
        ["T-shirts", "Clothes", 4, "☐"],
        ["Socks & underwear", "Clothes", 5, "☐"],
        ["Jacket", "Clothes", 1, "☐"],
        ["Toothbrush & toothpaste", "Toiletries", 1, "☐"],
        ["Medication", "Toiletries", 1, "☐"],
    ]
    invoice = [
        ["INVOICE", "", "", ""],
        ["From:", "Your name", "Invoice #", "0001"],
        ["Bill to:", "Client name", "Date", "[date]"],
        ["", "", "Due", ""],
        ["", "", "", ""],
        ["Description", "Qty", "Rate", "Amount"],
        ["Service or item", 1, 100, "=B7*C7"],
        ["", "", "", "=B8*C8"],
        ["", "", "", "=B9*C9"],
        ["", "", "Subtotal", "=SUM(D7:D9)"],
        ["", "", "Tax (10%)", "=D10*0.1"],
        ["", "", "Total", "=D10+D11"],
    ]
    out = []
    for title, rows, bold in (
        ("Budget", budget, (0, 8)),
        ("Chore chart", chores, (0,)),
        ("Packing list", packing, (0,)),
        ("Invoice", invoice, (0, 5, 11)),
    ):
        out.append((title, [_sheet("Sheet1", rows, bold_rows=bold)], _text_of(rows)))
    return out


# --------------------------------------------------------------------
# Starter whiteboards (Excalidraw elements in the canvas Y.Doc)
# --------------------------------------------------------------------
_INDEX_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _index(i: int) -> str:
    """Fractional-index keys in order: a0…az, then b00…"""
    if i < 62:
        return "a" + _INDEX_DIGITS[i]
    i -= 62
    return "b" + _INDEX_DIGITS[i // 62] + _INDEX_DIGITS[i % 62]


class _Scene:
    def __init__(self) -> None:
        self.elements: list[dict] = []
        self._now = int(time.time() * 1000)
        self._rng = random.Random(7)

    def _base(self, kind: str, x: float, y: float, w: float, h: float, **extra: Any) -> dict:
        roundness = {"rectangle": {"type": 3}, "ellipse": {"type": 2}, "arrow": {"type": 2}}.get(kind)
        el = {
            "id": uuid.uuid4().hex[:20],
            "type": kind,
            "x": x,
            "y": y,
            "width": w,
            "height": h,
            "angle": 0,
            "strokeColor": "#1e1e1e",
            "backgroundColor": "transparent",
            "fillStyle": "solid",
            "strokeWidth": 2,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "frameId": None,
            "roundness": roundness,
            "seed": self._rng.randint(1, 2**31 - 1),
            "version": 1,
            "versionNonce": self._rng.randint(1, 2**31 - 1),
            "isDeleted": False,
            "boundElements": None,
            "updated": self._now,
            "link": None,
            "locked": False,
            "index": _index(len(self.elements)),
        }
        el.update(extra)
        self.elements.append(el)
        return el

    def box(self, x, y, w, h, *, fill="transparent", kind="rectangle", sharp=False):
        el = self._base(kind, x, y, w, h, backgroundColor=fill)
        if sharp:
            el["roundness"] = None
        return el

    def text(self, x, y, text, *, size=20, align="left", w=None):
        lines = text.split("\n")
        width = w if w is not None else max(len(line) for line in lines) * size * 0.55
        height = len(lines) * size * 1.25
        return self._base(
            "text",
            x,
            y,
            width,
            height,
            text=text,
            originalText=text,
            fontSize=size,
            fontFamily=5,
            textAlign=align,
            verticalAlign="top",
            containerId=None,
            autoResize=True,
            lineHeight=1.25,
        )

    def label(self, box: dict, text: str, *, size=20):
        """Text centred on ``box`` (free text — no binding to keep)."""
        lines = text.split("\n")
        w = max(len(line) for line in lines) * size * 0.55
        h = len(lines) * size * 1.25
        return self.text(
            box["x"] + (box["width"] - w) / 2, box["y"] + (box["height"] - h) / 2, text, size=size, align="center", w=w
        )

    def line(self, x1, y1, x2, y2, *, arrow=False):
        return self._base(
            "arrow" if arrow else "line",
            x1,
            y1,
            abs(x2 - x1),
            abs(y2 - y1),
            points=[[0, 0], [x2 - x1, y2 - y1]],
            lastCommittedPoint=None,
            startBinding=None,
            endBinding=None,
            startArrowhead=None,
            endArrowhead="arrow" if arrow else None,
            **({"elbowed": False} if arrow else {}),
        )


def _mind_map() -> list[dict]:
    import math

    s = _Scene()
    cx, cy = 600, 400
    centre = s.box(cx - 110, cy - 50, 220, 100, fill="#ffd8a8", kind="ellipse")
    branches = ["Goal", "People", "Ideas", "Questions", "Resources", "Next steps"]
    for i, name in enumerate(branches):
        angle = -math.pi / 2 + i * 2 * math.pi / len(branches)
        bx, by = cx + 320 * math.cos(angle), cy + 230 * math.sin(angle)
        s.line(cx + 110 * math.cos(angle), cy + 50 * math.sin(angle), bx - 80 * math.cos(angle), by - 30 * math.sin(angle))
        b = s.box(bx - 80, by - 30, 160, 60, fill="#e7f5ff")
        s.label(b, name)
    s.label(centre, "Main idea", size=24)
    return s.elements


def _floor_plan() -> list[dict]:
    s = _Scene()
    rooms = [
        ("Living room", 100, 100, 360, 260),
        ("Kitchen", 460, 100, 240, 260),
        ("Hall", 100, 360, 160, 200),
        ("Bathroom", 260, 360, 160, 200),
        ("Bedroom", 420, 360, 280, 200),
    ]
    for name, x, y, w, h in rooms:
        s.label(s.box(x, y, w, h, sharp=True), name)
    s.text(100, 580, "Front door ↑  ·  1 grid square ≈ 1 m  ·  draw walls, doors and furniture over this", size=16)
    s.text(100, 50, "Floor plan", size=28)
    return s.elements


def _kanban_sketch() -> list[dict]:
    s = _Scene()
    s.text(80, 30, "Kanban", size=28)
    columns = [
        ("To do", ["Write the plan", "Book the venue", "Order supplies"]),
        ("Doing", ["Design the flyer"]),
        ("Done", ["Pick a date"]),
    ]
    for i, (name, cards) in enumerate(columns):
        x = 80 + i * 300
        s.box(x, 90, 270, 520, fill="#f8f9fa")
        s.text(x + 20, 105, name, size=24)
        for j, card in enumerate(cards):
            note = s.box(x + 20, 160 + j * 110, 230, 90, fill="#fff3bf")
            s.label(note, card, size=18)
    return s.elements


def _starter_whiteboards() -> list[tuple[str, list[dict]]]:
    return [("Mind map", _mind_map()), ("Floor plan", _floor_plan()), ("Kanban sketch", _kanban_sketch())]


def scene_to_yjs(elements: list[dict]) -> bytes:
    """A canvas Y.Doc holding ``elements`` (the ``elements`` map, keyed by
    element id) — what collab and the editor load."""
    from pycrdt import Doc, Map

    doc = Doc()
    ymap = doc.get("elements", type=Map)
    with doc.transaction():
        for el in elements:
            ymap[el["id"]] = el
    return doc.get_update()


__all__ = [
    "copy_office_file",
    "fill_template_placeholders",
    "list_templates",
    "office_kind_of",
    "office_title",
    "scene_to_yjs",
    "templates_folder",
]
