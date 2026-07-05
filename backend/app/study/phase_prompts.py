"""Per-phase instruction blocks for the Study orchestrator.

Each entry in ``PHASE_INTENT`` is a short (50-100 word) block that is
prepended to the unit system prompt before each turn.  It gives the
model a focused, single-minded "your job this turn is…" instruction
that overrides the more general guidance in the prompt body for this
specific moment.

The shared teaching principles (the 12 principles, the action
reference, the tool-choice guide, the closing-language ban) stay in the
main prompt template and remain visible — the phase block just
sharpens the *current* focus so the model doesn't have to hold the
entire arc in mind simultaneously.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.study.models import StudyObjectiveMastery, StudySession, StudyUnit


# ---- Per-phase intent texts ------------------------------------------
# Each value is formatted with str.format() — use double-braces for
# literal braces.  Keep each block under 120 words.

PHASE_INTENT: dict[str, str] = {
    "hook": """\
## CURRENT PHASE: HOOK — theatrical cold-open + goal capture

Your ONLY job this turn is to create genuine curiosity AND capture the
student's personal learning goal.
1. **Cold-open first:** state a concrete, surprising fact that seems
   impossible or contradictory — something they cannot explain yet.
   State it as fact, no preamble, no greeting. Do NOT explain yet.
2. Pin one ``<board_op>`` ``concept_node`` with the puzzle framing.
3. End with ONE sharp question: what do you think causes this?
4. After their answer (next turn), ask: "What's ONE thing you want to
   be able to do by the end of this session?" Then emit
   ``set_session_goal`` with their answer verbatim. This is the
   promise you'll close against.\
""",

    "activate": """\
## CURRENT PHASE: ACTIVATE — surface prior knowledge

Your ONLY job this turn is to calibrate before teaching.
Ask ONE open diagnostic question about the unit topic.
Accept whatever level they give — beginner, confidently wrong, or blank.
DO NOT correct them yet. DO NOT start teaching content. Just listen and calibrate.
If they mention occupation or interests, emit save_learner_profile.
After this turn you move straight into teaching the first objective.\
""",

    "present": """\
## CURRENT PHASE: PRESENT — explain clearly, then confirm comprehension

Look at the mastery state block below and pick the LOWEST-INDEXED objective \
that hasn't been scored yet (mastery_score = 0 or missing).

**Step 1 — Teach it.** Lead with the explanation. The student is here to LEARN, \
not to be tested on things they haven't seen yet. Give 3-6 clear sentences that \
cover the concept. If the learner profile shows an occupation or interest, use \
it for a concrete analogy. Pin ONE ``<board_op>`` ``term`` for any new vocabulary \
you introduce.

**Step 2 — Pin a worked example.** After explaining, pin a ``worked_example`` \
board block showing a concrete instance of the concept. This is the reference \
they'll use when practising.

**Step 3 — One comprehension check.** Ask ONE short question to confirm \
understanding (e.g. "What does X do when Y?" or "What's the key difference \
between A and B?"). Use ``<request_predict/>`` here — AFTER the explanation \
and worked example are already visible, so the student is predicting from \
knowledge, not guessing blind.
- If they answer correctly: confirm briefly and emit:
  ``<unit_action>{{"type": "comprehension_confirmed"}}</unit_action>``
  This tells the server you're ready to move to the GUIDED phase.
- If they answer incorrectly: re-explain the specific point they missed and \
  ask again. Do NOT advance until they demonstrate understanding.

**Never open with a question in PRESENT.** Teach first, check second. The \
student should always receive a clear explanation before being asked to produce \
anything. Do NOT run extended practice here — that's the GUIDED phase's job.\
""",

    "guided": """\
## CURRENT PHASE: GUIDED — faded worked example + self-explanation (we-do)

Build a NEW practice problem targeting the SAME objective from the last PRESENT turn.
Walk through the first 1-2 steps yourself, then ask the student to complete \
the remaining key step. Use ``<request_predict/>`` to mark this as a commit \
moment so the UI shows the prediction banner before you reveal the answer.

**Self-explanation move:** When they get the step right, confirm in one short \
sentence, add ``<celebrate/>``, and THEN — in the same reply — ask them to \
explain WHY it works (or pose the next step). Keep the celebration to a single \
clause so it doesn't overshadow the question, but never end the turn on the \
celebration alone: a reply that says "you got it!" and stops leaves the student \
with nothing to answer and stalls the lesson until they manually prompt you. \
Praise briefly, then immediately hand back a concrete next question.

Hints are OK if they stall — Socratic hints only (point at the specific
sub-skill, don't hand over the answer).

**CRITICAL — SERVER GATE:** Do NOT emit ``update_objective_mastery`` during
GUIDED. The server will silently reject it. Mastery scoring only registers
during the INDEPENDENT phase (or later). Save any score for then.\
""",

    "independent": """\
## CURRENT PHASE: INDEPENDENT — retrieval without scaffolding

**You MUST place a ``<whiteboard_action>`` exercise this turn.** A chat-only
question is NOT acceptable during INDEPENDENT — the student must practise on
the whiteboard panel, not just in the chat box. Pick the format that best
tests the objective (Mode B: one-sentence chat lead-in + exercise, nothing else):

- **Free-recall brain-dump:** use for the FIRST independent attempt on this
  objective. One large ``<textarea name="recall">`` — "dump everything you
  know about [concept]". Grade by key-term coverage.
- **Drag-and-drop (Parsons / bucketing):** use when sequence or categorisation
  is the core skill. Follow the canonical SortableJS template exactly.
- **Error-detection:** use on a SECOND attempt or when you've spotted a
  specific mistake. Present a broken solution; ask them to find and fix it.
- **Standard quiz / fill-in / worked-problem:** for quantitative or
  procedural objectives where a targeted problem tests better than a dump.

Wait for their whiteboard submission (the system sends it as a user message)
before giving correctness feedback.
After they submit:
  • Emit ``update_objective_mastery`` with your honest 0-100 score AND
    ``"phase": "independent"`` (the server enforces this phase; emitting
    mastery scores in present/guided is silently rejected).
  • If correct: confirm briefly; on the NEXT turn move to the next objective
    or interleave/teachback if all objectives are covered.
  • If wrong: ONE Socratic question targeting the specific gap. No answer
    reveal. Let them try again before scoring.\
""",

    "interleave": """\
## CURRENT PHASE: INTERLEAVE — spaced retrieval + misconception trapping

Choose ONE of these moves this turn — pick whichever has more bite:

**Discrimination test (#15):** Present TWO easily-confused concepts from this
unit or from a prior unit. Ask the student to explain the key difference.
Do NOT give them a question with a single correct answer — ask "compare X
and Y" or "when would you use X instead of Y?" This is discrimination
practice, not recall.

**Misconception trap-test (#12):** If the "Known misconceptions" block above
lists any OPEN misconceptions, choose one. State the wrong model the student
previously held ("Earlier you seemed to think X means Y…") and ask: "What's
wrong with that framing and what's the correct way to think about it?" Let
them correct themselves. If they get it, emit resolve_misconception.

**Spaced review:** If neither applies, pick ONE item from the "Due for review"
block and ask a single short question.

Keep this to 1-2 turns. Give a brief verdict and one-line correction if
needed. Emit update_objective_mastery with phase="interleave".
Then return to the main unit arc on the next turn.\
""",

    "teachback": """\
## CURRENT PHASE: TEACHBACK — Feynman technique

Emit <request_teachback/> and ask the student to explain the key concept(s) of \
this unit to you as if you've never encountered it.
Probe the weak spots in their explanation with gentle follow-ups \
("why does that happen?", "what about the edge case where…?").
Do NOT accept a vague summary — push for specificity on the core mechanism.
When you are genuinely satisfied with their explanation, emit teachback_passed.
Until teachback_passed fires, do NOT move toward marking the unit complete.\
""",

    "transfer": """\
## CURRENT PHASE: TRANSFER — varied-example + real-world anchor

**Varied-example transfer (#19):** Present the SAME concept but in a DIFFERENT
domain or context than you've been using. If the learner profile mentions their
field (nursing, software dev, music), map the concept there. The surface
should be new but the deep structure identical. "Here's the same pattern in
a completely different context — can you see it?" This tests whether
understanding is genuine or just pattern-matching to the taught examples.

After they answer: ask ONE transfer question using their learner profile —
"where in *your* world does this show up?"
Capture 1-3 concept anchors from their answer.
Pin a ``<board_op>`` ``concept_node`` with their real-world anchor,
AND pin a ``concept_map`` block showing how the unit's concepts connect —
this is the lesson artefact they leave with.
Then emit <request_confidence/> to capture their final confidence rating.
Do NOT also type a confidence question in chat — the widget handles it.\
""",

    "close": """\
## CURRENT PHASE: CLOSE — session goal check + co-created notes + gate

**Session goal check:** If a session goal was set (see "Student's session goal"
block above), reference it explicitly: "You wanted to be able to [goal] by
the end — let's verify that." Give them a quick final check that confirms
they can actually do it. This is the promise payoff.

**Co-created notes step (do this FIRST if notes haven't been requested yet):**
Invite the student to add one personal takeaway: "Before we wrap up — what's
the one thing from today you most want to remember? Add it in the Notes tab
in your own words." Ask once only.

Then check the mastery state block: every objective must be ≥ 75,
teachback_passed must be emitted, at least one confidence rating captured.
If ALL conditions are met: emit summarise_unit + mark_complete this turn \
(see the two-turn protocol below). Use neutral wrap-up language, NOT \
celebratory — the gate may still reject.
If something is still missing: do ONLY that one missing step this turn. \
Do NOT also attempt mark_complete until the gap is closed.\
""",
}

