import { useQuery } from "@tanstack/react-query";
import {
  BedDouble,
  Bus,
  CarFront,
  Check,
  Copy,
  FileText,
  Footprints,
  MapPin,
  Paperclip,
  Plane,
  Search,
  Ship,
  ShieldCheck,
  StickyNote,
  Ticket,
  TrainFront,
  Utensils,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { filesApi } from "@/api/files";
import { downloadAuthed } from "@/components/files/helpers";
import { itemsApi } from "@/items/api";
import type { ItemHandle } from "@/items/useItem";
import { Chip, ItemButton, Select, Sheet, TextInput, safeHref } from "@/items/ui";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import type { Attachment, BookingType, PlanType, Trip } from "./types";
import { allZones } from "./tz";

/* ------------------------------------------------------------- icons */

export const TYPE_ICON: Record<BookingType | PlanType, LucideIcon> = {
  flight: Plane,
  stay: BedDouble,
  car: CarFront,
  train: TrainFront,
  bus: Bus,
  ferry: Ship,
  tour: Footprints,
  ticket: Ticket,
  insurance: ShieldCheck,
  other: FileText,
  activity: MapPin,
  food: Utensils,
  transport: TrainFront,
  note: StickyNote,
};

const TINT: Record<string, string> = {
  flight: "#2C9CC8",
  stay: "#7B6CD9",
  car: "#C08B2C",
  train: "#3E8E5A",
  bus: "#3E8E5A",
  ferry: "#3B7DD8",
  transport: "#3E8E5A",
  tour: "#E2725B",
  ticket: "#E2725B",
  activity: "#E2725B",
  food: "#D9902F",
  insurance: "#4F8A8B",
  note: "#8A6F5A",
  other: "#8A6F5A",
};

export function TypeBadge({ type, size = 36, className }: { type: BookingType | PlanType; size?: number; className?: string }) {
  const Icon = TYPE_ICON[type] ?? MapPin;
  const c = TINT[type] ?? "var(--item-accent)";
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-xl", className)}
      style={{ width: size, height: size, background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

export const tint = (type: string) => TINT[type] ?? "var(--item-accent)";

/* ----------------------------------------------------------- inputs */

const COMMON = ["AUD", "USD", "EUR", "GBP", "JPY", "NZD", "CAD", "CHF", "CNY", "HKD", "SGD", "THB", "IDR", "KRW", "INR", "VND", "MYR", "PHP", "TWD", "MXN", "ZAR", "AED", "SEK", "NOK", "DKK", "ISK", "TRY", "CZK", "HUF", "PLN", "BRL", "ARS", "CLP", "PEN", "COP", "FJD", "EGP", "MAD"];

export function currencyOptions(t: Trip): string[] {
  const first = [t.settings.home_currency, ...t.currencies.map((c) => c.code)];
  return [...new Set([...first, ...COMMON])];
}

export function CurrencySelect({ trip, value, onChange, label = "Currency" }: { trip: Trip; value: string; onChange: (v: string) => void; label?: string }) {
  const opts = currencyOptions(trip);
  const known = new Set([trip.settings.home_currency, ...trip.currencies.map((c) => c.code)]);
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {opts.map((c) => (
        <option key={c} value={c}>
          {c}
          {known.has(c) ? "" : " (no rate)"}
        </option>
      ))}
    </Select>
  );
}

export function ZoneInput({ value, onChange, placeholder = "e.g. Asia/Tokyo", label }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const id = useId();
  const zones = useMemo(() => allZones(), []);
  return (
    <>
      <TextInput aria-label={label} list={id} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      <datalist id={id}>
        {zones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </>
  );
}

/** Amount as typed ("1,234.50") → number, or null. */
export function parseAmount(s: string): number | null {
  const clean = s.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : null;
}

export function TravellerChips({
  trip,
  value,
  onChange,
  emptyMeansAll = true,
}: {
  trip: Trip;
  value: string[];
  onChange: (ids: string[]) => void;
  emptyMeansAll?: boolean;
}) {
  if (trip.travellers.length < 2) return null;
  const all = emptyMeansAll && value.length === 0;
  return (
    <div className="flex flex-wrap gap-2">
      {emptyMeansAll && (
        <Chip active={all} onClick={() => onChange([])}>
          Everyone
        </Chip>
      )}
      {trip.travellers.map((t) => {
        const on = !all && value.includes(t.id);
        return (
          <Chip key={t.id} active={on} onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}>
            {t.name}
          </Chip>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- bits */

export function CopyCode({ code, label = "Booking ref" }: { code: string; label?: string }) {
  const [done, setDone] = useState(false);
  if (!code) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(code).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      aria-label={`Copy ${label.toLowerCase()} ${code}`}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-2 font-mono text-xs font-semibold tracking-wider text-[var(--text)] hover:bg-[var(--hover)]"
    >
      {code}
      {done ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5 text-[var(--text-muted)]" />}
    </button>
  );
}

export function Meta({ label, children }: { label: string; children: ReactNode }) {
  if (children === "" || children === null || children === undefined || children === false) return null;
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-[var(--text)]">{children}</div>
    </div>
  );
}

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

/* ----------------------------------------------------- attachments */

export function Attachments({ files, onRemove }: { files: Attachment[]; onRemove?: (id: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f) => (
        <span key={f.file_id} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] pl-2 text-xs">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 py-1.5 text-[var(--text)] hover:underline"
            onClick={() => void downloadAuthed({ id: f.file_id, filename: f.name || "attachment" })}
          >
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="truncate">{f.name || "Attachment"}</span>
          </button>
          {onRemove ? (
            <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.file_id)} className="flex h-8 w-8 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <span className="w-2" />
          )}
        </span>
      ))}
    </div>
  );
}

/** Pick a file from Promptly Files (booking PDFs, tickets, scans). */
export function DrivePicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (a: Attachment) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ["trip-drive-pick", debounced],
    queryFn: async () => (debounced ? (await filesApi.search(debounced, "mine", 20)).hits.map((h) => h.file) : (await filesApi.listRecent("mine", 20)).files),
    enabled: open,
    staleTime: 30_000,
  });
  return (
    <Sheet open={open} onClose={onClose} title="Attach from Files">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <TextInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your files" className="pl-9" />
        </div>
        <div className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)]">
          {(data ?? []).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                onPick({ file_id: f.id, name: f.filename });
                onClose();
              }}
              className="flex min-h-[48px] items-center gap-3 px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
            >
              <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{f.filename}</span>
            </button>
          ))}
          {!isFetching && (data ?? []).length === 0 && <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">No files found.</p>}
          {isFetching && !data && <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">Searching…</p>}
        </div>
      </div>
    </Sheet>
  );
}

