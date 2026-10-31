import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { AlarmClock, Search, Star, Upload, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Chip, EmptyState, Fab, ItemButton, todayISO } from "@/items/ui";
import type { ItemViewProps } from "@/items/types";
import { cn } from "@/utils/cn";

import { ContactDetail } from "./ContactDetail";
import { ContactForm } from "./ContactForm";
import { ImportSheet } from "./ImportSheet";
import { buildIndex, displayName, dueOn, letterOf, matches, sortContacts, tagCounts, workLine } from "./model";
import { ContactAvatar, sheetOpen, takePendingFilter, typingTarget, useNewContactRequests, useWidth, type PeopleFilter } from "./shared";
import type { Contact, ContactsData } from "./types";

/*
 * People — the A–Z book. Virtualised (thousands of people stay smooth),
 * sticky letter headers, a fast-scroll letter strip, search across every
 * field, filters by favourites / due / group / tag. Desktop: list + person
 * side by side with j/k, / and n. Phone: list → person (back returns).
 */

type Row = { kind: "header"; label: string; key: string } | { kind: "contact"; c: Contact; key: string } | { kind: "favs"; list: Contact[]; key: string };

// Where the list was, so coming back from a person (phone) lands in the same place.
const lastOffset = new Map<string, number>();

const HEADER_H = 30;
const ROW_H = 60;
const FAVS_H = 104;

