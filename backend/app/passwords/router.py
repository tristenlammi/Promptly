"""/api/passwords: accounts, devices, vaults, sync, sharing.

Everything crossing this API is opaque (see models.py). Bodies aren't logged:
the access log records method, path and status only, and a test holds that.
"""
from __future__ import annotations

import logging
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from limits import parse
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user, require_admin
from app.auth.models import User
from app.config import get_settings
from app.database import get_db
from app.notifications.dispatch import notify_user
from app.passwords import schemas as s
from app.passwords import live as live_channel, service
from app.passwords.deps import (
    SCOPE_MAIL_CODES,
    SCOPE_VAULT,
    SESSION_HARD,
    SESSION_IDLE,
    VaultIdentity,
    VaultSession,
    get_vault_identity,
    get_vault_user,
    hash_token,
    new_device_token,
    new_session_token,
    now,
    parse_uuid,
    policy,
    require_enabled,
    require_session,
)
from app.passwords.models import (
    PwAccount,
    PwActivity,
    PwAttachment,
    PwConnect,
    PwDevice,
    PwDeviceRequest,
    PwEmergency,
    PwHealth,
    PwItem,
    PwItemVersion,
    PwSession,
    PwVault,
    PwVaultMember,
)
from app.rate_limit import rate_limit



class _QuietRoute(APIRoute):
    """FastAPI's 422 echoes the rejected input back, and can't serialise bytes.
    Here the input may be a key, so an error says only where and what kind."""

    def get_route_handler(self):
        handler = super().get_route_handler()

        async def wrapped(request: Request):
            try:
                return await handler(request)
            except RequestValidationError as e:
                detail = [{"loc": list(err.get("loc", ())), "type": err.get("type", "invalid")} for err in e.errors()]
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail) from None

        return wrapped


logger = logging.getLogger("promptly.passwords")

router = APIRouter(route_class=_QuietRoute, dependencies=[Depends(require_enabled)])
admin_router = APIRouter(route_class=_QuietRoute)

KDF_CEILING = {"m": 4 * 1024 * 1024, "t": 32, "p": 8}
PLATFORMS = ("web", "chromium", "firefox", "android", "windows", "ios", "other")
ALLOWED_SCOPES = (SCOPE_VAULT, SCOPE_MAIL_CODES)
CONNECT_TTL = timedelta(minutes=10)
REQUEST_TTL = timedelta(minutes=15)

_LIMIT_WRITE_ACCOUNT = rate_limit(parse("20/minute"), bucket="pw_account")
_RESET_LIMIT = parse("10/hour")
_PROOF_LIMIT = parse(get_settings().RATE_LIMIT_LOGIN)
_LIMIT_CONNECT = rate_limit(parse("20/minute"), bucket="pw_connect")
_LIMIT_POLL = rate_limit(parse("120/minute"), bucket="pw_poll")


async def _proof_blocked(request: Request, user: User | None = None) -> None:
    """Per person and address, wrong proofs only: unlocking all day isn't throttled, guessing
    is, and someone else on the same network isn't caught by it. The account's own counter
    (below) catches guessing from many addresses."""
    from app import rate_limit as rl

    if rl._settings.RATE_LIMIT_ENABLED and not await rl._limiter.test(_PROOF_LIMIT, "pw_proof", rl._client_ip(request), str(user.id) if user else ""):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute and try again.", headers={"Retry-After": "60"})


async def _proof_failed(request: Request, user: User | None = None) -> None:
    from app import rate_limit as rl

    if rl._settings.RATE_LIMIT_ENABLED:
        await rl._limiter.hit(_PROOF_LIMIT, "pw_proof", rl._client_ip(request), str(user.id) if user else "")


def _check_kdf(kdf: s.Kdf, row) -> None:
    ok = (
        kdf.alg == "argon2id"
        and row.min_kdf_m <= kdf.m <= KDF_CEILING["m"]
        and row.min_kdf_t <= kdf.t <= KDF_CEILING["t"]
        and 1 <= kdf.p <= KDF_CEILING["p"]
    )
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "KDF parameters are outside what this server allows.")


def _kdf_out(account: PwAccount) -> s.Kdf:
    return s.Kdf(**account.kdf)


async def _session_for(db: AsyncSession, user: User, device: PwDevice | None) -> tuple[str, PwSession]:
    token = new_session_token()
    current = now()
    row = PwSession(
        user_id=user.id,
        device_id=device.id if device else None,
        token_hash=hash_token(token),
        token_version=user.token_version,
        expires_at=current + SESSION_IDLE,
        hard_expires_at=current + SESSION_HARD,
    )
    db.add(row)
    return token, row


def _session_out(token: str, row: PwSession, account: PwAccount, user: User) -> s.SessionOut:
    return s.SessionOut(
        token=token,
        expires_at=row.expires_at,
        account_id=account.id,
        wrapped_keyset=account.wrapped_keyset,
        kdf=_kdf_out(account),
        salt=account.salt,
        x25519_pub=account.x25519_pub,
        ed25519_pub=account.ed25519_pub,
        kit_confirmed=account.kit_confirmed_at is not None,
        kit_checked_at=account.kit_checked_at,
        user_id=user.id,
    )


# ------------------------------------------------------------------ account


