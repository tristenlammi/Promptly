"""The box connector's plain shapes (``home-box/connector/promptly_box.py``):
Home Assistant's set-up steps in, what Promptly shows out. Run against steps
recorded from Home Assistant's API. Skipped where the connector isn't beside
the backend (it ships to the box, not in the backend image)."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest


def _load():
    here = Path(__file__).resolve()
    for root in (os.environ.get("HOME_BOX_DIR"), here.parents[2] / "home-box", Path("/home-box")):
        path = Path(root) / "connector" / "promptly_box.py" if root else None
        if path and path.exists():
            spec = importlib.util.spec_from_file_location("promptly_box", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    return None


pb = _load()
pytestmark = pytest.mark.skipif(pb is None, reason="the box connector isn't mounted here")

HUE_WORDS = {
    "component.hue.config.step.manual.title": "Manual configure a Hue bridge",
    "component.hue.config.step.manual.data.host": "Host",
    "component.hue.config.step.link.title": "Link Hub",
    "component.hue.config.step.link.description": "Press the button on the bridge to register Philips Hue with Home Assistant.\n\n![Location of button on bridge](/static/images/config_philips_hue.jpg)",
    "component.hue.config.error.register_failed": "Failed to register, please try again",
    "component.hue.config.error.linking": "Unexpected linking error.",
    "component.hue.config.abort.already_configured": "Device is already configured",
    "component.hue.config.flow_title": "{name}",
}
# As POST /api/config/config_entries/flow answers for Hue.
HUE_MANUAL = {"type": "form", "flow_id": "01HUE", "handler": "hue", "step_id": "manual", "data_schema": [{"type": "string", "name": "host", "required": True}], "errors": {}, "description_placeholders": None, "last_step": None}
HUE_LINK = {"type": "form", "flow_id": "01HUE", "handler": "hue", "step_id": "link", "data_schema": [], "errors": None, "description_placeholders": None, "last_step": None}
HUE_LINK_FAILED = {**HUE_LINK, "errors": {"base": "register_failed"}}
HUE_DONE = {"type": "create_entry", "flow_id": "01HUE", "handler": "hue", "title": "Hue Bridge 1a2b3c", "result": {"entry_id": "e-hue", "title": "Hue Bridge 1a2b3c", "domain": "hue"}, "description": None}
# A sign-in style step (selectors, as newer integrations send them).
LOGIN = {
    "type": "form", "flow_id": "01LOG", "handler": "acme", "step_id": "user", "last_step": True, "errors": {"base": "invalid_auth"},
    "description_placeholders": {"url": "https://acme.example"},
    "data_schema": [
        {"name": "username", "required": True, "selector": {"text": {"type": "email"}}, "description": {"suggested_value": "sam@example.com"}},
        {"name": "password", "required": True, "selector": {"text": {"type": "password"}}},
        {"name": "api_token", "type": "string", "required": False, "default": "do-not-echo"},
        {"name": "region", "required": True, "default": "eu", "selector": {"select": {"options": [{"value": "eu", "label": "Europe"}, {"value": "us", "label": "America"}]}}},
        {"name": "scan_interval", "type": "integer", "valueMin": 5, "valueMax": 300, "default": 30, "optional": True},
        {"name": "use_tls", "type": "boolean", "default": True},
        {"name": "where", "selector": {"location": {}}},
    ],
}
LOGIN_WORDS = {"component.acme.config.step.user.description": "Sign in at {url} first.", "component.acme.config.step.user.data.username": "Email"}


def test_hue_asks_for_the_bridge_then_for_its_button():
    step = pb.shape_flow(HUE_MANUAL, HUE_WORDS, "Philips Hue")
    assert (step["kind"], step["title"]) == ("form", "Your Hue bridge's address")
    assert step["fields"] == [{"name": "host", "label": "Address", "required": True, "type": "text"}]

    link = pb.shape_flow(HUE_LINK, HUE_WORDS, "Philips Hue")
    # No fields: "press the button, then Continue". Home Assistant is never named, and its picture is dropped.
    assert link["kind"] == "form" and link["fields"] == [] and link["errors"] == {}
    assert link["text"] == "Press the big round button on top of your Hue bridge, then tap \"I've pressed it\" within 30 seconds."

    failed = pb.shape_flow(HUE_LINK_FAILED, HUE_WORDS, "Philips Hue")
    assert failed["errors"] == {"base": "The bridge didn't see its button pressed. Press it, then tap \"I've pressed it\" within 30 seconds."}

    done = pb.shape_flow(HUE_DONE, HUE_WORDS, "Philips Hue")
    assert (done["kind"], done["title"], done["entry_id"]) == ("done", "Hue Bridge 1a2b3c", "e-hue")


def test_a_sign_in_step_draws_its_fields_and_never_echoes_a_secret():
    step = pb.shape_flow(LOGIN, LOGIN_WORDS, "Acme")
    assert step["text"] == "Sign in at https://acme.example first." and step["last"] is True
    assert step["errors"] == {"base": "That sign-in wasn't accepted. Check the details and try again."}
    by = {f["name"]: f for f in step["fields"]}
    assert by["username"] == {"name": "username", "label": "Email", "required": True, "type": "text", "default": "sam@example.com"}
    assert by["password"]["type"] == "password" and "default" not in by["password"]
    assert by["api_token"]["type"] == "password" and "default" not in by["api_token"]  # by its name
    assert by["region"]["type"] == "select" and by["region"]["options"] == [{"value": "eu", "label": "Europe"}, {"value": "us", "label": "America"}]
    assert (by["scan_interval"]["type"], by["scan_interval"]["min"], by["scan_interval"]["max"], by["scan_interval"]["step"]) == ("number", 5, 300, 1)
    assert by["use_tls"]["type"] == "bool" and by["use_tls"]["default"] is True
    assert by["where"]["type"] == "unsupported"


def test_stops_menus_waits_and_other_websites():
    stopped = pb.shape_flow({"type": "abort", "flow_id": "x", "handler": "hue", "reason": "already_configured"}, HUE_WORDS, "Philips Hue")
    assert (stopped["kind"], stopped["text"]) == ("stopped", "This is already added to your home.")
    assert pb.shape_flow({"type": "abort", "flow_id": "x", "handler": "zzz", "reason": "no_devices_found"}, {}, "Zzz")["text"] == "Nothing was found on your network. Check it's switched on and on the same network as this home."
    menu = pb.shape_flow({"type": "menu", "flow_id": "m", "handler": "zzz", "step_id": "user", "menu_options": ["cloud", "local_network"]}, {"component.zzz.config.step.user.menu_options.cloud": "Sign in"}, "Zzz")
    assert menu["kind"] == "menu" and menu["options"] == [{"value": "cloud", "label": "Sign in"}, {"value": "local_network", "label": "Local network"}]
    assert pb.shape_flow({"type": "external", "flow_id": "o", "handler": "zzz", "step_id": "auth", "url": "https://x"}, {}, "Zzz")["kind"] == "elsewhere"
    assert pb.shape_flow({"type": "show_progress", "flow_id": "p", "handler": "zzz", "step_id": "wait", "progress_action": "pairing"}, {}, "Zzz")["kind"] == "wait"


def test_found_devices_get_a_name_and_brands_put_the_known_ones_first():
    names = {"hue": {"domain": "hue", "name": "Philips Hue", "iot_class": "local_push"}, "tuya": {"domain": "tuya", "name": "Tuya", "iot_class": "cloud_push"}, "pinecil": {"domain": "pinecil", "name": "Pinecil", "iot_class": "local_polling"}, "sun": {"domain": "sun", "name": "Sun"}}
    found = pb.found_one({"flow_id": "f", "handler": "hue", "context": {"source": "zeroconf", "title_placeholders": {"name": "Hue Bridge 1A2B3C"}}}, names, HUE_WORDS)
    assert found == {"flow": "f", "brand": "hue", "brand_name": "Philips Hue", "name": "Hue Bridge 1A2B3C"}
    can = {"hue", "tuya", "pinecil", "sun"}
    first = pb.brands_for(names, can, "")
    assert [b["id"] for b in first] == ["hue", "tuya"] and first[1]["cloud"] is True and first[0]["cloud"] is False
    assert [b["id"] for b in pb.brands_for(names, can, "pin")] == ["pinecil"]
    assert pb.brands_for(names, can, "sun") == []  # housekeeping isn't a brand


def test_actions_become_home_assistant_services():
    assert pb.service_for("light", "set", {"bri": 40, "k": 2700}) == ("light", "turn_on", {"brightness_pct": 40, "color_temp_kelvin": 2700})
    assert pb.service_for("media_player", "volume", 35) == ("media_player", "volume_set", {"volume_level": 0.35})
    assert pb.service_for("lock", "unlock", None) == ("lock", "unlock", {})
    assert pb.service_for("cover", "position", 20) == ("cover", "set_cover_position", {"position": 20})
    # A WiiM favourite by its number: the action its Home Assistant page gives.
    assert pb.service_for("media_player", "preset", 3) == ("media_player", "play_media", {"media_content_type": "music", "media_content_id": "3"})
    assert pb.service_for("sensor", "turn_on", None) is None and pb.service_for("lock", "toggle", None) is None
    assert pb.extras("climate", {"temperature": 21, "current_temperature": 19.5, "hvac_modes": ["off", "heat"], "min_temp": 7, "max_temp": 35}) == {"target": 21, "cur": 19.5, "min": 7, "max": 35, "modes": ["off", "heat"], "can": []}
    assert pb.extras("media_player", {"volume_level": 0.4, "media_title": "Song", "is_volume_muted": False}) == {"vol": 40, "title": "Song", "muted": False, "can": []}


def test_a_server_on_this_machine_is_reached_through_the_host():
    assert pb.server_from_here("http://localhost:8091", in_container=True) == "http://host.docker.internal:8091"
    assert pb.server_from_here("http://localhost:8091", in_container=False) == "http://localhost:8091"
    assert pb.server_from_here("https://promptly.example.org", in_container=True) == "https://promptly.example.org"


def test_brands_under_a_maker_are_found_by_their_own_id():
    flat = pb.flat_brands({
        "core": {
            "integration": {
                "philips": {"name": "Philips", "integrations": {"hue": {"name": "Philips Hue", "config_flow": True, "iot_class": "local_push"}}},
                "tuya": {"name": "Tuya", "config_flow": True, "iot_class": "cloud_push"},
            },
            "helper": {"group": {"name": "Group", "config_flow": True}},
            "translated_name": ["sun"],
        },
        "custom": {"integration": {}, "helper": {}},
    })
    assert flat["hue"]["name"] == "Philips Hue" and flat["tuya"]["iot_class"] == "cloud_push" and "group" in flat
    assert pb.brands_for(flat, {"hue", "tuya"}, "")[1]["cloud"] is True


# ------------------------------------------------------------------ the bundled Home Assistant's settings


def _ha_config():
    here = Path(__file__).resolve()
    for root in (os.environ.get("HOME_BOX_DIR"), here.parents[2] / "home-box", Path("/home-box")):
        path = Path(root) / "ha_config.py" if root else None
        if path and path.exists():
            spec = importlib.util.spec_from_file_location("ha_config", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    pytest.skip("home-box/ha_config.py isn't mounted here")


def test_its_web_server_setting_is_written_as_confirmed_not_on_trial(tmp_path, monkeypatch):
    """Home Assistant reverts an unconfirmed web setting after five minutes
    (to every address, port 8123). Ours is written as the confirmed one."""
    import json

    hc = _ha_config()
    monkeypatch.setenv("HOME_HA_BIND", "127.0.0.1")
    monkeypatch.setenv("HOME_HA_PORT", "8137")
    hc.main(str(tmp_path))
    data = json.loads((tmp_path / ".storage" / "http").read_text())["data"]
    assert (data["stable"]["server_host"], data["stable"]["server_port"], data["pending"], data["yaml_migration_done"]) == (["127.0.0.1"], 8137, None, True)
    yaml = (tmp_path / "configuration.yaml").read_text()
    assert "zeroconf:" in yaml and "ssdp:" in yaml and "default_config" not in yaml.replace("``default_config``", "") and "http:" not in yaml

    # What Home Assistant left after a failed trial: back to ours, the rest kept.
    left = {"version": 3, "minor_version": 1, "key": "http", "data": {
        "stable": {"server_port": 8123, "cors_allowed_origins": ["https://x"], "ssl_profile": "intermediate_v6", "error": None},
        "pending": {"server_port": 8137, "server_host": ["127.0.0.1"], "error": "not_promoted"},
        "yaml_migration_done": True,
    }}
    (tmp_path / ".storage" / "http").write_text(json.dumps(left))
    monkeypatch.setenv("HOME_HA_PORT", "8200")
    hc.main(str(tmp_path))
    data = json.loads((tmp_path / ".storage" / "http").read_text())["data"]
    assert (data["stable"]["server_host"], data["stable"]["server_port"], data["pending"]) == (["127.0.0.1"], 8200, None)
    assert data["stable"]["cors_allowed_origins"] == ["https://x"]

    # Somebody's own configuration.yaml is left alone, and so are their web settings.
    other = tmp_path / "theirs"
    other.mkdir()
    (other / "configuration.yaml").write_text("default_config:\n")
    hc.main(str(other))
    assert (other / "configuration.yaml").read_text() == "default_config:\n" and not (other / ".storage").exists()


def test_the_bundled_box_uses_the_deployments_secret_and_goes_where_its_told(monkeypatch):
    monkeypatch.setenv("PROMPTLY_BUILTIN_KEY", "k" * 64)
    monkeypatch.setenv("PROMPTLY_SERVER", "http://127.0.0.1:8087/")
    assert pb.read_setup() == {"server": "http://127.0.0.1:8087", "box": "b0000000-0000-4000-8000-00000000b0c5", "key": "k" * 64}
    monkeypatch.setenv("PROMPTLY_BUILTIN_KEY", "")
    with pytest.raises(SystemExit):
        pb.read_setup()


# ------------------------------------------------------------------ first real hardware: Hue, rooms, what added itself


def test_the_hue_button_step_says_which_button_and_how_long():
    step = pb.shape_flow(HUE_LINK, HUE_WORDS, "Philips Hue")
    assert step["title"] == "Link your Hue bridge" and step["button"] == "I've pressed it"
    assert "big round button on top" in step["text"] and "30 seconds" in step["text"] and "Home Assistant" not in step["text"]
    failed = pb.shape_flow(HUE_LINK_FAILED, HUE_WORDS, "Philips Hue")
    assert failed["errors"] == {"base": "The bridge didn't see its button pressed. Press it, then tap \"I've pressed it\" within 30 seconds."}
    # A step we have no button for of our own.
    assert "button" not in pb.shape_flow(HUE_MANUAL, HUE_WORDS, "Philips Hue")


def test_common_errors_and_stops_are_in_plain_words_for_any_brand():
    form = {"type": "form", "flow_id": "f", "handler": "shelly", "step_id": "user", "data_schema": [{"type": "string", "name": "host", "required": True}], "errors": {"base": "cannot_connect", "host": "invalid_host"}}
    words = {"component.shelly.config.error.cannot_connect": "Failed to connect", "component.shelly.config.error.custom_thing": "Shelly's own words"}
    got = pb.shape_flow(form, words, "Shelly")["errors"]
    assert got["base"].startswith("Couldn't reach it.") and "192.168" in got["host"]
    form["errors"] = {"base": "invalid_auth"}
    assert "sign-in wasn't accepted" in pb.shape_flow(form, words, "Shelly")["errors"]["base"]
    form["errors"] = {"base": "custom_thing"}  # not ours: the brand's
    assert pb.shape_flow(form, words, "Shelly")["errors"]["base"] == "Shelly's own words"
    form["errors"] = {"base": "weird_code"}  # nobody's
    assert pb.shape_flow(form, words, "Shelly")["errors"]["base"] == "Weird code"
    stop = pb.shape_flow({"type": "abort", "flow_id": "f", "handler": "shelly", "reason": "already_configured"}, words, "Shelly")
    assert (stop["kind"], stop["text"]) == ("stopped", "This is already added to your home.")
    assert pb.shape_flow({"type": "abort", "flow_id": "f", "handler": "hue", "reason": "no_bridges"}, {}, "Philips Hue")["text"].startswith("No Hue bridge was found")


# What Home Assistant holds after a real Hue bridge is linked (shapes from its
# Hue integration: the bridge, a lamp, and Hue's own room, which it lists as a
# "service" device carrying one grouped light).
HUE_DEVICES = [
    {"id": "d-bridge", "config_entry_id": "e-hue", "config_entries": ["e-hue"], "name": "Hue Bridge", "model": "BSB002", "manufacturer": "Signify", "area_id": "lounge_room", "via_device_id": None, "entry_type": None, "name_by_user": None},
    {"id": "d-lamp", "config_entry_id": "e-hue", "config_entries": ["e-hue"], "name": "Living room lamp", "model": "Hue white lamp", "area_id": "lounge_room", "via_device_id": "d-bridge", "entry_type": None, "name_by_user": None},
    {"id": "d-room", "config_entry_id": "e-hue", "config_entries": ["e-hue"], "name": "Lounge Room", "model": "Room", "area_id": "lounge_room", "via_device_id": "d-bridge", "entry_type": "service", "name_by_user": None},
    {"id": "d-cast", "config_entry_id": "e-cast", "config_entries": ["e-cast"], "name": "Kitchen Speaker", "model": "Nest Mini", "area_id": None, "via_device_id": None, "entry_type": None, "name_by_user": None},
]
HUE_REGISTRY = [
    {"entity_id": "light.living_room_lamp", "device_id": "d-lamp", "platform": "hue"},
    {"entity_id": "sensor.living_room_lamp_zigbee", "device_id": "d-lamp", "platform": "hue", "entity_category": "diagnostic"},
    {"entity_id": "light.lounge_room", "device_id": "d-room", "platform": "hue"},
    {"entity_id": "scene.lounge_room_relax", "device_id": "d-room", "platform": "hue"},
    {"entity_id": "switch.automation_wake_up", "device_id": "d-bridge", "platform": "hue", "entity_category": "config"},
    {"entity_id": "media_player.kitchen_speaker", "device_id": "d-cast", "platform": "cast"},
]
HUE_ROOM_ATTRS = {"is_hue_group": True, "hue_type": "room", "lights": ["Living room lamp"], "entity_id": ["light.living_room_lamp"], "friendly_name": "Lounge Room"}


def test_a_brands_own_room_is_not_a_device_and_neither_is_its_bridge():
    """Hue's "Lounge Room" and the bridge itself: no tile, no questions."""
    assert pb.brand_group("light", HUE_ROOM_ATTRS) == {"members": ["light.living_room_lamp"], "kind": "room"}
    assert pb.brand_group("light", {"entity_id": ["light.a", "light.b"]})["kind"] == "group"  # a light group made in Home Assistant
    assert pb.brand_group("light", {"brightness": 200}) is None and pb.brand_group("switch", HUE_ROOM_ATTRS) is None

    got = pb.brought("e-hue", HUE_DEVICES, HUE_REGISTRY, {"light.lounge_room"}, {"lounge_room": "Lounge Room"})
    assert got["things"] == [{"device_id": "d-lamp", "name": "Living room lamp", "kind": "light", "area": "lounge_room"}]
    assert got["summary"] == [{"n": 1, "kind": "light", "room": "Lounge Room"}] and got["loose"] == 0
    # Something that came with no room is counted, to offer sorting later.
    cast = pb.brought("e-cast", HUE_DEVICES, HUE_REGISTRY, set(), {})
    assert cast["summary"] == [{"n": 1, "kind": "media_player", "room": ""}] and cast["loose"] == 1


