"""Hardware probe for the Local Models tab.

Feeds the "will this run on your box?" badge. Probes:

- **RAM** via ``/proc/meminfo``. Always available on Linux; on a
  non-Linux host (e.g. the backend container running on Docker
  Desktop for Mac) we fall back to ``psutil`` if installed, else
  return 0 so the UI hides the hint.
- **CPU count** via ``os.cpu_count``.
- **NVIDIA GPU(s)** via ``nvidia-smi``. The binary is only present
  inside the ``ollama-gpu`` container (which has the NVIDIA runtime
  injected by the Container Toolkit). Running from the backend
  container we shell out over SSH? No — we exec it *inside* the
  ollama container via a hosted ``/api/show`` hack? Also no.
  Upstream Ollama's ``/api/show`` and ``/api/version`` don't return
  VRAM. Instead we try ``nvidia-smi`` directly — if the backend
  container has GPU access (e.g. you bolted on
  ``--gpus all`` later) it works; otherwise we quietly return
  ``has_nvidia=False`` and let the UI warn "GPU status unknown".
"""
from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass
class GPU:
    name: str
    vram_total_bytes: int
    vram_free_bytes: int


def _read_meminfo_total_bytes() -> int:
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    # e.g. "MemTotal:       16342168 kB"
                    parts = line.split()
                    if len(parts) >= 2:
                        return int(parts[1]) * 1024
    except OSError:
        pass
    return 0


def _probe_nvidia() -> list[GPU]:
    """Return a list of NVIDIA GPUs visible to this process.

    Uses ``nvidia-smi --query-gpu=name,memory.total,memory.free``.
    Empty list on any error — we treat the probe as best-effort.
    """
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []
    if completed.returncode != 0:
        return []

    gpus: list[GPU] = []
    for raw in completed.stdout.strip().splitlines():
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) != 3:
            continue
        name, total_mib, free_mib = parts
        try:
            total = int(total_mib) * 1024 * 1024
            free = int(free_mib) * 1024 * 1024
        except ValueError:
            continue
        gpus.append(GPU(name=name, vram_total_bytes=total, vram_free_bytes=free))
    return gpus


def probe_hardware() -> "HardwareProbe":
    # Lazy import to avoid a circular dependency with router.py which
    # owns the DTO definition.
    from app.local_models.router import HardwareProbe

    gpus = _probe_nvidia()
    return HardwareProbe(
        cpu_count=os.cpu_count() or 0,
        total_ram_bytes=_read_meminfo_total_bytes(),
        has_nvidia=len(gpus) > 0,
        gpus=[
            {
                "name": g.name,
                "vram_total_bytes": g.vram_total_bytes,
                "vram_free_bytes": g.vram_free_bytes,
            }
            for g in gpus
        ],
    )
