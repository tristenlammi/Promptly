"""Trip Planner item (kind ``trip``): model, time zones (cross-zone flights,
DST), money (conversion, splits, settle-up), every action, conflicts,
reminders, text, tools, and the API flow."""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from app.items.kinds.trip import SPEC, template
from app.items.kinds.trip import logic
from app.items.kinds.trip import trips as trips_mod
from app.items.kinds.trip.reminders import trip_reminders
from app.items.kinds.trip.timeutil import (
    duration,
    fmt_duration,
    in_gap,
    instant,
    to_home,
    to_minor,
)
from app.items.spec import ActionError, ItemContext

SYD = ZoneInfo("Australia/Sydney")
NOW = datetime(2027, 3, 1, 9, 0, tzinfo=SYD)
TESS = uuid.UUID("00000000-0000-0000-0000-00000000aaaa")  # the file's creator
SAM_USER = uuid.UUID("00000000-0000-0000-0000-00000000bbbb")  # a companion it's shared with
KAI_USER = uuid.UUID("00000000-0000-0000-0000-00000000cccc")


def _ctx(now: datetime = NOW, tz: ZoneInfo = SYD, user_id: uuid.UUID = TESS) -> ItemContext:
    user = SimpleNamespace(settings={"currency": "AUD"}, username="Tess", id=user_id)
    return ItemContext(db=None, user=user, file_id=None, now=now.astimezone(tz), tz=tz)  # type: ignore[arg-type]


def _new() -> dict:
    return SPEC.validate(template(_ctx()))


def T(d: dict, ref: str | None = None) -> dict:
    """A trip of the file: the first, or the one with id ``ref``."""
    return d["trips"][0] if ref is None else next(t for t in d["trips"] if t["id"] == ref)


def V(d: dict, ref: str | None = None) -> dict:
    """A trip's view (the trip plus the settings the trip logic reads)."""
    return trips_mod.view(d, T(d, ref))


async def act(data: dict, name: str, args: dict | None = None, now: datetime = NOW, user: uuid.UUID = TESS):
    from app.items.service import run_action

    out = await run_action(_ctx(now, user_id=user), SPEC, data, name, args or {})
    clean = SPEC.validate(data)
    data.clear()
    data.update(clean)
    return out


async def _trip() -> dict:
    """Japan 2027: two travellers, 10 days, a JPY rate."""
    d = _new()
    await act(d, "create_trip", {
        "title": "Japan 2027", "start": "2027-04-01", "end": "2027-04-10", "emoji": "🗾",
        "destinations": [
            {"name": "Tokyo", "country": "Japan", "tz": "Asia/Tokyo", "start": "2027-04-01", "end": "2027-04-05"},
            {"name": "Kyoto", "country": "Japan", "tz": "Asia/Tokyo", "start": "2027-04-05", "end": "2027-04-10"},
        ],
        "travellers": [{"name": "Sam"}],
    })
    await act(d, "set_exchange_rates", {"rates": [{"code": "JPY", "per_home": 100}]})
    return d


# ------------------------------------------------------------ model + template


def test_template_is_valid_and_personal():
    d = _new()
    assert d == {"trips": [], "settings": {"home_currency": "AUD", "passport_months": 6, "onboarded": False, "clock": "auto",
                                           "distance": "km"}}
    assert SPEC.validate({}) == SPEC.validate(SPEC.validate({}))  # every field has a default


async def test_create_trip_adds_me():
    d = await _trip()
    assert T(d)["id"] == "trip-japan-2027" and T(d)["title"] == "Japan 2027"
    assert T(d)["travellers"][0] == {"id": "t-tess", "name": "Tess", "is_me": True, "user_id": str(TESS), "age_group": "adult",
                                     "passport_country": "", "contact_id": ""}
    assert [t["name"] for t in T(d)["travellers"]] == ["Tess", "Sam"]
    assert T(d)["me_by_user"] == {str(TESS): "t-tess"}
    assert T(d)["home_currency"] == "AUD" and T(d)["status"] == "planning" and d["settings"]["onboarded"]
    assert "settings" not in T(d)  # the view's settings never land in the file


async def test_new_trip_reuses_my_passport_from_my_last_trip():
    d = await _trip()
    await act(d, "add_documents", {"trip": "trip-japan-2027", "documents": [
        {"type": "passport", "traveller": "Tess", "country": "Australia", "reference": "…123", "expires": "2030-01-01", "status": "done"},
        {"type": "passport", "traveller": "Sam", "country": "New Zealand", "expires": "2029-01-01"},
    ]})
    await act(d, "create_trip", {"title": "Bali", "start": "2027-08-01", "end": "2027-08-08"})
    bali = next(t for t in d["trips"] if t["title"] == "Bali")
    me = bali["travellers"][0]
    assert me["user_id"] == str(TESS) and me["passport_country"] == "Australia" and me["contact_id"] == ""
    docs = bali["documents"]
    assert len(docs) == 1 and docs[0]["traveller_id"] == me["id"] and docs[0]["expires"] == "2030-01-01"
    assert docs[0]["reference"] == "…123" and docs[0]["status"] == "done" and docs[0]["remind_on"] is None
    # Someone else creating a trip in the file doesn't get Tess's passport.
    await act(d, "create_trip", {"title": "Fiji"}, user=KAI_USER)
    fiji = next(t for t in d["trips"] if t["title"] == "Fiji")
    assert fiji["documents"] == [] and fiji["travellers"][0]["passport_country"] == ""
    # Older files (travellers without contact_id) still validate, and a picked contact sticks.
    raw = copy.deepcopy(d)
    for t in raw["trips"]:
        for tr in t["travellers"]:
            tr.pop("contact_id", None)
    SPEC.validate(raw)
    raw["trips"][0]["travellers"][1]["contact_id"] = "c-sam"
    assert SPEC.validate(raw)["trips"][0]["travellers"][1]["contact_id"] == "c-sam"


def test_model_refuses_bad_zones_dates_and_currencies():
    with pytest.raises(ValidationError):
        SPEC.validate({"destinations": [{"id": "d", "name": "X", "tz": "Mars/Olympus"}]})
    with pytest.raises(ValidationError):
        SPEC.validate({"start": "2027-02-30"})
    with pytest.raises(ValidationError):
        SPEC.validate({"expenses": [{"id": "x", "date": "2027-01-01", "title": "a", "currency": "dollars"}]})


def test_model_normalises():
    d = SPEC.validate({
        "start": "2027-04-10", "end": "2027-04-01",
        "bookings": [{"id": "b", "type": "flight", "start": "2027-04-01 10:30:00+11:00", "from_code": "syd"}],
        "days": [{"date": "2027-04-02", "items": [{"id": "a", "title": "A"}]},
                 {"date": "2027-04-01", "items": [{"id": "b", "title": "B"}]},
                 {"date": "2027-04-02", "items": [{"id": "c", "title": "C"}]}],
        "settings": {"home_currency": "AUD"},
        "currencies": [{"code": "AUD", "per_home": 1}, {"code": "JPY", "per_home": 100}, {"code": "JPY", "per_home": 90}],
    })
    assert (T(d)["start"], T(d)["end"]) == ("2027-04-01", "2027-04-10")
    assert T(d)["bookings"][0]["start"] == "2027-04-01T10:30" and T(d)["bookings"][0]["from_code"] == "SYD"
    assert [x["date"] for x in T(d)["days"]] == ["2027-04-01", "2027-04-02"]
    assert [i["id"] for i in T(d)["days"][1]["items"]] == ["a", "c"]
    assert T(d)["currencies"] == [{"code": "JPY", "per_home": 100.0, "updated": None}]


# --------------------------------------------------------------- time zones


def test_cross_dateline_flight_duration():
    # QF11 Sydney → Los Angeles: leaves 11:40 AEDT, lands 06:35 PST the same date.
    d = duration("2027-01-10T11:40", "Australia/Sydney", "2027-01-10T06:35", "America/Los_Angeles")
    assert d == timedelta(hours=13, minutes=55) and fmt_duration(d) == "13h 55m"
    # And back: LAX 22:30 → SYD 07:05 two days later.
    back = duration("2027-01-20T22:30", "America/Los_Angeles", "2027-01-22T07:05", "Australia/Sydney")
    assert back == timedelta(hours=13, minutes=35)  # 06:30Z → 20:05Z


def test_flight_across_a_dst_change():
    # The US is on daylight time from 14 Mar 2027, the UK only from 28 Mar:
    # JFK 19:00 EDT (23:00Z) → LHR 07:00 GMT (07:00Z) is 8h, not 7h.
    assert duration("2027-03-20T19:00", "America/New_York", "2027-03-21T07:00", "Europe/London") == timedelta(hours=8)
    # Same flight a week later, both on summer time: 7h.
    assert duration("2027-03-29T19:00", "America/New_York", "2027-03-30T08:00", "Europe/London") == timedelta(hours=8)
    assert duration("2027-03-29T19:00", "America/New_York", "2027-03-30T07:00", "Europe/London") == timedelta(hours=7)
    # A Sydney overnight across the April DST end (clocks back 03:00 → 02:00).
    assert duration("2027-04-03T23:00", "Australia/Sydney", "2027-04-04T06:00", "Australia/Sydney") == timedelta(hours=8)


def test_gap_and_ambiguous_wall_times():
    # 02:30 on the US spring-forward night doesn't exist: read as 03:30 EDT.
    assert in_gap("2027-03-14T02:30", "America/New_York")
    assert instant("2027-03-14T02:30", "America/New_York").astimezone(timezone.utc) == datetime(2027, 3, 14, 7, 30, tzinfo=timezone.utc)
    assert not in_gap("2027-03-14T03:30", "America/New_York")
    # 01:30 on the fall-back night happens twice: the first (EDT) is used.
    assert instant("2027-11-07T01:30", "America/New_York").astimezone(timezone.utc) == datetime(2027, 11, 7, 5, 30, tzinfo=timezone.utc)


