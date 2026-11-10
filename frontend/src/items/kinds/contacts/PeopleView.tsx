import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { AlarmClock, Check, Mail, Phone, Search, Star, Upload, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useSearchParams } from "react-router-dom";

import { Chip, EmptyState, Fab, ItemButton, todayISO } from "@/items/ui";
import type { ItemViewProps } from "@/items/types";
import { cn } from "@/utils/cn";

import { ContactDetail } from "./ContactDetail";
import { ContactForm } from "./ContactForm";
import { ImportSheet } from "./ImportSheet";
import { buildIndex, displayName, dueOn, letterOf, matches, sortContacts, tagCounts, telHref, workLine } from "./model";
import { SelectionBar } from "./Selection";
import { ContactAvatar, editContact, sheetOpen, takePendingFilter, typingTarget, useHomeCountry, useNewContactRequests, useWidth, type PeopleFilter } from "./shared";
import { ToolsMenu } from "./ToolsMenu";
import type { Contact, ContactsData } from "./types";

/*
 * Contacts — the A–Z book. Virtualised (thousands of people stay smooth),
 * sticky letter headers, a fast-scroll letter strip, search across every
 * field, filters by favourites / due / group / tag. Desktop: list + person
 * side by side with j/k, / and n. Phone: list → person (back returns).
 * "More" holds import / export / duplicates / settings; rows show quick
 * actions on hover; several people can be picked at once (More → Select
 * contacts, Ctrl/Shift-click, or a long press on a phone).
 */

type Row = { kind: "header"; label: string; key: string } | { kind: "contact"; c: Contact; key: string } | { kind: "favs"; list: Contact[]; key: string };

// Where the list was, so coming back from a person (phone) lands in the same place.
const lastOffset = new Map<string, number>();

const QUICK =
  "flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]";

const HEADER_H = 30;
const ROW_H = 60;
const FAVS_H = 104;

