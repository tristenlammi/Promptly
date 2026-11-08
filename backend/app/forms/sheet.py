"""Forms → a linked Sheet, kept up to date live (WP-F1.5, plan §3.5 / §6.2).

A form can be linked to a tab of a Promptly Sheet: a new spreadsheet
("<Form> (Responses)", next to the form) or a "Form responses" tab added to
one you already have. Then:

* each new answer becomes a row under the last row in use;
* a changed answer rewrites the row whose **Response #** matches — found by
  reading column A of the sheet as it is now, so sorting the sheet, adding
  columns or rows of your own doesn't break it (a row you deleted comes back
  at the bottom);
* a new question adds a column at the right; a renamed one renames its
  header only if the header still says the old name;
* a deleted answer stays in the sheet;
* every cell Forms writes is typed text (``ct: {fa: "@", t: "s"}``) with no
  formula, so an answer like ``=IMPORTXML(…)`` can't run anything.

How a write reaches the sheet: through the collab server
(``collab_internal.sheet_cells`` → ``/internal/sheet-cells``). For a sheet
someone has open, the cells arrive in their editor like a colleague's edit
and their autosave carries them into the workbook JSON. For a closed sheet,
collab stores the room and hands back its state, and the workbook JSON
(what export, search and RAG read) is rebuilt from it here
(``workspaces.sheet_y.data_from_state``). The write says what column A must
still hold on the rows it touches; if someone sorted in between, collab
refuses it and the sync plans again on the new state.

If collab can't be reached, nothing is lost: answers are rows in Postgres,
``forms.sheet_synced_seq`` stays where it was, and the 10-minute catch-up
(``forms_sheet_tick``) writes them later. Syncs of one form never overlap
(a transaction-scoped advisory lock), and each one is idempotent (rows are
found by Response #, and unchanged cells aren't rewritten).

Nothing here touches the form's answers; it only reads them.
"""
from __future__ import annotations

import copy
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.forms.definition import questions
from app.forms.export import answer_text, when
from app.forms.models import Form, FormResponse

logger = logging.getLogger("promptly.forms.sheet")

TAB_NAME = "Form responses"
#: The sheet stops growing here (``sheet_io.MAX_ROWS``), with a clear message.
from app.workspaces.sheet_io import MAX_ROWS  # noqa: E402

BATCH = 500
#: Answers saved around the last sync are looked at again (their sequence
#: number may have been taken before an earlier one's commit landed).
LOOKBACK = timedelta(minutes=2)
#: How long to wait before checking that an open sheet's editor saved.
RECONCILE_AFTER_S = 180

# What ``sheet_error`` holds, and what the Responses page says about it.
ERRORS: dict[str, str] = {
    "waiting": "Couldn't reach the sheet just now. New answers will be added in a few minutes.",
    "full": f"The sheet has reached {MAX_ROWS:,} rows, so new answers aren't being added. "
    "Link a new sheet to keep going.",
    "tab_deleted": "The “Form responses” tab was deleted from the linked sheet.",
    "trashed": "The linked sheet is in the bin. Restore it to keep it up to date, or make a new sheet.",
    "deleted": "The linked sheet was deleted.",
}


# --------------------------------------------------------------------
# Cells
# --------------------------------------------------------------------
def text_cell(value: str, *, bold: bool = False) -> dict[str, Any]:
    """A Fortune cell typed as text — never a formula, whatever it says."""
    cell: dict[str, Any] = {"v": value, "m": value, "ct": {"fa": "@", "t": "s"}}
    if bold:
        cell["bl"] = 1
    return cell


def cell_text(cell: Any) -> str:
    """What a cell shows (the same reading as collab's ``cellText``)."""
    if cell is None:
        return ""
    if not isinstance(cell, dict):
        return str(cell)
    v = cell.get("v")
    if v is None:
        v = cell.get("m")
    if v is None:
        return ""
    if isinstance(v, dict):
        inner = v.get("v") if v.get("v") is not None else v.get("m")
        return "" if inner is None else str(inner)
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        # JS ``String(3)`` is "3": a number the editor stored reads the same.
        return str(int(v))
    return str(v)


def _merged(existing: Any, value: str) -> dict[str, Any]:
    """``value`` as text, keeping the look someone gave the cell (colour,
    bold…) but never a formula."""
    cell = text_cell(value)
    if isinstance(existing, dict):
        keep = {k: copy.deepcopy(v) for k, v in existing.items() if k not in ("v", "m", "ct", "f", "spl")}
        keep.update(cell)
        return keep
    return cell


