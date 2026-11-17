"""Music by name: "play Miles Davis in the lounge".

A home's box can run a music service next to Home Assistant (Music Assistant,
as out of sight as Home Assistant is). The home's owner links a streaming
service to it (Tidal, on Tidal's own site: Promptly never sees a password),
and the box plays what's asked for on a speaker the home already has.

The box does the work (``music.*`` in ``relay.py``); this module is the
server's side: what a box's answers may contain, and choosing what to play.

Choosing never guesses. One search result is played only when it is plainly
the thing asked for; otherwise the person is asked which one they meant.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from . import quick

KINDS = ("artist", "album", "track", "playlist", "radio")
# What a search looks through when the person didn't say which.
DEFAULT_KINDS = ("artist", "album", "track", "playlist")
# Where each service's "link your account" page lives. A box is someone's
# computer: a link to anywhere else is never shown.
LINK_HOSTS: dict[str, tuple[str, ...]] = {"tidal": ("link.tidal.com",)}
_URI = re.compile(r"^[a-z0-9_]{1,40}(?:--[A-Za-z0-9]{1,24})?://(artist|album|track|playlist|radio)/[^\s?#]{1,200}$")
_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$")
NOT_LINKED = "No music service is linked to this home yet. The home's owner can link Tidal on the Home page: settings, then Music."
MAX_OPTIONS = 6


def _text(v: Any, limit: int) -> str:
    return v.strip()[:limit] if isinstance(v, str) else ""


def clean_results(raw: Any) -> list[dict[str, str]]:
    """A box's search answer: only the fields we know, at sizes we choose."""
    out: list[dict[str, str]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        uri, name = _text(item.get("uri"), 260), _text(item.get("name"), 120)
        m = _URI.match(uri)
        if not m or not name or item.get("kind") != m.group(1):
            continue
        one = {"uri": uri, "kind": m.group(1), "name": name}
        for key, limit in (("artist", 120), ("album", 120), ("by", 80), ("version", 60)):
            if _text(item.get(key), limit):
                one[key] = _text(item.get(key), limit)
        out.append(one)
        if len(out) >= 40:
            break
    return out


def clean_status(raw: Any) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}

    def rows(key: str, fields: tuple[str, ...]) -> list[dict[str, str]]:
        out = []
        for r in raw.get(key) if isinstance(raw.get(key), list) else []:
            if isinstance(r, dict) and all(_text(r.get(f), 80) for f in fields) and _ID.match(_text(r.get("id"), 80)):
                out.append({f: _text(r[f], 80) for f in fields})
        return out[:12]

    speakers = [s for s in raw.get("speakers") if isinstance(s, str)][:200] if isinstance(raw.get("speakers"), list) else []
    return {"brands": rows("brands", ("id", "name")), "sources": rows("sources", ("id", "brand", "name")), "speakers": speakers}


def clean_link(raw: Any, brand: str) -> dict[str, Any]:
    """One step of linking an account. The link is only ever the service's
    own page (``LINK_HOSTS``)."""
    raw = raw if isinstance(raw, dict) else {}
    state = raw.get("state")
    name = _text(raw.get("name"), 40) or brand.capitalize()
    if state == "done":
        return {"state": "done", "brand": brand, "name": name}
    flow = _text(raw.get("flow"), 80)
    if state == "wait" and _ID.match(flow):
        return {"state": "wait", "brand": brand, "name": name, "flow": flow}
    if state == "open" and _ID.match(flow):
        url = _text(raw.get("url"), 300)
        parts = urlsplit(url)
        if parts.scheme == "https" and parts.hostname in LINK_HOSTS.get(brand, ()) and not parts.username and parts.port in (None, 443):
            out: dict[str, Any] = {"state": "open", "brand": brand, "name": name, "flow": flow, "url": url, "site": parts.hostname}
            code = _text(raw.get("code"), 12)
            if re.fullmatch(r"[A-Za-z0-9-]{4,12}", code):
                out["code"] = code
            until = raw.get("until")
            if isinstance(until, (int, float)) and not isinstance(until, bool) and 0 < until < 4_000_000_000:
                out["until"] = int(until)
            return out
    return {"state": "stopped", "brand": brand, "text": _text(raw.get("text"), 200) or f"{name} couldn't be linked. Start again."}


