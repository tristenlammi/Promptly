"""Finish setting up: the checklist's rows follow the server's own state,
only the services this install has are listed, and the model suggestions
pick sensibly from what a provider offers."""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from tests.test_member_defaults import _auth, _member, client  # noqa: F401


def _maps(state: str = "off", **over) -> dict:
    """What ``setup._maps_state`` answers."""
    return {
        "available": state != "off", "managed": "ui", "state": state, "step": None, "progress": None,
        "ready": state == "ready", "names": [], **over,
    }


@pytest.fixture
def quiet(monkeypatch):
    """No optional service answers: a bare install."""
    from app.admin import setup
    from app.photos import ml
    from app.rtc import config as rtc_config
    from app.talk import admin as talk_admin

    state: dict = {
        "calls": None, "inside": None, "outside": None,
        "maps": _maps(),
        "photos": None, "hears": False, "speaks": False, "profiles": set(),
    }

    async def calls_state():
        return state["calls"] or "down"

    async def calls_tests(redis):
        return state["inside"], state["outside"]

    async def speech():
        return {"listening": {"reachable": state["hears"]}, "speaking": {"reachable": state["speaks"]}}

    async def photos_health(**_kw):
        return state["photos"]

    async def maps_state():
        return state["maps"]

    async def ollama():
        return False

    monkeypatch.setattr(rtc_config, "configured", lambda: state["calls"] is not None)
    monkeypatch.setattr(setup, "_calls_state", calls_state)
    monkeypatch.setattr(setup, "_calls_tests", calls_tests)
    monkeypatch.setattr(setup, "_maps_state", maps_state)
    monkeypatch.setattr(setup, "_ollama_there", ollama)
    monkeypatch.setattr(setup, "profiles", lambda: state["profiles"])
    monkeypatch.setattr(talk_admin, "_speech", speech)
    monkeypatch.setattr(ml, "health", photos_health)
    return state


def _rows(body: dict) -> dict[str, dict]:
    return {r["id"]: r for r in body["rows"]}


async def _provider(db, models: list[dict], name: str = "OpenRouter", kind: str = "openrouter"):
    from app.models_config.models import ModelProvider

    p = ModelProvider(name=name, type=kind, enabled=True, models=models)
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


async def test_a_fresh_install_lists_what_is_missing(db, user, client, quiet):
    r = await client.get("/api/admin/setup", headers=_auth(user))
    assert r.status_code == 200, r.text
    body = r.json()
    rows = _rows(body)
    for key in ("provider", "models", "search_model"):
        assert rows[key]["group"] == "essential" and rows[key]["status"] == "todo"
    assert rows["provider"]["to"] == "/setup?step=provider"
    for key in ("address", "email", "mfa", "backups", "people"):
        assert rows[key]["status"] == "todo" and rows[key]["to"]
    assert body["essential_left"] == 3 and body["dismissed"] is False
    # Services this install doesn't have aren't listed at all.
    assert not {"calls", "maps", "talk", "photos"} & set(rows)
    assert body["services"] == {
        "calls": False, "maps": False, "voice": False, "photos": False,
        "search": False, "local_models": False, "home": False,
    }


async def test_only_an_admin_sees_it(db, user, client, quiet):
    _, hdr = await _member(db, client, user)
    assert (await client.get("/api/admin/setup", headers=hdr)).status_code == 403
    assert (await client.get("/api/admin/setup/model-suggestions", headers=hdr)).status_code == 403
    assert (await client.get("/api/admin/setup")).status_code in (401, 403)


async def test_rows_turn_done_as_things_are_set_up(db, user, client, quiet):
    hdr = _auth(user)
    p = await _provider(db, [
        {"id": "anthropic/claude-sonnet-4.5", "display_name": "Claude Sonnet 4.5"},
        {"id": "openai/text-embedding-3-small", "display_name": "Embedding"},
    ])
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["provider"]["status"] == "done" and "OpenRouter" in rows["provider"]["detail"]
    assert rows["models"]["status"] == "todo" and rows["models"]["to"] == "/setup?step=models"

    r = await client.patch("/api/admin/app-settings", headers=hdr, json={
        "default_chat_provider_id": str(p.id), "default_chat_model_id": "anthropic/claude-sonnet-4.5",
        "public_origins": ["https://family.example.org"],
    })
    assert r.status_code == 200, r.text
    await _member(db, client, user)
    body = (await client.get("/api/admin/setup", headers=hdr)).json()
    rows = _rows(body)
    assert rows["models"]["status"] == "done" and "Claude Sonnet 4.5" in rows["models"]["detail"]
    assert rows["address"]["status"] == "done" and body["outside"]["https"] is True
    assert rows["people"]["status"] == "done"
    assert body["essential_left"] == 1  # the embedding model is still missing


