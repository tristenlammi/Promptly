import { afterEach, describe, expect, it, vi } from "vitest";

import { gifOf, isLibraryUrl, previewOf, type GifSearchConfig, type SpaceEmoji } from "@/api/rooms";

import { customName, markCustomEmoji } from "./customEmoji";
import { GifLibraryError, searchGifs } from "./gifs";

const giphy: GifSearchConfig = { provider: "giphy", key: "k", rating: "teen" };
const klipy: GifSearchConfig = { provider: "klipy", key: "k", rating: "family" };

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("the GIF library, searched from this device", () => {
  it("asks GIPHY the words as typed, with the rating, and sends no referrer or cookies", async () => {
    const f = answer({
      data: [
        {
          id: "abc",
          title: "Happy Dance GIF by Someone",
          url: "https://giphy.com/gifs/abc",
          images: {
            original: { url: "https://media1.giphy.com/media/abc/giphy.gif?cid=1", webp: "https://media1.giphy.com/media/abc/giphy.webp?cid=1", width: "480", height: "270" },
            fixed_width: { url: "https://media1.giphy.com/media/abc/200w.gif?cid=1", webp: "https://media1.giphy.com/media/abc/200w.webp?cid=1" },
          },
        },
        { id: "bad", title: "Elsewhere", images: { original: { url: "https://evil.example/x.gif" } } },
      ],
      pagination: { total_count: 60, count: 2, offset: 0 },
    });
    const page = await searchGifs(giphy, "  happy dance ", 0);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.giphy.com/v1/gifs/search");
    expect(u.searchParams.get("q")).toBe("happy dance");
    expect(u.searchParams.get("rating")).toBe("pg-13");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.credentials).toBe("omit");
    // Addresses are kept exactly as GIPHY sent them; anything not GIPHY's is dropped.
    expect(page.gifs).toEqual([
      {
        provider: "giphy",
        id: "abc",
        url: "https://media1.giphy.com/media/abc/giphy.webp?cid=1",
        preview_url: "https://media1.giphy.com/media/abc/200w.webp?cid=1",
        page_url: "https://giphy.com/gifs/abc",
        width: 480,
        height: 270,
        title: "Happy Dance",
      },
    ]);
    expect(page.next).toBe(2);
  });

  it("asks GIPHY what's trending when there are no words", async () => {
    const f = answer({ data: [], pagination: { total_count: 0 } });
    const page = await searchGifs(giphy, "", 0);
    expect(new URL((f.mock.calls[0] as unknown as [string])[0]).pathname).toBe("/v1/gifs/trending");
    expect(page).toEqual({ gifs: [], next: null });
  });

  it("reads KLIPY's shape and its pages", async () => {
    const f = answer({
      result: true,
      data: {
        has_next: true,
        data: [
          {
            id: 1,
            slug: "hello-hi-662",
            title: "Hello",
            file: {
              hd: { gif: { url: "https://static.klipy.com/ii/x/hd.gif", width: 498, height: 498 }, webp: { url: "https://static.klipy.com/ii/x/hd.webp", width: 498, height: 498 } },
              sm: { webp: { url: "https://static1.klipy.com/ii/x/sm.webp", width: 200, height: 200 } },
            },
          },
        ],
      },
    });
    const page = await searchGifs(klipy, "hello", 0);
    const u = new URL((f.mock.calls[0] as unknown as [string])[0]);
    expect(u.pathname).toBe("/api/v1/k/gifs/search");
    expect(u.searchParams.get("content_filter")).toBe("high");
    expect(u.searchParams.get("page")).toBe("1");
    expect(page.gifs[0]).toMatchObject({ provider: "klipy", id: "hello-hi-662", url: "https://static.klipy.com/ii/x/hd.webp", preview_url: "https://static1.klipy.com/ii/x/sm.webp", width: 498 });
    expect(page.next).toBe(2);
  });

  it("says plainly when the hour's searches are used up, or the key is refused", async () => {
    answer({}, 429);
    await expect(searchGifs(giphy, "x")).rejects.toMatchObject({ kind: "busy" });
    answer({}, 403);
    const err = await searchGifs(klipy, "x").catch((e) => e);
    expect(err).toBeInstanceOf(GifLibraryError);
    expect(err.kind).toBe("key");
  });
});

describe("what a message may carry", () => {
  it("only the library's own https addresses count as a library GIF", () => {
    expect(isLibraryUrl("giphy", "https://media2.giphy.com/media/a/giphy.webp")).toBe(true);
    expect(isLibraryUrl("giphy", "http://media2.giphy.com/media/a/giphy.webp")).toBe(false);
    expect(isLibraryUrl("giphy", "https://giphy.com.evil.example/a.gif")).toBe(false);
    expect(isLibraryUrl("klipy", "https://media2.giphy.com/media/a/giphy.webp")).toBe(false);
    expect(isLibraryUrl("tenor", "https://tenor.com/a.gif")).toBe(false);
    expect(gifOf({ meta: { gif: { provider: "giphy", url: "https://evil.example/a.gif" } } })).toBeNull();
    const ok = gifOf({ meta: { gif: { provider: "giphy", id: "a", url: "https://i.giphy.com/a.gif", preview_url: "https://evil.example/p.gif", has_note: true } } });
    expect(ok).toMatchObject({ id: "a", preview_url: null, has_note: true });
  });

  it("a removed or empty preview isn't shown", () => {
    expect(previewOf({ meta: { preview: { removed: true, url: "https://a.example" } } })).toBeNull();
    expect(previewOf({ meta: { preview: { url: "javascript:alert(1)", title: "x" } } })).toBeNull();
    expect(previewOf({ meta: { preview: { url: "https://a.example", title: "A", image: true } } })).toMatchObject({ title: "A", image: false });
    expect(previewOf({ meta: { preview: { url: "https://a.example", title: "A", image: true, image_url: "/api/x" } } })).toMatchObject({ image: true });
  });
});

describe("a space's own emoji", () => {
  const e = (name: string): SpaceEmoji => ({ id: name, name, url: `/e/${name}`, animated: false, created_by: null });
  const byName = { party: e("party"), sunny: e("sunny") };

  it("marks the ones this space has, and leaves code, links and strangers alone", () => {
    expect(markCustomEmoji("we did it :party: :nope:", byName)).toBe("we did it ![:party:](emoji:party) :nope:");
    expect(markCustomEmoji("`:party:` and https://x.example/:party:/y", byName)).toBe("`:party:` and https://x.example/:party:/y");
    expect(markCustomEmoji("10:30:party", byName)).toBe("10:30:party");
    expect(markCustomEmoji("no colons here", byName)).toBe("no colons here");
    expect(markCustomEmoji(":party:", {})).toBe(":party:");
  });

  it("knows a custom reaction by how it's written", () => {
    expect(customName(":party:")).toBe("party");
    expect(customName("👍")).toBeNull();
    expect(customName(":x:")).toBeNull();
  });
});
