import { AlertTriangle, Pill, Plus, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import {
  Card,
  EmptyState,
  Fab,
  ItemButton,
  List,
  ListRow,
  Page,
  ProgressBar,
  ProgressRing,
  Section,
  Stat,
  StatGrid,
  addDays,
  fmtDay,
} from "@/items/ui";
import { cn } from "@/utils/cn";

import { Badge, StatStrip, useWidth } from "./common";
import { MedChecklist, medColor } from "./MedChecklist";
import { FOOD_LABEL, adherence, doseIndex, isCurrent, planChanges, scheduleText, slotDose, slotsFor, supply } from "./meds";
import { QuickLogHost } from "./QuickLog";
import { MedSheet } from "./sheets";
import type { HealthData, Medication } from "./types";
import { todayISO } from "./zone";

export function MedsView({ item, isPhone, ask }: ItemViewProps<HealthData>) {
  const data = item.data;
  const [editing, setEditing] = useState<Medication | null>(null);
  const [adding, setAdding] = useState(false);
  const active = data.medications.filter((m) => isCurrent(m));
  const stopped = data.medications.filter((m) => !active.includes(m));
  const refillDays = data.settings.refill_days;
  const [measure, width] = useWidth<HTMLElement>();
  const twoCol = !isPhone && width >= 900;
  const cardCols = !isPhone && !twoCol && width >= 620 ? 2 : 1;

  const stats = useMemo(() => {
    const a7 = adherence(data, 7);
    const a30 = adherence(data, 30);
    const low = active.filter((m) => {
      const s = supply(m);
      return s?.daysLeft !== null && s?.daysLeft !== undefined && s.daysLeft <= refillDays;
    });
    return { a7, a30, low };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.medications, data.doses, refillDays]);

  // The last 14 days per med: share of scheduled doses taken.
  const strips = useMemo(() => {
    const idx = doseIndex(data.doses);
    const out: Record<string, { day: string; level: "none" | "all" | "some" | "missed" | "pending" }[]> = {};
    const today = todayISO();
    for (const m of active) out[m.id] = [];
    for (let i = 13; i >= 0; i--) {
      const day = addDays(today, -i);
      const slots = slotsFor({ ...data, medications: active }, day, Date.now(), idx);
      for (const m of active) {
        const mine = slots.filter((s) => s.med.id === m.id);
        if (!mine.length) out[m.id].push({ day, level: "none" });
        else {
          const ok = mine.filter((s) => s.state === "taken" || s.state === "late").length;
          const open = mine.filter((s) => s.state === "due" || s.state === "upcoming").length;
          out[m.id].push({ day, level: ok === mine.length ? "all" : open && ok + open === mine.length ? "pending" : ok ? "some" : "missed" });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.medications, data.doses]);

  const medCard = (m: Medication) => {
    const sup = supply(m);
    const a = adherence(data, 30, m.id);
    const low = sup?.daysLeft !== null && sup?.daysLeft !== undefined && sup.daysLeft <= refillDays;
    const food = FOOD_LABEL[m.with_food];
    const today = todayISO();
    const doseNow = slotDose(m, today, null);
    const next = planChanges(m).find((c) => c.from > today);
    return (
      <Card key={m.id} onClick={item.canEdit ? () => setEditing(m) : undefined} className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <ProgressRing value={(a.pct ?? 0) / 100} size={48} stroke={5} color={a.pct !== null && a.pct < 80 ? "var(--warning)" : medColor(m)}>
            {a.pct !== null ? `${a.pct}%` : "–"}
          </ProgressRing>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--text)]">
              {m.name} {doseNow && <span className="font-normal text-[var(--text-muted)]">· {doseNow}</span>}
            </p>
            <p className="truncate text-xs text-[var(--text-muted)]">
              {scheduleText(m)}
              {food ? ` · ${food}` : ""}
            </p>
            {m.purpose && <p className="truncate text-xs text-[var(--text-muted)]">For {m.purpose}</p>}
            {next && (
              <p className="truncate text-xs font-medium text-[var(--item-accent)]">
                From {fmtDay(next.from)}: {next.plan.stopped ? "paused" : next.plan.dose || scheduleText(m, next.from)}
              </p>
            )}
          </div>
          {m.kind === "supplement" && <Badge color="var(--text-muted)">Supplement</Badge>}
        </div>
        {sup && sup.daysLeft !== null && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <span className={cn("flex items-center gap-1", low ? "font-semibold text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                {low && <AlertTriangle className="h-3.5 w-3.5" />}
                {low ? "Refill soon" : "Supply"}
              </span>
              <span className="tabular-nums text-[var(--text-muted)]">
                {m.remaining} left · {Math.floor(sup.daysLeft)} days{sup.runsOut && low ? ` · runs out ${fmtDay(sup.runsOut)}` : ""}
              </span>
            </div>
            <ProgressBar value={Math.min(1, sup.daysLeft / 30)} color={low ? "var(--danger)" : "color-mix(in srgb, var(--text-muted) 70%, transparent)"} />
          </div>
        )}
        {m.schedule.type !== "as_needed" && (
          <div className="flex gap-1" role="img" aria-label={`${m.name}, last 14 days`}>
            {(strips[m.id] ?? []).map((d) => (
              <span
                key={d.day}
                title={`${d.day}: ${d.level}`}
                className="h-2.5 flex-1 rounded-full"
                style={{
                  background:
                    d.level === "all"
                      ? "var(--success)"
                      : d.level === "some"
                        ? "var(--warning)"
                        : d.level === "missed"
                          ? "var(--danger)"
                          : d.level === "pending"
                            ? "color-mix(in srgb, var(--item-accent) 35%, var(--surface-2))"
                            : "var(--surface-2)",
                }}
              />
            ))}
          </div>
        )}
      </Card>
    );
  };

  const list = (
    <Section
      title="Your medicines"
      action={
        item.canEdit && !isPhone && (
          <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
            Add
          </ItemButton>
        )
      }
    >
      {active.length ? (
        <div className={cn("grid gap-3", cardCols === 2 && "grid-cols-2")}>{active.map(medCard)}</div>
      ) : (
        <EmptyState
          icon={Pill}
          title="No medicines yet"
          text="Add prescriptions and supplements for a daily checklist, reminders at each dose, adherence and refill warnings."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" onClick={() => setAdding(true)}>
                  Add a medicine
                </ItemButton>
                <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Add my medications — I'll list them: ")}>
                  Tell the assistant
                </ItemButton>
              </div>
            )
          }
        />
      )}
      {stopped.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer px-1 text-sm text-[var(--text-muted)]">Stopped ({stopped.length})</summary>
          <List className="mt-2">
            {stopped.map((m) => (
              <ListRow
                key={m.id}
                onClick={item.canEdit ? () => setEditing(m) : undefined}
                title={`${m.name}${m.dose ? ` · ${m.dose}` : ""}`}
                subtitle={`${m.start ?? "?"} → ${m.end ?? "stopped"} · history kept`}
              />
            ))}
          </List>
        </details>
      )}
    </Section>
  );

  const today = data.medications.length ? (
    <Section title="Doses" hint="Fill in earlier days too — tap a dose to set the time you took it">
      <MedChecklist item={item} picker />
    </Section>
  ) : null;

  const summary = !active.length ? null : isPhone ? (
    <StatStrip
      items={[
        { label: "7 days", value: stats.a7.pct !== null ? `${stats.a7.pct}%` : "–", sub: `${stats.a7.taken + stats.a7.late}/${stats.a7.due} doses`, tone: stats.a7.pct !== null && stats.a7.pct >= 80 ? "good" : undefined },
        { label: "30 days", value: stats.a30.pct !== null ? `${stats.a30.pct}%` : "–", sub: stats.a30.missed ? `${stats.a30.missed} missed` : "None missed", tone: stats.a30.missed ? "bad" : "good" },
        { label: "Late", value: stats.a30.late, sub: "30 days" },
        { label: "Refills", value: stats.low.length, sub: stats.low.map((m) => m.name).join(", ") || "Stocked", tone: stats.low.length ? "bad" : undefined },
      ]}
    />
  ) : (
    <StatGrid className={twoCol ? "md:grid-cols-2" : "md:grid-cols-4"}>
      <Stat label="Last 7 days" value={stats.a7.pct !== null ? `${stats.a7.pct}%` : "–"} delta={`${stats.a7.taken + stats.a7.late} of ${stats.a7.due} doses`} tone={stats.a7.pct !== null && stats.a7.pct >= 80 ? "good" : "neutral"} />
      <Stat label="Last 30 days" value={stats.a30.pct !== null ? `${stats.a30.pct}%` : "–"} delta={stats.a30.missed ? `${stats.a30.missed} missed` : "None missed"} tone={stats.a30.missed ? "bad" : "good"} />
      <Stat label="Taken late" value={stats.a30.late} delta="30 days" />
      <Stat label="Refills due" value={stats.low.length} delta={stats.low.map((m) => m.name).join(", ") || "All stocked"} tone={stats.low.length ? "bad" : "neutral"} />
    </StatGrid>
  );

  return (
    <Page wide={!isPhone}>
      <QuickLogHost item={item} />
      <header ref={measure} className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-xl font-semibold text-[var(--text)]">Medicines</h2>
        {!isPhone && active.length > 0 && (
          <ItemButton size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask("How has my medication adherence been this month, and is anything running low?")}>
            Review adherence
          </ItemButton>
        )}
      </header>
      {isPhone || !twoCol ? (
        <>
          {today}
          {summary}
          {list}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-6">
          <div className="flex min-w-0 flex-col gap-6">{today}</div>
          <div className="flex min-w-0 flex-col gap-6">
            {summary}
            {list}
          </div>
        </div>
      )}
      {isPhone && item.canEdit && <Fab label="Add medicine" icon={Plus} onClick={() => setAdding(true)} />}
      {(adding || editing) && (
        <MedSheet
          item={item}
          editing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </Page>
  );
}
