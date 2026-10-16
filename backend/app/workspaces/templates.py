"""Workspace templates (Batch 4.6).

A template turns the blank-workspace cold start into a working setup:
seeded notes (real Markdown skeletons, not lorem), a board with a
matching label registry, and a tuned workspace system prompt. Data-
driven — each entry below is plain content, so adding a vertical is an
edit, not a feature.

Applied inside the create-workspace transaction; a template failure
must never lose the workspace itself (caller catches + logs).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import User
from app.chat.models import Workspace

logger = logging.getLogger("promptly.workspaces.templates")


@dataclass(frozen=True)
class WorkspaceTemplate:
    key: str
    name: str
    description: str
    system_prompt: str
    notes: list[tuple[str, str]] = field(default_factory=list)  # (title, md)
    board: tuple[str, list[dict[str, Any]]] | None = None  # (title, labels)
    # Picker section: "Home & family" or "Work" (V10).
    group: str = "Work"


TEMPLATES: dict[str, WorkspaceTemplate] = {
    t.key: t
    for t in [
        WorkspaceTemplate(
            key="legal_matter",
            name="Legal matter",
            description="Matter overview, client intake, and a deadlines board.",
            system_prompt=(
                "You are assisting on a legal matter. Be precise, cite the "
                "workspace documents you rely on, flag deadlines "
                "proactively, and never present speculation as legal fact. "
                "When drafting, prefer formal tone and defined terms."
            ),
            notes=[
                (
                    "Matter overview",
                    "# Matter overview\n\n"
                    "## Parties\n- Client: \n- Opposing party: \n\n"
                    "## Summary\n_What is this matter about, in three sentences?_\n\n"
                    "## Key dates\n| Date | Event |\n|---|---|\n|  |  |\n\n"
                    "## Strategy\n- \n\n"
                    "## Open questions\n- [ ] ",
                ),
                (
                    "Client intake",
                    "# Client intake\n\n"
                    "## Contact\n- Name: \n- Email: \n- Phone: \n\n"
                    "## Engagement\n- Scope: \n- Fee arrangement: \n- [ ] Conflicts check done\n\n"
                    "## Documents received\n- [ ] ",
                ),
            ],
            board=(
                "Deadlines",
                [
                    {"name": "Court", "color": "#EF4444"},
                    {"name": "Filing", "color": "#F59E0B"},
                    {"name": "Discovery", "color": "#4F46E5"},
                    {"name": "Client", "color": "#10B981"},
                ],
            ),
        ),
        WorkspaceTemplate(
            key="engineering_sprint",
            name="Engineering sprint",
            description="Sprint goals, a runbook, and a labelled sprint board.",
            system_prompt=(
                "You are assisting an engineering team. Be concrete and "
                "technical; prefer diffs, commands, and checklists over "
                "prose. When asked about the system, ground answers in the "
                "workspace's runbook and notes."
            ),
            notes=[
                (
                    "Sprint goals",
                    "# Sprint goals\n\n"
                    "## Objective\n_One sentence: what does this sprint ship?_\n\n"
                    "## Committed\n- [ ] \n\n"
                    "## Stretch\n- [ ] \n\n"
                    "## Risks\n- ",
                ),
                (
                    "Runbook",
                    "# Runbook\n\n"
                    "## Services\n| Service | Where | Owner |\n|---|---|---|\n|  |  |  |\n\n"
                    "## Deploy\n```bash\n# steps\n```\n\n"
                    "## Rollback\n```bash\n# steps\n```\n\n"
                    "## Incident contacts\n- ",
                ),
            ],
            board=(
                "Sprint",
                [
                    {"name": "Bug", "color": "#EF4444"},
                    {"name": "Feature", "color": "#4F46E5"},
                    {"name": "Chore", "color": "#64748B"},
                    {"name": "Blocked", "color": "#F59E0B"},
                ],
            ),
        ),
        WorkspaceTemplate(
            key="client_onboarding",
            name="Client onboarding",
            description="Onboarding checklist, welcome pack, and a pipeline board.",
            system_prompt=(
                "You are assisting with client onboarding. Be warm but "
                "efficient; track outstanding items explicitly and draft "
                "client-facing text in a professional, friendly tone."
            ),
            notes=[
                (
                    "Onboarding checklist",
                    "# Onboarding checklist\n\n"
                    "- [ ] Contract signed\n"
                    "- [ ] Kickoff call scheduled\n"
                    "- [ ] Access + accounts provisioned\n"
                    "- [ ] Welcome pack sent\n"
                    "- [ ] First deliverable agreed\n",
                ),
                (
                    "Welcome pack",
                    "# Welcome pack\n\n"
                    "## Who you'll work with\n- \n\n"
                    "## How we communicate\n- Channel: \n- Cadence: \n\n"
                    "## What happens next\n1. ",
                ),
            ],
            board=(
                "Pipeline",
                [
                    {"name": "Waiting on client", "color": "#F59E0B"},
                    {"name": "Internal", "color": "#4F46E5"},
                    {"name": "Done-done", "color": "#10B981"},
                ],
            ),
        ),
        # --- Home & family (V10) — the business-only list said Promptly
        # wasn't for households.
        WorkspaceTemplate(
            key="household",
            name="Household",
            group="Home & family",
            description="Chores board, a shopping list, key contacts and bills.",
            system_prompt=(
                "You help a household run smoothly. Be practical and brief. "
                "Use the workspace's notes for who does what, recurring bills "
                "and contacts; suggest fair ways to share chores, and turn "
                "plans into checklists."
            ),
            notes=[
                (
                    "Household info",
                    "# Household info\n\n"
                    "## Key contacts\n| Who | Phone | Notes |\n|---|---|---|\n"
                    "| Doctor |  |  |\n| School |  |  |\n| Plumber |  |  |\n\n"
                    "## Bills & renewals\n| Bill | Due | Amount | Paid by |\n|---|---|---|---|\n|  |  |  |  |\n\n"
                    "## Wi-Fi & codes\n- Wi-Fi: \n- Alarm: ",
                ),
                (
                    "Shopping list",
                    "# Shopping list\n\n"
                    "## Groceries\n- [ ] \n\n"
                    "## Household\n- [ ] \n\n"
                    "## Someday\n- [ ] ",
                ),
                (
                    "Meal plan",
                    "# Meal plan\n\n"
                    "| Day | Dinner | Who cooks |\n|---|---|---|\n"
                    "| Mon |  |  |\n| Tue |  |  |\n| Wed |  |  |\n"
                    "| Thu |  |  |\n| Fri |  |  |\n| Sat |  |  |\n| Sun |  |  |",
                ),
            ],
            board=(
                "Chores",
                [
                    {"name": "Weekly", "color": "#4F46E5"},
                    {"name": "Monthly", "color": "#0EA5E9"},
                    {"name": "Kids", "color": "#10B981"},
                    {"name": "Errand", "color": "#F59E0B"},
                ],
            ),
        ),
        WorkspaceTemplate(
            key="trip",
            name="Trip",
            group="Home & family",
            description="Itinerary, packing list, bookings and a to-do board.",
            system_prompt=(
                "You help plan a trip. Keep the itinerary, bookings and budget "
                "in the workspace notes as the source of truth; flag clashes, "
                "missing bookings and deadlines (visas, check-in times), and "
                "keep suggestions realistic for the group."
            ),
            notes=[
                (
                    "Itinerary",
                    "# Itinerary\n\n"
                    "**Dates:** \n**Travellers:** \n\n"
                    "| Day | Where | Plans | Stay |\n|---|---|---|---|\n"
                    "| 1 |  |  |  |\n| 2 |  |  |  |\n| 3 |  |  |  |",
                ),
                (
                    "Bookings",
                    "# Bookings\n\n"
                    "| What | Ref | Date & time | Cost | Paid |\n|---|---|---|---|---|\n"
                    "| Flights |  |  |  |  |\n| Stay |  |  |  |  |\n| Car |  |  |  |  |\n\n"
                    "## Budget\n- Total: \n- Per person: ",
                ),
                (
                    "Packing list",
                    "# Packing list\n\n"
                    "## Documents\n- [ ] Passports / ID\n- [ ] Tickets\n- [ ] Insurance\n\n"
                    "## Clothes\n- [ ] \n\n"
                    "## Gear & chargers\n- [ ] ",
                ),
            ],
            board=(
                "Trip to-dos",
                [
                    {"name": "Book", "color": "#4F46E5"},
                    {"name": "Buy", "color": "#F59E0B"},
                    {"name": "Before we go", "color": "#EF4444"},
                ],
            ),
        ),
        WorkspaceTemplate(
            key="renovation",
            name="Renovation",
            group="Home & family",
            description="Scope and budget, trades and quotes, and a works board.",
            system_prompt=(
                "You help manage a home renovation. Track scope, budget and "
                "quotes from the workspace notes; compare quotes like for like, "
                "flag budget overruns and decisions that block the trades, and "
                "keep the order of works sensible."
            ),
            notes=[
                (
                    "Scope & budget",
                    "# Scope & budget\n\n"
                    "## What we're doing\n- \n\n"
                    "## Budget\n| Item | Estimate | Actual |\n|---|---|---|\n|  |  |  |\n\n"
                    "**Contingency:** \n\n"
                    "## Decisions to make\n- [ ] ",
                ),
                (
                    "Trades & quotes",
                    "# Trades & quotes\n\n"
                    "| Trade | Name | Phone | Quote | Status |\n|---|---|---|---|---|\n"
                    "| Builder |  |  |  |  |\n| Electrician |  |  |  |  |\n"
                    "| Plumber |  |  |  |  |",
                ),
            ],
            board=(
                "Works",
                [
                    {"name": "Waiting on quote", "color": "#F59E0B"},
                    {"name": "Booked", "color": "#4F46E5"},
                    {"name": "Needs a decision", "color": "#EF4444"},
                    {"name": "DIY", "color": "#10B981"},
                ],
            ),
        ),
        WorkspaceTemplate(
            key="school",
            name="School",
            group="Home & family",
            description="Term dates, subjects and a homework board for a student.",
            system_prompt=(
                "You help a student (and their family) stay on top of school. "
                "Explain things step by step at the student's level, encourage "
                "them to try before giving answers, and use the workspace's "
                "notes for term dates, subjects and due dates."
            ),
            notes=[
                (
                    "Term overview",
                    "# Term overview\n\n"
                    "**Term dates:** \n**Year / class:** \n\n"
                    "## Key dates\n| Date | What |\n|---|---|\n|  |  |\n\n"
                    "## Teachers\n| Subject | Teacher | Contact |\n|---|---|---|\n|  |  |  |",
                ),
                (
                    "Study notes",
                    "# Study notes\n\n"
                    "## This week\n- \n\n"
                    "## Things I don't get yet\n- [ ] \n\n"
                    "## Before the next test\n- [ ] ",
                ),
            ],
            board=(
                "Homework",
                [
                    {"name": "Maths", "color": "#4F46E5"},
                    {"name": "English", "color": "#10B981"},
                    {"name": "Science", "color": "#0EA5E9"},
                    {"name": "Project", "color": "#F59E0B"},
                ],
            ),
        ),
    ]
}


def template_catalog() -> list[dict[str, str]]:
    """Key/name/description rows for the create-workspace picker."""
    return [
        {
            "key": t.key,
            "name": t.name,
            "description": t.description,
            "group": t.group,
        }
        for t in TEMPLATES.values()
    ]


async def apply_template(
    db: AsyncSession,
    *,
    ws: Workspace,
    user: User,
    template_key: str,
) -> None:
    """Seed ``ws`` from a template. Flushes only — caller commits."""
    from app.workspaces.content_seed import (
        create_board_with_labels,
        create_note_with_item,
    )

    template = TEMPLATES.get(template_key)
    if template is None:
        return
    if template.system_prompt and not (ws.system_prompt or "").strip():
        ws.system_prompt = template.system_prompt
    if template.board is not None:
        board_title, labels = template.board
        await create_board_with_labels(
            db, ws=ws, creator_id=user.id, title=board_title, labels=labels
        )
    # Reverse so the first-listed note lands at the top of the rail
    # (each insert takes the min-position slot).
    for title, markdown in reversed(template.notes):
        await create_note_with_item(
            db,
            ws=ws,
            owner=user,
            creator_id=user.id,
            title=title,
            markdown=markdown,
        )


# ---------------------------------------------------------------------
# Note templates (9.3) — single-note skeletons for the "New from
# template" picker. Same philosophy as workspace templates: plain
# content, adding one is an edit. The date placeholder is filled at
# creation time.
# ---------------------------------------------------------------------
NOTE_TEMPLATES: dict[str, tuple[str, str]] = {
    "meeting_agenda": (
        "Meeting agenda",
        """# Meeting agenda — {date}

**Attendees:**
**Goal:**

## Agenda

1.
2.
3.

## Notes

## Decisions

## Action items

- [ ]
""",
    ),
    "decision_record": (
        "Decision record",
        """# Decision — {date}

**Status:** Proposed
**Deciders:**

## Context

What situation forces this decision?

## Options considered

1. **Option A** —
2. **Option B** —

## Decision

## Consequences
""",
    ),
    "weekly_report": (
        "Weekly report",
        """# Week of {date}

## Done

-

## In progress

-

## Blocked

-

## Next week

-
""",
    ),
    "project_brief": (
        "Project brief",
        """# Project brief

**Owner:**
**Target date:**

## Problem

## Goals

-

## Non-goals

-

## Approach

## Risks

## Open questions

-
""",
    ),
}


__all__ = ["TEMPLATES", "NOTE_TEMPLATES", "apply_template", "template_catalog"]
