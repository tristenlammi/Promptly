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
    assert (step["kind"], step["title"]) == ("form", "Manual configure a Hue bridge")
    assert step["fields"] == [{"name": "host", "label": "Host", "required": True, "type": "text"}]

    link = pb.shape_flow(HUE_LINK, HUE_WORDS, "Philips Hue")
    # No fields: "press the button, then Continue". Home Assistant is never named, and its picture is dropped.
    assert link["kind"] == "form" and link["fields"] == [] and link["errors"] == {}
    assert link["text"] == "Press the button on the bridge to register Philips Hue with Promptly."

    failed = pb.shape_flow(HUE_LINK_FAILED, HUE_WORDS, "Philips Hue")
    assert failed["errors"] == {"base": "Failed to register, please try again"}

    done = pb.shape_flow(HUE_DONE, HUE_WORDS, "Philips Hue")
    assert (done["kind"], done["title"], done["entry_id"]) == ("done", "Hue Bridge 1a2b3c", "e-hue")


def test_a_sign_in_step_draws_its_fields_and_never_echoes_a_secret():
    step = pb.shape_flow(LOGIN, LOGIN_WORDS, "Acme")
    assert step["text"] == "Sign in at https://acme.example first." and step["last"] is True
    assert step["errors"] == {"base": "That sign-in wasn't accepted."}
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
    assert (stopped["kind"], stopped["text"]) == ("stopped", "Device is already configured")
    assert pb.shape_flow({"type": "abort", "flow_id": "x", "handler": "zzz", "reason": "no_devices_found"}, {}, "Zzz")["text"] == "Nothing was found on your network."
    menu = pb.shape_flow({"type": "menu", "flow_id": "m", "handler": "zzz", "step_id": "user", "menu_options": ["cloud", "local_network"]}, {"component.zzz.config.step.user.menu_options.cloud": "Sign in"}, "Zzz")
    assert menu["kind"] == "menu" and menu["options"] == [{"value": "cloud", "label": "Sign in"}, {"value": "local_network", "label": "Local network"}]
    assert pb.shape_flow({"type": "external", "flow_id": "o", "handler": "zzz", "step_id": "auth", "url": "https://x"}, {}, "Zzz")["kind"] == "elsewhere"
    assert pb.shape_flow({"type": "show_progress", "flow_id": "p", "handler": "zzz", "step_id": "wait", "progress_action": "pairing"}, {}, "Zzz")["kind"] == "wait"


def test_found_devices_get_a_name_and_brands_put_the_known_ones_first():
    names = {"hue": {"domain": "hue", "name": "Philips Hue", "iot_class": "local_push"}, "tuya": {"domain": "tuya", "name": "Tuya", "iot_class": "cloud_push"}, "ping": {"domain": "ping", "name": "Ping (ICMP)", "iot_class": "local_polling"}, "sun": {"domain": "sun", "name": "Sun"}}
    found = pb.found_one({"flow_id": "f", "handler": "hue", "context": {"source": "zeroconf", "title_placeholders": {"name": "Hue Bridge 1A2B3C"}}}, names, HUE_WORDS)
    assert found == {"flow": "f", "brand": "hue", "brand_name": "Philips Hue", "name": "Hue Bridge 1A2B3C"}
    can = {"hue", "tuya", "ping", "sun"}
    first = pb.brands_for(names, can, "")
    assert [b["id"] for b in first] == ["hue", "tuya"] and first[1]["cloud"] is True and first[0]["cloud"] is False
    assert [b["id"] for b in pb.brands_for(names, can, "pin")] == ["ping"]
    assert pb.brands_for(names, can, "sun") == []  # housekeeping isn't a brand


def test_actions_become_home_assistant_services():
    assert pb.service_for("light", "set", {"bri": 40, "k": 2700}) == ("light", "turn_on", {"brightness_pct": 40, "color_temp_kelvin": 2700})
    assert pb.service_for("media_player", "volume", 35) == ("media_player", "volume_set", {"volume_level": 0.35})
    assert pb.service_for("lock", "unlock", None) == ("lock", "unlock", {})
    assert pb.service_for("cover", "position", 20) == ("cover", "set_cover_position", {"position": 20})
    assert pb.service_for("sensor", "turn_on", None) is None and pb.service_for("lock", "toggle", None) is None
    assert pb.extras("climate", {"temperature": 21, "current_temperature": 19.5, "hvac_modes": ["off", "heat"], "min_temp": 7, "max_temp": 35}) == {"target": 21, "cur": 19.5, "min": 7, "max": 35, "modes": ["off", "heat"]}
    assert pb.extras("media_player", {"volume_level": 0.4, "media_title": "Song", "is_volume_muted": False}) == {"vol": 40, "title": "Song", "muted": False}


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
