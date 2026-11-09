"""Render a standalone compose file for one isolated Promptly stack.

Called by scripts/stack.sh; not meant to be run by hand. It renders this
worktree's docker-compose.yml with `docker compose config` (a throwaway env
file, the shell's Compose variables unset, env files not read), then rewrites
the result so nothing in it can touch the main app or another stack:

  * project `promptly-stack-<name>`, containers `Promptly<Name>-*`
  * images it builds are tagged `promptly-<service>:stack-<name>` (the main
    app's `promptly-backend:local` etc. are never built over)
  * named volumes in place of ./data bind mounts, own networks
    (Compose names both <project>_<key>)
  * only nginx publishes a port: 127.0.0.1:<port>
  * only the services asked for (see EXTRAS)

The rendered file is checked before it is written (see _check), so a change
to docker-compose.yml that would leak into the main stack fails loudly here.

Prints `PORT=<port>` on success.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
from pathlib import Path

CORE = ["postgres", "redis", "backend", "arq-worker", "mail-worker", "collab", "frontend", "nginx"]
# --with <key> -> services it adds. "maps" is a stub (a manifest so the Maps
# screen opens, no map data); "maps-full" runs the real maps container, which
# downloads and builds Australia's map data on first start (~1 h, ~15 GB).
EXTRAS = {
    "ollama": ["ollama"],
    "photos-ml": ["photos-ml"],
    "media": ["media-worker", "tusd"],
    "sandbox": ["sandbox"],
    "voice": ["whisper", "tts"],
    "convert": ["convert"],
    "search": ["searxng"],
    "maps": [],
    "maps-full": ["maps"],
    # Calls (voice channels): the bridged LiveKit variant. Its media ports
    # aren't published (only nginx is); a browser on this PC still connects.
    "calls": ["livekit-desktop"],
}
# What `--e2e` adds: what the e2e suite exercises beyond the core.
E2E_EXTRAS = ["media", "photos-ml", "maps", "convert"]
# Services the stack builds from this worktree, always.
OWN_BUILDS = {"backend", "frontend", "collab"}
FIRST_PORT = 8093
RESERVED_PORTS = {8091, 8092}  # the main app, the Passwords stack
MAIN_BACKEND_IMAGE = "promptly-backend:local"


def die(msg: str) -> None:
    print(f"stack-render: {msg}", file=sys.stderr)
    sys.exit(1)


def docker(*args: str, check: bool = True, env: dict | None = None) -> str:
    r = subprocess.run(["docker", *args], capture_output=True, text=True, env=env, encoding="utf-8")
    if check and r.returncode != 0:
        die(f"docker {' '.join(args[:3])} failed:\n{r.stderr.strip()}")
    return r.stdout


def camel(name: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in name.split("-"))


def norm(p: str) -> str:
    return os.path.normcase(os.path.normpath(p))


# ---------------------------------------------------------------- ports


def port_busy(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return True
    finally:
        s.close()
    for host in ("0.0.0.0", "127.0.0.1"):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, port))
        except OSError:
            return True
        finally:
            s.close()
    return False


def ports_taken(name: str) -> tuple[set[int], set[int]]:
    """(ports other things hold, ports this stack's own containers hold)."""
    others: set[int] = set()
    mine: set[int] = set()
    out = docker("ps", "-a", "--format", '{{.Label "com.docker.compose.project"}}\t{{.Label "promptly.stack.port"}}\t{{.Ports}}')
    for line in out.splitlines():
        project, label_port, ports = (line.split("\t") + ["", "", ""])[:3]
        held = {int(p) for p in re.findall(r":(\d+)->", ports)}
        if label_port.isdigit():
            held.add(int(label_port))
        (mine if project == f"promptly-stack-{name}" else others).update(held)
    return others, mine


def pick_port(name: str, previous: int | None) -> int:
    others, mine = ports_taken(name)
    if previous and previous not in others and (previous in mine or not port_busy(previous)):
        return previous
    for port in range(FIRST_PORT, FIRST_PORT + 200):
        if port in RESERVED_PORTS or port in others:
            continue
        if port in mine or not port_busy(port):
            return port
    die(f"no free port in {FIRST_PORT}-{FIRST_PORT + 199}")
    return 0


# ---------------------------------------------------------------- render


def write_env(path: Path) -> dict[str, str]:
    """The stack's throwaway secrets: made once, kept (Postgres keeps the
    password it was created with)."""
    if not path.exists():
        values = {
            "SECRET_KEY": secrets.token_hex(32),
            "POSTGRES_PASSWORD": secrets.token_hex(24),
            "TUS_HOOK_SECRET": secrets.token_hex(16),
            "SEARXNG_SECRET": secrets.token_hex(16),
        }
        path.write_text("".join(f"{k}={v}\n" for k, v in values.items()), encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    # Added after the first stacks were made, so appended to an existing file.
    later = {
        # Calls: the LiveKit key pair (the backend and livekit-desktop read it).
        "LIVEKIT_API_KEY": "API" + secrets.token_hex(8),
        "LIVEKIT_API_SECRET": secrets.token_hex(32),
        # The code sandbox's own job secret (never SECRET_KEY).
        "CODE_SANDBOX_SECRET": secrets.token_hex(32),
    }
    add = {k: v for k, v in later.items() if not env.get(k)}
    if add:
        with path.open("a", encoding="utf-8") as f:
            f.write("".join(f"{k}={v}\n" for k, v in add.items()))
        env.update(add)
    return env


def render_base(worktree: Path, env_file: Path) -> dict:
    compose_file = worktree / "docker-compose.yml"
    if not compose_file.exists():
        die(f"{compose_file} not found")
    # Interpolation must come from the throwaway env file only: drop every
    # variable the compose file reads, and Compose's own, from our env.
    names = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)", compose_file.read_text(encoding="utf-8")))
    env = {k: v for k, v in os.environ.items() if k not in names and not k.startswith("COMPOSE_")}
    out = docker(
        "compose", "-f", str(compose_file), "--env-file", str(env_file), "--profile", "*",
        "config", "--format", "json", "--no-env-resolution", env=env,
    )
    return json.loads(out)


def volume_rewrite(vol: dict, worktree: Path, state: Path, opts) -> dict | None:
    """A ./data bind becomes a named volume; a few binds get special care."""
    if vol.get("type") != "bind":
        return vol
    src = vol.get("source", "")
    target = vol.get("target", "")
    if target == "/etc/nginx/conf.d/local":
        return None  # operator TLS blocks, not for a test stack
    data = norm(str(worktree / "data"))
    nsrc = norm(src)
    if nsrc == data or nsrc.startswith(data + os.sep):
        key = Path(os.path.relpath(nsrc, data)).parts[0]
        key = re.sub(r"[^a-z0-9_-]", "_", key.lower())
        ro = bool(vol.get("read_only"))
        if key == "maps" and opts.maps == "stub":
            return {"type": "bind", "source": str(state / "maps-stub"), "target": target, "read_only": True}
        if key == "models" and opts.models_dir:
            # The main checkout's downloaded model files (public weights),
            # read-only, so photos-ml doesn't download 1.5 GB per stack.
            return {"type": "bind", "source": opts.models_dir, "target": target, "read_only": True}
        out = {"type": "volume", "source": key, "target": target}
        if ro:
            out["read_only"] = True
        return out
    if norm(src) == norm(str(worktree / "searxng")):
        # SearXNG writes into its config dir: give it a copy.
        dst = state / "searxng"
        if not dst.exists():
            shutil.copytree(src, dst)
        return {**vol, "source": str(dst)}
    return vol


def transform(cfg: dict, opts, env: dict[str, str]) -> dict:
    name = opts.name
    project = f"promptly-stack-{name}"
    prefix = f"Promptly{camel(name)}"
    tag = f"stack-{name}"
    backend_image = f"promptly-backend:{tag}"
    extras = set(opts.with_)
    wanted = set(CORE)
    for key in extras:
        wanted.update(EXTRAS[key])
    worktree = Path(opts.worktree)
    state = Path(opts.state)

    services = {}
    for svc, spec in cfg["services"].items():
        if svc not in wanted:
            continue
        spec = {k: v for k, v in spec.items() if v is not None}
        spec.pop("profiles", None)
        spec.pop("env_file", None)
        spec.pop("ports", None)

        # Container name: Promptly-Backend -> PromptlyNotes-Backend.
        orig = spec.get("container_name") or f"Promptly-{svc}"
        spec["container_name"] = prefix + "-" + orig.split("-", 1)[1]

        # Images.
        if "build" in spec:
            reuse = None if svc in OWN_BUILDS or opts.build_extras else opts.reuse.get(svc)
            if reuse:
                spec.pop("build")
                spec["image"] = reuse
                spec["pull_policy"] = "never"
            else:
                spec["image"] = f"promptly-{svc}:{tag}"
                spec["pull_policy"] = "build"
        elif spec.get("image") == MAIN_BACKEND_IMAGE:
            spec["image"] = backend_image
            spec["pull_policy"] = "never"

        # Only on services that are here.
        deps = spec.get("depends_on")
        if isinstance(deps, dict):
            spec["depends_on"] = {d: c for d, c in deps.items() if d in wanted}
            if not spec["depends_on"]:
                spec.pop("depends_on")
        elif isinstance(deps, list):
            spec["depends_on"] = [d for d in deps if d in wanted]

        vols = [volume_rewrite(v, worktree, state, opts) for v in spec.get("volumes", [])]
        if vols:
            spec["volumes"] = [v for v in vols if v is not None]

        # The backend family: what's actually there, and nothing more.
        if spec.get("image") == backend_image:
            e = spec.setdefault("environment", {})
            dead = "http://127.0.0.1:9"
            e.update({
                "SECRET_KEY": env["SECRET_KEY"],
                "CODE_SANDBOX_SECRET": env["CODE_SANDBOX_SECRET"],
                "SEARXNG_ENABLED": "true" if "search" in extras else "false",
                "OLLAMA_URL": "http://ollama:11434" if "ollama" in extras else dead,
                "WHISPER_URL": "http://whisper:8000" if "voice" in extras else dead,
                "TTS_URL": "http://tts:8000" if "voice" in extras else dead,
                "CONVERT_URL": "http://convert:3000" if "convert" in extras else "",
                "TUS_ENABLED": "true" if "media" in extras else "false",
                "TUS_HOOK_SECRET": env["TUS_HOOK_SECRET"],
                "STT_BACKEND": "local",
                "WYOMING_ENABLED": "false",
                "SINGLE_USER_MODE": "false",
            })

        if svc == "nginx":
            spec["ports"] = [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 80,
                              "published": str(opts.port), "protocol": "tcp"}]

        labels = spec.get("labels") or {}
        if isinstance(labels, list):
            labels = dict(l.split("=", 1) for l in labels)
        labels.update({
            "promptly.stack.name": name,
            "promptly.stack.port": str(opts.port),
            "promptly.stack.worktree": opts.worktree,
            "promptly.stack.state": opts.state,
        })
        spec["labels"] = labels
        services[svc] = spec

    missing = wanted - set(services)
    if missing:
        die(f"docker-compose.yml has no service(s): {', '.join(sorted(missing))}")

    # No explicit names: Compose then calls them <project>_<key>
    # (promptly-stack-notes_promptly), which can't clash with another stack.
    networks = {}
    for key, net in cfg.get("networks", {}).items():
        net = {k: v for k, v in net.items() if k != "name"}
        networks[key] = net

    volumes = {}
    for spec in services.values():
        for v in spec.get("volumes", []):
            if v.get("type") == "volume":
                volumes[v["source"]] = {}

    out = {"name": project, "services": services, "networks": networks}
    if volumes:
        out["volumes"] = volumes
    for k, v in cfg.items():
        if k.startswith("x-"):
            out[k] = v
    _check(out, opts)
    return out


