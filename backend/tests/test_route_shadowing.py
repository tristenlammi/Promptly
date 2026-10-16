"""No route is unreachable because an earlier one swallows its path (R-024).

Starlette matches routes in registration order, so ``POST /files/{file_id}/trash``
registered before ``POST /files/bulk/trash`` routes every bulk request to the
single-file handler, which then rejects ``file_id='bulk'`` with a 422. That
broke bulk Trash and bulk Restore for months without anyone noticing. This
walks the real route table so the next one fails here instead.
"""
from __future__ import annotations

from starlette.routing import Match, Route


def _routes() -> list[Route]:
    # Imported here, not at module level: importing the app configures
    # logging, and doing that while pytest collects breaks log capture for
    # every test that runs before this one.
    from app.main import app

    return [r for r in app.router.routes if isinstance(r, Route)]


def test_no_route_is_shadowed_by_an_earlier_one():
    routes = _routes()
    shadowed: list[str] = []
    for i, later in enumerate(routes):
        if later.param_convertors:
            continue  # only literal paths can be shadowed this way
        for earlier in routes[:i]:
            methods = (earlier.methods or set()) & (later.methods or set())
            if not methods - {"HEAD"}:
                continue
            scope = {"type": "http", "path": later.path, "method": sorted(methods)[0]}
            match, _ = earlier.matches(scope)
            if match == Match.FULL:
                shadowed.append(f"{sorted(methods)} {later.path} <- {earlier.path}")
                break
    assert not shadowed, "routes swallowed by an earlier route:\n" + "\n".join(shadowed)
