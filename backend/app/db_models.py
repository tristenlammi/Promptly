"""Aggregator that imports every ORM model so `Base.metadata` is complete.

Alembic's `env.py` imports from this module so autogenerate and migration
runs see all tables regardless of whether they are referenced elsewhere.
"""
from __future__ import annotations

from app.app_settings.models import AppSettings  # noqa: F401
from app.auth.events import AuthEvent  # noqa: F401
from app.auth.app_passwords import AppPassword  # noqa: F401
from app.photos.models import PhotoAsset  # noqa: F401
from app.photos.album_models import Album, AlbumItem, AlbumMember  # noqa: F401
from app.imports.models import FileImportMeta, ImportJob  # noqa: F401
from app.auth.models import User  # noqa: F401
from app.billing.models import UsageDaily  # noqa: F401
from app.chat.models import (  # noqa: F401
    ChatFolder,
    CompareGroup,
    Conversation,
    ConversationExcludedWorkspaceFile,
    DiscussionMessage,
    DiscussionThread,
    Message,
    MessageEmbedding,
    Workspace,
    WorkspaceCanvas,
    WorkspaceFile,
    WorkspaceItem,
    WorkspaceShare,
)
from app.commands.models import Command, CommandRun  # noqa: F401
from app.custom_models.models import (  # noqa: F401
    CustomModel,
    CustomModelFile,
    KnowledgeChunk,
)
from app.backups.models import BackupRun, OffsiteBackupConfig  # noqa: F401
from app.files.models import (  # noqa: F401
    BlobTombstone,
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
from app.notifications.models import PushHeld, PushPreferences, PushSubscription  # noqa: F401
from app.people.blocks import UserBlock  # noqa: F401
from app.porch.models import (  # noqa: F401
    PorchGroup,
    PorchGroupMember,
    PorchPost,
    PorchPostGroup,
    PorchPostMedia,
    PorchProfile,
)
from app.search.models import SearchProvider  # noqa: F401
from app.secrets.models import UserSecret  # noqa: F401
from app.items.models import ItemDocument, ItemInstall, ItemReminder, ItemState  # noqa: F401
from app.rooms.models import (  # noqa: F401
    Room,
    RoomAttachment,
    RoomMember,
    RoomMessage,
    RoomReaction,
    RoomSpace,
    RoomSpaceMember,
)
from app.mail.models import (  # noqa: F401
    MailAccount,
    MailFolder,
    MailInvite,
    MailLabel,
    MailMessage,
    MailOp,
    MailOutbox,
    MailRule,
    MailSnooze,
    MailThreadLabel,
)
from app.mail.alias_models import MailAlias, MailAliasDomain, MailAliasHit  # noqa: F401
from app.passwords.models import (  # noqa: F401
    PwAccount,
    PwActivity,
    PwAttachment,
    PwConnect,
    PwDevice,
    PwDeviceRequest,
    PwEmergency,
    PwHealth,
    PwItem,
    PwItemVersion,
    PwSend,
    PwSession,
    PwSettings,
    PwVault,
    PwVaultMember,
)
from app.passwords.accounts_models import PwMailScan, PwMailSite  # noqa: F401
from app.passwords.reminder_models import PwReminder  # noqa: F401
from app.breach_watch.models import (  # noqa: F401
    BreachAddress,
    BreachCatalog,
    BreachConfig,
    BreachHit,
    BreachWatch,
)
from app.passwords.sync_models import PwSyncRecord, PwSyncState  # noqa: F401
from app.maps.models import (  # noqa: F401
    MapLiveLocation,
    MapOfflineArea,
    MapParked,
    MapPlace,
    MapPreferredRoute,
    MapRecent,
    MapShare,
    MapTrackPoint,
)
from app.calendars.models import (  # noqa: F401
    CalAttendee,
    CalCalendar,
    CalEvent,
    CalEventRoom,
    CalEventSnooze,
    CalExternalGuest,
    CalFeed,
    CalMember,
    CalReminderSent,
    CalRoomReminderSent,
)
from app.tags.models import Tag, TagAssignment  # noqa: F401
from app.tasks.models import Task, TaskConnector, TaskRun  # noqa: F401
from app.trash.models import TrashEntry  # noqa: F401
from app.links.models import EntityLink  # noqa: F401
from app.today.models import RecentOpen  # noqa: F401
from app.workspaces.meetings_models import MeetingJob  # noqa: F401
# Forms (WP-F1.1).
from app.forms.models import Form, FormNotify, FormOptionCount, FormReport, FormResponse, FormUpload  # noqa: F401
# Calls (voice channels): channel settings and voice-session history (0281).
from app.calls.models import Call, CallParticipant, RoomVoice  # noqa: F401
# Talking to Promptly (WP-T2): per-turn timings.
from app.talk.models import TalkMetric  # noqa: F401
# --- Notes (0261_notes_core) ---
from app.notes.models import (  # noqa: F401
    Note,
    NoteAttachment,
    NoteItem,
    NoteMember,
    NoteReminder,
    NoteUserState,
    NoteVersion,
)
