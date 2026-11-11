import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckSquare, ChevronDown, Flag, FolderInput, ListChecks, PauseCircle, Plus, RotateCcw, Search, Sparkles, Tag, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Chip, EmptyState, Fab, Field, IconButton, ItemButton, ScrollRow, Sheet, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { allTags, cardState, deckSeed, deckTree, ensureDeck, matches, oneLine } from "./cards";
import { CardEditorSheet, CardForm } from "./CardEditor";
import { useAddIntent, DeckDot, DeckSelect, fmtDue, StateBadge, useCfg, usePaths, useWidth } from "./common";
import * as F from "./fsrs";
import { take } from "./intents";
import type { Card, Data } from "./types";

type Sort = "created" | "modified" | "due" | "lapses" | "front";

const STATES: { q: string; label: string }[] = [
  { q: "", label: "All" },
  { q: "is:due", label: "Due" },
  { q: "is:new", label: "New" },
  { q: "is:learning", label: "Learning" },
  { q: "is:review", label: "Review" },
  { q: "is:flagged", label: "Flagged" },
  { q: "is:suspended", label: "Suspended" },
  { q: "is:leech", label: "Leeches" },
];

const firstDue = (c: Card) => c.srs.reduce<number>((m, s) => (s.state !== "new" && s.due ? Math.min(m, F.parseMoment(s.due)) : m), Infinity);
const maxLapses = (c: Card) => c.srs.reduce((m, s) => Math.max(m, s.lapses), 0);

