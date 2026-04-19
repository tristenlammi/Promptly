"""SSRF-safe HTTP client (Phase 3.3).

The chat layer issues outbound HTTP requests on behalf of the user
(search providers configured by the admin, future tool-calling, etc.).
A poorly-checked URL is the canonical way an attacker pivots from the
public app to the internal network — pointing the search provider at
``http://169.254.169.254/latest/meta-data/`` to scrape AWS instance
credentials, ``http://localhost:6379`` to probe Redis, and so on.

``safe_fetch`` is a thin ``httpx`` wrapper that refuses to send a
request when *any* of the following are true:

1. URL scheme isn't ``http`` or ``https``.
2. Hostname resolves to a private / loopback / link-local / multicast /
   reserved IP — for both IPv4 and IPv6, against *every* address the
   resolver returns (so a hostile DNS that returns one public + one
   private answer still loses).
3. The hostname is on a hardcoded refusal list (``localhost``,
   ``ip6-localhost``, etc.) — belts-and-braces in case someone bypasses
   the resolver with ``/etc/hosts`` shenanigans.

On the wire we additionally enforce:

* A short connect + read timeout (default 5s) so an attacker can't
  use the search provider as a slowloris pump against our workers.
* A capped response body (default 10 MiB) — we read in chunks and
  drop the connection the moment we cross the limit.

There's an inherent TOCTOU window between our DNS lookup and the
socket the HTTP client opens (it re-resolves). Closing it would
require pinning an explicit IP into the request, which breaks HTTPS
SNI / certificate validation. We accept the residual risk because:

* Our threat model treats outbound URLs as *admin-controlled* (search
  provider endpoints), not arbitrary user input — the check primarily
  prevents misconfig and "what if Brave starts redirecting somewhere
  weird".
* Every redirect target is re-validated, which closes the obvious
  amplification (302 me to ``http://10.0.0.1``).
* We still enforce small body cap + short timeout, so even a
  successful TOCTOU doesn't yield interesting data exfil.
"""
from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import get_settings

logger = logging.getLogger("promptly.net.safe_fetch")

# Sensible defaults shared across every call site. Override per-call
# when you actually need to.
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_MAX_BYTES = 10 * 1024 * 1024  # 10 MiB

# Hostnames we always refuse, regardless of what they resolve to.
# Avoids the case where DNS resolution is somehow bypassed (e.g. an
# entry in /etc/hosts on a hardened deployment that maps "internal"
# to a public-looking IP we'd normally allow).
_NEVER_HOSTNAMES = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "ip6-localhost",
        "ip6-loopback",
        "broadcasthost",
        # AWS / GCP / Azure metadata service hostnames. They're not
        # routable from the public internet, but a misconfigured DNS
        # resolver could return a valid private IP for them, so we
        # belt-and-braces the names too.
        "metadata.google.internal",
        "metadata.goog",
    }
)

_ALLOWED_SCHEMES = frozenset({"http", "https"})


