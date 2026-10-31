import { CalendarClock, ChevronRight, Droplets, Flower2, Plus, Send, Settings2, Sparkles, Stethoscope } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import {
  Card,
  EmptyState,
  Fab,
  IconButton,
  ItemButton,
  List,
  ListRow,
  Page,
  ProgressBar,
  ProgressRing,
  Section,
  fmtAgo,
  fmtDay,
  fmtTime,
  parseDay,
} from "@/items/ui";
import { cn } from "@/utils/cn";
import { daysBetween } from "@/items/ui";

import { Badge, Callout, capacityWarning, insertReading, blankReading, round, useWidth } from "./common";
import { LogSheet } from "./LogSheet";
import { MedChecklist } from "./MedChecklist";
import { slotsFor } from "./meds";
import {
  SCALE_FACES,
  bpCategory,
  cycleForecast,
  fmtMetric,
  fmtParts,
  fromDisplay,
  glucoseBand,
  goalFor,
  indexReadings,
  metricDef,
  todayValue,
  type MetricDef,
} from "./metrics";
import { QuickLogHost, openQuickLog } from "./QuickLog";
import { openRecordsAt } from "./Records";
import { SymptomSheet } from "./sheets";
import type { HealthData, Reading } from "./types";
import { nowISO, todayISO } from "./zone";

