// The attacks an independent review proved against the extension, kept as tests. Each one
// should now fail, and a control beside the sharper ones shows the test can still tell.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { BACKEND } from "../passwords-tests/helpers";
import { addItem, bg, connect, launch, makeUsers, MASTER, menuFrame, popupFor, type Rig, startSite, tabIdOf, testHook, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 240_000 });

const PORT = 8111;
const at = (host: string, p: string) => `http://${host}:${PORT}/${p}`;

let rig: Rig;
let site: { close: () => void };
let user: ReturnType<typeof makeUsers>[number];

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  [user] = makeUsers(["proofs"]);
  await connect(rig, user);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

type ItemOut = { id: string; title: string; username?: string; password?: string; pendingPassword?: string; tags: string[]; urls: { url: string }[]; history: number; totp?: unknown; fields?: { name: string }[] };

const items = () => testHook<ItemOut[]>(rig, "items");
const itemNamed = async (title: string) => (await items()).find((i) => i.title === title)!;
const patch = (id: string, change: Record<string, unknown>) => testHook(rig, "patchItem", { id, patch: change });
const menus = (p: Page) => p.frames().filter((f) => f.url().includes("/menu.html"));
const saves = (p: Page) => p.frames().filter((f) => f.url().includes("/save.html"));
const state = (p: Page) => p.evaluate(() => (window as any).__state());
const VISIBLE_FOR = 800;

async function open(url: string) {
  const page = await rig.ctx.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

/** The popup's own call, for a page that stays in front. */
function fillCall(page: Page, m: Record<string, unknown>) {
  return bg<{ ok: boolean; r?: { ok: boolean; reason?: string; filled?: string[]; left?: string[] } }>(
    rig,
    `const tabs = await chrome.tabs.query({}); const id = tabs.find((x) => x.url === arg.u)?.id; return chrome.runtime.sendMessage({ t: "fill", tabId: id, ...arg.m });`,
    { u: page.url(), m },
  );
}

function seedMail(subject: string, from: string, text: string) {
  execFileSync("docker", ["exec", "-i", BACKEND, "python"], {
    encoding: "utf8",
    input: `
import asyncio, uuid
from datetime import datetime, timezone
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${user.id}")
        acc = await db.scalar(select(MailAccount).where(MailAccount.user_id == uid))
        if acc is None:
            acc = MailAccount(user_id=uid, email=f"{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
            db.add(acc)
            await db.flush()
            db.add(MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox"))
            await db.flush()
        folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == acc.id, MailFolder.role == "inbox"))
        db.add(MailMessage(account_id=acc.id, folder_id=folder.id, uid=int(datetime.now().timestamp()*1000) % 2000000000, thread_key=uuid.uuid4().hex, subject=${JSON.stringify(subject)}, from_name="Your Bank", from_addr=${JSON.stringify(from)}, sent_at=datetime.now(timezone.utc), body_text=${JSON.stringify(text)}))
        await db.commit()
asyncio.run(main())
`,
  });
}

// ---- 1. Hide until the press ---------------------------------------------------------------

test("hide until press: a dispatched focus event opens no menu at all", async () => {
  await addItem(rig, { title: "HideBank", url: "http://hbank.localhost:8111", username: "victim@example.com", password: "HIDE-secret-1" });
  const page = await open(at("evil.hbank.localhost", "adv-hide.html?drop=1"));
  await page.waitForTimeout(1500);
  expect(menus(page)).toHaveLength(0);
  await page.close();
});

for (const hold of [40, 80, 120, 200]) {
  test(`hide until press: a real focus, covered until a ${hold} ms press, fills nothing`, async () => {
    const page = await open(at("evil.hbank.localhost", "adv-hide.html?drop=1&how=focus"));
    await page.waitForTimeout(1800);
    expect(menus(page), "the menu did open").toHaveLength(1);
    await page.mouse.move(180, 145);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.waitForTimeout(hold);
    await page.mouse.up();
    await page.waitForTimeout(900);
    const s = await state(page);
    expect(s.pass).toBe("");
    expect(s.user).toBe("");
    await page.close();
  });
}

test("hide until press: a cover that stays up the whole time fills nothing", async () => {
  const page = await open(at("evil.hbank.localhost", "adv-hide.html?drop=0&how=focus"));
  await page.waitForTimeout(1800);
  await page.mouse.click(180, 145, { delay: 80 });
  await page.waitForTimeout(800);
  expect((await state(page)).pass).toBe("");
  await page.close();
});

test("hide until press: a cover in a closed shadow root fills nothing", async () => {
  const page = await open(at("evil.hbank.localhost", "adv-shadow-cover.html?how=focus"));
  await page.waitForTimeout(1800);
  await page.mouse.click(180, 145, { delay: 80 });
  await page.waitForTimeout(800);
  expect((await state(page)).pass).toBe("");
  await page.close();
});

test("control: with no cover, the same press at the same place fills, once the menu's been showing", async () => {
  const page = await open(at("hbank.localhost", "adv-hide.html?cover=0&how=focus"));
  await page.waitForTimeout(1800);
  expect(menus(page)).toHaveLength(1);
  await page.mouse.click(180, 145, { delay: 80 });
  await expect.poll(async () => (await state(page)).pass).toBe("HIDE-secret-1");
  await page.close();
});

test("control: a press too soon after the menu appears doesn't count, and a second look does", async () => {
  const page = await open(at("hbank.localhost", "adv-hide.html?cover=0&how=focus"));
  await expect.poll(() => menus(page).length, { timeout: 5000, intervals: [50] }).toBe(1);
  await menus(page)[0].getByRole("button", { name: "Fill HideBank" }).waitFor();
  await page.mouse.click(180, 145);
  await page.waitForTimeout(200);
  expect((await state(page)).pass).toBe("");
  await expect(menus(page)[0].getByText("that click didn't count")).toBeVisible();
  await page.waitForTimeout(VISIBLE_FOR);
  await menus(page)[0].getByRole("button", { name: "Fill HideBank" }).click();
  await expect.poll(async () => (await state(page)).pass).toBe("HIDE-secret-1");
  await page.close();
});

// ---- 2 and 8. The menu clicked is the menu checked ----------------------------------------------

test("a hidden child frame's menu takes the click: nothing fills, on the frame or the page", async () => {
  await addItem(rig, { title: "TwoBank", url: "http://tbank.localhost:8111", username: "victim@example.com", password: "TWO-secret-1" });
  const page = await open(at("evil.tbank.localhost", "adv-two.html?how=focus"));
  await page.waitForTimeout(2500);
  const inFrame = menus(page).find((f) => f.parentFrame()?.url().includes("adv-two-frame"));
  expect(inFrame, "the hidden frame has its menu").toBeTruthy();
  const box = await inFrame!.getByRole("button", { name: "Fill TwoBank" }).boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + 60, box!.y + 10, { delay: 90 });
  await page.waitForTimeout(1000);
  expect((await state(page)).pass).toBe("");
  const kid = page.frames().find((f) => f.url().includes("adv-two-frame"))!;
  expect(await kid.evaluate(() => (window as any).__state().pass)).toBe("");
  await page.close();
});