def test_a_group_entity_never_reaches_the_page_as_a_tile():
    ha = pb.HomeAssistant(session=None)
    ha._area_of = {"light.lounge_room": "lounge_room", "light.living_room_lamp": "lounge_room"}
    ha._device_of = {"media_player.downstairs": "d-grp", "media_player.kitchen_speaker": "d-cast"}
    ha._model_of = {"d-grp": "Google Cast Group", "d-cast": "Nest Mini"}
    assert ha._entity({"entity_id": "light.lounge_room", "state": "on", "attributes": HUE_ROOM_ATTRS}) is None
    assert ha.groups["light.lounge_room"] == {"members": ["light.living_room_lamp"], "kind": "room", "area": "lounge_room"}
    lamp = ha._entity({"entity_id": "light.living_room_lamp", "state": "on", "attributes": {"brightness": 128}})
    assert lamp["area"] == "lounge_room" and "grp" not in lamp
    group = ha._entity({"entity_id": "media_player.downstairs", "state": "off", "attributes": {"device_class": "speaker"}})
    one = ha._entity({"entity_id": "media_player.kitchen_speaker", "state": "off", "attributes": {"device_class": "speaker"}})
    assert group["grp"] is True and group["dev"] == "d-grp" and "grp" not in one and one["cls"] == "speaker"


