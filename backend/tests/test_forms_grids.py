"""Forms phase 2, WP-F2.1: multiple-choice grids and checkbox grids.

* the definition: caps (20 rows, 8 columns, 40-character columns), stable
  ids, one-per-column needing enough columns, kinds round-tripping;
* answer shapes: each row, one per column, required = any row, rows and
  columns that aren't on the form refused, unanswered rows dropped;
* a whole submit through the answer link, then the summary's counts per
  row, the question and individual views as text;
* downloads and the linked Sheet: one column per row "Question [Row]",
  keyed ``q:<id>:<row>``, a renamed row renaming its header only when the
  header still says the old words;
* a kind change keeps old answers readable as text.
"""
from __future__ import annotations

import time
import uuid

import httpx
import pytest


# ------------------------------------------------------------------ helpers
def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


def grid(iid, kind="choice_grid", *, rows=("Mon", "Tue", "Wed"), cols=("Morning", "Evening"), required=False, **extra):
    cfg = {
        "rows": [{"id": f"r{i}", "label": label} for i, label in enumerate(rows, start=1)],
        "columns": [{"id": f"c{i}", "label": label} for i, label in enumerate(cols, start=1)],
        **extra,
    }
    return {"id": iid, "kind": kind, "title": "When can you help?", "description": "", "image_asset_id": None,
            "required": required, "config": cfg, "deleted": False}


def defn(items, title="Grid test"):
    return {"version": 1, "title": title, "description": "", "after": "continue",
            "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
            "items": items}


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.forms import notify, sheet
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(notify, "answer_arrived", lambda form_id: None)
    monkeypatch.setattr(sheet, "sync_soon", lambda form: None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def make_form(client, owner, definition, **settings):
    r = await client.post("/api/forms", json={}, headers=H(owner))
    assert r.status_code == 201, r.text
    fid = r.json()["file"]["id"]
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": definition, "data_version": 1},
                         headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True, **settings}, headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/forms/{fid}/link", json={}, headers=H(owner))
    assert r.status_code == 200, r.text
    view = r.json()
    return fid, uuid.UUID(view["form"]["id"]), view["link"]["token"]


async def send(client, form_id, token, answers):
    from app.forms import abuse

    body = {"answers": answers, "submit_id": str(uuid.uuid4()),
            "start_token": abuse.start_token(form_id, now=time.time() - 30)}
    return await client.post(f"/api/f/{token}/submit", json=body)


# ------------------------------------------------------------------ the definition
def test_grid_definition_caps_and_ids():
    from app.forms.definition import DefinitionError, validate_definition

    ok = validate_definition(defn([grid("g"), grid("h", "checkbox_grid")]))
    g = ok["items"][0]["config"]
    assert g == {
        "rows": [{"id": "r1", "label": "Mon"}, {"id": "r2", "label": "Tue"}, {"id": "r3", "label": "Wed"}],
        "columns": [{"id": "c1", "label": "Morning"}, {"id": "c2", "label": "Evening"}],
        "each_row": False, "shuffle_rows": False, "one_per_column": False,
    }
    assert "one_per_column" not in ok["items"][1]["config"]  # choice grids only

    def refused(d) -> str:
        with pytest.raises(DefinitionError) as e:
            validate_definition(d)
        return str(e.value)

    assert "at most 20 rows" in refused(defn([grid("g", rows=[f"R{i}" for i in range(21)])]))
    assert "at most 8 columns" in refused(defn([grid("g", cols=[f"C{i}" for i in range(9)])]))
    assert "at most 40 characters" in refused(defn([grid("g", cols=["x" * 41])]))
    dup = grid("g")
    dup["config"]["rows"][1]["id"] = "r1"
    assert "same id" in refused(defn([dup]))
    assert "at least as many columns as rows" in refused(
        defn([grid("g", one_per_column=True, each_row=True, rows=("a", "b", "c"), cols=("1", "2"))])
    )
    assert "one_per_column" in refused(defn([grid("g", "checkbox_grid", one_per_column=True)]))
    # 20 × 8 with 40-character columns is fine.
    validate_definition(defn([grid("g", rows=[f"Row {i}" for i in range(20)], cols=["y" * 40] * 8)]))


