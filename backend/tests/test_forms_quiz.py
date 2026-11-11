"""Forms phase 2, WP-F2.3: quizzes.

* ``quiz.mark`` per kind: choices (any of several right), checkboxes (the
  exact set), short answers (case, spaces, trailing full stops, numbers),
  grids per row, "Other" never right by itself, blanks score 0, paragraphs
  pending until marked by hand;
* the answer page never sees a key (``GET /api/f/{token}`` and ``mine``);
* marking on submit; changing an answer marks it again and keeps the
  owner's marks only for answers that didn't change;
* a key change re-marks old answers (the regrade job) and the Sheet's Score
  follows;
* release now / later / partly ("still to mark"), one push per signed-in
  person, never to link answers;
* the results link: the right one shows your marks, a wrong one or someone
  else's is a 404;
* showing the correct answers turns "change your answer" off (and back);
* the Scores list: read grant yes, no grant and admins 404.
"""
from __future__ import annotations

import time
import uuid

import httpx
import pytest


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


def opt(oid, label):
    return {"id": oid, "label": label, "go_to": None, "limit": None, "image_asset_id": None}


def item(iid, kind, title=None, quiz=None, required=False, **config):
    out = {"id": iid, "kind": kind, "title": title or iid, "description": "", "image_asset_id": None,
           "required": required, "config": config, "deleted": False}
    if quiz is not None:
        out["quiz"] = quiz
    return out


def Q(points=1, **key):
    return {"points": points, "key": key or None, "feedback_right": "", "feedback_wrong": ""}


def defn(items, title="Family trivia"):
    return {"version": 1, "title": title, "description": "", "after": "continue",
            "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
            "items": items}


CAPITAL = item("cap", "multiple_choice", "Capital of Australia?", options=[opt("syd", "Sydney"), opt("cbr", "Canberra"),
               opt("mel", "Melbourne")], other=True, quiz={**Q(2, options=["cbr"]), "feedback_right": "Yes!",
                                                          "feedback_wrong": "It's Canberra."})
PRIMES = item("primes", "checkboxes", "Tick the primes", options=[opt("2", "2"), opt("4", "4"), opt("5", "5")],
              quiz=Q(2, options=["2", "5"]))
SUM = item("sum", "short_text", "What is 6 × 7?", validation={"kind": "number", "min": None, "max": None, "integer": False},
           quiz=Q(1, accept=["42"]))
CITY = item("city", "short_text", "Where is the Opera House?", quiz=Q(1, accept=["Sydney", "Sydney, NSW"]))
COLOUR = item("colour", "dropdown", "Colour of the sky?", options=[opt("b", "Blue"), opt("g", "Green")], quiz=Q(1, options=["b"]))
GRID = item("g", "choice_grid", "Match them", rows=[{"id": "r1", "label": "Cat"}, {"id": "r2", "label": "Dog"}],
            columns=[{"id": "c1", "label": "Meow"}, {"id": "c2", "label": "Woof"}], quiz=Q(1, rows={"r1": "c1", "r2": "c2"}))
CBGRID = item("cg", "checkbox_grid", "Which have legs?", rows=[{"id": "r1", "label": "Fish"}, {"id": "r2", "label": "Frog"}],
              columns=[{"id": "c1", "label": "Two"}, {"id": "c2", "label": "Four"}], quiz=Q(1, rows={"r2": ["c2"]}))
WHY = item("why", "paragraph", "Why do leaves fall?", quiz=Q(3))
SCALE = item("fun", "linear_scale", "How fun was this?", min=1, max=5)