def test_a_rooms_lights_use_the_brands_group_only_when_it_is_exactly_that_room():
    groups = {"light.lounge_room": {"members": ["light.a", "light.b"], "kind": "room"}, "light.downstairs": {"members": ["light.a", "light.b", "light.c"], "kind": "zone"}}
    assert pb.lights_target(["light.b", "light.a"], groups) == ["light.lounge_room"]
    assert pb.lights_target(["light.a"], groups) == ["light.a"]  # one was moved out in Promptly: each light, not Hue's room
    assert pb.lights_target(["light.a", "light.b", "light.d"], groups) == ["light.a", "light.b", "light.d"]


# What added itself: Google Cast, found before the box had finished its own
# first start (Home Assistant sets those up without asking).
ENTRIES = [
    {"entry_id": "e-cast", "domain": "cast", "source": "zeroconf", "created_at": 1000.0},
    {"entry_id": "e-hue", "domain": "hue", "source": "user", "created_at": 5000.0},
    {"entry_id": "e-wiz", "domain": "wiz", "source": "dhcp", "created_at": 6000.0},  # from "Found on your network", later
    {"entry_id": "e-met", "domain": "met", "source": "onboarding", "created_at": 1000.0},
    {"entry_id": "e-sun", "domain": "sun", "source": "import", "created_at": 1000.0},
]


