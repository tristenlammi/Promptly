"""Forms phase 2, WP-F2.4: quiz results around Promptly.

* the Quiz and Family trivia templates are valid quizzes with keys set;
* the Scores strip numbers and "Most missed";
* downloads: Score, Max and Still to mark as numbers in Excel;
* the Forms home card ("Quiz · 4 to mark") and Today ("4 answers to mark"),
  counts only;
* chat: ``draft_form`` makes a quiz with its suggested answers marked
  "check it"; ``read_form_responses`` gives quiz stats, never a person's
  score or name.
"""
from __future__ import annotations

import io
import time
import uuid
from datetime import datetime, timezone

import httpx
import pytest


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.forms import notify, regrade, sheet
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    monkeypatch.setattr(notify, "answer_arrived", lambda form_id: None)
    monkeypatch.setattr(sheet, "sync_soon", lambda form: None)
    monkeypatch.setattr(regrade, "regrade_soon", lambda form: None)
    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


async def from_template(client, user, key):
    r = await client.post("/api/forms", json={"template": key}, headers=H(user))
    assert r.status_code == 201, r.text
    fid = r.json()["file"]["id"]
    view = (await client.get(f"/api/forms/{fid}", headers=H(user))).json()
    await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True, "audience": "link"}, headers=H(user))
    link = (await client.post(f"/api/forms/{fid}/link", json={}, headers=H(user))).json()
    return fid, uuid.UUID(view["form"]["id"]), link["link"]["token"], view