class UnsafeURLError(ValueError):
    """Raised when ``safe_fetch`` refuses a URL.

    Carries a short ``reason`` code so callers can audit what
    happened without exposing the raw URL or resolved IP to end
    users (both can be sensitive).
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class ResponseTooLargeError(ValueError):
    """Raised when a response exceeds the configured byte cap."""


# --------------------------------------------------------------------
# Address validation
# --------------------------------------------------------------------
def _ip_is_blocked(ip: ipaddress._BaseAddress) -> tuple[bool, str]:
    """Return ``(blocked, reason_label)`` for one IP address.

    Reason is a short code suitable for the audit log. The full RFC
    list we cover:

    * Private (RFC 1918, RFC 4193) — 10/8, 172.16/12, 192.168/16,
      fc00::/7.
    * Loopback (127/8, ::1).
    * Link-local (169.254/16, fe80::/10).
    * Multicast (224.0.0.0/4, ff00::/8).
    * Reserved / unspecified (0.0.0.0/8, ::/128, 240.0.0.0/4, etc.).
    * IPv4-mapped IPv6 (``::ffff:0.0.0.0/96``) — re-checked as IPv4.
    """
    # IPv4-mapped IPv6 → unwrap and re-check, otherwise an attacker
    # could bypass the IPv4 ban by submitting ``::ffff:127.0.0.1``.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return _ip_is_blocked(ip.ipv4_mapped)

    if ip.is_unspecified:
        return True, "unspecified"
    if ip.is_loopback:
        return True, "loopback"
    if ip.is_link_local:
        return True, "link_local"
    if ip.is_multicast:
        return True, "multicast"
    if ip.is_reserved:
        return True, "reserved"
    if ip.is_private:
        return True, "private"
    # ``ipaddress`` doesn't classify ``169.254.169.254`` as link-local
    # in all stdlib versions even though IANA does — belt-and-braces.
    if isinstance(ip, ipaddress.IPv4Address):
        if int(ip) >> 16 == (169 << 8) | 254:
            return True, "link_local"

    return False, "ok"


def _resolve_all(hostname: str) -> list[ipaddress._BaseAddress]:
    """Return every IP the OS resolver gives us for ``hostname``.

    We refuse the request if *any* answer is unsafe — a malicious
    record returning ``[8.8.8.8, 127.0.0.1]`` doesn't get to slip
    the loopback past us just because the public address is listed
    first.
    """
    try:
        # ``getaddrinfo`` covers both IPv4 + IPv6 in one call. We
        # don't pass a port because we just want the addresses.
        infos = socket.getaddrinfo(
            hostname,
            None,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as e:
        raise UnsafeURLError(
            "dns_failure",
            f"DNS lookup failed for {hostname!r}",
        ) from e

    out: list[ipaddress._BaseAddress] = []
    for info in infos:
        sockaddr = info[4]
        # IPv4 sockaddr is (host, port); IPv6 is (host, port, flowinfo, scopeid).
        host = sockaddr[0]
        try:
            out.append(ipaddress.ip_address(host))
        except ValueError:
            # Something the resolver gave us isn't a valid IP literal.
            # Skip it — we'd rather have one less candidate than 500.
            continue
    return out


def assert_url_is_safe(url: str) -> str:
    """Return the validated URL, raise ``UnsafeURLError`` if not safe.

    Public API for callers that want to do the validation up front
    without actually fetching (e.g. webhook configuration).

    Hostnames listed in ``Settings.SSRF_ALLOWED_HOSTS`` skip the
    private-IP check — the docker-compose ``searxng`` service is the
    canonical example, since it has to resolve to an internal IP for
    the OOB experience to work.
    """
    parsed = urlparse(url)
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        raise UnsafeURLError(
            "bad_scheme",
            f"Only http(s) URLs are allowed (got {parsed.scheme!r})",
        )

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        raise UnsafeURLError("bad_url", "URL has no hostname")

    if hostname in _NEVER_HOSTNAMES:
        # ``_NEVER_HOSTNAMES`` wins even if the operator allowlists
        # the same name — refusing ``localhost`` is non-negotiable.
        raise UnsafeURLError(
            "blocked_hostname",
            f"Refusing to fetch {hostname!r}",
        )

    explicit_allow = hostname in get_settings().ssrf_allowed_hosts_set

    # If the hostname is itself an IP literal, validate directly —
    # don't round-trip through DNS, that's pointless and slow.
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None

    if literal is not None:
        if explicit_allow:
            return url
        blocked, reason = _ip_is_blocked(literal)
        if blocked:
            raise UnsafeURLError(
                f"blocked_ip:{reason}",
                f"Refusing to fetch {hostname!r} ({reason})",
            )
        return url

    addresses = _resolve_all(hostname)
    if not addresses:
        raise UnsafeURLError(
            "dns_failure",
            f"No IP addresses returned for {hostname!r}",
        )

    if explicit_allow:
        # Allowlisted name — we still ran DNS so that a typo or
        # broken resolver fails loudly, but we skip the private-IP
        # check on purpose.
        return url

    for ip in addresses:
        blocked, reason = _ip_is_blocked(ip)
        if blocked:
            raise UnsafeURLError(
                f"blocked_ip:{reason}",
                f"Refusing to fetch {hostname!r} — resolves to a {reason} address",
            )
    return url


# --------------------------------------------------------------------
# HTTP wrapper
# --------------------------------------------------------------------
async def safe_fetch(
    method: str,
    url: str,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = DEFAULT_MAX_BYTES,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    json: Any = None,
    client: httpx.AsyncClient | None = None,
    follow_redirects: bool = True,
) -> httpx.Response:
    """Issue an SSRF-safe HTTP request.

    Behaves like ``httpx.AsyncClient.request`` but:

    * Validates the URL against the SSRF allowlist before opening a
      socket. **Also re-validates the redirect target on every hop**
      so a public URL can't 302 us to ``http://127.0.0.1:6379``.
    * Caps ``timeout_seconds`` for the whole request lifecycle.
    * Caps the response body to ``max_bytes`` — we stream and bail
      mid-read rather than buffering the whole thing first.

    Pass an existing ``client`` if you need connection pooling across
    multiple requests; otherwise we open a one-shot client per call.
    """
    method = method.upper()
    current_url = url
    assert_url_is_safe(current_url)

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(
            timeout=timeout_seconds,
            # We drive the redirect loop ourselves so we can re-run
            # the SSRF guard on every hop.
            follow_redirects=False,
        )

    assert client is not None  # appeases mypy after the conditional create

    try:
        body_kwargs: dict[str, Any] = {}
        if json is not None:
            body_kwargs["json"] = json

        # Manual redirect loop. Bound at 5 hops to match httpx's
        # default and stop a redirect chain from amplifying a
        # slow-loris attack.
        response: httpx.Response | None = None
        for hop in range(6):
            request = client.build_request(
                method,
                current_url,
                headers=headers,
                params=params if hop == 0 else None,
                **body_kwargs,
            )
            response = await client.send(request, stream=True)
            if not (
                follow_redirects
                and response.is_redirect
                and "location" in response.headers
            ):
                break
            location = response.headers["location"]
            # Resolve relative redirects against the URL we just
            # fetched, so ``/login`` after ``https://x.com/page``
            # becomes ``https://x.com/login``.
            next_url = str(httpx.URL(current_url).join(location))
            await response.aclose()
            response = None
            assert_url_is_safe(next_url)
            current_url = next_url
            # On a redirect the body is not re-sent — drop ``json``.
            body_kwargs.clear()
        else:
            # We exhausted the hop budget without breaking out (the
            # else-on-for fires when the loop didn't ``break``).
            if response is not None:
                await response.aclose()
            raise UnsafeURLError(
                "redirect_loop",
                f"Refusing to follow more than 5 redirects from {url!r}",
            )

        assert response is not None

        # Stream the body in chunks, enforcing ``max_bytes``. We
        # must close the streaming response after we're done so the
        # connection is released back to the pool.
        try:
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ResponseTooLargeError(
                        f"Response from {url!r} exceeds {max_bytes} bytes"
                    )
                chunks.append(chunk)
            # Hand the buffered body back to httpx so callers can use
            # ``.json()`` / ``.text`` exactly as they would with a
            # vanilla ``httpx`` response.
            response._content = b"".join(chunks)  # type: ignore[attr-defined]
        finally:
            await response.aclose()

        return response

    finally:
        if own_client:
            await client.aclose()


__all__ = [
    "DEFAULT_MAX_BYTES",
    "DEFAULT_TIMEOUT_SECONDS",
    "ResponseTooLargeError",
    "UnsafeURLError",
    "assert_url_is_safe",
    "safe_fetch",
]
