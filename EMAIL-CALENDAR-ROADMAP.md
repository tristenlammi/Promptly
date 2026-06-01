# Promptly — Email & Calendar Roadmap (S-tier)

> Created 2026-06-01. Fleshes out **Phase 12** of `ROADMAP.md` into an
> implementable spec. The headline pillar of v3: an AI-triaged inbox that
> replaces your mail client for the conversations that matter, with calendar
> context, on-demand drafting, and emails as first-class chat/RAG content.
>
> **Status: design — not yet implemented.** Check items off as they land.

## North star

Email clients make *you* do the triage. Promptly's inbox is **AI-decided**:
it ingests everything, hides the firehose, and leads with "here are the few
things that actually need you today." The AI is the **triage layer**, not a bot
bolted onto a folder list. The default surface is a **daily brief**, not an
inbox — the inbox is there when you go looking.

Everything degrades gracefully (no email = nothing changes), stays cheap on a
small self-hosted box, and is **fully toggleable** — per-user and via an admin
org-wide kill switch (off until an admin explicitly enables it).

Each phase ends with `tsc --noEmit` + `npm run build` + a backend compile +
Docker rebuild + a phone-width visual check. Schema phases ship an Alembic
migration (run on container boot).

## Locked decisions (2026-06-01)

1. **Sync direction: two-way.** Archive/read/label in Promptly writes back to
   Gmail and vice-versa — one source of truth. Requires the `gmail.modify`
   scope (read + send + label/state writeback, **no delete scope**).
2. **Triage/RAG model: admin-configurable, local default.** Email bodies are
   sent to a model for triage + embedding. The admin picks that model; it
   **defaults to a local/Ollama model** so mail never leaves the box unless the
   admin opts into an external API. Surfaced in Admin → Settings.
3. **Notifications: daily AI brief by default.** One unobtrusive daily digest of
   what needs attention. Instant per-email alerts are **opt-in** (VIP senders /
   hard deadlines). Fully user-toggleable, including fully off.
4. **First milestone (E.1): foundation + magic, headless.** OAuth + sync +
   triage + attachments-to-folder + email RAG + `search_emails` tool, all
   verifiable via chat and the admin panel **before any inbox UI exists**. The
   differentiator ships first.

---

## What we reuse (already built — Phase 12 is mostly connective tissue)

| Need | Existing scaffolding |
| --- | --- |
| Auto folder for attachments | `SystemKind` enum + `_ensure`/seed + immutability guards (`backend/app/files/system_folders.py`); `persist_generated_file` (`backend/app/files/generated.py`) |
| Background sync engine | Tasks scheduler: 60s poll, `SELECT … FOR UPDATE SKIP LOCKED`, advance-cursor-before-run, detached `asyncio` exec (`backend/app/tasks/scheduler.py`, `runner.py`) |
| Emails → RAG | `knowledge_chunks` + dual `vector(768/1536)` + HNSW cosine + `embed_texts`/`chunk_text` (`backend/app/custom_models/`); continuous indexer pattern (`backend/app/chat/semantic_index.py`) |
| `search_emails` chat tool | Tool ABC + registry + category gating (`backend/app/chat/tools/registry.py`, `base.py`) |
| `@person` / `@email` mentions | Mention parse/resolve + `file:`/chat namespaces + summarized injection (`backend/app/chat/mentions.py`, `MentionAutocomplete.tsx`) |
| Notifications (brief + alerts) | Push categories + per-user prefs + `notify_user` (`backend/app/notifications/dispatch.py`) |
| Headless draft/polish | Stateless quota-checked headless endpoints (`enhance-prompt`, `edit-artifact` in `backend/app/chat/router.py`) + memory/personal-context injection |
| Encrypted OAuth tokens | Fernet `encrypt/decrypt_secret` (already used for SMTP password) |
| Per-user toggle | `users.settings` JSONB + `PATCH /auth/me/preferences` (`extra="forbid"` whitelist) |
| Nav visibility | `OPTIONAL_NAV_KEYS` + `hidden_nav` + `Sidebar.tsx` filter; `FeatureVisibilityPanel.tsx` |
| Admin kill switch | `AppSettings` singleton + `DefaultsTab.tsx`/admin PATCH with audit diff |
| HTML body sandbox | `allow-scripts`-only iframe pattern from `CodeArtifactPanel.tsx` |
| Sent-as-PDF / digests | `generate_pdf` (permitted context) + Task-style headless run for "Catch me up" |

---

## Data model

