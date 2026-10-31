"""Every item kind, found on its own: each package under ``app/items/kinds/``
exposes ``SPEC``. Adding an item never means editing a shared list."""
from __future__ import annotations

import importlib
import logging
import pkgutil
from functools import lru_cache

from app.items.spec import ItemSpec

logger = logging.getLogger("promptly.items.registry")

_extra: dict[str, ItemSpec] = {}


@lru_cache(maxsize=1)
def _discovered() -> dict[str, ItemSpec]:
    import app.items.kinds as pkg

    found: dict[str, ItemSpec] = {}
    for mod in pkgutil.iter_modules(pkg.__path__):
        if mod.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{pkg.__name__}.{mod.name}")
        except Exception:  # noqa: BLE001 — one broken item mustn't take the app down
            logger.exception("item kind %s failed to import", mod.name)
            continue
        spec = getattr(module, "SPEC", None)
        if not isinstance(spec, ItemSpec):
            logger.warning("item kind %s has no SPEC", mod.name)
            continue
        if spec.kind in found:
            logger.warning("item kind %s registered twice", spec.kind)
            continue
        found[spec.kind] = spec
    return found


def all_specs() -> dict[str, ItemSpec]:
    return {**_discovered(), **_extra}


def get_spec(kind: str | None) -> ItemSpec | None:
    if not kind:
        return None
    return all_specs().get(kind)


def register(spec: ItemSpec) -> None:
    """Add a kind at runtime (tests)."""
    _extra[spec.kind] = spec


def unregister(kind: str) -> None:
    _extra.pop(kind, None)


def kind_for_filename(filename: str | None) -> str | None:
    """The kind whose suffix ``filename`` ends with."""
    name = (filename or "").lower()
    for spec in all_specs().values():
        if name.endswith(spec.suffix.lower()):
            return spec.kind
    return None