export function TodayView({ item, isPhone, ask, goTo }: ItemViewProps<HealthData>) {
  const data = item.data;
  const s = data.settings;
  const day = todayISO();
  const idx = useMemo(() => indexReadings(data.readings), [data.readings]);
  const [editing, setEditing] = useState<Reading | null>(null);
  const [say, setSay] = useState("");
  const [symptom, setSymptom] = useState(false);
  const [measure, width] = useWidth<HTMLElement>();
  // Two columns only when the app itself is wide (not the viewport: the Ask
  // panel can leave ~700 px on a 1440 screen).
  const twoCol = !isPhone && width >= 860;
  const tileCols = isPhone ? 2 : (twoCol ? width - 384 : width) >= 540 ? 3 : 2;

  const tiles = useMemo(
    () => s.today_tiles.map((id) => metricDef(data, id)).filter((m): m is MetricDef => !!m),
    [s.today_tiles, data],
  );

  const todays = useMemo(() => {
    const rows = data.readings.filter((r) => r.at.slice(0, 10) === day);
    return rows.slice().reverse();
  }, [data.readings, day]);
  const todaysSymptoms = data.symptoms.filter((x) => x.at.slice(0, 10) === day);

  // Alerts: a crisis-range BP in the last 24 h, a low glucose today.
  const alerts = useMemo(() => {
    const out: { key: string; title: string; text: string }[] = [];
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const bp = idx.bp?.[idx.bp.length - 1];
    if (bp && new Date(bp.at).toISOString() >= since) {
      const c = bpCategory(bp.sys, bp.dia);
      if (c?.id === "crisis") out.push({ key: "bp", title: `Blood pressure ${bp.sys}/${bp.dia} is in the crisis range`, text: c.advice ?? "" });
    }
    const g = idx.glucose?.[idx.glucose.length - 1];
    if (g && g.value !== null && g.at.slice(0, 10) === day) {
      const b = glucoseBand(g.value, g.context, s.glucose_unit);
      if (b.id === "low" || b.id === "very_low") out.push({ key: "glu", title: `Glucose ${fmtMetric(metricDef(data, "glucose")!, g.value, s)} is low`, text: b.advice ?? "" });
    }
    return out;
  }, [idx, day, data, s]);

  const cycle = s.cycle_tracking ? cycleForecast(data.periods, day) : null;
  const nextAppt = data.appointments.find((a) => !a.done && a.at >= nowISO());
  const hasMeds = data.medications.some((m) => m.active);
  const doseState = useMemo(() => {
    const sl = slotsFor(data, day);
    const done = sl.filter((x) => x.state === "taken" || x.state === "late" || x.state === "skipped").length;
    const open = sl.filter((x) => x.state === "due" || x.state === "missed").length;
    return { total: sl.length, done, open };
  }, [data, day]);

  const tile = (m: MetricDef) => {
    const rows = idx[m.id];
    const goal = goalFor(data, m.id);
    const v = m.kind === "bp" ? null : todayValue(rows, m, day);
    const last = rows?.[rows.length - 1];
    let main: { value: string; unit: string } = { value: "Log", unit: "" };
    let sub = "Nothing yet";
    let stale = true;
    if (m.kind === "bp") {
      const t = last && last.at.slice(0, 10) === day ? last : null;
      if (t) {
        main = { value: `${t.sys}/${t.dia}`, unit: "" };
        sub = bpCategory(t.sys, t.dia)?.label ?? "";
        stale = false;
      } else if (last) {
        main = { value: `${last.sys}/${last.dia}`, unit: "" };
        sub = fmtAgo(last.at);
      }
    } else if (v !== null) {
      main = m.kind === "scale" ? { value: SCALE_FACES[Math.round(v) - 1] ?? "–", unit: "" } : fmtParts(m, v, s);
      stale = false;
      sub = goal?.direction === "daily" && goal.target ? `of ${fmtMetric(m, goal.target, s)}` : m.id === "sleep" && last?.quality ? `Quality ${last.quality}/5` : "Today";
    } else if (last) {
      const lv = last.value;
      if (lv !== null) main = m.kind === "scale" ? { value: SCALE_FACES[Math.round(lv) - 1] ?? "–", unit: "" } : fmtParts(m, lv, s);
      sub = goal?.direction === "daily" && goal.target ? `None today · last ${fmtAgo(last.at)}` : `Last · ${fmtAgo(last.at)}`;
    }
    const progress = goal?.direction === "daily" && goal.target ? (v ?? 0) / goal.target : null;
    return (
      <div key={m.id} className="relative">
        <button
          type="button"
          disabled={!item.canEdit}
          onClick={() => openQuickLog(m.id)}
          className="flex h-full min-h-[112px] w-full flex-col justify-between gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-left shadow-[var(--shadow-sm)] transition hover:border-[var(--item-accent)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:cursor-default"
          aria-label={`Log ${m.label}`}
        >
          <span className={cn("flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]", m.kind === "water" && item.canEdit && "pr-16")}>
            <m.icon className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
            <span className="truncate">{m.label}</span>
          </span>
          <span className="flex items-end justify-between gap-2">
            <span className="min-w-0">
              <span className={cn("block truncate text-2xl font-semibold tabular-nums tracking-tight", stale ? (rows?.length ? "text-[var(--text-muted)] opacity-80" : "text-[var(--item-accent)] text-lg") : "text-[var(--text)]")}>
                {main.value}
                {main.unit && <span className="ml-1 text-sm font-normal text-[var(--text-muted)]">{main.unit}</span>}
              </span>
              <span className="block truncate text-[11px] text-[var(--text-muted)]">{sub}</span>
            </span>
            {progress !== null && v !== null && <ProgressRing value={progress} size={40} stroke={5} color={progress >= 1 ? "var(--success)" : undefined} />}
          </span>
        </button>
        {m.kind === "water" && item.canEdit && (
          <button
            type="button"
            aria-label={`Add ${s.water_unit === "oz" ? "8 oz" : "250 ml"} of water`}
            onClick={() =>
              item.update((d) => {
                insertReading(d, { ...blankReading("water"), value: round(fromDisplay(s.water_unit === "oz" ? 8 : 250, "water", s), 2) });
              })
            }
            className="absolute right-2 top-2 flex h-9 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-2.5 text-xs font-semibold text-[var(--item-accent)] active:scale-95"
          >
            <Droplets className="h-3.5 w-3.5" />+{s.water_unit === "oz" ? "8" : "250"}
          </button>
        )}
      </div>
    );
  };

  const tilesBlock = (
    <Section
      title="Quick log"
      action={
        item.canEdit && (
          <IconButton label="Choose Today tiles" icon={Settings2} onClick={() => (openRecordsAt("profile"), goTo("records"))} />
        )
      }
    >
      <div className={cn("grid gap-3", tileCols === 3 ? "grid-cols-3" : "grid-cols-2")}>
        {tiles.map(tile)}
        {item.canEdit && (
          <button
            type="button"
            onClick={() => openQuickLog()}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-[var(--border)] text-sm font-medium text-[var(--text-muted)] transition hover:border-[var(--item-accent)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              tiles.length % tileCols === 0 ? "col-span-full h-12" : "min-h-[112px] flex-col",
            )}
          >
            <Plus className="h-5 w-5" />
            {tiles.length % tileCols === 0 ? "Log something else" : "More"}
          </button>
        )}
      </div>
    </Section>
  );

  const sayBlock = item.canEdit && (
    <form
      className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 pl-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!say.trim()) return;
        ask(`Log this: ${say.trim()}`);
        setSay("");
      }}
    >
      <Sparkles className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
      <input
        value={say}
        onChange={(e) => setSay(e.target.value)}
        aria-label="Tell the assistant what to log"
        placeholder="“BP 128/82 this morning, slept badly”"
        className="h-10 min-w-0 flex-1 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] md:text-sm"
      />
      <IconButton label="Send to the assistant" icon={Send} onClick={() => say.trim() && (ask(`Log this: ${say.trim()}`), setSay(""))} />
    </form>
  );

  const medsBlock = hasMeds ? (
    <Section
      title="Medicines today"
      hint={doseState.total ? (doseState.open ? `${doseState.done} of ${doseState.total} logged · ${doseState.open} to take` : doseState.done === doseState.total ? "All done for today" : `${doseState.done} of ${doseState.total} logged`) : undefined}
      action={<ItemButton size="sm" variant="ghost" onClick={() => goTo("meds")}>All <ChevronRight className="h-3.5 w-3.5" /></ItemButton>}
    >
      {doseState.total > 0 && <ProgressBar value={doseState.done / doseState.total} color={doseState.done === doseState.total ? "var(--success)" : undefined} />}
      <MedChecklist item={item} compact={!isPhone && !twoCol} />
    </Section>
  ) : null;

  const todayList = (
    <Section
      title="Logged today"
      action={
        item.canEdit && (
          <ItemButton size="sm" variant="ghost" icon={<Stethoscope className="h-3.5 w-3.5" />} onClick={() => setSymptom(true)}>
            Symptom
          </ItemButton>
        )
      }
    >
      {todays.length || todaysSymptoms.length ? (
        <List>
          {todays.map((r) => {
            const m = metricDef(data, r.metric);
            if (!m) return null;
            const val =
              m.kind === "bp"
                ? `${r.sys}/${r.dia}${r.pulse ? ` · ${r.pulse} bpm` : ""}`
                : m.kind === "scale" && r.value
                  ? `${SCALE_FACES[r.value - 1]} ${r.value}/5`
                  : m.kind === "sleep" && r.value === null
                    ? `Quality ${r.quality}/5`
                    : fmtMetric(m, r.value, s);
            const cat = m.kind === "bp" ? bpCategory(r.sys, r.dia) : null;
            return (
              <ListRow
                key={r.id}
                onClick={item.canEdit ? () => setEditing(r) : undefined}
                leading={<m.icon className="h-4 w-4 text-[var(--item-accent)]" />}
                title={m.label}
                subtitle={`${fmtTime(r.at)}${r.note ? ` · ${r.note}` : ""}`}
                trailing={
                  <span className="flex items-center gap-2">
                    {cat && <Badge color={cat.color}>{cat.label.replace("Hypertension ", "")}</Badge>}
                    <span className="font-semibold tabular-nums text-[var(--text)]">{val}</span>
                  </span>
                }
              />
            );
          })}
          {todaysSymptoms.map((x) => (
            <ListRow
              key={x.id}
              leading={<Stethoscope className="h-4 w-4 text-[var(--item-accent)]" />}
              title={x.name}
              subtitle={`${fmtTime(x.at)}${x.tags.length ? ` · ${x.tags.join(", ")}` : ""}`}
              trailing={<span className="font-semibold tabular-nums text-[var(--text)]">{x.severity}/10</span>}
            />
          ))}
        </List>
      ) : (
        <p className="px-1 text-sm text-[var(--text-muted)]">Nothing yet today — tap a tile above, or tell the assistant.</p>
      )}
    </Section>
  );

  const sideCards = (
    <>
      {nextAppt && (
        <Card onClick={() => (openRecordsAt("visits"), goTo("records"))} className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
            <CalendarClock className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--text)]">{nextAppt.title || "Appointment"}</p>
            <p className="truncate text-xs text-[var(--text-muted)]">
              {fmtDay(nextAppt.at.slice(0, 10))} · {fmtTime(nextAppt.at)}
              {nextAppt.who ? ` · ${nextAppt.who}` : ""}
            </p>
          </div>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-xs font-semibold tabular-nums text-[var(--item-accent)]">{apptIn(nextAppt.at.slice(0, 10), day)}</span>
            {nextAppt.questions.length > 0 && (
              <span className="text-[11px] text-[var(--text-muted)]">
                {nextAppt.questions.length} question{nextAppt.questions.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </Card>
      )}
      {cycle && (
        <Card className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
            <Flower2 className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--text)]">
              {cycle.inPeriod ? `Period · day ${cycle.cycleDay}` : `Cycle day ${cycle.cycleDay}`}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {cycle.daysUntilNext >= 0
                ? `Next period in about ${cycle.daysUntilNext} day${cycle.daysUntilNext === 1 ? "" : "s"}`
                : `Period expected ${-cycle.daysUntilNext} day${cycle.daysUntilNext === -1 ? "" : "s"} ago`}
              {day >= cycle.fertile[0] && day <= cycle.fertile[1] ? " · fertile window (estimate)" : ""}
            </p>
          </div>
          <ItemButton size="sm" onClick={() => (openRecordsAt("cycle"), goTo("records"))}>
            Log
          </ItemButton>
        </Card>
      )}
    </>
  );

  const askCard = (
    <Card className="flex flex-col gap-1">
      <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
        <Sparkles className="h-4 w-4 text-[var(--item-accent)]" />
        Ask about your numbers
      </p>
      {["How's my weight trend this month?", "Is my blood pressure in a healthy range?", "Does my sleep affect my mood?"].map((q) => (
        <button key={q} type="button" onClick={() => ask(q)} className="flex min-h-[40px] items-center rounded-xl px-2 text-left text-sm text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]">
          {q}
        </button>
      ))}
    </Card>
  );

  const empty = !data.readings.length && !hasMeds && !data.symptoms.length;
  const full = useMemo(() => capacityWarning(data), [data]);

  return (
    <Page wide={!isPhone}>
      <QuickLogHost item={item} />
      <header ref={measure} className="flex items-end justify-between gap-2 px-1">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">{parseDay(day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
          <h2 className="text-xl font-semibold text-[var(--text)]">Today</h2>
        </div>
        {/* Desktop "Log" lives in the shell header (primaryAction) — not repeated here. */}
      </header>

      {alerts.map((a) => (
        <Callout key={a.key} tone="danger" title={a.title}>
          {a.text}
        </Callout>
      ))}

      {full && (
        <Callout tone="warning" title="This file is nearly full">
          {full}. Nothing is ever deleted to make room — use <b>Archive older data</b> in the file's menu to move older entries into an archive file.
        </Callout>
      )}

      {empty && (
        <EmptyState
          icon={Sparkles}
          title="Start with one number"
          text="Log your weight, blood pressure or last night's sleep — or tell the assistant everything at once. Add your medicines and you'll get dose reminders."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" onClick={() => openQuickLog("weight")}>
                  Log weight
                </ItemButton>
                <ItemButton onClick={() => ask("Help me set up my medications and reminders")}>Set up medicines</ItemButton>
              </div>
            )
          }
        />
      )}

      {isPhone || !twoCol ? (
        <>
          {sayBlock}
          {/* Doses still to take come first (Medisafe): it's the one thing on
              this screen with a time attached. */}
          {doseState.open > 0 ? (
            <>
              {medsBlock}
              {tilesBlock}
            </>
          ) : (
            <>
              {tilesBlock}
              {medsBlock}
            </>
          )}
          {sideCards}
          {todayList}
          {!isPhone && askCard}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
          <div className="flex min-w-0 flex-col gap-6">
            {sayBlock}
            {tilesBlock}
            {todayList}
          </div>
          <div className={cn("flex min-w-0 flex-col gap-4")}>
            {sideCards}
            {medsBlock}
            {!hasMeds && item.canEdit && (
              <Card className="flex flex-col gap-2">
                <p className="text-sm font-semibold text-[var(--text)]">Medicines & supplements</p>
                <p className="text-sm text-[var(--text-muted)]">Add them to get a daily checklist, reminders and refill warnings.</p>
                <ItemButton size="sm" className="self-start" onClick={() => goTo("meds")}>
                  Add a medicine
                </ItemButton>
              </Card>
            )}
            {askCard}
          </div>
        </div>
      )}

      {isPhone && item.canEdit && <Fab label="Log" icon={Plus} onClick={() => openQuickLog()} />}
      {editing && <LogSheet item={item} metric={editing.metric} editing={editing} onClose={() => setEditing(null)} />}
      {symptom && <SymptomSheet item={item} onClose={() => setSymptom(false)} />}
    </Page>
  );
}

function apptIn(apptDay: string, today: string): string {
  const n = daysBetween(today, apptDay);
  return n <= 0 ? "Today" : n === 1 ? "Tomorrow" : n < 14 ? `In ${n} days` : n < 60 ? `In ${Math.round(n / 7)} weeks` : fmtDay(apptDay);
}
