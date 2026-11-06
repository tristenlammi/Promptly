// The extension's keeper of keys. Chrome kills this service worker whenever it likes,
// Firefox runs it as an event page, so nothing here depends on staying alive: the
// unlock secret sits in storage.session (memory only, trusted contexts only, the
// default in both engines), and top-level listeners re-register on every start.
import jsQR from "jsqr";

import { agoText, commitPending, linkIsSafe, type MailCode, rankMailCodes, savedDomainsOf, unwrapUnlockSecret, withPending, wrapUnlockSecret } from "../../../frontend/src/passwords/core/connections";
import { parseOtpauth } from "../../../frontend/src/passwords/core/totp";
import { argon2, KDF_FLOOR } from "../../../frontend/src/passwords/core/primitives";
import { ApiError, OfflineError, VaultApi } from "../../../frontend/src/passwords/core/api";
import { fromB64u, b64u, randomBytes, utf8 } from "../../../frontend/src/passwords/core/bytes";
import { decideOffer, type SaveOffer } from "../../../frontend/src/passwords/core/autofill/capture";
import { afterFill, codeStep, flowFor, mayFillOnLoad, type TabFlow } from "../../../frontend/src/passwords/core/autofill/flow";
import { openSignedPack, ruleForHost } from "../../../frontend/src/passwords/core/autofill/rules";
import { generateForSite, plusAddress } from "../../../frontend/src/passwords/core/generator";
import { baseDomain, hostOf, lookalikeOf, matchItems, matchUrl } from "../../../frontend/src/passwords/core/match";
import { type Item, type ItemBody, newBody, type SiteRule } from "../../../frontend/src/passwords/core/model";
import { IdbStore } from "../../../frontend/src/passwords/core/store";
import { totpCode } from "../../../frontend/src/passwords/core/totp";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { canCheckClipboard, CLIP_ALARM, clearClipboardIfOurs, clipboardTest, watchClipboard, writeClipboard } from "./clipboard";
import { handlePasskey } from "./passkeys";
import { packPublicKey } from "./rules-key";
import { type Candidate, type ContentRequest, ext, type FillOutcome, type MenuRequest, type PageReport, type PageRequest, type SaveRequest, type StateOut, type ToContent } from "./rpc";

declare const __ENGINE__: string;

const store = new IdbStore("promptly-vault");
const KEEPALIVE = "keepalive";
const LOCK_ALARM = "autolock";
const SYNC_ALARM = "sync";
/** Alarms run every 30 to 60 s. A gap this long means the machine was asleep. */
const SLEEP_GAP_MS = 3 * 60 * 1000;
const UNCONFIRMED_TAG = "unconfirmed sign-up";
const TYPED_USER_MS = 5 * 60 * 1000;

let serverUrl: string | null = null;
let token: string | null = null;
let userId: string | null = null;
let client: VaultClient | null = null;
let booted: Promise<void> | null = null;
const frameReports = new Map<string, PageReport>(); // `${tabId}:${frameId}`
/** Re-reading the shared copy empties the index first. Nothing should answer from it until
 *  that's done: a popup asking then gets an empty list, and doesn't ask again. */
let reloading: Promise<unknown> = Promise.resolve();
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
        // Never unlocked with no timer running, whatever happened to the last one.
        if (!(await ext.alarms.get(LOCK_ALARM))) await touchLockTimer();
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

type ExtSettings = { onClickOnly: boolean; neverHosts: string[]; mailCodes: boolean };

/** What only this extension has. */
async function extSettings(): Promise<ExtSettings> {
  return { onClickOnly: false, neverHosts: [], mailCodes: false, ...((await store.getMeta<Partial<ExtSettings>>("ext_settings")) ?? {}) };
}

/** The vault page's Settings screen writes these to the copy we share (kit.tsx). */
async function vaultSettings(): Promise<{ autoLockMinutes: number; lockOnSleep: boolean; clipboardSeconds: number }> {
  const s = (await store.getMeta<{ autoLockMinutes?: unknown; lockOnSleep?: unknown; clipboardSeconds?: unknown }>("settings")) ?? {};
  const number = (v: unknown, fallback: number, min: number) => (typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback);
  return { autoLockMinutes: number(s.autoLockMinutes, 15, 1), lockOnSleep: s.lockOnSleep !== false, clipboardSeconds: number(s.clipboardSeconds, 30, 1) };
}

async function touchLockTimer() {
  const s = await vaultSettings();
  ext.alarms.create(LOCK_ALARM, { delayInMinutes: s.autoLockMinutes });
}

async function lock() {
  const wasOpen = !!client?.unlocked;
  await client?.lock().catch(() => undefined);
  await session.remove(["unlock", "vaultSession", "flows", "pendingSave", "typedUsers", "deviceRequests", "beat", "onLoadDone"]);
  await ext.alarms.clear(KEEPALIVE);
  await ext.alarms.clear(LOCK_ALARM);
  await ext.alarms.clear(SYNC_ALARM);
  booted = null;
  client = makeClient();
  // Nothing we copied should outlast the lock.
  await clearClipboardIfOurs().catch(() => undefined);
  updateBadgeAll();
  // A vault page has its own keys in memory, and goes back to its locked screen.
  if (wasOpen) ext.runtime.sendMessage({ t: "locked" }).catch(() => undefined);
}

/** Firefox doesn't report "locked" from the idle API, and sleep isn't always reported
 *  on Chromium either. A timer that fires far later than asked means the machine slept. */
async function noticeSleep() {
  const now = Date.now();
  const { beat } = await session.get("beat");
  await session.set({ beat: now });
  if (typeof beat === "number" && now - beat > SLEEP_GAP_MS && client?.unlocked && (await vaultSettings()).lockOnSleep) await lock();
}

async function onIdleState(state: string) {
  // Locked screen or sleep: lock the vault too, unless the person said not to.
  if (state !== "locked") return;
  await boot();
  if ((await vaultSettings()).lockOnSleep) await lock();
}