def _number_of(text_: str) -> int | None:
    t = (text_ or "").strip()
    if not t:
        return None
    try:
        n = float(t)
    except ValueError:
        return None
    return int(n) if n.is_integer() and n > 0 else None


# --------------------------------------------------------------------
# Columns and rows
# --------------------------------------------------------------------
BASE_COLUMNS: list[tuple[str, str]] = [
    ("number", "Response #"),
    ("submitted", "Submitted"),
    ("edited", "Edited"),
]
EMAIL_TITLE = "Email (typed, not checked)"
ACCOUNT_TITLE = "Account"


def wanted_columns(
    definition: dict[str, Any],
    *,
    email: bool,
    account: bool,
    layout: list[dict[str, Any]] | None = None,
) -> list[tuple[str, str]]:
    """The columns the tab should have, in order: Response #, Submitted,
    Edited, Email and Account (when answers can have them, and kept once
    they're there), then every question — deleted ones last."""
    have = {e.get("key") for e in layout or []}
    out = list(BASE_COLUMNS)
    if email or "email" in have:
        out.append(("email", EMAIL_TITLE))
    if account or "account" in have:
        out.append(("account", ACCOUNT_TITLE))
    qs = questions(definition or {}, include_deleted=True)
    qs = [q for q in qs if not q.get("deleted")] + [q for q in qs if q.get("deleted")]
    for q in qs:
        title = (q.get("title") or "").strip() or "Untitled question"
        out.append((f"q:{q.get('id')}", f"{title} (deleted question)" if q.get("deleted") else title))
    return out


def row_values(
    definition: dict[str, Any],
    r: Any,
    *,
    who: dict[Any, str] | None = None,
    tz: Any = None,
) -> dict[str, str]:
    """One answer as ``{column key: text}`` — not neutralised: the cells are
    typed text, so nothing in them is ever run."""
    out = {
        "number": str(r.number),
        "submitted": when(r.submitted_at, tz),
        "edited": when(r.edited_at, tz),
        "email": r.email or "",
        "account": (who or {}).get(r.respondent_id, "") if r.respondent_id else "",
    }
    answers = r.answers or {}
    for q in questions(definition or {}, include_deleted=True):
        out[f"q:{q.get('id')}"] = answer_text(q, answers.get(q.get("id")))
    return out


@dataclass
class Plan:
    """What one sync writes: ``cells`` ``{(r, c): cell | None}``, what the
    sheet must still say where it writes (``expect`` ``{(r, c): text}``),
    the column layout after it, and which answers it placed."""

    cells: dict[tuple[int, int], dict[str, Any] | None] = field(default_factory=dict)
    expect: dict[tuple[int, int], str] = field(default_factory=dict)
    layout: list[dict[str, Any]] = field(default_factory=list)
    placed: list[int] = field(default_factory=list)
    appended: int = 0
    full: bool = False


def locate_columns(
    header: dict[int, str], layout: list[dict[str, Any]]
) -> dict[str, int]:
    """``{key: column}`` for the columns Forms wrote before. A column is
    where its header text is now (someone may have inserted or moved
    columns); if that text is nowhere (renamed by hand), where it was."""
    out: dict[str, int] = {}
    claimed: set[int] = set()
    # Pass 1: still where they were.
    for e in layout:
        c = e.get("col")
        if isinstance(c, int) and header.get(c) == e.get("title") and c not in claimed:
            out[e["key"]] = c
            claimed.add(c)
    # Pass 2: moved — find the header text elsewhere.
    for e in layout:
        if e["key"] in out:
            continue
        found = next((c for c in sorted(header) if header[c] == e.get("title") and c not in claimed), None)
        if found is not None:
            out[e["key"]] = found
            claimed.add(found)
    # Pass 3: renamed by hand — its old place, moved as far as its
    # neighbours moved (a column inserted before it shifts it too).
    shifts: dict[int, int] = {}
    for e in layout:
        c = e.get("col")
        if e["key"] in out and isinstance(c, int):
            d = out[e["key"]] - c
            shifts[d] = shifts.get(d, 0) + 1
    for e in layout:
        if e["key"] in out:
            continue
        c = e.get("col")
        if not isinstance(c, int) or c < 0:
            continue
        # As far as its nearest found neighbour on the left moved, else as
        # far as most columns moved.
        left = [(x["col"], out[x["key"]] - x["col"]) for x in layout
                if x["key"] in out and isinstance(x.get("col"), int) and x["col"] < c]
        guess = c + (max(left)[1] if left else (max(shifts, key=shifts.get) if shifts else 0))
        for cand in (guess, c):
            if cand >= 0 and cand not in claimed:
                out[e["key"]] = cand
                claimed.add(cand)
                break
    return out


