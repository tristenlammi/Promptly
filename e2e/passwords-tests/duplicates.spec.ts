// Duplicates: found on the device, counted in the sidebar, merged one at a time or all at once,
// "Not a duplicate" kept in the vault, and the merged copies in Trash.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import { addLogin, makeUsers, onboard, signedIn, unlock } from "./helpers";

test.describe.configure({ timeout: 600_000 });

const navBar = (page: Page) => page.getByRole("navigation", { name: "Passwords" });
const nav = (page: Page, name: string) => navBar(page).getByText(name, { exact: true }).click();
const count = (page: Page) => navBar(page).getByTestId("nav-count-Duplicates");
const group = (page: Page, site: string) => page.getByTestId("dupe-group").filter({ has: page.getByRole("heading", { name: site, exact: true }) });

/** WCAG A/AA problems, less the known accent-button contrast: the brand colour, tracked on its
 *  own (the same exception app-nav.spec.ts and photos-a11y.spec.ts make). */
async function axe(page: Page, what: string): Promise<string[]> {
  await page.mouse.move(0, 0); // no hover colours
  const { violations } = await new AxeBuilder({ page })
    .include('[data-testid="duplicates-screen"]')
    .include('nav[aria-label="Passwords"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const accent = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
  return violations
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.toLowerCase().includes(`background color: ${accent}`))) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => `${what}: ${v.id} (${v.nodes.map((n) => `${n.target.join(" ")} ${n.any.map((c) => c.message).join("; ")}`).join(" | ")})`);
}