test("a menu's token is the only name it has: another menu's, or none, gets a refusal", async () => {
  const page = await open(at("evil.tbank.localhost", "adv-two.html?how=focus"));
  await page.waitForTimeout(2500);
  const [a] = menus(page);
  expect(a).toBeTruthy();
  const it = await itemNamed("TwoBank");
  for (const token of ["", "0".repeat(32), "not-a-token"]) {
    const out = await a.evaluate(async ([tok, id]) => chrome.runtime.sendMessage({ t: "menuPick", itemId: id, token: tok }), [token, it.id] as const);
    expect(out.r.ok, token).toBe(false);
  }
  expect((await state(page)).pass).toBe("");
  await page.close();
});

test("a cross-origin frame's menu lists that frame's logins, not the page's", async () => {
  const src = encodeURIComponent(at("ads.localhost", "adv-two-frame.html?how=focus"));
  const page = await open(at("tbank.localhost", `adv-two.html?how=focus&src=${src}`));
  await page.waitForTimeout(2500);
  const inAds = menus(page).find((f) => f.parentFrame()?.url().startsWith("http://ads.localhost"));
  expect(inAds, "the frame has a menu").toBeTruthy();
  await expect(inAds!.getByText("No saved logins for this site.")).toBeVisible();
  expect(await inAds!.locator("body").innerText()).not.toContain("TwoBank");
  await page.close();
});

test("a mail code clicked in the honest frame's menu goes to that frame, and not a hostile sibling", async () => {
  await bg(rig, `return chrome.runtime.sendMessage({ t: "setMailCodes", on: true });`);
  seedMail("Your verification code", "no-reply@threeds.localhost", "Your code is 730194");
  const page = await open(at("shop.localhost", `adv-three.html?h=${encodeURIComponent(at("ads.localhost", "adv-otp-focus.html"))}&f=${encodeURIComponent(at("threeds.localhost", "adv-otp.html"))}`));
  await page.waitForTimeout(1500);
  const honest = page.frames().find((f) => f.url().startsWith("http://threeds.localhost"))!;
  const hostile = page.frames().find((f) => f.url().startsWith("http://ads.localhost"))!;
  await honest.click("#code", { timeout: 5000 });
  await expect.poll(() => menus(page).some((f) => f.parentFrame() === honest)).toBe(true);
  const mine = menus(page).find((f) => f.parentFrame() === honest)!;
  const row = mine.getByRole("button", { name: "Fill code from threeds.localhost", exact: true }).first();
  await expect(row).toBeVisible();
  await page.waitForTimeout(VISIBLE_FOR);
  await row.click();
  await expect.poll(() => honest.evaluate(() => (window as any).__state().code)).toBe("730194");
  expect(await hostile.evaluate(() => (window as any).__state().code)).toBe("");
  await page.close();
});

