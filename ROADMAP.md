# Promptly — Chat Interface Roadmap

> Forward-looking list of chat features we've decided are worth building.
> This is a planning document only — nothing here is implemented yet.
> Created 2026-05-29 from a capability audit of the existing chat stack.

## Guiding principles

These constraints apply to **every** item below — they are not optional polish:

1. **Keep the UI clean and uncluttered.** Promptly's composer and message
   surface are already dense. New affordances should hide until needed
   (hover / overflow menus / disclosures), reuse existing patterns (the
   tool/relay chips, the regenerate split-button, the `⋯` row menus), and
   never add a permanently-visible control that most users won't touch.
2. **Lean on scaffolding that already exists** before adding new surfaces —
   several gaps below are mostly "wire up the thing we already wrote."
3. **Model-agnostic.** Anything provider-specific (e.g. reasoning effort)
   must degrade gracefully when the active model doesn't support it.
4. **Mobile parity.** If a control matters, it has a touch story; if it's
   power-user-only, it can stay desktop-first (matches today's
   `ContextWindowPill` / `MessageStats` approach).

Legend: **impact** / **effort** are rough t-shirt sizes. "Scaffolding"
notes existing code we can build on.

---

## Phase 1 — Tier 1 polish (table stakes, mostly quick wins)

> **Status: shipped (2026-05-29).** All five items below are now live —
> LaTeX/math rendering, per-conversation instructions, single-message
> delete, one-click retry / pick-another-model on stream errors, and a
> desktop copy button on user messages.

These are the gaps users notice fastest. Most are small.

### 1.1 LaTeX / math rendering
- **What:** Render `$inline$` and `$$block$$` / `\[ \]` math in assistant
  replies instead of raw text.
- **Why:** Any math/science/finance answer currently looks broken.
  Highest "feels broken" gap for the smallest change.
- **How (clean UI):** Add `remark-math` + `rehype-katex` to the existing
  `react-markdown` pipeline in `MessageBubble.tsx`; load KaTeX CSS once.
  No new UI chrome at all.
- **impact: high · effort: low** · Scaffolding: existing markdown pipeline.

