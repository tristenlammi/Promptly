// Create and edit every kind of item.
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import { generateForSite } from "../core/generator";
import { hostOf } from "../core/match";
import type { CustomField, ItemBody, ItemKind, LoginUrl, UrlMatch } from "../core/model";
import { parseOtpauth } from "../core/totp";
import { Button, Callout, errorText, IconButton, inputClass, Label, useVault } from "./kit";
import { StrengthMeter } from "./Onboarding";
import { decodeQrFile, scanQrFromCamera } from "./qr";

export const KIND_LABEL: Record<string, string> = {
  login: "Login",
  note: "Secure note",
  card: "Card",
  identity: "Identity",
  totp: "2FA code",
  passkey: "Passkey",
  apikey: "API key",
  wifi: "Wi-Fi",
  ssh: "SSH key",
  bank: "Bank account",
  document: "Licence or ID",
};

export const CREATABLE: ItemKind[] = ["login", "note", "card", "identity", "totp", "apikey", "wifi", "ssh", "bank", "document"];

type FieldDef = { key: keyof ItemBody; label: string; secret?: boolean; area?: boolean; type?: string; hint?: string };

const FIELDS: Partial<Record<ItemKind, FieldDef[]>> = {
  card: [
    { key: "cardholder", label: "Name on card" },
    { key: "cardNumber", label: "Card number", secret: true },
    { key: "cardBrand", label: "Brand" },
    { key: "cardExpMonth", label: "Expiry month" },
    { key: "cardExpYear", label: "Expiry year" },
    { key: "cardCvv", label: "Security code", secret: true },
  ],
  identity: [
    { key: "firstName", label: "First name" },
    { key: "middleName", label: "Middle name" },
    { key: "lastName", label: "Last name" },
    { key: "email", label: "Email", type: "email" },
    { key: "phone", label: "Phone" },
    { key: "company", label: "Company" },
    { key: "address1", label: "Address" },
    { key: "address2", label: "Address line 2" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "postcode", label: "Postcode" },
    { key: "country", label: "Country" },
  ],
  apikey: [
    { key: "apiKey", label: "Key", secret: true },
    { key: "apiSecret", label: "Secret", secret: true },
  ],
  wifi: [
    { key: "ssid", label: "Network name" },
    { key: "wifiPassword", label: "Password", secret: true },
  ],
  ssh: [
    { key: "sshPublic", label: "Public key", area: true },
    { key: "sshPrivate", label: "Private key", area: true, secret: true },
    { key: "sshFingerprint", label: "Fingerprint" },
  ],
  bank: [
    { key: "bankName", label: "Bank" },
    { key: "accountName", label: "Account name" },
    { key: "accountNumber", label: "Account number", secret: true },
    { key: "routingNumber", label: "BSB or routing number" },
    { key: "iban", label: "IBAN", secret: true },
    { key: "swift", label: "SWIFT" },
  ],
  document: [
    { key: "documentType", label: "Type", hint: "Passport, driver's licence…" },
    { key: "documentNumber", label: "Number", secret: true },
    { key: "expiresOn", label: "Expires", type: "date" },
  ],
};

const MATCHES: { value: UrlMatch; label: string }[] = [
  { value: "base", label: "Same site (default)" },
  { value: "host", label: "This exact host" },
  { value: "exact", label: "This exact URL" },
  { value: "prefix", label: "Starts with" },
  { value: "regex", label: "Regular expression" },
  { value: "never", label: "Never fill" },
];

