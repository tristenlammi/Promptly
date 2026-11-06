// Import and export. Files are read here, on this device. They are never uploaded.
import { useState } from "react";

import { encryptedExport, plainCsvExport, plainJsonExport } from "../core/exporter";
import { AFTER_IMPORT, dedupe, type Imported, importFile, type ImportResult, NeedsPasswordError } from "../core/importers";
import { newBody } from "../core/model";
import { Button, Callout, errorText, inputClass, Label, Modal, Spinner, useVault } from "./kit";
import { downloadBlob } from "./Onboarding";
import { decodeQrFile, scanQrFromCamera } from "./qr";

export function TransferScreen() {
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-lg font-semibold text-[var(--text)]">Import and export</h1>
      <ImportPanel />
      <ExportPanel />
    </section>
  );
}

function ImportPanel() {
  const { vault, bump, toast } = useVault();
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [password, setPassword] = useState("");
  const [needPw, setNeedPw] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fresh, setFresh] = useState<Imported[]>([]);
  const [dupes, setDupes] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const read = async (f: { name: string; bytes: Uint8Array }, pw?: string) => {
    setError("");
    setNeedPw("");
    setBusy("Reading…");
    await new Promise((r) => setTimeout(r, 20));
    try {
      const r = await importFile(f.name, f.bytes, pw);
      const { fresh: fr, duplicates } = dedupe(r.items, vault.allItems({ includeDeleted: false }).map((i) => i.body));
      setResult(r);
      setFresh(fr);
      setDupes(duplicates);
    } catch (e) {
      if (e instanceof NeedsPasswordError) setNeedPw(e.format);
      else setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setResult(null);
    setDone(null);
    const loaded = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    setFile(loaded);
    read(loaded);
  };

  /** A transfer QR from Google Authenticator, from a picture of it or the camera. */
  const fromQr = async (text: string | null) => {
    if (!text) return setError("No QR code found there.");
    if (!text.startsWith("otpauth-migration://") && !text.startsWith("otpauth://")) return setError("That QR code isn't a 2FA transfer code.");
    setResult(null);
    setDone(null);
    const loaded = { name: "authenticator-transfer.txt", bytes: new TextEncoder().encode(text) };
    setFile(loaded);
    await read(loaded);
  };

  const commit = async () => {
    setBusy("Encrypting and saving…");
    await new Promise((r) => setTimeout(r, 20));
    try {
      const vid = await vault.personalVaultId();
      const folders = new Map(vault.allItems({ includeSystem: true }).filter((i) => i.body.kind === "folder").map((i) => [i.body.title, i.id]));
      for (const name of new Set(fresh.map((i) => i.folder).filter((x): x is string => !!x))) {
        if (!folders.has(name)) folders.set(name, (await vault.saveNew(vid, newBody("folder", name))).id);
      }
      for (let i = 0; i < fresh.length; i++) {
        const it = fresh[i];
        await vault.saveNew(vid, { ...it.body, folderId: it.folder ? folders.get(it.folder) : it.body.folderId ?? null });
        if (i % 25 === 0) setBusy(`Saved ${i + 1} of ${fresh.length}…`);
      }
      await vault.sync();
      bump();
      toast(`Imported ${fresh.length} items`);
      setDone(AFTER_IMPORT[result?.format ?? ""] ?? "");
      setResult(null);
      setFile(null);
      setPassword("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">Import</h2>
      <p className="text-sm text-[var(--text-muted)]">From Chrome, Edge, Firefox, Google Password Manager, Bitwarden, 1Password, LastPass, Dashlane, Proton Pass, Apple Passwords, KeePass, a Credential Exchange file, Aegis or 2FAS. The file stays on this device.</p>
      <input aria-label="Choose a file to import" type="file" className="text-sm text-[var(--text)]" onChange={(e) => choose(e.target.files?.[0])} />
      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text)]">
        <span>A 2FA transfer QR, from Google Authenticator:</span>
        <label className="inline-flex cursor-pointer items-center rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium">
          From a QR image
          <input aria-label="From a QR image" type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) await fromQr(await decodeQrFile(f)); }} />
        </label>
        <button type="button" className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium" onClick={() => { void scanQrFromCamera().then((t) => { if (t) void fromQr(t); }); }}>Scan with camera</button>
      </div>
      {needPw && file && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            read(file, password);
          }}
        >
          <Label text={`This ${needPw} file has a password`}>
            <input className={inputClass} type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
          <Button kind="primary" type="submit" className="w-fit">Open it</Button>
        </form>
      )}
      {busy && <Spinner label={busy} />}
      {error && <Callout kind="danger">{error}</Callout>}
      {result && !busy && (
        <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <p data-testid="import-summary" className="text-sm font-medium text-[var(--text)]">
            {result.format}: {fresh.length} to import{dupes ? `, ${dupes} already here` : ""}.
          </p>
          {result.warnings.length > 0 && (
            <Callout kind="warn">
              <ul className="list-disc pl-4">{result.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>
              {result.warnings.length > 20 && <p>…and {result.warnings.length - 20} more.</p>}
            </Callout>
          )}
          <ul className="max-h-64 overflow-auto text-sm text-[var(--text)]">
            {fresh.slice(0, 200).map((it, i) => (
              <li key={i} className="truncate border-b border-[var(--border)] py-1 last:border-0">{it.body.title} <span className="text-xs text-[var(--text-muted)]">{it.body.kind}{it.body.username ? ` · ${it.body.username}` : ""}</span></li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button kind="primary" onClick={commit} disabled={!fresh.length}>Import {fresh.length}</Button>
            <Button onClick={() => { setResult(null); setFile(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      {done !== null && (
        <Callout>
          <p className="font-medium">Done. Delete the file you imported from: it isn't encrypted.</p>
          {done && <p className="mt-1">{done}</p>}
        </Callout>
      )}
    </div>
  );
}

function ExportPanel() {
  const { vault, platform } = useVault();
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [plainOpen, setPlainOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const stamp = () => new Date().toISOString().slice(0, 10);

  const encrypted = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (pw.length < 10) return setError("Use at least 10 characters.");
    if (pw !== again) return setError("Those two don't match.");
    setBusy(true);
    await new Promise((r) => setTimeout(r, 20));
    try {
      downloadBlob(await encryptedExport(vault.exportable(), pw), `promptly-vault-${stamp()}.json`, "application/json");
      platform.api.noteExport().catch(() => undefined);
      setPw("");
      setAgain("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const plain = (kind: "csv" | "json") => {
    const items = vault.exportable();
    if (kind === "csv") downloadBlob(plainCsvExport(items), `promptly-vault-${stamp()}.csv`, "text/csv");
    else downloadBlob(plainJsonExport(items), `promptly-vault-${stamp()}.json`, "application/json");
    platform.api.noteExport().catch(() => undefined);
    setPlainOpen(false);
    setTyped("");
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">Export</h2>
      <form onSubmit={encrypted} className="flex flex-col gap-2">
        <p className="text-sm text-[var(--text-muted)]">An encrypted file with its own password. Keep it somewhere safe as a backup. Even if your server's gone, it opens here.</p>
        <Label text="Password for this file"><input className={inputClass} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Label>
        <Label text="Type it again"><input className={inputClass} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Label>
        {error && <Callout kind="danger">{error}</Callout>}
        <Button kind="primary" type="submit" className="w-fit" disabled={busy}>Export encrypted file</Button>
      </form>
      <Button className="w-fit" onClick={() => setPlainOpen(true)}>Export without encryption…</Button>
      {plainOpen && (
        <Modal title="Export without encryption?" onClose={() => setPlainOpen(false)}>
          <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
            <Callout kind="danger">This makes a file with all your passwords in plain text. Anyone who gets it can read them. Delete it as soon as you're done, and empty your trash.</Callout>
            <Label text="Type EXPORT to go on"><input className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} /></Label>
            <div className="flex gap-2">
              <Button kind="danger" disabled={typed !== "EXPORT"} onClick={() => plain("csv")}>Logins as CSV</Button>
              <Button kind="danger" disabled={typed !== "EXPORT"} onClick={() => plain("json")}>Everything as JSON</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
