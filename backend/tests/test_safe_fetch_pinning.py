"""DNS rebinding (security review M2): ``safe_fetch`` connects to the address
it checked, not to a second DNS answer, and keeps the hostname for Host,
SNI and the certificate. Redirects are checked and pinned per hop."""
from __future__ import annotations

import ipaddress

import httpx
import pytest

from app.net import safe_fetch as sf

PUBLIC = "93.184.216.34"


def _rebinding_dns(monkeypatch, answers: dict[str, list[str]]):
    """First answer per host is checked; any later lookup says loopback, the
    way a rebinding server would."""
    asked: dict[str, int] = {}

    def resolve(host):
        asked[host] = asked.get(host, 0) + 1
        if asked[host] > 1:
            return [ipaddress.ip_address("127.0.0.1")]
        return [ipaddress.ip_address(a) for a in answers[host]]

    monkeypatch.setattr(sf, "_resolve_all", resolve)
    return asked


@pytest.fixture
def wire(monkeypatch):
    """What actually goes out on the wire (the transport below the pin)."""
    sent: list[httpx.Request] = []
    replies: list[httpx.Response] = []

    async def handle(self, request):
        sent.append(request)
        return replies.pop(0) if replies else httpx.Response(200, text="hello")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle)
    return sent, replies


async def test_the_request_goes_to_the_checked_address(monkeypatch, wire):
    sent, _ = wire
    _rebinding_dns(monkeypatch, {"news.example.com": [PUBLIC]})
    r = await sf.safe_fetch("GET", "https://news.example.com/story?x=1")
    assert r.text == "hello"
    [req] = sent
    assert req.url.host == PUBLIC and req.url.path == "/story" and req.url.query == b"x=1"
    assert req.headers["host"] == "news.example.com"
    assert req.extensions["sni_hostname"] == "news.example.com"
    # The caller still sees the real address.
    assert str(r.url) == "https://news.example.com/story?x=1"


async def test_plain_http_keeps_the_host_header(monkeypatch, wire):
    sent, _ = wire
    _rebinding_dns(monkeypatch, {"site.example.org": [PUBLIC]})
    await sf.safe_fetch("GET", "http://site.example.org:8080/a")
    assert sent[0].url.host == PUBLIC and sent[0].url.port == 8080
    assert sent[0].headers["host"] == "site.example.org:8080"
    assert "sni_hostname" not in sent[0].extensions


async def test_ipv4_is_preferred(monkeypatch, wire):
    sent, _ = wire
    _rebinding_dns(monkeypatch, {"dual.example.com": ["2606:2800:220:1:248:1893:25c8:1946", PUBLIC]})
    await sf.safe_fetch("GET", "https://dual.example.com/")
    assert sent[0].url.host == PUBLIC


async def test_each_redirect_is_checked_and_pinned(monkeypatch, wire):
    sent, replies = wire
    _rebinding_dns(monkeypatch, {"a.example.com": [PUBLIC], "b.example.net": ["198.51.100.7"]})
    # 198.51.100.0/24 is documentation space: not global, so refused.
    replies.append(httpx.Response(302, headers={"location": "https://b.example.net/x"}))
    with pytest.raises(sf.UnsafeURLError):
        await sf.safe_fetch("GET", "https://a.example.com/")
    assert len(sent) == 1


async def test_a_redirect_to_a_public_host_is_pinned_too(monkeypatch, wire):
    sent, replies = wire
    _rebinding_dns(monkeypatch, {"a.example.com": [PUBLIC], "b.example.net": ["8.8.8.8"]})
    replies.append(httpx.Response(302, headers={"location": "https://b.example.net/x"}))
    r = await sf.safe_fetch("GET", "https://a.example.com/")
    assert [q.url.host for q in sent] == [PUBLIC, "8.8.8.8"]
    assert sent[1].extensions["sni_hostname"] == "b.example.net"
    assert str(r.url) == "https://b.example.net/x"


async def test_a_private_answer_is_still_refused(monkeypatch, wire):
    sent, _ = wire
    _rebinding_dns(monkeypatch, {"evil.example.com": ["10.0.0.5"]})
    with pytest.raises(sf.UnsafeURLError):
        await sf.safe_fetch("GET", "https://evil.example.com/")
    assert sent == []
