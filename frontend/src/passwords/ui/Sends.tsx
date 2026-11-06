// Secure Send: a password or a file, with an expiry and a view limit, for someone
// who may have no account. What you've sent is remembered in your own vault, so the
// server never knows what any of them are called.
import { Copy, Mail, MessageSquare, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { b64u } from "../core/bytes";
import { newBody } from "../core/model";
import { createSend, MAX_SEND_FILE, type SendPayload } from "../core/send";
import { Button, Callout, errorText, inputClass, Label, Modal, useVault } from "./kit";

type SendRow = { id: string; expires_at: string; views_left: number | null; has_password: boolean; disabled: boolean; created_at: string };
type Person = { id: string; username: string; has_vault: boolean };

export function SendsScreen() {
  const { vault, version, bump, toast, copy } = useVault();
  const [rows, setRows] = useState<SendRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [posting, setPosting] = useState<{ id: string; link: string; via: "rooms" | "mail" } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await vault.api.request<SendRow[]>("GET", "/sends"));
    } catch (e) {
      setError(errorText(e));
    }
  }, [vault]);
  useEffect(() => {
    void load();
  }, [load, version]);

  const records = useMemo(() => {
    void version;
    const out = new Map<string, { itemId: string; title: string; link: string }>();
    for (const i of vault.allItems({ includeSystem: true })) {
      if (i.body.kind === "send" && i.body.notes && !i.deleted) out.set(i.body.sendId ?? "", { itemId: i.id, title: i.body.title, link: i.body.notes });
    }
    return out;
  }, [vault, version]);

  const remove = async (id: string) => {
    try {
      await vault.api.request("DELETE", `/sends/${id}`);
      const r = records.get(id);
      if (r) {
        await vault.trashItem(r.itemId);
        await vault.purgeItem(r.itemId);
      }
      bump();
      toast("Send deleted");
      await load();
    } catch (e) {
      toast(errorText(e), "err");
    }
  };

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-[var(--text)]">Sends</h1>
        <Button kind="primary" onClick={() => setCreating(true)}>New Send</Button>
      </div>
      <p className="text-sm text-[var(--text-muted)]">Send a password or a file to anyone, with a limit on how long it lasts and how often it opens. They don't need an account.</p>
      {error && <Callout kind="danger">{error}</Callout>}
      {rows.length === 0 && !error && <p className="text-sm text-[var(--text-muted)]">Nothing sent at the moment.</p>}
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const rec = records.get(r.id);
          const expired = new Date(r.expires_at).getTime() < Date.now() || r.views_left === 0;
          return (
            <li key={r.id} data-testid="send-row" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--text)]">{rec?.title ?? "Sent from another device"}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  {expired ? "Finished" : `Until ${new Date(r.expires_at).toLocaleString()}`}
                  {r.views_left !== null && ` · ${r.views_left} view${r.views_left === 1 ? "" : "s"} left`}
                  {r.has_password && " · needs a password"}
                </p>
              </div>
              {rec && !expired && (
                <>
                  <Button small onClick={() => copy(rec.link, "Link", true)}><Copy className="h-3.5 w-3.5" /> Copy link</Button>
                  <Button small onClick={() => setPosting({ id: r.id, link: rec.link, via: "rooms" })}><MessageSquare className="h-3.5 w-3.5" /> Rooms</Button>
                  <Button small onClick={() => setPosting({ id: r.id, link: rec.link, via: "mail" })}><Mail className="h-3.5 w-3.5" /> Mail</Button>
                </>
              )}
              <Button small onClick={() => remove(r.id)} aria-label="Delete this Send"><Trash2 className="h-3.5 w-3.5" /></Button>
            </li>
          );
        })}
      </ul>
      {creating && <NewSend onClose={() => setCreating(false)} onMade={async () => { setCreating(false); await load(); }} />}
      {posting && <PostSend {...posting} onClose={() => setPosting(null)} />}
    </section>
  );
}

