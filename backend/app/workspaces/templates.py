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
                    "## Engagement\n- Scope: \n- Fee arrangement: \n- Conflicts check: [ ] done\n\n"
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
    ]
}


def template_catalog() -> list[dict[str, str]]:
    """Key/name/description rows for the create-workspace picker."""
    return [
        {"key": t.key, "name": t.name, "description": t.description}
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


__all__ = ["TEMPLATES", "apply_template", "template_catalog"]
