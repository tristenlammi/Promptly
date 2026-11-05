import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  FileText,
  FlaskConical,
  Flower2,
  History as HistoryIcon,
  Plus,
  Sparkles,
  Stethoscope,
  Syringe,
  UserRound,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import {
  Card,
  Chip,
  EmptyState,
  Field,
  ItemButton,
  List,
  ListRow,
  Page,
  ScrollRow,
  Section,
  Segmented,
  Sheet,
  addDays,
  daysBetween,
  fmtDay,
  fmtTime,
  parseDay,
} from "@/items/ui";
import { Sparkline } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { Badge } from "./common";
import { LogSheet } from "./LogSheet";
import { SCALE_FACES, bpCategory, cycleForecast, fmtMetric, metricDef } from "./metrics";
import { ProfileView } from "./Profile";
import { QuickLogHost } from "./QuickLog";
import { AppointmentSheet, LabSheet, SymptomSheet, VaxSheet } from "./sheets";
import type { Appointment, Flow, HealthData, LabResult, Reading, Symptom, Vaccination } from "./types";
import { VisitReport } from "./VisitReport";
import { nowISO, todayISO } from "./zone";

export type Sub = "visits" | "labs" | "symptoms" | "vaccines" | "history" | "cycle" | "profile";

let pendingSub: Sub | null = null;
/** Open Records on a given section next time it mounts (Today's shortcuts). */
export function openRecordsAt(sub: Sub) {
  pendingSub = sub;
}

export function RecordsView(props: ItemViewProps<HealthData>) {
  const { item, isPhone } = props;
  const [sub, setSub] = useState<Sub>(() => {
    const p = pendingSub;
    pendingSub = null;
    return p ?? "visits";
  });
  const subs: { id: Sub; label: string; icon: typeof FileText }[] = [
    { id: "visits", label: "Visits", icon: CalendarClock },
    { id: "labs", label: "Labs", icon: FlaskConical },
    { id: "symptoms", label: "Symptoms", icon: Stethoscope },
    { id: "vaccines", label: "Vaccines", icon: Syringe },
    ...(item.data.settings.cycle_tracking ? [{ id: "cycle" as Sub, label: "Cycle", icon: Flower2 }] : []),
    { id: "history", label: "History", icon: HistoryIcon },
    { id: "profile", label: "Profile", icon: UserRound },
  ];
  const nav = isPhone ? (
    <ScrollRow>
      {subs.map((s) => (
        <Chip key={s.id} active={sub === s.id} onClick={() => setSub(s.id)} icon={<s.icon className="h-3.5 w-3.5" />}>
          {s.label}
        </Chip>
      ))}
    </ScrollRow>
  ) : null;

  const body =
    sub === "visits" ? (
      <Visits {...props} />
    ) : sub === "labs" ? (
      <Labs {...props} />
    ) : sub === "symptoms" ? (
      <Symptoms {...props} />
    ) : sub === "vaccines" ? (
      <Vaccines {...props} />
    ) : sub === "cycle" ? (
      <Cycle {...props} />
    ) : sub === "history" ? (
      <HistoryList {...props} />
    ) : (
      <ProfileView {...props} />
    );

  return (
    <Page wide={!isPhone}>
      <QuickLogHost item={item} />
      {isPhone ? (
        <>
          {nav}
          {body}
        </>
      ) : (
        <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-6">
          <nav aria-label="Records sections" className="flex flex-col gap-1">
            {subs.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSub(s.id)}
                aria-current={sub === s.id ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium transition",
                  sub === s.id ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
                )}
              >
                <s.icon className={cn("h-4 w-4", sub === s.id && "text-[var(--item-accent)]")} />
                {s.label}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-col gap-5">{body}</div>
        </div>
      )}
    </Page>
  );
}

/* --------------------------------------------------------------- visits */

