// M7: passkeys through the extension, verified by an independent WebAuthn library
// (@simplewebauthn/server) on the relying-party side, on a local test site.
import crypto from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";

import { bg, connect, launch, makeUsers, MASTER, PASSKEY_PIN, type Rig, saveWithPin, signInWithPin, siteA, startSite, tabIdOf, testHook, typePasskeyPin, unlockExt } from "./lib";

test.describe.configure({ mode: "serial" });

let rig: Rig;
let site: { close: () => void };

const ORIGIN = "http://localhost:8111";
const RP = "localhost";
const b64u = (b: Buffer) => b.toString("base64url");

let credential: { id: string; publicKey: Uint8Array; counter: number };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [u] = makeUsers(["pk"]);
  await connect(rig, u);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

async function promptWindow() {
  const p = await rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 15_000 });
  await p.waitForLoadState();
  return p;
}

test("creates a passkey, in a window of its own, choosing the passkey PIN first, and a real server library accepts it", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: RP, userId: b64u(Buffer.from("user-1")), userName: "ana@example.com", challenge });
  const prompt = await promptWindow();
  await expect(prompt.getByText("Save a passkey?")).toBeVisible();
  await expect(prompt.getByText("localhost:8111")).toBeVisible();
  // No PIN yet: the same window asks for one, twice, with the box already focused.
  await expect(prompt.getByText("Choose a passkey PIN.")).toBeVisible();
  await expect(prompt.locator("#pin")).toBeFocused();
  await expect(prompt.locator("#pin-again")).toBeVisible();
  // An easy one, and two that don't match, are refused, and nothing's made.
  await prompt.locator("#pin").fill("1234");
  await prompt.locator("#pin-again").fill("1234");
  await prompt.getByRole("button", { name: "Save as a new item" }).click();
  await expect(prompt.locator("#pin-error")).toContainText("too easy");
  await prompt.locator("#pin").fill(PASSKEY_PIN);
  await prompt.locator("#pin-again").fill("482914");
  await prompt.locator("#pin-again").press("Enter");
  await expect(prompt.locator("#pin-error")).toContainText("don't match");
  // Enter in the box saves it.
  await typePasskeyPin(prompt);
  await prompt.locator("#pin-again").press("Enter");
  const r = await run;
  expect(r.error).toBeUndefined();
  expect(r.isReal).toBe(true);
  expect(r.authenticatorAttachment).toBe("platform");
  const v = await verifyRegistrationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true });
  expect(v.verified).toBe(true);
  // Only after the PIN.
  expect(v.registrationInfo?.userVerified).toBe(true);
  expect(v.registrationInfo?.credentialDeviceType).toBe("multiDevice");
  expect(v.registrationInfo?.credentialBackedUp).toBe(true);
  credential = { id: v.registrationInfo!.credential.id, publicKey: v.registrationInfo!.credential.publicKey, counter: v.registrationInfo!.credential.counter };
  await page.close();
});

test("signs in with it, and the library verifies the signature", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge, allow: [credential.id] });
  const prompt = await promptWindow();
  await expect(prompt.getByText("Sign in with a passkey?")).toBeVisible();
  // The PIN's set now, so it's one box, focused, and Enter signs in.
  await expect(prompt.locator("#pin")).toBeFocused();
  await expect(prompt.locator("#pin-again")).toHaveCount(0);
  await prompt.locator("#pin").fill(PASSKEY_PIN);
  await prompt.locator("#pin").press("Enter");
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyAuthenticationResponse({
    response: r,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    credential: { id: credential.id, publicKey: credential.publicKey as Uint8Array<ArrayBuffer>, counter: credential.counter },
    requireUserVerification: true,
  });
  expect(v.verified).toBe(true);
  expect(v.authenticationInfo.userVerified).toBe(true);
  expect(Buffer.from(r.response.userHandle, "base64url").toString()).toBe("user-1");
  await page.close();
});

test("discoverable sign-in with no allow list finds it too", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge });
  const prompt = await promptWindow();
  await signInWithPin(prompt, /ana@example.com/);
  expect((await run).error).toBeUndefined();
  await page.close();
});

test("excludeCredentials stops a duplicate, and says so only after the prompt", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: RP, userId: b64u(Buffer.from("user-1")), userName: "ana@example.com", challenge: b64u(crypto.randomBytes(32)), exclude: [credential.id] });
  const prompt = await promptWindow();
  await expect(prompt.getByText("You already have a passkey")).toBeVisible();
  await prompt.getByRole("button", { name: "Tell the site" }).click();
  expect((await run).error).toBe("InvalidStateError");
  await page.close();
});

