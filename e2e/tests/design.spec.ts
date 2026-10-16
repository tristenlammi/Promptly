import { expect, ready, test } from "../fixtures";

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace("#", "");
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("design system", () => {
  test("light-theme text colours are readable (WCAG AA)", async ({ alice: page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: "light" }, version: 0 }))
    );
    await page.goto("/chat");
    await ready(page);
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const get = (n: string) => cs.getPropertyValue(n).trim();
      return { dark: document.documentElement.classList.contains("dark"), bg: get("--bg"), surface: get("--surface"),
               accentText: get("--accent-text"), muted: get("--text-muted"), success: get("--success"), danger: get("--danger") };
    });
    expect(tokens.dark).toBe(false);
    for (const fg of [tokens.accentText, tokens.muted, tokens.success, tokens.danger]) {
      for (const bg of [tokens.bg, tokens.surface]) {
        expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("light-theme links in a reply are readable (V14)", async ({ alice: page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: "light" }, version: 0 }))
    );
    await page.goto("/chat");
    await ready(page);
    await page.getByPlaceholder(/^Message Promptly/).fill("see [the docs](https://example.com/docs)");
    await page.getByRole("button", { name: "Send message" }).click();
    const link = page.locator(".promptly-message:not(.flex-row-reverse) .promptly-prose a").last();
    await expect(link).toHaveText("the docs");
    // The reply re-renders as it finishes streaming; read the colour once
    // the link has settled into the finished message.
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    const [color, bg] = await link.evaluate((el) => [
      getComputedStyle(el).color,
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
    ]);
    expect(color, "computed link colour").toMatch(/[0-9]/);
    const fg = "#" + (color.match(/[0-9]+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test("a destructive confirm starts on Cancel, Escape closes it, focus comes back", async ({ alice: page }) => {
    await page.goto("/chat");
    await ready(page);
    await page.getByPlaceholder(/^Message Promptly/).fill("to be archived");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await page.locator("aside").getByRole("button", { name: "Archive conversation" }).first().click({ force: true });

    await page.goto("/archive");
    await ready(page);
    const del = page.getByRole("button", { name: "Delete forever" }).first();
    await del.focus();
    await del.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(del).toBeFocused();
  });

  test("the phone menu is out of reach while closed and Escape closes it", async ({ alice: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat");
    await expect(page.getByText("Loading Promptly...")).toHaveCount(0);
    const drawer = page.getByRole("dialog", { name: "Navigation menu", includeHidden: true });
    await expect(drawer).toHaveAttribute("inert", "");

    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(drawer).not.toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveAttribute("inert", "");
  });
});
