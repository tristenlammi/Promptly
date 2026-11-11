"""Passwords' live channel (app/passwords/live.py): a device is told a vault has
moved on, by id and revision only, so bookmark and item changes reach other
browsers in seconds instead of on their next minute's sync.

The socket is driven straight through ASGI on the test's own loop, and Redis is
an in-memory stand-in, so nothing here reaches a real Redis.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest

from tests.test_passwords import b64, bearer, client, connect_device, make_user, setup_vault, write  # noqa: F401


class FakePubSub:
    def __init__(self, hub: "FakeRedis") -> None:
        self.hub = hub
        self.q: asyncio.Queue = asyncio.Queue()
        self.channels: set[str] = set()

    async def subscribe(self, ch: str) -> None:
        self.channels.add(ch)
        self.hub.subs.append(self)

    async def unsubscribe(self, ch: str) -> None:
        self.channels.discard(ch)

    async def get_message(self, ignore_subscribe_messages: bool = True, timeout: float = 0) -> dict | None:
        try:
            return await asyncio.wait_for(self.q.get(), timeout)
        except asyncio.TimeoutError:
            return None

    async def aclose(self) -> None:
        if self in self.hub.subs:
            self.hub.subs.remove(self)


class FakeRedis:
    def __init__(self) -> None:
        self.subs: list[FakePubSub] = []
        self.published: list[tuple[str, str]] = []

    def pubsub(self) -> FakePubSub:
        return FakePubSub(self)

    async def publish(self, ch: str, data: str) -> int:
        self.published.append((ch, data))
        n = 0
        for s in self.subs:
            if ch in s.channels:
                s.q.put_nowait({"type": "message", "channel": ch, "data": data})
                n += 1
        return n


@pytest.fixture
def fake_redis(monkeypatch):
    import app.redis_client

    fake = FakeRedis()
    monkeypatch.setattr(app.redis_client, "redis", fake)
    return fake


class Socket:
    """One WebSocket connection to the app, over raw ASGI."""

    def __init__(self, path: str = "/api/passwords/live") -> None:
        from app.main import app

        self.inbox: asyncio.Queue = asyncio.Queue()
        self.outbox: asyncio.Queue = asyncio.Queue()
        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0"},
            "scheme": "ws",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": [(b"host", b"test")],
            "client": ("127.0.0.1", 50000),
            "server": ("test", 80),
            "subprotocols": [],
            "state": {},
        }
        self.inbox.put_nowait({"type": "websocket.connect"})
        self.task = asyncio.create_task(app(scope, self.inbox.get, self.outbox.put))

    async def next(self, timeout: float = 5.0) -> dict:
        return await asyncio.wait_for(self.outbox.get(), timeout)

    async def accepted(self) -> None:
        msg = await self.next()
        assert msg["type"] == "websocket.accept", msg

    def send(self, obj: dict) -> None:
        self.inbox.put_nowait({"type": "websocket.receive", "text": json.dumps(obj)})

    async def recv_json(self, timeout: float = 5.0) -> dict:
        msg = await self.next(timeout)
        assert msg["type"] == "websocket.send", msg
        return json.loads(msg["text"])

    async def closed_with(self, timeout: float = 5.0) -> int:
        msg = await self.next(timeout)
        assert msg["type"] == "websocket.close", msg
        return msg.get("code", 1000)

    async def close(self) -> None:
        self.inbox.put_nowait({"type": "websocket.disconnect", "code": 1000})
        try:
            await asyncio.wait_for(self.task, 5)
        except Exception:  # noqa: BLE001
            self.task.cancel()


async def device_session(client, user, vaulted):  # noqa: F811
    d = await connect_device(client, user)
    hd = {"Authorization": f"Bearer {d['token']}"}
    r = await client.post("/api/passwords/session", headers=hd, json={"auth_key": b64(vaulted.auth_key)})
    assert r.status_code == 200, r.text
    return d["token"], r.json()["token"]


def entry(**kw):
    return {"id": str(uuid.uuid4()), "base_revision": 0, "blob": b64(os.urandom(64)), **kw}


async def test_hello_then_a_write_elsewhere_says_pull(client, db, fake_redis):  # noqa: F811
    u = await make_user(db)
    v = await setup_vault(client, u)
    token, session = await device_session(client, u, v)
    ws = Socket()
    await ws.accepted()
    ws.send({"token": token, "session": session})
    hello = await ws.recv_json()
    assert hello["t"] == "hello"
    start = hello["vaults"][v.vault_id]

    # Another device (the web, here) saves something: this one hears the revision, nothing else.
    res = await write(client, v, v.vault_id, [entry()])
    msg = await ws.recv_json()
    assert msg == {"t": "changed", "vault": v.vault_id, "revision": res["revision"]}
    assert res["revision"] > start
    # Never content: only these three keys went to Redis.
    assert all(set(json.loads(d)) == {"t", "vault", "revision"} for _, d in fake_redis.published)
    await ws.close()


async def test_web_token_works_too(client, db, fake_redis):  # noqa: F811
    u = await make_user(db)
    v = await setup_vault(client, u)
    ws = Socket()
    await ws.accepted()
    ws.send({"token": bearer(u)["Authorization"].split(" ", 1)[1], "session": v.session})
    assert (await ws.recv_json())["t"] == "hello"
    await ws.close()


async def test_a_conflict_only_batch_tells_nobody(client, db, fake_redis):  # noqa: F811
    u = await make_user(db)
    v = await setup_vault(client, u)
    e = entry()
    await write(client, v, v.vault_id, [e])
    fake_redis.published.clear()
    # The same item from an old base: nothing applied, so nothing to pull.
    res = await write(client, v, v.vault_id, [{**e, "blob": b64(os.urandom(64))}])
    assert res["conflicts"] and not res["applied"]
    assert fake_redis.published == []


async def test_other_people_arent_told(client, db, fake_redis):  # noqa: F811
    a, b = await make_user(db), await make_user(db)
    va, vb = await setup_vault(client, a), await setup_vault(client, b)
    tok, sess = await device_session(client, b, vb)
    ws = Socket()
    await ws.accepted()
    ws.send({"token": tok, "session": sess})
    hello = await ws.recv_json()
    assert va.vault_id not in hello["vaults"]
    await write(client, va, va.vault_id, [entry()])
    assert [ch for ch, _ in fake_redis.published] == [f"pw:u:{a.id}"]
    with pytest.raises(asyncio.TimeoutError):
        await ws.next(timeout=0.5)
    await ws.close()


@pytest.mark.parametrize("first", [{}, {"token": "pwd_nope", "session": "pws_nope"}, {"token": "x", "session": 3}])
async def test_bad_sign_in_is_closed(client, db, fake_redis, first):  # noqa: F811
    ws = Socket()
    await ws.accepted()
    ws.send(first)
    assert await ws.closed_with() == 4401
    await ws.close()


async def test_locked_vault_is_closed(client, db, fake_redis):  # noqa: F811
    u = await make_user(db)
    v = await setup_vault(client, u)
    token, session = await device_session(client, u, v)
    r = await client.delete("/api/passwords/session", headers={"Authorization": f"Bearer {token}", "X-Vault-Session": session})
    assert r.status_code == 204
    ws = Socket()
    await ws.accepted()
    ws.send({"token": token, "session": session})
    assert await ws.closed_with() == 4401
    await ws.close()


async def test_session_recheck_closes_a_revoked_one(client, db, fake_redis, monkeypatch):  # noqa: F811
    from app.passwords import live

    monkeypatch.setattr(live, "PING_SECONDS", 0.05)
    monkeypatch.setattr(live, "RECHECK_SECONDS", 0.0)
    u = await make_user(db)
    v = await setup_vault(client, u)
    token, session = await device_session(client, u, v)
    ws = Socket()
    await ws.accepted()
    ws.send({"token": token, "session": session})
    assert (await ws.recv_json())["t"] == "hello"
    # Locked elsewhere: the next check ends the socket.
    await client.delete("/api/passwords/session", headers={"Authorization": f"Bearer {token}", "X-Vault-Session": session})
    while True:
        msg = await ws.next()
        if msg["type"] == "websocket.close":
            assert msg["code"] == 4401
            break
        assert json.loads(msg["text"])["t"] == "ping"
    await ws.close()


async def test_silence_at_sign_in_is_closed(client, db, fake_redis, monkeypatch):  # noqa: F811
    from app.passwords import live

    monkeypatch.setattr(live, "SIGN_IN_SECONDS", 0.1)
    ws = Socket()
    await ws.accepted()
    assert await ws.closed_with() == 4401
    await ws.close()
