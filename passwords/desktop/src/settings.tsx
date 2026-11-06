// Settings that only make sense on this computer. Opened from the App menu and the tray.
import { useEffect, useRef, useState } from "react";

import { Button, Callout, errorText, inputClass, Label, Modal } from "../../../frontend/src/passwords/ui/kit";
import { type BackupStatus, native, type SshStatus } from "./native";
import type { Shell } from "./shell";

function when(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : "never";
}

function HelloSection({ shell }: { shell: Shell }) {
  const [status, setStatus] = useState<{ available: boolean; enabled: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => native.helloStatus().then(setStatus);
  useEffect(() => {
    refresh();
  }, []);
  if (!status) return null;
  if (!status.available) return <p className="text-sm text-[var(--text-muted)]">Windows Hello isn't set up on this computer.</p>;
  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30));
    try {
      const raw = await shell.vault.exportUnlockSecret(password);
      await native.helloEnable(raw);
      raw.fill(0);
      await shell.store.setMeta("hello_enabled", true);
      setPassword("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error && /decrypt|operation/i.test(err.message + err.name) ? "That master password isn't right." : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return status.enabled ? (
    <div className="flex items-center justify-between gap-2 text-sm text-[var(--text)]">
      <span data-testid="hello-on">Windows Hello unlock is on.</span>
      <Button
        small
        onClick={async () => {
          await native.helloDisable();
          await shell.store.setMeta("hello_enabled", false);
          await refresh();
        }}
      >
        Turn off
      </Button>
    </div>
  ) : (
    <form onSubmit={enable} className="flex flex-col gap-2">
      <Label text="Master password" hint="Hello is a convenience: it stands in for typing this, on this Windows account. It isn't stronger than your Windows sign-in.">
        <input className={inputClass} type="password" autoComplete="current-password" aria-label="Master password for Hello" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Label>
      {error && <Callout kind="danger">{error}</Callout>}
      <Button kind="primary" type="submit" className="w-fit" disabled={busy || !password}>Turn on Windows Hello</Button>
    </form>
  );
}

function BackupSection({ shell }: { shell: Shell }) {
  const [s, setS] = useState<BackupStatus | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const refresh = () => native.backupStatus().then(setS);
  // A field's blur and a checkbox click arrive together. One at a time, each from what's saved.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    refresh();
  }, []);
  if (!s) return null;
  const save = (next: Partial<BackupStatus>) => {
    saving.current = saving.current.then(async () => {
      setError("");
      try {
        const merged = { ...(await native.backupStatus()), ...next };
        await native.backupConfigure(merged.enabled, merged.dir, merged.every_hours, merged.keep);
        await refresh();
      } catch (e) {
        setError(errorText(e));
      }
    });
    return saving.current;
  };
  const setPw = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== again) return setError("Those two don't match.");
    await native.backupPasswordSet(password);
    setPassword("");
    setAgain("");
    setNote("Backup password saved. Write it down: you'll need it to open a backup on another computer.");
    await refresh();
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--text-muted)]">An encrypted file on this computer, made on a schedule while the vault's unlocked. It covers items, not file attachments. Keep a copy somewhere off this machine.</p>
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input type="checkbox" aria-label="Back up on a schedule" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Back up on a schedule
      </label>
      <Label text="Folder">
        <input className={inputClass} aria-label="Backup folder" defaultValue={s.dir} onBlur={(e) => save({ dir: e.target.value })} />
      </Label>
      <div className="flex gap-2">
        <Label text="How often">
          <select className={inputClass} aria-label="How often" value={s.every_hours} onChange={(e) => save({ every_hours: Number(e.target.value) })}>
            <option value={24}>Daily</option>
            <option value={168}>Weekly</option>
          </select>
        </Label>
        <Label text="Files to keep">
          <input className={inputClass} type="number" min={1} max={365} value={s.keep} onChange={(e) => save({ keep: Number(e.target.value) || 14 })} />
        </Label>
      </div>
      <form onSubmit={setPw} className="flex flex-col gap-2">
        <Label text={s.has_password ? "Change the backup password" : "Backup password"} hint="Separate from your master password. It's kept on this computer, wrapped to your Windows account, so backups can run unattended.">
          <input className={inputClass} type="password" autoComplete="new-password" aria-label="Backup password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Label>
        <Label text="Type it again">
          <input className={inputClass} type="password" autoComplete="new-password" aria-label="Backup password again" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Label>
        <Button type="submit" className="w-fit" disabled={!password}>Save password</Button>
      </form>
      <div className="flex items-center gap-2">
        <Button
          kind="primary"
          disabled={!s.has_password || !shell.vault.unlocked}
          onClick={async () => {
            setError("");
            setNote("");
            try {
              const path = await shell.runBackup(true);
              setNote(path ? `Saved to ${path}` : "");
              await refresh();
            } catch (e) {
              setError(errorText(e));
              await refresh();
            }
          }}
        >
          Back up now
        </Button>
        <span data-testid="backup-last" className="text-xs text-[var(--text-muted)]">Last backup: {when(s.last_run_ms)}</span>
      </div>
      {note && <Callout><span data-testid="backup-note">{note}</span></Callout>}
      {(error || s.last_error) && <Callout kind="danger">{error || s.last_error}</Callout>}
    </div>
  );
}

