import type { Repeat, RepeatFreq } from "@/api/calendar";
import { Field, Select, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { addMonths, fmt, WEEKDAYS_MON, weekdayIndexMon, ymd } from "../dates";
import { nthWeekday } from "../model";

type Preset = "none" | "daily" | "weekly" | "monthly-day" | "monthly-weekday" | "yearly" | "weekdays" | "custom";

function presetOf(r: Repeat | null, start: Date): Preset {
  if (!r) return "none";
  const n = r.interval ?? 1;
  if (n !== 1 || r.until || r.count) return "custom";
  const wd = weekdayIndexMon(start);
  switch (r.freq) {
    case "daily":
      return "daily";
    case "weekly": {
      const days = r.weekdays ?? [];
      if (!days.length || (days.length === 1 && days[0] === wd)) return "weekly";
      if (days.length === 5 && [0, 1, 2, 3, 4].every((d) => days.includes(d))) return "weekdays";
      return "custom";
    }
    case "monthly":
      return r.monthly === "weekday" ? "monthly-weekday" : "monthly-day";
    case "yearly":
      return "yearly";
  }
}

function fromPreset(p: Preset, start: Date): Repeat | null {
  const wd = weekdayIndexMon(start);
  switch (p) {
    case "none":
      return null;
    case "daily":
      return { freq: "daily" };
    case "weekly":
      return { freq: "weekly", weekdays: [wd] };
    case "monthly-day":
      return { freq: "monthly" };
    case "monthly-weekday":
      return { freq: "monthly", monthly: "weekday" };
    case "yearly":
      return { freq: "yearly" };
    case "weekdays":
      return { freq: "weekly", weekdays: [0, 1, 2, 3, 4] };
    case "custom":
      return { freq: "weekly", interval: 1, weekdays: [wd] };
  }
}

/** The "Repeat" select, with a custom panel for interval / weekdays / end. */
export function RepeatPicker({ value, onChange, start, custom, onCustom }: { value: Repeat | null; onChange: (r: Repeat | null) => void; start: Date; custom: boolean; onCustom: (on: boolean) => void }) {
  const preset = custom ? "custom" : presetOf(value, start);
  const wdName = WEEKDAYS_MON[weekdayIndexMon(start)].long;

  return (
    <div className="flex flex-col gap-3">
      <Field label="Repeat">
        <Select
          value={preset}
          onChange={(e) => {
            const p = e.target.value as Preset;
            onCustom(p === "custom");
            if (p === "custom") onChange(value ? { ...value } : fromPreset("custom", start));
            else onChange(fromPreset(p, start));
          }}
        >
          <option value="none">Doesn't repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly on {wdName}</option>
          <option value="monthly-day">Monthly on day {start.getDate()}</option>
          <option value="monthly-weekday">Monthly on the {nthWeekday(start)}</option>
          <option value="yearly">Yearly on {fmt(start, { month: "long", day: "numeric" })}</option>
          <option value="weekdays">Every weekday (Mon–Fri)</option>
          <option value="custom">Custom…</option>
        </Select>
      </Field>
      {preset === "custom" && value && <CustomRepeat value={value} onChange={onChange} start={start} />}
    </div>
  );
}

function CustomRepeat({ value, onChange, start }: { value: Repeat; onChange: (r: Repeat) => void; start: Date }) {
  const set = (patch: Partial<Repeat>) => onChange({ ...value, ...patch });
  const unit: Record<RepeatFreq, string> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
  const n = value.interval ?? 1;
  const ends = value.until ? "on" : value.count ? "after" : "never";
  const days = value.weekdays?.length ? value.weekdays : [weekdayIndexMon(start)];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center gap-2 text-sm text-[var(--text)]">
        <span>Every</span>
        <TextInput
          type="number"
          min={1}
          max={99}
          value={n}
          onChange={(e) => set({ interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
          className="!w-16 text-center"
          aria-label="Repeat every"
        />
        <Select
          value={value.freq}
          onChange={(e) => {
            const freq = e.target.value as RepeatFreq;
            set({ freq, weekdays: freq === "weekly" ? days : undefined, monthly: freq === "monthly" ? value.monthly : undefined });
          }}
          className="!w-auto"
          aria-label="Repeat unit"
        >
          {(Object.keys(unit) as RepeatFreq[]).map((f) => (
            <option key={f} value={f}>
              {unit[f]}
              {n > 1 ? "s" : ""}
            </option>
          ))}
        </Select>
      </div>

      {value.freq === "weekly" && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">On</span>
          <div className="flex gap-1">
            {WEEKDAYS_MON.map((w, i) => {
              const on = days.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  aria-pressed={on}
                  aria-label={w.long}
                  onClick={() => {
                    const next = on ? days.filter((d) => d !== i) : [...days, i].sort();
                    if (next.length) set({ weekdays: next });
                  }}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold transition",
                    on ? "bg-[var(--item-accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]",
                  )}
                >
                  {w.narrow}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {value.freq === "monthly" && (
        <Select value={value.monthly ?? "day"} onChange={(e) => set({ monthly: e.target.value as "day" | "weekday" })} aria-label="Monthly on">
          <option value="day">On day {start.getDate()}</option>
          <option value="weekday">On the {nthWeekday(start)}</option>
        </Select>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-muted)]">Ends</span>
        <label className="flex h-9 items-center gap-2 text-sm text-[var(--text)]">
          <input type="radio" name="cal-ends" checked={ends === "never"} onChange={() => set({ until: undefined, count: undefined })} className="h-4 w-4 accent-[var(--item-accent)]" />
          Never
        </label>
        <label className="flex min-h-9 items-center gap-2 text-sm text-[var(--text)]">
          <input
            type="radio"
            name="cal-ends"
            checked={ends === "on"}
            onChange={() => set({ until: ymd(addMonths(start, 3)), count: undefined })}
            className="h-4 w-4 accent-[var(--item-accent)]"
          />
          On
          <TextInput
            type="date"
            value={value.until ?? ""}
            min={ymd(start)}
            disabled={ends !== "on"}
            onChange={(e) => e.target.value && set({ until: e.target.value, count: undefined })}
            className="!h-9 !w-auto disabled:opacity-50"
            aria-label="End date"
          />
        </label>
        <label className="flex min-h-9 items-center gap-2 text-sm text-[var(--text)]">
          <input type="radio" name="cal-ends" checked={ends === "after"} onChange={() => set({ count: 10, until: undefined })} className="h-4 w-4 accent-[var(--item-accent)]" />
          After
          <TextInput
            type="number"
            min={1}
            max={999}
            value={value.count ?? 10}
            disabled={ends !== "after"}
            onChange={(e) => set({ count: Math.max(1, Math.min(999, Number(e.target.value) || 1)), until: undefined })}
            className="!h-9 !w-20 text-center disabled:opacity-50"
            aria-label="Number of times"
          />
          times
        </label>
      </div>
    </div>
  );
}
