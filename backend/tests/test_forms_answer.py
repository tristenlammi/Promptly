"""Answering a form through its link (WP-F1.3).

The path re-walk (and its parity with the answer page's ``logic.ts``, from
the shared cases in ``tests/data/forms_path_cases.json``), the answer
checks, option places under the form lock (two people racing for the last
place), one answer per person and changing it, closing by time and count,
idempotent submits, the spam limits (start token, honeypot, rate limits,
size caps), identical "doesn't exist" answers, and that answering never
becomes access to the form's file.
"""
from __future__ import annotations

import asyncio
import io
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

CASES = json.loads((Path(__file__).parent / "data" / "forms_path_cases.json").read_text(encoding="utf-8"))["cases"]


# ------------------------------------------------------------------ helpers
@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    from app import rate_limit
    from app.files import storage
    from app.main import app

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
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


def H(u) -> dict:
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(u.id, token_version=u.token_version)}"}


async def mk_user(db, name, role="user"):
    from app.auth.models import User

    u = User(email=f"{name}-{uuid.uuid4().hex[:6]}@example.com", username=f"{name}{uuid.uuid4().hex[:6]}",
             password_hash="x", role=role)
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def opt(oid, label, go_to=None, limit=None):
    return {"id": oid, "label": label, "go_to": go_to, "limit": limit, "image_asset_id": None}


def q(iid, kind, required=False, **config):
    return {"id": iid, "kind": kind, "title": iid, "description": "", "image_asset_id": None,
            "required": required, "config": config, "deleted": False}


def defn(items, after="continue", title="Answer test"):
    return {"version": 1, "title": title, "description": "", "after": after,
            "theme": {"accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"},
            "items": items}


SIGNUP = defn([
    q("name", "short_text", required=True),
    q("dish", "multiple_choice", required=True,
      options=[opt("salad", "Salad", limit=2), opt("cake", "Cake", limit=1), opt("bread", "Bread")]),
])

FEEDBACK = defn([
    q("enjoy", "multiple_choice", required=True, branching=True,
      options=[opt("yes", "Yes", go_to="submit"), opt("no", "No", go_to="s3")]),
    {**q("s2", "section"), "config": {"after": "continue"}},
    q("why", "short_text"),
    {**q("s3", "section"), "config": {"after": "continue"}},
    q("better", "paragraph", required=True),
])


class Form:
    def __init__(self, fid, form_id, token):
        self.fid, self.form_id, self.token = fid, form_id, token


async def make_form(client, owner, definition, **settings) -> Form:
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
    return Form(fid, uuid.UUID(view["form"]["id"]), view["link"]["token"])


def started(form_id, ago=30.0) -> str:
    from app.forms import abuse

    return abuse.start_token(form_id, now=time.time() - ago)


async def send(client, f: Form, answers, *, who=None, submit_id=None, ip=None, **extra):
    headers = dict(H(who)) if who else {}
    if ip:
        headers["X-Real-IP"] = ip
    body = {"answers": answers, "submit_id": str(submit_id or uuid.uuid4()),
            "start_token": extra.pop("start_token", None) or started(f.form_id), **extra}
    return await client.post(f"/api/f/{f.token}/submit", json=body, headers=headers)


async def responses_of(db, form_id):
    from sqlalchemy import select

    from app.forms.models import FormResponse

    return (await db.execute(select(FormResponse).where(FormResponse.form_id == form_id)
                             .order_by(FormResponse.number)
                             .execution_options(populate_existing=True))).scalars().all()


# ------------------------------------------------------------------ pure: the walk and the checks
@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_path_parity(case):
    """The same cases ``e2e/tests/unit-forms-path.spec.ts`` runs through
    ``logic.ts``: the server's walk must give the same path."""
    from app.forms import answering as ans

    assert ans.walk_path(case["definition"], case["answers"]) == case["path"]
    if case["error"]:
        with pytest.raises(ans.AnswerError) as exc:
            ans.check_answers(case["definition"], case["answers"])
        assert exc.value.question_id == case["error"]
    else:
        clean, path = ans.check_answers(case["definition"], case["answers"])
        assert path == case["path"]
        assert sorted(clean) == sorted(case["kept"])


