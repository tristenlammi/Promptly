import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { badgeLabel, badgeText } from "@/lib/countBadge";

import { CountBadge } from "./CountBadge";

describe("badgeText", () => {
  it("shows nothing for zero, nonsense or less", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(-3)).toBe("");
    expect(badgeText(undefined)).toBe("");
    expect(badgeText(Number.NaN)).toBe("");
  });
  it("shows the number up to 99, then 99+", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
    expect(badgeText(12345)).toBe("99+");
  });
});

describe("badgeLabel", () => {
  it("says the real number in each app's words", () => {
    expect(badgeLabel("mail", 3)).toBe("3 unread");
    expect(badgeLabel("rooms", 1)).toBe("1 unread");
    expect(badgeLabel("tasks", 2)).toBe("2 due");
    expect(badgeLabel("porch", 150)).toBe("150 new");
    expect(badgeLabel("something-else", 4)).toBe("4 new");
    expect(badgeLabel("mail", 0)).toBe("");
  });
});

describe("CountBadge", () => {
  it("renders nothing at zero", () => {
    expect(renderToStaticMarkup(<CountBadge app="mail" n={0} />)).toBe("");
    expect(renderToStaticMarkup(<CountBadge app="mail" n={undefined} />)).toBe("");
  });

  it("is a labelled terracotta circle with the number", () => {
    const html = renderToStaticMarkup(<CountBadge app="mail" n={3} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="3 unread"');
    expect(html).toContain('data-badge="mail"');
    expect(html).toContain("bg-[var(--accent-strong)]");
    expect(html).toContain("rounded-full");
    expect(html).toMatch(/>3<\/span>$/);
  });

  it("caps the digits at 99+ but tells a screen reader the real count", () => {
    const html = renderToStaticMarkup(<CountBadge app="rooms" n={240} />);
    expect(html).toMatch(/>99\+<\/span>$/);
    expect(html).toContain('aria-label="240 unread"');
  });

  it("sits on the icon's corner in the collapsed rail", () => {
    const corner = renderToStaticMarkup(<CountBadge app="tasks" n={2} corner />);
    expect(corner).toContain("absolute");
    expect(corner).toContain("ring-[var(--surface)]");
    const row = renderToStaticMarkup(<CountBadge app="tasks" n={2} />);
    expect(row).not.toContain("absolute");
    expect(row).toContain("ml-auto");
  });
});