def plan(
    cells: dict[tuple[int, int], Any],
    layout: list[dict[str, Any]] | None,
    wanted: list[tuple[str, str]],
    rows: Iterable[tuple[int, dict[str, str]]],
    *,
    max_rows: int = MAX_ROWS,
) -> Plan:
    """Plan a sync against the tab as it is now (``cells``: ``{(r, c):
    cell}``). Row 0 is the header. Pure: no database, no collab."""
    texts = {pos: cell_text(v) for pos, v in cells.items()}
    header = {c: t for (r, c), t in texts.items() if r == 0 and t != ""}
    out = Plan()
    layout = [dict(e) for e in (layout or []) if isinstance(e, dict) and e.get("key")]
    cols = locate_columns(header, layout)
    # A column that couldn't be placed anywhere is written afresh.
    layout = [e for e in layout if e["key"] in cols]
    by_key = {e["key"]: e for e in layout}
    used_cols = set(header) | set(cols.values())
    next_col = (max(used_cols) + 1) if used_cols else 0

    def put(pos: tuple[int, int], cell: dict[str, Any] | None) -> None:
        out.cells[pos] = cell
        out.expect.setdefault(pos, texts.get(pos, ""))

    for key, title in wanted:
        e = by_key.get(key)
        if e is None:
            # A new column at the right end.
            c = next_col
            next_col += 1
            cols[key] = c
            e = {"key": key, "title": title, "col": c}
            layout.append(e)
            by_key[key] = e
            put((0, c), _merged(cells.get((0, c)), title) | {"bl": 1})
            continue
        c = cols[key]
        if e.get("title") != title:
            # Renamed: only if the header still says what Forms wrote.
            if texts.get((0, c), "") in (e.get("title"), ""):
                put((0, c), _merged(cells.get((0, c)), title) | {"bl": 1})
                e["title"] = title
    for e in layout:
        e["col"] = cols.get(e["key"], e.get("col"))
    out.layout = layout

    num_col = cols["number"]
    by_number: dict[int, int] = {}
    for (r, c), t in sorted(texts.items()):
        if c == num_col and r >= 1:
            n = _number_of(t)
            if n is not None and n not in by_number:
                by_number[n] = r
    last = max((r for (r, _c), t in texts.items() if t != ""), default=0)

    # The newest version of each answer only.
    latest: dict[int, dict[str, str]] = {}
    for number, values in rows:
        latest[number] = values
    for number in sorted(latest, key=lambda n: (n not in by_number, n)):
        values = latest[number]
        r = by_number.get(number)
        if r is not None:
            # Rewrite the row that holds this Response # now.
            out.expect[(r, num_col)] = texts.get((r, num_col), "")
            for key, c in cols.items():
                if key not in values:
                    continue
                v = values[key]
                cur = texts.get((r, c), "")
                if v == cur:
                    continue
                put((r, c), _merged(cells.get((r, c)), v) if v else None)
        else:
            r = last + 1
            if r >= max_rows:
                out.full = True
                break
            last = r
            by_number[number] = r
            out.appended += 1
            out.expect[(r, num_col)] = texts.get((r, num_col), "")
            for key, c in cols.items():
                v = values.get(key, "")
                if v:
                    put((r, c), _merged(cells.get((r, c)), v))
        out.placed.append(number)
    return out


def header_tab(tab_id: str, wanted: list[tuple[str, str]], *, name: str = TAB_NAME, order: int = 0) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """A new "Form responses" tab with its header row written (bold, frozen,
    answer columns a little wider), and its column layout."""
    layout = [{"key": k, "title": t, "col": i} for i, (k, t) in enumerate(wanted)]
    widths = {str(i): (90 if k == "number" else 150 if k in ("submitted", "edited") else 200) for i, (k, _t) in enumerate(wanted)}
    tab = {
        "id": tab_id,
        "name": name,
        "order": order,
        "celldata": [{"r": 0, "c": i, "v": text_cell(t, bold=True)} for i, (_k, t) in enumerate(wanted)],
        "config": {"columnlen": widths},
        "frozen": {"type": "rangeRow", "range": {"row_focus": 0, "column_focus": 0}},
    }
    return tab, layout


