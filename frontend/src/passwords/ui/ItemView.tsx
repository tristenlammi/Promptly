// One item, read-only, with copy buttons. Secrets stay as dots until asked for.
import { b64u, randomBytes, randomUuid } from "../core/bytes";
import { ChangePassword, ClockWarning, ExpiryReminder, FromFiles } from "./Connections";
import { ArchiveRestore, Archive, Download, ExternalLink, History, Pencil, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { downloadAttachment, uploadAttachment } from "../core/attachments";
import type { AttachmentRef, Item, ItemBody } from "../core/model";
import { downloadBlob } from "./Onboarding";
import { periodOf, secondsLeft, toOtpauth, totpCode } from "../core/totp";
import { ItemEditor, KIND_LABEL } from "./ItemEditor";
import { Button, Callout, CopyButton, errorText, IconButton, inputClass, Label, Modal, PlainRow, safeHref, SecretRow, useVault } from "./kit";
import { QrImage } from "./qr";


export function TotpRow({ cfg, label = "2FA code" }: { cfg: NonNullable<ItemBody["totp"]>; label?: string }) {
  const { copy, vault } = useVault();
  const [code, setCode] = useState("");
  const [left, setLeft] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const now = Date.now();
      try {
        const c = await totpCode(cfg, now);
        if (live) {
          setCode(c);
          setLeft(secondsLeft(cfg, now));
        }
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [cfg, vault]);
  if (error) return <PlainRow label={label} value={error} copyable={false} />;
  // (clock drift is shown once, at the top of the 2FA codes screen and on the item.)
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] py-2 last:border-0">
      <div>
        <div className="text-xs text-[var(--text-muted)]">{label}</div>
        <div className="font-mono text-lg tracking-wide text-[var(--text)]" data-testid="totp-code">{pretty}</div>
      </div>
      <div className="flex items-center gap-2">
        <span aria-label={`${left} seconds left`} className="text-xs tabular-nums text-[var(--text-muted)]">{left}s / {periodOf(cfg)}s</span>
        <CopyButton label={label} value={code} onCopy={() => copy(code, label, true)} />
      </div>
    </div>
  );
}

/** Ask for the master password again for items marked "reprompt". It's checked
 *  locally against the wrapped keyset, with no server involved. */
export function Reprompt({ onPass, onCancel }: { onPass: () => void; onCancel: () => void }) {
  const { vault } = useVault();
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    await new Promise((r) => setTimeout(r, 30));
    if (await vault.checkPassword(pw)) onPass();
    else setError("That isn't your master password.");
    setBusy(false);
  };
  return (
    <Modal title="Confirm it's you" onClose={onCancel}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Label text="Master password">
          <input className={inputClass} type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Label>
        {error && <Callout kind="danger">{error}</Callout>}
        <Button kind="primary" type="submit" disabled={busy || !pw}>Continue</Button>
      </form>
    </Modal>
  );
}

