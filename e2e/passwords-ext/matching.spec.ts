// Site matching (DECISIONS.md D89 to D93): two self-hosted services on one domain
// with different logins, a service on its own port, the item's match setting, and the warning
// on a lookalike. Local names only: *.localhost reaches the fixture server on 127.0.0.1.
import { expect, type Page, test } from "@playwright/test";

import { addItem, bg, connect, launch, makeUsers, menuFrame, popupFor, type Rig, startSite, tabIdOf, testHook, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 240_000 });

let rig: Rig;
let site: { close: () => void };

const ZYX = "http://zyx.gymserver.localhost:8111";
const ABC = "http://abc.gymserver.localhost:8111";

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [owner] = makeUsers(["matcher"]);
  await connect(rig, owner);
  await unlockExt(rig);
  await addItem(rig, { title: "Gym ZYX", url: ZYX, username: "zyx-user", password: "Zyx-Pw-1" });
  await addItem(rig, { title: "Gym ABC", url: ABC, username: "abc-user", password: "Abc-Pw-1" });
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

/** A press only counts once the menu has been showing a while (press.ts). */
const LOOK_MS = 800;

type ItemOut = { id: string; title: string; username?: string; password?: string; match?: string; urls: { url: string; match?: string }[] };
const items = () => testHook<ItemOut[]>(rig, "items");

async function openMenu(page: Page) {
  await page.click("#user");
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  await page.waitForTimeout(LOOK_MS);
  return f;
}

const badge = async (page: Page) => bg<string>(rig, "return await chrome.action.getBadgeText({ tabId: arg });", await tabIdOf(rig, page));
const state = (page: Page) => page.evaluate(() => (window as unknown as { __state: () => { user: string; pass: string } }).__state());
const saveFrame = (page: Page) => page.frames().find((f) => f.url().includes("/save.html"));