def test_money_minor_units_and_conversion():
    assert to_minor(3200, "JPY") == 3200 and to_minor(45.5, "AUD") == 4550 and to_minor(1.234, "KWD") == 1234
    d = {"settings": {"home_currency": "AUD"}, "currencies": [{"code": "JPY", "per_home": 97.5}]}
    assert to_home(d, 9750, "JPY") == 10000  # ¥9,750 = A$100.00
    assert to_home(d, 500, "AUD") == 500
    assert to_home(d, 100, "EUR") is None


# ----------------------------------------------------------------- trip details


async def test_set_trip_details_and_rebase_home_currency():
    d = await _trip()
    assert [x["name"] for x in T(d)["travellers"]] == ["Tess", "Sam"] and T(d)["destinations"][1]["tz"] == "Asia/Tokyo"
    ids = [x["id"] for x in T(d)["destinations"]]
    await act(d, "set_trip_details", {"destinations": [{"name": "Tokyo", "country": "Japan", "start": "2027-04-01"}, {"name": "Osaka"}]})
    assert T(d)["destinations"][0]["id"] == ids[0] and T(d)["destinations"][0]["tz"] == "Asia/Tokyo"  # kept
    await act(d, "set_exchange_rates", {"rates": [{"code": "USD", "home_per_unit": 1.5}]})
    await act(d, "set_trip_details", {"home_currency": "JPY"})
    rates = {r["code"]: r["per_home"] for r in T(d)["currencies"]}
    assert T(d)["home_currency"] == "JPY" and rates["AUD"] == pytest.approx(0.01)
    assert rates["USD"] == pytest.approx((1 / 1.5) / 100)
    with pytest.raises(ActionError):
        await act(d, "set_trip_details", {"start": "2027-05-01", "end": "2027-04-01"})
    with pytest.raises(ActionError):
        await act(d, "set_trip_details", {})
    with pytest.raises(ActionError):
        await act(d, "set_trip_details", {"add_destinations": [{"name": "X", "tz": "Nowhere/Land"}]})


# -------------------------------------------------------------------- bookings


async def test_add_flights_fills_zones_and_dedupes():
    d = await _trip()
    out = await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "provider": "Qantas", "number": "QF25", "from_code": "SYD", "to_code": "HND",
         "start": "2027-04-01T10:30", "end": "2027-04-01T18:45", "confirmation": "ABC123", "seat": "34A",
         "cost": 1450, "travellers": ["Tess", "sam"]},
        {"type": "flight", "number": "NH123", "from_code": "HND", "to_code": "ITM",
         # given as an aware UTC time: converted into Tokyo wall time
         "start": "2027-04-05T00:00:00Z", "end": "2027-04-05T10:10"},
        {"type": "flight", "number": "XX1", "from_code": "ZZZ", "to_code": "YYY", "start": "2027-04-09T10:00", "end": "2027-04-09T12:00"},
    ]})
    qf = T(d)["bookings"][0]
    assert qf["start_tz"] == "Australia/Sydney" and qf["end_tz"] == "Asia/Tokyo" and qf["from_place"] == "Sydney"
    assert qf["cost_minor"] == 145000 and qf["currency"] == "AUD" and qf["traveller_ids"] == ["t-tess", "t-sam"]
    assert out.result["added"][0]["duration"] == "10h 15m"  # 10:30 AEDT (23:30Z) → 18:45 JST (09:45Z)
    nh = next(b for b in T(d)["bookings"] if b["number"] == "NH123")
    assert nh["start"] == "2027-04-05T09:00"
    assert any("XX1" in w and "time zone" in w for w in out.result["warnings"])
    # The same booking again updates it.
    again = await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "start": "2027-04-01T10:30", "seat": "34B"}]})
    assert again.result["updated"] and len(T(d)["bookings"]) == 3 and T(d)["bookings"][0]["seat"] == "34B"


async def test_update_and_delete_booking():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [{"type": "stay", "title": "Hotel Gracery", "start": "2027-04-01T15:00",
                                                "end": "2027-04-05T11:00", "cost": 80000, "currency": "JPY"}]})
    b = T(d)["bookings"][0]
    assert b["start_tz"] == "Asia/Tokyo" and b["end_tz"] == "Asia/Tokyo"  # guessed from the destination
    await act(d, "update_booking", {"id": b["id"], "confirmation": "9981", "status": "pending"})
    assert T(d)["bookings"][0]["confirmation"] == "9981" and T(d)["bookings"][0]["status"] == "pending"
    with pytest.raises(ActionError):
        await act(d, "update_booking", {"id": "nope", "title": "x"})
    with pytest.raises(ActionError):
        await act(d, "update_booking", {"id": b["id"], "start_tz": "Bad/Zone"})
    await act(d, "plan_days", {"days": [{"date": "2027-04-01", "items": [{"title": "Check in", "type": "stay", "booking_id": b["id"]}]}]})
    await act(d, "add_expenses", {"expenses": [{"title": "Hotel", "amount": 80000, "currency": "JPY", "paid_by": "Tess", "booking_id": b["id"]}]})
    await act(d, "delete_bookings", {"ids": [b["id"]]})
    assert T(d)["bookings"] == [] and T(d)["days"][0]["items"][0]["booking_id"] is None and T(d)["expenses"][0]["booking_id"] is None
    with pytest.raises(ActionError):
        await act(d, "delete_bookings", {"ids": [b["id"]]})


# ------------------------------------------------------------------- itinerary


async def test_plan_move_reorder_remove():
    d = await _trip()
    out = await act(d, "plan_days", {"days": [
        {"date": "2027-04-02", "title": "Asakusa & Ueno", "items": [
            {"title": "Senso-ji", "time": "08:00", "duration_min": 90, "area": "Asakusa", "travel_after": "20 min subway"},
            {"title": "Lunch", "type": "food", "time": "12:30"},
            {"title": "Ueno Park", "time": "10:00"},
            {"title": "Souvenirs"},
        ]},
        {"date": "day 3", "items": [{"title": "teamLab", "time": "7pm", "cost": 3800, "currency": "JPY", "status": "booked"}]},
        {"date": "2027-05-01", "items": [{"title": "Too late"}]},
    ]})
    day2 = T(d)["days"][0]
    assert day2["title"] == "Asakusa & Ueno" and [i["title"] for i in day2["items"]] == ["Senso-ji", "Ueno Park", "Lunch", "Souvenirs"]
    assert T(d)["days"][1]["date"] == "2027-04-03" and T(d)["days"][1]["items"][0]["time"] == "19:00"
    assert T(d)["days"][1]["items"][0]["cost_minor"] == 3800 and T(d)["days"][1]["items"][0]["currency"] == "JPY"
    assert any("outside" in w for w in out.result["warnings"])
    lunch = day2["items"][2]["id"]
    await act(d, "move_items", {"moves": [{"item_id": lunch, "to_date": "2027-04-03", "time": "anytime"}]})
    assert T(d)["days"][1]["items"][-1]["title"] == "Lunch" and T(d)["days"][1]["items"][-1]["time"] is None
    ids = [i["id"] for i in T(d)["days"][0]["items"]]
    await act(d, "reorder_day", {"date": "2027-04-02", "item_ids": [ids[2], ids[0]]})
    assert [i["title"] for i in T(d)["days"][0]["items"]] == ["Souvenirs", "Senso-ji", "Ueno Park"]
    await act(d, "reorder_day", {"date": "2027-04-02", "item_ids": [ids[0]], "sort_by_time": True})
    assert [i["title"] for i in T(d)["days"][0]["items"]] == ["Senso-ji", "Ueno Park", "Souvenirs"]
    # replace keeps booked items
    await act(d, "plan_days", {"days": [{"date": "2027-04-03", "replace": True, "items": [{"title": "Shibuya Sky", "time": "17:00"}]}]})
    assert [i["title"] for i in T(d)["days"][1]["items"]] == ["Shibuya Sky", "teamLab"]
    await act(d, "update_plan_items", {"items": [{"id": T(d)["days"][1]["items"][0]["id"], "status": "done", "time": "16:30", "cost": 2200}]})
    assert T(d)["days"][1]["items"][0]["status"] == "done" and T(d)["days"][1]["items"][0]["time"] == "16:30"
    await act(d, "remove_plan_items", {"ids": [ids[2]], "to_ideas": True})
    assert T(d)["ideas"][-1]["title"] == "Souvenirs"
    with pytest.raises(ActionError):
        await act(d, "move_items", {"moves": [{"item_id": "ghost", "to_date": "2027-04-02"}]})
    with pytest.raises(ActionError):
        await act(d, "plan_days", {"days": [{"date": "not a date", "items": []}]})
    with pytest.raises(ActionError):
        await act(d, "reorder_day", {"date": "2027-04-09", "item_ids": ["x"]})


