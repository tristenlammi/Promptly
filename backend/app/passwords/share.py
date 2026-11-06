"""Sharing beyond a vault: the people picker, Secure Send and emergency access.

Secure Send: the server holds a sealed blob, a view count and an expiry. The key is in
the link's fragment. The one exception is posting a link through Rooms or Mail, where
the link passes through this server; the sending screen says so, and a password keeps
it closed even then.

Emergency access: the grantor's vault keys are sealed to the grantee in advance, and
kept here until the wait has run out. The wait is enforced by this server, so someone
who controls the server and is the grantee could skip it. SECURITY.md says so too.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from limits import parse
from pydantic import EmailStr, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import rate_limit as rl
from app.auth.models import User
from app.database import get_db
from app.notifications.dispatch import notify_user
from app.passwords import schemas as s
from app.passwords import service
from app.passwords.deps import VaultIdentity, VaultSession, get_vault_user, parse_uuid, require_enabled, require_session
from app.passwords.models import PwAccount, PwDeviceRequest, PwEmergency, PwSend, PwVault, PwVaultMember
from app.passwords.router import _QuietRoute
from app.rate_limit import rate_limit

logger = logging.getLogger("promptly.passwords")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])

MAX_SEND_BYTES = 10 * 1024 * 1024
MAX_SEND_DAYS = 30
MAX_ACTIVE_SENDS = 200
_LIMIT_SEND_META = rate_limit(parse("60/minute"), bucket="pw_send_meta")
_LIMIT_SEND_OPEN = rate_limit(parse("20/minute"), bucket="pw_send_open")
# Guesses at one Send's password, from anywhere.
_SEND_GUESSES = parse("10/hour")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ people


class PersonOut(s._Base):
    id: uuid.UUID
    username: str
    has_vault: bool


@router.get("/people", response_model=list[PersonOut])
async def people(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[PersonOut]:
    """Who you can share with. Member names, as the rest of Promptly already shows."""
    rows = (
        await db.execute(
            select(User.id, User.username, PwAccount.id)
            .outerjoin(PwAccount, PwAccount.user_id == User.id)
            .where(User.disabled.is_(False), User.id != session.user.id)
            .order_by(User.username)
            .limit(2000)
        )
    ).all()
    return [PersonOut(id=r[0], username=r[1], has_vault=r[2] is not None) for r in rows]


# ------------------------------------------------------------------ Secure Send


class SendCreate(s._Base):
    id: uuid.UUID
    blob: s.B64
    days: int = Field(ge=1, le=MAX_SEND_DAYS)
    views: int | None = Field(default=None, ge=1, le=1000)
    password_salt: s.B64 | None = None
    password_proof: s.B64 | None = None


class SendOut(s._Base):
    id: uuid.UUID
    expires_at: datetime
    views_left: int | None
    has_password: bool
    disabled: bool
    created_at: datetime


class SendMeta(s._Base):
    has_password: bool
    password_salt: s.B64 | None


class SendOpen(s._Base):
    proof: s.B64 | None = None


class SendBlob(s._Base):
    blob: s.B64
    views_left: int | None


def _send_out(row: PwSend) -> SendOut:
    return SendOut(
        id=row.id,
        expires_at=row.expires_at,
        views_left=row.views_left,
        has_password=row.password_verifier is not None,
        disabled=row.disabled_at is not None,
        created_at=row.created_at,
    )


@router.post("/sends", response_model=SendOut, status_code=status.HTTP_201_CREATED)
async def send_create(body: SendCreate, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> SendOut:
    if len(body.blob) > MAX_SEND_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "A Send can be up to 10 MB.")
    if (body.password_salt is None) != (body.password_proof is None):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A password needs both its salt and its proof.")
    if await db.get(PwSend, body.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "That Send already exists.")
    mine = (await db.execute(select(PwSend.id).where(PwSend.user_id == session.user.id))).scalars().all()
    if len(mine) >= MAX_ACTIVE_SENDS:
        raise HTTPException(status.HTTP_409_CONFLICT, "You have too many Sends. Delete some first.")
    row = PwSend(
        id=body.id,
        user_id=session.user.id,
        blob=body.blob,
        expires_at=_now() + timedelta(days=body.days),
        views_left=body.views,
        password_salt=body.password_salt,
        password_verifier=service.verifier(body.password_salt, body.password_proof) if body.password_salt and body.password_proof else None,
    )
    db.add(row)
    await service.activity(db, session.user.id, "send_created", session.device.id if session.device else None)
    await db.commit()
    await db.refresh(row)
    return _send_out(row)


@router.get("/sends", response_model=list[SendOut])
async def send_list(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[SendOut]:
    rows = (await db.execute(select(PwSend).where(PwSend.user_id == session.user.id).order_by(PwSend.created_at.desc()))).scalars().all()
    return [_send_out(r) for r in rows]


async def _my_send(db: AsyncSession, send_id: str, user: User) -> PwSend:
    row = await db.get(PwSend, parse_uuid(send_id))
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.delete("/sends/{send_id}", status_code=status.HTTP_204_NO_CONTENT)
async def send_delete(send_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    await db.delete(await _my_send(db, send_id, session.user))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _gone() -> HTTPException:
    # Never there, deleted, expired or used up all read the same to someone guessing.
    return HTTPException(status.HTTP_404_NOT_FOUND, "This Send has gone. It may have expired or been used up.")


async def _live(db: AsyncSession, row: PwSend | None) -> PwSend:
    if row is None or row.disabled_at is not None or row.expires_at <= _now() or row.views_left == 0:
        raise _gone()
    owner = await db.get(User, row.user_id)
    if owner is None or owner.disabled:
        raise _gone()
    return row


@router.get("/public/sends/{send_id}", response_model=SendMeta)
async def send_meta(send_id: str, response: Response, db: AsyncSession = Depends(get_db), _: None = Depends(_LIMIT_SEND_META)) -> SendMeta:
    """Whether to ask for a password. Doesn't use up a view."""
    response.headers["Cache-Control"] = "no-store"
    try:
        sid = uuid.UUID(send_id)
    except ValueError:
        raise _gone() from None
    row = await _live(db, await db.get(PwSend, sid))
    return SendMeta(has_password=row.password_verifier is not None, password_salt=row.password_salt)