- **`email_accounts`** — `id`, `user_id`, `provider` (`google`/`microsoft`),
  `email_address`, `oauth_tokens` (Fernet-encrypted JSON: access/refresh/expiry),
  `scopes`, `history_id` (Gmail incremental cursor), `sync_cursor_expired` (bool),
  `last_synced_at`, `last_sync_error`, `enabled`, `next_sync_at` (indexed —
  claimed by scheduler), `created_at`.
- **`email_messages`** — `id`, `account_id`, `provider_message_id`, `thread_id`,
  `subject`, `from_address`, `from_name`, `to_addresses` (JSON), `cc_addresses`,
  `date`, `snippet`, `body_text`, `body_html`, `has_attachments`,
  `attachment_file_ids` (JSON → `user_files` in the Email Attachments folder),
  `provider_labels` (JSON, reference only), `read`, `archived`,
  **AI fields:** `ai_category` (`action_required`/`fyi`/`newsletter`/
  `promotional`/`social`/`spam`), `ai_priority` (0–10), `ai_summary`,
  `needs_reply` (bool), `due_at` (parsed deadline, nullable), `triaged_at`,
  `triage_skipped_reason` (e.g. `bulk_heuristic`), `synced_at`.
  *(Retention: prune `body_html`/`body_text` after N days; keep metadata +
  embeddings longer. Respects storage quota.)*
- **`email_chunks`** — mirrors `knowledge_chunks`: `id`, `email_id`, `user_id`,
  `chunk_index`, `text`, `tokens`, `embedding_model`, `embedding_dim`,
  `content_hash`, `embedding_768`, `embedding_1536`, `chunk_metadata`
  (sender/date/subject). Partial HNSW cosine indexes per dim.
- **`email_contacts`** — derived from participants: `id`, `user_id`,
  `email_address`, `display_name`, `is_vip` (bool), `last_seen_at`,
  `message_count`. Powers `@person` and VIP routing.
- **`calendar_events`** — `id`, `account_id`, `provider_event_id`, `title`,
  `start_at`, `end_at`, `location`, `description`, `attendees` (JSON),
  `source_email_id` (nullable → click an event back to its mail), `synced_at`.

---

## Settings & gating

- **Per-user** (`users.settings`, whitelisted in `UserPreferencesUpdate`):
  - `email_mode`: `off` (default) | `triage` | `triage_rag`. `off` hides the nav
    item + the Email Attachments folder and disables all email behaviour.
    `triage_rag` additionally indexes mail for `search_emails`/`@`-mentions.
  - `email_notify`: `brief` (default) | `instant` | `off`.
  - `email_vip_instant` (bool): let VIP senders bypass digest into instant.
- **Org-wide** (`AppSettings` singleton, admin):
  - `email_integration_enabled` (default **false** — off until admin opts in).
    Overrides every per-user setting.
  - `google_oauth_client_id` / `google_oauth_client_secret_encrypted` (admin
    provisions their own Google Cloud project — no shared app).
  - `email_triage_provider_id` / `email_triage_model_id` (defaults to a local
    model when one is configured).
  - `email_triage_daily_token_cap` + global kill switch (mirrors web-search caps).
- **Nav:** add `"email"` to `OptionalNavKey` + `OPTIONAL_NAV_KEYS` + a `NAV_ITEMS`
  entry; appears in `FeatureVisibilityPanel` automatically.
- **Account panel:** new `EmailPanel.tsx` section (connect account, mode,
  notification posture, VIP list) — mirrors `MemoryPanel` shape.

---

## Sync engine (self-hosted realities)

- **OAuth:** admin-configured Google Cloud project; standard auth-code flow,
  tokens stored Fernet-encrypted. Scope `gmail.modify` + `gmail.send` +
  `calendar` (read/create). **No delete scope.**
- **Sync = polling, not push.** Self-hosted boxes rarely have a public webhook,
  so Gmail Pub/Sub `watch` is out of scope for v1. A new scheduler
  (`backend/app/email/scheduler.py`) clones the Tasks pattern: poll due
  `email_accounts` (every ~5 min), claim with `FOR UPDATE SKIP LOCKED`,
  incremental sync via Gmail **History API** keyed on `history_id`. On cursor
  expiry → flagged full resync. Two-way: read/archive/label changes in Promptly
  are pushed back to Gmail in the same loop.
- **Attachments** land in the lazily-seeded **Email Attachments** system folder
  (`SystemKind.EMAIL_ATTACHMENTS`) via `persist_generated_file`, then become
  RAG-indexed, `@`-mentionable, and code-interpreter-readable.

## Triage pipeline (cost-aware)