def test_what_nobody_chose_goes_back_to_found_and_what_they_chose_stays():
    chosen = pb.first_chosen(ENTRIES, HUE_DEVICES, onboarded_at=1005.0)
    assert chosen == {"e-hue", "e-wiz", "e-met", "e-sun"}
    assert [e["entry_id"] for e in pb.uninvited(ENTRIES, chosen)] == ["e-cast"]
    # Someone named a speaker or put it in a room: it's theirs now, and stays.
    for touch in ({"name_by_user": "Kitchen"}, {"area_id": "kitchen"}):
        devices = [{**d, **touch} if d["id"] == "d-cast" else d for d in HUE_DEVICES]
        assert pb.uninvited(ENTRIES, pb.first_chosen(ENTRIES, devices, onboarded_at=1005.0)) == []
    # A box whose first start we can't date keeps everything.
    assert pb.uninvited(ENTRIES, pb.first_chosen(ENTRIES, HUE_DEVICES, onboarded_at=None)) == []


def test_an_entry_in_a_home_without_anyone_adding_it_is_caught():
    """The rule itself: from now on, a set-up that came from the network and
    that no one tapped Add for is never left in the home."""
    chosen = {"e-hue"}
    later = [*ENTRIES[:2], {"entry_id": "e-sonos", "domain": "sonos", "source": "ssdp", "created_at": 9000.0}]
    assert {e["entry_id"] for e in pb.uninvited(later, chosen)} == {"e-cast", "e-sonos"}
    for source in ("zeroconf", "ssdp", "dhcp", "homekit", "usb", "bluetooth"):
        assert pb.uninvited([{"entry_id": "x", "domain": "anything", "source": source}], set()), source
    for source in ("user", "import", "reauth", "system", "ignore"):
        assert not pb.uninvited([{"entry_id": "x", "domain": "anything", "source": source}], set()), source


def test_it_looks_for_devices_only_once_it_has_its_own_account(tmp_path, monkeypatch):
    """Before that, Home Assistant sets up what it finds without asking."""
    import json

    hc = _ha_config()
    hc.main(str(tmp_path), hooked=True)
    yaml = (tmp_path / "configuration.yaml").read_text()
    assert "zeroconf:" not in yaml and "ssdp:" not in yaml and "dhcp:" not in yaml and "frontend:" in yaml
    (tmp_path / ".storage" / "onboarding").write_text(json.dumps({"version": 4, "key": "onboarding", "data": {"done": ["user", "core_config"]}}))
    hc.main(str(tmp_path), hooked=True)
    assert "zeroconf:" not in (tmp_path / "configuration.yaml").read_text()  # half-way isn't done
    (tmp_path / ".storage" / "onboarding").write_text(json.dumps({"version": 4, "key": "onboarding", "data": {"done": ["user", "core_config", "analytics", "integration"]}}))
    hc.main(str(tmp_path), hooked=True)
    yaml = (tmp_path / "configuration.yaml").read_text()
    assert "zeroconf:" in yaml and "ssdp:" in yaml and "dhcp:" in yaml

    # The hook: this script runs before every start of Home Assistant, once only.
    run = tmp_path / "run"
    run.write_text("#!/usr/bin/with-contenv bashio\ncd /config\nexec python3 -P -m homeassistant --config /config\n")
    assert hc.install_hook(str(run)) and hc.install_hook(str(run))
    lines = run.read_text().split("\n")
    assert lines.count(hc.HOOK) == 1 and lines.index(hc.HOOK) == lines.index("exec python3 -P -m homeassistant --config /config") - 1
    # No such script (a different image): it says so, and the looking stays on.
    assert hc.install_hook(str(tmp_path / "nope")) is False


def test_only_what_add_a_device_offers_can_be_started():
    """The page only asks for brands it was offered. Anything else asking
    (Home Assistant's own tools that fetch an address, open a database or
    read a file) is turned away, and never offered by a search either."""
    names = {
        "hue": {"domain": "hue", "name": "Philips Hue"},
        "acme": {"domain": "acme", "name": "Acme Plugs", "integration_type": "hub"},
        "scrape": {"domain": "scrape", "name": "Scrape"},
        "sql": {"domain": "sql", "name": "SQL"},
        "ping": {"domain": "ping", "name": "Ping (ICMP)"},
        "template": {"domain": "template", "name": "Template", "integration_type": "helper"},
        "sun": {"domain": "sun", "name": "Sun"},
    }
    can = set(names) | {"file"}
    assert pb.can_start("hue", names, can) and pb.can_start("acme", names, can)
    for tool in ("scrape", "sql", "ping", "file", "template", "sun", "", "not_a_brand"):
        assert not pb.can_start(tool, names, can), tool
    assert not pb.can_start("hue", names, {"acme"})  # this Home Assistant can't set it up
    for q in ("s", "p", "scrape", "sql", "ping", "template"):
        assert all(pb.can_start(b["id"], names, can) for b in pb.brands_for(names, can, q))
    assert [b["id"] for b in pb.brands_for(names, can, "sql")] == []


# ------------------------------------------------------------------ every kind of device (Home phase 2, stage 1)

