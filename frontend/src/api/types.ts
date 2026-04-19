// Shared API types mirroring the backend Pydantic schemas.

export type UserRole = "admin" | "user";

/** Per-user preferences stored in the JSONB `users.settings` column.
 *
 * Server-side this is open-ended (a JSONB grab-bag), but the API only
 * accepts a whitelisted set of keys via PATCH /auth/me/preferences.
 * Mirror that whitelist here so the frontend gets autocomplete + type
 * safety, while still leaving the door open for forward-compatible
 * fields the server might add ahead of the client.
 */
/** Per-conversation web-search behaviour (Phase D1).
 *
 *  * ``"off"``    — never search the web on this conversation.
 *  * ``"auto"``   — model decides per turn via the ``web_search`` tool
 *                   (the default for new accounts; "smart" mode).
 *  * ``"always"`` — synthesise a forced search before every assistant
 *                   reply (today's loud "search every turn" behaviour).
 *  Mirror of the backend ``WebSearchMode`` literal in
 *  ``app/chat/schemas.py`` — keep the sets in lockstep. */
export type WebSearchMode = "off" | "auto" | "always";

export interface UserSettings {
  /** Initial state of the per-chat Tools toggle. Defaults to ON. */
  default_tools_enabled?: boolean;
  /** Initial state of the per-chat Web Search picker (Phase D1).
   *  Defaults to ``"auto"`` for new accounts. */
  default_web_search_mode?: WebSearchMode;
  /** Free-form locality the user wants the AI to silently know about
   *  (e.g. ``"Sunshine Coast, QLD, Australia"``). Surfaces in the
   *  chat system prompt as ambient context. Capped at 120 chars
   *  server-side. */
  location?: string;
  /** IANA timezone name (e.g. ``"Australia/Brisbane"``). Drives the
   *  "current local time" line of the same ambient context block.
   *  Validated against the server's ``zoneinfo`` DB on PATCH. */
  timezone?: string;
  // Anything else the server might surface — kept loose on purpose so
  // a backend rollout doesn't break the type-check on the client.
  [key: string]: unknown;
}

export interface UserPreferencesUpdate {
  default_tools_enabled?: boolean;
  default_web_search_mode?: WebSearchMode;
  /** Pass an empty string to clear the stored value. */
  location?: string;
  /** Pass an empty string to clear the stored value. */
  timezone?: string;
}

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  /**
   * Per-user whitelist of model IDs surfaced in the chat picker.
   * `null` means "full access to the admin-curated pool". Admins
   * always have full access regardless of this field.
   */
  allowed_models: string[] | null;
  settings: UserSettings;
  created_at: string;
  /** Forces the user through a password-change screen on next login. */
  must_change_password?: boolean;
  /** Last successful login. Surfaced in profile + admin user table. */
  last_login_at?: string | null;
  /** Enrolled MFA method or null. Mirrored from the user_mfa_secrets row. */
  mfa_enrolled_method?: "totp" | "email" | null;
  mfa_enrolled_at?: string | null;
}

/** Expanded row used by the admin users table. */
export interface AdminUser {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  allowed_models: string[] | null;
  created_at: string;

  // ----- Security state (Phase 1) -----
  /** Number of consecutive failed login attempts. Resets on success. */
  failed_login_attempts: number;
  /** Non-null = account is currently locked. Cleared by admin unlock. */
  locked_at: string | null;
  /** Hard-disabled by an admin — refused at login + every authed request. */
  disabled: boolean;
  /** Forces a password-change screen on the user's next login. */
  must_change_password: boolean;
  last_login_at: string | null;
  last_login_ip: string | null;

  // ----- Quota overrides (Phase 3) -----
  // `null` on any of these means "use the org-wide default from
  // `app_settings`". A number — including 0 — is a hard per-user cap.
  storage_cap_bytes: number | null;
  daily_token_budget: number | null;
  monthly_token_budget: number | null;
}

/** One row of `usage_daily` returned by the admin usage endpoint. */
export interface AdminUserUsageDay {
  day: string;
  prompt_tokens: number;
  completion_tokens: number;
  messages_sent: number;
}

/** Snapshot returned by `GET /admin/users/{id}/usage`. */
export interface AdminUserUsage {
  daily_used: number;
  daily_cap: number | null;
  monthly_used: number;
  monthly_cap: number | null;
  storage_used_bytes: number;
  storage_cap_bytes: number | null;
  history: AdminUserUsageDay[];
}

/** One row from the security audit log. */
export interface AuthEvent {
  id: string;
  user_id: string | null;
  /** The identifier the caller typed. Kept even when no matching user exists. */
  identifier: string;
  ip: string;
  user_agent: string;
  event_type: string;
  detail: string | null;
  created_at: string;
}

