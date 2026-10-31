import { FileUp } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { toast } from "@/store/toastStore";
import { Field, ItemButton, Segmented, Select, Sheet, TextInput, Toggle } from "@/items/ui";

import { errorText } from "./api";
import { useMoney, type H } from "./common";
import { parseMoney } from "./logic";

/*
 * Import a bank CSV (CommBank, NAB, ANZ, Westpac, ING, Macquarie, Up's
 * export…): parsed here in the browser, columns mapped (guessed, then
 * adjustable), previewed, and sent in chunks to ``import_transactions``,
 * which skips duplicates and applies rules.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const src = text.replace(/^﻿/, "");
  const delim = (() => {
    const first = src.split(/\r?\n/, 1)[0] ?? "";
    const c = (ch: string) => first.split(ch).length;
    return c(";") > c(",") && c(";") > c("\t") ? ";" : c("\t") > c(",") ? "\t" : ",";
  })();
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

type DateFmt = "dmy" | "ymd" | "mdy";

export function parseDate(s: string, fmt: DateFmt): string | null {
  const t = s.trim().split(/[ T]/)[0];
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return fmt === "mdy" ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]);
  }
  m = t.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2,4})$/);
  if (m) {
    const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], mi + 1, +m[1]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface Mapping {
  date: number;
  amount: number;
  debit: number;
  credit: number;
  description: number;
  payee: number;
  category: number;
}

function guess(rows: string[][]): { header: boolean; map: Mapping; fmt: DateFmt } {
  const first = rows[0] ?? [];
  const looksDate = (s: string) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(s) || /^\d{1,2}[ -][A-Za-z]{3}/.test(s);
  const header = !first.some(looksDate);
  const map: Mapping = { date: -1, amount: -1, debit: -1, credit: -1, description: -1, payee: -1, category: -1 };
  const body = header ? rows.slice(1, 40) : rows.slice(0, 40);
  if (header) {
    first.forEach((h, i) => {
      const x = h.toLowerCase();
      if (map.date < 0 && /date/.test(x) && !/process|value date/.test(x)) map.date = i;
      else if (map.debit < 0 && /debit|withdraw|money out|paid out/.test(x)) map.debit = i;
      else if (map.credit < 0 && /credit|deposit|money in|paid in/.test(x)) map.credit = i;
      else if (map.amount < 0 && /amount|value|aud/.test(x) && !/balance/.test(x)) map.amount = i;
      else if (map.payee < 0 && /payee|merchant|counterparty/.test(x)) map.payee = i;
      else if (map.category < 0 && /categ/.test(x)) map.category = i;
      else if (map.description < 0 && /desc|narrat|detail|memo|particular|transaction|reference/.test(x)) map.description = i;
    });
  }
  const cols = Math.max(...body.map((r) => r.length), first.length);
  if (map.date < 0) for (let i = 0; i < cols && map.date < 0; i++) if (body.filter((r) => looksDate(r[i] ?? "")).length > body.length * 0.7) map.date = i;
  if (map.amount < 0 && map.debit < 0) {
    for (let i = 0; i < cols && map.amount < 0; i++) {
      if (i === map.date) continue;
      const nums = body.filter((r) => Number.isFinite(parseMoney(r[i] ?? "")));
      if (nums.length > body.length * 0.8 && body.some((r) => (r[i] ?? "").includes("-"))) map.amount = i;
    }
    if (map.amount < 0) for (let i = 0; i < cols && map.amount < 0; i++) if (i !== map.date && body.every((r) => Number.isFinite(parseMoney(r[i] ?? "")))) map.amount = i;
  }
  if (map.description < 0) {
    let best = -1;
    let len = 0;
    for (let i = 0; i < cols; i++) {
      if ([map.date, map.amount, map.debit, map.credit].includes(i)) continue;
      const l = body.reduce((n, r) => n + (Number.isFinite(parseMoney(r[i] ?? "")) ? 0 : (r[i] ?? "").length), 0);
      if (l > len) {
        len = l;
        best = i;
      }
    }
    map.description = best;
  }
  // Date order: any first part > 12 means day-first; any second part > 12 means month-first.
  let fmt: DateFmt = "dmy";
  for (const r of body) {
    const m = (r[map.date] ?? "").match(/^(\d{1,2})[-/.](\d{1,2})[-/.]/);
    if (m && +m[2] > 12) fmt = "mdy";
    if (m && +m[1] > 12) {
      fmt = "dmy";
      break;
    }
  }
  if (body.some((r) => /^\d{4}/.test(r[map.date] ?? ""))) fmt = "ymd";
  return { header, map, fmt };
}

export function CsvImportSheet({ item, open, onClose }: { item: H; open: boolean; onClose: () => void }) {
  const fmt = useMoney(item);
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [header, setHeader] = useState(true);
  const [map, setMap] = useState<Mapping | null>(null);
  const [dfmt, setDfmt] = useState<DateFmt>("dmy");
  const [flip, setFlip] = useState(false);
  const [account, setAccount] = useState<string>("");
  const [newAccount, setNewAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const accounts = item.data.accounts.filter((a) => !a.archived && a.source !== "up");

  const reset = () => {
    setRows([]);
    setMap(null);
    setName("");
    setFlip(false);
  };

  const load = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      toast.error("That file is too big for a statement (15 MB max).");
      return;
    }
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length < 1) {
      toast.error("That file has no rows.");
      return;
    }
    const g = guess(parsed);
    setRows(parsed);
    setHeader(g.header);
    setMap(g.map);
    setDfmt(g.fmt);
    setName(file.name);
    if (!account) setAccount(accounts[0]?.id ?? "__new");
    if (!newAccount) setNewAccount(file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "Bank account");
  };

  const headers = header ? rows[0] ?? [] : (rows[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const body = header ? rows.slice(1) : rows;

  const parsed = useMemo(() => {
    if (!map) return { ok: [] as { date: string; amount: number; description: string; payee?: string; category?: string }[], bad: 0 };
    const ok: { date: string; amount: number; description: string; payee?: string; category?: string }[] = [];
    let bad = 0;
    for (const r of body) {
      const date = parseDate(r[map.date] ?? "", dfmt);
      let cents = NaN;
      if (map.amount >= 0) cents = parseMoney(r[map.amount] ?? "");
      else {
        const dr = map.debit >= 0 ? parseMoney(r[map.debit] ?? "") : NaN;
        const cr = map.credit >= 0 ? parseMoney(r[map.credit] ?? "") : NaN;
        if (Number.isFinite(dr) && dr !== 0) cents = -Math.abs(dr);
        else if (Number.isFinite(cr) && cr !== 0) cents = Math.abs(cr);
        else if (Number.isFinite(dr) || Number.isFinite(cr)) cents = 0;
      }
      if (!date || !Number.isFinite(cents)) {
        bad++;
        continue;
      }
      if (cents === 0) continue;
      if (flip) cents = -cents;
      ok.push({
        date,
        amount: cents / 100,
        description: (r[map.description] ?? "").slice(0, 300),
        ...(map.payee >= 0 && r[map.payee] ? { payee: r[map.payee].slice(0, 120) } : {}),
        ...(map.category >= 0 && r[map.category] ? { category: r[map.category].slice(0, 60) } : {}),
      });
    }
    return { ok, bad };
  }, [body, map, dfmt, flip]);

  const run = async () => {
    if (!parsed.ok.length) return;
    setBusy(true);
    try {
      let accountId = account === "__new" ? "" : account;
      if (account === "__new") {
        const r = await item.runAction<{ id: string }>("add_account", { name: newAccount.trim() || "Bank account", type: "transactional" });
        accountId = r.result.id;
      }
      let imported = 0;
      let skipped = 0;
      for (let i = 0; i < parsed.ok.length; i += 2000) {
        const r = await item.runAction<{ imported: number; skipped: number }>("import_transactions", {
          account_id: accountId || null,
          rows: parsed.ok.slice(i, i + 2000),
        });
        imported += r.result.imported;
        skipped += r.result.skipped;
      }
      toast.success(`Imported ${imported}${skipped ? `, skipped ${skipped} duplicates` : ""}`);
      reset();
      onClose();
    } catch (e) {
      toast.error(errorText(e, "The import didn't work."));
    } finally {
      setBusy(false);
    }
  };

  const col = (key: keyof Mapping, label: string, optional = true) =>
    map && (
      <Field label={label}>
        <Select value={map[key]} onChange={(e) => setMap({ ...map, [key]: Number(e.target.value) })}>
          {optional && <option value={-1}>—</option>}
          {headers.map((h, i) => (
            <option key={i} value={i}>
              {h || `Column ${i + 1}`}
            </option>
          ))}
        </Select>
      </Field>
    );

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Import a bank CSV"
      size="lg"
      footer={
        rows.length ? (
          <>
            <ItemButton variant="secondary" onClick={reset} disabled={busy}>
              Another file
            </ItemButton>
            <ItemButton variant="primary" className="flex-1" disabled={busy || !parsed.ok.length} onClick={() => void run()}>
              {busy ? "Importing…" : `Import ${parsed.ok.length.toLocaleString()} transactions`}
            </ItemButton>
          </>
        ) : undefined
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f);
          e.target.value = "";
        }}
      />
      {!rows.length ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
            <FileUp className="h-6 w-6" />
          </span>
          <p className="max-w-sm text-sm text-[var(--text-muted)]">
            Download a CSV from your bank's website (CommBank, NAB, ANZ, Westpac, ING, Macquarie… any bank works). Duplicates are skipped, so re-importing an overlapping statement is safe.
          </p>
          <ItemButton variant="primary" onClick={() => fileRef.current?.click()}>
            Choose a CSV file
          </ItemButton>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text-muted)]">
            <span className="font-medium text-[var(--text)]">{name}</span> · {body.length.toLocaleString()} rows. Check the columns below.
          </p>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>First row is a header</span>
            <Toggle checked={header} onChange={setHeader} label="First row is a header" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {col("date", "Date", false)}
            {col("amount", "Amount (signed)")}
            {col("description", "Description", false)}
            {map && map.amount < 0 && col("debit", "Money out (debit)")}
            {map && map.amount < 0 && col("credit", "Money in (credit)")}
            {col("payee", "Payee (optional)")}
            {col("category", "Category (optional)")}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              size="sm"
              value={dfmt}
              onChange={setDfmt}
              options={[
                { value: "dmy", label: "DD/MM/YYYY" },
                { value: "mdy", label: "MM/DD/YYYY" },
                { value: "ymd", label: "YYYY-MM-DD" },
              ]}
            />
            <label className="flex items-center gap-2 text-sm">
              <Toggle checked={flip} onChange={setFlip} label="Flip signs" />
              Spending shows as positive — flip signs
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Into account">
              <Select value={account} onChange={(e) => setAccount(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                <option value="__new">New account…</option>
              </Select>
            </Field>
            {account === "__new" && (
              <Field label="New account name">
                <TextInput value={newAccount} onChange={(e) => setNewAccount(e.target.value)} maxLength={80} />
              </Field>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <caption className="sr-only">Preview</caption>
              <thead className="bg-[var(--surface-2)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                <tr>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Description</th>
                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {parsed.ok.slice(0, 8).map((r, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{r.date}</td>
                    <td className="max-w-0 truncate px-3 py-2">{r.payee || r.description}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${r.amount > 0 ? "text-[var(--success)]" : ""}`}>{fmt(Math.round(r.amount * 100), { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.bad > 0 && (
            <p className="text-xs text-[var(--danger)]">
              {parsed.bad} row{parsed.bad === 1 ? "" : "s"} couldn't be read (date or amount) and will be skipped — check the columns and date format.
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}
