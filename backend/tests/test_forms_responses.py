"""The Responses tab (WP-F1.4): the summary's maths, every answer to one
question, one answer at a time, deleting answers (the option places, the
answer count and the owner's storage all given back), and downloads that
open cleanly and never run a formula someone typed into an answer.
"""
from __future__ import annotations

import csv
import io
import time
import uuid

import httpx
import pytest


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.forms import notify
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    # Pushes have their own tests (test_forms_notify.py).
    monkeypatch.setattr(notify, "answer_arrived", lambda form_id: None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name, **settings):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role="user", settings=settings or {})
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def opt(oid, label, limit=None):
    return {"id": oid, "label": label, "go_to": None, "limit": limit, "image_asset_id": None}


def q(iid, kind, title=None, required=False, **config):
    return {"id": iid, "kind": kind, "title": title or iid, "description": "", "image_asset_id": None,
            "required": required, "config": config, "deleted": False}


DEFN = {
    "version": 1, "title": "BBQ RSVP", "description": "", "after": "continue",
    "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
    "items": [
        q("name", "short_text", "Your name"),
        q("coming", "multiple_choice", "Coming?", options=[opt("yes", "Yes"), opt("no", "No"), opt("maybe", "Maybe")], other=True),
        q("dish", "checkboxes", "What will you bring?", options=[opt("salad", "Salad", limit=2), opt("cake", "Cake"), opt("bread", "Bread")]),
        q("score", "linear_scale", "How hungry?", min=1, max=5, min_label="A bit", max_label="Starving"),
        q("stars", "rating", "Last year's BBQ", max=5),
        q("day", "date", "Best day"),
        q("arrive", "time", "Arriving at"),
        q("notes", "paragraph", "Anything else?"),
    ],
}


class F:
    def __init__(self, fid, form_id, token):
        self.fid, self.form_id, self.token = fid, form_id, token


async def make_form(client, owner, definition=DEFN, **settings) -> F:
    r = await client.post("/api/forms", json={}, headers=H(owner))
    fid = r.json()["file"]["id"]
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": definition, "data_version": 1}, headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True, "audience": "link", **settings}, headers=H(owner))
    assert r.status_code == 200, r.text
    view = (await client.post(f"/api/forms/{fid}/link", json={}, headers=H(owner))).json()
    return F(fid, uuid.UUID(view["form"]["id"]), view["link"]["token"])


async def answer(client, f: F, answers, **extra):
    from app.forms import abuse

    body = {"answers": answers, "submit_id": str(uuid.uuid4()),
            "start_token": abuse.start_token(f.form_id, now=time.time() - 30), **extra}
    r = await client.post(f"/api/f/{f.token}/submit", json=body)
    assert r.status_code == 200, r.text
    return r.json()["number"]


async def form_row(db, form_id):
    from sqlalchemy import select

    from app.forms.models import Form

    return (await db.execute(select(Form).where(Form.id == form_id).execution_options(populate_existing=True))).scalar_one()


async def counts(db, form_id):
    from sqlalchemy import select

    from app.forms.models import FormOptionCount

    rows = (await db.execute(select(FormOptionCount).where(FormOptionCount.form_id == form_id)
                             .execution_options(populate_existing=True))).scalars().all()
    return {(r.question_id, r.option_id): r.taken for r in rows if r.taken}


async def shell_size(db, fid):
    from app.files.models import UserFile

    row = await db.get(UserFile, uuid.UUID(fid), populate_existing=True)
    return row.size_bytes


async def fill(client, f):
    n1 = await answer(client, f, {"name": "Ann", "coming": {"option": "yes"}, "dish": {"options": ["salad", "cake"]},
                                  "score": 5, "stars": 4, "day": "2026-12-05", "arrive": "18:30", "notes": "Bringing a friend"})
    n2 = await answer(client, f, {"name": "Bo", "coming": {"option": "yes"}, "dish": {"options": ["salad"]},
                                  "score": 3, "stars": 5, "day": "2026-12-05", "arrive": "19:00"})
    n3 = await answer(client, f, {"name": "=HYPERLINK(\"http://evil\",\"x\")", "coming": {"other": "Only for dessert"},
                                  "dish": {"options": ["bread"]}, "score": 3, "day": "2026-12-06", "notes": "@SUM(1+1)"})
    n4 = await answer(client, f, {"name": "Di", "coming": {"option": "no"}})
    return n1, n2, n3, n4