QUIZ_DEFN = defn([CAPITAL, PRIMES, SUM, CITY, COLOUR, GRID, CBGRID, WHY, SCALE])


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.forms import notify, regrade, sheet
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(notify, "answer_arrived", lambda form_id: None)
    monkeypatch.setattr(sheet, "sync_soon", lambda form: None)
    # Regrades run when the test says so (``await regrade.regrade_form``).
    monkeypatch.setattr(regrade, "regrade_soon", lambda form: None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


@pytest.fixture
def pushes(monkeypatch):
    sent: list[dict] = []

    async def fake(**kw):
        sent.append(kw)

    import app.notifications.dispatch as d

    monkeypatch.setattr(d, "notify_user", fake)
    return sent


async def mk_user(db, name, role="user"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def make_quiz(client, owner, definition=QUIZ_DEFN, quiz=None, **settings):
    r = await client.post("/api/forms", json={}, headers=H(owner))
    fid = r.json()["file"]["id"]
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": definition, "data_version": 1},
                         headers=H(owner))
    assert r.status_code == 200, r.text
    body = {"accepting": True, **settings}
    if quiz is not False:
        body["quiz"] = quiz or {"release": "now", "show_score": True, "show_right_wrong": True,
                                "show_answers": False, "show_points": True}
    r = await client.patch(f"/api/forms/{fid}/settings", json=body, headers=H(owner))
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/forms/{fid}/link", json={}, headers=H(owner))
    view = r.json()
    return fid, uuid.UUID(view["form"]["id"]), view["link"]["token"]


async def send(client, form_id, token, answers, who=None, submit_id=None):
    from app.forms import abuse

    body = {"answers": answers, "submit_id": str(submit_id or uuid.uuid4()),
            "start_token": abuse.start_token(form_id, now=time.time() - 30)}
    return await client.post(f"/api/f/{token}/submit", json=body, headers=H(who) if who else {})


ALL_RIGHT = {
    "cap": {"option": "cbr"},
    "primes": {"options": ["5", "2"]},
    "sum": "42.0",
    "city": "  sydney. ",
    "colour": {"option": "b"},
    "g": {"rows": {"r1": "c1", "r2": "c2"}},
    "cg": {"rows": {"r2": ["c2"]}},
    "why": "Less light in autumn.",
    "fun": 5,
}


# ------------------------------------------------------------------ marking (pure)
def test_mark_each_kind():
    from app.forms import quiz
    from app.forms.definition import validate_definition

    d = validate_definition(QUIZ_DEFN)
    assert quiz.total_points(d) == 2 + 2 + 1 + 1 + 1 + 2 + 1 + 3
    g = quiz.mark(d, ALL_RIGHT)
    assert g["max"] == 13 and g["auto"] == 10 and g["manual"] == 0 and g["pending"] == 1
    assert g["items"]["why"] == {"points": None, "max": 3, "right": None, "by": "owner"}
    assert g["items"]["g"]["rows"] == {"r1": True, "r2": True}
    assert "fun" not in g["items"]  # a scale can't be marked

    wrong = {
        "cap": {"other": "Canberra"},          # "Other" is never right by itself
        "primes": {"options": ["2"]},          # all or nothing
        "sum": "41",
        "city": "Melbourne",
        "g": {"rows": {"r1": "c1", "r2": "c1"}},  # one row right
        "cg": {"rows": {"r2": ["c1", "c2"]}},
        "why": "   ",                           # blank: 0, not pending
    }
    g = quiz.mark(d, wrong)
    assert g["auto"] == 1 and g["pending"] == 0
    assert g["items"]["cap"]["right"] is False and g["items"]["colour"] == {"points": 0, "max": 1, "right": False, "by": "auto"}
    assert g["items"]["g"] == {"points": 1, "max": 2, "right": False, "by": "auto", "rows": {"r1": True, "r2": False}}
    assert g["items"]["why"]["points"] == 0

    # Short answers: case, spaces, trailing full stops; numbers as numbers.
    assert quiz.short_answer_right(CITY, "SYDNEY ,  NSW".replace(" ,", ","), ["Sydney, NSW"])
    assert quiz.short_answer_right(SUM, "42,0", ["42"])
    assert not quiz.short_answer_right(CITY, "42", ["42.0"])  # not a number question: words


def test_owner_marks_survive_only_unchanged_answers():
    from app.forms import quiz
    from app.forms.definition import validate_definition

    d = validate_definition(QUIZ_DEFN)
    first = quiz.mark(d, ALL_RIGHT)
    by_id = {i["id"]: i for i in d["items"]}
    marked = quiz.with_owner_mark(first, by_id["why"], 2)
    marked = quiz.with_owner_mark(marked, by_id["city"], 0)  # an override of an auto mark
    assert marked["manual"] == 2 and marked["pending"] == 0
    again = quiz.mark(d, ALL_RIGHT, marked, ALL_RIGHT)
    assert again["items"]["why"] == {"points": 2, "max": 3, "right": None, "by": "owner"}
    assert again["items"]["city"]["by"] == "owner" and again["items"]["city"]["points"] == 0
    changed = {**ALL_RIGHT, "why": "Because of the cold."}
    after = quiz.mark(d, changed, marked, ALL_RIGHT)
    assert after["items"]["why"]["points"] is None and after["pending"] == 1
    assert after["items"]["city"]["by"] == "owner"  # that answer didn't change


def test_key_validation():
    from app.forms.definition import DefinitionError, validate_definition

    out = validate_definition(defn([
        {**CAPITAL, "quiz": {**Q(2, options=["cbr", "gone"]), "suggested": True}},
        {**SCALE},
    ]))
    assert out["items"][0]["quiz"] == {"points": 2, "key": {"options": ["cbr"]}, "feedback_right": "",
                                       "feedback_wrong": "", "suggested": True}
    assert "quiz" not in out["items"][1]
    for bad, words in (
        ({**SCALE, "quiz": Q(1)}, "can't have points"),
        ({**CAPITAL, "quiz": {**Q(1), "points": 101}}, "0 to 100"),
        ({**CITY, "quiz": Q(1, accept=[str(i) for i in range(21)])}, "at most 20"),
        ({**CAPITAL, "quiz": {**Q(1), "feedback_right": "x" * 501}}, "too long"),
        ({**CAPITAL, "quiz": {**Q(1), "secret": 1}}, "doesn't know"),
    ):
        with pytest.raises(DefinitionError) as e:
            validate_definition(defn([bad]))
        assert words in str(e.value)


# ------------------------------------------------------------------ the answer page
async def test_keys_never_reach_the_answer_page(client, db, user):
    fid, form_id, token = await make_quiz(client, user, allow_edit=True, audience="link")
    page = (await client.get(f"/api/f/{token}")).json()
    assert page["quiz"] == {"release": "now"}
    text = str(page)
    assert all("quiz" not in i for i in page["definition"]["items"])
    assert "cbr'" in text  # the options are there…
    assert "'accept': [" not in text and "feedback" not in text and "Sydney, NSW" not in text  # …no key
    r = await send(client, form_id, token, ALL_RIGHT)
    assert r.status_code == 200, r.text
    edit = r.json()["edit_token"]
    mine = (await client.get(f"/api/f/{token}/mine", params={"edit": edit})).json()
    assert "'accept': [" not in str(mine) and "grading" not in str(mine) and "feedback" not in str(mine)


async def test_submit_marks_and_shows_only_what_the_owner_allows(client, db, user):
    fid, form_id, token = await make_quiz(client, user, audience="link", quiz={
        "release": "now", "show_score": True, "show_right_wrong": True, "show_answers": True, "show_points": False})
    r = await send(client, form_id, token, {**ALL_RIGHT, "cap": {"option": "syd"}})
    body = r.json()
    res = body["result"]
    assert res["released"] is True and res["score"] == 8 and res["max"] == 13 and res["pending"] == 1
    cap = next(i for i in res["items"] if i["id"] == "cap")
    assert cap == {"id": "cap", "title": "Capital of Australia?", "waiting": False, "right": False,
                   "correct": "Canberra", "feedback": "It's Canberra."}
    why = next(i for i in res["items"] if i["id"] == "why")
    assert why["waiting"] is True and "correct" not in why
    assert "points" not in cap  # points per question are off
    assert body["result_token"].startswith("1.")
    # Stored.
    from sqlalchemy import select

    from app.forms.models import FormResponse

    row = (await db.execute(select(FormResponse).where(FormResponse.form_id == form_id)
                            .execution_options(populate_existing=True))).scalar_one()
    assert int(row.score) == 8 and row.released_at is not None and row.grading["pending"] == 1


async def test_results_link(client, db, user):
    fid, form_id, token = await make_quiz(client, user, audience="link")
    a = (await send(client, form_id, token, ALL_RIGHT)).json()
    b = (await send(client, form_id, token, {"cap": {"option": "syd"}})).json()
    ok = await client.get(f"/api/f/{token}/result", params={"r": a["result_token"]})
    assert ok.status_code == 200 and ok.json()["score"] == 10 and ok.json()["number"] == 1
    # Someone else's number with my key, a made-up key, no key: the same 404.
    num_b, sig_a = b["result_token"].split(".")[0], a["result_token"].split(".", 1)[1]
    gone = []
    for r_token in (f"{num_b}.{sig_a}", "1.nope", None, "x"):
        r = await client.get(f"/api/f/{token}/result", params={"r": r_token} if r_token else {})
        gone.append((r.status_code, r.json()))
    assert all(g == gone[0] for g in gone) and gone[0][0] == 404
    # Still there once the form is closed.
    await client.patch(f"/api/forms/{fid}/settings", json={"accepting": False}, headers=H(user))
    assert (await client.get(f"/api/f/{token}/result", params={"r": a["result_token"]})).status_code == 200
    # Not for a form that isn't a quiz.
    fid2, form2, token2 = await make_quiz(client, user, defn([SCALE]), quiz=False, audience="link")
    sent = (await send(client, form2, token2, {"fun": 3})).json()
    assert "result" not in sent and "result_token" not in sent
    assert (await client.get(f"/api/f/{token2}/result", params={"r": "1.x"})).status_code == 404


async def test_editing_re_marks_and_keeps_owner_marks_for_unchanged_answers(client, db, user):
    respondent = await mk_user(db, "kid")
    fid, form_id, token = await make_quiz(client, user, allow_edit=True, audience="server")
    assert (await send(client, form_id, token, ALL_RIGHT, who=respondent)).status_code == 200
    r = await client.put(f"/api/forms/{fid}/responses/1/marks", json={"marks": {"why": 3, "city": 0}}, headers=H(user))
    assert r.status_code == 200, r.text
    assert r.json()["marks"]["score"] == 12 and r.json()["marks"]["pending"] == 0
    assert r.json()["marks"]["items"]["why"]["by"] == "owner"
    one = (await client.get(f"/api/forms/{fid}/responses/1", headers=H(user))).json()
    assert one["quiz"]["score"] == 12 and one["quiz"]["items"]["city"]["points"] == 0
    from app.forms import abuse

    body = {"answers": {**ALL_RIGHT, "why": "Different words now", "sum": "41"},
            "start_token": abuse.start_token(form_id, now=time.time() - 30)}
    r = await client.put(f"/api/f/{token}/mine", json=body, headers=H(respondent))
    assert r.status_code == 200, r.text
    g = r.json()["result"]
    assert g["pending"] == 1  # the paragraph changed: marked again by hand
    from sqlalchemy import select

    from app.forms.models import FormResponse

    row = (await db.execute(select(FormResponse).where(FormResponse.form_id == form_id)
                            .execution_options(populate_existing=True))).scalar_one()
    assert row.grading["items"]["city"] == {"points": 0, "max": 1, "right": False, "by": "owner"}  # unchanged answer
    assert row.grading["items"]["sum"]["points"] == 0 and row.grading["items"]["why"]["points"] is None
    # Bad marks are refused.
    for marks in ({"why": 4}, {"fun": 1}, {"why": -1}):
        r = await client.put(f"/api/forms/{fid}/responses/1/marks", json={"marks": marks}, headers=H(user))
        assert r.status_code == 400, marks


async def test_key_change_re_marks_old_answers_and_the_sheet_score(client, db, user):
    from app.forms import regrade
    from app.forms.sheet import row_values

    fid, form_id, token = await make_quiz(client, user, audience="link")
    assert (await send(client, form_id, token, {"cap": {"option": "syd"}})).status_code == 200
    view = (await client.get(f"/api/forms/{fid}", headers=H(user))).json()
    d = view["form"]["definition"]
    for it in d["items"]:
        if it["id"] == "cap":
            it["quiz"]["key"] = {"options": ["syd", "cbr"]}
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": d, "data_version": view["form"]["data_version"]},
                         headers=H(user))
    assert r.status_code == 200 and r.json()["remarking"] == 1
    assert await regrade.regrade_form(form_id) == 1
    from sqlalchemy import select

    from app.forms.models import FormResponse

    row = (await db.execute(select(FormResponse).where(FormResponse.form_id == form_id)
                            .execution_options(populate_existing=True))).scalar_one()
    assert row.grading["items"]["cap"]["right"] is True and int(row.score) == 2
    from app.forms.models import Form

    form = await db.get(Form, form_id)
    assert row_values(form.definition, row)["score"] == "2 / 13"
    # Nothing to change: nothing re-marked.
    assert await regrade.regrade_form(form_id) == 0
    # A save that doesn't touch points or keys doesn't re-mark.
    view = (await client.get(f"/api/forms/{fid}", headers=H(user))).json()
    d = view["form"]["definition"]
    d["title"] = "Trivia night"
    r = await client.put(f"/api/forms/{fid}/definition", json={"definition": d, "data_version": view["form"]["data_version"]},
                         headers=H(user))
    assert r.json()["remarking"] == 0


