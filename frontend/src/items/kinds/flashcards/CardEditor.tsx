import { Brackets, Eye, Flag, ImagePlus, Link2, Mic, PauseCircle, RotateCcw, Sigma, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Chip, Field, IconButton, ItemButton, Segmented, Sheet, TextArea, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { allTags, cardProblem, cardState, clozeNumbers, deckSeed, ensureDeck, newCard, normFront, reconcile, TYPE_LABEL } from "./cards";
import { DeckSelect, fmtDue, StateBadge } from "./common";
import { Face } from "./Face";
import { linkMarkdown, uploadMedia } from "./media";
import * as F from "./fsrs";
import type { Card, CardType, Data } from "./types";

const TYPES: { value: CardType; label: string }[] = [
  { value: "basic", label: "Basic" },
  { value: "reversed", label: "Both ways" },
  { value: "cloze", label: "Cloze" },
  { value: "typein", label: "Type" },
];

interface Draft {
  deck: string;
  type: CardType;
  front: string;
  back: string;
  note: string;
  tags: string;
}

const parseTags = (s: string) =>
  [...new Set(s.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean))].slice(0, 30);

/**
 * Add or edit one card: deck, type, front/back with a cloze helper and a
 * math helper, note, tags, and a live preview of every review item.
 */
