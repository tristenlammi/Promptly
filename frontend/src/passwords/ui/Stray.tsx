// Find stray passwords: secrets sitting in plain text in your own Mail, Files and Photos.
// Your server looks, since it holds them already; it keeps only where it found something.
// Saving one makes a vault item on this device, then the original can go to its Trash.
import { useCallback, useEffect, useRef, useState } from "react";

import type { ItemBody } from "../core/model";
import { canSave, prefill, STRAY_KIND_LABEL, STRAY_SOURCE_LABEL, STRAY_TRASH_WHERE, type StrayDetail, type StrayFinding, type StrayList } from "../core/stray";
import { ItemEditor } from "./ItemEditor";
import { Button, Callout, errorText, Modal, Spinner, useVault } from "./kit";
import { decodeQrFile } from "./qr";

const POLL_MS = 3000;

function when(at: string | null): string {
  return at ? new Date(at).toLocaleString() : "";
}

const LOOK_TEXT: Partial<Record<StrayFinding["kind"], string>> = {
  password_store:
    "A password manager's own file, outside this vault. It's encrypted, but it's a second copy of your passwords. If you still need what's in it, download it from Files and bring it in through Import and export. Then move this copy to Trash.",
  password_file: "This file's name says it holds passwords, and its contents couldn't be read here. Open it in Files to check, and move what's in it into the vault.",
};

