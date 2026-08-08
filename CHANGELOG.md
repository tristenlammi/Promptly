# Changelog

All notable changes to Promptly are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How this works

- Work locally against the **[Unreleased]** section — add a line under the
  relevant heading (`Added` / `Changed` / `Fixed` / `Removed`) as you go.
- When a patch is tested and ready, cut a version: run
  `scripts/release.ps1 <version>` (Windows) or `scripts/release.sh <version>`
  (Linux/macOS). That bumps `VERSION` + `frontend/package.json`, stamps today's
  date onto a new release heading, and empties `[Unreleased]` again.
- Then rebuild, do a final local test, and commit/push as that version
  (optionally `git tag v<version>`).

The in-app version tag (bottom of the sidebar) reads the injected
`frontend/package.json` version, so it always reflects the built release.

## [Unreleased]

## [0.5.2] - 2026-08-09

### Changed
- **Opening a chat no longer downloads the whiteboard and spreadsheet
  editors.** The browser was preloading ~10.6 MB of JavaScript on every
  page load; it now preloads **3.2 MB**. Excalidraw (4.6 MB),
  Fortune-Sheet (2.7 MB) and React Flow (163 kB) are genuinely fetched on
  demand, verified on a cold load with the service worker cleared.
  Cause: DOMPurify and Vite's dynamic-import helper matched no chunking
  rule, so Rollup was free to place those shared modules inside the
  excalidraw chunk — which meant the entry had to statically import 4.6 MB
  of whiteboard editor just to sanitize a message, dragging the other
  editors along behind it. Both are now pinned to their own small chunks.

## [0.5.1] - 2026-08-09

### Changed
- **Pages now load on demand instead of all at once.** Every route was
  imported eagerly, so opening a chat first downloaded the admin console,
  the automations flow editor and the whole Drive surface — a 2.4 MB
  entry chunk to render a text box. Routes are code-split now and the
  entry is **1.2 MB, roughly half**. The heaviest pages became their own
  chunks (admin 222 KB, workspace detail 343 KB) fetched on first visit.
  Login, MFA and the chat page stay eager on purpose: they're the first
  screens you see, and splitting them would only add a spinner to the
  most common path. The pending state lives in the app layout, so
  navigation shows a spinner in the content area rather than blanking the
  sidebar. Uses the existing `lazyWithRetry`, so a redeploy under an open
  tab still recovers instead of failing on a stale chunk name.

## [0.5.0] - 2026-08-08

### Added
- **A Health tab in Admin → Console** showing what the app is actually
  doing right now: database-pool usage against its ceiling, replies in
  flight, background tasks, memory, request counts by status class, and
  p50/p95/p99 response times. Promptly had no metrics of any kind, which
  meant the recent resource-starvation fixes (a pooled connection held
  for a whole generation, large uploads blocking the event loop,
  background tasks being collected mid-flight) were all made blind —
  with no way to confirm a fix held or to spot the next one before users
  did. The pool bar is the one to watch: exhausting it also blocked the
  health check, which got the container restarted mid-reply.
- `GET /api/admin/metrics` (admin-only) backs the panel. Deliberately a
  plain JSON snapshot rather than a Prometheus endpoint — the operator
  here is an admin on a settings page, not an SRE with a scraper. Numbers
  are collected in-process, cost nothing (counters plus a fixed-size
  latency ring), and are fed from the timing the access log already
  computes, so there's no second middleware and no extra clock reads.

## [0.4.2] - 2026-08-08

### Fixed
- **Background work can no longer vanish before it runs.** Nine places
  fired off a task and discarded the handle, but the event loop keeps
  only a *weak* reference to tasks — so Python was free to collect them
  mid-flight. The affected work is all the kind whose disappearance is
  silent: push notifications and inbox rows, workspace-memory refresh,
  chat re-indexing, automation event fan-out, the Redis-unavailable
  fallback for task runs, stream-session eviction, and the write that
  persists captured errors (so the admin error log could drop exactly
  the errors that happen under load). All now go through a shared helper
  that holds a reference until completion **and logs failures** —
  previously a crash in one of these surfaced only as asyncio's "Task
  exception was never retrieved" during garbage collection, attributed
  to nothing in particular.

## [0.4.1] - 2026-08-08

