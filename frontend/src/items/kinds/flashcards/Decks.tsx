import { Brain, ChevronDown, ChevronRight, FolderPlus, Import, Layers, ListFilter, Pencil, Plus, Settings2, Shuffle, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card as Panel, EmptyState, Fab, Field, IconButton, ItemButton, Page, Section, Sheet, Stat, TextArea, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { childrenOf, deckPaths, deckSeed, ensureDeck, oneLine, PALETTE, subtree } from "./cards";
import { CardEditorSheet } from "./CardEditor";
import { useAddIntent, DeckDot, DeckSelect, DueCounts, DueHeader, useCfg, useNow, useWidth } from "./common";
import { ImportSheet } from "./ImportSheet";
import { intents } from "./intents";
import { byDay, deckCounts, type DeckCount } from "./queue";
import { SettingsSheet } from "./SettingsSheet";
import type { Data, Deck } from "./types";

export function DecksTab({ item, isPhone, ask, goTo }: ItemViewProps<Data>) {
  const data = item.data;
  const cfg = useCfg(data);
  const now = useNow();
  const counts = useMemo(() => deckCounts(data, now, cfg), [data, now, cfg]);
  const kids = useMemo(() => childrenOf(data.decks), [data.decks]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Deck | "new" | null>(null);
  const [newParent, setNewParent] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null | false>(false);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState(false);
  useAddIntent(() => setAdding(selected));
  const sel = data.decks.find((d) => d.id === selected) ?? (!isPhone ? data.decks[0] : undefined) ?? null;

  const study = (deck: string | null) => {
    intents.study = { deck };
    goTo("study");
  };
  const cram = (deck: string | null) => {
    intents.cram = { deck };
    goTo("study");
  };
  const browse = (deck: Deck) => {
    const p = deckPaths(data.decks).get(deck.id) ?? deck.name;
    intents.browse = { query: `deck:"${p}"` };
    goTo("browse");
  };

  const rows: { deck: Deck; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const d of kids.get(parent) ?? []) {
      rows.push({ deck: d, depth });
      if (!collapsed.has(d.id) && depth < 20) walk(d.id, depth + 1);
    }
  };
  walk(null, 0);

  const toolbar = (
    <div className="flex items-center gap-1">
      {item.canEdit && (
        <IconButton
          label="New deck"
          icon={FolderPlus}
          onClick={() => {
            setNewParent(null);
            setEditing("new");
          }}
        />
      )}
      {item.canEdit && <IconButton label="Import & export" icon={Import} onClick={() => setImporting(true)} />}
      <IconButton label="Study settings" icon={Settings2} onClick={() => setSettings(true)} />
    </div>
  );

  const list = (
    <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center justify-end py-1.5 pr-3">
        <DueHeader />
      </div>
      {rows.map(({ deck, depth }) => {
        const k = counts.get(deck.id);
        const hasKids = (kids.get(deck.id) ?? []).length > 0;
        const active = !isPhone && sel?.id === deck.id;
        return (
          <div
            key={deck.id}
            className={cn("relative flex min-h-[56px] items-center", active && "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]")}
            style={{ paddingLeft: depth * 18 }}
          >
            {active && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[var(--item-accent)]" />}
            <button
              type="button"
              aria-label={hasKids ? (collapsed.has(deck.id) ? `Expand ${deck.name}` : `Collapse ${deck.name}`) : undefined}
              aria-hidden={!hasKids}
              tabIndex={hasKids ? 0 : -1}
              onClick={() =>
                hasKids &&
                setCollapsed((s) => {
                  const n = new Set(s);
                  if (n.has(deck.id)) n.delete(deck.id);
                  else n.add(deck.id);
                  return n;
                })
              }
              className={cn("flex h-11 w-8 shrink-0 items-center justify-center text-[var(--text-muted)]", !hasKids && "invisible")}
            >
              {collapsed.has(deck.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setSelected(deck.id)}
              aria-current={active ? "true" : undefined}
              className="flex min-h-[56px] min-w-0 flex-1 items-center gap-3 py-2 pr-3 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
            >
              <DeckDot color={deck.color} size={12} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text)]">{deck.name}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {k?.cards ?? 0} card{k?.cards === 1 ? "" : "s"}
                  {deck.description ? ` · ${deck.description}` : ""}
                </span>
              </span>
              <DueCounts fresh={k?.fresh ?? 0} learning={k?.learning ?? 0} review={k?.review ?? 0} />
            </button>
          </div>
        );
      })}
    </div>
  );

  const empty = (
    <EmptyState
      icon={Layers}
      title="No decks yet"
      text="Decks hold your cards. Nest them with “Parent::Child” names, like Spanish::Verbs."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {item.canEdit && (
            <ItemButton variant="primary" icon={<FolderPlus className="h-4 w-4" />} onClick={() => setEditing("new")}>
              New deck
            </ItemButton>
          )}
          {item.canEdit && (
            <ItemButton icon={<Import className="h-4 w-4" />} onClick={() => setImporting(true)}>
              Import
            </ItemButton>
          )}
          <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Build me a deck — ask me the topic or which of my files to use.")}>
            Ask AI
          </ItemButton>
        </div>
      }
    />
  );

  const detailFor = (d: Deck) => (
    <DeckDetail
      item={item}
      deck={d}
      counts={counts.get(d.id)}
      onStudy={() => study(d.id)}
      onCram={() => cram(d.id)}
      onBrowse={() => browse(d)}
      onAdd={() => setAdding(d.id)}
      onEdit={() => setEditing(d)}
      onSub={() => {
        setNewParent(d.id);
        setEditing("new");
      }}
      ask={ask}
    />
  );

  return (
    <>
      {isPhone ? (
        <Page>
          <Section title="Decks" action={toolbar}>
            {data.decks.length ? list : empty}
          </Section>
          {item.canEdit && data.decks.length > 0 && <Fab label="Add card" icon={Plus} onClick={() => setAdding(selected)} />}
          <Sheet open={!!selected && !!sel} onClose={() => setSelected(null)} title={sel ? deckPaths(data.decks).get(sel.id) : ""} size="lg">
            {sel && detailFor(sel)}
          </Sheet>
        </Page>
      ) : (
        <Page wide>
          {data.decks.length ? (
            <div className="grid grid-cols-[minmax(240px,320px)_minmax(0,1fr)] gap-5">
              <Section title="Decks" action={toolbar}>
                {list}
              </Section>
              <div className="min-w-0">{sel && <Panel>{detailFor(sel)}</Panel>}</div>
            </div>
          ) : (
            <Section title="Decks" action={toolbar}>
              {empty}
            </Section>
          )}
        </Page>
      )}
      <DeckEditor
        item={item}
        open={editing !== null}
        deck={editing === "new" ? null : editing}
        parent={newParent}
        onClose={() => setEditing(null)}
        onSaved={(id) => setSelected(id)}
        onDeleted={() => setSelected(null)}
      />
      <CardEditorSheet item={item} open={adding !== false} card={null} defaultDeck={adding || undefined} onClose={() => setAdding(false)} ask={ask} />
      <ImportSheet item={item} open={importing} onClose={() => setImporting(false)} />
      <SettingsSheet item={item} open={settings} onClose={() => setSettings(false)} ask={ask} />
    </>
  );
}