/** Save to vault, then the question about the original. One finding at a time. */
function StrayFlow({ finding, onClose, onChanged }: { finding: StrayFinding; onClose: () => void; onChanged: () => void }) {
  const { vault, bump, toast, go } = useVault();
  const [detail, setDetail] = useState<StrayDetail | null>(null);
  const [body, setBody] = useState<ItemBody | null>(null);
  const [vid, setVid] = useState("");
  const [step, setStep] = useState<"loading" | "look" | "edit" | "trash">("loading");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = await vault.api.request<StrayDetail>("GET", `/stray/${finding.id}`);
        let qr: string | null = null;
        if (d.kind === "totp_qr") {
          // The QR is read here, on this device. The server only hands over the picture.
          try {
            const raw = await vault.api.request<ArrayBuffer>("GET", `/stray/${finding.id}/image`);
            qr = await decodeQrFile(new Blob([raw]));
          } catch {
            qr = null;
          }
          if (qr?.startsWith("otpauth-migration://")) {
            qr = null;
            if (live) setNote("That QR moves several accounts at once. Use Import and export, then From a QR image.");
          } else if (!qr || !/^otpauth:\/\//i.test(qr)) {
            qr = null;
            if (live) setNote("The QR code couldn't be read from this picture. Use From an image below, or type the setup key the site shows.");
          }
        }
        let b: ItemBody | null = null;
        try {
          b = canSave(d.kind) ? prefill(d, qr) : null;
        } catch (e) {
          if (live) setNote(errorText(e));
        }
        const personal = await vault.personalVaultId();
        if (!live) return;
        setDetail(d);
        setVid(personal);
        setBody(b);
        setStep(b ? "edit" : "look");
      } catch (e) {
        if (!live) return;
        setError(errorText(e));
        setStep("look");
      }
    })();
    return () => {
      live = false;
    };
  }, [vault, finding.id]);

  const trash = async () => {
    setBusy(true);
    setError("");
    try {
      await vault.api.request("POST", `/stray/${finding.id}/trash`);
      toast(`Moved to ${STRAY_TRASH_WHERE[finding.source]}`);
      onChanged();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const ignore = async () => {
    try {
      await vault.api.request("POST", `/stray/${finding.id}/ignore`);
      onChanged();
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const where = `${STRAY_SOURCE_LABEL[finding.source]}: ${finding.where.title}`;

  if (step === "loading") {
    return (
      <Modal title="Save to vault" onClose={onClose}>
        <Spinner label="Opening…" />
      </Modal>
    );
  }

  if (step === "edit" && body) {
    return (
      <Modal title="Save to vault" onClose={onClose} wide>
        <div className="mb-3 flex flex-col gap-2 text-sm text-[var(--text)]">
          <p>
            From {where}. Check it, then Save. It's encrypted on this device before it goes anywhere.
          </p>
          {note && <Callout kind="warn">{note}</Callout>}
          {detail?.excerpt && (
            <details className="text-xs">
              <summary className="cursor-pointer text-[var(--text-muted)]">Where it was found</summary>
              <pre data-testid="stray-excerpt" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-1)] p-2">{detail.excerpt}</pre>
            </details>
          )}
          {finding.kind === "password_list" && finding.hits > 20 && (
            <Callout kind="info">This looks like a whole export. Import and export brings in every row as its own login, which is better than one long note.</Callout>
          )}
        </div>
        <ItemEditor
          initial={body}
          vaultId={vid}
          onCancel={onClose}
          onDone={() => {
            bump();
            toast("Saved");
            setStep("trash");
          }}
        />
      </Modal>
    );
  }

  if (step === "trash") {
    return (
      <Modal title="It's in your vault" onClose={onClose}>
        <div data-testid="stray-trash" className="flex flex-col gap-3 text-sm text-[var(--text)]">
          <p>The original is still in {where}. Your server can read it there, and so can anyone who gets into that account.</p>
          <p>
            Move it to {STRAY_TRASH_WHERE[finding.source]}? You can get it back from there until the Trash is emptied.
            {finding.source === "mail" && " Only this email moves, not the rest of its conversation."}
          </p>
          <Button kind="danger" onClick={trash} disabled={busy}>Move the original to Trash</Button>
          <Button onClick={ignore} disabled={busy}>Keep it, and stop showing it</Button>
          <Button onClick={onClose} disabled={busy}>Decide later</Button>
          {error && <Callout kind="danger">{error}</Callout>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={STRAY_KIND_LABEL[finding.kind]} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
        <p>In {where}.</p>
        {LOOK_TEXT[finding.kind] && <p>{LOOK_TEXT[finding.kind]}</p>}
        {note && <Callout kind="warn">{note}</Callout>}
        {error && <Callout kind="danger">{error}</Callout>}
        {finding.kind === "password_store" && <Button onClick={() => go("transfer")}>Go to Import and export</Button>}
        {!error && <Button kind="danger" onClick={() => setStep("trash")}>Move the original to Trash…</Button>}
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

export function StrayPanel() {
  const { vault, toast, route } = useVault();
  const [data, setData] = useState<StrayList | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<StrayFinding | null>(null);
  const ref = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await vault.api.request<StrayList>("GET", "/stray"));
    } catch (e) {
      setError(errorText(e));
    }
  }, [vault]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (route === "stray") ref.current?.scrollIntoView({ block: "start" });
  }, [route]);

  // While the server's looking, ask again every few seconds.
  useEffect(() => {
    if (!data?.scanning) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [data?.scanning, load]);

  const scan = async () => {
    setError("");
    try {
      await vault.api.request("POST", "/stray/scan");
      setData((d) => (d ? { ...d, scanning: true } : d));
      void load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const ignore = async (f: StrayFinding) => {
    if (!confirm(`Stop showing this ${STRAY_KIND_LABEL[f.kind].toLowerCase()} in ${STRAY_SOURCE_LABEL[f.source]}? It stays where it is, and later checks won't show it again.`)) return;
    try {
      await vault.api.request("POST", `/stray/${f.id}/ignore`);
      toast("Hidden for good");
      await load();
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  return (
    <section ref={ref} data-testid="stray" className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">
        Stray passwords <span data-testid="stray-count" className="ml-1 rounded bg-[var(--surface-1)] px-1.5 text-xs">{data ? data.count : "…"}</span>
      </h2>
      <p className="text-xs text-[var(--text-muted)]">
        Passwords, keys and codes sitting in plain text in your own Mail, Files and Photos, where your server can read them. Your server looks, in your things only, and
        keeps just where it found something. Nothing found goes to AI or anywhere else.
      </p>
      {data?.mail_hidden && <Callout kind="info">Mail isn't included here, because this browser was connected without codes from Mail. Turn those on in Settings to include it.</Callout>}
      <div className="flex flex-wrap items-center gap-2">
        <Button kind="primary" className="w-fit" onClick={scan} disabled={!data || data.scanning}>Find stray passwords</Button>
        {data?.scanning ? (
          <Spinner label="Looking through your Mail, Files and Photos…" />
        ) : data?.last_scan_at ? (
          <span className="text-xs text-[var(--text-muted)]">
            Last checked {when(data.last_scan_at)}.{!data.caught_up && " Some is still to check, and it's checked in the background."}
          </span>
        ) : null}
      </div>
      {error && <Callout kind="danger">{error}</Callout>}
      {data && data.findings.length > 0 && (
        <ul className="flex flex-col">
          {data.findings.map((f) => (
            <li key={f.id} data-testid="stray-row" className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] py-2 text-sm text-[var(--text)] last:border-0">
              <div className="min-w-0 flex-1">
                <p className="truncate">{f.where.title}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {STRAY_SOURCE_LABEL[f.source]} · {STRAY_KIND_LABEL[f.kind]}
                  {f.hits > 1 ? ` · ${f.hits}` : ""} · {f.where.detail}
                  {f.where.at ? ` · ${new Date(f.where.at).toLocaleDateString()}` : ""}
                </p>
                {f.preview && <p className="font-mono text-xs text-[var(--text-muted)]">{f.preview}</p>}
              </div>
              <Button small kind="primary" onClick={() => setOpen(f)}>{canSave(f.kind) ? "Save to vault" : "Open"}</Button>
              <Button small onClick={() => ignore(f)}>Ignore</Button>
            </li>
          ))}
        </ul>
      )}
      {data && !data.scanning && data.findings.length === 0 && data.last_scan_at && <p className="text-xs text-[var(--text-muted)]">Nothing found.</p>}
      {data && data.ignored > 0 && <p className="text-xs text-[var(--text-muted)]">{data.ignored} ignored.</p>}
      {open && <StrayFlow finding={open} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </section>
  );
}
