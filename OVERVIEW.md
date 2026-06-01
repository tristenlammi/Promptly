# Promptly — App Overview

> Single-source reference for **what Promptly is, what it does, and how it's built**. `README.md` is the operator runbook (deploy + day-2 ops); this document is the product + architecture map. Update it whenever a feature lands, gets reworked, or gets removed.
>
> **Last updated:** 2026-06-01 (Projects world-class upgrade. **Phase 1 — default model made real:** `chat_projects.default_model_id`/`default_provider_id` existed but had no UI and `handleNewChat` always sent the global model, so the backend fallback never fired. Added a controlled `ProjectModelField` (reuses the available-models catalogue without touching the global chat selection), wired it into the New-project modal + detail Settings tab, and `handleNewChat` now prefers the project default. Server validates the (provider, model) pair against the provider's `enabled_models` on create/update (`_validate_default_model`; custom `custom:<uuid>` models skip the membership check, provider ACL still applies). New-project modal also gained an optional instructions field. **Phase 2 — hybrid file retrieval (migration `0070_project_knowledge`):** pinned files used to be dumped into context wholesale on every turn — token blow-up + a hard ceiling. The Custom Models RAG store is now generalised to a second scope: `knowledge_chunks.custom_model_id` is nullable and a nullable `project_id` was added (CHECK enforces exactly one owner per chunk; partial unique index mirrors the custom-model dedup guard). `chat_project_files` gained the same indexing-lifecycle columns `custom_model_files` carries. The embed/chunk pipeline was extracted into a scope-agnostic core (`embed_file_to_chunks` + `insert_chunks`/`delete_existing_chunks` taking a `scope_kind`); `retrieve_project_context` runs the same cosine search with `WHERE project_id`. New `app/chat/project_knowledge.py` owns the hybrid decision: under ~6k indexed tokens → full-dump (unchanged); over → top-k retrieval spliced into the system prompt, with images + not-yet-indexed text still riding the attachment path. Indexing is enqueued on pin via `BackgroundTasks`; degrades to full-dump when no embedding provider is configured. The Files tab shows per-file indexing chips + a per-turn context-budget readout. **Phase 3 — searchable conversations + per-project usage:** the project detail page gained a debounced search box (reuses `/chat/conversations/search` with a new optional `project_id` filter that intersects with the caller's accessible set), richer conversation rows with a model badge + inline star/rename/remove-from-project actions, and a **Usage** tab backed by a new `GET /chat/projects/{id}/usage` endpoint that aggregates message-level token/cost stats per project + per model (since `usage_daily` can't be sliced by project; per-model attribution uses each conversation's current `model_id`). Previous: 2026-05-29 — Removed per-conversation sharing. Sharing a single chat with another user was little-used and — worse — recipients had no UI to drop a shared chat from their list (the backend `DELETE …/shares/{id}` "leave" path existed but was never wired to a button), so accepted shares were stuck in their sidebar forever. The whole conversation-share surface is gone: the `conversation_shares` table is dropped (migration `0050_drop_conv_shares`; `messages.author_user_id` is kept because it still drives author chips on project-shared chats), the six `/api/chat/.../shares` + `/share-invites` endpoints and their DTOs (`ShareRow`/`InviteRow`/`ShareStatus`) are removed, `get_accessible_conversation` / `list_accessible_conversation_ids` / `list_conversations` no longer consult share rows (owner + **project** share only; the sidebar list is owner-only as before), and `load_participants` now sources collaborators from accepted *project* shares. Frontend drops `ShareConversationDialog`, the sidebar "Share…" context-menu item + "Shared with you" pill, the conversation-invites section of the invites inbox, and the `useConversationShares`/`useShareInvites`/`useCreateShare`/`useDeleteShare`/`useAcceptInvite`/`useDeclineInvite` hooks + `chatApi` share methods. **Project**-level sharing (`project_shares`, the project Share dialog, project invites) is untouched and remains the single collaboration surface; the shared `_resolve_invitee`/`ShareUserBrief` primitives stay in `shares.py` for it. Previous: 2026-05-29 — Mobile composer persistence + camera auto-attach: two phone-only complaints. **(1) Attachments vanished on rotation** — `AppLayout` renders structurally different trees for mobile vs desktop, switched on `useIsMobile()` at 768px; rotating a phone to landscape usually crosses that breakpoint (most phones are >768px wide landscape), which unmounted the whole `Outlet → ChatPage → InputBar` subtree and wiped `InputBar`'s local `useState` (attachment chips *and* typed text). The uploaded files still existed server-side — only the composer's in-memory state was lost. Fix: new in-memory `composerStore` (Zustand, module-level so it survives the remount) mirrors `{ text, attachments }` keyed per conversation (`"__new__"` for unsaved chats). `InputBar` restores from it via lazy `useState` initialisers on mount and saves on change; a `loadedDraftKeyRef` ensures content is always written under the key it *belongs* to (so the in-place `/chat` → `/chat/:id` key change can't bleed one chat's draft into another), and the draft is cleared on send. Reload still starts fresh (rotation-only scope). **(2) Camera capture needed an extra tap** — "Take photo" ran through the same multi-select flow as gallery/file picks (upload → add to selection → press Attach). The camera input now attaches the captured photo (plus anything already selected) and closes the picker in one shot; gallery/document picks keep multi-select. Previous: 2026-05-29 — Title generation + sidebar styling: chat titles were frequently garbage ("Du", "Starting a", or raw truncated user messages) because the titler ran with `max_tokens=40` — thinking-capable models (the user's Gemini Flash, DeepSeek, etc.) spend tokens reasoning *before* emitting visible content, so the 40-token budget was consumed entirely by reasoning and the model hit the length cap before producing a title, yielding either an empty string (→ fallback to the raw first user message) or a truncated thought fragment. Fix: `titler.py` now requests `max_tokens=1024` (a plain model still stops after a few tokens, so it's near-free in the common case) and passes `reasoning_effort="off"` (threaded through `stream_chat` → `stream_chat_events`; no-op on non-DeepSeek providers). A new `_strip_think_blocks` helper also defensively removes `<think>…</think>` / `<thinking>…</thinking>` blocks (including an unclosed trailing one from budget exhaustion) that some OpenAI-compat proxies leak into the *content* channel, so picking the first output line grabs the title rather than the reasoning. 30-char cap unchanged. Sidebar styling: the conversation list now carries the `.promptly-scroll` class (it was using the chunky native scrollbar); `.promptly-scroll` gained Firefox `scrollbar-width/-color` support, dedicated `--scrollbar-thumb`/`--scrollbar-thumb-hover` theme tokens (subtle but visible, both themes), thinner 8px thumb, and hides the WebKit arrow buttons. Section headers (PINNED / TODAY / YESTERDAY / PREVIOUS 7 DAYS …) are now accent-orange (`var(--accent)`, same as the New chat button) instead of muted grey, and pinned chat titles get a softer `var(--accent)/80` tint so they stand out without shouting. Previous: 2026-05-29 — Long-reply truncation + streaming-freeze fixes: two separate user-reported problems. **(1) Cut-off replies** — normal chat applied a hard 4096 `max_tokens` cap because the composer never sends the field and the Pydantic default filled it; long answers got chopped mid-sentence (`finish_reason: "length"`). Default is now `None` across `SendMessageRequest` / `EditMessageRequest` / `RegenerateMessageRequest`, and `provider.py` omits `max_tokens` from `create_kwargs` entirely when `None` (sending `null` trips some compat layers) so the model writes until it naturally stops or hits the context window — matching what compare mode already did. The `done` SSE payload now carries a `truncated` flag (true when the final hop's `finish_reason` was `"length"`); the just-streamed assistant bubble shows a subtle amber "this reply was cut off — regenerate to continue" hint (client-only, not persisted). **(2) Page freeze during streaming** — the composer locked up the main thread on long replies because (a) every SSE token wrote to the Zustand store, forcing a full re-render + markdown re-parse per token, and (b) `rehype-highlight` re-ran over the *growing* code-heavy bubble on every one of those renders (O(n²)). `useStreamingChat` now buffers tokens and flushes at most once per `requestAnimationFrame` (~60fps, decoupled from token rate; flushed synchronously on `done`/abort via a `finally`). `MessageBubble` skips `rehype-highlight` entirely while `streaming` (highlight only runs on the final persisted bubble), memoises the preprocessed markdown string on `content`, and — critically — memoises the whole `<ReactMarkdown>` *element* on `[content, streaming]` so persisted bubbles whose `memo` is defeated by the parent's inline `onEdit`/`onBranch`/`onRegenerate` closures no longer re-parse/re-highlight on every sibling token. `ChatWindow` also memoises `authorLookup`. Previous: 2026-05-28 — Forced-finish hop, model-agnostic v2: previous fix relied on `tool_choice="none"` to stop the model on the final hop, but Gemini's OpenAI-compat layer (and likely others) silently drops that param and pattern-matches the long tool history into yet *another* tool call — so the model emitted only `tool_calls` on the forced hop, ran the unconditional break, and rendered the new "model ran tools but didn't synthesise a reply" error chip with an empty bubble + 14 sources. Forced hop now stacks **three** signals so whichever the active provider honours forces a text reply: `tools=None` (no schema to bind against), `tool_choice=None` (only meaningful with tools, kept consistent), and an injected `[FORCED FINISH]` instruction appended to the system prompt for that one call ("you have no tools left, write the answer now"). And as a true model-agnostic safety net, if the forced hop *still* produces zero text the router runs a one-shot **synthesis-retry pass**: a clean call to the same model with the user's most recent question + a digest of every tool result rendered into the system prompt + `tools=None`, with no prior `tool_call`/`tool` history to pattern-match against. The retry's text streams into the bubble like a normal reply (and replaces `full` so the assistant row persists with a real answer). The `tool_error` chip now only fires if both the forced hop *and* the synthesis-retry come back empty, with copy that nudges the user toward picking a different model. New `synthesis_retry` SSE event for future UI hooks. Previous: 2026-05-28 — Forced-finish hop fix: production was still hitting the empty-bubble + red "couldn't finish within 8 tool hops" failure mode because passing `tools=None` on the final hop didn't reliably stop misbehaving models from emitting `tool_calls` anyway (some models pattern-match the conversation history and call tools regardless of schema). The forced hop now keeps `tools=tools_payload` in scope but pins `tool_choice="none"` — the OpenAI-canonical "stop calling tools, synthesise an answer now" signal that every OpenAI-compat endpoint we talk to honours. The "we're done" check inside the loop also short-circuits unconditionally on `is_final_hop` so a still-misbehaving model can't pull us past the cap; the discarded tool calls get a `WARNING`-level log line for triage. Replaced the misleading for-else `tool_error` chip with a post-loop empty-text check that only fires when the bubble would otherwise be genuinely empty AND tools were actually run — so a partial answer no longer gets a confusing red error chip slapped next to it. Previous: 2026-05-15 — Forced-finish tool-loop hop: `MAX_TOOL_HOPS` bumped 5 → 8 and the *last* hop now runs with `tools=None` so the model is forced to synthesise a text reply from whatever it has gathered, instead of burning out the budget and rendering an empty assistant bubble + red "model exceeded the 5-hop tool limit" chip. The error path stays as a soft fallback for the pathological "model returned neither text nor tools on the forced hop" case. Surfaces a `tool_loop_wrapping_up` SSE event before the forced hop streams; the frontend currently ignores it (future UI hook). Previous: 2026-05-15 — DeepSeek thinking-mode `reasoning_content` round-trip: migration `0049_msgs_reasoning` adds a nullable text column to `messages` so the chat router can capture `delta.reasoning_content` from DeepSeek's parallel chain-of-thought channel, persist it on the assistant row, and replay it on follow-up turns. Fixes the upstream 400 "The `reasoning_content` in the thinking mode must be passed back to the API" that DeepSeek throws on multi-turn tool-call conversations (the API requires the intermediate assistant's reasoning to be echoed back; without tool calls it's optional and ignored). New `ReasoningDelta` stream event + `ChatMessage.reasoning_content` dataclass field + `to_openai()` emission; `provider.py` belt-and-braces strips the field for non-DeepSeek providers. Existing broken conversations need a regenerate-on-the-last-turn to unstick; new conversations capture from the first hop. Previous: 2026-05-15 — Defaults consolidation: new **Admin → Models → Defaults** tab unifies the three "which model fulfils role X?" admin knobs — global default chat model (NEW, migration `0048_appsettings_defchat` + non-admin `GET /api/workspace-defaults` read so the chat picker can fall back to it for users with no personal Account default), vision relay (moved from Admin → Settings), and the embedding model (moved out of the Custom Models panel into Defaults; the panel keeps a thin amber "no embedding configured" banner that deep-links to Defaults). Conversation-creation fallback chain in `chat/router.py` is now: payload → project default → user's personal default → admin default → first available. `modelStore` mirrors the admin default + relay pair into client state on auth bootstrap and uses the default as the second fallback in both `setAvailable` and `applyDefault`. Composer's "this model can't read images" warning is now relay-aware: with no relay configured it stays as the original amber drop-warning; with a relay configured it softens to an indigo informational chip ("Image will be described by &lt;relay model&gt; first") that pulls the relay's display name from the catalog so users see something legible rather than the raw slug. Previous: 2026-05-15 — Vision relay v1 (migration `0047_appsettings_vrelay`) — designates a vision-capable model under Admin → Settings to caption images attached to chats whose active model can't read them natively. Chat router fires the relay model per-image *before* the main turn, splices the caption into the prompt as a text preamble, and emits `vision_relay_started` / `vision_relay_finished` SSE events that render as indigo eye-icon chips next to the assistant bubble (click to expand and see the caption the chat model received). Skipped automatically when the active chat model already supports vision; the old "model cannot read images" amber warning is suppressed when a relay is configured. New `backend/app/chat/vision_relay.py` module owns the per-image OpenAI-shape captioning call and a tiny preamble formatter; the frontend gets a `VisionRelayChip` component plus `visionRelayInvocations` state on the chat store. Same-day: DeepSeek first-class provider — new `deepseek` `ProviderType` with pre-filled `https://api.deepseek.com` base URL in the Add Provider modal, vision heuristic flags `deepseek-vl*` / `vl2` ids; per-conversation `reasoning_effort` knob (migration `0046_conv_reasoning_effort`) translates to DeepSeek's `thinking` + `reasoning_effort` request fields via the OpenAI SDK's `extra_body`; `docs/operations.md` gains a "Provider playbooks" section with the self-hosted DeepSeek-VL2-via-vLLM recipe. Previous: 2026-05-12 — `chat_max_web_searches_per_turn` admin setting (migration `0045_app_settings_search_cap`) + frontend consolidation of failed tool chips when a same-tool call already succeeded; also recommitted the previously-uncommitted `0044_fix_fts_filename_hyphens` migration so the chain validates from a fresh install — note Alembic revision ids are capped at 32 chars by `alembic_version.version_num varchar(32)`.)

