import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeftRight, FileUp, Plus, Receipt, RefreshCw, Search, Tags, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { toast } from "@/store/toastStore";
import type { ItemViewProps } from "@/items/types";
import { Chip, EmptyState, Fab, IconButton, ItemButton, Page, ScrollRow, Select, TextInput, fmtDay } from "@/items/ui";
import { cn } from "@/utils/cn";

import { errorText, upApi } from "./api";
import { Amount, CatBadge, CategoryPicker, Pill, useMoney, useWidth, type H } from "./common";
import { CsvImportSheet } from "./CsvImport";
import { catIndex, counts, isIncomeLine, txnLines } from "./logic";
import { FileFullNotice } from "./Settings";
import { RecategoriseSheet, TxnSheet } from "./TxnSheet";
import type { BudgetData, Txn } from "./types";

type Filter = "all" | "uncategorised" | "pending" | "transfers" | "in" | "out";

export interface TxnFilterState {
  q: string;
  filter: Filter;
  account: string;
  category: string | null;
  month: string;
}

function useFiltered(data: BudgetData, f: TxnFilterState) {
  const q = useDeferredValue(f.q.trim().toLowerCase());
  return useMemo(() => {
    const words = q.split(/\s+/).filter(Boolean);
    return data.transactions.filter((t) => {
      if (f.month && !t.date.startsWith(f.month)) return false;
      if (f.account && t.account_id !== f.account) return false;
      if (f.category && t.category_id !== f.category && !t.splits.some((s) => s.category_id === f.category)) return false;
      switch (f.filter) {
        case "uncategorised":
          if (t.category_id || t.splits.length || t.transfer) return false;
          break;
        case "pending":
          if (!t.pending) return false;
          break;
        case "transfers":
          if (!t.transfer) return false;
          break;
        case "in":
          if (t.amount_cents <= 0 || t.transfer) return false;
          break;
        case "out":
          if (t.amount_cents >= 0 || t.transfer) return false;
          break;
      }
      if (words.length) {
        const hay = `${t.payee} ${t.description} ${t.notes} ${t.tags.join(" ")} ${(Math.abs(t.amount_cents) / 100).toFixed(2)}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
  }, [data, f.account, f.category, f.filter, f.month, q]);
}

/** The scrolling ancestor (the shell's <main>) and where the list starts in it. */
function useScrollParent(active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    let p: HTMLElement | null = node.parentElement;
    while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    const scroller = p ?? (document.scrollingElement as HTMLElement);
    setEl(scroller);
    const measure = () => setMargin(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    if (node.parentElement) ro.observe(node.parentElement);
    return () => ro.disconnect();
  }, [active]);
  return { ref, el, margin };
}

export function TransactionsView({ item, isPhone, ask }: ItemViewProps<BudgetData>) {
  const data = item.data;
  const fmt = useMoney(item);
  const cats = useMemo(() => catIndex(data), [data]);
  const accounts = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);
  const [f, setF] = useState<TxnFilterState>({ q: "", filter: "all", account: "", category: null, month: "" });
  const rows = useFiltered(data, f);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Txn | null>(null);
  const [adding, setAdding] = useState(false);
  const [recat, setRecat] = useState<Txn[] | null>(null);
  const [catFilter, setCatFilter] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Layout follows the room the tab really has (the AI panel can take a
  // third of the window): a full table with a detail panel when wide, the
  // phone's grouped rows when narrow.
  const [widthRef, pageW] = useWidth<HTMLDivElement>();
  const compact = isPhone || (pageW > 0 && pageW < 640);
  const aside = !compact && pageW >= 980;
  const showAccount = data.accounts.length > 1 && (aside ? pageW - 340 : pageW) >= 860;
  const cols = showAccount ? "grid-cols-[28px_88px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.75fr)_110px]" : "grid-cols-[28px_88px_minmax(0,1.5fr)_minmax(0,1fr)_110px]";
  const months = useMemo(() => [...new Set(data.transactions.map((t) => t.date.slice(0, 7)))].sort().reverse().slice(0, 36), [data.transactions]);
  const uncategorised = useMemo(() => data.transactions.filter((t) => !t.category_id && !t.splits.length && !t.transfer).length, [data.transactions]);
  const totals = useMemo(() => {
    let inn = 0;
    let out = 0;
    for (const t of rows) {
      if (!counts(t)) continue;
      for (const [cid, c] of txnLines(t)) {
        if (isIncomeLine(cats, cid, c)) inn += c;
        else out -= c;
      }
    }
    return { inn, out };
  }, [rows, cats]);

  // Flattened rows for the virtual list (day headers on a phone).
  const flat = useMemo(() => {
    if (!compact) return rows.map((t) => ({ kind: "t" as const, t }));
    const out: ({ kind: "h"; day: string; net: number } | { kind: "t"; t: Txn })[] = [];
    let h: { kind: "h"; day: string; net: number } | null = null;
    for (const t of rows) {
      if (!h || t.date !== h.day) {
        h = { kind: "h", day: t.date, net: 0 };
        out.push(h);
      }
      if (counts(t)) h.net += t.amount_cents;
      out.push({ kind: "t", t });
    }
    return out;
  }, [rows, compact]);

  const { ref, el, margin } = useScrollParent(data.transactions.length > 0);
  const virt = useVirtualizer({
    count: flat.length,
    getScrollElement: () => el,
    estimateSize: (i) => (flat[i]?.kind === "h" ? 36 : compact ? 64 : 52),
    overscan: 12,
    scrollMargin: margin,
  });

  const sel = selected ? data.transactions.find((t) => t.id === selected) ?? null : null;
  const open = useCallback((t: Txn) => (aside ? setSelected(t.id) : setEditing(t)), [aside]);

  // Desktop keyboard: j/k move, c categorise, Enter edit.
  useEffect(() => {
    if (isPhone) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      if (document.querySelector("[role=dialog]")) return;
      const idx = rows.findIndex((t) => t.id === selected);
      if (e.key === "j" || e.key === "ArrowDown") {
        const n = rows[Math.min(rows.length - 1, idx + 1)];
        if (n) {
          setSelected(n.id);
          virt.scrollToIndex(Math.min(rows.length - 1, idx + 1));
          e.preventDefault();
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        const n = rows[Math.max(0, idx - 1)];
        if (n) {
          setSelected(n.id);
          virt.scrollToIndex(Math.max(0, idx - 1));
          e.preventDefault();
        }
      } else if (e.key === "c" && sel && item.canEdit) {
        setRecat([sel]);
        e.preventDefault();
      } else if (e.key === "Enter" && sel) {
        setEditing(sel);
        e.preventDefault();
      } else if (e.key === "/") {
        document.getElementById("budget-txn-search")?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, rows, selected, sel, item.canEdit, virt]);

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await upApi.sync(item.fileId);
      item.accept(r.data, r.revision);
      if (r.sync?.ok) toast.success(r.sync.added ? `${r.sync.added} new from Up` : "Up is up to date");
      else if (!r.sync?.full) toast.error(r.sync?.error || "Sync failed");
    } catch (e) {
      toast.error(errorText(e, "Couldn't sync with Up."));
    } finally {
      setSyncing(false);
    }
  };

  const toggleCheck = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const filters: { v: Filter; label: string }[] = [
    { v: "all", label: "All" },
    { v: "uncategorised", label: `Uncategorised${uncategorised ? ` · ${uncategorised}` : ""}` },
    { v: "pending", label: "Pending" },
    { v: "out", label: "Spending" },
    { v: "in", label: "Money in" },
    { v: "transfers", label: "Transfers" },
  ];

  if (!data.transactions.length) {
    return (
      <Page>
        <EmptyState
          icon={Receipt}
          title="No transactions yet"
          text="Connect Up Bank (Overview → Accounts & settings), import a CSV from any bank, or add one by hand."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton icon={<FileUp className="h-4 w-4" />} onClick={() => setImporting(true)}>
                  Import CSV
                </ItemButton>
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                  Add transaction
                </ItemButton>
              </div>
            )
          }
        />
        <TxnSheet item={item} txn={null} open={adding} onClose={() => setAdding(false)} />
        <CsvImportSheet item={item} open={importing} onClose={() => setImporting(false)} />
      </Page>
    );
  }

  const fcat = f.category ? cats.get(f.category) : null;
  const items = virt.getVirtualItems();

  const list = (
    <div ref={ref} className={cn(!compact && "overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]")}>
      {!compact && (
        <div className={cn("grid items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]", cols)}>
          <span>
            <span className="sr-only">Select</span>
          </span>
          <span>Date</span>
          <span>Payee</span>
          <span>Category</span>
          {showAccount && <span>Account</span>}
          <span className="text-right">Amount</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">Nothing matches those filters.</p>
      ) : (
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const r = flat[v.index];
            const style = { position: "absolute" as const, top: 0, left: 0, width: "100%", transform: `translateY(${v.start - virt.options.scrollMargin}px)` };
            if (r.kind === "h") {
              return (
                <div key={v.key} data-index={v.index} ref={virt.measureElement} style={style} className="flex items-end justify-between px-1 pb-1 pt-3">
                  <span className="text-xs font-semibold text-[var(--text-muted)]">{fmtDay(r.day)}</span>
                  <span className="text-xs tabular-nums text-[var(--text-muted)]">{fmt(r.net, { sign: true })}</span>
                </div>
              );
            }
            const t = r.t;
            const c = t.category_id ? cats.get(t.category_id) : null;
            const catLabel = t.transfer ? "Transfer" : t.splits.length ? `Split · ${t.splits.length}` : c?.name ?? "Uncategorised";
            if (compact) {
              return (
                <div key={v.key} data-index={v.index} ref={virt.measureElement} style={style}>
                  <button
                    type="button"
                    onClick={() => open(t)}
                    className="flex min-h-[60px] w-full items-center gap-3 rounded-xl px-1 py-2 text-left active:bg-[var(--hover)]"
                  >
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Categorise ${t.payee}`}
                      onClick={(e) => {
                        if (!item.canEdit || t.transfer) return;
                        e.stopPropagation();
                        setRecat([t]);
                      }}
                    >
                      <CatBadge cat={c} transfer={t.transfer} size={40} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-[var(--text)]">{t.payee || t.description}</span>
                        {t.pending && <Pill tone="warn">Pending</Pill>}
                        {t.review && <Pill tone="warn">Check</Pill>}
                      </span>
                      <span className={cn("block truncate text-xs", !c && !t.transfer && !t.splits.length ? "font-medium text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>
                        {catLabel}
                        {t.notes ? ` · ${t.notes}` : ""}
                      </span>
                    </span>
                    <Amount cents={t.amount_cents} fmt={fmt} muted={t.transfer} className="text-sm" />
                  </button>
                </div>
              );
            }
            const a = t.account_id ? accounts.get(t.account_id) : null;
            return (
              <div key={v.key} data-index={v.index} ref={virt.measureElement} style={style}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === t.id}
                  aria-label={`${t.payee}, ${fmt(t.amount_cents)}, ${fmtDay(t.date)}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.target === e.currentTarget) setEditing(t);
                    else if (e.key === " " && e.target === e.currentTarget) {
                      e.preventDefault();
                      setSelected(t.id);
                    }
                  }}
                  onFocus={() => setSelected(t.id)}
                  onClick={() => (aside ? setSelected(t.id) : setEditing(t))}
                  onDoubleClick={() => setEditing(t)}
                  className={cn(
                    "grid min-h-[52px] cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 text-sm",
                    cols,
                    selected === t.id ? "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "hover:bg-[var(--hover)]",
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.payee}`}
                    checked={checked.has(t.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleCheck(t.id)}
                    className="h-4 w-4 accent-[var(--item-accent)]"
                  />
                  <span className="tabular-nums text-[var(--text-muted)]">{fmtDay(t.date)}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-[var(--text)]">{t.payee || t.description}</span>
                    {t.pending && <Pill tone="warn">Pending</Pill>}
                    {t.review && <Pill tone="warn">Check</Pill>}
                    {t.notes && <span className="truncate text-xs text-[var(--text-muted)]">{t.notes}</span>}
                  </span>
                  <button
                    type="button"
                    disabled={!item.canEdit || t.transfer}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRecat([t]);
                    }}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-[var(--surface-2)] disabled:hover:bg-transparent",
                      !c && !t.transfer && !t.splits.length ? "font-medium text-[var(--item-accent)]" : "text-[var(--text)]",
                    )}
                  >
                    <span aria-hidden>{t.transfer ? "↔️" : c?.emoji || "❔"}</span>
                    <span className="truncate">{catLabel}</span>
                  </button>
                  {showAccount && <span className="truncate text-[var(--text-muted)]">{a?.name ?? "—"}</span>}
                  <span className="text-right">
                    <Amount cents={t.amount_cents} fmt={fmt} muted={t.transfer} />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <Page wide>
      <div ref={widthRef} aria-hidden className="-mb-5 h-0" />
      <div className="flex flex-col gap-3">
        {data.up.status === "full" && <FileFullNotice item={item} />}
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <TextInput
              id="budget-txn-search"
              value={f.q}
              onChange={(e) => setF({ ...f, q: e.target.value })}
              placeholder={isPhone ? "Search" : "Search payee, notes, tags or amount  ( / )"}
              className="pl-9"
              aria-label="Search transactions"
            />
          </div>
          {data.up.connected && <IconButton label={syncing ? "Syncing with Up…" : "Sync with Up now"} icon={RefreshCw} onClick={() => void sync()} disabled={syncing} className={syncing ? "animate-spin" : ""} />}
          {item.canEdit && <IconButton label="Import a bank CSV" icon={FileUp} onClick={() => setImporting(true)} />}
          {item.canEdit && !isPhone && (
            <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add
            </ItemButton>
          )}
        </div>
        {(() => {
          // On a phone the date/account pickers ride in the chip row (pill
          // selects) so the list starts a whole row higher.
          const pill = (on: boolean) =>
            cn(
              "h-8 shrink-0 appearance-none rounded-full border bg-no-repeat pl-3 pr-7 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              on ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
            );
          const caret = { backgroundImage: "linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)", backgroundPosition: "calc(100% - 14px) 52%, calc(100% - 10px) 52%", backgroundSize: "4px 4px, 4px 4px" };
          const monthOpts = (
            <>
              <option value="">All dates</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: compact ? "short" : "long", year: "numeric" })}
                </option>
              ))}
            </>
          );
          const acctOpts = (
            <>
              <option value="">All accounts</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </>
          );
          const summary = (
            <span className={cn("text-xs tabular-nums text-[var(--text-muted)]", compact ? "px-1" : "ml-auto")} aria-live="polite">
              {rows.length.toLocaleString()} transaction{rows.length === 1 ? "" : "s"} · {fmt(totals.inn, { whole: true })} in · {fmt(totals.out, { whole: true })} out
            </span>
          );
          return (
            <>
              <ScrollRow>
                {compact && (
                  <select value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} aria-label="Month" className={pill(!!f.month)} style={caret}>
                    {monthOpts}
                  </select>
                )}
                {compact && data.accounts.length > 1 && (
                  <select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} aria-label="Account" className={pill(!!f.account)} style={caret}>
                    {acctOpts}
                  </select>
                )}
                {filters.map((x) => (
                  <Chip key={x.v} active={f.filter === x.v} onClick={() => setF({ ...f, filter: x.v })}>
                    {x.label}
                  </Chip>
                ))}
                <Chip active={!!f.category} onClick={() => (f.category ? setF({ ...f, category: null }) : setCatFilter(true))} icon={f.category ? <X className="h-3 w-3" /> : <Tags className="h-3 w-3" />}>
                  {fcat ? fcat.name : "Category"}
                </Chip>
              </ScrollRow>
              {compact ? (
                summary
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} className="!w-auto min-w-[9rem]" aria-label="Month">
                    {monthOpts}
                  </Select>
                  {data.accounts.length > 1 && (
                    <Select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} className="!w-auto min-w-[9rem]" aria-label="Account">
                      {acctOpts}
                    </Select>
                  )}
                  {summary}
                </div>
              )}
            </>
          );
        })()}
        {f.filter === "uncategorised" && rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-dashed border-[var(--border)] p-3 text-sm">
            <span className="flex-1 text-[var(--text-muted)]">{rows.length} to sort. Tap a category icon, or let the assistant do a first pass.</span>
            <ItemButton size="sm" onClick={() => ask("Categorise my uncategorised transactions. Use rules for payees that repeat.")}>
              Ask AI to categorise
            </ItemButton>
          </div>
        )}
        {checked.size > 0 && !compact && (
          <div className="sticky top-0 z-10 flex items-center gap-2 rounded-2xl bg-[var(--surface-2)] p-2 text-sm shadow-[var(--shadow-sm)]">
            <span className="px-2 font-medium">{checked.size} selected</span>
            <ItemButton size="sm" variant="primary" onClick={() => setRecat(data.transactions.filter((t) => checked.has(t.id)))}>
              Categorise
            </ItemButton>
            <ItemButton
              size="sm"
              icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
              onClick={() => {
                const ids = new Set(checked);
                item.update((d) => {
                  for (const t of d.transactions) if (ids.has(t.id)) {
                    t.transfer = true;
                    t.transfer_by = "user"; // a sync never flips the person's choice back
                    t.category_id = null;
                  }
                });
                setChecked(new Set());
              }}
            >
              Mark transfer
            </ItemButton>
            <ItemButton size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
              Clear
            </ItemButton>
          </div>
        )}
      </div>

      {!aside ? (
        list
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4">
          {list}
          <aside className="sticky top-4">
            {sel ? (
              <TxnDetail item={item} t={sel} onEdit={() => setEditing(sel)} onCategorise={() => setRecat([sel])} />
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">
                Select a transaction to see its details.
                <p className="mt-2 text-xs">j / k to move · c to categorise · Enter to edit · / to search</p>
              </div>
            )}
          </aside>
        </div>
      )}

      {compact && <div aria-hidden className="h-14" />}
      {compact && item.canEdit && <Fab label="Add" icon={Plus} onClick={() => setAdding(true)} />}
      <TxnSheet item={item} txn={editing} open={!!editing} onClose={() => setEditing(null)} />
      <TxnSheet item={item} txn={null} open={adding} onClose={() => setAdding(false)} />
      {recat && (
        <RecategoriseSheet
          item={item}
          txns={recat}
          open={!!recat}
          onClose={() => {
            setRecat(null);
            setChecked(new Set());
          }}
        />
      )}
      <CategoryPicker
        data={data}
        open={catFilter}
        onClose={() => setCatFilter(false)}
        title="Show category"
        onPick={(c) => {
          setF({ ...f, category: c });
          setCatFilter(false);
        }}
      />
      <CsvImportSheet item={item} open={importing} onClose={() => setImporting(false)} />
    </Page>
  );
}

