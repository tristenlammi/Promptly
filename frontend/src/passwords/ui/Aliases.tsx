// Aliases on your own domain: set up the domain, then every login can have its own
// address. The vault decides the word and judges leaks; the server only routes mail.
import { AtSign, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "../core/api";
import { type Alias, type AliasDomain, aliasApi, aliasWarnings, aliasWord, type MailFolderRow, type WordStyle } from "../core/aliases";
import type { LoginUrl } from "../core/model";
import { Button, Callout, CopyButton, errorText, inputClass, Label, useVault } from "./kit";

const WORD_STYLES: { value: WordStyle; label: string }[] = [
  { value: "word", label: "A random word (shop.k7m2)" },
  { value: "site", label: "The site's name (the server sees it)" },
  { value: "custom", label: "A word I type each time" },
  { value: "none", label: "No word, all random" },
];

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "never";
}

const STATUS: Record<AliasDomain["status"], string> = { new: "Not checked yet", checking: "Checking…", ok: "Working", failed: "Not working" };
const SEND_AS: Record<AliasDomain["send_as"], string> = {
  unknown: "Not checked",
  ok: "Replies can come from an alias",
  rewritten: "Your provider changes the sender",
  refused: "Your provider won't send as this domain",
};

export function AliasesScreen() {
  const { vault } = useVault();
  const api = useMemo(() => aliasApi(vault.api), [vault]);
  const [domains, setDomains] = useState<AliasDomain[] | null>(null);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; email: string }[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, a, acc] = await Promise.all([api.domains(), api.list().catch(() => [] as Alias[]), api.accounts()]);
      setDomains(d);
      setAliases(a);
      setAccounts(acc);
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  // While a check is running, look again every few seconds.
  const checking = domains?.some((d) => d.status === "checking");
  useEffect(() => {
    if (!checking) return;
    const t = window.setInterval(() => void api.domains().then(setDomains).catch(() => undefined), 4000);
    return () => window.clearInterval(t);
  }, [checking, api]);

  const replace = (a: Alias) => setAliases((list) => list.map((x) => (x.id === a.id ? a : x)));
  const shown = aliases.filter((a) => {
    if (!q.trim()) return true;
    const title = a.item_id ? vault.get(a.item_id)?.body.title ?? "" : "";
    return `${a.address} ${title}`.toLowerCase().includes(q.trim().toLowerCase());
  });

  return (
    <section data-testid="aliases" className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-lg font-semibold text-[var(--text)]">Aliases</h1>
      <p className="text-sm text-[var(--text-muted)]">
        A different email address for every login, on a domain you own. Mail sent to any of them lands in one of your mailboxes, so you can see who sold or leaked an
        address, and turn it off.
      </p>
      {error && <Callout kind="danger">{error}</Callout>}
      {domains === null ? null : (
        <>
          {domains.map((d) => (
            <DomainCard key={d.id} domain={d} accounts={accounts} onChange={(next) => setDomains((all) => (all ?? []).map((x) => (x.id === next.id ? next : x)))} onRemoved={() => void load()} />
          ))}
          <AddDomain accounts={accounts} first={domains.length === 0} onAdded={(d) => setDomains((all) => [...(all ?? []), d])} />
        </>
      )}
      {aliases.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">Your aliases</h2>
          <input className={inputClass} placeholder="Search aliases" aria-label="Search aliases" value={q} onChange={(e) => setQ(e.target.value)} />
          {shown.map((a) => (
            <AliasRow key={a.id} alias={a} onChange={replace} onRemoved={() => setAliases((list) => list.filter((x) => x.id !== a.id))} />
          ))}
        </div>
      )}
    </section>
  );
}

function AddDomain({ accounts, first, onAdded }: { accounts: { id: string; email: string }[]; first: boolean; onAdded: (d: AliasDomain) => void }) {
  const { vault } = useVault();
  const [domain, setDomain] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!account && accounts[0]) setAccount(accounts[0].id);
  }, [accounts, account]);
  if (!accounts.length) {
    return (
      <Callout>
        Aliases need a mailbox connected in Mail, which is where their mail arrives. <a className="underline" href="/mail">Open Mail</a> and add one first.
      </Callout>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-[var(--border)] p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
          onAdded(await aliasApi(vault.api).addDomain(domain, account));
          setDomain("");
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-sm font-semibold text-[var(--text)]">{first ? "Set up an alias domain" : "Add another domain"}</h2>
      <p className="text-xs text-[var(--text-muted)]">
        First, at your mail provider, add the domain and turn on a catch-all, so mail to anything@thatdomain reaches the mailbox below. The guide has steps for common
        providers. Then add it here and run the check.
      </p>
      <Label text="Domain" hint="One you own, or a subdomain of it, like mail.example.com">
        <input className={inputClass} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" aria-label="Alias domain" />
      </Label>
      <Label text="Its mail lands in">
        <select className={inputClass} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Mailbox for this domain">
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.email}</option>
          ))}
        </select>
      </Label>
      {error && <Callout kind="danger">{error}</Callout>}
      <Button kind="primary" type="submit" disabled={busy || !domain.trim()} className="w-fit">Add domain</Button>
    </form>
  );
}

