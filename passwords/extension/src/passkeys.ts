// Passkeys, background side. All trust decisions are here and in the content script:
// the page's world only carries messages. A separate window asks the person, so a page
// can't cover it, and the private key is used only here.
import { b64u } from "../../../frontend/src/passwords/core/bytes";
import { type Item, type Passkey, newBody } from "../../../frontend/src/passwords/core/model";
import { getAssertion, makeCredential, rpIdAllowed, usablePasskeys } from "../../../frontend/src/passwords/core/passkey";
import type { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { ext } from "./rpc";

type Req = {
  id: string;
  op: "get" | "create";
  origin: string;
  topOrigin?: string;
  crossOrigin: boolean;
  options: Record<string, unknown>;
  windowId?: number;
  resolve: (r: Record<string, unknown>) => void;
};

const pending = new Map<string, Req>();

function allPasskeys(client: VaultClient): { itemId: string; passkey: Passkey; title: string }[] {
  const out: { itemId: string; passkey: Passkey; title: string }[] = [];
  for (const i of client.allItems()) for (const p of i.body.passkeys ?? []) out.push({ itemId: i.id, passkey: p, title: i.body.title });
  return out;
}

function fail(name: string, message: string) {
  return { ok: false, name, message };
}

async function openPrompt(id: string): Promise<number | undefined> {
  const win = await ext.windows.create({ url: ext.runtime.getURL(`passkey.html?id=${id}`), type: "popup", width: 440, height: 600, focused: true });
  return win?.id;
}

ext.windows?.onRemoved?.addListener((windowId) => {
  for (const r of pending.values()) {
    if (r.windowId === windowId) {
      pending.delete(r.id);
      r.resolve(fail("NotAllowedError", "The request wasn't allowed."));
    }
  }
});

function loginFor(client: VaultClient, rpId: string, userName: string): Item | undefined {
  return client.allItems().find((i) => i.body.kind === "login" && (i.body.urls ?? []).some((u) => {
    try {
      const h = new URL(u.url.includes("://") ? u.url : `https://${u.url}`).hostname;
      return h === rpId || h.endsWith(`.${rpId}`);
    } catch {
      return false;
    }
  }) && (!i.body.username || !userName || i.body.username === userName));
}

export async function handlePasskey(
  msg: { t: string; [k: string]: unknown },
  sender: chrome.runtime.MessageSender,
  client: () => VaultClient | null,
): Promise<unknown> {
  const isPrompt = !!sender.url && sender.url.startsWith(ext.runtime.getURL("passkey.html"));

  if (msg.t === "pkRequest") {
    // A content script speaks for its frame. The origin comes from the browser's record
    // of the sender, not from anything the message says.
    if (isPrompt || !sender.tab || !sender.url) return fail("NotAllowedError", "Not allowed.");
    const u = new URL(sender.url);
    const origin = u.origin;
    const op = msg.op as "get" | "create";
    const options = msg.options as Record<string, unknown>;
    const rp = op === "create" ? ((options.rp as { id?: string }).id ?? u.hostname) : ((options.rpId as string) ?? u.hostname);
    if (!rpIdAllowed(rp, origin)) return fail("SecurityError", "This site isn't allowed to use that RP ID.");
    const crossOrigin = msg.crossOrigin === true;
    const c = client();
    if (op === "create") {
      const algs = options.algs as number[];
      if (!algs.includes(-7)) return { ok: false, native: true };
      if (options.attachment === "cross-platform") return { ok: false, native: true };
      if (c?.unlocked) {
        const exclude = (options.exclude as { id: string }[]).map((x) => x.id);
        if (allPasskeys(c).some((p) => p.passkey.rpId === rp && exclude.includes(p.passkey.credentialId))) {
          return fail("InvalidStateError", "That passkey is already saved here.");
        }
      }
    } else if (c?.unlocked) {
      // Nothing of ours to offer: go straight to the browser's own.
      const usable = usablePasskeys(allPasskeys(c), rp, (options.allow as { id: string }[]).map((x) => x.id));
      if (!usable.length) return { ok: false, native: true };
    }
    const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
    return new Promise((resolve) => {
      const req: Req = { id, op, origin, crossOrigin, topOrigin: crossOrigin ? (msg.topOrigin as string | undefined) : undefined, options: { ...options, _rp: rp }, resolve };
      pending.set(id, req);
      openPrompt(id).then((windowId) => {
        req.windowId = windowId;
      });
    });
  }

  if (!isPrompt) return null;
  const req = pending.get(msg.id as string);
  if (!req) return { gone: true };
  const c = client();

  if (msg.t === "pkPrompt") {
    const rp = req.options._rp as string;
    const base = { op: req.op, origin: req.origin, rpId: rp, rpName: (req.options.rp as { name?: string } | undefined)?.name, unlocked: !!c?.unlocked, user: req.options.user };
    if (!c?.unlocked) return { ...base, candidates: [] };
    if (req.op === "get") {
      const usable = usablePasskeys(allPasskeys(c), rp, (req.options.allow as { id: string }[]).map((x) => x.id));
      return { ...base, candidates: usable.map((u) => ({ itemId: u.itemId, credentialId: u.passkey.credentialId, title: u.title, userName: u.passkey.userName })) };
    }
    return { ...base, candidates: [], existing: loginFor(c, rp, (req.options.user as { name: string }).name)?.body.title };
  }

  if (msg.t !== "pkAnswer") return null;
  const action = msg.action as string;
  const finish = (r: Record<string, unknown>) => {
    pending.delete(req.id);
    req.resolve(r);
    if (req.windowId !== undefined) ext.windows.remove(req.windowId).catch(() => undefined);
    return { done: true };
  };
  if (action === "cancel") return finish(fail("NotAllowedError", "The request wasn't allowed."));
  if (action === "native") return finish({ ok: false, native: true });
  if (!c?.unlocked) return { error: "locked" };

  const uv = true; // The vault's unlocked, and this person just confirmed it here.
  if (req.op === "create") {
    const o = req.options as { rp: { name?: string }; user: { id: string; name: string; displayName?: string }; challenge: string; residentKey: string; _rp: string };
    const made = await makeCredential({
      rpId: o._rp,
      rpName: o.rp.name,
      userHandle: o.user.id,
      userName: o.user.name,
      userDisplayName: o.user.displayName,
      challenge: o.challenge,
      origin: req.origin,
      crossOrigin: req.crossOrigin,
      topOrigin: req.topOrigin,
      uv,
      discoverable: o.residentKey !== "discouraged",
    });
    const existing = msg.attach ? loginFor(c, o._rp, o.user.name) : undefined;
    if (existing) {
      await c.update(existing.id, { ...existing.body, passkeys: [...(existing.body.passkeys ?? []), made.passkey] });
    } else {
      await c.saveNew(await c.personalVaultId(), newBody("passkey", o.rp.name || o._rp, { username: o.user.name, urls: [{ url: `https://${o._rp}` }], passkeys: [made.passkey] }));
    }
    c.sync().catch(() => undefined);
    const { passkey: _p, ...result } = made;
    return finish({ ok: true, result });
  }

  const o = req.options as { challenge: string; _rp: string; allow: { id: string }[] };
  const usable = usablePasskeys(allPasskeys(c), o._rp, o.allow.map((x) => x.id));
  const chosen = usable.find((u) => u.passkey.credentialId === msg.credentialId);
  if (!chosen) return finish(fail("NotAllowedError", "The request wasn't allowed."));
  const item = c.get(chosen.itemId);
  if (item?.body.reprompt && !msg.reprompted) return { error: "reprompt" };
  const result = await getAssertion({ passkey: chosen.passkey, challenge: o.challenge, origin: req.origin, crossOrigin: req.crossOrigin, topOrigin: req.topOrigin, uv });
  if (item) {
    const passkeys = (item.body.passkeys ?? []).map((p) => (p.credentialId === chosen.passkey.credentialId ? { ...p, lastUsedAt: new Date().toISOString() } : p));
    c.update(item.id, { ...item.body, passkeys }).then(() => c.sync()).catch(() => undefined);
  }
  return finish({ ok: true, result });
}
