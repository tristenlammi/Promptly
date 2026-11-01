import { BellRing } from "lucide-react";

import { usePushSubscription } from "@/hooks/usePushSubscription";
import type { ItemViewProps } from "@/items/types";
import { Card, Field, ItemButton, Page, Section, Segmented, TextInput, Toggle } from "@/items/ui";

import type { Settings, TasksData } from "./types";

/* Settings: reminders (this device's push, default times, the morning
 * digest), the week, and a cheat sheet for quick add. */
export function SettingsView({ item }: ItemViewProps<TasksData>) {
  const s = item.data.settings;
  const set = (fn: (st: Settings) => void) => item.update((d) => fn(d.settings));
  const push = usePushSubscription();
  const ro = !item.canEdit;
  return (
    <Page className="max-w-2xl">
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
            <Row label="Morning digest" hint="One push with what's due today and what's overdue.">
              <Toggle label="Morning digest" checked={s.digest} onChange={(v) => set((st) => void (st.digest = v))} />
            </Row>
            {s.digest && (
              <Field label="Digest at">
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

      <Section title="Typing tasks" hint="Quick add understands plain words — these come out of the title.">
        <Card className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[
            ["Days", "today, tomorrow, Fri, next week, 12 Mar, in 3 days, in March"],
            ["Times", "9am, 6:30pm, 17:00, at 5, tonight, tomorrow morning"],
            ["Repeats", "every day, every weekday, every Mon and Thu, every 2 weeks, every month on the 1st, every 3 days after done"],
            ["Lists", "#shopping, #work — a # that isn't a list becomes a tag"],
            ["Tags", "@calls, @errands"],
            ["Priority", "!1 low, !2 medium, !3 high (or p1 = high)"],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-xs font-semibold text-[var(--text)]">{k}</p>
              <p className="text-xs text-[var(--text-muted)]">{v}</p>
            </div>
          ))}
          <p className="text-xs text-[var(--text-muted)] sm:col-span-2">
            On a computer, press <kbd className="rounded border border-[var(--border)] px-1">q</kbd> to jump to the box.
          </p>
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
