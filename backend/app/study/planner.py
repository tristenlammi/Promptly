"""AI-driven unit plan generation for a :class:`StudyProject`.

When a student creates a study topic, they describe what they want to
learn and why. The planner takes that free-form brief, asks the LLM to
break it into 5–20 ordered units with learning objectives, and persists
the result as ``StudyUnit`` rows.

The planner always asks for strict JSON so we can parse deterministically
and reject obviously broken output. It then clamps the list length into
the supported range, normalises each unit's shape, and assigns sequential
``order_index`` values starting at 0.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models_config.models import ModelProvider
from app.models_config.provider import ChatMessage, ProviderError, model_router
from app.study.models import StudyProject, StudyUnit

logger = logging.getLogger("promptly.study.planner")

MIN_UNITS = 5
MAX_UNITS = 20
DEFAULT_TEMPERATURE = 0.4
DEFAULT_MAX_TOKENS = 6000

_ALLOWED_DIFFICULTY = {"beginner", "intermediate", "advanced", "mixed"}


_PLANNER_SYSTEM_PROMPT = """You are an expert curriculum designer.

A student has described what they want to learn and the goal they're
working toward. Break the topic into a sequence of focused learning
UNITS that move them from wherever they are today to confidently
meeting that goal.

## Rules for the plan
- Produce between 5 and 20 units — enough to cover the topic properly
  without padding. Depth of topic should dictate the count, not a
  fixed target. Simple topics: 5–8. Broader or more technical topics:
  10–16. Deep multi-skill topics: up to 20.
- Units must be ORDERED — each one should make sense given the prior
  units and prepare the student for what comes next.
- Each unit's scope must be tight — one coherent concept area a
  student can realistically work through in 20–45 minutes.