ext.alarms.onAlarm.addListener(async (a) => {
  await boot();
  if (a.name === LOCK_ALARM) await lock();
  if (a.name === KEEPALIVE) await noticeSleep();
  if (a.name === CLIP_ALARM) await clearClipboardIfOurs();
  if (a.name === SYNC_ALARM && client?.unlocked) {
    await safeSync();
    await refreshDeviceRequests();
  }
});

ext.idle.onStateChanged.addListener((state) => void onIdleState(state));

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

// ---- A new device asking to join (plan 3.4) ----------------------------------------------

async function refreshDeviceRequests() {
  if (!client?.unlocked) return;
  let count: number;
  try {
    count = (await client.api.deviceRequests()).length;
  } catch {
    return; // Offline, or the session needs proving again: the next sync sorts that out.
  }
  const before = (await session.get("deviceRequests")).deviceRequests ?? 0;
  if (count === before) return;
  await session.set({ deviceRequests: count });
  updateBadgeAll();
}

// ---- Site access: everywhere after an explanation, or only on click -----------------

const ALL_SITES = ["https://*/*", "http://*/*"];
const FIELDS_SCRIPT = "promptly-fields";
const PASSKEY_SCRIPT = "promptly-passkey";

async function hasAllSites(): Promise<boolean> {
  return ext.permissions.contains({ origins: ALL_SITES });
}

async function setSiteAccess(onClickOnly: boolean) {
  const s = await extSettings();
  await store.setMeta("ext_settings", { ...s, onClickOnly });
  await applySiteAccess();
}

/** On click is the setting, or the browser hasn't given us every site. */
async function fillsOnClickOnly(): Promise<boolean> {
  return (await extSettings()).onClickOnly || !(await hasAllSites());
}

let accessQueue: Promise<unknown> = Promise.resolve();

/** Several events can ask at once, and registering a script twice throws. */
function applySiteAccess(): Promise<void> {
  const run = accessQueue.then(applySiteAccessNow, applySiteAccessNow);
  accessQueue = run.catch(() => undefined);
  return run;
}

