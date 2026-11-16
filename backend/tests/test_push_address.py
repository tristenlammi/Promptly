"""A push address is somewhere the server POSTs to on its own, so it has to
be a real push service on the internet (security review 2026-11): anyone
signed in could otherwise point the server at this machine, the home network
or the deployment's own services."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.notifications.router import _push_address_ok


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/abc",  # not https
        "https://127.0.0.1/push",
        "https://localhost/push",
        "https://10.0.0.5:8123/api/webhook/x",
        "https://192.168.1.10/",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/x",
        "ftp://example.org/x",
        "",
    ],
)
async def test_a_push_address_inside_is_refused(endpoint):
    with pytest.raises(HTTPException) as e:
        await _push_address_ok(endpoint)
    assert e.value.status_code == 400


async def test_a_public_address_and_one_that_goes_nowhere_pass():
    await _push_address_ok("https://93.184.216.34/push/abc")  # a public address
    await _push_address_ok("https://push.invalid/abc")  # resolves nowhere: nothing to reach