function Visits({ item, ask }: ItemViewProps<HealthData>) {
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [adding, setAdding] = useState(false);
  const [report, setReport] = useState(false);
  const now = nowISO();
  const upcoming = item.data.appointments.filter((a) => !a.done && a.at >= now);
  const past = item.data.appointments.filter((a) => a.done || a.at < now).slice().reverse();
  const row = (a: Appointment) => (
    <ListRow
      key={a.id}
      onClick={() => setEditing(a)}
      leading={
        <span className="flex w-11 flex-col items-center rounded-lg bg-[var(--surface-2)] py-1 text-center leading-tight">
          <span className="text-[10px] font-semibold uppercase text-[var(--item-accent)]">{parseDay(a.at.slice(0, 10)).toLocaleDateString(undefined, { month: "short" })}</span>
          <span className="text-base font-semibold tabular-nums text-[var(--text)]">{Number(a.at.slice(8, 10))}</span>
        </span>
      }
      title={a.title || "Appointment"}
      subtitle={`${fmtDay(a.at.slice(0, 10))} · ${fmtTime(a.at)}${a.who ? ` · ${a.who}` : ""}`}
      trailing={a.questions.length > 0 ? <Badge color="var(--item-accent)">{a.questions.length} Qs</Badge> : a.done ? <Badge color="var(--success)">Done</Badge> : null}
    />
  );
  return (
    <>
      <Section
        title="Upcoming"
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
              Appointment
            </ItemButton>
          )
        }
      >
        {upcoming.length ? (
          <>
            <NextVisit a={upcoming[0]} onOpen={() => setEditing(upcoming[0])} />
            <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
              <ItemButton variant="primary" icon={<FileText className="h-4 w-4" />} onClick={() => setReport(true)}>
                Prepare for this visit
              </ItemButton>
              <ItemButton
                icon={<Sparkles className="h-4 w-4" />}
                onClick={() =>
                  ask(
                    `Prepare a one-page summary for my ${upcoming[0].title || "appointment"} on ${upcoming[0].at.slice(0, 10)}${upcoming[0].who ? ` with ${upcoming[0].who}` : ""} (doctor_visit_summary), and suggest questions to add to it.`,
                  )
                }
              >
                Ask for questions to bring
              </ItemButton>
            </div>
            {upcoming.length > 1 && <List>{upcoming.slice(1).map(row)}</List>}
          </>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="No upcoming appointments"
            text="Add one to get a reminder the day before and two hours before — with your questions to ask."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" icon={<FileText className="h-4 w-4" />} onClick={() => setReport(true)}>
                  Prepare for my next visit
                </ItemButton>
                <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Make me a one-page summary of the last 3 months to take to my GP")}>
                  Ask the assistant
                </ItemButton>
              </div>
            }
          />
        )}
      </Section>
      {past.length > 0 && (
        <Section title="Past">
          <List>{past.slice(0, 100).map(row)}</List>
        </Section>
      )}
      {report && <VisitReport item={item} ask={ask} onClose={() => setReport(false)} />}
      {(adding || editing) && (
        <AppointmentSheet
          item={item}
          editing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** The next appointment, up front: when (with a countdown), where, and the
 *  questions to ask — what a visit-prep screen leads with. */
function NextVisit({ a, onOpen }: { a: Appointment; onOpen: () => void }) {
  const day = a.at.slice(0, 10);
  const n = daysBetween(todayISO(), day);
  const when = n <= 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--item-accent)_40%,var(--border))] bg-[color-mix(in_srgb,var(--item-accent)_7%,var(--surface))] p-4 text-left transition hover:border-[var(--item-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
    >
      <div className="flex items-start gap-3">
        <span className="flex w-12 shrink-0 flex-col items-center rounded-xl bg-[var(--surface)] py-1.5 text-center leading-tight">
          <span className="text-[10px] font-semibold uppercase text-[var(--item-accent)]">{parseDay(day).toLocaleDateString(undefined, { month: "short" })}</span>
          <span className="text-lg font-semibold tabular-nums text-[var(--text)]">{Number(a.at.slice(8, 10))}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--item-accent)]">Next · {when}</p>
          <p className="truncate text-base font-semibold text-[var(--text)]">{a.title || "Appointment"}</p>
          <p className="truncate text-sm text-[var(--text-muted)]">
            {fmtDay(day)} · {fmtTime(a.at)}
          </p>
          {(a.who || a.location) && <p className="truncate text-xs text-[var(--text-muted)]">{[a.who, a.location].filter(Boolean).join(" · ")}</p>}
        </div>
      </div>
      {a.questions.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-3">
          <p className="text-xs font-semibold text-[var(--text-muted)]">To ask ({a.questions.length})</p>
          <ul className="flex flex-col gap-1">
            {a.questions.slice(0, 4).map((q) => (
              <li key={q} className="flex gap-2 text-sm text-[var(--text)]">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--item-accent)]" />
                <span className="min-w-0">{q}</span>
              </li>
            ))}
            {a.questions.length > 4 && <li className="pl-3.5 text-xs text-[var(--text-muted)]">+{a.questions.length - 4} more</li>}
          </ul>
        </div>
      )}
    </button>
  );
}

