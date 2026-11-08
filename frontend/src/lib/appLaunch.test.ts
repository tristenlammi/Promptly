// The one signal for "is this window Promptly, or an app installed on its
// own?" (lib/appLaunch.ts). Node, no browser: window, sessionStorage and the
// display mode are stubbed per case.
import { afterEach, describe, expect, it, vi } from "vitest";

import { appKeyFor, launchFromUrl } from "./appLaunch";

describe("appKeyFor", () => {
  it.each([
    ["/", "promptly"],
    ["/chat/123", "promptly"],
    ["/files/photos", "promptly"],
    ["/photos", "photos"],
    ["/photos/albums/1", "photos"],
    ["/rooms/", "rooms"],
    ["/roomsx", "promptly"],
    ["/calendar/answer/x", "calendar"],
    ["/mail", "mail"],
    ["/maps/", "maps"],
    ["/passwords/", "passwords"],
    ["/passwords/send/abc", "passwords"],
    ["/app/open/budget", "open:budget"],
    ["/app/3f1c/", "app:3f1c"],
    ["/apps/budget/3f1c", "promptly"],
  ])("%s → %s", (path, key) => {
    expect(appKeyFor(path)).toBe(key);
  });
});

describe("launchFromUrl", () => {
  it("reads an installed app's start_url", () => {
    expect(launchFromUrl("https://p.example/rooms/?source=pwa", true)).toEqual({ key: "rooms", via: "pwa" });
    expect(launchFromUrl("/passwords/?source=pwa", true)).toEqual({ key: "passwords", via: "pwa" });
    expect(launchFromUrl("/app/abc/?source=pwa", true)).toEqual({ key: "app:abc", via: "pwa" });
  });
  it("ignores a copied start URL in a browser tab", () => {
    expect(launchFromUrl("/rooms/?source=pwa", false)).toBeNull();
  });
  it("trusts Promptly's Android launchers whatever the display mode says", () => {
    expect(launchFromUrl("/mail?source=android", false)).toEqual({ key: "mail", via: "android" });
    expect(launchFromUrl("/?source=android", true)).toEqual({ key: "promptly", via: "android" });
    expect(launchFromUrl("/app/open/budget?source=android", true)).toEqual({ key: "open:budget", via: "android" });
  });
  it("needs the marker", () => {
    expect(launchFromUrl("/rooms/", true)).toBeNull();
    expect(launchFromUrl("/rooms/?source=email", true)).toBeNull();
  });
});

/** A fresh copy of the module in a fake window. */
async function windowAt(href: string, standalone: boolean, storage = new Map<string, string>()) {
  const url = new URL(href, "https://p.example");
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {
    location: url,
    matchMedia: (q: string) => ({ matches: standalone && q === "(display-mode: standalone)" }),
  });
  vi.resetModules();
  const mod = await import("./appLaunch");
  return { mod, storage };
}

describe("which window this is", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a browser tab is inside Promptly", async () => {
    const { mod } = await windowAt("/passwords/", false);
    expect(mod.launchedAppKey()).toBeNull();
    expect(mod.showsPromptlyNav("passwords")).toBe(true);
  });

  it("the installed Promptly window is inside Promptly on every app's page", async () => {
    // Launched at "/", then the person opens Passwords, Rooms, Mail in it.
    const { mod } = await windowAt("/", true);
    expect(mod.launchedAppKey()).toBe("promptly");
    for (const app of ["passwords", "rooms", "mail", "calendar", "maps", "photos"]) expect(mod.showsPromptlyNav(app)).toBe(true);
  });

  it("a page loaded later in the same window keeps the launch", async () => {
    // The installed Passwords app: launched with its start_url…
    const { storage } = await windowAt("/passwords/?source=pwa", true);
    // …then a full page load (the vault is its own document) in that window.
    const { mod } = await windowAt("/passwords/#all", true, storage);
    expect(mod.isOwnAppWindow("passwords")).toBe(true);
    expect(mod.showsPromptlyNav("passwords")).toBe(false);
    // Leaving its scope for a Promptly page shows Promptly's navigation.
    expect(mod.showsPromptlyNav("promptly")).toBe(true);
    expect(mod.showsPromptlyNav("rooms")).toBe(true);
  });

  it("the main window opened at an app's address (a notification) is still Promptly", async () => {
    const { mod } = await windowAt("/calendar/e/123", true);
    expect(mod.showsPromptlyNav("calendar")).toBe(true);
  });

  it("an Android launcher is its app", async () => {
    const { mod } = await windowAt("/rooms/?source=android", false);
    expect(mod.isOwnAppWindow("rooms")).toBe(true);
    expect(mod.showsPromptlyNav("mail")).toBe(true);
  });

  it("an Android Item Store launcher becomes that app once it's opened", async () => {
    const { mod } = await windowAt("/app/open/budget?source=android", true);
    mod.rememberLaunchedApp("open:budget", "app:f1");
    expect(mod.isOwnAppWindow("app:f1")).toBe(true);
    // Not carried over for a window that wasn't launched there.
    const other = await windowAt("/apps", true);
    other.mod.rememberLaunchedApp("open:budget", "app:f1");
    expect(other.mod.isOwnAppWindow("app:f1")).toBe(false);
  });

  it("a fresh launch replaces an older one", async () => {
    const { storage } = await windowAt("/mail/?source=pwa", true);
    const { mod } = await windowAt("/rooms/?source=pwa", true, storage);
    expect(mod.launchedAppKey()).toBe("rooms");
  });

  it("blocked storage counts as Promptly", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { location: new URL("https://p.example/rooms/?source=pwa"), matchMedia: () => ({ matches: true }) });
    vi.resetModules();
    const mod = await import("./appLaunch");
    expect(mod.showsPromptlyNav("rooms")).toBe(true);
  });
});
