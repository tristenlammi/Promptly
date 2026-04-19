"""Single-row global runtime configuration.

Houses settings the admin can change from the UI without a restart:
the MFA master switch, SMTP credentials, and (in future) other
feature flags. Stored encrypted at rest where appropriate.

Always exactly one row, with id = ``SINGLETON_APP_SETTINGS_ID``.
"""
from __future__ import annotations

from app.app_settings.models import SINGLETON_APP_SETTINGS_ID, AppSettings

__all__ = ["AppSettings", "SINGLETON_APP_SETTINGS_ID"]