def _check(out: dict, opts) -> None:
    """Refuse to write a file that could touch anything outside the stack."""
    prefix = f"Promptly{camel(opts.name)}-"
    tag = f":stack-{opts.name}"
    for svc, spec in out["services"].items():
        if not spec["container_name"].startswith(prefix):
            die(f"{svc}: container name {spec['container_name']} isn't the stack's")
        if "build" in spec and not spec["image"].endswith(tag):
            die(f"{svc}: would build into {spec['image']}")
        if spec.get("image", "").startswith("promptly-backend") and not spec["image"].endswith(tag):
            die(f"{svc}: runs {spec['image']}, not the stack's backend")
        if spec.get("ports") and svc != "nginx":
            die(f"{svc}: publishes ports")
        for v in spec.get("volumes", []):
            if v.get("type") == "bind":
                src = norm(v["source"])
                ok = (src.startswith(norm(opts.worktree) + os.sep)
                      or src.startswith(norm(opts.state) + os.sep) or src == norm(opts.state)
                      or (opts.models_dir and src == norm(opts.models_dir) and v.get("read_only")))
                if not ok:
                    die(f"{svc}: binds {v['source']}, outside the worktree")
                if src.startswith(norm(str(Path(opts.worktree) / "data"))):
                    die(f"{svc}: binds the worktree's data folder")
    for key, net in out["networks"].items():
        if "name" in net or net.get("external"):
            die(f"network {key} isn't the stack's own")


