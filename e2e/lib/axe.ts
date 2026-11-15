import type { Page } from "@playwright/test";

type AxeNode = { target: unknown[]; any: { message: string }[] };
type AxeViolation = { id: string; impact?: string | null; help: string; nodes: AxeNode[] };

/**
 * Serious and critical findings as one line each, without the one finding
 * that isn't a spec's to make: white words on the brand terracotta.
 *
 * Filled buttons wear Promptly's own terracotta (``--accent``, which
 * ``--accent-strong`` and the item kit's ``--item-accent-fill`` follow since
 * v0.38.1). White on it is about 3:1, under WCAG AA's 4.5:1 — the owner's
 * chosen colour, tracked on its own (V14), not something each screen's scan
 * should fail on. Every other contrast finding still counts, and the line
 * says which colours, so a new one is easy to place.
 */
export async function seriousFindings(page: Page, what: string, violations: AxeViolation[]): Promise<string[]> {
  const brand = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const probe = document.createElement("i");
    document.body.appendChild(probe);
    const hex = (name: string) => {
      probe.style.color = "";
      probe.style.color = css.getPropertyValue(name).trim();
      const m = getComputedStyle(probe).color.match(/\d+/g);
      return m ? "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : "";
    };
    const out = ["--accent", "--accent-strong", "--item-accent-fill"].map(hex).filter(Boolean);
    probe.remove();
    return [...new Set(out)];
  });
  const onBrand = (n: AxeNode) => n.any.some((c) => brand.some((b) => c.message.toLowerCase().includes(`background color: ${b}`)));
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !onBrand(n)) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => {
      const where = v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ");
      const colours = v.id === "color-contrast" ? ` — ${(v.nodes[0].any[0]?.message ?? "").replace(/\s+/g, " ").slice(0, 160)}` : "";
      return `${what}: ${v.id} (${v.impact}) — ${v.help} — ${where}${colours}`;
    });
}
