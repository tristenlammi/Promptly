// The extension's keeper of keys. Chrome kills this service worker whenever it likes,
// Firefox runs it as an event page, so nothing here depends on staying alive: the
// unlock secret sits in storage.session (memory only, trusted contexts only, the
// default in both engines), and top-level listeners re-register on every start.
import { ApiError, OfflineError, VaultApi } from "../../../frontend/src/passwords/core/api";
import { fromB64u, b64u } from "../../../frontend/src/passwords/core/bytes";
import { decideOffer, type SaveOffer } from "../../../frontend/src/passwords/core/autofill/capture";
import { advance, flowFor, type TabFlow } from "../../../frontend/src/passwords/core/autofill/flow";
import { generateForSite } from "../../../frontend/src/passwords/core/generator";
import { baseDomain, hostOf, lookalikeOf, matchItems, matchUrl } from "../../../frontend/src/passwords/core/match";
import { type Item, type ItemBody, newBody, type SiteRule } from "../../../frontend/src/passwords/core/model";
import { IdbStore } from "../../../frontend/src/passwords/core/store";
import { totpCode } from "../../../frontend/src/passwords/core/totp";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { handlePasskey } from "./passkeys";
import { type Candidate, type ContentRequest, ext, type FillOutcome, type MenuRequest, type PageReport, type PageRequest, type SaveRequest, type StateOut, type ToContent } from "./rpc";

declare const __ENGINE__: string;

const store = new IdbStore("promptly-vault");
const KEEPALIVE = "keepalive";
const LOCK_ALARM = "autolock";
const SYNC_ALARM = "sync";

let serverUrl: string | null = null;
let token: string | null = null;
let userId: string | null = null;
let client: VaultClient | null = null;
let booted: Promise<void> | null = null;
const frameReports = new Map<string, PageReport>(); // `${tabId}:${frameId}`
let recents: Record<string, number> = {};

function makeClient(): VaultClient {
  const api = new VaultApi(serverUrl ?? "", () => token);
  return new VaultClient(api, store, __ENGINE__ === "firefox" ? "firefox" : "chromium");
}

/** storage.session survives a restart of this worker, and not a browser restart. */
const session = ext.storage.session;

async function saveSecret(secret: Uint8Array, sessionToken: string | null): Promise<void> {
  await session.set({ unlock: b64u(secret), vaultSession: sessionToken });
}

async function boot(): Promise<void> {
  booted ??= (async () => {
    serverUrl = (await store.getMeta<string>("server_url")) ?? null;
    token = (await store.getMeta<string>("device_token")) ?? null;
    userId = (await store.getMeta<string>("user_id")) ?? null;
    recents = (await store.getMeta<Record<string, number>>("recents")) ?? {};
    client = makeClient();
    const s = await session.get(["unlock", "vaultSession"]);
    if (s.unlock) {
      try {
        await client.restoreSession(fromB64u(s.unlock as string), (s.vaultSession as string) ?? null);
        startKeepAlive();
      } catch {
        await session.remove(["unlock", "vaultSession"]);
      }
    }
  })();
  return booted;
}

function startKeepAlive() {
  // An alarm every 30 s keeps Chrome from dropping the decrypted index between uses
  // while unlocked. If it's dropped anyway, boot() brings it back.
  ext.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  ext.alarms.create(SYNC_ALARM, { periodInMinutes: 1 });
}

async function settings(): Promise<{ autoLockMinutes: number; onClickOnly: boolean; neverHosts: string[] }> {
  return { autoLockMinutes: 15, onClickOnly: false, neverHosts: [], ...((await store.getMeta<object>("ext_settings")) ?? {}) };
}

async function touchLockTimer() {
  const s = await settings();
  ext.alarms.create(LOCK_ALARM, { delayInMinutes: s.autoLockMinutes });
}

async function lock() {
  await client?.lock().catch(() => undefined);
  await session.remove(["unlock", "vaultSession", "flows", "pendingSave"]);
  await ext.alarms.clear(KEEPALIVE);
  await ext.alarms.clear(LOCK_ALARM);
  await ext.alarms.clear(SYNC_ALARM);
  booted = null;
  client = makeClient();
  updateBadgeAll();
}

