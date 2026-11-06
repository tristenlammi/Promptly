// Passkeys, background side. All trust decisions are here and in the content script:
// the page's world only carries messages. A separate window asks the person, so a page
// can't cover it, and the private key is used only here.
import { b64u } from "../../../frontend/src/passwords/core/bytes";
import { type Item, type Passkey, newBody } from "../../../frontend/src/passwords/core/model";
import { getAssertion, makeCredential, rpIdAllowed, siteCredentialId, usablePasskeys } from "../../../frontend/src/passwords/core/passkey";
import type { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { ext } from "./rpc";

type Req = {
  id: string;
  tabId?: number;
  op: "get" | "create";
  origin: string;
  topOrigin?: string;
  crossOrigin: boolean;
  options: Record<string, unknown>;
  windowId?: number;
  resolve: (r: Record<string, unknown>) => void;
};

const pending = new Map<string, Req>();

/** A request a person can answer from the toolbar or the menu. Kept in session storage, since the
 *  worker can go at any time and the page will still be waiting. Holds nothing secret. */
type Offer = { key: string; tabId: number; frameId: number; documentId?: string; pageId: number; origin: string; topOrigin?: string; crossOrigin: boolean; options: Record<string, unknown>; rp: string };
const OFFERS_PER_TAB = 4;
let offerQueue: Promise<unknown> = Promise.resolve();

const readOffers = async () => ((await ext.storage.session.get("pkOffers")).pkOffers as Offer[] | undefined) ?? [];
/** One change at a time: a page can make several requests at once. */
function changeOffers(change: (now: Offer[]) => Offer[]): Promise<void> {
  const next = offerQueue.then(async () => {
    await ext.storage.session.set({ pkOffers: change(await readOffers()) });
  });
  offerQueue = next.catch(() => undefined);
  return next;
}

/** What can be offered on this tab now. Worked out at the time, so unlocking or a sync counts. */
export async function offerRows(tabId: number, c: VaultClient | null, frameId?: number) {
  if (!c?.unlocked) return [];
  const seen = new Set<string>();
  const rows: { key: string; credentialId: string; title: string; userName: string; rpId: string; origin: string }[] = [];
  for (const o of (await readOffers()).filter((x) => x.tabId === tabId && (frameId === undefined || x.frameId === frameId)).reverse()) {
    for (const u of usablePasskeys(allPasskeys(c), o.rp, (o.options.allow as { id: string }[]).map((x) => x.id))) {
      if (seen.has(u.passkey.credentialId)) continue;
      seen.add(u.passkey.credentialId);
      rows.push({ key: o.key, credentialId: u.passkey.credentialId, title: u.title, userName: u.passkey.userName, rpId: o.rp, origin: o.origin });
    }
  }
  return rows;
}

/** Opens the same window as any other sign-in, for this one passkey, and gives the page the
 *  answer if there is one. The request stays open if they cancel, as the browser's still is. */
export async function useOffer(tabId: number, key: string, credentialId: string) {
  const offer = (await readOffers()).find((o) => o.tabId === tabId && o.key === key);
  if (!offer) return { ok: false, reason: "gone" };
  if ([...pending.values()].some((r) => r.tabId === tabId)) return { ok: false, reason: "busy" };
  const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const req: Req = {
    id,
    tabId,
    op: "get",
    origin: offer.origin,
    crossOrigin: offer.crossOrigin,
    topOrigin: offer.topOrigin,
    options: { ...offer.options, _rp: offer.rp, _only: credentialId },
    resolve: (r) => {
      if (!r.ok) return;
      void changeOffers((now) => now.filter((o) => o.key !== key));
      ext.tabs.sendMessage(tabId, { t: "pkOfferResult", id: offer.pageId, result: r.result }, { frameId: offer.frameId, ...(offer.documentId ? { documentId: offer.documentId } : {}) }).catch(() => undefined);
    },
  };
  pending.set(id, req);
  req.windowId = await openPrompt(id);
  return { ok: true };
}

// A page that's gone can't be answered.
ext.webNavigation?.onCommitted?.addListener(({ tabId, frameId }) => {
  void changeOffers((now) => now.filter((o) => !(o.tabId === tabId && (frameId === 0 || o.frameId === frameId))));
});
ext.tabs?.onRemoved?.addListener((tabId) => {
  void changeOffers((now) => now.filter((o) => o.tabId !== tabId));
});

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

ext.tabs?.onRemoved?.addListener((tabId) => {
  for (const r of pending.values()) {
    if (r.tabId === tabId) {
      pending.delete(r.id);
      r.resolve(fail("NotAllowedError", "The request wasn't allowed."));
      if (r.windowId !== undefined) ext.windows.remove(r.windowId).catch(() => undefined);
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
  isThePerson: (c: VaultClient, typed: string) => Promise<boolean>,
  offersChanged: (tabId: number, url?: string) => void = () => undefined,
): Promise<unknown> {
  const isPrompt = !!sender.url && sender.url.startsWith(ext.runtime.getURL("passkey.html"));

  // From the toolbar panel only: a content script's sender is the web page it's in.
  if (msg.t === "pkOffers" || msg.t === "pkUseOffer") {
    if (!sender.url?.startsWith(ext.runtime.getURL("popup.html"))) return null;
    const tabId = msg.tabId as number;
    const c = client();
    if (msg.t === "pkUseOffer") return c?.unlocked ? useOffer(tabId, msg.key as string, msg.credentialId as string) : { ok: false, reason: "locked" };
    const offers = await offerRows(tabId, c);
    let saved: string | null = null;
    if (!offers.length && c?.unlocked) {
      // Saved for this site, and the site isn't asking. Otherwise it just looks broken.
      const tab = await ext.tabs.get(tabId).catch(() => null);
      let origin = "";
      try {
        origin = new URL(tab?.url ?? "").origin;
      } catch {
        /* not a page with an address */
      }
      if (origin && origin !== "null") saved = allPasskeys(c).find((p) => rpIdAllowed(p.passkey.rpId, origin))?.passkey.rpId ?? null;
    }
    return { offers, saved };
  }

  if (msg.t === "pkOffer" || msg.t === "pkOfferGone") {
    if (isPrompt || !sender.tab?.id || sender.frameId === undefined || !sender.url) return null;
    const tabId = sender.tab.id;
    const frameId = sender.frameId;
    const pageId = msg.id as number;
    if (typeof pageId !== "number") return null;
    if (msg.t === "pkOfferGone") {
      await changeOffers((now) => now.filter((o) => !(o.tabId === tabId && o.frameId === frameId && o.pageId === pageId)));
      offersChanged(tabId, sender.tab.url);
      return { ok: true };
    }
    const u = new URL(sender.url);
    const origin = (sender as { origin?: string }).origin ?? u.origin;
    const options = msg.options as Record<string, unknown>;
    if (origin === "null" || typeof options?.challenge !== "string" || !Array.isArray(options.allow)) return null;
    const rp = (options.rpId as string) ?? u.hostname;
    // A page can only ever offer itself. Another site's passkeys are never on the table.
    if (typeof rp !== "string" || !rpIdAllowed(rp, origin)) return null;
    const crossOrigin = msg.crossOrigin === true;
    const offer: Offer = { key: b64u(crypto.getRandomValues(new Uint8Array(16))), tabId, frameId, documentId: (sender as { documentId?: string }).documentId, pageId, origin, crossOrigin, topOrigin: crossOrigin ? (msg.topOrigin as string | undefined) : undefined, options, rp };
    await changeOffers((now) => {
      const others = now.filter((o) => o.tabId !== tabId);
      const here = now.filter((o) => o.tabId === tabId && !(o.frameId === frameId && o.pageId === pageId));
      return [...others, ...[...here, offer].slice(-OFFERS_PER_TAB)];
    });
    offersChanged(tabId, sender.tab.url);
    return { ok: true };
  }

  if (msg.t === "pkRequest") {
    // A content script speaks for its frame. The origin comes from the browser's record
    // of the sender, not from anything the message says.
    if (isPrompt || !sender.tab || !sender.url) return fail("NotAllowedError", "Not allowed.");
    const u = new URL(sender.url);
    const origin = (sender as { origin?: string }).origin ?? u.origin;
    // Nothing to offer a document with an opaque origin. The browser refuses it too.
    if (origin === "null") return { ok: false, native: true };
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
      // A known excluded id is only answered after the prompt, as a person answered it. An
      // instant error would tell a page, silently, which passkeys this vault holds.
    } else if (c?.unlocked) {
      // Nothing of ours to offer: go straight to the browser's own.
      const usable = usablePasskeys(allPasskeys(c), rp, (options.allow as { id: string }[]).map((x) => x.id));
      if (!usable.length) return { ok: false, native: true };
    }
    // One at a time from a tab: a page mustn't be able to bury someone in windows.
    if ([...pending.values()].some((r) => r.tabId === sender.tab!.id)) return fail("NotAllowedError", "Another request from this tab is waiting.");
    const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
    return new Promise((resolve) => {
      const req: Req = { id, tabId: sender.tab!.id, op, origin, crossOrigin, topOrigin: crossOrigin ? (msg.topOrigin as string | undefined) : undefined, options: { ...options, _rp: rp }, resolve };
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
    const base = { op: req.op, origin: req.origin, rpId: rp, unlocked: !!c?.unlocked, user: req.options.user, mustVerify: req.options.userVerification === "required" };
    if (!c?.unlocked) return { ...base, candidates: [] };
    if (req.op === "get") {
      const only = req.options._only as string | undefined;
      const usable = usablePasskeys(allPasskeys(c), rp, (req.options.allow as { id: string }[]).map((x) => x.id)).filter((u) => !only || u.passkey.credentialId === only);
      return { ...base, candidates: usable.map((u) => ({ itemId: u.itemId, credentialId: u.passkey.credentialId, title: u.title, userName: u.passkey.userName })) };
    }
    const exclude = (req.options.exclude as { id: string }[]).map((x) => x.id);
    const alreadySaved = allPasskeys(c).some((p) => p.passkey.rpId === rp && exclude.includes(siteCredentialId(p.passkey.credentialId)));
    return { ...base, candidates: [], alreadySaved, existing: loginFor(c, rp, (req.options.user as { name: string }).name)?.body.title };
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

  // User verification tells a site this person proved who they are. An unlocked vault and a
  // click don't. It's true only if they just proved it, here, in this window.
  const typed = typeof msg.verify === "string" ? msg.verify : "";
  const uv = !!typed && (await isThePerson(c, typed));
  if (typed && !uv) return { error: "wrong" };
  const mustVerify = req.options.userVerification === "required";
  if (mustVerify && !uv) return { error: "verify" };

  if (req.op === "create") {
    const o = req.options as { user: { id: string; name: string; displayName?: string }; challenge: string; residentKey: string; _rp: string; exclude: { id: string }[] };
    const excluded = o.exclude.map((x) => x.id);
    if (allPasskeys(c).some((p) => p.passkey.rpId === o._rp && excluded.includes(siteCredentialId(p.passkey.credentialId)))) return finish(fail("InvalidStateError", "That passkey is already saved here."));
    const made = await makeCredential({
      rpId: o._rp,
      // A site's own name for itself is whatever it likes. The RP ID has been checked.
      rpName: o._rp,
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
      await c.saveNew(await c.personalVaultId(), newBody("passkey", o._rp, { username: o.user.name, urls: [{ url: `https://${o._rp}` }], passkeys: [made.passkey] }));
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
  if (item?.body.reprompt && !uv) return { error: "verify" };
  const result = await getAssertion({ passkey: chosen.passkey, challenge: o.challenge, origin: req.origin, crossOrigin: req.crossOrigin, topOrigin: req.topOrigin, uv });
  if (item) {
    const passkeys = (item.body.passkeys ?? []).map((p) => (p.credentialId === chosen.passkey.credentialId ? { ...p, lastUsedAt: new Date().toISOString() } : p));
    c.update(item.id, { ...item.body, passkeys }).then(() => c.sync()).catch(() => undefined);
  }
  return finish({ ok: true, result });
}
