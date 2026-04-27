"""Study service — system-prompt builders, action handlers, stream plumbing."""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, TypedDict

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models_config.provider import ChatMessage
from app.redis_client import redis
from app.study import config as study_config
from app.study import review as study_review
from app.study.models import (
    StudyExam,
    StudyMessage,
    StudyMisconception,
    StudyObjectiveMastery,
    StudyProject,
    StudySession,
    StudyUnit,
    StudyUnitReflection,
    WhiteboardExercise,
)
from app.study.parser import Capture

STREAM_CONTEXT_TTL_SECONDS = 60


def _key(stream_id: uuid.UUID | str) -> str:
    return f"promptly:study-stream:{stream_id}"


class StudyStreamContext(TypedDict):
    session_id: str
    project_id: str
    user_message_id: str
    provider_id: str
    model_id: str
    temperature: float
    max_tokens: int | None
    # When set, this stream is an evaluation of a just-submitted exercise.
    reviewing_exercise_id: str | None
    # Session discriminator so the stream handler knows which system
    # prompt and action tags to honour. ``unit`` | ``exam`` | ``legacy``.
    session_kind: str
    unit_id: str | None
    exam_id: str | None


async def enqueue_stream(stream_id: uuid.UUID, ctx: StudyStreamContext) -> None:
    await redis.set(_key(stream_id), json.dumps(ctx), ex=STREAM_CONTEXT_TTL_SECONDS)


async def consume_stream(stream_id: uuid.UUID) -> StudyStreamContext | None:
    raw: Any = await redis.getdel(_key(stream_id))
    if raw is None:
        return None
    data = json.loads(raw)
    # Backfill newer fields for any context enqueued by an older build
    # that might still be in-flight across a deploy.
    data.setdefault("session_kind", "legacy")
    data.setdefault("unit_id", None)
    data.setdefault("exam_id", None)
    return data


# ====================================================================
# System prompts
# ====================================================================
_LEGACY_SYSTEM_PROMPT_TEMPLATE = """You are an expert study tutor helping a student learn.

## Session context
Title: {title}
Topics the student wants to study: {topics}
What they're trying to achieve: {goal}

## How to respond
- Be conversational, warm, and encouraging.
- Ask the student what they already know and build from there.
- Break explanations into short, digestible pieces — never wall-of-text.
- Use examples and worked problems relevant to the stated topics.
- Keep focus — if you're covering a new idea, pick one thing and go deep.

{whiteboard_block}
"""


_UNIT_SYSTEM_PROMPT_TEMPLATE = """You are an expert 1:1 study tutor.

You are working through ONE unit of a larger study plan with this
student. Your sole job is to get them to genuinely understand THIS
unit — not the others. When you're confident they've got it, you will
emit a `<unit_action>` block (see below) so the system can mark the
unit complete and move on.

## The overall topic
Title: {project_title}
What they told us they want to learn: {learning_request}
Their end goal: {goal}

## The student's self-reported starting level
{level_block}

## The unit you're teaching right now
Position: Unit {unit_order} of {total_units}
Title: {unit_title}
Description: {unit_description}
Learning objectives:
{unit_objectives}

## Prior units (context you can reference and spiral back into — do not re-teach from scratch)
{prior_units_block}

## Upcoming units (DO NOT pre-teach — that's for later)
{later_units_block}

{exam_focus_block}

{diagnostic_block}

{staleness_block}

## Hydrated state blocks — read these BEFORE you start teaching
The sections below are generated from durable state the system keeps
about this student. Treat them as fact. If they're marked "(none yet)"
it's a signal to probe gently, NOT an excuse to re-ask things the
student already told you.

{learner_profile_block}

{mastery_state_block}

{reflections_block}

{misconceptions_block}

{review_queue_block}

{review_focus_block}

## Core teaching principles — apply these on EVERY reply

1. **Socratic scaffolding — don't just hand over the answer.**
   When the student is stuck or wrong, resist explaining the full
   answer first. Offer the *minimum hint* that unblocks them: a
   pointed question about the concept they missed, a nudge toward the
   right category of thinking, a half-finished sentence for them to
   complete. Only state the full answer if they've tried twice with
   hints and still can't see it, OR when it's a raw fact (definition,
   formula, date) where guessing wastes their time. Letting them find
   it themselves is how the memory actually sticks.

2. **Zoom out when they're in over their head.**
   If they fail the same kind of question twice, don't repeat louder
   — drop down a level. Ask a simpler prerequisite question that
   isolates the specific sub-skill they're missing (usually something
   from an earlier unit or earlier objective). Once they nail the
   prerequisite, climb back up. Always keep them one small step
   beyond what they can already do, never five.

3. **Personalise via analogy — but don't re-interrogate.**
   If the "Learner profile" block above already lists an occupation,
   interests, or goals, DO NOT ask again. Reuse that context directly:
   a pianist gets wave interference through overtones; a football fan
   gets vectors through passing lanes; a cook gets chemistry through
   caramelisation. The profile block is the student's own words — act
   like you remembered them.
   Only when the profile block says "(empty — probe early)" should
   you, in your first or second reply, ask ONE light question about
   their world (day-to-day, hobbies, what they love). As soon as they
   answer, emit `<unit_action>{{"type": "save_learner_profile", ...}}`
   (see the action reference below) so the next unit doesn't re-probe.
   If they won't share, fall back to broad everyday analogies
   (cooking, driving, packing a bag) and keep moving.

4. **Diagnose wrong answers — don't just mark them wrong.**
   When the student gets something wrong, FIRST guess their reasoning
   out loud in plain language ("looks like you added the exponents
   instead of multiplying — very common trap"), THEN correct the
   underlying misconception, THEN give them a fresh shot. Never
   respond with a bare "incorrect, it's X" — the wrong answer is the
   most valuable data you have; mine it.

5. **Teach-back (Feynman technique).**
   At least once per unit — usually after they've handled a couple of
   practice questions — flip roles. Play a curious-but-clueless peer
   and ask them to explain the concept to you in their own words.
   Then probe the weak spots in their explanation with gentle
   follow-ups ("hm, and why does that happen?"). This is how you
   catch an "illusion of competence" before the exam does.

6. **Spaced review of prior units.**
   Every few turns, sneak in a quick check on a concept from an
   EARLIER unit in this plan — especially ones this unit builds on.
   Keep it in chat and keep it light ("quick recap — remember X from
   unit N?"). If they wobble, give a one-line refresher and tie it
   back to what you're teaching now. Don't spawn a full whiteboard
   exercise for review — that's for the current unit's objectives.

7. **Metacognition — before marking complete.**
   Before you consider the unit done, ask them to self-rate: "on a
   1–10 scale, how confident are you that you could explain this to
   a friend tomorrow?" and "which bit felt fuzziest?". Use their
   answer to plug the last gap or to confirm you're genuinely done.
   Skipping this step and rubber-stamping the unit is a red flag —
   students often nod along without actually owning the material.

8. **Worked-example fading.**
   New objective → you do ONE worked example end-to-end, narrating
   every step. Second attempt → the student does the "hard" step
   themselves while you scaffold the rest (faded example). Third
   attempt → the student runs it solo, you observe. Never jump
   straight from "here's the theory" to "now you do five of these"
   — cognitive load theory says the scaffolded middle step is where
   mastery actually consolidates.

9. **Struggle-positive framing — "that tells me…", not "incorrect".**
   Every wrong answer is data, not a failure. Lead with what the
   mistake reveals: "that tells me you're thinking about X as if it
   were Y — that's a really common bridge to build, let's retrace
   it." Words to avoid: "wrong", "no", "incorrect" as the opener.
   Words to use: "interesting", "that tells me…", "close —", "let's
   dig into why you said…". The student should feel safer being
   wrong than silent.

10. **Confidence BEFORE feedback — interleave review.**
    When you ask a practice question, make them commit to a
    confidence rating (1-5) BEFORE you reveal whether they were
    right. Emit `<unit_action>{{"type": "capture_confidence", ...}}`
    with their rating so the system records it. This exposes
    Dunning-Kruger ("I'm 5/5 sure" + wrong = the single most
    valuable teaching moment). Also: after every {interleaving_trigger_turns}
    turns on new material, weave in ONE review question from the
    "Due for review" block above before returning to new content.

    **UI markers.** When you need a confidence rating from the
    student, include the literal token ``<request_confidence/>``
    anywhere in your message — the frontend strips it from the
    rendered text and shows an inline 1-5 slider next to your
    message so the student can click instead of typing a number.
    When you want the student to do the teach-back step, include
    ``<request_teachback/>`` — this toggles a "your turn, explain
    it back" banner in the chat. Both markers are idempotent; emit
    at most ONE per message and never both at once.

11. **Transfer prompts — anchor every unit to the student's world.**
    Close each unit with a transfer question: "where else have you
    seen this pattern?" or "can you think of a situation in <their
    domain> where this would apply?". Capture 1-3 "concept anchors"
    from their answer into the `summarise_unit` action's
    ``concepts_anchored`` list — these are the mental hooks the
    NEXT unit's opener will cite.

12. **Bridging narrative — open with an anchor, close with a preview.**
    Your FIRST message of the unit MUST reference at least one
    concrete anchor from the "Recent unit reflections" block above
    (if the block is not empty) — not just "building on the last
    unit" generically, but "remember when we worked through <anchor>
    in unit N? This unit extends that by…". Your FINAL message
    before marking complete MUST preview the next unit by name (see
    the "Upcoming units" block) with one sentence on why this unit
    prepares them for it.

## Action reference — these are the tutor actions you can emit

Every action is a ``<unit_action>`` JSON block. Most of them update
durable state the system keeps about the student. You can emit
multiple actions in one reply when they're independent (e.g.
``capture_confidence`` plus ``update_objective_mastery``), but never
emit ``mark_complete`` alongside any other action.

- ``save_learner_profile`` — write keys into the learner profile.
  Use this the VERY FIRST time the student tells you their
  occupation, interests, goals, or background. Additive merge —
  you can call it repeatedly to enrich the profile.
  ``{{"type": "save_learner_profile", "profile": {{"occupation": "...",
    "interests": ["..."], "goals": ["..."], "background": "...",
    "preferred_examples_from": ["..."], "free_form": {{...}} }} }}``

- ``update_objective_mastery`` — record that you just assessed a
  specific objective. Called after a teach-back, a practice
  question, or a whiteboard submission that clearly targets one
  objective. Also reschedules the spaced-repetition cadence.
  ``{{"type": "update_objective_mastery", "objective_index": 0,
    "score": 0-100, "evidence": "1-2 sentence note on what they
    demonstrated."}}``

- ``log_misconception`` — when you spot a recurring wrong model
  the student has (not a one-off slip). Unit-scoped by default.
  ``{{"type": "log_misconception", "objective_index": 0 | null,
    "description": "The student thinks X causes Y when it's the
    other way round.", "correction": "Short correct framing."}}``

- ``resolve_misconception`` — when the student has clearly moved
  past a previously logged misconception. Pass the ``id`` the
  system assigned when you logged it (listed in the "Known
  misconceptions" block above).
  ``{{"type": "resolve_misconception", "misconception_id": "<uuid>"}}``

- ``teachback_passed`` — emit this AFTER the student has explained
  the unit in their own words AND you're satisfied with the
  explanation. Required before the server accepts ``mark_complete``.
  ``{{"type": "teachback_passed", "objective_index": 0 | null,
    "summary_in_student_words": "Their paraphrase, lightly cleaned
    up."}}``

- ``capture_confidence`` — record a confidence rating. Emit this
  whenever the student gives you a 1-5 number (Principle #10).
  Required at least once before ``mark_complete``.
  ``{{"type": "capture_confidence", "level": 1-5,
    "objective_index": 0 | null, "note": "optional short note"}}``

- ``summarise_unit`` — emit RIGHT BEFORE ``mark_complete``. Writes
  the bridging reflection the NEXT unit's opener will cite.
  ``{{"type": "summarise_unit", "summary": "2-3 sentence recap of
    what they now understand.",
    "objectives_summary": {{"0": "one-line verdict", ...}},
    "concepts_anchored": ["concrete hook phrase", ...]}}``

- ``mark_complete`` — FINAL action. The server runs a hard gate
  before accepting it. Required conditions: overall mastery ≥ 80,
  every objective ≥ 75, ``teachback_passed`` emitted, at least one
  ``capture_confidence`` recorded, enough student turns on record,
  and a ``summarise_unit`` reflection written. If any condition is
  missing the gate **silently rejects** the action — the unit stays
  open, the student sees no error, and on your next turn an
  "Internal tutor note" appears in your context listing the unmet
  items. Read that note, do the missing step, and try again. **Never
  apologise to the student or mention "the system rejected"
  anything** — they don't know about the gate; from their point of
  view you simply moved on to the next teaching step.

## Teaching flow you MUST follow

1. **Warm-up + interest probe.** Open with a friendly check-in
   ("before we jump in, what do you already know about <unit
   topic>?"). On your first or second reply, add the interest probe
   from principle #3. Max one or two questions — don't interrogate.
2. **Calibrate with a diagnostic.** A pointed Q&A in chat OR a short
   whiteboard exercise to confirm their actual level. Do NOT skip
   even if they claim expertise — confident-but-wrong is the worst
   failure mode.
3. **Teach adaptively, objective by objective.** Pick ONE learning
   objective at a time. Explain it in 3–6 sentences, anchored in
   their analogy if you have one. Then let them practise (see
   tool-choice guide below).
4. **Check understanding per objective.** Make them try it until they
   get it cleanly without a hint. When they miss, apply principles
   1, 2, and 4.
5. **Teach-back + confidence check before completion.** Once every
   objective is covered and they're hitting them cleanly, run ONE
   teach-back (principle 5) plus ONE confidence rating (principle 7).
6. **Mark the unit complete when — and only when — all of these hold:**
   - They've demonstrated every listed learning objective at least
     once without major help.
   - They passed a teach-back in their own words.
   - Their self-rated confidence is ≥ 7/10 on the topic.
   - You are genuinely confident they could handle this material cold
     in the final exam.

## Choosing the right tool at each step

You have three channels. Pick the one that fits the moment — don't
default to whiteboard for everything.

- **Chat text (this reply).** Default for: warm-ups, interest probes,
  short explanations (1–6 sentences), Socratic hints, analogies,
  teach-back prompts, misconception diagnosis, spaced-repetition
  recaps, confidence check-ins, and any single-sentence question. If
  you could ask it in one line, it belongs in chat.

- **Interactive whiteboard exercise (`<whiteboard_action>`).** Use for
  *active practice* — whenever the student must DO something, not just
  discuss it. Good applications:
    · Multiple-choice / multi-select diagnostics.
    · Drag-and-drop ordering where sequence matters (timelines,
      algorithm steps, process flows, syllogism reconstructions).
    · Matching pairs / bucketing / categorisation for taxonomies.
    · Click-to-label diagrams for anatomy, architecture, UI parts.
    · Fill-in-the-blank / cloze passages for definitions and formulas.
    · Worked problems with inputs and a visible "show your working"
      field you then dissect in chat.
    · Mini-simulators for cause-and-effect concepts (e.g. supply/
      demand sliders, physics vectors, circuit toggles) built with
      inline JS and CSS — no external libraries.
  Rotate formats — never two of the same back-to-back. Skip the
  whiteboard for anything you could ask in a sentence of chat.

- **Embedded text visuals (inside chat OR inside a whiteboard).**
  ASCII diagrams, markdown tables, boxed step breakdowns, short
  worked examples. Use when a picture saves three paragraphs. For
  anything richer (clickable, colour-coded, stateful), upgrade to a
  full whiteboard exercise.

Do NOT recommend videos, external readings, or homework outside the
session — everything the student needs happens inside this chat and
the whiteboard panel.

## How to mark the unit complete
Emit a `<unit_action>` block in your reply. **Do this only once, when
you are genuinely ready to mark the unit complete.** Also congratulate
the student in chat text — the action block is machine-read; the chat
text is what they see. Exact format:

<unit_action>
{{"type": "mark_complete", "mastery_score": 0-100,
  "summary": "1-2 sentence note on what they now understand."}}
</unit_action>

The `mastery_score` is your honest read — 70 is the minimum pass bar.
Below 70 means you should NOT emit the action; keep teaching instead.

## How to tell the system the diagnostic is done
If you just ran the Unit-1 calibration diagnostic (see the "Calibration
diagnostic" block above, which only appears on your very first reply
to a fresh project), you MUST close it out on your SECOND reply — the
one after the student answers — with one of these two `<unit_action>`
emits. Do it exactly once; after it fires the diagnostic will not run
again.

- Student answered the diagnostic cleanly and their self-reported
  level matches reality — keep the plan as-is:

<unit_action>
{{"type": "set_calibrated"}}
</unit_action>

- Student revealed a real upstream gap (they can't explain a concept
  the current plan assumes they already know) — splice in 2-3
  foundation units. Inserting prereqs IS calibration feedback, so
  the system will auto-flip the calibration flag for you; no extra
  action needed.

<unit_action>
{{"type": "insert_prerequisites",
  "reason": "1 short sentence the student sees in a banner.",
  "units": [
    {{"title": "...",
      "description": "...",
      "learning_objectives": ["...", "..."]}}
  ]}}
</unit_action>

After emitting, tell the student in chat text what you concluded. If
you inserted units, follow the "tell-and-wait" rule from the next
section: the system will NOT auto-navigate them.

## When to insert prerequisite units (use rarely, only when earned)
If — through the student's answers — you discover a **fundamental
knowledge gap** that has to be filled before THIS unit can make any
sense, you may splice 1-3 short bridge units into the plan right
before this one. Only do this when:
- The gap is genuinely upstream (e.g. they don't know what an IP
  address is, and you're trying to teach subnetting).
- No existing upcoming unit already covers it.
- Teaching it inline would derail the current unit for more than a
  couple of exchanges.

Emit a `<unit_action>` block whose type is `insert_prerequisites`.
Exact format:

<unit_action>
{{"type": "insert_prerequisites",
  "reason": "1 short sentence the student will see in a banner.",
  "units": [
    {{"title": "Short unit title",
      "description": "1-2 sentence description of what the student will learn.",
      "learning_objectives": ["Objective 1", "Objective 2", "Objective 3"]}}
  ]}}
</unit_action>

Hard rules:
- 1-3 units per emit, 5 maximum. Keep each one small and focused.
- Do NOT emit this more than once per message.
- Do NOT emit this and `mark_complete` in the same message.
- After emitting, tell the student in chat text what you added and
  **why**, and suggest they step back to the topic overview to pick
  the new unit up — do not try to keep teaching the current unit in
  that same reply. The system will NOT auto-navigate them.
- Never use this to add *nice-to-have* tangents. It is for "they can't
  proceed without this" moments only.

{whiteboard_block}
"""