async def test_ideas_add_dedupe_schedule_delete():
    d = await _trip()
    await act(d, "add_ideas", {"ideas": [
        {"title": "Fushimi Inari", "area": "Fushimi", "tags": ["shrine", "early"], "priority": "must", "hours": "24h", "duration_min": 150},
        {"title": "Nishiki Market", "area": "Downtown", "type": "food"},
    ]})
    await act(d, "add_ideas", {"ideas": [{"title": "fushimi inari", "book_ahead": True}]})
    assert len(T(d)["ideas"]) == 2 and T(d)["ideas"][0]["book_ahead"] and T(d)["ideas"][0]["priority"] == "must"
    iid = T(d)["ideas"][0]["id"]
    out = await act(d, "schedule_ideas", {"ideas": [{"idea_id": iid, "date": "2027-04-06", "time": "07:00"}]})
    it = T(d)["days"][0]["items"][0]
    assert it["title"] == "Fushimi Inari" and it["time"] == "07:00" and it["duration_min"] == 150 and "Hours: 24h" in it["notes"]
    assert len(T(d)["ideas"]) == 1 and out.summary.startswith("Scheduled Fushimi Inari")
    with pytest.raises(ActionError):
        await act(d, "schedule_ideas", {"ideas": [{"idea_id": iid, "date": "2027-04-06"}]})
    await act(d, "delete_ideas", {"ids": [T(d)["ideas"][0]["id"]]})
    assert T(d)["ideas"] == []


async def test_itinerary_for_merges_bookings_in_local_time():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-04-01T10:30", "end": "2027-04-01T18:45"},
        {"type": "stay", "title": "Gracery", "start": "2027-04-01T15:00", "end": "2027-04-05T11:00"},
    ]})
    await act(d, "plan_days", {"days": [{"date": "2027-04-01", "items": [
        {"title": "Ramen in Shinjuku", "time": "20:30", "type": "food"}, {"title": "Get a Suica card"}]}]})
    out = await act(d, "itinerary_for", {"date": "2027-04-01"})
    entries = out.result["entries"]
    titles = [e["title"] for e in entries]
    assert titles[0].startswith("Depart: QF25") and entries[0]["time"] == "10:30" and entries[0]["until"] == "18:45"
    assert titles[1:] == ["Check in: Gracery", "Ramen in Shinjuku", "Get a Suica card"]
    assert out.result["time_zone"] == "Asia/Tokyo"
    out = await act(d, "itinerary_for", {"date": "2027-04-05"})
    assert [e["title"] for e in out.result["entries"]] == ["Check out: Gracery"]
    assert logic.day_zone(V(d), "2027-04-06") == "Asia/Tokyo"


# --------------------------------------------------------------------- packing


async def test_packing_templates_items_check_progress():
    d = await _trip()
    out = await act(d, "add_packing_items", {"template": "beach"})
    swim = [i for i in T(d)["packing"] if i["name"] == "Swimsuit"]
    assert {i["traveller_id"] for i in swim} == {"t-tess", "t-sam"} and swim[0]["qty"] == 2
    assert len([i for i in T(d)["packing"] if i["name"].startswith("Reef-safe")]) == 1  # shared
    again = await act(d, "add_packing_items", {"template": "beach", "items": [{"name": "Kindle", "traveller": "Sam", "category": "Tech"}]})
    assert again.result["added"] == 1 and out.result["added"] > 10
    await act(d, "check_packing", {"names": ["swimsuit"]})
    prog = (await act(d, "packing_progress")).result
    assert prog["packed"] == 2 and prog["total"] == len(T(d)["packing"]) and "Sunglasses" in prog["essentials_left"]
    await act(d, "check_packing", {"all": True, "checked": False})
    assert not any(i["checked"] for i in T(d)["packing"])
    await act(d, "remove_packing_items", {"ids": [swim[0]["id"]]})
    with pytest.raises(ActionError):
        await act(d, "add_packing_items", {})
    with pytest.raises(ActionError):
        await act(d, "check_packing", {"names": ["unicorn"]})
    with pytest.raises(ActionError):
        await act(d, "add_packing_items", {"items": [{"name": "x", "traveller": "Nobody"}]})


# ---------------------------------------------------------------------- money


async def test_expenses_splits_settle_up_and_settlements():
    d = await _trip()
    await act(d, "set_trip_details", {"add_travellers": [{"name": "Kai"}]})
    await act(d, "add_expenses", {"expenses": [
        {"title": "Dinner", "amount": 10000, "currency": "JPY", "paid_by": "Tess", "category": "food", "date": "2027-04-02"},  # A$100 / 3
        {"title": "Taxi", "amount": 30, "paid_by": "Sam", "split_between": ["Sam", "Kai"], "category": "transport"},
        {"title": "Tickets", "amount": 60, "paid_by": "Kai", "split": "exact",
         "shares": [{"traveller": "Tess", "amount": 20}, {"traveller": "Sam", "amount": 40}]},
        {"title": "Villa", "amount": 300, "paid_by": "Tess", "split": "shares",
         "shares": [{"traveller": "Tess", "weight": 2}, {"traveller": "Sam", "weight": 1}]},
    ]})
    e = T(d)["expenses"]
    dinner = next(x for x in e if x["title"] == "Dinner")
    assert logic.expense_split(V(d), dinner) == {"t-tess": 3334, "t-sam": 3333, "t-kai": 3333}
    s = (await act(d, "settle_up")).result
    bal = {b["name"]: b["balance_minor"] for b in s["balances"]}
    # Tess paid 100 + 300, owes 33.34 + 20 + 200; Sam paid 30, owes 33.33 + 15 + 40 + 100; Kai paid 60, owes 33.33 + 15
    assert bal == {"Tess": 14666, "Sam": -15833, "Kai": 1167}
    assert sum(bal.values()) == 0
    assert len(s["transfers"]) == 2 and all(t["from"] == "Sam" for t in s["transfers"])
    assert {t["to"]: t["amount_minor"] for t in s["transfers"]} == {"Tess": 14666, "Kai": 1167}
    await act(d, "record_settlement", {"from_traveller": "Sam", "to_traveller": "Tess", "amount": 146.66})
    await act(d, "record_settlement", {"from_traveller": "Sam", "to_traveller": "Kai", "amount": 11.67})
    assert (await act(d, "settle_up")).result["settled"]
    with pytest.raises(ActionError):
        await act(d, "add_expenses", {"expenses": [{"title": "Bad", "amount": 50, "paid_by": "Tess", "split": "exact",
                                                     "shares": [{"traveller": "Sam", "amount": 10}]}]})
    with pytest.raises(ActionError):
        await act(d, "record_settlement", {"from_traveller": "Sam", "to_traveller": "Sam", "amount": 1})
    await act(d, "delete_expenses", {"ids": [dinner["id"]]})
    assert len(T(d)["expenses"]) == 3


async def test_budget_vs_actual_and_rates():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-04-01T10:30", "end": "2027-04-01T18:45", "cost": 2000},
        {"type": "stay", "title": "Ryokan", "start": "2027-04-05T15:00", "end": "2027-04-07T10:00", "cost": 100000, "currency": "JPY"},
    ]})
    ryokan = next(b for b in T(d)["bookings"] if b["type"] == "stay")
    await act(d, "set_budget", {"total": 6000, "categories": [{"category": "food", "amount": 800}, {"category": "stays", "amount": 1500}]})
    out = await act(d, "add_expenses", {"expenses": [
        {"title": "Sushi", "amount": 12000, "currency": "JPY", "category": "food", "paid_by": "Tess"},
        {"title": "Ryokan balance", "amount": 100000, "currency": "JPY", "category": "stays", "paid_by": "Tess", "booking_id": ryokan["id"]},
        {"title": "Gelato", "amount": 5, "currency": "EUR", "category": "food", "paid_by": "Sam"},
    ]})
    assert any("EUR" in w for w in out.result["warnings"])
    b = (await act(d, "budget_status", now=datetime(2027, 4, 3, 12, tzinfo=SYD))).result
    cats = {c["category"]: c for c in b["categories"]}
    assert b["budget_minor"] == 600000 and cats["flights"]["booked_minor"] == 200000
    assert cats["stays"]["booked_minor"] == 0 and cats["stays"]["spent_minor"] == 100000  # not counted twice
    assert cats["food"]["spent_minor"] == 12000 and cats["food"]["remaining_minor"] == 68000
    assert b["actual_minor"] == 312000 and b["remaining_minor"] == 288000 and b["missing_rates"] == ["EUR"]
    assert b["days"] == 10 and b["days_elapsed"] == 3 and b["left_per_day_minor"] == round(288000 / 7)
    await act(d, "set_exchange_rates", {"rates": [{"code": "EUR", "per_home": 0.6}], "remove": []})
    b2 = (await act(d, "budget_status")).result
    assert b2["missing_rates"] == [] and {c["category"]: c for c in b2["categories"]}["food"]["spent_minor"] == 12000 + 833
    with pytest.raises(ActionError):
        await act(d, "set_budget", {})
    with pytest.raises(ActionError):
        await act(d, "set_exchange_rates", {"rates": [{"code": "GBP"}]})


# ------------------------------------------------------------------ documents


async def test_documents_passport_validity_and_masking():
    d = await _trip()
    await act(d, "add_documents", {"documents": [
        {"type": "passport", "traveller": "Tess", "country": "Australia", "expires": "2027-08-01", "reference": "PA1234567", "status": "done"},
        {"type": "passport", "traveller": "Sam", "country": "Australia", "expires": "2031-01-01", "status": "done"},
        {"type": "visa", "traveller": "Sam", "country": "Japan", "title": "Japan eVisa", "status": "todo", "remind_on": "2027-03-05"},
    ]})
    tess = T(d)["documents"][0]
    assert tess["reference"] == "…4567"
    issues = logic.document_issues(V(d), NOW.date())
    kinds = [i["kind"] for i in issues]
    assert "passport_validity" in kinds and kinds.count("passport_validity") == 1
    assert "document_todo" in kinds  # 31 days to go
    await act(d, "update_document", {"id": tess["id"], "expires": "2035-01-01"})
    assert "passport_validity" not in [i["kind"] for i in logic.document_issues(V(d), NOW.date())]
    # Same passport again updates it.
    await act(d, "add_documents", {"documents": [{"type": "passport", "traveller": "Tess", "country": "Australia", "status": "done"}]})
    assert len(T(d)["documents"]) == 3
    await act(d, "remove_documents", {"ids": [tess["id"]]})
    with pytest.raises(ActionError):
        await act(d, "update_document", {"id": tess["id"], "status": "done"})


