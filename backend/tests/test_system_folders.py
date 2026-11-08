"""``get_or_create_subfolder`` must survive two callers racing to create
the same folder.

Regression: back-to-back board edits both re-index the board, both miss
the workspace's ``Boards`` folder, and both INSERT — the loser hit
``uq_file_folders_user_parent_name`` and the board's RAG text was never
refreshed.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import func, select, text


async def _parent(db, user):
    from app.files.models import FileFolder

    parent = FileFolder(user_id=user.id, parent_id=None, name="WS")
    db.add(parent)
    await db.commit()
    await db.refresh(parent)
    return parent


async def test_concurrent_get_or_create_returns_same_folder(db, user) -> None:
    from app.database import SessionLocal
    from app.files.models import FileFolder
    from app.files.system_folders import get_or_create_subfolder

    parent = await _parent(db, user)

    async with SessionLocal() as a, SessionLocal() as b:
        # A creates the folder but hasn't committed yet...
        folder_a = await get_or_create_subfolder(
            a, user_id=user.id, parent_id=parent.id, name="Boards"
        )
        # ...so B's SELECT misses and its INSERT blocks on A's index entry.
        task_b = asyncio.create_task(
            get_or_create_subfolder(
                b, user_id=user.id, parent_id=parent.id, name="Boards"
            )
        )
        await asyncio.sleep(0.5)
        assert not task_b.done()
        await a.commit()
        # A's commit turns B's INSERT into a unique violation, which must be
        # absorbed and resolved to A's row.
        folder_b = await asyncio.wait_for(task_b, timeout=10)

        assert folder_b.id == folder_a.id
        # B's transaction isn't poisoned by the rolled-back savepoint.
        assert (await b.execute(text("select 1"))).scalar() == 1
        await b.commit()

    count = (
        await db.execute(
            select(func.count())
            .select_from(FileFolder)
            .where(FileFolder.parent_id == parent.id, FileFolder.name == "Boards")
        )
    ).scalar()
    assert count == 1


async def test_get_or_create_is_idempotent(db, user) -> None:
    from app.files.system_folders import get_or_create_subfolder

    parent = await _parent(db, user)
    first = await get_or_create_subfolder(
        db, user_id=user.id, parent_id=parent.id, name="Boards"
    )
    await db.commit()
    second = await get_or_create_subfolder(
        db, user_id=user.id, parent_id=parent.id, name="Boards"
    )
    assert second.id == first.id
