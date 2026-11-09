"""A form's definition (WP-F1.1): every type's config validated, branching
targets checked, the limits enforced, and answered questions kept."""
from __future__ import annotations

import pytest

from app.forms.definition import (
    MAX_ITEMS,
    MAX_OPTIONS,
    DefinitionError,
    asset_ids,
    keep_answered,
    remap_assets,
    search_text,
    validate_definition,
)


def _q(id_, kind="short_text", title="Q", **config):
    return {"id": id_, "kind": kind, "title": title, "config": config}


def _opts(n, **extra):
    return [{"id": f"o{i}", "label": f"Option {i}", **extra} for i in range(n)]


def _ok(items, **top):
    return validate_definition({"title": "T", "items": items, **top})


def _bad(items, **top) -> DefinitionError:
    with pytest.raises(DefinitionError) as exc:
        _ok(items, **top)
    return exc.value


def test_blank_and_defaults_filled_in():
    d = _ok([])
    assert d["version"] == 1 and d["theme"] == {
        "accent": "terracotta", "header_asset_id": None, "header_builtin": None, "font": "default"
    }
    d = _ok([_q("a"), _q("p", "paragraph"), _q("s", "linear_scale"), _q("r", "rating")])
    by = {i["id"]: i for i in d["items"]}
    assert by["a"]["config"]["validation"]["kind"] == "any"
    assert by["p"]["config"]["max_length"] == 5000
    assert by["s"]["config"] == {"min": 1, "max": 5, "min_label": "", "max_label": ""}
    assert by["r"]["config"] == {"max": 5, "icon": "star"}


def test_every_question_type_validates():
    items = [
        _q("short", validation={"kind": "number", "min": 1, "max": 9, "integer": True}, max_length=20),
        _q("email", validation={"kind": "email"}),
        _q("link", validation={"kind": "url"}),
        _q("para", "paragraph", max_length=10000, min_length=10),
        _q("mc", "multiple_choice", options=_opts(3, limit=2), other=True, shuffle=True),
        _q("cb", "checkboxes", options=_opts(4), min_selected=1, max_selected=3, other=True),
        _q("dd", "dropdown", options=_opts(2)),
        _q("scale", "linear_scale", min=0, max=10, min_label="Never", max_label="Always"),
        _q("rate", "rating", max=10, icon="heart"),
        _q("date", "date", include_time=True, include_year=False),
        _q("time", "time", mode="duration"),
        _q("file", "file_upload", kinds=["images", "pdf", "images"], max_files=10, max_size_mb=100),
        {"id": "txt", "kind": "text", "title": "About the day", "description": "Bring a hat", "required": True},
        {"id": "img", "kind": "image", "config": {"alt": "Map"}},
        {"id": "sec", "kind": "section", "title": "Part 2", "config": {"after": "submit"}},
    ]
    d = _ok(items)
    by = {i["id"]: i for i in d["items"]}
    assert by["file"]["config"]["kinds"] == ["images", "pdf"]  # de-duplicated
    assert by["txt"]["required"] is False  # blocks aren't questions


@pytest.mark.parametrize(
    "item, words",
    [
        (_q("a", validation={"kind": "email", "min": 1}), "number"),
        (_q("a", validation={"kind": "number", "min": 5, "max": 1}), "smallest"),
        (_q("a", min_length=10, max_length=5), "shortest"),
        (_q("a", "paragraph", max_length=10001), ""),
        (_q("a", "linear_scale", min=2), ""),
        (_q("a", "linear_scale", max=11), ""),
        (_q("a", "rating", max=2), ""),
        (_q("a", "rating", icon="smiley"), ""),
        (_q("a", "time", mode="later"), ""),
        (_q("a", "file_upload", kinds=[]), ""),
        (_q("a", "file_upload", kinds=["exe"]), ""),
        (_q("a", "file_upload", max_files=11), ""),
        (_q("a", "file_upload", max_size_mb=101), ""),
        (_q("a", "checkboxes", options=_opts(2), min_selected=3), "at least"),
        (_q("a", "checkboxes", options=[{"id": "o", "label": "x", "go_to": "submit"}]), "another section"),
        (_q("a", "multiple_choice", options=[{"id": "o", "label": "x"}, {"id": "o", "label": "y"}]), "same id"),
        (_q("a", "multiple_choice", options=[{"id": "o", "label": "x", "limit": 0}]), ""),
        (_q("a", "short_text", colour="red"), ""),
        ({"id": "a", "kind": "matrix"}, "question type"),
        ({"id": "a b", "kind": "text"}, "id"),
    ],
)
def test_bad_configs_are_refused(item, words):
    err = _bad([item])
    assert err.item_id == item["id"]
    assert words.lower() in str(err).lower()


def test_branching_targets_must_exist():
    sec = {"id": "s2", "kind": "section", "title": "Two", "config": {}}
    ok = _ok([
        _q("c", "multiple_choice", options=[{"id": "y", "label": "Yes", "go_to": "submit"},
                                            {"id": "n", "label": "No", "go_to": "s2"}], branching=True),
        sec,
    ], after="s2")
    assert ok["after"] == "s2"
    assert "isn't in the form" in str(_bad([_q("c", "dropdown", options=[{"id": "y", "go_to": "s9"}]), sec]))
    assert "isn't in the form" in str(_bad([sec], after="nowhere"))
    assert "itself" in str(_bad([{"id": "s2", "kind": "section", "config": {"after": "s2"}}]))
    # A deleted section isn't a target any more…
    gone = dict(sec, deleted=True)
    assert "isn't in the form" in str(_bad([_q("c", "dropdown", options=[{"id": "y", "go_to": "s2"}]), gone]))
    # …but a deleted question's old branches don't block a save.
    _ok([dict(_q("c", "dropdown", options=[{"id": "y", "go_to": "s9"}]), deleted=True)])