// ---- 3 and 12. Mail --------------------------------------------------------------------------

test("another site's mail code: no code, no row, and the background refuses it too", async () => {
  await bg(rig, `return chrome.runtime.sendMessage({ t: "setMailCodes", on: true });`);
  seedMail("Your verification code", "no-reply@realbank.example", "Your code is 482913");
  const page = await open(at("phish.localhost", "adv-otp.html"));
  await page.waitForTimeout(600);
  await page.click("#code");
  await expect.poll(() => menus(page).length).toBe(1);
  const m = menus(page)[0];
  await expect(m.getByText(/realbank.example has a code. It isn't from this site/)).toBeVisible();
  expect(await m.locator("body").innerText()).not.toContain("482913");
  await expect(m.getByRole("button", { name: /Fill code from realbank/ })).toHaveCount(0);

  const raw = await m.evaluate(async () => {
    const token = location.hash.slice(1);
    const list = (await chrome.runtime.sendMessage({ t: "menuList", token })).r;
    return { list, id: null };
  });
  expect(JSON.stringify(raw.list)).not.toContain("482913");
  await page.close();
});

test("a code stolen with a hidden click: there's nothing to click", async () => {
  await bg(rig, `return chrome.runtime.sendMessage({ t: "setMailCodes", on: true });`);
  seedMail("Your verification code", "no-reply@realbank.example", "Your code is 615243");
  const page = await open(at("anyphish.localhost", "adv-phish.html?how=focus"));
  await page.waitForTimeout(2000);
  await page.mouse.move(180, 145);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  expect((await state(page)).code).toBe("");
  await page.close();
});

test("a sign-in link: never from another sender, shown by domain, and never one click", async () => {
  await bg(rig, `return chrome.runtime.sendMessage({ t: "setMailCodes", on: true });`);
  seedMail("Sign in to your account", "no-reply@not-your-bank.example", "Sign in here: https://not-your-bank.example/magic?code=abc");
  seedMail("Sign in to your account", "no-reply@linkmail.localhost", "Sign in here: https://linkmail.localhost/magic?code=abc");
  const other = await open(at("realsite.localhost", "login.html"));
  await other.waitForTimeout(600);
  await other.click("#user");
  await expect.poll(() => menus(other).length).toBe(1);
  await expect(menus(other)[0].getByText("No saved logins for this site.")).toBeVisible();
  await expect(menus(other)[0].getByRole("button", { name: /sign-in link/i })).toHaveCount(0);
  await other.close();

  const page = await open(at("linkmail.localhost", "login.html"));
  await page.waitForTimeout(600);
  await page.click("#user");
  await expect.poll(() => menus(page).length).toBe(1);
  const m = menus(page)[0];
  const row = m.getByRole("button", { name: "Sign-in link from linkmail.localhost", exact: true }).first();
  await expect(row).toBeVisible();
  // The domain, and not the free text in the From line. And it says what that's worth.
  const body = await m.locator("body").innerText();
  expect(body).not.toContain("Your Bank");
  expect(body).toContain("Senders can be forged");
  await page.waitForTimeout(VISIBLE_FOR);
  const url = page.url();
  await row.click();
  await page.waitForTimeout(300);
  expect(page.url(), "one click doesn't open it").toBe(url);
  await expect(m.getByRole("button", { name: "Don't open it" })).toBeVisible();

  // The menu's own question can't be skipped from the background's side either.
  const rows = await m.evaluate(async () => (await chrome.runtime.sendMessage({ t: "menuList", token: location.hash.slice(1) })).r.mail as { id: string; linkHost: string | null }[]);
  const withLink = rows.find((r) => r.linkHost)!;
  await page.waitForTimeout(VISIBLE_FOR);
  const direct = await m.evaluate(async (id) => chrome.runtime.sendMessage({ t: "menuMailLink", id, token: location.hash.slice(1) }), withLink.id);
  expect(direct.r.ok).toBe(false);
  expect(page.url()).toBe(url);
  await page.close();
});

// ---- 4. Saving -----------------------------------------------------------------------------------

test("a page that sets values and submits gets no save offer, and the stored password stands", async () => {
  await addItem(rig, { title: "SaveBank", url: "http://sbank.localhost:8111", username: "victim@example.com", password: "SAVE-real-1" });
  for (const host of ["evil.sbank.localhost", "sbank.localhost"]) {
    const page = await open(at(host, "adv-sv.html"));
    await page.waitForTimeout(3500);
    expect(await page.evaluate(() => (window as any).__trusted), "the browser called it a real submit").toEqual([true]);
    expect(saves(page), host).toHaveLength(0);
    const waiting = await testHook<unknown[]>(rig, "pending");
    expect(JSON.stringify(waiting)).not.toContain("attacker-chosen-1");
    await page.close();
  }
  const after = await itemNamed("SaveBank");
  expect(after.password).toBe("SAVE-real-1");
  expect(after.history).toBe(0);
});

test("a subdomain can't change its parent's login, even with real typing", async () => {
  const page = await open(at("evil.sbank.localhost", "adv-typed.html"));
  await page.locator("#user").pressSequentially("victim@example.com");
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially("typed-on-evil-1");
  await page.keyboard.press("Escape");
  await page.click("#go");
  await expect.poll(() => saves(page).length, { timeout: 8000 }).toBe(1);
  const bar = saves(page)[0];
  await expect(bar.getByText("Save this login for evil.sbank.localhost?")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Update" })).toHaveCount(0);
  await page.close();
  expect((await itemNamed("SaveBank")).password).toBe("SAVE-real-1");
});

test("the save bar: a stylesheet can't hide it, and a press on it while covered doesn't count", async () => {
  await addItem(rig, { title: "BarBank", url: "http://barbank.localhost:8111", username: "victim@example.com", password: "BAR-real-1" });
  const page = await open(at("barbank.localhost", "adv-typed.html?cover=1"));
  await page.locator("#user").pressSequentially("victim@example.com");
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially("hijacked-update-1");
  await page.keyboard.press("Escape");
  await page.addStyleTag({ content: "html>div[popover]{opacity:0.001!important}" });
  await page.click("#go");
  await expect.poll(() => saves(page).length, { timeout: 8000 }).toBe(1);
  const bar = saves(page)[0];
  await expect(bar.getByRole("button", { name: "Update" })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement.lastElementChild!).opacity), "our styles win").toBe("1");
  const box = await bar.getByRole("button", { name: "Update" }).boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { delay: 80 });
  await page.waitForTimeout(800);
  expect((await itemNamed("BarBank")).password, "the press behind the cover didn't count").toBe("BAR-real-1");
  await page.close();
});

