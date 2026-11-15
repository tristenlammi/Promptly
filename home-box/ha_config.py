"""Write the bundled Home Assistant's configuration before it starts.

Runs inside the Home Assistant container (docker-compose.yml, "Promptly
Home"), ahead of Home Assistant itself. Nobody edits this Home Assistant by
hand: Promptly is its only screen. So its settings are ours, rewritten on
every start from two values:

  HOME_HA_BIND   the address its own web server listens on. On a Linux host
                 it shares the host's network (so it can find devices), and
                 this is 127.0.0.1: nothing on the home network can open it.
                 On Docker Desktop it's on Docker's private network and
                 listens there (0.0.0.0, no port published).
  HOME_HA_PORT   its port (default 8123), should that one be taken.

Two files:

* ``configuration.yaml``: what to load. Not ``default_config``: that brings a
  camera relay and other listeners with it. Just what finding and running
  devices needs.
* ``.storage/http``: where the web server listens. Home Assistant keeps this
  itself now, and treats a changed setting as a trial: unless someone
  confirms it from its own screens within five minutes, it goes back to the
  last confirmed one (every address, port 8123) and restarts. Nobody opens
  those screens here, so we write the confirmed setting directly.
"""
import datetime
import json
import os
import sys

MARK = "# Written by Promptly on every start (home-box/ha_config.py). Changes here are lost."


def yaml_text() -> str:
    return f"""{MARK}
homeassistant:
  name: Home

frontend:
api:
websocket_api:
config:

# Finding devices on the home network.
network:
zeroconf:
ssdp:
dhcp:

logger:
  default: warning
"""


def http_store(old: dict | None, bind: str, port: int) -> dict:
    """Home Assistant's stored web-server settings, with ours as the
    confirmed ("stable") one and nothing on trial."""
    data = (old or {}).get("data") if isinstance(old, dict) else None
    stable = dict(data.get("stable") or {}) if isinstance(data, dict) else {}
    if not stable:
        stable = {
            "cors_allowed_origins": [],
            "login_attempts_threshold": -1,
            "ip_ban_enabled": True,
            "ssl_profile": "intermediate_v6",
            "use_x_frame_options": True,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
    stable.update(server_host=[bind], server_port=port, error=None, error_message=None)
    out = dict(old) if isinstance(old, dict) and "version" in old else {"version": 3, "minor_version": 1, "key": "http"}
    out["data"] = {"stable": stable, "pending": None, "yaml_migration_done": True}
    return out


def main(config_dir: str) -> None:
    bind = os.environ.get("HOME_HA_BIND", "0.0.0.0").strip() or "0.0.0.0"
    port = int(os.environ.get("HOME_HA_PORT", "8123") or 8123)
    path = os.path.join(config_dir, "configuration.yaml")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            if MARK not in f.read():
                # Somebody's own Home Assistant config: not ours to replace.
                print("promptly: configuration.yaml isn't Promptly's, leaving it alone", flush=True)
                return
    os.makedirs(os.path.join(config_dir, ".storage"), exist_ok=True)
    body = yaml_text()
    # For people who know Home Assistant, and for tests: whatever is in
    # configuration.extra.yaml is added to the end, as it is.
    extra = os.path.join(config_dir, "configuration.extra.yaml")
    if os.path.exists(extra):
        with open(extra, encoding="utf-8") as f:
            body += "\n# From configuration.extra.yaml\n" + f.read()
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)

    store = os.path.join(config_dir, ".storage", "http")
    old = None
    if os.path.exists(store):
        try:
            with open(store, encoding="utf-8") as f:
                old = json.load(f)
        except (OSError, ValueError):
            old = None
    tmp = store + ".promptly"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(http_store(old, bind, port), f, indent=2)
    os.replace(tmp, store)
    print(f"promptly: Home Assistant will listen on {bind}:{port}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/config")