### Fixed
- **Large file operations no longer freeze the whole backend.** Promptly
  runs a single uvicorn worker by design, so a synchronous write in an
  async handler stalls every user at once — no chat tokens, no SSE, not
  even the health check. Uploading a meeting recording (allowed up to
  100 MB) did exactly that, as did downloading a folder as a zip, which
  deflate-compresses up to 1 GB inline. Both now run off the event loop.
  Covered by tests that race a heartbeat against the write, so the
  regression is caught rather than remembered.

## [0.4.0] - 2026-08-08

### Added
- **First-run setup now connects a model provider.** The wizard gained a
  provider step (OpenRouter / Anthropic / OpenAI / local Ollama) right
  after account creation, so a fresh install can actually answer a
  message when setup finishes — previously it configured SMTP, CORS and
  MFA but never the model, and landed on a chat screen that couldn't
  reply. Skipping is still allowed but says plainly that chat won't work.
- A provider set via `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` in the environment is now **seeded automatically on
  first boot**, and the wizard detects it and skips the provider step.
- **An in-flight reply now survives a server restart.** Generation state
  lives only in process memory, so every restart — including a routine
  `docker compose up -d` — silently destroyed replies that were still
  being written: no message row, no billing entry, and the chat left
  showing a question with no answer and no error. Shutdown now persists
  whatever text has accumulated, marked inline as interrupted. Bounded by
  an 8s timeout so a slow save can't hang the shutdown, and covered by
  the first automated tests this path has ever had.
- **Continuous integration** (`.github/workflows/ci.yml`) — the repo's
  first automated gate. Runs the backend test suite, frontend lint, and
  the full production build (which is where PWA precache failures
  surface) on every push and pull request.
- **ESLint is now real.** A `lint` script had existed for a long time
  with no config and no eslint installed, so it could never run; there
  is now a flat config (typescript-eslint + react-hooks + jsx-a11y) that
  passes clean on errors. `npm run lint:strict` also fails on the ~233
  known warnings for burning that debt down.

### Fixed
- **A chat reply no longer holds a database connection for its whole
  generation.** The streaming path kept one pooled connection checked out
  as `idle in transaction` from the first prep query until the reply was
  persisted — across every tool hop and model round-trip. With
  `pool_size=10, max_overflow=20` that capped the instance at roughly 30
  concurrent replies, and once the pool drained even `/api/health`'s
  `SELECT 1` blocked, so the container was marked unhealthy and restarted,
  killing every in-flight stream. The connection is now returned to the
  pool around each model call and re-acquired on demand.
- Tool side-effects (a generated image or PDF, a workspace write) are now
  committed as they happen instead of sitting uncommitted in the reply's
  transaction, where they were rolled back and lost if the generation
  later failed.
- **The setup wizard ended after its first step.** Creating the admin
  account flipped auth status to "authenticated", which swapped the
  router to the signed-in branch — where `/setup` redirects to `/chat`.
  Every step after account creation was therefore unreachable, so no
  install ever got the chance to configure a public URL, an embedder, or
  SMTP. Status now flips when the wizard actually finishes.
- **Two conditional-React-hook bugs**, both caught by the new lint gate:
  `ResearchProgressCard` called `useMemo` after an early `return null`,
  and `WorkspaceDetailPage` called `useState`/`useCallback` after its
  `!id` guard. Either one throws "rendered fewer hooks than expected"
  and blanks the page if the component re-renders across that boundary
  instead of unmounting.
- The zero-provider chat screen is actionable instead of misleading: it
  no longer points at a "Models tab" that no longer exists, gives admins
  a button straight to the right settings tab, and tells non-admins to
  ask an administrator — previously they clicked "Configure a model" and
  were silently bounced back to the same broken screen.
- The backend test suite runs again. It had been broken since the Study
  feature was deleted — two test files still imported the removed
  `app.study` module, so `pytest` failed at collection and every test
  silently stopped running. Also repaired a stale test that patched
  `run_search` after the search-failover work moved callers onto
  `run_search_with_failover`.

### Changed
- The setup wizard's embedding step now says what it's actually asking
  for. It never used the words "embedding model" anywhere prominent, and
  its two tiles looked almost identical to the model-provider tiles a
  couple of steps earlier (both offered "Local (Ollama)"), so it read as
  picking the same thing twice. It now names the thing, explains that it
  powers search, states plainly that it is *not* the chat model, and
  confirms what was configured. The "API provider" tile — which sets up
  nothing and defers to the admin panel — says so.
