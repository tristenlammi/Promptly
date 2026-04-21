"""Web Push notification primitives.

Exposes the bare minimum at the package level:

* :data:`CATEGORIES` — the tuple of category ids the rest of the app
  may dispatch on. Keeping this here makes typos caught at call-site
  import time instead of "notification silently ignored" later.
* :func:`notify_user` — fire-and-forget dispatch helper.

Everything else (models, schemas, the router) lives in submodules
so the import graph stays shallow."""
from __future__ import annotations

from app.notifications.dispatch import CATEGORIES, notify_user

__all__ = ["CATEGORIES", "notify_user"]
