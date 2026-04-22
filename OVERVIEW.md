# Promptly — App Overview

> Single-source reference for **what Promptly is, what it does, and how it's built**. `README.md` is the operator runbook (deploy + day-2 ops); this document is the product + architecture map. Update it whenever a feature lands, gets reworked, or gets removed.
>
> **Last updated:** 2026-04-22 (clarified project-scope sharing semantics: system prompt + pinned files shared, conversation history is not)

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
- Dedicated `/projects` and `/projects/:id` pages modelled on the Study topic UI, with an Archive tab.
- Move an existing conversation into or out of a project from the chat menu. Temporary chats are ineligible.
- **What's shared across chats in a project**: the project's system prompt (prepended to each chat's system message) and the project's pinned files (folded into the first user turn of every chat alongside that turn's own attachments). Projects also set the default model/provider for new chats inside them.
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

All tables are created by Alembic (`backend/alembic/versions/`), currently at migration **0029**. Ownership is enforced by FK + row-level queries, not Postgres RLS.

| Table | What it holds | Key columns |
|---|---|---|
| `users` | Accounts | `id`, `email`, `username`, `role` (`admin`/`user`), `password_hash`, `token_version`, `is_locked`, `failed_login_count`, `mfa_required`, `quota_*` |
| `auth_events` | Audit log | `user_id?`, `event`, `ip`, `user_agent`, `created_at` |
| `conversations` | Chat threads | `user_id`, `title`, `pinned`, `starred`, `temporary`, `expires_at?`, `project_id?`, `compare_group_id?`, `model_id`, `web_search_mode`, `tools_enabled` |
| `messages` | Turns inside a conversation | `role` (`user`/`assistant`/`system`), `content`, `tokens_prompt`, `tokens_completion`, `cost_usd`, `model_id`, `tsv` (FTS), `created_at` |
| `conversation_shares` | Read-only + collaborator shares | `conversation_id`, `token`, `access`, `invited_user_id?`, `expires_at?` |
| `compare_groups` | Side-by-side runs | `user_id`, `title`, `seed_prompt`, `crowned_conversation_id?`, `archived_at?` |
| `chat_projects` + `chat_project_files` | Projects | `user_id`, `name`, `system_prompt`, shared file bag |
| `user_files` + `file_folders` | Files library | `user_id`, `original_filename`, `storage_path`, `mime`, `size_bytes`, `kind` (upload/generated), `source_conversation_id?`, folder tree |
| `study_projects` / `study_units` / `study_sessions` / `study_exams` / `study_messages` / `whiteboard_exercises` / `study_notes` | Study mode state | topic plan, unit mastery, exam runs, whiteboard payloads |
| `model_providers` | Admin-configured providers + enabled models | `kind`, `name`, `base_url`, `api_key_enc`, `enabled_models` JSON |
| `search_providers` | Enabled search backends + keys | `kind`, `api_key_enc`, `enabled` |
| `app_settings` | Singleton-ish global settings | theme default, default provider, feature flags |
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
| `/api/chat/projects` | `chat/projects_router.py` | Chat projects CRUD + file bag. |
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