test("control: the same bar, uncovered and looked at, does update", async () => {
  const page = await open(at("barbank.localhost", "adv-typed.html"));
  await page.locator("#user").pressSequentially("victim@example.com");
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially("really-mine-1");
  await page.keyboard.press("Escape");
  await page.click("#go");
  await expect.poll(() => saves(page).length, { timeout: 8000 }).toBe(1);
  const bar = saves(page)[0];
  await expect(bar.getByRole("button", { name: "Update" })).toBeVisible();
  await page.waitForTimeout(VISIBLE_FOR);
  await bar.getByRole("button", { name: "Update" }).click();
  await expect.poll(async () => (await itemNamed("BarBank")).password).toBe("really-mine-1");
  await page.close();
});

test("the toolbar popup offers the same save, where a page can't touch it", async () => {
  const page = await open(at("popupsave.localhost", "adv-typed.html"));
  await page.locator("#user").pressSequentially("pop@example.com");
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially("popup-saved-1");
  await page.keyboard.press("Escape");
  await page.click("#go");
  await expect.poll(() => saves(page).length, { timeout: 8000 }).toBe(1);
  const pop = await popupFor(rig, page);
  const offer = pop.getByTestId("save-offer");
  await expect(offer).toContainText("popupsave.localhost");
  await expect(offer).toContainText("pop@example.com");
  await offer.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await items()).some((i) => i.username === "pop@example.com" && i.password === "popup-saved-1")).toBe(true);
  await pop.close();
  await page.close();
});

test("a cross-origin frame can't raise a bar, or clear the page's own offer", async () => {
  const framed = await open(at("honest.localhost", `adv-framed.html?src=${encodeURIComponent(at("adframe.localhost", "adv-typed.html"))}`));
  await framed.waitForTimeout(600);
  const ad = framed.frames().find((f) => f.url().startsWith("http://adframe.localhost"))!;
  await ad.locator("#user").pressSequentially("junk@example.com");
  await framed.keyboard.press("Escape");
  await ad.locator("#pass").pressSequentially("junk-pass-1");
  await framed.keyboard.press("Escape");
  await ad.locator("#go").click();
  await framed.waitForTimeout(2500);
  expect(saves(framed), "no bar in the honest page").toHaveLength(0);
  expect(JSON.stringify(await testHook(rig, "pending"))).not.toContain("junk-pass-1");
  await framed.close();

  // The page's own offer, and a frame on another origin saying the submit failed.
  const page = await open(at("honest.localhost", `adv-framed.html?src=${encodeURIComponent(at("adframe.localhost", "login.html"))}`));
  await page.waitForTimeout(500);
  const tabId = await tabIdOf(rig, page);
  await bg(rig, `const s = (await chrome.storage.session.get("pendingSave")).pendingSave ?? []; await chrome.storage.session.set({ pendingSave: [...s, { tabId: arg, frameId: 0, offer: { kind: "save", password: "topsecret", host: "honest.localhost", url: "http://honest.localhost:8111/" }, submittedKind: "signin", at: Date.now() }] });`, tabId);
  expect(JSON.stringify(await testHook(rig, "pending")), "planted").toContain("topsecret");
  await bg(
    rig,
    `const all = await chrome.webNavigation.getAllFrames({ tabId: arg });
     const frame = all.find((f) => f.frameId !== 0 && f.url.includes("adframe.localhost"));
     await chrome.scripting.executeScript({ target: { tabId: arg, frameIds: [frame.frameId] }, world: "ISOLATED", func: () => chrome.runtime.sendMessage({ t: "submitFailed" }) });`,
    tabId,
  );
  await page.waitForTimeout(300);
  expect(JSON.stringify(await testHook(rig, "pending"))).toContain("topsecret");

  // Closing the tab takes it out of memory.
  await page.close();
  await expect.poll(async () => JSON.stringify(await testHook(rig, "pending"))).not.toContain("topsecret");
});

