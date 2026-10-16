"""Sheet structure is shared live by tab id (WP-6.3): every tab gets a stable
id from the server — on import and the first time a sheet is opened — so
each browser addresses the same tab."""
from __future__ import annotations

import uuid

import pytest

from tests.test_doc_comments_wp45 import _auth, client  # noqa: F401 — fixtures


def test_tabs_without_an_id_get_one_and_named_ones_keep_theirs():
    from app.workspaces.sheet_io import ensure_tab_ids, from_csv

    data = [{"name": "A", "celldata": []}, {"id": "keep", "name": "B", "celldata": []}]
    assert ensure_tab_ids(data) is True
    assert data[0]["id"] and data[1]["id"] == "keep"
    assert ensure_tab_ids(data) is False
    assert from_csv(b"a,b\n1,2\n")[0]["id"]


@pytest.mark.asyncio
async def test_opening_a_sheet_names_its_tabs_once(client, db, user):  # noqa: F811
    from app.files.models import UserFile
    from app.files.office import content_for_shell

    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Old"}, headers=_auth(user))
    sid = r.json()["id"]
    sheet = await content_for_shell(db, await db.get(UserFile, uuid.UUID(sid)))
    sheet.data = [{"name": "Legacy", "celldata": [{"r": 0, "c": 0, "v": {"v": "x"}}]}]
    await db.commit()
    first = (await client.get(f"/api/files/{sid}/sheet", headers=_auth(user))).json()["data"][0]["id"]
    second = (await client.get(f"/api/files/{sid}/sheet", headers=_auth(user))).json()["data"][0]["id"]
    assert first and first == second
