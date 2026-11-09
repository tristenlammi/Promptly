"""Porch talking (WP-P1.5): comments with one level of replies, editing and
deleting (D5: the post's author deletes any comment on their post),
reactions whose names only the author sees, polls (one vote, changeable,
closing, D4 results), mentions only for people who can see the post, saved
posts, Activity and its badge — and blocks filtering all of it."""
from __future__ import annotations

import uuid
from datetime import timedelta

from tests.porch_kit import H, boot, client, members_of, ok, people, quiet, root, say  # noqa: F401 — fixtures


async def comment(client, u, post_id, body, parent=None, mentions=()) -> dict:
    payload = {"body": body, "parent_id": parent, "mentions": [str(m) for m in mentions]}
    return await ok(await client.post(f"/api/porch/posts/{post_id}/comments", headers=H(u), json=payload), 201)


async def comments(client, u, post_id) -> dict:
    return await ok(await client.get(f"/api/porch/posts/{post_id}/comments", headers=H(u)))


async def get(client, u, post_id) -> dict:
    return await ok(await client.get(f"/api/porch/posts/{post_id}", headers=H(u)))


async def activity(client, u) -> dict:
    return await ok(await client.get("/api/porch/activity", headers=H(u)))


async def block(client, a, b) -> None:
    r = await client.put(f"/api/people/blocks/{b.id}", headers=H(a))
    assert r.status_code in (200, 204), r.text


async def test_comments_have_one_level_of_replies(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "BBQ Saturday"))["id"]
    other = (await say(client, ann, [fam], "Another"))["id"]

    first = await comment(client, bob, post, "I'm in")
    second = await comment(client, cat, post, "Me too")
    reply = await comment(client, ann, post, "Great!", parent=first["id"])
    assert reply["parent_id"] == first["id"]
    # A reply to a reply hangs off the same top comment.
    deeper = await comment(client, bob, post, f"@{ann.username} what time?", parent=reply["id"], mentions=[ann.id])
    assert deeper["parent_id"] == first["id"]
    assert [m["id"] for m in deeper["mentions"]] == [str(ann.id)]

    got = await comments(client, cat, post)
    assert got["count"] == 4
    assert [c["body"] for c in got["comments"]] == ["I'm in", "Me too"]  # oldest first
    assert [r["body"] for r in got["comments"][0]["replies"]] == ["Great!", f"@{ann.username} what time?"]
    assert all(r["parent_id"] == first["id"] for r in got["comments"][0]["replies"])

    # The post carries the count and the latest two.
    p = await get(client, cat, post)
    assert p["comment_count"] == 4
    assert [c["body"] for c in p["latest_comments"]] == ["Great!", f"@{ann.username} what time?"]

    # Replying across posts, or to nothing, is a 404.
    r = await client.post(f"/api/porch/posts/{other}/comments", headers=H(bob), json={"body": "x", "parent_id": first["id"]})
    assert r.status_code == 404
    r = await client.post(f"/api/porch/posts/{post}/comments", headers=H(bob), json={"body": "x", "parent_id": str(uuid.uuid4())})
    assert r.status_code == 404
    r = await client.post(f"/api/porch/posts/{post}/comments", headers=H(bob), json={"body": "   "})
    assert r.status_code == 400
    # Someone who can't see the post can't read or write its comments.
    for r in (
        await client.get(f"/api/porch/posts/{post}/comments", headers=H(dan)),
        await client.post(f"/api/porch/posts/{post}/comments", headers=H(dan), json={"body": "hi"}),
    ):
        assert r.status_code == 404


