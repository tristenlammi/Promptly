"""Every route that answers without a signed-in person is listed here.

A route with no ``get_current_user`` (or ``require_admin``) anywhere in its
dependencies can be called by anyone on the internet. Each one below was read
and has its own proof (a signed link, a device's own key, a box's key, a
login form) or shows nothing private. A new one fails this test until
someone adds it here with what guards it, on purpose.
"""
from __future__ import annotations

from fastapi.routing import APIRoute, APIWebSocketRoute

AUTH = {
    "get_current_user",
    "require_admin",
    # A phone's app password (its scope checked), or the web session.
    "maps_user",
    "_maps_user",
    "assistant_user",
    "widget_user",
    "phone_user",
    # The vault's own sign-in.
    "get_vault_identity",
    "get_vault_user",
    # Half-way through signing in: the token from the password step.
    "get_user_from_enrollment_token",
    "get_user_from_challenge_token",
}

# "METHOD /path" -> what guards it.
PUBLIC: dict[str, str] = {
    "ANY /dav": "WebDAV (every verb): HTTP Basic with a device's app password, checked in the handler",
    "ANY /dav/{path:path}": "WebDAV (every verb): HTTP Basic with a device's app password, checked in the handler",
    "GET /api/auth/avatar/{user_id}": "profile pictures: nothing private",
    "POST /api/auth/forgot-password": "signing in and out: rate-limited; credentials or a reset token",
    "POST /api/auth/login": "signing in and out: rate-limited; credentials or a reset token",
    "POST /api/auth/logout": "signing in and out: rate-limited; credentials or a reset token",
    "GET /api/auth/oidc/callback": "single sign-on hand-off: state and the provider's code",
    "GET /api/auth/oidc/login": "single sign-on hand-off: state and the provider's code",
    "POST /api/auth/oidc/pending": "single sign-on hand-off: state and the provider's code",
    "GET /api/auth/password-policy": "what the sign-in page needs before anyone is signed in",
    "POST /api/auth/refresh": "signing in and out: rate-limited; credentials or a reset token",
    "POST /api/auth/register": "signing in and out: rate-limited; credentials or a reset token",
    "POST /api/auth/reset-password": "signing in and out: rate-limited; credentials or a reset token",
    "POST /api/auth/setup": "signing in and out: rate-limited; credentials or a reset token",
    "GET /api/auth/setup-status": "what the sign-in page needs before anyone is signed in",
    "GET /api/auth/sso-status": "what the sign-in page needs before anyone is signed in",
    "GET /api/calendar/answer/{token}": "an invitation's own signed link",
    "POST /api/calendar/answer/{token}": "an invitation's own signed link",
    "GET /api/calendar/feed/{token}.ics": "a calendar feed's secret token",
    "POST /api/calls/answer": "the ringing push's signed answer token",
    "POST /api/calls/answer/decline": "the ringing push's signed answer token",
    "POST /api/calls/answer/state": "the ringing push's signed answer token",
    "POST /api/calls/callback": "a missed call's signed token: one person, one conversation, a day (reviewed 2026-11)",
    "POST /api/calls/session/leave": "a call session's own secret, from the app's service",
    "POST /api/calls/session/refresh": "a call session's own secret, from the app's service",
    "POST /api/calls/webhook": "LiveKit's signed webhook",
    "GET /api/chat/_ping": "says only that the service is up",
    "POST /api/devices/have": "pairing a phone: the one-time code from the QR",
    "POST /api/devices/pair/claim": "pairing a phone: the one-time code from the QR",
    "GET /api/documents/{document_id}/assets/{asset_id}": "a signed asset link (checked in the handler)",
    "GET /api/f/{token}": "a public form: the link's token is the pass",
    "GET /api/f/{token}/asset/{asset_id:uuid}": "a public form: the link's token is the pass",
    "GET /api/f/{token}/ics": "a public form: the link's token is the pass",
    "GET /api/f/{token}/mine": "a public form: the link's token is the pass",
    "PUT /api/f/{token}/mine": "a public form: the link's token is the pass",
    "GET /api/f/{token}/places": "a public form: the link's token is the pass",
    "POST /api/f/{token}/report": "a public form: the link's token is the pass",
    "GET /api/f/{token}/result": "a public form: the link's token is the pass",
    "POST /api/f/{token}/submit": "a public form: the link's token is the pass",
    "POST /api/f/{token}/uploads": "a public form: the link's token is the pass",
    "DELETE /api/f/{token}/uploads/{upload_id:uuid}": "a public form: the link's token is the pass",
    "GET /api/forms/{file_id:uuid}/assets/{asset_id:uuid}": "a signed asset link (checked in the handler)",
    "GET /api/health": "health checks: no data",
    "GET /api/health/live": "health checks: no data",
    "WS /api/home/box/ws": "a home box: its own key, or this server's HOME_BOX_SECRET (reviewed 2026-11)",
    "POST /api/hooks/{task_id}/{secret}": "an automation's webhook: its secret is in the address",
    "POST /api/internal/documents/{document_id}/snapshot": "service to service inside the deployment: a shared secret, checked in the handler",
    "POST /api/rooms/camera/send": "a camera ticket, signed: one person, one conversation, photos and videos only, 6 hours and 40 sends; membership checked on each (rooms/camera.py)",
    "POST /api/internal/tus-hook": "service to service inside the deployment: a shared secret, checked in the handler",
    "GET /api/items/app-manifest/{file_id}.webmanifest": "an installed app's manifest: names and icons only",
    "GET /api/items/app/{kind}/manifest.webmanifest": "an installed app's manifest: names and icons only",
    "POST /api/items/k/budget/hook/{file_id}": "the bank's webhook: its signature",
    "GET /api/m/{token}": "a signed, short-lived media link",
    "POST /api/maps/phone-location/fix": "the app's per-install key; takes a position only while its own page is asking (reviewed 2026-11)",
    "POST /api/notifications/action": "a notification button's signed token: one person, one action, one target, a week (reviewed 2026-11)",
    "POST /api/notifications/native": "the phone's app password (scope upload), checked in the handler (reviewed 2026-11)",
    "POST /api/notifications/native/gone": "the phone's app password (scope upload), checked in the handler (reviewed 2026-11)",
    "GET /api/notifications/public-key": "the push public key: public by nature",
    "POST /api/passwords/connect/poll": "the vault's device pairing: its own codes",
    "POST /api/passwords/connect/start": "the vault's device pairing: its own codes",
    "POST /api/passwords/devices/register": "the vault's device pairing: its own codes",
    "WS /api/passwords/live": "the vault's live channel: its token arrives in the first message",
    "GET /api/passwords/public/sends/{send_id}": "a Send link: its id and key",
    "POST /api/passwords/public/sends/{send_id}/open": "a Send link: its id and key",
    "GET /api/rooms/attachments/{att_id}": "a signed Rooms file link (reviewed 2026-11)",
    "GET /api/rooms/emojis/{emoji_id}/file": "a signed Rooms media link (reviewed 2026-11)",
    "GET /api/rooms/previews/{message_id}/image": "a signed Rooms media link (reviewed 2026-11)",
    "GET /api/rooms/saved-gifs/{saved_id}/file": "a signed Rooms media link (reviewed 2026-11)",
    "POST /api/rooms/voice/refresh": "a voice-channel session's own secret, from the app's service",
    "POST /api/rooms/voice/session/leave": "a voice-channel session's own secret, from the app's service",
    "POST /api/rooms/voice/session/speaking": "a voice-channel session's own secret, from the app's service",
    "POST /api/rooms/voice/session/state": "a voice-channel session's own secret, from the app's service",
    "POST /api/rooms/voice/session/still-here": "a voice-channel session's own secret, from the app's service",
    "GET /api/s/{token}/album": "a public album link: the token (and its password, if set)",
    "GET /api/s/{token}/album/zip": "a public album link: the token (and its password, if set)",
    "GET /api/s/{token}/album/{file_id}/{rendition}": "a public album link: the token (and its password, if set)",
    "GET /api/s/{token}/browse": "a share link: the token (and its password, if set)",
    "GET /api/s/{token}/download": "a share link: the token (and its password, if set)",
    "GET /api/s/{token}/file/{file_id}/download": "a share link: the token (and its password, if set)",
    "GET /api/s/{token}/file/{file_id}/office": "a share link: the token (and its password, if set)",
    "GET /api/s/{token}/meta": "a share link: the token (and its password, if set)",
    "GET /api/s/{token}/office": "a share link: the token (and its password, if set)",
    "POST /api/s/{token}/unlock": "a share link: the token (and its password, if set)",
    "GET /api/search/_ping": "says only that the service is up",
    "WS /api/talk/ws": "Talk's socket: the session token arrives in the first message",
    "GET /api/workspaces/my-shifts.ics": "a roster feed's secret token",
    "GET /api/workspaces/{workspace_id}/export/download": "a signed export link",
}


