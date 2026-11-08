// Security page: breach alerts for your email addresses, from Have I Been Pwned.
// The server checks the addresses (opt-in); which of your logins a breach touches is
// worked out here, so the server never learns what's in the vault.
import { useCallback, useEffect, useMemo, useState } from "react";

import { type Breach, type BreachWatch, exposedPasswords, loginsForBreach } from "../core/alerts";
import type { Item } from "../core/model";
import { Button, Callout, errorText, useVault } from "./kit";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Credit() {
  return (
    <p className="text-xs text-[var(--text-muted)]">
      Breach data from{" "}
      <a className="text-[var(--accent)] underline" href="https://haveibeenpwned.com" target="_blank" rel="noreferrer">Have I Been Pwned</a>, licensed{" "}
      <a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>.
    </p>
  );
}

function BreachRow({ breach, items, onChange }: { breach: Breach; items: Item[]; onChange: (item: Item) => void }) {
  const { go } = useVault();
  const logins = useMemo(() => loginsForBreach(breach, items), [breach, items]);
  return (
    <li className="flex flex-col gap-1 border-b border-[var(--border)] py-2 text-sm text-[var(--text)] last:border-0" data-testid="breach-row">
      <div>
        <span className="font-medium">{breach.title}</span>
        {breach.domain && <span className="ml-2 text-xs text-[var(--text-muted)]">{breach.domain}</span>}
        <span className="ml-2 text-xs text-[var(--text-muted)]">{breach.breach_date ? `breached ${when(breach.breach_date)}` : ""} · {breach.address}</span>
      </div>
      {breach.data_classes.length > 0 && <p className="text-xs text-[var(--text-muted)]">Exposed: {breach.data_classes.join(", ")}</p>}
      {logins.length > 0 ? (
        logins.map((item) => (
          <div key={item.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs">{item.body.title}</span>
            <Button small kind={exposedPasswords(breach) ? "primary" : "plain"} onClick={() => onChange(item)}>Change password</Button>
            <Button small onClick={() => go(`item/${item.id}`)}>Open</Button>
          </div>
        ))
      ) : (
        <p className="text-xs text-[var(--text-muted)]">
          {breach.domain ? `No login for ${breach.domain} in your vault.` : "This breach isn't tied to one website."} If you used that password anywhere else, change it there.
        </p>
      )}
    </li>
  );
}

export function BreachAlerts({ onChange }: { onChange: (item: Item) => void }) {
  const { vault, version, toast } = useVault();
  const [state, setState] = useState<BreachWatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => vault.api.request<BreachWatch>("GET", "/breach-watch").then(setState).catch(() => setState(null)), [vault]);
  useEffect(() => {
    void load();
  }, [load]);
  const items = useMemo(() => {
    void version;
    return vault.allItems();
  }, [vault, version]);

  if (!state) return null;
  const turn = async (on: boolean) => {
    setBusy(true);
    setError("");
    try {
      setState(await vault.api.request<BreachWatch>("PUT", "/breach-watch", { on }));
      toast(on ? "Breach alerts on. The first check runs within a few minutes." : "Breach alerts off, and what was found is forgotten");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.available && !state.on) {
    return (
      <section data-testid="breach-alerts" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">Breaches</h2>
        <p className="text-xs text-[var(--text-muted)]">Alerts when your email address shows up in a data breach need your admin to add a Have I Been Pwned key.</p>
      </section>
    );
  }

  const list = state.addresses.map((a) => a.address).join(", ");
  return (
    <section data-testid="breach-alerts" className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">
        Breaches {state.on && <span className="ml-1 rounded bg-[var(--surface-1)] px-1.5 text-xs">{state.breaches.length}</span>}
      </h2>
      {!state.on ? (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            Get told when one of your email addresses turns up in a data breach. Your server sends these addresses to Have I Been Pwned about once a day: {list || "none yet"}. It keeps the names of the breaches each one is in, which your admin could see. Your vault isn't involved.
          </p>
          <Button small className="w-fit" disabled={busy || !state.addresses.length} onClick={() => turn(true)}>Turn on breach alerts</Button>
        </>
      ) : (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            Watching {list}.{" "}
            {state.addresses.some((a) => a.checked_at)
              ? `Last checked ${when(state.addresses.map((a) => a.checked_at ?? "").sort().slice(-1)[0] || null)}.`
              : "The first check runs within a few minutes."}
          </p>
          {state.breaches.length > 0 ? (
            <ul>
              {state.breaches.map((b) => (
                <BreachRow key={`${b.address}/${b.name}`} breach={b} items={items} onChange={onChange} />
              ))}
            </ul>
          ) : (
            state.addresses.some((a) => a.checked_at) && <p className="text-xs text-[var(--text)]">None of your addresses is in a known breach.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              small
              disabled={busy}
              onClick={async () => {
                try {
                  await vault.api.request("POST", "/breach-watch/check");
                  toast("They'll be checked within ten minutes");
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              Check again soon
            </Button>
            <Button small disabled={busy} onClick={() => turn(false)}>Turn off</Button>
          </div>
        </>
      )}
      {error && <Callout kind="danger">{error}</Callout>}
      <Credit />
    </section>
  );
}