async def test_edit_and_delete_own_and_the_authors_d5(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "Photos from Sunday"))["id"]
    mine = await comment(client, bob, post, "Lovely")
    theirs = await comment(client, cat, post, "Who's that?")
    reply = await comment(client, bob, post, "That's Sam", parent=theirs["id"])
    assert mine["can_edit"] and mine["can_delete"]

    # Others can't change or delete your comment...
    r = await client.patch(f"/api/porch/comments/{mine['id']}", headers=H(cat), json={"body": "hacked"})
    assert r.status_code == 403
    r = await client.delete(f"/api/porch/comments/{mine['id']}", headers=H(cat))
    assert r.status_code == 403
    # ...you can.
    edited = await ok(await client.patch(f"/api/porch/comments/{mine['id']}", headers=H(bob), json={"body": "Lovely photos"}))
    assert edited["body"] == "Lovely photos" and edited["edited_at"]

    # D5: the post's author deletes anyone's comment on their post.
    seen = await comments(client, ann, post)
    assert all(c["can_delete"] for c in seen["comments"]) and not any(c["can_edit"] for c in seen["comments"])
    await ok(await client.delete(f"/api/porch/comments/{theirs['id']}", headers=H(ann)), 204)
    got = await comments(client, bob, post)
    # A deleted comment with replies keeps its place, emptied.
    assert [c["deleted"] for c in got["comments"]] == [False, True]
    assert got["comments"][1]["body"] == "" and got["comments"][1]["author"] is None
    assert [r["body"] for r in got["comments"][1]["replies"]] == ["That's Sam"]
    await ok(await client.delete(f"/api/porch/comments/{reply['id']}", headers=H(bob)), 204)
    got = await comments(client, bob, post)
    assert [c["body"] for c in got["comments"]] == ["Lovely photos"] and got["count"] == 1
    # A deleted comment can't be edited or replied to.
    r = await client.patch(f"/api/porch/comments/{theirs['id']}", headers=H(cat), json={"body": "again"})
    assert r.status_code == 404
    r = await client.post(f"/api/porch/posts/{post}/comments", headers=H(cat), json={"body": "x", "parent_id": theirs["id"]})
    assert r.status_code == 404

    # On someone else's post, you're not its author: no D5 for you.
    cats = (await say(client, cat, [fam], "Mine"))["id"]
    c = await comment(client, bob, cats, "Nice")
    r = await client.delete(f"/api/porch/comments/{c['id']}", headers=H(ann))
    assert r.status_code == 403
    await ok(await client.delete(f"/api/porch/comments/{c['id']}", headers=H(cat)), 204)


async def test_reactions_only_the_author_sees_who(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "New puppy"))["id"]

    mine = await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(bob), json={"emoji": "❤️"}))
    assert mine == {"emojis": ["❤️"], "mine": "❤️"}
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(cat), json={"emoji": "😂"}))
    r = await client.put(f"/api/porch/posts/{post}/reactions", headers=H(cat), json={"emoji": "🍕"})
    assert r.status_code == 400

    # The author: who reacted.
    a = (await get(client, ann, post))["reactions"]
    assert sorted(a["emojis"]) == sorted(["❤️", "😂"]) and a["mine"] is None
    assert [u["id"] for u in a["people"]] == [str(cat.id), str(bob.id)] and a["count"] == 2
    who = await ok(await client.get(f"/api/porch/posts/{post}/reactions", headers=H(ann)))
    assert {(w["user"]["id"], w["emoji"]) for w in who} == {(str(bob.id), "❤️"), (str(cat.id), "😂")}
    # Anyone else: only which emoji, no names, no numbers.
    b = (await get(client, bob, post))["reactions"]
    assert set(b) == {"emojis", "mine"} and b["mine"] == "❤️"
    r = await client.get(f"/api/porch/posts/{post}/reactions", headers=H(bob))
    assert r.status_code == 403
    assert str(bob.id) not in str(await get(client, cat, post))
    # One each: a new emoji replaces yours; taking it back removes it.
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(bob), json={"emoji": "👍"}))
    assert sorted((await get(client, ann, post))["reactions"]["emojis"]) == sorted(["👍", "😂"])
    await ok(await client.delete(f"/api/porch/posts/{post}/reactions", headers=H(bob)))
    assert (await get(client, ann, post))["reactions"]["count"] == 1
    # Outsiders can't react.
    r = await client.put(f"/api/porch/posts/{post}/reactions", headers=H(dan), json={"emoji": "❤️"})
    assert r.status_code == 404

    # Comments too: the comment's author sees who.
    c = await comment(client, bob, post, "So cute")
    await ok(await client.put(f"/api/porch/comments/{c['id']}/reactions", headers=H(ann), json={"emoji": "❤️"}))
    got = (await comments(client, bob, post))["comments"][0]["reactions"]
    assert [u["id"] for u in got["people"]] == [str(ann.id)]
    got = (await comments(client, cat, post))["comments"][0]["reactions"]
    assert got == {"emojis": ["❤️"], "mine": None}
    r = await client.get(f"/api/porch/comments/{c['id']}/reactions", headers=H(cat))
    assert r.status_code == 403
    assert len(await ok(await client.get(f"/api/porch/comments/{c['id']}/reactions", headers=H(bob)))) == 1


