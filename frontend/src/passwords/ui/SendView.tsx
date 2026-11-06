// The public page that opens a Send. No account, no vault, and nothing is fetched
// until the person asks, so a link preview can't use up a view.
import { useEffect, useMemo, useState } from "react";

import { ApiError, VaultApi } from "../core/api";
import { fromB64u } from "../core/bytes";
import { openSend, parseSendLink, sendMeta, type SendMetaOut, type SendPayload } from "../core/send";
import { Button, Callout, inputClass, Label } from "./kit";

export function SendView() {
  const link = useMemo(() => parseSendLink(location.pathname, location.hash), []);
  const api = useMemo(() => new VaultApi(location.origin, async () => null), []);
  const [meta, setMeta] = useState<SendMetaOut | null>(null);
  const [gone, setGone] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<{ payload: SendPayload; viewsLeft: number | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!link) return;
    sendMeta(api, link.id).then(setMeta).catch(() => setGone(true));
  }, [api, link]);

  const open = async () => {
    if (!link || !meta) return;
    setBusy(true);
    setError("");
    try {
      setOpened(await openSend(api, link.id, link.key, meta, password));
      // Opened: the key has no reason to stay in the address bar or the history. Before
      // this, a reload has to keep working.
      history.replaceState(null, "", location.pathname);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else if (e instanceof ApiError && e.status === 403) setError("That password isn't right.");
      else if (e instanceof ApiError && e.status === 429) setError("Too many tries. Try again later.");
      else setError("This Send couldn't be opened. The link may be incomplete.");
    } finally {
      setBusy(false);
    }
  };

  const save = (p: Extract<SendPayload, { kind: "file" }>) => {
    // Always a download: a sent file never runs on this page.
    const url = URL.createObjectURL(new Blob([fromB64u(p.data) as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = p.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  let body;
  if (!link) body = <Callout kind="danger">This link is incomplete. Ask whoever sent it for the whole thing.</Callout>;
  else if (gone) body = <Callout>This Send has gone. It may have expired or been used up. Ask whoever sent it for another.</Callout>;
  else if (opened) {
    const p = opened.payload;
    body = (
      <div className="flex flex-col gap-3">
        {p.title && <h2 className="font-medium text-[var(--text)]">{p.title}</h2>}
        {p.kind === "text" ? (
          <>
            <pre data-testid="send-text" className="whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] p-3 font-mono text-sm text-[var(--text)]">{p.text}</pre>
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(p.text);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </>
        ) : (
          <Button kind="primary" onClick={() => save(p)}>Download {p.name}</Button>
        )}
        <p className="text-xs text-[var(--text-muted)]">
          Save this somewhere safe now.
          {opened.viewsLeft === 0 ? " This was its last view, so the link won't open again." : ""}
        </p>
      </div>
    );
  } else if (!meta) body = <p className="text-sm text-[var(--text-muted)]">Checking the link…</p>;
  else {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--text)]">Someone sent you something through Promptly Passwords. It may only open a limited number of times.</p>
        {meta.has_password && (
          <Label text="Password" hint="Whoever sent this should have told you separately.">
            <input className={inputClass} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Label>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
        <Button kind="primary" disabled={busy || (meta.has_password && !password)} onClick={open}>{busy ? "Opening…" : "Open"}</Button>
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-[var(--bg)] p-4 pt-[10vh]">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h1 className="mb-3 text-lg font-semibold text-[var(--text)]">Secure Send</h1>
        {body}
      </div>
    </main>
  );
}