- `scripts/release.ps1` works on Windows again. Its `[Unreleased]` regex
  didn't tolerate carriage returns, so with `core.autocrlf=true` (the
  Windows default, and this is the Windows-primary script) it refused to
  cut any release at all.
- Ollama Web Search admin hint rewritten to be honest about the free
  tier: it's small (unpublished; ~a dozen searches per cycle in
  practice), so the guidance is now "last in the chain / blocked-page
  rescue", not "great primary".

## [0.3.0] - 2026-07-23

### Added
- **Ollama Web Search** as a web-search provider: Ollama's hosted search
  API (free tier with a free ollama.com account, API key auth). Joins the
  admin-ordered failover chain like any other provider — a zero-cost,
  off-instance alternative to self-hosted SearXNG.
- `fetch_url` gained a second blocked-page rescue: when the direct crawl
  is 403'd/empty and Tavily Extract can't recover it (or isn't
  configured), Ollama's hosted `web_fetch` now takes a turn. The tool
  chip shows "via Ollama" / "via Tavily" for whichever fetcher saved the
  page.

## [0.2.1] - 2026-07-23

### Fixed
- Leaked tool-call markup (e.g. DeepSeek's `<|DSML|…>` blocks) no longer
  lingers on screen: the stream's `done` event now carries the persisted
  (sanitized) reply text and the client prefers it over its raw delta
  accumulation — so backend-side cleanup and synthesis-retry answers
  actually reach the bubble. The live streaming bubble also elides the
  markup client-side while tokens are still arriving.

## [0.2.0] - 2026-07-23

### Added
- Workspace **Discussions**: a new `discussion` item kind giving members a
  threaded place to talk inside a workspace — thread rail, chronological
  messages, composer (Enter to send, Shift+Enter for a newline), and delete
  on your own threads/messages. Available from the navigator's **New** menu.
- Discussions show each author's **profile picture** next to their messages,
  in the thread rail, and on the thread header (initials chip when no
  picture is set).
- Discussions are **realtime**: new threads, messages, and deletions push to
  every open pane over SSE (Redis pub/sub fan-out) instead of the old 6s
  poll. A dropped stream reconnects with backoff and a slow safety-net
  refetch keeps the pane honest.
- Discussions are **opt-in for AI context**: they're created excluded from the
  workspace RAG pool, and the pane says so until a member turns the ⚡ on.
- Discussion RAG indexing: turning a discussion's context toggle ON flattens
  its threads into a backing Markdown file in the workspace's `Discussions/`
  Drive folder and embeds it into the workspace pool (re-indexed on every
  post); turning it OFF purges the chunks and trashes the file.
- Mobile: start a **New chat** or **New discussion** directly from the
  workspace item list on a phone.

### Changed
- Mobile workspaces: **Discussions are now usable on a phone** — the pane
  collapses to a single column (thread list → tap → messages screen with a
  back button and a keyboard-safe composer pinned to the bottom).
- Mobile workspaces no longer lock the interactive kinds: **chats and
  discussions are now fully editable** on a phone (post messages, start
  threads); notes stay read-only and the heavier editors still defer to
  desktop. Stale "read-only" copy updated to match.

### Fixed
- Chat streaming is now fully scoped to its conversation: switching chats
  mid-reply shows the chat you clicked, **browsing back to the streaming
  chat restores its thread with the live reply still ticking**, and a reply
  finishing while you're elsewhere lands in its own chat (visible instantly
  on return, no refetch wait). Sending from the New-chat screen tags its
  turn correctly so another chat's stream can never bleed into it.
- A cancelled/superseded turn can no longer wipe the next turn's live
  streaming state (thinking bubble vanishing, replies popping in all at
  once, sent messages not appearing until the reply finished).
- Dead SSE connections can't freeze chat any more: the backend now sends a
  keepalive ping every 20s while the model is quiet, and the frontend
  aborts a stream after 75s of total silence (the reply keeps generating
  server-side and appears on revisit) instead of leaving the send button
  and chat switching stuck forever.

### Removed
- The **"New from template"** entry in the workspace navigator's New menu
  (and the now-unreachable note-template picker behind it).

## [0.1.0] - 2026-07-12

### Added
- Initial versioned baseline. Establishes the `0.1.0` starting point, the
  `VERSION` file, this changelog, the `scripts/release.*` bump helper, and the
  in-app version indicator in the sidebar footer.
