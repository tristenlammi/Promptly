// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "@/api/client";

// The map itself needs a real browser; nothing here is about drawing it.
vi.mock("./MapView", () => ({ MapView: () => null, placeLook: () => undefined }));

import { MapsApp } from "./MapsApp";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof window.matchMedia;

describe("MapsApp", () => {
  // The map's settings arrive after the first render. On a server with Maps
  // off, that second render returns early: it used to run two hooks fewer than
  // the first, which React answers by throwing instead of showing this page.
  it("says Maps isn't turned on when the server has no map", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let answer: (() => void) | undefined;
    const waiting = new Promise<void>((r) => (answer = r));
    apiClient.defaults.adapter = async (config) => {
      if (String(config.url).endsWith("/maps/config")) {
        await waiting;
        return { data: { basemap: false, building: false, failed: false, ready: false }, status: 200, statusText: "OK", headers: {}, config };
      }
      return { data: {}, status: 200, statusText: "OK", headers: {}, config };
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <MapsApp />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    // First render: no settings yet, so the whole app with all its hooks.
    expect(host.textContent).not.toContain("Maps isn't turned on yet");
    await act(async () => {
      answer?.();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(host.textContent).toContain("Maps isn't turned on yet");
    expect(errors.mock.calls.filter((c) => /Rendered (fewer|more) hooks/i.test(String(c[0])))).toEqual([]);
    await act(async () => root.unmount());
    host.remove();
    errors.mockRestore();
  });
});