# --------------------------------------------------------------------
# Status (the Sheet card on the Responses page)
# --------------------------------------------------------------------
async def status(db: AsyncSession, form: Form, user: Any | None = None) -> dict[str, Any] | None:
    """The Sheet card: ``None`` when no sheet was ever linked."""
    from app.files.models import UserFile
    from app.files.office import get_office_access

    if form.sheet_tab_id is None:
        return None
    pending = (
        await db.execute(
            select(func.count())
            .select_from(FormResponse)
            .where(
                FormResponse.form_id == form.id,
                FormResponse.deleted_at.is_(None),
                FormResponse.seq > (form.sheet_synced_seq or 0),
            )
        )
    ).scalar_one()
    out: dict[str, Any] = {
        "file_id": str(form.sheet_file_id) if form.sheet_file_id else None,
        "title": None,
        "tab_name": TAB_NAME,
        "synced_at": form.sheet_synced_at.isoformat() if form.sheet_synced_at else None,
        "pending": int(pending or 0),
        "problem": None,
        "message": None,
        "can_open": False,
    }
    shell = await db.get(UserFile, form.sheet_file_id) if form.sheet_file_id else None
    problem = form.sheet_error
    if shell is None:
        problem = "deleted"
    elif shell.trashed_at is not None:
        problem = "trashed"
    if shell is not None:
        from app.files.office_templates import office_title

        out["title"] = office_title(shell)
        out["can_open"] = user is not None and await get_office_access(db, shell, user) != "none"
    out["problem"] = problem
    out["message"] = ERRORS.get(problem or "") if problem else None
    return out


# --------------------------------------------------------------------
# Linking
# --------------------------------------------------------------------
class SheetLinkError(Exception):
    pass


async def _flags(db: AsyncSession, form: Form) -> tuple[bool, bool]:
    """(answers can carry an email, answers can carry an account)."""
    has = (
        await db.execute(
            select(
                func.bool_or(FormResponse.email.is_not(None)),
                func.bool_or(FormResponse.respondent_id.is_not(None)),
            ).where(FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None))
        )
    ).one()
    email = bool(form.collect_email) or bool(has[0])
    account = form.audience == "server" or bool(has[1])
    return email, account


def _new_tab_id() -> str:
    return "frm" + uuid.uuid4().hex[:9]


def _mark_outside(sheet: Any) -> None:
    if not getattr(sheet, "outside_content", False):
        sheet.outside_content = True


async def link_new(db: AsyncSession, form_shell: Any, form: Form, user: Any, *, name: str | None = None) -> Any:
    """Make "<Form> (Responses)" — next to the form when the form is in your
    own folder, else in My files — and link it. Flushed, not committed."""
    from app.files.office import create_office_file
    from app.workspaces.sheet_io import flatten_text

    title = (name or "").strip()[:200] or f"{form.title} (Responses)"
    folder_id = form_shell.folder_id if form_shell.user_id == user.id else None
    email, account = await _flags(db, form)
    tab_id = _new_tab_id()
    tab, layout = header_tab(tab_id, wanted_columns(form.definition or {}, email=email, account=account))
    data = [tab]
    shell, sheet = await create_office_file(
        db, kind="sheet", owner=user, title=title, folder_id=folder_id, data=data, content_text=flatten_text(data)
    )
    _mark_outside(sheet)
    _set_link(form, shell.id, tab_id, layout)
    await db.flush()
    return shell


