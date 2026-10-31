import { Archive, BarChart3, Brain, Clock, Flame, Sparkles, Target } from "lucide-react";
import { useMemo, useState } from "react";

import { itemsApi } from "@/items/api";
import type { ItemViewProps } from "@/items/types";
import { Card as Panel, EmptyState, ItemButton, Page, Section, Segmented, Stat, StatGrid, fmtDuration, fmtNum } from "@/items/ui";
import { Bars, Heatmap, TrendChart } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { subtree } from "./cards";
import { CardEditorSheet } from "./CardEditor";
import { useAddIntent, DeckSelect, useCfg, useNow, useWidth } from "./common";
import * as F from "./fsrs";
import { byDay, forecast, streak } from "./queue";
import { MAX_LOG, type Data } from "./types";

const shortDay = (n: number) => {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
};

export function StatsTab({ item, isPhone, ask, doc }: ItemViewProps<Data>) {
  const data = item.data;
  const cfg = useCfg(data);
  const now = useNow(60_000);
  const [deck, setDeck] = useState("");
  const [span, setSpan] = useState<"30" | "90" | "365">("30");
  const [adding, setAdding] = useState(false);
  useAddIntent(() => setAdding(true));
  const addSheet = <CardEditorSheet item={item} open={adding} card={null} onClose={() => setAdding(false)} ask={ask} />;
  const ids = useMemo(() => (deck ? subtree(data.decks, deck) : null), [data.decks, deck]);
  const cards = useMemo(() => (ids ? data.cards.filter((c) => ids.has(c.deck_id)) : data.cards), [data.cards, ids]);
  const cardIds = useMemo(() => (ids ? new Set(cards.map((c) => c.id)) : null), [cards, ids]);
  const days = useMemo(() => byDay(data.review_log, cfg, cardIds), [data.review_log, cfg, cardIds]);
  const today = F.dayIndex(now, cfg);
  const n = Number(span);
  // The heatmap scrolls from the left, so newest days (on the right) hide
  // when it's wider than its card: size it to the room it has (15 px a week).
  const [heatRef, heatW] = useWidth<HTMLDivElement>();
  const [gridRef, gridW] = useWidth<HTMLDivElement>();
  const weeks = Math.max(8, Math.min(53, Math.floor((heatW + 3) / 15) || (isPhone ? 17 : 20)));

  const s = useMemo(() => {
    let reviews = 0;
    let ms = 0;
    let rev = 0;
    let pass = 0;
    for (let i = 0; i < n; i++) {
      const d = days.get(today - i);
      if (!d) continue;
      reviews += d.n;
      ms += d.ms;
      rev += d.reviews;
      pass += d.pass;
    }
    const studiedDays = [...days.keys()].filter((k) => k > today - n).length;
    return {
      reviews,
      ms,
      retention: rev ? pass / rev : null,
      rev,
      studiedDays,
    };
  }, [days, today, n]);

  const st = useMemo(() => streak(cardIds ? data.review_log.filter((e) => cardIds.has(e.c)) : data.review_log, now, cfg), [data.review_log, cardIds, now, cfg]);
  const todayStat = days.get(today);

  const heat = useMemo(() => {
    const vals = [...days.values()].map((d) => d.n).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.floor((vals.length - 1) * p)] ?? 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const out: Record<string, number> = {};
    for (const [k, v] of days) out[F.dayISO(k)] = v.n <= 0 ? 0 : v.n <= cuts[0] ? 1 : v.n <= cuts[1] ? 2 : v.n <= cuts[2] ? 3 : 4;
    return out;
  }, [days]);

  const perDay = useMemo(() => {
    const len = Math.min(n, 90);
    return Array.from({ length: len }, (_, i) => {
      const k = today - (len - 1 - i);
      return { x: shortDay(k), y: days.get(k)?.n ?? 0 };
    });
  }, [days, today, n]);

  const retentionTrend = useMemo(() => {
    const weeks = n <= 30 ? 8 : n <= 90 ? 13 : 52;
    return Array.from({ length: weeks }, (_, i) => {
      const end = today - (weeks - 1 - i) * 7;
      let rev = 0;
      let pass = 0;
      for (let k = end - 6; k <= end; k++) {
        const d = days.get(k);
        if (d) {
          rev += d.reviews;
          pass += d.pass;
        }
      }
      return {
        x: shortDay(end),
        y: rev >= 5 ? Math.round((pass / rev) * 1000) / 10 : null,
        y2: Math.round(cfg.retention * 1000) / 10,
      };
    });
  }, [days, today, n, cfg.retention]);

  const fc = useMemo(() => forecast(data, now, cfg, 30, ids), [data, now, cfg, ids]);
  const fcData = fc.map((y, i) => ({
    x: i === 0 ? "Today" : shortDay(today + i),
    y,
  }));

  const breakdown = useMemo(() => {
    const b = { new: 0, learning: 0, young: 0, mature: 0, suspended: 0 };
    let rSum = 0;
    let rN = 0;
    for (const c of cards)
      for (const x of c.srs) {
        if (c.suspended) b.suspended++;
        else if (x.state === "new") b.new++;
        else if (x.state === "learning" || x.state === "relearning") b.learning++;
        else if ((x.stability ?? 0) >= 21) b.mature++;
        else b.young++;
        const r = F.currentRetrievability(x, now, cfg);
        if (r !== null && !c.suspended) {
          rSum += r;
          rN++;
        }
      }
    return {
      ...b,
      total: Object.values(b).reduce((a, v) => a + v, 0),
      recall: rN ? rSum / rN : null,
    };
  }, [cards, now, cfg]);

  const ratings = useMemo(() => {
    const out = [0, 0, 0, 0];
    const since = now - n * 86_400_000;
    for (const e of data.review_log) {
      if (cardIds && !cardIds.has(e.c)) continue;
      if (F.parseMoment(e.t) < since) continue;
      out[e.r - 1]++;
    }
    return out;
  }, [data.review_log, cardIds, now, n]);

  if (!data.review_log.length)
    return (
      <Page>
        <EmptyState icon={BarChart3} title="No reviews yet" text="Study a few cards and your heatmap, retention and forecast show up here." />
        {addSheet}
      </Page>
    );

  const retTone = s.retention === null ? "neutral" : s.retention >= cfg.retention - 0.03 ? "good" : "bad";
  const segs: { k: keyof typeof breakdown; label: string; color: string }[] = [
    { k: "new", label: "New", color: "var(--item-accent)" },
    { k: "learning", label: "Learning", color: "var(--danger)" },
    {
      k: "young",
      label: "Young",
      color: "color-mix(in srgb, var(--success) 55%, var(--surface-2))",
    },
    { k: "mature", label: "Mature", color: "var(--success)" },
    { k: "suspended", label: "Suspended", color: "var(--warning)" },
  ];
  const ratingTotal = ratings.reduce((a, v) => a + v, 0);

  return (
    <Page wide={!isPhone}>
      <div className="flex flex-wrap items-center gap-2">
        <DeckSelect decks={data.decks} value={deck} onChange={setDeck} allLabel="All decks" className="w-auto min-w-[160px] flex-1 md:max-w-xs md:flex-none" />
        <Segmented
          value={span}
          onChange={setSpan}
          options={[
            { value: "30", label: "30 d" },
            { value: "90", label: "90 d" },
            { value: "365", label: "1 y" },
          ]}
        />
      </div>
      <StatGrid>
        <Stat label="Today" icon={Brain} value={fmtNum(todayStat?.n ?? 0)} unit="cards" delta={todayStat ? fmtDuration(todayStat.ms / 1000) : "not yet"} />
        <Stat
          label="Streak"
          icon={Flame}
          value={st.days}
          unit={st.days === 1 ? "day" : "days"}
          delta={`best ${st.best}`}
          tone={st.days ? "accent" : "neutral"}
        />
        <Stat
          label="True retention"
          icon={Target}
          value={s.retention === null ? "–" : `${(s.retention * 100).toFixed(1)}%`}
          delta={`target ${Math.round(cfg.retention * 100)}% · ${s.rev} reviews`}
          tone={retTone}
        />
        <Stat label="Time studied" icon={Clock} value={fmtDuration(s.ms / 1000)} delta={`${fmtNum(s.reviews)} reviews · ${s.studiedDays}/${n} days`} />
      </StatGrid>

      <div ref={gridRef} className={cn("grid gap-5", gridW >= 880 && "grid-cols-2")}>
        <Section title="Reviews by day" hint="Darker = more reviews">
          <Panel>
            <div ref={heatRef} className="flex w-full justify-center overflow-hidden [contain:inline-size]">
              <Heatmap days={heat} weeks={weeks} label={(d) => `${d}: ${days.get(Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000))?.n ?? 0} reviews`} />
            </div>
            <div className="mt-4">
              <Bars data={perDay} height={140} unit="reviews" />
            </div>
          </Panel>
        </Section>
        <Section title="Retention" hint="Share of due reviews you remembered, by week, vs your target (dashed)">
          <Panel>
            <TrendChart data={retentionTrend} height={200} unit="%" area={false} yDomain={[60, 100]} />
            {s.retention !== null && Math.abs(s.retention - cfg.retention) > 0.04 && (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                {s.retention < cfg.retention
                  ? "You're recalling less than your target — new or badly-worded cards, or long gaps, often explain it."
                  : "You're recalling more than your target — you could lower desired retention for fewer reviews."}
              </p>
            )}
          </Panel>
        </Section>
        <Section title="Due in the next 30 days" hint={`${fc.reduce((a, v) => a + v, 0)} reviews · tomorrow ${fc[1] ?? 0}`}>
          <Panel>
            <Bars data={fcData} height={160} unit="due" />
          </Panel>
        </Section>
        <Section
          title="Card states"
          hint={`Mature = interval of 21 days or more${breakdown.recall !== null ? ` · average recall right now ${Math.round(breakdown.recall * 100)}%` : ""}`}
        >
          <Panel className="flex flex-col gap-3">
            <div className="flex h-4 w-full overflow-hidden rounded-full bg-[var(--surface-2)]" role="img" aria-label="Card states">
              {segs.map((g) =>
                breakdown[g.k] ? (
                  <span
                    key={g.k}
                    style={{
                      width: `${((breakdown[g.k] as number) / Math.max(1, breakdown.total)) * 100}%`,
                      background: g.color,
                    }}
                  />
                ) : null,
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-sm">
              {segs.map((g) => (
                <span key={g.k} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
                  <span className="text-[var(--text-muted)]">{g.label}</span>
                  <span className="ml-auto font-semibold tabular-nums text-[var(--text)]">{breakdown[g.k] as number}</span>
                </span>
              ))}
            </div>
            {ratingTotal > 0 && (
              <div className="border-t border-[var(--border)] pt-3">
                <p className="mb-2 text-xs font-medium text-[var(--text-muted)]">Answers ({span} d)</p>
                <div className="grid grid-cols-4 text-center text-xs text-[var(--text-muted)]">
                  {["Again", "Hard", "Good", "Easy"].map((l, i) => (
                    <span key={l}>
                      <span className="block text-base font-semibold tabular-nums text-[var(--text)]">{Math.round((ratings[i] / ratingTotal) * 100)}%</span>
                      {l}
                    </span>
                  ))}
                </div>
                {ratings[1] / ratingTotal > 0.25 && (
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    Lots of Hard — remember Hard means “remembered, with effort”. If you forgot, press Again.
                  </p>
                )}
              </div>
            )}
          </Panel>
        </Section>
      </div>
      <div className="flex flex-wrap gap-2">
        <ItemButton
          size="sm"
          variant="ghost"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onClick={() => ask("Review my study stats — retention vs target, workload, streak — and tell me the one or two changes that would help most.")}
        >
          Review my stats
        </ItemButton>
        <ItemButton
          size="sm"
          variant="ghost"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onClick={() => ask("Make a study plan for my exam using the forecast — ask me the date if it isn't saved.")}
        >
          Exam plan
        </ItemButton>
      </div>
      <HistoryPanel item={item} canArchive={!!doc.can_archive} />
      {addSheet}
    </Page>
  );
}

/** How much review history the file holds — and, when it's filling up, a way
 *  to move the old part into an archive file (scheduling stays on the cards,
 *  so nothing about the schedule changes). Never trimmed silently. */
function HistoryPanel({ item, canArchive }: { item: ItemViewProps<Data>["item"]; canArchive: boolean }) {
  const log = item.data.review_log;
  const trimmed = item.data.log_trimmed ?? 0;
  const pct = Math.round((log.length / MAX_LOG) * 100);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const yearAgo = useMemo(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }, []);
  const [before, setBefore] = useState(yearAgo);
  if (pct < 50 && !trimmed) return null;
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await itemsApi.archive<Data>(item.fileId, before);
      item.accept(res.data, res.revision);
      setMsg("Older history moved to an archive file next to this one.");
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setMsg(typeof detail === "string" ? detail : "Couldn't archive right now — try again when you're online.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Review history" hint={`${fmtNum(log.length)} of ${fmtNum(MAX_LOG)} entries (${pct}%)`}>
      <Panel className="flex flex-col gap-3 text-sm">
        {trimmed > 0 && (
          <p className="text-[var(--warning)]" role="status">
            {fmtNum(trimmed)} of the oldest entries were dropped when the history was full. Your schedule wasn't affected; archive older history to keep the
            rest.
          </p>
        )}
        <p className="text-[var(--text-muted)]">
          Archiving moves answers before a date into a new file next to this one (its stats stay readable there). Due dates and card scheduling don't change.
        </p>
        {canArchive && item.canEdit && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-muted)]">
              Archive answers before
              <input
                type="date"
                value={before}
                onChange={(e) => setBefore(e.target.value)}
                className="h-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)]"
              />
            </label>
            <ItemButton
              icon={<Archive className="h-4 w-4" />}
              disabled={busy || !before || (typeof navigator !== "undefined" && !navigator.onLine)}
              onClick={run}
            >
              {busy ? "Archiving…" : "Archive older history"}
            </ItemButton>
          </div>
        )}
        {msg && (
          <p className="text-[var(--text)]" role="status">
            {msg}
          </p>
        )}
      </Panel>
    </Section>
  );
}
