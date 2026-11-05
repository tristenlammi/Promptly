"""Search finds a chat by its name and a word part-way through typing, for you only."""
from __future__ import annotations

import pytest

from app.chat.router import partial_word_query

from .test_mail import H, client, mk_user  # noqa: F401


async def _chat(db, user, title: str, words: str):
    from app.chat.models import Conversation, Message

    conversation = Conversation(user_id=user.id, title=title)
    db.add(conversation)
    await db.flush()
    db.add(Message(conversation_id=conversation.id, role="user", content=words))
    await db.commit()
    return conversation


@pytest.mark.parametrize("typed,expected", [
    ("budg", "budg:*"),
    ("q4 budg", "q4 & budg:*"),
    ("e2e", "e2e:*"),
    ("!!! ::", None),
    ('"exact words"', None),
    ("-not this", None),
    ("a:* | b'", "a & b:*"),
])
def test_what_the_partial_search_looks_for(typed, expected):
    assert partial_word_query(typed) == expected


async def test_a_chat_is_found_by_its_name_first(client, db):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    named = await _chat(db, u, "E2E chat", "Nothing relevant in here")
    await _chat(db, u, "Something else", "Unrelated words")
    url = "/api/chat/conversations/search?q=e2e"
    hits = (await client.get(url, headers=H(u))).json()
    assert [h["conversation_id"] for h in hits] == [str(named.id)] and hits[0]["conversation_title"] == "E2E chat"
    # In any case, part of a word too, and % means itself.
    assert len((await client.get("/api/chat/conversations/search?q=2E%20c", headers=H(u))).json()) == 1
    assert (await client.get("/api/chat/conversations/search?q=%25", headers=H(u))).json() == []
    # Someone else's chat stays out of it.
    assert (await client.get(url, headers=H(other))).json() == []


async def test_a_word_is_found_while_youre_still_typing_it(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    chat = await _chat(db, u, "Money", "The quarterly budget is ready")
    hits = (await client.get("/api/chat/conversations/search?q=quarterl", headers=H(u))).json()
    assert [h["conversation_id"] for h in hits] == [str(chat.id)]
    assert (await client.get("/api/chat/conversations/search?q=zzzz", headers=H(u))).json() == []
    # Odd punctuation can't break it.
    assert (await client.get("/api/chat/conversations/search?q=quarterl%27%3A*%20%7C", headers=H(u))).status_code == 200


async def test_mail_search_matches_part_of_a_word_too(client, db):  # noqa: F811
    from app.mail.apps import quick_search

    from .test_mail import mk_account, mk_message

    u = await mk_user(db, "owner")
    await mk_message(db, await mk_account(db, u), subject="Quarterly numbers")
    assert [h["subject"] for h in await quick_search(db, u, "quarte", 5)] == ["Quarterly numbers"]
