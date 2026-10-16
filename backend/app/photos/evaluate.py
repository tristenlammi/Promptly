"""Photos quality, measured (Part E §E9): the owner's evaluation library —
their own photos, labelled by hand, kept on their machine — run against
the engine, with the numbers tracked per release.

    docker compose exec backend python -m app.photos.evaluate /app/uploads/.photos-eval/spec.json

The spec (JSON; never committed) names whose library it is and what's
true about it, by file name::

    {
      "user": "tristen",
      "queries": [
        {"q": "me and my wife at Noosa", "expect": ["IMG_0412.jpg", "IMG_0413.jpg"]},
        {"q": "Max on the beach", "expect": ["PXL_2023…jpg"]}
      ],
      "people": {"Sarah": ["IMG_0412.jpg", "IMG_0500.jpg"], "Tristen": ["IMG_0412.jpg"]},
      "pets": {"Max": ["PXL_2023…jpg"]}
    }

What it reports:

* **search** — for each query, the rank of the first expected photo:
  success@5 (found in the top five) and MRR, with latency p50 / p95;
* **faces** — for each labelled person, how many of their photos the
  person of that name is found in (recall) and how many of that person's
  photos are really them (precision, over the labelled photos);
* **pets** — the same for named pets (top-1 = the pet named on the photo).

Nothing is written; it only reads. A file name that matches more than one
of their files is reported, not guessed.
"""
from __future__ import annotations