ext.alarms.onAlarm.addListener(async (a) => {
  await boot();
  if (a.name === LOCK_ALARM) await lock();
  if (a.name === SYNC_ALARM && client?.unlocked) await safeSync();
});

ext.idle.onStateChanged.addListener(async (state) => {
  // Locked screen or sleep: lock the vault too.
  if (state === "locked") {
    await boot();
    await lock();
  }
});

async function safeSync() {
  if (!client?.unlocked) return;
  try {
    await client.sync();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      try {
        await client.reprove();
        await session.set({ vaultSession: client.api.session });
        await client.sync();
      } catch {
        /* the token's revoked or the server's gone: keep working from the local copy */
      }
    }
  }
  // Open vault pages re-read the copy we share. Nobody listening is fine.
  ext.runtime.sendMessage({ t: "vaultChanged" }).catch(() => undefined);
}

// ---- Site access: everywhere after an explanation, or only on click -----------------

async function setSiteAccess(onClickOnly: boolean) {
  const s = await settings();
  await store.setMeta("ext_settings", { ...s, onClickOnly });
  await applySiteAccess();
}

async function applySiteAccess() {
  const s = await settings();
  const has = await ext.permissions.contains({ origins: ["https://*/*"] });
  const id = "promptly-fields";
  const existing = await ext.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
  if (s.onClickOnly || !has) {
    if (existing.length) await ext.scripting.unregisterContentScripts({ ids: [id] });
    return;
  }
  if (!existing.length) {
    await ext.scripting.registerContentScripts([{ id, js: ["content.js"], matches: ["https://*/*", "http://*/*"], allFrames: true, runAt: "document_start", persistAcrossSessions: true }]);
  }
  const mainId = "promptly-passkey";
  const hasMain = await ext.scripting.getRegisteredContentScripts({ ids: [mainId] }).catch(() => []);
  if (!hasMain.length) {
    await ext.scripting.registerContentScripts([{ id: mainId, js: ["passkey-main.js"], matches: ["https://*/*", "http://localhost/*", "http://*.localhost/*"], allFrames: true, runAt: "document_start", world: "MAIN", persistAcrossSessions: true } as chrome.scripting.RegisteredContentScript]);
  }
}

declare const __TEST_BUILD__: boolean;

ext.runtime.onInstalled.addListener(() => {
  applySiteAccess().catch(() => undefined);
  // WebDriver can't navigate Firefox to an extension page, so a test build opens one.
  if (__TEST_BUILD__ && __ENGINE__ === "firefox") ext.tabs.create({ url: ext.runtime.getURL("vault.html") });
  ext.contextMenus.removeAll(() => {
    ext.contextMenus.create({ id: "fill", title: "Fill from Promptly Passwords", contexts: ["editable"] });
    ext.contextMenus.create({ id: "generate", title: "Generate a password here", contexts: ["editable"] });
  });
});
ext.permissions.onAdded?.addListener(() => applySiteAccess().catch(() => undefined));
ext.runtime.onStartup?.addListener(() => applySiteAccess().catch(() => undefined));

// ---- Fill -----------------------------------------------------------------------------

function loginItems(): Item[] {
  return client?.unlocked ? client.allItems() : [];
}

function candidatesFor(url: string): Candidate[] {
  return matchItems(loginItems(), url, recents).map(({ item, downgrade }) => ({
    id: item.id,
    title: item.body.title,
    username: item.body.username ?? "",
    hasTotp: !!item.body.totp?.secret,
    kind: item.body.kind,
    downgrade,
    reprompt: !!item.body.reprompt,
  }));
}

function savedDomains(): string[] {
  const out: string[] = [];
  for (const i of loginItems()) for (const u of i.body.urls ?? []) {
    const h = hostOf(u.url);
    if (h) out.push(h);
  }
  return out;
}

async function frames(tabId: number): Promise<{ frameId: number; url: string; parentFrameId: number }[]> {
  try {
    const list = await ext.webNavigation.getAllFrames({ tabId });
    return (list ?? []).map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId }));
  } catch {
    return [{ frameId: 0, url: (await ext.tabs.get(tabId)).url ?? "", parentFrameId: -1 }];
  }
}