test("each self-hosted service gets its own login, and the other is set apart", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`${ZYX}/login.html`);

  const pop = await popupFor(rig, page);
  await expect(pop.getByRole("button", { name: "Fill Gym ZYX" })).toBeVisible();
  const others = pop.getByTestId("other-logins");
  await expect(others).toContainText("Other logins for gymserver.localhost");
  await expect(others.getByRole("button", { name: "Fill Gym ABC" })).toBeVisible();
  await expect(others.getByRole("button", { name: "Fill Gym ZYX" })).toHaveCount(0);
  await pop.close();
  // Only this site's own login is counted on the badge.
  await expect.poll(() => badge(page)).toBe("1");

  // The inline menu offers only the zyx login, and fills it.
  const menu = await openMenu(page);
  await expect(menu.getByRole("button", { name: "Fill Gym ZYX" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Fill Gym ABC" })).toHaveCount(0);
  await menu.getByRole("button", { name: "Fill Gym ZYX" }).click();
  await expect.poll(() => state(page)).toEqual({ user: "zyx-user", pass: "Zyx-Pw-1" });
  await page.close();

  // And the other way round on abc.
  const other = await rig.ctx.newPage();
  await other.goto(`${ABC}/login.html`);
  const m2 = await openMenu(other);
  await expect(m2.getByRole("button", { name: "Fill Gym ABC" })).toBeVisible();
  await expect(m2.getByRole("button", { name: "Fill Gym ZYX" })).toHaveCount(0);
  await other.close();
});

test("on a host of the domain with no login of its own, both are offered under their heading", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://gymserver.localhost:8111/login.html");
  const menu = await openMenu(page);
  await expect(menu.getByText("Other logins for gymserver.localhost")).toBeVisible();
  await expect(menu.getByRole("button", { name: "Fill Gym ABC" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Fill Gym ZYX" })).toBeVisible();
  await expect.poll(() => badge(page)).toBe("");
  await page.close();
});

test("a new login on another service is saved beside the zyx one, not over it", async () => {
  const page = await rig.ctx.newPage();
  await page.goto("http://new.gymserver.localhost:8111/login.html");
  // The same username as the zyx login, and another password.
  await page.locator("#user").pressSequentially("zyx-user");
  await page.keyboard.press("Escape");
  await page.locator("#pass").pressSequentially("New-Pw-1");
  await page.keyboard.press("Escape");
  await page.click("#go");
  await page.waitForURL(/welcome/);
  await expect.poll(() => !!saveFrame(page), { timeout: 15_000 }).toBe(true);
  const save = saveFrame(page)!;
  await expect(save.getByText("Save this login for new.gymserver.localhost?")).toBeVisible();
  await page.waitForTimeout(LOOK_MS);
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await items()).some((i) => i.urls.some((u) => u.url.includes("new.gymserver.localhost")))).toBe(true);
  const all = await items();
  expect(all.find((i) => i.title === "Gym ZYX")?.password).toBe("Zyx-Pw-1");
  expect(all.find((i) => i.urls.some((u) => u.url.includes("new.gymserver.localhost")))?.password).toBe("New-Pw-1");
  await page.close();
});

test("ports: an address with no port fills on any port, and a saved port is its own service", async () => {
  await addItem(rig, { title: "NAS", url: "http://nas.localhost", username: "nas-admin", password: "Nas-Pw-1" });
  await addItem(rig, { title: "NAS DSM", url: "http://nas.localhost:8112", username: "dsm-admin", password: "Dsm-Pw-1" });

  // :8111 has no login of its own: the no-port one is offered.
  const a = await rig.ctx.newPage();
  await a.goto("http://nas.localhost:8111/login.html");
  const menuA = await openMenu(a);
  await expect(menuA.getByRole("button", { name: "Fill NAS", exact: true })).toBeVisible();
  await expect(menuA.getByRole("button", { name: "Fill NAS DSM" })).toHaveCount(0);
  await menuA.getByRole("button", { name: "Fill NAS", exact: true }).click();
  await expect.poll(() => state(a)).toEqual({ user: "nas-admin", pass: "Nas-Pw-1" });
  await a.close();

  // :8112 has its own: that's the one, and the no-port one is set apart.
  const b = await rig.ctx.newPage();
  await b.goto("http://nas.localhost:8112/login.html");
  const pop = await popupFor(rig, b);
  await expect(pop.getByRole("button", { name: "Fill NAS DSM" })).toBeVisible();
  await expect(pop.getByTestId("other-logins").getByRole("button", { name: "Fill NAS", exact: true })).toBeVisible();
  await pop.close();
  const menuB = await openMenu(b);
  await expect(menuB.getByRole("button", { name: "Fill NAS DSM" })).toBeVisible();
  await expect(menuB.getByRole("button", { name: "Fill NAS", exact: true })).toHaveCount(0);
  await b.close();

  // An IP address saved with no port, on a port.
  await addItem(rig, { title: "Loopback", url: "http://127.0.0.1", username: "lo", password: "Lo-Pw-1" });
  const ip = await rig.ctx.newPage();
  await ip.goto("http://127.0.0.1:8111/login.html");
  const pip = await popupFor(rig, ip);
  await expect(pip.getByRole("button", { name: "Fill Loopback" })).toBeVisible();
  await pip.close();
  await ip.close();
});

test("the item's match setting, from the vault page's editor", async () => {
  const v = await rig.ctx.newPage();
  await v.goto(`chrome-extension://${rig.extId}/vault.html#/all`);
  await v.getByRole("list", { name: "Items" }).getByRole("button").filter({ hasText: "NAS" }).filter({ hasNotText: "DSM" }).first().click();
  await v.getByRole("button", { name: "Edit" }).click();
  const select = v.getByLabel("How this login matches websites");
  await expect(select).toHaveValue("auto");
  await select.selectOption("port");
  await expect(v.getByText("Only this host, and only on this port.")).toBeVisible();
  await v.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await items()).find((i) => i.title === "NAS")?.match).toBe("port");
  await v.close();
  // Exact host and port: a no-port address now only fills on the default port.
  await expect.poll(async () => {
    const p = await rig.ctx.newPage();
    await p.goto("http://nas.localhost:8111/login.html");
    const pop = await popupFor(rig, p);
    await pop.waitForTimeout(500);
    const n = await pop.getByRole("button", { name: "Fill NAS", exact: true }).count();
    await pop.close();
    await p.close();
    return n;
  }, { timeout: 20_000 }).toBe(0);
});

test("a lookalike gets no login, and a plain warning says why", async () => {
  await addItem(rig, { title: "Example Bank", url: "http://example.localhost:8111", username: "me", password: "Bank-Pw-1" });
  const page = await rig.ctx.newPage();
  await page.goto("http://examp1e.localhost:8111/login.html");
  const pop = await popupFor(rig, page);
  await expect(pop.getByTestId("lookalike")).toContainText("This is examp1e.localhost. Your login for example.localhost isn't offered here.");
  await expect(pop.getByRole("button", { name: "Fill Example Bank" })).toHaveCount(0);
  await pop.close();
  const menu = await openMenu(page);
  await expect(menu.getByText("This is examp1e.localhost. Your login for example.localhost isn't offered here.")).toBeVisible();
  await expect(menu.getByRole("button", { name: "Fill Example Bank" })).toHaveCount(0);
  await expect(menu.getByText("No saved logins for this site.")).toHaveCount(0);
  await page.close();
});
