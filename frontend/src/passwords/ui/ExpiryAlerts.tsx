// Expiry reminders in Calendar and Tasks, and the Security page's "Expiring soon".
// Own file so the item editor, item view and Security page each need only a line.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  defaultPrefs,
  expiringSoon,
  expiryOf,
  expiryText,
  localToday,
  prefsOf,
  REMINDER_WEEKS,
  type ReminderPrefs,
  reminderPlan,
  safeLabel,
  sameReminder,
  type ServerReminder,
  wantedReminder,
} from "../core/alerts";
import type { Item, ItemBody } from "../core/model";
import type { VaultClient } from "../core/vault";
import { Button, Callout, errorText, inputClass, Label, useVault } from "./kit";

type Listing = { reminders: ServerReminder[]; tasks_available: boolean };

const SERVER_NOTE = "Calendar and Tasks aren't end-to-end encrypted, so this puts the wording below and the date on your server in plain text. Nothing else from this item goes there.";

export const fetchReminders = (vault: VaultClient) => vault.api.request<Listing>("GET", "/reminders");

/** After an item's saved: tell the server what its reminder should now be. ``synced`` is the
 *  sync already started for the save, so two don't run at once. */
export async function syncReminder(vault: VaultClient, item: Item, synced?: Promise<unknown>): Promise<ServerReminder | null> {
  const want = wantedReminder(item);
  if (want) {
    // A new item is only on this device until it syncs, and the server checks it's yours.
    await (synced ?? vault.sync());
    return vault.api.request<ServerReminder>("PUT", `/reminders/${item.id}`, want);
  }
  // Settings say off, or the date's gone: take it away. Without settings, it was never ours.
  if (prefsOf(item.body)) await vault.api.request("DELETE", `/reminders/${item.id}`);
  return null;
}

function weeksText(n: number): string {
  return n === 1 ? "1 week before" : `${n} weeks before`;
}

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function useTasksAvailable(): boolean {
  const { vault } = useVault();
  const [ok, setOk] = useState(true);
  useEffect(() => {
    fetchReminders(vault).then((l) => setOk(l.tasks_available)).catch(() => undefined);
  }, [vault]);
  return ok;
}

/** The choices themselves, kept in the item's encrypted body. */
function PrefsForm({ body, prefs, onChange }: { body: ItemBody; prefs: ReminderPrefs; onChange: (p: ReminderPrefs) => void }) {
  const tasks = useTasksAvailable();
  const set = (next: Partial<ReminderPrefs>) => onChange({ ...prefs, ...next });
  const sent = safeLabel(prefs.label, body);
  return (
    <div className="flex flex-col gap-2" data-testid="reminder-form">
      <Callout kind="warn">{SERVER_NOTE}</Callout>
      <Label text="Reminder wording" hint={`Shows as "${sent} expires". Numbers of three or more digits are left out.`}>
        <input className={inputClass} maxLength={60} value={prefs.label} onChange={(e) => set({ label: e.target.value })} />
      </Label>
      <Label text="Remind me">
        <select className={inputClass} value={prefs.weeks} onChange={(e) => set({ weeks: Number(e.target.value) })}>
          {REMINDER_WEEKS.map((w) => (
            <option key={w} value={w}>{weeksText(w)}</option>
          ))}
        </select>
      </Label>
      <div className="flex flex-wrap gap-4 text-sm text-[var(--text)]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.calendar} onChange={(e) => set({ calendar: e.target.checked })} />
          In Calendar
        </label>
        {(tasks || prefs.task) && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={prefs.task} onChange={(e) => set({ task: e.target.checked })} />
            In Tasks
          </label>
        )}
      </div>
      {!prefs.calendar && !prefs.task && <p className="text-xs text-[var(--danger)]">Choose Calendar, Tasks or both.</p>}
    </div>
  );
}

/** In the item editor: the "Remind me" toggle, for items with an expiry date. */
export function ReminderFields({ body, onChange }: { body: ItemBody; onChange: (p: ReminderPrefs) => void }) {
  if (body.kind !== "document" && body.kind !== "card") return null;
  const prefs = prefsOf(body) ?? defaultPrefs(body);
  const date = expiryOf(body);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input type="checkbox" checked={prefs.on} disabled={!date && !prefs.on} onChange={(e) => onChange({ ...prefs, on: e.target.checked })} />
        Remind me before the expiry date (puts its wording and the date on your server)
      </label>
      {!date && <p className="text-xs text-[var(--text-muted)]">Add an expiry date to get a reminder.</p>}
      {prefs.on && <PrefsForm body={body} prefs={prefs} onChange={onChange} />}
    </div>
  );
}

