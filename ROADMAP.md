# Promptly — Roadmap v2

> Forward-looking plan created 2026-05-29 after a fresh capability audit.
> v1 (Phases 1–3 of the original roadmap) is fully shipped — see the
> **Appendix: Shipped to date** at the bottom. Nothing in the numbered
> phases below is implemented yet.

## Guiding principles

These constraints apply to **every** item below — they are not optional polish:

1. **Keep the UI clean and uncluttered.** New affordances hide until
   needed (hover / overflow menus / disclosures), reuse existing patterns
   (tool/relay chips, the regenerate split-button, the `⋯` row menus, the
   `‹2/3›` pager), and never add a permanently-visible control most users
   won't touch.
2. **Lean on scaffolding that already exists.** Many items below are
   mostly "wire up / extend the thing we already wrote" (tool registry,
   ModelRouter headless calls, notifications, embeddings, artifact panel).
3. **Model-agnostic.** Anything provider-specific (reasoning effort, code
   execution, vision) must degrade gracefully when the active model can't
   do it.
4. **Mobile parity.** If a control matters, it has a touch story; power-
   user-only controls can stay desktop-first.
5. **Cost- and abuse-aware.** Anything that runs the model **without a
   human in the loop** (Tasks especially) needs admin caps, per-run token
   limits, and a kill switch from day one. Background spend must never be
   silent or unbounded.

Legend: **impact** / **effort** are rough t-shirt sizes. "Scaffolding"
notes existing code to build on.

---

## Phase 1 — Scheduled Tasks / Automations  *(the new pillar)*

> **The headline feature of v2.** A Task is a saved prompt + a schedule.
> On schedule it runs **headless** (no human watching) and produces a
> discrete, dated **Run** — a standalone report, *not* an ever-growing
> chat thread. The Tasks area reads like a newsletter/reports inbox:
> "Morning AU News", "Weekly competitor digest", "Daily standup summary".

### Why this shape (not a chat thread)
The biggest value is a **fresh artifact every period** (e.g. a daily news
compilation). Appending each day's output to one endless conversation
would bury history, blow the context window, and make old editions
unreadable. So each run is its own immutable document with its own
date, cost, and status — browsable like back-issues of a newsletter.

### Data model
- **`Task`**: `id`, `user_id`, `title`, `prompt` (the instruction),
  `model_id`, `reasoning_effort`, tool config (web search on/off,
  fetch-url, RAG over a chosen project/folder), `schedule` (structured —
  see below), `timezone` (AU-friendly default), `enabled`, `next_run_at`,
  `last_run_at`, `last_status`, delivery prefs (notify in-app / email),
  retention (keep last N runs or N days), `created_at`.
- **`TaskRun`**: `id`, `task_id`, `status`
  (`pending`/`running`/`success`/`failed`), `started_at`, `finished_at`,
  `output_markdown`, `prompt_tokens`, `completion_tokens`, `cost_usd`,
  `error`, optional `tool_invocations` (so the report can show its
  sources, reusing the existing tool-chip rendering). Each run is its own
  row → the feed of dated digests.

### Scheduling & execution engine
- **Schedule representation:** structured recurrence — `frequency`
  (`hourly`/`daily`/`weekly`/`monthly`), `time_of_day`, `weekdays[]`,
  plus an **advanced cron string** escape hatch. Friendly UI builder;
  `next_run_at` computed server-side in the task's timezone (handle
  AU DST).
- **Runner:** a background scheduler in the backend that polls
  `tasks WHERE enabled AND next_run_at <= now()` every minute, claims
  rows with `SELECT … FOR UPDATE SKIP LOCKED` (or a Redis lock — Redis is
  already in the stack) so two workers never double-fire, then executes.
- **Generation:** reuse the **headless** model path that `summariser.py`
  / `titler.py` already use (ModelRouter, collect the full output instead
  of streaming), with the chat tool loop available so a news task can
  actually `web_search` + `fetch_url`. Store the final markdown on the
  run.
