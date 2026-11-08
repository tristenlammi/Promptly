// Duplicates: logins saved more than once, found on this device (core/duplicates.ts). Merging
// keeps one, moves everything else onto it, and puts the others in Trash for 30 days. What
// someone says isn't a duplicate is kept in their personal vault, encrypted.
import { CheckCircle2, KeyRound, Paperclip, ShieldCheck, StickyNote } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { moveAttachment } from "../core/attachments";
import { type DupeGroup, type DupePrefs, dupePrefsBody, findDuplicateGroups, liveDecisions, mergeDuplicates, prunePairs, readDupePrefs, withNotDuplicate, withoutNotDuplicate } from "../core/duplicates";
import { hostOf } from "../core/match";
import type { Item, ItemBody } from "../core/model";
import type { VaultClient, VaultInfo } from "../core/vault";
import { Button, Callout, errorText, Modal, Spinner, useVault } from "./kit";
import type { Platform } from "./platform";

/** The groups to show, with what the person has already said about some. Recomputed on every
 *  change to the vault. `ready` is false until this device knows which vault is its own. */
export function useDuplicates(vault: VaultClient, version: number): { groups: DupeGroup[]; prefs: DupePrefs; personal: string | null; ready: boolean } {
  const [personal, setPersonal] = useState<string | null>(null);
  useEffect(() => {
    if (!vault.unlocked) return;
    let live = true;
    vault.personalVaultId().then((id) => live && setPersonal(id)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [vault, version]);
  return useMemo(() => {
    void version;
    if (!vault.unlocked || !personal) return { groups: [], prefs: { pairs: [] }, personal, ready: false };
    const { prefs } = readDupePrefs(vault.allItems({ includeSystem: true }), personal);
    return { groups: findDuplicateGroups(vault.allItems(), prefs), prefs, personal, ready: true };
  }, [vault, version, personal]);
}

// ---- Doing it, and undoing it -----------------------------------------------------------

/** What a merge changed, so it can be put back. */
type MergeStep = { keepId: string; vaultId: string; before: ItemBody; dropped: string[]; moved: string[] };

async function mergeGroup(vault: VaultClient, api: Platform["api"], items: Item[], keepId: string): Promise<MergeStep> {
  // As they are now, not as they were when the list was drawn.
  const fresh = items.map((i) => vault.get(i.id)).filter((i): i is Item => !!i && !i.deleted);
  if (fresh.length < 2 || !fresh.some((i) => i.id === keepId)) throw new Error("These logins changed in the meantime. Have another look.");
  const { keep, body, drop, moves } = mergeDuplicates(fresh, keepId);
  const before = structuredClone(keep.body);
  const moved = [];
  try {
    // Before anything's changed, so a failure here leaves all the copies as they were.
    for (const m of moves) moved.push(await moveAttachment(api, { vaultId: m.from.vaultId, itemId: m.from.id }, { vaultId: keep.vaultId, itemId: keep.id }, m.ref));
  } catch (e) {
    for (const r of moved) await api.attachmentDelete(keep.vaultId, r.id).catch(() => undefined);
    throw e;
  }
  if (moved.length) body.attachments = [...(body.attachments ?? []), ...moved];
  await vault.update(keep.id, body);
  for (const d of drop) await vault.trashItem(d.id);
  return { keepId: keep.id, vaultId: keep.vaultId, before, dropped: drop.map((d) => d.id), moved: moved.map((r) => r.id) };
}

async function undoMerge(vault: VaultClient, api: Platform["api"], step: MergeStep): Promise<void> {
  for (const id of step.dropped) if (vault.get(id)?.deleted) await vault.restoreItem(id);
  if (vault.get(step.keepId)) await vault.update(step.keepId, step.before);
  // The copies made for the kept login. The originals never left the restored ones.
  for (const id of step.moved) await api.attachmentDelete(step.vaultId, id).catch(() => undefined);
}

async function savePrefs(vault: VaultClient, personal: string, change: (p: DupePrefs) => DupePrefs): Promise<void> {
  const all = vault.allItems({ includeSystem: true, includeDeleted: true });
  const { item, prefs } = readDupePrefs(all, personal);
  const next = prunePairs(change(prefs), new Map(all.map((i) => [i.id, i])));
  const body = dupePrefsBody(item?.body ?? null, next);
  if (item) await vault.update(item.id, body);
  else await vault.saveNew(personal, body);
}

type Done = { text: string; undo: () => Promise<void> };

// ---- The screen -------------------------------------------------------------------------

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const REASON: Record<DupeGroup["reason"], string> = {
  username: "Same site and username.",
  password: "Same site and password, under different usernames. It may be one account saved twice, or two accounts that share a password.",
  "password-no-username": "Same site and password, and at least one has no username saved.",
};

export function DuplicatesScreen() {
  const { vault, platform, version, bump, toast, go } = useVault();
  const { groups, prefs, personal, ready } = useDuplicates(vault, version);
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [keepIds, setKeepIds] = useState<Record<string, string>>({});
  const [left, setLeft] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    void version;
    vault.vaults().then(setVaults).catch(() => undefined);
  }, [vault, version]);

  const canEdit = useCallback((vaultId: string) => {
    const v = vaults.find((x) => x.id === vaultId);
    return !!v && (v.role === "manage" || v.role === "edit");
  }, [vaults]);
  const vaultName = (vaultId: string) => {
    const v = vaults.find((x) => x.id === vaultId);
    return v && v.kind !== "personal" ? v.displayName : null;
  };

  const sure = groups.filter((g) => g.kind === "sure");
  const likely = groups.filter((g) => g.kind === "likely");
  const mergeable = sure.filter((g) => canEdit(g.vaultId));
  const decided = useMemo(() => {
    void version;
    return vault.unlocked ? liveDecisions(prefs, new Map(vault.allItems({ includeSystem: true, includeDeleted: true }).map((i) => [i.id, i]))) : 0;
  }, [vault, prefs, version]);

  const keepOf = (g: DupeGroup) => (g.items.some((i) => i.id === keepIds[g.key]) ? keepIds[g.key] : g.items[0].id);
  const chosen = (g: DupeGroup) => g.items.filter((i) => i.id === keepOf(g) || !(left[g.key] ?? []).includes(i.id));

  const run = async (label: string, fn: () => Promise<Done | null>) => {
    setBusy(label);
    try {
      const d = await fn();
      if (d) setDone(d);
      vault.sync().catch(() => undefined);
      bump();
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy("");
    }
  };

  const undoable = (steps: MergeStep[]) => async () => {
    for (const s of [...steps].reverse()) await undoMerge(vault, platform.api, s);
  };

  const merge = (g: DupeGroup) =>
    run("Merging…", async () => {
      const items = chosen(g);
      const step = await mergeGroup(vault, platform.api, items, keepOf(g));
      const kept = vault.get(step.keepId)?.body.title ?? "the login you kept";
      const n = step.dropped.length;
      return { text: `Merged into ${kept}. ${n === 1 ? "The other one is" : `The other ${n} are`} in Trash for 30 days.`, undo: undoable([step]) };
    });

  const mergeAll = () =>
    run("Merging…", async () => {
      setConfirmAll(false);
      const steps: MergeStep[] = [];
      const failed: string[] = [];
      for (const g of mergeable) {
        try {
          steps.push(await mergeGroup(vault, platform.api, g.items, g.items[0].id));
        } catch {
          failed.push(g.site);
        }
      }
      if (failed.length) toast(`Couldn't merge ${failed.join(", ")}. The rest are done.`, "err");
      const dropped = steps.reduce((n, s) => n + s.dropped.length, 0);
      if (!steps.length) return null;
      return { text: `Merged ${steps.length} ${steps.length === 1 ? "set" : "sets"}. ${dropped} ${dropped === 1 ? "login is" : "logins are"} in Trash for 30 days.`, undo: undoable(steps) };
    });

  const notDuplicate = (g: DupeGroup) =>
    run("Saving…", async () => {
      if (!personal) throw new Error("This device hasn't found your own vault yet. Sync, then try again.");
      const ids = g.items.map((i) => i.id);
      await savePrefs(vault, personal, (p) => withNotDuplicate(p, g.items));
      return { text: "Got it. These won't be suggested again unless their site, username or password changes.", undo: () => savePrefs(vault, personal, (p) => withoutNotDuplicate(p, ids)) };
    });

  const suggestAgain = () =>
    run("Saving…", async () => {
      if (!personal) return null;
      const before = prefs;
      await savePrefs(vault, personal, () => ({ pairs: [] }));
      return { text: "Everything you'd marked is suggested again.", undo: () => savePrefs(vault, personal, () => before) };
    });

  if (!ready) return <Spinner label="Looking for duplicates…" />;

  const totalDrop = mergeable.reduce((n, g) => n + g.items.length - 1, 0);

  return (
    <section data-testid="duplicates-screen" className="flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--text)]">Duplicates</h1>
          <p className="max-w-2xl text-sm text-[var(--text-muted)]">
            Logins saved more than once, found on this device. Merging keeps the one you choose, puts the other passwords in its history, and brings across websites, notes, 2FA, passkeys and attachments. The others go to Trash for 30 days.
          </p>
        </div>
        {mergeable.length > 0 && (
          <Button kind="primary" disabled={!!busy} onClick={() => setConfirmAll(true)}>
            Merge all sure duplicates ({mergeable.length})
          </Button>
        )}
      </div>

      {done && (
        <div role="status" data-testid="dupes-done" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text)]">
          <span className="min-w-0 flex-1">{done.text}</span>
          <Button small disabled={!!busy} onClick={() => run("Undoing…", async () => { await done.undo(); setDone(null); toast("Undone"); return null; })}>Undo</Button>
          <Button small kind="ghost" onClick={() => setDone(null)}>Dismiss</Button>
        </div>
      )}
      {busy && <Spinner label={busy} />}

      {groups.length === 0 && (
        <div data-testid="dupes-empty" className="flex flex-col items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-[var(--success)]" aria-hidden="true" />
          <p className="font-medium text-[var(--text)]">No duplicates</p>
          <p className="text-sm text-[var(--text-muted)]">Every login here is saved once. New ones are checked as you save them.</p>
        </div>
      )}

      {sure.length > 0 && (
        <GroupList
          title="Saved twice"
          testId="dupes-sure"
          why="The same site and the same username. Almost always one login saved more than once."
          groups={sure}
          {...{ keepOf, setKeep: (g: DupeGroup, id: string) => setKeepIds((k) => ({ ...k, [g.key]: id })), left, setLeft, canEdit, vaultName, busy: !!busy, merge, notDuplicate, open: (id: string) => go(`item/${id}`) }}
        />
      )}
      {likely.length > 0 && (
        <GroupList
          title="Probably the same login"
          testId="dupes-likely"
          why="The same password on the same site, under another username or none. Check before merging: they could be two different accounts."
          groups={likely}
          {...{ keepOf, setKeep: (g: DupeGroup, id: string) => setKeepIds((k) => ({ ...k, [g.key]: id })), left, setLeft, canEdit, vaultName, busy: !!busy, merge, notDuplicate, open: (id: string) => go(`item/${id}`) }}
        />
      )}

      {decided > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-muted)]">
          You've marked {decided} {decided === 1 ? "pair" : "pairs"} of logins as not duplicates.
          <Button small disabled={!!busy} onClick={suggestAgain}>Suggest them again</Button>
        </p>
      )}

      {confirmAll && (
        <Modal title="Merge all sure duplicates?" onClose={() => setConfirmAll(false)}>
          <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
            <p>
              {mergeable.length} {mergeable.length === 1 ? "set" : "sets"} of logins saved twice will each keep the newest. {totalDrop} {totalDrop === 1 ? "login goes" : "logins go"} to Trash for 30 days, and nothing in them is lost: passwords go to history, and everything else comes across.
            </p>
            {likely.length > 0 && <p className="text-[var(--text-muted)]">Logins that are only probably the same aren't included. Look at those one by one.</p>}
            <p className="text-[var(--text-muted)]">You can undo this straight after.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setConfirmAll(false)}>Cancel</Button>
              <Button kind="primary" onClick={mergeAll}>Merge {mergeable.length}</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

type ListProps = {
  title: string;
  testId: string;
  why: string;
  groups: DupeGroup[];
  keepOf: (g: DupeGroup) => string;
  setKeep: (g: DupeGroup, id: string) => void;
  left: Record<string, string[]>;
  setLeft: (f: (l: Record<string, string[]>) => Record<string, string[]>) => void;
  canEdit: (vaultId: string) => boolean;
  vaultName: (vaultId: string) => string | null;
  busy: boolean;
  merge: (g: DupeGroup) => void;
  notDuplicate: (g: DupeGroup) => void;
  open: (id: string) => void;
};

function GroupList({ title, testId, why, groups, ...rest }: ListProps) {
  return (
    <section data-testid={testId} aria-labelledby={`${testId}-h`} className="flex flex-col gap-2">
      <h2 id={`${testId}-h`} className="text-sm font-semibold text-[var(--text)]">
        {title} <span className="ml-1 rounded bg-[var(--surface-1)] px-1.5 text-xs">{groups.length}</span>
      </h2>
      <p className="text-xs text-[var(--text-muted)]">{why}</p>
      <ul className="flex flex-col gap-3">
        {groups.map((g) => (
          <GroupCard key={g.key} group={g} {...rest} />
        ))}
      </ul>
    </section>
  );
}

function GroupCard({ group: g, keepOf, setKeep, left, setLeft, canEdit, vaultName, busy, merge, notDuplicate, open }: Omit<ListProps, "title" | "testId" | "why" | "groups"> & { group: DupeGroup }) {
  const keep = keepOf(g);
  const out = left[g.key] ?? [];
  const editable = canEdit(g.vaultId);
  const shared = vaultName(g.vaultId);
  const many = g.items.length > 2;
  const taking = g.items.filter((i) => i.id === keep || !out.includes(i.id)).length;
  const heading = `${g.site}, ${g.items.length} logins`;
  return (
    <li data-testid="dupe-group" aria-label={heading} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-medium text-[var(--text)]">{g.site}</h3>
        <span className="text-xs text-[var(--text-muted)]">{g.items.length} logins{shared ? ` · ${shared}` : ""}</span>
      </div>
      <p className="mb-2 text-xs text-[var(--text-muted)]">{REASON[g.reason]}</p>
      <fieldset>
        <legend className="sr-only">Which one to keep for {g.site}</legend>
        <div className={`grid grid-cols-1 gap-2 ${g.items.length >= 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"}`}>
          {g.items.map((i, n) => (
            <LoginCard
              key={i.id}
              item={i}
              group={g}
              newest={n === 0}
              kept={i.id === keep}
              included={i.id === keep || !out.includes(i.id)}
              showInclude={many}
              disabled={!editable || busy}
              onKeep={() => setKeep(g, i.id)}
              onInclude={(on) => setLeft((l) => ({ ...l, [g.key]: on ? (l[g.key] ?? []).filter((x) => x !== i.id) : [...(l[g.key] ?? []), i.id] }))}
              onOpen={() => open(i.id)}
            />
          ))}
        </div>
      </fieldset>
      {!editable && <p className="mt-2 text-xs text-[var(--text-muted)]">You can't change logins in this shared vault, so these can't be merged here. Someone who can edit it can.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button kind="primary" small disabled={!editable || busy || taking < 2} onClick={() => merge(g)}>
          {taking < g.items.length ? `Merge ${taking}` : "Merge"}
        </Button>
        <Button small disabled={busy} onClick={() => notDuplicate(g)}>Not a duplicate</Button>
      </div>
    </li>
  );
}

function LoginCard({ item, group, newest, kept, included, showInclude, disabled, onKeep, onInclude, onOpen }: {
  item: Item;
  group: DupeGroup;
  newest: boolean;
  kept: boolean;
  included: boolean;
  showInclude: boolean;
  disabled: boolean;
  onKeep: () => void;
  onInclude: (on: boolean) => void;
  onOpen: () => void;
}) {
  const b = item.body;
  const hosts = [...new Set((b.urls ?? []).map((u) => hostOf(u.url)).filter(Boolean))] as string[];
  const passkeys = b.passkeys?.length ?? 0;
  const files = b.attachments?.length ?? 0;
  const id = `keep-${item.id}`;
  return (
    <div data-testid="dupe-login" className={`flex min-w-0 flex-col gap-1 rounded-lg border p-2.5 text-sm ${kept ? "border-[var(--accent)] bg-[var(--surface-1)]" : "border-[var(--border)]"} ${included ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-2">
        <input id={id} type="radio" name={`keep-${group.key}`} aria-label={`Keep ${b.title || "this login"}`} checked={kept} disabled={disabled} onChange={onKeep} className="accent-[var(--accent)]" />
        <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate font-medium text-[var(--text)]">
          {b.title || "(no name)"}
        </label>
        {kept && <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 text-xs text-[var(--text)]">Keeping</span>}
      </div>
      <div className="truncate text-[var(--text)]">{b.username ? b.username : <span className="text-[var(--text-muted)]">No username</span>}</div>
      <div className="truncate text-xs text-[var(--text-muted)]">{hosts.join(", ") || "No website"}</div>
      <div className="text-xs text-[var(--text-muted)]">Last changed {day(b.updatedAt)}{newest ? " · newest" : ""}</div>
      <div className="flex flex-wrap gap-1 text-xs text-[var(--text)]">
        {b.totp && <Tag icon={<ShieldCheck className="h-3 w-3" />} text="2FA" />}
        {passkeys > 0 && <Tag icon={<KeyRound className="h-3 w-3" />} text={passkeys === 1 ? "Passkey" : `${passkeys} passkeys`} />}
        {files > 0 && <Tag icon={<Paperclip className="h-3 w-3" />} text={files === 1 ? "1 attachment" : `${files} attachments`} />}
        {b.notes && <Tag icon={<StickyNote className="h-3 w-3" />} text="Notes" />}
        {b.archived && <Tag text="Archived" />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button small kind="ghost" onClick={onOpen} aria-label={`Open ${b.title || "login"}`}>Open</Button>
        {showInclude && !kept && (
          <label className="flex items-center gap-1 text-xs text-[var(--text)]">
            <input type="checkbox" checked={included} disabled={disabled} onChange={(e) => onInclude(e.target.checked)} className="accent-[var(--accent)]" />
            Include in merge
          </label>
        )}
      </div>
    </div>
  );
}

function Tag({ icon, text }: { icon?: ReactNode; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5">
      {icon}
      {text}
    </span>
  );
}

/** For Security check: how many there are, and the way to them. */
export function DuplicatesSummary() {
  const { vault, version, go } = useVault();
  const { groups } = useDuplicates(vault, version);
  if (!groups.length) return null;
  const sure = groups.filter((g) => g.kind === "sure").length;
  const likely = groups.length - sure;
  const text = sure
    ? `${sure} ${sure === 1 ? "login is" : "logins are"} saved twice${likely ? `, and ${likely} more might be` : ""}.`
    : `${likely} ${likely === 1 ? "login" : "logins"} might be saved twice.`;
  return (
    <section data-testid="duplicates" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Duplicates</h2>
      <Callout>
        <span>{text}</span>
        <Button small className="ml-2" onClick={() => go("duplicates")}>Review duplicates</Button>
      </Callout>
    </section>
  );
}
