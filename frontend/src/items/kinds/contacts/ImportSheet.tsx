import { CheckCircle2, FileUp, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Field, ItemButton, Segmented, Sheet, Toggle, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { MONTH_FIRST_COUNTRIES, csvToContacts, type CsvFormat, type DateOrder } from "./csv";
import { importName, type ImportContact } from "./importing";
import { DupeIndex } from "./model";
import { PHOTO_BUDGET_CHARS, photoChars, shrinkPhoto } from "./photo";
import { useHomeCountry, type Handle } from "./shared";
import { parseVCards } from "./vcard";

/* Bring people over: a .vcf (Google, iCloud, Android, Outlook…) or a CSV
 * (Google Contacts, Outlook, any Name/Email/Phone sheet). Nobody is merged
 * unless the person chooses to, and only on a shared email, full phone
 * number or card — never on a name. People in one file are never matched
 * with each other (a shared family landline isn't one person). */

type Mode = "add" | "merge" | "skip";
const CHUNK = 300;

interface Result {
  added: number;
  merged: number;
  skipped: number;
  already: number;
  photosLeftOut: number;
}

interface AddResult {
  added: unknown[];
  merged: unknown[];
  skipped: unknown[];
  already_imported?: number;
  photos_left_out?: number;
}

async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  // Outlook's CSV is often Windows-1252: fall back when UTF-8 doesn't fit.
  if (utf8.includes("�")) {
    try {
      return new TextDecoder("windows-1252").decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

export function ImportSheet({ item, open, onClose }: { item: Handle; open: boolean; onClose: () => void }) {
  const cc = useHomeCountry(item);
  const [parsed, setParsed] = useState<ImportContact[] | null>(null);
  const [source, setSource] = useState("");
  const [skipped, setSkipped] = useState(0);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [dateOrder, setDateOrder] = useState<DateOrder>("none");
  const [dayFirst, setDayFirst] = useState(true);
  const [mode, setMode] = useState<Mode>("add");
  const [tagThem, setTagThem] = useState(true);
  const [busy, setBusy] = useState<{ done: number; total: number; what: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // One id per chosen file: its chunks (and any retry) share it, so the
  // server never matches people of this import with each other and skips
  // rows it already added.
  const importId = useRef("");
  const nextChunk = useRef(0);
  const totals = useRef<Result>({ added: 0, merged: 0, skipped: 0, already: 0, photosLeftOut: 0 });

  useEffect(() => {
    if (open) {
      setParsed(null);
      setSource("");
      setSkipped(0);
      setCsvText(null);
      setResult(null);
      setError(null);
      setBusy(null);
      setMode("add");
    }
  }, [open]);

  // What the server would do, counted the same way (DupeIndex mirrors logic.py).
  const matches = useMemo(() => {
    if (!parsed) return { strong: 0, nameOnly: 0 };
    const index = new DupeIndex(item.data.contacts, cc);
    let strong = 0;
    let nameOnly = 0;
    for (const c of parsed) {
      if (index.match(c)) strong++;
      else if (index.nameMatch(c)) nameOnly++;
    }
    return { strong, nameOnly };
  }, [parsed, item.data.contacts, cc]);

  const readCsv = (text: string, name: string, df?: boolean) => {
    const res = csvToContacts(text, { dayFirst: df ?? !MONTH_FIRST_COUNTRIES.has(cc) });
    const names: Record<CsvFormat, string> = { google: "Google Contacts CSV", outlook: "Outlook CSV", generic: "CSV" };
    setParsed(res.contacts);
    setSource(`${names[res.format]} · ${name}`);
    setSkipped(res.skipped);
    setDateOrder(res.dateOrder);
    setDayFirst(res.dayFirst);
  };

  const take = async (file: File) => {
    setError(null);
    importId.current = uid("imp");
    nextChunk.current = 0;
    totals.current = { added: 0, merged: 0, skipped: 0, already: 0, photosLeftOut: 0 };
    setFileName(file.name);
    try {
      const text = await readText(file);
      if (/BEGIN:VCARD/i.test(text)) {
        setParsed(parseVCards(text));
        setSource(`vCard · ${file.name}`);
        setSkipped(0);
        setCsvText(null);
        setDateOrder("none");
      } else {
        setCsvText(text);
        readCsv(text, file.name);
      }
    } catch {
      setError("That file couldn't be read. Export a .vcf or .csv from your contacts app and try again.");
    }
  };

  const run = async () => {
    if (!parsed?.length) return;
    const tag = `Imported ${new Date().toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
    const rows = parsed.map((c, i) => ({
      ...c,
      tags: tagThem ? [...(c.tags ?? []), tag].slice(0, 50) : c.tags,
      import_ref: `${importId.current}:${i}`,
    }));
    const total = totals.current;
    // Photos are shrunk here (on the device) and only while the file has room.
    let room = PHOTO_BUDGET_CHARS - photoChars(item.data.contacts);
    setBusy({ done: nextChunk.current, total: rows.length, what: "Importing" });
    try {
      for (let i = nextChunk.current; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        for (const c of chunk) {
          if (!c.photo) continue;
          const small = room > 20_000 ? await shrinkPhoto(c.photo, { size: 160, maxChars: 16_000 }) : null;
          if (small) room -= small.length;
          else total.photosLeftOut++;
          c.photo = small;
        }
        const res = await item.runAction<AddResult>("add_contacts", {
          contacts: chunk,
          on_duplicate: mode,
          batch: true,
          import_id: importId.current,
        });
        total.added += res.result.added.length;
        total.merged += res.result.merged.length;
        total.skipped += res.result.skipped.length;
        total.already += res.result.already_imported ?? 0;
        total.photosLeftOut += res.result.photos_left_out ?? 0;
        nextChunk.current = i + CHUNK;
        setBusy({ done: Math.min(rows.length, i + CHUNK), total: rows.length, what: "Importing" });
      }
      nextChunk.current = 0;
      setResult({ ...total });
      toast.success(`Imported: ${total.added} added${total.merged ? `, ${total.merged} merged` : ""}${total.skipped ? `, ${total.skipped} skipped` : ""}`);
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      const done = total.added + total.merged;
      setError(
        `Import paused${done ? ` after ${done.toLocaleString()} people` : ""}: ${offline ? "you're offline" : detail ?? "something went wrong"}. ` +
          "Retry carries on where it stopped — nobody is added twice.",
      );
    } finally {
      setBusy(null);
    }
  };

  const tagLabel = `Imported ${new Date().toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
  const paused = !!error && !!parsed && nextChunk.current > 0;

  return (
    <Sheet
      open={open}
      onClose={busy ? () => undefined : onClose}
      size="lg"
      title="Import contacts"
      footer={
        result ? (
          <ItemButton variant="primary" block onClick={onClose}>
            Done
          </ItemButton>
        ) : parsed ? (
          <>
            <ItemButton variant="ghost" disabled={!!busy || paused} onClick={() => setParsed(null)}>
              Back
            </ItemButton>
            <ItemButton
              variant="primary"
              block
              disabled={!parsed.length || !!busy || !item.canEdit}
              icon={paused ? <RotateCcw className="h-4 w-4" /> : undefined}
              onClick={() => void run()}
            >
              {busy ? `${busy.what} ${busy.done.toLocaleString()}/${busy.total.toLocaleString()}…` : paused ? "Retry" : `Import ${parsed.length.toLocaleString()}`}
            </ItemButton>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
        {result ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center" aria-live="polite">
            <CheckCircle2 className="h-10 w-10 text-[var(--success)]" />
            <p className="text-base font-semibold text-[var(--text)]">{result.added.toLocaleString()} added</p>
            <p className="text-sm text-[var(--text-muted)]">
              {result.merged ? `${result.merged} merged into people you had · ` : ""}
              {result.skipped ? `${result.skipped} already there, skipped · ` : ""}
              {result.already ? `${result.already} were already in from the first try · ` : ""}
              {result.photosLeftOut ? `${result.photosLeftOut} photos left out to keep the file small · ` : ""}
              Look under Groups → Find duplicates for anything that still looks doubled.
            </p>
          </div>
        ) : !parsed ? (
          <>
            <button
              type="button"
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void take(f);
              }}
              className={cn(
                "flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition",
                over ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)]" : "border-[var(--border)] hover:border-[var(--item-accent)]",
              )}
            >
              <FileUp className="h-8 w-8 text-[var(--item-accent)]" />
              <span className="text-sm font-semibold text-[var(--text)]">Choose a .vcf or .csv file</span>
              <span className="text-xs text-[var(--text-muted)]">or drop it here</span>
            </button>
            <input
              ref={input}
              type="file"
              accept=".vcf,.vcard,.csv,.txt,text/vcard,text/x-vcard,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void take(f);
                e.target.value = "";
              }}
            />
            <div className="grid grid-cols-1 gap-2 text-xs text-[var(--text-muted)] sm:grid-cols-3">
              <p>
                <strong className="text-[var(--text)]">Google:</strong> contacts.google.com → Export → vCard or Google CSV.
              </p>
              <p>
                <strong className="text-[var(--text)]">iPhone / iCloud:</strong> icloud.com/contacts → select all → Export vCard.
              </p>
              <p>
                <strong className="text-[var(--text)]">Outlook:</strong> People → Manage → Export contacts (CSV).
              </p>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              This is a copy — there's no phone sync or CardDAV yet, so changes here don't reach your phone. Export a vCard to take people back.
            </p>
          </>
        ) : (
          <>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm font-semibold text-[var(--text)]">
                {parsed.length.toLocaleString()} {parsed.length === 1 ? "person" : "people"} found
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {source}
                {skipped ? ` · ${skipped} empty rows left out` : ""}
              </p>
              {parsed.length > 0 && (
                <p className="mt-2 line-clamp-2 text-sm text-[var(--text-muted)]">
                  {parsed.slice(0, 8).map(importName).join(", ")}
                  {parsed.length > 8 ? `, and ${(parsed.length - 8).toLocaleString()} more` : ""}
                </p>
              )}
            </div>
            {csvText !== null && dateOrder === "ambiguous" && (
              <Field label="Dates like 04/05/1990 in this file mean…" hint="Every date in the file could be read either way — pick how your old app wrote them.">
                <Segmented<"dmy" | "mdy">
                  value={dayFirst ? "dmy" : "mdy"}
                  onChange={(v) => readCsv(csvText, fileName, v === "dmy")}
                  options={[
                    { value: "dmy", label: "4 May (day first)" },
                    { value: "mdy", label: "April 5 (month first)" },
                  ]}
                />
              </Field>
            )}
            <Field
              label="People you might already have"
              hint={
                <>
                  {matches.strong
                    ? `${matches.strong.toLocaleString()} share an email, a full phone number or a card ID with someone in your contacts.`
                    : "Nobody shares an email, phone number or card ID with your contacts."}
                  {matches.nameOnly ? ` ${matches.nameOnly.toLocaleString()} only share a name — they're added as new people (check them in Find duplicates).` : ""}
                </>
              }
            >
              <Segmented<Mode>
                value={mode}
                onChange={setMode}
                options={[
                  { value: "add", label: "Add as new" },
                  { value: "merge", label: "Merge in" },
                  { value: "skip", label: "Skip them" },
                ]}
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--text)]">
                Tag them “{tagLabel}”
                <span className="block text-xs text-[var(--text-muted)]">Easy to find (or undo) later</span>
              </span>
              <Toggle checked={tagThem} onChange={setTagThem} label="Tag imported contacts" />
            </div>
            {busy && (
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy.what} {busy.done.toLocaleString()} of {busy.total.toLocaleString()}…
              </div>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
