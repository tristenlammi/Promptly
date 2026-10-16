"""Promptly's own services — never a target for user-directed requests.

Automation HTTP steps that may reach the local network (an admin's, or a
user an admin allowed) still can't call these: the database, Redis, the
code sandbox, the unauthenticated Ollama / Whisper / TTS admin APIs. They
are refused by name and by every address the names resolve to (R-015).
"""
from __future__ import annotations

INTERNAL_HOSTS: frozenset[str] = frozenset(
    {
        # docker-compose service names (resolvable on the promptly network)
        "backend", "arq-worker", "collab", "frontend", "nginx",
        "postgres", "redis", "sandbox", "searxng",
        "ollama", "ollama-gpu", "ollama-rocm", "whisper", "tts",
        # container names
        "promptly-backend", "promptly-arqworker", "promptly-collab",
        "promptly-frontend", "promptly-nginx", "promptly-postgres",
        "promptly-redis", "promptly-sandbox", "promptly-searxng",
        "promptly-ollama", "promptly-ollama-gpu", "promptly-ollama-rocm",
        "promptly-whisper", "promptly-tts",
    }
)


def may_reach_private_network(user) -> bool:
    """Admins, or users an admin has allowed (``can_reach_private_network``)."""
    return getattr(user, "role", None) == "admin" or bool(
        getattr(user, "can_reach_private_network", False)
    )