/** In the item view: what's on the Calendar for it, kept in step with the item. */
export function ReminderPanel({ item, canEdit }: { item: Item; canEdit: boolean }) {
  const { vault, bump, toast, platform } = useVault();
  const [server, setServer] = useState<ServerReminder | null | undefined>(undefined);
  const [editing, setEditing] = useState<ReminderPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const date = expiryOf(item.body);
  const want = wantedReminder(item);
  const prefs = prefsOf(item.body);

  const load = useCallback(async () => {
    try {
      const l = await fetchReminders(vault);
      setServer(l.reminders.find((r) => r.item_id === item.id) ?? null);
    } catch {
      setServer(null);
    }
  }, [vault, item.id]);
  useEffect(() => {
    void load();
  }, [load]);

  // The date or wording changed on another device: move what's on the Calendar to match.
  // Once per change, so a server that words things differently can't set off a loop.
  const tried = useRef("");
  const wantKey = want ? JSON.stringify(want) : "";
  useEffect(() => {
    if (!server || !want || sameReminder(want, server) || !canEdit || tried.current === wantKey) return;
    tried.current = wantKey;
    vault.api.request<ServerReminder>("PUT", `/reminders/${item.id}`, want).then(setServer).catch(() => undefined);
  }, [server, wantKey, canEdit, vault, item.id]);

  if (!date || server === undefined) return null;

  const save = async (next: ReminderPrefs) => {
    setBusy(true);
    setError("");
    try {
      const saved = await vault.update(item.id, { ...vault.get(item.id)!.body, expiryReminder: next });
      const synced = vault.sync().catch(() => undefined);
      setServer(await syncReminder(vault, saved, synced));
      setEditing(null);
      bump();
      toast(next.on ? "Reminder set" : "Reminder removed");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <PrefsForm body={item.body} prefs={editing} onChange={setEditing} />
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="flex gap-2">
          <Button small kind="primary" disabled={busy || (!editing.calendar && !editing.task)} onClick={() => save({ ...editing, on: true })}>Set reminder</Button>
          <Button small onClick={() => setEditing(null)}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (server) {
    const where = [server.calendar && "on your Calendar", server.task && "in Tasks"].filter(Boolean).join(" and ");
    return (
      <div className="flex flex-col gap-1 py-2 text-xs text-[var(--text-muted)]" data-testid="reminder-status">
        <p>
          A reminder is {where}: "{server.label} expires" on {prettyDate(server.expires_on)}, {weeksText(server.weeks)}.
        </p>
        {server.calendar_gone && <p>The Calendar event was deleted there. Save the reminder again to put it back.</p>}
        {server.task_gone && <p>The task was deleted in Tasks. Save the reminder again to put it back.</p>}
        <div className="flex flex-wrap gap-2">
          {/* The server's own pages: from the extension or the Windows app, this page isn't on it. */}
          {server.event_url && <a className="text-[var(--accent)] underline" href={`${platform.baseUrl}${server.event_url}`} target="_blank" rel="noreferrer">Open in Calendar</a>}
          {server.task_url && <a className="text-[var(--accent)] underline" href={`${platform.baseUrl}${server.task_url}`} target="_blank" rel="noreferrer">Open in Tasks</a>}
          {canEdit && <Button small onClick={() => setEditing(prefs ?? { ...defaultPrefs(item.body), on: true })}>Change reminder</Button>}
          {canEdit && <Button small disabled={busy} onClick={() => save({ ...(prefs ?? defaultPrefs(item.body)), on: false })}>Turn off reminder</Button>}
        </div>
        {error && <Callout kind="danger">{error}</Callout>}
      </div>
    );
  }

  if (!canEdit) return null;
  return (
    <div className="flex flex-col gap-1 py-2 text-xs text-[var(--text-muted)]" data-testid="reminder-status">
      {item.body.remindExpiry && <p>An older reminder saying "Document expires soon" may be on your Calendar. It isn't linked to this item and won't move with it.</p>}
      {prefs?.on && <p>This reminder isn't on your Calendar or in Tasks right now.</p>}
      <div className="flex flex-wrap gap-2">
        <Button small disabled={busy} onClick={() => (prefs?.on ? save(prefs) : setEditing({ ...(prefs ?? defaultPrefs(item.body)), on: true }))}>
          {prefs?.on ? "Put the reminder back" : "Remind me before it expires"}
        </Button>
      </div>
      {error && <Callout kind="danger">{error}</Callout>}
    </div>
  );
}

/** Security page: what's expired or expiring in the next three months. All worked out here. */
export function ExpiringSoon() {
  const { vault, version, go } = useVault();
  const [server, setServer] = useState<ServerReminder[]>([]);
  const list = useMemo(() => {
    void version;
    return expiringSoon(vault.allItems(), localToday());
  }, [vault, version]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const l = await fetchReminders(vault);
        // Keep the server in step with dates changed on other devices.
        const plan = reminderPlan(vault.allItems({ includeDeleted: true }), l.reminders);
        for (const p of plan.put) await vault.api.request("PUT", `/reminders/${p.itemId}`, p.body).catch(() => undefined);
        for (const id of plan.remove) await vault.api.request("DELETE", `/reminders/${id}`).catch(() => undefined);
        const fresh = plan.put.length || plan.remove.length ? await fetchReminders(vault) : l;
        if (live) setServer(fresh.reminders);
      } catch {
        /* reminders are an extra here */
      }
    })();
    return () => {
      live = false;
    };
  }, [vault, version]);

  const reminded = new Set(server.map((r) => r.item_id));
  return (
    <section data-testid="expiring-soon" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">
        Expiring soon <span className="ml-1 rounded bg-[var(--surface-1)] px-1.5 text-xs">{list.length}</span>
      </h2>
      <p className="mb-1 text-xs text-[var(--text-muted)]">IDs, licences and cards that have expired or expire in the next three months. Worked out on this device.</p>
      {list.length > 0 && (
        <ul>
          {list.map(({ item, on, days }) => (
            <li key={item.id} className="flex items-center justify-between gap-2 border-b border-[var(--border)] py-1.5 text-sm text-[var(--text)] last:border-0">
              <span className="min-w-0 flex-1 truncate">
                {item.body.title}
                <span className={`ml-2 text-xs ${days < 0 ? "text-[var(--danger)]" : "text-[var(--text-muted)]"}`}>
                  {expiryText(days)} ({prettyDate(on)}){reminded.has(item.id) ? " · reminder set" : ""}
                </span>
              </span>
              <Button small onClick={() => go(`item/${item.id}`)}>Open</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