@router.get("/account", response_model=s.Prelogin)
async def prelogin(identity: VaultIdentity = Depends(get_vault_user), db: AsyncSession = Depends(get_db)) -> s.Prelogin:
    """Enough to derive keys. Harmless to a stolen session: the salt and KDF
    settings are useless without the master password and the Secret Key."""
    row = await policy(db)
    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == identity.user.id))
    return s.Prelogin(
        user_id=identity.user.id,
        exists=account is not None,
        account_id=account.id if account else None,
        kdf=_kdf_out(account) if account else None,
        salt=account.salt if account else None,
        wrapped_keyset=account.wrapped_keyset if account else None,
        min_kdf=s.Kdf(alg="argon2id", m=row.min_kdf_m, t=row.min_kdf_t, p=1),
        preview=row.preview_badge,
        enabled=row.enabled,
        server_time=now(),
    )


@router.post("/account", response_model=s.SessionOut, status_code=status.HTTP_201_CREATED)
async def create_account(
    body: s.AccountCreate,
    identity: VaultIdentity = Depends(get_vault_user),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_LIMIT_WRITE_ACCOUNT),
) -> s.SessionOut:
    user = identity.user
    _check_kdf(body.kdf, await policy(db))
    if await db.scalar(select(PwAccount).where(PwAccount.user_id == user.id)):
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have a vault.")
    if await db.get(PwVault, body.personal_vault_id) or await db.get(PwAccount, body.account_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "That id is taken.")
    auth_salt = secrets.token_bytes(16)
    account = PwAccount(
        id=body.account_id,
        user_id=user.id,
        kdf=body.kdf.model_dump(),
        salt=body.salt,
        auth_salt=auth_salt,
        auth_hash=service.verifier(auth_salt, body.auth_key),
        wrapped_keyset=body.wrapped_keyset,
        x25519_pub=body.x25519_pub,
        ed25519_pub=body.ed25519_pub,
    )
    db.add(account)
    db.add(PwVault(id=body.personal_vault_id, kind="personal", encrypted_name=body.personal_vault_name, created_by=user.id))
    await db.flush()
    db.add(
        PwVaultMember(
            vault_id=body.personal_vault_id,
            user_id=user.id,
            role="manage",
            wrapped_key=body.personal_vault_grant.wrapped_key,
            signature=body.personal_vault_grant.signature,
            granted_by=user.id,
            generation=1,
            accepted_at=now(),
        )
    )
    token, row = await _session_for(db, user, identity.device)
    await service.activity(db, user.id, "vault_created", identity.device.id if identity.device else None)
    await db.commit()
    # So someone with a stolen sign-in can't quietly set up a vault in this person's name.
    await notify_user(user_id=user.id, category="passwords", title="A password vault was set up", body="A vault was just set up on your account. If that wasn't you, change your Promptly password and reset the vault.", url="/passwords", tag="pw-created")
    return _session_out(token, row, account, user)


@router.post("/session", response_model=s.SessionOut)
async def create_session(
    body: s.SessionCreate,
    request: Request,
    identity: VaultIdentity = Depends(get_vault_user),
    db: AsyncSession = Depends(get_db),
) -> s.SessionOut:
    # The same key as _proof_failed below records, or this limit never comes into it.
    await _proof_blocked(request, identity.user)
    user = identity.user
    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == user.id).with_for_update())
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No vault yet.")
    current = now()
    if account.locked_until and account.locked_until > current:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many wrong tries. Wait a while and try again.",
            headers={"Retry-After": str(int((account.locked_until - current).total_seconds()) + 1)},
        )
    if not service.verify(account.auth_salt, account.auth_hash, body.auth_key):
        locked = False
        account.failed_attempts += 1
        if account.failed_attempts >= service.FAILED_LIMIT:
            account.locked_until = current + timedelta(minutes=service.LOCK_MINUTES)
            account.failed_attempts = 0
            await service.activity(db, user.id, "unlock_locked_out", identity.device.id if identity.device else None)
            locked = True
        await db.commit()
        await _proof_failed(request, user)
        if locked:
            await notify_user(user_id=user.id, category="passwords", title="Vault unlock paused", body="Too many wrong tries to unlock your vault, so it's paused for a while. If that wasn't you, change your Promptly password.", url="/passwords", tag="pw-locked")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_key")
    account.failed_attempts = 0
    account.locked_until = None
    token, row = await _session_for(db, user, identity.device)
    await service.activity(db, user.id, "unlocked", identity.device.id if identity.device else None)
    await db.commit()
    return _session_out(token, row, account, user)