async function send<T>(tabId: number, frameId: number, msg: ToContent): Promise<T | undefined> {
  try {
    return (await ext.tabs.sendMessage(tabId, msg, { frameId })) as T;
  } catch {
    return undefined;
  }
}

/** Puts the content script in place if site access is "on click". */
async function ensureContent(tabId: number) {
  const pong = await send<PageReport>(tabId, 0, { t: "report" });
  if (pong) return;
  try {
    await ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch {
    /* a page the browser won't let anyone script */
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string): boolean {
  return baseDomain(a) !== null && baseDomain(a) === baseDomain(b);
}

/** Which roles from this form kind get which values from the item. */
async function valuesFor(body: ItemBody): Promise<Record<string, string>> {
  const v: Record<string, string> = {};
  const put = (k: string, x?: string | null) => {
    if (x) v[k] = x;
  };
  put("username", body.username);
  put("email", body.username?.includes("@") ? body.username : body.email);
  put("password", body.password);
  put("current-password", body.password);
  if (body.totp?.secret) v.otp = await totpCode(body.totp);
  put("card-number", body.cardNumber);
  put("card-name", body.cardholder);
  put("card-cvv", body.cardCvv);
  put("card-exp-month", body.cardExpMonth);
  put("card-exp-year", body.cardExpYear);
  if (body.cardExpMonth && body.cardExpYear) put("card-exp", `${body.cardExpMonth.padStart(2, "0")}/${body.cardExpYear.slice(-2)}`);
  put("first-name", body.firstName);
  put("last-name", body.lastName);
  if (body.firstName || body.lastName) put("full-name", [body.firstName, body.lastName].filter(Boolean).join(" "));
  put("address1", body.address1);
  put("address2", body.address2);
  put("city", body.city);
  put("state", body.state);
  put("postcode", body.postcode);
  put("country", body.country);
  put("phone", body.phone);
  put("company", body.company);
  if (body.kind === "identity") put("email", body.email);
  return v;
}

async function fill(tabId: number, itemId: string, opts: { confirmOrigin?: string; confirmDowngrade?: boolean; confirmLookalike?: boolean; confirmCard?: boolean; reprompted?: boolean; viaMenu?: boolean }): Promise<FillOutcome> {
  if (!client?.unlocked) return { ok: false, reason: "locked" };
  const item = client.get(itemId);
  if (!item) return { ok: false, reason: "no-fields" };
  if (item.body.reprompt && !opts.reprompted) return { ok: false, reason: "reprompt" };
  await ensureContent(tabId);

  const list = await frames(tabId);
  const reports: { frameId: number; url: string; report: PageReport }[] = [];
  for (const f of list) {
    const report = await send<PageReport>(tabId, f.frameId, { t: "report" });
    if (report && report.fieldCount > 0) reports.push({ frameId: f.frameId, url: report.url || f.url, report });
  }
  const top = list.find((f) => f.frameId === 0);
  const topUrl = top?.url ?? "";
  if (!reports.length) return { ok: false, reason: "no-fields" };

  // Cards and identities aren't tied to a site: they need a confirmation (the popup),
  // never one inline click.
  const siteless = item.body.kind === "card" || item.body.kind === "identity";
  if (siteless && !opts.confirmCard) return { ok: false, reason: "confirm-card" };

  // Which frame? Prefer one whose origin matches the item. A frame on a different
  // origin from the item needs a confirmation that shows the real origin.
  const urls = item.body.urls ?? [];
  const matching = reports.filter((r) => urls.some((u) => matchUrl(u, r.url)));
  let chosen = siteless ? reports[0] : matching.find((r) => r.frameId === 0) ?? matching[0];
  if (!chosen) {
    // No saved URL matches anywhere here: the person chose it by hand from the popup.
    chosen = reports.find((r) => r.frameId === 0) ?? reports[0];
    if (opts.confirmOrigin !== originOf(chosen.url)) return { ok: false, reason: "confirm-origin", origin: originOf(chosen.url) };
  } else if (chosen.frameId !== 0 && !siteless) {
    // In an iframe. Fine with no prompt only for an exact-host match to the item and
    // the same site as the page; anything looser shows the real origin first.
    const frameHost = hostOf(chosen.url) ?? "";
    const topHost = hostOf(topUrl) ?? "";
    const exact = urls.some((u) => hostOf(u.url) === frameHost);
    if ((!exact || !sameSite(frameHost, topHost)) && opts.confirmOrigin !== originOf(chosen.url)) {
      return { ok: false, reason: "confirm-origin", origin: originOf(chosen.url) };
    }
  }

  const host = hostOf(chosen.url) ?? "";
  if (!siteless) {
    // Saved over https, page on http.
    const scheme = originOf(chosen.url).split(":")[0];
    if (scheme === "http" && urls.some((u) => u.url.startsWith("https://") || !u.url.includes("://")) && !opts.confirmDowngrade) {
      return { ok: false, reason: "confirm-downgrade", origin: originOf(chosen.url) };
    }
    if (!matching.length && !opts.confirmLookalike) {
      const looks = lookalikeOf(host, savedDomains());
      if (looks) return { ok: false, reason: "confirm-lookalike", origin: originOf(chosen.url), lookalike: looks };
    }
  }

  const values = await valuesFor(item.body);
  const res = await send<{ filled: string[] }>(tabId, chosen.frameId, { t: "doFill", values });
  if (!res) return { ok: false, reason: "no-frame" };

  recents[itemId] = Date.now();
  await store.setMeta("recents", recents);
  await setFlow(tabId, { itemId, host, filled: res.filled, at: Date.now() });
  await touchLockTimer();

  let totpCopied = false;
  if (item.body.totp?.secret && !res.filled.includes("otp") && !res.filled.includes("otp-digit") && res.filled.length) {
    const copied = await send<boolean>(tabId, chosen.frameId, { t: "copy", text: values.otp });
    totpCopied = !!copied;
  }
  return { ok: true, filled: res.filled, totpCopied };
}

async function getFlows(): Promise<Record<string, TabFlow>> {
  return ((await session.get("flows")).flows as Record<string, TabFlow>) ?? {};
}

async function setFlow(tabId: number, flow: TabFlow) {
  const flows = await getFlows();
  flows[String(tabId)] = flow;
  await session.set({ flows });
}

// ---- Badge ---------------------------------------------------------------------------

async function updateBadge(tabId: number, url: string | undefined) {
  if (!url) return;
  const n = client?.unlocked ? candidatesFor(url).length : 0;
  await ext.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => undefined);
  await ext.action.setBadgeBackgroundColor({ tabId, color: "#D97757" }).catch(() => undefined);
}

function updateBadgeAll() {
  ext.tabs.query({}, (tabs) => {
    for (const t of tabs) if (t.id !== undefined) updateBadge(t.id, t.url);
  });
}

ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" || info.url) {
    boot().then(() => updateBadge(tabId, tab.url));
  }
});
ext.tabs.onRemoved.addListener(async (tabId) => {
  for (const k of frameReports.keys()) if (k.startsWith(`${tabId}:`)) frameReports.delete(k);
  const flows = await getFlows();
  delete flows[String(tabId)];
  await session.set({ flows });
});

