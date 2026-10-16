"""Which credential the current request came in with (WP-7.2).

"session:<sid>" for a sign-in session (the ``sid`` claim every token of that
session carries), later "app_password:<id>" for WebDAV / sync clients. The
mass-delete guard counts what one credential deleted, and "restore everything
this device deleted" undoes it. Request-scoped via a contextvar, set by the
auth dependency.
"""
from __future__ import annotations

from contextvars import ContextVar

_credential: ContextVar[str | None] = ContextVar("promptly_credential", default=None)


def set_credential(value: str | None) -> None:
    _credential.set(value)


def current_credential() -> str | None:
    return _credential.get()


__all__ = ["current_credential", "set_credential"]
