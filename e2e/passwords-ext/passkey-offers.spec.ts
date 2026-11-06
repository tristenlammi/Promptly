// Passkeys a page asks for quietly, or with no click behind it: offered in the toolbar panel and
// the on-page menu, never shown or used until someone chooses. Uses a passkey in Bitwarden's
// export format, through the real importer, and an independent WebAuthn library on the site's side.
import crypto from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

import { fromBitwardenJson } from "../../frontend/src/passwords/core/importers";
import { connect, launch, makeUsers, menuFrame, popupFor, type Rig, siteA, startSite, tabIdOf, testHook, unlockExt } from "./lib";

test.describe.configure({ mode: "serial" });

let rig: Rig;
let site: { close: () => void };

const ORIGIN = "http://localhost:8111";
const RP = "localhost";
const GUID = "b0cf2f0b-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SITE_ID = Buffer.from(GUID.replace(/-/g, ""), "hex").toString("base64url");
const USER = "imported@example.com";
const challenge = () => crypto.randomBytes(32).toString("base64url");

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = pair.publicKey.export({ format: "jwk" }) as { x: string; y: string };

/** The public key as a site would have stored it: COSE, by hand. */
function coseKey(): Uint8Array {
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return new Uint8Array(Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]));
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [u] = makeUsers(["pkoffer"]);
  await connect(rig, u);
  await unlockExt(rig);

  // What a Bitwarden export holds, through the real importer.
  const imported = fromBitwardenJson({
    items: [
      {
        type: 1,
        name: "Imported site",
        login: {
          username: USER,
          uris: [{ uri: "http://localhost:8111" }],
          fido2Credentials: [
            {
              credentialId: GUID,
              keyType: "public-key",
              keyAlgorithm: "ECDSA",
              keyCurve: "P-256",
              keyValue: (pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
              rpId: RP,
              userHandle: Buffer.from("user-1").toString("base64url"),
              userName: USER,
              counter: "0",
              rpName: "Test",
              userDisplayName: USER,
              discoverable: "true",
              creationDate: new Date().toISOString(),
            },
          ],
        },
      },
    ],
  });
  await testHook(rig, "seedBody", { body: { v: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...imported.items[0].body } });
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

const prompts = () => rig.ctx.pages().filter((p) => p.url().includes("/passkey.html"));

async function verified(page: Page, wanted: string) {
  await expect.poll(() => page.evaluate(() => (window as any).__result)).toBeTruthy();
  const r = await page.evaluate(() => (window as any).__result);
  expect(r.error).toBeUndefined();
  expect(r.id).toBe(SITE_ID);
  const v = await verifyAuthenticationResponse({
    response: r,
    expectedChallenge: wanted,
    expectedOrigin: ORIGIN,
    expectedRPID: RP,
    credential: { id: SITE_ID, publicKey: coseKey() as Uint8Array<ArrayBuffer>, counter: 0 },
    requireUserVerification: false,
  });
  expect(v.verified).toBe(true);
}

const answerWith = async (pop: Page) => {
  const opened = promptWindow();
  await pop.getByRole("button", { name: `Sign in with a passkey as ${USER}` }).click();
  const prompt = await opened;
  await expect(prompt.getByText("Sign in with a passkey?")).toBeVisible();
  await expect(prompt.getByRole("strong").or(prompt.locator("strong"))).toContainText("localhost");
  await prompt.getByRole("button", { name: new RegExp(USER) }).click();
};

test("a quiet request shows nothing by itself, and an imported passkey answers it from the panel", async () => {
  const wanted = challenge();
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${wanted}&rp=${RP}&m=conditional&allow=${SITE_ID}`);
  await page.waitForTimeout(800);
  // Nothing opened, and the page knows nothing.
  expect(prompts()).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__result)).toBeNull();

  const pop = await popupFor(rig, page);
  await expect(pop.getByTestId("passkey-offer")).toContainText(USER);
  await answerWith(pop);
  await verified(page, wanted);
  await page.close();
});

test("a request with no click behind it opens no window of ours, and can still be answered", async () => {
  const wanted = challenge();
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${wanted}&rp=${RP}&allow=${SITE_ID}`);
  await page.waitForTimeout(800);
  expect(prompts()).toHaveLength(0);
  const pop = await popupFor(rig, page);
  await expect(pop.getByTestId("passkey-offer")).toBeVisible();
  await answerWith(pop);
  await verified(page, wanted);
  await page.close();
});

