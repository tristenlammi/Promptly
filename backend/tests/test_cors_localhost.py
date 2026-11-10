"""CORS allows the localhost defaults only until a public address is set (L4)."""
from __future__ import annotations

import pytest

from app import cors_dynamic


@pytest.fixture(autouse=True)
def _fresh_cache():
    cors_dynamic.invalidate_cache()
    yield
    cors_dynamic.invalidate_cache()


async def _origins(monkeypatch, *, env: str, db: list[str], debug: bool = False):
    from app.config import get_settings

    async def _load():
        return frozenset(db)

    monkeypatch.setattr(get_settings(), "ALLOWED_ORIGINS", env)
    monkeypatch.setattr(get_settings(), "DEBUG", debug)
    monkeypatch.setattr(cors_dynamic, "_load_origins_from_db", _load)
    return await cors_dynamic._resolve_allowed_origins()


async def test_a_fresh_install_allows_localhost(monkeypatch):
    got = await _origins(monkeypatch, env="http://localhost", db=[])
    assert "http://localhost:8087" in got


async def test_a_public_address_turns_localhost_off(monkeypatch):
    got = await _origins(monkeypatch, env="http://localhost", db=["https://promptly.example.com"])
    assert "https://promptly.example.com" in got
    assert "http://localhost:8087" not in got and "http://127.0.0.1" not in got


async def test_debug_keeps_localhost(monkeypatch):
    got = await _origins(monkeypatch, env="", db=["https://promptly.example.com"], debug=True)
    assert "http://localhost:8087" in got
