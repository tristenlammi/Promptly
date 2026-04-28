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
  /** User-level "every new chat starts here" preference. Stored as
   *  the ``model_id`` string from ``AvailableModel`` (NOT a UUID).
   *  Always paired with ``default_provider_id`` so the resolver can
   *  disambiguate models that share an id across providers. */
  default_model_id?: string;
  /** Provider UUID matching ``default_model_id``. */
  default_provider_id?: string;
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
  /** Pass an empty string to clear the stored default. Always paired
   *  with ``default_provider_id`` — the frontend treats them as one
   *  atomic field. */
  default_model_id?: string;
  /** Pass an empty string to clear. See ``default_model_id``. */
  default_provider_id?: string;
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
  /**
   * CORS allow-list of fully-qualified origins (scheme://host[:port])
   * the API will accept cross-origin requests from. Set from the
   * first-run wizard's "Public URL" step. Localhost is always allowed
   * regardless of what's listed here.
   */
  public_origins: string[];
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
  | "gemini"
  | "ollama"
  | "openai_compatible";

/**
 * Compact summary of the model's upstream endpoint data policies.
 * Currently only populated for OpenRouter providers (via the
 * `/models/{id}/endpoints` API). `null`/undefined means we don't
 * have privacy info for this model — the UI shows nothing, rather
 * than guessing.
 */
export interface ModelPrivacy {
  endpoints_count: number;
  training_endpoints: number;
  retains_prompts_endpoints: number;
  zdr_endpoints: number;
  max_retention_days: number | null;
}

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
  privacy?: ModelPrivacy | null;
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
  /** True when this entry represents a Custom Model (admin-curated
   *  assistant with a personality + knowledge library). Custom-model
   *  rows carry a synthetic ``model_id`` of the form ``custom:<uuid>``;
   *  the backend resolves it back to the underlying base model at
   *  chat time. */
  is_custom?: boolean;
  /** Only set when ``is_custom`` is true. Raw ``CustomModel.id`` uuid. */
  custom_model_id?: string | null;
  /** Only set when ``is_custom`` is true. Used as the subtitle in the
   *  model picker so users can see "GPT-4o" under the custom name. */
  base_display_name?: string | null;
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
  /** Stamped by the in-place edit endpoint when the conversation
   *  owner hand-corrects an assistant reply. Null on every original-
   *  state row. The UI uses this to render an "edited" badge. */
  edited_at?: string | null;
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
  /** Phase P1 — Chat Projects. Non-null when this chat lives inside a
   *  :class:`ChatProject`. Drives the sidebar grouping + breadcrumb. */
  project_id?: string | null;
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
  /** Whether the match lives in a conversation the caller owns or
   *  one that was shared to them. Powers the two palette sections. */
  access: "owner" | "collaborator";
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

export type StudySessionKind = "unit" | "exam" | "legacy";

export interface StudySessionSummary {
  id: string;
  project_id: string;
  kind: StudySessionKind;
  unit_id: string | null;
  exam_id: string | null;
  created_at: string;
  updated_at: string;
  teachback_passed_at: string | null;
  confidence_captured_at: string | null;
  min_turns_required: number | null;
  student_turn_count: number;
  hint_count: number;
  current_review_focus_objective_id: string | null;
}

export interface StudySessionDetail extends StudySessionSummary {
  notes_md: string | null;
  messages: StudyMessage[];
}

export type StudyProjectStatus =
  | "planning"
  | "active"
  | "completed"
  | "archived";

export type StudyUnitStatus =
  | "not_started"
  | "in_progress"
  | "completed";

export type StudyExamStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed";

export interface StudyUnitSummary {
  id: string;
  project_id: string;
  order_index: number;
  title: string;
  description: string;
  learning_objectives: string[];
  status: StudyUnitStatus;
  mastery_score: number | null;
  mastery_summary: string | null;
  exam_focus: string | null;
  /** True for units the tutor inserted mid-plan as prerequisite
   *  foundations (Phase 2 / 3). UI shows them with an "Added by tutor"
   *  label so the student can tell fill-in units from the original
   *  plan. Defaults to false on legacy rows. */
  inserted_as_prereq: boolean;
  /** Tutor-provided reason for inserting this unit as a prerequisite
   *  (written when emitting ``insert_prerequisites``). Only populated
   *  for tutor-inserted units; shown once in the topic-page
   *  "Added by tutor" banner grouped by ``prereq_batch_id``. */
  prereq_reason: string | null;
  /** Shared UUID for every unit inserted by the same tutor reply, so
   *  the UI can group them into a single dismissible banner. Keyed
   *  in localStorage for per-batch dismissal. */
  prereq_batch_id: string | null;
  /** Days since this unit was last studied (or last completed, as a
   *  fallback). Null when the unit has never been studied. Used by the
   *  UI to surface staleness tiers on completed units. */
  days_since_studied: number | null;
  completed_at: string | null;
  last_studied_at: string | null;
  session_id: string | null;
  /** Short, user-facing label describing why an in-progress unit isn't
   *  yet completable, e.g. "Teach-back pending", "Confidence rating
   *  pending", "1/3 objectives mastered". ``null`` for not-started,
   *  completed, or fully ready in-progress units. The unit card
   *  surfaces this under the "In progress" chip so students aren't
   *  left guessing why a unit with all-green metrics still hasn't
   *  closed. */
  gate_blocker: string | null;
  created_at: string;
  updated_at: string;
}