---

## 1. Elevator pitch

Promptly is a **self-hosted, multi-user AI chat workspace** designed to be deployed by one admin and shared with ~10 users (family, a small team, a study group). It pairs a Claude.ai-style chat UI with a bring-your-own-key model layer, production-grade auth, and a handful of genuinely differentiating features: a structured **Study mode** that dynamically teaches a topic, **side-by-side model comparison**, **AI-generated artefacts** (PDFs, images), **projects**, **file libraries**, and full **admin analytics**.

It runs as a single `docker compose up -d` on a small Linux box, Unraid server, or Docker Desktop — no cloud services required beyond the LLM provider of your choice.

---

## 2. Tech stack at a glance

### Frontend
- **React 18 + TypeScript** built by **Vite**
- **Tailwind CSS** with a CSS-variable design-token layer (light + dark)
- **Zustand** for UI/session state, **TanStack Query v5** for server state, **Axios** for the HTTP client
- **React Router v6** for routing
- **react-markdown** + `remark-gfm` + `rehype-highlight` for message rendering
- **Tiptap** for rich-text editing inside the PDF editor panel
- **Recharts** for admin analytics charts
- **Lucide React** for icons
- **vite-plugin-pwa** + Workbox for the installable PWA (offline shell, web-push notifications)

### Backend
- **Python 3.11 + FastAPI** (Uvicorn ASGI)
- **SQLAlchemy 2.0 async** + **Alembic** (30+ migrations, run automatically on container boot)
- **PostgreSQL 15** (primary store; FTS via `tsvector`)
- **Redis 7** (cache, rate limits, stream state)
- **ARQ** reserved for async jobs (not heavily used yet)
- **python-jose** (JWT) + **passlib/bcrypt**, **pyotp** + **qrcode** (TOTP MFA), **aiosmtplib** (email OTP)
- **pywebpush** for PWA push notifications (VAPID)
- **openai** + **anthropic** SDKs; all other providers go through the custom OpenAI-compatible `ModelRouter`
- **Pillow** + **filetype** for upload safety (EXIF stripping, magic-byte sniffing, transcoding)
- **pypdf** + **xhtml2pdf** + **markdown** for the `generate_pdf` tool
- **trafilatura** for extracting readable text in the `fetch_url` tool
- **httpx** for outbound HTTP (with an SSRF-safe wrapper in `app/net/safe_fetch.py`)