# ------------------------------------------------------------------ summary
async def test_summary_maths(client, db):
    owner = await mk_user(db, "ann")
    f = await make_form(client, owner)
    await fill(client, f)
    r = await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["total"] == 4 and s["first_number"] == 1 and s["latest_number"] == 4
    assert s["new_count"] == 4 and s["can_delete"] is True
    by = {b["id"]: b for b in s["questions"]}
    assert [b["id"] for b in s["questions"]] == ["name", "coming", "dish", "score", "stars", "day", "arrive", "notes"]

    coming = by["coming"]
    assert coming["answered"] == 4
    assert {o["id"]: o["count"] for o in coming["options"]} == {"yes": 2, "no": 1, "maybe": 0}
    assert coming["other"] == 1

    dish = by["dish"]
    assert dish["answered"] == 3
    assert {o["id"]: o["count"] for o in dish["options"]} == {"salad": 2, "cake": 1, "bread": 1}
    salad = next(o for o in dish["options"] if o["id"] == "salad")
    assert salad["limit"] == 2 and salad["taken"] == 2  # "Salad 2/2 (full)"
    assert next(o for o in dish["options"] if o["id"] == "cake")["limit"] is None

    score = by["score"]
    assert [b["count"] for b in score["bins"]] == [0, 0, 2, 0, 1]
    assert [b["value"] for b in score["bins"]] == [1, 2, 3, 4, 5]
    assert score["average"] == round(11 / 3, 2) and score["min_label"] == "A bit"
    stars = by["stars"]
    assert [b["count"] for b in stars["bins"]] == [0, 0, 0, 1, 1] and stars["average"] == 4.5

    assert by["day"]["groups"] == [{"value": "2026-12-05", "count": 2}, {"value": "2026-12-06", "count": 1}]
    assert by["arrive"]["groups"] == [{"value": "18:30", "count": 1}, {"value": "19:00", "count": 1}]

    notes = by["notes"]
    assert notes["answered"] == 2
    assert [x["number"] for x in notes["latest"]] == [3, 1]  # newest first
    assert notes["latest"][0]["text"] == "@SUM(1+1)"  # shown as text, as typed
    assert [x["text"] for x in by["name"]["latest"]] == ["Di", "=HYPERLINK(\"http://evil\",\"x\")", "Bo", "Ann"]


async def test_summary_empty_and_deleted_question(client, db):
    owner = await mk_user(db, "ann")
    f = await make_form(client, owner)
    s = (await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))).json()
    assert s["total"] == 0 and s["latest_number"] is None and s["new_count"] == 0
    assert all(b["answered"] == 0 for b in s["questions"])

    await answer(client, f, {"name": "Ann", "notes": "hi"})
    # Delete the paragraph from the form: it has answers, so it's kept as deleted.
    view = (await client.get(f"/api/forms/{f.fid}", headers=H(owner))).json()
    d = view["form"]["definition"]
    d["items"] = [i for i in d["items"] if i["id"] != "notes"]
    r = await client.put(f"/api/forms/{f.fid}/definition", json={"definition": d, "data_version": view["form"]["data_version"]}, headers=H(owner))
    assert r.status_code == 200, r.text
    s = (await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))).json()
    assert s["questions"][-1]["id"] == "notes" and s["questions"][-1]["deleted"] is True
    one = (await client.get(f"/api/forms/{f.fid}/responses/1", headers=H(owner))).json()
    assert one["answers"][-1] == {"id": "notes", "title": "Anything else?", "kind": "paragraph", "deleted": True,
                                  "answered": True, "text": "hi"}


# ------------------------------------------------------------------ one question / one answer
async def test_question_view_pages_and_search(client, db, monkeypatch):
    from app.forms import results

    monkeypatch.setattr(results, "PAGE", 2)
    owner = await mk_user(db, "ann")
    f = await make_form(client, owner)
    await fill(client, f)
    r = await client.get(f"/api/forms/{f.fid}/responses", params={"question": "name"}, headers=H(owner))
    body = r.json()
    assert [i["number"] for i in body["items"]] == [4, 3] and body["next_before"] == 3
    assert body["items"][0]["who"] == {"kind": "link", "name": "Someone with the link"}
    r = await client.get(f"/api/forms/{f.fid}/responses", params={"question": "name", "before": 3}, headers=H(owner))
    assert [i["number"] for i in r.json()["items"]] == [2, 1] and r.json()["next_before"] is None
    # Search a text question; % and _ are plain characters.
    r = await client.get(f"/api/forms/{f.fid}/responses", params={"question": "notes", "q": "friend"}, headers=H(owner))
    assert [i["text"] for i in r.json()["items"]] == ["Bringing a friend"]
    r = await client.get(f"/api/forms/{f.fid}/responses", params={"question": "notes", "q": "%"}, headers=H(owner))
    assert r.json()["items"] == []
    # A choice's "Other" is searchable; choices read as their labels.
    r = await client.get(f"/api/forms/{f.fid}/responses", params={"question": "coming", "q": "dessert"}, headers=H(owner))
    assert [i["text"] for i in r.json()["items"]] == ["Other: Only for dessert"]
    r = await client.get(f"/api/forms/{f.fid}/responses", params={"question": "dish"}, headers=H(owner))
    assert r.json()["items"][-1]["text"] == "Salad"
    assert (await client.get(f"/api/forms/{f.fid}/responses", params={"question": "nope"}, headers=H(owner))).status_code == 404


