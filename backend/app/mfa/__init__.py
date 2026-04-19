"""Native multi-factor authentication.

Public surface lives in :mod:`app.mfa.router` (HTTP endpoints) and
:mod:`app.mfa.service` (helpers used by the auth router on the login
hot path). Models / schemas / strategy modules are imported on demand
to keep startup cheap and avoid circular imports with the auth module.
"""
from __future__ import annotations