function DomainCard({ domain: d, accounts, onChange, onRemoved }: { domain: AliasDomain; accounts: { id: string; email: string }[]; onChange: (d: AliasDomain) => void; onRemoved: () => void }) {
  const { vault } = useVault();
  const api = aliasApi(vault.api);
  const [folders, setFolders] = useState<MailFolderRow[]>([]);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    api.folders(d.id).then(setFolders).catch(() => setFolders([]));
  }, [d.id, d.account_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = async (patch: Parameters<typeof api.editDomain>[1]) => {
    setError("");
    try {
      onChange(await api.editDomain(d.id, patch));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const tone = d.status === "ok" ? "text-[var(--success,#2e7d32)]" : d.status === "failed" ? "text-[var(--danger)]" : "text-[var(--text-muted)]";
  return (
    <div data-testid="alias-domain" className="flex flex-col gap-3 rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--text)]">
      <div className="flex flex-wrap items-center gap-2">
        <AtSign className="h-4 w-4 text-[var(--text-muted)]" />
        <span className="font-semibold">{d.domain}</span>
        <span className="text-xs text-[var(--text-muted)]">into {d.account_email}</span>
        <span data-testid="domain-status" className={`ml-auto text-xs font-medium ${tone}`}>{STATUS[d.status]}</span>
      </div>
      {d.status_detail && <Callout kind={d.status === "failed" ? "danger" : "warn"}>{d.status_detail}</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button small disabled={d.status === "checking"} onClick={() => void api.check(d.id).then(onChange).catch((e) => setError(errorText(e)))}>
          <RefreshCw className="h-3 w-3" /> {d.status === "new" ? "Run the check" : "Check again"}
        </Button>
        <span className="text-xs text-[var(--text-muted)]">
          Sends a test from {d.account_email} to a random address on {d.domain}, and waits for it to arrive. {d.checked_at ? `Last worked ${when(d.checked_at)}.` : ""}
        </span>
      </div>
      <p className="text-xs">
        <span className="font-medium">Replying from an alias:</span> {SEND_AS[d.send_as]}.{d.send_as_detail ? ` ${d.send_as_detail}` : ""}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Label text="New aliases start with">
          <select className={inputClass} value={d.word_style} onChange={(e) => void edit({ word_style: e.target.value as WordStyle })}>
            {WORD_STYLES.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        </Label>
        <Label text={`Random part: ${d.random_len} characters`}>
          <input type="range" min={3} max={12} value={d.random_len} onChange={(e) => void edit({ random_len: Number(e.target.value) })} aria-label="Random part length" />
        </Label>
        <Label text="Between word and random part">
          <select className={inputClass} value={d.separator} onChange={(e) => void edit({ separator: e.target.value as AliasDomain["separator"] })}>
            <option value=".">A dot (shop.k7m2)</option>
            <option value="-">A dash (shop-k7m2)</option>
            <option value="_">An underscore (shop_k7m2)</option>
          </select>
        </Label>
        <Label text="When an alias is off, its new mail goes to">
          <select
            className={inputClass}
            value={d.off_folder_id ?? ""}
            onChange={(e) => void edit(e.target.value ? { off_folder_id: e.target.value } : { off_to_trash: true })}
            aria-label="Where mail for an alias that's off goes"
          >
            <option value="">Trash</option>
            {folders.filter((f) => f.role !== "trash" && f.role !== "inbox").map((f) => (
              <option key={f.id} value={f.id}>{f.path}</option>
            ))}
          </select>
        </Label>
        {accounts.length > 1 && (
          <Label text="Mailbox">
            <select className={inputClass} value={d.account_id} onChange={(e) => void edit({ account_id: e.target.value })}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.email}</option>
              ))}
            </select>
          </Label>
        )}
      </div>
      {error && <Callout kind="danger">{error}</Callout>}
      {removing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">Forget {d.domain} and its {d.aliases} aliases? Their mail keeps arriving; it just isn't counted or turned off any more.</span>
          <Button small kind="danger" onClick={() => void api.removeDomain(d.id).then(onRemoved).catch((e) => setError(errorText(e)))}>Forget it</Button>
          <Button small onClick={() => setRemoving(false)}>Keep it</Button>
        </div>
      ) : (
        <Button small kind="ghost" className="w-fit" onClick={() => setRemoving(true)}><Trash2 className="h-3 w-3" /> Remove domain</Button>
      )}
    </div>
  );
}