# ------------------------------------------------------------------ conflicts


async def test_conflicts_find_real_problems():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        # lands HND 18:45, next flight from NRT 1h later → airport change
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-04-01T10:30", "end": "2027-04-01T18:45"},
        {"type": "flight", "number": "JL1", "from_code": "NRT", "to_code": "KIX", "start": "2027-04-01T19:45", "end": "2027-04-01T21:00"},
        # zone slip: entered as if both ends were Tokyo time → "arrives before it departs"
        {"type": "flight", "number": "QF80", "from_code": "HND", "to_code": "SYD", "start": "2027-04-10T20:00", "end": "2027-04-10T07:30"},
        # overlap with a train the same afternoon
        {"type": "train", "title": "Shinkansen", "start": "2027-04-05T09:00", "end": "2027-04-05T11:15", "start_tz": "Asia/Tokyo"},
        {"type": "tour", "title": "Tea ceremony", "start": "2027-04-05T10:00", "end": "2027-04-05T11:00", "start_tz": "Asia/Tokyo"},
        {"type": "stay", "title": "Gracery", "start": "2027-04-01T15:00", "end": "2027-04-04T11:00"},
        {"type": "stay", "title": "Kyoto Inn", "start": "2027-04-05T15:00", "end": "2027-04-10T10:00"},
    ]})
    await act(d, "plan_days", {"days": [{"date": "2027-04-07", "items": [
        {"title": f"Temple {n}", "time": f"{8 + n:02d}:00"} for n in range(5)]}]})
    issues = (await act(d, "conflicts")).result["issues"]
    kinds = {i["kind"] for i in issues}
    assert {"airport_change", "arrives_before_departs", "overlap", "missing_stay", "busy_day"} <= kinds
    missing = next(i for i in issues if i["kind"] == "missing_stay")
    assert missing["dates"] == ["2027-04-04", "2027-04-04"]
    assert issues[0]["severity"] == "error"
    # A trip with every night covered and nothing else says so.
    clean = await _trip()
    await act(clean, "add_bookings", {"bookings": [{"type": "stay", "title": "Home base", "start": "2027-04-01T15:00", "end": "2027-04-10T10:00"}]})
    assert (await act(clean, "conflicts")).result == "No conflicts found."


async def test_tight_connection_same_airport():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "number": "SQ232", "from_code": "SYD", "to_code": "SIN", "start": "2027-04-01T09:00", "end": "2027-04-01T15:00"},
        {"type": "flight", "number": "SQ12", "from_code": "SIN", "to_code": "NRT", "start": "2027-04-01T15:35", "end": "2027-04-01T23:30"},
    ]})
    issues = logic.conflicts(V(d), SYD, NOW.date())
    tight = [i for i in issues if i["kind"] == "tight_connection"]
    assert tight and tight[0]["severity"] == "error" and "35m" in tight[0]["message"]


async def test_summary_phase_and_next_up():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-04-01T10:30", "end": "2027-04-01T18:45"}]})
    s = (await act(d, "trip_summary")).result
    assert s["phase"] == "before" and s["days_to_go"] == 31 and s["dates"]["nights"] == 9
    assert s["next_up"][0]["what"].startswith("Depart: QF25") and s["bookings"] == {"flight": 1}
    during = (await act(d, "trip_summary", now=datetime(2027, 4, 3, 9, tzinfo=ZoneInfo("Asia/Tokyo")))).result
    assert during["phase"] == "during" and during["day"] == 3 and during["of"] == 10


# ------------------------------------------------------------------ reminders


async def test_reminders_use_each_bookings_zone():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-04-01T10:30", "end": "2027-04-01T18:45",
         "confirmation": "ABC123", "terminal_from": "1"},
        {"type": "flight", "number": "NH21", "from_code": "HND", "to_code": "ITM", "start": "2027-04-05T07:00", "end": "2027-04-05T08:10"},
        {"type": "train", "title": "Shinkansen to Kyoto", "start": "2027-04-05T13:00", "end": "2027-04-05T15:15", "start_tz": "Asia/Tokyo"},
        {"type": "stay", "title": "Gracery", "start": "2027-04-01T15:00", "end": "2027-04-05T11:00"},
        {"type": "flight", "number": "OLD1", "from_code": "SYD", "to_code": "MEL", "start": "2027-02-01T10:00", "end": "2027-02-01T11:30"},
    ]})
    now = datetime(2027, 3, 30, 12, tzinfo=SYD)
    all_rems = trip_reminders(d, _ctx(now))
    assert all(r.key.startswith(f"{T(d)['id']}/") for r in all_rems)  # the trip id is in every key
    rems = {r.key.split("/", 1)[1].split(":")[0] + ":" + r.key.split("/", 1)[1].split(":")[1]: r for r in all_rems}
    qf = next(b for b in T(d)["bookings"] if b["number"] == "QF25")
    nh = next(b for b in T(d)["bookings"] if b["number"] == "NH21")
    train = next(b for b in T(d)["bookings"] if b["type"] == "train")
    stay = next(b for b in T(d)["bookings"] if b["type"] == "stay")
    # 10:30 AEDT on 1 Apr = 23:30Z on 31 Mar → check-in opens 23:30Z on 30 Mar.
    assert rems[f"checkin:{qf['id']}"].due_at.astimezone(timezone.utc) == datetime(2027, 3, 30, 23, 30, tzinfo=timezone.utc)
    assert rems[f"depart:{qf['id']}"].due_at.astimezone(timezone.utc) == datetime(2027, 3, 31, 20, 30, tzinfo=timezone.utc)
    assert "ABC123" in rems[f"checkin:{qf['id']}"].body and "T1" in rems[f"checkin:{qf['id']}"].body
    # 07:00 JST on 5 Apr = 22:00Z on 4 Apr; three hours before = 19:00Z.
    assert rems[f"depart:{nh['id']}"].due_at.astimezone(timezone.utc) == datetime(2027, 4, 4, 19, 0, tzinfo=timezone.utc)
    assert rems[f"soon:{train['id']}"].due_at.astimezone(timezone.utc) == datetime(2027, 4, 5, 3, 0, tzinfo=timezone.utc)
    # Check-out 11:00 JST → reminder 08:00 JST.
    assert rems[f"checkout:{stay['id']}"].due_at.astimezone(timezone.utc) == datetime(2027, 4, 4, 23, 0, tzinfo=timezone.utc)
    assert rems["tripstart:2027-04-01"].due_at == datetime(2027, 3, 31, 18, 0, tzinfo=SYD)
    assert not any("OLD1" in r.title for r in rems.values())
    # Within 24h of departure: the check-in reminder is due now.
    late = datetime(2027, 4, 1, 1, 0, tzinfo=SYD)
    ci = next(r for r in trip_reminders(d, _ctx(late)) if r.key.startswith(f"{T(d)['id']}/checkin:{qf['id']}"))
    assert ci.due_at == late
    T(d)["status"] = "done"
    assert trip_reminders(d, _ctx(now)) == []


async def test_document_reminders():
    d = await _trip()
    await act(d, "add_documents", {"documents": [
        {"type": "passport", "traveller": "Tess", "expires": "2027-06-01", "status": "done"},
        {"type": "eta", "traveller": "Sam", "title": "Visit Japan Web", "status": "todo", "remind_on": "2027-03-10"},
        {"type": "insurance", "title": "Cover-More", "status": "todo"},
    ]})
    rems = trip_reminders(d, _ctx())
    keys = [r.key for r in rems]
    assert any(k.split("/", 1)[1].startswith("doc:passport_validity") for k in keys)
    eta = next(r for r in rems if "Visit Japan Web" in r.title)
    assert eta.due_at == datetime(2027, 3, 10, 9, 0, tzinfo=SYD)
    ins = next(r for r in rems if "Cover-More" in r.title)
    assert ins.due_at == datetime(2027, 3, 11, 9, 0, tzinfo=SYD)  # 3 weeks before


# ---------------------------------------------------------------- text + tools


async def test_to_text_reads_well():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "flight", "provider": "Qantas", "number": "QF25", "from_code": "SYD", "to_code": "HND",
         "start": "2027-04-01T10:30", "end": "2027-04-01T18:45", "confirmation": "ABC123"}]})
    await act(d, "plan_days", {"days": [{"date": "2027-04-02", "title": "Asakusa", "items": [{"title": "Senso-ji", "time": "08:00", "travel_after": "10 min walk"}]}]})
    await act(d, "add_expenses", {"expenses": [{"title": "Ramen", "amount": 2400, "currency": "JPY", "paid_by": "Sam"}]})
    text = SPEC.to_text(d)
    assert "Japan 2027" in text and "Tokyo, Japan" in text and "Tess, Sam" in text
    assert "QF25" in text and "AEDT" in text and "JST" in text and "(10h 15m)" in text and "ref ABC123" in text
    assert "Senso-ji" in text and "10 min walk" in text and "Ramen" in text and "Settle up" in text
    assert len(text) <= 20_000