async def send(client, form_id, token, answers):
    from app.forms import abuse

    body = {"answers": answers, "submit_id": str(uuid.uuid4()),
            "start_token": abuse.start_token(form_id, now=time.time() - 30)}
    r = await client.post(f"/api/f/{token}/submit", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_quiz_templates_are_quizzes():
    from app.forms import quiz
    from app.forms.templates import built_in, listing

    keys = {t["key"]: t for t in listing()}
    assert keys["quiz"]["quiz"] is True and keys["family_trivia"]["quiz"] is True and keys["rsvp"]["quiz"] is False
    d, settings = built_in("family_trivia")
    assert settings["quiz"]["release"] == "now"
    marked = quiz.marked_questions(d)
    assert len(marked) == 10 and quiz.total_points(d) == 10
    assert all(quiz.has_key(i) for i in marked)
    d2, _s = built_in("quiz")
    assert quiz.total_points(d2) == 1 + 1 + 2 + 2
    assert [i["kind"] for i in quiz.marked_questions(d2)] == ["multiple_choice", "short_text", "checkboxes", "paragraph"]


async def test_family_trivia_scores_strip_home_today_and_export(client, db, user):
    fid, form_id, token, view = await from_template(client, user, "family_trivia")
    assert view["form"]["settings"]["quiz"]["release"] == "now"
    d = view["form"]["definition"]
    right = {}
    for it in d["items"]:
        if it.get("quiz"):
            right[it["id"]] = {"option": it["quiz"]["key"]["options"][0]}
    first = next(o["id"] for o in d["items"][1]["config"]["options"] if o["id"] not in right["t1"].values())
    a = await send(client, form_id, token, {"name": "Sam", **right})
    b = await send(client, form_id, token, {"name": "Jo", **right, "t1": {"option": first}})
    assert a["result"]["score"] == 10 and b["result"]["score"] == 9

    s = (await client.get(f"/api/forms/{fid}/summary", headers=H(user))).json()["quiz"]
    assert s["max"] == 10 and s["marked"] == 2 and s["average"] == 9.5 and s["top"] == 10 and s["pending"] == 0
    assert [h["count"] for h in s["histogram"] if h["count"]] == [1, 1]
    assert s["most_missed"][0]["id"] == "t1" and s["most_missed"][0]["right_pct"] == 50

    # Excel: Score and Max as numbers.
    from openpyxl import load_workbook

    r = await client.get(f"/api/forms/{fid}/export", params={"format": "xlsx"}, headers=H(user))
    ws = load_workbook(io.BytesIO(r.content)).active
    head = [c.value for c in ws[1]]
    assert head[3:6] == ["Score", "Max", "Still to mark"]
    assert [ws.cell(row=2, column=4).value, ws.cell(row=2, column=5).value] == [10, 10]
    assert isinstance(ws.cell(row=3, column=4).value, int)

    # Home card and Today: nothing to mark yet (no paragraphs).
    cards = (await client.get("/api/forms", headers=H(user))).json()["forms"]
    card = next(c for c in cards if c["file_id"] == fid)
    assert card["quiz"] is True and card["to_mark"] == 0


async def test_to_mark_on_home_and_today(client, db, user):
    from app.forms.notify import today_section

    fid, form_id, token, view = await from_template(client, user, "quiz")
    base = {"q1": {"option": "q1o2"}, "q2": "56", "q3": {"options": ["q3o1", "q3o3"]}}
    await send(client, form_id, token, {"name": "Sam", **base, "q4": "The tilt of the earth."})
    await send(client, form_id, token, {"name": "Jo", **base, "q4": "No idea"})
    await send(client, form_id, token, {"name": "Al", **base})  # no paragraph answer: nothing to mark
    cards = (await client.get("/api/forms", headers=H(user))).json()["forms"]
    assert next(c for c in cards if c["file_id"] == fid)["to_mark"] == 2
    from zoneinfo import ZoneInfo

    sec = await today_section(db, user, datetime.now(timezone.utc), ZoneInfo("UTC"))
    assert sec["to_mark"] == [{"title": "Quiz", "count": 2, "url": f"/files/form/{fid}?tab=responses"}]
    # Counts and titles only: nobody's words or names.
    assert "Sam" not in str(sec) and "tilt" not in str(sec)


async def test_chat_reads_quiz_stats_without_names(client, db, user):
    from app.chat.tools.base import ToolContext
    from app.chat.tools.forms import ReadFormResponsesTool

    fid, form_id, token, view = await from_template(client, user, "family_trivia")
    d = view["form"]["definition"]
    right = {it["id"]: {"option": it["quiz"]["key"]["options"][0]} for it in d["items"] if it.get("quiz")}
    await send(client, form_id, token, {"name": "Unique Person Name", **right})
    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = (await ReadFormResponsesTool().run(ctx, {"form": fid})).content
    assert "A quiz out of 10 points: 1 marked, average 10.0" in out
    # No one's own score: no "10 / 10" next to anybody (the Scores view is for that).
    assert "/ 10" not in out


async def test_draft_form_quiz_with_suggested_answers(client, db, user):
    from app.chat.tools.base import ToolContext
    from app.chat.tools.forms import DraftFormTool

    ctx = ToolContext(db=db, user=user, conversation_id=uuid.uuid4(), user_message_id=uuid.uuid4(), turn={})
    out = await DraftFormTool().run(ctx, {"title": "90s trivia", "questions": [
        {"kind": "multiple_choice", "title": "Who sang Wannabe?", "options": ["Spice Girls", "Oasis", "Blur"],
         "answer": "Spice Girls", "points": 1},
        {"kind": "short_text", "title": "Year the Euro was launched?", "answer": "1999", "points": 2},
        {"kind": "checkboxes", "title": "Which were 90s consoles?", "options": ["PlayStation", "Switch", "N64"],
         "answers": ["PlayStation", "N64"]},
        {"kind": "multiple_choice", "title": "No answer given", "options": ["A", "B"]},
    ]})
    assert "draft quiz" in out.content and "check it" in out.content
    fid = out.meta["form_card"]["file_id"]
    view = (await client.get(f"/api/forms/{fid}", headers=H(user))).json()
    assert view["form"]["settings"]["quiz"]["release"] == "now"
    assert view["form"]["settings"]["accepting"] is False
    items = view["form"]["definition"]["items"]
    by_title = {i["title"]: i for i in items}
    q1 = by_title["Who sang Wannabe?"]
    spice = next(o["id"] for o in q1["config"]["options"] if o["label"] == "Spice Girls")
    assert q1["quiz"] == {"points": 1, "key": {"options": [spice]}, "feedback_right": "", "feedback_wrong": "", "suggested": True}
    assert by_title["Year the Euro was launched?"]["quiz"]["key"] == {"accept": ["1999"]}
    assert by_title["Year the Euro was launched?"]["quiz"]["points"] == 2
    assert len(by_title["Which were 90s consoles?"]["quiz"]["key"]["options"]) == 2
    assert "quiz" not in by_title["No answer given"]