/**
 * Global, admin-managed runtime configuration. Mirrors the singleton
 * row in the ``app_settings`` table. The SMTP password is never
 * returned — the API exposes a ``smtp_password_set`` boolean so the
 * UI can render "Configured" / "Not configured" without ever holding
 * the cleartext.
 */
export interface AppSettings {
  mfa_required: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  smtp_use_tls: boolean;
  smtp_from_address: string | null;
  smtp_from_name: string | null;
  smtp_password_set: boolean;
  smtp_configured: boolean;
  /**
   * Org-wide quota defaults. `null` on any field means "no default —
   * users without their own override are uncapped".
   */
  default_storage_cap_bytes: number | null;
  default_daily_token_budget: number | null;
  default_monthly_token_budget: number | null;
  updated_at: string;
}

// ---- Admin analytics ----
/** Headline numbers powering the dashboard cards. */
export interface AnalyticsSummary {
  window_days: number;
  total_users: number;
  active_users_window: number;
  messages_today: number;
  messages_window: number;
  prompt_tokens_window: number;
  completion_tokens_window: number;
  total_tokens_window: number;
  cost_usd_today: number;
  cost_usd_window: number;
}

export interface AnalyticsTimeseriesPoint {
  day: string;
  messages: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface AnalyticsUserRow {
  user_id: string;
  username: string;
  email: string;
  messages_window: number;
  prompt_tokens_window: number;
  completion_tokens_window: number;
  cost_usd_window: number;
  last_active_at: string | null;
}

export interface AnalyticsModelRow {
  model_id: string;
  messages_window: number;
  prompt_tokens_window: number;
  completion_tokens_window: number;
  cost_usd_window: number;
}

// ---- Admin observability (live console + grouped errors) ----
export interface ErrorEventRow {
  id: string;
  created_at: string;
  fingerprint: string;
  level: string;
  logger: string;
  exception_class: string | null;
  message: string;
  route: string | null;
  method: string | null;
  status_code: number | null;
  request_id: string | null;
  user_id: string | null;
  resolved_at: string | null;
}

export interface ErrorEventDetail extends ErrorEventRow {
  stack: string | null;
  extra: Record<string, unknown> | null;
}

export interface ErrorGroupRow {
  fingerprint: string;
  level: string;
  logger: string;
  exception_class: string | null;
  sample_message: string;
  occurrences: number;
  last_seen_at: string;
  first_seen_at: string;
  resolved: boolean;
}

/** A row in the admin's "assign models" picker. */
export interface AdminModelOption {
  provider_id: string;
  provider_name: string;
  model_id: string;
  display_name: string;
  context_window?: number | null;
}

// ---- Auth response — discriminated by ``status`` ----
//
// The backend returns one of three shapes from /auth/login. Modelling
// it as a discriminated union lets the frontend type-narrow on
// ``status`` and only access the populated fields.

export type MfaMethod = "totp" | "email";

/** Real session — login completed, no MFA in the way. */
export interface AuthResponseOk {
  status: "ok";
  user: User;
  access_token: string;
  token_type: "bearer";
  expires_in: number;
}

/** User has MFA enrolled — present a verify screen for the named method. */
export interface AuthResponseMfaRequired {
  status: "mfa_required";
  challenge_token: string;
  expires_in: number;
  method: MfaMethod;
  /** Masked destination ("a***@example.com") shown on email-method verify. */
  email_hint?: string | null;
}

/** ``app_settings.mfa_required`` is on but the user has no method yet. */
export interface AuthResponseMfaEnrollmentRequired {
  status: "mfa_enrollment_required";
  enrollment_token: string;
  expires_in: number;
}

export type AuthResponse =
  | AuthResponseOk
  | AuthResponseMfaRequired
  | AuthResponseMfaEnrollmentRequired;

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
}

// ---- Models ----
export type ProviderType =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "ollama"
  | "openai_compatible";

export interface ModelInfo {
  id: string;
  display_name: string;
  context_window?: number | null;
  pricing?: Record<string, unknown> | null;
  description?: string | null;
  /**
   * True if the upstream catalog reports the model accepts image input
   * (per OpenRouter's `architecture.input_modalities`). Drives the
   * "Vision" badge in the model selector and gates image attachments
   * in chat (Phase 4).
   */
  supports_vision?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string | null;
  api_key_masked: string | null;
  enabled: boolean;
  models: ModelInfo[];
  /**
   * Curated whitelist of model IDs surfaced in the chat picker.
   * `null` means "expose every model in `models`".
   */
  enabled_models: string[] | null;
  created_at: string;
}