# As Home Assistant 2026.11 reports an AirTouch 5: one unit, a "thermostat" per zone.
AT5_AC = {"hvac_modes": ["off", "auto", "cool", "dry", "fan_only", "heat"], "min_temp": 16, "max_temp": 30, "target_temp_step": 1, "fan_modes": ["low", "medium", "high", "auto"], "current_temperature": 26, "temperature": 23, "fan_mode": "auto", "supported_features": 393}
AT5_ZONE = {"hvac_modes": ["off", "fan_only"], "min_temp": 16, "max_temp": 30, "preset_modes": ["none", "boost"], "current_temperature": 24, "temperature": 22, "supported_features": 401}
# A WiiM speaker playing.
WIIM = {"volume_level": 0.3, "is_volume_muted": False, "media_title": "Song", "media_artist": "Band", "source": "Wi-Fi", "source_list": ["Wi-Fi", "Line In", "Bluetooth"], "group_members": ["media_player.kitchen"], "entity_picture": "https://cdn.example/cover.jpg", "device_class": "speaker", "supported_features": 1 | 2 | 4 | 8 | 32 | 512 | 2048 | 4096 | 16384 | 131072 | 524288}


def test_air_con_says_what_it_can_do_and_its_fan_speeds():
    x = pb.extras("climate", AT5_AC)
    assert x["can"] == ["temp", "fan", "off", "on"] and x["fans"] == ["low", "medium", "high", "auto"] and x["fan"] == "auto" and x["step"] == 1
    assert pb.extras("climate", AT5_ZONE)["can"] == ["temp", "off", "on"] and "fans" not in pb.extras("climate", AT5_ZONE)


def test_a_ducted_systems_zones_are_told_apart_from_its_unit():
    got = pb.zones_of({
        "climate.ac_0": ("e1", AT5_AC["hvac_modes"]), "climate.bedroom": ("e1", ["off", "fan_only"]), "climate.lounge": ("e1", ["off", "fan_only"]),
        "climate.heater": ("e2", ["off", "heat"]),  # something else entirely: left alone
        "climate.a": ("e3", ["off", "cool"]), "climate.b": ("e3", ["off", "cool"]),  # two split systems from one brand: both units
        "climate.loose": ("", ["off", "fan_only"]),
    })
    assert got == {"climate.ac_0": {"sys": "climate.ac_0"}, "climate.bedroom": {"sys": "climate.ac_0", "zone": True}, "climate.lounge": {"sys": "climate.ac_0", "zone": True}}


def test_turning_air_con_on_is_the_way_it_was_not_its_first_mode():
    modes = AT5_AC["hvac_modes"]
    x = {"modes": modes, "can": ["temp", "fan", "off", "on"]}
    # Home Assistant's own turn-on would pick heat (it tries heat before cool).
    assert pb.service_for("climate", "turn_on", None, x, "cool") == ("climate", "set_hvac_mode", {"hvac_mode": "cool"})
    assert pb.service_for("climate", "turn_on", None, x, "dry") == ("climate", "set_hvac_mode", {"hvac_mode": "dry"})
    # Nothing remembered, or a mode it no longer has: let the unit decide (auto), never plain "turn on".
    assert pb.service_for("climate", "turn_on", None, x, None) == ("climate", "set_hvac_mode", {"hvac_mode": "auto"})
    assert pb.service_for("climate", "turn_on", None, x, "heat_cool") == ("climate", "set_hvac_mode", {"hvac_mode": "auto"})
    assert pb.service_for("climate", "turn_on", None, {"modes": ["off", "heat", "cool"]}, None) == ("climate", "set_hvac_mode", {"hvac_mode": "cool"})
    # A zone only has "on".
    assert pb.service_for("climate", "turn_on", None, {"modes": ["off", "fan_only"]}, None) == ("climate", "set_hvac_mode", {"hvac_mode": "fan_only"})
    assert pb.service_for("climate", "turn_off", None, x, "cool") == ("climate", "set_hvac_mode", {"hvac_mode": "off"})
    assert pb.service_for("climate", "turn_off", None, {"modes": ["heat"]}, None) == ("climate", "turn_off", {})
    assert pb.service_for("climate", "fan", "high", x) == ("climate", "set_fan_mode", {"fan_mode": "high"})


def test_a_speaker_says_what_is_playing_and_what_it_can_do():
    x = pb.extras("media_player", WIIM)
    assert x["can"] == ["pause", "vol", "mute", "next", "src", "stop", "play", "group"]  # no "previous", no power button
    assert (x["title"], x["artist"], x["src"], x["vol"], x["muted"]) == ("Song", "Band", "Wi-Fi", 30, False)
    assert x["srcs"] == ["Wi-Fi", "Line In", "Bluetooth"] and x["members"] == ["media_player.kitchen"]
    # The picture's address never leaves the box: only a mark that changes when the picture does.
    assert len(x["art"]) == 12 and "cdn.example" not in str(x)
    assert x["art"] != pb.extras("media_player", {**WIIM, "entity_picture": "https://cdn.example/other.jpg"})["art"]
    assert pb.service_for("media_player", "next", None) == ("media_player", "media_next_track", {})
    assert pb.service_for("media_player", "mute", True) == ("media_player", "volume_mute", {"is_volume_muted": True})
    assert pb.service_for("media_player", "source", "Line In") == ("media_player", "select_source", {"source": "Line In"})
    assert pb.service_for("media_player", "join", ["media_player.lounge"]) == ("media_player", "join", {"group_members": ["media_player.lounge"]})
    assert pb.service_for("media_player", "unjoin", None) == ("media_player", "unjoin", {})
    assert pb.service_for("media_player", "turn_off", None) == ("media_player", "turn_off", {})


def test_the_other_kinds_have_their_own_few_actions():
    assert pb.service_for("vacuum", "dock", None) == ("vacuum", "return_to_base", {})
    assert pb.service_for("vacuum", "start", None) == ("vacuum", "start", {})
    assert pb.service_for("scene", "run", None) == ("scene", "turn_on", {})
    assert pb.service_for("fan", "oscillate", True) == ("fan", "oscillate", {"oscillating": True})
    assert pb.service_for("valve", "close", None) == ("valve", "close_valve", {})
    assert pb.service_for("humidifier", "turn_on", None) == ("homeassistant", "turn_on", {})
    assert pb.service_for("lawn_mower", "start", None) is None and pb.service_for("siren", "turn_on", None) is None
    assert pb.extras("vacuum", {"battery_level": 80, "supported_features": 4 | 16 | 8192}) == {"bat": 80, "can": ["pause", "dock", "start"]}
    assert pb.extras("cover", {"current_position": 40, "supported_features": 15})["can"] == ["open", "close", "pos", "stop"]
    assert pb.extras("fan", {"percentage": 33, "oscillating": False, "supported_features": 1}) == {"pct": 33, "osc": False, "can": ["speed"]}


def test_any_kind_of_device_is_shown_but_not_home_assistants_odds_and_ends():
    for kind in ("light", "climate", "media_player", "vacuum", "scene", "lawn_mower", "water_heater", "alarm_control_panel", "siren", "something_new"):
        assert pb.shown(kind), kind
    for kind in ("automation", "update", "person", "zone", "button", "number", "select", "tts", "camera", "device_tracker", ""):
        assert not pb.shown(kind), kind


