"""Network safety helpers shared by every outbound HTTP code path.

Right now this is just ``safe_fetch``, the SSRF guard that wraps
``httpx`` calls whose target URL is influenced by user input (search
provider URLs, user-configured webhooks, etc.). The package exists
so future helpers (DNS pinning, allowlist-based egress, etc.) have a
single home that's obviously about *outbound* network safety.
"""
from __future__ import annotations
