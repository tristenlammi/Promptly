"""Rewrite stored request paths to route templates (admin privacy, AP1).

Errors and rate-limit audit rows used to store the raw request path. Some
paths carry a secret (a device pairing code, a calendar feed token, a
signed media link, a share / album / form link, a webhook secret) or a
person's content (WebDAV file names, map tile coordinates), and Admin →
Errors and Admin → Audit showed them (audit L3-L7). The app now stores the
matched route's template, e.g. ``GET /api/calendar/feed/{token}.ics``.

This rewrites what's already stored:

* ``error_events.route`` (``METHOD /path``): to ``METHOD /template``. A row
  whose path matches no route of this version is deleted: it can't be told
  apart from one that holds a secret, and old errors are diagnostics only.
* ``auth_events.detail`` of ``rate_limited`` rows (``path=/x bucket=y``):
  the path becomes its template, or ``[removed]``. The row itself stays,
  because it's a security record (which address was throttled, and when).

The route table below is frozen from this release (``METHODS path``, in the
app's matching order; ``*`` is WebDAV's method set), so later route changes
can't change what this migration does. Matching uses Starlette's own path
compiler. Only counts are logged.

Revision ID: 0402_scrub_error_routes
Revises: 0403_cm_foreign_files
"""
import logging
import re

from alembic import op
from sqlalchemy import text

revision = "0402_scrub_error_routes"
down_revision = "0403_cm_foreign_files"
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

