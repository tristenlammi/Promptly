import { BookOpen, Flame, History, Lightbulb, PenLine, RefreshCw, Settings2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, Fab, IconButton, ItemButton, Page, Section, addDays, todayISO, weekStart } from "@/items/ui";
import { cn } from "@/utils/cn";

import { moodColor } from "./constants";

import { pendingDrafts, useUserId } from "./drafts";
import { EntryCard, ReaderSheet } from "./EntryViews";
import { avgMood, byDay, excerptOf, fmtDow, fmtFullDay, greeting, headingOf, onThisDay, plain, promptOfDay, streaks, visibleTemplates } from "./lib";
import { MoodPicker } from "./Pickers";
import { SettingsSheet } from "./SettingsSheet";
import { editor } from "./store";
import type { JournalData } from "./types";

export function TodayView({ item, isPhone, ask }: ItemViewProps<JournalData>) {
  const data = item.data;
  const today = todayISO();
  const [shuffle, setShuffle] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const todays = useMemo(
    () => data.entries.filter((e) => e.date === today).sort((a, b) => a.time.localeCompare(b.time)),
    [data.entries, today],
  );
  const streak = useMemo(() => streaks(data.entries, today), [data.entries, today]);
  const memories = useMemo(() => onThisDay(data.entries, today), [data.entries, today]);
  const prompt = useMemo(() => promptOfDay(data, today, shuffle), [data, today, shuffle]);
  const templates = useMemo(() => visibleTemplates(data), [data]);
  const weekWords = useMemo(() => {
    const from = addDays(today, -6);
    return data.entries.filter((e) => e.date >= from).reduce((n, e) => n + e.word_count, 0);
  }, [data.entries, today]);
  const wd = (new Date().getDay() + 6) % 7; // 0 = Monday
  const reflected = useMemo(() => {
    const from = addDays(today, -6);
    return data.entries.some((e) => e.date >= from && (e.template_id === "weekly-reflection" || e.tags.includes("weekly")));
  }, [data.entries, today]);
  const reflectDay = !reflected && (data.settings.weekly_reminder ? wd === data.settings.weekly_day : wd >= 5);
  // Text written on this device that the journal doesn't hold yet (the app
  // was closed or killed mid-entry, or a save was refused).
  const userId = useUserId();
  const unsaved = useMemo(
    () => (item.canEdit ? pendingDrafts(userId, item.fileId, data, item.status === "saved") : []),
    [userId, item.fileId, item.canEdit, data, item.status],
  );
  const canEdit = item.canEdit;
  const hide = data.settings.hide_previews;

  const streakText =
    streak.current === 0
      ? data.entries.length
        ? "Start a new streak today"
        : "Your first entry starts a streak"
      : streak.wroteToday
        ? `${streak.current}-day streak`
        : `${streak.current}-day streak — keep it going today`;

  const write = (o: Parameters<typeof editor.open>[0] = {}) => editor.open(o);

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-[var(--text-muted)]">{fmtFullDay(today)}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)] md:text-3xl">{greeting()}.</h1>
      </div>
      <IconButton label="Journal settings" icon={Settings2} onClick={() => setSettings(true)} />
    </div>
  );

  const unsavedCard = canEdit && unsaved.length > 0 && (
    <Card className="flex flex-col gap-2 border-[var(--item-accent)]">
      <p className="text-[15px] font-semibold text-[var(--text)]">
        {unsaved.length === 1 ? "You have unsaved writing on this device" : `You have ${unsaved.length} unsaved entries on this device`}
      </p>
      {unsaved.slice(0, 3).map((d) => (
        <div key={d.entryId} className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">
            {fmtFullDay(d.draft.date)} · {d.draft.title || plain(d.draft.body).slice(0, 80) || "Check-in"}
          </p>
          <ItemButton size="sm" variant="primary" onClick={() => write({ entryId: d.entryId })}>
            Continue
          </ItemButton>
        </div>
      ))}
    </Card>
  );

  const checkIn = canEdit && (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[15px] font-semibold text-[var(--text)]">{todays.length ? "How are you now?" : "How are you today?"}</p>
        <span className="text-xs text-[var(--text-muted)]">Tap to start an entry</span>
      </div>
      <MoodPicker value={null} onChange={(m) => m && write({ mood: m })} size="lg" />
      {!isPhone && (
        <ItemButton variant="primary" size="lg" icon={<PenLine className="h-4 w-4" />} onClick={() => write()}>
          Write
        </ItemButton>
      )}
    </Card>
  );

  const promptCard = data.settings.show_prompt && (
    <Card className="flex flex-col gap-3 bg-[color-mix(in_srgb,var(--item-accent)_8%,var(--surface))]">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--item-accent)]">
        <Lightbulb className="h-3.5 w-3.5" /> Prompt of the day
      </div>
      <p className="text-[17px] leading-relaxed text-[var(--text)]">{prompt}</p>
      <div className="flex gap-2">
        {canEdit && (
          <ItemButton variant="primary" size="sm" onClick={() => write({ prompt, templateId: null })}>
            Write about this
          </ItemButton>
        )}
        <ItemButton variant="ghost" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setShuffle((s) => s + 1)}>
          Another
        </ItemButton>
      </div>
    </Card>
  );

  const templateRow = canEdit && templates.length > 0 && (
    <Section title="Start with a template">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-2 md:px-0">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => write({ templateId: t.id })}
            className="flex w-[200px] shrink-0 flex-col gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition hover:border-[var(--item-accent)] md:w-auto"
          >
            <span className="text-sm font-semibold text-[var(--text)]">{t.name}</span>
            <span className="line-clamp-2 text-xs leading-snug text-[var(--text-muted)]">{t.description || t.prompts[0] || "Your template"}</span>
          </button>
        ))}
      </div>
    </Section>
  );

  const todayList = (
    <Section title={todays.length ? `Today · ${todays.length} ${todays.length === 1 ? "entry" : "entries"}` : "Today"}>
      {todays.length ? (
        <div className="flex flex-col gap-2">
          {todays.map((e) => (
            <EntryCard key={e.id} entry={e} hidePreview={hide} onOpen={() => setReading(e.id)} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={BookOpen}
          title={data.entries.length ? "Nothing written today yet" : "Your journal is ready"}
          text={
            data.entries.length
              ? "A line or two is enough. Pick a mood above, take the prompt, or just start writing."
              : "Write about your day, check in with how you feel, or try a template. Only you can open this journal unless you share it."
          }
          action={
            canEdit ? (
              <ItemButton variant="primary" icon={<PenLine className="h-4 w-4" />} onClick={() => write()}>
                Write your {data.entries.length ? "entry" : "first entry"}
              </ItemButton>
            ) : undefined
          }
        />
      )}
    </Section>
  );

  const week = useMemo(() => {
    const ws = weekStart(today, (data.settings.week_starts_on ?? 1) as 0 | 1);
    const days = byDay(data.entries);
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(ws, i);
      const list = days.get(d);
      return { d, n: list?.length ?? 0, mood: list ? avgMood(list) : null };
    });
  }, [data.entries, data.settings.week_starts_on, today]);

  const weekStrip = (
    <div className="flex justify-between gap-1 border-t border-[var(--border)] pt-3" role="list" aria-label="This week">
      {week.map((w) => {
        const isToday = w.d === today;
        const future = w.d > today;
        return (
          <div key={w.d} role="listitem" aria-label={`${fmtFullDay(w.d)}: ${w.n ? `${w.n} ${w.n === 1 ? "entry" : "entries"}` : "no entry"}`} className="flex flex-1 flex-col items-center gap-1">
            <span className={cn("text-[11px] font-medium", isToday ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{fmtDow(w.d).slice(0, 2)}</span>
            <span
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                isToday && "ring-2 ring-[var(--item-accent)] ring-offset-2 ring-offset-[var(--surface)]",
                !w.n && "border border-dashed border-[var(--border)]",
                future && "opacity-40",
              )}
              style={w.n ? { background: w.mood ? `color-mix(in srgb, ${moodColor(w.mood)} 55%, var(--surface))` : "color-mix(in srgb, var(--item-accent) 30%, var(--surface))", color: "var(--text)" } : { color: "var(--text-muted)" }}
            >
              {Number(w.d.slice(8))}
            </span>
          </div>
        );
      })}
    </div>
  );

  const streakCard = (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
        <Flame className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-[var(--text)]" aria-live="polite">
          {streakText}
        </p>
        <p className="text-xs text-[var(--text-muted)] tabular-nums">
          Longest {streak.longest} · {streak.daysWritten} days written · {weekWords.toLocaleString()} words this week
        </p>
      </div>
      </div>
      {weekStrip}
    </Card>
  );

  const reflectCard = reflectDay && data.entries.length > 0 && (
    <Card className="flex flex-col gap-2">
      <p className="text-[15px] font-semibold text-[var(--text)]">Time to look back on your week</p>
      <p className="text-sm text-[var(--text-muted)]">Highlights, what was hard, what you learned — and an intention for next week.</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <ItemButton size="sm" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => ask("Help me reflect on my week — summarise it from my entries and ask me a couple of questions.")}>
          Reflect with the assistant
        </ItemButton>
        {canEdit && data.templates.some((t) => t.id === "weekly-reflection") && (
          <ItemButton size="sm" variant="ghost" onClick={() => write({ templateId: "weekly-reflection" })}>
            Weekly reflection
          </ItemButton>
        )}
      </div>
    </Card>
  );

  const memoriesCard = memories.length > 0 && (
    <Section title="On this day" hint="From earlier years">
      <div className="flex flex-col gap-2">
        {memories.slice(0, 5).map(({ years, entry }) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setReading(entry.id)}
            className="flex flex-col gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-left transition hover:border-[var(--item-accent)]"
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--item-accent)]">
              <History className="h-3.5 w-3.5" /> {years === 1 ? "A year ago" : `${years} years ago`}
            </span>
            <span className="truncate text-sm font-semibold text-[var(--text)]">{headingOf(entry)}</span>
            {!hide && <span className="line-clamp-2 text-sm text-[var(--text-muted)]">{excerptOf(entry, 160)}</span>}
          </button>
        ))}
      </div>
    </Section>
  );

  return (
    <Page wide>
      {header}
      {isPhone ? (
        <>
          {unsavedCard}
          {checkIn}
          {todayList}
          {promptCard}
          {streakCard}
          {reflectCard}
          {memoriesCard}
          {templateRow}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
          <div className="flex flex-col gap-5">
            {unsavedCard}
            {checkIn}
            {todayList}
            {templateRow}
          </div>
          <div className="flex flex-col gap-5">
            {promptCard}
            {streakCard}
            {reflectCard}
            {memoriesCard}
          </div>
        </div>
      )}
      {isPhone && <div className="h-16" aria-hidden />}
      {isPhone && canEdit && <Fab label="Write" icon={PenLine} onClick={() => write()} />}
      <ReaderSheet entryId={reading} onClose={() => setReading(null)} item={item} ask={ask} />
      <SettingsSheet open={settings} onClose={() => setSettings(false)} item={item} ask={ask} />
    </Page>
  );
}