function AliasRow({ alias: a, onChange, onRemoved }: { alias: Alias; onChange: (a: Alias) => void; onRemoved: () => void }) {
  const { vault, copy, go } = useVault();
  const api = aliasApi(vault.api);
  const item = a.item_id ? vault.get(a.item_id) : undefined;
  const warnings = aliasWarnings(a, item);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const act = (p: Promise<Alias>) => p.then(onChange).catch((e) => setError(errorText(e)));
  return (
    <div data-testid="alias-row" className="flex flex-col gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]">
      <div className="flex flex-wrap items-center gap-2">
        <code className={`min-w-0 flex-1 break-all font-mono ${a.enabled ? "" : "text-[var(--text-muted)] line-through"}`}>{a.address}</code>
        <CopyButton label="alias" value={a.address} onCopy={() => copy(a.address, "Alias", false)} />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={a.enabled} onChange={(e) => void act(api.edit(a.id, { enabled: e.target.checked }))} aria-label={`${a.address} is on`} />
          On
        </label>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {item ? (
          <button className="underline" onClick={() => go(`item/${item.id}`)}>{item.body.title}</button>
        ) : a.item_id ? (
          "A login you can't see here"
        ) : (
          "Not linked to a login"
        )}
        {" · "}
        {a.count === 1 ? "1 email" : `${a.count} emails`}, last {when(a.last_at)}
        {!a.enabled && a.disabled_at ? ` · off since ${when(a.disabled_at)}` : ""}
      </p>
      {warnings.map((w) => (
        <Callout key={w.sender} kind="warn">
          <span data-testid="alias-warning">
            Mail from <b>{w.sender}</b> ({w.count}), which doesn't look like {item ? "this login's site" : "who this alias first heard from"}. The address may have been sold or leaked.
          </span>{" "}
          <span className="inline-flex gap-2">
            <button className="underline" onClick={() => void act(api.allow(a.id, w.sender))}>This sender is fine</button>
            {a.enabled && <button className="underline" onClick={() => void act(api.edit(a.id, { enabled: false }))}>Turn the alias off</button>}
          </span>
        </Callout>
      ))}
      {error && <Callout kind="danger">{error}</Callout>}
      {removing ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          Forget this alias? Mail to it will still arrive, unfiltered. To keep it out, turn it off instead.
          <Button small kind="danger" onClick={() => void api.remove(a.id).then(onRemoved).catch((e) => setError(errorText(e)))}>Forget it</Button>
          <Button small onClick={() => setRemoving(false)}>Keep it</Button>
        </div>
      ) : (
        <button className="w-fit text-xs text-[var(--text-muted)] underline" onClick={() => setRemoving(true)}>Forget</button>
      )}
    </div>
  );
}

/** In the item editor, next to the username: make an alias and use it. */
export function NewAliasButton({ urls, itemId, onMade }: { urls: LoginUrl[]; itemId?: string; onMade: (a: Alias) => void }) {
  const { vault, go } = useVault();
  const api = useMemo(() => aliasApi(vault.api), [vault]);
  const [domains, setDomains] = useState<AliasDomain[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.domains().then((d) => {
      setDomains(d);
      setChosen((c) => c || (d.find((x) => x.status === "ok") ?? d[0])?.id || "");
    }).catch(() => setDomains([]));
  }, [api]);
  if (domains === null) return null;
  if (!domains.length) {
    return (
      <button type="button" className="w-fit text-xs text-[var(--text-muted)] underline" onClick={() => go("aliases")}>
        Use an alias on your own domain…
      </button>
    );
  }
  const domain = domains.find((d) => d.id === chosen) ?? domains[0];
  const make = async () => {
    setError("");
    setBusy(true);
    try {
      onMade(await api.make(domain.id, aliasWord(domain.word_style, { url: urls[0]?.url, custom }), itemId ?? null));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "Unlock the vault again to make an alias." : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button small onClick={() => void make()} disabled={busy} data-testid="new-alias"><AtSign className="h-3 w-3" /> New alias</Button>
        {domains.length > 1 && (
          <select className={`${inputClass} w-auto py-1 text-xs`} value={domain.id} onChange={(e) => setChosen(e.target.value)} aria-label="Alias domain">
            {domains.map((d) => (
              <option key={d.id} value={d.id}>@{d.domain}</option>
            ))}
          </select>
        )}
        {domain.word_style === "custom" && (
          <input className={`${inputClass} w-32 py-1 text-xs`} placeholder="Word" aria-label="Alias word" value={custom} onChange={(e) => setCustom(e.target.value)} />
        )}
        {domain.status !== "ok" && <span className="text-xs text-[var(--warning)]">{domain.domain} hasn't passed its check yet.</span>}
      </div>
      {error && <span className="text-xs text-[var(--danger)]">{error}</span>}
    </div>
  );
}