export function BrowseTab({ item, isPhone, ask }: ItemViewProps<Data>) {
  const data = item.data;
  const cfg = useCfg(data);
  const paths = usePaths(data.decks);
  const [query, setQuery] = useState(() => take("browse")?.query ?? "");
  const [deck, setDeck] = useState("");
  const [stateQ, setStateQ] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<Sort>("created");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [bulk, setBulk] = useState<"move" | "tag" | "delete" | "reset" | null>(null);
  useAddIntent(() => setAdding(true));

  const full = [query, deck ? `deck:"${paths.get(deck) ?? ""}"` : "", stateQ, tag ? `tag:"${tag}"` : ""].filter(Boolean).join(" ");
  const now = Date.now();
  const hits = useMemo(() => {
    const out = data.cards.filter((c) => matches(c, full, paths, now, cfg));
    const by: Record<Sort, (a: Card, b: Card) => number> = {
      created: (a, b) => b.created.localeCompare(a.created),
      modified: (a, b) => b.modified.localeCompare(a.modified),
      due: (a, b) => firstDue(a) - firstDue(b),
      lapses: (a, b) => maxLapses(b) - maxLapses(a),
      front: (a, b) => oneLine(a.front).localeCompare(oneLine(b.front)),
    };
    return out.sort(by[sort]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.cards, full, paths, cfg, sort]);
  const tags = useMemo(() => allTags(data.cards), [data.cards]);
  const open = openId ? (data.cards.find((c) => c.id === openId) ?? null) : null;
  const [rootRef, width] = useWidth<HTMLDivElement>();
  // Three panes (filters · list · editor) need ~1000px; below that the
  // filters fold into the search bar, and the editor shows beside the list
  // only while a card is open (or as a sheet when even that won't fit).
  const sideFilters = !isPhone && width >= 1000;
  const sideEditor = !isPhone && (width >= 1000 || (width >= 700 && !!open));
  const desktopOpen = sideEditor ? (open ?? null) : null;

  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 64,
    overscan: 12,
  });

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = data.cards.filter((c) => sel.has(c.id));
  const bulkUpdate = (fn: (c: Card) => void) =>
    item.update((d) => {
      for (const c of d.cards) if (sel.has(c.id)) fn(c);
    });
  const allSuspended = chosen.length > 0 && chosen.every((c) => c.suspended);
  const allFlagged = chosen.length > 0 && chosen.every((c) => c.flagged);

  const search = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search — tag:x deck:y is:due -word"
            className="pl-9"
            aria-label="Search cards"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {item.canEdit && (
          <IconButton
            label={selecting ? "Stop selecting" : "Select cards"}
            icon={selecting ? X : CheckSquare}
            active={selecting}
            onClick={() => {
              setSelecting((s) => !s);
              setSel(new Set());
            }}
          />
        )}
      </div>
      <ScrollRow>
        {STATES.map((s) => (
          <Chip key={s.q} active={stateQ === s.q} onClick={() => setStateQ(s.q)}>
            {s.label}
          </Chip>
        ))}
      </ScrollRow>
      <ScrollRow>
        {!sideFilters && (
          <PillSelect label="Deck" value={deck} active={!!deck} onChange={setDeck}>
            <option value="">All decks</option>
            {deckTree(data.decks).map(({ deck: d, depth }) => (
              <option key={d.id} value={d.id}>
                {"\u2003".repeat(depth) + d.name}
              </option>
            ))}
          </PillSelect>
        )}
        {!sideFilters && tags.length > 0 && (
          <PillSelect label="Tag" value={tag} active={!!tag} onChange={setTag}>
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                #{t.tag} ({t.n})
              </option>
            ))}
          </PillSelect>
        )}
        <PillSelect label="Sort" value={sort} active={false} onChange={(v) => setSort(v as Sort)}>
          <option value="created">Newest first</option>
          <option value="modified">Recently edited</option>
          <option value="due">Due soonest</option>
          <option value="lapses">Most lapses</option>
          <option value="front">A–Z</option>
        </PillSelect>
      </ScrollRow>
    </div>
  );

  const bulkBar = selecting && (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[var(--shadow-md)]",
        isPhone && "mx-4 mb-2",
      )}
    >
      <button
        type="button"
        className="h-9 rounded-lg px-2 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]"
        onClick={() => setSel(sel.size === hits.length ? new Set() : new Set(hits.map((c) => c.id)))}
      >
        {sel.size === hits.length && hits.length ? "None" : `All ${hits.length}`}
      </button>
      <span className="px-1 text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
        {sel.size} selected
      </span>
      <div className="ml-auto flex items-center">
        <IconButton label="Move to deck" icon={FolderInput} disabled={!sel.size} onClick={() => setBulk("move")} />
        <IconButton label="Tags" icon={Tag} disabled={!sel.size} onClick={() => setBulk("tag")} />
        <IconButton
          label={allSuspended ? "Unsuspend" : "Suspend"}
          icon={PauseCircle}
          active={allSuspended}
          disabled={!sel.size}
          onClick={() => bulkUpdate((c) => (c.suspended = !allSuspended))}
        />
        <IconButton
          label={allFlagged ? "Unflag" : "Flag"}
          icon={Flag}
          active={allFlagged}
          disabled={!sel.size}
          onClick={() => bulkUpdate((c) => (c.flagged = !allFlagged))}
        />
        <IconButton label="Reset to new" icon={RotateCcw} disabled={!sel.size} onClick={() => setBulk("reset")} />
        <IconButton label="Delete" icon={Trash2} disabled={!sel.size} onClick={() => setBulk("delete")} />
      </div>
    </div>
  );

  const list = (
    <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", isPhone && "pb-24")}>
      {hits.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={Search}
            title={data.cards.length ? "No cards match" : "No cards yet"}
            text={data.cards.length ? "Try fewer filters, or search with tag:, deck:, is:due, type:cloze." : "Add cards here or import a deck."}
            action={
              item.canEdit && !data.cards.length ? (
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                  Add cards
                </ItemButton>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((row) => {
            const c = hits[row.index];
            const st = cardState(c);
            const due = firstDue(c);
            const active = openId === c.id && !isPhone;
            return (
              <div
                key={c.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: row.size,
                  transform: `translateY(${row.start}px)`,
                }}
                className="border-b border-[var(--border)]"
              >
                <button
                  type="button"
                  onClick={() => (selecting ? toggle(c.id) : setOpenId(c.id))}
                  className={cn(
                    "flex h-full w-full items-center gap-3 px-3 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
                    (active || sel.has(c.id)) && "bg-[var(--hover)]",
                  )}
                  aria-pressed={selecting ? sel.has(c.id) : undefined}
                >
                  {selecting && (
                    <span
                      aria-hidden
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2",
                        sel.has(c.id) ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)]",
                      )}
                    >
                      {sel.has(c.id) && "✓"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{oneLine(c.front, 160) || "—"}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {c.back ? oneLine(c.back, 120) : c.type === "cloze" ? `${c.srs.length} cloze${c.srs.length === 1 ? "" : "s"}` : ""}
                      {c.tags.length ? ` · #${c.tags.slice(0, 3).join(" #")}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="flex h-5 items-center gap-1.5">
                      {c.flagged && <Flag className="h-3.5 w-3.5 text-[var(--warning)]" aria-label="Flagged" />}
                      {st === "review" ? (
                        <span className={cn("text-xs tabular-nums", due <= now ? "font-semibold text-[var(--success)]" : "text-[var(--text-muted)]")}>
                          {Number.isFinite(due) ? fmtDue(new Date(due).toISOString(), now) : ""}
                        </span>
                      ) : (
                        <StateBadge state={st} />
                      )}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                      <DeckDot color={data.decks.find((d) => d.id === c.deck_id)?.color ?? "var(--border)"} size={6} />
                      <span className="max-w-[96px] truncate">{paths.get(c.deck_id)?.split("::").pop()}</span>
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const sheets = (
    <>
      <CardEditorSheet item={item} open={adding} card={null} defaultDeck={deck || undefined} onClose={() => setAdding(false)} ask={ask} />
      {!sideEditor && <CardEditorSheet item={item} open={!!open} card={open} onClose={() => setOpenId(null)} ask={ask} />}
      <BulkSheet
        item={item}
        kind={bulk}
        ids={sel}
        onClose={(done) => {
          setBulk(null);
          if (done) {
            setSel(new Set());
            setSelecting(false);
          }
        }}
      />
    </>
  );

  if (isPhone)
    return (
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 px-4 pb-2 pt-3">
          {search}
          <p className="mt-2 text-xs text-[var(--text-muted)]" aria-live="polite">
            {hits.length} of {data.cards.length} cards
          </p>
        </div>
        {bulkBar}
        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)] bg-[var(--surface)]">{list}</div>
        {item.canEdit && !selecting && <Fab label="Add" icon={Plus} onClick={() => setAdding(true)} />}
        {sheets}
      </div>
    );

  return (
    <div ref={rootRef} className="flex h-full min-h-0">
      {/* filters */}
      {sideFilters && (
        <aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--border)] p-4 xl:w-60">
          <div>
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Decks</p>
            <SideItem active={!deck} onClick={() => setDeck("")} label="All decks" n={data.cards.length} />
            {deckTree(data.decks).map(({ deck: d, depth }) => (
              <SideItem key={d.id} active={deck === d.id} onClick={() => setDeck(d.id)} label={d.name} depth={depth} color={d.color} />
            ))}
          </div>
          {tags.length > 0 && (
            <div>
              <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Tags</p>
              <SideItem active={!tag} onClick={() => setTag("")} label="Any tag" />
              {tags.slice(0, 60).map((t) => (
                <SideItem key={t.tag} active={tag === t.tag} onClick={() => setTag(t.tag)} label={`#${t.tag}`} n={t.n} />
              ))}
            </div>
          )}
        </aside>
      )}
      {/* list */}
      <section className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        {search}
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span aria-live="polite">
            {hits.length} of {data.cards.length} cards
          </span>
          <div className="flex items-center gap-1">
            <ItemButton
              size="sm"
              variant="ghost"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              onClick={() =>
                ask(
                  `Look at the cards matching "${full || "everything"}" and suggest improvements (ambiguous prompts, cards holding several facts, missing reverses).`,
                )
              }
            >
              Review with AI
            </ItemButton>
            {item.canEdit && (
              <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
                Add card
              </ItemButton>
            )}
          </div>
        </div>
        {bulkBar}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">{list}</div>
      </section>
      {/* editor */}
      {sideEditor && (
        <aside
          className={cn(
            "shrink-0 overflow-y-auto border-l border-[var(--border)] p-4",
            width >= 1200 ? "w-[440px]" : width >= 1000 ? "w-[380px]" : "w-[min(400px,50%)]",
          )}
        >
          {desktopOpen ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text)]">Edit card</h2>
                <IconButton label="Close editor" icon={X} onClick={() => setOpenId(null)} />
              </div>
              <CardForm key={desktopOpen.id} item={item} card={desktopOpen} onDone={(saved) => !saved && setOpenId(null)} ask={ask} autoFocus={false} compact />
            </>
          ) : (
            <EmptyState icon={ListChecks} title="Pick a card" text="Select a card to edit it here, with a live preview. Ctrl+Enter saves." />
          )}
        </aside>
      )}
      {sheets}
    </div>
  );
}