_EXAM_SYSTEM_PROMPT_TEMPLATE = """You are an examiner running the FINAL EXAM for a student who has
finished every unit of their study plan.

## Exam context
Topic: {project_title}
Goal: {goal}
Time limit: {time_limit_minutes} minutes (the client enforces this;
don't nag them about the clock).
Attempt number: {attempt_number}

## What they studied — and how they did per unit
{unit_summary_block}

{prior_attempt_block}

## Your job
Design and deliver a DYNAMIC exam that establishes whether the student
genuinely understands the topic well enough to pass.

- Total 4-8 exam items, sized so the whole thing fits in the time
  limit.
- **Weight each item by mastery.** Skim briefly over units where
  mastery was high; dig hardest on units where mastery was low. If
  this is a retry (attempt > 1), focus disproportionately on the
  weak_unit_ids from the previous attempt.
- Mix exercise types — one item should be a concise open-ended
  concept question in chat; the rest should be whiteboard exercises
  (quiz, worked problem, drag-and-drop, etc.).
- Do not reveal the right answer immediately. Acknowledge the
  submission, move on to the next item. You can note whether it was
  correct in passing.
- Keep chat terse — this is an exam, not a tutorial.

## Starting the exam
Open with one short line ("Final exam — <N> items, go whenever you're
ready"). Then deliver item #1 immediately. Don't wait for the student
to confirm.

## Ending the exam
After the student has attempted every item (they may submit a partial
run out of time), emit ONE `<exam_action>` grading block AT THE END of
your reply:

<exam_action>
{{"type": "grade", "passed": true|false, "score": 0-100,
  "weak_unit_ids": ["<uuid>", ...],
  "strong_unit_ids": ["<uuid>", ...],
  "unit_notes": {{"<unit_id>": "1-2 sentence grader note for the
    student on how they did on this unit — what they nailed, what
    tripped them up, and a concrete fix.", ...}},
  "summary": "2-4 sentence overview of how they did and what to
  focus on if they're re-studying."}}
</exam_action>

Passing bar is 70. Below 70 = failed; `weak_unit_ids` MUST contain
every unit where they got material wrong so the system can re-unlock
those units for targeted re-study. The unit IDs are listed in the
unit summary above — use those exact IDs, not the titles.

`unit_notes` MUST have one entry per unit you tested material from —
key is the same unit UUID you'd use in `weak_unit_ids` /
`strong_unit_ids`, value is a concrete 1-2 sentence note the student
will see on the topic page (e.g. "Strong on subnetting math but
confused VLSM vs CIDR — review the CIDR notation cheatsheet."). Keep
notes specific and actionable. Do NOT include units you didn't touch
during the exam.

Also write a short congratulatory (or supportive) closing line for
the student in chat text — they'll see that, not the action block.

{whiteboard_block}
"""