def test_grid_answer_checks():
    from app.forms import answering as ans
    from app.forms.definition import validate_definition

    d = validate_definition(defn([
        grid("g", each_row=True),
        grid("rank", one_per_column=True, rows=("Tea", "Coffee"), cols=("1st", "2nd")),
        grid("cb", "checkbox_grid"),
    ]))
    g, rank, cb = d["items"]

    def err(item, v):
        with pytest.raises(ans.AnswerError) as e:
            ans.check_one(item, v)
        assert e.value.question_id == item["id"]
        return str(e.value)

    full = {"rows": {"r1": "c1", "r2": "c2", "r3": "c1"}}
    assert ans.check_one(g, full) == full
    assert err(g, {"rows": {"r1": "c1"}}) == "Answer every row."
    assert err(g, {"rows": {"r1": "c1", "r2": "c2", "r9": "c1"}}) == "A row you answered isn't on the form any more."
    assert err(g, {"rows": {"r1": "c9", "r2": "c2", "r3": "c1"}}) == "A column you picked isn't on the form any more."
    assert err(g, {"rows": {"r1": ["c1"], "r2": "c2", "r3": "c1"}}) == "Pick one answer in each row."
    assert err(g, {"rows": [], "x": 1}) == "Pick your answers in the grid again."
    assert err(g, "Mon") == "Pick your answers in the grid again."
    assert err(rank, {"rows": {"r1": "c1", "r2": "c1"}}) == "Pick each column in one row only."
    assert ans.check_one(rank, {"rows": {"r2": "c1", "r1": "c2"}}) == {"rows": {"r1": "c2", "r2": "c1"}}
    # Checkbox grids: lists, unanswered rows dropped, no doubles.
    assert ans.check_one(cb, {"rows": {"r1": ["c1", "c2"], "r2": [], "r3": None}}) == {"rows": {"r1": ["c1", "c2"]}}
    assert err(cb, {"rows": {"r1": ["c1", "c1"]}}) == "A box in the grid was ticked twice."
    assert err(cb, {"rows": {"r1": "c1"}}) == "Pick your answers in the grid again."
    assert err(cb, {"rows": {"r1": ["zz"]}}) == "A column you picked isn't on the form any more."
    # Empty: nothing in any row.
    assert ans.is_empty(cb, {"rows": {"r1": [], "r2": None}})
    assert ans.is_empty(g, {"rows": {}})
    assert not ans.is_empty(g, {"rows": {"r1": "c1"}})


def test_required_grid_means_any_row():
    from app.forms import answering as ans
    from app.forms.definition import validate_definition

    d = validate_definition(defn([grid("g", required=True)]))
    clean, _ = ans.check_answers(d, {"g": {"rows": {"r2": "c1"}}})
    assert clean == {"g": {"rows": {"r2": "c1"}}}
    with pytest.raises(ans.AnswerError) as e:
        ans.check_answers(d, {"g": {"rows": {}}})
    assert str(e.value) == "This question needs an answer." and e.value.question_id == "g"


# ------------------------------------------------------------------ answering, summary, views
async def test_grid_answers_summary_and_views(client, db, user):
    d = defn([grid("g", required=True), grid("cb", "checkbox_grid", rows=("Sat", "Sun"), cols=("Bring food", "Help set up"))])
    fid, form_id, token = await make_form(client, user, d, audience="link")
    page = (await client.get(f"/api/f/{token}")).json()
    assert page["definition"]["items"][0]["config"]["rows"][0] == {"id": "r1", "label": "Mon"}
    for answers in (
        {"g": {"rows": {"r1": "c1", "r2": "c1"}}, "cb": {"rows": {"r1": ["c1", "c2"], "r2": ["c2"]}}},
        {"g": {"rows": {"r1": "c2"}}, "cb": {"rows": {"r1": ["c1"]}}},
        {"g": {"rows": {"r3": "c2"}}},
    ):
        r = await send(client, form_id, token, answers)
        assert r.status_code == 200, r.text
    # Refused by the server even though a page might let it through.
    r = await send(client, form_id, token, {"g": {"rows": {"r1": "nope"}}})
    assert r.status_code == 422 and r.json()["detail"]["question_id"] == "g"

    s = (await client.get(f"/api/forms/{fid}/summary", headers=H(user))).json()
    qg, qcb = s["questions"]
    assert qg["answered"] == 3
    assert qg["columns"] == [{"id": "c1", "label": "Morning"}, {"id": "c2", "label": "Evening"}]
    assert [(row["label"], row["answered"], row["counts"]) for row in qg["rows"]] == [
        ("Mon", 2, {"c1": 1, "c2": 1}),
        ("Tue", 1, {"c1": 1, "c2": 0}),
        ("Wed", 1, {"c1": 0, "c2": 1}),
    ]
    assert [row["counts"] for row in qcb["rows"]] == [{"c1": 2, "c2": 1}, {"c1": 0, "c2": 1}]

    one = (await client.get(f"/api/forms/{fid}/responses/1", headers=H(user))).json()
    texts = {a["id"]: a["text"] for a in one["answers"]}
    assert texts["g"] == "Mon: Morning; Tue: Morning"
    assert texts["cb"] == "Sat: Bring food, Help set up; Sun: Help set up"
    qa = (await client.get(f"/api/forms/{fid}/responses", params={"question": "g"}, headers=H(user))).json()
    assert [i["text"] for i in qa["items"]] == ["Wed: Evening", "Mon: Evening", "Mon: Morning; Tue: Morning"]

    # Downloads: one column per row, formula-safe like the rest.
    r = await client.get(f"/api/forms/{fid}/export", params={"format": "csv"}, headers=H(user))
    head = r.content.decode("utf-8-sig").splitlines()[0]
    assert head.endswith(
        "When can you help? [Mon],When can you help? [Tue],When can you help? [Wed],"
        "When can you help? [Sat],When can you help? [Sun]"
    )
    first = r.content.decode("utf-8-sig").splitlines()[1]
    assert first.endswith("Morning,Morning,,\"Bring food, Help set up\",Help set up")