export function PeopleView({ item, isPhone, ask }: ItemViewProps<ContactsData>) {
  const data = item.data;
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const pushed = useRef(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PeopleFilter>(() => takePendingFilter() ?? { kind: "all" });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rootW = useWidth(rootRef, isPhone);
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = todayISO();

  const select = useCallback(
    (id: string | null, { push = isPhone }: { push?: boolean } = {}) => {
      const p = new URLSearchParams(window.location.search);
      if (id) p.set("c", id);
      else p.delete("c");
      if (id && push) pushed.current = true;
      setParams(p, { replace: !(id && push) });
    },
    [isPhone, setParams],
  );

  const back = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else select(null, { push: false });
  }, [select]);

  // The header's "Add contact" (it switches here first).
  const openNew = useCallback(() => setAdding(true), []);
  useNewContactRequests(openNew);

  const index = useMemo(() => buildIndex(data), [data]);
  const sorted = useMemo(() => sortContacts(data.contacts, data.settings.sort_by), [data.contacts, data.settings.sort_by]);
  const visible = useMemo(() => {
    const pass = (c: Contact) => {
      switch (filter.kind) {
        case "favorites":
          return c.favorite;
        case "due": {
          const d = dueOn(c, today);
          return !!d && d <= today;
        }
        case "group":
          return c.groups.includes(filter.id);
        case "tag":
          return c.tags.some((t) => t.toLowerCase() === filter.tag.toLowerCase());
        default:
          return true;
      }
    };
    return sorted.filter((c) => pass(c) && matches(index, c.id, query));
  }, [sorted, filter, index, query, today]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const showFavs = !query && filter.kind === "all";
    if (showFavs) {
      const favs = visible.filter((c) => c.favorite);
      if (favs.length) out.push({ kind: "favs", list: favs, key: "favs" });
    }
    if (query) {
      for (const c of visible) out.push({ kind: "contact", c, key: c.id });
      return out;
    }
    let letter = "";
    for (const c of visible) {
      const l = letterOf(c, data.settings.sort_by);
      if (l !== letter) {
        letter = l;
        out.push({ kind: "header", label: l, key: `h-${l}` });
      }
      out.push({ kind: "contact", c, key: c.id });
    }
    return out;
  }, [visible, query, filter.kind, data.settings.sort_by]);

  const stickyIndexes = useMemo(() => rows.flatMap((r, i) => (r.kind === "header" ? [i] : [])), [rows]);
  const activeSticky = useRef(0);
  const rangeExtractor = useCallback(
    (range: Range) => {
      activeSticky.current = [...stickyIndexes].reverse().find((i) => range.startIndex >= i) ?? 0;
      const next = new Set([activeSticky.current, ...defaultRangeExtractor(range)]);
      return [...next].sort((a, b) => a - b);
    },
    [stickyIndexes],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "header" ? HEADER_H : rows[i]?.kind === "favs" ? FAVS_H : ROW_H),
    overscan: 12,
    rangeExtractor: stickyIndexes.length ? rangeExtractor : undefined,
    getItemKey: (i) => rows[i]?.key ?? i,
    initialOffset: () => lastOffset.get(item.fileId) ?? 0,
    onChange: (v) => {
      if (v.scrollOffset !== null) lastOffset.set(item.fileId, v.scrollOffset);
    },
  });

  const contactRows = useMemo(() => rows.flatMap((r, i) => (r.kind === "contact" ? [i] : [])), [rows]);
  const letters = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.kind === "header" && !m.has(r.label)) m.set(r.label, i);
    });
    return m;
  }, [rows]);

  // Keyboard: j/k move, / searches, n adds, Enter opens (phone-style), Esc clears.
  useEffect(() => {
    if (isPhone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || sheetOpen()) return;
      if (typingTarget(e)) {
        if (e.key === "Escape" && e.target === searchRef.current) {
          setQuery("");
          searchRef.current?.blur();
        }
        if ((e.key === "ArrowDown" || e.key === "Enter") && e.target === searchRef.current && contactRows.length) {
          e.preventDefault();
          const r = rows[contactRows[0]];
          if (r.kind === "contact") select(r.c.id);
          searchRef.current?.blur();
        }
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "n" && item.canEdit) {
        e.preventDefault();
        setAdding(true);
      } else if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!contactRows.length) return;
        e.preventDefault();
        const at = contactRows.findIndex((i) => {
          const r = rows[i];
          return r.kind === "contact" && r.c.id === selected;
        });
        const down = e.key === "j" || e.key === "ArrowDown";
        const nextPos = at < 0 ? 0 : Math.max(0, Math.min(contactRows.length - 1, at + (down ? 1 : -1)));
        const r = rows[contactRows[nextPos]];
        if (r.kind === "contact") {
          select(r.c.id);
          virtualizer.scrollToIndex(contactRows[nextPos], { align: "auto" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, contactRows, rows, selected, select, virtualizer, item.canEdit]);

  // Desktop: something is always open.
  useEffect(() => {
    if (isPhone || selected || !visible.length) return;
    select(visible[0].id, { push: false });
  }, [isPhone, selected, visible, select]);

  const tags = useMemo(() => tagCounts(data).slice(0, 12), [data]);
  const dueCount = useMemo(() => data.contacts.filter((c) => {
    const d = dueOn(c, today);
    return !!d && d <= today;
  }).length, [data.contacts, today]);

  const empty = data.contacts.length === 0;

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-4 pb-2 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${data.contacts.length.toLocaleString()} ${data.contacts.length === 1 ? "person" : "people"}`}
            aria-label="Search contacts"
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)] md:h-10 md:text-sm"
          />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
              <X className="h-4 w-4" />
            </button>
          ) : (
            !isPhone && <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--text-muted)]">/</kbd>
          )}
        </div>
        {!empty && (
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
            <Chip active={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })}>
              All
            </Chip>
            <Chip active={filter.kind === "favorites"} onClick={() => setFilter({ kind: "favorites" })} icon={<Star className="h-3 w-3" />}>
              Favourites
            </Chip>
            {dueCount > 0 && (
              <Chip active={filter.kind === "due"} onClick={() => setFilter({ kind: "due" })} icon={<AlarmClock className="h-3 w-3" />}>
                Due {dueCount}
              </Chip>
            )}
            {data.groups.map((g) => (
              <Chip key={g.id} active={filter.kind === "group" && filter.id === g.id} onClick={() => setFilter({ kind: "group", id: g.id })} icon={<Users className="h-3 w-3" />}>
                {g.name}
              </Chip>
            ))}
            {tags.map(([t]) => (
              <Chip key={t} active={filter.kind === "tag" && filter.tag.toLowerCase() === t.toLowerCase()} onClick={() => setFilter({ kind: "tag", tag: t })}>
                #{t}
              </Chip>
            ))}
          </div>
        )}
      </div>
      {empty ? (
        <div className="px-4 pb-24">
          <EmptyState
            icon={UserPlus}
            title="Your address book is empty"
            text="Add people one by one, bring them over from Google, iCloud or Outlook (vCard or CSV), or paste an email signature to the assistant."
            action={
              item.canEdit && (
                <div className="flex flex-wrap justify-center gap-2">
                  <ItemButton variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                    Add a contact
                  </ItemButton>
                  <ItemButton icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
                    Import
                  </ItemButton>
                  <ItemButton variant="ghost" onClick={() => ask("I'll paste some contact details — add them for me: ")}>
                    Ask the assistant
                  </ItemButton>
                </div>
              )
            }
          />
        </div>
      ) : visible.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-[var(--text-muted)]" aria-live="polite">
          {query ? `No one matches “${query}”.` : "No one here yet."}
        </p>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} className={cn("h-full overflow-y-auto overscroll-contain", isPhone && "pb-24")} role="list" aria-label="Contacts">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
              {virtualizer.getVirtualItems().map((v) => {
                const r = rows[v.index];
                if (!r) return null;
                const sticky = activeSticky.current === v.index && r.kind === "header";
                const style = {
                  ...(sticky ? { position: "sticky" as const, zIndex: 2 } : { position: "absolute" as const, transform: `translateY(${v.start}px)` }),
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: v.size,
                };
                if (r.kind === "header") {
                  return (
                    <div key={v.key} style={style} className="flex items-end bg-[var(--bg)] px-4 pb-1 text-xs font-semibold text-[var(--item-accent)]" role="presentation">
                      {r.label}
                    </div>
                  );
                }
                if (r.kind === "favs") {
                  return (
                    <div key={v.key} style={style} role="listitem" aria-label="Favourites" className={cn(letters.size > 3 && (isPhone ? "pr-9" : "pr-6"))}>
                      <FavouritesRow list={r.list} selected={selected} isPhone={isPhone} onPick={(id) => select(id)} />
                    </div>
                  );
                }
                const c = r.c;
                const due = dueOn(c, today);
                const overdue = !!due && due <= today;
                const on = c.id === selected;
                return (
                  <div key={v.key} style={style} role="listitem" className={cn(isPhone ? "pr-9" : "pr-6")}>
                    <button
                      type="button"
                      onClick={() => select(c.id)}
                      aria-current={on ? "true" : undefined}
                      className={cn(
                        "flex h-full w-full items-center gap-3 px-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
                        on && !isPhone ? "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]" : "hover:bg-[var(--hover)] active:bg-[var(--hover)]",
                      )}
                    >
                      <ContactAvatar contact={c} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium text-[var(--text)] md:text-sm">{displayName(c, data.settings.name_order)}</span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">{workLine(c) || c.emails[0]?.value || c.phones[0]?.value || " "}</span>
                      </span>
                      {overdue && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--item-accent)]" title="Due to reconnect" aria-label="Due to reconnect" />}
                      {c.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-[var(--text-muted)]" aria-label="Favourite" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          {!query && letters.size > 3 && (
            <LetterStrip
              letters={[...letters.keys()]}
              onPick={(l) => {
                const i = letters.get(l);
                if (i !== undefined) virtualizer.scrollToIndex(i, { align: "start" });
              }}
            />
          )}
        </div>
      )}
    </div>
  );

  const sheets = (
    <>
      <ContactForm item={item} open={adding} onClose={() => setAdding(false)} onSaved={(id) => select(id, { push: isPhone })} />
      <ImportSheet item={item} open={importing} onClose={() => setImporting(false)} />
    </>
  );

  if (isPhone) {
    if (selected && data.contacts.some((c) => c.id === selected)) {
      return (
        <>
          <ContactDetail item={item} contactId={selected} isPhone ask={ask} onBack={back} onOpen={(id) => select(id, { push: true })} onDeleted={back} />
          {sheets}
        </>
      );
    }
    return (
      <div className="h-full">
        {list}
        {item.canEdit && !empty && <Fab label="Add" icon={UserPlus} onClick={() => setAdding(true)} />}
        {sheets}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0">
      <div className={cn("flex shrink-0 flex-col border-r border-[var(--border)]", rootW > 0 && rootW < 880 ? "w-[300px]" : "w-[340px] 2xl:w-[380px]")}>{list}</div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected && data.contacts.some((c) => c.id === selected) ? (
          <ContactDetail item={item} contactId={selected} isPhone={false} ask={ask} onOpen={(id) => select(id)} onDeleted={() => select(null)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-[var(--text-muted)]">
            {empty ? "Add someone to get started." : "Pick someone from the list."}
            {!empty && (
              <p className="text-xs">
                <kbd className="rounded border border-[var(--border)] px-1">j</kbd> / <kbd className="rounded border border-[var(--border)] px-1">k</kbd> to move ·{" "}
                <kbd className="rounded border border-[var(--border)] px-1">/</kbd> to search · <kbd className="rounded border border-[var(--border)] px-1">n</kbd> new
              </p>
            )}
          </div>
        )}
      </div>
      {sheets}
    </div>
  );
}

/** The A–Z strip down the right edge: tap or drag to jump. */
function LetterStrip({ letters, onPick }: { letters: string[]; onPick: (l: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  const pickAt = (clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(letters.length - 1, Math.floor(((clientY - rect.top) / rect.height) * letters.length)));
    const l = letters[i];
    if (l !== last.current) {
      last.current = l;
      setBubble(l);
      onPick(l);
      if ("vibrate" in navigator) {
        try {
          navigator.vibrate?.(4);
        } catch {
          /* not allowed */
        }
      }
    }
  };
  return (
    <>
      <div
        ref={ref}
        role="navigation"
        aria-label="Jump to letter"
        className="absolute bottom-24 right-0 top-2 flex w-9 touch-none select-none flex-col items-center justify-center md:bottom-2 md:w-6"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          last.current = null;
          pickAt(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons || e.pointerType === "touch") pickAt(e.clientY);
        }}
        onPointerUp={() => {
          last.current = null;
          window.setTimeout(() => setBubble(null), 350);
        }}
      >
        {letters.map((l) => (
          <button
            key={l}
            type="button"
            tabIndex={-1}
            onClick={() => onPick(l)}
            className="flex min-h-0 w-full max-h-6 flex-1 items-center justify-center text-[11px] font-semibold leading-none text-[var(--item-accent)] md:text-[10px]"
          >
            {l}
          </button>
        ))}
      </div>
      {bubble && (
        <div aria-live="polite" className="pointer-events-none absolute left-1/2 top-1/3 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-2xl bg-[var(--item-accent)] text-3xl font-bold text-white shadow-[var(--shadow-lg)]">
          {bubble}
        </div>
      )}
    </>
  );
}

/** Favourites as a row of faces (iOS / Google Contacts) instead of a second copy of each row. */
function FavouritesRow({ list, selected, isPhone, onPick }: { list: Contact[]; selected: string | null; isPhone: boolean; onPick: (id: string) => void }) {
  return (
    <div className="flex h-full flex-col justify-center">
      <p className="px-4 pb-1.5 text-xs font-semibold text-[var(--item-accent)]">Favourites</p>
      <div className="flex gap-1 overflow-x-auto px-2.5 pb-1 [scrollbar-width:none]">
        {list.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.id)}
            aria-current={!isPhone && c.id === selected ? "true" : undefined}
            className={cn(
              "flex w-[68px] shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-1 transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              !isPhone && c.id === selected && "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]",
            )}
          >
            <ContactAvatar contact={c} size={48} />
            <span className="w-full truncate text-center text-[11px] text-[var(--text)]">{c.nickname || c.first || displayName(c)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