/** A compact dropdown that sizes to its value (filter row). */
function PillSelect({
  label,
  value,
  active,
  onChange,
  children,
}: {
  label: string;
  value: string;
  active: boolean;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "h-9 max-w-[200px] appearance-none truncate rounded-full border pl-3 pr-8 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
          active
            ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]"
            : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
    </span>
  );
}

function SideItem({
  active,
  onClick,
  label,
  n,
  depth = 0,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  n?: number;
  depth?: number;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition",
        active
          ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] font-medium text-[var(--text)]"
          : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {color && <DeckDot color={color} size={8} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {n !== undefined && <span className="text-xs tabular-nums">{n}</span>}
    </button>
  );
}

function BulkSheet({
  item,
  kind,
  ids,
  onClose,
}: {
  item: ItemHandle<Data>;
  kind: "move" | "tag" | "delete" | "reset" | null;
  ids: Set<string>;
  onClose: (done: boolean) => void;
}) {
  const [deck, setDeck] = useState("");
  const [newDeck, setNewDeck] = useState("");
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");
  useEffect(() => {
    if (kind) {
      setDeck(item.data.decks[0]?.id ?? "");
      setNewDeck("");
      setAdd("");
      setRemove("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const n = ids.size;
  const label = `${n} card${n === 1 ? "" : "s"}`;
  const at = F.iso(Date.now());
  const go = () => {
    if (kind === "move") {
      const seed = deckSeed();
      item.update((d) => {
        const target = newDeck.trim() ? ensureDeck(d, newDeck.trim(), seed) : deck;
        for (const c of d.cards) if (ids.has(c.id)) Object.assign(c, { deck_id: target, modified: at });
      });
    } else if (kind === "tag") {
      const plus = add.split(/[\s,]+/).filter(Boolean);
      const minus = new Set(
        remove
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((t) => t.toLowerCase()),
      );
      item.update((d) => {
        for (const c of d.cards) {
          if (!ids.has(c.id)) continue;
          const tags = c.tags.filter((t) => !minus.has(t.toLowerCase()));
          for (const t of plus) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
          c.tags = tags.slice(0, 30);
        }
      });
    } else if (kind === "reset") {
      item.update((d) => {
        for (const c of d.cards) if (ids.has(c.id)) c.srs = c.srs.map((s) => F.newSrs(s.k));
      });
    } else if (kind === "delete") {
      item.update((d) => {
        d.cards = d.cards.filter((c) => !ids.has(c.id));
        d.review_log = d.review_log.filter((e) => !ids.has(e.c));
      });
    }
    onClose(true);
  };
  const title = kind === "move" ? `Move ${label}` : kind === "tag" ? `Tag ${label}` : kind === "reset" ? `Reset ${label}?` : `Delete ${label}?`;
  return (
    <Sheet
      open={!!kind}
      onClose={() => onClose(false)}
      title={title}
      size="sm"
      footer={
        <>
          <ItemButton onClick={() => onClose(false)}>Cancel</ItemButton>
          <ItemButton variant={kind === "delete" ? "danger" : "primary"} block onClick={go} disabled={kind === "tag" && !add.trim() && !remove.trim()}>
            {kind === "move" ? "Move" : kind === "tag" ? "Apply" : kind === "reset" ? "Reset to new" : "Delete"}
          </ItemButton>
        </>
      }
    >
      {kind === "move" && (
        <div className="flex flex-col gap-3">
          <Field label="To deck">
            <DeckSelect decks={item.data.decks} value={deck} onChange={setDeck} />
          </Field>
          <Field label="…or a new deck" hint="Parent::Child works">
            <TextInput value={newDeck} onChange={(e) => setNewDeck(e.target.value)} placeholder="New deck name" />
          </Field>
        </div>
      )}
      {kind === "tag" && (
        <div className="flex flex-col gap-3">
          <Field label="Add tags">
            <TextInput autoFocus value={add} onChange={(e) => setAdd(e.target.value)} placeholder="exam-1 hard" />
          </Field>
          <Field label="Remove tags">
            <TextInput value={remove} onChange={(e) => setRemove(e.target.value)} placeholder="leech" />
          </Field>
        </div>
      )}
      {kind === "reset" && <p className="text-sm text-[var(--text)]">Their scheduling starts over as new cards. Review history stays in your stats.</p>}
      {kind === "delete" && (
        <p className="text-sm text-[var(--text)]">The cards and their review history are deleted. You can undo from the file's version history.</p>
      )}
    </Sheet>
  );
}