test("the on-page menu offers it as well, and picking it goes through the same window", async () => {
  const wanted = challenge();
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${wanted}&rp=${RP}&m=conditional`);
  await page.waitForTimeout(800);
  await page.click("#user");
  await expect.poll(() => !!menuFrame(page)).toBe(true);
  const menu = menuFrame(page)!;
  const row = menu.getByRole("button", { name: `Sign in with a passkey as ${USER}` });
  await expect(row).toBeVisible();
  await page.waitForTimeout(800);
  const opened = promptWindow();
  await row.click();
  const prompt = await opened;
  await prompt.getByRole("button", { name: new RegExp(USER) }).click();
  await verified(page, wanted);
  await page.close();
});

test("cancelling our window leaves the request open, and the page can still be answered", async () => {
  const wanted = challenge();
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${wanted}&rp=${RP}&m=conditional&allow=${SITE_ID}`);
  await page.waitForTimeout(500);
  const pop = await popupFor(rig, page);
  const opened = promptWindow();
  await pop.getByRole("button", { name: `Sign in with a passkey as ${USER}` }).click();
  const prompt = await opened;
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__result)).toBeNull();
  const pop2 = await popupFor(rig, page);
  await answerWith(pop2);
  await verified(page, wanted);
  await page.close();
});

test("a page calling it off, or going away, takes the offer with it", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${challenge()}&rp=${RP}&m=conditional`);
  const pop = await popupFor(rig, page);
  await expect(pop.getByTestId("passkey-offer")).toBeVisible();
  await page.evaluate(() => (window as any).__stop.abort());
  await expect(pop.getByTestId("passkey-offer")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__result?.error)).toBe("AbortError");
  await page.close();

  const again = await rig.ctx.newPage();
  await again.goto(`${siteA("webauthn.html")}?auto=${challenge()}&rp=${RP}&m=conditional`);
  const pop2 = await popupFor(rig, again);
  await expect(pop2.getByTestId("passkey-offer")).toBeVisible();
  await again.goto(siteA("webauthn.html"));
  await expect(pop2.getByTestId("passkey-offer")).toHaveCount(0, { timeout: 10_000 });
  await again.close();
});

test("a window left open when the page navigates closes, and nothing's signed for the new page", async () => {
  const wanted = challenge();
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${wanted}&rp=${RP}&m=conditional&allow=${SITE_ID}`);
  await page.waitForTimeout(500);
  const pop = await popupFor(rig, page);
  const opened = promptWindow();
  await pop.getByRole("button", { name: `Sign in with a passkey as ${USER}` }).click();
  const prompt = await opened;
  await expect(prompt.getByText("Sign in with a passkey?")).toBeVisible();
  const closed = prompt.waitForEvent("close", { timeout: 15_000 });
  // The new page lines up the same ids, hoping for the answer.
  await page.goto(`${siteA("webauthn.html")}?stolen=1`);
  await page.evaluate(() => {
    (window as any).__got = [];
    window.addEventListener("message", (e) => { if ((e.data as { __pk?: string })?.__pk === "res") (window as any).__got.push(e.data); });
    for (let id = 1; id < 40; id++) window.postMessage({ __pk: "offer", id, options: { rpId: "localhost", challenge: "AAAA", allow: [] } }, location.origin);
  });
  await closed;
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as any).__got)).toEqual([]);
  await pop.close();
  await page.close();
});