function NewSend({ onClose, onMade }: { onClose: () => void; onMade: () => Promise<void> }) {
  const { vault, platform, bump, copy } = useVault();
  const [mode, setMode] = useState<"text" | "file">("text");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [days, setDays] = useState(7);
  const [views, setViews] = useState("1");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      let payload: SendPayload;
      if (mode === "text") {
        if (!text) throw new Error("Add what you want to send.");
        payload = { kind: "text", title, text };
      } else {
        if (!file) throw new Error("Choose a file.");
        if (file.size > MAX_SEND_FILE) throw new Error("A file can be up to 7 MB.");
        payload = { kind: "file", title, name: file.name, mime: file.type || undefined, data: b64u(new Uint8Array(await file.arrayBuffer())) };
      }
      if (password && password.length < 8) throw new Error("Use at least 8 characters for the password, or leave it empty.");
      const limit = views.trim() ? Number(views) : null;
      if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error("Views must be a whole number, or empty for no limit.");
      const { id, link } = await createSend(vault.api, platform.baseUrl, payload, { days, views: limit, password: password || undefined });
      await vault.saveNew(await vault.personalVaultId(), newBody("send", title || (file?.name ?? "Text"), { notes: link, sendId: id }));
      bump();
      setMade(link);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <Modal title="Your link is ready" onClose={() => void onMade()}>
        <div className="flex flex-col gap-3">
          <p className="break-all rounded border border-[var(--border)] p-2 font-mono text-xs text-[var(--text)]" data-testid="send-link">{made}</p>
          <Button kind="primary" onClick={() => copy(made, "Link", true)}>Copy link</Button>
          {password && <Callout>Tell them the password some other way, not in the same message as the link.</Callout>}
          <Button onClick={() => void onMade()}>Done</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="New Send" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div role="tablist" className="flex gap-1">
          <Button small kind={mode === "text" ? "primary" : "plain"} onClick={() => setMode("text")}>Text</Button>
          <Button small kind={mode === "file" ? "primary" : "plain"} onClick={() => setMode("file")}>File</Button>
        </div>
        <Label text="What is it?" hint="Only you see this, and it's only here to tell your Sends apart. It's also shown to them.">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Label>
        {mode === "text" ? (
          <Label text="What to send">
            <textarea className={inputClass} rows={4} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
          </Label>
        ) : (
          <Label text="File, up to 7 MB">
            <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Label>
        )}
        <Label text={`Lasts ${days} day${days === 1 ? "" : "s"}`}>
          <input type="range" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </Label>
        <Label text="How many times it can open" hint="Leave empty for no limit, until it expires.">
          <input className={inputClass} inputMode="numeric" value={views} onChange={(e) => setViews(e.target.value)} />
        </Label>
        <Label text="Password (optional)" hint="Asked for before it opens. A good idea if the link goes through Rooms or Mail.">
          <input className={inputClass} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Label>
        {error && <Callout kind="danger">{error}</Callout>}
        <Button kind="primary" disabled={busy} onClick={submit}>{busy ? "Encrypting…" : "Make the link"}</Button>
      </div>
    </Modal>
  );
}

function PostSend({ id, link, via, onClose }: { id: string; link: string; via: "rooms" | "mail"; onClose: () => void }) {
  const { vault, toast } = useVault();
  const [people, setPeople] = useState<Person[]>([]);
  const [userId, setUserId] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (via === "rooms") void vault.api.request<Person[]>("GET", "/people").then(setPeople).catch((e) => setError(errorText(e)));
  }, [vault, via]);

  const post = async () => {
    try {
      await vault.api.request("POST", `/sends/${id}/via-${via}`, via === "rooms" ? { link, user_id: userId } : { link, to });
      toast(via === "rooms" ? "Posted in Rooms" : "Queued in Mail");
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Modal title={via === "rooms" ? "Send in Rooms" : "Send by Mail"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Callout kind="warn">The link passes through your Promptly server this way, and the link is enough to open it unless it has a password. Copying the link into something end-to-end encrypted is safer.</Callout>
        {via === "rooms" ? (
          <Label text="Who to">
            <select className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose someone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.username}</option>)}
            </select>
          </Label>
        ) : (
          <Label text="Their email address">
            <input className={inputClass} type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          </Label>
        )}
        {error && <Callout kind="danger">{error}</Callout>}
        <Button kind="primary" disabled={via === "rooms" ? !userId : !to} onClick={post}>Send the link</Button>
      </div>
    </Modal>
  );
}