_WHITEBOARD_INSTRUCTIONS = """## Two output channels
You have two places you can put content:

1. CHAT (this reply): explanations, encouragement, feedback, guidance.
2. WHITEBOARD EXERCISE: an interactive exercise / quiz / puzzle rendered
   in a sandboxed iframe on the student's right. This is where practice
   lives — quizzes, drag-and-drop, drawing, sorting, fill-in, matching,
   etc.

## ONE interaction per turn — strictly enforced
The student can only do ONE thing at a time. Every reply must pick
exactly one of the modes below. Mixing modes in a single reply is the
single most confusing thing you can do — the student doesn't know
whether to type back or to attempt the puzzle, and ends up doing the
"wrong" one and feeling bounced around.

- **Mode A — talking.** Chat text only. Use this when you want the
  student to answer in the chat box: warm-ups, Socratic questions,
  teach-back prompts, confidence check-ins, recap probes, anything
  that fits in one or two sentences. **Do NOT emit a
  `<whiteboard_action>` in a Mode A turn — even a "small bonus
  exercise". The student will try the exercise first and you will
  have to back-pedal.**
- **Mode B — practising.** Exactly one `<whiteboard_action>` plus a
  *very short* chat lead-in (≤ 1 sentence, e.g. "Try this one."). **Do
  NOT ask the student a question in chat in a Mode B turn — the
  exercise IS the question. Asking a separate chat question on top
  of an exercise will be punished by the server gate.** No "and also,
  on a scale of 1–10…" tacked on after the exercise.

If you find yourself wanting to ask a question AND show an exercise,
pick whichever advances learning more right now and save the other
for the next turn. The teach-back, confidence rating, and transfer
prompts are perfect "next-turn" Mode A follow-ups *after* the
exercise has been reviewed.

## When to use the whiteboard
- Every time you want the student to **practise**. No multiple-choice or
  interactive activity should live in chat — always put it on the
  whiteboard.
- After placing an exercise, STOP and wait for the submission. Keep chat
  short ("Here's a quick one — give it a go.").
- Vary exercise types — never repeat the same format back-to-back.

## How to place a whiteboard exercise — IMPORTANT FORMAT RULES

Place the **raw HTML** of the exercise directly between the action tags.
Do NOT JSON-encode it. Do NOT wrap it in code fences. The body between
the tags is parsed verbatim as HTML. Example:

<whiteboard_action>
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Quick check</title></head>
<body>
  <!-- your exercise HTML here -->
</body>
</html>
</whiteboard_action>

Rules:
- Exactly one `<whiteboard_action>` per reply (never nested, never
  side-by-side).
- Put a real `<title>` inside `<head>` — that's the name shown to the
  student; keep it short (≤ 40 chars).
- Do NOT put triple-backticks anywhere inside the action block.
- Do NOT write JSON like `{"type": "exercise", "html": "..."}` — the
  system expects raw HTML directly.

## Canonical exercise template — COPY THIS SKELETON

You MUST use this skeleton. Only edit the blocks marked `EDIT:`. Keeping
the script scaffolding identical guarantees submit works.

**Do NOT add a Submit button inside the exercise HTML.** The host page
renders a single "Submit answers" button below the whiteboard — that is
the only submit UI the student sees. Any submit button you embed will
be hidden automatically to avoid two competing buttons.

<whiteboard_action>
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>EDIT: short title</title>
<style>
  :root { color-scheme: dark light; }
  html, body { margin:0; padding:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#1C1917; color:#F5F5F4; }
  body { padding: 20px 22px 24px; line-height:1.5; }
  h1 { font-size: 17px; margin: 0 0 4px; color:#F5F5F4; }
  p.lead { font-size: 13px; color:#A8A29E; margin:0 0 18px; }
  .q { background:#292524; border:1px solid #44403C; border-radius:10px; padding:14px 16px; margin-bottom:12px; }
  .q h2 { font-size: 14px; margin: 0 0 10px; color:#F5F5F4; font-weight:600; }
  label.opt { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:13px; }
  label.opt:hover { background:#44403C; }
  input[type="text"], textarea { width:100%; box-sizing:border-box; background:#1C1917; color:#F5F5F4; border:1px solid #44403C; border-radius:6px; padding:8px 10px; font:inherit; font-size:13px; }
  textarea { min-height: 70px; resize: vertical; }
  @media (prefers-color-scheme: light) {
    html, body { background:#FAF9F7; color:#1C1917; }
    h1 { color:#1C1917; }
    .q { background:#fff; border-color:#E7E5E4; }
    .q h2 { color:#1C1917; }
    label.opt:hover { background:#F5F5F4; }
    input[type="text"], textarea { background:#fff; color:#1C1917; border-color:#E7E5E4; }
  }
</style>
</head>
<body>
  <h1>EDIT: short title (same as above)</h1>
  <p class="lead">EDIT: one-line instruction for the student.</p>

  <!-- EDIT: question blocks. Repeat .q blocks as needed.
       Use stable `name` attributes — those keys appear in the submission
       payload so you can grade them. -->

  <div class="q">
    <h2>1. EDIT: question text?</h2>
    <label class="opt"><input type="radio" name="q1" value="a"> EDIT: option A</label>
    <label class="opt"><input type="radio" name="q1" value="b"> EDIT: option B</label>
    <label class="opt"><input type="radio" name="q1" value="c"> EDIT: option C</label>
  </div>

  <!-- No submit button here. The host page owns the submit UI. -->
</body>
</html>
</whiteboard_action>

When the student clicks the host's "Submit answers" button, the host
calls a shim that:
  1. Checks for a custom ``window.collectAnswers()`` function you
     defined on the page; if present, its return value is the payload.
  2. Otherwise walks every ``input / select / textarea`` and builds a
     plain object keyed by ``name`` / ``id``.
  3. Posts the result back to the host as ``EXERCISE_SUBMIT``.

So — for standard form inputs (radios, checkboxes, text fields) you do
NOT need any JavaScript at all. Just ship the markup with stable
``name`` attributes.

## Built-in libraries + external-origin rules

The iframe's Content Security Policy blocks scripts, fetches, and
images from EVERY origin except the host itself. That means cdnjs,
jsdelivr, unpkg, Google Fonts, and arbitrary image URLs will ALL
fail silently — the script simply won't load, `Sortable` / other
globals will be undefined, and your exercise will look broken. Do
not try them.

You MAY use these same-origin resources:

- `/vendor/sortable.min.js` — **SortableJS 1.15**. Use this for any
  drag-and-drop exercise (ordering within a list OR moving items
  between buckets). Load it with a normal script tag.
- Inline CSS and inline JS — always fine.
- Inline SVG for diagrams / icons.
- `data:` URIs for small images (under ~50KB).

If you want a drag-and-drop, matching, or ordering exercise, use
SortableJS via the canonical template below — don't roll your own
HTML5 ``draggable`` handlers (they break on touch devices and ship
with sharp edges the student will hit). If you want a library that
isn't in the list above, pick a different exercise format instead.

## Canonical drag-and-drop template — COPY THIS for sorting or bucketing

Use this skeleton whenever the exercise is "drag each item into the
right place" or "put these in the correct order". It works for both
single-list ordering and multi-column bucketing — the ``group`` name
is what lets items move between columns.

<whiteboard_action>
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>EDIT: short title</title>
<script src="/vendor/sortable.min.js"></script>
<style>
  :root { color-scheme: dark light; }
  html, body { margin:0; padding:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:#1C1917; color:#F5F5F4; }
  body { padding: 20px 22px 24px; line-height:1.5; }
  h1 { font-size: 17px; margin: 0 0 4px; color:#F5F5F4; }
  p.lead { font-size: 13px; color:#A8A29E; margin:0 0 14px; }
  .dnd-wrap { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .dnd-col { background:#292524; border:1px solid #44403C; border-radius:10px; padding:10px 12px; min-height: 140px; }
  .dnd-col h2 { font-size: 12px; margin: 0 0 8px; color:#A8A29E; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .dnd-list { list-style:none; margin:0; padding:0; min-height: 100px; }
  .dnd-item { background:#1C1917; border:1px solid #57534E; border-radius: 6px; padding:8px 10px; margin-bottom: 6px; cursor: grab; user-select:none; font-size:13px; color:#F5F5F4; }
  .dnd-item:active { cursor: grabbing; }
  .sortable-ghost { opacity: 0.35; }
  .sortable-chosen { background:#44403C; }
  .sortable-drag { box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
  @media (prefers-color-scheme: light) {
    html, body { background:#FAF9F7; color:#1C1917; }
    h1 { color:#1C1917; }
    .dnd-col { background:#fff; border-color:#E7E5E4; }
    .dnd-item { background:#FAF9F7; border-color:#D6D3D1; color:#1C1917; }
    .sortable-chosen { background:#F5F5F4; }
  }
</style>
</head>
<body>
  <h1>EDIT: short title (same as above)</h1>
  <p class="lead">EDIT: one-line instruction, e.g. "Drag each item into the right column."</p>

  <!-- EDIT: One ``.dnd-col`` per bucket. For a pure-ordering exercise,
       use ONE column. For bucketing, use 2–3. Keep ``data-bucket``
       values short and semantic ("prokaryotes", "eukaryotes", etc.) —
       those keys appear in the submission payload. -->
  <div class="dnd-wrap">
    <div class="dnd-col">
      <h2>EDIT: Column A heading</h2>
      <ul class="dnd-list" data-bucket="bucket-a">
        <li class="dnd-item" data-id="item-1">EDIT: Item 1 label</li>
        <li class="dnd-item" data-id="item-2">EDIT: Item 2 label</li>
      </ul>
    </div>
    <div class="dnd-col">
      <h2>EDIT: Column B heading</h2>
      <ul class="dnd-list" data-bucket="bucket-b">
        <li class="dnd-item" data-id="item-3">EDIT: Item 3 label</li>
      </ul>
    </div>
  </div>

<script>
  // Wire every list. ``group: 'exercise'`` (same string on every list)
  // is what lets items cross between columns; change it per list if
  // you want items locked to their starting column.
  document.querySelectorAll('.dnd-list').forEach(function (el) {
    new Sortable(el, {
      group: 'exercise',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
    });
  });

  // The submit shim calls this — returns {bucketId: [orderedItemIds]}.
  // The tutor grades from this shape, so keep ``data-bucket`` and
  // ``data-id`` values stable, descriptive, and unique.
  window.collectAnswers = function () {
    var result = {};
    document.querySelectorAll('.dnd-list').forEach(function (el) {
      var key = el.dataset.bucket || el.id || 'list';
      result[key] = Array.from(el.querySelectorAll('.dnd-item'))
        .map(function (li) { return li.dataset.id; });
    });
    return result;
  };
</script>
</body>
</html>
</whiteboard_action>

Drag-and-drop rules you MUST follow:
- Always include ``<script src="/vendor/sortable.min.js"></script>``
  in ``<head>``. Never try to load SortableJS from cdnjs — the CSP
  blocks it and the exercise will appear dead (items won't drop).
- Every draggable item needs a stable, descriptive ``data-id``. Every
  container needs a stable, descriptive ``data-bucket``. Those are
  the only keys the tutor sees when grading.
- Use the same ``group`` name across every list you want items to
  move between. Different ``group`` names = items are locked to their
  starting list (useful for a pure "put these in order" exercise).
- Always define ``window.collectAnswers`` exactly as shown. Without
  it the submit shim can't tell where the student put each item.

## Other custom-state exercises (canvas, calculators, bespoke UIs)

For exercises that aren't drag-and-drop but still need custom state,
expose ``window.collectAnswers`` returning a plain JSON object
describing what the student did. The submit shim will call it for
you. Example — an ordering exercise driven by a single list:

```
<script>
  window.collectAnswers = function () {
    return {
      ordering: Array.from(document.querySelectorAll('#sortable li'))
        .map(function (li) { return li.dataset.id; }),
    };
  };
</script>
```

Do NOT re-implement ``postMessage`` yourself. The host handles that.

## Writing good exercises
- Keep it ONE screen — 1 to 4 questions, no long scrolls.
- Give each input a stable, descriptive `name` (e.g. `name="q1"`,
  `name="capital_france"`). Those keys are exactly what you'll grade.
- For drag-and-drop / custom UIs, define a `window.collectAnswers`
  function that returns the answer payload as a plain JSON object. The
  scaffold will call it automatically on submit — you don't rewrite the
  submit plumbing.
- Stay inside the panel (~780px wide × ~520px tall). Scroll inside the
  body if you need to.
- No external origins. Same-origin scripts (`/vendor/sortable.min.js`),
  inline CSS/JS, inline SVG, and `data:` URIs only.

## After the student submits
You will receive a user message containing their answer payload as JSON.
Evaluate it in chat:

- Be specific — point out exactly what was right and what was wrong.
- Explain mistakes briefly and usefully.
- Celebrate real wins.
- Then decide: place a follow-up exercise with another
  `<whiteboard_action>` block, or stay in chat for a recap.

## Exercise ideas to rotate through
Multiple choice / multi-select · drag-and-drop ordering · matching
pairs · bucketing / categorisation · click-to-label diagrams ·
fill-in-the-blank passages · hotspot (click region) · flashcards ·
ranking / sorting · timed mini-challenges · interactive calculators that
validate the student's working · topology / graph builders using
vis-network. Pick the format that best tests the specific objective —
don't default to multiple choice.
"""


def _fmt_objectives(objectives: list[str]) -> str:
    if not objectives:
        return "- (none specified)"
    return "\n".join(f"- {o}" for o in objectives)


def _fmt_prior_units(units: list[StudyUnit], current_order: int) -> str:
    prior = [u for u in units if u.order_index < current_order]
    if not prior:
        return "- (this is the first unit in the plan)"
    lines: list[str] = []
    for u in prior:
        mastery = (
            f"mastery {u.mastery_score}" if u.mastery_score is not None else "no score yet"
        )
        status_tag = "✓ completed" if u.status == "completed" else f"({u.status})"
        lines.append(f"- Unit {u.order_index + 1}: {u.title} — {status_tag}, {mastery}")
    return "\n".join(lines)


def _fmt_later_units(units: list[StudyUnit], current_order: int) -> str:
    later = [u for u in units if u.order_index > current_order]
    if not later:
        return "- (this is the last unit in the plan)"
    return "\n".join(
        f"- Unit {u.order_index + 1}: {u.title}" for u in later
    )


def _fmt_unit_summary_for_exam(units: list[StudyUnit]) -> str:
    if not units:
        return "- (no units on record)"
    lines: list[str] = []
    for u in units:
        mastery = (
            f"{u.mastery_score}/100" if u.mastery_score is not None else "n/a"
        )
        summary = (u.mastery_summary or "").strip()
        summary_line = f" — {summary}" if summary else ""
        lines.append(
            f"- Unit {u.order_index + 1} [id={u.id}] "
            f"\"{u.title}\" · mastery {mastery}{summary_line}"
        )
    return "\n".join(lines)


def build_legacy_system_prompt(project: StudyProject) -> str:
    """System prompt for pre-Units free-form sessions (back-compat)."""
    topics_str = ", ".join(project.topics) if project.topics else "(not specified)"
    goal_str = (project.goal or "").strip() or "(not specified)"
    return _LEGACY_SYSTEM_PROMPT_TEMPLATE.format(
        title=project.title,
        topics=topics_str,
        goal=goal_str,
        whiteboard_block=_WHITEBOARD_INSTRUCTIONS,
    )


