import { useVirtualizer } from "@tanstack/react-virtual";
import { BookOpen, PenLine, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Chip, EmptyState, Fab, ItemButton } from "@/items/ui";
import { cn } from "@/utils/cn";

import { MOODS } from "./constants";
import { EntryReader, ReaderSheet, TimelineRow } from "./EntryViews";
import { NO_FILTERS, filterEntries, fmtMonth, hasFilters, newestFirst, tagCounts, type Filters } from "./lib";
import { MoodFace } from "./Pickers";
import { editor } from "./store";
import type { Entry, JournalData } from "./types";

type Row = { kind: "month"; ym: string; n: number; words: number } | { kind: "entry"; entry: Entry; firstOfDay: boolean };

export function TimelineView({ item, isPhone, ask }: ItemViewProps<JournalData>) {
  const data = item.data;
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => newestFirst(data.entries), [data.entries]);
  const shown = useMemo(() => filterEntries(sorted, f), [sorted, f]);
  const tags = useMemo(() => tagCounts(data.entries).slice(0, 30), [data.entries]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let ym = "";
    let head: Extract<Row, { kind: "month" }> | null = null;
    for (const e of shown) {
      const m = e.date.slice(0, 7);
      if (m !== ym) {
        ym = m;
        head = { kind: "month", ym: m, n: 0, words: 0 };
        out.push(head);
      }
      head!.n += 1;
      head!.words += e.word_count;
      const prev = out[out.length - 1];
      out.push({ kind: "entry", entry: e, firstOfDay: !(prev?.kind === "entry" && prev.entry.date === e.date) });
    }
    return out;
  }, [shown]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i].kind === "month" ? 48 : data.settings.hide_previews ? 64 : 96),
    overscan: 8,
    getItemKey: (i) => {
      const r = rows[i];
      return r.kind === "month" ? `m${r.ym}` : r.entry.id;
    },
  });

  // Desktop: keep a selection in the reading pane.
  useEffect(() => {
    if (isPhone) return;
    if (!selected || !shown.some((e) => e.id === selected)) setSelected(shown[0]?.id ?? null);
  }, [isPhone, shown, selected]);

  // Keyboard: j/k or ↑/↓ move through entries (desktop), e edits.
  useEffect(() => {
    if (isPhone) return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (editor.get() || document.querySelector('[role="dialog"]')) return;
      const i = shown.findIndex((e) => e.id === selected);
      if (ev.key === "j" || ev.key === "ArrowDown") {
        const n = shown[Math.min(shown.length - 1, i + 1)];
        if (n) {
          ev.preventDefault();
          setSelected(n.id);
          const ri = rows.findIndex((r) => r.kind === "entry" && r.entry.id === n.id);
          if (ri >= 0) virt.scrollToIndex(ri, { align: "auto" });
        }
      } else if (ev.key === "k" || ev.key === "ArrowUp") {
        const n = shown[Math.max(0, i - 1)];
        if (n) {
          ev.preventDefault();
          setSelected(n.id);
          const ri = rows.findIndex((r) => r.kind === "entry" && r.entry.id === n.id);
          if (ri >= 0) virt.scrollToIndex(ri, { align: "auto" });
        }
      } else if (ev.key === "e" && selected && item.canEdit) {
        ev.preventDefault();
        editor.open({ entryId: selected });
      } else if (ev.key === "/") {
        ev.preventDefault();
        document.getElementById("journal-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, shown, selected, rows, virt, item.canEdit]);

  const toggleMood = (m: number) => setF((x) => ({ ...x, moods: x.moods.includes(m) ? x.moods.filter((y) => y !== m) : [...x.moods, m] }));
  const toggleTag = (t: string) => setF((x) => ({ ...x, tags: x.tags.includes(t) ? x.tags.filter((y) => y !== t) : [...x.tags, t] }));
  const active = hasFilters(f);
  const nFilters = f.tags.length + f.moods.length + (f.starred ? 1 : 0);

  const filterBar = (
    <div className="flex flex-col gap-2 border-b border-[var(--border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 focus-within:border-[var(--item-accent)] md:h-10">
          <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          <input
            id="journal-search"
            type="search"
            value={f.query}
            onChange={(e) => setF((x) => ({ ...x, query: e.target.value }))}
            placeholder="Search your journal"
            aria-label="Search entries"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] md:text-sm"
          />
          {f.query && (
            <button type="button" aria-label="Clear search" onClick={() => setF((x) => ({ ...x, query: "" }))} className="text-[var(--text-muted)]">
              <X className="h-4 w-4" />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => setShowFilters((s) => !s)}
          aria-expanded={showFilters}
          aria-label="Filters"
          className={cn(
            "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border md:h-10 md:w-10",
            showFilters || nFilters ? "border-[var(--item-accent)] text-[var(--item-accent)]" : "border-[var(--border)] text-[var(--text-muted)]",
          )}
        >
          <SlidersHorizontal className="h-4 w-4" />
          {nFilters > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--item-accent)] px-1 text-[10px] font-semibold text-white">
              {nFilters}
            </span>
          )}
        </button>
      </div>
      {showFilters && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={f.starred} onClick={() => setF((x) => ({ ...x, starred: !x.starred }))} icon={<Star className={cn("h-3.5 w-3.5", f.starred && "fill-current")} />}>
              Starred
            </Chip>
            {MOODS.map((m) => (
              <button
                key={m.value}
                type="button"
                aria-pressed={f.moods.includes(m.value)}
                aria-label={`Mood ${m.label}`}
                title={m.label}
                onClick={() => toggleMood(m.value)}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border transition",
                  f.moods.includes(m.value) ? "border-[var(--item-accent)]" : "border-transparent opacity-70 hover:opacity-100",
                )}
              >
                <MoodFace mood={m.value} size={24} />
              </button>
            ))}
          </div>
          {tags.length > 0 && (
            <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:flex-wrap">
              {tags.map(([t, n]) => (
                <Chip key={t} active={f.tags.includes(t)} onClick={() => toggleTag(t)}>
                  #{t} <span className="tabular-nums opacity-60">{n}</span>
                </Chip>
              ))}
            </div>
          )}
        </div>
      )}
      {active && (
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]" aria-live="polite">
          <span className="tabular-nums">
            {shown.length.toLocaleString()} of {data.entries.length.toLocaleString()} entries
          </span>
          <button type="button" onClick={() => setF(NO_FILTERS)} className="font-medium text-[var(--item-accent)]">
            Clear all
          </button>
        </div>
      )}
    </div>
  );

  const open = (id: string) => (isPhone ? setReading(id) : setSelected(id));

  const list = (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {data.entries.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={BookOpen}
            title="Your timeline starts with one entry"
            text="Everything you write appears here, month by month — searchable and filterable."
            action={item.canEdit ? <ItemButton variant="primary" onClick={() => editor.open()}>Write an entry</ItemButton> : undefined}
          />
        </div>
      ) : shown.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={Search} title="Nothing matches" text="Try fewer words, or clear a filter." action={<ItemButton onClick={() => setF(NO_FILTERS)}>Clear filters</ItemButton>} />
        </div>
      ) : (
        <div style={{ height: virt.getTotalSize(), position: "relative" }} className="w-full">
          {virt.getVirtualItems().map((v) => {
            const r = rows[v.index];
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virt.measureElement}
                className="absolute left-0 top-0 w-full px-2"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                {r.kind === "month" ? (
                  <div className="flex items-baseline justify-between px-2 pb-1 pt-5">
                    <h3 className="text-base font-semibold tracking-tight text-[var(--text)]">{fmtMonth(r.ym)}</h3>
                    <span className="text-xs tabular-nums text-[var(--text-muted)]">
                      {r.n} {r.n === 1 ? "entry" : "entries"} · {r.words.toLocaleString()} words
                    </span>
                  </div>
                ) : (
                  <div className={cn(r.firstOfDay && "border-t border-[var(--border)]", "pt-px")}>
                    <TimelineRow
                      entry={r.entry}
                      firstOfDay={r.firstOfDay}
                      hidePreview={data.settings.hide_previews}
                      selected={!isPhone && r.entry.id === selected}
                      onOpen={() => open(r.entry.id)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {isPhone && <div className="h-24" aria-hidden />}
    </div>
  );

  const sel = selected ? data.entries.find((e) => e.id === selected) ?? null : null;

  if (isPhone) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {filterBar}
        {list}
        {item.canEdit && <Fab label="Write" icon={PenLine} onClick={() => editor.open()} />}
        <ReaderSheet entryId={reading} onClose={() => setReading(null)} item={item} ask={ask} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-[var(--border)] xl:w-[380px] 2xl:w-[420px]">
        {filterBar}
        {list}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {sel ? (
          <EntryReader key={sel.id} entry={sel} item={item} ask={ask} className="px-8 py-8" />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--text-muted)]">Pick an entry to read it here.</div>
        )}
        {sel && (
          <p className="pb-6 text-center text-[11px] text-[var(--text-muted)]">
            <kbd>j</kbd>/<kbd>k</kbd> to move · <kbd>e</kbd> to edit · <kbd>/</kbd> to search
          </p>
        )}
      </div>
    </div>
  );
}