test("a site that requires user verification gets it after the PIN, with no password asked for", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: RP, userId: b64u(Buffer.from("user-uv")), userName: "uv@example.com", challenge, uv: "required" });
  const prompt = await promptWindow();
  await saveWithPin(prompt);
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyRegistrationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true });
  expect(v.verified).toBe(true);
  expect(v.registrationInfo?.userVerified).toBe(true);
  await page.close();
});

test("a site that says it doesn't want user verification still gets the PIN asked, and is told it happened", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: RP, userId: b64u(Buffer.from("user-nouv")), userName: "nouv@example.com", challenge, uv: "discouraged" });
  const prompt = await promptWindow();
  await expect(prompt.locator("#pin")).toBeVisible();
  await saveWithPin(prompt);
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyRegistrationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: false });
  expect(v.verified).toBe(true);
  // The PIN was typed, so it's true. A site that doesn't want it can ignore it.
  expect(v.registrationInfo?.userVerified).toBe(true);
  await page.close();
});

test("an item marked to ask still asks, whatever the site wants, and a wrong answer gets nothing", async () => {
  const items = await bg<{ id: string; username: string }[]>(rig, `return (await chrome.runtime.sendMessage({ t: "list", query: "uv@example.com" })).r;`);
  const id = items[0].id;
  const username = items[0].username;
  await testHook(rig, "patchItem", { id, patch: { reprompt: true } });
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge });
  const prompt = await promptWindow();
  await signInWithPin(prompt, new RegExp(username));
  await prompt.getByLabel("Master password or PIN").fill("not the password");
  await prompt.getByRole("button", { name: "Continue" }).click();
  await expect(prompt.getByText("That isn't right.")).toBeVisible({ timeout: 30_000 });
  await prompt.getByLabel("Master password or PIN").fill(MASTER);
  await prompt.getByRole("button", { name: "Continue" }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  await testHook(rig, "patchItem", { id, patch: { reprompt: false } });
  await page.close();
});

// ---- The passkey PIN (D-PIN-1) --------------------------------------------------------------

async function askForAna(page: Page) {
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge, allow: [credential.id] });
  return { run, challenge, prompt: await promptWindow() };
}

const stillWaiting = (run: Promise<unknown>) => Promise.race([run.then(() => "answered"), new Promise((r) => setTimeout(() => r("waiting"), 600))]);

async function wrongPin(prompt: Page, said: string) {
  await prompt.locator("#pin").fill("907153");
  await prompt.locator("#pin").press("Enter");
  await expect(prompt.locator("#pin-error")).toContainText(said, { timeout: 30_000 });
  await expect(prompt.locator("#pin")).toHaveValue("");
  await expect(prompt.locator("#pin")).toBeFocused();
}

async function verifiedSignIn(run: Promise<any>, challenge: string) {
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyAuthenticationResponse({
    response: r,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    credential: { id: credential.id, publicKey: credential.publicKey as Uint8Array<ArrayBuffer>, counter: 0 },
    requireUserVerification: true,
  });
  expect(v.verified).toBe(true);
  expect(v.authenticationInfo.userVerified).toBe(true);
}

test("passkey PIN: a wrong one is refused, says how many tries are left, and nothing reaches the site", async () => {
  const page = await rig.ctx.newPage();
  const { run, challenge, prompt } = await askForAna(page);
  await wrongPin(prompt, "4 tries left");
  expect(await stillWaiting(run)).toBe("waiting");
  await prompt.locator("#pin").fill(PASSKEY_PIN);
  await prompt.locator("#pin").press("Enter");
  await verifiedSignIn(run, challenge);
  await page.close();
});