async def test_polls_vote_change_close_and_who_voted(client, db, people):
    from app.porch.models import PorchPost

    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])

    async def poll(body="Pizza or pasta?", **p):
        return await client.post("/api/porch/posts", headers=H(ann), json={"kind": "poll", "body": body, "groups": [fam], "poll": p})

    assert (await poll(options=["Only one"])).status_code == 422
    assert (await poll(options=[str(i) for i in range(7)])).status_code == 422
    assert (await poll(options=["Pizza", "pizza"])).status_code == 400
    assert (await poll(options=["Pizza", "  "])).status_code == 400
    assert (await poll(body=" ", options=["Pizza", "Pasta"])).status_code == 400
    forever = await ok(await poll(options=["Yes", "No"]), 201)
    assert forever["kind"] == "poll" and forever["poll"]["closes_at"] is None and not forever["poll"]["closed"]
    got = await ok(await poll(options=["Pizza", "Pasta", "Tacos"], closes="1d"), 201)
    pid = got["id"]
    assert got["poll"]["closes_at"] and [o["label"] for o in got["poll"]["options"]] == ["Pizza", "Pasta", "Tacos"]
    pizza, pasta, _ = [o["id"] for o in got["poll"]["options"]]

    # Before you vote: no results (the author always sees them).
    b = (await get(client, bob, pid))["poll"]
    assert not b["show_results"] and b["options"][0]["votes"] is None and b["total"] is None
    assert (await get(client, ann, pid))["poll"]["show_results"]

    b = (await ok(await client.put(f"/api/porch/posts/{pid}/vote", headers=H(bob), json={"option_id": pizza})))["poll"]
    assert b["my_vote"] == pizza and [o["votes"] for o in b["options"]] == [1, 0, 0]
    # D4: who voted for what, for everyone who sees it (once they've voted).
    assert [u["id"] for u in b["options"][0]["voters"]] == [str(bob.id)]
    assert not (await get(client, cat, pid))["poll"]["show_results"]
    c = (await ok(await client.put(f"/api/porch/posts/{pid}/vote", headers=H(cat), json={"option_id": pasta})))["poll"]
    assert [o["votes"] for o in c["options"]] == [1, 1, 0] and [u["id"] for u in c["options"][0]["voters"]] == [str(bob.id)]
    # One vote each, changeable.
    b = (await ok(await client.put(f"/api/porch/posts/{pid}/vote", headers=H(bob), json={"option_id": pasta})))["poll"]
    assert [o["votes"] for o in b["options"]] == [0, 2, 0] and b["total"] == 2
    b = (await ok(await client.delete(f"/api/porch/posts/{pid}/vote", headers=H(bob))))["poll"]
    assert b["my_vote"] is None and not b["show_results"]
    await ok(await client.put(f"/api/porch/posts/{pid}/vote", headers=H(bob), json={"option_id": pizza}))

    # Another poll's option, a post that isn't a poll, and outsiders.
    r = await client.put(f"/api/porch/posts/{forever['id']}/vote", headers=H(bob), json={"option_id": pizza})
    assert r.status_code == 404
    text_post = (await say(client, ann, [fam], "not a poll"))["id"]
    r = await client.put(f"/api/porch/posts/{text_post}/vote", headers=H(bob), json={"option_id": pizza})
    assert r.status_code == 404
    r = await client.put(f"/api/porch/posts/{pid}/vote", headers=H(dan), json={"option_id": pizza})
    assert r.status_code == 404

    # Closed: no more voting; everyone sees the results.
    row = await db.get(PorchPost, uuid.UUID(pid))
    row.poll_closes_at = row.poll_closes_at - timedelta(days=2)
    await db.commit()
    r = await client.put(f"/api/porch/posts/{pid}/vote", headers=H(cat), json={"option_id": pizza})
    assert r.status_code == 400 and r.json()["detail"] == "This poll has closed"
    a = (await get(client, cat, pid))["poll"]
    assert a["closed"] and [o["votes"] for o in a["options"]] == [1, 1, 0]
    # The question can be edited; options can't.
    r = await client.patch(f"/api/porch/posts/{pid}", headers=H(ann), json={"body": ""})
    assert r.status_code == 400