@router.post("/public/sends/{send_id}/open", response_model=SendBlob)
async def send_open(send_id: str, body: SendOpen, request: Request, response: Response, db: AsyncSession = Depends(get_db), _: None = Depends(_LIMIT_SEND_OPEN)) -> SendBlob:
    response.headers["Cache-Control"] = "no-store"
    try:
        sid = uuid.UUID(send_id)
    except ValueError:
        raise _gone() from None
    row = (await db.execute(select(PwSend).where(PwSend.id == sid).with_for_update())).scalar_one_or_none()
    row = await _live(db, row)
    if row.password_verifier is not None:
        if body.proof is None:
            # Asking with nothing isn't a guess, so it can't be used to lock someone out.
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This Send needs its password.")
        limited = rl._settings.RATE_LIMIT_ENABLED and not await rl._limiter.test(_SEND_GUESSES, "pw_send", str(sid))
        if limited:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many tries. Try again later.")
        if not service.verify(row.password_salt or b"", row.password_verifier, body.proof):
            if rl._settings.RATE_LIMIT_ENABLED:
                await rl._limiter.hit(_SEND_GUESSES, "pw_send", str(sid))
            raise HTTPException(status.HTTP_403_FORBIDDEN, "That password isn't right.")
    if row.views_left is not None:
        row.views_left -= 1
    out = SendBlob(blob=row.blob, views_left=row.views_left)
    # Used up: nothing's kept beyond the last view.
    if row.views_left == 0:
        await db.delete(row)
    await db.commit()
    return out


# Posting a link. The body is written here and the link has to look like one, so these
# can't be used to put a secret into Rooms or Mail as plain text.
_LINK = re.compile(r"^https?://[^\s#]+/passwords/send/([0-9a-f-]{36})#[A-Za-z0-9_-]{43}$")


class SendPost(s._Base):
    link: str = Field(max_length=500)
    user_id: uuid.UUID | None = None
    to: EmailStr | None = None