/* ----------------------------------------------------------------- labs */

const FLAG_COLOR: Record<LabResult["flag"], string> = {
  "": "var(--text-muted)",
  normal: "var(--success)",
  low: "var(--warning)",
  high: "var(--warning)",
  abnormal: "var(--warning)",
  critical: "var(--danger)",
};

function Labs({ item, ask }: ItemViewProps<HealthData>) {
  const [editing, setEditing] = useState<LabResult | null>(null);
  const [adding, setAdding] = useState(false);
  const labs = item.data.labs;
  const byDay = useMemo(() => {
    const m = new Map<string, LabResult[]>();
    for (const l of labs) {
      const arr = m.get(l.day);
      if (arr) arr.push(l);
      else m.set(l.day, [l]);
    }
    return [...m.entries()].sort(([a], [b]) => (a < b ? 1 : -1));
  }, [labs]);
  const history = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const l of labs) if (l.value !== null) (m[l.test.toLowerCase()] ??= []).push(l.value);
    return m;
  }, [labs]);
  const range = (l: LabResult) =>
    l.ref_low !== null || l.ref_high !== null ? `ref ${l.ref_low ?? ""}–${l.ref_high ?? ""}` : "";
  return (
    <>
      <Section
        title="Lab results"
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
              Result
            </ItemButton>
          )
        }
      >
        {byDay.length ? (
          <div className="flex flex-col gap-4">
            {byDay.slice(0, 80).map(([day, rows]) => (
              <div key={day} className="flex flex-col gap-1.5">
                <p className="px-1 text-xs font-semibold text-[var(--text-muted)]">
                  {fmtDay(day)}
                  {rows.find((r) => r.time)?.time ? ` · ${rows.find((r) => r.time)!.time}` : ""}
                  {rows[0].panel ? ` · ${[...new Set(rows.map((r) => r.panel).filter(Boolean))].join(", ")}` : ""}
                </p>
                <List>
                  {rows.map((l) => {
                    const h = history[l.test.toLowerCase()] ?? [];
                    return (
                      <ListRow
                        key={l.id}
                        onClick={item.canEdit ? () => setEditing(l) : undefined}
                        title={l.test}
                        subtitle={[range(l) || l.note, l.source].filter(Boolean).join(" · ") || undefined}
                        trailing={
                          <span className="flex items-center gap-2">
                            {h.length > 1 && <Sparkline values={h} width={48} height={20} />}
                            {l.flag && l.flag !== "normal" && <Badge color={FLAG_COLOR[l.flag]}>{l.flag}</Badge>}
                            <span className="font-semibold tabular-nums text-[var(--text)]">
                              {l.value !== null ? l.value : l.value_text} <span className="text-xs font-normal text-[var(--text-muted)]">{l.unit}</span>
                            </span>
                          </span>
                        }
                      />
                    );
                  })}
                </List>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={FlaskConical}
            title="No lab results yet"
            text="Add results with the lab's reference range — out-of-range values are flagged and each test gets its own history."
            action={<ItemButton onClick={() => ask("Log my blood results. I'm attaching the report.")}>Import from a file</ItemButton>}
          />
        )}
      </Section>
      {(adding || editing) && (
        <LabSheet
          item={item}
          editing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- symptoms */

function Symptoms({ item, ask }: ItemViewProps<HealthData>) {
  const [editing, setEditing] = useState<Symptom | null>(null);
  const [adding, setAdding] = useState(false);
  const since = addDays(todayISO(), -29);
  const summary = useMemo(() => {
    const m = new Map<string, { name: string; n: number; sum: number; worst: number }>();
    for (const s of item.data.symptoms) {
      if (s.at.slice(0, 10) < since) continue;
      const k = s.name.toLowerCase();
      const cur = m.get(k) ?? { name: s.name, n: 0, sum: 0, worst: 0 };
      cur.n += 1;
      cur.sum += s.severity;
      cur.worst = Math.max(cur.worst, s.severity);
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  }, [item.data.symptoms, since]);
  const recent = item.data.symptoms.slice(-200).reverse();
  return (
    <>
      {summary.length > 0 && (
        <Section title="Last 30 days" hint="How often, and how bad on average">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {summary.map((s) => (
              <Card key={s.name} className="flex flex-col gap-1">
                <p className="truncate text-sm font-semibold text-[var(--text)]">{s.name}</p>
                <p className="text-xs tabular-nums text-[var(--text-muted)]">
                  {s.n}× · avg {(s.sum / s.n).toFixed(1)} · worst {s.worst}
                </p>
              </Card>
            ))}
          </div>
          <ItemButton icon={<Sparkles className="h-4 w-4" />} className="self-start" onClick={() => ask(`Look for patterns in my ${summary[0].name.toLowerCase()} — what tends to come before it (sleep, food, tags, cycle)?`)}>
            Find patterns
          </ItemButton>
        </Section>
      )}
      <Section
        title="Symptom log"
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
              Symptom
            </ItemButton>
          )
        }
      >
        {recent.length ? (
          <List>
            {recent.map((s) => (
              <ListRow
                key={s.id}
                onClick={item.canEdit ? () => setEditing(s) : undefined}
                title={s.name}
                subtitle={`${fmtDay(s.at.slice(0, 10))} ${fmtTime(s.at)}${s.tags.length ? ` · ${s.tags.join(", ")}` : ""}`}
                trailing={<Badge color={s.severity >= 8 ? "var(--danger)" : s.severity >= 5 ? "var(--warning)" : "var(--success)"}>{s.severity}/10</Badge>}
              />
            ))}
          </List>
        ) : (
          <EmptyState icon={Stethoscope} title="No symptoms logged" text="Log how you feel with a severity and possible triggers — patterns show up over a few weeks." />
        )}
      </Section>
      {(adding || editing) && (
        <SymptomSheet
          item={item}
          editing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------- vaccines */

function Vaccines({ item }: ItemViewProps<HealthData>) {
  const [editing, setEditing] = useState<Vaccination | null>(null);
  const [adding, setAdding] = useState(false);
  const today = todayISO();
  const due = item.data.vaccinations.filter((v) => v.next_due && v.next_due <= addDays(today, 60));
  return (
    <>
      {due.length > 0 && (
        <Card className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-[var(--text)]">Due soon</p>
          {due.map((v) => (
            <p key={v.id} className="text-sm text-[var(--text-muted)]">
              {v.name} · {v.next_due! < today ? "overdue since" : "due"} {fmtDay(v.next_due!)}
            </p>
          ))}
        </Card>
      )}
      <Section
        title="Vaccinations"
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
              Vaccination
            </ItemButton>
          )
        }
      >
        {item.data.vaccinations.length ? (
          <List>
            {item.data.vaccinations
              .slice()
              .reverse()
              .map((v) => (
                <ListRow
                  key={v.id}
                  onClick={item.canEdit ? () => setEditing(v) : undefined}
                  leading={<Syringe className="h-4 w-4 text-[var(--item-accent)]" />}
                  title={`${v.name}${v.dose_label ? ` · ${v.dose_label}` : ""}`}
                  subtitle={`${v.day}${v.next_due ? ` · next ${v.next_due}` : ""}`}
                />
              ))}
          </List>
        ) : (
          <EmptyState icon={Syringe} title="No vaccinations recorded" text="Keep your record in one place — and set when the next booster is due." />
        )}
      </Section>
      {(adding || editing) && (
        <VaxSheet
          item={item}
          editing={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------------- cycle */

const FLOWS: { value: Flow | "none"; label: string }[] = [
  { value: "none", label: "None" },
  { value: "spotting", label: "Spotting" },
  { value: "light", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "heavy", label: "Heavy" },
];
const FLOW_MIX: Record<Flow, number> = { spotting: 25, light: 50, medium: 75, heavy: 100 };

function Cycle({ item }: ItemViewProps<HealthData>) {
  const today = todayISO();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [pick, setPick] = useState<string | null>(null);
  const fc = useMemo(() => cycleForecast(item.data.periods, today), [item.data.periods, today]);
  const byDay = useMemo(() => new Map(item.data.periods.map((p) => [p.day, p.flow])), [item.data.periods]);
  const first = parseDay(`${month}-01`);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: lead + daysIn }, (_, i) => (i < lead ? null : `${month}-${String(i - lead + 1).padStart(2, "0")}`));
  const predicted = (d: string) => fc && d >= fc.nextPeriod && d < addDays(fc.nextPeriod, fc.avgPeriod);
  const fertile = (d: string) => fc && d >= fc.fertile[0] && d <= fc.fertile[1];
  const shift = (n: number) => {
    const d = new Date(first);
    d.setMonth(d.getMonth() + n);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const setFlow = (day: string, flow: Flow | "none") =>
    item.update((d) => {
      d.periods = d.periods.filter((p) => p.day !== day);
      if (flow !== "none") d.periods.push({ day, flow });
      d.periods.sort((a, b) => (a.day < b.day ? -1 : 1));
    });

  return (
    <>
      {fc ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card>
            <p className="text-xs text-[var(--text-muted)]">Cycle day</p>
            <p className="text-2xl font-semibold tabular-nums text-[var(--text)]">{fc.cycleDay}</p>
          </Card>
          <Card>
            <p className="text-xs text-[var(--text-muted)]">Next period</p>
            <p className="text-lg font-semibold text-[var(--text)]">{fmtDay(fc.nextPeriod)}</p>
            <p className="text-xs text-[var(--text-muted)]">{fc.daysUntilNext >= 0 ? `in ${fc.daysUntilNext} d` : `${-fc.daysUntilNext} d late`}</p>
          </Card>
          <Card>
            <p className="text-xs text-[var(--text-muted)]">Fertile window</p>
            <p className="text-sm font-semibold text-[var(--text)]">
              {fmtDay(fc.fertile[0])} – {fmtDay(fc.fertile[1])}
            </p>
          </Card>
          <Card>
            <p className="text-xs text-[var(--text-muted)]">Average</p>
            <p className="text-sm font-semibold tabular-nums text-[var(--text)]">
              {fc.avgCycle} d cycle · {fc.avgPeriod} d period
            </p>
          </Card>
        </div>
      ) : (
        <EmptyState icon={Flower2} title="Log your period" text="Tap the days on the calendar. After a couple of cycles you'll see predictions." />
      )}
      <Card className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <ItemButton variant="ghost" size="sm" aria-label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </ItemButton>
          <p className="text-sm font-semibold text-[var(--text)]">{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
          <ItemButton variant="ghost" size="sm" aria-label="Next month" onClick={() => shift(1)}>
            <ChevronRight className="h-4 w-4" />
          </ItemButton>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-[var(--text-muted)]">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const flow = byDay.get(d);
            return (
              <button
                key={d}
                type="button"
                disabled={!item.canEdit || d > today}
                onClick={() => setPick(d)}
                aria-label={`${d}${flow ? `, ${flow} flow` : ""}${predicted(d) ? ", predicted period" : ""}${fertile(d) ? ", fertile window estimate" : ""}`}
                className={cn(
                  "flex aspect-square items-center justify-center rounded-xl text-sm tabular-nums transition disabled:cursor-default",
                  d === today && "ring-2 ring-[var(--item-accent)]",
                  !flow && predicted(d) && "border-2 border-dashed border-[var(--item-accent)]",
                  flow ? "font-semibold text-white" : "text-[var(--text)] hover:bg-[var(--hover)]",
                )}
                style={
                  flow
                    ? { background: `color-mix(in srgb, var(--item-accent) ${FLOW_MIX[flow]}%, var(--surface-2))` }
                    : fertile(d)
                      ? { background: "color-mix(in srgb, var(--success) 14%, transparent)" }
                      : undefined
                }
              >
                {Number(d.slice(8))}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded" style={{ background: "var(--item-accent)" }} /> Period
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded border border-dashed border-[var(--item-accent)]" /> Predicted
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded" style={{ background: "color-mix(in srgb, var(--success) 30%, transparent)" }} /> Fertile (estimate)
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)]">Predictions are calendar estimates from your past cycles — not a form of contraception.</p>
      </Card>
      {pick && (
        <Sheet open onClose={() => setPick(null)} title={fmtDay(pick, { long: true })} size="sm">
          <Field label="Flow">
            <Segmented
              size="sm"
              value={(byDay.get(pick) ?? "none") as Flow | "none"}
              onChange={(v) => {
                setFlow(pick, v);
                setPick(null);
              }}
              options={FLOWS}
            />
          </Field>
          {!byDay.get(pick) && (
            <ItemButton
              className="mt-3"
              block
              onClick={() => {
                const start = pick;
                item.update((d) => {
                  for (let i = 0; i < (fc?.avgPeriod ?? 5); i++) {
                    const day = addDays(start, i);
                    if (day > today) break;
                    if (!d.periods.some((p) => p.day === day)) d.periods.push({ day, flow: i === 0 || i > 2 ? "light" : "medium" });
                  }
                  d.periods.sort((a, b) => (a.day < b.day ? -1 : 1));
                });
                setPick(null);
              }}
            >
              Period started this day
            </ItemButton>
          )}
        </Sheet>
      )}
    </>
  );
}

/* -------------------------------------------------------------- history */

type HRow = { kind: "reading"; r: Reading } | { kind: "symptom"; s: Symptom } | { kind: "day"; day: string };

function HistoryList({ item }: ItemViewProps<HealthData>) {
  const data = item.data;
  const [filter, setFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Reading | null>(null);
  const [editingSym, setEditingSym] = useState<Symptom | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const metricsUsed = useMemo(() => [...new Set(data.readings.map((r) => r.metric))], [data.readings]);

  const rows = useMemo<HRow[]>(() => {
    const items: { at: string; row: HRow }[] = [];
    if (filter !== "symptoms") for (const r of data.readings) if (filter === "all" || r.metric === filter) items.push({ at: r.at, row: { kind: "reading", r } });
    if (filter === "all" || filter === "symptoms") for (const s of data.symptoms) items.push({ at: s.at, row: { kind: "symptom", s } });
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const out: HRow[] = [];
    let day = "";
    for (const it of items) {
      const d = it.at.slice(0, 10);
      if (d !== day) {
        out.push({ kind: "day", day: d });
        day = d;
      }
      out.push(it.row);
    }
    return out;
  }, [data.readings, data.symptoms, filter]);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: (i) => (rows[i].kind === "day" ? 32 : 56), overscan: 12 });

  return (
    <Section title="History" hint={`${data.readings.length.toLocaleString()} readings · ${data.symptoms.length.toLocaleString()} symptoms`}>
      <ScrollRow>
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </Chip>
        {metricsUsed.map((m) => (
          <Chip key={m} active={filter === m} onClick={() => setFilter(m)}>
            {metricDef(data, m)?.label ?? m}
          </Chip>
        ))}
        {data.symptoms.length > 0 && (
          <Chip active={filter === "symptoms"} onClick={() => setFilter("symptoms")}>
            Symptoms
          </Chip>
        )}
      </ScrollRow>
      {rows.length ? (
        <div ref={scroller} className="h-[65dvh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
                  {row.kind === "day" ? (
                    <p className="bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold text-[var(--text-muted)]">{fmtDay(row.day, { long: true })}</p>
                  ) : row.kind === "symptom" ? (
                    <ListRow
                      onClick={item.canEdit ? () => setEditingSym(row.s) : undefined}
                      leading={<Stethoscope className="h-4 w-4 text-[var(--item-accent)]" />}
                      title={row.s.name}
                      subtitle={fmtTime(row.s.at)}
                      trailing={<span className="font-semibold tabular-nums text-[var(--text)]">{row.s.severity}/10</span>}
                    />
                  ) : (
                    <ReadingRow item={item} r={row.r} onEdit={() => setEditing(row.r)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState icon={HistoryIcon} title="Nothing here yet" text="Everything you log appears here, newest first — tap any entry to fix or delete it." />
      )}
      {editing && <LogSheet item={item} metric={editing.metric} editing={editing} onClose={() => setEditing(null)} />}
      {editingSym && <SymptomSheet item={item} editing={editingSym} onClose={() => setEditingSym(null)} />}
    </Section>
  );
}

function ReadingRow({ item, r, onEdit }: { item: ItemHandle<HealthData>; r: Reading; onEdit: () => void }) {
  const m = metricDef(item.data, r.metric);
  if (!m) return <ListRow title={r.metric} subtitle={fmtTime(r.at)} />;
  const s = item.data.settings;
  const cat = m.kind === "bp" ? bpCategory(r.sys, r.dia) : null;
  const val =
    m.kind === "bp"
      ? `${r.sys}/${r.dia}`
      : m.kind === "scale" && r.value
        ? `${SCALE_FACES[r.value - 1]} ${r.value}/5`
        : m.kind === "sleep" && r.value === null
          ? `Quality ${r.quality}/5`
          : fmtMetric(m, r.value, s);
  return (
    <ListRow
      onClick={item.canEdit ? onEdit : undefined}
      leading={<m.icon className="h-4 w-4 text-[var(--item-accent)]" />}
      title={m.label}
      subtitle={`${fmtTime(r.at)}${r.context ? ` · ${r.context.replace("_", " ")}` : ""}${r.note ? ` · ${r.note}` : ""}`}
      trailing={
        <span className="flex items-center gap-2">
          {cat && <Badge color={cat.color}>{cat.label.replace("Hypertension ", "")}</Badge>}
          <span className="font-semibold tabular-nums text-[var(--text)]">{val}</span>
        </span>
      }
    />
  );
}
