# Study Mode — Phase 7: Polish & Correctness

**Status:** Complete (P0 + P1 + P2)
**Owner:** Tristen
**Created:** 2026-06-02
**Depends on:** Phases 0–6 complete (see `study-s-tier-overhaul.md`)

This document captures the post-implementation audit findings and the Phase 7
work plan. All items were identified by a full read of the implemented code
after Phase 6 shipped. Items are sequenced by impact.

---

## Audit findings summary

Five structural gaps were identified. Three are high-impact (they meaningfully
limit the experience); two are medium. A polish tier follows.

---

## P0 — Must fix before calling this "done"

### P0-A: Verify LessonBoard is actually mounted in unit sessions

**Finding:** Two right-pane components coexist —
`components/study/Whiteboard/WhiteboardPanel.tsx` (legacy: exercise + notes +
history, no board blocks) and `components/study/LessonBoard/index.tsx` (full
block rendering, typed renderers, animations, concept map, real-time SSE
updates). If the session page still mounts `WhiteboardPanel`, the entire
evolving-board feature never reaches students.

**Fix:** Confirm which component `StudySessionPage` mounts. If it's
`WhiteboardPanel`, replace the import with `LessonBoard`. Delete
`WhiteboardPanel` once confirmed unused — having two implementations is a
maintenance hazard.

**Effort:** 30 min verification + swap if needed.

---

### P0-B: Slim the unit system prompt — phase prompts must be primary

**Finding:** `_UNIT_SYSTEM_PROMPT_TEMPLATE` in `service.py` is ~584 lines
containing all 12 generic teaching principles, a full teaching-flow checklist,
tool selection guide, and 1,236 lines of whiteboard instructions. The
`{phase_block}` is prepended at the top, but the model receives the entire
template on every turn regardless of phase.

Consequences:
- Phase instructions are diluted. "Interleave every 3 reps" (a principle in
  the template body) appears even during `hook` phase. "Ask for teach-back"
  appears even during `present` phase. Compliance drift is still possible.
- Token cost is high every turn. Prompt caching only helps if the static body
  is actually static — but mastery, reflections, misconceptions, and phase
  block all vary, so the cacheable region is small.
- The original Phase 2 design said phase prompts *replace* the mega-template.
  What shipped is phase hint + mega-template.

**Fix:**
1. Audit the 12 principles in the template. Anything that only applies to a
   specific phase (e.g. "worked-example fading" → `guided` only; "teach-back"
   → `teachback` only; "confidence before feedback" → `independent` only)
   moves entirely to that phase's block in `phase_prompts.py`.
2. The static template body becomes the invariant foundation:
   - Tutor role and student context (always needed)
   - The action reference (always needed — tutor needs to know what actions it
     can emit)
   - A short universal teaching philosophy (3–5 principles true in *every*
     phase: struggle-positive framing, personalise via analogy, diagnose wrong
     answers)
3. Keep whiteboard instructions as a separate cached block — they're long and
   static; isolating them makes them cacheably prefix-friendly.
4. The target: static template body ~150 lines, dynamic hydration (mastery,
   reflections, misconceptions) separate, phase block carries the per-turn
   instruction.

**Effort:** Medium. Requires careful editing of `service.py` and `phase_prompts.py`
in tandem. Each phase block will grow to ~100–150 words (from current ~50)
absorbing the principle that belongs to it. Test: run a unit session through all
phases and verify the model behaves correctly in each.

---

### P0-C: Add a comprehension gate to `present → guided` transition

**Finding:** `present → guided` advances after 2 student turns regardless of
whether the student understood the explanation. `guided → independent` advances
after 2 more turns regardless of whether the worked example landed. Only the
`independent` phase checks objective mastery, and only `teachback` checks a
pass flag. Struggling students are pushed through phases at a fixed cadence.

**Fix:**

Backend (`orchestrator.py`):
```python
# present → guided: wait for comprehension confirmation OR turn-count ceiling
if current_phase == "present":
    if comprehension_confirmed:
        return "guided"
    if turns_in_phase >= 4:          # ceiling: never stay in present forever
        return "guided"
    return "present"
```

Add `comprehension_confirmed: bool` parameter to `_next_phase()` and
`advance_phase()`. Set from a new lightweight `unit_action`:
```xml
<unit_action>{"type": "comprehension_confirmed"}</unit_action>
```

Backend (`models.py` / `StudySession`): add `comprehension_confirmed_at:
Mapped[datetime | None]` column. Alembic migration.

Backend (`router.py`): handle `comprehension_confirmed` action in
`apply_captures()` — stamp the session field, pass the flag into
`advance_phase()`.

`phase_prompts.py` — `present` block: instruct the tutor to emit
`comprehension_confirmed` once the student has answered a check question
correctly, OR after giving an adequate self-explanation. Not optional — the
tutor must close the present phase explicitly.

**Effort:** Medium. Schema change + new action handler + orchestrator update +
phase prompt edit. All self-contained.

---

## P1 — High value, moderate effort

### P1-A: Wire the session-goal UI (#20)

**Finding:** `StudySession.session_goal` exists, is passed to
`build_unit_system_prompt()`, and is referenced in the `close` phase prompt
("check whether the session goal was met"). But there is no UI for the student
to set a goal at session start. The field is always `null`.

**Fix:** Add a one-field prompt modal (or inline chip) that appears when a
student enters a unit — "What do you want to accomplish in this session?
(optional)". On submit, PATCH `/sessions/{id}` with `session_goal`. The
backend already handles this.