async function applySiteAccessNow() {
  const registered = new Set((await ext.scripting.getRegisteredContentScripts().catch(() => [])).map((x) => x.id));
  if (await fillsOnClickOnly()) {
    // The passkey wrapper is useless without the fields script, which is its bridge, so
    // neither stays. WebAuthn then belongs to the browser alone (DECISIONS).
    const drop = [FIELDS_SCRIPT, PASSKEY_SCRIPT].filter((id) => registered.has(id));
    if (drop.length) await ext.scripting.unregisterContentScripts({ ids: drop });
    return;
  }
  if (!registered.has(FIELDS_SCRIPT)) {
    await ext.scripting.registerContentScripts([{ id: FIELDS_SCRIPT, js: ["content.js"], matches: ALL_SITES, allFrames: true, runAt: "document_start", persistAcrossSessions: true }]);
  }
  if (!registered.has(PASSKEY_SCRIPT)) {
    await ext.scripting.registerContentScripts([{ id: PASSKEY_SCRIPT, js: ["passkey-main.js"], matches: ["https://*/*", "http://localhost/*", "http://*.localhost/*"], allFrames: true, runAt: "document_start", world: "MAIN", persistAcrossSessions: true } as chrome.scripting.RegisteredContentScript]);
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
ext.permissions.onRemoved?.addListener(() => applySiteAccess().catch(() => undefined));
ext.runtime.onStartup?.addListener(() => applySiteAccess().catch(() => undefined));

// ---- Fill -----------------------------------------------------------------------------

function loginItems(): Item[] {
  return client?.unlocked ? client.allItems() : [];
}

function canReveal(item: Item): boolean {
  return client?.canReveal(item.vaultId) ?? false;
}

function candidatesFor(url: string): Candidate[] {
  return matchItems(loginItems(), url, recents).map(({ item, downgrade }) => ({
    id: item.id,
    title: item.body.title,
    username: item.body.username ?? "",
    // A fill-only member can fill a code, and can't be shown one.
    hasTotp: !!item.body.totp?.secret && canReveal(item),
    kind: item.body.kind,
    downgrade,
    reprompt: !!item.body.reprompt,
  }));
}

/** Mid-flow, the item already chosen goes first (plan 6.3). */
async function orderedCandidates(tabId: number, url: string): Promise<Candidate[]> {
  const list = candidatesFor(url);
  const flow = flowFor((await getFlows())[String(tabId)], hostOf(url) ?? "", sameSite);
  if (flow) list.sort((a, b) => (a.id === flow.itemId ? -1 : b.id === flow.itemId ? 1 : 0));
  return list;
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

/** The last report from a frame, or a fresh one: a restarted worker has none. */
async function reportOf(tabId: number, frameId: number): Promise<PageReport | undefined> {
  return frameReports.get(`${tabId}:${frameId}`) ?? send<PageReport>(tabId, frameId, { t: "report" });
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
  // Changing it on the site: the new one was saved first, so this can't lose it.
  put("new-password", body.pendingPassword);
  put("confirm-password", body.pendingPassword);
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

/** Only what a frame has boxes for. A frame holding the security code box never gets the
 *  card number, whatever else was approved. */
function valuesForRoles(values: Record<string, string>, roles: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of roles) {
    if (values[role]) out[role] = values[role];
    if (role === "otp-digit" && values.otp) out.otp = values.otp;
    // Each stands in for the other when filling.
    if (role === "email" && values.username) out.username = values.username;
    if (role === "username" && values.email) out.email = values.email;
  }
  return out;
}

const hasValueFor = (values: Record<string, string>, roles: string[]) => Object.keys(valuesForRoles(values, roles)).length > 0;

type FillOptions = {
  confirmOrigin?: string;
  confirmDowngrade?: boolean;
  confirmLookalike?: boolean;
  confirmCard?: boolean;
  confirmFrames?: string[];
  reprompted?: boolean;
  /** The menu's frame, or the top page on load: those fill there and nowhere else. */
  onlyFrame?: number;
};

type FrameFill = { frameId: number; url: string; roles: string[] };

async function fill(tabId: number, itemId: string, opts: FillOptions): Promise<FillOutcome> {
  if (!client?.unlocked) return { ok: false, reason: "locked" };
  const item = client.get(itemId);
  if (!item) return { ok: false, reason: "no-fields" };
  if (item.body.reprompt && !opts.reprompted) return { ok: false, reason: "reprompt" };
  await ensureContent(tabId);

  const list = await frames(tabId);
  const asked = await Promise.all(list.map(async (f) => ({ f, report: await send<PageReport>(tabId, f.frameId, { t: "report", fresh: true }) })));
  const reports = asked
    .filter(({ f, report }) => report && report.fieldCount > 0 && (opts.onlyFrame === undefined || f.frameId === opts.onlyFrame))
    .map(({ f, report }) => ({ frameId: f.frameId, url: report!.url || f.url, report: report! }));
  const topUrl = list.find((f) => f.frameId === 0)?.url ?? "";
  if (!reports.length) return { ok: false, reason: "no-fields" };

  const values = await valuesFor(item.body);
  // Cards and identities aren't tied to a site: they need a confirmation (the popup),
  // never one inline click. Hosted card fields often sit in a frame each, so every frame
  // with a box for this item takes part, and each frame on another origin is named first.
  const siteless = item.body.kind === "card" || item.body.kind === "identity";
  let targets: FrameFill[];
  let host: string;

  if (siteless) {
    const usable = reports.filter((r) => hasValueFor(values, r.report.roles));
    if (!usable.length) return { ok: false, reason: "no-fields" };
    const others = [...new Set(usable.map((r) => originOf(r.url)).filter((o) => o !== originOf(topUrl)))];
    if (!opts.confirmCard || others.some((o) => !opts.confirmFrames?.includes(o))) return { ok: false, reason: "confirm-card", frames: others };
    targets = usable.map((r) => ({ frameId: r.frameId, url: r.url, roles: r.report.roles }));
    host = hostOf(topUrl) ?? "";
  } else {
    // Which frame? Prefer one whose origin matches the item. A frame on a different
    // origin from the item needs a confirmation that shows the real origin.
    const urls = item.body.urls ?? [];
    const exactHost = (url: string) => {
      const h = hostOf(url) ?? "";
      return urls.some((u) => hostOf(u.url) === h);
    };
    // No prompt in an iframe only for an exact-host match to the item, on the page's site.
    const frameIsPlain = (r: { frameId: number; url: string }) => r.frameId === 0 || (exactHost(r.url) && sameSite(hostOf(r.url) ?? "", hostOf(topUrl) ?? ""));
    const matching = reports.filter((r) => urls.some((u) => matchUrl(u, r.url)));
    let chosen = matching.find((r) => r.frameId === 0) ?? matching[0];
    if (!chosen) {
      // No saved URL matches anywhere here: the person chose it by hand from the popup.
      chosen = reports.find((r) => r.frameId === 0) ?? reports[0];
      if (opts.confirmOrigin !== originOf(chosen.url)) return { ok: false, reason: "confirm-origin", origin: originOf(chosen.url) };
    } else if (!frameIsPlain(chosen) && opts.confirmOrigin !== originOf(chosen.url)) {
      return { ok: false, reason: "confirm-origin", origin: originOf(chosen.url) };
    }

    host = hostOf(chosen.url) ?? "";
    // Saved over https, page on http.
    const scheme = originOf(chosen.url).split(":")[0];
    if (scheme === "http" && urls.some((u) => u.url.startsWith("https://") || !u.url.includes("://")) && !opts.confirmDowngrade) {
      return { ok: false, reason: "confirm-downgrade", origin: originOf(chosen.url) };
    }
    if (!matching.length && !opts.confirmLookalike) {
      const looks = lookalikeOf(host, savedDomains());
      if (looks) return { ok: false, reason: "confirm-lookalike", origin: originOf(chosen.url), lookalike: looks };
    }

    // A login split across frames: the rest of it, only from frames that pass with no
    // prompt, and only the boxes the first frame doesn't have.
    const chosenFrame = chosen;
    targets = [{ frameId: chosen.frameId, url: chosen.url, roles: chosen.report.roles }];
    for (const r of matching) {
      if (r.frameId === chosenFrame.frameId || !frameIsPlain(r)) continue;
      const missing = r.report.roles.filter((role) => !chosenFrame.report.roles.includes(role));
      if (hasValueFor(values, missing)) targets.push({ frameId: r.frameId, url: r.url, roles: missing });
    }
  }

  // One frame at a time: filling moves focus, and frames at once fight over it.
  const answers: ({ filled: string[] } | undefined)[] = [];
  for (const t of targets) {
    const answer = await send<{ filled: string[] }>(tabId, t.frameId, { t: "doFill", values: valuesForRoles(values, t.roles) });
    answers.push(answer);
    if (__TEST_BUILD__) testLog.doFills.push({ tabId, url: t.url, keys: Object.keys(valuesForRoles(values, t.roles)), filled: answer?.filled });
  }
  if (answers.every((a) => !a)) return { ok: false, reason: "no-frame" };
  const filled = [...new Set(answers.flatMap((a) => a?.filled ?? []))];
  if (!filled.length) return { ok: false, reason: "no-fields" };

  recents[itemId] = Date.now();
  await store.setMeta("recents", recents);
  const flows = await getFlows();
  flows[String(tabId)] = afterFill(flows[String(tabId)], itemId, host, filled, sameSite);
  await session.set({ flows });
  await touchLockTimer();
  return { ok: true, filled };
}

async function getFlows(): Promise<Record<string, TabFlow>> {
  return ((await session.get("flows")).flows as Record<string, TabFlow>) ?? {};
}

// ---- 2FA after sign-in (plan 6.3) --------------------------------------------------------

const codeTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** The page changed, and a sign-in may have moved on. Waits a moment, since pages draw
 *  their code box late, and doesn't restart for a page that won't stop changing. */
function scheduleCodeStep(tabId: number) {
  if (codeTimers.has(tabId)) return;
  codeTimers.set(
    tabId,
    setTimeout(() => {
      codeTimers.delete(tabId);
      runCodeStep(tabId).catch(() => undefined);
    }, 1200),
  );
}

async function runCodeStep(tabId: number) {
  if (!client?.unlocked) return;
  const flows = await getFlows();
  const tab = await ext.tabs.get(tabId).catch(() => null);
  const flow = flowFor(flows[String(tabId)], hostOf(tab?.url ?? "") ?? "", sameSite);
  if (!flow || flow.otpDone) return;
  const item = client.get(flow.itemId);
  // Fill-only members aren't shown codes, and the clipboard is showing.
  const hasTotp = !!item?.body.totp?.secret && canReveal(item);
  if (!hasTotp) return;
  const list = await frames(tabId);
  const reports = await Promise.all(list.map((f) => send<PageReport>(tabId, f.frameId, { t: "report", fresh: true })));
  if (!reports[list.findIndex((f) => f.frameId === 0)]) return; // A page we can't read tells us nothing.
  const roles = reports.flatMap((r) => r?.roles ?? []);
  const step = codeStep(flow, hasTotp, {
    hasCodeField: roles.includes("otp") || roles.includes("otp-digit"),
    hasPasswordField: roles.includes("password") || roles.includes("current-password"),
  });
  if (step !== "copy") return;
  flows[String(tabId)] = { ...flow, otpDone: true };
  await session.set({ flows });
  const code = await totpCode(item!.body.totp!);
  if (!(await writeClipboard(code))) return;
  const { clipboardSeconds } = await vaultSettings();
  await watchClipboard(code, clipboardSeconds);
  const text = `2FA code copied. Clears in ${clipboardSeconds} seconds.`;
  if (__TEST_BUILD__) testLog.notices.push(text);
  await send(tabId, 0, { t: "notice", text });
}

// ---- Badge ---------------------------------------------------------------------------

async function updateBadge(tabId: number, url: string | undefined) {
  if (!url) return;
  const asking = client?.unlocked ? ((await session.get("deviceRequests")).deviceRequests ?? 0) : 0;
  if (asking) {
    await ext.action.setBadgeText({ tabId, text: "!" }).catch(() => undefined);
    await ext.action.setBadgeBackgroundColor({ tabId, color: "#B3261E" }).catch(() => undefined);
    await ext.action.setTitle({ tabId, title: "Promptly Passwords: a new device is asking to join" }).catch(() => undefined);
    return;
  }
  const n = client?.unlocked ? candidatesFor(url).length : 0;
  await ext.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => undefined);
  await ext.action.setBadgeBackgroundColor({ tabId, color: "#D97757" }).catch(() => undefined);
  await ext.action.setTitle({ tabId, title: "Promptly Passwords" }).catch(() => undefined);
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
  const typed = await typedUsers();
  delete typed[String(tabId)];
  await session.set({ typedUsers: typed });
});

// Single-page apps change route with no load. Tell that frame to look again, within its
// own budget. onHistoryStateUpdated is the only way to see pushState from outside the page.
ext.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  void send(tabId, frameId, { t: "routeChanged" });
});