- For each unit include 2–5 "learning_objectives": short, outcome-
  focused statements the student should be able to demonstrate once
  they understand the unit ("can subnet a /24 into eight equal
  subnets", not "studied subnetting").
- Assume an AI tutor will work one-on-one with the student on each
  unit — do NOT include prerequisites like "watch this video" or
  "read chapter 3". The tutor handles the teaching interactively.
- Also classify the overall difficulty: one of beginner, intermediate,
  advanced, or mixed (if the plan ramps across levels).

## Pace the plan to the student's self-reported level

The student told you their starting level. Read the "Student's
current level" field in the brief below carefully — your plan MUST
match it. Topics that are "entry-level" to a practitioner (CCNA, AWS
Cloud Practitioner, Organic Chem 101, French A1) still assume a
whole layer of domain vocabulary a true beginner doesn't have.

- **beginner** — Assume they have NEVER studied this topic or anything
  adjacent. Front-load 2–4 foundation units covering the prerequisite
  vocabulary, mental models, and "what is this field even about"
  context before ANY domain-specific content. Example: a beginner on
  CCNA should see units on "What is a network?", "Packets, switches
  vs routers", "IP addresses and the OSI model" BEFORE the first
  Cisco-specific unit. A beginner on Organic Chemistry should see
  units on "Atoms, bonds, and why carbon is special" before
  "Functional groups". If in doubt, add the foundation unit — it
  costs 20 minutes of the student's time and saves hours of confusion
  downstream. Tag overall ``difficulty`` as ``beginner`` or ``mixed``.

- **some_exposure** — They know the basics but not the target
  material in depth. You can skip the "what is this field" foundation
  units, but DO still include a short "key terminology refresher"
  unit at the front that names the prerequisite concepts the rest of
  the plan will assume. Tag ``difficulty`` as ``intermediate`` or
  ``mixed``.

- **refresher** — They've worked through this material before and
  need to firm it up for an exam or interview. Skip foundation-
  building entirely; focus units on the trickier or higher-weighted
  topics; ramp straight to exam-style depth. Tag ``difficulty`` as
  ``intermediate`` or ``advanced``.

- **(level not provided)** — Pitch the plan at a generous
  intermediate level: include one or two light foundation units in
  case they're greener than they let on, but don't bury them in
  pre-reqs. Tag ``difficulty`` honestly based on the topic depth.

Do not make the student's stated level a hard ceiling — if their
brief clearly shows they're more advanced than they claimed, follow
the brief. But err on the side of their stated level when uncertain;
it's always easier to skip a foundation unit than to stumble through
an advanced one unprepared.

## Output format (STRICT)
Respond with ONE JSON object and nothing else. No prose, no code
fences, no markdown. Exact shape:

{
  "difficulty": "beginner|intermediate|advanced|mixed",
  "units": [
    {
      "title": "Short, specific unit title",
      "description": "2-4 sentences on what the student will learn and why it matters.",
      "learning_objectives": [
        "Can do X.",
        "Understands Y.",
        "Can apply Z to a worked problem."
      ]
    },
    ...
  ]
}

If you cannot produce a plan, respond with {"error": "short reason"}
and nothing else.
"""


@dataclass
class PlanUnit:
    title: str
    description: str
    learning_objectives: list[str]


@dataclass
class GeneratedPlan:
    difficulty: str | None
    units: list[PlanUnit]


class PlanGenerationError(Exception):
    """Raised when the LLM output can't be turned into a usable plan."""


async def generate_plan(
    *,
    provider: ModelProvider,
    model_id: str,
    title: str,
    learning_request: str,
    goal: str | None,
    topics: list[str],
    current_level: str | None = None,
) -> GeneratedPlan:
    """Ask the model for a unit plan and parse the JSON response.

    Raises :class:`PlanGenerationError` on malformed output or if the
    model flagged the brief as impossible.
    """
    user_prompt = _build_user_prompt(
        title=title,
        learning_request=learning_request,
        goal=goal,
        topics=topics,
        current_level=current_level,
    )

    buf: list[str] = []
    try:
        async for token in model_router.stream_chat(
            provider=provider,
            model_id=model_id,
            messages=[ChatMessage(role="user", content=user_prompt)],
            system=_PLANNER_SYSTEM_PROMPT,
            temperature=DEFAULT_TEMPERATURE,
            max_tokens=DEFAULT_MAX_TOKENS,
        ):
            buf.append(token)
    except ProviderError as exc:
        raise PlanGenerationError(f"Provider error: {exc}") from exc

    raw = "".join(buf).strip()
    if not raw:
        raise PlanGenerationError("Model returned an empty response.")

    data = _parse_json_strict(raw)
    if isinstance(data, dict) and isinstance(data.get("error"), str):
        raise PlanGenerationError(f"Planner declined: {data['error'].strip()[:200]}")

    return _coerce_plan(data)


_LEVEL_DESCRIPTIONS: dict[str, str] = {
    "beginner": (
        "beginner — the student has never studied this topic or anything "
        "adjacent. Treat them as starting from zero domain vocabulary."
    ),
    "some_exposure": (
        "some_exposure — the student knows the basics but wants to go "
        "deeper. They recognise core terms but haven't worked with them "
        "seriously yet."
    ),
    "refresher": (
        "refresher — the student has worked through this material before "
        "and is firming it up (e.g. prepping for an exam, re-entering the "
        "field). Skip the foundations."
    ),
}


def _build_user_prompt(
    *,
    title: str,
    learning_request: str,
    goal: str | None,
    topics: list[str],
    current_level: str | None,
) -> str:
    topics_line = ", ".join(topics) if topics else "(none specified)"
    goal_line = (goal or "").strip() or "(none specified)"
    level_line = _LEVEL_DESCRIPTIONS.get(
        (current_level or "").strip(),
        "(not provided — pitch at intermediate with light foundation coverage)",
    )
    return (
        f"## Topic title\n{title.strip()}\n\n"
        f"## What they want to learn\n{learning_request.strip()}\n\n"
        f"## Their end goal\n{goal_line}\n\n"
        f"## Specific focus areas\n{topics_line}\n\n"
        f"## Student's current level\n{level_line}\n\n"
        "Design the unit plan."
    )


def _parse_json_strict(raw: str) -> object:
    """Parse a JSON object, tolerating stray code fences or leading prose.

    The system prompt tells the model not to wrap the JSON, but models
    occasionally do anyway — we strip a common set of wrappers before
    giving up.
    """
    # Try straight parse first.
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Strip ```json ... ``` or ``` ... ``` fences if present.
    fence = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", raw, re.IGNORECASE)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass

    # Fall back to extracting the first balanced {...} block.
    first = raw.find("{")
    last = raw.rfind("}")
    if first != -1 and last > first:
        try:
            return json.loads(raw[first:last + 1])
        except json.JSONDecodeError:
            pass

    raise PlanGenerationError("Model output was not valid JSON.")


def _coerce_plan(data: object) -> GeneratedPlan:
    if not isinstance(data, dict):
        raise PlanGenerationError("Plan JSON must be an object.")

    units_raw = data.get("units")
    if not isinstance(units_raw, list):
        raise PlanGenerationError("Plan JSON must contain a 'units' array.")

    coerced: list[PlanUnit] = []
    for item in units_raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        description = str(item.get("description") or "").strip()
        objectives_raw = item.get("learning_objectives") or item.get("objectives")
        objectives: list[str] = []
        if isinstance(objectives_raw, list):
            for obj in objectives_raw:
                if isinstance(obj, str):
                    cleaned = obj.strip()
                    if cleaned:
                        objectives.append(cleaned[:500])
        coerced.append(
            PlanUnit(
                title=title[:255],
                description=description[:4000],
                learning_objectives=objectives[:8],
            )
        )
        if len(coerced) >= MAX_UNITS:
            break

    if len(coerced) < MIN_UNITS:
        raise PlanGenerationError(
            f"Planner returned only {len(coerced)} usable units "
            f"(need at least {MIN_UNITS})."
        )

    difficulty_raw = data.get("difficulty")
    difficulty: str | None = None
    if isinstance(difficulty_raw, str):
        d = difficulty_raw.strip().lower()
        if d in _ALLOWED_DIFFICULTY:
            difficulty = d

    return GeneratedPlan(difficulty=difficulty, units=coerced)


async def apply_plan(
    *,
    db: AsyncSession,
    project: StudyProject,
    plan: GeneratedPlan,
) -> list[StudyUnit]:
    """Persist ``plan`` into the DB, replacing any existing units.

    Returns the freshly-created ``StudyUnit`` rows in plan order. Caller
    is responsible for committing the transaction.
    """
    # Replace existing units on regeneration — safer than trying to
    # diff, and the tutor sessions bound to old units have already
    # SET NULL on their unit_id FK.
    await db.execute(
        sa_delete(StudyUnit).where(StudyUnit.project_id == project.id)
    )

    rows: list[StudyUnit] = []
    for idx, unit in enumerate(plan.units):
        row = StudyUnit(
            id=uuid.uuid4(),
            project_id=project.id,
            order_index=idx,
            title=unit.title,
            description=unit.description,
            learning_objectives=unit.learning_objectives,
            status="not_started",
        )
        db.add(row)
        rows.append(row)

    if plan.difficulty:
        project.difficulty = plan.difficulty
    project.status = "active"
    project.planning_error = None
    # Any regeneration invalidates the previous calibration — the new
    # plan may sit at a different level, and the Unit 1 diagnostic
    # should run again to confirm fit.
    project.calibrated = False
    # Reset calibration bookkeeping too — the next calibration pass
    # starts from a clean slate, and the honesty nudge should be
    # eligible to fire again on the new plan.
    project.calibration_source = None
    project.calibration_warning_sent_at = None
    project.updated_at = datetime.now(timezone.utc)

    await db.flush()
    return rows


async def generate_and_apply_plan(
    *,
    db: AsyncSession,
    project: StudyProject,
    provider: ModelProvider,
    model_id: str,
) -> list[StudyUnit]:
    """Convenience wrapper — generate + persist in one step.

    Records any :class:`PlanGenerationError` on the project row so the
    UI can surface a retry affordance without losing the original brief.
    """
    try:
        plan = await generate_plan(
            provider=provider,
            model_id=model_id,
            title=project.title,
            learning_request=(project.learning_request or "").strip(),
            goal=project.goal,
            topics=list(project.topics or []),
            current_level=project.current_level,
        )
    except PlanGenerationError as exc:
        project.status = "planning"
        project.planning_error = str(exc)[:500]
        project.updated_at = datetime.now(timezone.utc)
        await db.flush()
        logger.warning(
            "Plan generation failed for project %s: %s", project.id, exc
        )
        raise

    return await apply_plan(db=db, project=project, plan=plan)
