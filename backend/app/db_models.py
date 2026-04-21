"""Aggregator that imports every ORM model so `Base.metadata` is complete.

Alembic's `env.py` imports from this module so autogenerate and migration
runs see all tables regardless of whether they are referenced elsewhere.
"""
from __future__ import annotations

from app.app_settings.models import AppSettings  # noqa: F401
from app.auth.events import AuthEvent  # noqa: F401
from app.auth.models import User  # noqa: F401
from app.billing.models import UsageDaily  # noqa: F401
from app.chat.models import (  # noqa: F401
    ChatProject,
    ChatProjectFile,
    CompareGroup,
    Conversation,
    Message,
)
from app.files.models import FileFolder, UserFile  # noqa: F401
from app.mfa.models import (  # noqa: F401
    EmailOtpChallenge,
    MfaBackupCode,
    MfaTrustedDevice,
    UserMfaSecret,
)
from app.models_config.models import ModelProvider  # noqa: F401
from app.notifications.models import PushPreferences, PushSubscription  # noqa: F401
from app.search.models import SearchProvider  # noqa: F401
from app.study.models import (  # noqa: F401
    StudyExam,
    StudyMessage,
    StudyProject,
    StudySession,
    StudyUnit,
    WhiteboardExercise,
)