function BrowserSection() {
  const [ids, setIds] = useState("");
  const [on, setOn] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    native.nativeHostStatus().then((s) => {
      setIds(s.extension_ids.join("\n"));
      setOn(s.extension_ids.length > 0);
    });
  }, []);
  const save = async () => {
    setError("");
    setNote("");
    try {
      const list = ids.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      await native.nativeHostSet(true, list);
      setOn(list.length > 0);
      setNote(list.length ? "Done. Firefox and these extension ids can use Windows Hello." : "Done. Firefox can use Windows Hello.");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--text-muted)]">Lets the browser extension unlock with Windows Hello through this app's helper. Only the extensions listed here can use it. Chrome and Edge show an extension's id on their extensions page.</p>
      <Label text="Chrome or Edge extension ids, one per line">
        <textarea className={`${inputClass} font-mono`} rows={2} aria-label="Extension ids" spellCheck={false} value={ids} onChange={(e) => setIds(e.target.value)} />
      </Label>
      <div className="flex gap-2">
        <Button className="w-fit" onClick={save}>Save</Button>
        {on && <Button className="w-fit" onClick={() => native.nativeHostSet(false, []).then(() => { setOn(false); setIds(""); setNote("Removed."); }).catch((e) => setError(errorText(e)))}>Remove</Button>}
      </div>
      {note && <Callout>{note}</Callout>}
      {error && <Callout kind="danger">{error}</Callout>}
    </div>
  );
}

function SshSection() {
  const [s, setS] = useState<SshStatus | null>(null);
  useEffect(() => {
    native.sshStatus().then(setS);
  }, []);
  if (!s) return null;
  return (
    <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
      <label className="flex items-center gap-2">
        <input type="checkbox" aria-label="SSH agent" checked={s.enabled} onChange={(e) => native.sshSet(e.target.checked).then(setS)} /> Answer SSH on Windows's agent pipe
      </label>
      <p className="text-[var(--text-muted)]">Offers Ed25519 keys from your SSH items that have no passphrase, while the vault's unlocked. You're asked every time something wants to use one. Items set to ask for your master password aren't offered.</p>
      {s.running && <p data-testid="ssh-running" className="text-[var(--text-muted)]">Running.</p>}
      {s.error && <Callout kind="warn">{s.error}</Callout>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
      {children}
    </section>
  );
}

export function DesktopSettings({ shell, server, onClose, onDisconnect }: { shell: Shell; server: string; onClose: () => void; onDisconnect: () => void }) {
  const [autostart, setAutostart] = useState(false);
  const [updater, setUpdater] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    native.autostartGet().then(setAutostart);
    native.updaterStatus().then(setUpdater);
  }, []);
  return (
    <Modal title="Desktop settings" onClose={onClose} wide>
      <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto pr-1">
        <label className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" aria-label="Start with Windows" checked={autostart} onChange={(e) => native.autostartSet(e.target.checked).then(() => setAutostart(e.target.checked))} /> Start with Windows, in the tray
        </label>
        <p className="text-sm text-[var(--text-muted)]">Quick search: press Ctrl+Shift+Space anywhere. Closing this window keeps the app running in the tray; Quit is in the tray menu.</p>
        <Section title="Windows Hello"><HelloSection shell={shell} /></Section>
        <Section title="Backup"><BackupSection shell={shell} /></Section>
        <Section title="Browser extension"><BrowserSection /></Section>
        <Section title="SSH agent"><SshSection /></Section>
        <Section title="Updates">
          <p data-testid="updates" className="text-sm text-[var(--text-muted)]">{updater ? "Check from the tray menu." : "Automatic updates are off in this build. Get new versions from your server's Downloads."}</p>
        </Section>
        <Section title="This computer">
          <p className="text-sm text-[var(--text-muted)]">Connected to {server}.</p>
          {!confirming ? (
            <Button kind="danger" className="w-fit" onClick={() => setConfirming(true)}>Disconnect this computer…</Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Callout kind="warn">This removes the vault's copy and the sign-in from this computer. Your vault stays on the server. You'll need your Secret Key or another device to come back.</Callout>
              <Button kind="danger" className="w-fit" onClick={onDisconnect}>Yes, disconnect</Button>
            </div>
          )}
        </Section>
      </div>
    </Modal>
  );
}