// ---- Saving what someone typed --------------------------------------------------------

type PendingSave = { tabId: number; offer: SaveOffer; at: number };

async function pendingSave(tabId: number): Promise<PendingSave | null> {
  const list = ((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? [];
  const p = list.find((x) => x.tabId === tabId);
  return p && Date.now() - p.at < 5 * 60 * 1000 ? p : null;
}

async function setPending(tabId: number, offer: SaveOffer | null) {
  const list = (((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? []).filter((x) => x.tabId !== tabId);
  if (offer) list.push({ tabId, offer, at: Date.now() });
  await session.set({ pendingSave: list });
}

async function onCaptured(tabId: number, c: Extract<ContentRequest, { t: "captured" }>["capture"]) {
  if (!client?.unlocked) return;
  const s = await settings();
  const url = c.url;
  const existing = matchItems(loginItems(), url).map(({ item }) => ({ id: item.id, username: item.body.username, password: item.body.password }));
  const offer = decideOffer(c as Parameters<typeof decideOffer>[0], existing, s.neverHosts);
  await setPending(tabId, offer);
}

async function answerSave(tabId: number, answer: "save" | "update" | "never" | "dismiss") {
  const p = await pendingSave(tabId);
  await setPending(tabId, null);
  if (!p || !client?.unlocked) return;
  if (answer === "dismiss") return;
  if (answer === "never") {
    const s = await settings();
    await store.setMeta("ext_settings", { ...s, neverHosts: [...new Set([...s.neverHosts, p.offer.host])] });
    return;
  }
  if (p.offer.kind === "update" && p.offer.itemId) {
    const it = client.get(p.offer.itemId);
    if (it) await client.update(it.id, { ...it.body, password: p.offer.password, username: p.offer.username ?? it.body.username });
  } else {
    await client.saveNew(await client.personalVaultId(), newBody("login", p.offer.host.replace(/^www\./, ""), { username: p.offer.username, password: p.offer.password, urls: [{ url: `https://${p.offer.host}` }] }));
  }
  await safeSync();
  const tab = await ext.tabs.get(tabId).catch(() => null);
  updateBadge(tabId, tab?.url);
}

// ---- Messages --------------------------------------------------------------------------

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== ext.runtime.id) return false;
  const base = ext.runtime.getURL("");
  return !!sender.url && sender.url.startsWith(base);
}

/** Popup, full page and side panel: no tab, or a tab showing our own page. Our web
 *  accessible frames live in other pages' tabs, and only get MenuRequest. */
function isTrustedPage(sender: chrome.runtime.MessageSender): boolean {
  if (!isExtensionPage(sender)) return false;
  const url = sender.url ?? "";
  return !url.includes("/menu.html") && !url.includes("/save.html");
}

async function state(): Promise<StateOut> {
  const s = await settings();
  let preview = true;
  try {
    if (token && serverUrl) preview = (await client!.api.prelogin()).preview;
  } catch {
    /* offline: stay cautious */
  }
  return { connected: !!token && !!serverUrl, serverUrl, hasKit: client ? await client.hasDeviceKit() : false, unlocked: !!client?.unlocked, preview, onClickOnly: s.onClickOnly };
}

async function handlePage(m: PageRequest): Promise<unknown> {
  await boot();
  const c = client!;
  switch (m.t) {
    case "state":
      return state();
    case "unlock": {
      const r = await c.unlock(m.password, undefined, { keepSecret: true });
      await saveSecret(r.secret!, c.api.session);
      startKeepAlive();
      await touchLockTimer();
      updateBadgeAll();
      return { offline: r.offline };
    }
    case "lock":
      await lock();
      return { ok: true };
    case "session": {
      const s = await session.get(["unlock", "vaultSession"]);
      return { unlock: s.unlock ?? null, session: s.vaultSession ?? null };
    }
    case "list": {
      if (!c.unlocked) return [];
      await touchLockTimer();
      return c.search(m.query ?? "").slice(0, 200).map((i) => ({ id: i.id, title: i.body.title, username: i.body.username ?? "", kind: i.body.kind, hasTotp: !!i.body.totp?.secret, reprompt: !!i.body.reprompt }));
    }
    case "matches": {
      const tab = await ext.tabs.get(m.tabId);
      const url = m.url ?? tab.url ?? "";
      const host = hostOf(url);
      const lookalike = host && c.unlocked && !candidatesFor(url).length ? lookalikeOf(host, savedDomains()) : null;
      return { url, candidates: c.unlocked ? candidatesFor(url) : [], lookalike };
    }
    case "item":
      return c.unlocked ? (c.get(m.id)?.body ?? null) : null;
    case "totp": {
      const it = c.unlocked ? c.get(m.id) : undefined;
      if (!it?.body.totp) return null;
      return { code: await totpCode(it.body.totp), period: it.body.totp.steam ? 30 : it.body.totp.period ?? 30 };
    }
    case "fill":
      return fill(m.tabId, m.itemId, m);
    case "addLogin": {
      const it = await c.saveNew(await c.personalVaultId(), newBody("login", m.title, { username: m.username, password: m.password, urls: m.url ? [{ url: m.url }] : [] }));
      await safeSync();
      return { id: it.id };
    }
    case "check":
      return c.checkPassword(m.password);
    case "sync":
      // A page changed the offline copy we share: re-read it, then talk to the server.
      if (c.unlocked) await c.reload();
      await safeSync();
      return { ok: true };
    case "setAccess":
      await setSiteAccess(m.onClickOnly);
      return { ok: true };
    case "teach":
      await ensureContent(m.tabId);
      await send(m.tabId, 0, { t: "teachStart" });
      return { ok: true };
    case "reportForm":
      await ensureContent(m.tabId);
      return send<string>(m.tabId, 0, { t: "describeForm" });
    case "connected":
      await store.setMeta("server_url", m.serverUrl);
      await store.setMeta("device_token", m.token);
      await store.setMeta("device_id", m.deviceId);
      await store.setMeta("user_id", m.userId);
      booted = null;
      await boot();
      await applySiteAccess().catch(() => undefined);
      return { ok: true };
  }
}

async function handleContent(m: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await boot();
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  switch (m.t) {
    case "pageReport":
      frameReports.set(`${tabId}:${sender.frameId ?? 0}`, m.report);
      return null;
    case "hello": {
      const host = hostOf(m.url) ?? "";
      const rule = client?.unlocked ? findRule(host) : null;
      const pending = await pendingSave(tabId);
      return { rule, pendingSave: !!pending && (sender.frameId ?? 0) === 0, unlocked: !!client?.unlocked };
    }
    case "captured":
      await onCaptured(tabId, m.capture);
      return null;
    case "submitFailed":
      await setPending(tabId, null);
      return null;
    case "teachResult":
      if (client?.unlocked) {
        await client.saveNew(await client.personalVaultId(), newBody("site_rule", `Rule for ${m.rule.host}`, { rule: m.rule as SiteRule }));
        await safeSync();
      }
      return null;
  }
}

function findRule(host: string): SiteRule | null {
  if (!client?.unlocked) return null;
  const rules = client.allItems({ includeSystem: true }).filter((i) => i.body.kind === "site_rule" && i.body.rule).map((i) => i.body.rule!);
  let best: SiteRule | null = null;
  for (const r of rules) if (host === r.host || host.endsWith(`.${r.host}`)) if (!best || r.host.length > best.host.length) best = r;
  return best;
}

async function handleMenu(m: MenuRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await boot();
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  const parentFrame = (sender as { frameId?: number; parentFrameId?: number }).frameId;
  const frames_ = await frames(tabId);
  const me = frames_.find((f) => f.frameId === parentFrame);
  const hostFrame = me ? me.parentFrameId : 0;
  const url = frames_.find((f) => f.frameId === hostFrame)?.url ?? "";
  switch (m.t) {
    case "menuList": {
      if (!client?.unlocked) return { locked: true, candidates: [] };
      const flows = await getFlows();
      const flow = flowFor(flows[String(tabId)], hostOf(url) ?? "", sameSite);
      const list = candidatesFor(url);
      // Mid-flow, the item already chosen goes first.
      if (flow) list.sort((a, b) => (a.id === flow.itemId ? -1 : b.id === flow.itemId ? 1 : 0));
      const report = frameReports.get(`${tabId}:${hostFrame}`);
      return { locked: false, candidates: list, kinds: report?.kinds ?? [], url };
    }
    case "menuPick": {
      if (!client?.unlocked) return { ok: false, reason: "locked" };
      // The frame that hosts the menu re-checks that the menu's really visible.
      const check = await send<{ ok: boolean; reason?: string }>(tabId, hostFrame, { t: "menuCheck", itemId: m.itemId });
      if (!check?.ok) return { ok: false, reason: "popup", detail: check?.reason };
      const item = client.get(m.itemId);
      if (!item || item.body.kind === "card" || item.body.kind === "identity" || item.body.reprompt) return { ok: false, reason: "popup" };
      const flows = await getFlows();
      const r = await fill(tabId, m.itemId, { viaMenu: true });
      if (r.ok) {
        const flow = flows[String(tabId)];
        if (flow) await setFlow(tabId, advance(flow, r.filled));
      }
      return r.ok ? r : { ok: false, reason: "popup", detail: r.reason };
    }
    case "menuGenerate": {
      if (!client?.unlocked) return { ok: false };
      const host = hostOf(url);
      const password = generateForSite(host);
      // Saved straight away and marked pending: a failed sign-up can't lose it.
      await client.saveNew(await client.personalVaultId(), newBody("login", host?.replace(/^www\./, "") ?? "New login", { password, urls: url ? [{ url: originOf(url) }] : [], tags: ["unconfirmed sign-up"] }));
      await safeSync();
      await send(tabId, hostFrame, { t: "fillGenerated", password });
      return { ok: true };
    }
    case "menuClose":
      await send(tabId, hostFrame, { t: "report" });
      return null;
    case "menuOpenPopup":
      try {
        await (ext.action as unknown as { openPopup?: () => Promise<void> }).openPopup?.();
      } catch {
        /* needs a user gesture on some versions; the toolbar icon's still there */
      }
      return null;
  }
}

async function handleSave(m: SaveRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await boot();
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  if (m.t === "saveOffer") {
    const p = await pendingSave(tabId);
    // Only what's needed to ask: never the password back.
    return p ? { kind: p.offer.kind, username: p.offer.username ?? "", host: p.offer.host } : null;
  }
  await answerSave(tabId, m.answer);
  return null;
}

ext.runtime.onMessage.addListener((msg: { t: string }, sender, reply) => {
  if (sender.id !== ext.runtime.id) return false;
  const t = msg?.t ?? "";
  if (t === "vaultChanged") return false;
  let p: Promise<unknown>;
  if (t.startsWith("pk")) {
    p = boot().then(() => handlePasskey(msg as never, sender, () => client));
  } else if (t === "menuList" || t === "menuPick" || t === "menuGenerate" || t === "menuClose" || t === "menuOpenPopup") {
    if (!isExtensionPage(sender) || !(sender.url ?? "").includes("/menu.html")) return false;
    p = handleMenu(msg as MenuRequest, sender);
  } else if (t === "saveOffer" || t === "saveAnswer") {
    if (!isExtensionPage(sender) || !(sender.url ?? "").includes("/save.html")) return false;
    p = handleSave(msg as SaveRequest, sender);
  } else if (t === "pageReport" || t === "hello" || t === "captured" || t === "submitFailed" || t === "teachResult") {
    p = handleContent(msg as ContentRequest, sender);
  } else {
    if (!isTrustedPage(sender)) return false; // A content script can't ask for any of this.
    p = handlePage(msg as PageRequest);
  }
  p.then(
    (r) => reply({ ok: true, r }),
    (e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e), status: e instanceof ApiError ? e.status : undefined, offline: e instanceof OfflineError }),
  );
  return true;
});

