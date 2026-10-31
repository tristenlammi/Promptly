import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, ItemButton, Select, Sheet, Stepper, TextInput, Toggle } from "@/items/ui";

import { DEFAULT_WEIGHTS } from "./fsrs";
import type { Data, Settings } from "./types";

const stepsText = (v: number[]) => v.map((m) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440}d` : m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join(" ");

function parseSteps(s: string): number[] | null {
  const out: number[] = [];
  for (const tok of s.split(/[\s,]+/).filter(Boolean)) {
    const m = tok.match(/^(\d+(?:\.\d+)?)([smhd]?)$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || "m").toLowerCase();
    const minutes = unit === "s" ? n / 60 : unit === "h" ? n * 60 : unit === "d" ? n * 1440 : n;
    if (minutes <= 0 || minutes > 10080) return null;
    out.push(Math.round(minutes * 100) / 100);
  }
  return out.length <= 10 ? out : null;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]">{label}</p>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsSheet({ item, open, onClose, ask }: { item: ItemHandle<Data>; open: boolean; onClose: () => void; ask?: (p: string) => void }) {
  const s = item.data.settings;
  const set = (patch: Partial<Settings>) =>
    item.update((d) => {
      Object.assign(d.settings, patch);
    });
  const [learn, setLearn] = useState("");
  const [relearn, setRelearn] = useState("");
  useEffect(() => {
    if (open) {
      setLearn(stepsText(s.learning_steps));
      setRelearn(stepsText(s.relearning_steps));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const ro = !item.canEdit;
  const ret = Math.round(s.desired_retention * 100);
  const load = ret >= 95 ? "about twice the reviews of 90%" : ret >= 92 ? "noticeably more reviews" : ret >= 88 ? "the sweet spot" : ret >= 82 ? "fewer reviews, more forgetting" : "you'll forget a lot";
  const customWeights = s.weights.some((w, i) => Math.abs(w - DEFAULT_WEIGHTS[i]) > 1e-9);
  return (
    <Sheet open={open} onClose={onClose} title="Study settings" size="lg">
      <fieldset disabled={ro} className="flex flex-col divide-y divide-[var(--border)]">
        <div className="flex flex-col gap-2 pb-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium text-[var(--text)]">Desired retention</p>
            <p className="text-lg font-semibold tabular-nums text-[var(--item-accent)]">{ret}%</p>
          </div>
          <input
            type="range"
            min={70}
            max={99}
            step={1}
            value={ret}
            aria-label="Desired retention"
            onChange={(e) => set({ desired_retention: Number(e.target.value) / 100 })}
            className="w-full accent-[var(--item-accent)]"
          />
          <p className="text-xs text-[var(--text-muted)]">
            How likely you are to remember a card when it comes due — {load}. FSRS schedules each card to hit this.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 py-4">
          <Stepper label="New cards / day" value={s.new_per_day} onChange={(v) => set({ new_per_day: v })} step={5} min={0} max={9999} />
          <Stepper label="Max reviews / day" value={s.max_reviews_per_day} onChange={(v) => set({ max_reviews_per_day: v })} step={50} min={0} max={99999} />
        </div>
        <div className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-2">
          <Field label="Learning steps" hint="e.g. 1m 10m — before a new card graduates">
            <TextInput
              value={learn}
              onChange={(e) => setLearn(e.target.value)}
              onBlur={() => {
                const v = parseSteps(learn);
                if (v) set({ learning_steps: v });
                else setLearn(stepsText(s.learning_steps));
              }}
            />
          </Field>
          <Field label="Relearning steps" hint="after you forget a card (empty = none)">
            <TextInput
              value={relearn}
              onChange={(e) => setRelearn(e.target.value)}
              onBlur={() => {
                const v = parseSteps(relearn);
                if (v) set({ relearning_steps: v });
                else setRelearn(stepsText(s.relearning_steps));
              }}
            />
          </Field>
        </div>
        <div className="py-2">
          <Row label="New cards" hint="Where new cards go among reviews">
            <Select value={s.new_mix} onChange={(e) => set({ new_mix: e.target.value as Settings["new_mix"] })} className="w-40">
              <option value="mixed">Mixed in</option>
              <option value="before">Before reviews</option>
              <option value="after">After reviews</option>
            </Select>
          </Row>
          <Row label="Next day starts at" hint="Late-night study counts for the day before">
            <Select value={s.rollover_hour} onChange={(e) => set({ rollover_hour: Number(e.target.value) })} className="w-28">
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Maximum interval" hint="Days">
            <TextInput
              type="number"
              inputMode="numeric"
              min={1}
              max={36500}
              value={s.maximum_interval}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (v >= 1 && v <= 36500) set({ maximum_interval: v });
              }}
              className="w-28 text-right"
            />
          </Row>
          <Row label="Fuzz intervals" hint="Spreads cards added together across days">
            <Toggle checked={s.fuzz} onChange={(v) => set({ fuzz: v })} label="Fuzz intervals" />
          </Row>
          <Row label="Bury siblings" hint="One side / cloze of a card per day">
            <Toggle checked={s.bury_siblings} onChange={(v) => set({ bury_siblings: v })} label="Bury siblings" />
          </Row>
          <Row label="Show next intervals" hint="On the answer buttons">
            <Toggle checked={s.show_intervals} onChange={(v) => set({ show_intervals: v })} label="Show next intervals" />
          </Row>
          <Row label="Leech after" hint="Lapses before a card is flagged as a leech">
            <div className="flex items-center gap-2">
              <Select value={s.leech_threshold} onChange={(e) => set({ leech_threshold: Number(e.target.value) })} className="w-20">
                {[4, 6, 8, 10, 12, 16].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <Select value={s.leech_action} onChange={(e) => set({ leech_action: e.target.value as Settings["leech_action"] })} className="w-28">
                <option value="tag">Tag it</option>
                <option value="suspend">Suspend</option>
              </Select>
            </div>
          </Row>
        </div>
        <div className="py-2">
          <Row label="Daily reminder" hint="Only when cards are due">
            <div className="flex items-center gap-2">
              <TextInput type="time" value={s.reminder_time} onChange={(e) => e.target.value && set({ reminder_time: e.target.value })} className="w-28" aria-label="Reminder time" />
              <Toggle checked={s.reminder_enabled} onChange={(v) => set({ reminder_enabled: v })} label="Daily reminder" />
            </div>
          </Row>
          <Row label="Streak nudge" hint="An evening nudge if you haven't studied">
            <div className="flex items-center gap-2">
              <TextInput type="time" value={s.streak_nudge_time} onChange={(e) => e.target.value && set({ streak_nudge_time: e.target.value })} className="w-28" aria-label="Streak nudge time" />
              <Toggle checked={s.streak_nudge} onChange={(v) => set({ streak_nudge: v })} label="Streak nudge" />
            </div>
          </Row>
          <Row label="Exam date" hint="The assistant plans around it">
            <TextInput type="date" value={s.exam_date ?? ""} onChange={(e) => set({ exam_date: e.target.value || null })} className="w-40" aria-label="Exam date" />
          </Row>
        </div>
        <div className="flex flex-col gap-2 pt-4">
          <p className="text-xs text-[var(--text-muted)]">
            Scheduler: FSRS-6 with {customWeights ? "custom" : "default"} weights.
            {customWeights && (
              <button type="button" className="ml-1 font-medium text-[var(--item-accent)]" onClick={() => set({ weights: [...DEFAULT_WEIGHTS] })}>
                Reset to defaults
              </button>
            )}
          </p>
          {ask && (
            <ItemButton size="sm" variant="ghost" className="self-start" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => { onClose(); ask("Look at my stats and suggest the right desired retention and daily limits for me."); }}>
              Tune these for me
            </ItemButton>
          )}
        </div>
      </fieldset>
    </Sheet>
  );
}