def maps_stub(state: Path) -> None:
    d = state / "maps-stub" / "stub"
    d.mkdir(parents=True, exist_ok=True)
    (state / "maps-stub" / "current").write_text("stub\n", encoding="utf-8")
    (d / "manifest.json").write_text(
        json.dumps({"built_at": "2026-11-01T00:00:00+00:00", "osm_data": "stack stub, no real map"}) + "\n",
        encoding="utf-8")
    (d / "basemap.pmtiles").write_text("stub, not a real map\n", encoding="utf-8")
    maps_offline_stub(d / "areas")


def maps_offline_stub(areas: Path) -> None:
    """P Maps offline areas (maps-offline): an index of a few squares with
    real-looking sizes, so saving an area shows its size. Only the index: the
    pack files aren't there, so phones can't download from a stub. Put real
    squares in ``areas/`` (it's kept) to test phone downloads."""
    if (areas / "index.json").exists():
        return
    areas.mkdir(parents=True, exist_ok=True)
    mb = 1_000_000

    def f(n: float) -> dict:
        return {"bytes": int(n * mb), "sha256": "0" * 64}

    # (map, route, places, house numbers) MB, as measured in WP-M1.
    sizes = {
        "148_-33": (6.0, 3.1, 0.4, 0.8), "149_-33": (5.2, 2.6, 0.3, 0.6), "148_-34": (4.1, 1.9, 0.2, 0.5),
        "149_-34": (7.3, 4.4, 0.5, 1.1), "150_-34": (24.0, 38.0, 3.6, 8.2), "151_-34": (52.0, 86.0, 7.9, 14.0),
        "150_-35": (8.0, 9.0, 1.2, 2.5), "151_-35": (14.0, 21.0, 2.8, 6.0), "149_-36": (26.0, 44.0, 2.5, 4.1),
    }
    cells = {}
    for cell, (m, r, p, a) in sizes.items():
        x, y = (int(v) for v in cell.split("_"))
        cells[cell] = {"box": [x, y, x + 1, y + 1], "l0": 1342, "files": {"map": f(m), "route": f(r), "places": f(p), "addresses": f(a)}}
    total = sum(e["bytes"] for c in cells.values() for e in c["files"].values())
    index = {
        "format": 1, "build": "stub", "built_at": "2026-11-01T00:00:00Z", "search": True, "cells": cells,
        "l0": {"1342": f(10.6)}, "base": {"cameras": f(0.096), "chargers": f(0.304)},
        "totals": {"squares": len(cells), "bytes": total + int(11.0 * mb)},
    }
    (areas / "index.json").write_text(json.dumps(index) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--main-root", default="")
    ap.add_argument("--with", dest="with_", default="")
    ap.add_argument("--e2e", action="store_true")
    ap.add_argument("--build-extras", action="store_true")
    opts = ap.parse_args()

    if not re.fullmatch(r"[a-z][a-z0-9]*(-[a-z0-9]+)*", opts.name) or len(opts.name) > 24:
        die("a stack name is lowercase letters and digits (dashes between), up to 24 characters")
    want = [w.strip() for w in opts.with_.split(",") if w.strip()]
    if "all" in want:
        want = [k for k in EXTRAS if k != "maps-full"]
    if opts.e2e:
        want += E2E_EXTRAS
    for w in want:
        if w not in EXTRAS:
            die(f"unknown --with {w!r}; choose from: {', '.join(EXTRAS)}, all")
    if "maps-full" in want and "maps" in want:
        want.remove("maps")
    opts.with_ = sorted(set(want))
    opts.maps = "full" if "maps-full" in opts.with_ else ("stub" if "maps" in opts.with_ else "none")

    state = Path(opts.state)
    state.mkdir(parents=True, exist_ok=True)
    meta_file = state / "stack.json"
    previous = None
    if meta_file.exists():
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        if norm(meta.get("worktree", "")) != norm(opts.worktree):
            die(f"stack {opts.name} belongs to {meta.get('worktree')}")
        previous = meta.get("port")

    # Another stack (or anything else) already using this container prefix.
    prefix = f"Promptly{camel(opts.name)}-"
    for line in docker("ps", "-a", "--format", '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "promptly.stack.worktree"}}').splitlines():
        cname, project, wt = (line.split("\t") + ["", "", ""])[:3]
        if not cname.startswith(prefix):
            continue
        if project != f"promptly-stack-{opts.name}":
            die(f"container {cname} already exists and isn't this stack's; pick another name")
        if wt and norm(wt) != norm(opts.worktree):
            die(f"stack {opts.name} already runs from {wt}; `stack.sh down {opts.name}` there first")

    opts.port = pick_port(opts.name, previous)

    opts.models_dir = ""
    if "photos-ml" in opts.with_ and opts.main_root:
        models = Path(opts.main_root) / "data" / "models"
        if models.is_dir() and norm(str(models)) != norm(str(Path(opts.worktree) / "data" / "models")):
            opts.models_dir = str(models)

    # Optional services' images the main app already built: reused as-is
    # (read only) unless --build-extras.
    opts.reuse = {}
    for svc in ("sandbox", "whisper", "tts", "photos-ml", "maps"):
        ref = f"promptly-{svc}:latest"
        if subprocess.run(["docker", "image", "inspect", ref], capture_output=True).returncode == 0:
            opts.reuse[svc] = ref

    env = write_env(state / "stack.env")
    if opts.maps == "stub":
        maps_stub(state)
    cfg = render_base(Path(opts.worktree), state / "stack.env")
    out = transform(cfg, opts, env)
    (state / "compose.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    meta_file.write_text(json.dumps({
        "name": opts.name,
        "project": out["name"],
        "prefix": prefix.rstrip("-"),
        "port": opts.port,
        "url": f"http://localhost:{opts.port}",
        "worktree": opts.worktree,
        "with": opts.with_,
        "services": sorted(out["services"]),
        "backend_image": f"promptly-backend:stack-{opts.name}",
    }, indent=2) + "\n", encoding="utf-8")
    print(f"PORT={opts.port}")


if __name__ == "__main__":
    main()
