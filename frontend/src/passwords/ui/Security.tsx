// Security check: all computed here. Only a password's first five hash characters
// leave, through your server, so the breach service never sees your address.
import { useCallback, useEffect, useState } from "react";

import { coarseCounts, type HealthReport, runHealth, type TwoFaDirectory } from "../core/health";
import { ChangePassword, DuplicatesPanel, MailAlerts, RotationQueue, SurvivalPanel } from "./Connections";
import { BreachAlerts } from "./BreachAlerts";
import { ExpiringSoon } from "./ExpiryAlerts";
import type { Item } from "../core/model";
import { Button, Callout, errorText, Spinner, useVault } from "./kit";

function Row({ item, detail }: { item: Item; detail?: string }) {
  const { go } = useVault();
  return (
    <li className="flex items-center justify-between gap-2 border-b border-[var(--border)] py-1.5 text-sm text-[var(--text)] last:border-0">
      <span className="min-w-0 flex-1 truncate">{item.body.title}{detail ? <span className="ml-2 text-xs text-[var(--text-muted)]">{detail}</span> : null}</span>
      <Button small onClick={() => go(`item/${item.id}`)}>Open</Button>
    </li>
  );
}

function Group({ title, why, children, count }: { title: string; why: string; children: React.ReactNode; count: number }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">{title} <span data-testid={`count-${title}`} className="ml-1 rounded bg-[var(--surface-1)] px-1.5 text-xs">{count}</span></h2>
      <p className="mb-1 text-xs text-[var(--text-muted)]">{why}</p>
      {count > 0 && <ul>{children}</ul>}
    </section>
  );
}

/** Worst first, each once. */
function toChange(r: HealthReport): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of [...r.breached.map((b) => b.item), ...r.reused.flatMap((g) => g.items), ...r.weak]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

export function SecurityScreen() {
  const { vault, platform, settings, setSettings, version } = useVault();
  const [changing, setChanging] = useState<Item | null>(null);
  const [queue, setQueue] = useState<Item[] | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [breach, setBreach] = useState(true);

  const run = useCallback(async () => {
    setError("");
    setProgress("Checking…");
    try {
      const items = vault.allItems();
      let twofa: TwoFaDirectory | undefined;
      let passkeys: Record<string, unknown> | undefined;
      try {
        const dir = await platform.api.directory();
        twofa = dir.twofa;
        passkeys = dir.passkeys;
      } catch {
        /* the directories are a nice extra */
      }
      const r = await runHealth(items, {
        range: breach ? (p) => platform.api.breachRange(p) : undefined,
        twofa,
        passkeys,
        onProgress: (d, t) => setProgress(`Checked ${d} of ${t}`),
      });
      setReport(r);
      if (settings.healthOptIn) platform.api.putHealth(coarseCounts(r)).catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress("");
    }
  }, [vault, platform, breach, settings.healthOptIn]);

  useEffect(() => {
    void version;
  }, [version]);

  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <h1 className="text-lg font-semibold text-[var(--text)]">Security check</h1>
      <SurvivalPanel />
      <MailAlerts onChange={setChanging} />
      <BreachAlerts onChange={setChanging} />
      <ExpiringSoon />
      <DuplicatesPanel />
      <p className="text-sm text-[var(--text-muted)]">Worked out on this device. For breaches, only the first five characters of each password's hash go out, through your server.</p>
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input type="checkbox" checked={breach} onChange={(e) => setBreach(e.target.checked)} />
        Check passwords against known breaches
      </label>
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input
          type="checkbox"
          checked={settings.healthOptIn}
          onChange={(e) => {
            setSettings({ ...settings, healthOptIn: e.target.checked });
            if (!e.target.checked) platform.api.deleteHealth().catch(() => undefined);
          }}
        />
        Show "passwords need attention" on my Today page. That sends your server the counts only, never any names.
      </label>
      <Button kind="primary" className="w-fit" onClick={run} disabled={!!progress}>Check now</Button>
      {progress && <Spinner label={progress} />}
      {error && <Callout kind="danger">{error}</Callout>}
      {report && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text)]">Checked {report.checked} logins.</p>
          {toChange(report).length > 0 && (
            <Button className="w-fit" onClick={() => setQueue(toChange(report))}>Change these one by one ({toChange(report).length})</Button>
          )}
          <Group title="Breached" why="These passwords have appeared in known data breaches. Change them first." count={report.breached.length}>
            {report.breached.map(({ item, count }) => <Row key={item.id} item={item} detail={`seen ${count.toLocaleString()} times`} />)}
          </Group>
          <Group title="Reused" why="If one site leaks, the others are open too." count={report.reused.reduce((n, g) => n + g.items.length, 0)}>
            {report.reused.flatMap((g) => g.items).map((item) => <Row key={item.id} item={item} />)}
          </Group>
          <Group title="Weak" why="Easy to guess." count={report.weak.length}>
            {report.weak.map((item) => <Row key={item.id} item={item} />)}
          </Group>
          <Group title="Old" why="Not changed in over a year." count={report.old.length}>
            {report.old.map((item) => <Row key={item.id} item={item} />)}
          </Group>
          <Group title="Not secure (http)" why="This site's saved address isn't encrypted." count={report.http.length}>
            {report.http.map((item) => <Row key={item.id} item={item} />)}
          </Group>
          <Group title="Could use 2FA" why="These sites offer two-factor sign-in, and you haven't saved a code here." count={report.no2fa.length}>
            {report.no2fa.map(({ item }) => <Row key={item.id} item={item} />)}
          </Group>
          <Group title="No 2FA" why="No 2FA code saved here. Worth adding wherever the site offers it." count={report.noTotp.length}>
            {report.noTotp.map((item) => <Row key={item.id} item={item} />)}
          </Group>
          <Group title="Could use a passkey" why="These sites support passkeys." count={report.noPasskey.length}>
            {report.noPasskey.map((item) => <Row key={item.id} item={item} />)}
          </Group>
          <p className="text-xs text-[var(--text-muted)]">Data sourced from 2FA Directory by 2factorauth (2fa.directory) and Passkeys Directory by 2factorauth (passkeys.2fa.directory). Breach data from Have I Been Pwned.</p>
        </div>
      )}
      {changing && <ChangePassword item={changing} onDone={() => setChanging(null)} />}
      {queue && <RotationQueue items={queue} onDone={() => setQueue(null)} />}
    </section>
  );
}
