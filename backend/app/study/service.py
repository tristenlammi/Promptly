"""Study service — Redis stream-context handoff + tutor system prompt builder."""
from __future__ import annotations

import json
import uuid
from typing import Any, TypedDict

from app.models_config.provider import ChatMessage
from app.redis_client import redis
from app.study.models import StudyMessage, StudyProject, WhiteboardExercise
from app.study.parser import CLOSE_TAG, OPEN_TAG

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
    # When set, this stream is an evaluation of a just-submitted exercise. The
    # stream handler uses it to mark the exercise as reviewed + store feedback.
    reviewing_exercise_id: str | None


async def enqueue_stream(stream_id: uuid.UUID, ctx: StudyStreamContext) -> None:
    await redis.set(_key(stream_id), json.dumps(ctx), ex=STREAM_CONTEXT_TTL_SECONDS)


async def consume_stream(stream_id: uuid.UUID) -> StudyStreamContext | None:
    raw: Any = await redis.getdel(_key(stream_id))
    if raw is None:
        return None
    return json.loads(raw)


# ---- Tutor system prompt ----
_STUDY_SYSTEM_PROMPT_TEMPLATE = """You are an expert study tutor helping a student learn.

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

## Two output channels
You have two places you can put content:

1. CHAT (this reply): Use this for explanations, encouragement, feedback,
   and conversational guidance.
2. WHITEBOARD EXERCISE: Use this to deliver interactive exercises, quizzes,
   puzzles, simulations. The whiteboard on the student's right renders a
   sandboxed HTML page you write. You have full creative freedom.

## When to use the whiteboard
- Every time you want the student to **practise** (quiz, drag-and-drop,
  drawing task, calculator, sort, match, fill-in-blank, topology builder…).
- Do NOT put multiple-choice questions or interactive activities in the
  chat — always put them on the whiteboard.
- After placing an exercise, stop and wait for the student to submit before
  continuing. Use the chat to briefly set up ("Here's a quick quiz on VLSM —
  give it a go and I'll walk through your answers.").
- Vary exercise types — do not repeat the same format back-to-back.

## How to place a whiteboard exercise
Output a `<whiteboard_action>` block ANYWHERE in your reply:

<whiteboard_action>
{{"type": "exercise", "title": "Short title", "html": "<!DOCTYPE html>..."}}
</whiteboard_action>

The whole block must be valid JSON. Escape quotes and backslashes in the
`html` string properly. The `html` value is a COMPLETE, self-contained HTML
document.

## Exercise HTML contract
Your HTML document MUST:

1. Include a visible "Submit" button inside the page.
2. Also listen for a request-to-submit message from the parent so the student
   can submit via the sticky bar below the whiteboard:
   ```
   window.addEventListener('message', (e) => {{
     if (e.data && e.data.type === 'REQUEST_SUBMIT') submitAnswers();
   }});
   ```
3. When submitting, call:
   ```
   window.parent.postMessage(
     {{ type: 'EXERCISE_SUBMIT', payload: /* any JSON */ }},
     '*'
   );
   ```
4. Be fully self-contained. You may load libraries from https://cdnjs.cloudflare.com.
5. Use inline CSS. Aesthetic: background `#1C1917` or `#FAF9F7`, accent
   `#D97757`, clean sans-serif. Make it look polished.
6. Fit the panel — assume ~800px wide by ~600px tall and let content scroll
   internally if needed.

## After the student submits
You will receive a user message that reports their submission and includes
their answer payload verbatim. Evaluate their answers in chat:

- Be specific about what's right and what's wrong.
- Explain any mistakes briefly and usefully.
- Celebrate genuine wins.
- Then decide: place a follow-up exercise with another `<whiteboard_action>`
  block, or stay in chat for a quick recap — whichever helps most.

## Exercise ideas to vary between
Multiple choice / multi-select quizzes · drag-and-drop (ordering, matching,
bucketing) · click-to-label diagrams · fill-in-the-blank passages · hotspot
/ click-on-the-region · flashcards with self-rated recall · sorting & ranking ·
timed challenge modes · topology builders (vis.js from CDN) · interactive
calculators that validate the student's working.
"""


def build_tutor_system_prompt(project: StudyProject) -> str:
    topics_str = ", ".join(project.topics) if project.topics else "(not specified)"
    goal_str = (project.goal or "").strip() or "(not specified)"
    return _STUDY_SYSTEM_PROMPT_TEMPLATE.format(
        title=project.title,
        topics=topics_str,
        goal=goal_str,
    )


# ---- History rehydration ----
def build_history_for_llm(
    rows: list[StudyMessage],
    exercises_by_msg: dict[uuid.UUID, WhiteboardExercise],
) -> list[ChatMessage]:
    """Re-expand persisted messages into the format the LLM expects.

    The stored ``content`` of assistant messages has already had any
    ``<whiteboard_action>`` block stripped (we replay those only in the
    chat). For the LLM we re-inject the original block so the model can see
    exactly what it placed on the whiteboard earlier in the session.
    """
    history: list[ChatMessage] = []
    for m in rows:
        if m.role not in ("user", "assistant", "system"):
            continue
        content = m.content or ""
        if m.role == "assistant" and m.exercise_id in exercises_by_msg:
            ex = exercises_by_msg[m.exercise_id]
            action_json = json.dumps(
                {"type": "exercise", "title": ex.title or "", "html": ex.html}
            )
            content = (
                (content + "\n\n" if content else "")
                + f"{OPEN_TAG}\n{action_json}\n{CLOSE_TAG}"
            )
        if not content:
            continue
        history.append(ChatMessage(role=m.role, content=content))
    return history


# ---- Submission context ----
def format_submission_user_message(
    exercise: WhiteboardExercise, answers: dict[str, Any] | list[Any] | None
) -> str:
    """The user-facing chat message appended when the student submits.

    It doubles as the LLM's evaluation context: answers are serialised as a
    fenced JSON block, and the exercise title is called out so the AI can
    anchor its feedback without needing extra plumbing.
    """
    title = (exercise.title or "this exercise").strip()
    pretty = json.dumps(answers if answers is not None else {}, indent=2)
    return (
        f"I just submitted my answers for **{title}**.\n\n"
        "```json\n"
        f"{pretty}\n"
        "```\n\n"
        "Please evaluate how I did, point out anything I got wrong, and "
        "suggest what to work on next."
    )


def parse_action_payload(raw: str) -> dict[str, Any] | None:
    """Parse the JSON body captured between ``<whiteboard_action>`` tags.

    Returns ``None`` when the body is malformed so the stream handler can
    keep running instead of crashing mid-token.
    """
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    return obj