/* --------------------------------------------------- server checks */

export interface Issue {
  severity: "error" | "warning" | "info";
  kind: string;
  message: string;
  booking_ids?: string[];
  item_ids?: string[];
  document_id?: string;
  dates?: [string, string];
}

// The last check per file, so a trip opened offline still shows what the
// server found last time (the check itself needs a connection).
const lastIssues = new Map<string, Issue[]>();

/** The server's ``conflicts`` check, refreshed whenever the file changes. */
export function useIssues(item: ItemHandle<Trip>): Issue[] {
  const online = typeof navigator === "undefined" || navigator.onLine !== false;
  const { data } = useQuery({
    queryKey: ["trip-issues", item.fileId, item.data.id, item.revision],
    queryFn: async () => {
      const r = await itemsApi.action<Trip>(item.fileId, "conflicts", { trip: item.data.id });
      const res = r.result as { issues?: Issue[] } | string;
      const list = typeof res === "string" ? [] : res.issues ?? [];
      lastIssues.set(`${item.fileId}/${item.data.id}`, list);
      return list;
    },
    enabled: online && !!item.data.id,
    staleTime: Infinity,
    retry: false,
  });
  return data ?? lastIssues.get(`${item.fileId}/${item.data.id}`) ?? [];
}

/* ------------------------------------------------------------- who */

/** The signed-in Promptly user's id (each viewer has their own "me"). */
export function useUserId(): string | null {
  return useAuthStore((s) => s.user?.id) ?? null;
}

/** A link field's problem, or null (empty is fine). */
export function linkProblem(link: string): string | null {
  return link.trim() && !safeHref(link) ? "Links must be web (https://…), mailto: or tel: addresses." : null;
}

/** A delete button that asks first (two taps, no dialog). */
export function ConfirmDelete({ onConfirm, label = "Delete", question = "Delete this?" }: { onConfirm: () => void; label?: string; question?: string }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = window.setTimeout(() => setAsking(false), 5000);
    return () => window.clearTimeout(t);
  }, [asking]);
  if (!asking)
    return (
      <ItemButton variant="ghost" className="text-[var(--danger)]" onClick={() => setAsking(true)}>
        {label}
      </ItemButton>
    );
  return (
    <span className="flex items-center gap-1" role="group" aria-label={question}>
      <span className="text-sm text-[var(--text)]" aria-live="polite">
        {question}
      </span>
      <ItemButton variant="ghost" className="font-semibold text-[var(--danger)]" onClick={onConfirm}>
        Yes, delete
      </ItemButton>
      <ItemButton variant="ghost" onClick={() => setAsking(false)}>
        Keep
      </ItemButton>
    </span>
  );
}

export function SeverityDot({ severity }: { severity: Issue["severity"] }) {
  return (
    <span
      aria-hidden
      className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: severity === "error" ? "var(--danger)" : severity === "warning" ? "var(--warning)" : "var(--text-muted)" }}
    />
  );
}

export function FieldRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3", className)}>{children}</div>;
}

export function SheetFooter({ onSave, onDelete, saveLabel = "Save", disabled }: { onSave: () => void; onDelete?: () => void; saveLabel?: string; disabled?: boolean }) {
  return (
    <>
      {onDelete && (
        <ItemButton variant="ghost" className="text-[var(--danger)]" onClick={onDelete}>
          Delete
        </ItemButton>
      )}
      <ItemButton variant="primary" block disabled={disabled} onClick={onSave}>
        {saveLabel}
      </ItemButton>
    </>
  );
}
