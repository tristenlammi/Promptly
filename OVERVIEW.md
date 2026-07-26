# Promptly — Project Overview & Architecture

> **Single-source reference for what Promptly is, what it does, and how it's built.**
> `README.md` is the operator runbook (deploy + day-2 ops); this document is the full product + architecture map. Update it whenever a feature lands, gets reworked, or gets removed.
>
> **Last fully rewritten:** 2026-07-12 — regenerated from a ground-up read of the codebase (backend, frontend, infra, migrations through `0160`).

---

## Table of contents

1. [What Promptly is](#1-what-promptly-is)
2. [Tech stack at a glance](#2-tech-stack-at-a-glance)
3. [Repository map](#3-repository-map)
4. [Architecture & infrastructure](#4-architecture--infrastructure)
5. [Security, auth, MFA, users & admin](#5-security-auth-mfa-users--admin)
6. [Chat — the core feature](#6-chat--the-core-feature)
7. [Models & providers](#7-models--providers)
8. [Chat tools, research, search, code, image gen & MCP](#8-chat-tools-research-search-code-image-gen--mcp)
9. [Workspaces](#9-workspaces)
10. [Files / Drive](#10-files--drive)
11. [Custom models & RAG knowledge bases](#11-custom-models--rag-knowledge-bases)
12. [User memory](#12-user-memory)
13. [Voice](#13-voice)
14. [Notifications](#14-notifications)
15. [Automations (node-graph flows)](#15-automations-node-graph-flows)
16. [Feedback & saved prompts](#16-feedback--saved-prompts)
17. [Frontend architecture](#17-frontend-architecture)
18. [Appendix](#18-appendix)

---

## 1. What Promptly is

Promptly is a **self-hosted, multi-user AI workspace**. It pairs a Claude.ai-style chat UI with a bring-your-own-key model layer, production-grade auth, and a set of differentiating features:

- **Chat with any model** — Anthropic, OpenAI, Google, DeepSeek, Atlas Cloud, 300+ models via OpenRouter, local models via Ollama, and any OpenAI-compatible endpoint.
- **Agentic tools & deep research** — the model can search the web, fetch/follow pages, run Python in a sandbox, generate PDFs and images, fan out to parallel research sub-agents, and call external **MCP** connectors.
- **Workspaces** — chats, notes, canvases, boards, sheets and rosters that all share one retrieval (RAG) layer, so any chat in a workspace is grounded in everything the workspace knows.
- **Files / Drive** — a real drive experience (folders, trash, star, search, sharing) built on local disk, with collaborative rich-text documents.
- **Voice** — self-hosted Whisper dictation and Kokoro read-aloud, plus a hands-free half-duplex voice mode.
- **Automations** — a visual node-graph flow engine on cron / webhook / event triggers with a per-user credentials vault.
- **User memory** — persistent, per-user facts injected into every chat.
- **Multi-user & secure** — invite-only accounts, TOTP/email MFA, OIDC SSO, an append-only audit log, per-user quotas, and full admin analytics.
- **Private by architecture** — zero telemetry; pair it with local models + local search for a fully offline stack.

It runs as a single `docker compose up -d` on a small Linux box, Unraid server, or Docker Desktop — no cloud services required beyond the LLM provider of your choice. The design target is one admin sharing an instance with a handful of users (family, a small team).

> **North star:** be a genuinely better product than Open WebUI — neutralize its strengths (extensibility, mobile, integrations) while widening Promptly's moat in the workspace, grounded-AI, and automation surfaces.

---

## 2. Tech stack at a glance

### Frontend
- **React 18 + TypeScript**, built by **Vite 5**, shipped as an installable **PWA** (Workbox / `vite-plugin-pwa`, `injectManifest`).
- **Tailwind CSS 3** over a CSS-variable design-token layer (light + dark, terracotta `#D97757` accent).
- **Zustand** for client/UI state (17 stores), **TanStack Query v5** for server state, **Axios** for HTTP (single-flight 401 refresh).
- **React Router v6** for routing.
- **TipTap** (+ Yjs) for rich-text notes/documents; **Excalidraw** for canvas; **Fortune-Sheet** for spreadsheets/rosters; **React Flow** (`@xyflow/react`) for the automations editor.
- **react-markdown** + remark/rehype (GFM, KaTeX, highlight.js) for message rendering; **Mermaid** diagrams; **CodeMirror 6** for code-artifact editing; **Recharts** for analytics.
- **nspell / Hunspell** for note spellcheck; **DOMPurify** for sanitization; **Lucide** icons.

### Backend
- **FastAPI** (async) on **Python 3.11**, served by a **single Uvicorn worker** (see below).
- **PostgreSQL 15 + pgvector** (`pgvector/pgvector:pg15`) — primary datastore incl. all RAG vectors.
- **Redis 7** — SSE/streaming reconnect state, rate-limit counters, and the Arq job queue.
- **SQLAlchemy 2.0** (async, asyncpg) + **Alembic** migrations.
- **Arq** — durable background worker (automations, meeting transcription).
- **OpenAI SDK** drives every provider's `/chat/completions`; the **Anthropic** SDK is present but chat flows through the OpenAI-compat path.
- `python-jose` (JWT), `passlib[bcrypt]` (password hashing), Fernet (at-rest encryption of secrets), `pywebpush` (VAPID web push), `httpx` (outbound, SSRF-guarded).

### Sidecar services
- **collab** — Node ≥20 **Hocuspocus** Yjs websocket server for real-time notes/canvas/sheets.
- **sandbox** — hardened Python execution worker (air-gapped network, read-only rootfs, rlimits).
- **whisper** — `faster-whisper` STT shim; **tts** — Kokoro-82M (`kokoro-onnx`) read-aloud shim.
- **searxng** — bundled metasearch engine for web search.
- **ollama** (optional profile) — local model runtime for embeddings + optional local chat models.
- **nginx** — the sole public entrypoint (reverse proxy, TLS/HSTS, CSP, edge rate limits).

### Why one Uvicorn worker
The SSE streaming layer keeps each generation's event buffer in **process memory** for navigate-away/reconnect, and the embedding-fairness gate coordinates in-process. Running more than one worker breaks reconnects. This is a hard constraint — don't re-add `--workers 2` without first moving that state into Redis.

---

## 3. Repository map

```
Promptly/
├── docker-compose.yml         # the whole stack (service definitions + 2 networks)
├── docker-compose.dev.yml
├── install.sh / install.ps1   # one-shot installer (secret gen, profile detect, build, health-wait)
├── update.sh  / update.ps1    # pull + rebuild + recreate + nginx reload + health check
├── README.md                  # operator runbook
├── OVERVIEW.md                # this document
├── .env / .env.example        # config surface
│
├── backend/                   # FastAPI app
│   ├── Dockerfile             # python:3.11-slim; dev (reload) + prod (single worker) targets
│   ├── entrypoint.sh          # runs `python -m app.bootstrap` (migrate+provision) then uvicorn
│   ├── requirements.txt
│   ├── alembic/               # 160 migrations; head = 0160_remove_chart_dataview
│   └── app/
│       ├── main.py            # FastAPI app, router registration, lifespan loops, health
│       ├── config.py          # Pydantic-Settings (env), boot-safety validation
│       ├── bootstrap.py       # migrate + provision app_settings/VAPID/system providers
│       ├── database.py redis_client.py logging_setup.py cors_dynamic.py rate_limit.py
│       ├── db_models.py db_types.py   # ORM aggregator + shared mixins
│       ├── auth/  mfa/  groups/       # identity, second factor, role bundles
│       ├── admin/ billing/ observability/  # admin console, usage/quota, error capture
│       ├── app_settings/ models_config/    # instance settings, provider/model catalog
│       ├── chat/          # the core: router, streaming, tools/, agent_runner, artifacts…
│       ├── workspaces/    # 19 modules: items, canvas, boards, sheets, rosters, meetings, RAG
│       ├── files/         # Drive: storage, safety, extraction, sharing, quotas
│       ├── custom_models/ # user-created assistants + RAG knowledge bases
│       ├── memory/        # persistent per-user memory
│       ├── research/      # deep-research engine
│       ├── search/        # web-search provider abstraction + failover
│       ├── voice/         # STT/TTS backend service
│       ├── notifications/ # web push + inbox
│       ├── tasks/         # automations (flow engine, scheduler, arq worker)
│       ├── mcp/           # Model Context Protocol connectors (+ native UniFi)
│       ├── secrets/       # per-user encrypted credentials vault
│       ├── code/          # user-facing "Run" endpoint
│       ├── feedback/ saved_prompts/ local_models/
│       └── net/safe_fetch.py           # SSRF guard for all outbound HTTP
│
├── frontend/                  # React + TS + Vite SPA (PWA)
│   ├── src/
│   │   ├── App.tsx main.tsx sw.ts index.css
│   │   ├── pages/  components/  store/ stores/  api/  hooks/  utils/  styles/
│   └── vite.config.ts  tailwind.config.ts  package.json
│
├── collab/                    # Node Hocuspocus Yjs server (src/server.js)
├── sandbox/                   # code execution worker (server.py)
├── whisper/  tts/             # STT / TTS sidecar FastAPI shims
├── searxng/                   # SearXNG settings.yml
├── nginx/                     # nginx.conf + ssl/
├── scripts/                   # ollama-bootstrap.sh, VAPID key gen, etc.
├── data/                      # (gitignored) all runtime state: postgres, redis, ollama, uploads…
└── docs/                      # (gitignored, local-only) design docs & roadmaps
```

Backend feature modules follow a consistent shape: `router.py` (endpoints), `models.py` (ORM), `schemas.py` (Pydantic DTOs), `service.py` (logic). `db_models.py` is a pure aggregator that imports every ORM class so Alembic sees complete metadata.

---

## 4. Architecture & infrastructure

### 4.1 Service topology

Everything is defined in `docker-compose.yml` (compose project name `Promptly`). **Only nginx publishes host ports;** every other service talks over two internal Docker networks:

- **`promptly`** — the main app network.
- **`sandbox-net`** (`internal: true`) — an air-gapped network with **no route to the internet or host**. Only the backend and the code sandbox join it, so executed code can reach nothing except the backend that submitted the job.

| Service | Role | Image / build | Notes |
|---|---|---|---|
| **nginx** | Sole public entrypoint; reverse-proxies UI + API + collab WS | `nginx:alpine` | Ports `${NGINX_HTTP_PORT:-8087}:80`, `:8488→443`. TLS/HSTS gating, strict CSP, edge rate/conn limits, real-client-IP resolution. Re-resolves upstreams via Docker DNS at request time (recreated containers heal without a bounce). |
| **frontend** | Serves the built SPA | build `frontend/Dockerfile` | `VITE_API_BASE_URL=/api`. |
| **backend** | FastAPI app (API + SSE + in-process loops) | build `backend/Dockerfile` | Single uvicorn worker; joins **both** networks; `mem_limit 4g`. |
| **arq-worker** | Durable automation + meeting-notes jobs | same image as backend | Entrypoint overridden to `arq app.tasks.worker.WorkerSettings` so it never races the backend to migrate. |
| **collab** | Hocuspocus Yjs WS server for docs/canvas/sheets | build `collab/Dockerfile` (Node ≥20) | Verifies collab JWT (shared `SECRET_KEY`), persists CRDT to Postgres, debounces HTML/FTS snapshots back to the backend. |
| **postgres** | Primary datastore incl. pgvector RAG | `pgvector/pgvector:pg15` | Internal only; volume `./data/postgres`. |
| **redis** | Streaming state, rate limits, Arq queue | `redis:7-alpine` | Internal only; volume `./data/redis`. |
| **ollama** / **ollama-gpu** / **ollama-rocm** | Local LLM runtime — embeddings + optional local chat | `ollama/ollama:latest` (rocm variant) | Loopback-only host mapping by default (Ollama has no auth). Profiles `ollama` / `gpu` / `rocm` share the `ollama` network alias, so exactly one runs. Auto-pulls the embed model on first start. |
| **searxng** | Bundled metasearch for web search | `searxng/searxng` (pinned) | `cap_drop: ALL`; profile `search`. |
| **sandbox** | Code-interpreter execution worker | build `sandbox/Dockerfile` | `read_only: true`, tmpfs scratch, `cap_drop: ALL`, `no-new-privileges`, `pids_limit 256`; **only** on `sandbox-net`. |
| **whisper** | Speech-to-text (faster-whisper) | build `whisper/Dockerfile` | int8/CPU default; weights cached to a volume. |
| **tts** | Text-to-speech (Kokoro-82M) | build `tts/Dockerfile` | Emits 16-bit PCM WAV. |

**Compose profiles** (selected via `COMPOSE_PROFILES` in `.env`, written by the installer): `ollama` / `gpu` / `rocm` (mutually exclusive), and `search`. A full install writes `ollama,search`; `--no-search` / `--with-ollama` flip these. Optional dependencies use `required: false` (needs compose ≥ 2.20) so the backend still boots when a profile is inactive.

All stateful data is bind-mounted under `./data/` (postgres, redis, ollama, whisper, tts, uploads, whiteboard) — **backup is just a directory copy.**

### 4.2 Backend bootstrap (`app/main.py`, `config.py`, `bootstrap.py`)

- **Fail-fast boot check** — on import, `settings.validate_boot_safety()` refuses to start (`InsecureProductionConfig`) if `SECRET_KEY` is the dev placeholder or < 32 chars, and on a public `DOMAIN` also rejects placeholder DB/Redis passwords and unsafe `SINGLE_USER_MODE`.
- **Config** — `config.py` is a Pydantic-Settings class (`.env`, `lru_cache`d). It centralizes app identity, cookie flags, a trusted-proxy CIDR list for real-IP extraction, MFA + lockout tunables, the rate-limit DSL set, token TTLs, `DATABASE_URL`/`REDIS_URL`, sandbox/STT/TTS/search settings, an SSRF host allowlist, provider API-key seeds, and VAPID keys. One `SECRET_KEY` derives JWT signing, all Fernet at-rest encryption, avatar HMACs, and the sandbox bearer.
- **Lifespan loops** (in-process, single-worker): the temporary-conversation **sweeper**, the automations **scheduler**, the **semantic indexer** (embeds messages for the search palette), and the **chat-upload sweeper**.
- **Middleware** (outer→inner): app-wide blanket rate-limit dep → global exception handler (persists 500s to `error_events`) → optional `TrustedHostMiddleware` → `RequestContextMiddleware` (request-id, structured access log) → **`DynamicCORSMiddleware`** (rebuilds the allow-set per request from localhost ∪ env `ALLOWED_ORIGINS` ∪ DB `app_settings.public_origins`, 15s cache, flushed on admin edit).
- **Health** — `GET /api/health` (public) pings Postgres/Redis/(SearXNG) in parallel, returns per-component booleans only; it's the Docker healthcheck.
- **Docs** — `/api/docs`, `/api/redoc`, `/api/openapi.json` are exposed **only when `DEBUG=True`**.
- **Database** — async SQLAlchemy engine (`pool_pre_ping`, `pool_size=10`, `max_overflow=20`), `expire_on_commit=False`, per-request `get_db()`.

**Routers** are all mounted under `/api`: `auth`, `mfa`, `admin`, `app_settings`, `workspace_defaults`, `chat_folders`, `chat`, `proposals`, `hooks`, `saved_prompts`, `feedback`, the workspaces family (`workspaces`/`items`/`drive`/`ask`/`overview`/`tasks`/`comments`/`meetings`/`export`/`shares` + `canvas` + `workspace-search`), `secrets`, `mcp` (admin + workspace), `groups`, `models`, `links`, `custom_models`, `local_models`, `tasks`, `memory`, `voice`, `billing` (`/api/usage`), `research`, `code`, `search`, `files`, `documents`, `file_share` (`/api/s`, anonymous), and `notifications`.

### 4.3 Data model

56 tables across the domains, defined per-feature in `**/models.py`. Shared mixins in `db_types.py`: `UUIDPKMixin` (client-generated UUID4 PK), `TimestampMixin`, `CreatedAtMixin`. Grouped:

- **Identity & auth** — `users`, `auth_events` (audit), MFA (`user_mfa_secrets`, `mfa_backup_codes`, `mfa_trusted_devices`, `email_otp_challenges`), `user_groups` + `user_group_members`.
- **Chat** — `conversations`, `messages`, `message_embeddings` (pgvector), `chat_folders`, `compare_groups` (dormant).
- **Workspaces** — `workspaces`, `workspace_items`, `workspace_canvas`, `spreadsheets`, `rosters`, `workspace_files` + `conversation_excluded_workspace_files`, `workspace_shares`, `workspace_tasks` + `workspace_task_comments`, `workspace_item_comments`, `workspace_proposals`, `meeting_jobs`.
- **Files / Drive** — `files`, `file_folders`, `file_share_links`, `file_share_grants`, `document_state` (Yjs CRDT), `document_versions`, `resource_grants`.
- **Custom models & RAG** — `custom_models`, `custom_model_files`, `knowledge_chunks` (pgvector; scope CHECK = exactly one of custom_model/workspace/conversation).
- **Automations** — `tasks`, `task_runs`, `task_connectors`, `flow_graph_versions`, `automation_node_memory`.
- **Providers & integrations** — `model_providers`, `search_providers`, `mcp_connectors` + `workspace_mcp_connectors` + `connector_groups` + `connector_users`, `user_secrets` (encrypted vault).
- **Everything else** — `notifications`, `push_subscriptions`, `push_preferences`, `user_memories`, `usage_daily`, singleton `app_settings`, `error_events`.

### 4.4 Migrations & deployment

- **Alembic** (`backend/alembic/`) — **160 migrations**, head `0160_remove_chart_dataview`. `env.py` pulls the URL from settings, runs async with a `NullPool`. Revision ids must stay **≤ 32 chars** (`alembic_version.version_num` is `varchar(32)`) or the backend crash-loops on boot.
- Migrations run at **container start**, not in-process: `entrypoint.sh` runs `python -m app.bootstrap` (Alembic `upgrade head` + provision the `app_settings` singleton, a VAPID keypair on first boot, and the system SearXNG provider) before handing off to uvicorn. The arq-worker **overrides the entrypoint** so only the backend migrates.
- **Install** — `install.sh` / `install.ps1`: checks Docker/compose/openssl, seeds secrets (only replacing `change-me…` placeholders), detects the Ollama mode (cloud default / host-native detected / `--with-ollama` GPU probe), writes `COMPOSE_PROFILES`, then builds + brings up + polls health. Idempotent.
- **First-run wizard** (browser, no `.env` editing) — `setup-status` gates until an admin exists; `POST /auth/setup` (advisory-locked, rate-limited) creates the bootstrap admin; later steps set the public URL, embedding strategy, and optional MFA.
- **Update** — `update.sh` / `update.ps1`: `git pull --ff-only`, rebuild, recreate (profiles preserved), reload nginx, poll health.

### 4.5 Background worker

- **Arq worker** (`tasks/worker.py`, own container): jobs `execute_task_run` (one automation flow) and `execute_meeting_job` (chunked meeting transcription, 3h timeout). `queue.py` degrades gracefully to inline `asyncio.create_task` if Redis is unreachable, so nothing is silently dropped.
- **Scheduler** (`tasks/scheduler.py`, in-process loop, 60s): claims due tasks with `FOR UPDATE SKIP LOCKED`, advances `next_run_at` **before** running (overlap guard — after downtime fires once, no backfill), honors `concurrency=skip`.

---

## 5. Security, auth, MFA, users & admin

Promptly is single-tenant, **invite-only** (no public registration), self-hosted. Auth is built in-house: bcrypt hashing, HS256 JWTs, an HttpOnly refresh cookie, an append-only audit log, optional TOTP/email MFA, and optional OIDC SSO.

### 5.1 Token & session model (`auth/`)

| Token | Delivery | Default TTL | Purpose |
|---|---|---|---|
| **Access** | Response body → held in memory (Zustand) | 15 min | Bearer on every API call |
| **Refresh** | `promptly_refresh` HttpOnly cookie, `path=/api/auth` | 3 days | Exchanged at `POST /auth/refresh` |
| **mfa_challenge** | Response body | 10 min | After password OK when MFA enrolled |
| **mfa_enrollment** | Response body | 10 min | When `mfa_required` but no method yet |

- **HS256**, signed with `SECRET_KEY`. Every token carries a **`tv` (token_version)** claim compared against `User.token_version` on each request — bumping it invalidates **all** sessions instantly (used on password change, admin reset, disable, MFA disable, "log out everywhere"). There is no server-side session store.
- **Refresh** is single-flight on the client (deduped, retries the original request once on 401).
- Registration is disabled (`POST /auth/register` always 403). **First-run setup** creates the first admin, serialized by a Postgres advisory lock so a race can't create two admins.

### 5.2 Login hardening

- **Rate limits** run before the DB query. Constant-time posture: unknown users get a dummy bcrypt verify (`waste_a_verify`); every failure mode (disabled / locked / wrong password) returns the same generic `"Invalid credentials"` while auditing the real reason.
- **Account lockout** — `LOCKOUT_THRESHOLD=5` failures sets `locked_at`; the lock auto-expires after `LOCKOUT_COOLDOWN_MINUTES=15` (a non-zero cooldown prevents lockout being weaponized as a DoS, since anyone can enumerate handles). Admins unlock via `POST /admin/users/{id}/unlock`.
- **Password policy** (`auth/password_policy.py`) — min 10 / max 128, ≥1 digit, ≥1 symbol, ≥5 distinct chars, small common-password blocklist. Applied to setup/register/change (not login).

### 5.3 Audit log (`auth/events.py`)

Append-only `auth_events` (`user_id` = `ON DELETE SET NULL` so the trail survives deletion). Event types are module constants (not a DB enum): login/logout/lockout/unlock/disable/enable, password changes, `token_refresh`/`refresh_rejected`, the full `mfa_*` set, `app_settings_changed`, `rate_limited`, `file_upload_rejected`, `budget_exceeded`, `ssrf_blocked`, `tool_invoked/failed`, secret CRUD, and a workspace-lifecycle set. **Spoof-resistant client IP**: forwarded headers (`CF-Connecting-IP`/`X-Real-IP`/`X-Forwarded-For`) are honored only when the socket peer is in `TRUSTED_PROXY_IPS`. Surfaced to admins at `GET /admin/auth-events`.

### 5.4 MFA (`mfa/`)

Enrollment status is denormalized onto the `users` row so the login hot path needs no join. Decision order after a password check: valid trusted-device cookie → **allow**; enrolled → **challenge**; `mfa_required` but not enrolled → **force enrollment**; else **allow**.

- **TOTP** — 160-bit base32 secret, Fernet-encrypted; QR as an inline `data:` URI; ±30s skew; **replay defense** via a 90s Redis window (fails open on Redis error).
- **Email OTP** — 6-digit, SHA-256-hashed, 10-min TTL, ≤5 attempts, per-user send throttles (30s min interval, 10/hour) to defend against inbox-bombing via the instance's SMTP.
- **Backup codes** — 10 codes, **bcrypt**-hashed, shown once, consumed on use.
- **Trusted devices** — 256-bit token in an HttpOnly cookie; DB stores only its SHA-256; 30-day expiry; listable/revocable. Disabling MFA deletes them all.
- **SMTP transport** (`mfa/smtp.py`) — async `aiosmtplib`, config read from `app_settings` per send (rotate without restart), TLS per port (465 implicit, 587 STARTTLS). Shared by MFA, budget alerts, and feedback.

### 5.5 OIDC / SSO (`auth/oidc.py`)

Optional, **off by default**, config in `app_settings` (client secret Fernet-encrypted). A lean OIDC *client* on httpx + python-jose: signs `state`/`nonce` into a short-lived tx cookie, verifies the `id_token` against the issuer's JWKS (**asymmetric algs only** — `HS*`/`none` rejected), checks signature/audience/issuer/expiry/nonce. **Invite-only matching**: requires `email_verified`, matches the lowercased email to an existing non-disabled user — **no auto-provisioning**. Discovery + JWKS cached 1h. (Shipped 2026-07-09, migration 0152.)

### 5.6 Groups, roles & per-user flags (`groups/`, `auth/models.py`)

- **`UserGroup`** — an admin-managed role bundle whose `allowed_models` are additively UNIONed into each member's own access, and which scopes MCP connector reach.
- **`role`** — `admin` (full access, never gated) or `user`.
- **`allowed_models`** (tri-state) — `NULL` = full curated pool, `[]` = none, `[...]` = subset.
- **`can_generate_images`** / **`can_execute_code`** — per-user gates for the image tool and the user-facing Run button.
- **Quota overrides** — `storage_cap_bytes`, `daily_token_budget`, `monthly_token_budget` (NULL falls back to instance default).

### 5.7 Admin console (`admin/`, `require_admin`)

- **Users** — list/create/update/delete, CSV export/import (temp password shown once, never overwrites existing), self-safety guards (can't demote/disable/delete self), unlock/disable/enable/reset-password/logout-everywhere. Delete routes through `tasks.deletion.purge_user` to remove on-disk bytes.
- **Model pool** — the flat org-wide pool (every enabled provider's curated models, plus custom models as `custom:<uuid>`).
- **Analytics** (`admin/analytics.py`) — read off the `usage_daily` rollup (cost stored as integer **micros**): summary, timeseries, per-user, by-model, drill-down.
- **Observability** — an SSE **live log tail** off an in-memory ring buffer, and **error groups** (grouped by fingerprint) with resolve/reopen.
- **App settings** — SMTP, OIDC, embedding provider/model/dim, default model roles, budgets, VAPID, public origins.

### 5.8 Secrets & billing

- **Vault** (`secrets/`) — `UserSecret`, one Fernet-encrypted value per `(user, UPPER_SNAKE_CASE name)`, strictly owner-scoped, values never returned on read. Referenced in automations as `{{secret.NAME}}`, resolved only inside the HTTP-request node, redacted from run records, never sent to an LLM.
- **Usage & budgets** (`billing/`) — `UsageDaily` rollup upserted (`ON CONFLICT`) per finished stream. `check_budget` resolves per-user → instance default → unlimited, sums UTC-midnight daily/monthly windows, returns `ok`/`warn`(≥80%)/`blocked`(≥100%). First `warn` emails admins once/month.

### 5.9 Rate limiting & SSRF

- **Rate limiting** (`rate_limit.py`) — Redis-backed via the `limits` library, keyed on the spoof-resistant client IP. Buckets: blanket `300/min`, login `10/min` (+ per-identifier `5/min`), refresh `60/min`, setup `3/hour`, MFA verify `20/min`, MFA email send `10/hour`, share unlock `10/min`, and a **moving-window** per-user chat cap `60/5min`. Every 429 writes an audit row.
- **SSRF guard** (`net/safe_fetch.py`) — `assert_url_is_safe` refuses non-http(s) and any private/loopback/link-local/metadata resolution (IPv4+IPv6, IPv4-mapped unwrapping); `SSRF_ALLOWED_HOSTS` (default `searxng`) skips the private check but **never** the metadata check. `safe_fetch` validates before opening the socket, **re-validates every redirect hop** (bounded at 5), enforces a timeout, and caps the body (default 10 MiB). Provider `base_url`s validate through `assert_provider_url_safe` (allows loopback for local models, refuses IMDS).

---

## 6. Chat — the core feature

The chat backend lives under `backend/app/chat/` (the router alone is ~6,400 lines). It is a fully agentic, streaming, branchable chat with layered system prompts, tool calling, RAG, and reconnect-safe generation.

### 6.1 Two-phase send → stream

A message send is split into two HTTP requests so generation survives a client disconnect:

1. **`POST /conversations/{id}/messages`** (`202`) — enforces quotas/rate-limits, checks owner-only send, resolves the effective provider/model (request overrides the conversation default; `custom:<uuid>` resolves to a base), persists the user `Message` into the version tree (`parent_id = active_leaf`), and stashes a `StreamContext` in **Redis** under a fresh `stream_id` (60s TTL). Returns `{stream_id, user_message}`.
2. **`GET /stream/{stream_id}`** — opens the SSE `text/event-stream`.

### 6.2 Reconnect-safe streaming (`stream_runner.py`)

Generation runs in a **detached asyncio task**, decoupled from the HTTP connection. The task pushes each SSE chunk into an in-memory `StreamSession.events` list; the HTTP handler is merely a **subscriber**. When the client disconnects, only the subscriber is cancelled — the background task keeps producing tokens, the assistant message still lands in Postgres, usage still ticks. **Reconnect** (`find_active_for_conversation`) lets the frontend reattach on reload and replay every event from index 0. Finished sessions linger 180s then evict. **This is why the backend runs a single uvicorn worker** (the session table is in-process memory).

### 6.3 Layered system prompt

`merge_system_prompt` composes the prompt with **first-arg-wins** priority. Lowest → highest: base host-capabilities prompt → workspace prompt + retrieved knowledge → attachment-RAG block → account-wide custom prompt → **chat folder** prompt → per-conversation prompt → tool-aware prompt → **personal context (always-injected date/time + optional locale)** → cross-chat memory → @-mention/Drive/connector blocks → custom-model persona + its retrieved knowledge → (on spoken turns) the voice prompt, merged last/highest.

**Date/time is always injected** (`personal_context.py`) — local if the user set a timezone, else UTC — framed as ambient background with an explicit "don't fall back to your training cutoff" instruction. This fixes the "answers as if it's still the training-cutoff year" bug; search queries are also recency-augmented with the year.

### 6.4 Agentic tool-call loop

Up to **`MAX_TOOL_HOPS = 8`**. Each hop streams `stream_chat_events`; deltas dispatch to SSE (`TextDelta` → `{delta}`, `ReasoningDelta` accumulated only, `ToolCallDelta` merged, `UsageEvent` summed). On `finish_reason == "tool_calls"`, `_dispatch_tools` runs them and feeds results back. The **final hop** stacks three forced-finish signals (`tools=None`, `tool_choice=None`, a `[FORCED FINISH]` system injection) because some providers ignore `tool_choice="none"`. A **synthesis-retry** pass rescues the "model burned hops but produced empty text" case. `_strip_leaked_tool_call_xml` scrubs tool-call XML the model emitted as text (incl. `<|DSML|>` wrappers).

### 6.5 Conversations, messages, versioning

- **`Conversation`** — title, model/provider, pin/star, `web_search_mode`, `reasoning_effort`, `system_prompt`, branch lineage, `active_leaf_message_id`, `temporary_mode`/`expires_at`, `workspace_id`, `visibility` (`private`/`workspace`), `folder_id`, summary cache, chat-as-context fields.
- **`Message`** — `parent_id` self-FK (the version tree), `content`, `reasoning_content`, `sources`/`tool_calls`/`attachments` (JSONB), per-message stats (tokens, `ttft_ms`, `total_ms`, `cost_usd_micros`), `model_id`, `feedback`.
- **Versioning** (`versioning.py`) — sibling messages sharing a `parent_id` are versions. History is built from `lineage_to(leaf)` (a root-ward walk), **not** a flat `created_at` scan, so off-path versions never leak into the prompt. **Edit** inserts a sibling user turn (non-destructive); **regenerate** streams a sibling assistant answer (the ‹2/3› version pager, supports "try another model"); **continue** resumes a truncated reply; **branch** forks a new conversation.
- **Folders** (`folders_router.py`, migration 0148) — personal sidebar folders grouping chats; a folder's `system_prompt` applies live to every chat in it; `default_model` seeds new chats; deleting a folder lifts its chats (`SET NULL`). Mutually exclusive with workspaces.
- **Temporary / subchats** — `temporary_mode="one_hour"` slides `expires_at` on each send; a 5-min sweeper hard-deletes expired chats. Subchats are ephemeral throwaway side-chats on the same machinery (a floating side panel = ephemeral branch); their streaming uses isolated local state so a concurrent side-stream doesn't clobber the main conversation.
- **Sharing** — per-chat sharing was removed; a workspace member reads a chat only when `visibility=="workspace"` and they have an accepted share (read-only).

### 6.6 Attachments, RAG & vision in chat

- **Inline preamble** — small attachments' extracted text is spliced into the triggering turn.
- **Conversation attachment RAG** (`attachment_rag.py`) — "index for this chat" chunks+embeds files into `knowledge_chunks` (`scope_kind="conversation"`); at send time the top-8 chunks are retrieved as a knowledge block and the indexed files are skipped from the inline path. Chunks cascade-delete with the conversation.
- **Vision relay** (`vision_relay.py`) — if a turn has images the model can't read and an admin configured a vision-relay model, each image is captioned first and spliced into the preamble (with `vision_relay_started/finished` chips). Vision-capable models get real `ImagePart` bytes re-fed on every user turn that had them.
- **Semantic message search** (`semantic_index.py` + `semantic_search.py`) — a lifespan loop embeds messages into `message_embeddings`; cosine search is FTS-fused for the conversation-search endpoint and the Ctrl/Cmd+K palette.

### 6.7 Artifacts

- **Code artifacts with a Run button** (`sandbox_exec.py`) — ships code to the hardened sandbox; output files pass a MIME allowlist + extension deny-list before landing in Drive. Shared by the `code_interpreter` tool and the user-facing `POST /api/code/run`.
- **In-place artifact editing** (`artifact_edit.py`) — applies an NL instruction and returns the **complete** updated source so the side panel patches in place.
- **Workspace write-back proposals** (`proposals_router.py`) — workspace tools never write directly; they file a `WorkspaceProposal` that a human applies from a preview card (re-validated against current state).

### 6.8 Supporting modules

- **Compaction** (`compaction.py`) — summarizes the *middle* of a long chat in place (keeps head + a token-budgeted tail), hard-deletes those rows, splices a `[Compacted summary]` system row. Optional auto-compact fires at ~90% of the window.
- **Summariser** (`summariser.py`) — a non-destructive whole-chat memo, cached, backing the @-mention feature.
- **Titler** (`titler.py`) — 2–4 word titles with `reasoning_effort="off"`, `<think>` stripped, one refine pass at ≥5 messages.
- **Enhance** (`enhance.py`) — rewrites a rough draft or improves a prose passage preserving HTML.
- **Mentions** (`mentions.py`) — `@[title](uuid)` (chat summary), `@[name](file:id)` (Drive text), `@[name](connector:id)` (advertises an MCP server's tools even when Tools is off).
- **Export/Import** — round-trips conversations with mention tokens intact.

---

## 7. Models & providers

A unified `ModelRouter` (`models_config/provider.py`) drives **every** provider through the OpenAI SDK's `/chat/completions` shape. **Eight provider types**:

| Type | Base URL | Notes |
|---|---|---|
| `openrouter` | `openrouter.ai/api/v1` | Richest catalog; the only bespoke path (image gen, `reasoning` param) |
| `openai` | `api.openai.com/v1` | Native OpenAI |
| `anthropic` | `api.anthropic.com/v1` | OpenAI-compat endpoint for chat; native `/v1/models` for catalog |
| `gemini` | Google AI Studio compat | |
| `deepseek` | `api.deepseek.com` | `reasoning_content` round-trip + `thinking`/`reasoning_effort` |
| `atlascloud` | `api.atlascloud.ai/v1` | Hosted aggregator |
| `ollama` | `localhost:11434/v1` | Keyless local |
| `openai_compatible` | admin-supplied | vLLM / LM Studio / LocalAI |

- **Streaming core** — `stream_chat_events` yields the closed union `TextDelta | ReasoningDelta | ToolCallDelta | FinishEvent | UsageEvent`. It strips `reasoning_content` for non-DeepSeek models, drops `tools` when a model's catalog says `supports_tools == False`, and applies the right reasoning knob per provider.
- **Model roles** — the instance's `app_settings` holds six configurable model-role defaults, resolved per caller via `load_effective_defaults`: **default chat**, **vision relay**, **research**, **memory**, **image gen**, **voice**. Roles are system-driven (not gated by the user's `allowed_models`).
- **Access** — `effective_allow_set` = user `allowed_models` ∪ group grants; `None` = unrestricted/admin.
- **Context windows** — `_known_context_window` hard-codes windows per model id since most `/models` endpoints omit them. (Always verify context windows/pricing against official provider docs — never from training memory. Source of truth: `provider.py::_known_context_window`.)
- **Multimodal** — `ContentPart` (`TextPart` | `ImagePart`), each with `to_openai()`. Every outbound call funnels through `assert_provider_url_safe`.

---

## 8. Chat tools, research, search, code, image gen & MCP

### 8.1 Tool framework (`chat/tools/`)

Every server-side function subclasses **`Tool`** (`base.py`): `name`, `description`, `parameters` (JSON Schema), `category`, optional `max_per_turn`/`timeout_seconds`/`max_content_chars`. A **`ToolContext`** carries the same DB session as the chat router (so rows a tool creates are visible to the follow-up model call) plus a progress channel. A **`ToolResult`** returns `content` (fed back to the model), `attachment_ids` (→ chips), `sources` (→ inline `[n]` citations), and `meta` (→ `tool_finished` event). `validation.py` enforces each tool's JSON Schema server-side and `clean_model_text` scrubs adversarial control/bidi/zero-width chars from fetched content.

**Registry** (`registry.py`) — the live tools: `echo`, `generate_pdf`, `generate_image`, `code_interpreter`, `web_search`, `fetch_url`, `run_agents`, `deep_research`, `propose_workspace_note`, `propose_board_cards`, `propose_board_updates`, `read_workspace_item`, `query_board_cards`. (`attach_demo_file` is retired/unregistered.)

**Dispatch** (`_dispatch_tools`) — two-phase: validate/account/launch native tools as concurrent tasks (own session, `asyncio.timeout`, `_TOOL_CONCURRENCY=4`), then drain **in model-call order**. Features: per-turn caps, cross-hop dedup cache (replays cached content instead of re-executing), MCP routing, `tool_started`/`tool_progress`/`tool_finished` SSE events, and a compact **Tool Activity Card** record persisted onto `messages.tool_calls`.

**Category gating** (per turn): `tools_enabled` → `artefact` + `code` (+ `workspace` if in a workspace); `web_search_mode` ∈ {off, auto, always} → `search` (+ `agents` if tools also on). Voice turns skip all tools. `generate_image` is stripped for ungated users.

### 8.2 The tools

| Tool | Category | Purpose |
|---|---|---|
| `echo` | artefact | Diagnostic |
| `generate_pdf` | artefact | Markdown → PDF (+ editable `.md` sidecar) via xhtml2pdf |
| `generate_image` | artefact | Generate/edit an image via OpenRouter |
| `code_interpreter` | code | Run Python in the sandbox (auto-pulls data attachments; persists working dir per conversation) |
| `web_search` | search | Web search → numbered citations (via failover chain) |
| `fetch_url` | search | Fetch + extract one page (trafilatura; Tavily-Extract fallback for walled sites; surfaces in-content links for citation chains) |
| `run_agents` | agents | Fan out to 1–4 parallel research sub-agents (own model↔tool loop, depth-1, merged & renumbered citations) |
| `deep_research` | agents | Full multi-angle web investigation (evidence half of the pipeline, no side effects) |
| `propose_workspace_note` / `_board_cards` / `_board_updates` | workspace | File a write-back proposal for human approval |
| `read_workspace_item` | workspace | Read full live content of a note/board/sheet/canvas by title |
| `query_board_cards` | workspace | Real SQL filter/count over board cards |

### 8.3 Deep research engine (`research/`)

`gather_research_evidence` (shared by the endpoint and the `deep_research` tool): **decompose** (fast model → 5 sub-questions) → **search + read in parallel** (each sub-question on its own session, staggered; top-2 pages fetched, snippet fallback) → **gap check** (1–2 missing angles). The streaming endpoint additionally **synthesizes** a structured cited report, renders a PDF + `.md` pair, and persists the exchange into the conversation. `is_research_worthy` is a zero-cost rule-based classifier for the proactive "want deep research?" chip.

### 8.4 Web search (`search/`)

Provider adapters normalize to `SearchResult`; every request is SSRF-guarded. Providers: **searxng** (self-hosted), **brave**, **tavily** (also powers Extract fallback), **google_pse**, **openrouter** (runs an Exa web-plugin completion on OpenRouter's infra, off the self-host's IP — sidesteps CAPTCHA/rate-limit walls; reuses the admin's existing OpenRouter key). Results are canonicalized (tracking params stripped) and deduped.

**Failover** (`run_search_with_failover`) — walks an admin-ordered chain (by `position`, skipping cooling-down providers). A provider "fails" on a `SearchError` **or** HTTP 200 with empty results (every engine CAPTCHA'd the instance). A **hard** error (401/402/403/429) additionally **pauses that provider for 7 days** and notifies all admins. Query distillation collapses a message into a keyword query and appends the current year to recency-sensitive queries. (Shipped 2026-07-08, migration 0153.)

### 8.5 Code sandbox (`sandbox_exec.py`, `code/`)

The **sandbox container** does the real isolation (internal-only network, read-only rootfs, dropped caps, CPU/mem/time/file rlimits). `run_python_in_sandbox` (the trusted client) base64-encodes input files (≤64 MB), POSTs to `{sandbox}/execute` with a shared-secret header, and gates outputs (extension deny-list + MIME allow-list) before persisting to Drive. `session_id` = conversation id, so a working dir **persists across calls** in a conversation. The user-facing `POST /api/code/run` (Python, one-shot) gates on `can_execute_code` server-side (migration 0159).

### 8.6 Image generation

A **tool-driven system role**, not a chat-model pick (migration 0156). Three access layers: per-user `can_generate_images` (re-checked in `run()`), image-output models hidden from the chat picker, and `max_per_turn=1`. Model resolution: the admin-selected default image model (`app_settings.image_gen_*`) → first `supports_image_output` model in the pool. Distinguishes image-only models (OpenRouter `/images`) from dual-output (chat path). Iteration always produces a **new** file (never mutates history).

### 8.7 MCP (`mcp/`)

Admins connect external **Model Context Protocol** servers (and first-party native connectors) whose tools the model can call. `McpConnector`: `slug` (namespaces tools as `mcp__<slug>__<tool>`), `kind` (`mcp` remote | `unifi`/`omada` native), single Fernet-encrypted auth header, `availability` (`global`/`restricted`), `allowed_tools`, cached `tool_catalog`. Restricted connectors scope via three join tables: workspace (context), group, and direct-user (identity). The transport client (`client.py`) is short-lived per call, SSRF-guarded, timeout + result-capped, and drops destructive tools (`destructiveHint` and not read-only) in the MVP. `connectors_for_turn` resolves availability once per turn. A native **UniFi** connector (`unifi.py`) calls Ubiquiti's API directly with a fixed read-only 3-tool catalog returning concise summaries.

---

## 9. Workspaces

Workspaces are Promptly's flagship organizing surface (the evolution of "Chat Projects"). A workspace bundles **chats, notes, canvases, boards, sheets, rosters, tasks, automations and pinned files** into one collaborative container sharing a single RAG layer. Backend: `backend/app/workspaces/` (19 modules); real-time editing via the Node `collab/` service. **Workspaces are desktop-only by design.**

### 9.1 Structure

A `Workspace` carries a `system_prompt` (injected into every chat in it), `default_model`, a dedicated `memory_model`, `memory_mode` (`off`/`auto`/`manual`), a storage quota, and a `root_folder_id` (its Drive subtree). Items live in `workspace_items` (self-FK tree, float `position`, `visibility`, soft-delete via `trashed_at`). **Item kinds:** `note`, `canvas`, `board`, `sheet`, `container` (Notebook — the single grouping node; folders were removed), `chat`, `roster`. The tree (`GET /{wid}/tree`) also **synthesizes** chat nodes (from `Conversation` rows homed in the workspace) and automation nodes (from scheduled `Task` rows) so they're draggable without item rows. Deletion is soft (trash + 30-day lazy sweeper); archive soft-hides without trashing. Drag-and-drop is midpoint-float based (Finder-style: folder middle-band = drop-into, edge = reorder).

### 9.2 Item kinds

- **Notes** — ordinary Drive **Documents** (TipTap/Yjs), linked by `ref_id`. Inherit collaborative editing, HTML rendering, FTS, trash, quota for free. Blank notes start `indexing_status='empty'` (honest terminal state). Spellcheck (nspell/Hunspell, langs en/en-gb/en-au/es/fr/pt) + type-time autocorrect are frontend TipTap concerns; prefs are user-scoped.
- **Canvas** (`canvas_router.py`) — **Excalidraw** over Yjs, backed by `WorkspaceCanvas` + a `.md` text file. No HTML snapshot (the backend can't cheaply decode the Excalidraw schema); instead the client pushes **flattened shape text** for RAG. Theme-aware (follows the app theme with a sticky manual override), with mockup styling and Insert-item nodes. Includes a stateless server-side **background-removal** tool (rembg/U²-Net). Images ride inside the Y.Doc `files` map.
- **Boards** — kanban, **not tables**. A tree node whose cards are `WorkspaceTask` rows; `config` JSON holds the label registry, custom columns, and custom fields. Cards carry subtasks, labels, links, attachments (first image = cover), assignee, status (a column id), priority, due date. Every change logs a system activity entry; column moves fire `EVENT_CARD_MOVED`; assignments notify. RAG flattening is column-aware (`## <column>` headings).
- **Sheets** — Fortune-Sheet workbook JSON via the **backing-entity pattern** (`Spreadsheet` row), synced live over collab `sheet:<id>` rooms, with a client-flattened `content_text` mirrored to a `.md` RAG file. Styled warm-light always (not dark-aware) by design.
- **Rosters** — a shift scheduler mirroring the sheet pattern (`Roster` row, migration 0150), **owner/admin-only** to edit. Pointer-DnD drag-to-assign, multi-day, recurring shifts (all frontend); the backend stores the flattened schedule for RAG ("who's on Friday?").
- **Notebooks / chat pages / tasks / automations** — a Notebook's children render as tabs; a chat page is a real `chat` child; tasks and automations are synthesized. Duplication deep-copies notes/sheets/boards/canvases (incl. Yjs state).

### 9.3 Knowledge / RAG (`knowledge.py`, ~3,270 lines)

Every item and pinned file feeds one `knowledge_chunks` pool scoped by `(workspace_id, user_file_id)`. Each kind has an `index_*_for_workspace` background task reusing the scope-agnostic embed pipeline. **Injection decision** (`build_workspace_injection`): retrieval activates only when an embedder is configured **and** indexed text exceeds ~6,000 tokens; below that, full-dump. Crucially, the **workspace map** (a deterministic LLM-free table-of-contents) is injected in *every* mode, and authored items (notes/boards/sheets) are always injected in full (capped) so a giant pinned PDF can't crowd out a two-card board.

**Freshness correctness** (three fixes): retrieval filters **trashed** backing files; the context-disabled set unions items with "use as context" OFF, private drafts, trashed items, and pages inside a context-disabled Notebook; and deleting/unpinning **purges chunks** (trashing alone doesn't cascade). **Workspace memory** is an auto-maintained librarian doc (one hidden pinned file/workspace, gated by `memory_mode`, distilled from recent chats + documents, with a sticky manually-pinned block preserved verbatim).

### 9.4 Collaboration

- **4-tier roles** (`WorkspaceShare.role`, `String(16)` no-CHECK): **owner** (implicit) / **admin** (settings + membership) / **editor** (content only) / **viewer** (read-only). Rosters require admin even for editors. Destructive lifecycle (delete/archive/export/quota) is owner-only. `get_accessible_workspace` returns 404 (never 403) for no-access.
- **`private` visibility** (creator-only) is enforced on *every* fetch path (404), not just tree hiding, and excluded from the shared RAG pool.
- **Share lifecycle** — invite by username/email; re-inviting re-roles; invitees accept/decline from the inbox (with push). **Revoking a member unpins their files and purges the chunks.**
- **Comments** (`comments_router.py`) — flat threads on any item with an optional text-quote anchor, resolve/unresolve, and @-mention fan-out.
- **Mentions** (`mentions.py`) — `@username` resolves against workspace members only; frontend renders pills (reusing the `[[` wiki infra) → an `ItemPreviewModal`. Backlinks scan note HTML for `item=<id>` tokens (no link table).

### 9.5 Meetings

`MeetingJob` drives an upload → transcript → note pipeline on the **Arq worker** (durable): ffmpeg chunks any audio/video into 16 kHz Opus 10-min segments → sequential Whisper transcription with `[h:mm:ss]` anchors (transcript persisted before the cheap summarize step) → structured minutes (summary/key points/decisions/action items) → seeds a workspace note with a trailing `## Transcript`. **Speaker diarization was researched then shelved** (Whisper/OpenRouter can't diarize; Voxtral/pyannote-local can) — transcripts are time-anchored but non-diarized.

### 9.6 Ask, search, drive, export

- **Ask** (`ask_router.py`) — grounded Q&A over the top-8 workspace chunks with inline `[n]` citations mapping back to items (scroll-to-highlight).
- **Search** — three merged passes (item-title ILIKE, Postgres FTS with `<mark>` fragments, semantic stragglers), deduped per item. `/api/workspace-search` runs it across every accessible workspace.
- **Drive** (`drive_router.py`) — the workspace's file browser; every workspace file lives in the **owner's** Drive (`Workspaces/<title>/Files`) so a collaborator's file doesn't leave when they do; the `workspace_files` pivot is the membership/context record. Enforces both the owner's personal quota and the workspace quota.
- **Export/Import** (`export_router.py`) — owner-only zip export (notes `.md`, boards `.csv`, sheets per-tab `.csv`, canvases `.txt`, chats `.md`, raw files; private drafts + memory doc excluded); Markdown-zip import builds a fresh workspace.

### 9.7 Real-time collab (`collab/src/server.js`)

A Node **Hocuspocus** server terminates Yjs sync for three room kinds (bare UUID → Drive document, `canvas:<uuid>`, `sheet:<uuid>`), authenticated by the backend-minted HS256 collab JWT (each room validates its own claim shape; `perm=read` yields read-only). It persists the binary Y.Doc straight to Postgres; document rooms additionally debounce (3s) an HTML/FTS snapshot POST back to the backend. Presence chips ride in Yjs awareness. Only `/api/collab/:id` is proxied publicly.

---

## 10. Files / Drive

A full Drive experience (`backend/app/files/`) on **local disk** (no object store) — folders, trash, star, search, sharing — meant to "feel like a real drive."

- **Storage** (`storage.py`) — root `UPLOAD_ROOT` (default `/app/uploads`); layout `u_<user>/<file_id><ext>` (blobs named by UUID, never the user name). Streams in 64 KB chunks; `MAX_FILE_BYTES = 100 MB`; path-escape guarded.
- **Upload pipeline** (`POST /api/files/`) — `sanitize_filename` → **extension allowlist** → quota pre-check → stream → **magic-byte sniff** → quota post-check → EXIF wipe → persist → post-commit FTS extraction → fires `EVENT_FILE_ADDED`. Rejections audit-logged.
- **The allowlist** (`safety.py::_ALLOWED_EXTS`) — the single gate all uploads pass. Images (png/jpg/gif/webp/bmp), audio (mp3/wav/ogg/m4a/aac/flac/webm), documents (pdf/txt/md/csv/json), source/config (log/yaml/xml). **`.html` is deliberately excluded** (stored-XSS on a multi-user host). Browser-declared MIME is never trusted. A 40 MP decompression-bomb guard is set process-wide.
- **Text extraction** (`extraction.py`) — HTML strip / text read (256 KB cap) / pypdf. Optional **vision extraction** (`vision_extract.py`) captions images and OCRs scan-only PDFs (pypdfium2 rasterize) when a relay is configured.
- **Generated documents** — `generated_kinds.py` defines the `source_kind` provenance enum (`markdown_source`, `rendered_pdf`, `document`, `document_asset`, and the workspace backing-text kinds). `document_build.py` (Markdown → Yjs) and `document_render.py` (Yjs → **bleach-sanitized** HTML) back the collaborative Drive Documents (`documents_router.py`): 5-min collab tokens, throttled version history (capped 50/doc), download as HTML/MD/PDF, **HMAC-signed** inline-asset URLs (since `<img>`/`<audio>` can't send auth headers).
- **Sharing** — **peer grants** (`ResourceGrant`, polymorphic, folder grants cascade, `can_edit` only on documents) and **public/invite links** (`FileShareLink`, `token_urlsafe(32)`, optional bcrypt password → 10-min unlock JWT, expiry, revoke → 410; downloads forced `attachment` + `nosniff` + strict CSP). A workspace side-door grants access to files backing a shared workspace.
- **Quotas** (`quota.py`) — per-user total-bytes cap: user override → instance default → unlimited.
- **System folders** (`system_folders.py`) — protected per-user `My files/` → `Chat Uploads/` + `Generated Files/{Files,Media}/`, plus a `Workspaces/` root; find-or-create with race handling.
- **Chat-upload hygiene** — a Chat-Uploads file is "referenced" while its id appears in any live `messages.attachments`; unreferenced ones are soft-deleted on conversation-delete and by a 6-hour backstop sweeper. Re-attaching an identical name+size file reuses the row.

The frontend Files UI aims to feel like a real drive: full-width, sticky header, Kind column, folder-tree rail, and deep-linkable Recent/Starred/Shared/Trash/Search surfaces (with a separate "Promptly Files" PWA identity).

---

## 11. Custom models & RAG knowledge bases

A **Custom Model** (`backend/app/custom_models/`, admin-only, global) = a thin wrapper over a base provider/model + a system prompt (`personality`, merged at highest priority) + an attached knowledge library (RAG). It appears in the picker as a synthetic `custom:<uuid>` id resolved by `resolver.py`.

- **Data** — `CustomModel` (`base_provider_id`/`base_model_id` = the backbone, `top_k` default 6), `CustomModelFile` (M:N to `UserFile` with per-file indexing lifecycle), `KnowledgeChunk` (the shared RAG store; vector columns are **raw-SQL only**, never ORM-mapped, to avoid the pgvector codec on every connection).
- **Embedding** (`embedding.py`) — a single `AsyncOpenAI` client hits `/v1/embeddings`; OpenAI/Gemini/Ollama all flow through it. **Prod uses a cloud API embedder; dev uses bundled Ollama** — purely which `ModelProvider` sits in `app_settings.embedding_provider_id`. Only dims **768 and 1536** have physical vector columns (Matryoshka `dimensions=` truncation lets larger models fit). A per-worker **fairness gate** (`embedding_gate.py`) lets interactive query embeds jump ahead of bulk background re-indexing.
- **Ingestion** (`ingestion.py`) — on FastAPI `BackgroundTasks`: extract → content-hash short-circuit → sliding-window chunk (2000/200) → embed in batches of 16 → replace chunks → mark ready.
- **Retrieval** (`retrieval.py`) — pgvector cosine, raw SQL, `WHERE scope = :id AND f.trashed_at IS NULL`. Three entry points: `retrieve_context` (custom model, pure vector), `retrieve_workspace_context` (**hybrid** vector + FTS, RRF-fused), `retrieve_conversation_context`. Query embedding **never raises** (graceful degradation).
- **Scope invariant** — the `knowledge_chunks` CHECK constraint enforces **exactly one** of `custom_model_id` / `workspace_id` / `conversation_id` per row (history: 2 → 3 → 4 → back to **3** after study removal in migration 0158).

---

## 12. User memory

Persistent per-user facts (`backend/app/memory/`) injected into every chat system prompt.

- **Data** — `UserMemory`: `content` (3rd-person fact), `source` (`auto`/`manual`), `category` (`identity`/`preferences`/`projects`/`context`), `pinned`, `times_used`, `last_used_at`. Constants: `MAX_MEMORIES=200`, `MAX_NEW_PER_TURN=4`, `RETRIEVAL_K=10`, `SEMANTIC_DUP_THRESHOLD=0.90`, `MAX_CONTENT_CHARS=600`. Dedicated memory model (migration 0147).
- **Injection** — pinned facts first, then relevant facts via KNN cosine over the **last 3 user turns** (so a short follow-up doesn't embed to noise). **Usage-aware re-rank**: relevance dominates, usage/recency only breaks near-ties. Runs in a savepoint so a dim mismatch never aborts the chat.
- **Capture** — a cheap regex gate (English + a ~20-language multilingual gate) decides whether to run the extraction model post-reply (only in `auto` mode, not paused). `capture_memories` is **reconciliation extraction**: shows the model the 15 most-related facts *with ids*, applies a JSON op array (`add` high-confidence only / `update` / `delete`), with three-layer dedup. Uses the dedicated memory model. Emits `memory_saved` for per-fact undo.
- **Lifecycle** — evict-at-cap (least-valuable **auto** fact; pinned/manual never evicted); **Tidy-up** consolidation (`POST /consolidate`, merge-only, model can't invent/delete); a frontend-only **Stale** badge (>90 days). Owner-scoped endpoints (404-not-403), export/import.

---

## 13. Voice

Self-hosted, **half-duplex** (record → transcribe → reply → read aloud). `backend/app/voice/` + two stateless sidecars.

- **STT** — `POST /api/voice/transcribe` (multipart, ≤25 MB, clip transcribed and **discarded**, never persisted). `STT_BACKEND` selects local **faster-whisper** (`whisper/`, int8 CPU, VAD-trimmed) or OpenAI's hosted API.
- **TTS** — `POST /api/voice/tts` → WAV, via **Kokoro-82M** (`tts/`, `kokoro-onnx`, no torch). Voice mode splits a reply into **sentences and synthesizes each** (application-layer streaming, prefetching chunk n+1 for ~1s first-audio latency + barge-in points).
- **Fast voice model** — when a turn was spoken and the admin configured a voice model (`app_settings.voice_*`, migration 0157), the backend swaps it in **for that turn only** (latency is dominated by model speed). Voice turns skip tools/search entirely.
- Dictation (`useDictation`) works in every browser via `MediaRecorder`; read-aloud + voice mode via `useTextToSpeech`. (Phases 1–2 shipped; full-duplex is future work.)

---

## 14. Notifications

Web push + a durable in-app inbox (`backend/app/notifications/`).

- **Transport** — `pywebpush` authenticated by **VAPID keys stored in the DB** (`app_settings`, auto-generated on first boot, rotatable in the admin panel; the frontend fetches the public key, 503 if unset).
- **Data** — `Notification` (inbox row: category, title, body, deep-link URL, `read_at`), `PushSubscription` (unique per `(user, endpoint)` → idempotent re-subscribe), `PushPreferences` (master `enabled` + 7 per-category booleans).
- **Dispatch** (`dispatch.py`) — `notify_user` writes the inbox row first (pruned to 200/user), gates on prefs, fans out to subscriptions via `asyncio.to_thread`, and **prunes dead subscriptions** on 404/410. Dedup is via stable browser `tag`s. Triggers: shared-message, import/export ready, mention/assignment/invite, task-complete (meetings + automations), system-alert (search auto-pause).
  - **Known gap:** `system_alert` (and legacy email categories) have no `PushPreferences` column, so `_should_send` resolves them to `False` — those reach the inbox but never fire a browser push.

---

## 15. Automations (node-graph flows)

A visual flow engine (`backend/app/tasks/`) — "Automations two-tier." A single `Task` is either a **Simple** task (recurrence + prompt columns) or an **Advanced** flow (`flow_graph` JSONB); a Simple task derives into a canonical 3-node graph and runs through the identical runner.

- **Data** — `Task`, `TaskConnector` (MCP grants), `AutomationNodeMemory` (per-node cross-run state), `FlowGraphVersion` (save snapshots), `TaskRun` (immutable execution: status, trigger, `output_markdown`, `node_runs` inspector, tokens/cost/sources).
- **Node types** (25, `FLOW_GRAPH_VERSION=1`) — triggers (`schedule`/`manual`/`webhook`/`event`), processing (`ai.prompt`/`ai.summarise`/`ai.extract`/`search.web`/`fetch.page`/`http.request`/`mcp.action`/`research.deep`/`loop.foreach`/`memory.store`/`flow.merge`/`flow.delay`), control (`condition`/`router`), outputs (`report`/`board_card`/`chat_message`/`note`/`sheet`). `is_executable_graph` requires exactly one trigger, ≥1 terminal output, known types, acyclic, all reachable.
- **Triggers** — **cron** (`scheduler.py`+`recurrence.py`: `FOR UPDATE SKIP LOCKED`, advance-before-run, minutes/hourly/daily/**weekly-with-weekday-set**/monthly, task-local tz); **events** (`EVENT_FILE_ADDED`/`_CARD_MOVED`/`_ITEM_CREATED` with filters + flood guard); **webhooks** (`hooks_router.py`: unauthenticated `POST /api/hooks/{id}/{secret}`, timing-safe compare, wrong secret → 404, 64 KB cap).
- **Execution** (`graph_runner.py`) — topological traversal with **active-path branching** (control nodes gate edges), merge `all`/`any`, per-node retry (0–5, backoff, `on_error: continue`), a cooperative deadline (≤3000s). Data passes via `_interpolate` — an **eval-free whitelist regex** over `{{upstream_output}}`, `{{node_<id>.output}}`, `{{trigger.json.<path>}}`, `{{date}}`, `{{secret.NAME}}` (templates can never execute code). `dry_run`/`pinned` support run-to-here testing.
- **Credentials vault** — `{{secret.NAME}}` resolved **only** in the `http.request` node, SSRF-guarded (per-node `allow_private_network` opt-in, metadata always blocked), and every value redacted back to its token before touching `node_runs`/reports/logs.
- **Worker** — jobs run on the Arq worker (survives redeploys); the queue degrades to inline execution if Redis is down. (Rebuild the arq-worker with the backend on deploy.)
- **Flow copilot** (`copilot.py`) — constrained JSON generation (draft → validate → repair-once), plus `explain_graph` and `diagnose_run`.
- Owner-scoped, `MAX_TASKS_PER_USER=25`. `flow_service.py` keeps Simple↔Advanced coherent.

---

## 16. Feedback & saved prompts

- **Feedback** (`feedback/`) — an in-app button emails the maintainer **through the instance's own SMTP** (self-hosted instances have no central endpoint to POST to). `GET /` returns `FEEDBACK_EMAIL` (default `feedback@chatpromptly.com`) for a direct-email link; `POST /` (rate-limited 6/hour) uses the shared SMTP transport, sets Reply-To to the user (opt-in), and **never errors to the client** — on SMTP failure it returns a `mailto:` fallback address. Onboarding includes an SMTP setup step with ISPDB email autoconfig.
- **Saved prompts** (`saved_prompts/`) — deliberately minimal reusable composer templates (`title` + `body`, no variables/categories/sharing), owner-scoped (404-not-403), invoked via `/` in the composer.

---

## 17. Frontend architecture

A React 18 + TypeScript SPA (`frontend/`), Vite-built, shipped as an installable PWA. Talks to the backend over `/api` (REST + SSE) and to the collab service over WebSockets.

### 17.1 Build & PWA

- **Vite** — `@` → `./src` alias; dev server behind the proxy. A custom **`hunspellDictionaries()` plugin** inlines the Node-only `dictionary-*` packages as virtual ES modules (each language a lazy chunk). **Manual chunking** hand-splits heavy feature surfaces (excalidraw, fortunesheet, reactflow, tiptap, markdown, highlight, charts, icons, state, react) — ordering matters because fortune-sheet/xyflow paths contain the `react/` substring.
- **PWA** — `injectManifest` with a handwritten `sw.ts`: precache the hashed shell, **network-first SPA navigation** (so a redeploy never serves a stale shell referencing deleted chunks), Web Push handlers (tag-replace, focus-existing-tab), and it never intercepts `/api/**`. **globIgnores** must exclude the big lazy chunks (`excalidraw-*` ~4.5 MB, `dictionary-*` up to ~5.5 MB) or first-install bloats and the build hard-fails. Two PWA identities: main "Promptly" and a separate "Promptly Files" (`/files/` scope) swapped in at runtime.
- **Gotcha** — a committed `vite.config.js`/`tailwind.config.js` (tsc `-b` emit) can shadow the `.ts` sources and is in the Docker build context.

### 17.2 Shell & routing

`main.tsx` renders `StrictMode > ErrorBoundary > QueryClientProvider > BrowserRouter > App`. `App.tsx` gates route trees on `authStore.status` (idle/loading/needs_setup/unauthenticated/mfa_required/mfa_enrollment_required/authenticated). Authenticated routes nest under `<AppLayout>`.

**Pages** — `ChatPage`, `WorkspacesPage`, `WorkspaceDetailPage`, `TasksPage`/`TaskDetailPage` (automations), `MyWorkPage`, `FilesPage` (+ Recent/Starred/Shared/Trash/Search), `ArchivePage`, `AccountSecurityPage`, `AdminPage`, `LoginPage`/`SetupPage`, `MfaVerifyPage`/`MfaEnrollPage`, `ShareLinkLandingPage` (public, no chrome).

**Layout** — a single non-remounting element tree across the 768px breakpoint (crossing it re-styles rather than remounts, preserving chat scroll + in-flight state). Desktop static sidebar ↔ mobile slide-in drawer. Global shortcuts: **Ctrl/Cmd+K** (search palette), **Ctrl/Cmd+Shift+O** (new chat), **`/`** (focus composer). `navItems.ts` is the single nav source (Chat, Workspaces, My work, Automations, Files; `desktopOnly`/`adminOnly`/user-hideable flags).

### 17.3 State (Zustand, 17 stores)

`authStore` (user, in-memory access token, status, pending MFA), `chatStore` (active conversation + rich streaming state), `modelStore` [persist] (catalog + selected/default/admin-default/vision-relay, fallback chain), `themeStore` [persist] (default dark), `canvasThemeStore` [persist] (follows app theme with sticky override), `researchStore`, `subchatStore` (in-memory, concurrent side-chats), `uploadStore` (module-level upload queue surviving navigation), `uiStore`, `composerStore` [persist] (per-conversation draft, survives rotation remount), `editorStore`, `folderUiStore` [persist], `noteWidthStore` [persist], `autoCompactStore` [persist], `codeArtifactStore` (the Run side panel), `toastStore`.

### 17.4 API & streaming

- `client.ts` — one axios instance (`withCredentials`), request interceptor attaches the Bearer token, response interceptor does **single-flight 401 refresh** and retries once.
- `useStreamingChat` — POSTs for a `stream_id`, then `fetch`es the SSE stream and drains it via an async-generator; **batches token deltas to one flush per animation frame** (decouples render/markdown-reparse from token rate). Handles the full SSE event set (delta, done with stats, title_updated, vision warnings, memory saved/used, vision-relay, tool started/progress/finished/error, structured error cards) and **reattach** (re-joins an in-progress generation after navigating away).
- `useSubchatStream` (local-state driver for concurrent subchats), `useResearch` (feeds `researchStore`).

### 17.5 Components & theming

Component domains: **chat** (~55 files — window/bubble, composer, model selector, research dialogs, subchat modal, voice overlay, tool activity card, context management, mentions, memory), **workspaces** (~35 — multi-pane shell, per-kind panes, navigator tree, members/share, presence/comments, meeting modal, mobile gate), **files/documents** (Drive UI + the TipTap editor with custom extensions + spellcheck + Yjs collab), **admin**, **account**, **models**, **tasks**, **codeArtifacts**, **voice**, **mfa**, **usage**, **feedback**, **shared** (design-system kit — Button/Modal/Callout/ErrorState/ConfirmDialog/UserAvatar…), **system** (ErrorBoundary + `lazyWithRetry` for stale-chunk recovery). Design tokens are **CSS variables** in `index.css` (warm Claude-inspired palette, terracotta `#D97757` accent) preferred over Tailwind color classes. Realtime collab via `useCollabProvider` (+ canvas/sheet variants) over `wss://<host>/api/collab/<id>`.

---

## 18. Appendix

### 18.1 Key config surface (`backend/app/config.py`)

`SECRET_KEY` (one key: JWT signing + all Fernet at-rest + avatar HMAC + sandbox bearer), `DOMAIN`, `DEBUG`, `SINGLE_USER_MODE` (legacy dev bypass), `ALLOWED_ORIGINS`, `COOKIE_SECURE=True`/`COOKIE_SAMESITE=strict`, `TRUSTED_PROXY_IPS`, `LOCKOUT_THRESHOLD=5`/`LOCKOUT_COOLDOWN_MINUTES=15`, `ACCESS_TOKEN_TTL_MINUTES=15`/`REFRESH_TOKEN_TTL_DAYS=3`, the MFA tunables, the rate-limit DSL set, `DATABASE_URL`, `REDIS_URL`, `CODE_SANDBOX_URL`/`_SECRET`/`_TIMEOUT_S`, `STT_BACKEND`/`WHISPER_URL`, `TTS_URL`/`TTS_VOICE`, `SEARXNG_URL`/`_ENABLED`, `SSRF_ALLOWED_HOSTS=searxng`, provider key seeds, and `VAPID_*`.

### 18.2 Database tables (56)

`app_settings`, `auth_events`, `automation_node_memory`, `chat_folders`, `compare_groups`, `connector_groups`, `connector_users`, `conversation_excluded_workspace_files`, `conversations`, `custom_model_files`, `custom_models`, `document_state`, `document_versions`, `email_otp_challenges`, `error_events`, `file_folders`, `file_share_grants`, `file_share_links`, `files`, `flow_graph_versions`, `knowledge_chunks`, `mcp_connectors`, `meeting_jobs`, `message_embeddings`, `messages`, `mfa_backup_codes`, `mfa_trusted_devices`, `model_providers`, `notifications`, `push_preferences`, `push_subscriptions`, `resource_grants`, `rosters`, `saved_prompts`, `search_providers`, `spreadsheets`, `task_connectors`, `task_runs`, `tasks`, `usage_daily`, `user_group_members`, `user_groups`, `user_memories`, `user_mfa_secrets`, `user_secrets`, `users`, `workspace_canvas`, `workspace_files`, `workspace_item_comments`, `workspace_items`, `workspace_mcp_connectors`, `workspace_proposals`, `workspace_shares`, `workspace_task_comments`, `workspace_tasks`, `workspaces`.

### 18.3 Removed / dormant features

Some tables and terms in the codebase reference features that have been **removed** — don't treat them as live:

- **Study / Team-Learning** — deleted entirely 2026-07-11 (migration 0158): the whole module, 16 tables, and the frontend are gone; the `knowledge_chunks` study scope was dropped.
- **Chart & Data-view workspace items + the `data_sources` feature** — deleted 2026-07-11 (migration 0160, commit `ba05f98`). (The MCP integration-depth framework they explored remains conceptually valid for future items.)
- **Email / Calendar integration** — removed.
- **Per-conversation sharing** — removed; collaboration is workspace-level only.
- **Compare / side-by-side model mode** — decommissioned; the `compare_groups` table is kept dormant (not dropped).
- **BYOK SaaS / multi-tenancy / Clerk / orgs / paywall** — fully stripped; Promptly is plain free single-tenant multi-user self-host.
- **Workspace folders** as a grouping primitive — replaced by the single Notebook (`container`) node.

### 18.4 Recurring architectural patterns

- **Single-worker in-process coordination** — SSE reconnect and the embedding fairness gate both rely on the one-uvicorn-worker constraint.
- **Raw-SQL pgvector** everywhere (custom models, memory, message embeddings) — vector columns exist in Postgres but are never ORM-mapped; only dims 768/1536 have physical columns.
- **Graceful degradation as a rule** — retrieval, memory capture, notification dispatch, feedback SMTP, and the Arq queue all fall back rather than surfacing errors into the user-facing path.
- **404-not-403 owner scoping** across memory, saved prompts, tasks, and file/workspace shares so resource existence isn't probeable; timing-safe secret comparison on webhooks and share unlocks.
- **Everything encrypts under one `SECRET_KEY`** — rotating it invalidates every session, avatar URL, and encrypted secret simultaneously.