### Search
- **SearXNG** Docker sidecar (default, self-hosted, no API key)
- **Brave Search** and **Tavily** as optional HTTP-API providers

### Infrastructure
- **Docker Compose** with five services: `nginx`, `frontend`, `backend`, `postgres`, `redis`, plus `searxng`
- **Nginx** fronts everything; `/api/*` → backend, everything else → frontend SPA
- Only **nginx** publishes host ports (`8087` / `8488` by default); DB, Redis, SearXNG stay on the internal `promptly` network
- Stateful data bind-mounted under `./data/` (postgres, redis, uploads)

---

## 3. High-level architecture

```
 ┌────────┐   (http/https)   ┌────────────────┐   /api/*   ┌───────────────────┐
 │ Browser│ ───────────────► │  nginx reverse │ ─────────► │ FastAPI backend   │
 └────────┘                  │     proxy      │   other    │ (uvicorn, 8000)   │
                             │                │ ─────────► │ frontend (nginx)  │
                             └────────────────┘            └─────────┬─────────┘
                                                                     │
                      ┌──────────────────────────────┬───────────────┼───────────────┐
                      ▼                              ▼               ▼               ▼
                 Postgres 15                     Redis 7         SearXNG      External LLM
                 (conversations,                 (cache,        (web search   providers (OpenAI,
                  messages, files,                rate           HTTP API)    Anthropic,
                  study, audit)                   limits,                     OpenRouter, Ollama,
                                                  SSE state)                  custom OpenAI-compat)
```