test("finds duplicates and near-duplicates, merges, dismisses, merges all, and Trash holds the rest", async ({ browser }) => {
  const [u] = makeUsers(["dupes"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);

  // Saved twice: the same site and username, give or take case, spaces and www.
  await addLogin(page, { title: "Kickstarter old", username: "tristen.lammi@gmail.com", password: "Kick-One-1!", url: "https://www.kickstarter.com/" });
  await addLogin(page, { title: "Kickstarter", username: "Tristen.Lammi@Gmail.com", password: "Kick-Two-2!", url: "https://kickstarter.com/login" });
  await addLogin(page, { title: "GitHub old", username: "ana", password: "Git-One-1!", url: "https://github.com/" });
  await addLogin(page, { title: "GitHub", username: "ana", password: "Git-Two-2!", url: "https://www.github.com/login" });
  await addLogin(page, { title: "Reddit old", username: "bo", password: "Red-One-1!", url: "https://www.reddit.com/" });
  await addLogin(page, { title: "Reddit", username: "bo", password: "Red-Two-2!", url: "https://reddit.com/" });
  // Probably the same: one password, two usernames.
  await addLogin(page, { title: "Instagram", username: "tristen.lammi", password: "Insta-Same-1!", url: "https://www.instagram.com/" });
  await addLogin(page, { title: "Instagram 2", username: "tristenlammi", password: "Insta-Same-1!", url: "https://instagram.com/" });
  await addLogin(page, { title: "Twitch", username: "streamer.one", password: "Twitch-Same-1!", url: "https://www.twitch.tv/" });
  await addLogin(page, { title: "Twitch 2", username: "streamer.two", password: "Twitch-Same-1!", url: "https://twitch.tv/" });
  // Not duplicates: two services on one domain, and two accounts on one site.
  await addLogin(page, { title: "Gym zyx", username: "me", password: "Gym-Same-1!", url: "https://zyx.gymserver.org/" });
  await addLogin(page, { title: "Gym abc", username: "me", password: "Gym-Same-1!", url: "https://abc.gymserver.org/" });
  await addLogin(page, { title: "Steam main", username: "one", password: "Steam-1!", url: "https://store.steampowered.com/" });
  await addLogin(page, { title: "Steam alt", username: "two", password: "Steam-2!", url: "https://store.steampowered.com/" });

  await expect(count(page)).toHaveText(/^5/);
  await nav(page, "Duplicates");
  await expect(page.getByTestId("dupes-sure").getByTestId("dupe-group")).toHaveCount(3);
  await expect(page.getByTestId("dupes-likely").getByTestId("dupe-group")).toHaveCount(2);
  await expect(group(page, "gymserver.org")).toHaveCount(0);
  await expect(page.getByText("Steam main")).toHaveCount(0);
  // Side by side, with what each has.
  const insta = group(page, "instagram.com");
  await expect(insta.getByTestId("dupe-login")).toHaveCount(2);
  await expect(insta).toContainText("tristen.lammi");
  await expect(insta).toContainText("tristenlammi");
  await expect(insta).toContainText("Last changed");

  // Phone width: the drawer shows the count, the cards stack, nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(count(page)).toHaveText(/^5/);
  await nav(page, "Duplicates");
  await expect(insta.getByTestId("dupe-login").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const bad = await axe(page, "phone");
  await page.setViewportSize({ width: 1280, height: 860 });
  bad.push(...(await axe(page, "desktop")));
  await page.emulateMedia({ colorScheme: "dark" });
  bad.push(...(await axe(page, "desktop, dark")));
  await page.emulateMedia({ colorScheme: "light" });
  expect(bad).toEqual([]);

  // Merge one, keeping the older login, then undo it, then merge it again.
  await insta.getByRole("radio", { name: "Keep Instagram", exact: true }).check();
  await insta.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByTestId("dupes-done")).toContainText("Merged into Instagram.");
  await expect(count(page)).toHaveText(/^4/);
  await page.getByTestId("dupes-done").getByRole("button", { name: "Undo" }).click();
  await expect(count(page)).toHaveText(/^5/);
  await expect(insta).toHaveCount(1);
  await insta.getByRole("radio", { name: "Keep Instagram", exact: true }).check();
  await insta.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(page.getByTestId("dupes-done")).toContainText("Merged into Instagram.");
  await expect(count(page)).toHaveText(/^4/);

  // Not a duplicate: gone now, and still gone after a reload, since it's kept in the vault.
  await group(page, "twitch.tv").getByRole("button", { name: "Not a duplicate" }).click();
  await expect(page.getByTestId("dupes-done")).toContainText("won't be suggested again");
  await expect(group(page, "twitch.tv")).toHaveCount(0);
  await expect(count(page)).toHaveText(/^3/);
  await page.reload();
  await unlock(page);
  await expect(count(page)).toHaveText(/^3/);
  await nav(page, "Duplicates");
  await expect(group(page, "twitch.tv")).toHaveCount(0);
  await expect(page.getByText("You've marked 1 pair of logins as not duplicates.")).toBeVisible();

  // Merge all the sure ones, after a confirm with the count.
  await page.getByRole("button", { name: "Merge all sure duplicates (3)" }).click();
  const dialog = page.getByRole("dialog", { name: "Merge all sure duplicates?" });
  await expect(dialog).toContainText("3 sets of logins saved twice");
  await expect(dialog).toContainText("3 logins go to Trash for 30 days");
  await dialog.getByRole("button", { name: "Merge 3" }).click();
  await expect(page.getByTestId("dupes-done")).toContainText("Merged 3 sets. 3 logins are in Trash for 30 days.");
  await expect(page.getByTestId("dupes-empty")).toBeVisible();
  await expect(count(page)).toHaveCount(0);

  // Security check no longer mentions them.
  await nav(page, "Security check");
  await expect(page.getByTestId("duplicates")).toHaveCount(0);

  // The kept login has the other username; the copies wait in Trash.
  await nav(page, "All items");
  await page.getByRole("list", { name: "Items" }).getByRole("button", { name: /^Instagram/ }).click();
  const kept = page.getByRole("article", { name: "Instagram" });
  await expect(kept).toContainText("Other username");
  await expect(kept).toContainText("tristenlammi");
  await nav(page, "Trash");
  for (const title of ["Instagram 2", "Kickstarter old", "GitHub old", "Reddit old"]) await expect(page.getByText(title, { exact: true })).toBeVisible();
  for (const title of ["Instagram", "Kickstarter", "GitHub", "Reddit", "Twitch", "Twitch 2"]) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  await ctx.close();
});