function TxnDetail({ item, t, onEdit, onCategorise }: { item: H; t: Txn; onEdit: () => void; onCategorise: () => void }) {
  const fmt = useMoney(item);
  const data = item.data;
  const cats = catIndex(data);
  const c = t.category_id ? cats.get(t.category_id) : null;
  const a = data.accounts.find((x) => x.id === t.account_id);
  const ta = data.accounts.find((x) => x.id === t.transfer_account_id);
  const same = useMemo(() => {
    const key = t.payee.toLowerCase();
    const list = data.transactions.filter((x) => x.payee.toLowerCase() === key && counts(x));
    return { n: list.length, total: list.reduce((s, x) => s + x.amount_cents, 0), last: list.slice(0, 5) };
  }, [data.transactions, t.payee]);
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start gap-3">
        <CatBadge cat={c} transfer={t.transfer} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-[var(--text)]">{t.payee || "—"}</p>
          <p className="text-xs text-[var(--text-muted)]">{fmtDay(t.date, { long: true })}</p>
        </div>
        <Amount cents={t.amount_cents} fmt={fmt} className="text-lg" muted={t.transfer} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {t.pending && <Pill tone="warn">Pending</Pill>}
        {t.review && <Pill tone="warn">Needs a look</Pill>}
        {t.transfer && <Pill>Transfer{ta ? ` · ${ta.name}` : ""}</Pill>}
        <Pill tone={t.source === "up" ? "accent" : "neutral"}>{t.source === "up" ? "Up" : t.source === "csv" ? "CSV" : "Manual"}</Pill>
        {t.category_by === "rule" && <Pill>Rule</Pill>}
        {t.tags.map((x) => (
          <Pill key={x}>#{x}</Pill>
        ))}
      </div>
      {t.review && <p className="rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-2.5 text-xs">{t.review}</p>}
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-[var(--text-muted)]">Category</dt>
        <dd className="truncate">{t.transfer ? "—" : t.splits.length ? t.splits.map((s) => `${cats.get(s.category_id ?? "")?.name ?? "?"} ${fmt(Math.abs(s.amount_cents))}`).join(", ") : c?.name ?? "Uncategorised"}</dd>
        <dt className="text-[var(--text-muted)]">Account</dt>
        <dd className="truncate">{a?.name ?? "—"}</dd>
        {t.description && t.description !== t.payee && (
          <>
            <dt className="text-[var(--text-muted)]">Bank text</dt>
            <dd className="break-words text-xs">{t.description}</dd>
          </>
        )}
        {t.foreign && (
          <>
            <dt className="text-[var(--text-muted)]">Foreign</dt>
            <dd>
              {(Math.abs(t.foreign.amount_cents) / 100).toLocaleString()} {t.foreign.currency}
            </dd>
          </>
        )}
        {t.round_up_cents !== 0 && (
          <>
            <dt className="text-[var(--text-muted)]">Round-up</dt>
            <dd>{fmt(Math.abs(t.round_up_cents))}</dd>
          </>
        )}
        {t.notes && (
          <>
            <dt className="text-[var(--text-muted)]">Notes</dt>
            <dd className="break-words">{t.notes}</dd>
          </>
        )}
      </dl>
      {same.n > 1 && (
        <div className="rounded-xl bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
          {same.n} transactions with {t.payee}, {fmt(Math.abs(same.total))} in total.
        </div>
      )}
      {item.canEdit && (
        <div className="flex gap-2">
          {!t.transfer && (
            <ItemButton size="sm" variant="primary" onClick={onCategorise} className="flex-1">
              Categorise
            </ItemButton>
          )}
          <ItemButton size="sm" onClick={onEdit} className="flex-1">
            Edit
          </ItemButton>
        </div>
      )}
    </div>
  );
}
