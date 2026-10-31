import { FileUp, LayoutDashboard, PencilLine, PiggyBank, Plus, Radar, Receipt } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";
import { Card, Fab, Field, ItemButton, Page, Select, TextInput, todayISO } from "@/items/ui";

import { BudgetView } from "./Budget";
import type { H } from "./common";
import { CsvImportSheet } from "./CsvImport";
import { OverviewView } from "./Overview";
import { UpConnect } from "./Settings";
import { SubscriptionsView } from "./Subscriptions";
import { TransactionsView } from "./Transactions";
import { defaultBudgetStart } from "./logic";
import { normalizeData } from "./normalize";
import { TxnSheet } from "./TxnSheet";
import type { BudgetData } from "./types";

/*
 * Budget — YNAB / Monarch / PocketSmith / Frollo in one file, Australian-first.
 * Tabs: Overview (this month, cash flow, coming up, insights), Transactions
 * (search, filters, quick re-categorise, splits, CSV import), Budget
 * (categories with progress, rollover, move money, goals) and Subscriptions
 * (the automatic recurring-charge radar). Accounts & settings — Up Bank,
 * manual accounts, categories, rules, preferences — is a sheet from Overview.
 */

/* The header's "Add transaction" → the sheet of whichever tab is showing
 * (every tab mounts a QuickAddHost). A tiny in-module channel, keyed by file. */
const quickAdd = new Map<string, Set<() => void>>();
function requestQuickAdd(fileId: string): boolean {
  const subs = quickAdd.get(fileId);
  subs?.forEach((fn) => fn());
  return !!subs?.size;
}

/** The views read transactions with every field filled in (they're stored slim). */
function useBudgetHandle(item: H): H {
  const data = useMemo(() => normalizeData(item.data), [item.data]);
  return useMemo(() => (data === item.data ? item : { ...item, data }), [item, data]);
}

/** Opens the add-transaction sheet when the header's quick action fires. */
function QuickAddHost({ item, fab }: { item: H; fab?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    let subs = quickAdd.get(item.fileId);
    if (!subs) quickAdd.set(item.fileId, (subs = new Set()));
    subs.add(on);
    return () => {
      subs?.delete(on);
    };
  }, [item.fileId]);
  return (
    <>
      {fab && item.canEdit && <Fab label="Add" icon={Plus} onClick={() => setOpen(true)} />}
      <TxnSheet item={item} txn={null} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function withQuickAdd(View: (p: ItemViewProps<BudgetData>) => ReactElement, fab = false) {
  return function Wrapped(p: ItemViewProps<BudgetData>) {
    const item = useBudgetHandle(p.item);
    return (
      <>
        <View {...p} item={item} />
        <QuickAddHost item={item} fab={fab && p.isPhone} />
      </>
    );
  };
}

function Onboarding(p: ItemViewProps<BudgetData>) {
  const item = useBudgetHandle(p.item);
  const s = item.data.settings;
  const [csv, setCsv] = useState(false);
  const [freq, setFreq] = useState(s.pay_frequency);
  const [payday, setPayday] = useState(s.next_payday ?? "");
  const [start, setStart] = useState(s.month_start_day);
  const finish = () => {
    const restart = start !== s.month_start_day ? defaultBudgetStart(todayISO(), start) : null;
    item.update((d) => {
      d.settings.pay_frequency = freq;
      d.settings.next_payday = payday || null;
      d.settings.month_start_day = start;
      if (restart) d.settings.budget_start = restart;
      d.settings.onboarded = true;
    });
  };
  return (
    <Page>
      <div className="flex flex-col gap-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">Let's set up your budget</h1>
        <p className="text-sm text-[var(--text-muted)]">Bring in your transactions, tell us when you're paid, and you're done. You can change all of it later.</p>
      </div>
      <UpConnect item={item} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card onClick={() => setCsv(true)} className="flex items-center gap-3">
          <FileUp className="h-6 w-6 shrink-0 text-[var(--item-accent)]" />
          <div>
            <p className="text-sm font-semibold">Import a CSV</p>
            <p className="text-xs text-[var(--text-muted)]">From CommBank, NAB, ANZ, Westpac, ING…</p>
          </div>
        </Card>
        <Card onClick={finish} className="flex items-center gap-3">
          <PencilLine className="h-6 w-6 shrink-0 text-[var(--item-accent)]" />
          <div>
            <p className="text-sm font-semibold">Start by hand</p>
            <p className="text-xs text-[var(--text-muted)]">Add accounts and spending yourself</p>
          </div>
        </Card>
      </div>
      <Card className="flex flex-col gap-3">
        <p className="text-sm font-semibold">Your pay</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="I'm paid">
            <Select value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}>
              <option value="weekly">Weekly</option>
              <option value="fortnightly">Fortnightly</option>
              <option value="monthly">Monthly</option>
              <option value="irregular">Irregularly</option>
            </Select>
          </Field>
          <Field label="Next payday">
            <TextInput type="date" value={payday} onChange={(e) => setPayday(e.target.value)} />
          </Field>
          <Field label="Budget months start" hint="Set it to your payday if you're paid monthly">
            <Select value={start} onChange={(e) => setStart(Number(e.target.value))}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "On the 1st" : `On day ${d}`}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ItemButton variant="primary" onClick={finish}>
          Continue
        </ItemButton>
      </Card>
      <CsvImportSheet
        item={item}
        open={csv}
        onClose={() => {
          setCsv(false);
        }}
      />
    </Page>
  );
}

const budgetModule: ItemModule<BudgetData> = {
  kind: "budget",
  tabs: [
    { id: "overview", label: "Overview", icon: LayoutDashboard, View: withQuickAdd(OverviewView, true) },
    { id: "transactions", label: "Transactions", icon: Receipt, View: withQuickAdd(TransactionsView) },
    { id: "budget", label: "Budget", icon: PiggyBank, View: withQuickAdd(BudgetView) },
    { id: "subscriptions", label: "Bills", icon: Radar, View: withQuickAdd(SubscriptionsView) },
  ],
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "Add transaction",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            // Every tab hosts the sheet; if none is mounted yet, open Transactions first.
            if (!requestQuickAdd(h.fileId)) {
              goTo("transactions");
              setTimeout(() => requestQuickAdd(h.fileId), 0);
            }
          },
        }
      : null,
  needsOnboarding: (d) => !d.settings?.onboarded && !(d.transactions?.length ?? 0) && !(d.accounts?.length ?? 0),
  Onboarding,
};

export default budgetModule;
