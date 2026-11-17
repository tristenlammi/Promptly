"""Simple device commands without a model (``app/home/quick.py``): what is
understood, and above all what is NOT: anything that could mean two things
goes to the model, which can ask."""
from __future__ import annotations

import uuid

import pytest

from app.home import quick

BOX = uuid.UUID("11111111-1111-1111-1111-111111111111")
HOME = uuid.UUID("22222222-2222-2222-2222-222222222222")
OTHER_BOX = uuid.UUID("33333333-3333-3333-3333-333333333333")
OTHER_HOME = uuid.UUID("44444444-4444-4444-4444-444444444444")


def dev(eid: str, name: str, room: str = "", *, state: str = "on", box=BOX, home=HOME, live: bool = True, **extra) -> dict:
    domain = eid.split(".", 1)[0]
    d = {"id": eid, "domain": domain, "name": name, "state": state, "box_id": box, "home_id": home, "home": "Home", "live": live, "careful": domain in ("lock", "alarm_control_panel")}
    if room:
        d["area"], d["room"] = room.lower().replace(" ", "_"), room
    d.update(extra)
    return d


def house() -> list[dict]:
    return [
        dev("light.kitchen_bench", "Bench", "Kitchen"),
        dev("light.kitchen_ceiling", "Kitchen ceiling", "Kitchen"),
        dev("light.lounge_lamp", "Floor lamp", "Lounge"),
        dev("light.lounge_ceiling", "Lounge ceiling", "Lounge"),
        dev("light.bed", "Bedside", "Main Bedroom"),
        dev("light.desk", "Desk lamp", "Study"),
        dev("switch.heater", "Heater", "Study", state="off"),
        dev("fan.study", "Study fan", "Study", state="off"),
        dev("media_player.kitchen", "Kitchen speaker", "Kitchen", state="playing", x={"vol": 30, "can": ["pause", "play", "next", "prev", "vol", "mute", "stop", "preset"]}),
        dev("media_player.study", "Study speaker", "Study", state="idle", x={"vol": 55, "can": ["pause", "play", "next", "vol", "mute"]}),
        dev("scene.movie", "Movie night", "Lounge", state="scening"),
        dev("scene.relax", "Relax", "Lounge", state="scening"),
        dev("lock.front", "Front door", "Hall", state="locked"),
        dev("cover.garage", "Garage door", "Garage", state="closed", cls="garage", careful=True),
        dev("sensor.temp", "Temperature", "Lounge", state="21"),
    ]


def steps(plan: quick.Plan) -> list[tuple]:
    return [(s.kind, s.area, s.action) if s.kind == "lights" else (s.kind, s.device["id"], s.action, s.value) for s in plan.steps]


@pytest.mark.parametrize(
    ("said", "want", "say"),
    [
        ("Turn off the kitchen lights.", [("lights", "kitchen", "turn_off")], "Kitchen lights off."),
        ("turn the kitchen lights off", [("lights", "kitchen", "turn_off")], "Kitchen lights off."),
        ("Kitchen lights on", [("lights", "kitchen", "turn_on")], "Kitchen lights on."),
        ("Hey Promptly, switch on the lounge lights please", [("lights", "lounge", "turn_on")], "Lounge lights on."),
        ("Promptly turn off the main bedroom lights", [("lights", "main_bedroom", "turn_off")], "Main Bedroom lights off."),
        ("can you turn on the lounge room lights", [("lights", "lounge", "turn_on")], "Lounge lights on."),
        ("turn off the desk lamp", [("do", "light.desk", "turn_off", None)], "Desk lamp off."),
        ("Turn on the heater", [("do", "switch.heater", "turn_on", None)], "Heater on."),
        ("study fan off", [("do", "fan.study", "turn_off", None)], "Study fan off."),
        ("turn off the bedside light", [("do", "light.bed", "turn_off", None)], "Bedside off."),
    ],
)
def test_lights_and_switches_by_room_or_by_name(said, want, say):
    plan = quick.parse(said, house())
    assert plan is not None, said
    assert steps(plan) == want
    assert plan.say == say


def test_brightness_for_a_room_or_one_light():
    plan = quick.parse("Set lounge to 30%", house())
    assert plan is not None and plan.say == "Lounge lights at 30%."
    assert sorted(steps(plan)) == [("do", "light.lounge_ceiling", "set", {"bri": 30}), ("do", "light.lounge_lamp", "set", {"bri": 30})]
    assert steps(quick.parse("dim the desk lamp to 10 percent", house())) == [("do", "light.desk", "set", {"bri": 10})]
    assert steps(quick.parse("lounge lights to fifty percent", house())) == steps(quick.parse("set the brightness in the lounge to 50", house()))
    assert steps(quick.parse("dim the desk lamp to 20", house())) == [("do", "light.desk", "set", {"bri": 20})]
    # Nought is off, not a brightness.
    assert steps(quick.parse("set the lounge lights to 0%", house())) == [("lights", "lounge", "turn_off")]
    # More than a hundred isn't a brightness at all.
    assert quick.parse("set lounge to 300%", house()) is None


