import { AlertCircle, Check, ChevronDown, Loader2, Pencil, Plus, Settings, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi, type MailAccount, type MailFolder, type ServerSettings } from "./api";

const COLOURS = ["#D97757", "#2F9E6E", "#4F7FE0", "#9B6DD9", "#D9A441", "#C9586B"];
const BLANK_IMAP: ServerSettings = { host: "", port: 993, security: "ssl" };
const BLANK_SMTP: ServerSettings = { host: "", port: 465, security: "ssl" };

function ServerFields({ label, value, onChange }: { label: string; value: ServerSettings; onChange: (v: ServerSettings) => void }) {
  const input = "h-9 min-w-0 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm text-[var(--text)] outline-none focus:border-[#D97757]";
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-[var(--text-muted)]">{label}</legend>
      <div className="flex gap-2">
        <input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} placeholder="mail.example.com" aria-label={`${label} server`} className={`${input} flex-1`} />
        <input value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })} inputMode="numeric" aria-label={`${label} port`} className={`${input} w-16`} />
        <select value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as ServerSettings["security"] })} aria-label={`${label} security`} className={`${input} bg-[var(--surface)]`}>
          <option value="ssl">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
        </select>
      </div>
    </fieldset>
  );
}

/** The switcher at the top: which mailbox you're looking at. */
export function AccountPicker({ accounts, folders, current, onPick, onAdd, onManage, onSettings }: {
  accounts: MailAccount[];
  folders: MailFolder[];
  current?: string;
  onPick: (id: string | undefined) => void;
  onAdd: () => void;
  onManage: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = accounts.find((a) => a.id === current);
  const unread = (id?: string) => folders.filter((f) => f.role === "inbox" && (!id || f.account_id === id)).reduce((n, f) => n + f.unread, 0);
  const problem = accounts.some((a) => a.status === "error" && (!current || a.id === current));
  const row = "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]";
  const pick = (id: string | undefined) => { setOpen(false); onPick(id); };
  return (
    <div className="relative min-w-0" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} title={chosen?.email ?? "All mailboxes"} className="flex h-10 w-full min-w-0 items-center gap-2 rounded-xl px-2.5 text-left text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
        {chosen && <span style={{ backgroundColor: chosen.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />}
        <span className="min-w-0 flex-1 truncate">{chosen?.email ?? "All mailboxes"}</span>
        {problem && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#C62828]" />}
        <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="promptly-scroll absolute left-0 top-full z-40 mt-1 max-h-96 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl">
            <button type="button" role="menuitemradio" aria-checked={!current} onClick={() => pick(undefined)} className={row}>
              <span className="min-w-0 flex-1 truncate">All mailboxes</span>
              {unread() > 0 && <span className="text-xs font-medium text-[#D97757]">{unread()}</span>}
              {!current && <Check className="h-4 w-4 shrink-0 text-[#D97757]" />}
            </button>
            {accounts.map((a) => (
              <button key={a.id} type="button" role="menuitemradio" aria-checked={current === a.id} onClick={() => pick(a.id)} title={a.status === "error" ? a.status_detail : a.email} className={row}>
                <span style={{ backgroundColor: a.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate">{a.email}</span>
                {a.status === "error" && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[#C62828]" />}
                {unread(a.id) > 0 && <span className="text-xs font-medium text-[#D97757]">{unread(a.id)}</span>}
                {current === a.id && <Check className="h-4 w-4 shrink-0 text-[#D97757]" />}
              </button>
            ))}
            <div className="my-1 border-t border-[var(--border)]" />
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onAdd(); }} className={`${row} text-[var(--text-muted)]`}><Plus className="h-3.5 w-3.5" />Add a mailbox</button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onManage(); }} className={`${row} text-[var(--text-muted)]`}><Settings className="h-3.5 w-3.5" />Manage mailboxes</button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onSettings(); }} className={`${row} text-[var(--text-muted)]`}><SlidersHorizontal className="h-3.5 w-3.5" />Mail settings</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Which mailbox you're looking at, and the ones you've connected. */
export function MailboxSheet({ accounts, current, onPick, onAdd, onEdit, onClose, onRemoved }: {
  accounts: MailAccount[];
  current?: string;
  onPick: (id: string | undefined) => void;
  onAdd: () => void;
  onEdit: (a: MailAccount) => void;
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await mailApi.removeAccount(id);
      setRemoving(null);
      onRemoved(id);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't remove that mailbox."));
    } finally {
      setBusy(false);
    }
  };

  const row = "flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]";
  return (
    <Sheet open onClose={onClose} title="Mailboxes" size="sm">
      <div className="-mx-2 space-y-1">
        <button type="button" onClick={() => onPick(undefined)} aria-current={!current ? "true" : undefined} className={`${row} w-full`}>
          <span className="flex-1">All mailboxes</span>{!current && <Check className="h-4 w-4 text-[#D97757]" />}
        </button>
        {accounts.map((a) => (
          <div key={a.id}>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => onPick(a.id)} aria-current={current === a.id ? "true" : undefined} className={row}>
                <span style={{ backgroundColor: a.color }} className="h-2.5 w-2.5 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate">{a.email}</span>
                {a.status === "error" && <AlertCircle className="h-4 w-4 shrink-0 text-[#C62828]" />}
                {current === a.id && <Check className="h-4 w-4 shrink-0 text-[#D97757]" />}
              </button>
              <button type="button" onClick={() => onEdit(a)} aria-label={`Edit ${a.email}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><Pencil className="h-4 w-4" /></button>
              <button type="button" onClick={() => setRemoving(removing === a.id ? null : a.id)} aria-label={`Remove ${a.email}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><Trash2 className="h-4 w-4" /></button>
            </div>
            {a.status === "error" && a.status_detail && <p className="px-2 pb-1 text-xs text-[var(--text-muted)]">{a.status_detail}</p>}
            {removing === a.id && (
              <div className="mx-2 mb-2 rounded-lg bg-[var(--hover)] p-3 text-xs text-[var(--text)]">
                <p>This removes it from Promptly. Your mail stays in the mailbox itself.</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => setRemoving(null)} className="h-8 rounded-lg px-3 text-[var(--text-muted)]">Keep it</button>
                  <button type="button" disabled={busy} onClick={() => void remove(a.id)} className="h-8 rounded-lg bg-[#C62828] px-3 font-medium text-white disabled:opacity-50">Remove</button>
                </div>
              </div>
            )}
          </div>
        ))}
        <button type="button" onClick={onAdd} className={`${row} w-full text-[var(--text-muted)]`}><Plus className="h-4 w-4" />Add a mailbox</button>
      </div>
    </Sheet>
  );
}

/** Add a mailbox: email and password, and we fill in the rest when we can. */
export function AccountSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [colour, setColour] = useState(COLOURS[0]);
  const [imap, setImap] = useState(BLANK_IMAP);
  const [smtp, setSmtp] = useState(BLANK_SMTP);
  const [provider, setProvider] = useState("generic");
  const [note, setNote] = useState<string | null>(null);
  const [known, setKnown] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [guessed, setGuessed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [certificate, setCertificate] = useState<{ message: string; fingerprint: string } | null>(null);
  const [pin, setPin] = useState("");

  const lookUp = async () => {
    if (!email.includes("@")) return;
    const found = await mailApi.setup(email).catch(() => null);
    if (found?.known && found.imap && found.smtp) {
      setImap(found.imap);
      setSmtp(found.smtp);
      setProvider(found.provider ?? "generic");
      setNote(found.note ?? null);
      setKnown(true);
      setGuessed(false);
      setAdvanced(false);
    } else if (found?.note) {
      setKnown(false);
      setProvider("generic");
      setNote(found.note);
      setAdvanced(Boolean(found.imap));
      if (found.imap) setImap(found.imap);
      if (found.smtp) setSmtp(found.smtp);
    } else {
      setKnown(false);
      setNote(null);
      setProvider("generic");
      setGuessed(true);
      setAdvanced(true);
      const domain = email.split("@")[1];
      setImap((v) => (v.host ? v : { ...v, host: `imap.${domain}` }));
      setSmtp((v) => (v.host ? v : { ...v, host: `smtp.${domain}` }));
    }
  };

  const save = async (agreed = pin) => {
    setBusy(true);
    setProblem(null);
    setCertificate(null);
    try {
      await mailApi.addAccount({
        email, password, display_name: name, color: colour, provider, cert_pin: agreed,
        imap_host: imap.host, imap_port: imap.port, imap_security: imap.security,
        smtp_host: smtp.host, smtp_port: smtp.port, smtp_security: smtp.security,
      });
      toast.success("Connected. Your mail is on its way.");
      onSaved();
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: { message?: string; fingerprint?: string } } } }).response?.data?.detail;
      if (detail?.fingerprint) setCertificate({ message: detail.message ?? "", fingerprint: detail.fingerprint });
      else setProblem(apiErrorMessage(e, "Couldn't connect to that mailbox."));
      setBusy(false);
    }
  };

  const input = "h-10 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--text)] outline-none focus:border-[#D97757]";
  return (
    <Sheet open onClose={onClose} title="Add a mailbox" size="sm">
      <div className="space-y-3 pb-1 text-left">
        <p className="text-sm text-[var(--text-muted)]">Type your email address and password. Promptly works out the rest.</p>
        <input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} onBlur={() => void lookUp()} placeholder="you@example.com" aria-label="Email address" autoComplete="off" className={input} />
        {note && <p className="rounded-lg bg-[#D97757]/10 p-2.5 text-xs text-[var(--text)]">{note}</p>}
        {guessed && !note && <p className="rounded-lg bg-[var(--hover)] p-2.5 text-xs text-[var(--text)]">Promptly doesn't know this email provider yet, so it's made its best guess at the details under Advanced. If it won't connect, your provider's help page will have the right ones: look for "mail app settings".</p>}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={known ? "App password" : "Password"} aria-label="Password" autoComplete="new-password" className={input} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name, as people will see it" aria-label="Your name" className={input} />
        <div className="flex gap-2" role="radiogroup" aria-label="Colour">
          {COLOURS.map((c) => <button key={c} type="button" role="radio" aria-checked={colour === c} aria-label={c} onClick={() => setColour(c)} style={{ backgroundColor: c }} className={`h-6 w-6 rounded-full ${colour === c ? "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]" : ""}`} />)}
        </div>
        <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="inline-flex min-h-10 items-center gap-1 text-xs text-[var(--text-muted)] md:min-h-0">Advanced<ChevronDown className={`h-3.5 w-3.5 transition-transform ${advanced ? "rotate-180" : ""}`} /></button>
        {advanced && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">Where your mail comes in and goes out. Most people never need to change these.</p>
            <ServerFields label="Incoming mail (IMAP)" value={imap} onChange={setImap} />
            <ServerFields label="Outgoing mail (SMTP)" value={smtp} onChange={setSmtp} />
          </div>
        )}
        <p className="text-xs text-[var(--text-muted)]">Your password is stored encrypted on your Promptly server. Your mail stays in your mailbox too, and removing this later doesn't delete anything there.</p>
        {problem && (
          <div role="alert" className="space-y-1">
            <p className="text-sm text-[#C62828]">{problem}</p>
            <p className="text-xs text-[var(--text-muted)]">{known ? "Check the password first. Some email providers want an app password, made just for this, instead of your usual one." : "Check the password first. If that's right, open Advanced and compare the details with your email provider's help page."}</p>
          </div>
        )}
        {certificate && (
          <div role="alert" className="space-y-2 rounded-lg bg-[#D97757]/10 p-3 text-xs text-[var(--text)]">
            <p>{certificate.message}</p>
            <p className="break-all font-mono text-xs text-[var(--text-muted)]">{certificate.fingerprint.match(/.{1,2}/g)?.join(":")}</p>
            <button type="button" onClick={() => { setPin(certificate.fingerprint); void save(certificate.fingerprint); }} className="h-8 rounded-lg bg-[#D97757] px-3 font-medium text-white">Trust this certificate</button>
          </div>
        )}
        <button type="button" onClick={() => void save()} disabled={busy || !email || !password || !imap.host || !smtp.host} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#D97757] text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </Sheet>
  );
}