test("passkey PIN: a page asking again can't reset the count, and a right PIN does", async () => {
  const page = await rig.ctx.newPage();
  let ask = await askForAna(page);
  await wrongPin(ask.prompt, "4 tries left");
  await wrongPin(ask.prompt, "3 tries left");
  await ask.prompt.getByRole("button", { name: "Cancel" }).click();
  expect((await ask.run).error).toBe("NotAllowedError");
  // A fresh request, from a fresh page: the count is the extension's, not the page's.
  await page.close();
  const again = await rig.ctx.newPage();
  ask = await askForAna(again);
  await expect(ask.prompt.locator("#pin-error")).toContainText("3 tries left");
  await ask.prompt.locator("#pin").fill(PASSKEY_PIN);
  await ask.prompt.locator("#pin").press("Enter");
  await verifiedSignIn(ask.run, ask.challenge);
  // Back to five.
  ask = await askForAna(again);
  await expect(ask.prompt.locator("#pin")).toBeFocused();
  await expect(ask.prompt.locator("#pin-error")).toHaveText("");
  await ask.prompt.getByRole("button", { name: "Cancel" }).click();
  await again.close();
});

test("passkey PIN: five wrong in a row lock the vault, and only the master password opens it", async () => {
  // A short unlock PIN on this browser, to show it doesn't get round the lock.
  await bg(rig, `const r = await chrome.runtime.sendMessage({ t: "setPin", pin: "7391" }); if (!r.ok) throw new Error(r.error);`);
  const page = await rig.ctx.newPage();
  const { run, challenge, prompt } = await askForAna(page);
  for (const left of [4, 3, 2]) await wrongPin(prompt, `${left} tries left`);
  await wrongPin(prompt, "One more wrong and your vault locks.");
  await prompt.locator("#pin").fill("907153");
  await prompt.locator("#pin").press("Enter");
  await expect(prompt.locator("#pk-notice")).toContainText("Five wrong passkey PINs in a row, so your vault is locked. Unlock it with your master password.", { timeout: 30_000 });
  await expect(prompt.getByLabel("Master password")).toBeVisible();
  expect(await stillWaiting(run)).toBe("waiting");
  expect(await bg<boolean>(rig, `return (await chrome.runtime.sendMessage({ t: "state" })).r.unlocked;`)).toBe(false);
  // Nothing shorter than the master password opens it now.
  const quick = await bg<{ ok: boolean; error?: string }>(rig, `return await chrome.runtime.sendMessage({ t: "pinUnlock", pin: "7391" });`);
  expect(quick.ok).toBe(false);
  expect(quick.error).toContain("Five wrong passkey PINs");
  expect(await bg<boolean>(rig, `return (await chrome.runtime.sendMessage({ t: "state" })).r.unlocked;`)).toBe(false);
  // The master password, in the same window, and the request carries on with a fresh count.
  await prompt.getByLabel("Master password").fill(MASTER);
  await prompt.getByRole("button", { name: "Unlock" }).click();
  await expect(prompt.locator("#pin")).toBeVisible({ timeout: 60_000 });
  await expect(prompt.locator("#pin-error")).toHaveText("");
  await expect(prompt.locator("#pk-notice")).toHaveCount(0);
  await prompt.locator("#pin").fill(PASSKEY_PIN);
  await prompt.locator("#pin").press("Enter");
  await verifiedSignIn(run, challenge);
  await bg(rig, `await chrome.runtime.sendMessage({ t: "setPin", pin: null });`);
  await page.close();
});

test("passkey PIN: the page can't see it, type it, or answer for the window", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  await page.evaluate(() => {
    (window as any).__seen = [];
    window.addEventListener("message", (e) => (window as any).__seen.push(JSON.stringify(e.data)));
  });
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge, allow: [credential.id] });
  const prompt = await promptWindow();
  await expect(prompt.locator("#pin")).toBeFocused();
  // Keys the page gets stay in the page. The window is the extension's own, out of its reach.
  await page.keyboard.type(PASSKEY_PIN);
  await page.keyboard.press("Enter");
  await expect(prompt.locator("#pin")).toHaveValue("");
  expect(await page.evaluate(() => !document.getElementById("pin") && !window.opener && window.frames.length === 0)).toBe(true);
  expect(await stillWaiting(run)).toBe("waiting");
  // Only our window can ask what's waiting, or answer it. Anything else, even another of our own pages, is told nothing.
  const said = await bg<unknown[]>(rig, `return [await chrome.runtime.sendMessage({ t: "pkPrompt", id: "x" }), await chrome.runtime.sendMessage({ t: "pkAnswer", id: "x", action: "use", pin: arg })].map((m) => m?.r ?? null);`, PASSKEY_PIN);
  expect(said).toEqual([null, null]);
  await prompt.locator("#pin").fill(PASSKEY_PIN);
  await prompt.locator("#pin").press("Enter");
  await verifiedSignIn(run, challenge);
  // The PIN never went near the page: not in any message it could hear.
  const seen = await page.evaluate(() => (window as any).__seen as string[]);
  expect(seen.join("\n")).not.toContain(PASSKEY_PIN);
  await page.close();
});

