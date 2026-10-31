import { Download, FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, ItemButton, Segmented, Select, Sheet, TextArea, TextInput } from "@/items/ui";

import { ApkgImport } from "./ApkgImport";
import { deckPaths, download, oneLine, toCSV, subtree } from "./cards";
import { DeckSelect } from "./common";
import type { Data } from "./types";

type Fmt = "auto" | "csv" | "tsv" | "quizlet" | "anki";

interface Preview {
  format: string;
  count: number;
  skipped: number;
  preview: { type: string; front: string; back: string; tags: string[]; deck: string | null }[];
}

/** Import (parsed on the server — the same parser the AI uses) and export. */
export function ImportSheet({ item, open, onClose }: { item: ItemHandle<Data>; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"import" | "export">("import");
  const [source, setSource] = useState<"text" | "apkg">("text");
  const [text, setText] = useState("");
  const [fmt, setFmt] = useState<Fmt>("auto");
  const [termSep, setTermSep] = useState("tab");
  const [cardSep, setCardSep] = useState("newline");
  const [deck, setDeck] = useState("Imported");
  const [tags, setTags] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [exportDeck, setExportDeck] = useState("");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setErr(null);
      setDone(null);
    }
  }, [open]);
  useEffect(() => setPreview(null), [text, fmt, termSep, cardSep]);

  const args = () => ({
    text,
    format: fmt,
    deck: deck.trim() || "Imported",
    tags: tags.split(/[\s,]+/).filter(Boolean),
    ...(fmt === "quizlet" ? { term_sep: termSep, card_sep: cardSep } : {}),
  });

  const run = async (dry: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await item.runAction<Preview & { added?: number }>("import_cards", { ...args(), dry_run: dry });
      if (dry) setPreview(res.result);
      else {
        setDone(res.summary);
        setText("");
        setPreview(null);
      }
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(typeof detail === "string" ? detail : "That didn't import.");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) {
      setErr("That file is over 2 MB — split it up.");
      return;
    }
    const t = await f.text();
    setText(t);
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".csv")) setFmt("csv");
    else if (lower.endsWith(".tsv")) setFmt("tsv");
    else setFmt("auto");
    if (deck === "Imported") setDeck(f.name.replace(/\.[^.]+$/, "").slice(0, 80));
  };

  const paths = deckPaths(item.data.decks);
  const exportCount = exportDeck ? item.data.cards.filter((c) => subtree(item.data.decks, exportDeck).has(c.deck_id)).length : item.data.cards.length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import & export"
      size="lg"
      footer={
        tab === "import" && source === "apkg" && !done ? undefined : tab === "import" ? (
          preview ? (
            <>
              <ItemButton onClick={() => setPreview(null)}>Back</ItemButton>
              <ItemButton variant="primary" block disabled={busy || !item.canEdit} onClick={() => run(false)}>
                Import {preview.count} card{preview.count === 1 ? "" : "s"}
              </ItemButton>
            </>
          ) : (
            <ItemButton variant="primary" block disabled={busy || !text.trim()} onClick={() => run(true)}>
              {busy ? "Reading…" : "Preview"}
            </ItemButton>
          )
        ) : (
          <ItemButton
            variant="primary"
            block
            icon={<Download className="h-4 w-4" />}
            disabled={!exportCount}
            onClick={() => {
              const ids = exportDeck ? new Set(item.data.cards.filter((c) => subtree(item.data.decks, exportDeck).has(c.deck_id)).map((c) => c.id)) : undefined;
              const name = (exportDeck ? paths.get(exportDeck) ?? "deck" : "flashcards").replace(/::/g, " - ");
              download(`${name}.csv`, toCSV(item.data, ids));
            }}
          >
            Download CSV ({exportCount})
          </ItemButton>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: "import", label: "Import" }, { value: "export", label: "Export" }]} />
        {tab === "import" && !done && (
          <Segmented
            size="sm"
            value={source}
            onChange={setSource}
            options={[
              { value: "text", label: "Text, CSV, Quizlet" },
              { value: "apkg", label: "Anki package (.apkg)" },
            ]}
          />
        )}
        {tab === "import" && source === "apkg" && !done ? (
          <ApkgImport item={item} onDone={setDone} />
        ) : tab === "export" ? (
          <>
            <Field label="Deck">
              <DeckSelect decks={item.data.decks} value={exportDeck} onChange={setExportDeck} allLabel="All decks" />
            </Field>
            <p className="text-sm text-[var(--text-muted)]">
              CSV with front, back, tags, deck, note and type — opens in any spreadsheet and imports into Anki ("Notes in plain text") or Quizlet. Your whole file (with
              scheduling) is also downloadable from the ••• menu.
            </p>
          </>
        ) : done ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
            <p className="text-base font-semibold text-[var(--text)]">{done}</p>
            <ItemButton onClick={() => setDone(null)}>Import more</ItemButton>
          </div>
        ) : preview ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text)]">
              Found <b>{preview.count}</b> card{preview.count === 1 ? "" : "s"} ({preview.format})
              {preview.skipped ? `, ${preview.skipped} row${preview.skipped === 1 ? "" : "s"} unreadable` : ""}. Duplicates of existing cards are skipped.
            </p>
            <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              {preview.preview.slice(0, 8).map((c, i) => (
                <div key={i} className="px-3 py-2 text-sm">
                  <p className="truncate font-medium text-[var(--text)]">{oneLine(c.front, 140)}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {c.type !== "basic" ? `${c.type} · ` : ""}
                    {oneLine(c.back, 140)}
                    {c.deck ? ` · ${c.deck}` : ""}
                    {c.tags.length ? ` · #${c.tags.join(" #")}` : ""}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <ItemButton icon={<FileUp className="h-4 w-4" />} onClick={() => file.current?.click()}>
                Choose a file
              </ItemButton>
              <span className="text-xs text-[var(--text-muted)]">.txt (Anki), .csv, .tsv — or paste below</span>
              <input ref={file} type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            </div>
            <TextArea value={text} onChange={(e) => setText(e.target.value)} placeholder={"front,back,tags\nhola,hello,spanish\n…or paste a Quizlet export / Anki notes export"} className="min-h-[140px] font-mono text-xs" />
            <Field label="Format">
              <Select value={fmt} onChange={(e) => setFmt(e.target.value as Fmt)}>
                <option value="auto">Detect automatically</option>
                <option value="csv">CSV (front, back, tags)</option>
                <option value="tsv">TSV / tab-separated</option>
                <option value="quizlet">Quizlet export</option>
                <option value="anki">Anki — Notes in plain text</option>
              </Select>
            </Field>
            {fmt === "quizlet" && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Between term and definition">
                  <Select value={termSep} onChange={(e) => setTermSep(e.target.value)}>
                    <option value="tab">Tab</option>
                    <option value="comma">Comma</option>
                    <option value=" - ">Dash ( - )</option>
                    <option value=":">Colon</option>
                  </Select>
                </Field>
                <Field label="Between cards">
                  <Select value={cardSep} onChange={(e) => setCardSep(e.target.value)}>
                    <option value="newline">New line</option>
                    <option value="semicolon">Semicolon</option>
                    <option value="blankline">Blank line</option>
                  </Select>
                </Field>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Into deck" hint="Anki's deck column wins when there is one. Use :: to nest.">
                <TextInput value={deck} onChange={(e) => setDeck(e.target.value)} list="fc-deck-paths" />
              </Field>
              <Field label="Add tags">
                <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="imported" />
              </Field>
            </div>
            <datalist id="fc-deck-paths">
              {[...paths.values()].map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </>
        )}
        {err && (
          <p className="text-sm text-[var(--danger)]" role="alert">
            {err}
          </p>
        )}
      </div>
    </Sheet>
  );
}
