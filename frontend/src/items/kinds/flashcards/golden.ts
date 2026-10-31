/*
 * The FSRS-6 golden run, checked from TypeScript.
 *
 * ``backend/tests/test_item_flashcards_golden.json`` is written by (and
 * asserted in) ``backend/tests/test_item_flashcards.py::test_golden_fixture``
 * — 16 answers with lapses, relearning, Hard/Easy and fuzz, in a fixed zone.
 * ``checkGolden`` replays the same answers through ``fsrs.ts`` and lists
 * every difference (labels, due moments, state, S, D, log fields). An empty
 * list = the two schedulers agree.
 *
 * Run it (from ``frontend/``; esbuild ships with Vite):
 *
 *   npx esbuild src/items/kinds/flashcards/golden-run.mjs --bundle --platform=node \
 *     --format=esm --outfile="$TMP/fc-golden.mjs" && node "$TMP/fc-golden.mjs" ../backend/tests/test_item_flashcards_golden.json
 *
 * (any scratch path outside the repo works for --outfile). It prints
 * "golden: 16/16 steps match; invariants hold" or the differences and
 * exits non-zero.
 */
import * as F from "./fsrs";
import type { Srs } from "./types";

export interface GoldenStep {
  at: string;
  rating: F.Rating;
  seed: string;
  labels: string[];
  due: string;
  state: string;
  stability: number;
  difficulty: number;
  log: { r: number; s: string; e: number; i: number };
}

export interface GoldenFixture {
  tz: string;
  steps: GoldenStep[];
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/** Every mismatch between ``fsrs.ts`` and the fixture (empty = identical). */
export function checkGolden(fx: GoldenFixture): string[] {
  const cfg = F.configFrom({}, fx.tz);
  if (cfg.tz !== fx.tz) return [`this runtime doesn't know the zone ${fx.tz}`];
  const errs: string[] = [];
  let s: Srs = F.newSrs("f");
  fx.steps.forEach((st, i) => {
    const t = F.parseMoment(st.at);
    if (F.iso(t, cfg.tz) !== st.at) errs.push(`step ${i}: iso(${st.at}) = ${F.iso(t, cfg.tz)}`);
    const p = F.preview(s, t, cfg, st.seed);
    const labels = F.RATINGS.map((g) => F.label(p[g].minutes, p[g].days));
    if (labels.join() !== st.labels.join()) errs.push(`step ${i}: labels ${labels.join(" ")} ≠ ${st.labels.join(" ")}`);
    const { srs, log } = F.review(s, st.rating, t, cfg, st.seed);
    if (srs.due !== st.due) errs.push(`step ${i}: due ${srs.due} ≠ ${st.due}`);
    if (srs.state !== st.state) errs.push(`step ${i}: state ${srs.state} ≠ ${st.state}`);
    if (!close(srs.stability ?? NaN, st.stability)) errs.push(`step ${i}: stability ${srs.stability} ≠ ${st.stability}`);
    if (!close(srs.difficulty ?? NaN, st.difficulty)) errs.push(`step ${i}: difficulty ${srs.difficulty} ≠ ${st.difficulty}`);
    if (log.r !== st.log.r || log.s !== st.log.s || log.e !== st.log.e || !close(log.i, st.log.i))
      errs.push(`step ${i}: log ${JSON.stringify(log)} ≠ ${JSON.stringify(st.log)}`);
    s = srs;
  });
  return errs;
}

/** Extra invariants the fixture doesn't cover: a review "ahead" of now
 *  (clock skew) never gives a negative elapsed. */
export function checkInvariants(): string[] {
  const cfg = F.configFrom({}, "Australia/Sydney");
  const now = Date.parse("2026-10-31T09:30:00+11:00");
  const ahead: Srs = { ...F.newSrs("f"), state: "review", stability: 10, difficulty: 5, last_review: "2026-11-02T09:00:00+11:00", due: "2026-11-12T04:00:00+11:00", reps: 3 };
  const { log } = F.review(ahead, 3, now, cfg, "x/f");
  const errs: string[] = [];
  if (log.e !== 0) errs.push(`negative elapsed not clamped: e=${log.e}`);
  // Study days in the saved zone, not the device's.
  if (F.studyDate(Date.parse("2026-10-31T03:00:00+11:00"), cfg) !== "2026-10-30") errs.push("rollover hour in the zone");
  if (F.iso(Date.parse("2026-10-30T22:30:00Z"), "Australia/Sydney") !== "2026-10-31T09:30:00+11:00") errs.push("iso in the zone");
  return errs;
}
