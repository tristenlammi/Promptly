import { CloudSun, Heart, MapPin, PenLine, Sparkles, Star, Zap } from "lucide-react";

import { LinkedSection } from "@/components/links/LinkedSection";
import { Sheet, todayISO } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";
import { cn } from "@/utils/cn";

import { ENERGY, moodInfo } from "./constants";
import { excerptOf, fmtClock, fmtDow, fmtFullDay, headingOf } from "./lib";
import { Markdown } from "./Markdown";
import { EmotionChip, MoodFace } from "./Pickers";
import { editor } from "./store";
import type { Entry, JournalData } from "./types";

/* An entry as a card in a list, and an entry opened for reading. */

export function EntryCard({
  entry,
  onOpen,
  hidePreview,
  selected,
  showDate,
  compact,
}: {
  entry: Entry;
  onOpen: () => void;
  hidePreview?: boolean;
  selected?: boolean;
  showDate?: boolean;
  compact?: boolean;
}) {
  const mood = moodInfo(entry.mood);
  const ex = hidePreview ? "" : excerptOf(entry, compact ? 110 : 180);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected || undefined}
      className={cn(
        "group flex w-full items-start gap-3 rounded-2xl border bg-[var(--surface)] p-3.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
        selected ? "border-[var(--item-accent)]" : "border-[var(--border)] hover:border-[color-mix(in_srgb,var(--item-accent)_55%,var(--border))]",
      )}
    >
      <span className="pt-0.5">
        <MoodFace mood={entry.mood} size={30} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--text)]">{headingOf(entry)}</p>
          <EntryBadges entry={entry} />
        </div>
        {showDate && <p className="text-xs text-[var(--text-muted)]">{fmtFullDay(entry.date)}</p>}
        {ex && <p className={cn("mt-0.5 text-sm leading-relaxed text-[var(--text-muted)]", compact ? "line-clamp-2" : "line-clamp-3")}>{ex}</p>}
        <EntryMeta entry={entry} mood={mood} />
      </div>
    </button>
  );
}

function EntryBadges({ entry }: { entry: Entry }) {
  return (
    <>
      {(entry.ai_drafted || entry.ai_edited) && (
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--item-accent)]" aria-label={entry.ai_drafted ? "AI-drafted" : "Edited by the assistant"} />
      )}
      {entry.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-[var(--item-accent)]" aria-label="Starred" />}
    </>
  );
}

/** time · mood · feelings · #tags — one quiet line. */
function EntryMeta({ entry, mood, max = 3 }: { entry: Entry; mood: ReturnType<typeof moodInfo>; max?: number }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap text-xs text-[var(--text-muted)]">
      <span className="shrink-0 tabular-nums">{fmtClock(entry.time)}</span>
      {mood && (
        <span className="shrink-0 font-medium" style={{ color: `color-mix(in srgb, ${mood.color} 75%, var(--text))` }}>
          {mood.label}
        </span>
      )}
      {entry.emotions.slice(0, max - 1).map((w) => (
        <span key={w} className="shrink-0">
          {w}
        </span>
      ))}
      {entry.tags.slice(0, max).map((t) => (
        <span key={t} className="truncate text-[var(--item-accent)]">
          #{t}
        </span>
      ))}
    </div>
  );
}

/**
 * A timeline row, Day One style: the day on the left (only on a day's
 * first entry), the title, two lines of the text and one quiet meta line.
 * Flat rows with hairlines read much faster than a stack of cards.
 */