_ROUTES = """
GET /api/health
GET /api/health/live
GET /api/auth/setup-status
GET /api/auth/sso-status
GET /api/auth/oidc/login
GET /api/auth/oidc/callback
POST /api/auth/oidc/pending
POST /api/auth/setup
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
POST /api/auth/logout-everywhere
GET /api/auth/password-policy
POST /api/auth/forgot-password
POST /api/auth/reset-password
GET /api/auth/me
POST /api/auth/me/password
GET /api/auth/users/directory
PATCH /api/auth/me/preferences
PATCH /api/auth/me/profile
DELETE,POST /api/auth/me/avatar
GET /api/auth/avatar/{user_id}
GET /api/auth/mfa/status
POST /api/auth/mfa/verify
POST /api/auth/mfa/email/send
POST /api/auth/mfa/setup/totp
POST /api/auth/mfa/setup/totp/forced
POST /api/auth/mfa/setup/totp/verify
POST /api/auth/mfa/setup/totp/verify/forced
POST /api/auth/mfa/setup/email
POST /api/auth/mfa/setup/email/forced
POST /api/auth/mfa/setup/email/verify
POST /api/auth/mfa/setup/email/verify/forced
POST /api/auth/mfa/backup-codes/regenerate
POST /api/auth/mfa/disable
DELETE,GET /api/auth/mfa/trusted-devices
DELETE /api/auth/mfa/trusted-devices/{device_id}
GET /api/admin/analytics/summary
GET /api/admin/analytics/timeseries
GET /api/admin/analytics/users
GET /api/admin/analytics/by-model
GET /api/admin/analytics/feedback
GET /api/admin/analytics/feedback/notes
GET /api/admin/analytics/users/{user_id}/timeseries
GET /api/admin/logs/stream
GET /api/admin/metrics
GET /api/admin/errors/groups
GET /api/admin/errors/groups/{fingerprint}/events
GET /api/admin/errors/{event_id}
POST /api/admin/errors/groups/{fingerprint}/resolve
POST /api/admin/errors/groups/{fingerprint}/reopen
GET,POST /api/admin/users
GET /api/admin/users/export
POST /api/admin/users/import
GET /api/admin/users/import/{job_id}
DELETE,PATCH /api/admin/users/{user_id}
GET /api/admin/users/{user_id}/deletion-preview
GET /api/admin/model-pool
GET /api/admin/users/locked
POST /api/admin/users/{user_id}/unlock
POST /api/admin/users/{user_id}/disable
POST /api/admin/users/{user_id}/enable
POST /api/admin/users/{user_id}/logout-everywhere
POST /api/admin/users/{user_id}/reset-password
POST /api/admin/users/{user_id}/reset-mfa
GET /api/admin/users/{user_id}/usage
GET /api/admin/auth-events
GET /api/admin/auth-events.csv
GET /api/admin/backups
PUT /api/admin/backups/offsite
POST /api/admin/backups/offsite/test
POST /api/admin/backups/offsite/{action}
POST /api/admin/backups/run
GET /api/admin/storage/health
POST /api/admin/storage/check
POST /api/admin/storage/files/{file_id}/recheck
POST /api/admin/storage/understanding/retry
POST /api/admin/storage/media/retry
POST /api/admin/storage/quarantine/empty
GET,PATCH /api/admin/app-settings
POST /api/admin/app-settings/preview-origin
GET /api/admin/app-settings/email-autoconfig
POST /api/admin/app-settings/test-email
GET /api/workspace-defaults
GET,POST /api/chat/folders
DELETE,PATCH /api/chat/folders/{folder_id}
GET /api/chat/conversations/search
GET /api/chat/conversations/{conversation_id}/workspace-files
PUT /api/chat/conversations/{conversation_id}/workspace-files/{file_id}
GET /api/chat/conversations/mention-candidates
GET,POST /api/chat/conversations
DELETE,GET,PATCH /api/chat/conversations/{conversation_id}
POST /api/chat/conversations/{conversation_id}/messages/{message_id}/activate
POST /api/chat/conversations/{conversation_id}/branch
POST /api/chat/conversations/{conversation_id}/archive
POST /api/chat/conversations/{conversation_id}/unarchive
POST /api/chat/conversations/{conversation_id}/messages
POST /api/chat/conversations/{conversation_id}/messages/{message_id}/edit
DELETE,PATCH /api/chat/conversations/{conversation_id}/messages/{message_id}
PUT /api/chat/conversations/{conversation_id}/messages/{message_id}/feedback
POST /api/chat/conversations/{conversation_id}/messages/{message_id}/regenerate
POST /api/chat/conversations/{conversation_id}/messages/{message_id}/continue
POST /api/chat/enhance-prompt
POST /api/chat/edit-artifact
POST /api/chat/conversations/{conversation_id}/compact
POST /api/chat/conversations/{conversation_id}/summarise-to-workspace
GET /api/chat/stream/{stream_id}
GET /api/chat/conversations/{conversation_id}/export
GET /api/chat/exports/conversations
POST /api/chat/conversations/import
GET /api/chat/conversations/{conversation_id}/active-stream
POST /api/chat/stream/{stream_id}/stop
GET /api/chat/_ping
POST /api/chat/messages/{message_id}/tool-calls/{call_id}/approval
GET,PUT /api/chat/conversations/{conversation_id}/connectors
GET /api/chat/conversations/{conversation_id}/proposals
POST /api/chat/proposals/{proposal_id}/dismiss
POST /api/chat/proposals/{proposal_id}/apply
POST /api/hooks/{task_id}/{secret}
GET,POST /api/feedback
GET,POST /api/workspaces
GET /api/workspaces/templates
GET /api/workspaces/my-shifts
POST /api/workspaces/my-shifts/calendar-link
GET /api/workspaces/my-shifts.ics
GET /api/workspaces/my-work
DELETE,GET,PATCH /api/workspaces/{workspace_id}
GET /api/workspaces/{workspace_id}/events
POST /api/workspaces/{workspace_id}/duplicate
POST /api/workspaces/{workspace_id}/restore
POST /api/workspaces/{workspace_id}/transfer
POST /api/workspaces/{workspace_id}/archive
POST /api/workspaces/{workspace_id}/unarchive
DELETE,GET /api/workspaces/{workspace_id}/conversations
GET /api/workspaces/{workspace_id}/usage
POST /api/workspaces/{workspace_id}/reindex
POST /api/workspaces/{workspace_id}/files
PATCH /api/workspaces/{workspace_id}/files/{file_id}/context
DELETE /api/workspaces/{workspace_id}/files/{file_id}
DELETE,POST /api/workspaces/{workspace_id}/conversations/{conversation_id}
GET /api/workspaces/{workspace_id}/tree
POST /api/workspaces/{workspace_id}/items
POST /api/workspaces/{workspace_id}/items/{item_id}/duplicate
GET /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}/export
POST /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}/import
GET /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}/versions
GET /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}/versions/{version_id}
POST /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}/versions/checkpoint
GET,PUT /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}
GET,PUT /api/workspaces/{workspace_id}/rosters/{roster_id}
POST /api/workspaces/{workspace_id}/rosters/{roster_id}/publish
GET /api/workspaces/{workspace_id}/spreadsheets/{sheet_id}/collab-token
GET /api/workspaces/{workspace_id}/map
GET,PUT /api/workspaces/{workspace_id}/memory
POST /api/workspaces/{workspace_id}/memory/regenerate
POST /api/workspaces/{workspace_id}/memory/append
DELETE,GET,PATCH /api/workspaces/{workspace_id}/items/{item_id}
PATCH /api/workspaces/{workspace_id}/chats/{conversation_id}/context
POST /api/workspaces/{workspace_id}/items/{item_id}/move
POST /api/workspaces/{workspace_id}/chats/{conversation_id}/place
POST /api/workspaces/{workspace_id}/tasks/{task_id}/place
POST /api/workspaces/{workspace_id}/items/{item_id}/archive
POST /api/workspaces/{workspace_id}/items/{item_id}/unarchive
GET /api/workspaces/{workspace_id}/archived-items
GET /api/workspaces/{workspace_id}/items/{item_id}/backlinks
POST /api/workspaces/{workspace_id}/items/note-from-template
GET /api/workspaces/{workspace_id}/trash
POST /api/workspaces/{workspace_id}/trash/{item_id}/restore
DELETE /api/workspaces/{workspace_id}/trash/{item_id}
GET /api/workspaces/{workspace_id}/drive
POST /api/workspaces/{workspace_id}/drive/files
POST /api/workspaces/{workspace_id}/drive/folders
DELETE,PATCH /api/workspaces/{workspace_id}/drive/folders/{folder_id}
POST /api/workspaces/{workspace_id}/drive/files/{file_id}/move
GET /api/canvas/{canvas_id}
GET /api/canvas/{canvas_id}/collab-token
POST /api/canvas/{canvas_id}/text
POST /api/canvas/remove-background
POST /api/workspaces/{workspace_id}/ask
GET /api/workspaces/{workspace_id}/search
GET /api/workspaces/{workspace_id}/items/{item_id}/related
GET /api/workspaces/{workspace_id}/overview
GET /api/workspaces/{workspace_id}/activity
GET,POST /api/workspaces/{workspace_id}/tasks
DELETE,PATCH /api/workspaces/{workspace_id}/tasks/{task_id}
GET,POST /api/workspaces/{workspace_id}/tasks/{task_id}/comments
DELETE /api/workspaces/{workspace_id}/tasks/{task_id}/comments/{comment_id}
POST /api/workspaces/{workspace_id}/tasks/{task_id}/attachments
POST /api/workspaces/{workspace_id}/tasks/{task_id}/attachments/{file_id}/cover
DELETE /api/workspaces/{workspace_id}/tasks/{task_id}/attachments/{file_id}
GET,POST /api/workspaces/{workspace_id}/items/{item_id}/comments
POST /api/workspaces/{workspace_id}/items/{item_id}/comments/{comment_id}/resolve
DELETE,PATCH /api/workspaces/{workspace_id}/items/{item_id}/comments/{comment_id}
GET /api/workspaces/{workspace_id}/discussions/{item_id}/events
GET,POST /api/workspaces/{workspace_id}/discussions/{item_id}/threads
DELETE /api/workspaces/{workspace_id}/threads/{thread_id}
GET,POST /api/workspaces/{workspace_id}/threads/{thread_id}/messages
DELETE,PATCH /api/workspaces/{workspace_id}/messages/{message_id}
GET,POST /api/workspaces/{workspace_id}/meetings
GET /api/workspaces/{workspace_id}/meetings/{job_id}
GET /api/workspaces/{workspace_id}/meetings/{job_id}/transcript
POST /api/workspaces/{workspace_id}/meetings/{job_id}/retry
POST /api/workspaces/{workspace_id}/meetings/{job_id}/cancel
POST /api/workspaces/{workspace_id}/export-link
GET /api/workspaces/{workspace_id}/export/download
GET /api/workspaces/{workspace_id}/export
POST /api/workspaces/import
GET /api/workspace-search
GET,POST /api/secrets
DELETE,PUT /api/secrets/{secret_id}
GET /api/admin/mcp/workspaces
GET,POST /api/admin/mcp/connectors
DELETE,PATCH /api/admin/mcp/connectors/{connector_id}
POST /api/admin/mcp/connectors/{connector_id}/refresh
POST /api/admin/mcp/test
GET,PUT /api/workspaces/{workspace_id}/connectors
GET,POST /api/admin/groups
DELETE,PATCH /api/admin/groups/{group_id}
PUT /api/admin/groups/{group_id}/members
GET,POST /api/workspaces/{workspace_id}/shares
DELETE,PATCH /api/workspaces/{workspace_id}/shares/{share_id}
GET /api/workspace-share-invites
POST /api/workspace-share-invites/{share_id}/accept
POST /api/workspace-share-invites/{share_id}/decline
GET /api/models/
GET /api/models
POST /api/models/providers
DELETE,PATCH /api/models/providers/{provider_id}
POST /api/models/providers/{provider_id}/test
POST /api/models/providers/{provider_id}/fetch-models
GET /api/models/available
GET /api/links/unfurl
GET,POST /api/admin/custom-models/
GET,POST /api/admin/custom-models
GET,PUT /api/admin/custom-models/embedding-config
POST /api/admin/custom-models/embedding-config/test
DELETE,GET,PATCH /api/admin/custom-models/{custom_model_id:uuid}
POST /api/admin/custom-models/{custom_model_id:uuid}/files
DELETE /api/admin/custom-models/{custom_model_id:uuid}/files/{user_file_id:uuid}
POST /api/admin/custom-models/{custom_model_id:uuid}/files/{user_file_id:uuid}/reindex
GET /api/admin/custom-models/embedding-models/known
GET /api/admin/custom-models/local-embedding-status
POST /api/admin/custom-models/bootstrap-local-embedding
GET /api/admin/local-models/installed
GET /api/admin/local-models/hardware
DELETE /api/admin/local-models/installed/{name:path}
POST /api/admin/local-models/pull
POST /api/admin/local-models/refresh-provider
GET,POST /api/tasks
GET /api/tasks/connectors/available
POST /api/tasks/{task_id}/duplicate
POST /api/tasks/{task_id}/webhook/rotate
DELETE,GET,PATCH /api/tasks/{task_id}
POST /api/tasks/{task_id}/run
GET,PUT /api/tasks/{task_id}/graph
DELETE,GET,POST,PUT /api/tasks/{task_id}/graph/draft
POST /api/tasks/{task_id}/promote
GET /api/tasks/{task_id}/graph/versions
POST /api/tasks/{task_id}/graph/versions/{version_id}/restore
POST /api/tasks/{task_id}/graph/test
POST /api/tasks/{task_id}/graph/explain
POST /api/tasks/{task_id}/runs/{run_id}/diagnose
GET /api/tasks/{task_id}/memory
DELETE /api/tasks/{task_id}/memory/{node_id}
GET /api/tasks/{task_id}/runs
DELETE,GET /api/tasks/{task_id}/runs/{run_id}
POST /api/tasks/{task_id}/runs/{run_id}/to-chat
GET /api/tasks/{task_id}/runs/{run_id}/pdf
DELETE,GET,POST /api/memory
DELETE,PATCH /api/memory/{memory_id}
GET /api/memory/people-links
GET,PUT /api/memory/learning
POST /api/memory/learning/check
GET /api/memory/suggestions
GET /api/memory/past
POST /api/memory/{memory_id}/approve
POST /api/memory/{memory_id}/dismiss
POST /api/memory/{memory_id}/restore
GET /api/memory/{memory_id}/history
POST /api/memory/{memory_id}/history/{version_id}/restore
POST /api/memory/read-older-chats
GET /api/memory/profile
POST /api/memory/profile/rebuild
POST /api/memory/consolidate
GET /api/memory/export
POST /api/memory/import
POST /api/memory/instruct
POST /api/memory/instruct/apply
GET,POST /api/commands
DELETE,PATCH /api/commands/{command_id}
GET /api/commands/tools
GET /api/commands/tools/{connector_id}/devices
POST /api/commands/match
GET /api/commands/history
POST /api/commands/{command_id}/run
POST /api/voice/transcribe
POST /api/voice/tts
GET /api/usage/me/summary
GET /api/usage/me/timeseries
GET /api/usage/me/by-model
POST /api/conversations/{conversation_id}/research
POST /api/conversations/{conversation_id}/research/refine
POST /api/research/classify
GET /api/research/config
POST /api/code/run
GET,POST /api/search/providers
DELETE,PATCH /api/search/providers/{provider_id}
POST /api/search/providers/reorder
POST /api/search/providers/{provider_id}/resume
POST /api/search/run
GET /api/search/_ping
GET /api/files/browse
GET,POST /api/files/folders
GET /api/files/folders/all
DELETE,PATCH /api/files/folders/{folder_id:uuid}
GET /api/files/upload-policy
POST /api/files/precheck
GET /api/files/quota
POST /api/files/
DELETE,GET,PATCH /api/files/{file_id:uuid}
GET /api/files/{file_id:uuid}/download
GET,PUT /api/files/{file_id:uuid}/thumbnail
GET,PUT /api/files/{file_id:uuid}/source
POST /api/files/{file_id:uuid}/trash
POST /api/files/{file_id:uuid}/restore
POST /api/files/folders/{folder_id:uuid}/trash
POST /api/files/folders/{folder_id:uuid}/restore
POST /api/files/bulk/trash
GET,POST /api/files/trash/restore-device
POST /api/files/bulk/restore
POST /api/files/bulk/purge
POST /api/files/bulk/move
POST /api/files/bulk/star
POST /api/files/bulk/unstar
POST /api/files/bulk/zip
GET /api/files/zips/{job_id}
DELETE,GET /api/files/trash
DELETE,POST /api/files/{file_id:uuid}/star
DELETE,POST /api/files/folders/{folder_id:uuid}/star
GET /api/files/starred
GET /api/files/recent
GET /api/files/search
GET /api/files/users/search
DELETE,GET,POST /api/files/{resource_type}/{resource_id}/grants
DELETE,PATCH /api/files/{resource_type}/{resource_id}/grants/{grant_id}
POST /api/files/files/{file_id:uuid}/copy-to-mine
GET,POST /api/files/{file_id:uuid}/share-links
GET,POST /api/files/folders/{folder_id:uuid}/share-links
GET /api/files/share-links
DELETE /api/files/share-links/{link_id}
POST /api/documents
POST /api/documents/import
POST /api/documents/{document_id}/initial-state
GET /api/documents/{document_id}/collab-token
POST /api/documents/{document_id}/save
GET /api/documents/{document_id}/versions
GET /api/documents/{document_id}/versions/{version_id}
GET /api/documents/{document_id}/page-setup
GET /api/documents/{document_id}/download
POST /api/documents/{document_id}/assets
POST /api/documents/asset-links
GET /api/documents/{document_id}/assets/{asset_id}
GET,POST /api/documents/{document_id}/comments
GET /api/documents/{document_id}/comments/people
DELETE,PATCH /api/documents/{document_id}/comments/{comment_id}
POST /api/documents/{document_id}/comments/{comment_id}/resolve
POST /api/documents/{document_id}/mentions
POST /api/internal/documents/{document_id}/snapshot
POST /api/files/{file_id:uuid}/ai/ask
POST /api/files/{file_id:uuid}/ai/deck
POST /api/files/{file_id:uuid}/ai/sheet
POST /api/files/{file_id:uuid}/ai/form
POST /api/files/office/convert-ai
GET,POST /api/files/{file_id:uuid}/versions
PATCH /api/files/{file_id:uuid}/versions/{version_id:uuid}
GET /api/files/{file_id:uuid}/versions/{version_id:uuid}/diff
POST /api/files/{file_id:uuid}/versions/{version_id:uuid}/restore
GET,PUT /api/files/{file_id:uuid}/pdf
GET,PATCH /api/files/{file_id:uuid}/media
GET /api/files/{file_id:uuid}/signed-urls
GET,HEAD /api/m/{token}
GET,POST /api/auth/app-passwords
DELETE,PATCH /api/auth/app-passwords/{password_id}
POST /api/devices/pair
POST /api/devices/pair/status
GET /api/devices/pair/{code}
POST /api/devices/pair/claim
POST /api/devices/have
POST /api/devices/crashes
* /dav/{path:path}
* /dav
GET /api/items/store
DELETE,POST /api/items/store/{kind}
PUT /api/items/store/admin
GET,PUT /api/items/body
GET,PUT /api/items/launcher
POST /api/items/open/{kind}
GET /api/items/app/{kind}/manifest.webmanifest
GET /api/items/app-manifest/{file_id}.webmanifest
GET,POST /api/items
GET,PUT /api/items/{file_id}
GET /api/items/{file_id}/revision
POST /api/items/{file_id}/actions/{name}
POST /api/items/{file_id}/restore/{version_id}
POST /api/items/{file_id}/archive
POST /api/items/k/budget/{file_id}/up/connect
DELETE /api/items/k/budget/{file_id}/up
POST /api/items/k/budget/{file_id}/up/sync
GET /api/items/k/budget/{file_id}/up/status
POST /api/items/k/budget/hook/{file_id}
POST /api/items/k/flashcards/{file_id}/apkg
GET /api/items/k/journal/{file_id}/day
POST /api/items/k/mealplan/import
POST /api/items/k/mealplan/parse
GET /api/items/k/meals/off/barcode/{code}
GET /api/items/k/meals/off/search
GET /api/items/k/meals/builtin/foods
GET /api/items/k/meals/trends/{file_id}
GET /api/items/k/workout/catalog
DELETE,GET,POST /api/items/{file_id}/ai
GET /api/rooms/bootstrap
GET /api/rooms/people
POST /api/rooms/spaces
DELETE,PATCH /api/rooms/spaces/{space_id}
POST /api/rooms/spaces/{space_id}/members
DELETE,PATCH /api/rooms/spaces/{space_id}/members/{user_id}
PATCH /api/rooms/spaces/{space_id}/me
POST /api/rooms/spaces/{space_id}/rooms
DELETE,PATCH /api/rooms/rooms/{room_id}
POST /api/rooms/dms
PATCH /api/rooms/rooms/{room_id}/me
GET,POST /api/rooms/rooms/{room_id}/messages
DELETE,PATCH /api/rooms/messages/{message_id}
DELETE,PUT /api/rooms/messages/{message_id}/reactions
GET /api/rooms/rooms/{room_id}/pins
POST /api/rooms/rooms/{room_id}/read
POST /api/rooms/rooms/{room_id}/typing
POST /api/rooms/presence
POST /api/rooms/rooms/{room_id}/attachments
GET /api/rooms/attachments/{att_id}
GET /api/rooms/search
GET /api/rooms/events
GET /api/today
PUT /api/today/morning
GET /api/today/search
GET,POST /api/tags
GET,PUT /api/tags/entity
POST /api/tags/assign
POST /api/tags/unassign
DELETE,GET,PATCH /api/tags/{tag_id}
GET /api/tags/{tag_id}/items
POST /api/tags/{tag_id}/merge
DELETE,GET,POST /api/today/recents
DELETE /api/today/recents/{kind}/{entity_id}
GET /api/places
POST /api/crossapp/share
GET /api/crossapp/share/preview
GET /api/crossapp/share/card/{message_id}
GET,POST /api/crossapp/trip/{file_id}/{trip_id}/album
GET /api/crossapp/trip/{file_id}/{trip_id}/spending
POST /api/crossapp/trip/{file_id}/{trip_id}/spending/tag
GET /api/crossapp/budget/trips
POST /api/crossapp/mealplan/{file_id}/to-tasks
GET,POST /api/connections
GET /api/connections/resolve
GET /api/connections/search
DELETE /api/connections/{link_id}
DELETE,GET /api/trash
POST /api/trash/restore
POST /api/trash/purge
GET /api/maps/config
GET /api/maps/data-status
GET /api/maps/search
GET /api/maps/reverse
POST /api/maps/route
GET /api/maps/nearby
POST /api/maps/nearby/along
POST /api/maps/assistant
POST /api/maps/traffic/route
GET /api/maps/traffic/incidents/{z}/{x}/{y}.pbf
POST /api/maps/place/details
GET /api/maps/traffic/tile/{z}/{x}/{y}.pbf
POST /api/maps/traffic/test
POST /api/maps/navigate/route
GET,POST /api/maps/preferred
DELETE,PATCH /api/maps/preferred/{route_id}
GET,POST /api/maps/places
DELETE,PATCH /api/maps/places/{place_id}
DELETE,POST /api/maps/recents
DELETE,PUT /api/maps/parked
GET /api/maps/chargers
POST /api/maps/chargers/along
POST /api/maps/cameras/along
GET /api/maps/cameras
GET /api/maps/offline
GET /api/maps/offline/estimate
POST /api/maps/offline/areas
DELETE,PATCH /api/maps/offline/areas/{area_id}
PUT /api/maps/offline/areas/{area_id}/device
GET /api/maps/offline/files
GET,PUT /api/maps/timeline/settings
POST /api/maps/timeline/points
GET /api/maps/timeline/day
GET /api/maps/timeline/days
DELETE /api/maps/timeline
GET,PUT /api/maps/share
DELETE /api/maps/share/{viewer_id}
POST /api/maps/live
GET /api/mail/setup
POST /api/mail/accounts
DELETE,PATCH /api/mail/accounts/{account_id}
GET /api/mail/overview
GET /api/mail/threads
GET /api/mail/threads/{account_id}/{key}
POST /api/mail/threads/{account_id}/{key}/action
POST /api/mail/threads/action
POST /api/mail/mark-all-read
DELETE,PUT /api/mail/threads/{account_id}/{key}/snooze
GET,PUT /api/mail/settings
POST /api/mail/messages/{message_id}/rsvp
POST /api/mail/messages/{message_id}/remove-cancelled
POST /api/mail/threads/{account_id}/{key}/event-draft
POST /api/mail/threads/{account_id}/{key}/event
POST /api/mail/threads/{account_id}/{key}/task
POST /api/mail/contacts
POST /api/mail/known-people
POST /api/mail/labels
DELETE,PATCH /api/mail/labels/{label_id}
DELETE,PUT /api/mail/threads/{account_id}/{key}/labels/{label_id}
PUT /api/mail/labels/{label_id}/threads
GET,POST /api/mail/rules
POST /api/mail/rules/preview
DELETE /api/mail/rules/{rule_id}
GET,PUT /api/mail/admin/ai-search
POST /api/mail/send
DELETE /api/mail/send/{item_id}
POST /api/mail/send/{item_id}/retry
POST /api/mail/send/{item_id}/dismiss
GET /api/mail/people
POST /api/mail/draft
POST /api/mail/messages/{message_id}/attachments/{part}/save
GET /api/mail/messages/{message_id}/attachments/{part}/preview
GET /api/mail/messages/{message_id}/attachments/{part}
POST /api/mail/images
POST /api/mail/ask
POST /api/passwords/vaults/{vault_id}/attachments
GET,PUT /api/passwords/vaults/{vault_id}/attachments/{attachment_id}/chunks/{index}
POST /api/passwords/vaults/{vault_id}/attachments/{attachment_id}/finish
DELETE /api/passwords/vaults/{vault_id}/attachments/{attachment_id}
POST /api/passwords/breach/range
GET /api/passwords/directory
POST /api/passwords/icon
GET /api/passwords/people
GET,POST /api/passwords/sends
DELETE /api/passwords/sends/{send_id}
GET /api/passwords/public/sends/{send_id}
POST /api/passwords/public/sends/{send_id}/open
POST /api/passwords/sends/{send_id}/via-rooms
POST /api/passwords/sends/{send_id}/via-mail
GET,POST /api/passwords/emergency
POST /api/passwords/emergency/{emergency_id}/accept
PUT /api/passwords/emergency/{emergency_id}/wrap
POST /api/passwords/emergency/{emergency_id}/request
POST /api/passwords/emergency/{emergency_id}/refuse
POST /api/passwords/emergency/{emergency_id}/open
DELETE /api/passwords/emergency/{emergency_id}
GET /api/passwords/alerts
GET /api/passwords/mail/codes
GET /api/passwords/mail/security-events
POST /api/passwords/mail/plus-rule
GET /api/passwords/drive/files
GET /api/passwords/drive/files/{file_id}/content
POST /api/passwords/drive/files/{file_id}/trash
POST /api/passwords/reminder
GET /api/passwords/survival
GET /api/passwords/mail/accounts
GET /api/passwords/stray
GET /api/passwords/stray/count
POST /api/passwords/stray/scan
GET /api/passwords/stray/{finding_id}
GET /api/passwords/stray/{finding_id}/image
POST /api/passwords/stray/{finding_id}/ignore
POST /api/passwords/stray/{finding_id}/trash
GET /api/passwords/aliases/accounts
GET,POST /api/passwords/aliases/domains
DELETE,PATCH /api/passwords/aliases/domains/{domain_id}
GET /api/passwords/aliases/domains/{domain_id}/folders
POST /api/passwords/aliases/domains/{domain_id}/check
GET,POST /api/passwords/aliases
DELETE,PATCH /api/passwords/aliases/{alias_id}
POST /api/passwords/aliases/{alias_id}/allow
GET /api/mail/aliases/thread/{account_id}/{key}
PATCH /api/mail/aliases/{alias_id}
GET /api/passwords/reminders
DELETE,PUT /api/passwords/reminders/{item_id}
GET,PUT /api/passwords/breach-watch
POST /api/passwords/breach-watch/check
GET,PUT /api/passwords/admin/breach-watch
GET /api/passwords/browser-sync/{kind}
DELETE,PUT /api/passwords/browser-sync/tabs
POST /api/passwords/browser-sync/sent
DELETE /api/passwords/browser-sync/sent/{record_id}
PUT /api/passwords/browser-sync/history/{day}
DELETE /api/passwords/browser-sync/history
GET,PUT /api/passwords/browser-sync-prefs
DELETE,PUT /api/passwords/browser-sync/reading/{entry_id}
GET,PATCH /api/passwords/admin/policy
GET /api/passwords/status
GET,POST /api/passwords/account
DELETE,POST /api/passwords/session
POST /api/passwords/account/rekey
POST /api/passwords/account/kit
POST /api/passwords/account/reset
GET /api/passwords/devices
POST /api/passwords/devices/register
DELETE /api/passwords/devices/{device_id}
POST /api/passwords/connect/start
GET /api/passwords/connect/code/{code}
POST /api/passwords/connect/code/{code}/approve
POST /api/passwords/connect/code/{code}/deny
POST /api/passwords/connect/poll
GET,POST /api/passwords/device-requests
POST /api/passwords/device-requests/{request_id}/approver
POST /api/passwords/device-requests/{request_id}/approve
POST /api/passwords/device-requests/{request_id}/deny
POST /api/passwords/device-requests/{request_id}/poll
GET,POST /api/passwords/vaults
DELETE,PATCH /api/passwords/vaults/{vault_id}
POST /api/passwords/vaults/{vault_id}/accept
POST /api/passwords/vaults/{vault_id}/leave
GET /api/passwords/vaults/{vault_id}/changes
POST /api/passwords/vaults/{vault_id}/items
GET /api/passwords/vaults/{vault_id}/items/{item_id}/versions
GET /api/passwords/users/{user_id}/keys
GET,POST /api/passwords/vaults/{vault_id}/members
DELETE,PATCH /api/passwords/vaults/{vault_id}/members/{user_id}
POST /api/passwords/vaults/{vault_id}/rotate
GET /api/passwords/activity
POST /api/passwords/activity/export
DELETE,PUT /api/passwords/health
POST /api/assistant
POST /api/assistant/speak
GET /api/calendar/bootstrap
PATCH /api/calendar/prefs
GET /api/calendar/holiday-countries
POST /api/calendar/calendars
DELETE,PATCH /api/calendar/calendars/{cal_id}
PATCH /api/calendar/calendars/{cal_id}/me
POST /api/calendar/calendars/{cal_id}/members
DELETE,PATCH /api/calendar/calendars/{cal_id}/members/{user_id}
GET /api/calendar/people-suggestions
GET,POST /api/calendar/events
DELETE,GET,PATCH /api/calendar/events/{event_id}
POST /api/calendar/events/{event_id}/share
GET /api/calendar/rooms/{room_id}/upcoming
POST /api/calendar/events/{event_id}/rsvp
PATCH /api/calendar/events/{event_id}/me
GET /api/calendar/invites
GET /api/calendar/busy
GET /api/calendar/search
GET /api/calendar/extras
GET /api/calendar/extras/task
DELETE,POST /api/calendar/feed
GET /api/calendar/feed/{token}.ics
GET /api/calendar/events/{event_id}/photos
POST /api/calendar/events/{event_id}/album
PATCH /api/calendar/events/{event_id}/rooms/{room_id}
GET /api/calendar/email-check
GET,POST /api/calendar/events/{event_id}/email-guests
DELETE /api/calendar/events/{event_id}/email-guests/{guest_id}
GET,POST /api/calendar/answer/{token}
GET /api/people/u/{user_id}
GET /api/people/blocks
DELETE,PUT /api/people/blocks/{user_id}
GET /api/people/c/{file_id}/{contact_id}
GET /api/people/p/{person_id}
GET /api/people/search
GET,PATCH,POST /api/photos/family
POST /api/photos/family/members
DELETE /api/photos/family/members/{member_id}
PUT /api/photos/family/share
GET /api/photos/memories
GET /api/photos/memories/{memory_id}
POST /api/photos/memories/{memory_id}/dismiss
POST /api/photos/memories/{memory_id}/hide-person
POST /api/photos/memories/{memory_id}/album
GET,PUT /api/photos/settings
POST /api/photos/files/{file_id}/move-to-photos
GET /api/photos/understanding
GET /api/photos/search
POST /api/photos/items
GET /api/photos/buckets
GET /api/photos/timeline
GET /api/photos/places
GET /api/photos/cleanup
POST /api/photos/cleanup/keep
GET /api/photos/copies
POST /api/photos/copies/not
DELETE,GET,PUT /api/photos/files/{file_id}/edit
GET /api/photos/files/{file_id}/edited
POST /api/photos/files/{file_id}/render
POST /api/photos/files/{file_id}/save-as-new
GET /api/photos/map
POST /api/photos/archive
GET,POST /api/photos/albums
POST /api/photos/albums/preview
DELETE,GET,PATCH /api/photos/albums/{album_id}
DELETE,GET,POST /api/photos/albums/{album_id}/items
POST /api/photos/albums/{album_id}/members
DELETE,PATCH /api/photos/albums/{album_id}/members/{member_id}
GET,POST /api/photos/albums/{album_id}/links
DELETE /api/photos/albums/{album_id}/links/{link_id}
GET /api/photos/people
GET /api/photos/people/review
GET /api/photos/people/contacts
GET,PATCH /api/photos/people/{person_id}
POST /api/photos/people/{person_id}/merge
GET /api/photos/files/{file_id}/people
PUT /api/photos/people/{person_id}/relationship
GET /api/photos/people/{person_id}/faces
POST /api/photos/people/{person_id}/split
POST /api/photos/faces/{obs_id}/person
POST /api/photos/faces/assign
POST /api/photos/faces/{obs_id}/not
GET /api/s/{token}/album
GET /api/s/{token}/album/zip
GET /api/s/{token}/album/{file_id}/{rendition}
GET,POST /api/imports
DELETE,GET /api/imports/{job_id}
DELETE /api/imports/{job_id}/parts/{n}
POST /api/imports/{job_id}/check
POST /api/imports/{job_id}/start
GET /api/files/exports/current
POST /api/files/exports
DELETE /api/files/exports/{export_id}
POST /api/internal/tus-hook
POST /api/files/{file_id:uuid}/collab-token
GET /api/files/{file_id:uuid}/office
POST /api/files/office
POST /api/files/office/import-sheet
GET /api/files/templates
POST /api/files/{file_id:uuid}/save-as-template
GET,PUT /api/files/{file_id:uuid}/sheet
POST /api/files/{file_id:uuid}/sheet/import
GET /api/files/{file_id:uuid}/sheet/export
GET /api/files/{file_id:uuid}/sheet/versions
GET /api/files/{file_id:uuid}/sheet/versions/{version_id:uuid}
POST /api/files/{file_id:uuid}/sheet/versions/checkpoint
GET /api/files/workspaces/{workspace_id:uuid}
GET /api/files/{file_id:uuid}/details
GET /api/files/storage
GET /api/files/{file_id:uuid}/text
GET /api/files/{file_id:uuid}/office-preview
GET /api/files/{file_id:uuid}/sheet-preview
GET,PUT /api/files/ai-index
GET /api/s/{token}/meta
POST /api/s/{token}/unlock
GET /api/s/{token}/download
GET /api/s/{token}/browse
GET /api/s/{token}/file/{file_id}/download
GET /api/s/{token}/office
GET /api/s/{token}/file/{file_id}/office
GET /api/notifications/inbox
POST /api/notifications/inbox/{notification_id}/read
POST /api/notifications/inbox/read-all
GET /api/notifications/public-key
DELETE,GET,POST /api/notifications/subscriptions
DELETE,PATCH /api/notifications/subscriptions/{sub_id}
GET,PATCH /api/notifications/preferences
POST /api/notifications/test
POST /api/notifications/action
GET /api/forms/templates
GET,POST /api/forms
GET /api/forms/{file_id:uuid}
PUT /api/forms/{file_id:uuid}/definition
PATCH /api/forms/{file_id:uuid}/settings
POST /api/forms/{file_id:uuid}/assets
POST /api/forms/{file_id:uuid}/assets/from-file
DELETE,POST /api/forms/{file_id:uuid}/link
POST /api/forms/{file_id:uuid}/send
GET /api/forms/{file_id:uuid}/summary
DELETE,GET /api/forms/{file_id:uuid}/responses
DELETE,GET /api/forms/{file_id:uuid}/responses/{number:int}
GET /api/forms/{file_id:uuid}/export
POST /api/forms/{file_id:uuid}/ai/summary
POST /api/forms/from-event
POST /api/forms/{file_id:uuid}/uploads/{upload_id:uuid}/save
DELETE,POST /api/forms/{file_id:uuid}/sheet
POST /api/forms/{file_id:uuid}/sheet/sync
PUT /api/forms/{file_id:uuid}/notify
POST /api/forms/{file_id:uuid}/seen
GET /api/forms/{file_id:uuid}/assets/{asset_id:uuid}
GET /api/f/{token}
GET /api/f/{token}/asset/{asset_id:uuid}
POST /api/f/{token}/submit
GET,PUT /api/f/{token}/mine
POST /api/f/{token}/uploads
DELETE /api/f/{token}/uploads/{upload_id:uuid}
GET /api/f/{token}/ics
POST /api/f/{token}/report
GET /api/admin/forms
PATCH /api/admin/forms/settings
GET /api/admin/forms/{form_id:uuid}/reports
POST /api/admin/forms/{form_id:uuid}/close
POST /api/calls/webhook
GET /api/calls/me
POST /api/calls/test
POST /api/calls/test/report
GET /api/calls/speedtest
GET,PATCH /api/calls/admin/settings
GET /api/calls/check
GET /api/calls/usage
PATCH /api/rooms/rooms/{room_id}/voice
POST /api/rooms/rooms/{room_id}/voice/join
POST /api/rooms/rooms/{room_id}/voice/view
POST /api/rooms/voice/leave
POST /api/rooms/voice/refresh
GET /api/rooms/voice/me
POST /api/rooms/voice/state
POST /api/rooms/voice/speaking
POST /api/rooms/voice/still-here
POST /api/rooms/voice/control
POST /api/rooms/voice/session/state
POST /api/rooms/voice/session/speaking
POST /api/rooms/voice/session/still-here
POST /api/rooms/voice/session/leave
DELETE,POST /api/rooms/rooms/{room_id}/voice/members/{user_id}
POST /api/rooms/rooms/{room_id}/voice/members/{user_id}/move
POST /api/calls
POST /api/calls/dm
POST /api/calls/answer
POST /api/calls/answer/decline
POST /api/calls/answer/state
POST /api/calls/session/refresh
POST /api/calls/session/leave
GET /api/calls/live
DELETE,GET /api/calls/history
GET /api/calls/missed
POST /api/calls/missed/seen
GET /api/calls/people
GET /api/calls/{call_id}
POST /api/calls/{call_id}/join
POST /api/calls/{call_id}/decline
POST /api/calls/{call_id}/leave
POST /api/calls/{call_id}/end
POST /api/calls/{call_id}/ring
POST /api/calls/{call_id}/control
POST /api/calls/{call_id}/view
DELETE /api/calls/{call_id}/history
POST /api/talk/ticket
GET /api/talk/config
WS /api/talk/ws
GET,PATCH /api/admin/talk
GET /api/admin/talk/usage
GET,POST /api/notes
GET /api/notes/labels
GET /api/notes/to-tasks/lists
GET,PUT /api/notes/admin/transcription
GET /api/notes/events
POST /api/notes/bulk
DELETE /api/notes/trash
DELETE,GET,PATCH /api/notes/{note_id}
POST /api/notes/{note_id}/items
POST /api/notes/{note_id}/items/bulk
DELETE,PATCH /api/notes/{note_id}/items/{item_id}
PUT /api/notes/{note_id}/me
PUT /api/notes/{note_id}/labels
GET,POST /api/notes/{note_id}/members
DELETE /api/notes/{note_id}/members/{member_id}
DELETE,PUT /api/notes/{note_id}/reminder
GET /api/notes/{note_id}/versions
GET /api/notes/{note_id}/versions/{version_id}
POST /api/notes/{note_id}/versions/{version_id}/restore
POST /api/notes/{note_id}/attachments
DELETE /api/notes/{note_id}/attachments/{attachment_id}
POST /api/notes/{note_id}/attachments/{attachment_id}/transcribe
POST /api/notes/{note_id}/restore
DELETE /api/notes/{note_id}/forever
POST /api/notes/{note_id}/ai/{action}
POST /api/notes/{note_id}/copy
DELETE,POST /api/notes/{note_id}/to-document
POST /api/notes/{note_id}/to-tasks
POST /api/notes/{note_id}/to-tasks/undo
GET /api/widgets/snapshot
POST /api/widgets/tasks/complete
POST /api/widgets/tasks
POST /api/widgets/notes
POST /api/widgets/notes/{note_id}/add
POST /api/widgets/notes/{note_id}/items
PATCH /api/widgets/notes/{note_id}/items/{item_id}
GET /api/widgets/notes/pick
GET,POST /api/porch/groups
GET /api/porch/groups/discover
DELETE,GET,PATCH /api/porch/groups/{group_id}
POST /api/porch/groups/{group_id}/transfer
GET /api/porch/groups/{group_id}/members
DELETE,PATCH /api/porch/groups/{group_id}/members/{user_id}
PATCH /api/porch/groups/{group_id}/me
GET,POST /api/porch/groups/{group_id}/invites
DELETE /api/porch/groups/{group_id}/invites/{user_id}
POST /api/porch/groups/{group_id}/accept
POST /api/porch/groups/{group_id}/decline
POST /api/porch/groups/{group_id}/join
GET /api/porch/feed
GET /api/porch/groups/{group_id}/posts
GET /api/porch/users/{user_id}/posts
DELETE,GET,PATCH /api/porch/posts/{post_id}
GET /api/porch/saved
POST /api/porch/posts
GET /api/porch/events
POST /api/porch/compose/files
GET,POST /api/porch/posts/{post_id}/comments
DELETE,PATCH /api/porch/comments/{comment_id}
DELETE,GET,PUT /api/porch/posts/{post_id}/reactions
DELETE,GET,PUT /api/porch/comments/{comment_id}/reactions
DELETE,PUT /api/porch/posts/{post_id}/vote
DELETE,PUT /api/porch/posts/{post_id}/save
POST /api/porch/tags/{tag_id}/approve
POST /api/porch/tags/{tag_id}/decline
DELETE /api/porch/tags/{tag_id}
POST /api/porch/compose/tag-suggestions
GET /api/porch/activity
POST /api/porch/activity/seen
GET /api/porch/posts/{post_id}/card
POST /api/porch/posts/{post_id}/reply
GET /api/porch/posts/{post_id}/event
GET /api/porch/files/{file_id}/uses
POST /api/porch/files/uses
GET /api/porch/search
GET,PATCH /api/porch/me/notifications
GET /api/porch/alerts
DELETE,PUT /api/porch/alerts/{user_id}
POST /api/porch/reports
GET /api/porch/available
GET /api/porch/bootstrap
GET /api/porch/people
GET /api/porch/users/{user_id}
GET /api/porch/people/suggested
GET,PATCH /api/porch/me/profile
POST /api/porch/feed/seen
GET,PATCH /api/admin/porch
GET /api/admin/porch/reports
POST /api/admin/porch/reports/{report_id}
POST /api/admin/porch/posts/{post_id}/remove-from-everyone
"""


