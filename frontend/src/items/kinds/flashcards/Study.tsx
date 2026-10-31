import {
  BarChart3,
  Brain,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Flag,
  Flame,
  Import,
  Layers,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  Plus,
  Shuffle,
  Sparkles,
  Undo2,
  X,
  EyeOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import type { ItemViewProps } from "@/items/types";
import {
  Card as Panel,
  EmptyState,
  Field,
  IconButton,
  ItemButton,
  Page,
  ProgressBar,
  Section,
  Segmented,
  Select,
  Sheet,
  Stepper,
  TextInput,
  fmtDuration,
} from "@/items/ui";
import { cn } from "@/utils/cn";

import { allTags, deckPaths, deckTree, matches, subtree } from "./cards";
import { CardEditorSheet } from "./CardEditor";
import { useAddIntent, DeckDot, DueCounts, DueHeader, estimateMinutes, useCfg, useNow, usePaths, useToday } from "./common";
import { answerText, Face, typedCorrect } from "./Face";
import * as F from "./fsrs";
import { ImportSheet } from "./ImportSheet";
import { take } from "./intents";
import { countsOf, deckCounts, forecast, logInsertAt, nextItem, streak, today, todayLog, type QItem } from "./queue";
import type { Card, Data, Log, Srs } from "./types";

type Mode =
  | { kind: "study"; deck: string | null }
  | {
      kind: "cram";
      deck: string | null;
      items: { c: string; k: string }[];
      title: string;
      choice: boolean;
    };

export function StudyTab({ item, isPhone, ask, goTo }: ItemViewProps<Data>) {
  const [mode, setMode] = useState<Mode | null>(() => {
    const s = take("study");
    return s && item.canEdit ? { kind: "study", deck: s.deck } : null;
  });
  const [cram, setCram] = useState<string | null | false>(() => {
    const c = take("cram");
    return c ? c.deck : false;
  });
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  useAddIntent(() => setAdding(true));
  if (mode)
    return (
      <Session
        item={item}
        isPhone={isPhone}
        mode={mode}
        ask={ask}
        onExit={() => setMode(null)}
        onCram={(deck) => {
          setMode(null);
          setCram(deck);
        }}
      />
    );
  return (
    <>
      <Overview
        item={item}
        isPhone={isPhone}
        ask={ask}
        goTo={goTo}
        onStudy={(deck) => setMode({ kind: "study", deck })}
        onCram={(deck) => setCram(deck)}
        onAdd={() => setAdding(true)}
        onImport={() => setImporting(true)}
      />
      <CramSheet
        item={item}
        open={cram !== false}
        deck={cram === false ? null : cram}
        onClose={() => setCram(false)}
        onStart={(m) => {
          setCram(false);
          setMode(m);
        }}
      />
      <CardEditorSheet item={item} open={adding} card={null} onClose={() => setAdding(false)} ask={ask} />
      <ImportSheet item={item} open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

// ------------------------------------------------------------------ overview

function Overview({
  item,
  isPhone,
  ask,
  goTo,
  onStudy,
  onCram,
  onAdd,
  onImport,
}: {
  item: ItemHandle<Data>;
  isPhone: boolean;
  ask: (p: string) => void;
  goTo: (t: string) => void;
  onStudy: (deck: string | null) => void;
  onCram: (deck: string | null) => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  const data = item.data;
  const cfg = useCfg(data);
  const now = useNow();
  const t = useToday(data, now, cfg, null);
  const c = countsOf(t);
  const per = useMemo(() => deckCounts(data, now, cfg), [data, now, cfg]);
  const tree = useMemo(() => deckTree(data.decks), [data.decks]);
  const st = useMemo(() => streak(data.review_log, now, cfg), [data.review_log, now, cfg]);
  const week = useMemo(() => forecast(data, now, cfg, 8, null), [data, now, cfg]);
  const tomorrow = week[1] ?? 0;
  const dayNow = F.dayIndex(now, cfg);
  const examIn = data.settings.exam_date ? Math.round(Date.parse(`${data.settings.exam_date}T00:00:00Z`) / 86_400_000) - dayNow : null;
  const todayLogMs = useMemo(() => todayLog(data.review_log, now, cfg).reduce((ms, e) => ms + Math.min(e.d, 60_000), 0), [data.review_log, now, cfg]);

  if (!data.cards.length)
    return (
      <Page>
        <EmptyState
          icon={Layers}
          title="No cards yet"
          text="Write a few cards, bring a deck over from Anki or Quizlet, or let the assistant build one from your notes."
          action={
            <div className="flex flex-col items-stretch gap-2 sm:flex-row">
              {item.canEdit && (
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onAdd}>
                  Add cards
                </ItemButton>
              )}
              {item.canEdit && (
                <ItemButton icon={<Import className="h-4 w-4" />} onClick={onImport}>
                  Import
                </ItemButton>
              )}
              <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Make me a deck from my notes — ask which file or topic first.")}>
                Ask AI
              </ItemButton>
            </div>
          }
        />
      </Page>
    );

  const minutes = estimateMinutes(c.review + c.learning, c.fresh);
  const allDone = c.total === 0;
  const nextLearn = t.learningLater[0];
  const hero = (
    <Panel className="flex flex-col items-center gap-4 py-7 text-center">
      {allDone ? (
        <>
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--success-bg)] text-[var(--success)]">
            <CheckCircle2 className="h-8 w-8" />
          </span>
          <div>
            <p className="text-lg font-semibold text-[var(--text)]">All caught up</p>
            <p className="text-sm text-[var(--text-muted)]">
              {nextLearn
                ? `A learning card comes back ${new Date(nextLearn.dueMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
                : tomorrow
                  ? `${tomorrow} review${tomorrow === 1 ? "" : "s"} tomorrow.`
                  : "Nothing due tomorrow."}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <ItemButton icon={<Shuffle className="h-4 w-4" />} onClick={() => onCram(null)}>
              Custom study
            </ItemButton>
            {item.canEdit && (
              <ItemButton icon={<Plus className="h-4 w-4" />} onClick={onAdd}>
                Add cards
              </ItemButton>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center">
            <span className="text-6xl font-semibold tabular-nums tracking-tight text-[var(--text)]" aria-live="polite">
              {c.total}
            </span>
            <span className="text-sm text-[var(--text-muted)]">due today · about {minutes} min</span>
          </div>
          <div className="grid w-full max-w-xs grid-cols-3 divide-x divide-[var(--border)] rounded-2xl bg-[var(--surface-2)] py-2">
            {(
              [
                ["New", c.fresh, "var(--item-accent)"],
                ["Learning", c.learning, "var(--danger)"],
                ["Review", c.review, "var(--success)"],
              ] as const
            ).map(([label, v, tone]) => (
              <span key={label} className="flex flex-col items-center">
                <span className="text-lg font-semibold tabular-nums" style={{ color: v ? tone : "var(--text-muted)" }}>
                  {v}
                </span>
                <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
              </span>
            ))}
          </div>
          <ItemButton variant="primary" size="lg" block className="h-14 max-w-xs text-base" onClick={() => onStudy(null)} disabled={!item.canEdit}>
            <Brain className="h-5 w-5" /> Study now
          </ItemButton>
          {!item.canEdit && <p className="text-xs text-[var(--text-muted)]">View only — studying needs edit access.</p>}
        </>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5" title="Study streak">
          <Flame className={cn("h-4 w-4", st.days ? "text-[var(--warning)]" : "")} />
          <span>
            <span className="font-semibold tabular-nums text-[var(--text)]">{st.days}</span>
            -day streak
            {!st.studiedToday && st.days > 0 ? " · study today to keep it" : ""}
          </span>
        </span>
        {t.doneToday > 0 && (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4" /> {t.doneToday} done · {fmtDuration(todayLogMs / 1000)}
          </span>
        )}
      </div>
    </Panel>
  );

  const ahead = (
    <Section
      title="Coming up"
      action={
        <div className="flex items-center gap-1">
          <ItemButton
            size="sm"
            variant="ghost"
            icon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={() => ask("Look at my due counts and forecast — what should I focus on today, and are my limits sensible?")}
          >
            Plan today
          </ItemButton>
          <ItemButton size="sm" variant="ghost" icon={<BarChart3 className="h-3.5 w-3.5" />} onClick={() => goTo("stats")}>
            Stats
          </ItemButton>
        </div>
      }
    >
      <Panel className="flex flex-col gap-3">
        <WeekAhead counts={week.slice(1, 8)} firstDay={dayNow + 1} />
        {examIn !== null && examIn >= 0 && (
          <div className="flex items-center gap-2 border-t border-[var(--border)] pt-3 text-sm">
            <CalendarClock className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
            <span className="min-w-0 flex-1 text-[var(--text)]">Exam {examIn === 0 ? "today" : examIn === 1 ? "tomorrow" : `in ${examIn} days`}</span>
            <ItemButton
              size="sm"
              variant="ghost"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              onClick={() => ask("Make a study plan for my exam using the forecast and my weak cards.")}
            >
              Plan
            </ItemButton>
          </div>
        )}
      </Panel>
    </Section>
  );

  const decks = (
    <Section
      title="Decks"
      action={
        <div className="flex items-center gap-1">
          <ItemButton size="sm" variant="ghost" icon={<Shuffle className="h-3.5 w-3.5" />} onClick={() => onCram(null)}>
            Custom
          </ItemButton>
          {item.canEdit && (
            <ItemButton size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={onAdd}>
              Card
            </ItemButton>
          )}
        </div>
      }
    >
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-end border-b border-[var(--border)] py-1.5 pr-10">
          <DueHeader />
        </div>
        <div className="divide-y divide-[var(--border)]">
          {tree.map(({ deck, depth }) => {
            const k = per.get(deck.id);
            const due = k ? k.fresh + k.learning + k.review : 0;
            return (
              <button
                key={deck.id}
                type="button"
                onClick={() => (due && item.canEdit ? onStudy(deck.id) : onCram(deck.id))}
                className="flex min-h-[56px] w-full items-center gap-3 py-2 pr-3 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                style={{ paddingLeft: 14 + depth * 20 }}
                aria-label={`${deck.name}: ${due ? `study ${due} due` : "nothing due — custom study"}`}
              >
                <DeckDot color={deck.color} size={depth ? 8 : 10} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[var(--text)]", depth ? "text-sm" : "text-[15px] font-medium")}>{deck.name}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{k?.cards ?? 0} cards</span>
                </span>
                <DueCounts fresh={k?.fresh ?? 0} learning={k?.learning ?? 0} review={k?.review ?? 0} />
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              </button>
            );
          })}
        </div>
      </div>
    </Section>
  );

  return (
    <Page wide={!isPhone}>
      {isPhone ? (
        <>
          {hero}
          {decks}
          {ahead}
        </>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            {hero}
            {ahead}
          </div>
          <div className="min-w-0">{decks}</div>
        </div>
      )}
    </Page>
  );
}

/** Seven small bars: reviews due on each of the next days. */
function WeekAhead({ counts, firstDay }: { counts: number[]; firstDay: number }) {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, v) => a + v, 0);
  return (
    <div>
      <p className="mb-2 text-xs text-[var(--text-muted)]">
        <span className="font-semibold tabular-nums text-[var(--text)]">{total}</span> reviews in the next 7 days · tomorrow{" "}
        <span className="font-semibold tabular-nums text-[var(--text)]">{counts[0] ?? 0}</span>
      </p>
      <div className="grid grid-cols-7 gap-1.5" role="img" aria-label={`Reviews due on the next 7 days: ${counts.join(", ")}`}>
        {counts.map((v, i) => {
          const d = new Date((firstDay + i) * 86_400_000);
          return (
            <div key={i} className="flex flex-col items-center gap-1">
              <span className="text-[11px] font-medium tabular-nums text-[var(--text-muted)]">{v}</span>
              <div className="flex h-12 w-full items-end overflow-hidden rounded-md bg-[var(--surface-2)]">
                <div
                  className="w-full rounded-md bg-[var(--item-accent)]"
                  style={{
                    height: `${v ? Math.max(8, (v / max) * 100) : 0}%`,
                    opacity: i === 0 ? 1 : 0.65,
                  }}
                />
              </div>
              <span className="text-[11px] text-[var(--text-muted)]">
                {d.toLocaleDateString([], {
                  weekday: "narrow",
                  timeZone: "UTC",
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cram

function shuffle<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function CramSheet({
  item,
  open,
  deck,
  onClose,
  onStart,
}: {
  item: ItemHandle<Data>;
  open: boolean;
  deck: string | null;
  onClose: () => void;
  onStart: (m: Mode) => void;
}) {
  const data = item.data;
  const cfg = useCfg(data);
  const paths = usePaths(data.decks);
  const [deckId, setDeckId] = useState<string>("");
  const [tag, setTag] = useState("");
  const [what, setWhat] = useState<"all" | "due" | "new" | "forgot" | "flagged" | "hard">("all");
  const [limit, setLimit] = useState(50);
  const [order, setOrder] = useState<"random" | "deck">("random");
  const [style, setStyle] = useState<"flip" | "choice">("flip");
  useEffect(() => {
    if (open) setDeckId(deck ?? "");
  }, [open, deck]);
  const tags = useMemo(() => allTags(data.cards), [data.cards]);
  const items = useMemo(() => {
    if (!open) return [];
    const now = Date.now();
    const ids = deckId ? subtree(data.decks, deckId) : null;
    const since = now - 7 * 86_400_000;
    const forgot = new Set(data.review_log.filter((e) => e.r === 1 && F.parseMoment(e.t) >= since).map((e) => `${e.c}/${e.k}`));
    const out: { c: string; k: string; d: number }[] = [];
    for (const c of data.cards) {
      if (ids && !ids.has(c.deck_id)) continue;
      if (tag && !matches(c, `tag:${tag}`, paths, now, cfg)) continue;
      if (what === "flagged" && !c.flagged) continue;
      for (const s of c.srs) {
        if (what === "due" && !(s.state !== "new" && s.due && F.parseMoment(s.due) < F.dayStart(F.dayIndex(now, cfg) + 1, cfg))) continue;
        if (what === "new" && s.state !== "new") continue;
        if (what === "forgot" && !forgot.has(`${c.id}/${s.k}`)) continue;
        if (what === "hard" && !((s.difficulty ?? 0) >= 7 || s.lapses >= 2)) continue;
        out.push({ c: c.id, k: s.k, d: s.difficulty ?? 0 });
      }
    }
    return out;
  }, [open, data, deckId, tag, what, paths, cfg]);
  const title = [deckId ? paths.get(deckId) : "All decks", tag ? `#${tag}` : ""].filter(Boolean).join(" ");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Custom study"
      footer={
        <ItemButton
          variant="primary"
          block
          disabled={!items.length}
          onClick={() => {
            const picked = (order === "random" ? shuffle(items) : items).slice(0, limit).map(({ c, k }) => ({ c, k }));
            onStart({
              kind: "cram",
              deck: deckId || null,
              items: picked,
              title,
              choice: style === "choice",
            });
          }}
        >
          {style === "choice" ? "Learn" : "Cram"} {Math.min(limit, items.length)} card
          {Math.min(limit, items.length) === 1 ? "" : "s"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-muted)]">
          Practice outside the schedule — answers here don't change when cards are due.
        </p>
        <Field label="Deck">
          <Select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="">All decks</option>
            {deckTree(data.decks).map(({ deck: d, depth }) => (
              <option key={d.id} value={d.id}>
                {"  ".repeat(depth) + d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tag">
          <Select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.tag} ({t.n})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cards">
          <Select value={what} onChange={(e) => setWhat(e.target.value as typeof what)}>
            <option value="all">All cards</option>
            <option value="due">Due today</option>
            <option value="new">New (not studied yet)</option>
            <option value="forgot">Forgotten in the last 7 days</option>
            <option value="hard">Difficult (difficulty ≥ 7 or 2+ lapses)</option>
            <option value="flagged">Flagged</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Stepper label="How many" value={limit} onChange={setLimit} step={10} min={5} max={1000} />
          <Field label="Order">
            <Segmented
              value={order}
              onChange={setOrder}
              options={[
                { value: "random", label: "Shuffle" },
                { value: "deck", label: "In order" },
              ]}
              className="h-11 w-full items-center"
            />
          </Field>
        </div>
        <Field
          label="Style"
          hint={style === "choice" ? "Pick the answer from four — the others come from your other cards." : "Flip each card and rate yourself."}
        >
          <Segmented
            value={style}
            onChange={setStyle}
            options={[
              { value: "flip", label: "Flip cards" },
              { value: "choice", label: "Multiple choice" },
            ]}
            className="h-11 w-full items-center"
          />
        </Field>
        <p className="text-xs text-[var(--text-muted)]" aria-live="polite">
          {items.length} matching review item{items.length === 1 ? "" : "s"}.
        </p>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ session

/** The inverse of one answer: drop its log entry, put back that review
 *  item's scheduling (only if nothing newer happened to it), and undo a
 *  leech tag / suspension the answer added. */
interface UndoEntry {
  c: string;
  k: string;
  t: string;
  prev: Srs | null;
  addedLeech: boolean;
  suspendedByLeech: boolean;
}

/** Four answers for multiple choice: the right one and three from other
 *  cards (stable for the card, so a re-render doesn't reshuffle them). */
function choicesFor(card: Card, k: string, cards: Card[]): { text: string; right: boolean }[] {
  const right = answerText(card, k);
  const norm = (x: string) => x.trim().toLowerCase();
  const pool: string[] = [];
  const seen = new Set([norm(right)]);
  const start = Math.floor(F.seededRandom(`${card.id}/${k}`) * Math.max(1, cards.length));
  for (let n = 0; n < cards.length && pool.length < 12; n++) {
    const other = cards[(start + n * 7) % cards.length];
    if (!other || other.id === card.id) continue;
    for (const s of other.srs) {
      const a = answerText(other, s.k);
      if (a && !seen.has(norm(a)) && a.length <= 160) {
        seen.add(norm(a));
        pool.push(a);
        break;
      }
    }
  }
  const pick = pool.slice(0, 3).map((text) => ({ text, right: false }));
  const out = [...pick, { text: right, right: true }];
  const rot = Math.floor(F.seededRandom(`${card.id}/${k}/pos`) * out.length);
  return out.map((_, i) => out[(i + rot) % out.length]);
}

const RATING_META: { g: F.Rating; label: string; key: string; tone: string }[] = [
  { g: 1, label: "Again", key: "1", tone: "var(--danger)" },
  { g: 2, label: "Hard", key: "2", tone: "var(--warning)" },
  { g: 3, label: "Good", key: "3", tone: "var(--success)" },
  { g: 4, label: "Easy", key: "4", tone: "var(--item-accent)" },
];

function Session({
  item,
  isPhone,
  mode,
  ask,
  onExit,
  onCram,
}: {
  item: ItemHandle<Data>;
  isPhone: boolean;
  mode: Mode;
  ask: (p: string) => void;
  onExit: () => void;
  onCram: (deck: string | null) => void;
}) {
  const data = item.data;
  const cfg = useCfg(data);
  const now = useNow(10_000);
  const cram = mode.kind === "cram";
  const deckIds = useMemo(() => (mode.deck ? subtree(data.decks, mode.deck) : null), [data.decks, mode.deck]);
  // Everything below runs on this device: the queue, FSRS and the save are
  // local (the item's offline outbox keeps answers until they sync).
  const t = useToday(data, now, cfg, deckIds);
  const counts = countsOf(t);
  const choice = mode.kind === "cram" && mode.choice;
  const [picked, setPicked] = useState<number | null>(null);
  const [cur, setCur] = useState<{ c: string; k: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [typing, setTyping] = useState("");
  const [answers, setAnswers] = useState<{ r: F.Rating; d: number }[]>([]);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [finished, setFinished] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const undo = useRef<UndoEntry[]>([]);
  const lastCard = useRef<string | undefined>(undefined);
  const shownAt = useRef(Date.now());
  const cramQueue = useRef<{ c: string; k: string }[]>(mode.kind === "cram" ? mode.items.slice() : []);
  const cramTotal = useRef(mode.kind === "cram" ? mode.items.length : 0);
  const typeRef = useRef<HTMLInputElement>(null);

  const card = cur ? (data.cards.find((c) => c.id === cur.c) ?? null) : null;
  const srs = card && cur ? (card.srs.find((s) => s.k === cur.k) ?? null) : null;

  const show = useCallback((next: { c: string; k: string } | null) => {
    setCur(next);
    setRevealed(false);
    setTyped(null);
    setTyping("");
    setPicked(null);
    shownAt.current = Date.now();
  }, []);

  // Pick the next item whenever there's none (or it vanished).
  useEffect(() => {
    if (finished || editing) return;
    if (cur && card && srs) return;
    if (cram) {
      const nxt = cramQueue.current.find((q) => data.cards.some((c) => c.id === q.c && c.srs.some((s) => s.k === q.k)));
      if (!nxt) {
        setFinished(true);
        return;
      }
      show(nxt);
      return;
    }
    const q: QItem | null = nextItem(t, data.settings.new_mix, Date.now(), lastCard.current);
    if (q) {
      show({ c: q.card.id, k: q.srs.k });
    } else if (t.learningLater.length) {
      if (cur) setCur(null); // wait for the next learning card
    } else {
      setFinished(true);
    }
  }, [cur, card, srs, t, cram, finished, editing, data.cards, data.settings.new_mix, show]);

  // While waiting for a learning card, re-check as time passes.
  const waiting = !cur && !finished && !cram ? (t.learningLater[0] ?? null) : null;

  const choices = useMemo(() => (choice && card && srs ? choicesFor(card, srs.k, data.cards) : null), [choice, card, srs, data.cards]);

  const options = useMemo(() => {
    if (cram || !card || !srs) return null;
    return F.preview(srs, Date.now(), cfg, `${card.id}/${srs.k}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cram, card?.id, srs, cfg, revealed]);

  const reveal = useCallback(() => {
    if (!card || !srs || revealed) return;
    if (card.type === "typein" && srs.k === "f") setTyped(typing);
    setRevealed(true);
  }, [card, srs, revealed, typing]);

  const answer = useCallback(
    (g: F.Rating) => {
      if (!card || !srs || !revealed) return;
      const ms = Date.now();
      const dur = Math.max(0, Math.min(ms - shownAt.current, 3_600_000));
      navigator.vibrate?.(8);
      setAnswers((a) => [...a, { r: g, d: dur }]);
      lastCard.current = card.id;
      if (cram) {
        const q = cramQueue.current;
        const idx = q.findIndex((x) => x.c === card.id && x.k === srs.k);
        const it = idx >= 0 ? q.splice(idx, 1)[0] : { c: card.id, k: srs.k };
        // Missed ones come back a little later in the same session.
        if (g === 1) q.splice(Math.min(q.length, 3), 0, it);
        else if (g === 2) q.splice(Math.min(q.length, 8), 0, it);
        show(null);
        return;
      }
      // The new state is computed *inside* the mutator from the draft's
      // current state + this rating + this moment, so a replay on newer
      // data (another device answered this card meanwhile) is still right.
      const cid = card.id;
      const k = srs.k;
      const at = F.iso(ms, cfg.tz);
      const u: UndoEntry = {
        c: cid,
        k,
        t: at,
        prev: null,
        addedLeech: false,
        suspendedByLeech: false,
      };
      let leech: "tag" | "suspend" | null = null;
      item.update((d) => {
        const c = d.cards.find((x) => x.id === cid);
        const i = c ? c.srs.findIndex((x) => x.k === k) : -1;
        if (!c || i < 0) return;
        const before = c.srs[i];
        const { srs: nxt, log } = F.review(before, g, ms, cfg, `${cid}/${k}`);
        u.prev = { ...before };
        u.addedLeech = false;
        u.suspendedByLeech = false;
        leech = null;
        c.srs[i] = nxt;
        const ls = d.settings;
        if (
          before.state === "review" &&
          g === 1 &&
          nxt.lapses >= ls.leech_threshold &&
          (nxt.lapses - ls.leech_threshold) % Math.max(1, Math.floor(ls.leech_threshold / 2)) === 0
        ) {
          leech = ls.leech_action;
          if (!c.tags.some((x) => x.toLowerCase() === "leech")) {
            c.tags.push("leech");
            u.addedLeech = true;
          }
          if (ls.leech_action === "suspend" && !c.suspended) {
            c.suspended = true;
            u.suspendedByLeech = true;
          }
        }
        const entry: Log = { c: cid, k, t: at, d: dur, ...log };
        d.review_log.splice(logInsertAt(d.review_log, ms), 0, entry);
      });
      undo.current.push(u);
      if (undo.current.length > 50) undo.current.shift();
      if (leech) setFlash(leech === "suspend" ? "Leech — card suspended. Rewrite it?" : "Leech — tagged. Worth rewriting.");
      show(null);
    },
    [card, srs, revealed, cram, cfg, item, show],
  );

  const doUndo = useCallback(() => {
    if (cram) return;
    const u = undo.current.pop();
    if (!u) return;
    item.update((d) => {
      for (let j = d.review_log.length - 1; j >= 0; j--) {
        const e = d.review_log[j];
        if (e.c === u.c && e.k === u.k && e.t === u.t) {
          d.review_log.splice(j, 1);
          break;
        }
      }
      const c = d.cards.find((x) => x.id === u.c);
      if (!c) return;
      const s = c.srs.find((x) => x.k === u.k);
      // Only this answer's scheduling — and only if it's still the latest.
      if (s && u.prev && s.last_review === u.t) Object.assign(s, u.prev);
      if (u.addedLeech) c.tags = c.tags.filter((x) => x.toLowerCase() !== "leech");
      if (u.suspendedByLeech) c.suspended = false;
    });
    setAnswers((a) => a.slice(0, -1));
    setFinished(false);
    show({ c: u.c, k: u.k });
  }, [cram, item, show]);

  const mutateCard = useCallback(
    (fn: (c: Card) => void, msg: string) => {
      if (!card) return;
      item.update((d) => {
        const c = d.cards.find((x) => x.id === card.id);
        if (c) fn(c);
      });
      setFlash(msg);
      setMenu(false);
    },
    [card, item],
  );

  const bury = useCallback(() => {
    const tomorrow = F.dayISO(F.dayIndex(Date.now(), cfg) + 1);
    mutateCard((c) => (c.buried_until = tomorrow), "Buried until tomorrow");
    lastCard.current = card?.id;
    show(null);
  }, [cfg, mutateCard, card, show]);
  const suspend = useCallback(() => {
    mutateCard((c) => (c.suspended = true), "Card suspended");
    show(null);
  }, [mutateCard, show]);

  useEffect(() => {
    if (!flash) return;
    const tm = window.setTimeout(() => setFlash(null), 2600);
    return () => window.clearTimeout(tm);
  }, [flash]);

  // Keyboard: space/enter flip (then = Good), 1–4 rate, z undo, e edit, f flag, b bury, s suspend, esc end.
  useEffect(() => {
    if (editing || finished) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const inField = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (inField) {
        if (e.key === "Enter" && el === typeRef.current) {
          e.preventDefault();
          if (!revealed) reveal();
          else if (card && srs) answer(typedCorrect(typed ?? "", card, srs.k) ? 3 : 1);
        }
        return;
      }
      if (e.metaKey || e.altKey) return;
      if ((e.key === "z" && !e.ctrlKey) || ((e.ctrlKey || e.metaKey) && e.key === "z")) {
        e.preventDefault();
        doUndo();
        return;
      }
      if (e.ctrlKey) return;
      if (choice && choices && !revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        const i = Number(e.key) - 1;
        if (choices[i]) {
          setPicked(i);
          setRevealed(true);
        }
        return;
      }
      if (choice && revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        answer(picked !== null && choices?.[picked]?.right ? 3 : 1);
        return;
      }
      if (choice && !revealed) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) reveal();
        else answer(3);
      } else if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        answer(Number(e.key) as F.Rating);
      } else if (e.key === "e" && card && item.canEdit) {
        e.preventDefault();
        setEditing(true);
      } else if (e.key === "f" && card) {
        const target = !card.flagged;
        mutateCard((c) => (c.flagged = target), target ? "Flagged" : "Unflagged");
      } else if (e.key === "b" && card && !cram) {
        bury();
      } else if (e.key === "s" && card && !cram) {
        suspend();
      } else if (e.key === "Escape") {
        if (menu) setMenu(false);
        else if (answers.length) setFinished(true);
        else onExit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    editing,
    finished,
    revealed,
    reveal,
    answer,
    doUndo,
    card,
    srs,
    typed,
    item.canEdit,
    mutateCard,
    bury,
    suspend,
    cram,
    menu,
    answers.length,
    onExit,
    choice,
    choices,
    picked,
  ]);

  // Swipe (after flipping): left = Again, right = Good.
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const horizontal = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    horizontal.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current || !revealed) return;
    const ddx = e.clientX - start.current.x;
    const ddy = e.clientY - start.current.y;
    if (!horizontal.current && Math.abs(ddx) > 12 && Math.abs(ddx) > Math.abs(ddy) * 1.3) horizontal.current = true;
    if (horizontal.current) setDx(ddx);
  };
  const onPointerUp = () => {
    const was = horizontal.current;
    const d = dx;
    start.current = null;
    horizontal.current = false;
    setDx(0);
    if (was && revealed) {
      if (d < -90) answer(1);
      else if (d > 90) answer(3);
    }
  };

  const total = cram ? cramTotal.current : answers.length + counts.total;
  const progress = total ? answers.length / Math.max(total, answers.length) : 1;
  const shell = cn(
    "flex flex-col bg-[var(--bg)]",
    isPhone ? "fixed inset-0 z-[60] pt-[env(safe-area-inset-top,0px)]" : "mx-auto h-full min-h-[560px] w-full max-w-3xl px-6 py-4",
  );

  if (finished)
    return (
      <div className={shell}>
        <Summary
          item={item}
          answers={answers}
          cram={cram}
          deck={mode.deck}
          onDone={onExit}
          onUndo={!cram && undo.current.length ? doUndo : undefined}
          onContinue={cram ? undefined : () => setFinished(false)}
          onCram={() => onCram(mode.deck)}
          ask={ask}
        />
      </div>
    );

  const paths = deckPaths(data.decks);
  const deckName = mode.kind === "cram" ? mode.title : mode.deck ? (paths.get(mode.deck) ?? "") : "All decks";
  const cardDeck = card ? (data.decks.find((d) => d.id === card.deck_id) ?? null) : null;
  const cardDeckName = card ? (paths.get(card.deck_id)?.replace(/::/g, " › ") ?? "") : "";
  const showIntervals = data.settings.show_intervals && !cram;
  const isTypein = !!card && card.type === "typein" && srs?.k === "f";

  return (
    <div className={shell}>
      {/* top bar */}
      <div className={cn("flex shrink-0 items-center gap-1", isPhone && "px-2 pt-1")}>
        <IconButton label="End session" icon={X} onClick={() => (answers.length ? setFinished(true) : onExit())} />
        <div className="min-w-0 flex-1 px-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-[var(--text)]">{cram ? `Cram · ${deckName}` : deckName}</span>
            {cram ? (
              <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
                {answers.length} done · {cramQueue.current.length} left
              </span>
            ) : (
              <QueueCounts fresh={counts.fresh} learning={counts.learning} review={counts.review} current={srs?.state ?? null} />
            )}
          </div>
          <ProgressBar value={progress} className="mt-1.5 h-1" />
        </div>
        {!cram && <IconButton label="Undo last answer (Z)" icon={Undo2} disabled={!undo.current.length} onClick={doUndo} />}
        {item.canEdit && <IconButton label="Edit card (E)" icon={Pencil} disabled={!card} onClick={() => setEditing(true)} />}
        <div className="relative">
          <IconButton label="More" icon={MoreHorizontal} onClick={() => setMenu((m) => !m)} disabled={!card} />
          {menu && card && (
            <div
              role="menu"
              className="absolute right-0 top-11 z-10 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]"
            >
              {item.canEdit && (
                <MenuItem
                  icon={Pencil}
                  label="Edit card"
                  hint="E"
                  onClick={() => {
                    setMenu(false);
                    setEditing(true);
                  }}
                />
              )}
              <MenuItem
                icon={Flag}
                label={card.flagged ? "Unflag" : "Flag"}
                hint="F"
                onClick={() => {
                  const target = !card.flagged;
                  mutateCard((c) => (c.flagged = target), target ? "Flagged" : "Unflagged");
                }}
              />
              {!cram && <MenuItem icon={EyeOff} label="Bury until tomorrow" hint="B" onClick={bury} />}
              {!cram && <MenuItem icon={PauseCircle} label="Suspend" hint="S" onClick={suspend} />}
              <MenuItem
                icon={Sparkles}
                label="Explain this answer"
                onClick={() => {
                  setMenu(false);
                  ask(`Explain the answer to this card (id ${card.id}) and give me a memory hook.`);
                }}
              />
            </div>
          )}
        </div>
      </div>
      {cram && (
        <p className="mt-2 shrink-0 text-center text-[11px] text-[var(--text-muted)]">
          {choice ? "Learn (multiple choice)" : "Cram"} — your schedule isn't affected
        </p>
      )}

      {/* card */}
      <div
        className={cn("relative min-h-0 flex-1 overflow-y-auto overscroll-contain", isPhone ? "px-4" : "px-1")}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a,button,input")) return;
          if (!revealed && !isTypein && !choice) reveal();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{ touchAction: "pan-y" }}
      >
        {card && srs ? (
          <div
            className={cn(
              "relative mx-auto flex w-full max-w-2xl flex-col rounded-3xl border border-[var(--border)] bg-[var(--surface)] px-5 pb-8 pt-3 shadow-[var(--shadow-sm)] md:px-10",
              isPhone ? "my-3 min-h-[calc(100%-1.5rem)]" : "my-4 min-h-[calc(100%-2rem)]",
            )}
            style={
              dx
                ? {
                    transform: `translateX(${dx}px) rotate(${dx / 30}deg)`,
                    transition: "none",
                  }
                : { transition: "transform 180ms ease" }
            }
            aria-live="polite"
          >
            {dx !== 0 && (
              <span
                className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full px-3 py-1 text-sm font-bold text-white"
                style={{
                  background: dx < 0 ? "var(--danger)" : "var(--success)",
                  opacity: Math.min(1, Math.abs(dx) / 90),
                }}
              >
                {dx < 0 ? "Again" : "Good"}
              </span>
            )}
            <div className="flex min-h-[28px] items-center gap-2 text-xs text-[var(--text-muted)]">
              <DeckDot color={cardDeck?.color ?? "var(--border)"} size={8} />
              <span className="min-w-0 truncate">{cardDeckName}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {card.flagged && <Flag className="h-3.5 w-3.5 text-[var(--warning)]" aria-label="Flagged" />}
                {srs.state === "new" && (
                  <span className="rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--item-accent)]">
                    New
                  </span>
                )}
                {(srs.state === "learning" || srs.state === "relearning") && (
                  <span className="rounded-full bg-[var(--danger-bg)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--danger)]">
                    {srs.state === "relearning" ? "Relearn" : "Learning"}
                  </span>
                )}
              </span>
            </div>
            <div className={cn("flex flex-col", isPhone ? "pt-[9vh]" : "pt-[7vh]")}>
              <Face card={card} k={srs.k} revealed={revealed && !choice} typed={isTypein ? typed : undefined} />
            </div>
            {isTypein && !revealed && (
              <div className="mx-auto mt-6 w-full max-w-sm">
                <TextInput
                  ref={typeRef}
                  autoFocus
                  value={typing}
                  onChange={(e) => setTyping(e.target.value)}
                  placeholder="Type the answer…"
                  aria-label="Your answer"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="text-center"
                />
              </div>
            )}
            {!revealed && !isTypein && !choice && answers.length < 3 && (
              <p className="mt-auto pt-8 text-center text-xs text-[var(--text-muted)]">
                {isPhone ? "Tap anywhere to show the answer" : "Space or click to show the answer"}
              </p>
            )}
          </div>
        ) : waiting ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Clock className="h-8 w-8 text-[var(--text-muted)]" />
            <p className="text-sm text-[var(--text)]">
              Next learning card{" "}
              {F.parseMoment(waiting.srs.due!) - now > 60_000 ? `in ${Math.ceil((F.parseMoment(waiting.srs.due!) - now) / 60_000)} min` : "in a moment"}.
            </p>
            <div className="flex gap-2">
              <ItemButton onClick={() => show({ c: waiting.card.id, k: waiting.srs.k })}>Study it now</ItemButton>
              <ItemButton variant="ghost" onClick={() => setFinished(true)}>
                Finish
              </ItemButton>
            </div>
          </div>
        ) : null}
        {flash && (
          <div
            role="status"
            className="pointer-events-none fixed inset-x-0 bottom-40 z-[61] mx-auto w-fit rounded-full bg-[var(--text)] px-4 py-2 text-sm font-medium text-[var(--bg)] shadow-[var(--shadow-lg)]"
          >
            {flash}
          </div>
        )}
      </div>

      {/* answer bar */}
      {card && srs && (
        <div className={cn("shrink-0", isPhone ? "px-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] pt-2" : "pb-2 pt-3")}>
          {choice && choices ? (
            <div className="flex flex-col gap-2">
              <div className={cn("grid gap-2", isPhone ? "grid-cols-1" : "grid-cols-2")} role="group" aria-label="Choose the answer">
                {choices.map((ch, i) => {
                  const state = !revealed ? "idle" : ch.right ? "right" : picked === i ? "wrong" : "idle";
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={revealed}
                      onClick={() => {
                        setPicked(i);
                        setRevealed(true);
                      }}
                      className={cn(
                        "flex min-h-[52px] items-center gap-2 rounded-2xl border px-3 py-2 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                        state === "right" && "border-transparent bg-[var(--success-bg)] text-[var(--success)]",
                        state === "wrong" && "border-transparent bg-[var(--danger-bg)] text-[var(--danger)]",
                        state === "idle" && "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] enabled:hover:bg-[var(--hover)]",
                      )}
                    >
                      {!isPhone && <kbd className="text-[10px] text-[var(--text-muted)]">{i + 1}</kbd>}
                      <span className="min-w-0 flex-1 break-words">{ch.text}</span>
                    </button>
                  );
                })}
              </div>
              {revealed && (
                <ItemButton variant="primary" size="lg" block onClick={() => answer(picked !== null && choices[picked]?.right ? 3 : 1)}>
                  {picked !== null && choices[picked]?.right ? "Right — next" : "Next"}
                </ItemButton>
              )}
              <p className="sr-only" aria-live="polite">
                {revealed
                  ? picked !== null && choices[picked]?.right
                    ? "Correct"
                    : `Not quite — the answer is ${choices.find((x) => x.right)?.text ?? ""}`
                  : ""}
              </p>
            </div>
          ) : !revealed ? (
            <ItemButton variant="primary" size="lg" block className="h-14 text-base" onClick={reveal}>
              {isTypein ? "Check" : "Show answer"}
              {!isPhone && <kbd className="ml-2 rounded bg-white/20 px-1.5 text-xs">Space</kbd>}
            </ItemButton>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {RATING_META.map(({ g, label, key, tone }) => {
                const o = options?.[g];
                const suggested =
                  isTypein && typed !== null && ((g === 3 && typedCorrect(typed, card, srs.k)) || (g === 1 && !typedCorrect(typed, card, srs.k)));
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => answer(g)}
                    className={cn(
                      "flex h-16 flex-col items-center justify-center gap-0.5 rounded-2xl border text-[15px] font-semibold transition active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
                      suggested ? "border-transparent text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]",
                    )}
                    style={suggested ? { background: tone } : { boxShadow: `inset 0 -3px 0 ${tone}` }}
                    aria-label={`${label}${o && showIntervals ? `, next in ${F.label(o.minutes, o.days)}` : ""}`}
                  >
                    {showIntervals && o && (
                      <span className={cn("text-xs font-medium tabular-nums", suggested ? "text-white/90" : "text-[var(--text-muted)]")}>
                        {F.label(o.minutes, o.days)}
                      </span>
                    )}
                    <span style={suggested ? undefined : { color: tone }}>{label}</span>
                    {!isPhone && <span className={cn("text-[10px] font-normal", suggested ? "text-white/80" : "text-[var(--text-muted)]")}>{key}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {isPhone && revealed && answers.length < 3 && (
            <p className="mt-1.5 text-center text-[11px] text-[var(--text-muted)]">Tip: swipe the card left for Again, right for Good</p>
          )}
        </div>
      )}

      {card && (
        <CardEditorSheet
          item={item}
          open={editing}
          card={card}
          onClose={() => {
            setEditing(false);
            shownAt.current = Date.now();
          }}
        />
      )}
    </div>
  );
}

/** The session's three counts, Anki-style: the queue the current card
 *  comes from is underlined. */
function QueueCounts({ fresh, learning, review, current }: { fresh: number; learning: number; review: number; current: string | null }) {
  const q = current === "new" ? 0 : current === "learning" || current === "relearning" ? 1 : current === "review" ? 2 : -1;
  const cells: [number, string, string][] = [
    [fresh, "var(--item-accent)", "new"],
    [learning, "var(--danger)", "learning"],
    [review, "var(--success)", "to review"],
  ];
  return (
    <span
      className="flex shrink-0 items-center gap-2.5 text-sm font-semibold tabular-nums"
      aria-label={`${fresh} new, ${learning} learning, ${review} to review`}
    >
      {cells.map(([v, tone, label], i) => (
        <span
          key={label}
          className={cn("leading-5", q === i && "underline decoration-2 underline-offset-4")}
          style={{
            color: v || q === i ? tone : "var(--text-muted)",
            opacity: v || q === i ? 1 : 0.5,
          }}
        >
          {v}
        </span>
      ))}
    </span>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex h-11 w-full items-center gap-2.5 px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
    >
      <Icon className="h-4 w-4 text-[var(--text-muted)]" />
      <span className="flex-1">{label}</span>
      {hint && <kbd className="text-[10px] text-[var(--text-muted)]">{hint}</kbd>}
    </button>
  );
}

function Summary({
  item,
  answers,
  cram,
  deck,
  onDone,
  onUndo,
  onContinue,
  onCram,
  ask,
}: {
  item: ItemHandle<Data>;
  answers: { r: F.Rating; d: number }[];
  cram: boolean;
  deck: string | null;
  onDone: () => void;
  onUndo?: () => void;
  onContinue?: () => void;
  onCram: () => void;
  ask: (p: string) => void;
}) {
  const data = item.data;
  const cfg = useCfg(data);
  const now = Date.now();
  const n = answers.length;
  const ms = answers.reduce((a, x) => a + Math.min(x.d, 60_000), 0);
  const by = [1, 2, 3, 4].map((g) => answers.filter((a) => a.r === g).length);
  const correct = n ? Math.round(((n - by[0]) / n) * 100) : 0;
  const st = streak(data.review_log, now, cfg);
  const ids = deck ? subtree(data.decks, deck) : null;
  const tomorrow = forecast(data, now, cfg, 2, ids)[1] ?? 0;
  const left = countsOf(today(data, now, cfg, ids));
  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col items-center justify-center gap-6 px-6 py-8 text-center">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] text-[var(--item-accent)] item-pop">
        <CheckCircle2 className="h-10 w-10" />
      </span>
      <div>
        <h2 className="text-xl font-semibold text-[var(--text)]">
          {n ? (cram ? "Cram done" : left.total ? "Nice session" : "Done for today!") : "Nothing studied"}
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {n} card{n === 1 ? "" : "s"} in {fmtDuration(ms / 1000)}
          {!cram && st.days > 0 ? ` · ${st.days}-day streak` : ""}
        </p>
      </div>
      {n > 0 && (
        <div className="w-full">
          <div
            className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
            role="img"
            aria-label={`Again ${by[0]}, Hard ${by[1]}, Good ${by[2]}, Easy ${by[3]}`}
          >
            {by.map((v, i) =>
              v ? (
                <span
                  key={i}
                  style={{
                    width: `${(v / n) * 100}%`,
                    background: RATING_META[i].tone,
                  }}
                />
              ) : null,
            )}
          </div>
          <div className="mt-2 grid grid-cols-4 text-xs text-[var(--text-muted)]">
            {RATING_META.map((m, i) => (
              <span key={m.g}>
                <span className="block text-base font-semibold tabular-nums text-[var(--text)]">{by[i]}</span>
                {m.label}
              </span>
            ))}
          </div>
          <p className="mt-3 text-sm text-[var(--text)]">
            <span className="font-semibold tabular-nums">{correct}%</span> recalled
          </p>
        </div>
      )}
      {!cram && !left.total && <p className="text-sm text-[var(--text-muted)]">{`Tomorrow: ${tomorrow} review${tomorrow === 1 ? "" : "s"}.`}</p>}
      <div className="flex w-full flex-col gap-2">
        {onContinue && left.total > 0 ? (
          <>
            <ItemButton variant="primary" block size="lg" className="h-14 text-base" onClick={onContinue}>
              Keep going · {left.total} left
            </ItemButton>
            <ItemButton block size="lg" onClick={onDone}>
              Done for now
            </ItemButton>
          </>
        ) : (
          <ItemButton variant="primary" block size="lg" className="h-14 text-base" onClick={onDone}>
            Done
          </ItemButton>
        )}
        <div className="flex flex-wrap justify-center gap-2">
          {onUndo && (
            <ItemButton variant="ghost" size="sm" icon={<Undo2 className="h-3.5 w-3.5" />} onClick={onUndo}>
              Undo last
            </ItemButton>
          )}
          <ItemButton variant="ghost" size="sm" icon={<Shuffle className="h-3.5 w-3.5" />} onClick={onCram}>
            Cram more
          </ItemButton>
          {by[0] > 0 && (
            <ItemButton
              variant="ghost"
              size="sm"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              onClick={() => ask("Which cards did I just get wrong, and how could they be written better?")}
            >
              Review my misses
            </ItemButton>
          )}
        </div>
      </div>
    </div>
  );
}