export interface AvailableModel {
  provider_id: string;
  provider_name: string;
  provider_type: ProviderType;
  model_id: string;
  display_name: string;
  context_window?: number | null;
  supports_vision?: boolean;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string | null;
  model_count?: number | null;
}

// ---- Chat ----
export type MessageRole = "user" | "assistant" | "system";

export interface Source {
  title: string;
  url: string;
  snippet: string;
}

export interface MessageAttachmentSnapshot {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Provenance hint (Phase B3): set on AI-generated artefacts so the
   *  side-panel viewer can route a PDF chip into the editable
   *  Markdown editor (``"rendered_pdf"``) vs the read-only preview
   *  (``null`` — ordinary user upload). Mirror of the backend
   *  ``GeneratedKind`` enum, kept loose-typed so the UI doesn't break
   *  if a new generated kind ships before this file is updated. */
  source_kind?: string | null;
  /** When this row is a *rendered* artefact, the id of the editable
   *  source it was rendered from (e.g. the markdown the PDF came
   *  from). ``null`` for user uploads and for source rows themselves. */
  source_file_id?: string | null;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  sources?: Source[] | null;
  /** Files attached to the message:
   *  - on ``user`` rows: files the user picked via the paperclip modal.
   *  - on ``assistant`` rows: artefacts produced by tool calls during
   *    that turn (Phase A1). Either way the chip UI renders identically. */
  attachments?: MessageAttachmentSnapshot[] | null;
  created_at: string;
  // Assistant-only performance metrics. Undefined / null for user and
  // system messages and for historical rows produced before metrics
  // tracking was added.
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  ttft_ms?: number | null;
  total_ms?: number | null;
  /** Total dollar cost reported by the provider (model + paid tools).
   *  Floats; ``null`` when the provider didn't surface a cost. */
  cost_usd?: number | null;
  /** Phase 4b — UUID of the user that actually sent this message.
   *  Populated for ``role === "user"`` rows; ``null`` for assistant
   *  / system rows. The UI looks this up against the conversation's
   *  participants to render "from Jane" chips on shared chats. */
  author_user_id?: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  model_id: string | null;
  provider_id: string | null;
  pinned: boolean;
  starred: boolean;
  /** Three-mode web-search preference (Phase D1). Replaces the
   *  legacy ``web_search`` boolean. */
  web_search_mode: WebSearchMode;
  created_at: string;
  updated_at: string;
  /** Phase 4b — caller's relationship to the chat. ``"owner"`` is
   *  the default for back-compat with code paths that don't yet
   *  read shared chats. */
  role?: "owner" | "collaborator";
  /** Phase 4c — branching metadata. All ``null`` on regular chats;
   *  populated when this chat was forked from another via the
   *  ``/branch`` endpoint. The frontend uses ``parent_conversation_id``
   *  to render a "branched from" chip linking back to the source. */
  parent_conversation_id?: string | null;
  parent_message_id?: string | null;
  branched_at?: string | null;
  /** Phase Z1 — temporary chat lifecycle.
   *  ``null`` for normal permanent chats. ``"ephemeral"`` chats are
   *  deleted as soon as the user navigates away. ``"one_hour"`` chats
   *  auto-delete 1 hour after the last message; ``expires_at`` carries
   *  the live deadline so the UI can render a countdown. */
  temporary_mode?: TemporaryMode | null;
  expires_at?: string | null;
}

/** Phase Z1 — short-lived conversation modes. See ConversationSummary
 *  for full semantics. ``ephemeral`` = "incognito tab", ``one_hour`` =
 *  "scratchpad with sliding TTL". */
export type TemporaryMode = "ephemeral" | "one_hour";

/** Identity of a user that participates in a shared conversation —
 *  owner or accepted collaborator. */
export interface ConversationParticipant {
  user_id: string;
  username: string;
  email: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[];
  /** Phase 4b — owner identity, used to attribute author chips. */
  owner?: ConversationParticipant | null;
  /** Phase 4b — accepted collaborators. Empty for solo chats; the
   *  presence of any entry tells the UI to render author chips on
   *  user messages so it's clear who said what. */
  collaborators?: ConversationParticipant[];
}

/** Phase 4b — share status as stored on ``conversation_shares.status``. */
export type ShareStatus = "pending" | "accepted" | "declined";

/** One row in the share-management dialog (owner perspective). */
export interface ShareRow {
  id: string;
  conversation_id: string;
  invitee: ConversationParticipant;
  status: ShareStatus;
  created_at: string;
  accepted_at: string | null;
}

/** A pending invitation as seen by the *invitee*. Powers the
 *  invites inbox in the sidebar nav. */