The backend is the only component that ever talks to external LLM / search providers. The frontend is a pure SPA: after the initial login it only talks to `/api/*`.

---

## 4. Repository layout

```
Promptly/
├── backend/                    FastAPI app + Alembic migrations
│   ├── app/
│   │   ├── main.py             FastAPI entrypoint + /api/health deep probe
│   │   ├── config.py           pydantic-settings + production safety checks
│   │   ├── database.py         async SQLAlchemy engine
│   │   ├── db_models.py        aggregator so Alembic sees every model
│   │   ├── logging_setup.py    JSON logger + request-id context
│   │   ├── rate_limit.py       Redis-backed sliding-window limiter
│   │   ├── bootstrap.py        first-run setup (bootstrap admin, seed settings)
│   │   ├── admin/              users, usage, analytics, live console, audit
│   │   ├── app_settings/       global settings (theme defaults, feature flags)
│   │   ├── auth/               JWT, login, refresh, invites, password, lockouts
│   │   ├── billing/            per-day usage rollups & cost accounting
│   │   ├── chat/               conversations, messages, streaming, tools, compare,
│   │   │   │                   projects, shares, import/export, compaction, PDF editor
│   │   │   └── tools/          web_search, fetch_url, generate_pdf, generate_image…
│   │   ├── files/              uploads, safety, prompt-formatting, AI-generated files
│   │   ├── mfa/                TOTP, email OTP, backup codes, trusted devices
│   │   ├── models_config/      provider + model registry (bring-your-own-key)
│   │   ├── net/                SSRF-safe HTTP fetch helpers
│   │   ├── notifications/      VAPID keys, push subscriptions, dispatch
│   │   ├── observability/      error_events capture + admin live-console feed
│   │   ├── search/             SearXNG/Brave/Tavily adapters + provider config
│   │   └── study/              Study topics, units, exams, planner, streaming
│   ├── alembic/versions/       30 forward-only migrations
│   └── requirements.txt
│
├── frontend/                   React + Vite + TypeScript SPA
│   ├── src/
│   │   ├── App.tsx             top-level routes + auth/mfa gating
│   │   ├── sw.ts               service worker (PWA offline + push)
│   │   ├── api/                typed API clients (chat, compare, files, study…)
│   │   ├── components/         UI by domain (chat, compare, admin, study, files…)
│   │   ├── hooks/              useStreamingChat, useAuthBootstrap, useIsMobile…
│   │   ├── pages/              route-level screens
│   │   ├── store/              Zustand stores (auth, chat, theme, UI, study…)
│   │   └── utils/              token estimator, date fmt, markdown helpers…
│   └── package.json
│
├── nginx/                      public-facing reverse proxy config
├── searxng/                    self-hosted metasearch config (in git)
├── scripts/                    setup.sh, setup.ps1, VAPID keygen, PWA icon gen
├── data/                       bind-mounted runtime state (gitignored)
├── docker-compose.yml          production stack (the only one you need)
├── docker-compose.dev.yml      Vite HMR + exposed backend for local dev
├── README.md                   operator runbook
├── OVERVIEW.md                 ← you are here
└── Promptly.txt                historical product spec (kept for reference)
```