def _compiled():
    from starlette.routing import compile_path

    out = []
    for line in _ROUTES.strip().splitlines():
        methods, path = line.split(" ", 1)
        regex, fmt, _conv = compile_path(path)
        out.append((None if methods == "*" else set(methods.split(",")), regex, fmt))
    return out


def template_for(method: str | None, path: str, routes=None) -> str | None:
    """The template of the first route matching ``path`` (and ``method``,
    when one does), else ``None``."""
    routes = routes if routes is not None else _compiled()
    path = path.split("?", 1)[0]
    fallback = None
    for methods, regex, fmt in routes:
        if regex.match(path):
            if method is None or methods is None or method in methods:
                return fmt
            if fallback is None:
                fallback = fmt
    return fallback


_ROUTE_RE = re.compile(r"^([A-Z]+) (/.*)$", re.S)
_DETAIL_RE = re.compile(r"path=(.*?)(?= bucket=|$)", re.S)


def upgrade() -> None:
    bind = op.get_bind()
    routes = _compiled()

    rewritten = deleted = 0
    rows = bind.execute(text("SELECT id, route FROM error_events WHERE route IS NOT NULL")).all()
    for row_id, route in rows:
        m = _ROUTE_RE.match(route or "")
        if not m:
            continue  # not a request path (a background job's label)
        method, path = m.groups()
        fmt = template_for(method, path, routes)
        if fmt is None:
            bind.execute(text("DELETE FROM error_events WHERE id = :i"), {"i": row_id})
            deleted += 1
        elif f"{method} {fmt}" != route:
            bind.execute(
                text("UPDATE error_events SET route = :r WHERE id = :i"),
                {"r": f"{method} {fmt}"[:255], "i": row_id},
            )
            rewritten += 1

    audit = 0
    rows = bind.execute(
        text("SELECT id, detail FROM auth_events WHERE event_type = 'rate_limited' AND detail LIKE 'path=%'")
    ).all()
    for row_id, detail in rows:
        m = _DETAIL_RE.search(detail or "")
        if not m:
            continue
        raw = m.group(1)
        fmt = template_for(None, raw, routes) or "[removed]"
        if fmt == raw:
            continue
        new = detail[: m.start(1)] + fmt + detail[m.end(1):]
        bind.execute(text("UPDATE auth_events SET detail = :d WHERE id = :i"), {"d": new[:512], "i": row_id})
        audit += 1

    log.info(
        "0402_scrub_error_routes: %d error route(s) rewritten, %d deleted, %d audit detail(s) rewritten",
        rewritten, deleted, audit,
    )


def downgrade() -> None:
    # The raw paths are gone on purpose.
    pass