- **Catch-up policy:** after downtime, run a missed task **once** — never
  backfill every missed slot. **Overlap policy:** skip a trigger if the
  previous run is still `running`.
- **Manual "Run now":** every task has a one-tap test run that produces a
  normal `TaskRun`, so users aren't waiting until tomorrow to see output.

### UI (reports inbox, not chat)
- New **Tasks** nav entry (respects the Phase 2 visibility toggle).
- **Task list:** cards — title, schedule summary ("Daily · 7:00 AEST"),
  last-run status, next run, enable/pause switch.
- **Task detail:** the latest run rendered as a clean document via the
  existing `MessageBubble` markdown pipeline (headings, links, tables,
  collapsible code all for free), with a **date/history rail** to read
  past editions. Per-run cost shown like `MessageStats`.
- **Bridges out of the feed:** "Follow up in chat" seeds a *real*
  conversation from a run (so questions don't pollute the report feed);
  "Export as PDF" reuses the `generate_pdf` tool; optional "Save to
  Drive".
- **Mobile:** native time/day pickers in the schedule builder; list +
  reader are responsive first-class.

### Delivery & guardrails
- **Completion notifications** via the existing notifications module
  (`notifications/router.py`, `dispatch.py`) — in-app bell + optional
  email (email infra already exists for OTP).
- **Admin caps (required):** max active tasks/user, minimum interval
  (e.g. ≥ hourly), max runs/day, per-run token/cost cap, global kill
  switch — surfaced in Admin → Settings alongside the web-search caps.
- **Failure handling:** one retry, then mark `failed` + notify.

### Suggested sub-sequencing
- ✅ **T.1** — model + migration + scheduler + headless run engine + "Run now".
- ✅ **T.2** — Tasks UI: list, schedule builder, run history, run viewer.
- ✅ **T.3** — completion notifications (`task_complete` push category) +
  "Follow up in chat" (seeds a real conversation from a run) +
  export (copy / download `.md` / download PDF via the chat renderer).
- ✅ **T.4** — per-run output-token cap (`_MAX_OUTPUT_TOKENS`), retention
  sweeper (prunes runs beyond `retention_runs` after each run). *Deferred:
  promoting the per-user task cap + token cap into admin `app_settings` UI
  — currently module constants; revisit only if an admin needs to tune them.*

**impact: very high · effort: high** · Scaffolding: `summariser.py` /
`titler.py` headless ModelRouter calls, `tools/registry.py`, notifications
module, `generate_pdf`, Redis, `app_settings`/admin, `MessageBubble`
renderer.

---

## Phase 2 — Per-user feature visibility (clean vs. full) — ✅ SHIPPED

- **Shipped:** "Sidebar features" panel in Account (`FeatureVisibilityPanel`)
  with show/hide toggles for the optional modules **Projects, Tasks, Study**.
  Persisted to `users.settings.hidden_nav` via `PATCH /auth/me/preferences`
  (server-validated to the optional set; unknown keys dropped). `Sidebar.tsx`
  filters `NAV_ITEMS` by `optionalKey ∈ hidden_nav`. Chat + Files are core and
  never hideable; direct URLs still resolve since nothing is disabled.

- **What:** A section in account settings where each user shows/hides the
  **optional modules** in their nav — e.g. Projects, Study, **Tasks**,
  Compare, Drive. Purely cosmetic: it removes the nav entry only; no data
  is deleted or disabled, and it can be re-enabled anytime. Direct URLs
  still resolve.
- **Why:** v2 adds a new nav item (Tasks); this lets power users run a
  full cockpit while minimalists keep chat-only. Pairs naturally with the
  "keep the UI uncluttered" principle.
- **How (clean UI):** Store `enabled_modules` on user preferences
  (JSON/bool flags, default sensible). `Sidebar.tsx` / `AppLayout.tsx`
  filter nav from prefs. A simple checkbox list under
  account settings ("Interface").
- **impact: med · effort: low** · Scaffolding: account settings pages
  (`components/account`, `AccountSecurityPage.tsx`), `Sidebar.tsx`.

---

## Phase 3 — Quick wins — ✅ SHIPPED

### 3.1 Continue generating (on truncation) — ✅ SHIPPED
- **Shipped:** A **Continue** button in the amber "cut off" banner on the
  last assistant reply when `truncated` is set. New endpoint
  `POST /chat/conversations/{id}/messages/{mid}/continue` resumes the
  reply: the stream generator splices the partial text into the prompt as
  an in-memory scaffold turn (never persisted) and **appends** the
  continuation onto the *same* message row (content, tokens, cost, and
  latency all accumulate). Frontend `continueGenerate` seeds the streaming
  buffer with the existing text so the bubble grows in place and reads as
  one continuous answer; `truncated` re-fires if the continuation also hits
  the cap, so it can be continued again.
- **What:** A one-click **Continue** when a reply was cut off (re-prompt
  with the partial as context and append).
- **impact: med · effort: low** · Scaffolding: `truncated` flag, regenerate path.

### 3.2 Enhance prompt — ✅ SHIPPED
- **Shipped:** A **Enhance** wand in the `InputBar` action cluster (icon-only
  on mobile). Calls a stateless, quota-checked `POST /chat/enhance-prompt`
  that runs a headless `model_router.stream_chat` rewrite (system prompt
  preserves intent, no answering) using the user's selected model. The
  result lands in an inline **Enhanced prompt** preview with **Use this** /
  **Keep mine** so the draft is never silently overwritten. No-op rewrites
  (identical/empty) reset quietly.
- **What:** A small wand in the composer that rewrites a rough prompt into
  a sharper one before sending (preview + accept/discard).
- **impact: low-med · effort: low** · Scaffolding: `InputBar.tsx`,
  headless model call.

---

## Phase 4 — Code interpreter / data analysis  *(big rock)* — ✅ SHIPPED

- **What:** Actually **run** model-written code in a sandbox and return
  stdout, errors, dataframes, and **plots/charts as images** — turning
  Promptly from "chat" into an analysis tool. Unlocks real CSV/Excel
  analysis on uploaded files.
- **Shipped:**
  - A dedicated, locked-down **`sandbox`** service (new container) running
    a tiny FastAPI `/execute` worker with pandas / numpy / matplotlib /
    openpyxl preinstalled. Pinned to an **internal-only** docker network
    (`sandbox-net`, `internal: true`) so executed code has **no internet
    and no access to Postgres/Redis/Ollama**; read-only rootfs with a
    per-job tmpfs scratch, `cap_drop: ALL`, `no-new-privileges`, PID + mem
    caps, runs as non-root. Per-job CPU / address-space / file-size /
    fd / nproc `setrlimit` caps + a wall-clock timeout (verified: an
    infinite loop is killed, a raised exception surfaces its traceback).
  - A new **`code_interpreter`** tool (category **`code`**, gated by the
    existing Tools toggle). The model writes Python; we ship it to the
    sandbox, feed back stdout/stderr, and route every produced file
    (matplotlib charts, exported CSVs, …) through `persist_generated_file`
    so charts render inline as attachment chips like image generation.
  - **Auto data inputs:** every data-ish file the user attaches this turn
    (CSV/Excel/JSON/Parquet/text) — plus any explicit `input_file_ids`
    for `@`-mentioned Drive files — is materialised into the working dir
    under its original filename, so `pd.read_csv('data.csv')` just works.
  - **4.1** CSV files already get a rich table preview (the `code_artifact`
    preview kind); the interpreter operates on them and on Excel directly.
  - UI: `ToolStatusBlock` renders a "Ran code" chip with chart/file-count
    badges + an `error` badge when a script exits non-zero.
- **impact: very high · effort: high** · Scaffolding: tool registry,
  attachment/image rendering, artifact panel, Drive file APIs.

---

## Phase 5 — Live / iterative artifacts — ✅ SHIPPED

- **What:** Upgrade the artifact **viewer** into a **live, iteratively-
  editable** artifact: sandboxed iframe preview, and "make the button
  blue" patches the *same* artifact in place instead of re-emitting the
  whole block (Claude Artifacts-style).
- **Shipped:**
  - **In-place AI editing** — a "Describe a change…" bar in
    `CodeArtifactPanel.tsx`. The user types e.g. "make the button blue";
    we send the current artifact source + instruction to a stateless,
    quota-checked `POST /chat/edit-artifact` endpoint (headless model
    call, mirrors `enhance-prompt`) that returns the **full updated
    source**, which swaps into the panel draft in place. The live preview
    re-renders — no new chat message, no re-emitted code block. **Reset**
    reverts to the original.
  - **Live sandboxed iframe preview** already existed and is reused:
    `allow-scripts` (no `allow-same-origin`) blob-URL iframe for HTML/SVG,
    plus Markdown/JSON/CSV preview panes, all debounced so edits (manual
    or AI) re-render without thrashing.
- **Deferred:** a dedicated **React/JSX** live preview. It needs a
  bundled JSX transformer + inlined React to stay offline-safe (the app
  is self-hosted and can't depend on a CDN inside the sandboxed iframe);
  HTML/SVG previews already cover the common "show me a UI" case.
- **impact: high · effort: med-high** · Scaffolding: `CodeArtifactPanel.tsx`,
  collapsible code block plumbing in `MessageBubble.tsx`.

---

## Phase 6 — Cross-chat memory / personalization — ✅ SHIPPED

- **What:** An auto-memory that remembers durable facts about the user
  across all chats ("I'm a Rust dev", "answer concisely"), with a
  user-managed memory list (view / edit / delete) and a clear "saved to
  memory" affordance when something is captured.
- **Shipped:**
  - A dedicated **`user_memories`** table (migration `0057_user_memory`)
    holding durable per-user facts with provenance (`manual` vs
    `auto`-captured + originating conversation). Owner-scoped CRUD at
    **`/api/memory`** (list / add / edit / delete / clear-all), capped at
    200 facts with duplicate detection.
  - **Injection:** `build_memory_system_prompt` renders saved facts into
    a system-prompt block (same "background knowledge — don't recite it"
    framing as the personal-context block), prepended in
    `_stream_generator`. Zero token overhead for users with no memories.
  - **Capture:** a cheap regex pre-filter (`should_attempt_capture`)
    means ordinary Q&A turns cost nothing; when the user states something
    durable or says "remember…", a bounded headless extraction pass
    (`capture_memories`, mirrors `enhance.py`) pulls JSON facts, dedupes
    against existing memory, and persists up to 4 new ones per turn.
  - **Affordance:** a `memory_saved` SSE event drives a transient
    "Saved to memory · N facts" chip in the chat window listing exactly
    what was captured.
  - **Management UI:** a **Memory** panel in account settings — master
    on/off switch (`users.settings.memory_enabled`, default on), inline
    add / edit / delete, auto-captured badges, and a "forget everything"
    button.
- **impact: high · effort: med** · Scaffolding: per-chat instructions +
  project system-prompt hydration, account settings.

---

## Phase 7 — Semantic conversation search — ✅ SHIPPED

- **What:** Find chats by meaning, not just keywords ("that chat where we
  fixed the nginx timeout"). The `SearchPalette` already does FTS; this
  adds embedding-based recall.
- **Shipped:**
  - A **`message_embeddings`** pgvector table (migration
    `0058_msg_embeddings`) mirroring the `knowledge_chunks` storage
    pattern (dual `vector(768)`/`vector(1536)` columns + HNSW cosine
    indexes), reusing the workspace embedding config + `embed_texts`
    plumbing that powers RAG.
  - A **background indexer** (`semantic_index.py`, started in the app
    lifespan) that continuously embeds any message lacking an up-to-date
    vector — transparently handling both backfill of existing history and
    new messages, with **no hooks in the hot chat path**. Re-embeds on
    content edit (`content_hash`) or when the admin switches embedding
    model/dim. Small batches + adaptive sleep so it never saturates the
    provider; no-op when embeddings aren't configured.
  - **Hybrid search:** `GET /chat/conversations/search` now blends the
    existing FTS results with semantic (cosine) recall using **reciprocal
    rank fusion** (k=60). Keyword hits keep their highlighted
    `ts_headline` snippet; semantic-only hits get a synthesized excerpt
    and a "meaning" badge in the palette. A min-similarity floor keeps
    unrelated vectors out. Degrades cleanly to pure keyword search when
    embeddings are off or the embed call fails.
- **impact: med · effort: med** · Scaffolding: `SearchPalette.tsx`,
  `custom_models` embeddings, `search/` module.

---

## Phase 8 — End-user usage & cost dashboard

- **What:** A personal page showing spend, token usage, and activity over
  time (by model / day / conversation). Admin sees the fleet; users
  currently can't see their own.
- **How (clean UI):** New panel in account settings; aggregate the
  per-message cost we already record.
- **impact: med · effort: med** · Scaffolding: `billing/usage.py`,
  `MessageStats`, per-message cost fields.

---

## Phase 9 — Chat folders

- **What:** Lightweight folders for **loose** chats (separate from
  Projects), with drag-drop organisation in the sidebar.
- **How (clean UI):** Extend the sidebar grouping + the existing
  move/context-menu plumbing (`ConversationRowContextMenu.tsx`,
  `MoveToProjectMenu.tsx`).
- **impact: low-med · effort: med** · Scaffolding: sidebar, conversation
  context menu.

---

## Phase 10 — Real-time voice conversation mode

- **What:** Full-duplex voice mode (speak ↔ hear, with barge-in), beyond
  today's separate dictation (in) + TTS (out).
- **How (clean UI):** A dedicated voice session surface; reuse
  `useSpeechRecognition` for input and the TTS path for output, with a
  streaming turn loop.
- **impact: med · effort: high** · Scaffolding: `useSpeechRecognition.ts`,
  TTS in `MessageBubble.tsx`, streaming chat. *(Heaviest; intentionally
  last.)*

---

## Suggested sequencing

1. **Tasks (Phase 1)** — the new pillar; build the engine + reports inbox.
2. **Feature visibility (Phase 2)** — ships right after Tasks so the new
   nav item is curatable.
3. **Quick wins (Phase 3)** — Continue generating + Enhance prompt.
4. **Code interpreter (Phase 4)** — biggest capability jump after Tasks.
5. **Artifacts (5) → Memory (6) → Semantic search (7)** as dedicated efforts.
6. **Usage dashboard (8) → Folders (9)** opportunistically.
7. **Voice mode (10)** when there's appetite for the heaviest item.

> **Explicitly out of scope for v2** (decided 2026-05-29): MCP /
> connectors, read-only public share links, conversation tree view,
> i18n / localization (Promptly is AU-only for now).

---

## Appendix: Shipped to date (v1)

The original roadmap is fully delivered (2026-05-29):

- **Phase 1 — Tier-1 polish:** LaTeX/math rendering, per-conversation
  instructions, single-message delete, one-click retry / pick-another-
  model on stream errors, desktop copy on user messages.
- **Phase 2 — Differentiators:** voice dictation, @-mention Drive files,
  Mermaid diagram rendering, read-aloud (TTS), thumbs-up/down feedback,
  and **in-thread regeneration versioning** (`‹2/3›` via a message tree:
  `Message.parent_id` + `Conversation.active_leaf_message_id`;
  regenerate/edit keep old answers as siblings).
- **Phase 3 — Power-user & polish:** saved-prompt library + `/` slash
  commands, move-a-chat-into-a-project from the sidebar, global keyboard
  shortcuts (`Ctrl/Cmd+Shift+O` new chat, `/` focus composer, `Ctrl/Cmd+K`
  search), and true draft persistence (localStorage-backed composer).
- **Post-v1:** code blocks collapsed-by-default with expand + open-in-
  viewer.

Already present before v2 (so **not** re-listed as gaps): image
generation, PDF generation, web search + URL fetch, RAG over uploaded
docs, compare mode, study mode, projects, Drive (grid/list, user-to-user
sharing), conversation export, reasoning-effort control, vision relay,
MFA.
