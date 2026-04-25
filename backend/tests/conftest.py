"""Shared pytest configuration for the backend suite.

Ensures the FastAPI app's top-level ``app`` package is importable when
pytest is invoked from the repo root (via ``pytest backend/tests``)
rather than from inside the ``backend/`` directory. ``asyncio_mode =
auto`` lives in ``pytest.ini`` so every ``async def test_*`` runs
without per-test ``@pytest.mark.asyncio`` ceremony.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
