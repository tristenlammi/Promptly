# Promptly — Memory Overhaul Roadmap (S-tier)

> Created 2026-05-31. Turns the Phase-6 memory MVP (a flat, always-injected
> list of fact strings) into a **retrieved, self-maintaining, transparent**
> memory system. Check items off as they land.

## North star

Memory should feel like the assistant genuinely *knows* the user: it surfaces
the **right** facts at the right time (not the whole dossier every turn), it
**evolves** (updates/merges instead of endlessly accumulating), and the user
**trusts** it (sees what was captured, can undo/correct inline, knows where a
fact came from). Degrade gracefully when embeddings aren't configured, stay
cheap on a small self-hosted box, and never break a chat turn.

Each phase ends with `tsc --noEmit` + `npm run build` + a backend compile +
Docker rebuild + a phone-width visual check. Backend phases that change the
schema ship an Alembic migration (run on container boot).

---

## Current state (the baseline we're improving)

- `user_memories`: `id, user_id, content, source(manual|auto),
  source_conversation_id, created_at, updated_at`. No embeddings, no category,
  no importance, no usage stats. Cap 200/user. (`app/memory/models.py`)
- **Injection**: `ORDER BY created_at DESC LIMIT 200` → *all* facts rendered
  into *every* chat's system prompt (~4k tokens worst case).
  (`build_memory_system_prompt`, `app/chat/router.py:3585`)
- **Capture**: regex prefilter → one headless extraction call → JSON facts →
  substring dedup → insert. No merge/update, no contradiction handling.
  (`capture_memories`, `app/memory/service.py`)
- **UI**: flat list, filter, 3-way mode, "saved to memory" chip (no inline
  undo). `source_conversation_id` stored but never shown.

**Reuses that already exist:** `embed_texts` / pgvector / HNSW cosine pattern
(`message_embeddings`, semantic search), the headless `model_router.stream_chat`
path, the `memory_saved` SSE + chip, `confirm()` / `toast` / `Skeleton`
primitives, account section nav.

> ⚠️ **Dependency note:** Tiers 1 & 3 lean on the **embedding backend** — the
> same path behind the CPU-Ollama load spike. Confirm the embedding story
> (offload to an API, GPU, or accept one-time CPU cost) before Phase 1. If
> embeddings stay unconfigured, every embedding-dependent feature must fall
> back to today's recency behaviour (no regressions).

---

## Phase 1 — Retrieval + self-maintaining capture *(the biggest jump)*

The headline change: stop dumping all facts; retrieve the relevant ones, and
let capture **update** memory instead of only appending.

- [ ] **1.1 Embed memories.** Migration: add `embedding_768`/`embedding_1536`
      (vector) + `content_hash` + `embed_dim` to `user_memories`, HNSW cosine
      indexes — mirror `message_embeddings`. A tiny background indexer (or
      inline-on-write, since volume is low) embeds new/changed facts. No-op when
      embeddings aren't configured.
- [ ] **1.2 Retrieved injection.** At chat time, embed the user's turn and
      inject **top-K by cosine** (K≈8–12) instead of all 200. Always-include a
      small set of **pinned/core** facts (Phase 2.1) regardless of score.
      Fallback to recency when embeddings are off. Big token savings + relevance.
- [ ] **1.3 Merge-on-capture.** Extraction pass also receives the *existing
      related* facts (semantic lookup on the turn) and returns structured ops —
      `add` / `update(id)` / `delete(id)` — so "I moved to Rust" updates the
      Python fact instead of stacking a contradiction. New prompt + a small
      op-applier; bounded per turn; best-effort, never breaks the turn.
- [ ] **1.4 Semantic dedup.** On add/update, reject/merge a candidate whose
      cosine similarity to an existing fact exceeds a threshold (replaces the
      brittle substring check).

**impact: very high · effort: high** · Scaffolding: `embed_texts`, pgvector,
`semantic_index.py` pattern, `capture_memories`, `build_memory_system_prompt`.

## Phase 2 — Structure + trust *(make it legible and correctable)*

- [ ] **2.1 Categories + pinned/core facts.** Add `category`
      (identity | preferences | projects | context) + `pinned` bool. Grouped UI;
      pinned facts always inject. Extraction tags category.
- [ ] **2.2 Inline undo + correct on the capture chip.** "Saved 2 facts · Undo"
      that actually deletes the just-added rows; quick-edit a captured fact in
      place. Turns capture into a trusted loop. (chip → `MemorySavedChip`,
      `memory_saved` SSE already carries the facts; add their ids.)
- [ ] **2.3 Provenance UI.** Show the source conversation on each auto fact +
      deep-link to it; show "added / last used" timestamps.
- [ ] **2.4 Management UX.** Group by category, bulk select/delete, sort
      (recent / most-used / category). Builds on the Files selection patterns.

**impact: high · effort: med** · Scaffolding: MemoryPanel, MemorySavedChip,
`source_conversation_id` (already stored), DriveSelection patterns.

## Phase 3 — Relevance, transparency & power

- [ ] **3.1 Usage + importance signals.** Track `times_used` / `last_used_at`
      (incremented when a fact is retrieved into a turn); use them to break ties
      in retrieval and to choose what to drop at the cap. Optional gentle decay.
- [ ] **3.2 In-chat transparency.** A subtle "used N memories" affordance on an
      assistant turn that lists which facts were in scope (expand on hover/tap).
      Reuses the tool-chip rendering pattern.
- [ ] **3.3 "Remember this" inline action.** A message action that sends the
      selected text/message straight to memory (manual source) — capture without
      waiting for the regex gate.
- [ ] **3.4 Broader capture gate.** Replace the first-person-only regex with a
      cheaper/looser trigger (or a tiny classifier) so durable facts stated in
      other phrasings ("we standardised on Postgres") aren't missed — guarded by
      the same cost controls.
- [ ] **3.5 Export / import.** JSON download + restore, so memory is portable
      and backup-able.

**impact: med · effort: med** · Scaffolding: MessageBubble action row +
tool-chip rendering, SSE plumbing.

## Phase 4 — Optional / stretch

- [ ] **4.1 Per-project memory scoping** — opt a project into its own memory
      namespace (work vs personal). Bigger model + UX change; only if demand.
- [ ] **4.2 Admin guardrails** — per-user memory caps + a global kill switch in
      Admin → Settings, alongside the other caps.

---

## Sequencing & rationale

1. **Phase 1 first** — retrieval + merge-on-capture is where the "S-tier" feel
   actually comes from (relevance + evolution), and it's the riskiest/biggest,
   so land + verify it before building UX on top. **1.1 → 1.2** delivers value
   even before 1.3/1.4.
2. **Phase 2** makes it legible and trustworthy — the cheapest big perceived-
   quality win after retrieval.
3. **Phase 3** is delight + power; **Phase 4** only on demand.
4. Every embedding-dependent feature **falls back to recency** when embeddings
   aren't configured — no hard dependency, no regressions.

## Guardrails (apply to every phase)

- Capture/retrieval **never break a chat turn** (best-effort, caught + logged).
- No silent cost blowups — retrieval/embed calls are bounded; ordinary turns
  stay cheap.
- Privacy unchanged: owner-scoped, sensitive-data exclusion in the prompt,
  user can always see/edit/delete/undo.