def test_every_case_is_a_valid_form():
    from app.forms.definition import DefinitionError, validate_definition

    for c in CASES:
        try:
            validate_definition(c["definition"])
        except DefinitionError as exc:
            # Only the deliberately broken target may fail validation.
            assert "isn't in the form" in str(exc), c["name"]


def test_answer_checks():
    from app.forms import answering as ans

    def err(item, v):
        with pytest.raises(ans.AnswerError) as e:
            ans.check_one(item, v)
        return str(e.value)

    num = q("n", "short_text", validation={"kind": "number", "min": 1, "max": 10, "integer": True})
    assert ans.check_one(num, " 7 ") == "7"
    assert err(num, "seven") == "Enter a number."
    assert err(num, "7.5") == "Enter a whole number."
    assert err(num, "11") == "Enter a number from 1 to 10."
    email = q("e", "short_text", validation={"kind": "email", "min": None, "max": None, "integer": False})
    assert err(email, "nope") == "Enter an email like name@example.com."
    url = q("u", "short_text", validation={"kind": "url", "min": None, "max": None, "integer": False})
    assert err(url, "javascript:alert(1)") == "Enter a web link starting with https://"
    assert err(q("t", "short_text"), "x" * 1001).startswith("Keep it to 1000")
    assert err(q("t", "short_text"), 42) == "Write your answer as text."
    para = q("p", "paragraph", max_length=10)
    assert err(para, "x" * 11) == "Keep it to 10 characters or fewer."

    mc = q("m", "multiple_choice", options=[opt("a", "A")], other=False)
    assert ans.check_one(mc, {"option": "a"}) == {"option": "a"}
    assert "isn't on the form" in err(mc, {"option": "zz"})
    assert err(mc, {"other": "mine"}) == "Pick one of the options."  # no Other on this one
    assert err(mc, {"option": "a", "other": "x"}) == "Pick one of the options."
    mco = q("m", "multiple_choice", options=[opt("a", "A")], other=True)
    assert ans.check_one(mco, {"other": "  mine "}) == {"other": "mine"}
    assert err(mco, {"other": "   "}) == "Say what “Other” is."

    cb = q("c", "checkboxes", options=[opt("a", "A"), opt("b", "B"), opt("c", "C")], other=False,
           min_selected=2, max_selected=2)
    assert err(cb, {"options": ["a"]}) == "Tick exactly 2."
    assert err(cb, {"options": ["a", "a"]}) == "An option was ticked twice."
    assert err(cb, {"options": ["a", "b"], "other": "x"}) == "This question has no “Other”."
    assert ans.check_one(cb, {"options": ["a", "b"]}) == {"options": ["a", "b"]}

    assert err(q("s", "linear_scale", min=1, max=5), 6) == "Pick a number from 1 to 5."
    assert err(q("s", "linear_scale", min=1, max=5), True) == "Pick a number from 1 to 5."
    assert ans.check_one(q("s", "linear_scale", min=0, max=5), 0) == 0
    assert err(q("r", "rating", max=5), 0) == "Pick from 1 to 5."

    d = q("d", "date", include_time=False, include_year=True)
    assert ans.check_one(d, "2026-02-28") == "2026-02-28"
    assert err(d, "2026-02-30") == "Pick a full date."
    assert err(d, "2026-2-3") == "Pick a full date."
    bday = q("b", "date", include_time=False, include_year=False)
    assert ans.check_one(bday, "02-29") == "02-29"
    assert err(bday, "00-15") == "Pick a full date."  # a month not picked
    dt = q("dt", "date", include_time=True, include_year=True)
    assert err(dt, "2026-01-01T25:00") == "Pick a time."
    assert err(q("t", "time", mode="time"), "24:00") == "Pick a time."
    assert ans.check_one(q("t", "time", mode="duration"), "1:05:09") == "1:05:09"
    assert err(q("t", "time", mode="duration"), "1:65:00") == "Enter hours, minutes and seconds."


def test_answers_size_cap():
    from app.forms import answering as ans

    big = {f"x{i}": "y" * 1000 for i in range(70)}
    with pytest.raises(ans.AnswerError) as e:
        ans.check_answers(defn([q("a", "short_text")]), big)
    assert "too long" in str(e.value)