async def test_a_provider_with_nothing_to_chat_with_is_a_problem(db, user, client, quiet):
    await _provider(db, [{"id": "nomic-embed-text", "display_name": "nomic"}], name="Ollama", kind="ollama")
    rows = _rows((await client.get("/api/admin/setup", headers=_auth(user))).json())
    assert rows["provider"]["status"] == "problem"
    assert rows["models"]["status"] == "todo"


async def test_a_plain_http_address_is_flagged(db, user, client, quiet):
    hdr = _auth(user)
    await client.patch("/api/admin/app-settings", headers=hdr, json={"public_origins": ["http://family.example.org"]})
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["address"]["status"] == "problem" and "https" in rows["address"]["detail"]
    # A home-network address alone isn't "an address people can reach".
    await client.patch("/api/admin/app-settings", headers=hdr, json={"public_origins": ["http://192.168.1.20:8087"]})
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["address"]["status"] == "todo"


async def test_calls_follow_the_test_call_from_outside(db, user, client, quiet):
    hdr = _auth(user)
    quiet["calls"] = "ok"
    body = (await client.get("/api/admin/setup", headers=hdr)).json()
    row = _rows(body)["calls"]
    assert row["group"] == "outside" and row["status"] == "todo"
    assert "UDP 7882" in row["detail"] and "TCP 7881" in row["detail"]
    assert body["outside"]["ports"] == {"udp": 7882, "tcp": 7881}
    assert body["outside"]["calls"] == {"there": True, "running": True, "enabled": False, "inside_ok": False, "outside": None}

    quiet["outside"] = {"ok": False}
    assert _rows((await client.get("/api/admin/setup", headers=hdr)).json())["calls"]["status"] == "problem"
    quiet["outside"] = {"ok": True}
    assert _rows((await client.get("/api/admin/setup", headers=hdr)).json())["calls"]["status"] == "done"
    # Not answering: still listed when the install says it has calls.
    quiet["calls"] = "down"
    assert "calls" not in _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    quiet["profiles"] = {"calls"}
    assert _rows((await client.get("/api/admin/setup", headers=hdr)).json())["calls"]["status"] == "problem"


async def test_maps_rows_follow_the_real_state(db, user, client, quiet):
    hdr = _auth(user)

    async def row() -> dict:
        return _rows((await client.get("/api/admin/setup", headers=hdr)).json())["maps"]

    # Nothing chosen: nothing has been downloaded, and the wizard's step is offered.
    quiet["maps"] = _maps("none")
    body = (await client.get("/api/admin/setup", headers=hdr)).json()
    got = _rows(body)["maps"]
    assert got["status"] == "todo" and got["to"] == "/setup?step=maps" and "nothing has been downloaded" in got["detail"]
    assert body["outside"]["maps"]["can_choose"] is True and body["services"]["maps"] is True

    quiet["maps"] = _maps("building", step="working out the roads for directions", progress=0.2, names=["New Zealand"])
    got = await row()
    assert got["status"] == "working" and got["to"] is None
    assert "New Zealand is being put together" in got["detail"] and "working out the roads" in got["detail"] and "20%" in got["detail"]

    # A second country being added: the first keeps working.
    quiet["maps"] = _maps("building", step="building search", progress=0.6, ready=True, names=["New Zealand", "Fiji"])
    assert "The map you have keeps working" in (await row())["detail"]

    quiet["maps"] = _maps("ready", names=["New Zealand", "Fiji"])
    got = await row()
    assert got["status"] == "done" and "New Zealand and Fiji" in got["detail"]

    quiet["maps"] = _maps("failed", step="downloading street addresses", names=["Australia"])
    got = await row()
    assert got["status"] == "problem" and "downloading street addresses" in got["detail"] and got["to"] == "/admin?tab=settings"

    # Set in .env: said so, and no step to choose in.
    quiet["maps"] = _maps("ready", managed="env", names=["Monaco"])
    body = (await client.get("/api/admin/setup", headers=hdr)).json()
    got = _rows(body)["maps"]
    assert got["status"] == "done" and "set in .env" in got["detail"] and got["to"] is None
    assert body["outside"]["maps"]["can_choose"] is False

    # The install has Maps but the service isn't answering yet.
    quiet["maps"] = _maps("off")
    quiet["profiles"] = {"maps"}
    got = await row()
    assert got["status"] == "working" and "starting" in got["detail"]