async def test_release_later_partly_and_one_push(client, db, user, pushes):
    kid = await mk_user(db, "kid")
    fid, form_id, token = await make_quiz(client, user, audience="link", quiz={
        "release": "later", "show_score": True, "show_right_wrong": False, "show_answers": False, "show_points": False})
    # A signed-in answer can't reach a link form as "server"; use a server-audience copy for the push.
    await client.patch(f"/api/forms/{fid}/settings", json={"audience": "server"}, headers=H(user))
    r = await send(client, form_id, token, {k: v for k, v in ALL_RIGHT.items() if k != "why"}, who=kid)
    assert r.json()["result"] == {"number": 1, "released": False}
    await client.patch(f"/api/forms/{fid}/settings", json={"audience": "link"}, headers=H(user))
    link = (await send(client, form_id, token, ALL_RIGHT)).json()  # #2, a paragraph to mark
    assert link["result"] == {"number": 2, "released": False}
    pushes.clear()
    r = await client.post(f"/api/forms/{fid}/release", json={}, headers=H(user))
    assert r.json() == {"released": 1, "still_to_mark": 1}
    # One push, to the signed-in person, the form's title only; none for the link answer.
    assert len(pushes) == 1 and pushes[0]["user_id"] == kid.id and pushes[0]["category"] == "invite"
    assert pushes[0]["body"] == "“Family trivia”" and "10" not in pushes[0]["title"] + pushes[0]["body"]
    # Released again: nobody is told twice.
    r = await client.post(f"/api/forms/{fid}/release", json={}, headers=H(user))
    assert r.json() == {"released": 0, "still_to_mark": 1} and len(pushes) == 1
    # The link answer: still waiting until it's marked.
    assert (await client.get(f"/api/f/{token}/result", params={"r": link["result_token"]})).json() == {"number": 2, "released": False}
    await client.put(f"/api/forms/{fid}/responses/2/marks", json={"marks": {"why": 3}}, headers=H(user))
    assert (await client.post(f"/api/forms/{fid}/release", json={"numbers": [2]}, headers=H(user))).json() == {
        "released": 1, "still_to_mark": 0}
    res = (await client.get(f"/api/f/{token}/result", params={"r": link["result_token"]})).json()
    assert res == {"number": 2, "released": True, "pending": 0, "score": 13, "max": 13}
    # Summary stats.
    s = (await client.get(f"/api/forms/{fid}/summary", headers=H(user))).json()["quiz"]
    assert s["marked"] == 2 and s["pending"] == 0 and s["released"] == 2 and s["top"] == 13