import asyncio
import json
import statistics
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class Report:
    queries: list[dict[str, Any]] = field(default_factory=list)
    people: list[dict[str, Any]] = field(default_factory=list)
    pets: list[dict[str, Any]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        ranks = [q["rank"] for q in self.queries]
        times = [q["ms"] for q in self.queries]
        out: dict[str, Any] = {}
        if ranks:
            out["search"] = {
                "queries": len(ranks),
                "success_at_5": round(sum(1 for r in ranks if r and r <= 5) / len(ranks), 3),
                "mrr": round(sum(1 / r for r in ranks if r) / len(ranks), 3),
                "p50_ms": round(statistics.median(times)),
                "p95_ms": round(sorted(times)[max(0, int(len(times) * 0.95 + 0.5) - 1)]),
            }
        for key in ("people", "pets"):
            rows = getattr(self, key)
            if rows:
                out[key] = {
                    "labelled": len(rows),
                    "recall": round(sum(r["found"] for r in rows) / max(1, sum(r["labelled"] for r in rows)), 3),
                    "precision": round(sum(r["right"] for r in rows) / max(1, sum(r["claimed"] for r in rows)), 3),
                }
        return out


async def _files(db: AsyncSession, user_id: uuid.UUID, names: set[str]) -> tuple[dict[str, uuid.UUID], list[str]]:
    rows = (await db.execute(
        text(
            "SELECT f.filename, f.id FROM files f JOIN photo_assets p ON p.file_id = f.id "
            "WHERE p.user_id = :u AND f.trashed_at IS NULL AND f.filename = ANY(CAST(:n AS text[]))"
        ),
        {"u": user_id, "n": sorted(names)},
    )).all()
    seen: dict[str, list[uuid.UUID]] = {}
    for name, fid in rows:
        seen.setdefault(name, []).append(fid)
    problems = [f"“{n}” isn't in the library" for n in sorted(names - set(seen))]
    problems += [f"“{n}” matches {len(v)} files — rename one" for n, v in seen.items() if len(v) > 1]
    return {n: v[0] for n, v in seen.items() if len(v) == 1}, problems


async def _subjects(db: AsyncSession, user_id: uuid.UUID, labels: dict[str, list[str]], kind: str,
                    by_name: dict[str, uuid.UUID]) -> list[dict[str, Any]]:
    table, col = ("photo_faces", "person_id") if kind == "person" else ("photo_animals", "pet_id")
    labelled_files = {by_name[f] for files in labels.values() for f in files if f in by_name}
    out = []
    for name, files in labels.items():
        truth = {by_name[f] for f in files if f in by_name}
        found = set((await db.execute(
            text(
                f"SELECT DISTINCT o.file_id FROM {table} o JOIN photo_people pp ON pp.id = o.{col} "
                f"WHERE pp.user_id = :u AND pp.kind = :k AND lower(pp.name) = lower(:n)"
            ),
            {"u": user_id, "k": kind, "n": name},
        )).scalars())
        # Precision over the photos someone labelled: an unlabelled photo
        # the engine names them in may be right — it isn't counted against it.
        claimed = found & labelled_files
        out.append({"name": name, "labelled": len(truth), "found": len(found & truth),
                    "claimed": len(claimed), "right": len(claimed & truth)})
    return out


async def run(db: AsyncSession, spec: dict[str, Any]) -> Report:
    from app.auth.models import User
    from app.photos import engine
    from sqlalchemy import func, select

    user = (await db.execute(select(User).where(func.lower(User.username) == str(spec["user"]).lower()))).scalars().first()
    if user is None:
        raise SystemExit(f"No user {spec['user']!r}.")
    names = {f for q in spec.get("queries", []) for f in q.get("expect", [])}
    for key in ("people", "pets"):
        names |= {f for files in (spec.get(key) or {}).values() for f in files}
    by_name, problems = await _files(db, user.id, names)
    report = Report(problems=problems)
    known = (await db.execute(text("SELECT name, kind FROM photo_people WHERE user_id = :u AND name IS NOT NULL"), {"u": user.id})).all()
    people_names = [n for n, k in known if k == "person"]
    pet_names = [n for n, k in known if k == "pet"]
    for item in spec.get("queries", []):
        want = {by_name[f] for f in item.get("expect", []) if f in by_name}
        q = engine.parse(item["q"], people_names=people_names, pet_names=pet_names)
        q.limit = 50
        t0 = time.perf_counter()
        got = await engine.search(db, user, q)
        ms = (time.perf_counter() - t0) * 1000
        ids = [uuid.UUID(i["id"]) for i in got["items"]]
        rank = next((n for n, fid in enumerate(ids, 1) if fid in want), None)
        report.queries.append({"q": item["q"], "rank": rank, "ms": round(ms), "relaxed": got["relaxed"], "unresolved": got["unresolved"]})
    report.people = await _subjects(db, user.id, spec.get("people") or {}, "person", by_name)
    report.pets = await _subjects(db, user.id, spec.get("pets") or {}, "pet", by_name)
    return report


def render(report: Report) -> str:
    lines = ["Photos evaluation", "=" * 17]
    for k, v in report.summary().items():
        lines.append(f"{k}: " + ", ".join(f"{a}={b}" for a, b in v.items()))
    misses = [q for q in report.queries if not q["rank"] or q["rank"] > 5]
    if misses:
        lines.append("")
        lines.append("Not in the top five:")
        for q in misses:
            where = "not found" if not q["rank"] else f"rank {q['rank']}"
            extra = f" (widened: {', '.join(q['relaxed'])})" if q["relaxed"] else ""
            extra += f" (unknown: {', '.join(q['unresolved'])})" if q["unresolved"] else ""
            lines.append(f"  - {q['q']!r}: {where}{extra}")
    if report.problems:
        lines.append("")
        lines.append("Spec problems:")
        lines += [f"  - {p}" for p in report.problems]
    return "\n".join(lines)


async def _main(path: str) -> None:
    from app.database import SessionLocal

    spec = json.loads(Path(path).read_text("utf-8"))
    async with SessionLocal() as db:
        report = await run(db, spec)
    print(render(report))
    print(json.dumps(report.summary()))


if __name__ == "__main__":  # pragma: no cover
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m app.photos.evaluate SPEC.json")
    asyncio.run(_main(sys.argv[1]))


__all__ = ["Report", "render", "run"]