# Fallback for unknown or None phases — generic teaching mode.
_FALLBACK_INTENT = """\
## TEACHING MODE — open unit session

Guide the student through this unit's objectives using the principles below.
Teach adaptively, practice each objective, run a teach-back, capture confidence,
then close cleanly with summarise_unit + mark_complete.\
"""


# Appended to PRESENT when the student has been in it for several turns
# without a confirmed comprehension check (L0.2). The orchestrator holds
# them here on purpose — this block makes the tutor change tactics rather
# than repeat the same explanation louder.
_PRESENT_STUCK_ADDENDUM = """

**You've spent {turns} turns in PRESENT without confirmed comprehension.**
The current explanation isn't landing. Change tactics this turn:
- Re-explain with a SIMPLER, smaller example — concrete numbers or a
  familiar analogy, not more abstraction.
- Break the concept into a smaller piece and check just that piece.
- Ask what specifically feels unclear, and answer THAT.
Then run the comprehension check again. Emit
``<unit_action>{{"type": "comprehension_confirmed"}}</unit_action>`` only
when their answer genuinely shows understanding.\
"""


# ---- Formatter -------------------------------------------------------

def format_phase_block(phase: str | None, turns_in_phase: int = 0) -> str:
    """Return the phase instruction block to prepend to the system prompt.

    Always returns a non-empty string so the template substitution is
    safe regardless of whether the orchestrator has run.

    ``turns_in_phase`` (L0.2) lets the block adapt to a stuck lesson:
    after 3+ turns in PRESENT without a confirmed comprehension check,
    the tutor is told to simplify and re-check rather than push on.
    """
    if not phase:
        return _FALLBACK_INTENT
    # The blocks are written with ``{{``-escaped braces, but they're inserted
    # into the system prompt as a .format() *value* (never re-processed) — so
    # without this de-escape the model literally saw ``{{"type": …}}`` and
    # learned to emit unparseable doubled-brace actions (L0.2 bug fix).
    block = PHASE_INTENT.get(phase, _FALLBACK_INTENT).replace("{{", "{").replace(
        "}}", "}"
    )
    if phase == "present" and turns_in_phase >= 3:
        block += _PRESENT_STUCK_ADDENDUM.format(turns=turns_in_phase)
    return block
