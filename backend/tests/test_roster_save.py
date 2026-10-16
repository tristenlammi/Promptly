"""A stale roster editor can't overwrite the schedule (R-035)."""
from __future__ import annotations

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.chat.models import Roster, Workspace
from app.workspaces.items_router import save_roster
from app.workspaces.schemas import RosterSaveRequest


@pytest.fixture
async def roster(db, user):
    ws = Workspace(user_id=user.id, title="Shop")
    db.add(ws)
    await db.flush()
    r = Roster(workspace_id=ws.id, title="Rota", data={"shifts": [{"id": "s1"}]})
    db.add(r)
    await db.commit()
    return ws, r


async def _save(db, user, ws, r, base, shifts):
    return await save_roster(
        ws.id, r.id, RosterSaveRequest(data={"shifts": shifts}, base_revision=base),
        BackgroundTasks(), db=db, user=user,
    )


@pytest.mark.asyncio
async def test_saves_advance_the_revision(db, user, roster):
    ws, r = roster

    first = await _save(db, user, ws, r, 0, [{"id": "s1"}, {"id": "s2"}])
    second = await _save(db, user, ws, r, first.revision, [{"id": "s3"}])

    assert (first.revision, second.revision) == (1, 2)


@pytest.mark.asyncio
async def test_a_stale_save_is_refused_and_changes_nothing(db, user, roster):
    ws, r = roster
    await _save(db, user, ws, r, 0, [{"id": "s1"}, {"id": "s2"}])

    # A second tab (or a client that never loaded the roster) still on rev 0.
    with pytest.raises(HTTPException) as e:
        await _save(db, user, ws, r, 0, [])
    assert e.value.status_code == 409

    await db.refresh(r)
    assert len(r.data["shifts"]) == 2