export interface StudyExamSummary {
  id: string;
  project_id: string;
  session_id: string | null;
  attempt_number: number;
  status: StudyExamStatus;
  time_limit_seconds: number;
  started_at: string | null;
  ended_at: string | null;
  score: number | null;
  passed: boolean | null;
  weak_unit_ids: string[] | null;
  strong_unit_ids: string[] | null;
  summary: string | null;
  /** Grader notes keyed by unit id → short note, emitted by the final
   *  exam's ``grade`` action. Null for exams graded before this field
   *  landed. Surfaced in the topic-page ExamBreakdown section. */
  unit_notes: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

export type StudyCurrentLevel = "beginner" | "some_exposure" | "refresher";

export interface StudyProjectSummary {
  id: string;
  title: string;
  topics: string[];
  goal: string | null;
  learning_request: string | null;
  difficulty: string | null;
  /** Student's self-reported starting level, chosen in the New Study
   *  wizard. Null if they skipped the field. Surfaced in the UI as a
   *  small badge and read by the planner / tutor to pace content. */
  current_level: StudyCurrentLevel | null;
  /** Whether the Unit 1 forced diagnostic has run. Phase 3 flips this
   *  true via the tutor's ``calibration_complete`` action. Phase 1 just
   *  exposes it so the UI can show a "Calibration pending" chip later. */
  calibrated: boolean;
  /** How calibration flipped on — ``"skipped"`` | ``"tutor_set"`` |
   *  ``"tutor_insert"`` | null. Null while the project is still
   *  uncalibrated. Used mainly as diagnostic context; the actual
   *  honesty-nudge firing is driven by the ``calibration_warning``
   *  SSE event so the toast shows up live in the tutor session. */
  calibration_source: "skipped" | "tutor_set" | "tutor_insert" | null;
  status: StudyProjectStatus;
  model_id: string | null;
  archived_at: string | null;
  planning_error: string | null;
  total_units: number;
  completed_units: number;
  created_at: string;
  updated_at: string;
}

export interface StudyProjectDetail extends StudyProjectSummary {
  units: StudyUnitSummary[];
  sessions: StudySessionSummary[];
  exams: StudyExamSummary[];
  final_exam_unlocked: boolean;
  active_exam_id: string | null;
}

export interface UnitEnterResponse {
  unit: StudyUnitSummary;
  session: StudySessionSummary;
  /** Optional kick-off stream id — backend enqueues an AI opener so
   *  the tutor speaks first on a brand-new unit session. ``null`` on
   *  re-entries where there's already conversation history. */
  stream_id: string | null;
}

export interface StartExamResponse {
  exam: StudyExamSummary;
  session: StudySessionSummary;
  stream_id: string | null;
}

export interface StudySendMessageResponse {
  stream_id: string;
  user_message: StudyMessage;
}

export interface NotesState {
  notes: string | null;
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
}

export interface WhiteboardSubmitResponse {
  stream_id: string;
  user_message: StudyMessage;
  exercise: WhiteboardExerciseSummary;
}

// ---- Learner state (Study 10/10) ----

/**
 * Structured view of the learner profile JSONB the tutor builds up
 * over time. All fields are optional so the UI can render gracefully
 * when the student has just started.
 */
export interface LearnerProfile {
  occupation?: string | null;
  interests?: string[];
  goals?: string[];
  background?: string | null;
  preferred_examples_from?: string[];
  free_form?: Record<string, unknown>;
}

export interface LearnerProfileResponse {
  profile: LearnerProfile;
  updated_at: string | null;
}

export interface LearnerProfileUpdate {
  occupation?: string | null;
  interests?: string[];
  goals?: string[];
  background?: string | null;
  preferred_examples_from?: string[];
  free_form?: Record<string, unknown>;
}

export interface ObjectiveMasteryEntry {
  id: string;
  project_id: string;
  unit_id: string;
  objective_index: number;
  objective_text: string;
  mastery_score: number;
  ease_factor: number;
  interval_days: number;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  review_count: number;
  consecutive_failures: number;
  days_since_review: number | null;
  is_due: boolean;
}

export interface ObjectiveMasteryListResponse {
  entries: ObjectiveMasteryEntry[];
}

export interface ReviewQueueItem {
  objective_id: string;
  unit_id: string;
  unit_title: string;
  objective_index: number;
  objective_text: string;
  mastery_score: number;
  days_overdue: number;
  last_reviewed_at: string | null;
}

export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
}

export interface MisconceptionEntry {
  id: string;
  project_id: string;
  unit_id: string | null;
  objective_index: number | null;
  description: string;
  correction: string;
  first_seen_at: string;
  last_seen_at: string;
  times_seen: number;
  resolved_at: string | null;
}

export interface MisconceptionListResponse {
  entries: MisconceptionEntry[];
}

export interface ConfidenceCaptureResponse {
  session_id: string;
  captured_at: string;
  level: number;
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