function DeckDetail({
  item,
  deck,
  counts,
  onStudy,
  onCram,
  onBrowse,
  onAdd,
  onEdit,
  onSub,
  ask,
}: {
  item: ItemHandle<Data>;
  deck: Deck;
  counts?: DeckCount;
  onStudy: () => void;
  onCram: () => void;
  onBrowse: () => void;
  onAdd: () => void;
  onEdit: () => void;
  onSub: () => void;
  ask: (p: string) => void;
}) {
  const data = item.data;
  const cfg = useCfg(data);
  const path = deckPaths(data.decks).get(deck.id) ?? deck.name;
  const ids = useMemo(() => subtree(data.decks, deck.id), [data.decks, deck.id]);
  const cards = useMemo(() => data.cards.filter((c) => ids.has(c.deck_id)), [data.cards, ids]);
  const stats = useMemo(() => {
    const cardIds = new Set(cards.map((c) => c.id));
    const since = Date.now() - 30 * 86_400_000;
    const recent = data.review_log.filter((e) => cardIds.has(e.c) && Date.parse(e.t) >= since);
    const days = byDay(recent, cfg, null);
    let rev = 0;
    let pass = 0;
    for (const v of days.values()) {
      rev += v.reviews;
      pass += v.pass;
    }
    let mature = 0;
    let items = 0;
    for (const c of cards)
      for (const s of c.srs) {
        items++;
        if (s.state === "review" && (s.stability ?? 0) >= 21) mature++;
      }
    return {
      reviews: recent.length,
      retention: rev ? pass / rev : null,
      mature,
      items,
    };
  }, [cards, data.review_log, cfg]);
  const due = counts ? counts.fresh + counts.learning + counts.review : 0;
  const [boxRef, w] = useWidth<HTMLDivElement>();
  return (
    <div ref={boxRef} className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="mt-1.5">
          <DeckDot color={deck.color} size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-[var(--text)]">{path}</h2>
          {deck.description && <p className="whitespace-pre-line text-sm text-[var(--text-muted)]">{deck.description}</p>}
        </div>
        {item.canEdit && <IconButton label="Edit deck" icon={Pencil} onClick={onEdit} />}
      </div>
      <div className={cn("grid gap-3", w >= 620 ? "grid-cols-4" : "grid-cols-2")}>
        <Stat label="Cards" value={cards.length} />
        <Stat label="Due today" value={due} tone={due ? "accent" : "neutral"} delta={counts ? `${counts.fresh} new · ${counts.review} review` : undefined} />
        <Stat
          label="Retention (30 d)"
          value={stats.retention === null ? "–" : `${Math.round(stats.retention * 100)}%`}
          delta={`target ${Math.round(data.settings.desired_retention * 100)}%`}
          tone={stats.retention === null ? "neutral" : stats.retention >= data.settings.desired_retention - 0.03 ? "good" : "bad"}
        />
        <Stat
          label="Mature"
          value={stats.items ? `${Math.round((stats.mature / stats.items) * 100)}%` : "–"}
          delta={`${stats.mature} of ${stats.items} items`}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ItemButton variant="primary" size="lg" icon={<Brain className="h-4 w-4" />} disabled={!due || !item.canEdit} onClick={onStudy}>
          {due ? `Study ${due}` : "Nothing due"}
        </ItemButton>
        <ItemButton size="lg" className="whitespace-nowrap" icon={<Shuffle className="h-4 w-4" />} disabled={!cards.length} onClick={onCram}>
          Custom study
        </ItemButton>
      </div>
      <div className="flex flex-wrap gap-2">
        <ItemButton icon={<ListFilter className="h-4 w-4" />} onClick={onBrowse}>
          Browse
        </ItemButton>
        {item.canEdit && (
          <ItemButton icon={<Plus className="h-4 w-4" />} onClick={onAdd}>
            Add card
          </ItemButton>
        )}
        {item.canEdit && (
          <ItemButton icon={<FolderPlus className="h-4 w-4" />} onClick={onSub}>
            Subdeck
          </ItemButton>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <ItemButton
          size="sm"
          variant="ghost"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onClick={() => ask(`Add 15 more good cards to the deck "${path}" — fill gaps in what it already covers.`)}
        >
          Add cards with AI
        </ItemButton>
        <ItemButton
          size="sm"
          variant="ghost"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onClick={() => ask(`Find the weakest cards in "${path}" (most lapses) and rewrite them better.`)}
        >
          Fix weak cards
        </ItemButton>
        <ItemButton
          size="sm"
          variant="ghost"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onClick={() => ask(`Quiz me on "${path}" here in the panel — one question at a time, don't change my scheduling.`)}
        >
          Quiz me
        </ItemButton>
      </div>
      {cards.length > 0 && (
        <Section
          title="Recently added"
          action={
            <ItemButton size="sm" variant="ghost" onClick={onBrowse}>
              All {cards.length}
            </ItemButton>
          }
        >
          <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)]">
            {cards
              .slice()
              .sort((a, b) => b.created.localeCompare(a.created))
              .slice(0, 6)
              .map((c) => (
                <div key={c.id} className="px-3 py-2">
                  <p className="truncate text-sm text-[var(--text)]">{oneLine(c.front)}</p>
                  {c.back && <p className="truncate text-xs text-[var(--text-muted)]">{oneLine(c.back)}</p>}
                </div>
              ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function DeckEditor({
  item,
  open,
  deck,
  parent,
  onClose,
  onSaved,
  onDeleted,
}: {
  item: ItemHandle<Data>;
  open: boolean;
  deck: Deck | null;
  parent: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const data = item.data;
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [confirm, setConfirm] = useState(false);
  const [newLim, setNewLim] = useState("");
  const [revLim, setRevLim] = useState("");
  useEffect(() => {
    if (!open) return;
    setNewLim(deck?.new_per_day != null ? String(deck.new_per_day) : "");
    setRevLim(deck?.max_reviews_per_day != null ? String(deck.max_reviews_per_day) : "");
    setName(deck?.name ?? "");
    setParentId(deck?.parent_id ?? parent ?? "");
    setDesc(deck?.description ?? "");
    setColor(deck?.color ?? PALETTE[data.decks.length % PALETTE.length]);
    setConfirm(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deck?.id]);
  const inside = deck ? subtree(data.decks, deck.id) : new Set<string>();
  const nCards = deck ? data.cards.filter((c) => inside.has(c.deck_id)).length : 0;
  const parents = data.decks.filter((d) => !inside.has(d.id));
  const limit = (v: string, max: number): number | null | undefined => {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
  };
  const nl = limit(newLim, 9999);
  const rl = limit(revLim, 99_999);
  const valid = name.trim().length > 0 && (deck ? !name.includes("::") : true) && nl !== undefined && rl !== undefined;

  const save = () => {
    if (!valid) return;
    const seed = deckSeed();
    let id = deck?.id ?? "";
    item.update((d) => {
      if (deck) {
        const x = d.decks.find((k) => k.id === deck.id);
        if (!x) return;
        // Only the fields changed in this sheet (mutators replay on newer data).
        if (name.trim() !== deck.name) x.name = name.trim();
        if ((parentId || null) !== (deck.parent_id ?? null)) x.parent_id = parentId || null;
        if (desc !== deck.description) x.description = desc;
        if (color !== deck.color) x.color = color;
        if ((nl ?? null) !== (deck.new_per_day ?? null)) x.new_per_day = nl ?? null;
        if ((rl ?? null) !== (deck.max_reviews_per_day ?? null)) x.max_reviews_per_day = rl ?? null;
      } else {
        const prefix = parentId ? `${deckPaths(d.decks).get(parentId)}::` : "";
        id = ensureDeck(d, prefix + name.trim(), seed, color, desc);
        const x = d.decks.find((k) => k.id === id);
        if (x && nl != null) x.new_per_day = nl;
        if (x && rl != null) x.max_reviews_per_day = rl;
      }
    });
    onSaved(id);
    onClose();
  };

  const remove = (mode: "move" | "delete") => {
    if (!deck) return;
    const seed = deckSeed();
    item.update((d) => {
      const ids = subtree(d.decks, deck.id);
      if (mode === "delete") {
        const gone = new Set(d.cards.filter((c) => ids.has(c.deck_id)).map((c) => c.id));
        d.cards = d.cards.filter((c) => !gone.has(c.id));
        d.review_log = d.review_log.filter((e) => !gone.has(e.c));
      } else {
        const target = deck.parent_id ?? d.decks.find((k) => !ids.has(k.id))?.id ?? ensureDeck(d, "Default", seed);
        for (const c of d.cards) if (ids.has(c.deck_id)) c.deck_id = target;
      }
      d.decks = d.decks.filter((k) => !ids.has(k.id));
    });
    onDeleted();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={deck ? "Edit deck" : "New deck"}
      footer={
        <ItemButton variant="primary" block disabled={!valid} onClick={save}>
          {deck ? "Save" : "Create deck"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint={deck ? undefined : "Use :: to nest, e.g. Spanish::Verbs"}>
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            maxLength={deck ? 120 : 400}
          />
        </Field>
        <Field label="Inside">
          <DeckSelect decks={parents} value={parentId} onChange={setParentId} allLabel="— Top level —" />
        </Field>
        <Field label="Description">
          <TextArea value={desc} onChange={(e) => setDesc(e.target.value)} className="min-h-[64px]" maxLength={2000} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Own new cards a day" hint="Empty = only the overall limit">
            <TextInput
              inputMode="numeric"
              value={newLim}
              onChange={(e) => setNewLim(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={`${data.settings.new_per_day} (all decks)`}
              aria-invalid={nl === undefined}
            />
          </Field>
          <Field label="Own reviews a day" hint="Covers its subdecks too">
            <TextInput
              inputMode="numeric"
              value={revLim}
              onChange={(e) => setRevLim(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={`${data.settings.max_reviews_per_day} (all decks)`}
              aria-invalid={rl === undefined}
            />
          </Field>
        </div>
        <Field label="Colour">
          <div className="flex flex-wrap gap-2">
            {PALETTE.map((p) => (
              <button
                key={p}
                type="button"
                aria-label={`Colour ${p}`}
                aria-pressed={color === p}
                onClick={() => setColor(p)}
                className={cn("h-9 w-9 rounded-full border-2 transition", color === p ? "border-[var(--text)] scale-110" : "border-transparent")}
                style={{ background: p }}
              />
            ))}
          </div>
        </Field>
        {deck && (
          <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
            {confirm ? (
              nCards ? (
                <>
                  <p className="text-sm text-[var(--text)]">
                    This deck {inside.size > 1 ? "and its subdecks hold" : "holds"} {nCards} card{nCards === 1 ? "" : "s"}.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <ItemButton onClick={() => remove("move")}>Delete deck, keep cards</ItemButton>
                    <ItemButton variant="danger" onClick={() => remove("delete")}>
                      Delete deck and cards
                    </ItemButton>
                  </div>
                </>
              ) : (
                <ItemButton variant="danger" onClick={() => remove("delete")}>
                  Delete “{deck.name}”
                </ItemButton>
              )
            ) : (
              <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="self-start text-[var(--danger)]" onClick={() => setConfirm(true)}>
                Delete deck…
              </ItemButton>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