def test_tools_have_no_refs_and_cover_the_actions():
    from app.items.ai import tools_for

    tools = tools_for(SPEC, can_edit=True)
    names = {t["function"]["name"] for t in tools}
    for a in ("set_trip_details", "add_bookings", "update_booking", "delete_bookings", "plan_days", "move_items", "reorder_day",
              "add_ideas", "schedule_ideas", "add_packing_items", "check_packing", "add_expenses", "update_expense", "delete_expenses",
              "set_exchange_rates", "set_budget", "add_documents", "itinerary_for", "trip_summary", "budget_status",
              "settle_up", "packing_progress", "conflicts", "web_search", "find_my_files"):
        assert a in names, a
    assert "$ref" not in json.dumps(tools)
    readonly = {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
    assert "conflicts" in readonly and "add_bookings" not in readonly


async def test_actions_are_deterministic():
    a, b = await _trip(), await _trip()
    args = {"expenses": [{"title": "Lunch", "amount": 1500, "currency": "JPY", "paid_by": "Tess"},
                         {"title": "Lunch", "amount": 1500, "currency": "JPY", "paid_by": "Tess"}]}
    await act(a, "add_expenses", copy.deepcopy(args))
    await act(b, "add_expenses", copy.deepcopy(args))
    assert a == b and len({e["id"] for e in T(a)["expenses"]}) == 2


# --------------------------------------------------------------- fix pass


async def test_links_must_be_safe():
    d = await _trip()
    for bad in ("javascript:alert(1)", "data:text/html,<script>x</script>", "JaVaScRiPt:alert(1)", "vbscript:x"):
        with pytest.raises(ActionError):
            await act(d, "add_bookings", {"bookings": [{"type": "tour", "title": "X", "link": bad}]})
        with pytest.raises(ActionError):
            await act(d, "add_ideas", {"ideas": [{"title": "Y", "link": bad}]})
        with pytest.raises(ActionError):
            await act(d, "plan_days", {"days": [{"date": "2027-04-02", "items": [{"title": "Z", "link": bad}]}]})
        with pytest.raises(ActionError):
            await act(d, "add_documents", {"documents": [{"type": "visa", "link": bad}]})
        for section, row in (("bookings", {"id": "b", "type": "tour", "link": bad}),
                             ("ideas", {"id": "i", "title": "I", "link": bad}),
                             ("documents", {"id": "doc", "link": bad}),
                             ("days", {"date": "2027-04-02", "items": [{"id": "x", "title": "T", "link": bad}]})):
            with pytest.raises(ValidationError):
                SPEC.validate({**d, "trips": [{**T(d), section: [row]}]})
    await act(d, "add_bookings", {"bookings": [{"type": "tour", "title": "Tea", "link": "klook.com/booking/1"}]})
    assert T(d)["bookings"][0]["link"] == "https://klook.com/booking/1"
    await act(d, "update_booking", {"id": T(d)["bookings"][0]["id"], "link": "https://example.com/manage"})
    assert T(d)["bookings"][0]["link"] == "https://example.com/manage"


async def test_me_is_the_acting_user_not_the_owner():
    d = await _trip()  # created by Tess; Sam is a traveller
    # Sam's account opens the shared file: "me" isn't known for him yet.
    with pytest.raises(ActionError, match="which traveller you are"):
        await act(d, "add_expenses", {"expenses": [{"title": "Coffee", "amount": 5, "paid_by": "me"}]}, user=SAM_USER)
    # Without a payer and with no "me", nobody is assumed (it's left out of settle-up, with a warning).
    out = await act(d, "add_expenses", {"expenses": [{"title": "Snack", "amount": 4}]}, user=SAM_USER)
    assert T(d)["expenses"][-1]["paid_by"] is None and out.result["warnings"]
    await act(d, "set_trip_details", {"i_am": "Sam"}, user=SAM_USER)
    assert T(d)["me_by_user"] == {str(TESS): "t-tess", str(SAM_USER): "t-sam"}
    assert next(t for t in T(d)["travellers"] if t["id"] == "t-sam")["user_id"] == str(SAM_USER)
    await act(d, "add_expenses", {"expenses": [{"title": "Coffee", "amount": 5, "paid_by": "me"},
                                               {"title": "Lunch", "amount": 20}]}, user=SAM_USER)
    payers = {e["title"]: e["paid_by"] for e in T(d)["expenses"]}
    assert payers["Coffee"] == "t-sam" and payers["Lunch"] == "t-sam"  # default payer = the acting user's traveller
    await act(d, "add_expenses", {"expenses": [{"title": "Dinner", "amount": 30, "paid_by": "I"}]})  # Tess
    assert next(e for e in T(d)["expenses"] if e["title"] == "Dinner")["paid_by"] == "t-tess"
    # Kai's account claims a traveller added for him; claiming moves, one user per traveller.
    await act(d, "set_trip_details", {"add_travellers": [{"name": "Kai", "is_me": True}]}, user=KAI_USER)
    assert T(d)["me_by_user"][str(KAI_USER)] == "t-kai"
    await act(d, "set_trip_details", {"i_am": "Kai"}, user=SAM_USER)
    assert T(d)["me_by_user"] == {str(TESS): "t-tess", str(SAM_USER): "t-kai"}
    assert SPEC.validate(d)["trips"][0]["me_by_user"] == T(d)["me_by_user"]
    # The model drops mappings to travellers that don't exist.
    ghost = {**T(d), "me_by_user": {"u": "ghost", **T(d)["me_by_user"]}}
    assert SPEC.validate({**d, "trips": [ghost]})["trips"][0]["me_by_user"] == T(d)["me_by_user"]


async def test_renaming_and_removing_travellers_keeps_expenses():
    d = await _trip()
    await act(d, "add_expenses", {"expenses": [
        {"title": "Taxi", "amount": 30, "paid_by": "Sam", "split_between": ["Tess", "Sam"]},
        {"title": "Tickets", "amount": 60, "paid_by": "Tess", "split": "shares",
         "shares": [{"traveller": "Tess", "weight": 1}, {"traveller": "Sam", "weight": 2}]},
    ]})
    await act(d, "record_settlement", {"from_traveller": "Sam", "to_traveller": "Tess", "amount": 10})
    before = logic.settle_up(V(d))["balances"]
    # Rename by map, and by sending the whole list with ids: the id stays, nothing orphaned.
    await act(d, "set_trip_details", {"rename_travellers": [{"traveller": "Sam", "name": "Samuel"}]})
    assert [t["id"] for t in T(d)["travellers"]] == ["t-tess", "t-sam"] and T(d)["travellers"][1]["name"] == "Samuel"
    await act(d, "set_trip_details", {"travellers": [{"id": "t-tess", "name": "Tess"}, {"id": "t-sam", "name": "Sammy"}]})
    assert (T(d)["travellers"][1]["id"], T(d)["travellers"][1]["name"]) == ("t-sam", "Sammy")
    assert [b["balance_minor"] for b in logic.settle_up(V(d))["balances"]] == [b["balance_minor"] for b in before]
    with pytest.raises(ActionError, match="already a traveller"):
        await act(d, "set_trip_details", {"rename_travellers": [{"traveller": "Sammy", "name": "tess"}]})
    # Removing someone with money history is refused, naming what's at stake…
    with pytest.raises(ActionError, match="reassign_to"):
        await act(d, "set_trip_details", {"remove_travellers": ["Sammy"]})
    with pytest.raises(ActionError, match="reassign_to"):
        await act(d, "set_trip_details", {"travellers": [{"id": "t-tess", "name": "Tess"}]})
    assert len(T(d)["travellers"]) == 2
    # …and done when someone takes it over (shares merged, self-payments dropped).
    await act(d, "set_trip_details", {"add_travellers": [{"name": "Kai"}]})
    await act(d, "add_packing_items", {"items": [{"name": "Kindle", "traveller": "Sammy"}]})
    await act(d, "set_trip_details", {"remove_travellers": ["Sammy"], "reassign_to": "Tess"})
    assert [t["name"] for t in T(d)["travellers"]] == ["Tess", "Kai"]
    taxi = next(e for e in T(d)["expenses"] if e["title"] == "Taxi")
    tickets = next(e for e in T(d)["expenses"] if e["title"] == "Tickets")
    assert taxi["paid_by"] == "t-tess" and [s["traveller_id"] for s in taxi["shares"]] == ["t-tess"]
    assert tickets["shares"] == [{"traveller_id": "t-tess", "amount_minor": None, "weight": 3.0}]
    assert T(d)["settlements"] == [] and T(d)["packing"][0]["traveller_id"] is None
    # Someone with no expenses can just go.
    await act(d, "set_trip_details", {"remove_travellers": ["Kai"]})
    assert [t["id"] for t in T(d)["travellers"]] == ["t-tess"]
    with pytest.raises(ActionError):
        await act(d, "set_trip_details", {"remove_travellers": ["Tess"]})


async def test_changing_home_currency_keeps_every_amount():
    d = await _trip()  # AUD home, 1 AUD = 100 JPY
    await act(d, "set_exchange_rates", {"rates": [{"code": "USD", "per_home": 0.65}]})
    await act(d, "add_bookings", {"bookings": [{"type": "stay", "title": "Inn", "start": "2027-04-01T15:00", "end": "2027-04-03T10:00",
                                                "cost": 400}]})
    await act(d, "set_budget", {"total": 5000, "categories": [{"category": "food", "amount": 800}]})
    await act(d, "add_expenses", {"expenses": [
        {"title": "Dinner", "amount": 10000, "currency": "JPY", "paid_by": "Tess"},
        {"title": "Taxi", "amount": 50, "paid_by": "Sam"},
    ]})
    s = logic.settle_up(V(d))
    tr = s["transfers"][0]
    await act(d, "record_settlement", {"from_traveller": tr["from"], "to_traveller": tr["to"], "amount": tr["amount_minor"] / 100})
    assert logic.settle_up(V(d))["settled"]
    spent_aud = logic.budget_status(V(d))["spent_minor"]
    # No rate for EUR: refused, nothing changed.
    snapshot = copy.deepcopy(d)
    with pytest.raises(ActionError, match="no exchange rate for EUR"):
        await act(d, "set_trip_details", {"home_currency": "EUR"})
    assert d == snapshot
    await act(d, "set_trip_details", {"home_currency": "JPY"})
    rates = {r["code"]: r["per_home"] for r in T(d)["currencies"]}
    assert T(d)["home_currency"] == "JPY" and rates == {"AUD": 0.01, "USD": pytest.approx(0.0065)}
    assert T(d)["budget"]["total_minor"] == 500000 and T(d)["budget"]["lines"][0]["amount_minor"] == 80000
    assert T(d)["bookings"][0]["currency"] == "AUD" and T(d)["bookings"][0]["cost_minor"] == 40000  # pinned to what it was
    taxi = next(e for e in T(d)["expenses"] if e["title"] == "Taxi")
    dinner = next(e for e in T(d)["expenses"] if e["title"] == "Dinner")
    assert taxi["per_home"] == 0.01 and dinner["per_home"] is None
    assert logic.budget_status(V(d))["spent_minor"] == spent_aud  # A$150 = ¥15,000
    assert logic.settle_up(V(d))["settled"]  # still square
    assert T(d)["settlements"][0]["amount_minor"] == tr["amount_minor"]  # A$25.00 = ¥2,500
    # A trip with nothing to convert just switches.
    blank = _new()
    await act(blank, "create_trip", {"title": "Weekend"})
    await act(blank, "set_trip_details", {"home_currency": "NZD"})
    assert T(blank)["home_currency"] == "NZD" and blank["settings"]["home_currency"] == "AUD"  # the file default stays


async def test_expense_rates_lock_and_update_expense():
    d = await _trip()  # 1 AUD = 100 JPY
    await act(d, "add_expenses", {"expenses": [
        {"title": "Ramen", "amount": 2000, "currency": "JPY", "paid_by": "Tess"},
        {"title": "Gelato", "amount": 5, "currency": "EUR", "paid_by": "Sam"},  # no rate yet
    ]})
    ramen = next(e for e in T(d)["expenses"] if e["title"] == "Ramen")
    gelato = next(e for e in T(d)["expenses"] if e["title"] == "Gelato")
    assert ramen["per_home"] == 100.0 and gelato["per_home"] is None
    await act(d, "record_settlement", {"from_traveller": "Sam", "to_traveller": "Tess", "amount": 10})
    assert logic.settle_up(V(d))["settled"]
    # A new rate applies to new expenses only: settled stays settled.
    out = await act(d, "set_exchange_rates", {"rates": [{"code": "JPY", "per_home": 80}, {"code": "EUR", "per_home": 0.6}]})
    assert out.result["revalued_expenses"] == 0 and logic.settle_up(V(d))["settled"] is False  # only the EUR gelato is new money
    assert next(e for e in T(d)["expenses"] if e["title"] == "Ramen")["per_home"] == 100.0
    await act(d, "add_expenses", {"expenses": [{"title": "Sushi", "amount": 8000, "currency": "JPY", "paid_by": "Tess"}]})
    assert next(e for e in T(d)["expenses"] if e["title"] == "Sushi")["per_home"] == 80.0
    # Re-value explicitly.
    out = await act(d, "set_exchange_rates", {"rates": [{"code": "JPY", "per_home": 90}], "revalue_existing": True})
    assert out.result["revalued_expenses"] == 2 and {e["per_home"] for e in T(d)["expenses"] if e["currency"] == "JPY"} == {90.0}
    # Editing keeps the locked rate; changing currency takes the new currency's rate and needs the amount.
    await act(d, "update_expense", {"id": ramen["id"], "amount": 2500, "title": "Ramen x2"})
    ramen = next(e for e in T(d)["expenses"] if e["id"] == ramen["id"])
    assert ramen["amount_minor"] == 2500 and ramen["per_home"] == 90.0 and ramen["title"] == "Ramen x2"
    with pytest.raises(ActionError, match="amount"):
        await act(d, "update_expense", {"id": ramen["id"], "currency": "EUR"})
    await act(d, "update_expense", {"id": ramen["id"], "currency": "EUR", "amount": 20, "paid_by": "Sam",
                                    "split": "exact", "shares": [{"traveller": "Tess", "amount": 20}]})
    ramen = next(e for e in T(d)["expenses"] if e["id"] == ramen["id"])
    assert (ramen["currency"], ramen["amount_minor"], ramen["per_home"], ramen["paid_by"]) == ("EUR", 2000, 0.6, "t-sam")
    assert ramen["shares"] == [{"traveller_id": "t-tess", "amount_minor": 2000, "weight": None}]
    await act(d, "update_expense", {"id": ramen["id"], "split": "equal", "split_between": []})
    assert next(e for e in T(d)["expenses"] if e["id"] == ramen["id"])["shares"] == []
    with pytest.raises(ActionError):
        await act(d, "update_expense", {"id": "nope", "title": "x"})
    with pytest.raises(ActionError):
        await act(d, "update_expense", {"id": ramen["id"]})


def test_settle_up_uses_the_fewest_transfers():
    order = ["a", "b", "c", "d", "e"]
    bal = {"a": -700, "b": -600, "c": -300, "d": 700, "e": 900}
    # Greedy (biggest pays biggest) would need 4 here; a→d covers itself, so 3 do.
    out = logic.minimal_transfers(bal, order)
    assert len(out) == 3 and len(logic._greedy(dict(bal), {t: i for i, t in enumerate(order)})) == 4
    assert {(t["from_id"], t["to_id"], t["amount_minor"]) for t in out} == {("a", "d", 700), ("b", "e", 600), ("c", "e", 300)}
    net = dict.fromkeys(order, 0)
    for t in out:
        net[t["from_id"]] += t["amount_minor"]
        net[t["to_id"]] -= t["amount_minor"]
    assert all(net[k] + bal[k] == 0 for k in order)
    # Rounding dust (a couple of minor units) isn't worth a transfer.
    assert logic.minimal_transfers({"a": 2, "b": -2, "c": 0}, ["a", "b", "c"]) == []
    # Big groups fall back to greedy (still squares everyone up).
    many = [f"p{i}" for i in range(14)]
    vals = {p: (i + 1) * 100 * (1 if i % 2 else -1) for i, p in enumerate(many)}
    vals["p13"] -= sum(vals.values())
    assert sum(t["amount_minor"] for t in logic.minimal_transfers(vals, many)) == sum(v for v in vals.values() if v > 0)


def test_rounding_is_half_up_like_the_ui():
    from app.items.kinds.trip.timeutil import half_up

    assert to_minor(0.125, "AUD") == 13 and to_minor(0.005, "AUD") == 1  # Python's round() would give 12 and 0
    assert half_up(2.5) == 3 and half_up(-2.5) == -2  # = Math.round
    d = {"settings": {"home_currency": "AUD"}, "currencies": [{"code": "JPY", "per_home": 100}]}
    assert to_home(d, 1, "JPY", 200) == 1  # ¥1 at 200/A$ = 0.5 cents: rounds up, as in the UI


async def test_end_zone_falls_back_to_start_zone_and_user_zone():
    d = await _trip()
    await act(d, "add_bookings", {"bookings": [
        {"type": "train", "title": "Shinkansen", "start": "2027-04-05T09:00", "start_tz": "Asia/Tokyo", "end": "2027-04-05T11:15"}]})
    b = T(d)["bookings"][0]
    b["end_tz"] = ""  # an end without a zone of its own reads in the start's zone (as the UI does)
    from app.items.kinds.trip.timeutil import booking_duration

    assert booking_duration(b) == timedelta(hours=2, minutes=15)
    # A booking with no zone at all uses the person's saved zone, on both sides.
    b2 = {"start": "2027-04-05T09:00", "start_tz": "", "end": None}
    assert instant(b2["start"], b2["start_tz"], SYD) == datetime(2027, 4, 5, 9, tzinfo=SYD)


async def test_passport_missing_for_some_travellers():
    d = await _trip()
    await act(d, "add_documents", {"documents": [{"type": "passport", "traveller": "Tess", "expires": "2035-01-01", "status": "done"}]})
    issues = logic.document_issues(V(d), NOW.date())
    missing = [i for i in issues if i["kind"] == "passport_missing"]
    assert len(missing) == 1 and missing[0]["traveller_id"] == "t-sam" and "Sam" in missing[0]["message"]
    await act(d, "add_documents", {"documents": [{"type": "passport", "traveller": "Sam", "expires": "2035-01-01", "status": "done"}]})
    assert not [i for i in logic.document_issues(V(d), NOW.date()) if i["kind"] == "passport_missing"]


async def test_to_text_uses_the_owners_now():
    from app.items.spec import _TEXT_NOW

    d = await _trip()
    await act(d, "add_documents", {"documents": [{"type": "visa", "traveller": "Sam", "title": "Japan eVisa", "status": "todo"}]})
    token = _TEXT_NOW.set(datetime(2027, 3, 25, 9, tzinfo=SYD))  # 7 days to go
    try:
        text = SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(token)
    assert "starts in 7 days" in text
    token = _TEXT_NOW.set(datetime(2026, 1, 1, 9, tzinfo=SYD))  # far off: not a to-do warning yet
    try:
        assert "starts in" not in SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(token)


def test_spec_reminds_companions_and_is_honest():
    assert SPEC.remind_collaborators is True
    text = SPEC.description.lower()
    assert "offline" in text and "live flight status" in text and "not yet" in text
    assert not any("fewest" in h for h in SPEC.highlights)


# ------------------------------------------------------------------- the API


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


async def test_api_flow(client, db, user):
    from sqlalchemy import select

    from app.items.models import ItemReminder

    r = await client.post("/api/items/store/trip", headers=_auth(user))
    assert r.status_code == 200, r.text
    r = await client.post("/api/items", headers=_auth(user), json={"kind": "trip", "title": "Japan 2027"})
    assert r.status_code == 201, r.text
    item = r.json()
    fid = item["file_id"]
    assert item["filename"] == "Japan 2027.trip" and item["data"]["trips"] == []
    start = (datetime.now(timezone.utc) + timedelta(days=3)).date()
    r = await client.post(f"/api/items/{fid}/actions/create_trip", headers=_auth(user), json={"args": {"title": "Japan"}})
    assert r.status_code == 200 and r.json()["data"]["trips"][0]["travellers"][0]["is_me"], r.text
    r = await client.post(f"/api/items/{fid}/actions/set_trip_details", headers=_auth(user), json={"args": {
        "start": start.isoformat(), "end": (start + timedelta(days=7)).isoformat(),
        "destinations": [{"name": "Tokyo", "country": "Japan", "tz": "Asia/Tokyo"}]}})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/items/{fid}/actions/add_bookings", headers=_auth(user), json={"args": {"bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND",
         "start": f"{start.isoformat()}T10:30", "end": f"{start.isoformat()}T18:45"}]}})
    assert r.status_code == 200 and r.json()["summary"] == "Added 1 booking", r.text
    rems = (await db.execute(select(ItemReminder).where(ItemReminder.file_id == uuid.UUID(fid)))).scalars().all()
    assert {x.key.split("/", 1)[1].split(":")[0] for x in rems} >= {"checkin", "depart", "tripstart"}
    r = await client.post(f"/api/items/{fid}/actions/conflicts", headers=_auth(user), json={"args": {"trip": "japan"}})
    assert r.status_code == 200 and r.json()["revision"] == 4
    r = await client.post(f"/api/items/{fid}/actions/update_booking", headers=_auth(user), json={"args": {"id": "nope"}})
    assert r.status_code == 400
    data = (await client.get(f"/api/items/{fid}", headers=_auth(user))).json()
    body = data["data"]
    body["trips"][0]["packing"].append({"id": "p1", "name": "Passport", "category": "Documents", "essential": True})
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": body, "base_revision": data["revision"]})
    assert r.status_code == 200 and r.json()["data"]["trips"][0]["packing"][0]["qty"] == 1
    body["trips"][0]["bookings"][0]["start_tz"] = "Not/AZone"
    r = await client.put(f"/api/items/{fid}", headers=_auth(user), json={"data": body, "base_revision": r.json()["revision"]})
    assert r.status_code == 400