// ---- Saving what someone typed --------------------------------------------------------

type PendingSave = { tabId: number; offer: SaveOffer; submittedKind: string; at: number };
type TypedUser = { username: string; host: string; at: number };

async function pendingSave(tabId: number): Promise<PendingSave | null> {
  const list = ((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? [];
  const p = list.find((x) => x.tabId === tabId);
  return p && Date.now() - p.at < 5 * 60 * 1000 ? p : null;
}

async function setPending(tabId: number, offer: SaveOffer | null, submittedKind = "signin") {
  const list = (((await session.get("pendingSave")).pendingSave as PendingSave[]) ?? []).filter((x) => x.tabId !== tabId);
  if (offer) list.push({ tabId, offer, submittedKind, at: Date.now() });
  await session.set({ pendingSave: list });
}

async function typedUsers(): Promise<Record<string, TypedUser>> {
  return ((await session.get("typedUsers")).typedUsers as Record<string, TypedUser>) ?? {};
}

/** The username step of a sign-in spread over two pages. Kept per tab, session only. */
async function rememberTyped(tabId: number, username: string, url: string | undefined) {
  if (!client?.unlocked) return;
  const typed = await typedUsers();
  typed[String(tabId)] = { username, host: hostOf(url ?? "") ?? "", at: Date.now() };
  await session.set({ typedUsers: typed });
}

async function onCaptured(tabId: number, c: Extract<ContentRequest, { t: "captured" }>["capture"], senderUrl: string | undefined) {
  if (!client?.unlocked) return;
  const s = await extSettings();
  const url = c.url;
  if (!c.username) {
    const typed = (await typedUsers())[String(tabId)];
    const host = hostOf(senderUrl ?? url) ?? "";
    if (typed && Date.now() - typed.at < TYPED_USER_MS && (typed.host === host || sameSite(typed.host, host))) c.username = typed.username;
  }
  const existing = matchItems(loginItems(), url).map(({ item }) => ({
    id: item.id,
    username: item.body.username,
    password: item.body.password,
    pendingPassword: item.body.pendingPassword,
    unconfirmed: item.body.tags?.includes(UNCONFIRMED_TAG),
  }));
  const offer = decideOffer(c as Parameters<typeof decideOffer>[0], existing, s.neverHosts);
  await setPending(tabId, offer, c.kind);
  if (!offer) return;
  // If the page has moved on already, its "hello" came too soon to know about this.
  const tab = await ext.tabs.get(tabId).catch(() => null);
  if (tab?.url && tab.url !== url) await send(tabId, 0, { t: "showSave", kind: c.kind });
}

async function answerSave(tabId: number, answer: "save" | "update" | "never" | "dismiss") {
  const p = await pendingSave(tabId);
  await setPending(tabId, null);
  await send(tabId, 0, { t: "hideSave" });
  if (!p || !client?.unlocked) return;
  if (answer === "dismiss") return;
  if (answer === "never") {
    const s = await extSettings();
    await store.setMeta("ext_settings", { ...s, neverHosts: [...new Set([...s.neverHosts, p.offer.host])] });
    return;
  }
  const it = p.offer.itemId ? client.get(p.offer.itemId) : undefined;
  if (it && p.offer.generated === "signup") {
    // The site took the password we saved for it: now it's a login like any other.
    await client.update(it.id, { ...it.body, username: p.offer.username ?? it.body.username, tags: (it.body.tags ?? []).filter((x) => x !== UNCONFIRMED_TAG) });
  } else if (it && p.offer.generated === "change") {
    await client.update(it.id, commitPending(it.body));
  } else if (p.offer.kind === "update" && it) {
    await client.update(it.id, { ...it.body, password: p.offer.password, username: p.offer.username ?? it.body.username });
  } else {
    await client.saveNew(await client.personalVaultId(), newBody("login", p.offer.host.replace(/^www\./, ""), { username: p.offer.username, password: p.offer.password, urls: [{ url: `https://${p.offer.host}` }] }));
  }
  const typed = await typedUsers();
  delete typed[String(tabId)];
  await session.set({ typedUsers: typed });
  await safeSync();
  const tab = await ext.tabs.get(tabId).catch(() => null);
  updateBadge(tabId, tab?.url);
}

// ---- Generating a password into a page ----------------------------------------------------

/** Saved before it goes on the page, so a failed submit can't lose it. On a change form
 *  it's waiting on an existing login. Otherwise it's a new login, tagged until the site
 *  takes it, and trying again reuses that one rather than leaving a trail of them. */
async function generateInto(tabId: number, frameId: number, url: string, chosen?: string): Promise<void> {
  const c = client!;
  const host = hostOf(url);
  const password = generateForSite(host);
  const report = await reportOf(tabId, frameId);
  let target: Item | undefined;
  if (report?.kinds.includes("change-password")) {
    const list = await orderedCandidates(tabId, url);
    const id = chosen && list.some((x) => x.id === chosen) ? chosen : list[0]?.id;
    target = id ? c.get(id) : undefined;
  }
  // Someone who can't edit a shared login can't change it. They get a login of their own.
  const role = target ? (await c.vaults()).find((v) => v.id === target.vaultId)?.role : undefined;
  if (target && (role === "manage" || role === "edit")) {
    await c.update(target.id, withPending(target.body, password));
  } else {
    const origin = originOf(url);
    const waiting = loginItems().find((i) => i.body.tags?.includes(UNCONFIRMED_TAG) && !i.body.username && (i.body.urls ?? []).some((u) => originOf(u.url) === origin));
    if (waiting) await c.update(waiting.id, { ...waiting.body, password });
    else await c.saveNew(await c.personalVaultId(), newBody("login", host?.replace(/^www\./, "") ?? "New login", { password, urls: url ? [{ url: origin }] : [], tags: [UNCONFIRMED_TAG] }));
  }
  await safeSync();
  await send(tabId, frameId, { t: "fillGenerated", password });
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

/** Asks the server once a session, so opening the popup doesn't wait on the network. */
async function previewFlag(): Promise<boolean> {
  const known = (await session.get("preview")).preview;
  if (typeof known === "boolean") return known;
  try {
    if (token && serverUrl) {
      const { preview } = await client!.api.prelogin();
      await session.set({ preview });
      return preview;
    }
  } catch {
    /* offline: stay cautious */
  }
  return true;
}

async function state(): Promise<StateOut> {
  const unlocked = !!client?.unlocked;
  if (unlocked) void refreshDeviceRequests();
  return {
    connected: !!token && !!serverUrl,
    serverUrl,
    hasKit: client ? await client.hasDeviceKit() : false,
    unlocked,
    preview: await previewFlag(),
    onClickOnly: await fillsOnClickOnly(),
    deviceRequests: unlocked ? Number((await session.get("deviceRequests")).deviceRequests ?? 0) : 0,
  };
}

async function handlePage(m: PageRequest): Promise<unknown> {
  await boot();
  await reloading;
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
      return c.search(m.query ?? "").slice(0, 200).map((i) => ({ id: i.id, title: i.body.title, username: i.body.username ?? "", kind: i.body.kind, hasTotp: !!i.body.totp?.secret && c.canReveal(i.vaultId), reprompt: !!i.body.reprompt }));
    }
    case "matches": {
      const tab = await ext.tabs.get(m.tabId);
      const url = m.url ?? tab.url ?? "";
      const host = hostOf(url);
      if (c.unlocked) await touchLockTimer();
      const lookalike = host && c.unlocked && !candidatesFor(url).length ? lookalikeOf(host, savedDomains()) : null;
      return { url, candidates: c.unlocked ? await orderedCandidates(m.tabId, url) : [], lookalike };
    }
    case "item":
      return c.unlocked ? (c.get(m.id)?.body ?? null) : null;
    case "totp": {
      const it = c.unlocked ? c.get(m.id) : undefined;
      if (!it?.body.totp) return null;
      // The same gates as showing the item: no code for a fill-only member, and none
      // until the master password's been asked for again on an item that wants it.
      if (!c.canReveal(it.vaultId)) return null;
      if (it.body.reprompt && !m.reprompted) return null;
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
      if (c.unlocked) {
        reloading = reloading.then(() => c.reload()).catch(() => undefined);
        await reloading;
      }
      await safeSync();
      return { ok: true };
    case "setAccess":
      await setSiteAccess(m.onClickOnly);
      return { ok: true, onClickOnly: await fillsOnClickOnly() };
    case "unlockWithSecret": {
      const secret = fromB64u(m.secret);
      const r = await c.unlockWithSecret(secret);
      await saveSecret(secret, c.api.session);
      startKeepAlive();
      await touchLockTimer();
      updateBadgeAll();
      return { offline: r.offline };
    }
    case "extSettings": {
      const s = await extSettings();
      const pin = (await session.get("pin")).pin as PinRecord | undefined;
      return { onClickOnly: await fillsOnClickOnly(), mailCodes: s.mailCodes, pin: !!pin, clipCheck: await canCheckClipboard() };
    }
    case "setMailCodes":
      await store.setMeta("ext_settings", { ...(await store.getMeta<object>("ext_settings")), mailCodes: m.on });
      return { ok: true };
    case "setPin": {
      if (m.pin === null) {
        await session.remove("pin");
        return { ok: true };
      }
      const { unlock } = await session.get("unlock");
      if (!unlock) throw new Error("Unlock first");
      if (!/^\d{4,12}$/.test(m.pin)) throw new Error("Use 4 to 12 digits.");
      const salt = randomBytes(16);
      const stretched = await argon2(utf8(m.pin), salt, KDF_FLOOR);
      const wrapped = await wrapUnlockSecret(stretched, salt, fromB64u(unlock as string), "pin-unlock");
      stretched.fill(0);
      await session.set({ pin: { salt: b64u(salt), wrapped, tries: 0 } satisfies PinRecord });
      return { ok: true };
    }
    case "pinUnlock": {
      const pin = (await session.get("pin")).pin as PinRecord | undefined;
      if (!pin) throw new Error("There's no PIN on this browser. Use your master password.");
      const salt = fromB64u(pin.salt);
      const stretched = await argon2(utf8(m.pin), salt, KDF_FLOOR);
      let secret: Uint8Array;
      try {
        secret = await unwrapUnlockSecret(stretched, salt, pin.wrapped, "pin-unlock");
      } catch {
        const tries = pin.tries + 1;
        if (tries >= PIN_TRIES) {
          await session.remove("pin");
          throw new Error("That was the last try. Use your master password.");
        }
        await session.set({ pin: { ...pin, tries } });
        throw new Error(`That PIN isn't right. ${PIN_TRIES - tries} tries left.`);
      } finally {
        stretched.fill(0);
      }
      await c.unlockWithSecret(secret);
      await saveSecret(secret, c.api.session);
      await session.set({ pin: { ...pin, tries: 0 } });
      startKeepAlive();
      await touchLockTimer();
      updateBadgeAll();
      return { ok: true };
    }
    case "scanTabQr": {
      // Only of what's showing, only when asked, and it goes nowhere.
      const shot = await ext.tabs.captureVisibleTab(m.windowId ?? (undefined as unknown as number), { format: "png" });
      const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(bitmap, 0, 0);
      const img = g.getImageData(0, 0, bitmap.width, bitmap.height);
      return { uri: jsQR(img.data, img.width, img.height)?.data ?? null };
    }
    case "addTotp": {
      const totp = parseOtpauth(m.uri);
      if (!totp) throw new Error("That QR code isn't a 2FA setup code.");
      if (m.itemId) {
        const item = c.get(m.itemId);
        if (!item) throw new Error("Unknown item");
        await c.update(m.itemId, { ...item.body, totp });
      } else {
        await c.saveNew(await c.personalVaultId(), newBody("totp", m.title, { totp, urls: m.url ? [{ url: m.url }] : [] }));
      }
      await safeSync();
      return { ok: true };
    }
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
    case "activity":
      // Someone's using an open vault page: same as using the popup.
      if (c.unlocked) await touchLockTimer();
      return { ok: true };
    case "generate":
      return { password: generateForSite(m.host) };
    case "plusBase":
      return { email: mostUsedEmail() };
    case "plusAddress": {
      const base = m.host ? baseDomain(m.host) : null;
      try {
        return { address: plusAddress(m.email, base?.split(".")[0] ?? "") };
      } catch {
        return { address: null };
      }
    }
    case "clipWatch":
      await watchClipboard(m.text, (await vaultSettings()).clipboardSeconds);
      return { ok: true };
    case "clipClear":
      await clearClipboardIfOurs();
      return { ok: true };
  }
}

/** Where a plus-address starts from: the address this person signs up with most. */
function mostUsedEmail(): string | null {
  const counts = new Map<string, number>();
  for (const i of loginItems()) {
    const u = i.body.username;
    if (u?.includes("@")) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [email, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = email;
  return best;
}

async function handleContent(m: ContentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await boot();
  await reloading;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  switch (m.t) {
    case "pageReport":
      frameReports.set(`${tabId}:${sender.frameId ?? 0}`, m.report);
      if (__TEST_BUILD__) testLog.reportCount[tabId] = (testLog.reportCount[tabId] ?? 0) + 1;
      await maybeAutofillOnLoad(tabId, sender.frameId ?? 0, m.report.kinds ?? [], sender.url);
      if ((await getFlows())[String(tabId)]) scheduleCodeStep(tabId);
      return null;
    case "hello": {
      const host = hostOf(m.url) ?? "";
      const rule = await findRule(host);
      const pending = await pendingSave(tabId);
      return { rule, pendingSave: !!pending && (sender.frameId ?? 0) === 0, submittedKind: pending?.submittedKind, unlocked: !!client?.unlocked };
    }
    case "captured":
      await onCaptured(tabId, m.capture, sender.url);
      return null;
    case "capturedUser":
      await rememberTyped(tabId, m.username, sender.url);
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

// ---- The signed rules pack (plan 6.5) -----------------------------------------------------

let packRules: SiteRule[] | null = null;

/** Verifies a pack against the pinned key. Nothing here runs: rules are CSS selectors for
 *  a page's boxes, and those boxes still pass the same fill guard. */
async function loadPack(packBytes: Uint8Array, signature: string): Promise<SiteRule[]> {
  const key = packPublicKey();
  if (!key) throw new Error("No key");
  const seen = (await store.getMeta<number>("rules_pack_version")) ?? 0;
  const pack = openSignedPack({ pack: b64u(packBytes), signature }, fromB64u(key), seen);
  await store.setMeta("rules_pack_version", pack.version);
  return pack.rules;
}

/** Comes with the extension and with nothing else. Any failure, including a release build
 *  with no key yet, means no pack, and there's nothing to tell anyone. */
async function shippedPack(): Promise<SiteRule[]> {
  if (packRules) return packRules;
  try {
    const [bytes, signature] = await Promise.all([
      fetch(ext.runtime.getURL("rules/pack.json")).then((r) => r.arrayBuffer()),
      fetch(ext.runtime.getURL("rules/pack.sig")).then((r) => r.text()),
    ]);
    packRules = await loadPack(new Uint8Array(bytes), signature.trim());
  } catch {
    packRules = [];
  }
  return packRules;
}

/** The person's own taught rule wins over anything in the pack. */
async function findRule(host: string): Promise<SiteRule | null> {
  if (client?.unlocked) {
    const rules = client.allItems({ includeSystem: true }).filter((i) => i.body.kind === "site_rule" && i.body.rule).map((i) => i.body.rule!);
    const taught = ruleForHost(rules, host);
    if (taught) return taught;
  }
  return ruleForHost(await shippedPack(), host);
}

const PIN_TRIES = 5;
type PinRecord = { salt: string; wrapped: string; tries: number };

async function fetchMailCodes(): Promise<MailCode[]> {
  try {
    return await client!.api.request<MailCode[]>("GET", "/mail/codes");
  } catch {
    return [];
  }
}

/** The sender looks like a saved site and isn't, or this page does. Either way a click
 *  alone doesn't do it. */
function mailLookalike(found: MailCode, url: string): string | null {
  const [ranked] = rankMailCodes([found], url, savedDomainsOf(client!.allItems()));
  const pageIsLike = lookalikeOf(hostOf(url) ?? "", savedDomains());
  return ranked.lookalike ?? pageIsLike;
}

/** Opt-in. The server's told nothing about this page: the matching happens here. */
async function mailRows(kinds: string[], url: string | undefined) {
  if (!client?.unlocked || !url || !(await extSettings()).mailCodes) return [];
  if (!kinds.some((k) => k === "otp" || k === "email-first" || k === "signin")) return [];
  const ranked = rankMailCodes(await fetchMailCodes(), url, savedDomainsOf(client.allItems()));
  const pageIsLike = lookalikeOf(hostOf(url) ?? "", savedDomains());
  return ranked.map((r) => ({
    id: r.id,
    from: r.from_name || r.from_domain,
    domain: r.from_domain,
    ago: agoText(r.agoSeconds),
    matches: r.matches,
    lookalike: r.lookalike,
    pageLookalike: pageIsLike,
    code: kinds.includes("otp") ? r.code : null,
    hasLink: linkIsSafe(r),
  }));
}

/** Off unless an item asks for it, and then only in the clearest case (plan 6.6). */
async function maybeAutofillOnLoad(tabId: number, frameId: number, kinds: string[], url: string | undefined) {
  // Every page reports, so the cheap checks go before matching against the whole vault.
  if (!url || frameId !== 0 || !kinds.includes("signin") || !client?.unlocked) return;
  const matches = matchItems(loginItems(), url, recents);
  const local = (u: URL) => u.hostname === "localhost" || u.hostname.endsWith(".localhost");
  const allowed = mayFillOnLoad({ url, frameId, kinds }, matches.map((m) => ({ kind: m.kind, optedIn: !!m.item.body.autofillOnLoad, reprompt: !!m.item.body.reprompt, downgrade: m.downgrade })), __TEST_BUILD__ ? local : undefined);
  if (!allowed) return;
  // Once per address per tab, across worker restarts: a page that blanks itself or keeps
  // re-rendering doesn't get filled over and over.
  const done = ((await session.get("onLoadDone")).onLoadDone as Record<string, string>) ?? {};
  if (done[String(tabId)] === url) return;
  done[String(tabId)] = url;
  await session.set({ onLoadDone: done });
  await fill(tabId, matches[0].item.id, { onlyFrame: 0 });
}

async function frameShowingMenu(tabId: number, frameIds: number[]): Promise<number | undefined> {
  const answers = await Promise.all(frameIds.map((frameId) => send<boolean>(tabId, frameId, { t: "hasMenu" })));
  return frameIds[answers.findIndex((a) => a === true)];
}

async function handleMenu(m: MenuRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await boot();
  await reloading;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return null;
  const parentFrame = (sender as { frameId?: number; parentFrameId?: number }).frameId;
  const frames_ = await frames(tabId);
  const me = frames_.find((f) => f.frameId === parentFrame);
  // Chromium leaves our frame out of that list, and only the frame showing a menu knows.
  const hostFrame = me ? me.parentFrameId : (await frameShowingMenu(tabId, frames_.map((f) => f.frameId))) ?? 0;
  const url = frames_.find((f) => f.frameId === hostFrame)?.url ?? "";
  switch (m.t) {
    case "menuList": {
      if (!client?.unlocked) return { locked: true, candidates: [] };
      const list = await orderedCandidates(tabId, url);
      const report = await reportOf(tabId, hostFrame);
      const kinds = report?.kinds ?? [];
      return { locked: false, candidates: list, kinds, url, mail: await mailRows(kinds, url) };
    }
    case "menuPick": {
      if (!client?.unlocked) return { ok: false, reason: "locked" };
      // The frame that hosts the menu re-checks that the menu's really visible.
      const check = await send<{ ok: boolean; reason?: string }>(tabId, hostFrame, { t: "menuCheck", itemId: m.itemId });
      if (!check?.ok) return { ok: false, reason: "popup", detail: check?.reason };
      const item = client.get(m.itemId);
      if (!item || item.body.kind === "card" || item.body.kind === "identity" || item.body.reprompt) return { ok: false, reason: "popup" };
      const r = await fill(tabId, m.itemId, { onlyFrame: hostFrame });
      return r.ok ? r : { ok: false, reason: "popup", detail: r.reason };
    }
    case "menuMailCode":
    case "menuMailLink": {
      if (!client?.unlocked) return { ok: false };
      // The same check as filling a login: the menu has to be really visible.
      const check = await send<{ ok: boolean; reason?: string }>(tabId, hostFrame, { t: "menuCheck", itemId: "mail" });
      if (!check?.ok) return { ok: false, reason: "popup" };
      const found = (await fetchMailCodes()).find((x) => x.id === m.id);
      if (!found) return { ok: false, reason: "gone" };
      const lookalike = mailLookalike(found, url);
      if (m.t === "menuMailCode") {
        if (!found.code) return { ok: false };
        // Decided here as well as in the menu.
        if (lookalike && !m.confirmLookalike) return { ok: false, reason: "lookalike", lookalike };
        await send(tabId, hostFrame, { t: "doFill", values: { otp: found.code } });
        return { ok: true };
      }
      // A link goes somewhere at once and can't be taken back, so it's refused outright.
      if (lookalike || !linkIsSafe(found)) return { ok: false, reason: "lookalike", lookalike };
      await ext.tabs.update(tabId, { url: found.link! });
      return { ok: true };
    }
    case "menuGenerate": {
      if (!client?.unlocked) return { ok: false };
      await generateInto(tabId, hostFrame, url, m.itemId);
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

// ---- Test builds only: esbuild drops all of this from a release ------------------------------

const testLog = {
  doFills: [] as { tabId: number; url: string; keys: string[]; filled?: string[] }[],
  notices: [] as string[],
  reportCount: {} as Record<number, number>,
};

async function handleTest(m: { op: string; [k: string]: unknown }): Promise<unknown> {
  await boot();
  switch (m.op) {
    case "idle":
      await onIdleState(m.state as string);
      return { unlocked: !!client?.unlocked };
    case "sleepGap":
      await session.set({ beat: Date.now() - (m.ms as number) });
      await noticeSleep();
      return { unlocked: !!client?.unlocked };
    case "reports":
      return { report: frameReports.get(`${m.tabId}:${(m.frameId as number) ?? 0}`) ?? null, count: testLog.reportCount[m.tabId as number] ?? 0 };
    case "log":
      return testLog;
    case "noClipRead":
      clipboardTest.pretendNoRead(!!m.on);
      return { ok: true };
    case "clipDue":
      await clearClipboardIfOurs();
      return { ok: true };
    case "clipWrite":
      return { ok: await writeClipboard(m.text as string) };
    case "loadPack":
      packRules = await loadPack(fromB64u(m.pack as string), m.signature as string);
      return { rules: packRules.length };
    case "resetPack":
      await store.setMeta("rules_pack_version", 0);
      packRules = null;
      return { rules: (await shippedPack()).length };
    case "items":
      return client!.allItems().map((i) => ({ id: i.id, title: i.body.title, username: i.body.username, password: i.body.password, pendingPassword: i.body.pendingPassword, tags: i.body.tags ?? [], urls: i.body.urls ?? [], history: i.body.passwordHistory?.length ?? 0 }));
    case "patchItem": {
      const it = client!.get(m.id as string);
      if (!it) throw new Error("No such item");
      await client!.update(it.id, { ...it.body, ...(m.patch as Partial<ItemBody>) });
      return { ok: true };
    }
    case "settings":
      return vaultSettings();
    case "addCard":
      await client!.saveNew(await client!.personalVaultId(), newBody("card", m.title as string, { cardNumber: m.cardNumber as string, cardCvv: m.cardCvv as string }));
      return { ok: true };
    case "saveRule":
      await client!.saveNew(await client!.personalVaultId(), newBody("site_rule", "Taught", { rule: m.rule as SiteRule }));
      return { ok: true };
    case "seedItems": {
      const c = client!;
      const vault = await c.personalVaultId();
      for (let i = 0; i < (m.count as number); i++) {
        await c.saveNew(vault, newBody("login", `Seed ${i}`, { username: `seed${i}@example.com`, password: `Seed-Pass-${i}`, urls: [{ url: `https://seed${i}.example.com` }] }));
      }
      return { ok: true, total: c.allItems().length };
    }
    default:
      throw new Error(`No test op ${m.op}`);
  }
}

ext.runtime.onMessage.addListener((msg: { t: string }, sender, reply) => {
  if (sender.id !== ext.runtime.id) return false;
  const t = msg?.t ?? "";
  // Ours to send, not to answer: for extension pages and the offscreen page.
  if (t === "vaultChanged" || t === "locked" || t === "offscreenClip") return false;
  let p: Promise<unknown>;
  if (t.startsWith("pk")) {
    p = boot().then(() => handlePasskey(msg as never, sender, () => client));
  } else if (t === "menuList" || t === "menuPick" || t === "menuMailCode" || t === "menuMailLink" || t === "menuGenerate" || t === "menuClose" || t === "menuOpenPopup") {
    if (!isExtensionPage(sender) || !(sender.url ?? "").includes("/menu.html")) return false;
    p = handleMenu(msg as MenuRequest, sender);
  } else if (t === "saveOffer" || t === "saveAnswer") {
    if (!isExtensionPage(sender) || !(sender.url ?? "").includes("/save.html")) return false;
    p = handleSave(msg as SaveRequest, sender);
  } else if (t === "pageReport" || t === "hello" || t === "captured" || t === "capturedUser" || t === "submitFailed" || t === "teachResult") {
    p = handleContent(msg as ContentRequest, sender);
  } else if (__TEST_BUILD__ && t === "test") {
    if (!isTrustedPage(sender)) return false;
    p = handleTest(msg as unknown as { op: string });
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
    const best = (await orderedCandidates(tabId, t.url ?? ""))[0];
    if (best) await fill(tabId, best.id, {});
  }
  if (command === "generate" && client?.unlocked) {
    const t = await ext.tabs.get(tabId);
    await generateInto(tabId, 0, t.url ?? "");
  }
});

ext.contextMenus.onClicked.addListener(async (info, tab) => {
  await boot();
  if (!tab?.id) return;
  if (info.menuItemId === "fill") {
    const best = (await orderedCandidates(tab.id, tab.url ?? ""))[0];
    if (best) await fill(tab.id, best.id, {});
    else await send(tab.id, info.frameId ?? 0, { t: "openMenu" });
  }
  if (info.menuItemId === "generate" && client?.unlocked) {
    await generateInto(tab.id, info.frameId ?? 0, info.frameUrl ?? tab.url ?? "");
  }
});

export const _types = { userId } as const;