### 1.2 Per-conversation custom instructions / system prompt
- **What:** A per-chat "instructions" field (e.g. "answer concisely, you're
  a Rust expert") without having to create a Project.
- **Why:** System prompts only exist at the Project level today; most
  one-off steering wants to live on the chat.
- **How (clean UI):** Tuck behind a small "Instructions" affordance in the
  chat header / overflow menu — a slide-over or popover, **not** a
  permanent textarea above the composer. Persist on the conversation
  alongside `model_id` / `reasoning_effort`.
- **impact: high · effort: med** · Scaffolding: project `system_prompt`
  field + per-conversation settings hydration in `ChatPage.tsx`.

### 1.3 Delete an individual message
- **What:** Remove a single message (and, where it makes sense, the turn
  it belongs to) rather than only editing the last user turn or nuking the
  whole chat.
- **How (clean UI):** Add to the existing per-message hover/`⋯` actions and
  the touch long-press menu — no new always-on buttons. Confirm on
  destructive deletes that drop assistant context.
- **impact: med · effort: med** · Scaffolding: message action row in
  `MessageBubble.tsx`; needs a new backend delete endpoint.

### 1.4 One-click "Retry" on stream error
- **What:** When a stream fails, offer an immediate "Try again" (same
  model) and "Pick another model".
- **Why:** Reliability UX. `StreamErrorCard` already exists but
  `ChatWindow` doesn't even pass it `onPickAnotherModel`, and there's no
  plain retry.
- **How (clean UI):** Finish wiring the existing error card; reuse the
  regenerate model-override submenu for "pick another model".
- **impact: med · effort: low** · Scaffolding: `StreamErrorCard.tsx`,
  `RegenerateOverride` model menu.

### 1.5 Copy button on user messages (desktop)
- **What:** Desktop copy button on user messages, not just assistant
  replies.
- **How (clean UI):** Same hover affordance already used for assistant
  copy; touch long-press already copies any message.
- **impact: low · effort: trivial** · Scaffolding: `MessageBubble.tsx`
  `CopyButton` / `canCopy`.

---

## Phase 2 — Expected differentiators

> **Status: 2.1–2.5 shipped (2026-05-29).** Voice dictation, @-mention
> Drive files, Mermaid diagram rendering, read-aloud (TTS), and
> thumbs-up/down response feedback are now live. **2.6 (in-thread
> regeneration versioning) is intentionally deferred as its own project**
> — it needs a message-version storage model and history-aware
> send/regenerate, so it doesn't belong in this batch.

The features people expect from a "real" chat product.

### 2.1 Voice input (dictation)
- **What:** Mic button in the composer that dictates into the input.
- **Why:** Near-free — the hook `hooks/useSpeechRecognition.ts` is already
  written and simply **not wired into the composer**.
- **How (clean UI):** Single mic icon in the `InputBar` action cluster;
  show a subtle recording state; hide entirely where the Web Speech API
  is unsupported.
- **impact: med · effort: low** · Scaffolding: `useSpeechRecognition.ts`.

### 2.2 @-mention Drive files into a message
- **What:** Extend the existing `@`-mention so it can pull a Drive **file**
  (not just other chats) into context.
- **Why:** We have a full Drive *and* an @-mention system; mentioning a
  file is the natural bridge between them.
- **How (clean UI):** Reuse `MentionAutocomplete.tsx`; add a files section /
  tab to the picker. Resolve to file context server-side like the chat
  mention path (`mentions.py`).
- **impact: high · effort: med** · Scaffolding: `MentionAutocomplete.tsx`,
  `InputBar.tsx`, backend `mentions.py`, Drive file APIs.

### 2.3 Mermaid / diagram rendering
- **What:** Render ` ```mermaid ` fenced blocks as diagrams.
- **Why:** Models emit mermaid frequently; it shows as a raw code block now.
- **How (clean UI):** Render in the message body with a small "view source"
  toggle; consider routing large diagrams to the existing artifact panel
  pattern so the message stays compact.
- **impact: med · effort: low-med** · Scaffolding: `MessageBubble.tsx`
  code-fence handling, `CodeArtifactPanel.tsx` pattern.

### 2.4 Read-aloud / TTS of responses
- **What:** "Play" an assistant reply via `speechSynthesis`.
- **How (clean UI):** Lives in the per-message overflow/hover actions, not a
  persistent button. Clear play/stop state.
- **impact: med · effort: low**.

### 2.5 Response feedback (thumbs up / down) — *big rock*
- **What:** Capture per-response quality signal, optionally with a short
  reason on thumbs-down.
- **Why:** We currently capture **no** chat answer-quality signal. Needed
  for model evaluation and surfacing bad outputs. (Study mode has its own
  `ai_feedback`; chat has nothing.)
- **How (clean UI):** Tiny thumbs in the per-message actions; thumbs-down
  opens a light, optional reason popover. Store + expose to admin later.
- **impact: high · effort: med** · New backend table + endpoint.

### 2.6 In-thread regeneration versioning (`‹ 2/3 ›`) — *big rock*
- **What:** Keep alternate regenerated/edited answers as siblings with a
  version pager, instead of destroying the previous answer.
- **Why:** Today regenerate/edit **deletes** subsequent messages. The
  ChatGPT/Claude-style sibling navigation is the most-missed genuine chat
  feature.
- **How (clean UI):** A compact `‹ 2/3 ›` control inline in the message
  footer (next to regenerate); nothing new when there's only one version.
- **impact: high · effort: high** · Largest item: needs message-version
  storage model + history-aware send/regenerate. Plan as its own project.

---

## Phase 3 — Power-user & polish

> **Status: shipped (2026-05-29).** Saved prompt library + `/` slash
> commands (3.1), move-an-existing-chat-into-a-project from the sidebar
> context menu (3.2), global keyboard shortcuts — `Ctrl/Cmd+Shift+O`
> new chat, `/` focus composer, alongside the existing `Ctrl/Cmd+K`
> search (3.3), and true draft persistence across reload/PWA restart
> via a `localStorage`-backed composer store (3.4) are all live.

### 3.1 Saved prompt library + slash commands
- **What:** Reusable saved prompts/templates, invokable via `/` in the
  composer.
- **How (clean UI):** Reuse the `SearchPalette` interaction model; `/` opens
  an inline command/prompt menu. Keep the composer itself unchanged until
  `/` is typed.
- **impact: med · effort: med** · Scaffolding: `SearchPalette.tsx`,
  `MentionAutocomplete.tsx` autocomplete pattern.

### 3.2 Move an existing chat into a project
- **What:** Move a standalone chat into a Project from the sidebar.
- **Why:** `MoveToProjectMenu.tsx` already exists but **isn't mounted
  anywhere** — pure plumbing.
- **How (clean UI):** Surface inside the existing sidebar row `⋯` /
  context menu.
- **impact: med · effort: low** · Scaffolding: `MoveToProjectMenu.tsx`,
  `ConversationRowContextMenu.tsx`.

### 3.3 Global keyboard shortcuts
- **What:** New chat, focus composer, (and document existing ⌘K search /
  Enter-to-send).
- **How (clean UI):** No visual footprint; optional discoverable shortcuts
  sheet later.
- **impact: low-med · effort: low** · Scaffolding: `AppLayout.tsx` ⌘K
  handler.

### 3.4 True draft persistence (across reload / app restart)
- **What:** Today an unsent draft (text + attachments) lives in the
  in-memory `composerStore`, keyed per conversation. It survives switching
  chats and mobile rotation, but is **lost on a full page reload, tab
  close, or PWA restart**. This promotes drafts to `localStorage` so a
  half-typed message survives a reload — like Gmail keeping an unsent
  draft.
- **Why:** Cheap, invisible (no new UI), and genuinely annoying to lose a
  long draft to an accidental refresh — especially on flaky mobile / PWA.
- **How (clean UI):** Scope to **text-only** drafts (skip attachments —
  they reference uploaded files/blobs, not plain text) with a short TTL so
  stale drafts expire. No visible UI; just a persisted variant of the
  existing store.
- **impact: low · effort: low** · Scaffolding: `store/composerStore.ts`
  (promote to a `localStorage`-persisted store).

---

## Suggested sequencing

1. **Phase 1 batch** (LaTeX, per-chat instructions, retry, copy-on-user,
   delete message) — high perceived polish, low risk, lots of reused code.
2. **Phase 2 quick wins** (voice input, @-mention files, mermaid, TTS).
3. **Big rocks** as dedicated efforts: **response feedback**, then
   **regeneration versioning**.
4. **Phase 3** opportunistically.