async def test_blocks_hide_comments_reactions_and_votes(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "Hello"))["id"]
    b = await comment(client, bob, post, "From Bob")
    c = await comment(client, cat, post, "From Cat")
    await comment(client, ann, post, "Reply to Bob", parent=b["id"])
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(bob), json={"emoji": "😮"}))
    poll = await ok(await client.post("/api/porch/posts", headers=H(ann), json={"kind": "poll", "body": "Q?", "groups": [fam], "poll": {"options": ["A", "B"]}}), 201)
    a_opt = poll["poll"]["options"][0]["id"]
    await ok(await client.put(f"/api/porch/posts/{poll['id']}/vote", headers=H(bob), json={"option_id": a_opt}))

    await block(client, cat, bob)
    # Cat sees nothing of Bob's: his comment (and its thread), reaction, vote.
    got = await comments(client, cat, post)
    assert [x["body"] for x in got["comments"]] == ["From Cat"] and got["count"] == 1
    p = await get(client, cat, post)
    assert p["comment_count"] == 1 and p["reactions"]["emojis"] == [] and "From Bob" not in str(p)
    await ok(await client.put(f"/api/porch/posts/{poll['id']}/vote", headers=H(cat), json={"option_id": a_opt}))
    pc = (await get(client, cat, poll["id"]))["poll"]
    assert pc["options"][0]["votes"] == 1 and [u["id"] for u in pc["options"][0]["voters"]] == [str(cat.id)]
    # And the other way round.
    got = await comments(client, bob, post)
    assert "From Cat" not in str(got)
    r = await client.post(f"/api/porch/posts/{post}/comments", headers=H(bob), json={"body": "hey", "parent_id": c["id"]})
    assert r.status_code == 404
    r = await client.put(f"/api/porch/comments/{c['id']}/reactions", headers=H(bob), json={"emoji": "👍"})
    assert r.status_code == 404
    # A mention across a block is dropped.
    m = await comment(client, bob, post, f"@{cat.username} hi", mentions=[cat.id])
    assert m["mentions"] == []
    # The post's author still sees everyone.
    got = await comments(client, ann, post)
    assert {x["body"] for x in got["comments"]} == {"From Bob", "From Cat", f"@{cat.username} hi"}
    who = await ok(await client.get(f"/api/porch/posts/{post}/reactions", headers=H(ann)))
    assert [w["user"]["id"] for w in who] == [str(bob.id)]


async def test_mentions_reach_only_people_who_can_see_it(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "Dinner", mentions=[str(bob.id), str(dan.id)]))
    assert [m["id"] for m in post["mentions"]] == [str(bob.id)]
    # In a comment: picked or typed as @username, never someone outside.
    c = await comment(client, bob, post["id"], f"@{cat.username} @{dan.username} come along", mentions=[dan.id])
    assert [m["id"] for m in c["mentions"]] == [str(cat.id)]

    acts = await activity(client, cat)
    assert [(i["kind"], i["actors"][0]["id"]) for i in acts["items"]] == [("mention", str(bob.id))]
    acts = await activity(client, bob)
    assert [(i["kind"], i["post"]["id"]) for i in acts["items"]] == [("mention", post["id"])]
    assert (await activity(client, dan))["items"] == []
    # Someone who leaves the group stops seeing it in Activity too.
    await ok(await client.delete(f"/api/porch/groups/{fam}/members/{cat.id}", headers=H(cat)), 204)
    assert (await activity(client, cat))["items"] == []