def _deps(dependant, seen: set[str] | None = None) -> set[str]:
    seen = seen if seen is not None else set()
    for d in dependant.dependencies:
        if d.call is not None:
            seen.add(getattr(d.call, "__name__", repr(d.call)))
        _deps(d, seen)
    return seen


def unauthenticated() -> dict[str, str]:
    from app.main import app

    out: dict[str, str] = {}
    for r in app.routes:
        if not isinstance(r, (APIRoute, APIWebSocketRoute)):
            continue
        names = _deps(r.dependant)
        if names & AUTH:
            continue
        methods = sorted(getattr(r, "methods", None) or {"WS"})
        for m in methods:
            if m in ("HEAD", "OPTIONS"):
                continue
            guards = sorted(n for n in names if n not in ("get_db", "blanket_rate_limit", "_dep"))
            # WebDAV answers a dozen verbs on the same two paths: one entry each.
            key = f"ANY {r.path}" if r.path.startswith("/dav") else f"{m} {r.path}"
            out[key] = f"{r.endpoint.__module__}.{r.endpoint.__name__} deps={guards}"
    return out


def test_every_public_route_is_listed_on_purpose():
    found = unauthenticated()
    new = sorted(set(found) - set(PUBLIC))
    gone = sorted(set(PUBLIC) - set(found))
    assert not new, "Routes that answer without sign-in and aren't in PUBLIC (add each with what guards it):\n" + "\n".join(
        f"  {k}  <- {found[k]}" for k in new
    )
    assert not gone, "Listed in PUBLIC but no longer public (remove them):\n" + "\n".join(f"  {k}" for k in gone)