def test_limits():
    _ok([_q(f"q{i}") for i in range(MAX_ITEMS)])
    assert "at most" in str(_bad([_q(f"q{i}") for i in range(MAX_ITEMS + 1)]))
    # Deleted questions don't count towards the 200.
    _ok([_q(f"q{i}") for i in range(MAX_ITEMS)] + [dict(_q(f"d{i}"), deleted=True) for i in range(50)])
    _ok([_q("m", "multiple_choice", options=_opts(MAX_OPTIONS))])
    assert f"{MAX_OPTIONS} options" in str(_bad([_q("m", "multiple_choice", options=_opts(MAX_OPTIONS + 1))]))
    sections = [{"id": f"s{i}", "kind": "section", "config": {}} for i in range(49)]
    _ok(sections)
    assert "sections" in str(_bad(sections + [{"id": "s99", "kind": "section", "config": {}}]))
    assert "same id" in str(_bad([_q("a"), _q("a")]))
    # 256 KB of JSON.
    big = [dict(_q(f"q{i}"), description="x" * 4000) for i in range(70)]
    assert "too big" in str(_bad(big))
    # Text lengths.
    assert "too long" in str(_bad([dict(_q("a"), title="x" * 1001)]))
    assert "too long" in str(_bad([], description="x" * 5001))
    err = _bad([_q("a", "multiple_choice", options=[{"id": "o", "label": "x" * 501}])])
    assert err.item_id == "a" and "option" in str(err).lower()
    assert "object" in str(pytest.raises(DefinitionError, validate_definition, []).value)


def test_theme():
    d = _ok([], theme={"accent": "teal", "font": "serif", "header_builtin": "picnic-1"})
    assert d["theme"]["accent"] == "teal"
    _bad([], theme={"accent": "#ff0000"})
    _bad([], theme={"font": "comic"})


def test_keep_answered_puts_back_deleted_questions():
    old = _ok([_q("name"), _q("diet", "paragraph"), _q("unanswered")])
    new = _ok([_q("name")])
    kept = validate_definition(keep_answered(new, old, {"name", "diet"}))
    ids = {i["id"]: i for i in kept["items"]}
    assert set(ids) == {"name", "diet"}
    assert ids["diet"]["deleted"] is True and not ids["name"]["deleted"]


def test_search_text_and_assets():
    a1 = "11111111-1111-1111-1111-111111111111"
    a2 = "22222222-2222-2222-2222-222222222222"
    d = _ok(
        [
            dict(_q("a", "multiple_choice", title="Dish?", options=[{"id": "s", "label": "Salad", "image_asset_id": a2}]),
                 image_asset_id=a1),
            dict(_q("gone", title="Secret old question"), deleted=True),
        ],
        description="Bring food",
        theme={"header_asset_id": a1},
    )
    text = search_text(d)
    assert "Dish?" in text and "Salad" in text and "Bring food" in text and "Secret" not in text
    assert asset_ids(d) == {a1, a2}
    swapped = remap_assets(d, {a1: "33333333-3333-3333-3333-333333333333"})
    assert swapped["theme"]["header_asset_id"] == "33333333-3333-3333-3333-333333333333"
    assert swapped["items"][0]["config"]["options"][0]["image_asset_id"] is None


def test_templates_are_valid():
    from app.forms.templates import KEYS, built_in, listing

    # Six from phase 1, and the Quiz and Family trivia quizzes (WP-F2.4).
    assert len(KEYS) == 8
    for key in KEYS:
        defn, settings = built_in(key)
        assert defn["items"]
        assert set(settings) <= {
            "one_per_person", "allow_edit", "show_remaining", "confirmation", "audience", "quiz"
        }
    assert built_in("nope") is None
    assert [t["key"] for t in listing()] == list(KEYS)


# ---------------------------------------------------------------- through the API


@pytest.fixture
async def client(db, tmp_path, monkeypatch):
    import httpx

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


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


@pytest.mark.asyncio
async def test_a_save_that_drops_an_answered_question_keeps_it_deleted(client, db, user):
    import uuid

    from sqlalchemy import select

    from app.forms.models import Form, FormResponse

    r = await client.post("/api/files/office", json={"kind": "form", "form_template": "contact"}, headers=_auth(user))
    fid = r.json()["id"]
    form = (await db.execute(select(Form).where(Form.file_id == uuid.UUID(fid)))).scalar_one()
    db.add(FormResponse(form_id=form.id, number=1, source="server", answers={"phone": "0400"}, submit_id=uuid.uuid4()))
    await db.commit()
    d = (await client.get(f"/api/forms/{fid}", headers=_auth(user))).json()["form"]
    items = [i for i in d["definition"]["items"] if i["id"] not in ("phone", "address")]
    r = await client.put(f"/api/forms/{fid}/definition",
                         json={"definition": dict(d["definition"], items=items), "data_version": d["data_version"]},
                         headers=_auth(user))
    assert r.status_code == 200, r.text
    by = {i["id"]: i for i in r.json()["definition"]["items"]}
    assert "address" not in by  # unanswered: really gone
    assert by["phone"]["deleted"] is True  # answered: kept, marked deleted
