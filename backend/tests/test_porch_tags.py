"""Porch photo tags (WP-P1.5): only people who can see the post, shown only
after their yes ("Show it" / "Not me" from Activity), and face suggestions
only between people who both opted in — from the poster's own Photos people,
never anyone else's."""
from __future__ import annotations

import uuid

from sqlalchemy import text

from tests.porch_kit import H, client, members_of, ok, people, photo, post_photos, quiet, root  # noqa: F401 — fixtures


async def get(client, u, post_id) -> dict:
    return await ok(await client.get(f"/api/porch/posts/{post_id}", headers=H(u)))


def tags_of(post: dict) -> list[tuple[str, str]]:
    return [(t["user"]["id"], t["status"]) for m in post["media"] for t in m["tags"]]


async def requests(client, u) -> list[dict]:
    return (await ok(await client.get("/api/porch/activity", headers=H(u))))["tag_requests"]


async def test_tags_need_a_yes_and_only_people_who_see_it(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    f1 = await photo(client, ann, "a.jpg")
    tagged = [{"user_id": str(bob.id), "x": 0.3, "y": 0.4}, {"user_id": str(dan.id), "x": 0.5, "y": 0.5}, {"user_id": str(ann.id), "x": 0.1, "y": 0.1}]
    post = await post_photos(client, ann, [fam], [{"file_id": f1, "tags": tagged}], "Beach")
    pid = post["id"]
    # Dan can't see it and Ann is the poster: only Bob is asked.
    assert tags_of(post) == [(str(bob.id), "pending")]
    assert post["media"][0]["tags"][0]["x"] == 0.3
    # Until Bob says yes, only he and Ann know.
    assert tags_of(await get(client, bob, pid)) == [(str(bob.id), "pending")]
    assert tags_of(await get(client, cat, pid)) == []
    assert await requests(client, dan) == [] and await requests(client, cat) == []
    req = await requests(client, bob)
    assert len(req) == 1 and req[0]["post"]["id"] == pid and req[0]["by"]["id"] == str(ann.id)
    tag_id = req[0]["id"]
    # Nobody else can answer for him.
    for u in (ann, cat, dan):
        r = await client.post(f"/api/porch/tags/{tag_id}/approve", headers=H(u))
        assert r.status_code == 404

    await ok(await client.post(f"/api/porch/tags/{tag_id}/approve", headers=H(bob)))
    assert tags_of(await get(client, cat, pid)) == [(str(bob.id), "approved")]
    assert await requests(client, bob) == []

    # He can take it off again; then he isn't asked about this photo again.
    await ok(await client.post(f"/api/porch/tags/{tag_id}/decline", headers=H(bob)))
    assert tags_of(await get(client, cat, pid)) == [] and tags_of(await get(client, ann, pid)) == []
    media_id = post["media"][0]["id"]
    again = await ok(await client.patch(f"/api/porch/posts/{pid}", headers=H(ann), json={"media": [{"id": media_id, "tags": tagged}]}))
    assert tags_of(again) == [] and await requests(client, bob) == []

    # The author can tag later (editing) and take a tag off.
    again = await ok(await client.patch(f"/api/porch/posts/{pid}", headers=H(ann), json={"media": [{"id": media_id, "tags": [{"user_id": str(cat.id), "x": 0.6, "y": 0.6}]}]}))
    assert tags_of(again) == [(str(cat.id), "pending")]
    cat_tag = (await requests(client, cat))[0]["id"]
    r = await client.delete(f"/api/porch/tags/{cat_tag}", headers=H(bob))
    assert r.status_code == 404
    await ok(await client.delete(f"/api/porch/tags/{cat_tag}", headers=H(ann)), 204)
    assert await requests(client, cat) == []
    # media without "tags" leaves them as they are.
    again = await ok(await client.patch(f"/api/porch/posts/{pid}", headers=H(ann), json={"media": [{"id": media_id, "tags": [{"user_id": str(cat.id), "x": 0.6, "y": 0.6}]}]}))
    again = await ok(await client.patch(f"/api/porch/posts/{pid}", headers=H(ann), json={"media": [{"id": media_id, "alt_text": "The beach"}]}))
    assert tags_of(again) == [(str(cat.id), "pending")]


async def test_not_me_and_blocks(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    f1 = await photo(client, ann, "a.jpg")
    post = await post_photos(client, ann, [fam], [{"file_id": f1, "tags": [{"user_id": str(bob.id), "x": 0.5, "y": 0.5}, {"user_id": str(cat.id), "x": 0.2, "y": 0.2}]}])
    bob_tag = (await requests(client, bob))[0]["id"]
    await ok(await client.post(f"/api/porch/tags/{bob_tag}/decline", headers=H(bob)))
    assert (str(bob.id), "pending") not in tags_of(await get(client, ann, post["id"]))
    r = await client.post(f"/api/porch/tags/{bob_tag}/approve", headers=H(bob))
    assert r.status_code == 404  # "Not me" is final for this photo
    cat_tag = (await requests(client, cat))[0]["id"]
    await ok(await client.post(f"/api/porch/tags/{cat_tag}/approve", headers=H(cat)))
    # Bob blocks Cat: her tag isn't there for him.
    r = await client.put(f"/api/people/blocks/{cat.id}", headers=H(bob))
    assert r.status_code in (200, 204)
    assert tags_of(await get(client, bob, post["id"])) == []
    assert tags_of(await get(client, ann, post["id"])) == [(str(cat.id), "approved")]
    # Someone with a block with the poster can't be tagged, even in Everyone.
    r = await client.put(f"/api/people/blocks/{ann.id}", headers=H(dan))
    assert r.status_code in (200, 204)
    f2 = await photo(client, ann, "b.jpg")
    post2 = await post_photos(client, ann, "all", [{"file_id": f2, "tags": [{"user_id": str(dan.id), "x": 0.5, "y": 0.5}]}])
    assert tags_of(post2) == []


async def _face(db, owner, file_id, person_id, box=(0.4, 0.2, 0.2, 0.2)) -> None:
    await db.execute(
        text(
            "INSERT INTO photo_faces (file_id, user_id, box_x, box_y, box_w, box_h, score, size_px, model, person_id, embedding) "
            "VALUES (:f, :u, :x, :y, :w, :h, 0.99, 120, 'test', :p, CAST(:e AS vector))"
        ),
        {"f": uuid.UUID(file_id), "u": owner.id, "x": box[0], "y": box[1], "w": box[2], "h": box[3], "p": person_id, "e": "[" + ",".join(["0.01"] * 512) + "]"},
    )


async def _person(db, owner, name, linked) -> uuid.UUID:
    pid = uuid.uuid4()
    await db.execute(
        text("INSERT INTO photo_people (id, user_id, kind, name, linked_user_id) VALUES (:id, :u, 'person', :n, :l)"),
        {"id": pid, "u": owner.id, "n": name, "l": linked.id if linked else None},
    )
    return pid


async def test_face_suggestions_need_both_opt_ins_and_your_own_people(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    f1 = await photo(client, ann, "group.jpg")
    # Ann's Photos knows Bob and Dan (linked to their accounts); Bob's own
    # Photos has a person linked to Cat, whose face sits on Ann's photo row
    # (it must never be used: not Ann's people).
    p_bob = await _person(db, ann, "Bob", bob)
    p_dan = await _person(db, ann, "Dan", dan)
    p_cat_by_bob = await _person(db, bob, "Cat", cat)
    await _face(db, ann, f1, p_bob, (0.1, 0.2, 0.2, 0.2))
    await _face(db, ann, f1, p_dan, (0.6, 0.2, 0.2, 0.2))
    await _face(db, ann, f1, p_cat_by_bob, (0.4, 0.6, 0.2, 0.2))
    await db.commit()

    async def suggest(u=ann, **body):
        return await ok(await client.post("/api/porch/compose/tag-suggestions", headers=H(u), json={"file_ids": [f1], "groups": [fam], **body}))

    got = await suggest()
    assert got == {"enabled": False, "suggestions": []}  # Ann hasn't opted in
    await ok(await client.patch("/api/porch/me/profile", headers=H(ann), json={"face_suggestions": True}))
    assert (await suggest())["suggestions"] == []  # nor has Bob
    for u in (bob, cat, dan):
        await ok(await client.patch("/api/porch/me/profile", headers=H(u), json={"face_suggestions": True}))
    got = (await suggest())["suggestions"]
    # Bob (in Family, both opted in), at the middle of his face. Not Dan (he
    # wouldn't see the post), not Cat (only Bob's Photos knows her face).
    assert [(s["user"]["id"], s["file_id"], s["x"], s["y"]) for s in got] == [(str(bob.id), f1, 0.2, 0.3)]
    # To everyone: Dan would see it now.
    got = (await suggest(groups="all"))["suggestions"]
    assert {s["user"]["id"] for s in got} == {str(bob.id), str(dan.id)}
    # Someone else's photo gives nothing.
    assert (await suggest(u=bob))["suggestions"] == []
    # An existing post: its audience.
    post = await post_photos(client, ann, [fam], [f1])
    got = (await ok(await client.post("/api/porch/compose/tag-suggestions", headers=H(ann), json={"file_ids": [f1], "post_id": post["id"]})))["suggestions"]
    assert [s["user"]["id"] for s in got] == [str(bob.id)]
    # Bob opting out stops it.
    await ok(await client.patch("/api/porch/me/profile", headers=H(bob), json={"face_suggestions": False}))
    assert (await suggest())["suggestions"] == []