@router.delete("/session", status_code=status.HTTP_204_NO_CONTENT)
async def end_session(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    session.session.revoked_at = now()
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/account/rekey", status_code=status.HTTP_204_NO_CONTENT)
async def rekey(
    body: s.Rekey,
    request: Request,
    session: VaultSession = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Master password change, Secret Key rotation or a KDF upgrade: the keyset
    is re-wrapped, nothing else moves. Other sessions end."""
    await _proof_blocked(request, session.user)
    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == session.user.id).with_for_update())
    if account is None or not service.verify(account.auth_salt, account.auth_hash, body.auth_key):
        await _proof_failed(request, session.user)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong_key")
    _check_kdf(body.new_kdf, await policy(db))
    salt = secrets.token_bytes(16)
    account.kdf = body.new_kdf.model_dump()
    account.salt = body.new_salt
    account.auth_salt = salt
    account.auth_hash = service.verifier(salt, body.new_auth_key)
    account.wrapped_keyset = body.new_wrapped_keyset
    others = await db.execute(
        select(PwSession).where(PwSession.user_id == session.user.id, PwSession.id != session.session.id, PwSession.revoked_at.is_(None))
    )
    for row in others.scalars():
        row.revoked_at = now()
    await service.activity(db, session.user.id, "master_password_changed", session.device.id if session.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/account/kit", status_code=status.HTTP_204_NO_CONTENT)
async def confirm_kit(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == session.user.id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No vault yet.")
    current = now()
    account.kit_confirmed_at = account.kit_confirmed_at or current
    account.kit_checked_at = current
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _check_step_up(db: AsyncSession, user: User, body: s.ResetVault) -> None:
    """Promptly login plus MFA, when the account has MFA; otherwise its password
    (SSO users without either get the typed confirmation and their live session)."""
    from app.auth.utils import averify_password, decrypt_secret
    from app.mfa import backup as backup_codes
    from app.mfa import service as mfa_service
    from app.mfa import totp as totp_service

    secret = await mfa_service.get_secret(db, user_id=user.id)
    if secret is not None and secret.enrolled_at is not None:
        if body.backup_code and await backup_codes.verify_and_consume(db, user_id=user.id, submitted=body.backup_code):
            return
        if body.totp_code and secret.totp_secret_encrypted:
            try:
                plain = decrypt_secret(secret.totp_secret_encrypted)
            except ValueError:
                plain = ""
            if plain and totp_service.verify_code(plain, body.totp_code) and await totp_service.consume_totp(user.id, body.totp_code):
                return
        raise HTTPException(status.HTTP_403_FORBIDDEN, "mfa_required")
    if user.password_hash and user.password_hash != "!":
        if not body.password or not await averify_password(body.password, user.password_hash):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "password_required")


@router.post("/account/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_vault(
    body: s.ResetVault,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_LIMIT_WRITE_ACCOUNT),
) -> Response:
    """Destroys the vault. For someone who lost both master password and kit.
    Bearer session only, never a device token, and nothing here recovers data."""
    if body.confirm != "DELETE MY VAULT":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Type the confirmation exactly.")
    # First, so this can't be used to test a password for an account with no vault. Tries are
    # counted per account as well as per address, since a right guess here destroys things.
    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == user.id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No vault yet.")
    from app import rate_limit as rl

    if rl._settings.RATE_LIMIT_ENABLED and not await rl._limiter.test(_RESET_LIMIT, "pw_reset", str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many tries. Try again later.")
    try:
        await _check_step_up(db, user, body)
    except HTTPException:
        if rl._settings.RATE_LIMIT_ENABLED:
            await rl._limiter.hit(_RESET_LIMIT, "pw_reset", str(user.id))
        raise
    # Shared vaults this person is the last manager of get a new one, or nobody could ever run them.
    theirs = (await db.execute(select(PwVaultMember).where(PwVaultMember.user_id == user.id, PwVaultMember.role == "manage"))).scalars().all()
    for m in theirs:
        others = (await db.execute(select(PwVaultMember).where(PwVaultMember.vault_id == m.vault_id, PwVaultMember.user_id != user.id).order_by(PwVaultMember.created_at))).scalars().all()
        if others and not any(o.role == "manage" for o in others):
            others[0].role = "manage"
    personal = (
        await db.execute(
            select(PwVault.id)
            .join(PwVaultMember, PwVaultMember.vault_id == PwVault.id)
            .where(PwVaultMember.user_id == user.id, PwVault.kind == "personal", PwVault.created_by == user.id)
        )
    ).scalars().all()
    for vault_id in personal:
        service.remove_attachment_files(vault_id)
    await db.execute(delete(PwVault).where(PwVault.id.in_(personal)))
    await db.execute(delete(PwVaultMember).where(PwVaultMember.user_id == user.id))
    await db.execute(delete(PwSession).where(PwSession.user_id == user.id))
    await db.delete(account)
    await service.activity(db, user.id, "vault_reset")
    await db.commit()
    await notify_user(user_id=user.id, category="passwords", title="Your password vault was reset", body="Your vault was destroyed and reset. If that wasn't you, change your Promptly password straight away.", url="/passwords", tag="pw-reset")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ devices


def _device_out(row: PwDevice, current: PwDevice | None) -> s.DeviceOut:
    return s.DeviceOut(
        id=row.id,
        name=row.name,
        platform=row.platform,
        scopes=row.scopes,
        last_seen_at=row.last_seen_at,
        created_at=row.created_at,
        revoked_at=row.revoked_at,
        current=bool(current and current.id == row.id),
    )


def _clean_scopes(scopes: list[str]) -> list[str]:
    bad = [x for x in scopes if x not in ALLOWED_SCOPES]
    if bad or not scopes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown device scope.")
    return sorted(set(scopes))


def _clean_platform(platform: str) -> str:
    if platform not in PLATFORMS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown platform.")
    return platform


@router.get("/devices", response_model=list[s.DeviceOut])
async def list_devices(identity: VaultIdentity = Depends(get_vault_user), db: AsyncSession = Depends(get_db)) -> list[s.DeviceOut]:
    rows = (
        await db.execute(select(PwDevice).where(PwDevice.user_id == identity.user.id, PwDevice.revoked_at.is_(None)).order_by(PwDevice.created_at.desc()))
    ).scalars().all()
    return [_device_out(r, identity.device) for r in rows]


@router.post("/devices/register", status_code=status.HTTP_201_CREATED)
async def register_device(
    body: s.DeviceRegister,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_LIMIT_CONNECT),
) -> dict:
    """Android holds an app password for the suite already, so it can ask for a
    device token straight out. A bearer session can too. A device token can't
    mint another one, and neither can a stolen vault session on its own."""
    from app.auth.basic import client_ip, user_from_basic

    header = request.headers.get("authorization") or ""
    if header.lower().startswith("basic "):
        user = await user_from_basic(db, header, scope="assistant", ip=client_ip(request))
    elif header.lower().startswith("bearer ") and not header[7:].startswith("pwd_"):
        from app.auth.deps import _resolve_custom_user
        from fastapi.security import HTTPAuthorizationCredentials

        user = await _resolve_custom_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=header[7:]), db)
    else:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in first.")
    token = new_device_token()
    device = PwDevice(
        user_id=user.id,
        name=body.name,
        platform=_clean_platform(body.platform),
        token_hash=hash_token(token),
        scopes=_clean_scopes(body.scopes),
        token_version=user.token_version,
    )
    db.add(device)
    await db.flush()
    await service.activity(db, user.id, "device_added", device.id)
    await db.commit()
    return {"token": token, "device_id": str(device.id), "user_id": str(user.id)}


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(device_id: str, identity: VaultIdentity = Depends(get_vault_user), db: AsyncSession = Depends(get_db)) -> Response:
    row = await db.get(PwDevice, parse_uuid(device_id))
    if row is None or row.user_id != identity.user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    # A device can drop itself. A stolen device token can't cut off all the others.
    if identity.device is not None and identity.device.id != row.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Remove other devices from a signed-in browser.")
    row.revoked_at = now()
    await db.execute(delete(PwSession).where(PwSession.device_id == row.id))
    await service.activity(db, identity.user.id, "device_removed", identity.device.id if identity.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Connect: a client with nothing yet shows a code; a signed-in person approves.


@router.post("/connect/start", response_model=s.ConnectStarted, status_code=status.HTTP_201_CREATED)
async def connect_start(body: s.ConnectStart, db: AsyncSession = Depends(get_db), _: None = Depends(_LIMIT_CONNECT)) -> s.ConnectStarted:
    _clean_platform(body.platform)
    scopes = _clean_scopes(body.scopes)
    poll = secrets.token_urlsafe(32)
    code = secrets.token_hex(4).upper()
    row = PwConnect(
        code=code,
        poll_hash=hash_token(poll),
        name=body.name,
        scopes=scopes,
        platform=body.platform,
        expires_at=now() + CONNECT_TTL,
    )
    db.add(row)
    await db.commit()
    return s.ConnectStarted(id=row.id, code=code, poll_secret=poll, expires_at=row.expires_at)


async def _pending_connect(db: AsyncSession, code: str) -> PwConnect:
    row = await db.scalar(select(PwConnect).where(PwConnect.code == code.upper()).with_for_update())
    if row is None or row.expires_at <= now():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That code isn't valid any more.")
    return row


@router.get("/connect/code/{code}", response_model=s.ConnectInfo)
async def connect_info(code: str, _user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db), _rl: None = Depends(_LIMIT_CONNECT)) -> s.ConnectInfo:
    row = await _pending_connect(db, code)
    return s.ConnectInfo(name=row.name, platform=row.platform, scopes=row.scopes, status=row.status)


@router.post("/connect/code/{code}/approve", status_code=status.HTTP_204_NO_CONTENT)
async def connect_approve(code: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db), _rl: None = Depends(_LIMIT_CONNECT)) -> Response:
    """Bearer session only: a device token can't add another device."""
    row = await _pending_connect(db, code)
    if row.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "That code was already used.")
    row.status = "approved"
    row.user_id = user.id
    row.token_version = user.token_version
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/connect/code/{code}/deny", status_code=status.HTTP_204_NO_CONTENT)
async def connect_deny(code: str, _user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db), _rl: None = Depends(_LIMIT_CONNECT)) -> Response:
    row = await _pending_connect(db, code)
    if row.status == "pending":
        row.status = "denied"
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/connect/poll", response_model=s.ConnectResult)
async def connect_poll(body: s.ConnectPoll, db: AsyncSession = Depends(get_db), _: None = Depends(_LIMIT_POLL)) -> s.ConnectResult:
    row = await db.scalar(select(PwConnect).where(PwConnect.id == body.id).with_for_update())
    if row is None or row.expires_at <= now() or not secrets.compare_digest(row.poll_hash, hash_token(body.poll_secret)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if row.status != "approved":
        return s.ConnectResult(status=row.status)
    # The token is made here and handed over once: the server only ever stores its hash.
    user = await db.get(User, row.user_id)
    if user is None or user.disabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if row.token_version != user.token_version:
        # They signed out everywhere after approving this. It doesn't outlive that.
        await db.delete(row)
        await db.commit()
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    token = new_device_token()
    device = PwDevice(user_id=user.id, name=row.name, platform=row.platform, token_hash=hash_token(token), scopes=row.scopes, token_version=user.token_version)
    db.add(device)
    await db.flush()
    await service.activity(db, user.id, "device_added", device.id)
    device_name = row.name
    await db.delete(row)
    await db.commit()
    await notify_user(user_id=user.id, category="passwords", title="New device connected", body=f"{device_name[:60]} can now ask to join your vault. If that wasn't you, remove it in Passwords, Devices.", url="/passwords#/devices", tag=f"pw-dev-{device.id}")
    return s.ConnectResult(status="approved", token=token, device_id=device.id, user_id=user.id)


# Device approval: how a new device gets the Secret Key. The server carries only
# public keys and a blob sealed to the new device's ephemeral key.


@router.post("/device-requests", response_model=s.DeviceRequestCreated, status_code=status.HTTP_201_CREATED)
async def device_request_create(
    body: s.DeviceRequestCreate,
    identity: VaultIdentity = Depends(get_vault_user),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(_LIMIT_CONNECT),
) -> s.DeviceRequestCreated:
    _clean_platform(body.platform)
    poll = secrets.token_urlsafe(32)
    code = secrets.token_hex(3).upper()
    row = PwDeviceRequest(
        user_id=identity.user.id,
        name=body.name,
        platform=body.platform,
        code=code,
        poll_hash=hash_token(poll),
        device_pub=body.device_pub,
        expires_at=now() + REQUEST_TTL,
    )
    db.add(row)
    await db.commit()
    await notify_user(
        user_id=identity.user.id,
        category="passwords",
        title="A new device wants your vault",
        body=f"{body.name} is asking to join. Approve it from a device that's unlocked.",
        url="/passwords#/devices",
        tag=f"pw-device-{row.id}",
    )
    return s.DeviceRequestCreated(id=row.id, code=code, poll_secret=poll, expires_at=row.expires_at)


async def _own_request(db: AsyncSession, request_id: str, user: User) -> PwDeviceRequest:
    row = await db.get(PwDeviceRequest, parse_uuid(request_id), with_for_update=True)
    if row is None or row.user_id != user.id or row.expires_at <= now():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return row


@router.get("/device-requests", response_model=list[s.DeviceRequestOut])
async def device_request_list(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[s.DeviceRequestOut]:
    rows = (
        await db.execute(
            select(PwDeviceRequest)
            .where(PwDeviceRequest.user_id == session.user.id, PwDeviceRequest.expires_at > now(), PwDeviceRequest.status == "pending")
            .order_by(PwDeviceRequest.created_at.desc())
        )
    ).scalars().all()
    return [
        s.DeviceRequestOut(
            id=r.id, name=r.name, platform=r.platform, code=r.code, device_pub=r.device_pub, approver_pub=r.approver_pub,
            status=r.status, created_at=r.created_at, expires_at=r.expires_at,
        )
        for r in rows
    ]


@router.post("/device-requests/{request_id}/approver", status_code=status.HTTP_204_NO_CONTENT)
async def device_request_approver(
    request_id: str, body: s.DeviceRequestApprover, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)
) -> Response:
    row = await _own_request(db, request_id, session.user)
    # Re-opening the approval on this or another device starts the exchange over, so
    # both screens get new words. Approving still needs them to match.
    if row.status != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "This request has already been answered.")
    row.approver_pub = body.approver_pub
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/device-requests/{request_id}/approve", status_code=status.HTTP_204_NO_CONTENT)
async def device_request_approve(
    request_id: str, body: s.DeviceRequestApprove, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)
) -> Response:
    row = await _own_request(db, request_id, session.user)
    if row.status != "pending" or row.approver_pub is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This request can't be approved now.")
    row.payload = body.payload
    row.status = "approved"
    await service.activity(db, session.user.id, "device_approved", session.device.id if session.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/device-requests/{request_id}/deny", status_code=status.HTTP_204_NO_CONTENT)
async def device_request_deny(request_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    row = await _own_request(db, request_id, session.user)
    row.status = "denied"
    row.payload = None
    await service.activity(db, session.user.id, "device_denied", session.device.id if session.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/device-requests/{request_id}/poll", response_model=s.DeviceRequestState)
async def device_request_poll(
    request_id: str, body: s.DeviceRequestPoll, identity: VaultIdentity = Depends(get_vault_user), db: AsyncSession = Depends(get_db), _: None = Depends(_LIMIT_POLL)
) -> s.DeviceRequestState:
    row = await _own_request(db, request_id, identity.user)
    if not secrets.compare_digest(row.poll_hash, hash_token(body.poll_secret)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    out = s.DeviceRequestState(status=row.status, approver_pub=row.approver_pub, payload=row.payload)
    if row.status == "approved":
        # One pickup. The blob is sealed anyway; no reason to leave it around.
        await db.delete(row)
        await db.commit()
    return out


# ------------------------------------------------------------------ vaults


async def _vault_out(db: AsyncSession, vault: PwVault, member: PwVaultMember) -> s.VaultOut:
    return s.VaultOut(
        id=vault.id,
        # Someone else's personal vault, open through emergency access, is just a vault
        # shared with this person. To them, "personal" means their own.
        kind="shared" if vault.kind == "personal" and vault.created_by != member.user_id else vault.kind,
        rotate_needed=vault.rotate_needed if member.role == "manage" else False,
        revision=vault.revision,
        generation=vault.generation,
        name=vault.encrypted_name,
        role=member.role,
        wrapped_key=member.wrapped_key,
        signature=member.signature,
        granted_by=member.granted_by,
        member_generation=member.generation,
        accepted=member.accepted_at is not None,
        member_count=await service.member_count(db, vault.id),
    )


async def _member(db: AsyncSession, vault_id: str, user: User) -> tuple[PwVault, PwVaultMember]:
    vid = parse_uuid(vault_id)
    member = await service.member_of(db, vid, user.id)
    vault = await db.get(PwVault, vid) if member else None
    # The same answer for "no such vault" and "not yours".
    if member is None or vault is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return vault, member


def _require(member: PwVaultMember, roles: tuple[str, ...]) -> None:
    if member.role not in roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role in this vault doesn't allow that.")


@router.get("/vaults", response_model=list[s.VaultOut])
async def list_vaults(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[s.VaultOut]:
    rows = (
        await db.execute(
            select(PwVault, PwVaultMember)
            .join(PwVaultMember, PwVaultMember.vault_id == PwVault.id)
            .where(PwVaultMember.user_id == session.user.id)
            .order_by(PwVault.created_at)
        )
    ).all()
    return [await _vault_out(db, v, m) for v, m in rows]


@router.post("/vaults", response_model=s.VaultOut, status_code=status.HTTP_201_CREATED)
async def create_vault(body: s.VaultCreate, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> s.VaultOut:
    if await db.get(PwVault, body.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "That id is taken.")
    vault = PwVault(id=body.id, kind="shared", encrypted_name=body.name, created_by=session.user.id)
    db.add(vault)
    await db.flush()
    member = PwVaultMember(
        vault_id=body.id,
        user_id=session.user.id,
        role="manage",
        wrapped_key=body.grant.wrapped_key,
        signature=body.grant.signature,
        granted_by=session.user.id,
        generation=1,
        accepted_at=now(),
    )
    db.add(member)
    await service.activity(db, session.user.id, "vault_shared_created", session.device.id if session.device else None)
    await db.commit()
    await db.refresh(vault)
    return await _vault_out(db, vault, member)


@router.patch("/vaults/{vault_id}", status_code=status.HTTP_204_NO_CONTENT)
async def rename_vault(vault_id: str, body: s.VaultRename, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, ("manage",))
    vault.encrypted_name = body.name
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/vaults/{vault_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_vault(vault_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, ("manage",))
    if vault.kind == "personal":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your personal vault stays. Reset it from Settings.")
    service.remove_attachment_files(vault.id)
    await db.delete(vault)
    await service.activity(db, session.user.id, "vault_deleted", session.device.id if session.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/vaults/{vault_id}/accept", status_code=status.HTTP_204_NO_CONTENT)
async def accept_vault(vault_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    _, member = await _member(db, vault_id, session.user)
    member.accepted_at = member.accepted_at or now()
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/vaults/{vault_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_vault(vault_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    await db.get(PwVault, vault.id, with_for_update=True)
    if vault.kind == "personal" and vault.created_by == session.user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't leave your personal vault.")
    managers = await db.scalar(
        select(func.count()).select_from(PwVaultMember).where(PwVaultMember.vault_id == vault.id, PwVaultMember.role == "manage")
    )
    if member.role == "manage" and int(managers or 0) <= 1 and await service.member_count(db, vault.id) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Make someone else a manager first.")
    await db.delete(member)
    # They still hold the old key, so whoever manages it should change it.
    vault.rotate_needed = True
    await service.activity(db, session.user.id, "vault_left", session.device.id if session.device else None)
    await db.commit()
    if await service.member_count(db, vault.id) == 0:
        service.remove_attachment_files(vault.id)
        await db.delete(vault)
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ sync


@router.get("/vaults/{vault_id}/changes", response_model=s.ChangesOut)
async def changes(
    vault_id: str,
    since: int = 0,
    limit: int = 500,
    session: VaultSession = Depends(require_session),
    db: AsyncSession = Depends(get_db),
) -> s.ChangesOut:
    vault, _member_row = await _member(db, vault_id, session.user)
    limit = max(1, min(1000, limit))
    rows = (
        await db.execute(
            select(PwItem).where(PwItem.vault_id == vault.id, PwItem.revision > since).order_by(PwItem.revision, PwItem.id).limit(limit + 1)
        )
    ).scalars().all()
    more = len(rows) > limit
    if more and rows[limit].revision == rows[limit - 1].revision:
        # The client carries on from the last revision it saw, and a batch or a key rotation
        # gives many items one revision. A page must never end part-way through one, or the
        # rest are skipped for good on that device.
        same = rows[limit - 1].revision
        rows = (
            await db.execute(
                select(PwItem).where(PwItem.vault_id == vault.id, PwItem.revision > since, PwItem.revision <= same).order_by(PwItem.revision, PwItem.id)
            )
        ).scalars().all()
        more = (await db.scalar(select(func.count()).select_from(PwItem).where(PwItem.vault_id == vault.id, PwItem.revision > same))) > 0
    else:
        rows = rows[:limit]
    return s.ChangesOut(
        revision=vault.revision,
        generation=vault.generation,
        items=[
            s.ItemOut(id=r.id, revision=r.revision, blob=r.blob, deleted=r.deleted_at is not None, purged=r.blob is None, updated_at=r.updated_at)
            for r in rows
        ],
        more=more,
    )


@router.post("/vaults/{vault_id}/items", response_model=s.BatchOut)
async def write_items(vault_id: str, body: s.ItemBatch, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> s.BatchOut:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, service.WRITE_ROLES)
    if len({e.id for e in body.items}) != len(body.items):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "An item appears twice in that batch.")
    if body.generation is not None and body.generation != vault.generation:
        raise HTTPException(status.HTTP_409_CONFLICT, "This vault has a new key. Sync and try again.")
    total = await db.scalar(select(func.count()).select_from(PwItem).where(PwItem.vault_id == vault.id))
    if int(total or 0) + len(body.items) > service.MAX_ITEMS_PER_VAULT:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "This vault is full.")
    for e in body.items:
        if not e.purge and e.blob is None and not await db.get(PwItem, e.id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A new item needs a blob.")
    entries = [{"id": e.id, "base_revision": e.base_revision, "blob": e.blob, "deleted": e.deleted, "purge": e.purge} for e in body.items]
    result = await service.write_batch(db, vault.id, entries)
    await db.commit()
    if result["applied"]:
        # Every member's other devices pull now rather than on their next minute (live.py).
        await live_channel.vault_changed(db, vault.id, result["revision"])
    gone = [e.id for e in body.items if (e.deleted or e.purge) and str(e.id) in result["applied"]]
    if gone:
        from app.passwords.reminders import remove_for_items

        await remove_for_items(db, gone)  # Their Calendar events and tasks go too.
    return s.BatchOut(
        revision=result["revision"],
        applied=[uuid.UUID(x) for x in result["applied"]],
        conflicts=[s.ConflictOut(**c) for c in result["conflicts"]],
    )


@router.get("/vaults/{vault_id}/items/{item_id}/versions", response_model=list[s.VersionOut])
async def item_versions(vault_id: str, item_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[s.VersionOut]:
    vault, _m = await _member(db, vault_id, session.user)
    item = await db.get(PwItem, parse_uuid(item_id))
    if item is None or item.vault_id != vault.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    rows = (
        await db.execute(select(PwItemVersion).where(PwItemVersion.item_id == item.id).order_by(PwItemVersion.revision.desc()))
    ).scalars().all()
    return [s.VersionOut(revision=r.revision, blob=r.blob, created_at=r.created_at) for r in rows]


# ------------------------------------------------------------------ members


@router.get("/users/{user_id}/keys", response_model=s.PublicKeys)
async def user_keys(user_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> s.PublicKeys:
    _ = session
    account = await db.scalar(select(PwAccount).where(PwAccount.user_id == parse_uuid(user_id)))
    target = await db.get(User, parse_uuid(user_id))
    if account is None or target is None or target.disabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That person hasn't set up Passwords yet.")
    return s.PublicKeys(user_id=target.id, username=target.username, x25519_pub=account.x25519_pub, ed25519_pub=account.ed25519_pub)


@router.get("/vaults/{vault_id}/members", response_model=list[s.MemberOut])
async def list_members(vault_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[s.MemberOut]:
    vault, _m = await _member(db, vault_id, session.user)
    rows = (
        await db.execute(
            select(PwVaultMember, User, PwAccount)
            .join(User, User.id == PwVaultMember.user_id)
            .outerjoin(PwAccount, PwAccount.user_id == PwVaultMember.user_id)
            .where(PwVaultMember.vault_id == vault.id)
            .order_by(User.username)
        )
    ).all()
    return [
        s.MemberOut(
            user_id=m.user_id,
            username=u.username,
            role=m.role,
            granted_by=m.granted_by,
            generation=m.generation,
            accepted=m.accepted_at is not None,
            x25519_pub=a.x25519_pub if a else None,
            ed25519_pub=a.ed25519_pub if a else None,
        )
        for m, u, a in rows
    ]


@router.post("/vaults/{vault_id}/members", status_code=status.HTTP_204_NO_CONTENT)
async def add_member(vault_id: str, body: s.MemberAdd, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, ("manage",))
    await db.get(PwVault, vault.id, with_for_update=True)
    if vault.kind == "personal":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Make a shared vault to share with others.")
    if body.role not in service.ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown role.")
    target = await db.get(User, body.user_id)
    if target is None or target.disabled or not await db.scalar(select(PwAccount.id).where(PwAccount.user_id == target.id)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That person hasn't set up Passwords yet.")
    if await service.member_of(db, vault.id, target.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Already a member.")
    db.add(
        PwVaultMember(
            vault_id=vault.id,
            user_id=target.id,
            role=body.role,
            wrapped_key=body.grant.wrapped_key,
            signature=body.grant.signature,
            granted_by=session.user.id,
            generation=vault.generation,
        )
    )
    await service.activity(db, session.user.id, "vault_member_added", session.device.id if session.device else None)
    await service.activity(db, target.id, "vault_invited")
    await db.commit()
    await notify_user(
        user_id=target.id,
        category="passwords",
        title="A shared vault is waiting",
        body=f"{session.user.username} shared a password vault with you.",
        url="/passwords#/shared",
        tag=f"pw-share-{vault.id}",
    )
    # A card in their DMs as well. It carries no vault name, because Rooms can read it.
    try:
        from app.passwords.share import post_to_dm

        await post_to_dm(db, session.user, target.id, "I've shared a password vault with you. Open Passwords, then Shared vaults, to accept it.")
    except Exception:  # noqa: BLE001 — the push went, and the invitation itself is in
        logger.warning("Couldn't post a vault invitation to Rooms")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/vaults/{vault_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def set_member_role(vault_id: str, user_id: str, body: s.MemberRole, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    vault, member = await _member(db, vault_id, session.user)
    _require(member, ("manage",))
    await db.get(PwVault, vault.id, with_for_update=True)
    if body.role not in service.ROLES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown role.")
    target = await service.member_of(db, vault.id, parse_uuid(user_id))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if target.role == "manage" and body.role != "manage":
        managers = await db.scalar(
            select(func.count()).select_from(PwVaultMember).where(PwVaultMember.vault_id == vault.id, PwVaultMember.role == "manage")
        )
        if int(managers or 0) <= 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A vault needs at least one manager.")
    target.role = body.role
    await service.activity(db, session.user.id, "vault_role_changed", session.device.id if session.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/vaults/{vault_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(vault_id: str, user_id: str, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Cuts someone off now, whatever else happens. The new key is a separate step, since it
    has to re-encrypt everything and can fail; the vault's flagged until that's done."""
    vault, member = await _member(db, vault_id, session.user)
    _require(member, ("manage",))
    locked = await service.bump_revision(db, vault.id)
    uid = parse_uuid(user_id)
    if uid == session.user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use Leave to remove yourself.")
    target = await service.member_of(db, vault.id, uid)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    if vault.kind == "personal":
        opened = await db.scalar(select(PwEmergency.id).where(PwEmergency.grantor_id == session.user.id, PwEmergency.grantee_id == uid))
        if opened is None and vault.created_by == session.user.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A personal vault has no other members.")
    await db.delete(target)
    locked.rotate_needed = True
    await service.activity(db, session.user.id, "vault_member_removed", session.device.id if session.device else None)
    await service.activity(db, uid, "vault_removed")
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/vaults/{vault_id}/rotate", status_code=status.HTTP_204_NO_CONTENT)
async def rotate_vault(vault_id: str, body: s.Rotate, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Removing a member means a new vault key: the client re-encrypts every
    item and retained version and sends it all here, applied atomically. A
    partial rotation would leave items nobody can read, so it's all or nothing."""
    vid = parse_uuid(vault_id)
    member = await service.member_of(db, vid, session.user.id)
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    _require(member, ("manage",))
    vault = await service.bump_revision(db, vid)
    if vault.kind == "personal" and body.remove_user_ids:
        # The one way someone else is in a personal vault: emergency access was opened.
        allowed = set(
            (await db.execute(select(PwEmergency.grantee_id).where(PwEmergency.grantor_id == session.user.id, PwEmergency.state == "opened"))).scalars().all()
        )
        if not set(body.remove_user_ids) <= allowed:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A personal vault has no other members.")
    if body.from_generation != vault.generation:
        raise HTTPException(status.HTTP_409_CONFLICT, "Someone rotated this vault first. Reload and try again.")
    # bump_revision above moved it on by one. Anything else means a write since the client read.
    if body.from_revision is not None and vault.revision - 1 != body.from_revision:
        raise HTTPException(status.HTTP_409_CONFLICT, "Something changed in this vault. Try again.")
    if len(set(body.remove_user_ids)) != len(body.remove_user_ids):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Someone's listed twice.")
    if session.user.id in body.remove_user_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Use Leave to remove yourself.")

    rows = (await db.execute(select(PwVaultMember).where(PwVaultMember.vault_id == vid))).scalars().all()
    if not set(body.remove_user_ids) <= {m.user_id for m in rows}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That person isn't a member.")
    remaining = {m.user_id: m for m in rows if m.user_id not in body.remove_user_ids}
    if {m.user_id for m in body.members} != set(remaining):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A new key is needed for every remaining member.")
    live = (await db.execute(select(PwItem).where(PwItem.vault_id == vid, PwItem.blob.is_not(None)))).scalars().all()
    by_id = {i.id: i for i in live}
    if {i.id for i in body.items} != set(by_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Every item must be re-encrypted. Sync and try again.")

    vault.generation += 1
    vault.rotate_needed = False
    vault.encrypted_name = body.name
    rev = vault.revision
    for m in rows:
        if m.user_id in body.remove_user_ids:
            await db.delete(m)
    for g in body.members:
        m = remaining[g.user_id]
        m.wrapped_key = g.grant.wrapped_key
        m.signature = g.grant.signature
        m.granted_by = session.user.id
        m.generation = vault.generation
    for i in body.items:
        row = by_id[i.id]
        row.blob = i.blob
        row.size_bucket = len(i.blob)
        row.revision = rev
        kept = {v.revision: v for v in i.versions}
        versions = (await db.execute(select(PwItemVersion).where(PwItemVersion.item_id == row.id))).scalars().all()
        for v in versions:
            if v.revision in kept:
                v.blob = kept[v.revision].blob
            else:
                # Not re-encrypted means unreadable, so it can't stay.
                await db.delete(v)
    await service.activity(db, session.user.id, "vault_key_rotated", session.device.id if session.device else None)
    for removed in body.remove_user_ids:
        await service.activity(db, removed, "vault_removed")
    await db.commit()
    await live_channel.vault_changed(db, vault.id, rev)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ activity, health


@router.get("/activity", response_model=list[s.ActivityOut])
async def activity_log(limit: int = 100, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[s.ActivityOut]:
    rows = (
        await db.execute(
            select(PwActivity).where(PwActivity.user_id == session.user.id).order_by(PwActivity.at.desc()).limit(max(1, min(500, limit)))
        )
    ).scalars().all()
    return [s.ActivityOut(event=r.event, device_id=r.device_id, at=r.at) for r in rows]


@router.post("/activity/export", status_code=status.HTTP_204_NO_CONTENT)
async def note_export(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    await service.activity(db, session.user.id, "exported", session.device.id if session.device else None)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/health", status_code=status.HTTP_204_NO_CONTENT)
async def post_health(body: s.HealthIn, session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    """Coarse counts only, and only if the owner opted in on the vault page."""
    row = await db.get(PwHealth, session.user.id)
    if row is None:
        db.add(PwHealth(user_id=session.user.id, counts=body.model_dump()))
    else:
        row.counts = body.model_dump()
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/health", status_code=status.HTTP_204_NO_CONTENT)
async def delete_health(session: VaultSession = Depends(require_session), db: AsyncSession = Depends(get_db)) -> Response:
    await db.execute(delete(PwHealth).where(PwHealth.user_id == session.user.id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ admin


def _policy_out(row) -> s.PolicyOut:
    return s.PolicyOut(
        enabled=row.enabled,
        preview_badge=row.preview_badge,
        min_kdf_m=row.min_kdf_m,
        min_kdf_t=row.min_kdf_t,
        max_attachment_mb=row.max_attachment_mb,
        breach_check=row.breach_check,
    )


@admin_router.get("/admin/policy", response_model=s.PolicyOut)
async def get_policy(_admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)) -> s.PolicyOut:
    return _policy_out(await policy(db))


@admin_router.patch("/admin/policy", response_model=s.PolicyOut)
async def patch_policy(body: s.PolicyPatch, _admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)) -> s.PolicyOut:
    row = await policy(db)
    for key, value in body.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(row, key, value)
    await db.commit()
    return _policy_out(row)


@admin_router.get("/status")
async def public_status(identity: VaultIdentity = Depends(get_vault_identity), db: AsyncSession = Depends(get_db)) -> dict:
    """For the sidebar and Devices panel in the main app: nothing vault-derived."""
    row = await policy(db)
    has = await db.scalar(select(PwAccount.id).where(PwAccount.user_id == identity.user.id))
    return {"enabled": row.enabled, "preview": row.preview_badge, "has_vault": has is not None}


__all__ = ["router", "admin_router", "PwAttachment"]