# ------------------------------------------------------------------ the answer page and submitting
async def test_signed_out_answers_a_link_form(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link")
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert page["state"] == "open" and page["respondent"] is None
    assert page["remaining"] == {"dish": {"salad": 2, "cake": 1}}
    assert page["start_token"] and page["settings"]["collect_email"] is False
    r = await send(client, f, {"name": "Uncle Bob", "dish": {"option": "cake"}, "stray": "dropped"})
    assert r.status_code == 200, r.text
    assert r.json() == {"number": 1, "edit_token": None}
    [resp] = await responses_of(db, f.form_id)
    assert resp.respondent_id is None and resp.source == "link" and resp.email is None
    assert resp.answers == {"name": "Uncle Bob", "dish": {"option": "cake"}}
    assert resp.edit_token_hash  # kept hashed; only shown when editing is on
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert page["remaining"]["dish"] == {"salad": 2, "cake": 0}


async def test_required_on_the_path_and_off_path_answers_dropped(client, db, user):
    f = await make_form(client, user, FEEDBACK, audience="link")
    # A hand-made skip: "No" goes to section 3, whose question is required.
    r = await send(client, f, {"enjoy": {"option": "no"}})
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "invalid", "message": "This question needs an answer.", "question_id": "better"}
    # "Yes" ends the form: answers slipped into sections 2 and 3 are dropped.
    r = await send(client, f, {"enjoy": {"option": "yes"}, "why": "x", "better": "y"})
    assert r.status_code == 200
    r = await send(client, f, {"enjoy": {"option": "no"}, "why": "dropped", "better": "More food"})
    assert r.status_code == 200
    a, b = await responses_of(db, f.form_id)
    assert a.answers == {"enjoy": {"option": "yes"}} and a.path == [0]
    assert b.answers == {"enjoy": {"option": "no"}, "better": "More food"} and b.path == [0, 2]