test("an answer sent with the wrong document's value is dropped by the content script", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${challenge()}&rp=${RP}&m=conditional`);
  await page.evaluate(() => {
    (window as any).__got = [];
    window.addEventListener("message", (e) => { if ((e.data as { __pk?: string })?.__pk === "res") (window as any).__got.push(e.data); });
  });
  const tabId = await tabIdOf(rig, page);
  const other = await rig.ctx.newPage();
  await other.goto(`chrome-extension://${rig.extId}/test.html`);
  await other.evaluate(async (t) => {
    for (let id = 1; id < 6; id++) await chrome.tabs.sendMessage(t, { t: "pkOfferResult", id, document: "not-this-one", origin: "http://localhost:8111", result: { credentialId: "x" } }, { frameId: 0 }).catch(() => undefined);
  }, tabId);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__got)).toEqual([]);
  await other.close();
  await page.close();
});

test("a page's oversized or malformed offers are refused, and leave the panel working", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  await page.evaluate(() => {
    const send = (id: number, options: unknown) => window.postMessage({ __pk: "offer", id, options }, location.origin);
    send(1, { rpId: "localhost", challenge: "x".repeat(5_000_000), allow: [] });
    send(2, { rpId: "localhost", challenge: "AAAA", allow: [null] });
    send(3, { rpId: "localhost", challenge: "AAAA", allow: Array.from({ length: 1000 }, () => ({ id: "x" })) });
    send(4, { rpId: "localhost", allow: [] });
  });
  await page.waitForTimeout(500);
  const pop = await popupFor(rig, page);
  await expect(pop.getByRole("button", { name: "Fill Imported site" })).toBeVisible();
  await pop.waitForTimeout(1800);
  await expect(pop.getByTestId("passkey-offer")).toHaveCount(0);
  await expect(pop.getByTestId("passkey-saved")).toBeVisible();
  const size = await pop.evaluate(async () => JSON.stringify(await chrome.storage.session.get("pkOffers")).length);
  expect(size).toBeLessThan(5000);
  await page.close();
});

test("with a passkey saved and no request, the panel says why nothing's happening", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const pop = await popupFor(rig, page);
  await expect(pop.getByTestId("passkey-saved")).toContainText("this page isn't asking for one");
  await expect(pop.getByTestId("passkey-offer")).toHaveCount(0);
  await page.close();
});

test("a page can't offer another site's passkey, or hear about one by asking", async () => {
  // Another site's id can't be asked for from here: the RP ID check is against the real origin.
  const page = await rig.ctx.newPage();
  await page.goto("http://127.0.0.1:8111/webauthn.html");
  await page.evaluate(() => {
    window.postMessage({ __pk: "offer", id: 9001, options: { rpId: "localhost", challenge: "AAAA", allow: [] } }, location.origin);
    window.postMessage({ __pk: "offer", id: 9002, options: { rpId: "127.0.0.1", challenge: "AAAA", allow: [] } }, location.origin);
  });
  await page.waitForTimeout(600);
  const pop = await popupFor(rig, page);
  await pop.waitForTimeout(1800);
  await expect(pop.getByTestId("passkey-offer")).toHaveCount(0);
  // The page was told nothing either way.
  const told = await page.evaluate(() => new Promise((res) => {
    const seen: unknown[] = [];
    window.addEventListener("message", (e) => { if ((e.data as { __pk?: string })?.__pk === "res") seen.push(e.data); });
    setTimeout(() => res(seen), 500);
  }));
  expect(told).toEqual([]);
  await page.close();
});

test("only the toolbar panel can list or use offers", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`${siteA("webauthn.html")}?auto=${challenge()}&rp=${RP}&m=conditional`);
  const tabId = await tabIdOf(rig, page);
  // Another of our own pages stands in for any other sender: the check is on who's asking.
  const other = await rig.ctx.newPage();
  await other.goto(`chrome-extension://${rig.extId}/test.html`);
  const said = await other.evaluate(async (t) => {
    const list = await chrome.runtime.sendMessage({ t: "pkOffers", tabId: t });
    const use = await chrome.runtime.sendMessage({ t: "pkUseOffer", tabId: t, key: "x", credentialId: "y" });
    return [list?.r ?? null, use?.r ?? null];
  }, tabId);
  expect(said).toEqual([null, null]);
  await other.close();
  await page.close();
});
