"""Make app/passwords/data/deletion_sites.json from JustDeleteMe's site list.

JustDeleteMe (https://github.com/jdm-contrib/jdm) is MIT licensed:
"Copyright (c) 2013-2020 Robb Lewis, The JDM Contrib Team, & various contributors".
Credited in passwords/THIRD_PARTY.md. Only the deletion page, how hard it is, the
address to write to and the name are kept, per domain.

    python backend/scripts/update_deletion_sites.py --commit <sha>
    python backend/scripts/update_deletion_sites.py --file path/to/sites.json --commit <sha>

Pin a commit so the file in the repo says exactly which data it is.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

OUT = Path(__file__).resolve().parents[1] / "app" / "passwords" / "data" / "deletion_sites.json"
RAW = "https://raw.githubusercontent.com/jdm-contrib/jdm/{ref}/_data/sites.json"
DIFFICULTIES = {"easy", "medium", "hard", "limited", "impossible"}
EMAIL = re.compile(r"^[^@\s<>\"]{1,64}@[a-z0-9.-]{3,253}$", re.IGNORECASE)


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def convert(entries: list[dict]) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        row: dict[str, str] = {}
        url = str(e.get("url") or "")
        if url.startswith("https://") and len(url) <= 500:
            row["url"] = url
        email = str(e.get("email") or "")
        if EMAIL.match(email):
            row["email"] = email
        if str(e.get("difficulty") or "") in DIFFICULTIES:
            row["difficulty"] = str(e["difficulty"])
        if e.get("name"):
            row["name"] = str(e["name"])[:120]
        if not (row.get("url") or row.get("email")):
            continue
        domains = [str(d).lower().removeprefix("www.") for d in (e.get("domains") or []) if isinstance(d, str)]
        if not domains and row.get("url"):
            domains = [host_of(row["url"])]
        for d in domains:
            if d and re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", d):
                out.setdefault(d, row)
    return dict(sorted(out.items()))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True, help="jdm-contrib/jdm commit the data comes from")
    ap.add_argument("--file", help="a sites.json already on disk, instead of downloading it")
    args = ap.parse_args()
    if args.file:
        raw = Path(args.file).read_text(encoding="utf-8")
    else:
        with urllib.request.urlopen(RAW.format(ref=args.commit), timeout=60) as r:  # noqa: S310 — fixed https URL
            raw = r.read().decode("utf-8")
    sites = convert(json.loads(raw))
    doc = {
        "source": "JustDeleteMe, https://github.com/jdm-contrib/jdm, _data/sites.json",
        "licence": "MIT. Copyright (c) 2013-2020 Robb Lewis, The JDM Contrib Team, & various contributors",
        "commit": args.commit,
        "sites": sites,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=0, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(sites)} domains written to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
