"""Per-user spend tracking and budget enforcement (Phase 3).

This package bundles:

* The ``UsageDaily`` ORM rollup (one row per user/day) so budget checks
  cost a single indexed range scan instead of summing the entire
  ``messages`` table.
* Helpers to fold a finished stream's token usage into that rollup,
  enforce daily/monthly caps, and fire an admin email when a user
  crosses 80% of their monthly budget.
"""
from __future__ import annotations