// ---- 5. A frame swapped between the check and the send --------------------------------------------

for (const pinned of [true, false]) {
  test(`a frame swapped after the origin check gets nothing (${pinned ? "document id and origin" : "the origin check alone, as on Firefox"})`, async () => {
    await addItem(rig, { title: `SwapBank${pinned}`, url: "http://swbank.localhost:8111", username: "victim@example.com", password: "SWAP-secret-1" });
    const it = await itemNamed(`SwapBank${pinned}`);
    await testHook(rig, "flags", { flags: { fillDelayMs: 1200, noDocumentId: !pinned } });
    try {
      const url = at("swapevil.localhost", `adv-swap.html?bank=${encodeURIComponent(at("swbank.localhost", "login.html"))}&grab=${encodeURIComponent(at("swapevil.localhost", "adv-grab.html"))}`);
      const page = await open(url);
      await page.waitForTimeout(800);
      const pendingFill = fillCall(page, { itemId: it.id, confirmOrigin: "http://swbank.localhost:8111" });
      await page.waitForTimeout(500);
      await page.evaluate(() => (window as any).__swap());
      const r = await pendingFill;
      await page.waitForTimeout(600);
      expect((await state(page)).got, "nothing reached the new frame").toEqual([]);
      expect(r.r?.ok).toBe(false);
      await page.close();
    } finally {
      await testHook(rig, "flags", { flags: { fillDelayMs: 0, noDocumentId: false } });
    }
  });
}

test("a frame that won't answer can't hold a fill open", async () => {
  await addItem(rig, { title: "BusyBank", url: "http://busybank.localhost:8111", username: "victim@example.com", password: "BUSY-1" });
  const it = await itemNamed("BusyBank");
  const page = await open(at("busybank.localhost", "login.html"));
  await page.evaluate((src) => {
    const f = document.createElement("iframe");
    f.src = src;
    document.body.appendChild(f);
  }, at("slowframe.localhost", "adv-busy.html"));
  await page.waitForTimeout(800);
  const started = Date.now();
  const r = await fillCall(page, { itemId: it.id });
  expect(r.r?.ok).toBe(true);
  expect(Date.now() - started).toBeLessThan(3000);
  await page.close();
});

// ---- 6. Sandboxed documents --------------------------------------------------------------------

test("a CSP-sandboxed document isn't the site: no fill, no fill on load, no passkey window", async () => {
  await addItem(rig, { title: "SbBank", url: "http://sbox.localhost:8111", username: "victim@example.com", password: "SANDBOX-secret-1" });
  const it = await itemNamed("SbBank");
  let page = await open(at("sbox.localhost", "adv-sandboxed.html"));
  await page.waitForTimeout(700);
  const r = await fillCall(page, { itemId: it.id });
  await page.waitForTimeout(300);
  expect(r.r?.ok).toBe(false);
  expect((await state(page)).pass).toBe("");
  expect((await state(page)).origin).toBe("null");
  await page.close();

  await patch(it.id, { autofillOnLoad: true });
  page = await open(at("sbox.localhost", "adv-sandboxed.html?x=1"));
  await page.waitForTimeout(1500);
  expect((await state(page)).pass).toBe("");
  await page.close();

  page = await open(at("sbox.localhost", "adv-pk-sandboxed.html"));
  await page.waitForTimeout(1500);
  expect(rig.ctx.pages().filter((x) => x.url().includes("/passkey.html"))).toHaveLength(0);
  await page.close();

  // The same page, not sandboxed, is the control.
  page = await open(at("sbox.localhost", "login.html?x=2"));
  await expect.poll(async () => (await state(page)).pass, { timeout: 8000 }).toBe("SANDBOX-secret-1");
  await page.close();
});