---

## 5. Feature catalogue

### 5.1 Authentication & account security
- **JWT access token** (Bearer) + **HttpOnly refresh cookie** with a `tv` (token-version) claim. Bumping `User.token_version` instantly invalidates every session for that user (kick-all-sessions).
- **Invite-only registration** — `/register` is disabled; admins generate one-time invites under Account → Invites.
- **First-run setup wizard** that creates the bootstrap admin.
- **Account lockout** after configurable failed attempts (`LOCKOUT_THRESHOLD`, default 5). Lockout is permanent until an admin unlocks.
- **Rate limiting** on login, refresh, setup, MFA send/verify, and a per-user sliding window on chat sends. Backed by Redis.
- **MFA**: authenticator TOTP, email OTP, one-shot backup codes, "trust this device for 30 days" cookie. Admins can force enrollment org-wide.
- **Audit log** (`auth_events`) records every login attempt, lockout, refresh rejection, MFA attempt, rate-limit trip. Visible under Admin → Audit.
- **Production safety checks** refuse to boot with a weak `SECRET_KEY`, wildcard CORS, or insecure cookies.

### 5.2 Chat
- **Streaming responses** over SSE; stop / regenerate buttons; edit-and-resend on the user's previous turn.
- **Multi-provider model selection** per conversation (OpenRouter, OpenAI, Anthropic, Ollama, any OpenAI-compatible endpoint) with a searchable model picker.
- **Rich message rendering** — GFM markdown, code syntax highlighting, LaTeX-ready math, copy-to-clipboard per code block.
- **Attachments**: images (paste from clipboard, take photo, pick from gallery, upload from device) + documents (PDF, docx, txt, md). Files are validated by magic bytes, EXIF/GPS stripped, non-universal formats transcoded to JPEG server-side before being shown to models.
- **AI-generated artefacts** stored in a dedicated "Generated" folder: `generate_pdf` tool produces fully-rendered PDFs, `generate_image` tool calls model-native image gen.
- **Tools**: `web_search`, `fetch_url`, `generate_pdf`, `generate_image`, plus a demo/echo registry. Per-conversation `tools_enabled` toggle.
- **Web search**: per-conversation globe button with `off` / `auto` / `on` modes. SearXNG default, Brave / Tavily optional.
- **Context window indicator** (desktop): always-on model-aware pill (e.g. `1.2k / 128k`) with a breakdown tooltip. Green → amber → red as usage crosses 60% / 85%.
- **Context compaction**: when usage passes 85% a banner offers a one-click compact that summarises the middle of the conversation via the current model and leaves the head + tail untouched. Summary is stored as a special `role="system"` message rendered with its own UI.
- **Conversation actions**: star, pin, rename (inline), share (generate a read-only link or collaborator invite), move to project, delete, temporary/ephemeral chats (auto-deleted after 1 hour).
- **Full-text search** via `tsvector` + GIN indexes. `Cmd/Ctrl+K` command palette shows snippets grouped into "Your chats" and "Shared with you"; results jump to `#m-<message_id>` inside the conversation.
- **Import / export** conversations (Markdown format, bulk).
- **Stream errors** are classified server-side and rendered as actionable cards on the client (e.g. OpenRouter privacy 404 → "Open OpenRouter privacy settings", invalid-image upload → "Try re-uploading").

### 5.3 Compare mode (side-by-side)
- Start a compare run from the sidebar → picks 2–4 models.
- Shared composer fans the same prompt out to each column; each column streams independently.
- Tools + web search are deliberately **disabled** in compare mode to keep results comparable.
- **Crown a winner** to promote one column to a regular conversation; the losing columns are archived (visible in the Compare Archive but excluded from the normal chat list).
- Compare group delete cascades to archived columns.

