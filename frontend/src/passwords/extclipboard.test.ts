// The extension's clipboard clearing (passwords/extension/src/clipboard.ts), with the browser
// faked. Review F7: a clear that failed used to forget the secret was there.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = { session: {} as Record<string, unknown>, alarms: new Map<string, number>(), clip: "", writesFail: 0 };
  const ext = {
    storage: {
      session: {
        get: async (k: string) => (k in state.session ? { [k]: structuredClone(state.session[k]) } : {}),
        set: async (o: Record<string, unknown>) => void Object.assign(state.session, structuredClone(o)),
        remove: async (k: string) => void delete state.session[k],
      },
    },
    alarms: {
      create: async (name: string, o: { when: number }) => void state.alarms.set(name, o.when),
      clear: async (name: string) => state.alarms.delete(name),
    },
    permissions: { contains: async () => true },
    runtime: { getPlatformInfo: async () => ({}) },
  };
  return { state, ext };
});

vi.mock("../../../passwords/extension/src/rpc", () => ({ ext: fake.ext }));

Object.assign(globalThis, { __ENGINE__: "firefox", __TEST_BUILD__: false });
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (t: string) => {
      if (fake.state.writesFail > 0) {
        fake.state.writesFail -= 1;
        throw new Error("Document is not focused");
      }
      fake.state.clip = t;
    },
    readText: async () => fake.state.clip,
  },
});

const { clearClipboardIfOurs, watchClipboard, CLIP_ALARM } = await import("../../../passwords/extension/src/clipboard");

describe("clearing a copied secret", () => {
  beforeEach(() => {
    fake.state.session = {};
    fake.state.alarms.clear();
    fake.state.clip = "";
    fake.state.writesFail = 0;
  });

  it("tries again when a clear doesn't take", async () => {
    fake.state.clip = "hunter2-secret";
    await watchClipboard("hunter2-secret", 60);
    fake.state.writesFail = 1;
    await clearClipboardIfOurs();
    expect(fake.state.clip).toBe("hunter2-secret");
    expect(fake.state.session.clip).toBeTruthy();
    expect(fake.state.alarms.has(CLIP_ALARM)).toBe(true);
    await clearClipboardIfOurs();
    expect(fake.state.clip).toBe("");
    expect(fake.state.session.clip).toBeUndefined();
  });

  it("gives up after a few tries rather than retrying for ever", async () => {
    fake.state.clip = "s3cret";
    await watchClipboard("s3cret", 60);
    fake.state.writesFail = 100;
    for (let i = 0; i < 10; i++) await clearClipboardIfOurs();
    expect(fake.state.session.clip).toBeUndefined();
    expect(fake.state.writesFail).toBe(95);
  });

  it("leaves something the person copied since alone", async () => {
    fake.state.clip = "s3cret";
    await watchClipboard("s3cret", 60);
    fake.state.clip = "my shopping list";
    await clearClipboardIfOurs();
    expect(fake.state.clip).toBe("my shopping list");
    expect(fake.state.session.clip).toBeUndefined();
  });
});