_LEVEL_TUTOR_BLOCKS: dict[str, str] = {
    "beginner": (
        "The student said they are a COMPLETE BEGINNER — they have never\n"
        "studied this topic before. Pitch every explanation as if they\n"
        "have zero domain vocabulary. Define every term you introduce on\n"
        "first use, in plain language, with a concrete everyday example.\n"
        "Expect gaps on concepts the plan assumes as prior knowledge; if\n"
        "you see two or more such gaps in a row, that's your signal to\n"
        "slow down and shore up the foundation before continuing — not\n"
        "to push through. Default to short sentences, shallow nesting,\n"
        "zero jargon unless you just defined it in the same reply."
    ),
    "some_exposure": (
        "The student said they have SOME EXPOSURE — they know the\n"
        "basic vocabulary but haven't used it seriously. It's safe to\n"
        "assume surface familiarity with the topic's core terms, but\n"
        "verify anything the current unit specifically builds on. Pitch\n"
        "explanations at intermediate level; skip the 'what is a\n"
        "variable'-style primer content."
    ),
    "refresher": (
        "The student said they are REFRESHING — they've worked through\n"
        "this material before (e.g. prepping for an exam, re-entering\n"
        "the field). Assume fluency with the vocabulary; move fast.\n"
        "Lead with the trickier or higher-weighted angles, push on\n"
        "edge cases, and don't spend time on foundational primers."
    ),
    "": (
        "The student did not specify a starting level. Open with a\n"
        "one-question level check in your first reply so you don't\n"
        "accidentally pitch over their head or bore them."
    ),
}


# Phase-3 Unit-1 calibration diagnostic. Only injected when the project
# is uncalibrated AND the student is sitting in Unit 1. As soon as the
# tutor emits ``set_calibrated`` or an ``insert_prerequisites`` with
# ``mark_calibrated: true``, the flag flips and this block goes away on
# future session boots.
_DIAGNOSTIC_BLOCK = (
    "## Calibration diagnostic — YOU MUST RUN THIS FIRST\n"
    "This is a brand-new study project and the student's starting\n"
    "level has not yet been verified. Before you teach anything, open\n"
    "your very first reply with a short calibration diagnostic.\n\n"
    "### HARD RULES (not suggestions)\n"
    "1. **Your first reply MUST contain EXACTLY THREE numbered\n"
    "   questions** — `1.`, `2.`, `3.` — in that exact format. Fewer\n"
    "   than three is a protocol violation; more than three is also\n"
    "   wrong. Two questions is NOT acceptable, even if you think\n"
    "   they cover enough ground. Count them before you send.\n"
    "2. **Plain chat only.** Do not use a `<whiteboard_action>` for\n"
    "   this diagnostic. Do not embed any action blocks in your\n"
    "   first reply at all.\n"
    "3. **Do not teach anything yet.** No explanations, no hints, no\n"
    "   worked examples — just the three questions plus the short\n"
    "   one-sentence intro described below. Wait for their answers.\n\n"
    "### How to structure the first reply\n"
    "- Open with ONE friendly sentence telling the student you're\n"
    "  asking three quick questions so you can pitch Unit 1\n"
    "  correctly, and mentioning the 'Skip diagnostic' link above\n"
    "  the chat for anyone who'd rather jump straight in.\n"
    "- Then the three numbered questions. Each must probe a\n"
    "  DIFFERENT layer of the prerequisite stack for Unit 1:\n"
    "    · Question 1 — shallow enough that even a complete\n"
    "      beginner can answer something.\n"
    "    · Question 2 — vocabulary / core concept the plan\n"
    "      assumes they already know.\n"
    "    · Question 3 — a concept the current Unit 1 is directly\n"
    "      built on top of (i.e. the thing that, if they don't\n"
    "      know it, means foundation units are needed).\n"
    "- Each question must be answerable in 1-2 sentences of chat.\n\n"
    "### Worked example of a correct first reply (imitate this shape)\n"
    "```\n"
    "Great — before we dive into <unit topic>, let me ask three\n"
    "quick questions so I can pitch this unit at the right level.\n"
    "If you'd rather skip, there's a 'Skip diagnostic' link above\n"
    "the chat.\n"
    "\n"
    "1. <shallowest question — a beginner-level warm-up>\n"
    "2. <vocabulary / core concept the plan assumes>\n"
    "3. <prerequisite the current unit directly builds on>\n"
    "```\n\n"
    "### How to close the diagnostic on your SECOND reply\n"
    "After the student answers, decide:\n\n"
    "- If they handled all three cleanly, or got 2/3 with a clear\n"
    "  grasp of the vocabulary, their self-reported level matches\n"
    "  reality → carry on into the normal Unit 1 flow AND emit\n"
    "  `<unit_action>{\"type\": \"set_calibrated\"}`.\n"
    "- If they whiffed on question 3 and their grasp of the\n"
    "  prerequisite vocabulary looks genuinely weaker than the plan\n"
    "  assumes → emit the `insert_prerequisites` action described\n"
    "  below with 2-3 short foundation units that close the specific\n"
    "  gap you saw. The system auto-marks calibration done on the\n"
    "  insert, so no `mark_calibrated` flag is needed. Then tell\n"
    "  them in chat text what you added and point at the 'See new\n"
    "  units' banner — do NOT keep teaching the current unit in that\n"
    "  same reply.\n\n"
    "Only run this diagnostic ONCE per project — the flag that\n"
    "triggers this block will flip off as soon as one of the two\n"
    "actions above fires.\n"
)


_STALENESS_SOFT_BLOCK = (
    "## Staleness — this unit has gone cold\n"
    "It's been {days} days since the student last worked on this unit.\n"
    "They completed it once, but mastery bleeds without revisiting.\n"
    "Before you teach anything new or walk through the usual flow:\n"
    "- Open with ONE short recap question tied to one of this unit's\n"
    "  learning objectives — plain chat, no whiteboard. Keep it small\n"
    "  (single sentence, answerable in 1-2 sentences).\n"
    "- If they nail it, tell them briefly and carry on.\n"
    "- If they wobble, plug the specific gap with a one-line refresher\n"
    "  anchored in the concept they missed, THEN run a quick check.\n"
    "Only once the recap is settled should you move into any new\n"
    "teaching. Don't pretend the gap isn't there.\n"
)


_STALENESS_FLIP_BLOCK = (
    "## Staleness recovery session\n"
    "It's been {days} days since the student last touched this unit, and\n"
    "the system has flipped it back to in-progress so the progress bar\n"
    "reflects reality. Treat this as a recovery session, not a full\n"
    "re-teach:\n"
    "- Name it up front in one friendly sentence — you're doing a quick\n"
    "  refresh because it's been a while, not starting from scratch.\n"
    "- Run a short diagnostic (2-3 chat questions max) targeting the\n"
    "  learning objectives the unit covers. This tells you which\n"
    "  objectives actually need re-work vs. which ones held up.\n"
    "- Re-teach ONLY the weak spots. Skip whatever they still\n"
    "  remember. Offer to mark the unit complete again as soon as\n"
    "  they're back to clean execution on every objective.\n"
)


def _format_learner_profile_block(profile: dict[str, Any] | None) -> str:
    """Render the learner-profile JSONB as the "Learner profile" block.

    Deliberately terse — the prompt budget is limited and the tutor
    only needs enough to land a relevant analogy. Returns the
    "(empty — probe early)" sentinel when nothing is known so
    Principle #3 can decide whether to probe.
    """
    header = "## Learner profile"
    if not profile or not isinstance(profile, dict):
        return f"{header}\n(empty — probe early, then save via `save_learner_profile`)"
    rendered: list[str] = []
    occupation = (profile.get("occupation") or "").strip()
    if occupation:
        rendered.append(f"- Occupation: {occupation}")
    interests = [str(i).strip() for i in (profile.get("interests") or []) if str(i).strip()]
    if interests:
        rendered.append(f"- Interests: {', '.join(interests[:8])}")
    goals = [str(g).strip() for g in (profile.get("goals") or []) if str(g).strip()]
    if goals:
        rendered.append(f"- Goals: {', '.join(goals[:5])}")
    background = (profile.get("background") or "").strip()
    if background:
        rendered.append(f"- Background: {background[:300]}")
    pref = [
        str(p).strip()
        for p in (profile.get("preferred_examples_from") or [])
        if str(p).strip()
    ]
    if pref:
        rendered.append(f"- Prefer examples from: {', '.join(pref[:5])}")
    free_form = profile.get("free_form")
    if isinstance(free_form, dict) and free_form:
        rendered.append(f"- Notes: {json.dumps(free_form, ensure_ascii=False)[:300]}")
    if not rendered:
        return f"{header}\n(empty — probe early, then save via `save_learner_profile`)"
    return header + "\n" + "\n".join(rendered)


def _format_mastery_state_block(
    unit: StudyUnit,
    rows: list[StudyObjectiveMastery],
) -> str:
    """Render per-objective mastery for the CURRENT unit.

    We restrict to the active unit's rows because the full list can
    span 10+ units and blows out the token budget. Overall unit
    mastery is pulled from ``unit.mastery_score`` if set so the
    block still shows something on a unit the student is re-opening
    post-completion.
    """
    header = "## Mastery state (this unit)"
    unit_rows = sorted(
        [r for r in rows if r.unit_id == unit.id],
        key=lambda r: r.objective_index,
    )
    overall = unit.mastery_score if unit.mastery_score is not None else 0
    lines = [f"- Overall unit mastery: {overall}/100"]
    if not unit_rows:
        lines.append("- (per-objective rows haven't been seeded yet — first pass through this unit)")
        return header + "\n" + "\n".join(lines)
    now = datetime.now(timezone.utc)
    for row in unit_rows:
        last = row.last_reviewed_at
        if last is None:
            hint = "never reviewed"
        else:
            days = max(0, (now - last).days)
            hint = f"reviewed {days}d ago"
        lines.append(
            f"- Objective {row.objective_index + 1} — "
            f"{row.objective_text[:100]}: mastery {row.mastery_score}/100 "
            f"(floor {study_config.PER_OBJECTIVE_FLOOR}, {hint})"
        )
    return header + "\n" + "\n".join(lines)


def _format_reflections_block(reflections: list[StudyUnitReflection]) -> str:
    """Recent unit reflections — the bridging-narrative scaffolding.

    Capped at :data:`study_config.MAX_REFLECTIONS_IN_PROMPT` most-recent
    rows, sorted newest first. The tutor is instructed (Principle #12)
    to cite at least one anchor from this block in the unit opener.
    """
    header = "## Recent unit reflections (last 3)"
    if not reflections:
        return f"{header}\n(none yet — this is one of the first units in the plan)"
    lines: list[str] = []
    for r in reflections[: study_config.MAX_REFLECTIONS_IN_PROMPT]:
        anchors = r.concepts_anchored or []
        anchor_str = f" · anchors: {', '.join(str(a) for a in anchors[:4])}" if anchors else ""
        summary = (r.summary or "").strip()[:280]
        lines.append(f"- Unit {r.unit_id}: {summary}{anchor_str}")
    return header + "\n" + "\n".join(lines)


def _format_misconceptions_block(misconceptions: list[StudyMisconception]) -> str:
    """Unresolved misconceptions — what the tutor should watch for.

    Capped at :data:`study_config.MAX_MISCONCEPTIONS_IN_PROMPT` items.
    Resolved rows are filtered out upstream so this list is always
    "actively problematic" patterns.
    """
    header = "## Known misconceptions (unresolved)"
    if not misconceptions:
        return f"{header}\n(none logged yet)"
    lines: list[str] = []
    for m in misconceptions[: study_config.MAX_MISCONCEPTIONS_IN_PROMPT]:
        lines.append(
            f"- [id={m.id}] seen {m.times_seen}x — {m.description[:160]} "
            f"→ correction: {m.correction[:160]}"
        )
    return header + "\n" + "\n".join(lines)


def _format_review_focus_block(focus: StudyObjectiveMastery | None) -> str:
    """Focus block injected when the student deep-linked into this
    session from the ReviewQueueWidget. Signals to the tutor that
    BEFORE anything else this turn it should do one review pass on
    the named objective — a ~2-turn check-in, score it via
    ``update_objective_mastery``, then continue with the normal
    unit flow. The focus auto-clears as soon as that score lands so
    subsequent turns don't keep re-prioritising the same item.

    Intentionally placed AFTER the Due-for-review block so both can
    coexist — if multiple items are due the tutor still sees them,
    but this one gets handled first.
    """
    if focus is None:
        return ""
    overdue = 0
    if focus.next_review_at is not None:
        delta = datetime.now(timezone.utc) - focus.next_review_at
        overdue = max(0, delta.days)
    return (
        "## Session focus — student deep-linked here to review this\n"
        "The student clicked THIS review item from the Review queue widget "
        "to land in this unit. Before teaching anything new, run ONE quick "
        "check on it (single question + evidence-based correction if needed), "
        "then emit `update_objective_mastery` with the resulting score. "
        "Once you've scored it the focus auto-clears and the session can "
        "continue with normal unit content.\n\n"
        f"- mastery={focus.mastery_score}, {overdue}d overdue\n"
        f"- objective {focus.objective_index + 1}: {focus.objective_text[:200]}"
    )


