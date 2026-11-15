"""Write the bundled Home Assistant's configuration before it starts.

Runs inside the Home Assistant container (docker-compose.yml, "Promptly
Home"), ahead of Home Assistant itself. Nobody edits this Home Assistant by
hand: Promptly is its only screen. So the file is ours, rewritten on every
start from two settings:

  HOME_HA_BIND   the address its own web server listens on. On a Linux host
                 it shares the host's network (so it can find devices), and
                 this is 127.0.0.1: nothing on the home network can open it.
                 On Docker Desktop it's on Docker's private network and
                 listens there (0.0.0.0, no port published).
  HOME_HA_PORT   its port (default 8123), should that one be taken.

Not ``default_config``: that brings a camera relay and other listeners with
it. Just what finding and running devices needs.
"""
import os
import sys

MARK = "# Written by Promptly on every start (home-box/ha_config.py). Changes here are lost."


def text(bind: str, port: int) -> str:
    return f"""{MARK}
homeassistant:
  name: Home

http:
  server_host: {bind}
  server_port: {port}

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


def main(config_dir: str) -> None:
    path = os.path.join(config_dir, "configuration.yaml")
    bind = os.environ.get("HOME_HA_BIND", "0.0.0.0").strip() or "0.0.0.0"
    port = int(os.environ.get("HOME_HA_PORT", "8123") or 8123)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            if MARK not in f.read():
                # Somebody's own Home Assistant config: not ours to replace.
                print("promptly: configuration.yaml isn't Promptly's, leaving it alone", flush=True)
                return
    os.makedirs(config_dir, exist_ok=True)
    body = text(bind, port)
    # For people who know Home Assistant, and for tests: whatever is in
    # configuration.extra.yaml is added to the end, as it is.
    extra = os.path.join(config_dir, "configuration.extra.yaml")
    if os.path.exists(extra):
        with open(extra, encoding="utf-8") as f:
            body += "\n# From configuration.extra.yaml\n" + f.read()
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    print(f"promptly: Home Assistant will listen on {bind}:{port}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/config")