def test_a_brand_that_signs_in_on_its_makers_website_says_it_is_not_supported_yet():
    for reason in ("missing_credentials", "missing_configuration", "oauth_error", "no_url_available", "authorize_url_timeout"):
        stopped = pb.shape_flow({"type": "abort", "flow_id": "f", "handler": "nest", "reason": reason}, {}, "Google Nest")
        assert stopped["kind"] == "stopped" and "doesn't support yet" in stopped["text"], reason
    away = pb.shape_flow({"type": "external", "flow_id": "f", "handler": "spotify", "step_id": "auth", "url": "https://accounts.example/authorize"}, {}, "Spotify")
    assert away["kind"] == "elsewhere" and "doesn't support yet" in away["text"] and "accounts.example" not in str(away)


def test_wiim_and_airtouch_ask_for_an_address_in_plain_words():
    host = [{"type": "string", "name": "host", "required": True}]
    words = {"component.wiim.config.step.user.data.host": "Host", "component.wiim.config.step.user.data_description.host": "The hostname or IP address of the WiiM device."}
    step = pb.shape_flow({"type": "form", "flow_id": "f", "handler": "wiim", "step_id": "user", "data_schema": host, "errors": {}}, words, "WiiM")
    assert step["title"] == "Your WiiM's address" and "WiiM Home app" in step["text"] and step["fields"][0]["type"] == "text"
    step = pb.shape_flow({"type": "form", "flow_id": "f", "handler": "airtouch5", "step_id": "user", "data_schema": host, "errors": {"base": "cannot_connect"}}, {}, "AirTouch 5")
    assert step["title"] == "Your AirTouch 5's address" and step["errors"]["base"].startswith("Couldn't reach it")
    assert step["fields"][0]["label"] == "Address"  # not "Host"
    assert {"wiim", "airtouch5"} <= {b[0] for b in pb.BRANDS}
    # Google Nest starts by sending you off to make a developer project: said plainly instead.
    nest = pb.shape_flow({"type": "form", "flow_id": "f", "handler": "nest", "step_id": "create_cloud_project", "data_schema": [], "errors": {}}, {}, "Google Nest")
    assert nest["kind"] == "elsewhere" and "doesn't support yet" in nest["text"]


def test_the_server_and_the_box_agree_on_what_is_nobodys_device():
    from app.home import relay

    assert relay.NEVER == pb.HIDDEN


def test_only_a_speaker_that_keeps_numbered_favourites_can_be_asked_for_one():
    from app.home import relay

    wiim = {"id": "media_player.a", "domain": "media_player", "x": {"can": ["play", "preset"]}}
    cast = {"id": "media_player.b", "domain": "media_player", "x": {"can": ["play"]}}
    old = {"id": "media_player.c", "domain": "media_player"}
    assert relay.can_do(wiim, "preset") and not relay.can_do(cast, "preset") and not relay.can_do(old, "preset")
    assert relay.clean_value("media_player", "preset", 4, wiim) == 4
    for bad in (0, 21, "3", True, None):
        with pytest.raises(ValueError):
            relay.clean_value("media_player", "preset", bad, wiim)
    assert "wiim" in pb.PRESET_BRANDS


# ---------------------------------------------------------------- music by name
# As Music Assistant 2.10 answers ``players/all`` (trimmed).
MA_WIIM = {"player_id": "wiim_uuid:FF31F09E-5C5A-4D8A-A1B2-AAAA00001111", "type": "player", "name": "Lounge", "available": True, "enabled": True, "device_info": {"identifiers": {"ip_address": "192.168.1.40", "mac_address": "AA:BB:CC:00:11:22"}}}
MA_AIRPLAY = {"player_id": "upd3a7a53b", "type": "player", "name": "Kitchen Speaker", "display_name": "Kitchen Speaker", "available": True, "enabled": True, "device_info": {"identifiers": {"mac_address": "9A:57:73:5F:CF:2C", "ip_address": "192.168.1.41", "airplay_id": "ap9a57735fcf2c"}}}
MA_STRANGER = {"player_id": "cc_neighbours_tv", "type": "player", "name": "Next door's TV", "available": True, "enabled": True, "device_info": {"identifiers": {"ip_address": "192.168.1.99"}}}


def test_a_speaker_is_recognised_by_its_own_id_then_its_card_address_or_name():
    # As Home Assistant's WiiM integration registers one: its UPnP id, and its address as a link.
    wiim = pb.speaker_facts(
        {"identifiers": [["wiim", "uuid:FF31F09E-5C5A-4D8A-A1B2-AAAA00001111"]], "connections": [], "configuration_url": "http://192.168.1.40", "name": "WiiM Pro", "name_by_user": "Lounge speaker"},
        {"unique_id": "uuid:FF31F09E-5C5A-4D8A-A1B2-AAAA00001111", "platform": "wiim"},
    )
    assert wiim == {"name": "Lounge speaker", "idents": ["ff31f09e5c5a4d8aa1b2aaaa00001111"], "macs": [], "ip": "192.168.1.40", "brand": "wiim"}
    by_mac = {"name": "Kitchen", "idents": [], "macs": ["9a57735fcf2c"], "ip": "", "brand": "apple_tv"}
    by_ip = {"name": "Study", "idents": [], "macs": [], "ip": "192.168.1.41", "brand": "dlna_dmr"}
    by_name = {"name": "kitchen speaker!", "idents": [], "macs": [], "ip": "", "brand": "cast"}
    players = [MA_WIIM, MA_AIRPLAY, MA_STRANGER]
    assert pb.music_map({"media_player.lounge": wiim}, players) == {"media_player.lounge": MA_WIIM["player_id"]}
    assert pb.music_map({"media_player.k": by_mac}, players) == {"media_player.k": "upd3a7a53b"}
    assert pb.music_map({"media_player.s": by_ip}, players) == {"media_player.s": "upd3a7a53b"}
    assert pb.music_map({"media_player.k": by_name}, players) == {"media_player.k": "upd3a7a53b"}
    # Nobody's speaker here is never played to, whatever Music Assistant can see.
    assert "cc_neighbours_tv" not in pb.music_map({"media_player.lounge": wiim, "media_player.k": by_mac}, players).values()
    assert pb.music_map({}, players) == {}


def test_a_name_two_speakers_share_matches_neither():
    one = {"name": "Speaker", "idents": [], "macs": [], "ip": "", "brand": "cast"}
    players = [{**MA_AIRPLAY, "name": "Speaker", "display_name": "Speaker"}]
    assert pb.music_map({"media_player.a": one, "media_player.b": dict(one)}, players) == {}
    twins = [{**MA_AIRPLAY, "name": "Speaker", "display_name": "Speaker"}, {**MA_STRANGER, "name": "Speaker"}]
    assert pb.music_map({"media_player.a": one}, twins) == {}
    # Switched off or gone in Music Assistant: not played to.
    assert pb.music_map({"media_player.a": {**one, "name": "Kitchen Speaker"}}, [{**MA_AIRPLAY, "enabled": False}]) == {}
    # One player is one speaker: a second speaker can't claim it too.
    same = {"name": "x", "idents": [], "macs": ["9a57735fcf2c"], "ip": "", "brand": "cast"}
    assert pb.music_map({"media_player.a": same, "media_player.b": dict(same)}, [MA_AIRPLAY]) == {"media_player.a": "upd3a7a53b"}


