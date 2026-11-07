// The parts of the vault that lean on the rest of Promptly: warnings about losing it,
// security emails, changing a password with the site, documents from Files, travel mode
// and unlocking with a passkey.
import { useCallback, useEffect, useMemo, useState } from "react";

import { changePageUrl, clockDriftText, commitPending, createPasskeyUnlock, dropPending, findDuplicates, mergeDuplicates, type PasskeyUnlock, type SecurityAlert, securityAlerts, type SecurityEvent, withPending } from "../core/connections";
import { buildKitPdf } from "../core/kit";
import { encodeSecretKey, lastGroup } from "../core/keys";
import { generateForSite } from "../core/generator";
import { hostOf } from "../core/match";
import { type Item, newBody } from "../core/model";
import { downloadAttachment, moveAttachment, uploadAttachment } from "../core/attachments";
import { equalBytes } from "../core/bytes";
import { Reprompt } from "./ItemView";
import { Button, Callout, errorText, inputClass, Label, Modal, safeHref, useVault } from "./kit";
import { downloadBlob } from "./Onboarding";

const RECOVERY_CHECK_DAYS = 182;
const UNREACHABLE_WARN_DAYS = 3;
const BACKUP_WARN_DAYS = 8;

type SurvivalOut = { is_admin: boolean; kit_confirmed: boolean; kit_confirmed_at: string | null; offsite_configured: boolean; last_backup_at: string | null; backup_age_days: number | null };

/** What could lose you this vault, in plain words, with the fix beside it. */
export function SurvivalPanel() {
  const { vault, go, toast } = useVault();
  const [data, setData] = useState<SurvivalOut | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [lastCheck, setLastCheck] = useState<string | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void vault.api.request<SurvivalOut>("GET", "/survival").then(setData).catch(() => undefined);
    void vault.store.getMeta<number>("last_sync").then((v) => setLastSync(v ?? null));
    void vault.store.getMeta<string>("recovery_checked").then((v) => setLastCheck(v ?? null));
  }, [vault]);

  const items: { key: string; kind: "warn" | "danger"; text: string; action?: { label: string; run: () => void } }[] = [];
  if (data && !data.kit_confirmed) items.push({ key: "kit", kind: "danger", text: "You haven't confirmed saving your recovery kit. Without it, a forgotten master password means this vault is gone for good." });
  if (data && !data.offsite_configured) {
    items.push({
      key: "offsite",
      kind: "warn",
      text: data.is_admin ? "No off-site backup is set up. If this server's disk fails, your vault goes with it, unless a device still has its copy." : "Whoever runs this server hasn't set up off-site backups. Keep an encrypted export of your own.",
      action: { label: "Export", run: () => go("transfer") },
    });
  }
  if (data && (data.backup_age_days === null || data.backup_age_days > BACKUP_WARN_DAYS)) {
    items.push({ key: "backup", kind: "warn", text: data.backup_age_days === null ? "This server hasn't made a backup yet." : `The last backup on this server was ${data.backup_age_days} days ago.` });
  }
  const unreachable = lastSync ? Math.floor((Date.now() - lastSync) / 86_400_000) : 0;
  if (unreachable >= UNREACHABLE_WARN_DAYS) items.push({ key: "unreachable", kind: "warn", text: `This device hasn't reached your server for ${unreachable} days. It keeps working from its own copy, but what you change here isn't backed up anywhere else yet.` });
  const due = lastCheck !== undefined && recoveryDue(data?.kit_confirmed_at, lastCheck);

  const check = async () => {
    setError("");
    if (!(await vault.checkPassword(pw))) return setError("That master password isn't right. If you've forgotten it, now's the time to find your kit.");
    const at = new Date().toISOString();
    await vault.store.setMeta("recovery_checked", at);
    setLastCheck(at);
    setChecking(false);
    setPw("");
    toast("Noted. We'll ask again in six months.");
  };

  if (!items.length && !due) return null;
  return (
    <section data-testid="survival" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Keeping this vault safe</h2>
      {items.map((i) => (
        <Callout key={i.key} kind={i.kind}>
          <span>{i.text}</span>
          {i.action && <Button small className="ml-2" onClick={i.action.run}>{i.action.label}</Button>}
        </Callout>
      ))}
      {due && (
        <Callout>
          <span>Do you still have your recovery kit, and do you still know your master password?</span>
          <Button small className="ml-2" onClick={() => setChecking(true)}>Check my kit</Button>
        </Callout>
      )}
      {checking && (
        <Modal title="Recovery check" onClose={() => setChecking(false)}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text)]">Find your kit and make sure you can still read it. Then type your master password. It stays on this device.</p>
            <Label text="Master password">
              <input className={inputClass} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </Label>
            {error && <Callout kind="danger">{error}</Callout>}
            <Button kind="primary" disabled={!pw} onClick={check}>I have the kit, and this is my password</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** "Instagram says your password changed. Was that you?" Matched here, against the vault. */
export function MailAlerts({ onChange }: { onChange: (item: Item) => void }) {
  const { vault, version, go } = useVault();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    void vault.api.request<SecurityEvent[]>("GET", "/mail/security-events").then(setEvents).catch(() => undefined);
    void vault.store.getMeta<string[]>("alerts_dismissed").then((v) => setDismissed(v ?? []));
  }, [vault]);
  const alerts = useMemo<SecurityAlert[]>(() => {
    void version;
    return securityAlerts(events, vault.allItems()).filter((a) => !dismissed.includes(a.event.id));
  }, [events, vault, version, dismissed]);
  if (!alerts.length) return null;
  const dismiss = async (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    await vault.store.setMeta("alerts_dismissed", next.slice(-200));
  };
  return (
    <section data-testid="mail-alerts" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">From your email</h2>
      {alerts.map((a) => (
        <Callout key={a.event.id} kind="warn">
          <p>{a.text}</p>
          <p className="mb-2 text-xs opacity-80">{new Date(a.event.at).toLocaleString()} · {a.event.subject}</p>
          <div className="flex flex-wrap gap-2">
            <Button small onClick={() => onChange(a.item)}>Not me: change password</Button>
            <Button small onClick={() => go(`item/${a.item.id}`)}>Open login</Button>
            <Button small onClick={() => dismiss(a.event.id)}>That was me</Button>
          </div>
        </Callout>
      ))}
    </section>
  );
}

