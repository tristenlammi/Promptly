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


def _probe_nvidia() -> list[GPU] | None:
    """Return a list of NVIDIA GPUs visible to this process.

    Uses ``nvidia-smi --query-gpu=name,memory.total,memory.free``.
    ``None`` when the probe can't run at all — the normal case, since
    only the ollama-gpu container gets the GPU — so the caller can say
    "unknown" instead of a confident "no GPU" (R-279).
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
        return None
    if completed.returncode != 0:
        return None

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


async def _ollama_vram_bytes(base_url: str) -> int | None:
    """VRAM Ollama is using right now, from ``/api/ps`` (``size_vram`` per
    loaded model). The one GPU signal the backend can see from its own
    container. ``None`` when Ollama can't be reached."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{base_url}/api/ps")
            r.raise_for_status()
            models = r.json().get("models") or []
    except Exception:  # noqa: BLE001 — best-effort probe
        return None
    return sum(int(m.get("size_vram") or 0) for m in models if isinstance(m, dict))


async def probe_hardware(ollama_base_url: str) -> "HardwareProbe":
    # Lazy import to avoid a circular dependency with router.py which
    # owns the DTO definition.
    from app.local_models.router import HardwareProbe

    found = _probe_nvidia()
    gpus = found or []
    vram_in_use = await _ollama_vram_bytes(ollama_base_url)
    if gpus:
        gpu_status = "detected"
    elif vram_in_use:
        gpu_status = "in_use"
    elif found is not None:
        gpu_status = "none"  # nvidia-smi ran here and saw no device
    else:
        gpu_status = "unknown"
    return HardwareProbe(
        cpu_count=os.cpu_count() or 0,
        total_ram_bytes=_read_meminfo_total_bytes(),
        has_nvidia=len(gpus) > 0,
        gpu_status=gpu_status,
        ollama_vram_bytes=vram_in_use or 0,
        gpus=[
            {
                "name": g.name,
                "vram_total_bytes": g.vram_total_bytes,
                "vram_free_bytes": g.vram_free_bytes,
            }
            for g in gpus
        ],
    )