def test_music_assistant_only_gets_the_ways_of_playing_the_homes_speakers_need():
    assert pb.wanted_players({"wiim", "hue", "demo"}, set()) == {"wiim"}
    assert pb.wanted_players({"cast", "sonos", "linkplay"}, set()) == {"chromecast", "sonos", "wiim"}
    assert pb.wanted_players(set(), set()) == set()  # no speakers: it looks for nothing
    assert pb.wanted_players(set(), {"airplay", "radiobrowser"}) == {"airplay"}


def test_only_a_search_results_own_name_can_be_played():
    assert pb.music_uri("tidal://album/1234", {"tidal"}) == ("tidal", "album")
    assert pb.music_uri("tidal--Ab12Cd://track/99", {"tidal"}) == ("tidal--Ab12Cd", "track")
    assert pb.music_uri("library://artist/7", {"tidal"}) == ("library", "artist")
    for bad in (
        "http://169.254.169.254/latest", "https://example.com/a.mp3", "file:///etc/passwd", "builtin://track/http%3A%2F%2Fx",
        "tidal://album/1 2", "tidal://album/1?x=1", "tidal://album/", "tidal://station/1", "spotify://track/1", "", None, 5,
        "tidal://track//etc", "TIDAL://track/1",
    ):
        assert pb.music_uri(bad, {"tidal"}) is None, bad
    assert pb.music_uri("tidal://album/1", set()) is None  # nothing linked


def test_search_answers_are_cut_to_a_short_plain_list():
    found = {
        "artists": [{"uri": "tidal://artist/100", "name": "Miles Davis", "media_type": "artist", "provider_mappings": [{"provider_domain": "tidal"}], "metadata": {"images": ["…"]}}],
        "albums": [
            {"uri": "tidal://album/200", "name": "Kind of Blue", "version": "Legacy Edition", "artists": [{"name": "Miles Davis"}], "provider_mappings": [{"provider_domain": "tidal"}]},
            {"uri": "library://album/3", "name": "From a source nobody linked", "provider_mappings": [{"provider_domain": "filesystem_local"}]},
            {"uri": "library://album/4", "name": "In the library, from Tidal", "provider_mappings": [{"provider_domain": "tidal"}]},
        ],
        "tracks": [{"uri": "tidal://track/300", "name": "So What", "artists": [{"name": "Miles Davis"}, {"name": "John Coltrane"}], "album": {"name": "Kind of Blue"}}],
        "playlists": [{"uri": "tidal://playlist/abc-1", "name": "Miles Davis Essentials", "owner": "TIDAL"}],
        "radio": [{"uri": "radiobrowser://radio/1", "name": "Jazz FM"}, {"uri": "http://stream.example/jazz", "name": "A bare address"}],
    }
    got = pb.shape_results(found, ["artist", "album", "track", "playlist", "radio"], {"tidal"}, 5)
    assert got == [
        {"uri": "tidal://artist/100", "kind": "artist", "name": "Miles Davis"},
        {"uri": "tidal://album/200", "kind": "album", "name": "Kind of Blue", "artist": "Miles Davis", "version": "Legacy Edition"},
        {"uri": "library://album/4", "kind": "album", "name": "In the library, from Tidal"},
        {"uri": "tidal://track/300", "kind": "track", "name": "So What", "artist": "Miles Davis, John Coltrane", "album": "Kind of Blue"},
        {"uri": "tidal://playlist/abc-1", "kind": "playlist", "name": "Miles Davis Essentials", "by": "TIDAL"},
    ]
    assert len(pb.shape_results({"tracks": [{"uri": f"tidal://track/{i}", "name": f"T{i}"} for i in range(30)]}, ["track"], {"tidal"}, 5)) == 5
    assert pb.shape_results(None, ["track"], {"tidal"}, 5) == [] and pb.shape_results("x", ["track"], {"tidal"}, 5) == []


def test_linking_an_account_is_a_page_to_open_a_code_and_then_done():
    # As Music Assistant 2.10 answers ``config/providers/setup`` for Tidal.
    step = {
        "flow_id": "b810c74ef6674117971a2c0a5fd6a2d3", "step_id": "device_login", "type": "external", "title": "Link your Tidal account",
        "description": "Your code is FKGQW. Use the button below to open Tidal…", "entries": [], "errors": {}, "url": "https://link.tidal.com/FKGQW",
        "expires_at": 1794878617.5173671, "result": None, "reason": None,
    }
    assert pb.shape_link(step, "tidal") == {
        "state": "open", "brand": "tidal", "name": "Tidal", "flow": "b810c74ef6674117971a2c0a5fd6a2d3",
        "url": "https://link.tidal.com/FKGQW", "code": "FKGQW", "until": 1794878617,
    }
    assert pb.shape_link({"type": "finish", "result": {"instance_id": "tidal--Ab12"}}, "tidal") == {"state": "done", "brand": "tidal", "name": "Tidal"}
    assert pb.shape_link({"type": "progress", "flow_id": "f"}, "tidal")["state"] == "wait"
    assert pb.shape_link(None, "tidal")["state"] == "stopped"
    assert pb.shape_link({"type": "external", "url": "http://plain.example/x"}, "tidal")["state"] == "stopped"
    assert pb.shape_link({"type": "form", "entries": [{"key": "password"}]}, "tidal")["state"] == "stopped"  # never a form to type into
    assert set(pb.MUSIC_BRANDS) == {"tidal"}


def test_the_server_and_the_box_agree_on_what_can_be_linked_and_played():
    from app.home import music, relay

    assert set(pb.MUSIC_BRANDS) == set(music.LINK_HOSTS)
    assert set(pb.MUSIC_KINDS) == set(music.KINDS)
    # A speaker that can play music says so in the same word both ends know.
    e = relay.clean_entity({"id": "media_player.a", "domain": "media_player", "name": "A", "state": "idle", "x": {"can": ["play", "music"]}})
    assert "music" in e["x"]["can"]
    for uri in ("tidal://album/200", "tidal--Ab12Cd://track/99", "library://artist/7"):
        assert pb.music_uri(uri, {"tidal"}) and music.clean_results([{"uri": uri, "kind": uri.split("://")[1].split("/")[0], "name": "x"}])


def test_an_old_box_or_one_without_the_music_service_says_so():
    import asyncio

    ha = pb.HomeAssistant.__new__(pb.HomeAssistant)
    ha.music = None
    with pytest.raises(RuntimeError, match="no music service"):
        asyncio.run(ha.op("music.status", {}))


# ---------------------------------------------------------------- a kind of music, and its own page
class _FakeHA:
    def __init__(self):
        self.music_of = {"media_player.lounge": "upd3a7a53b"}
        self.entities = {"media_player.lounge": {}}
        self.speakers, self.speaker_brands = {}, set()