async def test_ai_turn_adds_bookings_and_plans(client, db, user, monkeypatch):
    """The AI panel drives the trip through its actions (one save, undoable)."""
    from app.items import ai
    from app.models_config import provider as prov
    from app.models_config.provider import FinishEvent, TextDelta, ToolCallDelta

    await client.post("/api/items/store/trip", headers=_auth(user))
    fid = (await client.post("/api/items", headers=_auth(user), json={"kind": "trip", "title": "Kyoto"})).json()["file_id"]
    hops = [
        [("create_trip", {"title": "Kyoto", "start": "2027-04-01", "end": "2027-04-05",
                          "destinations": [{"name": "Kyoto", "country": "Japan", "tz": "Asia/Tokyo"}]})],
        [("add_bookings", {"bookings": [{"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "KIX",
                                         "start": "2027-04-01T09:00", "end": "2027-04-01T17:30"}]}),
         ("plan_days", {"days": [{"date": "2027-04-02", "items": [{"title": "Fushimi Inari", "time": "07:30"}]}]})],
        [("conflicts", {})],
    ]

    class Fake:
        def __init__(self):
            self.calls = []

        async def stream_chat_events(self, **kw):
            self.calls.append(kw)
            hop = hops.pop(0) if hops else None
            if hop is None:
                yield TextDelta(text="Added your flight and day 2.")
            else:
                for i, (name, args) in enumerate(hop):
                    yield ToolCallDelta(index=i, id=f"c{len(self.calls)}{i}", name=name, arguments=json.dumps(args))
            yield FinishEvent(reason="tool_calls" if hop else "stop")

    fake = Fake()
    monkeypatch.setattr(prov, "model_router", fake)
    events = [ev async for ev in ai.run_turn(db, user, uuid.UUID(fid), "add my flight", object(), "m", can_edit=True)]
    done = events[-1]
    assert done["type"] == "done" and done["changed"] and done["version_id"]
    trip = done["data"]["trips"][0]
    assert trip["bookings"][0]["end_tz"] == "Asia/Tokyo" and trip["days"][0]["items"][0]["title"] == "Fushimi Inari"
    assert [e["ok"] for e in events if e["type"] == "action"] == [True, True, True]
    assert "verify them on the official government site" in fake.calls[0]["system"]
    assert any(t["function"]["name"] == "web_search" for t in fake.calls[0]["tools"])


