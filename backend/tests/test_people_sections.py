"""Person page sections (WP-P3.3): one failing or slow section doesn't break
the page, and Porch's "On Porch" obeys ``visible_post`` and blocks — Sam's
person page shows Mum his Family posts and nothing from The Lads."""
from __future__ import annotations

import asyncio

from tests.porch_kit import H, client, members_of, ok, people, quiet, root, say, set_porch  # noqa: F401 — fixtures


async def page(client, viewer, target) -> dict:
    return await ok(await client.get(f"/api/people/u/{target.id}", headers=H(viewer)))


def section(p: dict, key: str) -> dict | None:
    return next((s for s in p["sections"] if s["key"] == key), None)


async def test_on_porch_shows_only_what_you_can_see(client, db, people):
    ann, sam, mum, mate = people
    fam = await members_of(client, sam, "Family", [mum])
    lads = await members_of(client, sam, "The Lads", [mate])
    f1 = await say(client, sam, [fam], "Sunday roast")
    await say(client, sam, [lads], "Fishing trip")
    f2 = await say(client, sam, [fam], "Kids at the beach")

    got = section(await page(client, mum, sam), "porch")
    assert got is not None and got["title"] == "On Porch" and got["kind"] == "grid"
    assert [i["id"] for i in got["items"]] == [f2["id"], f1["id"]]
    assert got["items"][0]["title"] == "Kids at the beach" and got["items"][0]["href"] == f"/porch/p/{f2['id']}"
    assert got["more_url"] == f"/porch/u/{sam.id}" and got["more_label"] == "See all on Porch"
    assert got["note"] == "Groups you're both in: Family"
    # The mate sees only The Lads.
    mates = section(await page(client, mate, sam), "porch")
    assert [i["title"] for i in mates["items"]] == ["Fishing trip"] and mates["note"] == "Groups you're both in: The Lads"
    # Your own page: no Porch section about yourself.
    assert section(await page(client, sam, sam), "porch") is None

    # A block either way: nothing.
    await ok(await client.put(f"/api/people/blocks/{sam.id}", headers=H(mum)))
    assert section(await page(client, mum, sam), "porch") is None
    await ok(await client.delete(f"/api/people/blocks/{sam.id}", headers=H(mum)))
    assert section(await page(client, mum, sam), "porch") is not None
    # Porch off: nothing.
    await set_porch(db, porch_enabled=False)
    assert section(await page(client, mum, sam), "porch") is None


async def test_a_failing_or_slow_section_never_breaks_the_page(client, db, people, monkeypatch):
    from app.people import sections

    ann, sam, mum, _ = people
    fam = await members_of(client, sam, "Family", [mum])
    await say(client, sam, [fam], "Still here")
    sections.registered()  # Porch's is in

    async def broken(db, viewer, target):
        raise RuntimeError("boom")

    async def slow(db, viewer, target):
        await asyncio.sleep(10)
        return {"kind": "list", "items": [{"id": "x", "title": "late"}]}

    async def fine(db, viewer, target):
        return {"kind": "list", "items": [{"id": "1", "title": f"Hello {target.username}", "subtitle": "", "href": "/x"}]}

    monkeypatch.setattr(sections, "TIMEOUT_SECONDS", 0.3)
    monkeypatch.setitem(sections._REGISTRY, "test_broken", sections.Section("test_broken", "Broken", broken, 1))
    monkeypatch.setitem(sections._REGISTRY, "test_slow", sections.Section("test_slow", "Slow", slow, 2))
    monkeypatch.setitem(sections._REGISTRY, "test_fine", sections.Section("test_fine", "Fine", fine, 99))
    p = await page(client, mum, sam)
    keys = [s["key"] for s in p["sections"]]
    assert keys == ["porch", "test_fine"]
    assert section(p, "test_fine")["items"][0]["title"] == f"Hello {sam.username}"
    # The page's own parts are all there.
    assert p["user"]["id"] == str(sam.id) and "events" in p and "rooms" in p
