"""One search box (WP-5.4): word prefixes as you type, names indexed without
English stemming, folders shared with you, full trails, kind chips, search
inside a folder, and files related by meaning from the AI search index."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from tests.test_drive_index_wp51 import _auth, _upload, _user, client  # noqa: F401 — fixtures


async def _folder(db, user, name, parent=None):
    from app.files.models import FileFolder

    f = FileFolder(user_id=user.id, name=name, parent_id=parent.id if parent else None)
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def _search(client, user, q, **params):
    r = await client.get("/api/files/search", params={"q": q, **params}, headers=_auth(user))
    assert r.status_code == 200, r.text
    return r.json()


def _names(body, key="hits"):
    return [h["file"]["filename"] for h in body[key]]


def test_plain_queries_become_prefix_queries_and_operator_queries_do_not():
    from app.files.search_query import prefix_query_text

    assert prefix_query_text("budg rev") == "'budg':* & 'rev':*"
    assert prefix_query_text("q3_budget") == "'q3':* & 'budget':*"
    assert prefix_query_text("a report") == "'a' & 'report':*"
    assert prefix_query_text('"budget review"') is None
    assert prefix_query_text("budget -draft") is None
    assert prefix_query_text("budget OR plan") is None
    assert prefix_query_text("it's") is None  # a quote — leave it to websearch
    assert prefix_query_text("¿?") is None


@pytest.mark.asyncio
async def test_words_in_files_match_as_you_type_and_operators_still_work(client, db, user):  # noqa: F811
    await _upload(client, user, "notes.txt", b"Quarterly budget review for the garden club.")
    await _upload(client, user, "plan.txt", b"Budget draft, not reviewed yet.")
    body = await _search(client, user, "budg")
    assert set(_names(body)) == {"notes.txt", "plan.txt"}
    assert {h["match"] for h in body["hits"]} == {"content"}
    assert "<mark>" in body["hits"][0]["snippet"]
    assert _names(await _search(client, user, '"budget review"')) == ["notes.txt"]
    assert _names(await _search(client, user, "budget -draft")) == ["notes.txt"]
    # A name hit says so.
    body = await _search(client, user, "plan")
    assert body["hits"][0]["file"]["filename"] == "plan.txt" and body["hits"][0]["match"] == "name"


@pytest.mark.asyncio
async def test_names_are_indexed_as_written_not_stemmed_as_english(client, db, user):  # noqa: F811
    f = await _upload(client, user, "facturas de mayo.txt", b"x")
    tsv = (await db.execute(text("SELECT content_tsv::text FROM files WHERE id = :i"), {"i": f["id"]})).scalar()
    assert "'facturas'" in tsv and "'de'" in tsv and "'mayo'" in tsv
    assert _names(await _search(client, user, "factur")) == ["facturas de mayo.txt"]


@pytest.mark.asyncio
async def test_shared_folders_show_up_with_full_trails(client, db, user):  # noqa: F811
    pal = await _user(db, "pal")
    projects = await _folder(db, pal, "Projects")
    q3 = await _folder(db, pal, "Q3 roadmap", parent=projects)
    deep = await _upload(client, pal, "roadmap-notes.txt", b"milestones", folder_id=q3.id)
    loose = await _upload(client, pal, "roadmap-sketch.txt", b"sketch")
    await client.post(f"/api/files/folder/{projects.id}/grants", json={"grantee_user_id": str(user.id)},
                      headers=_auth(pal))
    await client.post(f"/api/files/file/{loose['id']}/grants", json={"grantee_user_id": str(user.id)},
                      headers=_auth(pal))
    mine = await _folder(db, user, "Roadmaps")
    own = await _upload(client, user, "roadmap-mine.txt", b"mine", folder_id=mine.id)

    body = await _search(client, user, "roadmap")
    folders = {f["name"]: f for f in body["folders"]}
    assert set(folders) == {"Q3 roadmap", "Roadmaps"}
    assert body["folder_breadcrumbs"][str(q3.id)] == f"Shared by {pal.username} / Projects"
    assert body["folder_breadcrumbs"][str(mine.id)] == "My files"
    by = {h["file"]["filename"]: h for h in body["hits"]}
    assert by["roadmap-notes.txt"]["breadcrumb"] == f"Shared by {pal.username} / Projects / Q3 roadmap"
    assert by["roadmap-notes.txt"]["parent_link"] == f"/files/folder/{q3.id}?scope=shared"
    assert by["roadmap-sketch.txt"]["breadcrumb"] == f"Shared by {pal.username}"
    assert by["roadmap-sketch.txt"]["parent_link"] is None
    assert by["roadmap-mine.txt"]["breadcrumb"] == "My files / Roadmaps"
    assert by["roadmap-mine.txt"]["parent_link"] == f"/files/folder/{mine.id}"
    del deep, own

    # "Owned by me" leaves the shared folder out; "shared with me" keeps only it.
    assert [f["name"] for f in (await _search(client, user, "roadmap", owner="me"))["folders"]] == ["Roadmaps"]
    assert [f["name"] for f in (await _search(client, user, "roadmap", owner="others"))["folders"]] == ["Q3 roadmap"]
    # A stranger sees none of it.
    stranger = await _user(db, "sam")
    body = await _search(client, stranger, "roadmap")
    assert body["hits"] == [] and body["folders"] == []


@pytest.mark.asyncio
async def test_kind_chips_and_searching_inside_a_folder(client, db, user):  # noqa: F811
    r = await client.post("/api/files/office", json={"kind": "sheet", "title": "Travel costs"}, headers=_auth(user))
    assert r.status_code == 201
    import io

    from docx import Document

    buf = io.BytesIO()
    d = Document()
    d.add_paragraph("Day one: Tokyo.")
    d.save(buf)
    await _upload(client, user, "travel-itinerary.docx", buf.getvalue(),
                  mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    trips = await _folder(db, user, "Trips")
    japan = await _folder(db, user, "Japan travel", parent=trips)
    inside = await _upload(client, user, "travel-tickets.txt", b"tickets", folder_id=japan.id)
    await _upload(client, user, "travel-outside.txt", b"elsewhere")

    assert _names(await _search(client, user, "travel", type="sheet")) == ["Travel costs.sheet"]
    assert _names(await _search(client, user, "travel", type="office")) == ["travel-itinerary.docx"]
    body = await _search(client, user, "travel", type="folder")
    assert body["hits"] == [] and [f["name"] for f in body["folders"]] == ["Japan travel"]

    body = await _search(client, user, "travel", folder_id=str(trips.id))
    assert _names(body) == ["travel-tickets.txt"]
    assert [f["name"] for f in body["folders"]] == ["Japan travel"]
    assert body["within_trail"] == "My files / Trips"
    pal = await _user(db, "pal")
    r = await client.get("/api/files/search", params={"q": "travel", "folder_id": str(trips.id)}, headers=_auth(pal))
    assert r.status_code == 404
    del inside


@pytest.mark.asyncio
async def test_files_related_by_meaning_come_from_the_ai_index_when_it_is_on(client, db, user, monkeypatch):  # noqa: F811
    from app.custom_models import retrieval
    from app.custom_models.retrieval import RetrievedChunk

    car = await _upload(client, user, "policy.txt", b"Renewal premium for the hatchback, due each March.")
    worded = await _upload(client, user, "insurance-letter.txt", b"car insurance letter")
    seen: dict = {}

    async def fake_drive(db, *, reader_id, query, filters=None):  # noqa: ARG001
        seen["filters"] = filters
        return [
            RetrievedChunk(chunk_id=uuid.uuid4(), user_file_id=uuid.UUID(worded["id"]), text="car insurance letter",
                           score=0.9, chunk_metadata={}, filename="insurance-letter.txt"),
            RetrievedChunk(chunk_id=uuid.uuid4(), user_file_id=uuid.UUID(car["id"]),
                           text="policy Renewal premium for the hatchback, due each March.",
                           score=0.7, chunk_metadata={}, filename="policy.txt"),
        ]

    monkeypatch.setattr(retrieval, "related_drive_hits", fake_drive)

    # AI search off: nothing related, even when asked.
    body = await _search(client, user, "car insurance", semantic="true")
    assert body["related"] == []

    await client.put("/api/files/ai-index", json={"enabled": True, "excluded_folder_ids": []}, headers=_auth(user))
    body = await _search(client, user, "car insurance", semantic="true", type="text", owner="me")
    assert _names(body) == ["insurance-letter.txt"]  # the word match
    assert [h["file"]["filename"] for h in body["related"]] == ["policy.txt"]  # not repeated
    rel = body["related"][0]
    assert rel["match"] == "meaning" and rel["snippet"].startswith("Renewal premium")
    assert rel["breadcrumb"] == "My files"
    assert seen["filters"].type == "text" and seen["filters"].owner == "me"

    # Only on request (the instant results don't pay for an embedding).
    assert (await _search(client, user, "car insurance"))["related"] == []


@pytest.mark.asyncio
async def test_related_means_clearly_above_the_background_not_merely_nearest(db, monkeypatch):
    from app.custom_models import retrieval
    from app.custom_models.retrieval import RetrievedChunk

    def hit(score):
        return RetrievedChunk(chunk_id=uuid.uuid4(), user_file_id=uuid.uuid4(), text="t", score=score,
                              chunk_metadata={}, filename=f"{score}.txt")

    async def vec(db, q):  # noqa: ARG001
        return ("[0.1]", 768, "fake")

    scores: list[float] = []

    async def sim(db, **kw):  # noqa: ARG001
        return [hit(s) for s in scores]

    monkeypatch.setattr(retrieval, "_resolve_query_vector", vec)
    monkeypatch.setattr(retrieval, "_similarity_search", sim)
    reader = uuid.uuid4()
    # One clearly related file over a background of unrelated ones (the real
    # numbers from a nomic-embed-text drive: 0.654 vs 0.415-0.447).
    scores[:] = [0.654, 0.447, 0.435, 0.427, 0.421, 0.418, 0.415, 0.41, 0.4, 0.4, 0.39, 0.39]
    assert [h.score for h in await retrieval.related_drive_hits(db, reader_id=reader, query="car insurance")] == [0.654]
    # Nothing stands out ("holiday photos" on the same drive) → nothing.
    scores[:] = [0.446, 0.438, 0.437, 0.429, 0.427, 0.427, 0.423, 0.399, 0.39, 0.38, 0.38, 0.37]
    assert await retrieval.related_drive_hits(db, reader_id=reader, query="holiday photos") == []
    # Too few files to judge.
    scores[:] = [0.7, 0.4]
    assert await retrieval.related_drive_hits(db, reader_id=reader, query="x") == []

    # No embedder → nothing.
    async def none(db, q):  # noqa: ARG001
        return None

    monkeypatch.setattr(retrieval, "_resolve_query_vector", none)
    assert await retrieval.related_drive_hits(db, reader_id=reader, query="car insurance") == []