- **Heuristic pre-filter first** (free): `List-Unsubscribe` header → newsletter;
  known bulk senders → skip the model, set `triage_skipped_reason`.
- **Batched LLM pass** (10–20 emails/call) on the admin-chosen triage model,
  async, never blocking sync. Produces `ai_category`, `ai_priority`,
  `ai_summary`, `needs_reply`, `due_at`.
- **Budget caps + kill switch** enforced per the admin `email_triage_daily_token_cap`.
- **RAG indexer** (`backend/app/email/indexer.py`, clone of `semantic_index.py`):
  continuously embeds new mail into `email_chunks`; no hooks in the hot path;
  no-op when embeddings unconfigured.

## Notifications

- New push categories in `dispatch.py`: `email_brief`, `email_action`.
- **Default `brief`:** one daily AI digest ("3 need a reply · 1 deadline
  tomorrow"), generated by a Task-style headless run, deep-linking into threads.
- **`instant`:** push on high `ai_priority` / `due_at` / VIP only.
- **`off`:** silent; inbox still works. All toggleable in `NotificationsPanel`.

## Emails in chat (gated)

- **`search_emails` tool** (registry, category `email`): only included in the
  model's tool schema when the user is in **email context** — toggled the Email
  button under `⋯`, or `@`-mentioned a person/email. **Never** auto-injected into
  ordinary chats. Calls `retrieve_email_context` (cosine over `email_chunks`).
- **`@person`** → bounded, summarized digest of recent threads with that contact.
  **`@[subject](email:id)`** → a single thread as context. Extends
  `mentions.py` with `person:`/`email:` namespaces.
- **"Chat about this email"** right-click / long-press → seeds a real chat with
  the thread as context (reuses the "Follow up in chat" bridge).

## Compose & calendar (E.3)

- **Draft / Polish / Smart-reply / Compose-from-scratch** via stateless headless
  endpoints (mirror `enhance-prompt`), with thread + personal-context + memories
  + a few of the user's own sent messages injected for **tone matching**.
- **No auto-send, ever.** Send button shows `Send to <name> <address> — confirm?`.
- **Follow-up tracking:** sent mail with no reply after N days surfaces a nudge.
- **Snooze** + **"Remind me about this email"** → calendar event and/or reminder
  notification (reuses scheduler), event carries `source_email_id`.
- **Calendar:** read + create (no full edit in v1); weekly strip atop the email
  view; events expand with attendees + join-link extraction.

## UI (E.2)

- Three-pane inbox: AI-category rail (counts; Spam collapsed) · list · sandboxed
  reading pane. Mobile: list → swipe to thread.
- **Reading pane:** AI summary card on top (expand to full body), HTML rendered
  in an `allow-scripts`-only iframe with **remote images blocked by default**
  (privacy + anti-tracking), "show images" opt-in. Inline Draft reply, archive.
- **Daily brief** as the default landing surface.
- Extras: one-tap **unsubscribe** (from `List-Unsubscribe`), **VIP** flag,
  **"Catch me up"** brief command.

---

## Sub-sequencing

- **E.1 — Foundation + magic (headless).** Google OAuth (admin-configured) ·
  polling sync + `email_messages` · attachments → Email Attachments folder ·
  heuristic + batched AI triage · `email_chunks` indexer · `search_emails` tool ·
  per-user + admin settings + kill switch. **Verify via chat + admin panel; no
  inbox UI yet.**
- **E.2 — Inbox UI + brief.** Category rail · list · sandboxed reading pane
  (images blocked) · read/archive (two-way) · daily brief notification ·
  "Chat about this email" · `@person`/`@email`.
- **E.3 — Compose & calendar.** Draft/polish/smart-reply/compose composer
  (no-auto-send) · follow-up tracking · snooze · calendar read+create + email↔event
  linking · "remind me."
- **E.4 — Outlook + polish.** Microsoft OAuth + sync · VIP instant alerts ·
  unsubscribe assist · "Catch me up."

## Hard parts / risks (decided or to watch)

- **OAuth self-host burden** — each deployment's admin provisions a Google Cloud
  project. Document as a clean setup step. *(Decided: admin-configured.)*
- **No Gmail push** without a public webhook → **polling** via History API.
- **Triage cost** — recurring per-message token spend → heuristic pre-filter +
  batching + admin budget cap + kill switch.
- **Privacy** — bodies hit a model → **local model default**, admin opt-in to API.
- **Storage growth** — body/attachment retention cap; metadata + embeddings kept.
- **HTML email security** — sandboxed iframe + remote images off by default.