def _check_link(link: str, send_id: uuid.UUID, request: Request) -> None:
    m = _LINK.match(link)
    if m is None or m.group(1) != str(send_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That isn't a link to this Send.")
    # This server's own address and nothing else, or the message could point anywhere.
    parts = urlsplit(link)
    if parts.path != f"/passwords/send/{send_id}" or parts.hostname != request.url.hostname:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That isn't a link to this Send.")


def _send_text(user: User, link: str) -> str:
    return f"{user.username} sent you something through Promptly Passwords. Only someone with this link can open it, and it stops working after its limit:\n\n{link}"


@router.post("/sends/{send_id}/via-rooms", status_code=status.HTTP_204_NO_CONTENT)
async def send_via_rooms(send_id: str, body: SendPost, request: Request, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    row = await _my_send(db, send_id, session.user)
    _check_link(body.link, row.id, request)
    if body.user_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick someone to send it to.")
    await post_to_dm(db, session.user, body.user_id, _send_text(session.user, body.link))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sends/{send_id}/via-mail", status_code=status.HTTP_204_NO_CONTENT)
async def send_via_mail(send_id: str, body: SendPost, request: Request, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    row = await _my_send(db, send_id, session.user)
    _check_link(body.link, row.id, request)
    if not body.to:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Add someone to send it to.")
    from app.mail import router as mail

    accounts = await mail._my_account_ids(db, session.user)
    if not accounts:
        raise HTTPException(status.HTTP_409_CONFLICT, "Set up Mail first, or copy the link instead.")
    await mail.send(mail.SendBody(account_id=accounts[0], to=[str(body.to)], subject="Something sent to you through Promptly Passwords", text=_send_text(session.user, body.link)), db, session.user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def post_to_dm(db: AsyncSession, sender: User, recipient_id: uuid.UUID, text: str) -> None:
    from app.rooms import router as rooms

    room = await rooms.open_dm(rooms.DmIn(user_ids=[recipient_id]), db, sender)
    await rooms.send(uuid.UUID(str(room["id"])), rooms.MessageIn(body=text), db, sender)


# ------------------------------------------------------------------ emergency access


class EmergencyCreate(s._Base):
    grantee_id: uuid.UUID
    wait_days: int = Field(ge=1, le=90)


class EmergencyGrant(s._Base):
    vault_id: uuid.UUID
    generation: int
    wrapped_key: s.B64
    signature: s.B64


class EmergencyWrap(s._Base):
    grants: list[EmergencyGrant] = Field(max_length=200)


class EmergencyOut(s._Base):
    id: uuid.UUID
    grantor_id: uuid.UUID
    grantor: str
    grantee_id: uuid.UUID
    grantee: str
    wait_days: int
    state: str
    requested_at: datetime | None
    opens_at: datetime | None
    # vault id to generation, so the grantor's client knows when to wrap again.
    wrapped: dict[str, int]
    opened_vaults: list[str]


def _unpack(row: PwEmergency) -> dict:
    if not row.wrapped:
        return {}
    return json.loads(row.wrapped.decode())


async def _emergency_out(db: AsyncSession, row: PwEmergency) -> EmergencyOut:
    grantor = await db.get(User, row.grantor_id)
    grantee = await db.get(User, row.grantee_id)
    data = _unpack(row)
    return EmergencyOut(
        id=row.id,
        grantor_id=row.grantor_id,
        grantor=grantor.username if grantor else "",
        grantee_id=row.grantee_id,
        grantee=grantee.username if grantee else "",
        wait_days=row.wait_days,
        state=row.state,
        requested_at=row.requested_at,
        opens_at=row.requested_at + timedelta(days=row.wait_days) if row.requested_at and row.state == "requested" else None,
        wrapped={g["vault_id"]: g["generation"] for g in data.get("grants", [])},
        opened_vaults=data.get("opened", []),
    )


async def _emergency(db: AsyncSession, emergency_id: str, user: User, *, role: str | None = None) -> PwEmergency:
    row = await db.get(PwEmergency, parse_uuid(emergency_id), with_for_update=True)
    # Someone it doesn't concern can't tell it exists.
    if row is None or user.id not in (row.grantor_id, row.grantee_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if role == "grantor" and row.grantor_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the person who set this up can do that.")
    if role == "grantee" and row.grantee_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the trusted contact can do that.")
    return row


@router.post("/emergency", response_model=EmergencyOut, status_code=status.HTTP_201_CREATED)
async def emergency_create(body: EmergencyCreate, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> EmergencyOut:
    if body.grantee_id == session.user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Pick someone other than yourself.")
    target = await db.get(User, body.grantee_id)
    if target is None or target.disabled or not await db.scalar(select(PwAccount.id).where(PwAccount.user_id == target.id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That person hasn't set up Passwords yet.")
    exists = await db.scalar(select(PwEmergency.id).where(PwEmergency.grantor_id == session.user.id, PwEmergency.grantee_id == target.id))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "That person is already your trusted contact.")
    row = PwEmergency(id=uuid.uuid4(), grantor_id=session.user.id, grantee_id=target.id, wait_days=body.wait_days, state="invited")
    db.add(row)
    await service.activity(db, session.user.id, "emergency_invited", session.device.id if session.device else None)
    await db.commit()
    await db.refresh(row)
    await notify_user(
        user_id=target.id,
        category="passwords",
        title="Trusted contact request",
        body=f"{session.user.username} wants you as their emergency contact for Passwords.",
        url="/passwords#/shared",
        tag=f"pw-em-{row.id}",
    )
    return await _emergency_out(db, row)


@router.get("/emergency", response_model=list[EmergencyOut])
async def emergency_list(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[EmergencyOut]:
    rows = (
        (await db.execute(select(PwEmergency).where((PwEmergency.grantor_id == session.user.id) | (PwEmergency.grantee_id == session.user.id)).order_by(PwEmergency.created_at)))
        .scalars()
        .all()
    )
    return [await _emergency_out(db, r) for r in rows]


@router.post("/emergency/{emergency_id}/accept", response_model=EmergencyOut)
async def emergency_accept(emergency_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> EmergencyOut:
    row = await _emergency(db, emergency_id, session.user, role="grantee")
    if row.state != "invited":
        raise HTTPException(status.HTTP_409_CONFLICT, "This has already been answered.")
    row.state = "accepted"
    await service.activity(db, row.grantor_id, "emergency_accepted")
    await db.commit()
    await notify_user(
        user_id=row.grantor_id,
        category="passwords",
        title="Trusted contact accepted",
        body=f"{session.user.username} accepted. Open Passwords on one of your devices to finish.",
        url="/passwords#/shared",
        tag=f"pw-em-{row.id}",
    )
    return await _emergency_out(db, row)


@router.put("/emergency/{emergency_id}/wrap", response_model=EmergencyOut)
async def emergency_wrap(emergency_id: str, body: EmergencyWrap, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> EmergencyOut:
    """The grantor's client seals its vault keys to the grantee, signed. Each must be for
    a vault the grantor manages, at its current generation."""
    row = await _emergency(db, emergency_id, session.user, role="grantor")
    if row.state in ("invited", "opened"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This can't be changed now.")
    stored = []
    for g in body.grants:
        member = await service.member_of(db, g.vault_id, session.user.id)
        vault = await db.get(PwVault, g.vault_id)
        if member is None or vault is None or member.role != "manage":
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        if vault.generation != g.generation:
            raise HTTPException(status.HTTP_409_CONFLICT, "A vault's key has changed. Sync and try again.")
        stored.append({"vault_id": str(g.vault_id), "generation": g.generation, "wrapped_key": s._encode(g.wrapped_key), "signature": s._encode(g.signature)})
    row.wrapped = json.dumps({"grants": stored}).encode()
    if row.state == "accepted":
        row.state = "ready"
    await db.commit()
    return await _emergency_out(db, row)


@router.post("/emergency/{emergency_id}/request", response_model=EmergencyOut)
async def emergency_request(emergency_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> EmergencyOut:
    row = await _emergency(db, emergency_id, session.user, role="grantee")
    if row.state not in ("ready", "refused"):
        raise HTTPException(status.HTTP_409_CONFLICT, "This can't be requested now.")
    row.state = "requested"
    row.requested_at = _now()
    await service.activity(db, row.grantor_id, "emergency_requested")
    await db.commit()
    await _warn_grantor(db, row, session.user)
    return await _emergency_out(db, row)


async def _warn_grantor(db: AsyncSession, row: PwEmergency, grantee: User) -> None:
    """Push and email, because this is the one thing the grantor must not miss."""
    days = row.wait_days
    await notify_user(
        user_id=row.grantor_id,
        category="passwords",
        title="Someone asked for your vault",
        body=f"{grantee.username} asked for emergency access. It opens in {days} day{'s' if days != 1 else ''} unless you refuse.",
        url="/passwords#/shared",
        tag=f"pw-em-{row.id}",
    )
    grantor = await db.get(User, row.grantor_id)
    if grantor is None or not grantor.email:
        return
    try:
        from app.mfa.smtp import send_message

        await send_message(
            db,
            to=grantor.email,
            subject="Emergency access to your Promptly vault was requested",
            text_body=(
                f"{grantee.username} asked for emergency access to your Promptly Passwords vault.\n\n"
                f"It opens in {days} day{'s' if days != 1 else ''} unless you refuse.\n\n"
                "If you weren't expecting this, sign in to Promptly, open Passwords, then Shared vaults, and choose Refuse."
            ),
        )
    except Exception:  # noqa: BLE001 — no mail server set up mustn't stop the request; the push went
        logger.warning("Couldn't email about an emergency access request")


@router.post("/emergency/{emergency_id}/refuse", response_model=EmergencyOut)
async def emergency_refuse(emergency_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> EmergencyOut:
    row = await _emergency(db, emergency_id, session.user, role="grantor")
    if row.state != "requested":
        raise HTTPException(status.HTTP_409_CONFLICT, "There's nothing to refuse.")
    row.state = "refused"
    row.requested_at = None
    await service.activity(db, session.user.id, "emergency_refused", session.device.id if session.device else None)
    await db.commit()
    await notify_user(
        user_id=row.grantee_id,
        category="passwords",
        title="Emergency access refused",
        body=f"{session.user.username} refused your request.",
        url="/passwords#/shared",
        tag=f"pw-em-{row.id}",
    )
    return await _emergency_out(db, row)


@router.post("/emergency/{emergency_id}/open", response_model=EmergencyOut)
async def emergency_open(emergency_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> EmergencyOut:
    """After the wait: the sealed grants become view-only memberships. A grant whose vault
    has moved on since it was wrapped can't open anything, so it's skipped."""
    row = await _emergency(db, emergency_id, session.user, role="grantee")
    if row.state != "requested" or row.requested_at is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ask for access first.")
    if _now() < row.requested_at + timedelta(days=row.wait_days):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The wait hasn't run out yet.")
    data = _unpack(row)
    opened: list[str] = []
    for g in data.get("grants", []):
        vault = await db.get(PwVault, uuid.UUID(g["vault_id"]))
        if vault is None or vault.generation != g["generation"]:
            continue
        if await service.member_of(db, vault.id, row.grantee_id):
            continue
        # They may have left or been demoted since they sealed this.
        still = await service.member_of(db, vault.id, row.grantor_id)
        if still is None or still.role != "manage":
            continue
        db.add(
            PwVaultMember(
                vault_id=vault.id,
                user_id=row.grantee_id,
                role="view",
                wrapped_key=s._decode(g["wrapped_key"]),
                signature=s._decode(g["signature"]),
                granted_by=row.grantor_id,
                generation=vault.generation,
                accepted_at=_now(),
            )
        )
        opened.append(str(vault.id))
    row.wrapped = json.dumps({"opened": opened}).encode()
    row.state = "opened"
    await service.activity(db, row.grantor_id, "emergency_opened")
    await db.commit()
    await notify_user(
        user_id=row.grantor_id,
        category="passwords",
        title="Emergency access opened",
        body=f"{session.user.username} can now read your vault.",
        url="/passwords#/shared",
        tag=f"pw-em-{row.id}",
    )
    return await _emergency_out(db, row)


@router.delete("/emergency/{emergency_id}", status_code=status.HTTP_204_NO_CONTENT)
async def emergency_delete(emergency_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Either side can end it. A grantor whose vault was opened rotates first, on the client;
    the memberships go here either way."""
    row = await _emergency(db, emergency_id, session.user)
    opened = _unpack(row).get("opened", [])
    for vault_id in opened:
        await db.execute(delete(PwVaultMember).where(PwVaultMember.vault_id == uuid.UUID(vault_id), PwVaultMember.user_id == row.grantee_id))
        vault = await db.get(PwVault, uuid.UUID(vault_id))
        if vault is not None:
            vault.rotate_needed = True
    await service.activity(db, session.user.id, "emergency_ended", session.device.id if session.device else None)
    if opened and session.user.id == row.grantee_id:
        # The grantor must still see that this happened, and change the keys. Only they clear it.
        row.state = "ended"
    else:
        await db.delete(row)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ alerts


class AlertsOut(s._Base):
    device_requests: int
    invitations: int
    emergency: int


@router.get("/alerts", response_model=AlertsOut)
async def alerts(identity: VaultIdentity = Depends(get_vault_user), db: AsyncSession = Depends(get_db)) -> AlertsOut:
    """Things waiting on you, as bare counts, for a client that's locked: the Android app
    has no Web Push and can't open a vault session to look. No names, no vault content."""
    requests = await db.scalar(
        select(func.count()).select_from(PwDeviceRequest).where(PwDeviceRequest.user_id == identity.user.id, PwDeviceRequest.status == "pending", PwDeviceRequest.expires_at > _now())
    )
    invited = await db.scalar(select(func.count()).select_from(PwVaultMember).where(PwVaultMember.user_id == identity.user.id, PwVaultMember.accepted_at.is_(None)))
    emergency = await db.scalar(
        select(func.count())
        .select_from(PwEmergency)
        .where(
            ((PwEmergency.grantor_id == identity.user.id) & (PwEmergency.state == "requested"))
            | ((PwEmergency.grantee_id == identity.user.id) & (PwEmergency.state == "invited"))
        )
    )
    return AlertsOut(device_requests=int(requests or 0), invitations=int(invited or 0), emergency=int(emergency or 0))


__all__ = ["router", "post_to_dm"]
