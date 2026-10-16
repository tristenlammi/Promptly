"""The Local Models hardware probe (R-279).

The backend container can't see the GPU (only ollama-gpu gets it), so the
old probe always said "no NVIDIA GPU — set COMPOSE_PROFILES=gpu", even on
GPU installs.
"""
from __future__ import annotations

import app.local_models.hardware as hw


async def _vram(n):
    async def _f(_base):
        return n
    return _f


async def test_no_nvidia_smi_means_unknown_not_none(monkeypatch):
    monkeypatch.setattr(hw, "_probe_nvidia", lambda: None)
    monkeypatch.setattr(hw, "_ollama_vram_bytes", await _vram(0))

    probe = await hw.probe_hardware("http://ollama:11434")

    assert probe.gpu_status == "unknown"
    assert probe.has_nvidia is False


async def test_ollama_vram_shows_the_gpu_in_use(monkeypatch):
    monkeypatch.setattr(hw, "_probe_nvidia", lambda: None)
    monkeypatch.setattr(hw, "_ollama_vram_bytes", await _vram(6 * 1024**3))

    probe = await hw.probe_hardware("http://ollama:11434")

    assert probe.gpu_status == "in_use"
    assert probe.ollama_vram_bytes == 6 * 1024**3


async def test_nvidia_smi_seeing_nothing_is_a_real_none(monkeypatch):
    monkeypatch.setattr(hw, "_probe_nvidia", lambda: [])
    monkeypatch.setattr(hw, "_ollama_vram_bytes", await _vram(None))

    probe = await hw.probe_hardware("http://ollama:11434")

    assert probe.gpu_status == "none"