# ------------------------------------------------------------- many trips


async def _three() -> dict:
    """Japan (Apr 2027, upcoming, with expenses), Bali (Jul 2027) and a past Rome trip."""
    d = await _trip()
    await act(d, "add_expenses", {"expenses": [{"title": "Ramen", "amount": 2000, "currency": "JPY", "paid_by": "Tess"}]})
    await act(d, "create_trip", {"title": "Bali", "start": "2027-07-01", "end": "2027-07-08", "emoji": "🏝️",
                                 "destinations": [{"name": "Ubud", "country": "Indonesia", "tz": "Asia/Makassar"}]})
    await act(d, "create_trip", {"title": "Rome 2026", "start": "2026-05-01", "end": "2026-05-06", "status": "done",
                                 "destinations": [{"name": "Rome", "country": "Italy", "tz": "Europe/Rome"}]})
    return d


def test_old_one_trip_files_load_as_trips0():
    old = {
        "title": "Japan 2027", "emoji": "🗾", "start": "2027-04-01", "end": "2027-04-10", "status": "booked",
        "travellers": [{"id": "t-tess", "name": "Tess", "is_me": True, "user_id": str(TESS)}],
        "me_by_user": {str(TESS): "t-tess"},
        "bookings": [{"id": "b-qf25", "type": "flight", "number": "QF25", "start": "2027-04-01T10:30", "start_tz": "Australia/Sydney"}],
        "expenses": [{"id": "x1", "date": "2027-04-02", "title": "Ramen", "amount_minor": 2000, "currency": "JPY", "paid_by": "t-tess"}],
        "currencies": [{"code": "JPY", "per_home": 100}],
        "settings": {"home_currency": "NZD", "passport_months": 3, "onboarded": True, "clock": "24h"},
    }
    d = SPEC.validate(copy.deepcopy(old))
    assert len(d["trips"]) == 1 and set(d) == {"trips", "settings"}
    t = d["trips"][0]
    assert t["title"] == "Japan 2027" and t["status"] == "booked" and t["home_currency"] == "NZD"
    assert t["bookings"][0]["number"] == "QF25" and t["expenses"][0]["amount_minor"] == 2000
    assert t["me_by_user"] == {str(TESS): "t-tess"} and t["id"].startswith("trip-")
    assert d["settings"]["passport_months"] == 3 and d["settings"]["clock"] == "24h"
    # The same old file always gets the same trip id, and the result is stable.
    assert SPEC.validate(copy.deepcopy(old))["trips"][0]["id"] == t["id"] and SPEC.validate(d) == d
    assert SPEC.validate(SPEC.migrate(copy.deepcopy(old), 1)) == d and SPEC.version == 2
    # An old file that never got past setup becomes an empty file.
    assert SPEC.validate({"travellers": [{"id": "t", "name": "Me"}], "settings": {"onboarded": False}})["trips"] == []
    text = SPEC.to_text(d)
    assert "Japan 2027" in text and "QF25" in text


async def test_old_file_keeps_working_through_actions():
    d = SPEC.validate({"title": "Kyoto", "start": "2027-04-01", "end": "2027-04-05",
                       "travellers": [{"id": "t-tess", "name": "Tess", "user_id": str(TESS)}], "me_by_user": {str(TESS): "t-tess"},
                       "settings": {"home_currency": "AUD", "onboarded": True}})
    await act(d, "add_expenses", {"expenses": [{"title": "Tea", "amount": 5, "paid_by": "me"}]})
    assert T(d)["expenses"][0]["paid_by"] == "t-tess"


async def test_trip_crud_and_list():
    d = await _three()
    ids = [t["id"] for t in d["trips"]]
    assert ids == ["trip-japan-2027", "trip-bali", "trip-rome-2026"]
    assert T(d, "trip-bali")["travellers"][0]["name"] == "Tess" and T(d, "trip-bali")["destinations"][0]["tz"] == "Asia/Makassar"
    lst = (await act(d, "list_trips")).result
    assert [(t["title"], t["when"]) for t in lst["trips"]] == [("Japan 2027", "upcoming"), ("Bali", "upcoming"), ("Rome 2026", "past")]
    assert lst["trips"][0]["days_to_go"] == 31 and lst["default_trip"] == "trip-japan-2027"
    # Same title twice gets its own id.
    await act(d, "create_trip", {"title": "Bali", "include_me": False, "travellers": [{"name": "Kai"}]})
    assert d["trips"][-1]["id"] == "trip-bali-2" and [t["name"] for t in d["trips"][-1]["travellers"]] == ["Kai"]
    n = len(d["trips"])
    with pytest.raises(ActionError, match="traveller"):
        await act(d, "create_trip", {"title": "Nobody", "include_me": False})
    with pytest.raises(ActionError):
        await act(d, "create_trip", {"title": "X", "home_currency": "dollars"})
    assert len(d["trips"]) == n  # refusals change nothing
    # Deleting a trip with money needs confirm.
    with pytest.raises(ActionError, match="confirm=true"):
        await act(d, "delete_trip", {"trip": "Japan 2027"})
    await act(d, "delete_trip", {"trip": "trip-bali-2"})
    out = await act(d, "delete_trip", {"trip": "japan", "confirm": True})
    assert out.summary == "Deleted the trip Japan 2027" and [t["id"] for t in d["trips"]] == ["trip-bali", "trip-rome-2026"]
    with pytest.raises(ActionError, match="No trip matches"):
        await act(d, "delete_trip", {"trip": "Atlantis"})
    # Copy travellers from another trip.
    await act(d, "create_trip", {"title": "Bali again", "copy_travellers_from": "Rome 2026"})
    assert [t["id"] for t in d["trips"][-1]["travellers"]] == ["t-tess"]


