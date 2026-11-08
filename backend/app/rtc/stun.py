"""This server's public address, found the way LiveKit finds its own: a STUN
binding request (RFC 5389) to a public STUN server.

Used by the Admin > Calls checklist ("Your internet address") and the
hourly check that notices the home's address changing. On Linux the
backend sits behind the same router as LiveKit, so both see the same
address; under CGNAT two servers may report different ports or the
address may be in 100.64.0.0/10.
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
import struct

# Same defaults LiveKit uses (rtcconfig), plus Google's as a second opinion.
SERVERS = [("global.stun.twilio.com", 3478), ("stun.l.google.com", 19302)]
_MAGIC = 0x2112A442


def _request() -> tuple[bytes, bytes]:
    txid = os.urandom(12)
    return struct.pack("!HHI", 0x0001, 0, _MAGIC) + txid, txid


def parse_response(data: bytes, txid: bytes) -> tuple[str, int] | None:
    """The mapped (address, port) from a Binding success response."""
    if len(data) < 20:
        return None
    mtype, length, magic = struct.unpack("!HHI", data[:8])
    if mtype != 0x0101 or magic != _MAGIC or data[8:20] != txid:
        return None
    pos, end = 20, min(len(data), 20 + length)
    mapped = None
    while pos + 4 <= end:
        atype, alen = struct.unpack("!HH", data[pos:pos + 4])
        val = data[pos + 4:pos + 4 + alen]
        if atype in (0x0020, 0x8020) and len(val) >= 8 and val[1] == 0x01:  # XOR-MAPPED-ADDRESS, IPv4
            port = struct.unpack("!H", val[2:4])[0] ^ (_MAGIC >> 16)
            addr = struct.unpack("!I", val[4:8])[0] ^ _MAGIC
            return str(ipaddress.IPv4Address(addr)), port
        if atype == 0x0001 and len(val) >= 8 and val[1] == 0x01:  # MAPPED-ADDRESS, IPv4
            mapped = (str(ipaddress.IPv4Address(val[4:8])), struct.unpack("!H", val[2:4])[0])
        pos += 4 + alen + ((4 - alen % 4) % 4)
    return mapped


class _Proto(asyncio.DatagramProtocol):
    def __init__(self, txid: bytes):
        self.txid = txid
        self.fut: asyncio.Future = asyncio.get_running_loop().create_future()

    def datagram_received(self, data, addr):
        got = parse_response(data, self.txid)
        if got and not self.fut.done():
            self.fut.set_result(got)

    def error_received(self, exc):
        if not self.fut.done():
            self.fut.set_exception(exc)


async def query(host: str, port: int, timeout: float = 2.5) -> tuple[str, int] | None:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_DGRAM)
    except OSError:
        return None
    if not infos:
        return None
    msg, txid = _request()
    transport = None
    try:
        transport, proto = await loop.create_datagram_endpoint(lambda: _Proto(txid), remote_addr=infos[0][4])
        for _ in range(3):
            transport.sendto(msg)
            try:
                return await asyncio.wait_for(asyncio.shield(proto.fut), timeout / 3)
            except asyncio.TimeoutError:
                continue
        return None
    except OSError:
        return None
    finally:
        if transport is not None:
            transport.close()


async def public_addresses() -> list[tuple[str, int]]:
    """What each STUN server saw (unanswered ones left out)."""
    got = await asyncio.gather(*(query(h, p) for h, p in SERVERS))
    return [g for g in got if g]


def is_cgnat(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network("100.64.0.0/10")
    except ValueError:
        return False


def is_private(ip: str) -> bool:
    """Private, CGNAT, loopback or link-local: not an internet address."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return a.is_private or a.is_loopback or a.is_link_local or is_cgnat(ip)
