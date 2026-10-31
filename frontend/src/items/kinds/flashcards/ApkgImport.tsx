import { FileUp, Package } from "lucide-react";
import { useRef, useState } from "react";

import { apiClient } from "@/api/client";
import type { ItemHandle } from "@/items/useItem";
import { ItemButton, Toggle } from "@/items/ui";

import { deckSeed, ensureDeck, normFront, oneLine } from "./cards";
import * as F from "./fsrs";
import type { Card, CardType, Data, Log, Srs } from "./types";

/*
 * Anki package import. The server reads the .apkg (SQLite needs Python's
 * stdlib — see backend .../flashcards/apkg.py), replays its review history
 * through FSRS and stores its media in Drive; nothing in the file changes
 * there. The cards are added here with one ordinary ``item.update``, so the
 * save goes through the normal patch / offline path. Card ids come from
 * Anki's note guids: importing the same deck again skips what's there.
 */

const MAX_CARDS = 20_000;
const MAX_BYTES = 100 * 1024 * 1024;

interface ImportedCard {
  id: string;
  deck: string;
  type: CardType;
  front: string;
  back: string;
  note: string;
  tags: string[];
  suspended: boolean;
  srs: Srs[];
  created: string;
}

interface Result {
  format: string;
  notes: number;
  cards: ImportedCard[];
  decks: string[];
  logs: Log[];
  skipped: number;
  truncated: number;
  history: { reviews: number; imported: number; dropped: number };
  media: { stored: number; failed: number; missing: number; requested: boolean };
  warnings: string[];
}