function wifiQr(b: ItemBody): string {
  const esc = (s: string) => s.replace(/([\\;,":])/g, "\\$1");
  return `WIFI:T:${b.wifiSecurity ?? "WPA"};S:${esc(b.ssid ?? "")};P:${esc(b.wifiPassword ?? "")};;`;
}

function History_({ item, onClose, onRestore }: { item: Item; onClose: () => void; onRestore: (b: ItemBody) => void }) {
  const { vault } = useVault();
  const [versions, setVersions] = useState<{ revision: number; createdAt: string; body: ItemBody }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    vault.versions(item.id).then(setVersions).catch((e) => setError(errorText(e)));
  }, [vault, item.id]);
  return (
    <Modal title="History" onClose={onClose} wide>
      {(item.body.passwordHistory?.length ?? 0) > 0 && (
        <section className="mb-4">
          <h3 className="mb-1 text-sm font-medium text-[var(--text)]">Earlier passwords</h3>
          {item.body.passwordHistory!.map((h, i) => (
            <SecretRow key={i} label={new Date(h.at).toLocaleString()} value={h.password} what="Old password" />
          ))}
        </section>
      )}
      <h3 className="mb-1 text-sm font-medium text-[var(--text)]">Earlier versions</h3>
      {error && <Callout kind="danger">{error}</Callout>}
      {versions === null && !error && <p className="text-sm text-[var(--text-muted)]">Loading…</p>}
      {versions?.length === 0 && <p className="text-sm text-[var(--text-muted)]">No earlier versions.</p>}
      <ul className="flex flex-col gap-1">
        {versions?.map((v) => (
          <li key={v.revision} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-2 text-sm text-[var(--text)]">
            <span>{new Date(v.createdAt).toLocaleString()} · {v.body.title}</span>
            <Button small onClick={() => onRestore(v.body)}>Restore</Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function ConflictPicker({ item }: { item: Item }) {
  const { vault, bump, toast } = useVault();
  const conflicts = item.body.conflicts ?? [];
  if (!conflicts.length) return null;
  const drop = async (i: number, use: boolean) => {
    const c = conflicts[i];
    const rest = conflicts.filter((_, n) => n !== i);
    const next: ItemBody = use ? ({ ...(c.body as ItemBody), createdAt: item.body.createdAt, updatedAt: item.body.updatedAt, conflicts: rest } as ItemBody) : { ...item.body, conflicts: rest };
    if (!next.conflicts?.length) delete next.conflicts;
    await vault.update(item.id, next);
    vault.sync().catch(() => undefined);
    bump();
    toast("Saved");
  };
  return (
    <Callout kind="warn">
      <div className="mb-1 font-medium">Conflict: pick one</div>
      <p className="mb-2 text-xs">This was changed in two places at once. What's shown is one version; nothing was lost.</p>
      {conflicts.map((c, i) => {
        const b = c.body as ItemBody;
        return (
          <div key={i} className="mb-2 rounded-lg border border-[var(--border)] p-2">
            <div className="text-xs text-[var(--text-muted)]">Other version, {new Date(c.at).toLocaleString()}</div>
            {b.username !== undefined && <div className="text-sm">Username: {b.username}</div>}
            {b.password !== undefined && <SecretRow label="Password" value={String(b.password)} />}
            {b.notes !== undefined && <div className="text-sm">Notes: {b.notes}</div>}
            <div className="mt-1 flex gap-2">
              <Button small kind="primary" onClick={() => drop(i, true)}>Use this one</Button>
              <Button small onClick={() => drop(i, false)}>Keep what's shown</Button>
            </div>
          </div>
        );
      })}
    </Callout>
  );
}

function Attachments({ item, canEdit }: { item: Item; canEdit: boolean }) {
  const { vault, platform, bump, toast } = useVault();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const list = item.body.attachments ?? [];

  const add = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setBusy(`Encrypting ${file.name}…`);
    try {
      await vault.sync();
      // An interrupted upload picks up where it stopped, if the same file's chosen again.
      const resumeName = `upload_resume:${item.id}:${file.name}:${file.size}`;
      let resume = await vault.getDeviceSealed<{ id: string; key: string }>(resumeName).catch(() => null);
      if (!resume) {
        resume = { id: randomUuid(), key: b64u(randomBytes(32)) };
        await vault.putDeviceSealed(resumeName, resume);
      }
      const ref = await uploadAttachment(platform.api, item.vaultId, item.id, file, (d, t) => setBusy(`Uploading ${file.name}: ${d} of ${t} MB`), resume);
      await vault.store.deleteMeta(resumeName);
      const fresh = vault.get(item.id)!;
      await vault.update(item.id, { ...fresh.body, attachments: [...(fresh.body.attachments ?? []), ref] });
      await vault.sync();
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const get = async (ref: AttachmentRef) => {
    setError("");
    setBusy(`Downloading ${ref.name}…`);
    try {
      const data = await downloadAttachment(platform.api, item.vaultId, item.id, ref);
      downloadBlob(data, ref.name, "application/octet-stream");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const remove = async (ref: AttachmentRef) => {
    try {
      await platform.api.attachmentDelete(item.vaultId, ref.id);
    } catch {
      /* the file row goes either way; a sweep catches a stray */
    }
    await vault.update(item.id, { ...item.body, attachments: list.filter((a) => a.id !== ref.id) });
    vault.sync().catch(() => undefined);
    bump();
    toast("Attachment removed");
  };

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-[var(--text-muted)]">Attachments</h3>
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-2 text-sm text-[var(--text)]">
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          <span className="text-xs text-[var(--text-muted)]">{(a.size / 1048576).toFixed(1)} MB</span>
          <IconButton label={`Download ${a.name}`} onClick={() => get(a)}><Download className="h-4 w-4" /></IconButton>
          {canEdit && <IconButton label={`Remove ${a.name}`} onClick={() => remove(a)}><Trash2 className="h-4 w-4" /></IconButton>}
        </div>
      ))}
      {canEdit && <Button small className="w-fit" onClick={() => setPicking(true)}>Add from Files</Button>}
      {picking && <FromFiles item={item} onClose={() => setPicking(false)} />}
      {canEdit && (
        <label className="w-fit cursor-pointer rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-1)]">
          Attach a file
          <input type="file" aria-label="Attach a file" className="hidden" onChange={(e) => add(e.target.files?.[0])} />
        </label>
      )}
      {busy && <p className="text-xs text-[var(--text-muted)]">{busy}</p>}
      {error && <Callout kind="danger">{error}</Callout>}
    </section>
  );
}

export function ItemView({ item, onClosed }: { item: Item; onClosed: () => void }) {
  const { vault, bump, toast } = useVault();
  const [editing, setEditing] = useState(false);
  const [restoring, setRestoring] = useState<ItemBody | null>(null);
  const [history, setHistory] = useState(false);
  const [passed, setPassed] = useState(false);
  const b = item.body;
  useEffect(() => setPassed(false), [item.id]);
  const [role, setRole] = useState<string>("manage");
  useEffect(() => {
    vault.vaults().then((vs) => setRole(vs.find((v) => v.id === item.vaultId)?.role ?? "view"));
  }, [vault, item.vaultId]);
  const canEdit = role === "manage" || role === "edit";
  const fillOnly = role === "fill";
  const [changing, setChanging] = useState(false);

  const save = async (next: ItemBody) => {
    await vault.update(item.id, next);
    vault.sync().catch(() => undefined);
    bump();
  };

  const remove = async () => {
    await vault.trashItem(item.id);
    vault.sync().catch(() => undefined);
    toast("Moved to Trash");
    bump();
    onClosed();
  };

  const secretFields = useMemo(() => {
    const rows: { label: string; value: string }[] = [];
    if (b.cardNumber) rows.push({ label: "Card number", value: b.cardNumber });
    if (b.cardCvv) rows.push({ label: "Security code", value: b.cardCvv });
    if (b.apiKey) rows.push({ label: "Key", value: b.apiKey });
    if (b.apiSecret) rows.push({ label: "Secret", value: b.apiSecret });
    if (b.wifiPassword) rows.push({ label: "Password", value: b.wifiPassword });
    if (b.sshPrivate) rows.push({ label: "Private key", value: b.sshPrivate });
    if (b.accountNumber) rows.push({ label: "Account number", value: b.accountNumber });
    if (b.iban) rows.push({ label: "IBAN", value: b.iban });
    if (b.documentNumber) rows.push({ label: "Number", value: b.documentNumber });
    return rows;
  }, [b]);

  if (editing || restoring) {
    return (
      <ItemEditor
        id={item.id}
        vaultId={item.vaultId}
        initial={restoring ?? b}
        onCancel={() => {
          setEditing(false);
          setRestoring(null);
        }}
        onDone={() => {
          setEditing(false);
          setRestoring(null);
          bump();
          toast("Saved");
        }}
      />
    );
  }

  if (b.reprompt && !passed) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-[var(--text)]">{b.title}</h2>
        <p className="text-sm text-[var(--text-muted)]">This item asks for your master password first.</p>
        <Reprompt onPass={() => setPassed(true)} onCancel={onClosed} />
      </div>
    );
  }

  return (
    <article className="flex flex-col gap-3" aria-label={b.title}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold text-[var(--text)]">{b.title}</h2>
          <div className="text-xs text-[var(--text-muted)]">{KIND_LABEL[b.kind] ?? b.kind}{b.tags?.length ? ` · ${b.tags.join(", ")}` : ""}</div>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label={b.favorite ? "Remove from favourites" : "Add to favourites"} disabled={!canEdit} onClick={() => save({ ...b, favorite: !b.favorite })}>
            <Star className={`h-4 w-4 ${b.favorite ? "fill-[var(--accent)] text-[var(--accent)]" : ""}`} />
          </IconButton>
          {!fillOnly && <IconButton label="History" onClick={() => setHistory(true)}><History className="h-4 w-4" /></IconButton>}
          <IconButton label={b.archived ? "Take out of archive" : "Archive"} disabled={!canEdit} onClick={() => save({ ...b, archived: !b.archived })}>
            {b.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
          </IconButton>
          {canEdit && !fillOnly && b.kind === "login" && b.password && <Button small onClick={() => setChanging(true)}>{b.pendingPassword ? "Finish changing password" : "Change password"}</Button>}
          {changing && <ChangePassword item={item} onDone={() => setChanging(false)} />}
          <IconButton label="Edit" disabled={!canEdit} onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></IconButton>
          <IconButton label="Move to Trash" disabled={!canEdit} onClick={remove}><Trash2 className="h-4 w-4" /></IconButton>
        </div>
      </header>

      <ConflictPicker item={item} />
      {fillOnly && <Callout>This vault lets you fill passwords but not see them. It isn't secure against a determined member: their device holds the key.</Callout>}

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3">
        {b.username && <PlainRow label="Username" value={b.username} />}
        {b.password && !fillOnly && <SecretRow label="Password" value={b.password} />}
        {b.totp && !fillOnly && <TotpRow cfg={b.totp} />}
        {b.cardholder && <PlainRow label="Name on card" value={b.cardholder} />}
        {(b.cardExpMonth || b.cardExpYear) && <PlainRow label="Expires" value={`${b.cardExpMonth ?? ""}/${b.cardExpYear ?? ""}`} />}
        {b.cardBrand && <PlainRow label="Brand" value={b.cardBrand} copyable={false} />}
        {(b.firstName || b.lastName) && <PlainRow label="Name" value={[b.firstName, b.middleName, b.lastName].filter(Boolean).join(" ")} />}
        {b.email && <PlainRow label="Email" value={b.email} />}
        {b.phone && <PlainRow label="Phone" value={b.phone} />}
        {b.company && <PlainRow label="Company" value={b.company} />}
        {(b.address1 || b.city) && <PlainRow label="Address" value={[b.address1, b.address2, b.city, b.state, b.postcode, b.country].filter(Boolean).join("\n")} />}
        {b.ssid && <PlainRow label="Network" value={b.ssid} />}
        {b.bankName && <PlainRow label="Bank" value={b.bankName} />}
        {b.accountName && <PlainRow label="Account name" value={b.accountName} />}
        {b.routingNumber && <PlainRow label="BSB or routing number" value={b.routingNumber} />}
        {b.swift && <PlainRow label="SWIFT" value={b.swift} />}
        {b.sshPublic && <PlainRow label="Public key" value={b.sshPublic} />}
        {b.sshFingerprint && <PlainRow label="Fingerprint" value={b.sshFingerprint} />}
        {b.documentType && <PlainRow label="Type" value={b.documentType} copyable={false} />}
        {b.expiresOn && <PlainRow label="Expires" value={b.expiresOn} copyable={false} />}
        {b.totp?.secret && <ClockWarning />}
        {b.kind === "document" && b.expiresOn && canEdit && <ExpiryReminder item={item} />}
        {!fillOnly && secretFields.map((r) => <SecretRow key={r.label} label={r.label} value={r.value} />)}
        {b.fields?.map((f, i) =>
          f.type === "hidden" && fillOnly ? null : f.type === "hidden" ? <SecretRow key={i} label={f.name || "Field"} value={f.value} mono={false} /> : <PlainRow key={i} label={f.name || "Field"} value={f.value} />,
        )}
        {b.notes && <PlainRow label="Notes" value={b.notes} />}
      </section>

      {b.urls?.length ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-[var(--text-muted)]">Websites</h3>
          {b.urls.map((u, i) => {
            const href = safeHref(u.url);
            return (
              <div key={i} className="flex items-center gap-2 text-sm text-[var(--text)]">
                <span className="min-w-0 flex-1 break-all">{u.url}</span>
                {href && (
                  <a className="text-[var(--accent-text)]" href={href} target="_blank" rel="noreferrer noopener" aria-label={`Open ${u.url}`}>
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            );
          })}
        </section>
      ) : null}

      {b.kind === "wifi" && b.ssid && !fillOnly && (
        <section className="flex flex-col items-start gap-1">
          <h3 className="text-xs font-medium text-[var(--text-muted)]">Scan to join</h3>
          <QrImage text={wifiQr(b)} />
        </section>
      )}
      {b.totp && !fillOnly && <PlainRow label="Setup link" value={toOtpauth(b.totp)} copyable />}
      {b.passkeys?.length ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-[var(--text-muted)]">Passkeys</h3>
          {b.passkeys.map((p) => (
            <div key={p.credentialId} className="rounded-lg border border-[var(--border)] p-2 text-sm text-[var(--text)]">
              {p.rpName || p.rpId} · {p.userName} · made {new Date(p.createdAt).toLocaleDateString()}
            </div>
          ))}
        </section>
      ) : null}

      {b.kind !== "folder" && <Attachments item={item} canEdit={canEdit} />}

      <footer className="text-xs text-[var(--text-muted)]">Changed {new Date(b.updatedAt).toLocaleString()}</footer>
      {history && (
        <History_
          item={item}
          onClose={() => setHistory(false)}
          onRestore={(old) => {
            setHistory(false);
            setRestoring({ ...old, passwordHistory: b.passwordHistory });
          }}
        />
      )}
    </article>
  );
}