def test_a_number_for_a_room_with_a_speaker_in_it_is_not_guessed():
    # The kitchen has lights and a speaker: 30% of what?
    assert quick.parse("set kitchen to 30%", house()) is None
    # Said plainly, each is fine.
    assert sorted(steps(quick.parse("set the kitchen lights to 30%", house()))) == [
        ("do", "light.kitchen_bench", "set", {"bri": 30}),
        ("do", "light.kitchen_ceiling", "set", {"bri": 30}),
    ]
    assert steps(quick.parse("set the kitchen speaker to 30%", house())) == [("do", "media_player.kitchen", "volume", 30)]


def test_colours_and_whites():
    plan = quick.parse("make the lounge lights red", house())
    assert plan.say == "Lounge lights red." and all(s.value == {"rgb": [255, 0, 0]} for s in plan.steps) and len(plan.steps) == 2
    assert steps(quick.parse("set the desk lamp to warm white", house())) == [("do", "light.desk", "set", {"k": 2700})]
    # A switch has no colour.
    assert quick.parse("make the heater red", house()) is None


def test_all_the_lights_only_when_it_is_said_and_only_in_one_home():
    plan = quick.parse("turn off all the lights", house())
    assert plan.say == "All the lights off."
    assert sorted(steps(plan)) == sorted([("lights", r, "turn_off") for r in ("kitchen", "lounge", "main_bedroom", "study")])
    # "The lights", with lights in four rooms: which?
    assert quick.parse("turn off the lights", house()) is None
    # One room of lights: that's the one.
    one = [dev("light.a", "Lamp", "Lounge"), dev("light.b", "Ceiling", "Lounge")]
    assert steps(quick.parse("turn off the lights", one)) == [("lights", "lounge", "turn_off")]
    # Two homes: never both at once.
    two = house() + [dev("light.x", "Porch light", "Porch", box=OTHER_BOX, home=OTHER_HOME)]
    assert quick.parse("turn off all the lights", two) is None


@pytest.mark.parametrize(
    "said",
    [
        "turn off the kitchen",  # its lights, or everything in it?
        "turn off the garden lights",  # no such room
        "turn on the lamp",  # two things have "lamp" in the name; neither is called that
        "turn off the kitchen lights and lock the front door",
        "turn off the kitchen lights in ten minutes",
        "are the kitchen lights on",
        "what's playing in the kitchen",
        "why are the lights on",
        "unlock the front door",
        "open the garage door",
        "turn off the front door",
        "garage door off",
        "play some jazz in the kitchen",
        "play taylor swift",
        "set the temperature to 22",
        "set lounge to 22",
        "tell me a joke",
        "on",
        "stop",
        "continue",
        "next",  # nothing named, but see the speaker tests: only when one is playing
        "",
    ],
)
def test_anything_unsure_goes_to_the_model(said):
    home = [d for d in house() if d["id"] != "media_player.kitchen"] if said == "next" else house()
    assert quick.parse(said, home) is None, said


def test_a_name_in_two_homes_is_never_guessed():
    two = house() + [dev("light.k2", "Ceiling", "Kitchen", box=OTHER_BOX, home=OTHER_HOME)]
    assert quick.parse("turn off the kitchen lights", two) is None
    assert quick.parse("turn off the lounge lights", two) is not None


def test_two_devices_with_one_name_are_never_guessed():
    twins = [dev("light.a", "Lamp", "Lounge"), dev("light.b", "Lamp", "Study")]
    assert quick.parse("turn off the lamp", twins) is None


def test_the_speaker_that_is_playing_is_the_one_meant():
    assert steps(quick.parse("pause the music", house())) == [("do", "media_player.kitchen", "pause", None)]
    assert quick.parse("Pause.", house()).say == "Paused on Kitchen speaker."
    assert steps(quick.parse("skip this song", house())) == [("do", "media_player.kitchen", "next", None)]
    assert steps(quick.parse("next", house())) == [("do", "media_player.kitchen", "next", None)]
    assert steps(quick.parse("stop the music", house())) == [("do", "media_player.kitchen", "pause", None)]
    assert steps(quick.parse("mute", house())) == [("do", "media_player.kitchen", "mute", True)]
    assert steps(quick.parse("volume 40", house())) == [("do", "media_player.kitchen", "volume", 40)]
    assert steps(quick.parse("set the volume to 15 percent", house())) == [("do", "media_player.kitchen", "volume", 15)]
    assert steps(quick.parse("turn it up", house())) == [("do", "media_player.kitchen", "volume", 40)]
    assert steps(quick.parse("volume down", house())) == [("do", "media_player.kitchen", "volume", 20)]
    assert steps(quick.parse("play preset 3", house())) == [("do", "media_player.kitchen", "preset", 3)]