test("RP ID spoofing is refused, in every form", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://a.localhost:8111/webauthn.html");
  for (const rpId of ["example.com", "b.localhost", "evil.a.localhost.example", "localhost.evil.test", "com", ""]) {
    const r = await page.evaluate((o) => (window as any).__auth(o), { rpId, challenge: b64u(crypto.randomBytes(32)), allow: [credential.id] });
    if (rpId === "") continue; // An empty rpId falls back to the host, per the spec.
    expect(r.error, rpId).toBe("SecurityError");
  }
  const c = await page.evaluate((o) => (window as any).__register(o), { rpId: "example.com", userId: "dQ", userName: "x", challenge: b64u(crypto.randomBytes(32)) });
  expect(c.error).toBe("SecurityError");
  await page.close();
});

test("Permissions-Policy: a frame denied WebAuthn is refused without any prompt", async () => {
  const page = await rig.ctx.newPage();
  await page.route("**/embed-deny.html", (r) =>
    r.fulfill({
      contentType: "text/html",
      headers: { "Permissions-Policy": "publickey-credentials-get=(), publickey-credentials-create=()" },
      body: `<title>x</title><script src="/webauthn-inner.js"></script>`,
    }),
  );
  await page.goto(siteA("webauthn.html"));
  const out = await page.evaluate(async () => {
    const f = document.createElement("iframe");
    f.src = "/webauthn.html";
    f.setAttribute("allow", "publickey-credentials-get 'none'; publickey-credentials-create 'none'");
    document.body.appendChild(f);
    await new Promise((res) => (f.onload = res));
    await new Promise((res) => setTimeout(res, 300));
    return (f.contentWindow as any).__auth({ rpId: "localhost", challenge: "AAAA" });
  });
  expect(out.error).toBe("NotAllowedError");
  await page.close();
});

test("the browser's own passkeys stay available: a person can choose them", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge, allow: [credential.id] });
  const prompt = await promptWindow();
  await prompt.getByRole("button", { name: "Use another device or security key" }).click();
  // With no authenticator attached, the native call ends in an error of its own, which
  // shows it reached the browser rather than us.
  const r = await Promise.race([run, new Promise<{ error: string }>((res) => setTimeout(() => res({ error: "pending-native" }), 3000))]);
  expect(["NotAllowedError", "pending-native"]).toContain(r.error);
  await page.close();
});

test("nothing of ours for this request goes straight to the native API, with no prompt", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  let opened = false;
  const listener = (p: { url: () => string }) => {
    if (p.url().includes("passkey.html")) opened = true;
  };
  rig.ctx.on("page", listener);
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge: b64u(crypto.randomBytes(32)), allow: [b64u(crypto.randomBytes(32))] });
  await Promise.race([run, new Promise((res) => setTimeout(res, 2000))]);
  rig.ctx.off("page", listener);
  expect(opened).toBe(false);
  await page.close();
});

test("closing the prompt refuses the request", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge: b64u(crypto.randomBytes(32)), allow: [credential.id] });
  const prompt = await promptWindow();
  await prompt.getByRole("button", { name: "Cancel" }).click();
  expect((await run).error).toBe("NotAllowedError");
  await page.close();
});

test("the passkey is in the vault, syncs, and shows in the vault page", async () => {
  const vault = await rig.ctx.newPage();
  await vault.goto(`chrome-extension://${rig.extId}/vault.html`);
  // Named for its RP ID. What the site calls itself isn't trusted with the vault's list.
  await expect(vault.getByRole("list", { name: "Items" }).getByRole("button", { name: /localhost/ }).first()).toBeVisible({ timeout: 20_000 });
  // Two items have that name by now, in no set order.
  await vault.getByRole("list", { name: "Items" }).getByRole("button", { name: /localhost ana@example.com/ }).click();
  await expect(vault.getByText(/localhost · ana@example.com/)).toBeVisible();
  await vault.close();
});