async def link_existing(db: AsyncSession, form: Form, user: Any, sheet_file_id: uuid.UUID) -> Any:
    """Add a "Form responses" tab to a sheet you can edit and link it.
    Flushed, not committed. Raises :class:`SheetLinkError` with a message
    for the person."""
    from app.chat.models import Spreadsheet
    from app.collab_internal import live_state
    from app.files.generated_kinds import GeneratedKind
    from app.files.models import UserFile
    from app.files.office import content_for_shell, get_office_access
    from app.workspaces.sheet_io import flatten_text, ensure_tab_ids
    from app.workspaces.sheet_y import read_state

    shell = await db.get(UserFile, sheet_file_id)
    if (
        shell is None
        or shell.source_kind != GeneratedKind.SHEET.value
        or shell.trashed_at is not None
        or await get_office_access(db, shell, user) != "edit"
    ):
        raise SheetLinkError("Pick a spreadsheet you can edit.")
    sheet = await content_for_shell(db, shell)
    if sheet is None:
        raise SheetLinkError("Pick a spreadsheet you can edit.")
    room = f"sheet:{sheet.id}"
    email, account = await _flags(db, form)
    wanted = wanted_columns(form.definition or {}, email=email, account=account)
    tab_id = _new_tab_id()
    live = await live_state(room)
    # What's there now: the room when it holds the sheet, else the workbook.
    st = read_state(live if live is not None else sheet.yjs_update)
    data_tabs = [t for t in sheet.data if isinstance(t, dict)] if isinstance(sheet.data, list) else []
    if st.struct_seeded:
        names = {str(v.get("name")) for v in st.tabs().values()}
        orders = [int(v.get("order") or 0) for v in st.tabs().values()]
    else:
        names = {str(t.get("name")) for t in data_tabs}
        orders = [int(t["order"]) for t in data_tabs if isinstance(t.get("order"), int)] or [len(data_tabs) - 1]
    order = max(orders, default=-1) + 1
    name = TAB_NAME
    n = 2
    while name in names:
        name = f"{TAB_NAME} {n}"
        n += 1
    tab, layout = header_tab(tab_id, wanted, name=name, order=order)
    if live is not None or st.seeded:
        # The room holds the sheet: the tab and its header go through it, so
        # an open editor shows them at once and the next one keeps them.
        # (Before any lock here: a closed room's store takes the sheet's row.)
        from app.collab_internal import CollabUnavailable, SheetWriteMoved, sheet_cells

        cells = {f"{tab_id}!0,{c['c']}": c["v"] for c in tab["celldata"]}
        try:
            await sheet_cells(room, cells, tabs={tab_id: {"name": name, "order": order}})
        except (CollabUnavailable, SheetWriteMoved):
            raise SheetLinkError("Couldn't reach that spreadsheet right now. Try again in a minute.") from None
    locked = (
        await db.execute(
            select(Spreadsheet).where(Spreadsheet.id == sheet.id).with_for_update().execution_options(populate_existing=True)
        )
    ).scalar_one()
    if live is None:
        # Closed: the tab goes into the workbook now (an open editor's
        # autosave brings it in otherwise).
        data = copy.deepcopy(locked.data) if isinstance(locked.data, list) else []
        ensure_tab_ids(data)
        data.append(tab)
        locked.data = data
        flag_modified(locked, "data")
        locked.content_text = flatten_text(data)
        locked.data_version = (locked.data_version or 0) + 1
    _mark_outside(locked)
    _set_link(form, shell.id, tab_id, layout)
    await db.flush()
    return shell


def _set_link(form: Form, sheet_file_id: uuid.UUID, tab_id: str, layout: list[dict[str, Any]]) -> None:
    form.sheet_file_id = sheet_file_id
    form.sheet_tab_id = tab_id
    form.sheet_columns = layout
    flag_modified(form, "sheet_columns")
    form.sheet_synced_seq = 0
    form.sheet_synced_at = None
    form.sheet_error = None


def unlink(form: Form) -> None:
    """Stop updating the sheet. The sheet stays as it is (and stays marked
    as holding other people's words)."""
    form.sheet_file_id = None
    form.sheet_tab_id = None
    form.sheet_columns = None
    form.sheet_synced_seq = 0
    form.sheet_synced_at = None
    form.sheet_error = None


# --------------------------------------------------------------------
# The sync
# --------------------------------------------------------------------
async def _lock(db: AsyncSession, form_id: uuid.UUID) -> None:
    """One sync per form at a time (released at commit)."""
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"forms-sheet:{form_id}"})


async def _room_now(db: AsyncSession, sheet: Any) -> tuple[bytes | None, bool]:
    """(state, open in an editor): the live state when open, else stored."""
    from app.chat.models import Spreadsheet
    from app.collab_internal import live_state

    room = f"sheet:{sheet.id}"
    live = await live_state(room)
    if live is not None:
        return live, True
    stored = (await db.execute(select(Spreadsheet.yjs_update).where(Spreadsheet.id == sheet.id))).scalar_one_or_none()
    return stored, False