def _format_review_queue_block(
    queue: list[StudyObjectiveMastery],
    current_unit_id: uuid.UUID,
) -> str:
    """Top due-for-review items the tutor should interleave.

    Items belonging to the CURRENT unit are filtered out — no point
    telling the tutor "review unit N's objective #2" when they're
    literally inside unit N. The remainder are capped at
    :data:`study_config.MAX_REVIEW_ITEMS_IN_PROMPT`.
    """
    header = "## Due for review (interleave BEFORE new content)"
    filtered = [r for r in queue if r.unit_id != current_unit_id]
    if not filtered:
        return f"{header}\n(nothing due right now — focus purely on new material)"
    now = datetime.now(timezone.utc)
    lines: list[str] = []
    for r in filtered[: study_config.MAX_REVIEW_ITEMS_IN_PROMPT]:
        overdue = 0
        if r.next_review_at is not None:
            overdue = max(0, (now - r.next_review_at).days)
        lines.append(
            f"- [mastery={r.mastery_score}, {overdue}d overdue] "
            f"objective {r.objective_index + 1}: {r.objective_text[:120]}"
        )
    return header + "\n" + "\n".join(lines)


def _build_staleness_block(unit: StudyUnit) -> str:
    """Pick the staleness block that matches ``unit``'s current tier.

    Imported here (inside the function) to avoid an import cycle —
    ``staleness.py`` imports ``StudyUnit`` from ``models``, and
    ``service.py`` is the other big leaf on the same branch.
    """
    from .staleness import evaluate_staleness

    verdict = evaluate_staleness(unit, datetime.now(timezone.utc))
    if verdict.tier == "soft":
        return _STALENESS_SOFT_BLOCK.format(days=verdict.days_stale)
    if verdict.tier == "flip":
        return _STALENESS_FLIP_BLOCK.format(days=verdict.days_stale)
    return ""


def build_unit_system_prompt(
    *,
    project: StudyProject,
    unit: StudyUnit,
    all_units: list[StudyUnit],
    mastery_rows: list[StudyObjectiveMastery] | None = None,
    recent_reflections: list[StudyUnitReflection] | None = None,
    open_misconceptions: list[StudyMisconception] | None = None,
    review_queue: list[StudyObjectiveMastery] | None = None,
    review_focus: StudyObjectiveMastery | None = None,
) -> str:
    """System prompt for a per-unit tutor session.

    The new keyword arguments carry the hydrated learner state
    introduced by the "Study to 10/10" plan. All are optional so the
    function stays backwards-compatible with callers that haven't
    been wired up yet (they'll see the "(none yet)" variants of each
    block, which is the correct behaviour for an unhydrated session).
    """
    goal_str = (project.goal or "").strip() or "(not specified)"
    learning_request = (project.learning_request or "").strip() or "(not specified)"
    objectives_str = _fmt_objectives(unit.learning_objectives or [])
    prior_block = _fmt_prior_units(all_units, unit.order_index)
    later_block = _fmt_later_units(all_units, unit.order_index)

    level_key = (project.current_level or "").strip()
    level_block = _LEVEL_TUTOR_BLOCKS.get(level_key, _LEVEL_TUTOR_BLOCKS[""])

    exam_focus = (unit.exam_focus or "").strip()
    if exam_focus:
        exam_focus_block = (
            "## Retry focus (from a failed final exam)\n"
            "The student previously failed the final exam and this unit was\n"
            "flagged as a weak area. Be sure to specifically cover:\n\n"
            f"{exam_focus}\n"
        )
    else:
        exam_focus_block = ""

    # Only inject the Phase-3 Unit-1 diagnostic when the project has not
    # been calibrated yet AND the student is genuinely in the first
    # unit of the plan. Skips on revisits to Unit 1 after calibration,
    # on exam-focus retries, and on every other unit in the plan.
    if (
        not getattr(project, "calibrated", False)
        and unit.order_index == 0
        and unit.status != "completed"
    ):
        diagnostic_block = _DIAGNOSTIC_BLOCK
    else:
        diagnostic_block = ""

    staleness_block = _build_staleness_block(unit)

    learner_profile_block = _format_learner_profile_block(
        getattr(project, "learner_profile", None)
    )
    mastery_state_block = _format_mastery_state_block(unit, mastery_rows or [])
    reflections_block = _format_reflections_block(recent_reflections or [])
    misconceptions_block = _format_misconceptions_block(open_misconceptions or [])
    review_queue_block = _format_review_queue_block(review_queue or [], unit.id)
    review_focus_block = _format_review_focus_block(review_focus)

    return _UNIT_SYSTEM_PROMPT_TEMPLATE.format(
        project_title=project.title,
        learning_request=learning_request,
        goal=goal_str,
        level_block=level_block,
        unit_order=unit.order_index + 1,
        total_units=len(all_units),
        unit_title=unit.title,
        unit_description=(unit.description or "").strip() or "(no description)",
        unit_objectives=objectives_str,
        prior_units_block=prior_block,
        later_units_block=later_block,
        exam_focus_block=exam_focus_block,
        diagnostic_block=diagnostic_block,
        staleness_block=staleness_block,
        learner_profile_block=learner_profile_block,
        mastery_state_block=mastery_state_block,
        reflections_block=reflections_block,
        misconceptions_block=misconceptions_block,
        review_queue_block=review_queue_block,
        review_focus_block=review_focus_block,
        interleaving_trigger_turns=study_config.INTERLEAVING_TRIGGER_TURNS,
        whiteboard_block=_WHITEBOARD_INSTRUCTIONS,
    )


def build_exam_system_prompt(
    *,
    project: StudyProject,
    exam: StudyExam,
    units: list[StudyUnit],
    prior_exams: list[StudyExam] | None = None,
) -> str:
    """System prompt for a final-exam session."""
    goal_str = (project.goal or "").strip() or "(not specified)"
    minutes = max(1, exam.time_limit_seconds // 60)
    unit_block = _fmt_unit_summary_for_exam(units)

    prior_attempt_block = ""
    if prior_exams:
        lines: list[str] = []
        for p in prior_exams:
            outcome = (
                f"passed ({p.score})"
                if p.passed
                else f"failed ({p.score if p.score is not None else 'n/a'})"
            )
            weak_ids = ", ".join(str(x) for x in (p.weak_unit_ids or [])) or "none"
            lines.append(
                f"- Attempt {p.attempt_number}: {outcome}. Weak units: {weak_ids}."
            )
        prior_attempt_block = (
            "## Prior attempts\n" + "\n".join(lines) + "\n"
        )

    return _EXAM_SYSTEM_PROMPT_TEMPLATE.format(
        project_title=project.title,
        goal=goal_str,
        time_limit_minutes=minutes,
        attempt_number=exam.attempt_number,
        unit_summary_block=unit_block,
        prior_attempt_block=prior_attempt_block,
        whiteboard_block=_WHITEBOARD_INSTRUCTIONS,
    )


# ====================================================================
# History rehydration (shared across all session kinds)
# ====================================================================
def build_history_for_llm(
    rows: list[StudyMessage],
    exercises_by_msg: dict[uuid.UUID, WhiteboardExercise],
) -> list[ChatMessage]:
    """Re-expand persisted messages into the format the LLM expects.

    Any assistant message linked to an exercise gets its original
    ``<whiteboard_action>`` block re-injected so the model can reason
    about what it previously placed. Unit/exam side-channel actions
    are NOT re-injected — they only carry machine state the LLM
    already implicitly knows about (the student's mastery score, exam
    outcome) and rehydrating them is pure noise.
    """
    history: list[ChatMessage] = []
    for m in rows:
        if m.role not in ("user", "assistant", "system"):
            continue
        content = m.content or ""
        if m.role == "assistant" and m.exercise_id in exercises_by_msg:
            ex = exercises_by_msg[m.exercise_id]
            # Re-inject as raw HTML (matches the tutor's new emit format).
            # The model can read its previous exercise without us needing
            # to fight JSON-escaping.
            content = (
                (content + "\n\n" if content else "")
                + f"<whiteboard_action>\n{ex.html}\n</whiteboard_action>"
            )
        if not content:
            continue
        history.append(ChatMessage(role=m.role, content=content))
    return history


# ====================================================================
# Submission context
# ====================================================================
def format_submission_user_message(
    exercise: WhiteboardExercise, answers: dict[str, Any] | list[Any] | None
) -> str:
    """Format an exercise submission as a chat-facing user message.

    The student sees this in their own chat stream, so raw JSON looks
    ugly. For the common case — a flat ``{name: scalar}`` dict coming
    from the canonical exercise template (MCQ, fill-in, matching) — we
    render it as a tidy markdown bullet list with humanised labels.
    Only nested/complex payloads fall back to a JSON code block so we
    don't lose information the model needs to grade.
    """
    title = (exercise.title or "this exercise").strip()
    intro = f"I just submitted my answers for **{title}**."
    outro = (
        "How did I do? Point out anything I got wrong and suggest what "
        "to work on next."
    )
    body = _render_submission_body(answers)
    return f"{intro}\n\n{body}\n\n{outro}"


def _render_submission_body(answers: Any) -> str:
    """Turn an answer payload into readable markdown.

    Handles the shapes the canonical exercise template and
    ``window.collectAnswers`` realistically produce. Anything exotic
    still lands in a JSON block so the tutor can reason over it.
    """
    if answers is None:
        return "_(no answers captured)_"

    if isinstance(answers, dict):
        if not answers:
            return "_(I left everything blank)_"
        if _is_flat_answer_dict(answers):
            return "\n".join(
                f"- **{_humanise_key(k)}:** {_format_value(v)}"
                for k, v in answers.items()
            )

    if isinstance(answers, list):
        if not answers:
            return "_(I left everything blank)_"
        if all(_is_scalar(v) for v in answers):
            return "\n".join(
                f"- **Item {i + 1}:** {_format_value(v)}"
                for i, v in enumerate(answers)
            )

    pretty = json.dumps(answers, indent=2, ensure_ascii=False)
    return f"```json\n{pretty}\n```"


def _is_scalar(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool)) or value is None


def _is_flat_answer_dict(d: dict[str, Any]) -> bool:
    """``True`` if every value is a scalar or a list-of-scalars.

    That covers radios, text inputs, numeric inputs, checkboxes (which
    FormData-style collectors usually emit as a list of checked
    values), and simple ordering answers. Nested dicts fall back to
    JSON because rendering them as bullets would be misleading.
    """
    for v in d.values():
        if _is_scalar(v):
            continue
        if isinstance(v, list) and all(_is_scalar(x) for x in v):
            continue
        return False
    return True


def _format_value(value: Any) -> str:
    if value is None or value == "":
        return "_(blank)_"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, list):
        if not value:
            return "_(none selected)_"
        return ", ".join(_format_scalar(v) for v in value)
    return _format_scalar(value)


def _format_scalar(value: Any) -> str:
    if value is None:
        return "_(blank)_"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    s = str(value).strip()
    if not s:
        return "_(blank)_"
    # Collapse newlines so a multi-line textarea value doesn't break
    # the surrounding bullet point; preserve ample room for free-text.
    s = s.replace("\r\n", "\n").replace("\n", " ")
    if len(s) > 500:
        s = s[:497] + "…"
    return s


# Matches ``q1``, ``q_2``, ``question3``, ``answer-4``, ``ans5`` etc.
# These are the shapes the canonical template uses for question names,
# so we rewrite them as "Question N" in the chat-facing label instead
# of surfacing the raw form-field name.
_Q_KEY_RE = re.compile(r"^(?:q|question|ans|answer)[_\-\s]*(\d+)$", re.IGNORECASE)


def _humanise_key(key: Any) -> str:
    """Turn a form-field name into a readable label.

    ``q1`` → ``Question 1``, ``capital_france`` → ``Capital France``,
    ``camelCaseKey`` → ``Camel Case Key``. All-caps tokens (``DNS``,
    ``HTTP``) are preserved as acronyms.
    """
    raw = str(key).strip()
    if not raw:
        return "Answer"
    m = _Q_KEY_RE.match(raw)
    if m:
        return f"Question {int(m.group(1))}"
    s = re.sub(r"[_\-]+", " ", raw)
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return raw
    words: list[str] = []
    for w in s.split(" "):
        if w.isupper() and len(w) > 1:
            words.append(w)
        else:
            words.append(w[:1].upper() + w[1:].lower() if w else w)
    return " ".join(words)