test("prototype tampering in the page doesn't change what the background decides", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://a.localhost:8111/webauthn.html");
  const r = await page.evaluate(async (allow) => {
    // A page lying about where it is, as loudly as it can.
    const realPost = window.postMessage;
    window.postMessage = function (m: any, o: any) {
      if (m?.__pk === "req") m.origin = "http://localhost:8111";
      return realPost.call(window, m, o);
    } as any;
    return (window as any).__auth({ rpId: "localhost.example", challenge: "AAAA", allow: [allow] });
  }, credential.id);
  expect(r.error).toBe("SecurityError");
  await page.close();
});

// ---- Fallback to the browser must always work (plan 4) ------------------------------------

/** A software authenticator in the browser, so a request that reaches it gets a real answer. */
async function withBrowserAuthenticator(page: Page) {
  const cdp = await rig.ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

const register = (page: Page) => page.evaluate((o) => (window as any).__register(o), { rpId: new URL(page.url()).hostname, userId: b64u(Buffer.from("browser-user")), userName: "browser@example.com", challenge: b64u(crypto.randomBytes(32)) });

function watchForPrompt() {
  let opened = false;
  const listener = (p: { url: () => string }) => {
    if (p.url().includes("passkey.html")) opened = true;
  };
  rig.ctx.on("page", listener);
  return () => {
    rig.ctx.off("page", listener);
    return opened;
  };
}

const setOnClick = (on: boolean) => bg(rig, `await chrome.runtime.sendMessage({ t: "setAccess", onClickOnly: arg });`, on);
const registered = () => bg<string[]>(rig, `return (await chrome.scripting.getRegisteredContentScripts()).map((x) => x.id).sort();`);

test("on-click mode takes the passkey wrapper away too, and WebAuthn goes to the browser", async () => {
  await setOnClick(true);
  expect(await registered()).toEqual([]);
  const stop = watchForPrompt();
  const page = await rig.ctx.newPage();
  await page.goto("http://onclick.localhost:8111/webauthn.html");
  await withBrowserAuthenticator(page);
  const r = await register(page);
  expect(r.error).toBeUndefined();
  expect(r.isReal).toBe(true);
  expect(stop()).toBe(false);
  await page.close();
  await setOnClick(false);
  expect(await registered()).toEqual(["promptly-fields", "promptly-passkey"]);
});

test("a wrapper left on a page with no bridge can't hang: it hands over to the browser", async () => {
  // A page that loaded before the mode changed, or after the extension was updated.
  await setOnClick(true);
  const stop = watchForPrompt();
  const page = await rig.ctx.newPage();
  await page.goto("http://orphan.localhost:8111/webauthn.html");
  await withBrowserAuthenticator(page);
  await bg(rig, `await chrome.scripting.executeScript({ target: { tabId: arg }, world: "MAIN", files: ["passkey-main.js"] });`, await tabIdOf(rig, page));
  const started = Date.now();
  const r = await register(page);
  expect(r.error).toBeUndefined();
  expect(r.isReal).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(stop()).toBe(false);

  // And for a sign-in, which also gets the browser's real answer.
  const signIn = await page.evaluate((o) => (window as any).__auth(o), { rpId: "orphan.localhost", challenge: b64u(crypto.randomBytes(32)), allow: [r.id] });
  expect(signIn.error).toBeUndefined();
  expect(signIn.id).toBe(r.id);
  await page.close();
  await setOnClick(false);
});

test("a bridge that answers and then goes quiet still ends at the browser", async () => {
  await setOnClick(true);
  const page = await rig.ctx.newPage();
  await page.clock.install();
  await page.goto("http://quiet.localhost:8111/webauthn.html");
  await withBrowserAuthenticator(page);
  await bg(rig, `await chrome.scripting.executeScript({ target: { tabId: arg }, world: "MAIN", files: ["passkey-main.js"] });`, await tabIdOf(rig, page));
  // The page says "I'm here" for the bridge, and then says nothing.
  await page.evaluate(() => {
    window.addEventListener("message", (e) => {
      if (e.data?.__pk === "req") window.postMessage({ __pk: "ack", id: e.data.id }, location.origin);
    });
  });
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: "quiet.localhost", userId: b64u(Buffer.from("quiet")), userName: "quiet@example.com", challenge: b64u(crypto.randomBytes(32)) });
  await new Promise((r) => setTimeout(r, 300));
  await page.clock.fastForward(6 * 60 * 1000 + 1000);
  const r = await run;
  expect(r.error).toBeUndefined();
  expect(r.isReal).toBe(true);
  await page.close();
  await setOnClick(false);
});