export function PeopleView({ item, isPhone, ask, doc }: ItemViewProps<ContactsData>) {
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
  const cc = useHomeCountry(item);

  // Picking several: null when off, the picked ids when on.
  const [pickedRaw, setPicked] = useState<Set<string> | null>(null);
  const picked = useMemo(() => {
    if (!pickedRaw) return null;
    const live = new Set(data.contacts.map((c) => c.id));
    const kept = [...pickedRaw].filter((id) => live.has(id));
    return kept.length === pickedRaw.size ? pickedRaw : new Set(kept);
  }, [pickedRaw, data.contacts]);
  const togglePicked = useCallback((id: string) => {
    setPicked((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // A long press on a phone starts picking.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const swallowClick = useRef(false);
  const pressEnd = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => pressEnd, [pressEnd]);
  const pressStart = (id: string, e: ReactPointerEvent) => {
    if (!isPhone || pickedRaw || e.pointerType === "mouse") return;
    pressEnd();
    const timer = window.setTimeout(() => {
      press.current = null;
      swallowClick.current = true;
      window.setTimeout(() => (swallowClick.current = false), 800);
      setPicked(new Set([id]));
      try {
        navigator.vibrate?.(8);
      } catch {
        /* not allowed */
      }
    }, 500);
    press.current = { timer, x: e.clientX, y: e.clientY };
  };
  const pressMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) pressEnd();
  };

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
      if (e.key === "Escape" && pickedRaw) {
        setPicked(null);
      } else if (e.key === "/") {
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
  }, [isPhone, contactRows, rows, selected, select, virtualizer, item.canEdit, pickedRaw]);

  // Links from other apps (Photos, Calendar) may say ?contact=<id>: the same as ?c=.
  useEffect(() => {
    const alias = params.get("contact");
    if (!alias) return;
    const p = new URLSearchParams(window.location.search);
    p.delete("contact");
    p.set("c", alias);
    setParams(p, { replace: true });
  }, [params, setParams]);

  // Opened on someone (a link from another app): show them in the list too.
  const openedOn = useRef(lastOffset.has(item.fileId) ? null : selected ?? params.get("contact"));
  useEffect(() => {
    const id = openedOn.current;
    if (isPhone || !id) return;
    const i = rows.findIndex((r) => r.kind === "contact" && r.c.id === id);
    if (i < 0) return;
    openedOn.current = null;
    virtualizer.scrollToIndex(i, { align: "center" });
  }, [isPhone, rows, virtualizer]);

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
  const filtered = !!query || filter.kind !== "all";
  const clearFilters = () => {
    setQuery("");
    setFilter({ kind: "all" });
  };
  const rowClick = (id: string, e: ReactMouseEvent) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (picked) togglePicked(id);
    else if (!isPhone && (e.ctrlKey || e.metaKey || e.shiftKey)) setPicked(new Set([id]));
    else select(id);
  };

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-4 pb-2 pt-3">
        <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
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
        <ToolsMenu item={item} title={doc.title} ask={ask} onSelectMode={() => setPicked(new Set())} />
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
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center" aria-live="polite">
          <p className="text-sm text-[var(--text-muted)]">{query ? `No one matches “${query}”.` : "No one here yet."}</p>
          {filtered && (
            <ItemButton size="sm" onClick={clearFilters}>
              Clear filters
            </ItemButton>
          )}
        </div>
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
                const isPicked = picked?.has(c.id) ?? false;
                const name = displayName(c, data.settings.name_order);
                return (
                  <div key={v.key} style={style} role="listitem" className={cn("group/row", isPhone ? "pr-9" : "pr-6")}>
                    <button
                      type="button"
                      onClick={(e) => rowClick(c.id, e)}
                      onPointerDown={(e) => pressStart(c.id, e)}
                      onPointerMove={pressMove}
                      onPointerUp={pressEnd}
                      onPointerCancel={pressEnd}
                      onPointerLeave={pressEnd}
                      onContextMenu={(e) => {
                        if (isPhone) e.preventDefault();
                      }}
                      aria-current={on && !picked ? "true" : undefined}
                      aria-pressed={picked ? isPicked : undefined}
                      className={cn(
                        "flex h-full w-full select-none items-center gap-3 px-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
                        (picked ? isPicked : on && !isPhone) ? "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]" : "hover:bg-[var(--hover)] active:bg-[var(--hover)]",
                      )}
                    >
                      {picked && (
                        <span
                          aria-hidden
                          className={cn(
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition",
                            isPicked ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-transparent",
                          )}
                        >
                          <Check className="h-3.5 w-3.5" strokeWidth={3} />
                        </span>
                      )}
                      <ContactAvatar contact={c} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium text-[var(--text)] md:text-sm">{name}</span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">{workLine(c) || c.emails[0]?.value || c.phones[0]?.value || " "}</span>
                      </span>
                      {overdue && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--item-accent)]" title="Due to reconnect" aria-label="Due to reconnect" />}
                      {c.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-[var(--text-muted)]" aria-label="Favourite" />}
                    </button>
                    {!isPhone && !picked && (
                      <div className="pointer-events-none absolute right-8 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-0.5 opacity-0 shadow-[var(--shadow-sm)] transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
                        {c.phones[0]?.value && (
                          <a href={telHref(c.phones[0].value, cc)} aria-label={`Call ${name}`} title="Call" className={QUICK}>
                            <Phone className="h-4 w-4" />
                          </a>
                        )}
                        {c.emails[0]?.value && (
                          <a href={`mailto:${c.emails[0].value}`} aria-label={`Email ${name}`} title="Email" className={QUICK}>
                            <Mail className="h-4 w-4" />
                          </a>
                        )}
                        {item.canEdit && (
                          <button
                            type="button"
                            aria-label={c.favorite ? `Take ${name} out of favourites` : `Add ${name} to favourites`}
                            aria-pressed={c.favorite}
                            title={c.favorite ? "Remove from favourites" : "Favourite"}
                            onClick={() => {
                              const to = !c.favorite;
                              editContact(item, c.id, (x) => void (x.favorite = to));
                            }}
                            className={QUICK}
                          >
                            <Star className={cn("h-4 w-4", c.favorite && "fill-current text-[var(--item-accent)]")} />
                          </button>
                        )}
                      </div>
                    )}
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
      {picked && <SelectionBar item={item} title={doc.title} picked={picked} allIds={visible.map((c) => c.id)} onPick={setPicked} onDone={() => setPicked(null)} />}
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
        {item.canEdit && !empty && !picked && <Fab label="Add" icon={UserPlus} onClick={() => setAdding(true)} />}
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
