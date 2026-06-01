"""Gmail History API incremental sync + two-way writeback (Phase 12 — E.1).

Strategy
--------
* **Incremental sync:** We hold a ``historyId`` cursor per account. On each
  poll we call ``users.history.list`` with that cursor to get only the delta
  (new/modified/deleted messages) since the last sync. This is O(delta) not
  O(inbox) — fast and cheap.
* **Full resync:** When the cursor expires (Gmail returns 404 on the history
  call) we fall back to a paginated ``users.messages.list`` with no cursor.
  We flag the account ``sync_cursor_expired = True`` and the caller re-runs.
* **Two-way writeback:** Each sync loop first flushes any pending
  ``writeback_read`` / ``writeback_archived`` flags before reading new mail,
  so the user's actions reach Gmail without a separate queue.
* **Token refresh:** We always check token expiry and refresh via the Google
  token endpoint before making API calls.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from email import message_from_bytes
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.email.crypto import OAuthTokens, decrypt_tokens, encrypt_tokens, tokens_expired
from app.email.models import CalendarEvent, EmailAccount, EmailContact, EmailMessage

logger = logging.getLogger("promptly.email.sync")

_GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105

# Max messages fetched per full-resync page (Gmail max is 500)
_PAGE_SIZE = 100
# Max messages to process per incremental sync tick (safety valve)
_MAX_PER_TICK = 200


# ------------------------------------------------------------------ #
# Token management                                                     #
# ------------------------------------------------------------------ #

async def _refresh_access_token(
    tokens: OAuthTokens,
    client_id: str,
    client_secret: str,
) -> OAuthTokens:
    """Exchange the refresh token for a fresh access token."""
    if not tokens.get("refresh_token"):
        raise RuntimeError("No refresh_token available — user must reconnect.")
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            _GOOGLE_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": tokens["refresh_token"],
                "grant_type": "refresh_token",
            },
            timeout=15,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Token refresh failed: {resp.text[:200]}")
    data = resp.json()
    from datetime import timedelta
    expiry_iso = (
        datetime.now(timezone.utc) + timedelta(seconds=int(data.get("expires_in", 3600)))
    ).isoformat()
    return {
        "access_token": data["access_token"],
        "refresh_token": tokens.get("refresh_token"),
        "expiry_iso": expiry_iso,
    }


async def _get_valid_tokens(
    db: AsyncSession,
    account: EmailAccount,
    client_id: str,
    client_secret: str,
) -> OAuthTokens:
    """Return valid tokens, refreshing if needed and persisting the update."""
    if not account.oauth_tokens_encrypted:
        raise RuntimeError("Account has no stored OAuth tokens.")
    tokens = decrypt_tokens(account.oauth_tokens_encrypted)
    if tokens_expired(tokens):
        tokens = await _refresh_access_token(tokens, client_id, client_secret)
        account.oauth_tokens_encrypted = encrypt_tokens(tokens)
        await db.flush()
    return tokens


# ------------------------------------------------------------------ #
# Gmail API helpers                                                    #
# ------------------------------------------------------------------ #

async def _gmail_get(url: str, access_token: str, **params) -> dict:
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            params={k: v for k, v in params.items() if v is not None},
            timeout=20,
        )
    if resp.status_code == 404:
        raise _CursorExpired()
    resp.raise_for_status()
    return resp.json()


class _CursorExpired(Exception):
    """Raised when Gmail returns 404 on a history call — cursor has expired."""


def _parse_message_data(raw: dict) -> dict[str, Any]:
    """Extract fields from a Gmail message resource (format=full or metadata)."""
    headers: dict[str, str] = {}
    for h in raw.get("payload", {}).get("headers", []):
        headers[h["name"].lower()] = h["value"]

    subject = headers.get("subject", "")
    from_raw = headers.get("from", "")
    to_raw = headers.get("to", "")
    cc_raw = headers.get("cc", "")
    date_str = headers.get("date", "")

    # Parse from: "Name <addr>" → (name, addr)
    from_name, from_address = _split_name_address(from_raw)

    date: datetime | None = None
    if date_str:
        try:
            date = parsedate_to_datetime(date_str)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
        except Exception:
            date = None

    # Extract body_text from the MIME tree
    body_text = _extract_body_text(raw.get("payload", {}))
    body_html = _extract_body_html(raw.get("payload", {}))
    snippet = raw.get("snippet", "")[:300]

    label_ids = raw.get("labelIds", [])
    read = "UNREAD" not in label_ids
    archived = "INBOX" not in label_ids

    has_attachments = any(
        p.get("filename") for p in _iter_parts(raw.get("payload", {}))
    )

    return {
        "subject": subject or None,
        "from_address": from_address or None,
        "from_name": from_name or None,
        "to_addresses": _parse_address_list(to_raw),
        "cc_addresses": _parse_address_list(cc_raw),
        "date": date,
        "snippet": snippet or None,
        "body_text": body_text or None,
        "body_html": body_html or None,
        "has_attachments": has_attachments,
        "provider_labels": label_ids,
        "read": read,
        "archived": archived,
    }


def _split_name_address(raw: str) -> tuple[str, str]:
    """Split 'Name <addr>' or 'addr' into (name, address)."""
    raw = raw.strip()
    if "<" in raw and raw.endswith(">"):
        parts = raw.rsplit("<", 1)
        return parts[0].strip().strip('"'), parts[1].rstrip(">").strip()
    return "", raw


def _parse_address_list(raw: str) -> list[str]:
    if not raw:
        return []
    return [a.strip() for a in raw.split(",") if a.strip()]


def _iter_parts(payload: dict) -> list[dict]:
    parts = [payload]
    for p in payload.get("parts", []):
        parts.extend(_iter_parts(p))
    return parts


def _extract_body_text(payload: dict) -> str:
    import base64
    for part in _iter_parts(payload):
        if part.get("mimeType") == "text/plain" and not part.get("filename"):
            data = part.get("body", {}).get("data", "")
            if data:
                try:
                    return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
                except Exception:
                    pass
    return ""


def _extract_body_html(payload: dict) -> str:
    import base64
    for part in _iter_parts(payload):
        if part.get("mimeType") == "text/html" and not part.get("filename"):
            data = part.get("body", {}).get("data", "")
            if data:
                try:
                    return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
                except Exception:
                    pass
    return ""


# ------------------------------------------------------------------ #
# Two-way writeback                                                    #
# ------------------------------------------------------------------ #

async def _flush_writebacks(
    db: AsyncSession,
    account: EmailAccount,
    access_token: str,
) -> int:
    """Apply pending read/archive writebacks to Gmail. Returns count applied."""
    pending = (
        await db.execute(
            select(EmailMessage).where(
                EmailMessage.account_id == account.id,
                EmailMessage.writeback_read.is_not(None)
                | EmailMessage.writeback_archived.is_not(None),
            ).limit(50)
        )
    ).scalars().all()

    applied = 0
    async with httpx.AsyncClient() as http:
        for msg in pending:
            add_labels: list[str] = []
            remove_labels: list[str] = []

            if msg.writeback_read is not None:
                if msg.writeback_read:
                    remove_labels.append("UNREAD")
                else:
                    add_labels.append("UNREAD")
                msg.writeback_read = None

            if msg.writeback_archived is not None:
                if msg.writeback_archived:
                    remove_labels.append("INBOX")
                else:
                    add_labels.append("INBOX")
                msg.writeback_archived = None

            if not add_labels and not remove_labels:
                continue

            try:
                resp = await http.post(
                    f"{_GMAIL_BASE}/users/me/messages/{msg.provider_message_id}/modify",
                    headers={"Authorization": f"Bearer {access_token}"},
                    json={
                        "addLabelIds": add_labels,
                        "removeLabelIds": remove_labels,
                    },
                    timeout=10,
                )
                if resp.status_code == 200:
                    applied += 1
                else:
                    logger.warning(
                        "Writeback failed for message %s: %s",
                        msg.provider_message_id, resp.text[:100],
                    )
            except Exception:
                logger.exception("Writeback error for message %s", msg.provider_message_id)

    await db.flush()
    return applied


# ------------------------------------------------------------------ #
# Contact upsert                                                       #
# ------------------------------------------------------------------ #

async def _upsert_contact(
    db: AsyncSession,
    user_id: uuid.UUID,
    email_address: str,
    display_name: str | None,
    seen_at: datetime,
) -> None:
    if not email_address:
        return
    existing = (
        await db.execute(
            select(EmailContact).where(
                EmailContact.user_id == user_id,
                EmailContact.email_address == email_address.lower(),
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.message_count += 1
        if display_name and not existing.display_name:
            existing.display_name = display_name
        if not existing.last_seen_at or seen_at > existing.last_seen_at:
            existing.last_seen_at = seen_at
        existing.updated_at = datetime.now(timezone.utc)
    else:
        db.add(EmailContact(
            user_id=user_id,
            email_address=email_address.lower(),
            display_name=display_name,
            message_count=1,
            last_seen_at=seen_at,
        ))


# ------------------------------------------------------------------ #
# Main sync entry point                                                #
# ------------------------------------------------------------------ #

async def sync_account(
    db: AsyncSession,
    account: EmailAccount,
    client_id: str,
    client_secret: str,
) -> dict[str, int]:
    """Sync one email account. Returns a dict of counters for logging."""
    now = datetime.now(timezone.utc)
    counters: dict[str, int] = {"new": 0, "updated": 0, "writebacks": 0}

    tokens = await _get_valid_tokens(db, account, client_id, client_secret)
    access_token = tokens["access_token"]

    # 1. Flush pending writebacks before reading (so we see our own changes)
    try:
        counters["writebacks"] = await _flush_writebacks(db, account, access_token)
    except Exception:
        logger.exception("Writeback flush failed for account %s", account.id)

    # 2. Incremental or full sync
    if account.needs_full_resync:
        await _full_sync(db, account, access_token, counters, now)
    else:
        try:
            await _incremental_sync(db, account, access_token, counters, now)
        except _CursorExpired:
            logger.warning("History cursor expired for account %s; doing full resync", account.id)
            account.sync_cursor_expired = True
            account.history_id = None
            await _full_sync(db, account, access_token, counters, now)

    account.last_synced_at = now
    account.last_sync_error = None
    account.sync_cursor_expired = False

    # 3. Calendar sync (best-effort — failure doesn't abort email sync)
    try:
        await sync_calendar(db, account, access_token)
    except Exception:
        logger.exception("Calendar sync failed for account %s (non-fatal)", account.id)

    # Schedule next sync in ~5 minutes
    from datetime import timedelta
    account.next_sync_at = now + timedelta(minutes=5)
    await db.commit()

    return counters


# ------------------------------------------------------------------ #
# Google Calendar sync                                                 #
# ------------------------------------------------------------------ #

_GCAL_BASE = "https://www.googleapis.com/calendar/v3"
_GCAL_LOOK_AHEAD_DAYS = 30


async def sync_calendar(
    db: AsyncSession,
    account: EmailAccount,
    access_token: str,
) -> None:
    """Sync primary calendar events for the next 30 days.

    Uses nextSyncToken for incremental updates. Falls back to a full sync
    when the token expires (410 Gone).
    """
    now = datetime.now(timezone.utc)
    from datetime import timedelta

    if account.calendar_sync_token:
        # Incremental: only events changed since last sync
        params: dict = {"syncToken": account.calendar_sync_token}
        async with httpx.AsyncClient() as http:
            resp = await http.get(
                f"{_GCAL_BASE}/calendars/primary/events",
                headers={"Authorization": f"Bearer {access_token}"},
                params=params,
                timeout=20,
            )
        if resp.status_code == 410:
            # Sync token expired — clear and fall through to full sync
            account.calendar_sync_token = None
        elif resp.status_code == 403:
            # No calendar scope on this token — skip silently
            return
        elif resp.status_code != 200:
            resp.raise_for_status()
        else:
            data = resp.json()
            await _upsert_events(db, account, data.get("items", []), now)
            account.calendar_sync_token = data.get("nextSyncToken") or account.calendar_sync_token
            return

    # Full sync — fetch events in the next LOOK_AHEAD_DAYS window
    time_min = now.isoformat()
    time_max = (now + timedelta(days=_GCAL_LOOK_AHEAD_DAYS)).isoformat()
    page_token: str | None = None

    while True:
        params = {
            "calendarId": "primary",
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 250,
        }
        if page_token:
            params["pageToken"] = page_token

        async with httpx.AsyncClient() as http:
            resp = await http.get(
                f"{_GCAL_BASE}/calendars/primary/events",
                headers={"Authorization": f"Bearer {access_token}"},
                params=params,
                timeout=20,
            )
        if resp.status_code == 403:
            return  # No calendar scope — skip
        resp.raise_for_status()
        data = resp.json()

        await _upsert_events(db, account, data.get("items", []), now)
        page_token = data.get("nextPageToken")
        if not page_token:
            account.calendar_sync_token = data.get("nextSyncToken")
            break


async def _upsert_events(
    db: AsyncSession,
    account: EmailAccount,
    items: list[dict],
    now: datetime,
) -> None:
    for item in items:
        provider_event_id = item.get("id", "")
        if not provider_event_id:
            continue

        # Cancelled events — delete locally
        if item.get("status") == "cancelled":
            existing = (
                await db.execute(
                    select(CalendarEvent).where(
                        CalendarEvent.account_id == account.id,
                        CalendarEvent.provider_event_id == provider_event_id,
                    )
                )
            ).scalar_one_or_none()
            if existing:
                await db.delete(existing)
            continue

        start_raw = item.get("start", {})
        end_raw = item.get("end", {})
        all_day = "date" in start_raw and "dateTime" not in start_raw

        start_at = _parse_gcal_datetime(start_raw)
        end_at = _parse_gcal_datetime(end_raw)

        # Extract Google Meet link from conferenceData
        meet_link: str | None = None
        for ep in item.get("conferenceData", {}).get("entryPoints", []):
            if ep.get("entryPointType") == "video":
                meet_link = ep.get("uri")
                break

        attendees = [
            {"email": a.get("email"), "name": a.get("displayName"), "self": a.get("self")}
            for a in item.get("attendees", [])
        ]

        existing = (
            await db.execute(
                select(CalendarEvent).where(
                    CalendarEvent.account_id == account.id,
                    CalendarEvent.provider_event_id == provider_event_id,
                )
            )
        ).scalar_one_or_none()

        if existing:
            existing.title = item.get("summary") or existing.title
            existing.start_at = start_at
            existing.end_at = end_at
            existing.all_day = all_day
            existing.location = item.get("location")
            existing.description = (item.get("description") or "")[:2000] or None
            existing.attendees = attendees
            existing.meet_link = meet_link
            existing.status = item.get("status")
            existing.synced_at = now
            existing.updated_at = now
        else:
            db.add(CalendarEvent(
                account_id=account.id,
                user_id=account.user_id,
                provider_event_id=provider_event_id,
                title=item.get("summary"),
                start_at=start_at,
                end_at=end_at,
                all_day=all_day,
                location=item.get("location"),
                description=(item.get("description") or "")[:2000] or None,
                attendees=attendees,
                meet_link=meet_link,
                status=item.get("status"),
                synced_at=now,
            ))


def _parse_gcal_datetime(raw: dict) -> datetime | None:
    """Parse a Google Calendar dateTime or date field."""
    if not raw:
        return None
    if "dateTime" in raw:
        try:
            dt = datetime.fromisoformat(raw["dateTime"])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            return None
    if "date" in raw:
        try:
            from datetime import date as date_cls
            d = date_cls.fromisoformat(raw["date"])
            return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


async def _incremental_sync(
    db: AsyncSession,
    account: EmailAccount,
    access_token: str,
    counters: dict[str, int],
    now: datetime,
) -> None:
    """Fetch only changes since the stored historyId."""
    data = await _gmail_get(
        f"{_GMAIL_BASE}/users/me/history",
        access_token,
        startHistoryId=account.history_id,
        historyTypes=["messageAdded", "messageDeleted", "labelsAdded", "labelsRemoved"],
        maxResults=_MAX_PER_TICK,
    )

    history_list = data.get("history", [])
    new_history_id = data.get("historyId", account.history_id)

    message_ids_to_fetch: set[str] = set()
    deleted_ids: set[str] = set()

    for record in history_list:
        for added in record.get("messagesAdded", []):
            message_ids_to_fetch.add(added["message"]["id"])
        for deleted in record.get("messagesDeleted", []):
            deleted_ids.add(deleted["message"]["id"])
        for label_change in record.get("labelsAdded", []) + record.get("labelsRemoved", []):
            message_ids_to_fetch.add(label_change["message"]["id"])

    # Handle deletes
    for pid in deleted_ids:
        existing = (
            await db.execute(
                select(EmailMessage).where(
                    EmailMessage.account_id == account.id,
                    EmailMessage.provider_message_id == pid,
                )
            )
        ).scalar_one_or_none()
        if existing:
            await db.delete(existing)

    # Fetch and upsert changed messages
    for pid in message_ids_to_fetch:
        await _fetch_and_upsert_message(db, account, access_token, pid, counters, now)

    account.history_id = new_history_id


async def _full_sync(
    db: AsyncSession,
    account: EmailAccount,
    access_token: str,
    counters: dict[str, int],
    now: datetime,
) -> None:
    """Paginated full inbox sync. Used on first connect or cursor expiry."""
    page_token: str | None = None
    fetched = 0

    # Grab the current historyId before we start (so incremental can pick up from here)
    profile_data = await _gmail_get(
        f"{_GMAIL_BASE}/users/me/profile", access_token
    )
    new_history_id = str(profile_data.get("historyId", ""))

    while fetched < _MAX_PER_TICK * 5:  # Cap full resync at ~1 000 messages
        params: dict[str, Any] = {"maxResults": _PAGE_SIZE, "q": "in:anywhere"}
        if page_token:
            params["pageToken"] = page_token

        data = await _gmail_get(
            f"{_GMAIL_BASE}/users/me/messages",
            access_token,
            **params,
        )
        messages = data.get("messages", [])
        for m in messages:
            await _fetch_and_upsert_message(db, account, access_token, m["id"], counters, now)
            fetched += 1

        page_token = data.get("nextPageToken")
        if not page_token or fetched >= _MAX_PER_TICK * 5:
            break

    account.history_id = new_history_id
    account.sync_cursor_expired = False


async def _fetch_and_upsert_message(
    db: AsyncSession,
    account: EmailAccount,
    access_token: str,
    provider_message_id: str,
    counters: dict[str, int],
    now: datetime,
) -> None:
    """Fetch one message from Gmail and upsert into email_messages."""
    try:
        raw = await _gmail_get(
            f"{_GMAIL_BASE}/users/me/messages/{provider_message_id}",
            access_token,
            format="full",
        )
    except Exception:
        logger.warning("Failed to fetch message %s", provider_message_id)
        return

    fields = _parse_message_data(raw)
    thread_id = raw.get("threadId")

    existing = (
        await db.execute(
            select(EmailMessage).where(
                EmailMessage.account_id == account.id,
                EmailMessage.provider_message_id == provider_message_id,
            )
        )
    ).scalar_one_or_none()

    if existing:
        # Update mutable state (label changes, body changes)
        existing.read = fields["read"]
        existing.archived = fields["archived"]
        existing.provider_labels = fields["provider_labels"]
        existing.synced_at = now
        # Don't overwrite body if we already have it (avoid unnecessary writes)
        if not existing.body_text and fields["body_text"]:
            existing.body_text = fields["body_text"]
        if not existing.body_html and fields["body_html"]:
            existing.body_html = fields["body_html"]
        counters["updated"] += 1
    else:
        msg = EmailMessage(
            account_id=account.id,
            user_id=account.user_id,
            provider_message_id=provider_message_id,
            thread_id=thread_id,
            synced_at=now,
            **fields,
        )
        db.add(msg)
        counters["new"] += 1

        # Upsert contact for the sender
        await _upsert_contact(
            db,
            user_id=account.user_id,
            email_address=(fields["from_address"] or "").lower(),
            display_name=fields["from_name"],
            seen_at=fields["date"] or now,
        )

    await db.flush()
