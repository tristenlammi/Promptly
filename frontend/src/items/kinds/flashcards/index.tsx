import { BarChart3, Brain, FolderTree, Import, Layers, ListFilter, Plus, Sparkles } from "lucide-react";
import { useState } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";
import { Card as Panel, Field, ItemButton, Page, Stepper, TextInput } from "@/items/ui";

import { BrowseTab } from "./Browse";
import { deckSeed, ensureDeck, newCard } from "./cards";
import { DecksTab } from "./Decks";
import { ImportSheet } from "./ImportSheet";
import { request } from "./intents";
import { StatsTab } from "./Stats";
import { StudyTab } from "./Study";
import type { Data } from "./types";

/*
 * Flashcards — decks, FSRS-6 spaced repetition (fsrs.ts mirrors the
 * server's fsrs.py), a phone-first study flow, a card browser, stats.
 */

const SAMPLE: { type: "basic" | "reversed" | "cloze" | "typein"; front: string; back: string; note?: string; tags: string[] }[] = [
  { type: "basic", front: "How do you show the answer?", back: "Tap the card (or press **Space**). Then rate how well you knew it.", tags: ["tour"] },
  {
    type: "basic",
    front: "What do the four buttons mean?",
    back: "**Again** — forgot · **Hard** — remembered with effort · **Good** — remembered · **Easy** — instant",
    note: "The small label over each button is when you'll see the card next. Swipe left for Again, right for Good.",
    tags: ["tour"],
  },
  { type: "cloze", front: "Flashcards schedules reviews with {{c1::FSRS}}, the algorithm modern {{c2::Anki}} uses.", back: "", tags: ["tour"] },
  { type: "reversed", front: "Minimum information principle", back: "One small, atomic fact per card", note: "Rule 4 of SuperMemo's 20 rules — the assistant follows them when it writes cards for you.", tags: ["tour"] },
  { type: "basic", front: "Euler's identity", back: "$$e^{i\\pi} + 1 = 0$$", note: "Math works anywhere: $…$ inline, $$…$$ on its own line.", tags: ["tour", "math"] },
  { type: "typein", front: "Type the word: the French for *thank you*", back: "merci", tags: ["tour"] },
];

function Onboarding({ item, ask, isPhone }: ItemViewProps<Data>) {
  const [name, setName] = useState("");
  const [perDay, setPerDay] = useState(item.data.settings.new_per_day);
  const [importing, setImporting] = useState(false);
  const finish = (opts: { deck?: string; sample?: boolean }) => {
    const seed = deckSeed();
    const tourSeed = deckSeed();
    const tour = opts.sample ? SAMPLE.map((c) => newCard("", c.type, c.front, c.back, c.note ?? "", c.tags)) : [];
    item.update((d) => {
      d.settings.onboarded = true;
      d.settings.new_per_day = perDay;
      if (opts.deck?.trim()) ensureDeck(d, opts.deck.trim(), seed);
      if (tour.length) {
        const id = ensureDeck(d, "Getting started", tourSeed, "#5B6DD9", "A one-minute tour — delete it whenever you like.");
        for (const c of tour) if (!d.cards.some((x) => x.id === c.id)) d.cards.push({ ...JSON.parse(JSON.stringify(c)), deck_id: id });
      }
    });
  };
  return (
    <Page className="justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] text-[var(--item-accent)]">
            <Layers className="h-7 w-7" />
          </span>
          <h1 className="text-xl font-semibold text-[var(--text)]">Remember anything</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Flashcards shows each card right before you'd forget it (FSRS — the scheduler in modern Anki), so a few minutes a day goes a long way.
          </p>
        </div>
        <Panel className="flex flex-col gap-4">
          <Field label="Your first deck">
            <TextInput autoFocus={!isPhone} value={name} onChange={(e) => setName(e.target.value)} placeholder="Spanish, Biology::Cells, AWS exam…" onKeyDown={(e) => e.key === "Enter" && name.trim() && finish({ deck: name })} />
          </Field>
          <Stepper label="New cards a day" value={perDay} onChange={setPerDay} step={5} min={0} max={500} />
          <p className="-mt-2 text-xs text-[var(--text-muted)]">20 a day ≈ 15–20 minutes of reviews a day after a month. You can change it any time.</p>
          <ItemButton variant="primary" block disabled={!name.trim()} icon={<Plus className="h-4 w-4" />} onClick={() => finish({ deck: name })}>
            Create deck
          </ItemButton>
        </Panel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ItemButton icon={<Import className="h-4 w-4" />} onClick={() => setImporting(true)}>
            Import
          </ItemButton>
          <ItemButton
            icon={<Sparkles className="h-4 w-4" />}
            onClick={() => {
              finish({});
              ask("Build me a first deck — ask me what I'm learning, or which of my notes to use.");
            }}
          >
            Ask AI
          </ItemButton>
          <ItemButton className="whitespace-nowrap" icon={<Brain className="h-4 w-4" />} onClick={() => finish({ sample: true })}>
            Take the tour
          </ItemButton>
        </div>
        <button type="button" className="text-sm text-[var(--text-muted)] hover:text-[var(--text)]" onClick={() => finish({})}>
          Skip
        </button>
      </div>
      <ImportSheet
        item={item}
        open={importing}
        onClose={() => {
          setImporting(false);
          if (item.data.cards.length) finish({});
        }}
      />
    </Page>
  );
}

const module: ItemModule<Data> = {
  kind: "flashcards",
  icon: Layers,
  tabs: [
    { id: "study", label: "Study", icon: Brain, View: StudyTab },
    { id: "decks", label: "Decks", icon: FolderTree, View: DecksTab },
    { id: "browse", label: "Browse", icon: ListFilter, View: BrowseTab },
    { id: "stats", label: "Stats", icon: BarChart3, View: StatsTab },
  ],
  // Every tab has the add sheet; when none is showing (the phone's Ask tab)
  // the intent waits for the Study tab.
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "Add card",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            if (!request("add", {})) goTo("study");
          },
        }
      : null,
  needsOnboarding: (d) => !d.settings?.onboarded && !(d.cards?.length) && !(d.decks?.length),
  Onboarding,
};

export default module;