Frontend: small modal or inline text field on the session page, shown before
the first message is sent. Dismiss without entering = null (no change).

**Effort:** Small. Frontend-only. The backend is already wired.

---

### P1-B: Fix `LessonArcRail` to show per-objective loops

**Finding:** The arc rail always renders all 9 phases in a fixed order once.
Units loop through `present → guided → independent` once per learning
objective, but the rail shows those phases as single chips. A student entering
their 3rd objective sees "Present" highlighted again with no context for why.

**Fix:** Have `GET /sessions/{id}/arc` return the expected loop count (total
objectives) alongside the current phase. The rail then renders:

```
Hook → Activate → [Present → Guided → Practice] × 3 → Review → Teach-back → Transfer → Close
                              ↑ currently here (obj 2/3)
```

The `[...]× N` group makes the repeating structure legible. Current phase
highlights the correct chip within the group for the current objective.

Backend (`router.py` `get_session_arc`): add `total_objectives` and
`current_objective_index` (derived from mastery rows: first objective with
score < mastery floor) to `SessionArcResponse`.

Frontend (`LessonArcRail.tsx`): render the teach block as a group with a `×N`
label; highlight the inner phase that matches `arc.phase` for the current
objective.

**Effort:** Small-medium. Mainly frontend rendering logic.

---

### P1-C: Assessor health in the insight dashboard

**Finding:** When no assessor model is configured, or when assessor calls fail,
mastery stays permanently as the tutor's subjective score. There's no indicator
in the UI. Grade inflation can persist silently for an entire project.

**Fix:**

Backend: add `GET /study/assessor-status` (admin-only) returning:
```json
{ "configured": true, "last_failure_at": null, "failure_count_24h": 0 }
```
`StudyRetrievalAttempt.source_kind` is already `'tutor'|'assessor'`. Query
recent attempts to determine assessor coverage rate.

Frontend (`InsightDashboard.tsx`): small status chip at the bottom of the
dashboard — "Assessor: active" (green) / "Assessor: not configured" (amber) /
"Assessor: failing" (red with timestamp). Only visible to admins.

**Effort:** Small.

---

### P1-D: Verify co-created notes are board-fed, not just a textarea

**Finding:** `StudyUnitReflection` has `board_snapshot` and `notes_snapshot`.
The `close` phase prompt instructs the tutor to help the student "co-author a
3–5 bullet takeaway." But it's unclear if the LessonBoard Notes tab actively
seeds from board blocks or is a plain scratchpad.

**Fix:** Verify in `LessonBoard/index.tsx`. If the Notes tab is a plain
`<textarea>`, add a "Seed from board" action that flattens the current board
blocks into a bullet list in the notes field. On unit close, snapshot both
board state and notes into `StudyUnitReflection.board_snapshot` /
`notes_snapshot` via the `mark_complete` flow.

**Effort:** Small-medium depending on current Notes tab state.

---

## P2 — Polish

### P2-A: `AhaMoment` visual weight

**Finding:** `AhaMoment` is a slim accent-coloured strip with "You got it."
and a sparkles icon. Functional but minimal — the design doc called for a
"distinct" celebration. Used sparingly so it should punch.

**Fix:** Consider a brief full-width flash animation (1–2s fade in/out overlay)
rather than a persistent strip. Or extend the strip to include the specific
thing they got right ("You got it — binary → decimal conversion on the first
try.") pulled from the tutor's preceding message.

---

### P2-B: Teachback gate objectivity

**Finding:** `teachback → transfer` fires when the LLM emits a
`teachback_passed` action. The independent assessor doesn't cover teachback
quality — it only covers objective retrieval. A generous tutor model can let
weak explanations through.

**Fix (optional):** Have the assessor model also score teach-back responses.
After `teachback` phase messages, run a separate assessor call that scores
the student's explanation against the unit's learning objectives. Emit
`teachback_passed` only when the assessor score meets a threshold.
This requires routing the assessor through a different rubric prompt.

---

### P2-C: Surface phase history in insights

**Finding:** `StudySession.phase_history` (JSONB) records every phase
transition with timestamps. This data exists but is never surfaced.

**Fix:** Add a "Session timeline" expandable section in `InsightDashboard`
showing completed sessions with their phase progressions — which phases were
reached, how long was spent in each, where teach-back was blocked. Useful for
identifying systematic pacing issues.

---

## Sequencing

| Item | Impact | Effort | Order |
|------|--------|--------|-------|
| P0-A: LessonBoard vs WhiteboardPanel | High (feature on/off) | XS | 1 |
| P0-B: Slim mega-template | High (compliance drift, cost) | M | 2 |
| P0-C: Comprehension gate | High (pacing correctness) | M | 3 |
| P1-A: Session goal UI | Medium | XS | 4 |
| P1-B: Arc rail per-objective loops | Medium | S | 5 |
| P1-C: Assessor health dashboard | Medium | S | 6 |
| P1-D: Co-created notes verification | Medium | S–M | 7 |
| P2-A: AhaMoment weight | Polish | XS | 8 |
| P2-B: Teachback gate objectivity | Polish | M | 9 |
| P2-C: Phase history in insights | Polish | S | 10 |

P0 items should all ship together as a single backend + frontend pass.
P1 items can ship incrementally in any order.
P2 items are backlog — do them when the P0/P1 list is clear.
