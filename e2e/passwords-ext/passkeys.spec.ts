// M7: passkeys through the extension, verified by an independent WebAuthn library
// (@simplewebauthn/server) on the relying-party side, on a local test site.
import crypto from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";

import { bg, connect, launch, makeUsers, MASTER, type Rig, siteA, startSite, tabIdOf, unlockExt } from "./lib";

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

test("creates a passkey, in a window of its own, and a real server library accepts it", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: RP, userId: b64u(Buffer.from("user-1")), userName: "ana@example.com", challenge });
  const prompt = await promptWindow();
  await expect(prompt.getByText("Save a passkey?")).toBeVisible();
  await expect(prompt.getByText("localhost:8111")).toBeVisible();
  await prompt.getByRole("button", { name: "Save as a new item" }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  expect(r.isReal).toBe(true);
  expect(r.authenticatorAttachment).toBe("platform");
  const v = await verifyRegistrationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: false });
  expect(v.verified).toBe(true);
  expect(v.registrationInfo?.userVerified, "a click on a button doesn't verify anyone").toBe(false);
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
  await prompt.getByRole("button", { name: /ana@example.com/ }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyAuthenticationResponse({
    response: r,
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    credential: { id: credential.id, publicKey: credential.publicKey as Uint8Array<ArrayBuffer>, counter: credential.counter },
    requireUserVerification: false,
  });
  expect(v.verified).toBe(true);
  expect(v.authenticationInfo.userVerified).toBe(false);
  expect(Buffer.from(r.response.userHandle, "base64url").toString()).toBe("user-1");
  await page.close();
});

test("discoverable sign-in with no allow list finds it too", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: RP, challenge });
  const prompt = await promptWindow();
  await prompt.getByRole("button", { name: /ana@example.com/ }).click();
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

test("a site that requires user verification gets it only after the master password, in the prompt", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: RP, userId: b64u(Buffer.from("user-uv")), userName: "uv@example.com", challenge, uv: "required" });
  const prompt = await promptWindow();
  await expect(prompt.getByText("prove it's you")).toBeVisible();
  await prompt.getByRole("button", { name: "Save as a new item" }).click();
  await expect(prompt.getByLabel("Master password or PIN")).toBeVisible();
  await prompt.getByLabel("Master password or PIN").fill("not the password");
  await prompt.getByRole("button", { name: "Continue" }).click();
  await expect(prompt.getByText("That isn't right.")).toBeVisible({ timeout: 30_000 });
  await prompt.getByLabel("Master password or PIN").fill(MASTER);
  await prompt.getByRole("button", { name: "Continue" }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyRegistrationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true });
  expect(v.verified).toBe(true);
  expect(v.registrationInfo?.userVerified).toBe(true);
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