# ------------------------------------------------------------------ choosing


_LEADS = ("some ", "song ", "album ", "playlist ", "artist ", "track ")
_BY = ("songs by ", "music by ", "something by ", "anything by ", "some ")


def _wanted(query: str) -> list[tuple[str, str]]:
    """The ways to read what was asked for, most literal first, each as
    ``(what, by whom)``: "blue in green by miles davis" is the song and the
    artist; "the album kind of blue" is "kind of blue"; "something by miles
    davis" is Miles Davis himself."""
    q = quick.key(query)
    out: list[tuple[str, str]] = [(q, "")]
    for lead in _BY:
        if q.startswith(lead) and lead.endswith("by "):
            out.append(("", q[len(lead):].strip()))
    for lead in _LEADS:
        if q.startswith(lead):
            out.append((quick.key(q[len(lead):]), ""))
    for what, _who in list(out):
        if what and " by " in what:
            title, who = what.rsplit(" by ", 1)
            out.append((title.strip(), quick.key(who)))
    return [w for w in dict.fromkeys(out) if w[0] or w[1]]


def _is(item: dict[str, str], what: str, who: str) -> bool:
    """This result is, by name, the thing asked for."""
    name = quick.key(item["name"])
    artist = quick.key(item.get("artist") or "")
    if not what:  # "something by X": X themselves
        return item["kind"] == "artist" and name == who
    if name != what:
        return False
    return not who or who in artist or artist in who if artist else not who


def _same_thing(items: list[dict[str, str]]) -> bool:
    """The same song or album several times over (a remaster, a single, the
    album version): any of them is what was asked for."""
    if len({i["kind"] for i in items}) != 1 or items[0]["kind"] not in ("track", "album"):
        return False
    return len({quick.key(i.get("artist") or "") for i in items}) == 1 and bool(items[0].get("artist"))


def choose(results: list[dict[str, str]], query: str, kind: str | None = None) -> tuple[dict[str, str] | None, list[dict[str, str]]]:
    """``(the one to play, or None; the ones to ask about)``.

    Played without asking only when one result is plainly it: the only one
    with that exact name (and that artist, when one was said), or the same
    song or album listed more than once. Two different things with the name
    asked for, or nothing with it, is a question for the person."""
    pool = [r for r in results if kind is None or r["kind"] == kind]
    if not pool:
        return None, []
    exact: list[dict[str, str]] = []
    for what, who in _wanted(query):
        exact = [r for r in pool if _is(r, what, who)]
        if exact:
            break
    if len(exact) == 1 or (exact and _same_thing(exact)):
        return exact[0], []
    if exact:
        return None, exact[:MAX_OPTIONS]
    if kind is not None and len(pool) == 1:
        return pool[0], []
    # Nothing has that name: the best few of each kind, to ask about.
    seen: dict[str, int] = {}
    few = []
    for r in pool:
        seen[r["kind"]] = seen.get(r["kind"], 0) + 1
        if seen[r["kind"]] <= (MAX_OPTIONS if kind else 2):
            few.append(r)
    return None, few[:MAX_OPTIONS]


def describe(item: dict[str, str]) -> str:
    """"Kind of Blue, the album by Miles Davis"."""
    kind = {"track": "the song", "album": "the album", "playlist": "the playlist", "artist": "the artist", "radio": "the station"}[item["kind"]]
    if item["kind"] == "artist":
        return item["name"]
    by = item.get("artist") or item.get("by") or ""
    return f"{item['name']}, {kind}" + (f" by {by}" if by else "")
