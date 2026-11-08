"""LiveKit access tokens. The token is the enforcement at the media layer:
one room, one identity, exactly the sources the person may publish.
"""
from __future__ import annotations

from datetime import timedelta

from livekit import api

from app.rtc import config

# LiveKit refreshes a connected client's token itself, so a short life only
# limits how long a leaked join URL is any good.
DEFAULT_TTL = timedelta(minutes=10)

MICROPHONE = "microphone"
CAMERA = "camera"
SCREEN = "screen_share"
SCREEN_AUDIO = "screen_share_audio"


class NotConfigured(RuntimeError):
    """No LiveKit key pair (calls aren't set up)."""


def mint(
    *,
    identity: str,
    room: str,
    name: str | None = None,
    sources: list[str] | None = None,
    can_subscribe: bool = True,
    can_publish_data: bool = True,
    metadata: str | None = None,
    ttl: timedelta = DEFAULT_TTL,
) -> str:
    """A token to join ``room`` as ``identity``. ``sources`` lists what may
    be published (empty or None: listen only)."""
    pair = config.keys()
    if pair is None:
        raise NotConfigured("calls aren't set up")
    sources = list(sources or [])
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=bool(sources),
        can_publish_sources=sources or None,
        can_subscribe=can_subscribe,
        can_publish_data=can_publish_data,
    )
    tok = api.AccessToken(*pair).with_identity(identity).with_grants(grants).with_ttl(ttl)
    if name:
        tok = tok.with_name(name)
    if metadata:
        tok = tok.with_metadata(metadata)
    return tok.to_jwt()


def decode(token: str) -> dict:
    """The claims of a token we minted (signature checked). For tests and
    for the Android voice session refresh."""
    pair = config.keys()
    if pair is None:
        raise NotConfigured("calls aren't set up")
    claims = api.TokenVerifier(*pair).verify(token)
    return {
        "identity": claims.identity,
        "name": claims.name,
        "room": claims.video.room if claims.video else None,
        "can_publish": claims.video.can_publish if claims.video else None,
        "sources": list(claims.video.can_publish_sources or []) if claims.video else [],
        "can_subscribe": claims.video.can_subscribe if claims.video else None,
    }