// ---- 7. Only into visible fields ------------------------------------------------------------------

for (const v of ["two", "cover", "pecover", "clip", "right", "below", "transp"]) {
  test(`a password box that can't be seen stays empty: ${v}`, async () => {
    const title = `Hid${v}`;
    await addItem(rig, { title, url: "http://hid.localhost:8111", username: "victim@example.com", password: "HID-secret-1" });
    const it = await itemNamed(title);
    const page = await open(at("hid.localhost", `adv-hidden.html?v=${v}`));
    await page.waitForTimeout(700);
    const r = await fillCall(page, { itemId: it.id });
    await page.waitForTimeout(300);
    const s = await state(page);
    expect(s.pass, JSON.stringify(r)).toBe("");
    expect(s.user).toBe("victim@example.com");
    await page.close();
  });
}

test("control: ordinary boxes fill, with text sitting over one of them", async () => {
  const it = await itemNamed("Hidtwo");
  for (const v of ["", "overlay"]) {
    const page = await open(at("hid.localhost", `adv-hidden.html?v=${v}`));
    await page.waitForTimeout(700);
    await fillCall(page, { itemId: it.id });
    await expect.poll(async () => (await state(page)).pass, { message: v }).toBe("HID-secret-1");
    await page.close();
  }
});

test("control: a form below the fold is scrolled to and filled, boxes together", async () => {
  const it = await itemNamed("Hidtwo");
  const page = await open(at("hid.localhost", "adv-hidden.html"));
  await page.evaluate(() => {
    document.body.style.paddingTop = "3000px";
  });
  await fillCall(page, { itemId: it.id });
  await expect.poll(async () => (await state(page)).pass).toBe("HID-secret-1");
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
  await page.close();
});

test("a card: 2 px number and security code boxes get nothing, and the question says what will fill", async () => {
  await testHook(rig, "addCard", { title: "HidCard", cardNumber: "4111111111111111", cardCvv: "737" });
  const it = await itemNamed("HidCard");
  await patch(it.id, { cardholder: "Ana Victim" });
  const page = await open(at("evil-shop.localhost", "adv-cardhid.html"));
  await page.waitForTimeout(700);
  const first = await fillCall(page, { itemId: it.id });
  const fills = (first.r as unknown as { fills: string[] }).fills;
  expect(fills).toEqual(["name on card"]);
  const r = await fillCall(page, { itemId: it.id, confirmCard: true, confirmFrames: [] });
  await page.waitForTimeout(400);
  expect(r.r?.ok).toBe(true);
  const s = await state(page);
  expect(s.nm).toBe("Ana Victim");
  expect(s.num).toBe("");
  expect(s.cvv).toBe("");
  // Not even sent to the frame.
  const log = await testHook<{ doFills: { url: string; keys: string[] }[] }>(rig, "log");
  expect(log.doFills.at(-1)!.keys).toEqual(["card-name"]);
  await page.close();
});

// ---- 9. Passkeys ----------------------------------------------------------------------------------

const passkeyWindows = () => rig.ctx.pages().filter((x) => x.url().includes("/passkey.html"));

test("passkeys: no gesture, no window, however many a page asks for", async () => {
  // Long enough after loading that nothing the test tooling did still counts as a gesture.
  const page = await rig.ctx.newPage();
  await page.goto(at("pk.localhost", "adv-pk.html?burst=3&auto=1&delay=7000"));
  await new Promise((r) => setTimeout(r, 8500));
  expect(passkeyWindows()).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__asked), "the page had no gesture when it asked").toBe(false);
  await page.close();
});

test("passkeys: three at once from a real click opens one window and refuses the rest", async () => {
  const page = await open(at("pk.localhost", "adv-pk.html?burst=3"));
  await page.waitForTimeout(300);
  const opened = rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 10_000 });
  await page.click("#go");
  const prompt = await opened;
  await page.waitForTimeout(800);
  expect(passkeyWindows()).toHaveLength(1);
  const s = await state(page);
  expect(s.r.filter((x: { err?: string }) => x.err === "NotAllowedError")).toHaveLength(2);

  // Nothing the site calls itself ends up in the vault or the prompt.
  await expect(prompt.locator("body")).not.toContainText("Totally Google");
  await prompt.getByRole("button", { name: "Save as a new item" }).click();
  await expect.poll(async () => (await state(page)).r.some((x: { id?: string }) => x.id)).toBe(true);
  await expect.poll(async () => (await items()).some((i) => i.title === "pk.localhost")).toBe(true);
  expect((await items()).some((i) => i.title.includes("Google"))).toBe(false);
  await page.close();
});

