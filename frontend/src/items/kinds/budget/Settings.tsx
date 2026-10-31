import { Archive, ExternalLink, Landmark, Link2, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { toast } from "@/store/toastStore";
import { itemsApi } from "@/items/api";
import { Field, ItemButton, List, ListRow, Section, Segmented, Select, Sheet, TextInput, Toggle, fmtAgo } from "@/items/ui";
import { cn } from "@/utils/cn";

import { errorText, upApi, type UpStatus } from "./api";
import { CatBadge, CategoryPicker, Pill, useMoney, type H } from "./common";
import { ACCOUNT_LABEL, addMonths, catIndex, currentMonth, monthRange, parseMoney } from "./logic";
import type { Account, AccountType, Category, Rule } from "./types";

type Tab = "accounts" | "budget" | "categories" | "rules";

export function SettingsSheet({ item, open, onClose, start = "accounts" }: { item: H; open: boolean; onClose: () => void; start?: Tab }) {
  const [tab, setTab] = useState<Tab>(start);
  useEffect(() => {
    if (open) setTab(start);
  }, [open, start]);
  return (
    <Sheet open={open} onClose={onClose} title="Accounts & settings" size="full">
      <div className="sticky top-0 z-10 -mx-5 mb-3 bg-[var(--bg)] px-5 pb-2">
        <Segmented
          className="w-full"
          value={tab}
          onChange={setTab}
          options={[
            { value: "accounts", label: "Accounts" },
            { value: "budget", label: "Budget" },
            { value: "categories", label: "Categories" },
            { value: "rules", label: "Rules" },
          ]}
        />
      </div>
      {tab === "accounts" && <AccountsPanel item={item} />}
      {tab === "budget" && <PrefsPanel item={item} />}
      {tab === "categories" && <CategoriesPanel item={item} />}
      {tab === "rules" && <RulesPanel item={item} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ Up

export function UpConnect({ item, compact }: { item: H; compact?: boolean }) {
  const [status, setStatus] = useState<UpStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "connect" | "sync" | "off">(null);
  const up = item.data.up;
  useEffect(() => {
    let alive = true;
    upApi
      .status(item.fileId)
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item.fileId, up.status, up.connected]);
  const connected = status?.connected ?? up.connected;
  // Connecting, syncing and disconnecting are the owner's (the token is theirs).
  const owner = status?.is_owner ?? true;
  const lastSync = status?.last_sync_at ?? up.last_sync_at;

  const connect = async () => {
    setBusy("connect");
    try {
      const r = await upApi.connect(item.fileId, token.trim());
      setToken("");
      setStatus(r);
      item.accept(r.data, r.revision);
      const n = r.sync?.added ?? 0;
      toast.success(r.sync?.ok ? `Connected to Up — ${n.toLocaleString()} transaction${n === 1 ? "" : "s"} synced` : `Connected. ${r.sync?.error ?? ""}`);
    } catch (e) {
      toast.error(errorText(e, "Couldn't connect to Up."));
    } finally {
      setBusy(null);
    }
  };
  const sync = async () => {
    setBusy("sync");
    try {
      const r = await upApi.sync(item.fileId);
      setStatus(r);
      item.accept(r.data, r.revision);
      if (r.sync?.ok) toast.success(r.sync.added ? `${r.sync.added} new transaction${r.sync.added === 1 ? "" : "s"}` : "Up to date");
      else if (!r.sync?.full) toast.error(r.sync?.error ?? "Sync failed");
    } catch (e) {
      toast.error(errorText(e, "Couldn't sync."));
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async () => {
    if (!window.confirm("Disconnect Up? The token is deleted from Promptly. Your transactions stay in this budget.")) return;
    setBusy("off");
    try {
      const r = await upApi.disconnect(item.fileId);
      setStatus(r);
      item.accept(r.data, r.revision);
      toast.success("Up disconnected. You can also revoke the token at api.up.com.au.");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#ff7a64] text-lg font-black text-[#1d1d40]" aria-hidden>
          ⚡
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text)]">Up Bank</p>
          <p className="text-xs text-[var(--text-muted)]">
            {connected
              ? up.status === "full"
                ? "Paused — this budget file is full"
                : `Connected · synced ${lastSync ? fmtAgo(lastSync) : "—"}${status?.webhook || up.webhook ? " · live updates on" : " · every 30 min"}`
              : up.status === "disconnected"
                ? "Disconnected — Up stopped accepting the token"
                : "Read-only sync of your accounts and transactions"}
          </p>
        </div>
        {connected && (
          <Pill tone={up.status === "error" || up.status === "full" ? "bad" : "good"}>{up.status === "error" ? "Error" : up.status === "full" ? "Full" : "On"}</Pill>
        )}
      </div>
      {up.status === "full" && <FileFullNotice item={item} onDone={owner && connected ? () => void sync() : undefined} />}
      {up.last_error && (up.status === "error" || up.status === "disconnected") && (
        <p className="rounded-xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-2.5 text-xs text-[var(--danger)]" role="alert">
          {up.last_error}
        </p>
      )}
      {connected ? (
        item.canEdit &&
        (owner ? (
          <div className="flex gap-2">
            <ItemButton className="flex-1" icon={<RefreshCw className={cn("h-4 w-4", busy === "sync" && "animate-spin")} />} disabled={!!busy} onClick={() => void sync()}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </ItemButton>
            <ItemButton variant="ghost" icon={<Unplug className="h-4 w-4" />} disabled={!!busy} onClick={() => void disconnect()}>
              Disconnect
            </ItemButton>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">The budget's owner manages the Up connection.</p>
        ))
      ) : item.canEdit && owner ? (
        <>
          {!compact && (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-[var(--text-muted)]">
              <li>
                On your phone, open{" "}
                <a href="https://api.up.com.au/getting_started" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-[var(--item-accent)] underline">
                  api.up.com.au/getting_started <ExternalLink className="h-3 w-3" />
                </a>{" "}
                and follow the link from the Up app to make a <b>Personal Access Token</b>.
              </li>
              <li>Copy the whole token (it starts with “up:yeah:”) and paste it here.</li>
            </ol>
          )}
          <Field label="Personal Access Token">
            <TextInput
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="up:yeah:…"
              aria-describedby="up-token-help"
            />
          </Field>
          <p id="up-token-help" className="flex items-start gap-1.5 text-[11px] text-[var(--text-muted)]">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Up's API is read-only — nothing here can move money. The token is stored encrypted on your server, never in this file, and you can revoke it in the Up app at any time.
          </p>
          <ItemButton variant="primary" disabled={!token.trim().startsWith("up:yeah:") || !!busy} onClick={() => void connect()} icon={<Link2 className="h-4 w-4" />}>
            {busy === "connect" ? "Connecting & syncing…" : "Connect Up"}
          </ItemButton>
        </>
      ) : null}
    </div>
  );
}

/** The file can't take more synced transactions: archive older ones (the
 *  framework's archive — budgets carry over), then sync again. */
export function FileFullNotice({ item, onDone }: { item: H; onDone?: () => void }) {
  const sd = item.data.settings.month_start_day || 1;
  // Default: keep the last 12 budget months.
  const [before, setBefore] = useState(() => monthRange(addMonths(currentMonth(item.data), -11), sd)[0]);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const res = await itemsApi.archive<typeof item.data>(item.fileId, before);
      item.accept(res.data, res.revision);
      toast.success("Older transactions moved to an archive file next to this one.");
      onDone?.();
    } catch (e) {
      toast.error(errorText(e, "Couldn't archive."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-3 text-xs text-[var(--text)]" role="alert">
      <p className="flex items-start gap-1.5">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warning)]" />
        This budget file is full, so new Up transactions can't be added. Archive older transactions into their own file — your budgets, rules and goals stay here and carry on.
      </p>
      {item.canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Archive transactions before" className="min-w-[10rem] flex-1">
            <TextInput type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
          </Field>
          <ItemButton icon={<Archive className="h-4 w-4" />} disabled={busy || !before} onClick={() => void run()}>
            {busy ? "Archiving…" : "Archive older transactions"}
          </ItemButton>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- accounts

function AccountsPanel({ item }: { item: H }) {
  const fmt = useMoney(item);
  const [edit, setEdit] = useState<Account | "new" | null>(null);
  const accts = item.data.accounts;
  const net = accts.filter((a) => !a.archived).reduce((n, a) => n + a.balance_cents, 0);
  return (
    <div className="flex flex-col gap-5">
      <UpConnect item={item} />
      <Section
        title="Accounts"
        hint={`Net worth ${fmt(net)}`}
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEdit("new")}>
              Manual account
            </ItemButton>
          )
        }
      >
        {accts.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">
            Connect Up above, or add a manual account for cash, another bank, a credit card or a loan.
          </p>
        ) : (
          <List>
            {accts.map((a) => (
              <ListRow
                key={a.id}
                onClick={item.canEdit ? () => setEdit(a) : undefined}
                leading={<Landmark className="h-5 w-5 text-[var(--text-muted)]" />}
                title={
                  <span className={cn("flex items-center gap-1.5", a.archived && "opacity-60")}>
                    {a.name}
                    {a.source === "up" && <Pill tone="accent">Up</Pill>}
                    {a.archived && <Pill>Archived</Pill>}
                  </span>
                }
                subtitle={`${ACCOUNT_LABEL[a.type] ?? a.type}${a.balance_at ? ` · ${fmtAgo(a.balance_at)}` : ""}${a.on_budget ? "" : " · off budget"}`}
                trailing={<span className={cn("font-semibold tabular-nums", a.balance_cents < 0 ? "text-[var(--danger)]" : "text-[var(--text)]")}>{fmt(a.balance_cents)}</span>}
              />
            ))}
          </List>
        )}
      </Section>
      {edit && <AccountSheet item={item} account={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function AccountSheet({ item, account, onClose }: { item: H; account: Account | null; onClose: () => void }) {
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<AccountType>(account?.type ?? "transactional");
  const [balance, setBalance] = useState(account ? (account.balance_cents / 100).toFixed(2) : "0");
  const [onBudget, setOnBudget] = useState(account?.on_budget ?? true);
  const bank = account?.source === "up";
  const save = async () => {
    const cents = parseMoney(balance);
    if (!name.trim() || (!bank && !Number.isFinite(cents))) return;
    if (!account) {
      try {
        await item.runAction("add_account", { name: name.trim(), type, balance: cents / 100, on_budget: onBudget });
      } catch (e) {
        toast.error(errorText(e));
        return;
      }
    } else {
      // Only what the person changed in the sheet (someone may have edited meanwhile).
      const nm = name.trim() !== account.name ? name.trim() : null;
      const ob = onBudget !== account.on_budget ? onBudget : null;
      const ty = !bank && type !== account.type ? type : null;
      const bal = !bank && cents !== account.balance_cents ? cents : null;
      const at = new Date().toISOString();
      item.update((d) => {
        const a = d.accounts.find((x) => x.id === account.id);
        if (!a) return;
        if (nm !== null) {
          a.name = nm;
          a.renamed = true;
        }
        if (ob !== null) a.on_budget = ob;
        if (ty !== null) a.type = ty;
        if (bal !== null) {
          a.balance_cents = bal;
          a.balance_at = at;
        }
      });
    }
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={account ? account.name : "New account"}
      footer={
        <>
          {account && (
            <ItemButton
              variant="ghost"
              onClick={() => {
                const target = !account.archived; // decided from what the person saw
                item.update((d) => {
                  const a = d.accounts.find((x) => x.id === account.id);
                  if (a) a.archived = target;
                });
                onClose();
              }}
            >
              {account.archived ? "Unarchive" : "Archive"}
            </ItemButton>
          )}
          <ItemButton variant="primary" className="flex-1" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={type} disabled={bank} onChange={(e) => setType(e.target.value as AccountType)}>
              {Object.entries(ACCOUNT_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Balance" hint={bank ? "Kept up to date by Up" : "Negative for what you owe"}>
            <TextInput inputMode="decimal" value={balance} disabled={bank} onChange={(e) => setBalance(e.target.value)} className="tabular-nums" />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="block">On budget</span>
            <span className="block text-xs text-[var(--text-muted)]">Its spending and income count in the budget. Off for loans and investments (their interest too)</span>
          </span>
          <Toggle checked={onBudget} onChange={setOnBudget} label="On budget" />
        </div>
      </div>
    </Sheet>
  );
}

// ----------------------------------------------------------------- prefs

function PrefsPanel({ item }: { item: H }) {
  const s = item.data.settings;
  const set = (patch: Partial<typeof s>) =>
    item.update((d) => {
      Object.assign(d.settings, patch, { onboarded: true });
    });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Budgeting style" hint="Envelope: leftover rolls forward and every dollar gets a job (YNAB-style)">
          <Segmented
            value={s.style}
            onChange={(v) => set({ style: v })}
            options={[
              { value: "simple", label: "Simple" },
              { value: "envelope", label: "Envelope" },
            ]}
          />
        </Field>
        <Field label="Months start on" hint="Payday budgeting — e.g. 15 runs 15th to 14th">
          <Select value={s.month_start_day} onChange={(e) => set({ month_start_day: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "The 1st (calendar months)" : `Day ${d}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="I'm paid">
          <Select value={s.pay_frequency} onChange={(e) => set({ pay_frequency: e.target.value as typeof s.pay_frequency })}>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option>
            <option value="irregular">Irregularly</option>
          </Select>
        </Field>
        <Field label="Next payday" hint="For “safe to spend until payday”">
          <TextInput type="date" value={s.next_payday ?? ""} onChange={(e) => set({ next_payday: e.target.value || null })} />
        </Field>
        <Field label="Currency">
          <Select value={s.currency} onChange={(e) => set({ currency: e.target.value })}>
            {["AUD", "NZD", "USD", "GBP", "EUR", "CAD", "SGD", "JPY"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Budget starts" hint="Rollover and “to be budgeted” count from this month; earlier months show spending only">
          <TextInput
            type="month"
            value={s.budget_start ?? ""}
            onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && set({ budget_start: e.target.value })}
          />
        </Field>
        <Field label="Up history on first sync">
          <Select value={s.up_history_days} onChange={(e) => set({ up_history_days: Number(e.target.value) })}>
            {[90, 180, 365, 730, 1095, 1825].map((d) => (
              <option key={d} value={d}>
                {d < 365 ? `${d / 30} months` : `${d / 365} year${d === 365 ? "" : "s"}`}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {[
        ["zero_based", "Zero-based: show “to be budgeted”", "Income minus everything you've assigned — aim for $0"],
        ["bill_reminders", "Remind me before bills & subscriptions", "A notification the day before each charge"],
        ["overspend_alerts", "Alert me when a category goes over", "Once per category per month"],
      ].map(([k, l, h]) => (
        <div key={k} className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="block font-medium">{l}</span>
            <span className="block text-xs text-[var(--text-muted)]">{h}</span>
          </span>
          <Toggle checked={!!s[k as keyof typeof s]} onChange={(v) => set({ [k]: v } as Partial<typeof s>)} label={l} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ categories

function CategoriesPanel({ item }: { item: H }) {
  const data = item.data;
  const [edit, setEdit] = useState<Category | "new" | null>(null);
  const [upCats, setUpCats] = useState<UpStatus["up_categories"]>([]);
  const [mapFor, setMapFor] = useState<string | null>(null);
  useEffect(() => {
    if (data.up.connected) upApi.status(item.fileId).then((s) => setUpCats(s.up_categories)).catch(() => undefined);
  }, [data.up.connected, item.fileId]);
  const cats = catIndex(data);
  const children = upCats.filter((c) => c.parent);
  return (
    <div className="flex flex-col gap-5">
      {data.groups.map((g) => {
        const list = data.categories.filter((c) => c.group_id === g.id);
        if (!list.length) return null;
        return (
          <Section key={g.id} title={g.name}>
            <List>
              {list.map((c) => (
                <ListRow
                  key={c.id}
                  onClick={item.canEdit ? () => setEdit(c) : undefined}
                  leading={<CatBadge cat={c} size={32} />}
                  title={<span className={c.hidden ? "opacity-50" : ""}>{c.name}</span>}
                  subtitle={[c.kind === "income" ? "Income" : c.bucket !== "none" ? c.bucket[0].toUpperCase() + c.bucket.slice(1) : "", c.rollover ? "Rolls over" : "", c.hidden ? "Hidden" : ""].filter(Boolean).join(" · ")}
                />
              ))}
            </List>
          </Section>
        );
      })}
      {item.canEdit && (
        <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => setEdit("new")}>
          New category
        </ItemButton>
      )}
      {children.length > 0 && (
        <Section title="Up categories" hint="Where Up's categories land in your budget (your own choices and rules always win)">
          <List>
            {children.map((u) => {
              const mine = data.settings.up_category_map[u.id];
              const c = mine ? cats.get(mine) : null;
              return <ListRow key={u.id} title={u.name} subtitle={u.parent ?? ""} onClick={item.canEdit ? () => setMapFor(u.id) : undefined} trailing={c ? `${c.emoji} ${c.name}` : "Default"} />;
            })}
          </List>
        </Section>
      )}
      {edit && <CategoryEditSheet item={item} cat={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      <CategoryPicker
        data={data}
        open={!!mapFor}
        onClose={() => setMapFor(null)}
        value={mapFor ? data.settings.up_category_map[mapFor] : null}
        title="Map to"
        onPick={(cid) => {
          const key = mapFor;
          setMapFor(null);
          if (!key || !cid) return;
          item.update((d) => {
            d.settings.up_category_map ??= {};
            d.settings.up_category_map[key] = cid;
          });
        }}
      />
    </div>
  );
}

function CategoryEditSheet({ item, cat, onClose }: { item: H; cat: Category | null; onClose: () => void }) {
  const data = item.data;
  const [name, setName] = useState(cat?.name ?? "");
  const [emoji, setEmoji] = useState(cat?.emoji ?? "");
  const [group, setGroup] = useState(cat?.group_id ?? data.groups[0]?.id ?? "");
  const [kind, setKind] = useState<Category["kind"]>(cat?.kind ?? "expense");
  const [bucket, setBucket] = useState<Category["bucket"]>(cat?.bucket ?? "wants");
  const [hidden, setHidden] = useState(cat?.hidden ?? false);
  const used = useMemo(() => !!cat && data.transactions.some((t) => t.category_id === cat.id), [cat, data.transactions]);
  const save = async () => {
    if (!name.trim()) return;
    if (!cat) {
      try {
        await item.runAction("add_category", { name: name.trim(), group_id: group, kind, emoji, bucket });
      } catch (e) {
        toast.error(errorText(e));
        return;
      }
    } else {
      const next: Partial<Category> = { name: name.trim(), emoji, group_id: group, kind, bucket, hidden };
      const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => cat[k as keyof Category] !== v)) as Partial<Category>;
      item.update((d) => {
        const c = d.categories.find((x) => x.id === cat.id);
        if (c) Object.assign(c, changed);
      });
    }
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={cat ? "Edit category" : "New category"}
      footer={
        <>
          {cat && !used && (
            <ItemButton
              variant="ghost"
              aria-label="Delete category"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                item.update((d) => {
                  d.categories = d.categories.filter((x) => x.id !== cat.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" className="flex-1" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[72px_1fr] gap-3">
          <Field label="Emoji">
            <TextInput value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 4))} className="text-center" />
          </Field>
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
        </div>
        <Field label="Group">
          <Select value={group} onChange={(e) => setGroup(e.target.value)}>
            {data.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "expense", label: "Spending" },
            { value: "income", label: "Income" },
          ]}
        />
        {kind === "expense" && (
          <Field label="50/30/20 bucket">
            <Segmented
              value={bucket}
              onChange={setBucket}
              options={[
                { value: "needs", label: "Needs" },
                { value: "wants", label: "Wants" },
                { value: "savings", label: "Savings" },
              ]}
            />
          </Field>
        )}
        {cat && (
          <div className="flex items-center justify-between text-sm">
            <span>Hide from the budget</span>
            <Toggle checked={hidden} onChange={setHidden} label="Hide category" />
          </div>
        )}
        {cat && used && <p className="text-xs text-[var(--text-muted)]">Transactions use this category, so it can be hidden but not deleted.</p>}
      </div>
    </Sheet>
  );
}

// ----------------------------------------------------------------- rules

function RulesPanel({ item }: { item: H }) {
  const data = item.data;
  const cats = catIndex(data);
  const [pattern, setPattern] = useState("");
  const [match, setMatch] = useState<Rule["match"]>("contains");
  const [cid, setCid] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [transfer, setTransfer] = useState(false);
  const [picker, setPicker] = useState(false);
  const add = async () => {
    try {
      const r = await item.runAction("add_rule", { pattern: pattern.trim(), match, field: "any", category_id: cid, rename_to: rename.trim() || null, mark_transfer: transfer });
      toast.success(r.summary);
      setPattern("");
      setRename("");
      setCid(null);
      setTransfer(false);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-5">
      {item.canEdit && (
        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] p-4">
          <p className="text-sm font-semibold">New rule</p>
          <div className="grid grid-cols-[minmax(0,140px)_1fr] gap-2">
            <Select value={match} onChange={(e) => setMatch(e.target.value as Rule["match"])} aria-label="Match type">
              <option value="contains">Contains</option>
              <option value="starts">Starts with</option>
              <option value="equals">Is exactly</option>
              <option value="regex">Pattern (regex)</option>
            </Select>
            <TextInput value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. uber eats" aria-label="Text to match" />
          </div>
          <button type="button" onClick={() => setPicker(true)} className="flex h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-2 text-left text-sm md:h-10">
            <CatBadge cat={cid ? cats.get(cid) : null} size={26} />
            {cid ? `Set category: ${cats.get(cid)?.name}` : "Set a category (optional)"}
          </button>
          <TextInput value={rename} onChange={(e) => setRename(e.target.value)} placeholder="Rename payee to… (optional)" aria-label="Rename payee to" />
          <div className="flex items-center justify-between text-sm">
            <span>Mark as a transfer</span>
            <Toggle checked={transfer} onChange={setTransfer} label="Mark as a transfer" />
          </div>
          <ItemButton variant="primary" disabled={!pattern.trim() || (!cid && !rename.trim() && !transfer)} onClick={() => void add()}>
            Save & apply
          </ItemButton>
        </div>
      )}
      {data.rules.length === 0 ? (
        <p className="text-center text-sm text-[var(--text-muted)]">No rules yet. Tip: when you categorise a transaction, switch on “Always for this payee”.</p>
      ) : (
        <List>
          {data.rules.map((r) => {
            const c = r.category_id ? cats.get(r.category_id) : null;
            return (
              <ListRow
                key={r.id}
                title={
                  <span className={r.enabled ? "" : "opacity-50"}>
                    {r.match === "regex" ? "Matches" : r.match === "equals" ? "Is" : r.match === "starts" ? "Starts with" : "Contains"} “{r.pattern}”
                  </span>
                }
                subtitle={[c ? `→ ${c.name}` : "", r.rename_to ? `rename to ${r.rename_to}` : "", r.mark_transfer ? "transfer" : ""].filter(Boolean).join(" · ")}
                action={
                  item.canEdit && (
                    <span className="flex items-center gap-1">
                      <Toggle
                        checked={r.enabled}
                        onChange={(v) =>
                          item.update((d) => {
                            const x = d.rules.find((y) => y.id === r.id);
                            if (x) x.enabled = v;
                          })
                        }
                        label={`Rule ${r.pattern} on`}
                      />
                      <button
                        type="button"
                        aria-label={`Delete rule ${r.pattern}`}
                        onClick={() =>
                          item.update((d) => {
                            d.rules = d.rules.filter((y) => y.id !== r.id);
                          })
                        }
                        className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  )
                }
              />
            );
          })}
        </List>
      )}
      <CategoryPicker
        data={data}
        open={picker}
        onClose={() => setPicker(false)}
        value={cid}
        onPick={(c) => {
          setCid(c);
          setPicker(false);
        }}
      />
    </div>
  );
}