def _music(answers, base="http://127.0.0.1:8095"):
    """The connector's music side with Music Assistant's answers scripted:
    ``answers[command]`` is a value, an error to raise, or a function of the
    arguments."""
    m = pb.Music(None, _FakeHA(), base)
    m.calls = []

    async def call(command, timeout=30.0, **args):
        m.calls.append((command, args))
        got = answers.get(command)
        if callable(got):
            got = got(args)
        if isinstance(got, Exception):
            raise got
        return got

    m.call = call

    async def sources():
        return [{"id": "tidal--Ab12", "brand": "tidal", "name": "Tidal"}]

    m.sources = sources
    return m


def test_a_mix_is_asked_for_as_music_assistant_wants_it_and_falls_back_to_plain_play():
    import asyncio

    m = _music({"player_queues/play_media": None})
    assert asyncio.run(m.op("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/100", "radio": True})) == {"mix": True}
    assert m.calls == [("player_queues/play_media", {"queue_id": "upd3a7a53b", "media": "radio_playlist://playlist/tidal://artist/100", "option": "replace"})]
    # No mix to be had from it (the service can't say what is like it): the thing itself, shuffled.
    m = _music({"player_queues/play_media": lambda a: RuntimeError("No base tracks available") if a["media"].startswith("radio_playlist://") else None})
    assert asyncio.run(m.op("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/100", "radio": True})) is None
    assert m.calls[-1] == ("player_queues/play_media", {"queue_id": "upd3a7a53b", "media": "tidal://artist/100", "option": "replace", "shuffle": True})
    # The music service not answering is said, not papered over with a second try.
    m = _music({"player_queues/play_media": RuntimeError(pb.MUSIC_DOWN)})
    with pytest.raises(RuntimeError, match="isn't answering"):
        asyncio.run(m.op("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/100", "radio": True}))
    assert len(m.calls) == 1
    # Its bare "Internal server error" is put in words a person can use.
    m = _music({"player_queues/play_media": RuntimeError("Internal server error")})
    with pytest.raises(RuntimeError, match="couldn't start that on the speaker"):
        asyncio.run(m.op("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/100"}))
    # A mix can't be a way round what may be played.
    m = _music({})
    for bad in ("spotify://artist/1", "radio_playlist://playlist/http://evil.example/x", "http://169.254.169.254/x"):
        with pytest.raises(RuntimeError, match="isn't something from this home"):
            asyncio.run(m.op("music.play", {"entity": "media_player.lounge", "uri": bad, "radio": True}))
    assert m.calls == []


def test_just_music_offers_what_was_played_lately_then_what_the_service_suggests():
    import asyncio

    recent = [
        {"uri": "tidal--Ab12://track/9", "media_type": "track", "name": "So What", "artists": [{"name": "Miles Davis"}]},
        {"uri": "library://album/4", "media_type": "album", "name": "In the library"},
        {"uri": "spotify://track/1", "media_type": "track", "name": "From a service nobody linked"},
        {"uri": "tidal://podcast/1", "media_type": "podcast", "name": "Not music"},
        {"uri": "http://evil.example/x", "media_type": "track", "name": "A bare address"},
    ]
    rows = [
        {"provider": "recommendations", "item_id": "random_albums", "items": []},
        {"provider": "tidal--Ab12", "item_id": "mixes", "items": [{"uri": "tidal--Ab12://playlist/m-1", "media_type": "playlist", "name": "My Daily Discovery"}]},
        {"provider": "tidal--Ab12", "item_id": "for_you", "items": []},
    ]
    answers = {
        "music/recently_played_items": recent,
        "music/recommendations": rows,
        "music/recommendations/items": lambda a: [{"uri": "tidal--Ab12://album/7", "media_type": "album", "name": "Kind of Blue"}] if a["item_id"] == "for_you" else [],
        # The library item is looked up, so it's known which service it came from.
        "music/item_by_uri": lambda a: {"uri": a["uri"], "media_type": "album", "name": "In the library", "provider_mappings": [{"provider_domain": "tidal"}]},
    }
    m = _music(answers)
    got = asyncio.run(m.op("music.suggest", {}))
    assert got == [
        {"uri": "tidal--Ab12://track/9", "kind": "track", "name": "So What", "artist": "Miles Davis"},
        {"uri": "library://album/4", "kind": "album", "name": "In the library"},
        {"uri": "tidal--Ab12://playlist/m-1", "kind": "playlist", "name": "My Daily Discovery"},
        {"uri": "tidal--Ab12://album/7", "kind": "album", "name": "Kind of Blue"},
    ]
    # The linked service's rows were read before the library's.
    asked = [a["item_id"] for c, a in m.calls if c == "music/recommendations/items"]
    assert asked[0] == "for_you"
    # A library item from a source nobody linked is left out.
    m = _music({**answers, "music/item_by_uri": lambda a: {"uri": a["uri"], "media_type": "album", "name": "x", "provider_mappings": [{"provider_domain": "filesystem_local"}]}})
    assert "library://album/4" not in [g["uri"] for g in asyncio.run(m.op("music.suggest", {}))]
    # Suggestions failing is no reason to say nothing was played lately.
    m = _music({**answers, "music/recommendations": RuntimeError("Internal server error")})
    assert [g["uri"] for g in asyncio.run(m.op("music.suggest", {}))][:1] == ["tidal--Ab12://track/9"]


def test_the_music_services_own_page_is_told_to_answer_only_where_the_connector_is(monkeypatch):
    import asyncio

    async def no_sleep(_s):
        return None

    monkeypatch.setattr(pb.asyncio, "sleep", no_sleep)
    # Not asked for: nothing is touched.
    monkeypatch.delenv("MUSIC_BIND", raising=False)
    m = _music({})
    asyncio.run(m._bind())
    assert m.calls == []
    # Asked for, and that's where the connector reaches it: saved once, then left alone.
    monkeypatch.setenv("MUSIC_BIND", "127.0.0.1")
    state = {"bind": "0.0.0.0"}

    def save(a):
        state["bind"] = a["values"]["bind_ip"]
        return RuntimeError(pb.MUSIC_DOWN)  # it restarts its web server under the call

    m = _music({"config/core/get_value": lambda a: state["bind"], "config/core/save": save})
    asyncio.run(m._bind())
    assert ("config/core/save", {"domain": "webserver", "values": {"bind_ip": "127.0.0.1"}}) in m.calls and m._bound
    before = len(m.calls)
    asyncio.run(m._bind())
    assert len(m.calls) == before
    # Already so: no save.
    m = _music({"config/core/get_value": "127.0.0.1"})
    asyncio.run(m._bind())
    assert [c for c, _a in m.calls] == ["config/core/get_value"]
    # The connector reaches it somewhere else (another container, by name): never told, or
    # the box would lock itself out of its own music.
    for base in ("http://music:8095", "http://home-music:8095", "http://host.docker.internal:8095", "http://192.168.1.20:8095"):
        m = _music({"config/core/get_value": "0.0.0.0"}, base=base)
        asyncio.run(m._bind())
        assert m.calls == [] and m._bound, base
    # It never came back saying so: that's a failure to report, not a quiet pass.
    m = _music({"config/core/get_value": "0.0.0.0", "config/core/save": None})
    with pytest.raises(RuntimeError, match="didn't come back"):
        asyncio.run(m._bind())
