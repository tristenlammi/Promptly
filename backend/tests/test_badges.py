"""Sidebar count badges (``GET /api/badges``): each app's number, the
person's time zone, nobody else's things, Porch only for people it's on
for, and a provider that breaks costs its own row's number, never the page."""
from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select, text

from tests.porch_kit import H, boot, client, members_of, mk_user, ok, quiet, root, say, set_porch  # noqa: F401

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _no_background(monkeypatch):
    """Rooms endpoints spawn push fan-out and @promptly: not wanted here."""
    import app.rooms.router as r

    monkeypatch.setattr(r, "spawn", lambda coro, name=None: coro.close())


async def badges(client, u, apps: str | None = None) -> dict:  # noqa: F811
    return await ok(await client.get("/api/badges", headers=H(u), params={"apps": apps} if apps is not None else None))


async def _zone(db, u, name: str) -> None:
    u.settings = {**(u.settings or {}), "timezone": name}
    await db.commit()


# ------------------------------------------------------------------ tasks


async def _tasks(client, u, tasks: list[dict]) -> str:  # noqa: F811
    assert (await client.post("/api/items/store/tasks", headers=H(u))).status_code == 200
    r = await client.post("/api/items", headers=H(u), json={"kind": "tasks"})
    assert r.status_code in (200, 201), r.text
    fid = r.json()["file_id"]
    r = await client.post(f"/api/items/{fid}/actions/add_tasks", headers=H(u), json={"args": {"tasks": tasks}})
    assert r.status_code == 200, r.text
    return fid


async def test_tasks_due_today_or_overdue_in_your_time_zone(client, db):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    # Kiritimati is UTC+14, Pago Pago UTC-11: always a different date.
    east, west = ZoneInfo("Pacific/Kiritimati"), ZoneInfo("Pacific/Pago_Pago")
    await _zone(db, ann, "Pacific/Kiritimati")
    k_today = datetime.now(UTC).astimezone(east).date()
    fid = await _tasks(client, ann, [
        {"title": "Pay rent", "due": k_today.isoformat()},
        {"title": "Old one", "due": (k_today - timedelta(days=3)).isoformat()},
        {"title": "Tomorrow", "due": (k_today + timedelta(days=1)).isoformat()},
        {"title": "Someday"},
    ])
    assert (await badges(client, ann))["tasks"] == 2
    # Someone else's tasks are never yours; no Tasks file is 0, not an error.
    assert (await badges(client, bob))["tasks"] == 0

    # The same file read in Pago Pago: "today" there is a day or two behind
    # Kiritimati's, so the rent isn't due yet; the old one still is.
    await _zone(db, ann, "Pacific/Pago_Pago")
    w_today = datetime.now(UTC).astimezone(west).date()
    assert w_today < k_today
    assert (await badges(client, ann))["tasks"] == 1  # only the overdue one

    # Ticking one off takes it off the badge.
    await _zone(db, ann, "Pacific/Kiritimati")
    r = await client.post(f"/api/items/{fid}/actions/complete_tasks", headers=H(ann), json={"args": {"tasks": ["Pay rent"]}})
    assert r.status_code == 200, r.text
    assert (await badges(client, ann))["tasks"] == 1


# ------------------------------------------------------------------ mail


async def _mail(db, account, *, seen=False, folder_role="inbox", uid=1, thread=None):
    from app.mail.models import MailFolder, MailMessage

    folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == account.id, MailFolder.role == folder_role))
    if folder is None:
        folder = MailFolder(account_id=account.id, path=folder_role.upper(), name=folder_role.title(), role=folder_role)
        db.add(folder)
        await db.flush()
    m = MailMessage(
        account_id=account.id, folder_id=folder.id, uid=uid, thread_key=thread or uuid.uuid4().hex, message_id=f"<{uuid.uuid4().hex}@x>",
        subject="Hi", from_name="Sam", from_addr="sam@example.com", to_addrs=[], cc_addrs=[], sent_at=datetime.now(UTC),
        snippet="x", body_text="x", body_html="", attachments=[], seen=seen,
    )
    db.add(m)
    await db.commit()
    return m


