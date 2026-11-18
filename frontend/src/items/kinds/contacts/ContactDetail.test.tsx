// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactDetail } from "./ContactDetail";
import { blankContact } from "./model";
import type { Handle } from "./shared";
import type { ContactsData } from "./types";

import { apiClient } from "@/api/client";

// The account lookup is the server's; nothing else here leaves the page.
vi.mock("@/api/peopleHub", () => ({
  peopleHubApi: { get: vi.fn(async () => null) },
  personPath: () => "/people/x",
}));

// Every other request the pane's parts make (links, tags, faces) gets an empty answer.
apiClient.defaults.adapter = async (config) => ({ data: [], status: 200, statusText: "OK", headers: {}, config });

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {};
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof window.matchMedia;

function handle(data: ContactsData): Handle {
  return {
    fileId: "f1",
    data,
    revision: 1,
    canEdit: true,
    status: "saved",
    connected: true,
    update: () => {},
    runAction: async () => ({ summary: "", result: undefined as never }),
    undo: () => {},
    canUndo: false,
    accept: () => {},
    refresh: async () => {},
  } as Handle;
}

function page(data: ContactsData) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ContactDetail item={handle(data)} contactId="c1" isPhone={false} ask={() => {}} onOpen={() => {}} onBack={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const sam = { ...blankContact({ first: "Sam", last: "Okafor" }), id: "c1" };
const settings = { name_order: "first_last", sort: "first", phone_country: "" } as unknown as ContactsData["settings"];
const withSam: ContactsData = { contacts: [sam], groups: [], settings };
const without: ContactsData = { contacts: [], groups: [], settings };

describe("ContactDetail", () => {
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    host?.remove();
    host = null;
  });

  // A contact can go while its pane is open: deleted here, on another device, or
  // by an import being undone. The pane used to run one hook fewer on that
  // render, which React answers by throwing and blanking the screen.
  it("says the contact is gone when it disappears while open, and comes back if it returns", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(page(withSam)));
    expect(host.textContent).toContain("Sam Okafor");

    await act(async () => root.render(page(without)));
    expect(host.textContent).toContain("This contact is gone");

    await act(async () => root.render(page(withSam)));
    expect(host.textContent).toContain("Sam Okafor");

    const hookOrder = errors.mock.calls.filter((c) => /hooks|Rendered (fewer|more)/i.test(String(c[0])));
    expect(hookOrder).toEqual([]);
    await act(async () => root.unmount());
    errors.mockRestore();
  });
});
