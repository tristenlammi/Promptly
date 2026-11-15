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
  Looking for devices on the network (zeroconf, ssdp, dhcp) is left out
  until this Home Assistant has its own account: before that it sets up
  whatever it finds without asking (a house's Chromecasts appeared in a home
  nobody had added them to). The connector makes the account within seconds
  and restarts Home Assistant once; this script runs again on every start of
  Home Assistant, not just of the container (``install_hook``), and puts the
  looking back.
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


RUN_SCRIPT = "/etc/services.d/home-assistant/run"
HOOK = "python3 /promptly/ha_config.py /config --from-hook || true"
STEPS = {"user", "core_config", "analytics", "integration"}


def yaml_text(looking: bool = True) -> str:
    discovery = """
# Finding devices on the home network.
network:
zeroconf:
ssdp:
dhcp:
""" if looking else """
# Not looking for devices yet: this Home Assistant has no account of its own,
# and until it does it would set up whatever it found without asking.
"""
    return f"""{MARK}
homeassistant:
  name: Home

frontend:
api:
websocket_api:
config:
{discovery}
logger:
  default: warning
"""


def onboarded(config_dir: str) -> bool:
    """Home Assistant has finished its own first start (the connector does
    that for it), so finding a device now asks before setting it up."""
    try:
        with open(os.path.join(config_dir, ".storage", "onboarding"), encoding="utf-8") as f:
            done = set((json.load(f).get("data") or {}).get("done") or [])
    except (OSError, ValueError, AttributeError):
        return False
    return STEPS <= done


def install_hook(run_script: str = RUN_SCRIPT) -> bool:
    """Make this script run before every start of Home Assistant inside the
    container (it restarts itself without the container restarting). True
    when it's in place."""
    try:
        with open(run_script, encoding="utf-8") as f:
            text = f.read()
        if HOOK in text:
            return True
        lines = text.split("\n")
        at = next(i for i, line in enumerate(lines) if line.startswith("exec python3"))
        lines.insert(at, HOOK)
        with open(run_script, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines))
        return True
    except (OSError, StopIteration):
        return False


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


def main(config_dir: str, hooked: bool = False) -> None:
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
    # Without the hook we'd never get to turn the looking back on: leave it on.
    looking = onboarded(config_dir) or not hooked
    body = yaml_text(looking)
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
    print(f"promptly: Home Assistant will listen on {bind}:{port}" + ("" if looking else ", not looking for devices until it has its account"), flush=True)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(args[0] if args else "/config", hooked="--from-hook" in sys.argv or install_hook())