export function ApkgImport({ item, onDone }: { item: ItemHandle<Data>; onDone: (summary: string) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [media, setMedia] = useState(true);
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const online = typeof navigator === "undefined" || navigator.onLine;

  const read = async () => {
    if (!picked) return;
    if (picked.size > MAX_BYTES) {
      setErr("Packages up to 100 MB can be imported — export the deck without media, or in parts.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append("file", picked);
      form.append("media", media ? "true" : "false");
      form.append("history", history ? "true" : "false");
      const { data } = await apiClient.post<Result>(`/items/k/flashcards/${item.fileId}/apkg`, form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 600_000,
      });
      setRes(data);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(typeof detail === "string" ? detail : "That package couldn't be read.");
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!res) return;
    // Ids / times / seeds outside the mutator (it may replay on newer data).
    const seeds = new Map(res.decks.map((p) => [p, deckSeed()]));
    const at = F.iso(Date.now());
    const tally = { added: 0, dup: 0, full: 0 };
    item.update((d) => {
      tally.added = tally.dup = tally.full = 0;
      const deckOf = new Map<string, string>();
      const ids = new Set(d.cards.map((c) => c.id));
      const fronts = new Map<string, Set<string>>();
      for (const c of d.cards) {
        let set = fronts.get(c.deck_id);
        if (!set) fronts.set(c.deck_id, (set = new Set()));
        set.add(normFront(c.front));
      }
      const fresh = new Set<string>();
      for (const ic of res.cards) {
        if (ids.has(ic.id)) {
          tally.dup += 1;
          continue;
        }
        if (d.cards.length >= MAX_CARDS) {
          tally.full += 1;
          continue;
        }
        let deckId = deckOf.get(ic.deck);
        if (!deckId) {
          deckId = ensureDeck(d, ic.deck, seeds.get(ic.deck) ?? seeds.values().next().value ?? deckSeed());
          deckOf.set(ic.deck, deckId);
        }
        let set = fronts.get(deckId);
        if (!set) fronts.set(deckId, (set = new Set()));
        const key = normFront(ic.front);
        if (set.has(key)) {
          tally.dup += 1;
          continue;
        }
        set.add(key);
        ids.add(ic.id);
        fresh.add(ic.id);
        const card: Card = {
          id: ic.id,
          deck_id: deckId,
          type: ic.type,
          front: ic.front,
          back: ic.back,
          note: ic.note,
          tags: ic.tags.slice(0, 30),
          flagged: false,
          suspended: ic.suspended,
          buried_until: null,
          created: ic.created || at,
          modified: at,
          srs: ic.srs.map((s) => ({ ...s })),
        };
        d.cards.push(card);
        tally.added += 1;
      }
      const logs = res.logs.filter((e) => fresh.has(e.c)).map((e) => ({ ...e }));
      if (logs.length) {
        const first = d.review_log.length ? F.parseMoment(d.review_log[0].t) : Infinity;
        if (logs.every((e) => F.parseMoment(e.t) <= first)) d.review_log.unshift(...logs);
        else {
          // Keep the log in time order (today's counts read it from the end).
          d.review_log.push(...logs);
          d.review_log.sort((a, b) => F.parseMoment(a.t) - F.parseMoment(b.t));
        }
      }
    });
    const bits = [`Imported ${tally.added} card${tally.added === 1 ? "" : "s"} from Anki`];
    if (tally.dup) bits.push(`${tally.dup} already here`);
    if (tally.full) bits.push(`${tally.full} didn't fit (${MAX_CARDS.toLocaleString()} cards a file)`);
    onDone(bits.join(" · "));
    setRes(null);
    setPicked(null);
  };

  if (res) {
    const withHistory = res.cards.filter((c) => c.srs.some((s) => s.state !== "new")).length;
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-[var(--text)]">
          Found <b>{res.cards.length}</b> card{res.cards.length === 1 ? "" : "s"} in {res.decks.length} deck{res.decks.length === 1 ? "" : "s"} ({res.notes} notes
          {res.skipped ? `, ${res.skipped} skipped — empty or unsupported` : ""}
          {res.truncated ? `, ${res.truncated} over the ${MAX_CARDS.toLocaleString()}-card limit` : ""}).
        </p>
        <ul className="list-disc pl-5 text-[var(--text-muted)]">
          <li>
            {withHistory} card{withHistory === 1 ? "" : "s"} keep{withHistory === 1 ? "s" : ""} their progress — {res.history.reviews.toLocaleString()} Anki reviews replayed through FSRS
            {res.history.dropped ? `; the newest ${res.history.imported.toLocaleString()} are kept for stats` : ""}.
          </li>
          {res.media.requested && (
            <li>
              {res.media.stored} media file{res.media.stored === 1 ? "" : "s"} saved to Drive → Flashcards media
              {res.media.failed ? `, ${res.media.failed} couldn't be used (not a plain image/audio file)` : ""}
              {res.media.missing ? `, ${res.media.missing} missing from the package` : ""}.
            </li>
          )}
          {res.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          {res.cards.slice(0, 6).map((c) => (
            <div key={c.id} className="px-3 py-2">
              <p className="truncate font-medium text-[var(--text)]">{oneLine(c.front, 140)}</p>
              <p className="truncate text-xs text-[var(--text-muted)]">
                {c.type !== "basic" ? `${c.type} · ` : ""}
                {oneLine(c.back, 120)} · {c.deck}
              </p>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <ItemButton onClick={() => setRes(null)}>Back</ItemButton>
          <ItemButton variant="primary" block disabled={!item.canEdit || !res.cards.length} onClick={add}>
            Add {res.cards.length} card{res.cards.length === 1 ? "" : "s"}
          </ItemButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <ItemButton icon={<FileUp className="h-4 w-4" />} onClick={() => file.current?.click()}>
          {picked ? "Choose another" : "Choose an .apkg"}
        </ItemButton>
        <span className="min-w-0 truncate text-sm text-[var(--text)]">{picked ? `${picked.name} · ${(picked.size / 1024 / 1024).toFixed(1)} MB` : ""}</span>
        <input
          ref={file}
          type="file"
          accept=".apkg,.colpkg,application/zip"
          className="hidden"
          onChange={(e) => {
            setPicked(e.target.files?.[0] ?? null);
            setErr(null);
          }}
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex min-h-[44px] items-center justify-between gap-3 text-sm text-[var(--text)]">
          <span>Bring images and sounds (saved to your Drive)</span>
          <Toggle checked={media} onChange={setMedia} label="Bring images and sounds" />
        </div>
        <div className="flex min-h-[44px] items-center justify-between gap-3 text-sm text-[var(--text)]">
          <span>Bring review history (cards keep their progress)</span>
          <Toggle checked={history} onChange={setHistory} label="Bring review history" />
        </div>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Notes (Basic, reversed, type-in and Cloze), decks, tags, suspended cards, review history and media come across; Anki's HTML formatting becomes Markdown, and
        custom card templates and styling don't. From Anki 2.1.50 or newer, export with <b>"Support older Anki versions"</b> ticked. Up to 100 MB.
      </p>
      {!online && <p className="text-sm text-[var(--warning)]">Importing a package needs a connection.</p>}
      {err && (
        <p className="text-sm text-[var(--danger)]" role="alert">
          {err}
        </p>
      )}
      <ItemButton variant="primary" block icon={<Package className="h-4 w-4" />} disabled={!picked || busy || !online || !item.canEdit} onClick={read}>
        {busy ? "Reading the package…" : "Read package"}
      </ItemButton>
    </div>
  );
}