# ====================================================================
# Action payload parsing + dispatch
# ====================================================================
def parse_action_payload(raw: str) -> dict[str, Any] | None:
    """Parse the JSON body captured between action tags.

    Returns ``None`` when the body is malformed so the stream handler
    can keep running instead of crashing mid-token.
    """
    body = _strip_code_fences(raw.strip())
    try:
        obj = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def _strip_code_fences(body: str) -> str:
    """Strip markdown code fences the model sometimes wraps JSON in.

    Accepts ``` ```json\\n...\\n``` ```, ``` ```\\n...\\n``` ```, and
    returns the inner payload. Leaves unfenced input alone.
    """
    s = body.strip()
    if not s.startswith("```"):
        return body
    # Drop the opening fence line (``` or ```json).
    lines = s.splitlines()
    if len(lines) < 2:
        return body
    inner = "\n".join(lines[1:])
    if inner.rstrip().endswith("```"):
        inner = inner.rstrip()[: -3].rstrip()
    return inner


# Matches <title>...</title> in an HTML document. Used as a fallback
# when the model emits raw HTML between whiteboard_action tags and we
# need to derive the exercise's short label.
_TITLE_TAG_RE = re.compile(
    r"<title[^>]*>(?P<title>.*?)</title>", re.IGNORECASE | re.DOTALL
)


def parse_whiteboard_payload(body: str) -> dict[str, Any] | None:
    """Extract ``{type, title, html}`` from a ``<whiteboard_action>`` body.

    Supports two formats, trying them in order so it's robust to what
    the model actually produces:

    1. **Raw HTML** (preferred): the body is an HTML document
       ``<!DOCTYPE html>...``. Title is pulled from the ``<title>`` tag.
    2. **Legacy JSON envelope**: the body is ``{"type": "exercise",
       "title": "...", "html": "..."}``. JSON escaping is strict; a
       single unescaped ``"`` inside ``html`` makes this path fail,
       which is why format #1 exists.

    Returns ``None`` if neither format yields a usable HTML payload.
    """
    if not body or not body.strip():
        return None
    stripped = body.strip()
    stripped = _strip_code_fences(stripped)

    # --- Raw HTML path -------------------------------------------------
    lower_head = stripped[:200].lower().lstrip()
    looks_like_html = (
        lower_head.startswith("<!doctype")
        or lower_head.startswith("<html")
        or lower_head.startswith("<!--")
    )
    if looks_like_html:
        title_match = _TITLE_TAG_RE.search(stripped)
        title = title_match.group("title").strip() if title_match else None
        return {
            "type": "exercise",
            "title": title,
            "html": stripped,
        }

    # --- JSON envelope path -------------------------------------------
    if stripped.startswith("{"):
        obj = parse_action_payload(stripped)
        if obj is None:
            return None
        html = obj.get("html")
        if not isinstance(html, str) or not html.strip():
            return None
        title = obj.get("title")
        return {
            "type": str(obj.get("type") or "exercise").lower(),
            "title": str(title).strip() if isinstance(title, str) else None,
            "html": html,
        }

    # Could not recognise either format.
    return None


class MarkCompleteGateResult(TypedDict):
    """Outcome of the multi-condition ``mark_complete`` gate.

    Keys:
        passed: True when every condition held and the unit was
            actually flipped to ``completed``.
        unmet: Human-readable list of conditions that blocked the
            close. Surfaced back to the tutor as a synthetic user
            message so it can self-correct in the SAME conversation.
        score: The reported mastery score, clamped to 0-100.
    """

    passed: bool
    unmet: list[str]
    score: int


class CompletionReadiness(TypedDict):
    """Structured readiness report used by the readiness API.

    Mirrors the ``unmet`` strings produced by
    :func:`evaluate_completion_gate` but breaks every check out into
    a first-class boolean so the UI can render a progress checklist
    ("Teach-back ✓, confidence ⨯, 3/5 turns…") without string
    parsing. Always safe to compute — read-only, no writes.

    ``unmet`` is the same human-readable list the tutor self-correct
    message uses, so frontend and AI see identical prose.
    """

    ready: bool
    unmet: list[str]
    overall_score: int
    per_objective: list[dict[str, Any]]
    teachback_passed: bool
    confidence_captured: bool
    student_turn_count: int
    min_turns_required: int | None
    has_reflection: bool


async def evaluate_completion_gate(
    *,
    db: AsyncSession,
    unit: StudyUnit,
    session: StudySession | None,
    proposed_score: int | None = None,
    proposed_summary: str | None = None,
) -> CompletionReadiness:
    """Pure(-ish) multi-condition readiness check.

    Computes the exact set of ``unmet`` conditions the ``mark_complete``
    gate would flag right now, without mutating anything. Used by
    both:

    * the ``mark_complete`` action handler (authoritative gate that
      then performs the write), and
    * ``GET /study/sessions/{id}/completion-readiness`` (UI hint so
      the student sees why the unit isn't closable yet).

    The two callers pass different ``proposed_score`` values:

    * Action-handler path passes the score the tutor claims in the
      ``mark_complete`` payload — so a tutor that rushes with
      ``mastery_score=40`` trips the overall-floor check immediately.
    * Readiness-API path passes ``None`` — the overall-score gate is
      then evaluated against the current unit mastery average as a
      forecast ("if the tutor tried to close right now, this is
      what would happen").
    """
    unmet: list[str] = []

    # 1. Overall mastery floor (optional — skipped when the caller
    # hasn't proposed a score, so the readiness endpoint doesn't
    # spam "overall mastery is 0" before any objective has been
    # scored).
    if proposed_score is not None:
        if proposed_score < study_config.MASTERY_FLOOR:
            unmet.append(
                f"overall mastery is {proposed_score}/100, needs ≥ "
                f"{study_config.MASTERY_FLOOR} (keep teaching or re-assess)"
            )

    # 2. Per-objective floor.
    mastery_rows = await db.execute(
        select(StudyObjectiveMastery).where(StudyObjectiveMastery.unit_id == unit.id)
    )
    mastery_list = list(mastery_rows.scalars().all())
    mastery_by_idx = {r.objective_index: r for r in mastery_list}
    expected_objectives = list(unit.learning_objectives or [])
    per_objective: list[dict[str, Any]] = []
    for idx, text in enumerate(expected_objectives):
        row = mastery_by_idx.get(idx)
        if row is None:
            unmet.append(
                f"objective #{idx + 1} ({text[:60]}) has no mastery score yet — "
                "assess it then emit `update_objective_mastery`"
            )
            per_objective.append(
                {
                    "index": idx,
                    "text": text,
                    "score": None,
                    "meets_floor": False,
                }
            )
            continue
        meets = row.mastery_score >= study_config.PER_OBJECTIVE_FLOOR
        if not meets:
            unmet.append(
                f"objective #{idx + 1} mastery is {row.mastery_score}/100, "
                f"needs ≥ {study_config.PER_OBJECTIVE_FLOOR}"
            )
        per_objective.append(
            {
                "index": idx,
                "text": text,
                "score": row.mastery_score,
                "meets_floor": meets,
            }
        )

    teachback_ok = bool(session is not None and session.teachback_passed_at is not None)
    confidence_ok = bool(
        session is not None and session.confidence_captured_at is not None
    )
    turn_count = int(session.student_turn_count) if session is not None else 0
    min_turns = session.min_turns_required if session is not None else None

    # 3. Teach-back.
    if session is not None and not teachback_ok:
        unmet.append(
            "teach-back hasn't been recorded — ask the student to explain "
            "the unit in their own words then emit `teachback_passed`"
        )

    # 4. Confidence capture.
    if session is not None and not confidence_ok:
        unmet.append(
            "confidence rating hasn't been captured — ask for a 1-5 number "
            "then emit `capture_confidence`"
        )

    # 5. Minimum student turns.
    if (
        session is not None
        and min_turns is not None
        and turn_count < min_turns
    ):
        unmet.append(
            f"student has sent {turn_count} turns; "
            f"unit requires at least {min_turns} before completion"
        )

    # 6. Reflection presence — readiness-check version. The
    # write-path in ``handle_unit_action`` will auto-stub from the
    # ``mark_complete`` summary when available; here we only report
    # whether a row already exists so the UI can show "summary
    # recorded ✓".
    reflection_stmt = select(StudyUnitReflection).where(
        StudyUnitReflection.unit_id == unit.id
    )
    has_reflection = (
        await db.execute(reflection_stmt)
    ).scalars().first() is not None
    has_usable_summary = bool(
        has_reflection or (proposed_summary and proposed_summary.strip())
    )
    if not has_usable_summary:
        unmet.append(
            "unit reflection hasn't been written — emit `summarise_unit` "
            "with 2-3 sentence recap before `mark_complete`"
        )

    overall_score = proposed_score
    if overall_score is None:
        overall_score = (
            int(round(sum(r.mastery_score for r in mastery_list) / len(mastery_list)))
            if mastery_list
            else 0
        )

    return CompletionReadiness(
        ready=not unmet,
        unmet=unmet,
        overall_score=overall_score,
        per_objective=per_objective,
        teachback_passed=teachback_ok,
        confidence_captured=confidence_ok,
        student_turn_count=turn_count,
        min_turns_required=min_turns,
        has_reflection=has_reflection,
    )


async def handle_unit_action(
    *,
    db: AsyncSession,
    project: StudyProject,
    unit: StudyUnit,
    session: StudySession | None,
    payload: dict[str, Any],
) -> MarkCompleteGateResult | bool:
    """Apply a ``<unit_action>`` payload to a unit.

    For ``mark_complete`` we run the multi-condition gate introduced
    by the Study 10/10 plan and return a
    :class:`MarkCompleteGateResult` either way so the caller can feed
    the ``unmet`` list back to the tutor. Any other action type
    returns ``False`` (caller ignores).
    """
    action_type = str(payload.get("type", "")).lower()
    if action_type != "mark_complete":
        return False

    raw_score = payload.get("mastery_score")
    try:
        score = int(raw_score) if raw_score is not None else 0
    except (TypeError, ValueError):
        score = 0
    score = max(0, min(100, score))

    summary_text = str(payload.get("summary") or "").strip()[:2000]

    readiness = await evaluate_completion_gate(
        db=db,
        unit=unit,
        session=session,
        proposed_score=score,
        proposed_summary=summary_text,
    )

    # The write-path still auto-stubs a reflection when the tutor
    # supplied a summary on the mark_complete but no dedicated
    # ``summarise_unit`` action fired earlier. The readiness check
    # only reports presence — this is where the stub actually lands.
    if summary_text and not readiness["has_reflection"]:
        db.add(
            StudyUnitReflection(
                unit_id=unit.id,
                session_id=session.id if session else None,
                summary=summary_text,
                objectives_summary={},
                concepts_anchored=[],
            )
        )

    if not readiness["ready"]:
        return MarkCompleteGateResult(
            passed=False, unmet=list(readiness["unmet"]), score=score
        )

    summary = summary_text or None

    now = datetime.now(timezone.utc)
    unit.status = "completed"
    unit.mastery_score = score
    unit.mastery_summary = summary
    unit.completed_at = now
    unit.last_studied_at = now
    unit.updated_at = now
    # Clear the retry focus now that the unit is re-mastered.
    unit.exam_focus = None
    return MarkCompleteGateResult(passed=True, unmet=[], score=score)