test("passkeys: a known excluded id isn't a silent probe: it answers only after the prompt", async () => {
  const seen = await open(at("pk.localhost", "adv-pk.html?burst=1"));
  const made = rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 10_000 });
  await seen.click("#go");
  await (await made).getByRole("button", { name: "Save as a new item" }).click();
  await expect.poll(async () => (await state(seen)).r.some((x: { id?: string }) => x.id)).toBe(true);
  const id = (await state(seen)).r.find((x: { id?: string }) => x.id).id;
  await seen.close();

  const page = await open(at("pk.localhost", `adv-pk.html?ex=${id}`));
  const asked = rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 10_000 });
  await page.click("#go");
  const prompt = await asked;
  await page.waitForTimeout(800);
  expect((await state(page)).r, "no answer yet").toEqual([]);
  await expect(prompt.getByText("You already have a passkey")).toBeVisible();
  await prompt.getByRole("button", { name: "Tell the site" }).click();
  await expect.poll(async () => (await state(page)).r[0]?.err).toBe("InvalidStateError");
  await page.close();
});

test("passkeys: a prompt's buttons don't take a click in their first moment", async () => {
  const page = await open(at("pk.localhost", "adv-pk.html?burst=1"));
  const asked = rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 10_000 });
  await page.click("#go");
  const prompt = await asked;
  await prompt.waitForSelector("button", { state: "attached" });
  const buttons = prompt.getByRole("button", { name: "Save as a new item" });
  expect(await buttons.isDisabled()).toBe(true);
  await expect(buttons).toBeEnabled({ timeout: 3000 });
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await page.close();
});

test("passkeys: conditional requests still pass straight through, with no gesture and no window", async () => {
  const page = await open(at("pk.localhost", "adv-pk.html"));
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as any).__conditional());
  await page.waitForTimeout(800);
  expect(passkeyWindows()).toHaveLength(0);
  await page.close();
});

test("passkeys: cross-origin is judged on every ancestor, so A inside B inside A says so", async () => {
  const inner = at("aba.localhost", "webauthn.html");
  const middle = at("middle.localhost", `adv-nest.html?src=${encodeURIComponent(inner)}`);
  const page = await open(at("aba.localhost", `adv-nest.html?src=${encodeURIComponent(middle)}`));
  await page.waitForTimeout(1200);
  const frame = page.frames().find((f) => new URL(f.url()).pathname === "/webauthn.html")!;
  const opened = rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 10_000 });
  const run = frame.evaluate((o) => (window as any).__register(o), { rpId: "aba.localhost", userId: Buffer.from("aba").toString("base64url"), userName: "aba@example.com", challenge: crypto.randomBytes(32).toString("base64url") });
  await (await opened).getByRole("button", { name: "Save as a new item" }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  const client = JSON.parse(Buffer.from(r.response.clientDataJSON, "base64url").toString());
  expect(client.crossOrigin).toBe(true);
  await page.close();
});

// ---- 10. Generate -----------------------------------------------------------------------------------

test("generate behind a cover: nothing's generated, and the stored login's untouched", async () => {
  await addItem(rig, { title: "GenBank", url: "http://gen.localhost:8111", username: "victim@example.com", password: "GEN-real-1" });
  let page = await open(at("gen.localhost", "adv-gen.html"));
  await page.waitForTimeout(1800);
  expect(menus(page), "a dispatched focus opens nothing").toHaveLength(0);
  await page.close();

  page = await open(at("gen.localhost", "adv-gen.html?how=focus"));
  await page.waitForTimeout(1800);
  const m = menus(page)[0];
  const box = await m.getByRole("button", { name: /Generate a password/ }).boundingBox();
  await page.mouse.click(box!.x + 40, box!.y + 8, { delay: 80 });
  await page.waitForTimeout(800);
  expect((await itemNamed("GenBank")).pendingPassword).toBeUndefined();
  expect((await state(page)).b).toBe("");
  await page.close();
});

test("generate on a change form won't touch an item that asks for the master password", async () => {
  await addItem(rig, { title: "GenGuarded", url: "http://genguard.localhost:8111", username: "g@example.com", password: "GUARD-real-1" });
  const it = await itemNamed("GenGuarded");
  await patch(it.id, { reprompt: true });
  const page = await open(at("genguard.localhost", "adv-gen.html?how=focus&cover=0"));
  await page.waitForTimeout(1800);
  const m = menus(page)[0];
  await m.getByRole("button", { name: /Generate a password/ }).click();
  await expect(m.getByText("fill this one from the toolbar")).toBeVisible();
  expect((await itemNamed("GenGuarded")).pendingPassword).toBeUndefined();
  expect((await state(page)).b).toBe("");
  await page.close();
});

test("control: generate with the menu in plain view works", async () => {
  await addItem(rig, { title: "GenOk", url: "http://genok.localhost:8111", username: "ok@example.com", password: "OK-real-1" });
  const page = await open(at("genok.localhost", "adv-gen.html?how=focus&cover=0"));
  await page.waitForTimeout(1800);
  await menus(page)[0].getByRole("button", { name: /Generate a password/ }).click();
  await expect.poll(async () => (await state(page)).b).not.toBe("");
  expect((await itemNamed("GenOk")).pendingPassword).toBe((await state(page)).b);
  await page.close();
});