ext.commands.onCommand.addListener(async (command, tab) => {
  await boot();
  const tabId = tab?.id ?? (await ext.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId === undefined) return;
  if (command === "open-menu") await send(tabId, 0, { t: "openMenu" });
  if (command === "fill-last") {
    const t = await ext.tabs.get(tabId);
    const best = candidatesFor(t.url ?? "")[0];
    if (best) await fill(tabId, best.id, {});
  }
  if (command === "generate" && client?.unlocked) {
    const t = await ext.tabs.get(tabId);
    const host = hostOf(t.url ?? "");
    const password = generateForSite(host);
    await client.saveNew(await client.personalVaultId(), newBody("login", host?.replace(/^www\./, "") ?? "New login", { password, urls: t.url ? [{ url: originOf(t.url) }] : [], tags: ["unconfirmed sign-up"] }));
    await safeSync();
    await send(tabId, 0, { t: "fillGenerated", password });
  }
});

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  await boot();
  if (!tab?.id) return;
  if (info.menuItemId === "fill") {
    const best = candidatesFor(tab.url ?? "")[0];
    if (best) await fill(tab.id, best.id, {});
    else await send(tab.id, info.frameId ?? 0, { t: "openMenu" });
  }
  if (info.menuItemId === "generate" && client?.unlocked) {
    const host = hostOf(tab.url ?? "");
    const password = generateForSite(host);
    await client.saveNew(await client.personalVaultId(), newBody("login", host?.replace(/^www\./, "") ?? "New login", { password, urls: tab.url ? [{ url: originOf(tab.url) }] : [], tags: ["unconfirmed sign-up"] }));
    await safeSync();
    await send(tab.id, info.frameId ?? 0, { t: "fillGenerated", password });
  }
});

export const _types = { userId } as const;
