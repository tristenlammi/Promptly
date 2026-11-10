import { BellRing } from "lucide-react";

import { usePushSubscription } from "@/hooks/usePushSubscription";
import type { ItemViewProps } from "@/items/types";
import { Card, Field, ItemButton, Page, Section, Segmented, TextInput, Toggle } from "@/items/ui";

import type { Settings, TasksData } from "./types";

/* Settings: reminders (this device's push, default times, the morning
 * morning summary), the week, and a cheat sheet for quick add. */
export function SettingsView({ item }: ItemViewProps<TasksData>) {
  const s = item.data.settings;
  const set = (fn: (st: Settings) => void) => item.update((d) => fn(d.settings));
  const push = usePushSubscription();
  const ro = !item.canEdit;
  return (
    <Page className="tasks-scope max-w-2xl">
      <h1 className="text-xl font-semibold text-[var(--text)]">Settings</h1>

      <Section title="Reminders">
        <Card className="flex flex-col gap-4">
          {push.supported && (
            <div className="flex items-center gap-3">
              <BellRing className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium text-[var(--text)]">Push on this device</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {push.subscribed ? "On — reminders pop up here." : push.permission === "denied" ? "Blocked in the browser's site settings." : "Off — reminders only reach your inbox."}
                </p>
              </div>
              {!push.subscribed && push.permission !== "denied" && push.serverConfigured !== false && (
                <ItemButton size="sm" variant="primary" disabled={push.loading} onClick={() => void push.subscribe()}>
                  Turn on
                </ItemButton>
              )}
            </div>
          )}
          <fieldset disabled={ro} className="flex flex-col gap-4">
            <Row label="Remind me at the time" hint="A task given a time gets an at-the-time reminder.">
              <Toggle label="Remind me at the time" checked={s.alert_timed} onChange={(v) => set((st) => void (st.alert_timed = v))} />
            </Row>
            <Field label="All-day tasks remind at" hint="When an all-day task has a reminder, this is when it goes off.">
              <TextInput type="time" value={s.default_time} onChange={(e) => e.target.value && set((st) => void (st.default_time = e.target.value))} className="max-w-[10rem]" />
            </Field>
            <Row label="Morning summary" hint="One push each morning with your day — tasks due and overdue, plus your events, workout and more. Opens Today.">
              <Toggle label="Morning summary" checked={s.digest} onChange={(v) => set((st) => void (st.digest = v))} />
            </Row>
            {s.digest && (
              <Field label="Send at">
                <TextInput type="time" value={s.digest_time} onChange={(e) => e.target.value && set((st) => void (st.digest_time = e.target.value))} className="max-w-[10rem]" />
              </Field>
            )}
          </fieldset>
        </Card>
      </Section>

      <Section title="Week">
        <Card>
          <fieldset disabled={ro}>
            <Row label="Week starts on" hint="Used for “next week”.">
              <Segmented size="sm" value={String(s.week_start) as "0"} onChange={(v) => set((st) => void (st.week_start = Number(v)))} options={[{ value: "0", label: "Mon" }, { value: "6", label: "Sun" }]} />
            </Row>
          </fieldset>
        </Card>
      </Section>

      <Section title="Typing tasks" hint="Just type it the way you'd say it. The day, time and list come out of the title.">
        <Card className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2">
            {[
              ["Call mum tomorrow 6pm", "Due tomorrow at 6pm, with a reminder"],
              ["Bins out every Tuesday 7pm", "Comes back every Tuesday"],
              ["Milk #shopping", "Goes on your Shopping list"],
              ["Pay rego in March !!!", "Due in March, flagged high priority"],
            ].map(([eg, what]) => (
              <li key={eg} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="text-sm font-medium text-[var(--text)]">“{eg}”</span>
                <span className="text-xs text-[var(--text-muted)]">{what}</span>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-[var(--border)] pt-3 text-sm sm:grid-cols-2">
            {[
              ["Days", "today, tomorrow, Fri, next week, 12 Mar, in 3 days, in March"],
              ["Times", "9am, 6:30pm, 17:00, at 5, tonight, tomorrow morning"],
              ["Repeats", "every day, every weekday, every Mon and Thu, every 2 weeks, every month on the 1st, every 3 days after done"],
              ["Lists", "#shopping, #work. A # that isn't a list becomes a tag"],
              ["Tags", "@calls, @errands"],
              ["Priority", "! low, !! medium, !!! high"],
            ].map(([k, v]) => (
              <div key={k}>
                <p className="text-xs font-semibold text-[var(--text)]">{k}</p>
                <p className="text-xs text-[var(--text-muted)]">{v}</p>
              </div>
            ))}
          </div>
        </Card>
      </Section>

      <Section title="On a phone">
        <Card className="flex flex-col gap-1.5 text-sm text-[var(--text)]">
          <p>Swipe a task right to tick it off.</p>
          <p>Swipe it left to move it to tomorrow, next week or a day you pick.</p>
        </Card>
      </Section>

      <Section title="On a keyboard">
        <Card className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {[
            ["Q", "Start a new task"],
            ["↑ ↓", "Move between tasks"],
            ["Enter or E", "Open the task"],
            ["T", "Move the task to today"],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-sm text-[var(--text)]">
              <kbd className="min-w-[2rem] rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-center text-xs font-medium">{k}</kbd>
              <span>{v}</span>
            </div>
          ))}
        </Card>
      </Section>
    </Page>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]">{label}</p>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