async def test_maps_state_reads_the_maps_service(monkeypatch):
    from app.admin import setup
    from app.maps import regions

    answers: dict = {"doc": None}

    async def control(method, path, body=None):
        assert (method, path) == ("GET", "/state")
        return answers["doc"]

    monkeypatch.setattr(regions, "control", control)
    monkeypatch.setattr(setup, "_maps_files", lambda: {"state": "off", "ready": False})

    got = await setup._maps_state()
    assert got["available"] is False and got["state"] == "off"

    answers["doc"] = {"managed": "ui", "chosen": False, "wanted": [], "live": None, "status": {"state": "none"}, "disk": {}}
    got = await setup._maps_state()
    assert got["available"] is True and got["state"] == "none" and got["names"] == []

    answers["doc"] = {
        "managed": "ui", "chosen": True, "wanted": [{"id": "new-zealand", "name": "New Zealand"}], "live": None,
        "status": {"state": "building", "step": "routing", "steps": ["osm", "basemap", "routing", "search"]}, "disk": {},
    }
    got = await setup._maps_state()
    assert got["state"] == "building" and got["step"] == "working out the roads for directions"
    assert got["names"] == ["New Zealand"] and got["ready"] is False and 0 < got["progress"] < 1

    answers["doc"] = {
        "managed": "env", "chosen": True, "wanted": [{"id": "custom", "name": "Monaco"}],
        "live": {"regions": [{"id": "custom", "name": "Monaco"}], "bytes": 5}, "status": {"state": "ready"}, "disk": {},
    }
    got = await setup._maps_state()
    assert got["state"] == "ready" and got["managed"] == "env" and got["ready"] is True

    answers["doc"] = {
        "managed": "ui", "chosen": True, "wanted": [{"id": "australia", "name": "Australia"}], "live": None,
        "status": {"state": "failed", "step": "addresses", "steps": ["osm", "addresses"]}, "disk": {},
    }
    got = await setup._maps_state()
    assert got["state"] == "failed" and got["step"] == "downloading street addresses"


async def test_speech_and_photos_rows(db, user, client, quiet):
    hdr = _auth(user)
    quiet["hears"], quiet["speaks"] = True, False
    quiet["photos"] = {"state": "downloading"}
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["talk"]["status"] == "problem" and rows["photos"]["status"] == "working"
    quiet["speaks"] = True
    quiet["photos"] = {"state": "ready"}
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["talk"]["status"] == "done" and rows["photos"]["status"] == "done"


async def test_closing_the_today_card_is_remembered(db, user, client, quiet):
    hdr = _auth(user)
    r = await client.patch("/api/auth/me/preferences", headers=hdr, json={"setup_card_dismissed": True})
    assert r.status_code == 200, r.text
    body = (await client.get("/api/admin/setup", headers=hdr)).json()
    # Closed, not done: the rows are still there for Admin → Setup.
    assert body["dismissed"] is True and body["essential_left"] == 3


async def test_the_home_network_address(monkeypatch):
    from app.admin import setup

    monkeypatch.setattr(setup, "get_settings", lambda: SimpleNamespace(SERVER_LAN_IP=""))
    assert setup.lan_address("192.168.1.20:8087") == "192.168.1.20"
    assert setup.lan_address("10.0.0.5") == "10.0.0.5"
    assert setup.lan_address("localhost:8087") is None
    assert setup.lan_address("127.0.0.1:8087") is None
    assert setup.lan_address("family.example.org") is None
    assert setup.lan_address("203.0.113.9:8087") is None
    assert setup.lan_address(None) is None
    monkeypatch.setattr(setup, "get_settings", lambda: SimpleNamespace(SERVER_LAN_IP="192.168.4.2"))
    assert setup.lan_address("family.example.org") == "192.168.4.2"


# ----------------------------------------------------- model suggestions


def _m(model_id: str, *, provider=None, vision=False, image=False, name=None):
    return SimpleNamespace(
        provider_id=provider or _P1, provider_name="OpenRouter", model_id=model_id,
        display_name=name or model_id, supports_vision=vision, supports_image_output=image,
    )


_P1, _P2 = uuid.uuid4(), uuid.uuid4()


def _picks(models) -> dict[str, str | None]:
    from app.admin.setup import suggest_models

    out = suggest_models(models, None)
    return {r["role"]: (r["suggestion"] or {}).get("model_id") for r in out["roles"]}


def test_suggestions_from_a_big_catalogue():
    picks = _picks([
        _m("anthropic/claude-3.7-sonnet", vision=True),
        _m("anthropic/claude-3.7-sonnet:thinking", vision=True),
        _m("anthropic/claude-sonnet-4.5", vision=True),
        _m("anthropic/claude-haiku-4.5", vision=True),
        _m("anthropic/claude-3.5-haiku"),
        _m("google/gemini-2.5-pro", vision=True),
        _m("google/gemini-2.5-flash", vision=True),
        _m("google/gemini-2.5-flash-image", image=True),
        _m("openai/gpt-5-mini", vision=True),
        _m("openai/text-embedding-3-small"),
        _m("openai/gpt-4o-audio-preview"),
    ])
    assert picks == {
        "chat": "anthropic/claude-sonnet-4.5",
        "quick": "anthropic/claude-haiku-4.5",
        "voice": "anthropic/claude-haiku-4.5",
        "see": "anthropic/claude-haiku-4.5",
        "draw": "google/gemini-2.5-flash-image",
    }


