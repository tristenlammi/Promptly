import { Check, Sparkles } from "lucide-react";
import { useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { ItemButton, Page, Select } from "@/items/ui";
import { cn } from "@/utils/cn";

import { WEEKDAY_NAMES } from "./engine";
import type { HabitsData } from "./types";
import { IDEAS, habitFromIdea } from "./util";

/** First run: pick 1–3 tiny habits (or design them with the coach), the day boundary and week start. */
export function Onboarding({ item, ask }: ItemViewProps<HabitsData>) {
  const [picked, setPicked] = useState<string[]>([]);
  const [dayEnd, setDayEnd] = useState(item.data.settings.day_ends_at);
  const [weekStart, setWeekStart] = useState(item.data.settings.week_start);
  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

  const finish = (withIdeas: boolean) => {
    // Habits (ids, created_at) are made outside the mutator; it only adds them.
    const made: ReturnType<typeof habitFromIdea>[] = [];
    if (withIdeas) {
      for (const idea of IDEAS.filter((i) => picked.includes(i.name))) {
        const h = habitFromIdea({ ...item.data, habits: [...item.data.habits, ...made] }, idea);
        made.push(h);
      }
    }
    item.update((d) => {
      d.settings.day_ends_at = dayEnd;
      d.settings.week_start = weekStart;
      d.settings.onboarded = true;
      for (const h of made) if (!d.habits.some((x) => x.id === h.id)) d.habits.push(structuredClone(h));
    });
  };

  return (
    <Page>
      <div className="flex flex-col gap-1 pt-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">Small habits, big change</h1>
        <p className="mx-auto max-w-md text-sm text-[var(--text-muted)]">
          Start with one to three habits so small they're hard to skip. Each comes with a plan — <em>“After I …, I will …”</em> — which roughly doubles follow-through.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {IDEAS.map((idea) => {
          const on = picked.includes(idea.name);
          return (
            <button
              key={idea.name}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(idea.name)}
              className={cn(
                "flex min-h-[64px] items-center gap-3 rounded-2xl border bg-[var(--surface)] px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                on ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,var(--surface))]" : "border-[var(--border)] hover:border-[var(--item-accent)]",
              )}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xl" style={{ background: `color-mix(in srgb, ${idea.color} 16%, transparent)` }} aria-hidden>
                {idea.emoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--text)]">{idea.name}</span>
                <span className="line-clamp-2 block text-xs text-[var(--text-muted)]">{idea.intention}</span>
              </span>
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)]")}>
                {on && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          );
        })}
      </div>
      {picked.length > 3 && <p className="text-center text-xs text-[var(--warning)]">That's {picked.length} — most people do best with 1–3 to start. You can always add more later.</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">My day ends at</span>
          <Select value={dayEnd} onChange={(e) => setDayEnd(Number(e.target.value))}>
            {[0, 1, 2, 3, 4, 5, 6].map((h) => (
              <option key={h} value={h}>
                {h === 0 ? "Midnight" : `${h}:00 am (night owl)`}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Weeks start on</span>
          <Select value={weekStart} onChange={(e) => setWeekStart(Number(e.target.value))}>
            {[0, 6, 5].map((d) => (
              <option key={d} value={d}>
                {WEEKDAY_NAMES[d]}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div
        className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-[var(--border)] bg-[var(--bg)] px-4 pb-[calc(12px+env(safe-area-inset-bottom,0px))] pt-3 md:static md:mx-0 md:flex-row md:border-0 md:px-0"
        // The shell pads its scroller for a phone tab bar that first-run
        // setup doesn't show; sit in that padding instead of 64px above
        // the screen edge with the list peeking out underneath.
      >
        <ItemButton variant="primary" size="lg" block disabled={!picked.length} onClick={() => finish(true)}>
          {picked.length ? `Start with ${picked.length} habit${picked.length === 1 ? "" : "s"}` : "Pick a habit to start"}
        </ItemButton>
        <div className="flex items-center gap-2 md:contents">
          <ItemButton
            size="lg"
            className="min-w-0 flex-1 md:w-full"
            icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />}
            onClick={() => {
              finish(false);
              ask("Help me design my first 1–3 habits. Ask me one question about my goals and my daily routine first, then create them with cues.");
            }}
          >
            Design with the coach
          </ItemButton>
          <button type="button" className="h-12 shrink-0 rounded-xl px-3 text-sm text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]" onClick={() => finish(false)}>
            Start empty
          </button>
        </div>
      </div>
    </Page>
  );
}
