"""Contacts item (app/items/kinds/contacts): the model, every action (happy
path + refusal), search, duplicates and merging, reminders, the text, the
AI tool schemas, and one end-to-end API flow."""
from __future__ import annotations

import copy
import json
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from app.items.kinds.contacts import SPEC
from app.items.kinds.contacts import logic as L
from app.items.kinds.contacts.actions import split_name
from app.items.spec import ActionError, ItemContext

TZ = ZoneInfo("Australia/Sydney")
NOW = datetime(2026, 10, 31, 10, 0, tzinfo=TZ)  # a Saturday


def ctx(now: datetime = NOW) -> ItemContext:
    return ItemContext(db=None, user=None, file_id=None, now=now, tz=now.tzinfo)  # type: ignore[arg-type]


def blank() -> dict:
    return SPEC.validate(SPEC.template(ctx()))


def run(data: dict, name: str, args: dict | None = None, now: datetime = NOW):
    action = SPEC.action(name)
    assert action is not None, name
    params = action.params.model_validate(args or {})
    out = action.run(ctx(now), data, params)
    # Whatever an action leaves must still be a valid file.
    fresh = SPEC.validate(data)
    data.clear()
    data.update(fresh)
    return out


def sample() -> dict:
    d = blank()
    run(
        d,
        "add_contacts",
        {
            "contacts": [
                {
                    "full_name": "Dr Sam Q. Rivera Jr.",
                    "company": "Atlassian",
                    "title": "Product Manager",
                    "emails": [{"label": "work", "value": "sam.rivera@atlassian.com"}],
                    "phones": [{"label": "mobile", "value": "+61 400 123 456"}],
                    "birthday": "1992-11-03",
                    "tags": ["climbing", "Climbing", "work"],
                    "groups": ["Work"],
                    "met_where": "DevCon",
                    "remember": ["Allergic to nuts"],
                },
                {"first": "Alex", "last": "Chen", "birthday": "--11-10", "groups": ["Family"], "favorite": True},
                {"first": "Priya", "last": "Nair", "emails": [{"value": "priya@example.com"}], "notes": "Loves hiking"},
            ]
        },
    )
    return d


def by_name(d: dict, first: str) -> dict:
    return next(c for c in d["contacts"] if c["first"] == first)


# ---------------------------------------------------------------- model


def test_template_and_old_files_load():
    d = blank()
    assert d["contacts"] == [] and d["groups"] == [] and d["settings"]["reminder_time"] == "09:00"
    assert SPEC.validate({})["settings"]["birthday_reminders"] is True
    # A bare contact gets every default.
    c = SPEC.validate({"contacts": [{"id": "c1", "first": "Ann"}]})["contacts"][0]
    assert c["interactions"] == [] and c["cadence_days"] is None and c["favorite"] is False