def test_gemini_is_not_a_mini():
    # "gemini" has "mini" in it: the Pro model is the chat pick, Flash the quick one.
    picks = _picks([_m("gemini-2.5-pro", vision=True), _m("gemini-2.5-flash", vision=True), _m("gemini-2.5-flash-lite")])
    assert picks["chat"] == "gemini-2.5-pro"
    assert picks["quick"] == "gemini-2.5-flash" and picks["see"] == "gemini-2.5-flash"
    assert picks["draw"] is None


def test_dated_names_and_plain_names():
    picks = _picks([
        _m("claude-sonnet-4-20250514"), _m("claude-sonnet-4-5-20250929"), _m("claude-3-5-haiku-20241022"),
        _m("gpt-4o-2024-11-20"), _m("gpt-4o"), _m("gpt-4o-mini"),
    ])
    assert picks["chat"] == "claude-sonnet-4-5-20250929"
    assert picks["quick"] == "claude-3-5-haiku-20241022"


def test_the_quick_model_stays_with_the_chat_models_provider():
    picks = _picks([
        _m("gpt-5", provider=_P1), _m("gpt-5-mini", provider=_P1),
        _m("claude-haiku-4-5", provider=_P2),
    ])
    assert picks["chat"] == "gpt-5" and picks["quick"] == "gpt-5-mini"


def test_a_local_only_install_gets_a_chat_model_and_nothing_made_up():
    from app.admin.setup import suggest_models

    out = suggest_models([_m("qwen3:8b"), _m("nomic-embed-text")], None)
    picks = {r["role"]: r["suggestion"] for r in out["roles"]}
    assert out["has_models"] is True
    assert picks["chat"]["model_id"] == "qwen3:8b"
    assert picks["quick"] is None and picks["see"] is None and picks["draw"] is None
    assert suggest_models([_m("nomic-embed-text")], None)["has_models"] is False


async def test_suggestions_endpoint_reports_what_is_saved(db, user, client, quiet):
    hdr = _auth(user)
    p = await _provider(db, [
        {"id": "anthropic/claude-sonnet-4.5", "display_name": "Claude Sonnet 4.5", "supports_vision": True},
        {"id": "anthropic/claude-haiku-4.5", "display_name": "Claude Haiku 4.5", "supports_vision": True},
    ])
    body = (await client.get("/api/admin/setup/model-suggestions", headers=hdr)).json()
    roles = {r["role"]: r for r in body["roles"]}
    assert body["has_models"] is True
    assert roles["chat"]["suggestion"]["model_id"] == "anthropic/claude-sonnet-4.5"
    assert roles["chat"]["suggestion"]["provider_id"] == str(p.id)
    assert roles["quick"]["suggestion"]["name"] == "Claude Haiku 4.5"
    assert roles["chat"]["current"] is None

    # Saving the picks the way the wizard does: one PATCH, every pair.
    patch = {}
    for r in body["roles"]:
        if r["suggestion"]:
            patch[f"{r['field']}_provider_id"] = r["suggestion"]["provider_id"]
            patch[f"{r['field']}_model_id"] = r["suggestion"]["model_id"]
    r = await client.patch("/api/admin/app-settings", headers=hdr, json=patch)
    assert r.status_code == 200, r.text
    body = (await client.get("/api/admin/setup/model-suggestions", headers=hdr)).json()
    roles = {r["role"]: r for r in body["roles"]}
    assert roles["chat"]["current"]["model_id"] == "anthropic/claude-sonnet-4.5"
    assert roles["voice"]["current"]["model_id"] == "anthropic/claude-haiku-4.5"
    rows = _rows((await client.get("/api/admin/setup", headers=hdr)).json())
    assert rows["models"]["status"] == "done" and "Talk" in rows["models"]["detail"]


async def test_finding_the_calls_service_never_blocks_the_other_checks(monkeypatch):
    """Looking the calls service up is a blocking DNS call (4 seconds when it
    isn't there). It runs off the event loop, so the Maps, speech and photo
    checks next to it don't time out and vanish from the list."""
    import threading

    from app.admin import setup
    from app.calls import checks
    from app.rtc import config as rtc_config

    seen: dict = {}

    def api_url() -> str:
        seen["thread"] = threading.current_thread()
        return "http://livekit:7880"

    async def server_status():
        return "down", "not there", None

    monkeypatch.setattr(rtc_config, "api_url", api_url)
    monkeypatch.setattr(checks, "server_status", server_status)
    assert await setup._calls_state() == "down"
    assert seen["thread"] is not threading.main_thread()
