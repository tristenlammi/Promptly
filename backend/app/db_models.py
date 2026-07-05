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
    CompareGroup,
    Conversation,
    ConversationExcludedWorkspaceFile,
    Message,
    MessageEmbedding,
    Workspace,
    WorkspaceCanvas,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceShare,
)
from app.custom_models.models import (  # noqa: F401
    CustomModel,
    CustomModelFile,
    KnowledgeChunk,
)
from app.files.models import (  # noqa: F401
    DocumentState,
    FileFolder,
    FileShareGrant,
    FileShareLink,
    UserFile,
)
from app.groups.models import UserGroup, UserGroupMember  # noqa: F401
from app.mcp.models import (  # noqa: F401
    ConnectorGroup,
    ConnectorUser,
    McpConnector,
    WorkspaceMcpConnector,
)
from app.memory.models import UserMemory  # noqa: F401
from app.mfa.models import (  # noqa: F401
    EmailOtpChallenge,
    MfaBackupCode,
    MfaTrustedDevice,
    UserMfaSecret,
)
from app.models_config.models import ModelProvider  # noqa: F401
from app.notifications.models import PushPreferences, PushSubscription  # noqa: F401
from app.search.models import SearchProvider  # noqa: F401
from app.secrets.models import UserSecret  # noqa: F401
from app.tasks.models import Task, TaskConnector, TaskRun  # noqa: F401
from app.workspaces.meetings_models import MeetingJob  # noqa: F401
from app.study.models import (  # noqa: F401
    StudyExam,
    StudyMessage,
    StudyProject,
    StudySession,
    StudyUnit,
    WhiteboardExercise,
)