async def test_show_answers_turns_editing_off_and_back(client, db, user):
    fid, form_id, token = await make_quiz(client, user, allow_edit=True, audience="link")
    base = {"release": "now", "show_score": True, "show_right_wrong": True, "show_points": False}
    v = (await client.patch(f"/api/forms/{fid}/settings", json={"quiz": {**base, "show_answers": True}}, headers=H(user))).json()
    assert v["form"]["settings"]["allow_edit"] is False
    r = await client.patch(f"/api/forms/{fid}/settings", json={"allow_edit": True}, headers=H(user))
    assert r.status_code == 400 and "correct answers" in r.text
    page = (await client.get(f"/api/f/{token}")).json()
    assert page["settings"]["allow_edit"] is False
    v = (await client.patch(f"/api/forms/{fid}/settings", json={"quiz": {**base, "show_answers": False}}, headers=H(user))).json()
    assert v["form"]["settings"]["allow_edit"] is True  # put back the way it was
    v = (await client.patch(f"/api/forms/{fid}/settings", json={"quiz": {**base, "show_answers": True}}, headers=H(user))).json()
    v = (await client.patch(f"/api/forms/{fid}/settings", json={"quiz": None}, headers=H(user))).json()
    assert v["form"]["settings"]["quiz"] is None and v["form"]["settings"]["allow_edit"] is True
    r = await client.patch(f"/api/forms/{fid}/settings", json={"quiz": {"release": "whenever"}}, headers=H(user))
    assert r.status_code == 400