async def test_chat_tool_reads_grid_counts(client, db, user):
    from app.chat.tools.base import ToolContext
    from app.chat.tools.forms import ReadFormResponsesTool

    fid, form_id, token = await make_form(client, user, defn([grid("g")]), audience="link")
    assert (await send(client, form_id, token, {"g": {"rows": {"r1": "c2"}}})).status_code == 200
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = await ReadFormResponsesTool().run(ctx, {"form": fid})
    assert "- Mon: Morning: 0, Evening: 1" in out.content
    assert ctx.turn["untrusted"] is True


# ------------------------------------------------------------------ the linked sheet (pure)
def test_sheet_columns_per_row_and_rename_rule():
    from types import SimpleNamespace

    from app.forms.sheet import cell_text, plan, row_values, wanted_columns

    d = defn([grid("g"), grid("cb", "checkbox_grid", rows=("Sat",), cols=("Food", "Set up"))])
    wanted = wanted_columns(d, email=False, account=False)
    assert wanted[3:] == [
        ("q:g:r1", "When can you help? [Mon]"),
        ("q:g:r2", "When can you help? [Tue]"),
        ("q:g:r3", "When can you help? [Wed]"),
        ("q:cb:r1", "When can you help? [Sat]"),
    ]
    resp = SimpleNamespace(number=1, submitted_at=None, edited_at=None, email=None, respondent_id=None,
                           answers={"g": {"rows": {"r2": "c2"}}, "cb": {"rows": {"r1": ["c1", "c2"]}}})
    vals = row_values(d, resp)
    assert vals["q:g:r1"] == "" and vals["q:g:r2"] == "Evening" and vals["q:cb:r1"] == "Food, Set up"
    first = plan({}, None, wanted, [(1, vals)])
    texts = {pos: cell_text(v) for pos, v in first.cells.items() if v is not None}
    assert texts[(0, 4)] == "When can you help? [Tue]" and texts[(1, 4)] == "Evening"
    grid_now = {pos: v for pos, v in first.cells.items() if v is not None}

    # Rename row Tue → Tuesday: its header follows. Mon's header was edited
    # by hand, so renaming Mon leaves the hand-made header alone.
    grid_now[(0, 3)] = {"v": "Monday shift", "m": "Monday shift"}
    d2 = defn([grid("g", rows=("Monday", "Tuesday", "Wed")), grid("cb", "checkbox_grid", rows=("Sat",), cols=("Food", "Set up"))])
    wanted2 = wanted_columns(d2, email=False, account=False, layout=first.layout)
    p = plan(grid_now, first.layout, wanted2, [(1, row_values(d2, resp))])
    t = {pos: cell_text(v) for pos, v in p.cells.items() if v is not None}
    assert t[(0, 4)] == "When can you help? [Tuesday]"
    assert (0, 3) not in p.cells


# ------------------------------------------------------------------ kind changes
def test_kind_change_keeps_old_answers_as_text():
    from app.forms.export import answer_text

    was_choice = {"id": "q", "kind": "choice_grid", "title": "Q", "config": {"rows": [], "columns": []}}
    assert answer_text(was_choice, {"option": "o1"}) == '{"option": "o1"}'
    was_grid = {"id": "q", "kind": "multiple_choice", "title": "Q", "config": {"options": []}}
    assert answer_text(was_grid, {"rows": {"r1": "c1"}}) == '{"rows": {"r1": "c1"}}'
    # A row removed from the grid since still reads.
    g = grid("g")
    assert "(removed row): Morning" in answer_text(g, {"rows": {"r1": "c2", "gone": "c1"}})


def test_ai_drafts_grids():
    from app.forms.ai import DRAFT_KINDS, items_from

    assert "choice_grid" in DRAFT_KINDS and "checkbox_grid" in DRAFT_KINDS
    out = items_from({"title": "Rota", "items": [
        {"kind": "choice_grid", "title": "Which shift?", "rows": ["Mon", "Tue", "Mon"], "columns": ["AM", "PM"]},
        {"kind": "checkbox_grid", "title": "Broken, no columns", "rows": ["A"]},
    ]})
    [it] = out["items"]
    assert [r["label"] for r in it["config"]["rows"]] == ["Mon", "Tue"]
    assert [c["label"] for c in it["config"]["columns"]] == ["AM", "PM"]