### 5.4 Projects
- A project bundles **a shared system prompt + a shared set of pinned files + a group of conversations** under one owner.
- Dedicated `/projects` and `/projects/:id` pages modelled on the Study topic UI, with an Archive tab. The detail page has **Conversations**, **Files**, **Usage**, and **Settings** tabs.
- **Searchable conversations**: the Conversations tab has a debounced search box that hits `GET /chat/conversations/search?project_id=…` (FTS + semantic fusion, scoped to the project by intersecting with the caller's accessible set). Rows show a model badge + date and carry inline actions (star, rename, remove-from-project).
- **Per-project usage**: `GET /chat/projects/{id}/usage` aggregates message-level token/cost stats (`usage_daily` is only keyed by user/day) across every conversation in the project, with a per-model breakdown (attributed to each conversation's current model). Rendered as the Usage tab.
- Move an existing conversation into or out of a project from the chat menu. Temporary chats are ineligible.
- **Default model**: a project can pin a default model/provider (set in the New-project modal or the detail page's Settings tab via `ProjectModelField`). New chats opened from inside the project start on that model — `handleNewChat` sends the project default explicitly (falling back to the user's current global model when unset), and the backend's create-conversation fallback honours it for API callers too. The chosen model is validated server-side (`_validate_default_model`) against the provider's `enabled_models` so a project can't pin a model the caller can't actually use (custom `custom:<uuid>` models skip the membership check, provider ACL still applies).
- **What's shared across chats in a project**: the project's system prompt (prepended to each chat's system message) and the project's pinned files.
- **Hybrid file retrieval** (`app/chat/project_knowledge.py`): small projects fold every pinned file into the triggering turn in full (as before). Once a project's indexed text passes ~6k tokens, it flips to **top-k semantic retrieval** — only the chunks most relevant to the current turn are spliced into the system prompt, so a large pinned doc set no longer blows the context window on every message. Reuses the Custom Models RAG plumbing: the `knowledge_chunks` pgvector table is now scoped by *either* `custom_model_id` *or* `project_id` (CHECK constraint enforces exactly one), the embed/chunk pipeline (`embed_file_to_chunks` + scope-agnostic `insert_chunks`/`delete_existing_chunks`) is shared, and `retrieve_project_context` runs the same cosine search. Indexing is enqueued on pin via `BackgroundTasks` and tracked per-file on `chat_project_files` (`indexing_status` queued→embedding→ready/failed); images/binaries stay `queued` and ride the attachment/vision path. Degrades to full-dump when no embedding provider is configured. The project detail page's Files tab shows per-file indexing chips and a **per-turn context-budget** readout (`per_turn_tokens` / `retrieval_active`).
- **What's not shared**: conversation history. Each chat loads its own messages (`WHERE conversation_id = X`) and never sees sibling chats' history. Cross-chat continuity is deliberately out of scope — if the user wants it, they pin a summary file to the project or paste an exported Markdown transcript into a new chat.

### 5.5 Study mode (desktop/tablet only)
Split-pane page: chat on the left, an interactive **whiteboard / exercise iframe** on the right.

- **Study Topics** — high-level goal entered by the user; an AI planner generates a 5–20 unit plan scoped to their goal + prior knowledge.
- **Units** — individual lessons. The tutor first diagnoses gaps (short Q&A / diagnostic), then teaches, then verifies understanding, then marks the unit complete.
- **Exercises** — the AI authors HTML/JS quizzes, drag-and-drop, Q&A and diagrams that render in a sandboxed iframe with a `postMessage` back-channel for answer submission. A "Submit answers" button persists even after a page refresh.
- **Final Exam** — unlocked once every unit is complete. Timed (~15–20 min), dynamically built from the student's weak points, pass/fail with targeted unit re-unlocking on fail.
- **Personal context** + **memory** per topic so the tutor knows what you already know and what's still shaky.
- **Staleness / calibration** detection bumps the tutor into "let's quickly recalibrate" mode if a unit keeps failing.
- **Prereq batching** warns when a new unit needs knowledge that wasn't covered earlier.
- **Archive + delete** flow with double-modal confirmation.
- Hidden entirely on phone screens (`StudyDesktopOnly` guard).

### 5.6 Files
- Dedicated `/files` library: upload, preview, rename, move, delete, bulk select.
- **System folders** (`Uploads`, `Generated`, `Shared`, per-project folders) are seeded and protected.
- **Safety pipeline**: magic-byte detection, filename sanitisation, size limits, EXIF/GPS stripping, atomic replace (Pillow writes to `*.stripping.tmp`, then `os.replace` — prevents 0-byte corruption), transcoding of exotic image formats to JPEG for model compatibility.
- **Quotas** per user (configurable by admins).
- Files can be referenced from chat (attach picker) or from projects.

### 5.7 Models tab (admin)
- Add/remove providers with an API key (OpenRouter, OpenAI, Anthropic, Ollama, custom OpenAI-compatible URL).
- Per-provider `SelectModelsModal` — searchable list of every model the provider exposes, checkbox to enable, inline **privacy badges** on OpenRouter rows showing the combined data policy of the model's endpoints (training / retention / ZDR).
- Only enabled models appear in the chat model picker.

### 5.8 Admin dashboard
- **Users** — create, invite, reset password, lock/unlock, delete, view per-user usage modal.
- **Analytics** — fleet-wide dashboard with:
  - Top totals row (prompt / completion / total tokens + peak day).
  - A daily trend chart that **defaults to the Tokens metric** (stacked prompt + completion bars), with Messages (bar) and Cost (line) as alternates. Includes a **user filter dropdown** to scope the chart to any single user.
  - Cost-by-user bar chart and Cost-by-model table rendered side-by-side at an even 50/50 split on wide screens.
  - A chart summary row under the main chart repeats the key numbers for the filtered window.
- **Audit log** — raw view of `auth_events`.
- **Live Console** — tails the backend's JSON log ring buffer with filters and error grouping, sourced from the in-memory observability store.
- **App settings** — global toggles, theme defaults, default search provider.
- **Models** — provider list + enable/disable per model (see 5.7).

### 5.9 Notifications (PWA push)
- Browser service worker subscribes to the backend's VAPID keys.
- Per-user preferences in Account → Notifications control what triggers a push (e.g. stream completion when the tab isn't visible).
- Dispatch layer deletes dead subscriptions automatically on 404/410 from the push service.

### 5.10 Sharing
- Per-conversation share dialog: **read-only link** (anyone with the URL) or **collaborator invite** (signed-in user, can reply).
- Collaborator conversations show up alongside your own, tagged with an `access=collaborator` field, in the sidebar and in search results.

### 5.11 Mobile polish
- Responsive layout — chat, projects, files, compare archive, admin all work on phones.
- A `useIsMobile()` hook gates things that don't belong on a small screen: **Study mode** (entire section), **context window pill** (hidden), **context warning banner** (hidden), **compare mode** (hidden sidebar entry + TopNav button).
- On mobile, **Enter inserts a newline** in the composer, edit-in-place, and compare shared composer — sending is explicit via the dedicated button, matching iMessage / WhatsApp behaviour.
- Attachment picker has three distinct actions on mobile: **Take photo**, **Choose from gallery** (direct photo-library access), and **Upload from device** (full file browser).
- PWA manifest + icons; "Install app" button in the layout.

### 5.12 Observability
- Structured JSON logs with per-request context (`request_id`, `user_id`, `route`).
- Every unhandled exception is persisted to `error_events` with stack trace + request context and surfaces in Admin → Console.
- `/api/health` pings Postgres + Redis + SearXNG in parallel (sub-second timeout each). Container healthchecks read it.

---

## 6. Database schema (high level)

All tables are created by Alembic (`backend/alembic/versions/`), currently at migration **0070**. Ownership is enforced by FK + row-level queries, not Postgres RLS.

| Table | What it holds | Key columns |
|---|---|---|
| `users` | Accounts | `id`, `email`, `username`, `role` (`admin`/`user`), `password_hash`, `token_version`, `is_locked`, `failed_login_count`, `mfa_required`, `quota_*` |
| `auth_events` | Audit log | `user_id?`, `event`, `ip`, `user_agent`, `created_at` |
| `conversations` | Chat threads | `user_id`, `title`, `pinned`, `starred`, `temporary`, `expires_at?`, `project_id?`, `compare_group_id?`, `model_id`, `web_search_mode`, `tools_enabled` |
| `messages` | Turns inside a conversation | `role` (`user`/`assistant`/`system`), `content`, `tokens_prompt`, `tokens_completion`, `cost_usd`, `model_id`, `tsv` (FTS), `created_at` |
| `conversation_shares` | Read-only + collaborator shares | `conversation_id`, `token`, `access`, `invited_user_id?`, `expires_at?` |
| `compare_groups` | Side-by-side runs | `user_id`, `title`, `seed_prompt`, `crowned_conversation_id?`, `archived_at?` |
| `chat_projects` + `chat_project_files` | Projects | `user_id`, `name`, `system_prompt`, `default_model_id`/`default_provider_id`, shared file bag; `chat_project_files` carries the RAG indexing lifecycle (`indexing_status`/`indexing_error`/`indexed_content_hash`/`indexed_at`) |
| `knowledge_chunks` | RAG chunks (pgvector) shared by Custom Models **and** Projects | scoped by `custom_model_id` *xor* `project_id` (CHECK), `embedding_768`/`embedding_1536` vectors + HNSW indexes |
| `user_files` + `file_folders` | Files library | `user_id`, `original_filename`, `storage_path`, `mime`, `size_bytes`, `kind` (upload/generated), `source_conversation_id?`, folder tree |
| `study_projects` / `study_units` / `study_sessions` / `study_exams` / `study_messages` / `whiteboard_exercises` / `study_notes` | Study mode state | topic plan, unit mastery, exam runs, whiteboard payloads |
| `model_providers` | Admin-configured providers + enabled models | `kind`, `name`, `base_url`, `api_key_enc`, `enabled_models` JSON |
| `search_providers` | Enabled search backends + keys | `kind`, `api_key_enc`, `enabled` |
| `app_settings` | Singleton-ish global settings | theme default, default provider, feature flags, `chat_max_web_searches_per_turn` |
| `usage_daily` | Per-user per-day rollups | `user_id`, `day`, `messages`, `prompt_tokens`, `completion_tokens`, `cost_usd` |
| `error_events` | Captured errors for admin console | level, stack, route, method, status_code, request_id |
| `push_subscriptions` + `push_preferences` | Web push | endpoint, p256dh, auth, per-event toggles |
| `mfa_*` | TOTP secrets, backup codes, email-OTP challenges, trusted devices | |

Full-text search runs on `messages.tsv` (`tsvector`), maintained by a trigger, indexed with GIN. `ts_headline` produces the result snippets.

---

## 7. API surface (all under `/api/`)

| Prefix | Module | Notes |
|---|---|---|
| `/api/health` | `main.py` | Deep probe → 200/503 + per-component status. |
| `/api/auth` | `auth/router.py` | Login, refresh, logout, register-from-invite, password reset. |
| `/api/auth/mfa` | `mfa/router.py` | Enroll/verify TOTP, email OTP, backup codes, trusted devices. |
| `/api/admin` | `admin/router.py` + `analytics.py` + `observability_router.py` | Users CRUD, analytics time-series, console log tail, audit log. |
| `/api/admin/app-settings` | `app_settings/router.py` | Global toggles. |
| `/api/chat` | `chat/router.py` | Conversations, messages, streaming, compaction, search, share, export. |
| `/api/chat/projects` | `chat/projects_router.py` | Chat projects CRUD + file bag + `/{id}/usage` rollup. `/conversations/search` takes an optional `project_id` filter. |
| `/api/chat/compare` | `chat/compare_router.py` | Compare groups create / send / crown / archive / delete. |
| `/api/models` | `models_config/router.py` | Providers CRUD, list upstream models, enable/disable. |
| `/api/study` | `study/router.py` | Study topics, units, sessions, exams, exercises. |
| `/api/search` | `search/router.py` | Per-user search-provider config + ad-hoc search. |
| `/api/files` | `files/router.py` | Upload, list, rename, move, delete, download. Safety + quotas enforced. |
| `/api/notifications` | `notifications/router.py` | VAPID public key, subscribe/unsubscribe, preferences. |

Docs (`/api/docs`, `/api/redoc`, `/api/openapi.json`) are exposed **only when `DEBUG=true`**.

---

## 8. Streaming flow (chat)

1. Client calls `POST /api/chat/conversations/{id}/send` with the user message, model, tools + search settings.
2. Backend returns a `stream_id` and the frontend opens `GET /api/chat/stream/{stream_id}` as an SSE request.
3. `stream_runner.py` calls the provider via `ModelRouter` (OpenAI SDK for most; Anthropic SDK for Claude), forwards tokens as `data: {...}` events, and intermixes structured `tool` events when the model calls a tool.
4. On completion it writes the assistant message, updates usage rollups, and sends a final `end` event.
5. Errors are classified by `_classify_upstream_error` (e.g. OpenRouter privacy 404, invalid image data URL) so the frontend's `StreamErrorCard` can render an actionable message instead of a raw string.
6. The frontend hook `useStreamingChat` owns reconnect-on-focus, stream lifetime, and hands tokens to the Zustand chat store.

---

## 9. Security posture

- All write endpoints require auth (Bearer JWT + HttpOnly refresh cookie).
- Production safety checks refuse to boot with a weak `SECRET_KEY`, missing `ALLOWED_ORIGINS`, insecure cookies, or wildcard CORS.
- Outbound HTTP from tools routes through `app/net/safe_fetch.py` — blocks private IPs, validates redirect targets, caps response sizes. Only the SearXNG docker hostname is allow-listed.
- Uploads are validated by magic bytes (`filetype`), EXIF/GPS stripped, written via atomic `os.replace`, 0-byte uploads rejected at both router entry and after EXIF stripping.
- Refresh tokens carry `tv`; bumping `User.token_version` kicks every session for that user.
- Password reset + invite links are single-use signed tokens.
- MFA enrollment is opt-in per user; admins can force it globally.
- Rate limits on login, refresh, setup, MFA, and chat sends; per-IP + per-identifier + per-user sliding windows.
- CORS is explicit, no wildcards; cookies are `Secure=true` + `SameSite=strict` by default.
- Docs (`/api/docs`) are hidden in prod.

---

## 10. Development ergonomics

- **Dev**: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` — Vite HMR, exposed backend on 8000.
- **Prod**: `docker compose up -d` — nginx is the only host-exposed port.
- **Migrations**: `backend/entrypoint.sh` runs `alembic upgrade head` on every boot. Create new migrations with `docker compose exec backend alembic revision -m "..."` (autogenerate works because `db_models.py` aggregates every model).
- **Frontend build**: `npm run build` inside the container (`tsc -b && vite build`); PWA icons are regenerated from `frontend/public/promptly-icon.svg` via `scripts/generate-pwa-icons.mjs` on every build.
- **Linting**: `npm run lint` (ESLint, zero warnings permitted).
- **Testing**: lightweight — deep health probe is the main CI gate today.

---

## 11. Maintenance notes for this document

Treat `OVERVIEW.md` as a living source of truth. **When a change lands, update this file in the same commit** so the next reader doesn't have to reverse-engineer intent from the diff.

Concrete triggers that should bump this doc:

| Change | Section(s) to touch |
|---|---|
| New feature or user-visible flow | §5 (Feature catalogue), §7 if it adds an endpoint |
| New table / column | §6 (Database schema) |
| New API router | §7 (API surface) + `main.py` row |
| New Python/JS dependency | §2 (Tech stack) |
| New Docker service or changed port mapping | §3 (Architecture) + §2 |
| New migration | bump the migration count in §6 |
| Mobile-only / desktop-only gating change | §5.11 |
| Security-relevant tweak (auth flow, uploads, SSRF list) | §5.1 and/or §9 |

Also bump the **Last updated** line at the top of the file with a one-line note about what changed.