def test_a_named_speaker_or_its_room():
    assert steps(quick.parse("pause the study speaker", house())) == [("do", "media_player.study", "pause", None)]
    assert steps(quick.parse("set the volume in the study to 20", house())) == [("do", "media_player.study", "volume", 20)]
    assert steps(quick.parse("volume 60 in the kitchen", house())) == [("do", "media_player.kitchen", "volume", 60)]
    # It didn't say it can go back a song, or that it has presets.
    assert quick.parse("previous song in the study", house()) is None
    assert quick.parse("play preset 2 in the study", house()) is None


def test_with_two_playing_or_none_nothing_is_guessed():
    both = [{**d, "state": "playing"} if d["domain"] == "media_player" else d for d in house()]
    assert quick.parse("pause the music", both) is None
    quiet = [{**d, "state": "idle"} if d["domain"] == "media_player" else d for d in house()]
    assert quick.parse("pause the music", quiet) is None
    assert quick.parse("play", quiet) is None  # nothing paused to carry on with
    paused = [{**d, "state": "paused"} if d["id"] == "media_player.study" else {**d, "state": "idle"} if d["domain"] == "media_player" else d for d in house()]
    assert steps(quick.parse("resume the music", paused)) == [("do", "media_player.study", "play", None)]
    assert steps(quick.parse("play music", paused)) == [("do", "media_player.study", "play", None)]
    # "Play music in the kitchen" with nothing paused there asks for music: the assistant starts some.
    assert quick.parse("play music in the kitchen", quiet) is None
    assert quick.parse("play the music in the study", house()) is None
    assert steps(quick.parse("play music in the study", paused)) == [("do", "media_player.study", "play", None)]


def test_speakers_playing_as_a_group_are_paused_as_the_group():
    grouped = house() + [dev("media_player.everywhere", "Everywhere", state="playing", grp=True, x={"can": ["pause", "play", "vol"]})]
    assert steps(quick.parse("pause", grouped)) == [("do", "media_player.everywhere", "pause", None)]


def test_scenes_by_their_exact_name():
    assert steps(quick.parse("turn on movie night", house())) == [("do", "scene.movie", "run", None)]
    assert quick.parse("activate the relax scene", house()).say == "Relax is on."
    assert steps(quick.parse("movie night scene", house())) == [("do", "scene.movie", "run", None)]
    assert quick.parse("turn on movie", house()) is None
    assert quick.parse("activate party", house()) is None


def test_a_lock_a_garage_door_or_an_alarm_is_never_in_a_plan():
    careful = [
        dev("lock.front", "Front door", "Hall", state="locked"),
        dev("cover.garage", "Garage", "Garage", state="closed", cls="garage", careful=True),
        dev("alarm_control_panel.house", "Alarm", "Hall", state="armed_away"),
        dev("switch.gate", "Gate", "Yard", careful=True),
    ]
    for said in ("turn off the alarm", "alarm off", "turn on the gate", "gate on", "turn off the front door", "garage off", "unlock the front door", "open the garage"):
        assert quick.parse(said, careful) is None, said


def test_an_offline_box_is_said_not_tried():
    off = [{**d, "live": False} for d in house()]
    plan = quick.parse("turn off the kitchen lights", off)
    assert plan is not None and plan.problem and not plan.steps and "offline" in plan.say
    plan = quick.parse("pause the music", off)
    assert plan is not None and plan.problem


def test_the_cheap_first_look():
    assert quick.maybe("turn off the kitchen lights")
    assert quick.maybe("Hey Promptly, pause")
    assert not quick.maybe("what's the weather tomorrow")
    assert not quick.maybe("remind me to call mum")
    assert not quick.maybe("is the heater on")
    assert not quick.maybe("")


def test_names_are_compared_the_way_people_say_them():
    assert quick.key("The Kitchen") == "kitchen"
    assert quick.norm("Sam's Room, 30%!") == "sams room 30 percent"
    sams = [dev("light.s", "Ceiling", "Sam's Room")]
    assert steps(quick.parse("turn off sams room lights", sams)) == [("lights", "sam's_room", "turn_off")]
    assert steps(quick.parse("Turn off Sam’s room lights", sams)) == [("lights", "sam's_room", "turn_off")]


@pytest.mark.parametrize(
    "said",
    [
        "play miles davis in the lounge",
        "play kind of blue",
        "play some jazz in the kitchen",
        "play yesterday by the beatles on the kitchen speaker",
        "play my discover playlist in the study",
        "put on some music by miles davis",
        "play the album blue in the kitchen",
        "hey promptly play the song next to me in the study",
        "play something relaxing",
    ],
)
def test_music_by_name_is_never_guessed_here_it_goes_to_the_model(said):
    """Which song, album or artist is meant can need a question back, so
    these are left to the assistant's ``home_music`` tool."""
    music = [{**d, "x": {**(d.get("x") or {}), "can": [*((d.get("x") or {}).get("can") or []), "music"]}} if d["domain"] == "media_player" else d for d in house()]
    assert quick.parse(said, music) is None
    assert quick.parse(said, house()) is None