def _tab_cells(st: Any, data: Any, tab_id: str) -> dict[tuple[int, int], Any] | None:
    """The tab's cells as editors see them; ``None`` when the tab is gone."""
    from app.workspaces.sheet_y import parse_pos, tab_key, workbook_cells

    if st.seeded:
        if st.struct_seeded:
            if tab_id not in st.tabs():
                return None
        elif not any(isinstance(t, dict) and tab_key(t, i) == tab_id for i, t in enumerate(data or [])):
            return None
        return st.tab_cells(tab_id)
    for i, t in enumerate(data or []):
        if isinstance(t, dict) and tab_key(t, i) == tab_id:
            out: dict[tuple[int, int], Any] = {}
            for k, v in workbook_cells([t]).items():
                pos = parse_pos(k.split("!", 1)[1])
                if pos is not None:
                    out[pos] = v
            return out
    return None


async def rebuild_data(db: AsyncSession, sheet_id: uuid.UUID, state: bytes | None) -> bool:
    """Bring a closed sheet's workbook JSON (export, search, RAG) up to the
    room's state. True when it changed. Doesn't commit."""
    from app.chat.models import Spreadsheet
    from app.workspaces.sheet_io import flatten_text
    from app.workspaces.sheet_y import data_from_state

    sheet = (
        await db.execute(
            select(Spreadsheet).where(Spreadsheet.id == sheet_id).with_for_update().execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if sheet is None:
        return False
    if state is None:
        state = sheet.yjs_update
    new = data_from_state(sheet.data, state)
    if new == sheet.data:
        return False
    sheet.data = new
    flag_modified(sheet, "data")
    sheet.content_text = flatten_text(new)
    sheet.data_version = (sheet.data_version or 0) + 1
    return True


async def _reindex_later(db: AsyncSession, sheet: Any) -> None:
    """A workspace sheet's chunks follow its new text."""
    if sheet.workspace_id is None:
        return
    from app.background import spawn
    from app.chat.models import WorkspaceItem
    from app.workspaces.knowledge import index_sheet_for_workspace

    item = (
        await db.execute(select(WorkspaceItem).where(WorkspaceItem.ref_id == sheet.id, WorkspaceItem.kind == "sheet"))
    ).scalars().first()
    if item is not None:
        spawn(index_sheet_for_workspace(sheet.workspace_id, item.id), name=f"sheet-index-{sheet.id}")


@dataclass
class SyncResult:
    written: int = 0
    live: bool = False
    problem: str | None = None


async def _owner_tz(db: AsyncSession, form_shell: Any) -> Any:
    from app.auth.models import User
    from app.notifications.quiet import zone_of

    owner = await db.get(User, form_shell.user_id) if form_shell is not None and form_shell.user_id else None
    return zone_of(owner.settings if owner is not None else None)


async def sync_once(
    db: AsyncSession, form_id: uuid.UUID, *, everything: bool = False, lookback: bool = True
) -> tuple[SyncResult, bool]:
    """One batch, in the caller's transaction (commit afterwards). Returns
    ``(result, more)`` — ``more`` when another batch is waiting.
    ``everything``: look at every answer, not only new and changed ones (the
    nightly check; unchanged rows cost no writes). ``lookback``: also the
    answers saved around the last sync (first batch only)."""
    from app.chat.models import Spreadsheet
    from app.collab_internal import CollabUnavailable, SheetWriteMoved, sheet_cells
    from app.files.models import UserFile
    from app.forms.results import names_of
    from app.workspaces.sheet_y import read_state

    res = SyncResult()
    await _lock(db, form_id)
    form = (
        await db.execute(select(Form).where(Form.id == form_id).execution_options(populate_existing=True))
    ).scalar_one_or_none()
    if form is None or form.sheet_tab_id is None:
        return res, False
    if form.sheet_file_id is None:
        res.problem = "deleted"
        return res, False
    shell = await db.get(UserFile, form.sheet_file_id)
    sheet = (
        await db.execute(select(Spreadsheet).where(Spreadsheet.file_id == form.sheet_file_id))
    ).scalar_one_or_none()
    if shell is None or sheet is None:
        res.problem = "deleted"
        return res, False
    if shell.trashed_at is not None:
        form.sheet_error = "trashed"
        res.problem = "trashed"
        return res, False
    if form.sheet_error == "full" and not everything:
        res.problem = "full"
        return res, False

    synced = form.sheet_synced_seq or 0
    base = select(FormResponse).where(FormResponse.form_id == form.id, FormResponse.deleted_at.is_(None))
    if everything:
        rows = list((await db.execute(base.order_by(FormResponse.seq).limit(MAX_ROWS))).scalars().all())
    else:
        rows = list(
            (await db.execute(base.where(FormResponse.seq > synced).order_by(FormResponse.seq).limit(BATCH)))
            .scalars()
            .all()
        )
        if lookback and form.sheet_synced_at is not None:
            # A sequence number is taken a moment before its commit: one taken
            # before the last sync but committed after it would be skipped.
            since = form.sheet_synced_at - LOOKBACK
            again = (
                await db.execute(
                    base.where(
                        FormResponse.seq <= synced,
                        or_(FormResponse.submitted_at >= since, FormResponse.edited_at >= since),
                    ).limit(BATCH)
                )
            ).scalars().all()
            rows = list(again) + rows
    new_rows = [r for r in rows if r.seq > synced]

    form_shell = await db.get(UserFile, form.file_id)
    tz = await _owner_tz(db, form_shell)
    who = await names_of(db, {r.respondent_id for r in rows if r.respondent_id})
    defn = form.definition or {}
    email, account = await _flags(db, form)
    wanted = wanted_columns(defn, email=email, account=account, layout=form.sheet_columns)
    values = [(r.number, row_values(defn, r, who=who, tz=tz)) for r in rows]
    room = f"sheet:{sheet.id}"
    tab_id = form.sheet_tab_id

    state, live = await _room_now(db, sheet)
    p: Plan | None = None
    for _attempt in range(4):
        st = read_state(state)
        cells = _tab_cells(st, sheet.data, tab_id)
        if cells is None:
            if form.sheet_columns:
                form.sheet_error = "tab_deleted"
                res.problem = "tab_deleted"
                return res, False
            cells = {}
        p = plan(cells, form.sheet_columns, wanted, values)
        if not p.cells:
            live_now = live
            stored = None
            break
        try:
            live_now, stored = await sheet_cells(
                room,
                {f"{tab_id}!{r},{c}": v for (r, c), v in p.cells.items()},
                expect={f"{tab_id}!{r},{c}": t for (r, c), t in p.expect.items()},
                tabs={tab_id: {"name": TAB_NAME, "order": 0}},
            )
            break
        except SheetWriteMoved as moved:
            # Someone sorted or typed there since: plan again on what's there now.
            state = moved.state
            p = None
            continue
        except CollabUnavailable as exc:
            logger.info("forms sheet sync for %s waits: %s", form_id, exc)
            form.sheet_error = "waiting"
            res.problem = "waiting"
            return res, False
    if p is None:
        form.sheet_error = "waiting"
        res.problem = "waiting"
        return res, False

    res.written = len(p.cells)
    res.live = bool(live_now)
    if p.cells and not live_now:
        if await rebuild_data(db, sheet.id, stored):
            await _reindex_later(db, sheet)
    elif p.cells and live_now:
        await _reconcile_later(form.id)
    _mark_outside(sheet)
    placed = set(p.placed)
    done = [r.seq for r in rows if r.number in placed]
    if done:
        form.sheet_synced_seq = max(synced, max(done))
    form.sheet_columns = p.layout
    flag_modified(form, "sheet_columns")
    form.sheet_synced_at = datetime.now(timezone.utc)
    if p.full:
        form.sheet_error = "full"
        res.problem = "full"
        return res, False
    form.sheet_error = None
    more = not everything and len(new_rows) >= BATCH and bool(done)
    return res, more


async def sync_form(form_id: uuid.UUID, *, everything: bool = False) -> SyncResult:
    """Bring a form's linked sheet up to date (own sessions, one batch per
    transaction so collab's store never waits on a lock held here)."""
    from app.database import SessionLocal

    total = SyncResult()
    for i in range(50):
        async with SessionLocal() as db:
            try:
                res, more = await sync_once(db, form_id, everything=everything, lookback=i == 0)
                await db.commit()
            except Exception:
                await db.rollback()
                raise
        total.written += res.written
        total.live = total.live or res.live
        total.problem = res.problem
        if not more:
            break
    return total


async def reconcile(form_id: uuid.UUID) -> bool:
    """The workbook JSON of a closed linked sheet follows its room — for an
    editor that closed before its autosave carried the rows."""
    from app.chat.models import Spreadsheet
    from app.collab_internal import live_state
    from app.database import SessionLocal

    async with SessionLocal() as db:
        form = await db.get(Form, form_id)
        if form is None or form.sheet_file_id is None:
            return False
        sheet = (
            await db.execute(select(Spreadsheet).where(Spreadsheet.file_id == form.sheet_file_id))
        ).scalar_one_or_none()
        if sheet is None:
            return False
        if await live_state(f"sheet:{sheet.id}") is not None:
            return False  # still open: its editor saves it
        changed = await rebuild_data(db, sheet.id, None)
        if changed:
            await _reindex_later(db, sheet)
        await db.commit()
        return changed


# --------------------------------------------------------------------
# Queueing
# --------------------------------------------------------------------
SYNC_JOB = "forms_sheet_sync_job"
RECONCILE_JOB = "forms_sheet_reconcile_job"


async def enqueue_sync(form_id: uuid.UUID) -> None:
    """Sync on the worker soon; inline here when the queue is down."""
    try:
        from app.tasks.queue import get_pool

        pool = await get_pool()
        await pool.enqueue_job(SYNC_JOB, str(form_id), _job_id=f"forms-sheet-{form_id}-{uuid.uuid4().hex[:8]}")
        return
    except Exception:  # noqa: BLE001 — never let queueing break an answer
        logger.warning("forms sheet sync: queue unavailable, running here", exc_info=True)
    from app.background import spawn

    spawn(_safe_sync(form_id), name=f"forms-sheet-{form_id}")


async def _safe_sync(form_id: uuid.UUID) -> None:
    try:
        await sync_form(form_id)
    except Exception:  # noqa: BLE001 — the catch-up tick tries again
        logger.exception("forms sheet sync failed for %s", form_id)


def sync_soon(form: Form) -> None:
    """After a commit that changed what the sheet should show (an answer,
    an edit, the questions, the settings): queue a sync if linked."""
    if form.sheet_tab_id is None or form.sheet_file_id is None:
        return
    from app.background import spawn

    spawn(enqueue_sync(form.id), name=f"forms-sheet-q-{form.id}")


async def _reconcile_later(form_id: uuid.UUID) -> None:
    import time

    try:
        from app.tasks.queue import get_pool

        pool = await get_pool()
        bucket = int(time.time() // RECONCILE_AFTER_S)
        await pool.enqueue_job(
            RECONCILE_JOB,
            str(form_id),
            _defer_by=timedelta(seconds=RECONCILE_AFTER_S),
            _job_id=f"forms-sheet-rec-{form_id}-{bucket}",
        )
    except Exception:  # noqa: BLE001 — the nightly check covers it
        logger.info("forms sheet reconcile not queued for %s", form_id, exc_info=True)


async def tick() -> int:
    """Cron: linked sheets with answers still to write (collab was down, or a
    sync was lost) catch up."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        ids = (
            await db.execute(
                select(Form.id).where(
                    Form.sheet_tab_id.is_not(None),
                    Form.sheet_file_id.is_not(None),
                    or_(
                        Form.sheet_error == "waiting",
                        select(FormResponse.id)
                        .where(
                            FormResponse.form_id == Form.id,
                            FormResponse.deleted_at.is_(None),
                            FormResponse.seq > Form.sheet_synced_seq,
                        )
                        .exists(),
                    ),
                )
            )
        ).scalars().all()
    n = 0
    for fid in ids:
        try:
            await sync_form(fid)
            n += 1
        except Exception:  # noqa: BLE001 — one bad form doesn't stop the rest
            logger.exception("forms sheet tick failed for %s", fid)
    return n


async def nightly() -> int:
    """Cron: every linked sheet is checked against every answer (nothing is
    written where it already matches), and a closed sheet's workbook JSON is
    brought up to its room."""
    from app.database import SessionLocal

    async with SessionLocal() as db:
        ids = (
            await db.execute(select(Form.id).where(Form.sheet_tab_id.is_not(None), Form.sheet_file_id.is_not(None)))
        ).scalars().all()
    n = 0
    for fid in ids:
        try:
            await sync_form(fid, everything=True)
            await reconcile(fid)
            n += 1
        except Exception:  # noqa: BLE001
            logger.exception("forms sheet nightly failed for %s", fid)
    return n


__all__ = [
    "ERRORS",
    "MAX_ROWS",
    "TAB_NAME",
    "Plan",
    "SheetLinkError",
    "SyncResult",
    "cell_text",
    "enqueue_sync",
    "header_tab",
    "link_existing",
    "link_new",
    "locate_columns",
    "nightly",
    "plan",
    "rebuild_data",
    "reconcile",
    "row_values",
    "status",
    "sync_form",
    "sync_once",
    "sync_soon",
    "text_cell",
    "tick",
    "unlink",
    "wanted_columns",
]