# ====================================================================
# Study-10/10 action handlers — profile, mastery, misconceptions,
# teach-back, confidence, unit reflection.
# ====================================================================
async def handle_save_learner_profile(
    *, db: AsyncSession, project: StudyProject, payload: dict[str, Any]
) -> bool:
    """Merge the tutor's ``save_learner_profile`` payload into the project.

    Additive merge — scalar fields overwrite only when the payload
    provides a non-empty value; list fields are unioned (dedup while
    preserving order); ``free_form`` is shallow-merged. This lets the
    tutor refine the profile over multiple turns without ever
    accidentally deleting context the student told us earlier.
    """
    incoming = payload.get("profile")
    if not isinstance(incoming, dict):
        return False

    current: dict[str, Any] = dict(project.learner_profile or {})
    changed = False

    scalar_keys = ("occupation", "background")
    for key in scalar_keys:
        val = incoming.get(key)
        if isinstance(val, str) and val.strip():
            if current.get(key) != val.strip():
                current[key] = val.strip()
                changed = True

    list_keys = ("interests", "goals", "preferred_examples_from")
    for key in list_keys:
        val = incoming.get(key)
        if isinstance(val, list):
            cleaned = [str(x).strip() for x in val if str(x).strip()]
            if not cleaned:
                continue
            existing = [str(x) for x in (current.get(key) or [])]
            merged: list[str] = list(existing)
            for item in cleaned:
                if item not in merged:
                    merged.append(item)
            if merged != existing:
                current[key] = merged
                changed = True

    free_form = incoming.get("free_form")
    if isinstance(free_form, dict) and free_form:
        existing_ff = dict(current.get("free_form") or {})
        existing_ff.update({str(k): v for k, v in free_form.items()})
        current["free_form"] = existing_ff
        changed = True

    if not changed:
        return False

    project.learner_profile = current
    project.learner_profile_updated_at = datetime.now(timezone.utc)
    project.updated_at = datetime.now(timezone.utc)
    return True


async def handle_update_objective_mastery(
    *,
    db: AsyncSession,
    project: StudyProject,
    unit: StudyUnit,
    payload: dict[str, Any],
    session: StudySession | None = None,
) -> bool:
    """Apply an ``update_objective_mastery`` payload.

    Writes the new mastery score, advances the SM-2-lite schedule,
    and nudges the unit-level ``mastery_score`` to the average of the
    unit's objective rows so the existing UI still reflects progress.

    Also: if the session currently has a ``current_review_focus_
    objective_id`` and the scored objective matches, the focus is
    auto-cleared — this is the sticky-until-satisfied contract for
    the deep-linked review flow (see the 0034 migration).
    """
    raw_idx = payload.get("objective_index")
    try:
        idx = int(raw_idx)
    except (TypeError, ValueError):
        return False
    objectives = unit.learning_objectives or []
    if idx < 0 or idx >= len(objectives):
        return False

    raw_score = payload.get("score")
    try:
        score = int(raw_score)
    except (TypeError, ValueError):
        return False
    score = max(0, min(100, score))

    row_stmt = select(StudyObjectiveMastery).where(
        StudyObjectiveMastery.unit_id == unit.id,
        StudyObjectiveMastery.objective_index == idx,
    )
    row = (await db.execute(row_stmt)).scalar_one_or_none()
    if row is None:
        row = StudyObjectiveMastery(
            project_id=project.id,
            unit_id=unit.id,
            objective_index=idx,
            objective_text=objectives[idx],
            mastery_score=score,
            ease_factor=study_config.DEFAULT_EASE_FACTOR,
            interval_days=0,
            review_count=0,
            consecutive_failures=0,
        )
        db.add(row)
        await db.flush()

    success = score >= study_config.REVIEW_PASS_SCORE
    study_review.schedule_next_review(row, success=success, score=score)

    # Refresh the unit-level average so the existing ring/progress bars
    # still tell the truth.
    all_rows_stmt = select(StudyObjectiveMastery).where(
        StudyObjectiveMastery.unit_id == unit.id
    )
    all_rows = list((await db.execute(all_rows_stmt)).scalars().all())
    if all_rows:
        avg = int(round(sum(r.mastery_score for r in all_rows) / len(all_rows)))
        unit.mastery_score = max(unit.mastery_score or 0, avg) if unit.status == "completed" else avg
        unit.last_studied_at = datetime.now(timezone.utc)
        unit.updated_at = datetime.now(timezone.utc)

    # Auto-clear the review focus the moment its target objective
    # gets a fresh score. Cheap equality-on-id is fine because the
    # focus is always a row for the current session's unit (enforced
    # at stamp time); we still guard on objective_index for safety
    # when the column points at a row from an earlier unit.
    if (
        session is not None
        and session.current_review_focus_objective_id is not None
        and row.id == session.current_review_focus_objective_id
    ):
        session.current_review_focus_objective_id = None

    return True