async def test_submit_is_idempotent(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link", allow_edit=True)
    sid = uuid.uuid4()
    one = await send(client, f, {"name": "A", "dish": {"option": "salad"}}, submit_id=sid)
    two = await send(client, f, {"name": "A", "dish": {"option": "salad"}}, submit_id=sid)
    assert one.status_code == two.status_code == 200
    assert one.json() == two.json() and one.json()["edit_token"]
    assert len(await responses_of(db, f.form_id)) == 1
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert page["remaining"]["dish"]["salad"] == 1


async def test_two_answers_race_for_the_last_place(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link")
    results = await asyncio.gather(*[
        send(client, f, {"name": n, "dish": {"option": "cake"}}, ip=f"203.0.113.{i}")
        for i, n in enumerate(("Ann", "Bob"))
    ])
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409], [r.text for r in results]
    lost = next(r for r in results if r.status_code == 409).json()["detail"]
    assert lost["code"] == "full" and lost["question_id"] == "dish" and lost["option_id"] == "cake"
    assert "“Cake” just filled up" in lost["message"]
    # Five at once for two places: exactly two get them.
    results = await asyncio.gather(*[
        send(client, f, {"name": f"P{i}", "dish": {"option": "salad"}}) for i in range(5)
    ])
    assert sorted(r.status_code for r in results) == [200, 200, 409, 409, 409]
    rows = await responses_of(db, f.form_id)
    assert [r.number for r in rows] == [1, 2, 3]
    from sqlalchemy import select

    from app.forms.models import Form as FormRow

    row = (await db.execute(select(FormRow).where(FormRow.id == f.form_id)
                            .execution_options(populate_existing=True))).scalar_one()
    assert row.response_count == 3 and row.next_number == 4


async def test_one_answer_per_person_and_changing_it(client, db, user):
    mum = await mk_user(db, "mum")
    f = await make_form(client, user, SIGNUP, audience="server", one_per_person=True, allow_edit=True)
    # Signed out: a server form asks you to sign in, and says nothing about itself.
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert page == {"state": "sign_in", "audience": "server"}
    r = await send(client, f, {"name": "Mum", "dish": {"option": "cake"}})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "sign_in"

    page = (await client.get(f"/api/f/{f.token}", headers=H(mum))).json()
    assert page["state"] == "open" and page["respondent"]["name"] == mum.username and page["answered"] is False
    r = await send(client, f, {"name": "Mum", "dish": {"option": "cake"}}, who=mum)
    assert r.status_code == 200 and r.json()["edit_token"] is None
    r = await send(client, f, {"name": "Mum again", "dish": {"option": "salad"}}, who=mum)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "already_answered" and r.json()["detail"]["can_edit"] is True

    page = (await client.get(f"/api/f/{f.token}", headers=H(mum))).json()
    assert page["answered"] is True and page["mine"]["answers"]["dish"] == {"option": "cake"}
    mine = (await client.get(f"/api/f/{f.token}/mine", headers=H(mum))).json()
    assert mine["number"] == 1 and mine["start_token"]
    # Changing it: the place on Cake is given back, one on Salad taken.
    r = await client.put(f"/api/f/{f.token}/mine", headers=H(mum), json={
        "answers": {"name": "Mum", "dish": {"option": "salad"}}, "start_token": started(f.form_id)})
    assert r.status_code == 200 and r.json() == {"number": 1}
    [resp] = await responses_of(db, f.form_id)
    assert resp.answers["dish"] == {"option": "salad"} and resp.edited_at is not None
    page = (await client.get(f"/api/f/{f.token}", headers=H(mum))).json()
    assert page["remaining"]["dish"] == {"salad": 1, "cake": 1}
    # Someone else can't change Mum's answer.
    other = await mk_user(db, "other")
    r = await client.put(f"/api/f/{f.token}/mine", headers=H(other), json={
        "answers": {"name": "x", "dish": {"option": "bread"}}, "start_token": started(f.form_id)})
    assert r.status_code == 404


async def test_changing_a_link_answer_with_its_edit_token(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link", allow_edit=True, collect_email=True)
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert page["settings"]["collect_email"] is True
    r = await send(client, f, {"name": "Uncle", "dish": {"option": "salad"}})
    assert r.status_code == 422 and r.json()["detail"]["question_id"] == "_email"
    r = await send(client, f, {"name": "Uncle", "dish": {"option": "salad"}}, email="uncle@example.com")
    assert r.status_code == 200
    token = r.json()["edit_token"]
    assert token
    mine = await client.get(f"/api/f/{f.token}/mine", params={"edit": token})
    assert mine.status_code == 200 and mine.json()["answers"]["name"] == "Uncle"
    assert mine.json()["email"] == "uncle@example.com"
    wrong = await client.get(f"/api/f/{f.token}/mine", params={"edit": "x" * 43})
    assert wrong.status_code == 404
    r = await client.put(f"/api/f/{f.token}/mine", json={
        "answers": {"name": "Uncle Bob", "dish": {"option": "bread"}}, "edit": token,
        "email": "bob@example.com", "start_token": started(f.form_id)})
    assert r.status_code == 200, r.text
    [resp] = await responses_of(db, f.form_id)
    assert resp.answers["name"] == "Uncle Bob" and resp.email == "bob@example.com"
    # Editing turned off: the token stops working.
    await client.patch(f"/api/forms/{f.fid}/settings", json={"allow_edit": False}, headers=H(user))
    assert (await client.get(f"/api/f/{f.token}/mine", params={"edit": token})).status_code == 404


async def test_closing_at_a_time_and_a_count(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link", max_responses=2, allow_edit=True,
                        closed_message="Thanks, we've got enough helpers!")
    tokens = []
    for n in ("A", "B"):
        r = await send(client, f, {"name": n, "dish": {"option": "bread"}})
        assert r.status_code == 200
        tokens.append(r.json()["edit_token"])
    r = await send(client, f, {"name": "C", "dish": {"option": "bread"}})
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "closed", "message": "Thanks, we've got enough helpers!"}
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert page["state"] == "closed" and page["closed_message"] == "Thanks, we've got enough helpers!"
    assert page["definition"]["title"] == "Answer test" and page["definition"]["items"] == []
    # Full by count still takes a change to an answer already in.
    r = await client.put(f"/api/f/{f.token}/mine", json={
        "answers": {"name": "A2", "dish": {"option": "bread"}}, "edit": tokens[0], "start_token": started(f.form_id)})
    assert r.status_code == 200
    # Past its closing time: no answers, no changes.
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    await client.patch(f"/api/forms/{f.fid}/settings", json={"max_responses": None, "close_at": past}, headers=H(user))
    assert (await client.get(f"/api/f/{f.token}")).json()["state"] == "closed"
    assert (await send(client, f, {"name": "D", "dish": {"option": "bread"}})).status_code == 409
    r = await client.put(f"/api/f/{f.token}/mine", json={
        "answers": {"name": "A3", "dish": {"option": "bread"}}, "edit": tokens[0], "start_token": started(f.form_id)})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "closed"


async def test_honeypot_looks_fine_and_keeps_nothing(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link")
    r = await send(client, f, {"name": "bot", "dish": {"option": "bread"}}, website="https://spam.example")
    assert r.status_code == 200 and r.json()["number"] == 1
    assert await responses_of(db, f.form_id) == []


async def test_start_token(client, db, user):
    from app.forms import abuse

    f = await make_form(client, user, SIGNUP, audience="link")
    other = await make_form(client, user, SIGNUP, audience="link")
    a = {"name": "x", "dish": {"option": "bread"}}
    fresh = (await client.get(f"/api/f/{f.token}")).json()["start_token"]
    r = await send(client, f, a, start_token=fresh)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_fast"
    r = await send(client, f, a, start_token=abuse.start_token(f.form_id, now=time.time() - 25 * 3600))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "start_expired"
    ms, sig = started(f.form_id).split(".")
    r = await send(client, f, a, start_token=f"{int(ms) - 60_000}.{sig}")  # an older time, same signature
    assert r.status_code == 400 and r.json()["detail"]["code"] == "bad_start"
    r = await send(client, f, a, start_token=started(other.form_id))  # another form's
    assert r.status_code == 400
    r = await client.post(f"/api/f/{f.token}/submit", json={"answers": a, "submit_id": str(uuid.uuid4())})
    assert r.status_code == 400
    assert await responses_of(db, f.form_id) == []
    assert abuse.check_start(f.form_id, abuse.start_token(f.form_id, now=time.time() - 3.5)) == "ok"


async def test_size_caps(client, db, user):
    f = await make_form(client, user, defn([q("p", "paragraph", max_length=10000)]), audience="link")
    r = await send(client, f, {"p": "x" * 10001})
    assert r.status_code == 422 and r.json()["detail"]["question_id"] == "p"
    r = await send(client, f, {"p": "ok", **{f"junk{i}": "y" * 1000 for i in range(70)}})
    assert r.status_code == 422 and "too long" in r.json()["detail"]["message"]
    r = await client.post(f"/api/f/{f.token}/submit", content=b'{"answers": "' + b"z" * 200_000 + b'"}',
                          headers={"Content-Type": "application/json"})
    assert r.status_code == 413


@pytest.fixture
async def limits_on(monkeypatch):
    """Rate limits on for one test, with this run's counters cleared. The
    limiter gets a Redis connection of this test's own (a pooled one from an
    earlier test's event loop would hang)."""
    from limits.aio.storage import RedisStorage
    from limits.aio.strategies import FixedWindowRateLimiter

    from app import rate_limit
    from app.redis_client import redis

    monkeypatch.setattr(rate_limit, "_limiter", FixedWindowRateLimiter(RedisStorage(rate_limit._settings.REDIS_URL)))

    async def clear():
        for pattern in ("*LIMITER*form_*", "form:*"):
            async for k in redis.scan_iter(match=pattern):
                await redis.delete(k)

    await clear()
    rate_limit._settings.RATE_LIMIT_ENABLED = True
    try:
        yield
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = False
        await clear()


async def test_rate_limits_per_person_and_per_form(client, db, user, pushes, limits_on, monkeypatch):
    from app.forms import abuse

    monkeypatch.setattr(abuse, "PER_PERSON_PER_HOUR", 2)
    f = await make_form(client, user, SIGNUP, audience="link")
    a = {"name": "x", "dish": {"option": "bread"}}
    assert (await send(client, f, a, ip="198.51.100.1")).status_code == 200
    assert (await send(client, f, a, ip="198.51.100.1")).status_code == 200
    r = await send(client, f, a, ip="198.51.100.1")
    assert r.status_code == 429 and r.json()["detail"]["code"] == "busy"
    assert r.headers.get("retry-after")
    # Someone else on another address still gets in.
    assert (await send(client, f, a, ip="198.51.100.2")).status_code == 200
    # Signed-in people count by account: a whole family behind one address.
    fam = [await mk_user(db, f"fam{i}") for i in range(3)]
    for p in fam:
        assert (await send(client, f, a, who=p, ip="198.51.100.1")).status_code == 200

    monkeypatch.setattr(abuse, "PER_FORM_PER_HOUR", 7)
    r = await send(client, f, a, ip="198.51.100.3")
    assert r.status_code == 200
    r = await send(client, f, a, ip="198.51.100.4")
    assert r.status_code == 429 and r.json()["detail"]["message"] == "Lots of answers are arriving. Try again in a minute."
    await send(client, f, a, ip="198.51.100.5")
    told = [p for p in pushes if p.get("tag") == f"form-busy:{f.form_id}"]
    assert len(told) == 1 and told[0]["user_id"] == user.id


async def test_route_level_submit_limit(client, db, user, limits_on):
    f = await make_form(client, user, SIGNUP, audience="link")
    codes = [(await send(client, f, {"name": "x"}, ip="192.0.2.77")).status_code for _ in range(11)]
    assert codes[:10] == [422] * 10 and codes[10] == 429


async def test_gone_is_the_same_for_every_dead_link(client, db, user):
    from app.forms.responses import GONE_MESSAGE

    expected = {"detail": {"code": "gone", "message": GONE_MESSAGE}}
    a = {"name": "x", "dish": {"option": "bread"}}

    async def both(token, form_id):
        g = await client.get(f"/api/f/{token}")
        s = await client.post(f"/api/f/{token}/submit", json={
            "answers": a, "submit_id": str(uuid.uuid4()), "start_token": started(form_id)})
        m = await client.get(f"/api/f/{token}/mine", params={"edit": "x"})
        rep = await client.post(f"/api/f/{token}/report", json={"reason": "x"})
        return [(r.status_code, r.json()) for r in (g, s, m, rep)]

    want = [(404, expected)] * 4
    assert await both("not-a-real-token", uuid.uuid4()) == want

    revoked = await make_form(client, user, SIGNUP, audience="link")
    await client.delete(f"/api/forms/{revoked.fid}/link", headers=H(user))
    assert await both(revoked.token, revoked.form_id) == want

    reset = await make_form(client, user, SIGNUP, audience="link")
    r = await client.post(f"/api/forms/{reset.fid}/link", json={"reset": True}, headers=H(user))
    new_token = r.json()["link"]["token"]
    assert new_token != reset.token
    assert await both(reset.token, reset.form_id) == want
    assert (await client.get(f"/api/f/{new_token}")).json()["state"] == "open"

    trashed = await make_form(client, user, SIGNUP, audience="link")
    assert (await client.post(f"/api/files/{trashed.fid}/trash", headers=H(user))).status_code in (200, 204)
    assert await both(trashed.token, trashed.form_id) == want

    switched = await make_form(client, user, SIGNUP, audience="link")
    r = await client.patch("/api/admin/forms/settings", json={"link_answers": False}, headers=H(user))
    assert r.status_code == 200 and r.json()["link_answers"] is False
    assert await both(switched.token, switched.form_id) == want
    # A server form isn't a link form: it still works for people signed in.
    server = await make_form(client, user, SIGNUP, audience="server")
    mum = await mk_user(db, "mum")
    assert (await client.get(f"/api/f/{server.token}", headers=H(mum))).json()["state"] == "open"
    # And the builder can't switch a form to link answers meanwhile.
    r = await client.patch(f"/api/forms/{server.fid}/settings", json={"audience": "link"}, headers=H(user))
    assert r.status_code == 400
    await client.patch("/api/admin/forms/settings", json={"link_answers": True}, headers=H(user))
    assert (await client.get(f"/api/f/{switched.token}")).json()["state"] == "open"


async def test_answering_never_becomes_file_access(client, db, user):
    """A form link is a ``resource_type="form"`` row: /api/s doesn't serve
    it, claim_link ignores it, and answering grants nothing."""
    from sqlalchemy import func, select

    from app.files.link_roles import claim_link
    from app.files.models import FileShareGrant, FileShareLink, ResourceGrant, UserFile
    from app.forms.access import form_access

    f = await make_form(client, user, SIGNUP, audience="server")
    mum = await mk_user(db, "mum")
    for path in ("meta", "download", "office", "browse"):
        r = await client.get(f"/api/s/{f.token}/{path}", headers=H(mum))
        assert r.status_code == 404, (path, r.status_code)
    assert (await send(client, f, {"name": "Mum", "dish": {"option": "bread"}}, who=mum)).status_code == 200
    link = (await db.execute(select(FileShareLink).where(FileShareLink.token == f.token))).scalar_one()
    assert link.resource_type == "form" and link.access_mode == "invite"
    # Even a link row set to an edit role can't be claimed into a grant.
    link.role = "edit"
    await db.commit()
    assert await claim_link(db, link, mum) is None
    grants = await db.scalar(select(func.count()).select_from(ResourceGrant).where(ResourceGrant.grantee_user_id == mum.id))
    visits = await db.scalar(select(func.count()).select_from(FileShareGrant).where(FileShareGrant.user_id == mum.id))
    assert grants == 0 and visits == 0
    shell = await db.get(UserFile, uuid.UUID(f.fid))
    assert await form_access(db, shell, mum) == "none"
    assert (await client.get(f"/api/forms/{f.fid}", headers=H(mum))).status_code == 404
    assert (await client.get(f"/api/files/{f.fid}/download", headers=H(mum))).status_code == 404


async def test_shared_links_lists_form_links(client, db, user):
    f = await make_form(client, user, SIGNUP, audience="link")
    rows = (await client.get("/api/files/share-links", headers=H(user))).json()["links"]
    [row] = [r for r in rows if r["token"] == f.token]
    assert row["resource_type"] == "form" and row["path"] == f"/f/{f.token}"
    assert row["resource_name"] == "Answer test" and row["access_mode"] == "public"
    # Who can answer changes the link's mode with it.
    await client.patch(f"/api/forms/{f.fid}/settings", json={"audience": "server"}, headers=H(user))
    rows = (await client.get("/api/files/share-links", headers=H(user))).json()["links"]
    assert next(r for r in rows if r["token"] == f.token)["access_mode"] == "invite"
    # Turned off from Shared links: the answer page says it doesn't exist.
    assert (await client.delete(f"/api/files/share-links/{row['id']}", headers=H(user))).status_code == 204
    assert (await client.get(f"/api/f/{f.token}")).status_code == 404
    # A file share link can't be made for a form either.
    r = await client.post(f"/api/files/{f.fid}/share-links", json={"access_mode": "public"}, headers=H(user))
    assert r.status_code == 400


async def test_reports_and_admin_forms(client, db, user, pushes):
    owner = await mk_user(db, "sam")
    f = await make_form(client, owner, SIGNUP, audience="link")
    r = await client.post(f"/api/f/{f.token}/report", json={"reason": "It asks for <b>bank</b> details"})
    assert r.status_code == 204
    alerts = [p for p in pushes if p["category"] == "system_alert"]
    assert [p["user_id"] for p in alerts] == [user.id]  # the admin
    assert "bank" not in alerts[0]["body"] and "Answer test" in alerts[0]["body"]
    # Server forms have no Report.
    server = await make_form(client, owner, SIGNUP, audience="server")
    assert (await client.post(f"/api/f/{server.token}/report", json={"reason": "x"})).status_code == 404

    assert (await client.get("/api/admin/forms", headers=H(owner))).status_code == 403
    body = (await client.get("/api/admin/forms", headers=H(user))).json()
    assert body["link_answers"] is True
    [row] = [x for x in body["forms"] if x["form_id"] == str(f.form_id)]
    assert row["reports"] == 1 and row["owner"] == owner.username and row["state"] == "open"
    assert "answers" in row and "definition" not in row
    assert str(server.form_id) not in [x["form_id"] for x in body["forms"]]
    reps = (await client.get(f"/api/admin/forms/{f.form_id}/reports", headers=H(user))).json()["reports"]
    assert reps[0]["reason"] == "It asks for <b>bank</b> details"

    r = await client.post(f"/api/admin/forms/{f.form_id}/close", json={"reason": "Phishing"}, headers=H(user))
    assert r.status_code == 200
    assert next(x for x in r.json()["forms"] if x["form_id"] == str(f.form_id))["state"] == "closed"
    told = [p for p in pushes if p["user_id"] == owner.id]
    assert told and "Phishing" in told[-1]["body"]
    assert (await client.get(f"/api/f/{f.token}")).json()["state"] == "closed"


async def test_send_to_people(client, db, user, pushes):
    bob = await mk_user(db, "bob")
    gone = await mk_user(db, "gone")
    gone.disabled = True
    await db.commit()
    r = await client.post("/api/forms", json={}, headers=H(user))
    fid = r.json()["file"]["id"]
    await client.patch(f"/api/forms/{fid}/settings", json={"accepting": True}, headers=H(user))
    r = await client.post(f"/api/forms/{fid}/send", json={"user_ids": [str(bob.id), str(gone.id), str(user.id)]},
                          headers=H(user))
    assert r.status_code == 200 and r.json() == {"sent": 1}
    view = (await client.get(f"/api/forms/{fid}", headers=H(user))).json()
    token = view["link"]["token"]  # made on the way
    [p] = pushes
    assert p["user_id"] == bob.id and p["url"] == f"/f/{token}" and p["category"] == "invite"
    assert p["actor_user_id"] == user.id
    # Someone who can only read the form can't send it.
    reader = await mk_user(db, "reader")
    await client.post(f"/api/files/file/{fid}/grants", json={"grantee_user_id": str(reader.id), "can_edit": False},
                      headers=H(user))
    r = await client.post(f"/api/forms/{fid}/send", json={"user_ids": [str(bob.id)]}, headers=H(reader))
    assert r.status_code == 404


async def test_pictures_only_through_the_link(client, db, user):
    from PIL import Image

    f = await make_form(client, user, SIGNUP, audience="link")
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), "red").save(buf, format="PNG")
    up = (await client.post(f"/api/forms/{f.fid}/assets", files={"file": ("h.png", buf.getvalue(), "image/png")},
                            headers=H(user))).json()
    d = json.loads(json.dumps(SIGNUP))
    d["theme"]["header_asset_id"] = up["id"]
    v = (await client.get(f"/api/forms/{f.fid}", headers=H(user))).json()["form"]["data_version"]
    r = await client.put(f"/api/forms/{f.fid}/definition", json={"definition": d, "data_version": v}, headers=H(user))
    assert r.status_code == 200, r.text
    page = (await client.get(f"/api/f/{f.token}")).json()
    url = page["asset_urls"][up["id"]]
    assert url.startswith(f"/api/f/{f.token}/asset/")
    r = await client.get(url)
    assert r.status_code == 200 and r.headers["x-content-type-options"] == "nosniff"
    assert (await client.get(url.replace("sig=", "sig=0"))).status_code == 404
    await client.delete(f"/api/forms/{f.fid}/link", headers=H(user))
    assert (await client.get(url)).status_code == 404


async def test_file_questions_wait_for_uploads(client, db, user):
    d = defn([q("name", "short_text", required=True),
              q("receipt", "file_upload", required=True, kinds=["images"], max_files=1, max_size_mb=5)])
    f = await make_form(client, user, d, audience="link")
    page = (await client.get(f"/api/f/{f.token}")).json()
    assert [i["id"] for i in page["definition"]["items"]] == ["name"]
    r = await send(client, f, {"name": "x", "receipt": ["not-an-upload"]})
    assert r.status_code == 200
    [resp] = await responses_of(db, f.form_id)
    assert resp.answers == {"name": "x"}


async def test_answers_count_against_the_owner_but_dont_touch_recent(client, db, user):
    from app.files.models import UserFile

    f = await make_form(client, user, SIGNUP, audience="link")
    shell = await db.get(UserFile, uuid.UUID(f.fid))
    before, modified = shell.size_bytes, shell.modified_at
    assert (await send(client, f, {"name": "x" * 500, "dish": {"option": "bread"}})).status_code == 200
    shell = await db.get(UserFile, uuid.UUID(f.fid), populate_existing=True)
    assert shell.size_bytes > before + 500
    assert shell.modified_at == modified