export function TimelineRow({
  entry,
  onOpen,
  hidePreview,
  selected,
  firstOfDay,
}: {
  entry: Entry;
  onOpen: () => void;
  hidePreview?: boolean;
  selected?: boolean;
  firstOfDay: boolean;
}) {
  const mood = moodInfo(entry.mood);
  const ex = hidePreview ? "" : excerptOf(entry, 160);
  const isToday = entry.date === todayISO();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected || undefined}
      aria-label={`${fmtFullDay(entry.date)}, ${fmtClock(entry.time)}: ${headingOf(entry)}`}
      className={cn(
        "relative flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
        selected ? "bg-[color-mix(in_srgb,var(--item-accent)_13%,transparent)]" : "hover:bg-[var(--hover)] active:bg-[var(--hover)]",
      )}
    >
      <div className="flex w-10 shrink-0 flex-col items-center pt-0.5" aria-hidden>
        {firstOfDay && (
          <>
            <span className={cn("text-[11px] font-semibold uppercase tracking-wide", isToday ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{fmtDow(entry.date)}</span>
            <span className={cn("text-[22px] font-semibold leading-none tabular-nums", isToday ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{Number(entry.date.slice(8))}</span>
          </>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-snug text-[var(--text)]">{headingOf(entry)}</p>
          <EntryBadges entry={entry} />
        </div>
        {ex && <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-[var(--text-muted)]">{ex}</p>}
        <EntryMeta entry={entry} mood={mood} />
      </div>
      {entry.mood ? (
        <span className="pt-0.5">
          <MoodFace mood={entry.mood} size={26} />
        </span>
      ) : null}
    </button>
  );
}

export function EntryReader({
  entry,
  item,
  ask,
  className,
  onBeforeEdit,
}: {
  entry: Entry;
  item: ItemHandle<JournalData>;
  ask: (p: string) => void;
  className?: string;
  onBeforeEdit?: () => void;
}) {
  const mood = moodInfo(entry.mood);
  const toggleStar = () => {
    const starred = !entry.starred; // decided from what's on screen, so a replay sets the same
    item.update((d) => {
      const e = d.entries.find((x) => x.id === entry.id);
      if (e) e.starred = starred;
    });
  };
  return (
    <article className={cn("mx-auto flex w-full max-w-[680px] flex-col gap-4", className)}>
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <p className="min-w-0 flex-1 text-sm text-[var(--text-muted)]">
            {fmtFullDay(entry.date)} · <span className="tabular-nums">{fmtClock(entry.time)}</span>
          </p>
          {item.canEdit && (
            <>
              <button
                type="button"
                aria-label={entry.starred ? "Unstar" : "Star"}
                aria-pressed={entry.starred}
                onClick={toggleStar}
                className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl hover:bg-[var(--hover)]", entry.starred ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}
              >
                <Star className={cn("h-5 w-5", entry.starred && "fill-current")} />
              </button>
              <button
                type="button"
                onClick={() => {
                  onBeforeEdit?.();
                  editor.open({ entryId: entry.id });
                }}
                className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <PenLine className="h-4 w-4" /> Edit
              </button>
            </>
          )}
        </div>
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight text-[var(--text)] [text-wrap:balance]">{headingOf(entry)}</h2>
        {(mood || entry.energy || entry.location || entry.weather) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[var(--text-muted)]">
            {mood && (
              <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text)]">
                <MoodFace mood={entry.mood} size={22} /> {mood.label}
              </span>
            )}
            {entry.energy && (
              <span className="inline-flex items-center gap-1">
                <Zap className="h-3.5 w-3.5" /> {ENERGY[entry.energy - 1]}
              </span>
            )}
            {entry.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> {entry.location}
              </span>
            )}
            {entry.weather && (
              <span className="inline-flex items-center gap-1">
                <CloudSun className="h-3.5 w-3.5" /> {entry.weather}
              </span>
            )}
          </div>
        )}
        {entry.emotions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.emotions.map((w) => (
              <EmotionChip key={w} word={w} active />
            ))}
          </div>
        )}
      </header>

      {(entry.ai_drafted || entry.ai_edited) && (
        <p className="flex items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]">
          <Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />{" "}
          {entry.ai_drafted ? "Drafted by the assistant at your request." : "Text edited by the assistant at your request."}
        </p>
      )}
      {entry.prompt && <blockquote className="border-l-[3px] border-[var(--item-accent)] pl-3 text-sm italic text-[var(--text-muted)]">{entry.prompt}</blockquote>}

      {entry.gratitude.length > 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            <Heart className="h-3.5 w-3.5 text-[var(--item-accent)]" /> Grateful for
          </p>
          <ol className="flex flex-col gap-1.5">
            {entry.gratitude.map((g, i) => (
              <li key={i} className="flex gap-2 text-[15px] text-[var(--text)]">
                <span className="w-4 shrink-0 font-semibold tabular-nums text-[var(--item-accent)]">{i + 1}</span>
                {g}
              </li>
            ))}
          </ol>
        </div>
      )}

      {entry.body.trim() && <Markdown text={entry.body} />}

      <LinkedSection thing={{ kind: "journal", id: `${item.fileId}:${entry.id}` }} readOnly={!item.canEdit} />

      <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        {entry.tags.map((t) => (
          <span key={t} className="rounded-full bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] px-2.5 py-1 text-xs font-medium text-[var(--text)]">
            #{t}
          </span>
        ))}
        <span className="text-xs tabular-nums text-[var(--text-muted)]">{entry.word_count.toLocaleString()} words</span>
        <button
          type="button"
          onClick={() => ask(`Help me reflect on my journal entry from ${entry.date}${entry.title ? ` (“${entry.title}”)` : ""} — entry id ${entry.id}. Ask me one or two good questions.`)}
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <Sparkles className="h-4 w-4 text-[var(--item-accent)]" /> Reflect on this
        </button>
      </footer>
    </article>
  );
}

/** An entry opened from a list (Today, Calendar, Timeline on a phone). */
export function ReaderSheet({
  entryId,
  onClose,
  item,
  ask,
}: {
  entryId: string | null;
  onClose: () => void;
  item: ItemHandle<JournalData>;
  ask: (p: string) => void;
}) {
  const entry = entryId ? item.data.entries.find((e) => e.id === entryId) ?? null : null;
  return (
    <Sheet open={!!entry} onClose={onClose} size="lg">
      {entry && (
        <EntryReader
          entry={entry}
          item={item}
          ask={(p) => {
            onClose();
            ask(p);
          }}
          className="pb-4 pt-1"
          onBeforeEdit={onClose}
        />
      )}
    </Sheet>
  );
}
