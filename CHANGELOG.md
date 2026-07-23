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
