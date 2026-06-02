# Study Mode → S-Tier Overhaul Plan

**Status:** Design / planning
**Owner:** Tristen
**Last updated:** 2026-06-02

This document captures the full plan to take Study mode from "very good AI
tutor" to a best-in-class, genuinely-feels-like-a-class learning experience.
It records every change discussed, designs the flagship "live classroom"
experience in detail, and sequences the work into shippable phases.

---

## 1. Vision

> A student opens a unit and it feels like a great teacher just walked in:
> there's a hook, a board that fills up as the lesson unfolds, moments where
> they're put on the spot, a visible arc with a payoff, and at the end they
> walk away with something they built — and the system *knows* what they
> actually retained, not just what the model claimed.

Organizing principle for engagement (so it's intrinsic, not gimmicky):
**Self-Determination Theory** — every feature should serve *competence*
(I can feel myself getting it), *autonomy* (I'm contributing, not just
consuming), or *relatedness* (this teacher knows me).

---

## 2. Where we are today

### Genuine strengths (keep / build on)
- **Research-grade pedagogy** encoded in the unit prompt: Socratic
  scaffolding, worked-example fading, teach-back/Feynman, confidence-
  before-feedback (Dunning-Kruger detection), struggle-positive framing.
- **The completion gate** — a hard, multi-condition gate that silently
  rejects `mark_complete` and feeds unmet conditions back for self-
  correction. The two-turn closing-language protocol prevents the tutor
  lying to the student.
- **Durable, hydrated learner state** — per-objective mastery,
  misconceptions, reflections (with concept anchors), learner profile,
  all re-injected into each unit prompt.
- **Adaptivity** — calibration diagnostic, mid-session prerequisite
  insertion, staleness decay, exam-failure re-opening weak units.
- **Production hardening** — SSE survives handler crashes, self-healing
  duplicate reflections, sandboxed iframe exercises with frame auth.

### The core structural gap
Teaching quality currently equals **one LLM following a ~500-line prompt
that lists ~12 competing principles**, with only the completion gate as a
hard rail. Three consequences:

1. **Compliance drift** — soft moves (interleaving, spaced review,
   transfer prompts) get silently dropped as context grows.
2. **Teacher = grader → grade inflation** — "mastery 85" is a vibe; the
   SR scheduler and progress bars run on subjective signal.
3. **Captured data isn't looped back** — misconceptions are shown to the
   tutor but never re-tested; confidence is captured but never turned into
   calibration feedback.

And the **medium caps the feeling**: a chat transcript with an ephemeral
puzzle sidebar. Sameness (every turn = a bubble), passivity windows (you
can read along without ever being on the spot), and ephemerality (nothing
accumulates) are what keep it from feeling like a class.

---

## 3. THE FLAGSHIP: the "Live Classroom"

The flagship converts "chat tutor" into "class." It is four interlocking
pieces sitting on one new backend capability (the orchestration engine):

```
            ┌──────────────────────────────────────────────┐
            │         Orchestration engine (§3.1)          │
            │  drives lesson phases; picks phase-specific  │
            │  prompts; decides "what beat happens next"   │
            └───────────────┬──────────────────────────────┘
                            │ emits board ops + arc state + turn intent
        ┌───────────────────┼───────────────────┬────────────────────┐
        ▼                   ▼                   ▼                    ▼
  Evolving board      Lesson-arc rail     Active-participation   Co-created
  (§3.2)              (§3.3)              pacing (§3.4)          notes (§3.6)
```

### 3.1 Orchestration engine — the spine

**Problem it solves:** the monolithic prompt + compliance drift +
grade-inflation + un-enforced cadence.

**Design:** a lesson becomes an explicit **phase state machine**. The
backend owns "what phase are we in," and each phase is driven by a
**short, focused, cacheable prompt** instead of one giant checklist.

Canonical phase sequence for a unit:

| Phase | Purpose | Primary moves |
|-------|---------|---------------|
| `hook` | Create stakes / curiosity | cold-open, objective-as-promise |
| `activate` | Surface prior knowledge | calibration / recap question |
| `present` | Teach one objective | explanation + board build, ≤60s passive |
| `guided` | We-do practice | faded worked example, self-explanation |
| `independent` | You-do retrieval | exercise / free-recall, **assessor scores** |
| `interleave` | Mix in due/confusable items | discrimination quiz, trap-test |
| `teachback` | Feynman | spoken/typed explain-back |
| `transfer` | Anchor to their world | transfer prompt → concept anchors |
| `close` | Payoff + preview | prove the promise, gate check |

Implementation notes:
- A new `session.phase` column (+ `phase_history` JSONB for analytics).
- The orchestrator is a thin server-side controller in
  `app/study/orchestrator.py`. It chooses the next phase from
  deterministic rules + lightweight signals (objectives mastered,
  due items, confidence, struggle), and selects the matching
  phase-prompt template. The LLM *fills* the phase; it does not
  *manage* the sequence.
- Phase-prompt templates replace the one mega-template. Each is small
  (the static teaching philosophy stays as a **cached shared prefix** —
  see §5 prompt caching). This directly fixes compliance drift and cost.
- The completion gate stays exactly as-is; it is the `close`-phase
  guard. Existing `<unit_action>` handlers are unchanged.

This is the highest-leverage change: it makes the lesson arc *real*
(so §3.3 can render it), enforces cadence deterministically, and is the
substrate the engagement pieces hang off.

### 3.2 The evolving board — the single biggest engagement lever

**Problem it solves:** ephemerality. Today the right pane shows one
exercise then it vanishes; nothing accumulates.

**Design:** the right pane becomes a **persistent canvas that grows over
the lesson** — terms pinned as introduced, a diagram built piece by
piece, the worked example staying up while the student practices, the
concept map extending. At the end **the board is the artifact of the
class** and seeds the concept-map builder (§ backlog #17) and notes
(§3.6).

Architecture (reuses the existing sandboxed-iframe whiteboard tech —
HTML/JS/SVG/canvas, SortableJS, CSP):
- New table `study_board_blocks`: `(id, session_id, order_index, kind,
  payload_json, created_at)`. `kind ∈ {term, note, diagram_svg, worked_
  example, exercise_ref, concept_node, callout}`.
- New tutor action `board_op` (append/update/highlight/clear-section):
  ```
  <board_op>{"op":"add","kind":"term","payload":{"term":"Subnet mask",
    "def":"..."}}</board_op>
  ```
  Parsed by the existing streaming parser (`parser.py`) exactly like
  `unit_action` / `whiteboard_action`; dispatched in `apply_captures`.
- The ephemeral *exercise* stays a first-class block (`kind:exercise_ref`)
  so practice still happens on the board, but it now lives **in context**
  alongside everything built so far rather than replacing it.
- Co-construction: the tutor can add a block with an empty slot and ask
  the student to fill it ("what goes in this box?") — autonomy lever.
- Frontend: `WhiteboardPanel` becomes `LessonBoard` — a scrollable stack
  of rendered blocks with smooth enter animations (the §3.5 reveal
  beats). Each block type gets a small renderer.

### 3.3 Lesson-arc rail — "you are here"

**Problem it solves:** sameness / no sense of momentum or stakes.

**Design:** a slim rail (top or left-of-board) showing today's beats from
the orchestrator's phase plan, with live progress and the unit's
objectives rendered as **promises** ("by the end: subnet a /24 in your
head"). Each promise flips to ✓ when its objective crosses the floor —
the close phase literally *proves the promise*.

- Data already exists: `session.phase` (§3.1) + objective mastery rows.
- Pure frontend component `LessonArcRail` reading a new
  `GET /sessions/{id}/arc` (phase plan + per-objective progress) or
  folded into the existing session detail payload.
- Creates anticipation ("almost at the exit ticket") and a felt
  beginning/middle/end.

### 3.4 Active-participation pacing — you can be called on

**Problem it solves:** passivity windows.

**Design rule:** *never more than ~30–60s of content before the student
does something that affects what comes next.*

- Orchestrator emits a **turn intent** each tutor turn: `present` (model
  talks, but must end on a commit ask) vs `elicit` (student must act
  before reveal). `independent`/`interleave`/`teachback` phases are
  always `elicit`.
- **Predict-before-reveal**: reveals are *contingent* — the student
  commits a guess (type/drag/predict) before the board reveals the
  answer. Generation + retrieval effect, experienced as engagement.
- Reuse the existing "your turn" UI precedents (confidence widget,
  teach-back banner) as a deliberate spotlight beat.

### 3.5 The performance layer — hooks, reveals, the aha

**Problem it solves:** every insight has the same visual weight as "ok,
next question."

- `hook` phase = cold-open prompt persona ("here's something that
  shouldn't be possible…").
- **Staged reveals**: board blocks animate in with a beat of weight; a
  reveal isn't a scroll, it's an event. Motion design in `LessonBoard`.
- Celebrate the genuine aha (distinct from the unit-complete toast).
- Tutor persona/prompt tuning for tension→release in the phase prompts.

### 3.6 Co-created notes / the artifact you leave with

**Problem it solves:** you leave with a scroll-back, not something you made.

- Upgrade `UnitNotes` (today: passive plain-text scratchpad,
  `session.notes_md`) into a **co-authored takeaway** the board feeds
  into: "here's what we covered — add the part that clicked, in your own
  words." Generation effect + ownership + reviewable later.
- On unit close, the board + notes snapshot into the unit reflection so
  the student (and the next unit's opener) can reference it.

### 3.7 What a single lesson *plays* like (beat-by-beat)

1. **Hook** (`present`/elicit): "Two networks, same cable, can't talk to
   each other. Why?" Board pins the puzzle. Student commits a guess.
2. **Activate**: one recap question on prerequisites. Board pins what
   they already know as green nodes.
3. **Present → guided** (loop per objective): short explanation, board
   builds the diagram; faded worked example; "you do the hard step."
   Every ~minute the student acts. Assessor scores the independent rep.
4. **Interleave**: a due item from an earlier unit OR a confusable
   concept trap-test surfaces; board shows it side-by-side.
5. **Teach-back**: spotlight beat — "explain subnetting back to me like
   I'm new." (Spoken, if voice is on.)
6. **Transfer**: "where in *your* world is this?" → concept anchors.
7. **Close**: each promise flips ✓; gate runs; payoff + next-unit
   bridge; board + notes snapshot to the artifact.

---

## 4. Admin-controlled teaching model (NEW requirement)

**Rationale:** the model used in the teaching area has a direct,
outsized effect on experience quality. This should be an **admin**
decision, not a per-user one — users shouldn't be able to point Study at
a weak/cheap model and get a bad class.

**This slots into an existing pattern.** `app_settings` already stores
admin-chosen, per-feature provider/model pairs — `default_chat_*`,
`vision_relay_*`, and `research_*` — surfaced in `DefaultsTab.tsx`,
gated by `require_admin`, and read at call-time (Deep Research already
overrides the user's model this exact way).

### Backend changes
- `app/app_settings/models.py`: add
  - `study_provider_id` + `study_model_id` — the **teaching model**.
  - `study_assessor_provider_id` + `study_assessor_model_id` — optional
    cheaper model for the independent assessor pass (§ backlog #10).
  - Alembic migration for the new nullable columns.
- `app/app_settings/router.py`: extend the admin PATCH schema +
  validation (mirror the research-model block).
- `app/study/router.py` + `planner.py`: **read the teaching model from
  `app_settings.study_*`** instead of `project.model_id` /
  per-request `provider_id`/`model_id`, in all four model-selection
  sites: `create_project` (planning), `enter_unit` kickoff,
  `send_message`, `start_final_exam`. Fall back to `default_chat_*` if
  the study model is unset, so the feature never hard-breaks.
- Keep `project.model_id` column for back-compat/analytics but stop
  treating it as authoritative for teaching turns.

### Frontend changes
- `DefaultsTab.tsx`: new **"Study / Teaching model"** section (and an
  optional "Assessor model" sub-pick), styled like the existing
  Research/Vision sections.
- **Remove the model picker from `NewStudyWizard.tsx`** (and the
  per-session model override in the study composer). The student picks
  *what to learn*, never *which model teaches*.
- Show a small read-only "Taught by <model>" affordance for transparency.

### Recommended-models curation
Ship a curated **"recommended for teaching"** list in the admin UI
(resolved against the live provider catalog — exact IDs come from the
configured providers, not hard-coded). Guidance baked into the UI copy:

- **Teaching model → favor the top reasoning tier** (quality dominates
  cost here). Good candidates as configured: **Claude Opus 4.8** or
  **Sonnet 4.6**, **Gemini 2.5/3 Pro**, **GPT-5.x** class. *Note:* for
  teaching pick the **Pro/frontier tier, not the Flash/mini tier** —
  "Gemini Flash" is the cheap/fast tier and is a better fit for the
  *assessor* than the *teacher*.
- **Assessor model → a fast, cheap, reliable grader**: **Haiku 4.5**,
  **Gemini Flash**, **GPT-5-mini** class. It scores retrieval against a
  rubric; it doesn't need to be the teacher.

(We mark these as *recommended*, admin can override; the list is data,
refreshed as frontier models change.)

---

## 5. Supporting systems (enable the rest)

### Measurement substrate / knowledge tracing (backlog #9)
- New table `study_retrieval_attempts`:
  `(id, session_id, unit_id, objective_index, phase, correct, hint_count,
  latency_ms, confidence, source_kind, created_at)`.
- Derive mastery from attempt history (start simple: recency-weighted
  accuracy; optional upgrade to Bayesian Knowledge Tracing later).
- **Rewire SM-2** to schedule off measured retrieval, not the tutor's
  subjective number. `review.py` already has the scheduler; it just gets
  a real success signal.
- Powers: honest progress bars, calibration feedback (#18), the insight
  dashboard (#4), and "read the room" pacing (#3.4 / #26).

### Independent assessor pass (backlog #10)
- After each `independent`/`interleave` rep, a **separate cheap-model
  call** (the admin assessor model, §4) grades the answer against a
  rubric and writes a `study_retrieval_attempts` row + the
  `update_objective_mastery` score. Splits warm-teacher from
  honest-grader → kills grade inflation.

### Prompt caching + async planning (backlog #5)
- The static teaching philosophy + phase scaffolding become a **cached
  prefix** (large cost/latency win now that prompts are phase-sized).
  Use the Anthropic prompt-caching pattern for the shared prefix.
- Make plan generation **async** with a progress state instead of a
  5–25s synchronous block on project create.

---

## 6. Full backlog (everything discussed)

Grouped; IDs are stable references.

**Foundation**
- **#8 Orchestration engine** (§3.1) — spine of the flagship.
- **#9 Measurement substrate / knowledge tracing** (§5).
- **#10 Independent assessor pass** (§5).
- **#5 Prompt caching + async planning** (§5).

**Flagship engagement (the "Live Classroom")**
- **#21 Evolving lesson board** (§3.2) — flagship.
- **#22 Lesson-arc rail + objective-as-promise** (§3.3).
- **#23 Active-participation pacing / predict-before-reveal** (§3.4).
- **#25 Performance layer — hooks, staged reveals, the aha** (§3.5).
- **#27 Co-created notes / lesson artifact** (§3.6).
- **#24 Voice — TTS narration + optional STT teach-back** (own track,
  high ceiling; pairs with mobile).
- **#26 "Read the room" adaptive pacing/energy** (uses #9).

**Retrieval-engineering teaching moves** (mostly new exercise templates
+ small actions; cheap once the board + assessor exist)
- **#11 Free-recall / brain-dump** (highest-yield retrieval).
- **#12 Misconception trap-testing** (close the logged-misconception loop).
- **#13 Self-explanation prompts** on worked examples.
- **#14 Error-detection exercises** ("find the bug in this solution").
- **#15 True interleaving** of confusable concepts (discrimination).
- **#16 Parsons problems + predict-then-observe sims**.
- **#17 Concept-map builder** (grows from `concepts_anchored` + board).
- **#18 Calibration-over-time feedback** (confidence vs correctness).
- **#19 Varied-example transfer** (vary surface, hold deep structure).
- **#20 Per-session goal-setting / self-regulated-learning loop**.

**Product surface / reach**
- **#1 Daily spaced-repetition review loop** (standalone, habit-forming).
- **#2 Mobile support** (esp. review + voice).
- **#3 Bring-your-own-material** (PDF/slides/syllabus + RAG; likely
  reuses Projects' pinned-file hybrid retrieval).
- **#4 Learner insight dashboard** (mastery, retention, weak spots,
  misconceptions, calibration).

**Admin / correctness**
- **#A Admin-controlled teaching model + recommended models** (§4) — NEW.
- **#6 Bug:** reflections block prints raw unit UUID instead of title
  (`service.py` `_format_reflections_block`, ~line 1308).
- **#7 Cleanup:** dead `min_turns_required` path; unit mastery can only
  ratchet up post-completion; final-exam grading not per-item/auditable.

---

## 7. Phased rollout

Each phase is independently shippable and ordered by dependency.

### Phase 0 — Foundations & quick wins *(low risk)*
- #A Admin teaching-model control + recommended models (§4).
- #6 reflections-UUID bug fix; #7 cleanup.
- #5 prompt caching for the (current) static prefix + async planning.
- *Exit:* admin owns the teaching model; quick correctness wins landed.

### Phase 1 — Honest measurement *(unlocks everything downstream)*
- #9 retrieval-attempts table + derived mastery; rewire SM-2.
- #10 independent assessor pass (uses the admin assessor model).
- *Exit:* mastery is measured, not claimed; SR runs on real signal.

### Phase 2 — Orchestration engine
- #8 phase state machine + phase-sized prompts (static philosophy →
  cached prefix). Completion gate becomes the `close` guard, unchanged.
- *Exit:* lessons have a real, server-driven arc; compliance drift gone.

### Phase 3 — The Live Classroom (flagship UX)
- #21 evolving board, #22 arc rail, #23 active-participation pacing,
  #25 performance layer, #27 co-created notes.
- *Exit:* a unit *feels like a class*. This is the headline release.

### Phase 4 — Retrieval-engineering moves
- #11–#19 (free recall, trap-testing, self-explanation, error-detection,
  true interleaving, parsons/predict-observe, concept map, calibration,
  varied examples), #20 goal-setting. Each is a board block + small
  action; ship incrementally.

### Phase 5 — Habit & reach
- #1 daily review loop, #4 insight dashboard, #2 mobile.

### Phase 6 — Big bets (parallelizable)
- #3 bring-your-own-material (RAG), #24 voice.

---

## 8. Risks & mitigations
- **Scope creep / regressions in a mature module.** → Phases are
  independently shippable; the completion gate and action handlers are
  preserved throughout; orchestrator wraps rather than rewrites.
- **Latency from multi-call turns (assessor + teacher + board ops).** →
  Assessor is a cheap model and can run async/parallel; phase prompts are
  smaller; prompt caching offsets.
- **Board complexity in a sandboxed iframe.** → Reuse the existing CSP +
  frame-auth + submit-shim infra; board blocks are typed renderers, not
  arbitrary new surface.
- **Over-gamification.** → SDT framing: every engagement feature must map
  to competence/autonomy/relatedness, not points-for-points.
- **Cost of frontier teaching model.** → It's an admin choice with a
  recommended set; assessor/summary work offloaded to a cheap tier.

## 9. Open questions
- Voice (#24): build vs. provider TTS/STT; latency budget; mobile-first?
- BYO-material (#3): how much of Projects' retrieval can Study reuse
  directly vs. needs its own ingestion?
- Concept map (#17): student-built vs. tutor-built-then-edited as default?
- Do we expose the assessor's per-rep scores to the student, or keep them
  behind the mastery bar?

---

## 10. Immediate next step
Recommend starting **Phase 0** (admin teaching-model control + quick
wins) since it's low-risk, user-requested, and unblocks consistent
quality for everything after — then **Phase 1** (measurement) as the
foundation the flagship leans on. The flagship UX (Phase 3) is the
headline, but it's materially better built on honest measurement (Phase
1) and the orchestration engine (Phase 2).
