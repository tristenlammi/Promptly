"""Mail with the rest of Promptly: invites, Files, Tasks, Contacts, Today, Ctrl+K, and
Chat and the phone assistant, where nothing is sent without you."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from email import message_from_bytes, policy

import pytest
from sqlalchemy import select

from app.chat.tools.base import ToolContext, ToolError
from app.mail import compose, invites, parse, worker
from app.mail.models import MailAccount, MailInvite, MailMessage, MailOutbox

from .test_mail import H, _deliver, _live_account, _rows, _sync, client, live, mk_account, mk_message, mk_user, server  # noqa: F401

ICS = b"""BEGIN:VCALENDAR\r
METHOD:REQUEST\r
BEGIN:VEVENT\r
UID:abc-123@example.com\r
SEQUENCE:2\r
SUMMARY:Team\\, lunch\r
DTSTART;TZID=AUS Eastern Standard Time:20261110T123000\r
DTEND;TZID=AUS Eastern Standard Time:20261110T133000\r
LOCATION:Queen Street\r
ORGANIZER;CN="Sam: Taylor":mailto:sam@example.com\r
ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:me@example.com\r
DESCRIPTION:Long line that is fol\r
 ded here\r
END:VEVENT\r
END:VCALENDAR\r
"""


def test_an_invite_is_read():
    i = invites.parse_ics(ICS)
    assert i["method"] == "REQUEST" and i["uid"] == "abc-123@example.com" and i["sequence"] == 2 and i["title"] == "Team, lunch"
    assert i["start"].startswith("2026-11-10T12:30:00+11:00") and i["zone_sure"] and not i["all_day"]
    assert i["organizer"] == {"name": "Sam: Taylor", "addr": "sam@example.com"} and i["description"] == "Long line that is folded here"


def test_all_day_utc_unknown_zone_and_rubbish():
    base = b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n%s\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    day = invites.parse_ics(base % b"DTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261112")
    assert day["all_day"] and day["start"] == "2026-11-10" and day["end"] == "2026-11-11"
    assert invites.parse_ics(base % b"DTSTART:20261110T010000Z")["start"].endswith("+00:00")
    assert invites.parse_ics(base % b"DTSTART;TZID=Made Up:20261110T010000")["zone_sure"] is False
    assert invites.parse_ics(base % b"DTSTART:banana") is None
    assert invites.parse_ics(b"not an invite") is None
    assert invites.parse_ics(b"BEGIN:VEVENT\r\nDTSTART:20261110T010000Z\r\nEND:VEVENT") is None


def test_an_answer_keeps_the_organisers_details_and_cant_be_broken_out_of():
    i = invites.parse_ics(ICS)
    out = invites.reply_ics(i, email="me@example.com", name='Me"\r\nBCC:evil', status="going")
    unfolded = out.replace("\r\n ", "")
    assert "METHOD:REPLY" in out and "UID:abc-123@example.com" in out and "SEQUENCE:2" in out
    assert "PARTSTAT=ACCEPTED" in unfolded and "mailto:sam@example.com" in unfolded
    assert not any(line.startswith("BCC") for line in out.split("\r\n"))


def test_an_invite_in_an_email_becomes_a_card_not_an_attachment():
    from email.message import EmailMessage

    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = "sam@example.com", "me@example.com", "Invite"
    m.set_content("Come along")
    m.add_alternative(ICS, maintype="text", subtype="calendar", params={"method": "REQUEST"})
    found = parse.parse(m.as_bytes())
    assert found.invite["uid"] == "abc-123@example.com" and found.attachments == []


async def _invited(db, account, ics=ICS) -> MailMessage:
    m = await mk_message(db, account, subject="Invite")
    m.invite = invites.parse_ics(ics)
    m.attachments = []
    await db.commit()
    return m


async def test_answering_adds_it_tells_the_organiser_and_can_change(client, db):  # noqa: F811
    from app.calendars.models import CalEvent

    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    m = await _invited(db, account)
    assert (await client.post(f"/api/mail/messages/{m.id}/rsvp", json={"answer": "going"}, headers=H(other))).status_code == 404

    r = await client.post(f"/api/mail/messages/{m.id}/rsvp", json={"answer": "going"}, headers=H(u))
    assert r.status_code == 200 and r.json()["answer"] == "going" and r.json()["told_organiser"] is True
    row = await db.get(MailInvite, (u.id, "abc-123@example.com"))
    event = await db.get(CalEvent, row.event_id)
    assert event.title == "Team, lunch" and event.location == "Queen Street"
    item = await db.scalar(select(MailOutbox).where(MailOutbox.account_id == account.id))
    assert item.recipients == ["sam@example.com"]
    sent = message_from_bytes(item.raw.encode("utf-8", "surrogateescape"), policy=policy.default)
    ics = next(p for p in sent.iter_attachments() if p.get_content_type() == "text/calendar")
    assert ics.get_param("method") == "REPLY" and b"PARTSTAT=ACCEPTED" in ics.get_payload(decode=True)

    # The conversation shows the answer. Saying yes twice doesn't add it twice.
    shown = (await client.get(f"/api/mail/threads/{account.id}/{m.thread_key}", headers=H(u))).json()["messages"][0]["invite"]
    assert shown["answer"] == "going" and shown["event_url"]
    await client.post(f"/api/mail/messages/{m.id}/rsvp", json={"answer": "going"}, headers=H(u))
    events = (await db.execute(select(CalEvent).where(CalEvent.title == "Team, lunch").execution_options(populate_existing=True))).scalars().all()
    assert len(events) == 1

    r = await client.post(f"/api/mail/messages/{m.id}/rsvp", json={"answer": "declined"}, headers=H(u))
    assert r.json()["event_url"] is None


async def test_a_cancelled_invite_cant_be_accepted_and_can_be_removed(client, db):  # noqa: F811
    u = await mk_user(db, "owner")
    account = await mk_account(db, u)
    m = await _invited(db, account)
    await client.post(f"/api/mail/messages/{m.id}/rsvp", json={"answer": "going"}, headers=H(u))
    m.uid = 8
    await db.commit()
    gone = await mk_message(db, account, subject="Cancelled")
    gone.uid = 9
    gone.invite = invites.parse_ics(ICS.replace(b"METHOD:REQUEST", b"METHOD:CANCEL"))
    await db.commit()
    assert (await client.post(f"/api/mail/messages/{gone.id}/rsvp", json={"answer": "going"}, headers=H(u))).status_code == 409
    assert (await client.post(f"/api/mail/messages/{m.id}/remove-cancelled", headers=H(u))).status_code == 409
    assert (await client.post(f"/api/mail/messages/{gone.id}/remove-cancelled", headers=H(u))).status_code == 204
    shown = (await client.get(f"/api/mail/threads/{account.id}/{gone.thread_key}", headers=H(u))).json()["messages"][0]["invite"]
    assert shown["cancelled"] and shown["event_url"] is None


async def test_an_email_can_become_an_event_a_task_and_a_contact(client, db):  # noqa: F811
    from app.calendars.models import CalEvent
    from app.items import service

    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    m = await mk_message(db, account, subject="Plan the party")
    url = f"/api/mail/threads/{account.id}/{m.thread_key}"
    body = {"title": "Party", "start": "2026-12-01T18:00:00", "all_day": False}
    assert (await client.post(f"{url}/event", json=body, headers=H(other))).status_code == 404
    assert (await client.post(f"{url}/task", headers=H(other))).status_code == 404
    assert (await client.post(f"{url}/event", json=body, headers=H(u))).status_code == 201
    assert await db.scalar(select(CalEvent.id).where(CalEvent.title == "Party")) is not None

    assert (await client.post(f"{url}/task", headers=H(u))).status_code == 201
    await db.commit()
    (row, doc), = await service.list_items(db, u, "tasks", archives=False)
    task = doc.data["tasks"][0]
    assert task["title"] == "Plan the party" and f"/mail?open={account.id}/{m.thread_key}" in task["notes"]

    assert (await client.post("/api/mail/contacts", json={"name": "Sam Taylor", "addr": "sam@example.com"}, headers=H(u))).status_code == 201
    await db.commit()
    known = (await client.post("/api/mail/known-people", json={"addrs": ["SAM@example.com", "x@y.co"]}, headers=H(u))).json()["people"]
    assert list(known) == ["sam@example.com"] and known["sam@example.com"]["name"] == "Sam Taylor"
    # Someone else's address book isn't yours.
    assert (await client.post("/api/mail/known-people", json={"addrs": ["sam@example.com"]}, headers=H(other))).json()["people"] == {}
    assert (await client.get("/api/mail/people?q=sam", headers=H(u))).json()["people"][0]["name"] == "Sam Taylor"


async def test_a_contacts_photo_shows_on_their_mail(client, db):  # noqa: F811
    from app.items import service

    u = await mk_user(db, "owner")
    await client.post("/api/mail/contacts", json={"name": "Sam", "addr": "sam@example.com"}, headers=H(u))
    await db.commit()
    (row, doc), = await service.list_items(db, u, "contacts", archives=False)
    data = dict(doc.data)
    data["contacts"] = [{**data["contacts"][0], "photo": "data:image/png;base64,AAAA"}]
    doc.data = data
    await db.commit()
    known = (await client.post("/api/mail/known-people", json={"addrs": ["sam@example.com"]}, headers=H(u))).json()["people"]
    assert known["sam@example.com"]["photo"] == "data:image/png;base64,AAAA"


async def test_today_and_ctrl_k_show_your_mail_only(client, db):  # noqa: F811
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    m = await mk_message(db, account, subject="Quarterly numbers")
    m.needs_reply, m.summary = True, "Wants the numbers"
    await db.commit()
    from app.mail.apps import quick_search, today_section

    section = await today_section(db, u)
    assert section["needs_reply"] == 1 and section["unread"] == 1 and section["items"][0]["summary"] == "Wants the numbers"
    assert str(account.id) in section["items"][0]["url"]
    assert await today_section(db, other) is None
    hits = (await client.get("/api/today/search?q=quarterly", headers=H(u))).json()["mail"]
    assert [h["subject"] for h in hits] == ["Quarterly numbers"]
    assert (await client.get("/api/today/search?q=quarterly", headers=H(other))).json()["mail"] == []
    assert await quick_search(db, other, "quarterly", 5) == []


# ---- Chat and the phone


def _ctx(db, user) -> ToolContext:
    return ToolContext(db=db, user=user, conversation_id=None, user_message_id=None, turn={})


async def test_chat_can_read_your_mail_and_marks_it_as_outside_content(db):
    from app.chat.tools.mail import MailReadTool, MailSearchTool

    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    m = await mk_message(db, await mk_account(db, u), subject="Quarterly numbers", body="They are 42")
    ctx = _ctx(db, u)
    found = await MailSearchTool().run(ctx, {"query": "quarterly"})
    assert str(m.id) in found.content and ctx.turn["untrusted"] is True
    assert "They are 42" in (await MailReadTool().run(_ctx(db, u), {"message_id": str(m.id)})).content
    assert "No mailboxes" in (await MailSearchTool().run(_ctx(db, other), {"query": "quarterly"})).content
    with pytest.raises(ToolError):
        await MailReadTool().run(_ctx(db, other), {"message_id": str(m.id)})
    with pytest.raises(ToolError):
        await MailReadTool().run(_ctx(db, u), {"message_id": "not an id"})


async def test_a_chat_draft_sends_nothing_and_stays_out_of_server_logs(db):
    from app.chat.tools.mail import MailDraftReplyTool

    u = await mk_user(db, "owner")
    m = await mk_message(db, await mk_account(db, u))
    got = await MailDraftReplyTool().run(_ctx(db, u), {"message_id": str(m.id), "text": "Sounds good & thanks"})
    assert await db.scalar(select(MailOutbox.id).limit(1)) is None
    path, _, fragment = got.meta["url"].partition("#")
    assert "Sounds" not in path and fragment == "draft=Sounds%20good%20%26%20thanks"


def test_chat_never_gets_the_tool_that_sends():
    from app.chat.tools.mail import MailReplyTool
    from app.chat.tools.registry import REGISTRY

    tools = REGISTRY.values() if isinstance(REGISTRY, dict) else REGISTRY
    assert [t for t in tools if t.name == "mail_reply"][0].category == "phone"
    assert MailReplyTool.category == "phone"


async def test_the_phone_reads_back_who_from_the_email_and_waits_for_a_yes(db):
    from app.maps import assistant

    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    account = await mk_account(db, u)
    m = await mk_message(db, account)
    m.reply_to = "help@example.com"
    await db.commit()
    # Whatever the model claims about who it's going to.
    args, problem = await assistant._reply_to_whom(db, u, {"message_id": str(m.id), "text": "Yes please", "to": "attacker@evil.example"})
    assert problem is None and args["to"] == "Sam" and "attacker" not in str(args)
    assert "Sam" in assistant._question("mail_reply", args) and "Yes please" in assistant._question("mail_reply", args)
    assert await db.scalar(select(MailOutbox.id).limit(1)) is None
    assert (await assistant._reply_to_whom(db, other, {"message_id": str(m.id), "text": "x"}))[1]

    from app.chat.tools.mail import MailReplyTool

    # What comes back from the phone is checked again, and the address ignored.
    with pytest.raises(ToolError):
        await MailReplyTool().run(_ctx(db, other), args)
    await MailReplyTool().run(_ctx(db, u), {**args, "to": "attacker@evil.example"})
    item = await db.scalar(select(MailOutbox))
    assert item.recipients == ["help@example.com"] and "attacker" not in item.raw


async def test_attaching_from_files_only_reaches_what_you_can_read(client, db, tmp_path, monkeypatch):  # noqa: F811
    from app.mail import apps

    u = await mk_user(db, "owner")
    with pytest.raises(Exception) as bad:
        await apps.files_to_attach(db, u, [uuid.uuid4()])
    assert getattr(bad.value, "status_code", None) == 404


# ---- with a real mail server


@live
async def test_saving_an_attachment_goes_through_to_the_system_folder(client, db, server):  # noqa: F811
    from app.files.models import FileFolder, UserFile

    u, other = await mk_user(db, "owner", role="admin"), await mk_user(db, "other")
    account = await _live_account(db, u)
    _deliver("alice@mailtest.example", subject="Report", attachment="%PDF-1.4 the report\n")
    await _sync(account)
    m = (await _rows(db, account))[0]
    part = m.attachments[0]["part"]
    url = f"/api/mail/messages/{m.id}/attachments/{part}/save"
    assert (await client.post(url, headers=H(other))).status_code == 404
    r = await client.post(url, headers=H(u))
    assert r.status_code == 200, r.text
    row = await db.get(UserFile, uuid.UUID(r.json()["id"]))
    folder = await db.get(FileFolder, row.folder_id)
    assert folder.system_kind == "mail_attachments" and folder.name == "Email Attachments" and row.user_id == u.id
    # Twice keeps both, and the protected folder isn't made again.
    again = await client.post(url, headers=H(u))
    assert again.status_code == 200 and again.json()["id"] != r.json()["id"]
    assert len((await db.execute(select(FileFolder).where(FileFolder.user_id == u.id, FileFolder.system_kind == "mail_attachments"))).scalars().all()) == 1
    # And it can go back out attached to something else.
    from app.mail import apps

    files = await apps.files_to_attach(db, u, [row.id])
    assert files[0].name == row.filename and files[0].data.startswith(b"%PDF")
    with pytest.raises(Exception) as bad:
        await apps.files_to_attach(db, other, [row.id])
    assert getattr(bad.value, "status_code", None) == 404


@live
async def test_a_real_invite_arrives_as_a_card_and_the_answer_really_goes(client, db, server):  # noqa: F811
    from email.message import EmailMessage
    import smtplib

    from .test_mail import HOST, _connect, _mailbox

    u = await mk_user(db, "owner", role="admin")
    account = await _live_account(db, u)
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = "Bob <bob@mailtest.example>", "alice@mailtest.example", "Invite"
    m["Message-ID"] = "<invite@mailtest.example>"
    m.set_content("Come along")
    m.add_alternative(ICS.replace(b"sam@example.com", b"bob@mailtest.example").replace(b"me@example.com", b"alice@mailtest.example"), maintype="text", subtype="calendar", params={"method": "REQUEST"})
    with smtplib.SMTP(HOST, 3025, timeout=20) as s:
        s.send_message(m)
    await _sync(account)
    row = (await _rows(db, account))[0]
    assert row.invite["title"] == "Team, lunch"
    assert (await client.post(f"/api/mail/messages/{row.id}/rsvp", json={"answer": "going"}, headers=H(u))).status_code == 200
    link = await asyncio.to_thread(_connect, account)
    await worker._send_due(link, account, True)
    await asyncio.to_thread(link.logout)
    box = _mailbox("bob@mailtest.example")
    box.select_folder("INBOX")
    uid = box.search(["ALL"])[0]
    raw = box.fetch([uid], ["BODY.PEEK[]"])[uid][b"BODY[]"]
    box.logout()
    got = parse.parse(raw)
    assert got.invite["method"] == "REPLY" and got.invite["uid"] == "abc-123@example.com" and got.invite["attendees"][0]["said"] == "going"


# ---- asking one mailbox, and previews


async def test_asking_can_stick_to_one_mailbox(client, db, monkeypatch):  # noqa: F811
    seen = {}

    async def resolve(db_, user, provider_id, model_id):
        return object(), model_id

    async def complete(provider, model_id, *, system, messages, **_):
        seen["prompt"] = messages[0].content
        return "Answer"

    async def no_quota(*_):
        return None

    monkeypatch.setattr("app.files.editor_ai.resolve_model", resolve)
    monkeypatch.setattr("app.files.editor_ai.complete", complete)
    monkeypatch.setattr("app.chat.router._enforce_send_quotas", no_quota)
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    work, home = await mk_account(db, u, email="work@example.com"), await mk_account(db, u, email="home@example.com")
    await mk_message(db, work, subject="Budget at work", body="The budget at work")
    await mk_message(db, home, subject="Budget at home", body="The budget at home")
    theirs = await mk_account(db, other, email="them@example.com")
    body = {"question": "budget", "provider_id": "00000000-0000-0000-0000-000000000009", "model_id": "m"}

    assert (await client.post("/api/mail/ask", json=body, headers=H(u))).json()["read"] == 2
    r = await client.post("/api/mail/ask", json={**body, "account_id": str(work.id)}, headers=H(u))
    assert r.json()["read"] == 1 and "at work" in seen["prompt"] and "at home" not in seen["prompt"]
    assert (await client.post("/api/mail/ask", json={**body, "account_id": str(theirs.id)}, headers=H(u))).status_code == 404


async def test_an_office_attachment_can_be_previewed_by_its_owner_only(client, db, monkeypatch):  # noqa: F811
    from app.files import convert
    from app.mail import router as mail_router

    async def fake_bytes(db_, user, message_id, part):
        message = await db_.get(MailMessage, message_id)
        await mail_router._mine(db_, user, message.account_id)
        return "report.docx", "application/octet-stream", b"not really a word file"

    async def fake_post(path, filename):
        assert filename == "attachment.docx" and path.read_bytes() == b"not really a word file"
        return b"%PDF-1.4 made up"

    monkeypatch.setattr(mail_router, "_attachment_bytes", fake_bytes)
    monkeypatch.setattr(convert, "_post", fake_post)
    monkeypatch.setattr(convert, "enabled", lambda: True)
    u, other = await mk_user(db, "owner"), await mk_user(db, "other")
    m = await mk_message(db, await mk_account(db, u))
    url = f"/api/mail/messages/{m.id}/attachments/0/preview"
    r = await client.get(url, headers=H(u))
    assert r.status_code == 200 and r.content.startswith(b"%PDF") and r.headers["content-type"] == "application/pdf"
    assert (await client.get(url, headers=H(other))).status_code == 404
    monkeypatch.setattr(convert, "enabled", lambda: False)
    assert (await client.get(url, headers=H(u))).status_code == 404