// ---- 11. On-click mode --------------------------------------------------------------------------------

test("on-click mode: after a popup fill the page still gets no menu, and menu messages are refused", async () => {
  await addItem(rig, { title: "ClickBank", url: "http://clickbank.localhost:8111", username: "victim@example.com", password: "CLICK-secret-1" });
  const it = await itemNamed("ClickBank");
  await bg(rig, `return chrome.runtime.sendMessage({ t: "setAccess", onClickOnly: true });`);
  try {
    const page = await open(at("clickbank.localhost", "login.html"));
    await page.waitForTimeout(500);
    await page.click("#user");
    await page.waitForTimeout(500);
    expect(menus(page)).toHaveLength(0);
    const r = await fillCall(page, { itemId: it.id });
    expect(r.r?.ok).toBe(true);
    await page.bringToFront();
    await page.evaluate(() => {
      (document.getElementById("user") as HTMLInputElement).value = "";
      (document.getElementById("pass") as HTMLInputElement).value = "";
      (document.activeElement as HTMLElement)?.blur?.();
    });
    await page.click("#pass");
    await page.waitForTimeout(800);
    expect(menus(page), "the injected script has no menu").toHaveLength(0);
    await page.close();
  } finally {
    await bg(rig, `return chrome.runtime.sendMessage({ t: "setAccess", onClickOnly: false });`);
  }
});

// ---- 13 and 14. Matching ------------------------------------------------------------------------------

test("a saved host with no port doesn't match another port, or fill on load there", async () => {
  await addItem(rig, { title: "PortBank", url: "http://portbank.localhost", username: "victim@example.com", password: "PORT-secret-1" });
  const it = await itemNamed("PortBank");
  await patch(it.id, { autofillOnLoad: true });
  const page = await open(at("portbank.localhost", "login.html"));
  await page.waitForTimeout(1500);
  expect((await state(page)).pass).toBe("");
  const pop = await popupFor(rig, page);
  await expect(pop.getByRole("button", { name: "Fill PortBank" })).toHaveCount(0);
  await pop.close();
  await page.close();
});

test("prefix mode doesn't cross a host boundary", async () => {
  await addItem(rig, { title: "PrefixBank", url: "http://prefixbank.localhost:8111", username: "victim@example.com", password: "PREFIX-secret-1" });
  const it = await itemNamed("PrefixBank");
  await patch(it.id, { urls: [{ url: "http://prefixbank.localhost:8111", match: "prefix" }] });
  const page = await open("http://prefixbank.localhost.evil.localhost:8111/login.html");
  await page.waitForTimeout(500);
  await page.click("#user");
  await expect.poll(() => menus(page).length).toBe(1);
  await expect(menus(page)[0].getByText("No saved logins for this site.")).toBeVisible();
  await page.close();
});

// ---- 15 and 16. Smaller things ---------------------------------------------------------------------------

test("the wrapper leaves no flag on the page", async () => {
  const page = await open(at("probe.localhost", "webauthn.html"));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => "__promptlyPk" in window)).toBe(false);
  await page.close();
});

test("a QR code doesn't quietly replace a 2FA secret, and the old one's kept", async () => {
  await addItem(rig, { title: "QrKept", url: "http://qrkept.localhost:8111", username: "q@example.com", password: "Q-1" });
  const it = await itemNamed("QrKept");
  await patch(it.id, { totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
  const uri = "otpauth://totp/Other:evil?secret=GEZDGNBVGY3TQOJQ&issuer=Other";
  const ask = (replace?: boolean) => bg<{ r: { ok: boolean; replaces?: string } }>(rig, `return chrome.runtime.sendMessage({ t: "addTotp", itemId: arg.id, uri: arg.uri, title: "QrKept", url: "", replace: arg.replace });`, { id: it.id, uri, replace });
  const first = await ask();
  expect(first.r.ok).toBe(false);
  expect(first.r.replaces).toBe("QrKept");
  const body = await bg<{ r: { totp: { secret: string }; fields?: { name: string; value: string }[] } }>(rig, `return chrome.runtime.sendMessage({ t: "item", id: arg });`, it.id);
  expect(body.r.totp.secret).toBe("JBSWY3DPEHPK3PXP");
  await ask(true);
  const after = await bg<{ r: { totp: { secret: string }; fields: { name: string; value: string }[] } }>(rig, `return chrome.runtime.sendMessage({ t: "item", id: arg });`, it.id);
  expect(after.r.totp.secret).toBe("GEZDGNBVGY3TQOJQ");
  expect(after.r.fields.some((f) => f.value === "JBSWY3DPEHPK3PXP")).toBe(true);
});

void menuFrame;
void MASTER;