export interface InviteRow {
  id: string;
  conversation_id: string;
  conversation_title: string | null;
  inviter: ConversationParticipant;
  created_at: string;
}

/** One match from ``GET /chat/conversations/search``. The snippet
 *  contains ``<mark>…</mark>`` runs around the matched terms; the
 *  sidebar renders it via ``dangerouslySetInnerHTML`` after the
 *  server already escaped everything else. */
export interface ConversationSearchHit {
  conversation_id: string;
  message_id: string;
  conversation_title: string | null;
  role: MessageRole;
  snippet: string;
  rank: number;
  created_at: string;
}

export interface SendMessageResponse {
  stream_id: string;
  user_message: ChatMessage;
}

/** State of a single tool invocation streamed via SSE. Lives in
 *  ``chatStore.toolInvocations`` while the assistant turn is in flight
 *  and is cleared at the start of the next stream — once the assistant
 *  message is committed, attachments and the textual reply already
 *  carry the lasting record of what happened. */
export type ToolInvocationStatus = "pending" | "ok" | "error";

export interface ToolInvocation {
  /** OpenAI's per-call ``id`` — stable across the started/finished pair. */
  id: string;
  name: string;
  status: ToolInvocationStatus;
  /** Populated for ``error`` status; null while pending or on success. */
  error?: string | null;
  /** Files the tool produced. Only present on the ``finished`` event,
   *  but kept on the invocation so the UI can render a per-tool chip
   *  group inline before the assistant message is finalised. */
  attachments?: MessageAttachmentSnapshot[] | null;
  /** Tool-specific structured data (e.g. an image-gen prompt + model)
   *  surfaced for richer UI affordances. Opaque to the chat layer. */
  meta?: Record<string, unknown> | null;
}

// ---- Study ----
export type StudyMessageRole = "user" | "assistant" | "system";

export interface StudyMessage {
  id: string;
  session_id: string;
  role: StudyMessageRole;
  content: string;
  exercise_id?: string | null;
  created_at: string;
}

export interface StudySessionSummary {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

/** Raw Excalidraw scene JSON (elements, appState, files). */
export type ExcalidrawSnapshot = Record<string, unknown>;

export interface StudySessionDetail extends StudySessionSummary {
  excalidraw_snapshot: ExcalidrawSnapshot | null;
  messages: StudyMessage[];
}

export interface StudyProjectSummary {
  id: string;
  title: string;
  topics: string[];
  goal: string | null;
  model_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudyProjectDetail extends StudyProjectSummary {
  sessions: StudySessionSummary[];
}

export interface StudySendMessageResponse {
  stream_id: string;
  user_message: StudyMessage;
}

export interface WhiteboardState {
  snapshot: ExcalidrawSnapshot | null;
  updated_at: string;
}

export type ExerciseStatus = "active" | "submitted" | "reviewed";

export interface WhiteboardExerciseSummary {
  id: string;
  session_id: string;
  message_id: string | null;
  title: string | null;
  status: ExerciseStatus;
  created_at: string;
  submitted_at: string | null;
}

export interface WhiteboardExerciseDetail extends WhiteboardExerciseSummary {
  html: string;
  answer_payload: unknown;
  ai_feedback: string | null;
  excalidraw_snap: string | null;
}

export interface WhiteboardSubmitResponse {
  stream_id: string;
  user_message: StudyMessage;
  exercise: WhiteboardExerciseSummary;
}

// ---- MFA ----
export interface MfaStatus {
  enrolled: boolean;
  method: MfaMethod | null;
  enrolled_at: string | null;
  last_used_at: string | null;
  backup_codes_remaining: number;
  trusted_devices_count: number;
}

export interface MfaTrustedDevice {
  id: string;
  label: string;
  ip: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

/** TOTP enrollment payload. ``qr_data_uri`` is a self-contained PNG. */
export interface MfaTotpEnrollPayload {
  secret: string;
  otpauth_uri: string;
  qr_data_uri: string;
}

export interface MfaEmailEnrollPayload {
  sent: boolean;
  expires_in: number;
  email_hint: string;
}

export interface MfaEmailSendPayload {
  sent: boolean;
  expires_in: number;
  email_hint: string;
}

/**
 * Returned by every MFA setup-verify endpoint. ``backup_codes`` is the
 * one and only delivery — the user MUST copy them down before leaving
 * the screen. ``access_token`` is populated only by the ``forced``
 * variants (which finish a forced-enrollment login flow) — for an
 * already-authenticated user enabling MFA from settings it's an empty
 * string.
 */
export interface MfaEnrollmentCompletePayload {
  user: User;
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  method: MfaMethod;
  backup_codes: string[];
}

export interface MfaBackupCodesPayload {
  codes: string[];
}