def test_model_validates_dates_and_normalises():
    ok = SPEC.validate({"contacts": [{"id": "a", "birthday": "--02-29", "tags": [" x ", "X", "y", ""]}]})
    assert ok["contacts"][0]["birthday"] == "--02-29"
    assert ok["contacts"][0]["tags"] == ["x", "y"]
    for bad in ("2026-02-30", "1990-13-01", "03/04/1990", "--00-10"):
        with pytest.raises(ValidationError):
            SPEC.validate({"contacts": [{"id": "a", "birthday": bad}]})
    # Blank strings become "no date".
    assert SPEC.validate({"contacts": [{"id": "a", "birthday": ""}]})["contacts"][0]["birthday"] is None
    with pytest.raises(ValidationError):
        SPEC.validate({"contacts": [{"id": "a"}, {"id": "a"}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"contacts": [{"id": "a", "interactions": [{"id": "i", "date": "2026-1-1"}]}]})


def test_dangling_links_are_cleaned_and_interactions_sorted():
    d = SPEC.validate(
        {
            "groups": [{"id": "g1", "name": "Work"}],
            "contacts": [
                {
                    "id": "a",
                    "groups": ["g1", "gone"],
                    "relationships": [
                        {"id": "r1", "type": "friend", "contact_id": "nobody", "name": "Old name"},
                        {"id": "r2", "type": "friend", "contact_id": "nobody"},
                        {"id": "r3", "type": "friend", "contact_id": "a", "name": ""},
                    ],
                    "interactions": [
                        {"id": "i1", "date": "2026-01-01"},
                        {"id": "i2", "date": "2026-05-01"},
                    ],
                }
            ],
        }
    )
    c = d["contacts"][0]
    assert c["groups"] == ["g1"]
    assert [(r["id"], r["contact_id"]) for r in c["relationships"]] == [("r1", None)]
    assert [i["id"] for i in c["interactions"]] == ["i2", "i1"]


# --------------------------------------------------------------- helpers


@pytest.mark.parametrize(
    "raw, want",
    [
        ("1990-03-15", "1990-03-15"),
        ("19900315", "1990-03-15"),
        ("--0315", "--03-15"),
        ("--03-15", "--03-15"),
        ("1604-03-15", "--03-15"),
        ("1990-03-15T00:00:00Z", "1990-03-15"),
        ("15 March 1990", "1990-03-15"),
        ("March 15, 1990", "1990-03-15"),
        ("3 Sept", "--09-03"),
        ("03-15", "--03-15"),
        ("today", "2026-10-31"),
        ("yesterday", "2026-10-30"),
        ("2026-02-30", None),
        ("someday", None),
    ],
)
def test_parse_date_flexible(raw, want):
    assert L.parse_date_flexible(raw, date(2026, 10, 31)) == want


def test_split_name():
    assert split_name("Dr Jane Q. Smith Jr.") == {"prefix": "Dr", "first": "Jane", "middle": "Q.", "last": "Smith", "suffix": "Jr."}
    assert split_name("Smith, Jane")["first"] == "Jane" and split_name("Smith, Jane")["last"] == "Smith"
    assert split_name("Cher") == {"prefix": "", "first": "Cher", "middle": "", "last": "", "suffix": ""}


def test_dates_and_ages():
    today = date(2026, 10, 31)
    assert L.next_occurrence("--10-31", today) == today
    assert L.next_occurrence("1990-10-30", today) == date(2027, 10, 30)
    assert L.next_occurrence("--02-29", date(2027, 1, 1)) == date(2027, 2, 28)
    assert L.next_occurrence("--02-29", date(2028, 1, 1)) == date(2028, 2, 29)
    assert L.age("1990-11-01", today) == 35 and L.age("1990-10-31", today) == 36 and L.age("--10-31", today) is None


# --------------------------------------------------------------- actions


def test_add_contacts_fills_fields_groups_and_ids():
    d = sample()
    sam = by_name(d, "Sam")
    assert (sam["prefix"], sam["middle"], sam["last"], sam["suffix"]) == ("Dr", "Q.", "Rivera", "Jr.")
    assert sam["id"] == "c-sam-q-rivera-jr" and sam["tags"] == ["climbing", "work"]
    assert sam["remember"][0]["text"] == "Allergic to nuts" and sam["remember"][0]["added"] == "2026-10-31"
    assert {g["name"] for g in d["groups"]} == {"Work", "Family"}
    assert sam["groups"] == [next(g["id"] for g in d["groups"] if g["name"] == "Work")]
    assert sam["created_at"].startswith("2026-10-31T10:00:00")
    # Same name again → a fresh id, and it's flagged as a possible duplicate.
    out = run(d, "add_contacts", {"contacts": [{"first": "Alex", "last": "Chen"}]})
    assert out.result["added"][0]["id"] == "c-alex-chen-2"
    assert out.result["possible_duplicates"][0]["existing_id"] == "c-alex-chen"


def test_add_contacts_skip_and_merge_duplicates():
    d = sample()
    out = run(d, "add_contacts", {"contacts": [{"first": "S", "emails": [{"value": "SAM.RIVERA@atlassian.com"}]}], "on_duplicate": "skip"})
    assert out.result["skipped"][0]["id"] == "c-sam-q-rivera-jr" and len(d["contacts"]) == 3
    out = run(
        d,
        "add_contacts",
        {
            "contacts": [{"full_name": "Sam Rivera", "phones": [{"value": "0400 123 456"}, {"label": "work", "value": "02 9999 0000"}], "remember": ["Has a dog"]}],
            "on_duplicate": "merge",
        },
    )
    assert out.summary.startswith("Merged 1") and len(d["contacts"]) == 3
    sam = by_name(d, "Sam")
    assert [p["value"] for p in sam["phones"]] == ["+61 400 123 456", "02 9999 0000"]  # same number not repeated
    assert {n["text"] for n in sam["remember"]} == {"Allergic to nuts", "Has a dog"}


def test_add_contacts_refuses_an_empty_person():
    with pytest.raises(ActionError):
        run(blank(), "add_contacts", {"contacts": [{"notes": "who?"}]})
    with pytest.raises(ActionError):
        run(blank(), "add_contacts", {"contacts": [{"first": "A", "birthday": "the other day"}]})


def test_a_big_import_leaves_out_bad_rows_instead_of_failing():
    d = blank()
    out = run(
        d,
        "add_contacts",
        {"contacts": [{"first": "Ok", "birthday": "the other day", "dates": [{"date": "nope"}]}, {"notes": "nobody"}, {"full_name": "Dr."}]},
    )
    assert out.result["invalid"] == 2 and len(d["contacts"]) == 1
    assert d["contacts"][0]["birthday"] is None and d["contacts"][0]["dates"] == []
    assert "left out 2" in out.summary


def test_add_contacts_links_relationships_both_ways():
    d = sample()
    run(d, "add_contacts", {"contacts": [{"first": "Jo", "relationships": [{"type": "spouse", "contact_id": "c-alex-chen"}, {"type": "child", "name": "Mia"}]}]})
    jo, alex = by_name(d, "Jo"), by_name(d, "Alex")
    assert {(r["type"], r["contact_id"], r["name"]) for r in jo["relationships"]} == {("spouse", "c-alex-chen", ""), ("child", None, "Mia")}
    assert alex["relationships"][0]["contact_id"] == jo["id"] and alex["relationships"][0]["type"] == "spouse"


def test_update_contact():
    d = sample()
    out = run(
        d,
        "update_contact",
        {
            "contact_id": "Priya Nair",
            "company": "Canva",
            "title": "Designer",
            "add_phones": [{"label": "mobile", "value": "0411 222 333"}],
            "append_note": "Starts at Canva in November.",
            "remember": ["Kids: Mia 6, Leo 3"],
            "topics": ["Ask how the move went"],
            "gift_ideas": ["Hiking socks"],
            "birthday": "4 July",
        },
    )
    p = by_name(d, "Priya")
    assert "company, title" in out.summary and p["company"] == "Canva" and p["birthday"] == "--07-04"
    assert p["notes"] == "Loves hiking\n\nStarts at Canva in November."
    assert p["phones"][0]["value"] == "0411 222 333" and p["topics"][0]["id"] == "t1"
    run(d, "update_contact", {"contact_id": p["id"], "mark_done": ["t1"], "remove_notes": ["g1"], "remove_values": ["0411222333"], "birthday": ""})
    p = by_name(d, "Priya")
    assert p["topics"][0]["done"] is True and p["gifts"] == [] and p["phones"] == [] and p["birthday"] is None
    with pytest.raises(ActionError, match="Nothing to change"):
        run(d, "update_contact", {"contact_id": p["id"]})
    with pytest.raises(ActionError, match="No contact"):
        run(d, "update_contact", {"contact_id": "Zed", "first": "Z"})
    with pytest.raises(ActionError, match="Colours"):
        run(d, "update_contact", {"contact_id": p["id"], "color": "blue"})


def test_ambiguous_names_need_an_id():
    d = sample()
    run(d, "add_contacts", {"contacts": [{"first": "Alex", "last": "Chen"}]})
    with pytest.raises(ActionError, match="More than one"):
        run(d, "update_contact", {"contact_id": "alex chen", "title": "x"})


def test_delete_contact_keeps_links_as_names():
    d = sample()
    run(d, "add_relationship", {"contact_id": "Sam", "type": "friend", "other_contact_id": "c-alex-chen"})
    out = run(d, "delete_contact", {"contact_ids": ["c-alex-chen"]})
    assert out.summary == "Deleted Alex Chen" and len(d["contacts"]) == 2
    rel = by_name(d, "Sam")["relationships"][0]
    assert rel["contact_id"] is None and rel["name"] == "Alex Chen"
    with pytest.raises(ActionError):
        run(d, "delete_contact", {"contact_ids": ["nope"]})


def test_merge_preview_and_merge():
    d = sample()
    run(d, "add_contacts", {"contacts": [{"first": "Sammy", "last": "R", "emails": [{"value": "sam@home.net"}], "phones": [{"value": "0400123456"}], "favorite": True, "notes": "Home email"}]})
    dupe = by_name(d, "Sammy")
    run(d, "log_interaction", {"contact_ids": [dupe["id"]], "type": "call", "date": "2026-10-01"})
    run(d, "add_relationship", {"contact_id": "Priya", "type": "colleague", "other_contact_id": dupe["id"]})
    before = copy.deepcopy(d)
    prev = run(d, "preview_merge", {"keep_id": "c-sam-q-rivera-jr", "merge_ids": [dupe["id"]]})
    assert d == before  # read-only
    m = prev.result["merged"]
    assert [e["value"] for e in m["emails"]] == ["sam.rivera@atlassian.com", "sam@home.net"] and len(m["phones"]) == 1
    out = run(d, "merge_contacts", {"keep_id": "c-sam-q-rivera-jr", "merge_ids": [dupe["id"]]})
    assert out.summary == "Merged 1 contact into Sam Q. Rivera Jr." and len(d["contacts"]) == 3
    sam = by_name(d, "Sam")
    assert sam["favorite"] is True and sam["notes"] == "Home email" and L.last_contacted(sam) == "2026-10-01"
    # Priya's link now points at the kept contact, both ways.
    assert by_name(d, "Priya")["relationships"][0]["contact_id"] == sam["id"]
    assert sam["relationships"][0]["contact_id"] == by_name(d, "Priya")["id"]
    with pytest.raises(ActionError):
        run(d, "merge_contacts", {"keep_id": sam["id"], "merge_ids": [sam["id"]]})


def test_find_duplicates_and_ruling_out():
    d = sample()
    run(d, "add_contacts", {"contacts": [{"first": "alex", "last": "chén"}, {"first": "P", "emails": [{"value": "Priya@Example.com"}]}]})
    groups = run(d, "find_duplicates").result["groups"]
    assert len(groups) == 2
    reasons = sorted(r for g in groups for r in g["reasons"])
    assert reasons == ["same email", "same name"]
    alex_ids = sorted(c["id"] for c in d["contacts"] if L.fold(c["first"]) == "alex")
    d["settings"]["not_duplicates"] = ["|".join(alex_ids)]
    assert run(d, "find_duplicates").result["count"] == 1


def test_log_interaction_and_keep_in_touch():
    d = sample()
    run(d, "set_reminder_cadence", {"contact_ids": ["Sam", "Alex"], "every_days": 30})
    due = run(d, "due_to_reconnect").result["people"]
    assert [p["name"] for p in due] == ["Alex Chen", "Sam Q. Rivera Jr."]  # never contacted = due now (favourite first)
    out = run(d, "log_interaction", {"contact_ids": ["Sam", "Alex"], "type": "meeting", "date": "2026-10-20", "notes": "Climbing gym", "follow_ups": ["Send the route guide"]})
    assert out.summary == "Logged a catch-up with Sam Q. Rivera Jr. and Alex Chen"
    assert out.result["logged"][0]["next_due"] == "2026-11-19"
    sam = by_name(d, "Sam")
    assert L.last_contacted(sam) == "2026-10-20" and sam["topics"][0]["text"] == "Send the route guide"
    assert run(d, "due_to_reconnect").result["count"] == 0
    assert run(d, "due_to_reconnect", {"within_days": 30}).result["count"] == 2
    # An older one doesn't move "last contacted" back.
    run(d, "log_interaction", {"contact_ids": ["Sam"], "type": "call", "date": "2026-09-01"})
    assert L.last_contacted(by_name(d, "Sam")) == "2026-10-20"
    with pytest.raises(ActionError, match="future"):
        run(d, "log_interaction", {"contact_ids": ["Sam"], "date": "2026-11-05"})
    with pytest.raises(ActionError):
        run(d, "log_interaction", {"contact_ids": ["Sam"], "date": "whenever"})


def test_cadence_snooze_and_clear():
    d = sample()
    out = run(d, "set_reminder_cadence", {"contact_ids": ["Sam"], "every_days": 14, "snooze_days": 10})
    assert out.result[0]["due_on"] == "2026-11-10"
    run(d, "set_reminder_cadence", {"contact_ids": ["Sam"], "clear": True})
    assert by_name(d, "Sam")["cadence_days"] is None
    with pytest.raises(ActionError):
        run(d, "set_reminder_cadence", {"contact_ids": ["Sam"]})


def test_important_dates_and_upcoming():
    d = sample()
    run(d, "add_important_date", {"contact_id": "Priya", "kind": "birthday", "date": "1988-11-05"})
    run(d, "add_important_date", {"contact_id": "Alex", "kind": "anniversary", "date": "2016-11-20", "label": "Wedding anniversary"})
    again = run(d, "add_important_date", {"contact_id": "Alex", "kind": "anniversary", "date": "2016-11-20", "label": "wedding anniversary"})
    assert again.summary.startswith("Updated") and len(by_name(d, "Alex")["dates"]) == 1
    up = run(d, "upcoming_dates", {"days": 30}).result["dates"]
    assert [(e["name"], e["date"], e.get("turns"), e.get("years")) for e in up] == [
        ("Sam Q. Rivera Jr.", "2026-11-03", 34, None),
        ("Priya Nair", "2026-11-05", 38, None),
        ("Alex Chen", "2026-11-10", None, None),
        ("Alex Chen", "2026-11-20", None, 10),
    ]
    with pytest.raises(ActionError):
        run(d, "add_important_date", {"contact_id": "Alex", "date": "soon"})


def test_add_relationship():
    d = sample()
    out = run(d, "add_relationship", {"contact_id": "Alex", "type": "manager", "other_contact_id": "Priya"})
    assert out.summary == "Priya Nair is now Alex Chen's manager"
    assert by_name(d, "Priya")["relationships"][0]["type"] == "report"
    with pytest.raises(ActionError, match="already"):
        run(d, "add_relationship", {"contact_id": "Alex", "type": "manager", "other_contact_id": "Priya"})
    with pytest.raises(ActionError, match="themselves"):
        run(d, "add_relationship", {"contact_id": "Alex", "type": "friend", "other_contact_id": "Alex"})
    run(d, "add_relationship", {"contact_id": "Alex", "type": "child", "name": "Mia", "label": "daughter"})
    assert by_name(d, "Alex")["relationships"][-1]["name"] == "Mia"
    with pytest.raises(ActionError):
        run(d, "add_relationship", {"contact_id": "Alex", "type": "child"})


def test_tag_and_untag():
    d = sample()
    out = run(d, "tag_contacts", {"contact_ids": ["Sam", "Priya"], "tags": ["hiking"], "groups": ["Book club"]})
    assert out.result["changed"] == 2 and any(g["name"] == "Book club" for g in d["groups"])
    run(d, "untag_contacts", {"contact_ids": ["Sam"], "tags": ["HIKING"], "groups": ["book club"]})
    sam = by_name(d, "Sam")
    assert "hiking" not in sam["tags"] and len(sam["groups"]) == 1
    with pytest.raises(ActionError):
        run(d, "tag_contacts", {"contact_ids": ["Sam"]})


def test_update_settings():
    d = sample()
    run(d, "update_settings", {"birthday_days_before": 3, "reminder_time": "08:30", "default_cadence_days": 0})
    assert d["settings"]["birthday_days_before"] == 3 and d["settings"]["default_cadence_days"] is None
    with pytest.raises(ActionError):
        run(d, "update_settings", {"reminder_time": "8am"})
    with pytest.raises(ActionError):
        run(d, "update_settings", {})


def test_find_contacts_is_fuzzy_across_fields():
    d = sample()
    run(d, "add_relationship", {"contact_id": "Priya", "type": "partner", "name": "Rohan"})

    def names(q, **kw):
        return [c["name"] for c in run(d, "find_contacts", {"query": q, **kw}).result["contacts"]]

    assert names("atlasian") == ["Sam Q. Rivera Jr."]  # a typo
    assert names("hiking") == ["Priya Nair"]  # notes
    assert names("rohan") == ["Priya Nair"]  # relationships
    assert names("nuts") == ["Sam Q. Rivera Jr."]  # things to remember
    assert names("0400 123") == ["Sam Q. Rivera Jr."]  # phone digits
    assert names("", tag="climbing") == ["Sam Q. Rivera Jr."]
    assert names("", group="family") == ["Alex Chen"]
    assert names("", favorites_only=True) == ["Alex Chen"]
    assert names("zebra") == []


def test_contact_brief():
    d = sample()
    run(d, "log_interaction", {"contact_ids": ["Sam"], "type": "call", "date": "2026-10-25", "notes": "Talked about the new role", "follow_ups": ["Ask about the offsite"]})
    b = run(d, "contact_brief", {"contact_id": "Sam"}).result
    assert b["work"] == "Product Manager · Atlassian" and b["age"] == 33
    assert b["remember"] == ["Allergic to nuts"] and b["open_topics"][0]["text"] == "Ask about the offsite"
    assert b["days_since_contact"] == 6 and b["upcoming_dates"][0]["date"] == "2026-11-03"
    with pytest.raises(ActionError):
        run(d, "contact_brief", {"contact_id": "Nobody"})


def test_actions_are_deterministic():
    a, b = sample(), sample()
    for d in (a, b):
        run(d, "log_interaction", {"contact_ids": ["Sam"], "type": "call"})
        run(d, "add_contacts", {"contacts": [{"full_name": "New Person", "groups": ["Club"]}]})
    assert a == b


# -------------------------------------------------------------- reminders


def _reminders(d: dict, now: datetime = NOW):
    return SPEC.reminders(d, ctx(now))


def test_birthday_and_date_reminders():
    d = sample()  # Sam's birthday 3 Nov, Alex 10 Nov
    run(d, "add_important_date", {"contact_id": "Priya", "kind": "anniversary", "date": "2020-11-01", "label": "Work anniversary"})
    rs = {r.key: r for r in _reminders(d)}
    sam = rs["bday:c-sam-q-rivera-jr:2026"]
    assert sam.due_at == datetime(2026, 11, 3, 9, 0, tzinfo=TZ) and "turns 34" in sam.body
    assert rs["date:c-priya-nair:d1:2026"].title == "Priya Nair: Work anniversary (6th) today"
    # 10 Nov is past the 8-day horizon only when the framework trims; it's within 9 days here.
    d["settings"].update({"birthday_days_before": 2, "reminder_time": "18:15"})
    rs = {r.key: r for r in _reminders(d)}
    pre = rs["bday-pre:c-sam-q-rivera-jr:2026:2"]
    assert pre.due_at == datetime(2026, 11, 1, 18, 15, tzinfo=TZ) and "in 2 days" in pre.title
    d["settings"].update({"birthday_reminders": False, "date_reminders": False})
    assert not [k for k in (r.key for r in _reminders(d)) if k.startswith(("bday", "date"))]


def test_todays_birthday_after_the_time_has_passed_isnt_sent_late():
    d = sample()
    late = datetime(2026, 11, 3, 15, 0, tzinfo=TZ)
    assert not any(r.key.startswith("bday:c-sam") for r in _reminders(d, late))
    early = datetime(2026, 11, 3, 7, 0, tzinfo=TZ)
    assert any(r.key == "bday:c-sam-q-rivera-jr:2026" for r in _reminders(d, early))


def test_weekly_keep_in_touch_digest():
    d = sample()
    assert not any(r.key.startswith("digest") for r in _reminders(d))  # nobody on a rhythm
    run(d, "set_reminder_cadence", {"contact_ids": ["Sam", "Alex", "Priya"], "every_days": 30})
    digests = [r for r in _reminders(d) if r.key.startswith("digest")]
    assert len(digests) == 1  # one, on the next Monday — not one per person
    r = digests[0]
    assert r.key == "digest:2026-11-02" and r.due_at.weekday() == 0
    assert r.title == "Time to catch up with 3 people" and "Alex Chen" in r.body
    d["settings"]["reconnect_digest"] = False
    assert not any(r.key.startswith("digest") for r in _reminders(d))


# ------------------------------------------------------------------- text


def test_to_text():
    d = sample()
    run(d, "log_interaction", {"contact_ids": ["Sam"], "type": "call", "notes": "Talked about climbing"})
    text = SPEC.to_text(d)
    assert text.startswith("Address book: 3 people (1 favourites).")
    assert "Sam Q. Rivera Jr." in text and "Product Manager at Atlassian" in text and "remember: Allergic to nuts" in text
    assert "Groups:" in text and "Recent interactions:" in text


def test_to_text_is_bounded():
    d = blank()
    run(d, "add_contacts", {"contacts": [{"first": f"Person{i}", "last": "Example", "notes": "x" * 300, "emails": [{"value": f"p{i}@example.com"}]} for i in range(1500)]})
    text = SPEC.to_text(d)
    assert len(text) <= 21_000 and "more." in text


# --------------------------------------------------------------- AI tools


def test_tools_have_no_refs_and_include_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    assert {a.name for a in SPEC.actions} <= names
    assert "$ref" not in json.dumps(tools)
    read_only = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert {"find_contacts", "upcoming_dates", "due_to_reconnect", "contact_brief"} <= read_only
    assert "add_contacts" not in read_only
    assert SPEC.kind == "contacts" and SPEC.suffix == ".contacts" and SPEC.color == "#3B7DD8" and SPEC.category == "People"


# ------------------------------------------------------- fix pass: phones


@pytest.mark.parametrize(
    "raw, cc, want",
    [
        ("0400 123 456", "AU", ("+61400123456", "")),
        ("+61 400 123 456", "AU", ("+61400123456", "")),
        ("0061 400 123 456", "AU", ("+61400123456", "")),
        ("400 123 456", "AU", ("+61400123456", "")),
        ("(02) 9999 0000 ext. 12", "AU", ("+61299990000", "12")),
        ("+61 2 9999 0000;ext=7", "AU", ("+61299990000", "7")),
        ("9999 0000", "AU", ("", "")),  # no area code: not comparable
        ("123", "AU", ("", "")),
        ("(212) 555-0142 x9", "US", ("+12125550142", "9")),
        ("1-212-555-0142", "US", ("+12125550142", "")),
        ("011 44 20 7946 0958", "US", ("+442079460958", "")),
        ("020 7946 0958", "GB", ("+442079460958", "")),
        ("06 1234 5678", "IT", ("+390612345678", "")),
        ("tel:+64211234567", "AU", ("+64211234567", "")),
    ],
)
def test_phone_parts_are_full_international_numbers(raw, cc, want):
    assert L.phone_parts(raw, cc) == want


def test_numbers_that_share_only_the_last_digits_are_different_people():
    # The old key compared the last 9 digits: +44 400 123 456 "matched" 0400 123 456.
    assert L.phone_key("+44 400 123 456") != L.phone_key("0400 123 456")
    assert L.phone_key("(02) 9999 0000 x12") != L.phone_key("(02) 9999 0000")
    assert L.phone_key("0400 123 456") == L.phone_key("+61400123456")


def test_home_country_from_settings_location_and_time_zone():
    class U:
        settings = {"location": "Manchester, United Kingdom"}

    assert L.home_country({"settings": {"phone_country": "NZ"}}, U(), "Australia/Sydney") == "NZ"
    assert L.home_country({"settings": {}}, U(), "Australia/Sydney") == "GB"
    assert L.home_country({"settings": {}}, None, "America/Toronto") == "CA"
    assert L.home_country({"settings": {}}, None, "America/Chicago") == "US"
    assert L.home_country({"settings": {}}, None, None) == "AU"


def test_phone_country_setting_changes_how_national_numbers_are_read():
    d = sample()
    run(d, "update_settings", {"phone_country": "gb"})
    assert d["settings"]["phone_country"] == "GB"
    with pytest.raises(ActionError, match="phone format"):
        run(d, "update_settings", {"phone_country": "ZZ"})
    run(d, "add_contacts", {"contacts": [{"first": "Pat", "phones": [{"value": "+44 20 7946 0958"}]}]})
    out = run(d, "add_contacts", {"contacts": [{"first": "P2", "phones": [{"value": "020 7946 0958"}]}], "on_duplicate": "skip"})
    assert out.result["skipped"] and out.result["skipped"][0]["why"] == "same phone"


# ------------------------------------------------------ fix pass: imports


def test_an_import_never_merges_people_inside_itself():
    d = blank()
    # A shared family email and landline, two different John Smiths — all in one import.
    out = run(
        d,
        "add_contacts",
        {
            "contacts": [
                {"first": "Ann", "last": "Lee", "emails": [{"value": "lees@home.net"}], "phones": [{"value": "02 9999 0000"}]},
                {"first": "Bo", "last": "Lee", "emails": [{"value": "lees@home.net"}], "phones": [{"value": "02 9999 0000"}]},
                {"first": "John", "last": "Smith", "emails": [{"value": "john@a.com"}]},
                {"first": "John", "last": "Smith", "emails": [{"value": "john@b.com"}]},
            ],
            "on_duplicate": "merge",
            "batch": True,
        },
    )
    assert len(out.result["added"]) == 4 and out.result["merged"] == [] and len(d["contacts"]) == 4


def test_a_same_name_is_never_merged_or_skipped_only_flagged():
    d = sample()
    out = run(d, "add_contacts", {"contacts": [{"first": "Priya", "last": "Nair", "emails": [{"value": "other@x.com"}]}], "on_duplicate": "merge"})
    assert len(out.result["added"]) == 1 and out.result["merged"] == []
    assert out.result["possible_duplicates"][0]["why"] == "same name"
    out = run(d, "add_contacts", {"contacts": [{"first": "Alex", "last": "Chen"}], "on_duplicate": "skip"})
    assert out.result["skipped"] == [] and len(out.result["added"]) == 1


def test_a_number_shared_by_more_than_two_people_is_ignored():
    d = blank()
    run(d, "add_contacts", {"contacts": [{"first": n, "phones": [{"value": "02 9999 0000"}]} for n in ("A", "B", "C")], "batch": True})
    out = run(d, "add_contacts", {"contacts": [{"first": "D", "phones": [{"value": "+61 2 9999 0000"}]}], "on_duplicate": "merge"})
    assert out.result["merged"] == [] and len(d["contacts"]) == 4
    assert L.duplicate_groups(d) == []  # a shared office line isn't a duplicate set
    # Two people sharing a number still pair up.
    e = blank()
    run(e, "add_contacts", {"contacts": [{"first": "A", "phones": [{"value": "0400 111 222"}]}]})
    out = run(e, "add_contacts", {"contacts": [{"first": "A2", "phones": [{"value": "+61400111222"}]}], "on_duplicate": "merge"})
    assert len(out.result["merged"]) == 1 and out.result["merged"][0]["why"] == "same phone"


def test_import_chunks_dont_match_each_other_and_a_retry_is_idempotent():
    d = sample()
    chunk1 = [
        {"first": "Kai", "emails": [{"value": "kai@x.com"}], "import_ref": "imp1:0", "groups": ["Imported"]},
        {"first": "Sam", "emails": [{"value": "sam.rivera@atlassian.com"}], "import_ref": "imp1:1"},
    ]
    chunk2 = [{"first": "Kai2", "emails": [{"value": "kai@x.com"}], "import_ref": "imp1:2"}]
    out = run(d, "add_contacts", {"contacts": chunk1, "on_duplicate": "merge", "batch": True, "import_id": "imp1"})
    assert [a["name"] for a in out.result["added"]] == ["Kai"] and out.result["merged"][0]["id"] == "c-sam-q-rivera-jr"
    # The last chunk has a single contact — still batch mode, and it isn't matched with chunk 1's Kai.
    out = run(d, "add_contacts", {"contacts": chunk2, "on_duplicate": "merge", "batch": True, "import_id": "imp1"})
    assert [a["name"] for a in out.result["added"]] == ["Kai2"]
    n = len(d["contacts"])
    # Retrying chunk 1 after a dropped connection adds nobody twice.
    out = run(d, "add_contacts", {"contacts": chunk1, "on_duplicate": "merge", "batch": True, "import_id": "imp1"})
    assert out.result["added"] == [] and out.result["already_imported"] == 1 and len(d["contacts"]) == n
    sam = by_name(d, "Sam")
    assert [e["value"] for e in sam["emails"]] == ["sam.rivera@atlassian.com"]


def test_batch_mode_is_an_explicit_flag():
    d = blank()
    out = run(d, "add_contacts", {"contacts": [{"first": "Ok", "birthday": "the other day"}], "batch": True})
    assert len(out.result["added"]) == 1 and d["contacts"][0]["birthday"] is None
    out = run(d, "add_contacts", {"contacts": [{"notes": "nobody"}], "batch": True})
    assert out.result["invalid"] == 1
    with pytest.raises(ActionError):
        run(d, "add_contacts", {"contacts": [{"first": "A", "birthday": "nope"}, {"first": "B"}], "batch": False})


def test_groups_are_only_created_for_people_added_or_merged():
    d = sample()
    out = run(d, "add_contacts", {"contacts": [{"first": "X", "emails": [{"value": "priya@example.com"}], "groups": ["Ghost group"]}], "on_duplicate": "skip"})
    assert out.result["skipped"] and not any(g["name"] == "Ghost group" for g in d["groups"])
    run(d, "add_contacts", {"contacts": [{"first": "X", "emails": [{"value": "priya@example.com"}], "groups": ["Hikers"]}], "on_duplicate": "merge"})
    gid = next(g["id"] for g in d["groups"] if g["name"] == "Hikers")
    assert gid in by_name(d, "Priya")["groups"]


def test_a_reimported_card_matches_by_its_uid():
    d = sample()
    sam = by_name(d, "Sam")
    # Exported as UID promptly-<id>; they changed jobs, so no email/phone in common.
    out = run(
        d, "add_contacts",
        {"contacts": [{"first": "Sam", "uid": f"promptly-{sam['id']}", "emails": [{"value": "sam@newjob.com"}]}], "on_duplicate": "merge"},
    )
    assert out.result["merged"][0] == {"id": sam["id"], "name": "Sam Q. Rivera Jr.", "why": "same card"}
    # A card from another app keeps its UID, and the next import of it matches.
    run(d, "add_contacts", {"contacts": [{"first": "Lin", "uid": "ABC-123"}]})
    out = run(d, "add_contacts", {"contacts": [{"first": "Lin", "uid": "abc-123", "phones": [{"value": "0400 999 888"}]}], "on_duplicate": "merge"})
    assert out.result["merged"][0]["why"] == "same card" and by_name(d, "Lin")["phones"][0]["value"] == "0400 999 888"


def test_import_merge_links_relationships_both_ways():
    d = sample()
    alex = by_name(d, "Alex")
    run(
        d, "add_contacts",
        {"contacts": [{"first": "P", "emails": [{"value": "priya@example.com"}], "relationships": [{"type": "spouse", "contact_id": alex["id"]}]}], "on_duplicate": "merge"},
    )
    priya, alex = by_name(d, "Priya"), by_name(d, "Alex")
    assert any(r["contact_id"] == alex["id"] and r["type"] == "spouse" for r in priya["relationships"])
    assert any(r["contact_id"] == priya["id"] and r["type"] == "spouse" for r in alex["relationships"])


# ------------------------------------------------------ fix pass: merging


def test_merged_dates_and_relationships_get_unique_ids():
    d = sample()
    run(d, "add_contacts", {"contacts": [{"first": "Sammy", "emails": [{"value": "sam.rivera@atlassian.com"}]}]})
    sammy = by_name(d, "Sammy")
    run(d, "add_important_date", {"contact_id": "c-sam-q-rivera-jr", "kind": "anniversary", "date": "2015-06-01", "label": "Wedding"})
    run(d, "add_important_date", {"contact_id": sammy["id"], "kind": "other", "date": "2019-02-01", "label": "Moved to Sydney"})
    run(d, "add_relationship", {"contact_id": "c-sam-q-rivera-jr", "type": "child", "name": "Mia"})
    run(d, "add_relationship", {"contact_id": sammy["id"], "type": "child", "name": "Leo"})
    run(d, "merge_contacts", {"keep_id": "c-sam-q-rivera-jr", "merge_ids": [sammy["id"]]})
    sam = by_name(d, "Sam")
    assert len(sam["dates"]) == 2 and len({x["id"] for x in sam["dates"]}) == 2
    assert len(sam["relationships"]) == 2 and len({x["id"] for x in sam["relationships"]}) == 2


def test_old_files_with_repeated_ids_inside_a_contact_are_renumbered():
    d = SPEC.validate(
        {
            "contacts": [
                {
                    "id": "a",
                    "dates": [{"id": "d1", "date": "--01-02"}, {"id": "d1", "date": "--03-04"}],
                    "relationships": [{"id": "r1", "name": "Mia"}, {"id": "r1", "name": "Leo"}],
                }
            ]
        }
    )
    c = d["contacts"][0]
    assert [x["id"] for x in c["dates"]] == ["d1", "d2"] and [x["id"] for x in c["relationships"]] == ["r1", "r2"]


def test_strong_duplicate_groups_leave_out_name_only_sets():
    d = sample()
    run(d, "add_contacts", {"contacts": [{"first": "Alex", "last": "Chen"}, {"first": "P", "emails": [{"value": "priya@example.com"}]}]})
    all_groups = run(d, "find_duplicates").result["groups"]
    strong = run(d, "find_duplicates", {"strong_only": True}).result["groups"]
    assert len(all_groups) == 2 and len(strong) == 1 and strong[0]["reasons"] == ["same email"] and strong[0]["strong"]
    assert next(g for g in all_groups if g["reasons"] == ["same name"])["strong"] is False


# ------------------------------------------------------- fix pass: photos

_TINY = "data:image/jpeg;base64," + "A" * 400


def test_photo_validation():
    ok = SPEC.validate({"contacts": [{"id": "a", "photo": _TINY}]})
    assert ok["contacts"][0]["photo"] == _TINY
    assert SPEC.validate({"contacts": [{"id": "a", "photo": ""}]})["contacts"][0]["photo"] is None
    for bad in (
        "data:image/jpeg;base64," + "A" * 90_000,  # too big
        "https://example.com/me.jpg",  # not a data URL
        "data:image/svg+xml;base64,PHN2Zz4=",  # SVG can carry script
        "data:image/png;base64,not base64!",
    ):
        with pytest.raises(ValidationError):
            SPEC.validate({"contacts": [{"id": "a", "photo": bad}]})
    # All photos together are capped too.
    big = "data:image/jpeg;base64," + "A" * 80_000
    with pytest.raises(ValidationError, match="photos take too much room"):
        SPEC.validate({"contacts": [{"id": f"c{i}", "photo": big} for i in range(60)]})


def test_photos_through_add_contacts():
    d = blank()
    run(d, "add_contacts", {"contacts": [{"first": "Ann", "photo": _TINY}]})
    assert d["contacts"][0]["photo"] == _TINY
    with pytest.raises(ActionError, match="JPEG, PNG or WebP"):
        run(d, "add_contacts", {"contacts": [{"first": "Bo", "photo": "javascript:alert(1)"}]})
    out = run(d, "add_contacts", {"contacts": [{"first": "Bo", "photo": "javascript:alert(1)"}, {"first": "Cy", "photo": _TINY}], "batch": True})
    assert len(out.result["added"]) == 2 and by_name(d, "Bo")["photo"] is None and by_name(d, "Cy")["photo"] == _TINY
    # A merge fills a missing photo but doesn't replace one.
    run(d, "add_contacts", {"contacts": [{"first": "Dee", "emails": [{"value": "dee@x.com"}]}]})
    run(d, "add_contacts", {"contacts": [{"first": "Dee", "emails": [{"value": "dee@x.com"}], "photo": _TINY}], "on_duplicate": "merge"})
    assert by_name(d, "Dee")["photo"] == _TINY
    assert "base64" not in SPEC.to_text(d)


def test_an_import_leaves_out_photos_once_the_file_is_full():
    d = blank()
    big = "data:image/jpeg;base64," + "A" * 80_000
    out = run(d, "add_contacts", {"contacts": [{"first": f"P{i}", "photo": big} for i in range(60)], "batch": True})
    assert len(out.result["added"]) == 60 and out.result["photos_left_out"] > 0
    assert sum(1 for c in d["contacts"] if c["photo"]) == 60 - out.result["photos_left_out"]
    assert "left out" in out.summary


# ----------------------------------------------------- fix pass: websites


def test_websites_are_safe_links():
    d = SPEC.validate(
        {
            "contacts": [
                {
                    "id": "a",
                    "websites": [
                        {"label": "", "value": "javascript:alert(1)"},
                        {"label": "Instagram", "value": "@sam.climbs"},
                        {"label": "", "value": "example.com/sam"},
                        {"label": "Skype", "value": "skype:sam.r"},
                        {"label": "LinkedIn", "value": "https://linkedin.com/in/sam"},
                    ],
                }
            ]
        }
    )
    assert [w["value"] for w in d["contacts"][0]["websites"]] == [
        "https://instagram.com/sam.climbs", "https://example.com/sam", "https://linkedin.com/in/sam",
    ]


def test_to_text_uses_the_owners_today():
    from app.items.spec import _TEXT_NOW

    d = sample()  # Sam's birthday is 3 Nov
    token = _TEXT_NOW.set(datetime(2026, 11, 1, 9, 0, tzinfo=TZ))
    try:
        assert "2026-11-03 Sam Q. Rivera Jr. birthday (turns 34)" in SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(token)
    token = _TEXT_NOW.set(datetime(2027, 6, 1, 9, 0, tzinfo=TZ))
    try:
        assert "Sam Q. Rivera Jr. birthday" not in SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(token)


# ------------------------------------------------------------------- API


@pytest.fixture
async def client(db):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


async def test_api_flow(client, user, db):
    from sqlalchemy import select

    from app.items.models import ItemReminder

    h = _auth(user)
    assert (await client.post("/api/items/store/contacts", headers=h)).status_code == 200
    r = await client.post("/api/items", headers=h, json={"kind": "contacts", "title": "People"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "People.contacts" and item["data"]["contacts"] == []
    soon = (date.today() + timedelta(days=3)).strftime("--%m-%d")
    r = await client.post(
        f"/api/items/{fid}/actions/add_contacts",
        headers=h,
        json={"args": {"contacts": [{"full_name": "Sam Rivera", "birthday": soon, "emails": [{"value": "sam@x.com"}]}]}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["summary"] == "Added Sam Rivera" and r.json()["revision"] == 2
    data = r.json()["data"]
    cid = data["contacts"][0]["id"]
    r = await client.post(f"/api/items/{fid}/actions/log_interaction", headers=h, json={"args": {"contact_ids": [cid], "type": "call"}})
    assert r.status_code == 200 and r.json()["revision"] == 3
    r = await client.post(f"/api/items/{fid}/actions/contact_brief", headers=h, json={"args": {"contact_id": cid}})
    assert r.status_code == 200 and r.json()["result"]["interactions_total"] == 1 and r.json()["revision"] == 3
    r = await client.post(f"/api/items/{fid}/actions/log_interaction", headers=h, json={"args": {"contact_ids": ["nobody"]}})
    assert r.status_code == 400 and "No contact" in r.json()["detail"]
    # A direct save from the UI.
    data = (await client.get(f"/api/items/{fid}", headers=h)).json()
    body = data["data"]
    body["contacts"][0]["favorite"] = True
    body["contacts"][0]["nickname"] = "Sammy"
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": body, "base_revision": data["revision"]})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["contacts"][0]["nickname"] == "Sammy"
    bad = copy.deepcopy(body)
    bad["contacts"][0]["birthday"] = "31/02"
    r = await client.put(f"/api/items/{fid}", headers=h, json={"data": bad, "base_revision": r.json()["revision"]})
    assert r.status_code == 400
    # The birthday reminder is scheduled.
    import uuid

    rows = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert any(row.key.startswith("bday:") and "Sam Rivera" in row.title for row in rows)


async def test_an_ai_turn_adds_from_pasted_text_and_logs(client, user, db, monkeypatch):
    import uuid

    from app.items import ai
    from app.models_config import provider as prov
    from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

    class Fake:
        def __init__(self, hops):
            self.hops, self.calls = list(hops), []

        async def stream_chat_events(self, **kw):
            self.calls.append(kw)
            hop = self.hops.pop(0) if self.hops else {"text": "done"}
            if hop.get("text"):
                yield TextDelta(text=hop["text"])
            for i, (name, args) in enumerate(hop.get("tools", [])):
                yield ToolCallDelta(index=i, id=f"c{i}{len(self.calls)}", name=name, arguments=json.dumps(args))
            yield FinishEvent(reason="tool_calls" if hop.get("tools") else "stop")

    h = _auth(user)
    await client.post("/api/items/store/contacts", headers=h)
    fid = (await client.post("/api/items", headers=h, json={"kind": "contacts", "title": "People"})).json()["file_id"]
    fake = Fake(
        [
            {"tools": [("add_contacts", {"contacts": [{"full_name": "Sam Rivera", "company": "Atlassian", "met_where": "DevCon"}]})]},
            {"tools": [("log_interaction", {"contact_ids": ["Sam Rivera"], "type": "meeting", "notes": "Talked at DevCon"}), ("log_interaction", {"contact_ids": ["Sam"], "date": "2999-01-01"})]},
            {"text": "Added Sam and logged the chat."},
        ]
    )
    monkeypatch.setattr(prov, "model_router", fake)
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "met Sam Rivera at DevCon, works at Atlassian", object(), "m", can_edit=True)]
    acts = [e for e in events if e["type"] == "action"]
    assert [a["ok"] for a in acts] == [True, True, False]  # the future one was refused
    done = events[-1]
    assert done["changed"] and done["data"]["contacts"][0]["interactions"][0]["notes"] == "Talked at DevCon"
    system = fake.calls[0]["system"]
    assert "Dunbar" in system and "never say or imply you sent" in system.lower()