async def test_one_answer_and_who(client, db):
    owner = await mk_user(db, "ann")
    bo = await mk_user(db, "bo", display_name="Bo Peep")
    f = await make_form(client, owner, collect_email=True)
    await answer(client, f, {"name": "Ann"}, email="ann@example.com")
    await client.patch(f"/api/forms/{f.fid}/settings", json={"collect_email": False}, headers=H(owner))
    await answer(client, f, {"name": "x"})
    # A server answer from Bo.
    await client.patch(f"/api/forms/{f.fid}/settings", json={"audience": "server"}, headers=H(owner))
    from app.forms import abuse

    r = await client.post(f"/api/f/{f.token}/submit", headers=H(bo), json={
        "answers": {"name": "Bo"}, "submit_id": str(uuid.uuid4()), "start_token": abuse.start_token(f.form_id, now=time.time() - 30)})
    assert r.status_code == 200, r.text

    one = (await client.get(f"/api/forms/{f.fid}/responses/2", headers=H(owner))).json()
    assert one["position"] == 2 and one["total"] == 3 and one["prev"] == 1 and one["next"] == 3
    assert one["who"] == {"kind": "link", "name": "Someone with the link"}
    first = (await client.get(f"/api/forms/{f.fid}/responses/1", headers=H(owner))).json()
    assert first["who"] == {"kind": "email", "name": "ann@example.com"} and first["prev"] is None
    last = (await client.get(f"/api/forms/{f.fid}/responses/3", headers=H(owner))).json()
    assert last["who"] == {"kind": "account", "name": "Bo Peep"} and last["next"] is None
    assert last["answers"][0] == {"id": "name", "title": "Your name", "kind": "short_text", "deleted": False,
                                  "answered": True, "text": "Bo"}
    assert last["answers"][1]["answered"] is False
    assert (await client.get(f"/api/forms/{f.fid}/responses/9", headers=H(owner))).status_code == 404


async def test_access_read_grant_sees_but_cannot_delete(client, db):
    owner = await mk_user(db, "ann")
    reader = await mk_user(db, "rae")
    stranger = await mk_user(db, "sid")
    f = await make_form(client, owner)
    await answer(client, f, {"name": "Ann"})
    r = await client.post(f"/api/files/file/{f.fid}/grants", json={"grantee_user_id": str(reader.id), "can_edit": False},
                          headers=H(owner))
    assert r.status_code in (200, 201), r.text
    s = await client.get(f"/api/forms/{f.fid}/summary", headers=H(reader))
    assert s.status_code == 200 and s.json()["can_delete"] is False
    assert (await client.get(f"/api/forms/{f.fid}/export", headers=H(reader))).status_code == 200
    assert (await client.delete(f"/api/forms/{f.fid}/responses/1", headers=H(reader))).status_code == 404
    assert (await client.delete(f"/api/forms/{f.fid}/responses", headers=H(reader))).status_code == 404
    for path in ("summary", "responses/1", "export", "responses?question=name"):
        assert (await client.get(f"/api/forms/{f.fid}/{path}", headers=H(stranger))).status_code == 404, path


