"""Notes N2.5: the person page's Notes section (and the shared sections registry).

* only notes both of you can open: shared between you, or shared with both of
  you by someone else; never a note only Sam can open, never your own private
  ones, never one in Trash;
* "See all" (``/notes?with=``) is the same set;
* a section that fails leaves the page working.
"""
from __future__ import annotations

from tests.test_notes_core import H, client, live, mk_user, new_list, new_note, share  # noqa: F401 — fixtures


async def page(client, viewer, target):  # noqa: F811
    r = await client.get(f"/api/people/u/{target.id}", headers=H(viewer))
    assert r.status_code == 200, r.text
    return r.json()


def notes_of(p) -> list[dict]:
    return next((s["items"] for s in p["sections"] if s["key"] == "notes"), [])


async def test_only_notes_you_both_can_open(client, db, live):  # noqa: F811
    ann, sam, mum = await mk_user(db, "ann"), await mk_user(db, "sam"), await mk_user(db, "mum")
    mine = await new_note(client, ann, title="Ann only")
    sams = await new_note(client, sam, title="Sam only")
    ours = await new_list(client, ann, title="Shopping", items=("Eggs", "Milk"))
    await share(client, ann, ours["id"], sam)
    family = await new_note(client, mum, title="Family list")
    await share(client, mum, family["id"], ann, sam)
    sam_and_mum = await new_note(client, mum, title="Mum and Sam")
    await share(client, mum, sam_and_mum["id"], sam)
    gone = await new_note(client, ann, title="Old")
    await share(client, ann, gone["id"], sam)
    assert (await client.delete(f"/api/notes/{gone['id']}", headers=H(ann))).status_code == 200

    p = await page(client, ann, sam)
    got = notes_of(p)
    assert {n["id"] for n in got} == {ours["id"], family["id"]}
    for hidden in (mine, sams, sam_and_mum, gone):
        assert hidden["id"] not in str(p)
    shop = next(n for n in got if n["id"] == ours["id"])
    assert shop["subtitle"] == "2 left · Yours" and shop["kind"] == "list" and shop["href"] == f"/notes/n/{ours['id']}"
    fam = next(n for n in got if n["id"] == family["id"])
    assert fam["owner"].startswith("mum") and fam["subtitle"].endswith("'s")
    section = next(s for s in p["sections"] if s["key"] == "notes")
    assert section["more_url"] == f"/notes?with={sam.id}" and section["kind"] == "grid"

    # "See all": the same notes, from Notes.
    r = await client.get("/api/notes", headers=H(ann), params={"with": str(sam.id)})
    assert {n["id"] for n in r.json()["notes"]} == {ours["id"], family["id"]}

    # Sam sees the same two on Ann's page; Mum and Sam's note isn't on Mum's page for Ann.
    assert {n["id"] for n in notes_of(await page(client, sam, ann))} == {ours["id"], family["id"]}
    assert {n["id"] for n in notes_of(await page(client, ann, mum))} == {family["id"]}


async def test_no_section_when_nothing_is_shared_or_on_your_own_page(client, db, live):  # noqa: F811
    ann, sam = await mk_user(db, "ann"), await mk_user(db, "sam")
    await new_note(client, ann, title="Mine")
    assert notes_of(await page(client, ann, sam)) == []
    assert [s["key"] for s in (await page(client, ann, sam))["sections"]] == []
    assert (await page(client, ann, ann))["sections"] == []


async def test_a_failing_section_leaves_the_page_working(client, db, live, monkeypatch):  # noqa: F811
    from app.people import sections

    ann, sam = await mk_user(db, "ann"), await mk_user(db, "sam")
    ours = await new_note(client, ann, title="Ours")
    await share(client, ann, ours["id"], sam)
    sections.registered()  # the built-in ones are in

    async def broken(db, viewer, target):  # noqa: ANN001
        raise RuntimeError("boom")

    monkeypatch.setitem(sections._REGISTRY, "broken", sections.Section(key="broken", title="Broken", fn=broken, order=1))
    p = await page(client, ann, sam)
    assert [s["key"] for s in p["sections"]] == ["notes"] and p["name"]
