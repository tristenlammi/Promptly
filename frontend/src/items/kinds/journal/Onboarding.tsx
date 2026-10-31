import { BellRing, BookOpen, Lock, Sparkles } from "lucide-react";
import { useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { ItemButton, Select, TextInput, Toggle } from "@/items/ui";

import type { JournalData } from "./types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/* A short first run: when to be reminded, and what stays private. */
export function Onboarding({ item }: ItemViewProps<JournalData>) {
  const [daily, setDaily] = useState(true);
  const [time, setTime] = useState("21:00");
  const [weekly, setWeekly] = useState(true);
  const [day, setDay] = useState(6);

  const finish = (withReminders: boolean) =>
    item.update((d) => {
      Object.assign(d.settings, {
        onboarded: true,
        daily_reminder: withReminders && daily,
        reminder_time: time,
        weekly_reminder: withReminders && weekly,
        weekly_day: day,
      });
    });

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-5 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] text-[var(--item-accent)]">
          <BookOpen className="h-8 w-8" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">A quiet place to write</h1>
        <p className="text-[15px] leading-relaxed text-[var(--text-muted)]">
          A few minutes a day is enough. Write freely, name how you feel, and look back on what matters.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center gap-3">
          <BellRing className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--text)]">Daily reminder</p>
            <p className="text-xs text-[var(--text-muted)]">Skipped if you've already written that day</p>
          </div>
          <Toggle label="Daily reminder" checked={daily} onChange={setDaily} />
        </div>
        {daily && <TextInput type="time" value={time} onChange={(e) => e.target.value && setTime(e.target.value.slice(0, 5))} aria-label="Reminder time" />}
        <div className="flex items-center gap-3 border-t border-[var(--border)] pt-3">
          <Sparkles className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--text)]">Weekly reflection</p>
            <p className="text-xs text-[var(--text-muted)]">Look back on the week, once a week</p>
          </div>
          <Toggle label="Weekly reflection" checked={weekly} onChange={setWeekly} />
        </div>
        {weekly && (
          <Select value={day} onChange={(e) => setDay(Number(e.target.value))} aria-label="Reflection day">
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d} evenings
              </option>
            ))}
          </Select>
        )}
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-[var(--text-muted)]">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Only you can open this journal unless you share the file. Other chats and search in Promptly see just an outline — dates, titles, moods and tags — not what you wrote. This journal's own assistant does read your entries, and sends them to the AI model your server uses (a cloud provider, if that's how it's set up). Your server's admins can technically read stored data.
      </p>

      <div className="flex flex-col gap-2">
        <ItemButton variant="primary" size="lg" block onClick={() => finish(true)}>
          Start writing
        </ItemButton>
        <ItemButton variant="ghost" block onClick={() => finish(false)}>
          Skip reminders for now
        </ItemButton>
      </div>
    </div>
  );
}