export function CardForm({
  item,
  card,
  defaultDeck,
  onDone,
  ask,
  autoFocus = true,
  compact,
}: {
  item: ItemHandle<Data>;
  card: Card | null;
  defaultDeck?: string;
  onDone?: (saved: Card | null) => void;
  ask?: (p: string) => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const data = item.data;
  const init = (): Draft => ({
    deck: card?.deck_id ?? defaultDeck ?? data.decks[0]?.id ?? "",
    type: card?.type ?? "basic",
    front: card?.front ?? "",
    back: card?.back ?? "",
    note: card?.note ?? "",
    tags: card?.tags.join(" ") ?? "",
  });
  const [d, setD] = useState<Draft>(init);
  const [showNote, setShowNote] = useState(!!card?.note);
  const [preview, setPreview] = useState(false);
  const [added, setAdded] = useState(0);
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLTextAreaElement>(null);
  const last = useRef<"front" | "back">("front");
  const fileRef = useRef<HTMLInputElement>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaErr, setMediaErr] = useState<string | null>(null);
  const [linking, setLinking] = useState<null | "image" | "audio">(null);
  const [link, setLink] = useState("");
  // Re-seed when the card changes (desktop inline editor).
  useEffect(() => {
    setD(init());
    setShowNote(!!card?.note);
    setPreview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  const problem = cardProblem(d);
  const dirty = !card || d.front !== card.front || d.back !== card.back || d.note !== card.note || d.type !== card.type || d.deck !== card.deck_id || d.tags !== card.tags.join(" ");
  const dup = useMemo(() => {
    if (card || !d.front.trim()) return false;
    const key = normFront(d.front);
    return data.cards.some((c) => c.deck_id === d.deck && normFront(c.front) === key);
  }, [card, d.front, d.deck, data.cards]);
  const tagSuggestions = useMemo(() => allTags(data.cards).slice(0, 12), [data.cards]);
  const nowTags = parseTags(d.tags);

  const wrap = (kind: "cloze" | "cloze-same" | "math") => {
    const which = kind === "math" ? last.current : "front";
    const el = which === "front" ? frontRef.current : backRef.current;
    const value = which === "front" ? d.front : d.back;
    const a = el?.selectionStart ?? value.length;
    const b = el?.selectionEnd ?? value.length;
    const sel = value.slice(a, b);
    let ins: string;
    let caret: [number, number];
    if (kind === "math") {
      ins = `$${sel || "x^2"}$`;
      caret = [a + 1, a + 1 + (sel || "x^2").length];
    } else {
      const nums = clozeNumbers(value);
      const max = nums.length ? Math.max(...nums) : 0;
      const n = kind === "cloze-same" ? Math.max(1, max) : max + 1;
      const pre = `{{c${n}::`;
      ins = `${pre}${sel || "answer"}}}`;
      caret = [a + pre.length, a + pre.length + (sel || "answer").length];
    }
    const next = value.slice(0, a) + ins + value.slice(b);
    setD((x) => ({ ...x, [which]: next, ...(kind !== "math" ? { type: "cloze" as CardType } : {}) }));
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(caret[0], caret[1]);
    }, 0);
  };

  /** Put ``md`` (media Markdown) at the cursor of the last field used. */
  const insert = (md: string) => {
    const which = last.current;
    const el = which === "front" ? frontRef.current : backRef.current;
    setD((x) => {
      const value = x[which];
      const a = el?.selectionStart ?? value.length;
      const b = el?.selectionEnd ?? value.length;
      const pre = value.slice(0, a);
      const glue = pre && !pre.endsWith("\n") ? "\n" : "";
      return { ...x, [which]: `${pre}${glue}${md}\n${value.slice(b)}` };
    });
  };

  const pickMedia = async (files: FileList | null) => {
    const list = files ? [...files] : [];
    if (!list.length) return;
    setMediaBusy(true);
    setMediaErr(null);
    try {
      for (const f of list.slice(0, 5)) insert((await uploadMedia(f)).markdown);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setMediaErr(typeof detail === "string" ? detail : e instanceof Error ? e.message : "That file couldn't be added.");
    } finally {
      setMediaBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      wrap(e.altKey ? "cloze-same" : "cloze");
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      save(!card);
    }
  };

  const save = (another: boolean) => {
    if (problem || !item.canEdit) return;
    const tags = parseTags(d.tags);
    // Ids and times are made here, not in the mutator (mutators replay).
    const seed = deckSeed();
    const at = F.iso(Date.now());
    const fresh = card ? null : newCard(d.deck, d.type, d.front, d.back, d.note, tags);
    const savedId = card?.id ?? fresh!.id;
    item.update((x) => {
      let deckId = d.deck;
      if (!deckId || !x.decks.some((k) => k.id === deckId)) deckId = ensureDeck(x, "Default", seed);
      if (card) {
        const c = x.cards.find((k) => k.id === card.id);
        if (!c) return;
        // Only what changed in this sheet — an edit elsewhere (another
        // device, the assistant) to the other fields survives.
        if (d.deck !== card.deck_id) c.deck_id = deckId;
        if (d.type !== card.type) c.type = d.type;
        if (d.front !== card.front) c.front = d.front.trim();
        if (d.back !== card.back) c.back = d.back.trim();
        if (d.note !== card.note) c.note = d.note.trim();
        if (d.tags !== card.tags.join(" ")) c.tags = tags;
        c.modified = at;
        reconcile(c);
      } else if (fresh && !x.cards.some((k) => k.id === fresh.id)) {
        x.cards.push({ ...JSON.parse(JSON.stringify(fresh)), deck_id: deckId });
      }
    });
    if (another) {
      setAdded((n) => n + 1);
      setD((x) => ({ ...x, front: "", back: "", note: "" }));
      window.setTimeout(() => frontRef.current?.focus(), 30);
    } else {
      onDone?.({ ...(card ?? ({} as Card)), id: savedId } as Card);
    }
  };

  const ro = !item.canEdit;
  const live = card ? data.cards.find((c) => c.id === card.id) ?? card : null;
  const previewCard: Card = reconcile({
    ...(live ?? newCard(d.deck, d.type, d.front, d.back, d.note, nowTags)),
    type: d.type,
    front: d.front,
    back: d.back,
    note: d.note,
    srs: live?.srs ?? [],
  });
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4" onKeyDown={keys}>
      <div className={cn("grid gap-3", compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-[1fr_auto]")}>
        <Field label="Deck">
          <DeckSelect decks={data.decks} value={d.deck} onChange={(v) => setD((x) => ({ ...x, deck: v }))} />
        </Field>
        <Field label="Type">
          <Segmented size="sm" value={d.type} onChange={(v) => setD((x) => ({ ...x, type: v }))} options={TYPES} className="h-11 w-full items-center md:h-10" />
        </Field>
      </div>

      <Field
        label={
          <span className="flex items-center justify-between gap-2">
            <span>{d.type === "cloze" ? "Text with deletions" : "Front"}</span>
          </span>
        }
        hint={d.type === "cloze" ? "Select a word and tap Cloze — or type {{c1::answer::hint}}. Same number = hidden together." : "Markdown and $math$ work."}
      >
        <TextArea
          ref={frontRef}
          autoFocus={autoFocus}
          readOnly={ro}
          value={d.front}
          onFocus={() => (last.current = "front")}
          onChange={(e) => setD((x) => ({ ...x, front: e.target.value }))}
          placeholder={d.type === "cloze" ? "The {{c1::mitochondrion}} is the powerhouse of the cell." : d.type === "typein" ? "Spanish for “dog”" : "What does ATP stand for?"}
          className="min-h-[96px]"
        />
      </Field>
      {!ro && (
        <div className="-mt-2 flex flex-wrap gap-2">
          <ItemButton size="sm" icon={<Brackets className="h-3.5 w-3.5" />} onClick={() => wrap("cloze")} title="Ctrl+Shift+C">
            Cloze
          </ItemButton>
          {d.type === "cloze" && clozeNumbers(d.front).length > 0 && (
            <ItemButton size="sm" variant="ghost" onClick={() => wrap("cloze-same")} title="Ctrl+Shift+Alt+C">
              Same number
            </ItemButton>
          )}
          <ItemButton size="sm" variant="ghost" icon={<Sigma className="h-3.5 w-3.5" />} onClick={() => wrap("math")}>
            Math
          </ItemButton>
          <ItemButton
            size="sm"
            variant="ghost"
            icon={<ImagePlus className="h-3.5 w-3.5" />}
            disabled={mediaBusy}
            onClick={() => fileRef.current?.click()}
            title="Add an image or audio file (saved in Drive → Flashcards media)"
          >
            {mediaBusy ? "Uploading…" : "Image / audio"}
          </ItemButton>
          <ItemButton size="sm" variant="ghost" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setLinking((v) => (v ? null : "image"))}>
            From link
          </ItemButton>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,audio/*,.mp3,.m4a,.ogg,.wav"
            multiple
            className="hidden"
            onChange={(e) => pickMedia(e.target.files)}
          />
        </div>
      )}
      {!ro && linking && (
        <div className="-mt-1 flex flex-wrap items-center gap-2">
          <TextInput value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/picture.png" aria-label="Media link" className="min-w-0 flex-1" />
          <ItemButton size="sm" variant={linking === "audio" ? "primary" : "ghost"} icon={<Mic className="h-3.5 w-3.5" />} onClick={() => setLinking(linking === "audio" ? "image" : "audio")} aria-pressed={linking === "audio"}>
            Audio
          </ItemButton>
          <ItemButton
            size="sm"
            variant="primary"
            disabled={!linkMarkdown(link, linking === "audio")}
            onClick={() => {
              const md = linkMarkdown(link, linking === "audio");
              if (md) insert(md);
              setLink("");
              setLinking(null);
            }}
          >
            Insert
          </ItemButton>
        </div>
      )}
      {!ro && (
        <p className="-mt-2 text-xs text-[var(--text-muted)]">
          Media go into the field you used last ({last.current === "front" ? "front" : "back"}) and are stored in your Drive; they show offline once seen on this device.
        </p>
      )}
      {mediaErr && (
        <p className="-mt-1 text-sm text-[var(--danger)]" role="alert">
          {mediaErr}
        </p>
      )}

      <Field label={d.type === "cloze" ? "Extra (optional)" : d.type === "typein" ? "Answer to type" : "Back"}>
        <TextArea
          ref={backRef}
          readOnly={ro}
          value={d.back}
          onFocus={() => (last.current = "back")}
          onChange={(e) => setD((x) => ({ ...x, back: e.target.value }))}
          placeholder={d.type === "cloze" ? "Shown after the answer" : d.type === "typein" ? "perro" : "Adenosine triphosphate"}
          className={d.type === "typein" ? "min-h-[56px]" : "min-h-[80px]"}
        />
      </Field>

      {showNote ? (
        <Field label="Note — source, mnemonic or explanation (shown after answering)">
          <TextArea readOnly={ro} value={d.note} onChange={(e) => setD((x) => ({ ...x, note: e.target.value }))} className="min-h-[64px]" />
        </Field>
      ) : (
        !ro && (
          <button type="button" className="-mt-1 self-start text-sm font-medium text-[var(--item-accent)]" onClick={() => setShowNote(true)}>
            + Add a note
          </button>
        )
      )}

      <Field label="Tags">
        <TextInput readOnly={ro} value={d.tags} onChange={(e) => setD((x) => ({ ...x, tags: e.target.value }))} placeholder="biology exam-1" />
      </Field>
      {!ro && tagSuggestions.length > 0 && (
        <div className="-mt-2 flex flex-wrap gap-1.5">
          {tagSuggestions.map(({ tag }) => {
            const on = nowTags.some((t) => t.toLowerCase() === tag.toLowerCase());
            return (
              <Chip
                key={tag}
                active={on}
                onClick={() =>
                  setD((x) => ({
                    ...x,
                    tags: on ? parseTags(x.tags).filter((t) => t.toLowerCase() !== tag.toLowerCase()).join(" ") : [...parseTags(x.tags), tag].join(" "),
                  }))
                }
              >
                {tag}
              </Chip>
            );
          })}
        </div>
      )}

      {(problem && d.front.trim()) || dup ? (
        <p className="text-sm text-[var(--warning)]" role="status">
          {problem && d.front.trim() ? problem : "A card with this front is already in that deck."}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <button type="button" onClick={() => setPreview((v) => !v)} className="flex items-center gap-1.5 self-start text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
          <Eye className="h-4 w-4" /> {preview ? "Hide preview" : `Preview (${previewCard.srs.length} review item${previewCard.srs.length === 1 ? "" : "s"})`}
        </button>
        {preview && d.front.trim() && (
          <div className="flex flex-col gap-2">
            {previewCard.srs.map((s) => (
              <div key={s.k} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {s.k === "f" ? "Front → back" : s.k === "r" ? "Back → front" : `Cloze ${s.k.slice(1)}`}
                </p>
                <Face card={previewCard} k={s.k} revealed size="md" />
              </div>
            ))}
          </div>
        )}
      </div>

      {live && <CardFacts card={live} now={now} />}

      {!ro && (
        <div className="flex flex-wrap items-center gap-2">
          {card ? (
            <>
              <ItemButton variant="primary" disabled={!!problem || !dirty} onClick={() => save(false)}>
                Save
              </ItemButton>
              <CardTools item={item} card={live ?? card} onDeleted={() => onDone?.(null)} />
              {ask && (
                <ItemButton
                  variant="ghost"
                  size="sm"
                  icon={<Sparkles className="h-3.5 w-3.5" />}
                  onClick={() => ask(`Improve this card (id ${card.id}) following the 20 rules — explain what you changed.`)}
                >
                  Improve
                </ItemButton>
              )}
            </>
          ) : (
            <>
              <ItemButton variant="primary" disabled={!!problem} onClick={() => save(true)} title="Ctrl+Enter">
                Add
              </ItemButton>
              <ItemButton disabled={!!problem} onClick={() => save(false)}>
                Add & close
              </ItemButton>
              {added > 0 && <span className="text-sm text-[var(--text-muted)]" aria-live="polite">{added} added</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CardFacts({ card, now }: { card: Card; now: number }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
      <div className="flex flex-wrap items-center gap-2">
        <StateBadge state={cardState(card)} />
        {card.flagged && <span className="font-semibold text-[var(--warning)]">Flagged</span>}
        <span>{TYPE_LABEL[card.type]}</span>
      </div>
      {card.srs.map((s) => (
        <div key={s.k} className="flex flex-wrap gap-x-3 tabular-nums">
          <span className="font-medium text-[var(--text)]">{s.k === "f" ? "Front" : s.k === "r" ? "Reverse" : `Cloze ${s.k.slice(1)}`}</span>
          <span>{s.state}</span>
          {s.due && s.state !== "new" && <span>due {fmtDue(s.due, now)}</span>}
          {s.stability != null && <span>stability {s.stability < 1 ? s.stability.toFixed(2) : Math.round(s.stability)} d</span>}
          {s.difficulty != null && <span>difficulty {s.difficulty.toFixed(1)}</span>}
          <span>{s.reps} reviews</span>
          {s.lapses > 0 && <span className="text-[var(--danger)]">{s.lapses} lapses</span>}
        </div>
      ))}
    </div>
  );
}

export function CardTools({ item, card, onDeleted }: { item: ItemHandle<Data>; card: Card; onDeleted?: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const set = (fn: (c: Card) => void) =>
    item.update((x) => {
      const c = x.cards.find((k) => k.id === card.id);
      if (c) fn(c);
    });
  return (
    <div className="flex items-center gap-1">
      <IconButton
        label={card.flagged ? "Unflag" : "Flag"}
        icon={Flag}
        active={card.flagged}
        onClick={() => {
          const target = !card.flagged;
          set((c) => (c.flagged = target));
        }}
      />
      <IconButton
        label={card.suspended ? "Unsuspend" : "Suspend"}
        icon={PauseCircle}
        active={card.suspended}
        onClick={() => {
          const target = !card.suspended;
          set((c) => (c.suspended = target));
        }}
      />
      <IconButton
        label="Forget (reset to new)"
        icon={RotateCcw}
        onClick={() => {
          if (window.confirm("Reset this card to new? Its scheduling starts over.")) set((c) => (c.srs = c.srs.map((s) => F.newSrs(s.k))));
        }}
      />
      {confirm ? (
        <ItemButton
          size="sm"
          variant="danger"
          onClick={() => {
            item.update((x) => {
              x.cards = x.cards.filter((k) => k.id !== card.id);
              x.review_log = x.review_log.filter((e) => e.c !== card.id);
            });
            onDeleted?.();
          }}
        >
          Delete card
        </ItemButton>
      ) : (
        <IconButton label="Delete" icon={Trash2} onClick={() => setConfirm(true)} />
      )}
    </div>
  );
}

export function CardEditorSheet({
  item,
  open,
  card,
  defaultDeck,
  onClose,
  ask,
}: {
  item: ItemHandle<Data>;
  open: boolean;
  card: Card | null;
  defaultDeck?: string;
  onClose: () => void;
  ask?: (p: string) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={card ? "Edit card" : "Add cards"} size="lg">
      {open && <CardForm item={item} card={card} defaultDeck={defaultDeck} onDone={onClose} ask={ask} />}
    </Sheet>
  );
}