async def test_scores_follow_form_access(client, db, user):
    fid, form_id, token = await make_quiz(client, user, audience="link")
    await send(client, form_id, token, ALL_RIGHT)
    await send(client, form_id, token, {"cap": {"option": "cbr"}})
    reader, nobody = await mk_user(db, "reader"), await mk_user(db, "nobody")
    admin = await mk_user(db, "admin", role="admin")
    await client.post(f"/api/files/file/{fid}/grants", json={"grantee_user_id": str(reader.id), "can_edit": False},
                      headers=H(user))
    r = await client.get(f"/api/forms/{fid}/scores", headers=H(reader))
    assert r.status_code == 200
    assert [(x["number"], x["score"], x["pending"]) for x in r.json()["scores"]] == [(1, 10, 1), (2, 2, 0)]
    for who in (nobody, admin):
        assert (await client.get(f"/api/forms/{fid}/scores", headers=H(who))).status_code == 404
        assert (await client.post(f"/api/forms/{fid}/release", json={}, headers=H(who))).status_code == 404
    # Reading isn't marking.
    assert (await client.put(f"/api/forms/{fid}/responses/1/marks", json={"marks": {"why": 1}},
                             headers=H(reader))).status_code == 404
    assert (await client.post(f"/api/forms/{fid}/release", json={}, headers=H(reader))).status_code == 404


async def test_turning_a_quiz_on_late_marks_what_is_in(client, db, user):
    from app.forms import regrade

    fid, form_id, token = await make_quiz(client, user, quiz=False, audience="link")
    await send(client, form_id, token, ALL_RIGHT)
    await client.patch(f"/api/forms/{fid}/settings", json={"quiz": {"release": "now"}}, headers=H(user))
    assert await regrade.regrade_form(form_id) == 1
    s = (await client.get(f"/api/forms/{fid}/scores", headers=H(user))).json()
    assert s["scores"][0]["score"] == 10 and s["scores"][0]["released"] is True