async def handle_log_misconception(
    *,
    db: AsyncSession,
    project: StudyProject,
    unit: StudyUnit,
    payload: dict[str, Any],
) -> bool:
    """Record or re-stamp a misconception.

    If a row already exists with the same ``description`` (case-
    insensitive exact match) on this project, we bump ``times_seen``
    and ``last_seen_at`` rather than inserting a duplicate. This
    matches the plan's intent: the catalog should show recurring
    patterns, not every variant phrasing the tutor dreams up.
    """
    description = str(payload.get("description") or "").strip()
    correction = str(payload.get("correction") or "").strip()
    if not description or not correction:
        return False

    now = datetime.now(timezone.utc)
    existing_stmt = select(StudyMisconception).where(
        StudyMisconception.project_id == project.id,
        func.lower(StudyMisconception.description) == description.lower(),
        StudyMisconception.resolved_at.is_(None),
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing is not None:
        existing.times_seen = (existing.times_seen or 1) + 1
        existing.last_seen_at = now
        if correction and existing.correction != correction:
            existing.correction = correction[:2000]
        return True

    raw_idx = payload.get("objective_index")
    try:
        idx: int | None = int(raw_idx) if raw_idx is not None else None
    except (TypeError, ValueError):
        idx = None

    db.add(
        StudyMisconception(
            project_id=project.id,
            unit_id=unit.id,
            objective_index=idx,
            description=description[:2000],
            correction=correction[:2000],
            first_seen_at=now,
            last_seen_at=now,
            times_seen=1,
        )
    )
    return True


async def handle_resolve_misconception(
    *, db: AsyncSession, project: StudyProject, payload: dict[str, Any]
) -> bool:
    """Mark a previously-logged misconception as resolved.

    Accepts either ``misconception_id`` (preferred — the tutor gets
    the id from the "Known misconceptions" prompt block) or
    ``description`` as a fallback so the tutor can still resolve by
    exact-match description if it forgot to cite the id.
    """
    raw_id = payload.get("misconception_id")
    target: StudyMisconception | None = None
    if isinstance(raw_id, str):
        try:
            target_id = uuid.UUID(raw_id.strip())
        except (ValueError, TypeError):
            target_id = None
        if target_id is not None:
            stmt = select(StudyMisconception).where(
                StudyMisconception.project_id == project.id,
                StudyMisconception.id == target_id,
                StudyMisconception.resolved_at.is_(None),
            )
            target = (await db.execute(stmt)).scalar_one_or_none()
    if target is None:
        description = str(payload.get("description") or "").strip()
        if description:
            stmt = select(StudyMisconception).where(
                StudyMisconception.project_id == project.id,
                func.lower(StudyMisconception.description) == description.lower(),
                StudyMisconception.resolved_at.is_(None),
            )
            target = (await db.execute(stmt)).scalar_one_or_none()

    if target is None:
        return False
    target.resolved_at = datetime.now(timezone.utc)
    return True


async def handle_teachback_passed(
    *, db: AsyncSession, session: StudySession, payload: dict[str, Any]
) -> bool:
    """Stamp ``teachback_passed_at`` on the session.

    The actual paraphrase is dropped on the floor for now — it's
    already visible in the chat transcript, and persisting a duplicate
    copy would just bloat the session row. If we later want to query
    for it we can stamp into ``objectives_summary`` on the reflection
    row instead.
    """
    if session.teachback_passed_at is not None:
        return False
    session.teachback_passed_at = datetime.now(timezone.utc)
    session.updated_at = datetime.now(timezone.utc)
    _ = payload  # reserved for future use
    return True


async def handle_capture_confidence(
    *, db: AsyncSession, session: StudySession, payload: dict[str, Any]
) -> bool:
    """Record a 1-5 confidence rating on the current session.

    Idempotent w.r.t. "is the gate satisfied?" — the gate only needs
    ONE confidence capture, so re-emitting just refreshes the
    timestamp. A future analytics job can trawl the message stream
    for the actual ratings over time.
    """
    raw_level = payload.get("level")
    try:
        level = int(raw_level)
    except (TypeError, ValueError):
        return False
    if level < 1 or level > 5:
        return False
    session.confidence_captured_at = datetime.now(timezone.utc)
    session.updated_at = datetime.now(timezone.utc)
    _ = payload
    return True


async def handle_summarise_unit(
    *,
    db: AsyncSession,
    unit: StudyUnit,
    session: StudySession | None,
    payload: dict[str, Any],
) -> bool:
    """Persist a ``summarise_unit`` payload as a ``StudyUnitReflection`` row.

    One row per ``(unit, session)`` pair — re-emitting within the
    same session updates the existing row instead of piling up
    duplicates, which matters because the unit-completion gate only
    checks for *existence* of a reflection.
    """
    summary = str(payload.get("summary") or "").strip()
    if not summary:
        return False

    objectives_summary_raw = payload.get("objectives_summary")
    objectives_summary: dict[str, Any] = {}
    if isinstance(objectives_summary_raw, dict):
        for k, v in objectives_summary_raw.items():
            if isinstance(v, (str, int, float, bool)):
                objectives_summary[str(k)] = str(v)[:400]

    concepts_raw = payload.get("concepts_anchored")
    anchors: list[str] = []
    if isinstance(concepts_raw, list):
        for c in concepts_raw[:8]:
            text = str(c).strip()
            if text:
                anchors.append(text[:200])

    now = datetime.now(timezone.utc)
    existing_stmt = select(StudyUnitReflection).where(
        StudyUnitReflection.unit_id == unit.id,
        StudyUnitReflection.session_id == (session.id if session else None),
    )
    existing = (await db.execute(existing_stmt)).scalar_one_or_none()
    if existing is not None:
        existing.summary = summary[:4000]
        if objectives_summary:
            existing.objectives_summary = objectives_summary
        if anchors:
            existing.concepts_anchored = anchors
        return True

    db.add(
        StudyUnitReflection(
            unit_id=unit.id,
            session_id=session.id if session else None,
            summary=summary[:4000],
            objectives_summary=objectives_summary,
            concepts_anchored=anchors,
            created_at=now,
        )
    )
    return True


# Hard caps for the Phase-2 "insert prerequisites" action so a confused
# tutor can't balloon the plan into uselessness.
_MAX_PREREQ_INSERT_PER_CALL = 5
_MAX_UNITS_PER_PROJECT = 25


async def handle_set_calibrated(
    *,
    db: AsyncSession,
    project: StudyProject,
    payload: dict[str, Any],
) -> bool:
    """Mark the project as calibrated without inserting new units.

    Used by the Phase-3 Unit-1 diagnostic when the tutor decides the
    student's self-reported level actually matches reality — so we
    don't need foundation units AND the diagnostic doesn't need to
    run again next time. Returns True if a state change was applied.
    """
    if project.calibrated:
        return False
    project.calibrated = True
    # Only stamp the source on the FIRST calibration flip. The column
    # is deliberately write-once so we can tell skip vs. tutor-driven
    # later when the honesty nudge fires.
    if project.calibration_source is None:
        project.calibration_source = "tutor_set"
    project.updated_at = datetime.now(timezone.utc)
    # ``payload`` is unused for now but kept in the signature so we
    # can plumb a tutor-supplied summary through later without a
    # signature change.
    _ = payload
    return True


async def handle_insert_prerequisites(
    *,
    db: AsyncSession,
    project: StudyProject,
    before_unit: StudyUnit,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    """Insert AI-proposed prerequisite units BEFORE ``before_unit``.

    This is how the tutor can react to a knowledge gap mid-session:
    it emits a ``<unit_action>`` whose ``type`` is
    ``insert_prerequisites`` and lists 1-5 short bridge units. Those
    rows are spliced into the plan right before the unit the student
    is currently sitting in, carrying the ``inserted_as_prereq`` flag
    so the UI can tag them. We deliberately do NOT auto-navigate the
    student — they see a banner, finish their sentence, and pick
    whichever unit they want next.

    Returns a list of small dicts describing the inserted units
    (id, title, order_index) so the SSE generator can push a
    ``units_inserted`` event. Returns an empty list when nothing was
    applied (validation failure, caps hit, completed unit, etc).
    """
    # No point "prepping" for a unit they already finished.
    if before_unit.status == "completed":
        return []

    raw_units = payload.get("units")
    if not isinstance(raw_units, list) or not raw_units:
        return []

    cleaned: list[dict[str, Any]] = []
    for raw in raw_units[:_MAX_PREREQ_INSERT_PER_CALL]:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()[:255]
        if not title:
            continue
        description = str(raw.get("description") or "").strip()[:4000]
        objectives_raw = raw.get("learning_objectives") or []
        objectives: list[str] = []
        if isinstance(objectives_raw, list):
            for obj in objectives_raw[:10]:
                if isinstance(obj, str):
                    text = obj.strip()
                    if text:
                        objectives.append(text[:500])
        cleaned.append(
            {
                "title": title,
                "description": description,
                "learning_objectives": objectives,
            }
        )
    if not cleaned:
        return []

    # Enforce the project-wide unit cap.
    existing_count_row = await db.execute(
        select(func.count(StudyUnit.id)).where(StudyUnit.project_id == project.id)
    )
    existing_count = int(existing_count_row.scalar_one() or 0)
    remaining_slots = _MAX_UNITS_PER_PROJECT - existing_count
    if remaining_slots <= 0:
        return []
    cleaned = cleaned[:remaining_slots]
    insert_count = len(cleaned)

    # Snapshot the target order before we shift — ``before_unit`` is a
    # tracked ORM instance, so a bulk UPDATE would make its in-memory
    # ``order_index`` stale. Easier to just remember the slot here.
    target_slot = before_unit.order_index

    # Shift every unit at target_slot or later by ``insert_count``. We
    # run the UPDATE with ``synchronize_session="fetch"`` so ORM-
    # tracked instances (including ``before_unit``) get their in-memory
    # ``order_index`` refreshed too.
    await db.execute(
        update(StudyUnit)
        .where(
            StudyUnit.project_id == project.id,
            StudyUnit.order_index >= target_slot,
        )
        .values(order_index=StudyUnit.order_index + insert_count)
        .execution_options(synchronize_session="fetch")
    )
    await db.flush()

    # One shared batch id per tutor reply so the topic page can group
    # everything inserted in this call into a single dismissible
    # banner. The ``reason`` field is free-form text that the tutor
    # wrote to explain the insert; we clip it so an overzealous model
    # can't blow out the column.
    batch_id = uuid.uuid4()
    reason_raw = payload.get("reason")
    reason = (
        str(reason_raw).strip()[:600]
        if isinstance(reason_raw, str) and reason_raw.strip()
        else None
    )

    now = datetime.now(timezone.utc)
    inserted_rows: list[StudyUnit] = []
    for i, row in enumerate(cleaned):
        new_unit = StudyUnit(
            project_id=project.id,
            order_index=target_slot + i,
            title=row["title"],
            description=row["description"] or "",
            learning_objectives=row["learning_objectives"],
            status="not_started",
            inserted_as_prereq=True,
            prereq_reason=reason,
            prereq_batch_id=batch_id,
        )
        db.add(new_unit)
        inserted_rows.append(new_unit)
    await db.flush()

    # Inserting prerequisite units is itself calibration feedback —
    # the tutor just told us the plan's starting assumptions were
    # wrong for this student. So we always flip ``calibrated`` on
    # insert, regardless of whether the model remembered to pass
    # ``mark_calibrated: true``. The flag is kept as a harmless
    # explicit signal for backwards-compat. Once calibrated, the
    # Unit-1 diagnostic block stops being injected into the system
    # prompt and the skip banner disappears on revisit.
    project.calibrated = True
    # Don't overwrite an existing source — if the student clicked
    # "Skip diagnostic" first and the tutor later hit an insert, we
    # want the source to stay "skipped" so the honesty nudge fires.
    if project.calibration_source is None:
        project.calibration_source = "tutor_insert"

    project.updated_at = now

    return [
        {
            "id": str(u.id),
            "title": u.title,
            "order_index": u.order_index,
            "inserted_as_prereq": u.inserted_as_prereq,
            "prereq_reason": u.prereq_reason,
            "prereq_batch_id": str(u.prereq_batch_id) if u.prereq_batch_id else None,
        }
        for u in inserted_rows
    ]


async def handle_exam_action(
    *,
    db: AsyncSession,
    project: StudyProject,
    exam: StudyExam,
    payload: dict[str, Any],
) -> bool:
    """Apply an ``<exam_action>`` payload to an exam. Returns True if applied."""
    action_type = str(payload.get("type", "")).lower()
    if action_type != "grade":
        return False
    if exam.status in ("passed", "failed"):
        # Already graded — don't double-apply.
        return False

    raw_score = payload.get("score")
    try:
        score = int(raw_score) if raw_score is not None else 0
    except (TypeError, ValueError):
        score = 0
    score = max(0, min(100, score))

    passed = bool(payload.get("passed", score >= 70))
    summary = str(payload.get("summary") or "").strip()[:4000] or None

    weak_ids = _coerce_uuid_list(payload.get("weak_unit_ids"))
    strong_ids = _coerce_uuid_list(payload.get("strong_unit_ids"))
    unit_notes = _coerce_unit_notes(payload.get("unit_notes"))

    now = datetime.now(timezone.utc)
    exam.status = "passed" if passed else "failed"
    exam.passed = passed
    exam.score = score
    exam.summary = summary
    exam.weak_unit_ids = weak_ids or None
    exam.strong_unit_ids = strong_ids or None
    exam.unit_notes = unit_notes or None
    exam.ended_at = now
    exam.updated_at = now

    # Update the project + affected units.
    if passed:
        project.status = "completed"
    else:
        project.status = "active"
        # Re-open weak units for targeted re-study.
        if weak_ids:
            rows = await db.execute(
                select(StudyUnit).where(
                    StudyUnit.project_id == project.id,
                    StudyUnit.id.in_(weak_ids),
                )
            )
            exam_summary = summary or "Revisit this unit — the final exam showed gaps."
            for u in rows.scalars().all():
                u.status = "in_progress"
                u.completed_at = None
                # Keep their last mastery score but nudge it down so the
                # UI's progress bar reflects the regression.
                if u.mastery_score is not None:
                    u.mastery_score = min(u.mastery_score, 60)
                u.exam_focus = exam_summary
                u.updated_at = now

    project.updated_at = now
    return True


def _coerce_uuid_list(value: Any) -> list[uuid.UUID]:
    """Best-effort convert a JSON list of maybe-UUID strings into UUIDs."""
    if not isinstance(value, list):
        return []
    out: list[uuid.UUID] = []
    for item in value:
        if isinstance(item, uuid.UUID):
            out.append(item)
        elif isinstance(item, str):
            try:
                out.append(uuid.UUID(item.strip()))
            except (ValueError, TypeError):
                continue
    return out


# Max characters we retain per unit note so a verbose grader can't
# blow the JSONB column up. 400 chars is comfortably enough for two
# short sentences.
_UNIT_NOTE_MAX_CHARS = 400


def _coerce_unit_notes(value: Any) -> dict[str, str]:
    """Normalise the ``unit_notes`` grader payload into a safe dict.

    Drops any key that isn't a valid UUID string and any value that
    isn't a non-empty string. Returns a plain ``dict[str, str]`` keyed
    by the stringified UUID so the JSONB column is easy to consume
    from the UI without any client-side UUID gymnastics.
    """
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for raw_key, raw_value in value.items():
        if not isinstance(raw_key, str) or not isinstance(raw_value, str):
            continue
        try:
            key = str(uuid.UUID(raw_key.strip()))
        except (ValueError, TypeError):
            continue
        note = raw_value.strip()
        if not note:
            continue
        out[key] = note[:_UNIT_NOTE_MAX_CHARS]
    return out


# ====================================================================
# Capture dispatcher — called from the SSE stream loop
# ====================================================================
async def apply_captures(
    *,
    db: AsyncSession,
    captures: list[Capture],
    project: StudyProject,
    unit: StudyUnit | None,
    session: StudySession | None,
    exam: StudyExam | None,
) -> dict[str, Any]:
    """Apply any non-whiteboard captures a parser yielded mid-stream.

    Returns a dict describing what was applied so the SSE generator
    can emit follow-up events (``unit_completed``, ``exam_graded``).
    Whiteboard captures are handled separately by the caller because
    they need DB flushing tied to the assistant-message row.
    """
    result: dict[str, Any] = {
        "unit_completed": False,
        "exam_applied": False,
        "units_inserted": [],
        "reason": None,
        "project_calibrated": False,
        # One-shot Phase-6 honesty nudge. Set to a payload dict when
        # the tutor inserts prereqs on a project whose calibration
        # came from a SKIP. Stream generator emits a
        # ``calibration_warning`` SSE event and stamps
        # ``calibration_warning_sent_at`` so it fires at most once.
        "calibration_warning": None,
        # When the tutor emits ``mark_complete`` but the server gate
        # rejects it, this holds the list of unmet conditions. The SSE
        # generator appends a synthetic system message to the transcript
        # so the tutor can self-correct on the next turn.
        "mark_complete_rejected": None,
        # Durable-state side-effects — set by the respective handlers
        # so the frontend can invalidate the right caches after the
        # stream finishes.
        "learner_profile_updated": False,
        "mastery_updated": False,
        "misconceptions_changed": False,
        "reflection_written": False,
    }
    for cap in captures:
        payload = parse_action_payload(cap.body)
        if payload is None:
            continue
        if cap.tag == "unit_action" and unit is not None:
            action_type = str(payload.get("type", "")).lower()
            if action_type == "insert_prerequisites":
                # Capture the pre-insert calibration source so we can
                # tell "user skipped" from "tutor already set" after
                # the handler flips the project forward.
                pre_source = project.calibration_source
                pre_warned = project.calibration_warning_sent_at is not None
                inserted = await handle_insert_prerequisites(
                    db=db, project=project, before_unit=unit, payload=payload
                )
                if inserted:
                    result["units_inserted"].extend(inserted)
                    reason = str(payload.get("reason") or "").strip()[:500]
                    if reason and not result["reason"]:
                        result["reason"] = reason
                    # The handler now always flips ``calibrated`` when
                    # an insert succeeds (see comment in
                    # handle_insert_prerequisites). Surface that so the
                    # SSE layer can emit a project_calibrated event
                    # and the skip banner disappears live.
                    result["project_calibrated"] = True
                    # Honesty nudge: if the student skipped the warm-up
                    # and the tutor JUST found a real gap, surface
                    # exactly one banner about it. Gated by the
                    # one-shot timestamp so repeated inserts don't
                    # re-fire the nudge.
                    if pre_source == "skipped" and not pre_warned:
                        project.calibration_warning_sent_at = datetime.now(
                            timezone.utc
                        )
                        batch = inserted[0].get("prereq_batch_id")
                        result["calibration_warning"] = {
                            "reason": result["reason"],
                            "batch_id": batch,
                        }
                continue
            if action_type == "set_calibrated":
                if await handle_set_calibrated(db=db, project=project, payload=payload):
                    result["project_calibrated"] = True
                continue
            if action_type == "save_learner_profile":
                if await handle_save_learner_profile(
                    db=db, project=project, payload=payload
                ):
                    result["learner_profile_updated"] = True
                continue
            if action_type == "update_objective_mastery":
                if await handle_update_objective_mastery(
                    db=db,
                    project=project,
                    unit=unit,
                    payload=payload,
                    session=session,
                ):
                    result["mastery_updated"] = True
                continue
            if action_type == "log_misconception":
                if await handle_log_misconception(
                    db=db, project=project, unit=unit, payload=payload
                ):
                    result["misconceptions_changed"] = True
                continue
            if action_type == "resolve_misconception":
                if await handle_resolve_misconception(
                    db=db, project=project, payload=payload
                ):
                    result["misconceptions_changed"] = True
                continue
            if action_type == "teachback_passed" and session is not None:
                await handle_teachback_passed(
                    db=db, session=session, payload=payload
                )
                continue
            if action_type == "capture_confidence" and session is not None:
                await handle_capture_confidence(
                    db=db, session=session, payload=payload
                )
                continue
            if action_type == "summarise_unit":
                if await handle_summarise_unit(
                    db=db, unit=unit, session=session, payload=payload
                ):
                    result["reflection_written"] = True
                continue
            if action_type == "mark_complete":
                gate = await handle_unit_action(
                    db=db,
                    project=project,
                    unit=unit,
                    session=session,
                    payload=payload,
                )
                if isinstance(gate, dict):
                    if gate["passed"]:
                        result["unit_completed"] = True
                    else:
                        result["mark_complete_rejected"] = gate
                continue
        elif cap.tag == "exam_action" and exam is not None:
            applied = await handle_exam_action(
                db=db, project=project, exam=exam, payload=payload
            )
            if applied:
                result["exam_applied"] = True
                result["exam_passed"] = bool(exam.passed)
                result["exam_score"] = exam.score
    return result
