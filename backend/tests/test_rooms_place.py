"""A place sent from P Maps into a room: it rides on the message as
``meta.place`` (a name, an address, a point) and is drawn as a card."""
from __future__ import annotations

from tests.test_rooms import H, _quiet_background, client, make_space, mk_user, people, say  # noqa: F401

CAFE = {"name": "  Blue   Door Cafe ", "address": "12 Example St, Newtown", "lat": -27.4698123456, "lon": 153.0251}


async def test_a_place_rides_on_the_message(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "", place=CAFE)
    place = m["meta"]["place"]
    assert place == {"name": "Blue Door Cafe", "address": "12 Example St, Newtown", "lat": -27.469812, "lon": 153.0251, "has_note": False}
    # With no words of your own, its name stands in for them (lists, notifications).
    assert "Blue Door Cafe" in m["body"]

    # Everyone in the room gets the same card.
    r = await client.get(f"/api/rooms/rooms/{room}/messages", headers=H(bob))
    assert r.status_code == 200, r.text
    got = [x for x in r.json()["messages"] if x["id"] == m["id"]][0]
    assert got["meta"]["place"]["name"] == "Blue Door Cafe"


async def test_your_words_go_with_the_place(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "On my way, there about 5:40 pm.", place=CAFE)
    assert m["body"] == "On my way, there about 5:40 pm."
    assert m["meta"]["place"]["has_note"] is True


async def test_a_retried_place_is_not_posted_twice(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    first = await say(client, ann, room, "", place=CAFE, client_id="p-1")
    again = await say(client, ann, room, "", place=CAFE, client_id="p-1")
    assert first["id"] == again["id"]
    assert again["meta"]["place"]["name"] == "Blue Door Cafe"


async def test_a_place_that_isnt_one_is_refused(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    for bad in (
        {"name": "Nowhere", "lat": 123.0, "lon": 10.0},
        {"name": "", "lat": 1.0, "lon": 1.0},
        {"name": "x" * 121, "lat": 1.0, "lon": 1.0},
        {"name": "No point"},
    ):
        r = await client.post(f"/api/rooms/rooms/{room}/messages", headers=H(ann), json={"body": "", "place": bad})
        assert r.status_code == 422, r.text


async def test_editing_a_bare_place_makes_the_words_yours(client, db, people):  # noqa: F811
    ann, bob, *_ = people
    _sid, room = await make_space(client, ann, bob)
    m = await say(client, ann, room, "", place=CAFE)
    r = await client.patch(f"/api/rooms/messages/{m['id']}", headers=H(ann), json={"body": "Meet here at 6"})
    assert r.status_code == 200, r.text
    assert r.json()["body"] == "Meet here at 6"
    assert r.json()["meta"]["place"]["has_note"] is True
    assert r.json()["meta"]["place"]["name"] == "Blue Door Cafe"