/** One password, with the site, at the person's pace. It's never a bot: you do each step. */
export function ChangePassword({ item, onDone, next }: { item: Item; onDone: () => void; next?: () => void }) {
  const { vault, bump, copy, toast } = useVault();
  const current = vault.get(item.id) ?? item;
  const url = changePageUrl(current.body);
  const host = hostOf(current.body.urls?.[0]?.url ?? "");
  const [pending, setPending] = useState(current.body.pendingPassword ?? "");
  const [error, setError] = useState("");
  const [passed, setPassed] = useState(!current.body.reprompt);

  const start = async () => {
    setError("");
    try {
      const password = generateForSite(host);
      // Saved before anything else happens, so a failed change can't lose it.
      await vault.update(item.id, withPending(vault.get(item.id)!.body, password));
      vault.sync().catch(() => undefined);
      setPending(password);
      bump();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const finish = async (worked: boolean) => {
    const body = vault.get(item.id)!.body;
    await vault.update(item.id, worked ? commitPending(body) : dropPending(body));
    vault.sync().catch(() => undefined);
    bump();
    toast(worked ? "Password changed. The old one's in its history." : "Kept the old password.");
    if (next) next();
    else onDone();
  };

  if (!passed) {
    return (
      <Modal title="Your master password" onClose={onDone}>
        <Reprompt onPass={() => setPassed(true)} onCancel={onDone} />
      </Modal>
    );
  }
  return (
    <Modal title={`Change password for ${current.body.title}`} onClose={onDone}>
      <div data-testid="change-flow" className="flex flex-col gap-3 text-sm text-[var(--text)]">
        {!pending ? (
          <>
            <p>A new password gets made for this site and saved here first. You then change it on the site, and the extension can fill the old and the new one for you.</p>
            <Button kind="primary" onClick={start}>Make a new password</Button>
          </>
        ) : (
          <>
            <p>Your new password is saved, waiting on the site.</p>
            <div className="flex flex-wrap gap-2">
              {url && safeHref(url) && (
                <a className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text)]" href={safeHref(url)} target="_blank" rel="noopener noreferrer">
                  Open the site's change page
                </a>
              )}
              <Button onClick={() => copy(current.body.password ?? "", "Current password", true)}>Copy current</Button>
              <Button onClick={() => copy(pending, "New password", true)}>Copy new</Button>
            </div>
            <p className="font-medium">Did the site accept it?</p>
            <div className="flex gap-2">
              <Button kind="primary" onClick={() => finish(true)}>Yes, it's changed</Button>
              <Button onClick={() => finish(false)}>No, keep the old one</Button>
            </div>
          </>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
      </div>
    </Modal>
  );
}

/** Work through a list, one site at a time. */
export function RotationQueue({ items, onDone }: { items: Item[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  if (i >= items.length) {
    return (
      <Modal title="All done" onClose={onDone}>
        <p className="mb-3 text-sm text-[var(--text)]">You've been through the list. Run the Security check again to see what's left.</p>
        <Button kind="primary" onClick={onDone}>Close</Button>
      </Modal>
    );
  }
  return <ChangePassword key={items[i].id} item={items[i]} onDone={onDone} next={() => setI(i + 1)} />;
}

export function DuplicatesPanel() {
  const { vault, version, bump, toast, platform } = useVault();
  const groups = useMemo(() => {
    void version;
    return findDuplicates(vault.allItems());
  }, [vault, version]);
  if (!groups.length) return null;
  const merge = async (group: Item[]) => {
    const { keep, body, drop, moves } = mergeDuplicates(group);
    try {
      // Before anything's changed, so a failure here leaves all the copies as they were.
      const moved = [];
      for (const m of moves) moved.push(await moveAttachment(platform.api, { vaultId: m.from.vaultId, itemId: m.from.id }, { vaultId: keep.vaultId, itemId: keep.id }, m.ref));
      if (moved.length) body.attachments = [...(body.attachments ?? []), ...moved];
      await vault.update(keep.id, body);
      for (const d of drop) await vault.trashItem(d.id);
      vault.sync().catch(() => undefined);
      bump();
      toast("Merged. The others are in Trash for 30 days.");
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  return (
    <section data-testid="duplicates" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Saved twice</h2>
      <p className="text-xs text-[var(--text-muted)]">Same site, same username. Merging keeps the newest, and moves other passwords to its history, so nothing's lost.</p>
      {groups.map((g) => (
        <div key={g.map((i) => i.id).join()} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2 text-sm text-[var(--text)]">
          <span className="min-w-0 flex-1 truncate">{g[0].body.title} · {g[0].body.username} · {g.length} copies</span>
          <Button small onClick={() => merge(g)}>Merge</Button>
        </div>
      ))}
    </section>
  );
}

type DriveFile = { id: string; name: string; size_bytes: number; mime_type: string };

/** Move a scan from Files into the vault, then offer to bin the unencrypted original. */
export function FromFiles({ item, onClose }: { item: Item; onClose: () => void }) {
  const { vault, platform, bump, toast } = useVault();
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [moved, setMoved] = useState<DriveFile | null>(null);
  const [remind, setRemind] = useState(item.body.expiresOn ?? "");

  useEffect(() => {
    const t = setTimeout(() => {
      void vault.api.request<DriveFile[]>("GET", `/drive/files?q=${encodeURIComponent(q)}`).then(setFiles).catch((e) => setError(errorText(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [vault, q]);

  const take = async (f: DriveFile) => {
    setError("");
    setBusy(`Encrypting ${f.name}…`);
    try {
      const raw = await vault.api.request<ArrayBuffer>("GET", `/drive/files/${f.id}/content`);
      const blob = new Blob([raw], { type: f.mime_type });
      await vault.sync();
      const ref = await uploadAttachment(platform.api, item.vaultId, item.id, { name: f.name, type: f.mime_type, size: blob.size, slice: (a, b) => blob.slice(a, b) });
      const fresh = vault.get(item.id)!;
      await vault.update(item.id, { ...fresh.body, attachments: [...(fresh.body.attachments ?? []), ref] });
      await vault.sync();
      bump();
      // The next step offers to delete the original, so make sure this copy really opens first.
      const back = await downloadAttachment(platform.api, item.vaultId, item.id, ref);
      if (!equalBytes(back, new Uint8Array(raw))) throw new Error("The copy in your vault didn't read back the same, so the original's still the one to keep.");
      setMoved(f);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  if (moved) {
    return (
      <Modal title="It's in the vault" onClose={onClose}>
        <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>{moved.name} is now encrypted here. The original is still in Files, where your server can read it.</p>
          <Button
            kind="primary"
            onClick={async () => {
              try {
                await vault.api.request("POST", `/drive/files/${moved.id}/trash`);
                toast("Moved to Files' Trash");
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Move the original to Trash
          </Button>
          <hr className="border-[var(--border)]" />
          <Label text="Remind me in Calendar on" hint={'Calendar isn\'t end-to-end encrypted, so it just says "Document expires soon", and nothing about which one.'}>
            <input className={inputClass} type="date" value={remind} onChange={(e) => setRemind(e.target.value)} />
          </Label>
          <Button
            disabled={!remind}
            onClick={async () => {
              try {
                await vault.api.request("POST", "/reminder", { on: remind });
                toast("Reminder added");
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Add the reminder
          </Button>
          {error && <Callout kind="danger">{error}</Callout>}
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Add from Files" onClose={onClose}>
      <div className="flex flex-col gap-2">
        <input className={inputClass} placeholder="Search your files" aria-label="Search your files" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {files.map((f) => (
            <li key={f.id}>
              <button className="w-full rounded-lg border border-[var(--border)] p-2 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-2)]" onClick={() => take(f)} disabled={!!busy}>
                {f.name} <span className="text-xs text-[var(--text-muted)]">{(f.size_bytes / 1048576).toFixed(1)} MB</span>
              </button>
            </li>
          ))}
          {!files.length && <li className="text-sm text-[var(--text-muted)]">Nothing found.</li>}
        </ul>
        {busy && <p className="text-xs text-[var(--text-muted)]">{busy}</p>}
        {error && <Callout kind="danger">{error}</Callout>}
      </div>
    </Modal>
  );
}

export function ClockWarning() {
  const { vault } = useVault();
  const text = clockDriftText(vault.serverTimeOffsetMs);
  return text ? <Callout kind="warn">{text}</Callout> : null;
}

/** Travel mode: chosen vaults come off this device until you're back. */
export function TravelPanel() {
  const { vault, version, bump, toast } = useVault();
  const [vaults, setVaults] = useState<Awaited<ReturnType<typeof vault.vaults>>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => vault.vaults().then(setVaults), [vault]);
  useEffect(() => {
    void load();
  }, [load, version]);
  const hidden = vaults.filter((v) => v.hidden);

  const start = async () => {
    setError("");
    if (!confirm("Remove these vaults from this device until you turn travel mode off?")) return;
    try {
      await vault.setTravelHidden(chosen);
      setChosen([]);
      bump();
      await load();
      toast("They're off this device");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const end = async () => {
    setError("");
    try {
      await vault.endTravel(pw);
      setPw("");
      bump();
      await load();
      toast("Everything's back");
    } catch {
      setError("That master password isn't right.");
    }
  };

  return (
    <div data-testid="travel" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Travel mode</h2>
      <p className="text-xs text-[var(--text-muted)]">Takes chosen vaults off this device, so someone looking through it at a border can't find them even if you unlock it. They stay on your server. It only protects you if your server isn't reachable by whoever's looking, and if you don't turn it off for them.</p>
      {hidden.length > 0 ? (
        <>
          <Callout kind="warn">Off this device: {hidden.map((v) => v.displayName).join(", ")}</Callout>
          <Label text="Master password, to bring them back">
            <input className={inputClass} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Label>
          <Button disabled={!pw} onClick={end}>Turn off travel mode</Button>
        </>
      ) : (
        <>
          {vaults.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm text-[var(--text)]">
              <input type="checkbox" checked={chosen.includes(v.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, v.id] : chosen.filter((x) => x !== v.id))} />
              {v.displayName}
            </label>
          ))}
          <Button disabled={!chosen.length} onClick={start}>Take them off this device</Button>
        </>
      )}
      {error && <Callout kind="danger">{error}</Callout>}
    </div>
  );
}

/** Web only. The offer's made after a live test passes, and the master password always works. */
export function PasskeyUnlockPanel() {
  const { vault, platform, toast } = useVault();
  const [saved, setSaved] = useState<PasskeyUnlock | null | undefined>(undefined);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void vault.store.getMeta<PasskeyUnlock>("passkey_unlock").then((v) => setSaved(v ?? null));
  }, [vault]);
  if (platform.kind !== "web" || saved === undefined || !window.PublicKeyCredential) return null;

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const secret = await vault.exportUnlockSecret(pw);
      const made = await createPasskeyUnlock(vault.userId ?? "", secret);
      secret.fill(0);
      if (!made) {
        setError("This browser or passkey can't do this. Your passkey was made but can't unlock anything, so you can delete it. Your master password still works.");
        return;
      }
      await vault.store.setMeta("passkey_unlock", made);
      setSaved(made);
      setPw("");
      toast("You can now unlock with this passkey on this device");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="passkey-unlock" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Unlock with a passkey</h2>
      {saved ? (
        <>
          <p className="text-sm text-[var(--text)]">On for this browser. Your master password still works, and you'll still need it on other devices.</p>
          <Button
            onClick={async () => {
              await vault.store.deleteMeta("passkey_unlock");
              setSaved(null);
            }}
          >
            Turn it off here
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-[var(--text-muted)]">A shorter way back in, on this browser only. It needs a passkey that supports the PRF feature, and we test yours before relying on it.</p>
          <Label text="Master password">
            <input className={inputClass} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Label>
          <Button disabled={!pw || busy} onClick={add}>Set it up</Button>
        </>
      )}
      {error && <Callout kind="warn">{error}</Callout>}
    </div>
  );
}

/** A shorter way back in, for this run of the app. */
export function PinPanel() {
  const { vault, platform, toast } = useVault();
  const [on, setOn] = useState(!!platform.pin?.has());
  const [pw, setPw] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  if (!platform.pin) return null;
  return (
    <div data-testid="pin" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Short PIN</h2>
      {on ? (
        <Button
          className="w-fit"
          onClick={() => {
            platform.pin!.clear();
            setOn(false);
          }}
        >
          Remove my PIN
        </Button>
      ) : (
        <>
          <p className="text-xs text-[var(--text-muted)]">Unlocks again until you close the app. Five wrong tries and it's gone. It's weaker than your master password, so it's off unless you set one.</p>
          <Label text="Master password"><input className={inputClass} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Label>
          <Label text="PIN, 4 to 12 digits"><input className={inputClass} type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} /></Label>
          <Button
            className="w-fit"
            disabled={!pw || !pin}
            onClick={async () => {
              setError("");
              try {
                const secret = await vault.exportUnlockSecret(pw);
                await platform.pin!.set(pin, secret);
                secret.fill(0);
                setPw("");
                setPin("");
                setOn(true);
                toast("PIN set");
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Set PIN
          </Button>
        </>
      )}
      {error && <Callout kind="danger">{error}</Callout>}
    </div>
  );
}

export const VAULT_PREFS = "vault-prefs";

/** Who gets a say over which vaults show site icons. Off unless turned on, per vault. */
export function VaultIconsToggle({ vaultId }: { vaultId: string }) {
  const { vault, version, bump, toast } = useVault();
  const row = useMemo(() => {
    void version;
    return vault.allItems({ includeSystem: true }).find((i) => i.vaultId === vaultId && i.body.kind === "prefs" && i.body.title === VAULT_PREFS);
  }, [vault, vaultId, version]);
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--text)]">
      <input
        type="checkbox"
        checked={!!row?.body.icon}
        onChange={async (e) => {
          try {
            if (row) await vault.update(row.id, { ...row.body, icon: e.target.checked });
            else await vault.saveNew(vaultId, newBody("prefs", VAULT_PREFS, { icon: e.target.checked }));
            vault.sync().catch(() => undefined);
            bump();
          } catch (err) {
            toast(errorText(err), "err");
          }
        }}
      />
      Show site icons in this vault. They're fetched through your server, which sees each site's name at that moment.
    </label>
  );
}

/** Rename or delete a folder. The items in it stay, just out of the folder. */
export function FolderTools({ folderId }: { folderId: string }) {
  const { vault, bump, go, toast } = useVault();
  const [renaming, setRenaming] = useState(false);
  const folder = vault.get(folderId);
  const [name, setName] = useState(folder?.body.title ?? "");
  if (!folder) return null;
  const remove = async () => {
    if (!confirm(`Delete the folder ${folder.body.title}? What's in it stays, out of the folder.`)) return;
    for (const i of vault.allItems()) {
      if (i.body.folderId === folderId) await vault.update(i.id, { ...i.body, folderId: null });
    }
    await vault.trashItem(folderId);
    vault.sync().catch(() => undefined);
    bump();
    go("all");
    toast("Folder deleted");
  };
  return (
    <span className="flex gap-1">
      <Button small onClick={() => setRenaming(true)}>Rename</Button>
      <Button small onClick={remove}>Delete folder</Button>
      {renaming && (
        <Modal title="Rename folder" onClose={() => setRenaming(false)}>
          <div className="flex flex-col gap-3">
            <Label text="Name"><input className={inputClass} autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Label>
            <Button
              kind="primary"
              disabled={!name.trim()}
              onClick={async () => {
                await vault.update(folderId, { ...folder.body, title: name.trim() });
                vault.sync().catch(() => undefined);
                bump();
                setRenaming(false);
              }}
            >
              Save
            </Button>
          </div>
        </Modal>
      )}
    </span>
  );
}

/** Everything that happens with the kit: first run, picked up after a reload, and after a
 *  new Secret Key. Download it, then prove it by typing its last group. */
export function KitGate({ onDone, username, fresh }: { onDone: () => void; username?: string; fresh?: boolean }) {
  const { vault, platform } = useVault();
  const [encoded, setEncoded] = useState("");
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  // A broken or hostile server mustn't be able to wall off the vault on this device.
  const [couldntTell, setCouldntTell] = useState(false);
  useEffect(() => {
    void (async () => {
      const raw = await vault.loadSecretKey();
      if (raw) {
        setEncoded(await encodeSecretKey(raw));
        raw.fill(0);
      }
    })();
  }, [vault]);
  return (
    <Modal title={fresh ? "Your new recovery kit" : "Save your recovery kit"} onClose={() => undefined}>
      <div data-testid="kit-gate" className="flex flex-col gap-3 text-sm text-[var(--text)]">
        <Callout kind="danger">
          {fresh ? "Your old kit no longer works. Keep this one instead." : "You haven't confirmed saving your kit yet."} If you forget your master password and don't have this, your vault is gone for good. Nobody can get it back for you.
        </Callout>
        <p className="break-all rounded border border-[var(--border)] p-2 text-center font-mono text-sm" data-testid="secret-key">{encoded}</p>
        <Button
          onClick={() => {
            downloadBlob(buildKitPdf({ secretKey: encoded, serverUrl: platform.baseUrl, username: username ?? "", createdOn: new Date().toISOString().slice(0, 10) }), "Promptly-Recovery-Kit.pdf", "application/pdf");
            setSaved(true);
          }}
        >
          Download my kit
        </Button>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I've saved or printed it somewhere safe
        </label>
        <Label text="Last group of your Secret Key">
          <input className={inputClass} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Label>
        {error && <Callout kind="danger">{error}</Callout>}
        <Button
          kind="primary"
          disabled={!saved || !typed}
          onClick={async () => {
            if (typed.trim().toUpperCase() !== lastGroup(encoded)) return setError("That's not the last group. Look at your kit again.");
            try {
              await vault.api.confirmKit();
              onDone();
            } catch (e) {
              setError(errorText(e));
              setCouldntTell(true);
            }
          }}
        >
          Done
        </Button>
        {couldntTell && <Button onClick={onDone}>Carry on for now</Button>}
      </div>
    </Modal>
  );
}

/** Things that need a look, on any screen. */
export function MainNotices({ onNeedKit }: { onNeedKit: () => void }) {
  const { vault, version, go, route } = useVault();
  const [due, setDue] = useState(false);
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const s = await vault.api.request<SurvivalOut>("GET", "/survival");
        const checked = await vault.store.getMeta<string>("recovery_checked");
        if (!live) return;
        if (!s.kit_confirmed) onNeedKit();
        setDue(recoveryDue(s.kit_confirmed_at, checked ?? null));
        setRequests((await vault.api.deviceRequests()).length);
      } catch {
        /* offline: the Security check says what it can */
      }
    };
    void check();
    const t = setInterval(check, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [vault, onNeedKit]);
  void version;
  const changed = [...vault.keyChanges.values()];
  return (
    <>
      {requests > 0 && route !== "devices" && (
        <div className="p-2"><Callout kind="warn"><span data-testid="request-notice">A new device wants to join your vault.</span> <Button small onClick={() => go("devices")}>Review</Button></Callout></div>
      )}
      {changed.length > 0 && route !== "shared" && (
        <div className="p-2"><Callout kind="warn">A shared vault can't open, because someone's keys changed. <Button small onClick={() => go("shared")}>Look at it</Button></Callout></div>
      )}
      {due && route !== "security" && (
        <div className="p-2"><Callout>Time to check you still have your recovery kit. <Button small onClick={() => go("security")}>Check</Button></Callout></div>
      )}
    </>
  );
}

function recoveryDue(kitAt: string | null | undefined, checked: string | null): boolean {
  const times = [kitAt, checked].filter(Boolean).map((t) => new Date(t as string).getTime());
  if (!times.length) return false;
  return Date.now() - Math.max(...times) > RECOVERY_CHECK_DAYS * 86_400_000;
}

/** Someone who shared with you has new keys. Their vault stays shut until you've looked. */
export function KeyChanges({ onChange }: { onChange: () => void }) {
  const { vault, bump } = useVault();
  const changed = [...vault.keyChanges.entries()];
  if (!changed.length) return null;
  return (
    <section data-testid="key-changes" className="flex flex-col gap-2">
      {changed.map(([vaultId, e]) => (
        <Callout key={vaultId} kind="danger">
          <p className="mb-2">{e.username || "Someone"}'s keys changed, so a vault they shared with you won't open. They may have reset their vault, or something may be wrong with the server. Check with them directly, and compare safety words.</p>
          <Button
            small
            onClick={async () => {
              await vault.acceptChangedKey(e.userId);
              await vault.reload();
              await vault.sync().catch(() => undefined);
              bump();
              onChange();
            }}
          >
            I've checked, use the new keys
          </Button>
        </Callout>
      ))}
    </section>
  );
}

export function ExpiryReminder({ item }: { item: Item }) {
  const { vault, bump, toast } = useVault();
  const [busy, setBusy] = useState(false);
  if (item.body.remindExpiry) return <p className="text-xs text-[var(--text-muted)]">A reminder is on your Calendar for {item.body.expiresOn}.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        small
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await vault.api.request("POST", "/reminder", { on: item.body.expiresOn });
            await vault.update(item.id, { ...vault.get(item.id)!.body, remindExpiry: true });
            vault.sync().catch(() => undefined);
            bump();
            toast("Reminder added");
          } catch (e) {
            toast(errorText(e), "err");
          } finally {
            setBusy(false);
          }
        }}
      >
        Remind me in Calendar
      </Button>
      <span className="text-xs text-[var(--text-muted)]">It'll just say "Document expires soon", since Calendar isn't end-to-end encrypted.</span>
    </div>
  );
}

/** Stronger stretching, or a whole new Secret Key. */
export function KeysPanel() {
  const { vault, toast, platform } = useVault();
  const [account, setAccount] = useState<{ kdf: { m: number; t: number; p: number; alg: "argon2id" } } | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newKit, setNewKit] = useState(false);
  const load = useCallback(() => vault.store.getAccount().then((a) => setAccount(a ?? null)), [vault]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!account) return null;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    await new Promise((r) => setTimeout(r, 30));
    try {
      await fn();
      await platform.hello?.disable().catch(() => undefined);
      await vault.store.setMeta("hello_enabled", false);
      platform.pin?.clear();
      setPw("");
      await load();
      toast(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const mib = Math.round(account.kdf.m / 1024);
  return (
    <div data-testid="keys" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--text)]">Your keys</h2>
      <p className="text-xs text-[var(--text-muted)]">Your master password is stretched with {mib} MiB of memory and {account.kdf.t} passes. Higher is harder to guess at, and slower to unlock on older devices.</p>
      {vault.kdfBelowMinimum(account) && <Callout kind="warn">Your server now asks for stronger settings than this vault uses.</Callout>}
      <Label text="Master password, to change either of these">
        <input className={inputClass} type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </Label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!pw || busy} onClick={() => run(() => vault.upgradeKdf(pw, { ...account.kdf, m: Math.min(account.kdf.m * 2, 1048576) }), "Stronger settings saved")}>Use more memory</Button>
        <Button
          disabled={!pw || busy}
          onClick={() => {
            if (!confirm("Make a new Secret Key? Your old kit stops working, and every other device has to join again.")) return;
            void run(async () => {
              const fresh = await vault.rotateSecretKey(pw);
              fresh.fill(0);
              setNewKit(true);
            }, "New Secret Key made");
          }}
        >
          Make a new Secret Key
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">A new Secret Key is for when an old kit may have been seen: the old kit stops working with your server. Your identity keys stay the same, so if someone also has your master password and an old copy of your vault's data, this won't stop them. Unlocking with Windows Hello, a PIN or a passkey has to be set up again after either change.</p>
      {error && <Callout kind="danger">{error}</Callout>}
      {newKit && <KitGate fresh onDone={() => setNewKit(false)} />}
    </div>
  );
}