export function ItemEditor({ initial, vaultId, id, onDone, onCancel }: { initial: ItemBody; vaultId: string; id?: string; onDone: (id: string) => void; onCancel: () => void }) {
  const { vault } = useVault();
  const [body, setBody] = useState<ItemBody>(initial);
  const [target, setTarget] = useState(vaultId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [otp, setOtp] = useState(initial.totp ? initial.totp.secret : "");
  const folders = useMemo(() => vault.allItems({ includeSystem: true }).filter((i) => i.body.kind === "folder"), [vault]);
  const [vaults, setVaults] = useState<{ id: string; displayName: string; role: string }[]>([]);
  useMemo(() => {
    vault.vaults().then((v) => setVaults(v.filter((x) => ["manage", "edit"].includes(x.role))));
  }, [vault]);

  const set = (key: keyof ItemBody, value: unknown) => setBody((b) => ({ ...b, [key]: value }));

  const applyOtp = (text: string) => {
    setOtp(text);
    setError("");
    const t = text.trim();
    if (!t) return set("totp", null);
    if (t.startsWith("otpauth-migration://")) {
      setError("That's a transfer code for several accounts at once. Use Import and export, and choose From a QR image.");
      return set("totp", null);
    }
    if (t.startsWith("otpauth://") || t.startsWith("steam://")) {
      try {
        const cfg = parseOtpauth(t);
        setOtp(cfg.secret);
        set("totp", cfg);
      } catch (e) {
        setError(errorText(e));
      }
      return;
    }
    set("totp", { ...(body.totp ?? {}), secret: t.toUpperCase().replace(/\s/g, "") });
  };

  const scanOtp = async () => {
    const text = await scanQrFromCamera();
    if (text) applyOtp(text);
  };

  const otpFromImage = async (file: File | undefined) => {
    if (!file) return;
    const text = await decodeQrFile(file);
    if (text) applyOtp(text);
    else setError("No QR code found in that image.");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.title.trim()) return setError("Give it a name.");
    setBusy(true);
    try {
      const clean: ItemBody = { ...body, title: body.title.trim() };
      if (body.kind === "login" || body.kind === "totp") {
        if (clean.totp?.secret) {
          if (!clean.totp.steam) parseOtpauth(`otpauth://totp/x?secret=${encodeURIComponent(clean.totp.secret)}`);
        } else {
          delete clean.totp;
        }
      }
      const saved = id ? await vault.update(id, clean) : await vault.saveNew(target, clean);
      vault.sync().catch(() => undefined);
      onDone(saved.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const urls = body.urls ?? [];
  const setUrl = (i: number, next: Partial<LoginUrl>) => set("urls", urls.map((u, n) => (n === i ? { ...u, ...next } : u)));
  const fields = body.fields ?? [];
  const setField = (i: number, next: Partial<CustomField>) => set("fields", fields.map((f, n) => (n === i ? { ...f, ...next } : f)));
  const defs = FIELDS[body.kind] ?? [];

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Edit item">
      <Label text="Name">
        <input className={inputClass} autoFocus={!id} value={body.title} onChange={(e) => set("title", e.target.value)} />
      </Label>

      {!id && vaults.length > 1 && (
        <Label text="Vault">
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)}>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>{v.displayName}</option>
            ))}
          </select>
        </Label>
      )}

      {body.kind === "login" && (
        <>
          <Label text="Username or email">
            <input className={inputClass} autoComplete="off" value={body.username ?? ""} onChange={(e) => set("username", e.target.value)} />
          </Label>
          <Label text="Password">
            <div className="flex gap-2">
              <input className={`${inputClass} font-mono`} autoComplete="new-password" value={body.password ?? ""} onChange={(e) => set("password", e.target.value)} />
              <IconButton label="Generate a password" onClick={() => set("password", generateForSite(hostOf(urls[0]?.url ?? "")))}>
                <RefreshCw className="h-4 w-4" />
              </IconButton>
            </div>
          </Label>
          <StrengthMeter password={body.password ?? ""} inputs={[body.username ?? "", body.title]} />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[var(--text)]">Websites</span>
            {urls.map((u, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input aria-label={`Website ${i + 1}`} className={`${inputClass} min-w-0 flex-1`} value={u.url} placeholder="https://example.com" onChange={(e) => setUrl(i, { url: e.target.value })} />
                <select aria-label={`How website ${i + 1} matches`} className={`${inputClass} w-auto`} value={u.match ?? "base"} onChange={(e) => setUrl(i, { match: e.target.value as UrlMatch })}>
                  {MATCHES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <IconButton label={`Remove website ${i + 1}`} onClick={() => set("urls", urls.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            ))}
            <Button small className="w-fit" onClick={() => set("urls", [...urls, { url: "" }])}><Plus className="h-3 w-3" /> Add website</Button>
          </div>
        </>
      )}

      {(body.kind === "login" || body.kind === "totp") && (
        <div className="flex flex-col gap-2">
          <Label text="2FA secret or otpauth link" hint="Scan the site's QR, or paste the setup key.">
            <input className={`${inputClass} font-mono`} autoComplete="off" spellCheck={false} value={otp} onChange={(e) => applyOtp(e.target.value)} />
          </Label>
          <div className="flex flex-wrap gap-2">
            <Button small onClick={scanOtp}>Scan with camera</Button>
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface-1)]">
              From an image
              <input type="file" accept="image/*" className="hidden" onChange={(e) => otpFromImage(e.target.files?.[0])} />
            </label>
          </div>
          <div
            className="rounded-lg border border-dashed border-[var(--border)] p-2 text-xs text-[var(--text-muted)]"
            onPaste={(e) => {
              const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
              if (f) otpFromImage(f);
            }}
            tabIndex={0}
          >
            Or click here and paste a screenshot of the QR.
          </div>
        </div>
      )}

      {defs.map((d) => (
        <Label key={String(d.key)} text={d.label} hint={d.hint}>
          {d.area ? (
            <textarea className={`${inputClass} font-mono`} rows={4} spellCheck={false} value={String(body[d.key] ?? "")} onChange={(e) => set(d.key, e.target.value)} />
          ) : (
            <input className={`${inputClass} ${d.secret ? "font-mono" : ""}`} type={d.type ?? "text"} autoComplete="off" value={String(body[d.key] ?? "")} onChange={(e) => set(d.key, e.target.value)} />
          )}
        </Label>
      ))}

      {body.kind === "wifi" && (
        <Label text="Security">
          <select className={inputClass} value={body.wifiSecurity ?? "WPA"} onChange={(e) => set("wifiSecurity", e.target.value)}>
            <option value="WPA">WPA / WPA2 / WPA3</option>
            <option value="WEP">WEP</option>
            <option value="nopass">None</option>
          </select>
        </Label>
      )}

      <Label text="Notes">
        <textarea className={inputClass} rows={body.kind === "note" ? 8 : 3} value={body.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
      </Label>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-[var(--text)]">Custom fields</span>
        {fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input aria-label={`Field ${i + 1} name`} className={`${inputClass} w-32`} placeholder="Name" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
            <input aria-label={`Field ${i + 1} value`} className={`${inputClass} min-w-0 flex-1`} placeholder="Value" value={f.value} onChange={(e) => setField(i, { value: e.target.value })} />
            <select aria-label={`Field ${i + 1} type`} className={`${inputClass} w-auto`} value={f.type} onChange={(e) => setField(i, { type: e.target.value as CustomField["type"] })}>
              <option value="text">Text</option>
              <option value="hidden">Hidden</option>
              <option value="boolean">Yes/no</option>
            </select>
            <IconButton label={`Remove field ${i + 1}`} onClick={() => set("fields", fields.filter((_, n) => n !== i))}><Trash2 className="h-4 w-4" /></IconButton>
          </div>
        ))}
        <Button small className="w-fit" onClick={() => set("fields", [...fields, { name: "", value: "", type: "text" }])}><Plus className="h-3 w-3" /> Add field</Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <Label text="Folder">
          <select className={inputClass} value={body.folderId ?? ""} onChange={(e) => set("folderId", e.target.value || null)}>
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.body.title}</option>
            ))}
          </select>
        </Label>
        <Label text="Tags" hint="Separated by commas">
          <input className={inputClass} value={(body.tags ?? []).join(", ")} onChange={(e) => set("tags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))} />
        </Label>
      </div>

      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input type="checkbox" checked={!!body.reprompt} onChange={(e) => set("reprompt", e.target.checked)} />
        Ask for my master password before showing or filling this
      </label>
      {body.kind === "login" && (
        <label className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" checked={!!body.autofillOnLoad} onChange={(e) => set("autofillOnLoad", e.target.checked)} />
          Fill when the page loads (exact site, HTTPS, top-level only)
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-[var(--text)]">
        <input type="checkbox" checked={!!body.icon} onChange={(e) => set("icon", e.target.checked)} />
        Show the site's icon (fetched through your server, which sees the site's name)
      </label>

      {error && <Callout kind="danger">{error}</Callout>}
      <div className="flex gap-2">
        <Button kind="primary" type="submit" disabled={busy}>Save</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