async def test_scoped_actions_and_ambiguity():
    d = await _three()
    # Two upcoming trips on different dates: the next one is the default.
    out = await act(d, "add_bookings", {"bookings": [{"type": "stay", "title": "Gracery", "start": "2027-04-01T15:00",
                                                      "end": "2027-04-05T11:00"}]})
    assert T(d, "trip-japan-2027")["bookings"][0]["title"] == "Gracery" and out.summary.endswith("· Japan 2027")
    assert out.result["trip"] == {"id": "trip-japan-2027", "title": "Japan 2027"}
    # By title (fuzzy), by destination, by id.
    await act(d, "add_bookings", {"trip": "bali", "bookings": [{"type": "stay", "title": "Villa", "start": "2027-07-01T14:00",
                                                               "end": "2027-07-08T11:00"}]})
    await act(d, "plan_days", {"trip": "Ubud", "days": [{"date": "day 2", "items": [{"title": "Rice terraces"}]}]})
    await act(d, "add_packing_items", {"trip": "trip-bali", "template": "beach"})
    bali = T(d, "trip-bali")
    assert bali["bookings"][0]["start_tz"] == "Asia/Makassar" and bali["days"][0]["date"] == "2027-07-02" and bali["packing"]
    assert not T(d, "trip-japan-2027")["packing"] and len(T(d, "trip-japan-2027")["bookings"]) == 1
    assert isinstance((await act(d, "trip_summary", {"trip": "Rome"})).result, dict)
    with pytest.raises(ActionError, match="No trip matches"):
        await act(d, "add_ideas", {"trip": "Mars", "ideas": [{"title": "x"}]})
    # An undated trip competes → no default; refuse, listing the trips.
    await act(d, "create_trip", {"title": "Someday Iceland"})
    with pytest.raises(ActionError, match="Which trip") as e:
        await act(d, "add_ideas", {"ideas": [{"title": "Blue Lagoon"}]})
    assert "Japan 2027" in str(e.value) and "trip-bali" in str(e.value)
    await act(d, "add_ideas", {"trip": "iceland", "ideas": [{"title": "Blue Lagoon"}]})
    assert T(d, "trip-someday-iceland")["ideas"][0]["title"] == "Blue Lagoon"
    # During a trip, it's the default even with others around.
    await act(d, "add_expenses", {"expenses": [{"title": "Coffee", "amount": 400, "currency": "JPY"}]},
              now=datetime(2027, 4, 3, 9, tzinfo=SYD))
    assert T(d, "trip-japan-2027")["expenses"][-1]["title"] == "Coffee"
    # Two trips with the same title: refused until the id is given.
    await act(d, "create_trip", {"title": "Bali"})
    with pytest.raises(ActionError, match="More than one trip"):
        await act(d, "trip_summary", {"trip": "Bali"})
    # Per-trip home currency; preferences are the file's.
    await act(d, "set_trip_details", {"trip": "trip-bali", "home_currency": "USD", "passport_months": 3})
    assert T(d, "trip-bali")["home_currency"] == "USD" and T(d, "trip-japan-2027")["home_currency"] == "AUD"
    assert d["settings"]["passport_months"] == 3 and all("settings" not in t for t in d["trips"])


async def test_no_trips_yet_refuses():
    d = _new()
    with pytest.raises(ActionError, match="create_trip"):
        await act(d, "add_bookings", {"bookings": [{"type": "stay", "title": "x"}]})
    assert (await act(d, "list_trips")).result["count"] == 0


async def test_duplicate_trip():
    d = await _three()
    await act(d, "add_bookings", {"bookings": [{"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND",
                                                "start": "2027-04-01T10:30", "end": "2027-04-01T18:45"}]})
    qf = T(d)["bookings"][0]["id"]
    await act(d, "plan_days", {"days": [{"date": "2027-04-02", "items": [
        {"title": "Senso-ji", "time": "08:00"}, {"title": "Arrive", "type": "flight", "booking_id": qf, "status": "booked"}]}]})
    await act(d, "add_packing_items", {"items": [{"name": "Adapter"}]})
    await act(d, "check_packing", {"all": True})
    await act(d, "add_documents", {"documents": [{"type": "passport", "traveller": "Tess", "expires": "2035-01-01", "status": "done"},
                                                 {"type": "visa", "traveller": "Sam", "title": "eVisa"}]})
    out = await act(d, "duplicate_trip", {"trip": "japan", "title": "Japan 2028", "start": "2028-04-03"})
    c = T(d, out.result["id"])
    assert (c["start"], c["end"]) == ("2028-04-03", "2028-04-12") and c["destinations"][1]["start"] == "2028-04-07"
    assert c["days"][0]["date"] == "2028-04-04"
    assert all(i["booking_id"] is None and i["status"] == "planned" for i in c["days"][0]["items"])
    assert c["bookings"] == [] and c["expenses"] == [] and not any(p["checked"] for p in c["packing"])
    assert [x["type"] for x in c["documents"]] == ["passport"] and c["currencies"] == T(d)["currencies"]
    # Without a start: no dates, the plan becomes ideas (not the flight).
    out = await act(d, "duplicate_trip", {"trip": "trip-japan-2027"})
    c = T(d, out.result["id"])
    assert c["title"] == "Japan 2027 (copy)" and c["start"] is None and c["days"] == []
    assert [i["title"] for i in c["ideas"]] == ["Senso-ji"]


async def test_reminders_across_trips():
    d = await _three()
    await act(d, "add_bookings", {"trip": "japan", "bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-04-01T10:30", "end": "2027-04-01T18:45"}]})
    await act(d, "add_bookings", {"trip": "bali", "bookings": [
        {"type": "flight", "number": "QF25", "from_code": "SYD", "to_code": "HND", "start": "2027-07-01T10:30", "end": "2027-07-01T18:45"}]})
    # Same booking id in both trips — the trip id keeps the reminder keys apart.
    assert T(d, "trip-japan-2027")["bookings"][0]["id"] == T(d, "trip-bali")["bookings"][0]["id"]
    rems = trip_reminders(d, _ctx(datetime(2027, 3, 1, 9, tzinfo=SYD)))
    keys = [r.key for r in rems]
    assert len(keys) == len(set(keys))
    assert {k.split("/")[0] for k in keys} == {"trip-japan-2027", "trip-bali"}  # nothing for the past trip
    jp = next(r for r in rems if r.key.startswith("trip-japan-2027/checkin:"))
    assert jp.body.startswith("Japan 2027 · ")
    # A trip marked done stops reminding.
    await act(d, "set_trip_details", {"trip": "bali", "status": "done"})
    assert not any(r.key.startswith("trip-bali/") for r in trip_reminders(d, _ctx(datetime(2027, 3, 1, 9, tzinfo=SYD))))


async def test_archive_moves_ended_trips():
    d = await _three()
    kept, archived = SPEC.archive(copy.deepcopy(d), _ctx(), "2027-01-01")
    assert [t["title"] for t in kept["trips"]] == ["Japan 2027", "Bali"]
    assert [t["title"] for t in archived["trips"]] == ["Rome 2026"] and archived["settings"]["onboarded"]
    assert SPEC.validate(kept)["trips"] and SPEC.validate(archived)["trips"]
    with pytest.raises(ActionError):
        SPEC.archive(copy.deepcopy(d), _ctx(), "2026-01-01")
    with pytest.raises(ActionError):
        SPEC.archive(copy.deepcopy(d), _ctx(), "soon")


async def test_to_text_covers_every_trip():
    from app.items.spec import _TEXT_NOW

    d = await _three()
    await act(d, "add_bookings", {"trip": "bali", "bookings": [{"type": "stay", "title": "Villa Ubud", "start": "2027-07-01T14:00",
                                                               "end": "2027-07-08T11:00"}]})
    token = _TEXT_NOW.set(datetime(2027, 3, 1, 9, tzinfo=SYD))
    try:
        text = SPEC.to_text(d)
    finally:
        _TEXT_NOW.reset(token)
    assert text.startswith("Trip Planner — 3 trips: Japan 2027 (upcoming); Bali (upcoming); Rome 2026 (past)")
    assert "Villa Ubud" in text and "trip id trip-bali" in text and "Past trips:" in text and "Rome" in text
    assert text.index("Japan 2027 —") < text.index("Bali —") < text.index("Past trips:")
    assert SPEC.to_text(_new()) == "Trip Planner: no trips yet."


def test_tools_cover_trip_actions():
    from app.items.ai import tools_for

    tools = {t["function"]["name"]: t for t in tools_for(SPEC, can_edit=True)}
    for a in ("list_trips", "create_trip", "duplicate_trip", "delete_trip"):
        assert a in tools
    assert "trip" in tools["add_bookings"]["function"]["parameters"]["properties"]
    assert "trip" in tools["conflicts"]["function"]["parameters"]["properties"]
    assert "trip" not in tools["list_trips"]["function"]["parameters"].get("properties", {})
    assert "list_trips" in {t["function"]["name"] for t in tools_for(SPEC, can_edit=False)}