async def test_saved_posts(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    one = (await say(client, ann, [fam], "one"))["id"]
    two = (await say(client, ann, [fam], "two"))["id"]
    assert not (await get(client, bob, one))["saved"]
    await ok(await client.put(f"/api/porch/posts/{one}/save", headers=H(bob)))
    await ok(await client.put(f"/api/porch/posts/{two}/save", headers=H(bob)))
    await ok(await client.put(f"/api/porch/posts/{one}/save", headers=H(bob)))  # idempotent
    assert (await get(client, bob, one))["saved"]
    got = await ok(await client.get("/api/porch/saved", headers=H(bob)))
    assert [p["id"] for p in got["posts"]] == [two, one]  # last saved first
    assert (await ok(await client.get("/api/porch/saved", headers=H(ann))))["posts"] == []  # private
    r = await client.put(f"/api/porch/posts/{one}/save", headers=H(dan))
    assert r.status_code == 404
    await ok(await client.delete(f"/api/porch/posts/{two}/save", headers=H(bob)))
    # A post no longer shared with you drops out of your list.
    await ok(await client.delete(f"/api/porch/groups/{fam}/members/{bob.id}", headers=H(bob)), 204)
    assert (await ok(await client.get("/api/porch/saved", headers=H(bob))))["posts"] == []


async def test_activity_and_its_badge(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob, cat])
    post = (await say(client, ann, [fam], "Holiday"))["id"]
    assert (await boot(client, ann))["activity_unseen"] == 0

    b = await comment(client, bob, post, "Jealous!")
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(bob), json={"emoji": "❤️"}))
    await ok(await client.put(f"/api/porch/posts/{post}/reactions", headers=H(cat), json={"emoji": "😮"}))
    await comment(client, cat, post, "Me too", parent=b["id"])
    await ok(await client.put(f"/api/porch/comments/{b['id']}/reactions", headers=H(ann), json={"emoji": "😂"}))

    acts = await activity(client, ann)
    kinds = [(i["kind"], i.get("target")) for i in acts["items"]]
    assert ("comment", "post") in kinds and ("reaction", "post") in kinds
    rx = next(i for i in acts["items"] if i["kind"] == "reaction")
    assert {u["id"] for u in rx["actors"]} == {str(bob.id), str(cat.id)} and set(rx["emoji"]) == {"❤️", "😮"}
    assert sum(1 for i in acts["items"] if i["kind"] == "comment") == 2  # Bob's and Cat's reply, on Ann's post
    assert acts["unseen"] == len(acts["items"]) == 3
    assert (await boot(client, ann))["activity_unseen"] == 3

    # Bob: Cat replied to his comment, Ann reacted to it.
    acts = await activity(client, bob)
    assert sorted(i["kind"] for i in acts["items"]) == ["reaction", "reply"]
    assert next(i for i in acts["items"] if i["kind"] == "reaction")["target"] == "comment"

    # Opening Activity clears the badge; invites keep counting until answered.
    await ok(await client.post("/api/porch/activity/seen", headers=H(ann)))
    acts = await activity(client, ann)
    assert acts["unseen"] == 0 and not any(i["unseen"] for i in acts["items"])
    lads = await members_of(client, dan, "The Lads", [])
    await ok(await client.post(f"/api/porch/groups/{lads}/invites", headers=H(dan), json={"user_ids": [str(ann.id)]}))
    acts = await activity(client, ann)
    assert [g["id"] for g in acts["invites"]] == [lads] and acts["unseen"] == 1

    # Blocking someone takes their activity away.
    await block(client, ann, cat)
    acts = await activity(client, ann)
    assert str(cat.id) not in str(acts["items"])
    # Your own actions are never your activity.
    assert all(str(ann.id) not in [u["id"] for u in i["actors"]] for i in acts["items"])