async def _account(db, u, email):
    from app.mail.models import MailAccount

    a = MailAccount(
        user_id=u.id, email=email, imap_host="imap.example.com", imap_port=993, imap_security="ssl",
        smtp_host="imap.example.com", smtp_port=465, smtp_security="ssl", username=email, secret_encrypted="x",
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a


async def test_mail_counts_unread_inbox_conversations_across_your_accounts(client, db):  # noqa: F811
    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    assert (await badges(client, ann))["mail"] == 0  # no accounts yet
    home, work = await _account(db, ann, "ann@home.example"), await _account(db, ann, "ann@work.example")
    first = await _mail(db, home, uid=1)
    await _mail(db, home, uid=2, thread=first.thread_key)  # same conversation: counts once
    await _mail(db, work, uid=1)
    await _mail(db, work, uid=2, seen=True)  # read
    await _mail(db, work, uid=3, folder_role="archive")  # not in the Inbox
    assert (await badges(client, ann))["mail"] == 2
    assert (await badges(client, bob))["mail"] == 0
    # Reading it in Mail clears it (the badge reads the same flag).
    await db.execute(text("UPDATE mail_messages SET seen = true WHERE account_id = :a"), {"a": home.id})
    await db.commit()
    assert (await badges(client, ann))["mail"] == 1


# ------------------------------------------------------------------ rooms


async def _space(client, owner, *members):  # noqa: F811
    r = await client.post("/api/rooms/spaces", headers=H(owner), json={"name": "Family", "emoji": "🏡"})
    assert r.status_code == 201, r.text
    sid, rid = r.json()["id"], r.json()["room_id"]
    r = await client.post(f"/api/rooms/spaces/{sid}/members", headers=H(owner), json={"user_ids": [str(m.id) for m in members]})
    assert r.status_code == 200, r.text
    return sid, rid


async def _say(client, u, room_id, body):  # noqa: F811
    r = await client.post(f"/api/rooms/rooms/{room_id}/messages", headers=H(u), json={"body": body})
    assert r.status_code == 201, r.text
    return r.json()


def _app_total(b: dict) -> int:
    """``totals(b).total`` from frontend/src/rooms/cache.ts, in Python."""
    total = 0
    for s in b["spaces"]:
        for r in s["rooms"]:
            n = r.get("notify") or s.get("notify") or "all"
            if n == "all":
                total += r["unread"]
            elif n == "mentions":
                total += r["mentions"]
    for r in b["dms"]:
        if (r.get("notify") or "all") != "none":
            total += r["unread"]
    return total


async def test_rooms_matches_what_the_rooms_app_counts(client, db):  # noqa: F811
    ann, bob, cat, dan = [await mk_user(db, n) for n in ("ann", "bob", "cat", "dan")]
    sid, room = await _space(client, ann, bob, cat, dan)
    # cat hears only mentions; dan muted the room.
    await client.patch(f"/api/rooms/spaces/{sid}/me", headers=H(cat), json={"notify": "mentions"})
    await client.patch(f"/api/rooms/rooms/{room}/me", headers=H(dan), json={"notify": "none"})
    await _say(client, ann, room, "Who's in for Saturday?")
    last = await _say(client, ann, room, f"@{cat.username} you in?")
    r = await client.post("/api/rooms/dms", headers=H(ann), json={"user_ids": [str(bob.id)]})
    assert r.status_code in (200, 201), r.text
    dm = r.json()["id"]
    await _say(client, ann, dm, "psst")

    got = {u.username: (await badges(client, u))["rooms"] for u in (ann, bob, cat, dan)}
    assert got == {ann.username: 0, bob.username: 3, cat.username: 1, dan.username: 0}
    for u in (ann, bob, cat, dan):
        b = await ok(await client.get("/api/rooms/bootstrap", headers=H(u)))
        assert got[u.username] == _app_total(b), u.username

    # Reading the room clears its part.
    await ok(await client.post(f"/api/rooms/rooms/{room}/read", headers=H(bob), json={"seq": last["seq"]}))
    assert (await badges(client, bob))["rooms"] == 1


async def test_rooms_adds_missed_calls_not_yet_seen(client, db, monkeypatch):  # noqa: F811
    from app.calls import access
    from app.calls.models import Call, CallParticipant
    from app.rooms.models import Room, RoomMember

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    room = Room(kind="dm", name="", last_seq=0)
    db.add(room)
    await db.flush()
    db.add_all([RoomMember(room_id=room.id, user_id=ann.id), RoomMember(room_id=room.id, user_id=bob.id)])
    for _ in range(2):
        call = Call(kind="dm", room_id=room.id, lk_room=f"c-{uuid.uuid4().hex[:12]}", started_by=ann.id, ended_at=datetime.now(UTC))
        db.add(call)
        await db.flush()
        db.add(CallParticipant(call_id=call.id, identity=f"u:{bob.id}", user_id=bob.id, ring="missed"))
    await db.commit()

    # Calls off (not set up here): only the messages count.
    assert (await badges(client, bob))["rooms"] == 0

    async def on(*_a, **_k):
        return True

    monkeypatch.setattr(access, "voice_allowed", on)
    assert (await badges(client, bob))["rooms"] == 2
    assert (await badges(client, ann))["rooms"] == 0  # her own calls aren't missed by her
    # Opening the Calls tab marks them seen.
    await ok(await client.post("/api/calls/missed/seen", headers=H(bob)))
    assert (await badges(client, bob))["rooms"] == 0


# ------------------------------------------------------------------ porch


async def test_porch_activity_and_new_posts_since_you_looked(client, db):  # noqa: F811
    ann, bob, cat = [await mk_user(db, n) for n in ("ann", "bob", "cat")]
    for u in (ann, bob, cat):
        await boot(client, u)  # opened Porch once (profile made)
    gid = await members_of(client, ann, "Family", [bob])
    # bob's feed was last looked at now; ann's post afterwards is new for him.
    await ok(await client.post("/api/porch/feed/seen", headers=H(bob), json={}))
    await ok(await client.post("/api/porch/activity/seen", headers=H(bob)))
    await ok(await client.post("/api/porch/feed/seen", headers=H(ann), json={}))
    await ok(await client.post("/api/porch/activity/seen", headers=H(ann)))
    assert (await badges(client, bob))["porch"] == 0
    post = await say(client, ann, [gid], "Beach on Sunday?")
    assert (await badges(client, bob))["porch"] == 1  # a new post in his feed
    assert (await badges(client, ann))["porch"] == 0  # her own post isn't news to her
    # bob comments: that's Activity for ann.
    await ok(await client.post(f"/api/porch/posts/{post['id']}/comments", headers=H(bob), json={"body": "Yes!"}), 201)
    assert (await badges(client, ann))["porch"] == 1
    # cat isn't in the group: nothing for her.
    assert (await badges(client, cat))["porch"] == 0
    # Looking clears it.
    await ok(await client.post("/api/porch/feed/seen", headers=H(bob), json={}))
    assert (await badges(client, bob))["porch"] == 0
    await ok(await client.post("/api/porch/activity/seen", headers=H(ann)))
    assert (await badges(client, ann))["porch"] == 0
    # An invite waits for an answer until it's answered.
    await ok(await client.post(f"/api/porch/groups/{gid}/invites", headers=H(ann), json={"user_ids": [str(cat.id)]}))
    assert (await badges(client, cat))["porch"] == 1


async def test_porch_is_left_out_for_people_it_isnt_on_for(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    assert "porch" in await badges(client, ann)
    await set_porch(db, porch_enabled=False)
    try:
        got = await badges(client, ann)
        assert "porch" not in got and {"tasks", "mail", "rooms"} <= set(got)
    finally:
        await set_porch(db, porch_enabled=True)


# ------------------------------------------------------------------ the endpoint


async def test_only_the_asked_rows_and_signing_in(client, db):  # noqa: F811
    ann = await mk_user(db, "ann")
    assert set(await badges(client, ann, "mail,rooms,nonsense")) == {"mail", "rooms"}
    assert await badges(client, ann, "") == {}
    assert (await client.get("/api/badges")).status_code == 401


async def test_a_broken_provider_counts_zero_and_spares_the_rest(client, db, monkeypatch, caplog):  # noqa: F811
    import app.badges as reg

    ann, bob = await mk_user(db, "ann"), await mk_user(db, "bob")
    acct = await _account(db, ann, "ann@home.example")
    await _mail(db, acct)

    async def boom(_db, _user):
        raise RuntimeError("provider exploded")

    async def bad_sql(db_, _user):
        await db_.execute(text("SELECT * FROM no_such_table"))
        return 5

    reg._load()
    parts = list(reg._PARTS)
    swapped = [
        dataclasses.replace(p, count=boom) if (p.app, p.key) == ("tasks", "due")
        else dataclasses.replace(p, count=bad_sql) if (p.app, p.key) == ("rooms", "unread")
        else p
        for p in parts
    ]
    monkeypatch.setattr(reg, "_PARTS", swapped)
    with caplog.at_level("ERROR", logger="promptly.badges"):
        got = await badges(client, ann)
    # The broken rows show no badge; mail (asked after the SQL error) still counts.
    assert got["tasks"] == 0 and got["rooms"] == 0 and got["mail"] == 1
    assert "badge tasks/due failed" in caplog.text and "badge rooms/unread failed" in caplog.text


def test_every_row_is_registered_once():
    import app.badges as reg

    assert reg.apps() == ["tasks", "mail", "rooms", "porch"]
    with pytest.raises(ValueError):
        reg.badge("mail", "unread")(lambda db, user: None)  # type: ignore[arg-type,return-value]