# ------------------------------------------------------------------ deleting
async def test_delete_gives_back_places_count_and_size(client, db):
    owner = await mk_user(db, "ann")
    f = await make_form(client, owner, max_responses=4)
    before = await shell_size(db, f.fid)
    n1, n2, n3, n4 = await fill(client, f)
    assert await counts(db, f.form_id) == {("coming", "yes"): 2, ("coming", "no"): 1,
                                           ("dish", "salad"): 2, ("dish", "cake"): 1, ("dish", "bread"): 1}
    full = await shell_size(db, f.fid)
    assert full > before
    # Full: the form closed on its count.
    assert (await client.get(f"/api/f/{f.token}")).json()["state"] == "closed"

    r = await client.delete(f"/api/forms/{f.fid}/responses/{n1}", headers=H(owner))
    assert r.status_code == 200 and r.json() == {"deleted": 1, "response_count": 3}
    assert await counts(db, f.form_id) == {("coming", "yes"): 1, ("coming", "no"): 1,
                                           ("dish", "salad"): 1, ("dish", "bread"): 1}
    form = await form_row(db, f.form_id)
    assert form.response_count == 3 and form.next_number == 5
    assert before < await shell_size(db, f.fid) < full
    # A place on Salad is free again, and the form takes one more answer.
    assert (await client.get(f"/api/f/{f.token}")).json()["state"] == "open"
    n5 = await answer(client, f, {"name": "Eve", "dish": {"options": ["salad"]}})
    assert n5 == 5  # numbers are never reused
    assert (await client.get(f"/api/forms/{f.fid}/responses/{n1}", headers=H(owner))).status_code == 404
    assert (await client.delete(f"/api/forms/{f.fid}/responses/{n1}", headers=H(owner))).status_code == 404
    s = (await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))).json()
    assert s["total"] == 4 and s["first_number"] == 2

    # Delete all: counters to zero, size back to just the questions.
    r = await client.delete(f"/api/forms/{f.fid}/responses", headers=H(owner))
    assert r.json() == {"deleted": 4, "response_count": 0}
    assert await counts(db, f.form_id) == {}
    assert await shell_size(db, f.fid) == before
    form = await form_row(db, f.form_id)
    assert form.response_count == 0 and form.next_number == 6
    assert (await client.get(f"/api/forms/{f.fid}/summary", headers=H(owner))).json()["total"] == 0


# ------------------------------------------------------------------ downloads
def test_neutralise_and_shapes():
    from app.forms.export import answer_text, neutralise

    for bad in ("=1+1", "+1", "-1", "@x", "\tx", "\rx"):
        assert neutralise(bad) == "'" + bad
    assert neutralise("hello") == "hello" and neutralise("") == ""
    mc = q("m", "multiple_choice", options=[opt("a", "Apple")])
    assert answer_text(mc, {"option": "a"}) == "Apple"
    assert answer_text(mc, {"other": "Pear"}) == "Other: Pear"
    assert answer_text(mc, "a") == "Apple"  # older shape
    cb = q("c", "checkboxes", options=[opt("a", "Apple"), opt("b", "")])
    assert answer_text(cb, {"options": ["a", "b"], "other": "Fig"}) == "Apple; (no label); Other: Fig"
    # A question whose type changed keeps old answers as text.
    assert answer_text(q("t", "short_text"), {"option": "a"}) == '{"option": "a"}'


async def test_export_csv_and_xlsx_are_formula_safe(client, db):
    from openpyxl import load_workbook

    owner = await mk_user(db, "ann", timezone="Australia/Sydney")
    f = await make_form(client, owner)
    await fill(client, f)

    r = await client.get(f"/api/forms/{f.fid}/export", params={"format": "csv"}, headers=H(owner))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "BBQ%20RSVP%20%28Responses%29.csv" in r.headers["content-disposition"]
    text = r.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0][:4] == ["Response #", "Submitted", "Edited", "Your name"]
    assert len(rows) == 5
    third = rows[3]
    assert third[3] == "'=HYPERLINK(\"http://evil\",\"x\")"
    assert third[4] == "Other: Only for dessert"
    assert third[-1] == "'@SUM(1+1)"
    assert rows[1][5] == "Salad; Cake"
    # Times in the downloader's own zone (Sydney is UTC+11 in December/November).
    for row in rows[1:]:
        for cell in row:
            assert not cell.startswith(("=", "+", "-", "@", "\t", "\r")), cell

    r = await client.get(f"/api/forms/{f.fid}/export", params={"format": "xlsx"}, headers=H(owner))
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
    wb = load_workbook(io.BytesIO(r.content))
    ws = wb.active
    assert ws.title == "Responses"
    values = [[c.value for c in row] for row in ws.iter_rows()]
    assert values[0][:4] == ["Response #", "Submitted", "Edited", "Your name"]
    assert values[1][0] == 1 and isinstance(values[1][0], int)
    header = values[0]
    assert values[1][header.index("How hungry?")] == 5
    for row in ws.iter_rows():
        for c in row:
            assert c.data_type != "f", c.coordinate
    assert values[3][3] == "'=HYPERLINK(\"http://evil\",\"x\")"
    assert (await client.get(f"/api/forms/{f.fid}/export", params={"format": "pdf"}, headers=H(owner))).status_code == 422


async def test_export_times_in_own_zone(client, db):
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    owner = await mk_user(db, "ann", timezone="Australia/Sydney")
    f = await make_form(client, owner)
    await answer(client, f, {"name": "Ann"})
    r = await client.get(f"/api/forms/{f.fid}/export", headers=H(owner))
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    got = datetime.strptime(rows[1][1], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("Australia/Sydney"))
    assert abs((datetime.now(timezone.utc) - got).total_seconds()) < 120
